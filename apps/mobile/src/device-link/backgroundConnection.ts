interface BackgroundConnectionOptions {
  isBackground(): boolean;
  releaseTopics(): Promise<void>[];
  stop(): void;
  connect(): void;
  graceMs: number;
  releaseWaitMs: number;
  suspendMs: number;
}

/** Owns the background grace period, including the async unsubscribe tail after its timer fires. */
export function createBackgroundConnection(options: BackgroundConnectionOptions) {
  let backgroundAt: number | null = null;
  let generation = 0;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const clearTimers = () => {
    if (stopTimer !== null) clearTimeout(stopTimer);
    if (releaseTimer !== null) clearTimeout(releaseTimer);
    stopTimer = releaseTimer = null;
  };
  return {
    background() {
      clearTimers();
      const captured = ++generation;
      backgroundAt = Date.now();
      for (const release of options.releaseTopics()) void release.catch(() => undefined);
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (!options.isBackground() || generation !== captured) return;
        const releases = Promise.allSettled(options.releaseTopics());
        const boundedWait = new Promise<void>((resolve) => {
          releaseTimer = setTimeout(resolve, options.releaseWaitMs);
        });
        void Promise.race([releases, boundedWait]).finally(() => {
          if (generation !== captured) return;
          clearTimers();
          if (options.isBackground()) options.stop();
        });
      }, options.graceMs);
    },
    active() {
      const elapsed = backgroundAt === null ? 0 : Date.now() - backgroundAt;
      backgroundAt = null;
      generation += 1;
      clearTimers();
      // A timer reference cannot tell whether the socket was actually stopped:
      // JS can be suspended while the final unsubscribe is still awaiting ACK.
      if (elapsed > options.suspendMs) options.stop();
      options.connect();
    },
    dispose() {
      generation += 1;
      backgroundAt = null;
      clearTimers();
    },
  };
}
