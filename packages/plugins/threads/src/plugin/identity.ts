import { ThreadsError } from './errors.js';
import type { Caller } from '../types.js';

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/**
 * Who is calling, or null when the call carries no identity. Never throws.
 * Payload branch (`docmd dev`): the client names itself. A header branch is
 * added here by a later unit, ahead of this one.
 */
export function findCaller(_ctx: unknown, payload: Record<string, any> | null | undefined): Caller | null {
  const name = str(payload?.author);
  const key = str(payload?.authorKey) ?? name;
  if (!key) return null;
  return {
    key,
    name: name ?? key,
    email: null,
    avatarUrl: str(payload?.avatarUrl) ?? '',
    source: 'payload',
  };
}

/** Like findCaller, but a call without identity is an `invalid` error. */
export function resolveCaller(ctx: unknown, payload: Record<string, any> | null | undefined): Caller {
  const caller = findCaller(ctx, payload);
  if (!caller) throw new ThreadsError('invalid', 'caller identity is required (author)');
  return caller;
}

/** The explicit profile an `upsert-author` call carries (dev mode); `authorKey` and `name` are required. */
export function profileFromPayload(payload: Record<string, any>): { key: string; name: string; avatarUrl: string | undefined } {
  return { key: payload.authorKey, name: payload.name, avatarUrl: payload.avatarUrl };
}
