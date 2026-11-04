import crypto from 'node:crypto';
import path from 'node:path';
import type { ActionContext } from '@docmd/api';
import * as parser from './parser.js';
import { ThreadsError } from './errors.js';
import { getOptions } from './config.js';
import { createDraftStore, makeOp, type DraftStore } from './drafts.js';
import { guardWrite } from './limits.js';
import { overlay } from './overlay.js';
import { countOrphanedBy, fsOrphanScanDeps, markOrphans } from './orphans.js';
import { readAuthors, writeAuthors } from './authors.js';
import { findCaller, headerProfile, payloadProfile, profileFromPayload, resolveCaller } from './identity.js';
import { assertCan } from './permissions.js';
import { getSync, discard, finishEarlierPublish, listManifests, readManifest, parseReviewFields, publish, summarize } from './reviews.js';
import type { AuthorsMap, Thread, Comment, Reaction, Anchor, Caller, DraftOp, Journal, DraftMode, NewDraftOp, WhoAmI, PublishResult, ReviewSummary } from '../types.js';

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

/**
 * Resolve the caller of a write, then validate the payload. Where the payload is
 * the identity source (dev) fields are validated first, as before; where it is
 * not (a header, or serve), identity comes first so an unauthenticated call never
 * reaches validation. `author` is only required from a payload caller.
 */
async function begin(ctx: ActionContext, payload: any, action: string, fields: string[]): Promise<Caller> {
  const trusted = !!getOptions(ctx).identityHeader || ctx.mode === 'serve';
  if (!trusted) requireFields(action, payload, fields);
  const caller = await resolveCaller(ctx, payload, { write: true });
  if (trusted) requireFields(action, payload, fields.filter((f) => f !== 'author'));
  return caller;
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
async function transact(ctx: ActionContext, caller: Caller, payload: any, fn: (tx: Tx, caller: Caller) => void): Promise<Outcome> {
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

/** Dev mode writes author profiles straight to authors.json, as before; a header caller's profile goes through the journal. */
async function recordProfile(ctx: ActionContext, caller: Caller, payload: any): Promise<void> {
  if (caller.source !== 'payload') return;
  const profile = payloadProfile(payload);
  if (profile) await upsertAuthor(ctx, profile.key, profile.name, profile.avatarUrl);
}

export const actions: Record<string, (payload: any, ctx: ActionContext) => Promise<any>> = {
  'threads:get-authors': async (_payload, ctx): Promise<AuthorsMap> => readAuthors(ctx),

  'threads:upsert-author': async (payload, ctx): Promise<{ ok: boolean }> => {
    const caller = await begin(ctx, payload, 'threads:upsert-author', getOptions(ctx).identityHeader ? ['name'] : ['authorKey', 'name']);
    assertCan(caller, 'upsert-author', { authorKey: payload.authorKey }, getOptions(ctx).permissions);
    if (caller.source === 'header') {
      // The key is the trusted header; the profile waits in the journal until publish.
      await getStore(ctx).transact(caller.key, (j) => {
        j.profile = headerProfile(payload, caller);
      });
      return { ok: true };
    }
    const profile = profileFromPayload(payload);
    await upsertAuthor(ctx, profile.key, profile.name, profile.avatarUrl);
    return { ok: true };
  },

  /** Published threads plus the caller's own drafts. */
  'threads:get-threads': async (payload, ctx): Promise<Thread[]> => {
    requireFields('threads:get-threads', payload, ['file']);
    const content = await ctx.readFile(payload.file);
    const published = markOrphans(content, parser.parseThreadsFromContent(content));
    const caller = await findCaller(ctx, payload);
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
    const identity = await findCaller(ctx, payload);
    if (!identity) return { identity: null, journal: null, orphanedMine: 0 };
    const docsRoot = path.join(ctx.projectRoot, ctx.config?.src || '');
    return {
      identity,
      journal: await getStore(ctx).load(identity.key),
      // A secondary counter: an unreadable file or directory must not cost the caller identity and journal.
      orphanedMine: await countOrphanedBy(docsRoot, identity.key, fsOrphanScanDeps).catch(() => 0),
    };
  },

  'threads:set-mode': async (payload, ctx): Promise<Journal> => {
    if (payload?.mode !== 'auto' && payload?.mode !== 'collect') {
      throw new ThreadsError('invalid', "threads:set-mode: mode must be 'auto' or 'collect'");
    }
    const caller = await resolveCaller(ctx, payload, { write: true });
    return getStore(ctx).setMode(caller.key, payload.mode);
  },

  'threads:add-thread': async (payload, ctx): Promise<Thread> => {
    const caller = await begin(ctx, payload, 'threads:add-thread', ['file', 'author', 'body']);
    guardWrite(ctx, payload, caller, { rate: true, now: () => Date.now() });
    await recordProfile(ctx, caller, payload);
    const threadId = generateThreadId();
    const { view } = await transact(ctx, caller, payload, (tx) =>
      push(tx, {
        kind: 'add-thread', file: tx.file, threadId, commentId: generateCommentId(),
        anchor: toAnchor(payload.anchor), body: payload.body,
      }),
    );
    return findThread(view, threadId);
  },

  'threads:add-comment': async (payload, ctx): Promise<Comment> => {
    const caller = await begin(ctx, payload, 'threads:add-comment', ['file', 'threadId', 'author', 'body']);
    guardWrite(ctx, payload, caller, { rate: true, now: () => Date.now() });
    await recordProfile(ctx, caller, payload);
    const commentId = generateCommentId();
    const { view } = await transact(ctx, caller, payload, (tx) => {
      findThread(tx.view, payload.threadId);
      push(tx, {
        kind: 'add-comment', file: tx.file, threadId: payload.threadId, commentId,
        parentId: payload.parentId || null, body: payload.body,
      });
    });
    return findComment(findThread(view, payload.threadId), commentId);
  },

  'threads:edit-comment': async (payload, ctx): Promise<Comment> => {
    const caller = await begin(ctx, payload, 'threads:edit-comment', ['file', 'threadId', 'commentId', 'body']);
    guardWrite(ctx, payload, caller, { rate: false, now: () => Date.now() });
    const { threadId, commentId, body } = payload;
    const { view } = await transact(ctx, caller, payload, (tx) => {
      const target = findComment(findThread(tx.view, threadId), commentId);
      assertCan(caller, 'edit-comment', { authorKey: target.authorKey, drafted: target.draft }, getOptions(ctx).permissions);
      const drafted = draftedCommentOp(tx, commentId);
      if (drafted) Object.assign(drafted, { body });
      else push(tx, { kind: 'edit-comment', file: tx.file, threadId, commentId, body });
    });
    return findComment(findThread(view, threadId), commentId);
  },

  'threads:delete-comment': async (payload, ctx): Promise<{ deleted: boolean }> => {
    const caller = await begin(ctx, payload, 'threads:delete-comment', ['file', 'threadId', 'commentId']);
    const { threadId, commentId } = payload;
    await transact(ctx, caller, payload, (tx) => {
      const thread = findThread(tx.view, threadId);
      const target = findComment(thread, commentId);
      // The opening comment of a thread that has replies: admin only, and the whole thread goes (nothing records an opener once it is spliced out).
      const wholeThread = !target.draft && thread.comments.length > 1 && thread.comments[0].id === commentId;
      assertCan(caller, 'delete-comment', { authorKey: wholeThread ? null : target.authorKey, drafted: target.draft }, getOptions(ctx).permissions);
      if (wholeThread) {
        drop(tx, opsOnThread(tx, threadId));
        push(tx, { kind: 'delete-thread', file: tx.file, threadId });
        return;
      }
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
    const caller = await begin(ctx, payload, 'threads:delete-thread', ['file', 'threadId']);
    const { threadId } = payload;
    await transact(ctx, caller, payload, (tx) => {
      const thread = findThread(tx.view, threadId);
      assertCan(caller, 'delete-thread', { authorKeys: thread.comments.filter((c) => !c.draft).map((c) => c.authorKey) }, getOptions(ctx).permissions);
      const drafted = draftedThreadOp(tx, threadId);
      drop(tx, opsOnThread(tx, threadId));
      if (!drafted) push(tx, { kind: 'delete-thread', file: tx.file, threadId });
    });
    return { deleted: true };
  },

  'threads:resolve-thread': async (payload, ctx): Promise<Thread> => {
    const caller = await begin(ctx, payload, 'threads:resolve-thread', ['file', 'threadId']);
    const { threadId } = payload;
    const { view } = await transact(ctx, caller, payload, (tx) => {
      const thread = findThread(tx.view, threadId);
      assertCan(caller, 'resolve-thread', { threadAuthor: thread.comments[0]?.authorKey, drafted: thread.draft }, getOptions(ctx).permissions);
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
    const caller = await begin(ctx, payload, 'threads:toggle-reaction', ['file', 'threadId', 'commentId', 'emoji']);
    const { threadId, commentId, emoji } = payload;
    const { view } = await transact(ctx, caller, payload, (tx) => {
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
    publish(await resolveCaller(ctx, payload, { write: true }), ctx, parseReviewFields('threads:publish-review', payload), {
      store: getStore(ctx),
      sync: getSync(ctx),
    }),

  /** Title and summary of the caller's open review. */
  'threads:update-review': async (payload, ctx): Promise<Journal> =>
    getStore(ctx).setReview((await resolveCaller(ctx, payload, { write: true })).key, parseReviewFields('threads:update-review', payload)),

  'threads:list-reviews': async (_payload, ctx): Promise<ReviewSummary[]> => (await listManifests(ctx)).map(summarize),

  /** Take a review back: reverse a published one from its manifest, or empty the caller's open one. */
  'threads:discard-review': async (payload, ctx): Promise<{ discarded: true }> => {
    const caller = await begin(ctx, payload, 'threads:discard-review', ['reviewId']);
    const manifest = await readManifest(ctx, payload.reviewId);
    assertCan(caller, 'discard-review', { reviewAuthor: manifest ? (manifest.authorKey ?? null) : caller.key }, getOptions(ctx).permissions);
    return discard(caller, ctx, payload.reviewId, { store: getStore(ctx), sync: getSync(ctx) });
  },
};
