import type { ReviewSummary, Thread } from '../../types';

/** Same segment slug the site generator applies to output paths. */
function slugSegment(seg: string): string {
  return seg
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9\-_.~]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || seg;
}

/** URL path segments of a source file's page: extension dropped, `index`/`README` collapse to the folder. */
function pageSegments(file: string): string[] {
  const segs = file.replace(/\\/g, '/').replace(/\.(md|markdown|ejs)$/i, '').split('/').filter(Boolean);
  const last = segs[segs.length - 1]?.toLowerCase();
  if (last === 'index' || last === 'readme') segs.pop();
  return segs.map(slugSegment);
}

/**
 * Where the current page says the site lives: `srcRoot` is the source folder prefix of
 * `data-source-file` (e.g. `docs/`), `siteBase` the URL prefix in front of the page's path.
 * The longest common tail of the page's segments and the URL's segments is the page itself;
 * at least one source segment always stays in the prefix.
 */
export function siteFromPage(currentFile: string, pathname: string): { siteBase: string; srcRoot: string } {
  const rawSegs = currentFile.replace(/\\/g, '/').replace(/\.(md|markdown|ejs)$/i, '').split('/').filter(Boolean);
  const cs = pageSegments(currentFile);
  const ps = pathname.split('/').filter(Boolean);
  let m = 0;
  const max = Math.min(cs.length - 1, ps.length);
  for (let n = max; n > 0; n--) {
    if (cs.slice(cs.length - n).join('/') === ps.slice(ps.length - n).join('/')) { m = n; break; }
  }
  const srcRoot = cs.length - m > 0 ? rawSegs.slice(0, cs.length - m).join('/') + '/' : '';
  const base = ps.slice(0, ps.length - m).join('/');
  return { siteBase: base ? `/${base}/` : '/', srcRoot };
}

/** `<page url>#thread-<id>` for a source file; `srcRoot` defaults to the first path segment. */
export function threadHref(file: string, threadId: string, siteBase: string, srcRoot?: string): string {
  const norm = file.replace(/\\/g, '/');
  const root = srcRoot ?? (norm.includes('/') ? norm.slice(0, norm.indexOf('/') + 1) : '');
  const rel = norm.startsWith(root) ? norm.slice(root.length) : norm;
  const segs = pageSegments(rel);
  const base = siteBase.endsWith('/') ? siteBase : `${siteBase}/`;
  return `${base}${segs.length ? `${segs.join('/')}/` : ''}#thread-${threadId}`;
}

/** Newest first; equal dates keep their incoming order. */
export function sortReviews(list: ReviewSummary[]): ReviewSummary[] {
  return list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.publishedAt < b.r.publishedAt ? 1 : a.r.publishedAt > b.r.publishedAt ? -1 : a.i - b.i))
    .map(x => x.r);
}

/** Orphaned threads (open or resolved) get their own group; the rest split by resolved state. */
export function partitionThreads(threads: Thread[]): { open: Thread[]; resolved: Thread[]; orphaned: Thread[] } {
  const out = { open: [] as Thread[], resolved: [] as Thread[], orphaned: [] as Thread[] };
  for (const t of threads) {
    if (t.orphaned === true) out.orphaned.push(t);
    else if (t.resolved) out.resolved.push(t);
    else out.open.push(t);
  }
  return out;
}
