import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempProject, type TempProject } from './helpers.ts';
import { createDraftStore, slug } from '../src/plugin/drafts.ts';

let project: TempProject;
let docsRoot: string;
let clock = Date.parse('2026-03-10T12:00:00.000Z');
const store = () => createDraftStore(docsRoot, { now: () => clock });
const draftsDir = () => path.join(docsRoot, '.threads', 'drafts');
const addThread = { kind: 'add-thread', file: 'docs/index.md', threadId: 't-1', commentId: 'c-1', anchor: null, body: 'hi' } as const;

before(() => {
  project = tempProject();
  docsRoot = path.join(project.root, 'docs');
  execFileSync('git', ['init', '-q'], { cwd: project.root });
});
after(() => project.cleanup());
beforeEach(() => {
  fs.rmSync(path.join(docsRoot, '.threads'), { recursive: true, force: true });
  clock = Date.parse('2026-03-10T12:00:00.000Z');
});

test('append writes <slug>.json atomically, writes .gitignore once, and git ignores the journal', async () => {
  const key = 'alice smith/1';
  assert.equal(slug(key), 'alice_20smith_2F1');
  const s = store();
  await s.append(key, addThread);
  const file = path.join(draftsDir(), 'alice_20smith_2F1.json');
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(journal.version, 1);
  assert.equal(journal.authorKey, key);
  assert.equal(journal.ops.length, 1);

  const ignore = path.join(draftsDir(), '.gitignore');
  assert.equal(fs.readFileSync(ignore, 'utf8'), '*\n!.gitignore\n');
  const before = fs.statSync(ignore).mtimeMs;
  await s.append(key, addThread);
  assert.equal(fs.statSync(ignore).mtimeMs, before, '.gitignore is not rewritten');

  assert.deepEqual(fs.readdirSync(draftsDir()).filter((f) => f.endsWith('.tmp')), []);
  assert.equal(spawnSync('git', ['check-ignore', '-q', file], { cwd: project.root }).status, 0);
});

test('a journal survives a new store instance', async () => {
  await store().append('bob', addThread);
  const loaded = await store().load('bob');
  assert.deepEqual(loaded.ops.map((o) => o.kind), ['add-thread']);
});

test('a corrupt journal is moved aside and a fresh one is returned', async () => {
  fs.mkdirSync(draftsDir(), { recursive: true });
  const file = path.join(draftsDir(), 'bob.json');
  fs.writeFileSync(file, '{ not json');
  const journal = await store().load('bob');
  assert.deepEqual(journal.ops, []);
  assert.equal(journal.authorKey, 'bob');
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.readFileSync(`${file}.corrupt-${clock}`, 'utf8'), '{ not json');
});

test('a missing journal loads fresh with the default mode, without writing', async () => {
  assert.equal((await store().load('x')).mode, 'collect');
  assert.equal((await createDraftStore(docsRoot, { now: () => clock, defaultMode: 'auto' }).load('x')).mode, 'auto');
  assert.equal(fs.existsSync(draftsDir()), false);
});

test('every mutation stamps ops and review.updatedAt from the injected clock', async () => {
  const s = store();
  const tick = () => { clock += 5000; return new Date(clock).toISOString(); };
  const cases: Array<[string, (op?: string) => Promise<unknown>]> = [
    ['append', () => s.append('k', addThread)],
    ['update', (op) => s.update('k', { opId: op!, body: 'changed' })],
    ['setMode', () => s.setMode('k', 'auto')],
    ['setReview', () => s.setReview('k', { title: 'T', summary: 'S' })],
    ['removeOp', (op) => s.removeOp('k', op!)],
  ];
  let opId = '';
  for (const [name, run] of cases) {
    const expected = tick();
    await run(opId);
    const j = await s.load('k');
    assert.equal(j.review.updatedAt, expected, name);
    if (name === 'append') {
      opId = j.ops[0].opId;
      assert.equal(j.ops[0].at, expected);
    }
  }
  const j = await s.load('k');
  assert.deepEqual([j.mode, j.review.title, j.review.summary, j.ops], ['auto', 'T', 'S', []]);
  assert.equal(j.review.createdAt, '2026-03-10T12:00:05.000Z');
});

test('update patches an op in place and rejects an unknown opId; clear deletes the file', async () => {
  const s = store();
  const j = await s.append('k', addThread);
  await s.update('k', { opId: j.ops[0].opId, body: 'new', kind: 'delete-thread' });
  const after = (await s.load('k')).ops[0] as any;
  assert.equal(after.body, 'new');
  assert.equal(after.kind, 'add-thread', 'kind is not patchable');
  await assert.rejects(s.update('k', { opId: 'o-nope' }), /threads\/not-found/);
  await s.clear('k');
  assert.equal(fs.existsSync(path.join(draftsDir(), 'k.json')), false);
  await s.clear('k'); // idempotent
});
