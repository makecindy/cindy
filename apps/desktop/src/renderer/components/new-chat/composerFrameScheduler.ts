/**
 * Creates a coalesced requestAnimationFrame scheduler. Scheduling again before
 * the frame runs cancels the stale callback; teardown cancels pending work.
 */
export function createComposerFrameScheduler(
  run: () => void,
  options: {
    requestFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (handle: number) => void;
  } = {},
): { schedule(): void; cancel(): void } {
  const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  let pending: number | null = null;

  return {
    schedule(): void {
      if (pending !== null) cancelFrame(pending);
      pending = requestFrame(() => {
        pending = null;
        run();
      });
    },
    cancel(): void {
      if (pending === null) return;
      cancelFrame(pending);
      pending = null;
    },
  };
}
