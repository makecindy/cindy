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
    wait(timeoutMs: number): Promise<boolean> {
      if (timeoutMs <= 0) return Promise.resolve(false);
      if (complete) return Promise.resolve(true);
      return new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          resolve(false);
        }, timeoutMs);
        waiters.add(wake);
      });
    },
  };
}

// Released only by check-environment after required binaries and optional Pi settle.
// Account switches may recreate Maker but do not repeat binary startup.
export const makerStartupGate = createMakerStartupGate();
