import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import type { ActionContext } from '@docmd/api';
import * as parser from './parser.js';
import { ThreadsError } from './errors.js';
import { getOptions } from './config.js';
import { createDraftStore, makeOp, type DraftStore } from './drafts.js';
import { guardWrite } from './limits.js';
import { overlay } from './overlay.js';
import { findCaller, payloadProfile, profileFromPayload, resolveCaller } from './identity.js';
import { defaultSync, finishEarlierPublish, listManifests, parseReviewFields, publish, summarize } from './reviews.js';
import type { Thread, Comment, Reaction, Anchor, Caller, DraftOp, Journal, DraftMode, NewDraftOp, WhoAmI, PublishResult, ReviewSummary } from '../types.js';

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

/** One store per docs root, so its lock covers every caller; `Date.now` is the production clock. */
const stores = new Map<string, { store: DraftStore; mode: DraftMode }>();
function getStore(ctx: ActionContext): DraftStore {
  const opts = getOptions(ctx);
  const root = path.join(ctx.projectRoot, ctx.config?.src || '');
  let entry = stores.get(root);
  if (!entry) {
    const e = { store: undefined as unknown as DraftStore, mode: 'collect' as DraftMode };
    e.store = createDraftStore(root, { now: Date.now, defaultMode: () => e.mode });
    stores.set(root, (entry = e));
  }
  entry.mode = opts.autoPublish && opts.autoPublish.startOn ? 'auto' : 'collect';
  return entry.store;
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

/** The state a mutation decides on, inside one locked read-modify-write of the caller's journal. */
interface Tx {
  j: Journal;
  at: string;
  file: string;
  /** Published threads with the caller's drafts applied, as of the start of this cycle. */
  view: Thread[];
}

const fileOps = (tx: Tx) => tx.j.ops.filter((o) => o.file === tx.file);
const draftedThreadOp = (tx: Tx, threadId: string) =>
  fileOps(tx).find((o) => o.kind === 'add-thread' && o.threadId === threadId);
const draftedCommentOp = (tx: Tx, commentId: string) =>
  fileOps(tx).find((o) => (o.kind === 'add-thread' || o.kind === 'add-comment') && o.commentId === commentId);
const opsOnThread = (tx: Tx, threadId: string) => fileOps(tx).filter((o) => o.threadId === threadId);
const opsOnComment = (tx: Tx, commentId: string) =>
  fileOps(tx).filter((o) => 'commentId' in o && o.commentId === commentId);
const push = (tx: Tx, op: NewDraftOp) => void tx.j.ops.push(makeOp(op, tx.at));
const drop = (tx: Tx, ops: DraftOp[]) => {
  const gone = new Set(ops.map((o) => o.opId));
  tx.j.ops = tx.j.ops.filter((o) => !gone.has(o.opId));
};
/** Ops on a comment plus, transitively, the caller's drafted replies to it (deleting a comment deletes those replies). */
function opsOnCommentTree(tx: Tx, commentId: string): DraftOp[] {
  const out = new Set<DraftOp>();
  const queue = [commentId];
  while (queue.length) {
    const id = queue.pop()!;
    for (const o of opsOnComment(tx, id)) out.add(o);
    for (const o of fileOps(tx)) if (o.kind === 'add-comment' && o.parentId === id) queue.push(o.commentId);
  }
  return [...out];
}

interface Outcome {
  /** Published threads with the caller's drafts applied, after the change. */
  view: Thread[];
}

/** Resolve the caller, then run `fn` as one locked read-modify-write of their journal. */
async function transact(ctx: ActionContext, payload: any, fn: (tx: Tx, caller: Caller) => void): Promise<Outcome> {
  const caller = resolveCaller(ctx, payload);
  const store = getStore(ctx);
  await finishEarlierPublish(ctx, store, caller.key);
  const file: string = payload.file;
  const published = parser.parseThreadsFromContent(await ctx.readFile(file));
  const who = { key: caller.key, name: caller.name };
  const journal = await store.transact(caller.key, (j, at) =>
    fn({ j, at, file, view: overlay(published, j.ops, file, who) }, caller),
  );
  return { view: overlay(published, journal.ops, file, who) };
}

/** Dev mode writes author profiles straight to authors.json, as before. */
async function recordProfile(ctx: ActionContext, payload: any): Promise<void> {
  const profile = payloadProfile(payload);
  if (profile) await upsertAuthor(ctx, profile.key, profile.name, profile.avatarUrl);
}

export const actions: Record<string, (payload: any, ctx: ActionContext) => Promise<any>> = {
  'threads:get-authors': async (_payload, ctx): Promise<AuthorsMap> => readAuthors(ctx),

  'threads:upsert-author': async (payload, ctx): Promise<{ ok: boolean }> => {
    requireFields('threads:upsert-author', payload, ['authorKey', 'name']);
    const profile = profileFromPayload(payload);
    await upsertAuthor(ctx, profile.key, profile.name, profile.avatarUrl);
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

  /**
   * The caller's identity and journal. A caller with no journal file gets a
   * fresh, unsaved journal: its review id and timestamps are ephemeral and
   * change on every call until the first write.
   */
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
    guardWrite(ctx, payload, { rate: true, now: Date.now });
    await recordProfile(ctx, payload);
    const threadId = generateThreadId();
    const { view } = await transact(ctx, payload, (tx) =>
      push(tx, {
        kind: 'add-thread', file: tx.file, threadId, commentId: generateCommentId(),
        anchor: toAnchor(payload.anchor), body: payload.body,
      }),
    );
    return findThread(view, threadId);
  },

  'threads:add-comment': async (payload, ctx): Promise<Comment> => {
    requireFields('threads:add-comment', payload, ['file', 'threadId', 'author', 'body']);
    guardWrite(ctx, payload, { rate: true, now: Date.now });
    await recordProfile(ctx, payload);
    const commentId = generateCommentId();
    const { view } = await transact(ctx, payload, (tx) => {
      findThread(tx.view, payload.threadId);
      push(tx, {
        kind: 'add-comment', file: tx.file, threadId: payload.threadId, commentId,
        parentId: payload.parentId || null, body: payload.body,
      });
    });
    return findComment(findThread(view, payload.threadId), commentId);
  },

  'threads:edit-comment': async (payload, ctx): Promise<Comment> => {
    requireFields('threads:edit-comment', payload, ['file', 'threadId', 'commentId', 'body']);
    guardWrite(ctx, payload, { rate: false, now: Date.now });
    const { threadId, commentId, body } = payload;
    const { view } = await transact(ctx, payload, (tx) => {
      findComment(findThread(tx.view, threadId), commentId);
      const drafted = draftedCommentOp(tx, commentId);
      if (drafted) Object.assign(drafted, { body });
      else push(tx, { kind: 'edit-comment', file: tx.file, threadId, commentId, body });
    });
    return findComment(findThread(view, threadId), commentId);
  },

  'threads:delete-comment': async (payload, ctx): Promise<{ deleted: boolean }> => {
    requireFields('threads:delete-comment', payload, ['file', 'threadId', 'commentId']);
    const { threadId, commentId } = payload;
    await transact(ctx, payload, (tx) => {
      findComment(findThread(tx.view, threadId), commentId);
      const drafted = draftedCommentOp(tx, commentId);
      if (drafted?.kind === 'add-thread') {
        // The first comment of a drafted thread: the thread goes with it.
        drop(tx, opsOnThread(tx, threadId));
        return;
      }
      drop(tx, opsOnCommentTree(tx, commentId));
      if (!drafted) push(tx, { kind: 'delete-comment', file: tx.file, threadId, commentId });
    });
    return { deleted: true };
  },

  'threads:delete-thread': async (payload, ctx): Promise<{ deleted: boolean }> => {
    requireFields('threads:delete-thread', payload, ['file', 'threadId']);
    const { threadId } = payload;
    await transact(ctx, payload, (tx) => {
      findThread(tx.view, threadId);
      const drafted = draftedThreadOp(tx, threadId);
      drop(tx, opsOnThread(tx, threadId));
      if (!drafted) push(tx, { kind: 'delete-thread', file: tx.file, threadId });
    });
    return { deleted: true };
  },

  'threads:resolve-thread': async (payload, ctx): Promise<Thread> => {
    requireFields('threads:resolve-thread', payload, ['file', 'threadId']);
    const { threadId } = payload;
    const { view } = await transact(ctx, payload, (tx) => {
      findThread(tx.view, threadId);
      // A drafted thread has no resolved field to flip: a second toggle cancels the first.
      const pending = draftedThreadOp(tx, threadId)
        ? opsOnThread(tx, threadId).find((o) => o.kind === 'resolve-thread')
        : undefined;
      if (pending) drop(tx, [pending]);
      else push(tx, { kind: 'resolve-thread', file: tx.file, threadId });
    });
    return findThread(view, threadId);
  },

  'threads:toggle-reaction': async (payload, ctx): Promise<Reaction[]> => {
    requireFields('threads:toggle-reaction', payload, ['file', 'threadId', 'commentId', 'emoji']);
    const { threadId, commentId, emoji } = payload;
    const { view } = await transact(ctx, payload, (tx) => {
      findComment(findThread(tx.view, threadId), commentId);
      // On a drafted comment a second toggle of the same emoji cancels the first.
      const pending = draftedCommentOp(tx, commentId)
        ? opsOnComment(tx, commentId).find((o) => o.kind === 'toggle-reaction' && o.emoji === emoji)
        : undefined;
      if (pending) drop(tx, [pending]);
      else push(tx, { kind: 'toggle-reaction', file: tx.file, threadId, commentId, emoji });
    });
    return findComment(findThread(view, threadId), commentId).reactions;
  },

  /** Write the caller's journal into the markdown, record the manifest, reset the journal. */
  'threads:publish-review': async (payload, ctx): Promise<PublishResult> =>
    publish(resolveCaller(ctx, payload), ctx, parseReviewFields('threads:publish-review', payload), {
      store: getStore(ctx),
      sync: defaultSync(ctx),
    }),

  /** Title and summary of the caller's open review. */
  'threads:update-review': async (payload, ctx): Promise<Journal> =>
    getStore(ctx).setReview(resolveCaller(ctx, payload).key, parseReviewFields('threads:update-review', payload)),

  'threads:list-reviews': async (_payload, ctx): Promise<ReviewSummary[]> => (await listManifests(ctx)).map(summarize),
};
