import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, makeCtx, type TempProject } from './helpers.ts';
import { actions } from '../src/plugin/actions.ts';
import { createDraftStore, makeOp } from '../src/plugin/drafts.ts';
import { applyOps, deriveTargets, discard, publish, reverseOps } from '../src/plugin/reviews.ts';
import { createLock, createNoGitSync, type Sync } from '../src/plugin/lock.ts';
import * as parser from '../src/plugin/parser.ts';
import type { DraftOp, NewDraftOp } from '../src/types.ts';

const AT = '2026-03-10T12:00:00.000Z';
const FILE = 'docs/index.md';
const anchor = (q: string) => ({ quote: q, prefix: null, suffix: null, selector: null, offset: null, blockText: null });
const mk = (op: NewDraftOp): DraftOp => makeOp(op, AT);

// ---------------------------------------------------------------------------
// reverseOps: small, pure
// ---------------------------------------------------------------------------

const PAGE = `---
title: Sample
---

Some ==marked text=={t-1} here and plain target text.

::: threads
  ::: thread t-1
    ::: anchor
      marked text
    :::

    ::: comment c-1 "Bob" "2026-03-01"
      First.

      ::: reactions
        - 👍 Bob
      :::
    :::

    ::: comment c-2 "Bob" "2026-03-02"
      Second.
    :::
  :::

  ::: thread t-2
    ::: comment c-3 "Bob" "2026-03-03"
      Other.
    :::
  :::
:::
`;

/** PAGE as the serializer writes it, so reversals can be compared byte for byte. */
const NORMAL = parser.replaceThreadsBlock(PAGE, parser.parseThreadsFromContent(PAGE));
const apply = (ops: DraftOp[], content = PAGE, name = 'Alice') =>
  applyOps(content, ops, { authorKey: `k-${name}`, authorName: name, reviewId: 'r-1', targets: deriveTargets(content, ops, name) });

const rows: Array<{ name: string; author?: string; ops: NewDraftOp[]; changes: RegExp }> = [
  { name: 'add-comment', ops: [{ kind: 'add-comment', file: FILE, threadId: 't-2', commentId: 'c-r', parentId: 'c-3', body: 'R' }], changes: /c-r/ },
  { name: 'edit-comment', ops: [{ kind: 'edit-comment', file: FILE, threadId: 't-1', commentId: 'c-2', body: 'Changed' }], changes: /Changed/ },
  { name: 'delete-comment (original position)', ops: [{ kind: 'delete-comment', file: FILE, threadId: 't-1', commentId: 'c-1' }], changes: /^(?![\s\S]*First)/ },
  { name: 'delete-thread (thread and highlight)', ops: [{ kind: 'delete-thread', file: FILE, threadId: 't-1' }], changes: /^(?![\s\S]*thread t-1)/ },
  { name: 'resolve-thread', ops: [{ kind: 'resolve-thread', file: FILE, threadId: 't-2' }], changes: /resolved "Alice"/ },
  { name: 'toggle-reaction (add)', ops: [{ kind: 'toggle-reaction', file: FILE, threadId: 't-1', commentId: 'c-2', emoji: '🎉' }], changes: /🎉/ },
  { name: 'toggle-reaction (remove)', author: 'Bob', ops: [{ kind: 'toggle-reaction', file: FILE, threadId: 't-1', commentId: 'c-1', emoji: '👍' }], changes: /^(?![\s\S]*👍)/ },
];

let published: ReturnType<typeof apply>;
const appliedRows = new Map<string, ReturnType<typeof apply>>();
before(() => {
  for (const row of rows) appliedRows.set(row.name, apply(row.ops.map(mk), NORMAL, row.author ?? 'Alice'));
  published = apply([
    mk({ kind: 'add-thread', file: FILE, threadId: 't-new', commentId: 'c-new', anchor: anchor('plain target text'), body: 'New' }),
  ]);
});

for (const row of rows) {
  test(`reverseOps undoes ${row.name}`, () => {
    const author = row.author ?? 'Alice';
    const done = appliedRows.get(row.name)!;
    assert.match(done.content, row.changes, 'the op changed the page');
    const back = reverseOps(done.content, done.applied, { authorName: author });
    assert.deepEqual(back.skipped, []);
    assert.equal(back.content, NORMAL);
    assert.equal(reverseOps(back.content, done.applied, { authorName: author }).content, back.content, 'second run changes nothing');
  });
}

test('reverseOps removes a started thread with a later reply by someone else and unwraps its highlight', () => {
  const withBobReply = apply(
    [mk({ kind: 'add-comment', file: FILE, threadId: 't-new', commentId: 'c-bob', parentId: 'c-new', body: 'Later' })],
    published.content,
    'Bob',
  ).content;
  assert.match(withBobReply, /==plain target text=={t-new}/);
  const back = reverseOps(withBobReply, published.applied, { authorName: 'Alice' });
  assert.deepEqual(back.skipped, []);
  assert.equal(back.content, NORMAL);
});

test('reverseOps re-parents later replies to a removed reply', () => {
  const r = apply([mk({ kind: 'add-comment', file: FILE, threadId: 't-2', commentId: 'c-r', parentId: 'c-3', body: 'R' })], NORMAL);
  const later = apply([mk({ kind: 'add-comment', file: FILE, threadId: 't-2', commentId: 'c-bob', parentId: 'c-r', body: 'To R' })], r.content, 'Bob');
  const back = reverseOps(later.content, r.applied, { authorName: 'Alice' });
  const t2 = parser.parseThreadsFromContent(back.content).find((t) => t.id === 't-2')!;
  assert.deepEqual(t2.comments.map((c) => [c.id, c.parent_id]), [['c-3', null], ['c-bob', 'c-3']]);
});

test('reverseOps skips ops whose target is gone, reverses the rest, and a second run is the same', () => {
  const ops = apply([
    mk({ kind: 'add-thread', file: FILE, threadId: 't-new', commentId: 'c-new', anchor: null, body: 'New' }),
    mk({ kind: 'add-comment', file: FILE, threadId: 't-2', commentId: 'c-r', parentId: 'c-3', body: 'R' }),
  ], NORMAL);
  // someone deleted t-new since the publish
  const gone = parser.replaceThreadsBlock(ops.content, parser.parseThreadsFromContent(ops.content).filter((t) => t.id !== 't-new'));
  const first = reverseOps(gone, ops.applied, { authorName: 'Alice' });
  assert.deepEqual(first.skipped.map((s) => s.opId), [ops.applied[0].opId]);
  assert.match(first.skipped[0].reason, /t-new/);
  assert.equal(first.content, NORMAL);
  const second = reverseOps(first.content, ops.applied, { authorName: 'Alice' });
  assert.equal(second.content, first.content);
});

// ---------------------------------------------------------------------------
// discard: medium, one temp project per file
// ---------------------------------------------------------------------------

let project: TempProject;
let docsRoot: string;
const ctx = () => makeCtx(project.root, { config: { src: 'docs' } });
const read = (rel: string) => fs.readFileSync(path.join(project.root, rel), 'utf8');
const manifestOf = (id: string) => JSON.parse(fs.readFileSync(path.join(docsRoot, '.threads', 'reviews', `${id}.json`), 'utf8'));
const ALICE = { author: 'Alice', authorKey: 'k-alice' };
const BOB = { author: 'Bob', authorKey: 'k-bob' };
const store = () => createDraftStore(docsRoot);
const fill = (key: string, ops: NewDraftOp[]) => store().transact(key, (j, at) => void j.ops.push(...ops.map((o) => makeOp(o, at))));
const threadsOf = (rel: string) => parser.parseThreadsFromContent(read(rel));

let original: string;
let aliceReview: string;

before(() => {
  project = tempProject();
  docsRoot = path.join(project.root, 'docs');
});
after(() => project.cleanup());
beforeEach(async () => {
  project.reset();
  fs.rmSync(path.join(docsRoot, '.threads'), { recursive: true, force: true });
  original = read(FILE);
  await fill('k-alice', [
    { kind: 'add-thread', file: FILE, threadId: 't-new', commentId: 'c-new', anchor: anchor('parser rules here'), body: 'New on index' },
    { kind: 'add-comment', file: FILE, threadId: 't-thread2', commentId: 'c-rep', parentId: 'c2-1', body: 'Reply' },
  ]);
  aliceReview = (await actions['threads:publish-review'](ALICE, ctx())).reviewId;
  await fill('k-bob', [{ kind: 'add-comment', file: FILE, threadId: 't-new', commentId: 'c-bob', parentId: 'c-new', body: 'Later' }]);
  await actions['threads:publish-review'](BOB, ctx());
});

test('discarding a published review removes its threads and replies, unwraps highlights, marks the manifest and rejects a second discard', async () => {
  assert.match(read(FILE), /==parser rules here=={t-new}/);
  // someone removed Alice's reply since the publish: skipped and recorded, the rest reversed
  fs.writeFileSync(path.join(project.root, FILE), parser.replaceThreadsBlock(read(FILE), threadsOf(FILE).map((t) => ({ ...t, comments: t.comments.filter((c) => c.id !== 'c-rep') }))));
  const res = await actions['threads:discard-review']({ ...ALICE, reviewId: aliceReview }, ctx());
  assert.deepEqual(res, { discarded: true });

  const threads = threadsOf(FILE);
  assert.ok(!threads.some((t) => t.id === 't-new'), 't-new gone with Bob\'s reply');
  assert.ok(!read(FILE).includes('{t-new}'));
  assert.match(read(FILE), /parser rules here/);
  const u = threads.find((t) => t.id === 't-thread2')!;
  const u0 = parser.parseThreadsFromContent(original).find((t) => t.id === 't-thread2')!;
  assert.deepEqual(u.comments.map((c) => c.id), u0.comments.map((c) => c.id));
  assert.ok(!threads.some((t) => t.comments.some((c) => c.id === 'c-rep')));

  const m = manifestOf(aliceReview);
  assert.equal(m.state, 'discarded');
  assert.equal(m.discardedBy, 'k-alice');
  assert.equal(m.discardSkipped.length, 1);
  assert.match(m.discardSkipped[0].reason, /c-rep/);
  const list = await actions['threads:list-reviews']({}, ctx());
  assert.equal(list.find((r: any) => r.id === aliceReview).state, 'discarded');

  await assert.rejects(
    actions['threads:discard-review']({ ...ALICE, reviewId: aliceReview }, ctx()),
    /threads\/invalid: .*already discarded/,
  );
});

test('discarding the open review only empties the journal', async () => {
  await fill('k-alice', [{ kind: 'add-comment', file: FILE, threadId: 't-thread1', commentId: 'c-open', parentId: null, body: 'Open' }]);
  const open = (await store().load('k-alice')).review.id;
  const files = read(FILE);
  const before = fs.readdirSync(path.join(docsRoot, '.threads', 'reviews')).sort();

  assert.deepEqual(await actions['threads:discard-review']({ ...ALICE, reviewId: open }, ctx()), { discarded: true });
  const journal = await store().load('k-alice');
  assert.deepEqual(journal.ops, []);
  assert.equal(journal.review.id, open);
  assert.equal(read(FILE), files);
  assert.deepEqual(fs.readdirSync(path.join(docsRoot, '.threads', 'reviews')).sort(), before, 'no manifest written');
});

test('an unknown review id is not-found', async () => {
  await assert.rejects(actions['threads:discard-review']({ ...ALICE, reviewId: 'r-nope' }, ctx()), /threads\/not-found/);
});

test('discard runs through sync.withLock and publishWithRetry, and records the injected clock', async () => {
  const lock = createLock();
  const log: string[] = [];
  const sync: Sync = {
    withLock: (fn) => { log.push('lock'); return lock.withLock(fn); },
    async publishWithRetry(apply, meta) { log.push(`retry:${meta.reviewId}`); await apply(); log.push('applied'); },
  };
  const ALICE_CALLER = { key: 'k-alice', name: 'Alice', email: null, avatarUrl: '', source: 'payload' as const };
  await discard(ALICE_CALLER, ctx(), aliceReview, { store: store(), sync, now: () => Date.parse('2031-02-03T04:05:06.000Z') });
  assert.deepEqual(log, ['lock', `retry:${aliceReview}`, 'applied']);
  const m = manifestOf(aliceReview);
  assert.equal(m.discardedAt, '2031-02-03T04:05:06.000Z');
  assert.deepEqual(m.discardSkipped, []);
});

/** A publish whose files and manifest were written but whose journal reset failed, then discarded. */
async function discardedInWindow() {
  await fill('k-alice', [{ kind: 'add-comment', file: FILE, threadId: 't-thread1', commentId: 'c-win', parentId: null, body: 'Window' }]);
  const real = store();
  let failed = false;
  const flaky = { ...real, transact: (...a: Parameters<typeof real.transact>) => {
    if (!failed) { failed = true; throw new Error('reset failed'); }
    return real.transact(...a);
  } };
  const ALICE_CALLER = { key: 'k-alice', name: 'Alice', email: null, avatarUrl: '', source: 'payload' as const };
  await assert.rejects(publish(ALICE_CALLER, ctx(), {}, { store: flaky, sync: createNoGitSync(createLock()) }), /reset failed/);
  const id = (await real.load('k-alice')).review.id;
  assert.ok(threadsOf(FILE).some((t) => t.comments.some((c) => c.id === 'c-win')), 'the publish wrote its file');
  await actions['threads:discard-review']({ ...ALICE, reviewId: id }, ctx());
  assert.ok(!threadsOf(FILE).some((t) => t.comments.some((c) => c.id === 'c-win')));
  return { id, real, discarded: manifestOf(id) };
}

test('a discard in the window after a failed journal reset is not undone by the next publish', async () => {
  const { id, real, discarded } = await discardedInWindow();
  // nothing left to publish: the reset is finished, not reported as a publish
  await assert.rejects(actions['threads:publish-review'](ALICE, ctx()), /threads\/empty-review/);
  assert.ok(!threadsOf(FILE).some((t) => t.comments.some((c) => c.id === 'c-win')), 'discarded comment did not come back');
  assert.deepEqual(manifestOf(id), discarded);
  assert.notEqual((await real.load('k-alice')).review.id, id, 'the journal was reset');
});

test('ops drafted after such a discard publish under a new review id', async () => {
  const { id, discarded } = await discardedInWindow();
  await fill('k-alice', [{ kind: 'add-comment', file: FILE, threadId: 't-thread1', commentId: 'c-after', parentId: null, body: 'After' }]);
  const next = await actions['threads:publish-review'](ALICE, ctx());
  assert.notEqual(next.reviewId, id);
  assert.ok(threadsOf(FILE).some((t) => t.comments.some((c) => c.id === 'c-after')));
  assert.ok(!threadsOf(FILE).some((t) => t.comments.some((c) => c.id === 'c-win')));
  assert.deepEqual(manifestOf(id), discarded);
});
