import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenLive } from '../src/client/lib/when-live.ts';

test('whenLive: already live fires immediately, once', () => {
  let n = 0;
  whenLive(() => true, () => n++);
  assert.equal(n, 1);
});

test('whenLive: fires once when live arrives later, and stops polling', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let live = false;
  let n = 0;
  whenLive(() => live, () => n++, { intervalMs: 100, maxMs: 5000 });
  t.mock.timers.tick(300);
  assert.equal(n, 0);
  live = true;
  t.mock.timers.tick(100);
  assert.equal(n, 1);
  // a reconnect flapping the socket must not mount again
  live = false; t.mock.timers.tick(1000); live = true; t.mock.timers.tick(1000);
  assert.equal(n, 1);
});

test('whenLive: never fires when not live, and gives up after maxMs', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let n = 0;
  let calls = 0;
  whenLive(() => { calls++; return false; }, () => n++, { intervalMs: 100, maxMs: 1000 });
  t.mock.timers.tick(1000);
  const after = calls;
  t.mock.timers.tick(5000);
  assert.equal(n, 0);
  assert.equal(calls, after, 'polling stopped');
});

test('whenLive: cancel stops a pending wait', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let live = false;
  let n = 0;
  const cancel = whenLive(() => live, () => n++, { intervalMs: 100 });
  cancel();
  live = true;
  t.mock.timers.tick(1000);
  assert.equal(n, 0);
});
