/*
 * Coverage map: the old immediate-write cases and the drafts cases that now cover them.
 *   add-thread creates a thread, ids, reloads          -> "add-thread and add-comment leave the markdown untouched" (AC-7, A-13)
 *   add-comment appends / get-threads returns both      -> same + "get-threads overlays the drafter only" (AC-8)
 *   edit-comment, delete-comment, delete-thread,
 *   resolve-thread, toggle-reaction                     -> "mutations on published targets append ops" and
 *                                                          "drafted target: ..." cases (A-1);
 *                                                          the transformation itself: overlay.test.ts
 *   add-thread highlight markup / delete-thread
 *   unwrapping the highlight                            -> moved to publish (the markdown is no longer written here)
 *   input validation, threads/<code> prefix             -> kept
 *   plugin surface                                      -> kept, extended with the new action names
 */
import { test, mock, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, makeCtx, type TempProject } from './helpers.ts';
import { actions } from '../src/plugin/actions.ts';
import { createDraftStore } from '../src/plugin/drafts.ts';
import * as plugin from '../src/index.ts';

let project: TempProject;
before(() => {
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-10T12:00:00Z') });
  project = tempProject();
});
after(() => {
  mock.timers.reset();
  project.cleanup();
});
beforeEach(() => {
  // guardWrite keeps one rate limiter per projectRoot, so this file's same-author adds share it:
  mock.timers.tick(60_000); // a fresh rate-limit window per test; the clock is frozen otherwise
  project.reset();
  fs.rmSync(path.join(project.root, 'docs', '.threads'), { recursive: true, force: true });
});

const ALICE = { author: 'Alice', authorKey: 'k-alice' };
const BOB = { author: 'Bob', authorKey: 'k-bob' };
const call = (name: string, payload: Record<string, unknown>, config: any = { src: 'docs' }) =>
  (actions as Record<string, any>)[name](payload, makeCtx(project.root, { config }));
const read = (rel: string = project.file) => fs.readFileSync(path.join(project.root, rel), 'utf8');
const journalOf = async (key: string) => createDraftStore(path.join(project.root, 'docs')).load(key);
const f = () => ({ file: project.file });

async function draftThread(who = ALICE, body = 'This needs to be reworded.') {
  return call('threads:add-thread', { ...f(), ...who, body, anchor: { quote: 'x', prefix: null, suffix: null, selector: null, offset: null, blockText: null } });
}

test('get-threads without identity returns the published threads', async () => {
  const result = await call('threads:get-threads', f());
  assert.deepEqual(result.map((t: any) => t.id), ['t-thread1', 't-thread2', 't-thread3']);
  assert.deepEqual(result.map((t: any) => t.resolved), [false, false, true]);
  assert.deepEqual(result[0].comments.map((c: any) => c.author), ['Alice', 'Bob']);
});

test('add-thread and add-comment leave the markdown untouched and journal two ops', async () => {
  const before = read();
  const thread = await draftThread();
  const comment = await call('threads:add-comment', { ...f(), ...BOB, threadId: 't-thread1', body: 'reply', parentId: 'c-x' });
  assert.equal(read(), before);

  // A-13: final ids, returned and journaled
  assert.match(thread.id, /^t-[0-9a-f]{8}$/);
  assert.match(thread.comments[0].id, /^c-[0-9a-f]{8}$/);
  assert.match(comment.id, /^c-[0-9a-f]{8}$/);
  assert.deepEqual([thread.draft, thread.comments[0].draft, comment.draft], [true, true, true]);

  const a = await journalOf('k-alice');
  assert.equal(a.version, 1);
  assert.equal(a.ops.length, 1);
  assert.deepEqual(
    [a.ops[0].kind, (a.ops[0] as any).threadId, (a.ops[0] as any).commentId, (a.ops[0] as any).body],
    ['add-thread', thread.id, thread.comments[0].id, 'This needs to be reworded.'],
  );
  assert.equal((a.ops[0] as any).anchor.quote, 'x');
  const b = await journalOf('k-bob');
  assert.deepEqual([b.ops[0].kind, (b.ops[0] as any).parentId, (b.ops[0] as any).commentId], ['add-comment', 'c-x', comment.id]);
  // every op carries an ISO timestamp; updatedAt is the last mutation's
  assert.equal(new Date(a.ops[0].at).toISOString(), a.ops[0].at);
  assert.equal(a.review.updatedAt, a.ops[0].at);
});

test('get-threads overlays the drafter only, and the result is the same from disk', async () => {
  const thread = await draftThread();
  await call('threads:add-comment', { ...f(), ...ALICE, threadId: 't-thread1', body: 'mine' });

  const mine = await call('threads:get-threads', { ...f(), ...ALICE });
  assert.deepEqual(mine.map((t: any) => t.id), ['t-thread1', 't-thread2', 't-thread3', thread.id]);
  assert.equal(mine[0].draft, undefined);
  assert.deepEqual(mine[0].comments.map((c: any) => c.draft), [undefined, undefined, true]);
  assert.equal(mine[3].draft, true);

  const theirs = await call('threads:get-threads', { ...f(), ...BOB });
  assert.deepEqual(theirs.map((t: any) => t.id), ['t-thread1', 't-thread2', 't-thread3']);
  assert.ok(theirs.every((t: any) => !t.draft && t.comments.every((c: any) => !c.draft)));

  // reload: the handlers keep no state beyond a lock, so a second call reads the journal back from disk
  const again = await call('threads:get-threads', { ...f(), ...ALICE });
  assert.deepEqual(again, mine);
  assert.deepEqual(again.map((t: any) => t.id), ['t-thread1', 't-thread2', 't-thread3', thread.id]);
  assert.equal(again[3].draft, true);
  assert.deepEqual(again[0].comments.map((c: any) => c.draft), [undefined, undefined, true]);
});

test('mutations on published targets append an op of their kind', async () => {
  const t = { ...f(), ...ALICE, threadId: 't-thread1' };
  await call('threads:edit-comment', { ...t, commentId: 'c1-1', body: 'edited' });
  await call('threads:resolve-thread', t);
  await call('threads:toggle-reaction', { ...t, commentId: 'c1-1', emoji: '👍' });
  await call('threads:delete-comment', { ...t, commentId: 'c1-2' });
  await call('threads:delete-thread', { ...f(), ...ALICE, threadId: 't-thread2' });
  const ops = (await journalOf('k-alice')).ops;
  assert.deepEqual(ops.map((o) => o.kind), ['edit-comment', 'resolve-thread', 'toggle-reaction', 'delete-comment', 'delete-thread']);
});

test('deleting a published comment first drops the caller\'s earlier ops on it', async () => {
  const t = { ...f(), ...ALICE, threadId: 't-thread1', commentId: 'c1-1' };
  await call('threads:edit-comment', { ...t, body: 'edited' });
  await call('threads:toggle-reaction', { ...t, emoji: '👍' });
  await call('threads:delete-comment', t);
  assert.deepEqual((await journalOf('k-alice')).ops.map((o) => o.kind), ['delete-comment']);
});

test('deleting a published thread drops the caller\'s drafted comments on it', async () => {
  await call('threads:add-comment', { ...f(), ...ALICE, threadId: 't-thread1', body: 'mine' });
  await call('threads:delete-thread', { ...f(), ...ALICE, threadId: 't-thread1' });
  assert.deepEqual((await journalOf('k-alice')).ops.map((o) => o.kind), ['delete-thread']);
});

test('deleting a comment also deletes the caller\'s drafted replies to it', async () => {
  const thread = await draftThread();
  const parent = await call('threads:add-comment', { ...f(), ...ALICE, threadId: thread.id, body: 'p' });
  const child = await call('threads:add-comment', { ...f(), ...ALICE, threadId: thread.id, body: 'c', parentId: parent.id });
  await call('threads:add-comment', { ...f(), ...ALICE, threadId: thread.id, body: 'grandchild', parentId: child.id });
  await call('threads:delete-comment', { ...f(), ...ALICE, threadId: thread.id, commentId: parent.id });
  assert.deepEqual((await journalOf('k-alice')).ops.map((o) => o.kind), ['add-thread']);
});

test('concurrent toggles of one reaction on a drafted comment cancel out', async () => {
  const thread = await draftThread();
  const t = { ...f(), ...ALICE, threadId: thread.id, commentId: thread.comments[0].id, emoji: '👍' };
  await Promise.all([call('threads:toggle-reaction', t), call('threads:toggle-reaction', t)]);
  assert.deepEqual((await journalOf('k-alice')).ops.map((o) => o.kind), ['add-thread']);
});

// A-1, drafted targets: each case starts from a fresh drafted thread (+ a drafted reply) and checks the journal.
const drafted: Array<[string, (t: any, reply: any) => Promise<void>]> = [
  ['edit changes the add-comment op body', async (t, reply) => {
    const edited = await call('threads:edit-comment', { ...f(), ...ALICE, threadId: t.id, commentId: reply.id, body: 'fixed' });
    assert.equal(edited.body, 'fixed');
    const ops = (await journalOf('k-alice')).ops as any[];
    assert.deepEqual([ops.length, ops[1].kind, ops[1].body], [2, 'add-comment', 'fixed']);
  }],
  ['resolve toggles on and off', async (t) => {
    const resolve = () => call('threads:resolve-thread', { ...f(), ...ALICE, threadId: t.id });
    assert.equal((await resolve()).resolved, true);
    assert.equal((await journalOf('k-alice')).ops.length, 3);
    assert.equal((await resolve()).resolved, false);
    assert.equal((await journalOf('k-alice')).ops.length, 2);
  }],
  ['reaction toggles on and off', async (t, reply) => {
    const react = () => call('threads:toggle-reaction', { ...f(), ...ALICE, threadId: t.id, commentId: reply.id, emoji: '👍' });
    assert.deepEqual(await react(), [{ emoji: '👍', authors: ['Alice'] }]);
    assert.equal((await journalOf('k-alice')).ops.length, 3);
    assert.deepEqual(await react(), []);
    assert.equal((await journalOf('k-alice')).ops.length, 2);
  }],
  ['delete-comment removes the reply op', async (t, reply) => {
    await call('threads:delete-comment', { ...f(), ...ALICE, threadId: t.id, commentId: reply.id });
    assert.deepEqual((await journalOf('k-alice')).ops.map((o) => o.kind), ['add-thread']);
  }],
  ['delete-comment of the first comment removes the thread', async (t) => {
    await call('threads:delete-comment', { ...f(), ...ALICE, threadId: t.id, commentId: t.comments[0].id });
    assert.equal((await journalOf('k-alice')).ops.length, 0);
    assert.ok(!(await call('threads:get-threads', { ...f(), ...ALICE })).some((x: any) => x.id === t.id));
  }],
  ['delete-thread removes every op on it', async (t) => {
    await call('threads:delete-thread', { ...f(), ...ALICE, threadId: t.id });
    assert.equal((await journalOf('k-alice')).ops.length, 0);
    assert.ok(!(await call('threads:get-threads', { ...f(), ...ALICE })).some((x: any) => x.id === t.id));
  }],
];
for (const [name, run] of drafted) {
  test(`drafted target: ${name}`, async () => {
    const thread = await draftThread();
    const reply = await call('threads:add-comment', { ...f(), ...ALICE, threadId: thread.id, body: 'second' });
    assert.equal((await journalOf('k-alice')).ops.length, 2);
    await run(thread, reply);
  });
}

test('whoami reports the payload identity and journal, or nulls without one', async () => {
  const withId = await call('threads:whoami', ALICE);
  assert.deepEqual(withId.identity, { key: 'k-alice', name: 'Alice', email: null, avatarUrl: '', source: 'payload', isAdmin: false });
  assert.equal(withId.journal.authorKey, 'k-alice');
  assert.deepEqual(await call('threads:whoami', {}), { identity: null, journal: null, orphanedMine: 0 });
});

test('set-mode persists collect and auto, and rejects other values', async () => {
  const j = await call('threads:set-mode', { ...ALICE, mode: 'collect' });
  assert.equal(j.mode, 'collect');
  assert.equal((await journalOf('k-alice')).mode, 'collect');
  assert.equal((await call('threads:set-mode', { ...ALICE, mode: 'auto' })).mode, 'auto');
  await assert.rejects(call('threads:set-mode', { ...ALICE, mode: 'nope' }), (e: Error) => e.message.startsWith('threads/invalid:'));
  assert.equal((await journalOf('k-alice')).mode, 'auto');
});

test('a new journal starts in the mode autoPublish asks for', async () => {
  const cases: Array<[string, any, string]> = [
    ['default (startOn)', undefined, 'auto'],
    ['startOn false', { autoPublish: { startOn: false } }, 'collect'],
    ['autoPublish false', { autoPublish: false }, 'collect'],
  ];
  for (const [name, threads, mode] of cases) {
    const who = { author: name, authorKey: `k-${name}` };
    const r = await call('threads:whoami', who, { src: 'docs', plugins: { threads } });
    assert.equal(r.journal.mode, mode, name);
  }
});

test('upsert-author writes authors.json as before', async () => {
  await call('threads:upsert-author', { authorKey: 'k1', name: 'Kay', avatarUrl: 'http://a/x.png' });
  await call('threads:upsert-author', { authorKey: 'k1', name: 'Kay 2' });
  const file = path.join(project.root, 'docs', '.threads', 'authors.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { k1: { name: 'Kay 2', avatarUrl: 'http://a/x.png' } });
  assert.deepEqual(await call('threads:get-authors', {}), { k1: { name: 'Kay 2', avatarUrl: 'http://a/x.png' } });
});

test('input validation rejects missing fields', async () => {
  const rejects = (name: string, payload: Record<string, unknown>, msg: string) =>
    assert.rejects(call(name, payload), (e: Error) => e.message.includes(msg));
  await rejects('threads:add-thread', { file: '', author: 'alice', body: 'hi' }, 'file is required');
  await rejects('threads:add-thread', { file: project.file, author: '', body: 'hi' }, 'author is required');
  await rejects('threads:add-thread', { file: project.file, author: 'alice', body: '   ' }, 'body is required');
  await rejects('threads:edit-comment', { ...f(), threadId: 't-thread1', commentId: 'c-1', body: 'x' }, 'caller identity is required');
});

test('lookup and validation failures carry the threads/<code> prefix', async () => {
  const rejects = (name: string, payload: Record<string, unknown>, msg: string) =>
    assert.rejects(call(name, payload), (e: Error) => e.message === msg);
  await rejects('threads:get-threads', {}, 'threads/invalid: threads:get-threads: file is required');
  await rejects('threads:edit-comment', { ...f(), ...ALICE, threadId: 't-nope', commentId: 'c-1', body: 'x' }, 'threads/not-found: Thread not found: t-nope');
  await rejects('threads:edit-comment', { ...f(), ...ALICE, threadId: 't-thread1', commentId: 'c-nope', body: 'x' }, 'threads/not-found: Comment not found: c-nope');
  await rejects('threads:delete-thread', { ...f(), ...ALICE, threadId: 't-nope' }, 'threads/not-found: Thread not found: t-nope');
});

test('plugin surface: descriptor, hooks and action names', () => {
  assert.equal(plugin.plugin.name, 'threads');
  assert.ok(plugin.plugin.capabilities?.includes('actions'));
  assert.equal(plugin.plugin.requiresLiveServer, true);
  assert.equal(typeof plugin.markdownSetup, 'function');
  assert.equal(typeof plugin.generateScripts, 'function');
  assert.equal(typeof plugin.getAssets, 'function');
  assert.equal(typeof plugin.actions, 'object');
  for (const name of [
    'add-thread', 'add-comment', 'resolve-thread', 'get-threads', 'delete-thread', 'delete-comment',
    'edit-comment', 'toggle-reaction', 'get-authors', 'upsert-author', 'whoami', 'set-mode',
  ]) {
    assert.equal(typeof plugin.actions[`threads:${name}`], 'function', name);
  }
  const assets = plugin.getAssets();
  const scripts = plugin.generateScripts({ src: path.join(project.root, 'docs') }, { sidebar: true });
  assert.ok(scripts.bodyScriptsHtml.includes('"sidebar":true'));
  assert.deepEqual(assets.map((a: any) => a.dest), ['assets/js/threads.js', 'assets/css/threads.css']);
});
