import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, makeCtx, type TempProject } from './helpers.ts';
import { actions } from '../src/plugin/actions.ts';
import { canDo, assertCan, type PermissionAction, type PermissionTarget } from '../src/plugin/permissions.ts';
import type { Caller } from '../src/types.ts';

// ---------------------------------------------------------------------------
// canDo: the decision table
// ---------------------------------------------------------------------------

const who = (key: string, over: Partial<Caller> = {}): Caller =>
  ({ key, name: key, email: null, avatarUrl: '', source: 'header', isAdmin: false, ...over });
const ALICE = who('alice');
const BOB = who('bob');
const ROOT = who('root', { isAdmin: true });
const DEV = who('dev', { source: 'payload' });

type Row = [label: string, caller: Caller, action: PermissionAction, target: PermissionTarget, resolve: 'anyone' | 'author', allowed: boolean];
const rows: Row[] = [
  ['edit: author', ALICE, 'edit-comment', { authorKey: 'alice' }, 'anyone', true],
  ['edit: other', BOB, 'edit-comment', { authorKey: 'alice' }, 'anyone', false],
  ['edit: admin', ROOT, 'edit-comment', { authorKey: 'alice' }, 'anyone', true],
  ['delete: other', BOB, 'delete-comment', { authorKey: 'alice' }, 'anyone', false],
  ['delete: legacy comment, member', BOB, 'delete-comment', {}, 'anyone', false],
  ['delete: legacy comment, admin', ROOT, 'delete-comment', { authorKey: null }, 'anyone', true],
  ['delete: legacy comment, payload caller', DEV, 'delete-comment', {}, 'author', true],
  ['edit: drafted', BOB, 'edit-comment', { authorKey: 'alice', drafted: true }, 'anyone', true],
  ['delete-thread: owns every comment', ALICE, 'delete-thread', { authorKeys: ['alice', 'alice'] }, 'anyone', true],
  ['delete-thread: one foreign comment', ALICE, 'delete-thread', { authorKeys: ['alice', 'bob'] }, 'anyone', false],
  ['delete-thread: one legacy comment', ALICE, 'delete-thread', { authorKeys: ['alice', undefined] }, 'anyone', false],
  ['delete-thread: admin', ROOT, 'delete-thread', { authorKeys: ['alice', 'bob'] }, 'anyone', true],
  ['resolve anyone: stranger', BOB, 'resolve-thread', { threadAuthor: 'alice' }, 'anyone', true],
  ['resolve author: stranger', BOB, 'resolve-thread', { threadAuthor: 'alice' }, 'author', false],
  ['resolve author: thread author', ALICE, 'resolve-thread', { threadAuthor: 'alice' }, 'author', true],
  ['resolve author: admin', ROOT, 'resolve-thread', { threadAuthor: 'alice' }, 'author', true],
  ['resolve author: legacy thread', BOB, 'resolve-thread', {}, 'author', false],
  ['resolve author: drafted thread', BOB, 'resolve-thread', { drafted: true }, 'author', true],
  ['discard: other', BOB, 'discard-review', { reviewAuthor: 'alice' }, 'anyone', false],
  ['discard: author', ALICE, 'discard-review', { reviewAuthor: 'alice' }, 'anyone', true],
  ['discard: admin', ROOT, 'discard-review', { reviewAuthor: 'alice' }, 'anyone', true],
  ['upsert: own key', ALICE, 'upsert-author', { authorKey: 'alice' }, 'anyone', true],
  ['upsert: no key', ALICE, 'upsert-author', {}, 'anyone', true],
  ['upsert: another key', BOB, 'upsert-author', { authorKey: 'alice' }, 'anyone', false],
  ['upsert: admin cannot write another key', ROOT, 'upsert-author', { authorKey: 'alice' }, 'anyone', false],
  ['payload caller is never enforced', DEV, 'discard-review', { reviewAuthor: 'alice' }, 'author', true],
];

test('canDo decision table', () => {
  for (const [label, caller, action, target, resolve, allowed] of rows) {
    assert.equal(canDo(caller, action, target, { resolve }), allowed, label);
  }
});

test('assertCan throws threads/forbidden and only then', () => {
  assert.doesNotThrow(() => assertCan(ALICE, 'edit-comment', { authorKey: 'alice' }, { resolve: 'anyone' }));
  assert.throws(
    () => assertCan(BOB, 'edit-comment', { authorKey: 'alice' }, { resolve: 'anyone' }),
    (e: any) => e.code === 'forbidden' && e.message.startsWith('threads/forbidden: '),
  );
});

// ---------------------------------------------------------------------------
// Wiring: each handler denies and allows through the actions
// ---------------------------------------------------------------------------

const HEADER = 'x-id';
let project: TempProject;
let page: string;
let reviewId: string;
const threadsCfg = { identityHeader: HEADER, permissions: { admins: ['root'], resolve: 'author' } };
const ctxFor = (key: string) => makeCtx(project.root, {
  config: { src: 'docs', plugins: { threads: threadsCfg } },
  caller: { transport: 'websocket', headers: { [HEADER]: key }, origin: null, remoteAddress: null, connectionId: key, connectedAt: 0 },
});
const call = (name: string, key: string, payload: Record<string, unknown> = {}) =>
  (actions as Record<string, any>)[`threads:${name}`]({ file: project.file, ...payload }, ctxFor(key));
const forbidden = (p: Promise<unknown>) => assert.rejects(p, /^ThreadsError: threads\/forbidden: /);
const anchor = { quote: 'x', prefix: null, suffix: null, selector: null, offset: null, blockText: null };

// alice's published thread: two comments by her (the second is a reply), in one published review
let tA: string, c1: string, c2: string;
before(async () => {
  project = tempProject();
  page = project.file;
  const t = await call('add-thread', 'alice', { body: 'first', anchor });
  tA = t.id; c1 = t.comments[0].id;
  c2 = (await call('add-comment', 'alice', { threadId: tA, body: 'second' })).id;
  reviewId = (await call('whoami', 'alice')).journal.review.id;
  await call('publish-review', 'alice');
});
after(() => project.cleanup());

test('edit-comment: a stranger is forbidden, the author and an admin are not', async () => {
  await forbidden(call('edit-comment', 'bob', { threadId: tA, commentId: c1, body: 'x' }));
  await call('edit-comment', 'alice', { threadId: tA, commentId: c1, body: 'mine' });
  await call('edit-comment', 'root', { threadId: tA, commentId: c1, body: 'admin' });
});

test('edit-comment on a legacy comment: admin only', async () => {
  await forbidden(call('edit-comment', 'alice', { threadId: 't-thread1', commentId: 'c1-1', body: 'x' }));
  await call('edit-comment', 'root', { threadId: 't-thread1', commentId: 'c1-1', body: 'x' });
});

test('delete-comment: a stranger is forbidden, the author is not', async () => {
  await forbidden(call('delete-comment', 'bob', { threadId: tA, commentId: c2 }));
  await call('delete-comment', 'alice', { threadId: tA, commentId: c2 });
});

test('delete-thread: forbidden unless the caller owns every comment', async () => {
  await call('add-comment', 'bob', { threadId: tA, body: 'bob was here' });
  await call('publish-review', 'bob');
  await forbidden(call('delete-thread', 'alice', { threadId: tA }));
  await call('delete-thread', 'root', { threadId: tA });
});

test('resolve-thread with resolve: author', async () => {
  await forbidden(call('resolve-thread', 'bob', { threadId: tA }));
  await call('resolve-thread', 'alice', { threadId: tA });
});

test('upsert-author: another key is forbidden, the caller\'s own is not', async () => {
  await forbidden(call('upsert-author', 'bob', { authorKey: 'alice', name: 'Mallory' }));
  await call('upsert-author', 'bob', { authorKey: 'bob', name: 'Bob' });
});

test('discard-review: a stranger is forbidden and nothing changes, the author is not', async () => {
  const manifest = path.join(project.root, 'docs', '.threads', 'reviews', `${reviewId}.json`);
  const before = fs.readFileSync(path.join(project.root, page), 'utf8');
  await forbidden(call('discard-review', 'bob', { reviewId }));
  assert.equal(fs.readFileSync(path.join(project.root, page), 'utf8'), before);
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).state, 'published');
  await call('discard-review', 'alice', { reviewId });
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).state, 'discarded');
});
