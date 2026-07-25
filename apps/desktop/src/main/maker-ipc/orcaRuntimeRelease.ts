import type { OrcaWorkerStatus } from './orcaTeamService.js';

export interface OrcaRuntimeReleaseWorker {
  id: string;
  sessionId: string;
  status: OrcaWorkerStatus;
  idleSince: string | null;
}

interface OrcaRuntimeReleaseSession {
  isTurnRunning?(): boolean;
  abort(): Promise<void>;
}

export interface OrcaRuntimeReleaseDeps {
  getSession(sessionId: string): OrcaRuntimeReleaseSession | null;
  markRelease(workerId: string, sessionId: string, releasedAt: number): Promise<boolean>;
  restoreRelease(
    workerId: string,
    sessionId: string,
    releasedAt: number,
    previousStatus: OrcaWorkerStatus,
    restoredAt: number,
  ): Promise<boolean>;
  closeSession(sessionId: string): Promise<void>;
  now(): number;
  log: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/**
 * Release a Worker provider runtime behind a durable recovery marker.
 *
 * The marker is written before the external close so a successful archive can
 * never be stranded by a later DB failure. Existing markers are respected,
 * making interrupted archive/end-team attempts safe to retry.
 */
export function createOrcaRuntimeRelease(deps: OrcaRuntimeReleaseDeps) {
  return async (worker: OrcaRuntimeReleaseWorker): Promise<void> => {
    let releasedAt: number | null = null;
    if (worker.idleSince === null) {
      releasedAt = deps.now();
      const didMark = await deps.markRelease(worker.id, worker.sessionId, releasedAt);
      if (!didMark) {
        throw new Error(`worker ${worker.id} changed before runtime release`);
      }
    }

    const session = deps.getSession(worker.sessionId);
    if (!session) return;

    if (session.isTurnRunning?.()) {
      try {
        await session.abort();
      } catch (error) {
        deps.log.warn('releaseWorkerRuntime: abort failed; continuing to close', {
          sessionId: worker.sessionId,
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      await deps.closeSession(worker.sessionId);
    } catch (error) {
      if (releasedAt !== null) {
        try {
          await deps.restoreRelease(
            worker.id,
            worker.sessionId,
            releasedAt,
            worker.status,
            deps.now(),
          );
        } catch (rollbackError) {
          deps.log.warn('releaseWorkerRuntime: failed to roll back release marker', {
            workerId: worker.id,
            sessionId: worker.sessionId,
            err: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
      }
      throw error;
    }
  };
}
