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

import readline from 'readline';
import { createMcpHandler } from './handler.js';

/** Newline-delimited JSON-RPC over stdin/stdout; stderr carries diagnostics. */
export async function runMcpServer() {
  console.error("docmd MCP server starting...");

  const handler = createMcpHandler({ cwd: process.cwd(), log: (line) => console.error(line) });

  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let response;
    try {
      response = await handler.handle(JSON.parse(line));
    } catch (err: any) {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${err.message}` } };
    }
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}
