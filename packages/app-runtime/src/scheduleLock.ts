export function createScheduleLock() {
  const inflight = new Map<string, Promise<void>>();

  async function withScheduleLock<T>(
    scheduleId: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = inflight.get(scheduleId) ?? Promise.resolve();
    // Scheduler registers a run before it waits for this per-schedule lock.  A
    // delete/pause can therefore abort a run while it is waiting here; do not
    // let that stale callback create a session after it acquires the lock.
    let started = false;
    let rejectQueuedAbort!: (reason: Error) => void;
    const queuedAbort = new Promise<never>((_, reject) => {
      rejectQueuedAbort = reject;
    });
    const runWhenNotAborted = async (): Promise<T> => {
      if (signal.aborted) {
        throw new Error(
          "schedule execution aborted before acquiring schedule lock",
        );
      }
      started = true;
      return fn();
    };
    const next = prev.then(runWhenNotAborted, runWhenNotAborted);
    const marker = next.then(
      () => undefined,
      () => undefined,
    );
    inflight.set(scheduleId, marker);
    const cleanup = (): void => {
      if (inflight.get(scheduleId) === marker) {
        inflight.delete(scheduleId);
      }
    };
    // Keep the lock marker until the queued callback has actually settled.  A
    // caller that aborts while queued may return early, but later fires must not
    // bypass the still-running predecessor.
    void next.then(cleanup, cleanup);
    const onAbort = (): void => {
      if (!started) {
        rejectQueuedAbort(
          new Error(
            "schedule execution aborted while waiting for schedule lock",
          ),
        );
      }
    };
    try {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      return await Promise.race([next, queuedAbort]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  return { withScheduleLock };
}
