import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject, makeCtx, type TempProject } from './helpers.ts';
import { actions } from '../src/plugin/actions.ts';
import { countOrphanedBy, markOrphans } from '../src/plugin/orphans.ts';
import type { Thread } from '../src/types.ts';

const thread = (id: string, quote?: string, by = 'k-alice'): Thread => ({
  id, resolved: false, resolved_by: null, resolved_at: null,
  comments: [{ id: `c-${id}`, thread_id: id, parent_id: null, author: 'A', date: '2026-03-01', edited_at: null, authorKey: by, body: 'hi', reactions: [] }],
  ...(quote ? { anchor: { quote } } : {}),
});

const block = (ids: string[]) => `\n::: threads\n${ids.map((i) => `  ::: thread ${i}\n    ::: comment c-${i} "A" "2026-03-01" by k-alice\n      hi\n    :::\n  :::\n`).join('')}:::\n`;

// ---------------------------------------------------------------------------
// markOrphans: pure
// ---------------------------------------------------------------------------

const cases: Array<[string, string, Thread, boolean]> = [
  ['mark present', 'Some ==quoted text=={t-1} here.\n' + block(['t-1']), thread('t-1', 'quoted text'), false],
  ['mark absent', 'Some plain text here.\n' + block(['t-1']), thread('t-1', 'quoted text'), true],
  ['mark of another thread only', 'Some ==quoted text=={t-2} here.\n' + block(['t-1']), thread('t-1', 'quoted text'), true],
  ['id appears only inside the threads block', 'Plain.\n' + block(['t-1']).replace('hi', 'see ==x=={t-1}'), thread('t-1', 'quoted text'), true],
  ['no anchor (legacy / general)', 'Plain.\n' + block(['t-1']), thread('t-1'), false],
  ['no threads block at all', 'Plain.\n', thread('t-1', 'quoted text'), true],
  ['id with regex characters', 'A ==q=={t.1} b\n' + block(['t.1']), thread('t.1', 'q'), false],
];
for (const [name, content, t, orphaned] of cases) {
  test(`markOrphans: ${name}`, () => {
    const [out] = markOrphans(content, [t]);
    assert.equal(out.orphaned, orphaned ? true : undefined);
    assert.equal('orphaned' in out, orphaned);
    assert.equal(out.anchor?.quote, t.anchor?.quote);
  });
}

test('markOrphans does not mutate its input', () => {
  const t = thread('t-1', 'q');
  markOrphans('Plain.\n', [t]);
  assert.equal('orphaned' in t, false);
});

// ---------------------------------------------------------------------------
// countOrphanedBy: in-memory file map
// ---------------------------------------------------------------------------

const ROOT = '/docs';
const orphan = (id: string, by: string) => `Plain.\n::: threads\n  ::: thread ${id}\n    ::: anchor\n      gone text\n    :::\n    ::: comment c-${id} "A" "2026-03-01" by ${by}\n      hi\n    :::\n  :::\n:::\n`;
const FILES: Record<string, string> = {
  '/docs/a.md': orphan('t-a1', 'k-alice'),
  '/docs/bob.md': orphan('t-a2', 'k-bob'),
  '/docs/sub/b.md': orphan('t-b', 'k-alice'),
  '/docs/.threads/x.md': orphan('t-x', 'k-alice'),
  '/docs/node_modules/pkg/y.md': orphan('t-y', 'k-alice'),
  '/docs/plain.md': 'No threads here.\n',
  '/docs/marked.md': 'Has ==gone text=={t-m} still.\n' + orphan('t-m', 'k-alice').replace('Plain.\n', ''),
};
const deps = {
  readFile: async (f: string) => FILES[f],
  listMarkdown: async () => Object.keys(FILES),
};

test('countOrphanedBy counts across files by first-comment key and skips .threads and node_modules', async () => {
  assert.equal(await countOrphanedBy(ROOT, 'k-alice', deps), 2);
  assert.equal(await countOrphanedBy(ROOT, 'k-bob', deps), 1);
});

test('countOrphanedBy is 0 for a caller with no threads', async () => {
  assert.equal(await countOrphanedBy(ROOT, 'k-nobody', deps), 0);
});

test('countOrphanedBy counts by the first comment, not a later reply', async () => {
  const files: Record<string, string> = {
    '/docs/r.md': orphan('t-r', 'k-bob').replace('  :::\n:::\n', '    ::: comment c-2 "A" "2026-03-02" reply-to c-t-r by k-alice\n      re\n    :::\n  :::\n:::\n'),
  };
  const d = { readFile: async (f: string) => files[f], listMarkdown: async () => Object.keys(files) };
  assert.equal(await countOrphanedBy(ROOT, 'k-alice', d), 0);
  assert.equal(await countOrphanedBy(ROOT, 'k-bob', d), 1);
});

// ---------------------------------------------------------------------------
// get-threads / whoami wiring: one temp project
// ---------------------------------------------------------------------------

let project: TempProject;
before(() => { project = tempProject(); });
after(() => project.cleanup());

const ALICE = { author: 'Alice', authorKey: 'k-alice' };
const BOB = { author: 'Bob', authorKey: 'k-bob' };
const call = (name: string, payload: Record<string, unknown>) =>
  (actions as Record<string, any>)[name](payload, makeCtx(project.root, { config: { src: 'docs' } }));

test('get-threads flags a published thread once its quote is edited out; whoami counts it for the starter only; drafts stay overlaid', async () => {
  const file = project.file;
  const abs = path.join(project.root, file);
  const quote = 'Developer Checklist';
  assert.ok(fs.readFileSync(abs, 'utf8').includes(quote));

  const added = await call('threads:add-thread', { file, ...ALICE, body: 'Orphan me', anchor: { quote, prefix: null, suffix: null, selector: null, offset: null, blockText: null } });
  await call('threads:publish-review', { ...ALICE });
  assert.match(fs.readFileSync(abs, 'utf8'), new RegExp(`==${quote}==\\{${added.id}\\}`));

  const before = (await call('threads:get-threads', { file, ...ALICE })).find((t: Thread) => t.id === added.id);
  assert.equal(before.orphaned, undefined);
  assert.equal((await call('threads:whoami', ALICE)).orphanedMine, 0);

  fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace(`==${quote}=={${added.id}}`, 'something else'));
  await call('threads:add-comment', { file, ...ALICE, threadId: added.id, body: 'Draft reply' });

  const threads: Thread[] = await call('threads:get-threads', { file, ...ALICE });
  const t = threads.find((x) => x.id === added.id)!;
  assert.equal(t.orphaned, true);
  assert.equal(t.anchor?.quote, quote);
  assert.ok(t.comments.some((c) => c.draft && c.body === 'Draft reply'), 'drafts overlaid');

  assert.equal((await call('threads:whoami', ALICE)).orphanedMine, 1);
  assert.equal((await call('threads:whoami', BOB)).orphanedMine, 0);
});
