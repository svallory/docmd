import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, makeCtx, type TempProject } from './helpers.ts';
import { actions } from '../src/plugin/actions.ts';
import { resolveCaller, findCaller } from '../src/plugin/identity.ts';
import { publish } from '../src/plugin/reviews.ts';
import { createDraftStore } from '../src/plugin/drafts.ts';
import { createLock, createNoGitSync, type Sync, type PublishMeta } from '../src/plugin/lock.ts';

const HEADER = 'X-Auth-Request-Email';
const caller = (headers: Record<string, string>, transport = 'websocket') =>
  ({ transport, headers, origin: null, remoteAddress: null, connectionId: 'c1', connectedAt: 0 });
const lit = (over: Record<string, unknown>, threads: Record<string, unknown> = { identityHeader: HEADER }) =>
  ({ projectRoot: '/nonexistent', mode: 'dev', caller: caller({}), config: { plugins: { threads } }, ...over }) as any;

test('header caller: key, email, name, isAdmin and whitespace encoding', async () => {
  const threads = { identityHeader: HEADER, permissions: { admins: ['root@example.com'] } };
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['email value', 'alice@example.com', { key: 'alice@example.com', email: 'alice@example.com', name: 'alice@example.com', isAdmin: false }],
    ['admin', 'root@example.com', { key: 'root@example.com', isAdmin: true }],
    ['plain id', 'alice', { key: 'alice', email: 'alice@threads.invalid' }],
    ['percent sign', 'a%zz', { key: 'a%zz', email: 'a%zz@threads.invalid' }],
    ['whitespace', 'Jane Doe', { key: 'Jane%20Doe', email: 'Jane%20Doe@threads.invalid' }],
  ];
  for (const [label, value, want] of cases) {
    const c = await resolveCaller(lit({ caller: caller({ 'x-auth-request-email': value }) }, threads), { author: 'Mallory' });
    assert.equal(c.source, 'header', label);
    assert.deepEqual({ ...c, ...want }, c, label);
  }
});

test('local transport with a header configured is missing; null identity; dev payload path', async () => {
  const local = lit({ caller: caller({ 'x-auth-request-email': 'a@b.c' }, 'local') });
  await assert.rejects(resolveCaller(local, { author: 'M' }), (e: Error) => e.message.startsWith('threads/unauthenticated'));
  assert.equal(await findCaller(lit({}), { author: 'M' }), null);
  assert.equal(await findCaller(lit({ mode: 'serve' }, {}), { author: 'M' }), null);
  const dev = await resolveCaller(lit({}, {}), { author: 'Kay', authorKey: 'k', avatarUrl: 'u' }, { write: true });
  assert.deepEqual(dev, { key: 'k', name: 'Kay', email: null, avatarUrl: 'u', source: 'payload', isAdmin: false });
});

let project: TempProject;
before(() => { project = tempProject(); });
after(() => project.cleanup());
beforeEach(() => {
  project.reset();
  fs.rmSync(path.join(project.root, 'docs', '.threads'), { recursive: true, force: true });
});

const docs = () => path.join(project.root, 'docs');
const authorsFile = () => path.join(docs(), '.threads', 'authors.json');
const run = (name: string, payload: Record<string, unknown>, extra: Record<string, unknown>) =>
  (actions as Record<string, any>)[`threads:${name}`](payload, makeCtx(project.root, extra));
const headerCtx = (headers: Record<string, string> | null) => ({
  config: { src: 'docs', plugins: { threads: { identityHeader: HEADER } } },
  ...(headers ? { caller: caller(headers) } : {}),
});
const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) { const p = path.join(e.parentPath, e.name); out[p] = fs.readFileSync(p, 'utf8'); }
  }
  return out;
};
const anchor = { quote: 'x', prefix: null, suffix: null, selector: null, offset: null, blockText: null };
const WRITES = ['add-thread', 'add-comment', 'edit-comment', 'delete-comment', 'delete-thread', 'resolve-thread', 'toggle-reaction', 'publish-review', 'upsert-author', 'set-mode', 'update-review', 'discard-review'];
const payloadFor = () => ({ file: project.file, threadId: 't-thread1', commentId: 'c-1', reviewId: 'r-1', body: 'b', emoji: '👍', anchor, name: 'N', mode: 'auto', author: 'Mallory', authorKey: 'mallory' });

test('AC-1: every write rejects unauthenticated without the header, and changes nothing', async () => {
  const before = tree(project.root);
  for (const name of WRITES) {
    await assert.rejects(run(name, payloadFor(), headerCtx({})), (e: Error) => e.message.startsWith('threads/unauthenticated'), name);
  }
  assert.deepEqual(tree(project.root), before);
});

test('discard-review resolves identity before it validates the payload', async () => {
  await assert.rejects(run('discard-review', {}, headerCtx({})), (e: Error) => e.message.startsWith('threads/unauthenticated'));
});

test('AC-5: serve without a header configured rejects writes, reads succeed', async () => {
  const serve = { mode: 'serve', config: { src: 'docs' } };
  const before = tree(project.root);
  for (const name of WRITES) {
    await assert.rejects(run(name, payloadFor(), serve), (e: Error) => e.message.startsWith('threads/no-identity-source'), name);
  }
  assert.deepEqual(tree(project.root), before);
  assert.ok(Array.isArray(await run('get-threads', { file: project.file }, serve)));
  assert.deepEqual(await run('get-authors', {}, serve), {});
  assert.deepEqual(await run('list-reviews', {}, serve), []);
  assert.deepEqual(await run('whoami', {}, serve), { identity: null, journal: null, orphanedMine: 0 });
});

test('AC-2: the payload identity is ignored; the header names the author, authors.json names the caller', async () => {
  fs.mkdirSync(path.dirname(authorsFile()), { recursive: true });
  fs.writeFileSync(authorsFile(), JSON.stringify({ 'alice@example.com': { name: 'Alice A', avatarUrl: 'http://a/a.png' } }));
  const ctx = headerCtx({ 'x-auth-request-email': 'alice@example.com' });
  const t = await run('add-thread', { file: project.file, body: 'hello', anchor, author: 'Mallory', authorKey: 'mallory', avatarUrl: 'x' }, ctx);
  assert.equal(t.comments[0].author, 'Alice A');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(authorsFile(), 'utf8'))), ['alice@example.com'], 'payload profile not recorded');
  const me = await run('whoami', { author: 'Mallory' }, ctx);
  assert.equal(me.identity.key, 'alice@example.com');
  assert.equal(me.identity.name, 'Alice A');
  assert.ok(!JSON.stringify(me.journal).toLowerCase().includes('mallory'), 'drafted op carries no payload identity');
  assert.equal(me.journal.authorKey, 'alice@example.com');
  await run('publish-review', { author: 'Mallory' }, ctx);
  const md = fs.readFileSync(path.join(project.root, project.file), 'utf8');
  assert.ok(md.includes('hello'));
  assert.match(md, /comment c-\w+ "Alice A" "[^"]+" by alice@example\.com/);
  assert.ok(!md.includes('Mallory') && !md.includes('mallory'));
});

test('AC-7: a header profile edit is journaled, then written to authors.json at publish', async () => {
  const ctx = headerCtx({ 'x-auth-request-email': 'bob@example.com' });
  await run('upsert-author', { name: 'Bob B', avatarUrl: 'http://a/b.png' }, ctx);
  assert.equal(fs.existsSync(authorsFile()), false);
  assert.deepEqual((await run('whoami', {}, ctx)).journal.profile, { name: 'Bob B', avatarUrl: 'http://a/b.png' });
  await run('add-thread', { file: project.file, body: 'hi', anchor }, ctx);
  await run('publish-review', {}, ctx);
  assert.deepEqual(JSON.parse(fs.readFileSync(authorsFile(), 'utf8')), { 'bob@example.com': { name: 'Bob B', avatarUrl: 'http://a/b.png' } });
  assert.equal((await run('whoami', {}, ctx)).journal.profile, undefined);
  // A profile edit alone is publishable: authors.json is the whole publish.
  await run('upsert-author', { name: 'Bob C' }, ctx);
  await run('publish-review', {}, ctx);
  assert.equal(JSON.parse(fs.readFileSync(authorsFile(), 'utf8'))['bob@example.com'].name, 'Bob C');
  assert.equal((await run('whoami', {}, ctx)).journal.profile, undefined);
  // A payload caller still writes authors.json directly.
  await run('upsert-author', { authorKey: 'k1', name: 'Kay' }, { config: { src: 'docs' } });
  assert.equal(JSON.parse(fs.readFileSync(authorsFile(), 'utf8')).k1.name, 'Kay');
});

// publish() driven directly, to see what the sync is told and to fail the manifest write.
const AUTHORS_REL = path.join('docs', '.threads', 'authors.json');
const BOB = { 'x-auth-request-email': 'bob@example.com' };
function direct(over: Record<string, unknown> = {}) {
  const ctx = makeCtx(project.root, headerCtx(BOB));
  const metas: PublishMeta[] = [];
  const inner = createNoGitSync(createLock());
  const sync: Sync = { withLock: inner.withLock, publishWithRetry: (apply, meta) => (metas.push(meta), inner.publishWithRetry(apply, meta)) };
  const store = createDraftStore(docs());
  const go = async () => publish(await resolveCaller(ctx, {}), ctx, {}, { store, sync, ...over });
  return { ctx, metas, store, go };
}

test('AC-7: the sync is told about authors.json, for a profile-only and an ops+profile publish', async () => {
  const d = direct();
  await run('upsert-author', { name: 'Bob' }, headerCtx(BOB));
  await d.go();
  assert.deepEqual(d.metas.map((m) => m.files), [[AUTHORS_REL]]);
  await run('upsert-author', { name: 'Bob 2' }, headerCtx(BOB));
  await run('add-thread', { file: project.file, body: 'hi', anchor }, headerCtx(BOB));
  await d.go();
  assert.deepEqual(d.metas[1].files, [project.file, AUTHORS_REL]);
});

test('an earlier-published review keeps a profile edited since, for the next publish', async () => {
  const ctx = headerCtx(BOB);
  await run('add-thread', { file: project.file, body: 'hi', anchor }, ctx);
  await run('upsert-author', { name: 'Bob P2' }, ctx);
  const d = direct();
  const id = (await d.store.load('bob@example.com')).review.id;
  const dir = path.join(docs(), '.threads', 'reviews');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ version: 1, id, state: 'published', ops: [], skipped: [] }));
  await d.go();
  assert.deepEqual((await d.store.load('bob@example.com')).profile, { name: 'Bob P2', avatarUrl: '' });
  assert.equal(fs.existsSync(authorsFile()), false);
  await d.go(); // now profile-only
  assert.equal(JSON.parse(fs.readFileSync(authorsFile(), 'utf8'))['bob@example.com'].name, 'Bob P2');
});

test('a failed publish puts authors.json back byte for byte, or removes it', async () => {
  const boom = direct({ now: () => { throw new Error('boom'); } });
  for (const seed of [null, '{"zed":{"name":"Z","avatarUrl":""}}\n\n']) {
    fs.rmSync(path.join(docs(), '.threads'), { recursive: true, force: true });
    if (seed !== null) { fs.mkdirSync(path.dirname(authorsFile()), { recursive: true }); fs.writeFileSync(authorsFile(), seed); }
    await run('upsert-author', { name: 'Bob' }, headerCtx(BOB));
    await run('add-thread', { file: project.file, body: 'hi', anchor }, headerCtx(BOB));
    await assert.rejects(boom.go(), /boom/);
    assert.equal(fs.existsSync(authorsFile()) ? fs.readFileSync(authorsFile(), 'utf8') : null, seed);
  }
});
