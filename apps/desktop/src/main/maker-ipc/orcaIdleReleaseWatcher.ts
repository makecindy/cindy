import {
  getOrcaRuntimeReleaseState,
  ORCA_RUNTIME_RELEASE_LEASE_MS,
} from './orcaRuntimeRelease.js';

/** Worker statuses that may release their runtime after the configured idle threshold. */
export const ORCA_IDLE_RELEASE_STATUSES = ['idle', 'running', 'done', 'error'] as const;

export type OrcaIdleReleaseStatus = (typeof ORCA_IDLE_RELEASE_STATUSES)[number];

/** Minimal persisted worker state needed by the idle-release policy. */
export interface OrcaIdleReleaseCandidate {
  id: string;
  teamId: string;
  sessionId: string;
  leadSessionId: string;
  agentKind: 'claude-code' | 'codex';
  status: OrcaIdleReleaseStatus;
  idleSince: number | null;
  updatedAt: number;
}

/** Runtime session surface used to protect a live turn from background release. */
export interface OrcaIdleReleaseSession {
  isTurnRunning(): boolean;
}

/** Result of re-checking and closing a runtime after local ownership was confirmed. */
export type OrcaIdleRuntimeCloseResult =
  | 'closed'
  | 'closed-and-acknowledged'
  | 'busy'
  | 'already-missing';

/** Timer handle abstraction keeps the watcher deterministic under fake timers. */
export interface OrcaIdleReleaseTimer {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

/** Host dependencies for persistence, runtime teardown, broadcasts, and diagnostics. */
export interface OrcaIdleReleaseWatcherDeps {
  readIdleReleaseMinutes(): number;
  listCandidates(
    idleUpdatedBefore: number,
    interruptedReleaseBefore: number,
  ): Promise<readonly OrcaIdleReleaseCandidate[]>;
  getSession(sessionId: string): OrcaIdleReleaseSession | null;
  withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  hasPendingInput(sessionId: string): Promise<boolean>;
  markReleased(candidate: OrcaIdleReleaseCandidate, releasedAt: number): Promise<boolean>;
  restoreRelease(
    candidate: OrcaIdleReleaseCandidate,
    releasedAt: number,
    restoredAt: number,
  ): Promise<boolean>;
  acknowledgeRelease(
    candidate: OrcaIdleReleaseCandidate,
    completedAt: number,
  ): Promise<boolean>;
  touchWorker(workerId: string, updatedAt: number): Promise<void>;
  /** Atomically re-check and close an idle runtime after local ownership is confirmed. */
  closeSessionIfIdle(
    candidate: OrcaIdleReleaseCandidate,
    releasedAt: number,
  ): Promise<OrcaIdleRuntimeCloseResult>;
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
 * release marker is written before the external runtime close so a crash or later
 * persistence outage cannot strand an archived thread without recovery metadata.
 * Explicit busy races roll that intent back; ambiguous close failures retain it
 * for lease-expired reconciliation, and duplicate scans cannot broadcast twice.
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

      const now = deps.now();
      const threshold = now - idleReleaseMinutes * 60_000;
      const candidates = await deps.listCandidates(
        threshold,
        now - ORCA_RUNTIME_RELEASE_LEASE_MS,
      );
      for (const candidate of candidates) {
        if (!isReleaseStatus(candidate.status)) continue;
        const releaseState = getOrcaRuntimeReleaseState({
          idleSince: candidate.idleSince === null
            ? null
            : new Date(candidate.idleSince).toISOString(),
          updatedAt: new Date(candidate.updatedAt).toISOString(),
        }, deps.now());
        if (releaseState === 'released' || releaseState === 'releasing') continue;

        try {
          await deps.withSessionLock(candidate.sessionId, async () => {
            // Maker sessions are process-local. Without a marker, a missing
            // Session can mean another shared-userData instance owns the runtime.
            // An expired intent is a durable lease that permits reconstruction.
            const session = deps.getSession(candidate.sessionId);
            if (!session && candidate.idleSince === null) return;

            // Sends and releases share this lock. Re-read the live session only after
            // acquiring it so a newly accepted turn cannot be closed by this scan.
            if (session?.isTurnRunning()) {
              if (candidate.idleSince === null) {
                await deps.touchWorker(candidate.id, deps.now());
              } else {
                await deps.restoreRelease(candidate, candidate.idleSince, deps.now());
              }
              return;
            }

            // A terminal status can coexist with a follow-up that is already queued.
            // Queued work means the Worker is not idle yet, even before its turn starts.
            if (await deps.hasPendingInput(candidate.sessionId)) {
              if (candidate.idleSince === null) {
                await deps.touchWorker(candidate.id, deps.now());
              } else {
                await deps.restoreRelease(candidate, candidate.idleSince, deps.now());
              }
              return;
            }

            // Persist the recovery fact before the non-transactional provider close.
            // If the process exits after this point, resume can safely attempt
            // unarchive; the compatibility path also handles a marker whose close
            // never reached thread/archive.
            const releasedAt = candidate.idleSince ?? deps.now();
            if (candidate.idleSince === null) {
              const marked = await deps.markReleased(candidate, releasedAt);
              if (!marked) return;
            }

            const rollbackBusyReleaseMarker = async () => {
              try {
                await deps.restoreRelease(candidate, releasedAt, deps.now());
              } catch (restoreError) {
                deps.log.warn('idleWatcher: release marker rollback failed', {
                  workerId: candidate.id,
                  reason: 'busy',
                  restoreError: restoreError instanceof Error ? restoreError.message : String(restoreError),
                });
              }
            };

            let closeResult: OrcaIdleRuntimeCloseResult;
            try {
              closeResult = await deps.closeSessionIfIdle(candidate, releasedAt);
            } catch (closeError) {
              // Archive may have completed before an acknowledgement timeout.
              // Keep the durable intent so a lease-expired retry reconciles it.
              throw closeError;
            }

            if (closeResult === 'busy') {
              await rollbackBusyReleaseMarker();
              return;
            }
            if (closeResult === 'already-missing') {
              return;
            }

            if (closeResult === 'closed') {
              const acknowledged = await deps.acknowledgeRelease(candidate, deps.now());
              if (!acknowledged) {
                throw new Error(`worker ${candidate.id} release acknowledgement changed`);
              }
            }

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
