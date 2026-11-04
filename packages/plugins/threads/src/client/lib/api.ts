import type { Thread, Comment, Reaction, AuthorsMap, Journal, WhoAmI, PublishResult, DraftMode, ReviewSummary } from '../../types';
import { getIdentityPayload } from './identity';

declare global {
  var docmd: {
    call(action: string, payload: any): Promise<any>;
    send(name: string, data: any): void;
    on(name: string, callback: (data: any) => void): () => void;
    afterReload(name: string, callback: (ctx: any) => void): void;
    scheduleReload(name: string, context?: any): void;
    isLive(): boolean;
  };
}

function getSourceFile(): string {
  const file = document.body.dataset['sourceFile'];
  if (!file) throw new Error('[threads] data-source-file not found on body element');
  return file;
}

export async function fetchAuthors(): Promise<AuthorsMap> {
  try {
    return await docmd.call('threads:get-authors', {});
  } catch {
    // Fallback to injected global (static builds)
    return (window as any).__threads_authors || {};
  }
}

export async function upsertAuthor(authorKey: string | null, name: string, avatarUrl: string): Promise<void> {
  // A header identity names itself; the server rejects a client-sent key.
  await docmd.call('threads:upsert-author', authorKey === null ? { name, avatarUrl } : { authorKey, name, avatarUrl });
}

export async function fetchThreads(): Promise<Thread[]> {
  return docmd.call('threads:get-threads', { file: getSourceFile() });
}

export async function createThread(payload: {
  anchor: any | null;
  author: string;
  body: string;
  authorKey?: string;
  avatarUrl?: string;
}): Promise<Thread> {
  return docmd.call('threads:add-thread', {
    file: getSourceFile(),
    ...payload,
  });
}

export async function addComment(
  threadId: string,
  payload: { author: string; body: string; parentId?: string | null; authorKey?: string; avatarUrl?: string },
): Promise<Comment> {
  return docmd.call('threads:add-comment', {
    file: getSourceFile(),
    threadId,
    ...payload,
  });
}

export async function editComment(
  threadId: string,
  commentId: string,
  payload: { body: string },
): Promise<Comment> {
  return docmd.call('threads:edit-comment', {
    file: getSourceFile(),
    threadId,
    commentId,
    ...payload,
  });
}

export async function deleteComment(
  threadId: string,
  commentId: string,
): Promise<void> {
  await docmd.call('threads:delete-comment', {
    file: getSourceFile(),
    threadId,
    commentId,
  });
}

export async function deleteThread(threadId: string): Promise<void> {
  await docmd.call('threads:delete-thread', {
    file: getSourceFile(),
    threadId,
  });
}

export async function resolveThread(
  threadId: string,
  payload: { resolved_by: string },
): Promise<Thread> {
  return docmd.call('threads:resolve-thread', {
    file: getSourceFile(),
    threadId,
    ...payload,
  });
}

export async function toggleReaction(
  threadId: string,
  commentId: string,
  payload: { emoji: string; author: string },
): Promise<Reaction[]> {
  return docmd.call('threads:toggle-reaction', {
    file: getSourceFile(),
    threadId,
    commentId,
    ...payload,
  });
}

/** A server rejection `threads/<code>: <text>` parsed back into its parts. */
export class ThreadsClientError extends Error {
  readonly code: string;
  readonly text: string;

  constructor(code: string, text: string) {
    super(`threads/${code}: ${text}`);
    this.name = 'ThreadsClientError';
    this.code = code;
    this.text = text;
  }
}

const WIRE_ERROR = /^threads\/([a-z][a-z-]*): ([\s\S]*)$/;

/** `docmd.call` that turns `threads/<code>: <text>` rejections into ThreadsClientError. */
async function call<T>(action: string, payload: any): Promise<T> {
  try {
    return await docmd.call(action, payload);
  } catch (err) {
    const m = WIRE_ERROR.exec(err instanceof Error ? err.message : String(err));
    if (m) throw new ThreadsClientError(m[1]!, m[2]!);
    throw err;
  }
}

export function whoami(identity?: { author: string; authorKey: string; avatarUrl: string }): Promise<WhoAmI> {
  return call('threads:whoami', identity ?? getIdentityPayload());
}

export function setMode(mode: DraftMode): Promise<Journal> {
  return call('threads:set-mode', { ...getIdentityPayload(), mode });
}

export function publishReview(input: { title?: string | null; summary?: string | null } = {}): Promise<PublishResult> {
  return call('threads:publish-review', { ...getIdentityPayload(), ...input });
}

export function listReviews(): Promise<ReviewSummary[]> {
  return call('threads:list-reviews', {});
}

export async function discardReview(reviewId: string): Promise<void> {
  await call('threads:discard-review', { ...getIdentityPayload(), reviewId });
}

export function updateReview(input: { title?: string | null; summary?: string | null }): Promise<Journal> {
  return call('threads:update-review', { ...getIdentityPayload(), ...input });
}
