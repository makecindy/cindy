export interface BackgroundConnectionDiagnostic {
  phase: "background" | "release-settled" | "grace-fired" | "stop" | "active";
  generation: number;
  elapsedMs: number;
  reason?: "grace" | "suspended";
  releases?: number;
  failed?: number;
  releaseOutcome?: "settled" | "timed-out";
}

interface BackgroundConnectionOptions {
  isBackground(): boolean;
  releaseTopics(): Promise<void>[];
  stop(): void;
  connect(): void;
  graceMs: number;
  releaseWaitMs: number;
  suspendMs: number;
  report?(event: BackgroundConnectionDiagnostic): void;
}

/** Owns the background grace period, including the async unsubscribe tail after its timer fires. */
export function createBackgroundConnection(
  options: BackgroundConnectionOptions,
) {
  let backgroundAt: number | null = null;
  let generation = 0;
  let stopTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  const report = (
    phase: BackgroundConnectionDiagnostic["phase"],
    extra: Partial<BackgroundConnectionDiagnostic> = {},
  ) => {
    // Diagnostics must never prevent stop/connect or create an unhandled async tail.
    try {
      options.report?.({
        phase,
        generation,
        elapsedMs:
          backgroundAt === null ? 0 : Math.max(0, Date.now() - backgroundAt),
        ...extra,
      });
    } catch {
      /* best-effort diagnostic */
    }
  };
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
      const initialReleases = options.releaseTopics();
      report("background", { releases: initialReleases.length });
      void Promise.allSettled(initialReleases).then((results) => {
        if (captured !== generation) return;
        report("release-settled", {
          releases: results.length,
          failed: results.filter((result) => result.status === "rejected")
            .length,
        });
      });
      stopTimer = setTimeout(() => {
        stopTimer = null;
        if (!options.isBackground() || generation !== captured) return;
        report("grace-fired");
        const releases = Promise.allSettled(options.releaseTopics());
        const boundedWait = new Promise<void>((resolve) => {
          releaseTimer = setTimeout(resolve, options.releaseWaitMs);
        });
        void Promise.race([releases, boundedWait]).then((result) => {
          if (generation !== captured) return;
          clearTimers();
          if (options.isBackground()) {
            report("stop", {
              reason: "grace",
              releaseOutcome: Array.isArray(result) ? "settled" : "timed-out",
              ...(Array.isArray(result)
                ? {
                    releases: result.length,
                    failed: result.filter(
                      (entry) => entry.status === "rejected",
                    ).length,
                  }
                : {}),
            });
            options.stop();
          }
        });
      }, options.graceMs);
    },
    active() {
      const elapsed = backgroundAt === null ? 0 : Date.now() - backgroundAt;
      report("active");
      backgroundAt = null;
      generation += 1;
      clearTimers();
      // A timer reference cannot tell whether the socket was actually stopped:
      // JS can be suspended while the final unsubscribe is still awaiting ACK.
      if (elapsed > options.suspendMs) {
        report("stop", { reason: "suspended", elapsedMs: elapsed });
        options.stop();
      }
      options.connect();
    },
    dispose() {
      generation += 1;
      backgroundAt = null;
      clearTimers();
    },
  };
}
