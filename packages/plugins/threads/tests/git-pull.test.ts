import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepoTrio, commitOn, git, BRANCH, type RepoTrio } from './helpers-git.ts';
import { pullOnce, startPullLoop, type ExecFile } from '../src/plugin/git-sync.ts';
import { onServerReady } from '../src/index.ts';
import { createLock } from '../src/plugin/lock.ts';

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
  const calls: string[][] = [];
  const { handle, rebuilds } = handleStub();
  const execFile: ExecFile = async (file, args, o) => {
    calls.push(args);
    const { promisify } = await import('node:util');
    const { execFile: ef } = await import('node:child_process');
    return (promisify(ef) as any)(file, args, o);
  };
  await pullOnce(handle, { execFile });
  assert.equal(rebuilds.length, 0);
  const verbs = calls.map((a) => a.filter((x) => !x.startsWith('credential') && x !== '-c')[0]);
  assert.deepEqual(verbs, ['fetch', 'rev-parse', 'rev-parse']);
  assert.ok(!calls.some((a) => a.includes('reset') || a.includes('diff')));
});

test('a draft journal survives the reset', async () => {
  const journal = path.join(trio.server, 'docs/.threads/drafts/ann.json');
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  fs.writeFileSync(journal, '{"keep":true}');
  commitOn(trio.other, 'docs/index.md', 'journal case');
  await pullOnce(handleStub().handle);
  assert.equal(fs.readFileSync(journal, 'utf8'), '{"keep":true}');
});

test('pullOnce goes through lock.withLock', async () => {
  const order: string[] = [];
  const inner = createLock();
  const lock = { withLock: <T>(fn: () => Promise<T>) => { order.push('lock'); return inner.withLock(fn); } };
  commitOn(trio.other, 'docs/index.md', 'lock case');
  const { handle, rebuilds } = handleStub();
  await pullOnce(handle, { lock });
  assert.deepEqual(order, ['lock']);
  assert.equal(rebuilds.length, 1);
});

test('startPullLoop registers one interval of pullSeconds and stop clears it; onServerReady wires it iff git is set', async () => {
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

test('a broken remote logs one failure without the remote and the loop keeps ticking', async () => {
  const broken = '/nonexistent/secret-remote.git';
  git(trio.server, 'remote', 'set-url', 'origin', broken);
  let logged!: () => void;
  const err = mock.method(console, 'error', () => logged());
  try {
    let tick!: () => void;
    const { handle, rebuilds } = handleStub({ branch: BRANCH, remote: broken, pullSeconds: 1 });
    startPullLoop(handle, { setInterval: (fn) => ((tick = fn), 1), clearInterval: () => {} });
    for (let i = 0; i < 2; i++) {
      const failed = new Promise<void>((r) => (logged = r));
      tick();
      await failed; // resolved by the one logged failure
      assert.equal(err.mock.callCount(), i + 1);
    }
    assert.ok(err.mock.calls.every((c) => !String(c.arguments[0]).includes('secret-remote')));
    assert.equal(rebuilds.length, 0);
  } finally {
    err.mock.restore();
    git(trio.server, 'remote', 'set-url', 'origin', trio.remote);
  }
});
