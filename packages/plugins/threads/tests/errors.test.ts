import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadsError } from '../src/plugin/errors.ts';

test('message carries the threads/<code>: prefix and code is exposed', () => {
  const e = new ThreadsError('not-found', 'Thread not found: t-1');
  assert.equal(e.message, 'threads/not-found: Thread not found: t-1');
  assert.equal(e.code, 'not-found');
});

test('parse round-trips a message and returns null without the prefix', () => {
  const msg = new ThreadsError('invalid', 'a: b\nc').message;
  assert.deepEqual(ThreadsError.parse(msg), { code: 'invalid', text: 'a: b\nc' });
  assert.deepEqual(ThreadsError.parse('threads/not-found: x'), { code: 'not-found', text: 'x' });
  assert.equal(ThreadsError.parse('Thread not found: t-1'), null);
  assert.equal(ThreadsError.parse('threads/not-found:x'), null);
});
