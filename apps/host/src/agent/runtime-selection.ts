import type { AgentKind, Effort, Maker, Session } from '@cindy/maker-core';
import type { ProviderView } from '@cindy/model-providers';
import { captureMessageDispatchRoute } from '@cindy/maker-shared/message-source';
import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  performSessionAgentSwitch,
  projectPendingAgentSwitchIntent,
  projectPendingModelGroupTarget,
  type MakerSessionAgentSwitchHandlerDeps,
} from '../../../desktop/src/main/maker-ipc/sessionAgentSwitchHandler.ts';
import {
  createSwitchedSessionBootstrap,
  createAgentSwitchBoundaryInsert,
  createAgentSwitchDbApply,
  createRememberThinkingIntent,
  readAgentSwitchSessionRow,
} from '../../../desktop/src/main/maker-ipc/agentSwitchDepsCore.ts';
import {
  applyAgentSwitchResumeFallbackAtomicallyWithPorts,
  applyAgentSwitchToSessionRowWithPorts,
  findParkedEngineSession,
  rebroadcastAgentSwitchBoundaryWith,
} from '../../../desktop/src/main/localDb/agentSwitchRows.ts';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.js';
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
  createPendingCredentialSwitchRouteReader,
  createPendingCredentialSwitchService,
} from '../../../desktop/src/main/maker-ipc/pendingCredentialSwitchAssembly.ts';
import {
  clearPendingCredentialSwitchWith,
  getPendingCredentialSwitchTargetWith,
  registerPendingCredentialSwitchWith,
  wakeSessionInputAfterCredentialSwitchWith,
  type PendingCredentialSwitchAccessPorts,
} from '../../../desktop/src/main/maker-ipc/pendingCredentialSwitchAccess.ts';
import { createColdPiRehydrationBinding } from '../../../desktop/src/main/maker-ipc/coldPiRehydrationBinding.ts';
import { createBotPermissionSync } from '../../../desktop/src/main/maker-ipc/botPermissionSyncCore.ts';
import {
  commitSessionPermissionModeWith,
  createSetSessionPermissionMode,
  createSetSessionPlanMode,
  persistAgentPlanModeChangeWith,
} from '../../../desktop/src/main/maker-ipc/sessionPermissionSettings.ts';
import { projectDeferredCredentialSwitchIntent } from '../../../desktop/src/main/maker-ipc/pendingCredentialSwitch.ts';
import { createDeferredRestartQueueGate } from '../../../desktop/src/main/maker-ipc/deferredRestartQueueWiring.ts';
import {
  createRecoverRemoteRuntimeAxisPersistence,
  createSetSessionEffort,
  createSetSessionFastMode,
  createSetSessionThinkingEnabled,
  createStagePendingUserRuntimeAxis,
  createUpdateSavedScheduledAxis,
  type ReadUsableAgentDeviceProviders,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeAxisSettings.ts';
import { createSubscriptionFastPolicies } from '../../../desktop/src/main/maker-host/subscriptionFastPolicyCore.ts';
import { directoryGrantsForRuntime } from '../../../desktop/src/main/maker-ipc/extraDirsValidator.ts';
import { setPendingCredentialSwitchReader } from '../../../desktop/src/main/maker-host/provider-route.ts';
import type { AgentInputCoordinator } from '../../../desktop/src/main/maker-ipc/agent-input-coordinator.desktop.ts';
import {
  createSessionRuntimeCleanup,
  createSessionRuntimeProjection,
  createSessionRuntimeProjector,
  createUpdateScheduledPreference,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeProjection.ts';
import { setSessionRuntimeProjector, type SessionRuntimeProjector } from '../../../desktop/src/main/localDb/mapper.ts';
import { setSessionRuntimeCleanup } from '../../../desktop/src/main/localDb/sessionRuntimeCleanup.ts';
import { createResolvePendingRuntimeAxisPatch } from '../../../desktop/src/main/maker-ipc/pendingRuntimeAxisPatch.ts';
import { assertModelRouteUsableWith } from '../../../desktop/src/main/maker-ipc/modelRouteAdmission.ts';
import {
  pinExclusiveSessionProviderWithProviders,
  resolveLenientSessionRouteWithProviders,
  verdictForModelRouteWithProviders,
} from '../../../desktop/src/main/maker-host/model-route-guard-catalog.ts';
import { createLocalRouteAdmission } from '../../../desktop/src/main/maker-ipc/localRouteAdmission.ts';
import { hostManagedLocalModelNotReady } from './pi-native-providers.ts';
import { persistSessionFieldsWith } from '../../../desktop/src/main/localDb/sessionFieldPersistence.ts';
import { readSessionSource } from '../../../desktop/src/main/localDb/sessionDispatchSnapshot.ts';
import {
  clearOwnerScopedSessionRuntimeSelection,
  getSessionRuntimeControlSnapshot,
  recordUserSessionRuntimeMutation,
  type SessionRuntimeProfile,
} from '../../../desktop/src/main/maker-ipc/sessionRuntimeControl.ts';
import { createSharedTaskSettingGuard } from '../../../desktop/src/main/maker-ipc/sharedTaskSetting.ts';
import { withSendToSessionLock } from '../../../desktop/src/main/maker-ipc/sendToSessionLock.ts';
import { withRehydrateCloseSuppressed } from '../../../desktop/src/main/maker-host/rehydrateCloseSuppression.ts';
import { clearSessionProvider, getSessionProvider, hasSessionProvider, setSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { getActiveAppSession, isAppSessionBoundaryPending, setAppSessionCommitBoundaryHook } from '../../../desktop/src/main/appSessionState.ts';
import { throwIpcError } from '../../../desktop/src/main/utils/ipcValidate.js';
import * as broadcastTap from '../../../desktop/src/main/device-link/broadcast-tap.js';
import type { Logger } from '../../../desktop/src/main/logger.ts';
import { recordHostContextSnapshot } from './context-usage.ts';
import { rememberSessionLastLiveUsage } from '../../../desktop/src/main/maker-ipc/sessionLastLiveUsage.ts';
import { createSessionContextWindowBudgetReconcile, type SessionContextWindowBudgetReconcilePorts } from '../../../desktop/src/main/maker-ipc/sessionContextWindowBudgetReconcile.js';
import { appliedContextWindowBudgets, pendingSessionContextWindowBudgetReconciles } from '../../../desktop/src/main/maker-ipc/sessionContextWindowBudgetState.js';
import { createSessionRuntimeFallback } from '../../../desktop/src/main/maker-ipc/sessionRuntimeFallback.ts';
import { createSessionRuntimeFallbackSettingsFile } from '../../../desktop/src/main/maker-host/sessionRuntimeFallbackSettingsCore.ts';
import { getUserDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { createPendingSessionRuntimeControlSettlement } from '../../../desktop/src/main/maker-ipc/pendingSessionRuntimeControlSettlement.ts';
import { publishAgentEvent } from './turn-executor.mjs';
import { createHostTurnSettlement } from './turn-settlement.ts';
import { getCurrentDbClientSnapshot } from '../../../desktop/src/main/localDb/client/current.js';
import { getSessionEffort, getSessionFastMode, setSessionEffort as restoreEffort, setSessionFastMode as restoreFastMode } from '../../../desktop/src/main/maker-host/session-effort-store.js';
import { readRuntimePluginSettings } from '../../../desktop/src/main/maker-host/runtime-plugin-settings.js';
import { RuntimePluginControlError } from '../../../desktop/src/main/cindy-brain/runtimeControl.js';
import { closeRejectedRuntimeAndRestoreControlStores } from '../../../desktop/src/main/maker-ipc/runtimeSetModel.js';
import { createSessionControlRuntimeWriter } from '../../../desktop/src/main/maker-ipc/sessionControlRuntimeWriter.js';
import { shouldApplyExclusiveProviderRerouteLive } from '../../../desktop/src/main/maker-host/model-route-guard-catalog.js';
import { admitPluginEngineSwitchTarget } from '../../../desktop/src/main/maker-ipc/pluginEngineSessionAdmission.js';
import { listPluginEngineViews } from '../../../desktop/src/main/maker-ipc/pluginEnginesIpc.js';
import { getPluginEngineHandoffWindow } from '../../../desktop/src/main/maker-host/pluginEngineModelCache.js';
import { pluginEngineKeyFromProviderId } from '../../../desktop/src/shared/pluginEngines.js';
import type { GhostModelRoute } from '../../../desktop/src/shared/ghost.js';
import type { ModelGroupSessionBindingView } from '../../../desktop/src/shared/modelGroups.js';
import { runOutsideDeviceLinkInvokeContext } from '../../../desktop/src/main/device-link/invoke-context.js';
import {
  runModelGroupBeforeSend,
  type RunModelGroupBeforeSendPorts,
  type RunModelGroupBeforeSendSessionRow,
} from '../../../desktop/src/main/model-groups/applyTurnRouting.js';
import { peekModelGroupSessionBinding } from '../../../desktop/src/main/model-groups/sessionBindings.js';
import { explicitPorts } from './explicit-ports.ts';

interface HostPendingSwitchOptions {
  signal?: AbortSignal;
  scheduled?: boolean;
  clientId?: string;
  nextInputChars?: number;
  hasImages?: boolean;
  autoResume?: boolean;
  expectedPiModel?: string;
  assertPreparationCurrent?: () => void;
}

/** What the Host's runtime selection reads from the rest of the Host (main.ts binds it). */
export interface HostRuntimeSelectionDeps {
  getMaker(): Maker;
  /** The Maker once the agent runtime is ready, else null (the desktop's getMakerIfReady). */
  getMakerIfReady(): Maker | null;
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
  /** The Host's profile directory (the desktop's app.getPath('userData')). */
  userDataDir: string;
  /** A route's configured window with a task's window budget (start-options). */
  resolveConfiguredContextWindow: SessionRuntimeSelectionPorts['resolveConfiguredContextWindow'];
  readStoredSessionContextWindowBudget: SessionRuntimeSelectionPorts['readStoredSessionContextWindowBudget'];
  /** Whether a budget change changes a route's effective window (start-options, the budget core). */
  contextWindowBudgetChangesEffectiveWindow: SessionContextWindowBudgetReconcilePorts['contextWindowBudgetChangesEffectiveWindow'];
  /** The Codex proxy's credential injection state (codex-runtime.ts). */
  codexProxyAuthInjectionState(): ReturnType<SessionRuntimeSelectionPorts['getCodexProxyAuthInjectionState']>;
  /** The current owner runtime's input queue: its rollover, coordinator and executor facts. */
  inputQueue: {
    contextRecoveryRollover(): SessionRuntimeSelectionPorts['contextOverflowRolloverHolder'];
    sessionDbAgentKind(sessionId: string): 'cc' | 'codex' | 'pi' | null;
    recordRuntimeControlError(sessionId: string, data: { message: string; reason: string }): void;
    isTurnRunning(sessionId: string): boolean;
    canSettleTurnControls(): boolean;
    isHeldForDesktop(): boolean;
    profileRouteStartupSignal(): AbortSignal;
    retryTurnSettlement(sessionId: string): void;
    wakeSession: AgentInputCoordinator['wakeSession'];
    refreshQueuedRoute: AgentInputCoordinator['refreshQueuedRoute'];
    cancelUsageLimitWait(sessionId: string): void;
    /** Forgets a task's working-directory recovery (turn-executor.mjs discardWorkingDirectoryRecovery). */
    discardWorkingDirectoryRecovery(sessionId: string): void;
    /** Starting a task's runtime outside a turn, as a send starts it (turn-executor.mjs startPorts). */
    startPorts(): HostRuntimeStartPorts;
  };
  /** A task's provider group binding and a group (the Host's provider group stores, main.ts). */
  readProviderGroupBinding: Parameters<typeof createSubscriptionFastPolicies>[0]['readProviderGroupBinding'];
  readProviderGroup: Parameters<typeof createSubscriptionFastPolicies>[0]['readProviderGroup'];
  /** Smart Routing (model-groups) runtime ports for projection, fallback and pre-send evaluation. */
  modelGroups?: {
    projectBinding(
      sessionId: string,
      target: { agentKind?: string | null; providerId?: string | null; model?: string | null; agentDeviceId?: string | null },
    ): ModelGroupSessionBindingView | null;
    readFallbackCandidate: NonNullable<Parameters<typeof createSessionRuntimeFallback<Session>>[0]['readModelGroupFallbackCandidate']>;
    readBeforeSendSessionRow(sessionId: string): Promise<RunModelGroupBeforeSendSessionRow | null>;
    evaluateTurnRouting: RunModelGroupBeforeSendPorts['evaluateTurnRouting'];
    describeTurnSwitchCause: NonNullable<RunModelGroupBeforeSendPorts['describeCause']>;
  };
  log: Logger;
}

/**
 * The input queue members the runtime selection calls. input-queue.mjs has no types, so main.ts casts
 * its api to HostRuntimeSelectionDeps['inputQueue']; this list must name every one of those members
 * (the type below fails to compile otherwise), and input-queue.test.mjs checks a real queue has each.
 */
export const HOST_RUNTIME_SELECTION_QUEUE_MEMBERS = [
  'contextRecoveryRollover', 'sessionDbAgentKind', 'isTurnRunning', 'wakeSession', 'refreshQueuedRoute',
  'cancelUsageLimitWait', 'discardWorkingDirectoryRecovery', 'startPorts', 'recordRuntimeControlError', 'canSettleTurnControls', 'retryTurnSettlement', 'isHeldForDesktop',
  'profileRouteStartupSignal',
] as const satisfies readonly (keyof HostRuntimeSelectionDeps['inputQueue'])[];
type UnlistedQueueMembers = Exclude<keyof HostRuntimeSelectionDeps['inputQueue'], typeof HOST_RUNTIME_SELECTION_QUEUE_MEMBERS[number]>;
const everyQueueMemberListed: [UnlistedQueueMembers] extends [never] ? true : never = true;
void everyQueueMemberListed;
/** The runtime start functions startPorts() returns (HostRuntimeStartPorts), checked the same way. */
export const HOST_RUNTIME_START_PORTS = [
  'buildCreateOptsWithStderr', 'checkWorkDirExists', 'synthesizeOrcaVendorOptionsFromDb', 'readSessionExtraDirsFromDb',
  'readSessionWritableDirsFromDb', 'ensureRemoteReadyForSessionStart', 'bootstrapSession', 'broadcastSessionCreated',
] as const satisfies readonly (keyof HostRuntimeStartPorts)[];
type UnlistedStartPorts = Exclude<keyof HostRuntimeStartPorts, typeof HOST_RUNTIME_START_PORTS[number]>;
const everyStartPortListed: [UnlistedStartPorts] extends [never] ? true : never = true;
void everyStartPortListed;

/** The executor's runtime start functions (turn-executor.mjs startPorts), as the desktop's send transaction has them. */
export interface HostRuntimeStartPorts {
  /** Returns the options with the stderr capture (the desktop's CreateOpts, whose remoteHostId is optional). */
  buildCreateOptsWithStderr<O extends object>(opts: O): O & { remoteHostId?: string | null };
  checkWorkDirExists(sessionId: string, workingDir: string | undefined, agentKind: string, remoteHostId: string | null | undefined): Promise<boolean>;
  synthesizeOrcaVendorOptionsFromDb(sessionId: string, opts: object): Promise<unknown>;
  readSessionExtraDirsFromDb(sessionId: string): Promise<string[]>;
  readSessionWritableDirsFromDb(sessionId: string): Promise<string[]>;
  ensureRemoteReadyForSessionStart(params: { createOpts?: unknown }): Promise<unknown>;
  bootstrapSession(opts: object, assertAccess?: () => void, nativeHistoryResume?: boolean, routeStartupSignal?: AbortSignal): Promise<{ session: Session }>;
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
  const settlement: ReturnType<typeof createHostTurnSettlement> = createHostTurnSettlement({
    open: () => deps.inputQueue.canSettleTurnControls(),
    busy: id => deps.inputQueue.isTurnRunning(id) || maker().getSession(id)?.isTurnRunning() === true,
    retry: id => deps.inputQueue.retryTurnSettlement(id),
    credentials: () => pendingCredentialSwitchService,
    applyControl: id => settleRuntimeControl(id, 'host-turn-settled'),
    onControlError: (sessionId, error) => deps.log.warn('runtime settlement delivery failed', { sessionId, error }),
  });
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
    (agent, model, providerId, remoteHostId, unavailableCode) => assertModelRouteUsableWith(explicitPorts<Parameters<typeof assertModelRouteUsableWith>[0]>({
      // The Host refuses SSH tasks before any of this runs (send-preflight.ts).
      listSshCodexProviders: async () => throwIpcError('UNSUPPORTED_CAPABILITY', 'Host does not yet support remote execution'),
      verdictForModelRoute,
    }), agent, model, providerId, remoteHostId, unavailableCode);
  // register.ts bootstrapSession's start admission of a runtime (localRouteAdmission.ts), with the
  // route check above and the Host's provider listing.
  const admitLocalRoute = createLocalRouteAdmission(explicitPorts<Parameters<typeof createLocalRouteAdmission>[0]>({
    // The Host has no managed local model runtime (Ollama, llama.cpp): it answers as the desktop's
    // preflight answers when that runtime is not ready (pi-native-providers.ts).
    ensureManagedOllamaReadyForSession: input =>
      hostManagedLocalModelNotReady({ providerId: input.providerId ?? '', remoteHostId: input.remoteHostId ?? null }),
    getUserDataDir: () => deps.userDataDir,
    assertModelRouteUsable,
    pinExclusiveSessionProvider: (agent, model, providerId) =>
      pinExclusiveSessionProviderWithProviders(() => deps.listProviderViews(), agent, model, providerId),
  }));
  const projectModelGroupBinding = deps.modelGroups
    ? (
        sessionId: string,
        target: { agentKind?: string | null; providerId?: string | null; model?: string | null; agentDeviceId?: string | null },
      ) => deps.modelGroups!.projectBinding(sessionId, target)
    : undefined;
  const { broadcastSessionRuntimeProjection: publishProjection, projectScheduledPreferences } = createSessionRuntimeProjection(explicitPorts<Parameters<typeof createSessionRuntimeProjection>[0]>({
    broadcastSessionPatched,
    projectModelGroupBinding,
  }));
  const broadcastSessionRuntimeProjection: typeof publishProjection = (id, baseline) => {
    settlement.observeControl(id);
    return publishProjection(id, baseline);
  };
  // The task read projector (register.ts setSessionRuntimeProjector), which bindHostSessionRuntimeHooks
  // installs: every task read shows what the task runs on, an accepted runtime override included.
  const sessionRuntimeProjector = createSessionRuntimeProjector(explicitPorts<Parameters<typeof createSessionRuntimeProjector>[0]>({
    projectScheduledPreferences,
    runtimePluginsSelected: id => !!readRuntimePluginSettings(id),
    pendingWorkerQuestion: undefined, // Worker execution is owned by the desktop.
    projectModelGroupBinding,
  }));
  // The cleanup at a task's archive or delete (register.ts setSessionRuntimeCleanup), which
  // bindHostSessionRuntimeHooks installs: the task's runtime override and axes do not outlive it.
  const sessionRuntimeCleanup = createSessionRuntimeCleanup(explicitPorts<Parameters<typeof createSessionRuntimeCleanup>[0]>({
    clearDeferredCredentialSelection: sessionId => pendingCredentialSwitchService.clearDeferredSelection(sessionId),
    // The desktop stops a start still in progress on another computer; the Host starts no task on
    // another computer (send-preflight.ts refuses remote tasks), so none is ever waiting.
    cancelPendingRemoteStart: () => {},
    discardWorkingDirectoryRecovery: sessionId => deps.inputQueue.discardWorkingDirectoryRecovery(sessionId),
    broadcastSessionRuntimeProjection,
    log: deps.log,
  }));
  const updateScheduledPreference = createUpdateScheduledPreference(explicitPorts<Parameters<typeof createUpdateScheduledPreference>[0]>({ broadcastSessionRuntimeProjection }));
  const resolvePendingRuntimeAxisPatch = createResolvePendingRuntimeAxisPatch(explicitPorts<Parameters<typeof createResolvePendingRuntimeAxisPatch>[0]>({
    getDesktopProviderService: providerService,
    log: deps.log,
  }));
  // As register.ts: the same-engine pick an intent lands as, through applySessionRuntimeSelection
  // (handleSetModel without a revision), read at call time because handleSetModel is assigned below.
  const applySessionRuntimeSelection: Parameters<typeof createSelectSameAgentModel>[0]['applySessionRuntimeSelection'] =
    (sessionId, model, providerId, selection, options) =>
      handleSetModel(sessionId, model, providerId, undefined, selection, options);
  const canApplyAutomaticRuntimeSelection = createCanApplyAutomaticRuntimeSelection(explicitPorts<Parameters<typeof createCanApplyAutomaticRuntimeSelection>[0]>({ agentSwitchPending: pendingSwitches }));
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
  const pendingCredentialSwitchService = createPendingCredentialSwitchService(explicitPorts<Parameters<typeof createPendingCredentialSwitchService>[0]>({
    settlementPermit: settlement.permit,
    maker: pendingSwitchMaker,
    isSessionInTurn: sessionId => isSessionInTurn(sessionId),
    applyPiPendingSelection: (sessionId, target, resolved, isCurrent) => {
      if (!applyPiPendingSelection) throw new Error('Pi model selection is not ready');
      return applyPiPendingSelection(sessionId, target, resolved, isCurrent);
    },
    // The desktop broadcasts these to its windows; the Host sends them on its event stream.
    broadcastToAllWindows: (channel, payload) => deps.publish({ type: 'plugin_push', channel, payload }),
    inputCoordinator: {
      wakeSession(id, reason) {
        coordinatorWake.wakeSession(id, reason);
        settlement.credentialApplied(id);
      },
    },
    resolveLenientSessionRoute: (agent, model, providerId, opts) =>
      resolveLenientSessionRouteWithProviders(() => deps.listProviderViews(), agent, model, providerId, opts),
    getSessionDbAgentKind: sessionId => deps.inputQueue.sessionDbAgentKind(sessionId) ?? settlement.deferredDbKind(sessionId),
    getDesktopProviderService: providerService,
    resolveConfiguredContextWindow: deps.resolveConfiguredContextWindow,
    agentInputCoordinatorHolder: coordinatorRoute,
    broadcastSessionPatched,
    log: deps.log,
  }));
  // As register.ts: the proxy's synchronous routing reads a task's pending switch.
  setPendingCredentialSwitchReader(createPendingCredentialSwitchRouteReader(pendingCredentialSwitchService));
  // The shared register / clear / wake / read of a pending switch (register.ts pendingCredentialSwitchPorts).
  const accessPorts = (): PendingCredentialSwitchAccessPorts => explicitPorts<PendingCredentialSwitchAccessPorts>({
    pendingCredentialSwitchHolder: pendingCredentialSwitchService,
    agentInputCoordinatorHolder: coordinatorWake,
    getSessionDbAgentKind: sessionId => deps.inputQueue.sessionDbAgentKind(sessionId),
    getMaker: maker,
  });
  // Host also considers a runtime with an unacknowledged permission change busy. The desktop
  // reads its foreground turn activity tracker here (release table, section 7).
  const isSessionInTurn = (sessionId: string) => maker().getSession(sessionId)?.isTurnRunning?.() === true;
  // register.ts's binding (createColdPiRehydrationBinding), with the Host's runtime start functions
  // (the ones its send transaction uses) in place of the desktop's.
  const bindColdPiRehydration = (onRehydrated?: (session: Session) => void, assertAccess?: () => void, signal?: AbortSignal) => createColdPiRehydrationBinding(explicitPorts<Parameters<typeof createColdPiRehydrationBinding>[0]>({
    maker: { getSession: sessionId => maker().getSession(sessionId) },
    buildCreateOptsWithStderr: opts => deps.inputQueue.startPorts().buildCreateOptsWithStderr(opts),
    checkWorkDirExists: (sessionId, workingDir, agentKind, remoteHostId) =>
      deps.inputQueue.startPorts().checkWorkDirExists(sessionId, workingDir, agentKind, remoteHostId),
    synthesizeOrcaVendorOptionsFromDb: (sessionId, opts) =>
      deps.inputQueue.startPorts().synthesizeOrcaVendorOptionsFromDb(sessionId, opts),
    readSessionExtraDirsFromDb: sessionId => deps.inputQueue.startPorts().readSessionExtraDirsFromDb(sessionId),
    bootstrapSession: opts => {
      const work = deps.inputQueue.startPorts().bootstrapSession(opts, assertAccess, false, signal);
      return onRehydrated ? work.then(result => {
        onRehydrated(result.session);
        return result;
      }) : work;
    },
  }));
  const rehydrateColdPiRuntimeForWindowVerification = bindColdPiRehydration();

  const projectCredentialSwitch = (sessionId: string) =>
    projectDeferredCredentialSwitchIntent(getPendingCredentialSwitchTargetWith(accessPorts(), sessionId));
  const describePluginEngine = (providerId: string | null): string | null => {
    const key = pluginEngineKeyFromProviderId(providerId);
    return key ? listPluginEngineViews().find((engine) => engine.key === key)?.name ?? null : null;
  };
  const agentSwitchDeps: MakerSessionAgentSwitchHandlerDeps = explicitPorts<MakerSessionAgentSwitchHandlerDeps>({
    // Ports for moving a task to or between other computers (release table, B5): the Host refuses a
    // switch with a non-empty agentDeviceId at its entry and refuses tasks running elsewhere at send,
    // so these are never reached; written out so a new one is a decision (explicit-ports.ts).
    resolveProviderGroupTarget: undefined,
    clearProviderGroupBinding: undefined,
    assertAgentDeviceRouteUsable: undefined,
    describeAgentDevice: undefined,
    cancelPendingRemoteStart: undefined,
    // Task switching onto a local plugin engine (docs/plans/acp-plugin-bridge.md), using the same
    // live admission and engine display name as Desktop (register.ts).
    canSwitchCompletedAutomationSession: undefined,
    admitPluginEngineTarget: (target) => admitPluginEngineSwitchTarget(target, listPluginEngineViews()),
    admitRemotePluginEngineTarget: undefined,
    describePluginEngine,
    resolveHandoffWindow: async ({ sessionId, agent, model, providerId, agentDeviceId }) => {
      if (agentDeviceId) return null;
      const budget = await deps.readStoredSessionContextWindowBudget(sessionId);
      return deps.resolveConfiguredContextWindow(getActiveCatalog(), agent, providerId, model, budget, 'required');
    },
    resolveLocalPluginHandoffWindow: (providerId, modelId) => getPluginEngineHandoffWindow(providerId, modelId),
    // Host does not assemble companion lanes for runtime handoffs.
    listCompanionSessionIds: undefined,
    relocateNativeHistory: undefined,
    readOwnerGeneration: () => getActiveAppSession().generation,
    peekPendingHandoff: deps.pendingHandoff.peek ? sessionId => deps.pendingHandoff.peek!(sessionId) : undefined,
    withSessionLock: withSendToSessionLock,
    // A task whose Agent runs on another computer is refused on the Host (send-preflight.ts).
    assertModelRouteUsable: async (agent, model, providerId) => assertModelRouteUsable(agent, model, providerId),
    getSessionRow: readAgentSwitchSessionRow,
    getLiveSession: sessionId => maker().getSession(sessionId),
    closeSession: sessionId => maker().closeSession(sessionId, 'agent-switch'),
    listMessagesForHandoff: (sessionId, after) => listMessagesForAgentHandoff(sessionId, null, after, 'replay'),
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
        // The desktop's rebroadcastAgentSwitchBoundary (localDb/ipc/messages.ts): the boundary row
        // as stored, shown only to the owner of the moment of the write, as the Host's message event.
        rebroadcastAgentSwitchBoundary: (sessionId, boundaryClientId, ownerScope) =>
          rebroadcastAgentSwitchBoundaryWith(explicitPorts<Parameters<typeof rebroadcastAgentSwitchBoundaryWith>[0]>({
            isOwnerBroadcastScopeCurrent: scope => isOwnerScopeCurrent(scope ?? null),
            broadcastMessageRow: (rowSessionId, message) =>
              deps.publish({ type: 'message_created', sessionId: rowSessionId, messageId: message.id, message }),
          }), sessionId, boundaryClientId, ownerScope ?? null),
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
    bootstrapSwitchedSession: createSwitchedSessionBootstrap(explicitPorts<Parameters<typeof createSwitchedSessionBootstrap>[0]>({
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
    })),
    // As register.ts: an engine pick replaces a credential switch registered before it.
    supersedePendingCredentialSwitch: sessionId => clearPendingCredentialSwitchWith(accessPorts(), sessionId),
    projectDeferredCredentialSwitchIntent: projectCredentialSwitch,
    // As register.ts: a committed switch's thinking choice goes to the preference mirror the next
    // runtime start reads (start-options.ts getThinkingEnabledFromMemory), and to the clients' memory.
    rememberThinkingIntent: createRememberThinkingIntent(explicitPorts<Parameters<typeof createRememberThinkingIntent>[0]>({
      broadcastToAllWindows: (channel, payload) => deps.publish({ type: 'plugin_push', channel, payload }),
    })),
    withCloseSuppressed: withRehydrateCloseSuppressed,
    pendingSwitches,
    selectSameAgentModel: createSelectSameAgentModel(explicitPorts<Parameters<typeof createSelectSameAgentModel>[0]>({ applySessionRuntimeSelection })),
    onPendingSwitchChanged: (sessionId, intent) => {
      if (intent && !intent.preparation) recordUserSessionRuntimeMutation(sessionId);
      broadcastSessionPatched(sessionId, { agentSwitchIntent: intent });
      if (peekModelGroupSessionBinding(sessionId)) {
        void broadcastSessionRuntimeProjection(sessionId).catch(() => {});
      }
    },
    // The desktop also marks an IM task as detached from its channel default; the Host has no IM.
    onUserRouteSelectionLanded: async sessionId => { await updateScheduledPreference(sessionId, null); },
    log: deps.log,
  });

  // As the desktop: a review task's settings follow its source task. Taking over a local Agent's
  // visible session is the desktop's local-agent (release table, gap A 6); the Host has no such runtime.
  const assertReviewSettingsUnlocked: SessionRuntimeSelectionPorts['assertReviewSettingsUnlocked'] = async sessionId => {
    if ((await readSessionSource(sessionId)) === 'review') {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Review task settings are fixed to the source task');
    }
  };
  // The Host's entries are not a shared task's guest (no Device Link invoke context).
  const captureSharedTaskSettingGuard: SessionRuntimeSelectionPorts['captureSharedTaskSettingGuard'] =
    sessionId => createSharedTaskSettingGuard(undefined, sessionId, { admitted: false });
  // register.ts's budget reconcile, applier and replay (sessionContextWindowBudgetReconcile.ts), on the
  // Host's ports: the runtime mutation dependencies are register.ts's runtimeMutationDeps, member for
  // member. The applier takes the task's send lock itself; inside the Host's /sessions/update, which
  // already holds it, it re-enters (sendToSessionLock.ts).
  const contextWindowBudgetReconcile = createSessionContextWindowBudgetReconcile(explicitPorts<Parameters<typeof createSessionContextWindowBudgetReconcile>[0]>({
    getMakerIfReady: deps.getMakerIfReady,
    readStoredSessionContextWindowBudget: deps.readStoredSessionContextWindowBudget,
    contextWindowBudgetChangesEffectiveWindow: deps.contextWindowBudgetChangesEffectiveWindow,
    getPendingCredentialSwitchTarget: sessionId => getPendingCredentialSwitchTargetWith(accessPorts(), sessionId),
    registerPendingCredentialSwitchForSession: (sessionId, target) =>
      registerPendingCredentialSwitchWith(accessPorts(), sessionId, target),
    runtimeMutationDeps: () => ({
      maker: maker(), isSessionInTurn,
      registerPendingCredentialSwitch: (sessionId, target) => registerPendingCredentialSwitchWith(accessPorts(), sessionId, target),
      clearPendingCredentialSwitch: (sessionId, opts) => clearPendingCredentialSwitchWith(accessPorts(), sessionId, opts),
      wakeSessionInputQueue: sessionId => wakeSessionInputAfterCredentialSwitchWith(accessPorts(), sessionId),
      getPendingCredentialSwitch: sessionId => getPendingCredentialSwitchTargetWith(accessPorts(), sessionId),
      codexAuthInjection: deps.codexProxyAuthInjectionState(), logger: deps.log,
    }),
    log: deps.log,
  }));
  const persistSessionFields: SessionRuntimeSelectionPorts['persistSessionFields'] = (sessionId, patch, options) => persistSessionFieldsWith(explicitPorts<Parameters<typeof persistSessionFieldsWith>[0]>({
    captureOwnerScope, isOwnerScopeCurrent, broadcastSessionPatched,
    // The session settings' budget hook, as the desktop registers it (bootstrap-electron.ts).
    applyContextWindowBudget: () => contextWindowBudgetReconcile.sessionContextWindowBudgetApplier,
  }), sessionId, patch, options);
  const ports = (): SessionRuntimeSelectionPorts => explicitPorts<SessionRuntimeSelectionPorts>({
    maker: maker(),
    agentSwitchPending: pendingSwitches,
    broadcastSessionRuntimeProjection,
    assertReviewSettingsUnlocked,
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
    captureSharedTaskSettingGuard,
    registerPendingCredentialSwitchForSession: (sessionId, target) =>
      registerPendingCredentialSwitchWith(accessPorts(), sessionId, target),
    agentInputCoordinatorHolder: coordinatorRoute,
    getSessionDbAgentKind: sessionId => deps.inputQueue.sessionDbAgentKind(sessionId),
    broadcastSessionPatched,
    persistSessionFields,
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

  function captureRouteOwner() {
    const generation = getActiveAppSession().generation;
    const db = getCurrentDbClientSnapshot();
    return () => db === getCurrentDbClientSnapshot() && generation === getActiveAppSession().generation;
  }

  class HostRouteAdmissionError extends Error {}

  // The plugin route guard checks again after Pi has acknowledged a live change.
  // A rejected selection at that point has changed the runtime but not the task row.
  // Restore the snapshot while this selection still holds the task's send lock.
  async function recoverRejectedRoute<T>(
    id: string,
    sameOwner: () => boolean,
    assertTurnAdmission: () => void,
    run: (bindRehydrated: (session: Session) => void) => Promise<T>,
  ): Promise<T> {
    return withSendToSessionLock(id, async () => {
      // If admission changed while waiting for the lock, the live instance can
      // already belong to another owner. There is nothing from this call to undo.
      assertTurnAdmission();
      const ownerMaker = maker();
      const initialInstance = ownerMaker.getSession(id);
      let instance = initialInstance;
      const hadProvider = hasSessionProvider(id);
      const provider = getSessionProvider(id);
      const effort = getSessionEffort(id);
      const fastMode = getSessionFastMode(id);
      const pendingCredential = pendingCredentialSwitchService.get(id);
      const generation = getSessionRuntimeControlSnapshot(id).generation;
      let originalModel = instance?.model;
      try {
        return await run(session => {
          // Window verification can create an instance within this same mutation.
          // Capture its exact identity at bootstrap, before the engine accepts a route.
          if (!instance) {
            instance = session;
            originalModel = session.model;
          }
        });
      } catch (error) {
        if (!(error instanceof HostRouteAdmissionError)) throw error;
        const ownsInstance = () => !!instance && ownerMaker.getSession(id) === instance;
        const modelChanged = ownsInstance() && instance?.model !== originalModel;
        const routeChanged = hadProvider !== hasSessionProvider(id) || provider !== getSessionProvider(id);
        const axesChanged = effort !== getSessionEffort(id) || fastMode !== getSessionFastMode(id);
        const credentialCleared = !!pendingCredential && !pendingCredentialSwitchService.has(id);
        const accountChanged = !sameOwner() || isAppSessionBoundaryPending();
        if (modelChanged || instance !== initialInstance || routeChanged || axesChanged || credentialCleared || accountChanged) {
          try {
            await closeRejectedRuntimeAndRestoreControlStores({
              closeRuntime: async () => {
                const rejected = instance;
                if (!rejected || !ownsInstance()) return;
                await withRehydrateCloseSuppressed(id, async () => {
                  await ownerMaker.closeSessionIfCurrent(rejected, 'runtime-refresh');
                });
              },
              restoreControlStores() {
                // The Host's app-session commit hook clears providers, axes and runtime
                // control state. Its outgoing runtime disposal clears credential registrations.
                const live = ownerMaker.getSession(id);
                if (!sameOwner() || isAppSessionBoundaryPending() || (live && live !== instance) ||
                    getSessionRuntimeControlSnapshot(id).generation !== generation) return;
                if (hadProvider) setSessionProvider(id, provider);
                else clearSessionProvider(id);
                restoreEffort(id, effort);
                restoreFastMode(id, fastMode);
                if (pendingCredential && !pendingCredentialSwitchService.has(id))
                  pendingCredentialSwitchService.register(id, pendingCredential);
              },
              reportCloseError: closeError => deps.log.warn('rejected Host route could not retire its runtime', {
                sessionId: id, error: closeError instanceof Error ? closeError.message : String(closeError),
              }),
              assertRuntimeClosed() {
                if (ownsInstance()) throw new Error('Rejected runtime is still registered');
              },
            });
          } catch (cleanupError) {
            // An allow-on-failure plugin must never deliver through a runtime
            // whose rejected route is still installed.
            deps.log.error('rejected Host route left its runtime registered', { sessionId: id, error: cleanupError });
            throw new RuntimePluginControlError('block', '', true, 'rejected-route-still-live');
          }
        }
        throw error;
      }
    });
  }
  async function applyPendingPick(
    sessionId: string,
    options: HostPendingSwitchOptions | undefined,
    assertAdmission?: () => void,
    expectedRevision?: number,
  ) {
    const sameOwner = captureRouteOwner();
    const routeSignal = deps.inputQueue.profileRouteStartupSignal();
    let rejected: HostRouteAdmissionError | undefined;
    const check = () => {
      if (rejected) throw rejected;
      try {
        routeSignal.throwIfAborted();
        assertAdmission?.();
        if (!sameOwner() || isAppSessionBoundaryPending()) {
          throwIpcError('PRECONDITION_FAILED', 'Host account changed; runtime selection was not changed');
        }
      }
      catch (error) {
        rejected = new HostRouteAdmissionError(error instanceof Error ? error.message : String(error), { cause: error });
        throw rejected;
      }
    };
    const selectionDeps: MakerSessionAgentSwitchHandlerDeps = {
      ...agentSwitchDeps,
      selectSameAgentModel: createSelectSameAgentModel({
        applySessionRuntimeSelection: (id, model, provider, selection, selectionOptions) =>
          recoverRejectedRoute(id, sameOwner, check, bindRehydrated => {
            const select = createHandleSetModel(() => ({
              ...ports(), rehydrateColdPiRuntimeForWindowVerification: bindColdPiRehydration(bindRehydrated, check, routeSignal),
            }));
            return select(id, model, provider, undefined, selection, {
              ...selectionOptions,
              assertSelectionCurrent: () => { check(); selectionOptions?.assertSelectionCurrent?.(); },
              beforeMutation: async () => { await selectionOptions?.beforeMutation?.(); check(); },
            });
          }),
      }),
      closeSession: (...args) => { check(); return agentSwitchDeps.closeSession(...args); },
      applyAgentSwitchToDb: (...args) => { check(); return agentSwitchDeps.applyAgentSwitchToDb(...args); },
    };
    try {
      await applyPendingAgentSwitchIfIdle(selectionDeps, sessionId, {
        signal: options?.signal, nextInputChars: options?.nextInputChars, expectedRevision,
      });
    } catch (error) {
      if (!(error instanceof RuntimePluginControlError)) {
        if (rejected) throw rejected.cause;
        routeSignal.throwIfAborted();
      }
      throw error;
    }
    // The shared cross-engine path can retain a failed pick and return normally.
    if (rejected) throw rejected.cause;
  }

  const settleRuntimeControl = createPendingSessionRuntimeControlSettlement(explicitPorts<Parameters<typeof createPendingSessionRuntimeControlSettlement>[0]>({
    canSettle: settlement.allowedControl,
    onSettlementWork: settlement.onControlWork,
    applySessionRuntimeSelection: (id, model, provider, selection, options) => {
      const generation = options.applyingPendingGeneration!;
      const check = () => settlement.assertControl(id, generation);
      check();
      return applySessionRuntimeSelection(id, model, provider, selection, { ...options, assertSelectionCurrent: check });
    },
    runtimeSelectionRequiresModelWindowConfirmation: result =>
      result.contextWindowConfirmationRequired !== undefined || result.contextTokensForConfirmation !== undefined,
    broadcastSessionRuntimeProjection,
    getSessionDbAgentKind: id => deps.inputQueue.sessionDbAgentKind(id) ?? settlement.deferredDbKind(id),
    onTurnErrorEvent: (id, error) => deps.inputQueue.recordRuntimeControlError(id, error),
    broadcastToAllWindows: (_channel, { sessionId, event }) => publishAgentEvent({ publish: deps.publish }, sessionId, event, {}),
    log: deps.log,
  }));
  applyPiPendingSelection = createApplyPiPendingSelection(explicitPorts<Parameters<typeof createApplyPiPendingSelection>[0]>({ handleSetModel }));
  const readSessionRuntimeProfiles = createReadSessionRuntimeProfiles(explicitPorts<Parameters<typeof createReadSessionRuntimeProfiles>[0]>({
    maker: { getSessionMeta: sessionId => maker().getSessionMeta(sessionId), getSession: sessionId => maker().getSession(sessionId) },
    agentSwitchPending: pendingSwitches,
    log: deps.log,
  }));
  const recoverRenamedSessionModelOnSend = createRecoverRenamedSessionModelOnSend(explicitPorts<Parameters<typeof createRecoverRenamedSessionModelOnSend>[0]>({
    agentSwitchPending: pendingSwitches, getDesktopProviderService: providerService, readSessionRuntimeProfiles, handleSetModel,
  }));
  // The desktop's effort, Fast mode and thinking handlers (register.ts SET_EFFORT, SET_FAST_MODE,
  // SET_THINKING_ENABLED) and the closures they use, from sessionRuntimeAxisSettings.ts. The desktop
  // checks the IPC sender first; the Host's entries authenticate their caller themselves.
  // An Agent on another computer: refused as the Host refuses remote execution (send-preflight.ts).
  const readUsableAgentDeviceProviders: ReadUsableAgentDeviceProviders = async () =>
    throwIpcError('UNSUPPORTED_CAPABILITY', 'Host does not yet support remote execution');
  // The Maker members the handlers call; the owner runtime's Maker at each call.
  const axisMaker = {
    getSession: (sessionId: string) => maker().getSession(sessionId),
    closeSession: (...args: Parameters<Maker['closeSession']>) => maker().closeSession(...args),
    closeSessionIfCurrent: (...args: Parameters<Maker['closeSessionIfCurrent']>) => maker().closeSessionIfCurrent(...args),
  };
  const { createSubscriptionFastPolicy } = createSubscriptionFastPolicies(explicitPorts<Parameters<typeof createSubscriptionFastPolicies>[0]>({
    readProviderGroupBinding: deps.readProviderGroupBinding,
    readProviderGroup: deps.readProviderGroup,
  }));
  const updateSavedScheduledAxis = createUpdateSavedScheduledAxis(explicitPorts<Parameters<typeof createUpdateSavedScheduledAxis>[0]>({
    readUsableAgentDeviceProviders, updateScheduledPreference, getDesktopProviderService: providerService,
    admitPluginEngineTarget: undefined,
    admitRemotePluginEngineTarget: undefined,
  }));
  const recoverRemoteRuntimeAxisPersistence = createRecoverRemoteRuntimeAxisPersistence(explicitPorts<Parameters<typeof createRecoverRemoteRuntimeAxisPersistence>[0]>({
    maker: axisMaker, broadcastSessionRuntimeProjection, log: deps.log,
  }));
  const stagePendingUserRuntimeAxis = createStagePendingUserRuntimeAxis(explicitPorts<Parameters<typeof createStagePendingUserRuntimeAxis>[0]>({
    agentSwitchDeps, readUsableAgentDeviceProviders, agentSwitchPending: pendingSwitches,
    getDesktopProviderService: providerService, persistSessionFields,
    wakeSessionInputAfterCredentialSwitch: sessionId => wakeSessionInputAfterCredentialSwitchWith(accessPorts(), sessionId),
  }));
  const axisPorts = {
    maker: axisMaker, updateScheduledPreference, agentSwitchPending: pendingSwitches, stagePendingUserRuntimeAxis,
    updateSavedScheduledAxis, resolvePendingRuntimeAxisPatch, readSessionRuntimeProfiles, recoverRemoteRuntimeAxisPersistence,
    assertReviewSettingsUnlocked, broadcastSessionRuntimeProjection, captureSharedTaskSettingGuard,
    // Called only inside a Device Link invoke (remoteResponse); the Host's entries are never one.
    markRemoteSettingPersistedInsideHandler: () => {},
    persistSessionFields,
    getPendingCredentialSwitchHolder: () => pendingCredentialSwitchService,
    log: deps.log,
  };
  const setSessionEffort = createSetSessionEffort(axisPorts);
  const setSessionFastMode = createSetSessionFastMode(explicitPorts<Parameters<typeof createSetSessionFastMode>[0]>({
    ...axisPorts, readUsableAgentDeviceProviders, getDesktopProviderService: providerService, createSubscriptionFastPolicy,
  }));
  const setSessionThinkingEnabled = createSetSessionThinkingEnabled(explicitPorts<Parameters<typeof createSetSessionThinkingEnabled>[0]>({
    maker: axisMaker, assertReviewSettingsUnlocked, captureSharedTaskSettingGuard,
  }));
  // A task's permission mode and Plan mode (sessionPermissionSettings.ts): the desktop's commit with the
  // Host's Maker, review-task check, patch broadcast and session field write. The entries run outside the
  // task's send lock, as the desktop's do: the permission queues come first, the send lock after.
  const permissionMaker = { getSession: (sessionId: string) => maker().getSession(sessionId) };
  // botPermissionSync.ts's lane sync: a Bot's other lanes follow a permission save.
  const botPermissionSync = createBotPermissionSync(explicitPorts<Parameters<typeof createBotPermissionSync>[0]>({
    getMakerIfReady: () => deps.getMakerIfReady(),
    broadcastSessionPatched: (sessionId, patch) => broadcastSessionPatched(sessionId, patch),
  }));
  const commitSessionPermissionMode = (sessionId: string, mode: string, remote = false, beforeMutation?: () => Promise<void>) =>
    commitSessionPermissionModeWith(explicitPorts<Parameters<typeof commitSessionPermissionModeWith>[0]>({
      maker: permissionMaker, assertReviewSettingsUnlocked,
      broadcastSessionPatched: (patchedSessionId, patch) => broadcastSessionPatched(patchedSessionId, patch),
      syncBotLinkedLanePermissions: botPermissionSync.syncBotLinkedLanePermissions,
      // Called only inside a Device Link invoke (remote); the Host's entries are never one.
      markRemoteSettingPersistedInsideHandler: () => {},
      log: deps.log,
    }), sessionId, mode, remote, beforeMutation);
  const setSessionPermissionMode = createSetSessionPermissionMode(explicitPorts<Parameters<typeof createSetSessionPermissionMode>[0]>({ commitSessionPermissionMode }));
  const setSessionPlanMode = createSetSessionPlanMode(explicitPorts<Parameters<typeof createSetSessionPlanMode>[0]>({
    maker: permissionMaker, assertReviewSettingsUnlocked, persistSessionFields,
    markRemoteSettingPersistedInsideHandler: () => {}, log: deps.log,
  }));
  /**
   * A runtime of a task closed (the Maker's session:closed, from the session's own close), finalized
   * in the desktop's order: finalizeClosedSession keeps its last live usage for a cold Pi model
   * change's window check (sessionLastLiveUsage.ts), read from the closed session as the desktop reads
   * it; then cleanupClosedSessionRuntime settles its pending credential switch.
   */
  const onSessionClosed = (sessionId: string, session: Pick<Session, 'getUsageSnapshot'>) => {
    rememberSessionLastLiveUsage(sessionId, session.getUsageSnapshot());
    if (deps.inputQueue.canSettleTurnControls()) pendingCredentialSwitchService.onSessionClosed(sessionId);
    // As the desktop's cleanupClosedSessionRuntime (register.ts), after the pending switch: a closed
    // runtime's budget bookkeeping goes, so its replacement starts from the stored budget.
    appliedContextWindowBudgets.delete(sessionId);
    pendingSessionContextWindowBudgetReconciles.delete(sessionId);
  };

  // The route change an interrupted-turn auto-resume tries first (sessionRuntimeFallback.ts), as
  // register.ts assembles it: a task with the user's fallback setting on moves to another provider's
  // candidate on its second attempt. The rebuild leases it marks are the auto-resume's own (read on an
  // unexpected close on the desktop; the Host does not tear a resume down when a runtime closes).
  const pendingSessionRuntimeFallbackRebuilds = new WeakMap<Session, number>();
  const fallbackSettings = createSessionRuntimeFallbackSettingsFile(() => getUserDataDir());
  const maybeApplySessionRuntimeFallback = createSessionRuntimeFallback<Session>(explicitPorts<Parameters<typeof createSessionRuntimeFallback<Session>>[0]>({
    maker: { getSession: sessionId => maker().getSession(sessionId), closeSession: sessionId => maker().closeSession(sessionId) },
    readSessionRuntimeProfiles, canApplyAutomaticRuntimeSelection,
    // Teammate tasks are refused at Host admission: no task has a Teammate route to fall back along.
    readBotFallbackCandidate: async () => ({ isBot: false, candidate: null }),
    readModelGroupFallbackCandidate: deps.modelGroups?.readFallbackCandidate,
    // Agents on another computer are refused at Host admission (send-preflight.ts): every task runs here.
    readSessionAgentDeviceId: async () => null,
    readSessionRuntimeFallbackSettings: () => fallbackSettings.read(),
    getDesktopProviderService: providerService as Parameters<typeof createSessionRuntimeFallback<Session>>[0]['getDesktopProviderService'],
    pendingSessionRuntimeFallbackRebuilds,
    applySessionRuntimeSelection,
    getPendingCredentialSwitchTarget: sessionId => getPendingCredentialSwitchTargetWith(accessPorts(), sessionId),
    clearPendingCredentialSwitchForSession: (sessionId, options) => clearPendingCredentialSwitchWith(accessPorts(), sessionId, options),
    broadcastSessionRuntimeProjection,
    agentSwitchDeps,
    performSessionAgentSwitch,
    // As register.ts (runtimeSelectionRequiresModelWindowConfirmation): a pick that needs the user to
    // confirm a smaller context window is not applied automatically.
    runtimeSelectionRequiresModelWindowConfirmation: result =>
      result.contextWindowConfirmationRequired !== undefined || result.contextTokensForConfirmation !== undefined,
    log: deps.log,
  }));

  return {
    readSessionRuntimeProfiles,
    assertReviewSettingsUnlocked,
    async applyPluginRoute(id: string, route: GhostModelRoute, assertVerdict: () => void, assertTurn: () => void) {
      const sameOwner = captureRouteOwner();
      const check = () => {
        try { assertTurn(); }
        catch (error) { throw new HostRouteAdmissionError('The originating Host turn changed', { cause: error }); }
        if (!sameOwner() || isAppSessionBoundaryPending() || deps.inputQueue.isHeldForDesktop())
          throw new HostRouteAdmissionError('The Host cannot persist a route for this turn');
        assertVerdict();
      };
      check();
      if (route.agentDeviceId) throw new Error('Host does not support remote execution');
      const generation = getSessionRuntimeControlSnapshot(id).generation;
      const profiles = await readSessionRuntimeProfiles(id);
      if (!profiles) throw new Error('Task runtime unavailable');
      check();
      const effective = profiles.pendingMutation?.profile ?? profiles.effective;
      const targetAgent = route.agentKind === 'cc' ? 'claude-code' : route.agentKind;
      const selectHarness = targetAgent !== effective.agentKind || !!effective.agentDeviceId;
      await recoverRejectedRoute(id, sameOwner, check, async bindRehydrated => {
        const applyPluginModel = createHandleSetModel(() => ({
          ...ports(), rehydrateColdPiRuntimeForWindowVerification: bindColdPiRehydration(bindRehydrated),
        }));
        const write = createSessionControlRuntimeWriter(explicitPorts<Parameters<typeof createSessionControlRuntimeWriter>[0]>({
          agentSwitchPending: pendingSwitches, agentSwitchDeps, assertModelRouteUsable, getDesktopProviderService: providerService,
          reconcileBotModelRoute: { acceptTaskChoice: async () => {} }, updateScheduledPreference, readSessionRuntimeProfiles,
          readUsableAgentDeviceProviders, shouldApplyExclusiveProviderRerouteLive,
          applySessionRuntimeSelection: async (sessionId, model, provider, selection, options) => {
            const result = await applyPluginModel(sessionId, model, provider, undefined, selection, { ...options, assertSelectionCurrent: check });
            if (result.superseded && !sameOwner()) throw new HostRouteAdmissionError('Host account changed during plugin route selection');
            return result;
          },
          runtimeSelectionRequiresModelWindowConfirmation: result =>
            result.contextWindowConfirmationRequired !== undefined || result.contextTokensForConfirmation !== undefined,
          // The Host never runs remote-agent sessions; explicit device IDs are never this computer.
          isSelfDeviceId: () => false,
          onExplicitRouteSelected: sessionId => deps.inputQueue.cancelUsageLimitWait(sessionId),
        }));
        const result = await write({ targetSessionId: id, expectedGeneration: generation,
          beforeMutation: async () => check(),
          patch: { ...(selectHarness ? { harness: targetAgent, agentDeviceId: null } : {}),
            model: route.model, providerId: route.providerId,
            ...(route.effort !== undefined ? { effort: route.effort as Effort } : {}),
            ...(route.fastMode !== undefined ? { fastMode: route.fastMode } : {}),
          },
        });
        if (!result.ok) throw new Error(result.errorCode);
      });
    },
    pendingSwitches,
    agentSwitchDeps,
    /** The task read projector and the archive/delete cleanup (bindHostSessionRuntimeHooks installs them, as register.ts). */
    sessionRuntimeProjector,
    sessionRuntimeCleanup,
    /** The interrupted-turn auto-resume's route change (auto-resume.ts), and the rebuild leases it marks. */
    maybeApplySessionRuntimeFallback,
    pendingSessionRuntimeFallbackRebuilds,
    /**
     * The start admission of a task runtime (register.ts bootstrapSession's admitLocalRoute): a start
     * that is not a verified resume of the task's stored route is refused on a disabled, retired or
     * payment-required route, or rerouted to an enabled copy; it changes `providerId` in place.
     */
    admitLocalRoute,
    /** The intent of a task as clients see it (session_changed, the task snapshot). */
    projectIntent: (sessionId: string) =>
      projectPendingAgentSwitchIntent(pendingSwitches.get(sessionId)) ?? projectCredentialSwitch(sessionId),
    /** Freeze the actual executor and pending target at the shared send's acceptance boundary on mismatch. */
    readDispatchRoute: (session: Pick<Session, 'id' | 'agentKind' | 'agentDeviceId'> & { readonly model?: string }) => {
      const intent = pendingSwitches.get(session.id);
      if (!intent) return undefined;
      const actualProviderId = getSessionProvider(session.id);
      const actualDeviceId = session.agentDeviceId ?? null;
      const targetProviderId = intent.providerId ?? null;
      const targetDeviceId = intent.targetAgentDeviceId === undefined ? actualDeviceId : intent.targetAgentDeviceId;
      return captureMessageDispatchRoute(
        {
          agentKind: session.agentKind,
          model: session.model ?? '',
          providerId: actualProviderId,
          agentDeviceId: actualDeviceId,
          ...(session.agentKind === 'acp' && !actualDeviceId ? { engineName: describePluginEngine(actualProviderId) ?? undefined } : {}),
        },
        {
          agentKind: intent.targetAgentKind,
          model: intent.model,
          providerId: targetProviderId,
          agentDeviceId: targetDeviceId,
          ...(intent.targetAgentKind === 'acp' && !targetDeviceId ? { engineName: describePluginEngine(targetProviderId) ?? undefined } : {}),
        },
        intent.preparationError,
      );
    },
    /** The desktop's set-effort (an effort change of a task, live or staged into a pending pick). */
    setEffort: (sessionId: unknown, effort: unknown) => setSessionEffort(sessionId, effort),
    /** The desktop's set-fast-mode. */
    setFastMode: (sessionId: unknown, requestedSpeed: unknown) => setSessionFastMode(sessionId, requestedSpeed),
    /** The desktop's set-thinking-enabled. */
    setThinkingEnabled: (sessionId: unknown, enabled: unknown) => setSessionThinkingEnabled(sessionId, enabled),
    /** The desktop's set-permission-mode (its arguments checked, then the commit). */
    setPermissionMode: (sessionId: unknown, mode: unknown) => setSessionPermissionMode(sessionId, mode),
    /** The desktop's set-plan-mode. */
    setPlanMode: (sessionId: unknown, enabled: unknown) => setSessionPlanMode(sessionId, enabled),
    /**
     * A Plan mode a runtime changed itself (its plan_mode_changed event), saved as the desktop's
     * emitWiredSessionEvent saves it; the executor gives the owner it wired the runtime under and its
     * session bindings.
     */
    persistAgentPlanModeChange: (
      ports: Pick<Parameters<typeof persistAgentPlanModeChangeWith>[0], 'ownerDb' | 'sessionBindings'>,
      session: Parameters<typeof persistAgentPlanModeChangeWith>[1],
      event: Parameters<typeof persistAgentPlanModeChangeWith>[2],
    ) => persistAgentPlanModeChangeWith(explicitPorts<Parameters<typeof persistAgentPlanModeChangeWith>[0]>({ ...ports, persistSessionFields, log: deps.log }), session, event),
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
     * order: the landing (with the send's signal and next input size), then, for a send
     * that is not scheduled, the recovery of a renamed model, then the replay of a window budget rebuild
     * still owed (under the send lock the transaction holds). The desktop's other steps are not on the
     * Host yet (release table: the scheduled model scope, the Orca pending check, the provider group
     * check).
     */
    async applyPendingAgentSwitch(sessionId: string, options?: HostPendingSwitchOptions) {
      // A context recovery can replay its interrupted input while a desktop owns the profile.
      // Leave independent user selections and model-renaming writes for the next normal send.
      const intent = pendingSwitches.get(sessionId);
      const assertPreparation = options?.assertPreparationCurrent;
      if (options && assertPreparation) {
        assertPreparation();
        if (!intent || intent.targetAgentKind !== 'pi' || intent.model !== options.expectedPiModel || intent.targetAgentDeviceId) {
          throwIpcError('PRECONDITION_FAILED', 'The selected Pi route is not ready');
        }
        const originalRuntime = maker().getSession(sessionId);
        await applyPendingPick(sessionId, options, assertPreparation, pendingSwitches.revision?.(sessionId));
        assertPreparation();
        if (pendingSwitches.get(sessionId)) {
          throwIpcError('PRECONDITION_FAILED', 'The selected Pi route is not ready');
        }
        // The shared switch normally retires the old engine. A non-owner pick
        // can take a local landing path, so confirm the old runtime is gone.
        const live = maker().getSession(sessionId);
        if (intent.deviceLinkModelSelectionOrigin !== 'owner' && live && live === originalRuntime && live.agentKind !== 'pi') {
          await maker().closeSessionIfCurrent(live, 'runtime-refresh');
          assertPreparation();
        }
        return;
      }
      if (intent && !deps.inputQueue.isHeldForDesktop()) {
        await applyPendingPick(sessionId, options);
      }
      if (!deps.inputQueue.isHeldForDesktop() && !options?.scheduled) await recoverRenamedSessionModelOnSend(sessionId);
      await contextWindowBudgetReconcile.replayPendingSessionContextWindowBudgetUnderLock(sessionId);
      if (!intent && !options?.scheduled && !deps.inputQueue.isHeldForDesktop() && deps.modelGroups) {
        const modelGroups = deps.modelGroups;
        await runModelGroupBeforeSend(
          {
            readSession: (sid) => modelGroups.readBeforeSendSessionRow(sid),
            evaluateTurnRouting: (sid, current, turn) => modelGroups.evaluateTurnRouting(sid, current, turn),
            applySameEngineRoute: ({ sessionId: sid, model, providerId, effort, fastMode, cause }) =>
              applySessionRuntimeSelection(
                sid,
                model,
                providerId,
                { effort: (effort || null) as SessionRuntimeProfile['effort'], fastMode },
                {
                  source: 'fallback',
                  sessionLockHeld: true,
                  configStaged: true,
                  persistRoute: true,
                  preserveModelGroupBinding: true,
                  effortExplicit: Boolean(effort),
                  fastExplicit: Boolean(fastMode),
                  routeChangeAttribution: { by: 'model-group', reason: cause ?? 'unavailable' },
                },
              ),
            performCrossSwitch: async ({ sessionId: sid, targetAgentKind, agentDeviceId, model, providerId, effort, fastMode, skipBootstrap, cause }) => {
              if (targetAgentKind === 'acp') return { switched: false };
              return performSessionAgentSwitch(agentSwitchDeps, {
                sessionId: sid,
                targetAgentKind,
                agentDeviceId,
                model,
                providerId,
                effort,
                fastMode,
                applyNow: true,
                skipBootstrap,
                configStaged: true,
                preserveModelGroupBinding: true,
                routeChangeAttribution: { by: 'model-group', reason: cause ?? 'unavailable' },
              });
            },
            writeSwitchNote: async (sid, note, clientId) => {
              await deps.createDbMessage(sid, {
                clientId,
                role: 'assistant',
                content: '',
                agentMeta: { pluginModelRoute: note },
              });
            },
            describeCause: (cause) => modelGroups.describeTurnSwitchCause(cause),
            runAsOwner: (work) => runOutsideDeviceLinkInvokeContext(work),
          },
          sessionId,
          {
            hasImages: options?.hasImages,
            autoResume: options?.autoResume,
            scheduled: options?.scheduled,
            signal: options?.signal,
          },
        );
      }
    },
    readPendingTarget: (sessionId: string) => projectPendingModelGroupTarget(pendingSwitches.get(sessionId)),
    markPendingModelGroupPick: (sessionId: string, pickedKey: string) => pendingSwitches.markModelGroupPick(sessionId, pickedKey),
    broadcastBindingProjection(sessionId: string): void {
      void broadcastSessionRuntimeProjection(sessionId).catch(() => undefined);
    },
    /** The session settings write with the budget hook (persistSessionFieldsWith): /sessions/update's budget. */
    persistSessionFields,
    onTurnSettled: settlement.settle,
    disposeTurnSettlements: settlement.dispose,
    holdTurnSettlements: settlement.hold,
    deferredTurnSettlements: settlement.pendingIds,
    /**
     * register.ts registerPendingCredentialSwitchForSession: a credential switch that waits for the task's
     * turn to end. The Agent, system, IM card and scheduled model changes register through it on the
     * desktop; on the Host they are not wired yet (release table, B2), so only tests call it today.
     */
    registerPendingCredentialSwitch: (
      sessionId: string,
      target: Parameters<typeof registerPendingCredentialSwitchWith>[2],
    ) => registerPendingCredentialSwitchWith(accessPorts(), sessionId, target),
    /** Whether a credential switch waits for this task's turn to end (the coordinator and idle-release gates). */
    hasPendingCredentialSwitch: (sessionId: string) => pendingCredentialSwitchService.has(sessionId),
    clearIntent(sessionId: string) {
      pendingSwitches.clear(sessionId);
    },
    onSessionClosed,
    /** Subscribes to a Maker's session-closed events (each session's own close); returns the unsubscribe. */
    /** register.ts's cold Pi window check (createColdPiRehydrationBinding); the context rollover binds it too. */
    rehydrateColdPiRuntimeForWindowVerification,
    attachMaker(target: Pick<Maker, 'on'>): () => void {
      return target.on(event => {
        if (event.type === 'session:closed') onSessionClosed(event.sessionId, event.session);
      });
    },
  };
}

type HostRuntimeSelection = ReturnType<typeof createHostRuntimeSelection>;

/**
 * The process-wide runtime selection slots the desktop fills at startup, filled for the Host: main.ts
 * calls this once, after the runtime selection is built and before the first owner commit
 * (configureHostOwner in ensureRuntime). Returns the undo, for tests.
 *
 * The task read projector (mapper.ts setSessionRuntimeProjector; the desktop's, register.ts): every task
 * read (the task list, a single task) shows the route the task runs on, an accepted runtime override
 * (an automatic fallback) included, with runtimeEffective, runtimePending and runtimeGeneration, as the
 * route change pushes already do.
 *
 * The cleanup at a task's archive or delete (sessionRuntimeCleanup.ts setSessionRuntimeCleanup; the
 * desktop's, register.ts): the status writers call cleanupSessionRuntimeForTerminalStatus, which runs it,
 * so a task archived after an automatic fallback starts on its saved route once restored.
 *
 * The app session commit boundary (appSessionState.ts setAppSessionCommitBoundaryHook; the desktop's
 * hook, bootstrap-electron.ts): when the owner changes, before the new owner is visible, every task's
 * provider, runtime axes and runtime control state go (clearOwnerScopedSessionRuntimeSelection, which
 * also advances the owner epoch). The desktop's other steps of that hook, on the Host:
 * - local Agent confirmations (cancelLocalAgentConfirmations): the Host runs no local Agent service
 *   (release table row 29); its own tool confirmations close in disposeOwnerRuntime (main.ts), which
 *   every owner commit follows;
 * - a Claude Code login in progress (cancelClaudeCliLogin): disposeOwnerRuntime closes the provider
 *   configuration, whose cancelLogins aborts it and kills the CLI child; every commit of another owner
 *   follows that dispose (ensureRuntime refuses an owner switch while an owner runtime is up);
 * - task attention badges, remote desktop viewers, popped-out tab windows: window state, which the
 *   Host does not have.
 */
export function bindHostSessionRuntimeHooks(selection: {
  sessionRuntimeProjector: SessionRuntimeProjector;
  sessionRuntimeCleanup(sessionId: string): void;
}): () => void {
  setAppSessionCommitBoundaryHook(() => clearOwnerScopedSessionRuntimeSelection());
  setSessionRuntimeProjector(selection.sessionRuntimeProjector);
  setSessionRuntimeCleanup(selection.sessionRuntimeCleanup);
  return () => {
    setAppSessionCommitBoundaryHook(null);
    setSessionRuntimeProjector(null);
    setSessionRuntimeCleanup(null);
  };
}

/**
 * The input queue's hooks the runtime selection answers (main.ts passes them to createInputQueue; the
 * input-queue tests use the same function): a pick lands at the send, the coordinator and idle-release
 * gates of a pending credential switch (with the gateway restart, deferredRestartQueueWiring.ts), a
 * turn's end landing that switch before the rest of the settle work, a runtime's own Plan change, and
 * the start admission of a runtime.
 * The selection is read at call time: main.ts creates it after the queue.
 */
export function hostRuntimeSelectionQueueHooks(
  getSelection: () => Pick<HostRuntimeSelection,
    'applyPendingAgentSwitch' | 'hasPendingCredentialSwitch' | 'onTurnSettled' | 'deferredTurnSettlements' | 'holdTurnSettlements' | 'disposeTurnSettlements' | 'persistAgentPlanModeChange'
    | 'maybeApplySessionRuntimeFallback' | 'pendingSessionRuntimeFallbackRebuilds' | 'admitLocalRoute' | 'readDispatchRoute'>,
  ports: { isSessionRestarting(sessionId: string): boolean; afterTurnSettled?(sessionId: string): void },
) {
  return {
    applyPendingAgentSwitch: (sessionId: string, options?: HostPendingSwitchOptions) =>
      getSelection().applyPendingAgentSwitch(sessionId, options),
    readDispatchRoute: (...args: Parameters<HostRuntimeSelection['readDispatchRoute']>) =>
      getSelection().readDispatchRoute(...args),
    hasPendingCredentialSwitch: createDeferredRestartQueueGate(explicitPorts<Parameters<typeof createDeferredRestartQueueGate>[0]>({
      hasPendingCredentialSwitchEntry: (sessionId: string) => getSelection().hasPendingCredentialSwitch(sessionId),
      isSessionRestarting: (sessionId: string) => ports.isSessionRestarting(sessionId),
    })),
    hasPendingCredentialSwitchEntry: (sessionId: string) => getSelection().hasPendingCredentialSwitch(sessionId),
    disposeTurnSettlements: () => getSelection().disposeTurnSettlements(),
    holdTurnSettlements: (tasks: Iterable<string>) => getSelection().holdTurnSettlements(tasks),
    deferredTurnSettlements: () => getSelection().deferredTurnSettlements(),
    onSessionSettled: (sessionId: string) => getSelection().onTurnSettled(sessionId),
    afterTurnSettled: ports.afterTurnSettled,
    persistAgentPlanModeChange: (...args: Parameters<HostRuntimeSelection['persistAgentPlanModeChange']>) =>
      getSelection().persistAgentPlanModeChange(...args),
    // The interrupted-turn auto-resume's route change and its rebuild leases (auto-resume.ts).
    maybeApplySessionRuntimeFallback: (...args: Parameters<HostRuntimeSelection['maybeApplySessionRuntimeFallback']>) =>
      getSelection().maybeApplySessionRuntimeFallback(...args),
    pendingSessionRuntimeFallbackRebuilds: {
      set: (session: Session, attemptToken: number) => getSelection().pendingSessionRuntimeFallbackRebuilds.set(session, attemptToken),
      delete: (session: Session) => getSelection().pendingSessionRuntimeFallbackRebuilds.delete(session),
    },
    /** Every runtime start of the executor takes this admission before its runtime is created. */
    admitLocalRoute: (...args: Parameters<HostRuntimeSelection['admitLocalRoute']>) => getSelection().admitLocalRoute(...args),
  };
}

