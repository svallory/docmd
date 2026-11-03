/**
 * --------------------------------------------------------------------
 * docmd : the zero-config documentation engine.
 *
 * `docmd serve` with actions enabled: live-server assets, origin
 * allowlist, caller identity, worker tasks, auto-rebuild with
 * `system:rebuilt`, the rebuild API, and WebSocket shutdown. One
 * long-lived serve spawn; every check shares it.
 *
 * Run: `node tests/runner.js --only=serve-actions`
 * --------------------------------------------------------------------
 */

import { setup, writeFile, runTestFile, DOCMD } from '../shared.js';
import { freePort, canConnect, request, spawnServe, waitForHealthz, exitWithin, copyServePlugin } from '../_lib/serve-harness.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const { WebSocket } = createRequire(DOCMD)('ws');

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    failed++;
    failures.push(message);
    console.log(`    ❌ ${message}`);
  } else {
    passed++;
    console.log(`    ✅ ${message}`);
  }
}

/** Status of a WebSocket upgrade: 'open' or the HTTP status that refused it. */
function upgradeStatus(port, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, origin ? { origin } : {});
    ws.on('unexpected-response', (_req, res) => { res.resume(); resolve(res.statusCode); });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('error'));
  });
}

/** Connected client that records frames and resolves `call`s by id. */
function connect(port, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: `http://127.0.0.1:${port}`, headers });
  const frames = [];
  const waiters = [];
  let nextId = 1;
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise((resolve) => ws.once('close', resolve));
  ws.on('message', (raw) => {
    const text = raw.toString();
    let json = null;
    try { json = JSON.parse(text); } catch { /* bare text frame */ }
    const frame = { text, json };
    frames.push(frame);
    for (const w of [...waiters]) if (w.pred(frame)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(frame); }
  });
  const waitFor = (pred, timeoutMs = 10000) => {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const waiter = {
        pred,
        resolve: (frame) => { clearTimeout(timer); resolve(frame); },
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error('waitFor timed out'));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const call = async (action, payload) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, type: 'call', action, payload }));
    const frame = await waitFor((f) => f.json && f.json.id === id);
    if (frame.json.error) throw new Error(frame.json.error);
    return frame.json.result;
  };
  return { ws, frames, opened, closed, call, waitFor };
}

const isRebuilt = (f) => f.json && f.json.type === 'event' && f.json.name === 'system:rebuilt';
const rebuiltFrames = (client) => client.frames.filter(isRebuilt);

/** Poll a URL until `pred(response)` holds or the deadline passes; null on timeout. */
async function pollPage(port, urlPath, pred, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request(port, urlPath).catch(() => null);
    if (res && pred(res)) return res;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

export const test = runTestFile({
  name: 'Serve actions: live-server build, origin allowlist, identity, rebuild, shutdown',
  emoji: '🛰️',
  run: async () => {
    const dir = setup('serve-actions');
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    writeFile(dir, 'docs/index.md', '# Home\n');
    writeFile(dir, 'docs/other.md', '# Other\n\nfirst version\n');
    copyServePlugin(dir);
    writeFile(dir, 'docmd.config.json', JSON.stringify({
      title: 'Actions',
      src: './docs',
      out: './site',
      plugins: { threads: {}, './plugins/serve-plugin': {} },
      serve: { actions: { enabled: true, origins: [origin] } },
    }, null, 2) + '\n');

    const handle = spawnServe(dir, ['--port', String(port)]);
    let client = null;
    try {
      await waitForHealthz(port, handle);

      // AC-16 / AC-22 (serve half): live-server assets are built and served.
      const home = await request(port, '/');
      const body = home.body.slice(home.body.indexOf('<body'));
      assert(body.includes('assets/js/docmd-api.js'), 'AC-16: HTML references docmd-api.js from <body>');
      assert(home.body.includes('assets/js/threads.js') && home.body.includes('assets/css/threads.css'), 'AC-22: HTML references threads.js and threads.css');
      for (const asset of ['assets/js/docmd-api.js', 'assets/js/threads.js', 'assets/css/threads.css']) {
        assert((await request(port, `/${asset}`)).status === 200, `AC-22: /${asset} is served 200`);
      }

      // Banner.
      assert(/Actions[^\n]*\bon\b/.test(handle.output.text) && handle.output.text.includes(origin), 'Banner shows actions on with the configured origin');

      // AC-17: origin allowlist.
      assert((await upgradeStatus(port, origin)) === 'open', 'AC-17: allowed origin upgrades');
      assert((await upgradeStatus(port, 'http://evil.example')) === 403, 'AC-17: foreign origin gets 403');
      assert((await upgradeStatus(port, null)) === 403, 'AC-17: missing origin gets 403');

      client = connect(port, { 'x-test-identity': 'alice', cookie: 's=1' });
      await client.opened;
      const ping = await client.call('system:ping');
      assert(ping && ping.ok === true, 'AC-17: system:ping returns ok');

      // AC-19: caller identity, no cookies.
      const who = await client.call('test:whoami');
      assert(who.identity === 'alice' && who.mode === 'serve' && who.origin === origin, 'AC-19: identity header, mode serve and origin reach the action');
      const dump = await client.call('test:whoami', { dump: true });
      assert(dump.headers['x-test-identity'] === 'alice' && !('cookie' in dump.headers) && !('set-cookie' in dump.headers), 'AC-19: no cookie/set-cookie in ctx.caller.headers');

      // AC-20: worker tasks.
      const worker = await client.call('test:worker', { n: 7 }).catch((e) => `error: ${e.message}`);
      assert(worker === 49, `AC-20: test:worker returns the worker task result (got ${JSON.stringify(worker)})`);

      // AC-24: ctx.writeFile -> auto-rebuild -> system:rebuilt, page updated, no reload frame.
      await client.call('test:write', { file: 'docs/other.md', content: '# Other\n\nsecond version\n' });
      const rebuilt = await client.waitFor(isRebuilt).catch(() => null);
      assert(rebuilt !== null && rebuilt.json.data.files.includes('docs/other.md'), 'AC-24: system:rebuilt lists docs/other.md (project-relative)');
      const page2 = await pollPage(port, '/other/', (r) => r.status === 200 && r.body.includes('second version'));
      assert(page2 !== null, 'AC-24: the written page reflects the new content within 10 s');

      // AC-25: handle.rebuild after an out-of-band edit.
      fs.writeFileSync(path.join(dir, 'docs/other.md'), '# Other\n\nthird version\n');
      const handleResult = await client.call('test:handle-rebuild', { files: ['docs/other.md'] });
      assert(handleResult.mode === 'serve', 'AC-25: handle.mode is "serve"');
      assert(await pollPage(port, '/other/', (r) => r.body.includes('third version')) !== null, 'AC-25: handle.rebuild publishes the edit within 10 s');

      // AC-26: ten overlapping requestRebuild calls coalesce.
      fs.writeFileSync(path.join(dir, 'docs/other.md'), '# Other\n\nfourth version\n');
      const before = rebuiltFrames(client).length;
      await Promise.all(Array.from({ length: 10 }, () => client.call('test:rebuild', { files: ['docs/other.md'] })));
      const during = rebuiltFrames(client).length - before;
      assert(during >= 1 && during <= 2, `AC-26: ten overlapping rebuilds resolve with at most 2 system:rebuilt (got ${during})`);
      const final = await pollPage(port, '/other/', (r) => r.body.includes('fourth version'));
      assert(final !== null && final.status === 200, 'AC-26: the served page is consistent with the latest content');

      assert(!client.frames.some((f) => f.text === 'reload'), 'AC-24: no reload frame was received');

      // AC-7 (WS half): SIGTERM closes the socket, exits 0, refuses connections.
      const closedInTime = Promise.race([client.closed.then(() => true), new Promise((res) => setTimeout(() => res(false), 5000))]);
      handle.child.kill('SIGTERM');
      const r = await exitWithin(handle, 5000);
      assert(await closedInTime, 'AC-7: the open WebSocket observed close');
      assert(r.code === 0 && !r.timedOut, 'AC-7: SIGTERM exits 0 within 5 s');
      assert(!(await canConnect('127.0.0.1', port)), 'AC-7: a new connect is refused');
    } finally {
      if (handle.child.exitCode === null) { handle.child.kill('SIGKILL'); await handle.exited; }
    }
  }
});

export const results = {
  get passed() { return passed; },
  get failed() { return failed; },
  get failures() { return [...failures]; }
};
