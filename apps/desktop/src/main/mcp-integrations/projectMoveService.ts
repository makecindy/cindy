import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDbClient, tryGetDbClient } from '../localDb/client/current.js';
import { sessions, orcaTeams, orcaWorkers } from '../localDb/schema.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import { broadcastSessionPatched } from '../localDb/ipc/sessions.js';
import { setSessionProjectMoveProjector } from '../localDb/mapper.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createDeferredProjectMoveController } from './deferredProjectMove.js';
import { captureDeferredProjectMoveScope } from './deferredProjectMoveJournal.js';
import {
  inspectSessionProjectMove,
  moveSessionProject,
  setDeferredHostMove,
} from './moveSession.js';
import { validateLocalProjectDirectory, withLocalProjectContext } from './createProject.js';
import { setProjectMoveHooks } from './projectMoveBridge.js';

const log = createLogger('project-move');

export function initializeProjectMoves(deps: {
  isBusy(sessionId: string): boolean;
  canApply(): boolean;
  onSettled(sessionId: string): void;
  drainPersist(): Promise<void>;
  withWorkerLocks<T>(
    ids: readonly string[],
    run: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }>;
}) {
  const foregroundRequests = new Set<string>();
  const workerIds = async (id: string) =>
    (
      await getDbClient()
        .drizzle.select({ sessionId: orcaWorkers.sessionId })
        .from(orcaWorkers)
        .innerJoin(orcaTeams, eq(orcaWorkers.teamId, orcaTeams.id))
        .where(and(eq(orcaTeams.leadSessionId, id), eq(orcaTeams.status, 'active')))
    )
      .map((worker) => worker.sessionId)
      .filter((worker) => worker !== id);
  const readCurrentTarget = async (id: string) => {
    const [row] = await getDbClient()
      .drizzle.select()
      .from(sessions)
      .where(eq(sessions.id, id))
      .limit(1);
    return row && row.status === 'active'
      ? {
          workingDir: row.workingDir,
          workspaceKind:
            row.workspaceKind === 'dialogue' ? ('dialogue' as const) : ('project' as const),
        }
      : null;
  };
  const controller = createDeferredProjectMoveController({
    captureScope: () => {
      // Startup recovery may run before this owner's DB is ready. Refuse the
      // settlement before its failure/rollback branch can retire a valid intent.
      const client = tryGetDbClient();
      if (!client) throwIpcError('PRECONDITION_FAILED', 'Cindy project storage is not ready.');
      const scope = captureDeferredProjectMoveScope();
      return {
        ...scope,
        assertCurrent: () => {
          scope.assertCurrent();
          if (tryGetDbClient() !== client)
            throwIpcError('PRECONDITION_FAILED', 'Cindy project storage is not ready.');
        },
      };
    },
    withSessionLock: withSessionRouteLock,
    readCurrentTarget,
    isBusy: async (id) =>
      !deps.canApply() || deps.isBusy(id) || (await workerIds(id)).some(deps.isBusy),
    applyMove: async (intent, { assertCurrent }) => {
      assertCurrent();
      if (!deps.canApply()) return 'busy';
      const ids = await workerIds(intent.sessionId);
      assertCurrent();
      const locked = await deps.withWorkerLocks(ids, async () => {
        // Worker membership may change while acquiring the lead/worker locks.
        const currentIds = await workerIds(intent.sessionId);
        assertCurrent();
        if (
          !deps.canApply() ||
          currentIds.some((id) => !ids.includes(id)) ||
          deps.isBusy(intent.sessionId) ||
          currentIds.some(deps.isBusy)
        )
          return 'busy' as const;
        await deps.drainPersist();
        assertCurrent();
        const result = await moveSessionProject(
          deps.isBusy,
          intent.sessionId,
          intent.sessionId,
          intent.target.workspaceKind === 'dialogue' ? null : intent.target.workingDir,
          assertCurrent,
          { routeLockHeld: true, strictTranscriptRelocation: true },
        );
        assertCurrent();
        if (!result.ok) {
          // Strict CC relocation may already have persisted the live fork ID
          // before a copy failed. Keep the renderer aligned with that safe ID.
          const [row] = await getDbClient()
            .drizzle.select({ sdkSessionId: sessions.sdkSessionId })
            .from(sessions)
            .where(eq(sessions.id, intent.sessionId))
            .limit(1);
          assertCurrent();
          if (row) broadcastSessionPatched(intent.sessionId, { sdkSessionId: row.sdkSessionId });
          throw new Error(`PROJECT_MOVE_${result.errorCode}`);
        }
      });
      return locked.acquired ? locked.value : 'busy';
    },
    publish: (sessionId, projectMoveTarget) => {
      broadcastSessionPatched(sessionId, { projectMoveTarget, projectMoveFailureId: null });
      if (projectMoveTarget === null) deps.onSettled(sessionId);
    },
    onFailure: (sessionId, error) => {
      log.warn('deferred project move failed', { sessionId, error });
      // The initiating request reports immediate failures itself. Background
      // failures need a push because that request has already been acknowledged.
      if (foregroundRequests.has(sessionId)) return;
      broadcastSessionPatched(sessionId, {
        projectMoveTarget: null,
        projectMoveFailureId: randomUUID(),
      });
    },
  });
  setSessionProjectMoveProjector((id) => controller.project(id));
  // Retry only pending work. The timer also covers an idle worker/background task
  // ending without a normal terminal event, and owner DB readiness after restart.
  const drain = () => {
    void controller.drain().catch((error) => {
      log.debug('project move drain deferred', { error });
    });
  };
  const timer = setInterval(drain, 2_000);
  timer.unref();
  setProjectMoveHooks({
    onIdle: drain,
    hasPending: (id) => controller.project(id) !== null,
    beforeSend: async (id) => {
      const result = await controller.settle(id, { lockHeld: true, beforeSend: true });
      if (result === 'busy')
        throwIpcError('SESSION_RUNNING', 'The task workspace is still in use.');
    },
  });
  setDeferredHostMove(async (sessionId, workingDir, assertAuthority) => {
    if (!deps.canApply())
      return {
        ok: false,
        errorCode: 'PRECONDITION_FAILED',
        message: 'Move tasks from the active Cindy instance.',
      };
    const checked = workingDir === null ? null : validateLocalProjectDirectory(workingDir);
    if (checked && !checked.ok) return checked;
    const targetDir = checked?.workingDir ?? null;
    return withLocalProjectContext<{
      sessionId: string;
      workingDir: string | null;
      workspaceKind: 'project' | 'dialogue';
    }>(sessionId, async (context) => {
      const assertCurrent = () => {
        context.assertCurrent();
        assertAuthority();
      };
      return withSessionRouteLock(sessionId, async () => {
        assertCurrent();
        const { target } = await inspectSessionProjectMove(
          context,
          sessionId,
          targetDir,
          deps.isBusy,
          assertCurrent,
          true,
        );
        assertCurrent();
        if (target.agentDeviceId) {
          // Remote agents keep their native workspace on the execution computer.
          // Preserve ordinary idle moves without deferring them or requiring a
          // local resume transcript. The ordinary move rechecks busy state.
          const result = await moveSessionProject(
            deps.isBusy,
            sessionId,
            sessionId,
            targetDir,
            assertCurrent,
            { routeLockHeld: true },
          );
          assertCurrent();
          if (!result.ok) return result;
          return {
            ...result,
            workspaceKind:
              result.workspaceKind === 'dialogue' ? ('dialogue' as const) : ('project' as const),
          };
        }
        const source = {
          workingDir: target.workingDir,
          workspaceKind:
            target.workspaceKind === 'dialogue' ? ('dialogue' as const) : ('project' as const),
        };
        const destination =
          targetDir === null
            ? { workingDir: target.workingDir, workspaceKind: 'dialogue' as const }
            : { workingDir: targetDir, workspaceKind: 'project' as const };
        await controller.stage(sessionId, source, destination);
        assertCurrent();
        foregroundRequests.add(sessionId);
        let settled;
        try {
          settled = await controller.settle(sessionId, { lockHeld: true });
        } finally {
          foregroundRequests.delete(sessionId);
        }
        assertCurrent();
        if (settled === 'cancelled')
          return {
            ok: false,
            errorCode: 'INTERNAL',
            message: 'Could not move the task. Its previous project was restored.',
          };
        return { ok: true, sessionId, ...destination };
      });
    });
  });
  drain();
  return () => {
    clearInterval(timer);
    setProjectMoveHooks(null);
    setSessionProjectMoveProjector(null);
    setDeferredHostMove(null);
  };
}
