/** A promise-chain mutex: callbacks run strictly one after the other, a failure does not poison the queue. */
export interface Lock {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export function createLock(): Lock {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    withLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = chain.then(fn, fn);
      chain = run.catch(() => undefined);
      return run;
    },
  };
}

/** What a publish tells the sync layer (a git implementation builds the commit from it). */
export interface PublishMeta {
  reviewId: string;
  authorKey: string;
  authorName: string;
  /** The author's email; a git sync falls back to a placeholder when absent. */
  authorEmail?: string | null;
  /** What the change is: a published review or a discard (default publish). */
  kind?: 'publish' | 'discard';
  /** Files the change touches, relative to the project root. */
  files: string[];
  /** The review manifest the change writes, relative to the project root (committed with the files). */
  manifest?: string;
}

/** What `apply` reports once it has written the files: the commit message is built from it. */
export interface Applied {
  title: string;
  summary: string | null;
}

/**
 * How a publish reaches the outside world. `withLock` serialises repository
 * mutations; `publishWithRetry` runs `apply` (which may run more than once
 * when an implementation retries, so it must start from scratch each time).
 * An implementation that retries must return the files to their pre-apply state
 * before calling `apply` again: apply reads the files it rewrites.
 */
export interface Sync {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  publishWithRetry(apply: () => Promise<Applied>, meta: PublishMeta): Promise<void>;
}

/** The `docmd dev` path: no git process, `apply` runs once. */
export function createNoGitSync(lock: Lock): Sync {
  return {
    withLock: (fn) => lock.withLock(fn),
    publishWithRetry: async (apply) => void (await apply()),
  };
}
