/**
 * Run `onLive` once the docmd socket is live. The browser API exposes no
 * "connected" event, only `isLive()`, so while the socket is still connecting
 * this polls on a fixed interval and stops for good once it fires or after
 * `maxMs`. Returns a cancel function. `onLive` runs at most once.
 */
export function whenLive(
  isLive: () => boolean,
  onLive: () => void,
  opts: { intervalMs?: number; maxMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 250;
  const maxMs = opts.maxMs ?? 30_000;
  let timer: ReturnType<typeof setInterval> | null = null;

  const cancel = (): void => {
    if (timer !== null) { clearInterval(timer); timer = null; }
  };

  if (isLive()) { onLive(); return cancel; }

  let waited = 0;
  timer = setInterval(() => {
    waited += intervalMs;
    if (isLive()) { cancel(); onLive(); return; }
    if (waited >= maxMs) cancel(); // static host or dead server: give up
  }, intervalMs);
  return cancel;
}
