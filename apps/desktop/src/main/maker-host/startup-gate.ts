/** Process-wide binary startup boundary, independent of account/Maker lifetimes. */
export function createMakerStartupGate() {
  let complete = false;
  const waiters = new Set<() => void>();

  return {
    assertComplete(): void {
      if (!complete) throw new Error('Maker startup preparation has not completed');
    },
    complete(): void {
      complete = true;
      for (const wake of waiters) wake();
      waiters.clear();
    },
    /** A timed-out caller is removed and must not start work when startup finishes later. */
    wait(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
      if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(false);
      if (complete) return Promise.resolve(true);
      return new Promise((resolve) => {
        const finish = (ready: boolean) => {
          clearTimeout(timer);
          waiters.delete(wake);
          signal?.removeEventListener('abort', abort);
          resolve(ready);
        };
        const wake = () => finish(true);
        const abort = () => finish(false);
        const timer = setTimeout(abort, timeoutMs);
        waiters.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
  };
}

// Released only by check-environment after required binaries and optional Pi settle.
// Account switches may recreate Maker but do not repeat binary startup.
export const makerStartupGate = createMakerStartupGate();
