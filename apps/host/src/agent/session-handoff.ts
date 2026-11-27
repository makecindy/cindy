import { eq } from 'drizzle-orm';
import type { AgentKind, Effort } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import type { OrcaRemoteWorkerModelsRequest } from '@cindy/device-link';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../../desktop/src/main/appSessionState.js';
import { getDbClient, getCurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.js';
import { botProfiles, botSessionLinks, sessions } from '../../../desktop/src/main/localDb/schema.js';
import { isBotVisibleRemotely } from '../../../desktop/src/main/localDb/ipc/botRemoteVisibility.js';
import { openSession } from '../../../desktop/src/main/localDb/sessionOpening.js';
import { listProjects, resolveSessionProject } from '../../../desktop/src/main/mcp-integrations/projectManagementCore.js';
import { getSelectedNewMakerRoute } from '../../../desktop/src/main/maker-host/newMakerDefaultsCache.js';
import { validateHandoffWorkingDir } from '../../../desktop/src/main/maker-ipc/handoffWorkingDir.js';
import { prepareHandoffWorktree } from '../../../desktop/src/main/maker-ipc/handoffWorktree.js';
import { createRemoteSessionOpener } from '../../../desktop/src/main/maker-ipc/remoteSessionCreation.js';
import type { SessionHandoffSendParams, SessionHandoffSendResult } from '../../../desktop/src/main/maker-ipc/sessionHandoffCore.js';
import { resolveSessionExecutionSelection } from '../../../desktop/src/main/maker-ipc/sessionExecutionSelection.js';
import { buildLocalProviderRoutingContext, deviceAvailableModels } from '../../../desktop/src/main/maker-ipc/orcaProviderRoutingContext.js';
import { pluginEngineDescriptors } from '../../../desktop/src/main/maker-ipc/pluginEnginesIpc.js';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.js';
import { withSessionPermissionChange } from '../../../desktop/src/main/maker-ipc/sessionPermissionChange.js';
import { getForSession, listAll } from '../../../desktop/src/main/worktree/WorktreeManager.js';
import { resolveFreshSourceBranch } from '../../../desktop/src/main/worktree/freshBase.js';
import { isTaskActionRevoked } from '../../../desktop/src/main/maker-ipc/taskActionAuthorization.js';
import { uiText } from '../../../desktop/src/main/uiText.js';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import { isIpcError } from '../../../desktop/src/shared/ipc-errors.js';
import { getHostNewMakerDefaultsByVendor } from './remote-draft-preferences.js';
import { assertHostTaskExecutionSupported } from './send-preflight.js';
import { holdError } from './profile-hold.js';
import type { createInputQueue } from './input-queue.mjs';
import type { HostWorktreeLifecycle } from './worktree-lifecycle.js';

export function createHostSessionHandoff(ports: {
  input: ReturnType<typeof createInputQueue>;
  worktree: HostWorktreeLifecycle;
  readProviders(): Promise<ProviderView[]>;
  agents(): readonly AgentKind[];
  hasCindyAiApiKey(): boolean;
  isSelfDeviceId(id: string): boolean;
  assertProviderExecutionSupported(id: string, providerId?: string | null): void;
  broadcastCreated(id: string): void;
}) {
  function captureOwner(write = false) {
    const owner = getCurrentDbClientSnapshot();
    const generation = ports.input.profileHoldGeneration();
    return () => {
      if (!owner || getCurrentDbClientSnapshot() !== owner || isAppSessionBoundaryPending())
        throwIpcError('PRECONDITION_FAILED', 'The Host account is not ready');
      if (write) {
        const held = ports.input.profileHoldReason();
        if (held) throw holdError(held);
        if (generation !== ports.input.profileHoldGeneration())
          throwIpcError('PRECONDITION_FAILED', 'Host profile ownership changed');
      }
    };
  }
  async function send(params: SessionHandoffSendParams): Promise<SessionHandoffSendResult> {
    const { targetSessionId: id, clientId, message, taskActionDeliveryGuard: guard } = params;
    const assertOwner = captureOwner(true);
    if (!clientId || !guard)
      return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY', message: 'Task action authorization is required.' };
    let queueAcceptanceStarted = false;
    try {
      assertOwner();
      await withSessionPermissionChange(id, async () => undefined);
      return await withSendToSessionLock(id, async () => {
        assertOwner();
        const [target] = await getDbClient().drizzle.select({
          row: sessions,
          buddyStatus: botProfiles.status,
          buddyHiddenAt: botProfiles.hiddenAt,
          buddyRole: botSessionLinks.role,
        }).from(sessions)
          .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
          .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
          .where(eq(sessions.id, id)).limit(1);
        assertOwner();
        const notFound = { ok: false as const, errorCode: 'NOT_FOUND', message: 'Session does not exist' };
        if (!target || target.row.hiddenAt != null) return notFound;
        const { row, buddyStatus, buddyHiddenAt, buddyRole } = target;
        if (row.source === 'bot' || buddyRole != null) {
          if (buddyRole === 'group' || !buddyStatus ||
              !isBotVisibleRemotely({ status: buddyStatus, hiddenAt: buddyHiddenAt })) return notFound;
          return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY',
            message: uiText('bots.groupChat.errors.lifecycleUnavailable', 'The current server or computer does not support this action yet.') };
        }
        if (row.status === 'archived' || row.status === 'deleted')
          return { ok: false, errorCode: row.status === 'archived' ? 'ARCHIVED' : 'DELETED', message: 'Session is no longer active' };
        const agentKind = row.agentKind === 'cc' ? 'claude-code' : row.agentKind;
        if (agentKind !== 'claude-code' && agentKind !== 'codex' && agentKind !== 'pi' && agentKind !== 'acp')
          return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY', message: 'The target engine is not supported on this Host' };
        try {
          assertHostTaskExecutionSupported(row);
          ports.assertProviderExecutionSupported(id, row.providerId);
        } catch (error) {
          if (!isIpcError(error) && !(error instanceof Error && error.message.startsWith('[UNSUPPORTED_CAPABILITY]'))) throw error;
          return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY', message: (error as Error).message };
        }
        const queued = await ports.input.enqueue(id, { clientId, text: message }, {
          ...params,
          taskActionDeliveryGuard: Object.assign(async () => {
            assertOwner();
            await guard();
            assertOwner();
          }, { onSettled: guard.onSettled }),
          onQueueAcceptanceStarted: () => { queueAcceptanceStarted = true; },
        });
        if (queued?.ok === false) return queued;
        return { ok: true, agentKind, wakeKind: 'queued', targetTitle: row.title,
          targetLastUserSendAt: row.userSendAt == null ? null : new Date(row.userSendAt).toISOString() };
      });
    } catch (error) {
      // Once the queue may contain this input, even the same error code can
      // mean a failed acknowledgement rather than a refusal to deliver.
      if (queueAcceptanceStarted) throw error;
      if (isTaskActionRevoked(error))
        return { ok: false, errorCode: 'UNSUPPORTED_CAPABILITY', message: 'Task action authorization expired; no message was sent.' };
      if ((isIpcError(error) && error.code === 'PRECONDITION_FAILED') ||
          (error instanceof Error && error.message === 'input cancelled before acceptance')) {
        return { ok: false, errorCode: 'HOST_NOT_READY',
          message: uiText('ipcError.PRECONDITION_FAILED', 'This action isn’t available in the current state.') };
      }
      throw error;
    }
  }

  const create = createRemoteSessionOpener({
    openSession,
    captureOwner: () => captureOwner(true),
    withSessionLock: withSendToSessionLock,
    sessionExists: async id => Boolean((await getDbClient().drizzle.select({ id: sessions.id })
      .from(sessions).where(eq(sessions.id, id)).limit(1))[0]),
    resolveProject: resolveSessionProject,
    validateDirectory: validateHandoffWorkingDir,
    resolveExecution: async input => {
      if (input.agentKind === 'acp' || input.providerId !== undefined)
        throw Object.assign(new Error('Plugin engines are not supported on this Host'), { code: 'UNSUPPORTED_CAPABILITY' });
      if (input.agentDeviceId && !ports.isSelfDeviceId(input.agentDeviceId))
        throw Object.assign(new Error('This Host runs tasks locally'), { code: 'PROVIDER_ROUTE_UNAVAILABLE' });
      const assertOwner = captureOwner(true);
      await getHostNewMakerDefaultsByVendor();
      const route = getSelectedNewMakerRoute(activeOwnerScopeKey());
      const source = route ? {
        agentKind: route.harness === 'claude' ? 'claude-code' as const : route.harness,
        model: route.model, providerId: route.providerId,
        effort: (route.effort || undefined) as Effort | undefined, fastMode: route.fastMode,
      } : undefined;
      const agent = input.agentKind ?? source?.agentKind;
      const views = await ports.readProviders();
      assertOwner();
      const execution = resolveSessionExecutionSelection({
        selection: { ...input, fastMode: input.fast },
        source,
        availableAgents: ports.agents(),
        availableModels: agent ? views.flatMap(provider => provider.models[agent] ?? []) : [],
        providerRouting: buildLocalProviderRoutingContext(views),
        hasCindyAiApiKey: ports.hasCindyAiApiKey(),
      });
      ports.assertProviderExecutionSupported('', execution.providerId);
      return execution;
    },
    prepareWorktree: async (id, directory) => {
      const assertOwner = captureOwner(true);
      const prepared = await prepareHandoffWorktree({
        getForSession, listAll, detectCwd: ports.worktree.detect, listBranches: ports.worktree.listBranches,
        suggestName: ports.worktree.suggestName, createId: () => id, resolveFreshSource: resolveFreshSourceBranch,
        createWorktree: request => ports.worktree.createWorktree(request, { awaitFullCheckout: true, assertWriteAllowed: assertOwner }),
      }, undefined, directory);
      return prepared.ok ? { ok: true, path: prepared.meta.path }
        : { ok: false, errorCode: 'WORKTREE_UNAVAILABLE', message: prepared.message };
    },
    discardWorktree: (id, path, assertOwner) => ports.worktree.discardPrecreatedWorktree(id, path, {
      canRemove: async () => { assertOwner(); return true; },
    }),
    openSessionCommit: async (row, assertCurrent) => {
      const db = getDbClient();
      assertCurrent();
      await db.drizzle.insert(sessions).values(row).run();
    },
    broadcastCreated: ports.broadcastCreated,
  });
  return {
    send, create, listProjects,
    async readModels(request: OrcaRemoteWorkerModelsRequest) {
      const assertOwner = captureOwner();
      assertOwner();
      if (request.agentDeviceId)
        throwIpcError('UNSUPPORTED_CAPABILITY', 'This Host runs tasks locally');
      const views = await ports.readProviders();
      assertOwner();
      const available = ports.agents();
      if (request.agent === 'acp') {
        return { agentDeviceId: null, pluginEngines: pluginEngineDescriptors() };
      }
      const agents = request.agent ? [request.agent] : available;
      const pluginEngines = !request.agent ? pluginEngineDescriptors() : [];
      return { agentDeviceId: null, ...Object.fromEntries(agents.map(agent => [
        agent === 'claude-code' ? 'claude_code' : agent,
        available.includes(agent) ? deviceAvailableModels(views, agent) : [],
      ])), ...(pluginEngines.length ? { pluginEngines } : {}) };
    },
  };
}
