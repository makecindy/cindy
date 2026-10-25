/** Worker statuses that may release their runtime after the configured idle threshold. */
export const ORCA_IDLE_RELEASE_STATUSES = ['idle', 'running', 'done', 'error'] as const;

export type OrcaIdleReleaseStatus = (typeof ORCA_IDLE_RELEASE_STATUSES)[number];

/** Minimal persisted worker state needed by the idle-release policy. */
export interface OrcaIdleReleaseCandidate {
  id: string;
  sessionId: string;
  leadSessionId: string;
  status: OrcaIdleReleaseStatus;
  idleSince: number | null;
  updatedAt: number;
}

/** Runtime session surface used to protect a live turn from background release. */
export interface OrcaIdleReleaseSession {
  isTurnRunning(): boolean;
}

/** Timer handle abstraction keeps the watcher deterministic under fake timers. */
export interface OrcaIdleReleaseTimer {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

/** Host dependencies for persistence, runtime teardown, broadcasts, and diagnostics. */
export interface OrcaIdleReleaseWatcherDeps {
  readIdleReleaseMinutes(): number;
  listCandidates(updatedBefore: number): Promise<readonly OrcaIdleReleaseCandidate[]>;
  getSession(sessionId: string): OrcaIdleReleaseSession | null;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  hasPendingInput(sessionId: string): Promise<boolean>;
  markReleased(candidate: OrcaIdleReleaseCandidate, releasedAt: number): Promise<boolean>;
  touchWorker(workerId: string, updatedAt: number): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  broadcastWorkerChanged(leadSessionId: string): void;
  now(): number;
  timer: OrcaIdleReleaseTimer;
  log: {
    info(message: string, details?: Record<string, unknown>): void;
    warn(message: string, details?: Record<string, unknown>): void;
  };
}

export interface OrcaIdleReleaseWatcher {
  start(): void;
  stop(): void;
  scanNow(): Promise<void>;
}

const DEFAULT_SCAN_INTERVAL_MS = 60_000;

function isReleaseStatus(status: string): status is OrcaIdleReleaseStatus {
  return ORCA_IDLE_RELEASE_STATUSES.some((candidate) => candidate === status);
}

/**
 * Creates the process-level Worker idle watcher. A scan is single-flight, and each
 * release marker is written atomically after the runtime closes so failed teardown
 * remains retryable and duplicate scans cannot broadcast the same release twice.
 */
export function createOrcaIdleReleaseWatcher(
  deps: OrcaIdleReleaseWatcherDeps,
  scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
): OrcaIdleReleaseWatcher {
  let timerHandle: ReturnType<typeof setInterval> | null = null;
  let scanInFlight = false;

  const scanNow = async (): Promise<void> => {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      const idleReleaseMinutes = deps.readIdleReleaseMinutes();
      if (idleReleaseMinutes <= 0) return;

      const threshold = deps.now() - idleReleaseMinutes * 60_000;
      const candidates = await deps.listCandidates(threshold);
      for (const candidate of candidates) {
        if (candidate.idleSince !== null || !isReleaseStatus(candidate.status)) continue;

        try {
          await deps.withSessionLock(candidate.sessionId, async () => {
            // Maker sessions are process-local. A missing session can mean another
            // shared-userData instance owns the runtime, so only the local owner may release it.
            const session = deps.getSession(candidate.sessionId);
            if (!session) return;

            // Sends and releases share this lock. Re-read the live session only after
            // acquiring it so a newly accepted turn cannot be closed by this scan.
            if (session.isTurnRunning()) {
              await deps.touchWorker(candidate.id, deps.now());
              return;
            }

            // A terminal status can coexist with a follow-up that is already queued.
            // Queued work means the Worker is not idle yet, even before its turn starts.
            if (await deps.hasPendingInput(candidate.sessionId)) {
              await deps.touchWorker(candidate.id, deps.now());
              return;
            }

            await deps.closeSession(candidate.sessionId);

            const releasedAt = deps.now();
            const marked = await deps.markReleased(candidate, releasedAt);
            if (!marked) return;

            deps.log.info('idleWatcher: released worker', {
              workerId: candidate.id,
              sessionId: candidate.sessionId,
              idleThresholdMin: idleReleaseMinutes,
            });
            deps.broadcastWorkerChanged(candidate.leadSessionId);
          });
        } catch (err) {
          deps.log.warn('idleWatcher: release worker failed', {
            workerId: candidate.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      deps.log.warn('idleWatcher: scan failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    } finally {
      scanInFlight = false;
    }
  };

  return {
    start() {
      if (timerHandle !== null) deps.timer.clearInterval(timerHandle);
      timerHandle = deps.timer.setInterval(() => {
        void scanNow();
      }, scanIntervalMs);
      deps.log.info('idleWatcher started');
    },
    stop() {
      if (timerHandle === null) return;
      deps.timer.clearInterval(timerHandle);
      timerHandle = null;
      deps.log.info('idleWatcher stopped');
    },
    scanNow,
  };
}
