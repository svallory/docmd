import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, '..', 'e2e', 'fixtures', 'playground-index.md');

/** markdown-it is a dependency of @docmd/parser, not of this plugin. */
const parserRequire = createRequire(path.resolve(here, '..', '..', '..', 'parser', 'package.json'));
export const MarkdownIt = parserRequire('markdown-it');

export const today = new Date().toISOString().split('T')[0];

export interface TempProject {
  root: string;
  /** Relative path of the page the fixture is copied to. */
  file: string;
  /** Rewrite docs/index.md from the fixture. */
  reset(): void;
  /** Remove the temp directory. */
  cleanup(): void;
}

/** Temp dir holding docs/index.md copied from the playground fixture. */
export function tempProject(): TempProject {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'threads-test-'));
  const file = path.join('docs', 'index.md');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  const reset = () => fs.copyFileSync(FIXTURE, path.join(root, file));
  reset();
  return { root, file, reset, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Action context matching what the action dispatcher provides. */
export function makeCtx(root: string, extra: Record<string, unknown> = {}): any {
  const ctx: any = {
    projectRoot: root,
    config: {},
    broadcast: () => {},
    source: { _modified: false },
    async readFile(relativePath: string) {
      return fs.promises.readFile(path.resolve(root, relativePath), 'utf8');
    },
    async writeFile(relativePath: string, content: string) {
      await fs.promises.writeFile(path.resolve(root, relativePath), content);
      ctx.source._modified = true;
    },
    async readFileLines(relativePath: string) {
      return (await ctx.readFile(relativePath)).split('\n');
    },
    ...extra,
  };
  return ctx;
}
