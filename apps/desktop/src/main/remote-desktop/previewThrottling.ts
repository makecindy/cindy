/** The slice of a WebContents whose background throttling a preview cast takes over. */
export interface ThrottledContents {
  isDestroyed(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
  getBackgroundThrottling?(): boolean;
}

interface Hold {
  count: number;
  /** What the owner of the contents last asked for; given back when the last hold ends. */
  desired: boolean;
}

const holds = new WeakMap<ThrottledContents, Hold>();

/**
 * Whoever owns a contents' background-throttling policy (the main window follows running
 * turns) sets it through here, so a cast that is holding throttling off is not undone by the
 * owner's next change: while held, the request is only remembered and applied on release.
 */
export function applyBackgroundThrottling(contents: ThrottledContents, allowed: boolean): void {
  if (contents.isDestroyed()) return;
  const hold = holds.get(contents);
  if (hold) {
    hold.desired = allowed;
    return;
  }
  contents.setBackgroundThrottling(allowed);
}

/**
 * Keeps `contents` painting while the system treats it as hidden (a locked screen puts a
 * shown window to `hidden`, and a hidden page produces no frames to capture). Returns the
 * idempotent release, which gives the owner's setting back (the one read before the first
 * hold, or the one the owner asked for since) once the last hold on the contents is gone.
 */
export function holdBackgroundThrottlingOff(contents: ThrottledContents): () => void {
  if (contents.isDestroyed()) return () => undefined;
  let hold = holds.get(contents);
  if (!hold) {
    hold = { count: 0, desired: contents.getBackgroundThrottling?.() ?? true };
    holds.set(contents, hold);
    contents.setBackgroundThrottling(false);
  }
  hold.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = holds.get(contents);
    if (!current || --current.count > 0) return;
    holds.delete(contents);
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(current.desired);
  };
}
