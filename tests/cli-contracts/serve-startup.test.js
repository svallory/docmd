/**
 * --------------------------------------------------------------------
 * docmd : the zero-config documentation engine.
 *
 * `docmd serve` startup failures: every one exits 1 (port in use,
 * invalid config, actions without origins, workspace root) and SIGINT
 * shuts a running server down cleanly. One short-lived spawn each.
 *
 * Run: `node tests/runner.js --only=serve-startup`
 * --------------------------------------------------------------------
 */

import { setup, writeFile, runTestFile } from '../shared.js';
import { freePort, canConnect, spawnServe, waitForHealthz, exitWithin } from '../_lib/serve-harness.js';
import net from 'node:net';

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

function project(name, config) {
  const dir = setup(name);
  writeFile(dir, 'docs/index.md', '# Hi\n');
  writeFile(dir, 'docmd.config.json', typeof config === 'string' ? config : JSON.stringify({ title: 'T', src: './docs', out: './site', ...config }, null, 2) + '\n');
  return dir;
}

async function expectExit1(dir, args) {
  const handle = spawnServe(dir, args);
  try {
    const r = await exitWithin(handle, 15000);
    return { ...r, text: handle.output.text };
  } finally {
    if (handle.child.exitCode === null) { handle.child.kill('SIGKILL'); await handle.exited; }
  }
}

export const test = runTestFile({
  name: 'Serve startup failures exit 1 (AC-3, AC-8, AC-18, A-6) and SIGINT stops cleanly (AC-7)',
  emoji: '🚧',
  run: async () => {
    // AC-3: port already bound -> exit 1, names the port, no fallback to port + 1.
    {
      const dir = project('serve-startup-port', {});
      const blocker = net.createServer();
      await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
      const { port } = blocker.address();
      try {
        const started = Date.now();
        const r = await expectExit1(dir, ['--port', String(port)]);
        assert(r.code === 1 && Date.now() - started <= 5000 + 5000, 'AC-3: port in use exits 1');
        assert(r.text.includes(String(port)), 'AC-3: output names the port');
        assert(!(await canConnect('127.0.0.1', port + 1)), 'AC-3: nothing listens on port + 1');
      } finally {
        await new Promise((r) => blocker.close(r));
      }
    }

    // AC-8: invalid config -> exit 1, nothing listening.
    {
      const dir = project('serve-startup-badconfig', '{ "title": "x", ');
      const port = await freePort();
      const r = await expectExit1(dir, ['--port', String(port)]);
      assert(r.code === 1, 'AC-8: syntactically invalid config exits 1');
      assert(!(await canConnect('127.0.0.1', port)), 'AC-8: nothing listens on the chosen port');
    }

    // AC-18: actions enabled without origins.
    {
      const dir = project('serve-startup-noorigins', { serve: { actions: { enabled: true } } });
      const r = await expectExit1(dir, ['--port', String(await freePort())]);
      assert(r.code === 1 && r.text.includes('serve.actions.origins'), 'AC-18: actions without origins exits 1 naming serve.actions.origins');
    }

    // A-6: workspace root.
    {
      const dir = project('serve-startup-workspace', {
        workspace: { projects: [{ prefix: '/', src: './docs' }] }
      });
      const r = await expectExit1(dir, ['--port', String(await freePort())]);
      assert(r.code === 1 && r.text.includes('docmd serve does not support workspaces yet'), 'A-6: workspace root exits 1 with the message');
    }

    // AC-7: SIGINT -> exit 0, port closed.
    {
      const dir = project('serve-startup-sigint', {});
      const port = await freePort();
      const handle = spawnServe(dir, ['--port', String(port)]);
      try {
        await waitForHealthz(port, handle);
        handle.child.kill('SIGINT');
        const r = await exitWithin(handle, 5000);
        assert(r.code === 0 && !r.timedOut, 'AC-7: SIGINT exits 0 within 5 s');
        assert(!(await canConnect('127.0.0.1', port)), 'AC-7: the port refuses connections after SIGINT');
      } finally {
        if (handle.child.exitCode === null) { handle.child.kill('SIGKILL'); await handle.exited; }
      }
    }
  }
});

export const results = {
  get passed() { return passed; },
  get failed() { return failed; },
  get failures() { return [...failures]; }
};
