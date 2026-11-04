import fs from 'node:fs';
import path from 'node:path';
import * as parser from './parser.js';
import type { Thread } from '../types.js';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SKIPPED_DIRS = new Set(['.threads', 'node_modules']);

/**
 * Flag every thread whose anchor quote has lost its `==...=={id}` mark in the page body
 * (the part above the `::: threads` block). Threads without an anchor are never flagged.
 * Pure: returns copies, the input is untouched.
 */
export function markOrphans(content: string, threads: Thread[]): Thread[] {
  const cut = content.indexOf('\n::: threads');
  const body = cut >= 0 ? content.slice(0, cut) : content;
  return threads.map((t) => {
    if (!t.anchor?.quote) return t;
    const mark = new RegExp(`==(?:(?!==).)+==\\{${escapeRe(t.id)}\\}`);
    return mark.test(body) ? t : { ...t, orphaned: true };
  });
}

export interface OrphanScanDeps {
  /** Content of a file given the path `listMarkdown` returned. */
  readFile: (file: string) => Promise<string>;
  /** Every markdown file under `root`. */
  listMarkdown: (root: string) => Promise<string[]>;
}

/** Disk-backed deps: recursive `*.md` listing, skipping `.threads` and `node_modules`. */
export const fsOrphanScanDeps: OrphanScanDeps = {
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  async listMarkdown(root) {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (e: any) {
        if (e.code === 'ENOENT') return;
        throw e;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!SKIPPED_DIRS.has(e.name)) await walk(path.join(dir, e.name));
        } else if (e.isFile() && e.name.endsWith('.md')) out.push(path.join(dir, e.name));
      }
    };
    await walk(root);
    return out;
  },
};

/**
 * Orphaned published threads, under `docsRoot`, whose first comment was written by
 * `authorKey`. Files without a threads block are not parsed; `.threads/` and
 * `node_modules` are skipped whatever `listMarkdown` returns.
 */
export async function countOrphanedBy(docsRoot: string, authorKey: string, deps: OrphanScanDeps): Promise<number> {
  const files = (await deps.listMarkdown(docsRoot)).filter(
    (f) => !path.relative(docsRoot, f).split(/[\\/]/).some((seg) => SKIPPED_DIRS.has(seg)),
  );
  const counts = await Promise.all(
    files.map(async (file) => {
      const content = await deps.readFile(file);
      if (!content.includes('::: threads')) return 0;
      return markOrphans(content, parser.parseThreadsFromContent(content)).filter(
        (t) => t.orphaned && t.comments[0]?.authorKey === authorKey,
      ).length;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}
