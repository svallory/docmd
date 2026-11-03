import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { ActionContext } from '@docmd/api';
import * as parser from './parser.js';
import { ThreadsError } from './errors.js';
import { getOptions } from './config.js';
import { createDraftStore, type DraftStore } from './drafts.js';
import { overlay } from './overlay.js';
import { findCaller, resolveCaller } from './identity.js';
import type { Thread, Comment, Reaction, Anchor, Caller, DraftOp, Journal, DraftMode, WhoAmI } from '../types.js';

interface AuthorsMap {
  [key: string]: { name: string; avatarUrl: string };
}

/**
 * Resolve the .threads directory inside the docs source folder.
 * Falls back to projectRoot if config.src is not available.
 */
function getThreadsDir(ctx: ActionContext): string {
  const srcDir = ctx.config?.src || '';
  return path.join(ctx.projectRoot, srcDir, '.threads');
}

/**
 * Read the authors map from <docsRoot>/.threads/authors.json.
 * Returns {} if file doesn't exist.
 */
async function readAuthors(ctx: ActionContext): Promise<AuthorsMap> {
  const filePath = path.join(getThreadsDir(ctx), 'authors.json');
  try {
    const content = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(content) as AuthorsMap;
  } catch (e: any) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
}

/**
 * Write the authors map to <docsRoot>/.threads/authors.json.
 * Creates the directory if needed.
 */
async function writeAuthors(ctx: ActionContext, authors: AuthorsMap): Promise<void> {
  const dirPath = getThreadsDir(ctx);
  const filePath = path.join(dirPath, 'authors.json');
  await fs.promises.mkdir(dirPath, { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(authors, null, 2) + '\n');
}

/**
 * Upsert an author entry. Updates name/avatarUrl if provided.
 */
async function upsertAuthor(ctx: ActionContext, authorKey: string, name: string, avatarUrl?: string): Promise<void> {
  const authors = await readAuthors(ctx);
  const existing = authors[authorKey] || { name: '', avatarUrl: '' };
  authors[authorKey] = {
    name: name || existing.name || authorKey,
    avatarUrl: avatarUrl || existing.avatarUrl || '',
  };
  await writeAuthors(ctx, authors);
}

const generateThreadId = () => 't-' + crypto.randomBytes(4).toString('hex');
const generateCommentId = () => 'c-' + crypto.randomBytes(4).toString('hex');

/** One store per docs root and default mode; `Date.now` is the production clock. */
const stores = new Map<string, DraftStore>();
function getStore(ctx: ActionContext): DraftStore {
  const opts = getOptions(ctx);
  const defaultMode: DraftMode = opts.autoPublish && opts.autoPublish.startOn ? 'auto' : 'collect';
  const root = path.join(ctx.projectRoot, ctx.config?.src || '');
  const id = `${root}\0${defaultMode}`;
  let store = stores.get(id);
  if (!store) {
    store = createDraftStore(root, { now: Date.now, defaultMode });
    stores.set(id, store);
  }
  return store;
}

/** Validate that required string fields are present and non-empty. */
function requireFields(action: string, payload: Record<string, any>, fields: string[]): void {
  for (const field of fields) {
    if (!payload[field] || (typeof payload[field] === 'string' && !payload[field].trim())) {
      throw new ThreadsError('invalid', `${action}: ${field} is required`);
    }
  }
}

function toAnchor(raw: unknown): Anchor | null {
  if (raw && typeof raw === 'object' && typeof (raw as any).quote === 'string' && (raw as any).quote) {
    return raw as Anchor;
  }
  return null;
}

/** Everything a mutation handler works on: the caller, the store and the view the caller sees. */
interface Session {
  caller: Caller;
  store: DraftStore;
  file: string;
  published: Thread[];
  journal: Journal;
  view: Thread[];
}

async function open(ctx: ActionContext, payload: any, file: string): Promise<Session> {
  const caller = resolveCaller(ctx, payload);
  const store = getStore(ctx);
  const published = parser.parseThreadsFromContent(await ctx.readFile(file));
  return refresh({ caller, store, file, published, journal: await store.load(caller.key), view: [] });
}

function refresh(s: Session, journal: Journal = s.journal): Session {
  return { ...s, journal, view: overlay(s.published, journal.ops, s.file, { key: s.caller.key, name: s.caller.name }) };
}

function findThread(view: Thread[], threadId: string): Thread {
  const thread = view.find((t) => t.id === threadId);
  if (!thread) throw new ThreadsError('not-found', `Thread not found: ${threadId}`);
  return thread;
}

function findComment(thread: Thread, commentId: string): Comment {
  const comment = thread.comments.find((c) => c.id === commentId);
  if (!comment) throw new ThreadsError('not-found', `Comment not found: ${commentId}`);
  return comment;
}

const inFile = (s: Session) => s.journal.ops.filter((o) => o.file === s.file);
const draftedThreadOp = (s: Session, threadId: string) =>
  inFile(s).find((o) => o.kind === 'add-thread' && o.threadId === threadId);
const draftedCommentOp = (s: Session, commentId: string) =>
  inFile(s).find((o) => (o.kind === 'add-thread' || o.kind === 'add-comment') && o.commentId === commentId);
const opsOnThread = (s: Session, threadId: string) => inFile(s).filter((o) => o.threadId === threadId);
const opsOnComment = (s: Session, commentId: string) =>
  inFile(s).filter((o) => 'commentId' in o && o.commentId === commentId);
const ids = (ops: DraftOp[]) => ops.map((o) => o.opId);

/** Dev mode writes author profiles straight to authors.json, as before. */
async function recordProfile(ctx: ActionContext, caller: Caller): Promise<void> {
  if (caller.source === 'payload' && caller.key !== caller.name) {
    await upsertAuthor(ctx, caller.key, caller.name, caller.avatarUrl);
  }
}

export const actions: Record<string, (payload: any, ctx: ActionContext) => Promise<any>> = {
  'threads:get-authors': async (_payload, ctx): Promise<AuthorsMap> => readAuthors(ctx),

  'threads:upsert-author': async (payload, ctx): Promise<{ ok: boolean }> => {
    requireFields('threads:upsert-author', payload, ['authorKey', 'name']);
    await upsertAuthor(ctx, payload.authorKey, payload.name, payload.avatarUrl);
    return { ok: true };
  },

  /** Published threads plus the caller's own drafts. */
  'threads:get-threads': async (payload, ctx): Promise<Thread[]> => {
    requireFields('threads:get-threads', payload, ['file']);
    const published = parser.parseThreadsFromContent(await ctx.readFile(payload.file));
    const caller = findCaller(ctx, payload);
    if (!caller) return published;
    const journal = await getStore(ctx).load(caller.key);
    return overlay(published, journal.ops, payload.file, { key: caller.key, name: caller.name });
  },

  'threads:whoami': async (payload, ctx): Promise<WhoAmI> => {
    const identity = findCaller(ctx, payload);
    if (!identity) return { identity: null, journal: null };
    return { identity, journal: await getStore(ctx).load(identity.key) };
  },

  'threads:set-mode': async (payload, ctx): Promise<Journal> => {
    if (payload?.mode !== 'auto' && payload?.mode !== 'collect') {
      throw new ThreadsError('invalid', "threads:set-mode: mode must be 'auto' or 'collect'");
    }
    const caller = resolveCaller(ctx, payload);
    return getStore(ctx).setMode(caller.key, payload.mode);
  },

  'threads:add-thread': async (payload, ctx): Promise<Thread> => {
    requireFields('threads:add-thread', payload, ['file', 'author', 'body']);
    const s = await open(ctx, payload, payload.file);
    await recordProfile(ctx, s.caller);
    const threadId = generateThreadId();
    const journal = await s.store.append(s.caller.key, {
      kind: 'add-thread', file: s.file, threadId, commentId: generateCommentId(),
      anchor: toAnchor(payload.anchor), body: payload.body,
    });
    return findThread(refresh(s, journal).view, threadId);
  },

  'threads:add-comment': async (payload, ctx): Promise<Comment> => {
    requireFields('threads:add-comment', payload, ['file', 'threadId', 'author', 'body']);
    const s = await open(ctx, payload, payload.file);
    findThread(s.view, payload.threadId);
    await recordProfile(ctx, s.caller);
    const commentId = generateCommentId();
    const journal = await s.store.append(s.caller.key, {
      kind: 'add-comment', file: s.file, threadId: payload.threadId, commentId,
      parentId: payload.parentId || null, body: payload.body,
    });
    return findComment(findThread(refresh(s, journal).view, payload.threadId), commentId);
  },

  'threads:edit-comment': async (payload, ctx): Promise<Comment> => {
    requireFields('threads:edit-comment', payload, ['file', 'threadId', 'commentId', 'body']);
    const { threadId, commentId, body } = payload;
    const s = await open(ctx, payload, payload.file);
    findComment(findThread(s.view, threadId), commentId);
    const drafted = draftedCommentOp(s, commentId);
    const journal = drafted
      ? await s.store.update(s.caller.key, { opId: drafted.opId, body })
      : await s.store.append(s.caller.key, { kind: 'edit-comment', file: s.file, threadId, commentId, body });
    return findComment(findThread(refresh(s, journal).view, threadId), commentId);
  },

  'threads:delete-comment': async (payload, ctx): Promise<{ deleted: boolean }> => {
    requireFields('threads:delete-comment', payload, ['file', 'threadId', 'commentId']);
    const { threadId, commentId } = payload;
    const s = await open(ctx, payload, payload.file);
    findComment(findThread(s.view, threadId), commentId);
    const drafted = draftedCommentOp(s, commentId);
    if (drafted?.kind === 'add-thread') {
      // The first comment of a drafted thread: the thread goes with it.
      await s.store.removeOp(s.caller.key, ids(opsOnThread(s, threadId)));
    } else if (drafted) {
      await s.store.removeOp(s.caller.key, ids(opsOnComment(s, commentId)));
    } else {
      await s.store.removeOp(s.caller.key, ids(opsOnComment(s, commentId)));
      await s.store.append(s.caller.key, { kind: 'delete-comment', file: s.file, threadId, commentId });
    }
    return { deleted: true };
  },

  'threads:delete-thread': async (payload, ctx): Promise<{ deleted: boolean }> => {
    requireFields('threads:delete-thread', payload, ['file', 'threadId']);
    const { threadId } = payload;
    const s = await open(ctx, payload, payload.file);
    findThread(s.view, threadId);
    await s.store.removeOp(s.caller.key, ids(opsOnThread(s, threadId)));
    if (!draftedThreadOp(s, threadId)) {
      await s.store.append(s.caller.key, { kind: 'delete-thread', file: s.file, threadId });
    }
    return { deleted: true };
  },

  'threads:resolve-thread': async (payload, ctx): Promise<Thread> => {
    requireFields('threads:resolve-thread', payload, ['file', 'threadId']);
    const { threadId } = payload;
    const s = await open(ctx, payload, payload.file);
    findThread(s.view, threadId);
    // A drafted thread has no resolved field to flip: a second toggle cancels the first.
    const pending = draftedThreadOp(s, threadId)
      ? opsOnThread(s, threadId).find((o) => o.kind === 'resolve-thread')
      : undefined;
    const journal = pending
      ? await s.store.removeOp(s.caller.key, pending.opId)
      : await s.store.append(s.caller.key, { kind: 'resolve-thread', file: s.file, threadId });
    return findThread(refresh(s, journal).view, threadId);
  },

  'threads:toggle-reaction': async (payload, ctx): Promise<Reaction[]> => {
    requireFields('threads:toggle-reaction', payload, ['file', 'threadId', 'commentId', 'emoji']);
    const { threadId, commentId, emoji } = payload;
    const s = await open(ctx, payload, payload.file);
    findComment(findThread(s.view, threadId), commentId);
    // On a drafted comment a second toggle of the same emoji cancels the first.
    const pending = draftedCommentOp(s, commentId)
      ? opsOnComment(s, commentId).find((o) => o.kind === 'toggle-reaction' && o.emoji === emoji)
      : undefined;
    const journal = pending
      ? await s.store.removeOp(s.caller.key, pending.opId)
      : await s.store.append(s.caller.key, { kind: 'toggle-reaction', file: s.file, threadId, commentId, emoji });
    return findComment(findThread(refresh(s, journal).view, threadId), commentId).reactions;
  },
};
