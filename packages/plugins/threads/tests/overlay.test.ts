import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overlay } from '../src/plugin/overlay.ts';
import type { Thread, DraftOp } from '../src/types.ts';

const who = { key: 'k-me', name: 'Me' };
const F = 'docs/a.md';
const at = '2026-04-01T10:00:00.000Z';
const published = (): Thread[] => [{
  id: 't-pub', resolved: false, resolved_by: null, resolved_at: null,
  comments: [
    { id: 'c-1', thread_id: 't-pub', parent_id: null, author: 'Ann', date: '2026-01-01', edited_at: null, body: 'one', reactions: [] },
    { id: 'c-2', thread_id: 't-pub', parent_id: null, author: 'Bo', date: '2026-01-02', edited_at: null, body: 'two',
      reactions: [{ emoji: '👍', authors: ['Ann'] }] },
  ],
}];
const base = { opId: 'o', at, file: F };

const table: Array<[string, DraftOp[], (t: Thread[]) => void]> = [
  ['add-thread', [{ ...base, kind: 'add-thread', threadId: 't-new', commentId: 'c-new', anchor: { quote: 'q', prefix: null, suffix: null, selector: null, offset: null, blockText: null }, body: 'hello' }], (t) => {
    assert.equal(t.length, 2);
    assert.equal(t[0].draft, undefined);
    assert.equal(t[1].draft, true);
    assert.deepEqual(t[1].anchor, { quote: 'q' });
    assert.deepEqual([t[1].comments[0].draft, t[1].comments[0].author, t[1].comments[0].date, t[1].comments[0].authorKey], [true, 'Me', '2026-04-01', 'k-me']);
  }],
  ['add-comment', [{ ...base, kind: 'add-comment', threadId: 't-pub', commentId: 'c-3', parentId: 'c-1', body: 'reply' }], (t) => {
    assert.equal(t[0].draft, undefined);
    assert.deepEqual(t[0].comments.map((c) => c.draft), [undefined, undefined, true]);
    assert.equal(t[0].comments[2].parent_id, 'c-1');
  }],
  ['edit-comment', [{ ...base, kind: 'edit-comment', threadId: 't-pub', commentId: 'c-1', body: 'edited' }], (t) => {
    assert.deepEqual([t[0].comments[0].body, t[0].comments[0].edited_at], ['edited', '2026-04-01']);
  }],
  ['delete-comment', [{ ...base, kind: 'delete-comment', threadId: 't-pub', commentId: 'c-1' }], (t) => {
    assert.deepEqual(t[0].comments.map((c) => c.id), ['c-2']);
  }],
  ['delete-thread', [{ ...base, kind: 'delete-thread', threadId: 't-pub' }], (t) => assert.deepEqual(t, [])],
  ['resolve-thread toggles', [{ ...base, kind: 'resolve-thread', threadId: 't-pub' }], (t) => {
    assert.deepEqual([t[0].resolved, t[0].resolved_by, t[0].resolved_at], [true, 'Me', '2026-04-01']);
  }],
  ['resolve-thread twice unresolves', [{ ...base, kind: 'resolve-thread', threadId: 't-pub' }, { ...base, opId: 'o2', kind: 'resolve-thread', threadId: 't-pub' }], (t) => {
    assert.deepEqual([t[0].resolved, t[0].resolved_by, t[0].resolved_at], [false, null, null]);
  }],
  ['toggle-reaction joins an existing reaction', [{ ...base, kind: 'toggle-reaction', threadId: 't-pub', commentId: 'c-2', emoji: '👍' }], (t) => {
    assert.deepEqual(t[0].comments[1].reactions, [{ emoji: '👍', authors: ['Ann', 'Me'] }]);
  }],
  ['toggle-reaction new, then off removes the reaction', [
    { ...base, kind: 'toggle-reaction', threadId: 't-pub', commentId: 'c-1', emoji: '🎉' },
    { ...base, opId: 'o2', kind: 'toggle-reaction', threadId: 't-pub', commentId: 'c-1', emoji: '🎉' },
  ], (t) => assert.deepEqual(t[0].comments[0].reactions, [])],
  ['ops of another file are ignored', [{ ...base, file: 'docs/b.md', kind: 'delete-thread', threadId: 't-pub' }], (t) => assert.deepEqual(t, published())],
  ['ops on missing targets are ignored', [
    { ...base, kind: 'add-comment', threadId: 't-gone', commentId: 'c-x', parentId: null, body: 'x' },
    { ...base, opId: 'o2', kind: 'edit-comment', threadId: 't-pub', commentId: 'c-gone', body: 'x' },
  ], (t) => assert.deepEqual(t, published())],
  ['ops apply in order: a drafted comment can be reacted to', [
    { ...base, kind: 'add-comment', threadId: 't-pub', commentId: 'c-3', parentId: null, body: 'r' },
    { ...base, opId: 'o2', kind: 'toggle-reaction', threadId: 't-pub', commentId: 'c-3', emoji: '❤️' },
  ], (t) => assert.deepEqual(t[0].comments[2].reactions, [{ emoji: '❤️', authors: ['Me'] }])],
];

for (const [name, ops, check] of table) {
  test(`overlay: ${name}`, () => {
    const input = published();
    check(overlay(input, ops, F, who));
    assert.deepEqual(input, published(), 'input is not mutated');
  });
}
