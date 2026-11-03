import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLock } from '../src/plugin/lock.ts';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

test('withLock runs callbacks strictly in order, even when the first is slow (C-5)', async () => {
  const lock = createLock();
  const log: string[] = [];
  const gate = deferred();
  const first = lock.withLock(async () => {
    log.push('start1');
    await gate.promise;
    log.push('end1');
  });
  const second = lock.withLock(async () => {
    log.push('start2');
    log.push('end2');
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['start1'], 'the second callback waits while the first is pending');
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(log, ['start1', 'end1', 'start2', 'end2']);
});

test('a failing callback rejects its own caller and does not block the queue', async () => {
  const lock = createLock();
  const failed = lock.withLock(async () => {
    throw new Error('boom');
  });
  const next = lock.withLock(async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
});
