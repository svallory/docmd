import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
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
  /** The child environment; defaults to a copy of `process.env` taken for each command. */
  env?: NodeJS.ProcessEnv;
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

  const git = (args: string[]) =>
    run('git', args, { cwd, env: { ...(deps.env ?? process.env), GIT_TERMINAL_PROMPT: '0' } });
  const auth = ['-c', 'credential.helper=', '-c', `credential.helper=${CREDENTIAL_HELPER}`];

  const syncToRemoteHead = async () => {
    await git([...auth, 'fetch', remote, `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await git(['reset', '--hard', `origin/${branch}`]);
  };

  const commit = async (meta: PublishMeta, applied: Applied) => {
    const marker = skipDeployMarker;
    const subject = meta.kind === 'discard'
      ? `revert(threads): discard review "${applied.title}" ${marker}`
      : `${applied.title} ${marker}`;
    const email = meta.authorEmail || `${meta.authorName}@threads.invalid`;
    await git([
      '-c', `user.name=${committer.name}`, '-c', `user.email=${committer.email}`,
      'commit', `--author=${ident(meta.authorName)} <${ident(email)}>`,
      '-m', subject, ...(meta.kind !== 'discard' && applied.summary ? ['-m', applied.summary] : []),
    ]);
  };

  const push = () => git([...auth, 'push', remote, `HEAD:refs/heads/${branch}`]);

  const resetQuietly = () => git(['reset', '--hard', `origin/${branch}`]).catch(() => undefined);

  return {
    withLock: (fn) => lock.withLock(fn),
    async publishWithRetry(apply, meta) {
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await syncToRemoteHead();
        let applied: Applied | void;
        try {
          applied = await apply();
          await git(['add', '-A', '--', ...meta.files, ...(meta.manifest ? [meta.manifest] : [])]);
          await commit(meta, applied ?? { title: meta.reviewId, summary: null });
        } catch (e) {
          await resetQuietly();
          throw e;
        }
        try {
          await push();
          return;
        } catch (e) {
          lastError = e;
          await resetQuietly();
        }
      }
      throw new ThreadsError(
        'push-failed',
        `could not push to ${remote}/${branch} after ${MAX_ATTEMPTS} attempts; the review is unchanged, publish it again`,
        { cause: lastError },
      );
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
