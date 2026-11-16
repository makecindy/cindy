import type { AgentKind, Maker, Session } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  performSessionAgentSwitch,
  projectPendingAgentSwitchIntent,
  type MakerSessionAgentSwitchHandlerDeps,
} from '../../../desktop/src/main/maker-ipc/sessionAgentSwitchHandler.ts';
import {
  createSwitchedSessionBootstrap,
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
  type InternalRuntimeSelectionOptions,
  type SessionRuntimeSelectionPorts,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeSelectionApply.ts';
import {
  createCanApplyAutomaticRuntimeSelection,
  createReadSessionRuntimeProfiles,
  createRecoverRenamedSessionModelOnSend,
  createSelectSameAgentModel,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeSelectionLanding.ts';
import {
  createApplyPiPendingSelection,
  createPendingCredentialSwitchService,
} from '../../../desktop/src/main/maker-ipc/pendingCredentialSwitchAssembly.ts';
import {
  clearPendingCredentialSwitchWith,
  getPendingCredentialSwitchTargetWith,
  registerPendingCredentialSwitchWith,
  wakeSessionInputAfterCredentialSwitchWith,
  type PendingCredentialSwitchAccessPorts,
} from '../../../desktop/src/main/maker-ipc/pendingCredentialSwitchAccess.ts';
import { createColdPiRehydrationForWindowVerification } from '../../../desktop/src/main/maker-ipc/coldPiRehydration.ts';
import { directoryGrantsForRuntime } from '../../../desktop/src/main/maker-ipc/extraDirsValidator.ts';
import { setPendingCredentialSwitchReader } from '../../../desktop/src/main/maker-host/provider-route.ts';
import { setThinkingEnabledInMemory } from '../../../desktop/src/main/maker-host/newMakerDefaultsCache.ts';
import { MAKER_PUSH } from '../../../desktop/src/main/maker-ipc/channels.ts';
import type { AgentInputCoordinator } from '../../../desktop/src/main/maker-ipc/agent-input-coordinator.desktop.ts';
import {
  createSessionRuntimeProjection,
  createUpdateScheduledPreference,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeProjection.ts';
import { createResolvePendingRuntimeAxisPatch } from '../../../desktop/src/main/maker-ipc/pendingRuntimeAxisPatch.ts';
import { assertModelRouteUsableWith } from '../../../desktop/src/main/maker-ipc/modelRouteAdmission.ts';
import {
  resolveLenientSessionRouteWithProviders,
  verdictForModelRouteWithProviders,
} from '../../../desktop/src/main/maker-host/model-route-guard-catalog.ts';
import { persistSessionFieldsWith } from '../../../desktop/src/main/localDb/sessionFieldPersistence.ts';
import { readSessionSource } from '../../../desktop/src/main/localDb/sessionDispatchSnapshot.ts';
import { recordUserSessionRuntimeMutation } from '../../../desktop/src/main/maker-ipc/sessionRuntimeControl.ts';
import { createSharedTaskSettingGuard } from '../../../desktop/src/main/maker-ipc/sharedTaskSetting.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { withRehydrateCloseSuppressed } from '../../../desktop/src/main/maker-host/rehydrateCloseSuppression.ts';
import { setSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { messages, sessions } from '../../../desktop/src/main/localDb/schema.ts';
import { messageToCamel } from '../../../desktop/src/main/localDb/mapper.ts';
import { getActiveAppSession } from '../../../desktop/src/main/appSessionState.ts';
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
    wakeSession: AgentInputCoordinator['wakeSession'];
    refreshQueuedRoute: AgentInputCoordinator['refreshQueuedRoute'];
    cancelUsageLimitWait(sessionId: string): void;
    /** Starting a task's runtime outside a turn, as a send starts it (turn-executor.mjs startPorts). */
    startPorts(): HostRuntimeStartPorts;
  };
  log: Logger;
}

/** The executor's runtime start functions (turn-executor.mjs startPorts), as the desktop's send transaction has them. */
export interface HostRuntimeStartPorts {
  /** Returns the options with the stderr capture (the desktop's CreateOpts, whose remoteHostId is optional). */
  buildCreateOptsWithStderr<O extends object>(opts: O): O & { remoteHostId?: string | null };
  checkWorkDirExists(sessionId: string, workingDir: string | undefined, agentKind: string, remoteHostId: string | null | undefined): Promise<boolean>;
  synthesizeOrcaVendorOptionsFromDb(sessionId: string, opts: object): Promise<unknown>;
  readSessionExtraDirsFromDb(sessionId: string): Promise<string[]>;
  readSessionWritableDirsFromDb(sessionId: string): Promise<string[]>;
  ensureRemoteReadyForSessionStart(params: { createOpts?: unknown }): Promise<unknown>;
  bootstrapSession(opts: object, assertAccess?: () => void, nativeHistoryResume?: boolean): Promise<unknown>;
  broadcastSessionCreated(sessionId: string): void;
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
  const broadcastSessionPatched: SessionRuntimeSelectionPorts['broadcastSessionPatched'] = (sessionId, patch, ownerScope) => {
    if (ownerScope !== undefined && !isOwnerScopeCurrent(ownerScope ?? null)) return;
    deps.publish({ type: 'session_changed', sessionId, patch });
  };
  // The provider service's member the shared bodies call (listProviders), over the Host's listing.
  const providerService: SessionRuntimeSelectionPorts['getDesktopProviderService'] =
    () => ({ listProviders: () => deps.listProviderViews() });
  const verdictForModelRoute = (agent: AgentKind, model: string, providerId: string | null) =>
    verdictForModelRouteWithProviders(() => deps.listProviderViews(), agent, model, providerId);
  const assertModelRouteUsable: SessionRuntimeSelectionPorts['assertModelRouteUsable'] =
    (agent, model, providerId, remoteHostId, unavailableCode) => assertModelRouteUsableWith({
      // The Host refuses SSH tasks before any of this runs (send-preflight.ts).
      listSshCodexProviders: async () => throwIpcError('UNSUPPORTED_CAPABILITY', 'Host does not yet support remote execution'),
      verdictForModelRoute,
    }, agent, model, providerId, remoteHostId, unavailableCode);
  const { broadcastSessionRuntimeProjection } = createSessionRuntimeProjection({ broadcastSessionPatched });
  const updateScheduledPreference = createUpdateScheduledPreference({ broadcastSessionRuntimeProjection });
  const resolvePendingRuntimeAxisPatch = createResolvePendingRuntimeAxisPatch({
    getDesktopProviderService: providerService,
    log: deps.log,
  });
  // As register.ts: the same-engine pick an intent lands as, through applySessionRuntimeSelection
  // (handleSetModel without a revision), read at call time because handleSetModel is assigned below.
  const applySessionRuntimeSelection: Parameters<typeof createSelectSameAgentModel>[0]['applySessionRuntimeSelection'] =
    (sessionId, model, providerId, selection, options) =>
      handleSetModel(sessionId, model, providerId, undefined, selection, options);
  const canApplyAutomaticRuntimeSelection = createCanApplyAutomaticRuntimeSelection({ agentSwitchPending: pendingSwitches });
  const coordinatorRoute: Pick<AgentInputCoordinator, 'refreshQueuedRoute'> = {
    refreshQueuedRoute: (...args) => deps.inputQueue.refreshQueuedRoute(...args),
  };
  const coordinatorWake: Pick<AgentInputCoordinator, 'wakeSession'> = {
    wakeSession: (...args) => deps.inputQueue.wakeSession(...args),
  };
  // The Maker members the pending credential switch reads; the owner runtime's Maker at each call.
  const pendingSwitchMaker = {
    listActiveSessions: () => maker().listActiveSessions(),
    closeSession: (sessionId: string, reason?: 'runtime-refresh') => maker().closeSession(sessionId, reason),
  };
  // As register.ts: the pending credential switch service, assembled before handleSetModel exists;
  // its Pi transaction is read at call time (createApplyPiPendingSelection below).
  let applyPiPendingSelection: ReturnType<typeof createApplyPiPendingSelection> | null = null;
  const pendingCredentialSwitchService = createPendingCredentialSwitchService({
    maker: pendingSwitchMaker,
    isSessionInTurn: sessionId => isSessionInTurn(sessionId),
    applyPiPendingSelection: (sessionId, target, resolved, isCurrent) => {
      if (!applyPiPendingSelection) throw new Error('Pi model selection is not ready');
      return applyPiPendingSelection(sessionId, target, resolved, isCurrent);
    },
    // The desktop broadcasts these to its windows; the Host sends them on its event stream.
    broadcastToAllWindows: (channel, payload) => deps.publish({ type: 'plugin_push', channel, payload }),
    inputCoordinator: coordinatorWake,
    resolveLenientSessionRoute: (agent, model, providerId, opts) =>
      resolveLenientSessionRouteWithProviders(() => deps.listProviderViews(), agent, model, providerId, opts),
    getSessionDbAgentKind: sessionId => deps.inputQueue.sessionDbAgentKind(sessionId),
    getDesktopProviderService: providerService,
    resolveConfiguredContextWindow: deps.resolveConfiguredContextWindow,
    agentInputCoordinatorHolder: coordinatorRoute,
    broadcastSessionPatched,
    log: deps.log,
  });
  // As register.ts: the proxy's synchronous routing reads a task's pending switch.
  setPendingCredentialSwitchReader((sessionId) => {
    const pending = pendingCredentialSwitchService.get(sessionId);
    return pending
      ? {
          model: pending.model,
          providerId: pending.providerId,
          ...(pending.previousRoute?.model ? { previousModel: pending.previousRoute.model } : {}),
        }
      : undefined;
  });
  // The shared register / clear / wake / read of a pending switch (register.ts pendingCredentialSwitchPorts).
  const accessPorts = (): PendingCredentialSwitchAccessPorts => ({
    pendingCredentialSwitchHolder: pendingCredentialSwitchService,
    agentInputCoordinatorHolder: coordinatorWake,
    getSessionDbAgentKind: sessionId => deps.inputQueue.sessionDbAgentKind(sessionId),
    getMaker: maker,
  });
  // The desktop's sessionTurnActivityTracker: in a turn from the runtime's foreground running status
  // to its end. The executor's own turn record is open for the very send a pick lands in, so it is
  // not that; the task's runtime reports the same as the tracker here.
  const isSessionInTurn = (sessionId: string) => maker().getSession(sessionId)?.isTurnRunning?.() === true;
  // As register.ts createColdPiRehydrationForWindowVerification, with the Host's runtime start
  // functions (the ones its send transaction uses) in place of the desktop's.
  const rehydrateColdPiRuntimeForWindowVerification = createColdPiRehydrationForWindowVerification({
    hasLiveSession: (sessionId) => !!maker().getSession(sessionId),
    loadSessionRow: async (sessionId) => {
      const [row] = await getDbClient()
        .drizzle.select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row;
    },
    buildCreateOpts: (sessionId, row) =>
      deps.inputQueue.startPorts().buildCreateOptsWithStderr({
        id: sessionId,
        agentKind: 'pi',
        workingDir: row.workingDir,
        model: row.model,
        providerId: row.providerId,
        effort: row.effort ?? undefined,
        fastMode: (row.fastMode ?? false),
        permissionMode: row.permissionMode ?? 'ask',
        planMode: !!row.planModeEnabled,
        title: row.title ?? undefined,
        resumeSessionId: row.sdkSessionId,
        orcaRole: row.orcaRole ?? undefined,
      }),
    checkWorkDirExists: (sessionId, workingDir, agentKind, remoteHostId) =>
      deps.inputQueue.startPorts().checkWorkDirExists(sessionId, workingDir, agentKind, remoteHostId),
    prepareCreateOpts: async (sessionId, createOpts) => {
      await deps.inputQueue.startPorts().synthesizeOrcaVendorOptionsFromDb(sessionId, createOpts);
      const extraDirs = await deps.inputQueue.startPorts().readSessionExtraDirsFromDb(sessionId);
      Object.assign(createOpts, directoryGrantsForRuntime(extraDirs));
    },
    bootstrapSession: (createOpts) => deps.inputQueue.startPorts().bootstrapSession(createOpts),
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
    // As register.ts: the committed switch's runtime from its row. A landing at the send skips it
    // (the send transaction starts the runtime), but a switch back to an engine with a parked native
    // session starts it at once to see whether the resume holds (sessionAgentSwitchHandler.ts). The
    // start functions are the executor's (its send transaction's); no IM channel resolves vendor
    // options on the Host, as on a desktop without IM.
    bootstrapSwitchedSession: createSwitchedSessionBootstrap({
      getActiveAppSession,
      buildCreateOptsWithStderr: opts => deps.inputQueue.startPorts().buildCreateOptsWithStderr(opts),
      resolveSwitchedSessionVendorOptions: () => undefined,
      synthesizeOrcaVendorOptionsFromDb: (sessionId, opts) => deps.inputQueue.startPorts().synthesizeOrcaVendorOptionsFromDb(sessionId, opts),
      readSessionExtraDirsFromDb: sessionId => deps.inputQueue.startPorts().readSessionExtraDirsFromDb(sessionId),
      directoryGrantsForRuntime,
      readSessionWritableDirsFromDb: sessionId => deps.inputQueue.startPorts().readSessionWritableDirsFromDb(sessionId),
      ensureRemoteReadyForSessionStart: params => deps.inputQueue.startPorts().ensureRemoteReadyForSessionStart(params),
      bootstrapSession: (opts, assertAccess, nativeHistoryResume) =>
        deps.inputQueue.startPorts().bootstrapSession(opts, assertAccess, nativeHistoryResume),
      broadcastSessionCreated: sessionId => deps.inputQueue.startPorts().broadcastSessionCreated(sessionId),
      log: deps.log,
    }),
    // As register.ts: an engine pick replaces a credential switch registered before it.
    supersedePendingCredentialSwitch: sessionId => clearPendingCredentialSwitchWith(accessPorts(), sessionId),
    // As register.ts: a committed switch's thinking choice goes to the preference mirror the next
    // runtime start reads (start-options.ts getThinkingEnabledFromMemory), and to the clients' memory.
    rememberThinkingIntent: ({ agentKind, providerId, model, thinking }) => {
      setThinkingEnabledInMemory(agentKind, providerId, model, thinking);
      deps.publish({ type: 'plugin_push', channel: MAKER_PUSH.DRAFT_PREF_APPLY, payload: {
        agent: agentKind,
        providerId: providerId ?? '',
        modelId: model,
        active: false,
        thinking,
      } });
    },
    withCloseSuppressed: withRehydrateCloseSuppressed,
    pendingSwitches,
    selectSameAgentModel: createSelectSameAgentModel({ applySessionRuntimeSelection }),
    onPendingSwitchChanged: (sessionId, intent) => {
      if (intent) recordUserSessionRuntimeMutation(sessionId);
      broadcastSessionPatched(sessionId, { agentSwitchIntent: intent });
    },
    // The desktop also marks an IM task as detached from its channel default; the Host has no IM.
    onUserRouteSelectionLanded: async sessionId => { await updateScheduledPreference(sessionId, null); },
    log: deps.log,
  };

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
    canApplyAutomaticRuntimeSelection,
    // Tasks whose Agent runs on another computer are refused on the Host (send-preflight.ts).
    applyAgentDeviceRuntimeSelection: async () => throwIpcError('UNSUPPORTED_CAPABILITY', 'Host does not yet support remote execution'),
    assertModelRouteUsable,
    agentSwitchDeps,
    resolvePendingRuntimeAxisPatch,
    rehydrateColdPiRuntimeForWindowVerification,
    updateScheduledPreference,
    // A teammate's task is refused on the Host; the reconciler only acts on teammate tasks.
    reconcileBotModelRoute: { acceptTaskChoice: async () => {} },
    log: deps.log,
    // The Host's entries do not run inside a Device Link invoke (isDeviceLinkInvoke() is false).
    localModelWindowSwitchErrorCode: code => code,
    wakeSessionInputAfterCredentialSwitch: sessionId => wakeSessionInputAfterCredentialSwitchWith(accessPorts(), sessionId),
    pendingCredentialSwitchHolder: pendingCredentialSwitchService,
    clearPendingCredentialSwitchForSession: (sessionId, opts) => clearPendingCredentialSwitchWith(accessPorts(), sessionId, opts),
    isSessionInTurn,
    contextOverflowRolloverHolder: deps.inputQueue.contextRecoveryRollover(),
    getPendingCredentialSwitchTarget: sessionId => getPendingCredentialSwitchTargetWith(accessPorts(), sessionId),
    // The Host's entries are not a shared task's guest (no Device Link invoke context).
    captureSharedTaskSettingGuard: sessionId => createSharedTaskSettingGuard(undefined, sessionId, { admitted: false }),
    registerPendingCredentialSwitchForSession: (sessionId, target) =>
      registerPendingCredentialSwitchWith(accessPorts(), sessionId, target),
    agentInputCoordinatorHolder: coordinatorRoute,
    getSessionDbAgentKind: sessionId => deps.inputQueue.sessionDbAgentKind(sessionId),
    broadcastSessionPatched,
    persistSessionFields: (sessionId, patch) => persistSessionFieldsWith({
      captureOwnerScope, isOwnerScopeCurrent, broadcastSessionPatched,
      // The window budget hook of the session settings; a model change never carries a budget.
      applyContextWindowBudget: () => undefined,
    }, sessionId, patch),
    // A Device Link set-model's write-back marker: the Host has no Device Link set-model.
    markRemoteSettingPersistedInsideHandler: () => {},
    getDesktopProviderService: providerService,
    resolveConfiguredContextWindow: deps.resolveConfiguredContextWindow,
    readStoredSessionContextWindowBudget: deps.readStoredSessionContextWindowBudget,
    listSshCodexProviders: async () => throwIpcError('UNSUPPORTED_CAPABILITY', 'Host does not yet support remote execution'),
    getCodexProxyAuthInjectionState: () => deps.codexProxyAuthInjectionState(),
    recordSessionContextSnapshot: recordHostContextSnapshot,
  });
  const handleSetModel = createHandleSetModel(ports);
  applyPiPendingSelection = createApplyPiPendingSelection({ handleSetModel });
  const readSessionRuntimeProfiles = createReadSessionRuntimeProfiles({
    maker: { getSessionMeta: sessionId => maker().getSessionMeta(sessionId), getSession: sessionId => maker().getSession(sessionId) },
    agentSwitchPending: pendingSwitches,
    log: deps.log,
  });
  const recoverRenamedSessionModelOnSend = createRecoverRenamedSessionModelOnSend({
    agentSwitchPending: pendingSwitches, getDesktopProviderService: providerService, readSessionRuntimeProfiles, handleSetModel,
  });
  /**
   * A runtime of a task closed (the Maker's session:closed, from the session's own close), finalized
   * in the desktop's order: finalizeClosedSession keeps its last live usage for a cold Pi model
   * change's window check (sessionLastLiveUsage.ts), read from the closed session as the desktop reads
   * it; then cleanupClosedSessionRuntime settles its pending credential switch.
   */
  const onSessionClosed = (sessionId: string, session: Pick<Session, 'getUsageSnapshot'>) => {
    rememberSessionLastLiveUsage(sessionId, session.getUsageSnapshot());
    pendingCredentialSwitchService.onSessionClosed(sessionId);
  };

  return {
    pendingSwitches,
    agentSwitchDeps,
    /** The intent of a task as clients see it (session_changed, the task snapshot). */
    projectIntent: (sessionId: string) => projectPendingAgentSwitchIntent(pendingSwitches.get(sessionId)),
    /** A model change a client asks for: the desktop's set-model (source 'user'). */
    setModel(sessionId: string, model: unknown, providerId: unknown, revision: unknown, selection: unknown) {
      deps.inputQueue.cancelUsageLimitWait(sessionId);
      const options: InternalRuntimeSelectionOptions = { source: 'user' };
      return handleSetModel(sessionId, model, providerId, revision, selection, options);
    },
    /** An engine change a client asks for: the desktop's switch-session-agent, under the task's lock. */
    switchAgent(params: Parameters<typeof performSessionAgentSwitch>[1]) {
      // As the desktop's handler: the shared task guard of this entry (no Device Link guest on the
      // Host), and the task's lock when the session id is a string.
      const guard = createSharedTaskSettingGuard(undefined, String(params.sessionId), { admitted: false });
      const run = () => performSessionAgentSwitch(agentSwitchDeps, { ...params, assertSelectionCurrent: guard.admit });
      return typeof params.sessionId === 'string' && params.sessionId ? withSendToSessionLock(params.sessionId, run) : run();
    },
    /**
     * The send transaction's landing of a picked model or engine, with the steps of the desktop's
     * transaction binding (register.ts, createMakerSendTransaction's applyPendingAgentSwitch) in its
     * order: the landing (called as the desktop calls it, without the send's signal), then, for a send
     * that is not scheduled, the recovery of a renamed model. The desktop's other steps are not on the
     * Host yet (release table: the scheduled model scope, the window budget replay, the Orca pending
     * check, the provider group check).
     */
    async applyPendingAgentSwitch(sessionId: string, options?: { signal?: AbortSignal; scheduled?: boolean; clientId?: string }) {
      await applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId);
      if (!options?.scheduled) await recoverRenamedSessionModelOnSend(sessionId);
    },
    /** A task's turn settled (the desktop's settlePendingCredentialSwitch): a pending switch lands now. */
    onTurnSettled(sessionId: string) {
      const pending = pendingCredentialSwitchService.onTurnSettled(sessionId);
      if (!pending) return;
      void pending.catch((err) => {
        deps.log.warn('pending credential switch settle failed', {
          sessionId,
          source: 'host-turn-settled',
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    /** Whether a credential switch waits for this task's turn to end (the coordinator and idle-release gates). */
    hasPendingCredentialSwitch: (sessionId: string) => pendingCredentialSwitchService.has(sessionId),
    clearIntent(sessionId: string) {
      pendingSwitches.clear(sessionId);
    },
    onSessionClosed,
    /** Subscribes to a Maker's session-closed events (each session's own close); returns the unsubscribe. */
    attachMaker(target: Pick<Maker, 'on'>): () => void {
      return target.on(event => {
        if (event.type === 'session:closed') onSessionClosed(event.sessionId, event.session);
      });
    },
  };
}
