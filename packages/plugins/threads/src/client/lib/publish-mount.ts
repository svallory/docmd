import { whenLive } from './when-live';

export interface PublishMountDeps<W> {
  /** The docmd socket probe; absent when docmd is not loaded (static build). */
  isLive: (() => boolean) | undefined;
  /** Whether the owning element is still in the document. */
  isConnected: () => boolean;
  create: () => W;
  remove: (widget: W) => void;
}

/** Mounts the publish widget once the socket is live; never twice, never after stop(). */
export function createPublishMount<W>(deps: PublishMountDeps<W>) {
  let widget: W | null = null;
  let cancel: (() => void) | null = null;

  return {
    get widget(): W | null { return widget; },
    get waiting(): boolean { return cancel !== null; },
    start(): void {
      const { isLive } = deps;
      if (widget || cancel || !isLive) return;
      let fired = false;
      const c = whenLive(isLive, () => {
        fired = true;
        cancel = null;
        if (widget || !deps.isConnected()) return;
        widget = deps.create();
      }, () => { cancel = null; });
      if (!fired) cancel = c; // an immediate mount leaves nothing pending
    },
    stop(): void {
      cancel?.();
      cancel = null;
      if (widget) deps.remove(widget);
      widget = null;
    },
  };
}
