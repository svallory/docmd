/**
 * --------------------------------------------------------------------
 * docmd : the zero-config documentation engine.
 *
 * Static file handler contracts (AC-11..AC-15): path safety, caching
 * headers, MIME table, HEAD, and the dev wrapper's injection.
 *
 * Run: `node tests/runner.js --only=static-server`
 * --------------------------------------------------------------------
 */

import http from 'node:http';
import path from 'node:path';
import { setup, writeFile, runTestFile } from '../shared.js';
import { createStaticHandler } from '../../packages/core/dist/server/static.js';
import { serveStatic } from '../../packages/core/dist/utils/dev-utils.js';

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

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => handler(req, res));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Raw request so that paths such as `/../x` are not normalised by a client.
function request(server, method, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, method, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

const MIME_TABLE = [
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['avif', 'image/avif'],
  ['xml', 'application/xml'], ['wasm', 'application/wasm'], ['mjs', 'text/javascript'],
  ['map', 'application/json'], ['webmanifest', 'application/manifest+json'],
  ['unknownext', 'application/octet-stream'],
];

export const test = runTestFile({
  name: 'Static handler: production serving, path safety, dev wrapper (AC-11..15)',
  emoji: '📁',
  run: async () => {
    const base = setup('static-server');
    const site = path.join(base, 'site');
    const bare = path.join(base, 'bare');
    const html404 = '<html><body><h1>custom missing</h1></body></html>';
    writeFile(site, 'index.html', '<html><body>home</body></html>');
    writeFile(site, 'page.html', '<html><body>page</body></html>');
    writeFile(site, 'dir/index.html', '<html><body>dir index</body></html>');
    writeFile(site, '404.html', html404);
    for (const [ext] of MIME_TABLE) writeFile(site, `assets/x.${ext}`, 'x');
    writeFile(base, 'site-private/secret.txt', 'SECRET');
    writeFile(bare, 'index.html', '<html><body>bare</body></html>');

    const prod = await listen(createStaticHandler({ rootDir: site }));
    const prodBare = await listen(createStaticHandler({ rootDir: () => bare }));
    const dev = await listen((req, res) => serveStatic(req, res, site));

    try {
      // AC-11: caching + nosniff
      const ok = await request(prod, 'GET', '/page');
      const etag = ok.headers['etag'];
      assert(ok.status === 200 && ok.headers['cache-control'] === 'no-cache', 'AC-11: 200 carries Cache-Control: no-cache');
      assert(/^W\/".+"$/.test(etag || ''), 'AC-11: 200 carries a weak ETag');
      const cached = await request(prod, 'GET', '/page', { 'If-None-Match': etag });
      assert(cached.status === 304 && cached.body.length === 0, 'AC-11: matching If-None-Match gives an empty 304');
      const redirect = await request(prod, 'GET', '/dir');
      const forbidden = await request(prod, 'GET', '/..%2f..%2fetc/passwd');
      const missing = await request(prod, 'GET', '/nope');
      for (const [label, r] of [['200', ok], ['301', redirect], ['304', cached], ['403', forbidden], ['404', missing]]) {
        assert(r.headers['x-content-type-options'] === 'nosniff', `AC-11: ${label} carries nosniff`);
      }

      // AC-12: traversal
      assert(forbidden.status === 403, 'AC-12: encoded ../ traversal is 403');
      assert((await request(prod, 'GET', '/../docmd.config.json')).status === 403, 'AC-12: raw ../ traversal is 403');
      for (const p of ['/../site-private/secret.txt', '/..%2fsite-private/secret.txt', '/%2e%2e/site-private/secret.txt']) {
        const r = await request(prod, 'GET', p);
        assert(r.status !== 200 && !r.body.toString().includes('SECRET'), `AC-12: sibling-prefix attack ${p} is not served`);
      }

      // AC-13: 404 / redirect / index / extensionless
      assert(missing.status === 404 && missing.body.toString() === html404, 'AC-13: 404 body is byte-equal to 404.html');
      const plain = await request(prodBare, 'GET', '/nope');
      assert(plain.status === 404 && !/dev server/i.test(plain.body.toString()), 'AC-13: plain 404 without 404.html has no "dev server"');
      assert(redirect.status === 301 && redirect.headers['location'] === '/dir/', 'AC-13: /dir redirects to /dir/');
      assert((await request(prod, 'GET', '/dir/')).body.toString().includes('dir index'), 'AC-13: /dir/ serves dir/index.html');
      assert(ok.body.toString().includes('page'), 'AC-13: /page serves page.html');

      // AC-14: MIME table
      for (const [ext, expected] of MIME_TABLE) {
        const r = await request(prod, 'GET', `/assets/x.${ext}`);
        assert(r.headers['content-type'] === expected, `AC-14: .${ext} is ${expected} (got ${r.headers['content-type']})`);
      }

      // HEAD mirrors GET
      const head = await request(prod, 'HEAD', '/page');
      assert(head.status === ok.status && head.body.length === 0, 'HEAD: same status, empty body');
      assert(['content-type', 'etag', 'cache-control', 'x-content-type-options', 'content-length']
        .every((h) => head.headers[h] === ok.headers[h]), 'HEAD: same headers as GET');

      // AC-15: dev wrapper
      const devPage = (await request(dev, 'GET', '/')).body.toString();
      assert(devPage.includes('window.__docmd_dev') && devPage.includes('<script src="/__dev/docmd-api.js">'), 'AC-15: dev injects __docmd_dev and the api script tag');
      const api = await request(dev, 'GET', '/__dev/docmd-api.js');
      assert(api.status === 200 && /javascript/.test(api.headers['content-type']), 'AC-15: /__dev/docmd-api.js is 200 JavaScript');
      assert((await request(dev, 'GET', '/')).headers['cache-control'] === 'no-cache', 'AC-15: dev sends no-cache');
      const devBare = http.createServer((req, res) => serveStatic(req, res, bare));
      await new Promise((r) => devBare.listen(0, '127.0.0.1', r));
      try {
        const d404 = await request(devBare, 'GET', '/nope');
        assert(d404.status === 404 && d404.body.toString().includes('docmd dev server'), 'AC-15: dev 404 mentions "docmd dev server"');
      } finally {
        devBare.close();
      }
    } finally {
      prod.close();
      prodBare.close();
      dev.close();
    }
  }
});

export const results = {
  get passed() { return passed; },
  get failed() { return failed; },
  get failures() { return [...failures]; }
};
