import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ThreadsError } from './errors.js';
import type { DraftMode, DraftOp, Journal, NewDraftOp } from '../types.js';

export interface DraftStore {
  /** The caller's journal; a fresh (unsaved) one when none exists. */
  load(key: string): Promise<Journal>;
  /** Append an op (the store assigns `opId` and `at`). */
  append(key: string, op: NewDraftOp): Promise<Journal>;
  /** Merge fields into an existing op, selected by `patch.opId`. */
  update(key: string, patch: { opId: string } & Record<string, unknown>): Promise<Journal>;
  removeOp(key: string, opId: string | string[]): Promise<Journal>;
  /** Delete the journal (after publish or discard). */
  clear(key: string): Promise<void>;
  setMode(key: string, mode: DraftMode): Promise<Journal>;
  setReview(key: string, review: { title?: string | null; summary?: string | null }): Promise<Journal>;
}

export interface DraftStoreOptions {
  /** Clock, epoch ms. */
  now?: () => number;
  /** Mode of a new journal. */
  defaultMode?: DraftMode;
}

/** File name stem for a key. */
export const slug = (key: string): string => encodeURIComponent(key).replace(/%/g, '_');

const hex = (prefix: string) => prefix + crypto.randomBytes(4).toString('hex');

export function createDraftStore(
  docsRoot: string,
  { now = Date.now, defaultMode = 'collect' }: DraftStoreOptions = {},
): DraftStore {
  const dir = path.join(docsRoot, '.threads', 'drafts');
  const fileOf = (key: string) => path.join(dir, `${slug(key)}.json`);
  const iso = () => new Date(now()).toISOString();

  // One queue per store: read-modify-write cycles never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const fresh = (key: string): Journal => {
    const at = iso();
    return {
      version: 1,
      authorKey: key,
      mode: defaultMode,
      review: { id: hex('r-'), title: null, summary: null, createdAt: at, updatedAt: at },
      ops: [],
    };
  };

  async function read(key: string): Promise<Journal> {
    const file = fileOf(key);
    let text: string;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch (e: any) {
      if (e.code === 'ENOENT') return fresh(key);
      throw e;
    }
    try {
      const j = JSON.parse(text);
      if (j && j.version === 1 && Array.isArray(j.ops) && j.review && typeof j.review === 'object') return j as Journal;
    } catch {
      // fall through: corrupt
    }
    await fs.promises.rename(file, `${file}.corrupt-${now()}`);
    return fresh(key);
  }

  async function write(key: string, journal: Journal): Promise<void> {
    await fs.promises.mkdir(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    try {
      await fs.promises.writeFile(ignore, '*\n!.gitignore\n', { flag: 'wx' });
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
    }
    const file = fileOf(key);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(journal, null, 2) + '\n');
    await fs.promises.rename(tmp, file);
  }

  /** Read, change, stamp `review.updatedAt`, save. */
  const mutate = (key: string, fn: (j: Journal, at: string) => void): Promise<Journal> =>
    locked(async () => {
      const journal = await read(key);
      const at = iso();
      fn(journal, at);
      journal.review.updatedAt = at;
      await write(key, journal);
      return journal;
    });

  return {
    load: (key) => locked(() => read(key)),
    append: (key, op) =>
      mutate(key, (j, at) => {
        j.ops.push({ ...op, opId: hex('o-'), at } as DraftOp);
      }),
    update: (key, patch) =>
      mutate(key, (j) => {
        const op = j.ops.find((o) => o.opId === patch.opId);
        if (!op) throw new ThreadsError('not-found', `Draft operation not found: ${patch.opId}`);
        const { opId: _id, kind: _kind, at: _at, ...fields } = patch as Record<string, unknown>;
        Object.assign(op, fields);
      }),
    removeOp: (key, opId) =>
      mutate(key, (j) => {
        const ids = new Set(Array.isArray(opId) ? opId : [opId]);
        j.ops = j.ops.filter((o) => !ids.has(o.opId));
      }),
    clear: (key) =>
      locked(async () => {
        try {
          await fs.promises.unlink(fileOf(key));
        } catch (e: any) {
          if (e.code !== 'ENOENT') throw e;
        }
      }),
    setMode: (key, mode) =>
      mutate(key, (j) => {
        j.mode = mode;
      }),
    setReview: (key, review) =>
      mutate(key, (j) => {
        if (review.title !== undefined) j.review.title = review.title;
        if (review.summary !== undefined) j.review.summary = review.summary;
      }),
  };
}
