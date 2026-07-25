import type { OrcaWorkerStatus } from './orcaTeamService.js';

export interface OrcaRuntimeReleaseWorker {
  id: string;
  teamId: string;
  leadSessionId: string;
  sessionId: string;
  status: OrcaWorkerStatus;
  idleSince: string | null;
  session: {
    agentKind: 'claude-code' | 'codex';
  };
}

interface OrcaRuntimeReleaseSession {
  isTurnRunning?(): boolean;
  abort(): Promise<void>;
  close(options?: { releaseRuntime?: boolean }): Promise<void>;
}

export interface OrcaRuntimeReleaseDeps {
  getSession(sessionId: string): OrcaRuntimeReleaseSession | null;
  resumeSession(worker: OrcaRuntimeReleaseWorker): Promise<void>;
  markRelease(workerId: string, sessionId: string, releasedAt: number): Promise<boolean>;
  restoreRelease(
    workerId: string,
    sessionId: string,
    releasedAt: number,
    previousStatus: OrcaWorkerStatus,
    restoredAt: number,
  ): Promise<boolean>;
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
    let session = deps.getSession(worker.sessionId);
    let recreatedOwnership = false;
    if (!session) {
      // Claude's runtime is the Session-owned CLI process, so missing local
      // ownership already means there is no persistent provider runtime left.
      if (worker.session.agentKind !== 'codex') return;

      // A resumable generic close only removes local ownership; it does not
      // acknowledge provider runtime release. An existing marker is only a
      // pre-close intent, so interrupted releases must also recreate ownership.
      await deps.resumeSession(worker);
      session = deps.getSession(worker.sessionId);
      if (!session) {
        throw new Error(`worker ${worker.id} session could not be resumed for runtime release`);
      }
      recreatedOwnership = true;
    }

    let releasedAt: number | null = null;
    if (worker.idleSince === null || recreatedOwnership) {
      // Resume/unarchive consumes an existing marker. Persist a fresh intent
      // before retrying archive so a crash cannot strand the provider runtime.
      releasedAt = deps.now();
      const didMark = await deps.markRelease(worker.id, worker.sessionId, releasedAt);
      if (!didMark) {
        throw new Error(`worker ${worker.id} changed before runtime release`);
      }
    }

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
      await session.close({ releaseRuntime: true });
    } catch (error) {
      // A failed archive may have completed provider/local teardown before its
      // acknowledgement timed out. Keep the marker when Session ownership has
      // disappeared so retry bootstrap can reconcile an already-archived thread.
      if (releasedAt !== null && deps.getSession(worker.sessionId) !== null) {
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
