import type { OrcaWorkerStatus } from './orcaTeamService.js';

export interface OrcaRuntimeReleaseWorker {
  id: string;
  teamId: string;
  leadSessionId: string;
  sessionId: string;
  status: OrcaWorkerStatus;
  idleSince: string | null;
  updatedAt: string;
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
  resumeSession(worker: OrcaRuntimeReleaseWorker): Promise<number | null>;
  retireSession(sessionId: string): Promise<void>;
  markRelease(
    workerId: string,
    sessionId: string,
    releasedAt: number,
    expectedUpdatedAt?: number,
  ): Promise<boolean>;
  acknowledgeRelease(workerId: string, sessionId: string, completedAt: number): Promise<boolean>;
  now(): number;
  log: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export const ORCA_RUNTIME_RELEASE_LEASE_MS = 30_000;

export type OrcaRuntimeReleaseState = 'none' | 'releasing' | 'interrupted' | 'released';

/** Classify the no-migration release protocol encoded by idle_since/updated_at. */
export function getOrcaRuntimeReleaseState(
  worker: Pick<OrcaRuntimeReleaseWorker, 'idleSince' | 'updatedAt'>,
  now: number,
): OrcaRuntimeReleaseState {
  if (worker.idleSince === null) return 'none';
  const releasedAt = Date.parse(worker.idleSince);
  const updatedAt = Date.parse(worker.updatedAt);
  if (!Number.isFinite(releasedAt) || !Number.isFinite(updatedAt)) return 'interrupted';
  if (updatedAt > releasedAt) return 'released';
  return now - releasedAt < ORCA_RUNTIME_RELEASE_LEASE_MS ? 'releasing' : 'interrupted';
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
    const initialReleaseState = worker.idleSince === null
      ? 'none'
      : getOrcaRuntimeReleaseState(worker, deps.now());
    if (initialReleaseState === 'releasing') {
      throw new Error(`worker ${worker.id} runtime release is already in progress`);
    }
    let session = deps.getSession(worker.sessionId);
    let recreatedOwnership = false;
    let resumedVersion: number | null = null;
    if (!session) {
      // Claude's runtime is the Session-owned CLI process, so missing local
      // ownership already means there is no persistent provider runtime left.
      if (worker.session.agentKind !== 'codex') {
        if (initialReleaseState === 'interrupted') {
          const acknowledged = await deps.acknowledgeRelease(
            worker.id,
            worker.sessionId,
            deps.now(),
          );
          if (!acknowledged) {
            throw new Error(`worker ${worker.id} release acknowledgement changed before persistence`);
          }
        }
        return;
      }

      // A resumable generic close only removes local ownership; it does not
      // acknowledge provider runtime release. An existing marker is only a
      // pre-close intent, so interrupted releases must also recreate ownership.
      resumedVersion = await deps.resumeSession(worker);
      session = deps.getSession(worker.sessionId);
      if (!session || resumedVersion === null) {
        throw new Error(`worker ${worker.id} session could not be resumed for runtime release`);
      }
      recreatedOwnership = true;
    }

    let releasedAt: number | null = null;
    if (worker.idleSince === null || recreatedOwnership) {
      const expectedUpdatedAt = recreatedOwnership
        ? resumedVersion
        : Date.parse(worker.updatedAt);
      if (expectedUpdatedAt === null || !Number.isFinite(expectedUpdatedAt)) {
        throw new Error(`worker ${worker.id} has an invalid runtime release version`);
      }
      // Resume/unarchive consumes an existing marker. Persist a fresh intent
      // before retrying archive so a crash cannot strand the provider runtime.
      releasedAt = deps.now();
      const didMark = await deps.markRelease(
        worker.id,
        worker.sessionId,
        releasedAt,
        expectedUpdatedAt,
      );
      if (!didMark) {
        if (recreatedOwnership) {
          try {
            await deps.retireSession(worker.sessionId);
          } catch (error) {
            deps.log.warn('releaseWorkerRuntime: failed to retire raced restored ownership', {
              sessionId: worker.sessionId,
              err: error instanceof Error ? error.message : String(error),
            });
          }
        }
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

    // Any close error is ambiguous: thread/archive may have completed remotely
    // before its acknowledgement timed out. Keep the intent so a lease-expired
    // retry can reconcile either outcome without resuming an archived thread.
    await session.close({ releaseRuntime: true });

    if (releasedAt !== null || initialReleaseState !== 'released') {
      const acknowledged = await deps.acknowledgeRelease(
        worker.id,
        worker.sessionId,
        deps.now(),
      );
      if (!acknowledged) {
        throw new Error(`worker ${worker.id} release acknowledgement changed before persistence`);
      }
    }
  };
}
