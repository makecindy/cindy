import { eq } from 'drizzle-orm';
import type { AgentKind, CreateSessionOptions, Maker, Session as MakerSession } from '@cindy/maker-core';
import { getActiveAppSession } from '../../../desktop/src/main/appSessionState.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent, type DataOwnerBroadcastScope } from '../../../desktop/src/main/device-link/broadcast-tap.js';
import { listMessagesForAgentHandoff } from '../../../desktop/src/main/localDb/agentHandoffHistory.js';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.js';
import { sessions } from '../../../desktop/src/main/localDb/schema.js';
import { listVisibleSubagentObservationIdentities, type VisibleSubagentObservationIdentity } from '../../../desktop/src/main/localDb/subagentRuns.js';
import { createLogger } from '../../../desktop/src/main/logger.js';
import { directoryGrantsForRuntime } from '../../../desktop/src/main/maker-ipc/extraDirsValidator.js';
import { createRewindOrchestrator, type RewindCommitOptions } from '../../../desktop/src/main/maker-orchestration/rewindCore.js';
import { advanceSessionRewindGeneration, withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.js';
import { createSessionActionRuntime } from '../../../desktop/src/main/maker-ipc/sessionActionRuntime.js';
import { assertTaskActionCurrent } from '../../../desktop/src/main/maker-ipc/taskActionAuthorization.js';
import { beginSubagentRewindFence, finishSubagentRewindFence, primeSubagentRewindFence, type SubagentRewindFence } from '../../../desktop/src/main/subagentObservationRewindFence.js';
import { isIpcError, type IpcErrorCode } from '../../../desktop/src/shared/ipc-errors.js';
import { requireString, throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import { holdError } from './profile-hold.js';

const log = createLogger('host-rewind');
const STOPPED_REWIND_RETRY_MS = 100;
const STOPPED_REWIND_TIMEOUT_MS = 15_000;

function dbToMakerEngineKind(kind: string | null | undefined): AgentKind {
  if (kind === 'codex') return 'codex';
  if (kind === 'pi') return 'pi';
  return 'claude-code';
}

function wrapErr(err: unknown): never {
  const code: IpcErrorCode = isIpcError(err) ? err.code : 'INTERNAL';
  throwIpcError(code, err instanceof Error ? err.message : String(err));
}

export interface HostRewindStartPorts {
  buildCreateOptsWithStderr(opts: CreateSessionOptions): CreateSessionOptions;
  checkWorkDirExists(sessionId: string, workingDir: string, agentKind: AgentKind, remoteHostId?: string): Promise<boolean>;
  readSessionExtraDirsFromDb(sessionId: string): Promise<string[]>;
  readSessionWritableDirsFromDb(sessionId: string): Promise<string[]>;
  bootstrapSession(
    opts: CreateSessionOptions,
    assertAccess?: () => void,
    nativeHistoryResume?: boolean,
  ): Promise<{ session: MakerSession }>;
}

export interface HostRewindPorts {
  getMaker(): Pick<Maker, 'getSession' | 'getSessionMeta' | 'closeSession' | 'closeSessionIfCurrent'> | null;
  resolveHandoffWindow(
    sessionId: string,
    route: {
      agentKind: AgentKind | 'acp';
      model: string | null | undefined;
      providerId: string | null;
      agentDeviceId?: string | null;
      remoteHostId?: string | null;
      workingBudget?: number | null;
    },
  ): Promise<number | null>;
  drainSessionPersistence(sessionId: string): Promise<void>;
  setLastAssistantTranscriptUuid(sessionId: string, uuid: string | undefined): void;
  startPorts(): HostRewindStartPorts;
  withSessionInputStoppedForRewind<T>(sessionId: string, action: () => Promise<T>): Promise<T>;
  profileHoldReason(): string | null;
  profileHoldGeneration?(): number;
  clearPendingHandoff(sessionId: string): void;
  recoverGeneratedImages(sessionId: string): Promise<unknown>;
  publish(event: Record<string, unknown>): void;
}

export function createHostRewind(ports: HostRewindPorts) {
  const requireMaker = () => {
    const maker = ports.getMaker();
    if (!maker) throwIpcError('PRECONDITION_FAILED', 'Agent runtime is not ready');
    return maker;
  };
  const assertOwner = (scope: DataOwnerBroadcastScope) => {
    if (!isDataOwnerBroadcastScopeCurrent(scope)) {
      throwIpcError('PRECONDITION_FAILED', 'Account changed while preparing rewind');
    }
  };
  const assertNotHeld = (expectedHoldGeneration?: number) => {
    const held = ports.profileHoldReason();
    if (held) throw holdError(held);
    if (expectedHoldGeneration !== undefined && ports.profileHoldGeneration?.() !== expectedHoldGeneration) {
      throw holdError('Profile hold state changed during rewind');
    }
  };

  const orchestrator = createRewindOrchestrator({
    getMaker: requireMaker,
    withRehydrateCloseSuppressed: (_sessionId, fn) => fn(),
    resolveHandoffWindow: (sessionId, route) => ports.resolveHandoffWindow(sessionId, route),
    listMessagesForAgentHandoff: (...args) => listMessagesForAgentHandoff(...args),
    setLastAssistantTranscriptUuid: (sessionId, uuid) => ports.setLastAssistantTranscriptUuid(sessionId, uuid),
    broadcastMessagesDeleted: (payload, ownerScope) => {
      if (isDataOwnerBroadcastScopeCurrent(ownerScope)) {
        ports.publish({ type: 'message_deleted', ...payload });
      }
    },
  });

  const actionRuntime = createSessionActionRuntime({
    getLive: sessionId => ports.getMaker()?.getSession(sessionId),
    ownerGeneration: () => getActiveAppSession().generation,
    load: async sessionId => {
      const [row] = await getDbClient().drizzle.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      return row;
    },
    resume: async (sessionId, row, assertCurrent) => {
      const startHoldGeneration = ports.profileHoldGeneration?.();
      const assertResumeAllowed = () => {
        assertCurrent();
        assertNotHeld(startHoldGeneration);
      };
      assertResumeAllowed();
      if (!row.workingDir) throwIpcError('NOT_FOUND', 'Task working directory is unavailable');
      const start = ports.startPorts();
      const agentKind = dbToMakerEngineKind(row.agentKind);
      const createOpts = start.buildCreateOptsWithStderr({
        id: sessionId,
        agentKind,
        workingDir: row.workingDir,
        model: row.model ?? undefined,
        providerId: row.providerId ?? undefined,
        resumeSessionId: row.sdkSessionId ?? undefined,
        effort: (row.effort ?? undefined) as CreateSessionOptions['effort'],
        fastMode: (row.fastMode ?? false) as CreateSessionOptions['fastMode'],
        permissionMode: (row.permissionMode ?? 'ask') as CreateSessionOptions['permissionMode'],
        planMode: row.planModeEnabled === true,
        title: row.title ?? undefined,
      });
      const ready = await start.checkWorkDirExists(sessionId, createOpts.workingDir, agentKind);
      assertResumeAllowed();
      if (!ready) throwIpcError('NOT_FOUND', 'Task working directory is unavailable');
      const extraDirs = await start.readSessionExtraDirsFromDb(sessionId);
      assertResumeAllowed();
      if (extraDirs.length > 0) Object.assign(createOpts, directoryGrantsForRuntime(extraDirs));
      const writableDirs = await start.readSessionWritableDirsFromDb(sessionId);
      assertResumeAllowed();
      if (writableDirs.length > 0) createOpts.writableDirs = writableDirs;
      const { session } = await start.bootstrapSession(createOpts, assertResumeAllowed, true);
      assertResumeAllowed();
      return session;
    },
    close: async (_sessionId, live) => {
      await ports.getMaker()?.closeSessionIfCurrent(live, 'runtime-refresh');
    },
    holdsPendingRewind: live => live.agentKind === 'claude-code',
  });

  const commitAfterPersistBarrier = async (sessionId: string, clientId: string, opts: RewindCommitOptions) => {
    await ports.drainSessionPersistence(sessionId);
    return withSendToSessionLock(sessionId, async () => {
      let committed = false;
      try {
        opts.assertWriteAllowed?.();
        await assertTaskActionCurrent(sessionId, clientId);
        await actionRuntime(sessionId, 'rewind');
        opts.assertWriteAllowed?.();
        await assertTaskActionCurrent(sessionId, clientId);
        const result = await orchestrator.commitRewindAtMessage(sessionId, clientId, opts);
        committed = true;
        advanceSessionRewindGeneration(sessionId);
        return result;
      } finally {
        await actionRuntime.release(sessionId, { rewindCommitted: committed });
      }
    });
  };

  const commitAfterStopping = async (sessionId: string, clientId: string, opts: RewindCommitOptions) => {
    const deadline = Date.now() + STOPPED_REWIND_TIMEOUT_MS;
    while (true) {
      try {
        return await commitAfterPersistBarrier(sessionId, clientId, opts);
      } catch (err) {
        if (!isIpcError(err) || err.code !== 'SESSION_RUNNING' || Date.now() >= deadline) throw err;
        await new Promise<void>(resolve => setTimeout(resolve, STOPPED_REWIND_RETRY_MS));
      }
    }
  };

  return {
    async preview(sessionId: unknown, clientId: unknown) {
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
      const ownerScope = captureDataOwnerBroadcastScope();
      const holdGeneration = ports.profileHoldGeneration?.();
      try {
        return await withSendToSessionLock(sid, async () => {
          try {
            assertOwner(ownerScope);
            if (!ports.getMaker()?.getSession(sid)) assertNotHeld(holdGeneration);
            await actionRuntime(sid, 'rewind');
            assertOwner(ownerScope);
            return await orchestrator.previewRewindAtMessage(sid, cid);
          } finally {
            await actionRuntime.release(sid);
          }
        });
      } catch (err) {
        log.warn('rewind:preview failed', { sid, cid, error: String(err) });
        wrapErr(err);
      }
    },

    async commit(sessionId: unknown, clientId: unknown, opts?: unknown) {
      const holdGeneration = ports.profileHoldGeneration?.();
      assertNotHeld(holdGeneration);
      const ownerScope = captureDataOwnerBroadcastScope();
      const sid = requireString(sessionId, 'sessionId');
      const cid = requireString(clientId, 'clientId');
      await assertTaskActionCurrent(sid, cid);
      const requireLatestUser = !!opts && typeof opts === 'object' && (opts as { requireLatestUser?: unknown }).requireLatestUser === true;
      const stopIfRunning = !!opts && typeof opts === 'object' && (opts as { stopIfRunning?: unknown }).stopIfRunning === true;
      const allowFileRestore = !!opts && typeof opts === 'object' && (opts as { allowFileRestore?: unknown }).allowFileRestore === false ? false : undefined;
      const assertWriteAllowed = () => {
        assertNotHeld(holdGeneration);
        assertOwner(ownerScope);
      };
      const commitOpts: RewindCommitOptions = {
        requireLatestUser,
        ownerScope,
        assertWriteAllowed,
        ...(allowFileRestore === false ? { allowFileRestore: false as const } : {}),
      };
      let subagentFence: SubagentRewindFence | null = null;
      let fenceCommitted = false;
      let visibleSubagentIdentitiesAfterCommit: VisibleSubagentObservationIdentity[] = [];
      try {
        subagentFence = beginSubagentRewindFence(sid);
        primeSubagentRewindFence(subagentFence, await listVisibleSubagentObservationIdentities(sid));
        assertWriteAllowed();
        await assertTaskActionCurrent();
        const result = stopIfRunning
          ? await ports.withSessionInputStoppedForRewind(sid, () => commitAfterStopping(sid, cid, commitOpts))
          : await commitAfterPersistBarrier(sid, cid, commitOpts);
        visibleSubagentIdentitiesAfterCommit = await listVisibleSubagentObservationIdentities(sid);
        fenceCommitted = true;
        ports.clearPendingHandoff(sid);
        void ports.recoverGeneratedImages(sid).catch(() => undefined);
        if (isDataOwnerBroadcastScopeCurrent(ownerScope)) {
          ports.publish({
            type: 'subagent_runs_changed',
            sessionId: sid,
            runId: null,
            created: false,
            firstForSession: false,
          });
        }
        return result;
      } catch (err) {
        log.warn('rewind:commit failed', { sid, cid, error: String(err) });
        wrapErr(err);
      } finally {
        if (subagentFence) {
          finishSubagentRewindFence(subagentFence, fenceCommitted, visibleSubagentIdentitiesAfterCommit);
        }
      }
    },
  };
}
