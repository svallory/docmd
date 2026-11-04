/**
 * Content-watcher pipeline for `docmd dev`: post-rebuild quiet window,
 * content-signature gate, pending-file accumulation, debounce and build.
 *
 * Right after a content rebuild, fs.watch can still deliver stale events
 * (macOS phantom events, the build's own writes). Dropping them outright also
 * dropped a genuine save made inside the window. Instead, an event that
 * arrives inside the window is deferred until the window ends and is then
 * handled like any other event: the signature gate discards the phantom and
 * self-write ones, and a real edit is rebuilt. Everything time- or
 * filesystem-dependent is injected so the pipeline runs under a fake clock.
 */
export type WatchEventKind = 'content' | 'asset' | 'config';

export interface WatchEventMeta {
  kind: WatchEventKind;
  /** The file was just written by an RPC action (its reload is already known to the client). */
  rpcWritten: boolean;
}

interface PipelineOptions {
  quietMs: number;
  debounceMs: number;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** True when the file's content signature differs from the last one seen (consumes it). */
  signatureChanged: (filePath: string) => boolean;
  /** True while another quiet period (e.g. after a config rebuild) swallows events. */
  isBlocked: () => boolean;
  /** Runs one build. `targets` is undefined for a full (asset) rebuild. Must throw on failure. */
  build: (targets: string[] | undefined) => Promise<void>;
  /** A build finished; `reload` is false when every target was written by an RPC action. */
  onBuilt: (info: { targets: string[]; reload: boolean }) => void;
  /** A config/nav file really changed. */
  onConfig: (filePath: string) => void;
}

export function createWatchPipeline(opts: PipelineOptions) {
  let lastRebuildAt = 0;
  const deferred = new Map<string, { handle: unknown; meta: WatchEventMeta }>();
  const pending = new Map<string, boolean>(); // file -> every event for it was RPC-written
  let pendingAsset = false;
  let debounce: unknown = null;
  let building = false;
  let queued = false;

  const mergeRpc = (prev: boolean | undefined, next: boolean) => (prev === undefined ? next : prev && next);

  function process(filePath: string, meta: WatchEventMeta): void {
    if (opts.isBlocked()) return;
    if (!opts.signatureChanged(filePath)) return;
    if (meta.kind === 'config') {
      opts.onConfig(filePath);
      return;
    }
    pending.set(filePath, mergeRpc(pending.get(filePath), meta.rpcWritten));
    if (meta.kind === 'asset') pendingAsset = true;
    if (debounce) opts.clearTimer(debounce);
    debounce = opts.setTimer(() => {
      debounce = null;
      void execute();
    }, opts.debounceMs);
  }

  async function execute(): Promise<void> {
    if (building) { queued = true; return; }
    const targets = [...pending.keys()];
    const rpc = new Map(pending);
    const asset = pendingAsset;
    pending.clear();
    pendingAsset = false;
    queued = false;
    if (!targets.length) return;
    building = true;
    try {
      await opts.build(asset ? undefined : targets);
      self.markRebuilt();
      opts.onBuilt({ targets, reload: !targets.every((f) => rpc.get(f)) });
    } catch {
      // Their signatures are already consumed: keep them for the next event's build.
      for (const f of targets) pending.set(f, mergeRpc(pending.get(f), rpc.get(f)!));
      if (asset) pendingAsset = true;
    } finally {
      building = false;
      if (queued) void execute();
    }
  }

  const self = {
    /** Call when any content build (watcher, plugin or config) has finished. */
    markRebuilt(): void {
      lastRebuildAt = opts.now();
    },
    /** Call for every watcher event that passed the cheap noise filters. */
    event(filePath: string, meta: WatchEventMeta): void {
      const remaining = opts.quietMs - (opts.now() - lastRebuildAt);
      if (remaining <= 0) {
        process(filePath, meta);
        return;
      }
      // One pending re-check per file, measured from its first deferral so
      // later builds cannot push it back indefinitely.
      const prev = deferred.get(filePath);
      if (prev) {
        prev.meta = { kind: meta.kind, rpcWritten: prev.meta.rpcWritten && meta.rpcWritten };
        return;
      }
      const entry = { handle: undefined as unknown, meta };
      deferred.set(filePath, entry);
      entry.handle = opts.setTimer(() => {
        deferred.delete(filePath);
        process(filePath, entry.meta);
      }, remaining);
    },
    /** Drop every timer and pending file (the watchers are being replaced). */
    cancel(): void {
      for (const { handle } of deferred.values()) opts.clearTimer(handle);
      deferred.clear();
      if (debounce) opts.clearTimer(debounce);
      debounce = null;
      pending.clear();
      pendingAsset = false;
      queued = false;
    }
  };
  return self;
}
