import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, makeCtx, type TempProject } from './helpers.ts';
import { checkBody, createRateLimiter } from '../src/plugin/limits.ts';
import { actions } from '../src/plugin/actions.ts';
import { createDraftStore } from '../src/plugin/drafts.ts';

const code = (fn: () => void): string | undefined => {
  try { fn(); } catch (e: any) { return e.code; }
  return undefined;
};

test('checkBody: the cap is inclusive, counted in characters', () => {
  const opts = { maxCommentChars: 5 };
  const table: Array<[string, string | undefined]> = [
    ['12345', undefined],
    ['123456', 'limit-chars'],
    ['', undefined],
    ['   ', undefined],
    ['😀😀😀😀😀', undefined],
    ['😀😀😀😀😀😀', 'limit-chars'],
  ];
  for (const [body, want] of table) assert.equal(code(() => checkBody(body, opts)), want, JSON.stringify(body));
});

test('rate limiter: per key, sliding window, rejected calls are not recorded', () => {
  let t = 0;
  const limiter = createRateLimiter({ now: () => t * 1000, windowMs: 60_000, max: 2 });
  const steps: Array<[string, number, string | undefined]> = [
    ['a', 0, undefined],
    ['a', 30, undefined],
    ['a', 59, 'rate-limited'],
    ['b', 59, undefined],
    ['a', 59.5, 'rate-limited'],
    ['a', 61, undefined], // the t=0 hit slid out
    ['a', 62, 'rate-limited'], // t=30 and t=61 still inside
    ['a', 91, undefined], // t=30 slid out
  ];
  for (const [key, at, want] of steps) {
    t = at;
    assert.equal(code(() => limiter.take(key)), want, `${key}@${at}`);
  }
});

let project: TempProject;
before(() => {
  mock.timers.enable({ apis: ['Date'], now: 0 });
  project = tempProject();
});
after(() => {
  mock.timers.reset();
  project.cleanup();
});
beforeEach(() => {
  project.reset();
  fs.rmSync(path.join(project.root, 'docs', '.threads'), { recursive: true, force: true });
});

const config = (limits: Record<string, number>) => ({ src: 'docs', plugins: { threads: { limits } } });
const call = (name: string, payload: Record<string, unknown>, limits: Record<string, number> = {}) =>
  (actions as Record<string, any>)[`threads:${name}`](
    { file: project.file, ...payload },
    makeCtx(project.root, { config: config(limits) }),
  );
const A = { author: 'A', authorKey: 'a' };
const B = { author: 'B', authorKey: 'b' };
const ops = async (key: string) => (await createDraftStore(path.join(project.root, 'docs')).load(key)).ops;

test('over-long bodies reject on add-thread, add-comment and edit-comment without touching the journal', async () => {
  const limits = { maxCommentChars: 10, commentsPerMinute: 100 };
  const made = await call('add-thread', { ...A, body: '0123456789' }, limits); // exactly the cap
  assert.equal(made.comments[0].body, '0123456789');
  const reject = async (name: string, extra: Record<string, unknown>) =>
    assert.rejects(call(name, { ...A, body: '0123456789X', ...extra }, limits), { message: /^threads\/limit-chars/ });
  await reject('add-thread', {});
  await reject('add-comment', { threadId: made.id });
  await reject('edit-comment', { threadId: made.id, commentId: made.comments[0].id });
  assert.equal((await ops('a')).length, 1);
});

test('the third add by one key in a minute rejects, another key passes, the window slides; edits are exempt', async () => {
  const limits = { commentsPerMinute: 2 };
  const first = await call('add-thread', { ...A, body: 'one' }, limits);
  mock.timers.tick(59_000);
  await call('add-comment', { ...A, threadId: first.id, body: 'two' }, limits);
  await assert.rejects(call('add-comment', { ...A, threadId: first.id, body: 'three' }, limits), { message: /^threads\/rate-limited/ });
  await assert.rejects(call('add-thread', { ...A, body: 'three' }, limits), { message: /^threads\/rate-limited/ });
  await call('add-thread', { ...B, body: 'other key' }, limits);
  await call('edit-comment', { ...A, threadId: first.id, commentId: first.comments[0].id, body: 'edited' }, limits);
  await call('toggle-reaction', { ...A, threadId: first.id, commentId: first.comments[0].id, emoji: '👍' }, limits);
  assert.equal((await ops('a')).length, 3); // two adds, one reaction; the edit folded into the drafted add
  mock.timers.tick(2_000); // t = 61 s
  await call('add-comment', { ...A, threadId: first.id, body: 'four' }, limits);
});
