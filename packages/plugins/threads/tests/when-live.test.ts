import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whenLive } from '../src/client/lib/when-live.ts';
import { createPublishMount } from '../src/client/lib/publish-mount.ts';

const TICK = 250;
const MAX = 30_000;

test('whenLive: already live fires immediately, once', () => {
  let n = 0;
  whenLive(() => true, () => n++);
  assert.equal(n, 1);
});

test('whenLive: fires once when live arrives later, and stops polling', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let live = false;
  let n = 0;
  let calls = 0;
  whenLive(() => { calls++; return live; }, () => n++);
  t.mock.timers.tick(TICK * 3);
  assert.equal(n, 0);
  live = true;
  t.mock.timers.tick(TICK);
  assert.equal(n, 1);
  const after = calls;
  t.mock.timers.tick(TICK * 20);
  assert.equal(n, 1);
  assert.equal(calls, after, 'polling stopped');
});

test('whenLive: never live gives up after the bound and reports it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let n = 0;
  let gaveUp = 0;
  let calls = 0;
  whenLive(() => { calls++; return false; }, () => n++, () => gaveUp++);
  t.mock.timers.tick(MAX);
  const after = calls;
  t.mock.timers.tick(MAX);
  assert.equal(n, 0);
  assert.equal(gaveUp, 1);
  assert.equal(calls, after, 'polling stopped');
});

test('whenLive: cancel stops a pending wait', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let live = false;
  let n = 0;
  const cancel = whenLive(() => live, () => n++);
  cancel();
  live = true;
  t.mock.timers.tick(TICK * 4);
  assert.equal(n, 0);
});

// The app's mount decisions, with a fake socket probe and a fake document.
function harness() {
  const s = { live: false, connected: true, created: 0, removed: 0 };
  const mount = createPublishMount<{ id: number }>({
    isLive: () => s.live,
    isConnected: () => s.connected,
    create: () => ({ id: ++s.created }),
    remove: () => { s.removed++; },
  });
  return { s, mount };
}

test('publish mount: mounts once when live flips, not again across a reconnect or a repeat start()', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { s, mount } = harness();
  mount.start();
  assert.equal(mount.widget, null);
  assert.equal(mount.waiting, true);
  s.live = true;
  t.mock.timers.tick(TICK);
  assert.equal(s.created, 1);
  assert.equal(mount.waiting, false);
  s.live = false; t.mock.timers.tick(TICK * 4); s.live = true; t.mock.timers.tick(TICK * 4);
  mount.start();
  assert.equal(s.created, 1);
});

test('publish mount: already live mounts at once and leaves nothing pending', () => {
  const { s, mount } = harness();
  s.live = true;
  mount.start();
  assert.equal(s.created, 1);
  assert.equal(mount.waiting, false);
});

test('publish mount: never mounts when not live, and can start again after giving up', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { s, mount } = harness();
  mount.start();
  t.mock.timers.tick(MAX);
  assert.equal(s.created, 0);
  assert.equal(mount.waiting, false, 'give-up clears the pending handle');
  s.live = true;
  mount.start();
  assert.equal(s.created, 1);
});

test('publish mount: no probe (static build) never mounts', () => {
  const mount = createPublishMount({ isLive: undefined, isConnected: () => true, create: () => ({}), remove: () => {} });
  mount.start();
  assert.equal(mount.widget, null);
  assert.equal(mount.waiting, false);
});

test('publish mount: stop() before live cancels the wait', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { s, mount } = harness();
  mount.start();
  mount.stop();
  s.live = true;
  t.mock.timers.tick(TICK * 4);
  assert.equal(s.created, 0);
});

test('publish mount: an element detached at the moment of going live mounts nothing', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { s, mount } = harness();
  mount.start();
  s.connected = false;
  s.live = true;
  t.mock.timers.tick(TICK);
  assert.equal(s.created, 0);
});

test('publish mount: stop() removes a mounted widget', () => {
  const { s, mount } = harness();
  s.live = true;
  mount.start();
  mount.stop();
  assert.equal(s.removed, 1);
  assert.equal(mount.widget, null);
});

test('publish mount: a second start() while waiting does not add a second poller', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const mount = createPublishMount({ isLive: () => { calls++; return false; }, isConnected: () => true, create: () => ({}), remove: () => {} });
  mount.start();
  mount.start();
  const before = calls;
  t.mock.timers.tick(TICK);
  assert.equal(calls - before, 1);
});
