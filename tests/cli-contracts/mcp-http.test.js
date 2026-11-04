/**
 * --------------------------------------------------------------------
 * docmd : the zero-config documentation engine.
 *
 * MCP over HTTP: stateless JSON on POST /mcp, Origin validated only when
 * present, wired into `docmd serve` behind `serve.mcp.enabled`.
 *
 * Run: `node tests/runner.js --only=mcp-http`
 * --------------------------------------------------------------------
 */

import http from 'node:http';
import { setup, writeFile, runTestFile } from '../shared.js';
import { freePort, request, spawnServe, waitForHealthz, stopServe } from '../_lib/serve-harness.js';
import { createMcpHandler } from '../../packages/core/dist/mcp/handler.js';
import { mcpConfigConflict } from '../../packages/core/dist/commands/serve.js';
import { createMcpHttpHandler } from '../../packages/core/dist/mcp/http.js';

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

/** POST `body` (string or object) to /mcp; resolves { status, headers, body, json }. */
function post(port, body, headers = {}, method = 'POST') {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json;
        try { json = JSON.parse(text); } catch { /* empty or non-JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const readDoc = (id, route) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'read_doc', arguments: { route } } });

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

export const test = runTestFile({
  name: 'MCP over HTTP: stateless JSON on POST /mcp (AC-28, AC-29)',
  emoji: '🌐',
  run: async () => {
    const dir = setup('mcp-http');
    writeFile(dir, 'docmd.config.json', JSON.stringify({ title: 'T', out: 'build', url: 'https://example.test' }));
    writeFile(dir, '.env', 'SECRET=1\n');
    writeFile(dir, 'docs/intro.md', '# Intro content\n');

    const allowedOrigin = 'http://127.0.0.1:9';
    const handler = createMcpHandler({ cwd: dir });
    const open = http.createServer(createMcpHttpHandler({ handler, origins: [allowedOrigin] }));
    const closed = http.createServer(createMcpHttpHandler({ handler, origins: [] }));
    const [openPort, closedPort] = await Promise.all([listen(open), listen(closed)]);

    try {
      // Protocol behaviour.
      const i = await post(openPort, init);
      assert(i.status === 200 && /^application\/json/.test(i.headers['content-type']) && i.json?.result?.serverInfo?.name === 'docmd-mcp-server',
        'initialize: 200 JSON with serverInfo.name docmd-mcp-server (also AC-29: no Origin is 200 on an allow-listed server)');
      assert(i.headers['mcp-session-id'] === undefined, 'initialize: no Mcp-Session-Id header is issued');

      const l = await post(openPort, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert(JSON.stringify(l.json?.result?.tools?.map((t) => t.name)) === JSON.stringify(handler.toolNames()), 'tools/list: names equal handler.toolNames()');

      const env = await post(openPort, readDoc(3, '.env'));
      const envText = env.json?.result?.content?.[0]?.text || '';
      assert(/outside the documentation source directory/.test(envText) && !envText.includes('SECRET'), 'read_doc ".env" over HTTP returns an error, not contents');
      const intro = await post(openPort, readDoc(4, 'docs/intro.md'));
      assert((intro.json?.result?.content?.[0]?.text || '').includes('# Intro content'), 'read_doc "docs/intro.md" over HTTP returns the file');

      const n = await post(openPort, initialized);
      assert(n.status === 202 && n.body === '', 'notification: 202 with empty body');
      const b = await post(openPort, [init, initialized]);
      assert(b.status === 200 && Array.isArray(b.json) && b.json.length === 1 && b.json[0].result?.serverInfo?.name === 'docmd-mcp-server',
        'batch [initialize, notification]: 200 with a one-element array');

      for (const method of ['GET', 'DELETE']) {
        const r = await post(openPort, undefined, {}, method);
        assert(r.status === 405 && r.headers.allow === 'POST', `${method} /mcp: 405 with Allow: POST`);
      }

      const bad = await post(openPort, '{not json');
      assert(bad.status === 400 && bad.json?.error?.code === -32700, 'invalid JSON: 400 with JSON-RPC parse error -32700');
      const big = await post(openPort, JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping', params: { pad: 'x'.repeat(1024 * 1024 + 1) } }));
      assert(big.status === 413, 'body over 1 MiB: 413');

      // Announced length over the limit: 413 before the body arrives (the request is left open).
      const early = await new Promise((resolve) => {
        const timer = setTimeout(() => { req.destroy(); resolve('hung'); }, 2000);
        const req = http.request({ host: '127.0.0.1', port: openPort, path: '/mcp', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2097152 } }, (res) => {
          clearTimeout(timer);
          res.resume();
          resolve(res.statusCode);
          req.destroy();
        });
        req.on('error', () => {});
        req.write('{"jsonrpc"');
      });
      assert(early === 413, 'Content-Length over 1 MiB: 413 without waiting for the body');

      const sess = await post(openPort, init, { 'Mcp-Session-Id': 'abc', 'MCP-Protocol-Version': '1999-01-01' });
      assert(sess.status === 200 && sess.json?.result?.serverInfo?.name === 'docmd-mcp-server', 'Mcp-Session-Id and MCP-Protocol-Version request headers are ignored');

      // Origin (AC-29).
      assert((await post(openPort, init, { Origin: 'http://evil.example' })).status === 403, 'origins [x]: foreign Origin is 403');
      assert((await post(openPort, init, { Origin: allowedOrigin })).status === 200, 'origins [x]: listed Origin is 200');
      assert((await post(closedPort, init, { Origin: allowedOrigin })).status === 403, 'origins []: any Origin is 403');
      assert((await post(closedPort, init)).status === 200, 'origins []: no Origin is 200');
    } finally {
      open.closeAllConnections?.();
      closed.closeAllConnections?.();
      await Promise.all([new Promise((r) => open.close(r)), new Promise((r) => closed.close(r))]);
    }

    // serve.mcp vs --config (pure guard, no spawn).
    {
      const proj = setup('mcp-http-conflict');
      writeFile(proj, 'docmd.config.json', '{}');
      writeFile(proj, 'other.config.json', '{}');
      const on = { serve: { mcp: { enabled: true } } };
      assert(mcpConfigConflict('other.config.json', on, proj) !== null, 'mcp + --config naming another file is refused');
      assert(mcpConfigConflict('docmd.config.js', on, proj) === null, 'mcp + default config is allowed');
      assert(mcpConfigConflict('./docmd.config.json', on, proj) === null, 'mcp + --config naming the default file is allowed');
      assert(mcpConfigConflict('other.config.json', { serve: { mcp: { enabled: false } } }, proj) === null, 'mcp off never conflicts');
    }

    // Wiring through the real command.
    {
      const port = await freePort();
      const wired = setup('mcp-http-serve');
      writeFile(wired, 'docmd.config.json', JSON.stringify({
        title: 'T', out: 'site', url: 'https://example.test',
        serve: { mcp: { enabled: true, origins: [`http://127.0.0.1:${port}`] } },
      }));
      writeFile(wired, 'docs/index.md', '# Home\n');
      const handle = spawnServe(wired, ['--port', String(port)]);
      try {
        await waitForHealthz(port, handle);
        const r = await post(port, init, { Origin: `http://127.0.0.1:${port}` });
        assert(r.status === 200 && r.json?.result?.serverInfo?.name === 'docmd-mcp-server',
          'serve: POST /mcp initialize with a configured Origin is 200 with serverInfo.name');
        const g = await request(port, '/mcp', 'GET');
        assert(g.status === 405, 'serve: GET /mcp is 405');
        assert(/MCP\s*:?\s*on/.test(handle.output.text.replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')), 'serve: banner shows MCP on');
      } finally {
        await stopServe(handle);
      }
    }
  }
});

export const results = {
  get passed() { return passed; },
  get failed() { return failed; },
  get failures() { return [...failures]; }
};
