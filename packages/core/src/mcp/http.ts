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

import type http from 'http';
import type { McpHandler } from './handler.js';

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpHttpOptions {
  handler: McpHandler;
  /** Allowed `Origin` values. An `Origin` header, when present, must match one. */
  origins: string[];
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, extra: http.OutgoingHttpHeaders = {}): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(body);
}

function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0', id: null, error: { code, message } };
}

/** Collect the body; resolves `null` once it exceeds the limit (the rest is discarded). */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', reject);
  });
}

/**
 * Stateless MCP over HTTP: `POST` only, one JSON response per request.
 * No sessions and no SSE; `Mcp-Session-Id` and `MCP-Protocol-Version`
 * request headers are ignored.
 */
export function createMcpHttpHandler(opts: McpHttpOptions) {
  const allowed = new Set(opts.origins);

  return async function mcpHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      req.resume();
      sendJson(res, 403, rpcError(-32600, 'Origin not allowed'));
      return;
    }

    if (req.method !== 'POST') {
      req.resume();
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const raw = await readBody(req);
    if (raw === null) {
      sendJson(res, 413, rpcError(-32600, 'Request body exceeds 1 MiB'), { Connection: 'close' });
      return;
    }

    let message: any;
    try {
      message = JSON.parse(raw);
    } catch (err: any) {
      sendJson(res, 400, rpcError(-32700, `Parse error: ${err.message}`));
      return;
    }

    try {
      if (Array.isArray(message)) {
        if (message.length === 0) {
          sendJson(res, 400, rpcError(-32600, 'Invalid Request: empty batch'));
          return;
        }
        const replies = (await Promise.all(message.map((m) => opts.handler.handle(m)))).filter((r) => r !== null);
        if (replies.length === 0) {
          res.writeHead(202, { 'Content-Length': 0 });
          res.end();
          return;
        }
        sendJson(res, 200, replies);
        return;
      }

      const reply = await opts.handler.handle(message);
      if (reply === null) {
        res.writeHead(202, { 'Content-Length': 0 });
        res.end();
        return;
      }
      sendJson(res, 200, reply);
    } catch (err: any) {
      sendJson(res, 500, rpcError(-32603, `Internal error: ${err.message}`));
    }
  };
}
