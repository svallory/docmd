/** One definition of the page body and of a thread mark, shared by publish and orphan detection. */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The page split at the top-level threads block: `body` is what a mark can live in. */
export function splitPage(content: string): { body: string; rest: string } {
  const cut = content.indexOf('\n::: threads');
  return cut >= 0 ? { body: content.slice(0, cut), rest: content.slice(cut) } : { body: content, rest: '' };
}

/**
 * Pattern for `==quote=={id}`; the quote may span lines. Capture group 1 is the quote.
 * Without an id it matches the mark of any thread.
 */
export function markPattern(threadId?: string, flags = ''): RegExp {
  const id = threadId === undefined ? '[^}]+' : escapeRe(threadId);
  return new RegExp(`==((?:(?!==)[\\s\\S])+)==\\{${id}\\}`, flags);
}
