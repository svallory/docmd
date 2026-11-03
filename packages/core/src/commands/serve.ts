/**
 * --------------------------------------------------------------------
 * docmd : the zero-config documentation engine.
 *
 * @package     @docmd/core (and ecosystem)
 * @website     https://docmd.io
 * @repository  https://github.com/docmd-io/docmd
 * @license     MIT
 * @copyright   Copyright (c) 2025-present docmd.io
 *
 * [docmd-source] - Please do not remove this header.
 * --------------------------------------------------------------------
 */

import http from 'http';
import path from 'path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fsUtils as fs, WorkerPool } from '@docmd/utils';
import { TUI } from '@docmd/api';
import { buildSite } from './build.js';
import { loadConfig } from '../utils/config-loader.js';
import { exitWithError, exitCodeFor, failWith } from '../utils/exit.js';
import { formatPathForDisplay, getNetworkIp } from '../utils/dev-utils.js';
import { createStaticHandler } from '../server/static.js';
import { resolveServeBind, validateServeConfig } from '../server/serve-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Graceful shutdown budget; stays below `docmd stop`'s 5 s SIGTERM grace. */
export const SHUTDOWN_BUDGET_MS = 4000;

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'));
    return String(pkg.version);
  } catch {
    return 'unknown';
  }
}

export interface ServeRouterOptions {
  outputDir: () => string;
  version: string;
}

/**
 * The request router: `/healthz`, `/mcp` (not served yet) and everything
 * else through the production static handler.
 */
export function createServeRouter(opts: ServeRouterOptions) {
  const staticHandler = createStaticHandler({ rootDir: opts.outputDir });
  const health = JSON.stringify({ status: 'ok', version: opts.version });

  return async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = req.url || '/';
    const pathname = target.startsWith('/') ? target.split(/[?#]/)[0] : target;

    if (pathname === '/healthz') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(health),
        'Cache-Control': 'no-store',
      });
      res.end(health);
      return;
    }

    if (pathname === '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    await staticHandler(req, res);
  };
}

/**
 * `docmd serve`: build once, then serve the output with the production
 * static handler. No watcher, no browser, no port probing, no raw stdin.
 */
export async function startServe(
  configPathOption: string,
  opts: { host?: string; port?: string } = {}
): Promise<void> {
  const CWD = process.cwd();

  // 1. Workspaces are not supported yet.
  try {
    const { detectWorkspace } = await import('../engine/workspace.js');
    if (await detectWorkspace(configPathOption)) {
      failWith('docmd serve does not support workspaces yet');
    }
  } catch (e) {
    exitWithError(e);
  }

  // 2. Config.
  let config: any;
  try {
    config = await loadConfig(configPathOption, { isDev: false, quiet: true });
  } catch (e) {
    exitWithError(e, { section: 'Failed to load config' });
  }

  // 3. serve section.
  const problems = validateServeConfig(config.serve);
  if (problems.length > 0) failWith(problems.join('\n'), { section: 'Invalid serve configuration' });

  // 4. Bind address: CLI > env > config > defaults.
  const { host, port } = resolveServeBind({
    cli: { host: opts.host, port: opts.port },
    env: process.env,
    config: config.serve,
  });
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    failWith(`Invalid port: ${String(opts.port || process.env.PORT)}. Expected an integer between 0 and 65535.`);
  }

  // 5. Clear the output dir (no stale files), then build once.
  const outputDir = path.resolve(CWD, config.out || 'site');
  if (outputDir === CWD || CWD.startsWith(outputDir + path.sep)) {
    failWith(`Refusing to clear output directory "${outputDir}": it contains the project root.`);
  }

  const elapsed = TUI.timer();
  const workerScript = path.resolve(__dirname, '../engine/worker-parser.js');
  const workerConfig = { ...config };
  delete workerConfig._workerPool;
  const workerPool = new WorkerPool(workerScript, { config: workerConfig, cwd: CWD });
  try {
    if (await fs.exists(outputDir)) await fs.remove(outputDir);
    await buildSite(configPathOption, { isDev: false, quiet: false, showStats: false, workerPool });
  } catch (e) {
    await workerPool.terminateAll().catch(() => {});
    exitWithError(e, { section: 'Build failed' });
  }
  TUI.info(`Build completed in ${elapsed()}.`);

  // 6. Server.
  const route = createServeRouter({ outputDir: () => outputDir, version: readVersion() });
  const server = http.createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Server Error');
      } else {
        res.destroy();
      }
    });
  });

  // 7. Actions are off: a WebSocket upgrade gets a definite answer.
  server.on('upgrade', (_req, socket) => {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', () => socket.destroy());
  });

  // 8. Listen on exactly host:port; no fallback.
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      exitWithError(new Error(`Port ${port} is already in use on ${host}.`), { section: 'Failed to start server' });
    }
    exitWithError(err, { section: 'Failed to start server' });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));

  // 9. Banner.
  const boundPort = (server.address() as any)?.port ?? port;
  const loopbackOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const anyHost = host === '0.0.0.0' || host === '::';
  const networkIp = anyHost ? getNetworkIp() : null;
  TUI.section('Production Server Running', TUI.green);
  TUI.item('', '', TUI.dim, TUI.green);
  TUI.item('Local Access', `http://${anyHost || loopbackOnly ? '127.0.0.1' : host}:${boundPort}`, TUI.bold, TUI.green);
  if (networkIp) TUI.item('Network Access', `http://${networkIp}:${boundPort}`, TUI.bold, TUI.green);
  TUI.item('Serving from', formatPathForDisplay(outputDir, CWD), TUI.dim, TUI.green);
  TUI.item('Actions', 'off', TUI.dim, TUI.green);
  TUI.item('MCP', 'off', TUI.dim, TUI.green);
  TUI.item('', '', TUI.dim, TUI.green);
  TUI.footer(TUI.green);

  // 10. Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => process.exit(exitCodeFor(new Error('shutdown timed out'))), SHUTDOWN_BUDGET_MS).unref();
    try {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
      await workerPool.terminateAll();
    } catch {
      // shutting down anyway
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
