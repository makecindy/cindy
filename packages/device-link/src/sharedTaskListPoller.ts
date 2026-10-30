/**
 * Cadence of the account shared-task directory on controlling clients. It only
 * discovers memberships: the server and the hosting Desktop enforce access, and
 * task content arrives through host pushes, independent of this interval.
 */
export const SHARED_TASK_LIST_ACTIVE_MS = 30_000;
export const SHARED_TASK_LIST_IDLE_MS = 60_000;
/** Returning to the foreground does not reread a list this recent. */
export const SHARED_TASK_LIST_RESUME_MIN_MS = 10_000;

export interface SharedTaskListPoller {
  /** Read now, e.g. after joining or reconnecting; while hidden, read on return. */
  refresh(): void;
  /** Call on foreground/background changes; reading pauses while hidden. */
  visibilityChanged(): void;
  dispose(): void;
}

export function startSharedTaskListPoller(options: {
  /**
   * Resolves to the number of listed shared tasks, or null when the read failed.
   * `fresh` marks a read owed to an explicit refresh event; it must not reuse
   * a list cached before that event.
   */
  poll(read: { fresh: boolean }): Promise<number | null>;
  isVisible(): boolean;
}): SharedTaskListPoller {
  let disposed = false;
  let busy = false;
  // An explicit refresh is owed. It survives an in-flight read (e.g. a join
  // mid-read) and a background period, and is paid by the next visible read.
  let refreshPending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = SHARED_TASK_LIST_IDLE_MS;
  let lastReadAt = Number.NEGATIVE_INFINITY;
  const cancel = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancel();
    if (disposed || busy || !options.isVisible()) return;
    timer = setTimeout(() => { void run(); }, delay);
  };
  const run = async () => {
    if (disposed || busy) return;
    cancel();
    busy = true;
    try {
      do {
        const fresh = refreshPending;
        refreshPending = false;
        lastReadAt = Date.now();
        const count = await options.poll({ fresh }).catch(() => null);
        if (count !== null) delay = count > 0 ? SHARED_TASK_LIST_ACTIVE_MS : SHARED_TASK_LIST_IDLE_MS;
        // Never start the owed read in the background; it runs on return.
      } while (refreshPending && !disposed && options.isVisible());
    } finally { busy = false; }
    schedule();
  };
  if (options.isVisible()) void run();
  return {
    refresh() {
      refreshPending = true;
      if (options.isVisible()) void run();
    },
    visibilityChanged() {
      if (!options.isVisible()) { cancel(); return; }
      const elapsed = Date.now() - lastReadAt;
      // A negative interval means the clock moved backwards; read rather than trust it.
      if (refreshPending || elapsed < 0 || elapsed >= SHARED_TASK_LIST_RESUME_MIN_MS) {
        // A read still in flight began before the background period and may
        // return an old snapshot; owe one more read right after it.
        if (busy) refreshPending = true;
        void run();
      } else schedule();
    },
    dispose() { disposed = true; cancel(); },
  };
}
