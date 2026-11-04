import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partitionThreads, siteFromPage, sortReviews, threadHref } from '../src/client/lib/reviews-view.ts';
import type { ReviewSummary, Thread } from '../src/types.ts';

const review = (id: string, publishedAt: string): ReviewSummary => ({
  id, authorKey: 'a', authorName: 'A', title: id, publishedAt, state: 'published', ops: [],
});
const thread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id, resolved: false, resolved_by: null, resolved_at: null, comments: [], ...extra,
});

describe('threadHref', () => {
  const table: Array<[string, string, string | undefined, string]> = [
    ['docs/guide/intro.md', '/', undefined, '/guide/intro/#thread-t-1'],
    ['docs/index.md', '/', undefined, '/#thread-t-1'],
    ['docs/guide/index.md', '/', undefined, '/guide/#thread-t-1'],
    // Documented limit: README always collapses to its folder, even when the folder also has an index page.
    ['docs/guide/README.md', '/', undefined, '/guide/#thread-t-1'],
    ['docs/README.md', '/', undefined, '/#thread-t-1'],
    ['docs/a/b/c/deep.md', '/', undefined, '/a/b/c/deep/#thread-t-1'],
    ['docs/guide/intro.md', '/site/', undefined, '/site/guide/intro/#thread-t-1'],
    ['docs/guide/intro.md', '/site', undefined, '/site/guide/intro/#thread-t-1'],
    ['docs/My Guide/Getting Started.md', '/', undefined, '/My-Guide/Getting-Started/#thread-t-1'],
    ['content/guide/intro.md', '/', 'content/', '/guide/intro/#thread-t-1'],
  ];
  for (const [file, base, root, want] of table) {
    it(`${file} @ ${base}${root ? ` (root ${root})` : ''} → ${want}`, () => {
      assert.equal(threadHref(file, 't-1', base, root), want);
    });
  }
});

describe('siteFromPage', () => {
  const table: Array<[string, string, string, string]> = [
    ['docs/guide/intro.md', '/guide/intro/', '/', 'docs/'],
    ['docs/index.md', '/', '/', 'docs/'],
    ['docs/index.md', '/site/', '/site/', 'docs/'],
    ['docs/guide/intro.md', '/site/guide/intro/', '/site/', 'docs/'],
    ['docs/guide/README.md', '/site/guide/', '/site/', 'docs/'],
    ['docs/README.md', '/docs/', '/docs/', 'docs/'],
  ];
  for (const [file, path, siteBase, srcRoot] of table) {
    it(`${file} at ${path}`, () => {
      assert.deepEqual(siteFromPage(file, path), { siteBase, srcRoot });
    });
  }

  it('feeds threadHref so a link from another page resolves under the base', () => {
    const { siteBase, srcRoot } = siteFromPage('docs/index.md', '/site/');
    assert.equal(threadHref('docs/guide/intro.md', 't-1', siteBase, srcRoot), '/site/guide/intro/#thread-t-1');
  });
});

describe('sortReviews', () => {
  it('orders newest first and keeps equal dates in incoming order, without mutating the input', () => {
    const input = [
      review('old', '2026-01-01T00:00:00Z'),
      review('tie-1', '2026-03-01T00:00:00Z'),
      review('new', '2026-04-01T00:00:00Z'),
      review('tie-2', '2026-03-01T00:00:00Z'),
    ];
    assert.deepEqual(sortReviews(input).map(r => r.id), ['new', 'tie-1', 'tie-2', 'old']);
    assert.deepEqual(input.map(r => r.id), ['old', 'tie-1', 'new', 'tie-2']);
  });
});

describe('partitionThreads', () => {
  it('puts orphaned threads in orphaned whatever their resolved state; legacy threads without the flag are not', () => {
    const { open, resolved, orphaned } = partitionThreads([
      thread('open'),
      thread('done', { resolved: true }),
      thread('lost-open', { orphaned: true }),
      thread('lost-done', { orphaned: true, resolved: true }),
      { ...thread('legacy'), anchor: { quote: 'q' } },
    ]);
    assert.deepEqual(open.map(x => x.id), ['open', 'legacy']);
    assert.deepEqual(resolved.map(x => x.id), ['done']);
    assert.deepEqual(orphaned.map(x => x.id), ['lost-open', 'lost-done']);
  });
});
