import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, makeCtx, type TempProject } from './helpers.ts';
import { actions } from '../src/plugin/actions.ts';
import { createDraftStore, makeOp } from '../src/plugin/drafts.ts';
import { applyOps, defaultTitle, pageTitleOf, publish } from '../src/plugin/reviews.ts';
import { createLock, createNoGitSync, type Sync } from '../src/plugin/lock.ts';
import { ThreadsError } from '../src/plugin/errors.ts';
import * as parser from '../src/plugin/parser.ts';
import type { DraftOp, NewDraftOp } from '../src/types.ts';

const AT = '2026-03-10T12:00:00.000Z';
const OPTS = { authorKey: 'k-alice', authorName: 'Alice', reviewId: 'r-00000001' };
const mk = (op: NewDraftOp): DraftOp => makeOp(op, AT);
const FILE = 'docs/index.md';
const quote = { quote: 'inline discussion threads', prefix: null, suffix: null, selector: null, offset: null, blockText: null };

// ---------------------------------------------------------------------------
// applyOps / titles: small, pure
// ---------------------------------------------------------------------------

const PAGE = `---
title: Sample
---

Some ==marked text=={t-1} here and plain target text.

::: threads
  ::: thread t-1
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

test('applyOps writes each op kind with tokens and captures before-states', () => {
  const ops = [
    mk({ kind: 'add-thread', file: FILE, threadId: 't-new', commentId: 'c-new', anchor: { ...quote, quote: 'plain target text' }, body: 'New thread' }),
    mk({ kind: 'add-comment', file: FILE, threadId: 't-2', commentId: 'c-reply', parentId: 'c-3', body: 'Reply' }),
    mk({ kind: 'edit-comment', file: FILE, threadId: 't-1', commentId: 'c-2', body: 'Second, edited.' }),
    mk({ kind: 'delete-comment', file: FILE, threadId: 't-1', commentId: 'c-1' }),
    mk({ kind: 'resolve-thread', file: FILE, threadId: 't-2' }),
    mk({ kind: 'toggle-reaction', file: FILE, threadId: 't-1', commentId: 'c-2', emoji: '🎉' }),
    mk({ kind: 'delete-thread', file: FILE, threadId: 't-1' }),
  ];
  const { content, applied, skipped } = applyOps(PAGE, ops, OPTS);
  assert.deepEqual(skipped, []);
  assert.equal(applied.length, 7);

  // highlight + anchor + tokens on the new thread; delete-thread unwrapped t-1's mark
  assert.match(content, /==plain target text=={t-new}/);
  assert.match(content, /Some marked text here/);
  const threads = parser.parseThreadsFromContent(content);
  assert.deepEqual(threads.map((t) => t.id), ['t-2', 't-new']);
  const added = threads.find((t) => t.id === 't-new')!;
  assert.deepEqual(added.anchor, { quote: 'plain target text' });
  assert.deepEqual(
    [added.comments[0].author, added.comments[0].authorKey, added.comments[0].reviewId, added.comments[0].date],
    ['Alice', 'k-alice', 'r-00000001', '2026-03-10'],
  );
  const t2 = threads.find((t) => t.id === 't-2')!;
  assert.equal(t2.comments[1].id, 'c-reply');
  assert.equal(t2.comments[1].parent_id, 'c-3');
  assert.deepEqual([t2.resolved, t2.resolved_by, t2.resolved_at], [true, 'Alice', '2026-03-10']);

  const by = (kind: string) => applied.find((o) => o.kind === kind)!;
  assert.equal(by('add-thread').quote, 'plain target text');
  assert.ok(applied.every((o) => o.pageTitle === 'Sample'));
  assert.deepEqual(by('edit-comment').before, { body: 'Second.', edited_at: null });
  assert.equal((by('delete-comment').before as any).comment.id, 'c-1');
  assert.deepEqual(by('resolve-thread').before, { resolved: false, resolved_by: null, resolved_at: null });
  assert.deepEqual(by('toggle-reaction').before, { present: false });
  assert.equal((by('delete-thread').before as any).thread.id, 't-1');
});

test('applyOps skips ops whose target is gone and applies the rest (A-10)', () => {
  const missingThread = mk({ kind: 'add-comment', file: FILE, threadId: 't-gone', commentId: 'c-x', parentId: null, body: 'x' });
  const missingComment = mk({ kind: 'edit-comment', file: FILE, threadId: 't-1', commentId: 'c-gone', body: 'x' });
  const fence = mk({ kind: 'add-thread', file: FILE, threadId: 't-f', commentId: 'c-f', anchor: { ...quote, quote: 'a\n::: threads\nb' }, body: 'x' });
  const good = mk({ kind: 'add-comment', file: FILE, threadId: 't-2', commentId: 'c-ok', parentId: null, body: 'kept' });
  const { content, applied, skipped } = applyOps(PAGE, [missingThread, missingComment, fence, good], OPTS);
  assert.deepEqual(skipped.map((s) => s.opId), [missingThread.opId, missingComment.opId, fence.opId]);
  assert.ok(skipped.every((s) => s.reason.length > 0));
  assert.deepEqual(applied.map((o) => o.opId), [good.opId]);
  assert.match(content, /c-ok/);
  assert.equal(applyOps(PAGE, [missingThread], OPTS).content, PAGE, 'nothing applied leaves the file byte-identical');
});

test('replaying ops over their own output changes nothing (C-16)', () => {
  const ops = [
    mk({ kind: 'add-thread', file: FILE, threadId: 't-new', commentId: 'c-new', anchor: { ...quote, quote: 'plain target text' }, body: 'New' }),
    mk({ kind: 'add-comment', file: FILE, threadId: 't-2', commentId: 'c-reply', parentId: null, body: 'Reply' }),
    mk({ kind: 'edit-comment', file: FILE, threadId: 't-1', commentId: 'c-2', body: 'Edited' }),
    mk({ kind: 'delete-comment', file: FILE, threadId: 't-1', commentId: 'c-1' }),
  ];
  const once = applyOps(PAGE, ops, OPTS);
  const twice = applyOps(once.content, ops, OPTS);
  assert.equal(twice.content, once.content);
  assert.deepEqual(twice.applied.map((o) => o.kind), ['edit-comment'], 'only the idempotent edit re-applies; re-adds and the repeated delete are skipped');
});

test('applyOps on the playground fixture writes the quote highlight and the anchor child', () => {
  const fixture = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'e2e', 'fixtures', 'playground-index.md'), 'utf8');
  const op = mk({ kind: 'add-thread', file: FILE, threadId: 't-fx', commentId: 'c-fx', anchor: quote, body: 'On the fixture' });
  const { content } = applyOps(fixture, [op], OPTS);
  // the first occurrence is already inside t-thread1's mark: wrapping nests, so only the token form is asserted
  assert.match(content, /==inline discussion threads=={t-fx}/);
  assert.match(content, /::: comment c-fx "Alice" "2026-03-10" by k-alice review r-00000001/);
  assert.match(content, /::: anchor\n\s+inline discussion threads\n\s+:::/);
  assert.deepEqual(parser.parseThreadsFromContent(content).map((t) => t.id), ['t-thread1', 't-thread2', 't-thread3', 't-fx']);
});

test('pageTitleOf prefers frontmatter, then the first heading, else null', () => {
  const cases: Array<[string, string | null]> = [
    ['---\ntitle: "Quoted"\n---\n# Heading', 'Quoted'],
    ['---\ndescription: x\n---\n\n# Heading ##\ntext', 'Heading'],
    ['intro\n# First\n# Second', 'First'],
    ['no title here\n## sub only', null],
    ['---\ntitle: Plain\n---', 'Plain'],
  ];
  for (const [content, want] of cases) assert.equal(pageTitleOf(content), want, content);
});

test('defaultTitle: plural, +K pages, cap and newline stripping (A-7)', () => {
  const op = (kind: DraftOp['kind'], file: string) => ({ kind, file });
  const titles = { 'a.md': 'Page A', 'b.md': 'Page B', 'c.md': null };
  const cases: Array<[string, ReturnType<typeof op>[], string]> = [
    ['Ann', [op('add-thread', 'a.md')], 'Comments by Ann: 1 comment on Page A'],
    ['Ann', [op('add-thread', 'a.md'), op('add-comment', 'a.md'), op('resolve-thread', 'a.md')], 'Comments by Ann: 2 comments on Page A'],
    ['Ann', [op('add-comment', 'a.md'), op('add-comment', 'b.md')], 'Comments by Ann: 2 comments on Page A, +1 page'],
    ['Ann', [op('add-comment', 'b.md'), op('add-comment', 'a.md'), op('add-comment', 'c.md')], 'Comments by Ann: 3 comments on Page B, +2 pages'],
    ['Ann', [op('resolve-thread', 'c.md')], 'Comments by Ann: 1 comment on c.md'],
    ['Line\nBreak', [op('add-comment', 'a.md')], 'Comments by Line Break: 1 comment on Page A'],
  ];
  for (const [name, ops, want] of cases) assert.equal(defaultTitle(name, ops, titles), want);
  const long = defaultTitle('N'.repeat(300), [op('add-comment', 'a.md')], titles);
  assert.equal(long.length, 120);
});

// ---------------------------------------------------------------------------
// publish: medium, one temp project per file
// ---------------------------------------------------------------------------

let project: TempProject;
let docsRoot: string;
const OTHER = 'docs/other.md';
const store = () => createDraftStore(docsRoot);
const ctx = () => makeCtx(project.root, { config: { src: 'docs' } });
const read = (rel: string) => fs.readFileSync(path.join(project.root, rel), 'utf8');
const manifestPath = (id: string) => path.join(docsRoot, '.threads', 'reviews', `${id}.json`);
const manifests = () => {
  const dir = path.join(docsRoot, '.threads', 'reviews');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};
const ALICE = { key: 'k-alice', name: 'Alice', email: null, avatarUrl: '', source: 'payload' as const };
const BOB = { key: 'k-bob', name: 'Bob', email: null, avatarUrl: '', source: 'payload' as const };
const fill = (key: string, ops: NewDraftOp[]) =>
  store().transact(key, (j, at) => void j.ops.push(...ops.map((o) => makeOp(o, at))));

before(() => {
  project = tempProject();
  docsRoot = path.join(project.root, 'docs');
});
after(() => project.cleanup());
beforeEach(() => {
  project.reset();
  fs.writeFileSync(path.join(project.root, OTHER), '# Other Page\n\nTarget sentence here.\n');
  fs.rmSync(path.join(docsRoot, '.threads'), { recursive: true, force: true });
});

const journalOps = (): NewDraftOp[] => [
  { kind: 'add-thread', file: FILE, threadId: 't-new', commentId: 'c-new', anchor: quote, body: 'New on index' },
  { kind: 'add-comment', file: FILE, threadId: 't-thread2', commentId: 'c-rep', parentId: 'c2-1', body: 'Reply' },
  { kind: 'add-thread', file: OTHER, threadId: 't-oth', commentId: 'c-oth', anchor: null, body: 'New on other' },
  { kind: 'edit-comment', file: FILE, threadId: 't-thread2', commentId: 'c-gone', body: 'dangling' },
];

test('publish-review writes K files, the manifest and resets the journal (AC-10, AC-11 .. AC-12)', async () => {
  await fill('k-alice', journalOps());
  const before = (await store().load('k-alice')).review.id;
  const result = await actions['threads:publish-review']({ author: 'Alice', authorKey: 'k-alice', title: 'Two pages' }, ctx());

  assert.match(result.reviewId, /^r-[0-9a-f]{8}$/);
  assert.equal(result.reviewId, before);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /c-gone/);

  for (const rel of [FILE, OTHER]) {
    const comments = parser.parseThreadsFromContent(read(rel)).flatMap((t) => t.comments).filter((c) => c.reviewId);
    assert.ok(comments.length > 0, rel);
    assert.ok(comments.every((c) => c.authorKey === 'k-alice' && c.reviewId === result.reviewId), rel);
  }
  assert.match(read(FILE), /==inline discussion threads=={t-new}/);

  const m = JSON.parse(fs.readFileSync(manifestPath(result.reviewId), 'utf8'));
  assert.deepEqual(
    [m.version, m.state, m.authorKey, m.authorName, m.title, m.summary],
    [1, 'published', 'k-alice', 'Alice', 'Two pages', null],
  );
  assert.ok(!Number.isNaN(Date.parse(m.publishedAt)));
  assert.equal(m.ops.length, 3);
  assert.equal(m.ops[0].quote, quote.quote);
  assert.equal(m.ops[2].pageTitle, 'Other Page');
  assert.deepEqual(m.skipped, result.skipped);

  const journal = await store().load('k-alice');
  assert.deepEqual(journal.ops, []);
  assert.notEqual(journal.review.id, result.reviewId);
  const threads = await actions['threads:get-threads']({ file: FILE, author: 'Alice', authorKey: 'k-alice' }, ctx());
  assert.ok(threads.some((t: any) => t.id === 't-new'));
  assert.ok(threads.every((t: any) => !t.draft && t.comments.every((c: any) => !c.draft)));
});

test('publish records the injected clock and a default title; empty-review writes nothing (AC-3, A-7)', async () => {
  await fill('k-bob', [{ kind: 'add-comment', file: FILE, threadId: 't-thread1', commentId: 'c-b', parentId: null, body: 'Hi' }]);
  const sync = createNoGitSync(createLock());
  const deps = { store: store(), sync, now: () => Date.parse('2030-01-02T03:04:05.000Z'), newId: () => 'r-aaaaaaaa' };
  const { reviewId } = await publish(BOB, ctx(), { summary: 'S'.repeat(2500) }, deps);
  const m = JSON.parse(fs.readFileSync(manifestPath(reviewId), 'utf8'));
  assert.equal(m.publishedAt, '2030-01-02T03:04:05.000Z');
  assert.equal(m.title, 'Comments by Bob: 1 comment on docmd _playground');
  assert.equal(m.summary.length, 2000);
  assert.equal((await store().load('k-bob')).review.id, 'r-aaaaaaaa');

  const content = read(FILE);
  await assert.rejects(publish(BOB, ctx(), {}, deps), (e: any) => e instanceof ThreadsError && e.code === 'empty-review' && e.message.startsWith('threads/empty-review'));
  await assert.rejects(actions['threads:publish-review']({ author: 'Nobody', authorKey: 'k-none' }, ctx()), /threads\/empty-review: /);
  assert.equal(read(FILE), content);
  assert.deepEqual(manifests(), [`${reviewId}.json`], 'no manifest for the rejected publishes');
});

test('update-review sets the open review title; list-reviews is newest first with the panel shape (AC-9)', async () => {
  const j = await actions['threads:update-review']({ author: 'Alice', authorKey: 'k-alice', title: 'x' }, ctx());
  assert.equal(j.review.title, 'x');
  assert.equal((await store().load('k-alice')).review.title, 'x');
  await assert.rejects(actions['threads:update-review']({ author: 'Alice', authorKey: 'k-alice', title: 5 }, ctx()), /threads\/invalid/);

  let clock = Date.parse('2026-05-01T00:00:00.000Z');
  const deps = { store: store(), sync: createNoGitSync(createLock()), now: () => clock };
  await fill('k-alice', [{ kind: 'add-thread', file: OTHER, threadId: 't-1', commentId: 'c-1', anchor: { ...quote, quote: 'Target sentence' }, body: 'one' }]);
  const first = await publish(ALICE, ctx(), {}, deps);
  clock = Date.parse('2026-06-01T00:00:00.000Z');
  await fill('k-bob', [{ kind: 'add-comment', file: FILE, threadId: 't-thread1', commentId: 'c-2', parentId: null, body: 'two' }]);
  const second = await publish(BOB, ctx(), { title: 'Bob review' }, deps);

  const list = await actions['threads:list-reviews']({}, ctx());
  assert.deepEqual(list.map((r: any) => r.id), [second.reviewId, first.reviewId]);
  assert.deepEqual(list[0], {
    id: second.reviewId, authorKey: 'k-bob', authorName: 'Bob', title: 'Bob review',
    publishedAt: '2026-06-01T00:00:00.000Z', state: 'published',
    ops: [{ file: FILE, threadId: 't-thread1', quote: null, pageTitle: 'docmd _playground' }],
  });
  assert.deepEqual(list[1].ops, [{ file: OTHER, threadId: 't-1', quote: 'Target sentence', pageTitle: 'Other Page' }]);
});

test('two concurrent publishes run one after the other (C-5)', async () => {
  await fill('k-alice', [{ kind: 'add-comment', file: FILE, threadId: 't-thread1', commentId: 'c-a', parentId: null, body: 'a' }]);
  await fill('k-bob', [{ kind: 'add-comment', file: FILE, threadId: 't-thread1', commentId: 'c-b', parentId: null, body: 'b' }]);
  const log: string[] = [];
  const lock = createLock();
  const sync: Sync = {
    withLock: (fn) => lock.withLock(fn),
    async publishWithRetry(apply, meta) {
      log.push(`start:${meta.authorKey}`);
      await new Promise((r) => setImmediate(r));
      await apply();
      log.push(`end:${meta.authorKey}`);
    },
  };
  const deps = { store: store(), sync };
  await Promise.all([publish(ALICE, ctx(), {}, deps), publish(BOB, ctx(), {}, deps)]);
  assert.deepEqual(log, ['start:k-alice', 'end:k-alice', 'start:k-bob', 'end:k-bob']);
  const ids = parser.parseThreadsFromContent(read(FILE)).flatMap((t) => t.comments.map((c) => c.id));
  assert.ok(ids.includes('c-a') && ids.includes('c-b'), 'the second publish saw the first one\'s write');
});
