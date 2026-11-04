import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tempProject, makeCtx } from './helpers.ts';
import { makeRepoTrio, commitOn, log, git, BRANCH, type RepoTrio } from './helpers-git.ts';
import { actions } from '../src/plugin/actions.ts';
import { createDraftStore } from '../src/plugin/drafts.ts';
import { getSync, publish } from '../src/plugin/reviews.ts';
import { assertRuntime, normalizeOptions } from '../src/plugin/config.ts';
import { onServerReady } from '../src/index.ts';
import { ThreadsError } from '../src/plugin/errors.ts';
import type { ExecFile } from '../src/plugin/git-sync.ts';

const SENTINEL = 'SENTINEL-7f3a';
const realExec = promisify(nodeExecFile) as unknown as ExecFile;
const ANCHOR = { quote: 'Official Documentation', prefix: null, suffix: null, selector: null, offset: null, blockText: null };
const GIT = { branch: BRANCH, committer: { name: 'Threads Bot', email: 'bot@fixture.invalid' } };

let trio: RepoTrio;
const savedToken = process.env.DOCMD_THREADS_GIT_TOKEN;
before(() => {
  trio = makeRepoTrio();
  process.env.DOCMD_THREADS_GIT_TOKEN = SENTINEL;
});
after(() => {
  trio.cleanup();
  if (savedToken === undefined) delete process.env.DOCMD_THREADS_GIT_TOKEN;
  else process.env.DOCMD_THREADS_GIT_TOKEN = savedToken;
});
beforeEach(() => trio.reset());

/** Context for the server clone: header identity, git on. */
const gitCtx = () => makeCtx(trio.server, {
  mode: 'serve',
  config: { src: 'docs', plugins: { threads: { identityHeader: 'x-user', git: GIT } } },
  caller: { transport: 'websocket', headers: { 'x-user': 'ann@example.com' }, origin: null, remoteAddress: null, connectionId: 'c', connectedAt: 0 },
});
const draft = (ctx: any, body: string) =>
  actions['threads:add-thread']({ file: 'docs/index.md', body, anchor: ANCHOR }, ctx);
const head = (remote: string) => log(remote, '%H').length;

// ---------------------------------------------------------------------------
// small: configuration and the no-git path
// ---------------------------------------------------------------------------

test('assertRuntime: the token is required only when git is configured', () => {
  const withGit = normalizeOptions({ git: { branch: BRANCH } });
  const without = normalizeOptions({});
  assert.throws(
    () => assertRuntime(withGit, {}),
    (e: unknown) => e instanceof ThreadsError && e.code === 'config' && e.message.startsWith('threads/config:') && e.message.includes('DOCMD_THREADS_GIT_TOKEN'),
  );
  assert.throws(() => assertRuntime(withGit, { DOCMD_THREADS_GIT_TOKEN: '' }), /DOCMD_THREADS_GIT_TOKEN/);
  assert.doesNotThrow(() => assertRuntime(withGit, { DOCMD_THREADS_GIT_TOKEN: 'x' }));
  assert.doesNotThrow(() => assertRuntime(without, {}));
});

test('onServerReady rejects without the token and resolves with it or without git', async () => {
  const log_ = mock.method(console, 'log', () => {});
  const handle = (threads: unknown): any => ({ mode: 'serve', projectRoot: '/x', config: { plugins: { threads } } });
  try {
    delete process.env.DOCMD_THREADS_GIT_TOKEN;
    await assert.rejects(onServerReady(handle({ git: { branch: BRANCH } })), /^ThreadsError: threads\/config: .*DOCMD_THREADS_GIT_TOKEN/);
    await onServerReady(handle(true)); // git absent: the variable is not needed
    process.env.DOCMD_THREADS_GIT_TOKEN = SENTINEL;
    await onServerReady(handle({ git: { branch: BRANCH } }));
    assert.ok(log_.mock.calls.every((c) => !String(c.arguments[0]).includes(SENTINEL)));
  } finally {
    log_.mock.restore();
    process.env.DOCMD_THREADS_GIT_TOKEN = SENTINEL;
  }
});

test('without git a publish spawns no process', async () => {
  const project = tempProject();
  try {
    const calls: unknown[] = [];
    const ctx = makeCtx(project.root, { config: { src: 'docs' } });
    const payload = { author: 'Ann', authorKey: 'ann', file: project.file, body: 'hi', anchor: ANCHOR };
    await actions['threads:add-thread'](payload, ctx);
    const sync = getSync(ctx, { execFile: async (...a) => (calls.push(a), { stdout: '', stderr: '' }) });
    const store = createDraftStore(path.join(project.root, 'docs'), { now: Date.now, defaultMode: () => 'collect' });
    await publish({ key: 'ann', name: 'Ann', email: null, avatarUrl: '', source: 'payload', isAdmin: false }, ctx, {}, { store, sync });
    assert.deepEqual(calls, []);
    assert.ok(fs.readdirSync(path.join(project.root, 'docs', '.threads', 'reviews')).length === 1, 'the review was written');
  } finally {
    project.cleanup();
  }
});

// ---------------------------------------------------------------------------
// medium: a real bare remote and two clones
// ---------------------------------------------------------------------------

const allFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);

test('publish makes one commit authored by the commenter; the token leaks nowhere', async () => {
  const ctx = gitCtx();
  await draft(ctx, 'Reword this link text.');
  await actions['threads:update-review']({ title: 'Link wording', summary: 'Two small fixes.' }, ctx);

  const out: string[] = [];
  const spies = [
    mock.method(console, 'log', (...a: unknown[]) => void out.push(a.join(' '))),
    mock.method(console, 'error', (...a: unknown[]) => void out.push(a.join(' '))),
    mock.method(console, 'warn', (...a: unknown[]) => void out.push(a.join(' '))),
    mock.method(process.stdout, 'write', (s: unknown) => (out.push(String(s)), true)),
    mock.method(process.stderr, 'write', (s: unknown) => (out.push(String(s)), true)),
  ];
  try {
    await actions['threads:publish-review']({}, ctx);
  } finally {
    spies.forEach((s) => s.mock.restore());
  }

  assert.equal(head(trio.remote), 2, 'exactly one new commit');
  const [a, c, subject, body] = log(trio.remote, '%an <%ae>%n%cn <%ce>%n%s%n%b').slice(-4);
  assert.deepEqual([a, c, subject, body], ['Ann Lee <ann@example.com>', 'Threads Bot <bot@fixture.invalid>', 'Link wording [skip ci]', 'Two small fixes.']);
  const files = git(trio.remote, 'show', '--name-only', '--format=', BRANCH).split('\n').filter(Boolean).sort();
  assert.equal(files.length, 2);
  assert.ok(files.includes('docs/index.md') && files.some((f) => /^docs\/\.threads\/reviews\/r-.*\.json$/.test(f)), files.join());

  // the credential is not in the remote URL, under .git/, or in the output
  assert.ok(!git(trio.server, 'remote', '-v').includes(SENTINEL));
  for (const f of allFiles(path.join(trio.server, '.git'))) {
    assert.ok(!fs.readFileSync(f).includes(SENTINEL), `${f} holds the token`);
  }
  assert.ok(!out.join('\n').includes(SENTINEL));
});

test('discard is one forward commit authored by the discarding caller', async () => {
  const ctx = gitCtx();
  await draft(ctx, 'Reword this.');
  await actions['threads:update-review']({ title: 'Wording' }, ctx);
  const { reviewId } = await actions['threads:publish-review']({}, ctx);
  await actions['threads:discard-review']({ reviewId }, ctx);

  assert.equal(head(trio.remote), 3);
  const [a, c, s] = log(trio.remote, '%an <%ae>%n%cn <%ce>%n%s').slice(-3);
  assert.deepEqual([a, c, s], ['Ann Lee <ann@example.com>', 'Threads Bot <bot@fixture.invalid>', 'revert(threads): discard review "Wording" [skip ci]']);
});

test('a push that loses a race is retried on the fresh head; three rejections leave the review open', async () => {
  const ctx = gitCtx();
  const store = createDraftStore(path.join(trio.server, 'docs'), { now: Date.now, defaultMode: () => 'collect' });
  const caller = { key: 'ann@example.com', name: 'Ann Lee', email: 'ann@example.com', avatarUrl: '', source: 'header' as const, isAdmin: false };
  await draft(ctx, 'Race me.');

  // other pushes once, just before the server's first push
  let raced = false;
  const racing: ExecFile = async (file, args, opts) => {
    if (!raced && args.includes('push')) {
      raced = true;
      commitOn(trio.other, 'docs/index.md', 'OTHER-WAS-HERE');
    }
    return realExec(file, args, opts);
  };
  await publish(caller, ctx, { title: 'Raced' }, { store, sync: getSync(ctx, { execFile: racing }) });
  assert.deepEqual(log(trio.remote, '%an|%s'), ['seed|base', 'other|other: OTHER-WAS-HERE', 'Ann Lee|Raced [skip ci]']);
  // the second attempt applied on the fresh head
  const final = git(trio.remote, 'show', `${BRANCH}:docs/index.md`);
  assert.ok(final.includes('OTHER-WAS-HERE') && final.includes('Race me.'));

  // rejected every time: a pre-receive hook refuses while the marker exists
  trio.reset();
  const hook = path.join(trio.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, '#!/bin/sh\n[ -e ./reject ] && exit 1\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(trio.remote, 'reject'), '');
  try {
    await draft(ctx, 'Doomed.');
    await assert.rejects(
      publish(caller, ctx, { title: 'Doomed' }, { store, sync: getSync(ctx, { execFile: realExec }) }),
      (e: unknown) => e instanceof ThreadsError && e.code === 'push-failed',
    );
    const journal = await store.load(caller.key);
    assert.equal(journal.ops.length, 1, 'the ops are intact');
    assert.ok(!fs.existsSync(path.join(trio.server, 'docs', '.threads', 'reviews')), 'no manifest left behind');
  } finally {
    fs.rmSync(hook);
    fs.rmSync(path.join(trio.remote, 'reject'));
  }
  assert.equal(git(trio.server, 'status', '--porcelain').trim(), '');
  assert.equal(git(trio.server, 'rev-parse', 'HEAD').trim(), git(trio.server, 'rev-parse', `origin/${BRANCH}`).trim());
  assert.equal(head(trio.remote), 1);
});
