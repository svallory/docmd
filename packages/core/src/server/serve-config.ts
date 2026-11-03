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

/**
 * The `serve` config section (production server) and the decisions made
 * about it: defaults, validation and host/port precedence.
 *
 * `normalizeServeConfig` never throws, so `build` and `dev` keep working
 * with a bad `serve` block. `validateServeConfig` is what `docmd serve`
 * calls at startup to refuse it.
 */

export interface ServeConfig {
  host: string;
  port: number;
  actions: { enabled: boolean; origins: string[] };
  mcp: { enabled: boolean; origins: string[] };
}

export const DEFAULT_SERVE_HOST = '127.0.0.1';
export const DEFAULT_SERVE_PORT = 3000;

function toOrigins(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

/** Fill defaults for the user's `serve` section. Never throws. */
export function normalizeServeConfig(userServe: any): ServeConfig {
  const u = userServe && typeof userServe === 'object' ? userServe : {};
  const actions = u.actions && typeof u.actions === 'object' ? u.actions : {};
  const mcp = u.mcp && typeof u.mcp === 'object' ? u.mcp : {};
  return {
    host: typeof u.host === 'string' && u.host !== '' ? u.host : DEFAULT_SERVE_HOST,
    port: u.port === undefined || u.port === null || u.port === '' ? DEFAULT_SERVE_PORT : Number(u.port),
    actions: { enabled: actions.enabled === true, origins: toOrigins(actions.origins) },
    mcp: { enabled: mcp.enabled === true, origins: toOrigins(mcp.origins) },
  };
}

/** `true` when `value` is a full http(s) origin such as `https://docs.example.com`. */
function isValidOrigin(value: string): boolean {
  if (value === '*') return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin !== 'null';
  } catch {
    return false;
  }
}

/** Startup validation. Returns one message per problem; empty means valid. */
export function validateServeConfig(serve: ServeConfig): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(serve.port) || serve.port < 0 || serve.port > 65535) {
    errors.push(`serve.port must be an integer between 0 and 65535 (got ${String(serve.port)}).`);
  }
  if (serve.actions.enabled && serve.actions.origins.length === 0) {
    errors.push('serve.actions.origins must list at least one origin when serve.actions.enabled is true.');
  }
  for (const o of serve.actions.origins) {
    if (!isValidOrigin(o)) errors.push(`serve.actions.origins contains an invalid origin: "${o}" (expected e.g. "https://docs.example.com").`);
  }
  for (const o of serve.mcp.origins) {
    if (!isValidOrigin(o)) errors.push(`serve.mcp.origins contains an invalid origin: "${o}" (expected e.g. "https://docs.example.com").`);
  }
  return errors;
}

export interface ServeBindInput {
  cli: { host?: string; port?: string | number };
  env: Record<string, string | undefined>;
  config: Pick<ServeConfig, 'host' | 'port'>;
}

/** CLI > environment > config > defaults (the config already carries the defaults). */
export function resolveServeBind(input: ServeBindInput): { host: string; port: number } {
  const { cli, env, config } = input;
  const host = cli.host || env.DOCMD_HOST || config.host || DEFAULT_SERVE_HOST;
  const rawPort = cli.port || env.PORT || config.port;
  return { host, port: Number(rawPort) };
}
