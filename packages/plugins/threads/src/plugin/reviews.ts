import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionContext } from '@docmd/api';
import * as parser from './parser.js';
import { ThreadsError } from './errors.js';
import { markPattern, splitPage } from './marks.js';
import { authorsPath, readAuthorsRaw, writeAuthors } from './authors.js';
import { createLock, createNoGitSync, type Sync } from './lock.js';
import type { DraftStore } from './drafts.js';
import type { Caller, Comment, DraftOp, ManifestOp, PublishResult, ReviewManifest, ReviewSummary, Thread } from '../types.js';

const TITLE_MAX = 120;
const SUMMARY_MAX = 2000;

const day = (iso: string) => iso.slice(0, 10);
/** Kept (and exported) so units still merging that use it need no change. */
export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let tmpSeq = 0;

// ---------------------------------------------------------------------------
// Titles (A-7)
// ---------------------------------------------------------------------------

/** Page title: frontmatter `title:` if present, else the first `# ` heading, else null. */
export function pageTitleOf(content: string): string | null {
  const lines = content.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---');
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^title:\s*(.*)$/.exec(l);
        if (m) {
          const t = m[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
          if (t) return t;
        }
      }
      i = end + 1;
    }
  }
  for (; i < lines.length; i++) {
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

const oneLine = (s: string, max: number) => s.replace(/[\r\n]+/g, ' ').trim().slice(0, max);

/**
 * `Comments by <name>: <N> comment(s) on <first page title>[, +K page(s)]`.
 * N counts the comments a review adds (all ops when it adds none).
 * `pageTitles` maps a file to its page title; a file without one is named by its path.
 */
export function defaultTitle(name: string, ops: Array<Pick<DraftOp, 'kind' | 'file'>>, pageTitles: Record<string, string | null | undefined>): string {
  const added = ops.filter((o) => o.kind === 'add-thread' || o.kind === 'add-comment').length;
  const n = added || ops.length;
  const files = [...new Set(ops.map((o) => o.file))];
  const titleOf = (f: string) => pageTitles[f] || f;
  const extra = files.length - 1;
  const pages = extra > 0 ? `, +${extra} page${extra === 1 ? '' : 's'}` : '';
  const first = files.length ? titleOf(files[0]) : '';
  return oneLine(`Comments by ${name}: ${n} comment${n === 1 ? '' : 's'} on ${first}${pages}`, TITLE_MAX);
}

export const cleanTitle = (s: string) => oneLine(s, TITLE_MAX);
export const cleanSummary = (s: string) => s.slice(0, SUMMARY_MAX);

// ---------------------------------------------------------------------------
// Applying ops to one file's markdown (pure)
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  authorKey: string;
  authorName: string;
  reviewId: string;
  /** Desired end state per opId for resolve-thread (resolved) and toggle-reaction (present); see deriveTargets. */
  targets?: Record<string, boolean>;
}

export interface ApplyResult {
  content: string;
  applied: ManifestOp[];
  skipped: Array<{ opId: string; reason: string }>;
}

/** A quote line that parses as a container fence would corrupt the threads block on re-parse. */
const unsafeQuote = (quote: string) => quote.split('\n').some((l) => l.trim() === ':::' || l.trim().startsWith('::: '));

/**
 * Wrap the first occurrence of `quote` in the body (after the frontmatter, above the
 * threads block) as `==quote=={id}`, skipping occurrences that touch an existing mark.
 * No free occurrence: the content is returned unchanged (the anchor is still recorded).
 */
function wrapQuote(content: string, quote: string, threadId: string): string {
  const { body, rest } = splitPage(content);
  const from = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(body)?.[0].length ?? 0;
  const spans = [...body.matchAll(markPattern(undefined, 'g'))].map((m) => [m.index!, m.index! + m[0].length]);
  let at = body.indexOf(quote, from);
  while (at >= 0 && spans.some(([a, b]) => at < b && at + quote.length > a)) at = body.indexOf(quote, at + 1);
  if (at < 0) return content;
  return body.slice(0, at) + `==${quote}=={${threadId}}` + body.slice(at + quote.length) + rest;
}

/** Turn a thread's `==text=={id}` highlight back into plain text (the one definition; delete-thread and discard use it). */
export const unwrapThread = (content: string, threadId: string) =>
  content.replace(markPattern(threadId, 'g'), '$1');

/**
 * Turn the toggle ops of one file into desired end states, from the file as first read:
 * resolve-thread -> resolved, toggle-reaction -> the author is present. Ops are walked in
 * order, so a second toggle of the same target flips the first one's result. Passing the
 * result to applyOps makes a re-run a no-op.
 */
export function deriveTargets(content: string, ops: DraftOp[], authorName: string): Record<string, boolean> {
  const threads = parser.parseThreadsFromContent(content);
  const resolved = new Map(threads.map((t) => [t.id, t.resolved]));
  const present = new Map<string, boolean>();
  for (const t of threads)
    for (const c of t.comments)
      for (const r of c.reactions ?? []) present.set(`${t.id}\0${c.id}\0${r.emoji}`, r.authors.includes(authorName));
  const targets: Record<string, boolean> = {};
  for (const op of ops) {
    if (op.kind === 'resolve-thread') {
      targets[op.opId] = !(resolved.get(op.threadId) ?? false);
      resolved.set(op.threadId, targets[op.opId]);
    } else if (op.kind === 'toggle-reaction') {
      const key = `${op.threadId}\0${op.commentId}\0${op.emoji}`;
      targets[op.opId] = !(present.get(key) ?? false);
      present.set(key, targets[op.opId]);
    }
  }
  return targets;
}

/**
 * Apply one file's ops (in order) to its markdown. Ops whose target is gone are
 * skipped with a reason. `applied` carries `before` (what discard needs to
 * reverse the op), `quote` (add-thread) and `pageTitle`. Replaying is safe (C-16):
 * an add whose id already carries this review's id counts as applied, any other
 * existing id is skipped, and resolve/reaction ops set the state in `opts.targets`
 * instead of flipping it (without a target they flip).
 */
export function applyOps(content: string, ops: DraftOp[], opts: ApplyOptions): ApplyResult {
  const threads: Thread[] = parser.parseThreadsFromContent(content);
  const pageTitle = pageTitleOf(content) ?? undefined;
  const applied: ManifestOp[] = [];
  const skipped: ApplyResult['skipped'] = [];
  let text = content;
  let changed = false;

  const skip = (op: DraftOp, reason: string) => void skipped.push({ opId: op.opId, reason });
  const done = (op: DraftOp, extra: Partial<ManifestOp> = {}) => {
    const entry = { ...op, ...extra } as ManifestOp;
    if (pageTitle) entry.pageTitle = pageTitle;
    applied.push(entry);
  };

  for (const op of ops) {
    const thread = threads.find((t) => t.id === op.threadId);
    const comment = (id: string) => thread?.comments.find((c) => c.id === id);
    switch (op.kind) {
      case 'add-thread': {
        const quote = op.anchor?.quote;
        if (thread) {
          if (comment(op.commentId)?.reviewId === opts.reviewId) done(op, quote ? { quote } : {});
          else skip(op, `thread ${op.threadId} already exists`);
          break;
        }
        if (quote && unsafeQuote(quote)) { skip(op, 'anchor quote contains a container fence'); break; }
        const first: Comment = {
          id: op.commentId, thread_id: op.threadId, parent_id: null, author: opts.authorName,
          date: day(op.at), edited_at: null, authorKey: opts.authorKey, reviewId: opts.reviewId,
          body: op.body, reactions: [],
        };
        const t: Thread = { id: op.threadId, resolved: false, resolved_by: null, resolved_at: null, comments: [first] };
        if (quote) {
          t.anchor = { quote };
          text = wrapQuote(text, quote, op.threadId);
        }
        threads.push(t);
        changed = true;
        done(op, quote ? { quote } : {});
        break;
      }
      case 'add-comment': {
        if (!thread) { skip(op, `thread ${op.threadId} not found`); break; }
        const existing = comment(op.commentId);
        if (existing) {
          if (existing.reviewId === opts.reviewId) done(op);
          else skip(op, `comment ${op.commentId} already exists`);
          break;
        }
        thread.comments.push({
          id: op.commentId, thread_id: op.threadId, parent_id: op.parentId, author: opts.authorName,
          date: day(op.at), edited_at: null, authorKey: opts.authorKey, reviewId: opts.reviewId,
          body: op.body, reactions: [],
        });
        changed = true;
        done(op);
        break;
      }
      case 'edit-comment': {
        const c = comment(op.commentId);
        if (!c) { skip(op, thread ? `comment ${op.commentId} not found` : `thread ${op.threadId} not found`); break; }
        const before = { body: c.body, edited_at: c.edited_at };
        c.body = op.body;
        c.edited_at = day(op.at);
        changed = true;
        done(op, { before });
        break;
      }
      case 'delete-comment': {
        const idx = thread ? thread.comments.findIndex((c) => c.id === op.commentId) : -1;
        if (!thread || idx < 0) { skip(op, thread ? `comment ${op.commentId} not found` : `thread ${op.threadId} not found`); break; }
        const [removed] = thread.comments.splice(idx, 1);
        changed = true;
        done(op, { before: { comment: removed, index: idx } });
        break;
      }
      case 'delete-thread': {
        const idx = threads.findIndex((t) => t.id === op.threadId);
        if (idx < 0) { skip(op, `thread ${op.threadId} not found`); break; }
        const [removed] = threads.splice(idx, 1);
        text = unwrapThread(text, op.threadId);
        changed = true;
        done(op, { before: { thread: removed, index: idx } });
        break;
      }
      case 'resolve-thread': {
        if (!thread) { skip(op, `thread ${op.threadId} not found`); break; }
        const before = { resolved: thread.resolved, resolved_by: thread.resolved_by, resolved_at: thread.resolved_at };
        const want = opts.targets?.[op.opId] ?? !thread.resolved;
        if (want && !thread.resolved) {
          thread.resolved = true; thread.resolved_by = opts.authorName; thread.resolved_at = day(op.at);
          changed = true;
        } else if (!want && thread.resolved) {
          thread.resolved = false; thread.resolved_by = null; thread.resolved_at = null;
          changed = true;
        }
        done(op, { before });
        break;
      }
      case 'toggle-reaction': {
        const c = comment(op.commentId);
        if (!c) { skip(op, thread ? `comment ${op.commentId} not found` : `thread ${op.threadId} not found`); break; }
        c.reactions ??= [];
        const r = c.reactions.find((x) => x.emoji === op.emoji);
        const present = !!r && r.authors.includes(opts.authorName);
        const want = opts.targets?.[op.opId] ?? !present;
        if (want && !present) {
          if (r) r.authors.push(opts.authorName);
          else c.reactions.push({ emoji: op.emoji, authors: [opts.authorName] });
          changed = true;
        } else if (!want && present) {
          r!.authors = r!.authors.filter((a) => a !== opts.authorName);
          if (!r!.authors.length) c.reactions = c.reactions.filter((x) => x !== r);
          changed = true;
        }
        done(op, { before: { present } });
        break;
      }
    }
  }

  if (!changed) return { content, applied, skipped };
  return { content: parser.replaceThreadsBlock(text, threads), applied, skipped };
}

export interface ReverseResult {
  content: string;
  skipped: Array<{ opId: string; reason: string }>;
}

/**
 * Reverse one file's published ops (newest first) from the `before` states the manifest
 * recorded. Ops whose target is gone are skipped with a reason. Idempotent (C-16): a second
 * run changes nothing, because every step sets a state (removes an id, restores a value,
 * inserts only when absent) rather than flipping one. `authorName` is the review author's
 * display name: reactions are stored by name and a manifest op does not carry it.
 */
export function reverseOps(content: string, manifestOps: ManifestOp[], opts: { authorName: string }): ReverseResult {
  const threads: Thread[] = parser.parseThreadsFromContent(content);
  const skipped: ReverseResult['skipped'] = [];
  let text = content;
  let changed = false;

  for (const op of [...manifestOps].reverse()) {
    const skip = (reason: string) => void skipped.push({ opId: op.opId, reason });
    const thread = threads.find((t) => t.id === op.threadId);
    const before = op.before as any;
    const needThread = () => { if (!thread) skip(`thread ${op.threadId} not found`); return thread; };
    switch (op.kind) {
      case 'add-thread': {
        if (!thread) { skip(`thread ${op.threadId} not found`); break; }
        threads.splice(threads.indexOf(thread), 1);
        text = unwrapThread(text, op.threadId);
        changed = true;
        break;
      }
      case 'add-comment': {
        const t = needThread();
        if (!t) break;
        const idx = t.comments.findIndex((c) => c.id === op.commentId);
        if (idx < 0) { skip(`comment ${op.commentId} not found`); break; }
        const [gone] = t.comments.splice(idx, 1);
        for (const c of t.comments) if (c.parent_id === gone.id) c.parent_id = gone.parent_id;
        changed = true;
        break;
      }
      case 'edit-comment': {
        const t = needThread();
        if (!t) break;
        const c = t.comments.find((x) => x.id === op.commentId);
        if (!c) { skip(`comment ${op.commentId} not found`); break; }
        if (!before) { skip('no recorded before-state'); break; }
        if (c.body !== before.body || c.edited_at !== before.edited_at) changed = true;
        c.body = before.body;
        c.edited_at = before.edited_at;
        break;
      }
      case 'delete-comment': {
        const t = needThread();
        if (!t) break;
        if (!before?.comment) { skip('no recorded before-state'); break; }
        if (t.comments.some((c) => c.id === op.commentId)) break;
        t.comments.splice(Math.min(before.index, t.comments.length), 0, before.comment);
        changed = true;
        break;
      }
      case 'delete-thread': {
        if (!before?.thread) { skip('no recorded before-state'); break; }
        if (thread) break;
        const restored: Thread = before.thread;
        threads.splice(Math.min(before.index, threads.length), 0, restored);
        if (restored.anchor?.quote && !unsafeQuote(restored.anchor.quote)) text = wrapQuote(text, restored.anchor.quote, restored.id);
        changed = true;
        break;
      }
      case 'resolve-thread': {
        const t = needThread();
        if (!t) break;
        if (!before) { skip('no recorded before-state'); break; }
        if (t.resolved !== before.resolved || t.resolved_by !== before.resolved_by || t.resolved_at !== before.resolved_at) changed = true;
        t.resolved = before.resolved;
        t.resolved_by = before.resolved_by;
        t.resolved_at = before.resolved_at;
        break;
      }
      case 'toggle-reaction': {
        const t = needThread();
        if (!t) break;
        const c = t.comments.find((x) => x.id === op.commentId);
        if (!c) { skip(`comment ${op.commentId} not found`); break; }
        if (typeof before?.present !== 'boolean') { skip('no recorded before-state'); break; }
        c.reactions ??= [];
        const r = c.reactions.find((x) => x.emoji === op.emoji);
        const present = !!r && r.authors.includes(opts.authorName);
        if (present === before.present) break;
        if (before.present) {
          if (r) r.authors.push(opts.authorName);
          else c.reactions.push({ emoji: op.emoji, authors: [opts.authorName] });
        } else {
          r!.authors = r!.authors.filter((a) => a !== opts.authorName);
          if (!r!.authors.length) c.reactions = c.reactions.filter((x) => x !== r);
        }
        changed = true;
        break;
      }
    }
  }

  if (!changed) return { content, skipped };
  return { content: parser.replaceThreadsBlock(text, threads), skipped };
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

/** `<docsRoot>`: the project root joined with the configured docs source folder. */
const docsRootOf = (ctx: ActionContext): string => path.join(ctx.projectRoot, ctx.config?.src || '');
const reviewsDir = (ctx: ActionContext) => path.join(docsRootOf(ctx), '.threads', 'reviews');

export async function writeManifest(ctx: ActionContext, manifest: ReviewManifest): Promise<void> {
  const dir = reviewsDir(ctx);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${manifest.id}.json`);
  const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n');
  await fs.promises.rename(tmp, file);
}

/** The manifest, or null when there is none (or it is not a v1 manifest). */
export async function readManifest(ctx: ActionContext, id: string): Promise<ReviewManifest | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(reviewsDir(ctx), `${path.basename(id)}.json`), 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const m = JSON.parse(text);
    return m && m.version === 1 && typeof m.id === 'string' && Array.isArray(m.ops) ? (m as ReviewManifest) : null;
  } catch {
    return null;
  }
}

/** Every readable manifest, newest `publishedAt` first. */
export async function listManifests(ctx: ActionContext): Promise<ReviewManifest[]> {
  let names: string[];
  try {
    names = await fs.promises.readdir(reviewsDir(ctx));
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const all = await Promise.all(names.filter((n) => n.endsWith('.json')).map((n) => readManifest(ctx, n.slice(0, -5))));
  return all
    .filter((m): m is ReviewManifest => m !== null)
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
}

export const summarize = (m: ReviewManifest): ReviewSummary => ({
  id: m.id,
  authorKey: m.authorKey,
  authorName: m.authorName,
  title: m.title,
  publishedAt: m.publishedAt,
  state: m.state,
  ops: m.ops.map((o) => ({ file: o.file, threadId: o.threadId, quote: o.quote ?? null, pageTitle: o.pageTitle ?? null })),
});

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * Write every changed file, then run `finalWrite` (the manifest). A failure puts the files
 * already written back; files that cannot be restored are named in a `threads/invalid` error.
 */
async function writeAllOrNothing(
  ctx: ActionContext,
  results: Array<{ file: string; original: string; next: string }>,
  finalWrite: () => Promise<void>,
  label: 'publish' | 'discard',
  /** An extra write that lands after the files and before `finalWrite`; returns its undo, which runs first on failure. */
  beforeFinal?: () => Promise<() => Promise<void>>,
): Promise<void> {
  const written: typeof results = [];
  let undoExtra: (() => Promise<void>) | undefined;
  try {
    for (const r of results) {
      if (r.next === r.original) continue;
      written.push(r);
      await ctx.writeFile(r.file, r.next);
    }
    if (beforeFinal) undoExtra = await beforeFinal();
    await finalWrite();
  } catch (e) {
    const stuck: string[] = [];
    if (undoExtra) {
      try {
        await undoExtra();
      } catch {
        stuck.push(profileFileOf(ctx));
      }
    }
    for (const r of written.reverse()) {
      try {
        await ctx.writeFile(r.file, r.original);
      } catch {
        stuck.push(r.file);
      }
    }
    if (stuck.length) {
      throw new ThreadsError(
        'invalid',
        `${label} failed (${e instanceof Error ? e.message : String(e)}) and these files could not be restored, check them: ${stuck.join(', ')}`,
        { cause: e },
      );
    }
    throw e;
  }
}

export interface PublishDeps {
  store: DraftStore;
  sync: Sync;
  now?: () => number;
  newId?: (prefix: string) => string;
}

/** One sync (and so one lock) per docs root, so every caller's publish queues behind the same chain. */
const syncs = new Map<string, Sync>();
export function defaultSync(ctx: ActionContext): Sync {
  const root = docsRootOf(ctx);
  let sync = syncs.get(root);
  if (!sync) syncs.set(root, (sync = createNoGitSync(createLock())));
  return sync;
}

/** Drop a published profile from the journal, unless the caller edited it again meanwhile. */
/** `authors.json` as the sync is told about it: relative to the project root, like a target file. */
const profileFileOf = (ctx: ActionContext): string => path.relative(ctx.projectRoot, authorsPath(ctx));

/** Set `authors.json[key]`; returns the function that puts the file back as it was. */
async function writeProfile(ctx: ActionContext, key: string, profile: { name: string; avatarUrl: string }): Promise<() => Promise<void>> {
  const before = await readAuthorsRaw(ctx);
  await writeAuthors(ctx, { ...(before === null ? {} : JSON.parse(before)), [key]: profile });
  return async () => {
    if (before === null) await fs.promises.rm(authorsPath(ctx), { force: true });
    else await fs.promises.writeFile(authorsPath(ctx), before);
  };
}

const clearProfile = (store: DraftStore, key: string, profile: { name: string; avatarUrl: string }) =>
  store.transact(key, (j) => {
    if (j.profile && j.profile.name === profile.name && j.profile.avatarUrl === profile.avatarUrl) delete j.profile;
  });

/**
 * Write the caller's journal into the markdown files it targets, record the
 * review manifest, and reset the journal. Under the sync's lock; `apply` runs
 * inside `publishWithRetry` and starts from scratch each time it is called.
 */
export async function publish(
  caller: Caller,
  ctx: ActionContext,
  input: { title?: string | null; summary?: string | null },
  { store, sync, now = Date.now, newId = (prefix) => prefix + crypto.randomBytes(4).toString('hex') }: PublishDeps,
): Promise<PublishResult> {
  return sync.withLock(async () => {
    // The journal's review was published, then discarded, but its reset never finished: finish it
    // now so only ops drafted since are published (under the new id), never the discarded ones.
    const stale = await readManifest(ctx, (await store.load(caller.key)).review.id);
    if (stale?.state === 'discarded') await finishEarlierPublish(ctx, store, caller.key, newId);
    const journal = await store.load(caller.key);
    if (!journal.ops.length) {
      if (!journal.profile) throw new ThreadsError('empty-review', 'there is nothing to publish');
      // A profile edit alone: authors.json is the whole publish, with no review or manifest.
      const profile = journal.profile;
      await sync.publishWithRetry(
        async () => void (await writeProfile(ctx, caller.key, profile)),
        { reviewId: journal.review.id, authorKey: caller.key, authorName: caller.name, files: [profileFileOf(ctx)] },
      );
      await clearProfile(store, caller.key, journal.profile);
      return { reviewId: journal.review.id, skipped: [] };
    }
    const ops = journal.ops;
    const reviewId = journal.review.id;
    const files = [...new Set(ops.map((o) => o.file))];
    const order = new Map(ops.map((o, i) => [o.opId, i]));
    let skipped: PublishResult['skipped'] = [];

    // An earlier publish of this review wrote its files and manifest but failed to reset the
    // journal: do not apply again (toggles would flip back), only finish the reset.
    const earlier = await readManifest(ctx, reviewId);
    // Toggle targets come from the first read of each file and are reused by any retry of apply.
    const targetsByFile = new Map<string, Record<string, boolean>>();

    if (earlier) skipped = earlier.skipped;
    else await sync.publishWithRetry(
      async () => {
        const applied: ManifestOp[] = [];
        skipped = [];
        const titles: Record<string, string | null> = {};
        const results: Array<{ file: string; original: string; next: string }> = [];
        for (const file of files) {
          const fileOps = ops.filter((o) => o.file === file);
          let content: string;
          try {
            content = await ctx.readFile(file);
          } catch {
            for (const o of fileOps) skipped.push({ opId: o.opId, reason: `file ${file} not readable` });
            continue;
          }
          titles[file] = pageTitleOf(content);
          if (!targetsByFile.has(file)) targetsByFile.set(file, deriveTargets(content, fileOps, caller.name));
          const targets = targetsByFile.get(file)!;
          const result = applyOps(content, fileOps, { authorKey: caller.key, authorName: caller.name, reviewId, targets });
          applied.push(...result.applied);
          skipped.push(...result.skipped);
          results.push({ file, original: content, next: result.content });
        }
        applied.sort((a, b) => order.get(a.opId)! - order.get(b.opId)!);

        await writeAllOrNothing(ctx, results, async () => {
          const title = 'title' in input ? input.title : journal.review.title;
          const summary = 'summary' in input ? input.summary : journal.review.summary;
          await writeManifest(ctx, {
            version: 1,
            id: reviewId,
            authorKey: caller.key,
            authorName: caller.name,
            title: cleanTitle(title || defaultTitle(caller.name, ops, titles)),
            summary: summary ? cleanSummary(summary) : null,
            state: 'published',
            publishedAt: new Date(now()).toISOString(),
            ops: applied,
            skipped,
          });
        }, 'publish', journal.profile ? () => writeProfile(ctx, caller.key, journal.profile!) : undefined);
      },
      { reviewId, authorKey: caller.key, authorName: caller.name, files: journal.profile ? [...files, profileFileOf(ctx)] : files },
    );

    // Drop what was published (ops added meanwhile stay) and start a fresh review.
    if (earlier) await finishEarlierPublish(ctx, store, caller.key, newId);
    else {
      const published = new Set(ops.map((o) => o.opId));
      await store.transact(caller.key, (j, at) => {
        j.ops = j.ops.filter((o) => !published.has(o.opId));
        j.review = { id: newId('r-'), title: null, summary: null, createdAt: at, updatedAt: at };
      });
    }
    // Written with the files above; drop it from the journal. On the earlier-published path apply
    // did not run, so the profile (maybe edited since) stays for the next publish.
    if (journal.profile && earlier?.state !== 'published') await clearProfile(store, caller.key, journal.profile);
    return { reviewId, skipped };
  });
}

/**
 * Finish a publish whose files and manifest were written but whose journal reset failed:
 * drop the ops the manifest recorded (applied and skipped) and rotate the review id, so
 * ops still in the journal stand for what is really pending and later edits of the
 * published comments become real edit/delete ops. A no-op when the journal's review has no
 * manifest; finishes the reset for a published or discarded one (a discard must not let the old ops be applied again).
 */
export async function finishEarlierPublish(
  ctx: ActionContext,
  store: DraftStore,
  key: string,
  newId: (prefix: string) => string = (prefix) => prefix + crypto.randomBytes(4).toString('hex'),
): Promise<void> {
  const manifest = await readManifest(ctx, (await store.load(key)).review.id);
  if (!manifest) return;
  const done = new Set([...manifest.ops.map((o) => o.opId), ...manifest.skipped.map((x) => x.opId)]);
  await store.transact(key, (j, at) => {
    if (j.review.id !== manifest.id) return;
    j.ops = j.ops.filter((o) => !done.has(o.opId));
    j.review = { id: newId('r-'), title: null, summary: null, createdAt: at, updatedAt: at };
  });
}

// ---------------------------------------------------------------------------
// Discard
// ---------------------------------------------------------------------------

export interface DiscardDeps {
  store: DraftStore;
  sync: Sync;
  now?: () => number;
}

/**
 * Take a review back. A published review is reversed from its manifest as a forward change
 * (files first, all or nothing, then the manifest is marked `discarded`); the caller's own
 * open review is only emptied. Runs under the sync's lock, the file work inside
 * `publishWithRetry`, like `publish`.
 */
export async function discard(
  caller: Caller,
  ctx: ActionContext,
  reviewId: string,
  { store, sync, now = Date.now }: DiscardDeps,
): Promise<{ discarded: true }> {
  return sync.withLock(async () => {
    const manifest = await readManifest(ctx, reviewId);
    if (!manifest) {
      const journal = await store.load(caller.key);
      if (journal.review.id !== reviewId) throw new ThreadsError('not-found', `review ${reviewId} not found`);
      await store.transact(caller.key, (j) => {
        if (j.review.id === reviewId) j.ops = [];
      });
      return { discarded: true } as const;
    }
    if (manifest.state === 'discarded') throw new ThreadsError('invalid', `review ${reviewId} is already discarded`);

    const files = [...new Set(manifest.ops.map((o) => o.file))];
    await sync.publishWithRetry(
      async () => {
        const discardSkipped: Array<{ opId: string; reason: string }> = [];
        const results: Array<{ file: string; original: string; next: string }> = [];
        for (const file of files) {
          const fileOps = manifest.ops.filter((o) => o.file === file);
          let content: string;
          try {
            content = await ctx.readFile(file);
          } catch {
            for (const o of fileOps) discardSkipped.push({ opId: o.opId, reason: `file ${file} not readable` });
            continue;
          }
          const result = reverseOps(content, fileOps, { authorName: manifest.authorName });
          discardSkipped.push(...result.skipped);
          results.push({ file, original: content, next: result.content });
        }

        await writeAllOrNothing(ctx, results, () => writeManifest(ctx, {
          ...manifest,
          state: 'discarded',
          discardedAt: new Date(now()).toISOString(),
          discardedBy: caller.key,
          discardSkipped,
        }), 'discard');
      },
      { reviewId, authorKey: caller.key, authorName: caller.name, files },
    );
    return { discarded: true } as const;
  });
}

/** Optional `title` / `summary` (string or null) of a review payload, capped; absent keys stay absent. */
export function parseReviewFields(action: string, payload: any): { title?: string | null; summary?: string | null } {
  const out: { title?: string | null; summary?: string | null } = {};
  for (const [field, clean] of [['title', cleanTitle], ['summary', cleanSummary]] as const) {
    const v = payload?.[field];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string') throw new ThreadsError('invalid', `${action}: ${field} must be a string`);
    out[field] = v === null ? null : clean(v);
  }
  return out;
}
