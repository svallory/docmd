/**
 * Server errors. The message prefix `threads/<code>: ` is the wire contract:
 * the dispatcher returns plain error messages, and the client parses the
 * prefix back into `{ code, text }`.
 */

export type ThreadsErrorCode =
  | 'not-found' | 'invalid' | 'config' | 'empty-review' | 'limit-chars' | 'rate-limited'
  | 'unauthenticated' | 'no-identity-source';

const PREFIX = /^threads\/([a-z][a-z-]*): ([\s\S]*)$/;

export class ThreadsError extends Error {
  readonly code: ThreadsErrorCode;

  constructor(code: ThreadsErrorCode, text: string, options?: { cause?: unknown }) {
    super(`threads/${code}: ${text}`, options);
    this.name = 'ThreadsError';
    this.code = code;
  }

  /** Split a `threads/<code>: <text>` message; `null` when it has no prefix. */
  static parse(message: string): { code: string; text: string } | null {
    const m = PREFIX.exec(message);
    return m ? { code: m[1], text: m[2] } : null;
  }
}
