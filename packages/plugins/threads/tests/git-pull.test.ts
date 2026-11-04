import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepoTrio, commitOn, removeOn, git, BRANCH, type RepoTrio } from './helpers-git.ts';
import { getSync, pullOnce, startPullLoop, type ExecFile } from '../src/plugin/git-sync.ts';
import { onServerReady } from '../src/index.ts';
import { createLock } from '../src/plugin/lock.ts';
import { makeCtx } from './helpers.ts';
import { promisify } from 'node:util';
import { execFile as nodeExecFile } from 'node:child_process';

let trio: RepoTrio;
const saved = { token: process.env.DOCMD_THREADS_GIT_TOKEN, global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
before(() => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.DOCMD_THREADS_GIT_TOKEN = 'SENTINEL-pull';
  trio = makeRepoTrio();
});
after(() => {
  trio.cleanup();
  restore('GIT_CONFIG_GLOBAL', saved.global);
  restore('GIT_CONFIG_SYSTEM', saved.system);
  restore('DOCMD_THREADS_GIT_TOKEN', saved.token);
});
beforeEach(() => trio.reset());

const realExec = promisify(nodeExecFile) as unknown as ExecFile;
/** Runs git for real and records each verb (credential config stripped) in `log`. */
const recording = (log: string[]): ExecFile => (file, args, o) => {
  const rest = args.filter((_, i) => !(args[i] === '-c' || args[i - 1] === '-c'));
  log.push(rest[0]);
  return realExec(file, args, o);
};

/** A server handle for the trio's server clone that records `rebuild` calls. */
const handleStub = (git_: object = { branch: BRANCH, pullSeconds: 7 }) => {
  const rebuilds: Array<string[] | undefined> = [];
  const stops: Array<() => void> = [];
  const handle: any = {
    mode: 'serve', projectRoot: trio.server, config: { src: 'docs', plugins: { threads: { git: git_ } } },
    rebuild: async (files?: string[]) => void rebuilds.push(files),
    onShutdown: (fn: () => void) => void stops.push(fn),
  };
  return { handle, rebuilds, stops };
};

test('markdown-only change: reset to the remote head and rebuild just that page (AC-22)', async () => {
  commitOn(trio.other, 'docs/index.md', 'from other');
  const { handle, rebuilds } = handleStub();
  await pullOnce(handle);
  assert.equal(git(trio.server, 'rev-parse', 'HEAD'), git(trio.remote, 'rev-parse', BRANCH));
  assert.equal(fs.readFileSync(path.join(trio.server, 'docs/index.md'), 'utf8'), fs.readFileSync(path.join(trio.other, 'docs/index.md'), 'utf8'));
  assert.deepEqual(rebuilds, [['docs/index.md']]);
});

test('a non-markdown path in the change rebuilds everything', async () => {
  fs.writeFileSync(path.join(trio.other, 'docmd.config.json'), '{}\n');
  commitOn(trio.other, 'docs/index.md', 'with config');
  const { handle, rebuilds } = handleStub();
  await pullOnce(handle);
  assert.deepEqual(rebuilds, [undefined]);
});

test('remote unmoved: only fetch runs, nothing is rebuilt', async () => {
  const verbs: string[] = [];
  const { handle, rebuilds } = handleStub();
  await pullOnce(handle, { execFile: recording(verbs) });
  assert.equal(rebuilds.length, 0);
  assert.deepEqual(verbs, ['fetch', 'rev-parse', 'rev-parse']);
});

test('an added or deleted page rebuilds everything', async () => {
  removeOn(trio.other, 'docs/extra.md');
  const { handle, rebuilds } = handleStub();
  await pullOnce(handle);
  assert.deepEqual(rebuilds, [undefined]);
});

test('a rebuild that fails is retried on the next pull, even when the remote did not move', async () => {
  commitOn(trio.other, 'docs/index.md', 'retry case');
  const { handle, rebuilds } = handleStub();
  let fail = true;
  handle.rebuild = async (files?: string[]) => { rebuilds.push(files); if (fail) { fail = false; throw new Error('build failed'); } };
  await assert.rejects(pullOnce(handle), /build failed/);
  await pullOnce(handle);
  assert.deepEqual(rebuilds, [['docs/index.md'], ['docs/index.md']]);
  await pullOnce(handle);
  assert.equal(rebuilds.length, 2); // cleared once it resolved
});

test('a draft journal survives the reset', async () => {
  const journal = path.join(trio.server, 'docs/.threads/drafts/ann.json');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, '{"keep":true}');
  commitOn(trio.other, 'docs/index.md', 'journal case');
  await pullOnce(handleStub().handle);
  assert.equal(fs.readFileSync(journal, 'utf8'), '{"keep":true}');
});

test('the git work runs inside the lock and rebuild after it', async () => {
  const order: string[] = [];
  const inner = createLock();
  const lock = { withLock: <T>(fn: () => Promise<T>) => inner.withLock(async () => { order.push('enter'); try { return await fn(); } finally { order.push('exit'); } }) };
  commitOn(trio.other, 'docs/index.md', 'lock case');
  const { handle } = handleStub();
  handle.rebuild = async () => void order.push('rebuild');
  await pullOnce(handle, { lock, execFile: recording(order) });
  assert.deepEqual(order, ['enter', 'fetch', 'rev-parse', 'rev-parse', 'diff', 'reset', 'exit', 'rebuild']);
});

test('a pull waits behind a publish holding the project lock (AC-6)', async () => {
  const ctx = makeCtx(trio.server, { mode: 'serve', config: { src: 'docs', plugins: { threads: { git: { branch: BRANCH } } } } });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const publishing = getSync(ctx).withLock(() => held);
  const verbs: string[] = [];
  const pulling = pullOnce(handleStub().handle, { execFile: recording(verbs) });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(verbs, []);
  release();
  await publishing;
  await pulling;
  assert.equal(verbs[0], 'fetch');
});

test('startPullLoop registers one interval of pullSeconds and stop clears it; onServerReady wires it iff git is set', { timeout: 5000 }, async () => {
  const set: Array<[unknown, number]> = [];
  const cleared: unknown[] = [];
  const timers = { setInterval: (fn: () => void, ms: number) => (set.push([fn, ms]), 'id-1'), clearInterval: (id: unknown) => void cleared.push(id) };
  const stop = startPullLoop(handleStub().handle, timers);
  assert.equal(set.length, 1);
  assert.equal(set[0][1], 7000);
  stop();
  assert.deepEqual(cleared, ['id-1']);

  const log_ = mock.method(console, 'log', () => {});
  try {
    const on = handleStub();
    await onServerReady(on.handle);
    assert.equal(on.stops.length, 1);
    on.stops.forEach((s) => s());
    const off = handleStub(undefined as any);
    off.handle.config.plugins.threads = true;
    await onServerReady(off.handle);
    assert.equal(off.stops.length, 0);
  } finally {
    log_.mock.restore();
  }
});

test('a broken remote logs one cause line without the path and the loop keeps ticking', { timeout: 20000 }, async () => {
  git(trio.server, 'remote', 'set-url', 'origin', '/nonexistent/secret-remote.git');
  const lines: string[] = [];
  let logged: () => void = () => {};
  const err = mock.method(console, 'error', (m: string) => { lines.push(m); logged(); });
  try {
    let tick!: () => void;
    const { handle, rebuilds } = handleStub({ branch: BRANCH, pullSeconds: 1 }); // remote stays the default 'origin'
    startPullLoop(handle, { setInterval: (fn) => ((tick = fn), 1), clearInterval: () => {} });
    // Three ticks while a publish holds the lock: only one pull queues behind it.
    const sync = getSync(makeCtx(trio.server, { mode: 'serve', config: { src: 'docs', plugins: { threads: { git: { branch: BRANCH } } } } }));
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const publishing = sync.withLock(() => held);
    tick(); tick(); tick();
    release();
    await publishing;
    await sync.withLock(async () => {}); // behind every pull that queued
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.length, 1);
    // The loop keeps going after the failure.
    const failed = new Promise<void>((r) => (logged = r));
    tick();
    await failed;
    assert.equal(lines.length, 2);
    assert.ok(lines.every((l) => /does not appear to be a git repository/.test(l) && !l.includes('secret-remote')), lines.join('\n'));
    assert.equal(rebuilds.length, 0);
  } finally {
    err.mock.restore();
    git(trio.server, 'remote', 'set-url', 'origin', trio.remote);
  }
});
