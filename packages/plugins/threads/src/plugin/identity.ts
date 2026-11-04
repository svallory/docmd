import type { ActionContext } from '@docmd/api';
import { ThreadsError } from './errors.js';
import { getOptions } from './config.js';
import { readAuthors } from './authors.js';
import type { Caller } from '../types.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** What identity resolution reads from the action context. */
type IdentityCtx = Partial<Pick<ActionContext, 'caller' | 'mode' | 'config' | 'projectRoot'>>;

/** The trusted header value (trimmed) and the key derived from it, or null when absent (or the call is local). */
function headerIdentity(ctx: IdentityCtx, header: string): { raw: string; key: string } | null {
  if (!ctx.caller || ctx.caller.transport !== 'websocket') return null;
  const raw = str(ctx.caller.headers?.[header.toLowerCase()])?.trim();
  if (!raw) return null;
  return { raw, key: /\s/.test(raw) ? encodeURIComponent(raw) : raw };
}

/**
 * Who is calling, or null when the call carries no identity. Throws only when
 * authors.json exists but cannot be read.
 * With `identityHeader` configured only that header is trusted and the payload
 * is ignored; otherwise (`docmd dev`) the client names itself.
 */
export async function findCaller(ctx: IdentityCtx, payload: Record<string, any> | null | undefined): Promise<Caller | null> {
  const opts = getOptions(ctx);
  if (opts.identityHeader) {
    const id = headerIdentity(ctx, opts.identityHeader);
    if (!id) return null;
    const { raw, key } = id;
    const entry = (await readAuthors(ctx))[key];
    return {
      key,
      name: str(entry?.name) ?? key,
      email: raw.includes('@') ? raw : `${key}@threads.invalid`,
      avatarUrl: str(entry?.avatarUrl) ?? '',
      source: 'header',
      isAdmin: opts.permissions.admins.includes(key),
    };
  }
  if (ctx.mode === 'serve') return null;
  const name = str(payload?.author);
  const key = str(payload?.authorKey) ?? name;
  if (!key) return null;
  return {
    key,
    name: name ?? key,
    email: null,
    avatarUrl: str(payload?.avatarUrl) ?? '',
    source: 'payload',
    isAdmin: false,
  };
}

/**
 * Like findCaller, but a call without identity is an error. With `write`, a
 * server that has no trusted identity source (serve mode, no header configured)
 * refuses; a configured header that is missing is `unauthenticated`.
 */
export async function resolveCaller(
  ctx: IdentityCtx,
  payload: Record<string, any> | null | undefined,
  { write = false }: { write?: boolean } = {},
): Promise<Caller> {
  const opts = getOptions(ctx);
  if (write && !opts.identityHeader && ctx.mode === 'serve') {
    throw new ThreadsError('no-identity-source', 'this server has no trusted identity source; set plugins.threads.identityHeader');
  }
  const caller = await findCaller(ctx, payload);
  if (caller) return caller;
  if (opts.identityHeader) {
    throw new ThreadsError('unauthenticated', `identity header ${opts.identityHeader} is missing from the request`);
  }
  throw new ThreadsError('invalid', 'caller identity is required (author)');
}

/** The explicit profile an `upsert-author` call carries (dev mode); `authorKey` and `name` are required. */
export function profileFromPayload(payload: Record<string, any>): { key: string; name: string; avatarUrl: string | undefined } {
  return { key: payload.authorKey, name: payload.name, avatarUrl: payload.avatarUrl };
}

/** The profile a payload caller supplies with an explicit `authorKey` (dev mode), else null. */
export function payloadProfile(payload: Record<string, any>): { key: string; name: string; avatarUrl: string } | null {
  const key = str(payload?.authorKey);
  const name = str(payload?.author);
  return key && name ? { key, name, avatarUrl: str(payload?.avatarUrl) ?? '' } : null;
}

/** The profile a header caller sets with `upsert-author`: a name, and an avatar that defaults to the current one. */
export function headerProfile(payload: Record<string, any>, caller: Caller): { name: string; avatarUrl: string } {
  return { name: payload.name, avatarUrl: str(payload?.avatarUrl) ?? caller.avatarUrl };
}
