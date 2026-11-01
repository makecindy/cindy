import { createOrcaPluginAuthority } from '@cindy/app-runtime/orcaPluginAuthority';
import {createSessionRewindInputBoundary} from '@cindy/app-runtime/sessionRewindInputBoundary';
import {createBotTodoDelivery} from '@cindy/app-runtime/botTodoDelivery';
import { createBotCapabilityPreflight } from '@cindy/app-runtime/botCapabilityPreflight';
import { createBotImSendGuard } from '@cindy/app-runtime/botImSendGuard';
import { createBotGroupStepNotification } from '@cindy/app-runtime/botGroupStepNotification';
import { companionMergeIds, companionMergeResult, companionSwitchOptions, companionFailureCode } from '@cindy/app-runtime/companionCloudControl';
import { registerBotGroupHandlers } from '@cindy/app-runtime/botGroupHandlers';
import { createPluginTaskReviewContextReader } from '@cindy/app-runtime/pluginTaskReviewContextReader';
import {registerBotDelegationHandlers} from '@cindy/app-runtime/botDelegationHandlers';
import {createSessionControlCoordinator} from '@cindy/app-runtime/sessionControlCoordinator';
import { createSessionRuntimeManagement } from '@cindy/app-runtime/sessionRuntimeManagement';
import { registerBotDirectMessageHandlers } from '@cindy/app-runtime/botDirectMessageService';
import {createSessionSenderIdentityReader} from '@cindy/app-runtime/sessionSenderIdentity';
import {createBotSessionDispatcher} from '@cindy/app-runtime/botSessionDispatcher';
import {createBotModelRouteReader} from '@cindy/app-runtime/botModelRouteReader';
import {createBotRuntimeRefreshHost} from '@cindy/app-runtime/botRuntimeRefreshHost';
import { createSessionRuntimeProfiles } from '@cindy/app-runtime/sessionRuntimeProfiles';
import { registerSessionRuntimeAxisHandlers } from '@cindy/app-runtime/sessionRuntimeAxisHandlers';
import { createPendingCredentialSwitchRegistration, createPendingCredentialSwitchPersistence } from '@cindy/app-runtime/pendingCredentialSwitchHost';
import { createSameAgentModelSelection, createPendingPiModelSelection } from '@cindy/app-runtime/sessionModelSelectionAdapters';
import { createPendingRuntimeAxisResolver } from '@cindy/app-runtime/pendingRuntimeAxisResolver';
import { createAgentDeviceRuntimeSelection } from '@cindy/app-runtime/agentDeviceRuntimeSelection';
import { createSessionModelSelection } from '@cindy/app-runtime/sessionModelSelection';
import { createSessionRecoveryLeases } from '@cindy/app-runtime/sessionRecoveryLeases';
import { createBotFallbackCandidateReader } from '@cindy/app-runtime/botFallbackCandidate';
import { createInterruptedTurnRecovery } from '@cindy/app-runtime/interruptedTurnRecovery';
import { createSessionRuntimeFallback } from '@cindy/app-runtime/sessionRuntimeFallback';
import type { InternalRuntimeSelectionOptions } from '@cindy/app-runtime/sessionRuntimeSelectionTypes';
import { createAutoResumeInputLifecycle } from '@cindy/app-runtime/autoResumeInputLifecycle';
import { createSchedulerRecoveryBridge } from '@cindy/app-runtime/schedulerRecoveryBridge';
import { createScheduledPreferenceStore } from '@cindy/app-runtime/scheduledPreferenceStore';
import { createScheduledModelProjection } from '@cindy/app-runtime/scheduledModelProjection';
import { createSchedulerQueueBridge } from '@cindy/app-runtime/schedulerQueueBridge';
import { createSessionActivityBridge } from '@cindy/app-runtime/session-activity/bridge';
import {createSessionControlInputBuilder} from '@cindy/app-runtime/sessionControlInput';
import { createSessionQueueReader } from '@cindy/app-runtime/sessionQueueReader';
import {createUsageLimitWaitHost} from '@cindy/app-runtime/usageLimitWaitHost';
import {createWorkingDirectoryDiagnostics} from '@cindy/app-runtime/workingDirectoryDiagnostics';
import {createSessionClear} from '@cindy/app-runtime/sessionClear';
import { createContextRebuildCommit } from '@cindy/app-runtime/contextRebuildCommit';
import { createPluginWorkerCompletionReader, readPluginWorkerActivity } from '@cindy/app-runtime/pluginWorkerCompletion';
import {createSessionEventGuards} from '@cindy/app-runtime/sessionEventGuards';
import {createSilentStopRuntime} from '@cindy/app-runtime/silentStopRuntime';
import { redactEventForRenderer } from '@cindy/app-runtime/sessionEventRedaction';
import { createRemoteInputAutoTitle } from '@cindy/app-runtime/remoteInputAutoTitle';
import { createQueuedEditProvenance, registerMakerInputSubmission } from '@cindy/app-runtime/makerInputSubmission';
import { createQueuedAttachmentLifecycle } from '@cindy/app-runtime/queuedAttachmentLifecycle';
import { createMakerInputValidation } from '@cindy/app-runtime/makerInputValidation';
import { registerMakerInputControls } from '@cindy/app-runtime/makerInputControls';
import { markWorkerIdle, listIdleReleaseCandidates, markIdleReleased, touchWorker } from '../localDb/orcaTeamStore.js';
import { attachTrustedDesktopSendContext } from '@cindy/app-runtime/makerSendTransaction';
import { createMakerInputBoundary } from '@cindy/app-runtime/makerInputBoundary';
import { createMakerSteerTransaction } from '@cindy/app-runtime/makerSteerTransaction';
import { setVoiceTaskDispatch, setVoiceCallMemoryReader } from '../voice-conversation/taskBridge.js';
import { buildBotMemoryScopeKey } from '@cindy/maker-core';
import { createOrcaWorkerProjectHandlers } from './orcaWorkerProjectHandlers';
import { getTeamByWorkerSession } from '../localDb/orcaTeamStore';
import { readWorkerProjectContext, createWorkerWorktree, rememberWorkerProject, probeWorkerProject, resolveWorkerWorktreeSource, getWorkerOwnedWorktree } from './orcaWorkerProject';
import type { WorkerWorktreeRequest } from '../../shared/orca-worker-project';
import { captureAgentRequest as captureRequest, ownerChannelInputEvidence, type CapturedAgentRequest } from './forwardedRequest.js';
import { readChannelToolScope } from '../im/shared/channelToolScope.js';
import { taskActionPrincipal } from './taskActionAuthorization.js';
import { verifiedOwnerRequestText, type AgentRequestReceipt } from '../../shared/forwardedRequest.js';
import { configureBotTodoDispatch, settleBotTodoForSession } from './botTodoAccess.js';
import { createBotTodoDispatch } from './botTodoDispatch.js';
import { assertBotTaskCoordination, classifySessionMessagePurpose, coordinationInput } from './botTaskCoordination.js';
import type { BotTaskCoordination, SessionMessagePurpose } from '../../shared/botTaskCoordination.js';
import { openSession, setSessionOpeningModelAdmission } from '../localDb/sessionOpening.js';
import { createPluginTaskReviewResolver } from './pluginTaskReviewContext.js';
import { isPluginTaskPermissionAllowed, assertPluginTaskResult, createPluginTaskService, readPluginTaskPlanReceipt, PluginTaskError, type PluginTaskService } from './pluginTaskService.js';
import { resolvePluginWorkerDirectory } from './pluginWorkerDirectory.js';
import { PluginWriteAccessGate } from './pluginWriteAccessGate.js';
import { createPluginTaskStore } from './pluginTaskStore.js';
import { createPluginBackgroundTaskHandlers, revealAllPluginHiddenTasks } from './pluginHiddenTasks.js';
import { setSessionHidden } from '../localDb/ipc/sessionHidden.js';
import { isSessionHiddenSync } from '../localDb/hiddenSessionRegistry.js';
import { notifyAgentIslandBotGroupChanged } from '../localDb/agentIslandSessionPatch.js';
import { ghostDeclaresHiddenTasks } from '../../shared/ghost.js';
import { controlOwnedSessionExecution, isSameSessionExecution, withdrawOwnedSessionInputs } from './sessionExecutionOwnership.js';
import { showMobilePluginTaskPermission, setPluginTaskHandler, setPluginTargetAdapter, assertPluginTargetQueuedDelivery, getPluginTaskSourceSessionId, setPluginTaskUninstaller, setPluginTaskRelocator, pluginTargetAuthorizationRevision, isPluginTaskAuthorized, getPluginTaskInstallRevision, pluginTaskAuthorizationRevision } from '../cindy-brain/index.js';
import { listPluginTargetCandidates, resolvePluginTargetSession } from './pluginTargetCandidates.js';
import { createPluginTargetStore } from './pluginTargetStore.js';
import { collectPluginAttachmentPayloadTexts, withPluginMessageAttachments } from '../cindy-media/pluginMessageAttachments.js';
import type { PluginTaskRoute, PluginTaskRequest } from '../../shared/pluginTasks.js';
import { createHash as pluginTaskConfigHash } from 'node:crypto';
import { finishCompanionEnvironmentRemoval } from '../bot-import/runtime.js';
import { setImportProbeConfirmation } from '../bot-import/probeAuthorization.js';
import { requestHostInteraction } from './interactionRouter.js';
import { registerMcpAppsIpc } from '../mcp-apps/ipc.js';
import { createAppMessageSender } from '../mcp-apps/messageSender.js';
import { MCP_APP_MESSAGE_GUARD, type McpAppMessageGuard } from '../mcp-apps/message.js';
import { mcpAppModelContext } from '../mcp-apps/runtime.js';
import { prepareCompanionImportDeletion } from '../bot-import/host.js';
import { createBotMessageTransport } from './botMessageTransport.js';
import { MANAGED_LLAMACPP_PROVIDER_ID, llamaCppModelPreset, llamaCppMaxContextSize } from '../../shared/llamaCpp.js';
import { getManagedLlamaCppService } from '../local-model-runtime/llamaCppService.js';
import { ensureManagedLlamaCppProvider } from '../local-model-runtime/managedLlamaCppProvider.js';
import { setBotRemoteMessageService } from './botRemoteMessageReceiver.js';
import { handleListDevices, defaultDeps as deviceDirectoryDeps } from '../device-link/ipc.js';
import { configureBotAutonomyHost, getBotAutonomyGlance, noteBotAutonomyInputProjection } from '../bot-autonomy/hub.js';
import { getHostSourceDevice, getSelfDeviceId, remoteBackgroundInvoke, remoteInvoke as invokeBotPeer } from '../device-link/index.js';
import { readDeviceProviderViews } from '../remote-agent/controller/deviceCatalog.js';
import { checkDeviceRoute } from '../remote-agent/controller/deviceRouteCheck.js';
import { cancelPendingRemoteStart } from '../remote-agent/controller/startRemote.js';
import { forgetCredentialGrants } from '../remote-agent/executor/credentialGrants.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import {
  isProviderGroupReleased,
  listRemoteProviderGroupBindings,
  markProviderGroupReleased,
  readProviderGroupBinding,
  writeProviderGroupBinding,
} from '../provider-group/bindings.js';
import { getProviderGroupGuestSwitch } from '../provider-group/guestSwitch.js';
import { currentProviderPartyUsageStore } from '../usage/providerPartyUsageStore.js';
import { recordSessionProviderPartyUsage } from './sessionProviderPartyUsage.js';
import { createProviderGroupLeaseReporter, type ProviderGroupLeaseReporter } from '../provider-group/leaseReporter.js';
import { ensureProviderGroupUsageReporter, notifyProviderGroupUsage } from '../provider-group/usageReportRuntime.js';
import { PROVIDER_GROUP_USAGE_ENSURE_INTERVAL_MS, PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS } from '../provider-group/usageReporter.js';
import {
  getProviderGroupDirectory,
  getProviderGroupRemoteClient,
  getProviderGroupRemoteGroups,
  getProviderGroupRouter,
  setProviderGroupLocalLoad,
  setProviderGroupClaudeUsageReader,
  setProviderGroupCodexUsageReader,
  setProviderGroupSessionGroupReader,
  setProviderGroupSessionRebalance,
  setProviderGroupTurnProbe,
} from '../provider-group/runtime.js';
import { readProviderGroupAutoRebalance, writeProviderGroupAutoRebalance } from '../provider-group/sessionPrefs.js';
import { countProviderRunningTurns, type ProviderLocalLoadRoute } from '../provider-group/localLoad.js';
import { remoteAgentHostRunningProviders, resolveRemoteAgentHostClaudeSessionId } from '../remote-agent/host/service.js';
import {
  createProviderGroupService,
  PROVIDER_GROUP_SUPERSEDED_ERROR,
  type ProviderGroupRoute,
  type ProviderGroupService,
  type ProviderGroupSessionRow,
  type ProviderGroupStartContext,
  type ProviderGroupTurnErrorHooks,
} from '../provider-group/service.js';
import { createProviderGroupHeldRecovery, createProviderGroupHeldTurnErrors } from '../provider-group/heldTurnErrors.js';
import { createProviderGroupHeldWorkerTerminals } from '../provider-group/heldWorkerTerminals.js';
import { providerGroupSwitchCause } from '../provider-group/failurePolicy.js';
import { listProviderGroups, readProviderGroup } from '../provider-group/store.js';
import { providerGroupReshare } from '../provider-group/reshareRuntime.js';
import {
  isRemoteProviderInvocationAllowed,
  setRemoteProviderInvocationEnabled,
} from '../maker-host/remote-provider-access-store.js';
import { registerModelFavoritesSync } from './modelFavoritesSync.js';
import { advanceRuntimeRecoveryNotice } from '../im/shared/runtimeRecoveryNotice.js';
import { removeBotImConnectionsForBot } from '../im/shared/botImConnectionRuntime.js';
import { configureBotImLaneRuntime } from '../im/shared/botImLaneRuntime.js';
import { markImSessionManualRouteOverride } from '../im/shared/manualRouteOverride.js';
import { configureAppDefaultModelSelection, inspectAppDefaultModel } from './appDefaultModelControl.js';
import type { BuiltinApiKeyBridgeDeps } from '../secrets/builtinApiKeyBridge.js';
import { setBotInvitationWelcomeDispatch } from './botInvitation.js';
import { createQueuedDispatchReceipts } from './queuedDispatchReceipts.js';
import type { TurnUsageContext } from './turnUsageContext.js';
import { retainProviderPresentationAfterAuthChange } from '../maker-host/provider-presentation-store.js';
import { registerPluginListHandler } from './pluginListHandler.js';
import { initializeBotAuthorizationHost } from './botAuthorizationHost.js';
import { resolveBotAuthorizationDelivery, buildBotAuthorizationContinuation, commitBotAuthorizationInput, type BotAuthorizationInputGuard, getBotAuthorizationService } from './botAuthorizationService.js';
import { registerSessionSetModelHandler } from './sessionSetModelHandler.js';
import { refreshSubscriptionAccountModels } from '../maker-host/subscription-account-models.js';
import { syncSubscriptionAccountUsage } from '../usage/subscriptionAccountUsage.js';
import { clearXaiRateLimitSnapshot } from '../usageBroadcaster.js';
import { subscriptionAccountKind, subscriptionAccountState, loginSubscriptionAccount, logoutSubscriptionAccount, cancelSubscriptionAccountLogin, removeSubscriptionAccountCredentialsReversibly } from '../maker-host/subscription-account-auth.js';
import { isCodexAccountProvider, codexAccountState, codexAccountLoginName, loginCodexAccount, logoutCodexAccount, cancelCodexAccountLogin, removeCodexAccountCredentialsReversibly, retireCodexAccount } from '../maker-host/codex-account-auth.js';
import { projectRemoteBotDelegations } from './remoteBotDelegations.js';
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

import { readCodexContextWindowInfo } from '../maker-host/codex-context-window.js';
import { readSshCodexModelList, assertSshCodexModel, isVerifiedSshCodexResume } from '../remote-ssh/codex-model-list.js';
import { prepareCodexCustomContextCatalog } from '../maker-host/codex-custom-context-catalog.js';
import { inferProviderIdForModel } from '../maker-host/provider-route.js';
import { bindGroupFastPolicy } from '../provider-group/fastPolicyRuntime.js';
import { resolveConfiguredContextWindow, contextWindowBudgetChangesEffectiveWindow, resolveDesktopModelContextProviderId, resolveSessionContextWindowBounds, readStoredSessionContextWindowBudget, applySessionContextWindowBudgetToCreateOpts } from '../maker-host/model-context-settings.js';
import { isSessionContextWindowBudgetCustomized, readSessionContextWindowBudget } from '../maker-host/session-context-budget-store.js';
import { MAX_CONTEXT_WINDOW_BUDGET, MIN_CONTEXT_WINDOW_BUDGET } from '../../shared/sessionContextWindowBudget.js';
import { getCodexHome } from '../maker-host/auth-adapters.js';
import { getCachedBinaryStatus } from '../agent-binaries/index.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  canHostControlPiSubagentRun,
  controlPiSubagentRuns,
  isPiSubagentTerminal,
  listPiSubagentRuns,
  piSubagentRunRoot,
} from '@cindy/maker-core/pi-subagent-runs';
import {
  PI_CACHE_RECOVERY_EXPECTATION, AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT,
  INHERITED_CAPABILITY_SELECTION, MAIN_OWNED_SEND_CONTEXT,
} from '@cindy/maker-core';
import { AUTO_REVIEW_DELEGATED_CONTINUATION, readAutoReviewUserText, restoreAutoReviewSteerIntent, restoreAutoReviewUserIntent } from './autoReviewUserIntent.js';
import type {
  AgentEvent,
  AgentKind,
  Effort,
  ContextUsageData,
  InteractionDecision,
  InteractionRequest,
  MainOwnedSendContext,
  Maker,
  PermissionMode,
  SendOrigin,
  Session,
  SessionSendOptions,
  SessionSendResult,
  UserMessage,
} from '@cindy/maker-core';
import {
  actualSourceIdForModel,
  effectiveSourceIdForModel,
  isModelSelectableForNewRoute,
  buildUserProvider,
  mergeDiscoveredRuntimeModels,
  findCatalogModel,
  storedCustomProviderId,
  isLocalOnlyProviderForAgent,
  isOrganizationManagedProvider,
  type ProviderView,
} from '@cindy/model-providers';
import { createId } from '@paralleldrive/cuid2';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import {
  isTurnContinuationBoundaryEvent,
} from '@cindy/maker-shared/turn-continuation';
import {
  CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1,
  DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
  readInputDeliveryClientIds,
} from '@cindy/device-link';
import { and, asc, desc, eq, gte, inArray, isNull, like, lt, or, sql } from 'drizzle-orm';
import { applyScheduledModelSelection, createScheduledModelScope, ScheduledModelSelectionBusyError, type ScheduledModelSelection, type ScheduledModelSelectionLease } from './scheduledModelSelection';
import { parseScheduledModelBaseline } from '../../shared/scheduledModelBaseline';
import { recordTurnModelChange, type TurnModelIdentity } from './turnModelChange';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import {
  activeOwnerScopeKey,
  getActiveAppSession,
  getActiveDataOwnerPushStamp,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../appSessionState.js';
import { upsertRecentWorkdir } from '../localDb/ipc/recentWorkdirs.js';
import { isRetainableProjectSession } from '../../shared/sessionSource.js';
import { initializePluginOauthCards } from '../plugin-oauth/cards.js';
import { currentOauthIdentityScope, loadOauthSigningKey } from '../plugin-oauth/desktopIdentity.js';
import { readDeviceLinkSettings, readLastKnownDeviceNames } from '../device-link/settings-store.js';
import { getDeviceLinkStatus, getMobileNotifyGeneration, sendMobileBotGroupNotify, sendMobileSessionNotify } from '../device-link/index.js';
import type { AgentMeta, Session as RendererSession } from '../../renderer/lib/ccAgent.types';
import {
  deriveAutoTitleSeed,
  normalizeAgentInputClearBoundaryMs,
  serializeSessionReferencePayload,
  USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
  HOST_ONLY_AGENT_PREFIX,
  type AgentInputClearBoundaryOpts,
  type AgentInputCreateOpts,
  type AgentInputQueuedMessage,
  type AgentInputSessionRef,
  type AgentInputSessionReferenceContext,
} from '../../shared/agentInputQueue.js';
import { getManagedWorktreeBasePath } from '../../shared/managedWorktreePaths.js';
import { normalizeWorkingDirForProjectSettings } from '../../shared/workingDir.js';

import {
  applyWithVerifiedModelWindow,
  buildDeferredRuntimeSelectionProfile,
  nextDeferredModelWindowRetry,
  planUserRuntimeModelSwitch,
  shouldSkipColdPiWindowRehydration,
} from '../../shared/runtimeModelSwitchGate.js';
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
import { buildInputHandoffNoticeText } from '../im/desktopConfirmNotice.js';
import { sendInputHandoffChannelNotice } from '../im/shared/inputHandoffChannelNotice.js';
import { bindingStore } from '../im/binding.js';
import { isHeadlessGhostSetupTurn } from '../mcp-integrations/ghostSetupInteractionSurface.js';
import {
  initGhostSetupInteractionBridge,
  parseGhostSetupInteractionCommand,
  parseGhostSetupInlineSubmitRequest,
  projectPendingInteractionsForRemote,
  type GhostSetupInteractionResponseTarget,
  type GhostSetupInteractionSnapshot,
} from '../cindy-brain/ghostSetupInteractionBridge.js';
import { initGhostSetupCoordinator } from '../cindy-brain/ghostSetupCoordinator.js';
import { classifyGhostVisibility } from '../cindy-brain/ghostVisibility.js';
import { resolveSafe as resolveCindyMediaUrl } from '../cindy-media/blobStore.js';
import { companionAvatarCache } from '../companion-cloud/avatarCacheHost.js';
import { ingestMedia } from '../cindy-media/ingest.js';
import { removeRefs as removeMediaRefs } from '../cindy-media/ledger.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';
import { toolNotFoundMessage } from '../cindy-brain/pipeDispatcher.js';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';
import { isGhostDisabledForWorkdir } from '../cindy-brain/ghostWorkdirPrefs.js';
import {
  executeGhostSetupAction,
  executeGhostSetupInlineAction,
  bindGhostSetupConnectionAction,
  findGhostForInstanceId,
  ghostInstallMutationTargetFor,
  getGhostManager,
  getGhostPipeDispatcher,
  getGhostSetupAssessment,
  remotePluginSettings,
  isGhostAvailableForActiveSession,
} from '../cindy-brain/index.js';
import {
  hasDeliveryNamespace,
  installedGhostStoragePart,
} from '../../shared/pluginIdentity.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererEvent,
} from '../security/trustedAppRenderer.js';
import {
  initRenameSessionsConfirm,
  RenameSessionsConfirmBridge,
  type RenameSessionsConfirmInteractionSnapshot,
} from '../session-title-rename/index.js';
import { getBrowserAvailability, openBrowserForLogin } from '../mcp-integrations/browser.js';
import { readComputerStatusForSettings, type ComputerStatusRequest } from './computerStatusHandler.js';
import { isBrowserOpenForLoginError } from '../../shared/browserBackend.js';
import {
  getActiveCodexBridgeInstanceId,
  getActiveCodexBridgeServerNames,
  shutdownCodexEnvironment,
} from '../mcp-integrations/codexEnvironment.js';
import { invalidatePiEnvironment } from '../mcp-integrations/piEnvironment.js';
import { REMOTE_MEMORY_SERVER_NAME, REMOTE_BOT_HELPER_SERVER_NAME } from '../mcp-integrations/codexHttpBridge.js';
import { getRemoteMcpBridgeToken } from '../mcp-integrations/remoteMcpBridgeToken.js';
import {
  checkComputerDriverUpdate,
  cancelComputerDriverPermissionGrant,
  getComputerDriverAppBundlePath,
  getComputerDriverAppIcon,
  getComputerDriverStatus,
  grantComputerDriverPermissions,
  installComputerDriver,
  listComputerWindowsForAtMention,
  pauseComputerDriverPermissionProbe,
  updateComputerDriver,
} from '../mcp-integrations/computer.js';
import { getRsbBrowserBridge } from '../rsb-browser-bridge/index.js';
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
import {
  type SessionQueueInspectionEntry,
} from './sessionQueueInspection.js';
import {
  createSessionControlService,
  sessionQueueOriginForDispatcher,
} from './sessionControlService.js';
import {
  createQueueReorderAdapter,
  type SessionQueueMoveResult,
  type SessionQueueSteerResult,
} from './sessionQueueControl.js';
import {
  createSessionBindingLifecycle,
  createSessionCloseTeardown,
  finalizeSessionClose,
  runSessionCloseCleanup,
} from './sessionBindingLifecycle.js';
import { readCanonicalSessionActivity } from './sessionActivityProjection.js';
import {
  listAtBrowserTabs,
  parseAtContextCatalogRequest,
  readAtDesktopWindows,
  resolveAtBrowserTabSessionId,
} from './atContextCatalog.js';
import {
  finalizeAtProjectAgentResources,
  listAtProjectAgentResources,
  supportsAtProjectAgentResources,
} from './atAgentCatalog.js';
import * as imageCacheStore from '../imageCacheStore.js';
import * as cindyChatAttachments from '../cindy-media/chatAttachments.js';
import { materializeSshRemoteMedia } from '../file-browser/ssh-media.js';
import { readGeneratedImageFile, MAX_GENERATED_IMAGE_BYTES } from '../cindy-media/generatedMedia.js';
import { createGeneratedImageDelivery } from '../cindy-media/generatedImageDelivery.js';
import { setGeneratedImageRecovery } from '../cindy-media/generatedImageRecovery.js';
import {
  getCurrentDbClientSnapshot,
  getDbClient,
  isDbClientNotReadyError,
  tryGetDbClient,
} from '../localDb/client/current.js';
import { createBotRuntimeRestoreCoordinator } from './botRuntimeRestore.js';
import { createWorkingDirectoryRecovery, isUnavailableFilesystemError } from './workingDirectoryRecovery.js';
import { createWorkingDirectoryPreflight } from './workingDirectoryPreflight.js';
import { allocateDialogueRecoveryWorkspace, findDialogueRecoveryWorkspace, requiredDialogueRecoveryRoot } from './dialogueRecoveryWorkspace.js';
import { workdirDiagnosticContext, workdirDiagnosticErrorCode } from '../workdirDiagnostics.js';
import { statWorkingDirectory, mkdirWorkingDirectory, realpathWorkingDirectory, findSimilarWorkingDirectory } from '../workdir-probe-host/index.js';
import { getMessagesForHistory } from '../localDb/chatHistoryReader.js';
import {
  awaitAgentInputQueueSnapshotPersistence as awaitQueuedSnapshotWrite,
  loadAgentInputQueueSnapshot,
  loadAgentInputQueueSnapshotCounts,
  getPersistedInputClientIds,
  saveAgentInputQueueSnapshot,
  saveCancelledInputDelivery,
  readInputDeliveryReceipts,
  hasInputDeliveryCancellation,
} from '../localDb/agentInputQueueSnapshots.js';
import {
  ensureDialogueWorkspaceDir,
  dialogueWorkspaceRoots,
  isManagedDialogueWorkspace,
} from '../localDb/dialogueWorkspace.js';
import {
  broadcastMessageRow,
  broadcastMessageAgentMetaUpdate,
  broadcastMessageDeleted,
  commitContextRebuild,
  commitMessageDeletion,
  createMessage as createDbMessage,
  findLatestContextRebuildMeta,
  rewindPersistedUserMessageAfterClear,
  findParkedEngineSession,
  getMessageDeletionTarget,
  listMessagesForAgentHandoff,
  findLatestUserMessageForRebuild,
  patchMessageAgentMeta,
  readPiUserEntry,
  supersedeRetriedUserTurn,
  updateMessageContent,
} from '../localDb/ipc/messages.js';
import { invalidateWorkersByLeadSingleFlight } from '../localDb/ipc/orcaWorkerListSingleFlight.js';
import { messageToCamel, setSessionRuntimeProjector } from '../localDb/mapper.js';
import { visibleMessageText, visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure.js';
import { buildReviewPrompt } from '../reviewer/reviewPrompt.js';
import { resolveReviewScope, withSessionReviewWorkspace } from '../git-review/scopeResolver.js';
import { selectReviewWorkspace, shouldSelectReviewWorkspace } from '../reviewer/reviewWorkspaceSelection.js';
import {
  additionalReviewRepositoriesAreCurrent,
  loadAdditionalReviewRepositories,
  resolveReviewRepoRoot,
  type LoadedReviewRepository,
  type SkippedReviewRepository,
} from '../reviewer/reviewAdditionalRepositories.js';
import {
  listReviewHistoricalAttachments,
  loadReviewEvidence,
  readReviewContextFingerprint,
  reviewBranchBaselineIsCurrent,
  reviewWorkspaceFingerprintIsCurrent,
  resolveReviewArtifactPath,
  SensitiveReviewPathError,
} from '../reviewer/reviewEvidence.js';
import {
  authorizeReviewExplicitArtifacts,
  ReviewArtifactAuthorizationError,
  type ReviewArtifactConfirmationItem,
} from '../reviewer/reviewArtifactAuthorization.js';
import { confirmReviewArtifacts } from '../reviewer/confirmReviewArtifacts.js';
import { configureOutboundReviewPreparation } from './reviewOutboundInput.js';
import { assertRemoteBotInvocationAllowed } from '../device-link/remoteBotSessionBoundary.js';
import {
  cleanupOrphanedReviewArtifactSnapshots,
  prepareStableReviewArtifactSnapshots,
} from '../reviewer/reviewArtifactSnapshot.js';
import {
  fingerprintReviewArtifacts,
  ReviewArtifactFingerprintChangedError,
  ReviewArtifactFingerprintLimitError,
} from '../reviewer/reviewArtifactFingerprint.js';
import { reviewChangeSetContentPaths, usableReviewChangeSet } from '../reviewer/reviewEvidenceSafety.js';
import { enforceReviewCreateOptions } from '../reviewer/reviewSessionPolicy.js';
import { reviewSourceIdentityMatches } from '../reviewer/reviewSourceIdentity.js';
import { buildReviewSessionTitle } from '../reviewer/reviewSessionTitle.js';
import { buildReviewFollowUpMessage, buildReviewInputSummary } from '../reviewer/reviewFollowUp.js';
import { listSessionTouchedDirsLive } from '../git-context/sessionDirResolver.js';
import {
  readReviewRunFromAgentMeta,
  type ReviewRunMeta,
  type ReviewRunOwner,
} from '../../shared/reviewRun.js';
import {
  createRetryableReviewInitialization,
  hasReviewOwnerProcessEnded,
  shouldFailInterruptedReview,
} from '../reviewer/reviewRunRecovery.js';
import {
  startReviewOwnerLiveness,
  type ReviewOwnerLivenessHandle,
} from '../reviewer/reviewOwnerLiveness.js';
import {
  discardInvalidReviewSourceLease,
  readPersistedReviewSourceLease,
  releaseReviewSourceLease,
  tryAcquireReviewSourceLease,
} from '../reviewer/reviewSourceLease.js';

import { broadcastSubagentRunsChanged } from '../localDb/ipc/subagentRuns.js';
import { resolveGhostFsSessionSnapshot } from './ghostFsSessionSnapshot.js';
import { clearSubagentObservationRewindState } from '../subagentObservationRewindFence.js';
import {
  applyAgentSwitchToSessionRow,
  applyAgentSwitchResumeFallbackAtomically,
  broadcastSessionPatched,
  captureSessionRecycleScope,
  clearSessionContextInDb,
  createSessionRemoteHostIdReader,
  getSessionRowSnapshot,
  getSessionFsSnapshot,
  getSessionRowSnapshotStrict,
  commitProvisionalSession,
  discardProvisionalSessionRow,
  persistSessionFields,
  recycleSessionWorktreeForStatusChange,
  restoreArchivedSessionForSend,
  scheduleWorktreeRecycleForStatusChange,
  setSessionRuntimeCleanup,
} from '../localDb/ipc/sessions.js';
// sidebar-card-mode: turn-done 后刷新列表预览,并按需生成置顶卡片摘要

import {
  addOrUpdateWorker,
  archiveSingleWorkerSession,
  archiveWorkersByTeam,
  createActiveTeam,
  getActiveTeamByLead,
  getSessionOrcaRole,
  getWorkerLink,
  isActiveWorkerStatus,
  isOrphanedTeamInit,
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
  setRemoteWorkerStatusProvider,
  setSessionOrcaRole,
  setWorkerFocus,
  updateWorkerStatus,
  updateWorkerIdentity,
} from '../localDb/orcaTeamStore.js';
import {
  botLifecycleEvents,
  botProfileVersions,
  botProfiles,
  botSessionLinks,
  messages,
  orcaTeams,
  orcaWorkers,
  orcaWorkerCreationReservations,
  sessions,
  schedules,
} from '../localDb/schema.js';
import { nextBotModelRoute, normalizeBotModelChain, type BotModelRoute } from '../../shared/botModelChain.js';
import { createBotModelRouteReconciler } from './botModelRouteReconciler.js';
import {
  cindyAutoRouteToFollow,
  followMovedCindyAutoRoutes,
  stagedCindyAutoSwitch,
} from './cindyAutoRouteFollow.js';
import { readEffectiveBotModelChain, readEffectiveBotModelSelection } from '../maker-host/bot-model-chain-settings-store.js';
import {
  isOrcaWorkerPermissionMode,
  type OrcaWorkerPermissionMode,
} from '../../shared/orca-worker-permission-mode.js';
import { t } from '../i18n.js';
import { createLogger } from '../logger.js';
import { createColdPiRehydrationForWindowVerification, classifyColdPiRehydrationOutcome } from './coldPiRehydration.js';
import { ColdPiRehydrationError, logColdPiRehydrationFailure, reportColdPiRehydrationFailure } from './coldPiRehydrationFailure.js';
import {
  desktopClaudeAuthAdapter,
  desktopCodexAuthAdapter,
  readClaudeApiKey,
} from '../maker-host/auth-adapters.js';
import { prepareSharedProjectSkillLinks } from '../maker-host/shared-global-skills.js';
import {
  activeCindyBuiltInAgentSkills,
  builtInSkillDescriptors,
} from '../maker-host/built-in-skills.js';
import { isCindySkillEnabled } from '../skillhub/activationPreferences.js';
import {
  parseDirectLearnInvocation,
  canGrantUnqualifiedClaudeLearnInvocation,
  type CindyLearnInvocationGrant,
} from '../learn-host/invocationGrant.js';
import { ensurePiManagerInstalled } from '../maker-host/pi-manager-client.js';
import {
  setRemoteCodexLiveTurnChecker,
  setRemoteSessionStartEnsure,
  getRemoteCcTurnSettledHandler,
  getRemoteCcStaleQuery,
} from '../maker-host/remote-session-start-ensure.js';
import { getCodexProxyAuthInjectionState } from '../maker-host/codex-proxy-host.js';
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
import {
  createBotDelegationService,
  discardDelegationQueuedInputs,
  hasExplicitSessionTaskModel,
  type BotDelegationService,
} from './botDelegationService.js';
import { createBotSessionTaskRouteBridge } from './botSessionTaskRouteBridge.js';
import {
  createBotDirectMessageService,
  type BotDirectMessageService,
} from './botDirectMessageService.js';
import { createBotGroupChatService, settleBotGroupLaneTerminal, type BotGroupChatService, type BotGroupChatServiceDeps, type BotGroupLaneTerminal } from './botGroupChatService.js';
import { settleUndispatchedBotGroupTurn } from './botGroupRuntimeFailure.js';
import { withChatServer } from './chatServer.js';
import { companionHomes, isCompanionShadowed } from '../companion-cloud/homes.js';
import { createCompanionCloudHost } from '../companion-cloud/host.js';
import { activeCompanionCloud } from '../companion-cloud/runtime.js';
import { companionCloudView } from '../companion-cloud/view.js';
import type { CompanionCloudActionResult, CompanionCloudFailureCode, CompanionHomeChoices, CompanionMergeResult, CompanionSwitchOptions } from '../../shared/companionCloud.js';
import { createBotGroupPlanDecider } from './botGroupPlanDecider.js';
import { botGroupMembersVisibleRemotely, registerBotGroupRemoteResourceProvider } from './botGroupRemoteResourceProvider.js';
import { broadcastBotGroupRemoteResourceChanged } from './botGroupRemoteResourceInvalidation.js';
import { getBotGroupStepNotificationBody, getInputHandoffNotificationBody } from '../sessionNotificationCopy.js';
import { readSessionTitle } from '../im/shared/controlProjects.js';
import { readSessionNotificationPreview } from '../localDb/sessionNotificationPreview.js';
import { createBotGroupWorkDir } from './botGroupWorkDir.js';
import { createBotGroupAttachmentStore } from './botGroupAttachments.js';
import { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import { validateExistingLocalProjectDirectory } from '../mcp-integrations/createProject.js';
import { gitExec } from '../worktree/gitExec.js';
import { BOT_GROUP_CLIENT_ID_PREFIX } from '../../shared/botGroupChat.js';
import { ensureBotGroupLaneSession } from '../localDb/ipc/bots.js';
import { restartBotRuntime } from './botRuntimeRestart.js';
import { registerBotLifecycleHandlers } from './botLifecycleService.js';
import { isSessionPermissionMode, persistPermissionModeWithoutRuntime } from './sessionPermissionPersistence.js';
import { withSessionPermissionChange } from './sessionPermissionChange.js';
import { updateBotRoutineLifecycle } from '../routines/service.js';
import {
  createBotCompactRuntimeRefreshCoordinator,
  prepareBotCapabilityEpochBeforeSend,
  refreshBotRuntimeAfterModelSelection,
  replaceBotRuntimeAfterPreflight,
  type BotCompactBoundary,
  type BotCompactRuntimeRefreshOutcome,
  type BotCompactRuntimeSession,
} from './botCompactRuntimeRefresh.js';
import {
  pruneWithdrawnWorkingMemoryForSession,
  pruneWorkingMemoryForSession,
} from './botWorkingMemory.js';
import { listBotRecallSessionIds } from '../localDb/botHistoryScope.js';
import { createWireNoteMemory } from './wireNoteMemory.js';
import { isBotCanonicalReplacementBusy } from './botCanonicalReplacementGuard.js';
import { configureBotCanonicalReplacementCoordinator } from './botCanonicalReplacementCoordinator.js';
import { botSessionInputBlockReason, isShadowedCompanionCanonical, SHADOWED_COMPANION_INPUT_MESSAGE } from './botSessionInputGuard.js';
import { configureBotRuntimeEpochRefreshRequest } from './botRuntimeEpochRefreshSignal.js';
import { createGitSnapshotCoordinator } from '../maker-host/git-snapshot-host.js';
import {
  cancelCodexAuthModeChange,
  ensureCodexMcpBridgeStartedForRemote,
  finalizeCodexAfterAuthModeChange,
  getMaker,
  handleRemoteWorkerBridge,
  listCodexGatewayHostKeys,
  refreshCodexGatewayHost,
  setCodexGatewayKeyRefreshHook,
  listSshCodexProviders,
  disposeRemoteCodexHostAfterRestart,
  getMakerIfReady,
  getPluginRegistry,
  isBotToolsetAvailable,
  listBotRuntimeMcpServers,
  preflightBotRuntimeResources,
  prepareCodexForAuthModeChange,
  prepareCodexForCustomProviderHostChange,
  restartCodexAfterAuthModeChange,
  setBeforeLocalCodexSessionStartHook,
  setBotCapabilityAgentKindResolver,
  setModelContextRuntimeRefreshListener,
  setAutoReviewContextResolver,
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
  getRemoteNewMakerDefaultsByVendor,
  getWorkerDefaultsFromNewMaker,
  getSelectedNewMakerRoute,
  getWorkerPermissionModeFromCreationPrefs,
  type ProviderModelMemorySnapshot,
  syncNewMakerDraftCache,
  setProviderModelMemoryCache,
  setThinkingEnabledInMemory,
  setWorkerCreationPrefsCache,
} from '../maker-host/newMakerDefaultsCache.js';
import {
  applyNewMakerWorktreeBranchPreference,
  getNewMakerWorktreeBranchPreference,
} from '../maker-host/newMakerWorktreeBranchPreferenceCache.js';
import {
  rehydrateCloseSuppression,
  withRehydrateCloseSuppressed,
} from '../maker-host/rehydrateCloseSuppression.js';
import { handleCloseSessionRequest } from './closeSessionRequest.js';
import {
  createOrcaIdleReleaseWatcher,
  ORCA_IDLE_RELEASE_STATUSES,
  type OrcaIdleReleaseWatcher,
} from './orcaIdleReleaseWatcher.js';
import { createOrcaWorkerResumeScheduler } from './orcaWorkerResumeScheduler.js';
import {
  ackSessionTurnEndedDurable,
  hasAssistantProgressAfterMessage,
  getRecoveryContextSnapshot,
  markSessionTurnEndedOnClose,
  markSessionTurnEndedAfterBarrier,
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
  readSessionWritableDirsFromDb,
  readSessionWorkingDirFromDb,
  readSessionWorkingDirRow,
  listVisibleActiveSessionDirectoryGrants,
} from '../maker-host/session-storage.js';
import { libraryExtraDirSyncTargets } from './libraryExtraDirSyncTargets.js';
import {
  captureDeferredTurnError,
  clearSessionPersistState,
  clearSessionThinkingSnapshots,
  consumeLastAssistantPersistId,
  consumeLastTopLevelAssistantPersistId,
  drainPersistQueue,
  enqueueDurableWrite,
  flushAssistantBlock,
  flushOrphanToolResults,
  getLastAssistantTranscriptUuid,
  getSessionDbAgentKind,
  getSessionTextSnapshot,
  markAssistantTurnFailed,
  noteSessionAgentKind,
  noteSessionClearBoundary,
  onInteractionMessage,
  onInteractionResolved,
  clearCodexPlanRowsForSession,
  sealAssistantBlockForLateFinal,
  markAutoResumeOutcome,
  onTurnErrorEvent,
  persistDeferredTurnError,
  prepareSyntheticToolEventForBroadcast,
  redactToolInputForUntrustedBoundary,
  resetTurnPersistState,
  saveTurnStartedAtForDeferred,
  type DeferredTurnErrorRow,
} from '../messagePersistBroadcaster.js';
import { ensureCcManagerInstalledOrInstall } from '../remote-ssh/cc-manager-install.js';
import {
  ensureRemoteCodexMcpBridge,
  hasPendingRemoteMcpDrift,
} from '../remote-ssh/codex-remote-mcp.js';
import {
  hasPendingAgentProxyReconcile,
  reconcileCodexAgentProxyEnv,
  setAgentProxyLiveTurnChecker,
} from '../remote-ssh/agent-proxy.js';
import {
  ensureRemoteAgentInstalledOrInstall,
  ensureRemoteHostReady,
  getRemoteSshPool,
  broadcastSilentInstallStatus,
  probeRemoteWorkingDirectory,
} from '../remote-ssh/index.js';
import { recordSessionContextSnapshot } from '../sessionSpendBroadcaster.js';

import { broadcastReferenceModelPricing } from '../usage/referenceModelPricing.js';
import {
  clearModelPriceOverride,
  stageProviderModelPriceOverridesClear,
  readModelPriceOverrideView,
  setModelPriceOverride,
} from '../usage/modelPriceOverrideStore.js';
import { ClaudeOutputLagTimingGuard, type ModelUsageCumulative } from '../usage/modelUsageDelta.js';

import { type RegionalMoney } from '../../shared/regionalMoney.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import {
  listPiRuntimePaletteCommands,
  mergePiPackageCommands,
  shouldListPiPackageCommands,
  type PiPackageMutationRequest,
} from '../../shared/piPackages.js';
import {
  listManagedPiPromptCommands,
  listPiPackages,
  mutatePiPackage,
  onPiPackagesChanged,
  piPackageMutationFailureCategory,
  piPackageMutationMayHaveChangedState,
  type PiPackageRuntimeInvalidationPhase,
} from '../maker-host/pi-package-store.js';
import {
  invalidateLocalPiPackageRuntimes,
  invalidateLocalPiPackageRuntimesForObservedChange,
} from '../maker-host/pi-package-runtime-invalidation.js';
import {
  issuePiPackageMutationGrant,
  piPackageMutationNeedsGrant,
} from '../maker-host/pi-package-mutation-grant.js';
import { onCodexAutoResetRestored, readXaiSubscriptionUsageSnapshotForDeviceLink, readClaudeSubscriptionUsageSnapshotForDeviceLink, readCodexAccountUsageSnapshotWithWebRefresh, readCodexRateLimitsForHost } from './usage.js';
import { requireEnum, requireObject, throwIpcError } from '../utils/ipcValidate.js';
import { applyPersistedCindyMakeMarker } from './cindyMakeSessionStart.js';
import { assertCindyMakeEnabled, assertCindyMakeSessionAvailable } from '../cindy-make/featureGate.js';
import { CINDY_MAKE_SESSION_SOURCE } from '../../shared/cindyMakeSession.js';
import { cindyMakeManager } from '../cindy-make/manager.js';
import { assertCindyMakeWorkspace, withCindyMakeProjectUse } from '../cindy-make/projectAccess.js';
import { isCindyMakeWorktreePath, isCindyMakeManagedWorktreePath } from '../cindy-make/sourcePaths.js';
import { assertCindyMakeTaskReady, configureCindyMakeTaskSender, CINDY_MAKE_TASK_DISPATCH } from '../cindy-make/taskRuntime.js';
import {
  finishUpstreamMergeTurn,
  interruptUpstreamMergeTurn,
  prepareUpstreamMergeTurn,
} from '../cindy-make/upstreamMergeRuntime.js';
import { isIpcError, type IpcErrorCode } from '../../shared/ipc-errors.js';
import { piPackageCommandDiagnostic } from '../maker-host/pi-package-diagnostic.js';
import {
  runPiPackageListIpcBoundary,
  runPiPackageMutationIpcBoundary,
} from './piPackageMutationIpc.js';
import { dbToMakerAgentKind, makerToDbAgentKind } from '../../shared/agentKindConversion.js';
import { readWorkflowProgressForSession } from '../workflow-progress/reader.js';
import { readSessionBackgroundTaskOutputTail } from '../background-task-output/reader.js';
import { AgentInputCoordinator } from './agent-input-coordinator.js';
import { bindSilentStopContinuationGeneration } from './silentStopContinuationBinding.js';
import { notePromptPredictionSessionStopped } from './promptPredictionStopLedger.js';
import {
  estimateReferenceTokens,
  MAX_REFERENCE_MESSAGES,
  MAX_REFERENCE_TOKENS,
  MAX_SESSION_REFERENCES,
  resolveSessionReferences,
} from './sessionReferenceResolver.js';
import { registerAndroidAutomationHandlers } from './androidHandlers.js';
import { MAKER_INVOKE, MAKER_PUSH, MAKER_SEND } from './channels.js';
import type { CollabDispatchOutcome } from './collabSendOutcome.js';
import {
  AcceptedCallbackDispatchCancelled,
  runAcceptedCallback,
} from './acceptedCallbackRunner.js';
import { GroupToolAuthorizationError } from './botGroupToolAuthorization.js';
import { createElectronIpcHandlerRegistry } from './electronIpcRegistry.js';
import { refreshCodexMcpEnvironment } from './codexMcpRefresh.js';

import {
  excludeDirectoryGrantConflictsWithSlots,
  extraDirsForRuntime,
  directoryGrantsForRuntime,
  libraryRootForRuntime,
  isLibraryExtraDirSlot,
  libraryExtraDirSlot,
  libraryRootFromSlot,
  splitExtraDirSlots,
  validateExtraDirs,
} from './extraDirsValidator.js';
import {
  applyRemoteDirectoryGrantUpdate,
  isPersistedDirectoryGrantSubset,
} from './remoteDirectoryGrantUpdate.js';
import { consumeWritableDirectoryPickerGrants } from './writableDirectoryPickerGrant.js';
import {
  prepareHandoffWorktree,
  shouldRecycleHandoffWorktreeOnFailure,
} from './handoffWorktree.js';
import { validateHandoffWorkingDir } from './handoffWorkingDir.js';
import { registerProjectPluginPolicyHandlers } from './projectPluginPolicyHandlers.js';
import { registerLocalModelHandlers } from '../local-model-runtime/ipc.js';
import { ensureManagedOllamaReadyForSession } from '../local-model-runtime/preflight.js';
import {
  TURN_CHANGE_SET_DETAIL_ID_LIMIT,
  TurnChangeSetActionError,
  applyTurnChangeSetAction,
  beginTurnChangeSet,
  clearPendingTurnChangeSets,
  finalizeTurnChangeSet,
  getTurnChangeSets,
  listTurnChangeSets,
  noteTurnDiffEvent,
  normalizeTurnChangeSetWorkspaceKey,
  waitForTurnChangeSetSeal,
} from '../turn-change-set/store.js';
import { registerPrecreatedWorktreeDiscardHandler } from './precreatedWorktreeDiscardHandler.js';
import { registerNewMakerWorktreePreferenceHandler } from './newMakerWorktreePreferenceHandler.js';
import { registerNewMakerWorktreeBranchPreferenceHandler } from './newMakerWorktreeBranchPreferenceHandler.js';
import {
  resolveFreshSourceBranch,
  getManagedWorktreeReadinessForSession,
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
import { resolveOrcaImageAttachmentInput } from './orcaImageAttachments.js';
import { OrcaWorkerPermissionConfirmBridge } from './orcaWorkerPermissionConfirmBridge.js';
import { assertTaskActionCurrent, hasTaskActionAuthorization, settleTaskActionInput, TaskActionAuthorizationError, type TaskActionDeliveryGuard } from './taskActionAuthorization.js';
import {
  getOrcaWorkspaceInfoReadOnly,
  getOrcaWorkerDiagnosticStatusReadOnly,
  readOrcaWorkerOutputReadOnly,
} from './orcaDiagnostics.js';
import { startOrcaTeamWithPermissionGate } from './orcaStartTeamPermissionGate.js';
import { createWorkerCreationPrefsSyncHandler } from './workerCreationPrefsSyncHandler.js';
import {
  containsManagedAttachment,
  createMakerSendTransaction,
  prepareDirectoryGrantsForBootstrap,
  stampTrustedDeviceLinkQueuedOrigin,
  stampTrustedDesktopQueuedOrigin,
  TRUSTED_DESKTOP_QUEUE_ORIGIN,
} from './makerSendTransaction.js';
import { createAgentPrewarmer, isAgentPrewarmEligible } from './agentPrewarm.js';
import { isProvisionalSession } from '../localDb/provisionalSessions.js';
import { findLatestAssistantTranscriptUuid } from './latestAssistantTranscriptUuid.js';
import {
  installDesktopInteractionHandler,
  installInteractionLifecycleObserver,
  noteInteractionRouteSteer,
} from './interactionRouter.js';
import { createSharedPermission, type SharedPermission } from './sharedPermission';
import { registerMakerMessageDeleteHandler } from './messageDeleteHandler.js';
import {
  cleanupOrphanedTempAttachments,
  cleanupSessionTempAttachments,
  configureTempAttachmentOwner,
  normalizeUserMessage,
  materializeDirectSendOssAttachments,
  materializeQueuedOssAttachmentsDeferred,
  collectQueuedAttachmentRefs,
} from './normalizeAttachments.js';
import { QueuedAttachmentOwnershipRegistry } from './queuedAttachmentOwnership.js';
import { prepareRemoteReviewAttachments } from './reviewRemoteInput.js';
import { getAgentIslandService } from '../agent-island/service.js';
import { createOrcaLifecycleService, ORCA_WORKER_READY_MESSAGE } from './orcaLifecycleService.js';
import { buildUiAssignmentInitialTask } from './orcaUiAssignment.js';
import {
  createOrcaUiAssignmentDispatchClaims,
  createOrcaUiAssignmentHistoryGate,
} from './orcaUiAssignmentHistoryGate.js';
import { orcaModelDiscoveryFailure, throwOrcaServiceFailure } from './orcaServiceFailure.js';
import {
  createOrcaTeamService,
  captureOrcaDeliveryBaselines,
  evaluateOrcaDeliveryScope,
  findFocusTargetWorker,
  type InterruptWorkerResult,
  type ListWorkerQueuedMessagesResult,
  type MergeWorkerQueuedMessagesResult,
  type MoveWorkerQueuedMessageResult,
  type OrcaTeamService,
  type OrcaWorkerEffort,
  type SendToWorkerResult,
  type SteerWorkerQueuedMessageResult,
  type WorkerQueuedMessageControlResult,
  type WorkerTerminalTurnCapture,
} from './orcaTeamService.js';
import {
  agentDeviceCatalogFailure,
  createOrcaWorkerCreationService,
  normalizeOrcaWorkerLabel,
  pickWorkerAgentDeviceId,
} from './orcaWorkerCreationService.js';
import {
  resolveSendToSessionExecutionConfig,
  type SendToSessionExecutionOverrides,
} from './sendToSessionExecutionConfig.js';
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
  restoreManualInterrupt,
} from './orcaManualInterrupt.js';
import { tryInjectProjectContext } from './projectContextInject.js';
import { registerMakerSessionCreateHandler } from './sessionCreateHandler.js';
import {
  createOrcaRemoteWorkerHost,
  createOrcaRemoteWorkerSessionOpener,
  registerOrcaRemoteWorkerHandlers,
} from './orcaRemoteWorkerHost.js';
import { createOrcaRemoteWorkers, invokeDeviceValue, isExecutionDeviceCandidate, type OrcaRemoteWorkers } from './orcaRemoteWorkers.js';
import { getReceivedShares, providerShareAgentDeviceId } from '../device-link/providerShareGuest.js';
import {
  ORCA_EXECUTION_DEVICES_CHANNEL,
  ORCA_REMOTE_WORKER_BRIDGE_CHANNEL,
  COMPANION_CLOUD_CAPS_CHANNEL,
  COMPANION_CLOUD_FLUSH_CHANNEL,
  COMPANION_CLOUD_HAND_OVER_CHANNEL,
  COMPANION_CLOUD_MERGE_CHANNEL,
  COMPANION_CLOUD_RECEIVE_VERSION,
  COMPANION_CLOUD_TARGETS_CHANNEL,
  COMPANION_CLOUD_VERSION,
  companionCloudCapsVersion,
  parseCompanionCloudRemoteActionResult,
  parseCompanionCloudRemoteTargets,
} from '@cindy/device-link';
import { INPUT_HANDOFF_LOCAL_CHANNEL, INPUT_HANDOFF_LOCAL_PICTURE_CHANNEL, type InputHandoffHolder, type InputHandoffSnapshot } from '@cindy/device-link';
import { getInputHandoffService, initInputHandoffService } from '../input-handoff/service.js';
import { closeInputHandoffAskpass, initInputHandoffAskpass } from '../input-handoff/askpass/index.js';
import { onQuit } from '../lifecycle.js';
import { isInputHandoffDisabledForSession } from '../input-handoff/botPolicy.js';
import { createMacHandoffDriver } from '../input-handoff/macDriver.js';
import { supportsRemotePluginOauth } from '../plugin-oauth/runtime.js';
import {
  parseOrcaRemoteLead,
  serializeOrcaRemoteLead,
  type OrcaRemoteLead,
} from '../../shared/orcaRemoteWorker.js';
import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  isUserPendingAgentSwitchIntent,
  performSessionAgentSwitch,
  projectPendingAgentSwitchIntent,
  registerMakerSessionAgentSwitchHandler,
  relocateForFreshStart,
  settleSystemRouteSwitchIntent,
  type MakerSessionAgentSwitchHandlerDeps,
  type PendingAgentSwitchIntent,
} from './sessionAgentSwitchHandler.js';
import { pendingHarnessRuntimeMutation, setSessionRuntimeHarness } from './sessionRuntimeHarnessSelection.js';
import {
  COMPANION_SESSION_IDS_LIMIT,
  extractPlainText,
  prependNoteToWireUserMessage,
  prependHandoffToUserMessage,
  type HandoffWireMessage,
} from './agentHandoff.js';
import { sanitizeSourceName } from '@cindy/maker-shared/message-source';
import { registerSessionHandoffIpc } from './sessionHandoffIpc.js';
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';
import {
  createContextOverflowRollover,
  canContinueContextRecovery,
  hasModelWindowContextToProtect,
  isContextOverflowErrorData,
  isOversizedHistoryErrorData,
  isPiPromptRpcTimeoutError,
  lookupVerifiedContextWindow,
  persistedUserContentToWireMessage,
  type ModelWindowSwitchPreparationResult,
} from './contextOverflowRollover.js';
import {
  classifyCodexHistoryOversized,
  reserveCodexForkCleanup,
} from '../maker-host/codex-local-sessions.js';
import {
  readPiNativeCompatOverride,
  recordPiNativeCompatOverride,
} from '../maker-host/pi-native-compat-overrides-store.js';
import { readCodexThreadStorageReadOnly } from '../maker-host/codex-thread-storage.js';
import { hydrateQueuedAgentReferences } from './agentInputReferences.js';
import { agentHandoffPending } from './agentHandoffPendingSingleton.js';
import {
  getSessionLastLiveUsage,
  rememberSessionLastLiveUsage,
} from './sessionLastLiveUsage.js';
import { clearSealedCodexPlanState, readCodexPlanState } from '../localDb/codexPlanState.js';
import { buildCompletedPlanGuardNote, buildPlanReconcileNote } from './planReconcile.js';
import { peekGoalInactiveNote } from '../goal-host/inactiveNote.js';
import { readReplyQuoteNote, REPLY_QUOTE_SOURCE_CONTENT } from './chatReplyQuoteNote.js';
import { readBotDmThreadContextNote } from './botDmThreadContext.js';
import { readTurnUsageResetAt } from '../goal-host/usageLimit.js';
import {
  readAccountUsageLimit,
  readRemoteAccountUsageLimit,
  claudeAccountUsageLimit,
  codexAccountUsageLimit,
  sessionUsesOtherMachineAccount,
  subscriptionFamilyOf,
  xaiAccountUsageLimit,
} from '../usage/accountUsageLimit.js';
import { UsageLimitAutoResume } from './usageLimitAutoResume.js';
import { createUsageLimitRecoveryStore, type SavedUsageLimitWait } from './usageLimitRecoveryStore.js';
import { type MakerSessionCreateOpts, withCreateSessionStderr } from './sessionRequest.js';
import { persistAndHydrateSessionProvider } from './sessionProviderBootstrap.js';
import { registerMakerSessionSendHandler } from './sessionSendHandler.js';
import {
  registerReviewStartHandler,
  ReviewPreconditionError,
  type ReviewFailureReason,
} from './reviewStartHandler.js';
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
  deviceAvailableModels,
  deviceWorkerRoutingContext,
  readOrcaWorkerProviderRoutingContext,
  sshCodexWorkerRoutingContext,
} from './orcaProviderRoutingContext.js';
import {
  clearSessionProvider,
  getSessionProvider,
  hasSessionProvider,
  hydrateSessionProvider,
  normalizeSessionProviderId,
  setSessionProvider,
} from '../maker-host/session-provider-store.js';
import { getActiveCatalog, setDiscoveredProviderModels } from '../maker-host/active-catalog.js';
import { createSubscriptionFastPolicy } from '../maker-host/subscription-fast-policy.js';
import { readCompactionPct } from '../maker-host/compaction-settings-store.js';
import { resolveVerifiedContextWindow, resolveModelDefaultContextWindow } from '../maker-host/catalog-to-descriptors.js';
import {
  isModelContextLimitCustomized,
  readModelContextLimit,
  writeModelContextLimitsWithRefresh,
} from '../maker-host/model-context-limit-store.js';
import { refreshAnthropicModelsFromProbe } from '../maker-host/model-discovery/anthropic.js';
import { refreshOpenAiMediaModels } from '../maker-host/model-discovery/openai-media.js';
import { refreshXaiMediaModels } from '../maker-host/model-discovery/xai-media.js';
import { testProviderConnection } from '../maker-host/provider-diagnostics.js';
import { fetchProviderModels, fetchSavedOAuthProviderModels } from '../maker-host/provider-model-fetch.js';
import {
  beginProviderRouteMutation,
  setPendingCredentialSwitchReader,
} from '../maker-host/provider-route.js';
import { refreshXaiModelsFromHttp } from '../maker-host/model-discovery/xai.js';
import { refreshBuiltinProviderModels, refreshModelsWithCatalog } from '../maker-host/provider-model-refresh.js';
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
  revokeCodexAccountUltrafast,
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
import { reportCindyGatewayKeyRejectedForCurrentKey } from '../model-access/gatewayKeyRejection.js';
import { isGatewayProxyTokenRecoveryErrorEventForProvider } from './gatewayProxyTokenRecovery.js';
import {
  getSessionEffort,
  getSessionFastMode,
  setSessionEffort,
  setSessionFastMode,
} from '../maker-host/session-effort-store.js';
import { readSessionRuntimeFallbackSettings } from '../maker-host/session-runtime-fallback-store.js';
import {
  getModelVisibilityMirrorSnapshot,
  syncModelVisibilityMirrorForOwner,
  waitForModelVisibilityMirror,
} from '../maker-host/model-visibility-mirror.js';
import {
  clearProviderDisableOverrides,
  setModelsDisabled,
  setProviderDisabled,
  stageProviderDisableOverridesClear,
} from '../maker-host/model-disable-store.js';
import { readProviderOrder, setProviderOrder } from '../maker-host/provider-order-store.js';
import {
  describeModelRouteRejection,
  resolveCurrentSetModelProviderId,
  resolveExclusiveSetModelReroute,
  resolveSetModelGuardProviderId,
} from '../maker-host/model-route-guard.js';
import {
  pinExclusiveSessionProvider,
  resolveLenientSessionRoute,
  resolveScheduledModelSelectionLive,
  shouldApplyExclusiveProviderRerouteLive,
  verdictForModelRoute,
} from '../maker-host/model-route-guard-live.js';
import {
  setClaudeProxyOwnerBoundaryPendingChecker,
  setClaudeProxyOwnerScopeKeyReader,
  setClaudeProxySessionIdResolver,
} from '../maker-host/anthropic-compat-proxy-host.js';
import {
  clearClaudeSessionBackgroundActivity,
  getClaudeSessionBackgroundActivity,
  listActiveClaudeBackgroundActivitySessions,
  noteClaudeSessionTurnState,
  setClaudeBackgroundActivityBroadcaster,
} from '../maker-host/claude-session-background-activity.js';

import { setLiveCcSessionBridge } from '../maker-host/claude-transcript-relocation.js';
import {
  CredentialModeSwitchBusyError,
  isCredentialModeSwitchBusyError,
  isLocalSessionBusy,
} from '../maker-host/codex-credential-switch.js';
import {
  applyRuntimeSetModelChange,
  refreshActiveModelContextSettings,
  closeRejectedRuntimeAndRestoreControlStores,
  isRemoteModelSwitchRouteChangeError,
} from './runtimeSetModel.js';
import { codexThreadTransferSourcePredicate, commitCodexThreadTransfer, relinkCodexProviderThread } from './codexProviderThreadRelink.js';
import {
  codexCustomProviderConfigSignature,
  hasCodexAppliedCustomProviderCapability,
} from '../maker-host/codex-custom-provider-route.js';
import {
  applyRuntimeSelectionAxesWithRecovery,
  commitRuntimeAxisAfterPersistence,
  isSupportedRuntimeEffort,
  resolveRetainedRuntimeEffort,
} from './runtimeSelectionAxes.js';
import { runSchedulerQueuedPreparation } from './schedulerQueuedPreparation.js';
import {
  acceptSessionRuntimeAxisMutation,
  acceptSessionRuntimeMutation,
  cancelPendingSessionRuntimeMutation,
  captureSessionRuntimeControlOwnerEpoch,
  clearSessionRuntimeControlState,
  deferSessionRuntimeAxisMutation,
  getPendingSessionRuntimeMutation,
  getSessionRuntimeControlSnapshot,
  projectSessionRuntimeControl,
  isPendingSessionRuntimeRouteExplicit,
  mergeSessionRuntimeProfilePatch,
  pickSessionRuntimeFallback,
  recordFailedSessionRuntimeFallbackCandidate,
  recordRecoveredSessionRuntimeMutation,
  recordRecoveredSessionRuntimeAxisMutation,
  recordUserSessionRuntimeAxisMutation,
  recordUserSessionRuntimeMutation,
  resolveCompatibleSessionRuntimeEffort,
  resolveCompatibleSessionRuntimeAxisPatch,
  resolveSessionRuntimeAxes,
  resolveSessionRuntimeRefreshEffort,
  sessionRuntimeGenerationMatches,
  sessionRuntimeControlOwnerEpochMatches,
  settlePendingSessionRuntimeMutation,
  type SessionRuntimeMutationSource,
  type SessionRuntimeAxisPatch,
  type SessionRuntimeProfile,
} from './sessionRuntimeControl.js';
import { applyRuntimeEffortWithRecovery } from './runtimeSetEffort.js';
import { normalizeDeviceLinkSetModelWireArgs } from './setModelWireArgs.js';
import { PendingCredentialSwitchService, type PendingCredentialSwitchDeps } from './pendingCredentialSwitch.js';
import {
  DeferredCodexRestartService,
  runMemoryChangeWithCodexRestart,
  type MemoryChangeParts,
} from './deferredCodexRestart.js';
import { GatewayCodexRestartService } from './gatewayCodexRestart.js';
import {
  createDeferredRestartSettledWake,
  createDeferredRestartQueueGate,
} from './deferredRestartQueueWiring.js';
import {
  hasAnySessionInTurn,
  collectInTurnSessionIds,
  isSessionTurnDispatchBoundaryBusy,
  isTerminalTurnErrorEvent,
  SessionTurnActivityTracker,
} from './sessionTurnActivityTracker.js';
import { SilentStopTurnLeaseGate, SessionTurnLeaseTracker } from './sessionTurnLease.js';
import { ProductTurnUsageTargetTracker, ProductTurnWallClockTracker } from './turnWallClock.js';
import { resolveClearSessionBoundary } from './clearSessionBoundary.js';
import {
  assertAgentCommandListIpcCaller,
  toAgentCommandListFailure,
} from './agentCommandListIpcBoundary.js';
import {
  assertAgentSkillListIpcCaller,
  toAgentSkillListFailure,
} from './agentSkillListIpcBoundary.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
} from '../device-link/broadcast-tap.js';
import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast.js';
import { setBusyProbe as setDeviceLinkBusyProbe } from '../device-link/index.js';
import {
  markRemoteSettingPersistedInsideHandler,
  setSessionTextSnapshotReader,
  setRemoteTurnChangeAction,
  setRemoteReviewInputGuard as setDeviceLinkRemoteReviewInputGuard,
  setRemoteWorkingDirGuard as setDeviceLinkRemoteWorkingDirGuard,
  setRemoteSettingsPersist as setDeviceLinkRemoteSettingsPersist,
  setRemoteXaiSubscriptionUsageReader as setDeviceLinkRemoteXaiSubscriptionUsageReader,
  setRemoteClaudeSubscriptionUsageReader as setDeviceLinkRemoteClaudeSubscriptionUsageReader,
} from '../device-link/dispatch.js';
import {
  deviceLinkInvokeControllerSupports,
  getDeviceLinkInvokeContext,
  isDeviceLinkInvoke,
  isMobileControllerInvoke,
  readDeviceLinkInvokeSourceDevice,
  runOutsideDeviceLinkInvokeContext,
} from '../device-link/invoke-context.js';
import { beginRemoteSendTrace } from '../device-link/remoteSendTrace.js';
import { stampSharedTaskInput } from './sharedTaskInput.js';
import { createSharedTaskContextUsageGuard } from './sharedTaskContextUsage.js';
import { createSharedTaskSettingGuard } from './sharedTaskSetting.js';
import { assertSharedTaskInteractionResolveCurrent, isSessionSharedTaskActive, setSharedTaskInteractionReader, setSharedTaskQueueReader } from '../device-link/sharedTaskDispatch.js';

function captureSharedTaskSettingGuard(sessionId: string) {
  const context = getDeviceLinkInvokeContext();
  return createSharedTaskSettingGuard(context?.sharedTask, sessionId, context?.sharedTaskSetting ?? { admitted: false });
}
import {
  attachMainOwnedInputBoundary,
  buildClientEnvironmentNote,
  shouldPrependMobileClientPromptNote,
  stampDirectSendSourceDevice,
  stripMainOnlySendOpts,
  stampMobileClientOrigin,
  type MainOwnedInputBoundaryStamp,
} from './mobileClientPromptNote.js';
import { buildWireMessageSourceNote, readWireSourceDevice } from './messageSourceNote.js';
import { SIDE_CHAT_CONTEXT } from './sideChatContext.js';
import { getResolvedMainLocale } from '../i18n.js';
import {
  buildUiLanguageErrorNote,
  readClaimedUiLanguage,
  stampTurnUiLanguage,
  turnUiLanguageFromSendOpts,
} from './uiLanguageErrorNote.js';
import {
  assertResolveInteractionOrigin,
  isPluginSetupInteractionDecision,
} from './interactionResolveOrigin.js';
import { checkRemoteWorkingDir } from '../device-link/remote-workdir-guard.js';
import { assertReviewSessionExternalInputAllowed } from '../reviewer/reviewSessionInputPolicy.js';
import { createWorkerTurnStartSequencer } from './workerTurnStartSequencer.js';
import { createBusinessSessionId } from '../sessionIds.js';
import { forkSessionAtMessage } from '../maker-orchestration/fork.js';
import {
  isSessionAutoTitleEligible,
  registerSessionAutoTitleHooks,
  scheduleSessionAutoTitle,
} from './sessionAutoTitle.js';
import { SILENT_STOP_RESUME_PROMPT, SilentStopAutoResumeGuard } from './silentStopAutoResume.js';
import {
  publishUiContinuation,
  publishUiSessionIntervention,
  publishUiTurnDispatching,
  publishUiTurnUndispatched,
} from './uiContinuationSignal.js';
import { channelTurnSourceFor, noteChannelTurnSource } from './channelTurnSignal.js';
import { readSilentStopAutoResumeSettings } from '../maker-host/silent-stop-auto-resume-store.js';
import {
  AutoResumeBookkeeping,
  type OrcaSuppressedTerminal,
  type SuppressedTurnError,
  type SuppressedTurnErrorOwner,
} from './autoResumeBookkeeping.js';
import {
  InterruptedTurnAutoResumeGuard,
  isAcceptedTurnContinuationOnlyReason,
  isInterruptedTurnError,
  shouldPreserveWaitingContinuationOnlyAutoResume,
  shouldPreserveRuntimeFallbackAutoResume,
  type InterruptedTurnErrorSignals,
} from './interruptedTurnAutoResume.js';
import { readInterruptedTurnAutoResumeSettings } from '../maker-host/interrupted-turn-auto-resume-store.js';
import {
  isBotCandidateUnavailable,
  canResumeAfterRuntimeFallback,
  type RuntimeFallbackResult,
} from './botCandidateRecovery.js';

import {
  broadcastGhostMessageBlocked,
  broadcastGhostMessageRewritten,
  createGhostSessionTap,
  getGhostFsSlot,
  hasEnabledUserMessageHookGhost,
  screenGhostUserMessage,
  setGhostAgentTurnRunner,
  setGhostSessionRevealer,
  setGhostErrandRunner,
  setGhostWorkspaceSessionService,
  setGhostLibraryExtraDirSync,
  getFocusedGhostSessionId,
  notifyGhostSessionEvent,
  getInstalledGhostName,
} from '../cindy-brain/index.js';
import {
  readPluginTaskConfig,
  clampPluginTaskPermissionMode,
  setPluginTaskConfigValidator,
  writePluginTaskConfig,
  readGhostErrandSessionId,
  writeGhostErrandSessionId,
} from '../cindy-brain/pluginTaskPrefsStore.js';
import { isGhostPickedDir } from '../cindy-brain/pickGrantsStore.js';
import {
  resolveGhostUserHookModel,
  withGhostUserHookModel,
} from '../cindy-brain/subscriptionGateway.js';
import { createSessionExecutionResolver, resolveSessionExecutionSelection } from './sessionExecutionSelection.js';
import { createGhostErrandRunner } from './ghostErrandRunner.js';
import {
  createPluginTaskSession,
  createPluginDraftSession,
  findActiveSessionByWorkdir,
} from '../localDb/ipc/pluginWorkspaceSessions.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { openMainWindowSession } from '../deepLink.js';
import { handleSessionEvent, type SessionEventDependencies } from './sessionEventPipeline.js';
import {
  createDeferredProductTurnFailureGate,
  type ProductTurnFailureOwner,
} from './productTurnFailureOwner.js';
import { installSessionTurnObserver } from './sessionTurnObserver.js';

const log = createLogger('maker-ipc');
const workdirLog = createLogger('workdir-diagnostics');
const {findSimilarDirOnDisk,emitWorkDirMissingError}=createWorkingDirectoryDiagnostics({findSimilarWorkingDirectory:(...args)=>findSimilarWorkingDirectory(...args),log,broadcastToAllWindows:(...args)=>broadcastToAllWindows(...args)});

const workingDirectoryRecovery = createWorkingDirectoryRecovery({ stat: statWorkingDirectory, mkdir: mkdirWorkingDirectory, realpath: realpathWorkingDirectory, requiredRoot: requiredDialogueRecoveryRoot, findFallback: findDialogueRecoveryWorkspace }, allocateDialogueRecoveryWorkspace, workdirLog);

function localModelWindowSwitchErrorCode(code: IpcErrorCode): IpcErrorCode {
  return isDeviceLinkInvoke() ? 'PRECONDITION_FAILED' : code;
}

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
// session event wiring 是模块级函数；service 在 registerMakerIpc 内构造后注入给事件回调。
let orcaTeamServiceForEvents: OrcaTeamService | null = null;
// 协同远端 Worker 的宿主装配；bootstrapSession 据此拒绝在本机启动远端 Worker 的代理任务。
let orcaRemoteWorkersForHost: OrcaRemoteWorkers | null = null;
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
  isEnabled: () =>
    readInterruptedTurnAutoResumeSettings().enabled || readSessionRuntimeFallbackSettings().enabled,
  log: {
    debug: (message, meta) => log.debug(message, meta),
    warn: (message, meta) => log.warn(message, meta),
  },
});
let settlePendingSessionRuntimeControlHolder: ((sessionId: string, reason: string) => void) | null =
  null;

/**
 * 目标模式是否在管这个会话(active / usageLimited 时由 goal-host 自己等额度重置)。
 * setter 注入避免 register↔goal-host 环;bootstrap 接上 GoalController。
 */
let goalOwnsUsageLimitProbe: ((sessionId: string) => Promise<boolean>) | null = null;
export function setGoalOwnsUsageLimitProbe(
  probe: ((sessionId: string) => Promise<boolean>) | null,
): void {
  goalOwnsUsageLimitProbe = probe;
}

/**
 * 会话当前实际在跑的来源与模型:临时切换(set_session_runtime)或自动降级的运行时覆盖优先,
 * 否则用会话保存的选择。分模型额度必须按实际运行的模型匹配。
 */
export function resolveSessionRuntimeRoute(
  sessionId: string,
  agentKind: string,
  saved: { providerId?: string | null; model?: string | null } | null,
): { providerId: string | null; modelId: string | null } {
  const override = getSessionRuntimeControlSnapshot(sessionId).effectiveOverride;
  if (override && override.agentKind === agentKind) {
    return { providerId: override.providerId ?? null, modelId: override.model ?? null };
  }
  return {
    providerId: getSessionProvider(sessionId) ?? saved?.providerId ?? null,
    modelId: saved?.model ?? null,
  };
}

/**
 * 会话所用账号的重置时刻:结构化错误 → 实际账号的用量窗口 → 报错原文。
 * 只服务订阅账号:API key / Coding Plan / 网关等来源的普通 429 即使带 Retry-After,也不是
 * 周期额度耗尽,按产品规则只报错不等待。
 */
const usageLimitWaitHost=createUsageLimitWaitHost({
 coordinator:()=>agentInputCoordinatorHolder,getSessionRowSnapshot:(...args)=>getSessionRowSnapshot(...args),getDbClient:()=>getDbClient(),log,
 activeOwnerScopeKey:()=>activeOwnerScopeKey(),ownerScopedUserDataPath:(...args)=>ownerScopedUserDataPath(...args),isPassive:()=>!app.isPackaged&&process.env.XDT_SCHEDULER_PASSIVE==='1',
 isSessionSharedTaskActive:id=>isSessionSharedTaskActive(id),goalOwnsUsageLimitProbe:id=>goalOwnsUsageLimitProbe?.(id)??Promise.resolve(false),resolveSessionRuntimeRoute:(...args)=>resolveSessionRuntimeRoute(...args),
 limits:{subscriptionFamilyOf:(...args)=>subscriptionFamilyOf(...args),sessionUsesOtherMachineAccount:(...args)=>sessionUsesOtherMachineAccount(...args),readRemoteAccountUsageLimit:(...args)=>readRemoteAccountUsageLimit(...args),readAccountUsageLimit:(...args)=>readAccountUsageLimit(...args),codexAccountUsageLimit:(...args)=>codexAccountUsageLimit(...args),xaiAccountUsageLimit:(...args)=>xaiAccountUsageLimit(...args)},
 remoteBackgroundInvoke:(...args)=>remoteBackgroundInvoke(...args),readClaudeSubscriptionUsageSnapshotForDeviceLink:(...args)=>readClaudeSubscriptionUsageSnapshotForDeviceLink(...args),readCodexAccountUsageSnapshotWithWebRefresh:(...args)=>readCodexAccountUsageSnapshotWithWebRefresh(...args),
 beforeContinue: (id, token) => schedulerRecoveryBridge.beforeContinue(id, token),});
const {usageLimitAutoResume,isAutomaticContinueEligible,isUsageLimitAutoResumeEligible,isProviderGroupFailoverEligible,resolveSessionUsageResetAt,suspendUsageLimitWaits,flushUsageLimitWaits,reconcileScheduledUsageLimitWaits,findSchedulerUsageLimitWait,restoreSavedUsageLimitWait,restoreUsageLimitWaits}=usageLimitWaitHost;
export {suspendUsageLimitWaits,flushUsageLimitWaits,reconcileScheduledUsageLimitWaits,findSchedulerUsageLimitWait,restoreUsageLimitWaits};
/** Used by ordinary and goal waits; never substitutes this computer's quota for an SSH/remote agent. */
export const hasRestoredCodexQuota=usageLimitWaitHost.hasRestoredCodexQuota;

onCodexAutoResetRestored(providerId => usageLimitAutoResume.resumeRestored(id => hasRestoredCodexQuota(id, providerId)));

// Schedule 不另建重试状态机：真正的恢复仍由 AgentInputCoordinator +
// AutoResumeBookkeeping 独占。这里仅把「这一轮 scheduler run 已被普通自动续跑接管」
// 和「最终仍失败」桥给 runner，让同一个 run 继续等待或正确失败。
const schedulerRecoveryBridge = createSchedulerRecoveryBridge({
 coordinator: () => agentInputCoordinatorHolder, bookkeeping: () => autoResumeBookkeeping, usageLimit: () => usageLimitAutoResume,
});
const { pendingSchedulerAutoResumeRunBySession, schedulerAutoResumeFailureListeners, schedulerAutoResumeRunKey, beginSchedulerAutoResume, clearSchedulerAutoResumePending, notifySchedulerAutoResumeFailed, failPendingSchedulerAutoResume, finishSchedulerUsageLimitWait } = schedulerRecoveryBridge;
export const { isSchedulerAutoResumePending, onSchedulerAutoResumeFailed, cancelSchedulerAutoResume } = schedulerRecoveryBridge;

/**
 * 先压住的 Orca Worker 终态(自愈或供应商组换电脑期间)最终确定不救时，用当初的 capture 恰好一次收口
 * Worker 状态与 auto-bridge(把异常终止回报给 Lead)。
 */
function settleDeferredOrcaWorkerTerminal(sessionId: string, payload: OrcaSuppressedTerminal): void {
  void (async () => {
    try {
      await workerTurnStartSequencer.waitForStart(sessionId);
      await orcaTeamServiceForEvents?.handleWorkerTerminalTurn({
        sessionId,
        status: payload.status,
        finalText: payload.finalText,
        diagnostic: payload.diagnostic,
        capture: payload.capture as WorkerTerminalTurnCapture | undefined,
      });
    } catch {
      /* non-fatal */
    }
  })();
}

/** 恢复最终放出失败时，按原终态的 Session/代次结算产品调用，不得中断替换后的新一轮。 */
function settleDeferredProductTurnFailure(sessionId: string): void {
  deferredProductTurnFailureGate.settle(
    sessionId,
    isCurrentProductTurnFailureOwner,
    (owner) => {
      void interruptProductTurn(sessionId, owner).catch(() =>
        log.warn('Could not interrupt product turn follow-up'));
    },
  );
}

function settleDeferredBotGroupTerminal(terminal: BotGroupLaneTerminal): void {
  if (!botGroupChatServiceHolder) return;
  void settleBotGroupLaneTerminal(botGroupChatServiceHolder, terminal, drainPersistQueue).catch(() =>
    log.warn('Bot group recovery failure settlement failed'));
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
  surfaceSuppressedError: (sessionId, detail) => {
    surfaceSuppressedAutoResumeErrorInAgentIsland(sessionId, detail);
    settleDeferredProductTurnFailure(sessionId);
  },
  // L3：auto-resume 放弃后，用当初压住的 capture 恰好一次收口 Orca status / auto-bridge。
  // L2 flush/discard 不会走到这里，避免「还在重试却已经把异常终止桥给 Lead」。
  finalizeOrcaSuppressedTerminal: settleDeferredOrcaWorkerTerminal,
  finalizeBotGroupSuppressedTerminal: settleDeferredBotGroupTerminal,
  markOutcome: (sessionId, clientId, outcome) => {
    void markAutoResumeOutcome(sessionId, clientId, outcome);
  },
  rollbackGuardPendingResume: (sessionId, attemptToken) => {
    if (typeof attemptToken === 'number') {
      interruptedTurnAutoResumeGuard.noteResumeSendFailed(sessionId, attemptToken);
    }
  },
  // holder 是可变绑定,必须懒读(模块初始化时 coordinator 还没建)。
  abandonTakeover: (sessionId, message, attemptToken) =>
    agentInputCoordinatorHolder?.abandonAutoResume(sessionId, message, attemptToken),
  onAutoResumeFailed: (sessionId, attemptToken) =>
    failPendingSchedulerAutoResume(sessionId, attemptToken),
  log: (message, fields) => log.debug(message, fields),
});

/**
 * 供应商组自动换电脑期间先不呈现的那次失败(provider-group/heldTurnErrors.ts)：error 行暂存在这里，换成了丢掉，
 * 没换成补落并放出横幅与 Agent Island 提醒。
 */
const providerGroupHeldErrors = createProviderGroupHeldTurnErrors<DeferredTurnErrorRow>({
  // 暂存那一刻(仍在失败那一轮里)取好补落要用的一切；补落只写这一行，不碰那时正在进行的一轮，
  // 按出错的时刻排序：换电脑途中用户发了新消息，补落的错误卡仍排在那条消息之前。
  capture: (sessionId, data, agentMeta) =>
    captureDeferredTurnError(
      sessionId,
      data as { message?: unknown; reason?: unknown; sdkError?: unknown; toolLoop?: unknown } | null,
      (agentMeta ?? null) as AgentMeta | null,
    ),
  persist: (sessionId, row) => {
    persistDeferredTurnError(sessionId, row);
  },
  surface: (sessionId, detail) => surfaceSuppressedAutoResumeErrorInAgentIsland(sessionId, detail),
  settleFailure: settleDeferredProductTurnFailure,
  // holder 是可变绑定,必须懒读。
  releaseHold: (sessionId, holdId) =>
    agentInputCoordinatorHolder?.releaseProviderGroupSwitchHold(sessionId, holdId) ?? false,
  ownerKey: () => activeOwnerScopeKey(),
  log: (message, meta) => log.info(message, meta),
});

/**
 * 协同 Worker 在换电脑期间先不回报给 Lead 的那次终态(provider-group/heldWorkerTerminals.ts)：换成了丢掉，由续跑那一轮
 * 照常回报结果；没换成才把这次异常终止回报给 Lead。群专线的终态也沿用同一次登记结算，
 * 避免异步资格检查拒绝接管后群轮次一直等待。与 providerGroupHeldErrors 按同一次登记结算。
 */
const providerGroupHeldTerminals = createProviderGroupHeldWorkerTerminals<{
  orcaTerminal: OrcaSuppressedTerminal | null;
  groupTerminal: BotGroupLaneTerminal | null;
}>({
  deliver: (sessionId, terminal) => {
    if (terminal.orcaTerminal) settleDeferredOrcaWorkerTerminal(sessionId, terminal.orcaTerminal);
    if (terminal.groupTerminal) settleDeferredBotGroupTerminal(terminal.groupTerminal);
  },
  ownerKey: () => activeOwnerScopeKey(),
  log: (message, meta) => log.info(message, meta),
});

/** Queued handoffs keep their original product/Worker receipts until vendor dispatch. */
const {
  discard: discardProviderGroupHeld,
  release: releaseProviderGroupHeld,
  settleContinuation: settleProviderGroupContinuation,
  hasPendingContinuation: hasPendingProviderGroupContinuation,
} = createProviderGroupHeldRecovery({
  errors: providerGroupHeldErrors,
  terminals: providerGroupHeldTerminals,
  settleFailure: settleDeferredProductTurnFailure,
  ownerKey: () => activeOwnerScopeKey(),
});

/** 换电脑这一趟久久没有结局(交接卡住等)时不再瞒着：先把错误放出来，换成了照常续跑。 */
const PROVIDER_GROUP_SWITCH_HOLD_MAX_MS = 3 * 60_000;

/**
 * Continuation-only auto-retry is scheduled against the current runtime
 * Session, but stall abort recovery, terminal-error drain, or a Codex
 * interrupt ACK failure may close/rebuild that exact instance before the
 * backoff timer fires. Bind the lease to the instance, not only sessionId:
 * a replacement Session can otherwise inherit a late close callback.
 *
 * Only `unexpected` closes preserve the lease. User-requested close/stop
 * still cancel via teardown.
 */
const pendingContinuationOnlyAutoResumeRebuilds = new WeakMap<Session, number>();
const pendingSessionRuntimeFallbackRebuilds = new WeakMap<Session, number>();

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
  deferredProductTurnFailureGate.clearSession(sessionId);
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

/** 统一明确停止的实现(coordinator 就绪后由注册流程装上)。 */
let explicitStopImpl: ((sessionId: string) => Promise<void>) | null = null;

/**
 * 用户明确喊停的统一入口 —— 与桌面 Stop 同一套清理, 顺序固定:
 *   1. 撤自动续跑与退避簿记(resetAutomaticRecoveryForExplicitStop);
 *   2. 取消上下文溢出恢复;
 *   3. 发起 Goal 暂停(同步摘掉 listener / timer, 落盘与中止并行);
 *   4. coordinator.stop: 撤已排期续跑、清队列、中止当前一轮(唯一的一次 abort)并清理
 *      待决交互;
 *   5. 等 Goal 落盘与队列快照落盘。Goal 落盘失败在中止**之后**才抛 INTERNAL —— 与桌面
 *      Stop 同一顺序, 存储错误不能挡住用户的喊停。
 *
 * 外部渠道(个人 IM `/stop`、官方 hook `task.cancel`)与伙伴群聊 / 委派的停止都走这里,
 * 不再各自拼一份(见 docs/dev-rules/im-turn-flow.md 不变量 9)。调用方不要再自己
 * `session.abort()` —— 重复中止会向 vendor 发两次 interrupt。
 *
 * 注册前(启动早期 / 单测)退回最小语义: 撤自动续跑 + 暂停 Goal + 中止当前一轮。
 */
export async function stopSessionTurnExplicitly(sessionId: string): Promise<void> {
  if (explicitStopImpl) {
    await explicitStopImpl(sessionId);
    return;
  }
  resetAutomaticRecoveryForExplicitStop(sessionId);
  const goalPause = pauseGoalBeforeExplicitStop(sessionId);
  await Promise.all([goalPause, getMaker().getSession(sessionId)?.abort()]);
}

/**
 * silent-stop 决策结果通知:scheduler/hook runner 等 in-process 监听方无法从
 * session.onEvent 收到合成的 settle 信号,通过本回调获知非续跑决策已做出,
 * 以便结束被 silentStop done 挂起的 turnFinished promise。
 * 回调参数 settled=true 表示该 session 的 silent-stop done 已 settle(不再续跑)。
 */
type SilentStopSettledCb = (
  sessionId: string,
  reason: 'exhausted' | 'skip' | 'send-failed',
) => void;
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

function fireSilentStopSettled(
  sessionId: string,
  reason: 'exhausted' | 'skip' | 'send-failed',
): void {
  const set = silentStopSettledListeners.get(sessionId);
  if (set) {
    for (const cb of set) {
      try {
        cb(sessionId, reason);
      } catch {
        /* swallow */
      }
    }
  }
}

const COLLABORATION_SETTING_KEYS = [
  'workerSoftLimit',
  'workerHardLimit',
  'workerIdleReleaseMinutes',
] as const;
type CollaborationSettingKey = (typeof COLLABORATION_SETTING_KEYS)[number];
const COLLABORATION_WORKER_LIMIT_MAX = 20;
const COLLABORATION_IDLE_RELEASE_MAX_MINUTES = 120;

function isCollaborationSettingKey(key: unknown): key is CollaborationSettingKey {
  return typeof key === 'string' && (COLLABORATION_SETTING_KEYS as readonly string[]).includes(key);
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
      throwIpcError(
        'INVALID_PARAMS',
        `${key} must be <= ${COLLABORATION_IDLE_RELEASE_MAX_MINUTES}`,
      );
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
          await prepareCodexForAuthModeChange({ allLocalHosts: true });
        } catch (err) {
          // busy 原样透传 —— 执行体靠它分流延迟路径;其余是真实故障,编码后上抛。
          if (isCredentialModeSwitchBusyError(err)) throw err;
          throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
        }
      },
      finalize: () => finalizeCodexAfterAuthModeChange({ prepareMcpEnvironment: true }),
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
// maker-ipc 会话创建路径与 scheduler-host 共享此导出，统一走 emitSessionCreated。
// renderer sessionsStore.onCreated 收到后 forceRefreshAll 重拉所有桶。
export function broadcastSessionCreated(sessionId: string): void {
  emitSessionCreated(sessionId);
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
  fastMode?: boolean | 'ultrafast';
  workingDir: string;
  workspaceKind?: 'project' | 'dialogue';
  permissionMode?: 'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
};

type SendToSessionInternalResult =
  | {
      ok: true;
      /** 目标 session 的 business id。create 分支回传新建 id;jump 分支回显入参 id。 */
      targetSessionId: string;
      agentKind: AgentKind;
      /** created = 本次新建并投递;resumed = 既有 session 被唤醒;already-active = 已在线直送;queued = 目标繁忙时进入输入队列。 */
      wakeKind: 'resumed' | 'already-active' | 'created' | 'queued';
      targetTitle: string | null;
      targetLastUserSendAt: string | null;
      /** jump 排队时的可寻址句柄；直发 / create 时省略。 */
      queuedMessageId?: string;
      /** create + useWorktree 成功时为新 session 的 worktree 绝对路径;其余情况 undefined。 */
      worktreePath?: string | null;
      model?: string;
      effort?: SendToSessionCreateDefaults['effort'] | null;
      fastMode?: boolean | 'ultrafast';
      providerId?: string | null;
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
        | 'UNSUPPORTED_CAPABILITY'
        | 'BUDGET_MODEL_REQUIRES_API_MODE'
        | 'PROVIDER_ROUTE_UNAVAILABLE'
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
  listSessionQueue: (
    sessionId: string,
  ) => Promise<
    | { ok: true; messages: SessionQueueInspectionEntry[] }
    | { ok: false; errorCode: 'NOT_FOUND' | 'HOST_NOT_READY' | 'INTERNAL'; message: string }
  >;
  listSessionQueuedCounts: (
    sessionIds: string[],
  ) => Promise<
    | { ok: true; counts: Record<string, number> }
    | { ok: false; errorCode: 'HOST_NOT_READY' | 'INTERNAL'; message: string }
  >;
  updateSessionQueuedMessage: (params: {
    callerSessionId: string;
    targetSessionId: string;
    queuedMessageId: string;
    message: string;
  }) => Promise<
    | { ok: true; queuedMessageId: string }
    | {
        ok: false;
        errorCode:
          | 'NOT_FOUND'
          | 'QUEUED_MESSAGE_NOT_FOUND'
          | 'MESSAGE_CONSUMING'
          | 'NOT_AUTHORIZED'
          | 'INVALID_ARGS'
          | 'HOST_NOT_READY'
          | 'INTERNAL';
        message: string;
      }
  >;
  cancelSessionQueuedMessage: (params: {
    callerSessionId: string;
    targetSessionId: string;
    queuedMessageId: string;
  }) => Promise<
    | { ok: true; queuedMessageId: string }
    | {
        ok: false;
        errorCode:
          | 'NOT_FOUND'
          | 'QUEUED_MESSAGE_NOT_FOUND'
          | 'MESSAGE_CONSUMING'
          | 'NOT_AUTHORIZED'
          | 'INVALID_ARGS'
          | 'HOST_NOT_READY'
          | 'INTERNAL';
        message: string;
      }
  >;
  steerSessionQueuedMessage: (params: {
    callerSessionId: string;
    targetSessionId: string;
    queuedMessageId: string;
  }) => Promise<
    SessionQueueSteerResult | { ok: false; errorCode: 'NOT_FOUND' | 'HOST_NOT_READY' | 'INTERNAL'; message: string }
  >;
  moveSessionQueuedMessage: (params: {
    callerSessionId: string;
    targetSessionId: string;
    queuedMessageId: string;
    position: number;
  }) => Promise<
    SessionQueueMoveResult | { ok: false; errorCode: 'NOT_FOUND' | 'HOST_NOT_READY' | 'INTERNAL'; message: string }
  >;
  steerSession: (params: {
    callerSessionId: string;
    targetSessionId: string;
    message: string;
  }) => Promise<
    | { ok: true; queuedMessageId: string }
    | {
        ok: false;
        errorCode:
          | 'NOT_FOUND'
          | 'NO_ACTIVE_TURN'
          | 'UNSUPPORTED_CAPABILITY'
          | 'INPUT_LOCKED'
          | 'DELIVERY_FAILED'
          | 'HOST_NOT_READY'
          | 'INTERNAL';
        message: string;
      }
  >;
  stopSessionTurn: (params: { targetSessionId: string }) => Promise<
    | {
        ok: true;
        status: 'no-active-turn' | 'waiting-for-safe-point' | 'requested' | 'unconfirmed';
        turnGeneration?: number;
        reason?: string;
      }
    | {
        ok: false;
        errorCode: 'NOT_FOUND' | 'UNSUPPORTED_CAPABILITY' | 'HOST_NOT_READY' | 'INTERNAL';
        message: string;
      }
  >;
  getSessionRuntime: (params: {
    targetSessionId: string;
  }) => Promise<
    | { ok: true; runtime: import('./sessionControlService.js').SessionRuntimeDetails }
    | { ok: false; errorCode: 'NOT_FOUND' | 'HOST_NOT_READY' | 'INTERNAL'; message: string }
  >;
  setSessionRuntime: (params: {
    targetSessionId: string;
    expectedGeneration?: number;
    patch: {
      harness?: AgentKind;
      model?: string;
      providerId?: string | null;
      effort?: import('@cindy/maker-core').Effort;
      fastMode?: boolean | 'ultrafast';
    };
  }) => Promise<
    | {
        ok: true;
        status: 'applied' | 'deferred';
        effectiveBoundary?: 'next_send';
        generation: number;
        effectiveProfile: SessionRuntimeProfile;
        pendingMutation: ReturnType<typeof getPendingSessionRuntimeMutation>;
      }
    | {
        ok: false;
        errorCode:
          | 'NOT_FOUND'
          | 'CONFLICT'
          | 'INVALID_ARGS'
          | 'ROUTE_UNAVAILABLE'
          | 'HOST_NOT_READY'
          | 'INTERNAL';
        message: string;
      }
  >;
  sendToSession: (params: {
    /** Host-only script follow-up; preserves target authorization without treating script text as consent. */
    readonly [AUTO_REVIEW_DELEGATED_CONTINUATION]?: true;
    messagePurpose?: SessionMessagePurpose;
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
    /** create 分支可选:显式执行配置；未提供的字段继续继承 dispatcher。jump 忽略。 */
    execution?: SendToSessionExecutionOverrides;
    /** Host-owned create defaults for non-session callers such as scheduler script tasks. */
    createDefaults?: SendToSessionCreateDefaults;
  }) => Promise<SendToSessionInternalResult>;
  enableOrca: (
    leadSessionId: string,
    opts: EnableOrcaOptions,
  ) => Promise<{
    teamId: string;
    workerSessionId: string;
    workerId: string;
    dispatched: boolean;
    uiAssignmentSnapshotBeforeMs: number;
    workerPermissionMode: OrcaWorkerPermissionMode;
    dispatchOutcome?: CollabDispatchOutcome;
  }>;
  disableOrca: (leadSessionId: string) => Promise<{ ok: true }>;
  /** start_team 只建立 team，不隐式创建 worker。 */
  startTeam: (params: {
    leadSessionId: string;
    workerPermissionMode?: OrcaWorkerPermissionMode;
  }) => Promise<
    | { ok: true; teamId: string; workerPermissionMode: OrcaWorkerPermissionMode; reused?: boolean }
    | { ok: false; errorCode: string; message: string }
  >;
  createWorker: (params: {
    leadSessionId: string;
    role: string;
    agent: AgentKind;
    model?: string;
    providerId?: string;
    effort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
    fast?: boolean | 'ultrafast';
    workerPermissionMode?: OrcaWorkerPermissionMode;
    label: string;
    workingDir?: string;
    worktree?: { sourceBranch?: string };
    initialTask?: string;
    initialTaskImages?: string[];
    executionDeviceId?: string;
    /** Worker 的 Agent 所在位置；语义见 OrcaWorkerCreateParams.agentDeviceId。 */
    agentDeviceId?: string | null;
  }) => Promise<
    | {
        ok: true;
        workerId: string;
        workerSessionId: string;
        workingDir?: string;
        worktree?: { path: string; branch: string };
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
    | {
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
    | {
        ok: true;
        workers: Array<{
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
        }>;
      }
    | { ok: false; errorCode: string; message: string }
  >;
  getWorkspaceInfo: (params: { leadSessionId: string }) => Promise<
    | {
        ok: true;
        workflow: { workflow_id: string; lead_session_id: string; status: string } | null;
        ui_capacity: number;
        worker_count: number;
        workers: Array<{
          worker_id: string;
          session_id: string;
          status: string;
          session_status: string;
          idle_ms: number | null;
          restored_from_storage: boolean;
          is_working: boolean;
          will_queue: boolean;
          queued_count: number;
          queue_paused: boolean;
          label: string | null;
          role: string;
          agent_kind: AgentKind;
          model: string;
          effort: string | null;
          focused: boolean;
          working_dir: string;
          owns_worktree: boolean;
          worktree?: { path: string; branch: string };
          execution_device?: {
            device_id: string;
            device_name: string | null;
            reachable: boolean | null;
          };
        }>;
        execution_devices?: Array<{
          device_id: string;
          name: string;
          platform: string | null;
          supported: boolean;
        }>;
      }
    | { ok: false; errorCode: string; message: string }
  >;
  getWorkerStatus: (params: { leadSessionId: string; workerId: string }) => Promise<
    | {
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
    | {
        ok: true;
        worker_id: string;
        session_id: string;
        status: string;
        session_status: string;
        result: string;
      }
    | { ok: false; errorCode: string; message: string }
  >;
  switchFocus: (params: {
    leadSessionId: string;
    workerIdOrLabel: string;
  }) => Promise<{ ok: true; workerId: string } | { ok: false; errorCode: string; message: string }>;
  // sendToWorker 的语义跟 sendToSession 的 create 分支完全不同 — worker 派活
  // 永远投递到既有 worker session，绝不创建新 session。holder 只暴露 service
  // 边界的窄契约，避免 sendToSession 的 create 模式漏进 worker 派活语义。
  sendToWorker: (params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
    delivery?: 'queue' | 'steer';
    imagePaths?: string[];
  }) => Promise<SendToWorkerResult>;
  interruptWorker: (params: {
    callerLeadSessionId: string;
    targetSessionId: string;
    message: string;
  }) => Promise<InterruptWorkerResult>;
  // 排队消息控制:只作用于 lead 自己发出的 orca 排队条目,归属校验与 send/idle/archive 同一套 resolveWorkerRef。
  listWorkerQueuedMessages: (params: {
    callerLeadSessionId: string;
    workerRef?: string;
  }) => Promise<ListWorkerQueuedMessagesResult>;
  steerWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    workerRef?: string;
    queuedMessageId: string;
  }) => Promise<SteerWorkerQueuedMessageResult>;
  moveWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    workerRef?: string;
    queuedMessageId: string;
    position: number;
  }) => Promise<MoveWorkerQueuedMessageResult>;
  updateWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
    message: string;
  }) => Promise<WorkerQueuedMessageControlResult>;
  cancelWorkerQueuedMessage: (params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageId: string;
  }) => Promise<WorkerQueuedMessageControlResult>;
  mergeWorkerQueuedMessages: (params: {
    callerLeadSessionId: string;
    workerRef: string;
    queuedMessageIds: string[];
    message: string;
  }) => Promise<MergeWorkerQueuedMessagesResult>;
  idleWorker: (params: {
    callerLeadSessionId: string;
    workerId: string;
    expectedStatus?: 'done';
  }) => Promise<
    { ok: true; workerId?: string } | { ok: false; errorCode: string; message: string }
  >;
  endTeam: (params: {
    leadSessionId: string;
  }) => Promise<{ ok: true } | { ok: false; errorCode: string; message: string }>;
  archiveWorker: (params: {
    callerLeadSessionId: string;
    workerId: string;
  }) => Promise<
    { ok: true; workerId?: string } | { ok: false; errorCode: string; message: string }
  >;
  listAvailableModels: (params: {
    agent?: AgentKind;
    callerSessionId?: string;
    /** Worker task/model discovery is owned by this execution computer. */
    executionDeviceId?: string;
    /** 列哪里的模型：缺省 = Lead 所在位置；null = 任务所在电脑；string = 那台电脑或分享。 */
    agentDeviceId?: string | null;
  }) => Promise<
    | {
        ok: true;
        /** 本次列出的位置(null = 任务所在电脑)。 */
        agentDeviceId?: string | null;
        /** 可以放 Worker Agent 的其他位置(同账号电脑与收到的分享)。 */
        locations?: Array<{ agentDeviceId: string; name: string }>;
        codex?: Array<{
          id: string;
          label: string;
          providers?: Array<{ id: string; name: string }>;
          defaultProviderId?: string | null;
        }>;
        claude_code?: Array<{
          id: string;
          label: string;
          providers?: Array<{ id: string; name: string }>;
          defaultProviderId?: string | null;
        }>;
        pi?: Array<{
          id: string;
          label: string;
          providers?: Array<{ id: string; name: string }>;
          defaultProviderId?: string | null;
        }>;
      }
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
  fast?: boolean | 'ultrafast';
  /** 显式选定的模型来源;语义见 OrcaWorkerCreateParams.providerId。 */
  providerId?: string | null;
  /** Worker 创建默认权限；缺省沿用当前偏好，显式值会更新偏好。 */
  workerPermissionMode?: OrcaWorkerPermissionMode;
  /** 新建 Lead 专用：先建 Worker，等首条 Lead 输入 accepted 且可查询后再派任务。 */
  deferDelegateTask?: boolean;
  /** 首个 Worker 放到同账号另一台电脑运行；缺省 = 本机。 */
  executionDeviceId?: string;
  /** 运行设备上的工作目录；缺省由那台分配。只在指定运行设备时生效。 */
  workingDir?: string;
  /** 首个 Worker 的 Agent 所在位置(远程供应商)；语义见 OrcaWorkerCreateParams.agentDeviceId。 */
  agentDeviceId?: string | null;
  worktree?: WorkerWorktreeRequest;
}

let orcaCollabServiceHolder: OrcaCollabService | null = null;
let botDelegationServiceHolder: BotDelegationService | null = null;
let botDirectMessageServiceHolder: BotDirectMessageService | null = null;
let botGroupChatServiceHolder: BotGroupChatService | null = null;
/**
 * Settle a pending account / endpoint switch before using the companion runtime: the lazy Chat
 * Server wrapper rebinds only when touched. (The home registry itself is owner-scoped.)
 */
function settleCompanionOwner(): void { void botGroupChatServiceHolder?.chatServer; }
let unsubscribeCompanionCloudBroadcast: (() => void) | null = null;
const listCompanionDevices = async () => (await handleListDevices(deviceDirectoryDeps())).devices;
/** Cloud-companion version of another computer's Cindy; 0 when it is old or cannot be reached. */
async function companionCloudPeerVersion(deviceId: string): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      invokeDeviceValue(invokeBotPeer, deviceId, COMPANION_CLOUD_CAPS_CHANNEL, []),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('[INVOKE_TIMEOUT] caps probe timed out')), 5_000); }),
    ]);
    return companionCloudCapsVersion(value);
  } catch { return 0; } finally { clearTimeout(timer); }
}

const botRuntimeRestoreCoordinator = createBotRuntimeRestoreCoordinator({
  readDbIdentity: () => {
    const snapshot = getCurrentDbClientSnapshot();
    return snapshot
      ? { userId: snapshot.userId, clientEpoch: snapshot.clientEpoch }
      : null;
  },
  readServices: () => ({
    directMessages: botDirectMessageServiceHolder,
    delegation: botDelegationServiceHolder,
  }),
  log,
});

export function restoreBotRuntimeForCurrentOwner(): Promise<boolean> {
  return botRuntimeRestoreCoordinator.restoreCurrentOwner();
}

/** 按当前账号恢复协同远端 Worker 的轮询；数据库未就绪时跳过，由接管后的调用补上。 */
export async function restoreOrcaRemoteWorkersForCurrentOwner(): Promise<void> {
  const remote = orcaRemoteWorkersForHost;
  if (!remote || !tryGetDbClient()) return;
  await remote.start().catch((err) =>
    log.warn('orca remote workers: restore failed', {
      err: err instanceof Error ? err.message : String(err),
    }),
  );
}

/** 账号边界：停掉上一账号远端 Worker 的轮询与补发，避免写进下一个账号的数据库。 */
export function stopOrcaRemoteWorkersForOwnerBoundary(): void {
  orcaRemoteWorkersForHost?.stop();
}

export function captureRemoteWorkerReportSettlement(
  sessionId: string, reportedInputClientIds: readonly string[],
): () => Promise<void> {
  return orcaRemoteWorkersForHost?.captureReportSettlement(sessionId, reportedInputClientIds)
    ?? (async () => {});
}

function markWorkerManualInterruptIfKnown(
  sessionId: string,
  reason: 'input_stop' | 'abort_session',
): boolean {
  if (!isKnownOrcaWorkerSession(sessionId)) return false;
  markManualInterrupt(sessionId, reason);
  return true;
}

export type {
  DispatchOrcaInterAgentMessageParams,
  DispatchOrcaInterAgentMessageResult,
  OrcaInterAgentMessageSource,
};

type DispatchOrcaInterAgentMessage = (
  params: DispatchOrcaInterAgentMessageParams,
) => Promise<DispatchOrcaInterAgentMessageResult>;

let dispatchInterAgentMessageHolder: DispatchOrcaInterAgentMessage | null = null;

export async function dispatchInterAgentMessage(
  params: DispatchOrcaInterAgentMessageParams,
): Promise<DispatchOrcaInterAgentMessageResult> {
  const dispatch = dispatchInterAgentMessageHolder;
  if (!dispatch) {
    return {
      ok: false,
      dispatchOutcome: {
        ...createHostSendFailure(
          'SEND_FAILED',
          'orca inter-agent dispatch service not initialized',
        ),
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

export function tryGetBotDelegationService(): BotDelegationService | null {
  return botDelegationServiceHolder;
}

export function tryGetBotDirectMessageService(): BotDirectMessageService | null {
  return botDirectMessageServiceHolder;
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
  string | { type: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };

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
  // cindy-media 晋升必须跟 durable user message 同步发生(createMessage 的
  // commitMessageMediaRefs)。这里仍可能在消息行落库前被 /clear 或 steer 取消；
  // 若提前挂 session-attachment 粗引用，取消路径没有 owner token 可补偿，清空后
  // 会把无主 blob 永久 pin 在 session 上。排队物化的本地副本由自身 ownership
  // registry 管理；直接发送则交给 durable message writer 在 row 成功后挂账。
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

/**
 * 待解决的 interaction 请求(permission/ask/plan 三合一)—— 用 promise 跨 IPC 边界。
 * key: requestId, value: resolver + owning session. ask/plan intentionally do
 * not use a timeout because they represent explicit product decisions, not a
 * transient permission prompt.
 */
const PERMISSION_INTERACTION_TIMEOUT_MS = 10 * 60 * 1000;

interface PendingInteractionEntry {
  sharedPermission?: import('./sharedPermission').SharedPermission;
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
  timeoutDeadlineAt?: number;
  timeoutRemainingMs?: number;
  /** IM owns presentation/timeouts; Host retains the execution and cancellation boundary. */
  migrated?: boolean;
  deferredDecision?: InteractionDecision;
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

const orcaWorkerPermissionConfirmBridge = new OrcaWorkerPermissionConfirmBridge({
  broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
  logger: log,
});

const taskActionConfirmBridge = new OrcaWorkerPermissionConfirmBridge({
  broadcast: (channel, payload) => broadcastToAllWindows(channel, payload),
  logger: log,
});

export async function confirmTaskAction(sessionId: string, tool: string, args: unknown): Promise<boolean> {
  const result = await taskActionConfirmBridge.request(sessionId, {
    title: t('taskActionConfirmation.title'),
    description: t(tool === 'start_session_task' ? 'taskActionConfirmation.delegation' : 'taskActionConfirmation.once'),
    action: { toolName: `mcp__cindy_helper__${tool}`,
      input: args as Record<string, unknown>, confirmation: 'task_action' },
  });
  return result.confirmed;
}

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
        activeStep?.title ??
          t('newChat.pluginSetup.title').replace('{{name}}', value.request.ghost.name),
      );
      return;
    }
    if (channel === MAKER_PUSH.INTERACTION_DISMISSED && typeof value.requestId === 'string') {
      getAgentIslandService()?.handleInteractionDismissed(value.sessionId, value.requestId);
    }
  },
  logger: log,
});

/**
 * 代输入 (input handoff). Like Desktop-only confirmations these are Host-owned
 * waits: they never block a later user turn and are not turn-idle zombies.
 * Broadcasts carry step structure only; owner values never leave the
 * trusted local channel or the signed v3 exchange.
 */
const inputHandoffImNotified = new Set<string>();
/** Who is answering: this Desktop, or the server-verified controller device. */
function inputHandoffActor(): InputHandoffHolder {
  const context = getDeviceLinkInvokeContext();
  if (!context) return { local: true };
  return { deviceId: context.controllerDeviceId };
}
function describeInputHandoffDevice(deviceId: string): Omit<InputHandoffHolder, 'local' | 'deviceId'> {
  const source = readDeviceLinkInvokeSourceDevice();
  const name = (source?.deviceId === deviceId ? source.name : undefined) ?? readLastKnownDeviceNames()[deviceId];
  return {
    ...(name ? { name: name.slice(0, 60) } : {}),
    ...(source?.deviceId === deviceId ? { platform: source.platform } : {}),
  };
}
const inputHandoffImNotifier = createFeishuDesktopConfirmNotifier(buildInputHandoffNoticeText);
/**
 * Tell the owner a screen is waiting, wherever they are. The phone push is
 * sent from main (not the renderer) so an unattended desktop with Cindy
 * focused still alerts, and each new screen alerts again. The body is fixed
 * copy: no screen contents, no purpose text, never a value.
 */
function notifyInputHandoffOwner(sessionId: string, snapshot: InputHandoffSnapshot): void {
  const generation = getMobileNotifyGeneration();
  void (async () => {
    try {
      const [title, preview] = await Promise.all([
        readSessionTitle(sessionId),
        readSessionNotificationPreview(sessionId, false).catch(() => undefined),
      ]);
      // An IM-driven task gets one text pointer per request, not one per screen.
      if (!inputHandoffImNotified.has(snapshot.requestId)) {
        inputHandoffImNotified.add(snapshot.requestId);
        // Channel-driven tasks get it in their chat; a desktop task taken over from Feishu (/ctr) by its binding.
        if (!sendInputHandoffChannelNotice(sessionId, buildInputHandoffNoticeText(title), log))
          inputHandoffImNotifier(sessionId, title);
      }
      sendMobileSessionNotify({
        sessionId,
        title: preview?.teammateName ?? title,
        kind: 'needs-reply',
        fallbackBody: getInputHandoffNotificationBody(),
        eventId: `input-handoff:${snapshot.requestId}:${snapshot.stepNumber}`,
        generation,
        ...(preview?.teammateBotId ? { teammateBotId: preview.teammateBotId } : {}),
        ...(preview?.teammateAvatar ? { teammateAvatar: preview.teammateAvatar } : {}),
      });
    } catch (err) {
      log.warn('[input-handoff] owner push failed (non-fatal)', err);
    }
  })();
}
let inputHandoffContinuation:
  | ((sessionId: string, requestId: string, message: string) => Promise<void>)
  | null = null;
initInputHandoffService({
  broadcast: (channel, payload) => {
    broadcastToAllWindows(channel, payload);
    const value = payload as { sessionId?: unknown; requestId?: unknown; request?: InputHandoffSnapshot };
    if (typeof value.sessionId !== 'string') return;
    if (channel === MAKER_PUSH.INTERACTION_REQUEST && value.request?.kind === 'input_handoff') {
      if (!shouldNotifyAgentIslandForSession(value.sessionId)) return;
      if (value.request.terminal === true) {
        getAgentIslandService()?.handleInteractionDismissed(value.sessionId, value.request.requestId);
        return;
      }
      getAgentIslandService()?.handlePluginSetupInteraction(
        value.sessionId,
        value.request.requestId,
        value.request.purpose,
        'input_handoff',
      );
      return;
    }
    if (channel === MAKER_PUSH.INTERACTION_DISMISSED && typeof value.requestId === 'string') {
      getAgentIslandService()?.handleInteractionDismissed(value.sessionId, value.requestId);
    }
  },
  createDriver: () => (process.platform === 'darwin' ? createMacHandoffDriver() : null),
  hostPid: process.pid,
  remoteInputAvailable: supportsRemotePluginOauth,
  // A live view of just the window rides remote desktop, so only where the owner allowed it.
  liveViewAvailable: () => {
    if (process.platform !== 'darwin') return false;
    const settings = readDeviceLinkSettings();
    return settings.remoteControlEnabled && settings.remoteDesktopEnabled;
  },
  notifyOwner: (sessionId, snapshot) => notifyInputHandoffOwner(sessionId, snapshot),
  describeDevice: describeInputHandoffDevice,
  onClosed: (_sessionId, requestId) => {
    inputHandoffImNotified.delete(requestId);
  },
  continueAgent: async (sessionId, requestId, message) => {
    if (!inputHandoffContinuation) throw new Error('INPUT_HANDOFF_CONTINUATION_UNAVAILABLE');
    await inputHandoffContinuation(sessionId, requestId, message);
  },
  logger: log,
});
// sudo / ssh / git password prompts in the owner's local tasks become one-step 代输入 cards.
initInputHandoffAskpass({
  startTerminalPrompt: (request) => getInputHandoffService()?.startTerminalPrompt(request) ?? { ok: false },
  isDisabledForSession: isInputHandoffDisabledForSession,
  logger: log,
});
onQuit('input-handoff-askpass', closeInputHandoffAskpass, 'async');

initGhostSetupCoordinator({
  getTargetToken: ghostInstallMutationTargetFor,
  remoteConnection: true,
  changeBus: getGhostSetupChangeBus(),
  bridge: ghostSetupInteractionBridge,
  resolveStoreId: (ghostId) => {
    const ghost = findGhostForInstanceId(ghostId);
    return ghost ? installedGhostStoragePart(ghost) : ghostId;
  },
  assess: (ghostId) => getGhostSetupAssessment(ghostId),
  validateTarget: (ghostId, tool, workingDir) => {
    // Coordinator 的 UI 只消费 TARGET_UNAVAILABLE 状态；这里的 message 会随
    // ensureReady 结果回到模型，因此与 ghost_info / ghost_call 共用同一口径。
    const instance = findGhostForInstanceId(ghostId);
    const visibility = classifyGhostVisibility(
      instance?.manifest.id ?? ghostId,
      workingDir ?? null,
      {
        listGhosts: () => getGhostManager().list(),
        isAvailableForActiveSession: isGhostAvailableForActiveSession,
        isDisabledForWorkdir: isGhostDisabledForWorkdir,
      },
      instance && hasDeliveryNamespace(instance) ? instance.namespace : undefined,
    );
    if (!visibility.ok) return visibility;
    const ghost = visibility.ghost;
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
    const ghost = findGhostForInstanceId(ghostId);
    if (!ghost) return null;
    return {
      id: installedGhostStoragePart(ghost),
      name: ghost.manifest.name,
      ...(ghost.iconDataUrl ? { iconDataUrl: ghost.iconDataUrl } : {}),
    };
  },
  executeAction: ({ sessionId, ghostId, action, responseTarget, assertCurrent }) =>
    executeGhostSetupAction({
      sessionId,
      ghostId,
      action,
      assertCurrent,
      ...(responseTarget ? { responseTarget } : {}),
    }),
  executeInlineAction: executeGhostSetupInlineAction,
  timeoutMessage: () => t('newChat.pluginSetup.timeout'),
  logger: log,
});

initializePluginOauthCards({
  settings: remotePluginSettings,
  bindConnection: bindGhostSetupConnectionAction,
  identity: currentOauthIdentityScope,
  loadKey: loadOauthSigningKey,
  bridge: ghostSetupInteractionBridge,
  bots: getBotAuthorizationService,
  inputHandoff: getInputHandoffService,
  owner: () => currentOauthIdentityScope() ? activeOwnerScopeKey() : null,
  available: peer => {
    const settings = readDeviceLinkSettings();
    return getDeviceLinkStatus() === 'online' && settings.remoteControlEnabled && !settings.revokedControllers.includes(peer);
  },
});

function clearPendingInteraction(requestId: string): PendingInteractionEntry | null {
  const entry = pendingInteractionResolvers.get(requestId);
  if (!entry) return null;
  pendingInteractionResolvers.delete(requestId);
  if (entry.timeoutId) clearTimeout(entry.timeoutId);
  return entry;
}

/** Permission safety time counts only while its owning task can accept input. */
function schedulePendingPermissionTimeout(requestId: string, entry: PendingInteractionEntry): void {
  if (entry.migrated || entry.sharedPermission || entry.kind !== 'permission' || entry.timeoutId !== undefined
    || pendingInteractionResolvers.get(requestId) !== entry
    || agentInputCoordinatorHolder?.isExecutionPaused(entry.sessionId)) return;
  const remaining = entry.timeoutRemainingMs ?? PERMISSION_INTERACTION_TIMEOUT_MS;
  entry.timeoutDeadlineAt = Date.now() + remaining;
  entry.timeoutId = setTimeout(() => {
    if (pendingInteractionResolvers.get(requestId) !== entry) return;
    entry.timeoutId = undefined;
    entry.timeoutRemainingMs = 0;
    entry.timeoutDeadlineAt = undefined;
    // Also guard an already-due callback at the pause boundary.
    if (agentInputCoordinatorHolder?.isExecutionPaused(entry.sessionId)) return;
    const pending = clearPendingInteraction(requestId);
    if (!pending) return;
    handleAgentIslandInteractionDismissed(entry.sessionId, requestId);
    pending.resolve({ kind: 'permission', behavior: 'deny', reason: 'timeout' });
    dismissRendererInteraction(pending, requestId, 'timeout', 'deny');
  }, remaining);
}

function setPendingInteractionTimeoutsPaused(sessionId: string, paused: boolean): string[] {
  const applied: string[] = [];
  for (const [requestId, entry] of pendingInteractionResolvers) {
    if (entry.sessionId !== sessionId) continue;
    if (!paused && entry.deferredDecision) {
      if (resolvePendingInteraction(requestId, entry.deferredDecision, !!entry.sharedPermission)) applied.push(requestId);
      continue;
    }
    if (entry.kind !== 'permission') continue;
    if (paused) {
      if (entry.timeoutId === undefined) continue;
      clearTimeout(entry.timeoutId);
      entry.timeoutId = undefined;
      entry.timeoutRemainingMs = Math.max(0, (entry.timeoutDeadlineAt ?? Date.now()) - Date.now());
      entry.timeoutDeadlineAt = undefined;
    } else {
      schedulePendingPermissionTimeout(requestId, entry);
    }
  }
  return applied;
}

type RecoverableInteractionSnapshot =
  | InteractionRequest
  | GhostSetupInteractionSnapshot
  | IssueConfirmInteractionSnapshot
  | RenameSessionsConfirmInteractionSnapshot
  | GhostGrantConfirmInteractionSnapshot
  | InputHandoffSnapshot;

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
function getPendingInteractionsForSession(sessionId: string): PendingInteractionSnapshotEntry[] {
  const out: PendingInteractionSnapshotEntry[] = [];
  for (const entry of pendingInteractionResolvers.values()) {
    if (entry.sessionId === sessionId && !entry.migrated)
      out.push({ request: entry.request, persistId: entry.persistId });
  }
  out.push(
    ...issueConfirmBridge.pendingSnapshots(sessionId).map(({ request }) => ({ request })),
    ...renameSessionsConfirmBridge.pendingSnapshots(sessionId).map(({ request }) => ({ request })),
    ...taskActionConfirmBridge.pendingSnapshots(sessionId).map(({ request }) => ({ request })),
    ...orcaWorkerPermissionConfirmBridge
      .pendingSnapshots(sessionId)
      .map(({ request }) => ({ request })),
    ...ghostGrantConfirmBridge.pendingSnapshots(sessionId).map(({ request }) => ({ request })),
    ...ghostSetupInteractionBridge.pendingSnapshots(sessionId).map(({ request }) => ({ request })),
    ...(getInputHandoffService()?.pendingSnapshots(sessionId) ?? []).map(({ request }) => ({ request })),
  );
  return out;
}

// 伙伴自主跟进：状态表读「等你的那句话」只取请求本身（不含 persistId 等宿主内部字段）。
configureBotAutonomyHost({
  readSessionExecution: (id) => {
    const session = getMakerIfReady()?.getSession(id);
    return session ? { instanceId: session.instanceId, generation: session.getTurnGeneration() } : null;
  },
  isCompletionHandledByTeammate: (sessionId, botId, execution) => botDelegationServiceHolder
    ?.isCompletionHandledByTeammate(sessionId, { pendingForBotId: botId, execution }) ?? Promise.resolve(null),
  getPendingInteractions: (sessionId) => getPendingInteractionsForSession(sessionId).map((entry) => entry.request),
});

/**
 * Agent-owned interactions are queue/zombie boundaries. Desktop-only confirms
 * are Host tool waiters: they are recoverable UI state, but must not block a
 * later user turn or be cleared by turn-idle reconciliation.
 */
function hasPendingAgentInteractionForSession(sessionId: string): boolean {
  return (
    Array.from(pendingInteractionResolvers.values()).some(
      (entry) => entry.sessionId === sessionId,
    ) || ghostSetupInteractionBridge.pendingSnapshots(sessionId).length > 0
  );
}

type BotCompactRuntimeRefreshHandler = (
  session: BotCompactRuntimeSession,
  boundary: BotCompactBoundary,
) => Promise<BotCompactRuntimeRefreshOutcome>;

/**
 * `wireSessionToIpc` is module-scoped because IM adapters and scheduler paths
 * create Sessions outside the renderer IPC handler.  The real refresh routine
 * needs the register-time Maker/bootstrap closure, so keep one narrow holder
 * and let the instance-scoped coordinator own all compact settle signals.
 */
let botCompactRuntimeRefreshHandler: BotCompactRuntimeRefreshHandler | null = null;
/**
 * 逐轮环境说明(界面语言 / 客户端设备 / 个人版制作说明)的去重记忆:同一原生上下文里内容
 * 没变就不重复前置。原生压缩边界、`/clear`、换窗重建后整体重发一次(见 wireNoteMemory.ts)。
 */
const wireNoteMemory = createWireNoteMemory();
const botCompactRuntimeRefreshCoordinator = createBotCompactRuntimeRefreshCoordinator({
  hasPendingInteraction: hasPendingAgentInteractionForSession,
  refresh: (session, boundary) =>
    botCompactRuntimeRefreshHandler?.(session, boundary) ?? Promise.resolve('deferred'),
  onError: (sessionId, error) => {
    log.warn('Bot compact runtime refresh failed; lazy resume remains available', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  },
});

function attemptBotCompactRuntimeRefresh(session: WiredSession, trigger: string): void {
  if (!botCompactRuntimeRefreshCoordinator.hasPending(session.id)) return;
  void botCompactRuntimeRefreshCoordinator.attempt(session).then((outcome) => {
    if (outcome === 'refreshed') {
      log.info('Bot compact runtime refreshed at idle boundary', {
        sessionId: session.id,
        trigger,
      });
    }
  });
}

function isPendingDesktopOnlyConfirmation(requestId: string): boolean {
  return (
    issueConfirmBridge.pendingSnapshots().some(({ request }) => request.requestId === requestId) ||
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

function persistInteractionDecision(
  sessionId: string,
  persistId: string | undefined,
  kind: PendingInteractionEntry['kind'],
  request: RecoverableInteractionSnapshot,
  decision: InteractionDecision | Record<string, unknown>,
): void {
  if (kind !== 'ask_user_question' && kind !== 'plan_review') return;
  onInteractionResolved(
    sessionId,
    persistId,
    kind,
    request as {
      requestId?: unknown;
      questions?: unknown;
      plan?: unknown;
      planFilePath?: unknown;
    },
    decision as Record<string, unknown>,
  );
}

/** Keep IM answers provisional in the same pause boundary as Desktop answers. */
function bindSharedPermission(requestId: string, entry: PendingInteractionEntry, shared: SharedPermission): void {
  entry.sharedPermission = shared;
  const originalResolve = entry.resolve;
  entry.resolve = (decision) => {
    shared.settle(decision);
    originalResolve(shared.decision ?? decision);
  };
  shared.decide = (decision) => {
    if (decision.kind !== 'permission' || shared.decision || entry.deferredDecision
      || pendingInteractionResolvers.get(requestId) !== entry) return false;
    if (agentInputCoordinatorHolder?.isExecutionPaused(entry.sessionId)) {
      entry.deferredDecision = decision;
      return true;
    }
    return shared.settle(decision);
  };
  void shared.result.then((decision) => {
    if (pendingInteractionResolvers.get(requestId) === entry) {
      resolvePendingInteraction(requestId, decision, true);
    }
  });
}

/** Host cancellation is final even while user answers are held by execution-pause. */
function cancelPendingInteraction(requestId: string, decision: InteractionDecision): boolean {
  const entry = pendingInteractionResolvers.get(requestId);
  if (!entry) return false;
  if (entry.sharedPermission) {
    entry.sharedPermission.settle(decision);
    decision = entry.sharedPermission.decision ?? decision;
  }
  // Use the same final-decision path as SharedPermission, never the paused answer gate.
  return resolvePendingInteraction(requestId, decision, true);
}

/** Narrow detached-workbench action: the Bot's live glance must still own this exact local permission. */
export function allowBotWorkbenchPendingPermission(botId: string, sessionId: string, requestId: string): { accepted: boolean } {
  const row = getBotAutonomyGlance(botId, undefined, false).waiting.find((item) =>
    item.deviceId === null && item.sessionId === sessionId &&
    item.requestId === requestId && item.waitingFor === 'permission');
  const pending = pendingInteractionResolvers.get(requestId);
  if (!row || !pending || pending.sessionId !== sessionId || pending.kind !== 'permission' ||
      pending.request.kind !== 'permission' || pending.request.requestId !== requestId) {
    return { accepted: false };
  }
  return { accepted: resolvePendingInteraction(requestId, { kind: 'permission', behavior: 'allow' }) };
}

function resolvePendingInteraction(requestId: string, decision: InteractionDecision, fromShared = false): boolean {
  const resolver = pendingInteractionResolvers.get(requestId);
  if (!resolver || (!fromShared && agentInputCoordinatorHolder?.isExecutionPaused(resolver.sessionId))) return false;
  if (resolver.sharedPermission && !fromShared) return resolver.sharedPermission.decide(decision);
  clearPendingInteraction(requestId);
  handleAgentIslandInteractionDismissed(resolver.sessionId, requestId);
  resolver.resolve(decision);
  // 广播「已解决」让**所有其它 renderer**(被控端自己的窗口 + 其它控制端 + 多窗口)收敛清面板。
  // 多端镜像下同一交互面板可能同时开在多处,只有发起方乐观本地清了 —— 不广播则其它方卡住。
  const resolvedAs =
    decision.kind === 'permission' && decision.behavior === 'allow' ? 'allow' : 'deny';
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
  const askUserNoFollowUpTurn =
    resolver.kind === 'ask_user_question' &&
    (decision.kind !== 'ask_user_question' || decision.dismissed === true);
  if (plannedNoFollowUpTurn || askUserNoFollowUpTurn) {
    agentInputCoordinatorHolder?.onInteractionResolved(resolver.sessionId);
  }
  persistInteractionDecision(
    resolver.sessionId,
    resolver.persistId,
    resolver.kind,
    resolver.request,
    decision,
  );
  // (Option B)ask_user_question 答完 → 即时改写该会话的 goal 目标(仅首轮澄清,controller 内 guard)。
  // 连同本次问题(含选项)一并交出,让 controller 用确定性标记甄别这是不是"目标澄清问题"。
  if (
    resolver.kind === 'ask_user_question' &&
    decision.kind === 'ask_user_question' &&
    goalAskAnswerObserver
  ) {
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

function isPermissionInteractionDecision(
  value: unknown,
): value is Extract<InteractionDecision, { kind: 'permission' }> {
  return Boolean(
    value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'permission',
  );
}

function defaultDecisionForPending(...args:Parameters<typeof originalSessionEventGuards.defaultDecisionForPending>):ReturnType<typeof originalSessionEventGuards.defaultDecisionForPending>{return originalSessionEventGuards.defaultDecisionForPending(...args);}

function cleanupPendingAgentInteractionsForSession(sessionId: string, reason: string): void {
  const entries = Array.from(pendingInteractionResolvers.entries()).filter(
    ([, entry]) => entry.sessionId === sessionId,
  );
  for (const [requestId, entry] of entries) {
    clearPendingInteraction(requestId);
    handleAgentIslandInteractionDismissed(sessionId, requestId);
    const decision = defaultDecisionForPending(entry.kind, reason);
    entry.resolve(decision);
    persistInteractionDecision(sessionId, entry.persistId, entry.kind, entry.request, decision);
    dismissRendererInteraction(entry, requestId, reason, 'deny');
  }
  ghostSetupInteractionBridge.cleanupForSession(
    sessionId,
    reason === 'session_closed' ? 'session_closed' : 'session_aborted',
  );
}

function cleanupPendingInteractionsForSession(sessionId: string, reason: string): void {
  cleanupPendingAgentInteractionsForSession(sessionId, reason);
  taskActionConfirmBridge.cleanupForSession(sessionId, reason === 'session_closed' ? 'session_closed' : 'session_aborted');
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
  orcaWorkerPermissionConfirmBridge.cleanupForSession(
    sessionId,
    reason === 'session_closed' ? 'session_closed' : 'session_aborted',
  );
  ghostGrantConfirmBridge.cleanupForSession(
    sessionId,
    reason === 'session_closed' ? 'session_closed' : 'session_aborted',
  );
  // 代输入 follows the same real close/abort boundary; silent, no continuation.
  getInputHandoffService()?.cleanupForSession(sessionId);
  // fs 槽 workdir 写确认的会话级记忆只在会话真正关闭时清(防 Set 无界增长)。
  // 本函数在 session_aborted(用户点停止)等瞬态也会被调,那些场景确认卡该收、
  // 但"同目录本会话免弹"的记忆要保住——否则用户每
  // 次 Stop 后同目录又要重新点一遍允许,与卡片文案承诺不符(review P2)。
  if (reason === 'session_closed') {
    getGhostFsSlot().cleanupForSession(sessionId);
  }
}

/**
 * 接管进行中的会话时,把待确认交互交给 IM 呈现。
 * 权限保留 Desktop 面板并共用一次决定;问答和计划沿用原有 UI 迁移规则。
 * 执行的取消、暂停与恢复仍由 Desktop 管理。
 */
export function takePendingInteractionsForSession(sessionId: string): Array<{
  sharedPermission?: SharedPermission;
  requestId: string;
  request: InteractionRequest;
  resolve: (decision: InteractionDecision) => void;
}> {
  const entries = Array.from(pendingInteractionResolvers.entries()).filter(
    ([, entry]) => entry.sessionId === sessionId && !entry.migrated && !entry.sharedPermission,
  );
  const taken: Array<{
    sharedPermission?: SharedPermission;
    requestId: string;
    request: InteractionRequest;
    resolve: (decision: InteractionDecision) => void;
  }> = [];
  for (const [requestId, entry] of entries) {
    if (entry.kind === 'permission') {
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.timeoutId = undefined;
      const shared = createSharedPermission();
      bindSharedPermission(requestId, entry, shared);
      taken.push({ requestId, request: entry.request, resolve: shared.decide, sharedPermission: shared });
      continue;
    }
    // Transfer the UI, never the raw engine resolver. Keep cancellation and pause
    // ownership here even after the IM registry consumes its one-shot answer.
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    entry.timeoutId = undefined;
    entry.migrated = true;
    taken.push({ requestId, request: entry.request, resolve: decision => {
      if (pendingInteractionResolvers.get(requestId) !== entry || entry.deferredDecision) return;
      if (agentInputCoordinatorHolder?.isExecutionPaused(sessionId)) {
        entry.deferredDecision = decision;
        return;
      }
      resolvePendingInteraction(requestId, decision);
    } });
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
 * Capture only the exact direct-abort owner that a provider-driven close is
 * about to tear down. Ordinary closes and stale owner/turn generations must
 * not wake a paused Goal after their routing identity has been discarded.
 */
function getDirectAbortBoundaryForClosingSession(
  sessionId: string,
  session: WiredSession,
): DirectAbortReconcileBoundary | null {
  const boundary = directAbortReconcileBoundaries.get(sessionId);
  if (!boundary || boundary.session !== session) return null;
  if (currentSessionTurnBoundaryGeneration(sessionId) !== boundary.generation) return null;
  return boundary;
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
/** Billing identity and Pi tariff captured at product-turn start. */
const turnUsageContextBySession = new Map<string, TurnUsageContext>();

/**
 * Zero-value marker for a future subscription turn that was deliberately not
 * priceable. daily_model_usage has no money-kind column, so approximate=true
 * distinguishes this from legacy zero rows that history may still estimate.
 */
function unpricedSubscriptionValueMarker(...args:Parameters<typeof originalSessionEventGuards.unpricedSubscriptionValueMarker>):ReturnType<typeof originalSessionEventGuards.unpricedSubscriptionValueMarker>{return originalSessionEventGuards.unpricedSubscriptionValueMarker(...args);}
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
// per-session send/route 锁本体(含 30s 泄漏告警 + 5min 强制 bail 的 watchdog)已抽到
// sendToSessionLock.ts 以便单测;此处保留 re-export 与 map 引用以维持既有导入面。
import {
  acquireSendToSessionLock,
  hasSendToSessionLock,
  sendToSessionLocks,
  trackSendToSessionLockRun,
  withSendToSessionLock,
  withSessionRestartLock,
  waitForSendToSessionLock,
  assertSessionNotRestarting,
} from './sendToSessionLock.js';
export { acquireSendToSessionLock, hasSendToSessionLock, withSendToSessionLock };

export interface ApplyDirectoryGrantsOptions {
  remote: boolean;
  senderId?: number;
  /** extraDirs: requested 只含 library 槽(可空=撤槽),用户目录在锁内从 DB 现读。 */
  replaceLibrarySlot?: boolean;
}

/**
 * extraDirs / writableDirs 授权内部入口。IPC 与 library 静默注入共用。
 * extraDirs 轴不走 picker;writableDirs 仍消费 picker grant。
 */
export function applyDirectoryGrants(
  axis: 'extraDirs' | 'writableDirs',
  sessionId: string,
  requestedDirs: string[],
  options: ApplyDirectoryGrantsOptions,
): Promise<string[] | void> {
  return withSendToSessionLock(sessionId, async () => {
    const [sourceRow] = await getDbClient()
      .drizzle.select({ source: sessions.source })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (sourceRow?.source === 'review') {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Review task settings are fixed to the source task');
    }
    const maker = getMaker();
    const sess = maker.getSession(sessionId);
    const supported = axis === 'extraDirs'
      ? sess?.capabilities.extraDirs.supported
      : sess?.capabilities.writableDirs?.supported;
    const label = axis === 'extraDirs' ? 'set-extra-dirs' : 'set-writable-dirs';
    if (sess && !supported) {
      log.debug(`${label}: agent capability=false, no-op`, {
        sessionId,
        agentKind: sess.agentKind,
      });
      return;
    }
    const persistOnly = !sess;
    const workDir = persistOnly
      ? (await readSessionWorkingDirFromDb(sessionId) ?? undefined)
      : (sess.workDir || undefined);
    let dirsToApply = requestedDirs;
    if (axis === 'extraDirs') {
      const persisted = await readSessionExtraDirsFromDb(sessionId);
      const { user: dbUser, library: dbLibrary } = splitExtraDirSlots(persisted);
      if (options.replaceLibrarySlot) {
        const { library } = splitExtraDirSlots(requestedDirs);
        dirsToApply = [...dbUser, ...library];
      } else {
        const { user } = splitExtraDirSlots(requestedDirs);
        dirsToApply = [...user, ...dbLibrary];
      }
    }
    const result = await applyRemoteDirectoryGrantUpdate(axis, dirsToApply, {
      setExtraDirs: persistOnly
        ? async () => {}
        : (dirs) => sess.setExtraDirs(extraDirsForRuntime(dirs), libraryRootForRuntime(dirs)),
      setWritableDirs: persistOnly
        ? async () => {}
        : (dirs) => sess.setWritableDirs(dirs),
    }, {
      validate: async (requested) => {
        if (axis !== 'extraDirs') {
          return validateExtraDirs(requested, workDir);
        }
        const { user, library } = splitExtraDirSlots(requested);
        const userResult = await validateExtraDirs(user, workDir);
        const libraryValid: string[] = [];
        const libraryRejected: Array<{ path: string; reason: string }> = [];
        for (const slot of library) {
          const root = libraryRootFromSlot(slot);
          const checked = await validateExtraDirs([root], workDir);
          if (checked.valid.length === 1) libraryValid.push(libraryExtraDirSlot(checked.valid[0]));
          else libraryRejected.push(...checked.rejected);
        }
        return {
          valid: [...userResult.valid, ...libraryValid],
          rejected: [...userResult.rejected, ...libraryRejected],
        };
      },
      readExtraDirs: () => readSessionExtraDirsFromDb(sessionId),
      readWritableDirs: () => readSessionWritableDirsFromDb(sessionId),
      excludeConflicts: async (candidates, blocked) => {
        const accepted = await excludeDirectoryGrantConflictsWithSlots(candidates, blocked);
        if (axis === 'writableDirs') {
          const previousDirs = await readSessionWritableDirsFromDb(sessionId);
          const [route] = await getDbClient()
            .drizzle.select({ remoteHostId: sessions.remoteHostId })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (options.remote || route?.remoteHostId) {
            // The picker lives on the controller filesystem, so device-link and SSH may only
            // retain/revoke roots that were already persisted on the execution side.
            if (!isPersistedDirectoryGrantSubset(accepted, previousDirs)) {
              throwIpcError(
                'PRECONDITION_FAILED',
                'remote writable directories can only retain or revoke existing grants',
              );
            }
            return accepted;
          } else {
            if (options.senderId === undefined) {
              throwIpcError('PRECONDITION_FAILED', 'Writable directory picker owner unavailable');
            }
            try {
              await consumeWritableDirectoryPickerGrants({
                scopeId: sessionId,
                senderId: options.senderId,
                requestedDirs: accepted,
                previousDirs,
              });
            } catch (error) {
              throwIpcError(
                'PRECONDITION_FAILED',
                error instanceof Error
                  ? error.message
                  : 'Writable directory authorization failed',
              );
            }
          }
        }
        return accepted;
      },
      persist: (patch) => persistSessionFields(sessionId, patch),
      // 附加目录：远程 Agent 正在跑一轮时不当场关——本机执行器先改、回滚时已回到原来的目录(文件读写由本机执行器
      // 把关)，库里也还是原来那份，那台只是暂时连不上；这一轮结束后再重建。当场关会把进行中的一轮杀掉，且不是那台
      // 电脑的问题，供应商组也不会换电脑(docs/product-rules/provider-groups.md §6.1「本机的操作不打断进行中的远程一轮」)。
      // 可写目录不在此列：本机执行器在对方确认后才改，回滚不到时可能留着更宽的可写目录，照旧当场关。
      terminate: () => (axis === 'extraDirs' && sess?.agentDeviceId && sess.isTurnRunning()
        ? maker.closeSessionIfCurrent(sess, 'runtime-refresh', { afterCurrentTurn: true })
        : maker.closeSession(sessionId)),
    });
    if (result.changed || result.rejectedCount > 0) log.info(label, {
      sessionId,
      requested: requestedDirs.length,
      kept: result.dirs.length,
      rejected: result.rejectedCount,
    });
    if (options.remote) markRemoteSettingPersistedInsideHandler(result.dirs);
    return result.dirs;
  });
}

/**
 * Mivo 会话 library ready 时静默写入只读 extraDirs(专用槽,不弹 picker)。
 * root 为 null 则撤该会话 library 槽,用户自选目录保留。
 */
export async function applyLibraryReadonlyExtraDir(
  sessionId: string,
  root: string | null,
): Promise<string[] | void> {
  let canonical: string | null = null;
  if (root) {
    try {
      canonical = await fsp.realpath(root);
    } catch {
      canonical = null;
    }
  }
  return applyDirectoryGrants(
    'extraDirs',
    sessionId,
    canonical ? [libraryExtraDirSlot(canonical)] : [],
    { remote: false, replaceLibrarySlot: true },
  );
}

async function sessionIsRemote(sessionId: string): Promise<boolean> {
  const [row] = await getDbClient()
    .drizzle.select({ remoteHostId: sessions.remoteHostId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return Boolean(row?.remoteHostId);
}

let libraryExtraDirSyncGeneration = 0;
let libraryExtraDirSyncRoot: string | null = null;
let libraryExtraDirSyncChain: Promise<void> = Promise.resolve();

async function syncLibraryReadonlyExtraDir(
  root: string | null,
): Promise<'granted' | 'not-granted' | 'superseded'> {
  libraryExtraDirSyncRoot = root;
  const generation = ++libraryExtraDirSyncGeneration;
  const run = async (): Promise<'granted' | 'not-granted' | 'superseded'> => {
    if (generation !== libraryExtraDirSyncGeneration) return 'superseded';
    const grantRoot = libraryExtraDirSyncRoot;
    const focused = getFocusedGhostSessionId();
    if (generation !== libraryExtraDirSyncGeneration) return 'superseded';
    const visible = await listVisibleActiveSessionDirectoryGrants();
    if (generation !== libraryExtraDirSyncGeneration) return 'superseded';
    const targets = libraryExtraDirSyncTargets(
      visible, new Set(getMaker().listActiveSessions().map((session) => session.id)), focused,
    );
    let granted = false;
    for (const sessionId of targets) {
      if (generation !== libraryExtraDirSyncGeneration) return 'superseded';
      const remote = await sessionIsRemote(sessionId);
      if (generation !== libraryExtraDirSyncGeneration) return 'superseded';
      const nextRoot = !remote && grantRoot && sessionId === focused ? grantRoot : null;
      // 没有 Library 槽可撤、这次也不给：什么都不变，不碰运行中的会话。否则每次切换焦点都要把每个开着的任务的附加
      // 目录重新下发一遍，远程 Agent 那台恰好连不上时回滚失败、会话被关，正在跑的一轮就此中断(2026-10-11 实测)。
      // 运行时的 Library 槽只会来自已落库的那份(启动从库里读，改动先改运行时再落库，落库失败回滚)，库里没有即运行时没有。
      if (!nextRoot) {
        const persisted = await readSessionExtraDirsFromDb(sessionId).catch(() => null);
        if (generation !== libraryExtraDirSyncGeneration) return 'superseded';
        if (persisted && !persisted.some(isLibraryExtraDirSlot)) continue;
      }
      try {
        const applied = await applyLibraryReadonlyExtraDir(sessionId, nextRoot);
        if (nextRoot && applied?.some(isLibraryExtraDirSlot)) granted = true;
      } catch (error) {
        log.warn('library extraDirs session sync failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!remote && nextRoot && sessionId === focused) throw error;
      }
      if (generation !== libraryExtraDirSyncGeneration) return 'superseded';
    }
    if (grantRoot && !granted) {
      throw new Error('library extraDirs not granted to focused session');
    }
    return grantRoot && granted ? 'granted' : 'not-granted';
  };
  const queued = libraryExtraDirSyncChain.then(run, run);
  libraryExtraDirSyncChain = queued.then(() => undefined, () => undefined);
  return queued;
}

let agentInputCoordinatorHolder: AgentInputCoordinator | null = null;
let contextOverflowRolloverHolder: ReturnType<typeof createContextOverflowRollover> | null = null;

/** De-duplicate repeated budget notifications for the same live session. */
const appliedContextWindowBudgets = new Map<string, number | null>();
/** Budget rebuilds deferred while a turn is active and replayed at send boundaries. */
const pendingSessionContextWindowBudgetReconciles = new Set<string>();

let sessionContextWindowBudgetApplier:
  | ((sessionId: string, change: { previous: number | null; next: number | null }) => Promise<void>)
  | null = null;

export async function applySessionContextWindowBudgetChange(
  sessionId: string,
  change: { previous: number | null; next: number | null },
): Promise<void> {
  await sessionContextWindowBudgetApplier?.(sessionId, change);
}

const overflowSuppressedBroadcasts = new Map<
  string,
  { sessionId: string; event: AgentEvent; persistId?: string; resolvedContent?: unknown }
>();

function getWiredSessionCloseReason(session: WiredSession) {
  return getMakerIfReady()?.getSessionCloseReason(session) ?? 'unexpected';
}

/**
 * Preserve the provider-rebuild handoff window for continuation-only
 * auto-retry (stall / idle / reconnect-stall). Every check is instance- and
 * token-scoped so a user close or a later retry cannot resurrect the old
 * business session. An in-flight callback / queued CONTINUE still belongs to
 * this attempt and must survive unexpected close.
 */
const { bindContinuationOnlyAutoResumeLease, shouldPreserveContinuationOnlyAutoResume, shouldPreserveSessionRuntimeFallbackAutoResume } = createSessionRecoveryLeases({
  coordinator: () => agentInputCoordinatorHolder, interruptedTurnAutoResumeGuard, autoResumeBookkeeping, pendingContinuationOnlyAutoResumeRebuilds, pendingSessionRuntimeFallbackRebuilds,
});

/**
 * GoalController 已确认当前 turn 归自己所有后调用：复用输入协调器的 Stop 边界中断
 * vendor，同时保留用户已经排队的新指令并在终态收口后继续派发。
 *
 * 这里不判断 goal ownership，避免 register 反向依赖 goal-host；调用方必须先完成判定。
 */
export function stopActiveGoalTurnForClear(sessionId: string): void {
  const coordinator = agentInputCoordinatorHolder;
  if (!coordinator) {
    throw new Error('Agent input coordinator is not initialized');
  }
  coordinator.stop(sessionId, { keepQueue: true, pauseQueue: false });
}

const rewindInputSessions = new Set<string>();
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
let gatewayCodexRestartHolder: GatewayCodexRestartService | null = null;
let pendingAgentSwitchApplyHolder:
  ((
    sessionId: string,
    signal?: AbortSignal,
    selection?: ScheduledModelSelection,
    beforeApply?: () => Promise<boolean | void>,
    scheduledModelOverride?: boolean,
  ) => Promise<{ release: () => void; selection?: ScheduledModelSelection }>) | null = null;
let cancelPendingAgentSwitchHolder: ((sessionId: string) => void) | null = null;
let prepareScheduledModelPreferencesHolder: ((sessionId: string, override: boolean) => Promise<void>) | null = null;
let recordDispatchedModelHolder: ((sessionId: string, clientId: string) => void) | null = null;

export function recordDispatchedModel(sessionId: string, clientId: string): void {
  recordDispatchedModelHolder?.(sessionId, clientId);
}

/** Send boundary: preserve an override's owner choice, or apply that choice for a following run. */
export async function prepareScheduledModelPreferencesUnderLock(sessionId: string, override: boolean) {
  if (!prepareScheduledModelPreferencesHolder) throw new Error('Scheduled model selection is not initialized');
  return prepareScheduledModelPreferencesHolder(sessionId, override);
}

/** 会话级完整路由选择(引擎 + 模型 + 来源 + 档位 + Fast)。 */
export interface SessionRouteSelection {
  agentDeviceId?: string | null;
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: string | null;
  fastMode: boolean | 'ultrafast';
}
let readPendingAgentSwitchRouteHolder:
  ((sessionId: string) => PendingAgentSwitchRouteRead | undefined) | null = null;
let applySessionRouteUnderSendLockHolder:
  ((sessionId: string, route: SessionRouteSelection | null, currentAgentKind: AgentKind) => Promise<'applied' | 'staged'>) | null = null;
/**
 * 切换引擎后重建会话时补回渠道专属 vendorOptions(IM 的会话 id / 对端等)。
 * 切换建会话只读 DB 行, 不补的话 IM 任务切完引擎会悄悄丢掉 bot 专属工具。
 */
const switchedSessionVendorOptionsResolvers = new Set<
  (sessionId: string) => Record<string, unknown> | undefined
>();

function resolveSwitchedSessionVendorOptions(sessionId: string): Record<string, unknown> | undefined {
  for (const resolve of switchedSessionVendorOptionsResolvers) {
    const options = resolve(sessionId);
    if (options) return options;
  }
  return undefined;
}
let gitSnapshotCoordinator: GitSnapshotCoordinator | null = null;
const sessionTurnActivityTracker = new SessionTurnActivityTracker();
let providerGroupLeaseReporter: ProviderGroupLeaseReporter | null = null;
const reviewRunOwner: ReviewRunOwner = { instanceId: randomUUID(), processId: process.pid };
const sessionTurnLeaseTracker = new SessionTurnLeaseTracker({
  getDbClient,
  owner: reviewRunOwner,
  createTurnId: randomUUID,
  now: Date.now,
  warn: (message, fields) => log.warn(message, fields),
});
/**
 * Recovering a missing/deleted canonical task can replace its runtime. The same
 * per-session lock used by message dispatch must therefore cover the final
 * busy check and the SQLite CAS; otherwise a turn can start between a renderer
 * precheck and the archive transaction and lose its terminal output.
 */
export async function assertBotCanonicalReplacementIdle(sessionId: string): Promise<void> {
  const live = getMakerIfReady()?.getSession(sessionId);
  const busy = isBotCanonicalReplacementBusy({
    turnRunning: live?.isTurnRunning() === true,
    backgroundTaskCount: live?.listBackgroundTasks().length ?? 0,
    trackedTurn: sessionTurnActivityTracker.isSessionInTurn(sessionId),
    leasedTurn: await sessionTurnLeaseTracker.isTurnActive(sessionId),
    pendingInteraction: hasPendingAgentInteractionForSession(sessionId),
  });
  if (busy) {
    throwIpcError(
      'SESSION_RUNNING',
      '伙伴主任务仍在运行或等待处理，现在不能恢复替代任务',
    );
  }
}
configureBotCanonicalReplacementCoordinator((sessionId, operation) =>
  withSendToSessionLock(sessionId, async () => {
    await assertBotCanonicalReplacementIdle(sessionId);
    return operation();
  }),
);
let reviewOwnerLivenessHandle: ReviewOwnerLivenessHandle | null = null;
const ensureReviewOwnerLivenessReady = createRetryableReviewInitialization(async () => {
  const handle = reviewOwnerLivenessHandle ?? (await startReviewOwnerLiveness());
  reviewOwnerLivenessHandle = handle;
  reviewRunOwner.liveness = handle.identity;
  await sessionTurnLeaseTracker.refreshActiveLeaseOwners();
});
configureTempAttachmentOwner(reviewRunOwner, ensureReviewOwnerLivenessReady);
configureOutboundReviewPreparation({
  owner: reviewRunOwner,
  ensureOwnerReady: ensureReviewOwnerLivenessReady,
  resolvePath: resolveReviewArtifactPath,
});
const silentStopTurnLeaseGate = new SilentStopTurnLeaseGate();
function providerTurnLeaseId(sessionInstanceId: string, turnGeneration: number): string {
  return `${sessionInstanceId}:${turnGeneration}`;
}
const productTurnWallClockTracker = new ProductTurnWallClockTracker();
const productTurnUsageTargetTracker = new ProductTurnUsageTargetTracker();
const claudeOutputLagTimingGuard = new ClaudeOutputLagTimingGuard();

/**
 * Own the session input boundary while rewind stops an active turn and changes
 * history. Queued messages survive the operation but stay paused afterwards.
 */
export const {withSessionInputStoppedForRewind}=createSessionRewindInputBoundary({getCoordinator:()=>agentInputCoordinatorHolder,rewinding:rewindInputSessions,logger:log,stopGoal:async id=>goalStopObserver?.(id)});

/**
 * 媒体回收器活引用取证入口(recycler.ts 的内存队列暂存区):内存排队/在途
 * 消息的序列化文本。coordinator 未就绪(启动早期)返回空——此时也不存在
 * 内存队列,空集合语义正确。
 */
export function collectAgentInputQueueScanTexts(): string[] {
  return [...collectPluginAttachmentPayloadTexts(), ...(agentInputCoordinatorHolder?.collectQueuedPayloadTexts() ?? [])];
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

/** Goal direct dispatch must yield to the same input boundary as ordinary messages. */
export function isGoalInputBlocked(sessionId: string): boolean {
  return !agentInputCoordinatorHolder
    || agentInputCoordinatorHolder.shouldQueueNewTurn(sessionId)
    || hasPendingAgentInteractionForSession(sessionId);
}

export async function ensureGoalInputReady(sessionId: string): Promise<boolean> {
  const coordinator = agentInputCoordinatorHolder;
  if (!coordinator) return false;
  await coordinator.ensureQueueRestored(sessionId);
  return coordinator === agentInputCoordinatorHolder
    && coordinator.isQueueRestored(sessionId)
    && !isGoalInputBlocked(sessionId);
}

export function isSessionInTurn(sessionId: string): boolean {
  return sessionTurnActivityTracker.isSessionInTurn(sessionId);
}

export function getSessionLastUserActionAt(sessionId: string): number | null {
  return agentInputCoordinatorHolder?.getLastUserActionAt(sessionId) ?? null;
}

/** Runtime-only attribution; queued or rejected steering cannot take ownership. */
export function getSessionActiveInputClientIds(sessionId: string): string[] {
  return agentInputCoordinatorHolder?.getActiveInputClientIds(sessionId) ?? [];
}

/** Runtime-only attribution; queued or rejected steering cannot take ownership. */
export function getSessionInputProvenance(sessionId: string) {
  const input = agentInputCoordinatorHolder?.getAcceptedInputProvenance(sessionId) ?? null;
  return { input, executing: !!input || !!getMakerIfReady()?.getSession(sessionId)?.isTurnRunning() };
}

/** Capture from the caller's accepted input before any asynchronous target work. */
export async function captureSessionAgentRequest(sessionId: string, supplement: string): Promise<CapturedAgentRequest> {
  const scope = captureDataOwnerBroadcastScope();
  const active = agentInputCoordinatorHolder?.getAcceptedInputProvenance(sessionId) ?? null;
  const lane = readChannelToolScope({ sessionId, sessionInstanceId: getMakerIfReady()?.getSession(sessionId)?.instanceId });
  const principal = taskActionPrincipal(sessionId);
  // Only a companion's task instructions forward the owner's words. Ordinary
  // sessions (including scheduled runs and child results) keep their own body.
  const [companion] = await getDbClient().drizzle.select({ role: botSessionLinks.role })
    .from(botSessionLinks).where(and(eq(botSessionLinks.sessionId, sessionId),
      inArray(botSessionLinks.role, ['canonical', 'group', 'channel', 'thread']), isNull(botSessionLinks.archivedAt))).limit(1);
  const ownerVerified = !!companion && principal === 'owner';
  const evidence = active ?? (ownerVerified ? await ownerChannelInputEvidence(lane, async (clientId) => {
    const [row] = await getDbClient().drizzle.select({ content: messages.content }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId), eq(messages.role, 'user'),
        isNull(messages.rewindAt))).limit(1);
    return row ? extractPlainText(row.content) : null;
  }) : null);
  const request = await captureRequest(sessionId, supplement, evidence,
    () => listMessagesForAgentHandoff(sessionId, 1, undefined, 'user'),
    !!companion, ownerVerified);
  if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new Error('Data owner changed before request capture');
  return request;
}

export function getTaskActionInputState(sessionId: string) {
  const input = getSessionInputProvenance(sessionId);
  const session = getMakerIfReady()?.getSession(sessionId);
  return {
    key: JSON.stringify(input),
    // Reuse the live permission/Plan generation guard; the DB can lag a mode change.
    permission: resolveGhostFsSessionSnapshot(
      (id) => getMakerIfReady()?.getSession(id), sessionId, session?.instanceId,
    ),
    ownerInput: isActiveInputOwnerAuthored(sessionId),
    ownerContinuation: agentInputCoordinatorHolder?.isActiveInputOwnerContinuation(sessionId) === true,
    automatic: !!input.input && !isActiveInputOwnerAuthored(sessionId),
    orcaSenderSessionId: input.input?.orcaSenderSessionId,
    boundary: `${session?.instanceId ?? ''}:${agentInputCoordinatorHolder?.getGeneration(sessionId) ?? -1}`,
  };
}

/** Live permission authority for Host task actions; never reconstructed from DB defaults. */
export function getTaskActionSession(sessionId: string) {
  return getMakerIfReady()?.getSession(sessionId);
}

/** Owner-authored active input (see AgentInputCoordinator.isActiveInputOwnerAuthored). */
export function isActiveInputOwnerAuthored(sessionId: string): boolean {
  return agentInputCoordinatorHolder?.isActiveInputOwnerAuthored(sessionId) ?? false;
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
  gatewayCodexRestartHolder?.clear();
}

/** Reuse the owner-scoped idle retry for settings whose persistence already succeeded. */
export function scheduleDeferredCodexRestart(reason: string): void {
  deferredCodexRestartHolder?.schedule(reason);
}

export function clearWorkingDirectoryRecoveryForOwnerBoundary(): void {
  workingDirectoryRecovery.clear();
}

/**
 * Goal / IM / scheduler 直发 `Session.send()` 的 deferred agent-switch 锁桥。
 *
 * 与 renderer 的 makerSendTransaction 不同,这些调用方没有后续 lazy-create 阶段;
 * holder 因此先在 session 锁内同步 bootstrap 新引擎,调用方重新读取 live session
 * 并完成 send 后才 release。启动期 holder 尚未就绪时不可能已有进程内 pending
 * intent,返回 no-op release 即可。
 */
export function acquirePendingAgentSwitchForDirectSend(
  sessionId: string, signal?: AbortSignal, selection?: undefined, scheduledModelOverride?: boolean,
): Promise<() => void>;
export function acquirePendingAgentSwitchForDirectSend(
  sessionId: string, signal: AbortSignal | undefined, selection: ScheduledModelSelection,
): Promise<ScheduledModelSelectionLease>;
export function acquirePendingAgentSwitchForDirectSend(
  sessionId: string, signal?: AbortSignal, selection?: ScheduledModelSelection, scheduledModelOverride?: boolean,
): Promise<(() => void) | ScheduledModelSelectionLease>;
export async function acquirePendingAgentSwitchForDirectSend(
  sessionId: string,
  signal?: AbortSignal,
  selection?: ScheduledModelSelection,
  scheduledModelOverride?: boolean,
): Promise<(() => void) | ScheduledModelSelectionLease> {
  if (selection && !pendingAgentSwitchApplyHolder) throw new Error('Scheduled model selection is not initialized');
  const lease = await pendingAgentSwitchApplyHolder?.(sessionId, signal, selection, undefined, scheduledModelOverride);
  if (!selection) return lease?.release ?? (() => {});
  if (!lease?.selection) {
    lease?.release();
    throw new Error('Scheduled model selection was not resolved');
  }
  return { release: lease.release, selection: lease.selection };
}

/** 直发路径在 createSession / 重读 live session 之前关掉不健康原生会话。 */
export async function prepareUnhealthySessionForSend(sessionId: string): Promise<void> {
  await contextOverflowRolloverHolder?.prepareUnhealthySession(sessionId);
}

/** Later successful model/provider picks supersede an earlier cross-engine intent. */
export function cancelPendingAgentSwitchForSession(sessionId: string): void {
  cancelPendingAgentSwitchHolder?.(sessionId);
}

/**
 * IM 渠道直发专用: 在同一把 send 锁内, 先跑 `syncUnderLock`(渠道默认跟随对齐),
 * 再按普通直发语义应用待切换意图。`syncUnderLock` 抛错会让本条消息失败,
 * 调用方必须自行吞掉非致命错误。
 */
export async function acquirePendingAgentSwitchForImSend(
  sessionId: string,
  syncUnderLock: () => Promise<boolean | void>,
): Promise<() => void> {
  const lease = await pendingAgentSwitchApplyHolder?.(sessionId, undefined, undefined, syncUnderLock);
  return lease?.release ?? (() => {});
}

/** 会话上待应用的切换意图目标(用户挑的或系统登记的)读回投影。 */
export interface PendingAgentSwitchRouteRead extends Omit<SessionRouteSelection, 'fastMode'> {
  /**
   * 意图在 pending 注册表的修订号(set / clear 都推进)。与跟随记录里的 pendingRev
   * 相等 = 同一次登记; 用户重新挑过(哪怕选了同值)会换号, 据此不把用户选择
   * 误认成系统登记的跟随意图(PR #5155 review P1)。
   */
  rev?: number;
}

/** 会话上待应用的切换意图目标(用户挑的或系统登记的); 无意图返回 undefined。 */
export function readPendingAgentSwitchRoute(
  sessionId: string,
): PendingAgentSwitchRouteRead | undefined {
  return readPendingAgentSwitchRouteHolder?.(sessionId);
}

/**
 * 系统发起的整条路由切换(与伙伴模型对齐同一套): 登记意图, 会话空闲时当场应用;
 * `route` 传 null = 只应用此前登记、仍待生效的意图。
 * 调用方必须已持有该会话的 send 锁(acquirePendingAgentSwitchForImSend 的回调内)。
 * 返回 'staged' = 会话忙(或切换已过 commit 点、恢复尾段待重试), 意图留待安全边界
 * 应用。应用失败会撤回本次意图后抛错 —— 包括底层按 fail-continue 吞掉的跨引擎
 * 应用失败: 那种失败留下的意图不能伪装成「任务正忙」让上层反复重试同一个必然
 * 失败的切换(PR #5155 review P1)。
 */
export async function applySessionRouteUnderSendLock(
  sessionId: string,
  route: SessionRouteSelection | null,
  currentAgentKind: AgentKind,
): Promise<'applied' | 'staged'> {
  const apply = applySessionRouteUnderSendLockHolder;
  if (!apply) throw new Error('Session route selection is not initialized');
  return apply(sessionId, route, currentAgentKind);
}

/** 注册切换后重建会话用的 vendorOptions 解析器; 返回注销函数。 */
export function registerSwitchedSessionVendorOptionsResolver(
  resolve: (sessionId: string) => Record<string, unknown> | undefined,
): () => void {
  switchedSessionVendorOptionsResolvers.add(resolve);
  return () => {
    switchedSessionVendorOptionsResolvers.delete(resolve);
  };
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
  target: { model: string; providerId: string | null; forceSessionRebuild?: boolean; selectionSource?: 'agent' },
): Promise<void> {
  return createPendingCredentialSwitchRegistration({get pendingCredentialSwitchHolder() {return pendingCredentialSwitchHolder;}, maker: getMaker(), getSessionDbAgentKind, getDbClient, captureSessionRuntimeControlOwnerEpoch, getSessionProvider})(sessionId, target);
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

let prepareBotSessionForImSendHolder: ((sessionId: string) => Promise<string | null>) | null = null;

/**
 * IM 直发进伙伴会话(连接已交给伙伴: 主任务 / `channel` 专线)前的守卫, 与桌面
 * `sendToAgentAccepted` 的伙伴部分同源: 伙伴暂停 / 归档 / 归属不完整时返回拒绝原因
 * (调用方回一句渠道提示, 不发送); 否则先对齐伙伴模型链首选路由、再刷新能力纪元。
 * 不持有 send 锁 —— 调用方必须在 acquirePendingAgentSwitch 之前调用, 对齐登记的
 * 切换意图由随后的锁内应用落实。非伙伴会话直接放行。holder 未就绪时放行。
 */
export async function prepareBotSessionForImSend(sessionId: string): Promise<string | null> {
  return prepareBotSessionForImSendHolder ? prepareBotSessionForImSendHolder(sessionId) : null;
}

let applyPiImModelSelectionHolder: ((
  sessionId: string, model: string, providerId: string | null | undefined,
  previousRoute: { model: string; providerId: string | null } | null,
  options?: { refreshPiConfiguration?: boolean; source?: 'user' | 'agent' },
) => Promise<{ status: 'applied' | 'deferred'; generation?: number; effectiveProviderId?: string | null }>) | null = null;

/** IM model cards already own the send lock; reuse Desktop's window-safe Pi transaction. */
export async function applyPiImModelSelectionUnderLock(
  sessionId: string, model: string, providerId: string | null | undefined,
  previousRoute: { model: string; providerId: string | null } | null,
  options?: { refreshPiConfiguration?: boolean; source?: 'user' | 'agent' },
): Promise<{ status: 'applied' | 'deferred'; generation?: number; effectiveProviderId?: string | null }> {
  if (!applyPiImModelSelectionHolder) throw new Error('Pi model selection is not ready');
  return applyPiImModelSelectionHolder(sessionId, model, providerId, previousRoute, options);
}

export function getPendingCredentialSwitchTarget(
  sessionId: string,
): { model: string; providerId: string | null; forceSessionRebuild?: boolean; selectionSource?: 'agent' } | undefined {
  const pending = pendingCredentialSwitchHolder?.get(sessionId);
  return pending ? { model: pending.model, providerId: pending.providerId,
    ...(pending.forceSessionRebuild ? { forceSessionRebuild: true } : {}),
    ...(pending.selectionSource ? { selectionSource: pending.selectionSource } : {}) } : undefined;
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
  /** Routine dispatch preserves the teammate's current planning preference. */
  inheritTargetPlanMode?: boolean;
  /** 发给 agent 的正文(可含静默运行隐藏协议后缀)。 */
  text: string;
  /** 落库与队列气泡展示的用户原始 prompt(不含隐藏协议)。 */
  persistedContent: string;
  origin: { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId?: string };
  /** Runs under the send lock before the live session is captured or a user row is written. */
  onPreparing?: () => Promise<void>;
  /** Reject the queued run if preparation fails before dispatch. */
  onPreparationFailed?: (error: unknown) => void;
  /** 排队项被 drain 派发、turn 已被会话接受时回调(等价直发路径的 send onAccepted)。 */
  onAccepted: (queuedPermissions?: { permissionMode?: string; planMode?: boolean }) => void | Promise<void>;
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
export type SchedulerEnqueueResult = { clientId: string } | { duplicate: true } | { retry: true };

interface SchedulerQueueBridge {
  ensureQueueRestored(sessionId: string): Promise<boolean>;
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
const schedulerQueuedPromptPreparations = new Map<string, {
  onPreparing: () => Promise<void>;
  onPreparationFailed?: (error: unknown) => void;
}>();

export async function ensureSchedulerQueueRestored(sessionId: string): Promise<boolean> {
  // 桥未就绪时不能把未知队列当成空闲；让 runner 沿用恢复待定的顺延路径。
  return schedulerQueueBridgeHolder?.ensureQueueRestored(sessionId) ?? false;
}

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

const originalSessionActivityBridge = createSessionActivityBridge({
  log, getAgentIslandService, isSessionHiddenSync, isKnownOrcaWorkerSession,
  isRemoteAuthRetryErrorEvent, isGatewayProxyTokenRecoveryErrorEvent,
  getCoordinator: () => agentInputCoordinatorHolder,
  getBookkeeping: () => autoResumeBookkeeping,
  getSession: id => sessionBindings.getSession(id),
});
const { sessionMetaForIsland, handleAgentIslandEventAfterBroadcast, isAgentIslandCompletionTail, surfaceSuppressedAutoResumeErrorInAgentIsland, handleAgentIslandInteractionAfterBroadcast, handleAgentIslandInteractionDismissed, handleAgentIslandInteractionDismissedByRequestId, handleAgentIslandSessionClosedAfterCleanup, handleAgentIslandSessionStopped, shouldNotifyAgentIslandForSession, clearSuppressedOrcaWorkerAgentIslandSession, notifyAgentIslandUserPrompt, dispatchAgentIslandUserPrompt, commitAgentIslandUserPrompt, rollbackAgentIslandUserPrompt } = originalSessionActivityBridge;
function isRemoteAuthRetryErrorEvent(...args:Parameters<typeof originalSessionEventGuards.isRemoteAuthRetryErrorEvent>):ReturnType<typeof originalSessionEventGuards.isRemoteAuthRetryErrorEvent>{return originalSessionEventGuards.isRemoteAuthRetryErrorEvent(...args);}

function isGatewayProxyTokenRecoveryErrorEvent(sessionId: string, event: AgentEvent): boolean {
  return isGatewayProxyTokenRecoveryErrorEventForProvider(getSessionProvider(sessionId), event);
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

export function listInTurnSessionIds(maker?: Pick<Maker, 'listActiveSessions'> | null): string[] {
  return collectInTurnSessionIds(sessionTurnActivityTracker, maker?.listActiveSessions() ?? []);
}

/**
 * /goal 生命周期旁路(setter 注入避免 register↔goal-host 环):
 *  - goalClearObserver:clear-context(INPUT_CLEAR_SESSION)时清除该会话目标(上下文已抹,目标失去依据)。
 *  - goalIdleObserver:会话 turn 收尾(idle)时让 controller 兜底续跑 active 目标(#9,race-free,见 controller.maybeContinueActiveGoal)。
 *  - goalDeferredResumeCancelObserver:非 abort 的 session close/replacement 取消一次性 Resume，
 *    防止同 sessionId 的后续实例被迟到 idle 误唤醒。
 *  - goalStopObserver:用户 Stop 当前 turn(ABORT_SESSION)时把 active 目标暂停。调用 observer
 *    会同步 detach 监听/续跑资格；paused 持久化与 vendor abort 并行，回执等落盘收口。
 * bootstrap 在启动期接上对应 GoalController API。
 */
let goalClearObserver: ((sessionId: string) => void) | null = null;
export function setGoalClearObserver(observer: ((sessionId: string) => void) | null): void {
  goalClearObserver = observer;
}
let goalIdleObserver: ((sessionId: string) => void) | null = null;
export function setGoalIdleObserver(observer: ((sessionId: string) => void) | null): void {
  goalIdleObserver = observer;
}

let goalDeferredResumeCancelObserver: ((sessionId: string) => void) | null = null;
export function setGoalDeferredResumeCancelObserver(
  observer: ((sessionId: string) => void) | null,
): void {
  goalDeferredResumeCancelObserver = observer;
}

/**
 * Shared Goal wake-up boundary after the desktop turn tracker is idle.
 * Normal terminal events and authoritative reconciliation both pass through
 * here; the Goal controller coalesces duplicate or late terminal tails.
 */
function notifyGoalIdleAfterTurnSettled(sessionId: string): void {
  goalIdleObserver?.(sessionId);
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
  observer:
    | ((sessionId: string, answers: Record<string, string>, questions: AskUserQuestions) => void)
    | null,
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
export function installDesktopInteractionListener(session: {
  id: string;
  setInteractionListener: (
    l: ((req: InteractionRequest) => Promise<InteractionDecision>) | null,
  ) => void;
}): void {
  installDesktopInteractionHandler(session, async (req: InteractionRequest, sharedPermission) => {
    const agentIslandInteractionEpoch = shouldNotifyAgentIslandForSession(session.id)
      ? (getAgentIslandService()?.captureInteractionEpoch(session.id) ?? null)
      : null;
    // F1-a Phase 2: interaction(ask_user / plan_review / permission)是 turn 暂停边界,
    // 且不走 onEvent —— 在这把在飞 assistant 文本落库,等价于 renderer 老逻辑在
    // ask_user_question / plan_review case 里的 mid-turn assistant 抢救(只入队、不阻塞)。
    if (
      agentIslandInteractionEpoch !== null &&
      shouldNotifyAgentIslandForSession(session.id) &&
      getAgentIslandService()?.isInteractionCurrent(session.id, agentIslandInteractionEpoch) ===
        false
    ) {
      return defaultDecisionForPending(req.kind, 'stale_turn');
    }
    flushAssistantBlock(session.id);
    // F1-a Phase 5: ask_user / plan_review 的消息本身也收口 main 单点落库(单 persistId,
    // 修 F1 重复),persistId 盖进 payload 让 renderer 用同一 id 建气泡 + answered 回写命中。
    // permission 不建 chat 消息 → persistId 为 undefined。
    const interactionPersistId = onInteractionMessage(
      session.id,
      req as unknown as {
        kind?: unknown;
        requestId?: unknown;
        questions?: unknown;
        plan?: unknown;
        planFilePath?: unknown;
      },
    );
    return new Promise<InteractionDecision>((resolve) => {
      const boundaryRequest: InteractionRequest =
        req.kind === 'permission'
          ? {
              ...req,
              input: redactToolInputForUntrustedBoundary(
                req.toolName,
                req.input,
              ) as Record<string, unknown>,
            }
          : req;
      const entry: PendingInteractionEntry = {
        sharedPermission,
        sessionId: session.id,
        kind: req.kind,
        resolve,
        request: boundaryRequest,
        persistId: interactionPersistId ?? undefined,
      };
      // 必须先登记 pending,再广播。否则 renderer / device-link 回得太快会打到
      // 「no pending resolver」,确认卡看起来没反应,Codex 最终却记成用户拒绝。
      pendingInteractionResolvers.set(req.requestId, entry);
      if (sharedPermission) {
        bindSharedPermission(req.requestId, entry, sharedPermission);
      } else {
        schedulePendingPermissionTimeout(req.requestId, entry);
      }
      broadcastToAllWindows(MAKER_PUSH.INTERACTION_REQUEST, {
        sessionId: session.id,
        request: boundaryRequest,
        persistId: interactionPersistId,
      });
      handleAgentIslandInteractionAfterBroadcast(
        session as { id: string; agentKind?: unknown; workDir?: unknown; workspaceKind?: unknown },
        boundaryRequest,
        agentIslandInteractionEpoch,
      );
    });
  }, (requestId, decision) => {
    cancelPendingInteraction(requestId, decision);
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
async function settleSilentStopDone(
  sessionId: string,
  reason: 'exhausted' | 'skip' | 'send-failed',
  turnLeaseId: string,
  runtime: NonNullable<ReturnType<Maker['getSession']>>,
  generation: number,
): Promise<void> {
  silentStopTurnLeaseGate.settle(sessionId, turnLeaseId);
  try {
    if (!(await sessionTurnLeaseTracker.markTurnEndedAndCheckIdle(
      sessionId, turnLeaseId, () => runtime.settleHostTurnContinuation(generation),
    ))) {
      log.debug('ignored stale silent-stop settle after a newer turn started', {
        sessionId,
        turnLeaseId,
      });
      return;
    }
  } catch (error) {
    log.warn('silent-stop turn lease settle failed closed', {
      sessionId,
      turnLeaseId,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  void finalizeTurnChangeSet(sessionId, null, 'complete');
  productTurnWallClockTracker.clear(sessionId);
  productTurnUsageTargetTracker.clear(sessionId);
  sessionTurnActivityTracker.scheduleIdleAfterTerminalBroadcast(sessionId);
  noteClaudeSessionTurnState(sessionId, false);
  agentInputCoordinatorHolder?.onTurnEvent(sessionId, 'done');
  settlePendingCredentialSwitch(sessionId, `silent-stop:${reason}`);
  settlePendingSessionRuntimeControlHolder?.(sessionId, `silent-stop:${reason}`);
  deferredCodexRestartHolder?.onSessionSettled();
  gatewayCodexRestartHolder?.onSessionSettled();
  agentInputCoordinatorHolder?.onExternalTurnSettled(sessionId);
  refreshRemoteCodexMcpOnTurnSettledHolder?.(sessionId);
  fireSilentStopSettled(sessionId, reason);
}



/**
 * silent-stop 续跑的 generation 绑定/回滚接线已抽到 silentStopContinuationBinding.ts
 * (可单测,行为测试用真实 sendHostTurnContinuation 驱动)。
 */



function isFencedStaleProductTerminal(...args:Parameters<typeof originalSessionEventGuards.isFencedStaleProductTerminal>):ReturnType<typeof originalSessionEventGuards.isFencedStaleProductTerminal>{return originalSessionEventGuards.isFencedStaleProductTerminal(...args);}

function isFencedStaleSessionTerminal(...args:Parameters<typeof originalSessionEventGuards.isFencedStaleSessionTerminal>):ReturnType<typeof originalSessionEventGuards.isFencedStaleSessionTerminal>{return originalSessionEventGuards.isFencedStaleSessionTerminal(...args);}

interface WiredSessionCloseContext {
  closeReason: ReturnType<typeof getWiredSessionCloseReason>;
  closedDirectAbortBoundary: DirectAbortReconcileBoundary | null;
  preserveAutoResumeIntent: boolean;
}

const deferredProductTurnFailureGate = createDeferredProductTurnFailureGate();

/** Desktop adapters for the instance-owned binding and synchronous close lifecycle. */
const sessionBindings = createSessionBindingLifecycle<WiredSession, WiredSessionCloseContext>({
  log,
  restoreInteractionListener: installDesktopInteractionListener,
  beforeReplace: (session: WiredSession) => {
    // Invalidate delayed callbacks before publishing the replacement instance.
    cancelDirectAbortReconciliation(session.id);
    goalDeferredResumeCancelObserver?.(session.id);
  },
  onBind: (session: WiredSession) => {
    advanceSessionTurnBoundaryGeneration(session.id);
    bindContinuationOnlyAutoResumeLease(session);
    // Auth/gateway and context-overflow recovery can replace the provider
    // runtime before the old renderer reports its final deferred error. Move
    // that logical owner to the replacement; the actual dispatch boundary
    // below retires it if a newer turn has already started.
    deferredProductTurnFailureGate.rebindSession(session.id, session);
  },
  broadcastStatus: (session: WiredSession, status) => {
    broadcastToAllWindows(MAKER_PUSH.STATUS_CHANGED, { sessionId: session.id, status });
  },
  captureCloseContext: (session: WiredSession) => {
    const closeReason = getWiredSessionCloseReason(session);
    const closedDirectAbortBoundary = getDirectAbortBoundaryForClosingSession(session.id, session);
    const preserveAutoResumeIntent =
      shouldPreserveContinuationOnlyAutoResume(session, closeReason) ||
      shouldPreserveSessionRuntimeFallbackAutoResume(session, closeReason) ||
      (closeReason === 'unexpected' && session.wasClosedByRuntime() &&
        agentInputCoordinatorHolder?.hasUsageLimitRecovery(session.id) === true);
    pendingContinuationOnlyAutoResumeRebuilds.delete(session);
    return { closeReason, closedDirectAbortBoundary, preserveAutoResumeIntent };
  },
  cleanupClosedSession: (session: WiredSession, context) => {
    runSessionCloseCleanup(context.preserveAutoResumeIntent, {
      cleanupInteractions: () => cleanupPendingInteractionsForSession(session.id, 'session_closed'),
      preserveAutoResume: () => {
        log.info('preserving scheduled continuation-only auto-resume across provider rebuild', {
          sessionId: session.id,
          attemptToken: agentInputCoordinatorHolder?.getAutoResumeAttemptToken(session.id),
          closeReason: context.closeReason,
        });
      },
      resetAutoResume: () => {
        // Cancelling both the timer and its bookkeeping prevents a closed task
        // from being resurrected or attaching recovery to a replacement runtime.
        interruptedTurnAutoResumeGuard.noteSessionReset(session.id);
        autoResumeBookkeeping.teardown(session.id);
        usageLimitAutoResume.noteSessionClosed(session.id);
      },
      // Read at the coordinator boundary, as before: only a close/rebuild window
      // preserves the signal currently driving that rebuild, not the old queue.
      shouldPreserveInputBoundary: () => rehydrateCloseSuppression.isSuppressed(session.id),
      closeInputCoordinator: (boundaryOptions) => {
        const options = {
          ...boundaryOptions,
          // Requested / rebuild closes own their follow-up; a self-close has no
          // done event, so queued user input would otherwise wait forever.
          // 'unexpected' only means no Maker reason was recorded: direct product
          // closes (IM /new, archive sync) also land there, so require the
          // runtime's own self-close signal before resurrecting the queue.
          wakeQueuedInput: context.closeReason === 'unexpected' && session.wasClosedByRuntime(),
        };
        agentInputCoordinatorHolder?.onSessionClosed(session.id, options);
      },
      cleanupRuntimeState: () => cleanupClosedSessionRuntime(session),
    });
  },
  beforeCloseTeardown: createSessionCloseTeardown<WiredSession>({
    clearCompactRuntimeRefresh: session => botCompactRuntimeRefreshCoordinator.clearForClosedSession(session),
    cancelDirectAbortReconciliation,
    clearPendingFailedTurnPersist: sessionId => { pendingFailedTurnAssistantPersistId.delete(sessionId); },
    isRehydrateCloseSuppressed: sessionId => rehydrateCloseSuppression.isSuppressed(sessionId),
    getProviderGroupSwitchHoldId: sessionId => agentInputCoordinatorHolder?.getProviderGroupSwitchHoldId(sessionId),
    hasPendingProviderGroupContinuation,
    clearDeferredProductTurnFailure: (sessionId, session, options) =>
      deferredProductTurnFailureGate.clearSession(sessionId, session, options),
  }),
  finalizeClosedSession: (session: WiredSession, context) => {
    // 关闭前固化 live 用量（见 sessionLastLiveUsage.ts）：冷 Pi 切模的窗口核实
    // 预检用它代替可能低报的 DB 快照（Greptile P1）。
    rememberSessionLastLiveUsage(session.id, session.getUsageSnapshot?.());
    finalizeSessionClose(context.closedDirectAbortBoundary !== null, {
      clearTurnState: () => {
        sessionTurnActivityTracker.deleteSession(session.id);
        sessionTurnBoundaryGenerationById.delete(session.id);
        markSessionTurnEndedOnClose(session.id);
      },
      notifyGoalIdle: () => notifyGoalIdleAfterTurnSettled(session.id),
      cancelGoalResume: () => goalDeferredResumeCancelObserver?.(session.id),
    });
  },
});

/** Called only when the outgoing Maker is actually discarded, not on any error status. */
export function releaseSessionBindingsForOwnerBoundary(): void {
  sessionBindings.releaseForOwnerBoundary();
}

let pluginTaskServiceForCurrentOwner: (() => PluginTaskService) | null = null;
let drainPluginTaskReceipts: (() => Promise<void>) | null = null;
export async function flushPluginTaskLifecycle(): Promise<void> {
  await drainPluginTaskReceipts?.();
}
function notePluginTaskLifecycle(operation: (service: PluginTaskService) => Promise<unknown>): void {
  if (!pluginTaskServiceForCurrentOwner) return;
  try { void operation(pluginTaskServiceForCurrentOwner()).catch(() => log.warn('Plugin task receipt update failed')); }
  catch { /* Database is unavailable during logout/startup; never switch to another owner. */ }
}

function isCurrentProductTurnFailureOwner(owner: ProductTurnFailureOwner): boolean {
  const bound = sessionBindings.getSession(owner.sessionId);
  // A closed owner may still receive its renderer's final deferred-persist IPC.
  // If a replacement is already bound, the old identity is stale; while no
  // replacement exists, the captured Session/generation remains authoritative.
  if (bound && bound !== owner.session) return false;
  if (owner.session.instanceId !== owner.instanceId) return false;
  try {
    return owner.session.getTurnGeneration() === owner.generation;
  } catch {
    return false;
  }
}

async function finishProductTurn(
  sessionId: string,
  owner?: ProductTurnFailureOwner,
): Promise<void> {
  if (owner) {
    deferredProductTurnFailureGate.clear(owner);
    if (!isCurrentProductTurnFailureOwner(owner)) return;
  }
  await finishUpstreamMergeTurn(sessionId);
}

async function interruptProductTurn(
  sessionId: string,
  owner?: ProductTurnFailureOwner,
): Promise<void> {
  if (owner) {
    deferredProductTurnFailureGate.clear(owner);
    if (!isCurrentProductTurnFailureOwner(owner)) return;
  }
  if (owner) notePluginTaskLifecycle(service => service.settle(sessionId, owner.originalExecution ?? owner, 'failed'));
  await interruptUpstreamMergeTurn(sessionId);
}

/** Remaining domain cleanup stays in its original order, after input coordination. */
function cleanupClosedSessionRuntime(session: WiredSession): void {
  // 会话关闭:兑现延迟凭证切换(直接写 route),并唤醒被它挡住的等待者。
  pendingCredentialSwitchHolder?.onSessionClosed(session.id);
  deferredCodexRestartHolder?.onSessionSettled();
  gatewayCodexRestartHolder?.onSessionSettled();
  agentInputCoordinatorHolder?.onExternalTurnSettled(session.id);
  try {
    refreshRemoteCodexMcpOnTurnSettledHolder?.(session.id);
  } catch (error) {
    log.warn('optional remote MCP refresh failed during session close', {
      sessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  gitSnapshotCoordinator?.onSessionClosed(session.id);
  clearOrcaMcpHydrated(session.id);
  knownNonOrcaSessionIds.delete(session.id);
  appliedContextWindowBudgets.delete(session.id);
  pendingSessionContextWindowBudgetReconciles.delete(session.id);
  lastReportedCostUsdBySession.delete(session.id);
  lastReportedModelUsageBySession.delete(session.id);
  turnModelPromiseBySession.delete(session.id);
  turnUsageContextBySession.delete(session.id);
  productTurnWallClockTracker.clear(session.id);
  productTurnUsageTargetTracker.clear(session.id);
  claudeOutputLagTimingGuard.clear(session.id);
  // 后台活动检测:会话进程已关闭(closeSession / 删除),清账并广播横幅熄灭。
  clearClaudeSessionBackgroundActivity(session.id);
  clearSessionPersistState(session.id);
  const subagentRewindStateCleared = clearSubagentObservationRewindState(session.id);
  if (!subagentRewindStateCleared) {
    log.warn('session close deferred active Subagent Rewind cleanup', {
      sessionId: session.id,
    });
  }
  // 进程关闭 ≠ 通知作废:临时会话调度(非 heartbeat / 非 persistentSession)在 run
  // 终态后立刻 closeSession,此刻完成卡片刚在灵动岛上弹出来。硬删条目会让它当场
  // 消失,所以这条路径保留仍在展示的卡片,由 dwell 到期或用户 ack 收掉。
  handleAgentIslandSessionClosedAfterCleanup(session.id, 'process-closed');
}

// Keep holder reads live, including reads after an awaited pricing/persistence
// operation. Capturing these services when wiring a Session would freeze the
// pre-initialization or previous runtime value for later events.
const sessionEventDependencies: SessionEventDependencies = {
  onPluginTaskTerminal: (sessionId, execution, outcome, outputMessageId) => {
    notePluginTaskLifecycle(service => service.settle(sessionId, execution, outcome, outputMessageId));
  },
  onSuccessfulProductTurn: finishProductTurn,
  onUnsuccessfulProductTurn: interruptProductTurn,
  deferUnsuccessfulProductTurn: (owner) => deferredProductTurnFailureGate.defer(owner),
  get botCompactRuntimeRefreshCoordinator() { return botCompactRuntimeRefreshCoordinator; },
  get wireNoteMemory() { return wireNoteMemory; },
  get attemptBotCompactRuntimeRefresh() { return attemptBotCompactRuntimeRefresh; },
  get botDelegationServiceHolder() { return botDelegationServiceHolder; },
  get botGroupChatServiceHolder() { return botGroupChatServiceHolder; },
  get isFencedStaleSessionTerminal() {
    return isFencedStaleSessionTerminal;
  },
  get log() {
    return log;
  },
  get usageLimitAutoResume() {
    return usageLimitAutoResume;
  },
  get interruptedTurnAutoResumeGuard() {
    return interruptedTurnAutoResumeGuard;
  },
  get redactEventForRenderer() {
    return redactEventForRenderer;
  },
  get handleAgentIslandInteractionDismissed() {
    return handleAgentIslandInteractionDismissed;
  },
  get clearPendingInteraction() {
    return clearPendingInteraction;
  },
  get defaultDecisionForPending() {
    return defaultDecisionForPending;
  },
  get persistInteractionDecision() {
    return persistInteractionDecision;
  },
  get broadcastToAllWindows() {
    return broadcastToAllWindows;
  },
  get broadcastCodexImageAsToolResult() {
    return broadcastCodexImageAsToolResult;
  },
  get autoResumeBookkeeping() {
    return autoResumeBookkeeping;
  },
  stashProviderGroupHeldError: (sessionId, holdId, data, agentMeta) =>
    providerGroupHeldErrors.stash(sessionId, holdId, data, agentMeta),
  stashProviderGroupHeldWorkerTerminal: (sessionId, holdId, terminal, groupTerminal) =>
    providerGroupHeldTerminals.stash(sessionId, holdId, { orcaTerminal: terminal, groupTerminal: groupTerminal ?? null }),
  get pendingFailedTurnAssistantPersistId() {
    return pendingFailedTurnAssistantPersistId;
  },
  get silentStopAutoResumeGuard() {
    return silentStopAutoResumeGuard;
  },
  get sessionTurnActivityTracker() {
    return sessionTurnActivityTracker;
  },
  get productTurnWallClockTracker() {
    return productTurnWallClockTracker;
  },
  get productTurnUsageTargetTracker() {
    return productTurnUsageTargetTracker;
  },
  get advanceSessionTurnBoundaryGeneration() {
    return advanceSessionTurnBoundaryGeneration;
  },
  get gitSnapshotCoordinator() {
    return gitSnapshotCoordinator;
  },
  get workerTurnStartSequencer() {
    return workerTurnStartSequencer;
  },
  get orcaTeamServiceForEvents() {
    return orcaTeamServiceForEvents;
  },
  get turnModelPromiseBySession() {
    return turnModelPromiseBySession;
  },
  get readSessionModelForUsage() {
    return readSessionModelForUsage;
  },
  get turnUsageContextBySession() {
    return turnUsageContextBySession;
  },
  get silentStopTurnLeaseGate() {
    return silentStopTurnLeaseGate;
  },
  get agentInputCoordinatorHolder() {
    return agentInputCoordinatorHolder;
  },
  get handleSilentStopTurnEnd() {
    return handleSilentStopTurnEnd;
  },
  get isRemoteAuthRetryErrorEvent() {
    return isRemoteAuthRetryErrorEvent;
  },
  get isGatewayProxyTokenRecoveryErrorEvent() {
    return isGatewayProxyTokenRecoveryErrorEvent;
  },
  get overflowSuppressedBroadcasts() {
    return overflowSuppressedBroadcasts;
  },
  get handleAgentIslandEventAfterBroadcast() {
    return handleAgentIslandEventAfterBroadcast;
  },
  // 智能体不回报所用 Key:走「按当前 Key、不占用触发机会」的入口(见 gatewayKeyRejection.ts)。
  reportAgentCindyGatewayKeyRejected: reportCindyGatewayKeyRejectedForCurrentKey,
  get notifyGoalIdleAfterTurnSettled() {
    return notifyGoalIdleAfterTurnSettled;
  },
  get settlePendingCredentialSwitch() {
    return settlePendingCredentialSwitch;
  },
  get settlePendingSessionRuntimeControlHolder() {
    return settlePendingSessionRuntimeControlHolder;
  },
  get deferredCodexRestartHolder() {
    return deferredCodexRestartHolder;
  },
  get gatewayCodexRestartHolder() {
    return gatewayCodexRestartHolder;
  },
  get refreshRemoteCodexMcpOnTurnSettledHolder() {
    return refreshRemoteCodexMcpOnTurnSettledHolder;
  },
  get markTurnEndedAfterPersistDrain() {
    return markTurnEndedAfterPersistDrain;
  },
  get contextOverflowRolloverHolder() {
    return contextOverflowRolloverHolder;
  },
  get lastReportedModelUsageBySession() {
    return lastReportedModelUsageBySession;
  },
  get claudeOutputLagTimingGuard() {
    return claudeOutputLagTimingGuard;
  },
  get lastReportedCostUsdBySession() {
    return lastReportedCostUsdBySession;
  },
  get unpricedSubscriptionValueMarker() {
    return unpricedSubscriptionValueMarker;
  },
};

const sessionTurnObserverDependencies = {
  beforeLocalProviderStart: (session: Session) =>
    withCindyMakeProjectUse(app.getPath('userData'), session.workDir, async () => undefined),
  silentStopTurnLeaseGate,
  sessionTurnLeaseTracker,
  providerTurnLeaseId,
  log,
};

export function wireSessionToIpc(session: ReturnType<Maker['getSession']>): void {
  if (!session) return;
  const registration = sessionBindings.beginBinding(session);
  if (!registration) return;

  registration.disposers.push(installSessionTurnObserver(sessionTurnObserverDependencies, session));

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
    clearPendingTurnChangeSets(session.id);
  });
  registration.disposers.push(
    session.onEvent((event: AgentEvent) => {
      if (isFencedStaleSessionTerminal(session.id, event)) return;
      noteTurnDiffEvent(session.id, event, session.remoteHostId !== null);
      ghostSessionTap.handleEvent(
        event as { type: string; data?: unknown; source?: string; turnOrigin?: { kind?: string } },
      );
    }),
  );

  // 转发事件到所有 window。interaction_dismissed 单独走专用 channel,
  // 让 renderer chat store 不必扫所有 vendor-raw 找它。
  // Host recovery is a dedicated Session channel so Orca/Learn product
  // listeners never treat it as turn text; Desktop persist/broadcast still
  // consumes the localized notice.
  const emitWiredSessionEvent = (event: AgentEvent) => {
    if (event.type === 'plan_mode_changed') {
      const enabled = (event.data as { enabled?: unknown })?.enabled;
      if (typeof enabled === 'boolean') {
        // Do not block event consumption/turn lease release on this queue.
        void withSessionPermissionChange(session.id, async () => {
          if (!ownerDb || ownerDb !== getCurrentDbClientSnapshot()
            || sessionBindings.getSession(session.id) !== session
            || session.getPlanMode() !== enabled) return;
          await persistSessionFields(session.id, {planModeEnabled: enabled});
        }).catch((error) => log.warn('persist plan_mode_changed failed', {sessionId: session.id, error: String(error)}));
      }
      return;
    }
    handleSessionEvent(ownerEventDependencies, session, event);
  };
  const ownerDb = getCurrentDbClientSnapshot();
  const ownerEventDependencies = Object.create(sessionEventDependencies) as SessionEventDependencies;
  Object.defineProperty(ownerEventDependencies, 'onPluginTaskTerminal', {
    value: (...args: Parameters<NonNullable<SessionEventDependencies['onPluginTaskTerminal']>>) => {
      if (!ownerDb || getCurrentDbClientSnapshot() !== ownerDb) return;
      sessionEventDependencies.onPluginTaskTerminal?.(...args);
    },
  });
  // 「远程与分享」页按使用方的用量：本机自己的任务记在当前账号的账本里，换了账号之后的迟到事件不记。
  Object.defineProperty(ownerEventDependencies, 'recordProviderPartyUsage', {
    value: (target: Session, event: AgentEvent) => {
      if (!ownerDb || getCurrentDbClientSnapshot() !== ownerDb) return;
      try {
        recordSessionProviderPartyUsage({
          providerOf: getSessionProvider,
          bindingOf: readProviderGroupBinding,
          selfDeviceId: getSelfDeviceId,
          record: (usage) => currentProviderPartyUsageStore().record({ kind: 'local' }, usage),
          // 经另一台电脑的组、在组里别的电脑上运行：组所在电脑经手不到，记下来报告给它(provider-groups.md §7)。
          recordForGroup: ({ groupDeviceId, ...usage }) => {
            const day = currentProviderPartyUsageStore().record({ kind: 'group', deviceId: groupDeviceId }, usage);
            if (day) notifyProviderGroupUsage(groupDeviceId, day);
          },
        }, target, event);
      } catch (error) {
        log.warn('record provider party usage failed', { sessionId: target.id, error: String(error) });
      }
    },
  });
  registration.disposers.push(session.onEvent(emitWiredSessionEvent));
  registration.disposers.push(session.onRuntimeRecovery(emitWiredSessionEvent));
  sessionBindings.attachStatusListener(registration);

  // 注入 interaction listener (permission/ask/plan 三合一,renderer 按 kind 弹不同 UI)
  installDesktopInteractionListener(session);
  installInteractionLifecycleObserver(session, {
    onStart: (request, route) => {
      ghostSessionTap.interactionObserver.onStart(request, route);
      void botDelegationServiceHolder?.handleInteractionStart(session.id, request).catch((error) => {
        log.warn('failed to project child interaction to requesting Bot', {
          sessionId: session.id,
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    onEnd: (request, route) => {
      ghostSessionTap.interactionObserver.onEnd(request, route);
      void botDelegationServiceHolder?.handleInteractionEnd(session.id, request).catch((error) => {
        log.warn('failed to clear child interaction for requesting Bot', {
          sessionId: session.id,
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
}

/**
 * Backward-compat alias for feishu /ctr code (im/feishu/runAgentTurn.ts) that
 * imports `wireSessionToIpcExternal`. Module-top export of wireSessionToIpc
 * makes the holder pattern unnecessary, but keeping the alias avoids touching
 * unrelated feishu code in this merge.
 */
export const wireSessionToIpcExternal = wireSessionToIpc;

type SendToSessionDispatchSession = {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  remoteHostId: string | null;
  send(message: UserMessage | string, opts?: SessionSendOptions): Promise<SessionSendResult>;
};

/** Starts exact turn capture at the accepted, durable user-message boundary. */
export async function beginTurnChangeSetAtDispatch(
  session: SendToSessionDispatchSession,
  anchorClientId: string,
): Promise<void> {
  await waitForTurnChangeSetSeal(session.id);
  await finalizeTurnChangeSet(session.id, null, 'partial');
  await waitForTurnChangeSetSeal(session.id);
  await beginTurnChangeSet({
    sessionId: session.id,
    anchorClientId,
    provider: session.agentKind,
    cwd: session.workDir,
    remote: session.remoteHostId !== null,
  });
}

async function confirmReviewExternalArtifacts(
  event: IpcMainInvokeEvent,
  items: ReviewArtifactConfirmationItem[],
): Promise<boolean> {
  // Remote invokes have no Renderer sender. Until this confirmation has a
  // remote UI, retain the explicit-grant requirement rather than auto-approve.
  if (isDeviceLinkInvoke()) return false;
  return confirmReviewArtifacts(event, items);
}

export interface RegisterMakerIpcOptions {
  /** Reuse the normal settings save notifications, including credential-generation invalidation. */
  builtinApiKeyDeps: BuiltinApiKeyBridgeDeps;
  onAnySessionTurnKeepaliveChange?: (isRunning: boolean) => void;
  /** 由 bootstrap 注入，避免 maker-ipc → model-access → maker-host 的循环依赖。 */
  refreshXdGatewayModels(): Promise<void>;
  /** DB 可读后仍在后台运行的账号模型发现；新建 / 懒恢复路由前必须等待。 */
  waitForAccountProviderModelsReady(): Promise<void>;
  /** Provider 刷新协调器已可用；紧跟 configure 发出，避免后续 handler 失败造成永久等待。 */
  onProviderModelAutoRefreshConfigured(): void;
}

let disposePiPackagesChangedBroadcast: (() => void) | null = null;

/**
 * Preselects a route in the local new-task draft, the same push the app-default model
 * selection uses. The menu bar calls it before opening a new task for one account.
 */
export function applyNewMakerDraftRoute(route: BotModelRoute): void {
  broadcastToAllWindows(MAKER_PUSH.DRAFT_PREF_APPLY, {
    agent: route.harness === 'claude' ? 'claude-code' : route.harness,
    providerId: route.providerId ?? '',
    modelId: route.model,
    active: true,
    ...(route.effort ? { effort: route.effort } : {}),
    ...(route.fastMode ? { fast: route.fastMode } : {}),
  });
}

/**
 * Register before the first BrowserWindow: modelVisibilityPrefs mirrors its initial snapshot as
 * soon as the Renderer selects an owner, before the splash-gated Maker IPC bundle is available.
 */
export function registerModelVisibilitySyncIpc(): void {
  registerModelFavoritesSync(broadcastToAllWindows);
  configureAppDefaultModelSelection((appDefaultSelection) => {
    broadcastToAllWindows(MAKER_PUSH.DRAFT_PREF_APPLY, {
      agent: appDefaultSelection.route.harness === 'claude' ? 'claude-code' : appDefaultSelection.route.harness,
      providerId: appDefaultSelection.route.providerId ?? '', modelId: appDefaultSelection.route.model,
      active: true, appDefaultSelection,
    });
  });
  // Register with model visibility before the first window; a cold-start preference
  // push must not be lost while the larger Maker bundle is still initializing.
  ipcMain.on(MAKER_SEND.SYNC_NEW_MAKER_DRAFT, (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (syncNewMakerDraftCache(payload, getActiveDataOwnerPushStamp(),
      activeOwnerScopeKey(), isAppSessionBoundaryPending())) broadcastNewMakerDraftChanged();
  });

  ipcMain.handle(
    MAKER_INVOKE.MODEL_VISIBILITY_SYNC,
    async (event, dataOwnerId: unknown, ownerGeneration: unknown, map: unknown, policy?: unknown) => {
      assertTrustedAppRendererEvent(event);
      syncModelVisibilityMirrorForOwner(
        map,
        { dataOwnerId, ownerGeneration },
        getActiveDataOwnerPushStamp(),
        isAppSessionBoundaryPending(),
        () => {
          broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {});
        },
        policy,
      );
    },
  );
}

export function registerMakerIpc(maker: Maker, options: RegisterMakerIpcOptions): void {
  setImportProbeConfirmation((sessionId, request, signal) => {
    // Canonical companion tasks exist before a harness is launched. Reuse the
    // same pending resolver and remote/UI routes without starting a model turn.
    const live = maker.getSession(sessionId);
    const target = live ?? { id: sessionId, setInteractionListener: () => {} };
    if (!live) installDesktopInteractionListener(target);
    return live ? live.runHostInteraction(request, () => requestHostInteraction(target, request, signal))
      : requestHostInteraction(target, request, signal);
  });
  // Catalog updates and explicit budget edits share one serial refresh boundary.
  let contextRefresh = Promise.resolve();
  let applyPiModelSettingsRefresh: (sessionId: string, model: string, providerId: string | null) => Promise<void> =
    async () => { throw new Error('Pi model settings refresh is not ready'); };
  let applyPiPendingSelection: NonNullable<PendingCredentialSwitchDeps['applyPiPending']> =
    async () => { throw new Error('Pi pending model switch is not ready'); };
  let followMovedCindyAutoRoutesNow: () => Promise<void> = async () => {};
  const refreshContextSettings = (targets?: readonly { agent: AgentKind; providerId: string; modelId: string }[]) => {
    const owner = getActiveAppSession();
    const next = contextRefresh.then(async () => {
      // 目录刷新先登记被服务端挪走的 Auto：之后的上下文刷新会跳过已登记切换的任务，
      // 不再按旧来源重载一个已不提供该模型的连接。
      if (!targets) {
        await followMovedCindyAutoRoutesNow().catch((error) =>
          log.warn('Cindy Auto provider follow failed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }).then(() => refreshActiveModelContextSettings({
      targets, inferProviderId: (model, agent) => resolveDesktopModelContextProviderId(getActiveCatalog(), agent, null, model),
      withSessionLock: withSendToSessionLock,
      applyPiRefresh: applyPiModelSettingsRefresh,
      hasPendingSelection: (sessionId) => {
        const pending = getPendingSessionRuntimeMutation(sessionId);
        return !!agentSwitchPending.get(sessionId) ||
          (!!pending && isPendingSessionRuntimeRouteExplicit(sessionId, pending.generation));
      },
      assertCurrent: () => {
        if (getActiveAppSession().generation !== owner.generation) throw new Error('Account changed during context configuration');
      },
      runtime: {
        maker, isSessionInTurn,
        registerPendingCredentialSwitch: registerPendingCredentialSwitchForSession,
        clearPendingCredentialSwitch: clearPendingCredentialSwitchForSession,
        wakeSessionInputQueue: wakeSessionInputAfterCredentialSwitch,
        getPendingCredentialSwitch: getPendingCredentialSwitchTarget,
        codexAuthInjection: getCodexProxyAuthInjectionState(), logger: log,
      },
    }));
    contextRefresh = next.catch(() => {});
    return next;
  };
  setModelContextRuntimeRefreshListener(() => {
    if (!getMakerIfReady()) return;
    void refreshContextSettings().catch((error) => log.warn('model default context refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    }));
  });

  setSessionTextSnapshotReader(getSessionTextSnapshot);
  log.info('registering maker:* IPC handlers');
  const broadcastSessionRuntimeProjection = async (
    sessionId: string,
    baselineOverride?: SessionRuntimeProfile,
  ): Promise<void> => {
    const [saved] = await getDbClient().drizzle
      .select({ value: sessions.scheduledModelBaseline }).from(sessions)
      .where(eq(sessions.id, sessionId)).limit(1);
    const scheduledBaseline = parseScheduledModelBaseline(saved?.value);
    if (scheduledBaseline) {
      broadcastSessionPatched(sessionId, projectScheduledPreferences(sessionId, scheduledBaseline));
      return;
    }
    let baseline = baselineOverride;
    if (!baseline) {
      const [row] = await getDbClient()
        .drizzle.select({
          agentKind: sessions.agentKind,
          model: sessions.model,
          providerId: sessions.providerId,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) return;
      baseline = {
        agentKind: dbToMakerAgentKind(row.agentKind),
        model: row.model,
        providerId: row.providerId?.trim() || null,
        effort: row.effort,
        fastMode: (row.fastMode === 'ultrafast' ? 'ultrafast' : row.fastMode === true),
      };
    }
    broadcastSessionPatched(
      sessionId,
      projectSessionRuntimeControl(sessionId, baseline) as Record<string, unknown>,
    );
  };
  const projectScheduledPreferences = createScheduledModelProjection(projectSessionRuntimeControl);
  setSessionRuntimeProjector((session) => {
    const baseline = parseScheduledModelBaseline(session.scheduledModelBaseline);
    if (baseline) return projectScheduledPreferences(session.id, baseline);
    return projectSessionRuntimeControl(session.id, {
      agentKind: dbToMakerAgentKind(session.agentKind),
      model: session.model,
      providerId: session.providerId?.trim() || null,
      effort: session.effort as SessionRuntimeProfile['effort'],
      fastMode: session.fastMode,
    });
  });
  setSessionRuntimeCleanup((sessionId) => {
    // 任务在另一台电脑上还没启动完：让那台停下，不再迟到地启动、跑完这一轮。
    cancelPendingRemoteStart(sessionId);
    workingDirectoryRecovery.discard(sessionId);
    clearSessionRuntimeControlState(sessionId);
    clearSessionProvider(sessionId);
    setSessionEffort(sessionId, null);
    setSessionFastMode(sessionId, false);
    void broadcastSessionRuntimeProjection(sessionId).catch((error) => {
      log.debug('session runtime cleanup projection failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
  disposePiPackagesChangedBroadcast?.();
  disposePiPackagesChangedBroadcast = onPiPackagesChanged((origin) => {
    void invalidateLocalPiPackageRuntimesForObservedChange(maker, origin)
      .then((invalidation) => {
        if (invalidation && invalidation.failedSessionIds.length > 0) {
          log.warn('Cross-process Pi package change did not retire every local runtime', {
            failedSessionIds: invalidation.failedSessionIds,
          });
        }
      })
      .catch((error) => {
        log.warn('Cross-process Pi package runtime invalidation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(MAKER_PUSH.PI_PACKAGES_CHANGED);
      }
    }
  });
  getAgentIslandService()?.setPermissionResolver(resolvePendingPermissionFromAgentIsland);
  sessionTurnActivityTracker.setTurnKeepaliveChangeListener(
    options.onAnySessionTurnKeepaliveChange ?? null,
  );
  gitSnapshotCoordinator = createGitSnapshotCoordinator(maker);
  // 接上 DB 改名通知(用户手动改名后自动起名收手)与拦截意识探针(装了
  // will-user-message 钩子时不把用户原话送去标题模型)。
  registerSessionAutoTitleHooks({ isUserMessageScreeningActive: hasEnabledUserMessageHookGhost });

  // device-link busy presence:把「本机是否有 turn 在跑」探针注入 device-link host,
  // 它每 5s 取一次、翻转才上报,让控制端设备列表显示 busy 三态(规则 2:回调注入解耦)。
  setDeviceLinkBusyProbe(() => anySessionInTurn(maker));

  // device-link 参数级收敛:远程 create-session 的 workingDir / worktree:create 的 baseRepo
  // 必须是本机当前可访问的目录,挡掉控制端用任意路径越权起进程或执行 git。
  setDeviceLinkRemoteWorkingDirGuard(checkRemoteWorkingDir);
  setDeviceLinkRemoteReviewInputGuard(assertReviewExternalInputAllowed);
  // 远程 xAI 订阅余量只读:该 channel 的 ipcMain handler 挂 assertTrustedSender,
  // device-link 由 dispatch 拦截直读注入的 reader(见 dispatch.ts 同名 setter 注释)。
  setDeviceLinkRemoteXaiSubscriptionUsageReader(readXaiSubscriptionUsageSnapshotForDeviceLink);
  setDeviceLinkRemoteClaudeSubscriptionUsageReader(readClaudeSubscriptionUsageSnapshotForDeviceLink);
  setProviderGroupClaudeUsageReader(readClaudeSubscriptionUsageSnapshotForDeviceLink);
  setProviderGroupCodexUsageReader(readCodexAccountUsageSnapshotWithWebRefresh, readCodexRateLimitsForHost);

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
  initGithubIssueSubmit(
    issueConfirmBridge,
    (sessionId) => turnModelPromiseBySession.get(sessionId) ?? readSessionModelForUsage(sessionId),
  );
  initRenameSessionsConfirm(renameSessionsConfirmBridge);

  // Worker 创建偏好与模型默认值同样以 renderer localStorage 为真源。main 只保留
  // 权限模式镜像，供 Orca UI / MCP 创建路径读取。
  ipcMain.on(
    MAKER_SEND.SYNC_WORKER_CREATION_PREFS,
    createWorkerCreationPrefsSyncHandler({
      assertTrustedSender: (event) =>
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
      setWorkerPermissionMode: (workerPermissionMode) =>
        setWorkerCreationPrefsCache({ workerPermissionMode }),
    }),
  );

  const applyWorkerPermissionModePreference = (
    workerPermissionMode: OrcaWorkerPermissionMode,
  ): void => {
    setWorkerCreationPrefsCache({ workerPermissionMode });
    broadcastToAllWindows(MAKER_PUSH.WORKER_CREATION_PREFS_APPLY, { workerPermissionMode });
  };

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

  ipcMain.handle(MAKER_INVOKE.TURN_CHANGE_SETS_LIST, async (event, sessionId: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
      throwIpcError('INVALID_PARAMS', 'Invalid sessionId');
    }
    return listTurnChangeSets(sessionId);
  });

  ipcMain.handle(
    MAKER_INVOKE.TURN_CHANGE_SETS_GET,
    async (event, sessionId: unknown, ids: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
        throwIpcError('INVALID_PARAMS', 'Invalid sessionId');
      }
      if (
        !Array.isArray(ids) ||
        ids.length > TURN_CHANGE_SET_DETAIL_ID_LIMIT ||
        ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256)
      ) {
        throwIpcError('INVALID_PARAMS', 'Invalid turn change-set ids');
      }
      return getTurnChangeSets(sessionId, ids as string[]);
    },
  );

  const applyRecordedTurnChanges = async (
    sessionId: unknown, id: unknown, action: unknown,
    assertRemoteAccess?: () => Promise<void>,
  ) => {
    const ownerScope = captureDataOwnerBroadcastScope();
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) {
      throwIpcError('INVALID_PARAMS', 'Invalid sessionId');
    }
    if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
      throwIpcError('INVALID_PARAMS', 'Invalid turn change-set id');
    }
    if (action !== 'undo' && action !== 'reapply') {
      throwIpcError('INVALID_PARAMS', 'Invalid turn change-set action');
    }
    const meta = await maker.getSessionMeta(sessionId);
    if (!meta) throwIpcError('NOT_FOUND', 'Task not found.');
    if (meta.remoteHostId) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Remote workspace restore is not available.');
    }
    const normalizedWorkDir = normalizeTurnChangeSetWorkspaceKey(meta.workDir);
    const workspaceIsBusy = (): boolean =>
      maker.listActiveSessions().some((session) => {
        if (session.remoteHostId) return false;
        const currentWorkDir = normalizeTurnChangeSetWorkspaceKey(session.workDir);
        return (
          currentWorkDir === normalizedWorkDir &&
          (session.isTurnRunning() || getClaudeSessionBackgroundActivity(session.id))
        );
      });
    if (workspaceIsBusy() || isSessionTurnPendingCompletion(sessionId)) {
      throwIpcError('SESSION_RUNNING', 'Wait for the current response to finish.');
    }
    await waitForTurnChangeSetSeal(sessionId);
    if (workspaceIsBusy() || isSessionTurnPendingCompletion(sessionId)) {
      throwIpcError('SESSION_RUNNING', 'Wait for the current response to finish.');
    }
    let accessFailure: { error: unknown } | undefined;
    try {
      return await applyTurnChangeSetAction(sessionId, id, action, ownerScope, async () => {
        try {
          await assertRemoteAccess?.();
        } catch (error) {
          accessFailure = { error };
          throw error;
        }
        if (workspaceIsBusy() || isSessionTurnPendingCompletion(sessionId)) {
          throw new TurnChangeSetActionError('busy', 'Wait for the current response to finish.');
        }
      });
    } catch (error) {
      // Preserve only errors from the trusted remote authorization callback; storage
      // and Git errors still pass through the existing sanitized error mapping.
      if (accessFailure && error === accessFailure.error) throw error;
      if (!(error instanceof TurnChangeSetActionError)) {
        log.warn('turn change-set action failed', { sessionId, id, action, error });
        throwIpcError('INTERNAL', 'The recorded changes could not be applied.');
      }
      if (error.kind === 'not-found') throwIpcError('NOT_FOUND', error.message);
      if (error.kind === 'busy') throwIpcError('SESSION_RUNNING', error.message);
      if (error.kind === 'wrong-state') throwIpcError('PRECONDITION_FAILED', error.message);
      if (error.kind === 'git-missing') {
        throwIpcError('TURN_CHANGE_GIT_UNAVAILABLE', error.message);
      }
      if (error.kind === 'unsupported') throwIpcError('UNSUPPORTED_CAPABILITY', error.message);
      if (error.kind === 'conflict') throwIpcError('STALE_DIFF', error.message);
      throwIpcError('INTERNAL', error.message);
    }
  };
  setRemoteTurnChangeAction(applyRecordedTurnChanges);
  ipcMain.handle(
    MAKER_INVOKE.TURN_CHANGE_SET_APPLY,
    (event, sessionId: unknown, id: unknown, action: unknown) => {
      assertTrustedAppRendererEvent(event);
      return applyRecordedTurnChanges(sessionId, id, action);
    },
  );

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
    // 它不经过输入协调器的 Stop(错误与重试入口仍在)：供应商组进行中的换电脑也要作废，
    // 用户停止不换(provider-groups.md §6.1，#5880)。
    noteSessionReset: (sessionId) => {
      resetAutomaticRecoveryForExplicitStop(sessionId);
      providerGroupService?.noteUserAction(sessionId);
    },
    notifyGoalStop: pauseGoalBeforeExplicitStop,
  });

  // 单个后台任务的精确停止(消息流任务卡 / 状态栏停止按钮)。只停指定 taskId,
  // 当前 turn 与其他后台任务不受影响 —— 与上面的会话级止损入口互补。
  registerStopAgentTaskHandler(createElectronIpcHandlerRegistry(), {
    getLiveSession: (sessionId) => maker.getSession(sessionId) ?? undefined,
    stopDetachedTask: async (sessionId, taskId) => {
      const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
      const runRoot = piSubagentRunRoot(agentHome, sessionId);
      // This fallback enumerates durable runs out of a `pi-agent-home` shared
      // with any concurrent dev / packaged / --passive instance, so it reaches
      // runs another live window is driving. Both Subagent stop buttons land
      // here when no handle is loaded, so it needs the same gate as
      // CONTROL_PI_SUBAGENT: discover first, refuse before writing anything.
      const run = (await listPiSubagentRuns(runRoot)).find(
        (candidate) => candidate.taskId === taskId || candidate.runId === taskId,
      );
      if (!run) return false;
      // A terminal run has nothing to write, so gating it would only turn an
      // idempotent stop into an error. Refuse only where a control would land.
      if (!isPiSubagentTerminal(run.state) && !canHostControlPiSubagentRun(run, process.pid)) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'This Subagent run belongs to another running Cindy instance. Control it from that window.',
        );
      }
      return (await controlPiSubagentRuns(runRoot, run.runId, 'stop')) > 0;
    },
  });

  ipcMain.handle(MAKER_INVOKE.CONTROL_PI_SUBAGENT, async (event, input: unknown) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throwIpcError('INVALID_PARAMS', 'PI Subagent control input required');
    }
    const body = input as Record<string, unknown>;
    if (typeof body.sessionId !== 'string' || !body.sessionId) {
      throwIpcError('INVALID_PARAMS', 'sessionId required');
    }
    if (typeof body.taskId !== 'string' || !body.taskId) {
      throwIpcError('INVALID_PARAMS', 'taskId required');
    }
    if (
      body.action !== 'stop' &&
      body.action !== 'steer' &&
      body.action !== 'follow_up' &&
      body.action !== 'resume'
    ) {
      throwIpcError('INVALID_PARAMS', 'action must be stop, steer, follow_up, or resume');
    }
    if (
      body.action !== 'stop' &&
      (typeof body.message !== 'string' || !body.message.trim() || body.message.length > 32_000)
    ) {
      throwIpcError('INVALID_PARAMS', 'message must contain 1..32000 characters');
    }
    const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
    const runRoot = piSubagentRunRoot(agentHome, body.sessionId);
    const runs = await listPiSubagentRuns(runRoot);
    const run = runs.find(
      (candidate) => candidate.taskId === body.taskId || candidate.runId === body.taskId,
    );
    if (!run) throwIpcError('NOT_FOUND', 'PI Subagent run not found');
    if (body.childId !== undefined && (typeof body.childId !== 'string' || !body.childId)) {
      throwIpcError('INVALID_PARAMS', 'childId must be a non-empty string');
    }
    const childId = typeof body.childId === 'string' ? body.childId : undefined;
    if (childId && !run.tasks.some((task) => task.childId === childId)) {
      throwIpcError('NOT_FOUND', 'PI Subagent child not found');
    }
    const terminal = isPiSubagentTerminal(run.state);
    if (body.action === 'resume') {
      const live = maker.getSession(body.sessionId);
      if (!terminal || live?.agentKind !== 'pi') {
        throwIpcError(
          'UNSUPPORTED_CAPABILITY',
          'Resume requires a loaded parent PI task and a terminal run.',
        );
      }
      await live.resumeBackgroundTask(run.taskId, body.message as string, childId);
      return { ok: true, controlled: 1 };
    }
    if (terminal) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'PI Subagent control requires an active run');
    }
    // `pi-agent-home` is shared with any concurrent dev / packaged / --passive
    // instance, so this run may be driven by another live window. Stop, steer
    // and follow-up all write into the runner's mailbox, so refuse before the
    // write and tell the user where the run actually lives. Orphaned and
    // unattributable runs stay controllable on purpose — that is the only way
    // to stop work left behind by a crashed instance.
    if (!canHostControlPiSubagentRun(run, process.pid)) {
      throwIpcError(
        'PRECONDITION_FAILED',
        'This Subagent run belongs to another running Cindy instance. Control it from that window.',
      );
    }
    const controlled = await controlPiSubagentRuns(
      runRoot,
      run.runId,
      body.action,
      body.action === 'stop'
        ? { ...(childId ? { childId } : {}) }
        : { message: body.message as string, ...(childId ? { childId } : {}) },
    );
    return { ok: controlled > 0, controlled };
  });

  // 会话仍在运行的后台任务快照(只读)。renderer 挂载 / reloadMessages 清空
  // taskUpdates 后据此补回存量任务(实时增量仍走 agent_task_update 事件流)。
  ipcMain.handle(MAKER_INVOKE.LIST_SESSION_BACKGROUND_TASKS, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    const live = maker.getSession(sessionId);
    // pendingContinuations:「任务已终态、wake turn 尚未启动或仍在跑」的
    // continuation claim 数。tasks 在任务终态后立即不含该任务,renderer 的
    // 唤醒桥接对账不能拿空 tasks 当「无后续」—— 必须本字段为 0 才允许收口。
    return {
      tasks: live ? live.listBackgroundTasks() : [],
      pendingContinuations: live ? live.countPendingWakeContinuations() : 0,
    };
  });

  // 后台命令输出尾部(只读)。任务卡展开区据此显示「最近输出」与最后写入时间。
  // 入参只有 (sessionId, taskId):输出路径取自该活跃会话仍在运行的后台任务登记
  // (SDK task_started 的 output_file),调用方(renderer / device-link 控制端)无法
  // 指定任意路径。任务已终态、会话不活跃 → unavailable。SSH 远程工作区会话的 CLI
  // 跑在远端,output_file 写在远端,本机读必落空 → 同样 unavailable。
  ipcMain.handle(
    MAKER_INVOKE.READ_BACKGROUND_TASK_OUTPUT_TAIL,
    async (event, sessionId: unknown, taskId: unknown) => {
      // 本机调用只接受已登记的顶层 Cindy 窗口;device-link 隧道调用由 dispatch 层鉴权。
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      if (typeof sessionId !== 'string' || !sessionId) {
        return { ok: false, reason: 'forbidden' } as const;
      }
      try {
        const active = maker.listActiveSessions().find((x) => x.id === sessionId);
        const live = active && !active.remoteHostId ? maker.getSession(sessionId) : undefined;
        return await readSessionBackgroundTaskOutputTail(live, taskId);
      } catch {
        return { ok: false, reason: 'read_failed' } as const;
      }
    },
  );

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
      // host 在 SET_MODEL 的 session lock 内执行 90% 模型窗口保护；旧 host 缺省 false，
      // Mobile 据此对已知受压缩窗降级为 fail closed。
      supportsModelWindowSwitchGuard: true,
      // v2 因果能力：同引擎 no-op 返回 revision，后续 SET_MODEL 在 session 锁内 CAS。
      // 新 desktop 控制端据此与只有基础切换能力的旧 host 做安全兼容门控。
      supportsSessionAgentSwitchCas: true,
      // 新控制端只有看到此位才允许给被控端 Orca Team 选择 Worker Full access。
      // 旧 desktop 缺省为 false，避免显式 bypassPermissions 被旧 handler 静默忽略。
      supportsOrcaWorkerPermissionMode: true,
      // 新控制端只有看到此位，才会让被控端延后 UI initial_task 并在 Lead 首条
      // 输入 accepted 且历史可查询后走 WORKER_DISPATCH_UI_ASSIGNMENT；旧端继续即时派发。
      supportsDeferredOrcaUiAssignment: true,
      // 新控制端只有看到此位，才在 Worker 的模型面板里列出远程供应商并给创建 / 开启协同带
      // agentDeviceId(Worker 的 Agent 所在电脑)；旧 desktop 会静默丢掉这个字段，把 Worker 建在
      // 与 Lead 相同的位置，所以缺省 false 时控制端不提供。
      supportsOrcaWorkerAgentDevice: true,
      // 调度更新支持 intervalMs:null 的显式清空表达(IPC 入口归一化成引擎的
      // 「带 key 的 undefined」)。旧 desktop 缺省为 false——旧引擎会把 null 当
      // 已设间隔算出 now+null 立即触发,mobile 必须据此回退旧 wire 形态(省略
      // key,由旧引擎的隐式清空承担等价语义)。
      supportsScheduleIntervalNullClear: true,
      // New mobile editors only expose/save pre-run commands when the host can persist them.
      supportsSchedulePreRunHook: true,
      // Full scheduled model selection, including bound Harness changes and template overrides.
      supportsScheduleModelSelection: true,
    };
  });

  // device-link 远程草稿镜像(只读):返回某 vendor 在 New Maker 草稿里的当前完整选择
  // (model/effort/fast/permission/source/是否显式选过模型)。控制端经隧道调用 → seed 远程项目草稿。
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
      thinking?: unknown;
      active?: unknown;
      markModelChoice?: unknown;
      taskProviderId?: unknown;
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
    if (p.fast !== undefined && (typeof p.fast !== 'boolean' && p.fast !== 'ultrafast')) {
      throwIpcError('INVALID_PARAMS', 'fast must be boolean or ultrafast');
    }
    if (p.thinking !== undefined && typeof p.thinking !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'thinking must be boolean');
    }
    if (p.markModelChoice !== undefined && typeof p.markModelChoice !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'markModelChoice must be boolean');
    }
    if (
      p.taskProviderId !== undefined &&
      (typeof p.taskProviderId !== 'string' || p.taskProviderId.length > 256)
    ) {
      throwIpcError('INVALID_PARAMS', 'taskProviderId must be a string of at most 256 chars');
    }
    broadcastToAllWindows(MAKER_PUSH.DRAFT_PREF_APPLY, {
      agent: p.agent,
      providerId: p.providerId ?? '',
      modelId: p.modelId,
      active: p.active === true,
      ...(p.markModelChoice === false ? { markModelChoice: false } : {}),
      // 已有任务里只换模型:来源沿用任务的,被控端据此判断是否改写自己的新建默认。
      ...(p.taskProviderId ? { taskProviderId: p.taskProviderId } : {}),
      ...(p.effort !== undefined ? { effort: p.effort } : {}),
      ...(p.fast !== undefined ? { fast: p.fast } : {}),
      ...(p.thinking !== undefined ? { thinking: p.thinking } : {}),
    });
  });

  // device-link 草稿「新建会话默认启用 worktree」写穿:与上面的模型 pref 同款转发模式——
  // 被控端不直接改 newMakerDefaultsCache(那只是镜像、renderer 才是真相),把布尔转发给
  // 自身 renderer(WORKTREE_PREF_APPLY,仅本地窗口),renderer patchDraft 写真实草稿;
  // 变更经既有 SYNC_NEW_MAKER_DRAFT re-mirror + NEW_MAKER_DRAFT_CHANGED 回流控制端。
  registerNewMakerWorktreePreferenceHandler(createElectronIpcHandlerRegistry(), {
    isDeviceLinkInvoke,
    assertTrustedCaller: (event) =>
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
    broadcast: broadcastToAllWindows,
  });

  // worktree 源分支不是设备全局草稿字段，而是 canonical baseRepo scoped 的 host 真相。
  // 本地 renderer 与 device-link 控制端共用 GET/APPLY；APPLY 先落 main 进程缓存，再把
  // 权威 snapshot 同时广播给本地窗口和 sessions topic 订阅者。
  registerNewMakerWorktreeBranchPreferenceHandler(createElectronIpcHandlerRegistry(), {
    isDeviceLinkInvoke,
    assertTrustedCaller: (event) =>
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
    getPreference: getNewMakerWorktreeBranchPreference,
    applyPreference: applyNewMakerWorktreeBranchPreference,
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
    if (p.fast !== undefined && (typeof p.fast !== 'boolean' && p.fast !== 'ultrafast')) {
      throwIpcError('INVALID_PARAMS', 'fast must be boolean or ultrafast');
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
      typeof p.sessionId !== 'string' ||
      !p.sessionId ||
      (p.agent !== 'claude-code' && p.agent !== 'codex' && p.agent !== 'pi') ||
      typeof p.providerId !== 'string' ||
      !p.providerId ||
      typeof p.model !== 'string' ||
      !p.model
    )
      return;
    tapWindowBroadcast(MAKER_PUSH.SESSION_MODEL_PREF_CHANGED, {
      sessionId: p.sessionId,
      agent: p.agent,
      providerId: p.providerId,
      model: p.model,
      ...(typeof p.effort === 'string' ? { effort: p.effort } : {}),
      ...((typeof p.fast === 'boolean' || p.fast === 'ultrafast') ? { fast: p.fast } : {}),
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
        // Claude 订阅清单来自 Claude Code SDK:用本机 CLI 的登录读一次 supportedModels
        // (Cindy 不带订阅凭证请求 Anthropic,也不发送消息)。
        refreshAnthropic: refreshAnthropicModelsFromProbe,
        refreshOpenAi: () =>
          maker.refreshAgentLocalModels('codex', { credentialMode: 'oauth-bearer' }),
        refreshOpenAiMedia: refreshOpenAiMediaModels,
        refreshXai: refreshXaiModelsFromHttp,
        refreshXaiMedia: refreshXaiMediaModels,
      }),
  });
  options.onProviderModelAutoRefreshConfigured();

  registerLocalModelHandlers(createElectronIpcHandlerRegistry(), {
    assertTrustedSender: (event) =>
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
    refreshCatalog: () => refreshCustomProvidersIntoCatalog(),
    broadcastChanged: () => broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {}),
    broadcastStatus: (status) => broadcastToAllWindows(MAKER_PUSH.LOCAL_MODEL_STATUS, status),
    broadcastPullProgress: (progress) =>
      broadcastToAllWindows(MAKER_PUSH.LOCAL_MODEL_PULL_PROGRESS, progress),
    broadcastInstallProgress: (progress) =>
      broadcastToAllWindows(MAKER_PUSH.LOCAL_MODEL_INSTALL_PROGRESS, progress),
    currentOwnerSession: () => getActiveAppSession(),
    userDataDir: app.getPath('userData'),
  });

  registerProviderHandlers(createElectronIpcHandlerRegistry(), {
    listProviders: (opts) => getDesktopProviderService().listProviders(opts),
    isOrganizationManagedProviderId: (providerId) =>
      getActiveCatalog().providers.some(
        (provider) => provider.id === providerId && isOrganizationManagedProvider(provider),
      ),
    getModelVisibilityOverrides: async (providers, trusted) => {
      if (!trusted) await waitForModelVisibilityMirror();
      return getModelVisibilityMirrorSnapshot(providers, trusted);
    },
    refreshCatalog: () => refreshCustomProvidersIntoCatalog(),
    codexCustomProviderConfigSignature,
    hasAppliedCodexCustomProviderImageGeneration: (providerId) =>
      hasCodexAppliedCustomProviderCapability(providerId, 'imageGeneration'),
    listBusyLocalCodexSessionIds: () =>
      maker
        .listActiveSessions()
        .filter(
          (session) =>
            session.agentKind === 'codex' &&
            !session.remoteHostId &&
            isLocalSessionBusy(session, isSessionInTurn),
        )
        .map((session) => session.id),
    prepareCodexCustomProviderHostChange: prepareCodexForCustomProviderHostChange,
    retireCodexAccount,
    finalizeCodexCustomProviderHostChange: finalizeCodexAfterAuthModeChange,
    cancelCodexCustomProviderHostChange: cancelCodexAuthModeChange,
    beginRouteMutation: (providerId) => beginProviderRouteMutation(providerId),
    broadcastChanged: () => broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {}),
    kickProviderGroupReshare: (reason) => providerGroupReshare.kick(reason),
    listProviderIds: () => getDesktopSelectableCatalog().providers.map((provider) => provider.id),
    setProviderOrder: (providerIds) => setProviderOrder(providerIds),
    getProviderOrder: () => readProviderOrder(),
    listPresets: () => getActiveCatalog().presets ?? [],
    testConnection: (input) => testProviderConnection(input),
    fetchModels: async (spec) => {
      if (spec.savedProviderId && subscriptionAccountKind(spec.savedProviderId)) {
        return { ok: await refreshSubscriptionAccountModels(spec.savedProviderId), models: [] };
      }
      if (isCodexAccountProvider(spec.savedProviderId)) {
        if (spec.agent !== 'codex') throw new Error('Codex account model discovery requires Codex');
        const applied = await refreshModelsWithCatalog({
          refreshCatalog: refreshActiveCatalogFromSource,
          refreshModels: () => maker.refreshAgentLocalModels('codex', {
            credentialMode: 'oauth-bearer', providerId: spec.savedProviderId!,
          }),
          getScopeKey: () => getActiveAppSession().generation,
        });
        return { ok: applied, models: [] };
      }
      if (spec.authMethod === 'oauth') {
        const owner = getActiveAppSession();
        const provider = getActiveCatalog().providers.find((p) => p.id === spec.savedProviderId);
        if (!provider) return { ok: false, code: 'AUTH_INVALID' };
        return fetchSavedOAuthProviderModels(
          provider,
          spec.agent,
          storedCustomProviderId(provider.id),
          () => getActiveAppSession().generation === owner.generation &&
            getActiveCatalog().providers.find((p) => p.id === provider.id) === provider,
          undefined,
          spec.headers,
        );
      }
      return fetchProviderModels(spec);
    },
    builtinApiKeyDeps: options.builtinApiKeyDeps,
    // 重新发现会用订阅凭证发起真实上游请求，限主页面 sender（子 frame / WebView 拒绝）。
    assertTrustedSender: (event) =>
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]),
    // provider:list 是只读通道且要服务 device-link（合成 event），不能加会抛的 guard；
    // 改用不抛的判定决定「这次读取要不要放行本机绑定自愈 + 清单拉取」。
    isTrustedSender: (event) =>
      isTrustedAppRendererEvent(event as Parameters<typeof isTrustedAppRendererEvent>[0]),
    // 动态清单重新发现:目前没有需要主动重拉的供应商(anthropic 清单来自 Claude Code
    // 会话 init 的 SDK 捕获,没有 HTTP 发现通道,也就没有失败态)。
    rediscoverModels: async () => null,
    refreshBuiltinModels: refreshProviderModelsManually,
    requestModelsAutoRefresh: requestProviderModelAutoRefresh,
    scanLocalCli: () => scanLocalCliAuth(createLocalCliScanDeps()),
    // 「模型 / 供应商停用」override 写入(main 侧持久化,handler 写后广播 PROVIDER_CHANGED)。
    setModelsDisabled: (providerId, modelIds, disabled) =>
      setModelsDisabled(providerId, modelIds, disabled),
    setProviderDisabled: (providerId, disabled) => setProviderDisabled(providerId, disabled),
    getRemoteProviderInvocationEnabled: (providerId) =>
      isRemoteProviderInvocationAllowed(providerId),
    setRemoteProviderInvocationEnabled: (providerId, enabled) =>
      setRemoteProviderInvocationEnabled(providerId, enabled),
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
    broadcastPricingChanged: broadcastReferenceModelPricing,
    // Keep the catalog specification unchanged. Persist the override and refresh only
    // matching Codex tasks at a turn boundary; the editor reads back the effective value.
    readCodexContextWindowInfo: async (target, sessionId) => {
      if (sessionId) {
        const session = maker.getSession(sessionId);
        if (session) return session.agentKind === 'codex' ? session.getCodexContextWindowInfo() : null;
      }
      const configured = await readCodexContextWindowInfo({
        codexHome: getCodexHome(),
        binaryPath: getCachedBinaryStatus('codex').binaryPath,
        modelId: target.modelId,
        contextWindowOverride: readModelContextLimit('codex', target.providerId, target.modelId)
          ?? resolveModelDefaultContextWindow(getDesktopSelectableCatalog(), 'codex', target.providerId, target.modelId),
      });
      // Configuration refresh releases idle handles; the next send recreates one.
      // Expose the actual next-start configuration, explicitly marked as pending.
      return configured && sessionId ? { ...configured, pendingApply: true } : configured;
    },
    readModelContextLimit: (target) => ({
      limit: readModelContextLimit(target.agent, target.providerId, target.modelId),
      isCustomized: isModelContextLimitCustomized(
        target.agent,
        target.providerId,
        target.modelId,
      ),
    }),
    validateModelContextLimit: async (targets, limit) => {
      const localTargets = targets.filter((target) => target.providerId === MANAGED_LLAMACPP_PROVIDER_ID);
      if (localTargets.length) {
        const { models } = await getManagedLlamaCppService(app.getPath('userData')).snapshot();
        for (const target of localTargets) {
          const model = models.find((entry) => entry.id === target.modelId);
          if (!model) throwIpcError('INVALID_PARAMS', 'Local model is not installed');
          try {
            llamaCppModelPreset(model, { [`${target.agent}:${target.providerId}:${target.modelId}`]: limit });
          } catch {
            throwIpcError('INVALID_PARAMS', `This local model supports context up to ${llamaCppMaxContextSize(model)} tokens`);
          }
        }
      }
      for (const target of targets.filter((t) => t.agent === 'codex')) {
        const binaryPath = getCachedBinaryStatus('codex').binaryPath;
        if (!binaryPath) throw new Error('Codex runtime is unavailable');
        await prepareCodexCustomContextCatalog({
          binaryPath, codexHome: getCodexHome(), modelId: target.modelId, contextWindow: limit,
        });
      }
    },
    writeModelContextLimit: async (targets, limit) => {
      const owner = getActiveAppSession();
      const active = () => {
        const now = getActiveAppSession();
        return now?.dataOwnerId === owner?.dataOwnerId && now?.generation === owner?.generation;
      };
      const write = () => writeModelContextLimitsWithRefresh(targets, limit,
        () => refreshContextSettings(targets),
        () => refreshContextSettings());
      if (targets.some((target) => target.providerId === MANAGED_LLAMACPP_PROVIDER_ID)) {
        const service = getManagedLlamaCppService(app.getPath('userData'));
        return service.configure(async () => {
          if (!active()) throw new Error('OWNER_CHANGED');
          await ensureManagedLlamaCppProvider(
            (await service.snapshot()).models, active,
          );
          if (!active()) throw new Error('OWNER_CHANGED');
          await refreshCustomProvidersIntoCatalog();
          if (!active()) throw new Error('OWNER_CHANGED');
          await write();
        });
      }
      await write();
    },
    // 通用 OAuth（目录 auth.oauth 描述符驱动）：login 成功后 best-effort 拉动态模型发现
    // (additions-only merge 进 active-catalog) 并广播 PROVIDER_CHANGED 让 UI 刷新连接态。
    oauthLogin: async (providerId, isCurrent, onBrowserUrl, method, onDeviceCode) => {
      if (subscriptionAccountKind(providerId)) {
        const result = await loginSubscriptionAccount(providerId, isCurrent, {
          method,
          onDeviceCode,
        });
        if (result.ok && isCurrent()) {
          if (subscriptionAccountKind(providerId) === 'xai') clearXaiRateLimitSnapshot(providerId);
          try { await refreshSubscriptionAccountModels(providerId); } catch { /* Static catalog remains usable. */ }
          if (!isCurrent()) return result;
          const previous = await getCustomProvider(providerId);
          const identity = subscriptionAccountState(providerId).identity ?? providerId.slice(-8);
          if (isCurrent() && previous && identity && result.firstLogin && ['Anthropic', 'Claude', 'xAI', 'Grok'].includes(previous.name)) {
            await updateCustomProviderIfUnchanged(providerId, previous, { ...previous, name: `${previous.name} · ${identity}`.slice(0, 50) });
            if (isCurrent()) await refreshCustomProvidersIntoCatalog();
          }
          if (isCurrent()) broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {});
        }
        return result;
      }
      if (method === 'device') throw new Error('Device login is only available for Grok');
      if (isCodexAccountProvider(providerId)) {
        const owner = getActiveAppSession();
        const sameOwner = () => getActiveAppSession().generation === owner.generation;
        const current = () => isCurrent() && sameOwner();
        const result = await loginCodexAccount(providerId, isCurrent, onBrowserUrl);
        if (!result.ok) return result;
        return { ...result,
          ...(result.identityChanged ? {
            commitAccountCapabilities: () => revokeCodexAccountUltrafast(providerId, sameOwner),
          } : {}),
          afterCommit: async () => {
          if (!sameOwner()) return;
          if (result.identityChanged) await refreshCustomProvidersIntoCatalog();
          if (!current()) return;
          const previous = await getCustomProvider(providerId);
          if (!current()) return;
          const identity = codexAccountState(providerId).identity;
          if (previous && identity) {
            const names = new Set(getActiveCatalog().providers.filter((provider) => provider.id !== providerId).map((provider) => provider.name));
            const name = codexAccountLoginName(previous.name, result.previousIdentity, identity, names);
            if (name !== undefined) {
              await updateCustomProviderIfUnchanged(providerId, previous, { ...previous, name });
              if (!current()) return;
              await refreshCustomProvidersIntoCatalog();
            }
          }
          if (!current()) return;
          try { await maker.refreshAgentLocalModels('codex', { credentialMode: 'oauth-bearer', providerId }); }
          catch { /* Login remains valid; model refresh can be retried without changing credentials. */ }
          if (!current()) return;
          broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {});
        } };
      }
      const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
      const oauth = provider?.auth.oauth;
      if (!provider || !oauth) throw new Error(`provider '${providerId}' has no oauth descriptor`);
      const storageProviderId =
        provider.source === 'user' ? storedCustomProviderId(providerId) : providerId;
      let rollbackCredentials: (() => boolean) | undefined;
      const result = await runGenericOAuthLogin(
        { id: storageProviderId, name: provider.name },
        oauth,
        {
          onProgress: (progress) =>
            broadcastToAllWindows(MAKER_PUSH.PROVIDER_OAUTH_PROGRESS, { providerId, ...progress }),
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
            if (
              oauth.modelsDiscoveryUrl &&
              (!upstream ||
                new URL(oauth.modelsDiscoveryUrl).origin !== new URL(upstream).origin)
            ) {
              // The descriptor is user/provider data, but the discovery request carries a
              // Bearer token. Never let an explicit discovery URL collect credentials outside
              // the runtime's own origin. Imported descriptors are rejected earlier; this is
              // the same fail-closed guard for existing catalog entries.
              continue;
            }
            const url =
              oauth.modelsDiscoveryUrl ?? (upstream ? deriveModelsDiscoveryUrl(upstream) : null);
            if (!url) continue;
            // 去重键含 agent:发现请求头按 wire 分派(cc 带 anthropic-version),同 URL 不同 wire 不能共用响应。
            const key = `${agent}\n${url}`;
            if (!fetched.has(key))
              fetched.set(
                key,
                await discoverGenericOAuthModels(storageProviderId, oauth, url, agent),
              );
            if (!isCurrent()) break;
            const models = fetched.get(key);
            if (!models || models.length === 0) continue;
            if (provider.source === 'user') {
              const cfg = await getCustomProvider(storageProviderId);
              if (!isCurrent()) break;
              if (cfg) {
                const nextCfg = mergeDiscoveredModelsIntoConfig(cfg, agent, models);
                if (nextCfg) {
                  const applied = await updateCustomProviderIfUnchanged(
                    storageProviderId,
                    cfg,
                    nextCfg,
                  );
                  if (!isCurrent()) break;
                  if (applied) customChanged = true;
                }
              }
            } else {
              if (!isCurrent()) break;
              setDiscoveredProviderModels(
                providerId,
                agent,
                buildUserProvider({
                  id: providerId,
                  name: provider.name,
                  runtimes: {
                    [agent]: {
                      baseUrl: provider.routing[agent]!.upstream,
                      wireProtocol: provider.routing[agent]!.wireProtocol,
                      models: mergeDiscoveredRuntimeModels([], models),
                    },
                  },
                }, { modelRegistry: getActiveCatalog().modelRegistry }).models[agent] ?? [],
              );
            }
          }
          if (customChanged && isCurrent()) await refreshCustomProvidersIntoCatalog();
        } catch {
          /* 发现失败保持纯静态目录，不影响登录结果 */
        }
        if (isCurrent()) {
          if (provider.source === 'builtin') await retainProviderPresentationAfterAuthChange(providerId);
          if (isCurrent()) broadcastToAllWindows(MAKER_PUSH.PROVIDER_CHANGED, {});
        }
      }
      return { ...result, ...(rollbackCredentials ? { rollbackCredentials } : {}) };
    },
    readCustomProviderKeyForMutation,
    storeCustomProviderKey,
    removeCustomProviderKey,
    oauthLogout: async (providerId) => {
      if (subscriptionAccountKind(providerId)) { logoutSubscriptionAccount(providerId); await syncSubscriptionAccountUsage(providerId); return; }
      if (isCodexAccountProvider(providerId)) { await logoutCodexAccount(providerId); return; }
      if (!logoutGenericOAuth(storedCustomProviderId(providerId))) {
        throw new Error('failed to remove generic OAuth credentials');
      }
    },
    oauthCancel: (providerId) => {
      if (subscriptionAccountKind(providerId)) { cancelSubscriptionAccountLogin(providerId); return; }
      if (isCodexAccountProvider(providerId)) cancelCodexAccountLogin(providerId);
      else cancelGenericOAuthLogin(storedCustomProviderId(providerId));
    },
    removeOAuthCredentials: (providerId) => {
      if (subscriptionAccountKind(providerId)) {
        const restore = removeSubscriptionAccountCredentialsReversibly(providerId);
        if (subscriptionAccountKind(providerId) === 'xai') clearXaiRateLimitSnapshot(providerId);
        return restore;
      }
      return isCodexAccountProvider(providerId)
        ? removeCodexAccountCredentialsReversibly(providerId)
        : removeGenericOAuthCredentialsReversibly(storedCustomProviderId(providerId));
    },
  });

  // 自定义 MCP 服务器 CRUD —— CRUD 成功后刷新三个 agent 的 mcpProviders 数组
  // （下次新建会话生效）并广播 MCP_CHANGED 让设置页列表 live 刷新。
  registerMcpHandlers(createElectronIpcHandlerRegistry(), {
    listMcpServers: listBotRuntimeMcpServers,
    resolveBotContext: async (sessionId, chain) => {
      const route = await reconcileBotModelRoute.preview(sessionId, chain);
      if (!route) return null;
      const meta = await maker.getSessionMeta(sessionId);
      return meta ? { agentKind: route.agentKind, remoteHostId: meta.remoteHostId } : null;
    },
    refreshProviders: () => refreshCustomMcpProviders(),
    broadcastChanged: () => broadcastToAllWindows(MAKER_PUSH.MCP_CHANGED, {}),
    // 内置 server 名对自定义 MCP 是保留名：撞名会在装配层顶替内置 server 并继承
    // 它在 MCP 审批策略里的信任，所以 CRUD 阶段就拒收。
    getReservedMcpIds: () => getBuiltinMcpServerNames(),
    // Persisted MCP changes must eventually replace the frozen spawn config;
    // busy hosts keep their bridge until the existing idle retry can refresh it.
    invalidateCodex: async () => {
      const ownerScopeKey = activeOwnerScopeKey();
      await refreshCodexMcpEnvironment({
        restartCodex: restartCodexAfterAuthModeChange,
        shutdownCodexEnvironment,
        onDeferred: () => {
          if (!isAppSessionBoundaryPending() && activeOwnerScopeKey() === ownerScopeKey) {
            scheduleDeferredCodexRestart('Custom MCP configuration changed');
          }
        },
        logger: log,
      });
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
  // 查询异常交由 routingTransform 的 fail-closed 边界收口,不能伪装成查无会话后回落网关。
  setClaudeProxyOwnerBoundaryPendingChecker(isAppSessionBoundaryPending);
  setClaudeProxyOwnerScopeKeyReader(activeOwnerScopeKey);
  setClaudeProxySessionIdResolver((sdkSessionId) => {
    if (isAppSessionBoundaryPending()) return null;
    const s = maker.listActiveSessions().find((x) => x.requestSessionId === sdkSessionId);
    return s ? s.id : resolveRemoteAgentHostClaudeSessionId(sdkSessionId);
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
  ipcMain.handle(MAKER_INVOKE.LIST_DESKTOP_COMMANDS, (_event, ctx?: unknown) => {
    const deviceId = ctx && typeof ctx === 'object' && !Array.isArray(ctx)
      && typeof (ctx as { deviceId?: unknown }).deviceId === 'string'
      && (ctx as { deviceId: string }).deviceId.length > 0
      ? (ctx as { deviceId: string }).deviceId
      : undefined;
    return {
      success: true,
      commands: getDesktopCommandRegistry().list(deviceId ? { deviceId } : undefined),
    };
  });

  ipcMain.handle(MAKER_INVOKE.EXECUTE_DESKTOP_COMMAND, async (e, name: unknown, ctx: unknown) => {
    if (name === 'cindy-make-doctor' || name === 'cindy-make') {
      assertTrustedAppRendererEvent(e);
      assertCindyMakeEnabled();
      if (ctx != null && (typeof ctx !== 'object' || Array.isArray(ctx)))
        throwIpcError('INVALID_PARAMS', 'Invalid Make context');
    }
    if (typeof name !== 'string' || name.length === 0) {
      throwIpcError('INVALID_PARAMS', 'name required');
    }
    // senderWebContentsId 由 main 从 event.sender 填入(覆盖 renderer 传入的任何值),
    // 供需要"只回发起窗口"的命令(/issue)做定向 send。
    const c = { ...((ctx ?? {}) as DesktopCommandContext), senderWebContentsId: e.sender.id };
    return getDesktopCommandRegistry().execute(name, c);
  });

  ipcMain.handle(
    MAKER_INVOKE.LIST_AGENT_COMMANDS,
    async (event, agentKind: unknown, rawParams?: unknown) => {
      assertAgentCommandListIpcCaller(event, {
        isDeviceLinkInvoke,
        assertTrustedSender: (sourceEvent) =>
          assertTrustedAppRendererEvent(
            sourceEvent as Parameters<typeof assertTrustedAppRendererEvent>[0],
          ),
      });
      try {
        const kind = requireAgentKind(agentKind);
        const params = rawParams === undefined ? {} : requireObject(rawParams);
        if (params.sessionId !== undefined && typeof params.sessionId !== 'string') {
          throwIpcError('INVALID_PARAMS', 'sessionId must be a string');
        }
        if (
          params.allowManagedPiPackagePreview !== undefined &&
          typeof params.allowManagedPiPackagePreview !== 'boolean'
        ) {
          throwIpcError('INVALID_PARAMS', 'allowManagedPiPackagePreview must be a boolean');
        }
        const sessionId =
          typeof params.sessionId === 'string' && params.sessionId.trim()
            ? params.sessionId.trim()
            : undefined;
        const sessionMeta = sessionId ? await maker.getSessionMeta(sessionId) : null;
        const builtins = maker.listAgentCommands(kind);
        const mayListPackageCommands = shouldListPiPackageCommands(
          kind,
          sessionId !== undefined,
          sessionMeta,
          params.allowManagedPiPackagePreview !== false,
        );
        let packageCommands: Array<{ name: string; description: string }> = [];
        let runtimeStatus:
          import('../../shared/piPackages.js').PiPackageCommandRuntimeStatus | undefined;
        if (mayListPackageCommands && sessionId) {
          const manifest = maker.getSessionRuntimeCapabilities(sessionId);
          runtimeStatus =
            manifest?.status === 'loaded'
              ? 'loaded'
              : manifest?.status === 'failed'
                ? 'failed'
                : manifest?.status === 'unknown'
                  ? 'unknown'
                  : 'pending';
          if (manifest?.status === 'loaded') {
            packageCommands = listPiRuntimePaletteCommands(
              manifest.commands,
              manifest.authorizedSlashCommandNames ?? manifest.managedPackageCommandNames,
            );
          } else if (!manifest) {
            // An empty local Pi task may have a persisted session row before its
            // process starts. Keep inspected Prompt templates visible; send waits
            // for this task's get_commands catalog before allowing execution.
            packageCommands = await listManagedPiPromptCommands();
          }
        } else if (mayListPackageCommands) {
          // Before a task exists, only prompt templates are statically knowable.
          // Extension commands appear after that exact Pi runtime confirms them.
          packageCommands = await listManagedPiPromptCommands();
        }
        const commands = mergePiPackageCommands(kind, builtins, packageCommands);
        return { success: true, commands, ...(runtimeStatus ? { runtimeStatus } : {}) };
      } catch (err) {
        return toAgentCommandListFailure(err, {
          reportError: (error) => {
            log.warn('Agent command list failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });
      }
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.LIST_AGENT_SKILLS,
    async (event, agentKind: unknown, params: unknown) => {
      assertAgentSkillListIpcCaller(event, {
        isDeviceLinkInvoke,
        assertTrustedSender: (sourceEvent) =>
          assertTrustedAppRendererEvent(
            sourceEvent as Parameters<typeof assertTrustedAppRendererEvent>[0],
          ),
      });
      try {
        const kind = requireAgentKind(agentKind);
        const skillParams = (params ?? {}) as {
          workingDir?: string;
          remoteHostId?: string;
          forceReload?: boolean;
          sessionId?: string;
        };
        const linksChanged = skillParams.remoteHostId
          ? false
          : await prepareProjectSkillLinksFailSoft(skillParams.workingDir);
        if (kind === 'codex' && linksChanged) {
          skillParams.forceReload = true;
        }
        if (kind === 'codex' && !skillParams.remoteHostId) {
          await desktopCodexAuthAdapter.ensureGlobalCodexAssets();
        } else {
          // Pi scans ~/.agents/skills directly. Refresh the managed projection here so a
          // Codex-only skill added after Cindy startup is visible without using another agent
          // or restarting the app first. Claude keeps the same shared-root refresh semantics.
          await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();
        }
        const result = await maker.listAgentSkills(kind, skillParams);
        return {
          success: true,
          ...result,
          skills: activeCindyBuiltInAgentSkills(
            result.skills,
            builtInSkillDescriptors(app.getPath('userData'), app.getPath('appData')),
            isCindySkillEnabled,
          ),
        };
      } catch (err) {
        return toAgentSkillListFailure(err, {
          reportError: (error) => {
            log.warn('Agent skill list failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          },
        });
      }
    },
  );

  ipcMain.handle(MAKER_INVOKE.PI_PACKAGES_LIST, async (event) => {
    assertTrustedAppRendererEvent(event);
    return runPiPackageListIpcBoundary(
      () => listPiPackages(),
      t('settings.piPackages.loadFailed'),
      (error) => {
        log.warn('Pi extension list failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });

  ipcMain.handle(MAKER_INVOKE.PI_PACKAGES_MUTATE, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const payload = requireObject(raw);
    const action = requireEnum(
      payload.action,
      ['install', 'remove', 'update', 'set-enabled'] as const,
      'action',
    );
    if (typeof payload.source !== 'string' || payload.source.length > 2_048) {
      throwIpcError('INVALID_PARAMS', 'invalid Pi extension source');
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'confirmed')) {
      throwIpcError('INVALID_PARAMS', 'Renderer confirmation is not accepted');
    }
    if (payload.enabled !== undefined && typeof payload.enabled !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
    }
    if (payload.mutationTarget !== undefined
      && (typeof payload.mutationTarget !== 'string'
        || !/^cindy-pi-package:[a-f0-9]{64}$/.test(payload.mutationTarget))) {
      throwIpcError('INVALID_PARAMS', 'invalid Pi extension mutation target');
    }
    const request: PiPackageMutationRequest = {
      action,
      source: payload.source,
      ...(typeof payload.mutationTarget === 'string'
        ? { mutationTarget: payload.mutationTarget }
        : {}),
      ...(typeof payload.enabled === 'boolean' ? { enabled: payload.enabled } : {}),
    };
    return runPiPackageMutationIpcBoundary(
      async () => {
        let runtimesInvalidated = false;
        let runtimeConvergencePartial = false;
        const invalidateRuntimes = async (
          phase: PiPackageRuntimeInvalidationPhase = 'commit',
        ): Promise<void> => {
          if (runtimesInvalidated && phase === 'commit') return;
          runtimesInvalidated = true;
          try {
            const invalidation = await invalidateLocalPiPackageRuntimes(maker, {
              afterCurrentTurn: request.action !== 'remove'
                && !(request.action === 'set-enabled' && request.enabled === false),
              failureEvent: () => ({
                type: 'text', source: 'pi',
                data: { isFinal: true, text: t('settings.piPackages.failure.runtimeRetirementFailed') },
              }),
            });
            if (invalidation.failedSessionIds.length > 0) {
              runtimeConvergencePartial = true;
              log.warn('Pi package changed but some local runtimes did not close', {
                failedSessionIds: invalidation.failedSessionIds,
              });
            }
          } catch {
            // The package mutation is already committed. Runtime convergence is
            // a separately recoverable result, never a rewritten native failure.
            runtimeConvergencePartial = true;
            log.warn('Pi package changed but local runtime invalidation failed', {
              failureCategory: 'runtime-invalidation-failed',
              recoveryAction: 'restart-cindy',
            });
          }
        };
        try {
          const mutationHooks = { onRuntimeInvalidationPublished: invalidateRuntimes };
          const result = !piPackageMutationNeedsGrant(request)
            ? await mutatePiPackage(request, undefined, mutationHooks)
            : await mutatePiPackage(
                request,
                // The trusted Settings action is the user's one authorization;
                // this grant binds only the exact request.
                issuePiPackageMutationGrant(request),
                mutationHooks,
              );
          // Pi discovers packages at process start. Every successful roster
          // mutation must retire old local ordinary runtimes, including install,
          // update, and enable—not only revocation.
          await invalidateRuntimes();
          return runtimeConvergencePartial
            ? { ...result, runtimeConvergence: 'partial' as const }
            : result;
        } catch (error) {
          // Retire snapshots only after the store reached a native command or
          // durable write. Pure validation/state-read failures must not cancel
          // unrelated running Pi tasks.
          if (piPackageMutationMayHaveChangedState(error)) {
            await invalidateRuntimes();
          }
          throw error;
        }
      },
      (error) => piPackageMutationFailureCategory(error) === 'state-unavailable'
        ? t('settings.piPackages.failure.stateUnavailable')
        : t('settings.piPackages.operationFailed'),
      (error) => {
        log.warn('Pi extension mutation failed', {
          action: request.action,
          failureCategory: piPackageMutationFailureCategory(error),
          diagnostic: piPackageCommandDiagnostic(error),
          mayHaveChangedState: piPackageMutationMayHaveChangedState(error),
        });
      },
    );
  });

  ipcMain.handle(
    MAKER_INVOKE.SCAN_AT_RESOURCES,
    async (_e, agentKind: unknown, params: unknown) => {
      try {
        const resourceParams = params as { workingDir: string; cap?: number; query?: string };
        await prepareProjectSkillLinksFailSoft(resourceParams?.workingDir);
        const kind = requireAgentKind(agentKind);
        const includeProjectAgents = supportsAtProjectAgentResources(kind);
        const [result, customizationResult] = await Promise.all([
          maker.scanAtResources(kind, resourceParams),
          includeProjectAgents
            ? maker
                .listCustomizations({
                  agentKind: 'claude-code',
                  workingDirs: [resourceParams.workingDir],
                  kinds: ['agent'],
                })
                .catch((err: unknown) => {
                  log.warn(
                    'Project Agent @ catalog failed; keeping workspace resources available',
                    err,
                  );
                  return null;
                })
            : Promise.resolve(null),
        ]);
        const projectAgents = customizationResult
          ? listAtProjectAgentResources(
              customizationResult.items,
              resourceParams.workingDir,
              resourceParams.query,
            )
          : [];
        const merged = finalizeAtProjectAgentResources(
          kind,
          result.items,
          projectAgents,
          resourceParams.cap,
        );
        return { success: true, items: merged.items, truncated: result.truncated || merged.capped };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          items: [],
          truncated: false,
        };
      }
    },
  );

  ipcMain.handle(MAKER_INVOKE.AT_CONTEXT_LIST, async (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = parseAtContextCatalogRequest(payload);
    if (!request) {
      throwIpcError('INVALID_PARAMS', 'Invalid @ context catalog request');
    }

    const unavailable: Array<'browser-tabs' | 'desktop-windows'> = [];
    let browserTabs: ReturnType<typeof listAtBrowserTabs> = [];
    let desktopWindows: ReturnType<typeof readAtDesktopWindows> = [];
    try {
      const browserTabSessionId = resolveAtBrowserTabSessionId(
        request.sessionId,
        event.sender.getURL(),
      );
      browserTabs = listAtBrowserTabs(
        getRsbBrowserBridge(),
        browserTabSessionId,
        request.query,
        request.limit,
      );
    } catch (err) {
      unavailable.push('browser-tabs');
      log.warn('@ context browser-tab catalog failed', err);
    }

    // Computer Use is machine-scoped. Do not let renderer-provided project
    // metadata appear to participate in its enablement decision.
    if (request.query && getPluginRegistry().isEnabled('computer')) {
      try {
        desktopWindows = readAtDesktopWindows(
          await listComputerWindowsForAtMention(),
          request.query,
          request.limit,
        );
      } catch (err) {
        unavailable.push('desktop-windows');
        log.warn('@ context desktop-window catalog failed', err);
      }
    }

    return { success: true, browserTabs, desktopWindows, unavailable };
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
      } else if (agentKind === 'pi') {
        await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();
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
  // sessionBindings + lastReportedCostUsdBySession + sessionTurnActivityTracker 都在模块顶层,
  // 让 scheduler runner / feishu 接管 / future MCP 等绕过 IPC 的调用方也能复用同一份 wire 逻辑。

  type CreateOpts = MakerSessionCreateOpts;

  function buildCreateOptsWithStderr(o: CreateOpts) {
    // 把 vendor 子进程 stderr 引到主进程日志,否则 "process exited with code 1" 之类
    // 的失败信息会被默默丢掉。renderer 仍可以通过 vendorOptions 自定义,这里只在缺省时兜底。
    return withCreateSessionStderr(o, (agentKind, line) =>
      log.warn(`[${agentKind}/stderr] ${line}`),
    );
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
   * 副作用：mutate o.userPrompt（追加按需读取 TOC 的短 wrapper）；返回是否真的注入了入口。
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

  /**
   * Review isolation is persisted by sessions.source, not trusted to whichever
   * renderer happens to reconstruct CreateOpts after a restart. Every local
   * create/resume funnel passes bootstrapSession, so this is the single place
   * that restores the host-owned read-only purpose before any prompt injection.
   */
  async function applyPersistedReviewMode(o: CreateOpts): Promise<void> {
    let isReview = o.reviewMode === true;
    if (!isReview && typeof o.id === 'string' && o.id) {
      const [row] = await getDbClient()
        .drizzle.select({ source: sessions.source, remoteHostId: sessions.remoteHostId })
        .from(sessions)
        .where(eq(sessions.id, o.id))
        .limit(1);
      isReview = row?.source === 'review';
      if (isReview && row?.remoteHostId) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Review tasks are local-only in this version');
      }
    }
    if (!isReview) return;
    if (o.remoteHostId) {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Review tasks are local-only in this version');
    }
    enforceReviewCreateOptions(o);
  }

  async function readSessionSource(sessionId: string): Promise<string | null> {
    const [row] = await getDbClient()
      .drizzle.select({ source: sessions.source })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row?.source ?? null;
  }

  async function assertReviewExternalInputAllowed(sessionId: string): Promise<void> {
    const source = await readSessionSource(sessionId);
    assertCindyMakeSessionAvailable(source);
    await assertReviewSessionExternalInputAllowed(sessionId, async () => source);
  }

  async function assertReviewSettingsUnlocked(sessionId: string): Promise<void> {
    if ((await readSessionSource(sessionId)) === 'review') {
      throwIpcError('UNSUPPORTED_CAPABILITY', 'Review task settings are fixed to the source task');
    }
  }

  function orcaSessionStatus(sessionId: string): string {
    const session = maker.getSession(sessionId) as { getStatus?: () => string } | null;
    return session?.getStatus?.() ?? 'not_running';
  }

  async function readLatestWorkerAssistantMessage(workerSessionId: string): Promise<string> {
    const db = getDbClient().drizzle;
    const [row] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, workerSessionId),
          eq(messages.role, 'assistant'),
          isNull(messages.rewindAt),
        ),
      )
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
    const remoteRuntime = orcaRemoteWorkersForHost?.runtime;
    return {
      getWorkerWorktree: getWorkerOwnedWorktree,
      readActiveTeam: readActiveOrcaTeamByLeadReadOnly,
      listWorkersByLead,
      // 远端 Worker 的本机代理行从不运行；状态取运行设备的轮询投影。
      getSessionStatus: (sessionId: string) =>
        remoteRuntime?.isRemote(sessionId)
          ? !remoteRuntime.isReachable(sessionId)
            ? 'unreachable'
            : remoteRuntime.isTurnRunning(sessionId) ? 'running' : 'idle'
          : orcaSessionStatus(sessionId),
      getWorkerFlowStatus: async (sessionId: string) => {
        if (remoteRuntime?.isRemote(sessionId)) {
          const running = remoteRuntime.isTurnRunning(sessionId);
          return { isWorking: running, willQueue: running, queuedCount: 0, queuePaused: false };
        }
        await inputCoordinator.ensureQueueRestored(sessionId);
        const inspection = inputCoordinator.getQueueInspection(sessionId);
        const live = getStableSessionForTurnBoundary(sessionId);
        return {
          isWorking: isSessionTurnDispatchBoundaryBusy(sessionTurnActivityTracker, sessionId, live),
          willQueue:
            inputCoordinator.shouldQueueNewTurn(sessionId) || sendToSessionLocks.has(sessionId),
          queuedCount: inspection.length,
          queuePaused: inputCoordinator.isQueuePaused(sessionId),
        };
      },
      readLatestAssistantMessage: (workerSessionId: string) =>
        remoteRuntime?.isRemote(workerSessionId)
          ? remoteRuntime.latestReply(workerSessionId)
          : readLatestWorkerAssistantMessage(workerSessionId),
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
   * 任务记录里「Agent 在哪台电脑运行」(null = 本机)。读失败按本机处理：本机任务的行为与读取
   * 之前完全一致，只有确认是另一台电脑上的任务才走对应分支。
   */
  async function readSessionAgentDeviceId(sessionId: string): Promise<string | null> {
    try {
      const [row] = await getDbClient()
        .drizzle.select({ agentDeviceId: sessions.agentDeviceId, remoteHostId: sessions.remoteHostId })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row?.agentDeviceId && !row.remoteHostId ? row.agentDeviceId : null;
    } catch (error) {
      log.warn('session agent device lookup failed; treating the task as local', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Agent 将在另一台电脑运行时的选择准入(远程 Agent)：那台在线、允许被远程调用这个来源、
   * 目录里有这个模型。在选择时就拒绝，不留一个发送时在那台失败、且每次发送都重试的意图。
   */
  async function assertAgentDeviceRouteUsable(
    deviceId: string,
    agent: AgentKind,
    model: string,
    providerId: string | null,
  ): Promise<void> {
    await readUsableAgentDeviceProviders(deviceId, agent, model, providerId);
  }

  async function readUsableAgentDeviceProviders(
    deviceId: string,
    agent: AgentKind,
    model: string,
    providerId: string | null,
  ): Promise<ProviderView[]> {
    let views: ProviderView[] = [];
    const checked = await checkDeviceRoute(
      async () => {
        views = await readDeviceProviderViews(remoteBackgroundInvoke, deviceId);
        return views;
      },
      agent,
      providerId,
      model,
    );
    if (!checked) return views;
    // 分享来的供应商连不上(分享者电脑离线，或分享在服务端已暂停而 relay 只回离线)：用分享专属
    // 文案，不让受邀者去「那台电脑」上操作。
    const rejection = checked === 'unreachable' && isProviderShareAgentDeviceId(deviceId)
      ? 'REMOTE_AGENT_SHARE_UNAVAILABLE'
      : checked;
    log.warn('remote agent selection rejected', { agent, model, providerId, rejection });
    if (rejection.startsWith('REMOTE_AGENT_SHARE_')) {
      // 分享来的供应商：给出分享专属原因(device-link 控制端同样降级为 PRECONDITION_FAILED)。
      throwIpcError(
        isDeviceLinkInvoke() ? 'PRECONDITION_FAILED' : rejection as 'REMOTE_AGENT_SHARE_PAUSED' | 'REMOTE_AGENT_SHARE_REMOVED' | 'REMOTE_AGENT_SHARE_UNAVAILABLE',
        'the shared provider is not available; the model was not changed',
      );
    }
    // device-link 控制端降级为 PRECONDITION_FAILED(不把新 code 变成跨版本 wire 契约)。
    const code = rejection === 'unreachable' ? 'REMOTE_AGENT_DEVICE_UNREACHABLE' : 'REMOTE_AGENT_MODEL_UNAVAILABLE';
    throwIpcError(
      isDeviceLinkInvoke() ? 'PRECONDITION_FAILED' : code,
      rejection === 'unreachable'
        ? 'the computer that would run the agent is not reachable; the model was not changed'
        : 'that computer does not offer this model to other computers; the model was not changed',
    );
  }

  /**
   * 分隔条展示用的电脑名：null = 任务所在电脑(本机)，其他按设备目录最近一次的名字。
   * 分享来的供应商不写电脑名(分享者的电脑名不给受邀者，provider-sharing.md §6)，分隔条写「另一台电脑」。
   */
  function describeAgentDevice(deviceId: string | null): string | null {
    if (!deviceId) return getHostSourceDevice().name ?? null;
    if (isProviderShareAgentDeviceId(deviceId)) return null;
    try {
      return readLastKnownDeviceNames()[deviceId] ?? null;
    } catch {
      return null;
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
      // 读不到只能按「调用方未指定」继续 → 整个会话跑在非用户所选的上游上。
      log.warn('pre-hydrate session provider failed (non-fatal)', {
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
    await assertReviewSettingsUnlocked(sessionId);
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
    remoteHostId?: string | null,
  ): Promise<string | undefined> {
    if (agent === 'codex' && remoteHostId) {
      assertSshCodexModel(await readSshCodexModelList({ id: remoteHostId }, listSshCodexProviders), model, providerId);
      return undefined;
    }
    const verdict = await verdictForModelRoute(agent, model, providerId);
    if (verdict.kind === 'reject') {
      throwIpcError(
        'INVALID_PARAMS',
        describeModelRouteRejection(verdict.reason, model, providerId),
      );
    }
    return verdict.kind === 'reroute' ? verdict.providerId : undefined;
  }

  // 供应商组(docs/product-rules/provider-groups.md)：在 agentSwitchDeps 就绪后装配。
  let providerGroupService: ProviderGroupService | null = null;

  const autoResumeInputLifecycle = createAutoResumeInputLifecycle({
    bookkeeping: () => autoResumeBookkeeping,
    interrupted: () => interruptedTurnAutoResumeGuard,
    coordinator: () => agentInputCoordinatorHolder,
    scheduler: schedulerRecoveryBridge,
    noteSilentStopUserSend: id => silentStopAutoResumeGuard.noteUserSend(id),
    noteUsageLimitUserAction: id => usageLimitAutoResume.noteUserAction(id),
    noteProviderGroupUserAction: id => providerGroupService?.noteUserAction(id),
    settleProviderGroupContinuation,
  });
  const { settleUndispatchedInterruptedAutoResume } = autoResumeInputLifecycle;

  async function readProviderGroupSessionRow(sessionId: string): Promise<ProviderGroupSessionRow | null> {
    const [row] = await getDbClient()
      .drizzle.select({
        agentKind: sessions.agentKind,
        model: sessions.model,
        providerId: sessions.providerId,
        agentDeviceId: sessions.agentDeviceId,
        remoteHostId: sessions.remoteHostId,
        sdkSessionId: sessions.sdkSessionId,
        source: sessions.source,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    // 审查任务的设置固定跟随源任务，不归供应商组分配。协同的 Lead 与 Worker 与普通任务一样归组(2026-10-10)。
    if (!row || row.source === 'review') return null;
    return {
      agentKind: dbToMakerAgentKind(row.agentKind),
      model: row.model ?? null,
      providerId: row.providerId ?? null,
      agentDeviceId: row.agentDeviceId ?? null,
      remoteHostId: row.remoteHostId ?? null,
      sdkSessionId: row.sdkSessionId ?? null,
    };
  }

  /**
   * 协同 Lead 归在供应商组里时那个组那一项(跟 Lead 的 Worker 跟它，见 orcaWorkerCreationService)。
   * 本机的组已删除时不算；另一台电脑上的组由那台分配时再核对。
   */
  function readLeadProviderGroupEntry(
    leadSessionId: string,
    remoteHostId: string | null,
  ): { providerGroupEntry?: { agentDeviceId: string | null; providerId: string } } {
    if (remoteHostId) return {};
    const binding = readProviderGroupBinding(leadSessionId);
    if (!binding) return {};
    if (!binding.groupDeviceId && !readProviderGroup(binding.providerId)) return {};
    return { providerGroupEntry: { agentDeviceId: binding.groupDeviceId ?? null, providerId: binding.providerId } };
  }

  async function readProviderLocalLoadRoutes(sessionIds: readonly string[]): Promise<ProviderLocalLoadRoute[]> {
    const rows = await getDbClient()
      .drizzle.select({
        id: sessions.id,
        agentKind: sessions.agentKind,
        model: sessions.model,
        providerId: sessions.providerId,
        agentDeviceId: sessions.agentDeviceId,
        remoteHostId: sessions.remoteHostId,
      })
      .from(sessions)
      .where(inArray(sessions.id, [...sessionIds]));
    return rows.map((row) => ({
      id: row.id,
      agentKind: dbToMakerAgentKind(row.agentKind),
      model: row.model ?? null,
      providerId: row.providerId ?? null,
      agentDeviceId: row.agentDeviceId ?? null,
      remoteHostId: row.remoteHostId ?? null,
    }));
  }

  async function resolveProviderGroupImplicitProvider(agentKind: AgentKind, model: string): Promise<string | null> {
    const providers = await getDesktopProviderService().listProviders({
      allowSideEffects: false,
      catalog: getActiveCatalog(),
    });
    return effectiveSourceIdForModel(providers, null, model, agentKind);
  }

  async function persistProviderGroupRoute(sessionId: string, route: ProviderGroupRoute): Promise<void> {
    await getDbClient()
      .drizzle.update(sessions)
      .set({ agentDeviceId: route.agentDeviceId, providerId: route.providerId, updatedAt: Date.now() })
      .where(eq(sessions.id, sessionId));
    broadcastSessionPatched(sessionId, { agentDeviceId: route.agentDeviceId, providerId: route.providerId });
  }

  async function hasProviderGroupAssistantHistory(sessionId: string): Promise<boolean> {
    const [row] = await getDbClient()
      .drizzle.select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'assistant')))
      .limit(1);
    return Boolean(row);
  }

  /**
   * 新任务第一次启动前按供应商组选电脑；已归组的任务以任务记录为准核对绑定(用户手动挪走时解除)。
   * 不归组管时原样返回 null。
   */
  async function applyProviderGroupAssignment(o: CreateOpts): Promise<ProviderGroupStartContext | null> {
    if (!providerGroupService || !o.id || o.remoteHostId) return null;
    if (typeof o.model !== 'string' || !o.model) return null;
    // 本机没有建组、任务不指向同账号另一台电脑(那台可能建了组)、也没有归组时不读数据库，
    // 启动路径与没有这个功能时完全一致。
    const pointsAtOtherComputer = Boolean(o.agentDeviceId) && !isProviderShareAgentDeviceId(o.agentDeviceId);
    if (Object.keys(listProviderGroups()).length === 0 && !pointsAtOtherComputer && !readProviderGroupBinding(o.id)) {
      return null;
    }
    // 新建的协同 Worker 由启动这一步落库：任务记录还没有时按启动参数分配(当作从没运行过的任务)。
    const [existing] = await getDbClient()
      .drizzle.select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, o.id))
      .limit(1);
    const context = await providerGroupService.assignBeforeStart({
      sessionId: o.id,
      agentKind: o.agentKind,
      model: o.model,
      ...(existing || o.reviewMode === true
        ? {}
        : {
            startRow: {
              agentKind: o.agentKind,
              model: o.model,
              providerId: o.providerId ?? null,
              agentDeviceId: o.agentDeviceId ?? null,
              remoteHostId: null,
              sdkSessionId: o.resumeSessionId ?? null,
            },
          }),
    });
    if (context?.overrideRoute) {
      // 另一台电脑上的组选中的可能是任何一台，包括这台自己(改回本机运行)。
      o.agentDeviceId = context.route.agentDeviceId ?? undefined;
      o.providerId = context.route.providerId;
    } else if (context?.route.agentDeviceId && o.agentDeviceId === undefined) {
      o.agentDeviceId = context.route.agentDeviceId;
      o.providerId = context.route.providerId;
    }
    return context;
  }

  async function bootstrapSession(o: CreateOpts, assertAccess?: () => void): Promise<{
    session: Awaited<ReturnType<typeof maker.createSession>>;
    didInjectOrcaInstructions: boolean;
    didInjectProjectContext: boolean;
  }> {
    assertAccess?.();
    await applyPersistedCindyMakeMarker(o, readSessionSource);
    assertAccess?.();
    // 协同远端 Worker 的代理任务行只承接计槽与回报，真实任务在运行设备上，绝不在本机起 Agent。
    if (o.id && await orcaRemoteWorkersForHost?.isRemoteWorker(o.id)) {
      throw new Error('[PRECONDITION_FAILED] this Worker runs on another device and cannot start locally');
    }
    assertAccess?.();
    // Agent 在另一台电脑上运行的任务：恢复时调用方可能没带设备，以任务记录为准。
    if (o.id && o.agentDeviceId === undefined && !o.remoteHostId) {
      const agentDeviceId = await readSessionAgentDeviceId(o.id);
      if (agentDeviceId) o.agentDeviceId = agentDeviceId;
    }
    let providerGroupStart = await applyProviderGroupAssignment(o);
    // 模型与供应商来自那台电脑(由那台按它自己的目录校验)，本机目录里没有它们。
    const agentOnOtherDevice = Boolean(o.agentDeviceId) && !o.remoteHostId;
    if (o.id && !o.remoteHostId) worktreeManager.assertPrecreatedSessionNotCancelled(o.id);
    if (o.id && o.workingDir && !o.remoteHostId) {
      o.workingDir = workingDirectoryRecovery.resolve(o.id, o.workingDir);
      await workingDirectoryRecovery.observe(o.id, o.workingDir).catch((error) => {
        workdirLog.warn('workdir bootstrap observation failed', {
          ...workdirDiagnosticContext(o.id!, o.workingDir), code: workdirDiagnosticErrorCode(error),
        });
      });
    }
    o.hostStartupPreferences = {
      userPrompt: o.userPrompt,
      makerMemoryEnabled: o.makerMemoryEnabled,
      displayReasoning: o.displayReasoning,
    };
    await options.waitForAccountProviderModelsReady();
    const runtimeOverride =
      typeof o.id === 'string' ? getSessionRuntimeControlSnapshot(o.id).effectiveOverride : null;
    if (runtimeOverride && runtimeOverride.agentKind === o.agentKind) {
      o.model = runtimeOverride.model;
      // 供应商组分配到另一台电脑(或经另一台电脑的组改到这里)时，来源由那次分配决定：选中的那台上这个
      // 供应商的 id 可能与原来不同，不让临时调整盖掉。留在本机的照旧按临时调整。
      const groupDecidesSource = providerGroupStart !== null
        && (providerGroupStart.overrideRoute || providerGroupStart.route.agentDeviceId !== null);
      if (!groupDecidesSource) o.providerId = runtimeOverride.providerId;
      o.effort = runtimeOverride.effort ?? undefined;
      o.fastMode = runtimeOverride.fastMode;
    }
    assertAccess?.();
    await applyPersistedReviewMode(o);
    const didInjectOrcaInstructions = o.reviewMode === true ? false : applyOrcaInstructions(o);
    const didInjectProjectContext =
      o.reviewMode === true ? false : await applyProjectContextInjection(o);

    const usingFallback = !!o.id && !!o.workingDir && !o.remoteHostId &&
      workingDirectoryRecovery.isFallback(o.id, o.workingDir);
    assertAccess?.();
    await prepareDirectoryGrantsForBootstrap(o, {
      statDirectory: usingFallback ? statWorkingDirectory : undefined,
      realpathDirectory: usingFallback ? realpathWorkingDirectory : undefined,
      preservePersistedGrants: usingFallback,
      readPersistedWritableDirs: readSessionWritableDirsFromDb,
      persistExistingSession: async (sessionId, patch) => {
        const [existing] = await getDbClient()
          .drizzle.select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        assertAccess?.();
        if (existing) await persistSessionFields(sessionId, patch);
      },
    });

    await hydrateProviderIdBeforeSessionStart(o);
    assertAccess?.();
    /** 本机运行时的启动准入(Agent 在另一台电脑运行时由那台按它自己的目录裁决)。 */
    const admitLocalRoute = async (): Promise<void> => {
      await ensureManagedOllamaReadyForSession({
        providerId: o.providerId,
        remoteHostId: o.remoteHostId ?? null,
        userDataDir: app.getPath('userData'),
      });
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
              .drizzle.select({ model: sessions.model, providerId: sessions.providerId,
                remoteHostId: sessions.remoteHostId, sdkSessionId: sessions.sdkSessionId, agentKind: sessions.agentKind })
              .from(sessions)
              .where(eq(sessions.id, o.id))
              .limit(1);
            verifiedResume =
              !!row && row.model === o.model && (row.providerId ?? null) === (o.providerId ?? null);
            if (o.agentKind === 'codex' && o.remoteHostId) {
              verifiedResume = isVerifiedSshCodexResume(o, row ? { ...row, agentKind: dbToMakerAgentKind(row.agentKind) } : undefined);
            }
          } catch {
            verifiedResume = false;
          }
        }
        if (!verifiedResume) {
          const reroute = await assertModelRouteUsable(o.agentKind, o.model, o.providerId ?? null, o.remoteHostId);
          if (reroute && shouldApplyExclusiveProviderRerouteLive(o.providerId)) {
            o.providerId = reroute;
          }
        } else if (!(o.agentKind === 'codex' && o.remoteHostId) && shouldApplyExclusiveProviderRerouteLive(o.providerId)) {
          const pin = await pinExclusiveSessionProvider(o.agentKind, o.model, o.providerId ?? null);
          if (pin) o.providerId = pin;
        }
      }
    };
    if (!agentOnOtherDevice) await admitLocalRoute();
    assertAccess?.();
    let session: Awaited<ReturnType<typeof maker.createSession>> | undefined;
    while (!session) {
      try {
        session = await maker.createSession(o);
      } catch (error) {
        // 供应商组刚分配的电脑没能启动 Agent(连不上、登录失效等)：换组里下一台再试，
        // 每台最多一次；不该换或没有下一台时照常报错。
        const failedRoute = { agentDeviceId: o.agentDeviceId ?? null, providerId: o.providerId ?? null };
        const next = providerGroupStart && providerGroupService
          ? await providerGroupService.nextAfterStartFailure(providerGroupStart, error).catch((retryError) => {
              log.warn('provider group: choosing the next computer failed', {
                sessionId: o.id,
                error: retryError instanceof Error ? retryError.message : String(retryError),
              });
              return null;
            })
          : null;
        // 分享来的供应商被分享者建成了组：续接回到原来那台却接不下时，组所在电脑发来「需要换一台」凭证
        // (provider-groups.md §6.1 分享的人)：同一个分享位置带交接重新打开，打开时带回凭证，由组换一台。
        const guestRelocation = !next && o.id && o.resumeSessionId && isProviderShareAgentDeviceId(o.agentDeviceId)
          && providerGroupService?.claimGuestStartSwitch(o.id) === true;
        if (!next && !guestRelocation) throw error;
        // 有原生会话要续接：会话在原来那台上，换过去先交接(全量交接 + 全新原生会话 + 分隔条)，这次发送带上交接，
        // 不拿原来那台的会话 id 去别处打开(那边认不出，会悄悄开一个没有上下文的新会话)。
        if (o.id && o.resumeSessionId) {
          const target = next
            ? next.route
            : { agentDeviceId: o.agentDeviceId ?? null, providerId: o.providerId ?? null };
          await relocateForFreshStart(agentSwitchDeps, {
            sessionId: o.id,
            agentDeviceId: target.agentDeviceId,
            providerId: target.providerId,
            from: failedRoute,
            ...(guestRelocation ? { sharedRelocation: true } : {}),
          });
          o.resumeSessionId = undefined;
          if (o.vendorOptions) {
            const fresh = { ...o.vendorOptions };
            for (const key of ['resumeSessionAt', 'forkSession', 'threadId', 'tailTurnsToDrop']) delete fresh[key];
            o.vendorOptions = fresh;
          }
        }
        if (!next) continue;
        providerGroupStart = next;
        o.agentDeviceId = next.route.agentDeviceId ?? undefined;
        o.providerId = next.route.providerId;
        assertAccess?.();
        // 换回本机运行：补上本机的启动准入(停用模型 / 来源、本机模型服务)。
        if (!o.agentDeviceId) await admitLocalRoute();
        assertAccess?.();
      }
    }
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
        providerId: runtimeOverride ? undefined : o.providerId,
        updateProviderId: async (targetSessionId, providerId) => {
          await db.update(sessions).set({ providerId }).where(eq(sessions.id, targetSessionId));
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
      if (runtimeOverride) {
        setSessionEffort(session.id, runtimeOverride.effort);
        setSessionFastMode(session.id, runtimeOverride.fastMode);
      } else {
        // DB 行里的 effort 是历史合法值(固定 effort 模型切换时省略了字段),
        // hydrate 时必须按**当前模型能力**归一化:固定 effort 模型 → null,
        // 可调模型 → 兼容档位。直接回灌旧值会把不支持 reasoningEffort 的模型
        // 请求打给 provider 被拒(issue #3691 / PR #3727 Greptile P1)。
        const hydrateProviderId = getSessionProvider(session.id) ?? o.providerId ?? null;
        const hydrateProvider = getActiveCatalog().providers.find(
          (candidate) => candidate.id === hydrateProviderId,
        );
        const hydrateModel = findCatalogModel(
          hydrateProvider,
          session.model,
          o.agentKind,
        );
        setSessionEffort(
          session.id,
          hydrateModel
            ? resolveCompatibleSessionRuntimeEffort(hydrateModel, efRow?.effort ?? null)
            : efRow?.effort,
        );
        setSessionFastMode(session.id, (efRow?.fastMode ?? false));
      }
    } catch (err) {
      // 来源没能落库 → 所选来源在下次冷启动后消失(本次路由已在启动边界冻结)。
      log.warn('hydrate session provider failed (non-fatal)', {
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

  botCompactRuntimeRefreshHandler = createBotRuntimeRefreshHost({
    getDbClient,maker,log,withSendToSessionLock,hasPendingAgentInteractionForSession,
    hasPendingAgentSwitch:id=>!!agentSwitchDeps.pendingSwitches?.get(id),
    applyPendingAgentSwitch:id=>applyPendingAgentSwitchIfIdle(agentSwitchDeps,id,{bootstrapAfterSwitch:true}),
    buildCreateOptsWithStderr,synthesizeOrcaVendorOptionsFromDb,readSessionExtraDirsFromDb,
    checkWorkDirExists,ensureRemoteReadyForSessionStart,withRehydrateCloseSuppressed,
    preflightBotRuntimeResources,bootstrapSession,markOrcaRoleIfNeeded,broadcastSessionCreated,
  });

  async function refreshBotCapabilityEpochBeforeSend(live:WiredSession):Promise<void>{
    return createBotCapabilityPreflight({getDbClient,coordinator:botCompactRuntimeRefreshCoordinator,
      buildCreateOptsWithStderr,synthesizeOrcaVendorOptionsFromDb,readSessionExtraDirsFromDb,
      preflightBotRuntimeResources:options=>preflightBotRuntimeResources(options)})(live);
  }

  // switchFocus 和 sendToWorker 都可能唤醒 idle worker；统一走这里才能保留 extraDirs。
  // assertCurrent：插件能力权威校验，冷启动前 / bootstrap 后各一次。
  // isCancelled：关闭协同 / 归档 / 显式 idle 会取消尚未落地的唤醒；冷启动前与
  // bootstrap 返回后都要检查，已经拉起的 runtime 要自己关掉（review P1）。
  // 与发送 / 供应商组换电脑共用同一把会话锁这件事由 orcaWorkerResumeScheduler
  // （下方 withSessionLock = withSendToSessionLock）保证：锁内再查一次 live，
  // 换电脑空档不会按旧任务记录把它拉起来。
  async function resumeOrcaWorkerSessionIfMissing(
    target: {
      id: string;
      teamId: string;
      leadSessionId: string;
      sessionId: string;
    },
    assertCurrent?: () => Promise<void>,
    isCancelled?: () => boolean,
  ): Promise<boolean> {
    const live = maker.getSession(target.sessionId);
    if (live) return false;
    if (isCancelled?.()) return false;

    const db = getDbClient().drizzle;
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, target.sessionId))
      .limit(1);
    if (!row) return false;
    // 归档 / 删除后的 worker 不允许被唤醒：关闭协同与 archive 可能和后台预热交错。
    if (row.status !== 'active') return false;
    if (isCancelled?.()) return false;

    const workerVendorOptions = {
      orcaRole: 'worker' as const,
      orcaWorkflowId: target.teamId,
      orcaLeadSessionId: target.leadSessionId,
      orcaWorkerId: target.id,
      orcaWorkerSessionId: target.sessionId,
    };
    const storedExtraDirs = await readSessionExtraDirsFromDb(target.sessionId);
    const writableDirs = await readSessionWritableDirsFromDb(target.sessionId);
    const opts = buildCreateOptsWithStderr({
      id: row.id,
      agentKind: dbToMakerAgentKind(row.agentKind),
      workingDir: row.workingDir ?? '',
      model: row.model,
      effort: row.effort as CreateOpts['effort'],
      fastMode: (row.fastMode ?? false),
      permissionMode: permissionModeOrAsk(row.permissionMode),
      title: row.title,
      resumeSessionId: row.sdkSessionId ?? undefined,
      orcaRole: row.orcaRole as 'worker' | null,
      vendorOptions: workerVendorOptions,
      // 远端 worker 唤醒必须带上 remoteHostId 并走 ensure (SSH 重连 / agent
      // 安装 / codex daemon MCP 注入), 否则会以远端 workingDir 在本机 spawn,
      // 且远端 daemon 的协同 MCP 通道不就绪。
      remoteHostId: row.remoteHostId ?? undefined,
      ...directoryGrantsForRuntime(storedExtraDirs),
      ...(writableDirs.length > 0 ? { writableDirs } : {}),
    });
    await assertCurrent?.();
    await ensureRemoteReadyForSessionStart({ createOpts: opts });
    await applySessionContextWindowBudgetToCreateOpts(target.sessionId, opts, getActiveCatalog());
    await assertCurrent?.();
    if (isCancelled?.()) return false;
    const { session: resumedSession } = await bootstrapSession(opts);
    // bootstrap 之后 runtime 已经存在：从这里开始的任何失败（授权失效 / 账号切换 /
    // 关闭协同 / 归档 / 显式 idle）都必须先关掉刚拉起的 session 再返回或抛错，
    // 否则已归档 worker 会留在运行态（review P1 + Security）。
    const closeResumedSession = async (reason: string) => {
      await maker.closeSession(resumedSession.id).catch((err) => {
        log.warn('orcaWorkerResume: close resumed session failed', {
          sessionId: resumedSession.id,
          reason,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    };
    try {
      await assertCurrent?.();
    } catch (err) {
      await closeResumedSession('assert-current-after-bootstrap');
      throw err;
    }
    if (isCancelled?.() || !(await isOrcaWorkerSessionResumable(target.sessionId))) {
      await closeResumedSession('resume-invalid-after-bootstrap');
      return false;
    }
    await markOrcaRoleIfNeeded(resumedSession.id, 'worker');
    return true;
  }

  /** 唤醒后的会话仍必须是 active；读不到状态按不可唤醒处理（fail-closed）。 */
  async function isOrcaWorkerSessionResumable(sessionId: string): Promise<boolean> {
    try {
      const [row] = await getDbClient()
        .drizzle.select({ status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row?.status === 'active';
    } catch (err) {
      log.warn('orcaWorkerResume: read session status failed', {
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // focus 切换是纯 UI 操作,不再同步等待冷启动(2026-09 实报: 首次切到 dormant worker
  // 要等 ~5s)。resume 仍要发生,但转后台并走共享调度器: per-session 去重 + 与发送路径
  // 共用 sendToSession 锁,避免并发双 bootstrap(实现与不变量见 orcaWorkerResumeScheduler.ts)。
  const orcaWorkerResumeScheduler = createOrcaWorkerResumeScheduler({
    resume: async (
      target: {
        id: string;
        teamId: string;
        leadSessionId: string;
        sessionId: string;
      },
      isCancelled,
      assertCurrent,
    ) => {
      const didResume = await resumeOrcaWorkerSessionIfMissing(
        target,
        assertCurrent,
        isCancelled,
      );
      if (didResume) {
        log.info('orcaWorkerResume: resumed idle worker (session only, no status change)', {
          workerId: target.id,
          sessionId: target.sessionId,
        });
      }
      return didResume;
    },
    withSessionLock: (sessionId, task) =>
      withSendToSessionLock(sessionId, task, () => 'orca-worker-resume'),
  });

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
      botHelperAvailable: getActiveCodexBridgeServerNames()?.includes(REMOTE_BOT_HELPER_SERVER_NAME) ?? false,
      token: getRemoteMcpBridgeToken(),
      bridgeInstanceId: getActiveCodexBridgeInstanceId(),
    };
  }

  async function ensureRemoteReadyForSessionStart(params: {
    session?: { agentKind: AgentKind; remoteHostId: string | null } | null;
    createOpts?: unknown;
  }): Promise<{ remoteCodexDaemonRebootstrapped: true } | void> {
    const ownerGeneration = getActiveAppSession().generation;
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
        (createOpts && typeof createOpts === 'object' ? (createOpts as { id?: unknown }).id : null);
      if (typeof sessionIdForLookup === 'string' && sessionIdForLookup) {
        remoteHostIdToEnsure = await readSessionRemoteHostIdCached(sessionIdForLookup);
      }
    }
    if (!remoteHostIdToEnsure) return;

    if (createOpts && typeof createOpts === 'object') {
      const mutableCreateOpts = createOpts as {
        remoteHostId?: string;
        makerMemoryEnabled?: boolean;
      };
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
      session?.agentKind === 'codex' ||
      session?.agentKind === 'claude-code' ||
      session?.agentKind === 'pi'
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

    // pi 远端:走通用 silent install(probe 远端 pi 二进制,缺/版本不符则安装)。
    await ensureRemoteAgentInstalledOrInstall(remoteHostIdToEnsure, ensureAgentKind);
    // pi-manager 预上传(前置检查点,而非 transport 创建深处 —— R1 生命周期 H3 /
    // R2 安装 M3)。失败不阻断(transport 内还会再 ensure),但提前暴露问题。
    // 注(轮 28 LOW-2):host 不 ready 时此段静默跳过是**有意**的 —— 上方
    // ensureRemoteAgentInstalledOrInstall 已对不 ready 抛 SSH_NOT_CONNECTED,
    // 这里只是 best-effort 增强(与 claude-code 分支的立即 throw 语义对齐点
    // 不同:pi 的 agent 二进制检查已兜底)。
    if (ensureAgentKind === 'pi') {
      const host = getRemoteSshPool().get(remoteHostIdToEnsure);
      if (host?.getStatus() === 'ready') {
        try {
          // 轮 28 MEDIUM:pi-manager bundle 安装/升级进度转发 silent install
          // toast —— 否则 preflight 的 daemon 安装静默(与 ensureRemoteAgent
          // 的 toast 对齐)。
          await ensurePiManagerInstalled(host, log, (event) => {
            const hostId = remoteHostIdToEnsure;
            if (event.kind === 'error') {
              broadcastSilentInstallStatus({
                hostId,
                agentKind: 'pi',
                phase: 'failed',
                message: event.message,
              });
            } else if (event.kind === 'ready') {
              broadcastSilentInstallStatus({ hostId, agentKind: 'pi', phase: 'done' });
            } else {
              // install-upload 是 pi-manager 专属 kind, SILENT_INSTALL_STATUS 的
              // eventKind union 不含它(轮 32 MEDIUM 类型对齐) —— 归入 install-log
              // (renderer phaseText 对未知 kind 保持上次文案, 映射后走通用阶段)。
              broadcastSilentInstallStatus({
                hostId,
                agentKind: 'pi',
                phase: 'progress',
                eventKind: event.kind === 'install-upload' ? 'install-log' : event.kind,
              });
            }
          });
        } catch (err) {
          log.warn('pi-manager preflight install failed (transport will retry)', {
            hostId: remoteHostIdToEnsure,
            error: String((err as Error)?.message ?? err),
          });
        }
      }
    }

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
        if (
          result.ok &&
          result.daemonRebootstrapped &&
          !codexRemoteHasLiveTurn(remoteHostIdToEnsure)
        ) {
          await detachIdleRemoteCodexSessionsOnHost(
            remoteHostIdToEnsure,
            'codex-mcp-daemon-rebootstrap',
            ownerGeneration,
          );
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
    return maker
      .listActiveSessions()
      .some(
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
  // 轮 42 P2(codex-connector):pi 纳入 —— 远端 pi 会话经 getRemotePiAgentProxyEnv
  // 注入 HTTPS_PROXY/HTTP_PROXY 走同一 SSH 代理隧道, 在途 pi turn 也要防
  // Settings 改代理时重建/停隧道打断其网络路径(旧注释「pi 走 responses-bridge
  // 不经代理隧道」已过时, 轮 42 起远端 pi 注入 proxy env)。
  function remoteAgentHasLiveTurn(hostId: string): boolean {
    return maker
      .listActiveSessions()
      .some(
        (s) =>
          s.remoteHostId === hostId &&
          (s.agentKind === 'codex' || s.agentKind === 'claude-code' || s.agentKind === 'pi') &&
          (agentInputCoordinatorHolder?.hasActiveTurnForRewind(s.id) ?? false),
      );
  }
  setAgentProxyLiveTurnChecker(remoteAgentHasLiveTurn);

  // 注(轮 28 LOW-3):pi 会话**不需要** detach —— MCP bridge 变更由
  // invalidatePiEnvironment 的 generation-lease 机制处理(活动会话继续用旧桥,
  // 新会话重建到新桥), 与 codex 的 detach 语义等价。
  async function detachIdleRemoteCodexSessionsOnHost(
    hostId: string,
    reason: string,
    ownerGeneration: number,
  ): Promise<void> {
    if (isAppSessionBoundaryPending() || getActiveAppSession().generation !== ownerGeneration) return;
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
    // Model discovery can own a connection before any Session exists. Daemon
    // bootstrap invalidates that connection too; wait for its retirement before
    // lazy creation reads the catalog, rather than racing the SSH close event.
    await disposeRemoteCodexHostAfterRestart(hostId, ownerGeneration);
  }

  // turn 结束后补一次远端 MCP ensure (best-effort):live turn 期间被推迟的
  // daemon bootstrap (driftUnapplied 持久指纹, 见 codex-remote-mcp.ts) 在
  // idle 时点必然补刀 — 不等用户下次操作 (Greptile: defer 需要可靠自愈
  // 路径)。ensure 幂等, 无漂移时仅一次 config 读 + daemon 探活。经模块级
  // holder 供各 turn 收口路径调用。远端 CC 走 holder 的 detach 补偿
  // (bridge 重建 / 端口重绑已让 fresh 失效时重建 query)。
  refreshRemoteCodexMcpOnTurnSettledHolder = (sessionId: string): void => {
    // Shutdown closes sessions while the dynamic Maker facade rejects access.
    // No remote reconfiguration belongs to the departing owner's boundary.
    if (isAppSessionBoundaryPending()) return;
    const ownerGeneration = getActiveAppSession().generation;
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
            await detachIdleRemoteCodexSessionsOnHost(
              remoteHostId,
              'codex-mcp-turn-settled-rebootstrap',
              ownerGeneration,
            );
          }
        }).catch((err) => {
          log.warn('remote Codex refresh on turn settled failed', {
            hostId: remoteHostId,
            errorName: err instanceof Error ? err.name : 'UnknownError',
          });
        });
      return;
    }
    if (session.agentKind === 'claude-code') {
      void reconcileIfPending;
      getRemoteCcTurnSettledHandler()?.(sessionId);
    }
  };

  const makerSessionRegistry = createElectronIpcHandlerRegistry();
  registerMakerSessionCreateHandler(makerSessionRegistry, {
    // CREATE_SESSION 同样先走 remote ensure:remote draft (尤其 collab
    // lead) 的 SSH 重连 / agent 安装 / codex daemon MCP 注入必须先于
    // bootstrap, 否则 lead 首个 turn 没有 cindy_orca, 与 orca 架构文档的
    // "session start/resume 前置" 契约不符。本地会话 ensure 内部直接返回。
    bootstrapSession: async (co) => {
      await ensureRemoteReadyForSessionStart({ createOpts: co });
      const result = await bootstrapSession(co);
      // maker:create-session 是手机 / device-link 的创建入口，不经过
      // local-db:sessions:create，因此后者维护 recent_workdirs 的逻辑不会运行。
      // worktree 两步流此时 co.workingDir 已是隔离目录；picker 需要记住用户选的
      // 项目根，而不是 auto-* 运行目录。worktreeStore 以同一预生成 sessionId
      // 保存了权威 baseRepo。先完成 best-effort upsert 再让 handler 广播 created，
      // 这样 renderer 收到广播重拉 recent 表时不会撞到写入竞态。
      if (
        co.workspaceKind !== 'dialogue' &&
        !co.remoteHostId &&
        isRetainableProjectSession({ source: 'desktop', orcaRole: co.orcaRole })
      ) {
        const recentProjectDir =
          worktreeStore.get(result.session.id)?.baseRepo ??
          getManagedWorktreeBasePath(co.workingDir) ??
          co.workingDir;
        await upsertRecentWorkdir(recentProjectDir);
      }
      return result;
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
  });

  // 本机作为运行设备：承接另一台电脑上协同 Lead 派来的 Worker 任务(见 orcaRemoteWorkerHost.ts)。
  const writeOrcaRemoteLead = async (sessionId: string, lead: OrcaRemoteLead) => {
    await getDbClient()
      .drizzle.update(sessions)
      .set({ orcaRemoteLead: serializeOrcaRemoteLead(lead) })
      .where(eq(sessions.id, sessionId));
    broadcastSessionPatched(sessionId, { orcaRemoteLead: lead });
  };
  // Cloud companions: another computer asks before handing a companion here (read-only constant).
  makerSessionRegistry.handle(COMPANION_CLOUD_CAPS_CHANNEL, () => ({ companionCloud: COMPANION_CLOUD_VERSION }));
  // Another computer of this account changes where a companion runs: this computer (its home)
  // lists the computers that can receive it and hands it over, exactly as from its own settings.
  makerSessionRegistry.handle(COMPANION_CLOUD_TARGETS_CHANNEL, async () =>
    (await activeCompanionCloud()?.transferTargets()) ?? []);
  makerSessionRegistry.handle(COMPANION_CLOUD_MERGE_CHANNEL, async (_event: unknown, keepBotId: unknown, fromBotIds: unknown) => {
    const keep = companionMergeIds(keepBotId, fromBotIds);
    return (await activeCompanionCloud()?.mergeCindyHere(keep.keep, keep.from)) ?? { ok: false, code: 'NOT_ENABLED' };
  });
  // A merge on another computer reads the cloud: this computer (the copy's home) sends what it has not yet.
  makerSessionRegistry.handle(COMPANION_CLOUD_FLUSH_CHANNEL, async (_event: unknown, botId: unknown) => {
    if (typeof botId !== 'string' || !botId.trim() || botId.length > 200) throwIpcError('INVALID_PARAMS', 'botId required');
    return (await activeCompanionCloud()?.flushHere(botId)) ?? { ok: false, code: 'NOT_ENABLED' };
  });
  makerSessionRegistry.handle(COMPANION_CLOUD_HAND_OVER_CHANNEL, async (_event: unknown, botId: unknown, targetDeviceId: unknown, options: unknown) => {
    if (typeof botId !== 'string' || !botId.trim() || botId.length > 200) throwIpcError('INVALID_PARAMS', 'botId required');
    if (typeof targetDeviceId !== 'string' || !targetDeviceId || targetDeviceId.length > 200) throwIpcError('INVALID_PARAMS', 'targetDeviceId required');
    return (await activeCompanionCloud()?.transfer(botId, targetDeviceId, companionSwitchOptions(options))) ?? { ok: false, code: 'NOT_ENABLED' };
  });
  registerOrcaRemoteWorkerHandlers(makerSessionRegistry, createOrcaRemoteWorkerHost({
    readModels: async (request) => {
      const owner = getCurrentDbClientSnapshot();
      const result = await orcaCollabServiceHolder?.listAvailableModels({ ...request, agentDeviceId: request.agentDeviceId ?? null });
      if (getCurrentDbClientSnapshot() !== owner) throwIpcError('PRECONDITION_FAILED', 'Worker account changed');
      if (!result?.ok) throw new Error(`[${result?.errorCode ?? 'HOST_NOT_READY'}] ${result?.message ?? 'Worker model service is not ready'}`);
      return result;
    },
    getCaller: () => {
      const context = getDeviceLinkInvokeContext();
      return context
        ? {
            controllerDeviceId: context.controllerDeviceId,
            controllerName: context.controllerName,
            sharedTask: context.sharedTask,
          }
        : null;
    },
    readSession: async (sessionId) => {
      const [row] = await getDbClient()
        .drizzle.select({
          orcaRemoteLead: sessions.orcaRemoteLead,
          agentDeviceId: sessions.agentDeviceId,
          providerId: sessions.providerId,
          status: sessions.status,
          workingDir: sessions.workingDir,
          model: sessions.model,
          agentKind: sessions.agentKind,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) return null;
      return {
        orcaRemoteLead: parseOrcaRemoteLead(row.orcaRemoteLead),
        status: row.status,
        workingDir: row.workingDir,
        model: row.model,
        agentKind: row.agentKind === 'cc' ? 'claude-code' : (row.agentKind as 'codex' | 'pi'),
        effort: row.effort,
        fastMode: row.fastMode,
        agentDeviceId: row.agentDeviceId,
        providerId: row.providerId,
      };
    },
    openSession: createOrcaRemoteWorkerSessionOpener({
      openSession,
      isSelfDeviceId: deviceId => deviceId === getSelfDeviceId(),
      captureOwner: () => {
        const owner = getCurrentDbClientSnapshot();
        return () => { if (getCurrentDbClientSnapshot() !== owner) throwIpcError('PRECONDITION_FAILED', 'Worker account changed'); };
      },
      resolveAgentSelection: async request => {
        const views = await readDeviceProviderViews(remoteBackgroundInvoke, request.agentDeviceId!);
        const routing = deviceWorkerRoutingContext(views, request.agentKind);
        const models = routing.remoteCodexModels ?? [];
        const providers = routing.availability[request.agentKind];
        const model = request.model ?? (request.providerId
          ? providers.find(provider => provider.id === request.providerId)?.models[0]
          : models[0]?.id);
        try {
          const selected = resolveSessionExecutionSelection({
            selection: { agentKind: request.agentKind, model, providerId: request.providerId,
              effort: request.effort, fastMode: request.fastMode },
            availableAgents: [request.agentKind], availableModels: models, providerRouting: routing,
            // The connected remote provider owns its credential; it validates the
            // credential again when starting. Never require/copy this host's key.
            hasCindyAiApiKey: true,
          });
          return { ...request, model: selected.model, providerId: selected.providerId ?? undefined,
            effort: selected.effort, fastMode: selected.fastMode };
        } catch (error) {
          throwIpcError('INVALID_PARAMS', error instanceof Error ? error.message : 'Worker model is unavailable');
        }
      },
      insertSession: async (row) => {
        await getDbClient().drizzle.insert(sessions).values(row).run();
      },
      bootstrapSession: async (opened, assertCurrent) => {
        const agentKind = opened.agentKind === 'codex' || opened.agentKind === 'pi'
          ? opened.agentKind
          : 'claude-code';
        await bootstrapSession(buildCreateOptsWithStderr({
          id: opened.id,
          agentKind,
          workspaceKind: opened.workspaceKind,
          // openSession 已为 dialogue 分配目录；project 由调用方给出并经 device-link 目录守卫。
          workingDir: opened.workingDir ?? '',
          model: opened.model,
          providerId: opened.providerId,
          agentDeviceId: opened.agentDeviceId ?? undefined,
          effort: (opened.effort || undefined) as CreateOpts['effort'],
          fastMode: opened.fastMode,
          permissionMode: opened.permissionMode as CreateOpts['permissionMode'],
          title: opened.title,
        }), assertCurrent);
      },
      broadcastSessionCreated,
    }),
    writeRemoteLead: writeOrcaRemoteLead,
    withSessionLock: withSendToSessionLock,
    now: Date.now,
  }));

  makerSessionRegistry.handle(ORCA_REMOTE_WORKER_BRIDGE_CHANNEL, (_event: unknown, raw: unknown) => {
    const ctx = getDeviceLinkInvokeContext();
    return handleRemoteWorkerBridge(raw, ctx ? {
      controllerDeviceId: ctx.controllerDeviceId, sharedTask: ctx.sharedTask,
    } : null);
  });

  const readSourceReviewCards = async (sourceSessionId: string) =>
    getDbClient()
      .drizzle.select({
        clientId: messages.clientId,
        agentMeta: messages.agentMeta,
      })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sourceSessionId),
          gte(messages.clientId, 'review:'),
          lt(messages.clientId, 'review;'),
          eq(messages.role, 'assistant'),
          isNull(messages.rewindAt),
        ),
      );

  const reconcileReviewForSource = async (sourceSessionId: string): Promise<void> => {
    const dbClient = getDbClient();
    const [rows, sourceLease] = await Promise.all([
      readSourceReviewCards(sourceSessionId),
      readPersistedReviewSourceLease(dbClient, sourceSessionId),
    ]);
    const interruptedAt = Date.now();
    for (const row of rows) {
      const reviewRun = readReviewRunFromAgentMeta(row.agentMeta);
      if (!reviewRun || !(await shouldFailInterruptedReview(reviewRun, reviewRunOwner))) continue;
      const failed: ReviewRunMeta = {
        ...reviewRun,
        status: 'failed',
        completedAt: interruptedAt,
        failureCode: 'interrupted',
      };
      await updateMessageContent(sourceSessionId, row.clientId, '');
      await patchMessageAgentMeta(sourceSessionId, row.clientId, { reviewRun: failed });
      await broadcastMessageAgentMetaUpdate(sourceSessionId, row.clientId);
    }
    if (!sourceLease) return;
    if (!sourceLease.lease) {
      await discardInvalidReviewSourceLease(dbClient, sourceLease);
      log.warn('discarded malformed Review source lease', {
        sourceSessionId,
        leaseRowId: sourceLease.id,
      });
      return;
    }
    if (!(await hasReviewOwnerProcessEnded(sourceLease.lease.owner, reviewRunOwner))) return;
    await releaseReviewSourceLease(dbClient, {
      sourceSessionId,
      runId: sourceLease.lease.runId,
      owner: sourceLease.lease.owner,
    });
  };
  const sourceHasPersistedRunningReview = async (sourceSessionId: string): Promise<boolean> => {
    const rows = await readSourceReviewCards(sourceSessionId);
    return rows.some((row) => readReviewRunFromAgentMeta(row.agentMeta)?.status === 'running');
  };
  const sourceHasActiveTurn = async (sourceSessionId: string): Promise<boolean> => {
    if (
      maker.getSession(sourceSessionId)?.isTurnRunning() ||
      sessionTurnActivityTracker.isSessionInTurn(sourceSessionId)
    ) {
      return true;
    }
    return sessionTurnLeaseTracker.isTurnActive(sourceSessionId);
  };
  // This is ordinary attachment hygiene rather than Review recovery. Keep its
  // existing startup behavior while Review-specific work remains on demand.
  void cleanupOrphanedTempAttachments({ currentOwner: reviewRunOwner }).catch((error) => {
    log.warn('failed to clean orphaned temporary attachments', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const ensureReviewRuntimeReady = createRetryableReviewInitialization(async () => {
    try {
      await ensureReviewOwnerLivenessReady();
      await cleanupOrphanedReviewArtifactSnapshots({ currentOwner: reviewRunOwner });
    } catch (error) {
      log.error('failed to prepare Review runtime state', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  const readLatestReviewerResult = async (reviewerSessionId: string): Promise<string> => {
    const rows = await getDbClient()
      .drizzle.select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, reviewerSessionId),
          eq(messages.role, 'assistant'),
          isNull(messages.rewindAt),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(8);
    for (const row of rows) {
      const text = visibleMessageText('assistant', row.content);
      if (text) return text;
    }
    return '';
  };

  const reviewRunControl = registerReviewStartHandler(makerSessionRegistry, {
    captureSourceAccessGuard: (sourceSessionId) => {
      // Capture trusted origin while still in the invoke context, including for
      // a later provider-start callback that may run outside that await chain.
      const remote = isDeviceLinkInvoke();
      return async () => {
        if (remote) {
          await assertRemoteBotInvocationAllowed([{ sourceSessionId }], MAKER_INVOKE.START_REVIEW);
        }
      };
    },
    assertCaller: (event) => {
      // A device-link invoke is already authenticated by the relay, controller
      // lease and remote invoke allowlist. Its synthetic IPC event has no real
      // BrowserWindow sender, so only local Renderer calls use the sender guard.
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
      }
    },
    waitUntilReady: async (sourceSessionId) => {
      await ensureReviewRuntimeReady();
      // Recover only this task when the user explicitly starts Review again.
      // A live or ambiguous peer remains protected by the DB-backed gate.
      await reconcileReviewForSource(sourceSessionId);
    },
    createRunId: randomUUID,
    createReviewerSessionId: randomUUID,
    owner: reviewRunOwner,
    now: Date.now,
    acquireSourceLease: (input) => tryAcquireReviewSourceLease(getDbClient(), input),
    releaseSourceLease: async (input) => {
      await releaseReviewSourceLease(getDbClient(), input);
    },
    prepareRun: async ({ event, request, reviewerSessionId }) => {
      const db = getDbClient().drizzle;
      const [source] = await db
        .select({
          id: sessions.id,
          title: sessions.title,
          workingDir: sessions.workingDir,
          workspaceKind: sessions.workspaceKind,
          model: sessions.model,
          effort: sessions.effort,
          fastMode: sessions.fastMode,
          providerId: sessions.providerId,
          agentKind: sessions.agentKind,
          source: sessions.source,
          remoteHostId: sessions.remoteHostId,
          agentDeviceId: sessions.agentDeviceId,
          status: sessions.status,
        })
        .from(sessions)
        .where(eq(sessions.id, request.sourceSessionId))
        .limit(1);
      if (!source || source.status !== 'active') {
        throwIpcError('NOT_FOUND', 'Source task not found');
      }
      if (await sourceHasPersistedRunningReview(source.id)) {
        throwIpcError('SESSION_RUNNING', 'This task already has a review in progress');
      }
      if (source.source === 'review') {
        throwIpcError('INVALID_PARAMS', 'A review task cannot start another review');
      }
      if (source.remoteHostId) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Review is local-only in this version');
      }
      // Agent 在另一台电脑运行的任务：审查任务会沿用它的模型与来源(都在那台)，而只读审查还不能
      // 在那台运行。
      if (source.agentDeviceId) {
        throwIpcError('UNSUPPORTED_CAPABILITY', 'Review is not available for tasks whose agent runs on another computer');
      }
      if (!source.workingDir) {
        throwIpcError('INVALID_PARAMS', 'The source task has no working directory to review');
      }
      const sourceScope = await resolveReviewScope(source.id);
      let sourceWorkingDir = sourceScope.repoRoot ?? sourceScope.workdir ?? source.workingDir;
      const inReviewWorkspace = <T>(task: () => Promise<T>): Promise<T> =>
        withSessionReviewWorkspace(source.id, sourceWorkingDir, task);
      if (await sourceHasActiveTurn(source.id)) {
        throwIpcError(
          'SESSION_RUNNING',
          'Wait for the current task turn to finish before reviewing',
        );
      }

      let evidence!: Awaited<ReturnType<typeof loadReviewEvidence>>;
      let primaryRepoRoot: string | null = null;
      let additionalRepositories: LoadedReviewRepository[] = [];
      let skippedRepositories: SkippedReviewRepository[] = [];
      let uncheckedTaskDirs = 0;
      let workspaceSelected = false;
      let historyCaptureIncomplete = false;
      let sourceArtifactFingerprint = '';
      let authorizedArtifactPaths: string[] = [];
      let cleanupPreparedArtifacts: (() => Promise<void>) | null = null;
      let cleanupRemoteAttachments: (() => Promise<void>) | null = null;
      let acceptRemoteAttachments: (() => void) | null = null;
      try {
        if (isDeviceLinkInvoke() && request.attachments.length) {
          const remote = await prepareRemoteReviewAttachments(
            request, reviewerSessionId, materializeQueuedOssAttachmentsDeferred,
          );
          request.attachments = remote.attachments;
          acceptRemoteAttachments = remote.onAccepted;
          cleanupRemoteAttachments = remote.cleanup;
          cleanupPreparedArtifacts = remote.cleanup;
        }
        const prepareEvidence = async () => {
          const historicalAttachments = await listReviewHistoricalAttachments(source.id);
          const explicitArtifactGrant = await authorizeReviewExplicitArtifacts({
            workingDir: sourceWorkingDir,
            focus: request.focus,
            attachments: [...request.attachments, ...historicalAttachments],
            resolvePath: resolveReviewArtifactPath,
            confirm: (items) => confirmReviewExternalArtifacts(event as IpcMainInvokeEvent, items),
          });
          authorizedArtifactPaths = explicitArtifactGrant.paths;
          const prepared = await prepareStableReviewArtifactSnapshots({
            workingDir: sourceWorkingDir,
            grant: explicitArtifactGrant,
            owner: reviewRunOwner,
            prepare: (snapshotGrant) =>
              inReviewWorkspace(() => loadReviewEvidence({
                sourceSessionId: source.id,
                workingDir: sourceWorkingDir,
                focus: request.focus,
                attachments: request.attachments,
                explicitArtifactGrant: snapshotGrant,
              })),
          });
          cleanupPreparedArtifacts = async () => {
            try {
              await prepared.cleanup();
            } finally {
              await cleanupRemoteAttachments?.();
            }
          };
          evidence = prepared.value;
          sourceArtifactFingerprint = prepared.fingerprint;
        };
        await prepareEvidence();
        // A task can change several repositories or worktrees (a client worktree
        // plus a server checkout). Review them as one deliverable instead of only
        // the directory the latest tool call happened to use.
        primaryRepoRoot = await resolveReviewRepoRoot(sourceWorkingDir);
        const additional = await loadAdditionalReviewRepositories({
          sourceSessionId: source.id,
          primaryRoot: primaryRepoRoot ?? sourceWorkingDir,
          touchedDirs: await listSessionTouchedDirsLive(source.id),
          warn: (message, fields) => log.warn(message, { sourceSessionId: source.id, ...fields }),
        });
        additionalRepositories = additional.repos;
        skippedRepositories = additional.skipped;
        uncheckedTaskDirs = additional.uncheckedDirs;
        // An empty checkout or non-Git source commonly means the work happened
        // elsewhere. Historical turn metadata cannot tell us which current code
        // the user wants; ask about the directory instead of refusing the run.
        if (
          additionalRepositories.length === 0 &&
          shouldSelectReviewWorkspace(evidence, isDeviceLinkInvoke())
        ) {
          const selectedDir = await selectReviewWorkspace(event as IpcMainInvokeEvent, sourceWorkingDir);
          if (!selectedDir) throwIpcError('MUTATION_CANCELLED', 'Review workspace selection cancelled');
          workspaceSelected = true;
          if (path.resolve(selectedDir) !== path.resolve(sourceWorkingDir)) {
            await cleanupPreparedArtifacts?.();
            sourceWorkingDir = selectedDir;
            await prepareEvidence();
          }
        }
        // Reversible turn capture is advisory. Bash (even `git status`) and
        // overlapping tasks mark it partial; a fresh Git baseline or explicitly
        // selected artifacts must not be blocked by unrelated capture gaps.
        const historicalChangeSet = evidence.changeSet;
        evidence.changeSet = usableReviewChangeSet(evidence.changeSet, sourceWorkingDir, {
          hasGitBaseline: !!evidence.workspaceFingerprint,
          hasExplicitArtifacts: evidence.artifacts.length > 0 || workspaceSelected,
        });
        historyCaptureIncomplete = !!historicalChangeSet && !evidence.changeSet;
        // An explicit directory choice targets its current code, not a turn
        // captured in the previous task directory.
        if (workspaceSelected) evidence.changeSet = null;
      } catch (error) {
        await cleanupPreparedArtifacts?.();
        if (
          error instanceof ReviewArtifactAuthorizationError ||
          error instanceof SensitiveReviewPathError
        ) {
          throwIpcError('PERMISSION_DENIED', error.message);
        }
        throw error;
      }
      // A committed branch is reviewable content on its own: opening an existing
      // worktree and running /review has no conversation, no dirty tree and no
      // turn of its own, yet the branch's commits are exactly what to review.
      if (
        evidence.context.length === 0 &&
        !evidence.workspace?.dirty &&
        !evidence.branch &&
        !evidence.changeSet &&
        evidence.artifacts.length === 0 &&
        additionalRepositories.length === 0 &&
        !request.focus &&
        !workspaceSelected
      ) {
        await cleanupPreparedArtifacts?.();
        // "Nothing to review" and "the branch was there but could not be read"
        // are different answers, and only the second one tells the user what to
        // do about it. The prompt-level warning never runs on this path.
        throwIpcError(
          'INVALID_PARAMS',
          evidence.branchUnavailableReason
            ? `Review could not load this branch's changes (${evidence.branchUnavailableReason})`
            : 'The current task has no reviewable content yet',
        );
      }
      let builtPrompt: ReturnType<typeof buildReviewPrompt>;
      try {
        builtPrompt = buildReviewPrompt({
          focus: evidence.focusPath ? `审查路径：${evidence.focusPath}` : request.focus,
          context: evidence.context,
          historyCaptureIncomplete,
          workspace: evidence.workspace,
          branch: evidence.branch,
          ...(evidence.branchUnavailableReason
            ? { branchUnavailableReason: evidence.branchUnavailableReason }
            : {}),
          changeSet: evidence.changeSet,
          ...(additionalRepositories.length > 0
            ? {
                primaryRoot: primaryRepoRoot ?? sourceWorkingDir,
                additionalRepositories,
              }
            : {}),
          ...(skippedRepositories.length > 0 ? { skippedRepositories } : {}),
          ...(uncheckedTaskDirs > 0 ? { uncheckedTaskDirs } : {}),
          artifacts: evidence.artifacts,
          artifactsOmitted: evidence.artifactsOmitted,
          artifactExcerpts: evidence.artifactExcerpts,
          artifactWarnings: evidence.artifactWarnings,
        });
      } catch (error) {
        await cleanupPreparedArtifacts?.();
        throw error;
      }

      const additionalWorkingDirs = additionalRepositories.map((repo) => repo.root);
      const reviewWorkspaceMeta = {
        workingDir: sourceWorkingDir,
        ...(evidence.branch ? { baseRef: evidence.branch.baseRef } : {}),
        hasUncommittedChanges: !!evidence.workspace?.dirty,
        ...(additionalWorkingDirs.length > 0 ? { additionalWorkingDirs } : {}),
      };
      return {
        sourceAgentKind: source.agentKind as 'cc' | 'codex' | 'pi',
        prompt: builtPrompt.prompt,
        replyLanguage: builtPrompt.replyLanguage,
        inputSummary: buildReviewInputSummary({
          ...reviewWorkspaceMeta,
          uncoveredWorkingDirs: skippedRepositories.map((repo) => repo.root),
          uncheckedTaskDirs,
          artifactCount: evidence.artifacts.length,
          focus: evidence.focusPath ?? request.focus,
        }),
        targetKind: builtPrompt.targetKind,
        workspace: reviewWorkspaceMeta,
        onAccepted: () => acceptRemoteAttachments?.(),
        cleanup: async () => {
          await cleanupPreparedArtifacts?.();
        },
        prepareLaunch: async () => {
          const rawReviewMessage: IpcUserMessage = {
            type: 'user',
            content: [{ type: 'text', text: builtPrompt.prompt }, ...evidence.attachmentBlocks],
          };
          const reviewMessage = await prepareUserMessageForAgent(
            reviewerSessionId,
            rawReviewMessage,
            'send',
          );
          const readRoots = new Set(evidence.readRoots);
          const reviewReadPaths = new Set(evidence.reviewReadPaths);
          if (typeof reviewMessage !== 'string' && Array.isArray(reviewMessage.content)) {
            for (const block of reviewMessage.content) {
              if (
                (block.type === 'image' || block.type === 'file') &&
                typeof block.path === 'string' &&
                path.isAbsolute(block.path)
              ) {
                readRoots.add(path.dirname(block.path));
                reviewReadPaths.add(block.path);
              }
            }
          }
          // Fingerprint what the review actually covers, not the whole
          // workspace: explicit artifacts, attachments and the reviewed change
          // set. The reviewer still reads the full workspace through workingDir,
          // but an unrelated file edit must not invalidate a completed review,
          // and a full-workspace content hash cannot stay inside its byte budget
          // on a real checkout.
          //
          // Change-set paths are bound even when Git evidence exists: the Git
          // fingerprint hashes identity, porcelain status and patches, so an
          // ignored deliverable built by the reviewed turn (dist/report.html)
          // is covered by neither unless it is included here.
          // The change set is the review target only when nothing better was
          // selected. With uncommitted work or a branch diff in hand it is not
          // part of the evidence, so neither its gaps nor its paths belong
          // here — those commits are already represented by the selected
          // evidence, and binding unreviewed paths would let an unrelated turn
          // refuse the review or invalidate its result.
          //
          // The accepted cost: a branch review does not bind an ignored file
          // the latest turn happened to produce, so editing that file mid-review
          // will not invalidate the result. Binding it would mean an unrelated
          // turn — one whose content is not being reviewed — could refuse the
          // review outright or expire it. Between "an unreviewed file went
          // unwatched" and "an unreviewed file blocked a valid review", this
          // takes the first. Reviewing that deliverable is still available by
          // attaching it explicitly, which puts it in reviewReadPaths.
          const changeSetIsReviewed = !evidence.workspace?.dirty && !evidence.branch;
          const changeSetContent = changeSetIsReviewed
            ? reviewChangeSetContentPaths(evidence.changeSet, sourceWorkingDir)
            : { paths: [], truncated: false };
          // A change set that cannot account for everything the turn changed —
          // whether it was summarized away or never enumerable in the first
          // place — cannot serve as a baseline. Refuse instead of publishing a
          // conclusion whose freshness check silently skipped the remainder.
          //
          // A Git fingerprint is not an exemption: it hashes tracked evidence
          // only, so a missing entry that happens to be an ignored deliverable
          // is covered by neither side — exactly the gap this change closes.
          if (changeSetContent.truncated) {
            throw new ReviewPreconditionError({
              code: 'artifact-unavailable',
              message:
                'The reviewed change set cannot account for every file the turn changed, so Review cannot bind a complete content baseline',
            });
          }
          const artifactPaths = [...new Set([...reviewReadPaths, ...changeSetContent.paths])];
          if (workspaceSelected && !evidence.workspaceFingerprint) {
            // A selected non-Git directory has no HEAD/status baseline. Bind
            // its contents with the existing bounded artifact fingerprinter.
            artifactPaths.push(sourceWorkingDir);
          }
          const artifactFingerprintOptions = { linkConfinementRoot: sourceWorkingDir };
          let artifactFingerprint: string;
          try {
            artifactFingerprint = await fingerprintReviewArtifacts(
              artifactPaths,
              artifactFingerprintOptions,
            );
          } catch (error) {
            if (
              error instanceof ReviewArtifactFingerprintChangedError ||
              error instanceof ReviewArtifactFingerprintLimitError
            ) {
              throw new ReviewPreconditionError({
                code: 'artifact-unavailable',
                message: error.message,
              });
            }
            throw error;
          }
          const artifactFingerprintIsCurrent = async (
            paths: readonly string[],
            expected: string,
          ): Promise<boolean> => {
            try {
              return (
                (await fingerprintReviewArtifacts(paths, artifactFingerprintOptions)) === expected
              );
            } catch {
              return false;
            }
          };
          const completeArtifactFingerprintIsCurrent = (): Promise<boolean> =>
            artifactFingerprintIsCurrent(artifactPaths, artifactFingerprint);
          const readCurrentSourceIdentity = async () => {
            const [currentSource] = await db
              .select({
                workingDir: sessions.workingDir,
                workspaceKind: sessions.workspaceKind,
                status: sessions.status,
              })
              .from(sessions)
              .where(eq(sessions.id, source.id))
              .limit(1);
            return currentSource ?? null;
          };

          return {
            message: reviewMessage as UserMessage,
            reviewerCreateOpts: buildCreateOptsWithStderr({
              id: reviewerSessionId,
              agentKind: dbToMakerAgentKind(source.agentKind),
              workingDir: sourceWorkingDir,
              workspaceKind: source.workspaceKind,
              model: source.model,
              effort: source.effort as CreateOpts['effort'],
              fastMode: (source.fastMode ?? false),
              providerId: source.providerId,
              title: buildReviewSessionTitle(source.title),
              permissionMode: 'ask',
              planMode: false,
              reviewMode: true,
              // Additional repositories are read grants only. Their freshness is
              // bound through their Git fingerprints, not the bounded artifact
              // hash, which cannot cover a whole checkout.
              reviewReadPaths: [...reviewReadPaths, ...additionalWorkingDirs],
              makerMemoryEnabled: false,
              ...(readRoots.size > 0 ? { extraDirs: [...readRoots] } : {}),
            }),
            verifyBeforeStart: async (): Promise<ReviewFailureReason | null> => {
              if (!reviewSourceIdentityMatches(source, await readCurrentSourceIdentity())) {
                return {
                  code: 'source-workspace-changed',
                  message:
                    'The source task workspace changed before Review started. Run /review again in the current workspace.',
                };
              }
              if (
                (await sourceHasActiveTurn(source.id)) ||
                (await readReviewContextFingerprint(source.id)) !== evidence.contextFingerprint
              ) {
                return {
                  code: 'source-conversation-changed',
                  message:
                    'The task conversation changed before Review started. Run /review again for the current context.',
                };
              }
              if (
                !(await inReviewWorkspace(() => reviewWorkspaceFingerprintIsCurrent(
                  source.id,
                  evidence.workspaceFingerprint,
                )))
              ) {
                return {
                  code: 'source-files-changed',
                  message:
                    'The task files changed before Review started. Run /review again for the current result.',
                };
              }
              // The workspace fingerprint pins HEAD, not the base it is compared
              // against; a moved base changes the branch diff without touching it.
              if (!(await inReviewWorkspace(() => reviewBranchBaselineIsCurrent(source.id, evidence.branch)))) {
                return {
                  code: 'source-files-changed',
                  message:
                    'The branch comparison base changed before Review started. Run /review again for the current result.',
                };
              }
              if (!(await additionalReviewRepositoriesAreCurrent(source.id, additionalRepositories))) {
                return {
                  code: 'source-files-changed',
                  message:
                    'Files in another reviewed repository changed before Review started. Run /review again for the current result.',
                };
              }
              if (
                !(await artifactFingerprintIsCurrent(
                  authorizedArtifactPaths,
                  sourceArtifactFingerprint,
                ))
              ) {
                return {
                  code: 'artifact-changed',
                  message:
                    'A review artifact changed before Review started. Run /review again for the current result.',
                };
              }
              if (!(await completeArtifactFingerprintIsCurrent())) {
                return {
                  code: 'artifact-changed',
                  message:
                    'A review artifact changed before Review started. Run /review again for the current result.',
                };
              }
              return null;
            },
            verifyBeforePublish: async (): Promise<ReviewFailureReason | null> => {
              if (!reviewSourceIdentityMatches(source, await readCurrentSourceIdentity())) {
                return {
                  code: 'source-workspace-changed',
                  message:
                    'The source task workspace changed while Review was running. Run /review again in the current workspace.',
                };
              }
              if (
                (await sourceHasActiveTurn(source.id)) ||
                (await readReviewContextFingerprint(source.id)) !== evidence.contextFingerprint
              ) {
                return {
                  code: 'source-conversation-changed',
                  message:
                    'The task conversation changed while Review was running. Run /review again for the current context.',
                };
              }
              if (
                !(await inReviewWorkspace(() => reviewWorkspaceFingerprintIsCurrent(
                  source.id,
                  evidence.workspaceFingerprint,
                )))
              ) {
                return {
                  code: 'source-files-changed',
                  message:
                    'The task files changed while Review was running. Run /review again for the current result.',
                };
              }
              if (!(await inReviewWorkspace(() => reviewBranchBaselineIsCurrent(source.id, evidence.branch)))) {
                return {
                  code: 'source-files-changed',
                  message:
                    'The branch comparison base changed while Review was running. Run /review again for the current result.',
                };
              }
              if (!(await additionalReviewRepositoriesAreCurrent(source.id, additionalRepositories))) {
                return {
                  code: 'source-files-changed',
                  message:
                    'Files in another reviewed repository changed while Review was running. Run /review again for the current result.',
                };
              }
              if (
                !(await artifactFingerprintIsCurrent(
                  authorizedArtifactPaths,
                  sourceArtifactFingerprint,
                ))
              ) {
                return {
                  code: 'artifact-changed',
                  message:
                    'A review artifact changed while Review was running. Run /review again for the current result.',
                };
              }
              if (!(await completeArtifactFingerprintIsCurrent())) {
                return {
                  code: 'artifact-changed',
                  message:
                    'A review artifact changed while Review was running. Run /review again for the current result.',
                };
              }
              return null;
            },
          };
        },
      };
    },
    createSourceCard: async ({ sourceSessionId, sourceCardClientId, sourceAgentKind, meta }) => {
      await createDbMessage(sourceSessionId, {
        clientId: sourceCardClientId,
        role: 'assistant',
        content: '',
        agentMeta: { reviewRun: meta },
        agentKind: sourceAgentKind,
      });
    },
    updateSourceCard: async ({ sourceSessionId, sourceCardClientId, meta, result }) => {
      await updateMessageContent(sourceSessionId, sourceCardClientId, result);
      await patchMessageAgentMeta(sourceSessionId, sourceCardClientId, { reviewRun: meta });
      await broadcastMessageAgentMetaUpdate(sourceSessionId, sourceCardClientId);
    },
    publishReviewerLink: async ({ sourceSessionId, sourceCardClientId, meta }) => {
      await patchMessageAgentMeta(sourceSessionId, sourceCardClientId, { reviewRun: meta });
      await broadcastMessageAgentMetaUpdate(sourceSessionId, sourceCardClientId);
    },
    startReviewer: async (createOpts) => {
      const { session } = await bootstrapSession(createOpts);
      return session;
    },
    markReviewerStarted: async (reviewerSessionId, startedAt) => {
      await getDbClient()
        .drizzle.update(sessions)
        .set({ userSendAt: startedAt, updatedAt: startedAt })
        .where(eq(sessions.id, reviewerSessionId));
    },
    broadcastReviewerCreated: broadcastSessionCreated,
    persistReviewerPrompt: async ({ reviewerSessionId, sourceSessionId, runId, prompt, sourceAgentKind }) => {
      // The existing "sent by task" label links the Reviewer back to its source.
      // Reviewer tasks are not in the task list, so this is their durable way back.
      const origin = sessionQueueOriginForDispatcher({
        dispatcherSessionId: sourceSessionId,
        ...(await readSenderIdentity(sourceSessionId)),
        message: prompt,
      });
      await createDbMessage(reviewerSessionId, {
        clientId: `review-prompt:${runId}`,
        role: 'user',
        content: prompt,
        ...(origin ? { agentMeta: { origin } } : {}),
        agentKind: sourceAgentKind,
      });
    },
    drainPersistQueue,
    readReviewerResult: readLatestReviewerResult,
    // Close the loop like an inline review: the source agent receives the
    // conclusion as a hidden host-queued turn attributed to the Reviewer task,
    // and verifies/fixes it. Busy sources queue it behind their current turn.
    forwardResultToSource: async ({ sourceSessionId, reviewerSessionId, runId, result, replyLanguage }) => {
      const followUp = buildReviewFollowUpMessage(result, replyLanguage);
      const sent = await sendToSessionInternal({
        targetSessionId: sourceSessionId,
        clientId: `review-follow-up:${runId}`,
        message: followUp,
        // Hidden host input: the review card is what the user sees; the source
        // agent's reply follows it. The model text omits this prefix.
        persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${followUp}`,
        dispatcherSessionId: reviewerSessionId,
        forceQueue: true,
        autoReviewUserText: { kind: 'delegated-continuation' },
        resumeWithStoredPermissionMode: true,
      });
      if (!sent.ok) {
        throw new Error(`${sent.errorCode}: ${sent.message}`);
      }
      if (sent.wakeKind === 'queued') await awaitAgentInputQueueSnapshotPersistence(sourceSessionId);
    },
    closeReviewer: async (reviewerSessionId) => {
      try {
        await maker.closeSession(reviewerSessionId);
      } finally {
        // startSession can fail after F6/base64 attachments were materialized
        // but before Maker owns the session, so its onClose hook is not enough.
        await cleanupSessionTempAttachments(reviewerSessionId);
      }
    },
    warn: (message, fields) => log.warn(message, fields),
  });
  registerPrecreatedWorktreeDiscardHandler(makerSessionRegistry, {
    assertCaller: (event) => {
      // device-link 的真实调用身份由 invoke async context + allowlist 证明；本机直调仍
      // 必须来自 Cindy 自有顶层 Renderer，不能把删除能力交给 WebView/Ghost。
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
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
      worktreeManager.discardPrecreatedWorktreeByRecoveryKey(sessionId, recoveryKey, options),
    cancel: (sessionId, locator, options) =>
      worktreeManager.cancelPrecreatedWorktree(sessionId, locator, options),
  });

  // turn 运行中登记的切换意图(下一条消息发送时刻由 send 事务 apply)。
  const agentSwitchPending = createPendingAgentSwitchRegistry();
  // User send intent owns the next route boundary, including automatic requests
  // that read the runtime generation after the picker accepted that intent.
  const canApplyAutomaticRuntimeSelection = (sessionId: string, expectedGeneration?: number): boolean =>
    !agentSwitchPending.get(sessionId) &&
    sessionRuntimeGenerationMatches(sessionId, expectedGeneration);
  cancelPendingAgentSwitchHolder = (sessionId) => {
    agentSwitchPending.clear(sessionId);
    appliedContextWindowBudgets.delete(sessionId);
    // Cancelling a route switch must not discard a still-pending budget replay intent.
    broadcastSessionPatched(sessionId, {
      agentSwitchIntent: null,
      agentSwitchIntentCanceled: true,
    });
  };

  const runtimeMutationDeps = () => ({
    maker,
    isSessionInTurn,
    registerPendingCredentialSwitch: registerPendingCredentialSwitchForSession,
    clearPendingCredentialSwitch: clearPendingCredentialSwitchForSession,
    wakeSessionInputQueue: wakeSessionInputAfterCredentialSwitch,
    getPendingCredentialSwitch: getPendingCredentialSwitchTarget,
    codexAuthInjection: getCodexProxyAuthInjectionState(),
    logger: log,
  });

  const reconcileSessionContextWindowBudgetUnderLock = async (
    sessionId: string,
    previous: number | null,
  ): Promise<void> => {
    const live = getMakerIfReady()?.getSession(sessionId);
    if (!live) {
      appliedContextWindowBudgets.delete(sessionId);
      pendingSessionContextWindowBudgetReconciles.delete(sessionId);
      return;
    }
    const latestBudget = await readStoredSessionContextWindowBudget(sessionId);
    if (appliedContextWindowBudgets.has(sessionId)
      && appliedContextWindowBudgets.get(sessionId) === latestBudget) {
      pendingSessionContextWindowBudgetReconciles.delete(sessionId);
      return;
    }
    const [row] = await getDbClient().drizzle
      .select({ agentKind: sessions.agentKind, model: sessions.model, providerId: sessions.providerId })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row?.model) return;
    const agent = dbToMakerAgentKind(row.agentKind);
    const providerId = getSessionProvider(sessionId) ?? row.providerId;
    if (!contextWindowBudgetChangesEffectiveWindow({
      catalog: getActiveCatalog(), agent, providerId, modelId: row.model,
      previous, next: latestBudget,
    })) return;

    const pendingTarget = getPendingCredentialSwitchTarget(sessionId);
    if (pendingTarget) {
      await registerPendingCredentialSwitchForSession(sessionId, {
        ...pendingTarget,
        forceSessionRebuild: true,
      });
      pendingSessionContextWindowBudgetReconciles.add(sessionId);
      return;
    }
    const result = await applyRuntimeSetModelChange({
      ...runtimeMutationDeps(),
      sessionId,
      model: live.model,
      providerId: getSessionProvider(sessionId),
      forceSessionRebuild: true,
    });
    if (result.status === 'applied') {
      appliedContextWindowBudgets.set(sessionId, latestBudget);
      pendingSessionContextWindowBudgetReconciles.delete(sessionId);
      return;
    }
    pendingSessionContextWindowBudgetReconciles.add(sessionId);
  };

  sessionContextWindowBudgetApplier = async (sessionId, change) => {
    const activeMaker = getMakerIfReady();
    if (!activeMaker || !activeMaker.getSession(sessionId)) return;
    await withSendToSessionLock(sessionId, () =>
      reconcileSessionContextWindowBudgetUnderLock(sessionId, change.previous));
  };

  const replayPendingSessionContextWindowBudgetUnderLock = async (
    sessionId: string,
    before?: () => void,
  ): Promise<void> => {
    if (!pendingSessionContextWindowBudgetReconciles.has(sessionId)) return;
    before?.();
    await reconcileSessionContextWindowBudgetUnderLock(
      sessionId, appliedContextWindowBudgets.get(sessionId) ?? null);
  };

  // session-agent-switch:lazy-create 前以 DB 行为真源校正 createOpts。切换后
  // 残留在 renderer store / 排队项里的旧 agentKind/resumeSessionId 若原样 spawn,
  // 会把会话劫持回旧引擎且丢交接注入(规则 9:代码兜底)。send 事务与
  // GET_CONTEXT_USAGE 的 lazy 分支共用(后者无校正曾是审计实锤缺口)。
  // 权限档同样是会话级设置:forceQueue 入队快照不能锁死排队期间的切档,冷启动必须
  // 再读一次当前落库值,否则降档后仍免确认、升档后仍重复询问。
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
          permissionMode: sessions.permissionMode,
          planModeEnabled: sessions.planModeEnabled,
          agentDeviceId: sessions.agentDeviceId,
          remoteHostId: sessions.remoteHostId,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row) return;
      // Agent 换电脑也在发送事务内落地：快照里的旧位置不能把 Agent 拉回原来那台。
      // 缺省(undefined)交给 bootstrapSession 按任务记录读取，与恢复路径同一口径。
      if (!co.remoteHostId && !row.remoteHostId) {
        co.agentDeviceId = row.agentDeviceId ?? undefined;
      }
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
      if (!row.sdkSessionId && co.vendorOptions) {
        // context.rebuild clears the DB sdk_session_id. Queued createOpts may
        // still carry vendor-specific resume/fork anchors from before the close;
        // strip every native continuation hint so CC/Codex bootstrap fresh too.
        const freshVendorOptions = { ...co.vendorOptions };
        for (const key of ['resumeSessionAt', 'forkSession', 'threadId', 'tailTurnsToDrop']) {
          delete freshVendorOptions[key];
        }
        co.vendorOptions =
          Object.keys(freshVendorOptions).length > 0 ? freshVendorOptions : undefined;
      }
      co.providerId = row.providerId;
      co.effort = (row.effort ?? undefined) as CreateOpts['effort'];
      co.fastMode = (row.fastMode ?? false);
      co.permissionMode = permissionModeOrAsk(row.permissionMode);
      // 新建会话的计划模式按落库状态起档：排队项的 createOpts.planMode 是那一条消息的
      // 计划意图（伙伴委派等 Host 输入恒为 false），本轮意图仍由发送事务按原快照传给
      // send，这里只校正冷启动的会话状态，不改本轮是否以计划执行。
      co.planMode = row.planModeEnabled === true;
    } catch (error) {
      // context.rebuild clears sdk_session_id before the next bootstrap. If the
      // DB truth cannot be read, continuing with caller-supplied opts could
      // resurrect the dead native resume/fork/thread; fail closed instead.
      log.warn('lazy-create: DB reconciliation failed; refusing stale native bootstrap', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // 冷 Pi 切模核实前的运行时恢复（#5508）：流程在 coldPiRehydration.ts 内，每条失败
  // 路径都带类别；这里只接 DB、工作目录探测与 bootstrap。
  const rehydrateColdPiRuntimeForWindowVerification = createColdPiRehydrationForWindowVerification({
    hasLiveSession: (sessionId) => !!maker.getSession(sessionId),
    loadSessionRow: async (sessionId) => {
      const [row] = await getDbClient()
        .drizzle.select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row;
    },
    buildCreateOpts: (sessionId, row) =>
      buildCreateOptsWithStderr({
        id: sessionId,
        agentKind: 'pi',
        workingDir: row.workingDir,
        model: row.model,
        providerId: row.providerId,
        effort: (row.effort ?? undefined) as CreateOpts['effort'],
        fastMode: (row.fastMode ?? false),
        permissionMode: (row.permissionMode ?? 'ask') as CreateOpts['permissionMode'],
        planMode: !!row.planModeEnabled,
        title: row.title ?? undefined,
        resumeSessionId: row.sdkSessionId,
        orcaRole: row.orcaRole ?? undefined,
      }),
    checkWorkDirExists: (sessionId, workingDir, agentKind, remoteHostId) =>
      checkWorkDirExists(sessionId, workingDir, agentKind, remoteHostId),
    prepareCreateOpts: async (sessionId, createOpts) => {
      await synthesizeOrcaVendorOptionsFromDb(sessionId, createOpts);
      const extraDirs = await readSessionExtraDirsFromDb(sessionId);
      if (extraDirs.length > 0) createOpts.extraDirs = extraDirs;
    },
    bootstrapSession: (createOpts) => bootstrapSession(createOpts),
  });

  const agentSwitchDeps: MakerSessionAgentSwitchHandlerDeps = {
    // 换到供应商组那一项时由组选一台能用的电脑(provider-groups.md §6)。
    resolveProviderGroupTarget: (sessionId, target) =>
      providerGroupService ? providerGroupService.resolveSwitchTarget(sessionId, target) : Promise.resolve(null),
    withSessionLock: withSendToSessionLock,
    // 停用轴边界裁决:目标路由被停用 → 抛错;隐式默认落点被停用 → 返回启用替代来源。
    // Agent 在另一台电脑运行的任务：目标模型属于那台的目录，由那台的 Agent 启动时裁决(选择时另
    // 有 assertAgentDeviceRouteUsable 预检)。本次选择换了位置时按目标位置判断。
    assertModelRouteUsable: async (agent, model, providerId, sessionId, targetAgentDeviceId) => {
      const agentDeviceId = targetAgentDeviceId !== undefined
        ? targetAgentDeviceId
        : sessionId ? await readSessionAgentDeviceId(sessionId) : null;
      return agentDeviceId ? undefined : assertModelRouteUsable(agent, model, providerId);
    },
    assertAgentDeviceRouteUsable,
    describeAgentDevice,
    getSessionRow: async (sessionId) => {
      const db = getDbClient().drizzle;
      const [row] = await db
        .select({
          id: sessions.id,
          agentKind: sessions.agentKind,
          model: sessions.model,
          providerId: sessions.providerId,
          status: sessions.status,
          remoteHostId: sessions.remoteHostId,
          orcaRole: sessions.orcaRole,
          orcaRemoteLead: sessions.orcaRemoteLead,
          sdkSessionId: sessions.sdkSessionId,
          source: sessions.source,
          agentDeviceId: sessions.agentDeviceId,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },
    getLiveSession: (sessionId) => maker.getSession(sessionId),
    closeSession: (sessionId) => maker.closeSession(sessionId, 'agent-switch'),
    listMessagesForHandoff: (sessionId, after) =>
      listMessagesForAgentHandoff(sessionId, 400, after),
    findParkedEngineSession: (sessionId, targetDbKind) =>
      findParkedEngineSession(sessionId, targetDbKind),
    applyAgentSwitchToDb: async (sessionId, patch) => {
      // 把 Agent 挪到另一台电脑时那台的目录才算数，不拿本机目录的窗口写进去。
      const movingToOtherDevice = typeof patch.agentDeviceId === 'string';
      const verifiedWindow = movingToOtherDevice ? undefined : lookupVerifiedContextWindow(
        (agentKind, modelId, pid) =>
          resolveConfiguredContextWindow(
            getActiveCatalog(),
            dbToMakerAgentKind(agentKind || patch.agentKind),
            pid,
            modelId,
          ),
        patch.model,
        patch.providerId ?? null,
        dbToMakerAgentKind(patch.agentKind),
      );
      await applyAgentSwitchToSessionRow(sessionId, {
        ...patch,
        ...(verifiedWindow ? { contextWindow: verifiedWindow } : {}),
      });
    },
    setSessionProvider,
    supersedePendingCredentialSwitch: clearPendingCredentialSwitchForSession,
    insertBoundaryMessage: async (sessionId, content) => {
      const clientId = `agent-switch:${createId()}`;
      await createDbMessage(sessionId, { clientId, role: 'agent_switch', content });
      return clientId;
    },
    applyResumeFallbackAtomically: applyAgentSwitchResumeFallbackAtomically,
    setPendingHandoff: (sessionId, handoff, expectedGeneration) =>
      agentHandoffPending.set(sessionId, handoff, expectedGeneration),
    readPendingHandoffGeneration: (sessionId) => agentHandoffPending.readGeneration(sessionId),
    rememberThinkingIntent: ({ agentKind, providerId, model, thinking }) => {
      setThinkingEnabledInMemory(agentKind, providerId, model, thinking);
      // 同步本机 renderer 的记忆：主进程写的只是镜像，renderer 才是 providerModelMemory
      // 的真相源。不写回这一笔，renderer 的全量快照会一直「尚未包含该选择」，提交时写入
      // 的钉子也就撤不掉，反而会长期压住用户在被控端后来的显式改动（Greptile P1）。
      broadcastToAllWindows(MAKER_PUSH.DRAFT_PREF_APPLY, {
        agent: agentKind,
        providerId: providerId ?? '',
        modelId: model,
        active: false,
        thinking,
      });
    },
    bootstrapSwitchedSession: async (sessionId, opts) => {
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
        fastMode: (row.fastMode ?? false),
        permissionMode: (row.permissionMode ?? 'ask') as CreateOpts['permissionMode'],
        planMode: false,
        // 跨引擎意图期内改的思考开关必须显式带入：否则 createSession 只能读被控端
        // 镜像/默认值，与用户刚选的不一致（device-link 远程场景）。
        ...(opts?.thinkingEnabled !== undefined
          ? { thinkingEnabled: opts.thinkingEnabled }
          : {}),
        title: row.title ?? undefined,
        resumeSessionId: row.sdkSessionId ?? undefined,
        // 远端会话切换引擎后仍是远端:带回 remoteHostId 并走 ensure (SSH
        // 重连 / agent 安装 / codex daemon MCP 注入), 否则会以远端
        // workingDir 在本机 spawn。
        remoteHostId: row.remoteHostId ?? undefined,
        vendorOptions: resolveSwitchedSessionVendorOptions(sessionId),
      });
      // 协同的 Lead / Worker(只有供应商组换电脑会走到这里)：按任务记录带回协同身份、提示词与协同工具，
      // 换过去的那台照常是团队成员，不等下一次发送再重启一次。
      if (row.orcaRole) await synthesizeOrcaVendorOptionsFromDb(sessionId, co);
      if (co.extraDirs === undefined) {
        try {
          const extraDirs = await readSessionExtraDirsFromDb(sessionId);
          if (extraDirs.length > 0) Object.assign(co, directoryGrantsForRuntime(extraDirs));
        } catch (err) {
          log.warn('agent-switch bootstrap: read extra_dirs from DB failed (non-fatal)', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (co.writableDirs === undefined) {
        const writableDirs = await readSessionWritableDirsFromDb(sessionId).catch(() => []);
        if (writableDirs.length > 0) co.writableDirs = writableDirs;
      }
      await ensureRemoteReadyForSessionStart({ createOpts: co });
      await bootstrapSession(co);
      broadcastSessionCreated(sessionId);
    },
    withCloseSuppressed: withRehydrateCloseSuppressed,
    pendingSwitches: agentSwitchPending,
    selectSameAgentModel: createSameAgentModelSelection((...args) => applySessionRuntimeSelection(...args)),

    onPendingSwitchChanged: (sessionId, intent) => {
      if (intent) recordUserSessionRuntimeMutation(sessionId);
      broadcastSessionPatched(sessionId, { agentSwitchIntent: intent });
    },
    // 用户选择落地 → 给 IM 任务打「脱离跟随」标记(同值重选也永久脱离, PR #5155)。
    onUserRouteSelectionLanded: async (sessionId) => {
      await updateScheduledPreference(sessionId, null);
      await markImSessionManualRouteOverride(sessionId);
    },
    log,
  };
  registerMakerSessionAgentSwitchHandler(makerSessionRegistry, agentSwitchDeps);

  /** 终态错误后输入协调器收尾、turn 真正停下来再交接(交接拒绝运行中的 turn)。 */
  async function waitForProviderGroupTurnIdle(sessionId: string): Promise<void> {
    for (let i = 0; i < 40 && maker.getSession(sessionId)?.isTurnRunning(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  providerGroupService = createProviderGroupService({
    router: getProviderGroupRouter(),
    directory: getProviderGroupDirectory(),
    readGroup: readProviderGroup,
    // 同账号另一台电脑上的组(docs/product-rules/provider-groups.md §4「同账号直连」)。
    remote: getProviderGroupRemoteGroups(),
    localDeviceId: getSelfDeviceId,
    readBinding: readProviderGroupBinding,
    writeBinding: (sessionId, binding) => writeProviderGroupBinding(sessionId, binding),
    isReleased: isProviderGroupReleased,
    markReleased: (sessionId, group) => markProviderGroupReleased(sessionId, group),
    readSessionRow: readProviderGroupSessionRow,
    resolveImplicitProvider: resolveProviderGroupImplicitProvider,
    persistRoute: persistProviderGroupRoute,
    hasAssistantHistory: hasProviderGroupAssistantHistory,
    isFailoverEligible: isProviderGroupFailoverEligible,
    leaseRecovery: (sessionId, token) =>
      agentInputCoordinatorHolder?.leaseUsageLimitRecovery(sessionId, token) ?? null,
    isLeaseCurrent: (sessionId, lease) =>
      agentInputCoordinatorHolder?.isUsageLimitRecoveryLeaseCurrent(sessionId, lease) ?? false,
    rearmContinue: (sessionId, lease, resumeAt) =>
      agentInputCoordinatorHolder?.rearmUsageLimitWait(sessionId, lease, resumeAt) ?? null,
    cancelContinue: (sessionId, token) => {
      agentInputCoordinatorHolder?.cancelUsageLimitWait(sessionId, token);
    },
    switchAgentLocation: async (sessionId, route, switchOptions) => {
      const isCurrent = switchOptions?.isCurrent;
      const assertCurrent = () => {
        if (isCurrent && !isCurrent()) throw new Error(PROVIDER_GROUP_SUPERSEDED_ERROR);
      };
      // 换电脑是本机的决定：即使这次发送来自手机或另一台电脑，也不继承它的 device-link 来源，否则换不过去的
      // 原因(那台连不上等)会被降级成 PRECONDITION_FAILED，判定认不出是那台的问题，就不再试下一台。
      const run = () => runOutsideDeviceLinkInvokeContext(async () => {
        assertCurrent();
        const result = await performSessionAgentSwitch(agentSwitchDeps, {
          sessionId,
          targetAgentKind: route.agentKind,
          model: route.model,
          providerId: route.providerId,
          agentDeviceId: route.agentDeviceId,
          applyNow: true,
          // 引擎与模型不变、只换位置：协同的 Lead 与 Worker 也接受这种切换。
          providerGroupRelocation: true,
          // 分享的人换电脑：位置仍是同一个分享，强制重新交接，由组所在电脑换一台。
          ...(switchOptions?.relocate ? { forceRelocation: true } : {}),
          // 发送前换电脑：随后的 lazy-create 按任务记录在新电脑上启动，不重复 bootstrap。
          ...(switchOptions?.beforeSend ? { skipBootstrap: true } : {}),
          // 用户确认为了先用那台的配额换号：分隔条写明原因。
          ...(switchOptions?.reason ? { providerGroupSwitchReason: switchOptions.reason } : {}),
          // 用户在等锁、读交接素材期间接手：在改动之前停下。
          ...(isCurrent ? { assertSelectionCurrent: assertCurrent } : {}),
        });
        // 同引擎同位置等情况会按 no-op 返回：没有真正换过去，按交接失败处理。
        if (!result.switched) throw new Error('provider group: the agent switch did not apply');
        // 运行中换电脑：换过去的那台没能把 Agent 启动起来时按换不过去处理，由调用方按同一个判定换下一台，不把续跑
        // 交给一台起不来的电脑(续跑会再失败，协同 Worker 还会一直停在运行中)。发送前换电脑随后照常 lazy-create。
        if (!switchOptions?.beforeSend && !result.engineReady) {
          throw new Error(result.bootstrapError || '[REMOTE_AGENT_UNAVAILABLE] the agent did not start on that computer');
        }
      });
      // 发送前换电脑已在发送事务里；运行中失败后的换电脑是异步触发的，与其他内部调用一样在发送锁内交接，
      // 不与用户同时发来的消息交错。
      if (switchOptions?.beforeSend) {
        await run();
        return;
      }
      assertCurrent();
      await waitForProviderGroupTurnIdle(sessionId);
      assertCurrent();
      await withSendToSessionLock(sessionId, run);
    },
    isTurnRunning: (sessionId) => maker.getSession(sessionId)?.isTurnRunning() ?? false,
    // 没有开着的会话(或已出错)时这次发送要重新打开 Agent 所在电脑上的会话：发送前现读那台的状态。
    hasLiveSession: (sessionId) => {
      const live = maker.getSession(sessionId);
      return live?.getStatus() === 'active' && !live.hasStartedClosing();
    },
    // 分享来的供应商被分享者建成了组：组所在电脑发来「需要换一台」时自动交接(provider-groups.md §6.1)。
    guestSwitch: getProviderGroupGuestSwitch(),
    continueSession: async (sessionId, token, info) =>
      agentInputCoordinatorHolder
        ? agentInputCoordinatorHolder.continueAfterUsageLimitReset(sessionId, token, info)
        : 'superseded',
    fallback: (sessionId, signals, token) => usageLimitAutoResume.onTurnError(sessionId, signals, token),
    // 组内电脑的报错用那台机器的本地时间：不带时区的钟点不按本机时区理解。
    readResetAt: (signals) => readTurnUsageResetAt(signals, Date.now(), { localTimeZoneTrusted: false }),
    // 任务里选过「以后自动换」的换号(provider-groups.md §6.2「任务进行中换号」)。
    readAutoRebalance: readProviderGroupAutoRebalance,
    writeAutoRebalance: (sessionId) => writeProviderGroupAutoRebalance(sessionId),
    now: () => Date.now(),
    log,
  });
  setProviderGroupTurnProbe((sessionId) => maker.getSession(sessionId)?.isTurnRunning() ?? false);
  // 模型列表把归组的任务显示在组那一项下(provider-groups.md §10)。
  const sessionGroupService = providerGroupService;
  setProviderGroupSessionGroupReader((sessionId) => sessionGroupService.sessionGroup(sessionId));
  // 电脑与手机发送前问要不要换号、记下用户的决定(provider-groups.md §6.2「任务进行中换号」)。
  setProviderGroupSessionRebalance({
    suggest: (sessionId) => sessionGroupService.rebalanceSuggestion(sessionId),
    decide: (sessionId, memberKey, remember, clientId) => sessionGroupService.rebalanceDecision(sessionId, memberKey, remember, clientId),
  });
  // 这台电脑上每个供应商正在运行一轮的任务数：组里「本机」这台显示它，同账号电脑读目录时也带上(§5)。
  setProviderGroupLocalLoad(() => countProviderRunningTurns({
    listTurnRunningSessions: () => maker.listActiveSessions().filter((s) => s.isTurnRunning()).map((s) => s.id),
    readSessionRoutes: readProviderLocalLoadRoutes,
    resolveImplicitProvider: resolveProviderGroupImplicitProvider,
    hostRunningProviders: remoteAgentHostRunningProviders,
  }));
  // 经另一台电脑上的组运行的任务：开始 / 结束一轮时报告给组所在电脑，让它的分配看到真实负载。
  providerGroupLeaseReporter?.dispose();
  providerGroupLeaseReporter = createProviderGroupLeaseReporter({
    listRemoteBindings: listRemoteProviderGroupBindings,
    isTurnRunning: (sessionId) => maker.getSession(sessionId)?.isTurnRunning() ?? false,
    send: (ownerDeviceId, seq, entries) => getProviderGroupRemoteClient().leases(ownerDeviceId, seq, entries),
    now: () => Date.now(),
    log,
  });
  const leaseReporter = providerGroupLeaseReporter;
  sessionTurnActivityTracker.setSessionTurnChangeListener((sessionId) => leaseReporter.notify(sessionId));
  // 经另一台电脑的组用掉的用量：启动后(账号确定之后)与之后换了账号时，把当前账号还没送到的整份报一次。
  const usageReportTimer = setInterval(() => ensureProviderGroupUsageReporter(), PROVIDER_GROUP_USAGE_ENSURE_INTERVAL_MS);
  (usageReportTimer as { unref?: () => void }).unref?.();
  setTimeout(() => ensureProviderGroupUsageReporter(), PROVIDER_GROUP_USAGE_STARTUP_DELAY_MS).unref?.();
  registerMakerMessageDeleteHandler(makerSessionRegistry, {
    getSessionRow: async (sessionId) => {
      const [row] = await getDbClient()
        .drizzle.select({ status: sessions.status, agentKind: sessions.agentKind })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      return row ?? null;
    },
    getMessage: getMessageDeletionTarget,
    listMessagesForContext: (sessionId) => listMessagesForAgentHandoff(sessionId, 400),
    pruneWorkingMemory: (sessionId, deletedMessageIds) =>
      pruneWorkingMemoryForSession(sessionId, ownerScopedUserDataPath(), deletedMessageIds),
    getLiveSession: (sessionId) => maker.getSession(sessionId),
    hasBackgroundActivity: getClaudeSessionBackgroundActivity,
    closeSession: (sessionId) => maker.closeSession(sessionId),
    drainPersistQueue,
    commitDeletion: commitMessageDeletion,
    setPendingHandoff: (sessionId, handoff, expectedGeneration) =>
      agentHandoffPending.set(sessionId, handoff, expectedGeneration),
    readPendingHandoffGeneration: (sessionId) => agentHandoffPending.readGeneration(sessionId),
    onCommitted: (
      { sessionId, deletedClientIds, subagentRunIds, updatedAt, preview },
      requestedClientId,
    ) => {
      broadcastMessageDeleted({
        sessionId,
        clientId: requestedClientId,
        clientIds: deletedClientIds,
      });
      for (const runId of subagentRunIds) {
        broadcastSubagentRunsChanged({ sessionId, runId, created: false, firstForSession: false });
      }
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
  const applyScheduledProfile = async (
    sessionId: string, selection: ScheduledModelSelection, signal?: AbortSignal,
  ) => applyScheduledModelSelection(selection, {
    getTarget: async () => {
      const row = await agentSwitchDeps.getSessionRow(sessionId);
      return row ? { agentKind: dbToMakerAgentKind(row.agentKind), status: row.status,
        remoteHostId: row.remoteHostId, orcaRole: row.orcaRole } : null;
    },
    isBusy: () => isSessionInTurn(sessionId) || !!maker.getSession(sessionId)?.isTurnRunning(),
    resolveSelection: async (route) => {
      // Agent 在另一台电脑运行的任务:自动化的选择按那台的已授权目录解析,本机停用轴不适用。
      const row = await agentSwitchDeps.getSessionRow(sessionId);
      if (row?.agentDeviceId && !row.remoteHostId) {
        return resolveScheduledModelSelectionLive(route, { agentDeviceId: row.agentDeviceId });
      }
      const reroute = await assertModelRouteUsable(route.agentKind, route.model, route.providerId);
      return resolveScheduledModelSelectionLive({ ...route,
        providerId: reroute && shouldApplyExclusiveProviderRerouteLive(route.providerId)
          ? reroute : route.providerId,
      });
    },
    switchHarness: async (route) => {
      const [savedModes] = await getDbClient().drizzle
        .select({ planMode: sessions.planModeEnabled }).from(sessions)
        .where(eq(sessions.id, sessionId)).limit(1);
      const result = await performSessionAgentSwitch({
        ...agentSwitchDeps, pendingSwitches: undefined, onPendingSwitchChanged: undefined,
      }, {
        sessionId, targetAgentKind: route.agentKind, model: route.model,
        providerId: route.providerId, effort: route.effort, fastMode: route.fastMode,
        applyNow: true, configStaged: true, signal,
      });
      // An automatic model choice does not exit the owner's plan mode.
      if (savedModes?.planMode) {
        await persistSessionFields(sessionId, { planModeEnabled: true });
        await maker.getSession(sessionId)?.setPlanMode(true);
      }
      return result;
    },
    applyModel: async (route) => {
      if (signal?.aborted) throw new Error('Scheduled model selection aborted');
      const result = await applySessionRuntimeSelection(sessionId, route.model, route.providerId,
        { effort: route.effort, fastMode: route.fastMode },
        { source: 'user', configStaged: true, sessionLockHeld: true, applyingUserSelectionOnSend: true });
      if (result.deferred) throw new ScheduledModelSelectionBusyError('Scheduled model selection deferred');
      if (result.superseded || runtimeSelectionRequiresModelWindowConfirmation(result)) {
        throw new Error('Scheduled model selection could not be applied');
      }
    },
  });
  const scheduledModelScope = createScheduledModelScope({
    createId,
    ownerEpoch: captureSessionRuntimeControlOwnerEpoch,
    read: async (sessionId) => {
      const [row] = await getDbClient().drizzle.select({
        agentKind: sessions.agentKind, model: sessions.model, providerId: sessions.providerId,
        effort: sessions.effort, fastMode: sessions.fastMode, baseline: sessions.scheduledModelBaseline,
        status: sessions.status,
      }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      return row?.status === 'active' ? { baseline: row.baseline, profile: {
        agentKind: dbToMakerAgentKind(row.agentKind), model: row.model, providerId: row.providerId,
        effort: row.effort, fastMode: row.fastMode,
      } } : null;
    },
    write: async (sessionId, baseline) => {
      const owner = captureSessionRuntimeControlOwnerEpoch();
      const db = getDbClient().drizzle;
      const [row] = baseline ? [] : await db.select({ baseline: sessions.scheduledModelBaseline })
        .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      const saved = parseScheduledModelBaseline(row?.baseline);
      if (!sessionRuntimeControlOwnerEpochMatches(owner)) throw new Error('Account changed during scheduled model selection');
      await db.update(sessions)
        .set({
          scheduledModelBaseline: baseline ? JSON.stringify(baseline) : null,
          ...(saved ? {
            agentKind: makerToDbAgentKind(saved.agentKind), model: saved.model,
            providerId: saved.providerId, effort: saved.effort ?? undefined, fastMode: saved.fastMode,
          } : {}),
        })
        .where(eq(sessions.id, sessionId));
      await broadcastSessionRuntimeProjection(sessionId);
    },
    isBusy: (sessionId) => isSessionInTurn(sessionId) || !!maker.getSession(sessionId)?.isTurnRunning() ||
      isUserPendingAgentSwitchIntent(agentSwitchPending.get(sessionId)),
    apply: async (sessionId, profile) => { await applyScheduledProfile(sessionId, profile); },
  });
  const { updateScheduledPreference, updateSavedScheduledAxis } = createScheduledPreferenceStore({
    getDbClient, broadcastSessionRuntimeProjection, getDesktopProviderService, getActiveCatalog, resolveSessionRuntimeAxes,
  });
  prepareScheduledModelPreferencesHolder = async (sessionId, override) => {
    if (override) await scheduledModelScope.begin(sessionId);
    else await scheduledModelScope.restore(sessionId);
  };
  pendingAgentSwitchApplyHolder = async (sessionId, signal, selection, beforeApply, scheduledModelOverride) => {
    let stage = 'direct-send:acquire';
    let deferPendingApply = false;
    const release = await acquireSendToSessionLock(sessionId, undefined, () => stage);
    try {
      // An automation with a model override goes straight to its own route. Restoring
      // the owner first could destructively shrink history that this send can use.
      if (!selection && !scheduledModelOverride) await scheduledModelScope.restore(sessionId);
      // Read after acquisition: a picker can have been queued ahead of this
      // send. Restore under this same lease through dispatch, without re-taking it.
      const pendingSelection = agentSwitchPending.get(sessionId);
      if (!signal?.aborted && isUserPendingAgentSwitchIntent(pendingSelection)) {
        stage = 'direct-send:restoreArchivedSession';
        await restoreArchivedSessionForSend(sessionId, { routeLockHeld: true, signal });
      }
      stage = 'direct-send:reconcileBotModelRoute';
      await reconcileBotModelRoute(sessionId, true);
      if (beforeApply) {
        stage = 'direct-send:beforeApply';
        // 回调(IM 渠道默认跟随对齐)返回 true = 跟随切换被暂缓(会话有后台工作 / 待处理
        // 交互): 本次不能再走通用意图应用 —— 那里只看 isTurnRunning, 会把刚登记的意图
        // 立即应用, 跨引擎时关闭并重建仍在承载后台工作的 Session, 绕过跟随自己的安全
        // 边界(PR #5155 review P1)。意图留待安全边界 / 下一条消息。
        deferPendingApply = (await beforeApply()) === true;
      }
      stage = 'direct-send:applyPendingAgentSwitchIfIdle';
      if (!deferPendingApply) {
        await applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId, {
          bootstrapAfterSwitch: true,
          signal,
        });
      }
      await replayPendingSessionContextWindowBudgetUnderLock(sessionId, () => {
        stage = 'direct-send:reconcileContextWindowBudget';
      });
      let resolvedSelection: ScheduledModelSelection | undefined;
      if (selection) {
        stage = 'direct-send:applyScheduledModelSelection';
        await scheduledModelScope.begin(sessionId);
        resolvedSelection = await applyScheduledProfile(sessionId, selection, signal);
      }
      stage = 'direct-send:prepareUnhealthySession';
      await contextOverflowRolloverHolder?.prepareUnhealthySession(sessionId);
      // The caller retains the lease through runtime refresh and Session.send.
      stage = 'direct-send:caller-dispatch';
      return { release, selection: resolvedSelection };
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
    uiAssignmentSnapshotBeforeMs: number;
    workerPermissionMode: OrcaWorkerPermissionMode;
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
      deferDelegateTask: opts.deferDelegateTask,
      workerPermissionMode: opts.workerPermissionMode,
      ...(opts.executionDeviceId
        ? {
            executionDeviceId: opts.executionDeviceId,
          }
        : {}),
      ...(opts.workingDir !== undefined ? { workingDir: opts.workingDir } : {}),
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
      ...(opts.agentDeviceId !== undefined ? { agentDeviceId: opts.agentDeviceId } : {}),
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
      uiAssignmentSnapshotBeforeMs: result.uiAssignmentSnapshotBeforeMs,
      workerPermissionMode: result.workerPermissionMode,
      ...(result.dispatchOutcome ? { dispatchOutcome: result.dispatchOutcome } : {}),
    };
  }

  async function assertLeadCollabProjectEnabled(leadSessionId: string): Promise<void> {
    await assertReviewSettingsUnlocked(leadSessionId);
    const lead = maker.getSession(leadSessionId);
    const leadRow = await getSessionRowSnapshot(leadSessionId);
    // Worker 不能再当 Lead：本机 Worker 的 MCP 工具已按 vendorOptions 拒绝，这里补上
    // IPC / 远程入口；另一台电脑派来的远端 Worker 同样不能嵌套开启协同。
    if (leadRow?.orcaRole === 'worker' || leadRow?.orcaRemoteLead) {
      throwIpcError('PRECONDITION_FAILED', '[WORKER_CANNOT_NEST] a worker task cannot start collaboration');
    }
    const rawWorkingDir =
      typeof leadRow?.workingDir === 'string' ? leadRow.workingDir : lead?.workDir;
    const normalizedWorkingDir =
      typeof rawWorkingDir === 'string'
        ? (normalizeWorkingDirForProjectSettings(rawWorkingDir) ?? rawWorkingDir)
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
      isManagedDialogueWorkspace,
    );
  }

  async function sendUserMessageWithAwaitedGitBaseline(
    session: SendToSessionDispatchSession,
    message: string,
    anchorClientId: string,
    opts: SessionSendOptions,
    /**
     * 本条落库行的来源(origin / sourcePlugin),只用于在 wire 上前置 `[消息来源]`;
     * persistedText 用来识别主机隐藏指令(不加说明)。空闲直发不经 send 事务,
     * 说明只在这里加一次。
     */
    source?: { origin?: unknown; sourcePlugin?: unknown; persistedText?: string },
  ): Promise<SessionSendResult> {
    assertCindyMakeSessionAvailable(await readSessionSource(session.id));
    const dispatchMergeTurn = prepareUpstreamMergeTurn(session.id);
    if (!session.remoteHostId && isCindyMakeWorktreePath(app.getPath('userData'), session.workDir)) {
      if (cindyMakeManager.isTaskPreparing(session.id))
        throwIpcError('PRECONDITION_FAILED', 'Cindy Make is still preparing this task');
      await assertCindyMakeTaskReady(session.id);
    }
    const dispatch = async (): Promise<SessionSendResult> => {
      let baselineStarted = false;
      let turnChangeSetStarted = false;
      const pendingHandoff = await agentHandoffPending.peek(session.id);
      const withHandoff: UserMessage = pendingHandoff
        ? (prependHandoffToUserMessage(
            { type: 'user', content: message },
            pendingHandoff,
          ) as UserMessage)
        : { type: 'user', content: message };
      // 来源说明是元信息,排在交接段之前(交接自带「以下是用户的新消息」结束标记);
      // 原生命令必须留在消息开头,同 send 事务的占位规则。
      const sourceNote = source && shouldPrependMobileClientPromptNote(message, session.agentKind)
        ? buildWireMessageSourceNote(
            { origin: source.origin, sourcePlugin: source.sourcePlugin },
            { visibleText: source.persistedText ?? message },
          )
        : null;
      const outgoingMessage: UserMessage = sourceNote
        ? (prependNoteToWireUserMessage(withHandoff as HandoffWireMessage, sourceNote) as UserMessage)
        : withHandoff;
      // Idle direct sends never carry internal coordination (that is force-queued).
      const releaseTurnSource = noteChannelTurnSource(session.id, channelTurnSourceFor(source?.origin, false));
      try {
        const sendResult = await session.send(outgoingMessage, {
          ...opts,
          onAccepted: async () => {
            await opts.onAccepted?.();
            await beginTurnChangeSetAtDispatch(session, anchorClientId);
            turnChangeSetStarted = true;
            if (gitSnapshotCoordinator) {
              await gitSnapshotCoordinator.onTurnStart(session.id);
              baselineStarted = true;
            }
          },
          onDispatching: () => {
            opts.onDispatching?.();
            // A real provider dispatch supersedes any deferred receipt from a
            // previous recovery attempt. Clear only at this irreversible
            // boundary; preparation can still be rejected before dispatch.
            deferredProductTurnFailureGate.clearSession(session.id);
            dispatchMergeTurn?.();
          },
        });
        if (turnChangeSetStarted && !sendResult.accepted) {
          clearPendingTurnChangeSets(session.id);
        }
        if (baselineStarted && !sendResult.accepted) {
          gitSnapshotCoordinator?.onTurnAbort(session.id);
        }
        if (pendingHandoff && sendResult.accepted) {
          agentHandoffPending.consume(session.id);
        }
        return sendResult;
      } catch (err) {
        if (turnChangeSetStarted) {
          clearPendingTurnChangeSets(session.id);
        }
        if (baselineStarted) {
          gitSnapshotCoordinator?.onTurnAbort(session.id);
        }
        throw err;
      } finally {
        releaseTurnSource();
      }
    };
    return session.remoteHostId
      ? dispatch()
      : withCindyMakeProjectUse(app.getPath('userData'), session.workDir, dispatch);
  }

  /**
   * 来源标签用的发送方身份快照：任务标题，以及该任务所属伙伴（有则标签显示伙伴名）。
   * 读失败只降级为无标题 / 按普通任务显示，不影响投递。
   */
  const readSenderIdentity = createSessionSenderIdentityReader(getDbClient);

  const {settleTodoDispatch}=createBotTodoDelivery({
    configureBotTodoDispatch,settleBotTodoForSession,readInputDeliveryReceipts,saveCancelledInputDelivery,
    getCurrentDbClientSnapshot,isAppSessionBoundaryPending,get inputCoordinator() { return inputCoordinator; },log,
    send:    async ({ sessionId, message, displayText, requestId, assertCurrent }) => {
      assertCurrent();
      const result = await sendToSessionInternal({
        targetSessionId: sessionId,
        message,
        persistedContent: displayText,
        clientId: requestId,
        onAccepted: assertCurrent,
        forceQueue: true,
        autoReviewUserText: { kind: 'delegated-continuation' },
      });
      if (result.ok && result.wakeKind === 'queued')
        await awaitAgentInputQueueSnapshotPersistence(sessionId);
      assertCurrent();
      return {
        ok: result.ok,
        queued: result.ok && result.wakeKind === 'queued',
        ...(!result.ok ? { error: result.message } : {}),
      };
    }
  });

  async function sendToSessionInternal(params: {
    taskActionDeliveryGuard?: TaskActionDeliveryGuard;
    botTaskCoordination?: BotTaskCoordination;
    targetSessionId?: string;
    message: string;
    persistedContent?: string;
    /** Host-managed images; attachment callers always use the durable queue. */
    files?: AgentInputQueuedMessage['files'];
    clientId?: string;
    dispatcherSessionId?: string;
    title?: string;
    useWorktree?: boolean;
    /** create 分支可选:新 session 的工作目录覆盖(绝对路径,须已存在;jump 忽略)。#811 */
    workingDir?: string;
    /** create 分支可选:显式执行配置；未提供的字段继续继承 dispatcher。jump 忽略。 */
    execution?: SendToSessionExecutionOverrides;
    onAccepted?: () => void | Promise<void>;
    onAcceptedRollback?: () => void | Promise<void>;
    onAcceptedCommit?: () => void | Promise<void>;
    origin?: AgentInputQueuedMessage['origin'];
    /** Host-only receipt: plugin-authored input is not user-authored permission. */
    autoReviewUserText?: AgentRequestReceipt;
    authorizationGuard?: BotAuthorizationInputGuard;
    createDefaults?: SendToSessionCreateDefaults;
    /** 安全调用方可要求新会话不比来源会话拥有更高的权限。 */
    inheritSourcePermissionMode?: boolean;
    /** Host-owned durable inputs use the coordinator even when idle. */
    forceQueue?: boolean;
    /** Explicit target delivery preserves the recipient's current plan mode. */
    inheritTargetPlanMode?: boolean;
    /** 插件任务派发的来源(只用于标签与 `[消息来源]`,不是权限判据,也不是 origin)。 */
    sourcePlugin?: AgentInputQueuedMessage['sourcePlugin'];
    /**
     * Host 持有的恢复策略:目标会话不在运行、需要 lazy-resume 时,按会话落库的权限档
     * 启动,而不是 main 侧通路的缺省 bypass。插件任务的档位来自用户的任务设置,只能由
     * 宿主的插件派发入口显式要求,不从来源字段推断(#5788)。
     * forceQueue 会在这条 lazy-resume 之前入队返回;排队项真正启动前由
     * reconcileCreateOptsAgainstDb 再读当前落库档位,不使用入队时的旧快照。
     */
    resumeWithStoredPermissionMode?: boolean;
  }): Promise<SendToSessionInternalResult> {
    await assertTaskActionCurrent();
    if (hasTaskActionAuthorization()) params = { ...params, forceQueue: true };
    const {
      targetSessionId,
      message,
      persistedContent,
      clientId: explicitClientId,
      dispatcherSessionId,
      title,
      useWorktree,
      workingDir: workingDirOverride,
      execution: executionOverrides,
      onAccepted,
      onAcceptedRollback,
      onAcceptedCommit,
      origin,
      createDefaults,
      inheritSourcePermissionMode,
    } = params;
    const queuedOrigin = sessionQueueOriginForDispatcher({
      dispatcherSessionId,
      ...(await readSenderIdentity(origin ? undefined : dispatcherSessionId)),
      message,
      explicitOrigin: origin,
    });
    const inputAgentMeta: AgentMeta | undefined = queuedOrigin || params.sourcePlugin || params.autoReviewUserText !== undefined
      ? {
          ...(queuedOrigin ? { origin: queuedOrigin } : {}),
          // 插件来源只用于标签(主机在插件派发入口盖章,名字已清洗)。
          ...(params.sourcePlugin ? { sourcePlugin: params.sourcePlugin } : {}),
          ...(params.autoReviewUserText !== undefined
            ? { autoReviewUserText: params.autoReviewUserText, delivery: 'turn' as const }
            : {}),
        } as AgentMeta
      : undefined;
    if (!message) {
      return { ok: false, errorCode: 'INVALID_ARGS', message: 'message required' };
    }
    const sourcePlugin = params.sourcePlugin;
    // 空闲直发的 wire 来源说明与落库标签读同一份数据。
    const directSource = {
      origin: queuedOrigin,
      sourcePlugin,
      persistedText: extractPlainText(persistedContent ?? message),
    };

    if (targetSessionId) {
      try {
        await assertReviewExternalInputAllowed(targetSessionId);
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'UNSUPPORTED_CAPABILITY') throw error;
        return {
          ok: false,
          errorCode: 'UNSUPPORTED_CAPABILITY',
          message: error instanceof Error ? error.message : String(error),
        };
      }
      await reconcileBotModelRoute(targetSessionId);
      const compactedRuntime = maker.getSession(targetSessionId);
      if (compactedRuntime) await refreshBotCapabilityEpochBeforeSend(compactedRuntime);
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
      // 来源任务的 Agent 在另一台电脑运行：新任务继承同一台电脑(它的模型与来源都在那台)。
      let inheritedAgentDeviceId: string | undefined;
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
          const [row] = await db
            .select()
            .from(sessions)
            .where(eq(sessions.id, dispatcherSessionId))
            .limit(1);
          if (meta.agentDeviceId && !meta.remoteHostId) inheritedAgentDeviceId = meta.agentDeviceId;
          const inheritedBase: SendToSessionCreateDefaults = {
            agentKind: meta.agentKind,
            workingDir: resolvedWorkDir,
            // 覆盖目录必有真实项目目录 → 归 project 工作区(标题/侧栏分组按项目
            // 语义走);未覆盖时保持缺省继承,行为不变。
            ...(workingDirOverride !== undefined ? { workspaceKind: 'project' as const } : {}),
            model: meta.model,
            effort: (row?.effort ?? undefined) as SendToSessionCreateDefaults['effort'],
            fastMode: (row?.fastMode ?? false),
            providerId: row?.providerId,
            // working_dir 覆盖时强制继承来源会话的权限档(review 反馈):把新目录
            // 以 Full access 打开是相对 dispatcher 的权限升级,跨项目 handoff
            // 不应隐式发生;未覆盖时保持既有缺省(bypassPermissions)不变。
            permissionMode:
              inheritSourcePermissionMode || workingDirOverride !== undefined
                ? permissionModeOrAsk(row?.permissionMode)
                : 'bypassPermissions',
          };
          const hasExecutionOverrides =
            executionOverrides !== undefined &&
            (executionOverrides.agentKind !== undefined ||
              executionOverrides.model !== undefined ||
              executionOverrides.effort !== undefined ||
              executionOverrides.fastMode !== undefined);
          if (hasExecutionOverrides) {
            const targetAgent = executionOverrides.agentKind ?? inheritedBase.agentKind;
            const deviceRouting = inheritedAgentDeviceId
              ? deviceWorkerRoutingContext(
                  await readDeviceProviderViews(remoteBackgroundInvoke, inheritedAgentDeviceId),
                  targetAgent,
                )
              : null;
            const resolvedExecution = resolveSendToSessionExecutionConfig({
              source: {
                agentKind: inheritedBase.agentKind,
                model: inheritedBase.model,
                effort: inheritedBase.effort,
                fastMode: (inheritedBase.fastMode ?? false),
                providerId: inheritedBase.providerId,
              },
              overrides: executionOverrides,
              availableModels: deviceRouting?.remoteCodexModels ?? maker.getCapabilities(targetAgent).availableModels,
              providerRouting: deviceRouting ?? await getProviderRoutingContext(),
              hasCindyAiApiKey: inheritedAgentDeviceId ? true : readClaudeApiKey() != null,
            });
            if (!resolvedExecution.ok) {
              return {
                ok: false,
                errorCode: resolvedExecution.errorCode,
                message: resolvedExecution.message,
              };
            }
            inherited = { ...inheritedBase, ...resolvedExecution.config };
          } else {
            inherited = inheritedBase;
          }
          // 所有可能提前失败的 workingDir / 执行配置校验完成后才创建 worktree，
          // 避免非法 agent/model/effort/Fast 组合留下无主目录与 store 绑定。
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
          fastMode: (inherited.fastMode ?? false),
          providerId: inherited.providerId,
          title: newTitle,
          permissionMode: inherited.permissionMode ?? 'bypassPermissions',
          ...(inheritedAgentDeviceId ? { agentDeviceId: inheritedAgentDeviceId } : {}),
        });
        await assertTaskActionCurrent();
        const { row: openedRow, value: { session } } = await openSession({
          id: createOpts.id, body: { title: newTitle,
            agentKind: inherited.agentKind === 'claude-code' ? 'cc' : inherited.agentKind,
            model: inherited.model, providerId: inherited.providerId, effort: inherited.effort,
            fastMode: (inherited.fastMode ?? false), permissionMode: createOpts.permissionMode,
            workspaceKind: inherited.workspaceKind, workingDir: createOpts.workingDir,
            ...(inheritedAgentDeviceId ? { agentDeviceId: inheritedAgentDeviceId } : {}) },
        }, async (row, assertCurrent) => {
          const created = await bootstrapSession({ ...createOpts, id: row.id, model: row.model,
            providerId: row.providerId, effort: (row.effort || undefined) as CreateOpts['effort'],
            fastMode: row.fastMode, workingDir: row.workingDir ?? createOpts.workingDir }, assertCurrent);
          // A later owner check must not reclaim a worktree whose Session already exists.
          createdPreviewSessionId = created.session.id;
          return created;
        });
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
        const sendResult = await sendUserMessageWithAwaitedGitBaseline(session, message, clientId, {
          planMode: false,
          beforeProviderStart: assertTaskActionCurrent,
          onAccepted: async () => {
            await assertTaskActionCurrent();
            notifyAgentIslandUserPrompt(session, persistedContent ?? message, {
              source: 'send_to_session:create:onPersisting',
              clientId,
            });
            createdPreviewStarted = true;
            await createDbMessage(session.id, {
              clientId,
              role: 'user',
              content: persistedContent ?? message,
              ...(inputAgentMeta ? { agentMeta: inputAgentMeta } : {}),
            });
            // F4: send_to_session 的 create 分支也建了一条用户可见新会话(有 title + 落了 user
            // 消息),同属"新建会话需同步所有窗侧栏"的 purpose。广播跟 user row 持久化
            // 保持同一个 accepted 边界,避免后续 handle.send 失败时侧栏漏刷新。
            // (jump/resume 分支是既有 session 重建,不在此发,见 wakeKind:'resumed' 分支。)
            broadcastSessionCreated(session.id);
          },
          onDispatching: () => dispatchAgentIslandUserPrompt(session.id),
        }, directSource);
        if (createdPreviewStarted) {
          if (sendResult.accepted) {
            commitAgentIslandUserPrompt(session.id, clientId);
          } else {
            rollbackAgentIslandUserPrompt(
              session.id,
              clientId,
              'send_to_session:create:not-dispatched',
            );
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
          model: openedRow.model,
          effort: openedRow.effort || null,
          fastMode: openedRow.fastMode,
          providerId: openedRow.providerId ?? null,
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
          return { ok: false, errorCode: 'BUSY', message: 'new session has a turn in progress' };
        }
        return {
          ok: false,
          errorCode: 'AGENT_NOT_READY',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }

    assertSessionNotRestarting(targetSessionId);
    const prev = sendToSessionLocks.get(targetSessionId);
    const waitPrev = waitForSendToSessionLock(targetSessionId, prev);
    // lockStage 只为 sendToSessionLock 的泄漏告警服务:标出临界区内当前挂在哪个
    // await 上,日志即可直接定位挂点(PR #2829 QA:回执 deliver 挂死 64 分钟零线索)。
    let lockStage = 'resolve-session-meta+row';
    const run = waitPrev.then(async () => {
      await assertTaskActionCurrent();
      await reconcileBotModelRoute(targetSessionId, true);
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
      // Internal sends (plugins, tasks, routines) reach idle sessions without sendToAgentAccepted.
      const [companionLink] = await getDbClient().drizzle
        .select({ role: botSessionLinks.role, botId: botSessionLinks.botId })
        .from(botSessionLinks).where(eq(botSessionLinks.sessionId, targetSessionId)).limit(1);
      if (isShadowedCompanionCanonical(companionLink, isCompanionShadowed)) {
        return { ok: false as const, errorCode: 'AGENT_NOT_READY' as const, message: SHADOWED_COMPANION_INPUT_MESSAGE };
      }

      // 崩溃恢复:在路由决策前加载快照,确保恢复的排队 prompt 不被跳过。
      // 失败时 shouldQueueNewTurn 仍返回 true(未恢复即入队),消息不丢。
      lockStage = 'queue-restore';
      await inputCoordinator.ensureQueueRestored(targetSessionId).catch(() => undefined);
      // Private messages and authorization continuations use the durable coordinator, including an idle
      // recipient. This preserves input provenance and one recovery/dispatch path.
      // Pending selections also need the canonical send transaction: it consumes the intent,
      // then refreshes queued createOpts from DB before starting the target harness.
      // enqueue does not await dispatch, so the drain can acquire this lock after we return.
      if (params.files?.length || params.forceQueue || explicitClientId?.startsWith('bot-dm:') || explicitClientId?.startsWith(BOT_GROUP_CLIENT_ID_PREFIX) || explicitClientId?.startsWith('bot-authorization-resume:') || inputCoordinator.shouldQueueNewTurn(targetSessionId) || agentSwitchPending.get(targetSessionId)) {
        lockStage = 'enqueue-queued-message';
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
          onAcceptedCommit,
          origin: queuedOrigin,
          sourcePlugin,
          autoReviewUserText: params.autoReviewUserText,
          botTaskCoordination: params.botTaskCoordination,
          authorizationGuard: params.authorizationGuard,
          files: params.files,
          inheritTargetPlanMode: params.inheritTargetPlanMode,
          taskActionDeliveryGuard: params.taskActionDeliveryGuard,
        });
        return {
          ok: true as const,
          targetSessionId,
          agentKind: meta.agentKind,
          wakeKind: 'queued' as const,
          queuedMessageId: qClientId,
          targetTitle: dbRow.title,
          targetLastUserSendAt:
            dbRow.userSendAt !== null ? new Date(dbRow.userSendAt).toISOString() : null,
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
          ...(inputAgentMeta ? { agentMeta: inputAgentMeta } : {}),
        });
        await runAcceptedCallback(onAccepted, targetSessionId, clientId);
      };

      lockStage = 'prepare-unhealthy-session';
      await contextOverflowRolloverHolder?.prepareUnhealthySession(targetSessionId);
      let live = maker.getSession(targetSessionId);
      if (live?.agentKind === 'pi' && live.getStatus() === 'error') {
        // A failed Pi close deliberately remains in Maker.activeSessions so the
        // next create can retry teardown without spawning a second process.
        // Never send through that unusable handle: fall through to lazy resume,
        // whose Maker.createSession call performs the existing bounded close retry.
        live = undefined;
      }
      if (live) {
        if (live.isTurnRunning?.()) {
          lockStage = 'enqueue-queued-message';
          await enqueueSendToSessionMessage({
            targetSessionId,
            message,
            persistedContent: persistedContent ?? message,
            clientId,
            meta,
            dbRow,
            onAccepted,
            onAcceptedRollback,
            onAcceptedCommit,
            origin: queuedOrigin,
            sourcePlugin,
            autoReviewUserText: params.autoReviewUserText,
            botTaskCoordination: params.botTaskCoordination,
          });
          return {
            ok: true as const,
            targetSessionId,
            agentKind: meta.agentKind,
            wakeKind: 'queued' as const,
            queuedMessageId: clientId,
            targetTitle: dbRow.title,
            targetLastUserSendAt:
              dbRow.userSendAt !== null ? new Date(dbRow.userSendAt).toISOString() : null,
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
          lockStage = 'remote-drift-ensure';
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
            const driftCleared = !hasPendingRemoteMcpDrift(
              live.remoteHostId,
              codexRemoteDriftOpts(),
            );
            if (driftCleared) {
              try {
                await live.detach();
              } catch (err) {
                log.warn(
                  'sendToSession: detach after drift rebootstrap failed, falling through to lazy-resume',
                  { targetSessionId, err: err instanceof Error ? err.message : String(err) },
                );
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
          lockStage = 'remote-cc-detach';
          try {
            await live.detach();
          } catch (err) {
            log.warn(
              'sendToSession: detach stale remote CC session failed, falling through to lazy-resume',
              { targetSessionId, err: err instanceof Error ? err.message : String(err) },
            );
          }
          // detach 后不得继续 live 直发 (session 已 closed) — 置空落入
          // 下方 lazy-resume (bootstrap 重建 → factory forceFresh)。
          live = undefined;
        }
      }
      if (live) {
        lockStage = 'live-send';
        try {
          const sendResult = await sendUserMessageWithAwaitedGitBaseline(live, message, clientId, {
            ...(params.autoReviewUserText ? {
              [AUTO_REVIEW_SOURCE_CONTENT]: '',
              ...(params.autoReviewUserText.kind === 'delegated-continuation' ? {
                [AUTO_REVIEW_USER_INTENT]: restoreAutoReviewUserIntent(await readAutoReviewHistory(targetSessionId)),
                [AUTO_REVIEW_DELEGATED_CONTINUATION]: true as const,
              } : { [AUTO_REVIEW_USER_INTENT]: verifiedOwnerRequestText(params.autoReviewUserText) ?? '' }),
            } : {}),
            planMode: false,
            onAccepted: persistUserMessage,
            onDispatching: () => dispatchAgentIslandUserPrompt(targetSessionId),
          }, directSource);
          if (userPromptPreviewStarted) {
            if (sendResult.accepted) {
              commitAgentIslandUserPrompt(targetSessionId, clientId);
            } else {
              rollbackAgentIslandUserPrompt(
                targetSessionId,
                clientId,
                'send_to_session:live:not-dispatched',
              );
            }
          }
          assertDesktopSendDispatched(sendResult, 'send_to_session live');
          return {
            ok: true as const,
            targetSessionId,
            agentKind: meta.agentKind,
            wakeKind: 'already-active' as const,
            targetTitle: dbRow.title,
            targetLastUserSendAt:
              dbRow.userSendAt !== null ? new Date(dbRow.userSendAt).toISOString() : null,
          };
        } catch (err) {
          if (isSessionRunningError(err)) {
            if (userPromptPreviewStarted) {
              rollbackAgentIslandUserPrompt(
                targetSessionId,
                clientId,
                'send_to_session:live:queued-before-dispatch',
              );
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
              onAcceptedCommit,
              origin: queuedOrigin,
              sourcePlugin,
              autoReviewUserText: params.autoReviewUserText,
              botTaskCoordination: params.botTaskCoordination,
            });
            return {
              ok: true as const,
              targetSessionId,
              agentKind: meta.agentKind,
              wakeKind: 'queued' as const,
              queuedMessageId: clientId,
              targetTitle: dbRow.title,
              targetLastUserSendAt:
                dbRow.userSendAt !== null ? new Date(dbRow.userSendAt).toISOString() : null,
            };
          }
          if (userPromptPreviewStarted) {
            rollbackAgentIslandUserPrompt(
              targetSessionId,
              clientId,
              'send_to_session:live:failed-before-dispatch',
            );
          }
          return {
            ok: false as const,
            errorCode: 'INTERNAL' as const,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      lockStage = 'lazy-resume-bootstrap';
      try {
        const createOpts = buildCreateOptsWithStderr({
          id: targetSessionId,
          agentKind: meta.agentKind,
          workingDir: meta.workDir,
          model: meta.model,
          resumeSessionId: meta.sdkSessionId,
          // 插件任务的档位由用户在任务设置里给定(errand 还会再收窄),不能借 lazy-resume
          // 的缺省 bypass 提权;档位不一致还会让 errand 复用判定每轮都失败、另开新会话
          // (#5788)。由宿主的插件派发、伙伴后台任务派发等入口显式要求,未要求的 main 侧
          // 通路(Orca 派活等)保持既有缺省。
          permissionMode: params.resumeWithStoredPermissionMode
            ? permissionModeOrAsk(dbRow.permissionMode)
            : 'bypassPermissions',
          // 计划模式同理按落库状态起档,运行态才与库内一致(心跳等权限边界读取方要求两者
          // 相同)。下方 send 带 planMode:false,本轮仍是普通执行、不消耗武装态。
          ...(params.resumeWithStoredPermissionMode
            ? { planMode: dbRow.planModeEnabled === true }
            : {}),
          // 发起方回合结束后进程常被释放。漏掉 providerId = 回落到隐式默认路由,
          // 订阅 / 自定义来源的伙伴会以 AGENT_NOT_READY 起不来,委派结果停在外发
          // 队列里,表现就是「对方做完了,发起方没被叫醒」。
          ...(dbRow.providerId ? { providerId: dbRow.providerId } : {}),
        });
        await synthesizeOrcaVendorOptionsFromDb(targetSessionId, createOpts);
        if (createOpts.extraDirs === undefined) {
          try {
            const row = await readSessionExtraDirsFromDb(targetSessionId);
            if (row.length > 0) Object.assign(createOpts, directoryGrantsForRuntime(row));
          } catch (err) {
            log.warn('sendToSession: read extra_dirs from DB failed (non-fatal)', {
              targetSessionId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (createOpts.writableDirs === undefined) {
          const row = await readSessionWritableDirsFromDb(targetSessionId).catch(() => []);
          if (row.length > 0) createOpts.writableDirs = row;
        }
        // lazy-resume 也要走 remote ensure:Orca 派活 / scheduler 等 main 侧
        // 通路不带 remoteHostId 快照, ensure 内部会从 sessions 行兜底回填并
        // 完成 SSH 重连 / agent 安装 / codex daemon MCP 注入。
        await ensureRemoteReadyForSessionStart({ createOpts });
        const { session } = await bootstrapSession(createOpts);
        await markOrcaRoleIfNeeded(session.id, createOpts.orcaRole);
        const sendResult = await sendUserMessageWithAwaitedGitBaseline(session, message, clientId, {
          ...(params.autoReviewUserText ? {
            [AUTO_REVIEW_SOURCE_CONTENT]: '',
            ...(params.autoReviewUserText.kind === 'delegated-continuation' ? {
              [AUTO_REVIEW_USER_INTENT]: restoreAutoReviewUserIntent(await readAutoReviewHistory(targetSessionId)),
              [AUTO_REVIEW_DELEGATED_CONTINUATION]: true as const,
            } : { [AUTO_REVIEW_USER_INTENT]: verifiedOwnerRequestText(params.autoReviewUserText) ?? '' }),
          } : {}),
          planMode: false,
          onAccepted: persistUserMessage,
          onDispatching: () => dispatchAgentIslandUserPrompt(targetSessionId),
        }, directSource);
        if (userPromptPreviewStarted) {
          if (sendResult.accepted) {
            commitAgentIslandUserPrompt(targetSessionId, clientId);
          } else {
            rollbackAgentIslandUserPrompt(
              targetSessionId,
              clientId,
              'send_to_session:resumed:not-dispatched',
            );
          }
        }
        assertDesktopSendDispatched(sendResult, 'send_to_session resumed');
        return {
          ok: true as const,
          targetSessionId,
          agentKind: meta.agentKind,
          wakeKind: 'resumed' as const,
          targetTitle: dbRow.title,
          targetLastUserSendAt:
            dbRow.userSendAt !== null ? new Date(dbRow.userSendAt).toISOString() : null,
        };
      } catch (err) {
        if (isSessionRunningError(err)) {
          if (userPromptPreviewStarted) {
            rollbackAgentIslandUserPrompt(
              targetSessionId,
              clientId,
              'send_to_session:resumed:queued-before-dispatch',
            );
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
            onAcceptedCommit,
            origin: queuedOrigin,
            sourcePlugin,
            autoReviewUserText: params.autoReviewUserText,
            botTaskCoordination: params.botTaskCoordination,
          });
          return {
            ok: true as const,
            targetSessionId,
            agentKind: meta.agentKind,
            wakeKind: 'queued' as const,
            queuedMessageId: clientId,
            targetTitle: dbRow.title,
            targetLastUserSendAt:
              dbRow.userSendAt !== null ? new Date(dbRow.userSendAt).toISOString() : null,
          };
        }
        if (userPromptPreviewStarted) {
          rollbackAgentIslandUserPrompt(
            targetSessionId,
            clientId,
            'send_to_session:resumed:failed-before-dispatch',
          );
        }
        return {
          ok: false as const,
          errorCode: 'AGENT_NOT_READY' as const,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    });

    // 锁条目改由 trackSendToSessionLockRun 安装:run 挂死超过 5min 时条目强制 bail,
    // 后续 outbox 重试 / guardian dispatch / worker idle-close 不再被僵尸条目糊死;
    // 告警日志携带 lockStage 定位挂点。返回值仍是 run 本体,调用方观察到真实结果。
    return trackSendToSessionLockRun(targetSessionId, run, () => lockStage);
  }

  const welcomeDispatchReceipts = createQueuedDispatchReceipts();
  const dispatchBotSessionMessage = createBotSessionDispatcher({getDbClient,maker,getSessionRowSnapshot,getInputCoordinator:()=>inputCoordinator,createId,buildSessionControlInputItem:(params)=>buildSessionControlInputItem(params),readSenderIdentity,welcomeDispatchReceipts,sendToSessionInternal});

  setBotInvitationWelcomeDispatch(dispatchBotSessionMessage);
  setVoiceTaskDispatch(dispatchBotSessionMessage);
  setVoiceCallMemoryReader(async botId =>
    (await maker.makerMemory?.getStore(buildBotMemoryScopeKey(botId)))?.getIndex() ?? '');

  // 代输入 ended: hidden metadata-only continuation, mirroring the bot
  // authorization resume. A deterministic client id keeps delivery idempotent.
  inputHandoffContinuation = async (sessionId, requestId, message) => {
    await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
    const result = await dispatchBotSessionMessage({
      targetSessionId: sessionId,
      message,
      persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${message}`,
      clientId: `input-handoff-result:${requestId}`,
    });
    if (!result.ok) throw new Error(`Input handoff continuation not accepted: ${result.errorCode}`);
  };

  // 同账号另一台电脑上的任务发来的消息（Agent 的 send_to_session 传 deviceId::sessionId）。
  registerSessionHandoffIpc({
    send: (params) => sendToSessionInternal(params),
    validate: async (deviceId, input) => {
      const response = await invokeBotPeer(deviceId, 'maker:session:handoff', [{ action: 'validate-task-action', ...input }]);
      const result = response.ok ? response.result as { valid?: unknown; released?: unknown } | null : null;
      return result?.valid === true && (!input.release || result.released === true);
    },
  });

  initializeBotAuthorizationHost(async (card, validate, assertAuthorizationCurrent) => {
    await inputCoordinator.ensureQueueRestored(card.sessionId);
    const generation = inputCoordinator.getGeneration(card.sessionId);
    const authorizationGuard: BotAuthorizationInputGuard = {
      validate,
      assertCurrent: () => {
        assertAuthorizationCurrent();
        assertRemoteInputClearNotInFlight(card.sessionId, true);
        if (rewindInputSessions.has(card.sessionId) || !inputCoordinator.isGenerationCurrent(card.sessionId, generation)) {
          throw new Error('Authorization input boundary changed');
        }
      },
    };
    authorizationGuard.assertCurrent();
    const result = await dispatchBotSessionMessage({ ...buildBotAuthorizationContinuation(card), authorizationGuard });
    if (!result.ok) throw new Error('Authorization continuation not accepted');
    await awaitAgentInputQueueSnapshotPersistence(card.sessionId);
  }, (sessionId) => {
    const generation = inputCoordinator.getGeneration(sessionId);
    return () => {
      assertRemoteInputClearNotInFlight(sessionId, true);
      if (!inputCoordinator.isGenerationCurrent(sessionId, generation))
        throw new Error('Authorization request input boundary changed');
    };
  });

  botDirectMessageServiceHolder = createBotDirectMessageService({
    transport: createBotMessageTransport({ selfDeviceId: getSelfDeviceId,
      listDevices: () => handleListDevices(deviceDirectoryDeps()), invoke: invokeBotPeer }),
    discardQueuedDelivery: async (sessionId, clientId, assertOwner) => {
      await inputCoordinator.ensureQueueRestored(sessionId);
      assertOwner();
      inputCoordinator.remove(sessionId, clientId);
    },
    hasQueuedDelivery: async (sessionId, clientId) => {
      await inputCoordinator.ensureQueueRestored(sessionId);
      return inputCoordinator.hasKnownClientId(sessionId, clientId);
    },
    dispatch: ({
      autoReviewUserText,
      targetSessionId,
      dispatcherSessionId,
      message,
      persistedContent,
      clientId,
      onAccepted,
      onAcceptedRollback,
    }) =>
      dispatchBotSessionMessage({
        autoReviewUserText,
        targetSessionId,
        dispatcherSessionId,
        message,
        persistedContent,
        clientId,
        onAccepted: onAccepted
          ? async () => {
              try {
                await onAccepted();
              } catch (error) {
                throw new AcceptedCallbackDispatchCancelled(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
          : undefined,
        onAcceptedRollback,
      }),
    ensureCanonicalSession: async (botId, beforeRecovery) => {
      if (!botDelegationServiceHolder) {
        return { ok: false as const, errorCode: 'DELEGATION_UNAVAILABLE', message: '伙伴消息服务尚未就绪' };
      }
      return botDelegationServiceHolder.ensureCanonicalSession(botId, beforeRecovery);
    },
    captureOwnerScope: captureDataOwnerBroadcastScope,
    isOwnerScopeCurrent: (scope) =>
      isDataOwnerBroadcastScopeCurrent(
        scope as ReturnType<typeof captureDataOwnerBroadcastScope>,
      ),
    onChanged: (payload, scope) => {
      const ownerScope = scope as ReturnType<typeof captureDataOwnerBroadcastScope> | undefined;
      if (ownerScope && !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
      broadcastToAllWindows(MAKER_PUSH.BOT_DIRECT_MESSAGE_CHANGED, payload, ownerScope);
    },
  });
  setBotRemoteMessageService(botDirectMessageServiceHolder);
  botGroupChatServiceHolder?.dispose();
  // 分工 steps run in the group's folder, the 项目文件夹, or one worktree per plan (bot-group-chat.md §7.5).
  const botGroupAttachments = createBotGroupAttachmentStore({ ownerRoot: () => ownerScopedUserDataPath(), log });
  const botGroupWorkDir = createBotGroupWorkDir({
    ownerRoot: () => ownerScopedUserDataPath(),
    detectRepo: async (dir) => {
      const detected = await worktreeManager.detectCwd(dir);
      return { gitInstalled: detected.gitInstalled, isGitRepo: detected.isGitRepo };
    },
    prepareWorktree: async (projectDir) => {
      const prepared = await prepareHandoffWorktree({
        getForSession: worktreeManager.getForSession, listAll: worktreeManager.listAll,
        detectCwd: worktreeManager.detectCwd, suggestName: worktreeManager.suggestName,
        listBranches: worktreeManager.listBranches, resolveCommit: worktreeManager.revParseCommit,
        createWorktree: worktreeManager.createWorktree, createId: () => randomUUID(),
        resolveFreshSource: resolveFreshSourceBranch,
      }, undefined, projectDir);
      return prepared.ok
        ? { ok: true as const, sessionId: prepared.sessionId, workingDir: prepared.meta.path, branch: prepared.meta.branch }
        : prepared;
    },
    git: async (args, cwd) => (await gitExec(args, cwd, { timeoutMs: 10_000 })).stdout,
    trashItem: (fullPath) => shell.trashItem(fullPath),
  });
  // The companion "restart": durable handoff from DB history, no replay of any input.
  async function restartBotCanonicalRuntime(sessionId: string, assertOwnerCurrent: () => void): Promise<void> {
    const recovery = contextOverflowRolloverHolder;
    if (!recovery) throwIpcError('PRECONDITION_FAILED', 'Bot recovery is not ready');
    await restartBotRuntime(sessionId, assertOwnerCurrent, {
      stopInput: (id) => {
        // Save the visible partial reply before abort/close clears the stream buffers.
        flushAssistantBlock(id);
        flushOrphanToolResults(id, null);
        resetAutomaticRecoveryForExplicitStop(id);
        recovery.cancelRecovery(id);
        // Cancel sends/retries before waiting for their serialization lock.
        // Preserve queued user input, paused until the user explicitly resumes it.
        agentInputCoordinatorHolder?.stop(id, { keepQueue: true, pauseQueue: true, resumeOnUserInput: true });
      },
      withSessionLock: withSessionRestartLock,
      rebuild: async (id, assertCurrent, signal) => {
        await pauseGoalBeforeExplicitStop(id);
        assertCurrent();
        cleanupPendingInteractionsForSession(id, 'session_closed');
        await recovery.prepareNativeSessionRecovery(id, null, assertCurrent, signal);
      },
      onClosed: (id) => agentInputCoordinatorHolder?.onSessionClosed(id),
    });
  }
  // 「消息平台」页的隐藏任务「重新开始」: 主任务与 IM 专线共用伙伴这一条显式重启。
  configureBotImLaneRuntime({
    isTurnRunning: (sessionId) => !!maker.getSession(sessionId)?.isTurnRunning?.(),
    restartSession: async (sessionId) => {
      const scope = captureDataOwnerBroadcastScope();
      await restartBotCanonicalRuntime(sessionId, () => {
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new Error('OWNER_CHANGED');
      });
    },
  });
  // A turn is running or queued in a companion's main task: no context rebuild, no hand-over.
  const companionTurnActive = (sessionId: string) => !!maker.getSession(sessionId)?.isTurnRunning?.()
    || inputCoordinator.getQueueControlSnapshot(sessionId).pendingQueue.length > 0;
  const botGroupChatDeps: BotGroupChatServiceDeps = {
    ensureLane: async (input) => {
      try {
        return await ensureBotGroupLaneSession(input);
      } catch (error) {
        return { ok: false as const, errorCode: 'LANE_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) };
      }
    },
    dispatch: ({ targetSessionId, message, persistedContent, clientId, attachments, toolsDisabled, onQueued, onAccepted }) =>
      dispatchBotSessionMessage({
        targetSessionId,
        message,
        persistedContent,
        clientId,
        toolsDisabled,
        onQueued,
        // Same attachment shape as a task message: images by their media address, files by path.
        ...(attachments && attachments.length > 0
          ? {
            files: attachments.map((attachment) => ({
              id: attachment.id,
              name: attachment.name,
              originalName: attachment.name,
              path: attachment.path ?? attachment.url ?? '',
              ...(attachment.url ? { url: attachment.url } : {}),
              ext: path.extname(attachment.name).toLowerCase(),
              size: attachment.size,
              category: attachment.category,
              mimeType: attachment.mimeType,
              ...(attachment.annotated ? { annotated: true } : {}),
            })),
          }
          : {}),
        onAccepted,
      }),
    prepareAttachments: botGroupAttachments.prepare,
    abortLane: (sessionId) => stopSessionTurnExplicitly(sessionId),
    closeLanes: async (sessionIds) => {
      await Promise.all(sessionIds.map((id) => maker.closeSession(id).catch(() => undefined)));
    },
    syncLanePermission: async (laneSessionId, botId) => {
      const [canonical] = await getDbClient().drizzle
        .select({ mode: sessions.permissionMode })
        .from(botSessionLinks)
        .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
        .where(and(eq(botSessionLinks.botId, botId), eq(botSessionLinks.role, 'canonical'), isNull(botSessionLinks.archivedAt)))
        .limit(1);
      const mode = canonical?.mode;
      if (!mode || !isSessionPermissionMode(mode)) return;
      const live = maker.getSession(laneSessionId);
      if (live) {
        if (live.stablePermissionModeState?.mode !== mode) {
          await live.setPermissionMode(mode as 'ask' | 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions');
        }
        return;
      }
      if (!(await persistPermissionModeWithoutRuntime(laneSessionId, mode))) {
        throw new Error('Group lane permission could not be persisted');
      }
    },
    hasPendingInteraction: (sessionId) => hasPendingAgentInteractionForSession(sessionId),
    decidePlan: createBotGroupPlanDecider((prompt, opts) => requestUtilityText(maker, prompt, opts)),
    workDir: botGroupWorkDir,
    validateProjectDir: async (dir) => {
      try {
        const checked = await validateExistingLocalProjectDirectory(dir);
        return checked.ok
          ? { ok: true as const, dir: checked.workingDir }
          : { ok: false as const, message: '这个文件夹不能用作项目文件夹' };
      } catch {
        return { ok: false as const, message: '项目文件夹不存在' };
      }
    },
    captureOwnerScope: captureDataOwnerBroadcastScope,
    isOwnerScopeCurrent: (scope) =>
      isDataOwnerBroadcastScopeCurrent(scope as ReturnType<typeof captureDataOwnerBroadcastScope>),
    onChanged: (payload, scope) => {
      const ownerScope = scope as ReturnType<typeof captureDataOwnerBroadcastScope> | undefined;
      if (ownerScope && !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
      broadcastToAllWindows(MAKER_PUSH.BOT_GROUP_CHANGED, payload, ownerScope);
      if (payload.change === 'updated' || payload.change === 'deleted') notifyAgentIslandBotGroupChanged(payload.groupId);
      // Phones read groups as remote resources; any change re-reads the row and the chat.
      broadcastBotGroupRemoteResourceChanged(payload.groupId);
    },
    companionCloud: createCompanionCloudHost({
      log,
      ensureCanonicalSession: async (botId) => {
        if (!botDelegationServiceHolder) throw new Error('DELEGATION_UNAVAILABLE');
        const ensured = await botDelegationServiceHolder.ensureCanonicalSession(botId);
        if (!ensured.ok) throw new Error(ensured.errorCode);
        return ensured.sessionId;
      },
      // Cloud history was added: rebuild like a restart, but never interrupt a turn.
      rebuildContext: async (sessionId) => {
        if (companionTurnActive(sessionId)) return 'busy';
        const scope = captureDataOwnerBroadcastScope();
        await restartBotCanonicalRuntime(sessionId, () => {
          if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new Error('OWNER_CHANGED');
        });
        return 'rebuilt';
      },
      isTurnActive: companionTurnActive,
      // Moving a companion that is still working, when the user chose to stop it first.
      stopTurn: stopSessionTurnExplicitly,
      listDevices: listCompanionDevices,
      // Old clients answer CHANNEL_NOT_ALLOWED; unreachable ones time out. Neither may receive a companion.
      probeCompanionCloud: async (deviceId) => (await companionCloudPeerVersion(deviceId)) >= COMPANION_CLOUD_RECEIVE_VERSION,
      selfDeviceId: getSelfDeviceId,
      homeLink: {
        version: companionCloudPeerVersion,
        targets: async (deviceId) =>
          parseCompanionCloudRemoteTargets(await invokeDeviceValue(invokeBotPeer, deviceId, COMPANION_CLOUD_TARGETS_CHANNEL, [])),
        handOver: async (deviceId, botId, targetDeviceId, options) => {
          const result = parseCompanionCloudRemoteActionResult(await invokeDeviceValue(invokeBotPeer, deviceId,
            COMPANION_CLOUD_HAND_OVER_CHANNEL, options?.whenBusy ? [botId, targetDeviceId, { whenBusy: options.whenBusy }] : [botId, targetDeviceId]));
          return result.ok ? result : { ...result, code: companionFailureCode(result.code) };
        },
        merge: async (deviceId, keepBotId, fromBotIds) =>
          companionMergeResult(await invokeDeviceValue(invokeBotPeer, deviceId, COMPANION_CLOUD_MERGE_CHANNEL, [keepBotId, fromBotIds])),
        flush: async (deviceId, botId) => {
          const result = parseCompanionCloudRemoteActionResult(await invokeDeviceValue(invokeBotPeer, deviceId, COMPANION_CLOUD_FLUSH_CHANNEL, [botId]));
          return result.ok ? result : { ...result, code: companionFailureCode(result.code) };
        },
      },
      // A message the owner wrote in the companion's room reaches its main task like any user input.
      deliverToCanonical: async (botId, text, clientId) => {
        // A room message drives the companion's main task like a same-account device: only where this
        // computer allows same-account device control (the room carries no authenticated device).
        if (!readDeviceLinkSettings().remoteControlEnabled) return { ok: false as const, errorCode: 'REMOTE_CONTROL_DISABLED' };
        if (!botDelegationServiceHolder) return { ok: false as const, errorCode: 'DELEGATION_UNAVAILABLE' };
        const ensured = await botDelegationServiceHolder.ensureCanonicalSession(botId);
        if (!ensured.ok) return { ok: false as const, errorCode: ensured.errorCode };
        // Content from the cloud room must not wake the task with more permission than the user chose.
        const result = await dispatchBotSessionMessage({ targetSessionId: ensured.sessionId, message: text, clientId,
          resumeWithStoredPermissionMode: true });
        return result.ok ? { ok: true as const } : { ok: false as const, errorCode: result.errorCode };
      },
    }),
    onStepSettled: createBotGroupStepNotification({
      isDataOwnerBroadcastScopeCurrent,getMobileNotifyGeneration,botGroupMembersVisibleRemotely,
      sendMobileBotGroupNotify,getBotGroupStepNotificationBody,log,
    }),
    log,
  };
  botGroupChatServiceHolder = withChatServer(createBotGroupChatService(botGroupChatDeps), botGroupChatDeps);
  unsubscribeCompanionCloudBroadcast?.();
  unsubscribeCompanionCloudBroadcast = companionHomes.onChange((snapshot) => {
    const scope = captureDataOwnerBroadcastScope();
    void companionCloudView(snapshot, listCompanionDevices).then((view) => {
      // Device lookups can finish out of order: a superseded snapshot is never pushed after a newer one.
      if (companionHomes.snapshot() !== snapshot) return;
      broadcastToAllWindows(MAKER_PUSH.COMPANION_CLOUD_CHANGED, view, scope);
    });
  });
  // Phones reach groups through the Remote Resource protocol (bot-group-chat.md §8).
  registerBotGroupRemoteResourceProvider(() => botGroupChatServiceHolder);
  botDelegationServiceHolder?.dispose();
  botDelegationServiceHolder = createBotDelegationService({
    captureRequest: captureSessionAgentRequest,
    readSessionExecution: id => {
      const session = maker.getSession(id);
      return session ? { instanceId: session.instanceId, generation: session.getTurnGeneration() } : null;
    },
    // Native close cannot be cancelled by the ordinary send-lock watchdog.
    withSessionLock: withSessionRestartLock,
    taskControl: {
      steer: (params) => sessionControlService.steerSession(params),
      stop: (params) => sessionControlService.stopSessionTurn(params),
      isActive: (id) => {
        const session = maker.getSession(id);
        return !!session && (session.isTurnRunning() || session.getTurnControlSnapshot().pendingInteractionCount > 0);
      },
      holdInput: (id, held) => {
        inputCoordinator.setExecutionPaused(id, held);
        return setPendingInteractionTimeoutsPaused(id, held);
      },
      // Wait for sends already admitted before the hold before sampling native activity.
      waitForInputBoundary: (id) => withSendToSessionLock(id, async () => undefined),
      preparePause: async (id) => {
        resetAutomaticRecoveryForExplicitStop(id);
        contextOverflowRolloverHolder?.cancelRecovery(id);
        await pauseGoalBeforeExplicitStop(id);
      },
      restoreInput: (id) => inputCoordinator.ensureQueueRestored(id),
      flushInput: awaitAgentInputQueueSnapshotPersistence,
      resumeInput: async (id) => { inputCoordinator.resume(id); },
    },
    getWorktree: worktreeManager.getForSession,
    reconcileWorktree: worktreeManager.reconcileSessionTransfer,
    withTransferredWorktree: worktreeManager.withTransferredSession,
    discardUnusedWorktree: async sessionId => {
      const [row] = await getDbClient().drizzle.select({ id: sessions.id }).from(sessions)
        .where(eq(sessions.id, sessionId)).limit(1);
      if (!row) await worktreeManager.removeWorktreeForSession(sessionId);
    },
    prepareWorktree: async workingDir => {
      const prepared = await prepareHandoffWorktree({
        getForSession: worktreeManager.getForSession, listAll: worktreeManager.listAll,
        detectCwd: worktreeManager.detectCwd, suggestName: worktreeManager.suggestName,
        listBranches: worktreeManager.listBranches, resolveCommit: worktreeManager.revParseCommit,
        createWorktree: worktreeManager.createWorktree, createId: () => randomUUID(),
        resolveFreshSource: resolveFreshSourceBranch,
      }, undefined, workingDir);
      return prepared.ok ? { ok: true, sessionId: prepared.sessionId, workingDir: prepared.meta.path } : prepared;
    },
    taskQueue: {
      inspect: async (id, callerSessionId) => {
        await inputCoordinator.ensureQueueRestored(id);
        if (!inputCoordinator.isQueueRestored(id)) throw new Error('Task queue restoration is incomplete');
        return inputCoordinator.getQueueInspection(id)
          .filter(item => item.source === 'session' && item.sourceLabel === callerSessionId)
          .map(item => ({ queuedMessageId: item.queuedMessageId, consuming: item.consuming, message: item.content }));
      },
      update: params => sessionControlService.updateQueuedMessage(params),
      cancel: params => sessionControlService.cancelQueuedMessage(params),
    },
    readCallerPermission: (sessionId) => {
      const state = maker.getSession(sessionId)?.stablePermissionModeState;
      return state?.mode ? { mode: state.mode, generation: state.generation } : null;
    },
    readCallerRuntime: (sessionId) => {
      const session = maker.getSession(sessionId);
      return session ? {
        agentKind: makerToDbAgentKind(session.agentKind),
        agentDeviceId: session.agentDeviceId ?? null,
        model: session.model,
        providerId: getSessionProvider(sessionId) ?? null,
        effort: (getSessionEffort(sessionId) ?? undefined) as CreateOpts['effort'],
        fastMode: getSessionFastMode(sessionId),
      } : null;
    },
    taskRoute: createBotSessionTaskRouteBridge({
      getSessionRuntime: params => sessionControlService.getSessionRuntime(params),
      setSessionRuntime: params => sessionControlService.setSessionRuntime(params),
      readConfiguredCandidate: (callerSessionId, current, childSessionId) =>
        readBotFallbackCandidate(callerSessionId, current, childSessionId),
    }),
    dispatch: ({ targetSessionId, message, persistedContent, clientId, onAccepted, dispatcherSessionId, autoReviewUserText }) =>
      dispatchBotSessionMessage({
        autoReviewUserText,
        targetSessionId,
        message,
        persistedContent,
        clientId,
        onAccepted: onAccepted ? async (replayed) => {
          try {
            await onAccepted(replayed);
          } catch (error) {
            if (error instanceof GroupToolAuthorizationError || error instanceof TaskActionAuthorizationError) {
              throw new AcceptedCallbackDispatchCancelled(error.message);
            }
            throw error;
          }
        } : undefined,
        dispatcherSessionId,
        // 后台任务按发起时落库的权限档运行；冷启动不能退回 bypass。否则任务实际以
        // Full access 运行，库里却是 Auto / Ask，绑定它的心跳每轮都因档位不一致被顺延。
        resumeWithStoredPermissionMode: true,
      }),
    discardDelegationQueuedInputs: (sessionId, delegationId) =>
      discardDelegationQueuedInputs(inputCoordinator, sessionId, delegationId, awaitAgentInputQueueSnapshotPersistence),
    abortSession: (sessionId) => stopSessionTurnExplicitly(sessionId),
    closeSession: (sessionId) => maker.closeSession(sessionId),
    broadcastSessionCreated,
    onChanged: (payload) => {
      broadcastToAllWindows(MAKER_PUSH.BOT_DELEGATION_CHANGED, payload);
    },
    resolveInteraction: resolvePendingInteraction,
    hasPendingInput: (sessionId) =>
      inputCoordinator.getQueueControlSnapshot(sessionId).pendingQueue.length > 0,
    readPendingInputClientIds: (sessionId) =>
      inputCoordinator.getQueueControlSnapshot(sessionId).pendingQueue.flatMap(item => [item.clientId, ...(item.supersedesUserClientId ? [item.supersedesUserClientId] : []), ...(item.retrySourceClientId ? [item.retrySourceClientId] : [])]),
    collectArtifacts: async (sessionId, inputClientIds) => {
      await waitForTurnChangeSetSeal(sessionId);
      const acceptedInputs = new Set(inputClientIds);
      const changeSets = (await listTurnChangeSets(sessionId)).filter(changeSet => acceptedInputs.has(changeSet.anchorClientId));
      const byPath = new Map<string, {
        path: string;
        absolutePath: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed';
      }>();
      for (const changeSet of changeSets) {
        for (const file of changeSet.files) {
          const status = file.status === 'added' || file.status === 'untracked' || file.status === 'copied'
            ? 'added'
            : file.status === 'deleted'
              ? 'deleted'
              : file.status === 'renamed'
                ? 'renamed'
                : 'modified';
          byPath.set(file.path, {
            path: file.path,
            absolutePath: path.resolve(changeSet.cwd, file.path),
            status,
          });
        }
      }
      return [...byPath.values()];
    },
    // A task started from a group posts its card, confirmations and result there as its teammate.
    postGroupTaskMessage: async (input) => botGroupChatServiceHolder
      ? botGroupChatServiceHolder.postCompanionTaskMessage(input)
      : { ok: false as const, errorCode: 'GROUP_CHANNEL_UNAVAILABLE', retryable: true },
    groupHasTaskChannel: async (groupId) => botGroupChatServiceHolder
      ? botGroupChatServiceHolder.hasCompanionTaskChannel(groupId) : true,
  });
  registerBotLifecycleHandlers({
    maker,
    restartRuntime: restartBotCanonicalRuntime,
    getDelegationService: () => botDelegationServiceHolder,
    onPaused: (botId) => updateBotRoutineLifecycle(botId, 'pause'),
    onResumed: async (botId) => {
      // Task results that finished while the teammate was paused were held, not retried.
      // Start their delivery first and independently: a routine-engine failure below must
      // not strand them until the next launch. The service retries its own failures.
      void botDelegationServiceHolder?.resumeCompletionDelivery(botId);
      await updateBotRoutineLifecycle(botId, 'resume');
    },
    onBeforeDelete: async (botId) => {
      // 伙伴自有的 IM 机器人连接先停掉并清凭证: 伙伴没了, 它的 bot 不能继续收消息。
      await removeBotImConnectionsForBot(botId);
      await prepareCompanionImportDeletion(botId);
    },
    onDeleted: async (botId, assertOwner) => {
      assertOwner();
      // Deleted on its home: other devices stop showing it. Started first and independently, so a
      // local cleanup failure below never skips it; it records retirePending and retries itself.
      // A demoted copy never retires the cloud companion.
      settleCompanionOwner();
      void activeCompanionCloud()?.retire(botId).catch((error: unknown) => {
        log.warn('companion cloud retire failed', { error: error instanceof Error ? error.message.slice(0, 80) : 'UNKNOWN' });
      });
      // Profile deletion has committed. Startup also purges orphaned routines
      // if this cleanup fails or the process stops before it finishes.
      await updateBotRoutineLifecycle(botId, 'delete');
      assertOwner();
      await finishCompanionEnvironmentRemoval(ownerScopedUserDataPath(), botId, assertOwner);
    },
  });
  const delegationForRestore = botDelegationServiceHolder;
  void restoreBotRuntimeForCurrentOwner();

  registerBotDelegationHandlers({ipcMain,isDeviceLinkInvoke,assertTrustedAppRendererEvent,service:delegationForRestore});
  registerBotDirectMessageHandlers({ipcMain,isDeviceLinkInvoke,assertTrustedAppRendererEvent,getService:()=>botDirectMessageServiceHolder});
  registerBotGroupHandlers({ipcMain,assertTrustedAppRendererEvent,getService:()=>botGroupChatServiceHolder});
  const currentCompanionHomes = () => { settleCompanionOwner(); return companionHomes; };
  ipcMain.handle(MAKER_INVOKE.COMPANION_CLOUD_STATE, async (event) => {
    assertTrustedAppRendererEvent(event);
    return companionCloudView(currentCompanionHomes().snapshot(), listCompanionDevices);
  });
  const companionBotId = (value: unknown) => {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) throwIpcError('INVALID_PARAMS', 'botId required');
    return value;
  };
  const companionNotEnabled: CompanionCloudActionResult = { ok: false, code: 'NOT_ENABLED' };
  ipcMain.handle(MAKER_INVOKE.COMPANION_CLOUD_TAKE_OVER, async (event, botId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = companionBotId(botId);
    currentCompanionHomes();
    return activeCompanionCloud()?.takeOver(id) ?? companionNotEnabled;
  });
  ipcMain.handle(MAKER_INVOKE.COMPANION_CLOUD_SWITCH_HOME, async (event, botId: unknown, targetDeviceId: unknown, options: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = companionBotId(botId);
    if (typeof targetDeviceId !== 'string' || !targetDeviceId || targetDeviceId.length > 200) throwIpcError('INVALID_PARAMS', 'targetDeviceId required');
    currentCompanionHomes();
    return activeCompanionCloud()?.switchHome(id, targetDeviceId, companionSwitchOptions(options)) ?? companionNotEnabled;
  });
  ipcMain.handle(MAKER_INVOKE.COMPANION_CLOUD_TRANSCRIPT, async (event, botId: unknown, before: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = companionBotId(botId);
    if (before !== undefined && before !== null && (typeof before !== 'string' || !/^[1-9][0-9]{0,18}$/.test(before)))
      throwIpcError('INVALID_PARAMS', 'Invalid cursor');
    const runtime = activeCompanionCloud();
    if (!runtime) throwIpcError('PRECONDITION_FAILED', 'Cloud companions are not available');
    try {
      return await runtime.transcript(id, typeof before === 'string' ? before : undefined);
    } catch (error) {
      log.warn('companion transcript read failed', { error: error instanceof Error ? error.message.slice(0, 80) : 'UNKNOWN' });
      throwIpcError('PRECONDITION_FAILED', 'Companion conversation is not available');
    }
  });
  ipcMain.handle(MAKER_INVOKE.COMPANION_CLOUD_CINDY_COPIES, async (event) => {
    assertTrustedAppRendererEvent(event);
    currentCompanionHomes();
    return (await activeCompanionCloud()?.cindyCopies()) ?? [];
  });
  ipcMain.handle(MAKER_INVOKE.COMPANION_CLOUD_MERGE_CINDY, async (event, keepBotId: unknown, fromBotIds: unknown) => {
    assertTrustedAppRendererEvent(event);
    const ids = companionMergeIds(keepBotId, fromBotIds);
    currentCompanionHomes();
    return (await activeCompanionCloud()?.mergeCindy(ids.keep, ids.from)) ?? companionNotEnabled;
  });
  ipcMain.handle(MAKER_INVOKE.COMPANION_CLOUD_ATTACHMENT, async (event, botId: unknown, mediaId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = companionBotId(botId);
    if (typeof mediaId !== 'string' || !/^[0-9a-f-]{1,64}$/i.test(mediaId)) throwIpcError('INVALID_PARAMS', 'Invalid media id');
    const runtime = activeCompanionCloud();
    if (!runtime) throwIpcError('PRECONDITION_FAILED', 'Cloud companions are not available');
    try {
      return await runtime.attachment(id, mediaId);
    } catch (error) {
      log.warn('companion attachment read failed', { error: error instanceof Error ? error.message.slice(0, 80) : 'UNKNOWN' });
      throwIpcError('PRECONDITION_FAILED', 'Companion attachment is not available');
    }
  });
  ipcMain.handle(MAKER_INVOKE.COMPANION_AVATAR_RESOLVE, async (event, request: unknown) => {
    assertTrustedAppRendererEvent(event);
    const input = request && typeof request === 'object' ? request as Record<string, unknown> : {};
    const { avatar, deviceId, fetch } = input;
    if (typeof avatar !== 'string' || !avatar || avatar.length > 2048) throwIpcError('INVALID_PARAMS', 'avatar required');
    if (deviceId !== undefined && deviceId !== null && (typeof deviceId !== 'string' || deviceId.length > 200))
      throwIpcError('INVALID_PARAMS', 'Invalid deviceId');
    return companionAvatarCache.resolve({ avatar, deviceId: typeof deviceId === 'string' ? deviceId : null, fetch: fetch === true });
  });
  ipcMain.handle(MAKER_INVOKE.COMPANION_CLOUD_HOME_CHOICES, async (event, botId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = companionBotId(botId);
    currentCompanionHomes();
    const choices: CompanionHomeChoices = { homeDeviceId: null, mode: 'unavailable', reason: 'NOT_ENABLED', targets: [] };
    return (await activeCompanionCloud()?.homeChoices(id)) ?? choices;
  });

  const captureSessionOwner = () => {
    const owner = getCurrentDbClientSnapshot();
    return () => {
      if (!owner || isAppSessionBoundaryPending() || getCurrentDbClientSnapshot() !== owner) throw new Error('账号已变化，请重新发起任务');
    };
  };
  const resolveSessionExecution = createSessionExecutionResolver({
    captureOwner: captureSessionOwner,
    readCaller: async sessionId => {
      const meta = await maker.getSessionMeta(sessionId);
      if (!meta || meta.remoteHostId) throw new Error('无法读取发起任务的本机模型配置，请明确选择新任务的模型');
      const profile = await readSessionRuntimeProfiles(sessionId);
      if (!profile || profile.pendingMutation) throw new Error('发起任务正在切换模型，请稍后重试');
      return { ...profile.effective, effort: profile.effective.effort ?? undefined };
    },
    readDefault: () => {
      const route = getSelectedNewMakerRoute(activeOwnerScopeKey());
      return route ? { agentKind: route.harness === 'claude' ? 'claude-code' : route.harness,
        model: route.model, providerId: route.providerId, effort: (route.effort || undefined) as Effort | undefined,
        fastMode: route.fastMode } : undefined;
    },
    availableAgents: () => maker.listAvailableAgents(),
    availableModels: agent => maker.getCapabilities(agent).availableModels,
    readProviderRouting: () => getProviderRoutingContext(),
    hasCindyAiApiKey: () => readClaudeApiKey() != null,
  });
  setSessionOpeningModelAdmission(async body => {
    const execution = await resolveSessionExecution({
      agentKind: body.agentKind, model: body.model, providerId: body.providerId,
      effort: body.effort, fastMode: body.fastMode,
    });
    return { ...body, ...execution, effort: execution.effort ?? '',
      agentKind: execution.agentKind === 'claude-code' ? 'cc' : execution.agentKind };
  });
  setPluginTaskConfigValidator(async config => { await resolveSessionExecution(config); });

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

    // This surface acts on the user's task, so keep its own route/permissions.
    // Admission is shared with plugin-owned tasks; their defaults must not replace it.
    try {
      // A remote task's model is owned by its execution host, not this device's catalog.
      const source = await maker.getSessionMeta(request.sourceSessionId);
      if (!source?.remoteHostId) await resolveSessionExecution({}, request.sourceSessionId);
    }
    catch (error) { return { ok: false, errorCode: 'MODEL_UNAVAILABLE',
      message: error instanceof Error ? error.message : '任务模型不可用，请在任务中重新选择' }; }

    // agent.run 的真正发送方是插件(来源任务只是它运行的地方):三种模式都盖插件来源。
    const agentRunPluginName = sanitizeSourceName(getInstalledGhostName(request.ghostId));
    const agentRunSourcePlugin = {
      pluginId: request.ghostId,
      ...(agentRunPluginName ? { name: agentRunPluginName } : {}),
    };

    if (request.mode === 'new') {
      const result = await sendToSessionInternal({
        sourcePlugin: agentRunSourcePlugin,
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
        sourcePlugin: agentRunSourcePlugin,
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
    const [latestAssistant] = await getDbClient()
      .drizzle.select({ clientId: messages.clientId })
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
      const forked = await forkSessionAtMessage(request.sourceSessionId, latestAssistant.clientId);
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
      sourcePlugin: agentRunSourcePlugin,
      targetSessionId: forkedSessionId,
      message: request.prompt,
      persistedContent: request.persistedContent,
    });
    if (!sent.ok) return sent;
    return { ok: true, sessionId: forkedSessionId, disposition: 'forked' };
  });
  setGhostSessionRevealer((sessionId) => openMainWindowSession(sessionId));

  // One receipt service per account/database epoch. No mutable current-DB lookup
  // is retained by an asynchronous task request.
  let pluginTaskEpoch: ReturnType<typeof getCurrentDbClientSnapshot> = null;
  let pluginTasks: PluginTaskService | null = null;
  drainPluginTaskReceipts = async () => { await pluginTasks?.drain(); };
  pluginTaskServiceForCurrentOwner = () => {
    const snapshot = getCurrentDbClientSnapshot();
    if (!snapshot) throw new PluginTaskError('HOST_NOT_READY', 'Task storage is unavailable', true);
    if (pluginTaskEpoch === snapshot && pluginTasks) return pluginTasks;
    const assertCurrent = () => {
      if (getCurrentDbClientSnapshot() !== snapshot) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
    };
    const assertPlugin = (pluginId: string) => {
      assertCurrent();
      if (!isPluginTaskAuthorized(pluginId)) throw new PluginTaskError('PERMISSION_DENIED', 'Plugin task capability is unavailable');
    };
    const routeUnavailable = (): never => { throw new PluginTaskError('ROUTE_UNAVAILABLE', 'The selected provider, model or effort is unavailable'); };
    const resolveRoute = async (pluginId: string, requested?: PluginTaskRoute, callId?: string): Promise<PluginTaskRoute> => {
      assertPlugin(pluginId);
      const selection = { ...readPluginTaskConfig(pluginId), ...requested };
      const sourceSessionId = getPluginTaskSourceSessionId(pluginId, callId);
      if (callId && !sourceSessionId && !(selection.agentKind && selection.model && selection.providerId)) throw new PluginTaskError('ROUTE_UNAVAILABLE', '发起任务已不可用，请重新调用，或在面板选择模型后创建任务');
      try {
        const execution = await resolveSessionExecution(selection, sourceSessionId);
        assertPlugin(pluginId);
        if (!execution.providerId) return routeUnavailable();
        return { ...execution, agentKind: execution.agentKind === 'claude-code' ? 'cc' : execution.agentKind,
          providerId: execution.providerId, effort: execution.effort ?? '' };
      } catch (error) {
        throw new PluginTaskError('ROUTE_UNAVAILABLE', error instanceof Error ? error.message : '任务模型不可用，请重新选择');
      }
    };
    const readExecution = (taskId: string) => {
      const live = maker.getSession(taskId);
      return live && (live.isTurnRunning() || live.getTurnControlSnapshot().pendingInteractionCount > 0) ? { instanceId: live.instanceId, generation: live.getTurnGeneration() } : null;
    };
    pluginTaskEpoch = snapshot;
    pluginTasks = createPluginTaskService({
      store: createPluginTaskStore(snapshot.client), assertCurrent, assertAuthorized: assertPlugin, resolveRoute,
      readModelPreference: pluginId => {
        const config = readPluginTaskConfig(pluginId);
        // Match the shared resolver: a complete explicit identity does not
        // inherit the new-task selection; partial/reset settings can do so.
        const fallback = config.agentKind && config.model && config.providerId
          ? undefined : getSelectedNewMakerRoute(activeOwnerScopeKey());
        return { ...config, inheritedDefault: fallback ? JSON.stringify([
          fallback.harness, fallback.model, fallback.providerId, fallback.effort, fallback.fastMode,
        ]) : undefined };
      },
      readPermissionMode: pluginId => clampPluginTaskPermissionMode(readPluginTaskConfig(pluginId).permissionMode),
      readLiveSession: taskId => maker.getSession(taskId),
      setModel: async (taskId, route, assertUnchanged) => {
        const current = await sessionControlService.getSessionRuntime({ targetSessionId: taskId });
        if (!current.ok) throw new PluginTaskError('TASK_NOT_FOUND', current.message);
        await assertUnchanged();
        const targetAgent = route.agentKind === 'cc' ? 'claude-code' : route.agentKind;
        const pendingAgent = current.runtime.pendingMutation?.profile.agentKind;
        const selectHarness = current.runtime.effectiveProfile.agentKind !== targetAgent
          || (pendingAgent !== undefined && pendingAgent !== targetAgent);
        const result = await sessionControlService.setSessionRuntime({ targetSessionId: taskId,
          expectedGeneration: current.runtime.runtimeGeneration,
          beforeMutation: assertUnchanged,
          patch: { ...(selectHarness ? { harness: targetAgent } : {}),
            model: route.model, providerId: route.providerId, effort: (route.effort || null) as Effort | null,
            fastMode: route.fastMode } });
        if (!result.ok) throw new PluginTaskError(result.errorCode, result.message);
        return { status: result.status };
      },
      assertTeamPlanUnstarted: async taskId => {
        assertCurrent();
        await drainPersistQueue();
        assertCurrent();
        const [input] = await snapshot.client.drizzle.select({id: messages.id}).from(messages).where(and(eq(messages.sessionId, taskId), eq(messages.role, 'user'))).limit(1);
        const [task] = await snapshot.client.drizzle.select({startedAt: sessions.activeTurnStartedAt, endedAt: sessions.lastTurnEndedAt}).from(sessions).where(eq(sessions.id, taskId)).limit(1);
        assertCurrent();
        if (input || task?.startedAt != null || task?.endedAt != null) throw new PluginTaskError('TASK_BUSY', 'Register the team plan before sending input');
        const workers = await snapshot.client.drizzle.select({id:orcaWorkers.id}).from(orcaWorkers).innerJoin(orcaTeams,eq(orcaWorkers.teamId,orcaTeams.id)).where(eq(orcaTeams.leadSessionId,taskId)).limit(1);
        const reservations = await snapshot.client.drizzle.select({id:orcaWorkerCreationReservations.id}).from(orcaWorkerCreationReservations).innerJoin(orcaTeams,eq(orcaWorkerCreationReservations.teamId,orcaTeams.id)).where(and(eq(orcaTeams.leadSessionId,taskId),gte(orcaWorkerCreationReservations.expiresAt,Date.now()))).limit(1);
        assertCurrent();
        if (workers.length || reservations.length) throw new PluginTaskError('TASK_BUSY', 'Register the team plan before creating Workers');
      },
      createSession: async (pluginId, taskId, title, route, isolatedWorkspace, requestedRoute, onPersistenceStarted, callId, hidden, targetContext) => {
        assertPlugin(pluginId);
        const cfg = readPluginTaskConfig(pluginId);
        const configurationIsCurrent = () => {
          targetContext?.assertCurrent();
          const current = readPluginTaskConfig(pluginId);
          return current.workingDir === cfg.workingDir && current.permissionMode === cfg.permissionMode
            && current.agentKind === cfg.agentKind && current.model === cfg.model
            && current.providerId === cfg.providerId && current.effort === cfg.effort
            && current.fastMode === cfg.fastMode;
        };
        // Receipt persistence/provider lookup can yield after the first resolution.
        // Reuse the resolver with the original request, then guard this configuration
        // through directory validation and the creator's final continuation.
        const currentRoute = await resolveRoute(pluginId, requestedRoute, callId);
        if ((Object.keys(currentRoute) as Array<keyof PluginTaskRoute>).some(key => currentRoute[key] !== route[key]))
          throw new PluginTaskError('ROUTE_UNAVAILABLE', 'Plugin task route changed');
        const requestedWorkingDir = targetContext?.workingDir ?? (!isolatedWorkspace ? cfg.workingDir : undefined);
        const workingDir = requestedWorkingDir
          ? await resolvePluginWorkerDirectory({
              requested: requestedWorkingDir, configuredDirectory: requestedWorkingDir,
              isPickedDirectory: () => false,
              assertCurrent: () => {
                assertPlugin(pluginId);
                if (!configurationIsCurrent()) throw new PluginTaskError('PERMISSION_DENIED', 'Plugin task configuration changed');
              },
            })
          : undefined;
        assertPlugin(pluginId);
        if (!configurationIsCurrent()) throw new PluginTaskError('PERMISSION_DENIED', 'Plugin task configuration changed');
        await createPluginTaskSession({
          ghostId: pluginId, sessionId: taskId, title, ...route,
          onPersistenceStarted,
          permissionMode: clampPluginTaskPermissionMode(cfg.permissionMode),
          ...(workingDir ? { workingDir } : {}),
          ...(hidden ? { hidden: true } : {}),
          shouldContinue: () => getCurrentDbClientSnapshot() === snapshot && isPluginTaskAuthorized(pluginId) && configurationIsCurrent()
            && (!hidden || ghostDeclaresHiddenTasks(findGhostForInstanceId(pluginId)?.manifest)),
          notifySessionCreated: ({ sessionId, workdir }) => {
            // 插件订阅口径不因隐藏改变(isGhostEligibleSessionRow);后台任务不发「新建」推送,
            // 不进侧栏、手机列表与新任务通知。
            notifyGhostSessionEvent('created', { sessionId, workdir });
            if (!hidden) broadcastSessionCreated(sessionId);
          },
        });
      },
      assertHiddenTasksAllowed: pluginId => {
        assertPlugin(pluginId);
        if (!ghostDeclaresHiddenTasks(findGhostForInstanceId(pluginId)?.manifest))
          throw new PluginTaskError('PERMISSION_DENIED', 'Background tasks require agent.hiddenTasks in ghost.json');
      },
      setHidden: async (taskId, hidden, assertAllowed) => {
        await setSessionHidden({ sessionId: taskId, hidden, db: snapshot.client, assertCurrent: assertAllowed });
      },
      revealPluginTasks: async pluginId => {
        // 不受详情页列表的展示上限约束：分批恢复全部，避免卸载撤销归属后仍有任务隐藏。
        await revealAllPluginHiddenTasks(snapshot.client, pluginId, taskId =>
          setSessionHidden({ sessionId: taskId, hidden: false, db: snapshot.client, assertCurrent }));
      },
      readSession: async taskId => {
        assertCurrent();
        const [row] = await snapshot.client.drizzle.select().from(sessions).where(eq(sessions.id, taskId)).limit(1);
        assertCurrent();
        if (!row || row.source !== 'plugin' || row.remoteHostId || (row.orcaRole && row.orcaRole !== 'lead') || !['cc', 'codex', 'pi'].includes(row.agentKind)) return null;
        const runtime = await readSessionRuntimeProfiles(taskId);
        assertCurrent();
        // A queued input will execute the accepted next-send route. Keep its
        // receipt stable as a deferred model/Harness switch reaches that boundary.
        const selected = runtime?.pendingMutation?.profile ?? runtime?.effective;
        const resolvedConfig: PluginTaskRoute = selected
          ? { agentKind: selected.agentKind === 'claude-code' ? 'cc' : selected.agentKind,
            providerId: selected.providerId ?? '', model: selected.model,
            effort: selected.effort ?? '', fastMode: selected.fastMode }
          : { agentKind: row.agentKind as PluginTaskRoute['agentKind'], providerId: row.providerId ?? '', model: row.model, effort: row.effort, fastMode: row.fastMode };
        const revision = Number.parseInt(pluginTaskConfigHash('sha256').update(JSON.stringify([resolvedConfig, row.permissionMode, row.planModeEnabled, row.workingDir, row.status, row.orcaRole])).digest('hex').slice(0, 12), 16);
        return { taskId, title: row.title, status: row.status, revision, resolvedConfig, workingDir: row.workingDir ?? undefined, permissionMode: row.permissionMode, planModeEnabled: !!row.planModeEnabled, hidden: row.hiddenAt != null };
      },
      dispatch: async (pluginId, taskId, clientId, text, images = []) => {
        assertPlugin(pluginId);
        // 插件来源只用于标签与 `[消息来源]` 说明;不新增 origin 类型,也不是权限判据。
        const pluginName = sanitizeSourceName(getInstalledGhostName(pluginId));
        const validate = async () => { assertPlugin(pluginId); await pluginTaskServiceForCurrentOwner!().assertDispatch(pluginId, taskId); assertPlugin(pluginId); };
        return withPluginMessageAttachments(images, () => assertPlugin(pluginId), async files => {
          await validate();
          const outcome = await sendToSessionInternal({ targetSessionId: taskId, clientId,
            message: text, autoReviewUserText: { kind: 'delegated-continuation' }, forceQueue: true, files,
            sourcePlugin: { pluginId, ...(pluginName ? { name: pluginName } : {}) },
            authorizationGuard: { validate, assertCurrent: () => assertPlugin(pluginId) }, onAccepted: validate });
          await awaitAgentInputQueueSnapshotPersistence(taskId);
          assertCurrent();
          return outcome;
        });
      },
      inspect: async taskId => {
        assertCurrent(); await inputCoordinator.ensureQueueRestored(taskId); assertCurrent();
        if (!inputCoordinator.isQueueRestored(taskId)) throw new PluginTaskError('HOST_NOT_READY', 'Task queue is restoring', true);
        return { execution: readExecution(taskId), pending: inputCoordinator.getQueueControlSnapshot(taskId).pendingQueue };
      },
      cancel: async (pluginId, taskId, inputClientIds, execution) => {
        assertPlugin(pluginId);
        await inputCoordinator.ensureQueueRestored(taskId);
        assertCurrent();
        if (!inputCoordinator.isQueueRestored(taskId)) throw new PluginTaskError('HOST_NOT_READY', 'Task queue is restoring', true);
        await withdrawOwnedSessionInputs({ sessionId: taskId, queue: {
          ensureQueueRestored: async sessionId => {
            await inputCoordinator.ensureQueueRestored(sessionId);
            await pluginTaskServiceForCurrentOwner!().get(pluginId, taskId);
            assertPlugin(pluginId);
          },
          getQueueControlSnapshot: sessionId => inputCoordinator.getQueueControlSnapshot(sessionId),
          remove: (sessionId, clientId) => inputCoordinator.remove(sessionId, clientId),
        }, owns: value => { assertPlugin(pluginId); return inputClientIds.includes(value); }, flush: awaitAgentInputQueueSnapshotPersistence });
        assertCurrent();
        if (!execution) return 'cancelled';
        let stopped = false;
        const applied = await controlOwnedSessionExecution({
          sessionId: taskId, withSessionLock: withSessionRestartLock,
          matches: () => getCurrentDbClientSnapshot() === snapshot && isPluginTaskAuthorized(pluginId) && isSameSessionExecution(readExecution(taskId), execution),
          operation: async () => {
            await pluginTaskServiceForCurrentOwner!().get(pluginId, taskId);
            assertPlugin(pluginId);
            if (!isSameSessionExecution(readExecution(taskId), execution)) { stopped = true; return; }
            resetAutomaticRecoveryForExplicitStop(taskId);
            contextOverflowRolloverHolder?.cancelRecovery(taskId);
            const outcome = await sessionControlService.stopSessionTurn({ targetSessionId: taskId });
            if (!outcome.ok) throw new PluginTaskError('UNSUPPORTED_CAPABILITY', 'Execution does not support stopping');
            stopped = outcome.status === 'no-active-turn';
          },
        });
        return applied ? (stopped ? 'stale' : 'stopping') : 'stale';
      },
    });
    return pluginTasks;
  };
  const startOrcaTeamForCaller = async (leadSessionId: string, workerPermissionMode?: OrcaWorkerPermissionMode, assertCurrent?: (activationStarted?: boolean) => Promise<void>, completeOperation?: PluginTaskService['completeOperation']) => {
      try {
        await assertLeadCollabProjectEnabled(leadSessionId);
        // Plugin Auto cannot request Full access, including through the public
        // Agent tool. Reject before showing a confirmation we cannot honor.
        if (workerPermissionMode === 'bypassPermissions'
          && (await captureOrcaPluginAuthority(leadSessionId)).permissionMode === 'auto') {
          throw new PluginTaskError('PERMISSION_DENIED', 'Plugin tasks cannot request Worker Full access');
        }
        return await startOrcaTeamWithPermissionGate(
          { leadSessionId, workerPermissionMode },
          {
            getCurrentWorkerPermissionMode: getWorkerPermissionModeFromCreationPrefs,
            requestFullAccessConfirmation: (sessionId) =>
              orcaWorkerPermissionConfirmBridge.request(sessionId, {
                title: t('newChat.chatInput.fullAccessConfirmation.title'),
                description: `${t('newChat.chatInput.fullAccessConfirmation.description')} ${t('newChat.chatInput.fullAccessConfirmation.note')}`,
              }),
            startTeam: async (params) => {
              const start = async () => {
                await assertCurrent?.();
                return orcaLifecycleService.startTeam(params, assertCurrent ? () => assertCurrent(true) : undefined);
              };
              // Track only admitted native work, never the permission dialog.
              return completeOperation ? completeOperation(start) : start();
            },
          },
        );
      } catch (err) {
        return {
          ok: false as const,
          errorCode:
            err instanceof Error && (err as unknown as { code?: string }).code
              ? (err as unknown as { code: string }).code
              : 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
  };
  const pluginPermissionRequests = new Set<string>();
  const pluginWriteAccessGate = new PluginWriteAccessGate();
  const pluginWriteAccessIdentity = (pluginId: string) => {
    const owner = getCurrentDbClientSnapshot();
    const revision = getPluginTaskInstallRevision(pluginId);
    if (!owner || !revision) throw new PluginTaskError('PERMISSION_DENIED', 'Plugin task approval unavailable');
    return JSON.stringify([owner.userId, owner.clientEpoch, revision]);
  };
  // Projection and release consume the same host-stamped completion evidence.
  const readPluginWorkerCompletion = createPluginWorkerCompletionReader({
    getCurrentDbClientSnapshot: () => getCurrentDbClientSnapshot(),
    getWorkerFlowStatus: sessionId => createOrcaDiagnosticsDeps().getWorkerFlowStatus(sessionId),
  });
  const handlePluginTask = async (pluginId: string, request: PluginTaskRequest, explicitWriteAccess = false, assertCallerCurrent = () => {}): Promise<unknown> => {
    const service = pluginTaskServiceForCurrentOwner!();
    switch (request.kind) {
      case 'requestWriteAccess': {
        const snapshot = getCurrentDbClientSnapshot();
        const task = await service.get(pluginId, request.taskId);
        if (task.status !== 'active') throw new PluginTaskError('TASK_BUSY', 'Archived tasks cannot request write access');
        const assertPlanInactive = () => {
          const live = maker.getSession(task.taskId);
          const plan = live?.stablePlanModeState;
          if (live && (!plan || plan.enabled)) throw new PluginTaskError('PERMISSION_DENIED', 'Plan Mode is active or changing');
        };
        assertPlanInactive();
        if (task.planModeEnabled) throw new PluginTaskError('PERMISSION_DENIED', 'Exit Plan Mode before requesting write access');
        const mode = request.mode ?? 'acceptEdits';
        const cfg = readPluginTaskConfig(pluginId);
        assertCallerCurrent();
        if (isPluginTaskPermissionAllowed(task.permissionMode, cfg.permissionMode) && (mode === 'acceptEdits' ? task.permissionMode === 'acceptEdits' || task.permissionMode === 'auto' : task.permissionMode === 'auto')) return { granted: true, task };
        if (pluginPermissionRequests.size) throw new PluginTaskError('TASK_BUSY', 'A permission request is already open');
        const identity = pluginWriteAccessIdentity(pluginId);
        const assertRequestCurrent = () => {
          assertCallerCurrent();
          if (snapshot !== getCurrentDbClientSnapshot() || identity !== pluginWriteAccessIdentity(pluginId)) throw new PluginTaskError('PERMISSION_DENIED', 'Permission request identity changed');
        };
        const before = JSON.stringify(cfg);
        const assertIdle = async () => {
          await inputCoordinator.ensureQueueRestored(task.taskId);
          assertRequestCurrent();
          if (!inputCoordinator.isQueueRestored(task.taskId)) throw new PluginTaskError('HOST_NOT_READY', 'Task queue is restoring', true);
          if (mode === 'acceptEdits') {
            if ((await service.listRuns(pluginId, task.taskId)).items.length) throw new PluginTaskError('TASK_BUSY', 'Only an unstarted task can request write access');
            await drainPersistQueue();
            if (!snapshot || snapshot !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
            // Ordinary UI turns have no plugin send receipt. Clearing or rewinding
            // their messages must not make an already-started task new again.
            const [input] = await snapshot.client.drizzle.select({id: messages.id}).from(messages)
              .where(and(eq(messages.sessionId, task.taskId), eq(messages.role, 'user'))).limit(1);
            const [row] = await snapshot.client.drizzle.select({startedAt: sessions.activeTurnStartedAt, endedAt: sessions.lastTurnEndedAt}).from(sessions)
              .where(eq(sessions.id, task.taskId)).limit(1);
            if (snapshot !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
            if (input || row?.startedAt != null || row?.endedAt != null) throw new PluginTaskError('TASK_BUSY', 'Only an unstarted task can request write access');
          }
          const live = maker.getSession(task.taskId);
          if (live?.isTurnRunning() || live?.getTurnControlSnapshot().pendingInteractionCount || inputCoordinator.getQueueControlSnapshot(task.taskId).pendingQueue.length) throw new PluginTaskError('TASK_BUSY', 'Wait for the current turn before changing permission');
        };
        pluginPermissionRequests.add(pluginId);
        try {
          await withSessionRestartLock(task.taskId, assertIdle);
          assertRequestCurrent();
          // Busy/preflight failures have not asked the user anything; do not consume an attempt.
          return await pluginWriteAccessGate.request(JSON.stringify([pluginId, task.taskId]), identity, mode, explicitWriteAccess, async () => {
          const result = request.mobilePageId ? { response: await showMobilePluginTaskPermission(pluginId, request.mobilePageId, {
            title: t(mode === 'auto' ? 'pluginTaskWriteAccess.autoTitle' : 'pluginTaskWriteAccess.title'),
            message: t(mode === 'auto' ? 'pluginTaskWriteAccess.autoMessage' : 'pluginTaskWriteAccess.message').replace('{{name}}', getInstalledGhostName(pluginId) ?? pluginId),
            detail: `${task.title}\n\n${t(mode === 'auto' ? 'pluginTaskWriteAccess.autoDetail' : 'pluginTaskWriteAccess.detail')}`,
            allow: t('pluginTaskWriteAccess.allow'), cancel: t('pluginTaskWriteAccess.cancel'),
          }) ? 0 : 1 } : await dialog.showMessageBox({
            type: 'question', title: t(mode === 'auto' ? 'pluginTaskWriteAccess.autoTitle' : 'pluginTaskWriteAccess.title'),
            message: t(mode === 'auto' ? 'pluginTaskWriteAccess.autoMessage' : 'pluginTaskWriteAccess.message').replace('{{name}}', getInstalledGhostName(pluginId) ?? pluginId),
            detail: t(mode === 'auto' ? 'pluginTaskWriteAccess.autoDetail' : 'pluginTaskWriteAccess.detail'),
            buttons: [t('pluginTaskWriteAccess.allow'), t('pluginTaskWriteAccess.cancel')], defaultId: 1, cancelId: 1,
          });
          if (result.response !== 0) return { granted: false };
          // Reserve permission order before the lifecycle/restart fence. Ordinary
          // permission writers never hold that fence while awaiting this queue.
          return await withSessionPermissionChange(task.taskId, () => service.completeOperation(() => withSessionRestartLock(task.taskId, async () => {
            assertRequestCurrent();
            if (snapshot !== getCurrentDbClientSnapshot() || before !== JSON.stringify(readPluginTaskConfig(pluginId))) throw new PluginTaskError('PERMISSION_DENIED', 'Account or permission settings changed');
            const fresh = await service.get(pluginId, task.taskId);
            if (fresh.status !== 'active') throw new PluginTaskError('TASK_BUSY', 'Archived tasks cannot request write access');
            if (fresh.planModeEnabled) throw new PluginTaskError('PERMISSION_DENIED', 'Exit Plan Mode before requesting write access');
            if (fresh.revision !== task.revision) throw new PluginTaskError('TASK_BUSY', 'Task changed while awaiting permission');
            await assertIdle();
            assertRequestCurrent();
            assertPlanInactive();
            const live = maker.getSession(task.taskId);
            let persisted = false;
            try {
              if (live) await live.setPermissionMode(mode);
              assertRequestCurrent();
              if (snapshot !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
              const saved = await snapshot!.client.tx('bots.persistSessionPermission', {sessionId: task.taskId, mode});
              persisted = saved.updated;
              if (!saved.updated) throw new PluginTaskError('TASK_NOT_FOUND', 'Task not found');
              if (snapshot !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
              const updatedTask = await service.get(pluginId, task.taskId);
              if (updatedTask.planModeEnabled) throw new PluginTaskError('PERMISSION_DENIED', 'Plan Mode changed during permission confirmation');
              assertRequestCurrent();
              if (snapshot !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
              assertPlanInactive();
              const currentConfig = readPluginTaskConfig(pluginId);
              if (currentConfig.permissionMode !== cfg.permissionMode) throw new PluginTaskError('PERMISSION_DENIED', 'Permission settings changed');
              if (mode === 'auto' || ['ask', 'plan'].includes(clampPluginTaskPermissionMode(currentConfig.permissionMode))) writePluginTaskConfig(pluginId, {...currentConfig, permissionMode: mode});
              broadcastSessionPatched(task.taskId, {permissionMode: mode});
              return { granted: true, task: updatedTask };
            } catch (error) {
              if (live) await live.setPermissionMode(task.permissionMode as Parameters<typeof live.setPermissionMode>[0]).catch(() => undefined);
              if (persisted) await snapshot!.client.tx('bots.persistSessionPermission', {sessionId: task.taskId, mode: task.permissionMode});
              throw error;
            }
          })));
          });
        } finally { pluginPermissionRequests.delete(pluginId); }
      }
      case 'startTeam': {
        const epoch = getCurrentDbClientSnapshot();
        const task = await service.get(pluginId, request.taskId);
        const configuredDirectory = readPluginTaskConfig(pluginId).workingDir;
        // Becoming Lead changes revision through orcaRole, but may not change admission facts.
        const admission = (view: typeof task) => JSON.stringify([view.resolvedConfig, view.permissionMode, view.planModeEnabled, view.workingDir]);
        const expectedAdmission = admission(task);
        assertPluginWorkerAutoAuthorized(pluginId, task);
        const result = await startOrcaTeamForCaller(task.taskId, undefined, async (activationStarted) => {
          if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
          const fresh = await service.get(pluginId, task.taskId);
          if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
          assertPluginWorkerAutoAuthorized(pluginId, fresh);
          if (configuredDirectory !== readPluginTaskConfig(pluginId).workingDir) throw new PluginTaskError('PERMISSION_DENIED', 'Plugin directory authorization changed');
          if ((!activationStarted && fresh.revision !== task.revision) || admission(fresh) !== expectedAdmission) throw new PluginTaskError('STALE_REVISION', 'Task changed during team activation');
        }, service.completeOperation);
        assertPluginTaskResult(result, 'Collaboration could not be started');
        return result;
      }
      case 'setTeamPlan': return withSendToSessionLock(request.taskId, async () => {
        const epoch = getCurrentDbClientSnapshot();
        const task = await service.get(pluginId, request.taskId);
        const cfg = readPluginTaskConfig(pluginId);
        const assertCurrent = () => {
          if (epoch !== getCurrentDbClientSnapshot() || !isPluginTaskAuthorized(pluginId) || cfg.workingDir !== readPluginTaskConfig(pluginId).workingDir) throw new PluginTaskError('PERMISSION_DENIED', 'Plugin directory authorization changed');
        };
        const items = [];
        for (const item of request.plan.items) {
          const workingDir = await resolvePluginWorkerDirectory({requested:item.workingDir,leadDirectory:task.workingDir,configuredDirectory:cfg.workingDir,isPickedDirectory:dir=>isGhostPickedDir(pluginId,dir),assertCurrent});
          items.push({...item, workingDir});
        }
        const current = await service.get(pluginId, request.taskId);
        assertCurrent();
        if (current.revision !== task.revision) throw new PluginTaskError('STALE_REVISION', 'Task changed during directory validation');
        return service.setTeamPlan(pluginId, request.taskId, {...request.plan, items});
      });
      case 'releaseWorker': {
        return service.completeOperation(async () => {
          const epoch = getCurrentDbClientSnapshot();
          await service.get(pluginId,request.taskId);
          if (!epoch) throw new PluginTaskError('HOST_NOT_READY','Task storage unavailable',true);
          const [record] = await epoch.client.drizzle.select({id:orcaWorkers.id,sessionId:orcaWorkers.sessionId,label:orcaWorkers.label}).from(orcaWorkers).innerJoin(orcaTeams,eq(orcaWorkers.teamId,orcaTeams.id)).where(and(eq(orcaWorkers.id,request.workerId),eq(orcaTeams.leadSessionId,request.taskId))).limit(1);
          if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED','Account changed');
          await service.get(pluginId,request.taskId);
          if (!record) throw new PluginTaskError('TASK_NOT_FOUND','Worker not found');
          const planReceipt = await createPluginTaskStore(epoch.client).get(request.taskId);
          const plan = planReceipt ? readPluginTaskPlanReceipt(planReceipt.payload).teamPlan : undefined;
          if (plan && !plan.items.some((item: {label: string}) => item.label === record.label)) throw new PluginTaskError('INVALID_REQUEST', 'Worker is not in team plan');
          const [row] = await epoch.client.drizzle.select().from(sessions).where(eq(sessions.id,record.sessionId)).limit(1);
          if (!row || row.status === 'deleted') throw new PluginTaskError('TASK_NOT_FOUND','Worker not found');
          const validate = async () => {
            if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED','Account changed');
            await service.get(pluginId,request.taskId);
            const [worker] = await epoch.client.drizzle.select({status:orcaWorkers.status}).from(orcaWorkers).where(eq(orcaWorkers.id,record.id)).limit(1);
            const {row: fresh, completedAt} = await readPluginWorkerCompletion(epoch, record.sessionId, worker?.status ?? 'unknown');
            if (!fresh || fresh.status === 'deleted' || completedAt === null || completedAt !== request.completedAt) throw new PluginTaskError('STALE_REVISION','Worker has no matching successful completion');
          };
          if (row.status === 'archived') {
            await validate();
            if (plan) await service.settleWorkerLabel(pluginId,request.taskId,record.label!);
            return {ok:true,workerId:record.id};
          }
          const result = await orcaTeamService.archiveWorker({callerLeadSessionId:request.taskId,workerId:record.id,onlyIfIdle:true,beforeArchive:validate});
          assertPluginTaskResult(result, 'Worker could not be released');
          if (result.ok && plan) await service.settleWorkerLabel(pluginId,request.taskId,record.label!);
          return result;
        });
      }
      case 'getTeam': {
        const epoch = getCurrentDbClientSnapshot();
        if (!epoch) throw new PluginTaskError('HOST_NOT_READY', 'Task storage unavailable', true);
        await service.get(pluginId, request.taskId);
        await inputCoordinator.ensureQueueRestored(request.taskId);
        if (!inputCoordinator.isQueueRestored(request.taskId)) throw new PluginTaskError('HOST_NOT_READY', 'Task input queue is unavailable', true);
        if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
        await service.get(pluginId, request.taskId);
        const team = await getOrcaWorkspaceInfoReadOnly(createOrcaDiagnosticsDeps(), request.taskId);
        if (!team.ok) throw new PluginTaskError('HOST_NOT_READY', 'Collaboration state unavailable', true);
        const workers = await Promise.all(team.workers.map(async worker => {
          const {row, completedAt, status} = await readPluginWorkerCompletion(epoch, worker.session_id, worker.status);
          const activity = await readPluginWorkerActivity(epoch, worker.session_id, row?.createdAt);
          return {...worker, acceptedAt:activity.acceptedAt, startedAt:activity.firstActivityAt, timingBasis:'host-message-window', createdAt:row?.createdAt, lastTurnStartedAt:row?.activeTurnStartedAt, lastTurnEndedAt:row?.lastTurnEndedAt, waitingForUser:!!maker.getSession(worker.session_id)?.getTurnControlSnapshot().pendingInteractionCount, usage: {scope:'session-total', tokens:row?.totalTokenUsage ?? null, costUSD:row?.totalCostCurrency === 'USD' && row.totalCostAmount > 0 ? row.totalCostAmount : null, approximate:row?.totalCostIsApproximate ?? false, reason:row?.totalCostCurrency === 'USD' && row.totalCostAmount > 0 ? null : 'No confirmed USD cost; subscription value and other currencies are not a bill'}, status, permissionMode:row?.permissionMode, providerId:row?.providerId, fastMode:row?.fastMode, completedAt};
        }));
        if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
        await service.get(pluginId, request.taskId);
        const [leadRow] = await epoch.client.drizzle.select().from(sessions).where(eq(sessions.id,request.taskId)).limit(1);
        const reservations = team.workflow ? await epoch.client.drizzle.select({id:orcaWorkerCreationReservations.id}).from(orcaWorkerCreationReservations).where(and(eq(orcaWorkerCreationReservations.teamId,team.workflow.workflow_id),gte(orcaWorkerCreationReservations.expiresAt,Date.now()))) : [];
        const occupiedSlots=workers.length+reservations.length;
        const planRow = await createPluginTaskStore(epoch.client).get(request.taskId);
        const plan = planRow ? readPluginTaskPlanReceipt(planRow.payload).teamPlan : undefined;
        if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED','Account changed');
        await service.get(pluginId,request.taskId);
        const hardLimit = Math.min(readCollaborationSettings().workerHardLimit, plan?.concurrency ?? Infinity);
        const live = maker.getSession(request.taskId);
        return {...team, capacity:{hardLimit,occupiedSlots,remainingSlots:Math.max(0,hardLimit-occupiedSlots),advisory:true}, coordinatorUsage:{scope:'session-total',tokens:leadRow?.totalTokenUsage ?? null,costUSD:leadRow?.totalCostCurrency==='USD' && leadRow.totalCostAmount>0 ? leadRow.totalCostAmount : null, approximate:leadRow?.totalCostIsApproximate ?? false}, workers, waitingForUser:!!live && live.getTurnControlSnapshot().pendingInteractionCount > 0, leadWorking:(!!live && (live.isTurnRunning() || live.getTurnControlSnapshot().pendingInteractionCount > 0)) || inputCoordinator.getQueueControlSnapshot(request.taskId).pendingQueue.length > 0};
      }
      case 'models': {
        const snapshot = getCurrentDbClientSnapshot();
        const { available } = await inspectAppDefaultModel();
        if (snapshot !== getCurrentDbClientSnapshot() || !isPluginTaskAuthorized(pluginId)) throw new PluginTaskError('PERMISSION_DENIED', '账号或插件授权已变化');
        return { models: available.map(option => ({ id: option.id,
          route: { agentKind: option.route.harness === 'claude' ? 'cc' : option.route.harness,
            model: option.route.model, providerId: option.route.providerId,
            effort: option.route.effort, fastMode: option.route.fastMode },
          efforts: option.efforts, supportsFastMode: option.supportsFastMode })) };
      }
      case 'setModel': return service.setModel(pluginId, request);
      case 'create': return service.create(pluginId, request);
      case 'get': return service.get(pluginId, request.taskId);
      case 'setHidden': return service.setHidden(pluginId, request);
      case 'list': return service.list(pluginId, request.after, request.limit);
      case 'send': return service.send(pluginId, request);
      case 'readMessages': {
        const snapshot = getCurrentDbClientSnapshot();
        await service.get(pluginId, request.taskId);
        if (snapshot !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
        if (!snapshot) throw new PluginTaskError('HOST_NOT_READY', 'Task storage is unavailable', true);
        let cursor: { createdAt: number; id: string; rowid?: number } | null = null;
        if (request.after) {
          try {
            cursor = JSON.parse(request.after);
            if (!cursor || typeof cursor.id !== 'string' || !Number.isSafeInteger(cursor.createdAt)
              || (cursor.rowid !== undefined && !Number.isSafeInteger(cursor.rowid))) throw new Error('Invalid cursor');
          } catch { throw new PluginTaskError('INVALID_REQUEST', 'Invalid message cursor'); }
        }
        await drainPersistQueue();
        if (getCurrentDbClientSnapshot() !== snapshot) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
        const page = await getMessagesForHistory({ sessionIds: [request.taskId], workdir: null, fromMs: null, toMs: null,
          agentKind: null, roles: null, includeRewound: false, limit: request.limit ?? 50, cursor, order: 'asc' });
        await service.get(pluginId, request.taskId);
        if (getCurrentDbClientSnapshot() !== snapshot) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
        return { items: page.items.map(({ id, clientId, role, content, createdAt }) => ({ id: clientId ?? id, role, content, createdAt })),
          nextCursor: page.nextCursor ? JSON.stringify(page.nextCursor) : null };
      }
      case 'getRun': return service.getRun(pluginId, request.runId);
      case 'listRuns': return service.listRuns(pluginId, request.taskId, request.after, request.limit);
      case 'cancel': return service.cancel(pluginId, request.runId);
      default: throw new PluginTaskError('UNSUPPORTED_CAPABILITY', 'Task operation is unavailable');
    }
  };
  setPluginTaskHandler(handlePluginTask);
  setPluginTargetAdapter({
    store: () => {
      const snapshot = getCurrentDbClientSnapshot();
      if (!snapshot) throw new Error('HOST_NOT_READY');
      return createPluginTargetStore(snapshot.client, () => {
        if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('PERMISSION_DENIED');
      });
    },
    approvalRevision: pluginTargetAuthorizationRevision,
    candidates: listPluginTargetCandidates,
    session: resolvePluginTargetSession,
    create: async (pluginId, project, taskId, title, route, guard) => {
      guard();
      await pluginTaskServiceForCurrentOwner!().create(pluginId, {
        requestKey: `target-project:${taskId}`, title, route,
      }, { taskId, workingDir: project, assertCurrent: guard });
      guard();
    },
    send: async (pluginId, taskId, clientId, text, guard, validateTarget, delivery, images = []) => {
      guard();
      const snapshot = getCurrentDbClientSnapshot();
      const assertCurrent = () => { guard(); if (snapshot !== getCurrentDbClientSnapshot()) throw new Error('PERMISSION_DENIED'); };
      const name = sanitizeSourceName(getInstalledGhostName(pluginId));
      const sourcePlugin = { pluginId, ...(name ? { name } : {}) };
      const validate = async () => { assertCurrent(); await validateTarget(); assertCurrent(); };
      await validate();
      return withPluginMessageAttachments(images, assertCurrent, async files => {
        if (delivery === 'steer') {
          const outcome = await withSendToSessionLock(taskId, async () => {
            await validate();
            await assertReviewExternalInputAllowed(taskId);
            const session = maker.getSession(taskId);
            if (!session?.isTurnRunning() || !session.capabilities.sameTurnSteer.supported) return 'not-attempted';
            const turnGeneration = session.getTurnGeneration();
            const meta = await maker.getSessionMeta(taskId);
            await validate();
            if (!meta) throw new Error('TARGET_UNAVAILABLE');
            const item = await buildSessionControlInputItem({ targetSessionId: taskId, clientId,
              message: text, persistedContent: text, meta, sourcePlugin, files,
              inheritTargetPlanMode: true,
              autoReviewUserText: { kind: 'delegated-continuation' },
            });
            await validate();
            return inputCoordinator.steerControlInput(taskId, { item }, {
              session, turnGeneration, beforeMutation: validate,
            });
          });
          if (outcome === 'steered') {
            await awaitAgentInputQueueSnapshotPersistence(taskId);
            return 'steer';
          }
          if (outcome === 'rejected') throw new Error('DELIVERY_REJECTED');
          // The coordinator owns ACK-uncertain input in a paused queue. Never enqueue a copy.
          if (outcome === 'queued') {
            await awaitAgentInputQueueSnapshotPersistence(taskId);
            throw new Error('DELIVERY_UNCERTAIN');
          }
        }
        const result = await sendToSessionInternal({ targetSessionId: taskId, clientId, message: text, files,
          autoReviewUserText: { kind: 'delegated-continuation' }, forceQueue: true,
          resumeWithStoredPermissionMode: true,
          inheritTargetPlanMode: true,
          sourcePlugin,
          authorizationGuard: { validate, assertCurrent },
          onAccepted: validate,
        });
        if (!result.ok) throw Object.assign(new Error(result.message), { code: result.errorCode });
        await awaitAgentInputQueueSnapshotPersistence(taskId);
        return 'queue';
      });
    },
    withdraw: async (taskId, clientId, guard) => {
      guard();
      await withdrawOwnedSessionInputs({ sessionId: taskId,
        queue: {
          ensureQueueRestored: async id => { await inputCoordinator.ensureQueueRestored(id); guard(); },
          getQueueControlSnapshot: id => inputCoordinator.getQueueControlSnapshot(id),
          remove: (id, inputId) => inputCoordinator.remove(id, inputId),
        },
        owns: id => { guard(); return id === clientId; }, flush: awaitAgentInputQueueSnapshotPersistence,
      });
    },
  });
  setPluginTaskUninstaller((pluginId, remove) => pluginTaskServiceForCurrentOwner!().withUninstall(pluginId, remove));
  setPluginTaskRelocator((from, to) => pluginTaskServiceForCurrentOwner!().relocatePlugin(from, to));

  // Local task UI only. The plugin and device-link protocols have no recovery operation.
  const pluginWriteAccessFromHost = async (event: Electron.IpcMainInvokeEvent, taskId: unknown, retry: boolean) => {
    if (isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', 'Local task UI required');
    assertTrustedAppRendererEvent(event);
    if (typeof taskId !== 'string' || !taskId || taskId.length > 128) throwIpcError('INVALID_PARAMS', 'taskId required');
    const owner = getCurrentDbClientSnapshot();
    if (!owner) throwIpcError('INTERNAL', 'Task storage unavailable');
    const frame = event.senderFrame;
    const assertCallerCurrent = () => {
      if (owner !== getCurrentDbClientSnapshot() || event.sender.isDestroyed() || event.senderFrame !== frame) throwIpcError('PERMISSION_DENIED', 'Task UI changed');
      assertTrustedAppRendererEvent(event);
    };
    const receipt = await createPluginTaskStore(owner.client).get(taskId);
    assertCallerCurrent();
    if (!receipt || receipt.operation !== 'create') return { granted: false, available: false };
    try {
      await pluginTaskServiceForCurrentOwner!().get(receipt.pluginId, taskId);
      assertCallerCurrent();
      const identity = pluginWriteAccessIdentity(receipt.pluginId);
      const mode = pluginWriteAccessGate.recoverable(JSON.stringify([receipt.pluginId, taskId]), identity);
      if (!retry || !mode) return { granted: false, available: !!mode };
      const result = await handlePluginTask(receipt.pluginId, {type:'tasks-request', kind:'requestWriteAccess', taskId, mode}, true, () => {
        assertCallerCurrent();
        if (identity !== pluginWriteAccessIdentity(receipt.pluginId)) throwIpcError('PERMISSION_DENIED', 'Plugin installation changed');
      }) as {granted: boolean};
      return { granted: result.granted, available: !result.granted, mode };
    } catch {
      throwIpcError('PERMISSION_DENIED', 'Plugin write permission could not be confirmed');
    }
  };
  ipcMain.handle('maker:get-plugin-write-access-recovery', (event, taskId: unknown) => pluginWriteAccessFromHost(event, taskId, false));
  ipcMain.handle('maker:retry-plugin-write-access', (event, taskId: unknown) => pluginWriteAccessFromHost(event, taskId, true));

  // 插件详情页「后台任务」:只服务本机可信窗口(打开/显示到任务列表都是本机 UI 动作),
  // 不登记 device-link;停用的插件同样可查,透明性不依赖插件仍可运行。
  const pluginBackgroundTasks = createPluginBackgroundTaskHandlers({
    currentDb: () => getCurrentDbClientSnapshot()?.client ?? null,
    isInstalled: pluginId => findGhostForInstanceId(pluginId) !== null,
    isRunning: taskId => maker.getSession(taskId)?.isTurnRunning() === true,
    setHidden: input => setSessionHidden(input),
  });
  const assertLocalBackgroundTaskUi = (event: Electron.IpcMainInvokeEvent) => {
    if (isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', 'Local task UI required');
    assertTrustedAppRendererEvent(event);
  };
  ipcMain.handle('ghosts:background-tasks:list', (event, pluginId: unknown) => {
    assertLocalBackgroundTaskUi(event);
    return pluginBackgroundTasks.list(pluginId);
  });
  ipcMain.handle('ghosts:background-tasks:reveal', (event, pluginId: unknown, taskId: unknown) => {
    assertLocalBackgroundTaskUi(event);
    return pluginBackgroundTasks.reveal(pluginId, taskId);
  });

  // Legacy result-returning adapter; ordinary task configuration lives above.
  setGhostErrandRunner(
    createGhostErrandRunner({
      readConfig: readPluginTaskConfig,
      readSessionId: readGhostErrandSessionId,
      writeSessionId: writeGhostErrandSessionId,
      getSessionRow: async (sessionId) => {
        const [row] = await getDbClient()
          .drizzle.select({
            status: sessions.status,
            agentKind: sessions.agentKind,
            model: sessions.model,
            providerId: sessions.providerId,
            effort: sessions.effort,
            fastMode: sessions.fastMode,
            permissionMode: sessions.permissionMode,
            workingDir: sessions.workingDir,
            workspaceKind: sessions.workspaceKind,
          })
          .from(sessions)
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!row) return null;
        const profile = await readSessionRuntimeProfiles(sessionId);
        if (profile?.pendingMutation) throw new Error('任务正在切换模型，请稍后重试');
        const live = maker.getSession(sessionId);
        const mode = live ? live.stablePermissionModeState?.mode : row.permissionMode;
        if (live && !mode) throw new Error('任务正在切换权限，请稍后重试');
        return { ...row, ...(profile ? { ...profile.effective,
          agentKind: profile.effective.agentKind === 'claude-code' ? 'cc' : profile.effective.agentKind } : {}),
          permissionMode: mode ?? row.permissionMode };
      },
      createSession: async (params) => {
        const sessionId = await createPluginTaskSession({
          ...params,
          notifySessionCreated: (info) => notifyGhostSessionEvent('created', info),
        });
        // errand 会话在侧边栏可见(与 workspace 槽同通道刷新)——透明是这个
        // 能力的安全边界之一,errand 不支持隐藏。普通任务只有声明 agent.hiddenTasks
        // 才能转入后台,且用户始终能在插件详情页「后台任务」查看与接手。
        broadcastSessionCreated(sessionId);
        return sessionId;
      },
      getGhostName: getInstalledGhostName,
      resolveExecution: resolveSessionExecution,
      captureOwner: captureSessionOwner,
      normalizeWorkingDir: (dir) => normalizeWorkingDirForStorage(dir),
      isUserPickedDir: isGhostPickedDir,
      isSessionBusy: isSessionInTurn,
      dispatch: async ({ targetSessionId, message, ghostId }) => {
        // errand 同样由插件发出:盖插件来源(标签与 `[消息来源]`),不是权限判据。
        const errandPluginName = sanitizeSourceName(getInstalledGhostName(ghostId));
        const r = await sendToSessionInternal({
          targetSessionId,
          message,
          sourcePlugin: { pluginId: ghostId, ...(errandPluginName ? { name: errandPluginName } : {}) },
          // errand 会话按任务设置的权限档落库;冷启动必须沿用,不能退回 bypass(#5788)。
          resumeWithStoredPermissionMode: true,
        });
        if (!r.ok) return { ok: false, errorCode: r.errorCode, message: r.message };
        return { ok: true, wakeKind: r.wakeKind };
      },
      getObservableSession: (sessionId) => maker.getSession(sessionId) ?? null,
      onSilentStopSettled,
      readLatestAssistantText: async (sessionId, sinceMs) => {
        const [row] = await getDbClient()
          .drizzle.select({ content: messages.content })
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
  setGhostLibraryExtraDirSync(syncLibraryReadonlyExtraDir);
  getGhostFsSlot().setSessionSnapshotResolver(async (sessionId, instanceId) =>
    resolveGhostFsSessionSnapshot((id) => getMaker().getSession(id), sessionId, instanceId));
  setGhostWorkspaceSessionService({
    captureSessionAuthorization: (sessionId, instanceId) => {
      const snapshot = resolveGhostFsSessionSnapshot((id) => getMaker().getSession(id), sessionId, instanceId);
      return snapshot && !snapshot.planModeEnabled && snapshot.permissionMode !== 'plan'
        ? snapshot.isCurrent ?? null : null;
    },
    reviewPermissionAction: async (sessionId, instanceId, action) => {
      const session = getMaker().getSession(sessionId);
      if (!session || session.instanceId !== instanceId) {
        return { verdict: 'block', reason: 'The originating task instance is no longer active.' };
      }
      const decision = await session.reviewHostPermissionAction(action);
      return getMaker().getSession(sessionId) === session
        ? decision
        : { verdict: 'block', reason: 'The task instance changed during review.' };
    },
    findActiveSessionByWorkdir,
    createDraftSession: async (params) => {
      const assertOwner = captureSessionOwner();
      const config = readPluginTaskConfig(params.ghostId);
      const execution = await resolveSessionExecution(config, params.sourceSessionId);
      assertOwner();
      const sessionId = await createPluginDraftSession({
        ...params,
        shouldContinue: () => { assertOwner(); return (params.shouldContinue?.() ?? true)
          && JSON.stringify(readPluginTaskConfig(params.ghostId)) === JSON.stringify(config); },
        defaults: { ...execution, effort: execution.effort ?? '', permissionMode: clampPluginTaskPermissionMode(config.permissionMode), agentKind: execution.agentKind === 'claude-code' ? 'cc' : execution.agentKind },
        notifySessionCreated: (info) => notifyGhostSessionEvent('created', info),
      });
      if (!sessionId) return null;
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
    inheritTargetPlanMode = false,
  ): Promise<AgentInputCreateOpts> {
    const db = getDbClient().drizzle;
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!row) {
      throw new Error(`session ${sessionId} not found`);
    }
    const createOpts = buildCreateOptsWithStderr({
      id: sessionId,
      agentKind: meta.agentKind,
      workingDir: row.workingDir ?? meta.workDir,
      model: meta.model,
      providerId: row.providerId,
      resumeSessionId: meta.sdkSessionId,
      effort: (row.effort ?? undefined) as CreateOpts['effort'],
      fastMode: (row.fastMode ?? false),
      permissionMode: permissionModeOrAsk(row.permissionMode),
      planMode: inheritTargetPlanMode ? !!row.planModeEnabled : false,
      title: row.title ?? undefined,
      remoteHostId: row.remoteHostId ?? undefined,
      orcaRole: row.orcaRole as CreateOpts['orcaRole'],
    });
    await synthesizeOrcaVendorOptionsFromDb(sessionId, createOpts);
    if (createOpts.extraDirs === undefined) {
      try {
        const extraDirs = await readSessionExtraDirsFromDb(sessionId);
        if (extraDirs.length > 0) Object.assign(createOpts, directoryGrantsForRuntime(extraDirs));
      } catch (err) {
        log.warn('inter-agent queue: read extra_dirs from DB failed (non-fatal)', {
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (createOpts.writableDirs === undefined) {
      const writableDirs = await readSessionWritableDirsFromDb(sessionId).catch(() => []);
      if (writableDirs.length > 0) createOpts.writableDirs = writableDirs;
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
    taskActionDeliveryGuard?: TaskActionDeliveryGuard;
    botTaskCoordination?: BotTaskCoordination;
    targetSessionId: string;
    inheritTargetPlanMode?: boolean;
    message: string;
    persistedContent: string;
    files?: AgentInputQueuedMessage['files'];
    clientId: string;
    meta: NonNullable<Awaited<ReturnType<typeof maker.getSessionMeta>>>;
    dbRow: NonNullable<Awaited<ReturnType<typeof getSessionRowSnapshot>>>;
    onAccepted?: SchedulerQueuedPromptRequest['onAccepted'];
    onAcceptedRollback?: SchedulerQueuedPromptRequest['onAcceptedRollback'];
    onAcceptedCommit?: () => void | Promise<void>;
    origin?: AgentInputQueuedMessage['origin'];
    sourcePlugin?: AgentInputQueuedMessage['sourcePlugin'];
    /** Host-only receipt: plugin-authored input is not user-authored permission. */
    autoReviewUserText?: AgentRequestReceipt;
    authorizationGuard?: BotAuthorizationInputGuard;
  }): Promise<void> {
    const queued = await buildSessionControlInputItem(params);
    if (params.onAccepted) {
      orcaInterAgentDispatcher.registerQueuedOrcaInterAgentAcceptedCallback(
        params.clientId,
        () => params.onAccepted?.({
          permissionMode: queued.createOpts.permissionMode,
          planMode: queued.createOpts.planMode,
        }),
        params.onAcceptedRollback,
        params.onAcceptedCommit,
      );
    }
    // 崩溃恢复排序:确保先读回持久化队列再追加本条(见 ensureQueueRestored)。
    // 失败时 enqueue 照常入队(shouldQueueNewTurn 已守住不会直发)。
    await inputCoordinator.ensureQueueRestored(params.targetSessionId).catch(() => undefined);
    await assertTaskActionCurrent();
    if (params.authorizationGuard) {
      await commitBotAuthorizationInput(params.authorizationGuard, () => {
        inputCoordinator.enqueue(params.targetSessionId, queued);
      });
    } else {
      inputCoordinator.enqueue(params.targetSessionId, queued);
    }
    log.info('send_to_session queued while target busy', {
      targetSessionId: params.targetSessionId,
      clientId: params.clientId,
    });
  }

  const buildSessionControlInputItem=createSessionControlInputBuilder({buildCreateOptsForQueuedSession});

  const orcaInterAgentDispatcher: OrcaInterAgentDispatcher = createOrcaInterAgentDispatcher({
    readAutoReviewHistory: sessionId => readAutoReviewHistory(sessionId),
    createId,
    getSessionMeta: (sessionId) => maker.getSessionMeta(sessionId).catch(() => null),
    getSessionRowSnapshot,
    getLiveSession: (sessionId) => maker.getSession(sessionId),
    validateImageAttachments: async (paths) => {
      // 图片来源两类: 会话受管地址(cindy-media:// / xdt-image://)与任意本机绝对路径。
      const images: Array<{ path: string; name: string; ext: string; size: number; mimeType: string }> = [];
      for (const input of paths) {
        const resolved = resolveOrcaImageAttachmentInput(input);
        if (!resolved) {
          return {
            ok: false,
            message: `image not resolvable (accepts cindy-media:// / xdt-image:// URIs or local image files: png/jpeg/gif/webp): ${input}`,
          };
        }
        let size: number;
        try {
          const stat = await fsp.stat(resolved.absPath);
          if (!stat.isFile()) throw new Error('not a file');
          size = stat.size;
        } catch {
          return { ok: false, message: `image not found or unreadable: ${input}` };
        }
        images.push({
          path: resolved.absPath,
          name: path.basename(resolved.absPath),
          ext: path.extname(resolved.absPath).toLowerCase(),
          size,
          mimeType: resolved.mimeType,
        });
      }
      return { ok: true, images };
    },
    applyPendingAgentSwitch: (sessionId) =>
      applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId, { bootstrapAfterSwitch: true }),
    hasPendingAgentSwitch: (sessionId) => !!agentSwitchPending.get(sessionId),
    peekPendingHandoff: (sessionId) => agentHandoffPending.peek(sessionId),
    consumePendingHandoff: (sessionId) => agentHandoffPending.consume(sessionId),
    shouldQueueNewTurn: (sessionId): boolean => inputCoordinator.shouldQueueNewTurn(sessionId),
    steerControlInput: (sessionId, item, expectedTurn) =>
      inputCoordinator.steerControlInput(sessionId, { item }, expectedTurn),
    hasSendToSessionLock: (sessionId) => sendToSessionLocks.has(sessionId),
    withSendToSessionLock,
    prepareUnhealthySession: (sessionId) =>
      contextOverflowRolloverHolder?.prepareUnhealthySession(sessionId) ?? Promise.resolve(false),
    buildCreateOptsForQueuedSession,
    enqueueQueuedMessage: (sessionId, item) => {
      // 先 await 恢复再 enqueue:确保恢复的排队 prompt 在新消息之前,且恢复后
      // 队列处于 paused 态不会被新消息的 getDrainableHead 立刻 drain。
      void (async () => {
        await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
        inputCoordinator.enqueue(sessionId, item);
      })();
    },
    reserveNextQueuedMessage: async (sessionId, item, onReserved, beforeReserve) => {
      await inputCoordinator.ensureQueueRestored(sessionId);
      if (!inputCoordinator.isQueueRestored(sessionId)) {
        throw new Error(`queue restore incomplete for ${sessionId}`);
      }
      await beforeReserve?.();
      return inputCoordinator.reserveNextInput(sessionId, item, { onReserved }).reserved;
    },
    sendToSessionInternal,
    createDbMessage,
    beginDirectTurnChangeSet: async (sessionId, clientId) => {
      const liveSession = maker.getSession(sessionId);
      if (!liveSession) {
        throw new Error('Target session became unavailable before direct turn dispatch.');
      }
      await beginTurnChangeSetAtDispatch(liveSession, clientId);
    },
    abortDirectTurnChangeSet: clearPendingTurnChangeSets,
    resolveWorkerSenderLabel: async (workerId, fallback) => {
      const link = await getWorkerLink({ workerId });
      if (!link) return fallback;
      const worker = (await listWorkersByLead(link.leadSessionId)).find((w) => w.id === workerId);
      return worker?.role ?? fallback;
    },
    resolveWorkerSessionLink: async (workerId) => {
      const link = await getWorkerLink({ workerId });
      return link ? { leadSessionId: link.leadSessionId, workerSessionId: link.workerSessionId } : null;
    },
    isSessionRunningError,
    log,
  });
  const dispatchOrEnqueueOrcaInterAgentMessage: OrcaInterAgentDispatcher['dispatchOrEnqueueOrcaInterAgentMessage'] =
    async (params) => {
      try {
        await assertReviewExternalInputAllowed(params.targetSessionId);
      } catch (error) {
        return {
          ok: false,
          dispatchOutcome: {
            ...createHostSendFailure(
              'SEND_FAILED',
              error instanceof Error ? error.message : String(error),
            ),
            source: params.meta.source,
            context: params.meta.context,
          },
        };
      }
      return orcaInterAgentDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(params);
    };
  dispatchInterAgentMessageHolder = dispatchOrEnqueueOrcaInterAgentMessage;

  // Agent 选择的排队行插话 / 排序(cindy_orca 与 cindy_helper 共用)。
  const { steerStoredControlMessage, moveStoredControlMessage } = createQueueReorderAdapter({
    getLiveSession: (sessionId) => maker.getSession(sessionId),
    hasSendToSessionLock: (sessionId) => sendToSessionLocks.has(sessionId),
    // inputCoordinator 在本函数更后面才声明,只能在调用时取用。
    getCoordinator: () => inputCoordinator,
  });

  const workerProjectHandlers = createOrcaWorkerProjectHandlers({
    isDeviceLinkInvoke,
    assertTrustedAppRendererEvent,
    getOwner: getCurrentDbClientSnapshot,
    getSession: async (owner, id) => {
      const [session] = await owner.client.drizzle
        .select()
        .from(sessions)
        .where(eq(sessions.id, id))
        .limit(1);
      return session;
    },
    getTeamByWorkerSession,
    readContext: readWorkerProjectContext,
    probe: probeWorkerProject,
    remember: rememberWorkerProject,
    log,
  });

  ipcMain.handle(
    MAKER_INVOKE.SESSION_ENABLE_ORCA,
    async (_e, leadSessionId: unknown, opts: unknown) => {
      if (typeof leadSessionId !== 'string')
        throwIpcError('INVALID_PARAMS', 'leadSessionId required');
      const body = (opts ?? {}) as {
        workerAgent?: unknown;
        delegateTask?: unknown;
        role?: unknown;
        label?: unknown;
        model?: unknown;
        effort?: unknown;
        fast?: unknown;
        providerId?: unknown;
        workerPermissionMode?: unknown;
        deferDelegateTask?: unknown;
        executionDeviceId?: unknown;
        workingDir?: unknown;
        worktree?: unknown;
        projectPath?: unknown;
        agentDeviceId?: unknown;
      };
      const workerAgent: AgentKind =
        body.workerAgent === 'codex' ? 'codex' : body.workerAgent === 'pi' ? 'pi' : 'claude-code';
      const delegateTask = typeof body.delegateTask === 'string' ? body.delegateTask : undefined;
      if (
        body.workerPermissionMode !== undefined &&
        !isOrcaWorkerPermissionMode(body.workerPermissionMode)
      ) {
        throwIpcError('INVALID_PARAMS', 'workerPermissionMode must be auto or bypassPermissions');
      }
      if (body.deferDelegateTask !== undefined && typeof body.deferDelegateTask !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'deferDelegateTask must be a boolean');
      }
      const project = await workerProjectHandlers.options(_e, leadSessionId, body);
      const result = await enableOrcaInternal(leadSessionId, {
        ...project.fields,
        workerAgent,
        delegateTask,
        role: typeof body.role === 'string' ? body.role : undefined,
        label: typeof body.label === 'string' ? body.label : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        effort: typeof body.effort === 'string' ? (body.effort as OrcaWorkerEffort) : undefined,
        fast: (typeof body.fast === 'boolean' || body.fast === 'ultrafast') ? body.fast : undefined,
        // 只认非空(trim 后)string 为显式来源;其余(null/空白/缺省/异型)一律按「未显式」处理。
        providerId:
          typeof body.providerId === 'string' && body.providerId.trim().length > 0
            ? body.providerId.trim()
            : undefined,
        workerPermissionMode: body.workerPermissionMode,
        deferDelegateTask: body.deferDelegateTask,
        // 运行设备与那台上的目录(可选)；旧控制端不带，行为不变。
        ...(typeof body.executionDeviceId === 'string' && body.executionDeviceId.trim()
          ? {
              executionDeviceId: body.executionDeviceId.trim(),
              ...(typeof body.workingDir === 'string' && body.workingDir.trim()
                ? { workingDir: body.workingDir.trim() }
                : {}),
            }
          : {}),
        // 首个 Worker 的 Agent 所在位置(远程供应商)；旧控制端不带 = 跟 Lead。
        ...pickWorkerAgentDeviceId(body.agentDeviceId),
      });
      await project.remember();
      return result;
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.WORKER_DISPATCH_UI_ASSIGNMENT,
    async (
      _e,
      leadSessionId: unknown,
      workerSessionId: unknown,
      initialTask: unknown,
      snapshotBeforeMs: unknown,
      waitForLeadHistory: unknown,
    ) => {
      if (typeof leadSessionId !== 'string' || leadSessionId.length === 0) {
        throwIpcError('INVALID_PARAMS', 'leadSessionId required');
      }
      if (typeof workerSessionId !== 'string' || workerSessionId.length === 0) {
        throwIpcError('INVALID_PARAMS', 'workerSessionId required');
      }
      if (typeof initialTask !== 'string' || initialTask.trim().length === 0) {
        throwIpcError('INVALID_PARAMS', 'initialTask required');
      }
      if (
        typeof snapshotBeforeMs !== 'number' ||
        !Number.isFinite(snapshotBeforeMs) ||
        snapshotBeforeMs < 0
      ) {
        throwIpcError('INVALID_PARAMS', 'snapshotBeforeMs must be a non-negative number');
      }
      if (typeof waitForLeadHistory !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'waitForLeadHistory must be a boolean');
      }
      const { assertCurrent } = await captureOrcaPluginAuthority(leadSessionId);
      if (waitForLeadHistory) {
        const queryable = await orcaUiAssignmentHistoryGate.waitUntilQueryable(
          leadSessionId,
          snapshotBeforeMs,
        );
        if (!queryable) {
          throwIpcError(
            'PRECONDITION_FAILED',
            'Lead input was not queryable before the UI assignment deadline',
          );
        }
      }
      return orcaUiAssignmentDispatchClaims.runOnce(
        { leadSessionId, workerSessionId, snapshotBeforeMs },
        async () => {
          const result = await orcaTeamService.sendToWorker({
            callerLeadSessionId: leadSessionId,
            targetSessionId: workerSessionId,
            // 远端 Worker 在另一台电脑，没有读取 Lead 历史的 Worker 桥，只发任务原文。
            message: orcaRemoteWorkersForHost?.runtime.isRemote(workerSessionId)
              ? initialTask.trim()
              : buildUiAssignmentInitialTask({
                  leadSessionId,
                  initialTask: initialTask.trim(),
                  snapshotBeforeMs,
                }),
          }, assertCurrent);
          if (!result.ok) throwOrcaServiceFailure(result);
          return result;
        },
      );
    },
  );

  /**
   * clearLeadOrcaRoleState — 把一个 Lead session 的协同身份彻底清干净:DB orca_role=null
   * (setSessionOrcaRole 会同时广播 { orcaRole: null } patch,renderer 的 collabEnabled 翻 false)、
   * 清 knownNonOrca cache、在线时清空 vendorOptions。抽出来给 disableOrcaInternal 的「正常关闭」
   * 和「悬空 lead 兜底」两条路径共用,避免两份漂移。
   */
  async function clearLeadOrcaRoleState(leadSessionId: string, assertCurrent?: () => Promise<void>): Promise<void> {
    await assertCurrent?.();
    await setSessionOrcaRole(leadSessionId, null);
    knownNonOrcaSessionIds.delete(leadSessionId);

    const leadSess = maker.getSession(leadSessionId);
    if (leadSess) {
      await assertCurrent?.();
      try {
        await leadSess.setVendorOptions({
          orcaRole: null,
          orcaWorkflowId: null,
          orcaLeadSessionId: null,
          initialWorker: null,
        });
      } catch (err) {
        log.warn('disableOrca: setVendorOptions on alive Lead failed', {
          leadSessionId,
          err: err instanceof Error ? err.message : String(err),
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
  async function disableOrcaInternal(leadSessionId: string, assertCurrent?: () => Promise<void>): Promise<{ ok: true }> {
    const team = await getActiveTeamByLead(leadSessionId);
    await assertCurrent?.();
    if (!team) {
      // 没有 active team —— 但 Lead 的 orca_role 可能因为上一次关闭被中途打断而悬空成 'lead'
      // (markTeamEnded / markWorkersStatusByTeam / archiveWorkersByTeam 已落库,setSessionOrcaRole(null)
      // 还没落库就退出 / 崩溃)。renderer 的 collabEnabled 只看 orca_role,会把会话永久困在空
      // split view;若这里继续无条件 no-op,再点 X 关闭也救不回来 —— 修复逻辑被门在「必须有
      // active team」之后,坏态自锁。所以这里做幂等兜底:仍是 stranded lead 就把角色清掉,
      // 让「关闭协同」成为可靠的逃生口。
      const role = await getSessionOrcaRole(leadSessionId);
      await assertCurrent?.();
      if (role === 'lead') {
        log.warn('disableOrca: no active team but lead orca_role stranded; reconciling', {
          leadSessionId,
        });
        // 上一次关闭若在 archiveWorkersByTeam 之前被打断,team 已非 active 但 worker session 还停在
        // active + hidden + unreachable —— 一并补齐归档,否则它们会成为永远触达不到的孤儿 worker。
        const workerRecycleScope = captureSessionRecycleScope();
        const orphanedWorkerSessionIds = await reconcileInactiveTeamWorkersForLead(leadSessionId, assertCurrent);
        for (const sid of orphanedWorkerSessionIds) {
          await assertCurrent?.();
          await recycleSessionWorktreeForStatusChange(sid, 'archived', workerRecycleScope);
          await assertCurrent?.();
          cleanupPendingInteractionsForSession(sid, 'orca_disable');
          forgetKnownOrcaWorkerSession(sid);
        }
        if (orphanedWorkerSessionIds.length > 0) {
          log.warn('disableOrca: archived orphaned workers from non-active team(s)', {
            leadSessionId,
            count: orphanedWorkerSessionIds.length,
          });
        }
        await clearLeadOrcaRoleState(leadSessionId, assertCurrent);
      } else {
        log.info('disableOrca: no active team, no-op', { leadSessionId });
      }
      return { ok: true };
    }

    const workers = await listWorkersByLead(leadSessionId);
    const activeWorkers = workers.filter((w) => w.teamId === team.id);
    // 先取消尚未落地的后台预热：关闭流程不等待 sendToSession 锁，若不取消，等锁中或
    // 冷启动中的 resume 会在归档之后把 worker 重新拉活（review P1）。
    for (const w of workers) {
      orcaWorkerResumeScheduler.cancel(w.sessionId);
    }
    for (const w of activeWorkers) {
      await assertCurrent?.();
      orcaTeamService.clearAutoBridgeState(w.sessionId);
      await assertCurrent?.();
      const sess = maker.getSession(w.sessionId);
      if (sess) {
        try {
          if (sess.isTurnRunning?.()) {
            await sess.abort();
          }
        } catch (err) {
          log.warn('disableOrca: abort failed (continuing to close)', {
            sessionId: w.sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
        await assertCurrent?.();
        try {
          await maker.closeSession(w.sessionId);
        } catch (err) {
          log.warn('disableOrca: closeSession failed', {
            sessionId: w.sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await assertCurrent?.();
      cleanupPendingInteractionsForSession(w.sessionId, 'orca_disable');
      forgetKnownOrcaWorkerSession(w.sessionId);
    }

    await assertCurrent?.();
    await markTeamEnded(team.id, 'completed');
    await assertCurrent?.();
    await markWorkersStatusByTeam(team.id, 'done');
    await assertCurrent?.();
    const workerRecycleScope = captureSessionRecycleScope();
    const archivedWorkerSessionIds = await archiveWorkersByTeam(team.id, assertCurrent);
    // 远端 Worker：停止那台的当前一轮并通知结束协同(任务与文件保留)；不可达的留待重连后补发。
    void orcaRemoteWorkers.releaseEnded(archivedWorkerSessionIds);
    await Promise.all(
      archivedWorkerSessionIds.map(async (sessionId) => {
        await assertCurrent?.();
        await recycleSessionWorktreeForStatusChange(sessionId, 'archived', workerRecycleScope);
      }),
    );

    await clearLeadOrcaRoleState(leadSessionId, assertCurrent);

    log.info('disableOrca done', {
      leadSessionId,
      teamId: team.id,
      archivedCount: activeWorkers.length,
    });
    return { ok: true };
  }

  ipcMain.handle(MAKER_INVOKE.SESSION_DISABLE_ORCA, async (_e, leadSessionId: unknown) => {
    if (typeof leadSessionId !== 'string')
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    return disableOrcaInternal(leadSessionId);
  });

  // Local-only reads: intentionally absent from the device-link allowlist.
  ipcMain.handle('maker:worker:project-context', workerProjectHandlers.context);
  ipcMain.handle('maker:worker:project-label', workerProjectHandlers.label);

  // ─── Orca worker IPC handlers ────────────────────────────────────────────

  ipcMain.handle(MAKER_INVOKE.WORKER_CREATE, async (_e, body: unknown) => {
    const b = body as Record<string, unknown> | null | undefined;
    if (!b || typeof b.leadSessionId !== 'string')
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    if (typeof b.role !== 'string' || b.role.length < 1 || b.role.length > 32)
      throwIpcError('INVALID_PARAMS', 'role must be 1-32 chars');
    if (typeof b.label !== 'string') throwIpcError('INVALID_PARAMS', 'label required');
    const label = normalizeOrcaWorkerLabel(b.label);
    if (!label.ok) throwIpcError('INVALID_PARAMS', label.message);
    const agent =
      b.agent === 'codex'
        ? ('codex' as const)
        : b.agent === 'pi'
          ? ('pi' as const)
          : ('claude-code' as const);
    const model = typeof b.model === 'string' && b.model.length > 0 ? b.model : undefined;
    if (
      b.workerPermissionMode !== undefined &&
      !isOrcaWorkerPermissionMode(b.workerPermissionMode)
    ) {
      throwIpcError('INVALID_PARAMS', 'workerPermissionMode must be auto or bypassPermissions');
    }
    const project = await workerProjectHandlers.options(_e, b.leadSessionId, b);
    await assertLeadCollabProjectEnabled(b.leadSessionId);
    const result = await orcaLifecycleService.createWorker({
      ...project.fields,
      leadSessionId: b.leadSessionId,
      role: b.role,
      agent,
      model,
      effort: typeof b.effort === 'string' ? (b.effort as OrcaWorkerEffort) : undefined,
      fast: (typeof b.fast === 'boolean' || b.fast === 'ultrafast') ? b.fast : undefined,
      // 只认非空(trim 后)string 为显式来源;其余(null/空白/缺省/异型)一律按「未显式」处理。
      providerId:
        typeof b.providerId === 'string' && b.providerId.trim().length > 0
          ? b.providerId.trim()
          : undefined,
      workerPermissionMode: b.workerPermissionMode,
      label: label.value,
      initialTask:
        typeof b.initialTask === 'string' && b.initialTask.length > 0 ? b.initialTask : undefined,
      // 运行设备与那台上的目录(可选)；旧控制端不带，行为不变。
      ...(typeof b.executionDeviceId === 'string' && b.executionDeviceId.trim()
        ? {
            executionDeviceId: b.executionDeviceId.trim(),
            ...(typeof b.workingDir === 'string' && b.workingDir.trim()
              ? { workingDir: b.workingDir.trim() }
              : {}),
          }
        : {}),
      // Worker 的 Agent 所在位置(远程供应商)；旧控制端不带 = 跟 Lead。
      ...pickWorkerAgentDeviceId(b.agentDeviceId),
    });
    if (!result.ok) throwOrcaServiceFailure(result);
    await project.remember();
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
    if (typeof leadSessionId !== 'string')
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    return listWorkersByLead(leadSessionId);
  });

  ipcMain.handle(MAKER_INVOKE.WORKER_SWITCH_FOCUS, async (_e, body: unknown) => {
    const b = body as Record<string, unknown> | null | undefined;
    if (!b || typeof b.leadSessionId !== 'string')
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    if (typeof b.workerIdOrLabel !== 'string')
      throwIpcError('INVALID_PARAMS', 'workerIdOrLabel required');

    const workers = await listWorkersByLead(b.leadSessionId);
    const target = findFocusTargetWorker(workers, b.workerIdOrLabel);
    if (!target) throwIpcError('WORKER_NOT_FOUND', `no worker matching "${b.workerIdOrLabel}"`);

    // focused 切换: clear 旧 + set 新, 原子化 (review F4)
    await setWorkerFocus(target.teamId, target.id);

    // idle worker → 后台预热 runtime(发送/派活时需要),但 focus 切换不等待冷启动:
    // worker 历史来自 DB,切换立即生效;resume 失败只告警,不影响 focus 结果。
    if (target.status === 'idle') {
      orcaWorkerResumeScheduler.requestInBackground(target, (err) => {
        log.warn('switchFocus: resume failed', {
          workerId: target.id,
          sessionId: target.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }

    broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, {
      leadSessionId: b.leadSessionId as string,
    });
    return { ok: true, workerId: target.id };
  });

  registerOrcaWorkerControlHandlers(createElectronIpcHandlerRegistry(), {
    idleWorker: (params) => orcaTeamService.idleWorker(params),
    archiveWorker: (params) => orcaTeamService.archiveWorker(params),
    logInfo: (message, fields) => log.info(message, fields),
  });

  ipcMain.handle(MAKER_INVOKE.TEAM_END, async (_e, leadSessionId: unknown) => {
    if (typeof leadSessionId !== 'string')
      throwIpcError('INVALID_PARAMS', 'leadSessionId required');
    const result = await disableOrcaInternal(leadSessionId);
    broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, {
      leadSessionId: leadSessionId as string,
    });
    return result;
  });

  const hasPendingIdleReleaseInput = async (sessionId: string): Promise<boolean> => {
    await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
    // A failed restore is itself a pending condition: never close a worker while
    // its durable follow-up snapshot is still unavailable.
    if (!inputCoordinator.isQueueRestored(sessionId)) return true;
    return (
      inputCoordinator.hasPendingQueuedWork(sessionId) ||
      inputCoordinator.hasQueuedItemWhere(sessionId, () => true, { includeRecovery: true })
    );
  };

  // 协同远端 Worker：Worker 在同账号另一台电脑运行(见 orcaRemoteWorkers.ts)。
  // 其代理任务行永不在本机跑 Agent，团队服务的会话依赖按是否远端分流。
  const orcaRemoteWorkers = createOrcaRemoteWorkers({
    getOwnerToken: getCurrentDbClientSnapshot,
    remoteInvoke: (deviceId, channel, args) => invokeBotPeer(deviceId, channel, args),
    listDevices: () => handleListDevices(deviceDirectoryDeps()),
    getTeamService: () => orcaTeamServiceForEvents,
    broadcastOrcaWorkerChanged: (leadSessionId) => {
      broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
    },
    readLeadTitle: async (leadSessionId) => {
      const [row] = await getDbClient()
        .drizzle.select({ title: sessions.title })
        .from(sessions)
        .where(eq(sessions.id, leadSessionId))
        .limit(1);
      return row?.title ?? '';
    },
    log,
  });
  orcaRemoteWorkersForHost = orcaRemoteWorkers;
  setRemoteWorkerStatusProvider((proxySessionId, deviceId) => ({
    deviceName: orcaRemoteWorkers.deviceName(deviceId),
    reachable: orcaRemoteWorkers.runtime.isReachable(proxySessionId),
    ...(orcaRemoteWorkers.runtime.workingDir(proxySessionId)
      ? { workingDir: orcaRemoteWorkers.runtime.workingDir(proxySessionId)! }
      : {}),
  }));

  const orcaTeamService = createOrcaTeamService(orcaRemoteWorkers.wrapTeamDeps({
    isWorkerLabelLockedByPlan: async ({ leadSessionId, labels }) => {
      const receipt = await createPluginTaskStore(getDbClient()).get(leadSessionId);
      const plan = receipt ? readPluginTaskPlanReceipt(receipt.payload).teamPlan : undefined;
      return plan?.items.some(item => labels.includes(item.label)) ?? false;
    },
    captureControlAuthority: async (leadSessionId) => (await captureOrcaPluginAuthority(leadSessionId)).assertCurrent,
    captureDeliveryAuthority: async (leadSessionId) => {
      const epoch = getCurrentDbClientSnapshot();
      if (!epoch) throw new PluginTaskError('HOST_NOT_READY', 'Task storage unavailable', true);
      const readSessionRow = async () => {
        const [row] = await epoch.client.drizzle.select({
          status: sessions.status, clearedAt: sessions.clearedAt,
          permissionMode: sessions.permissionMode, planModeEnabled: sessions.planModeEnabled,
        }).from(sessions).where(eq(sessions.id, leadSessionId)).limit(1);
        return row ?? null;
      };
      const row = await readSessionRow();
      if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
      const baselines = captureOrcaDeliveryBaselines({ row, live: maker.getSession(leadSessionId) ?? null });
      return async () => {
        if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
        if (isAppSessionBoundaryPending()) throw new PluginTaskError('HOST_NOT_READY', 'Account is switching');
        const current = await readSessionRow();
        if (epoch !== getCurrentDbClientSnapshot()) throw new PluginTaskError('PERMISSION_DENIED', 'Account changed');
        const verdict = evaluateOrcaDeliveryScope({
          ...baselines, row: current, live: maker.getSession(leadSessionId) ?? null,
        });
        if (verdict !== 'ok') throw new PluginTaskError('PERMISSION_DENIED', `Orca delivery revoked: ${verdict}`);
      };
    },
    withSessionSendLock: withSendToSessionLock,
    getWorkerLinkBySessionId: (workerSessionId) => getWorkerLink({ workerSessionId }),
    getWorkerLinkByWorkerId: (workerId) => getWorkerLink({ workerId }),
    listWorkersByLead,
    getLiveSession: (sessionId) => maker.getSession(sessionId) ?? null,
    resumeWorkerSession: async (target) => {
      // 与 focus 后台预热共享同一套去重/锁:派活不会和切换触发两次 bootstrap。
      await orcaWorkerResumeScheduler.request(target);
    },
    // 归档 / 显式 idle 会释放 runtime；先取消未落地的后台预热，避免释放后被重新拉起。
    cancelWorkerResume: (sessionId) => orcaWorkerResumeScheduler.cancel(sessionId),
    updateWorkerStatus,
    updateWorkerIdentity,
    markWorkerIdle: (...args) => markWorkerIdle(...args),
    markWorkerIdleIfStatus,
    restoreWorkerDoneIfIdle,
    closeWorkerSession: async (sessionId, beforeClose) => {
      const sess = maker.getSession(sessionId);
      await beforeClose?.();
      if (sess) {
        await sess.abort();
      }
      await beforeClose?.();
      await maker.closeSession(sessionId);
    },
    closeWorkerSessionIfIdle: async (sessionId, sendLockHeld = false) => {
      if (!sendLockHeld && sendToSessionLocks.has(sessionId)) return false;
      const sess = maker.getSession(sessionId);
      return sess ? sess.closeIfIdle() : true;
    },
    hasPendingWorkerInput: async (sessionId) => {
      await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
      // A failed restore is itself a pending condition: never close a worker while
      // its durable follow-up snapshot is still unavailable.
      if (!inputCoordinator.isQueueRestored(sessionId)) return true;
      return (
        inputCoordinator.hasPendingQueuedWork(sessionId) ||
        inputCoordinator.hasQueuedItemWhere(sessionId, () => true, { includeRecovery: true })
      );
    },
    hasSendToSessionLock: (sessionId) => sendToSessionLocks.has(sessionId),
    archiveWorkerSession: async (sessionId, beforeMutation) => {
      const workerRecycleScope = captureSessionRecycleScope();
      await archiveSingleWorkerSession(sessionId, beforeMutation);
      await beforeMutation?.();
      // 与普通归档(patchSessionMetaInDb)一致:status 落库即回执,回收(quiesce + git worktree
      // remove + 文件清理)放后台,不让手机/桌面的归档回执等它。调用方(IPC / MCP archive_worker /
      // 插件 releaseWorker)都不依赖回收已完成;回收在队列里按 captured scope 自行复核仍可删。
      // 插件 releaseWorker 在持有该 session send 锁时调到这里,而回收要拿同一把 route 锁——
      // 若在此 await 会自等到锁 watchdog bail,后台调度同时消除了这处自锁。
      scheduleWorktreeRecycleForStatusChange(sessionId, 'archived', workerRecycleScope);
    },
    getManualInterrupt,
    clearManualInterrupt,
    restoreManualInterrupt,
    forgetWorkerSession: forgetKnownOrcaWorkerSession,
    broadcastOrcaWorkerChanged: (leadSessionId) => {
      broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
    },
    onLeadWorkerReportsSettled: (leadSessionId) => {
      // A delivered report starts the next Lead turn, whose own terminal decides
      // completion. Only an idle Lead replays the completion Agent Island deferred.
      if (
        isSessionTurnDispatchBoundaryBusy(
          sessionTurnActivityTracker,
          leadSessionId,
          maker.getSession(leadSessionId),
        )
      ) {
        return;
      }
      getAgentIslandService()?.notifyQueueEmptied(leadSessionId);
    },
    dispatchWorkerMessage: async ({
      targetSessionId,
      message,
      workerId,
      delivery,
      imagePaths,
      dispatchMeta,
      onAccepted,
      onAcceptedRollback,
      onAcceptedCommit,
    }) => {
      const result = await dispatchOrEnqueueOrcaInterAgentMessage({
        targetSessionId,
        rawContent: message,
        source: 'lead',
        senderLabel: 'Lead',
        workerId,
        ...(delivery ? { delivery } : {}),
        ...(imagePaths ? { imagePaths } : {}),
        meta: dispatchMeta,
        onAccepted,
        onAcceptedRollback,
        onAcceptedCommit,
      });
      if (!result.ok) {
        return { ok: false, dispatchOutcome: result.dispatchOutcome };
      }
      return {
        ok: true,
        mode: result.mode,
        clientId: result.clientId,
        ...(result.agentKind ? { agentKind: result.agentKind } : {}),
        dispatchOutcome: result.dispatchOutcome,
        targetTitle: result.targetTitle ?? null,
        targetLastUserSendAt: result.targetLastUserSendAt ?? null,
        ...(result.steerFallbackReason ? { steerFallbackReason: result.steerFallbackReason } : {}),
      };
    },
    reserveWorkerMessage: async ({
      targetSessionId,
      message,
      workerId,
      dispatchMeta,
      beforeReserve,
      onReserved,
      onAccepted,
      onAcceptedRollback,
      onAcceptedCommit,
    }) => {
      const result = await orcaInterAgentDispatcher.reserveNextOrcaInterAgentMessage({
        targetSessionId,
        rawContent: message,
        source: 'lead',
        senderLabel: 'Lead',
        workerId,
        meta: dispatchMeta,
        beforeReserve,
        onReserved,
        onAccepted,
        onAcceptedRollback,
        onAcceptedCommit,
      });
      if (!result.ok) return { ok: false, dispatchOutcome: result.dispatchOutcome };
      return {
        ok: true,
        mode: result.mode,
        clientId: result.clientId,
        dispatchOutcome: result.dispatchOutcome,
        targetTitle: result.targetTitle ?? null,
        targetLastUserSendAt: result.targetLastUserSendAt ?? null,
      };
    },
    requestWorkerInterrupt: async (sessionId) => {
      markManualInterrupt(sessionId, 'lead_interrupt');
      const sess = getStableSessionForTurnBoundary(sessionId);
      if (!sess) {
        return {
          stopOutcome: sessionTurnActivityTracker.isSessionTurnDispatchBoundaryBusy(sessionId)
            ? ('unconfirmed' as const)
            : ('no-active-turn' as const),
          queuePaused: inputCoordinator.getProjection(sessionId).queuePaused,
        };
      }
      const result = await sess.requestGracefulStop();
      return {
        stopOutcome: result.status,
        queuePaused: inputCoordinator.getProjection(sessionId).queuePaused,
      };
    },
    getWorkerQueuePaused: (sessionId) => inputCoordinator.isQueuePaused(sessionId),
    getSessionQueueSnapshot: async (sessionId) => {
      // 先补崩溃恢复,保证重启后 lead 仍能看到快照恢复出的排队消息。
      await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
      const snapshot = inputCoordinator.getQueueControlSnapshot(sessionId);
      const inspection = inputCoordinator.getQueueInspection(sessionId);
      return {
        pendingQueue: snapshot.pendingQueue,
        steeringClientIds: snapshot.steeringQueueClientIds,
        consumingClientIds: inspection
          .filter((entry) => entry.consuming)
          .map((entry) => entry.queuedMessageId),
        inspectionMessages: inspection.map((entry) => ({
          queuedMessageId: entry.queuedMessageId,
          position: entry.position,
          source:
            entry.source === 'orca'
              ? ('lead' as const)
              : entry.source === 'scheduler'
                ? ('scheduler' as const)
                : ('user' as const),
          content: entry.content,
          consuming: entry.consuming,
        })),
        isWorking: isSessionTurnDispatchBoundaryBusy(
          sessionTurnActivityTracker,
          sessionId,
          getStableSessionForTurnBoundary(sessionId),
        ),
        willQueue:
          inputCoordinator.shouldQueueNewTurn(sessionId) || sendToSessionLocks.has(sessionId),
        queuePaused: inputCoordinator.getProjection(sessionId).queuePaused,
      };
    },
    ensureWorkerQueueRestored: async (sessionId) => {
      await inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
      return inputCoordinator.isQueueRestored(sessionId);
    },
    removeQueuedMessage: (sessionId, clientId, expected) => {
      if (!inputCoordinator.hasQueuedItemWhere(sessionId, (item) => item.clientId === clientId && (!expected || item === expected))) {
        return false;
      }
      // remove 内部对 steering 条目静默拒绝,以移除后的队列状态为准判定成败。
      inputCoordinator.remove(sessionId, clientId);
      return !inputCoordinator.hasQueuedItemWhere(sessionId, (item) => item.clientId === clientId);
    },
    replaceQueuedMessage: (sessionId, clientId, next, expected) =>
      (!expected || inputCoordinator.hasQueuedItemWhere(sessionId, item => item === expected))
      && inputCoordinator.replaceQueuedMessage(sessionId, clientId, next),
    mergeQueuedMessages: (sessionId, clientIds, buildReplacement) =>
      inputCoordinator.mergeQueuedMessagesAtomically(sessionId, clientIds, buildReplacement).merged,
    steerStoredQueuedMessage: steerStoredControlMessage,
    moveQueuedMessage: moveStoredControlMessage,
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
  }));
  orcaTeamServiceForEvents = orcaTeamService;
  // 数据库可能晚于本注册就绪；bootstrap 在接管数据库后会再调一次，两种顺序都覆盖。
  void restoreOrcaRemoteWorkersForCurrentOwner();
  ipcMain.handle(ORCA_EXECUTION_DEVICES_CHANNEL, async (event) => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
    // 共享任务访客看不到本账号的设备目录。
    if (getDeviceLinkInvokeContext()?.sharedTask) throwIpcError('PERMISSION_DENIED', 'not available to shared task guests');
    return { devices: await orcaRemoteWorkers.listExecutionDevices() };
  });

  /**
   * Lead 的 list_available_models 给出的 Worker Agent 位置(远程供应商)：同账号在线、开了远程控制的
   * 电脑，以及收到的、未暂停的分享。只列位置不读目录；那台没开放供应商时按位置再列模型会是空的。
   * 分享不写分享者的电脑名(provider-sharing.md §6)，写「供应商 · 分享者」。
   */
  async function listWorkerAgentLocations(): Promise<Array<{ agentDeviceId: string; name: string }>> {
    const { devices } = await handleListDevices(deviceDirectoryDeps()).catch(() => ({ devices: [] }));
    const shares = getReceivedShares().filter((share) => share.status === 'active');
    return [
      ...devices
        .filter(isExecutionDeviceCandidate)
        .map((device) => ({ agentDeviceId: device.deviceId, name: device.name || device.deviceId })),
      ...shares.flatMap((share) => {
        try {
          return [{
            agentDeviceId: providerShareAgentDeviceId(share.shareId),
            name: `${share.providerLabel} · ${share.owner.displayName}`,
          }];
        } catch {
          return [];
        }
      }),
    ];
  }

  const getProviderRoutingContext = () =>
    readOrcaWorkerProviderRoutingContext({
      providerService: getDesktopProviderService(),
      getCatalog: getActiveCatalog,
    });

  const { assertPluginWorkerAutoAuthorized, captureOrcaPluginAuthority, validateCreationPlan } = createOrcaPluginAuthority({
    getCurrentDbClientSnapshot, getAcceptedInputProvenance: id => inputCoordinator.getAcceptedInputProvenance(id),
    getSession: id => maker.getSession(id), createPluginTaskStore,
    pluginTaskServiceForCurrentOwner: () => pluginTaskServiceForCurrentOwner!(),
    readPluginTaskConfig, isPluginTaskAuthorized, resolvePluginWorkerDirectory,
    readPluginTaskPlanReceipt, isGhostPickedDir, getSelfDeviceId, readSessionAgentDeviceId,
  });

  async function discardWorkerWorktree(sessionId: string): Promise<void> {
    await withSendToSessionLock(sessionId, async () => {
      await worktreeManager.awaitBackgroundCheckout(sessionId);
      const meta = worktreeManager.getForSession(sessionId);
      const result = await worktreeManager.cancelPrecreatedWorktree(
        sessionId,
        { path: meta?.path },
        {
          canRemove: async () => {
            if (maker.getSession(sessionId)) return false;
            const [row] = await getDbClient()
              .drizzle.select({ status: sessions.status })
              .from(sessions)
              .where(eq(sessions.id, sessionId))
              .limit(1);
            return !row || row.status === 'archived';
          },
        },
      );
      if (result.status === 'preserved' || result.status === 'path-mismatch') {
        log.warn('Failed Worker worktree was preserved', { sessionId, status: result.status });
      }
    });
  }

  const orcaWorkerCreationService = createOrcaWorkerCreationService({
    withLeadSendLock: withSendToSessionLock,
    getActiveTeamByLead,
    listWorkersByLead,
    isActiveWorkerStatus,
    readCollaborationSettings,
    validateCreationPlan,
    getLeadSessionRow: async (leadSessionId) => {
      const db = getDbClient().drizzle;
      const [leadRow] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, leadSessionId))
        .limit(1);
      if (!leadRow) return null;
      return {
        ...readLeadProviderGroupEntry(leadRow.id, leadRow.remoteHostId),
        id: leadRow.id,
        // 走转换正本:pi lead 不能被压成 claude-code,否则 input.agent===lead.agentKind
        // 判等失效,pi-lead 建 pi-worker 会走错默认分支(见 orcaWorkerCreationService)。
        agentKind: dbToMakerAgentKind(leadRow.agentKind),
        workspaceKind: leadRow.workspaceKind,
        workingDir: leadRow.workingDir,
        model: leadRow.model,
        effort: leadRow.effort,
        permissionMode: leadRow.permissionMode,
        fastMode: (leadRow.fastMode ?? false),
        providerId: leadRow.providerId ?? null,
        remoteHostId: leadRow.remoteHostId ?? null,
        ...(leadRow.agentDeviceId && !leadRow.remoteHostId ? { agentDeviceId: leadRow.agentDeviceId } : {}),
      };
    },
    getWorkerDefaults: getWorkerDefaultsFromNewMaker,
    getWorkerPermissionMode: getWorkerPermissionModeFromCreationPrefs,
    resolveWorkerWorkingDir: async (dir, lead) => {
      let resolved: string;
      if (lead.remoteHostId) {
        resolved = await probeRemoteWorkingDirectory(lead.remoteHostId, dir);
      } else {
        resolved = await realpathWorkingDirectory(dir);
        if (!(await statWorkingDirectory(resolved)).isDirectory()) throw new Error('Not a directory');
      }
      assertCollabProjectEnabled(
        { ...lead, workingDir: resolved, workspaceKind: 'project' },
        (pluginId, workingDir) => getPluginRegistry().isEnabled(pluginId, workingDir),
        () => false,
      );
      return resolved;
    },
    resolveWorkerWorktreeSource,
    getWorkerWorktree: getWorkerOwnedWorktree,
    createWorkerWorktree,
    discardWorkerWorktree,
    getAvailableModels: (agent) => maker.getCapabilities(agent).availableModels,
    getProviderRoutingContext: async (agent, remoteHostId, agentDeviceId) => agentDeviceId && !remoteHostId
      // Worker 的 Agent 在另一台电脑(或分享)运行：模型与来源按那台的目录。
      ? deviceWorkerRoutingContext(await readDeviceProviderViews(remoteBackgroundInvoke, agentDeviceId), agent ?? 'claude-code')
      : agent === 'codex' && remoteHostId
        ? sshCodexWorkerRoutingContext(await readSshCodexModelList({ id: remoteHostId }, listSshCodexProviders))
        : getProviderRoutingContext(),
    isSelfDeviceId: (deviceId) => deviceId === getSelfDeviceId(),
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
    openRemoteWorker: (input) => orcaRemoteWorkers.openRemoteWorker(input),
    recordRemoteWorker: (input) => orcaRemoteWorkers.recordRemoteWorker(input),
    discardRemoteWorker: (input) => orcaRemoteWorkers.discardRemoteWorker(input),
  });

  const orcaUiAssignmentHistoryGate = createOrcaUiAssignmentHistoryGate({
    hasUserMessageSince: async (leadSessionId, snapshotBeforeMs) => {
      const page = await getMessagesForHistory({
        sessionIds: [leadSessionId],
        workdir: null,
        fromMs: snapshotBeforeMs,
        toMs: null,
        agentKind: null,
        roles: ['user'],
        includeRewound: false,
        limit: 1,
        cursor: null,
        order: 'asc',
      });
      return page.items.length > 0;
    },
  });
  const orcaUiAssignmentDispatchClaims = createOrcaUiAssignmentDispatchClaims();

  const orcaLifecycleService = createOrcaLifecycleService({
    getActiveTeamByLead,
    isOrphanedTeamInit,
    createActiveTeam: async (leadSessionId) => createActiveTeam({ leadSessionId }),
    getWorkerPermissionMode: getWorkerPermissionModeFromCreationPrefs,
    getWorkerPermissionModeOverride: async (leadSessionId) => {
      return captureOrcaPluginAuthority(leadSessionId);
    },
    setWorkerPermissionMode: applyWorkerPermissionModePreference,
    createWorkerInTeam: (params, assertCurrent, onCreated) => orcaWorkerCreationService.createWorkerInTeam(params, assertCurrent, onCreated),
    dispatchWorkerTask: (params, assertCurrent) => orcaTeamService.dispatchWorkerTask(params, assertCurrent),
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
          ? { initialWorker: { workerId, sessionId: workerSessionId } }
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
    sendWorkerReadyPlaceholder: async ({ workerSessionId, agentKind, entrypoint, context }, assertCurrent) => {
      // 远端 Worker 的任务在运行设备上已建好并启动，无需本机占位消息。
      if (orcaRemoteWorkers.runtime.isRemote(workerSessionId)) return;
      const workerSession = maker.getSession(workerSessionId);
      if (!workerSession) {
        throw new Error(`worker session ${workerSessionId} not found for ready placeholder`);
      }
      const sendResult = await workerSession.send(
        { type: 'user', content: ORCA_WORKER_READY_MESSAGE },
        {
          planMode: false,
          throwOnStartFailure: true,
          onAccepted: async () => {
            try {
              await assertCurrent?.();
            } catch (err) {
              throw new AcceptedCallbackDispatchCancelled(err instanceof Error ? err.message : String(err));
            }
          },
        },
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
      if (await orcaRemoteWorkers.rollbackCreatedWorker(workerSessionId)) return;
      const workerSession = maker.getSession(workerSessionId);
      if (workerSession) {
        await maker.closeSession(workerSessionId).catch(() => undefined);
      }
      forgetKnownOrcaWorkerSession(workerSessionId);
      await archiveSingleWorkerSession(workerSessionId).catch(() => undefined);
      try {
        await removeWorker(workerId);
      } finally {
        if (worktreeManager.getForSession(workerSessionId)) await discardWorkerWorktree(workerSessionId);
      }
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
    listCandidates: (...args) => listIdleReleaseCandidates(...args),
    getSession: (sessionId) => maker.getSession(sessionId) ?? null,
    withSessionLock: withSendToSessionLock,
    hasPendingInput: hasPendingIdleReleaseInput,
    markReleased: (...args) => markIdleReleased(...args),
    touchWorker: (...args) => touchWorker(...args),
    closeSession: (sessionId) => maker.closeSession(sessionId),
    broadcastWorkerChanged: (leadSessionId) => {
      broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
    },
    now: Date.now,
    timer: { setInterval, clearInterval },
    log,
  });
  idleReleaseWatcher.start();

  let applySessionRuntimeSelection: (
    sessionId: string,
    model: string,
    providerId: string | null | undefined,
    selection: {
      effort: SessionRuntimeProfile['effort'];
      fastMode: boolean | 'ultrafast';
      confirmedContextWindow?: number;
      /** Pi-only：目标模型的思考开关意图；随暂存选择/换窗重试一并回放。 */
      thinking?: boolean;
    },
    options: InternalRuntimeSelectionOptions,
  ) => Promise<{
    deferred: boolean;
    superseded: boolean;
    generation?: number;
    effectiveProviderId?: string | null;
    contextWindowConfirmationRequired?: number;
    contextTokensForConfirmation?: number;
  }> = async () => {
    throw new Error('session runtime selection is not ready');
  };
  const runtimeSelectionRequiresModelWindowConfirmation = (result: {
    contextWindowConfirmationRequired?: number;
    contextTokensForConfirmation?: number;
  }): boolean =>
    result.contextWindowConfirmationRequired !== undefined ||
    result.contextTokensForConfirmation !== undefined;
  const settlingSessionRuntimeControls = new Set<string>();
  const settlePendingSessionRuntimeControl = (sessionId: string, reason: string): void => {
    if (settlingSessionRuntimeControls.has(sessionId)) return;
    const pending = getPendingSessionRuntimeMutation(sessionId);
    if (!pending) return;
    settlingSessionRuntimeControls.add(sessionId);
    void (async () => {
      try {
        const settleSelection = {
          effort: pending.profile.effort,
          fastMode: pending.profile.fastMode,
          ...(pending.thinking !== undefined ? { thinking: pending.thinking } : {}),
        };
        const settleOptions = {
          source: pending.source,
          expectedGeneration: pending.generation,
          applyingPendingGeneration: pending.generation,
          effortExplicit: pending.profile.effort !== null,
          fastExplicit: true,
          routeExplicit: isPendingSessionRuntimeRouteExplicit(sessionId, pending.generation),
        };
        let result = await applySessionRuntimeSelection(
          sessionId,
          pending.profile.model,
          pending.profile.providerId,
          settleSelection,
          settleOptions,
        );
        // 回合中登记的缩窗选择:用户当时已经点过目标模型。空闲结算时若仍要确认换窗,
        // 带着核实窗口再 apply 一次,避免把选择取消掉。
        const windowRetry = nextDeferredModelWindowRetry(
          runtimeSelectionRequiresModelWindowConfirmation(result),
          result.contextWindowConfirmationRequired,
        );
        if (windowRetry.action === 'retry') {
          result = await applySessionRuntimeSelection(
            sessionId,
            pending.profile.model,
            pending.profile.providerId,
            { ...settleSelection, confirmedContextWindow: windowRetry.confirmedContextWindow },
            settleOptions,
          );
          if (nextDeferredModelWindowRetry(
            runtimeSelectionRequiresModelWindowConfirmation(result),
            result.contextWindowConfirmationRequired,
          ).action !== 'done') {
            throw new Error('deferred model-window selection requires unsupported confirmation');
          }
        } else if (windowRetry.action === 'cancel') {
          throw new Error('deferred model-window selection requires unsupported confirmation');
        }
        log.info('pending session runtime settled', {
          sessionId,
          reason,
          generation: pending.generation,
          superseded: result.superseded,
        });
      } catch (error) {
        const cancelled = cancelPendingSessionRuntimeMutation(sessionId, pending.generation);
        log.warn('pending session runtime settlement failed', {
          sessionId,
          reason,
          cancelled,
          error: error instanceof Error ? error.message : String(error),
        });
        if (cancelled) {
          await broadcastSessionRuntimeProjection(sessionId).catch((broadcastError) => {
            log.debug('cancelled pending runtime projection broadcast failed', {
              sessionId,
              error:
                broadcastError instanceof Error ? broadcastError.message : String(broadcastError),
            });
          });
          const failureMessage =
            error instanceof Error && error.message.includes('unsupported')
              ? 'Deferred model switch was cancelled because safe context rebuild is unsupported. The previous model remains active.'
              : 'Deferred model switch was cancelled because it could not be applied safely. The previous model remains active.';
          const failureReason = 'runtime-selection-cancelled';
          onTurnErrorEvent(sessionId, { message: failureMessage, reason: failureReason }, null);
          const dbAgentKind = getSessionDbAgentKind(sessionId);
          const agentSource = dbAgentKind ? dbToMakerAgentKind(dbAgentKind) : undefined;
          broadcastToAllWindows(MAKER_PUSH.EVENT, {
            sessionId,
            event: {
              type: 'error',
              data: { message: failureMessage, reason: failureReason, isTerminal: true },
              ...(agentSource ? { source: agentSource } : {}),
            } satisfies AgentEvent,
          });
        }
      } finally {
        settlingSessionRuntimeControls.delete(sessionId);
        const latest = getPendingSessionRuntimeMutation(sessionId);
        if (latest && latest.generation !== pending.generation) {
          settlePendingSessionRuntimeControl(sessionId, `${reason}:generation-advanced`);
        }
      }
    })();
  };
  settlePendingSessionRuntimeControlHolder = settlePendingSessionRuntimeControl;

  const readSessionRuntimeProfiles = createSessionRuntimeProfiles({ maker, getDbClient, log, getSessionRuntimeControlSnapshot, hasSessionProvider, getSessionProvider, getSessionEffort, getSessionFastMode, agentSwitchPending });

  /**
   * 系统按配置发起的整条路由选择(伙伴模型对齐 / IM 渠道默认跟随): 跨引擎登记切换
   * 意图(应用时带交接), 同引擎按用户选择语义登记; 都不在这里抢占运行中的轮次。
   * 调用方持有 send 锁。
   */
  const stageSessionRouteSelection = async (
    sessionId: string,
    route: SessionRouteSelection,
    currentAgentKind: AgentKind,
  ): Promise<void> => {
    // Legacy callers without a location must not move a remote session implicitly.
    const currentDeviceId = await readSessionAgentDeviceId(sessionId);
    if (route.agentDeviceId === undefined && currentDeviceId) return;
    if (route.agentKind !== currentAgentKind || currentDeviceId !== (route.agentDeviceId ?? null) || currentDeviceId) {
      await performSessionAgentSwitch(agentSwitchDeps, {
        sessionId, targetAgentKind: route.agentKind, model: route.model,
        providerId: route.providerId, effort: route.effort, fastMode: route.fastMode,
        ...(route.agentDeviceId !== undefined ? { agentDeviceId: route.agentDeviceId } : {}),
        configStaged: true,
      });
    } else {
      await applyWithVerifiedModelWindow((confirmedContextWindow) =>
        applySessionRuntimeSelection(sessionId, route.model, route.providerId,
          { effort: route.effort as SessionRuntimeProfile['effort'], fastMode: route.fastMode,
            ...(confirmedContextWindow === undefined ? {} : { confirmedContextWindow }) },
          { source: 'user', deferWhileRunning: true, sessionLockHeld: true, configStaged: true }));
    }
  };
  followMovedCindyAutoRoutesNow = async () => {
    const owner = getActiveAppSession();
    await followMovedCindyAutoRoutes({
      isReady: () => tryGetDbClient() !== null,
      // 远程主机 / 另一台电脑上运行的任务，路由由那一端的目录决定，不在本机改道。
      listCandidates: async () =>
        (
          await getDbClient()
            .drizzle.select({
              sessionId: sessions.id,
              agentKind: sessions.agentKind,
              model: sessions.model,
              providerId: sessions.providerId,
              effort: sessions.effort,
              fastMode: sessions.fastMode,
            })
            .from(sessions)
            .where(
              and(
                eq(sessions.status, 'active'),
                or(eq(sessions.model, 'auto'), like(sessions.model, 'auto/%')),
                isNull(sessions.remoteHostId),
                isNull(sessions.agentDeviceId),
              ),
            )
        ).map((row) => ({
          sessionId: row.sessionId,
          agentKind: dbToMakerAgentKind(row.agentKind),
          model: row.model,
          providerId: row.providerId?.trim() || null,
          effort: row.effort ?? null,
          fastMode: (row.fastMode === 'ultrafast' ? 'ultrafast' : row.fastMode === true),
        })),
      listProviders: () =>
        getDesktopProviderService().listProviders({
          allowSideEffects: false,
          catalog: getActiveCatalog(),
        }),
      withSessionLock: withSendToSessionLock,
      readRoute: async (sessionId) => {
        const profiles = await readSessionRuntimeProfiles(sessionId);
        if (!profiles) return null;
        const credentialSwitch = getPendingCredentialSwitchTarget(sessionId);
        return cindyAutoRouteToFollow({
          effective: profiles.effective,
          control: profiles.control,
          hasPendingSelection:
            !!agentSwitchPending.get(sessionId) ||
            (!!credentialSwitch && credentialSwitch.selectionSource !== 'agent') ||
            !!profiles.pendingMutation,
        });
      },
      readStagedSwitch: async (sessionId) => {
        const intent = agentSwitchPending.get(sessionId);
        if (!intent?.configStaged) return null;
        const profiles = await readSessionRuntimeProfiles(sessionId);
        return profiles ? stagedCindyAutoSwitch(intent, profiles.effective) : null;
      },
      cancelStagedSwitch: async (sessionId) => cancelPendingAgentSwitchHolder?.(sessionId),
      stage: async (sessionId, route, identity) => {
        await stageSessionRouteSelection(sessionId, route, route.agentKind);
        const intent = agentSwitchPending.get(sessionId);
        if (
          intent &&
          stagedCindyAutoSwitch(intent, route) &&
          intent.providerId === identity.targetProviderId
        ) {
          // 只标记本次 Auto 跟随写入的同模型/同来源登记；其它配置切换不携带此身份。
          intent.cindyAutoRelocation = identity;
        }
      },
      assertCurrent: () => {
        if (getActiveAppSession().generation !== owner.generation) {
          throw new Error('Account changed during Cindy Auto provider follow');
        }
      },
      logger: log,
    });
  };
  const isSessionIdleForRouteApply = (sessionId: string): boolean => {
    const live = maker.getSession(sessionId) as WiredSession | undefined;
    return !live?.isTurnRunning() && (live?.listBackgroundTasks().length ?? 0) === 0
      && !hasPendingAgentInteractionForSession(sessionId);
  };

  const reconcileBotModelRoute = createBotModelRouteReconciler({
    ownerEpoch: captureSessionRuntimeControlOwnerEpoch,
    withSessionLock: withSendToSessionLock,
    read: createBotModelRouteReader({getDbClient,maker,readEffectiveBotModelSelection,getSessionRuntimeControlSnapshot,agentSwitchPending,getSessionProvider,hasSessionProvider,getSessionEffort,getSessionFastMode}),
    apply: async (sessionId, route, current) => {
      await stageSessionRouteSelection(sessionId, { ...route, agentDeviceId: route.agentDeviceId ?? null }, current.agentKind);
      // Consume the same model/Harness intent as the normal send path. Its
      // verified window protection and history handoff also apply here; a Bot
      // settings save need not wait for a second user message. Busy runtimes
      // retain their intent for the existing safe-boundary coordinator.
      if (isSessionIdleForRouteApply(sessionId)) {
        await applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId, { bootstrapAfterSwitch: true });
      }
    },
  });

  readPendingAgentSwitchRouteHolder = (sessionId) => {
    const intent = agentSwitchPending.get(sessionId);
    return intent
      ? {
          agentKind: intent.targetAgentKind,
          model: intent.model,
          providerId: intent.providerId ?? null,
          agentDeviceId: intent.targetAgentDeviceId,
          effort: intent.effort ?? null,
          rev: agentSwitchPending.revision?.(sessionId),
        }
      : undefined;
  };
  applySessionRouteUnderSendLockHolder = async (sessionId, route, currentAgentKind) => {
    // route=null: 只应用此前已登记(且仍在)的意图。
    let staged = agentSwitchPending.get(sessionId);
    try {
      if (route) {
        await stageSessionRouteSelection(sessionId, route, currentAgentKind);
        // 登记时系统可能改道来源; 按登记后的意图对象认「自己的」, 不按字段比较。
        staged = agentSwitchPending.get(sessionId);
      }
      if (!staged) return 'applied';
      if (!isSessionIdleForRouteApply(sessionId)) return 'staged';
      await applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId, { bootstrapAfterSwitch: true });
    } catch (error) {
      // 系统发起的切换失败不能卡住用户这条消息, 也不能留一个会在下次发送时反复失败的意图。
      if (staged && agentSwitchPending.get(sessionId) === staged) cancelPendingAgentSwitchHolder?.(sessionId);
      throw error;
    }
    const settle = settleSystemRouteSwitchIntent({
      stagedIntent: staged,
      remainingIntent: agentSwitchPending.get(sessionId),
      sessionIdle: isSessionIdleForRouteApply(sessionId),
    });
    if (settle === 'failed') {
      // 应用没抛错但也没生效: 跨引擎意图的应用失败被底层按 fail-continue 吞掉、
      // 意图原样留着。不能当「任务正忙」上报, 否则上层每条消息都会重试同一个必然
      // 失败的切换; 撤回意图、报错让上层保持原路由(PR #5155 review P1)。
      cancelPendingAgentSwitchHolder?.(sessionId);
      throw new Error('session route switch did not apply; pending intent withdrawn');
    }
    return settle;
  };

  configureBotRuntimeEpochRefreshRequest((sessionId, reason) => {
    return (async () => {
      const refresh = (live: WiredSession) => {
        botCompactRuntimeRefreshCoordinator.noteBoundary(live);
        return botCompactRuntimeRefreshCoordinator.attempt(live);
      };
      if (reason === 'model') {
        return refreshBotRuntimeAfterModelSelection({
          current: () => getMakerIfReady()?.getSession(sessionId) as WiredSession | undefined,
          select: () => reconcileBotModelRoute.profileChanged(sessionId),
          refresh,
        });
      }
      const live = getMakerIfReady()?.getSession(sessionId) as WiredSession | undefined;
      if (!live) return 'not-bot';
      return refresh(live);
    })().then((outcome) => {
      if (outcome === 'refreshed') {
        log.info('Bot runtime capability epoch refreshed', { sessionId, reason });
      }
      return outcome;
    }).catch((error) => {
      // Profile/resource writes must not create an unhandled rejection. The
      // refresh coordinator preflights before close, so the current healthy
      // runtime stays alive and the next send retries the same epoch check.
      log.warn('Bot runtime capability epoch refresh failed', {
        sessionId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'deferred' as const;
    });
  });

  setBotCapabilityAgentKindResolver(async (sessionId, chain) =>
    (await reconcileBotModelRoute.preview(sessionId, chain))?.agentKind ?? null);

  const readBotFallbackCandidate = createBotFallbackCandidateReader({ getDbClient, readEffectiveBotModelChain, getSessionRuntimeControlSnapshot });

  const resolvePendingRuntimeAxisPatch = createPendingRuntimeAxisResolver({getPendingSessionRuntimeMutation, getDesktopProviderService, getActiveCatalog, resolveCompatibleSessionRuntimeAxisPatch, log});

  const maybeApplySessionRuntimeFallback = createSessionRuntimeFallback({
    captureSessionRuntimeControlOwnerEpoch, readSessionRuntimeProfiles, canApplyAutomaticRuntimeSelection, hasExplicitSessionTaskModel, readBotFallbackCandidate, readSessionAgentDeviceId, readSessionRuntimeFallbackSettings, getDesktopProviderService, getActiveCatalog, pickSessionRuntimeFallback, maker, pendingSessionRuntimeFallbackRebuilds, withSendToSessionLock, sessionRuntimeControlOwnerEpochMatches, getDbClient, recordFailedSessionRuntimeFallbackCandidate, applySessionRuntimeSelection, cancelPendingSessionRuntimeMutation, getPendingCredentialSwitchTarget, clearPendingCredentialSwitchForSession, broadcastSessionRuntimeProjection, agentSwitchDeps, acceptSessionRuntimeMutation, withRehydrateCloseSuppressed, log
  });

  const sessionControlService = createSessionControlService({
    sessionExists: async (sessionId) => (await maker.getSessionMeta(sessionId)) !== null,
    getLiveSession: (sessionId) => maker.getSession(sessionId) ?? null,
    getSessionActivitySnapshot: readCanonicalSessionActivity,
    ...createSessionRuntimeManagement({
      getLiveSession:id=>maker.getSession(id)??null,readCanonicalSessionActivity,readSessionRuntimeProfiles,readBotFallbackCandidate,
      hasExplicitSessionTaskModel,readSessionRuntimeFallbackSettings,applySessionRuntimeSelection,
      mergeSessionRuntimeProfilePatch,getSessionRuntimeControlSnapshot,
      setHarness:async({targetSessionId,expectedGeneration,patch,beforeMutation})=>{
        return setSessionRuntimeHarness({
          withSessionLock: withSendToSessionLock,
          ownerEpoch: captureSessionRuntimeControlOwnerEpoch,
          generation: (id) => getSessionRuntimeControlSnapshot(id).generation,
          pendingRevision: (id) => agentSwitchPending.revision!(id),
          pending: (id) => agentSwitchPending.get(id),
          read: async (id) => (await readSessionRuntimeProfiles(id))?.effective ?? null,
          resolve: async (profile, explicit) => {
            const reroute = await assertModelRouteUsable(profile.agentKind, profile.model, profile.providerId);
            const providers = await getDesktopProviderService().listProviders({
              allowSideEffects: false, catalog: getActiveCatalog(),
            });
            const providerId = reroute && shouldApplyExclusiveProviderRerouteLive(profile.providerId)
              ? reroute
              : profile.providerId ?? effectiveSourceIdForModel(providers, null, profile.model, profile.agentKind);
            const provider = providers.find((candidate) => candidate.id === providerId);
            const model = findCatalogModel(provider, profile.model, profile.agentKind, { exact: true });
            if (!provider?.connected || !model) {
              throwIpcError('INVALID_PARAMS', `model "${profile.model}" is unavailable for harness "${profile.agentKind}"`);
            }
            const axes = resolveSessionRuntimeAxes({
              model, effort: profile.effort, fastMode: profile.fastMode,
              effortExplicit: explicit.effort, fastExplicit: explicit.fast,
            });
            if (!axes.ok) throwIpcError('INVALID_PARAMS', `target model runtime axes unavailable: ${axes.reason}`);
            return { ...profile, providerId: providerId ?? null, effort: axes.effort, fastMode: axes.fastMode };
          },
          stage: async (id, profile, assertSelectionCurrent, beforeMutation) => {
            return performSessionAgentSwitch(agentSwitchDeps, {
              sessionId: id, targetAgentKind: profile.agentKind, model: profile.model,
              providerId: profile.providerId, effort: profile.effort, fastMode: profile.fastMode,
              runtimeSource: 'agent', assertSelectionCurrent, beforeMutation,
            });
          },
        }, { targetSessionId, expectedGeneration, beforeMutation, patch: { ...patch, harness: patch.harness } });
      },
    }),
    assertExternalInputAllowed: assertReviewExternalInputAllowed,
    ...createSessionControlCoordinator({captureSessionAgentRequest,getSessionMeta:id=>maker.getSessionMeta(id),
      buildSessionControlInputItem,readSenderIdentity,get inputCoordinator() { return inputCoordinator; },steerStoredControlMessage,moveStoredControlMessage}),
    createId,
  });

  // ─── 把 internal 业务函数发布到 module-level holder ────────────────────
  // mcp-providers.ts 的 cindy_helper control deps 通过
  // tryGetOrcaCollabService() 拿到这些函数引用, 让 MCP tool
  // 走与 IPC handler 完全相同的业务路径。
  orcaCollabServiceHolder = {
    ...createSessionQueueReader({ getSessionMeta: id => maker.getSessionMeta(id), get inputCoordinator() { return inputCoordinator; }, loadAgentInputQueueSnapshotCounts, isDbClientNotReadyError }),
    updateSessionQueuedMessage: (params) => sessionControlService.updateQueuedMessage(params),
    cancelSessionQueuedMessage: (params) => sessionControlService.cancelQueuedMessage(params),
    steerSessionQueuedMessage: (params) => sessionControlService.steerQueuedMessage(params),
    moveSessionQueuedMessage: (params) => sessionControlService.moveQueuedMessage(params),
    steerSession: (params) => sessionControlService.steerSession(params),
    stopSessionTurn: (params) => sessionControlService.stopSessionTurn(params),
    getSessionRuntime: (params) => sessionControlService.getSessionRuntime(params),
    setSessionRuntime: (params) => sessionControlService.setSessionRuntime(params),
    sendToSession: async (params) => {
      // A script follow-up may name a companion as its dispatcher while no
      // owner turn is active. Never quote that companion's stale last input.
      const request: CapturedAgentRequest = params[AUTO_REVIEW_DELEGATED_CONTINUATION]
        ? { message: params.message, autoReviewUserText: { kind: 'agent-request' } }
        : await captureSessionAgentRequest(params.dispatcherSessionId ?? '', params.message);
      params = { ...params, message: request.message };
      const ownerScope = captureDataOwnerBroadcastScope();
      let classification: Awaited<ReturnType<typeof classifySessionMessagePurpose>>;
      try {
        classification = await classifySessionMessagePurpose({
          senderSessionId: params.dispatcherSessionId,
          targetSessionId: params.targetSessionId,
          purpose: params.messagePurpose,
        });
      } catch (error) {
        return { ok: false, errorCode: 'INVALID_ARGS', message: error instanceof Error ? error.message : String(error) };
      }
      if (!isDataOwnerBroadcastScopeCurrent(ownerScope)) {
        return { ok: false, errorCode: 'AGENT_NOT_READY', message: 'Data owner changed before delivery.' };
      }
      return sendToSessionInternal({
        ...params,
        autoReviewUserText: request.autoReviewUserText,
        ...(classification.delegatedContinuation || (params.targetSessionId && params[AUTO_REVIEW_DELEGATED_CONTINUATION])
          ? { autoReviewUserText: { ...request.autoReviewUserText, kind: 'delegated-continuation' as const } } : {}),
        ...(params.targetSessionId && params[AUTO_REVIEW_DELEGATED_CONTINUATION] ? {
          // Use the durable path for idle and busy targets alike. It restores the
          // target's user intent and current permission mode at dispatch time.
          forceQueue: true,
          resumeWithStoredPermissionMode: true,
        } : {}),
        ...(classification.coordination ? {
          ...coordinationInput(params.message, classification.coordination),
          forceQueue: true,
        } : {}),
      });
    },
    enableOrca: enableOrcaInternal,
    disableOrca: disableOrcaInternal,
    // MCP worker 派活必须经 OrcaTeamService，确保 running、resume idle、广播和
    // 公开错误码映射都与 IPC handler WORKER_SEND_TO 保持同一套状态机。
    sendToWorker: (params) => orcaTeamService.sendToWorker(params),
    interruptWorker: (params) => orcaTeamService.interruptWorker(params),
    // 排队消息控制统一走 OrcaTeamService,复用 resolveWorkerRef 归属校验与
    // coordinator 的 remove/replace 原语(cancel 经 remove 触发 discard settle)。
    listWorkerQueuedMessages: (params) => orcaTeamService.listWorkerQueuedMessages(params),
    updateWorkerQueuedMessage: (params) => orcaTeamService.updateWorkerQueuedMessage(params),
    cancelWorkerQueuedMessage: (params) => orcaTeamService.cancelWorkerQueuedMessage(params),
    mergeWorkerQueuedMessages: (params) => orcaTeamService.mergeWorkerQueuedMessages(params),
    steerWorkerQueuedMessage: (params) => orcaTeamService.steerWorkerQueuedMessage(params),
    moveWorkerQueuedMessage: (params) => orcaTeamService.moveWorkerQueuedMessage(params),
    startTeam: ({ leadSessionId, workerPermissionMode }) => startOrcaTeamForCaller(leadSessionId, workerPermissionMode),
    createWorker: async (params) => {
      try {
        await assertLeadCollabProjectEnabled(params.leadSessionId);
        return await orcaLifecycleService.createWorker(params);
      } catch (err) {
        return {
          ok: false,
          errorCode:
            err instanceof Error && (err as unknown as { code?: string }).code
              ? (err as unknown as { code: string }).code
              : 'INTERNAL',
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
          errorCode:
            err instanceof Error && (err as unknown as { code?: string }).code
              ? (err as unknown as { code: string }).code
              : 'INTERNAL',
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
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    getWorkspaceInfo: async ({ leadSessionId }) => {
      try {
        const info = await getOrcaWorkspaceInfoReadOnly(createOrcaDiagnosticsDeps(), leadSessionId);
        if (!info.ok || !orcaRemoteWorkersForHost) return info;
        // 运行设备目录只给 Lead 选 execution_device_id 用；探测失败不影响其余诊断。
        const devices = await orcaRemoteWorkersForHost.listExecutionDevices().catch(() => []);
        return {
          ...info,
          execution_devices: devices.map((d) => ({
            device_id: d.deviceId,
            name: d.name,
            platform: d.platform,
            supported: d.supported,
          })),
        };
      } catch (err) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    getWorkerStatus: async ({ leadSessionId, workerId }) => {
      try {
        return await getOrcaWorkerDiagnosticStatusReadOnly(
          createOrcaDiagnosticsDeps(),
          leadSessionId,
          workerId,
        );
      } catch (err) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    readWorker: async ({ leadSessionId, workerId }) => {
      try {
        return await readOrcaWorkerOutputReadOnly(
          createOrcaDiagnosticsDeps(),
          leadSessionId,
          workerId,
        );
      } catch (err) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    switchFocus: async ({ leadSessionId, workerIdOrLabel }) => {
      try {
        const { assertCurrent } = await captureOrcaPluginAuthority(leadSessionId);
        const workers = await listWorkersByLead(leadSessionId);
        const target = findFocusTargetWorker(workers, workerIdOrLabel);
        if (!target)
          return {
            ok: false,
            errorCode: 'WORKER_NOT_FOUND',
            message: `no worker matching "${workerIdOrLabel}"`,
          };

        await assertCurrent();
        await setWorkerFocus(target.teamId, target.id);

        // Resume a closed session in the background so it's ready to receive tasks,
        // but DON'T change worker status — status only transitions to 'running' when
        // actual work is dispatched (sendToWorker). Setting 'running' here without a
        // task causes the icon to flash indefinitely (no turn → turn-done never fires).
        // Focus must not wait for the cold boot: the transcript is DB-backed, and the
        // send path lazily resumes through the same deduped scheduler. The authority
        // check stays on the synchronous path (a revoked authority fails the whole
        // switch, as before) and is re-checked inside the background resume.
        if (target.status === 'idle') {
          await assertCurrent();
          orcaWorkerResumeScheduler.requestInBackground(
            target,
            (err) => {
              log.warn('switchFocus: resume failed', {
                workerId: target.id,
                sessionId: target.sessionId,
                err: err instanceof Error ? err.message : String(err),
              });
            },
            { assertCurrent },
          );
        }
        broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
        return { ok: true, workerId: target.id };
      } catch (err) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    idleWorker: async ({ callerLeadSessionId, workerId, expectedStatus }) => {
      try {
        const { assertCurrent } = await captureOrcaPluginAuthority(callerLeadSessionId);
        return await orcaTeamService.idleWorker({ callerLeadSessionId, workerId, expectedStatus }, { assertCurrent });
      } catch (err) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    endTeam: async ({ leadSessionId }) => {
      try {
        const { assertCurrent } = await captureOrcaPluginAuthority(leadSessionId);
        await disableOrcaInternal(leadSessionId, assertCurrent);
        broadcastToAllWindows(MAKER_PUSH.ORCA_WORKER_CHANGED, { leadSessionId });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    archiveWorker: async ({ callerLeadSessionId, workerId }) => {
      try {
        const { assertCurrent } = await captureOrcaPluginAuthority(callerLeadSessionId);
        return await orcaTeamService.archiveWorker({ callerLeadSessionId, workerId, beforeArchive: assertCurrent });
      } catch (err) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
    listAvailableModels: async ({ agent, callerSessionId, executionDeviceId, agentDeviceId: requestedAgentDeviceId }) => {
      try {
        if (executionDeviceId) {
          if (!orcaRemoteWorkersForHost) throw new Error('[HOST_NOT_READY] Worker service is not ready');
          const result = await orcaRemoteWorkersForHost.readModels(executionDeviceId, {
            ...(agent ? { agent } : {}), agentDeviceId: requestedAgentDeviceId ?? null,
          });
          return { ok: true, ...result };
        }
        const agents: AgentKind[] = agent ? [agent] : ['codex', 'claude-code', 'pi'];
        // SSH Lead 的 Worker 在 SSH 主机上运行 Agent，不能放到别的电脑：不列可选位置。
        const sshLead = callerSessionId ? Boolean(await readSessionRemoteHostIdCached(callerSessionId)) : false;
        // 不指定位置时列 Lead 所在位置(Lead 的 Agent 在另一台电脑运行就列那台；Lead 归在供应商组里就列组那一项
        // 所在的电脑)，与 create_worker 不指定位置时 Worker 跟 Lead 同一口径；指定了就列那里(null = 任务所在电脑)。
        const leadGroupEntry = callerSessionId && requestedAgentDeviceId === undefined && !sshLead
          ? readLeadProviderGroupEntry(callerSessionId, null).providerGroupEntry
          : undefined;
        const leadAgentDeviceId = leadGroupEntry
          ? leadGroupEntry.agentDeviceId
          : callerSessionId ? await readSessionAgentDeviceId(callerSessionId) : null;
        const agentDeviceId = requestedAgentDeviceId === undefined
          ? leadAgentDeviceId
          : requestedAgentDeviceId && requestedAgentDeviceId !== getSelfDeviceId()
            ? requestedAgentDeviceId
            : null;
        const locations = sshLead ? undefined : await listWorkerAgentLocations();
        if (agentDeviceId) {
          let views: ProviderView[];
          try {
            views = await readDeviceProviderViews(remoteBackgroundInvoke, agentDeviceId);
          } catch (err) {
            return agentDeviceCatalogFailure(err);
          }
          return {
            ok: true,
            agentDeviceId,
            ...(locations ? { locations } : {}),
            ...Object.fromEntries(agents.map((a) => [
              a === 'codex' ? 'codex' : a === 'pi' ? 'pi' : 'claude_code',
              deviceAvailableModels(views, a),
            ])),
          };
        }
        const providerRouting = await getProviderRoutingContext();
        const result: Record<
          string,
          Array<{
            id: string;
            label: string;
            providers: Array<{ id: string; name: string }>;
            defaultProviderId: string | null;
          }>
        > = {};
        for (const a of agents) {
          const caps = maker.getCapabilities(a);
          // key 必须区分 pi,否则 pi 模型会被塞进 claude_code 键与 CC 模型混淆。
          const key = a === 'codex' ? 'codex' : a === 'pi' ? 'pi' : 'claude_code';
          const providers = providerRouting.availability[a] ?? [];
          result[key] = caps.availableModels.map((m) => ({
            id: m.id,
            label: m.displayName,
            providers: providers
              .filter((provider) => provider.models.includes(m.id))
              .map((provider) => ({ id: provider.id, name: provider.name })),
            defaultProviderId: providerRouting.resolveDefaultProviderIdForModel(a, m.id),
          }));
        }
        return { ok: true, agentDeviceId: null, ...(locations ? { locations } : {}), ...result };
      } catch (err) {
        return orcaModelDiscoveryFailure(err, Boolean(executionDeviceId));
      }
    },
  };

  const createUserMessageDurably: typeof createDbMessage = async (sessionId, message, opts) => {
    const releasePendingOutcomeOnFailure = autoResumeInputLifecycle.beforePersist(sessionId, message);
    try {
      return await enqueueDurableWrite(`user:${sessionId}:${message.clientId}`, async (ownerScope) => {
        // Coordinator accepts can stamp transcriptParentUuid early; this late FIFO
        // fallback covers makerSendTransaction/direct createDbMessage paths.
        const hasTranscriptParent =
          typeof message.agentMeta?.transcriptParentUuid === 'string' &&
          message.agentMeta.transcriptParentUuid.length > 0;
        // 会话关闭（如远程电脑断线）会清掉内存里的值，重发的第一条消息就没有锚点；
        // 这时从库里补回上一条 assistant 的 uuid。
        const transcriptParentUuid = hasTranscriptParent
          ? undefined
          : getLastAssistantTranscriptUuid(sessionId)
            ?? await Promise.resolve().then(() => findLatestAssistantTranscriptUuid(sessionId)).catch(() => undefined);
        const enrichedMessage =
          transcriptParentUuid && !hasTranscriptParent
            ? { ...message, agentMeta: { ...message.agentMeta, transcriptParentUuid } }
            : message;
        // session-agent-switch:user 行逐行 stamp 当前引擎(见 messages.agent_kind 注释)。
        const agentKind = getSessionDbAgentKind(sessionId);
        const scopedOpts = {
          ...(opts ?? {}),
          // Keep a committed user row durable across an owner switch, while
          // preventing createMessage from relabelling its broadcast to the
          // next owner after the media-ref await.
          broadcastOwnerScope: ownerScope,
        };
        return createDbMessage(
          sessionId,
          agentKind ? { ...enrichedMessage, agentKind } : enrichedMessage,
          scopedOpts,
        );
      });
    } catch (err) {
      releasePendingOutcomeOnFailure();
      throw err;
    }
  };

  const readAutoReviewHistory = async (sessionId: string) => {
    await drainPersistQueue();
    return listMessagesForAgentHandoff(sessionId, null, undefined, 'authorization');
  };
  setAutoReviewContextResolver(createPluginTaskReviewResolver(createPluginTaskReviewContextReader({
    getCurrentDbClientSnapshot, drainPersistQueue, readPluginTaskConfig,
    pluginTaskAuthorizationRevision, isPluginTaskAuthorized,
    assertTaskOwnership: (pluginId, taskId) => pluginTaskServiceForCurrentOwner!().get(pluginId, taskId),
  })));

  const {
    sendToAgentAccepted: sendToAgentAcceptedUnlocked,
    prewarmSession: prewarmSessionRuntime,
  } = createMakerSendTransaction({
    restoreArchivedSessionForSend,
    prepareProductTurn: (sessionId) => {
      const dispatch = prepareUpstreamMergeTurn(sessionId);
      return dispatch
        ? () => {
            // This is the transaction path's actual vendor-dispatch boundary.
            deferredProductTurnFailureGate.clearSession(sessionId);
            dispatch();
          }
        : undefined;
    },
    readAutoReviewHistory,
    readScheduledPermissions: getSessionFsSnapshot,
    getSession: (sessionId) => maker.getSession(sessionId),
    closeSession: (sessionId) => maker.closeSession(sessionId),
    getSessionMeta: (sessionId) => maker.getSessionMeta(sessionId),
    ensureRemoteReadyForSessionStart: async (params) => {
      await ensureRemoteReadyForSessionStart(params);
    },
    checkWorkDirExists,
    resolveRecoveredWorkingDir: (sessionId, dir) => workingDirectoryRecovery.resolve(sessionId, dir),
    statDirectory: (dir) => statWorkingDirectory(dir),
    isPersistedWorktreeFallback: (dir) => dialogueWorkspaceRoots().some((root) =>
      path.dirname(path.resolve(dir)) === path.join(root, 'worktree-recovery')),
    preflightBotRuntimeResources: async (opts) => { await preflightBotRuntimeResources(opts); },
    readWorkingDirectoryRecoveryCreateOpts: async (sessionId) => {
      const [row] = await getDbClient().drizzle.select().from(sessions)
        .where(eq(sessions.id, sessionId)).limit(1);
      if (!row?.workingDir) throw new Error(`Session ${sessionId} has no working directory`);
      return {
        id: sessionId,
        agentKind: dbToMakerAgentKind(row.agentKind),
        workingDir: row.workingDir,
        workspaceKind: row.workspaceKind,
        model: row.model ?? undefined,
        providerId: row.providerId,
        effort: (row.effort ?? undefined) as CreateOpts['effort'],
        fastMode: (row.fastMode ?? false),
        permissionMode: permissionModeOrAsk(row.permissionMode),
        planMode: !!row.planModeEnabled,
        title: row.title ?? undefined,
        resumeSessionId: row.sdkSessionId ?? undefined,
        remoteHostId: row.remoteHostId ?? undefined,
        orcaRole: row.orcaRole as CreateOpts['orcaRole'],
        codexHistoryHasProductPrompt: row.codexHistoryHasProductPrompt ?? undefined,
      };
    },
    peekWorkingDirectoryRecoveryNote: (sessionId, workingDir) => workingDirectoryRecovery.peek(sessionId, workingDir),
    consumeWorkingDirectoryRecoveryNote: (sessionId, note) =>
      workingDirectoryRecovery.consume(sessionId, note),
    isOrcaMcpHydrated,
    buildCreateOptsWithStderr,
    synthesizeOrcaVendorOptionsFromDb,
    readSessionExtraDirsFromDb,
    readSessionWritableDirsFromDb,
    readSessionWorkingDirFromDb,
    readSessionWorkingDirState: readSessionWorkingDirRow,
    withRehydrateCloseSuppressed,
    bootstrapSession,
    markOrcaRoleIfNeeded,
    broadcastSessionCreated,
    prepareSendUserMessage: (sessionId, message) =>
      prepareUserMessageForAgent(sessionId, message, 'send'),
    materializeDirectSendOssAttachments,
    captureCindyLearnInvocation: async (session, persistedContent, dispatchedText) => {
      const invocationText = visibleMessageTextForConversationSearch(
        'user',
        typeof persistedContent === 'string' ? persistedContent : JSON.stringify(persistedContent),
      );
      const persistedInvocation = parseDirectLearnInvocation(invocationText);
      const dispatchedInvocation = parseDirectLearnInvocation(dispatchedText);
      if (
        !persistedInvocation
        || !dispatchedInvocation
        || JSON.stringify(persistedInvocation) !== JSON.stringify(dispatchedInvocation)
      ) return null;
      if (
        session.remoteHostId
        || maker.getSession(session.id) !== session
        || (session.getStatus && session.getStatus() !== 'active')
      ) return null;

      if (session.agentKind === 'claude-code'
        && !/^\/cindy:learn(?:\s|$)/i.test(dispatchedText.trim())
        && !await canGrantUnqualifiedClaudeLearnInvocation(session.id)) return null;

      const descriptors = builtInSkillDescriptors(
        app.getPath('userData'),
        app.getPath('appData'),
      );
      const learnDescriptor = descriptors.find((descriptor) => descriptor.name === 'learn');
      if (!learnDescriptor || !isCindySkillEnabled(learnDescriptor.absolutePath)) return null;

      const result = session.agentKind === 'claude-code'
        ? await maker.listAgentRuntimeSkills(session.agentKind, {
          workingDir: session.workDir,
          sessionId: session.id,
          runtimeConfigDir: process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude'),
        })
        : await maker.listAgentSkills(session.agentKind, {
          workingDir: session.workDir,
          sessionId: session.id,
        });
      if (result.errors?.length || maker.getSession(session.id) !== session) return null;
      const learnCandidates = activeCindyBuiltInAgentSkills(
        result.skills,
        descriptors,
        isCindySkillEnabled,
      ).filter((skill) => (skill.name.toLowerCase() === 'learn' || skill.runtimeCommandName === 'cindy:learn')
        && (!/^\/cindy:learn(?:\s|$)/i.test(dispatchedText.trim())
          || (skill.builtIn === true && skill.runtimeCommandName === 'cindy:learn')));
      if (
        learnCandidates.length !== 1
        || learnCandidates.some((skill) => skill.builtIn !== true || !skill.path)
      ) return null;

      const resolvedSkillPath = await fsp.realpath(learnCandidates[0]!.path!);
      if (maker.getSession(session.id) !== session) return null;
      return {
        version: 1,
        sessionInstanceId: session.instanceId,
        resolvedSkillPath,
      } satisfies CindyLearnInvocationGrant;
    },
    createDbMessage: createUserMessageDurably,
    rewindPersistedUserMessageAfterClear: (sessionId, clientId) =>
      enqueueDurableWrite(`user-rewind:${sessionId}:${clientId}`, () =>
        rewindPersistedUserMessageAfterClear(sessionId, clientId),
      ),
    isClearBoundaryCurrent: (sessionId, expected, expectedGeneration) => {
      const coordinator = agentInputCoordinatorHolder;
      if (!coordinator) return true;
      if (
        expectedGeneration !== undefined &&
        !coordinator.isGenerationCurrent(sessionId, expectedGeneration)
      ) {
        return false;
      }
      return coordinator.getClearBoundaryMs(sessionId) === expected;
    },
    readPiUserEntry,
    linkPiUserEntry: (sessionId, clientId, piEntryId) =>
      enqueueDurableWrite(`pi-entry-link:${sessionId}:${clientId}`, () =>
        patchMessageAgentMeta(sessionId, clientId, { piEntryId }),
      ),
    beforeDispatchDirectUserTurn: (sessionId) => gitSnapshotCoordinator?.onTurnStart(sessionId),
    onModelDispatched: recordDispatchedModelHolder = (sessionId, clientId) => {
      const live = maker.getSession(sessionId);
      if (!live) return;
      const current: TurnModelIdentity = {
        agentKind: live.agentKind, model: live.model, providerId: getSessionProvider(sessionId),
      };
      const owner = captureDataOwnerBroadcastScope();
      const db = getDbClient().drizzle;
      const createdAt = Date.now();
      void enqueueDurableWrite(`turn-model:${sessionId}:${clientId}`, async () => {
        if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
        const [input] = await db.select({ content: messages.content }).from(messages)
          .where(and(eq(messages.sessionId, sessionId), eq(messages.clientId, clientId),
            eq(messages.role, 'user'), isNull(messages.rewindAt))).limit(1);
        // Hidden coordination/routine inputs must not leak a visible model boundary.
        if (!input || input.content.startsWith(UI_ACTION_TRIGGER_PREFIX)) return;
        await recordTurnModelChange(current, {
          readPrevious: async () => {
            const [previous] = await db.select({ meta: messages.agentMeta }).from(messages)
              .innerJoin(sessions, eq(sessions.id, messages.sessionId))
              .where(and(
                eq(messages.sessionId, sessionId), eq(messages.role, 'user'),
                sql`${messages.clientId} <> ${clientId}`, isNull(messages.rewindAt),
                or(isNull(sessions.clearedAt), sql`${messages.createdAt} > ${sessions.clearedAt}`),
                sql`CASE WHEN json_valid(${messages.agentMeta}) THEN json_extract(${messages.agentMeta}, '$.executionModel') END IS NOT NULL`,
              )).orderBy(desc(messages.createdAt), desc(sql`${messages}.rowid`)).limit(1);
            return previous?.meta
              ? (JSON.parse(previous.meta) as { executionModel?: TurnModelIdentity }).executionModel ?? null
              : null;
          },
          record: async (executionModel) => isDataOwnerBroadcastScopeCurrent(owner) &&
            await patchMessageAgentMeta(sessionId, clientId, { executionModel }),
          publish: async (modelChange) => {
            if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
            await createDbMessage(sessionId, {
              clientId: `model-change:${clientId}`, role: 'assistant', content: '',
              agentMeta: { modelChange }, agentKind: makerToDbAgentKind(current.agentKind), createdAt,
            });
          },
        });
      }).catch((error) => log.warn('turn model attribution failed', { sessionId, error }));
    },
    assertBeforeVendorDispatch: (sessionId, sendOpts) => {
      const remote = isDeviceLinkInvoke();
      assertRemoteInputClearNotInFlight(sessionId, remote);
      const precondition = readRemoteInputClearBoundaryPrecondition(sendOpts);
      if (precondition.present) {
        assertCurrentInputClearBoundary(sessionId, precondition.expected);
      }
      assertCurrentInputGeneration(sessionId, readExpectedInputGeneration(sendOpts));
    },
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
    peekPlanReconcileNote: async (sessionId) => {
      const snapshot = await enqueueDurableWrite(`plan-reconcile-read:${sessionId}`, () =>
        readCodexPlanState(sessionId),
      );
      if (!snapshot) return null;
      if (snapshot.state === 'sealed') {
        return { note: buildCompletedPlanGuardNote(), sealedTurnId: snapshot.turnId };
      }
      const openSteps = snapshot.plan
        .filter((item) => item.status !== 'completed')
        .map((item) => item.step);
      if (openSteps.length === 0 && snapshot.state !== 'interrupted') return null;
      return { note: buildPlanReconcileNote({ openSteps, totalSteps: snapshot.plan.length }) };
    },
    consumeSealedPlanReconcileNote: (sessionId, turnId) =>
      enqueueDurableWrite(`plan-seal-consume:${sessionId}:${turnId}`, () =>
        clearSealedCodexPlanState(sessionId, turnId),
      ),
    // 读排在持久化 FIFO 之后,与计划对账同口径,避免读到上一条回复尚未落库的旧快照。
    peekGoalInactiveNote: (sessionId) =>
      enqueueDurableWrite(`goal-inactive-read:${sessionId}`, () => peekGoalInactiveNote(sessionId)),
    // 手机客户端说明的开关:被控端盖章的来源判据(本机 renderer / 桌面控制端 / 平台
    // 未知一律 false)。必须在这里现取,不能提前求值缓存——同一个装配好的事务会服务
    // 后续所有 send,来源是逐次调用的属性。
    isMobileClientInvoke: () => isMobileControllerInvoke(),
    // 被控电脑自身身份(设备说明里的「本机」),同样每次现取。
    readHostDeviceIdentity: () => getHostSourceDevice(),
    // 个人版制作任务说明:按持久化的 sessions.source 判定,每次 send 现读,不信任
    // 调用方自报;与手机说明同层(只进 wire 消息)。
    readTaskSource: readSessionSource,
    // 伙伴私聊引用回复的 [引用说明]:按落库内容里的 replyQuote 从库里重读原消息。
    readReplyQuoteNote,
    // 私聊话题的 [话题说明]:按持久化的话题链接现读,不是话题时为 null。
    readBotThreadNote: readBotDmThreadContextNote,
    planRepeatableWireNotes: (sessionId, notes, opts) => wireNoteMemory.plan(sessionId, notes, opts),
    applyPendingAgentSwitch: async (sessionId, options) => {
      if (!options?.scheduled) await scheduledModelScope.restore(sessionId);
      await applyPendingAgentSwitchIfIdle(agentSwitchDeps, sessionId);
      await replayPendingSessionContextWindowBudgetUnderLock(sessionId);
      // Queued Orca delivery and resume both use this transaction. A failed
      // cross-engine preparation may retain its intent without throwing.
      if (agentSwitchPending.get(sessionId)) {
        const row = await getSessionRowSnapshotStrict(sessionId);
        // Execution-device Workers have an authoritative remote Lead binding,
        // not an orca_role. Do not use the incoming message's origin as identity.
        if (row?.orcaRole || parseOrcaRemoteLead(row?.orcaRemoteLead)) {
          throwIpcError('PRECONDITION_FAILED', 'Agent switch is still pending; retry the send after recovery');
        }
      }
      // 已归组的任务所在那台现在不能用时，先换到组里下一台再发(失败不影响这次发送)；离线时先等它恢复，
      // 等的时候进行中行显示「重新连接中 n/5」。
      await providerGroupService?.beforeSend(sessionId, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.scheduled ? { scheduled: true } : {}),
        ...(options?.clientId ? { clientId: options.clientId } : {}),
        progress: (state) => agentInputCoordinatorHolder?.setProviderGroupSendReconnect(sessionId, state),
      }).catch((error) => {
        log.warn('provider group: pre-send check failed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        agentInputCoordinatorHolder?.setProviderGroupSendReconnect(sessionId, null);
      });
    },
    prepareUnhealthySession: (sessionId) =>
      contextOverflowRolloverHolder?.prepareUnhealthySession(sessionId) ?? Promise.resolve(false),
    workdirDiagnostics: workdirLog,
    log,
  });

  // 输入框开始输入（打字、粘贴、开始语音输入）时预热 Agent（本机与 device-link 控制端共用）。只覆盖用户自己的普通
  // 任务、且 Agent 在本机运行；Bot / IM / 定时 / 审查 / 共享 / 协同 / 远程主机等任务的
  // 启动另有专门的路由与权限检查，仍由真实发送处理。启动走发送路径的同一个懒创建，
  // 并在同一把会话发送锁里执行，真实发送不会与预热并发重复启动。
  const agentPrewarmer = createAgentPrewarmer({
    start: (sessionId, createOpts) => withSendToSessionLock(sessionId, async () => {
      if (maker.getSession(sessionId)) return false;
      if (agentSwitchPending.get(sessionId) || cindyMakeManager.isTaskPreparing(sessionId)) return false;
      // Queued work starts the runtime itself through the normal drain.
      if (agentInputCoordinatorHolder?.hasPendingQueuedWork(sessionId)) return false;
      const [row] = await getDbClient().drizzle
        .select({
          status: sessions.status,
          source: sessions.source,
          workingDir: sessions.workingDir,
          remoteHostId: sessions.remoteHostId,
          agentDeviceId: sessions.agentDeviceId,
          orcaRole: sessions.orcaRole,
        })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!isAgentPrewarmEligible(row)) return false;
      const co = buildCreateOptsWithStderr({ ...(createOpts as CreateOpts), id: sessionId });
      await reconcileCreateOptsAgainstDb(sessionId, co);
      if (co.remoteHostId || co.agentDeviceId) return false;
      return prewarmSessionRuntime(sessionId, co);
    }),
    isLive: (sessionId) => maker.getSession(sessionId) !== undefined,
    // Runs under the send lock: a send that got there first has marked the runtime used
    // (and its turn is running), one that arrives later waits for the close to finish and
    // then cold-starts, instead of meeting a runtime that is half closed.
    closeIfUnused: (sessionId, stillUnused) => withSendToSessionLock(sessionId, async () => {
      if (!stillUnused()) return;
      if (agentInputCoordinatorHolder?.hasPendingQueuedWork(sessionId)) return;
      const live = maker.getSession(sessionId);
      if (!live || live.isTurnRunning()) return;
      await live.closeIfIdle();
    }),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
    log,
  });

  // Host-only hints belong to the dispatched input, not a persistent session cache.
  // The fallback transaction still rechecks the authoritative Bot link and chain.
  const botFallbackInputs = new WeakSet<object>();
  const canRecoverTurn = (signals: InterruptedTurnErrorSignals, item?: AgentInputQueuedMessage | null) =>
    isInterruptedTurnError(signals) ||
    (!!item && botFallbackInputs.has(item.createOpts) && isBotCandidateUnavailable(signals));

  const sendToAgentAccepted: typeof sendToAgentAcceptedUnlocked = async (...args) => {
    const [sessionId] = args;
    if (typeof sessionId !== 'string') return await sendToAgentAcceptedUnlocked(...args);
    agentPrewarmer.markUsed(sessionId);
    // 新建页的未发送任务第一次发送：renderer 通常已先转正，这里兜底。
    if (isProvisionalSession(sessionId)) await commitProvisionalSession(sessionId);
    if (cindyMakeManager.isTaskPreparing(sessionId) && (args[3] as Record<PropertyKey, unknown> | undefined)?.[CINDY_MAKE_TASK_DISPATCH] !== true) {
      throwIpcError('PRECONDITION_FAILED', 'Cindy Make is still preparing this task');
    }
    await assertReviewExternalInputAllowed(sessionId);
    await reconcileBotModelRoute(sessionId);
    const compactedRuntime = maker.getSession(sessionId);
    if (compactedRuntime) await refreshBotCapabilityEpochBeforeSend(compactedRuntime);
    return await withSendToSessionLock(sessionId, async () => {
      await reconcileBotModelRoute(sessionId, true);
      const [botInput] = await getDbClient()
        .drizzle.select({
          source: sessions.source,
          role: botSessionLinks.role,
          workingDir: sessions.workingDir,
          remoteHostId: sessions.remoteHostId,
          profileStatus: botProfiles.status,
          hiddenAt: botProfiles.hiddenAt,
          botId: botSessionLinks.botId,
        })
        .from(sessions)
        .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
        .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
        .where(eq(sessions.id, sessionId))
        .limit(1);
      assertCindyMakeSessionAvailable(botInput?.source);
      const blocked = botSessionInputBlockReason(botInput ?? null);
      // Rechecked under the send lock right before every real send, including queue drains.
      if (botInput?.source === 'bot' && isShadowedCompanionCanonical(botInput, isCompanionShadowed)) {
        throwIpcError('PRECONDITION_FAILED', SHADOWED_COMPANION_INPUT_MESSAGE);
      }
      if (args[2] && typeof args[2] === 'object') {
        if (botInput?.source === 'bot' && ['canonical', 'delegation', 'group', 'channel', 'thread'].includes(botInput.role ?? '')) {
          botFallbackInputs.add(args[2]);
        } else {
          botFallbackInputs.delete(args[2]);
        }
      }
      if (botInput?.source === CINDY_MAKE_SESSION_SOURCE && (args[3] as Record<PropertyKey, unknown> | undefined)?.[CINDY_MAKE_TASK_DISPATCH] !== true) {
        await assertCindyMakeTaskReady(sessionId);
      }
      if (isDeviceLinkInvoke() && botInput?.source === 'bot' && (botInput.hiddenAt || botInput.profileStatus === 'archived')) {
        throwIpcError('NOT_FOUND', 'Session does not exist');
      }
      if (blocked) throwIpcError('PRECONDITION_FAILED', blocked);
      if (inputCoordinator.isExecutionPaused(sessionId)) {
        throwIpcError('PRECONDITION_FAILED', 'Task is paused; resume it before continuing');
      }
      const queuedClientId = (args[3] as { persistUserMessage?: { clientId?: string } } | undefined)
        ?.persistUserMessage?.clientId;
      await runSchedulerQueuedPreparation(queuedClientId, schedulerQueuedPromptPreparations,
        () => { if (queuedClientId) schedulerQueuedPromptDiscardWatchers.delete(queuedClientId); });
      return botInput?.remoteHostId ? sendToAgentAcceptedUnlocked(...args)
        : withCindyMakeProjectUse(app.getPath('userData'), botInput?.workingDir, () => sendToAgentAcceptedUnlocked(...args));
    });
  };
  prepareBotSessionForImSendHolder = createBotImSendGuard({getDbClient,reconcileBotModelRoute,
    getSession:id=>maker.getSession(id),refreshBotCapabilityEpochBeforeSend});

  // Shared by pre-send pressure checks and the final automatic-continuation gate.
  // A stale/archived link must not turn a delegated or deleted companion into a direct chat.
  const readContextRecoverySession = async (sessionId: string) => {
    const [row] = await getDbClient()
      .drizzle.select({
        status: sessions.status,
        source: sessions.source,
        botRole: botSessionLinks.role,
        botLinkArchivedAt: botSessionLinks.archivedAt,
        botStatus: botProfiles.status,
        botHiddenAt: botProfiles.hiddenAt,
        agentKind: sessions.agentKind,
        remoteHostId: sessions.remoteHostId,
        clearedAt: sessions.clearedAt,
        sdkSessionId: sessions.sdkSessionId,
        contextTokens: sessions.contextTokens,
        contextWindow: sessions.contextWindow,
        model: sessions.model,
        providerId: sessions.providerId,
        workingDir: sessions.workingDir,
      })
      .from(sessions)
      .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
      .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return null;
    return {
      ...row,
      botRole: row.botStatus === 'active' && !row.botHiddenAt && row.botLinkArchivedAt === null
        ? row.botRole : null,
    };
  };
  contextOverflowRolloverHolder = createContextOverflowRollover({
    hasExternalRecoveryOwner: (sessionId) =>
      isHeadlessGhostSetupTurn(sessionId) || !!bindingStore.findByTarget(sessionId),
    getSessionRow: readContextRecoverySession,
    classifyCodexHistory: async (threadId) => {
      const ownerScope = captureDataOwnerBroadcastScope();
      const dbSnapshot = getCurrentDbClientSnapshot();
      // 多账号线程的 rollout 在 codex-accounts 下,只有 thread-index 记着位置;
      // 记录读不出时不回退旧 HOME(可能是过期副本),按 unknown 处理。
      const storage = await readCodexThreadStorageReadOnly(threadId).catch(() => null);
      const result = storage === null ? 'unknown' : await classifyCodexHistoryOversized(threadId, storage);
      if (
        !dbSnapshot || !isDataOwnerBroadcastScopeCurrent(ownerScope) ||
        getCurrentDbClientSnapshot()?.clientEpoch !== dbSnapshot.clientEpoch
      ) {
        throw new Error('Codex history owner changed during inspection');
      }
      return result;
    },
    getAutoCompactThresholdPct: () => readCompactionPct(),
    resolveVerifiedWindow: (agentKind, modelId, providerId) => {
      const catalog = getActiveCatalog();
      const makerAgentKind = dbToMakerAgentKind(agentKind);
      return resolveConfiguredContextWindow(catalog, makerAgentKind, providerId, modelId);
    },
    listMessages: (sessionId) => listMessagesForAgentHandoff(sessionId, 400),
    // 伙伴自有会话(当前 + 恢复前旧对话整体优先,后台任务补足),写进回忆指引限定 history 工具范围。
    listCompanionSessionIds: (sessionId) => listBotRecallSessionIds(sessionId, COMPANION_SESSION_IDS_LIMIT),
    findLatestUser: findLatestUserMessageForRebuild,
    findLatestRebuildMeta: findLatestContextRebuildMeta,
    getLiveSession: (sessionId) => maker.getSession(sessionId),
    rehydrateColdPiRuntimeForWindowVerification,
    closeSession: (sessionId) => maker.closeSession(sessionId, 'runtime-refresh'),
    drainPersistQueue,
    commitRebuild: createContextRebuildCommit({
      captureDataOwnerBroadcastScope: () => captureDataOwnerBroadcastScope(),
      getCurrentDbClientSnapshot: () => getCurrentDbClientSnapshot(),
      isDataOwnerBroadcastScopeCurrent: scope => isDataOwnerBroadcastScopeCurrent(scope),
      commitContextRebuild: (...args) => commitContextRebuild(...args),
      broadcastSessionPatched: (...args) => broadcastSessionPatched(...args),
      createDbMessage: (...args) => createDbMessage(...args),
      logger: log,
    }),
    setPendingHandoff: (sessionId, handoff, expectedGeneration) =>
      agentHandoffPending.set(sessionId, handoff, expectedGeneration),
    readPendingHandoffGeneration: (sessionId) => agentHandoffPending.readGeneration(sessionId),
    onRebuilt: (sessionId) => {
      // overflow 终态已先走 coordinator onTurnEvent('error')，会留下 active-turn
      // recovery 和错误横幅。重放绕开 coordinator，随后的 done 会被 recovery 吃掉。
      agentInputCoordinatorHolder?.clearError(sessionId);
      // 新原生上下文没看过任何环境说明:下一轮整体重发(重放路径不经 send 事务)。
      wireNoteMemory.reset(sessionId);
    },
    getRecoveryAbortSignal: (sessionId) => {
      const coordinator = agentInputCoordinatorHolder!;
      if (coordinator.hasPendingQueuedWork(sessionId)) {
        // The terminal error may have installed recovery after this input was
        // queued. Release that old error so the queued input can actually drain.
        coordinator.clearError(sessionId);
        return AbortSignal.abort();
      }
      return coordinator.getInputAbortSignal(sessionId);
    },
    // PI provider compat 自愈：上游拒收可选请求字段后，把「该 provider/model 关掉该字段」
    // 学进 models.json compat 的覆盖存储；重建会话时 writeModelsJson 合并它。
    readPiNativeCompatOverride: (providerId, modelId, routeKey) =>
      readPiNativeCompatOverride(providerId, modelId, routeKey),
    recordPiNativeCompatOverride: async (providerId, modelId, compat, routeKey) =>
      recordPiNativeCompatOverride(providerId, modelId, compat, routeKey),
    replayUserMessage: async (sessionId, content, agentFacingWireContent, recovery) => {
      const [row] = await getDbClient()
        .drizzle.select()
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (!row?.workingDir) return { accepted: false };
      if (recovery?.signal?.aborted) return { accepted: false };
      const createOpts = buildCreateOptsWithStderr({
        id: sessionId,
        agentKind: dbToMakerAgentKind(row.agentKind),
        workingDir: row.workingDir,
        model: row.model ?? undefined,
        providerId: row.providerId,
        effort: (row.effort ?? undefined) as CreateOpts['effort'],
        fastMode: (row.fastMode ?? false),
        permissionMode: (row.permissionMode ?? 'ask') as CreateOpts['permissionMode'],
        planMode: !!row.planModeEnabled,
        title: row.title ?? undefined,
        remoteHostId: row.remoteHostId ?? undefined,
      });
      if (createOpts.extraDirs === undefined) {
        try {
          const extraDirs = await readSessionExtraDirsFromDb(sessionId);
          if (extraDirs.length > 0) Object.assign(createOpts, directoryGrantsForRuntime(extraDirs));
        } catch (err) {
          log.warn('overflow replay: read extra_dirs from DB failed (non-fatal)', {
            sessionId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (createOpts.writableDirs === undefined) {
        const writableDirs = await readSessionWritableDirsFromDb(sessionId).catch(() => []);
        if (writableDirs.length > 0) createOpts.writableDirs = writableDirs;
      }
      const recoveryIntent = recovery?.continueFromHistory
        ? restoreAutoReviewUserIntent(await readAutoReviewHistory(sessionId), {
            clientId: recovery.sourceUserClientId,
            content: recovery.sourceUserContent,
          })
        : undefined;
      if (recovery?.continueFromHistory) {
        const current = await readContextRecoverySession(sessionId);
        if (!current || !canContinueContextRecovery(current) || current.status !== 'active'
          || isHeadlessGhostSetupTurn(sessionId) || bindingStore.findByTarget(sessionId)) {
          return { accepted: false };
        }
      }
      const sendReplay = () => sendToAgentAcceptedUnlocked(
        sessionId,
        persistedUserContentToWireMessage(agentFacingWireContent ?? content),
        createOpts,
        recovery?.continueFromHistory
          ? {
              signal: recovery.signal,
              [PI_CACHE_RECOVERY_EXPECTATION]: recovery.piCacheCompatibility,
              ...(recovery.piCacheCompatibility ? { retryUserClientId: recovery.sourceUserClientId } : {}),
              [INHERITED_CAPABILITY_SELECTION]: recovery.sourceCapabilitySelectionText,
              // The internal continuation is not fresh user authorization. Restore
              // intent from authored history, never attachment/quote projections.
              [AUTO_REVIEW_SOURCE_CONTENT]: readAutoReviewUserText(recovery.sourceUserContent) ?? '',
              [AUTO_REVIEW_USER_INTENT]: recoveryIntent,
            }
          : { signal: recovery?.signal },
      );
      const result = row.remoteHostId ? await sendReplay()
        : await withCindyMakeProjectUse(app.getPath('userData'), row.workingDir, sendReplay);
      return { accepted: result.accepted === true };
    },
    withSessionLock: withSendToSessionLock,
    withCloseSuppressed: withRehydrateCloseSuppressed,
    log,
  });
  /**
   * Same-turn steer contract: resolved STEER means maker-core accepted the
   * inserted message into the active turn (Claude: streaming input push;
   * Codex: turn/steer RPC) — the running turn is NOT interrupted (2026-07-12
   * 统一同轮注入). NO_ACTIVE_TURN is the only fallbackable
   * rejection; closed sessions, closed input queues, normalization failures, and
   * vendor start failures are hard pre-accept failures so renderer rolls back
   * the optimistic bubble instead of resurrecting the message as a new turn.
   */
  const { steerToAgentAccepted } = createMakerSteerTransaction({
    getDbClient: (...args) => getDbClient(...args),
    assertReviewExternalInputAllowed: (...args) => assertReviewExternalInputAllowed(...args),
    maker,
    log,
    prepareUserMessageForAgent: (...args) => prepareUserMessageForAgent(...args),
    readReplyQuoteNote: (...args) => readReplyQuoteNote(...args),
    readAutoReviewHistory: (...args) => readAutoReviewHistory(...args),
    getHostSourceDevice: (...args) => getHostSourceDevice(...args),
    isMobileControllerInvoke: (...args) => isMobileControllerInvoke(...args),
    isDeviceLinkInvoke: (...args) => isDeviceLinkInvoke(...args),
    getResolvedMainLocale: (...args) => getResolvedMainLocale(...args),
    wireNoteMemory,
    readSessionSource: (...args) => readSessionSource(...args),
    mcpAppModelContext: (...args) => mcpAppModelContext(...args),
    assertRemoteInputClearNotInFlight: (...args) => assertRemoteInputClearNotInFlight(...args),
    readRemoteInputClearBoundaryPrecondition: (...args) => readRemoteInputClearBoundaryPrecondition(...args),
    assertCurrentInputClearBoundary: (...args) => assertCurrentInputClearBoundary(...args),
    assertCurrentInputGeneration: (...args) => assertCurrentInputGeneration(...args),
    readExpectedInputGeneration: (...args) => readExpectedInputGeneration(...args),
    publishUiSessionIntervention: (...args) => publishUiSessionIntervention(...args),
  });

  const trustedDesktopSteerText = new AsyncLocalStorage<string>();

  const revokeTrustedDesktopQueueOrigin = (item?: AgentInputQueuedMessage): void => { if (item?.origin) delete (item.origin as Record<PropertyKey, unknown>)[TRUSTED_DESKTOP_QUEUE_ORIGIN]; };
  configureCindyMakeTaskSender((sessionId, message, createOpts, sendOpts) =>
    sendToAgentAccepted(sessionId, message, createOpts, attachTrustedDesktopSendContext(message, sendOpts)),
    (sessionId) => inputCoordinator.getClearBoundaryMs(sessionId),
  );
  registerMcpAppsIpc(createAppMessageSender({
    owner: getCurrentDbClientSnapshot,
    readClearBoundary: async (sessionId) => normalizeAgentInputClearBoundaryMs(
      (await getSessionRowSnapshotStrict(sessionId))?.clearedAt,
    ),
    restoreQueue: (sessionId) => inputCoordinator.ensureQueueRestored(sessionId),
    clearBoundary: (sessionId) => inputCoordinator.getClearBoundaryMs(sessionId),
    shouldQueue: (sessionId) => inputCoordinator.shouldQueueNewTurn(sessionId),
    getSessionMeta: (sessionId) => maker.getSessionMeta(sessionId),
    createClientId: createId,
    buildQueueItem: buildSessionControlInputItem,
    enqueue: (sessionId, item) => { inputCoordinator.enqueue(sessionId, item); },
    sendToAgentAccepted,
  }), async (sessionId, request, signal) => {
    const session = maker.getSession(sessionId) ?? { id: sessionId, setInteractionListener: () => {} };
    // Historical Apps use the same permission cards without starting an Agent turn.
    installDesktopInteractionListener(session);
    return requestHostInteraction(session, request, signal);
  });
  registerMakerSessionSendHandler(
    {
      handle(channel, handler) {
        makerSessionRegistry.handle(channel, (event, ...args) => {
          if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event as never);
          return handler(event, ...args);
        });
      },
    },
    {
      sendToAgentAccepted: async (sessionId, message, createOpts, sendOpts) => {
        // Only fresh user IPC waits, before taking any send/restart fence.
        // Internal continuations and turn cleanup must remain able to finish.
        const owner = getCurrentDbClientSnapshot();
        await withSessionPermissionChange(sessionId, async () => undefined);
        if (!owner || owner !== getCurrentDbClientSnapshot()) throwIpcError('PRECONDITION_FAILED', 'Account changed before input');
        return sendToAgentAccepted(
          sessionId,
          message,
          createOpts,
          // 直连 maker:send 的设备来源只由 main 按 invoke context 盖章(wire 值已在
          // sessionSendHandler 边界剥掉);本机 renderer 不盖。
          isDeviceLinkInvoke()
            ? stampDirectSendSourceDevice(sendOpts, readDeviceLinkInvokeSourceDevice())
            : attachTrustedDesktopSendContext(message, sendOpts),
        );
      },
      assertRemoteInputControlBoundary: (sessionId, opts) =>
        assertRemoteInputControlBoundary(sessionId, isDeviceLinkInvoke(), opts),
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.STEER,
    async (event, sessionId: unknown, message: unknown, sendOpts?: unknown) => {
      // **wire sendOpts 必须消毒**(review P1/P2,两个 bot 各报一次):这个 channel 在
      // device-link allowlist 里开放,`sendOpts` 是调用方可控输入。不剥的话,桌面 renderer
      // 或任意获准远控的非手机客户端只要传 `{ fromMobileClient: true }`,就能让本轮拿到伪造
      // 的手机环境说明、按错误的来源调整产物形态。
      //
      // 契约与 maker:send 一致(sessionSendHandler 同样在 IPC 边界剥):**该字段只由 main
      // 盖章**。coordinator 的内部 steerToAgent 调用不经过这里,透传值不受影响。
      if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
      const deviceLinkInvoke = isDeviceLinkInvoke();
      if (!deviceLinkInvoke) assertTrustedAppRendererEvent(event);
      const boundaryStamp = await assertRemoteInputControlBoundary(
        sessionId,
        deviceLinkInvoke,
        sendOpts,
      );
      const sanitizedSendOpts = attachMainOwnedInputBoundary(
        stripMainOnlySendOpts(sendOpts),
        boundaryStamp,
      );
      await steerToAgentAccepted(
        sessionId,
        message,
        deviceLinkInvoke
          ? stampDirectSendSourceDevice(sanitizedSendOpts, readDeviceLinkInvokeSourceDevice())
          : attachTrustedDesktopSendContext(message, sanitizedSendOpts),
      );
    },
  );

  // #4513: session 双时间戳「疑似中断」是纯 DB 启发式,对任何在飞 turn 都成立;
  // renderer 的运行态抑制依赖 status(isRunning) 事件,而消息流与状态流是两条通道,
  // 事件可能缺失/迟到(协同 worker 视图实测复现)。这里把 main 侧权威运行态暴露
  // 给 renderer 做一次真值回填:tracker 由 status/done/终止型 error 事件维护,
  // 再叠加 live runtime 的 isTurnRunning 兜底。进程内存态重启后自然清空,
  // 不会把「真中断」误报成在飞。
  ipcMain.handle(
    MAKER_INVOKE.SESSION_TURN_ACTIVE,
    (event, sessionId: unknown): { inTurn: boolean } => {
      assertTrustedAppRendererEvent(event);
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throwIpcError('INVALID_PARAMS', 'sessionId required');
      }
      const live = getMakerIfReady()?.getSession(sessionId);
      return {
        inTurn:
          sessionTurnActivityTracker.isSessionInTurn(sessionId) ||
          live?.isTurnRunning() === true,
      };
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.GET_CONTEXT_USAGE,
    async (_e, sessionId: unknown, createOpts?: unknown): Promise<ContextUsageData> => {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throwIpcError('INVALID_PARAMS', 'sessionId required');
      }
      const sharedTaskAccess = createSharedTaskContextUsageGuard(
        getDeviceLinkInvokeContext()?.sharedTask, sessionId,
      );
      sharedTaskAccess.assertCurrent();
      let sess = maker.getSession(sessionId);
      if (!sess) {
        const trustedCreateOpts = await sharedTaskAccess.resolveCreateOpts(
          createOpts, async () => ({
            ...await readSharedTaskTaskCreateOpts(sessionId),
            extraDirs: extraDirsForRuntime(await readSessionExtraDirsFromDb(sessionId)),
            writableDirs: await readSessionWritableDirsFromDb(sessionId),
          }),
        );
        if (!trustedCreateOpts) {
          throwIpcError('NOT_FOUND', `Session ${sessionId} is not running`);
        }
        const co = buildCreateOptsWithStderr({ ...(trustedCreateOpts as CreateOpts), id: sessionId });
        // session-agent-switch:先按 DB 行校正再判 claude-only——否则切到 codex 后
        // 残留的 claude createOpts 会在这里 spawn 出旧引擎的 live session 并被后续
        // send 复用(会话被劫持回旧引擎,2026-07-20 审计实锤)。
        await reconcileCreateOptsAgainstDb(sessionId, co);
        if (co.agentKind !== 'claude-code') {
          throwIpcError(
            'UNSUPPORTED_CAPABILITY',
            `Agent ${co.agentKind} does not support context usage`,
          );
        }
        const okLazy = await checkWorkDirExists(
          sessionId,
          co.workingDir,
          co.agentKind,
          co.remoteHostId,
        );
        if (!okLazy) {
          throwIpcError('NOT_FOUND', `Working directory is missing for session ${sessionId}`);
        }
        await synthesizeOrcaVendorOptionsFromDb(sessionId, co);
        if (co.extraDirs === undefined) {
          try {
            const row = await readSessionExtraDirsFromDb(sessionId);
            if (row.length > 0) Object.assign(co, directoryGrantsForRuntime(row));
          } catch (err) {
            log.warn('context-usage lazy-create: read extra_dirs from DB failed (non-fatal)', {
              sessionId,
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (co.writableDirs === undefined) {
          const row = await readSessionWritableDirsFromDb(sessionId).catch(() => []);
          if (row.length > 0) co.writableDirs = row;
        }
        try {
          sharedTaskAccess.assertCurrent();
          await ensureRemoteReadyForSessionStart({ createOpts: co });
          const {
            session: lazySess,
            didInjectOrcaInstructions,
            didInjectProjectContext,
          } = await bootstrapSession(co, sharedTaskAccess.assertCurrent);
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
          throwIpcError(
            'INTERNAL',
            err instanceof Error ? err.message : 'context usage lazy create failed',
          );
        }
      }
      if (sess.agentKind !== 'claude-code' && sess.agentKind !== 'pi') {
        throwIpcError(
          'UNSUPPORTED_CAPABILITY',
          `Agent ${sess.agentKind} does not support context usage`,
        );
      }
      try {
        return await sess.getContextUsage();
      } catch (err) {
        if (err instanceof Error && err.name === 'NotSupportedError') {
          throwIpcError('UNSUPPORTED_CAPABILITY', err.message);
        }
        throwIpcError(
          'INTERNAL',
          err instanceof Error ? err.message : 'context usage query failed',
        );
      }
    },
  );

  // 尽力而为：立即返回，启动在后台进行；不支持、已在运行或启动失败都只是下一次发送照常冷启动。
  ipcMain.handle(
    MAKER_INVOKE.SESSION_PREWARM,
    async (event, sessionId: unknown, createOpts?: unknown): Promise<{ accepted: boolean }> => {
      const sid = requireSessionId(sessionId);
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      if (getDeviceLinkInvokeContext()?.sharedTask) return { accepted: false };
      if (!createOpts || typeof createOpts !== 'object' || Array.isArray(createOpts)) {
        throwIpcError('INVALID_PARAMS', 'createOpts required');
      }
      void agentPrewarmer.request(sid, createOpts);
      return { accepted: true };
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.SESSION_DISCARD_PROVISIONAL,
    async (event, sessionId: unknown): Promise<{ discarded: boolean; remaining: boolean }> => {
      const sid = requireSessionId(sessionId);
      // Local renderer only: not on the device-link allowlist, and the sender must be the app window.
      assertTrustedAppRendererEvent(event);
      if (!isProvisionalSession(sid)) return { discarded: false, remaining: false };
      // Under the send lock: a prewarm that is still starting finishes first, and one queued
      // behind us finds no row and does nothing.
      const discarded = await withSendToSessionLock(sid, async () => {
        if (!isProvisionalSession(sid)) return false;
        agentPrewarmer.markUsed(sid);
        const live = maker.getSession(sid);
        if (live?.isTurnRunning()) return false;
        // Same close as idle prewarm reclaim; the row goes away right after.
        if (live) await live.closeIfIdle();
        if (maker.getSession(sid)) return false;
        return discardProvisionalSessionRow(sid);
      });
      // remaining: the unsent task still exists (its runtime could not be closed), so the
      // renderer keeps tracking it and retries instead of reopening the same id.
      return { discarded, remaining: !discarded && isProvisionalSession(sid) };
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.SESSION_COMMIT_PROVISIONAL,
    async (event, sessionId: unknown): Promise<{ committed: boolean }> => {
      const sid = requireSessionId(sessionId);
      // Local renderer only: not on the device-link allowlist, and the sender must be the app window.
      assertTrustedAppRendererEvent(event);
      return { committed: await commitProvisionalSession(sid) };
    },
  );

  /**
   * Reconcile the in-memory turn boundary after a vendor abort/close when the
   * normal terminal event was lost. The vendor Session is authoritative for
   * whether work is still running; the desktop tracker is only an event-driven
   * view and can remain stale across owner-boundary teardown.
   */
  type StableSessionLookup =
    { status: 'found'; session: WiredSession } | { status: 'missing' } | { status: 'unavailable' };

  const lookupStableSessionForTurnBoundary = (sessionId: string): StableSessionLookup => {
    const wired = sessionBindings.getSession(sessionId);
    if (wired) return { status: 'found', session: wired };
    try {
      const sess = maker.getSession(sessionId);
      return sess ? { status: 'found', session: sess } : { status: 'missing' };
    } catch (err) {
      // Dynamic Maker throws PRECONDITION_FAILED while an account owner is
      // being replaced. Callers that need fail-closed must not treat this as
      // "session process gone".
      log.warn('session lookup unavailable during turn-boundary reconciliation', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'unavailable' };
    }
  };

  const getStableSessionForTurnBoundary = (sessionId: string): WiredSession | null => {
    const lookup = lookupStableSessionForTurnBoundary(sessionId);
    return lookup.status === 'found' ? lookup.session : null;
  };

  /**
   * Finalize an exact retry owner that never crossed vendor dispatch.
   * Technical failure surfaces the suppressed error; explicit cancellation
   * persists it quietly and closes the replacement Island lifecycle.
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

  const sealLostTerminalPersistState = (sessionId: string): void => {
    // Same persist boundary as a lost-terminal live-idle reconcile. The next
    // turn on this sessionId must not append to a half-open streaming block.
    sealAssistantBlockForLateFinal(sessionId, null);
    const abortedAssistantPersistId = consumeLastAssistantPersistId(sessionId);
    const abortedBoundaryAssistantPersistId = consumeLastTopLevelAssistantPersistId(sessionId);
    flushOrphanToolResults(sessionId, null);
    if (abortedAssistantPersistId) {
      pendingFailedTurnAssistantPersistId.set(sessionId, abortedAssistantPersistId);
    }
    if (abortedBoundaryAssistantPersistId) {
      void markAssistantTurnFailed(sessionId, abortedBoundaryAssistantPersistId);
    }
    clearCodexPlanRowsForSession(sessionId);
    resetTurnPersistState(sessionId);
  };

  const reconcileSessionTurnIdle = (sessionId: string, source: string): boolean => {
    const lookup = lookupStableSessionForTurnBoundary(sessionId);
    if (lookup.status === 'unavailable') return false;
    if (lookup.status === 'missing') {
      const trackerStale =
        sessionTurnActivityTracker.isSessionInTurn(sessionId) ||
        sessionTurnActivityTracker.isSessionTurnDispatchBoundaryBusy(sessionId);
      sealLostTerminalPersistState(sessionId);
      if (trackerStale) {
        log.warn('reconciling stale session turn boundary after session unload', {
          sessionId,
          source,
        });
      }
      sessionTurnActivityTracker.deleteSession(sessionId);
      void sessionTurnLeaseTracker.markTurnEnded(sessionId);
      notifyGoalIdleAfterTurnSettled(sessionId);
      try {
        markTurnEndedAfterPersistDrain(sessionId);
        noteClaudeSessionTurnState(sessionId, false);
        settlePendingCredentialSwitch(sessionId, `reconcile:${source}`);
        settlePendingSessionRuntimeControlHolder?.(sessionId, `reconcile:${source}`);
        deferredCodexRestartHolder?.onSessionSettled();
        gatewayCodexRestartHolder?.onSessionSettled();
        agentInputCoordinatorHolder?.onExternalTurnSettled(sessionId);
        refreshRemoteCodexMcpOnTurnSettledHolder?.(sessionId);
      } catch (err) {
        log.warn('stale session turn side-effect cleanup failed', {
          sessionId,
          source,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return true;
    }
    const sess = lookup.session;
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
    // reached the host. Seal persist state before releasing the boundary;
    // otherwise its last progress line is later treated as a legacy final
    // answer by title regeneration.
    sealLostTerminalPersistState(sessionId);
    const trackerStale =
      sessionTurnActivityTracker.isSessionInTurn(sessionId) ||
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
    void sessionTurnLeaseTracker.markTurnEnded(sessionId);
    // 与正常 product-terminal 事件共享同一条 Goal idle 唤醒语义。direct abort
    // 与 coordinator 的 authoritative-idle 都从本 reconciliation 成功出口经过；
    // 迟到终态或重复尾巴由 Goal controller 的 deferred intent 防抖幂等收敛。
    notifyGoalIdleAfterTurnSettled(sessionId);
    try {
      // The marker write is best-effort and ordered behind pending message
      // persistence. It may retry/settle after an owner boundary is available.
      markTurnEndedAfterPersistDrain(sessionId);
      noteClaudeSessionTurnState(sessionId, false);
      settlePendingCredentialSwitch(sessionId, `reconcile:${source}`);
      settlePendingSessionRuntimeControlHolder?.(sessionId, `reconcile:${source}`);
      deferredCodexRestartHolder?.onSessionSettled();
      gatewayCodexRestartHolder?.onSessionSettled();
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
    if (sessionBindings.getSession(sessionId) !== boundary.session) return false;
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

  /**
   * /clear replaces the coordinator state synchronously but seals the DB
   * visibility boundary after an await. Remote input must not enter that
   * window: it could capture the new generation while still reading the old
   * clearedAt value and then dispatch into the pre-clear context.
   */
  // A clear seals the DB visibility boundary after an await.  Keep a small
  // per-session refcount rather than a bare Set so two user clear requests
  // cannot let the first finally block release the gate while the second one
  // is still sealing.


  /**
   * Deferred queue materialisation creates local media before the coordinator
   * knows whether the item will ever reach the durable messages row. Keep that
   * ownership outside the persisted queue payload and settle it at the same
   * lifecycle boundaries as the coordinator item.
   */
  const { queuedAttachmentOwnership, registerQueuedAttachmentOwnership, markQueuedAttachmentDurableAfterSnapshot, discardQueuedAttachmentOwnership, discardSpecificQueuedAttachmentOwnership, markQueuedAttachmentPersistenceStarted, settleQueuedAttachmentPersistenceFailure } = createQueuedAttachmentLifecycle(log, awaitAgentInputQueueSnapshotPersistence);

  async function awaitAgentInputQueueSnapshotPersistence(sessionId: string): Promise<void> {
    inputCoordinator.retryQueueSnapshotPersistence(sessionId);
    await awaitQueuedSnapshotWrite(sessionId);
  }

  const inputCoordinator: AgentInputCoordinator = new AgentInputCoordinator({
    sendToAgent: async (sessionId, message, createOpts, sendOpts) => {
      try {
        const result = await sendToAgentAccepted(sessionId, message, createOpts, sendOpts);
        await orcaInterAgentDispatcher.settleQueuedOrcaInterAgentAcceptedCallback(
          sessionId,
          sendOpts,
          result.outcome,
        );
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
    isResumableTurnErrorCandidate: canRecoverTurn,
    // 被按住的 error 最终没接管 → 只补落 error 行(横幅 coordinator 自己设)。
    // 纯判定：供应商组会先试着换电脑时，这次错误先不呈现(provider-groups.md §6.1)。
    providerGroupSwitchCandidate: (sessionId, signals) =>
      providerGroupService?.mayHandleTurnError(sessionId, signals)
        ? providerGroupSwitchCause(signals, 'run')
        : null,
    onUsageLimitedTurnError: (sessionId, signals, item, candidateToken) => {
      if (schedulerRecoveryBridge.onUsageLimitedTurnError(sessionId, signals, item, candidateToken)) return;
      // 供应商组分配的任务先试自动换电脑，不换时由它交回额度重置后自动继续。
      if (!providerGroupService || signals.providerGroupUsageLimit) {
        usageLimitAutoResume.onTurnError(sessionId, signals, candidateToken);
        return;
      }
      // 先不呈现的那次错误：换成了丢掉，不换了先放出来再交回原有处理；一直没有结局时到点放出来。
      const holdId = inputCoordinator.getProviderGroupSwitchHoldId(sessionId);
      let hooks: ProviderGroupTurnErrorHooks | undefined;
      let holdTimer: ReturnType<typeof setTimeout> | undefined;
      if (holdId !== null) {
        // 久久没有结局时到点放出来。每次重试、开始换电脑时重新计时：等原电脑恢复本身就可能要一两分钟，
        // 不让等的时间吃掉换电脑的时间(到点放出会把协同 Worker 的异常终止回报给 Lead)。
        const armHoldTimer = () => {
          clearTimeout(holdTimer);
          holdTimer = setTimeout(() => {
            // 协同 Worker：到点把这次异常终止回报给 Lead 之后，这一趟换电脑就此停下——Lead 已据此重新安排，
            // 再换过去续跑会让它收到两份互相矛盾的结果。普通任务照旧：错误先放出来，换成了照常续跑。
            const worker = providerGroupHeldTerminals.has(sessionId, holdId);
            releaseProviderGroupHeld(sessionId, holdId);
            if (worker) providerGroupService?.noteUserAction(sessionId);
          }, PROVIDER_GROUP_SWITCH_HOLD_MAX_MS);
        };
        // 协同 Worker 的终态与 error 行按同一次登记结算：换成了不回报这次异常终止，没换成才回报给 Lead。
        const recoveryOwner = activeOwnerScopeKey();
        hooks = {
          notHandled: () => recoveryOwner === activeOwnerScopeKey() && inputCoordinator.resumeAfterProviderGroupDeclined(
            sessionId, candidateToken, signals, (attemptToken) => {
              const detail = providerGroupHeldErrors.takeForRecovery(sessionId, holdId);
              if (detail) autoResumeBookkeeping.stashSuppressedError(sessionId, detail, attemptToken);
              const terminal = providerGroupHeldTerminals.takeForRecovery(sessionId, holdId);
              if (terminal?.orcaTerminal) autoResumeBookkeeping.stashOrcaSuppressedTerminal(sessionId, terminal.orcaTerminal);
              if (terminal?.groupTerminal) autoResumeBookkeeping.stashBotGroupSuppressedTerminal(sessionId, terminal.groupTerminal);
            },
          ),
          beforeFallback: () => releaseProviderGroupHeld(sessionId, holdId),
          resumed: () => discardProviderGroupHeld(sessionId, holdId),
          // 先等原电脑恢复时进行中行显示「重新连接中 n/5」，开始换电脑时改回「正在换一台电脑继续」。
          reconnecting: (attempt, maxAttempts) => {
            armHoldTimer();
            inputCoordinator.setProviderGroupSwitchHoldProgress(sessionId, holdId, { attempt, maxAttempts });
          },
          switching: () => {
            armHoldTimer();
            inputCoordinator.setProviderGroupSwitchHoldProgress(sessionId, holdId, null);
          },
          // 续跑马上交出去：不再计「久久没有结局」，免得续跑途中把错误放出来(协同 Worker 会因此回报两次)。
          continuing: () => clearTimeout(holdTimer),
        };
        armHoldTimer();
      }
      void providerGroupService
        .onTurnError(sessionId, signals, candidateToken, hooks)
        .catch((error: unknown) => {
          log.warn('provider group: handling a failed turn did not complete', {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          if (holdId === null) return;
          clearTimeout(holdTimer);
          // 用户中途接手、错误已被新的一轮换掉等：补落 error 行，错误已不是当前状态时不再呈现。
          releaseProviderGroupHeld(sessionId, holdId);
        });
    },
    onResumableTurnErrorDiscarded: (
      sessionId: string,
      options: { surfaceError: boolean; owner: SuppressedTurnErrorOwner; providerGroupSwitchHoldId?: number },
    ) => {
      if (options.providerGroupSwitchHoldId !== undefined) {
        const deferred = autoResumeBookkeeping.takeDeferredError(sessionId, options.owner);
        if (deferred) {
          providerGroupHeldErrors.stash(sessionId, options.providerGroupSwitchHoldId, deferred.detail);
          if (deferred.orcaTerminal || deferred.groupTerminal) {
            providerGroupHeldTerminals.stash(sessionId, options.providerGroupSwitchHoldId, deferred);
          }
        }
        return;
      }
      if (options.surfaceError) {
        autoResumeBookkeeping.surfaceSuppressedError(sessionId, { deferredOwner: options.owner });
      } else {
        autoResumeBookkeeping.flushSuppressedError(sessionId, { deferredOwner: options.owner });
      }
    },
    onResumableTurnError: createInterruptedTurnRecovery({
      coordinator: () => inputCoordinator, canRecoverTurn, botFallbackInputs, interruptedTurnAutoResumeGuard, saveTurnStartedAtForDeferred, log, autoResumeBookkeeping, beginSchedulerAutoResume, getStableSessionForTurnBoundary, pendingContinuationOnlyAutoResumeRebuilds, maybeApplySessionRuntimeFallback, pendingSessionRuntimeFallbackRebuilds
    }),
    steerToAgent: (sessionId, message, sendOpts) => {
      const expectedText = trustedDesktopSteerText.getStore();
      return steerToAgentAccepted(
        sessionId,
        message,
        expectedText === undefined
          ? sendOpts
          : attachTrustedDesktopSendContext(message, sendOpts, expectedText),
      );
    },
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
    isLiveTurnRunning: (sessionId) => {
      const lookup = lookupStableSessionForTurnBoundary(sessionId);
      if (lookup.status === 'unavailable') return undefined;
      if (lookup.status === 'missing') return false;
      try {
        return lookup.session.isTurnRunning();
      } catch {
        return undefined;
      }
    },
    isLiveSessionPresent: (sessionId) => {
      const lookup = lookupStableSessionForTurnBoundary(sessionId);
      if (lookup.status === 'unavailable') return undefined;
      return lookup.status === 'found';
    },
    getTurnGeneration: (sessionId) =>
      getStableSessionForTurnBoundary(sessionId)?.getTurnGeneration() ?? null,
    getObservedCurrentTurnTerminal: (sessionId) => {
      const lookup = lookupStableSessionForTurnBoundary(sessionId);
      if (lookup.status !== 'found') return undefined;
      try {
        return lookup.session.getObservedCurrentTurnTerminal();
      } catch {
        return undefined;
      }
    },
    getTurnSessionIdentity: (sessionId) => getStableSessionForTurnBoundary(sessionId) ?? null,
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
    // Coordinator steer/drain persistence must use the same FIFO writer and
    // auto-resume bookkeeping as direct maker sends.  Keeping one writer also
    // preserves message ordering when a clear-race rewind follows the insert.
    createUserMessage: createUserMessageDurably,
    rewindPersistedUserMessageAfterClear: (sessionId, clientId) =>
      enqueueDurableWrite(`user-rewind:${sessionId}:${clientId}`, () =>
        rewindPersistedUserMessageAfterClear(sessionId, clientId),
      ),
    resolveSessionReferences,
    refreshAgentReferencesBeforeDispatch: async (item) => {
      const refreshed = await hydrateQueuedAgentReferences(item, {
        isSessionTurnRunning: (targetSessionId) =>
          getMakerIfReady()?.getSession(targetSessionId)?.isTurnRunning() ?? false,
      });
      Object.assign(item, refreshed);
      if (refreshed.agentReferences === undefined) delete item.agentReferences;
    },
    // interrupted-turn-resume:retry 续跑判定走 DB 持久化行(见 dep 注释)。
    // 先 drain 持久化写队列:terminal error 到达时 flushAssistantBlock 只是把
    // 产出行入队,立即 Retry 可能在写入落盘前查询 → 有产出被误判为零产出而
    // 重发原文(review P2)。drain 等的是全局 write chain 快照,毫秒级。
    hasAssistantProgressAfter: async (sessionId, userClientId) => {
      await drainPersistQueue();
      return hasAssistantProgressAfterMessage(sessionId, userClientId);
    },
    getRecoveryContextSnapshot: async (sessionId, userClientId) => {
      await drainPersistQueue();
      return getRecoveryContextSnapshot(sessionId, userClientId);
    },
    // retry-supersede:零产出重试的克隆行落库并派发成功后,软删被取代的旧 user 行
    // 与其后的 error 行(实现与守卫见 localDb/ipc/messages.supersedeRetriedUserTurn)。
    // 只发 messages:deleted、不额外发 sessions:patched:软删既不改变会话列表的
    // _count(权威口径不过滤 rewind_at,行本体还在)也不改变 preview(克隆行仍是最新
    // 可见行),理由与踩过的坑记在 helper 的注释里。
    supersedeRetriedUserTurn,
    getLastAssistantTranscriptUuid,
    // 插话并入正在运行的 turn,不开启新 turn:排队时登记的「新 turn 接管」回调不再适用,
    // 只释放登记(不运行),否则会给已在跑的 worker 另建一份 running/auto-bridge 身份。
    onSteerAccepted: async (sessionId, item) => {
      void settleTaskActionInput(item).catch(() => undefined);
      await settleTodoDispatch(sessionId, item.clientId, true);
      orcaInterAgentDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId);
    },
    onAcceptedQueuedMessage: async (sessionId, item, restoredFromSnapshot): Promise<void> => {
      if (item.clientId.startsWith('plugin-target:')) {
        try { await assertPluginTargetQueuedDelivery(sessionId, item.clientId); }
        catch { throw new AcceptedCallbackDispatchCancelled('Plugin target delivery is no longer authorized'); }
      }
      if (restoredFromSnapshot && item.clientId.startsWith('bot-dm:')) {
        if (!botDirectMessageServiceHolder) throw new AcceptedCallbackDispatchCancelled('Bot message recovery unavailable');
        await botDirectMessageServiceHolder.assertRestoredQueuedDelivery(sessionId, item.clientId);
      }
      // 已派发 → 该项不会再走 discard,释放 scheduler 的 discard 监听防泄漏。
      schedulerQueuedPromptDiscardWatchers.delete(item.clientId);
      schedulerQueuedPromptPreparations.delete(item.clientId);
      // 返回 promise 让 coordinator 在 onPersisted 链路里 await —— worker 运行态与
      // pending auto-bridge 副作用必须先于 turn 启动完成；失败仍吞错落日志，不拦派发。
      await orcaInterAgentDispatcher.runQueuedOrcaInterAgentAcceptedCallback(sessionId, item);
      await botDelegationServiceHolder?.acceptQueuedSessionInput(sessionId, item.clientId, item.supersedesUserClientId, restoredFromSnapshot, item.retrySourceClientId);
      const pluginTaskSession = maker.getSession(sessionId);
      if (pluginTaskSession && pluginTaskServiceForCurrentOwner) {
        await pluginTaskServiceForCurrentOwner().accept(sessionId, item, { instanceId: pluginTaskSession.instanceId, generation: pluginTaskSession.getTurnGeneration() });
      }
    },
    onUserMessagePersisting: (sessionId, item) => {
      markQueuedAttachmentPersistenceStarted(sessionId, item.clientId);
    },
    onUserMessagePersisted: (sessionId, item) => {
      // A messages row is a stronger durable boundary than the queue snapshot.
      // Release the controller-owned OSS source before dropping the ephemeral
      // ownership record; the local materialization itself now belongs to the
      // durable transcript row.
      void queuedAttachmentOwnership.settleDurable(sessionId, item.clientId);
    },
    onUserMessageQueryable: (sessionId) => {
      orcaUiAssignmentHistoryGate.notifyUserMessagePersisted(sessionId);
    },
    onUserMessagePersistenceFailed: (sessionId, item, opts) => {
      settleQueuedAttachmentPersistenceFailure(sessionId, item.clientId, opts.retainForRetry);
    },
    onInputDispatchSettled: async (sessionId, item, accepted) => {
      welcomeDispatchReceipts.settle(sessionId, item.clientId, accepted);
      await settleTodoDispatch(sessionId, item.clientId, accepted);
    },
    onDispatchedUserTurn: async (sessionId, item, preVendorDispatchAt): Promise<void> => {
      void settleTaskActionInput(item).catch(() => undefined);
      // 供应商组换电脑后的续跑派发出去了：协同 Worker 暂存的那次终态不再回报(续跑那一轮结束时照常回报结果)。
      if (item.autoResume === true && item.autoResumeInfo?.reason === USAGE_LIMIT_RESET_AUTO_RESUME_REASON) {
        settleProviderGroupContinuation(sessionId, true);
      }
      botDelegationServiceHolder?.confirmQueuedSessionInputDispatched(sessionId, item.clientId);
      const { attemptToken, discarded } = autoResumeInputLifecycle.dispatched(sessionId, item);
      if (discarded) {
        log.info('interrupted-turn auto-resume accepted by vendor', { sessionId, clientId: item.clientId, attemptToken });
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
    // 复用真人活跃边界：队首 Retry / Continue 和新输入尚未落库时也开始新限额周期。
    onUserAction: (sessionId) => usageLimitAutoResume.noteUserAction(sessionId),
    // 失败 turn 重试 → hook 侧把这一轮接回渠道那条已收口的消息。source 区分
    // 人工与自动续跑：只有真人接手才作废 scheduler waiter，自动路径不能取消自己。
    onUiRetry: (sessionId, clientId, source, attemptToken) => {
      autoResumeInputLifecycle.retry(sessionId, clientId, source, attemptToken);
      if (source === 'manual') {
        contextOverflowRolloverHolder?.cancelRecovery(sessionId);
        // UI continuation can dispatch before the scheduler backoff callback.
        // Retire that pending waiter first so it cannot consume the manual retry.
        failPendingSchedulerAutoResume(sessionId);
        // The click itself is the human intervention boundary. Reset here, before any
        // persistence/vendor await, so a failed manual retry still starts a fresh episode.
        silentStopAutoResumeGuard.noteUserSend(sessionId);
        interruptedTurnAutoResumeGuard.noteUserSend(sessionId);
        providerGroupService?.noteUserAction(sessionId);
      }
      publishUiContinuation(sessionId, clientId);
    },
    // 新消息进队 → 作废该会话的待续跑记账(渠道那条旧消息已被别的内容取代)。
    // 用 enqueue 入口而不是消息文本: 零产出重试重发的是原文, 文本上无从区分,
    // 而它走 unshift 不经这里, 于是不会把自己的回流作废掉。
    onUserEnqueue: (sessionId) => {
      contextOverflowRolloverHolder?.cancelRecovery(sessionId);
      autoResumeBookkeeping.supersedeUnclaimedErrorForUserIntervention(sessionId);
      // The user turn can dispatch before the backoff callback observes that its
      // recovery was superseded. Fail the scheduler waiter synchronously so it
      // cannot consume that unrelated turn's text/done as this run's result.
      failPendingSchedulerAutoResume(sessionId);
      publishUiSessionIntervention(sessionId);
    },
    previewQueuedUserTurn: (sessionId, item) => {
      if (item.botTaskCoordination) return;
      notifyAgentIslandUserPrompt(
        { id: sessionId, agentKind: item.createOpts?.agentKind, workDir: item.workingDir },
        // 预览给人看的正文:落库可见内容优先(发给模型的 text 可能带来源 / 回执前缀);
        // Orca 条目落库的是 {orcaSource, content} JSON,取原话 displayText。
        item.origin?.kind === 'orca'
          ? (item.origin.displayText ?? item.text)
          : item.persistedContent || item.text,
        { source: 'enqueue', clientId: item.clientId },
      );
    },
    onAutomaticEnqueue: (sessionId, item) => {
      contextOverflowRolloverHolder?.cancelRecovery(sessionId);
      // 协同消息(Lead 给 Worker 派活、Worker 的回报到达 Lead)：供应商组按「有人接手」处理——这一趟换电脑停下，
      // 那条消息开始新的一轮(provider-groups.md §6.1「协同任务」)。不重置中断自愈的预算。
      if (item?.origin?.kind === 'orca') providerGroupService?.noteUserAction(sessionId);
      // Orca 等自动输入会推进同一会话，必须撤销旧 retry owner，避免它消费这轮事件；
      // 但预算充值仍只发生在真人消息的持久化路径，自动输入不会重置 episode。
      autoResumeBookkeeping.supersedeUnclaimedErrorForUserIntervention(sessionId);
      failPendingSchedulerAutoResume(sessionId);
      publishUiSessionIntervention(sessionId);
    },
    onRejectedUserTurn: (sessionId, item) => {
      void settleUndispatchedBotGroupTurn(botGroupChatServiceHolder, sessionId, item.clientId,
        'failed', inputCoordinator.getProjection(sessionId).error).catch(() => {
        log.warn('Bot group undispatched input settlement failed', { sessionId });
      });
      notePluginTaskLifecycle(service => service.discard(sessionId, item, 'failed'));
      welcomeDispatchReceipts.settle(sessionId, item.clientId, false);
      rollbackAgentIslandUserPrompt(sessionId, item.clientId, 'rejected');
      // Auto-resume items have an exact-token cleanup boundary below. Keep
      // their attempt lease until that boundary can restore recovery and
      // finalize the suppressed error; releasing it here would make a later
      // undispatched discard skip finalizeSuppressedError.
      if (item.autoResume) return;
      autoResumeBookkeeping.surfaceSuppressedErrorForRetry(sessionId, item.clientId);
    },
    persistTerminalSendError: (sessionId, message) => {
      onTurnErrorEvent(
        sessionId,
        {
          message,
          ...(isPiPromptRpcTimeoutError({ message }) ? { reason: 'pi-prompt-timeout' } : {}),
        },
        null,
      );
    },
    onUnconfirmedAutoResumeTurn: autoResumeInputLifecycle.unconfirmed,
    onPersistedSendRejected: (sessionId, message) => {
      if (!isPiPromptRpcTimeoutError({ message })) return;
      // 第一次 timeout：只关掉卡住的原生进程，不自动 replay。用户重试时再 hidden rebuild。
      void maker.closeSession(sessionId).catch((error) => {
        log.warn('failed to close unhealthy PI session after prompt timeout', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    // 队列项未派发即被丢弃(stop/remove/clearSession) → 释放暂存的 accepted 副作用, 防回调表泄漏。
    onDiscardedQueuedMessage: (sessionId, item) => {
      void settleTaskActionInput(item).catch(() => undefined);
      void settleTodoDispatch(sessionId, item.clientId, false);
      notePluginTaskLifecycle(service => service.discard(sessionId, item, 'cancelled'));
      if (item.durableDelivery === true) {
        void saveCancelledInputDelivery(sessionId, item.clientId).catch((error) => {
          log.warn('input delivery cancellation persistence failed', { sessionId, error: String(error) });
        });
      }
      welcomeDispatchReceipts.settle(sessionId, item.clientId, false);
      rollbackAgentIslandUserPrompt(sessionId, item.clientId, 'discarded');
      discardQueuedAttachmentOwnership(sessionId, item.clientId);
      orcaInterAgentDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId);
      // Auto-resume cleanup must run before generic claimed-retry release:
      // settleOutcome may drop the attempt lease, while finalizeSuppressedError
      // still needs the suppressed entry/current token to complete takeover drain.
      const autoResume = item.autoResume === true;
      if (autoResume) settleUndispatchedInterruptedAutoResume(sessionId, item);
      finalizeUndispatchedClaimedRetry(sessionId, item, 'cancelled');
      // 持久化中的项在这里被取消后不会再走 onUndispatchedUserTurn，复用同一结算出口。
      if (!autoResume) settleUndispatchedInterruptedAutoResume(sessionId, item);
      // 排队心跳被丢弃 → 通知 runner 按 aborted 收尾对应 run,不让 fire 永久挂起。
      const watcher = schedulerQueuedPromptDiscardWatchers.get(item.clientId);
      schedulerQueuedPromptPreparations.delete(item.clientId);
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
    },
    // 谓词逻辑在 deferredRestartQueueWiring.ts(与 #2506 跨模块回归共用同一
    // 工厂,harness 不再照抄接线形状);holder 晚于 coordinator 构造,经闭包
    // 晚绑定。
    hasPendingCredentialSwitch: createDeferredRestartQueueGate({
      hasPendingCredentialSwitchEntry: (sessionId) =>
        pendingCredentialSwitchHolder?.has(sessionId) === true,
      isSessionRestarting: (sessionId) =>
        deferredCodexRestartHolder?.isSessionRestarting(sessionId) === true ||
        gatewayCodexRestartHolder?.isSessionRestarting(sessionId) === true,
    }),
    emitProjection: (projection) => {
      usageLimitWaitHost.onProjection(projection);
      schedulerRecoveryBridge.emitProjection(projection);
      broadcastToAllWindows(MAKER_PUSH.INPUT_PROJECTION, projection);
      // 伙伴自主跟进：出错 / 用量上限等待旁路进状态表（只读投影，不影响原广播）。
      try { noteBotAutonomyInputProjection(projection); } catch { /* 观察层异常不影响输入协调 */ }
      if (!isGoalInputBlocked(projection.sessionId)) notifyGoalIdleAfterTurnSettled(projection.sessionId);
    },
    // 意识拦截钩(订阅槽①):派发/落库前问已装钩子意识;fail-open 由
    // screenGhostUserMessage 内部收敛,快路径(无钩子意识)零开销。
    screenUserMessage: (sessionId, agentFacingText, item) => {
      const session = getStableSessionForTurnBoundary(sessionId);
      const model = resolveGhostUserHookModel(
        session?.isTurnRunning() === true,
        session?.model,
        item.createOpts.model,
      );
      return withGhostUserHookModel(model, () =>
        screenGhostUserMessage(sessionId, agentFacingText),
      );
    },
    onUserMessageBlocked: (sessionId, item, verdict) => {
      rollbackAgentIslandUserPrompt(sessionId, item.clientId, 'blocked');
      broadcastGhostMessageBlocked({
        sessionId,
        clientId: item.clientId,
        text: item.text,
        ...verdict,
      });
    },
    onUserMessageRewritten: (sessionId, item, info) => (revokeTrustedDesktopQueueOrigin(item), broadcastGhostMessageRewritten({ sessionId, clientId: item.clientId, ...info })),
    beforeDispatchUserTurn: async (sessionId, item) => {
      if (item.botTaskCoordination) await assertBotTaskCoordination(sessionId, item.botTaskCoordination);
      autoResumeBookkeeping.markReplacementDispatching(sessionId, item.clientId);
      const liveSession = maker.getSession(sessionId);
      if (liveSession) {
        await beginTurnChangeSetAtDispatch(liveSession, item.clientId);
      }
      // hook 续跑回流的**权威归属点**: 在 vendor dispatch 之前(本回调被 await), 所以
      // 观察器挂上就不丢正文开头, 而 live session 此刻必然已就绪。clientId 对得上的
      // 才是目标续跑轮 —— 绕过 coordinator 的 turn(silent-stop 自动续跑)不走这里,
      // 结构上不可能被误认。详见 uiContinuationSignal 的模块注释。
      publishUiTurnDispatching(sessionId, item.clientId);
      await gitSnapshotCoordinator?.onTurnStart(sessionId);
    },
    onUndispatchedUserTurn: (sessionId, item, disposition) => {
      void settleTodoDispatch(sessionId, item.clientId, false);
      welcomeDispatchReceipts.settle(sessionId, item.clientId, false);
      // 目标轮落库了却没能 dispatch(取消 / 失败): 记账该立刻还回去, 而不是等超时。
      publishUiTurnUndispatched(sessionId, item.clientId);
      clearPendingTurnChangeSets(sessionId);
      gitSnapshotCoordinator?.onTurnAbort(sessionId);
      autoResumeBookkeeping.rollbackReplacementPreview(sessionId, item.clientId);
      const autoResume = item.autoResume === true;
      if (autoResume) settleUndispatchedInterruptedAutoResume(sessionId, item);
      finalizeUndispatchedClaimedRetry(sessionId, item, disposition);
      // 自动续跑那条消息已落库、却最终没派出去 → 这次重连就是失败。**必须在这里钉死**:
      // 它不会产生任何 turn 事件,新加的终态结算路径够不到它,待确认记录于是悬空,被之后
      // 任何一个无关的 text / tool 事件误标成「已重新连接」(codex P1)。
      // 按 clientId 匹配 —— 别的 turn 未派发不该动这条记录。
      if (!autoResume) settleUndispatchedInterruptedAutoResume(sessionId, item);
    },
    // Thread 3 fix: called from drain/dispatchCompact failure paths where the item
    // was removed from the queue but not put back (persisted-failure case). If no
    // other work is pending, any deferred completion must be replayed so Agent
    // Island does not remain in the "running" phase indefinitely.
    onQueueEmptied: (sessionId) => {
      getAgentIslandService()?.notifyQueueEmptied(sessionId);
    },
    // 排队输入崩溃恢复(issue #761):快照写入 fire-and-forget(模块内 per-session
    // 写链保序 + 失败落日志),读回由 ensureQueueRestored 懒触发。恢复前先严格
    // 水合 durable /clear 边界，所有入口共用，避免仅 projection 路径安全。
    persistQueueSnapshot: (sessionId, items) => saveAgentInputQueueSnapshot(sessionId, items),
    loadClearBoundary: async (sessionId) =>
      (await getSessionRowSnapshotStrict(sessionId))?.clearedAt,
    loadQueueSnapshot: async (sessionId) => {
      // Rehydrate durable task holds before any entry point can drain restored/new input.
      await botDelegationServiceHolder?.restorePauseForSession(sessionId);
      await restoreSavedUsageLimitWait(sessionId);
      return loadAgentInputQueueSnapshot(sessionId);
    },
    getPersistedClientIds: getPersistedInputClientIds,
  });
  agentInputCoordinatorHolder = inputCoordinator;
  explicitStopImpl = async (sessionId) => {
    await inputCoordinator.ensureQueueRestored(sessionId);
    resetAutomaticRecoveryForExplicitStop(sessionId);
    contextOverflowRolloverHolder?.cancelRecovery(sessionId);
    // 与桌面 Stop 同序: Goal 暂停同步摘掉续跑源后, 中止先发出, 再等落盘(失败此时才抛)。
    const goalPause = pauseGoalBeforeExplicitStop(sessionId);
    inputCoordinator.stop(sessionId);
    await Promise.all([goalPause, awaitAgentInputQueueSnapshotPersistence(sessionId)]);
  };
  setSharedTaskQueueReader((sessionId, clientId) => {
    const item = inputCoordinator.getProjection(sessionId).pendingQueue.find((pending) => pending.clientId === clientId);
    return item ? { sessionId, authorAccountId: item.sharedTaskAuthor?.accountId ?? '', state: 'pending', attachments: item.files } : undefined;
  });
  setSharedTaskInteractionReader((requestId) => {
    const entry = pendingInteractionResolvers.get(requestId);
    const request = entry?.request;
    if (!entry || entry.migrated || !request || (request.kind !== 'permission' && request.kind !== 'ask_user_question' && request.kind !== 'plan_review')) return undefined;
    return {
      sessionId: entry.sessionId,
      kind: request.kind,
      ...(request.kind === 'permission' ? { toolName: request.toolName, suggestions: request.suggestions } : {}),
    };
  });
  // An Orca Lead turn that only dispatched work is not the team's completion:
  // keep it running until every worker report has reached the Lead.
  getAgentIslandService()?.setCompletionDeferResolver((sessionId) =>
    inputCoordinator.hasPendingQueuedWork(sessionId) ||
    orcaTeamServiceForEvents?.hasPendingWorkerReports(sessionId) === true,
  );

  // Scheduler 撞忙排队桥实现(导出薄封装见 isSchedulerTargetSessionBusy 一带注释)。
  // registerAll 可能因切账号重跑:先清旧账号残留的 discard 监听(对应队列快照
  // 已随账号切换失效,runner 侧 run 也已被 sweep 收尾)。
  schedulerQueuedPromptDiscardWatchers.clear();
  schedulerQueuedPromptPreparations.clear();
  schedulerQueueBridgeHolder = createSchedulerQueueBridge({
    maker, inputCoordinator, getSessionRowSnapshot, createId,
    schedulerQueuedPromptDiscardWatchers, schedulerQueuedPromptPreparations, enqueueSendToSessionMessage,
    isDispatchBoundaryBusy: (id, session) => isSessionTurnDispatchBoundaryBusy(sessionTurnActivityTracker, id, session),
  });

  // 延迟生效的凭证切换登记表:set-model 撞上"会话自己在跑"时不再拒绝,登记到这里,
  // turn 结束边界(上方 onEvent 接线)自动兑现:关会话 + 写 route + 广播 + 唤醒队列。
  const pendingCredentialSwitchService = new PendingCredentialSwitchService({
    maker,
    isSessionInTurn,
    isPiOwnerCurrent: sessionRuntimeControlOwnerEpochMatches,
    withPiSessionLock: withSendToSessionLock,
    applyPiPending: (sessionId, target, resolved, isCurrent) =>
      applyPiPendingSelection(sessionId, target, resolved, isCurrent),
    broadcastFailed: (payload) => {
      broadcastToAllWindows(MAKER_PUSH.SESSION_CREDENTIAL_SWITCH_FAILED, payload);
    },
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
    persistRoute: createPendingCredentialSwitchPersistence({get pendingCredentialSwitchHolder() {return pendingCredentialSwitchHolder;}, sessionRuntimeControlOwnerEpochMatches, getDbClient, getSessionDbAgentKind, getDesktopProviderService, getActiveCatalog, resolveSessionRuntimeAxes, resolveConfiguredContextWindow, setSessionEffort, setSessionFastMode, broadcastSessionPatched}),
    logger: log,
  });
  pendingCredentialSwitchHolder = pendingCredentialSwitchService;
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

  // Memory 设置变更撞上 Codex busy 时的延迟软重启登记(见 deferredCodexRestart.ts)。
  // 与 pendingCredentialSwitchService 共用 turn 结束 / 会话关闭边界接线。
  // 等待其它任务空闲时不阻塞输入；只在实际重启期间挡住相关会话的派发，
  // 成功或失败收口后均唤醒，避免全局设置变化冻结无关任务。
  const deferredCodexRestartService = new DeferredCodexRestartService({
    restart: (applyRuntime) => restartCodexAfterAuthModeChange(async () => {
      if (await applyRuntime() === false) return false;
      await shutdownCodexEnvironment();
    }),
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
    onQueueGateReleased: createDeferredRestartSettledWake({
      wakeSession: (sessionId, reason) => inputCoordinator.wakeSession(sessionId, reason),
    }),
    logger: log,
  });
  deferredCodexRestartHolder = deferredCodexRestartService;
  const gatewayCodexRestartService = new GatewayCodexRestartService({
    listHostKeys: listCodexGatewayHostKeys,
    restartHost: refreshCodexGatewayHost,
    hasBusySession: (hostKey) => maker.listActiveSessions().some(session =>
      session.agentKind === 'codex' && !session.remoteHostId &&
      (session.codexHostKey ?? 'local') === hostKey && isLocalSessionBusy(session, isSessionInTurn)),
    listSessionIds: (hostKey) => maker.listActiveSessions().filter(session =>
      session.agentKind === 'codex' && !session.remoteHostId &&
      (session.codexHostKey ?? 'local') === hostKey).map(session => session.id),
    onQueueGateReleased: createDeferredRestartSettledWake({
      wakeSession: (sessionId, reason) => inputCoordinator.wakeSession(sessionId, reason),
    }),
    logger: log,
  });
  gatewayCodexRestartHolder = gatewayCodexRestartService;
  setCodexGatewayKeyRefreshHook(() => gatewayCodexRestartService.schedule());
  // 新本地 Codex 会话加入 shared host 前先尝试兑现 pending 的延迟重启,
  // 让它直接在新状态的 fresh host 上起跑(maker-host onBeforeStart 接线)。
  setBeforeLocalCodexSessionStartHook(async () => {
    await gatewayCodexRestartService.flushBeforeLocalCodexSessionStart();
    await deferredCodexRestartService.flushBeforeLocalCodexSessionStart();
  });

  const { requireSessionId, requireClientId, requireSessionRefs, requireTrustedReferenceContexts, requireQueuedMessage } = createMakerInputValidation(isDeviceLinkInvoke);

  ipcMain.handle(DL_SESSION_REFERENCE_CAPABILITY_CHANNEL, () => ({ supported: true, version: 1 }));

  async function readSharedTaskTaskCreateOpts(sid: string): Promise<AgentInputCreateOpts> {
    const [row] = await getDbClient().drizzle.select().from(sessions).where(eq(sessions.id, sid)).limit(1);
    if (!row || row.status !== 'active' || !row.workingDir) throwIpcError('NOT_FOUND', 'SharedTask task unavailable');
    return {
      agentKind: dbToMakerAgentKind(row.agentKind), workingDir: row.workingDir,
      model: row.model, providerId: row.providerId, effort: row.effort,
      permissionMode: row.permissionMode, fastMode: row.fastMode,
      planMode: row.planModeEnabled, remoteHostId: row.remoteHostId ?? undefined,
      resumeSessionId: row.sdkSessionId ?? undefined, orcaRole: row.orcaRole,
    };
  }

  const prepareSharedTaskInput = async (sid: string, item: AgentInputQueuedMessage) => {
    const sharedTask = getDeviceLinkInvokeContext()?.sharedTask;
    if (!sharedTask) return item;
    return stampSharedTaskInput(item, sharedTask, await readSharedTaskTaskCreateOpts(sid));
  };

  /**
   * device-link 远控输入的自动起名(入队 / 插话共用)。
   *
   * 只对远控调用生效:本机 renderer 自己走 `maker:auto-title`。返回一个 commit 闭包
   * 而不是直接调度 —— 调度必须发生在输入真正被 coordinator 接受之后,否则输入被拒
   * 时会留下一个凭空出现的标题。
   */
  const prepareDeviceLinkAutoTitle = createRemoteInputAutoTitle({
    isDeviceLinkInvoke, isSessionAutoTitleEligible, scheduleSessionAutoTitle, log,
    labels: () => ({ image: t('ccAgent.autoTitle.image'), file: t('ccAgent.autoTitle.file') }),
  });
  /**
   * INPUT_ENQUEUE / INPUT_STEER 的发送前状态闸门。
   *
   * 这里不能复用 swallow-error 的展示查询:数据库暂时不可读时要让 renderer
   * 保留本地草稿并稍后重试,只有明确不存在或已删除才返回终态 NOT_FOUND。
   * archived 有意放行,因为桌面发送会先乐观 auto-unarchive,而 coordinator 仍可
   * 接受这条输入。
   */
  const { getInputSessionRow, readRemoteInputClearBoundaryPrecondition, readExpectedInputGeneration, assertCurrentInputGeneration, assertExpectedRemoteInputClearBoundary, assertCurrentInputClearBoundary, retryPendingInputClearBoundary, observeLocalInputClearBoundary, remoteInputClientIdWasPersisted, assertRemoteInputControlBoundary, beginRemoteInputClearGate, endRemoteInputClearGate, assertRemoteInputClearNotInFlight } = createMakerInputBoundary({
    inputCoordinator,
    getSessionRowSnapshotStrict: (...args) => getSessionRowSnapshotStrict(...args),
    getSessionRowSnapshot: (...args) => getSessionRowSnapshot(...args),
    clearSessionContextInDb: (...args) => clearSessionContextInDb(...args),
    getPersistedInputClientIds: (...args) => getPersistedInputClientIds(...args),
    assertReviewExternalInputAllowed: (...args) => assertReviewExternalInputAllowed(...args),
    log
  });


  const stampQueuedEditProvenance = createQueuedEditProvenance({
    inputCoordinator,
    isSharedTaskInvoke: () => !!getDeviceLinkInvokeContext()?.sharedTask,
    captureOwner: captureDataOwnerBroadcastScope,
    isOwnerCurrent: isDataOwnerBroadcastScopeCurrent,
  });

  registerMakerInputControls({
    inputCoordinator, ipcMain, isDeviceLinkInvoke, assertTrustedAppRendererEvent,
    getInputSessionRow: (...args) => getInputSessionRow(...args),
    retryPendingInputClearBoundary: (...args) => retryPendingInputClearBoundary(...args),
    assertRemoteInputClearNotInFlight: (...args) => assertRemoteInputClearNotInFlight(...args),
    assertRemoteInputControlBoundary: (...args) => assertRemoteInputControlBoundary(...args),
    observeLocalInputClearBoundary: (...args) => observeLocalInputClearBoundary(...args),
    getSessionRowSnapshot: (...args) => getSessionRowSnapshot(...args),
    readInputDeliveryClientIds, readInputDeliveryReceipts, saveCancelledInputDelivery,
    awaitAgentInputQueueSnapshotPersistence, getAgentIslandService,
    readQueuedEditorProvenance, stampQueuedEditProvenance,
  });

  registerMakerInputSubmission({
    inputCoordinator, ipcMain,
    assertReviewExternalInputAllowed,
    isDeviceLinkInvoke,
    assertTrustedAppRendererEvent,
    getCurrentDbClientSnapshot,
    withSessionPermissionChange,
    prepareSharedTaskInput,
    beginRemoteSendTrace,
    awaitAgentInputQueueSnapshotPersistence,
    materializeQueuedOssAttachmentsDeferred,
    hydrateQueuedAgentReferences,
    getMakerIfReady,
    isMobileControllerInvoke,
    readDeviceLinkInvokeSourceDevice,
    getResolvedMainLocale,
    prepareDeviceLinkAutoTitle,
    hasInputDeliveryCancellation,
    trustedDesktopSteerText,
    collectQueuedAttachmentRefs,
    readQueuedEditorProvenance,
    stampQueuedEditProvenance,
    assertRemoteInputClearNotInFlight,
    readRemoteInputClearBoundaryPrecondition,
    observeLocalInputClearBoundary,
    getInputSessionRow,
    assertExpectedRemoteInputClearBoundary,
    remoteInputClientIdWasPersisted,
    assertRemoteInputControlBoundary,
    registerQueuedAttachmentOwnership,
    queuedAttachmentOwnership,
    discardSpecificQueuedAttachmentOwnership,
    discardQueuedAttachmentOwnership,
    markQueuedAttachmentDurableAfterSnapshot
  });

  // device-link 出方向:远程入队消息的 OSS 引用(files[] + persistedContent)在入队前一次性物化成本地
  // 临时文件(共用下载、用后删 OSS),保证喂 agent 的 files[] 与落库的 persistedContent 都是本地路径。
  // 本机会话无 OSS 引用 → materializeQueuedOssAttachmentsDeferred 原样返回,零开销。


  ipcMain.handle(MAKER_INVOKE.INPUT_STOP, async (_e, sessionId: unknown, opts?: unknown) => {
    const sid = requireSessionId(sessionId);
    const remote = isDeviceLinkInvoke();
    await assertRemoteInputControlBoundary(sid, remote, opts, 'stop');
    // Some providers acknowledge Stop without emitting another terminal event.
    // Close the native build's wait at this authorized, shared Stop boundary.
    const makeInterrupted = interruptUpstreamMergeTurn(sid).catch(() =>
      log.warn('Could not interrupt merge task after explicit stop'),
    );
    if (!remote) reviewRunControl.noteReviewerStopRequested(sid);
    // Main 是本机窗口与 Device Link 控制端的 Stop 汇合点；先记账再触发 abort，
    // 任何 renderer 后续请求推荐都会从同一 ledger fail-closed。
    notePromptPredictionSessionStopped(sid);
    getGhostPipeDispatcher().cancelSessionCalls(sid);
    // 这三类续跑撤销都是同步操作，必须早于 goal/DB await；
    // 否则退避 timer 能在用户已点 Stop 后抢先发出下一轮。
    resetAutomaticRecoveryForExplicitStop(sid);
    // pauseGoal 调用同步 detach listener/timer，持久化可以与 vendor abort 并行；真正的
    // turn/interrupt 先启动，IPC 回执再等待 paused 落盘。
    const goalPause = pauseGoalBeforeExplicitStop(sid);
    const result = inputCoordinator.stop(
      sid,
      opts && typeof opts === 'object'
        ? (opts as {
            keepQueue?: boolean;
            pauseQueue?: boolean;
            expectedClearBoundaryMs?: number | null;
          })
        : undefined,
    );
    // Thread 1 fix: stop() clears pendingCompacts (and optionally pendingQueue)
    // without calling notifyQueueEmptied. A compact-only queue stopped here would
    // leave a deferred completion stuck forever. Mirror the INPUT_REMOVE pattern.
    if (!inputCoordinator.hasPendingQueuedWork(sid)) {
      getAgentIslandService()?.notifyQueueEmptied(sid);
    }
    await Promise.all([goalPause, makeInterrupted]);
    return result;
  });


  ipcMain.handle(MAKER_INVOKE.IMAGES_RETRY, async (event, sessionId: unknown, imageId: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const sid = requireSessionId(sessionId);
    if (typeof imageId !== 'string' || !/^[a-f0-9]{64}$/.test(imageId)) throwIpcError('INVALID_PARAMS', 'invalid image id');
    await assertRemoteInputControlBoundary(sid, remote, undefined);
    try { await generatedImageDelivery.recover(sid, imageId as string); }
    catch { throwIpcError('INTERNAL', 'Image delivery is unavailable'); }
  });


  ipcMain.handle(
    MAKER_INVOKE.INPUT_CANCEL_USAGE_LIMIT_WAIT,
    async (event, sessionId: unknown, opts?: unknown) => {
      const remote = isDeviceLinkInvoke();
      // 本机调用必须来自 Cindy 自己的 renderer;device-link 调用由隧道上下文与输入控制边界把关。
      if (!remote) assertTrustedAppRendererEvent(event);
      const sid = requireSessionId(sessionId);
      await assertRemoteInputControlBoundary(sid, remote, opts);
      usageLimitAutoResume.clear(sid);
      return inputCoordinator.cancelUsageLimitWait(sid);
    },
  );

  // renderer auth-retry 放弃时（catch / guard fall-through）调回 main 补落持久化。
  // main 侧在 isRemoteAuthRetry 条件下跳过了 onTurnErrorEvent；此处覆盖"重试失败/不能重试"两路。
  // agentMetaRaw:renderer 传来的 event.agentMeta(可选),用于 flushAssistantBlock 边界 meta 兜底
  // 与 dedup key(requestId/uuid),与 register.ts 主路径 onTurnErrorEvent(sid, errData, event.agentMeta) 对称。
  ipcMain.handle(
    MAKER_INVOKE.PERSIST_TURN_ERROR_DEFERRED,
    (_e, sessionId: unknown, errDataRaw: unknown, agentMetaRaw: unknown) => {
      const sid = requireSessionId(sessionId);
      const errData =
        errDataRaw != null && typeof errDataRaw === 'object'
          ? (errDataRaw as { message?: unknown; reason?: unknown; sdkError?: unknown })
          : null;
      const agentMeta =
        agentMetaRaw != null && typeof agentMetaRaw === 'object'
          ? (agentMetaRaw as AgentMeta)
          : null;
      const persistId = onTurnErrorEvent(sid, errData, agentMeta);
      deferredProductTurnFailureGate.settle(
        sid,
        isCurrentProductTurnFailureOwner,
        (owner) => {
          void interruptProductTurn(sid, owner).catch(() =>
            log.warn('Could not interrupt product turn after deferred recovery failure'),
          );
        },
        { data: errData, meta: agentMeta },
      );
      getAgentIslandService()?.resolveDeferredRemoteAuthRetryError(sid);
      return persistId;
    },
  );


  /**
   * 排队消息被编辑时按**编辑者**所在设备重新盖章:改写后的正文出自这次编辑的设备,原条目的
   * 设备 / 手机来源(以及插件来源)不再属实。与入队同一套盖章,wire 自报一律不生效;
   * 设备与平台在 IPC 边界的 invoke context 里读,回调执行时不再依赖 async context。
   */
  function readQueuedEditorProvenance(): {
    sourceDevice: ReturnType<typeof readDeviceLinkInvokeSourceDevice>;
    isMobile: boolean;
  } {
    return { sourceDevice: readDeviceLinkInvokeSourceDevice(), isMobile: isMobileControllerInvoke() };
  }


  // 与 enqueue/steer 同一套物化:远程编辑保存的新附件可能是 OSS 引用,入队前物化成本地文件。


  const clearSessionContext=createSessionClear({inputCoordinator,agentHandoffPending,wireNoteMemory,assertReviewExternalInputAllowed,isDeviceLinkInvoke,beginRemoteInputClearGate,endRemoteInputClearGate,
 resetSessionRuntime(sid){cindyMakeManager.cancelTasksForSession(sid);workingDirectoryRecovery.discard(sid);resetAutomaticRecoveryForExplicitStop(sid);},
 notifyQueueEmptied:sid=>getAgentIslandService()?.notifyQueueEmptied(sid),goalClearObserver:sid=>goalClearObserver?.(sid),
 clearSessionContextInDb,pruneWithdrawnWorkingMemoryForSession,userDataDirectory:ownerScopedUserDataPath,log});
 ipcMain.handle(MAKER_INVOKE.INPUT_CLEAR_SESSION,(_e,sessionId:unknown,clearedAt:unknown)=>clearSessionContext(sessionId,clearedAt));

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

  ipcMain.handle(MAKER_INVOKE.LIST_ACTIVE, (_event, options?: unknown) => {
    const activityService = getAgentIslandService();
    const activityById = new Map(activityService?.getSessionActivitySnapshots()
      .map((activity) => [activity.sessionId, activity] as const) ?? []);
    const sessions = maker.listActiveSessions().map((s) => {
      const activity = activityById.get(s.id);
      return {
        sessionId: s.id,
        agentKind: s.agentKind,
        workDir: s.workDir,
        capabilities: s.capabilities,
        isTurnRunning: s.isTurnRunning(),
        ...(activityService ? {
          activityPhase: activity?.phase ?? 'idle',
          activityAttention: activity?.attention ?? false,
        } : {}),
      };
    });
    // Only an opted-in controller may treat an absent runtime as idle. Legacy
    // callers keep the array response and its original absence semantics.
    if (options && typeof options === 'object' && !Array.isArray(options)
      && (options as Record<string, unknown>).summary === true
      && (options as Record<string, unknown>).snapshotVersion === 2) {
      return { format: 'active-sessions-v2', sessions };
    }
    return sessions;
  });

  ipcMain.handle(
    MAKER_INVOKE.RESOLVE_INTERACTION,
    async (event, requestId: unknown, decision: unknown) => {
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
      assertResolveInteractionOrigin(decision, isPendingDesktopOnlyConfirmation(requestId));
      const sharedTask = getDeviceLinkInvokeContext()?.sharedTask;
      if (sharedTask) {
        // The initial dispatch check may be separated from this handler by an
        // async DB admission. Recheck membership and pending-request ownership
        // immediately before resolving so a revoked guest cannot win the race.
        assertSharedTaskInteractionResolveCurrent(sharedTask, [requestId, decision]);
      }
      let pluginSetupResponseTarget: GhostSetupInteractionResponseTarget | undefined;
      if (isPluginSetupInteractionDecision(decision) && !isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event);
        if (decision.action === 'run_action') {
          // Electron's real sender identity stays outside the untrusted command
          // payload and is carried only through the Host-owned action path.
          pluginSetupResponseTarget = event.sender;
        }
      }
      if (resolvePendingInteraction(requestId, decision as InteractionDecision)) {
        return { accepted: true };
      }
      if (isPermissionInteractionDecision(decision)) {
        handleAgentIslandInteractionDismissedByRequestId(requestId);
      }
      // agent interaction 没命中 → 可能是 issue 确认卡(kind='issue_confirm',
      // pending 在 issueConfirmBridge 自己的 map 里)或批量改名确认卡。
      // 三边都 miss 才告警。
      if (issueConfirmBridge.resolve(requestId, decision)) return { accepted: true };
      if (renameSessionsConfirmBridge.resolve(requestId, decision)) return { accepted: true };
      if (!sharedTask && taskActionConfirmBridge.resolveFromIpc(requestId, decision, {
        isDeviceLink: isDeviceLinkInvoke(),
        assertTrustedSender: () => assertTrustedAppRendererEvent(event),
      })) return { accepted: true };
      if (
        orcaWorkerPermissionConfirmBridge.resolveFromIpc(requestId, decision, {
          isDeviceLink: isDeviceLinkInvoke(),
          assertTrustedSender: () => assertTrustedAppRendererEvent(event),
        })
      ) {
        return { accepted: true };
      }
      if (ghostGrantConfirmBridge.resolve(requestId, decision)) return { accepted: true };
      if (ghostSetupInteractionBridge.resolve(requestId, decision, pluginSetupResponseTarget)) {
        return { accepted: true };
      }
      if (await getBotAuthorizationService()?.resolve(requestId, decision, pluginSetupResponseTarget)) return { accepted: true };
      // 代输入: value-less decisions only (hand back / cancel / stay / refresh).
      // Values never use this generic channel; see INPUT_HANDOFF_LOCAL_CHANNEL.
      if (!sharedTask && getInputHandoffService()?.resolve(requestId, decision, inputHandoffActor())) return { accepted: true };
      log.warn('resolve-interaction: no pending resolver (likely already dismissed/timed out)', {
        requestId,
      });
      return { accepted: false };
    },
  );

  ipcMain.handle(MAKER_INVOKE.PLUGIN_SETUP_SUBMIT_INLINE, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = parseGhostSetupInlineSubmitRequest(raw);
    if (!request) throwIpcError('INVALID_PARAMS', 'invalid plugin setup submission');
    const { requestId, ...submit } = request;
    if (!ghostSetupInteractionBridge.submitInline(requestId, submit) && !(await getBotAuthorizationService()?.submit(requestId, submit))) {
      throwIpcError('INVALID_PARAMS', 'plugin setup interaction is not pending');
    }
  });

  // 快照:打开/重连/刷新会话时,renderer 拉当前挂起交互重建面板(本机 + device-link 远程共用)。
  ipcMain.handle(MAKER_INVOKE.GET_PENDING_INTERACTIONS, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId) return [];
    let pending = getPendingInteractionsForSession(sessionId);
    // Shared-task guests never see the owner's input handoff.
    if (getDeviceLinkInvokeContext()?.sharedTask)
      pending = pending.filter(({ request }) => request.kind !== 'input_handoff');
    return projectPendingInteractionsForRemote(pending, isDeviceLinkInvoke());
  });

  /**
   * 代输入 values: Cindy's own trusted top-level renderer only. Never on the
   * device-link allowlist; remote devices use the signed v3 exchange instead.
   * The payload is never logged, persisted or echoed back.
   */
  ipcMain.handle(INPUT_HANDOFF_LOCAL_CHANNEL, async (event, requestId: unknown, submission: unknown) => {
    if (isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', 'input handoff values must be entered on this Desktop');
    assertTrustedAppRendererEvent(event);
    if (typeof requestId !== 'string' || !requestId) throwIpcError('INVALID_PARAMS', 'requestId required');
    return { accepted: (await getInputHandoffService()?.submit(requestId, submission)) ?? false };
  });

  /** 代输入 screenshot step on this computer: shown in Cindy's own window only, never pushed or stored. */
  ipcMain.handle(INPUT_HANDOFF_LOCAL_PICTURE_CHANNEL, (event, requestId: unknown, revision: unknown) => {
    if (isDeviceLinkInvoke()) throwIpcError('PERMISSION_DENIED', 'input handoff pictures stay on this Desktop');
    assertTrustedAppRendererEvent(event);
    if (typeof requestId !== 'string' || !requestId || !Number.isSafeInteger(revision))
      throwIpcError('INVALID_PARAMS', 'requestId and revision required');
    return getInputHandoffService()?.picture(requestId, revision as number) ?? null;
  });

  // ── 运行时切换 (Stage 2 B) ───────────────────────────────────────────────
  // session 不存在(被 close / 还没 send 创建出来)就 no-op 不报错, 让 renderer
  // 可以乐观调用 (UI 更新先行, IPC 失败也不会回滚 UI, 老 agentManager 同语义)。

  /**
   * Agent 在另一台电脑上运行的任务：模型目录、来源、思考档与上下文窗口都属于那台电脑，本机目录
   * 不参与校验，由那台的 Agent 在切换时裁决(不认识的模型直接报错，任务保持原模型)。点选仍先
   * 记成意图、在发送时于同一把会话锁里落地，与本机任务一致。
   */
  const applyAgentDeviceRuntimeSelection = createAgentDeviceRuntimeSelection({
    hasSessionProvider, getSessionProvider, agentSwitchPending, agentSwitchDeps, wakeSessionInputAfterCredentialSwitch, isDeviceLinkInvoke, markRemoteSettingPersistedInsideHandler, maker, isSessionInTurn, withRehydrateCloseSuppressed, setSessionProvider, setSessionEffort, setSessionFastMode, persistSessionFields, updateScheduledPreference, broadcastSessionPatched, getSessionEffort, recordUserSessionRuntimeMutation, acceptSessionRuntimeMutation, broadcastSessionRuntimeProjection, log, assertAgentDeviceRouteUsable, readUsableAgentDeviceProviders,
    get contextOverflowRolloverHolder() { return contextOverflowRolloverHolder; },
  });

  const handleSetModel = createSessionModelSelection({
    isDeviceLinkInvoke, deviceLinkInvokeControllerSupports, captureSessionRuntimeControlOwnerEpoch, captureSharedTaskSettingGuard, sessionRuntimeControlOwnerEpochMatches, assertReviewSettingsUnlocked, getDbClient, canApplyAutomaticRuntimeSelection, agentSwitchPending, applyAgentDeviceRuntimeSelection, hasSessionProvider, hydrateSessionProvider, log, getSessionProvider, listSshCodexProviders, getSessionRuntimeControlSnapshot, maker, getDesktopProviderService, getActiveCatalog, resolveSessionRuntimeRefreshEffort, getSessionEffort, getSessionDbAgentKind, assertModelRouteUsable, resolveSessionRuntimeAxes, clearPendingCredentialSwitchForSession, agentSwitchDeps, wakeSessionInputAfterCredentialSwitch, markRemoteSettingPersistedInsideHandler, resolvePendingRuntimeAxisPatch, acceptSessionRuntimeMutation, getSessionFastMode, deferSessionRuntimeAxisMutation, getPendingCredentialSwitchTarget, broadcastSessionRuntimeProjection, isSessionInTurn, setSessionProvider, clearSessionProvider, setSessionEffort, setSessionFastMode, withRehydrateCloseSuppressed, getSessionLastLiveUsage, resolveConfiguredContextWindow, readStoredSessionContextWindowBudget, rehydrateColdPiRuntimeForWindowVerification, recordRecoveredSessionRuntimeMutation, recordRecoveredSessionRuntimeAxisMutation, broadcastSessionPatched, getCurrentDbClientSnapshot, captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent, applyRuntimeSetModelChange, registerPendingCredentialSwitchForSession, getCodexProxyAuthInjectionState, persistSessionFields, updateScheduledPreference, recordUserSessionRuntimeMutation, settlePendingSessionRuntimeMutation, acceptSessionRuntimeAxisMutation, recordSessionContextSnapshot, withSendToSessionLock, get pendingCredentialSwitchHolder() { return pendingCredentialSwitchHolder; }, get contextOverflowRolloverHolder() { return contextOverflowRolloverHolder; }
  });
  applyPiModelSettingsRefresh = async (sessionId, model, providerId) => {
    const generation = getSessionRuntimeControlSnapshot(sessionId).generation;
    const result = await handleSetModel(sessionId, model, providerId, undefined, undefined, {
      source: 'agent', sessionLockHeld: true, applyingUserSelectionOnSend: true,
      expectedGeneration: generation, refreshPiConfiguration: true,
    });
    if (result.contextWindowConfirmationRequired) {
      throw new Error('Pi model settings need a smaller context window; confirm the switch before continuing');
    }
  };
  applyPiPendingSelection = createPendingPiModelSelection(handleSetModel, sessionRuntimeControlOwnerEpochMatches);

  applyPiImModelSelectionHolder = async (sessionId, model, providerId, previousRoute, options) => {
    const result = await handleSetModel(sessionId, model, providerId, undefined, undefined, {
      source: options?.source ?? 'user', sessionLockHeld: true, applyingUserSelectionOnSend: true,
      ...(previousRoute ? { previousPiRoute: previousRoute } : {}),
      ...(options?.refreshPiConfiguration ? { refreshPiConfiguration: true } : {}),
    });
    if (result.superseded) throw new Error('Pi model selection was superseded');
    if (result.contextWindowConfirmationRequired) {
      throw new Error('Pi model selection needs confirmation for its smaller context window');
    }
    return {
      status: result.deferred ? 'deferred' : 'applied',
      generation: result.generation,
      effectiveProviderId: result.effectiveProviderId,
    };
  };
  applySessionRuntimeSelection = (sessionId, model, providerId, selection, options) =>
    handleSetModel(sessionId, model, providerId, undefined, selection, options);
  registerSessionSetModelHandler(makerSessionRegistry, {
    isDeviceLinkInvoke,
    assertTrustedSender: (event) => assertTrustedAppRendererEvent(
      event as Parameters<typeof assertTrustedAppRendererEvent>[0],
    ),
    apply: (sessionId, model, providerId, revision, selection) => {
      // 用户动手换模型或来源即视为接手:在进入切换(含等锁、重建会话)之前就撤销额度等待,
      // 不让到点的续跑抢在切换期间派发。切换失败时错误与手动重试仍在,不恢复等待。
      if (typeof sessionId === 'string') {
        usageLimitAutoResume.noteUserAction(sessionId);
        providerGroupService?.noteUserAction(sessionId);
        agentInputCoordinatorHolder?.cancelUsageLimitWait(sessionId);
      }
      return handleSetModel(sessionId, model, providerId, revision, selection, { source: 'user' });
    },
  });

  registerSessionRuntimeAxisHandlers(ipcMain, {
    sessionRuntimeControlOwnerEpochMatches, withRehydrateCloseSuppressed, maker, setSessionEffort, setSessionFastMode, getSessionProvider, recordRecoveredSessionRuntimeAxisMutation, broadcastSessionRuntimeProjection, log, agentSwitchDeps, readUsableAgentDeviceProviders, getDesktopProviderService, getActiveCatalog, resolveSessionRuntimeAxes, persistSessionFields, agentSwitchPending, wakeSessionInputAfterCredentialSwitch, isDeviceLinkInvoke, assertTrustedAppRendererEvent, captureSessionRuntimeControlOwnerEpoch, captureSharedTaskSettingGuard, updateScheduledPreference, markRemoteSettingPersistedInsideHandler, getDbClient, updateSavedScheduledAxis, resolvePendingRuntimeAxisPatch, recordUserSessionRuntimeAxisMutation, readSessionRuntimeProfiles, withSendToSessionLock, assertReviewSettingsUnlocked, createSubscriptionFastPolicy, get pendingCredentialSwitchHolder() { return pendingCredentialSwitchHolder; }
  });

  ipcMain.handle(
    MAKER_INVOKE.SET_PERMISSION_MODE,
    async (event, sessionId: unknown, mode: unknown) => {
      // 轮 40-w4-t6 CRITICAL:切到 bypassPermissions 是高风险授权 —— 本地 raw IPC
      // 必须来自受信顶层 renderer(UI 的 Full access 确认在 ChatInput 侧), 否则
      // 任意 WebView/Ghost 可绕过确认直切 Full access(Pi 热读权限文件立即放行)。
      // device-link 远程控制端已由 remoteControlEnabled + revoke + allowlist 授权,
      // 按既有契约放行。
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
      }
      if (typeof sessionId !== 'string' || typeof mode !== 'string') {
        throwIpcError('INVALID_PARAMS', 'sessionId + mode required');
      }
      if (!isSessionPermissionMode(mode)) {
        throwIpcError('INVALID_PARAMS', 'invalid permission mode');
      }
      const snapshot = getCurrentDbClientSnapshot();
      const remote = isDeviceLinkInvoke();
      const assertOwnerCurrent = () => {
        if (!snapshot || snapshot !== getCurrentDbClientSnapshot()) {
          throwIpcError('PRECONDITION_FAILED', 'Account changed during permission update');
        }
      };
      return withSessionPermissionChange(sessionId, async () => {
        assertOwnerCurrent();
        await assertReviewSettingsUnlocked(sessionId);
        assertOwnerCurrent();
        const [row] = await snapshot!.client.drizzle.select({permissionMode: sessions.permissionMode})
          .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        assertOwnerCurrent();
        if (!row) throwIpcError('NOT_FOUND', 'session not found');
        const sess = maker.getSession(sessionId);
        let runtimeChanged = false;
        try {
          if (sess) {
            await sess.setPermissionMode(mode as PermissionMode);
            runtimeChanged = true;
          }
          assertOwnerCurrent();
          const saved = await snapshot!.client.tx('bots.persistSessionPermission', {sessionId, mode});
          if (!saved.updated) throwIpcError('NOT_FOUND', 'session not found');
          assertOwnerCurrent();
        } catch (error) {
          // Keep recovery inside the same permission operation so it cannot
          // overwrite a later user choice. Never recover into a new account.
          if (runtimeChanged && sess && snapshot === getCurrentDbClientSnapshot()) {
            await sess.setPermissionMode(row.permissionMode as PermissionMode).catch((rollbackError) => {
              log.warn('permission runtime rollback failed', {sessionId, error: String(rollbackError)});
            });
          }
          throw error;
        }
        // 分享供应商的「本任务总是允许」随权限档变化失效；Agent 实例被回收时执行器收不到这次切换。
        if (row.permissionMode !== mode) forgetCredentialGrants(sessionId);
        broadcastSessionPatched(sessionId, { permissionMode: mode });
        if (remote) {
          const result = {};
          markRemoteSettingPersistedInsideHandler(result);
          return result;
        }
        return true;
      });
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.SET_PLAN_MODE,
    async (event, sessionId: unknown, enabled: unknown) => {
      // 轮 24-I3 HIGH:会话变更型 IPC 统一 sender 校验(对齐 SET_PERMISSION_MODE)。
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
      }
      if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'sessionId + enabled required');
      }
      const snapshot = getCurrentDbClientSnapshot();
      const remote = isDeviceLinkInvoke();
      const assertOwnerCurrent = () => {
        if (!snapshot || snapshot !== getCurrentDbClientSnapshot())
          throwIpcError('PRECONDITION_FAILED', 'Account changed during Plan update');
      };
      return withSessionPermissionChange(sessionId, async () => {
        assertOwnerCurrent();
        await assertReviewSettingsUnlocked(sessionId);
        assertOwnerCurrent();
        const [row] = await snapshot!.client.drizzle.select({planModeEnabled: sessions.planModeEnabled})
          .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        assertOwnerCurrent();
        if (!row) throwIpcError('NOT_FOUND', 'session not found');
        const sess = maker.getSession(sessionId);
        try {
          if (sess) await sess.setPlanMode(enabled);
          assertOwnerCurrent();
          if (maker.getSession(sessionId) !== sess) throwIpcError('PRECONDITION_FAILED', 'Session changed during Plan update');
          await persistSessionFields(sessionId, {planModeEnabled: enabled});
          assertOwnerCurrent();
        } catch (error) {
          // A provider may change its runtime before rejecting. Preserve the
          // existing best-effort recovery, inside this same complete commit.
          if (sess && snapshot === getCurrentDbClientSnapshot() && maker.getSession(sessionId) === sess) {
            await sess.setPlanMode(!!row.planModeEnabled).catch((rollbackError) => {
              log.warn('Plan runtime rollback failed', {sessionId, error: String(rollbackError)});
            });
          }
          throw error;
        }
        // 计划模式同属权限档：分享供应商的「本任务总是允许」随之失效(同上)。
        if (!!row.planModeEnabled !== enabled) forgetCredentialGrants(sessionId);
        if (remote) {
          const result = {};
          markRemoteSettingPersistedInsideHandler(result);
          return result;
        }
      });
    },
  );

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
    const parent =
      BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined;
    const defaultPath = path.join(app.getPath('documents'), 'cindy-session.html');
    const picked = await dialog.showSaveDialog(parent!, {
      title: t('ccAgent.sidebar.sessionMenu.exportHtml'),
      defaultPath,
      filters: [{ name: 'HTML', extensions: ['html'] }],
    });
    if (picked.canceled || !picked.filePath) return null;
    const written = await sess.exportSessionHtml(picked.filePath);
    // 导出完成后在文件管理器中高亮该文件(与常见「导出并显示」体验一致)。
    shell.showItemInFolder(written);
    return written;
  });

  ipcMain.handle(
    MAKER_INVOKE.COMPACT_SESSION,
    async (event, sessionId: unknown, instructions: unknown) => {
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
    },
  );

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
        status: sessions.status,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row) return null;
    // 轮 40-w3 MEDIUM:会话树是历史浏览入口, lazy resume 会**复活**会话
    // (重建 desktop 内存 session + 远端 daemon session)。已归档/软删除的
    // 会话必须保持死态 —— 只允许 active 会话被懒恢复, 否则「查看会话树」
    // 这个只读动作会让产品持久态(归档/删除)与运行态(活跃进程)分叉。
    if (row.status !== 'active') {
      log.debug('session-tree: skip lazy resume for non-active session', {
        sessionId,
        status: row.status,
      });
      return null;
    }
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
      fastMode: (row.fastMode ?? false),
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
    if (extraDirs.length > 0) Object.assign(createOpts, directoryGrantsForRuntime(extraDirs));
    const writableDirs = await readSessionWritableDirsFromDb(sessionId).catch(() => []);
    if (writableDirs.length > 0) createOpts.writableDirs = writableDirs;
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
      if (
        parsed.customInstructions !== undefined &&
        typeof parsed.customInstructions !== 'string'
      ) {
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
      clearSessionThinkingSnapshots(sessionId);
      resetTurnPersistState(sessionId);

      // 多窗口与 device-link 控制端先清旧投影，再按 DB 真相补当前活动路径。
      if (hiddenClientIds.length > 0) {
        broadcastMessageDeleted({
          sessionId,
          clientId: hiddenClientIds[0],
          clientIds: hiddenClientIds,
        });
      }
      const visibleRows = await getDbClient()
        .drizzle.select()
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

  ipcMain.handle(
    MAKER_INVOKE.SET_THINKING_ENABLED,
    async (event, sessionId: unknown, enabled: unknown) => {
      if (!isDeviceLinkInvoke()) {
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
      }
      if (typeof sessionId !== 'string' || typeof enabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'sessionId + enabled required');
      }
      const assertSharedTaskCurrent = captureSharedTaskSettingGuard(sessionId);
      await assertReviewSettingsUnlocked(sessionId);
      assertSharedTaskCurrent();
      const sess = maker.getSession(sessionId);
      if (!sess) return;
      assertSharedTaskCurrent.admit();
      await sess.setThinkingEnabled(enabled);
    },
  );

  // 两类目录授权均在同一 session 锁内完成校验、运行时应用与持久化。
  // session 不在 / capability 不支持都 no-op, 不抛错 — 跟 setModel 容错语义一致。
  ipcMain.handle(MAKER_INVOKE.SET_EXTRA_DIRS, async (event, sessionId: unknown, dirs: unknown) => {
    // 轮 24-I3 HIGH:SET_EXTRA_DIRS 会扩展 agent 的文件可见面(任意已存在绝对目录
    // 加入额外可读范围)—— 必须 sender 校验, 否则受污染页面可扩大文件访问。
    const deviceLinkInvoke = isDeviceLinkInvoke();
    if (!deviceLinkInvoke) {
      assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    }
    if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
    if (!Array.isArray(dirs)) throwIpcError('INVALID_PARAMS', 'dirs must be string[]');
    const requested = (dirs as string[]).filter((dir) => typeof dir === 'string' && !isLibraryExtraDirSlot(dir));
    return applyDirectoryGrants('extraDirs', sessionId, requested, {
      remote: deviceLinkInvoke,
      ...(!deviceLinkInvoke ? { senderId: event.sender.id } : {}),
    });
  });

  ipcMain.handle(
    MAKER_INVOKE.SET_WRITABLE_DIRS,
    async (event, sessionId: unknown, dirs: unknown) => {
      const deviceLinkInvoke = isDeviceLinkInvoke();
      if (!deviceLinkInvoke) {
        assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
      }
      if (typeof sessionId !== 'string') throwIpcError('INVALID_PARAMS', 'sessionId required');
      if (!Array.isArray(dirs)) throwIpcError('INVALID_PARAMS', 'dirs must be string[]');
      return applyDirectoryGrants('writableDirs', sessionId, dirs as string[], {
        remote: deviceLinkInvoke,
        ...(!deviceLinkInvoke ? { senderId: event.sender.id } : {}),
      });
    },
  );

  // ── Memory 控制 ────────────────────────────────────────────────────────
  // 透传到 maker.{getAgentMemoryStatus, setAgentMemory, resetAgentMemory},
  // 真实落地在 BaseAgent 子类 (Claude / Codex)。renderer 拿到 status 渲染 toggle,
  // setMemory 后按 result.effective ('immediate' | 'next-session') 决定是否提示
  // "新会话生效"; reset 前必走 confirm dialog (UI 层负责)。
  ipcMain.handle(MAKER_INVOKE.MEMORY_GET, async (_e, agentKind: unknown) => {
    if (agentKind !== 'claude-code' && agentKind !== 'codex' && agentKind !== 'pi') {
      throwIpcError(
        'INVALID_PARAMS',
        `agentKind required (claude-code | codex | pi), got ${String(agentKind)}`,
      );
    }
    return maker.getAgentMemoryStatus(agentKind);
  });

  ipcMain.handle(MAKER_INVOKE.MEMORY_SET, async (_e, agentKind: unknown, enabled: unknown) => {
    if (agentKind !== 'claude-code' && agentKind !== 'codex' && agentKind !== 'pi') {
      throwIpcError(
        'INVALID_PARAMS',
        `agentKind required (claude-code | codex | pi), got ${String(agentKind)}`,
      );
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
      throwIpcError(
        'INVALID_PARAMS',
        `agentKind required (claude-code | codex | pi), got ${String(agentKind)}`,
      );
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
  registerPluginListHandler(createElectronIpcHandlerRegistry(), {
    getPluginRegistry,
    isBotToolsetAvailable,
    assertBotQuery: (event) => {
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event as Parameters<typeof assertTrustedAppRendererEvent>[0]);
    },
  });

  // Read one plugin's enable state by id. Unlike PLUGINS_LIST this does NOT skip
  // hidden (HOSTED_ELSEWHERE) plugins, so a dedicated Settings section (e.g.
  // 「电脑使用」for `browser`) can read its real project-override state.
  ipcMain.handle(
    MAKER_INVOKE.PLUGINS_GET_STATE,
    async (_e, id: unknown, workingDir: unknown, workspaceKind: unknown) => {
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
                isManagedDialogueWorkspace(candidate),
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
    },
  );

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
    if (!GLOBAL_PLUGIN_IDS.has(id) && id !== 'browser') {
      return { codexMcpRefreshed: true };
    }
    // Machine-wide tools keep their existing lifecycle. The preference is
    // already durable at this point, so refresh best-effort; a busy turn must
    // keep using the existing bridge and must not turn a successful save into
    // an IPC failure. Renderer surfaces the deferred state explicitly.
    return refreshCodexMcpEnvironment({
      restartCodex: restartCodexAfterAuthModeChange,
      shutdownCodexEnvironment,
      onDeferred: () =>
        deferredCodexRestartHolder?.schedule('Codex Browser capability routing changed'),
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
    if (!GLOBAL_PLUGIN_IDS.has(id) && id !== 'browser') {
      return { codexMcpRefreshed: true };
    }
    return refreshCodexMcpEnvironment({
      restartCodex: restartCodexAfterAuthModeChange,
      shutdownCodexEnvironment,
      onDeferred: () =>
        deferredCodexRestartHolder?.schedule('Codex Browser capability routing changed'),
      logger: log,
    });
  });

  registerProjectPluginPolicyHandlers(createElectronIpcHandlerRegistry(), { getPluginRegistry });

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
      if (isBrowserOpenForLoginError(err)) {
        throwIpcError(err.code, err.code);
      }
      log.warn('browser.openForLogin failed', err);
      throwIpcError('INTERNAL', 'Failed to open the agent browser.');
    }
  });

  // ── Local desktop computer-use (Settings →「电脑使用」) ─────────────────
  // Probe the installed CuaDriver used by the phase-one Computer Use runtime.
  ipcMain.handle(
    MAKER_INVOKE.COMPUTER_STATUS,
    async (
      _event,
      options?: ComputerStatusRequest,
    ) => {
      try {
        return await readComputerStatusForSettings(options, {
          getStatus: getComputerDriverStatus,
          refreshPermissionGuide: refreshComputerPermissionGuideWindow,
        });
      } catch (err) {
        throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
      }
    },
  );

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
      return await grantComputerDriverPermissions(initialStatus);
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

  ipcMain.on(
    MAKER_SEND.COMPUTER_PERMISSION_APP_DRAG_START,
    (_event, payload?: { iconDataUrl?: unknown }) => {
      startComputerPermissionAppDrag(_event.sender, payload?.iconDataUrl);
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.COMPUTER_PERMISSION_APP_DRAG_END,
    async (_event, payload?: { didCopy?: unknown }) => {
      return finishComputerPermissionAppDrag(_event.sender, payload?.didCopy);
    },
  );

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

  // 查询型:失败通过 checkStatus 返回，保留已知版本供页面显示和重试。
  ipcMain.handle(MAKER_INVOKE.COMPUTER_CHECK_UPDATE, async (_event, options?: { force?: boolean }) => {
    try {
      return await checkComputerDriverUpdate(undefined, { force: options?.force === true });
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
  });

  // 更新执行:in-flight 托管在 main,设置窗口关闭安装照常跑完;重开面板
  // 再调用会 join 同一个安装 Promise,不会重复安装。下载进度经广播推给
  // 所有窗口(join 的调用方天然共享同一份进度流)。
  ipcMain.handle(
    MAKER_INVOKE.COMPUTER_UPDATE_DRIVER,
    async (_event, opts?: { joinOnly?: boolean }) => {
      try {
        return await updateComputerDriver(
          (progress) => {
            for (const win of BrowserWindow.getAllWindows()) {
              if (!win.isDestroyed()) {
                win.webContents.send('computer-driver-update-progress', progress);
              }
            }
          },
          { joinOnly: opts?.joinOnly === true },
        );
      } catch (err) {
        throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
      }
    },
  );

  // ── Plugin hub (Phase 2) ──────────────────────────────────────────────────

  log.info('maker:* IPC handlers registered');
}

const generatedImageDelivery = createGeneratedImageDelivery({
  invoke: remoteBackgroundInvoke,
  publish: (sessionId, event, persistId, resolvedContent) => {
    broadcastToAllWindows(MAKER_PUSH.EVENT, { sessionId, event, persistId, resolvedContent }, captureDataOwnerBroadcastScope());
  },
  readSource: async (_sessionId, image, session) => {
    if (image.pathOrigin === 'remote-agent') throw new Error('REMOTE_SOURCE_REQUIRED');
    if (session.remoteHostId) {
      if (!image.path || !session.workingDir) throw new Error('REMOTE_SOURCE_REQUIRED');
      const result = await materializeSshRemoteMedia({ remoteHostId: session.remoteHostId, workdir: session.workingDir },
        `xdt-file://?path=${encodeURIComponent(image.path)}`, undefined, { maxBytes: MAX_GENERATED_IMAGE_BYTES });
      if (!result.ok) throw new Error('REMOTE_SOURCE_REQUIRED');
      return readGeneratedImageFile(result.cachePath);
    }
    const managed = image.url?.startsWith('cindy-media://') ? resolveCindyMediaUrl(image.url)
      : image.url?.startsWith('xdt-image://') ? imageCacheStore.resolveSafe(image.url) : undefined;
    if (managed) {
      try { return await readGeneratedImageFile(managed.absPath); }
      catch (error) { if (!image.path) throw error; }
    }
    const source = image.path;
    if (!source) throw new Error('MEDIA_SOURCE_MISSING');
    return readGeneratedImageFile(source);
  },
});
setGeneratedImageRecovery((sessionId) => generatedImageDelivery.recover(sessionId), () => generatedImageDelivery.reconcile());

async function broadcastCodexImageAsToolResult(sessionId: string, event: AgentEvent): Promise<void> {
  try { await generatedImageDelivery.deliver(sessionId, event); }
  catch { log.warn('Codex generated image delivery could not be persisted', { sessionId }); }
}

function broadcastSyntheticToolEvent(
  sessionId: string,
  event: AgentEvent & { type: 'tool_use' | 'tool_result' | 'tool_result_full' },
): void {
  const prepared = prepareSyntheticToolEventForBroadcast(
    sessionId,
    { type: event.type, data: event.data },
    (event.agentMeta as AgentMeta | null | undefined) ?? null,
  );
  broadcastToAllWindows(MAKER_PUSH.EVENT, {
    sessionId,
    event,
    persistId: prepared.persistId,
    resolvedContent: prepared.resolvedContent,
  });
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
const checkWorkDirExists = createWorkingDirectoryPreflight({
  workingDirectoryRecovery,
  statWorkingDirectory,
  readBoundWorkingDir: async (sessionId) => {
    const liveWorkingDir = getMakerIfReady()?.getSession(sessionId)?.workDir || null;
    const persistedWorkingDir = await readSessionWorkingDirFromDb(sessionId).catch(() => null);
    return [liveWorkingDir, persistedWorkingDir];
  },
  getUserDataPath: () => app.getPath('userData'),
  isCindyMakeWorktreePath: isCindyMakeManagedWorktreePath,
  assertCindyMakeWorkspace,
  getManagedWorktreeBasePath,
  getManagedWorktreeReadinessForSession,
  findSimilarDirOnDisk,
  listActiveSessions: () => getMaker().listActiveSessions(),
  emitWorkDirMissingError,
  workdirLog,
  log,
});
/**
 * ENOENT 兜底:扫一下 parent 目录,找一个 trim/大小写 后等于目标 basename 的真实条目。
 * 命中的最典型场景是 macOS Finder 里目录名末尾带了不可见空格,而 sessions.ts 写库时
 * 做了 .trim() 把空格砍了 —— DB 里存的路径在磁盘上不存在,但同名带空格的目录是存在的。
 * 普通诊断失败返回 null；文件系统不可用交给 recovery 的统一 fallback。
 */

function broadcastToAllWindows(
  channel: string,
  payload: unknown,
  ownerScope?: ReturnType<typeof captureDataOwnerBroadcastScope>,
): void {
  if (ownerScope && !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
  const ownerStamp = ownerScope ? ownerScope.ownerStamp : getActiveDataOwnerPushStamp();
  if (
    channel === MAKER_PUSH.ORCA_WORKER_CHANGED &&
    payload &&
    typeof payload === 'object' &&
    typeof (payload as { leadSessionId?: unknown }).leadSessionId === 'string'
  ) {
    invalidateWorkersByLeadSingleFlight((payload as { leadSessionId: string }).leadSessionId);
  }
  // device-link 被控端旁路:命中转发白名单且存在控制链路时,把事件转发给控制端
  // (无 link 时 O(1) no-op,不进 maker-core 热路径成本)
  // 旁路永远不能反向阻断本机生命周期。owner boundary 切换期间远端链路
  // 可能暂不可用；如果异常冒泡，Session 的 status/terminal listener 会在
  // 清理前中止，最终留下 tracker busy + 死进程，所有后续消息永久排队。
  try {
    if (ownerStamp === undefined) tapWindowBroadcast(channel, payload);
    else tapWindowBroadcast(channel, payload, ownerStamp);
  } catch (err) {
    log.warn('device-link broadcast tap failed; keeping local broadcast alive', {
      channel,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      if (ownerStamp === undefined) win.webContents.send(channel, payload);
      else win.webContents.send(channel, payload, ownerStamp);
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
    tapWindowBroadcast(MAKER_PUSH.NEW_MAKER_DRAFT_CHANGED, getRemoteNewMakerDefaultsByVendor());
  }, 0);
}

const originalSilentStopRuntime=createSilentStopRuntime({
 get agentInputCoordinatorHolder(){return agentInputCoordinatorHolder;},
 silentStopTurnLeaseGate,silentStopAutoResumeGuard,productTurnWallClockTracker,
 advanceRuntimeRecoveryNotice,createDbMessage,settleSilentStopDone,broadcastToAllWindows,MAKER_PUSH,log,
});
function handleSilentStopTurnEnd(...args:Parameters<typeof originalSilentStopRuntime.handleSilentStopTurnEnd>) {
 return originalSilentStopRuntime.handleSilentStopTurnEnd(...args);
}

const originalSessionEventGuards=createSessionEventGuards({coordinator:()=>agentInputCoordinatorHolder,currentLedgerCurrency});
