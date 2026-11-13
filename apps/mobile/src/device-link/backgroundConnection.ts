export const BACKGROUND_TRANSITION_TIMEOUT_MS = 4_000;

export interface BackgroundConnectionDiagnostic {
  phase: "background" | "release-settled" | "grace-fired" | "stop" | "active";
  generation: number;
  elapsedMs: number;
  reason?: "grace" | "suspended" | "hold-released";
  /** Background work the person asked for is keeping the connection. */
  held?: boolean;
  releases?: number;
  transitions?: number;
  failed?: number;
  releaseOutcome?: "settled" | "timed-out";
}

interface BackgroundConnectionOptions {
  isBackground(): boolean;
  releaseTopics(): Promise<void>[];
  pendingTransitions?(): Promise<void>[];
  stop(): void;
  /** `hold`: a notification action needs the connection while the app stays in the background. */
  connect(reason: "active" | "hold"): void;
  /**
   * Background work the person asked for (answering from a notification) currently
   * needs the connection. Owned by the caller so that it outlives a replaced client.
   */
  isHeld?(): boolean;
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
        const transitions = options.pendingTransitions?.() ?? [];
        report("grace-fired", { transitions: transitions.length });
        // A media handoff must finish host authorization before signaling stops.
        // This does not retain subscriptions or extend the media/lease deadline.
        const topicReleases = options.releaseTopics();
        const releases = Promise.allSettled([...topicReleases, ...transitions]);
        const remainingTransitionMs = transitions.length
          ? Math.max(
              0,
              BACKGROUND_TRANSITION_TIMEOUT_MS - (Date.now() - backgroundAt!),
            )
          : 0;
        const boundedWait = new Promise<void>((resolve) => {
          releaseTimer = setTimeout(
            resolve,
            transitions.length ? remainingTransitionMs : options.releaseWaitMs,
          );
        });
        void Promise.race([releases, boundedWait]).then((result) => {
          if (generation !== captured) return;
          clearTimers();
          if (options.isBackground() && options.isHeld?.()) {
            // The last hold stops the connection when it is released.
            report("grace-fired", { held: true });
          } else if (options.isBackground()) {
            report("stop", {
              reason: "grace",
              releaseOutcome: Array.isArray(result) ? "settled" : "timed-out",
              ...(Array.isArray(result)
                ? {
                    releases: topicReleases.length,
                    failed: result
                      .slice(0, topicReleases.length)
                      .filter((entry) => entry.status === "rejected").length,
                  }
                : {}),
            });
            options.stop();
          }
        });
      }, options.graceMs);
    },
    active() {
      const backgroundGeneration = generation;
      const elapsed = backgroundAt === null ? 0 : Date.now() - backgroundAt;
      report("active");
      backgroundAt = null;
      generation += 1;
      clearTimers();
      // A timer reference cannot tell whether the socket was actually stopped:
      // JS can be suspended while the final unsubscribe is still awaiting ACK.
      if (elapsed > options.suspendMs) {
        report("stop", {
          reason: "suspended",
          elapsedMs: elapsed,
          generation: backgroundGeneration,
        });
        options.stop();
      }
      options.connect("active");
    },
    /**
     * A hold began: bounded background work the person asked for needs the
     * connection. One the grace period already stopped is started again;
     * nothing is resubscribed.
     */
    held() {
      if (options.isBackground()) options.connect("hold");
    },
    /**
     * The last hold ended. Still in the background, the connection stops as the
     * grace period would have stopped it; a pending grace or unsubscribe tail
     * keeps the stop for itself.
     */
    unheld() {
      if (stopTimer !== null || releaseTimer !== null) return;
      if (!options.isBackground() || options.isHeld?.()) return;
      report("stop", { reason: "hold-released" });
      options.stop();
    },
    dispose() {
      generation += 1;
      backgroundAt = null;
      clearTimers();
    },
  };
}
