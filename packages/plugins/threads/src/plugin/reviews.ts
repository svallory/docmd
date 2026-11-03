import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionContext } from '@docmd/api';
import * as parser from './parser.js';
import { ThreadsError } from './errors.js';
import { createLock, createNoGitSync, type Sync } from './lock.js';
import type { DraftStore } from './drafts.js';
import type { Caller, Comment, DraftOp, ManifestOp, PublishResult, ReviewManifest, ReviewSummary, Thread } from '../types.js';

const TITLE_MAX = 120;
const SUMMARY_MAX = 2000;

const day = (iso: string) => iso.slice(0, 10);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
}

export interface ApplyResult {
  content: string;
  applied: ManifestOp[];
  skipped: Array<{ opId: string; reason: string }>;
}

/** A quote line that parses as a container fence would corrupt the threads block on re-parse. */
const unsafeQuote = (quote: string) => quote.split('\n').some((l) => l.trim() === ':::' || l.trim().startsWith('::: '));

/** Wrap the first occurrence of `quote` in the body (above the threads block) as `==quote=={id}`. */
function wrapQuote(content: string, quote: string, threadId: string): string {
  const cut = content.indexOf('\n::: threads');
  const body = cut >= 0 ? content.slice(0, cut) : content;
  const rest = cut >= 0 ? content.slice(cut) : '';
  const at = body.indexOf(quote);
  if (at < 0) return content;
  return body.slice(0, at) + `==${quote}=={${threadId}}` + body.slice(at + quote.length) + rest;
}

const unwrapThread = (content: string, threadId: string) =>
  content.replace(new RegExp(`==((?:(?!==).)+)==\\{${escapeRe(threadId)}\\}`, 'g'), '$1');

/**
 * Apply one file's ops (in order) to its markdown. Ops whose target is gone are
 * skipped with a reason. `applied` carries `before` (what discard needs to
 * reverse the op), `quote` (add-thread) and `pageTitle`. Adding an id that
 * already exists is skipped, so replaying add/edit/delete ops is idempotent;
 * resolve and reaction ops are toggles and are not.
 */
export function applyOps(content: string, ops: DraftOp[], opts: ApplyOptions): ApplyResult {
  const threads: Thread[] = parser.parseThreadsFromContent(content);
  const pageTitle = pageTitleOf(content) ?? undefined;
  const applied: ManifestOp[] = [];
  const skipped: ApplyResult['skipped'] = [];
  let text = content;

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
        if (thread) { skip(op, `thread ${op.threadId} already exists`); break; }
        const quote = op.anchor?.quote;
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
        done(op, quote ? { quote } : {});
        break;
      }
      case 'add-comment': {
        if (!thread) { skip(op, `thread ${op.threadId} not found`); break; }
        if (comment(op.commentId)) { skip(op, `comment ${op.commentId} already exists`); break; }
        thread.comments.push({
          id: op.commentId, thread_id: op.threadId, parent_id: op.parentId, author: opts.authorName,
          date: day(op.at), edited_at: null, authorKey: opts.authorKey, reviewId: opts.reviewId,
          body: op.body, reactions: [],
        });
        done(op);
        break;
      }
      case 'edit-comment': {
        const c = comment(op.commentId);
        if (!c) { skip(op, thread ? `comment ${op.commentId} not found` : `thread ${op.threadId} not found`); break; }
        const before = { body: c.body, edited_at: c.edited_at };
        c.body = op.body;
        c.edited_at = day(op.at);
        done(op, { before });
        break;
      }
      case 'delete-comment': {
        const idx = thread ? thread.comments.findIndex((c) => c.id === op.commentId) : -1;
        if (!thread || idx < 0) { skip(op, thread ? `comment ${op.commentId} not found` : `thread ${op.threadId} not found`); break; }
        const [removed] = thread.comments.splice(idx, 1);
        done(op, { before: { comment: removed, index: idx } });
        break;
      }
      case 'delete-thread': {
        const idx = threads.findIndex((t) => t.id === op.threadId);
        if (idx < 0) { skip(op, `thread ${op.threadId} not found`); break; }
        const [removed] = threads.splice(idx, 1);
        text = unwrapThread(text, op.threadId);
        done(op, { before: { thread: removed, index: idx } });
        break;
      }
      case 'resolve-thread': {
        if (!thread) { skip(op, `thread ${op.threadId} not found`); break; }
        const before = { resolved: thread.resolved, resolved_by: thread.resolved_by, resolved_at: thread.resolved_at };
        if (thread.resolved) {
          thread.resolved = false; thread.resolved_by = null; thread.resolved_at = null;
        } else {
          thread.resolved = true; thread.resolved_by = opts.authorName; thread.resolved_at = day(op.at);
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
        if (!r) c.reactions.push({ emoji: op.emoji, authors: [opts.authorName] });
        else if (present) {
          r.authors = r.authors.filter((a) => a !== opts.authorName);
          if (!r.authors.length) c.reactions = c.reactions.filter((x) => x !== r);
        } else r.authors.push(opts.authorName);
        done(op, { before: { present } });
        break;
      }
    }
  }

  if (!applied.length) return { content, applied, skipped };
  return { content: parser.replaceThreadsBlock(text, threads), applied, skipped };
}

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

/** `<docsRoot>`: the project root joined with the configured docs source folder. */
export const docsRootOf = (ctx: ActionContext): string => path.join(ctx.projectRoot, ctx.config?.src || '');
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
    const journal = await store.load(caller.key);
    if (!journal.ops.length) throw new ThreadsError('empty-review', 'there is nothing to publish');
    const ops = journal.ops;
    const reviewId = journal.review.id;
    const files = [...new Set(ops.map((o) => o.file))];
    const order = new Map(ops.map((o, i) => [o.opId, i]));
    let skipped: PublishResult['skipped'] = [];

    await sync.publishWithRetry(
      async () => {
        const applied: ManifestOp[] = [];
        skipped = [];
        const titles: Record<string, string | null> = {};
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
          const result = applyOps(content, fileOps, { authorKey: caller.key, authorName: caller.name, reviewId });
          applied.push(...result.applied);
          skipped.push(...result.skipped);
          if (result.content !== content) await ctx.writeFile(file, result.content);
        }
        applied.sort((a, b) => order.get(a.opId)! - order.get(b.opId)!);

        const title = input.title ?? journal.review.title;
        const summary = input.summary ?? journal.review.summary;
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
      },
      { reviewId, authorKey: caller.key, authorName: caller.name, files },
    );

    // Drop what was published (ops added meanwhile stay) and start a fresh review.
    const published = new Set(ops.map((o) => o.opId));
    await store.transact(caller.key, (j, at) => {
      j.ops = j.ops.filter((o) => !published.has(o.opId));
      j.review = { id: newId('r-'), title: null, summary: null, createdAt: at, updatedAt: at };
    });
    return { reviewId, skipped };
  });
}
