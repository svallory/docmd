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
  /** Files the journal targets. */
  files: string[];
}

/**
 * How a publish reaches the outside world. `withLock` serialises repository
 * mutations; `publishWithRetry` runs `apply` (which may run more than once
 * when an implementation retries, so it must start from scratch each time).
 */
export interface Sync {
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  publishWithRetry(apply: () => Promise<void>, meta: PublishMeta): Promise<void>;
}

/** The `docmd dev` path: no git process, `apply` runs once. */
export function createNoGitSync(lock: Lock): Sync {
  return {
    withLock: (fn) => lock.withLock(fn),
    publishWithRetry: (apply) => apply(),
  };
}
