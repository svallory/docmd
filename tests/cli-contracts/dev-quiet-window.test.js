/**
 * --------------------------------------------------------------------
 * docmd : the zero-config documentation engine.
 *
 * Dev content-watcher pipeline (the production module `dev` runs): a save
 * inside the post-rebuild quiet window is rebuilt once the window passes;
 * the rebuild's own events do not loop; saves batch into one build; a failed
 * build is retried; cancel drops everything. Injected clock, timers and
 * build, real signature tracker on real files. No sleeps.
 *
 * Run: `node tests/runner.js --only=dev-quiet-window`
 * --------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { setImmediate } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { setup, runTestFile } from '../shared.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const { createWatchPipeline } = await import(pathToFileURL(path.join(ROOT, 'packages/core/dist/commands/dev-quiet-window.js')).href);
const { FileSignatureTracker } = await import(pathToFileURL(path.join(ROOT, 'packages/utils/dist/index.js')).href);

let passed = 0;
let failed = 0;
const failures = [];
function assert(condition, message) {
  if (!condition) { failed++; failures.push(message); console.log(`    ❌ ${message}`); }
  else { passed++; console.log(`    ✅ ${message}`); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const QUIET = 1000;
const DEBOUNCE = 600;
const settle = () => new Promise((r) => setImmediate(r));

function harness({ failBuilds = 0 } = {}) {
  let clock = 10_000;
  let nextId = 1;
  const timers = new Map();
  const tracker = new FileSignatureTracker();
  const builds = [];
  const built = [];
  const configs = [];
  let toFail = failBuilds;
  const pipe = createWatchPipeline({
    quietMs: QUIET,
    debounceMs: DEBOUNCE,
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { at: clock + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    signatureChanged: (f) => tracker.hasChanged(f),
    isBlocked: () => false,
    build: async (targets) => {
      builds.push(targets);
      if (toFail > 0) { toFail--; throw new Error('boom'); }
    },
    onBuilt: (info) => built.push(info),
    onConfig: (f) => configs.push(f)
  });
  const advance = async (ms) => {
    const target = clock + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      timers.delete(next[0]);
      clock = Math.max(clock, next[1].at);
      next[1].fn();
      await settle();
    }
    clock = target;
    await settle();
  };
  const content = (f, rpcWritten = false) => pipe.event(f, { kind: 'content', rpcWritten });
  return { pipe, advance, content, builds, built, configs, timers };
}

let seq = 0;
// A different size each call, so the mtime+size signature always differs.
const save = (file) => fs.writeFileSync(file, `# page\n${'x'.repeat(++seq * 7)}\n`);

// A page that was built just now: its first edit is rebuilt and the window is open.
async function builtOnce(dir, name = 'page.md') {
  const h = harness();
  const file = path.join(dir, name);
  save(file);
  h.content(file);
  await h.advance(DEBOUNCE);
  return { h, file };
}

export const test = runTestFile({
  name: 'Dev content-watcher pipeline: quiet window',
  emoji: '⏱️',
  run: async () => {
    const dir = setup('dev-quiet-window');

    { // AC1
      const { h, file } = await builtOnce(dir);
      assert(h.builds.length === 1, 'setup: first edit builds after the debounce');
      await h.advance(300);
      save(file);
      h.content(file);
      await h.advance(QUIET);
      assert(h.builds.length === 1, 'an edit inside the window is not built while the window is open');
      await h.advance(DEBOUNCE);
      assert(h.builds.length === 2 && same(h.builds[1], [file]), 'an edit saved inside the window is rebuilt once it passes');
    }

    { // AC2
      const { h, file } = await builtOnce(dir);
      await h.advance(100); h.content(file);
      await h.advance(200); h.content(file); h.content(file);
      await h.advance(5 * QUIET);
      assert(h.builds.length === 1, 'the rebuild\'s own events (file unchanged) are deferred, gated and do not rebuild');
    }

    { // batching
      const { h } = await builtOnce(dir);
      const a = path.join(dir, 'a.md');
      const b = path.join(dir, 'b.md');
      save(a); save(b);
      await h.advance(200);
      h.content(a); h.content(b);
      await h.advance(QUIET + DEBOUNCE);
      assert(h.builds.length === 2 && same(h.builds[1], [a, b]), 'files saved inside the window build together in one pass');
    }

    { // failed build
      const h = harness({ failBuilds: 1 });
      const a = path.join(dir, 'fa.md');
      const b = path.join(dir, 'fb.md');
      save(a);
      h.content(a);
      await h.advance(DEBOUNCE);
      assert(h.builds.length === 1 && h.built.length === 0, 'setup: the build fails');
      save(b);
      h.content(b);
      await h.advance(DEBOUNCE);
      assert(h.builds.length === 2 && same(h.builds[1], [a, b]), 'a failed build\'s files are rebuilt with the next edit');
    }

    { // cancel
      const { h, file } = await builtOnce(dir);
      await h.advance(100);
      save(file);
      h.content(file);
      h.pipe.cancel();
      await h.advance(10 * QUIET);
      assert(h.builds.length === 1 && h.timers.size === 0, 'cancel drops deferred events and leaves no timers');
    }

    { // bounded deferral
      const { h, file } = await builtOnce(dir);
      await h.advance(100);
      save(file);
      h.content(file); // deferred until the window ends (900 ms from now)
      for (let i = 0; i < 4; i++) { await h.advance(400); h.pipe.markRebuilt(); } // plugin builds keep finishing
      await h.advance(DEBOUNCE);
      assert(h.builds.length === 2 && same(h.builds[1], [file]), 'builds that keep finishing do not postpone a deferred save indefinitely');
    }

    { // rpc marks
      const { h } = await builtOnce(dir);
      const a = path.join(dir, 'ra.md');
      const b = path.join(dir, 'rb.md');
      save(a); save(b);
      h.content(a, true);
      await h.advance(QUIET + DEBOUNCE);
      assert(h.built[1].reload === false, 'a build of RPC-written files does not request a reload');
      await h.advance(QUIET);
      h.content(a, true); h.content(b, false);
      save(a); save(b);
      h.content(a, true); h.content(b, false);
      await h.advance(DEBOUNCE);
      assert(h.built[2].reload === true, 'a build with any non-RPC file requests a reload');
    }

    { // config
      const h = harness();
      const f = path.join(dir, 'navigation.json');
      save(f);
      h.pipe.event(f, { kind: 'config', rpcWritten: false });
      assert(same(h.configs, [f]) && h.builds.length === 0, 'a changed config file is routed to the config handler, not built');
    }
  }
});

export const results = {
  get passed() { return passed; },
  get failed() { return failed; },
  get failures() { return [...failures]; }
};
