import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type { ActionContext } from '@docmd/api';
import { ThreadsError } from './errors.js';
import { getOptions, type ThreadsOptions } from './config.js';
import { createLock, createNoGitSync, type Applied, type Lock, type PublishMeta, type Sync } from './lock.js';

export type ExecFile = (
  file: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

export interface GitSyncDeps {
  cwd: string;
  lock: Lock;
  execFile?: ExecFile;
}

const MAX_ATTEMPTS = 3;

/** Reads the token from the child environment: it is never an argument, a URL or a file. */
const CREDENTIAL_HELPER = '!f(){ echo username=x-access-token; echo "password=$DOCMD_THREADS_GIT_TOKEN"; }; f';

/** A name or email as `--author` takes it: no angle brackets or line breaks. */
const ident = (s: string): string => s.replace(/[<>\r\n]+/g, ' ').trim();

/**
 * Git-backed sync: one commit per publish or discard, authored by the caller,
 * committed by the configured bot, pushed to the configured branch. A rejected
 * push is retried from the fresh remote head (the review is applied again).
 */
export function createGitSync(opts: NonNullable<ThreadsOptions['git']>, deps: GitSyncDeps): Sync {
  const { cwd, lock } = deps;
  const run: ExecFile = deps.execFile ?? (promisify(nodeExecFile) as unknown as ExecFile);
  const { branch, remote, skipDeployMarker, committer } = opts;

  // The child gets the server's environment: the credential helper reads the token from it.
  const git = (args: string[]) =>
    run('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const auth = ['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`];

  const syncToRemoteHead = async () => {
    await git([...auth, 'fetch', remote, `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await git(['reset', '--hard', `origin/${branch}`]);
  };

  /** Paths the change may have written; the ones that exist are staged, the rest (deleted upstream) are skipped. */
  const pathsOf = (meta: PublishMeta) => [...meta.files, ...(meta.manifest ? [meta.manifest] : [])];

  const stage = async (meta: PublishMeta): Promise<boolean> => {
    const present = pathsOf(meta).filter((f) => fs.existsSync(path.join(cwd, f)));
    if (present.length) await git(['add', '-A', '--', ...present]);
    return git(['diff', '--cached', '--quiet']).then(() => false, () => true);
  };

  const commit = async (meta: PublishMeta, applied: Applied) => {
    const marker = skipDeployMarker;
    const subject = meta.kind === 'discard'
      ? `revert(threads): discard review "${applied.title}" ${marker}`
      : `${applied.title} ${marker}`;
    const slug = meta.authorKey.replace(/[^a-z0-9._-]+/gi, '-');
    const email = meta.authorEmail || `${slug}@threads.invalid`;
    await git([
      '-c', `user.name=${committer.name}`, '-c', `user.email=${committer.email}`,
      'commit', `--author=${ident(meta.authorName)} <${ident(email)}>`,
      '-m', subject, ...(meta.kind !== 'discard' && applied.summary ? ['-m', applied.summary] : []),
    ]);
  };

  const push = () => git([...auth, 'push', remote, `HEAD:refs/heads/${branch}`]);

  /** Back to origin, and drop what the change wrote that git does not know (a new manifest), so the review stays open. */
  const resetQuietly = async (meta: PublishMeta) => {
    await git(['reset', '--hard', `origin/${branch}`]).catch(() => undefined);
    // Only what the change creates (the manifest, authors.json): never a target page, never an empty pathspec.
    const created = pathsOf(meta).filter((f) => f.includes('.threads/'));
    if (created.length) await git(['clean', '-fdq', '--', ...created]).catch(() => undefined);
  };

  /** A coded, path-free error for the client (the remote may carry credentials); the raw error stays in `cause`, redacted in the log. */
  const fail = (what: string, cause: unknown) => {
    const raw = cause instanceof Error ? `${cause.message}` : String(cause);
    console.error(`[threads] git ${what} failed: ${raw.replace(/\/\/[^@/\s]*@/g, '//***@')}`);
    return new ThreadsError('push-failed', `could not ${what} the remote branch ${branch}; the review is unchanged, try again`, { cause });
  };

  return {
    withLock: (fn) => lock.withLock(fn),
    async publishWithRetry(apply, meta) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          await syncToRemoteHead();
        } catch (e) {
          await resetQuietly(meta);
          throw fail('sync with', e);
        }
        let applied: Applied;
        try {
          applied = await apply();
        } catch (e) {
          await resetQuietly(meta);
          throw e;
        }
        try {
          if (!(await stage(meta))) return; // nothing changed (e.g. the profile is already committed)
          await commit(meta, applied);
        } catch (e) {
          await resetQuietly(meta);
          throw fail('commit to', e);
        }
        try {
          await push();
          return;
        } catch (e) {
          lastError = e;
          await resetQuietly(meta);
        }
      }
      throw fail(`push ${MAX_ATTEMPTS} times to`, lastError);
    },
  };
}

/** One lock per docs root, so every caller's publish queues behind the same chain. */
const locks = new Map<string, Lock>();
const syncs = new Map<string, Sync>();

/**
 * The sync for this project: git-backed when `plugins.threads.git` is set (one per
 * project root), else the no-git one (`docmd dev`, no process is ever spawned).
 * With an injected `execFile` the sync is built fresh (tests), sharing the lock.
 */
export function getSync(ctx: ActionContext, deps: { execFile?: ExecFile } = {}): Sync {
  const root = path.join(ctx.projectRoot, ctx.config?.src || '');
  let lock = locks.get(root);
  if (!lock) locks.set(root, (lock = createLock()));
  const git = getOptions(ctx).git;
  if (!git) {
    let sync = syncs.get(root);
    if (!sync) syncs.set(root, (sync = createNoGitSync(lock)));
    return sync;
  }
  if (deps.execFile) return createGitSync(git, { cwd: ctx.projectRoot, lock, execFile: deps.execFile });
  let sync = syncs.get(`git:${root}`);
  if (!sync) syncs.set(`git:${root}`, (sync = createGitSync(git, { cwd: ctx.projectRoot, lock })));
  return sync;
}
