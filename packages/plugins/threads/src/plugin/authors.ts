import fs from 'node:fs';
import path from 'node:path';
import type { AuthorsMap } from '../types.js';

/** What locating the docs root needs from an action context. */
interface RootCtx {
  projectRoot?: string;
  config?: any;
}

/** `<docsRoot>/.threads/authors.json`. */
export const authorsPath = (ctx: RootCtx): string =>
  path.join(ctx.projectRoot ?? '', ctx.config?.src || '', '.threads', 'authors.json');

/** authors.json as text; null when the file does not exist, any other failure throws. */
export async function readAuthorsRaw(ctx: RootCtx): Promise<string | null> {
  try {
    return await fs.promises.readFile(authorsPath(ctx), 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** The authors map; {} when the file does not exist. */
export async function readAuthors(ctx: RootCtx): Promise<AuthorsMap> {
  const raw = await readAuthorsRaw(ctx);
  return raw === null ? {} : (JSON.parse(raw) as AuthorsMap);
}

/** Write the authors map, creating the directory if needed. */
export async function writeAuthors(ctx: RootCtx, authors: AuthorsMap): Promise<void> {
  const file = authorsPath(ctx);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(authors, null, 2) + '\n');
}
