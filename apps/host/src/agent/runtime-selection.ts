import type { AgentKind, Maker } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  performSessionAgentSwitch,
  projectPendingAgentSwitchIntent,
  type MakerSessionAgentSwitchHandlerDeps,
} from '../../../desktop/src/main/maker-ipc/sessionAgentSwitchHandler.ts';
import {
  createAgentSwitchBoundaryInsert,
  createAgentSwitchDbApply,
  readAgentSwitchSessionRow,
} from '../../../desktop/src/main/maker-ipc/agentSwitchDepsCore.ts';
import {
  applyAgentSwitchResumeFallbackAtomicallyWithPorts,
  applyAgentSwitchToSessionRowWithPorts,
  findParkedEngineSession,
} from '../../../desktop/src/main/localDb/agentSwitchRows.ts';
import { listMessagesForAgentHandoff } from '../../../desktop/src/main/localDb/agentHandoffHistory.ts';
import {
  createHandleSetModel,
  type SessionRuntimeSelectionPorts,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeSelectionApply.ts';
import {
  createSessionRuntimeProjection,
  createUpdateScheduledPreference,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeProjection.ts';
import { createResolvePendingRuntimeAxisPatch } from '../../../desktop/src/main/maker-ipc/pendingRuntimeAxisPatch.ts';
import { assertModelRouteUsableWith } from '../../../desktop/src/main/maker-ipc/modelRouteAdmission.ts';
import { verdictForModelRouteWithProviders } from '../../../desktop/src/main/maker-host/model-route-guard-catalog.ts';
import { persistSessionFieldsWith } from '../../../desktop/src/main/localDb/sessionFieldPersistence.ts';
import { readSessionSource } from '../../../desktop/src/main/localDb/sessionDispatchSnapshot.ts';
import {
  recordUserSessionRuntimeMutation,
  sessionRuntimeGenerationMatches,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeControl.ts';
import { createSharedTaskSettingGuard } from '../../../desktop/src/main/maker-ipc/sharedTaskSetting.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { withRehydrateCloseSuppressed } from '../../../desktop/src/main/maker-host/rehydrateCloseSuppression.ts';
import { setSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { messages } from '../../../desktop/src/main/localDb/schema.ts';
import { messageToCamel } from '../../../desktop/src/main/localDb/mapper.ts';
import { getActiveAppSession } from '../../../desktop/src/main/appSessionState.ts';
import { CredentialModeSwitchBusyError } from '../../../desktop/src/main/maker-host/codex-credential-switch.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import * as broadcastTap from '../../../desktop/src/main/device-link/broadcast-tap.js';
import type { Logger } from '../../../desktop/src/main/logger.ts';
import { recordHostContextSnapshot } from './context-usage.ts';
import { rememberSessionLastLiveUsage } from '../../../desktop/src/main/maker-ipc/sessionLastLiveUsage.ts';

/** What the Host's runtime selection reads from the rest of the Host (main.ts binds it). */
export interface HostRuntimeSelectionDeps {
  getMaker(): Maker;
  /** Publishes a Host event (the event hub). */
  publish(event: Record<string, unknown>): void;
  /** Writes a message row of a task (the Host's message store). */
  createDbMessage(sessionId: string, body: Record<string, unknown>): Promise<unknown>;
  /** The pending handoff summary registry (one for the Host process). */
  pendingHandoff: {
    set(sessionId: string, handoff: string, expectedGeneration?: number): void;
    readGeneration(sessionId: string): number;
    peek?(sessionId: string): Promise<string | null>;
  };
  /** The providers the Host can route to, as its model settings list them. */
  listProviderViews(): Promise<ProviderView[]>;
  /** A route's configured window with a task's window budget (start-options). */
  resolveConfiguredContextWindow: SessionRuntimeSelectionPorts['resolveConfiguredContextWindow'];
  readStoredSessionContextWindowBudget: SessionRuntimeSelectionPorts['readStoredSessionContextWindowBudget'];
  /** The Codex proxy's credential injection state (codex-runtime.ts). */
  codexProxyAuthInjectionState(): ReturnType<SessionRuntimeSelectionPorts['getCodexProxyAuthInjectionState']>;
  /** The current owner runtime's input queue: its rollover, coordinator and executor facts. */
  inputQueue: {
    contextRecoveryRollover(): SessionRuntimeSelectionPorts['contextOverflowRolloverHolder'];
    sessionDbAgentKind(sessionId: string): 'cc' | 'codex' | 'pi' | null;
    isTurnRunning(sessionId: string): boolean;
    wakeSession(sessionId: string, reason: string): void;
    refreshQueuedRoute(sessionId: string, route: Record<string, unknown>): void;
    cancelUsageLimitWait(sessionId: string): void;
  };
  log: Logger;
}

type OwnerScope = ReturnType<typeof broadcastTap.captureDataOwnerBroadcastScope> | null;

/**
 * A model or engine change of a task on the Host, with the desktop's steps: the shared pending
 * switch registry (an intent until the next send), the desktop's engine switch
 * (performSessionAgentSwitch) and model change (handleSetModel, sessionRuntimeSelectionApply.ts), and
 * the send-time landing in the shared send transaction. Ports are bound here; each binding that is
 * not the desktop's own function names why (design: checkpoint 3 port table).
 */
export function createHostRuntimeSelection(deps: HostRuntimeSelectionDeps) {
  const maker = () => deps.getMaker();
  const pendingSwitches = createPendingAgentSwitchRegistry();
  // As sessionSpendBroadcaster.ts and localDb/ipc/sessions.ts bind them: the same broadcast tap.
  const captureOwnerScope = (): OwnerScope => broadcastTap.captureDataOwnerBroadcastScope?.() ?? null;
  const isOwnerScopeCurrent = (scope: OwnerScope) =>
    scope === null || broadcastTap.isDataOwnerBroadcastScopeCurrent?.(scope) !== false;
  const broadcastSessionPatched = (sessionId: string, patch: Record<string, unknown>, ownerScope?: OwnerScope) => {
    if (ownerScope !== undefined && !isOwnerScopeCurrent(ownerScope)) return;
    deps.publish({ type: 'session_changed', sessionId, patch });
  };
  const providerService = () => ({ listProviders: () => deps.listProviderViews() });
  const verdictForModelRoute = (agent: AgentKind, model: string, providerId: string | null) =>
    verdictForModelRouteWithProviders(() => deps.listProviderViews(), agent, model, providerId);
  const assertModelRouteUsable: SessionRuntimeSelectionPorts['assertModelRouteUsable'] =
    (agent, model, providerId, remoteHostId, unavailableCode) => assertModelRouteUsableWith({
      // The Host refuses SSH tasks before any of this runs (send-preflight.ts).
      listSshCodexProviders: async () => { throw new Error('Host does not run SSH tasks'); },
      verdictForModelRoute,
    }, agent, model, providerId, remoteHostId, unavailableCode);
  const { broadcastSessionRuntimeProjection } = createSessionRuntimeProjection({ broadcastSessionPatched });
  const updateScheduledPreference = createUpdateScheduledPreference({ broadcastSessionRuntimeProjection });
  const resolvePendingRuntimeAxisPatch = createResolvePendingRuntimeAxisPatch({
    getDesktopProviderService: providerService as unknown as SessionRuntimeSelectionPorts['getDesktopProviderService'],
    log: deps.log,
  });

  const agentSwitchDeps: MakerSessionAgentSwitchHandlerDeps = {
    readOwnerGeneration: () => getActiveAppSession().generation,
    peekPendingHandoff: deps.pendingHandoff.peek ? sessionId => deps.pendingHandoff.peek!(sessionId) : undefined,
    withSessionLock: withSendToSessionLock,
    // A task whose Agent runs on another computer is refused on the Host (send-preflight.ts).
    assertModelRouteUsable: async (agent, model, providerId) => assertModelRouteUsable(agent, model, providerId),
    getSessionRow: readAgentSwitchSessionRow,
    getLiveSession: sessionId => maker().getSession(sessionId),
    closeSession: sessionId => maker().closeSession(sessionId, 'agent-switch'),
    listMessagesForHandoff: (sessionId, after) => listMessagesForAgentHandoff(sessionId, 400, after),
    findParkedEngineSession: (sessionId, targetDbKind, fromAgentDeviceId) =>
      findParkedEngineSession(sessionId, targetDbKind, fromAgentDeviceId),
    applyAgentSwitchToDb: createAgentSwitchDbApply(
      (sessionId, patch) => applyAgentSwitchToSessionRowWithPorts(sessionId, patch,
        { captureOwnerScope, isOwnerScopeCurrent, broadcastSessionPatched }),
      deps.resolveConfiguredContextWindow,
    ),
    setSessionProvider,
    insertBoundaryMessage: createAgentSwitchBoundaryInsert((sessionId, body) => deps.createDbMessage(sessionId, body)),
    applyResumeFallbackAtomically: (sessionId, boundaryClientId, content) =>
      applyAgentSwitchResumeFallbackAtomicallyWithPorts(sessionId, boundaryClientId, content, {
        captureOwnerScope, isOwnerScopeCurrent, broadcastSessionPatched,
        // As the desktop's rebroadcastAgentSwitchBoundary (localDb/ipc/messages.ts): the boundary row
        // as stored, shown only to the owner of the moment of the write.
        rebroadcastAgentSwitchBoundary: async (sessionId, boundaryClientId, ownerScope) => {
          const [row] = await getDbClient().drizzle.select().from(messages)
            .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, boundaryClientId))).limit(1);
          if (row && isOwnerScopeCurrent(ownerScope ?? null)) {
            const message = messageToCamel(row);
            deps.publish({ type: 'message_created', sessionId, messageId: message.id, message });
          }
        },
        log: deps.log,
      }),
    setPendingHandoff: (sessionId, handoff, expectedGeneration) =>
      deps.pendingHandoff.set(sessionId, handoff, expectedGeneration),
    readPendingHandoffGeneration: sessionId => deps.pendingHandoff.readGeneration(sessionId),
    // A switch the Host commits never bootstraps: the send transaction creates the new runtime from
    // the committed row (skipBootstrap); only the desktop's direct sends (Goal, IM, scheduler) do.
    bootstrapSwitchedSession: async () => { throw new Error('Host switches bootstrap at the next send'); },
    withCloseSuppressed: withRehydrateCloseSuppressed,
    pendingSwitches,
    selectSameAgentModel: async (sessionId, intent, applyNow, assertSelectionCurrent, beforeMutation, pendingSelectionAccess) => {
      // The desktop's applySessionRuntimeSelection: handleSetModel without a revision.
      const result = await handleSetModel(sessionId, intent.model, intent.providerId, undefined, {
        effort: (intent.effort ?? null) as never,
        fastMode: intent.fastMode ?? false,
        ...(intent.thinking !== undefined ? { thinking: intent.thinking } : {}),
        ...(intent.confirmedContextWindow ? { confirmedContextWindow: intent.confirmedContextWindow } : {}),
      } as never, { source: 'user', sessionLockHeld: true, applyingUserSelectionOnSend: applyNow,
        runtimeSource: intent.runtimeSource, configStaged: intent.configStaged === true,
        assertSelectionCurrent, beforeMutation, pendingSelectionAccess } as never);
      if ((result as { contextWindowConfirmationRequired?: unknown }).contextWindowConfirmationRequired !== undefined) {
        throwIpcError('PRECONDITION_FAILED', 'Model context window changed or was unknown; select the model again to confirm');
      }
      return result;
    },
    onPendingSwitchChanged: (sessionId, intent) => {
      if (intent) recordUserSessionRuntimeMutation(sessionId);
      broadcastSessionPatched(sessionId, { agentSwitchIntent: intent });
    },
    // The desktop also marks an IM task as detached from its channel default; the Host has no IM.
    onUserRouteSelectionLanded: async sessionId => { await updateScheduledPreference(sessionId, null); },
    log: deps.log,
  } as MakerSessionAgentSwitchHandlerDeps;

  const ports = (): SessionRuntimeSelectionPorts => ({
    maker: maker(),
    agentSwitchPending: pendingSwitches,
    broadcastSessionRuntimeProjection,
    // As the desktop: a review task's settings follow its source task. Taking over a local Agent's
    // visible session is the desktop's local-agent (second batch); the Host has no such runtime.
    assertReviewSettingsUnlocked: async sessionId => {
      if ((await readSessionSource(sessionId)) === 'review') {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Review task settings are fixed to the source task');
      }
    },
    canApplyAutomaticRuntimeSelection: (sessionId, expectedGeneration) =>
      !pendingSwitches.get(sessionId) && sessionRuntimeGenerationMatches(sessionId, expectedGeneration),
    // Tasks whose Agent runs on another computer are refused on the Host (send-preflight.ts).
    applyAgentDeviceRuntimeSelection: async () => { throw new Error('Host does not run tasks on another computer'); },
    assertModelRouteUsable,
    agentSwitchDeps,
    resolvePendingRuntimeAxisPatch,
    rehydrateColdPiRuntimeForWindowVerification: async () => {
      throw new Error('cold Pi window verification is not wired on the Host yet');
    },
    updateScheduledPreference,
    // A teammate's task is refused on the Host; the reconciler only acts on teammate tasks.
    reconcileBotModelRoute: { acceptTaskChoice: async () => {} } as never,
    log: deps.log,
    // The Host's entries do not run inside a Device Link invoke (isDeviceLinkInvoke() is false).
    localModelWindowSwitchErrorCode: code => code,
    wakeSessionInputAfterCredentialSwitch: sessionId => deps.inputQueue.wakeSession(sessionId, 'credential-switch-applied-inline'),
    // Pending credential switches: not wired yet (checkpoint 3, desktop prep unit in progress).
    pendingCredentialSwitchHolder: null,
    clearPendingCredentialSwitchForSession: (sessionId, opts) => {
      if (opts?.wake !== false) deps.inputQueue.wakeSession(sessionId, 'pending-credential-switch-cancelled');
    },
    // The desktop's sessionTurnActivityTracker: in a turn from the runtime's foreground running status
    // to its end. The executor's own turn record is open for the very send a pick lands in, so it is
    // not that; the task's runtime reports the same as the tracker here.
    isSessionInTurn: sessionId => maker().getSession(sessionId)?.isTurnRunning?.() === true,
    contextOverflowRolloverHolder: deps.inputQueue.contextRecoveryRollover(),
    getPendingCredentialSwitchTarget: () => undefined,
    // The Host's entries are not a shared task's guest (no Device Link invoke context).
    captureSharedTaskSettingGuard: sessionId => createSharedTaskSettingGuard(undefined, sessionId, { admitted: false }),
    registerPendingCredentialSwitchForSession: async sessionId => {
      throw new CredentialModeSwitchBusyError([sessionId], `Cannot switch provider route while the session is busy: ${sessionId}`);
    },
    agentInputCoordinatorHolder: { refreshQueuedRoute: (sessionId: string, route: Record<string, unknown>) =>
      deps.inputQueue.refreshQueuedRoute(sessionId, route) } as never,
    getSessionDbAgentKind: sessionId => deps.inputQueue.sessionDbAgentKind(sessionId),
    broadcastSessionPatched: broadcastSessionPatched as SessionRuntimeSelectionPorts['broadcastSessionPatched'],
    persistSessionFields: (sessionId, patch) => persistSessionFieldsWith({
      captureOwnerScope, isOwnerScopeCurrent, broadcastSessionPatched,
      // The window budget hook of the session settings; a model change never carries a budget.
      applyContextWindowBudget: () => undefined,
    }, sessionId, patch),
    // A Device Link set-model's write-back marker: the Host has no Device Link set-model.
    markRemoteSettingPersistedInsideHandler: () => {},
    getDesktopProviderService: providerService as unknown as SessionRuntimeSelectionPorts['getDesktopProviderService'],
    resolveConfiguredContextWindow: deps.resolveConfiguredContextWindow,
    readStoredSessionContextWindowBudget: deps.readStoredSessionContextWindowBudget,
    listSshCodexProviders: async () => { throw new Error('Host does not run SSH tasks'); },
    getCodexProxyAuthInjectionState: () => deps.codexProxyAuthInjectionState(),
    recordSessionContextSnapshot: recordHostContextSnapshot,
  });
  const handleSetModel = createHandleSetModel(ports);

  return {
    pendingSwitches,
    agentSwitchDeps,
    /** The intent of a task as clients see it (session_changed, the task snapshot). */
    projectIntent: (sessionId: string) => projectPendingAgentSwitchIntent(pendingSwitches.get(sessionId)),
    /** A model change a client asks for: the desktop's set-model (source 'user'). */
    setModel(sessionId: string, model: unknown, providerId: unknown, revision: unknown, selection: unknown) {
      deps.inputQueue.cancelUsageLimitWait(sessionId);
      return handleSetModel(sessionId, model as never, providerId as never, revision as never, selection as never,
        { source: 'user' } as never);
    },
    /** An engine change a client asks for: the desktop's switch-session-agent, under the task's lock. */
    switchAgent(params: Parameters<typeof performSessionAgentSwitch>[1]) {
      return withSendToSessionLock(params.sessionId as string, () => performSessionAgentSwitch(agentSwitchDeps, params));
    },
    /** The send transaction's landing of a picked model or engine (the desktop's register.ts 18488). */
    applyPendingAgentSwitch: (sessionId: string, options?: { signal?: AbortSignal }) =>
      applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId, options?.signal ? { signal: options.signal } : undefined),
    clearIntent(sessionId: string) {
      pendingSwitches.clear(sessionId);
    },
    /**
     * A runtime of a task closed (the Maker's session:closed, from the session's own close): the
     * desktop's finalizeClosedSession keeps its last live usage for a cold Pi model change's window
     * check (sessionLastLiveUsage.ts), read from the closed session as the desktop reads it.
     */
    onSessionClosed(sessionId: string, session: { getUsageSnapshot?(): { contextTokens?: number; contextWindow?: number } | undefined }) {
      rememberSessionLastLiveUsage(sessionId, session.getUsageSnapshot?.() as never);
    },
    /** Subscribes to a Maker's session-closed events (each session's own close); returns the unsubscribe. */
    attachMaker(target: Pick<Maker, 'on'>): () => void {
      return target.on(event => {
        if (event.type === 'session:closed') this.onSessionClosed(event.sessionId, event.session);
      });
    },
  };
}
