/**
 * registerMakerIpc — 把 Maker Core 的能力暴露为 maker:* IPC channel。
 *
 * 设计：
 * - 单 maker 实例服务所有 BrowserWindow（Maker 是进程级单例）
 * - 事件流转发：每个 session 启动事件 forward loop，主动 push 到所有 window
 * - permission 流：renderer 收到 permission-request 后，调用 resolve-permission 回信
 *   （本轮 ClaudeAgent adapter 暂未接通到 SDK canUseTool，详见 claude-code-agent.ts 的 warn）
 *
 * 老的 cc-agent:* / codex:* IPC handler 完全不动，新链路与老链路并行。
 */

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AgentEvent,
  AgentKind,
  ContextUsageData,
  InteractionDecision,
  InteractionRequest,
  Maker,
  SendOrigin,
  SessionSendOptions,
  SessionSendResult,
  UserMessage,
} from '@cindy/maker-core';
import { createId } from '@paralleldrive/cuid2';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import { DL_SESSION_REFERENCE_CAPABILITY_CHANNEL } from '@cindy/device-link';
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { getActiveAppSession } from '../appSessionState.js';
import type { AgentMeta } from '../../renderer/lib/ccAgent.types';
import {
  deriveAutoTitleSeed,
  getAgentFacingText,
  serializeSessionReferencePayload,
  type AgentInputCreateOpts,
  type AgentInputQueuedMessage,
  type AgentInputSessionRef,
  type AgentInputSessionReferenceContext,
} from '../../shared/agentInputQueue.js';
import { getManagedWorktreeBasePath } from '../../shared/managedWorktreePaths.js';
import { normalizeWorkingDirForProjectSettings } from '../../shared/workingDir.js';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import type { DesktopCommandContext } from '../commands/index.js';
import { getDesktopCommandRegistry } from '../commands/index.js';
import {
  initGithubIssueSubmit,
  IssueConfirmBridge,
  type IssueConfirmInteractionSnapshot,
} from '../github-issue/index.js';
import {
  initGhostGrantConfirmBridge,
  type GhostGrantConfirmInteractionSnapshot,
} from '../cindy-brain/ghostGrantConfirmBridge.js';
import { createFeishuDesktopConfirmNotifier } from '../im/desktopConfirmNoticeWiring.js';
import {
  initGhostSetupInteractionBridge,
  parseGhostSetupInteractionCommand,
  parseGhostSetupInlineSubmitRequest,
  projectPendingInteractionsForRemote,
  type GhostSetupInteractionResponseTarget,
  type GhostSetupInteractionSnapshot,
} from '../cindy-brain/ghostSetupInteractionBridge.js';
import { initGhostSetupCoordinator } from '../cindy-brain/ghostSetupCoordinator.js';
import { toolNotFoundMessage } from '../cindy-brain/pipeDispatcher.js';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';
import { isGhostDisabledForWorkdir } from '../cindy-brain/ghostWorkdirPrefs.js';
import {
  executeGhostSetupAction,
  executeGhostSetupInlineAction,
  getGhostManager,
  getGhostSetupAssessment,
  isGhostAvailableForActiveSession,
} from '../cindy-brain/index.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererEvent,
} from '../security/trustedAppRenderer.js';
import {
  initRenameSessionsConfirm,
  RenameSessionsConfirmBridge,
  type RenameSessionsConfirmInteractionSnapshot,
} from '../session-title-rename/index.js';
import {
  getBrowserAvailability,
  openBrowserForLogin,
} from '../mcp-integrations/browser.js';
import { getActiveCodexBridgeInstanceId, getActiveCodexBridgeServerNames, shutdownCodexEnvironment } from '../mcp-integrations/codexEnvironment.js';
import { invalidatePiEnvironment, shutdownPiEnvironment } from '../mcp-integrations/piEnvironment.js';
import { REMOTE_MEMORY_SERVER_NAME } from '../mcp-integrations/codexHttpBridge.js';
import { getRemoteMcpBridgeToken } from '../mcp-integrations/remoteMcpBridgeToken.js';
import {
  checkComputerDriverUpdate,
  cancelComputerDriverPermissionGrant,
  getComputerDriverAppBundlePath,
  getComputerDriverAppIcon,
  getComputerDriverStatus,
  grantComputerDriverPermissions,
  installComputerDriver,
  pauseComputerDriverPermissionProbe,
  updateComputerDriver,
} from '../mcp-integrations/computer.js';
import {
  closeComputerPermissionGuideWindow,
  finishComputerPermissionAppDrag,
  getComputerPermissionGuideStatus,
  openComputerPermissionPaneForStatus,
  isComputerPermissionGuideWebContents,
  refreshComputerPermissionGuideWindow,
  seedOpenedPermissionPane,
  showComputerPermissionGuideWindow,
  startComputerPermissionAppDrag,
} from '../computer-permission-guide/window.js';
import { parseComputerPermissionGrantRequest } from '../computer-permission-guide/request.js';
import { shouldUseComputerPermissionGuide } from './computerPermissionGuideEligibility.js';
import * as imageCacheStore from '../imageCacheStore.js';
import { collectCindyMediaUrls, commitChatImageUrls } from '../cindy-media/chatAttachments.js';
import * as cindyChatAttachments from '../cindy-media/chatAttachments.js';
import { materializeGeneratedImage } from '../cindy-media/generatedMedia.js';
import { getDbClient } from '../localDb/client/current.js';
import {
  loadAgentInputQueueSnapshot,
  saveAgentInputQueueSnapshot,
} from '../localDb/agentInputQueueSnapshots.js';
import { ensureDialogueWorkspaceDir, dialogueWorkspaceRootDir } from '../localDb/dialogueWorkspace.js';
import {
  healMissingDialogueWorkdir,
  matchDialogueWorkspacePath,
} from '../localDb/dialogueWorkdirSelfHeal.js';
import {
  broadcastMessageRow,
  broadcastMessageDeleted,
  commitMessageDeletion,
  createMessage as createDbMessage,
  findParkedEngineSession,
  getMessageDeletionTarget,
  listMessagesForAgentHandoff,
  patchMessageAgentMeta,
  supersedeRetriedUserTurn,
} from '../localDb/ipc/messages.js';
import { messageToCamel } from '../localDb/mapper.js';
import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure.js';
import {
  applyAgentSwitchToSessionRow,
  applyAgentSwitchResumeFallbackAtomically,
  broadcastSessionPatched,
  clearSessionContextInDb,
  createSessionRemoteHostIdReader,
  getSessionRowSnapshot,
  persistSessionFields,
} from '../localDb/ipc/sessions.js';
// sidebar-card-mode: turn-done 后触发任务现状摘要生成
import { maybeGenerateSessionTaskSummary } from '../sessionTaskSummary.js';
import {
  addOrUpdateWorker,
  archiveSingleWorkerSession,
  archiveWorkersByTeam,
  createActiveTeam,
  getActiveTeamByLead,
  getSessionOrcaRole,
  getWorkerLink,
  isActiveWorkerStatus,
  listWorkersByLead,
  markTeamEnded,
  markWorkersStatusByTeam,
  markWorkerIdleIfStatus,
  restoreWorkerDoneIfIdle,
  reconcileInactiveTeamWorkersForLead,
  releaseWorkerCreationReservation,
  removeWorker,
  renewWorkerCreationReservation,
  reserveWorkerCreation,
  setSessionOrcaRole,
  setWorkerFocus,
  updateWorkerStatus,
} from '../localDb/orcaTeamStore.js';
import { messages, orcaTeams, orcaWorkers, sessions } from '../localDb/schema.js';
import { t } from '../i18n.js';
import { createLogger } from '../logger.js';
import { desktopClaudeAuthAdapter, desktopCodexAuthAdapter, readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { prepareSharedProjectSkillLinks } from '../maker-host/shared-global-skills.js';
import { setRemoteCodexLiveTurnChecker, setRemoteSessionStartEnsure, getRemoteCcTurnSettledHandler, getRemoteCcStaleQuery } from '../maker-host/remote-session-start-ensure.js';
import { getCodexProxyAuthInjection, getCodexProxyAuthInjectionState } from '../maker-host/codex-proxy-host.js';
import {
  readCollaborationSettings,
  readCollaborationSettingsState,
  resetCollaborationSettings,
  writeCollaborationSetting,
} from '../maker-host/collaboration-settings-store.js';
import {
  readAgentResourceSettingsState,
  resetAgentResourceSettings,
  writeAgentResourceSetting,
} from '../maker-host/agent-resource-settings-store.js';
import { createAgentResourceSettingsIpc } from './agent-resource-settings-ipc.js';
import { createGitSnapshotCoordinator } from '../maker-host/git-snapshot-host.js';
import {
  cancelCodexAuthModeChange,
  ensureCodexMcpBridgeStartedForRemote,
  finalizeCodexAfterAuthModeChange,
  getMaker,
  getPluginRegistry,
  prepareCodexForAuthModeChange,
  restartCodexAfterAuthModeChange,
  setBeforeLocalCodexSessionStartHook,
} from '../maker-host/index.js';
import {
  readMemorySettingsState,
  resetMemorySettings,
  type MemorySettings,
  writeMemorySetting,
} from '../maker-host/memory-settings-store.js';
import { GLOBAL_PLUGIN_IDS } from '../maker-host/plugins/types.js';
import {
  assertCollabProjectEnabled,
  resolveLocalCollabPolicyWorkingDir,
} from './collabProjectPolicy.js';
import type { GitSnapshotCoordinator } from '../git-snapshot/gitSnapshotCoordinator.js';
import {
  getRemoteNewMakerDefaults,
  getWorkerDefaultsFromNewMaker,
  type NewMakerDraftSnapshot,
  type ProviderModelMemorySnapshot,
  setNewMakerDraftCache,
  setProviderModelMemoryCache,
} from '../maker-host/newMakerDefaultsCache.js';
import { withRehydrateCloseSuppressed } from '../maker-host/rehydrateCloseSuppression.js';
import { handleCloseSessionRequest } from './closeSessionRequest.js';
import {
  createOrcaIdleReleaseWatcher,
  ORCA_IDLE_RELEASE_STATUSES,
  type OrcaIdleReleaseWatcher,
} from './orcaIdleReleaseWatcher.js';
import {
  ackSessionTurnEndedDurable,
  hasAssistantProgressAfterMessage,
  markSessionTurnEnded,
  markSessionTurnEndedAfterBarrier,
  markSessionTurnStarted,
} from '../localDb/sessionActiveTurn.js';
import {
  assertDesktopSendDispatched,
  createHostSendFailure,
  observeFireAndForgetSendOutcome,
  toDesktopSessionDispatchOutcome,
} from '../maker-host/send-outcome.js';
import {
  markSessionUsedProjectContext,
  readSessionExtraDirsFromDb,
  readSessionWorkingDirFromDb,
} from '../maker-host/session-storage.js';
import {
  clearSessionPersistState,
  consumeLastAssistantPersistId,
  consumeLastTopLevelAssistantPersistId,
  drainPersistQueue,
  enqueueDurableWrite,
  flushAssistantBlock,
  flushOrphanToolResults,
  getLastAssistantTranscriptUuid,
  getSessionDbAgentKind,
  markAssistantTurnCompleted,
  markAssistantTurnFailed,
  noteAgentMeta,
  noteSessionAgentKind,
  noteSessionClearBoundary,
  noteTurnStarted,
  onAssistantTextEvent,
  onInteractionMessage,
  onInteractionResolved,
  onThinkingEvent,
  onToolResultEvent,
  onToolResultFullEvent,
  onToolUseEvent,
  markAutoResumeOutcome,
  onTurnErrorEvent,
  prepareSyntheticToolEventForBroadcast,
  resetTurnPersistState,
  saveTurnStartedAtForDeferred,
} from '../messagePersistBroadcaster.js';
import { ensureCcManagerInstalledOrInstall } from '../remote-ssh/cc-manager-install.js';
import { ensureRemoteCodexMcpBridge, hasPendingRemoteMcpDrift } from '../remote-ssh/codex-remote-mcp.js';
import {
  hasPendingAgentProxyReconcile,
  reconcileCodexAgentProxyEnv,
  setAgentProxyLiveTurnChecker,
} from '../remote-ssh/agent-proxy.js';
import { ensureRemoteAgentInstalledOrInstall, ensureRemoteHostReady, getRemoteSshPool, isCcMgrUpgradeInFlight } from '../remote-ssh/index.js';
import {
  recordSessionContextSnapshot,
  recordSessionTurnSpend,
  recordSessionTurnTokens,
} from '../sessionSpendBroadcaster.js';
import {
  codexUsageToTokens,
  piUsageToTokens,
  recordSchedulerTurnCost,
  recordTurnCostOnMessage,
  recordTurnUsageOnMessage,
} from '../turnCostBroadcaster.js';
import { recordModelMismatchOnMessage } from '../modelMismatchBroadcaster.js';
import { detectClaudeModelMismatch } from '../../shared/modelMismatch.js';
import { triggerClaudeAccountUsageRefresh } from '../usage/claudeAccountUsage.js';
import { broadcastEffectiveModelPricing, getCodexProviderSubscriptionValuePrice, getGatewayAccountCurrency, getModelPriceQuote, getModelPricing, getModelPricingForModel, getSubscriptionDirectValuePrice } from '../usage/modelPricing.js';
import { clearModelPriceOverride, stageProviderModelPriceOverridesClear, readModelPriceOverrideView, setModelPriceOverride } from '../usage/modelPriceOverrideStore.js';
import { computeModelUsageDeltas, detectOutputLag, type ModelUsageCumulative, type ModelUsageDeltaEntry } from '../usage/modelUsageDelta.js';
import { claudeSubscriptionUsageModelKey, codexApiUsageModelKey, codexSubscriptionUsageModelKey, piSubscriptionUsageModelKey } from '../usage/usageHistory.js';
import { billingRouteForExplicitProvider, buildClaudeTurnUsageDetails, computePriceQuoteTurnMoney, estimateClaudeSubscriptionTurnValue, isAnthropicModel, normalizeModelIdForPricing, resolveClaudeTurnCostSinks, type BillingRoute } from '../usage/turnCostCalculator.js';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX, isSubscriptionDirectModel } from '../../shared/subscriptionModels.js';
import {
  addRegionalMoney,
  usdToLedgerCurrency,
  type RegionalMoney,
} from '../../shared/regionalMoney.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { triggerClaudeSubscriptionUsageRefresh, triggerCodexAccountUsageRefresh } from './usage.js';
import {
  rebroadcastCodexTodayUsage,
  rebroadcastTodaySpend,
  recordCodexAccountUsageSnapshot,
  recordCodexTurnUsage,
  recordModelTurnUsage,
  recordTurnSpend,
} from '../usageBroadcaster.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { dbToMakerAgentKind, makerToDbAgentKind } from '../../shared/agentKindConversion.js';
import { readWorkflowProgressForSession } from '../workflow-progress/reader.js';
import {
  AgentInputCoordinator,
} from './agent-input-coordinator.js';
import {
  estimateReferenceTokens,
  MAX_REFERENCE_MESSAGES,
  MAX_REFERENCE_TOKENS,
  MAX_SESSION_REFERENCES,
  resolveSessionReferences,
} from './sessionReferenceResolver.js';
import { registerAndroidAutomationHandlers } from './androidHandlers.js';
import { MAKER_INVOKE, MAKER_PUSH, MAKER_SEND } from './channels.js';
import type {
  CollabDispatchOutcome,
} from './collabSendOutcome.js';
import { runAcceptedCallback } from './acceptedCallbackRunner.js';
import { createElectronIpcHandlerRegistry } from './electronIpcRegistry.js';
import { refreshCodexMcpEnvironment } from './codexMcpRefresh.js';
import { broadcastSchedulerChanged } from './schedule.js';
import { validateExtraDirs } from './extraDirsValidator.js';
import { prepareHandoffWorktree, shouldRecycleHandoffWorktreeOnFailure } from './handoffWorktree.js';
import { validateHandoffWorkingDir } from './handoffWorkingDir.js';
import { registerProjectPluginPolicyHandlers } from './projectPluginPolicyHandlers.js';
import { registerPrecreatedWorktreeDiscardHandler } from './precreatedWorktreeDiscardHandler.js';
import { registerNewMakerWorktreePreferenceHandler } from './newMakerWorktreePreferenceHandler.js';
import {
  resolveFreshSourceBranch,
  restoreMissingManagedWorktreeForSession,
  WorktreeManager as worktreeManager,
  worktreeStore,
} from '../worktree/index.js';
import type { WorktreeMeta } from '../worktree/types.js';
import {
  createOrcaInterAgentDispatcher,
  type DispatchOrcaInterAgentMessageParams,
  type DispatchOrcaInterAgentMessageResult,
  type OrcaInterAgentDispatcher,
  type OrcaInterAgentMessageSource,
} from './orcaInterAgentDispatcher.js';
import {
  getOrcaWorkspaceInfoReadOnly,
  getOrcaWorkerDiagnosticStatusReadOnly,
  readOrcaWorkerOutputReadOnly,
} from './orcaDiagnostics.js';
import { createMakerSendTransaction } from './makerSendTransaction.js';
import {
  installDesktopInteractionHandler,
  installInteractionLifecycleObserver,
} from './interactionRouter.js';
import { registerMakerMessageDeleteHandler } from './messageDeleteHandler.js';
import {
  normalizeUserMessage,
  materializeDirectSendOssAttachments,
  materializeQueuedOssAttachments,
} from './normalizeAttachments.js';
import { AGENT_ISLAND_DISPLAY_CONFIG } from '../agent-island/displayConfig.js';
import {
  shouldClearAgentIslandSessionForOrcaWorker,
  shouldNotifyAgentIslandForSession as shouldNotifyAgentIslandForSessionByPolicy,
} from '../agent-island/notificationPolicy.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { createOrcaLifecycleService, ORCA_WORKER_READY_MESSAGE } from './orcaLifecycleService.js';
import { throwOrcaServiceFailure } from './orcaServiceFailure.js';
import { createOrcaTeamService, findFocusTargetWorker, type ListWorkerQueuedMessagesResult, type OrcaTeamService, type OrcaWorkerEffort, type WorkerQueuedMessageControlResult } from './orcaTeamService.js';
import {
  createOrcaWorkerCreationService,
  normalizeOrcaWorkerLabel,
  providerRouteRequiresExplicitSelection,
} from './orcaWorkerCreationService.js';
import { registerOrcaWorkerControlHandlers } from './orcaWorkerControlHandlers.js';
import {
  clearOrcaMcpHydrated,
  isOrcaMcpHydrated,
  knownNonOrcaSessionIds,
  markOrcaMcpHydratedIfNeeded,
  markKnownNonOrcaIfApplicable,
} from './orcaMcpHydrationCache.js';
import {
  applyOrcaInstructions,
  synthesizeOrcaVendorOptionsFromDb,
} from './orcaSessionStartOptions.js';
import {
  clearManualInterrupt,
  forgetKnownOrcaWorkerSession,
  getManualInterrupt,
  isKnownOrcaWorkerSession,
  markKnownOrcaWorkerSession,
  markManualInterrupt,
} from './orcaManualInterrupt.js';
import { tryInjectProjectContext } from './projectContextInject.js';
import { registerMakerSessionCreateHandler } from './sessionCreateHandler.js';
import {
  applyPendingAgentSwitchIfIdle,
  applySetModelThenCancelAgentSwitchIntent,
  createPendingAgentSwitchRegistry,
  registerMakerSessionAgentSwitchHandler,
  type MakerSessionAgentSwitchHandlerDeps,
} from './sessionAgentSwitchHandler.js';
import { prependHandoffToUserMessage } from './agentHandoff.js';
import { hydrateQueuedAgentReferences } from './agentInputReferences.js';
import { agentHandoffPending } from './agentHandoffPendingSingleton.js';
import { type MakerSessionCreateOpts, withCreateSessionStderr } from './sessionRequest.js';
import { persistAndHydrateSessionProvider } from './sessionProviderBootstrap.js';
import { registerMakerSessionSendHandler } from './sessionSendHandler.js';
import { registerStopAgentTaskHandler } from './stopAgentTaskHandler.js';
import { registerStopSessionBackgroundTasksHandler } from './stopSessionBackgroundTasksHandler.js';
import { registerProviderHandlers } from './providerHandlers.js';
import { createLocalCliScanDeps, scanLocalCliAuth } from './localCliDetect.js';
import { registerMcpHandlers } from './mcpHandlers.js';
import {
  getBuiltinMcpServerNames,
  refreshCustomMcpProviders,
} from '../mcp-integrations/custom-mcp-registry.js';
import {
  getDesktopProviderService,
  getDesktopSelectableCatalog,
  refreshActiveCatalogFromSource,
  refreshCustomProvidersIntoCatalog,
} from '../maker-host/createDesktopProviderService.js';
import {
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  isModelSelectableForNewRoute,
  type ProviderView,
} from '@cindy/model-providers';
import {
  getSessionProvider,
  hydrateSessionProvider,
  normalizeSessionProviderId,
  setSessionProvider,
} from '../maker-host/session-provider-store.js';
import { getActiveCatalog, setDiscoveredProviderModels } from '../maker-host/active-catalog.js';
import { testProviderConnection } from '../maker-host/provider-diagnostics.js';
import { fetchProviderModels } from '../maker-host/provider-model-fetch.js';
import {
  beginProviderRouteMutation,
  isUserProviderSession,
} from '../maker-host/provider-route.js';
import {
  getAnthropicModelDiscoveryFailure,
  refreshAnthropicModelsFromHttp,
} from '../maker-host/model-discovery/anthropic.js';
import { refreshBuiltinProviderModels } from '../maker-host/provider-model-refresh.js';
import {
  configureProviderModelAutoRefresh,
  refreshProviderModelsManually,
  requestProviderModelAutoRefresh,
} from '../maker-host/provider-model-auto-refresh.js';
import { setProviderUpstreamErrorBroadcaster } from '../maker-host/provider-upstream-error-observer.js';
import {
  createClaudeAutoPermissionFallbackCoordinator,
  setClaudeAutoClassifierUnavailableListener,
} from '../maker-host/claude-auto-permission-fallback.js';
import {
  cancelGenericOAuthLogin,
  deriveModelsDiscoveryUrl,
  discoverGenericOAuthModels,
  logoutGenericOAuth,
  removeGenericOAuthCredentialsReversibly,
  runGenericOAuthLogin,
} from '../maker-host/generic-oauth.js';
import {
  getCustomProvider,
  mergeDiscoveredModelsIntoConfig,
  updateCustomProviderIfUnchanged,
} from '../maker-host/custom-provider-store.js';
import {
  readCustomProviderHeadersForMutation,
  readCustomProviderKeyForMutation,
  removeCustomProviderHeaders,
  removeCustomProviderKey,
  storeCustomProviderHeaders,
  storeCustomProviderKey,
} from '../secrets/providerSecretStore.js';
import { setSessionEffort, setSessionFastMode } from '../maker-host/session-effort-store.js';
import {
  getModelVisibilityMirrorSnapshot,
  syncModelVisibilityMirror,
} from '../maker-host/model-visibility-mirror.js';
import {
  clearProviderDisableOverrides,
  setModelsDisabled,
  setProviderDisabled,
  stageProviderDisableOverridesClear,
} from '../maker-host/model-disable-store.js';
import { readProviderOrder, setProviderOrder } from '../maker-host/provider-order-store.js';
import {
  resolveLenientSessionRoute,
  verdictForModelRoute,
} from '../maker-host/model-route-guard-live.js';
import { setClaudeProxySessionIdResolver } from '../maker-host/anthropic-compat-proxy-host.js';
import {
  clearClaudeSessionBackgroundActivity,
  getClaudeSessionBackgroundActivity,
  listActiveClaudeBackgroundActivitySessions,
  noteClaudeSessionTurnState,
  setClaudeBackgroundActivityBroadcaster,
} from '../maker-host/claude-session-background-activity.js';
import { readClaudeSessionRoute } from '../maker-host/claude-session-route-registry.js';
import { consumeClaudeGatewayOpusPlanMismatch } from '../maker-host/claude-gateway-error-observer.js';
import { setLiveCcSessionBridge } from '../maker-host/claude-transcript-relocation.js';
import {
  CredentialModeSwitchBusyError,
  isCredentialModeSwitchBusyError,
  isLocalSessionBusy,
} from '../maker-host/codex-credential-switch.js';
import { applyRuntimeSetModelChange } from './runtimeSetModel.js';
import { PendingCredentialSwitchService } from './pendingCredentialSwitch.js';
import {
  DeferredCodexRestartService,
  runMemoryChangeWithCodexRestart,
  type MemoryChangeParts,
} from './deferredCodexRestart.js';
import {
  hasAnySessionInTurn,
  isSessionTurnDispatchBoundaryBusy,
  isTerminalTurnErrorEvent,
  SessionTurnActivityTracker,
} from './sessionTurnActivityTracker.js';
import { resolveClearSessionBoundary } from './clearSessionBoundary.js';
import { tapWindowBroadcast } from '../device-link/broadcast-tap.js';
import { setBusyProbe as setDeviceLinkBusyProbe } from '../device-link/index.js';
import {
  markRemoteSettingPersistedInsideHandler,
  setRemoteWorkingDirGuard as setDeviceLinkRemoteWorkingDirGuard,
  setRemoteSettingsPersist as setDeviceLinkRemoteSettingsPersist,
} from '../device-link/dispatch.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import {
  assertResolveInteractionOrigin,
  isPluginSetupInteractionDecision,
} from './interactionResolveOrigin.js';
import { checkRemoteWorkingDir } from '../device-link/remote-workdir-guard.js';
import { createWorkerTurnStartSequencer } from './workerTurnStartSequencer.js';
import { createBusinessSessionId } from '../sessionIds.js';
import { forkSessionAtMessage } from '../maker-orchestration/fork.js';
import {
  isSessionAutoTitleEligible,
  registerSessionAutoTitleHooks,
  scheduleSessionAutoTitle,
} from './sessionAutoTitle.js';
import {
  SILENT_STOP_RESUME_PROMPT,
  SilentStopAutoResumeGuard,
} from './silentStopAutoResume.js';
import {
  publishUiContinuation,
  publishUiSessionIntervention,
  publishUiTurnDispatching,
  publishUiTurnUndispatched,
} from './uiContinuationSignal.js';
import { readSilentStopAutoResumeSettings } from '../maker-host/silent-stop-auto-resume-store.js';
import {
  AutoResumeBookkeeping,
  type SuppressedTurnError,
} from './autoResumeBookkeeping.js';
import {
  InterruptedTurnAutoResumeGuard,
  isAutoResumeUserMessage,
  isInterruptedTurnError,
  isSubstantiveProgressEvent,
  type InterruptedTurnErrorSignals,
} from './interruptedTurnAutoResume.js';
import { readInterruptedTurnAutoResumeSettings } from '../maker-host/interrupted-turn-auto-resume-store.js';
import {
  broadcastGhostMessageBlocked,
  broadcastGhostMessageRewritten,
  createGhostSessionTap,
  getGhostFsSlot,
  hasEnabledGhostAssistantHook,
  runGhostAssistantReplyHook,
  hasEnabledUserMessageHookGhost,
  screenGhostUserMessage,
  setGhostAgentTurnRunner,
  setGhostErrandRunner,
  setGhostWorkspaceSessionService,
  notifyGhostSessionEvent,
  getInstalledGhostName,
} from '../cindy-brain/index.js';
import {
  readGhostErrandConfig,
  readGhostErrandSessionId,
  writeGhostErrandSessionId,
} from '../cindy-brain/errandPrefsStore.js';
import { isGhostPickedDir } from '../cindy-brain/pickGrantsStore.js';
import { createGhostErrandRunner } from './ghostErrandRunner.js';
import {
  createGhostErrandSession,
  createPluginDraftSession,
  findActiveSessionByWorkdir,
} from '../localDb/ipc/pluginWorkspaceSessions.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { openMainWindowSession } from '../deepLink.js';

const log = createLogger('maker-ipc');

async function prepareProjectSkillLinksFailSoft(workingDir: unknown): Promise<boolean> {
  // Slash/@ palettes are read-only device-link surfaces. Their remote invokes must not
  // create or remove compatibility links in the controlled project's filesystem.
  if (isDeviceLinkInvoke() || typeof workingDir !== 'string' || !workingDir) return false;
  try {
    const result = await prepareSharedProjectSkillLinks({ workingDir });
    for (const warning of result.warnings) {
      log.warn('shared project skill link warning', { workingDir, warning });
    }
    return result.changed;
  } catch (err) {
    log.warn('prepare shared project skill links failed', {
      workingDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
const workerTurnStartSequencer = createWorkerTurnStartSequencer(log);
// silent-stop 自动续跑守卫(决策语义与防死循环不变量见 silentStopAutoResume.ts 文件头)。
// 纯内存、app 级单例:额度按 sessionId 记账,kill switch 每次决策时现读(改配置即生效)。
const silentStopAutoResumeGuard = new SilentStopAutoResumeGuard({
  isEnabled: () => readSilentStopAutoResumeSettings().enabled,
  log: {
    debug: (message, meta) => log.debug(message, meta),
    warn: (message, meta) => log.warn(message, meta),
  },
});
// 中断自动续跑守卫(上游把已有产出的 turn 打断 → 自动替用户点一次「继续」)。
// 与 silent-stop 那份**额度独立记账**,理由见 interruptedTurnAutoResume.ts 文件头。
const interruptedTurnAutoResumeGuard = new InterruptedTurnAutoResumeGuard({
  isEnabled: () => readInterruptedTurnAutoResumeSettings().enabled,
  log: {
    debug: (message, meta) => log.debug(message, meta),
    warn: (message, meta) => log.warn(message, meta),
  },
});

// Schedule 不另建重试状态机：真正的恢复仍由 AgentInputCoordinator +
// AutoResumeBookkeeping 独占。这里仅把「这一轮 scheduler run 已被普通自动续跑接管」
// 和「最终仍失败」桥给 runner，让同一个 run 继续等待或正确失败。
const pendingSchedulerAutoResumeRunBySession = new Map<string, string>();
const schedulerAutoResumeFailureListeners = new Map<string, Set<() => void>>();

function schedulerAutoResumeRunKey(sessionId: string, runId: string): string {
  return JSON.stringify([sessionId, runId]);
}

function beginSchedulerAutoResume(sessionId: string, runId: string): void {
  pendingSchedulerAutoResumeRunBySession.set(sessionId, runId);
}

function clearSchedulerAutoResumePending(sessionId: string, runId: string): void {
  if (pendingSchedulerAutoResumeRunBySession.get(sessionId) === runId) {
    pendingSchedulerAutoResumeRunBySession.delete(sessionId);
  }
}

function notifySchedulerAutoResumeFailed(sessionId: string, runId: string): void {
  clearSchedulerAutoResumePending(sessionId, runId);
  const listeners = schedulerAutoResumeFailureListeners.get(
    schedulerAutoResumeRunKey(sessionId, runId),
  );
  if (!listeners) return;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Runner listener failures must not break chat recovery cleanup.
    }
  }
}

function failPendingSchedulerAutoResume(sessionId: string): void {
  const runId = pendingSchedulerAutoResumeRunBySession.get(sessionId);
  if (runId) notifySchedulerAutoResumeFailed(sessionId, runId);
}

export function isSchedulerAutoResumePending(sessionId: string, runId: string): boolean {
  return pendingSchedulerAutoResumeRunBySession.get(sessionId) === runId;
}

export function onSchedulerAutoResumeFailed(
  sessionId: string,
  runId: string,
  listener: () => void,
): () => void {
  const key = schedulerAutoResumeRunKey(sessionId, runId);
  let listeners = schedulerAutoResumeFailureListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    schedulerAutoResumeFailureListeners.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) schedulerAutoResumeFailureListeners.delete(key);
  };
}

/** Schedule pause/delete：只撤销仍属于该 run 的普通聊天自动续跑。 */
export function cancelSchedulerAutoResume(sessionId: string, runId: string): boolean {
  if (!isSchedulerAutoResumePending(sessionId, runId)) return false;
  // teardown 是既有唯一生命周期出口：撤退避、清 coordinator 接管与隐藏续跑、
  // 结算活动行并通知 runner。runId 校验防止迟到的旧 abort 误杀新 run。
  autoResumeBookkeeping.teardown(sessionId);
  return true;
}

/**
 * 中断自愈的每会话簿记(压住的错误详情 / 待确认的重连记录 / 退避排期)。
 *
 * 状态与生命周期不变量都在 `autoResumeBookkeeping.ts`(有单测);这里只注入副作用:
 * 落库、结果回填、守卫额度回滚、清 coordinator 接管态。
 */
const autoResumeBookkeeping = new AutoResumeBookkeeping({
  // agentMeta 传 null:补落时原事件已不在手上(接管决策可能发生在延后结算路径、或退避
  // 3–20 秒之后),onTurnErrorEvent 无 agentMeta 时按 register 记录的 turnDedupId 做多窗
  // dedup(saveTurnStartedAtForDeferred 已在压住那一刻存好 turn 开始时刻)。
  persistSuppressedError: (sessionId, detail) => onTurnErrorEvent(sessionId, detail, null),
  surfaceSuppressedError: (sessionId, detail) =>
    surfaceSuppressedAutoResumeErrorInAgentIsland(sessionId, detail),
  markOutcome: (sessionId, clientId, outcome) => {
    void markAutoResumeOutcome(sessionId, clientId, outcome);
  },
  rollbackGuardPendingResume: (sessionId) =>
    interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId),
  // holder 是可变绑定,必须懒读(模块初始化时 coordinator 还没建)。
  abandonTakeover: (sessionId, message) =>
    agentInputCoordinatorHolder?.abandonAutoResume(sessionId, message),
  onAutoResumeFailed: failPendingSchedulerAutoResume,
  log: (message, fields) => log.debug(message, fields),
});

/**
 * 用户明确停止会话时统一撤销两类自动续跑与它们的退避簿记。
 *
 * 这个边界必须早于 live Session 查询：owner 切换期间可能暂时拿不到 Session，
 * 但已经排期的 timer / scheduler takeover 仍然存在，不能因此漏清后原地复活。
 */
function resetAutomaticRecoveryForExplicitStop(sessionId: string): void {
  silentStopAutoResumeGuard.noteSessionReset(sessionId);
  interruptedTurnAutoResumeGuard.noteSessionReset(sessionId);
  autoResumeBookkeeping.teardown(sessionId);
}

function settleUndispatchedAutoResumeOutcome(
  sessionId: string,
  item: AgentInputQueuedMessage,
): boolean {
  if (!autoResumeBookkeeping.isPendingOutcomeClientId(sessionId, item.clientId)) return false;
  // markOutcome 复用 durable-write 队列；持久化中取消时，failed patch 会排在
  // 正在进行的 user row insert 后面，不会出现先 patch、后 insert 的窗口。
  autoResumeBookkeeping.settleOutcome(sessionId, 'failed');
  return true;
}

/**
 * 非 renderer 发送路径(scheduler runner / hook runner)调用:给 silent-stop
 * 守卫充值自动续跑额度。renderer 发送走 createMakerSendTransaction 内部已充值,
 * 但 scheduler/hook 直接 session.send,必须额外调这里。
 */
export function noteSilentStopUserSend(sessionId: string): void {
  silentStopAutoResumeGuard.noteUserSend(sessionId);
}

/**
 * 非 renderer 中止路径(IM `!stop` 等)调用。历史名称保留给现有调用方；实际必须
 * 同时撤掉 silent-stop、中断续跑及退避簿记，保证所有明确 Stop 入口同一语义。
 */
export function noteSilentStopSessionReset(sessionId: string): void {
  resetAutomaticRecoveryForExplicitStop(sessionId);
}

/**
 * silent-stop 决策结果通知:scheduler/hook runner 等 in-process 监听方无法从
 * session.onEvent 收到合成的 settle 信号,通过本回调获知非续跑决策已做出,
 * 以便结束被 silentStop done 挂起的 turnFinished promise。
 * 回调参数 settled=true 表示该 session 的 silent-stop done 已 settle(不再续跑)。
 */
type SilentStopSettledCb = (sessionId: string, reason: 'exhausted' | 'skip' | 'send-failed') => void;
const silentStopSettledListeners = new Map<string, Set<SilentStopSettledCb>>();

export function onSilentStopSettled(sessionId: string, cb: SilentStopSettledCb): () => void {
  let set = silentStopSettledListeners.get(sessionId);
  if (!set) {
    set = new Set();
    silentStopSettledListeners.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) silentStopSettledListeners.delete(sessionId);
  };
}

function fireSilentStopSettled(sessionId: string, reason: 'exhausted' | 'skip' | 'send-failed'): void {
  const set = silentStopSettledListeners.get(sessionId);
  if (set) {
    for (const cb of set) {
      try { cb(sessionId, reason); } catch { /* swallow */ }
    }
  }
}

const COLLABORATION_SETTING_KEYS = [
  'workerSoftLimit',
  'workerHardLimit',
  'workerIdleReleaseMinutes',
] as const;
type CollaborationSettingKey = typeof COLLABORATION_SETTING_KEYS[number];
const COLLABORATION_WORKER_LIMIT_MAX = 20;
const COLLABORATION_IDLE_RELEASE_MAX_MINUTES = 120;

function isCollaborationSettingKey(key: unknown): key is CollaborationSettingKey {
  return typeof key === 'string'
    && (COLLABORATION_SETTING_KEYS as readonly string[]).includes(key);
}

function requireInteger(value: unknown, key: CollaborationSettingKey): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throwIpcError('INVALID_PARAMS', `${key} must be an integer`);
  }
  return value;
}

function validateCollaborationSettingValue(key: CollaborationSettingKey, value: unknown): number {
  const next = requireInteger(value, key);
  const current = readCollaborationSettings();
  if (key === 'workerIdleReleaseMinutes') {
    if (next < 0) throwIpcError('INVALID_PARAMS', `${key} must be >= 0`);
    if (next > COLLABORATION_IDLE_RELEASE_MAX_MINUTES) {
      throwIpcError('INVALID_PARAMS', `${key} must be <= ${COLLABORATION_IDLE_RELEASE_MAX_MINUTES}`);
    }
    return next;
  }

  if (next < 1) throwIpcError('INVALID_PARAMS', `${key} must be >= 1`);
  if (next > COLLABORATION_WORKER_LIMIT_MAX) {
    throwIpcError('INVALID_PARAMS', `${key} must be <= ${COLLABORATION_WORKER_LIMIT_MAX}`);
  }
  if (key === 'workerSoftLimit' && next > current.workerHardLimit) {
    throwIpcError('INVALID_PARAMS', 'workerSoftLimit must be <= workerHardLimit');
  }
  if (key === 'workerHardLimit' && next < current.workerSoftLimit) {
    throwIpcError('INVALID_PARAMS', 'workerHardLimit must be >= workerSoftLimit');
  }
  return next;
}

function collaborationSettingsWire() {
  const state = readCollaborationSettingsState();
  return {
    ...state.value,
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults,
  };
}

// agent-resource-settings 的 key 白名单/校验/wire 组装已抽到
// agent-resource-settings-ipc.ts(可注入依赖免 Electron 直测,含 sender 校验、
// 逐 key 校验、存储失败转 INTERNAL 的全套测试)。这里只保留 adapter 接线。
const agentResourceSettingsIpc = createAgentResourceSettingsIpc({
  assertTrustedSender: (event) =>
    assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
  readState: readAgentResourceSettingsState,
  write: writeAgentResourceSetting,
  reset: resetAgentResourceSettings,
});

function memorySettingsWire() {
  const state = readMemorySettingsState();
  return {
    ...state.value,
    isCustomized: state.isCustomized,
    customizedKeys: state.customizedKeys,
    defaults: state.defaults,
  };
}

// native memory 的运行时应用按 agent 拆开:Claude 的 setMemory 是纯内存覆盖
// (per-session spawn,不碰 Codex shared host),任何路径都立即应用;Codex 的
// setMemory 会 RPC 热更新 live host,busy 时延迟到会话空闲后(见
// applyMemoryChangeWithCodexRestart 的 persist / applyRuntime 拆分)。

/**
 * Memory 设置变更统一走这里:能立即软重启 Codex 就重启;本地 Codex 会话 busy
 * 时**不再 fail-closed 拒绝**(2026-07-23 实报:任务跑着时关记忆直接弹
 * CREDENTIAL_SWITCH_BUSY 裸错误)—— persist 部分照常落盘,live host 的 runtime
 * 热推与软重启登记到 DeferredCodexRestartService,全部空闲后自动补做;返回
 * codexRestartDeferred 供 UI 提示生效时机。非 busy 的 prepare 失败(并发凭证
 * 切换 / close 异常)包装成结构化 IPC error 上抛、不提交设置 —— 不把内部报错
 * 文本裸曝给 renderer(review P1 2026-07-23)。执行体见
 * runMemoryChangeWithCodexRestart。
 */
/**
 * Maker Memory 开关翻转后的 codex bridge 失效 (review R1 P2)。cindy_memory
 * provider 的 isEnabled 在 bridge 启动时冻结 (codexEnvironment doStart 快照
 * provider 集合), 不重建的话老 bridge 缺/多 cindy_memory server — 远端 CC
 * 会出现 prompt 注入了 memory rules 但工具面没有 server 的失配, codex 远端
 * 漂移判定永不收敛。与 contacts / 全局插件开关同机制:best-effort shutdown,
 * 下一次使用 lazy 重建出与新开关一致的 bridge;远端失效与重注入由
 * shutdownCodexEnvironment 的既有 hook 链自愈。调用方须放在 applyRuntime
 * (prepare 已停 app-server / 延迟路径全员空闲) 满足「先停 app-server 再关
 * bridge」的顺序约束, 并用翻转守卫包住 (同值调用不白杀 bridge)。失败只记
 * warn — 设置已落盘, 旧 bridge 的失配窗口由下一次 bridge 重建收敛。
 */
async function shutdownAgentMcpEnvironmentsBestEffort(reason: string): Promise<void> {
  // Codex 与 Pi 各有一个懒启动的 MCP bridge 单例,server 集合在 doStart 时冻结。MCP /
  // contacts / memory 开关变更后两者都要 invalidate,否则新会话仍连到旧 bridge:被禁用的
  // 工具没被真正撤销、新启用的工具不可用(Pi 侧 codex review P1)。best-effort:失败只 warn,
  // 下一次使用 lazy 重建出与新开关一致的 bridge。
  try {
    await shutdownCodexEnvironment();
  } catch (err) {
    log.warn(`shutdownCodexEnvironment on ${reason} failed — cached bridge still stale`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Pi 用 generation lease：活动会话继续使用旧桥，新会话立即重建到新配置。
  invalidatePiEnvironment();
}

async function applyMemoryChangeWithCodexRestart<T extends object>(
  parts: MemoryChangeParts<T>,
): Promise<T & { codexRestartDeferred: boolean }> {
  // 本次变更若覆盖了一个 pending 登记,被门挡住的会话队列必须在 clear 后补
  // 唤醒(门谓词变 false 不会自己触发 drain)。名单此刻采集 —— clear 发生在
  // prepare 关掉全部会话之后,那时已经采不到(review P1 2026-07-23)。
  const gatedSessionIds = deferredCodexRestartHolder?.listGatedSessionIds() ?? [];
  return runMemoryChangeWithCodexRestart(
    {
      prepare: async () => {
        try {
          await prepareCodexForAuthModeChange();
        } catch (err) {
          // busy 原样透传 —— 执行体靠它分流延迟路径;其余是真实故障,编码后上抛。
          if (isCredentialModeSwitchBusyError(err)) throw err;
          throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
        }
      },
      finalize: finalizeCodexAfterAuthModeChange,
      cancel: cancelCodexAuthModeChange,
      scheduleDeferredRestart: (reason, applyRuntime) => {
        deferredCodexRestartHolder?.schedule(reason, applyRuntime);
      },
      clearDeferredRestart: () => {
        deferredCodexRestartHolder?.clear();
        for (const sessionId of gatedSessionIds) {
          agentInputCoordinatorHolder?.wakeSession(sessionId, 'deferred-codex-restart-superseded');
        }
      },
      takePendingApplyRuntime: () => deferredCodexRestartHolder?.takePendingApplyRuntime() ?? null,
      logger: log,
    },
    parts,
  );
}

/**
 * 子代理 spawn 配置(`-c agents.*`)变更的统一执行体:复用 Memory 设置的
 * 「能立即软重启就重启,busy 就延迟到全部本地 Codex 会话空闲」链路。子代理配置
 * 自身没有 native 热推维度(唯一杠杆是重启后新 spawn 现读 store),applyRuntime
 * 有意缺省 —— 跨设置域接续由基础设施原子完成,不在这里快照(peek-then-schedule
 * 会被 prepare 的 await 窗口打断,盖掉窗口内 Memory 新登记的回调,review 第 2 轮):
 * busy 路径 service.schedule 对缺省回调做 preserve;立即路径执行体经
 * takePendingApplyRuntime 把排队工作原地补执行后再重启。
 * 调用方(bootstrap-electron 的 SET/RESET)负责先判定变更是否触及 spawn 注入键。
 */
export async function applyCodexSpawnConfigChangeWithRestart<T extends object>(
  persist: () => Promise<T>,
  stillValid?: () => boolean,
): Promise<T & { codexRestartDeferred: boolean }> {
  return applyMemoryChangeWithCodexRestart({
    persist,
    reason: 'subagent-spawn-config-change',
    stillValid,
  });
}

// ─── Sessions push helpers ────────────────────────────────────────────────
// maker-ipc 会话创建路径与 scheduler-host 共享此导出，统一广播
// `local-db:sessions:created`；renderer sessionsStore.onCreated 收到后
// forceRefreshAll 重拉所有桶。其它生命周期专属路径仍保留各自的同契约 helper。
export function broadcastSessionCreated(sessionId: string): void {
  tapWindowBroadcast('local-db:sessions:created', { sessionId });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send('local-db:sessions:created', { sessionId });
    } catch {
      // best-effort UI refresh, 失败不影响业务
    }
  }
}

/**
 * interrupted-turn-resume:turn 收尾打标的唯一实现点。统一规则:「ended 时间戳
 * 定格于逻辑收尾时刻,写入在 persist queue 排空之后」——
 *  - 定格:延后写期间用户若已启动新 turn,新 started 更晚,不被本写伪装成已结束
 *    (MAX 守卫兜回退)。
 *  - drain 后写:本 turn 已入队的持久化(assistant flush / orphan tool_result /
 *    error 行)durable 之前 ended 不落库;进程在此窗口退出时,重启仍满足
 *    startedAt > endedAt,由中断提示兜底,尾部输出 / 错误行不会静默丢失。
 *  - quit freeze 判定在调用时刻而非 drain 完成时刻(markSessionTurnEndedAfterBarrier
 *    内部保证):done 已到、drain 期间 ⌘Q 的已完成 turn 不会因 freeze 丢 ended
 *    而误报中断(review P2);shutdown close 触发的收尾在调用时刻已冻结,照样被挡。
 * done / terminal error / status idle 三条收尾路径都必须走这里,不要在任何
 * 收尾分支直接调 markSessionTurnEnded(时序类 review 反馈已三次命中此点,
 * 2026-07-06 收敛为单点)。
 */
function markTurnEndedAfterPersistDrain(sessionId: string): void {
  markSessionTurnEndedAfterBarrier(sessionId, drainPersistQueue());
}

// ─── Orca collab service holder ───────────────────────────────────────────
// 让其它 main 模块(典型: mcp-integrations/mcp-providers 的 cindy_helper
// control deps)能 deferred 拿到 Orca / handoff 业务函数引用。
//
// 时序: maker-host 在 app 启动早期就构造 mcp-providers (那时 holder 还是 null
// — 仅闭包捕获 holder 引用); 真正调用工具时 registerMakerIpc 早已执行完毕
// 给 holder 赋值, requireOrcaCollabService() 能拿到 ready 的 service。
type SendToSessionCreateDefaults = {
  agentKind: AgentKind;
  model: string;
  providerId?: string | null;
  effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  fastMode?: boolean;
  workingDir: string;
  workspaceKind?: 'project' | 'dialogue';
  permissionMode?: 'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
};

type SendToSessionInternalResult =  | {
      ok: true;
      /** 目标 session 的 business id。create 分支回传新建 id;jump 分支回显入参 id。 */
      targetSessionId: string;
      agentKind: AgentKind;
      /** created = 本次新建并投递;resumed = 既有 session 被唤醒;already-active = 已在线直送;queued = 目标繁忙时进入输入队列。 */
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** create + useWorktree 成功时为新 session 的 worktree 绝对路径;其余情况 undefined。 */
      worktreePath?: string | null;
    }
  | {
      ok: false;
      errorCode:
        | 'INVALID_ARGS'
        | 'NOT_FOUND'
        | 'ARCHIVED'
        | 'DELETED'
        | 'BUSY'
        | 'AGENT_NOT_READY'
        // create 分支专用:dispatcher 无 session 上下文时无法继承配置新建。
        | 'LEAD_NOT_SUPPORTED'
        // create + useWorktree 专用:workingDir 不是 git 仓库 / git 未装 / worktree 创建失败。
        // 显式要隔离却拿不到时硬报,不静默降级成共享工作树(调用方自行决定是否去掉参数重试)。
        | 'WORKTREE_UNAVAILABLE'
        | 'INTERNAL';
      message: string;
    };

/** 暴露给 xdt-helper MCP provider 的协同控制面，必须复用 IPC 同源业务路径。 */
interface OrcaCollabService {
  sendToSession: (
    params: {
      /** 省略 → create 新 session;提供 → jump 到该既有 session。 */
      targetSessionId?: string;
      message: string;
      /** 调用方(dispatcher)自身 session id,create 分支据此继承配置;未绑定 session ctx 时为 undefined。 */
      dispatcherSessionId?: string;
      /** create 分支可选标题;省略则用消息首行兜底。 */
      title?: string;
      /** create 分支可选:true = 为新 session 预建独立 git worktree 并以其为 workingDir(jump 忽略)。 */
      useWorktree?: boolean;
      /** create 分支可选:新 session 的工作目录覆盖(绝对路径,须已存在;jump 忽略)。#811 */
      workingDir?: string;
      /** Host-owned create defaults for non-session callers such as scheduler script tasks. */
      createDefaults?: SendToSessionCreateDefaults;
    },
  ) => Promise<SendToSessionInternalResult>;
  enableOrca: (
    leadSessionId: string,
    opts: EnableOrcaOptions,
  ) => Promise<{
    teamId: string;
    workerSessionId: string;
    workerId: string;
    dispatched: boolean;
    dispatchOutcome?: CollabDispatchOutcome;
  }>;
  disableOrca: (leadSessionId: string) => Promise<{ ok: true }>;
  /** start_team 只建立 team，不隐式创建 worker。 */
  startTeam: (params: { leadSessionId: string }) => Promise<
    { ok: true; teamId: string } | { ok: false; errorCode: string; message: string }
  >;
  createWorker: (params: {
    leadSessionId: string;
    role: string;
    agent: AgentKind;
    model?: string;
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    fast?: boolean;
    label: string;
    initialTask?: string;
  }) => Promise<
    {
      ok: true;
      workerId: string;
      workerSessionId: string;
      softLimitExceeded?: boolean;
      dispatched?: boolean;
      dispatchOutcome?: CollabDispatchOutcome;
    }
    | { ok: false; errorCode: string; message: string }
  >;
  createWorkerFromTask: (params: {
    leadSessionId: string;
    task: string;
    agentKind: AgentKind;
  }) => Promise<
    {
      ok: true;
      workerId: string;
      workerSessionId: string;
      label: string;
      softLimitExceeded?: boolean;
      dispatched?: boolean;
      dispatchOutcome?: CollabDispatchOutcome;
    }
    | { ok: false; errorCode: string; message: string }
  >;
  listWorkers: (params: { leadSessionId: string }) => Promise<
    { ok: true; workers: Array<{
      workerId: string;
      sessionId: string;
      role: string;
      agent: AgentKind;
      model: string;
      effort: string | null;
      label: string | null;
      status: string;
      focused: boolean;
      idleSince: string | null;
    }> }
    | { ok: false; errorCode: string; message: string }
  >;
  getWorkspaceInfo: (params: { leadSessionId: string }) => Promise<
    {
      ok: true;
      workflow: {
        workflow_id: string;
        lead_session_id: string;
        status: string;
      } | null;
      ui_capacity: number;
      worker_count: number;
      workers: Array<{
        worker_id: string;
        session_id: string;
        status: string;
        session_status: string;
        idle_ms: number | null;
        restored_from_storage: boolean;
        label: string | null;
        role: string;
        agent_kind: AgentKind;
        model: string;
        effort: string | null;
        focused: boolean;
        working_dir: string;
      }>;
    }
    | { ok: false; errorCode: string; message: string }
  >;
  getWorkerStatus: (params: { leadSessionId: string; workerId: string }) => Promise<
    {
      ok: true;
      worker_id: string;
      session_id: string;
      status: string;
      session_status: string;
      idle_ms: number | null;
      restored_from_storage: boolean;
    }
    | { ok: false; errorCode: string; message: string }
  >;
  readWorker: (params: { leadSessionId: string; workerId: string }) => Promise<
    {
      ok: true;
      worker_id: string;
      session_id: string;
      status: string;
      session_status: string;
      result: string;
    }
    | { ok: false; errorCode: string; message: string }
  >;
  switchFocus: (params: { leadSessionId: string; workerIdOrLabel: string }) => Promise<
    { ok: true; workerId: string }
    | { ok: false; errorCode: string; message: string }
  >;
  // sendToWorker 的语义跟 sendToSession 的 create 分支完全不同 — worker 派活
  // 永远投递到既有 worker session，绝不创建新 session。holder 只暴露 service
  // 边界的窄契约，避免 sendToSession 的 create 模式漏进 worker 派活语义。
  sendToWorker: (params: { callerLeadSessionId: string; targetSessionId: string; message: string }) => Promise<
    { ok: true; agentKind: AgentKind; wakeKind: 'resumed' | 'already-active' | 'queued'; targetTitle: string | null; targetLastUserSendAt: string | null; queuedMessageId?: string }
    | { ok: false; errorCode: string; message: string }
  >;
  // 排队消息控制:只作用于 lead 自己发出的 orca 排队条目,归属校验与 send/idle/archive 同一套 resolveWorkerRef。
  listWorkerQueuedMessages: (params: { callerLeadSessionId: string; workerRef: string }) => Promise<ListWorkerQueuedMessagesResult>;
  updateWorkerQueuedMessage: (params: { callerLeadSessionId: string; workerRef: string; queuedMessageId: string; message: string }) => Promise<WorkerQueuedMessageControlResult>;
  cancelWorkerQueuedMessage: (params: { callerLeadSessionId: string; workerRef: string; queuedMessageId: string }) => Promise<WorkerQueuedMessageControlResult>;
  idleWorker: (params: { callerLeadSessionId: string; workerId: string; expectedStatus?: 'done' }) => Promise<
    { ok: true; workerId?: string } | { ok: false; errorCode: string; message: string }
  >;
  endTeam: (params: { leadSessionId: string }) => Promise<
    { ok: true } | { ok: false; errorCode: string; message: string }
  >;
  archiveWorker: (params: { callerLeadSessionId: string; workerId: string }) => Promise<
    { ok: true; workerId?: string } | { ok: false; errorCode: string; message: string }
  >;
  listAvailableModels: (params: { agent?: AgentKind }) => Promise<
    { ok: true; codex?: Array<{ id: string; label: string }>; claude_code?: Array<{ id: string; label: string }>; pi?: Array<{ id: string; label: string }> }
    | { ok: false; errorCode: string; message: string }
  >;
}

interface EnableOrcaOptions {
  workerAgent: AgentKind;
  delegateTask?: string;
  role?: string;
  label?: string;
  model?: string;
  effort?: OrcaWorkerEffort;
  fast?: boolean;
  /** 显式选定的模型来源;语义见 OrcaWorkerCreateParams.providerId。 */
  providerId?: string | null;
}

let orcaCollabServiceHolder: OrcaCollabService | null = null;
// session event wiring 是模块级函数；service 在 registerMakerIpc 内构造后注入给事件回调。
let orcaTeamServiceForEvents: OrcaTeamService | null = null;

function markWorkerManualInterruptIfKnown(sessionId: string, reason: 'input_stop' | 'abort_session'): boolean {
  if (!isKnownOrcaWorkerSession(sessionId)) return false;
  markManualInterrupt(sessionId, reason);
  return true;
}

export type {
  DispatchOrcaInterAgentMessageParams,
  DispatchOrcaInterAgentMessageResult,
  OrcaInterAgentMessageSource,
};

type DispatchOrcaInterAgentMessage = (params: DispatchOrcaInterAgentMessageParams) => Promise<DispatchOrcaInterAgentMessageResult>;

let dispatchInterAgentMessageHolder: DispatchOrcaInterAgentMessage | null = null;

export async function dispatchInterAgentMessage(params: DispatchOrcaInterAgentMessageParams): Promise<DispatchOrcaInterAgentMessageResult> {
  const dispatch = dispatchInterAgentMessageHolder;
  if (!dispatch) {
    return {
      ok: false,
      dispatchOutcome: {
        ...createHostSendFailure('SEND_FAILED', 'orca inter-agent dispatch service not initialized'),
        source: params.meta.source,
        context: params.meta.context,
      },
    };
  }
  return dispatch(params);
}

/** 模块级 idle watcher；停止后不再持有可能已经失效的 maker 引用。 */
let idleReleaseWatcher: OrcaIdleReleaseWatcher | null = null;

/**
 * 取 Orca collab service, ready 前返 null。registerMakerIpc 执行完成后 holder
 * 被赋值, 之前调本函数会拿到 null —— 调用方 (典型: mcp-providers.ts 的 control
 * 回调) 应当把 null 翻译成业务错误码 (如 HOST_NOT_READY) 返给 LLM, 而不是抛
 * raw Error 让 LLM 看到一串 internal message。
 *
 * 之所以保留 null 而非抛错: LLM 通常在 session 已创建后才调工具, 那时 holder
 * 早已 ready; 但万一 wiring 改了 / 启动顺序变了, null 的边沿能在 mcp-providers
 * 那层精确翻译, 比抛 Error 友好。
 */
export function tryGetOrcaCollabService(): OrcaCollabService | null {
  return orcaCollabServiceHolder;
}

function createBridgeWorkerLabel(task: string): string {
  const suffix = createId().slice(0, 6).toLowerCase();
  const base = task
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const maxBaseLength = 32 - suffix.length - 1;
  const prefix = base.slice(0, maxBaseLength).replace(/-+$/g, '') || 'worker';
  const label = `${prefix}-${suffix}`;
  const normalized = normalizeOrcaWorkerLabel(label);
  return normalized.ok ? normalized.value : `worker-${suffix}`;
}

/** 停止 idle watcher setInterval (app quit 时调, maker 可能已 shutdown)。 */
export function stopOrcaIdleWatcher(): void {
  idleReleaseWatcher?.stop();
  idleReleaseWatcher = null;
}

function requireAgentKind(value: unknown): AgentKind {
  if (value === 'claude-code' || value === 'codex' || value === 'pi') return value;
  throwIpcError('INVALID_PARAMS', 'agentKind required');
}

type IpcUserMessage =
  | string
  | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

async function prepareUserMessageForAgent(
  sessionId: string,
  message: unknown,
  logPrefix: 'send' | 'steer',
): Promise<IpcUserMessage> {
  const msg = message as IpcUserMessage;
  // 归一化 image/file 块到真实 fs path (xdt-image:// 反查、F6 base64 落临时文件、
  // clipboard:// 占位丢弃), 让 maker-core 收到的 path 一律可 fs.readFile。
  //
  // send 与 steer 必须共用这一层：插话是投递模式，不是缩水版内容类型。
  // 过去队列 bug 的根源就是 busy/idle 两条路径各自拼消息，导致附件、mention、
  // 持久化内容不同步；这里把 main 边界也收敛成同一个 helper。
  const normalized = await normalizeUserMessage(sessionId, msg);
  const sentImageUrls = imageCacheStore.collectSessionImageUrls(msg);
  if (sentImageUrls.length > 0) {
    const mark = await imageCacheStore.markFilesCommitted(sentImageUrls);
    if (mark.errors > 0) {
      log.warn(`${logPrefix}: mark image cache committed had errors`, {
        sessionId,
        imageCount: sentImageUrls.length,
        marked: mark.marked,
        skipped: mark.skipped,
        errors: mark.errors,
      });
    }
  }
  // 媒体总仓晋升:消息里的 cindy-media blob 挂 session-attachment 引用(草稿
  // 转正,替代 markFilesCommitted;幂等,重发不刷重复行)。失败只警告——
  // 引用缺失的代价是 blob 提前进回收候选,不该阻塞消息发送。
  const sentBlobUrls = collectCindyMediaUrls(msg);
  if (sentBlobUrls.length > 0) {
    try {
      await commitChatImageUrls({ sessionId, urls: sentBlobUrls });
    } catch (err) {
      log.warn(`${logPrefix}: commit cindy-media attachment refs failed`, {
        sessionId,
        blobCount: sentBlobUrls.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return normalized as IpcUserMessage;
}

function summarizeIpcUserMessage(message: IpcUserMessage): Record<string, unknown> {
  if (typeof message === 'string') {
    return { contentType: 'string', textLen: message.length };
  }
  const content = message.content;
  if (typeof content === 'string') {
    return { contentType: 'string', textLen: content.length };
  }
  let textLen = 0;
  let imageCount = 0;
  let fileCount = 0;
  let mentionCount = 0;
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') textLen += block.text.length;
    else if (block.type === 'image') imageCount += 1;
    else if (block.type === 'file') fileCount += 1;
    else if (block.type === 'mention') mentionCount += 1;
  }
  return {
    contentType: 'blocks',
    blockCount: content.length,
    textLen,
    imageCount,
    fileCount,
    mentionCount,
  };
}

interface CodexImageEventData {
  kind?: 'view' | 'generation';
  blockId?: string;
  path?: string;
  url?: string;
  revisedPrompt?: string;
  status?: string;
}

/**
 * 待解决的 interaction 请求(permission/ask/plan 三合一)—— 用 promise 跨 IPC 边界。
 * key: requestId, value: resolver + owning session. ask/plan intentionally do
 * not use a timeout because they represent explicit product decisions, not a
 * transient permission prompt.
 */
const PERMISSION_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingInteractionEntry {
  sessionId: string;
  kind: InteractionRequest['kind'];
  resolve: (decision: InteractionDecision) => void;
  /**
   * 原始 InteractionRequest —— 留着是为了 feishu 接管时能"重发"卡片到飞书,
   * 以及 GET_PENDING_INTERACTIONS 快照重建(新窗口/重连/刷新打开会话时重建面板)。
   */
  request: InteractionRequest;
  /**
   * ask_user / plan_review 落库消息的 persistId(permission 无)。快照重建时回传给
   * renderer,让重建出的 pending 复用同一条消息(按 requestId 去重,不产生重复气泡)。
   */
  persistId?: string;
  timeoutId?: ReturnType<typeof setTimeout>;
}

const pendingInteractionResolvers = new Map<string, PendingInteractionEntry>();

/**
 * submit_github_issue 工具的提交前确认桥(kind='issue_confirm')。独立于
 * pendingInteractionResolvers —— 那套 map 只服务 agent 发起的 InteractionRequest
 * 闭合 union,且 feishu /ctr 接管会整体搬走;issue 确认卡只在 desktop 出现,
 * 超时/会话清理由桥自己兜底。复用同一对 INTERACTION_REQUEST / RESOLVE_INTERACTION
 * channel,renderer 按 kind 分发。
 */
// 桌面专属确认卡的 IM 侧提示(#926):卡片仍只在桌面出现(设计边界不动),
// 但飞书绑定会话的用户会即时收到「去桌面确认」的文字提示,不再默等到超时。
const desktopConfirmImNotifier = createFeishuDesktopConfirmNotifier();

const issueConfirmBridge = new IssueConfirmBridge({
  broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
  logger: log,
  onDesktopOnlyConfirmPending: (sessionId) =>
    desktopConfirmImNotifier(sessionId, '「提交 GitHub issue」的确认卡'),
});

const renameSessionsConfirmBridge = new RenameSessionsConfirmBridge({
  broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
  logger: log,
  onDesktopOnlyConfirmPending: (sessionId) =>
    desktopConfirmImNotifier(sessionId, '「批量重命名任务」的确认卡'),
});

/**
 * ghost_call 过户 workdir 外文件的确认桥(kind='ghost_grant_confirm')。
 * 单例挂在 cindy-brain 模块里(ghost.ts 经 getGhostGrantConfirmBridge 消费),
 * 这里只负责注入 broadcast;pending 语义与 issue 确认卡一致。
 */
const ghostGrantConfirmBridge = initGhostGrantConfirmBridge({
  broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
  logger: log,
  onDesktopOnlyConfirmPending: (sessionId) =>
    desktopConfirmImNotifier(sessionId, '「插件文件授权」的确认卡'),
});

const ghostSetupInteractionBridge = initGhostSetupInteractionBridge({
  broadcast: (channel, payload) => {
    broadcastToAllWindows(channel, payload);
    const value = payload as {
      sessionId?: unknown;
      requestId?: unknown;
      request?: GhostSetupInteractionSnapshot;
    };
    if (typeof value.sessionId !== 'string') return;
    if (channel === MAKER_PUSH.INTERACTION_REQUEST && value.request?.kind === 'plugin_setup') {
      if (!shouldNotifyAgentIslandForSession(value.sessionId)) return;
      if (value.request.terminal === true) {
        // The Renderer keeps the terminal snapshot for its short visual
        // grace, while Agent Island must stop treating it as attention now.
        getAgentIslandService()?.handleInteractionDismissed(
          value.sessionId,
          value.request.requestId,
        );
        return;
      }
      const activeStep = value.request.steps.find(
        (step) => step.phase !== 'satisfied' && step.phase !== 'cancelled',
      );
      getAgentIslandService()?.handlePluginSetupInteraction(
        value.sessionId,
        value.request.requestId,
        activeStep?.title ?? t('newChat.pluginSetup.title').replace('{{name}}', value.request.ghost.name),
      );
      return;
    }
    if (
      channel === MAKER_PUSH.INTERACTION_DISMISSED &&
      typeof value.requestId === 'string'
    ) {
      getAgentIslandService()?.handleInteractionDismissed(
        value.sessionId,
        value.requestId,
      );
    }
  },
  logger: log,
});

initGhostSetupCoordinator({
  changeBus: getGhostSetupChangeBus(),
  bridge: ghostSetupInteractionBridge,
  assess: (ghostId) => getGhostSetupAssessment(ghostId),
  validateTarget: (ghostId, tool, workingDir) => {
    const ghost = getGhostManager()
      .list()
      .find((candidate) => candidate.manifest.id === ghostId);
    if (!ghost || !isGhostAvailableForActiveSession(ghostId)) {
      return {
        ok: false,
        errorCode: 'GHOST_NOT_FOUND',
        message: t('newChat.pluginSetup.targetNotFound'),
      };
    }
    if (!ghost.enabled) {
      return {
        ok: false,
        errorCode: 'GHOST_ASLEEP',
        message: t('newChat.pluginSetup.targetDisabled'),
      };
    }
    if (isGhostDisabledForWorkdir(ghostId, workingDir)) {
      return {
        ok: false,
        errorCode: 'GHOST_DISABLED_IN_WORKDIR',
        message: t('newChat.pluginSetup.targetDisabledInWorkdir'),
      };
    }
    if (tool && !(ghost.manifest.tools ?? []).some((candidate) => candidate.name === tool)) {
      return {
        ok: false,
        errorCode: 'TOOL_NOT_FOUND',
        message: toolNotFoundMessage(ghostId, tool, ghost.manifest.tools),
      };
    }
    return { ok: true };
  },
  getGhostIdentity: (ghostId) => {
    const ghost = getGhostManager().list().find((candidate) => candidate.manifest.id === ghostId);
    return ghost
      ? {
          id: ghostId,
          name: ghost.manifest.name,
          ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
        }
      : null;
  },
  executeAction: ({ sessionId, ghostId, action, responseTarget }) =>
    executeGhostSetupAction({
      sessionId,
      ghostId,
      action,
      ...(responseTarget ? { responseTarget } : {}),
    }),
  executeInlineAction: ({ sessionId, ghostId, action, value }) =>
    executeGhostSetupInlineAction({ sessionId, ghostId, action, value }),
  timeoutMessage: () => t('newChat.pluginSetup.timeout'),
  logger: log,
});

function clearPendingInteraction(requestId: string): PendingInteractionEntry | null {
  const entry = pendingInteractionResolvers.get(requestId);
  if (!entry) return null;
  pendingInteractionResolvers.delete(requestId);
  if (entry.timeoutId) clearTimeout(entry.timeoutId);
  return entry;
}

type RecoverableInteractionSnapshot =
  | InteractionRequest
  | GhostSetupInteractionSnapshot
  | IssueConfirmInteractionSnapshot
  | RenameSessionsConfirmInteractionSnapshot
  | GhostGrantConfirmInteractionSnapshot;

type PendingInteractionSnapshotEntry = {
  request: RecoverableInteractionSnapshot;
  persistId?: string;
};

/**
 * 快照:某会话当前所有挂起的 agent interaction 与 Host-owned 确认卡。
 * 供 renderer 在「打开 / 重连 / 刷新」会话时重建可操作面板 —— pending 状态原本只由实时
 * INTERACTION_REQUEST push 设置,后加入的窗口会错过那条 push,靠这个查询补回。
 * 纯内存读;O(N) 其中 N = 全局挂起交互数(极小)。
 */
function getPendingInteractionsForSession(
  sessionId: string,
): PendingInteractionSnapshotEntry[] {
  const out: PendingInteractionSnapshotEntry[] = [];
  for (const entry of pendingInteractionResolvers.values()) {
    if (entry.sessionId === sessionId) out.push({ request: entry.request, persistId: entry.persistId });
  }
  out.push(
    ...issueConfirmBridge.pendingSnapshots(sessionId).map(({ request }) => ({ request })),
    ...renameSessionsConfirmBridge
      .pendingSnapshots(sessionId)
      .map(({ request }) => ({ request })),
    ...ghostGrantConfirmBridge
      .pendingSnapshots(sessionId)
      .map(({ request }) => ({ request })),
    ...ghostSetupInteractionBridge
      .pendingSnapshots(sessionId)
      .map(({ request }) => ({ request })),
  );
  return out;
}

/**
 * Agent-owned interactions are queue/zombie boundaries. Desktop-only confirms
 * are Host tool waiters: they are recoverable UI state, but must not block a
 * later user turn or be cleared by turn-idle reconciliation.
 */
function hasPendingAgentInteractionForSession(sessionId: string): boolean {
  return (
    Array.from(pendingInteractionResolvers.values()).some((entry) => entry.sessionId === sessionId) ||
    ghostSetupInteractionBridge.pendingSnapshots(sessionId).length > 0
  );
}

function isPendingDesktopOnlyConfirmation(requestId: string): boolean {
  return (
    issueConfirmBridge
      .pendingSnapshots()
      .some(({ request }) => request.requestId === requestId) ||
    renameSessionsConfirmBridge
      .pendingSnapshots()
      .some(({ request }) => request.requestId === requestId) ||
    ghostGrantConfirmBridge
      .pendingSnapshots()
      .some(({ request }) => request.requestId === requestId)
  );
}

function dismissRendererInteraction(
  entry: PendingInteractionEntry,
  requestId: string,
  reason: string,
  resolvedAs: 'allow' | 'deny',
  decision?: unknown,
): void {
  // reason==='resolved'(被某一端答了)时,把 ask/plan 的决策内容(answers / behavior+reason)一并广播,
  // 让没发起回答的那些端(被控端自己 + 其它控制端)live 渲染出与答题端一致的「已回答」卡片,而不是
  // 只能标 expired(过去只带 requestId,对端无从知道选了什么)。其它 reason(timeout / mode_changed /
  // session_closed 等真·放弃)不带 decision,仍走原 expired 语义。permission 无 chat 卡片,也不带。
  const carryDecision =
    reason === 'resolved' && (entry.kind === 'ask_user_question' || entry.kind === 'plan_review');
  broadcastToAllWindows(MAKER_PUSH.INTERACTION_DISMISSED, {
    sessionId: entry.sessionId,
    requestId,
    reason,
    resolvedAs,
    ...(carryDecision ? { decision } : {}),
  });
}

function resolvePendingInteraction(requestId: string, decision: InteractionDecision): boolean {
  const resolver = pendingInteractionResolvers.get(requestId);
  if (!resolver) return false;
  clearPendingInteraction(requestId);
  handleAgentIslandInteractionDismissed(resolver.sessionId, requestId);
  resolver.resolve(decision);
  // 广播「已解决」让**所有其它 renderer**(被控端自己的窗口 + 其它控制端 + 多窗口)收敛清面板。
  // 多端镜像下同一交互面板可能同时开在多处,只有发起方乐观本地清了 —— 不广播则其它方卡住。
  const resolvedAs = decision.kind === 'permission' && decision.behavior === 'allow' ? 'allow' : 'deny';
  dismissRendererInteraction(resolver, requestId, 'resolved', resolvedAs, decision);
  // 交互曾是队列 drain 的 busy 门(hasPendingInteraction)。只在「不会带外启动
  // 后续 turn」的 resolve 上唤醒:plan_review 的批准/反馈会由 agent 带外自动发起
  // 实施/修订 turn(runPlanReviewFlow),resolve 瞬间该 turn 尚未 registered、
  // isTurnRunning 仍为假,此时唤醒会让排队消息抢跑相撞(bot review P2)——它们的
  // 后续 turn 完成时自有 done wake。判定分支必须与 codex runPlanReviewFlow 的
  // 「dismissed || 无反馈 → 不发 turn」保持镜像;claude 的取消发生在 turn 内,
  // 此处唤醒撞上 isTurnRunning 门为 no-op,turn 结束由 done wake 兜底。
  const plannedNoFollowUpTurn =
    resolver.kind === 'plan_review' &&
    decision.kind === 'plan_review' &&
    decision.behavior === 'deny' &&
    (decision.dismissed === true ||
      !(typeof decision.reason === 'string' && decision.reason.trim().length > 0));
  if (plannedNoFollowUpTurn) {
    agentInputCoordinatorHolder?.onInteractionResolved(resolver.sessionId);
  }
  // 被控端权威落库 ask/plan 的 answered/approved/revised 状态(含答案/编辑后 plan/feedback)。
  if (resolver.kind === 'ask_user_question' || resolver.kind === 'plan_review') {
    onInteractionResolved(
      resolver.sessionId,
      resolver.persistId,
      resolver.kind,
      resolver.request as { requestId?: unknown; questions?: unknown; plan?: unknown; planFilePath?: unknown },
      (decision ?? {}) as Record<string, unknown>,
    );
  }
  // (Option B)ask_user_question 答完 → 即时改写该会话的 goal 目标(仅首轮澄清,controller 内 guard)。
  // 连同本次问题(含选项)一并交出,让 controller 用确定性标记甄别这是不是"目标澄清问题"。
  if (resolver.kind === 'ask_user_question' && decision.kind === 'ask_user_question' && goalAskAnswerObserver) {
    try {
      const questions = (resolver.request as { questions?: AskUserQuestions }).questions ?? [];
      goalAskAnswerObserver(resolver.sessionId, decision.answers ?? {}, questions);
    } catch (e) {
      log.warn('goalAskAnswerObserver threw', { sessionId: resolver.sessionId, error: String(e) });
    }
  }
  return true;
}

function resolvePendingPermissionFromAgentIsland(
  requestId: string,
  decision: Extract<InteractionDecision, { kind: 'permission' }>,
): boolean {
  const resolver = pendingInteractionResolvers.get(requestId);
  if (resolver?.kind !== 'permission') return false;
  return resolvePendingInteraction(requestId, decision);
}

function isPermissionInteractionDecision(value: unknown): value is Extract<InteractionDecision, { kind: 'permission' }> {
  return Boolean(value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'permission');
}

function defaultDecisionForPending(kind: InteractionRequest['kind'], reason: string): InteractionDecision {
  if (kind === 'ask_user_question') {
    return { kind: 'ask_user_question', answers: {} };
  }
  if (kind === 'plan_review') {
    // dismissed: 系统性 deny(session_closed / session_aborted / 超时清理等),
    // reason 是系统代码 —— Codex plan 修订循环据此不把它当用户反馈发修订 turn。
    return { kind: 'plan_review', behavior: 'deny', reason, dismissed: true };
  }
  return { kind, behavior: 'deny', reason } as InteractionDecision;
}

function cleanupPendingAgentInteractionsForSession(sessionId: string, reason: string): void {
  const entries = Array.from(pendingInteractionResolvers.entries())
    .filter(([, entry]) => entry.sessionId === sessionId);
  for (const [requestId, entry] of entries) {
    clearPendingInteraction(requestId);
    handleAgentIslandInteractionDismissed(sessionId, requestId);
    entry.resolve(defaultDecisionForPending(entry.kind, reason));
    dismissRendererInteraction(entry, requestId, reason, 'deny');
  }
  ghostSetupInteractionBridge.cleanupForSession(
    sessionId,
    reason === 'session_closed' ? 'session_closed' : 'session_aborted',
  );
}

function cleanupPendingInteractionsForSession(sessionId: string, reason: string): void {
  cleanupPendingAgentInteractionsForSession(sessionId, reason);
  // Desktop-only 确认只跟随真实会话终止/中止清理。权威 NO_ACTIVE_TURN 的
  // turn-idle reconcile 只处理 Agent-owned 僵尸，不能取消仍有效的 Host 工具等待。
  issueConfirmBridge.cleanupForSession(
    sessionId,
    reason === 'session_closed' ? 'session_closed' : 'session_aborted',
  );
  renameSessionsConfirmBridge.cleanupForSession(
    sessionId,
    reason === 'session_closed' ? 'session_closed' : 'session_aborted',
  );
  ghostGrantConfirmBridge.cleanupForSession(
    sessionId,
    reason === 'session_closed' ? 'session_closed' : 'session_aborted',
  );
  // fs 槽 workdir 写确认的会话级记忆只在会话真正关闭时清(防 Set 无界增长)。
  // 本函数在 session_aborted(用户点停止)等瞬态也会被调,那些场景确认卡该收、
  // 但"同目录本会话免弹"的记忆要保住——否则用户每
  // 次 Stop 后同目录又要重新点一遍允许,与卡片文案承诺不符(review P2)。
  if (reason === 'session_closed') {
    getGhostFsSlot().cleanupForSession(sessionId);
  }
}

/**
 * 取走该 session 当前所有 pending interaction 的 request + resolve fn,
 * **不 resolve** —— caller (feishu 接管路径) 拿去把卡片重发到飞书,等用户在
 * 飞书答复时再调 resolve。
 *
 * 同时 broadcast INTERACTION_DISMISSED 让 desktop renderer 清掉对话框 UI
 * (resolvedAs 字段省略 —— renderer 默认按 'deny' 处理, 但我们用 reason
 * 'migrated_to_feishu' 让 caller 能区分日志, 实际 UI 只是关掉对话框)。
 *
 * 给 feishu /ctr 接管 in-turn session 用 —— attached=true 路径里 setInteractionListener
 * 覆盖之前调一次, 把 desktop 卡片"原地搬到飞书"。
 */
export function takePendingInteractionsForSession(
  sessionId: string,
): Array<{ requestId: string; request: InteractionRequest; resolve: (decision: InteractionDecision) => void }> {
  const entries = Array.from(pendingInteractionResolvers.entries())
    .filter(([, entry]) => entry.sessionId === sessionId);
  const taken: Array<{ requestId: string; request: InteractionRequest; resolve: (decision: InteractionDecision) => void }> = [];
  for (const [requestId, entry] of entries) {
    clearPendingInteraction(requestId);
    taken.push({ requestId, request: entry.request, resolve: entry.resolve });
    handleAgentIslandInteractionDismissed(entry.sessionId, requestId);
    // resolvedAs 省略 — renderer 行 1537 默认 'deny', UI 上只是关掉对话框,
    // 跟我们这里"搬走"语义一致(没真选 allow/deny)。
    broadcastToAllWindows(MAKER_PUSH.INTERACTION_DISMISSED, {
      sessionId: entry.sessionId,
      requestId,
      reason: 'migrated_to_feishu',
    });
  }
  return taken;
}

type WiredSession = NonNullable<ReturnType<Maker['getSession']>>;

interface WiredSessionRegistration {
  session: WiredSession;
  disposers: Array<() => void>;
}

/**
 * 记录已经 wire 过 IPC 转发的 session 实例，避免 lazy-create 路径或多个调用方
 * (renderer IPC handler / scheduler runner / feishu 接管 / future MCP server) 重复挂 listener。
 *
 * deferred agent switch 会保留业务 id 但替换 Session 实例；此时必须解绑旧实例并完整
 * wire 新实例，不能只按 id 去重。
 */
const wiredSessionsById = new Map<string, WiredSessionRegistration>();

/**
 * Monotonic logical-turn generation used by direct abort reconciliation.
 * Session ids survive owner-boundary replacement, so the Session object alone
 * is not enough to reject a late retry for a newer turn on the same instance.
 */
const sessionTurnBoundaryGenerationById = new Map<string, number>();

interface DirectAbortReconcileBoundary {
  session: WiredSession;
  generation: number;
  turnId: string | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
}

/** One direct ABORT_SESSION retry chain per session; a newer abort supersedes the old one. */
const directAbortReconcileBoundaries = new Map<string, DirectAbortReconcileBoundary>();
const DIRECT_ABORT_RECONCILE_RETRY_DELAY_MS = 250;

function currentSessionTurnBoundaryGeneration(sessionId: string): number {
  return sessionTurnBoundaryGenerationById.get(sessionId) ?? 0;
}

function advanceSessionTurnBoundaryGeneration(sessionId: string): number {
  const next = currentSessionTurnBoundaryGeneration(sessionId) + 1;
  sessionTurnBoundaryGenerationById.set(sessionId, next);
  return next;
}

function cancelDirectAbortReconciliation(
  sessionId: string,
  expected?: DirectAbortReconcileBoundary,
): void {
  const boundary = directAbortReconcileBoundaries.get(sessionId);
  if (!boundary || (expected && boundary !== expected)) return;
  if (boundary.retryTimer) clearTimeout(boundary.retryTimer);
  boundary.retryTimer = null;
  directAbortReconcileBoundaries.delete(sessionId);
}

/**
 * SDK result 事件的 total_cost_usd 是 session 累计 (不是 per-turn) ——
 * 老 vendor/claude/usageExtractor.ts:72-74 也确认过。要算"这一 turn 花了多少"
 * 就要拿这次累计减上次累计。这里 per-session 记一下上次报上来的累计值。
 * close-session 时清掉, 避免长跑下来 leak。
 */
const lastReportedCostUsdBySession = new Map<string, number>();

/**
 * Claude done 事件 modelUsage 的 per-session 累计快照 (与 lastReportedCostUsdBySession
 * 同语义 — SDK 报的是子进程内累计, 写 daily_model_usage 前要 delta 化)。
 * close-session 时清掉。
 */
const lastReportedModelUsageBySession = new Map<string, Map<string, ModelUsageCumulative>>();

/**
 * Codex done 事件不带 model id。done 时读取 sessions.model 会被用户中途切模型污染,
 * 所以正常路径在 turn start(status:isRunning true) 时立刻点查并缓存本轮 promise;
 * 这里只作为缺失 start 事件时的兜底。
 */
async function readSessionModelForUsage(sessionId: string): Promise<string> {
  try {
    const row = await getDbClient()
      .drizzle.select({ model: sessions.model })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return row?.model || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 本轮实际模型快照。key=sessionId, value=turn start 时启动的 model 读取 promise。
 * 只在第一次 isRunning:true 时写入,避免后续 progress status 在用户切模型后覆盖本轮归因。
 */
const turnModelPromiseBySession = new Map<string, Promise<string>>();
/**
 * claude/codex 失败 turn 的记账交接: is_error 收尾时 terminal error 事件先到,
 * 边界块在 error 上就 consume 掉本轮 assistant persistId;配对的 done 稍后才进
 * usage 分支 —— 不交接的话 per-message 花费/用量明细在失败 turn 上丢失
 * (日/会话总额不受影响,PR #485 review)。turn start 清残留,防错配到下一轮。
 */
const pendingFailedTurnAssistantPersistId = new Map<string, string>();

/**
 * 跟踪每个 session 的逻辑 turn 与后台节流 keepalive。外部 running guard
 * 通过 isSessionInTurn 查询真实 busy；mainWindow 后台节流订阅 keepalive 聚合状态。
 *
 * 来源:
 *   - status event 带 isRunning:true → set true
 *   - status event 带 isRunning:false (turn done) → event broadcast 后立即结束逻辑 turn，
 *     同时保留短 keepalive grace 给 renderer 收尾
 *   - done event → 同上，兜底 status 漏发
 *   - 终止型 error event → 同上，兜底终止型 error 漏发 status/done
 *   - close-session → delete
 *
 * 可重试 error event 不清 idle：Codex retry-loop 会先把可重试 auth error 暴露给 UI，
 * daemon 仍可能在 retry；只有 isTerminalTurnErrorEvent(event) 为 true 才结束 turn。
 *
 * 注意: isSessionInTurn 是 turn-level (单轮 SDK 调用) 语义，不同于
 * Session.getStatus() 的 lifecycle (active/closed)，也不同于 terminal 后短暂保留的
 * background-throttling keepalive。
 */
const sendToSessionLocks = new Map<string, Promise<unknown>>();

/**
 * Acquire the per-session send/route lock until the returned release callback runs.
 *
 * Direct-send callers need this lease form because applying a deferred agent switch,
 * refreshing the resulting live Session, and calling Session.send happen in different
 * modules but must remain one atomic route decision.
 */
async function acquireSendToSessionLock(sessionId: string): Promise<() => void> {
  const previous = sendToSessionLocks.get(sessionId);
  const waitPrevious = previous ? previous.catch(() => undefined) : Promise.resolve();
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const run = waitPrevious.then(() => gate);
  const tracked = run.finally(() => {
    if (sendToSessionLocks.get(sessionId) === tracked) {
      sendToSessionLocks.delete(sessionId);
    }
  });
  sendToSessionLocks.set(sessionId, tracked);
  await waitPrevious;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseGate();
  };
}

/** Serialize every local send / runtime release / route mutation for one session. */
export async function withSendToSessionLock<T>(
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const release = await acquireSendToSessionLock(sessionId);
  try {
    return await task();
  } finally {
    release();
  }
}

let agentInputCoordinatorHolder: AgentInputCoordinator | null = null;
const rewindInputSessions = new Set<string>();
const SESSION_REWIND_INPUT_LOCK_ID = 'session-rewind';
const SESSION_REWIND_STOP_TIMEOUT_MS = 15_000;
let pendingCredentialSwitchHolder: PendingCredentialSwitchService | null = null;
function settlePendingCredentialSwitch(sessionId: string, source: string): void {
  const pending = pendingCredentialSwitchHolder?.onTurnSettled(sessionId);
  if (!pending) return;
  void pending.catch((err) => {
    log.warn('pending credential switch settle failed', {
      sessionId,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
// turn 收口时对远端 codex MCP 做一次 best-effort ensure 的钩子 (live turn
// 期间被推迟的 daemon bootstrap 在 idle 时点补刀)。真实现定义在
// registerMakerIpcs 闭包内 (依赖 maker / ensure 函数), 模块级 turn 收口
// 路径经 holder 调用; 未注入时 no-op。
let refreshRemoteCodexMcpOnTurnSettledHolder: ((sessionId: string) => void) | null = null;
let deferredCodexRestartHolder: DeferredCodexRestartService | null = null;
let pendingAgentSwitchApplyHolder:
  ((sessionId: string, signal?: AbortSignal) => Promise<() => void>) | null = null;
let cancelPendingAgentSwitchHolder: ((sessionId: string) => void) | null = null;
let gitSnapshotCoordinator: GitSnapshotCoordinator | null = null;
const sessionTurnActivityTracker = new SessionTurnActivityTracker();

/**
 * Own the session input boundary while rewind stops an active turn and changes
 * history. Queued messages survive the operation but stay paused afterwards.
 */
export async function withSessionInputStoppedForRewind<T>(
  sessionId: string,
  action: () => Promise<T>,
): Promise<T> {
  const coordinator = agentInputCoordinatorHolder;
  let releaseInputLockOnExit = true;
  if (!coordinator) {
    throwIpcError('INTERNAL', 'Agent input coordinator is not initialized');
  }
  if (rewindInputSessions.has(sessionId)) {
    throwIpcError('SESSION_RUNNING', 'A rewind is already in progress for this session');
  }

  rewindInputSessions.add(sessionId);
  try {
    await coordinator.ensureQueueRestored(sessionId).catch(() => undefined);
    if (!coordinator.isQueueRestored(sessionId)) {
      throwIpcError('INTERNAL', 'Failed to restore queued input before rewind');
    }

    coordinator.setInteractionLock(sessionId, SESSION_REWIND_INPUT_LOCK_ID, true, {
      preserveOnStop: true,
    });
    if (coordinator.hasActiveTurnForRewind(sessionId)) {
      // Pause /goal before abort so the terminal event cannot auto-resume it.
      await goalStopObserver?.(sessionId);
      coordinator.stop(sessionId, { keepQueue: true, pauseQueue: true });
    } else {
      coordinator.pausePendingQueueForRewind(sessionId);
    }

    const stopped = await coordinator.waitForRewindBoundaryIdle(
      sessionId,
      SESSION_REWIND_STOP_TIMEOUT_MS,
    );
    if (!stopped) {
      // The old turn / interaction is still authoritative. Keep both the input
      // lock and duplicate-rewind guard after returning the timeout error, then
      // release them automatically once the real terminal boundary arrives.
      releaseInputLockOnExit = false;
      void coordinator
        .releaseRewindLockWhenIdle(sessionId, SESSION_REWIND_INPUT_LOCK_ID)
        .then(() => rewindInputSessions.delete(sessionId))
        .catch((err) => {
          log.error('failed to release retained rewind input lock', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      throwIpcError('SESSION_RUNNING', 'Timed out waiting for the session to stop before rewind');
    }

    return await action();
  } finally {
    coordinator.pausePendingQueueForRewind(sessionId);
    if (releaseInputLockOnExit) {
      coordinator.setInteractionLock(sessionId, SESSION_REWIND_INPUT_LOCK_ID, false);
      rewindInputSessions.delete(sessionId);
    }
  }
}

/**
 * 媒体回收器活引用取证入口(recycler.ts 的内存队列暂存区):内存排队/在途
 * 消息的序列化文本。coordinator 未就绪(启动早期)返回空——此时也不存在
 * 内存队列,空集合语义正确。
 */
export function collectAgentInputQueueScanTexts(): string[] {
  return agentInputCoordinatorHolder?.collectQueuedPayloadTexts() ?? [];
}

export interface AutomationUserTurnGitBaselineHooks {
  beforeDispatchUserTurn(sessionId: string): void | Promise<void>;
  onUndispatchedUserTurn(sessionId: string): void;
}

export function createAutomationUserTurnGitBaselineHooks(): AutomationUserTurnGitBaselineHooks {
  return {
    beforeDispatchUserTurn: (sessionId) => gitSnapshotCoordinator?.onTurnStart(sessionId),
    onUndispatchedUserTurn: (sessionId) => gitSnapshotCoordinator?.onTurnAbort(sessionId),
  };
}

export function isSessionInTurn(sessionId: string): boolean {
  return sessionTurnActivityTracker.isSessionInTurn(sessionId);
}

/**
 * 标题素材读取需要覆盖 `status:isRunning=false` 到 terminal event 的短窗口：
 * 逻辑 running 已结束，但最后一条 Assistant 还没有拿到 durable turn seal。
 * dispatch boundary 正好在 terminal delivery 后才释放，不改变全局
 * `isSessionInTurn` 的产品语义。
 */
export function isSessionTurnPendingCompletion(sessionId: string): boolean {
  return sessionTurnActivityTracker.isSessionTurnDispatchBoundaryBusy(sessionId);
}

/**
 * 数据 owner 边界(登出 / 切账号)时丢弃跨 owner 的延迟 Codex 重启登记。
 * IPC handler 与本模块 holder 随进程存活,而具体 Maker 在 owner 边界被整体替换
 * (dynamic facade)—— 旧 owner 的记忆设置变更不得在新 owner 的 Maker 上兑现
 * 重启、关掉新 owner 的会话(review P1 2026-07-23)。bootstrap 的 owner 边界
 * 收口在 maker.shutdown()/resetMaker() 前调用。
 */
export function clearDeferredCodexRestartForOwnerBoundary(): void {
  deferredCodexRestartHolder?.clear();
}

/**
 * Goal / IM / scheduler 直发 `Session.send()` 的 deferred agent-switch 锁桥。
 *
 * 与 renderer 的 makerSendTransaction 不同,这些调用方没有后续 lazy-create 阶段;
 * holder 因此先在 session 锁内同步 bootstrap 新引擎,调用方重新读取 live session
 * 并完成 send 后才 release。启动期 holder 尚未就绪时不可能已有进程内 pending
 * intent,返回 no-op release 即可。
 */
export async function acquirePendingAgentSwitchForDirectSend(
  sessionId: string,
  signal?: AbortSignal,
): Promise<() => void> {
  return pendingAgentSwitchApplyHolder?.(sessionId, signal) ?? (() => {});
}

/** Later successful model/provider picks supersede an earlier cross-engine intent. */
export function cancelPendingAgentSwitchForSession(sessionId: string): void {
  cancelPendingAgentSwitchHolder?.(sessionId);
}

/**
 * 运行时 model/provider 切换的 pending 桥接。
 *
 * desktop IPC 与 IM 卡片都必须走同一组入口，否则 busy turn 下会出现一端 deferred、
 * 另一端 fail-closed 的行为分叉。register 在 service 尚未初始化时必须抛错，不能
 * 假装登记成功后丢失用户选择；其余读取/清理入口保持启动期 no-op 语义。
 */
export async function registerPendingCredentialSwitchForSession(
  sessionId: string,
  target: { model: string; providerId: string | null },
): Promise<void> {
  const service = pendingCredentialSwitchHolder;
  if (!service) {
    throw new Error('Pending credential switch service is not initialized');
  }
  // 捕获会话 agent:deferred 切换在收口时刻要重过停用裁决(期间目标可能被停用,
  // PR #744 review 第七轮);读不到(会话行缺失)则登记不带 agentKind = 收口不裁决。
  const dbAgentKind = getSessionDbAgentKind(sessionId);
  // 捕获切换前的运行路由:model 用 live handle(热切过未落库时比 DB 权威),来源用
  // provider store;effort / fast 无 live getter,从 DB 行读 —— renderer 在收到
  // deferred 结果**之后**才落盘请求值,本函数在 IPC 回包之前执行,此刻行里仍是
  // 切换前值,无竞态。目标在等待期间被全停且目录无启用兜底时,收口按整套
  // previousRoute 回滚(model/provider/effort/fast 一致成对,第十六、十八轮)。
  // deferred 场景会话正在跑 turn,live handle 必在;取不到就不带 = 无从回滚。
  const live = getMaker().getSession(sessionId);
  let prevRow: { model: string | null; effort: string | null; fastMode: boolean | null; providerId: string | null } | null = null;
  try {
    const [row] = await getDbClient()
      .drizzle.select({
        model: sessions.model,
        effort: sessions.effort,
        fastMode: sessions.fastMode,
        providerId: sessions.providerId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    prevRow = row ?? null;
  } catch {
    prevRow = null;
  }
  const prevModel = live?.model ?? prevRow?.model ?? null;
  service.register(sessionId, {
    ...target,
    ...(dbAgentKind ? { agentKind: dbToMakerAgentKind(dbAgentKind) } : {}),
    ...(prevModel
      ? {
          previousRoute: {
            model: prevModel,
            providerId: getSessionProvider(sessionId) ?? prevRow?.providerId ?? null,
            ...(prevRow?.effort ? { effort: prevRow.effort } : {}),
            ...(prevRow?.fastMode != null ? { fastMode: prevRow.fastMode } : {}),
          },
        }
      : {}),
  });
}

export function clearPendingCredentialSwitchForSession(
  sessionId: string,
  opts?: { wake?: boolean },
): void {
  pendingCredentialSwitchHolder?.clear(sessionId);
  // pending 门解除后 coordinator 没有其它唤醒源；wake:false 由调用方在
  // close + route 写入完成后显式唤醒，避免队首趁窗口派发到旧凭证。
  if (opts?.wake !== false) {
    agentInputCoordinatorHolder?.wakeSession(sessionId, 'pending-credential-switch-cancelled');
  }
}

export function wakeSessionInputAfterCredentialSwitch(sessionId: string): void {
  agentInputCoordinatorHolder?.wakeSession(sessionId, 'credential-switch-applied-inline');
}

export function getPendingCredentialSwitchTarget(
  sessionId: string,
): { model: string; providerId: string | null } | undefined {
  const pending = pendingCredentialSwitchHolder?.get(sessionId);
  return pending
    ? { model: pending.model, providerId: pending.providerId }
    : undefined;
}

// ── Scheduler 撞忙排队桥(scheduler-host runner 消费)────────────────────────
// 心跳任务 fire 时目标会话正忙 → 不再盲发(会被 SESSION_RUNNING 拒)也不再只
// 静默顺延,而是把心跳 prompt 作为排队消息入 coordinator 队列:用户在会话里
// 看得见"排队中的自动化任务"、可手动删除;turn 结束后按队列顺序自动派发,
// runner 经 onAccepted 收到派发通知后继续既有的 run 结果捕获/通知链路。
// 实现挂在 registerAll 闭包里(需要 inputCoordinator / maker / 队列 createOpts
// 构造),这里只留 holder + 导出薄封装;holder 未就绪(启动早期 / 未登录)时
// isBusy 返回 false → runner 走原直发路径,行为与本特性引入前一致。

export interface SchedulerQueuedPromptRequest {
  sessionId: string;
  /** 发给 agent 的正文(可含静默运行隐藏协议后缀)。 */
  text: string;
  /** 落库与队列气泡展示的用户原始 prompt(不含隐藏协议)。 */
  persistedContent: string;
  origin: { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId?: string };
  /** 排队项被 drain 派发、turn 已被会话接受时回调(等价直发路径的 send onAccepted)。 */
  onAccepted: () => void | Promise<void>;
  /** 派发已 accept 但最终未成为运行 turn(取消/回滚)时回调。 */
  onAcceptedRollback?: () => void | Promise<void>;
  /** 排队项未派发即被丢弃(用户删除队列行 / stop 清队列 / 会话清理)时回调。 */
  onDiscarded?: () => void;
}

/**
 * enqueuePrompt 的结果:成功入队;或命中同任务既有排队/待重试项(去重);
 * 或崩溃恢复快照尚未成功读回(retry —— 恢复完成前不能做持久化去重,调用方
 * 顺延本次 fire 稍后再试,防止恢复后与快照里的同任务项双份派发)。
 */
export type SchedulerEnqueueResult =
  | { clientId: string }
  | { duplicate: true }
  | { retry: true };

interface SchedulerQueueBridge {
  isSessionBusy(sessionId: string): boolean;
  hasQueuedPrompt(sessionId: string, scheduleId: string): boolean;
  enqueuePrompt(req: SchedulerQueuedPromptRequest): Promise<SchedulerEnqueueResult>;
  removeQueuedPrompt(sessionId: string, clientId: string): void;
  /** 排队项(含派发中 / 可重试 recovery)是否仍被 coordinator 跟踪 —— runner 派发等待的存活探测。 */
  isPromptTracked(sessionId: string, clientId: string): boolean;
}

let schedulerQueueBridgeHolder: SchedulerQueueBridge | null = null;
/** 排队心跳的 discard 监听(clientId → 通知 runner 收尾)。派发/丢弃后清条目。 */
const schedulerQueuedPromptDiscardWatchers = new Map<string, () => void>();

export function isSchedulerTargetSessionBusy(sessionId: string): boolean {
  return schedulerQueueBridgeHolder?.isSessionBusy(sessionId) ?? false;
}

export function hasQueuedSchedulerPrompt(sessionId: string, scheduleId: string): boolean {
  return schedulerQueueBridgeHolder?.hasQueuedPrompt(sessionId, scheduleId) ?? false;
}

export async function enqueueSchedulerPrompt(
  req: SchedulerQueuedPromptRequest,
): Promise<SchedulerEnqueueResult> {
  const bridge = schedulerQueueBridgeHolder;
  if (!bridge) throw new Error('scheduler queue bridge not ready');
  return bridge.enqueuePrompt(req);
}

export function isSchedulerPromptTracked(sessionId: string, clientId: string): boolean {
  // holder 未就绪(切账号窗口)时按"仍在跟踪"处理:探测的用途是防挂起兜底,
  // 宁可多等、不误杀正常排队中的 run。
  return schedulerQueueBridgeHolder?.isPromptTracked(sessionId, clientId) ?? true;
}

export function removeQueuedSchedulerPrompt(sessionId: string, clientId: string): void {
  schedulerQueueBridgeHolder?.removeQueuedPrompt(sessionId, clientId);
}

function sessionMetaForIsland(session: {
  id: string;
  agentKind?: unknown;
  workDir?: unknown;
  workspaceKind?: unknown;
}): {
  sessionId: string;
  agentKind?: string;
  workingDir?: string | null;
  workspaceKind?: string | null;
} {
  return {
    sessionId: session.id,
    agentKind: typeof session.agentKind === 'string' ? session.agentKind : undefined,
    workingDir: typeof session.workDir === 'string' ? session.workDir : null,
    workspaceKind: typeof session.workspaceKind === 'string' ? session.workspaceKind : null,
  };
}

function handleAgentIslandEventAfterBroadcast(
  session: {
    id: string;
    agentKind?: unknown;
    workDir?: unknown;
    workspaceKind?: unknown;
    remoteHostId?: unknown;
  },
  event: AgentEvent,
): void {
  if (!shouldNotifyAgentIslandForSession(session.id)) return;
  try {
    const service = getAgentIslandService();
    if (!service) return;
    const meta = sessionMetaForIsland(session);
    if (isRemoteAuthRetryErrorEvent(session, event)) {
      service.deferRemoteAuthRetryError(meta, event);
      return;
    }
    const terminalError = event.type === 'error' && isTerminalTurnErrorEvent(event);
    const autoResumePendingOrDeferred =
      agentInputCoordinatorHolder?.isAutoResumePending(session.id) === true ||
      agentInputCoordinatorHolder?.isAutoResumeDeferred(session.id) === true;
    const autoResumeOwnsError =
      autoResumePendingOrDeferred ||
      autoResumeBookkeeping.shouldSuppressAgentIslandError(session.id);
    const autoResumeOwnsCompletionTail =
      autoResumePendingOrDeferred ||
      autoResumeBookkeeping.shouldSuppressAgentIslandCompletionTail(session.id);
    if (
      (terminalError && autoResumeOwnsError) ||
      (isAgentIslandCompletionTail(event) && autoResumeOwnsCompletionTail)
    ) {
      // Auto-resume owns both the error and its provider completion tail. Do not
      // let either enter Agent Island; the existing suppressed-error lifecycle
      // will surface the real error once if recovery is ultimately rejected.
      return;
    }
    service.handleAgentEvent(meta, event);
  } catch (error) {
    log.warn('Agent Island event update failed after maker event broadcast', {
      sessionId: session.id,
      type: event.type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isAgentIslandCompletionTail(event: AgentEvent): boolean {
  if (event.type === 'done') return true;
  if (event.type !== 'status') return false;
  const data = event.data as { isRunning?: unknown } | undefined;
  return data?.isRunning === false;
}

function surfaceSuppressedAutoResumeErrorInAgentIsland(
  sessionId: string,
  detail: SuppressedTurnError,
): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    const service = getAgentIslandService();
    if (!service) return;
    const wired = wiredSessionsById.get(sessionId)?.session;
    const meta = wired ? sessionMetaForIsland(wired) : { sessionId };
    service.handleAgentEvent(meta, redactEventForRenderer({
      type: 'error',
      data: { ...detail, isTerminal: true },
    }));
  } catch (error) {
    log.warn('Agent Island suppressed auto-resume error restore failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isRemoteAuthRetryErrorEvent(
  session: { agentKind?: unknown; remoteHostId?: unknown },
  event: AgentEvent,
): boolean {
  if (!session.remoteHostId || event.type !== 'error' || !isTerminalTurnErrorEvent(event)) return false;
  if (session.agentKind === 'codex') return false;
  const data = event.data as { message?: unknown; sdkError?: unknown; errorStatus?: unknown } | undefined;
  return data?.sdkError === 'authentication_failed' ||
    data?.errorStatus === 401 ||
    /authentication_error|invalid.*api.key|401/i.test(
      typeof data?.message === 'string' ? data.message : '',
    );
}

function handleAgentIslandInteractionAfterBroadcast(
  session: { id: string; agentKind?: unknown; workDir?: unknown; workspaceKind?: unknown },
  request: InteractionRequest,
  interactionEpoch: number | null,
): void {
  if (interactionEpoch === null || !shouldNotifyAgentIslandForSession(session.id)) return;
  try {
    getAgentIslandService()?.handleInteractionRequest(
      sessionMetaForIsland(session),
      request,
      interactionEpoch,
    );
  } catch (error) {
    log.warn('Agent Island interaction update failed after maker interaction broadcast', {
      sessionId: session.id,
      requestId: request.requestId,
      kind: request.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandInteractionDismissed(sessionId: string, requestId: string): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.handleInteractionDismissed(sessionId, requestId);
  } catch (error) {
    log.warn('Agent Island interaction dismiss update failed during mandatory cleanup', {
      sessionId,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandInteractionDismissedByRequestId(requestId: string): void {
  try {
    getAgentIslandService()?.handleInteractionDismissedByRequestId(requestId);
  } catch (error) {
    log.warn('Agent Island interaction dismiss update failed by request id', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandSessionClosedAfterCleanup(
  sessionId: string,
  reason: 'discarded' | 'process-closed' = 'discarded',
): void {
  try {
    getAgentIslandService()?.handleSessionClosed(sessionId, { reason });
  } catch (error) {
    log.warn('Agent Island session close cleanup failed after mandatory session cleanup', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleAgentIslandSessionStopped(
  session: string | { id: string; getCurrentTurnId?: () => string | null },
): void {
  const sessionId = typeof session === 'string' ? session : session.id;
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.handleSessionStopped(
      sessionId,
      typeof session === 'string' ? null : (session.getCurrentTurnId?.() ?? null),
    );
  } catch (error) {
    log.warn('Agent Island session stop update failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function shouldNotifyAgentIslandForSession(sessionId: string): boolean {
  return shouldNotifyAgentIslandForSessionByPolicy(
    AGENT_ISLAND_DISPLAY_CONFIG,
    isKnownOrcaWorkerSession(sessionId),
  );
}

function clearSuppressedOrcaWorkerAgentIslandSession(sessionId: string): void {
  if (!shouldClearAgentIslandSessionForOrcaWorker(AGENT_ISLAND_DISPLAY_CONFIG)) return;
  handleAgentIslandSessionClosedAfterCleanup(sessionId);
}

function notifyAgentIslandUserPrompt(
  session: { id: string; agentKind?: unknown; workDir?: unknown; workspaceKind?: unknown },
  content: unknown,
  options: { source: string; clientId?: string; replacesCurrentTurn?: boolean } = {
    source: 'unknown',
  },
): boolean {
  if (!shouldNotifyAgentIslandForSession(session.id)) return false;
  const prompt = extractAgentIslandPromptText(content);
  if (!prompt) return false;
  try {
    const service = getAgentIslandService();
    if (!service) return false;
    return service.handleUserPrompt(sessionMetaForIsland(session), prompt, {
      source: options.source,
      clientId: options.clientId,
      notifiedAt: Date.now(),
      replacesCurrentTurn: options.replacesCurrentTurn,
    });
  } catch (error) {
    log.warn('Agent Island prompt preview update failed after user message persistence', {
      sessionId: session.id,
      source: options.source,
      clientId: options.clientId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

function dispatchAgentIslandUserPrompt(sessionId: string): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.handleUserPromptDispatching(sessionId);
  } catch (error) {
    log.warn('Agent Island prompt dispatch boundary update failed', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function commitAgentIslandUserPrompt(sessionId: string, clientId: string | undefined): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.commitUserPrompt(sessionId, clientId);
  } catch (error) {
    log.warn('Agent Island prompt preview commit failed', {
      sessionId,
      clientId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function rollbackAgentIslandUserPrompt(sessionId: string, clientId: string | undefined, source: string): void {
  if (!shouldNotifyAgentIslandForSession(sessionId)) return;
  try {
    getAgentIslandService()?.rollbackUserPrompt(sessionId, clientId);
  } catch (error) {
    log.warn('Agent Island prompt preview rollback failed', {
      sessionId,
      clientId,
      source,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function extractAgentIslandPromptText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null;
  if (Array.isArray(content)) return extractAgentIslandPromptTextFromBlocks(content);
  if (!content || typeof content !== 'object') return null;
  const record = content as { content?: unknown; text?: unknown };
  if (typeof record.content === 'string') return record.content.trim() || null;
  if (Array.isArray(record.content)) return extractAgentIslandPromptTextFromBlocks(record.content);
  if (typeof record.text === 'string') return record.text.trim() || null;
  return null;
}

function extractAgentIslandPromptTextFromBlocks(blocks: unknown[]): string | null {
  const text = blocks
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!block || typeof block !== 'object') return '';
      const record = block as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

/**
 * 当前是否有任意一个 session 正在跑 turn。
 * 给 WindowControls 关闭按钮用: 无 in-flight 直接进 closing overlay, 有 in-flight 弹确认框。
 * sessionTurnActivityTracker 由 maker-core 发出的 status event、done、close 边界维护；
 * maker active sessions 覆盖 Session.send accepted/reserved 到首个 status 之间的窗口。
 * 这里只是 snapshot 一次, O(N) 其中 N = 当前 alive session 数, 几十量级, 可忽略。
 */
export function anySessionInTurn(maker?: Pick<Maker, 'listActiveSessions'> | null): boolean {
  return hasAnySessionInTurn(sessionTurnActivityTracker, maker?.listActiveSessions() ?? []);
}

/**
 * /goal 生命周期旁路(setter 注入避免 register↔goal-host 环):
 *  - goalClearObserver:clear-context(INPUT_CLEAR_SESSION)时清除该会话目标(上下文已抹,目标失去依据)。
 *  - goalIdleObserver:会话 turn 收尾(idle)时让 controller 兜底续跑 active 目标(#9,race-free,见 controller.maybeContinueActiveGoal)。
 *  - goalStopObserver:用户 Stop 当前 turn(ABORT_SESSION)时把 active 目标暂停。调用 observer
 *    会同步 detach 监听/续跑资格；paused 持久化与 vendor abort 并行，回执等落盘收口。
 * bootstrap 在启动期接上 getGoalController()?.clearGoal / maybeContinueActiveGoal / pauseGoal。
 */
let goalClearObserver: ((sessionId: string) => void) | null = null;
export function setGoalClearObserver(observer: ((sessionId: string) => void) | null): void {
  goalClearObserver = observer;
}
let goalIdleObserver: ((sessionId: string) => void) | null = null;
export function setGoalIdleObserver(observer: ((sessionId: string) => void) | null): void {
  goalIdleObserver = observer;
}
let goalStopObserver: ((sessionId: string) => void | Promise<void>) | null = null;
export function setGoalStopObserver(
  observer: ((sessionId: string) => void | Promise<void>) | null,
): void {
  goalStopObserver = observer;
}

/** Goal 的同步 detach 是 Stop 边界；vendor abort 先启动，IPC 回执等待 paused 落定。 */
async function pauseGoalBeforeExplicitStop(sessionId: string): Promise<void> {
  const observer = goalStopObserver;
  if (!observer) return;
  try {
    await Promise.resolve(observer(sessionId));
  } catch (err) {
    log.error('goal pause persistence failed during explicit stop', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    throwIpcError('INTERNAL', 'Failed to persist the stopped Goal state');
  }
}
// (Option B)用户答完 AskUserQuestion 时,把结构化答案 + 本次问题(含选项)交给 goal controller
// 即时改写目标(仅首轮、且确认这次问的就是"目标澄清问题"时,controller 内部再 guard)。
// 透传 questions 是为了让 controller 用确定性标记(选项里是否含原目标 verbatim)区分目标澄清 vs
// 普通工作型提问。bootstrap 接 getGoalController()?.applyClarificationAnswer。
type AskUserQuestions = Extract<InteractionRequest, { kind: 'ask_user_question' }>['questions'];
let goalAskAnswerObserver:
  | ((sessionId: string, answers: Record<string, string>, questions: AskUserQuestions) => void)
  | null = null;
export function setGoalAskAnswerObserver(
  observer: ((sessionId: string, answers: Record<string, string>, questions: AskUserQuestions) => void) | null,
): void {
  goalAskAnswerObserver = observer;
}

/**
 * 把 Desktop fallback handler 登记到 session 级中央 InteractionRouter — 行为:broadcast
 * INTERACTION_REQUEST 给所有 window, 等 renderer 通过 RESOLVE_INTERACTION IPC
 * 回 decision。permission 10 分钟超时兜底为 deny; ask/plan 不超时，必须等
 * 用户提交、停止任务或关闭 session。
 *
 * Router 在 Session 实例生命周期内只安装一次 listener。Feishu/Discord/Slack
 * turn 通过 beforeProviderStart 登记临时 route，终态只释放自己的 lease，
 * 不再覆盖或“还原” Desktop listener。重复调用只更新 Desktop fallback。
 */
export function installDesktopInteractionListener(
  session: { id: string; setInteractionListener: (l: ((req: InteractionRequest) => Promise<InteractionDecision>) | null) => void },
): void {
  installDesktopInteractionHandler(session, async (req: InteractionRequest) => {
    const agentIslandInteractionEpoch = shouldNotifyAgentIslandForSession(session.id)
      ? getAgentIslandService()?.captureInteractionEpoch(session.id) ?? null
      : null;
    // F1-a Phase 2: interaction(ask_user / plan_review / permission)是 turn 暂停边界,
    // 且不走 onEvent —— 在这把在飞 assistant 文本落库,等价于 renderer 老逻辑在
    // ask_user_question / plan_review case 里的 mid-turn assistant 抢救(只入队、不阻塞)。
    if (
      agentIslandInteractionEpoch !== null &&
      shouldNotifyAgentIslandForSession(session.id) &&
      getAgentIslandService()?.isInteractionCurrent(
        session.id,
        agentIslandInteractionEpoch,
      ) === false
    ) {
      return defaultDecisionForPending(req.kind, 'stale_turn');
    }
    flushAssistantBlock(session.id);
    // F1-a Phase 5: ask_user / plan_review 的消息本身也收口 main 单点落库(单 persistId,
    // 修 F1 重复),persistId 盖进 payload 让 renderer 用同一 id 建气泡 + answered 回写命中。
    // permission 不建 chat 消息 → persistId 为 undefined。
    const interactionPersistId = onInteractionMessage(session.id, req as unknown as {
      kind?: unknown; requestId?: unknown; questions?: unknown; plan?: unknown; planFilePath?: unknown;
    });
    broadcastToAllWindows(MAKER_PUSH.INTERACTION_REQUEST, {
      sessionId: session.id,
      request: req,
      persistId: interactionPersistId,
    });
    return new Promise<InteractionDecision>((resolve) => {
      const entry: PendingInteractionEntry = {
        sessionId: session.id,
        kind: req.kind,
        resolve,
        request: req,
        persistId: interactionPersistId ?? undefined,
      };
      if (req.kind === 'permission') {
        entry.timeoutId = setTimeout(() => {
          const pending = clearPendingInteraction(req.requestId);
          if (!pending) return;
          handleAgentIslandInteractionDismissed(session.id, req.requestId);
          pending.resolve({ kind: 'permission', behavior: 'deny', reason: 'timeout' });
          dismissRendererInteraction(pending, req.requestId, 'timeout', 'deny');
        }, PERMISSION_INTERACTION_TIMEOUT_MS);
      }
      pendingInteractionResolvers.set(req.requestId, entry);
      handleAgentIslandInteractionAfterBroadcast(
        session as { id: string; agentKind?: unknown; workDir?: unknown; workspaceKind?: unknown },
        req,
        agentIslandInteractionEpoch,
      );
    });
  });
}

/**
 * 把 session 接进 IPC 转发链路 —— 让事件 / 状态变化 / interaction 请求都 fan-out
 * 到所有 BrowserWindow，让 renderer 的 makerChatStore 能听到事件并落库 messages 表。
 *
 * 调用点:
 *   1. CREATE_SESSION adapter — renderer 主动建 session
 *   2. SEND lazy-create / rehydrate 分支
 *   3. scheduler-host/runner.ts — schedule fire 创建 session（关键修复，之前漏接）
 *      漏接后果：runner-created session 的事件停留在 maker-host 内部，renderer 收不到，
 *      messages / cost / status 全部空 — schedule 跑出来的 session 在 UI 里一片空白。
 *   4. feishu /ctr 接管流程 (im/feishu/runAgentTurn.ts) — 通过 wireSessionToIpcExternal
 *      compat alias 调用本函数。
 *   未来若新增任何"绕过 IPC 直接 maker.createSession()"的入口（如 MCP server tool）必须也调本函数。
 */
/**
 * silent-stop turn 的续跑执行体:问守卫要决策,resume 则以用户身份补发「继续」
 * (落库带 agentMeta.autoResume 标记,renderer 渲染成分隔线而非用户气泡),
 * exhausted 则向 renderer 合成一条 terminal error(reason: silent-stop-exhausted,
 * ErrorBanner 渲染成带「继续」按钮的提示)。合成 error 只广播给 renderer,不进
 * main 自身的 session.onEvent 管线 —— turn 已正常 done 收尾,不能再触发第二次
 * 终结记账/收口。失败只 warn + 清 pending,绝不重试(额度不退,安全方向)。
 */
/**
 * silent-stop done 时 idle 转换被延迟(避免假完成通知);当守卫决定不续跑时
 * (skip / exhausted / send 失败)补发被推迟的 idle + coordinator done 信号,
 * 让 renderer 正确显示 stopped、scheduler/hook runner 收到 done 并 finish。
 */
function settleSilentStopDone(sessionId: string, reason: 'exhausted' | 'skip' | 'send-failed'): void {
  sessionTurnActivityTracker.scheduleIdleAfterTerminalBroadcast(sessionId);
  noteClaudeSessionTurnState(sessionId, false);
  agentInputCoordinatorHolder?.onTurnEvent(sessionId, 'done');
  settlePendingCredentialSwitch(sessionId, `silent-stop:${reason}`);
  deferredCodexRestartHolder?.onSessionSettled();
  agentInputCoordinatorHolder?.onExternalTurnSettled(sessionId);
  refreshRemoteCodexMcpOnTurnSettledHolder?.(sessionId);
  fireSilentStopSettled(sessionId, reason);
}

async function surfaceSilentStopExhaustedBanner(sessionId: string): Promise<void> {
  await createDbMessage(
    sessionId,
    {
      clientId: randomUUID(),
      role: 'error',
      content: {
        message: '模型连续多次返回空响应,自动续跑已暂停。点击「继续」恢复任务。',
        isTerminal: true,
        reason: 'silent-stop-exhausted',
      },
    },
    { shouldBroadcast: () => false },
  ).catch((err) => {
    log.warn('silent-stop exhausted marker persist failed', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  broadcastToAllWindows(MAKER_PUSH.EVENT, {
    sessionId,
    event: {
      type: 'error',
      data: {
        message: '模型连续多次返回空响应,自动续跑已暂停。点击「继续」恢复任务。',
        isTerminal: true,
        reason: 'silent-stop-exhausted',
      },
      source: 'claude-code',
    },
  });
  log.warn('silent-stop auto-resume exhausted — surfaced continue banner', { sessionId });
}

async function handleSilentStopTurnEnd(
  session: NonNullable<ReturnType<Maker['getSession']>>,
  doneAt: number,
  turnOrigin?: SendOrigin,
): Promise<void> {
  if (agentInputCoordinatorHolder?.hasPendingQueuedWork(session.id)) {
    log.debug('silent-stop auto-resume skipped — coordinator has queued work', {
      sessionId: session.id,
    });
    settleSilentStopDone(session.id, 'skip');
    return;
  }
  const decision = silentStopAutoResumeGuard.onSilentStop(session.id, doneAt);
  if (decision.action === 'resume') {
    try {
      const clientId = randomUUID();
      const sendResult = await session.send(
        { type: 'user', content: SILENT_STOP_RESUME_PROMPT },
        {
          origin: turnOrigin,
          onAccepted: async () => {
            await createDbMessage(session.id, {
              clientId,
              role: 'user',
              content: SILENT_STOP_RESUME_PROMPT,
              // autoResume: renderer 据此隐藏用户气泡、渲染「已自动继续」分隔线;
              // 也是审计标记(DB/transcript 里可查每次自动续跑)。
              agentMeta: {
                delivery: 'turn',
                autoResume: true,
                ...(turnOrigin?.kind === 'scheduler' && turnOrigin.scheduleId
                  ? {
                      origin: {
                        kind: 'scheduler' as const,
                        scheduleId: turnOrigin.scheduleId,
                        ...(turnOrigin.scheduleName ? { scheduleName: turnOrigin.scheduleName } : {}),
                        ...(turnOrigin.runId ? { runId: turnOrigin.runId } : {}),
                      },
                    }
                  : {}),
              },
            });
          },
        },
      );
      // send outcome 统一走 toDesktopSessionDispatchOutcome 消费(directSessionSendGuard
      // 强制的调用点协议),不手检 accepted。
      const outcome = toDesktopSessionDispatchOutcome(sendResult, {
        source: 'silent-stop-auto-resume',
        context: `maker-ipc.silent-stop.auto-resume sessionId=${session.id}`,
      });
      if (!outcome.dispatched) {
        silentStopAutoResumeGuard.noteResumeSendFailed(session.id);
        log.warn('silent-stop auto-resume send not accepted', {
          sessionId: session.id,
          reason: outcome.reason,
        });
        await surfaceSilentStopExhaustedBanner(session.id);
        settleSilentStopDone(session.id, 'exhausted');
      } else {
        log.info('silent-stop auto-resume dispatched', { sessionId: session.id });
      }
    } catch (err) {
      silentStopAutoResumeGuard.noteResumeSendFailed(session.id);
      log.warn('silent-stop auto-resume send failed', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
      await surfaceSilentStopExhaustedBanner(session.id);
      settleSilentStopDone(session.id, 'exhausted');
    }
    return;
  }
  if (decision.action === 'exhausted') {
    await surfaceSilentStopExhaustedBanner(session.id);
    settleSilentStopDone(session.id, 'exhausted');
  }
  if (decision.action === 'skip') {
    settleSilentStopDone(session.id, 'skip');
  }
}

export function wireSessionToIpc(session: ReturnType<Maker['getSession']>): void {
  if (!session) return;
  const existing = wiredSessionsById.get(session.id);
  if (existing?.session === session) {
    installDesktopInteractionListener(session);
    return;
  }
  if (existing) {
    // A runtime replacement invalidates any delayed direct-abort callback that
    // still belongs to the old Session instance.
    cancelDirectAbortReconciliation(session.id);
    for (const dispose of existing.disposers) dispose();
    existing.session.setInteractionListener(null);
  }
  advanceSessionTurnBoundaryGeneration(session.id);
  const registration: WiredSessionRegistration = { session, disposers: [] };
  wiredSessionsById.set(session.id, registration);

  // session-agent-switch:登记本会话当前引擎,broadcaster / user 行落库据此逐行
  // stamp messages.agent_kind(切换后历史行的 agent_meta 必须按写入时引擎解析)。
  noteSessionAgentKind(session.id, makerToDbAgentKind(session.agentKind));

  // 订阅槽①旁听 tap(独立监听,叠加在主转发之外互不干扰):AgentEvent →
  // did-turn-*。资格(用户主会话)与自动化轮次过滤都在 tap 内部,这里零逻辑。
  const ghostSessionTap = createGhostSessionTap(session.id);
  // 拆线收口:实例替换(上面的 existing.disposers)与会话关闭(下面 closed 的
  // finally)两条路径都要给插件补上缺失的 did-turn-end 与在场审批的 end,否则订阅方
  // 的「AI 在忙 / 在等审批」外层状态永久卡住。observer 也在这里摘掉。
  registration.disposers.push(() => {
    ghostSessionTap.dispose();
    installInteractionLifecycleObserver(session, null);
  });
  registration.disposers.push(session.onEvent((event: AgentEvent) => {
    ghostSessionTap.handleEvent(
      event as { type: string; data?: unknown; source?: string; turnOrigin?: { kind?: string } },
    );
  }));

  // 转发事件到所有 window。interaction_dismissed 单独走专用 channel,
  // 让 renderer chat store 不必扫所有 vendor-raw 找它。
  registration.disposers.push(session.onEvent((event: AgentEvent) => {
    let attributedEvent = event;
    if (event.type === 'error' && isTerminalTurnErrorEvent(event)) {
      const reason = !session.remoteHostId && session.agentKind === 'claude-code'
        ? consumeClaudeGatewayOpusPlanMismatch(session.id)
        : null;
      if (reason) {
        const eventData = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : {};
        attributedEvent = {
          ...event,
          data: { ...eventData, reason },
        };
        log.warn('Claude Opus plan error attributed to XD Gateway route', {
          sessionId: session.id,
          model: session.model,
          reason,
        });
      }
    }
    const broadcastEvent = redactEventForRenderer(attributedEvent);
    if (event.type === 'interaction_dismissed') {
      const data = event.data as { requestId?: unknown; reason?: unknown };
      if (typeof data.requestId === 'string') {
        handleAgentIslandInteractionDismissed(session.id, data.requestId);
        const entry = clearPendingInteraction(data.requestId);
        if (entry) {
          entry.resolve(defaultDecisionForPending(
            entry.kind,
            typeof data.reason === 'string' ? data.reason : 'dismissed',
          ));
        }
      }
      broadcastToAllWindows(MAKER_PUSH.INTERACTION_DISMISSED, { sessionId: session.id, ...(event.data as object) });
      return;
    }
    if (event.type === 'image' && event.source === 'codex') {
      void broadcastCodexImageAsToolResult(session.id, event);
      return;
    }
    if (event.type === 'plan_mode_changed') {
      // agent 自行切换计划模式(典型: 计划批准后自动退出)。main 是持久化收口点:
      // 复用 persistSessionFields 回写 sessions.plan_mode_enabled 并广播
      // sessions:patched, 本机窗口与 device-link 控制端镜像同步收敛。
      const data = event.data as { enabled?: unknown };
      if (typeof data?.enabled === 'boolean') {
        void persistSessionFields(session.id, { planModeEnabled: data.enabled }).catch((err) => {
          log.warn('persist plan_mode_changed failed', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return;
    }
    // turn 结束的 status event (isRunning=false + status='Done') 携带 endSnapshot。
    // contextTokens / contextWindow 的持久化统一在 main 端做，避免多 window 竞写；
    // 但不能挡在 EVENT broadcast 前面，否则 final/done 已到 main 后还会被同步 SQLite
    // 和 usage 广播拖住。这里先记录待写快照，广播后再执行。
    // Claude / Codex 同形 (usageTracker.snapshot() 两边都给 contextTokens / contextWindow),
    // 不按 source 分支 —— 之前漏接 codex 导致重启后圆环归零。
    let pendingContextSnapshot: { contextTokens: number; contextWindow: number } | null = null;
    let pendingCodexAccountUsageSnapshot: unknown | null = null;
    let shouldMarkTurnStatusIdleAfterBroadcast = false;
    let shouldMarkTurnTerminalIdleAfterBroadcast = false;
    if (event.type === 'account_usage' && event.source === 'codex' && !session.remoteHostId) {
      pendingCodexAccountUsageSnapshot = event.data;
    }
    if (event.type === 'status') {
      const data = event.data as {
        isRunning?: boolean;
        status?: string;
        contextTokens?: number;
        contextWindow?: number;
      };
      if (data.isRunning === true) {
        // replacement 已进入 vendor 后，running 是新 attempt 的权威起点。不要依赖
        // sendToAgent 返回后的 onDispatched 回调：provider 可同步发事件并先清 activeTurn。
        autoResumeBookkeeping.discardReplacementProvenByProviderEvent(session.id);
        // 新 turn 启动: 上一轮未配对的失败记账交接 id 已无归属, 丢弃防错配。
        pendingFailedTurnAssistantPersistId.delete(session.id);
        // 记录 turn 开始时刻，供 onTurnErrorEvent 判断 error 是否属于 /clear 之前的旧 turn。
        noteTurnStarted(session.id);
        // silent-stop 守卫:新 turn 开始 → 清 pendingResume + 记录时刻(陈旧判定)。
        silentStopAutoResumeGuard.noteTurnStarted(session.id);
        interruptedTurnAutoResumeGuard.noteTurnStarted(session.id);
        const wasInTurn = sessionTurnActivityTracker.isSessionInTurn(session.id);
        sessionTurnActivityTracker.setSessionInTurn(session.id, data.isRunning);
        if (!wasInTurn) advanceSessionTurnBoundaryGeneration(session.id);
        // 后台活动检测:turn 开始 → 该会话的 API 流量回归主线,后台横幅熄灭。
        noteClaudeSessionTurnState(session.id, true);
        if (!wasInTurn) {
          if (!gitSnapshotCoordinator?.hasPendingTurnStart(session.id)) {
            void gitSnapshotCoordinator?.onTurnStart(session.id);
          }
          workerTurnStartSequencer.start(session.id, async () => {
            await orcaTeamServiceForEvents?.handleWorkerTurnStarted(session.id);
          });
          // interrupted-turn-resume:记录 turn 启动时刻,与正常收尾时刻配对做
          // 「疑似中断」纯读判定(设计总述见 localDb/sessionActiveTurn.ts 文件头)。
          // SSH remote 会话同样记录:session 行在本地 DB、事件流走本进程,只是
          // agent 跑在远端;device-link 被控会话不进本进程 maker-core,天然不经过。
          markSessionTurnStarted(session.id);
        }
        if (
          (event.source === 'claude-code' || event.source === 'codex' || event.source === 'pi')
          && !turnModelPromiseBySession.has(session.id)
        ) {
          turnModelPromiseBySession.set(session.id, readSessionModelForUsage(session.id));
        }
      } else if (data.isRunning === false) {
        shouldMarkTurnStatusIdleAfterBroadcast = true;
      }
      if (data.isRunning === false && data.status === 'Done' && typeof data.contextTokens === 'number') {
        pendingContextSnapshot = {
          contextTokens: data.contextTokens,
          contextWindow: data.contextWindow ?? 0,
        };
      }
    }
    if (event.type === 'done') {
      // turn 正常收尾但一路没有实质产出时,上一条重连记录同样不能停在"结果未回填":
      // 成功路径已在产出事件里 settle 成 succeeded(此处 no-op),走到这里就是没产出。
      autoResumeBookkeeping.settleOutcome(session.id, 'failed');
      const isSilentStopDone = (event.data as { silentStop?: boolean } | null | undefined)?.silentStop === true;
      // silent-stop done:自动续跑会在 1.5s 后启动新 turn(或弹耗尽横幅),
      // 不标 idle/不触发 goal idle/不通知 coordinator done——避免 renderer
      // 在 500ms 完成去抖窗口内显示假完成通知,下一个 turn 开始后又跳回 running。
      if (!isSilentStopDone) {
        // 兜底: 有些 vendor 的 done 不必先发 status:isRunning=false。
        // 但 idle 恢复不能挡在 EVENT broadcast 前，否则隐藏窗口可能在 done
        // 还没进入 renderer 时就重新被 Chromium 节流。
        shouldMarkTurnTerminalIdleAfterBroadcast = true;
        agentInputCoordinatorHolder?.onTurnEvent(session.id, 'done');
        // #9 idle 兜底:turn 收尾后让 goal controller 决定是否补一轮(无 goal/非 active 时 no-op)。
        goalIdleObserver?.(session.id);
      } else {
        // silent-stop 自动续跑:translator 判定本 turn 被上游空内容消息静默收尾时在
        // done.data 附加 silentStop 标记(见 maker-core translator)。延迟一拍再决策,
        // 让本次 turn-end 的落库/收口先走完,也给"用户恰好自己发了消息"留出让位窗口
        //(守卫内部还有 doneAt 陈旧判定,双保险,绝不插队)。
        // 回拨 in-turn 状态:translator 在 done 之前推了 status(isRunning=false),
        // 那条事件已经把 tracker 标成 idle。恢复 in-turn 让 renderer 在 1.5s 决策
        // 窗口内不触发 500ms 完成去抖的假通知。settleSilentStopDone / 新 turn 的
        // noteTurnStarted 会再正确设置最终状态。
        sessionTurnActivityTracker.setSessionInTurn(session.id, true);
        // 后台活动检测:silent-stop 决策窗内逻辑 turn 仍在继续,同步回拨。
        noteClaudeSessionTurnState(session.id, true);
        const silentStopDoneAt = Date.now();
        const silentStopTurnOrigin = event.turnOrigin;
        setTimeout(() => {
          void handleSilentStopTurnEnd(session, silentStopDoneAt, silentStopTurnOrigin);
        }, 1_500);
      }
    }
    // 提前声明在终止型 error 块与 done/terminal 边界块两处均需使用的持久化条件标志。
    let isPlannedUpgradeClose = false;
    let isRemoteAuthRetry = false;
    if (isTerminalTurnErrorEvent(event)) {
      // **任何**终态失败都先把上一条重连记录钉成失败 —— 不管这次错误本身是否值得自愈。
      // 只在"命中白名单、准备再接管"时才 settle 的话,非白名单的终态(认证 / 计费 /
      // invalid-request)会让记录悬空,随后一个无关 turn 的首个产出事件就把它标成
      // 「已重新连接」(codex P1)。
      autoResumeBookkeeping.settleOutcome(session.id, 'failed');
      // 终止型 error 可能没有后续 status/done（SDK/event loop crash 等），需要在
      // EVENT broadcast 后结束逻辑 turn，并保留 terminal grace 给 renderer 收尾；
      // 可重试 error 保持 running。
      shouldMarkTurnTerminalIdleAfterBroadcast = true;
      if (event.source === 'claude-code' || event.source === 'codex' || event.source === 'pi') {
        turnModelPromiseBySession.delete(session.id);
      }
      const errData = attributedEvent.type === 'error'
        ? (attributedEvent.data as
            | { message?: unknown; reason?: unknown; sdkError?: unknown; errorStatus?: unknown }
            | undefined)
        : undefined;
      // 计划内 cc-mgr 升级窗口的 daemon 关闭(reason='remote_daemon_closed')是
      // 预期噪音: renderer 事件路径按同语义静默 banner, 这里同样不给 coordinator
      // 记 error —— 否则 paired-done 保留会让升级后的 projection 复现
      // [REMOTE_DAEMON_CLOSED] banner。范围与 renderer 一致**按 session**(仅
      // banner-clicker):同 host 其它会话的中断照真实失败浮现;窗口外的 daemon
      // 死亡同样不受影响(保留 + 通知)。
      isPlannedUpgradeClose =
        errData?.reason === 'remote_daemon_closed' &&
        isCcMgrUpgradeInFlight(session.id);
      // Legacy CC/XD 远程 auth 错误跳过持久化：renderer 会静默 auto-retry（makerChatStore 在 reducer
      // 前拦截、关闭旧会话、重发消息，不显示 ErrorBanner）；若 main 已落库，retry 成功后
      // 重开会话会看到虚假错误卡。判定与 renderer 的 isAuthError 保持一致，覆盖
      // sdkError === 'authentication_failed' 以及 message 命中 authentication_error /
      // invalid api key / 401 的情形。本地会话（无 remoteHostId）无 auto-retry，不跳过。
      isRemoteAuthRetry = isRemoteAuthRetryErrorEvent(session, event);
      if (!isPlannedUpgradeClose) {
        agentInputCoordinatorHolder?.onTurnEvent(
          session.id,
          'error',
          typeof broadcastEvent.data === 'object' &&
            broadcastEvent.data !== null &&
            typeof (broadcastEvent.data as { message?: unknown }).message === 'string'
            ? (broadcastEvent.data as { message: string }).message
            : undefined,
          // 结构化信号:自动续跑的判据靠它们收紧(见 isInterruptedTurnError),不靠文本猜。
          {
            ...(typeof errData?.sdkError === 'string' ? { sdkError: errData.sdkError } : {}),
            ...(typeof errData?.reason === 'string' ? { reason: errData.reason } : {}),
            ...(typeof errData?.errorStatus === 'number'
              ? { errorStatus: errData.errorStatus }
              : {}),
          },
        );
      }
    }
    // F1-a Phase 2: assistant 文本持久化收口 main 单点(根除多窗各落一份的重复)。
    // 在 onEvent 同步路径只做 O(1):为在飞 assistant 分配 / 复用 persistId、累积全文,
    // 把 persistId 盖进广播 payload 让 renderer 在途气泡用同一 id;真正落库走模块内
    // 异步队列、不在此同步执行(规则19 热路径)。其它消息类型的 persistId 暂为
    // undefined,renderer 继续走原逻辑(后续 Phase 收口 tool_use / tool_result 等)。
    const eventAgentMeta = (event as { agentMeta?: AgentMeta | null }).agentMeta ?? null;
    // 跟踪会话最近一次非空 agentMeta(镜像 renderer state.lastAgentMeta),给 interaction
    // 边界 flush 当兜底锚点,保 agent_meta 不丢(rewind/fork)。
    if (eventAgentMeta) noteAgentMeta(session.id, eventAgentMeta);
    let persistId: string | undefined;
    // tool_result 家族:main 解析出的权威内容,盖进 payload 让 renderer 即时显示
    // (Option C:内容重排状态机只在 main 一份,与落库同源同值)。
    let resolvedContent: string | undefined;
    // 中断自愈的额度判据是「是否在推进」:模型产出了实质内容(文本 / 工具调用)就把
    // 连续失败计数归零,于是只要任务还在往前走,自愈次数不设上限;连续 N 次重连都
    // 产出不了任何东西才停下等人(见 interruptedTurnAutoResume.ts 的额度模型)。
    // 刻意只认这两类事件:thinking / status / 空消息都不算产出;guard 侧是 O(1)、
    // 无 IO、无日志,放在热路径安全。
    if (isSubstantiveProgressEvent(event)) {
      interruptedTurnAutoResumeGuard.noteProgress(session.id);
      // 同一个信号也是「上一次重连真的成功了」的唯一证据 → 回填结果。
      autoResumeBookkeeping.settleOutcome(session.id, 'succeeded');
    }
    if (event.type === 'text') {
      const td = event.data as { text?: unknown; isFinal?: unknown } | null;
      if (typeof td?.text === 'string') {
        orcaTeamServiceForEvents?.captureWorkerText(session.id, td.text, {
          isFinal: td.isFinal === true,
        });
      }
      persistId = onAssistantTextEvent(
        session.id,
        event.data as { text?: unknown; isFinal?: unknown },
        eventAgentMeta,
      );
    } else if (event.type === 'tool_use') {
      // tool_use 边界:先 flush 在飞 assistant(保证 assistant 行先于其 tool_use 入队
      // 落库),再落 tool_use 本身,拿回 persistId 盖进 payload。两者都只入队、不阻塞。
      flushAssistantBlock(session.id, eventAgentMeta);
      persistId = onToolUseEvent(
        session.id,
        event.data as { toolUseId?: unknown; toolName?: unknown; input?: unknown },
        eventAgentMeta,
      );
    } else if (event.type === 'tool_result') {
      const r = onToolResultEvent(
        session.id,
        event.data as { summary?: unknown; toolUseIds?: unknown },
        eventAgentMeta,
      );
      persistId = r?.persistId;
      resolvedContent = r?.content;
    } else if (event.type === 'tool_result_full') {
      const r = onToolResultFullEvent(
        session.id,
        event.data as { toolUseId?: unknown; fullText?: unknown },
        eventAgentMeta,
      );
      persistId = r?.persistId;
      resolvedContent = r?.content;
    } else if (event.type === 'thinking') {
      // thinking final/redacted 落库收口 main;clientId=blockId(renderer 同源),无需
      // persistId 回传。start/delta 不落库。
      onThinkingEvent(
        session.id,
        event.data as { stage?: unknown; blockId?: unknown; text?: unknown; durationMs?: unknown },
        eventAgentMeta,
      );
    }
    // 先 broadcast 保 UI 实时性,再 flush(flush 只入队、不阻塞)。
    // Keep the raw event for main-side coordination/persistence, but only
    // cross renderer/device-link boundaries with the redacted copy.
    broadcastToAllWindows(MAKER_PUSH.EVENT, {
      sessionId: session.id,
      event: broadcastEvent,
      persistId,
      resolvedContent,
    });
    handleAgentIslandEventAfterBroadcast(session, broadcastEvent);
    if (shouldMarkTurnTerminalIdleAfterBroadcast) {
      sessionTurnActivityTracker.scheduleIdleAfterTerminalBroadcast(session.id);
      // 后台活动检测:done / 终止型 error = 逻辑 turn 结束,记录结束时刻。
      // 此后若该会话进程仍有 API 流量(后台子 agent),record 路径会点亮横幅。
      noteClaudeSessionTurnState(session.id, false);
      // turn 收尾打标(last_turn_ended_at)不在此处:done / terminal error 的本 turn
      // 持久化(assistant flush / orphan tool_result / error 行)在下方 flush 块才
      // 入队,统一在那之后走 markTurnEndedAfterPersistDrain(见该 helper 注释)。
      // turn 边界(done / 终止型 error):必须在 tracker 标 idle **之后**再兑现本会话的
      // 延迟凭证切换、唤醒被本会话挡住的等待者 —— vendor 可能不发前置 status:false,
      // 提前唤醒会让 apply/重试读到 isSessionInTurn=true 而空转,退化到 10s 兜底
      // (review P2 2026-07-04)。apply 内部串行 + 幂等,fire-and-forget 安全;
      // planned upgrade close 等场景多唤一次也只是 no-op。
      settlePendingCredentialSwitch(session.id, `event:${event.type}`);
      deferredCodexRestartHolder?.onSessionSettled();
      agentInputCoordinatorHolder?.onExternalTurnSettled(session.id);
      refreshRemoteCodexMcpOnTurnSettledHolder?.(session.id);
    } else if (shouldMarkTurnStatusIdleAfterBroadcast) {
      sessionTurnActivityTracker.scheduleIdleAfterStatusBroadcast(session.id);
      // status:isRunning=false 即逻辑 turn 结束(可重试 error 不发这个信号)。
      markTurnEndedAfterPersistDrain(session.id);
      noteClaudeSessionTurnState(session.id, false);
    }
    if (event.type === 'done') {
      void gitSnapshotCoordinator?.onTurnEnd(session.id);
    }
    if (isTerminalTurnErrorEvent(event)) {
      gitSnapshotCoordinator?.onTurnAbort(session.id);
    }
    // done / 终止型 error 持久化边界:把在飞 assistant 落库(与 text isFinal 互斥幂等)。
    // tool_use 边界的 flush 已在上面 broadcast 前做(需先于 tool_use 落库);
    // ask_user / plan_review / permission 不走 onEvent(走 interaction listener),
    // 它们的 flush 在 setInteractionListener 里。
    //
    // 可重试 error 仍属于同一 turn，不能 reset lastAgentMeta / tool_result 配对状态；
    // 否则未来出现 turn 中途的非终止型 error 时会打断后续 tool_result 关联。
    // 本 turn 最后一条 assistant 的 persistId(挂 per-turn 费用 / turn 边界用)。terminal
    // error 同样 consume，写失败 seal 后再按需交接给 paired done；纯 tool 轮为 undefined。
    let turnAssistantPersistId: string | undefined;
    let turnBoundaryAssistantPersistId: string | undefined;
    let isPairedFailedTurnDone = false;
    if (event.type === 'done' || isTerminalTurnErrorEvent(event)) {
      flushAssistantBlock(session.id, eventAgentMeta);
      turnAssistantPersistId = consumeLastAssistantPersistId(session.id);
      turnBoundaryAssistantPersistId = consumeLastTopLevelAssistantPersistId(session.id);
      if (isTerminalTurnErrorEvent(event) && event.type !== 'done') {
        // 失败 turn: 记账发生在稍后的配对 done(usage 在那条事件上), 把这里
        // consume 到的 persistId 交接过去(见 pendingFailedTurnAssistantPersistId)。
        if (turnAssistantPersistId) {
          pendingFailedTurnAssistantPersistId.set(session.id, turnAssistantPersistId);
        }
      } else {
        // done: 优先本事件 consume 的 id, 失败 turn 场景回收交接的 id;
        // 无论用没用到都清掉, 防残留错配下一轮。
        const pendingFailedPersistId = pendingFailedTurnAssistantPersistId.get(session.id);
        if (!turnAssistantPersistId && pendingFailedPersistId) {
          turnAssistantPersistId = pendingFailedPersistId;
          isPairedFailedTurnDone = true;
        }
        pendingFailedTurnAssistantPersistId.delete(session.id);
      }
      flushOrphanToolResults(session.id, eventAgentMeta);
      if (turnBoundaryAssistantPersistId) {
        // 在同一 durable FIFO 内先盖 turn seal、再复用 local-db:messages:created 广播
        // 更新后的完整行。失败轮的 paired done 只复用 id 做 usage 记账，不能把
        // terminal error 已写的 false seal 覆盖成 true、让施工播报重新进入标题素材。
        if (event.type !== 'done') {
          void markAssistantTurnFailed(session.id, turnBoundaryAssistantPersistId);
        } else if (!isPairedFailedTurnDone) {
          void markAssistantTurnCompleted(session.id, turnBoundaryAssistantPersistId);
        }
      }
      // error 行在 flushOrphanToolResults 之后入队,保证 orphan tool_result 排在
      // error 行之前(历史时间线:tool 输出 → 错误卡,而非错误卡插到 tool 输出之前)。
      // 自愈接管中 → 压住 error 行:成功续跑时历史里只留一条「已自动继续」分隔条,
      // 救不回来时由 AutoResumeBookkeeping.finalizeSuppressedError 补落。判据取 coordinator 的实时
      // 接管态(而非 host 自己的 map):退避期间用户若自己发了消息,接管态已被清,那之后
      // 新 turn 的失败必须照常落库。
      //
      // 还有一种时序:terminal error 早于用户气泡落库完成到达时,接管决策要推迟到
      // settlePendingTerminalEventAfterPersist 才能做(recovery 留不留得住是前提)。那时
      // error 行早就落库了、压不回去,接管成功后历史里会同时留下错误卡与重连行(codex P1)。
      // 所以决策未定时也一并压住(isAutoResumeDeferred),由 coordinator 在三个「最终没接管」
      // 的出口回调 onResumableTurnErrorDiscarded 让它补落。
      const autoResumeSuppressesPersist =
        event.type === 'error' &&
        (agentInputCoordinatorHolder?.isAutoResumePending(session.id) === true ||
          agentInputCoordinatorHolder?.isAutoResumeDeferred(session.id) === true);
      if (
        event.type === 'error' &&
        !isPlannedUpgradeClose &&
        !isRemoteAuthRetry &&
        !autoResumeSuppressesPersist
      ) {
        onTurnErrorEvent(
          session.id,
          attributedEvent.data as {
            message?: unknown;
            reason?: unknown;
            sdkError?: unknown;
          } | null,
          eventAgentMeta,
        );
      }
      // 压住的错误详情必须在这里存一份:决策推迟场景下 onResumableTurnError 还没被调用过
      // (它自己那份 set 发生在接管成立时),不存就无从补落。同 clientId 内容,覆盖无害。
      if (autoResumeSuppressesPersist) {
        autoResumeBookkeeping.stashSuppressedError(session.id, attributedEvent.data);
      } else if (event.type === 'error' && isTerminalTurnErrorEvent(event)) {
        // replacement 可在 sendToAgent 返回前同步失败并让 coordinator 的 activeTurn
        // 失效；这个新终态已经取代旧中断，按 dispatch phase 直接清旧 owner。
        autoResumeBookkeeping.discardReplacementProvenByProviderEvent(session.id);
      }
      // deferred 路径保存 turn 开始时刻:isRemoteAuthRetry 时 onTurnErrorEvent 被跳过，
      // renderer 会稍后调 persistTurnErrorDeferred IPC。在 resetTurnPersistState 清掉
      // _turnStartedAtBySession 之前保存一份，让 deferred 路径能正确做 /clear 竞态 cap。
      // 自愈压住 error 行时同理:补落发生在 resetTurnPersistState 之后(退避 3–20 秒,
      // 或决策推迟的那一小段),不先存一份会让 /clear 竞态 cap 判错。
      if (event.type === 'error' && (isRemoteAuthRetry || autoResumeSuppressesPersist)) {
        saveTurnStartedAtForDeferred(session.id);
      }
      // turn 收尾打标:本 turn 已知持久化(assistant flush / orphan tool_result /
      // error 行)已全部入队,在此统一定格并等排空后写。done 与 terminal error
      // 同一规则(planned upgrade close / remote auth retry 分支无 error 行,
      // drain 同样无害)。
      markTurnEndedAfterPersistDrain(session.id);
      resetTurnPersistState(session.id);
      // sidebar-card-mode: 摘要触发挪到本轮 assistant 块 flush 入队之后(原先在
      // done 早段、flush 之前触发,流式轮次会读到上一轮文本)。只在正常 done 触发。
      // codex review:flushAssistantBlock 仅把 assistant insert 入队 writeChain、未落库,
      // latestMessageText 立刻读库可能读到本轮 assistant 写入之前的旧状态;先 await
      // drainPersistQueue() 等持久化队列排空,确立"读在写后"的边界,再起摘要。
      if (event.type === 'done') {
        void (async () => {
          await drainPersistQueue();
          // force:turn-done 是权威刷新点(本轮 assistant 已落库),必须以最新内容覆盖
          // 任何 pin 触发 / 上一轮残留的摘要——绕过 in-flight 早返与 20s 节流
          // (codex review:pin during running turn 会让卡片停在部分/旧摘要)。
          await maybeGenerateSessionTaskSummary(session.id, { force: true });
        })();
      }
      // will-assistant-message 出口钩子(先定案 → 一拍后替换):仅 done(非终止
      // error)、有真实回复文本 + 已落库的 assistant persistId + 有启用的出口钩子
      // 意识时,派一个独立异步续跑跑裁决并原地更新那条消息(rewrite 换文本 /
      // render 换自绘卡)。同步守卫 hasEnabledGhostAssistantHook 保证无此类意识时
      // 不 schedule —— 与今天行为逐字节一致,零额外开销(规则 10 不碰热路径)。
      if (event.type === 'done' && turnAssistantPersistId) {
        const doneResult = (event.data as { result?: unknown } | null)?.result;
        const replyText = typeof doneResult === 'string' ? doneResult : '';
        if (replyText.length > 0 && hasEnabledGhostAssistantHook()) {
          runGhostAssistantReplyHook(session.id, turnAssistantPersistId, replyText);
        }
      }
      // Worker turn 结束后交给 OrcaTeamService 处理 DB status、广播与 auto-bridge。
      void (async () => {
        try {
          const doneData = event.data as { result?: unknown } | null;
          const finalText = typeof doneData?.result === 'string' && doneData.result.length > 0
            ? doneData.result
            : '';
          await workerTurnStartSequencer.waitForStart(session.id);
          await orcaTeamServiceForEvents?.handleWorkerTerminalTurn({
            sessionId: session.id,
            status: isTerminalTurnErrorEvent(event) ? 'error' : 'done',
            finalText,
          });
        } catch { /* non-fatal */ }
      })();
    }
    if (pendingContextSnapshot) {
      recordSessionContextSnapshot(
        session.id,
        pendingContextSnapshot.contextTokens,
        pendingContextSnapshot.contextWindow,
      );
    }
    if (pendingCodexAccountUsageSnapshot) {
      recordCodexAccountUsageSnapshot(pendingCodexAccountUsageSnapshot);
    }
    // 每 turn 结束累加 daily_spend 表 + 广播给 renderer 右下角"今日 $X.XX" chip。
    // 这些统计 side effect 必须在 EVENT broadcast 之后，避免同步 SQLite 或额外
    // usage 广播延后 final/done 送达。
    //
    // 本轮费用 = HYBRID 定价: Anthropic 模型信任 SDK 自报 cost (OAuth 下=0、API 下=真实、
    // cache-correct), 非 Anthropic provider 模型 (gpt-5.5 等) 用远端 gateway 价 × token
    // 重算 —— 修 SDK 把它们按 Anthropic 价错算 (~2.5x) 的 bug。逐模型解析后四个 sink
    // (今日 / session / per-message / 按模型) 同源同值。
    // 守卫: index.ts:388 stream_end fallback / codex done 不带 total_cost_usd, typeof 检查会跳过。
    if (event.type === 'done' && event.source === 'claude-code') {
      const modelPromise = turnModelPromiseBySession.get(session.id) ?? readSessionModelForUsage(session.id);
      turnModelPromiseBySession.delete(session.id);
      const doneData = event.data as {
        total_cost_usd?: unknown;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        modelUsage?: Record<string, unknown>;
      } | undefined;
      const cumulative = doneData?.total_cost_usd;
      const modelUsage = doneData?.modelUsage;
      let modelUsageDeltas: ModelUsageDeltaEntry[] | undefined;
      if (modelUsage && typeof modelUsage === 'object') {
        const { next, deltas } = computeModelUsageDeltas(
          lastReportedModelUsageBySession.get(session.id),
          modelUsage,
        );
        lastReportedModelUsageBySession.set(session.id, next);
        modelUsageDeltas = deltas;
      }
      // total_cost_usd 累计基线: 主路径不靠它算钱, 但仍跟住, 以便万一某轮缺 modelUsage
      // 走兜底时累计差才准。先取"更新前"基线给兜底用, 再写入本轮累计。
      const prevReportedCost = lastReportedCostUsdBySession.get(session.id) ?? 0;
      if (typeof cumulative === 'number' && cumulative >= 0) {
        lastReportedCostUsdBySession.set(session.id, cumulative);
      }
      // 模型降级检测:所选模型(turn start 快照)整轮缺席于实际 modelUsage delta →
      // 判定主线被上游静默替换(如 fable-5 高负载被路由到 opus-4-8),把标记挂到本轮
      // 收尾 assistant 的 agent_meta 上(AssistantMessage 渲染降级提示行)。
      // fire-and-forget,与记账 sink 互不阻塞;判定纯函数见 shared/modelMismatch.ts。
      if (modelUsageDeltas && detectOutputLag(modelUsageDeltas)) {
        // 上游在 done 时点还没结算本轮输出(实测 Vertex),这一轮的费用会偏低、下一轮偏高。
        // 总量不丢,只是归属错位;不做纠正的理由见 usage/modelUsageDelta 文件头。
        log.warn(
          `turn output likely lagging upstream settlement (session=${session.id}): ` +
            modelUsageDeltas
              .map(
                (d) =>
                  `${d.model} out=${d.outputTokensDelta} in=${d.inputTokensDelta} ` +
                  `cacheRead=${d.cacheReadTokensDelta} cacheCreate=${d.cacheCreateTokensDelta}`,
              )
              .join('; '),
        );
      }
      if (turnAssistantPersistId && modelUsageDeltas && modelUsageDeltas.length > 0) {
        const mismatchClientId = turnAssistantPersistId;
        const actualEntries = modelUsageDeltas.map((d) => ({
          model: d.model,
          outputTokens: d.outputTokensDelta,
        }));
        void modelPromise
          .then((selectedModel) => {
            const mismatch = detectClaudeModelMismatch(selectedModel, actualEntries);
            if (mismatch) {
              return recordModelMismatchOnMessage({
                sessionId: session.id,
                clientId: mismatchClientId,
                mismatch,
              });
            }
          })
          .catch(() => { /* 模型解析失败:跳过降级检测,非致命 */ });
      }
      if (modelUsageDeltas && modelUsageDeltas.length > 0) {
        // 主路径: 逐模型 HYBRID 定价 (Anthropic→SDK, 非 Anthropic→gateway), 四个 sink
        // 由同一份解析结果驱动。价格表走 main 端内存 + 磁盘缓存, stale 快返并后台刷新。
        const deltas = modelUsageDeltas;
        void (async () => {
          const sessionProviderForBilling = getSessionProvider(session.id);
          const observedClaudeRoute =
            sessionProviderForBilling == null ? readClaudeSessionRoute(session.id) : null;
          const explicitProviderBillingRoute = billingRouteForExplicitProvider(
            sessionProviderForBilling,
            sessionProviderForBilling
              ? getActiveCatalog().providers.find(
                  (provider) => provider.id === sessionProviderForBilling,
                )?.access?.kind
              : null,
          );
          const isClaudeSubscriptionSession = !session.remoteHostId && (
            sessionProviderForBilling === 'anthropic'
            || (
              sessionProviderForBilling == null
              && (observedClaudeRoute != null
                ? observedClaudeRoute === 'subscription'
                : !readClaudeApiKey())
            )
          );
          const billingRoute: BillingRoute = session.remoteHostId
            ? 'unknown'
            : isClaudeSubscriptionSession
              ? 'subscription'
              : explicitProviderBillingRoute
                ?? (observedClaudeRoute === 'gateway' ? 'xd-gateway' : 'unknown');
          const pricing =
            billingRoute === 'xd-gateway'
              ? await getModelPricingForModel(
                  'xd',
                  normalizeModelIdForPricing(deltas[0]?.model),
                )
              : await getModelPricing();
          const { turnMoney, estimatedTurnMoney, perModel } = resolveClaudeTurnCostSinks(
            deltas,
            pricing,
            {
              providerId: sessionProviderForBilling,
              billingRoute,
              region: CURRENT_CINDY_REGION,
            },
          );
          // 按模型记账 (首页仪表盘"按模型拆分"): 写归一化裸 id, 与 codex 行 / 价格表对齐。
          // 订阅轮打 #billing=subscription 标记(Claude 订阅:Anthropic 模型 + cost=0),
          // 或 bridge 订阅轮(chatgpt// xai/ 前缀,source==='subscription');两类均需触发
          // rebroadcastTodaySpend 刷新首页仪表盘。
          const modelUsageWrites: Promise<unknown>[] = [];
          let hasSubscriptionValueRow = false;
          for (const m of perModel) {
            const isClaudeSubscriptionValueRow =
              isClaudeSubscriptionSession && !m.money && isAnthropicModel(m.model);
            const isBridgeSubscriptionRow =
              m.source === 'subscription' && isSubscriptionDirectModel(m.model);
            if (isClaudeSubscriptionValueRow || isBridgeSubscriptionRow) hasSubscriptionValueRow = true;
            modelUsageWrites.push(recordModelTurnUsage({
              agentKind: 'claude-code',
              model: isClaudeSubscriptionValueRow ? claudeSubscriptionUsageModelKey(m.model) : m.model,
              // daily_model_usage does not persist RegionalMoney.kind. Keep reference estimates
              // out of this actual-cost row so they cannot be reconstructed as real API spend.
              money: m.money?.kind === 'actual-cost' ? m.money : null,
              inputTokensDelta: m.deltas.inputTokens,
              outputTokensDelta: m.deltas.outputTokens,
              cacheReadTokensDelta: m.deltas.cacheReadTokens,
              cacheCreateTokensDelta: m.deltas.cacheCreateTokens,
            }));
          }
          // 无真实费用、但产生订阅价值或 provider 参考估值的轮次不走
          // recordTurnSpend。等模型行落库后重广播今日 spend 快照,通知已打开的首页
          // 仪表盘刷新(对齐 codex 订阅轮的 rebroadcastCodexTodayUsage)。
          if ((hasSubscriptionValueRow || estimatedTurnMoney) && !turnMoney) {
            void Promise.allSettled(modelUsageWrites).then(() => rebroadcastTodaySpend());
          }
          if (turnMoney && turnMoney.amount > 0) {
            // 保留 #216 的 token/cache 明细随费用落库 (MessageActionBar tooltip)。
            // deltas 非空 → buildClaudeTurnUsageDetails 用 deltas 里的 model, fallbackModel 不取用。
            // 传 perModel → 落「按模型成本明细」(含 subagent 跑的模型, 如 Haiku)。
            const turnUsageDetails = buildClaudeTurnUsageDetails(doneData?.usage, deltas, 'unknown', perModel);
            recordTurnSpend(turnMoney);
            recordSessionTurnSpend(session.id, turnMoney);
            // per-message 维度优先挂 assistant；纯 tool turn 则按 scheduler runId 直接归因。
            const changedScheduleId = await recordSchedulerTurnCost({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              money: turnMoney,
              turnUsageDetails,
              turnOrigin: event.turnOrigin,
            });
            if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
          } else if (turnAssistantPersistId) {
            // 无真实计费轮的「本轮价值」估算,挂到消息(isEstimate:true,chip 的
            // "本会话价值"由 useSessionEstimatedValue 汇总),不进 daily_spend /
            // sessions.total_cost_usd(那些是真实账单)。provider 参考价与两类订阅估值
            // 可叠加(如 Claude 订阅主会话 + bridge 订阅子 agent):
            //   - provider-api 参考价:远程目录中的公开参考价,不是供应商真实账单;
            //   - bridge 订阅模型(chatgpt/ / xai/,source==='subscription'):静态参考价折算;
            //   - Claude 订阅会话(显式选 Anthropic,SDK 自报 cost=0):Anthropic 牌价折算
            //     (纯 Anthropic 轮 pricing 为 null → 家族牌价兜底表,不为估值发起网络请求)。
            // 混合轮(真实计费 > 0)走上面的真实分支,订阅部分不另挂估算 —— 一条消息只有一个
            // cost 字段,真实计费优先;订阅 token 明细仍在 turnUsageDetails.perModelCost 里。
            const estimatedValues: RegionalMoney[] = estimatedTurnMoney
              ? [estimatedTurnMoney]
              : [];
            for (const m of perModel) {
              if (m.source !== 'subscription') continue;
              const quote = getSubscriptionDirectValuePrice(m.model, 'claude-code', pricing);
              const value = computePriceQuoteTurnMoney(
                m.deltas,
                quote ?? undefined,
                currentLedgerCurrency(),
              );
              if (value?.amount) estimatedValues.push(value);
            }
            if (isClaudeSubscriptionSession) {
              const claudeEstimated = estimateClaudeSubscriptionTurnValue(
                perModel,
                currentLedgerCurrency(),
                await getModelPricing(),
              );
              if (claudeEstimated?.amount) estimatedValues.push(claudeEstimated);
            }
            const turnEstimatedValue =
              estimatedValues.length > 0
                ? addRegionalMoney(estimatedValues)
                : null;
            const turnUsageDetails = buildClaudeTurnUsageDetails(doneData?.usage, deltas, 'unknown', perModel);
            if (turnEstimatedValue && turnEstimatedValue.amount > 0) {
              const changedScheduleId = await recordSchedulerTurnCost({
                sessionId: session.id,
                clientId: turnAssistantPersistId,
                money: turnEstimatedValue,
                turnUsageDetails,
                turnOrigin: event.turnOrigin,
              });
              if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
            } else {
              // 真实计费与订阅估值都拿不到(典型:网关目录整体不下发价格、模型不在价表)
              // —— 钱没有,但 token 明细是算好的,落下来让 UI 退回显示本轮 token。
              await recordTurnUsageOnMessage({
                sessionId: session.id,
                clientId: turnAssistantPersistId,
                turnUsageDetails,
              });
            }
          }
        })();
      } else if (typeof cumulative === 'number' && cumulative >= 0) {
        // 窄兜底: 罕见地 done 只带 total_cost_usd、没 modelUsage —— 拆不了 daily_model_usage,
        // 但至少用累计差把总额 / session / message 记上, 别漏整轮 (review #4)。
        const rawDelta = Math.max(0, cumulative - prevReportedCost);
        void (async () => {
          let resolvedModel = 'unknown';
          try {
            const model = await modelPromise;
            resolvedModel = model;
          } catch { /* non-fatal: 保留 SDK 原始 cost */ }
          const turnUsageDetails = buildClaudeTurnUsageDetails(doneData?.usage, undefined, resolvedModel);
          // 本分支有三个"记不了钱"的出口(本轮 cost 未增长 / 订阅直连 / 订阅与网关路由),
          // 账本口径一个字不改,但都把本轮 token 明细落下来 —— 钱算不出来不代表用量
          // 算不出来,UI 那一格据此退回显示 token 而不是空着。
          const recordUsageOnly = async () => {
            if (!turnAssistantPersistId) return;
            await recordTurnUsageOnMessage({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              turnUsageDetails,
            });
          };
          if (rawDelta <= 0) {
            await recordUsageOnly();
            return;
          }
          const providerId = getSessionProvider(session.id);
          const observedRoute =
            providerId == null ? readClaudeSessionRoute(session.id) : null;
          const explicitProviderRoute = billingRouteForExplicitProvider(
            providerId,
            providerId
              ? getActiveCatalog().providers.find((provider) => provider.id === providerId)
                  ?.access?.kind
              : null,
          );
          const route: BillingRoute = session.remoteHostId
            ? 'unknown'
            : providerId === 'anthropic' || observedRoute === 'subscription'
              ? 'subscription'
              : explicitProviderRoute
                ?? (observedRoute === 'gateway' ? 'xd-gateway' : 'unknown');
          // 订阅直连轮(chatgpt/ / xai/)走窄兜底时: 真实计费恒 0, 不写 daily_spend /
          // sessions.total_cost_usd(与主路径 resolveTurnCost 的 subscription gate 同口径,
          // 避免把订阅 SDK 自报 cost 误记进计费)。但显式 provider-api 是权威路由:
          // 自定义 API 供应商可能供应带订阅前缀的模型 id,不能按前缀把真实费用判掉。
          if (route !== 'provider-api' && isSubscriptionDirectModel(resolvedModel)) {
            await recordUsageOnly();
            return;
          }
          if (route === 'subscription' || route === 'xd-gateway') {
            await recordUsageOnly();
            return;
          }
          const ledgerCurrency =
            (await getGatewayAccountCurrency()) ?? currentLedgerCurrency();
          const money = usdToLedgerCurrency(rawDelta, ledgerCurrency);
          recordTurnSpend(money);
          recordSessionTurnSpend(session.id, money);
          const changedScheduleId = await recordSchedulerTurnCost({
            sessionId: session.id,
            clientId: turnAssistantPersistId,
            money,
            turnUsageDetails,
            turnOrigin: event.turnOrigin,
          });
          if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
        })();
      }
      // 与 spend 记账并列的另一个 turn-done side-effect: 刷新 Claude 账号月度配额
      // (LiteLLM /v2/user/info)。fire-and-forget, 模块内 2s 超时 + 10s 节流。
      // 故意放在 cumulative 块外面: spend 走 turn delta, 配额走 HTTP API, 两件事独立;
      // 但仍在 done && claude-code 的 if 内, 不要每个事件都打一次。
      void triggerClaudeAccountUsageRefresh();
      // chatgpt/ 订阅轮: 额外触发 ChatGPT wham 额度刷新(与 codex 同一 ChatGPT 账户),让底部
      // chip 的订阅额度实时更新 —— bridge 轮不产生 codex account_usage 事件,须主动触发。
      void modelPromise
        .then((m) => { if (m && m.startsWith(CHATGPT_MODEL_PREFIX)) triggerCodexAccountUsageRefresh(); })
        .catch(() => { /* 模型解析失败: 跳过, 非致命 */ });
      // Claude 订阅账号余量 (oauth/usage 端点) 同理 turn-done 触发一次 —— 节流 (180s) /
      // 429 退避 / 未连订阅 no-op 都在 reader 内部; turn 内的实时刷新由 proxy 旁路读
      // unified headers 兜住, 这里只负责把 scoped 分模型窗口等端点独有数据拉新。
      triggerClaudeSubscriptionUsageRefresh();
    }
    // Codex done 事件: 记 today token 累计 (替代老 registerCodexIpc 里的 recordCodexTurnUsage 接入点)。
    // codex/index.ts 在 turn.completed 时把 SDK usage 翻成 camelCase 塞进 done.data.usage, 这里直接转给 broadcaster。
    // Codex SDK 不报 cost, 所以走 token 量(codex chip 显示 "本 session N token"), 跟 Claude 的 $ chip 是两条管道。
    if (event.type === 'done' && event.source === 'codex') {
      // 本会话显式选定的供应商('xd' / 'openai' / null=默认)。退役全局 authMode 后,
      // 「是否走订阅(不计网关费)」改由 spawn 注入 + 该会话是否显式选了 XD 网关决定。
      const sessionProvider = getSessionProvider(session.id);
      const isRemoteCodexSession = Boolean(session.remoteHostId);
      const isCustomProviderRoute =
        !isRemoteCodexSession && isUserProviderSession(session.id);
      const codexAuthInjection = isRemoteCodexSession ? null : getCodexProxyAuthInjection();
      const modelPromise = turnModelPromiseBySession.get(session.id) ?? readSessionModelForUsage(session.id);
      turnModelPromiseBySession.delete(session.id);
      const usage = (event.data as { usage?: unknown } | undefined)?.usage;
      if (usage) recordCodexTurnUsage(usage);
      // 按模型记账: codex done.data.usage 是 **per-turn 增量语义** (maker-core
      // codexDoneUsage 契约: promptTokens=本 turn 未命中输入, completionTokens=输出+推理
      // 合并, cachedTokens=命中缓存; 整 turn 没收到 tokenUsage/updated 时全 0)。
      // 直接入库, 不做 delta 化 —— 历史上 promptTokens 曾是 contextTokens 快照、这里
      // 做过 per-session delta 化, 语义改为 per-turn 后那套逻辑会把后小于前的 turn 记 0。
      if (usage && typeof usage === 'object') {
        const u = usage as { promptTokens?: number; completionTokens?: number; reasoningTokens?: number; cachedTokens?: number };
        const promptTokens = Number(u.promptTokens) || 0;
        const completionTokens = Number(u.completionTokens) || 0;
        const cachedTokens = Number(u.cachedTokens) || 0;
        void recordSessionTurnTokens(
          session.id,
          promptTokens + completionTokens + cachedTokens,
        );
        // 先落 daily_model_usage token 行, 再等价格表补 API cost。首页 usage push 会在
        // ~2s 后刷新, 不能让冷价格表 / 离线 fetch 把模型 token 行延后到刷新之后。
        // 后续 cost-only 增量不会重复累计 token。
        void (async () => {
          let pricingModel = 'unknown';
          let turnModel = 'unknown';
          try {
            turnModel = await modelPromise;
            // 价格查表用归一化裸 id, 与 daily_model_usage 的 key 一致
            // (codex 当前不带 [1m], 归一化防御未来变体后缀导致查表 miss)。
            pricingModel = normalizeModelIdForPricing(turnModel);
          } catch {
            // 模型读取失败时仍记录 token, 聚合 UI 会归到 unknown。
          }
          const isCodexBudgetRoute =
            (sessionProvider == null || sessionProvider === 'xd')
            && pricingModel.startsWith('codex/');
          const isCodexXaiProviderRoute =
            (sessionProvider == null || sessionProvider === 'xai')
            && pricingModel.startsWith(XAI_MODEL_PREFIX);
          const isCodexOpenAiProviderRoute =
            sessionProvider == null || sessionProvider === 'openai';
          const hasGatewayKey = Boolean(readClaudeApiKey());
          const hasEffectiveGatewayRoute =
            !isRemoteCodexSession &&
            !isCustomProviderRoute &&
            (
              codexAuthInjection === 'env-key' ||
              isCodexBudgetRoute ||
              (sessionProvider === 'xd' && hasGatewayKey)
            );
          // 显式来源的订阅判定以目录 access.kind 为权威(内置 anthropic 的 Claude.ai
          // 订阅同样是订阅价值,不能只认 OpenAI/xAI);目录缺 access 的旧快照仍靠下面
          // 的 openai oauth 分支兜底。
          const sessionProviderAccessKind = sessionProvider
            ? getActiveCatalog().providers.find((provider) => provider.id === sessionProvider)
                ?.access?.kind
            : null;
          const isCodexSubscriptionAccessRoute =
            !isRemoteCodexSession &&
            sessionProvider != null &&
            sessionProvider !== 'xd' &&
            sessionProviderAccessKind === 'subscription' &&
            !hasEffectiveGatewayRoute;
          const isSubscriptionValue = isRemoteCodexSession ||
            isCodexXaiProviderRoute ||
            isCodexSubscriptionAccessRoute ||
            (
              isCodexOpenAiProviderRoute
              && codexAuthInjection === 'oauth-bearer'
              && !hasEffectiveGatewayRoute
            );
          const usesReferencePriceEstimate =
            !isSubscriptionValue &&
            !isRemoteCodexSession &&
            !hasEffectiveGatewayRoute &&
            Boolean(sessionProvider && sessionProvider !== 'xd');
          const modelUsageKey = isSubscriptionValue
            ? codexSubscriptionUsageModelKey(pricingModel)
            : codexApiUsageModelKey(pricingModel);
          await recordModelTurnUsage({
            agentKind: 'codex',
            model: modelUsageKey,
            inputTokensDelta: promptTokens,
            outputTokensDelta: completionTokens,
            cacheReadTokensDelta: cachedTokens,
            cacheCreateTokensDelta: 0,
          }).finally(() => rebroadcastCodexTodayUsage());

          // Codex SDK 不报 $, 用价格表折算。普通模型 + oauth(订阅)显示为 token 价值;api 模式和 codex/
          // 折扣模型走 gateway API, 显示为 API cost。远端 Codex 由远端 daemon
          // 路由,本机不知道远端 OAuth/API 事实,因此只显示 token 价值,不写本地
          // gateway cost。只有真实本地 API cost 写入 sessions.total_cost_usd,
          // 避免 scheduler 的 Cost 汇总混入订阅价值或远端账号消耗。
          // fire-and-forget 不阻塞事件循环;价格表走 main 端内存 + 磁盘缓存,
          // stale 快返并后台刷新,
          // 拉不到 / 模型无条目 → 只落 token 明细,UI 退回显示本轮 token。
          // 明细在 try 外构造:它只依赖上面已拿到的 token 数,价格请求抛错时也要能落。
          const turnUsageDetails = buildTurnUsageDetails({
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            cacheReadTokens: cachedTokens,
            cacheCreateTokens: 0,
            model: turnModel,
          });
          const recordCodexUsageOnly = async () => {
            if (!turnAssistantPersistId) return;
            await recordTurnUsageOnMessage({
              sessionId: session.id,
              clientId: turnAssistantPersistId,
              turnUsageDetails,
            });
          };
          try {
            const pricing = isSubscriptionValue
              ? await getModelPricing()
              : hasEffectiveGatewayRoute
                ? await getModelPricingForModel('xd', pricingModel)
                : usesReferencePriceEstimate
                  ? await getModelPricing()
                  : null;
            // 订阅估值按显式来源取各自的日期定价路由:内置 anthropic 走 Anthropic
            // registry 参考价(含 codex 侧价格覆盖),默认/openai 保持 OpenAI 价表。
            const subscriptionValueProviderId =
              isCodexSubscriptionAccessRoute && sessionProvider != null
                ? sessionProvider
                : 'openai';
            const price = isCodexXaiProviderRoute
              ? getSubscriptionDirectValuePrice(pricingModel, 'codex', pricing)
              : isSubscriptionValue
                ? getCodexProviderSubscriptionValuePrice(
                    subscriptionValueProviderId,
                    pricingModel,
                    pricing,
                  )
                : hasEffectiveGatewayRoute
                  ? getModelPriceQuote(pricing, 'xd', pricingModel)
                  : usesReferencePriceEstimate
                    ? getModelPriceQuote(pricing, sessionProvider, pricingModel, 'codex')
                    : undefined;
            const money = computePriceQuoteTurnMoney(
              codexUsageToTokens(u),
              price ?? undefined,
              currentLedgerCurrency(),
            );
            // Only Gateway sale prices are actual API spend. Third-party/user reference quotes
            // are value estimates and daily_model_usage cannot preserve RegionalMoney.kind, so
            // writing them into #billing=api would later reconstruct an estimate as actual cost.
            if (!isSubscriptionValue && money && price?.source === 'gateway') {
              await recordModelTurnUsage({
                agentKind: 'codex',
                model: modelUsageKey,
                money,
                inputTokensDelta: 0,
                outputTokensDelta: 0,
                cacheReadTokensDelta: 0,
                cacheCreateTokensDelta: 0,
              });
            }
            if (money && money.amount > 0) {
              const isActualApiCost = !isSubscriptionValue && price?.source === 'gateway';
              if (isActualApiCost) {
                void recordTurnSpend(money);
                void recordSessionTurnSpend(session.id, money);
              }
              const changedScheduleId = await recordSchedulerTurnCost({
                sessionId: session.id,
                clientId: turnAssistantPersistId,
                money,
                turnUsageDetails,
                turnOrigin: event.turnOrigin,
              });
              if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
            } else {
              await recordCodexUsageOnly();
            }
          } catch {
            // token row 已在价格请求前落库;价格失败只影响 API cost / message cost。
            // 消息那一格仍要有事实可看:补落一次 token 明细。patch 是 agent_meta merge、
            // 写的又是同一份明细,所以与上面成功分支重复执行也是幂等的(自身失败只 warn)。
            await recordCodexUsageOnly();
          }
        })();
      }
      // 走 gateway/API 口径(同一把 XD key 的 LiteLLM 计费)的 codex turn,done 后刷新账号配额
      // (与 cc 同口径, chip 显示 daily/monthly/key cost)。命中:会话显式选了 XD 网关、无 OAuth
      // token 的 env-key fallback、或 codex/ 预算模型。普通 oauth 订阅没有 $ 配额,不刷。
      void modelPromise
        .then((model) => {
          const hasGatewayKey = Boolean(readClaudeApiKey());
          if (!isRemoteCodexSession &&
            !isCustomProviderRoute &&
            !model.startsWith(XAI_MODEL_PREFIX) &&
            (codexAuthInjection === 'env-key' || model.startsWith('codex/') || (sessionProvider === 'xd' && hasGatewayKey))) {
            void triggerClaudeAccountUsageRefresh();
          }
        })
        .catch(() => {
          if (sessionProvider === 'xd' && readClaudeApiKey()) {
            void triggerClaudeAccountUsageRefresh();
          }
        });
    }
    // Pi done 事件同样携带 per-turn token/cache 明细。Pi 复用 Cindy 的 provider
    // 路由，因此计费形态必须看 session provider，而不是把它当成一个新的计费方：
    //   openai / anthropic / xai → 用户订阅，显示剩余窗口 + 本对话价值；
    //   xd / 默认网关            → 实际 gateway cost。
    // usage 事实无论价格是否可解析都持久化，保证新模型也能看到 cache 命中明细。
    if (event.type === 'done' && event.source === 'pi') {
      const sessionProvider = getSessionProvider(session.id);
      const modelPromise =
        turnModelPromiseBySession.get(session.id) ?? readSessionModelForUsage(session.id);
      turnModelPromiseBySession.delete(session.id);
      const rawUsage = (event.data as { usage?: unknown } | undefined)?.usage;
      if (rawUsage && typeof rawUsage === 'object') {
        const tokens = piUsageToTokens(rawUsage as {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheCreationTokens?: number;
        });
        const totalTokens =
          tokens.inputTokens +
          tokens.outputTokens +
          tokens.cacheReadTokens +
          tokens.cacheCreateTokens;
        void recordSessionTurnTokens(session.id, totalTokens);
        void (async () => {
          let turnModel = 'unknown';
          try {
            turnModel = await modelPromise;
          } catch {
            // 模型读取失败仍持久化 token/cache，模型显示为 unknown。
          }
          const pricingModel = normalizeModelIdForPricing(turnModel);
          const effectiveProvider =
            sessionProvider ??
            (pricingModel.startsWith(CHATGPT_MODEL_PREFIX)
              ? 'openai'
              : pricingModel.startsWith(XAI_MODEL_PREFIX)
                ? 'xai'
                : null);
          const isSubscriptionValue =
            effectiveProvider === 'openai'
            || effectiveProvider === 'anthropic'
            || effectiveProvider === 'xai'
            || isSubscriptionDirectModel(pricingModel);
          const turnUsageDetails = buildTurnUsageDetails({
            ...tokens,
            model: turnModel,
          });

          // Pi 也必须进 daily_model_usage，否则首页仪表盘会把 Pi 的
          // token/cache 全部漏掉。先落 usage 事实，价格解析失败也不影响。
          const modelUsageKey = isSubscriptionValue
            ? piSubscriptionUsageModelKey(pricingModel)
            : pricingModel;
          await recordModelTurnUsage({
            agentKind: 'pi',
            model: modelUsageKey,
            inputTokensDelta: tokens.inputTokens,
            outputTokensDelta: tokens.outputTokens,
            cacheReadTokensDelta: tokens.cacheReadTokens,
            cacheCreateTokensDelta: tokens.cacheCreateTokens,
          });
          void rebroadcastTodaySpend();

          try {
            // 自定义(source:'user')provider——本地 Ollama / 用户自付费兼容端点——即便
            // 模型 id 与 XD 目录重名,也不能套用 XD 网关定价当作 Cindy 消费入账;只记 token
            // (上方已入库),不写 money(codex review)。仅 xd / 默认网关与订阅路由计费。
            const isCustomProviderRoute = isUserProviderSession(session.id);
            const pricing =
              isSubscriptionValue || isCustomProviderRoute
                ? null
                : await getModelPricingForModel('xd', pricingModel);
            const price =
              effectiveProvider === 'openai'
              || effectiveProvider === 'anthropic'
              || effectiveProvider === 'xai'
                ? getModelPriceQuote(null, effectiveProvider, pricingModel)
                : isSubscriptionDirectModel(pricingModel)
                  ? getSubscriptionDirectValuePrice(pricingModel)
                  : isCustomProviderRoute
                    ? null
                    : getModelPriceQuote(pricing, 'xd', pricingModel);
            const money = computePriceQuoteTurnMoney(
              tokens,
              price ?? undefined,
              currentLedgerCurrency(),
            );
            if (money && money.amount > 0) {
              if (!isSubscriptionValue) {
                // token 已在上方入库；这里只补真实 API/gateway 费用，
                // 避免重复累加 token。订阅价值则由 #billing=subscription 读时估算。
                await recordModelTurnUsage({
                  agentKind: 'pi',
                  model: modelUsageKey,
                  money,
                  inputTokensDelta: 0,
                  outputTokensDelta: 0,
                  cacheReadTokensDelta: 0,
                  cacheCreateTokensDelta: 0,
                });
                void recordTurnSpend(money);
                void recordSessionTurnSpend(session.id, money);
              }
              const changedScheduleId = await recordSchedulerTurnCost({
                sessionId: session.id,
                clientId: turnAssistantPersistId,
                money,
                turnUsageDetails,
                turnOrigin: event.turnOrigin,
              });
              if (changedScheduleId) broadcastSchedulerChanged(changedScheduleId);
            } else if (turnAssistantPersistId && turnUsageDetails) {
              await recordTurnUsageOnMessage({
                sessionId: session.id,
                clientId: turnAssistantPersistId,
                turnUsageDetails,
              });
            }
          } catch {
            // 价格读取失败不能连带丢失 token/cache 事实。
            if (turnAssistantPersistId && turnUsageDetails) {
              await recordTurnUsageOnMessage({
                sessionId: session.id,
                clientId: turnAssistantPersistId,
                turnUsageDetails,
              });
            }
          }

          if (effectiveProvider === 'openai') {
            triggerCodexAccountUsageRefresh();
          } else if (effectiveProvider === 'anthropic') {
            triggerClaudeSubscriptionUsageRefresh();
          } else if (effectiveProvider === 'xd' || effectiveProvider == null) {
            void triggerClaudeAccountUsageRefresh();
          }
          // xAI 没有独立订阅窗口端点；Responses bridge 从响应 headers 实时更新
          // useXaiRateLimit 消费的快照，无需额外网络请求。
        })();
      }
    }
  }));
  registration.disposers.push(session.onStatusChange((status) => {
    if (wiredSessionsById.get(session.id)?.session !== session) return;
    // The local window broadcast is best-effort, but keep this guard here as
    // well because status callbacks are a lifecycle boundary: a third-party
    // bridge must not be able to skip session cleanup by throwing.
    try {
      broadcastToAllWindows(MAKER_PUSH.STATUS_CHANGED, { sessionId: session.id, status });
    } catch (err) {
      log.warn('session status broadcast failed', {
        sessionId: session.id,
        status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (status === 'closed') {
      try {
        cleanupPendingInteractionsForSession(session.id, 'session_closed');
        // 会话关闭同样是"终止":退避窗口有 3–20 秒,期间会话可能被独立关掉(切 agent、
        // 远端断开、宿主回收)。只清 coordinator 不够 —— 排期中的定时器与悬空的重连记录
        // 都还活着,前者会到点往已关闭的会话补发消息(coordinator 关闭路径保留 recovery,
        // 补发会把用户关掉的会话重新拉起来),后者会把结果错绑到下一个会话实例(codex P1)。
        autoResumeBookkeeping.teardown(session.id);
        agentInputCoordinatorHolder?.onSessionClosed(session.id);
        // 会话关闭:兑现延迟凭证切换(直接写 route),并唤醒被它挡住的等待者。
        pendingCredentialSwitchHolder?.onSessionClosed(session.id);
        deferredCodexRestartHolder?.onSessionSettled();
        agentInputCoordinatorHolder?.onExternalTurnSettled(session.id);
        refreshRemoteCodexMcpOnTurnSettledHolder?.(session.id);
        gitSnapshotCoordinator?.onSessionClosed(session.id);
        clearOrcaMcpHydrated(session.id);
        knownNonOrcaSessionIds.delete(session.id);
        lastReportedCostUsdBySession.delete(session.id);
        lastReportedModelUsageBySession.delete(session.id);
        turnModelPromiseBySession.delete(session.id);
        // 后台活动检测:会话进程已关闭(closeSession / 删除),清账并广播横幅熄灭。
        clearClaudeSessionBackgroundActivity(session.id);
        clearSessionPersistState(session.id);
        // 进程关闭 ≠ 通知作废:临时会话调度(非 heartbeat / 非 persistentSession)在 run
        // 终态后立刻 closeSession,此刻完成卡片刚在灵动岛上弹出来。硬删条目会让它当场
        // 消失,所以这条路径保留仍在展示的卡片,由 dwell 到期或用户 ack 收掉。
        handleAgentIslandSessionClosedAfterCleanup(session.id, 'process-closed');
      } catch (err) {
        log.warn('session close cleanup failed; forcing idle reconciliation', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Wiring teardown is independent of the best-effort product cleanup
        // above. A single disposer or listener error must not leave a closed
        // session reachable from the in-memory routing map.
        cancelDirectAbortReconciliation(session.id);
        pendingFailedTurnAssistantPersistId.delete(session.id);
        wiredSessionsById.delete(session.id);
        for (const dispose of registration.disposers) {
          try {
            dispose();
          } catch (err) {
            log.warn('session disposer failed during close teardown', {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        try {
          session.setInteractionListener(null);
        } catch (err) {
          log.warn('session interaction listener teardown failed', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // This must run even when an owner-boundary-sensitive cleanup above
        // rejects. A closed Session cannot keep the desktop turn boundary busy.
        sessionTurnActivityTracker.deleteSession(session.id);
        sessionTurnBoundaryGenerationById.delete(session.id);
        markSessionTurnEnded(session.id);
      }
    }
  }));

  // 注入 interaction listener (permission/ask/plan 三合一,renderer 按 kind 弹不同 UI)
  installDesktopInteractionListener(session);
  installInteractionLifecycleObserver(session, ghostSessionTap.interactionObserver);
}

/**
 * Backward-compat alias for feishu /ctr code (im/feishu/runAgentTurn.ts) that
 * imports `wireSessionToIpcExternal`. Module-top export of wireSessionToIpc
 * makes the holder pattern unnecessary, but keeping the alias avoids touching
 * unrelated feishu code in this merge.
 */
export const wireSessionToIpcExternal = wireSessionToIpc;

export interface RegisterMakerIpcOptions {
  onAnySessionTurnKeepaliveChange?: (isRunning: boolean) => void;
  /** 由 bootstrap 注入，避免 maker-ipc → model-access → maker-host 的循环依赖。 */
  refreshXdGatewayModels(): Promise<void>;
  /** DB 可读后仍在后台运行的账号模型发现；新建 / 懒恢复路由前必须等待。 */
  waitForAccountProviderModelsReady(): Promise<void>;
  /** Provider 刷新协调器已可用；紧跟 configure 发出，避免后续 handler 失败造成永久等待。 */
  onProviderModelAutoRefreshConfigured(): void;
}

export function registerMakerIpc(maker: Maker, options: RegisterMakerIpcOptions): void {
  log.info('registering maker:* IPC handlers');
  getAgentIslandService()?.setPermissionResolver(resolvePendingPermissionFromAgentIsland);
  sessionTurnActivityTracker.setTurnKeepaliveChangeListener(options.onAnySessionTurnKeepaliveChange ?? null);
  gitSnapshotCoordinator = createGitSnapshotCoordinator(maker);
  // 接上 DB 改名通知(用户手动改名后自动起名收手)与拦截意识探针(装了
  // will-user-message 钩子时不把用户原话送去标题模型)。
  registerSessionAutoTitleHooks({
    isUserMessageScreeningActive: hasEnabledUserMessageHookGhost,
  });

  // device-link busy presence:把「本机是否有 turn 在跑」探针注入 device-link host,
  // 它每 5s 取一次、翻转才上报,让控制端设备列表显示 busy 三态(规则 2:回调注入解耦)。
  setDeviceLinkBusyProbe(() => anySessionInTurn(maker));

  // device-link 参数级收敛:远程 create-session 的 workingDir / worktree:create 的 baseRepo
  // 必须是本机当前可访问的目录,挡掉控制端用任意路径越权起进程或执行 git。
  setDeviceLinkRemoteWorkingDirGuard(checkRemoteWorkingDir);

  // device-link 远程 set-* 持久化回流:effort/permission/fastMode/extraDirs 等
  // runtime-only handler 经这个注入写被控端 DB + 广播 patched。SET_MODEL 是例外:
  // 它必须在自己的 session 锁内直接调 persistSessionFields，防队列 drain 夹在
  // runtime 切换与 DB 落盘之间。两条路径都必须 await 持久化后才回 invoke-result。
  setDeviceLinkRemoteSettingsPersist(async (sessionId, patch) => {
    try {
      await persistSessionFields(sessionId, patch);
    } catch (err) {
      log.warn('[device-link] persist remote setting failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  // submit_github_issue 工具的 main 侧提交服务(确认桥 → serverApiFetch)。
  initGithubIssueSubmit(issueConfirmBridge);
  initRenameSessionsConfirm(renameSessionsConfirmBridge);

  // ── newMakerDraft 缓存同步 ──────────────────────────────────────────────
  // Renderer push (fire-and-forget) → main 内存缓存; collab spawn worker 时
  // 读这份缓存决定 model/effort/fastMode。startup 立刻推一次 + 用户每次改 New
  // Maker 偏好时增量推, payload 形态严格按 newMakerDefaultsCache.NewMakerDraftSnapshot。
  // 校验失败 (payload 不是 object / 缺字段) → no-op, 缓存维持上一次值, 避免脏数据污染。
  ipcMain.on(MAKER_SEND.SYNC_NEW_MAKER_DRAFT, (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Partial<NewMakerDraftSnapshot>;
    if (
      !p.lastByVendor || typeof p.lastByVendor !== 'object'
      || !p.fastModeByModel || typeof p.fastModeByModel !== 'object'
      || !p.effortByModel || typeof p.effortByModel !== 'object'
    ) return;
    setNewMakerDraftCache({
      lastByVendor: p.lastByVendor,
      fastModeByModel: p.fastModeByModel,
      effortByModel: p.effortByModel,
      // worktree 勾选记忆(vendor 无关根字段):旧 renderer 不推此字段 → false 兜底。
      worktreeEnabled: p.worktreeEnabled === true,
    });
    broadcastNewMakerDraftChanged();
  });

  // device-link:被控端 providerModelMemory(草稿列表行的真实读源)全量镜像给 main。旧的
  // newMakerDraft.effortByModel 已不再写非选中模型,故必须把这一层也同步出去,控制端才能完整镜像
  // 被控端草稿模型列表。镜像更新后同样广播 NEW_MAKER_DRAFT_CHANGED(payload 含 providerModelMemory)。
  ipcMain.on(MAKER_SEND.SYNC_PROVIDER_MODEL_MEMORY, (_e, payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    // 结构宽松校验:顶层是 object,值再交给消费方按字段读(脏数据不至于崩,缺字段回落默认)。
    setProviderModelMemoryCache(payload as ProviderModelMemorySnapshot);
    broadcastNewMakerDraftChanged();
  });

  // ── 元能力 ─────────────────────────────────────────────────────────────
  ipcMain.handle(MAKER_INVOKE.LIST_AVAILABLE_AGENTS, () => {
    return maker.listAvailableAgents();
  });

  ipcMain.handle(MAKER_INVOKE.ANY_SESSION_IN_TURN, () => {
    return anySessionInTurn(maker);
  });

  ipcMain.handle(MAKER_INVOKE.SESSION_IN_TURN, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    // 以 live session 自身的 isTurnRunning() 为权威(对齐本文件 reconcileTurnIdle 的判定):
    // tracker 只靠事件流维护,turn 异常死亡(没发 done / terminal)会 stale 为 in-turn —— 绝不能
    // 让它盖过 live 的 not-running,否则控制端 stall 看门狗永远拿不到 false、永远不收尾(正是本 PR 要修的卡死)。
    // 未加载 session = 没有活跃 turn(跑 turn 必先加载)→ false。
    const live = maker.getSession(sessionId);
    return live ? live.isTurnRunning() : false;
  });

  // 会话后台活动(turn 已结束但 CC 子进程仍在调模型)只读快照。
  ipcMain.handle(MAKER_INVOKE.SESSION_BACKGROUND_ACTIVITY, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    return { active: getClaudeSessionBackgroundActivity(sessionId) };
  });

  // 后台活动活跃会话全量列表(renderer 全局 store 挂载时的初始快照,增量走 push)。
  ipcMain.handle(MAKER_INVOKE.LIST_SESSION_BACKGROUND_ACTIVITY, () => {
    return { sessionIds: listActiveClaudeBackgroundActivitySessions() };
  });

  // “全部停止”是会话级最终止损入口：即使 turn 正在运行，也关闭其 agent 进程与全部子代理。
  registerStopSessionBackgroundTasksHandler(createElectronIpcHandlerRegistry(), {
    closeSession: (sessionId) => maker.closeSession(sessionId),
    clearBackgroundActivity: clearClaudeSessionBackgroundActivity,
    // 「全部停止」是会话级止损:已排期的自动续跑必须撤掉,别在用户喊停后又补发一条。
    noteSessionReset: resetAutomaticRecoveryForExplicitStop,
    notifyGoalStop: pauseGoalBeforeExplicitStop,
  });

  // 单个后台任务的精确停止(消息流任务卡 / 状态栏停止按钮)。只停指定 taskId,
  // 当前 turn 与其他后台任务不受影响 —— 与上面的会话级止损入口互补。
  registerStopAgentTaskHandler(createElectronIpcHandlerRegistry(), {
    getLiveSession: (sessionId) => maker.getSession(sessionId) ?? undefined,
  });

  // 会话仍在运行的后台任务快照(只读)。renderer 挂载 / reloadMessages 清空
  // taskUpdates 后据此补回存量任务(实时增量仍走 agent_task_update 事件流)。
  ipcMain.handle(MAKER_INVOKE.LIST_SESSION_BACKGROUND_TASKS, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    const live = maker.getSession(sessionId);
    return { tasks: live ? live.listBackgroundTasks() : [] };
  });

  // workflow 逐 agent 进度树(只读)。从活跃会话拿 workDir + sdkSessionId → 推导 Claude Code
  // workflows 记录目录 → 按 taskId 匹配 wf_*.json 解析成 {phases, agents[]}。数据源是 SDK 内部
  // 产物(无公开契约):找不到会话 / 未拿到 sdkSessionId / 目录不存在 / 文件损坏一律返回 null,
  // renderer 据此回退到 workflow 级卡片。整体 try/catch 兜底,绝不让 best-effort 查询污染主流程。
  ipcMain.handle(
    MAKER_INVOKE.GET_WORKFLOW_PROGRESS,
    async (_e, sessionId: unknown, taskId: unknown) => {
      if (typeof sessionId !== 'string' || typeof taskId !== 'string' || !taskId) return null;
      try {
        const s = maker.listActiveSessions().find((x) => x.id === sessionId);
        if (s) {
          // SSH 远程工作区会话(s.remoteHostId):Claude CLI 跑在 SSH 远端主机,workflow
          // 记录文件写在**SSH 远端 HOME** 下 —— 用本机 os.homedir() 拼目录必落空,读远端
          // 文件需经 remote-file-service,暂不支持 → 返回 null,renderer 回退到 workflow 级
          // 卡片(其数据走事件流,SSH 下可用)。注意这不是 device-link:device-link 远程会话
          // 不在本机 listActiveSessions,由控制端 renderer 的 makerTransport 隧道路由到被控端
          // 执行本 handler(见 allowlist 的 maker:get-workflow-progress 准入)。
          if (s.remoteHostId) return null;
          const { sdkSessionId, workDir } = s;
          // sdkSessionId 允许为空(/clear 后置空):reader 跳过精确目录直接跨目录扫描。
          if (!workDir) return null;
          // reader 内部带跨 sdkSessionId 换代兜底:resume 换代前跑的 workflow
          // 记录在旧 session 目录,精确目录 miss 后按 taskId 扫同 project 下其它目录。
          return await readWorkflowProgressForSession(
            os.homedir(),
            workDir,
            sdkSessionId ?? null,
            taskId,
          );
        }
        // 会话不活跃(app 重启后看历史 / 会话已被关闭释放):workflow 记录文件仍在
        // 本机磁盘,回退持久化 session 行的 working_dir + sdk_session_id 定位目录
        // (同样带跨换代兜底)。remote_host_id 非空(SSH)与活跃分支同理返回 null。
        const db = getDbClient().drizzle;
        const rows = await db
          .select({
            workingDir: sessions.workingDir,
            sdkSessionId: sessions.sdkSessionId,
            remoteHostId: sessions.remoteHostId,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        const row = rows[0];
        // sdkSessionId 允许为空:/clear 会把它置 null,但旧 wf 记录文件仍在,
        // reader 会跳过精确目录直接跨目录扫描(taskId 全局唯一)。
        if (!row || row.remoteHostId || !row.workingDir) return null;
        return await readWorkflowProgressForSession(
          os.homedir(),
          row.workingDir,
          row.sdkSessionId ?? null,
          taskId,
        );
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(MAKER_INVOKE.GET_CAPABILITIES, (_e, agentKind: unknown) => {
    return {
      ...maker.getCapabilities(requireAgentKind(agentKind)),
      // host 级 optional 能力；旧 desktop 缺省为 false。两个 agent 查询都带回，
      // 手机读取当前 agent 快照即可决定是否展示切换入口。
      supportsSessionAgentSwitch: true,
      // v2 因果能力：同引擎 no-op 返回 revision，后续 SET_MODEL 在 session 锁内 CAS。
      // 新 desktop 控制端据此与只有基础切换能力的旧 host 做安全兼容门控。
      supportsSessionAgentSwitchCas: true,
    };
  });

  // device-link 远程草稿镜像(只读):返回某 vendor 在 New Maker 草稿里的当前完整选择
  // (model/effort/fast/permission/source)。控制端经隧道调用 → seed 远程项目草稿。
  // 缓存未就绪 / 该 vendor 无草稿 model → 返回 {},控制端按 capabilities 默认兜底。
  ipcMain.handle(MAKER_INVOKE.GET_NEW_MAKER_DEFAULTS, (_e, agentKind: unknown) => {
    return getRemoteNewMakerDefaults(requireAgentKind(agentKind));
  });

  // device-link 草稿「模型 effort/fast」写穿:控制端经隧道调用 → 跑在**被控端**。被控端不直接改
  // newMakerDefaultsCache(那只是镜像、renderer 才是真相),而是把 pref 转发给自身 renderer
  // (DRAFT_PREF_APPLY,非转发 channel,只落本地窗口),由 renderer 调它原来的本地 setter 写真实草稿;
  // 草稿变更经既有 SYNC_NEW_MAKER_DRAFT re-mirror + 上面的 NEW_MAKER_DRAFT_CHANGED 广播回控制端。
  ipcMain.handle(MAKER_INVOKE.APPLY_NEW_MAKER_DRAFT_PREF, (_e, pref: unknown) => {
    if (!pref || typeof pref !== 'object') throwIpcError('INVALID_PARAMS', 'pref required');
    const p = pref as {
      agent?: unknown;
      providerId?: unknown;
      modelId?: unknown;
      effort?: unknown;
      fast?: unknown;
      active?: unknown;
      markModelChoice?: unknown;
    };
    if (p.agent !== 'claude-code' && p.agent !== 'codex' && p.agent !== 'pi') {
      throwIpcError('INVALID_PARAMS', 'agent must be claude-code|codex|pi');
    }
    if (p.providerId !== undefined && typeof p.providerId !== 'string') {
      throwIpcError('INVALID_PARAMS', 'providerId must be string');
    }
    if (p.active !== true && !p.providerId) {
      throwIpcError('INVALID_PARAMS', 'providerId required');
    }
    if (typeof p.modelId !== 'string' || !p.modelId) {
      throwIpcError('INVALID_PARAMS', 'modelId required');
    }
    if (p.effort !== undefined && typeof p.effort !== 'string') {
      throwIpcError('INVALID_PARAMS', 'effort must be string');
    }
    if (p.fast !== undefined && typeof p.fast !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'fast must be boolean');
    }
    if (p.markModelChoice !== undefined && typeof p.markModelChoice !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'markModelChoice must be boolean');
    }
    broadcastToAllWindows(MAKER_PUSH.DRAFT_PREF_APPLY, {
      agent: p.agent,
      providerId: p.providerId ?? '',
      modelId: p.modelId,
      active: p.active === true,
      ...(p.markModelChoice === false ? { markModelChoice: false } : {}),
      ...(p.effort !== undefined ? { effort: p.effort } : {}),
      ...(p.fast !== undefined ? { fast: p.fast } : {}),
    });
  });

  // device-link 草稿「新建会话默认启用 worktree」写穿:与上面的模型 pref 同款转发模式——
  // 被控端不直接改 newMakerDefaultsCache(那只是镜像、renderer 才是真相),把布尔转发给
  // 自身 renderer(WORKTREE_PREF_APPLY,仅本地窗口),renderer patchDraft 写真实草稿;
  // 变更经既有 SYNC_NEW_MAKER_DRAFT re-mirror + NEW_MAKER_DRAFT_CHANGED 回流控制端。
  registerNewMakerWorktreePreferenceHandler(createElectronIpcHandlerRegistry(), {
    isDeviceLinkInvoke,
    assertTrustedCaller: (event) =>
      assertTrustedAppRendererEvent(
        event as Parameters<typeof assertTrustedAppRendererEvent>[0],
      ),
    broadcast: broadcastToAllWindows,
  });

  // 旧控制端的 device-link 会话模型预设写穿兼容入口。转发给被控端 renderer 后,renderer 将值
  // 收敛到 providerModelMemory 全局预设,同时经 SYNC_SESSION_MODEL_PREF 回流供旧控制端的
  // session-scoped 镜像显示。新控制端统一走 APPLY_NEW_MAKER_DRAFT_PREF。
  ipcMain.handle(MAKER_INVOKE.SET_SESSION_MODEL_PREF, (_e, pref: unknown) => {
    if (!pref || typeof pref !== 'object') throwIpcError('INVALID_PARAMS', 'pref required');
    const p = pref as {
      sessionId?: unknown;
      agent?: unknown;
      providerId?: unknown;
      model?: unknown;
      effort?: unknown;
      fast?: unknown;
    };
    if (typeof p.sessionId !== 'string' || !p.sessionId) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    if (p.agent !== 'claude-code' && p.agent !== 'codex' && p.agent !== 'pi') {
      throwIpcError('INVALID_PARAMS', 'agent must be claude-code|codex|pi');
    }
    if (typeof p.providerId !== 'string' || !p.providerId) {
      throwIpcError('INVALID_PARAMS', 'providerId required');
    }
    if (typeof p.model !== 'string' || !p.model) {
      throwIpcError('INVALID_PARAMS', 'model required');
    }
    if (p.effort !== undefined && typeof p.effort !== 'string') {
      throwIpcError('INVALID_PARAMS', 'effort must be string');
    }
    if (p.fast !== undefined && typeof p.fast !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'fast must be boolean');
    }
    broadcastToAllWindows(MAKER_PUSH.SESSION_PREF_APPLY, {
      sessionId: p.sessionId,
      agent: p.agent,
      providerId: p.providerId,
      model: p.model,
      ...(p.effort !== undefined ? { effort: p.effort } : {}),
      ...(p.fast !== undefined ? { fast: p.fast } : {}),
    });
  });

  // device-link 会话非选中 pref 镜像回流:被控端 renderer → main(SYNC_SESSION_MODEL_PREF),main
  // 把它转发给订阅了 session:<id> 的控制端(NEW 推送只走 tap,不回发本地窗口)。无控制者近似 no-op。
  ipcMain.on(MAKER_SEND.SYNC_SESSION_MODEL_PREF, (_e, pref: unknown) => {
    if (!pref || typeof pref !== 'object') return;
    const p = pref as {
      sessionId?: unknown;
      agent?: unknown;
      providerId?: unknown;
      model?: unknown;
      effort?: unknown;
      fast?: unknown;
    };
    if (
      typeof p.sessionId !== 'string' || !p.sessionId
      || (p.agent !== 'claude-code' && p.agent !== 'codex' && p.agent !== 'pi')
      || typeof p.providerId !== 'string' || !p.providerId
      || typeof p.model !== 'string' || !p.model
    ) return;
    tapWindowBroadcast(MAKER_PUSH.SESSION_MODEL_PREF_CHANGED, {
      sessionId: p.sessionId,
      agent: p.agent,
      providerId: p.providerId,
      model: p.model,
      ...(typeof p.effort === 'string' ? { effort: p.effort } : {}),
      ...(typeof p.fast === 'boolean' ? { fast: p.fast } : {}),
    });
  });

  // 模型供应商目录（只读）+ 自定义供应商 CRUD —— handler body 注入 listProviders / 副作用，
  // 便于脱 Electron + 内存 db 单测。CRUD 成功后刷新 active-catalog 并广播 PROVIDER_CHANGED，
  // 让设置页列表 + 对话模型选择器（各 useProviders 实例）live 刷新。
  configureProviderModelAutoRefresh({
    listProviders: (opts) => getDesktopProviderService().listProviders(opts),
    getScopeKey: () => getActiveAppSession().generation,
    // 通知唯一出口是 active-catalog changedListener(capabilities 先对齐再广播);
    // 这里不再补发 PROVIDER_CHANGED——no-op/拒收刷新就该是 0 次广播。
    refreshCatalog: async () => {
      await refreshActiveCatalogFromSource();
    },
    refreshProvider: (providerId) =>
      refreshBuiltinProviderModels(providerId, {
        refreshXd: options.refreshXdGatewayModels,
        refreshAnthropic: refreshAnthropicModelsFromHttp,
        refreshOpenAi: () => maker.refreshAgentLocalModels(
          'codex',
          { credentialMode: 'oauth-bearer' },
        ),
        refreshXaiCatalog: async () => {
          await refreshActiveCatalogFromSource();
        },
      }),
  });
  options.onProviderModelAutoRefreshConfigured();

  registerProviderHandlers(createElectronIpcHandlerRegistry(), {
    listProviders: (opts) => getDesktopProviderService().listProviders(opts),
    getModelVisibilityOverrides: () => getModelVisibilityMirrorSnapshot(),
    refreshCatalog: () => refreshCustomProvidersIntoCatalog(),
    beginRouteMutation: (providerId) => beginProviderRouteMutation(providerId),
    broadcastChanged: () => broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {}),
    listProviderIds: () => getDesktopSelectableCatalog().providers.map((provider) => provider.id),
    setProviderOrder: (providerIds) => setProviderOrder(providerIds),
    getProviderOrder: () => readProviderOrder(),
    listPresets: () => getActiveCatalog().presets ?? [],
    testConnection: (input) => testProviderConnection(input),
    fetchModels: (spec) => fetchProviderModels(spec),
    // 重新发现会用订阅凭证发起真实上游请求，限主页面 sender（子 frame / WebView 拒绝）。
    assertTrustedSender: (event) =>
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
    // provider:list 是只读通道且要服务 device-link（合成 event），不能加会抛的 guard；
    // 改用不抛的判定决定「这次读取要不要放行本机绑定自愈 + 清单拉取」。
    isTrustedSender: (event) =>
      isTrustedAppRendererEvent(event as Parameters<typeof isTrustedAppRendererEvent>[0]),
    // 动态清单重新发现：目前只有 anthropic 订阅是「清单唯一来源是动态发现」的供应商。
    // 拉取内部只记账不抛，完成后现读一次失败归因回给 renderer。
    rediscoverModels: async (providerId) => {
      if (providerId !== 'anthropic') return null;
      await refreshAnthropicModelsFromHttp();
      return getAnthropicModelDiscoveryFailure();
    },
    refreshBuiltinModels: refreshProviderModelsManually,
    requestModelsAutoRefresh: requestProviderModelAutoRefresh,
    scanLocalCli: () => scanLocalCliAuth(createLocalCliScanDeps()),
    // 「模型 / 供应商停用」override 写入(main 侧持久化,handler 写后广播 PROVIDER_CHANGED)。
    setModelsDisabled: (providerId, modelIds, disabled) =>
      setModelsDisabled(providerId, modelIds, disabled),
    setProviderDisabled: (providerId, disabled) => setProviderDisabled(providerId, disabled),
    stageClearProviderDisableOverrides: (providerId) =>
      stageProviderDisableOverridesClear(providerId),
    // 「恢复默认」= 删除该供应商整组停用 override(configuration-and-overrides.md §4)。
    clearProviderDisableOverrides: (providerId) => clearProviderDisableOverrides(providerId),
    // 所有跨 await 的 provider 读写都捕获完整 app session；generation 能识别 A→B→A，
    // 防止旧请求返回混合快照或写进后来重新进入的 A 会话。
    currentOwnerSession: () => getActiveAppSession(),
    readCustomProviderHeadersForMutation,
    storeCustomProviderHeaders,
    removeCustomProviderHeaders,
    // 已存自定义供应商在该 agent 下的请求目标端点(baseUrl + 可选 modelsUrl),取自
    // active-catalog routing。models-fetch 用它把 savedProviderId 请求钉回已存端点,
    // 确保 main-only 密文头只发往该供应商自己的端点(安全边界在 main)。
    readSavedProviderRoute: (providerId, agent) => {
      const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
      if (!provider || provider.source !== 'user') return null;
      const routing = provider.routing[agent];
      if (!routing || routing.disabled) return null;
      return { baseUrl: routing.upstream, modelsUrl: routing.modelsUrl ?? null };
    },
    getLedgerCurrency: currentLedgerCurrency,
    readModelPriceOverride: (target) =>
      readModelPriceOverrideView(target, getActiveCatalog().modelRegistry),
    writeModelPriceOverride: (target, desired) =>
      setModelPriceOverride(target, desired, getActiveCatalog().modelRegistry),
    clearModelPriceOverride,
    stageClearProviderModelPriceOverrides: stageProviderModelPriceOverridesClear,
    broadcastPricingChanged: broadcastEffectiveModelPricing,
    // 通用 OAuth（目录 auth.oauth 描述符驱动）：login 成功后 best-effort 拉动态模型发现
    // (additions-only merge 进 active-catalog) 并广播 PROVIDER_CHANGED 让 UI 刷新连接态。
    oauthLogin: async (providerId, isCurrent) => {
      const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
      const oauth = provider?.auth.oauth;
      if (!provider || !oauth) throw new Error(`provider '${providerId}' has no oauth descriptor`);
      let rollbackCredentials: (() => boolean) | undefined;
      const result = await runGenericOAuthLogin(
        { id: provider.id, name: provider.name },
        oauth,
        {
          onProgress: (progress) =>
            broadcastToAllWindows(MAKER_PUSH.PROVIDER_OAUTH_PROGRESS, {
              providerId,
              ...progress,
            }),
          onCredentialPersisted: (rollback) => {
            rollbackCredentials = rollback;
          },
        },
      );
      if (result.ok && isCurrent()) {
        // 授权成功后按 agent 自动发现模型（与内置订阅体验统一,用户不必手填模型）:
        // 发现端点 = 描述符显式声明 ?? 由该 runtime 的 baseUrl 推导（…/v1/models）。
        // 自定义供应商的发现结果 additions-only 持久化进配置（重启后仍在）;内置供应商走
        // 内存 augment（静态目录 first-wins）。任何一步失败都只降级为纯静态,不影响登录结果。
        try {
          const fetched = new Map<
            string,
            { id: string; name: string; contextWindow?: number }[] | null
          >();
          let customChanged = false;
          for (const agent of provider.agents) {
            if (!isCurrent()) break;
            const upstream = provider.routing[agent]?.upstream;
            const url = oauth.modelsDiscoveryUrl ?? (upstream ? deriveModelsDiscoveryUrl(upstream) : null);
            if (!url) continue;
            // 去重键含 agent:发现请求头按 wire 分派(cc 带 anthropic-version),同 URL 不同 wire 不能共用响应。
            const key = `${agent}\n${url}`;
            if (!fetched.has(key)) fetched.set(key, await discoverGenericOAuthModels(providerId, oauth, url, agent));
            if (!isCurrent()) break;
            const models = fetched.get(key);
            if (!models || models.length === 0) continue;
            if (provider.source === 'user') {
              const cfg = await getCustomProvider(providerId);
              if (!isCurrent()) break;
              if (cfg) {
                const nextCfg = mergeDiscoveredModelsIntoConfig(cfg, agent, models);
                if (nextCfg) {
                  const applied = await updateCustomProviderIfUnchanged(providerId, cfg, nextCfg);
                  if (!isCurrent()) break;
                  if (applied) customChanged = true;
                }
              }
            } else {
              if (!isCurrent()) break;
              setDiscoveredProviderModels(
                providerId,
                agent,
                models.map((m) => ({
                  id: m.id,
                  name: m.name,
                  // 端点上报的窗口值优先,缺省才落 200K 保守默认(review P1):
                  // 之前无条件写死 200K,发现的 1M 模型仍会显示并按 200K 压缩。
                  contextWindow: m.contextWindow ?? 200_000,
                  // 只有端点真给了才算已核实,可以拿去收敛运行期上报窗口;落 200K
                  // 兜底的不标记 —— 否则 resolveVerifiedContextWindow 会拒收缺失
                  // 标记的条目,inflate 的运行期值压不下来(review P1)。
                  ...(m.contextWindow !== undefined ? { contextWindowVerified: true } : {}),
                  efforts: [],
                  defaultEffort: null,
                  group: `custom:${providerId}`,
                  defaultEnabled: false,
                })),
              );
            }
          }
          if (customChanged && isCurrent()) await refreshCustomProvidersIntoCatalog();
        } catch {
          /* 发现失败保持纯静态目录，不影响登录结果 */
        }
        if (isCurrent()) broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {});
      }
      return {
        ...result,
        ...(rollbackCredentials ? { rollbackCredentials } : {}),
      };
    },
    readCustomProviderKeyForMutation,
    storeCustomProviderKey,
    removeCustomProviderKey,
    oauthLogout: async (providerId) => {
      if (!logoutGenericOAuth(providerId)) {
        throw new Error('failed to remove generic OAuth credentials');
      }
    },
    oauthCancel: (providerId) => cancelGenericOAuthLogin(providerId),
    removeOAuthCredentials: (providerId) =>
      removeGenericOAuthCredentialsReversibly(providerId),
  });

  // 自定义 MCP 服务器 CRUD —— CRUD 成功后刷新两个 agent 的 mcpProviders 数组
  // （下次新建会话生效）并广播 MCP_CHANGED 让设置页列表 live 刷新。
  registerMcpHandlers(createElectronIpcHandlerRegistry(), {
    refreshProviders: () => refreshCustomMcpProviders(),
    broadcastChanged: () => broadcastToAllWindows(MAKER_PUSH.MCP_CHANGED, {}),
    // 内置 server 名对自定义 MCP 是保留名：撞名会在装配层顶替内置 server 并继承
    // 它在 MCP 审批策略里的信任，所以 CRUD 阶段就拒收。
    getReservedMcpIds: () => getBuiltinMcpServerNames(),
    // Codex 的 MCP flags 冻在 codexEnvironment 的 cached spawn 配置里,清缓存 + dispose app-server,
    // 让下个 codex 会话按新 MCP 配置重 spawn(与 slack 变更同款 best-effort;busy 会话软重启失败只告警)。
    // 顺序：先 dispose app-server（含 busy 检查），成功后再关 bridge/cache。
    // 若先关 bridge、后 dispose 失败（busy），running 会话的 mcp_servers URL 会指向已停的 bridge。
    invalidateCodex: async () => {
      let codexRestarted = false;
      try {
        await restartCodexAfterAuthModeChange();
        codexRestarted = true;
      } catch (err) {
        log.warn('restartCodexAfterAuthModeChange on custom mcp change failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (codexRestarted) {
        try {
          await shutdownCodexEnvironment();
        } catch (err) {
          log.warn('shutdownCodexEnvironment on custom mcp change failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Pi 的 MCP bridge 同样按首个会话冻结 server 集合:自定义 MCP 增删改后必须 invalidate,
      // 否则新 Pi 会话仍暴露已删/已禁用的工具、拿不到新启用的工具(codex review P1)。
      // 与 codex 分支独立(不依赖 codexRestarted),下一次 startSession lazy 重建。
      invalidatePiEnvironment();
    },
  });
  // Claude 原生 Auto 分类器不可用 → 会话仍保持 Auto，只把后续审批切到 Cindy reviewer。
  // coordinator 内部复核 DB 仍为 auto 并按 session 去重；不改偏好、不弹提示。
  const handleClaudeAutoClassifierUnavailable = createClaudeAutoPermissionFallbackCoordinator({
    getSession: (sessionId) => maker.getSession(sessionId),
    getSessionMeta: (sessionId) => maker.getSessionMeta(sessionId),
    logger: log,
  });
  setClaudeAutoClassifierUnavailableListener((signal) => {
    void handleClaudeAutoClassifierUnavailable(signal);
  });

  // 自定义供应商上游错误(4xx/5xx 分类结果)→ 广播给所有窗口(renderer toast 人话提示)。
  // 观察器本身挂在两个 loopback proxy 上(见 provider-upstream-error-observer),此处只接广播。
  setProviderUpstreamErrorBroadcaster((event) =>
    broadcastToAllWindows(MAKER_PUSH.PROVIDER_UPSTREAM_ERROR, event),
  );
  // 会话后台活动翻转 → 广播给所有窗口(renderer 会话内横幅 +「全部停止」入口)。
  setClaudeBackgroundActivityBroadcaster((payload) =>
    broadcastToAllWindows(MAKER_PUSH.SESSION_BACKGROUND_ACTIVITY_CHANGED, payload),
  );

  // per-session 供应商路由:把 cc loopback proxy 看到的 x-claude-code-session-id(= sdkSessionId)
  // 反解成 xdt sessionId,供其统一路由器查该会话显式选定的供应商。sdkSessionId 唯一,直接匹配活跃会话。
  setClaudeProxySessionIdResolver((sdkSessionId) => {
    const s = maker.listActiveSessions().find((x) => x.sdkSessionId === sdkSessionId);
    return s ? s.id : null;
  });

  // 会话移动转录迁移:活跃会话桥(查内存 sdkSessionId + 关闭 handle)。
  // rewind fork 后 SDK 换新 id,消息落库前 DB 仍是旧值,迁移必须能看到内存里的最新 id;
  // 移动时还要关闭活跃 handle,否则旧 cwd 的 CLI 进程继续追加旧目录 jsonl 造成分叉。
  setLiveCcSessionBridge({
    resolveSdkSessionId: (sessionId) => {
      const s = maker.listActiveSessions().find((x) => x.id === sessionId);
      return s?.sdkSessionId ?? null;
    },
    closeSession: (sessionId) => maker.closeSession(sessionId),
  });

  // ── Palette `/` 命令三源 (palette refactor) ────────────────────────────
  // Desktop / agent-builtin / agent-skill 各一条 list 接口 + desktop 自家的
  // execute 接口。renderer 通过 mergeCommands 把三路 list 合并展示, dispatch
  // 时按 kind 分流: desktop → executeDesktopCommand IPC; agent-* → 当 prompt 前缀 send。
  ipcMain.handle(MAKER_INVOKE.LIST_DESKTOP_COMMANDS, () => {
    return { success: true, commands: getDesktopCommandRegistry().list() };
  });

  ipcMain.handle(MAKER_INVOKE.EXECUTE_DESKTOP_COMMAND, async (e, name: unknown, ctx: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throwIpcError('INVALID_PARAMS', 'name required');
    }
    // senderWebContentsId 由 main 从 event.sender 填入(覆盖 renderer 传入的任何值),
    // 供需要"只回发起窗口"的命令(/issue)做定向 send。
    const c = {
      ...((ctx ?? {}) as DesktopCommandContext),
      senderWebContentsId: e.sender.id,
    };
    await getDesktopCommandRegistry().execute(name, c);
  });

  ipcMain.handle(MAKER_INVOKE.LIST_AGENT_COMMANDS, (_e, agentKind: unknown) => {
    try {
      return { success: true, commands: maker.listAgentCommands(requireAgentKind(agentKind)) };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), commands: [] };
    }
  });

  ipcMain.handle(MAKER_INVOKE.LIST_AGENT_SKILLS, async (_e, agentKind: unknown, params: unknown) => {
    try {
      const kind = requireAgentKind(agentKind);
      const skillParams = (params ?? {}) as { workingDir?: string; forceReload?: boolean };
      const linksChanged = await prepareProjectSkillLinksFailSoft(skillParams?.workingDir);
      if (kind === 'codex' && linksChanged) {
        skillParams.forceReload = true;
      }
      if (kind === 'codex') {
        await desktopCodexAuthAdapter.ensureGlobalCodexAssets();
      } else if (kind === 'claude-code') {
        await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();
      }
      const result = await maker.listAgentSkills(
        kind,
        skillParams,
      );
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err), skills: [] };
    }
  });

  ipcMain.handle(MAKER_INVOKE.SCAN_AT_RESOURCES, async (_e, agentKind: unknown, params: unknown) => {
    try {
      const resourceParams = params as { workingDir: string; cap?: number; query?: string };
      await prepareProjectSkillLinksFailSoft(resourceParams?.workingDir);
      const result = await maker.scanAtResources(requireAgentKind(agentKind), resourceParams);
      return { success: true, ...result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        items: [],
        truncated: false,
      };
    }
  });

  ipcMain.handle(MAKER_INVOKE.LIST_CUSTOMIZATIONS, async (_e, params: unknown) => {
    try {
      const p = (params ?? {}) as {
        agentKind?: unknown;
        workingDirs?: unknown;
        forceReload?: unknown;
        kinds?: unknown;
      };
      const agentKind = p.agentKind !== undefined ? requireAgentKind(p.agentKind) : undefined;
      if (agentKind === undefined || agentKind === 'codex') {
        await desktopCodexAuthAdapter.ensureGlobalCodexAssets();
      }
      const opts = {
        ...(agentKind !== undefined ? { agentKind } : {}),
        workingDirs: Array.isArray(p.workingDirs)
          ? p.workingDirs.filter((s): s is string => typeof s === 'string')
          : [],
        forceReload: p.forceReload === true,
        kinds: Array.isArray(p.kinds)
          ? p.kinds.filter((s): s is string => typeof s === 'string')
          : undefined,
      };
      const result = await maker.listCustomizations(opts);
      return { success: true, ...result };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        items: [],
        errors: [],
      };
    }
  });

  // ── Session 生命周期 ────────────────────────────────────────────────────
  // wiredSessionsById + lastReportedCostUsdBySession + sessionTurnActivityTracker 都在模块顶层,
  // 让 scheduler runner / feishu 接管 / future MCP 等绕过 IPC 的调用方也能复用同一份 wire 逻辑。

  type CreateOpts = MakerSessionCreateOpts;

  function buildCreateOptsWithStderr(o: CreateOpts) {
    // 把 vendor 子进程 stderr 引到主进程日志,否则 "process exited with code 1" 之类
    // 的失败信息会被默默丢掉。renderer 仍可以通过 vendorOptions 自定义,这里只在缺省时兜底。
    return withCreateSessionStderr(o, (agentKind, line) => log.warn(`[${agentKind}/stderr] ${line}`));
  }

  function isSessionRunningError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const code = (err as { code?: unknown }).code;
    if (code === 'SESSION_RUNNING') return true;
    const message = (err as { message?: unknown }).message;
    return typeof message === 'string' && message.startsWith('SESSION_RUNNING:');
  }

  // SEND lazy-create owns its non-Orca cache write here (line below); direct
  // CREATE_SESSION uses markKnownNonOrcaIfApplicable outside this function.
  // Keep the decision split: SEND must inspect DB first, and exceptional Orca
  // states (e.g. worker role but missing link) intentionally return false
  // without caching so a later retry can recover.
  /**
   * project-knowledge inject 共用逻辑：CREATE_SESSION adapter + SEND lazy-create 都用。
   * 自动开启——任何 session 创建都会尝试读 cwd 下 .cindy/project-knowledge/，存在就注入；
   * 不再依赖 renderer 显式开关。tryInjectProjectContext silently fallback——目录缺失 / 文件
   * 读失败都走 injected:false 分支，不抛错也不阻塞 session 创建。
   * 副作用：mutate o.userPrompt（追加 wrapper）；返回是否真的注入了内容。
   */
  async function applyProjectContextInjection(o: CreateOpts): Promise<boolean> {
    if (!o.workingDir) return false;
    // remote session: workingDir 是远端主机上的路径。本机若恰好存在同路径且带
    // .cindy/project-knowledge/,tryInjectProjectContext 会把**本机**的项目知识注入给
    // 远端 agent,污染远端仓库的回答。远端 project-context 需经远端 host 读取(后续特性),
    // 未落地前 remote session 一律跳过本地注入。注意:仅影响 remote,local 注入行为不变。
    if (o.remoteHostId) {
      log.info('project-context inject skipped (remote session)', { workDir: o.workingDir });
      return false;
    }
    const result = await tryInjectProjectContext(o.workingDir);
    if (result.injected && result.content) {
      // 复用 userPrompt 字段语义（"用户级 system prompt 末段"）拼到现有内容尾部。
      o.userPrompt = `${o.userPrompt ?? ''}\n\n${result.content}`;
      return true;
    }
    log.info('project-context inject skipped', { workDir: o.workingDir, reason: result.reason });
    return false;
  }

  function orcaSessionStatus(sessionId: string): string {
    const session = maker.getSession(sessionId) as ({ getStatus?: () => string } | null);
    return session?.getStatus?.() ?? 'not_running';
  }

  async function readLatestWorkerAssistantMessage(workerSessionId: string): Promise<string> {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(and(
        eq(messages.sessionId, workerSessionId),
        eq(messages.role, 'assistant'),
        isNull(messages.rewindAt),
      ))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    return visibleMessageTextForConversationSearch('assistant', row?.content ?? '');
  }

  async function readActiveOrcaTeamByLeadReadOnly(leadSessionId: string) {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        id: orcaTeams.id,
        leadSessionId: orcaTeams.leadSessionId,
        status: orcaTeams.status,
      })
      .from(orcaTeams)
      .where(and(eq(orcaTeams.leadSessionId, leadSessionId), eq(orcaTeams.status, 'active')))
      .orderBy(desc(orcaTeams.updatedAt), desc(orcaTeams.createdAt))
      .limit(1);
    return row ?? null;
  }

  function createOrcaDiagnosticsDeps() {
    return {
      readActiveTeam: readActiveOrcaTeamByLeadReadOnly,
      listWorkersByLead,
      getSessionStatus: orcaSessionStatus,
      readLatestAssistantMessage: readLatestWorkerAssistantMessage,
    };
  }

  /**
   * 注入成功后回写 sessions.used_project_context = true（DB 默认 false）。
   * 失败只 warn，不抛——不阻塞 session 创建主流程。
   */
  async function markProjectContextIfNeeded(sessionId: string, didInject: boolean): Promise<void> {
    if (!didInject) return;
    try {
      await markSessionUsedProjectContext(sessionId);
    } catch (err) {
      log.warn('failed to mark used_project_context', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 懒启动 / 队列恢复时,renderer 传来的 createOpts 可能没有 providerId,但 DB 里的
   * sessions.provider_id 才是这条会话的真实来源选择。必须在 maker.createSession 前补齐,
   * 否则 agent 首轮 auth gate 会按默认 fallback 判断,之后 hydrate 路由表已经太晚。
   */
  async function hydrateProviderIdBeforeSessionStart(o: CreateOpts): Promise<void> {
    if (o.providerId !== undefined) {
      if (typeof o.providerId === 'string') {
        o.providerId = o.providerId.trim() || null;
      }
      return;
    }
    if (typeof o.id !== 'string' || !o.id) return;
    try {
      const db = getDbClient().drizzle;
      const [row] = await db
        .select({ providerId: sessions.providerId })
        .from(sessions)
        .where(eq(sessions.id, o.id))
        .limit(1);
      if (row) {
        // DB null 是显式默认路由，不等于「调用方未指定」。保留该三态才能阻止
        // Pi 在同名 BYOM 存在时把默认路由误反查成自定义来源。
        o.providerId = row.providerId?.trim() || null;
      }
    } catch (err) {
      log.debug('pre-hydrate session provider failed (non-fatal)', {
        sessionId: o.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function markOrcaRoleIfNeeded(
    sessionId: string,
    orcaRole: CreateOpts['orcaRole'],
  ): Promise<void> {
    if (orcaRole !== 'lead' && orcaRole !== 'worker') return;
    if (orcaRole === 'worker') {
      markKnownOrcaWorkerSession(sessionId);
      clearSuppressedOrcaWorkerAgentIslandSession(sessionId);
    }
    try {
      await setSessionOrcaRole(sessionId, orcaRole);
    } catch (err) {
      log.warn('failed to mark orca_role', {
        sessionId,
        orcaRole,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 统一的 session bootstrap 序列（5 步，不含 markOrcaRoleIfNeeded）：
   *   1. applyOrcaInstructions(o)            注入 Orca lead/worker system prompt
   *   2. applyProjectContextInjection(o)     注入 project-context 知识层
   *   3. validateExtraDirs(o.extraDirs)      过滤非法 extraDirs（仅当非空）
   *   4. maker.createSession(o)              真正创建 session
   *   5. markProjectContextIfNeeded + wireSessionToIpc + markOrcaMcpHydratedIfNeeded
   *      —— DB 落字段 + IPC 绑定 + MCP 注水
   *
   * 不负责的事（留给调用方处理，因路径差异显著）：
   *   - markOrcaRoleIfNeeded: 路径 A（CREATE_SESSION）有两阶段契约 —— lead-only；
   *     worker 等 addWorker 建立 link 后由 MARK_ORCA_ROLE IPC 单独写。
   *     路径 B/C（SEND lazy/rehydrate）直接调让 helper 内部 filter 处理 lead/worker。
   *     语义差异显式留在调用方，可读性 > 收敛。
   *   - closeSession（rehydrate 路径独有）
   *   - DB 兜底读 extraDirs（lazy/rehydrate 路径独有；需在调 helper 前完成并写回 o.extraDirs）
   *   - synthesizeOrcaVendorOptionsFromDb（lazy/rehydrate 路径独有；必须在 helper 前调，
   *     因 applyOrcaInstructions 依赖 vendorOptions.orcaRole）
   *   - markKnownNonOrcaIfApplicable（CREATE_SESSION 路径独有的 cache 写入）
   *   - Orca worker 首消息（CREATE_SESSION 路径独有的业务逻辑）
   *   - stderr hook 注入（CREATE_SESSION adapter / lazy-create 调用方各自先完成）
   *   - log.info(...) 诊断（各路径字段不同，由调用方在拿到返回值后自己打）
   *
   * 历史：Issue #27 —— 消除 register.ts 内 3 处 session 创建的重复 5 步。
   * 已踩过 commit 2e8371c7 的坑（路径 B/C 漏调 markOrcaMcpHydratedIfNeeded
   * 导致 Orca MCP 工具 rehydrate 失败），抽 helper 让"漏调"在编译期不可能发生。
   */
  /**
   * 停用轴的边界裁决(判定纯逻辑在 model-route-guard.ts,可单测)。
   * 返回值 = 需要改路由到的启用来源 id(隐式默认落点被停用而有替代拷贝时),
   * undefined = 照常;停用语义下不可路由则抛 INVALID_PARAMS。目录读取失败按
   * 放行处理:目录不可用时历史行为就是回落 capabilities 继续跑,本守卫只执行停用
   * 语义,不把目录故障升级成会话不可建。allowSideEffects=false —— 这条路径可能由
   * device-link / renderer 驱动,纯读即可(自愈另有主进程业务入口负责)。
   */
  async function assertModelRouteUsable(
    agent: AgentKind,
    model: string,
    providerId: string | null,
  ): Promise<string | undefined> {
    const verdict = await verdictForModelRoute(agent, model, providerId);
    if (verdict.kind === 'reject') {
      throwIpcError(
        'INVALID_PARAMS',
        verdict.reason === 'explicit-source-disabled'
          ? `provider "${providerId}" is disabled for model "${model}" in settings`
          : verdict.reason === 'capability-model'
            ? `model "${model}" is not an agent chat model`
            : verdict.reason === 'model-retired'
              ? `model "${model}" has been retired from the catalog`
              : `model "${model}" is disabled in settings`,
      );
    }
    return verdict.kind === 'reroute' ? verdict.providerId : undefined;
  }

  async function bootstrapSession(o: CreateOpts): Promise<{
    session: Awaited<ReturnType<typeof maker.createSession>>;
    didInjectOrcaInstructions: boolean;
    didInjectProjectContext: boolean;
  }> {
    await options.waitForAccountProviderModelsReady();
    const didInjectOrcaInstructions = applyOrcaInstructions(o);
    const didInjectProjectContext = await applyProjectContextInjection(o);

    if (o.extraDirs && o.extraDirs.length > 0) {
      const validation = await validateExtraDirs(o.extraDirs, o.workingDir);
      o.extraDirs = validation.valid;
    }

    await hydrateProviderIdBeforeSessionStart(o);
    // 停用轴准入(PR #744 review):**新建**会话不得路由到用户停用的模型 / 来源。
    // renderer 选择器已过滤,但 create-session 在 device-link allowlist 内,老控制端
    // 可直接点名 —— main 必须自己裁决。resume 豁免(运行中的会话不打断)只给
    // **经核实的原样续跑**:请求路由与本会话 DB 持久化路由一致才算;resumeSessionId
    // 是调用方可控字段,携带任意非空 id 同时改点停用 model/provider 不能构成绕过
    // (PR #744 review 第十六轮)。读不到会话行(远端新建等)按非豁免走正常裁决。
    // 隐式来源的原生默认落点被停用而有启用替代拷贝时,把会话显式改路由过去(下方
    // persistAndHydrateSessionProvider 会把它落库):实际路由层对隐式来源走原生
    // 默认、不查停用标志,仅放行等于继续用停用拷贝付费。
    if (typeof o.model === 'string' && o.model) {
      let verifiedResume = false;
      if (o.resumeSessionId && typeof o.id === 'string' && o.id) {
        try {
          const [row] = await getDbClient()
            .drizzle.select({ model: sessions.model, providerId: sessions.providerId })
            .from(sessions)
            .where(eq(sessions.id, o.id))
            .limit(1);
          verifiedResume =
            !!row &&
            row.model === o.model &&
            (row.providerId ?? null) === (o.providerId ?? null);
        } catch {
          verifiedResume = false;
        }
      }
      if (!verifiedResume) {
        const reroute = await assertModelRouteUsable(o.agentKind, o.model, o.providerId ?? null);
        if (reroute && !o.providerId) o.providerId = reroute;
      }
    }
    const session = await maker.createSession(o);
    await markProjectContextIfNeeded(session.id, didInjectProjectContext);
    wireSessionToIpc(session);
    markOrcaMcpHydratedIfNeeded(session.id, o);

    // per-session 供应商:从 DB(sessions.provider_id)回填路由 store —— 跨重启恢复会话显式选定的
    // 供应商,让首个请求就按所选来源路由;无值则保持未设(→ 默认路由,行为不变)。hydrate 不覆盖
    // 运行中已有的选择。读失败不致命(回落默认路由)。所有 create/resume 路径都经本funnel,单点覆盖。
    //
    // device-link 远程 create(P2):DesktopSessionStorage.create 从 maker-core SessionMeta 建行,
    // SessionMeta 不含 providerId → 远程新建行 provider_id 恒 NULL。这里在 hydrate 前用 create opts
    // 的 providerId 补写 DB。providerId=null 是显式清除来源,也必须写库覆盖旧值;只有
    // providerId=undefined 才表示调用方没有携带来源选择。懒启动路径会在 maker.createSession
    // 前从 DB 预补 o.providerId,所以下面同时承担「新建落库」和「恢复路由 store」两件事。
    try {
      const db = getDbClient().drizzle;
      await persistAndHydrateSessionProvider({
        sessionId: session.id,
        providerId: o.providerId,
        updateProviderId: async (targetSessionId, providerId) => {
          await db
            .update(sessions)
            .set({ providerId })
            .where(eq(sessions.id, targetSessionId));
        },
        readProviderId: async (targetSessionId) => {
          const [pRow] = await db
            .select({ providerId: sessions.providerId })
            .from(sessions)
            .where(eq(sessions.id, targetSessionId))
            .limit(1);
          return pRow?.providerId;
        },
        hydrateSessionProvider,
      });
      // bridge 会话态(effort / fast)同点 hydrate:让 resume / 重启后的首个 bridge 请求就带上
      // 用户上次选定的思维深度与 Fast(否则要等用户再点一次开关才写进内存 store)。
      const [efRow] = await db
        .select({ effort: sessions.effort, fastMode: sessions.fastMode })
        .from(sessions)
        .where(eq(sessions.id, session.id))
        .limit(1);
      if (efRow?.effort) setSessionEffort(session.id, efRow.effort);
      setSessionFastMode(session.id, !!efRow?.fastMode);
    } catch (err) {
      log.debug('hydrate session provider failed (non-fatal)', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 预建 worktree 补快照:send_to_session / hook-control / device-link 远程 create 都是
    // 「先 worktree:create(worktreeStore 绑定)后建会话」—— 绑定写入时 session 行还不
    // 存在,worktreeStore.set 的 sessions.worktree_path 同步落空(仅 warn)。此处行已建,
    // 统一补一次反范式快照(幂等;本地"先会话后 worktree"路径此时无绑定,天然跳过)。
    // 失败非致命 —— 徽标与回收都以 worktreeStore 为准。
    try {
      const wtMeta = worktreeStore.get(session.id);
      if (wtMeta?.path) {
        const db = getDbClient().drizzle;
        await db
          .update(sessions)
          .set({ worktreePath: wtMeta.path })
          .where(eq(sessions.id, session.id));
      }
    } catch (err) {
      log.debug('backfill worktree_path failed (non-fatal)', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return { session, didInjectOrcaInstructions, didInjectProjectContext };
  }

  // switchFocus 和 sendToWorker 都可能唤醒 idle worker；统一走这里才能保留 extraDirs。
  async function resumeOrcaWorkerSessionIfMissing(target: {
    id: string;
    teamId: string;
    leadSessionId: string;
    sessionId: string;
  }): Promise<boolean> {
    const live = maker.getSession(target.sessionId);
    if (live) return false;

    const db = getDbClient().drizzle;
    const [row] = await db.select().from(sessions).where(eq(sessions.id, target.sessionId)).limit(1);
    if (!row) return false;

    const workerVendorOptions = {
      orcaRole: 'worker' as const,
      orcaWorkflowId: target.teamId,
      orcaLeadSessionId: target.leadSessionId,
      orcaWorkerId: target.id,
      orcaWorkerSessionId: target.sessionId,
    };
    const extraDirs = await readSessionExtraDirsFromDb(target.sessionId);
    const opts = buildCreateOptsWithStderr({
      id: row.id,
      agentKind: dbToMakerAgentKind(row.agentKind),
      workingDir: row.workingDir ?? '',
      model: row.model,
      effort: row.effort as CreateOpts['effort'],
      fastMode: !!row.fastMode,
      permissionMode: row.permissionMode as CreateOpts['permissionMode'],
      title: row.title,
      resumeSessionId: row.sdkSessionId ?? undefined,
      orcaRole: row.orcaRole as 'worker' | null,
      vendorOptions: workerVendorOptions,
      // 远端 worker 唤醒必须带上 remoteHostId 并走 ensure (SSH 重连 / agent
      // 安装 / codex daemon MCP 注入), 否则会以远端 workingDir 在本机 spawn,
      // 且远端 daemon 的协同 MCP 通道不就绪。
      remoteHostId: row.remoteHostId ?? undefined,
      ...(extraDirs.length > 0 ? { extraDirs } : {}),
    });
    await ensureRemoteReadyForSessionStart({ createOpts: opts });
    const { session: resumedSession } = await bootstrapSession(opts);
    await markOrcaRoleIfNeeded(resumedSession.id, 'worker');
    return true;
  }

  // sessionId → remoteHostId 的进程内缓存 reader(lazy resume 路径每次 send 都
  // 经过 ensureRemoteReadyForSessionStart;实现与缓存语义见 localDb/ipc/sessions.ts,
  // DB 异常不缓存 null)。
  const readSessionRemoteHostIdCached = createSessionRemoteHostIdReader();

  /**
   * stale-bridge 谓词 (review R2 P2):bridge 的 provider 集合在启动时冻结;
   * Maker Memory 开关翻转而 codex busy 时, bridge 重建被
   * DeferredCodexRestartService 推迟, 窗口内活跃 bridge 缺 cindy_memory。
   * 远端链路 (per-session flag 钳制 / drift 判定) 必须以它为准 — 否则
   * prompt 注入与工具面失配、drift 追一个注不进去的 server 永不收敛。
   * 无活跃 bridge 时返回 false (接下来的 lazy 重建会产出与 manager 现值
   * 一致的新 bridge, 不构成缺失)。
   */
  function activeBridgeMissingMemory(): boolean {
    const bridgeServers = getActiveCodexBridgeServerNames();
    return bridgeServers !== null && !bridgeServers.includes(REMOTE_MEMORY_SERVER_NAME);
  }

  /** 远端会话视角的 Maker Memory 有效开关 = manager 现值 + stale-bridge 钳制。 */
  function remoteMakerMemoryEnabledForBridge(): boolean {
    return (maker.makerMemory?.isEnabled() ?? false) && !activeBridgeMissingMemory();
  }

  /**
   * live-send 轻量漂移判定 (hasPendingRemoteMcpDrift) 的 opts。函数而非常量:
   * 第二次判定发生在 ensure 之后, bridge 可能已 lazy 重建, 四个成分都要现读。
   */
  function codexRemoteDriftOpts() {
    return {
      collabEnabled: getPluginRegistry().isEnabled('collab'),
      // desired 集合要跟 ensure 实际能注入的集合同源 (stale-bridge 钳制),
      // 不能只看 manager 现值 — 否则旧 bridge 缺 cindy_memory 时 drift 永不
      // 收敛, 每次 live send 白跑完整 ensure。
      makerMemoryEnabled: remoteMakerMemoryEnabledForBridge(),
      token: getRemoteMcpBridgeToken(),
      bridgeInstanceId: getActiveCodexBridgeInstanceId(),
    };
  }

  async function ensureRemoteReadyForSessionStart(params: {
    session?: { agentKind: AgentKind; remoteHostId: string | null } | null;
    createOpts?: unknown;
  }): Promise<{ remoteCodexDaemonRebootstrapped: true } | void> {
    const { session, createOpts } = params;
    // Remote SSH auto-reconnect 前置: 拿 host 是否要联网在 maker-core 之前确定,
    // 避免 remote transport hook 同步抛 "not found in pool"。ensureRemoteHostReady
    // 是幂等的, 已 ready 直接返回。
    const sessRemoteHostId = session?.remoteHostId;
    const coRemoteHostId =
      createOpts && typeof createOpts === 'object'
        ? ((createOpts as { remoteHostId?: string }).remoteHostId ?? null)
        : null;
    let remoteHostIdToEnsure = sessRemoteHostId ?? coRemoteHostId;
    if (!remoteHostIdToEnsure) {
      // DB 兜底:live session 缺失 (lazy resume) 且调用方快照未带 remoteHostId
      // 时 (main 侧发起的 Orca worker 派活 / scheduler 等路径),从 sessions 行
      // 对齐——否则 remote worker 会以远端 workingDir 在本机 spawn。session 的
      // remoteHostId 创建后不变,进程内缓存安全。
      const sessionIdForLookup =
        (session as { id?: string } | null | undefined)?.id ??
        (createOpts && typeof createOpts === 'object'
          ? (createOpts as { id?: unknown }).id
          : null);
      if (typeof sessionIdForLookup === 'string' && sessionIdForLookup) {
        remoteHostIdToEnsure = await readSessionRemoteHostIdCached(sessionIdForLookup);
      }
    }
    if (!remoteHostIdToEnsure) return;

    if (createOpts && typeof createOpts === 'object') {
      const mutableCreateOpts = createOpts as { remoteHostId?: string; makerMemoryEnabled?: boolean };
      mutableCreateOpts.remoteHostId = remoteHostIdToEnsure;
      // SSH remote 与本地同语义:Maker Memory 跟随控制端设置 (scope 由
      // maker-core 按 remoteHostId+workingDir 隔离)。调用方显式给的值优先
      // (renderer 已按全局设置填);main 侧发起、快照缺该字段的路径 (Orca
      // worker 派活 / scheduler / lazy-resume 等) 按全局开关补齐 — 这里
      // 不得再强制 false (review R1 P1:此前的强制覆盖让远端会话永远
      // 拿不到记忆注入)。
      mutableCreateOpts.makerMemoryEnabled ??= maker.makerMemory?.isEnabled() ?? false;
      // stale-bridge 钳制 (见 activeBridgeMissingMemory):窗口内本会话统一
      // 按关闭注入 (prompt 与工具面同源), bridge 重建后新会话自然恢复。
      if (mutableCreateOpts.makerMemoryEnabled && activeBridgeMissingMemory()) {
        mutableCreateOpts.makerMemoryEnabled = false;
      }
    }

    await ensureRemoteHostReady(remoteHostIdToEnsure);
    const ensureAgentKind: 'claude-code' | 'codex' | 'pi' | null =
      session?.agentKind === 'codex' || session?.agentKind === 'claude-code' || session?.agentKind === 'pi'
        ? session.agentKind
        : createOpts && typeof createOpts === 'object'
          ? (() => {
              const ak = (createOpts as { agentKind?: unknown }).agentKind;
              return ak === 'codex' || ak === 'claude-code' || ak === 'pi' ? ak : null;
            })()
          : null;
    if (!ensureAgentKind) return;

    // claude-code 远端走 cc-mgr.mjs daemon。首次 /context 也必须像 send 一样
    // 触发 cc-manager 安装/升级, 否则 query/getContextUsage 可能因旧 bundle 不存在而失败。
    if (ensureAgentKind === 'claude-code') {
      const host = getRemoteSshPool().get(remoteHostIdToEnsure);
      if (host?.getStatus() !== 'ready') {
        throwIpcError('SSH_NOT_CONNECTED', `ssh host ${remoteHostIdToEnsure} not connected`);
      }
      await ensureCcManagerInstalledOrInstall({ host });
      return;
    }

    // pi 无远端(SSH)支持:capabilities 已拒 remote session,这里兜底跳过。
    if (ensureAgentKind === 'pi') return;
    await ensureRemoteAgentInstalledOrInstall(remoteHostIdToEnsure, ensureAgentKind);

    // codex 远端 daemon 的 MCP 注入 (cindy_orca / orca_worker_bridge 等经 SSH
    // remote-forward 直连本机 HTTP bridge):转发 / config.toml / daemon env
    // 就绪必须先于 transport 创建 (daemon discover/bootstrap)。best-effort —
    // 失败时 session 按"远端无 MCP"放行,与历史行为一致;协同类工具此时不可用。
    if (ensureAgentKind === 'codex') {
      const host = getRemoteSshPool().get(remoteHostIdToEnsure);
      if (host?.getStatus() === 'ready') {
        // proxy 对账必须先于 MCP bootstrap:marker 漂移时 reconcile 会 pkill
        // daemon, 若 MCP 先 bootstrap (带 token) 再被 pkill, transport
        // startDaemon 重启的 daemon 只有 proxy env 没有 LIZI_MCP_TOKEN —
        // 且 desiredFp===appliedFp 让 driftUnapplied 漏判, 协同 401 持续到
        // 下次 token/代际变化 (codex-connector R20 P1)。先 reconcile 让
        // 最后一次启动恒为携带双方的 MCP bootstrap;marker 一致时仅 1 次
        // cat RTT 零副作用。
        await reconcileCodexAgentProxyEnv(host);
        const result = await ensureRemoteCodexMcpBridge(host, {
          ensureBridgeStarted: ensureCodexMcpBridgeStartedForRemote,
          // config 漂移生效要重启 daemon, 重启会断同 host 的 live turn:
          // 有 turn 在跑时 config 照写但 bootstrap 推迟 (driftUnapplied 持久,
          // turn-done 挂钩补刀)。
          hasLiveTurnOnHost: codexRemoteHasLiveTurn,
          // collab 全局禁用 (Tier 4) 时按清理路径剥远端受管段 — bridge
          // 名单不反映开关 (codex-connector R20 P2)。
          isCollabEnabled: () => getPluginRegistry().isEnabled('collab'),
          // Maker Memory 全局开着时把 cindy_memory 一并注入远端 daemon config。
          isMakerMemoryEnabled: () => maker.makerMemory?.isEnabled() ?? false,
        });
        if (result.ok && result.daemonRebootstrapped && !codexRemoteHasLiveTurn(remoteHostIdToEnsure)) {
          await detachIdleRemoteCodexSessionsOnHost(remoteHostIdToEnsure, 'codex-mcp-daemon-rebootstrap');
          return { remoteCodexDaemonRebootstrapped: true };
        }
      }
    }
  }

  // 暴露给 maker-host 的 orca bridge deps:bridge rehydrate remote session 时
  // 直调 core createSession 不经 IPC 层, 经 holder 回调本函数补齐 preflight
  // (review: PR #778 codex-connector R17 P1)。
  setRemoteSessionStartEnsure(ensureRemoteReadyForSessionStart);

  // codex 远端 daemon 的 live-turn 判定 (ensure 与 turn-done 挂钩共用):
  // bootstrap 重启会断同 host 的 live turn, defer/补刀都以此为据。
  // function 声明 (hoisted):const 箭头形态下, 任何早于本行执行的调用路径
  // (如注册流程中被直线调用的 resume 分支) 都会 TDZ ReferenceError — 用
  // 声明消除整类风险 (reviewer R27 指出;当前调用点虽均在初始化后, 不
  // 留隐患)。
  function codexRemoteHasLiveTurn(hostId: string): boolean {
    return maker.listActiveSessions().some(
      (s) =>
        s.remoteHostId === hostId &&
        s.agentKind === 'codex' &&
        (agentInputCoordinatorHolder?.hasActiveTurnForRewind(s.id) ?? false),
    );
  }
  setRemoteCodexLiveTurnChecker(codexRemoteHasLiveTurn);
  // agent-proxy 的漂移应用 (重启 daemon / 迁移拆除隧道) 会打断该 host 上
  // **任一** agent 的在途流量 — 隧道是 codex 与 CC 共用的网络通路, gate
  // 必须两个通道都看 (R3 review P1), 不能沿用 MCP ensure 的 codex-only
  // 判定 (那边 daemon 重启只影响 codex, 语义不同)。
  function remoteAgentHasLiveTurn(hostId: string): boolean {
    return maker.listActiveSessions().some(
      (s) =>
        s.remoteHostId === hostId &&
        (s.agentKind === 'codex' || s.agentKind === 'claude-code') &&
        (agentInputCoordinatorHolder?.hasActiveTurnForRewind(s.id) ?? false),
    );
  }
  setAgentProxyLiveTurnChecker(remoteAgentHasLiveTurn);

  async function detachIdleRemoteCodexSessionsOnHost(hostId: string, reason: string): Promise<void> {
    const detachTasks: Array<Promise<void>> = [];
    for (const s of maker.listActiveSessions()) {
      if (s.remoteHostId !== hostId || s.agentKind !== 'codex') continue;
      if (agentInputCoordinatorHolder?.hasActiveTurnForRewind(s.id) ?? false) continue;
      detachTasks.push(
        s.detach().catch((err) => {
          log.warn('remote Codex session detach after daemon rebootstrap failed', {
            sessionId: s.id,
            hostId,
            reason,
            err: err instanceof Error ? err.message : String(err),
          });
        }),
      );
    }
    await Promise.all(detachTasks);
  }

  // turn 结束后补一次远端 MCP ensure (best-effort):live turn 期间被推迟的
  // daemon bootstrap (driftUnapplied 持久指纹, 见 codex-remote-mcp.ts) 在
  // idle 时点必然补刀 — 不等用户下次操作 (Greptile: defer 需要可靠自愈
  // 路径)。ensure 幂等, 无漂移时仅一次 config 读 + daemon 探活。经模块级
  // holder 供各 turn 收口路径调用。远端 CC 走 holder 的 detach 补偿
  // (bridge 重建 / 端口重绑已让 fresh 失效时重建 query)。
  refreshRemoteCodexMcpOnTurnSettledHolder = (sessionId: string): void => {
    const session = maker.getSession(sessionId);
    const remoteHostId = session?.remoteHostId;
    if (!remoteHostId) return;
    const host = getRemoteSshPool().get(remoteHostId);
    const hostReady = host?.getStatus() === 'ready';
    // agent-proxy 的 live-turn defer 在这里补刀 — codex 与 CC 的 turn 收口
    // 都算 (隧道是两个 agent 共用的通路, gate 也共用, R3 review P1)。只有
    // 确有 pending (defer / 失败) 时才跑, 稳态下不为每次 turn 结束白付一次
    // 远端 cat RTT。失败不阻断后续 (自身已重新记 pending)。
    const reconcileIfPending =
      hostReady && host && hasPendingAgentProxyReconcile(remoteHostId)
        ? reconcileCodexAgentProxyEnv(host).catch((err) => {
            log.warn('agent-proxy reconcile on turn settled failed', {
              sessionId,
              hostId: remoteHostId,
              err: err instanceof Error ? err.message : String(err),
            });
          })
        : Promise.resolve();
    if (session.agentKind === 'codex') {
      if (!hostReady || !host) return;
      // 与 session-start 路径同序: 先 reconcile 再 MCP ensure (codex R20 P1)。
      void reconcileIfPending
        .then(() =>
          ensureRemoteCodexMcpBridge(host, {
            ensureBridgeStarted: ensureCodexMcpBridgeStartedForRemote,
            hasLiveTurnOnHost: codexRemoteHasLiveTurn,
            isCollabEnabled: () => getPluginRegistry().isEnabled('collab'),
            isMakerMemoryEnabled: () => maker.makerMemory?.isEnabled() ?? false,
          }),
        )
        .then(async (result) => {
          if (result?.ok && result.daemonRebootstrapped && !codexRemoteHasLiveTurn(remoteHostId)) {
            await detachIdleRemoteCodexSessionsOnHost(remoteHostId, 'codex-mcp-turn-settled-rebootstrap');
          }
        });
      return;
    }
    if (session.agentKind === 'claude-code') {
      void reconcileIfPending;
      getRemoteCcTurnSettledHandler()?.(sessionId);
    }
  };

  const makerSessionRegistry = createElectronIpcHandlerRegistry();
  registerMakerSessionCreateHandler(
    makerSessionRegistry,
    {
      // CREATE_SESSION 同样先走 remote ensure:remote draft (尤其 collab
      // lead) 的 SSH 重连 / agent 安装 / codex daemon MCP 注入必须先于
      // bootstrap, 否则 lead 首个 turn 没有 cindy_orca, 与 orca 架构文档的
      // "session start/resume 前置" 契约不符。本地会话 ensure 内部直接返回。
      bootstrapSession: async (co) => {
        await ensureRemoteReadyForSessionStart({ createOpts: co });
        return bootstrapSession(co);
      },
      markOrcaRoleIfNeeded,
      markKnownNonOrcaIfApplicable,
      allocateDialogueWorkspace: ensureDialogueWorkspaceDir,
      createSessionId: createId,
      now: Date.now,
      withSessionLock: withSendToSessionLock,
      sendWorkerReadyMessage: (session) => {
        // Orca worker 首次创建时发一条初始化消息，强制 codex 写 rollout 文件，
        // 避免 app 重启后 thread/resume 因 rollout 缺失而失败。
        observeFireAndForgetSendOutcome(
          session.send({ type: 'user', content: ORCA_WORKER_READY_MESSAGE }, { planMode: false }),
          {
            owner: 'orca-worker-ready',
            entrypoint: 'CREATE_SESSION',
            sessionId: session.id,
            agentKind: session.agentKind,
            action: 'worker-ready-placeholder',
            context: `CREATE_SESSION/${session.id}/worker-ready-placeholder`,
          },
        );
      },
      broadcastSessionCreated,
      logCreateSession: (fields) => log.info('create-session invoked', fields),
      warnStderr: (agentKind, line) => log.warn(`[${agentKind}/stderr] ${line}`),
    },
  );

  registerPrecreatedWorktreeDiscardHandler(makerSessionRegistry, {
    assertCaller: (event) => {
      // device-link 的真实调用身份由 invoke async context + allowlist 证明；本机直调仍
      // 必须来自 Cindy 自有顶层 Renderer，不能把删除能力交给 WebView/Ghost。
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(
          event as Parameters<typeof assertTrustedAppRendererEvent>[0],
        );
      }
    },
    withSessionLock: withSendToSessionLock,
    isSessionClaimed: async (sessionId) => {
      if (maker.getSession(sessionId)) return true;
      const [row] = await getDbClient()
        .drizzle.select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return !!row;
    },
    discard: (sessionId, expectedPath, options) =>
      worktreeManager.discardPrecreatedWorktree(sessionId, expectedPath, options),
    discardByRecoveryKey: (sessionId, recoveryKey, options) =>
      worktreeManager.discardPrecreatedWorktreeByRecoveryKey(
        sessionId,
        recoveryKey,
        options,
      ),
  });

  // turn 运行中登记的切换意图(下一条消息发送时刻由 send 事务 apply)。
  const agentSwitchPending = createPendingAgentSwitchRegistry();
  cancelPendingAgentSwitchHolder = (sessionId) => {
    agentSwitchPending.clear(sessionId);
    broadcastSessionPatched(sessionId, {
      agentSwitchIntent: null,
      agentSwitchIntentCanceled: true,
    });
  };

  // session-agent-switch:lazy-create 前以 DB 行为真源校正 createOpts。切换后
  // 残留在 renderer store / 排队项里的旧 agentKind/resumeSessionId 若原样 spawn,
  // 会把会话劫持回旧引擎且丢交接注入(规则 9:代码兜底)。send 事务与
  // GET_CONTEXT_USAGE 的 lazy 分支共用(后者无校正曾是审计实锤缺口)。
  async function reconcileCreateOptsAgainstDb(sessionId: string, co: CreateOpts): Promise<void> {
    try {
      const db = getDbClient().drizzle;
      const [row] = await db
        .select({
          agentKind: sessions.agentKind,
          model: sessions.model,
          sdkSessionId: sessions.sdkSessionId,
          providerId: sessions.providerId,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) return;
      const dbMakerKind = dbToMakerAgentKind(row.agentKind);
      if (co.agentKind !== dbMakerKind) {
        log.warn('lazy-create: createOpts agentKind drifted from DB (agent switch); reconciling', {
          sessionId,
          staleAgentKind: co.agentKind,
          dbAgentKind: dbMakerKind,
        });
        co.agentKind = dbMakerKind;
      }
      // 意图制切换 / 凭证形态切换下,renderer 与排队项的 createOpts 快照构建于 send
      // 事务内 apply 之前。agentKind 可能已一致,但 model/resume/providerId/effort/fast
      // 仍是旧值；
      // 尤其 resumeSessionId 可能是**旧引擎**的原生会话 id——resume 会以错误引擎
      // 解释它)。lazy-create 时刻 DB 行是唯一真源,执行字段无条件对齐。
      co.model = row.model ?? undefined;
      co.resumeSessionId = row.sdkSessionId ?? undefined;
      co.providerId = row.providerId;
      co.effort = (row.effort ?? undefined) as CreateOpts['effort'];
      co.fastMode = !!row.fastMode;
    } catch {
      // 校正读库失败按原 opts 继续(与切换功能上线前行为一致)。
    }
  }

  const agentSwitchDeps: MakerSessionAgentSwitchHandlerDeps = {
    withSessionLock: withSendToSessionLock,
    // 停用轴边界裁决:目标路由被停用 → 抛错;隐式默认落点被停用 → 返回启用替代来源。
    assertModelRouteUsable: (agent, model, providerId) =>
      assertModelRouteUsable(agent, model, providerId),
    getSessionRow: async (sessionId) => {
      const db = getDbClient().drizzle;
      const [row] = await db
        .select({
          id: sessions.id,
          agentKind: sessions.agentKind,
          model: sessions.model,
          status: sessions.status,
          remoteHostId: sessions.remoteHostId,
          orcaRole: sessions.orcaRole,
          sdkSessionId: sessions.sdkSessionId,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },
    getLiveSession: (sessionId) => maker.getSession(sessionId),
    closeSession: (sessionId) => maker.closeSession(sessionId, 'agent-switch'),
    listMessagesForHandoff: (sessionId, after) => listMessagesForAgentHandoff(sessionId, 400, after),
    findParkedEngineSession: (sessionId, targetDbKind) =>
      findParkedEngineSession(sessionId, targetDbKind),
    applyAgentSwitchToDb: applyAgentSwitchToSessionRow,
    setSessionProvider,
    supersedePendingCredentialSwitch: clearPendingCredentialSwitchForSession,
    insertBoundaryMessage: async (sessionId, content) => {
      const clientId = `agent-switch:${createId()}`;
      await createDbMessage(sessionId, {
        clientId,
        role: 'agent_switch',
        content,
      });
      return clientId;
    },
    applyResumeFallbackAtomically: applyAgentSwitchResumeFallbackAtomically,
    setPendingHandoff: (sessionId, handoff, expectedGeneration) =>
      agentHandoffPending.set(sessionId, handoff, expectedGeneration),
    readPendingHandoffGeneration: (sessionId) => agentHandoffPending.readGeneration(sessionId),
    bootstrapSwitchedSession: async (sessionId) => {
      // 切换已提交,从 DB 行(新引擎值)重建 live session。resumeSessionId 直接取
      // 行上的 sdk_session_id:切换事务在有停泊绑定时已把它落成停泊 id(Phase 2
      // 切回续接),否则为 null = 全新原生会话,上下文由交接注入承接——与
      // lazy-create(reconcileCreateOptsAgainstDb)同一条 resume 口径。
      const db = getDbClient().drizzle;
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      if (!row) throw new Error(`session ${sessionId} row missing after agent switch`);
      if (!row.workingDir) {
        // 无 workingDir(理论上只有从未 send 过的草稿,不可能有可切换的历史):
        // 抛错走 engineReady=false 降级,下一条消息的 lazy-create 用其现有错误呈现。
        throw new Error(`session ${sessionId} has no workingDir; cannot bootstrap switched engine`);
      }
      const co = buildCreateOptsWithStderr({
        id: sessionId,
        agentKind: dbToMakerAgentKind(row.agentKind),
        workingDir: row.workingDir,
        model: row.model ?? undefined,
        providerId: row.providerId,
        effort: (row.effort ?? undefined) as CreateOpts['effort'],
        fastMode: !!row.fastMode,
        permissionMode: (row.permissionMode ?? 'ask') as CreateOpts['permissionMode'],
        planMode: false,
        title: row.title ?? undefined,
        resumeSessionId: row.sdkSessionId ?? undefined,
        // 远端会话切换引擎后仍是远端:带回 remoteHostId 并走 ensure (SSH
        // 重连 / agent 安装 / codex daemon MCP 注入), 否则会以远端
        // workingDir 在本机 spawn。
        remoteHostId: row.remoteHostId ?? undefined,
      });
      if (co.extraDirs === undefined) {
        try {
          const extraDirs = await readSessionExtraDirsFromDb(sessionId);
          if (extraDirs.length > 0) co.extraDirs = extraDirs;
        } catch (err) {
          log.warn('agent-switch bootstrap: read extra_dirs from DB failed (non-fatal)', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await ensureRemoteReadyForSessionStart({ createOpts: co });
      await bootstrapSession(co);
      broadcastSessionCreated(sessionId);
    },
    withCloseSuppressed: withRehydrateCloseSuppressed,
    pendingSwitches: agentSwitchPending,
    onPendingSwitchChanged: (sessionId, intent) => {
      broadcastSessionPatched(sessionId, { agentSwitchIntent: intent });
    },
    log,
  };
  registerMakerSessionAgentSwitchHandler(makerSessionRegistry, agentSwitchDeps);
  registerMakerMessageDeleteHandler(makerSessionRegistry, {
    getSessionRow: async (sessionId) => {
      const [row] = await getDbClient().drizzle
        .select({ status: sessions.status, agentKind: sessions.agentKind })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },
    getMessage: getMessageDeletionTarget,
    listMessagesForContext: (sessionId) => listMessagesForAgentHandoff(sessionId, 400),
    getLiveSession: (sessionId) => maker.getSession(sessionId),
    hasBackgroundActivity: getClaudeSessionBackgroundActivity,
    closeSession: (sessionId) => maker.closeSession(sessionId),
    commitDeletion: commitMessageDeletion,
    setPendingHandoff: (sessionId, handoff, expectedGeneration) =>
      agentHandoffPending.set(sessionId, handoff, expectedGeneration),
    readPendingHandoffGeneration: (sessionId) => agentHandoffPending.readGeneration(sessionId),
    onCommitted: ({ sessionId, deletedClientIds, updatedAt, preview }, requestedClientId) => {
      broadcastMessageDeleted({
        sessionId,
        clientId: requestedClientId,
        clientIds: deletedClientIds,
      });
      // 不带 _count:可见消息数不是列表的权威口径,拿它 patch 的错值会被 shallow merge 一直
      // 留住;权威口径受删除影响只有 0 或 +1,交给 sessions:list / reseed 收敛就够。
      // 见 commitMessageDeletion 的注释与 issue #1282。
      broadcastSessionPatched(sessionId, {
        sdkSessionId: null,
        updatedAt: new Date(updatedAt).toISOString(),
        preview,
      });
    },
    withCloseSuppressed: withRehydrateCloseSuppressed,
    log,
  });
  pendingAgentSwitchApplyHolder = async (sessionId, signal) => {
    const release = await acquireSendToSessionLock(sessionId);
    try {
      await applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId, {
        bootstrapAfterSwitch: true,
        signal,
      });
      return release;
    } catch (err) {
      release();
      throw err;
    }
  };

  ipcMain.handle(MAKER_INVOKE.MARK_ORCA_ROLE, async (_e, sessionId: unknown, role: unknown) => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    if (role !== 'worker' && role !== 'lead') throwIpcError('INVALID_PARAMS', 'invalid role');
    await markOrcaRoleIfNeeded(sessionId, role);
  });

  /**
   * enableOrcaInternal — 在已存在的 lead session 上开协同模式。
   *   1. 校验没有活跃 team(partial unique 也会兜底)
   *   2. 读 Lead session DB 配置 → 派生 Worker 默认 model/workingDir
   *   3. 创建 active team + Worker session(走 bootstrapSession 完整链路)
   *   4. 把 Worker 落到 orca_workers 表 + 标 orca_role='worker'
   *   5. 标 Lead orca_role='lead' + 清 knownNonOrcaSessionIds 缓存
   *   6. 若 Lead session 在线,立即调 setVendorOptions 让下一 turn 拿到协同 MCP
   *      (Lead 不在线就靠 sessions.orca_role + synthesizeOrcaVendorOptionsFromDb
   *       下次 spawn 时 rehydrate,语义一致)
   * 返回 { teamId, workerSessionId, workerId } 让 renderer 可直接路由 / 写本地状态。
   *
   * 共用 caller:
   *   - SESSION_ENABLE_ORCA IPC handler (renderer 手动 toggle 触发)
   * MCP 侧开 team 统一走 start_team + create_worker, 不再调用这个旧粗粒度入口。
   */
  async function enableOrcaInternal(
    leadSessionId: string,
    opts: EnableOrcaOptions,
  ): Promise<{
    teamId: string;
    workerSessionId: string;
    workerId: string;
    dispatched: boolean;
    dispatchOutcome?: CollabDispatchOutcome;
  }> {
    await assertLeadCollabProjectEnabled(leadSessionId);
    const result = await orcaLifecycleService.enableTeam({
      leadSessionId,
      workerAgent: opts.workerAgent,
      role: opts.role,
      label: opts.label,
      model: opts.model,
      effort: opts.effort,
      fast: opts.fast,
      providerId: opts.providerId,
      delegateTask: opts.delegateTask,
    });
    if (!result.ok) throwOrcaServiceFailure(result);
    log.info('enableOrca done', {
      leadSessionId,
      teamId: result.teamId,
      workerSessionId: result.workerSessionId,
      workerAgent: opts.workerAgent,
      delegated: !!opts.delegateTask?.trim(),
      dispatched: result.dispatched,
    });
    return {
      teamId: result.teamId,
      workerSessionId: result.workerSessionId,
      workerId: result.workerId,
      dispatched: result.dispatched,
      ...(result.dispatchOutcome ? { dispatchOutcome: result.dispatchOutcome } : {}),
    };
  }

  async function assertLeadCollabProjectEnabled(leadSessionId: string): Promise<void> {
    const lead = maker.getSession(leadSessionId);
    const leadRow = await getSessionRowSnapshot(leadSessionId);
    const rawWorkingDir =
      typeof leadRow?.workingDir === 'string' ? leadRow.workingDir : lead?.workDir;
    const normalizedWorkingDir =
      typeof rawWorkingDir === 'string'
        ? normalizeWorkingDirForProjectSettings(rawWorkingDir) ?? rawWorkingDir
        : rawWorkingDir;
    const liveWorkspaceKind = (lead as { workspaceKind?: unknown } | undefined)?.workspaceKind;
    const workspaceKind =
      liveWorkspaceKind === 'project' || liveWorkspaceKind === 'dialogue'
        ? liveWorkspaceKind
        : leadRow?.workspaceKind;
    assertCollabProjectEnabled(
      {
        workingDir: normalizedWorkingDir,
        workspaceKind,
        remoteHostId: lead?.remoteHostId ?? leadRow?.remoteHostId,
        agentKind: lead?.agentKind ?? leadRow?.agentKind ?? null,
      },
      (pluginId, workingDir) => getPluginRegistry().isEnabled(pluginId, workingDir),
      (workingDir) =>
        matchDialogueWorkspacePath(workingDir, dialogueWorkspaceRootDir()) !== null,
    );
  }

  type SendToSessionDispatchSession = {
    id: string;
    send(message: UserMessage | string, opts?: SessionSendOptions): Promise<SessionSendResult>;
  };

  async function sendUserMessageWithAwaitedGitBaseline(
    session: SendToSessionDispatchSession,
    message: string,
    opts: SessionSendOptions,
  ): Promise<SessionSendResult> {
    let baselineStarted = false;
    const pendingHandoff = await agentHandoffPending.peek(session.id);
    const outgoingMessage: UserMessage = pendingHandoff
      ? (prependHandoffToUserMessage({ type: 'user', content: message }, pendingHandoff) as UserMessage)
      : { type: 'user', content: message };
    try {
      const sendResult = await session.send(outgoingMessage, {
        ...opts,
        onAccepted: async () => {
          await opts.onAccepted?.();
          if (gitSnapshotCoordinator) {
            await gitSnapshotCoordinator.onTurnStart(session.id);
            baselineStarted = true;
          }
        },
      });
      if (baselineStarted && !sendResult.accepted) {
        gitSnapshotCoordinator?.onTurnAbort(session.id);
      }
      if (pendingHandoff && sendResult.accepted) {
        agentHandoffPending.consume(session.id);
      }
      return sendResult;
    } catch (err) {
      if (baselineStarted) {
        gitSnapshotCoordinator?.onTurnAbort(session.id);
      }
      throw err;
    }
  }

  async function sendToSessionInternal(
    params: {
      targetSessionId?: string;
      message: string;
      persistedContent?: string;
      clientId?: string;
      dispatcherSessionId?: string;
      title?: string;
      useWorktree?: boolean;
      /** create 分支可选:新 session 的工作目录覆盖(绝对路径,须已存在;jump 忽略)。#811 */
      workingDir?: string;
      onAccepted?: () => void | Promise<void>;
      onAcceptedRollback?: () => void | Promise<void>;
      origin?: AgentInputQueuedMessage['origin'];
      createDefaults?: SendToSessionCreateDefaults;
      /** 安全调用方可要求新会话不比来源会话拥有更高的权限。 */
      inheritSourcePermissionMode?: boolean;
    },
  ): Promise<SendToSessionInternalResult> {
    const {
      targetSessionId,
      message,
      persistedContent,
      clientId: explicitClientId,
      dispatcherSessionId,
      title,
      useWorktree,
      workingDir: workingDirOverride,
      onAccepted,
      onAcceptedRollback,
      origin,
      createDefaults,
      inheritSourcePermissionMode,
    } = params;
    if (!message) {
      return {
        ok: false,
        errorCode: 'INVALID_ARGS',
        message: 'message required',
      };
    }

    // ── create 分支 ──────────────────────────────────────────────────────────
    // 不传 targetSessionId → 为业务对象起一个全新的专属 session,继承 dispatcher
    // (调用方)session 的配置后投递首条消息,把新 id 回传给调用方建立关联。
    // 新 id 是 fresh 的,不存在并发竞争,因此不进 sendToSessionLocks。
    if (!targetSessionId) {
      if (!dispatcherSessionId && !createDefaults) {
        return {
          ok: false,
          errorCode: 'LEAD_NOT_SUPPORTED',
          message:
            'create requires a dispatcher session context to inherit config; ' +
            'current MCP call has none (typical: Codex global ctx)',
        };
      }
      let createdPreviewSessionId: string | null = null;
      let createdPreviewClientId: string | null = null;
      let createdPreviewStarted = false;
      let handoffWorktree: { sessionId: string; meta: WorktreeMeta } | null = null;
      try {
        const db = getDbClient().drizzle;
        let inherited: SendToSessionCreateDefaults;
        if (dispatcherSessionId) {
          // agentKind/workDir/model 取规范化后的 meta(与 jump 路径同源,绕开 DB 里
          // agent_kind 的 'cc' 旧值歧义);effort/fastMode 从 DB 行补全。
          const meta = await maker.getSessionMeta(dispatcherSessionId).catch(() => null);
          if (!meta) {
            return {
              ok: false,
              errorCode: 'NOT_FOUND',
              message: `dispatcher session ${dispatcherSessionId} not found`,
            };
          }
          // working_dir 覆盖(#811):把新 session 落到指定项目目录,而不是恒继承
          // dispatcher 的目录。先于 worktree 预建校验——use_worktree 的 base 仓库
          // 也从覆盖后的目录(校验器规范化后的形态)解析。
          let resolvedWorkDir = meta.workDir;
          if (workingDirOverride !== undefined) {
            // 远程 SSH 会话的 workDir 是远端路径,本机 stat 校验对它无意义
            // (本机恰好同名目录会假阳性、远端合法目录会假阴性)——fail-closed
            // 拒绝,待远程校验通道具备后再放开。
            if (meta.remoteHostId) {
              return {
                ok: false,
                errorCode: 'INVALID_ARGS',
                message: 'working_dir 暂不支持远程任务(远端路径无法在本机校验)',
              };
            }
            const checked = await validateHandoffWorkingDir(workingDirOverride);
            if (!checked.ok) {
              return { ok: false, errorCode: 'INVALID_ARGS', message: checked.message };
            }
            resolvedWorkDir = checked.dir;
          }
          // useWorktree:为新 session 预建正规 session worktree(与 UI 新会话勾选
          // worktree 同类:worktreeStore 绑定 + 关闭时 auto-stash 清理),新 session 的
          // id 必须用预生成的那个(worktree 绑定已按它登记)。失败硬报 WORKTREE_UNAVAILABLE
          // ——调用方显式要隔离,静默降级会让新 session 落在共享工作树里(dispatcher 若在
          // ephemeral worktree 里跑,新 session 还会随那个 worktree 一起被回收)。
          if (useWorktree) {
            const prep = await prepareHandoffWorktree(
              {
                getForSession: worktreeManager.getForSession,
                listAll: worktreeManager.listAll,
                detectCwd: worktreeManager.detectCwd,
                suggestName: worktreeManager.suggestName,
                listBranches: worktreeManager.listBranches,
                resolveCommit: worktreeManager.revParseCommit,
                createWorktree: worktreeManager.createWorktree,
                createId: () => randomUUID(),
                resolveFreshSource: resolveFreshSourceBranch,
              },
              // working_dir 覆盖时不带 dispatcherSessionId:resolveHandoffBaseRepo
              // 的「dispatcher 自身 worktree」捷径按路径包含判定——覆盖目录若指向
              // dispatcher worktree 树内的**嵌套独立仓库**,捷径会跳过 detectCwd、
              // 误用 dispatcher 的 baseRepo。去掉捷径后 detectCwd 按目录自身探测
              // git 根;覆盖目录落在登记过的 worktree 内时,listAll 反查分支仍生效。
              workingDirOverride !== undefined ? undefined : dispatcherSessionId,
              resolvedWorkDir,
            );
            if (!prep.ok) {
              return { ok: false, errorCode: 'WORKTREE_UNAVAILABLE', message: prep.message };
            }
            handoffWorktree = { sessionId: prep.sessionId, meta: prep.meta };
          }
          const [row] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.id, dispatcherSessionId))
            .limit(1);
          inherited = {
            agentKind: meta.agentKind,
            workingDir: resolvedWorkDir,
            // 覆盖目录必有真实项目目录 → 归 project 工作区(标题/侧栏分组按项目
            // 语义走);未覆盖时保持缺省继承,行为不变。
            ...(workingDirOverride !== undefined ? { workspaceKind: 'project' as const } : {}),
            model: meta.model,
            effort: (row?.effort ?? undefined) as SendToSessionCreateDefaults['effort'],
            fastMode: !!row?.fastMode,
            providerId: row?.providerId,
            // working_dir 覆盖时强制继承来源会话的权限档(review 反馈):把新目录
            // 以 Full access 打开是相对 dispatcher 的权限升级,跨项目 handoff
            // 不应隐式发生;未覆盖时保持既有缺省(bypassPermissions)不变。
            permissionMode:
              inheritSourcePermissionMode || workingDirOverride !== undefined
                ? permissionModeOrAsk(row?.permissionMode)
                : 'bypassPermissions',
          };
        } else {
          if (useWorktree) {
            return {
              ok: false,
              errorCode: 'WORKTREE_UNAVAILABLE',
              message: 'createDefaults cannot create a worktree without a dispatcher session',
            };
          }
          inherited = createDefaults!;
        }
        const newTitle = title?.trim() || message.split('\n')[0].slice(0, 60);
        const createOpts = buildCreateOptsWithStderr({
          ...(handoffWorktree ? { id: handoffWorktree.sessionId } : {}),
          agentKind: inherited.agentKind,
          workspaceKind: inherited.workspaceKind,
          workingDir: handoffWorktree ? handoffWorktree.meta.path : inherited.workingDir,
          model: inherited.model,
          effort: inherited.effort as CreateOpts['effort'],
          fastMode: !!inherited.fastMode,
          providerId: inherited.providerId,
          title: newTitle,
          permissionMode: inherited.permissionMode ?? 'bypassPermissions',
        });
        const { session } = await bootstrapSession(createOpts);
        // worktree 场景补写 sessions.worktree_path 反范式快照:createWorktree 时
        // session 行还不存在,worktreeStore.set 的 DB 同步落空(仅 warn),这里 session
        // 行已建,补一次。失败非致命——徽标以 worktreeStore 为准。
        if (handoffWorktree) {
          try {
            await db
              .update(sessions)
              .set({ worktreePath: handoffWorktree.meta.path })
              .where(eq(sessions.id, session.id));
          } catch (err) {
            log.warn('sendToSession create: sync worktree_path to DB failed (non-fatal)', {
              sessionId: session.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        const clientId = createId();
        createdPreviewSessionId = session.id;
        createdPreviewClientId = clientId;
        const sendResult = await sendUserMessageWithAwaitedGitBaseline(session, message, {
          planMode: false,
          onAccepted: async () => {
            notifyAgentIslandUserPrompt(session, persistedContent ?? message, {
              source: 'send_to_session:create:onPersisting',
              clientId,
            });
            createdPreviewStarted = true;
            await createDbMessage(session.id, {
              clientId,
              role: 'user',
              content: persistedContent ?? message,
            });
            // F4: send_to_session 的 create 分支也建了一条用户可见新会话(有 title + 落了 user
            // 消息),同属"新建会话需同步所有窗侧栏"的 purpose。广播跟 user row 持久化
            // 保持同一个 accepted 边界,避免后续 handle.send 失败时侧栏漏刷新。
            // (jump/resume 分支是既有 session 重建,不在此发,见 wakeKind:'resumed' 分支。)
            broadcastSessionCreated(session.id);
          },
          onDispatching: () => dispatchAgentIslandUserPrompt(session.id),
        });
        if (createdPreviewStarted) {
          if (sendResult.accepted) {
            commitAgentIslandUserPrompt(session.id, clientId);
          } else {
            rollbackAgentIslandUserPrompt(session.id, clientId, 'send_to_session:create:not-dispatched');
          }
        }
        assertDesktopSendDispatched(sendResult, 'send_to_session create');
        log.info('sendToSession created new session', {
          dispatcherSessionId,
          newSessionId: session.id,
          agentKind: session.agentKind,
          worktreePath: handoffWorktree?.meta.path ?? null,
        });
        return {
          ok: true,
          targetSessionId: session.id,
          agentKind: inherited.agentKind,
          wakeKind: 'created',
          targetTitle: newTitle,
          targetLastUserSendAt: null,
          worktreePath: handoffWorktree?.meta.path ?? null,
        };
      } catch (err) {
        if (createdPreviewStarted && createdPreviewSessionId && createdPreviewClientId) {
          rollbackAgentIslandUserPrompt(
            createdPreviewSessionId,
            createdPreviewClientId,
            'send_to_session:create:failed-before-dispatch',
          );
        }
        // worktree 已建而 session 未建成 → 回收,避免无主目录与 store 绑定残留;
        // session 已建成(createdPreviewSessionId 非空)则绝不回收——判据与理由见
        // shouldRecycleHandoffWorktreeOnFailure 的注释(删了会造成指向不存在目录的
        // 孤儿会话,BUSY 分支还有 turn 正在其中跑)。best-effort。
        if (
          handoffWorktree &&
          shouldRecycleHandoffWorktreeOnFailure(createdPreviewSessionId !== null)
        ) {
          void worktreeManager
            .removeWorktreeForSession(handoffWorktree.sessionId)
            .catch(() => undefined);
        }
        if (isSessionRunningError(err)) {
          return {
            ok: false,
            errorCode: 'BUSY',
            message: 'new session has a turn in progress',
          };
        }
        return {
          ok: false,
          errorCode: 'AGENT_NOT_READY',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const prev = sendToSessionLocks.get(targetSessionId);
    const waitPrev = prev ? prev.catch(() => undefined) : Promise.resolve();
    const run = waitPrev.then(async () => {
      const [meta, dbRow] = await Promise.all([
        maker.getSessionMeta(targetSessionId).catch(() => null),
        getSessionRowSnapshot(targetSessionId),
      ]);

      if (!meta || !dbRow) {
        return {
          ok: false as const,
          errorCode: 'NOT_FOUND' as const,
          message: `session ${targetSessionId} not found`,
        };
      }
      if (dbRow.status === 'archived') {
        return {
          ok: false as const,
          errorCode: 'ARCHIVED' as const,
          message: `session ${targetSessionId} is archived`,
        };
      }
      if (dbRow.status === 'deleted') {
        return {
          ok: false as const,
          errorCode: 'DELETED' as const,
          message: `session ${targetSessionId} is deleted`,
        };
      }

      // 崩溃恢复:在路由决策前加载快照,确保恢复的排队 prompt 不被跳过。
      // 失败时 shouldQueueNewTurn 仍返回 true(未恢复即入队),消息不丢。
      await inputCoordinator.ensureQueueRestored(targetSessionId).catch(() => undefined);
      if (inputCoordinator.shouldQueueNewTurn(targetSessionId)) {
        const qClientId = explicitClientId ?? createId();
        await enqueueSendToSessionMessage({
          targetSessionId,
          message,
          persistedContent: persistedContent ?? message,
          clientId: qClientId,
          meta,
          dbRow,
          onAccepted,
          onAcceptedRollback,
          origin,
        });
        return {
          ok: true as const,
          targetSessionId,
          agentKind: meta.agentKind,
          wakeKind: 'queued' as const,
          targetTitle: dbRow.title,
          targetLastUserSendAt: dbRow.userSendAt !== null
            ? new Date(dbRow.userSendAt).toISOString()
            : null,
        };
      }

      const clientId = explicitClientId ?? createId();
      let userPromptPreviewStarted = false;
      const previewSessionMeta = {
        id: targetSessionId,
        agentKind: meta.agentKind,
        workDir: meta.workDir,
      };
      const persistUserMessage = async (): Promise<void> => {
        // 同 sendPersistedUserMessageToSession 的顺序硬约束: durable write 失败则不启动
        // turn,业务 accepted 副作用不生效。灵动岛 preview 提前到落库前以贴近用户发送
        // 瞬间;失败或未 dispatch 时由外层 rollback 恢复,避免留下假的 running card。
        notifyAgentIslandUserPrompt(previewSessionMeta, persistedContent ?? message, {
          source: 'send_to_session:persist:onPersisting',
          clientId,
        });
        userPromptPreviewStarted = true;
        await createDbMessage(targetSessionId, {
          clientId,
          role: 'user',
          content: persistedContent ?? message,
        });
        await runAcceptedCallback(onAccepted, targetSessionId, clientId);
      };

      let live = maker.getSession(targetSessionId);
      if (live) {
        if (live.isTurnRunning?.()) {
          await enqueueSendToSessionMessage({
            targetSessionId,
            message,
            persistedContent: persistedContent ?? message,
            clientId,
            meta,
            dbRow,
            onAccepted,
            onAcceptedRollback,
            origin,
          });
          return {
            ok: true as const,
            targetSessionId,
            agentKind: meta.agentKind,
            wakeKind: 'queued' as const,
            targetTitle: dbRow.title,
            targetLastUserSendAt: dbRow.userSendAt !== null
              ? new Date(dbRow.userSendAt).toISOString()
              : null,
          };
        }
        // idle-live send 前的轻量 MCP 漂移判定 (纯本地, 零远程 RTT):
        // bridge shutdown strip / token 轮换 / bridge 重建 / 端口重绑后,
        // live 直发路径原本不经任何 ensure, daemon 会带着死 URL / 空 env
        // 跑到 turn-done 才恢复 (codex-connector R23 P1)。命中漂移才走完整
        // remote ensure (含 lazy 重建 bridge), 无漂移零开销。
        if (
          live.remoteHostId &&
          live.agentKind === 'codex' &&
          hasPendingRemoteMcpDrift(live.remoteHostId, codexRemoteDriftOpts())
        ) {
          const ensureResult = await ensureRemoteReadyForSessionStart({ session: live });
          // ensure 完整生效 ⇒ daemon 已 (重) bootstrap ⇒ 长命 transport
          // (到旧 daemon socket 的 proxy channel) 已死 — 继续用 live 直发
          // 会把首条消息送进失效 transport, 用户先撞一次 transport error
          // 才能靠 ensureStarted 自愈 (codex-connector R25 P1)。与 cc stale
          // 同构:detach 落 lazy-resume 直接重建。drift 未清 = 他处有 live
          // turn 在 defer, daemon 未重启, transport 仍活, 保持直发。
          if (ensureResult?.remoteCodexDaemonRebootstrapped) {
            live = undefined;
          } else {
            const driftCleared = !hasPendingRemoteMcpDrift(live.remoteHostId, codexRemoteDriftOpts());
            if (driftCleared) {
              try {
                await live.detach();
              } catch (err) {
                log.warn('sendToSession: detach after drift rebootstrap failed, falling through to lazy-resume', {
                  targetSessionId,
                  err: err instanceof Error ? err.message : String(err),
                });
              }
              live = undefined;
            }
          }
        }
        // 远端 CC 的 invalidate 竞态 (codex-connector R23 P2):invalidate
        // (bridge 重建 / 端口重绑 / shutdown) 的 detach 是 fire-and-forget,
        // session 在 detach 完成前仍 active — 此时直发会进带旧 MCP URL 的
        // query。stale 命中时先同步 detach 再落 lazy-resume (forceFresh)。
        if (
          live !== undefined &&
          live.remoteHostId &&
          live.agentKind === 'claude-code' &&
          getRemoteCcStaleQuery()?.(live.id) === true
        ) {
          try {
            await live.detach();
          } catch (err) {
            log.warn('sendToSession: detach stale remote CC session failed, falling through to lazy-resume', {
              targetSessionId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
          // detach 后不得继续 live 直发 (session 已 closed) — 置空落入
          // 下方 lazy-resume (bootstrap 重建 → factory forceFresh)。
          live = undefined;
        }
      }
      if (live) {
        try {
          const sendResult = await sendUserMessageWithAwaitedGitBaseline(
            live,
            message,
            {
              planMode: false,
              onAccepted: persistUserMessage,
              onDispatching: () => dispatchAgentIslandUserPrompt(targetSessionId),
            },
          );
          if (userPromptPreviewStarted) {
            if (sendResult.accepted) {
              commitAgentIslandUserPrompt(targetSessionId, clientId);
            } else {
              rollbackAgentIslandUserPrompt(targetSessionId, clientId, 'send_to_session:live:not-dispatched');
            }
          }
          assertDesktopSendDispatched(sendResult, 'send_to_session live');
          return {
            ok: true as const,
            targetSessionId,
            agentKind: meta.agentKind,
            wakeKind: 'already-active' as const,
            targetTitle: dbRow.title,
            targetLastUserSendAt: dbRow.userSendAt !== null
              ? new Date(dbRow.userSendAt).toISOString()
              : null,
          };
        } catch (err) {
          if (isSessionRunningError(err)) {
            if (userPromptPreviewStarted) {
              rollbackAgentIslandUserPrompt(targetSessionId, clientId, 'send_to_session:live:queued-before-dispatch');
            }
            await enqueueSendToSessionMessage({
              targetSessionId,
              message,
              persistedContent: persistedContent ?? message,
              clientId,
              meta,
              dbRow,
              onAccepted,
              onAcceptedRollback,
              origin,
            });
            return {
              ok: true as const,
              targetSessionId,
              agentKind: meta.agentKind,
              wakeKind: 'queued' as const,
              targetTitle: dbRow.title,
              targetLastUserSendAt: dbRow.userSendAt !== null
                ? new Date(dbRow.userSendAt).toISOString()
                : null,
            };
          }
          if (userPromptPreviewStarted) {
            rollbackAgentIslandUserPrompt(targetSessionId, clientId, 'send_to_session:live:failed-before-dispatch');
          }
          return {
            ok: false as const,
            errorCode: 'INTERNAL' as const,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      try {
        const createOpts = buildCreateOptsWithStderr({
          id: targetSessionId,
          agentKind: meta.agentKind,
          workingDir: meta.workDir,
          model: meta.model,
          resumeSessionId: meta.sdkSessionId,
          permissionMode: 'bypassPermissions',
        });
        await synthesizeOrcaVendorOptionsFromDb(targetSessionId, createOpts);
        if (createOpts.extraDirs === undefined) {
          try {
            const row = await readSessionExtraDirsFromDb(targetSessionId);
            if (row.length > 0) createOpts.extraDirs = row;
          } catch (err) {
            log.warn('sendToSession: read extra_dirs from DB failed (non-fatal)', {
              targetSessionId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // lazy-resume 也要走 remote ensure:Orca 派活 / scheduler 等 main 侧
        // 通路不带 remoteHostId 快照, ensure 内部会从 sessions 行兜底回填并
        // 完成 SSH 重连 / agent 安装 / codex daemon MCP 注入。
        await ensureRemoteReadyForSessionStart({ createOpts });
        const { session } = await bootstrapSession(createOpts);
        await markOrcaRoleIfNeeded(session.id, createOpts.orcaRole);
        const sendResult = await sendUserMessageWithAwaitedGitBaseline(
          session,
          message,
          {
            planMode: false,
            onAccepted: persistUserMessage,
            onDispatching: () => dispatchAgentIslandUserPrompt(targetSessionId),
          },
        );
        if (userPromptPreviewStarted) {
          if (sendResult.accepted) {
            commitAgentIslandUserPrompt(targetSessionId, clientId);
          } else {
            rollbackAgentIslandUserPrompt(targetSessionId, clientId, 'send_to_session:resumed:not-dispatched');
          }
        }
        assertDesktopSendDispatched(sendResult, 'send_to_session resumed');
        return {
          ok: true as const,
          targetSessionId,
          agentKind: meta.agentKind,
          wakeKind: 'resumed' as const,
          targetTitle: dbRow.title,
          targetLastUserSendAt: dbRow.userSendAt !== null
            ? new Date(dbRow.userSendAt).toISOString()
            : null,
        };
      } catch (err) {
        if (isSessionRunningError(err)) {
          if (userPromptPreviewStarted) {
            rollbackAgentIslandUserPrompt(targetSessionId, clientId, 'send_to_session:resumed:queued-before-dispatch');
          }
          await enqueueSendToSessionMessage({
            targetSessionId,
            message,
            persistedContent: persistedContent ?? message,
            clientId,
            meta,
            dbRow,
            onAccepted,
            onAcceptedRollback,
            origin,
          });
          return {
            ok: true as const,
            targetSessionId,
            agentKind: meta.agentKind,
            wakeKind: 'queued' as const,
            targetTitle: dbRow.title,
            targetLastUserSendAt: dbRow.userSendAt !== null
              ? new Date(dbRow.userSendAt).toISOString()
              : null,
          };
        }
        if (userPromptPreviewStarted) {
          rollbackAgentIslandUserPrompt(targetSessionId, clientId, 'send_to_session:resumed:failed-before-dispatch');
        }
        return {
          ok: false as const,
          errorCode: 'AGENT_NOT_READY' as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    });

    const tracked = run.finally(() => {
      if (sendToSessionLocks.get(targetSessionId) === tracked) {
        sendToSessionLocks.delete(targetSessionId);
      }
    });
    sendToSessionLocks.set(targetSessionId, tracked);
    return tracked;
  }

  // Ghost 的 Agent 槽只负责验证权限和整理 prompt；真正的新回合仍走
  // sendToSessionInternal 这一条主机通路，因此会话恢复、繁忙排队、消息落库与
  // 费用行为都和用户亲自在聊天框发送一致。runner 通过回调注入，避免
  // cindy-brain 反向依赖 maker-ipc 形成模块环。
  setGhostAgentTurnRunner(async (request) => {
    const dispositionForWakeKind = (
      wakeKind: Extract<SendToSessionInternalResult, { ok: true }>['wakeKind'],
    ): 'created' | 'resumed' | 'active' | 'queued' => {
      switch (wakeKind) {
        case 'created':
          return 'created';
        case 'resumed':
          return 'resumed';
        case 'already-active':
          return 'active';
        case 'queued':
          return 'queued';
      }
    };

    if (request.mode === 'new') {
      const result = await sendToSessionInternal({
        dispatcherSessionId: request.sourceSessionId,
        message: request.prompt,
        persistedContent: request.persistedContent,
        inheritSourcePermissionMode: true,
        ...(request.title ? { title: request.title } : {}),
      });
      if (!result.ok) return result;
      return {
        ok: true,
        sessionId: result.targetSessionId,
        disposition: dispositionForWakeKind(result.wakeKind),
      };
    }

    if (request.mode === 'continue') {
      const result = await sendToSessionInternal({
        targetSessionId: request.sourceSessionId,
        message: request.prompt,
        persistedContent: request.persistedContent,
      });
      if (!result.ok) return result;
      return {
        ok: true,
        sessionId: result.targetSessionId,
        disposition: dispositionForWakeKind(result.wakeKind),
      };
    }

    // fork 必须基于一条已经完成的 assistant 回复。这里固定选择当前有效历史里
    // 最新一条回复，让插件只能表达“从现在这里分叉”，不能偷偷挑更早的消息。
    const [latestAssistant] = await getDbClient().drizzle
      .select({ clientId: messages.clientId })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, request.sourceSessionId),
          eq(messages.role, 'assistant'),
          isNull(messages.rewindAt),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(1);
    if (!latestAssistant?.clientId) {
      return {
        ok: false,
        errorCode: 'NO_PRIOR_ASSISTANT',
        message: '原任务还没有可用于分叉的 Agent 回复',
      };
    }

    let forkedSessionId: string;
    try {
      const forked = await forkSessionAtMessage(
        request.sourceSessionId,
        latestAssistant.clientId,
      );
      forkedSessionId = forked.id;
      broadcastSessionCreated(forked.id);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'SOURCE_NOT_FOUND' || code === 'MESSAGE_NOT_FOUND') {
        return { ok: false, errorCode: 'NOT_FOUND', message };
      }
      if (code === 'SOURCE_NEVER_RAN' || code === 'NO_PRIOR_ASSISTANT') {
        return { ok: false, errorCode: code, message };
      }
      if (code === 'UNSUPPORTED_HISTORY') {
        return { ok: false, errorCode: 'FORK_UNSUPPORTED_HISTORY', message };
      }
      return { ok: false, errorCode: `FORK_${code ?? 'FAILED'}`, message };
    }

    const sent = await sendToSessionInternal({
      targetSessionId: forkedSessionId,
      message: request.prompt,
      persistedContent: request.persistedContent,
    });
    if (!sent.ok) return sent;
    return {
      ok: true,
      sessionId: forkedSessionId,
      disposition: 'forked',
    };
  });

  // Ghost 的派活取件(agent 槽 errand 加档):守门在 cindy-brain/errandSlot,
  // 这里注入真实执行链——专属会话确保/统一投递/turn 收口。投递仍走
  // sendToSessionInternal 这一条主机通路(消息落库、进程拉起与用户亲发一致);
  // 收口复用 hook-control 的 observeHookTurn(与飞书 bot 同一套 turn 观察语义)。
  setGhostErrandRunner(
    createGhostErrandRunner({
      readConfig: readGhostErrandConfig,
      readSessionId: readGhostErrandSessionId,
      writeSessionId: writeGhostErrandSessionId,
      getSessionRow: async (sessionId) => {
        const [row] = await getDbClient().drizzle
          .select({
            status: sessions.status,
            agentKind: sessions.agentKind,
            model: sessions.model,
            permissionMode: sessions.permissionMode,
            workingDir: sessions.workingDir,
            workspaceKind: sessions.workspaceKind,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        return row ?? null;
      },
      createSession: async (params) => {
        const sessionId = await createGhostErrandSession({
          ...params,
          notifySessionCreated: (info) => notifyGhostSessionEvent('created', info),
        });
        // errand 会话在侧边栏可见(与 workspace 槽同通道刷新)——透明是这个
        // 能力的安全边界之一,不做隐藏会话。
        broadcastSessionCreated(sessionId);
        return sessionId;
      },
      getGhostName: getInstalledGhostName,
      getDraftDefaults: getWorkerDefaultsFromNewMaker,
      normalizeWorkingDir: (dir) => normalizeWorkingDirForStorage(dir),
      isUserPickedDir: isGhostPickedDir,
      isSessionBusy: isSessionInTurn,
      dispatch: async ({ targetSessionId, message }) => {
        const r = await sendToSessionInternal({ targetSessionId, message });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, wakeKind: r.wakeKind };
      },
      getObservableSession: (sessionId) => maker.getSession(sessionId) ?? null,
      onSilentStopSettled,
      readLatestAssistantText: async (sessionId, sinceMs) => {
        const [row] = await getDbClient().drizzle
          .select({ content: messages.content })
          .from(messages)
          .where(
            and(
              eq(messages.sessionId, sessionId),
              eq(messages.role, 'assistant'),
              isNull(messages.rewindAt),
              gte(messages.createdAt, sinceMs),
            ),
          )
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(1);
        if (!row) return null;
        const text = visibleMessageTextForConversationSearch('assistant', row.content ?? '');
        return text.length > 0 ? text : null;
      },
      log: {
        info: (message, meta) => log.info(message, meta),
        warn: (message, meta) => log.warn(message, meta),
      },
    }),
  );

  // Ghost 的 workspace 槽:判重/创建走 localDb 服务,创建后广播与 scheduler
  // 同一条 `local-db:sessions:created` 通道让侧边栏刷新;focus 复用 deep link
  // 的会话聚焦通道。注入方式与 setGhostAgentTurnRunner 同款倒置,避免
  // cindy-brain 反向依赖 maker-ipc / localDb 形成模块环。
  setGhostWorkspaceSessionService({
    findActiveSessionByWorkdir,
    createDraftSession: async (params) => {
      // draft 跟随用户在 New Maker 面板的当前选择,与用户手建草稿的默认体验
      // 一致。main 侧缓存没有"当前激活 vendor"信号,取有选择记录的一档:
      // cc 有记录用 cc;cc 无则 codex;再无则 pi(整套跟随,避免给 pi-only 用户
      // 建出带 Claude 默认值的会话);都没有走 mapper 兜底。
      const ccDefaults = getWorkerDefaultsFromNewMaker('claude-code');
      const codexDefaults = ccDefaults.model ? null : getWorkerDefaultsFromNewMaker('codex');
      const piDefaults =
        ccDefaults.model || codexDefaults?.model ? null : getWorkerDefaultsFromNewMaker('pi');
      const picked = ccDefaults.model
        ? { agentKind: 'cc' as const, d: ccDefaults }
        : codexDefaults?.model
          ? { agentKind: 'codex' as const, d: codexDefaults }
          : piDefaults?.model
            ? { agentKind: 'pi' as const, d: piDefaults }
            : null;
      const sessionId = await createPluginDraftSession({
        ...params,
        ...(picked
          ? {
              defaults: {
                agentKind: picked.agentKind,
                ...(picked.d.model ? { model: picked.d.model } : {}),
                ...(picked.d.effort ? { effort: picked.d.effort } : {}),
                ...(picked.d.fastMode !== undefined ? { fastMode: picked.d.fastMode } : {}),
                ...(picked.d.providerId !== undefined ? { providerId: picked.d.providerId } : {}),
              },
            }
          : {}),
        notifySessionCreated: (info) => notifyGhostSessionEvent('created', info),
      });
      broadcastSessionCreated(sessionId);
      return sessionId;
    },
    focusSession: (sessionId) => openMainWindowSession(sessionId),
  });

  // 排队项会进 pendingQueue projection, 经 Electron IPC 结构化克隆发给 renderer,
  // vendorOptions 里只能保留原始值条目 —— buildCreateOptsWithStderr 注入的
  // onStderrLine 函数、orca rehydrate 塞的运行时对象都克隆不了, 不剥掉
  // 整条 projection 广播 / get-projection invoke 都会抛 "object could not be cloned"。
  // drain 真正派发时 sendToAgentAccepted 会重新走 buildCreateOptsWithStderr +
  // synthesizeOrcaVendorOptionsFromDb 补齐这些运行时字段, 队列里不需要携带。
  function sanitizeVendorOptionsForQueuedItem(
    vendorOptions: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!vendorOptions) return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(vendorOptions)) {
      const t = typeof value;
      if (value === null || t === 'string' || t === 'number' || t === 'boolean') out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async function buildCreateOptsForQueuedSession(
    sessionId: string,
    meta: NonNullable<Awaited<ReturnType<typeof maker.getSessionMeta>>>,
  ): Promise<AgentInputCreateOpts> {
    const db = getDbClient().drizzle;
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row) {
      throw new Error(`session ${sessionId} not found`);
    }
    const createOpts = buildCreateOptsWithStderr({
      id: sessionId,
      agentKind: meta.agentKind,
      workingDir: meta.workDir,
      model: meta.model,
      providerId: row.providerId,
      resumeSessionId: meta.sdkSessionId,
      effort: (row.effort ?? undefined) as CreateOpts['effort'],
      fastMode: !!row.fastMode,
      permissionMode: permissionModeOrAsk(row.permissionMode),
      planMode: false,
      title: row.title ?? undefined,
      remoteHostId: row.remoteHostId ?? undefined,
      orcaRole: row.orcaRole as CreateOpts['orcaRole'],
    });
    await synthesizeOrcaVendorOptionsFromDb(sessionId, createOpts);
    if (createOpts.extraDirs === undefined) {
      try {
        const extraDirs = await readSessionExtraDirsFromDb(sessionId);
        if (extraDirs.length > 0) createOpts.extraDirs = extraDirs;
      } catch (err) {
        log.warn('inter-agent queue: read extra_dirs from DB failed (non-fatal)', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      agentKind: createOpts.agentKind,
      workingDir: createOpts.workingDir,
      model: createOpts.model,
      effort: createOpts.effort,
      fastMode: createOpts.fastMode,
      permissionMode: createOpts.permissionMode,
      planMode: createOpts.planMode,
      makerMemoryEnabled: createOpts.makerMemoryEnabled,
      displayReasoning: createOpts.displayReasoning,
      vendorOptions: sanitizeVendorOptionsForQueuedItem(createOpts.vendorOptions),
      remoteHostId: createOpts.remoteHostId,
      resumeSessionId: createOpts.resumeSessionId,
      orcaRole: createOpts.orcaRole,
    };
  }

  async function enqueueSendToSessionMessage(params: {
    targetSessionId: string;
    message: string;
    persistedContent: string;
    clientId: string;
    meta: NonNullable<Awaited<ReturnType<typeof maker.getSessionMeta>>>;
    dbRow: NonNullable<Awaited<ReturnType<typeof getSessionRowSnapshot>>>;
    onAccepted?: () => void | Promise<void>;
    onAcceptedRollback?: () => void | Promise<void>;
    origin?: AgentInputQueuedMessage['origin'];
  }): Promise<void> {
    const createOpts = await buildCreateOptsForQueuedSession(params.targetSessionId, params.meta);
    const queued: AgentInputQueuedMessage = {
      clientId: params.clientId,
      text: params.message,
      persistedContent: params.persistedContent,
      model: createOpts.model,
      effort: createOpts.effort ?? '',
      permissionMode: permissionModeOrAsk(createOpts.permissionMode),
      workingDir: createOpts.workingDir,
      vendorOptions: createOpts.vendorOptions,
      chatMessage: {
        clientId: params.clientId,
        role: 'user',
        content: params.persistedContent,
        createdAt: new Date().toISOString(),
      },
      createOpts,
      ...(params.origin ? { origin: params.origin } : {}),
    };
    if (params.onAccepted) {
      orcaInterAgentDispatcher.registerQueuedOrcaInterAgentAcceptedCallback(
        params.clientId,
        params.onAccepted,
        params.onAcceptedRollback,
      );
    }
    // 崩溃恢复排序:确保先读回持久化队列再追加本条(见 ensureQueueRestored)。
    // 失败时 enqueue 照常入队(shouldQueueNewTurn 已守住不会直发)。
    await inputCoordinator.ensureQueueRestored(params.targetSessionId).catch(() => undefined);
    inputCoordinator.enqueue(params.targetSessionId, queued);
    log.info('send_to_session queued while target busy', {
      targetSessionId: params.targetSessionId,
      clientId: params.clientId,
    });
  }

  const orcaInterAgentDispatcher: OrcaInterAgentDispatcher = createOrcaInterAgentDispatcher({
    createId,
    getSessionMeta: (sessionId) => maker.getSessionMeta(sessionId).catch(() => null),
    getSessionRowSnapshot,
    getLiveSession: (sessionId) => maker.getSession(sessionId),
    shouldQueueNewTurn: (sessionId): boolean => inputCoordinator.shouldQueueNewTurn(sessionId),
    hasSendToSessionLock: (sessionId) => sendToSessionLocks.has(sessionId),
    buildCreateOptsForQueuedSession,
    enqueueQueuedMessage: (sessionId, item) => {
      // 先 await 恢复再 enqueue:确保恢复的排队 prompt 在新消息之前,且恢复后
      // 队列处于 paused 态不会被新消息的 getDrainableHead 立刻 drain。
      void (async () => {
        await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
        inputCoordinator.enqueue(sessionId, item);
      })();
    },
    sendToSessionInternal,
    createDbMessage,
    resolveWorkerSenderLabel: async (workerId, fallback) => {
      const link = await getWorkerLink({ workerId });
      if (!link) return fallback;
      const worker = (await listWorkersByLead(link.leadSessionId)).find((w) => w.id === workerId);
      return worker?.role ?? fallback;
    },
    isSessionRunningError,
    log,
  });
  const dispatchOrEnqueueOrcaInterAgentMessage = orcaInterAgentDispatcher.dispatchOrEnqueueOrcaInterAgentMessage;
  dispatchInterAgentMessageHolder = dispatchOrEnqueueOrcaInterAgentMessage;

  ipcMain.handle(MAKER_INVOKE.SESSION_ENABLE_ORCA, async (_e, leadSessionId: unknown, opts: unknown) => {
    if (typeof leadSessionId !== 'string') throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    const body = (opts ?? {}) as {
      workerAgent?: unknown;
      delegateTask?: unknown;
      role?: unknown;
      label?: unknown;
      model?: unknown;
      effort?: unknown;
      fast?: unknown;
      providerId?: unknown;
    };
    const workerAgent: AgentKind =
      body.workerAgent === 'codex' ? 'codex' : body.workerAgent === 'pi' ? 'pi' : 'claude-code';
    const delegateTask = typeof body.delegateTask === 'string' ? body.delegateTask : undefined;
    return enableOrcaInternal(leadSessionId, {
      workerAgent,
      delegateTask,
      role: typeof body.role === 'string' ? body.role : undefined,
      label: typeof body.label === 'string' ? body.label : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      effort: typeof body.effort === 'string' ? body.effort as OrcaWorkerEffort : undefined,
      fast: typeof body.fast === 'boolean' ? body.fast : undefined,
      // 只认非空(trim 后)string 为显式来源;其余(null/空白/缺省/异型)一律按「未显式」处理。
      providerId: typeof body.providerId === 'string' && body.providerId.trim().length > 0
        ? body.providerId.trim()
        : undefined,
    });
  });

  /**
   * clearLeadOrcaRoleState — 把一个 Lead session 的协同身份彻底清干净:DB orca_role=null
   * (setSessionOrcaRole 会同时广播 { orcaRole: null } patch,renderer 的 collabEnabled 翻 false)、
   * 清 knownNonOrca cache、在线时清空 vendorOptions。抽出来给 disableOrcaInternal 的「正常关闭」
   * 和「悬空 lead 兜底」两条路径共用,避免两份漂移。
   */
  async function clearLeadOrcaRoleState(leadSessionId: string): Promise<void> {
    await setSessionOrcaRole(leadSessionId, null);
    knownNonOrcaSessionIds.delete(leadSessionId);

    const leadSess = maker.getSession(leadSessionId);
    if (leadSess) {
      try {
        await leadSess.setVendorOptions({
          orcaRole: null,
          orcaWorkflowId: null,
          orcaLeadSessionId: null,
          initialWorker: null,
        });
      } catch (err) {
        log.warn('disableOrca: setVendorOptions on alive Lead failed', {
          leadSessionId, err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * disableOrcaInternal — 关闭 lead session 当前的协同模式。
   *   1. 查 active team;不存在则尝试兜底修复悬空 lead(见下),再返回
   *   2. 对每个 Worker session:running 则 abort,然后 closeSession 释放 SDK
   *   3. DB: team status='completed' + workers status='done' + sessions.status='archived'
   *      (archived 让 sidebar 自动隐藏 Worker;orca_role 保留作历史识别)
   *   4. Lead orca_role=null + clear knownNonOrca cache + 在线时 setVendorOptions 清空
   *
   * Worker 最后输出回传 Lead 的逻辑(用户认可的 Q1 方案 A: 直接读 Worker 最后一条
   * assistant 消息注入 Lead)留作后续打磨 — 当前 MVP 只保证 SDK 进程被销毁、
   * 数据库状态干净,renderer 收到 status='archived' patch 后自然收起 split pane。
   *
   * 共用 caller:
   *   - SESSION_DISABLE_ORCA IPC handler (renderer 手动 toggle)
   *   - cindy_helper end_team MCP tool (Lead agent 自动调)
   */
  async function disableOrcaInternal(leadSessionId: string): Promise<{ ok: true }> {
    const team = await getActiveTeamByLead(leadSessionId);
    if (!team) {
      // 没有 active team —— 但 Lead 的 orca_role 可能因为上一次关闭被中途打断而悬空成 'lead'
      // (markTeamEnded / markWorkersStatusByTeam / archiveWorkersByTeam 已落库,setSessionOrcaRole(null)
      // 还没落库就退出 / 崩溃)。renderer 的 collabEnabled 只看 orca_role,会把会话永久困在空
      // split view;若这里继续无条件 no-op,再点 X 关闭也救不回来 —— 修复逻辑被门在「必须有
      // active team」之后,坏态自锁。所以这里做幂等兜底:仍是 stranded lead 就把角色清掉,
      // 让「关闭协同」成为可靠的逃生口。
      const role = await getSessionOrcaRole(leadSessionId);
      if (role === 'lead') {
        log.warn('disableOrca: no active team but lead orca_role stranded; reconciling', { leadSessionId });
        // 上一次关闭若在 archiveWorkersByTeam 之前被打断,team 已非 active 但 worker session 还停在
        // active + hidden + unreachable —— 一并补齐归档,否则它们会成为永远触达不到的孤儿 worker。
        const orphanedWorkerSessionIds = await reconcileInactiveTeamWorkersForLead(leadSessionId);
        for (const sid of orphanedWorkerSessionIds) {
          cleanupPendingInteractionsForSession(sid, 'orca_disable');
          forgetKnownOrcaWorkerSession(sid);
        }
        if (orphanedWorkerSessionIds.length > 0) {
          log.warn('disableOrca: archived orphaned workers from non-active team(s)', {
            leadSessionId, count: orphanedWorkerSessionIds.length,
          });
        }
        await clearLeadOrcaRoleState(leadSessionId);
      } else {
        log.info('disableOrca: no active team, no-op', { leadSessionId });
      }
      return { ok: true };
    }

    const workers = await listWorkersByLead(leadSessionId);
    const activeWorkers = workers.filter((w) => w.teamId === team.id);
    for (const w of activeWorkers) {
      orcaTeamService.clearAutoBridgeState(w.sessionId);
      const sess = maker.getSession(w.sessionId);
      if (sess) {
        try {
          if (sess.isTurnRunning?.()) {
            await sess.abort();
          }
        } catch (err) {
          log.warn('disableOrca: abort failed (continuing to close)', {
            sessionId: w.sessionId, err: err instanceof Error ? err.message : String(err),
          });
        }
        try {
          await maker.closeSession(w.sessionId);
        } catch (err) {
          log.warn('disableOrca: closeSession failed', {
            sessionId: w.sessionId, err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      cleanupPendingInteractionsForSession(w.sessionId, 'orca_disable');
      forgetKnownOrcaWorkerSession(w.sessionId);
    }

    await markTeamEnded(team.id, 'completed');
    await markWorkersStatusByTeam(team.id, 'done');
    await archiveWorkersByTeam(team.id);

    await clearLeadOrcaRoleState(leadSessionId);

    log.info('disableOrca done', {
      leadSessionId, teamId: team.id, archivedCount: activeWorkers.length,
    });
    return { ok: true };
  }

  ipcMain.handle(MAKER_INVOKE.SESSION_DISABLE_ORCA, async (_e, leadSessionId: unknown) => {
    if (typeof leadSessionId !== 'string') throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    return disableOrcaInternal(leadSessionId);
  });

  // ─── Orca worker IPC handlers ────────────────────────────────────────────

  ipcMain.handle(MAKER_INVOKE.WORKER_CREATE, async (_e, body: unknown) => {
    const b = body as Record<string, unknown> | null | undefined;
    if (!b || typeof b.leadSessionId !== 'string') throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    if (typeof b.role !== 'string' || b.role.length < 1 || b.role.length > 32) throwIpcError('INVALID_PARAMS', 'role must be 1-32 chars');
    if (typeof b.label !== 'string') throwIpcError('INVALID_PARAMS', 'label required');
    const label = normalizeOrcaWorkerLabel(b.label);
    if (!label.ok) throwIpcError('INVALID_PARAMS', label.message);
    const agent =
      b.agent === 'codex' ? ('codex' as const) : b.agent === 'pi' ? ('pi' as const) : ('claude-code' as const);
    const model = typeof b.model === 'string' && b.model.length > 0 ? b.model : undefined;
    await assertLeadCollabProjectEnabled(b.leadSessionId);
    const result = await orcaLifecycleService.createWorker({
      leadSessionId: b.leadSessionId,
      role: b.role,
      agent,
      model,
      effort: typeof b.effort === 'string' ? b.effort as OrcaWorkerEffort : undefined,
      fast: typeof b.fast === 'boolean' ? b.fast : undefined,
      // 只认非空(trim 后)string 为显式来源;其余(null/空白/缺省/异型)一律按「未显式」处理。
      providerId: typeof b.providerId === 'string' && b.providerId.trim().length > 0
        ? b.providerId.trim()
        : undefined,
      label: label.value,
      initialTask: typeof b.initialTask === 'string' && b.initialTask.length > 0 ? b.initialTask : undefined,
    });
    if (!result.ok) throwOrcaServiceFailure(result);
    return {
      ok: true,
      workerId: result.workerId,
      workerSessionId: result.workerSessionId,
      softLimitExceeded: result.softLimitExceeded,
      ...(result.dispatched !== undefined ? { dispatched: result.dispatched } : {}),
      ...(result.dispatchOutcome ? { dispatchOutcome: result.dispatchOutcome } : {}),
    };
  });

  ipcMain.handle(MAKER_INVOKE.WORKER_LIST, async (_e, leadSessionId: unknown) => {
    if (typeof leadSessionId !== 'string') throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    return listWorkersByLead(leadSessionId);
  });

  ipcMain.handle(MAKER_INVOKE.WORKER_SWITCH_FOCUS, async (_e, body: unknown) => {
    const b = body as Record<string, unknown> | null | undefined;
    if (!b || typeof b.leadSessionId !== 'string') throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    if (typeof b.workerIdOrLabel !== 'string') throwIpcError('INVALID_PARAMS', 'workerIdOrLabel required');

    const workers = await listWorkersByLead(b.leadSessionId);
    const target = findFocusTargetWorker(workers, b.workerIdOrLabel);
    if (!target) throwIpcError('WORKER_NOT_FOUND', `no worker matching "${b.workerIdOrLabel}"`);

    // focused 切换: clear 旧 + set 新, 原子化 (review F4)
    await setWorkerFocus(target.teamId, target.id);

    // idle worker → resume session (so it's ready for tasks), but don't set status
    // to 'running' — that only happens when actual work is dispatched via sendToWorker.
    if (target.status === 'idle') {
      try {
        const didResume = await resumeOrcaWorkerSessionIfMissing(target);
        if (didResume) {
          log.info('switchFocus: resumed idle worker (session only, no status change)', { workerId: target.id, sessionId: target.sessionId });
        }
      } catch (err) {
        log.warn('switchFocus: resume failed', {
          workerId: target.id, err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId: b.leadSessionId as string });
    return { ok: true, workerId: target.id };
  });

  registerOrcaWorkerControlHandlers(createElectronIpcHandlerRegistry(), {
    idleWorker: (params) => orcaTeamService.idleWorker(params),
    archiveWorker: (params) => orcaTeamService.archiveWorker(params),
    logInfo: (message, fields) => log.info(message, fields),
  });

  ipcMain.handle(MAKER_INVOKE.TEAM_END, async (_e, leadSessionId: unknown) => {
    if (typeof leadSessionId !== 'string') throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    const result = await disableOrcaInternal(leadSessionId);
    broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId: leadSessionId as string });
    return result;
  });

  const hasPendingIdleReleaseInput = async (sessionId: string): Promise<boolean> => {
    await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
    // A failed restore is itself a pending condition: never close a worker while
    // its durable follow-up snapshot is still unavailable.
    if (!inputCoordinator.isQueueRestored(sessionId)) return true;
    return inputCoordinator.hasPendingQueuedWork(sessionId) ||
      inputCoordinator.hasQueuedItemWhere(sessionId, () => true, { includeRecovery: true });
  };

  const orcaTeamService = createOrcaTeamService({
    getWorkerLinkBySessionId: (workerSessionId) => getWorkerLink({ workerSessionId }),
    getWorkerLinkByWorkerId: (workerId) => getWorkerLink({ workerId }),
    listWorkersByLead,
    getLiveSession: (sessionId) => maker.getSession(sessionId) ?? null,
    resumeWorkerSession: async (target) => {
      await resumeOrcaWorkerSessionIfMissing(target);
    },
    updateWorkerStatus,
    markWorkerIdle: async (workerId) => {
      const now = Date.now();
      const db = getDbClient().drizzle;
      await db.update(orcaWorkers)
        .set({ status: 'idle', idleSince: now, updatedAt: now })
        .where(eq(orcaWorkers.id, workerId));
    },
    markWorkerIdleIfStatus,
    restoreWorkerDoneIfIdle,
    closeWorkerSession: async (sessionId) => {
      const sess = maker.getSession(sessionId);
      if (sess) {
        await sess.abort();
      }
      await maker.closeSession(sessionId);
    },
    closeWorkerSessionIfIdle: async (sessionId) => {
      if (sendToSessionLocks.has(sessionId)) return false;
      const sess = maker.getSession(sessionId);
      return sess ? sess.closeIfIdle() : true;
    },
    hasPendingWorkerInput: async (sessionId) => {
      await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
      // A failed restore is itself a pending condition: never close a worker while
      // its durable follow-up snapshot is still unavailable.
      if (!inputCoordinator.isQueueRestored(sessionId)) return true;
      return inputCoordinator.hasPendingQueuedWork(sessionId) ||
        inputCoordinator.hasQueuedItemWhere(sessionId, () => true, { includeRecovery: true });
    },
    hasSendToSessionLock: (sessionId) => sendToSessionLocks.has(sessionId),
    archiveWorkerSession: archiveSingleWorkerSession,
    getManualInterrupt,
    clearManualInterrupt,
    forgetWorkerSession: forgetKnownOrcaWorkerSession,
    broadcastOrcaWorkerChanged: (leadSessionId) => {
      broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
    },
    dispatchWorkerMessage: async ({ targetSessionId, message, workerId, dispatchMeta, onAccepted, onAcceptedRollback }) => {
      const result = await dispatchOrEnqueueOrcaInterAgentMessage({
        targetSessionId,
        rawContent: message,
        source: 'lead',
        senderLabel: 'Lead',
        workerId,
        meta: dispatchMeta,
        onAccepted: async () => {
          clearManualInterrupt(targetSessionId);
          await onAccepted?.();
        },
        onAcceptedRollback,
      });
      if (!result.ok) {
        return {
          ok: false,
          dispatchOutcome: result.dispatchOutcome,
        };
      }
      return {
        ok: true,
        mode: result.mode,
        clientId: result.clientId,
        dispatchOutcome: result.dispatchOutcome,
        targetTitle: result.targetTitle ?? null,
        targetLastUserSendAt: result.targetLastUserSendAt ?? null,
      };
    },
    getSessionQueueSnapshot: async (sessionId) => {
      // 先补崩溃恢复,保证重启后 lead 仍能看到快照恢复出的排队消息。
      await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
      const projection = inputCoordinator.getProjection(sessionId);
      return {
        pendingQueue: projection.pendingQueue,
        steeringClientIds: projection.steeringQueueClientIds,
      };
    },
    removeQueuedMessage: (sessionId, clientId) => {
      if (!inputCoordinator.hasQueuedItemWhere(sessionId, (item) => item.clientId === clientId)) {
        return false;
      }
      // remove 内部对 steering 条目静默拒绝,以移除后的队列状态为准判定成败。
      inputCoordinator.remove(sessionId, clientId);
      return !inputCoordinator.hasQueuedItemWhere(sessionId, (item) => item.clientId === clientId);
    },
    replaceQueuedMessage: (sessionId, clientId, next) =>
      inputCoordinator.replaceQueuedMessage(sessionId, clientId, next),
    sendAutoBridgeToLead: async (leadSessionId, message, workerId) => {
      const result = await dispatchInterAgentMessage({
        targetSessionId: leadSessionId,
        rawContent: message,
        source: 'worker',
        senderLabel: 'Worker',
        workerId,
        meta: {
          source: 'maker-ipc/auto-bridge',
          context: `worker_auto_bridge/${leadSessionId}/${workerId}`,
        },
      });
      return { accepted: result.ok };
    },
    log,
  });
  orcaTeamServiceForEvents = orcaTeamService;

  const orcaWorkerCreationService = createOrcaWorkerCreationService({
    getActiveTeamByLead,
    listWorkersByLead,
    isActiveWorkerStatus,
    readCollaborationSettings,
    getLeadSessionRow: async (leadSessionId) => {
      const db = getDbClient().drizzle;
      const [leadRow] = await db.select().from(sessions).where(eq(sessions.id, leadSessionId)).limit(1);
      if (!leadRow) return null;
      return {
        id: leadRow.id,
        // 走转换正本:pi lead 不能被压成 claude-code,否则 input.agent===lead.agentKind
        // 判等失效,pi-lead 建 pi-worker 会走错默认分支(见 orcaWorkerCreationService)。
        agentKind: dbToMakerAgentKind(leadRow.agentKind),
        workspaceKind: leadRow.workspaceKind,
        workingDir: leadRow.workingDir,
        model: leadRow.model,
        effort: leadRow.effort,
        permissionMode: leadRow.permissionMode,
        fastMode: !!leadRow.fastMode,
        providerId: leadRow.providerId ?? null,
        remoteHostId: leadRow.remoteHostId ?? null,
      };
    },
    getWorkerDefaults: getWorkerDefaultsFromNewMaker,
    getAvailableModels: (agent) => maker.getCapabilities(agent).availableModels,
    getProviderRoutingContext: async () => {
      const views = await getDesktopProviderService().listProviders({ allowSideEffects: true });
      // 准入过滤与 modelList.ts 标准派生同口径:用户停用的模型(disabled,见
      // model-disable-store)与非聊天模型(image/video/tts/stt/realtime/
      // embedding/compression,issue #882 第 3 点)不进路由可用集 —— MCP
      // create_worker 点名它们会走既有的 INVALID_PARAMS / NO_PROVIDER 拒绝路径,
      // 而不是静默路由过去。停用的供应商已在 connectedProvidersForAgent(suspended)
      // 一层出局。isModelSelectableForNewRoute 同时收口 chat / disabled / retired，
      // 这里的 models/fastModels/effortMetaByModel 都是
      // orcaWorkerCreationService 唯一能看到的 provider 快照 —— 一旦某个非聊天
      // mode 的模型混进这份 id 清单,service 内所有 `provider.models.includes(id)`
      // 式的 preflight 都只按 id 存在与否放行,永远不会知道这条模型其实是图片/
      // 语音端点(mode 信息在这一步已经被拍平丢弃),必须在这里先过滤,不能指望
      // 下游 service 补(2026-07 review 第 16 轮:MCP create_worker / 缓存默认
      // 路由都走这条快照,不经过 renderer 侧选择器的过滤)。
      const routableModels = (provider: ProviderView, agent: AgentKind) =>
        (provider.models[agent] ?? []).filter((model) =>
          isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
        );
      const availabilityFor = (agent: AgentKind) =>
        connectedProvidersForAgent(views, agent).map((provider) => {
          const models = routableModels(provider, agent);
          return {
            id: provider.id,
            name: provider.name,
            models: models.map((model) => model.id),
            // Fast 能力 per-(provider, model):显式来源的 Fast 判定按该来源自己的条目。
            fastModels: models
              .filter((model) => model.supportsFastMode)
              .map((model) => model.id),
            // effort 档位同样 per-(provider, model):供 service 按实际路由来源重归一。
            effortMetaByModel: Object.fromEntries(
              models.map((model) => [
                model.id,
                { efforts: model.efforts, defaultEffort: model.defaultEffort },
              ]),
            ),
            requiresExplicitRoute: providerRouteRequiresExplicitSelection(
              provider.routing[agent]?.authStrategy,
            ),
            // chat-bridged codex 供应商标记 (SSH 远端 worker 兼容闸用,
            // 见 orcaWorkerCreationService R23 P2 校验;wireProtocol 仅
            // codex 侧存在, 其他 agent 恒 false)。
            chatBridgedCodex: agent === 'codex' && provider.routing[agent]?.wireProtocol === 'openai-chat',
          };
        });
      return {
        availability: {
          'claude-code': availabilityFor('claude-code'),
          codex: availabilityFor('codex'),
          pi: availabilityFor('pi'),
        },
        resolveDefaultProviderIdForModel: (agent, model) => (
          effectiveSourceIdForModel(views, null, model, agent)
        ),
      };
    },
    readClaudeApiKey,
    reserveWorkerCreation,
    renewWorkerCreationReservation,
    releaseWorkerCreationReservation,
    createId,
    createSessionId: createBusinessSessionId,
    buildCreateOptsWithStderr,
    ensureRemoteReadyForSessionStart: async (params) => {
      await ensureRemoteReadyForSessionStart({ createOpts: params.createOpts });
    },
    bootstrapSession,
    addOrUpdateWorker: async (worker) => {
      await addOrUpdateWorker(worker);
    },
    markOrcaRoleIfNeeded: async (sessionId, role) => {
      await markOrcaRoleIfNeeded(sessionId, role);
    },
    closeWorkerSession: async (sessionId) => {
      if (!maker.getSession(sessionId)) return;
      await maker.closeSession(sessionId);
    },
    archiveWorkerSession: archiveSingleWorkerSession,
    forgetWorkerSession: forgetKnownOrcaWorkerSession,
    removeWorker,
    dispatchWorkerTask: (params) => orcaTeamService.dispatchWorkerTask(params),
    broadcastSessionCreated,
    broadcastOrcaWorkerChanged: (leadSessionId) => {
      broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
    },
  });

  const orcaLifecycleService = createOrcaLifecycleService({
    getActiveTeamByLead,
    createActiveTeam: async (leadSessionId) => createActiveTeam({ leadSessionId }),
    createWorkerInTeam: (params) => orcaWorkerCreationService.createWorkerInTeam(params),
    dispatchWorkerTask: (params) => orcaTeamService.dispatchWorkerTask(params),
    markTeamEnded,
    setSessionOrcaRole,
    clearKnownNonOrcaSession: (sessionId) => {
      knownNonOrcaSessionIds.delete(sessionId);
    },
    setLeadVendorOptions: async ({ leadSessionId, teamId, workerId, workerSessionId }) => {
      const leadSess = maker.getSession(leadSessionId);
      if (!leadSess) return;
      await leadSess.setVendorOptions({
        orcaRole: 'lead',
        orcaWorkflowId: teamId,
        orcaLeadSessionId: leadSessionId,
        ...(workerId && workerSessionId
          ? {
              initialWorker: {
                workerId,
                sessionId: workerSessionId,
              },
            }
          : {}),
      });
    },
    clearLeadVendorOptions: async (leadSessionId) => {
      const leadSess = maker.getSession(leadSessionId);
      if (!leadSess) return;
      await leadSess.setVendorOptions({
        orcaRole: null,
        orcaWorkflowId: null,
        orcaLeadSessionId: null,
        initialWorker: null,
      });
    },
    sendWorkerReadyPlaceholder: async ({ workerSessionId, agentKind, entrypoint, context }) => {
      const workerSession = maker.getSession(workerSessionId);
      if (!workerSession) {
        throw new Error(`worker session ${workerSessionId} not found for ready placeholder`);
      }
      const sendResult = await workerSession.send(
        { type: 'user', content: ORCA_WORKER_READY_MESSAGE },
        { planMode: false, throwOnStartFailure: true },
      );
      assertDesktopSendDispatched(sendResult, context);
      log.info('orca worker ready placeholder accepted', {
        owner: 'orca-worker-ready',
        entrypoint,
        sessionId: workerSession.id,
        agentKind,
        action: 'worker-ready-placeholder',
        context,
      });
    },
    rollbackCreatedWorker: async ({ workerId, workerSessionId }) => {
      const workerSession = maker.getSession(workerSessionId);
      if (workerSession) {
        await maker.closeSession(workerSessionId).catch(() => undefined);
      }
      forgetKnownOrcaWorkerSession(workerSessionId);
      await archiveSingleWorkerSession(workerSessionId).catch(() => undefined);
      await removeWorker(workerId);
    },
    broadcastSessionCreated,
    broadcastOrcaWorkerChanged: (leadSessionId) => {
      broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
    },
  });

  // ─── Collaboration settings IPC ─────────────────────────────────────────
  ipcMain.handle(MAKER_INVOKE.COLLABORATION_SETTINGS_GET, async () => {
    return collaborationSettingsWire();
  });

  ipcMain.handle(MAKER_INVOKE.COLLABORATION_SETTINGS_SET, async (_e, body: unknown) => {
    const b = body as Record<string, unknown> | null | undefined;
    if (!b || typeof b.key !== 'string') throwIpcError('INVALID_PARAMS', 'key required');
    if (!isCollaborationSettingKey(b.key)) {
      throwIpcError('INVALID_PARAMS', `unknown key: ${b.key}`);
    }
    const value = validateCollaborationSettingValue(b.key, b.value);
    writeCollaborationSetting(b.key, value);
    return collaborationSettingsWire();
  });

  ipcMain.handle(MAKER_INVOKE.COLLABORATION_SETTINGS_RESET, async () => {
    resetCollaborationSettings();
    return collaborationSettingsWire();
  });

  // ─── Agent resource settings IPC(命令并发/进程优先级/工具链限核)──────────
  // 业务体在 agent-resource-settings-ipc.ts(sender 校验/逐 key 校验/存储失败
  // 转 INTERNAL),这里是纯 adapter。
  ipcMain.handle(MAKER_INVOKE.AGENT_RESOURCE_SETTINGS_GET, async (e) =>
    agentResourceSettingsIpc.get(e),
  );
  ipcMain.handle(MAKER_INVOKE.AGENT_RESOURCE_SETTINGS_SET, async (e, body: unknown) =>
    agentResourceSettingsIpc.set(e, body),
  );
  ipcMain.handle(MAKER_INVOKE.AGENT_RESOURCE_SETTINGS_RESET, async (e) =>
    agentResourceSettingsIpc.reset(e),
  );

  // ─── Idle watcher ────────────────────────────────────────────────────────
  // 只扫描 active team/session，避免已归档 Worker 被终态筛选重新捞起。
  idleReleaseWatcher?.stop();
  idleReleaseWatcher = createOrcaIdleReleaseWatcher({
    readIdleReleaseMinutes: () => readCollaborationSettings().workerIdleReleaseMinutes,
    listCandidates: async (updatedBefore) => {
      const db = getDbClient().drizzle;
      return db
        .select({
          id: orcaWorkers.id,
          sessionId: orcaWorkers.sessionId,
          leadSessionId: orcaTeams.leadSessionId,
          status: orcaWorkers.status,
          idleSince: orcaWorkers.idleSince,
          updatedAt: orcaWorkers.updatedAt,
        })
        .from(orcaWorkers)
        .innerJoin(orcaTeams, eq(orcaTeams.id, orcaWorkers.teamId))
        .innerJoin(sessions, eq(sessions.id, orcaWorkers.sessionId))
        .where(and(
          isNull(orcaWorkers.idleSince),
          inArray(orcaWorkers.status, ORCA_IDLE_RELEASE_STATUSES),
          sql`${orcaWorkers.updatedAt} < ${updatedBefore}`,
          eq(orcaTeams.status, 'active'),
          eq(sessions.status, 'active'),
        ));
    },
    getSession: (sessionId) => maker.getSession(sessionId) ?? null,
    withSessionLock: withSendToSessionLock,
    hasPendingInput: hasPendingIdleReleaseInput,
    markReleased: async (candidate, releasedAt) => {
      // Drizzle proxy 的 UPDATE ... RETURNING 会执行写入但返回空数组；这里直接用
      // DbClient async exec 的 changes 做原子 compare-and-set 结果判定。
      const result = await getDbClient().exec(
        `UPDATE orca_workers
         SET status = 'idle', idle_since = ?, updated_at = ?
         WHERE id = ? AND status = ? AND idle_since IS NULL AND updated_at = ?`,
        [releasedAt, releasedAt, candidate.id, candidate.status, candidate.updatedAt],
      );
      return result.changes === 1;
    },
    touchWorker: async (workerId, updatedAt) => {
      await getDbClient().drizzle
        .update(orcaWorkers)
        .set({ updatedAt })
        .where(eq(orcaWorkers.id, workerId));
    },
    closeSession: (sessionId) => maker.closeSession(sessionId),
    broadcastWorkerChanged: (leadSessionId) => {
      broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
    },
    now: Date.now,
    timer: { setInterval, clearInterval },
    log,
  });
  idleReleaseWatcher.start();

  // ─── 把 internal 业务函数发布到 module-level holder ────────────────────
  // mcp-providers.ts 的 cindy_helper control deps 通过
  // tryGetOrcaCollabService() 拿到这些函数引用, 让 MCP tool
  // 走与 IPC handler 完全相同的业务路径。
  orcaCollabServiceHolder = {
    sendToSession: sendToSessionInternal,
    enableOrca: enableOrcaInternal,
    disableOrca: disableOrcaInternal,
    // MCP worker 派活必须经 OrcaTeamService，确保 running、resume idle、广播和
    // 公开错误码映射都与 IPC handler WORKER_SEND_TO 保持同一套状态机。
    sendToWorker: ({ callerLeadSessionId, targetSessionId, message }) => orcaTeamService.sendToWorker({
      callerLeadSessionId,
      targetSessionId,
      message,
    }),
    // 排队消息控制统一走 OrcaTeamService,复用 resolveWorkerRef 归属校验与
    // coordinator 的 remove/replace 原语(cancel 经 remove 触发 discard settle)。
    listWorkerQueuedMessages: (params) => orcaTeamService.listWorkerQueuedMessages(params),
    updateWorkerQueuedMessage: (params) => orcaTeamService.updateWorkerQueuedMessage(params),
    cancelWorkerQueuedMessage: (params) => orcaTeamService.cancelWorkerQueuedMessage(params),
    startTeam: async ({ leadSessionId }) => {
      try {
        await assertLeadCollabProjectEnabled(leadSessionId);
        return await orcaLifecycleService.startTeam({ leadSessionId });
      } catch (err) {
        return {
          ok: false,
          errorCode: err instanceof Error && (err as unknown as { code?: string }).code ? (err as unknown as { code: string }).code : 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    createWorker: async (params) => {
      try {
        await assertLeadCollabProjectEnabled(params.leadSessionId);
        return await orcaLifecycleService.createWorker(params);
      } catch (err) {
        return {
          ok: false,
          errorCode: err instanceof Error && (err as unknown as { code?: string }).code ? (err as unknown as { code: string }).code : 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    createWorkerFromTask: async ({ leadSessionId, task, agentKind }) => {
      try {
        await assertLeadCollabProjectEnabled(leadSessionId);
        const created = await orcaLifecycleService.createWorker({
          leadSessionId,
          role: 'developer',
          agent: agentKind,
          label: createBridgeWorkerLabel(task),
          initialTask: task,
        });
        if (!created.ok) return created;
        return {
          ok: true,
          workerId: created.workerId,
          workerSessionId: created.workerSessionId,
          label: created.resolved.label,
          ...(created.softLimitExceeded ? { softLimitExceeded: created.softLimitExceeded } : {}),
          ...(created.dispatched !== undefined ? { dispatched: created.dispatched } : {}),
          ...(created.dispatchOutcome ? { dispatchOutcome: created.dispatchOutcome } : {}),
        };
      } catch (err) {
        return {
          ok: false,
          errorCode: err instanceof Error && (err as unknown as { code?: string }).code ? (err as unknown as { code: string }).code : 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    listWorkers: async ({ leadSessionId }) => {
      try {
        const workers = await listWorkersByLead(leadSessionId);
        return {
          ok: true,
          workers: workers.map((w) => ({
            workerId: w.id,
            sessionId: w.sessionId,
            role: w.role,
            agent: w.session.agentKind,
            model: w.session.model,
            effort: w.session.effort,
            label: w.label,
            status: w.status,
            focused: w.focused,
            idleSince: w.idleSince,
          })),
        };
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
    getWorkspaceInfo: async ({ leadSessionId }) => {
      try {
        return await getOrcaWorkspaceInfoReadOnly(createOrcaDiagnosticsDeps(), leadSessionId);
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
    getWorkerStatus: async ({ leadSessionId, workerId }) => {
      try {
        return await getOrcaWorkerDiagnosticStatusReadOnly(createOrcaDiagnosticsDeps(), leadSessionId, workerId);
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
    readWorker: async ({ leadSessionId, workerId }) => {
      try {
        return await readOrcaWorkerOutputReadOnly(createOrcaDiagnosticsDeps(), leadSessionId, workerId);
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
    switchFocus: async ({ leadSessionId, workerIdOrLabel }) => {
      try {
        const workers = await listWorkersByLead(leadSessionId);
        const target = findFocusTargetWorker(workers, workerIdOrLabel);
        if (!target) return { ok: false, errorCode: 'WORKER_NOT_FOUND', message: `no worker matching "${workerIdOrLabel}"` };

        await setWorkerFocus(target.teamId, target.id);

        // Resume closed session so it's ready to receive tasks, but DON'T change
        // worker status — status only transitions to 'running' when actual work is
        // dispatched (sendToWorker). Setting 'running' here without a task causes
        // the icon to flash indefinitely (no turn → turn-done never fires).
        if (target.status === 'idle') {
          await resumeOrcaWorkerSessionIfMissing(target);
        }
        broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
        return { ok: true, workerId: target.id };
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
    idleWorker: async ({ callerLeadSessionId, workerId, expectedStatus }) => {
      try {
        return await orcaTeamService.idleWorker({ callerLeadSessionId, workerId, expectedStatus });
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
    endTeam: async ({ leadSessionId }) => {
      try {
        await disableOrcaInternal(leadSessionId);
        broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
        return { ok: true };
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
    archiveWorker: async ({ callerLeadSessionId, workerId }) => {
      try {
        return await orcaTeamService.archiveWorker({ callerLeadSessionId, workerId });
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
    listAvailableModels: async ({ agent }) => {
      try {
        const agents: AgentKind[] = agent ? [agent] : ['codex', 'claude-code', 'pi'];
        const result: Record<string, Array<{ id: string; label: string }>> = {};
        for (const a of agents) {
          const caps = maker.getCapabilities(a);
          // key 必须区分 pi,否则 pi 模型会被塞进 claude_code 键与 CC 模型混淆。
          const key = a === 'codex' ? 'codex' : a === 'pi' ? 'pi' : 'claude_code';
          result[key] = caps.availableModels.map((m) => ({ id: m.id, label: m.displayName }));
        }
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, errorCode: 'INTERNAL', message: err instanceof Error ? err.message : String(err) };
      }
    },
  };

  const { sendToAgentAccepted: sendToAgentAcceptedUnlocked } = createMakerSendTransaction({
    getSession: (sessionId) => maker.getSession(sessionId),
    closeSession: (sessionId) => maker.closeSession(sessionId),
    getSessionMeta: (sessionId) => maker.getSessionMeta(sessionId),
    ensureRemoteReadyForSessionStart: async (params) => {
      await ensureRemoteReadyForSessionStart(params);
    },
    checkWorkDirExists,
    isOrcaMcpHydrated,
    buildCreateOptsWithStderr,
    synthesizeOrcaVendorOptionsFromDb,
    readSessionExtraDirsFromDb,
    readSessionWorkingDirFromDb,
    withRehydrateCloseSuppressed,
    bootstrapSession,
    markOrcaRoleIfNeeded,
    broadcastSessionCreated,
    prepareSendUserMessage: (sessionId, message) =>
      prepareUserMessageForAgent(sessionId, message, 'send'),
    materializeDirectSendOssAttachments,
    createDbMessage: async (sessionId, message, opts) => {
      // 真实用户消息(renderer 发送事务)→ 给两个自动续跑守卫充值额度。
      //
      // **必须按 agentMeta.autoResume 排除自动补发的消息。** silent-stop 的自动续跑
      // 走 session.send 直发、天然绕开本路径,但**中断自动续跑走的正是本路径**
      // (coordinator 队列 → makerSendTransaction.onAccepted → 这里)。不排除的话它
      // 每次续跑都给自己(和 silent-stop)重新充值,「每条人话最多买 N 个自动 turn」
      // 这条防死循环的硬保证就没了 —— 上游连环抽风时会无限自动续跑。
      if (isAutoResumeUserMessage(message.agentMeta)) {
        // 这条自动续跑消息的结果还不知道,登记待确认(产出→succeeded / 再被打断→failed)。
        autoResumeBookkeeping.registerPendingOutcome(sessionId, message.clientId);
      } else {
        silentStopAutoResumeGuard.noteUserSend(sessionId);
        interruptedTurnAutoResumeGuard.noteUserSend(sessionId);
      }
      // 落库失败 → 撤掉刚才那条待确认登记:那条消息压根不存在,留着会让后续事件去 patch
      // 一个不存在的 clientId,map 也一直脏着(copilot review)。登记刻意放在写之前(不能
      // 让写完到登记之间的事件漏掉结算),所以这里补一条失败回滚。
      const releasePendingOutcomeOnFailure = () => {
        if (!isAutoResumeUserMessage(message.agentMeta)) return;
        autoResumeBookkeeping.releasePendingOutcome(sessionId, message.clientId);
      };
      const result = await enqueueDurableWrite(`user:${sessionId}:${message.clientId}`, () => {
        // Coordinator accepts can stamp transcriptParentUuid early; this late FIFO
        // fallback covers makerSendTransaction/direct createDbMessage paths.
        const transcriptParentUuid = getLastAssistantTranscriptUuid(sessionId);
        const hasTranscriptParent = typeof message.agentMeta.transcriptParentUuid === 'string' &&
          message.agentMeta.transcriptParentUuid.length > 0;
        const enrichedMessage = transcriptParentUuid && !hasTranscriptParent
          ? {
              ...message,
              agentMeta: {
                ...message.agentMeta,
                transcriptParentUuid,
              },
            }
          : message;
        // session-agent-switch:user 行逐行 stamp 当前引擎(见 messages.agent_kind 注释)。
        const agentKind = getSessionDbAgentKind(sessionId);
        return createDbMessage(
          sessionId,
          agentKind ? { ...enrichedMessage, agentKind } : enrichedMessage,
          opts,
        );
      }).catch((err: unknown) => {
        releasePendingOutcomeOnFailure();
        throw err;
      });
      return result;
    },
    linkPiUserEntry: (sessionId, clientId, piEntryId) =>
      enqueueDurableWrite(`pi-entry-link:${sessionId}:${clientId}`, () =>
        patchMessageAgentMeta(sessionId, clientId, { piEntryId })),
    beforeDispatchDirectUserTurn: (sessionId) => gitSnapshotCoordinator?.onTurnStart(sessionId),
    onUndispatchedDirectUserTurn: (sessionId) => gitSnapshotCoordinator?.onTurnAbort(sessionId),
    ackInterruptedTurnDispatched: async (sessionId, endedAt) => {
      await ackSessionTurnEndedDurable(sessionId, endedAt);
    },
    previewUserPrompt: (session, content, options) => {
      const replacesCurrentTurn = autoResumeBookkeeping.isSuppressedErrorClaimedByRetry(
        session.id,
        options.clientId,
      );
      const previewed = notifyAgentIslandUserPrompt(session, content, {
        ...options,
        ...(replacesCurrentTurn ? { replacesCurrentTurn: true } : {}),
      });
      if (previewed && replacesCurrentTurn && options.clientId) {
        autoResumeBookkeeping.markReplacementPreviewed(session.id, options.clientId);
      }
    },
    dispatchUserPromptPreview: (sessionId, clientId) => {
      dispatchAgentIslandUserPrompt(sessionId);
      if (clientId) {
        autoResumeBookkeeping.markReplacementDispatching(sessionId, clientId);
      }
    },
    commitUserPromptPreview: (sessionId, clientId) => {
      commitAgentIslandUserPrompt(sessionId, clientId);
      if (clientId) {
        // Session.send has returned accepted=true. This is the exact authoritative
        // success boundary even when synchronous provider events already made the
        // coordinator active turn stale before onDispatchedUserTurn can run.
        autoResumeBookkeeping.discardSuppressedErrorForRetry(sessionId, clientId);
      }
    },
    rollbackUserPromptPreview: (sessionId, clientId, source) => {
      if (clientId) {
        autoResumeBookkeeping.rollbackReplacementPreview(sessionId, clientId);
      }
      rollbackAgentIslandUserPrompt(sessionId, clientId, source);
    },
    isSessionRunningError,
    // session-agent-switch:lazy-create 前以 DB 行为真源校正 createOpts(定义见
    // reconcileCreateOptsAgainstDb;GET_CONTEXT_USAGE 的 lazy 分支共用)。
    reconcileCreateOptsWithDb: reconcileCreateOptsAgainstDb,
    peekPendingHandoff: (sessionId) => agentHandoffPending.peek(sessionId),
    consumePendingHandoff: (sessionId) => agentHandoffPending.consume(sessionId),
    applyPendingAgentSwitch: (sessionId) => applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId),
    log,
  });

  const sendToAgentAccepted: typeof sendToAgentAcceptedUnlocked = async (...args) => {
    const [sessionId] = args;
    if (typeof sessionId !== 'string') return await sendToAgentAcceptedUnlocked(...args);
    return await withSendToSessionLock(sessionId, () => sendToAgentAcceptedUnlocked(...args));
  };
  /**
   * Same-turn steer contract: resolved STEER means maker-core accepted the
   * inserted message into the active turn (Claude: streaming input push;
   * Codex: turn/steer RPC) — the running turn is NOT interrupted (2026-07-12
   * 统一同轮注入). NO_ACTIVE_TURN is the only fallbackable
   * rejection; closed sessions, closed input queues, normalization failures, and
   * vendor start failures are hard pre-accept failures so renderer rolls back
   * the optimistic bubble instead of resurrecting the message as a new turn.
   */
  const steerToAgentAccepted = async (sessionId: unknown, message: unknown, sendOpts?: unknown): Promise<void> => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    const sess = maker.getSession(sessionId);
    if (!sess) {
      log.warn('steer: session not running', { sessionId });
      throwIpcError('NO_ACTIVE_TURN', `Session ${sessionId} is not running`);
    }
    log.info('steer: invoked', {
      sessionId,
      agentKind: sess.agentKind,
      sameTurnSteerSupported: sess.capabilities.sameTurnSteer.supported,
      activeBeforeNormalize: sess.isTurnRunning(),
    });
    if (!sess.capabilities.sameTurnSteer.supported) {
      throwIpcError('UNSUPPORTED_CAPABILITY', `Agent ${sess.agentKind} does not support same-turn steer`);
    }
    if (!sess.isTurnRunning()) {
      throwIpcError('NO_ACTIVE_TURN', `Session ${sessionId} has no active turn`);
    }

    let normalized: IpcUserMessage;
    try {
      normalized = await prepareUserMessageForAgent(sessionId, message, 'steer');
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      log.warn('steer: normalize message failed', {
        sessionId,
        agentKind: sess.agentKind,
        error: messageText,
      });
      throwIpcError('INTERNAL', messageText);
    }
    // Attachment normalization can cross async boundaries. Re-check active turn so
    // a just-finished turn does not accidentally accept a stale 插话 request.
    log.debug('steer: normalized message', {
      sessionId,
      agentKind: sess.agentKind,
      activeAfterNormalize: sess.isTurnRunning(),
      ...summarizeIpcUserMessage(normalized),
    });
    if (!sess.isTurnRunning()) {
      throwIpcError('NO_ACTIVE_TURN', `Session ${sessionId} has no active turn`);
    }
    const meta = await maker.getSessionMeta(sessionId).catch(() => null);
    const so = (sendOpts ?? {}) as { messageUuid?: string; userName?: string; signal?: AbortSignal };
    try {
      await sess.steer(normalized as never, {
        logTitle: meta?.title,
        messageUuid: so.messageUuid,
        userName: so.userName,
        signal: so.signal,
      });
      log.info('steer: delivered', { sessionId, agentKind: sess.agentKind });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      const isClosedDeliveryFailure = /session (?:is )?closed|closed session|input queue is closed/i.test(messageText);
      if (!isClosedDeliveryFailure && /no active .*turn|has no active turn/i.test(messageText)) {
        log.warn('steer: no active turn during delivery', {
          sessionId,
          agentKind: sess.agentKind,
          error: messageText,
        });
        throwIpcError('NO_ACTIVE_TURN', `Session ${sessionId} has no active turn`);
      }
      log.warn('steer: delivery failed', {
        sessionId,
        agentKind: sess.agentKind,
        error: messageText,
      });
      throwIpcError('INTERNAL', messageText);
    }
  };

  registerMakerSessionSendHandler(
    makerSessionRegistry,
    { sendToAgentAccepted },
  );

  ipcMain.handle(MAKER_INVOKE.STEER, async (_e, sessionId: unknown, message: unknown, sendOpts?: unknown) => {
    await steerToAgentAccepted(sessionId, message, sendOpts);
  });

  ipcMain.handle(MAKER_INVOKE.GET_CONTEXT_USAGE, async (_e, sessionId: unknown, createOpts?: unknown): Promise<ContextUsageData> => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    let sess = maker.getSession(sessionId);
    if (!sess) {
      if (!createOpts) {
        throwIpcError('NOT_FOUND', `Session ${sessionId} is not running`);
      }
      const co = buildCreateOptsWithStderr({ ...(createOpts as CreateOpts), id: sessionId });
      // session-agent-switch:先按 DB 行校正再判 claude-only——否则切到 codex 后
      // 残留的 claude createOpts 会在这里 spawn 出旧引擎的 live session 并被后续
      // send 复用(会话被劫持回旧引擎,2026-07-20 审计实锤)。
      await reconcileCreateOptsAgainstDb(sessionId, co);
      if (co.agentKind !== 'claude-code') {
        throwIpcError('UNSUPPORTED_CAPABILITY', `Agent ${co.agentKind} does not support context usage`);
      }
      const okLazy = await checkWorkDirExists(sessionId, co.workingDir, co.agentKind, co.remoteHostId);
      if (!okLazy) {
        throwIpcError('NOT_FOUND', `Working directory is missing for session ${sessionId}`);
      }
      await synthesizeOrcaVendorOptionsFromDb(sessionId, co);
      if (co.extraDirs === undefined) {
        try {
          const row = await readSessionExtraDirsFromDb(sessionId);
          if (row.length > 0) co.extraDirs = row;
        } catch (err) {
          log.warn('context-usage lazy-create: read extra_dirs from DB failed (non-fatal)', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        await ensureRemoteReadyForSessionStart({ createOpts: co });
        const { session: lazySess, didInjectOrcaInstructions, didInjectProjectContext } = await bootstrapSession(co);
        await markOrcaRoleIfNeeded(lazySess.id, co.orcaRole);
        log.info('context-usage: lazy create-session', {
          sessionId,
          agentKind: co.agentKind,
          model: co.model,
          usedOrcaInstructions: didInjectOrcaInstructions,
          usedProjectContext: didInjectProjectContext,
          extraDirsCount: co.extraDirs?.length ?? 0,
        });
        sess = lazySess;
      } catch (err) {
        throwIpcError('INTERNAL', err instanceof Error ? err.message : 'context usage lazy create failed');
      }
    }
    if (sess.agentKind !== 'claude-code' && sess.agentKind !== 'pi') {
      throwIpcError('UNSUPPORTED_CAPABILITY', `Agent ${sess.agentKind} does not support context usage`);
    }
    try {
      return await sess.getContextUsage();
    } catch (err) {
      if (err instanceof Error && err.name === 'NotSupportedError') {
        throwIpcError('UNSUPPORTED_CAPABILITY', err.message);
      }
      throwIpcError('INTERNAL', err instanceof Error ? err.message : 'context usage query failed');
    }
  });

  /**
   * Reconcile the in-memory turn boundary after a vendor abort/close when the
   * normal terminal event was lost. The vendor Session is authoritative for
   * whether work is still running; the desktop tracker is only an event-driven
   * view and can remain stale across owner-boundary teardown.
   */
  const getStableSessionForTurnBoundary = (sessionId: string): WiredSession | null => {
    const wired = wiredSessionsById.get(sessionId)?.session;
    if (wired) return wired;
    try {
      return maker.getSession(sessionId) ?? null;
    } catch (err) {
      // Dynamic Maker intentionally fails closed while an account owner is
      // being replaced. A missing stable wiring snapshot means we cannot
      // authoritatively reconcile this session yet; callers must retain their
      // boundary and wait for the normal close/settle path.
      log.warn('session lookup unavailable during turn-boundary reconciliation', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  /**
   * Finalize an exact retry owner that never crossed vendor dispatch.
   *
   * Technical delivery failure surfaces the suppressed error once. Explicit user
   * cancellation persists it without attention and closes the replacement Island
   * lifecycle, so delayed provider tails cannot turn the cancelled retry into a
   * false success. Both queued discard and persisted/pre-dispatch cancellation use
   * this boundary; keeping the disposition here prevents those paths from drifting.
   */
  const finalizeUndispatchedClaimedRetry = (
    sessionId: string,
    item: AgentInputQueuedMessage,
    disposition: 'cancelled' | 'failed',
  ): boolean => {
    if (disposition === 'failed') {
      return autoResumeBookkeeping.surfaceSuppressedErrorForRetry(sessionId, item.clientId);
    }
    const cancelledClaimedRetry = autoResumeBookkeeping.flushSuppressedErrorForRetry(
      sessionId,
      item.clientId,
    );
    if (!cancelledClaimedRetry) return false;
    handleAgentIslandSessionStopped(getStableSessionForTurnBoundary(sessionId) ?? sessionId);
    return true;
  };

  const reconcileSessionTurnIdle = (sessionId: string, source: string): boolean => {
    const sess = getStableSessionForTurnBoundary(sessionId);
    if (!sess) return false;
    let liveSessionIdle = false;
    try {
      liveSessionIdle = !sess.isTurnRunning();
    } catch (err) {
      log.warn('live session turn-state lookup failed during reconciliation', {
        sessionId,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    if (!liveSessionIdle) return false;
    // The vendor is authoritative that this turn is over, but no terminal event
    // reached the host. Flush and fail-seal the latest top-level Assistant before
    // releasing the boundary; otherwise its last progress line is later treated
    // as a legacy final answer by title regeneration. Preserve the last Assistant
    // id for a rare late paired done so usage attribution still has a target.
    flushAssistantBlock(sessionId, null);
    const abortedAssistantPersistId = consumeLastAssistantPersistId(sessionId);
    const abortedBoundaryAssistantPersistId = consumeLastTopLevelAssistantPersistId(sessionId);
    flushOrphanToolResults(sessionId, null);
    if (abortedAssistantPersistId) {
      pendingFailedTurnAssistantPersistId.set(sessionId, abortedAssistantPersistId);
    }
    if (abortedBoundaryAssistantPersistId) {
      void markAssistantTurnFailed(sessionId, abortedBoundaryAssistantPersistId);
    }
    const trackerStale = sessionTurnActivityTracker.isSessionInTurn(sessionId) ||
      sessionTurnActivityTracker.isSessionTurnDispatchBoundaryBusy(sessionId);
    const hadZombieInteraction = hasPendingAgentInteractionForSession(sessionId);
    if (trackerStale || hadZombieInteraction) {
      log.warn('reconciling stale session turn boundary', {
        sessionId,
        source,
        trackerStale,
        hadZombieInteraction,
        liveSessionIdle,
      });
    } else {
      // The owner-boundary wiring guard can drop the isRunning=true event
      // entirely. In that case the live Session being idle is still the
      // authoritative proof that this abort boundary can be released.
      log.info('confirmed live session idle during turn-boundary reconciliation', {
        sessionId,
        source,
      });
    }
    sessionTurnActivityTracker.setSessionInTurn(sessionId, false);
    try {
      // The marker write is best-effort and ordered behind pending message
      // persistence. It may retry/settle after an owner boundary is available.
      markTurnEndedAfterPersistDrain(sessionId);
      resetTurnPersistState(sessionId);
      noteClaudeSessionTurnState(sessionId, false);
      settlePendingCredentialSwitch(sessionId, `reconcile:${source}`);
      deferredCodexRestartHolder?.onSessionSettled();
      agentInputCoordinatorHolder?.onExternalTurnSettled(sessionId);
      refreshRemoteCodexMcpOnTurnSettledHolder?.(sessionId);
    } catch (err) {
      log.warn('stale session turn side-effect cleanup failed', {
        sessionId,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (hadZombieInteraction) {
      try {
        cleanupPendingAgentInteractionsForSession(sessionId, 'turn_idle_reconcile');
      } catch (err) {
        log.warn('stale session interaction cleanup failed', {
          sessionId,
          source,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return true;
  };

  const readDirectAbortTurnId = (session: WiredSession, sessionId: string): string | null => {
    try {
      return session.getCurrentTurnId?.() ?? null;
    } catch (err) {
      log.warn('direct abort turn-id lookup failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  const isDirectAbortBoundaryCurrent = (
    sessionId: string,
    boundary: DirectAbortReconcileBoundary,
  ): boolean => {
    if (directAbortReconcileBoundaries.get(sessionId) !== boundary) return false;
    if (wiredSessionsById.get(sessionId)?.session !== boundary.session) return false;
    if (currentSessionTurnBoundaryGeneration(sessionId) !== boundary.generation) return false;

    // Codex exposes a provider turn id. Compare only when both sides have an
    // id: after an abort the old id legitimately becomes null, while a new
    // turn with a different non-null id must invalidate this retry chain.
    const currentTurnId = readDirectAbortTurnId(boundary.session, sessionId);
    return boundary.turnId === null || currentTurnId === null || boundary.turnId === currentTurnId;
  };

  const scheduleDirectAbortReconciliation = (
    sessionId: string,
    boundary: DirectAbortReconcileBoundary,
  ): void => {
    if (boundary.retryTimer) return;
    boundary.retryTimer = setTimeout(() => {
      boundary.retryTimer = null;
      if (!isDirectAbortBoundaryCurrent(sessionId, boundary)) {
        cancelDirectAbortReconciliation(sessionId, boundary);
        return;
      }
      reconcileDirectAbortBoundary(sessionId, boundary, 'direct-abort-retry');
    }, DIRECT_ABORT_RECONCILE_RETRY_DELAY_MS);
  };

  const reconcileDirectAbortBoundary = (
    sessionId: string,
    boundary: DirectAbortReconcileBoundary,
    source: string,
  ): void => {
    if (!isDirectAbortBoundaryCurrent(sessionId, boundary)) {
      cancelDirectAbortReconciliation(sessionId, boundary);
      return;
    }

    let reconciledIdle = false;
    try {
      reconciledIdle = reconcileSessionTurnIdle(sessionId, source);
    } catch (err) {
      log.warn('direct abort idle reconciliation failed', {
        sessionId,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (reconciledIdle) {
      cancelDirectAbortReconciliation(sessionId, boundary);
      return;
    }

    // Keep the boundary fail-closed until the same Session instance and turn
    // generation prove idle. Owner replacement, a new turn, or close cancels
    // this chain through the identity/generation guards above.
    if (isDirectAbortBoundaryCurrent(sessionId, boundary)) {
      scheduleDirectAbortReconciliation(sessionId, boundary);
    } else {
      cancelDirectAbortReconciliation(sessionId, boundary);
    }
  };

  const beginDirectAbortReconciliation = (
    sessionId: string,
    session: WiredSession,
  ): DirectAbortReconcileBoundary => {
    cancelDirectAbortReconciliation(sessionId);
    const boundary: DirectAbortReconcileBoundary = {
      session,
      generation: currentSessionTurnBoundaryGeneration(sessionId),
      turnId: readDirectAbortTurnId(session, sessionId),
      retryTimer: null,
    };
    directAbortReconcileBoundaries.set(sessionId, boundary);
    return boundary;
  };

  const inputCoordinator: AgentInputCoordinator = new AgentInputCoordinator({
    sendToAgent: async (sessionId, message, createOpts, sendOpts) => {
      try {
        const result = await sendToAgentAccepted(sessionId, message, createOpts, sendOpts);
        await orcaInterAgentDispatcher.settleQueuedOrcaInterAgentAcceptedCallback(sessionId, sendOpts, result.outcome);
        return result.outcome;
      } catch (err) {
        await orcaInterAgentDispatcher.rollbackQueuedOrcaInterAgentAcceptedCallback(
          sessionId,
          sendOpts.persistUserMessage?.clientId,
        );
        throw err;
      }
    },
    // turn 被上游打断(且已有产出)→ 自动替用户点一次「继续」。判据、额度、退避都在
    // interruptedTurnAutoResume;这里只做编排:决策 → 退避 → 复核 → 补发 → 失败回滚。
    // 纯判定,无副作用:coordinator 用它在「决策还做不了」的时序里先把红横幅与 error 行
    // 按住(见 isAutoResumeDeferred)。与下面 onResumableTurnError 的第一道门是同一个函数,
    // 两处必须同判据 —— 否则会出现"按住了却永远不接管"或"没按住却接管"的错配。
    isResumableTurnErrorCandidate: (signals: InterruptedTurnErrorSignals) =>
      isInterruptedTurnError(signals),
    // 被按住的 error 最终没接管：统一从 bookkeeping 释放。真正成为最终失败时同步到
    // Agent Island；被用户接手或被另一条技术错误顶替时只补历史，不再打扰用户。
    onResumableTurnErrorDiscarded: (
      sessionId: string,
      options: { surfaceError: boolean },
    ) => {
      if (options.surfaceError) autoResumeBookkeeping.surfaceSuppressedError(sessionId);
      else autoResumeBookkeeping.flushSuppressedError(sessionId);
    },
    onResumableTurnError: (
      sessionId: string,
      signals: InterruptedTurnErrorSignals,
      item: AgentInputQueuedMessage,
    ) => {
      if (!isInterruptedTurnError(signals)) return null;
      const erroredAt = Date.now();
      const decision = interruptedTurnAutoResumeGuard.onInterruptedTurn(sessionId, erroredAt);
      if (decision.action !== 'resume') {
        // 不接管 → coordinator 走常规错误呈现(落 error 行 + 红横幅 + 「继续任务」)。
        // 额度耗尽 / 熔断 / 开关关闭都走这里:自愈救不动了就把方向盘交回用户。
        log.debug('interrupted-turn auto-resume not granted', {
          sessionId,
          action: decision.action,
        });
        return null;
      }
      // 接管:压住这条错误的落库与横幅,只在聊天流里显示低调的自愈提示。
      //
      // **详情的暂存刻意不在这里做**,由 onEvent 里"压住落库"那一刻唯一负责
      // (`autoResumeSuppressesPersist` 分支)。原先两处都 stash 一遍,内容相同、看着无害,
      // 但 stashSuppressedError 现在要在覆盖前把**上一次**中断补落 —— 同一次中断 stash 两遍
      // 就会把正在压制中的自己补落出来,红色错误卡与活动行同时出现。每次中断只 stash 一次
      // 是那条 flush 成立的前提。
      //
      // saveTurnStartedAtForDeferred 与 isRemoteAuthRetry 同款 —— 补落时 turn 开始时刻
      // 已被 resetTurnPersistState 清掉,不先存一份会让 /clear 竞态 cap 判错。
      saveTurnStartedAtForDeferred(sessionId);
      log.info('interrupted-turn auto-resume scheduled', {
        sessionId,
        attempt: decision.attempt,
        maxAttempts: decision.maxAttempts,
        sessionTotal: decision.sessionTotal,
        delayMs: decision.delayMs,
      });
      const schedulerRunId =
        item.origin?.kind === 'scheduler' && typeof item.origin.runId === 'string'
          ? item.origin.runId
          : null;
      if (schedulerRunId) beginSchedulerAutoResume(sessionId, schedulerRunId);
      // 排期的撤旧、补落与令牌都在 AutoResumeBookkeeping.schedule 里(带单测),这里只给
      // 退避时长和到点要干的事。
      autoResumeBookkeeping.schedule(sessionId, decision.delayMs, async (attempt) => {
        try {
          // 退避窗口内用户可能已经自己发了消息 / 清了会话。判据是 coordinator 的 recovery
          // 与**接管态**(enqueue / clearError / teardown 会清掉接管态,recovery 未必),
          // autoRetryLastError 内部复核后会 no-op 并返回非 resumed —— 此时必须回滚
          // pendingResume。
          const outcome = await inputCoordinator.autoRetryLastError(sessionId);
          // Timer fire 不是 ownership 终点。上面的 DB 判定 await 期间，用户可能已用
          // Manual Retry / clearError / 新输入接管；旧回调不得再 disposition 新 owner。
          if (!attempt.isCurrent()) {
            log.debug('interrupted-turn auto-resume completion superseded', {
              sessionId,
              outcome,
            });
            return;
          }
          if (outcome !== 'resumed') {
            interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId);
            // superseded = 用户自己接手了,别再弹横幅打扰(但中断要补进历史);
            // no-progress = 零产出、按设计不自动续跑,这是一次没人接手的真失败,
            // 必须把横幅还给用户,否则被静默吞掉(copilot review)。
            autoResumeBookkeeping.finalizeSuppressedError(sessionId, {
              surfaceError: outcome === 'no-progress',
            });
            log.debug('interrupted-turn auto-resume not dispatched', { sessionId, outcome });
            return;
          }
          // resumed 只表示续跑项已经进队；被压住的错误继续由那条 item 的 clientId
          // 持有，直到灵动岛建立 replacement-turn 边界并真正跨过 vendor dispatch。
          // Schedule 的 run 接管标记也不能在这里清：它会在续跑项即将进入
          // vendor 前清掉，让同步返回的新 terminal error 只能靠**本 attempt**重新接管；
          // 派发前被 Stop / clear / ghost block 丢弃时仍由 discard/undispatched 回调
          // 立即失败同一个 run。
          log.info('interrupted-turn auto-resume dispatched', { sessionId });
        } catch (err) {
          if (!attempt.isCurrent()) {
            log.debug('interrupted-turn auto-resume rejection superseded', { sessionId });
            return;
          }
          interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId);
          // 补发本身失败 → 回落成常规错误呈现,让用户能手点重试。
          autoResumeBookkeeping.finalizeSuppressedError(sessionId, { surfaceError: true });
          log.warn('interrupted-turn auto-resume failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
      // 回传展示信息:coordinator 存进 autoResumePending → projection → 活动行
      // (「重新连接中 attempt/maxAttempts」+ 展开详情里的原因与会话累计)。
      return {
        ...(signals.message !== undefined ? { error: signals.message } : {}),
        attempt: decision.attempt,
        maxAttempts: decision.maxAttempts,
        sessionTotal: decision.sessionTotal,
      };
    },
    steerToAgent: (sessionId, message, sendOpts) =>
      steerToAgentAccepted(sessionId, message, sendOpts),
    abortSession: async (sessionId) => {
      resetAutomaticRecoveryForExplicitStop(sessionId);
      markWorkerManualInterruptIfKnown(sessionId, 'input_stop');
      const sess = getStableSessionForTurnBoundary(sessionId);
      if (!sess) return;
      handleAgentIslandSessionStopped(sess);
      try {
        await sess.abort();
      } finally {
        // The coordinator owns idle reconciliation after this promise settles,
        // so its boolean result is not consumed twice. Interaction waiters are
        // still always released even when the vendor abort rejects.
        cleanupPendingInteractionsForSession(sessionId, 'session_aborted');
      }
    },
    isTurnRunning: (sessionId) => {
      const sess = getStableSessionForTurnBoundary(sessionId);
      return isSessionTurnDispatchBoundaryBusy(sessionTurnActivityTracker, sessionId, sess);
    },
    getTurnGeneration: (sessionId) =>
      getStableSessionForTurnBoundary(sessionId)?.getTurnGeneration() ?? null,
    reconcileTurnIdle: (sessionId) => {
      // steer 拿到 maker-core 权威 NO_ACTIVE_TURN、或 abort 已让 vendor 停止
      // 但终态事件丢失时，都走同一条收口路径。
      return reconcileSessionTurnIdle(sessionId, 'authoritative-idle');
    },
    hasPendingInteraction: hasPendingAgentInteractionForSession,
    getAgentKind: (sessionId) => getStableSessionForTurnBoundary(sessionId)?.agentKind ?? null,
    getSdkSessionId: async (sessionId) => {
      const meta = await maker.getSessionMeta(sessionId).catch(() => null);
      return meta?.sdkSessionId;
    },
    resolveSessionReferences,
    // interrupted-turn-resume:retry 续跑判定走 DB 持久化行(见 dep 注释)。
    // 先 drain 持久化写队列:terminal error 到达时 flushAssistantBlock 只是把
    // 产出行入队,立即 Retry 可能在写入落盘前查询 → 有产出被误判为零产出而
    // 重发原文(review P2)。drain 等的是全局 write chain 快照,毫秒级。
    hasAssistantProgressAfter: async (sessionId, userClientId) => {
      await drainPersistQueue();
      return hasAssistantProgressAfterMessage(sessionId, userClientId);
    },
    // retry-supersede:零产出重试的克隆行落库并派发成功后,软删被取代的旧 user 行
    // 与其后的 error 行(实现与守卫见 localDb/ipc/messages.supersedeRetriedUserTurn)。
    // 只发 messages:deleted、不额外发 sessions:patched:软删既不改变会话列表的
    // _count(权威口径不过滤 rewind_at,行本体还在)也不改变 preview(克隆行仍是最新
    // 可见行),理由与踩过的坑记在 helper 的注释里。
    supersedeRetriedUserTurn,
    getLastAssistantTranscriptUuid,
    onAcceptedQueuedMessage: (sessionId, item): Promise<void> | undefined => {
      // 已派发 → 该项不会再走 discard,释放 scheduler 的 discard 监听防泄漏。
      schedulerQueuedPromptDiscardWatchers.delete(item.clientId);
      // 返回 promise 让 coordinator 在 onPersisted 链路里 await —— worker 运行态与
      // pending auto-bridge 副作用必须先于 turn 启动完成；失败仍吞错落日志，不拦派发。
      return orcaInterAgentDispatcher.runQueuedOrcaInterAgentAcceptedCallback(sessionId, item);
    },
    onDispatchedUserTurn: async (sessionId, item, preVendorDispatchAt): Promise<void> => {
      if (
        item.autoResume &&
        item.origin?.kind === 'scheduler' &&
        typeof item.origin.runId === 'string' &&
        // sendToAgent may synchronously emit the next recoverable terminal error.
        // In that case the coordinator already owns a renewed auto-resume attempt;
        // this older dispatch must not clear the same scheduler run's new claim.
        !inputCoordinator.isAutoResumePending(sessionId)
      ) {
        clearSchedulerAutoResumePending(sessionId, item.origin.runId);
      }
      // 「继续任务」只能在 vendor dispatch 不可逆后 durable ack：
      // - enqueue 时 ack：排队可取消，旧中断横幅回不来；
      // - onAccepted 时 ack：仍可能 cancelled-before-dispatch，且无新 started，
      //   旧横幅被抹掉、隐藏续跑行也不可操作，任务会静默丢失。
      // dispatch 返回前 agent 事件可能已经写入新 started；因此 durable ack 使用
      // 进入 vendor 前冻结的时间戳，既确认旧中断，又不会盖过新 turn 的 started。
      if (item.originalSyntheticTrigger !== 'continue') return;
      try {
        await ackSessionTurnEndedDurable(sessionId, preVendorDispatchAt);
      } catch (err) {
        log.warn('continue dispatched ack failed', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
    noteSessionClearBoundary,
    // 失败 turn 重试 → hook 侧把这一轮接回渠道那条已收口的消息。source 区分
    // 人工与自动续跑：只有真人接手才作废 scheduler waiter，自动路径不能取消自己。
    onUiRetry: (sessionId, clientId, source) => {
      autoResumeBookkeeping.claimSuppressedErrorForRetry(sessionId, clientId, source);
      if (source === 'manual') {
        // UI continuation can dispatch before the scheduler backoff callback.
        // Retire that pending waiter first so it cannot consume the manual retry.
        failPendingSchedulerAutoResume(sessionId);
      }
      publishUiContinuation(sessionId, clientId);
    },
    // 新消息进队 → 作废该会话的待续跑记账(渠道那条旧消息已被别的内容取代)。
    // 用 enqueue 入口而不是消息文本: 零产出重试重发的是原文, 文本上无从区分,
    // 而它走 unshift 不经这里, 于是不会把自己的回流作废掉。
    onUserEnqueue: (sessionId) => {
      // 同步撤掉 timer / in-flight lease 与未认领的 Island filter，新 turn 不继承旧失败。
      autoResumeBookkeeping.supersedeUnclaimedErrorForUserIntervention(sessionId);
      // The user turn can dispatch before the backoff callback observes that its
      // recovery was superseded. Fail the scheduler waiter synchronously so it
      // cannot consume that unrelated turn's text/done as this run's result.
      failPendingSchedulerAutoResume(sessionId);
      publishUiSessionIntervention(sessionId);
    },
    // 技术硬失败 / policy block 与用户 Stop/clear 是两种 disposition：前者没有人接手，
    // 被压住的中断就是最终错误，必须一次性恢复到历史与 Agent Island。
    onRejectedUserTurn: (sessionId, item) => {
      autoResumeBookkeeping.surfaceSuppressedErrorForRetry(sessionId, item.clientId);
    },
    // 队列项未派发即被丢弃(stop/remove/clearSession) → 释放暂存的 accepted 副作用, 防回调表泄漏。
    onDiscardedQueuedMessage: (sessionId, item) => {
      orcaInterAgentDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId);
      // 通用 discard 只做非打扰补落：Stop / clear / remove 不应复活旧错误；policy block
      // 已先经 onRejectedUserTurn surface，这里按 clientId 会安全 no-op。
      finalizeUndispatchedClaimedRetry(sessionId, item, 'cancelled');
      // 持久化中的项在这里被取消后不会再走 onUndispatchedUserTurn，复用同一结算出口。
      settleUndispatchedAutoResumeOutcome(sessionId, item);
      // 排队心跳被丢弃 → 通知 runner 按 aborted 收尾对应 run,不让 fire 永久挂起。
      const watcher = schedulerQueuedPromptDiscardWatchers.get(item.clientId);
      if (watcher) {
        schedulerQueuedPromptDiscardWatchers.delete(item.clientId);
        try {
          watcher();
        } catch (err) {
          log.warn('scheduler queued prompt discard watcher threw', {
            clientId: item.clientId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (
        item.autoResume &&
        item.origin?.kind === 'scheduler' &&
        typeof item.origin.runId === 'string'
      ) {
        // 续跑还没跨过持久化边界，不会进入 onUndispatchedUserTurn；把普通聊天守卫
        // 的 pendingResume 一并回滚，避免本次 Stop / block 让后续中断永远失去自愈。
        interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId);
        notifySchedulerAutoResumeFailed(sessionId, item.origin.runId);
      }
    },
    hasPendingCredentialSwitch: (sessionId) => {
      if (pendingCredentialSwitchHolder?.has(sessionId) === true) return true;
      // 延迟 Codex 重启 pending 期间同样挡住本地 Codex live 会话的排队派发 ——
      // 否则排队消息在旧 host 上接续开新 turn,重启被无限顺延(review P1
      // 2026-07-23)。未 spawn / 已关闭的会话不挡:fresh spawn 本来就读新设置。
      // maker 是 dynamic facade,owner 边界窗口会抛 → 按不挡处理(边界会清 pending)。
      if (deferredCodexRestartHolder?.isPending() !== true) return false;
      try {
        const session = maker.listActiveSessions().find((s) => s.id === sessionId);
        return !!session && session.agentKind === 'codex' && !session.remoteHostId;
      } catch {
        return false;
      }
    },
    emitProjection: (projection) => {
      broadcastToAllWindows(MAKER_PUSH.INPUT_PROJECTION, projection);
    },
    // 意识拦截钩(订阅槽①):派发/落库前问已装钩子意识;fail-open 由
    // screenGhostUserMessage 内部收敛,快路径(无钩子意识)零开销。
    screenUserMessage: (sessionId, agentFacingText) =>
      screenGhostUserMessage(sessionId, agentFacingText),
    onUserMessageBlocked: (sessionId, item, verdict) =>
      broadcastGhostMessageBlocked({
        sessionId,
        clientId: item.clientId,
        text: item.text,
        ...verdict,
      }),
    onUserMessageRewritten: (sessionId, item, info) =>
      broadcastGhostMessageRewritten({ sessionId, clientId: item.clientId, ...info }),
    beforeDispatchUserTurn: (sessionId, item) => {
      if (
        item.autoResume &&
        item.origin?.kind === 'scheduler' &&
        typeof item.origin.runId === 'string'
      ) {
        // 旧 attempt 的接管标记不能跨进下一次 vendor dispatch：sendToAgent 可能在
        // 返回前同步发出新的 terminal error。先清旧标记后，可恢复错误会由同一条
        // onResumableTurnError 链重新 begin；认证/计费等确定性错误则保持未接管，
        // runner 会立即失败。若在真正 dispatch 前取消，下面的 undispatched 回调
        // 仍会按 item.origin 精确通知对应 run，不会静默丢失。
        clearSchedulerAutoResumePending(sessionId, item.origin.runId);
      }
      // hook 续跑回流的**权威归属点**: 在 vendor dispatch 之前(本回调被 await), 所以
      // 观察器挂上就不丢正文开头, 而 live session 此刻必然已就绪。clientId 对得上的
      // 才是目标续跑轮 —— 绕过 coordinator 的 turn(silent-stop 自动续跑)不走这里,
      // 结构上不可能被误认。详见 uiContinuationSignal 的模块注释。
      publishUiTurnDispatching(sessionId, item.clientId);
      return gitSnapshotCoordinator?.onTurnStart(sessionId);
    },
    onUndispatchedUserTurn: (sessionId, item, disposition) => {
      // 目标轮落库了却没能 dispatch(取消 / 失败): 记账该立刻还回去, 而不是等超时。
      publishUiTurnUndispatched(sessionId, item.clientId);
      gitSnapshotCoordinator?.onTurnAbort(sessionId);
      // persisted/pre-dispatch 与仍在队列的取消共用同一个 exact-owner 终局；技术失败
      // 必须 surface，用户接管则进入 stopped，二者不能再靠调用路径隐式推断。
      finalizeUndispatchedClaimedRetry(sessionId, item, disposition);
      // 自动续跑那条消息已落库、却最终没派出去 → 这次重连就是失败。**必须在这里钉死**:
      // 它不会产生任何 turn 事件,新加的终态结算路径够不到它,待确认记录于是悬空,被之后
      // 任何一个无关的 text / tool 事件误标成「已重新连接」(codex P1)。
      // 按 clientId 匹配 —— 别的 turn 未派发不该动这条记录。
      if (settleUndispatchedAutoResumeOutcome(sessionId, item)) {
        // 同时把守卫的 pendingResume 回滚:不回滚会让该会话之后的中断永远被判成
        // 「上一次还在路上」,再也不自愈(不变量 I5)。
        interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId);
      }
      if (
        item.autoResume &&
        item.origin?.kind === 'scheduler' &&
        typeof item.origin.runId === 'string'
      ) {
        notifySchedulerAutoResumeFailed(sessionId, item.origin.runId);
      }
    },
    // Thread 3 fix: called from drain/dispatchCompact failure paths where the item
    // was removed from the queue but not put back (persisted-failure case). If no
    // other work is pending, any deferred completion must be replayed so Agent
    // Island does not remain in the "running" phase indefinitely.
    onQueueEmptied: (sessionId) => {
      getAgentIslandService()?.notifyQueueEmptied(sessionId);
    },
    // 排队输入崩溃恢复(issue #761):快照写入 fire-and-forget(模块内 per-session
    // 写链保序 + 失败落日志),读回由 IPC 入口的 ensureQueueRestored 懒触发。
    persistQueueSnapshot: (sessionId, items) => saveAgentInputQueueSnapshot(sessionId, items),
    loadQueueSnapshot: (sessionId) => loadAgentInputQueueSnapshot(sessionId),
    getPersistedClientIds: async (sessionId, clientIds) => {
      if (clientIds.length === 0) return new Set<string>();
      const db = getDbClient().drizzle;
      const rows = await db
        .select({ clientId: messages.clientId })
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), inArray(messages.clientId, clientIds)));
      return new Set(rows.map((r) => r.clientId));
    },
  });
  agentInputCoordinatorHolder = inputCoordinator;
  getAgentIslandService()?.setCompletionDeferResolver((sessionId) =>
    inputCoordinator.hasPendingQueuedWork(sessionId)
  );

  // Scheduler 撞忙排队桥实现(导出薄封装见 isSchedulerTargetSessionBusy 一带注释)。
  // registerAll 可能因切账号重跑:先清旧账号残留的 discard 监听(对应队列快照
  // 已随账号切换失效,runner 侧 run 也已被 sweep 收尾)。
  schedulerQueuedPromptDiscardWatchers.clear();
  schedulerQueueBridgeHolder = {
    isSessionBusy: (sessionId) => {
      // 两个视角取并集:coordinator 队列/锁/凭证切换视角(shouldQueueNewTurn,
      // 含 dispatch-boundary busy)∪ turn 活动视角(tracker + live session 自报,
      // maker-core 修复后含自动续跑 turn)。任一认为忙即入队,不再让 runner 盲发。
      const sess = maker.getSession(sessionId);
      return (
        inputCoordinator.shouldQueueNewTurn(sessionId) ||
        isSessionTurnDispatchBoundaryBusy(sessionTurnActivityTracker, sessionId, sess)
      );
    },
    hasQueuedPrompt: (sessionId, scheduleId) =>
      inputCoordinator.hasQueuedItemWhere(
        sessionId,
        (item) => item.origin?.kind === 'scheduler' && item.origin.scheduleId === scheduleId,
        { includeRecovery: true },
      ),
    enqueuePrompt: async (req) => {
      const [meta, dbRow] = await Promise.all([
        maker.getSessionMeta(req.sessionId).catch(() => null),
        getSessionRowSnapshot(req.sessionId),
      ]);
      if (!meta || !dbRow) {
        throw new Error(`scheduler enqueue: session ${req.sessionId} not found`);
      }
      if (dbRow.status === 'archived' || dbRow.status === 'deleted') {
        throw new Error(`scheduler enqueue: session ${req.sessionId} is ${dbRow.status}`);
      }
      // 去重必须在崩溃恢复快照读回**之后**做:重启后快照未恢复时内存队列是空的,
      // 只查内存会漏掉快照里的同任务心跳,恢复完成后两条都派发(PR #972 review P1)。
      // ensureQueueRestored 读快照失败时内部吞错并保持未恢复态(等下次入口重试),
      // 所以必须再以 isQueueRestored 确认:未恢复就不入队,返回 retry 让 runner
      // 顺延本次 fire —— 恢复成功前持久化去重无从谈起,宁可晚一轮不留双份。
      await inputCoordinator.ensureQueueRestored(req.sessionId).catch(() => undefined);
      if (!inputCoordinator.isQueueRestored(req.sessionId)) {
        return { retry: true as const };
      }
      // 暂停中的队列(用户 Stop / 崩溃恢复出用户草稿的恢复暂停)不入队:暂停队列
      // 永不 drain、只有用户显式操作解除,塞进去的心跳 accepted 永远不来,run 会
      // 永久挂 running(review P1/P2)。返回 retry 让 runner 顺延,90s 轮询直到
      // 用户恢复/清空队列后再正常排队或直发。
      if (inputCoordinator.isQueuePaused(req.sessionId)) {
        return { retry: true as const };
      }
      if (
        inputCoordinator.hasQueuedItemWhere(
          req.sessionId,
          (item) => item.origin?.kind === 'scheduler' && item.origin.scheduleId === req.origin.scheduleId,
          { includeRecovery: true },
        )
      ) {
        return { duplicate: true as const };
      }
      const clientId = createId();
      if (req.onDiscarded) {
        schedulerQueuedPromptDiscardWatchers.set(clientId, req.onDiscarded);
      }
      try {
        await enqueueSendToSessionMessage({
          targetSessionId: req.sessionId,
          message: req.text,
          persistedContent: req.persistedContent,
          clientId,
          meta,
          dbRow,
          onAccepted: req.onAccepted,
          onAcceptedRollback: req.onAcceptedRollback,
          origin: req.origin,
        });
      } catch (err) {
        schedulerQueuedPromptDiscardWatchers.delete(clientId);
        throw err;
      }
      return { clientId };
    },
    removeQueuedPrompt: (sessionId, clientId) => {
      // remove 只作用于 pending 行;已进入派发(activeTurn)的项 no-op —— 调用方
      // (runner abort 路径)对此已有兜底(转 session.abort)。
      inputCoordinator.remove(sessionId, clientId);
    },
    // 存活探测刻意**不含** recovery:项转入 active-turn recovery 后,Retry 走
    // "克隆已受理 turn"路径,不会再触发 onAcceptedQueuedMessage,排队方注册的
    // 回调永远等不到 —— 视为不存活,让 runner 的 run 以失败收口而非永久挂起。
    isPromptTracked: (sessionId, clientId) =>
      inputCoordinator.hasQueuedItemWhere(sessionId, (item) => item.clientId === clientId),
  };

  // 延迟生效的凭证切换登记表:set-model 撞上"会话自己在跑"时不再拒绝,登记到这里,
  // turn 结束边界(上方 onEvent 接线)自动兑现:关会话 + 写 route + 广播 + 唤醒队列。
  const pendingCredentialSwitchService = new PendingCredentialSwitchService({
    maker,
    isSessionInTurn,
    broadcastApplied: (payload) => {
      broadcastToAllWindows(MAKER_PUSH.SESSION_CREDENTIAL_SWITCH_APPLIED, payload);
    },
    onApplied: (sessionId) => {
      inputCoordinator.wakeSession(sessionId, 'pending-credential-switch-applied');
    },
    // 停用轴:deferred 切换收口前重裁决(SET_MODEL 时刻裁决过,但生效可能在数分钟
    // 后,期间目标可能被停用;PR #744 review 第七轮,第十四轮换宽松降级形态 ——
    // 目标全停时连模型一起换到启用兜底)。
    resolveRoute: resolveLenientSessionRoute,
    // 裁决改道 / 清空显式来源 / 全停换模型时回写 DB + 广播 patch:renderer 在
    // deferred 接受时已按请求值落盘,不纠正则下一次懒 resume 按停用路由重建
    // (PR #744 review 第十、十四轮)。
    persistRoute: async (sessionId, route) => {
      const patch: Record<string, unknown> = { providerId: route.providerId };
      if (route.model) patch.model = route.model;
      if (route.effort) patch.effort = route.effort;
      if (route.fastMode !== undefined) patch.fastMode = route.fastMode;
      await getDbClient()
        .drizzle.update(sessions)
        .set(patch)
        .where(eq(sessions.id, sessionId));
      broadcastSessionPatched(sessionId, patch);
    },
    logger: log,
  });
  pendingCredentialSwitchHolder = pendingCredentialSwitchService;

  // Memory 设置变更撞上 Codex busy 时的延迟软重启登记(见 deferredCodexRestart.ts)。
  // 与 pendingCredentialSwitchService 共用 turn 结束 / 会话关闭边界接线;pending
  // 期间本地 Codex live 会话的排队派发被上方 coordinator 的 hasPendingCredentialSwitch
  // 谓词挡住,兑现后由 onApplied 逐个唤醒。
  const deferredCodexRestartService = new DeferredCodexRestartService({
    restart: restartCodexAfterAuthModeChange,
    hasBusyLocalCodexSession: () =>
      maker
        .listActiveSessions()
        .some(
          (session) =>
            session.agentKind === 'codex' &&
            !session.remoteHostId &&
            isLocalSessionBusy(session, isSessionInTurn),
        ),
    listLocalCodexSessionIds: () =>
      maker
        .listActiveSessions()
        .filter((session) => session.agentKind === 'codex' && !session.remoteHostId)
        .map((session) => session.id),
    onApplied: (sessionIds) => {
      for (const sessionId of sessionIds) {
        inputCoordinator.wakeSession(sessionId, 'deferred-codex-restart-applied');
      }
    },
    logger: log,
  });
  deferredCodexRestartHolder = deferredCodexRestartService;
  // 新本地 Codex 会话加入 shared host 前先尝试兑现 pending 的延迟重启,
  // 让它直接在新状态的 fresh host 上起跑(maker-host onBeforeStart 接线)。
  setBeforeLocalCodexSessionStartHook(() =>
    deferredCodexRestartService.flushBeforeLocalCodexSessionStart(),
  );

  const requireSessionId = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    return value;
  };
  const requireClientId = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0) {
      throwIpcError('INVALID_PARAMS', 'clientId required');
    }
    return value;
  };
  const requireSessionRefs = (value: unknown): AgentInputSessionRef[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_SESSION_REFERENCES) {
      throwIpcError('INVALID_PARAMS', `sessionRefs must contain at most ${MAX_SESSION_REFERENCES} items`);
    }
    const refs = value as AgentInputSessionRef[];
    const seen = new Set<string>();
    for (const ref of refs) {
      if (
        !ref ||
        typeof ref.sessionId !== 'string' ||
        ref.sessionId.length === 0 ||
        ref.sessionId.length > 256 ||
        (ref.deviceId !== undefined && (typeof ref.deviceId !== 'string' || ref.deviceId.length === 0)) ||
        (typeof ref.deviceId === 'string' && ref.deviceId.length > 256) ||
        (ref.messageClientId !== undefined &&
          (typeof ref.messageClientId !== 'string' || ref.messageClientId.length === 0 || ref.messageClientId.length > 256))
      ) {
        throwIpcError('INVALID_PARAMS', 'sessionRefs contains an invalid reference');
      }
      const key = `${ref.deviceId ?? ''}\u0000${ref.sessionId}\u0000${ref.messageClientId ?? ''}`;
      if (seen.has(key)) throwIpcError('INVALID_PARAMS', 'sessionRefs contains duplicates');
      seen.add(key);
    }
    return refs;
  };
  const requireTrustedReferenceContexts = (
    refs: AgentInputSessionRef[] | undefined,
    value: unknown,
  ): AgentInputSessionReferenceContext[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > MAX_SESSION_REFERENCES || value.length !== (refs?.length ?? 0)) {
      throwIpcError('SESSION_REFERENCE_UNAVAILABLE', 'remote session reference snapshot count is invalid');
    }
    const contexts = value as AgentInputSessionReferenceContext[];
    let totalMessages = 0;
    let totalTokens = 0;
    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index];
      const ref = refs?.[index];
      if (
        !context ||
        typeof context.sessionId !== 'string' ||
        context.sessionId.length > 256 ||
        (context.title !== undefined && (typeof context.title !== 'string' || context.title.length > 128)) ||
        !Array.isArray(context.messages)
      ) {
        throwIpcError('SESSION_REFERENCE_UNAVAILABLE', 'remote session reference snapshot is invalid');
      }
      if (
        !ref ||
        ref.sessionId !== context.sessionId ||
        ref.messageClientId !== context.messageClientId ||
        ref.deviceId !== context.deviceId ||
        (context.source !== 'local' && context.source !== 'device-link') ||
        (context.source === 'local' && context.deviceId !== undefined) ||
        (context.source === 'device-link' && typeof context.deviceId !== 'string') ||
        (context.range !== 'recent' && context.range !== 'around-anchor') ||
        context.messageCount !== context.messages.length ||
        typeof context.truncated !== 'boolean'
      ) {
        throwIpcError('SESSION_REFERENCE_UNAVAILABLE', 'remote session reference snapshot does not match the request');
      }
      if (context.terminal !== undefined) {
        const terminal = context.terminal;
        if (
          !terminal ||
          typeof terminal !== 'object' ||
          Array.isArray(terminal) ||
          terminal.status !== 'error' ||
          (
            terminal.createdAt !== undefined &&
            (typeof terminal.createdAt !== 'number' || !Number.isFinite(terminal.createdAt))
          )
        ) {
          throwIpcError('SESSION_REFERENCE_UNAVAILABLE', 'remote session reference terminal status is invalid');
        }
        // Strip unknown fields at this trust boundary. The marker is
        // intentionally status-only; provider error details must not cross
        // into the model prompt through a crafted remote snapshot.
        context.terminal = {
          status: 'error',
          ...(terminal.createdAt !== undefined ? { createdAt: terminal.createdAt } : {}),
        };
      }
      totalMessages += context.messages.length;
      for (const message of context.messages) {
        if (!message || (message.role !== 'user' && message.role !== 'assistant') || typeof message.content !== 'string') {
          throwIpcError('SESSION_REFERENCE_UNAVAILABLE', 'remote session reference message is invalid');
        }
        totalTokens += estimateReferenceTokens(message.content);
      }
    }
    const serializedTokens = estimateReferenceTokens(serializeSessionReferencePayload(contexts));
    if (
      totalMessages > MAX_REFERENCE_MESSAGES ||
      totalTokens > MAX_REFERENCE_TOKENS ||
      serializedTokens > MAX_REFERENCE_TOKENS - 128
    ) {
      throwIpcError('SESSION_REFERENCE_UNAVAILABLE', 'remote session reference snapshot exceeds the shared budget');
    }
    return contexts;
  };
  const requireQueuedMessage = (
    value: unknown,
    opts?: { allowMissingTrustedContexts?: boolean },
  ): AgentInputQueuedMessage => {
    if (!value || typeof value !== 'object') throwIpcError('INVALID_PARAMS', 'queued message required');
    const msg = value as AgentInputQueuedMessage;
    if (typeof msg.clientId !== 'string' || !msg.clientId) {
      throwIpcError('INVALID_PARAMS', 'queued.clientId required');
    }
    if (typeof msg.text !== 'string') throwIpcError('INVALID_PARAMS', 'queued.text required');
    if (typeof msg.persistedContent !== 'string') throwIpcError('INVALID_PARAMS', 'queued.persistedContent required');
    if (!msg.chatMessage || typeof msg.chatMessage !== 'object') {
      throwIpcError('INVALID_PARAMS', 'queued.chatMessage required');
    }
    if (!msg.createOpts || typeof msg.createOpts !== 'object') {
      throwIpcError('INVALID_PARAMS', 'queued.createOpts required');
    }
    if (
      msg.createOpts.agentKind !== 'claude-code'
      && msg.createOpts.agentKind !== 'codex'
      && msg.createOpts.agentKind !== 'pi'
    ) {
      throwIpcError('INVALID_PARAMS', 'queued.createOpts.agentKind invalid');
    }
    const normalized: AgentInputQueuedMessage = { ...msg };
    const refs = requireSessionRefs(normalized.sessionRefs);
    if (!isDeviceLinkInvoke()) {
      // preload/renderer 不属于可信边界，不能直接注入历史正文。
      delete normalized.trustedSessionReferenceContexts;
      delete normalized.sessionReferencesRequireTrustedSnapshot;
      return normalized;
    }
    const contexts = requireTrustedReferenceContexts(refs, normalized.trustedSessionReferenceContexts);
    if ((refs?.length ?? 0) > 0) normalized.sessionReferencesRequireTrustedSnapshot = true;
    else delete normalized.sessionReferencesRequireTrustedSnapshot;
    if (
      (normalized.sessionRefs?.length ?? 0) > 0 &&
      !contexts &&
      !opts?.allowMissingTrustedContexts
    ) {
      throwIpcError('SESSION_REFERENCE_UNAVAILABLE', 'remote session references were not resolved by the controller');
    }
    return normalized;
  };

  ipcMain.handle(DL_SESSION_REFERENCE_CAPABILITY_CHANNEL, () => ({
    supported: true,
    version: 1,
  }));

  /**
   * device-link 远控输入的自动起名(入队 / 插话共用)。
   *
   * 只对远控调用生效:本机 renderer 自己走 `maker:auto-title`。返回一个 commit 闭包
   * 而不是直接调度 —— 调度必须发生在输入真正被 coordinator 接受之后,否则输入被拒
   * 时会留下一个凭空出现的标题。
   */
  const prepareDeviceLinkAutoTitle = async (
    sid: string,
    queued: AgentInputQueuedMessage,
  ): Promise<() => void> => {
    const noop = () => {};
    if (!isDeviceLinkInvoke()) return noop;
    // 起名素材:用户写了字就用他的字(可喂标题模型);一个字没写(只贴图 / 只拖
    // 文件 / 只 @ 一个文件 / 只引用一个会话)就用本地合成的描述,只当占位标题。
    const seed = deriveAutoTitleSeed(queued, {
      image: t('ccAgent.autoTitle.image'),
      file: t('ccAgent.autoTitle.file'),
    });
    if (!seed) return noop;
    let eligible: boolean;
    try {
      eligible = await isSessionAutoTitleEligible(sid);
    } catch (err) {
      // 这一步只是省一次无谓调度的**廉价预检**,权威资格判定在
      // runSessionAutoTitle 内部(它自己也做重试安全的处理)。读不到时按"要起名"
      // 放行,否则一次 DB 抖动就会让单轮对话的标题永久停在 New Maker(review P1)。
      log.warn('[device-link] auto-title precheck failed (scheduling anyway)', {
        sessionId: sid,
        err: err instanceof Error ? err.message : String(err),
      });
      eligible = true;
    }
    if (!eligible) return noop;
    return () => {
      scheduleSessionAutoTitle({
        sessionId: sid,
        text: seed.text,
        agentKind: queued.createOpts.agentKind,
        isUserText: seed.isUserText,
      });
    };
  };

  ipcMain.handle(MAKER_INVOKE.INPUT_GET_PROJECTION, async (_e, sessionId: unknown) => {
    const sid = requireSessionId(sessionId);
    // 崩溃恢复(issue #761):renderer 打开会话首次取 projection 前,先把持久化的
    // 排队输入读回内存态,返回值即含恢复后的队列,不依赖 push 补发。
    // 失败时仍返回当前内存态 projection(宁可漏恢复也不阻塞会话打开)。
    await inputCoordinator.ensureQueueRestored(sid).catch(() => undefined);
    return inputCoordinator.getProjection(sid);
  });

  // device-link 出方向:远程入队消息的 OSS 引用(files[] + persistedContent)在入队前一次性物化成本地
  // 临时文件(共用下载、用后删 OSS),保证喂 agent 的 files[] 与落库的 persistedContent 都是本地路径。
  // 本机会话无 OSS 引用 → materializeQueuedOssAttachments 原样返回,零开销。
  ipcMain.handle(MAKER_INVOKE.INPUT_ENQUEUE, async (_e, sessionId: unknown, item: unknown, opts?: unknown) => {
    const sid = requireSessionId(sessionId);
    // 恢复先于入队:普通新输入保持 FIFO；「继续任务」由 coordinator 在完整旧队列
    // 恢复后再明确插到队首，避免恢复竞态把它重新压到后面。
    await inputCoordinator.ensureQueueRestored(sid).catch(() => undefined);
    const queuedWithAttachments = (await materializeQueuedOssAttachments(
      sid,
      requireQueuedMessage(item),
    )) as AgentInputQueuedMessage;
    const queued = await hydrateQueuedAgentReferences(queuedWithAttachments);
    const commitAutoTitle = await prepareDeviceLinkAutoTitle(sid, queued);

    // 「继续任务」durable ack 延后到 vendor dispatch 成功（onDispatchedUserTurn）：
    // 排队可取消时旧中断提示必须能恢复；accepted 但仍可能 cancelled-before-dispatch
    // 时也不能提前 ack。续跑项本身由 coordinator 插到队首（普通输入仍 FIFO）。
    const projection = inputCoordinator.enqueue(sid, queued, {
      ...(opts && typeof opts === 'object' ? opts as { sendAtMs?: number } : undefined),
      // INPUT_ENQUEUE 只承载显式用户输入(composer 发送 / UI trigger / device-link
      // 被控端转投的用户消息):崩溃恢复出的暂停队列遇到显式输入即放行,解开
      // 「继续任务/新消息全部排队直到重启」的死锁。Orca 自动投递走 main 侧直调
      // enqueue,不带此 flag,恢复暂停语义不变。
      resumeRestorePausedQueue: true,
    });
    commitAutoTitle();
    return projection;
  });

  ipcMain.handle(MAKER_INVOKE.INPUT_COMPACT, async (_e, sessionId: unknown, createOpts: unknown, opts?: unknown) => {
    const sid = requireSessionId(sessionId);
    await inputCoordinator.ensureQueueRestored(sid).catch(() => undefined);
    if (!createOpts || typeof createOpts !== 'object') {
      throwIpcError('INVALID_PARAMS', 'createOpts required');
    }
    const typedCreateOpts = createOpts as AgentInputCreateOpts;
    if (typedCreateOpts.agentKind !== 'claude-code') {
      throwIpcError('INVALID_PARAMS', 'compact only supports claude-code sessions');
    }
    return inputCoordinator.compact(
      sid,
      typedCreateOpts,
      opts && typeof opts === 'object' ? opts as { userName?: string } : undefined,
    );
  });

  ipcMain.handle(MAKER_INVOKE.INPUT_STEER, async (_e, sessionId: unknown, item: unknown, opts?: unknown) => {
    const sid = requireSessionId(sessionId);
    await inputCoordinator.ensureQueueRestored(sid).catch(() => undefined);
    const steerOpts = opts && typeof opts === 'object'
      ? opts as { removeFromQueue?: boolean; touchUserSend?: boolean }
      : undefined;
    const queuedWithAttachments = (await materializeQueuedOssAttachments(
      sid,
      requireQueuedMessage(item, {
        // A device-link projection intentionally omits the trusted snapshot.
        // Only the explicit remove-from-queue steer path may reattach it from
        // the main-owned row; all other IPC paths remain fail-closed here.
        allowMissingTrustedContexts: isDeviceLinkInvoke() && steerOpts?.removeFromQueue === true,
      }),
    )) as AgentInputQueuedMessage;
    const queued = await hydrateQueuedAgentReferences(queuedWithAttachments);
    // 插话也补起名:远控用户完全可能趁这一轮还在跑就写下第一句话,只认入队的话
    // 标题会一直停在首条纯附件消息的合成占位上(PR #510 review P1)。是否真的该
    // 改名由 runSessionAutoTitle 权威判定。
    const commitAutoTitle = await prepareDeviceLinkAutoTitle(sid, queued);
    // steer 与 enqueue 不同:它会因同会话已有在飞 steer / Stop 边界 / 输入锁而
    // 返回 false。必须等它落定、受理了才改名 —— 被拒的文本改掉默认名 / 合成占位 /
    // fork 占位就是凭空改名(review P1)。
    const accepted = await inputCoordinator.steer(
      sid,
      queued,
      steerOpts,
    );
    if (accepted) commitAutoTitle();
    return accepted;
  });

  ipcMain.handle(MAKER_INVOKE.INPUT_STOP, async (_e, sessionId: unknown, opts?: unknown) => {
    const sid = requireSessionId(sessionId);
    // 这三类续跑撤销都是同步操作，必须早于 goal/DB await；
    // 否则退避 timer 能在用户已点 Stop 后抢先发出下一轮。
    resetAutomaticRecoveryForExplicitStop(sid);
    // pauseGoal 调用同步 detach listener/timer，持久化可以与 vendor abort 并行；真正的
    // turn/interrupt 先启动，IPC 回执再等待 paused 落盘。
    const goalPause = pauseGoalBeforeExplicitStop(sid);
    const result = inputCoordinator.stop(
      sid,
      opts && typeof opts === 'object'
        ? opts as { keepQueue?: boolean; pauseQueue?: boolean }
        : undefined,
    );
    // Thread 1 fix: stop() clears pendingCompacts (and optionally pendingQueue)
    // without calling notifyQueueEmptied. A compact-only queue stopped here would
    // leave a deferred completion stuck forever. Mirror the INPUT_REMOVE pattern.
    if (!inputCoordinator.hasPendingQueuedWork(sid)) {
      getAgentIslandService()?.notifyQueueEmptied(sid);
    }
    await goalPause;
    return result;
  });

  ipcMain.handle(MAKER_INVOKE.INPUT_RESUME, (_e, sessionId: unknown) =>
    inputCoordinator.resume(requireSessionId(sessionId)));

  ipcMain.handle(MAKER_INVOKE.INPUT_RETRY_LAST_ERROR, (_e, sessionId: unknown) =>
    inputCoordinator.retryLastError(requireSessionId(sessionId)));

  ipcMain.handle(MAKER_INVOKE.INPUT_CLEAR_ERROR, (_e, sessionId: unknown) =>
    inputCoordinator.clearError(requireSessionId(sessionId)));

  // renderer auth-retry 放弃时（catch / guard fall-through）调回 main 补落持久化。
  // main 侧在 isRemoteAuthRetry 条件下跳过了 onTurnErrorEvent；此处覆盖"重试失败/不能重试"两路。
  // agentMetaRaw:renderer 传来的 event.agentMeta(可选),用于 flushAssistantBlock 边界 meta 兜底
  // 与 dedup key(requestId/uuid),与 register.ts 主路径 onTurnErrorEvent(sid, errData, event.agentMeta) 对称。
  ipcMain.handle(MAKER_INVOKE.PERSIST_TURN_ERROR_DEFERRED, (_e, sessionId: unknown, errDataRaw: unknown, agentMetaRaw: unknown) => {
    const sid = requireSessionId(sessionId);
    const errData = errDataRaw != null && typeof errDataRaw === 'object'
      ? errDataRaw as { message?: unknown; reason?: unknown; sdkError?: unknown }
      : null;
    const agentMeta = agentMetaRaw != null && typeof agentMetaRaw === 'object'
      ? agentMetaRaw as AgentMeta
      : null;
    onTurnErrorEvent(sid, errData, agentMeta);
    getAgentIslandService()?.resolveDeferredRemoteAuthRetryError(sid);
  });

  ipcMain.handle(MAKER_INVOKE.INPUT_REMOVE, (_e, sessionId: unknown, clientId: unknown) => {
    const sid = requireSessionId(sessionId);
    const cid = requireClientId(clientId);
    const result = inputCoordinator.remove(sid, cid);
    if (!inputCoordinator.hasPendingQueuedWork(sid)) {
      getAgentIslandService()?.notifyQueueEmptied(sid);
    }
    return result;
  });

  ipcMain.handle(MAKER_INVOKE.INPUT_UPDATE_TEXT, (
    _e,
    sessionId: unknown,
    clientId: unknown,
    newText: unknown,
    sessionRefs?: unknown,
    trustedContexts?: unknown,
  ) => {
    if (typeof newText !== 'string') throwIpcError('INVALID_PARAMS', 'newText required');
    const refs = requireSessionRefs(sessionRefs);
    const remote = isDeviceLinkInvoke();
    const contexts = remote ? requireTrustedReferenceContexts(refs, trustedContexts) : undefined;
    if (remote && (refs?.length ?? 0) > 0 && !contexts) {
      throwIpcError('SESSION_REFERENCE_UNAVAILABLE', 'remote session references were not resolved by the controller');
    }
    return inputCoordinator.updateText(
      requireSessionId(sessionId),
      requireClientId(clientId),
      newText,
      refs,
      contexts,
      remote,
    );
  });

  // 与 enqueue/steer 同一套物化:远程编辑保存的新附件可能是 OSS 引用,入队前物化成本地文件。
  ipcMain.handle(MAKER_INVOKE.INPUT_UPDATE_CONTENT, async (_e, sessionId: unknown, clientId: unknown, item: unknown) => {
    const sid = requireSessionId(sessionId);
    const cid = requireClientId(clientId);
    const remote = isDeviceLinkInvoke();
    const parsed = requireQueuedMessage(item);
    const queuedWithAttachments = (await materializeQueuedOssAttachments(
      sid,
      parsed,
    )) as AgentInputQueuedMessage;
    const queued = await hydrateQueuedAgentReferences(queuedWithAttachments);
    // 旧 device-link update-content 调用没有 side-channel sessionRefs；显式
    // 传空数组，避免 updateQueuedMessageContent 从完整文本重新解析控制端坐标。
    const update = remote && parsed.sessionRefs === undefined
      ? { ...queued, sessionRefs: [] }
      : queued;
    return inputCoordinator.updateContent(sid, cid, update);
  });

  ipcMain.handle(MAKER_INVOKE.INPUT_MOVE, (_e, sessionId: unknown, clientId: unknown, targetIndex: unknown) => {
    if (typeof targetIndex !== 'number' || !Number.isFinite(targetIndex)) {
      throwIpcError('INVALID_PARAMS', 'targetIndex required');
    }
    return inputCoordinator.move(requireSessionId(sessionId), requireClientId(clientId), targetIndex);
  });

  ipcMain.handle(MAKER_INVOKE.INPUT_SET_EXPANDED, (_e, sessionId: unknown, expanded: unknown) =>
    inputCoordinator.setExpanded(requireSessionId(sessionId), expanded === true));

  ipcMain.handle(MAKER_INVOKE.INPUT_SET_INTERACTION_LOCK, (_e, sessionId: unknown, lockId: unknown, locked: unknown) =>
    inputCoordinator.setInteractionLock(requireSessionId(sessionId), requireClientId(lockId), locked === true));

  ipcMain.handle(MAKER_INVOKE.INPUT_SET_EDIT_LOCK, (_e, sessionId: unknown, clientId: unknown, locked: unknown) =>
    inputCoordinator.setEditLock(requireSessionId(sessionId), requireClientId(clientId), locked === true));

  ipcMain.handle(MAKER_INVOKE.INPUT_CLEAR_SESSION, async (_e, sessionId: unknown, clearedAt: unknown) => {
    if (
      clearedAt !== undefined
      && (typeof clearedAt !== 'string' || !Number.isFinite(new Date(clearedAt).getTime()))
    ) {
      throwIpcError('INVALID_PARAMS', 'clearedAt must be an ISO timestamp');
    }
    const sid = requireSessionId(sessionId);
    const remoteInvoke = isDeviceLinkInvoke();
    const clearBoundary = resolveClearSessionBoundary({
      clearedAt: typeof clearedAt === 'string' ? clearedAt : undefined,
      isRemoteInvoke: remoteInvoke,
    });
    const projection = inputCoordinator.clearSession(sid, clearBoundary);
    resetAutomaticRecoveryForExplicitStop(sid);
    // 丢弃缓存的待注入交接 / fork 来源标记:它们是按 clear 之前的历史算出来的,
    // DB 侧的 cleared_at 抑制拦不住已经落进 registry 内存的那一份(首发被拒后
    // 缓存仍在),下次 send 会把旧血缘灌进用户刚显式清空的上下文。
    //
    // 用 invalidate(留 null 墓碑)而不是 clear(删条目):删条目会让后续 send 回落到
    // DB 重建,把旧交接捞回来再缓存住。墓碑同步生效,窗口内的 send 立刻拿到 null;
    // clear 纪元则要等下面 cleared_at 落库之后才推进。
    agentHandoffPending.invalidate(sid);
    getAgentIslandService()?.notifyQueueEmptied(sid);
    // 清上下文后,active 目标失去其依据(objective 引用的内容已被抹掉)→ 一并清除目标。
    goalClearObserver?.(sid);
    // cleared_at 在 handler 内**同步**落库,本地与远程同一口径。
    //
    // 过去本地路径只靠 renderer 事后 fire-and-forget 写这一列,于是 handler 返回到那次
    // 写入落库之间有个窗口:此刻启动的引擎切换 / 消息删除会读到**尚未标记 clear**的
    // DB 历史,却又拿到 clear 之后的纪元——纪元校验因此形同虚设,基于已清空历史算出的
    // 交接会盖掉刚立的墓碑。在这里同步写掉,那个窗口就不存在了;renderer 之后若再写一次
    // 也是同值幂等。
    const clearBoundaryMs =
      typeof clearBoundary === 'number'
        ? clearBoundary
        : new Date(clearBoundary).getTime();
    try {
      await clearSessionContextInDb(sid, clearBoundaryMs);
    } catch (err) {
      // 落库失败不阻断 /clear:内存墓碑已经立了,这一次以及后续 send 都拿不到旧交接。
      // 残余风险是 DB 里没有 cleared_at,进程重启后 findPendingAgentHandoff 可能把
      // clear 之前的交接重建出来——renderer 侧随后还会写一次同值(sdkSessionId + clearedAt),
      // 那是这里的第二次机会。用 error 级别,便于事后从日志确认是否走到过这条路。
      log.error('clear session context persist failed', {
        sessionId: sid,
        remoteInvoke,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    // 落库尝试结束后封边界:重立墓碑(清掉这段 await 里用 clear 前纪元挤进来的那份)
    // + 推进纪元(挡住后面才写回的那批)。顺序不可颠倒,理由见 sealClearBoundary 注释。
    agentHandoffPending.sealClearBoundary(sid);
    return projection;
  });

  ipcMain.handle(MAKER_INVOKE.ABORT_SESSION, async (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    markWorkerManualInterruptIfKnown(sessionId, 'abort_session');
    resetAutomaticRecoveryForExplicitStop(sessionId);
    // 调用本身先同步撤销 Goal 续跑资格；paused 落库与 vendor abort 并行。
    const goalPause = pauseGoalBeforeExplicitStop(sessionId);
    const sess = getStableSessionForTurnBoundary(sessionId);
    if (!sess) {
      await goalPause;
      return;
    }
    handleAgentIslandSessionStopped(sess);
    const directAbortBoundary = beginDirectAbortReconciliation(sessionId, sess);
    // Attach the rejection handler immediately: Goal storage can fail while a slow
    // vendor abort is still settling, and that failure must not become unhandled.
    const goalPauseResult = goalPause.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let abortFailed = false;
    let abortError: unknown;
    try {
      await sess.abort();
    } catch (error) {
      abortFailed = true;
      abortError = error;
    } finally {
      // The stable lookup may still be inside an owner-boundary transition;
      // reconciliation owns its own safe live-state lookup and must run even
      // when the abort promise rejects or the Session reports a late idle.
      try {
        reconcileDirectAbortBoundary(sessionId, directAbortBoundary, 'direct-abort');
      } finally {
        cleanupPendingInteractionsForSession(sessionId, 'session_aborted');
      }
    }
    const settledGoalPause = await goalPauseResult;
    if (abortFailed) {
      if (!settledGoalPause.ok) {
        log.error('goal pause persistence also failed after session abort failure', {
          sessionId,
          error:
            settledGoalPause.error instanceof Error
              ? settledGoalPause.error.message
              : String(settledGoalPause.error),
        });
      }
      throw abortError;
    }
    if (!settledGoalPause.ok) throw settledGoalPause.error;
  });

  ipcMain.handle(MAKER_INVOKE.CLOSE_SESSION, async (_e, sessionId: unknown, opts?: unknown) => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    // F6 fallback 临时文件 + worktree 清理走 Maker.lifecycleHooks.onClose
    // (在 maker-host/index.ts 注入), Maker 在 status==='closed' 时自动调,
    // 同时覆盖"主动 closeSession"和"内部异常关闭"两条路径。
    // opts.preserveWorkspace=true(/clear、鉴权重连等软重启)时抑制这些重副作用,
    // 业务体与选项解析见 closeSessionRequest.ts。
    await withSendToSessionLock(sessionId, () =>
      handleCloseSessionRequest(
        {
          closeSession: (sid) => maker.closeSession(sid),
          withRehydrateCloseSuppressed,
          cleanupPendingInteractions: (sid) =>
            cleanupPendingInteractionsForSession(sid, 'session_closed'),
        },
        sessionId,
        opts,
      ),
    );
  });

  ipcMain.handle(MAKER_INVOKE.LIST_ACTIVE, () => {
    return maker.listActiveSessions().map((s) => ({
      sessionId: s.id,
      agentKind: s.agentKind,
      workDir: s.workDir,
      capabilities: s.capabilities,
      isTurnRunning: s.isTurnRunning(),
    }));
  });

  ipcMain.handle(MAKER_INVOKE.RESOLVE_INTERACTION, (event, requestId: unknown, decision: unknown) => {
    if (typeof requestId !== 'string') throwIpcError('INVALID_PARAMS', 'requestId required');
    if (
      isPluginSetupInteractionDecision(decision) &&
      !parseGhostSetupInteractionCommand(decision)
    ) {
      throwIpcError('INVALID_PARAMS', 'invalid plugin setup decision');
    }
    // permission / ask / plan and setup cancellation remain remotely
    // resolvable. Host-owned setup side effects and Desktop-only confirmations
    // may only originate from the trusted local Desktop.
    assertResolveInteractionOrigin(
      decision,
      isPendingDesktopOnlyConfirmation(requestId),
    );
    let pluginSetupResponseTarget: GhostSetupInteractionResponseTarget | undefined;
    if (isPluginSetupInteractionDecision(decision) && !isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event);
      if (decision.action === 'run_action') {
        // Electron's real sender identity stays outside the untrusted command
        // payload and is carried only through the Host-owned action path.
        pluginSetupResponseTarget = event.sender;
      }
    }
    if (!resolvePendingInteraction(requestId, decision as InteractionDecision)) {
      if (isPermissionInteractionDecision(decision)) {
        handleAgentIslandInteractionDismissedByRequestId(requestId);
      }
      // agent interaction 没命中 → 可能是 issue 确认卡(kind='issue_confirm',
      // pending 在 issueConfirmBridge 自己的 map 里)或批量改名确认卡。
      // 三边都 miss 才告警。
      if (issueConfirmBridge.resolve(requestId, decision)) return;
      if (renameSessionsConfirmBridge.resolve(requestId, decision)) return;
      if (ghostGrantConfirmBridge.resolve(requestId, decision)) return;
      if (ghostSetupInteractionBridge.resolve(requestId, decision, pluginSetupResponseTarget)) {
        return;
      }
      log.warn('resolve-interaction: no pending resolver (likely already dismissed/timed out)', { requestId });
    }
  });

  ipcMain.handle(MAKER_INVOKE.PLUGIN_SETUP_SUBMIT_INLINE, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = parseGhostSetupInlineSubmitRequest(raw);
    if (!request) throwIpcError('INVALID_PARAMS', 'invalid plugin setup submission');
    const { requestId, ...submit } = request;
    if (!ghostSetupInteractionBridge.submitInline(requestId, submit)) {
      throwIpcError('INVALID_PARAMS', 'plugin setup interaction is not pending');
    }
  });

  // 快照:打开/重连/刷新会话时,renderer 拉当前挂起交互重建面板(本机 + device-link 远程共用)。
  ipcMain.handle(MAKER_INVOKE.GET_PENDING_INTERACTIONS, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return [];
    const pending = getPendingInteractionsForSession(sessionId);
    return projectPendingInteractionsForRemote(pending, isDeviceLinkInvoke());
  });

  // ── 运行时切换 (Stage 2 B) ───────────────────────────────────────────────
  // session 不存在(被 close / 还没 send 创建出来)就 no-op 不报错, 让 renderer
  // 可以乐观调用 (UI 更新先行, IPC 失败也不会回滚 UI, 老 agentManager 同语义)。

  ipcMain.handle(MAKER_INVOKE.SET_MODEL, async (
    _e,
    sessionId: unknown,
    model: unknown,
    providerId?: unknown,
    expectedAgentSwitchRevision?: unknown,
    selection?: unknown,
  ) => {
    if (typeof sessionId !== 'string' || typeof model !== 'string') {
      throwIpcError('INVALID_PARAMS', 'sessionId + model required');
    }
    if (
      providerId !== undefined &&
      providerId !== null &&
      typeof providerId !== 'string'
    ) {
      throwIpcError('INVALID_PARAMS', 'providerId must be string, null, or undefined');
    }
    if (
      expectedAgentSwitchRevision !== undefined &&
      (typeof expectedAgentSwitchRevision !== 'number' ||
        !Number.isSafeInteger(expectedAgentSwitchRevision) ||
        expectedAgentSwitchRevision < 0)
    ) {
      throwIpcError('INVALID_PARAMS', 'expectedAgentSwitchRevision must be a non-negative integer');
    }
    if (
      selection !== undefined &&
      (
        selection === null ||
        typeof selection !== 'object' ||
        Array.isArray(selection) ||
        typeof (selection as { effort?: unknown }).effort !== 'string' ||
        typeof (selection as { fastMode?: unknown }).fastMode !== 'boolean'
      )
    ) {
      throwIpcError('INVALID_PARAMS', 'selection must contain effort + fastMode');
    }
    const atomicSelection = selection as
      | { effort: string; fastMode: boolean }
      | undefined;
    // 与 send 事务共用 session 锁:发送时刻执行的跨引擎切换必须先落定,
    // 后到的 SET_MODEL 才能写 route。否则切换 DB await 恢复后会用旧 provider
    // 覆盖用户刚选的新 route，形成 DB 与进程内路由分叉。
    return withSendToSessionLock(sessionId, async () => {
      // 同引擎重选是 switch ack 后的第二段写入。另一控制端若在两段之间更新（含
      // set→clear ABA），修订号已变化：旧 SET_MODEL 必须在任何 route/DB 副作用前让位。
      if (
        typeof expectedAgentSwitchRevision === 'number' &&
        agentSwitchPending.revision?.(sessionId) !== expectedAgentSwitchRevision
      ) {
        return { deferred: false, superseded: true };
      }
      // 停用轴准入(PR #744 review;第十二轮移入锁内):切换模型是一次新的路由选择,
      // 不得切到用户停用的模型 / 来源(本机选择器已过滤,但本 channel 在 device-link
      // allowlist 内,老控制端可直接点名)。裁决必须在拿到会话锁**之后**执行 ——
      // 排队等待期间目标可能刚被停用,而同凭证族的变更即时生效、不经 deferred 收口
      // 的重裁决,锁前裁决结果可能已过期。会话当前正用着的停用模型不受影响,这里只
      // 拦「切过去」;隐式来源的原生默认落点被停用而有启用替代拷贝时,以显式来源
      // 落地(与 bootstrapSession 同语义)。agentKind 读不到(会话行缺失等)时不拦。
      // DB 存的是 'cc' | 'codex'(messages.agent_kind 口径),目录侧是 AgentKind。
      let effectiveProviderId = providerId;
      {
        const dbAgentKind = getSessionDbAgentKind(sessionId);
        if (dbAgentKind) {
          const reroute = await assertModelRouteUsable(
            dbToMakerAgentKind(dbAgentKind),
            model,
            typeof providerId === 'string' ? providerId : null,
          );
          if (reroute && typeof providerId !== 'string') effectiveProviderId = reroute;
        }
      }
      try {
        const result = await applySetModelThenCancelAgentSwitchIntent(
          agentSwitchPending,
          sessionId,
          () => applyRuntimeSetModelChange({
            maker,
            sessionId,
            model,
            providerId: effectiveProviderId,
            isSessionInTurn,
            registerPendingCredentialSwitch: registerPendingCredentialSwitchForSession,
            clearPendingCredentialSwitch: clearPendingCredentialSwitchForSession,
            wakeSessionInputQueue: wakeSessionInputAfterCredentialSwitch,
            getPendingCredentialSwitch: getPendingCredentialSwitchTarget,
            // 解析隐式来源的凭证家族,精确判定是否跨远端压缩身份边界(见
            // shouldCloseSessionForCredentialSwitch.codexAuthInjection)。
            codexAuthInjection: getCodexProxyAuthInjectionState(),
            logger: log,
          }),
          (id) => broadcastSessionPatched(id, {
            agentSwitchIntent: null,
            agentSwitchIntentCanceled: true,
          }),
        );
        // deferred = 会话自己在跑,选择已登记、turn 结束自动生效。renderer 据此提示
        // "任务结束后生效"而不是当成已即时切换。
        const response = { deferred: result.status === 'deferred', superseded: false };
        if (atomicSelection) {
          // model/provider/effort/fast 是一次选择快照，必须在同一把 session 锁内收敛。
          // applyRuntimeSetModelChange 可能 close + wake；若 effort/fast 留给 renderer
          // 后续独立调用，queue drain 会用新 model + 旧偏好重建，跨控制端时还会发生
          // 旧请求尾写覆盖新选择。
          setSessionEffort(sessionId, atomicSelection.effort);
          setSessionFastMode(sessionId, atomicSelection.fastMode);
          const sess = maker.getSession(sessionId);
          if (
            sess &&
            result.status !== 'deferred' &&
            !pendingCredentialSwitchHolder?.has(sessionId)
          ) {
            await sess.setEffort(
              atomicSelection.effort as
                | 'minimal'
                | 'low'
                | 'medium'
                | 'high'
                | 'xhigh'
                | 'max'
                | 'ultra',
            );
            if (sess.agentKind === 'codex') {
              await sess.setFastMode(atomicSelection.fastMode);
            }
          }
        }
        if (isDeviceLinkInvoke() || atomicSelection) {
          // device-link 的通用持久化原本发生在 handler 返回、session 锁释放之后；
          // 本地 renderer 的 sessionService.update 也有同一窗口。凡携带 selection 的
          // 新调用都由 host 在解锁前一次落定全部字段。
          const patch: Record<string, unknown> = { model };
          if (effectiveProviderId !== undefined) {
            patch.providerId = normalizeSessionProviderId(
              typeof effectiveProviderId === 'string' ? effectiveProviderId : null,
            );
          }
          if (atomicSelection) {
            patch.effort = atomicSelection.effort;
            patch.fastMode = atomicSelection.fastMode;
          }
          await persistSessionFields(sessionId, patch);
          if (isDeviceLinkInvoke()) {
            // dispatch 继续兼容最小/旧 handler 的锁外回流；标记本结果避免重复写。
            markRemoteSettingPersistedInsideHandler(response);
          }
        }
        return response;
      } catch (err) {
        if (err instanceof CredentialModeSwitchBusyError) {
          // 兜底(正常路径 busy 已转 deferred):切模型撞上凭证切换忙,独立 code,
          // renderer toast 走 ipcError.CREDENTIAL_SWITCH_BUSY 专属文案。
          throwIpcError('CREDENTIAL_SWITCH_BUSY', err.message);
        }
        throw err;
      }
    });
  });

  ipcMain.handle(MAKER_INVOKE.SET_EFFORT, async (_e, sessionId: unknown, effort: unknown) => {
    if (typeof sessionId !== 'string' || typeof effort !== 'string') {
      throwIpcError('INVALID_PARAMS', 'sessionId + effort required');
    }
    // 记下会话 effort:responses-bridge 模型(chatgpt/ / xai/)的 effort 无法经请求体流到 bridge,
    // 由 compat-proxy 路由决策从这里读出、闭包进订阅直连 handler 的 prefs(不影响 session 是否在跑)。
    setSessionEffort(sessionId, effort);
    const sess = maker.getSession(sessionId);
    if (!sess) {
      log.debug('set-effort: session not found, no-op', { sessionId });
      return;
    }
    // 有 pending 凭证切换 = 本会话的 model/effort 变更已整体延迟到 turn 结束重建:
    // 跳过对仍在跑的旧 turn 的 runtime 推送(与 renderer 本地分支的 deferred 守卫同因,
    // 这里是唯一 choke point,同时覆盖 device-link 远程入口;review P2 2026-07-04)。
    // 持久化不受影响:本地由 renderer sessionService.update 落盘,远程由 device-link
    // dispatch 的 persistRemoteSetting 按请求值落被控端 DB,重建时生效。
    if (pendingCredentialSwitchHolder?.has(sessionId)) {
      log.debug('set-effort: skipped live push (pending credential switch)', { sessionId });
      return;
    }
    await sess.setEffort(effort as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra');
  });

  ipcMain.handle(MAKER_INVOKE.SET_PERMISSION_MODE, async (_e, sessionId: unknown, mode: unknown) => {
    if (typeof sessionId !== 'string' || typeof mode !== 'string') {
      throwIpcError('INVALID_PARAMS', 'sessionId + mode required');
    }
    const sess = maker.getSession(sessionId);
    if (!sess) {
      log.debug('set-permission-mode: session not found, no-op', { sessionId });
      return;
    }
    await sess.setPermissionMode(mode as 'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions');
  });

  ipcMain.handle(MAKER_INVOKE.SET_PLAN_MODE, async (_e, sessionId: unknown, enabled: unknown) => {
    if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'sessionId + enabled required');
    }
    const sess = maker.getSession(sessionId);
    if (!sess) {
      log.debug('set-plan-mode: session not found, no-op', { sessionId });
      return;
    }
    await sess.setPlanMode(enabled);
  });

  ipcMain.handle(MAKER_INVOKE.EXPORT_SESSION_HTML, async (e, sessionId: unknown) => {
    // 会弹原生保存对话框并把会话内容落盘:必须来自受信顶层页面,不能让辅助窗口 /
    // WebView / 子 frame 经隐藏入口导出敏感会话(codex review)。导出非 device-link
    // 通道(主机端原生对话框),故无条件校验。
    assertTrustedAppRendererEvent(e as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    const sess = maker.getSession(sessionId);
    if (!sess) {
      log.debug('export-session-html: session not found, no-op', { sessionId });
      return null;
    }
    if (!sess.capabilities.sessionHtmlExport?.supported) {
      // agent 不支持导出(CC/Codex):调用方应先按 capabilities 隐藏入口,这里兜底 no-op。
      log.debug('export-session-html: agent does not support export, no-op', {
        sessionId,
        agentKind: sess.agentKind,
      });
      return null;
    }
    // 主进程弹原生保存对话框选落盘位置(renderer 只发起,不碰文件系统)。
    const parent = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const defaultPath = path.join(app.getPath('documents'), 'cindy-session.html');
    const picked = await dialog.showSaveDialog(parent!, {
      title: 'Export session to HTML',
      defaultPath,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    const written = await sess.exportSessionHtml(picked.filePath);
    // 导出完成后在文件管理器中高亮该文件(与常见「导出并显示」体验一致)。
    shell.showItemInFolder(written);
    return written;
  });

  ipcMain.handle(MAKER_INVOKE.COMPACT_SESSION, async (event, sessionId: unknown, instructions: unknown) => {
    // 会启动 Agent turn、产生模型费用:非 device-link 的本机调用必须来自受信顶层页面,
    // 不能让辅助窗口 / WebView / 子 frame 经隐藏入口触发(codex review)。device-link
    // 走独立鉴权通道,按既有 dual 模式放行。
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    if (instructions !== undefined && typeof instructions !== 'string') {
      throwIpcError('INVALID_PARAMS', 'instructions must be a string when provided');
    }
    const sess = maker.getSession(sessionId);
    if (!sess) {
      log.debug('compact-session: session not found, no-op', { sessionId });
      return null;
    }
    if (!sess.capabilities.manualCompact?.supported) {
      // 调用方应先按 capabilities 隐藏入口,这里兜底 no-op。
      log.debug('compact-session: agent does not support manual compact, no-op', {
        sessionId,
        agentKind: sess.agentKind,
      });
      return null;
    }
    return sess.compactSession(instructions);
  });

  /**
   * 会话树是历史浏览入口，不能要求用户先发一条消息把旧 Pi 会话唤醒。
   * 这里按持久化元数据恢复同一原生 session；Maker.createSession 自带 per-id singleflight。
   */
  async function getOrResumeSessionTreeSession(sessionId: string) {
    const live = maker.getSession(sessionId);
    if (live) return live;
    const meta = await maker.getSessionMeta(sessionId).catch(() => null);
    if (!meta || meta.agentKind !== 'pi') return null;
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({
        providerId: sessions.providerId,
        effort: sessions.effort,
        fastMode: sessions.fastMode,
        permissionMode: sessions.permissionMode,
        remoteHostId: sessions.remoteHostId,
        orcaRole: sessions.orcaRole,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return null;
    const createOpts = buildCreateOptsWithStderr({
      id: sessionId,
      agentKind: 'pi',
      workingDir: meta.workDir,
      model: meta.model,
      // providerId=null 是显式的 Cindy 默认路由；undefined 才允许 Pi 按同名模型
      // 反查原生 BYOM。会话树懒恢复必须原样保留 DB 的三态契约。
      providerId: row.providerId,
      resumeSessionId: meta.sdkSessionId,
      effort: row.effort as CreateOpts['effort'],
      fastMode: !!row.fastMode,
      permissionMode: permissionModeOrAsk(row.permissionMode),
      title: meta.title,
      remoteHostId: row.remoteHostId ?? undefined,
      orcaRole: row.orcaRole as CreateOpts['orcaRole'],
    });
    const workDirReady = await checkWorkDirExists(
      sessionId,
      createOpts.workingDir,
      createOpts.agentKind,
      createOpts.remoteHostId,
    );
    if (!workDirReady) return null;
    await synthesizeOrcaVendorOptionsFromDb(sessionId, createOpts);
    const extraDirs = await readSessionExtraDirsFromDb(sessionId).catch(() => []);
    if (extraDirs.length > 0) createOpts.extraDirs = extraDirs;
    await ensureRemoteReadyForSessionStart({ createOpts });
    const { session: resumed } = await bootstrapSession(createOpts);
    await markOrcaRoleIfNeeded(resumed.id, createOpts.orcaRole);
    log.info('session-tree: lazily resumed Pi session', {
      sessionId,
      sdkSessionId: meta.sdkSessionId ?? null,
    });
    return resumed;
  }

  ipcMain.handle(MAKER_INVOKE.GET_SESSION_TREE, async (event, sessionId: unknown) => {
    // getOrResumeSessionTreeSession 会 lazy resume(spawn Agent)→ 有副作用。非
    // device-link 本机调用须受信顶层页面(codex review);device-link 独立鉴权,放行。
    if (!isDeviceLinkInvoke()) {
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    const sess = await getOrResumeSessionTreeSession(sessionId);
    if (!sess || !sess.capabilities.sessionTree?.supported) return null;
    return sess.getSessionTree();
  });

  ipcMain.handle(
    MAKER_INVOKE.NAVIGATE_SESSION_TREE,
    async (event, sessionId: unknown, entryId: unknown, options: unknown) => {
      // 改写原生分支 + SQLite 投影、可触发 summarize Agent turn:非 device-link 本机
      // 调用须受信顶层页面(codex review);device-link 独立鉴权,按既有 dual 模式放行。
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
      }
      if (typeof sessionId !== 'string' || !sessionId || typeof entryId !== 'string' || !entryId) {
        throwIpcError('INVALID_PARAMS', 'sessionId + entryId required');
      }
      const rawOptions = options == null ? {} : options;
      if (typeof rawOptions !== 'object' || Array.isArray(rawOptions)) {
        throwIpcError('INVALID_PARAMS', 'options must be an object');
      }
      const parsed = rawOptions as Record<string, unknown>;
      if (parsed.summarize !== undefined && typeof parsed.summarize !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'summarize must be boolean');
      }
      if (parsed.customInstructions !== undefined && typeof parsed.customInstructions !== 'string') {
        throwIpcError('INVALID_PARAMS', 'customInstructions must be string');
      }
      const sess = await getOrResumeSessionTreeSession(sessionId);
      if (!sess || !sess.capabilities.sessionTree?.supported) return null;
      // 整个「原生分支导航 → 捕获 result.messages → session.treeRehydrate 重建 SQLite」窗口
      // 必须与 maker:send 走同一把 per-session 锁(acquireSendToSessionLock)。否则另一窗口 /
      // device-link 在 navigate 捕获 result.messages 之后、rehydrate 之前发一个 turn:Pi 把它
      // 收进活动 JSONL,而 rehydrate 用导航前捕获的旧 result.messages 重建库,这条新 turn 就
      // 在 JSONL 里有、SQLite 里被旧快照覆盖/隐藏(hiddenClientIds 只修复 Renderer 删除广播,
      // 修不了 JSONL 与 DB 的这处分叉,codex review P1)。summarize turn 是 Pi 内部 RPC,不经
      // maker:send IPC,故不与本锁重入。
      const { result, hiddenClientIds, now } = await withSendToSessionLock(sessionId, async () => {
        const result = await sess.navigateSessionTree(entryId, {
          summarize: parsed.summarize === true,
          ...(typeof parsed.customInstructions === 'string'
            ? { customInstructions: parsed.customInstructions }
            : {}),
        });
        const now = Date.now();
        // hiddenClientIds 由重投影事务原子返回:它是隐藏动作发生那一刻的完整可见集。
        const { hiddenClientIds } = await getDbClient().tx('session.treeRehydrate', {
          sessionId,
          now,
          contextTokens: result.contextTokens,
          contextWindow: result.contextWindow,
          messages: result.messages.map((message) => ({
            id: createId(),
            clientId: message.clientId,
            role: message.role,
            content: JSON.stringify(message.content),
            toolUseId: message.toolUseId ?? null,
            agentMeta: message.agentMeta ? JSON.stringify(message.agentMeta) : null,
            agentKind: 'pi',
            createdAt: message.createdAt,
          })),
        });
        return { result, hiddenClientIds, now };
      });
      resetTurnPersistState(sessionId);

      // 多窗口与 device-link 控制端先清旧投影，再按 DB 真相补当前活动路径。
      if (hiddenClientIds.length > 0) {
        broadcastMessageDeleted({
          sessionId,
          clientId: hiddenClientIds[0],
          clientIds: hiddenClientIds,
        });
      }
      const visibleRows = await getDbClient().drizzle
        .select()
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt)))
        .orderBy(messages.createdAt);
      for (const row of visibleRows) broadcastMessageRow(sessionId, messageToCamel(row));
      broadcastSessionPatched(sessionId, {
        clearedAt: null,
        contextTokens: result.contextTokens,
        contextWindow: result.contextWindow,
        updatedAt: new Date(now).toISOString(),
        _count: { messages: visibleRows.length },
      });
      return {
        tree: result.tree,
        draftText: result.draftText,
        cancelled: result.cancelled === true,
      };
    },
  );

  ipcMain.handle(MAKER_INVOKE.SET_FAST_MODE, async (_e, sessionId: unknown, enabled: unknown) => {
    if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'sessionId + enabled required');
    }
    // 记下会话 Fast 态:responses-bridge 模型(chatgpt/ 前缀)的 fast 无法经请求体流到 bridge,
    // 由 compat-proxy 路由决策从这里读出、闭包进订阅直连 handler 的 prefs(与 SET_EFFORT 的 effort 同机制)。
    setSessionFastMode(sessionId, enabled);
    const sess = maker.getSession(sessionId);
    if (!sess) {
      log.debug('set-fast-mode: session not found, no-op', { sessionId });
      return;
    }
    if (sess.agentKind === 'pi') {
      // Pi 的 ChatGPT 请求不从 pi 请求体携带 Fast，而是由上面的 session store
      // 在 compat-proxy 决策点闭包进 responses bridge prefs。到这里已经即时生效，
      // 无需向 pi RPC 再发一份不存在的 set_fast_mode 控制命令。
      log.debug('set-fast-mode: pi responses bridge state updated', { sessionId, enabled });
      return;
    }
    if (sess.agentKind !== 'codex') {
      log.debug('set-fast-mode: agent does not implement fast mode, no-op', {
        sessionId,
        agentKind: sess.agentKind,
      });
      return;
    }
    // 同 set-effort:pending 凭证切换期间不触碰仍在跑的旧 turn,持久化走各自 DB 路径。
    if (pendingCredentialSwitchHolder?.has(sessionId)) {
      log.debug('set-fast-mode: skipped live push (pending credential switch)', { sessionId });
      return;
    }
    await sess.setFastMode(enabled);
  });

  // renderer → main 单向镜像「模型显示/隐藏」override(整张快照,fire-and-forget,不落盘)。
  // main 缓存供 IM /model 与 device-link provider:list 复用同一套可见性过滤。值实变时
  // 复用 PROVIDER_CHANGED 目录失效事件，让已连接控制端驱逐缓存并重拉 override 快照。
  // 容错存储(非对象 ⇒ 清空),无错误路径,故不需要 throwIpcError。
  ipcMain.handle(MAKER_INVOKE.MODEL_VISIBILITY_SYNC, async (_e, map: unknown) => {
    syncModelVisibilityMirror(map, () => {
      broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {});
    });
  });

  // 附加只读引用目录的运行时 closure 推送。DB 持久化由 renderer 同步调
  // local-db:sessions:update 完成 (跟 SET_MODEL / sessionService.update 同模式)。
  // session 不在 / capability 不支持都 no-op, 不抛错 — 跟 setModel 容错语义一致。
  ipcMain.handle(MAKER_INVOKE.SET_EXTRA_DIRS, async (_e, sessionId: unknown, dirs: unknown) => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    if (!Array.isArray(dirs)) throwIpcError('INVALID_PARAMS', 'dirs must be string[]');
    const sess = maker.getSession(sessionId);
    if (!sess) {
      log.debug('set-extra-dirs: session not found, no-op', { sessionId });
      return;
    }
    if (!sess.capabilities.extraDirs.supported) {
      log.debug('set-extra-dirs: agent capability=false, no-op', {
        sessionId,
        agentKind: sess.agentKind,
      });
      return;
    }
    // workingDir 从 SessionMeta 读 (sess.workDir 是 maker-core Session 的 getter)
    const workingDir = sess.workDir || undefined;
    const validation = await validateExtraDirs(dirs as string[], workingDir);
    log.info('set-extra-dirs', {
      sessionId,
      requested: (dirs as string[]).length,
      kept: validation.valid.length,
      rejected: validation.rejected.length,
    });
    await sess.setExtraDirs(validation.valid);
    // 返回实际应用的子集(已剔除校验未通过的目录),供远程 set-* 回流持久化用:
    // 远程控制端选的路径在被控端常被拒,持久化必须以这个生效值为准,不能用原始请求值。
    return validation.valid;
  });

  // ── Memory 控制 ────────────────────────────────────────────────────────
  // 透传到 maker.{getAgentMemoryStatus, setAgentMemory, resetAgentMemory},
  // 真实落地在 BaseAgent 子类 (Claude / Codex)。renderer 拿到 status 渲染 toggle,
  // setMemory 后按 result.effective ('immediate' | 'next-session') 决定是否提示
  // "新会话生效"; reset 前必走 confirm dialog (UI 层负责)。
  ipcMain.handle(MAKER_INVOKE.MEMORY_GET, async (_e, agentKind: unknown) => {
    if (agentKind !== 'claude-code' && agentKind !== 'codex' && agentKind !== 'pi') {
      throwIpcError('INVALID_PARAMS', `agentKind required (claude-code | codex | pi), got ${String(agentKind)}`);
    }
    return maker.getAgentMemoryStatus(agentKind);
  });

  ipcMain.handle(MAKER_INVOKE.MEMORY_SET, async (_e, agentKind: unknown, enabled: unknown) => {
    if (agentKind !== 'claude-code' && agentKind !== 'codex' && agentKind !== 'pi') {
      throwIpcError('INVALID_PARAMS', `agentKind required (claude-code | codex | pi), got ${String(agentKind)}`);
    }
    if (typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'enabled required (boolean)');
    }
    log.info('memory:set', { agentKind, enabled });
    const result = await maker.setAgentMemory(agentKind, enabled);
    // 持久化用户意图: 重启后 runtime-configs.ts 会从 store 读这个值注入 agent。
    // 写盘失败不阻塞 — 当前 session 已经 setMemory 成功, 只是下次重启会回默认。
    let settingsState = readMemorySettingsState();
    try {
      const settingKey = agentKind === 'claude-code' ? 'claudeCode' : agentKind;
      settingsState = writeMemorySetting(settingKey, enabled);
    } catch (err) {
      log.warn('memory:set persistence failed (in-session change still applied)', {
        agentKind,
        enabled,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return {
      ...result,
      isCustomized: settingsState.isCustomized,
      customizedKeys: settingsState.customizedKeys,
      defaults: settingsState.defaults,
    };
  });

  ipcMain.handle(MAKER_INVOKE.MEMORY_RESET, async (_e, agentKind: unknown) => {
    if (agentKind !== 'claude-code' && agentKind !== 'codex' && agentKind !== 'pi') {
      throwIpcError('INVALID_PARAMS', `agentKind required (claude-code | codex | pi), got ${String(agentKind)}`);
    }
    log.info('memory:reset', { agentKind });
    return maker.resetAgentMemory(agentKind);
  });

  ipcMain.handle(MAKER_INVOKE.MAKER_MEMORY_SET_ENABLED, async (_e, enabled: unknown) => {
    if (typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'enabled required (boolean)');
    }
    const makerMemory = maker.makerMemory;
    if (!makerMemory) {
      throwIpcError('MAKER_MEMORY_NOT_READY', 'maker memory not initialized');
    }
    log.info('maker-memory:set-enabled', { enabled });
    // persist / applyRuntime 拆分:settings 落盘 + manager 状态翻转立即做(新会话
    // 立刻按新值注入);native setMemory 的 live-host RPC 热推放 applyRuntime ——
    // Codex busy 的延迟路径把它挪到所有会话空闲后执行,不 mid-turn 热更正在跑的
    // 任务(review P1 2026-07-23)。
    const wasEnabled = makerMemory.isEnabled();
    let persistedSettings: MemorySettings | null = null;
    return applyMemoryChangeWithCodexRestart({
      persist: async () => {
        // Persist before changing the manager. A failed maker:false write must reject the toggle
        // instead of presenting an opt-out that silently disappears after restart.
        const settingsState = writeMemorySetting('maker', enabled, { preserveDefault: enabled });
        persistedSettings = settingsState.value;
        const result = enabled
          ? await makerMemory.enable({ skipAgentSync: true })
          : await makerMemory.disable();
        // Claude 的原生覆盖立即应用(纯内存,不碰 busy 的 Codex host)——
        // 延迟路径下新建 Claude 会话也要立刻符合最新设置(review P1 2026-07-23)。
        if (enabled) {
          await makerMemory.syncNativeAgentsOff(['claude-code']);
        } else if (!settingsState.value.maker) {
          await maker.setAgentMemory('claude-code', settingsState.value.claudeCode);
        }
        return {
          ...result,
          isCustomized: settingsState.isCustomized,
          customizedKeys: settingsState.customizedKeys,
          defaults: settingsState.defaults,
        };
      },
      applyRuntime: async () => {
        if (enabled) {
          await makerMemory.syncNativeAgentsOff(['codex']);
        } else if (persistedSettings && !persistedSettings.maker) {
          await maker.setAgentMemory('codex', persistedSettings.codex);
        }
        // 开关翻转 ⇒ 重建 codex bridge, 理由与约束见
        // shutdownAgentMcpEnvironmentsBestEffort 文档 (review R1 P2)。
        if (wasEnabled !== enabled) {
          await shutdownAgentMcpEnvironmentsBestEffort('maker-memory toggle');
        }
      },
    });
  });

  // MEMORY_GET_SETTINGS 故意不在这里注册 —— renderer/index.tsx 在 React mount
  // 之前 (远早于 splash 完成) 就会调一次, 所以挂在 bootstrap-electron 的早期
  // registerIpcHandlers() 里, 见那里的注释。
  ipcMain.handle(MAKER_INVOKE.MEMORY_RESET_SETTINGS, async () => {
    // 同 MAKER_MEMORY_SET_ENABLED 的 persist / applyRuntime 拆分。
    const wasMakerEnabled = maker.makerMemory?.isEnabled() ?? false;
    let resetSettings_: MemorySettings | null = null;
    return applyMemoryChangeWithCodexRestart({
      persist: async () => {
        const settings = resetMemorySettings();
        resetSettings_ = settings;
        if (maker.makerMemory) {
          if (settings.maker) {
            await maker.makerMemory.enable({ skipAgentSync: true });
          } else {
            await maker.makerMemory.disable();
          }
        }
        // Claude 立即应用,同 MAKER_MEMORY_SET_ENABLED 的拆分理由。
        if (settings.maker) {
          await maker.makerMemory?.syncNativeAgentsOff(['claude-code']);
        } else {
          await maker.setAgentMemory('claude-code', settings.claudeCode);
        }
        // Pi 的自动记忆以 Cindy Memory 为存储层，不参与“启用 Cindy 时关闭原生记忆”联动；
        // reset 仍要把存活 Pi runtime 的独立开关恢复成默认值。
        if (maker.listAvailableAgents().includes('pi')) {
          await maker.setAgentMemory('pi', settings.pi);
        }
        return memorySettingsWire();
      },
      applyRuntime: async () => {
        if (!resetSettings_) return;
        if (resetSettings_.maker) {
          await maker.makerMemory?.syncNativeAgentsOff(['codex']);
        } else {
          await maker.setAgentMemory('codex', resetSettings_.codex);
        }
        // maker 开关随 reset 翻转时同样要重建 codex bridge — 见
        // shutdownAgentMcpEnvironmentsBestEffort 文档 (review R1 P2)。
        if (wasMakerEnabled !== resetSettings_.maker) {
          await shutdownAgentMcpEnvironmentsBestEffort('memory settings reset');
        }
      },
    });
  });

  ipcMain.handle(MAKER_INVOKE.MAKER_MEMORY_RESET, async () => {
    if (!maker.makerMemory) {
      throwIpcError('MAKER_MEMORY_NOT_READY', 'maker memory not initialized');
    }
    log.info('maker-memory:reset');
    return maker.makerMemory.resetAll();
  });

  // 占位：MetaAgent 入口
  ipcMain.handle(MAKER_INVOKE.RUN, () => {
    throwIpcError('INTERNAL', `${MAKER_INVOKE.RUN} reserved for future MetaAgent feature`);
  });

  // ── Plugin system (Phase 1) ──────────────────────────────────────────────
  ipcMain.handle(MAKER_INVOKE.PLUGINS_LIST, async (_e, workingDir: unknown) => {
    const wd = typeof workingDir === 'string' ? workingDir : undefined;
    return getPluginRegistry().listPlugins(wd);
  });

  // Read one plugin's enable state by id. Unlike PLUGINS_LIST this does NOT skip
  // hidden (HOSTED_ELSEWHERE) plugins, so a dedicated Settings section (e.g.
  // 「电脑使用」for `browser`) can read its real project-override state.
  ipcMain.handle(MAKER_INVOKE.PLUGINS_GET_STATE, async (
    _e,
    id: unknown,
    workingDir: unknown,
    workspaceKind: unknown,
  ) => {
    if (typeof id !== 'string') {
      throwIpcError('INVALID_PARAMS', 'id (string) required');
    }
    const wd = typeof workingDir === 'string' ? workingDir : undefined;
    // collab 的 app 托管 dialogue cwd 只读取用户/全局级；显式真实目录仍读取项目覆盖。
    // 这里与 mutation 最终授权共用「dialogue kind + Main 可信路径」判据，device-link
    // 隧道到被控端后也由被控端自己的 dialogue root 解析，Renderer 无需知道或猜 userData。
    const policyWorkingDir =
      id === 'collab' && wd !== undefined
        ? resolveLocalCollabPolicyWorkingDir(
            wd,
            typeof workspaceKind === 'string' ? workspaceKind : null,
            (candidate) =>
              matchDialogueWorkspacePath(candidate, dialogueWorkspaceRootDir()) !== null,
          )
        : wd;
    const state = await getPluginRegistry().getEnableState(id, policyWorkingDir);
    const acceptedWorkspaceKind =
      id === 'collab' && (workspaceKind === 'project' || workspaceKind === 'dialogue')
        ? workspaceKind
        : undefined;
    // 远端控制端不能只靠 channel 存在判断 dialogue 协同：旧被控端也已有这个 channel，
    // 但它会忽略第三个参数，且最终授权不接受 dialogue。回显被 Main 接受的 kind 作为
    // 同一次只读查询的向后兼容握手；旧端缺字段，新端即可 fail-closed。
    return acceptedWorkspaceKind
      ? { ...state, collabWorkspaceKind: acceptedWorkspaceKind }
      : state;
  });

  ipcMain.handle(MAKER_INVOKE.PLUGINS_SET_ENABLED, async (_e, id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'id (string) + enabled (boolean) required');
    }
    const ok = await getPluginRegistry().setEnabled(id, enabled);
    if (!ok) {
      throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
    }
    // Ordinary plugins are user defaults: existing sessions keep their frozen
    // policy and only new sessions observe changes, so no shared environment
    // refresh is needed.
    if (!GLOBAL_PLUGIN_IDS.has(id)) {
      return { codexMcpRefreshed: true };
    }
    // Machine-wide tools keep their existing lifecycle. The preference is
    // already durable at this point, so refresh best-effort; a busy turn must
    // keep using the existing bridge and must not turn a successful save into
    // an IPC failure. Renderer surfaces the deferred state explicitly.
    return refreshCodexMcpEnvironment({
      restartCodex: restartCodexAfterAuthModeChange,
      shutdownCodexEnvironment,
      logger: log,
    });
  });

  ipcMain.handle(MAKER_INVOKE.PLUGINS_CLEAR_ENABLED, async (_e, id: unknown) => {
    if (typeof id !== 'string') {
      throwIpcError('INVALID_PARAMS', 'id (string) required');
    }
    const ok = await getPluginRegistry().clearEnabled(id);
    if (!ok) {
      throwIpcError('PERMISSION_DENIED', `Cannot modify essential plugin: ${id}`);
    }
    if (!GLOBAL_PLUGIN_IDS.has(id)) {
      return { codexMcpRefreshed: true };
    }
    return refreshCodexMcpEnvironment({
      restartCodex: restartCodexAfterAuthModeChange,
      shutdownCodexEnvironment,
      logger: log,
    });
  });

  registerProjectPluginPolicyHandlers(createElectronIpcHandlerRegistry(), {
    getPluginRegistry,
  });

  // ── Android automation (Settings →「电脑使用」) ──────────────────────────
  registerAndroidAutomationHandlers(createElectronIpcHandlerRegistry());

  // ── Browser automation (Settings →「电脑使用」) ───────────────────────────
  // Probe local browser detection. Drives the detection status + download
  // guidance UI; only inspects (never launches a browser).
  ipcMain.handle(MAKER_INVOKE.BROWSER_STATUS, async () => {
    try {
      return await getBrowserAvailability();
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  // Launch the headed automation browser + open a blank tab so the user logs in once.
  ipcMain.handle(MAKER_INVOKE.BROWSER_OPEN_FOR_LOGIN, async () => {
    try {
      await openBrowserForLogin();
      return { launched: true };
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  // ── Local desktop computer-use (Settings →「电脑使用」) ─────────────────
  // Probe the installed CuaDriver used by the phase-one Computer Use runtime.
  ipcMain.handle(MAKER_INVOKE.COMPUTER_STATUS, async (_event, options?: {
    includeDoctor?: boolean;
    forcePermissionProbe?: boolean;
    skipPermissionProbe?: boolean;
    freshPermissionProbe?: boolean;
    bypassPermissionProbeCache?: boolean;
    passivePermissionProbeOnly?: boolean;
  }) => {
    try {
      const status = await getComputerDriverStatus(options);
      if (
        options?.forcePermissionProbe === true
        || options?.freshPermissionProbe === true
      ) {
        refreshComputerPermissionGuideWindow(status);
      }
      return status;
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(MAKER_INVOKE.COMPUTER_INSTALL_DRIVER, async () => {
    try {
      return await installComputerDriver();
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(MAKER_INVOKE.COMPUTER_GRANT_PERMISSIONS, async (_event, payload?: unknown) => {
    assertTrustedAppRendererEvent(_event);
    const options = parseComputerPermissionGrantRequest(payload);
    if (!options) {
      throwIpcError('INVALID_PARAMS', 'Invalid Computer Use permission request');
    }
    const shouldShowGuide = shouldUseComputerPermissionGuide({
      platform: process.platform,
      showGuide: options.showGuide,
      appBundlePath: getComputerDriverAppBundlePath(),
    });
    try {
      // Permission snapshots are mutable TCC state and cannot be accepted from
      // Renderer. Re-establish the state in Main immediately before guide side
      // effects, bypassing both daemon and probe caches.
      const initialStatus = shouldShowGuide
        ? await getComputerDriverStatus({
            forcePermissionProbe: true,
            freshPermissionProbe: true,
            bypassPermissionProbeCache: true,
          })
        : undefined;
      if (shouldShowGuide) {
        if (!initialStatus) throw new Error('Computer Use permission guide status unavailable');
        if (options.openedPaneUrl) {
          seedOpenedPermissionPane(options.openedPaneUrl);
        }
        await openComputerPermissionPaneForStatus(initialStatus);
        // Phase one keeps CuaDriver as the real permission/runtime identity.
        // The new guide wraps its existing grant flow without introducing a
        // second Computer Use.app entry in macOS privacy settings.
        await pauseComputerDriverPermissionProbe();
        await showComputerPermissionGuideWindow(
          BrowserWindow.fromWebContents(_event.sender),
          initialStatus,
        );
      }
      return await grantComputerDriverPermissions(
        initialStatus,
      );
    } catch (err) {
      if (shouldShowGuide) closeComputerPermissionGuideWindow();
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  // 查询型:授权引导弹窗的 CuaDriver 图标。取不到时 renderer 降级用通用图标。
  ipcMain.handle(MAKER_INVOKE.COMPUTER_DRIVER_ICON, async () => {
    return { iconDataUrl: await getComputerDriverAppIcon() };
  });

  ipcMain.handle(MAKER_INVOKE.COMPUTER_PERMISSION_GUIDE_STATUS, async (_event) => {
    const status = getComputerPermissionGuideStatus(_event.sender);
    if (!status) {
      throwIpcError('PRECONDITION_FAILED', 'Computer Use permission guide is not active');
    }
    return status;
  });

  ipcMain.on(MAKER_SEND.COMPUTER_PERMISSION_APP_DRAG_START, (_event, payload?: {
    iconDataUrl?: unknown;
  }) => {
    startComputerPermissionAppDrag(_event.sender, payload?.iconDataUrl);
  });

  ipcMain.handle(MAKER_INVOKE.COMPUTER_PERMISSION_APP_DRAG_END, async (_event, payload?: {
    didCopy?: unknown;
  }) => {
    return finishComputerPermissionAppDrag(_event.sender, payload?.didCopy);
  });

  // 命令型:取消在途授权流程。幂等,无在途 grant 时 no-op。
  ipcMain.handle(MAKER_INVOKE.COMPUTER_CANCEL_PERMISSION_GRANT, async (_event) => {
    const cancelledFromGuide = isComputerPermissionGuideWebContents(_event.sender);
    if (!cancelledFromGuide) {
      assertTrustedAppRendererEvent(_event);
    }
    cancelComputerDriverPermissionGrant();
    closeComputerPermissionGuideWindow();
    if (cancelledFromGuide) {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(MAKER_PUSH.COMPUTER_PERMISSION_GUIDE_CANCELLED);
        }
      }
    }
    return { cancelled: true };
  });

  // 查询型:checkComputerDriverUpdate 内部已把所有失败兜成
  // updateAvailable=false,正常不会走到 catch;保留兜底以防实现回归。
  ipcMain.handle(MAKER_INVOKE.COMPUTER_CHECK_UPDATE, async () => {
    try {
      return await checkComputerDriverUpdate();
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  // 更新执行:in-flight 托管在 main,设置窗口关闭安装照常跑完;重开面板
  // 再调用会 join 同一个安装 Promise,不会重复安装。下载进度经广播推给
  // 所有窗口(join 的调用方天然共享同一份进度流)。
  ipcMain.handle(MAKER_INVOKE.COMPUTER_UPDATE_DRIVER, async (_event, opts?: { joinOnly?: boolean }) => {
    try {
      return await updateComputerDriver((progress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send('computer-driver-update-progress', progress);
          }
        }
      }, { joinOnly: opts?.joinOnly === true });
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  // ── Plugin hub (Phase 2) ──────────────────────────────────────────────────

  log.info('maker:* IPC handlers registered');
}

async function broadcastCodexImageAsToolResult(
  sessionId: string,
  event: AgentEvent,
): Promise<void> {
  const data = event.data as CodexImageEventData | null;
  if (data?.kind !== 'generation') return;

  try {
    const cached = await materializeCodexImage(sessionId, data);
    if (!cached) {
      log.warn('codex image event missing materializable image', {
        sessionId,
        blockId: data.blockId,
        hasPath: !!data.path,
        hasUrl: !!data.url,
      });
      return;
    }

    const toolUseId = data.blockId || `codex-image-${Date.now()}`;
    const toolInput = {
      ...(data.revisedPrompt ? { prompt: data.revisedPrompt } : {}),
      ...(data.status ? { status: data.status } : {}),
    };
    const fullText = JSON.stringify({
      ok: true,
      kind: 'generation',
      text: 'image generated',
      xdt_image_url: cached.url,
      filename: cached.filename,
      ...(data.revisedPrompt ? { revised_prompt: data.revisedPrompt } : {}),
      ...(data.status ? { status: data.status } : {}),
      ...(data.path ? { original_path: data.path } : {}),
    });

    broadcastSyntheticToolEvent(sessionId, {
      type: 'tool_use',
      source: 'codex',
      agentMeta: event.agentMeta,
      data: {
        toolUseId,
        toolName: 'imagegen',
        input: toolInput,
      },
    } satisfies AgentEvent);
    broadcastSyntheticToolEvent(sessionId, {
      type: 'tool_result_full',
      source: 'codex',
      agentMeta: event.agentMeta,
      data: {
        toolUseId,
        fullText,
        isError: false,
      },
    } satisfies AgentEvent);
    broadcastSyntheticToolEvent(sessionId, {
      type: 'tool_result',
      source: 'codex',
      agentMeta: event.agentMeta,
      data: {
        summary: 'image generated',
        toolUseIds: [toolUseId],
      },
    } satisfies AgentEvent);
  } catch (err) {
    log.warn('failed to materialize codex image event', {
      sessionId,
      blockId: data?.blockId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function broadcastSyntheticToolEvent(
  sessionId: string,
  event: AgentEvent & { type: 'tool_use' | 'tool_result' | 'tool_result_full' },
): void {
  const prepared = prepareSyntheticToolEventForBroadcast(
    sessionId,
    { type: event.type, data: event.data },
    event.agentMeta as AgentMeta | null | undefined ?? null,
  );
  broadcastToAllWindows(MAKER_PUSH.EVENT, {
    sessionId,
    event,
    persistId: prepared.persistId,
    resolvedContent: prepared.resolvedContent,
  });
}

async function materializeCodexImage(
  sessionId: string,
  data: CodexImageEventData,
): Promise<{ url: string; filename: string } | null> {
  // 规则 25:生成图入 cindy-media 总仓(零引用;合成 tool_result
  // 消息落库时由 createMessage 的挂账钩子补 session-attachment 引用)。逻辑
  // 本体在 cindy-media/generatedMedia.ts(规则 14 可测),这里只做 thin adapter。
  try {
    return await materializeGeneratedImage(data, {
      ingestFromPath: cindyChatAttachments.ingestChatImageFromPath,
      ingestBuffer: cindyChatAttachments.ingestChatImageBuffer,
    });
  } catch (err) {
    // 白名单外 mime / 读盘失败:丢图不炸事件流(与旧行为的失败面一致)。
    log.warn('materializeCodexImage: ingest failed, dropping image', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 用户在 session 跑到一半把工作目录删了 / 重命名了，之后继续 send 会让 SDK 在
 * spawn cwd 时炸出乱七八糟的 ENOENT，banner 上是裸错误栈很难看。这里负责本地
 * workdir probe；如果传入 live session，可以额外广播兼容 error event。SEND 调用方
 * 负责在 dispatch 前返回 host-send failure，让队列和气泡按未派发状态回滚。
 *
 * agentSource 为了让 reducer / 事件类型对齐，老 session 没法准确知道 source 时
 * 走 'claude-code' 兜底；banner 不在乎 source，只显示 message。
 */
async function checkWorkDirExists(
  sessionId: string,
  workingDir: string | undefined | null,
  agentKind: AgentKind | undefined,
  remoteHostId?: string | null,
  opts?: { suppressMissingBroadcast?: boolean },
): Promise<boolean> {
  // 远端 session: workdir 在远端机器上, 本地 fs.stat 必然 ENOENT 但完全没意义。
  // 这条 guard 当初是为本地 session 兜底 "用户在 Finder 把目录删了 / 改名了" 的
  // 场景, 远端走自己的 probe (StartRemoteSessionPanel 创建前 stat-remote-path,
  // 或者 agent 真跑起来时由远端 codex 自己报 ENOENT)。这里直接放行。
  if (remoteHostId) return true;
  if (!workingDir?.trim()) return true;
  const source: AgentKind = agentKind === 'codex' || agentKind === 'pi' ? agentKind : 'claude-code';
  // suppressMissingBroadcast: 调用方(SEND 事务)手里还有 DB 权威值可兜底时,
  // 首检失败只记日志不广播错误横幅——兜底成功的话用户不该看到假错误。
  const suppress = opts?.suppressMissingBroadcast === true;
  try {
    const stat = await fsp.stat(workingDir);
    if (!stat.isDirectory()) {
      if (suppress) {
        log.warn('send: workdir not a directory (broadcast suppressed, caller has fallback)', { sessionId, workingDir });
      } else {
        emitWorkDirMissingError(sessionId, workingDir, source, 'not-dir');
      }
      return false;
    }
    // Managed worktrees need a stronger readiness check than directory existence: another send
    // may observe `git worktree add` before snapshot apply finishes, and a previous apply conflict
    // deliberately leaves the directory present while keeping the session blocked.
    const normalizedWorkingDir = path.resolve(workingDir).replace(/\\/g, '/');
    if (getManagedWorktreeBasePath(normalizedWorkingDir) !== null) {
      const ready = await restoreMissingManagedWorktreeForSession(sessionId, workingDir);
      if (!ready) {
        if (suppress) {
          log.warn('send: managed worktree not ready (broadcast suppressed, caller has fallback)', { sessionId, workingDir });
        } else {
          emitWorkDirMissingError(sessionId, workingDir, source, 'not-exist');
        }
        return false;
      }
    }
    return true;
  } catch {
    // app 托管的 dialogue 工作目录(<userData>/dialogues/<日期>/<id>)本来就是
    // 空的一次性目录:丢了直接 mkdir 重建放行,不打扰用户(自愈详见
    // dialogueWorkdirSelfHeal.ts;legacy userData 前缀由启动 sweep 先行改写)。
    const healed = await healMissingDialogueWorkdir(workingDir, dialogueWorkspaceRootDir());
    if (healed) {
      log.info('send: recreated missing dialogue workdir', { sessionId, workingDir });
      return true;
    }
    // Cindy 托管 worktree 被外部 PR cleanup / 手动 git 命令移除时，先按 DB 中
    // 的精确 worktree_path 从本地或 origin tracking 分支重建。普通用户目录绝不
    // 猜测 fallback；快照冲突也保持阻断，交给恢复横幅显式处理。
    const restored = await restoreMissingManagedWorktreeForSession(sessionId, workingDir);
    if (restored) {
      log.info('send: restored missing managed worktree', { sessionId, workingDir });
      return true;
    }
    if (suppress) {
      log.warn('send: workdir missing (broadcast suppressed, caller has fallback)', { sessionId, workingDir });
      return false;
    }
    const similar = await findSimilarDirOnDisk(workingDir);
    emitWorkDirMissingError(sessionId, workingDir, source, 'not-exist', similar);
    return false;
  }
}

/**
 * ENOENT 兜底:扫一下 parent 目录,找一个 trim/大小写 后等于目标 basename 的真实条目。
 * 命中的最典型场景是 macOS Finder 里目录名末尾带了不可见空格,而 sessions.ts 写库时
 * 做了 .trim() 把空格砍了 —— DB 里存的路径在磁盘上不存在,但同名带空格的目录是存在的。
 * 失败一律返回 null,不要在错误兜底里再抛新错。
 */
async function findSimilarDirOnDisk(workingDir: string): Promise<string | null> {
  try {
    const parent = path.dirname(workingDir);
    const target = path.basename(workingDir);
    if (!parent || parent === workingDir || !target) return null;
    const entries = await fsp.readdir(parent);
    const trimMatch = entries.find((n) => n !== target && n.trim() === target.trim());
    if (trimMatch) return path.join(parent, trimMatch);
    const ciMatch = entries.find((n) => n !== target && n.toLowerCase() === target.toLowerCase());
    if (ciMatch) return path.join(parent, ciMatch);
    return null;
  } catch {
    return null;
  }
}

function emitWorkDirMissingError(
  sessionId: string,
  workingDir: string,
  agentSource: AgentKind,
  reason: 'not-exist' | 'not-dir',
  similarPath?: string | null,
): void {
  const base =
    reason === 'not-dir'
      ? `工作目录已不是文件夹, 无法继续: ${workingDir}`
      : `工作目录已不存在, 无法继续: ${workingDir}`;
  // JSON.stringify 把路径用引号包起来,末尾空格 / 不可见字符在引号里肉眼可见。
  const hint = similarPath
    ? ` — 注意: 磁盘上有同名但不完全一致的目录 ${JSON.stringify(similarPath)} (可能末尾带空格或大小写不同),建议在 Finder 重命名后重新选择目录。`
    : '';
  const message = base + hint;
  log.warn('send aborted: workdir missing', { sessionId, workingDir, reason, similarPath: similarPath ?? undefined });
  broadcastToAllWindows(MAKER_PUSH.EVENT, {
    sessionId,
    event: {
      type: 'error',
      data: { message },
      source: agentSource,
    } satisfies AgentEvent,
  });
}

function redactEventForRenderer(event: AgentEvent): AgentEvent {
  if (!event.data || typeof event.data !== 'object') return event;

  const data = event.data as Record<string, unknown>;
  const safeData = { ...data };
  let changed = false;
  for (const key of ['message', 'sdkError'] as const) {
    if (typeof safeData[key] === 'string') {
      const redacted = redactSensitiveText(safeData[key]);
      if (redacted !== safeData[key]) {
        safeData[key] = redacted;
        changed = true;
      }
    }
  }

  if (event.type === 'done' && safeData.raw && typeof safeData.raw === 'object') {
    const raw = { ...(safeData.raw as Record<string, unknown>) };
    if (raw.error && typeof raw.error === 'object') {
      const error = { ...(raw.error as Record<string, unknown>) };
      for (const key of ['message', 'detail', 'sdkError', 'additionalDetails'] as const) {
        if (typeof error[key] === 'string') {
          const redacted = redactSensitiveText(error[key]);
          if (redacted !== error[key]) {
            error[key] = redacted;
            changed = true;
          }
        }
      }
      raw.error = error;
    }
    safeData.raw = raw;
  }

  return changed ? ({ ...event, data: safeData } as AgentEvent) : event;
}

function broadcastToAllWindows(channel: string, payload: unknown): void {
  // device-link 被控端旁路:命中转发白名单且存在控制链路时,把事件转发给控制端
  // (无 link 时 O(1) no-op,不进 maker-core 热路径成本)
  // 旁路永远不能反向阻断本机生命周期。owner boundary 切换期间远端链路
  // 可能暂不可用；如果异常冒泡，Session 的 status/terminal listener 会在
  // 清理前中止，最终留下 tracker busy + 死进程，所有后续消息永久排队。
  try {
    tapWindowBroadcast(channel, payload);
  } catch (err) {
    log.warn('device-link broadcast tap failed; keeping local broadcast alive', {
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch (e) {
      log.warn(`broadcast to window failed: ${String(e)}`);
    }
  }
}

/**
 * device-link:被控端「当前 New Maker 草稿」任意变化(newMakerDraft 选中态 / providerModelMemory
 * 列表态)→ 把 per-vendor 解析结果(含 providerModelMemory 全量)转发给订阅的控制端,刷新远程草稿
 * 显示镜像。只走 tap(转发控制端),**不** webContents.send 本地窗口 —— 被控端是真相、不自镜像。
 * 无控制者订阅时 tap 近似 no-op(O(1))。SYNC_NEW_MAKER_DRAFT / SYNC_PROVIDER_MODEL_MEMORY 共用。
 *
 * 合并(coalesce):一次用户动作可能同时改 newMakerDraft 与 providerModelMemory,两个 SYNC handler
 * 各调一次本函数 → 用 setTimeout(0) 把同一突发内的多次调用并成一次 fan-out(全量快照幂等,延迟一个
 * 计时 tick 对低频草稿变更无感),避免重复转发整张快照。
 */
let draftChangedScheduled = false;
function broadcastNewMakerDraftChanged(): void {
  if (draftChangedScheduled) return;
  draftChangedScheduled = true;
  setTimeout(() => {
    draftChangedScheduled = false;
    tapWindowBroadcast(MAKER_PUSH.NEW_MAKER_DRAFT_CHANGED, {
      claudeCode: getRemoteNewMakerDefaults('claude-code'),
      codex: getRemoteNewMakerDefaults('codex'),
    });
  }, 0);
}
