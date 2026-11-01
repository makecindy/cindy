import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';
import { createSessionFork } from '@cindy/app-runtime/sessionFork';
import { createSessionForkIpc } from '@cindy/app-runtime/sessionForkIpc';
import { createSessionRewind } from '@cindy/app-runtime/sessionRewind';
import { createSessionRewindIpc } from '@cindy/app-runtime/sessionRewindIpc';
import { createSessionRewindInputBoundary } from '@cindy/app-runtime/sessionRewindInputBoundary';
import { registerMakerMessageDeleteHandler } from '@cindy/app-runtime/messageDeleteHandler';
import { registerMakerReadHandlers } from '@cindy/app-runtime/makerReadHandlers';
import { createOfflineHistoryAgent } from '../models/runtime.js';
import { terminalNodeExecutable } from '../version.js';
import { runNative } from '../engines/native.js';
import {createBotTodoDelivery} from '@cindy/app-runtime/botTodoDelivery';
import type {createBotTodoAccess} from '@cindy/app-runtime/botTodoAccess';
import { createBotGroupChatRuntime, type BotGroupChatService, type BotGroupChatServiceDeps } from '@cindy/app-runtime/botGroupChatService';
import { createBotGroupAttachmentRuntime } from '@cindy/app-runtime/botGroupAttachments';
import { createBotGroupWorkDir } from '@cindy/companion-core/botGroupWorkDir';
import { createBotGroupPlanDecider } from '@cindy/app-runtime/botGroupPlanDecider';
import { settleUndispatchedBotGroupTurn } from '@cindy/app-runtime/botGroupRuntimeFailure';
import { createBotGroupStepNotification, type BotGroupStepNotificationDelivery } from '@cindy/app-runtime/botGroupStepNotification';
import { createBotImSendGuard } from '@cindy/app-runtime/botImSendGuard';
import { createBotCapabilityPreflight } from '@cindy/app-runtime/botCapabilityPreflight';
import { createBotGroupRemoteResources } from '@cindy/app-runtime/botGroupRemoteResourceProvider';
import { registerBotGroupHandlers } from '@cindy/app-runtime/botGroupHandlers';
import { createSessionPermissionPersistence, isSessionPermissionMode } from '@cindy/app-runtime/sessionPermissionPersistence';
import { createProjectDirectoryValidation } from '@cindy/app-runtime/projectDirectoryValidation';
import { parseRemoteAttachmentRef } from '@cindy/app-runtime/remoteAttachment';
import { botSessionLinks } from '@cindy/runtime-db/schema';
import {prepareHandoffWorktree} from '@cindy/app-runtime/handoffWorktree';
import {createBotImConnectionStore} from '@cindy/app-runtime/botImConnectionStore';
import {resolveHelperSurface} from '@cindy/app-runtime/helperSurface';
import {createTaskActionHost} from '@cindy/app-runtime/taskActionHost';
import {createTaskTags} from '@cindy/app-runtime/taskTags';
import {createSessionBatchHelper} from '@cindy/app-runtime/sessionBatchHelper';
import {createHistoryRemoteDeps} from '@cindy/app-runtime/historyDevices';
import {readChatHistoryMessages} from '@cindy/app-runtime/remoteChatHistory';
import {createRemoteSessionsStatusSetter} from '@cindy/app-runtime/sessionStatusRemote';
import {createTaskToolCallAuthorizer} from '@cindy/app-runtime/taskToolCallAuthorizer';
import {resolveGhostFsSessionSnapshot} from '@cindy/app-runtime/ghostFsSessionSnapshot';
import {OrcaWorkerPermissionConfirmBridge} from '@cindy/app-runtime/orcaWorkerPermissionConfirmBridge';
import {createBotRuntimeRestoreCoordinator} from '@cindy/app-runtime/botRuntimeRestore';
import {createBotLifecycleRuntime,type BotLifecycleServiceDeps} from '@cindy/app-runtime/botLifecycleService';
import {registerBotLifecycleActionHandler} from '@cindy/app-runtime/botLifecycleHandlers';
import {restartBotRuntime} from '@cindy/app-runtime/botRuntimeRestart';
import {registerBotDelegationHandlers} from '@cindy/app-runtime/botDelegationHandlers';
import {createBotDelegationRuntime,discardDelegationQueuedInputs,type BotDelegationService,type BotDelegationServiceDeps} from '@cindy/app-runtime/botDelegationService';
import {createBotDelegationParentLifecycle} from '@cindy/app-runtime/botDelegationLifecycle';
import {createBotSessionTaskRouteBridge} from '@cindy/app-runtime/botSessionTaskRouteBridge';
import {createAgentRequestCapture} from '@cindy/app-runtime/agentRequestCapture';
import {TaskActionAuthorizationError,bindTaskActionInput,type TaskActionDeliveryGuard} from '@cindy/app-runtime/taskActionAuthorization';
import {createTerminalSessionControl} from './session-control.js';
import {createTerminalSkillReader} from '../models/skills.js';
import {registerSearchHandlers} from '@cindy/app-runtime/searchHandlers';
import {registerBotContentHandlers} from '@cindy/app-runtime/botContentHandlers';
import {createBotSessionDispatcher,type BotSessionMessage} from '@cindy/app-runtime/botSessionDispatcher';
import {createSessionSenderIdentityReader} from '@cindy/app-runtime/sessionSenderIdentity';
import {sessionQueueOriginForDispatcher} from '@cindy/app-runtime/sessionQueueOrigin';
import {commitBotAuthorizationInput} from '@cindy/app-runtime/botAuthorizationDelivery';
import {createQueuedDispatchReceipts} from '@cindy/app-runtime/queuedDispatchReceipts';
import {applyBotRuntimeToolPolicy} from '@cindy/app-runtime/botRuntimeToolPolicy';
import {registerBotProfileHandlers} from '@cindy/app-runtime/botProfileHandlers';
import {botProfiles as botProfileRows} from '@cindy/runtime-db/schema';
import {isBotMcpServerAllowed} from '@cindy/maker-core';
import {openTerminalBotServices,type TerminalBotServices,type TerminalBotServicesHost} from './bot-services.js';
import {createBotModelRouteReconciler} from '@cindy/app-runtime/botModelRouteReconciler';
import {createBotModelRouteReader} from '@cindy/app-runtime/botModelRouteReader';
import {createBotRuntimeRefreshHost} from '@cindy/app-runtime/botRuntimeRefreshHost';
import {refreshBotRuntimeAfterModelSelection} from '@cindy/app-runtime/botCompactRuntimeRefresh';
import {isBotCanonicalReplacementBusy} from '@cindy/app-runtime/botCanonicalReplacementGuard';
import {createAuxiliaryTextRequest} from '@cindy/app-runtime/auxiliaryText';
import type {BotProfileRuntimeDeps} from '@cindy/app-runtime/botProfileRuntime';
import {MAKER_PUSH} from '@cindy/maker-shared/maker-channels';
import {createAppDefaultModelControl} from '@cindy/app-runtime/appDefaultModelControl';
import {createCompanionLocalHistory} from '@cindy/app-runtime/companionLocalHistory';
import {openTerminalMediaRuntime,type TerminalMediaRuntime} from './media-runtime.js';
import {TerminalPiRuntimeOwner} from '../pi-runtime.js';
import { describeModelRouteRejection } from '@cindy/model-providers/model-route-guard';
import { createTerminalModelSelection } from './model-selection.js';
import { createColdPiRehydrationForWindowVerification } from '@cindy/app-runtime/coldPiRehydration';
import { createSessionLastLiveUsage } from '@cindy/app-runtime/sessionLastLiveUsage';
import { createSessionStorage as createOriginalSessionStorage } from '@cindy/runtime-db/sessionStorage';
import { normalizeDeviceLinkSetModelWireArgs } from '@cindy/app-runtime/setModelWireArgs';
import { CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1 } from '@cindy/device-link';
import { createSessionBindingLifecycle, runSessionCloseCleanup } from '@cindy/app-runtime/sessionBindingLifecycle';
import { createTerminalRuntimeRecovery } from './runtime-recovery.js';
import { createAutoResumeInputLifecycle } from '@cindy/app-runtime/autoResumeInputLifecycle';
import { createSchedulerRecoveryBridge } from '@cindy/app-runtime/schedulerRecoveryBridge';
import { createSessionRuntimeControl } from '@cindy/app-runtime/sessionRuntimeControl';
import { createScheduledModelProjection } from '@cindy/app-runtime/scheduledModelProjection';
import { parseScheduledModelBaseline } from '@cindy/app-runtime/scheduledModelBaseline';
import { createSessionRuntimeAxes } from '@cindy/app-runtime/sessionRuntimeAxes';
import { createMakerScheduleRunner, type ScheduleMaker } from '@cindy/app-runtime/schedulePromptRunner';
import { createSchedulerQueueBridge } from '@cindy/app-runtime/schedulerQueueBridge';
import { runSchedulerQueuedPreparation, type SchedulerQueuedPreparation } from '@cindy/app-runtime/schedulerQueuedPreparation';
import { createCredentialModeSwitch } from '@cindy/app-runtime/credentialModeSwitch';
import { createCodexProviderIdentity, type AppliedCodexProviderRoute } from '@cindy/app-runtime/codexProviderIdentity';
import { createScheduledTargetRestore } from '@cindy/app-runtime/scheduledTargetRestore';
import { createScheduledWorkdirResolver } from '@cindy/worktree-core/scheduledWorkdir';
import { shouldApplyExclusiveProviderReroute } from '@cindy/model-providers/model-route-guard';
import { createTerminalScheduledModels } from './scheduled-models.js';
import { createTerminalSessions } from './sessions.js';
import { createTerminalNativeHistory } from './native-history.js';
import { createTerminalNativeArchive } from './native-archive.js';
import { resolveSessionContextWindow } from '@cindy/app-runtime/sessionContextWindow';
import { createClaudeTranscriptRelocation } from '@cindy/app-runtime/claudeTranscriptRelocation';
import { CindyMakeManager } from '@cindy/app-runtime/cindyMakeManager';
import { isSessionTurnDispatchBoundaryBusy } from '@cindy/app-runtime/sessionTurnActivityTracker';
import { createTerminalSessionActivity } from './activity.js';
import {TerminalMcpApps} from './mcp-apps.js';
import {createAppMessageSender} from '@cindy/app-runtime/mcp-apps/messageSender';
import {createSessionControlInputBuilder} from '@cindy/app-runtime/sessionControlInput';
import {MCP_APPS_INVOKE} from '@cindy/maker-shared/mcp-apps';
import type {TerminalSshService} from '../ssh.js';
import { type SessionRestoreOptions } from '@cindy/app-runtime/sessionRestore';
import { createSessionQueueReader } from '@cindy/app-runtime/sessionQueueReader';
import { createTerminalHistory } from './history.js';
import type {ChatEmbeddingDefaultContext} from '@cindy/app-runtime/chatEmbeddingSettingsStore';
import {makerToDbAgentKind,dbToMakerAgentKind} from '@cindy/maker-shared/agent-kind-conversion';
import { captureProductTurnFailureOwner, type ProductTurnFailureOwner } from '@cindy/app-runtime/productTurnFailureOwner';
import { isTerminalTurnErrorEvent } from '@cindy/app-runtime/sessionTurnActivityTracker';
import {createTerminalTaskEvents,type TerminalEventBindings} from './events.js';
import {createTerminalUsageApi} from '../models/usage-api.js';
import {createTerminalGitSnapshots} from './git-snapshots.js';
import {createTerminalGoals} from './goals.js';
import {createTerminalWorkdirs} from './workdirs.js';
import {createUsageLimitWaitHost} from '@cindy/app-runtime/usageLimitWaitHost';
import {createSessionClear} from '@cindy/app-runtime/sessionClear';
import {createBotWorkingMemory} from '@cindy/app-runtime/botWorkingMemory';
import {createUiContinuationSignals} from '@cindy/app-runtime/uiContinuationSignals';
import {createSessionOpening} from '@cindy/app-runtime/sessionOpening';
import {createDialogueWorkspace} from '@cindy/app-runtime/dialogueWorkspace';
import {createDialogueWorkspaceSettings} from '@cindy/app-runtime/dialogueWorkspaceSettings';
import {openTerminalGeneratedImages} from './generated-images.js';
import {createRuntimeTranslator} from '@cindy/maker-shared/runtime-i18n';
import {mainLocaleResources} from '../../../desktop/src/shared/mainLocaleResources.js';
import { throwIpcError } from '@cindy/remote-agent/ipcValidate';
import { redactEventForRenderer } from '@cindy/app-runtime/sessionEventRedaction';
import type { TerminalPluginEvents } from '../plugins/events.js';
import { resolveGhostUserHookModel, withGhostUserHookModel } from '@cindy/app-runtime/subscriptionGateway';
import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';
import { openTerminalUsage, type TerminalUsage } from './usage.js';
import { createSessionTaskSummary } from '@cindy/app-runtime/sessionTaskSummary';
import { agentSupportsOneShot } from '@cindy/model-providers/utility-model/oneShotSupport';
import { registerMakerInputSubmission } from '@cindy/app-runtime/makerInputSubmission';
import { createQueuedAttachmentLifecycle } from '@cindy/app-runtime/queuedAttachmentLifecycle';
import { createSessionAutoTitle } from '@cindy/app-runtime/sessionAutoTitle';
import { createRemoteInputAutoTitle } from '@cindy/app-runtime/remoteInputAutoTitle';
import { stampSharedTaskInput, assertSharedTaskQueueMutation } from '@cindy/app-runtime/sharedTaskInput';
import { createAttachmentNormalizer, type AttachmentNormalizerHost } from '@cindy/app-runtime/normalizeAttachments';
import os from 'node:os';
import { createAgentInputReferenceHydrator } from '@cindy/app-runtime/agentInputReferences';
import { createSessionReferenceResolver } from '@cindy/app-runtime/sessionReferenceResolver';
import { createSessionTerminalReader } from '@cindy/runtime-db/sessionTerminal';
import { registerMakerInputControls } from '@cindy/app-runtime/makerInputControls';
import { stampMobileClientOrigin } from '@cindy/im-runtime/mobileClientPromptNote';
import { readInputDeliveryClientIds } from '@cindy/device-link';
import { createMakerInputBoundary } from '@cindy/app-runtime/makerInputBoundary';
import { attachMainOwnedInputBoundary, stampDirectSendSourceDevice } from '@cindy/im-runtime/mobileClientPromptNote';
import { attachTrustedDesktopSendContext } from '@cindy/app-runtime/makerSendTransaction';
import { createMakerSteerTransaction } from '@cindy/app-runtime/makerSteerTransaction';
import { assertReviewSessionExternalInputAllowed } from '@cindy/app-runtime/reviewSessionInputPolicy';
import { assertCindyMakeSessionAvailable } from '@cindy/app-runtime/cindyMakeFeatureGate';
import { restoreTrustedDesktopQueuedOrigin, revokeTrustedDesktopQueuedOrigin, stampTrustedDesktopQueuedOrigin, stampTrustedDeviceLinkQueuedOrigin } from '@cindy/app-runtime/makerSendTransaction';
import { normalizeAgentInputClearBoundaryMs, buildMakerUserMessage } from '@cindy/maker-shared/agent-input-queue';
import { AgentInputCoordinator, type AgentInputSendOpts } from '@cindy/app-runtime/agent-input-coordinator';
import type { AgentInputCreateOpts } from '@cindy/maker-shared/agent-input-queue';
import { createMakerSendTransaction, type MakerSendTransactionDeps, type MakerSendPlatform } from '@cindy/app-runtime/makerSendTransaction';
import { sessions as persistedSessionRows } from '@cindy/runtime-db/schema';
import { eq as dbEq, and as dbAnd, isNull as dbIsNull } from 'drizzle-orm';
import { createWireNoteMemory } from '@cindy/app-runtime/wireNoteMemory';
import { createImMessagePersistence } from '@cindy/app-runtime/imMessagePersistence';
import {openStandaloneNodeDatabase,type NodeDatabase} from '../database.js';
import { openTerminalConversations, type TerminalConversations } from './conversations.js';
import type { TerminalWorktrees } from '../worktrees/host.js';
import { createTerminalWorktreeIpc, WORKTREE_CHANNELS } from '../worktrees/ipc.js';
import type { WorktreeRuntimeLease } from '@cindy/worktree-core/runtimeLeases';
import { preparePersistedOrcaSessionStart } from '@cindy/orca-workflow/host/orcaSessionStartOptions';
import { createOrcaRemoteWorkers } from '@cindy/orca-workflow/host/orcaRemoteWorkers';
import { createOrcaTeamService, captureOrcaDeliveryBaselines, evaluateOrcaDeliveryScope, type OrcaTeamService, type OrcaManualInterruptSnapshot } from '@cindy/orca-workflow/host/orcaTeamService';
import { createOrcaInterAgentDispatcher } from '@cindy/orca-workflow/host/orcaInterAgentDispatcher';
import { toDesktopSessionDispatchOutcome } from '@cindy/im-runtime/sendOutcome';
import { createQueueReorderAdapter, type ControlSteerOutcome, type QueuedSteerOutcome } from '@cindy/im-runtime/sessionQueueControl';
import type { AgentInputQueuedMessage } from '@cindy/maker-shared/agent-input-queue';
import { assertTerminalOrcaInput, captureTerminalOrcaInput, terminalOrcaHistoryMessage, type TerminalOrcaInput } from './orca-input.js';
import { createTerminalOrcaLifecycle } from './orca-lifecycle.js';
import { createTerminalOrcaTools } from './orca-tools.js';
import { createTerminalOrcaIpc, ORCA_CONTROL_CHANNELS } from './orca-ipc.js';
import { createOrcaIdleReleaseWatcher } from '@cindy/orca-workflow/host/orcaIdleReleaseWatcher';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ORCA_EXECUTION_DEVICES_CHANNEL } from '@cindy/device-link';
import type { MakerSessionCreateOpts } from '@cindy/orca-workflow/host/sessionTypes';
import { createOrcaRemoteWorkerForwarder } from '@cindy/orca-workflow/host/orcaRemoteWorkerBridge';
import { TerminalOrcaStore } from './orca-store.js';
import { createOrcaRemoteWorkerMcpProvider, createOrcaWorkerBridgeMcpProvider } from '@cindy/orca-workflow/mcp';
import type { McpProvider, McpProviderContext } from '@cindy/maker-core';
import { createTerminalRemoteWorkerHost, REMOTE_WORKER_CHANNELS, assertRemoteWorkerAssignment, type RemoteWorkerAssignment } from './orca-remote.js';
import type { OrcaRemoteLead } from '@cindy/maker-shared/orca-remote-worker';
import { isSameSessionExecution } from '@cindy/plugin-runtime/sessionExecutionOwnership';
import type { TerminalPluginSessionPort, TerminalPluginSessionHooks } from '../plugins/session-contract.js';
import type { TerminalPluginTask } from '../plugins/mcp.js';
import { createPluginSessionPermissions } from '../plugins/session-permissions.js';
import type { PluginTaskContext } from '../plugins/permissions.js';
import type { TerminalPluginSetup } from '../plugins/setup.js';
import { parseGhostSetupInlineSubmitRequest } from '@cindy/plugin-runtime/ghostSetupInteractionBridge';
import { createGhostSetupInteractionSurface } from '@cindy/plugin-runtime/ghostSetupInteractionSurface';
import { createHash, randomUUID } from 'node:crypto';
import { stat, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ClaudeCodeAgent, CodexAgent, PiAgent, Maker, type AgentEvent, type AgentKind, type BaseAgent, type InteractionDecision, type InteractionRequest, type Logger, type PermissionMode, type Session, type UserMessage } from '@cindy/maker-core';
import { buildClientDeviceNote, buildMessageSourceNote, messageSourceSenderFromMeta } from '@cindy/maker-shared/message-source';
import { resolveRoute, type Catalog, type ResolvedRoute } from '@cindy/model-providers';
import { type InvocationContext, type TerminalSecrets } from '../contracts.js';
import { createDeviceAgentStarter, readDeviceProviderViews, readRemoteProviderRoute, hostedStartOptions, type HostedStartInput, type DeviceAgentServiceDeps } from '@cindy/remote-agent';
import { readTaskDelivery, validateTaskDelivery, type TaskDeliveryProof } from './handoff.js';
import { TerminalTaskMedia } from './media.js';
import { persistedUserContentToWireMessage, isContextOverflowErrorData, isOversizedHistoryErrorData, isUnsupportedRequestOptionErrorData, type ContextOverflowRolloverDeps } from '@cindy/im-runtime/contextOverflowRollover';
import { createAutoReviewIntentProjection } from '@cindy/maker-shared/auto-review-intent';
import { AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION, INHERITED_CAPABILITY_SELECTION, PI_CACHE_RECOVERY_EXPECTATION } from '@cindy/maker-core';
import type { AutoReviewDelegate, AutoReviewRequest } from '@cindy/maker-core';
import { normalizeTaskInput, appendInputText, inputPlainText, persistedInput, type InputHost, type AttachmentLifecycle } from './input.js';
import { createRemoteHistory } from './remote-history.js';
import { atomicPrivateWrite, readPrivateFile, privateDirectory } from '../platform.js';
import { testConnection, fetchModels } from '../models/operations.js';
import { ENGINES, TerminalModelConfig, type ModelSelection } from '../models/config.js';
import { createTerminalAgent, discoverNativeModels, findAgentBinary, nativeAuthState, type RuntimeInput } from '../models/runtime.js';
import { createTaskTools } from './mcp.js';
import { TASK_CORE_MCP_NAMES, TERMINAL_PLUGIN_MCP_NAME } from './mcp-names.js';
import { gateBuiltinMcpProviders } from '@cindy/app-runtime/builtinMcpProviderGate';
import { createTerminalBotCatalog } from './bot-catalog.js';
import { registerBotDirectMessageHandlers, createBotDirectMessageRuntime, type BotDirectMessageService, type BotDirectMessageServiceDeps, type BotMessageTransport } from '@cindy/app-runtime/botDirectMessageService';
import { createBotCanonicalSessionRecovery } from '@cindy/app-runtime/botCanonicalSessionRecovery';
import { createBotCanonicalSessionRegistry } from '@cindy/app-runtime/botCanonicalSessionRegistry';
import { createBotProfileLocks } from '@cindy/app-runtime/botProfileLock';
import { GroupToolAuthorizationError } from '@cindy/app-runtime/botGroupToolAuthorization';
import { AcceptedCallbackDispatchCancelled } from '@cindy/im-runtime/acceptedCallbackRunner';
import { formatForwardedRequest as formatLocalizedForwardedRequest, readForwardedRequestSource, matchesForwardedRequest } from '../../../desktop/src/shared/forwardedRequest.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';
import { TerminalSshRuntime } from './ssh-runtime.js';
import { TerminalDeviceTools } from './device-tools.js';
import {registerTerminalSessionPathHost} from './path-authorization.js';
import {createRemoteSessionHandoff} from '@cindy/app-runtime/sessionHandoffRemote';
import {validateRemoteTaskActionReceipt} from '@cindy/app-runtime/remoteTaskActionReceipt';
import {createSessionHandoffHandler} from '@cindy/app-runtime/sessionHandoffHost';
import { PluginRegistry } from '@cindy/app-runtime/builtin-tools/plugin-registry';
import { SettingsReader } from '@cindy/app-runtime/builtin-tools/settings-reader';
import { createXdtHelperMcpServer } from '../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer.js';
import type { TerminalKnowledge } from '../knowledge.js';
import { TerminalCapabilities, CAPABILITY_CHANNELS } from './capabilities.js';
import { registerCapabilityResources } from './capability-resources.js';
import { installInteractionLifecycleObserver, installDesktopInteractionHandler, beginInteractionRoute, requestHostInteraction, noteInteractionRouteSteer } from '@cindy/im-runtime/interactionRouter';
import { createSharedPermission, type SharedPermission } from '@cindy/im-runtime/sharedPermission';
import type { ImTurnHost } from '@cindy/im-runtime/turnHost';
import { createInboundFileStaging } from '@cindy/im-runtime/inboundFileStaging';
import { TerminalImBindings } from '../im/bindings.js';
import { TerminalImDefaults } from '../im/defaults.js';
import { TerminalImControl } from '../im/control.js';
import { TerminalImOrchestrators } from '../im/orchestrator.js';
import { buildImDefaultRouteRecord } from '@cindy/im-runtime/channelDefaultRoute';
import type { ImCommandHost } from '@cindy/im-runtime/commandHost';
import type { ImCardHost } from '@cindy/im-runtime/cardHost';
import { lookupPending, resolvePending } from '@cindy/im-runtime/pendingInteractions';
import { resolveLenientRoute } from '@cindy/model-providers/model-route-guard';
import { modelSupportsFastMode, sourcesForModel } from '@cindy/model-providers';
import { createTerminalChannelRouteFollower, type TerminalChannelRouteConfig } from '../im/routes.js';
import { createImSessionDefaults } from '@cindy/im-runtime/defaultSessionSettings';
import { createTerminalImSessionRepo } from '../im/session-repo.js';
import type { ImOrchestratorConfig, ImSessionNamespace } from '@cindy/im-runtime/types';
import type { Capabilities, MakerEventListener } from '@cindy/maker-core';
import type { HistoryWorkReference } from '@cindy/maker-shared/message-window';
import { TerminalTaskStorage, type TerminalTaskMeta, type Submission } from './storage.js';
import { TerminalUtilityModels } from '../models/utility.js';
import { registerUtilityModelResources } from '../models/utility-resources.js';
import type { UtilityNativeAgents } from '@cindy/model-providers/utility-model/host';
import { TerminalTaskChanges, TASK_CHANGE_CHANNELS } from './changes.js';
import { TerminalTurnLifecycle } from './turn-lifecycle.js';
import { createChannelTurnSignals } from '@cindy/im-runtime/channelTurnSignal';
import { createRuntimeRecoveryNotices } from '@cindy/im-runtime/runtimeRecoveryNotice';
import { createSessionPermissionChanges } from '@cindy/im-runtime/sessionPermissionChange';
import { PluginTaskError } from '@cindy/plugin-runtime/pluginTaskService';
import { changeSessionPermissionMode } from '@cindy/im-runtime/permissionModeControl';
import { buildAutoTitlePrompt } from '@cindy/im-runtime/titlePrompt';
import { validateTitleOutput } from '@cindy/im-runtime/titleOutputValidation';
import { fbotTitle } from '@cindy/im-runtime/title';
import { isCredentialModeSwitchBusyError } from '@cindy/im-runtime/credentialModeSwitchError';
import { TerminalTaskContext } from './context.js';
import { TerminalTaskRoutes } from './routes.js';
import { AUTO_TITLE_MAX_CHARS } from '@cindy/maker-shared/session-title';
import type { Locale } from '../ui/i18n.js';
import { redactToolInputForUntrustedBoundary } from '@cindy/remote-agent/host/toolInputRedaction';

export const TERMINAL_TASK_CHANNELS = [
  MCP_APPS_INVOKE,
  'maker:input:clear-session',
  'maker:input:steer', 'maker:input:compact', 'maker:input:retry-last-error', 'maker:input:clear-error', 'maker:input:cancel-usage-limit-wait',
  'maker:auxiliary-model-settings:get', 'maker:auxiliary-model-settings:set',
  'maker:switch-session-agent', 'maker:get-session-agent-switch-intent',
  'maker:generate-title',
  ...CAPABILITY_CHANNELS,
  ...TASK_CHANGE_CHANNELS,
  'maker:plugin-setup:submit-inline',
  'local-db:messages:around','local-db:messages:around-client-id','local-db:messages:view','local-db:messages:view-intent','local-db:messages:work-details',
  'maker:input:stop', 'maker:input:resume', 'maker:input:remove', 'maker:input:update-text', 'maker:input:update-content', 'maker:input:move', 'maker:input:set-expanded', 'maker:input:set-edit-lock', 'maker:input:set-interaction-lock', 'maker:get-capabilities', 'maker:get-new-maker-defaults', 'maker:git-safety:get', 'maker:git-safety:set', 'maker:git-safety:reset', 'maker:get-session-tree', 'maker:set-thinking-enabled', 'maker:session:handoff', 'local-db:history:messages', 'local-db:history:query', 'maker:input:enqueue', 'maker:input:get-projection', 'maker:create-session', 'maker:close-session', 'maker:abort-session', 'maker:send', 'maker:steer',
  'maker:list-active', 'maker:any-session-in-turn', 'maker:session-in-turn', 'maker:session:turn-active', 'maker:get-context-usage',
  'maker:get-pending-interactions', 'maker:resolve-interaction', 'maker:set-model', 'maker:set-effort',
  'maker:set-permission-mode', 'maker:set-plan-mode', 'maker:set-fast-mode', 'maker:compact-session',
  'maker:get-plugin-write-access-recovery', 'maker:retry-plugin-write-access',
  ...REMOTE_WORKER_CHANNELS,
  ...ORCA_CONTROL_CHANNELS,
  ORCA_EXECUTION_DEVICES_CHANNEL,
  'local-db:orca-workflows:get-by-lead', 'local-db:orca-workflows:get-by-worker-session',
  'local-db:orca-workflows:list-workers-by-lead', 'local-db:orca-workflows:list-workers-by-leads',
  'maker:list-available-agents', 'maker:agent:status', 'maker:provider:list',
  'maker:provider:presets', 'maker:provider:test-connection', 'maker:provider:models-fetch', 'maker:provider:models-refresh', 'maker:provider:models-rediscover', 'maker:provider:models-auto-refresh', 'maker:provider:custom:disconnect', 'maker:model-disable:set',
  'maker:model-context-limit:get', 'maker:model-context-limit:set', 'maker:model-context-limit:reset', 'terminal:models:context-owner',
  'maker:provider:custom:create', 'maker:provider:custom:update', 'maker:provider:custom:delete',
  'terminal:tasks:turn-status', 'terminal:tasks:submit', 'terminal:tasks:status', 'terminal:tasks:wait',
  'terminal:tasks:list', 'terminal:tasks:get', 'terminal:tasks:history', 'terminal:tasks:delete', 'terminal:tasks:rename',
  'terminal:models:get', 'terminal:models:set-default', 'terminal:models:reset-default',
  'binding:resolve-session', 'binding:list-attached', 'binding:revoke',
  'local-db:recent-workdirs:list', 'local-db:recent-workdirs:remove',
  'local-db:sessions:list', 'local-db:sessions:get', 'local-db:sessions:update', 'local-db:sessions:patch-meta', 'local-db:messages:list',
] as const;

export interface TerminalTaskHostOptions extends InputHost {
  secretsLocked?: () => boolean;
  desktopInputBinary?: () => Promise<string>;
  dataRoot?: string;
  accountContext?(): ChatEmbeddingDefaultContext;
  currentOwnerSession?(): {dataOwnerId: string | null; generation: number};
  remoteAttachments?: Pick<AttachmentNormalizerHost, 'materializeRemoteAttachment' | 'removeRemote'>;
  mcpAppModelContext?: MakerSendPlatform['mcpAppModelContext'];
  ssh?:TerminalSshService;
  materializeSshRemoteMedia?: (origin: {remoteHostId: string|null; workdir:string},url:string,limits?:{baseDir?:string;maxBytes?:number})=>Promise<{ok:true;cachePath:string}|{ok:false}>;
  database?:NodeDatabase;
  profileDir: string;
  deviceId?: string;
  remoteWorkerLocations?: () => Promise<Array<{ agentDeviceId: string; name: string }>>;
  listOrcaDevices?: () => Promise<{ devices: import('@cindy/remote-agent/shared/deviceLinkIpc').DeviceLinkDeviceView[] }>;
  logger: Logger;
  secretStore: TerminalSecrets;
  emit(channel: string, args: unknown[]): void;
  emitLocal?(channel: string, args: unknown[]): void;
  emitRemote?(channel: string, args: unknown[]): void;
  deferPendingTasks?:boolean;
  defaultTitle?: string | (() => string);
  silentStopMessage?: () => string;
  runtimeRecoveryMessage?: () => string;
  language?: () => Locale;
  protectedInput?: import('../protected-input.js').TerminalProtectedInput;
  isSessionShared?(sessionId:string):boolean;
  beforeTaskUnavailable?: (sessionId:string)=>Promise<void>;
  authorizeHostedRequest?: (input: {sessionId:string;providerId:string;model:string}) => Promise<boolean>;
  authorizeGuestRequest?: (input: {sessionId:string;providerId:string;routeToken:string;model:string}) => Promise<boolean>;
  resolveExecutionRoute?: (input: { agentDeviceId?: string; providerId?: string; model?: string; agentKind?: AgentKind; groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding }, taskId: string) => Promise<{ agentDeviceId?: string; providerId: string; model: string; agentKind: AgentKind; groupBinding?: import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding } | null>;
  remoteInvoke?: DeviceAgentServiceDeps['remoteInvoke'];
  helperRemoteInvoke?(device:string,channel:string,args:unknown[],options?:{preSend?:()=>void}):Promise<import('@cindy/device-link').InvokeResultPayload>;
  binaryPaths?: Partial<Record<AgentKind, string>>;
  catalog?: Catalog;
  region?: 'cn' | 'global';
  /** Optional adapter injection for embedding and deterministic contract tests. */
  createAgent?: (input: RuntimeInput) => Promise<BaseAgent>;
  nativeStatus?: (kind: AgentKind, binary: string | null) => ReturnType<typeof nativeAuthState>;
}
type ScheduledOrigin = { kind: 'scheduler'; scheduleId: string; scheduleName: string; runId: string; firedAt?: number };
export type TaskInvocationContext = InvocationContext & { targetPlugin?: { id: string; name: string }; collaboration?: TerminalOrcaInput; orca?: RemoteWorkerAssignment; scheduler?: ScheduledOrigin; sender?: {sessionId:string;title?:string}; plugin?: {id:string;name:string}; normalizedInput?: boolean; deliveryProof?: TaskDeliveryProof; taskActionDeliveryGuard?:TaskActionDeliveryGuard };
type LiveTask = { revoke():void; cancelReview():void; didInjectOrcaInstructions: boolean; plugin?:TerminalPluginTask; capabilityRevision: number; modelRevision: number; maker: Maker; agent: BaseAgent; session: Session; selection: ModelSelection; dispose: Array<() => void | Promise<void>> };
type Pending = { persistId?:string; persistedByEvent?:boolean; sessionId: string; sourceRequestId: string; request: InteractionRequest; settle: (decision: InteractionDecision) => void; decide: (decision:InteractionDecision)=>boolean; deferred?:InteractionDecision; shared?: SharedPermission; migrated?: boolean };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENT');
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string' || !value.trim()) throw new Error('INVALID_ARGUMENT'); return value; }
function permission(value: unknown): PermissionMode {
  if (!['ask', 'default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'].includes(String(value))) throw new Error('INVALID_PERMISSION_MODE');
  return value as PermissionMode;
}
function decisionForDismissal(request: InteractionRequest): InteractionDecision {
  return request.kind === 'ask_user_question' ? { kind: request.kind, answers: {}, dismissed: true }
    : { kind: request.kind, behavior: 'deny', reason: 'session_closed', ...(request.kind === 'plan_review' ? { dismissed: true } : {}) };
}

/** Persistent, UI-independent task service. Each live task delegates its loop,
 * cancellation and native transcript resume to the unchanged Maker adapters. */
export class TerminalTaskHost {
  private nativeHistory!: ReturnType<typeof createTerminalNativeHistory>;
  private nativeArchive?: ReturnType<typeof createTerminalNativeArchive>;
  private worktrees?: TerminalWorktrees;
  private worktreeIpc?: ReturnType<typeof createTerminalWorktreeIpc>;
  private conversationChannels:readonly string[]=[];
  get channels(): readonly string[] { return [...TERMINAL_TASK_CHANNELS,...this.conversationChannels,...this.botHandlers.keys(),...(this.sessions?.channels??[]),...(this.sessionActivity?.channels??[]),...(this.usageApi?.channels??[]),...(this.goals?.channels??[]),...(this.worktrees?WORKTREE_CHANNELS:[])]; }
  async connectWorktrees(host: TerminalWorktrees): Promise<void> {
    this.guard({ source: 'local' });
    if (this.worktrees) throw new Error('WORKTREE_HOST_ALREADY_CONNECTED');
    this.worktrees = host;
    this.worktreeIpc = createTerminalWorktreeIpc({ host: () => host, guard: context => this.guard(context),
      task: id => this.storage.get(id), withTaskLock: (id, work) => this.routes.withLock(id, work),
      changed: id => this.emit('worktree:changed', { sessionId: id }),
    });
    await host.manager.reconcilePendingSafeDirectoryCleanups();
    this.retryWorktrees();
  }
  private retryWorktrees() {
    const host = this.worktrees; if (!host || this.closed) return;
    host.maintenance.startWorktreeRecycleMaintenance({ isReady: () => !this.closed,
      recycleCurrentSession: async id => {
        const row = await this.storage.get(id);
        if (row) await this.sessions.service.recycleSessionWorktreeForStatusChange(id, row.deleted ? 'deleted' : row.archived ? 'archived' : 'active');
      },
    });
  }
  private readonly botHandlers=new Map<string,(context:TaskInvocationContext,...args:any[])=>unknown>();
  bots?:TerminalBotServices;
  botDelegations?:BotDelegationService;
  botLifecycle?:ReturnType<ReturnType<typeof createBotLifecycleRuntime>['createBotLifecycleService']>;
  private botLifecycleHooks:Pick<BotLifecycleServiceDeps,'onPaused'|'onResumed'|'onBeforeDelete'|'onDeleted'|'onLifecycleChanged'>={};
  configureBotLifecycleHooks(hooks:typeof this.botLifecycleHooks){this.botLifecycleHooks=hooks;}

  readonly botParentLifecycle=createBotDelegationParentLifecycle();
  private readonly botRestore=createBotRuntimeRestoreCoordinator({
    readDbIdentity:()=>this.ownerDatabase?.getCurrentDbClientSnapshot()??null,
    readServices:()=>({directMessages:this.botDirectMessages??null,delegation:this.botDelegations??null}),
    log:{warn:(message,fields)=>this.options.logger.warn(message,fields as Record<string,unknown>|undefined)},
  });
  private sessionOpening!:ReturnType<typeof createSessionOpening>;

  botDirectMessages?:BotDirectMessageService;
  botGroupChat?:BotGroupChatService;
  readonly botProfileLocks=createBotProfileLocks();
  private botRuntimeDeps?:BotProfileRuntimeDeps;
  private botMemory?:TerminalBotServicesHost['memory'];
  private reconcileBotRoute?:ReturnType<typeof createBotModelRouteReconciler>;
  private refreshBotCapabilityBeforeSend?:ReturnType<typeof createBotCapabilityPreflight>;
  private readonly botProfileListeners=new Set<(id:string)=>void>();
  private readonly botRosterListeners=new Set<()=>void>();
  private botImStore?:ReturnType<typeof createBotImConnectionStore>;
  get botImConnections(){return this.botImStore??=createBotImConnectionStore({filePath:()=>{this.guard({source:'local'});return path.join(this.options.profileDir,'bot-im-connections.json');},scopeKey:()=>{this.guard({source:'local'});return this.options.profileDir;},log:this.options.logger});}
  get botModelSettings(){return this.runtimeRecovery.models;}
  onSubmission(listener:(receipt:Submission)=>void){this.receiptListeners.add(listener);return ()=>{this.receiptListeners.delete(listener);};}
  hasPendingInteraction(id:string){return this.pending.has(id);}
  async restoreTaskQueue(id:string){await this.ready;this.guard({source:'local'});await this.inputCoordinator.ensureQueueRestored(id);}
  onBotProfileChanged(listener:(id:string)=>void){this.botProfileListeners.add(listener);return ()=>{this.botProfileListeners.delete(listener);};}
  onBotRosterChanged(listener:()=>void){this.botRosterListeners.add(listener);return ()=>{this.botRosterListeners.delete(listener);};}
  defaultModels!:ReturnType<typeof createAppDefaultModelControl>;
  readonly models: TerminalModelConfig;
  readonly sshRuntime?: TerminalSshRuntime;
  readonly builtinTools: PluginRegistry;
  readonly deviceTools: TerminalDeviceTools;
  private readonly unregisterPathAuthorization:()=>void;
  readonly storage: TerminalTaskStorage;
  history!: ReturnType<typeof createTerminalHistory>;
  private taskTags?:ReturnType<typeof createTaskTags<TaskInvocationContext>>;
  private pluginTargetValidator?: (taskId: string, clientId: string) => Promise<void>;
  private async assertPluginTargetInput(id: string, clientId?: string) {
    try {
      if (!clientId || !this.pluginTargetValidator) throw new Error('PLUGIN_TARGET_AUTHORITY_UNAVAILABLE');
      await this.pluginTargetValidator(id, clientId);
    } catch {
      throw new AcceptedCallbackDispatchCancelled('Plugin target delivery is no longer authorized');
    }
  }
  /** Only the sandbox target slot registers this port. A target delivery never
   * makes an existing owner task into a plugin-owned task. */
  configurePluginTargetDelivery(validate: (taskId: string, clientId: string) => Promise<void>) {
    this.pluginTargetValidator = validate;
    return {
      send: async (plugin: { id: string; name: string }, id: string, clientId: string, text: string,
        images: import('@cindy/plugin-runtime/pluginMessageAttachments').PluginMessageImage[],
        guard: () => void, delivery: 'queue' | 'steer'): Promise<'queue' | 'steer'> => {
        const current = async () => { this.guard({ source: 'local' }); guard(); await validate(id, clientId); guard(); };
        await current();
        const files: NonNullable<AgentInputQueuedMessage['files']> = [];
        for (const image of images) {
          const media = await this.media.ingest({ sessionId: id, bytes: image.buffer, mimeType: image.mimeType, name: image.name }, guard);
          await current(); files.push({ id: image.hash, category: 'image', path: media.path, mimeType: image.mimeType, name: image.name, ext: path.extname(image.name), size: image.buffer.length });
        }
        if (delivery === 'steer') {
          const outcome = await this.routes.withLock(id, async () => {
            await current();
            const session = this.live.get(id)?.maker.getSession(id), row = await this.storage.get(id);
            if (!session?.isTurnRunning() || !row) return 'not-attempted';
            const item: AgentInputQueuedMessage = { clientId, text, persistedContent: text, model: row.model,
              effort: row.effort ?? '', permissionMode: row.permissionMode ?? 'default', workingDir: row.workDir, files,
              sourcePlugin: { pluginId: plugin.id, name: plugin.name },
              chatMessage: { clientId, role: 'user', content: text, createdAt: new Date().toISOString() },
              createOpts: { agentKind: row.agentKind, workingDir: row.workDir, model: row.model, providerId: row.providerId } };
            return this.steerOrcaInput(id, item, { session, turnGeneration: session.getTurnGeneration() }, plugin);
          });
          if (outcome === 'steered') return 'steer';
          if (outcome === 'queued') throw new Error('DELIVERY_UNCERTAIN');
          if (outcome === 'rejected') throw new Error('DELIVERY_REJECTED');
        }
        await current();
        // A turn may end between reserving a steering input and its native
        // boundary. That input already owns its normalized queue receipt.
        const existing = await this.storage.submission(id, clientId);
        if (existing) {
          if (existing.targetPlugin?.id !== plugin.id || existing.status !== 'queued' || existing.error === 'STEER_DELIVERY_UNCERTAIN')
            throw new Error('DELIVERY_UNCERTAIN');
          return 'queue';
        }
        const receipt = await this.submit(id, { text, files }, { requestId: clientId }, { source: 'local', targetPlugin: plugin, assertCurrent: guard });
        if (receipt.status === 'failed' || receipt.status === 'interrupted') throw new Error('DELIVERY_REJECTED');
        return 'queue';
      },
      withdraw: async (id: string, clientId: string, guard: () => void) => {
        guard();
        const receipt = await this.storage.submission(id, clientId);
        if (receipt?.targetPlugin && receipt.status === 'queued' && this.activeSubmissions.get(id) !== clientId)
          await this.removeQueued(id, clientId, { source: 'local', assertCurrent: guard });
      },
      close: () => { if (this.pluginTargetValidator === validate) this.pluginTargetValidator = undefined; },
    };
  }
  readonly orcaStore: TerminalOrcaStore;
  private readonly orcaRemoteController: ReturnType<typeof createOrcaRemoteWorkers>;
  readonly orcaTeamService: OrcaTeamService;
  readonly orcaLifecycle: ReturnType<typeof createTerminalOrcaLifecycle>['lifecycle'];
  readonly orcaTools: ReturnType<typeof createTerminalOrcaTools>;
  private readonly orcaIpc: ReturnType<typeof createTerminalOrcaIpc>;
  readonly orcaIdle: ReturnType<typeof createOrcaIdleReleaseWatcher>;
  private readonly orcaAction = new AsyncLocalStorage<() => void>();
  private readonly orcaBootOptions = new Map<string, MakerSessionCreateOpts>();
  private readonly manualOrcaInterrupts = new Map<string, OrcaManualInterruptSnapshot>();
  readonly orcaDispatcher: ReturnType<typeof createOrcaInterAgentDispatcher<TerminalTaskMeta>>;
  readonly orcaQueue: {
    snapshot(id: string): Promise<AgentInputQueuedMessage[]>;
    remove(id: string, clientId: string, expected?: AgentInputQueuedMessage): Promise<boolean>;
    replace(id: string, clientId: string, next: AgentInputQueuedMessage, expected?: AgentInputQueuedMessage): Promise<boolean>;
    merge(id: string, ids: readonly string[], build: (items: readonly AgentInputQueuedMessage[]) => AgentInputQueuedMessage | null): Promise<boolean>;
    move(id: string, clientId: string, position: number): Promise<number | null | 'locked'>;
  };
  readonly changes: TerminalTaskChanges;
  readonly turnLifecycle: TerminalTurnLifecycle;
  readonly channelSignals: ReturnType<typeof createChannelTurnSignals>;
  readonly channelRecovery: ReturnType<typeof createRuntimeRecoveryNotices>;
  readonly taskContext: TerminalTaskContext;
  readonly routes: TerminalTaskRoutes;
  private readonly remoteWorkerForwarder: ReturnType<typeof createOrcaRemoteWorkerForwarder>;
  private readonly remoteWorkers: ReturnType<typeof createTerminalRemoteWorkerHost>;
  private readonly routeClosures = new Set<string>();
  private readonly wireNoteMemory = createWireNoteMemory();
  private readonly permissionChanges = createSessionPermissionChanges();
  private readonly utilityAbort = new AbortController();
  readonly utility: TerminalUtilityModels;
  private readonly utilityWork = new Set<Promise<unknown>>();
  private readonly externalSubmissions = new Map<string, string>();
  private readonly stoppingTasks = new Map<string, number>();
  private readonly storageReady: Promise<void>;
  readonly media: TerminalTaskMedia;
  mediaRuntime!: TerminalMediaRuntime;
  readonly database:Promise<NodeDatabase>;
  readonly conversations:Promise<TerminalConversations>;
  usage!: TerminalUsage;
  private conversationRuntime!:TerminalConversations;
  private readonly legacyExecutionReceipts=new Map<string,string>();
  readonly eventBindings:TerminalEventBindings={};
  sessions!: Awaited<ReturnType<typeof createTerminalSessions>>;
  private readonly makeManager = new CindyMakeManager();
  sessionActivity!: Awaited<ReturnType<typeof createTerminalSessionActivity>>;
  usageApi!:ReturnType<typeof createTerminalUsageApi>;
  private eventRuntime!:ReturnType<typeof createTerminalTaskEvents>;
  private runtimeRecovery!:ReturnType<typeof createTerminalRuntimeRecovery>;
  private generatedImages!:Awaited<ReturnType<typeof openTerminalGeneratedImages>>;
  private gitSnapshots!:ReturnType<typeof createTerminalGitSnapshots>;
  private dialogueWorkspace!:ReturnType<typeof createDialogueWorkspace>;
  dialogueWorkspaceRoots!: () => string[];
  private workdirs!:ReturnType<typeof createTerminalWorkdirs>;
  private usageWaits!:ReturnType<typeof createUsageLimitWaitHost>;
  private readonly schedulerRecovery = createSchedulerRecoveryBridge({
    coordinator: () => this.inputCoordinator, bookkeeping: () => this.eventRuntime.bookkeeping, usageLimit: () => this.usageWaits.usageLimitAutoResume,
  });
  private readonly recoveryInputs = createAutoResumeInputLifecycle({
    bookkeeping: () => this.eventRuntime.bookkeeping,
    interrupted: () => this.eventRuntime.interrupted,
    coordinator: () => this.inputCoordinator,
    scheduler: this.schedulerRecovery,
    noteSilentStopUserSend: id => this.turnLifecycle.noteUserSend(id),
    noteUsageLimitUserAction: id => this.usageWaits?.usageLimitAutoResume.noteUserAction(id),
  });
  private goals!:ReturnType<typeof createTerminalGoals>;
  private readonly uiSignals=createUiContinuationSignals();
  private summary!: ReturnType<typeof createSessionTaskSummary>;
  readonly capabilities: TerminalCapabilities;
  readonly mcpApps: TerminalMcpApps;
  readonly channelFiles: ReturnType<typeof createInboundFileStaging>;
  readonly channelBindings: TerminalImBindings;
  readonly channelDefaults: TerminalImDefaults;
  readonly channelControl: TerminalImControl;
  readonly channelOrchestrators: TerminalImOrchestrators;
  readonly channelSessionDefaults: ReturnType<typeof createImSessionDefaults>;
  private readonly live = new Map<string, LiveTask>();
  private readonly starts = new Map<string, Promise<LiveTask>>();
  private pluginEvents?: TerminalPluginEvents;
  private readonly pluginEventSessions = new WeakSet<Session>();
  private pluginSessions?: TerminalPluginSessionHooks;
  private pluginFactory?: (context:PluginTaskContext)=>Promise<TerminalPluginTask>;
  private pluginSetup?:TerminalPluginSetup;
  private readonly channelPluginSurface = createGhostSetupInteractionSurface();
  private knowledge?: Pick<TerminalKnowledge, 'createRuntime' | 'snapshot' | 'sshProvider' | 'memory' | 'providerCatalog'>;
  private channelTools?: (context: () => import('@cindy/mcps').LiziMcpSessionContext, metadata: { source?: string }) => NonNullable<Parameters<typeof createTaskTools>[0]['extraFactories']>;
  private readonly schedulerPreparations = new Map<string, SchedulerQueuedPreparation>();
  private readonly schedulerDiscardWatchers = new Map<string, () => void>();
  private readonly lastLiveUsage = createSessionLastLiveUsage();
  private readonly preparedSessionStarts = new Map<string, {options: MakerSessionCreateOpts; didInjectOrcaInstructions: boolean}>();
  private readonly taskActionConfirm=new OrcaWorkerPermissionConfirmBridge({broadcast:(channel,payload)=>this.emit(channel,payload),
    logger:{warn:(...args:unknown[])=>this.options.logger.warn(String(args[0]),args[1] as Record<string,unknown>|undefined)},
  });
  private authorizeTaskToolCall?:import('@cindy/mcps').ToolCallAuthorizer;
  private sessionControls!:ReturnType<typeof createTerminalSessionControl>;
  private readonly runtimeControl = createSessionRuntimeControl();
  private readonly runtimeAxes = createSessionRuntimeAxes();
  private readonly codexProviderRoutes = new Map<string, {sessionId: string; routes: readonly AppliedCodexProviderRoute[]; authInjection: 'env-key'}>();
  private scheduledModels?: ReturnType<typeof createTerminalScheduledModels>;
  private schedulerDeps?: import('../../../../packages/lizi-mcps/src/types.js').SchedulerMcpDeps;
  private readonly taskObservers = new Map<string,Set<(event:AgentEvent)=>void>>();
  private readonly makerObservers = new Set<MakerEventListener>();
  private readonly engineCapabilities = new Map<AgentKind, Capabilities>();
  private readonly channelVendorOptions = new Map<string, Record<string, unknown>>();
  private channelMaker?: ReturnType<ImTurnHost['getMaker']>;
  private channelHost?: ImTurnHost;
  private channelCards?: ImCardHost;
  private readonly channelHydration = new Map<string, { providerId?: string | null; effort?: import('@cindy/maker-core').Effort; fastMode?: boolean | 'ultrafast' }>();
  private readonly pending = new Map<string, Pending>();
  private inputCoordinator!: AgentInputCoordinator<TaskInvocationContext>;
  private sessionBindings!: ReturnType<typeof createSessionBindingLifecycle<Session, {closeReason: unknown; preserveAutoResumeIntent: boolean}>>;
  private readonly closingTasks = new WeakMap<LiveTask, Promise<void>>();
  private readonly idleReclaims = new Map<string, Promise<boolean>>();
  private readonly idleReclaimTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly idleReclaimAttempts = new Set<Promise<void>>();
  private trustedDesktopSteerText = new AsyncLocalStorage<string>();
  private attachmentLifecycle!: ReturnType<typeof createQueuedAttachmentLifecycle>;
  private autoTitle!: ReturnType<typeof createSessionAutoTitle>;
  private attachments!: ReturnType<typeof createAttachmentNormalizer>;
  private inputReferences!: ReturnType<typeof createAgentInputReferenceHydrator>;
  private inputHandlers = new Map<string, (event: TaskInvocationContext, ...args: any[]) => unknown>();
  private inputBoundary!: ReturnType<typeof createMakerInputBoundary>;
  private clearSessionContext!:ReturnType<typeof createSessionClear>;
  private readonly inputInvocation = new AsyncLocalStorage<TaskInvocationContext>();
  private readonly inputContexts = new Map<string, TaskInvocationContext>();
  private readonly inputSessions = new Set<string>();
  private readonly queueMutations = new Set<string>();
  private readonly steerOperations = new Set<Promise<ControlSteerOutcome>>();
  private readonly submissionText = new Map<string, string>();
  private readonly activeSubmissions = new Map<string, string>();
  private readonly receiptListeners = new Set<(receipt: Submission) => void>();
  private readonly sending = new Set<string>();
  private readonly groupBindings = new Map<string, import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding>();
  private readonly hostedRuntimeIds = new Set<string>();
  private hostedWrites: Promise<void> = Promise.resolve();
  private readonly hosted = new Set<import('@cindy/maker-core').AgentSessionHandle>();
  private readonly binaries = new Map<AgentKind, string | null>();
  private readonly authCache = new Map<AgentKind, { at: number; value: Awaited<ReturnType<typeof nativeAuthState>> }>();
  readonly ready: Promise<void>;
  private pendingDispatchReady:boolean;
  private closed = false;
  private shutdownReason: 'app-quit' | 'account-boundary' = 'app-quit';
  private dataClosed = false;
  private ownerDatabase?: NodeDatabase;
  private closing?: Promise<void>;
  private readonly persistenceFaults = new Set<string>();

  readonly piRuntimeOwner: TerminalPiRuntimeOwner;
  constructor(private readonly options: TerminalTaskHostOptions) {
    this.piRuntimeOwner = new TerminalPiRuntimeOwner(options.logger);
    this.channelSignals = createChannelTurnSignals(options.logger);
    this.channelRecovery = createRuntimeRecoveryNotices(options.runtimeRecoveryMessage ?? (() => 'Pi extensions could not be refreshed. Restart Cindy before using Pi again.'));
    this.channelFiles = createInboundFileStaging({
      createLogger: () => options.logger,
      ownerScopedImUserDataPath: (...segments) => {
        if (this.closed) throw new Error('TASK_HOST_CLOSED');
        return path.join(options.profileDir, ...segments);
      },
      ensureDirectory: privateDirectory,
    });
    this.pendingDispatchReady=!options.deferPendingTasks;
    if (!path.isAbsolute(options.profileDir)) throw new Error('PROFILE_DIRECTORY_MUST_BE_ABSOLUTE');
    this.database=options.database?Promise.resolve(options.database):openStandaloneNodeDatabase(options.profileDir,options.logger,options.language);
    this.media = new TerminalTaskMedia(options.profileDir,{database:this.database,logger:options.logger,isCurrent:()=>!this.dataClosed});
    this.storage = new TerminalTaskStorage(path.join(options.profileDir, 'tasks'));
    this.conversations = this.database.then(database => openTerminalConversations({
      database, media: this.media, profileDir: options.profileDir,
      logger: options.logger, region: options.region ?? 'global',
      isCurrent: () => !this.dataClosed,
      isSessionRunning: id => this.isTurnRunning(id),
      isParentPiSessionLive: id => this.live.get(id)?.maker.getSession(id)?.agentKind === 'pi',
      emit: (channel, payload) => this.emit(channel, payload),
      emitLocal: (channel, payload, ...stamp) => this.emit(channel, payload, 'local', stamp),
      emitRemote: (channel, payload) => this.emit(channel, payload, 'remote'),
      getSessionProvider: id => this.runtimeProvider(id),
      historyChanged: id => this.emit('terminal:tasks:changed', { sessionId: id }),
      botChanged: id => { for(const listener of this.botProfileListeners) { try { listener(id); } catch {} } },
      sessionPatched: (id, patch) => this.sessionActivity?.metadata(id, patch),
      removeTurnChangeSetsForSession: id => this.changes.store.removeTurnChangeSetsForSession(id),
      materializeSshRemoteMedia: (...args) => {
        if (!options.materializeSshRemoteMedia) throw new Error('SSH_MEDIA_SERVICE_NOT_CONNECTED');
        return options.materializeSshRemoteMedia(...args);
      },
    }));
    this.storage.configurePersistence(this.database, this.conversations);
    this.taskContext = new TerminalTaskContext({conversations:this.conversations,logger:options.logger,assertCurrent:()=>this.guard({source:'local'})});
    this.changes = new TerminalTaskChanges({
      profileDir: options.profileDir, storage: this.storage, logger: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      activeWorkspaces: () => [...this.live.values()].filter(task => this.isTurnRunning(task.session.id)).map(task => task.session.workDir),
      userMessageIds: async id => new Set((await this.messages(id, { limit: Infinity }, true)).filter(row => row.role === 'user').map(row => row.clientId)),
      emit: (channel, payload) => this.emit(channel, payload),
    });
    this.turnLifecycle = new TerminalTurnLifecycle({
      profileDir: options.profileDir, logger: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      getDbClient: () => { if (this.dataClosed || !this.ownerDatabase) throw new Error('TASK_DATABASE_OWNER_UNAVAILABLE'); return this.ownerDatabase.getDbClient(); },
      coordinator: () => this.inputCoordinator ?? null,
      observer: {
        getSessionProvider: id => this.runtimeProvider(id),
        verdictForModelRoute: (agent, model, provider) => this.models.verdict(agent, model, provider),
        throwIpcError,
        ensureManagedOllamaReadyForSession: ({providerId}) => this.models.prepareLocalModel(providerId),
        publishChannelTurn: async (session, phase) => {
          if (phase === 'undispatched') this.changes.store.clearPendingTurnChangeSets(session.id);
          await this.channelSignals.publishChannelTurn(session, phase);
        },
        publishProviderInitiatedTurn: session => this.channelSignals.publishProviderInitiatedTurn(session),
      },
      beforeStart: async session => { this.changes.assertCanDispatch(session.workDir); },
      advanceRuntimeRecoveryNotice: session => this.channelRecovery.advanceRuntimeRecoveryNotice(session),
      createDbMessage: (...args) => this.conversations.then(runtime => runtime.messages.createMessage(...args)),
      emit: (channel, payload) => this.emit(channel, payload),
      settled: async (session, _reason) => {
        this.eventRuntime?.activity.setSessionInTurn(session.id,false);
        const conversations=await this.conversations;
        conversations.activeTurn.markSessionTurnEndedAfterBarrier(session.id,conversations.persistence.drainPersistQueue());
        await this.changes.store.finalizeTurnChangeSet(session.id, null, 'complete');
        this.inputCoordinator.onTurnEvent(session.id, 'done');
        this.inputCoordinator.onExternalTurnSettled(session.id);
        const requestId = this.activeSubmissions.get(session.id);
        if (requestId) { this.activeSubmissions.delete(session.id); await this.updateReceipt(session.id, requestId, 'completed', undefined, this.submissionText.get(session.id)); this.submissionText.delete(session.id); }
        setImmediate(() => this.drain(session.id));
        this.emit('maker:event', { sessionId: session.id, event: { type: 'status', data: { isRunning: false } } });
      },
    });
    this.storageReady = this.storage.open();
    this.orcaStore = new TerminalOrcaStore({ root: options.profileDir, tasks: this.storage, beforeOpen: this.storageReady, logger: options.logger,
      withSessionRouteLock: (id, work) => this.routes.withLock(id, work),
      cleanupRuntime: id => { this.routes.cancel(id); this.groupBindings.delete(id); this.routes.recovery.runtime.cancelRecovery(id); },
      guard: () => this.guard({ source: 'local' }),
      onTaskPatch: (id, patch) => {
        this.emit('local-db:sessions:patched', { sessionId: id, patch });
        this.emit('terminal:tasks:changed', { sessionId: id });
      },
    });
    this.orcaRemoteController = createOrcaRemoteWorkers({
      getOwnerToken: () => this.closed ? null : this,
      getTeamService: () => this.orcaTeamService,
      listDevices: async () => {
        if (!options.listOrcaDevices) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        return options.listOrcaDevices();
      },
      remoteInvoke: async (device, channel, args) => {
        if (!options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        const response = await options.remoteInvoke(device, channel, args);
        return response.ok ? { ok: true, result: response.result } : { ok: false,
          error: { code: 'IPC_ERROR', message: `[${response.error?.code ?? 'INTERNAL'}] ${response.error?.message ?? 'Remote invocation failed'}` } };
      },
      readLeadTitle: async id => (await this.storage.get(id))?.title ?? '',
      broadcastOrcaWorkerChanged: leadSessionId => this.emit('maker:orca:worker-changed', { leadSessionId }),
      log: options.logger,
      store: {
        archiveSingleWorkerSession: (id, beforeMutation) => this.orcaStore.archiveSingleWorkerSession(id, beforeMutation),
        getRemoteWorkerByProxySession: id => this.orcaStore.getRemoteWorkerByProxySession(id),
        listActiveRemoteWorkers: () => this.orcaStore.listActiveRemoteWorkers(),
        listUnreleasedEndedRemoteWorkers: () => this.orcaStore.listUnreleasedEndedRemoteWorkers(),
        markWorkerRemoteReleased: (id, at) => this.orcaStore.markWorkerRemoteReleased(id, at),
        markWorkerRemoteStopConfirmed: (id, at) => this.orcaStore.markWorkerRemoteStopConfirmed(id, at),
        getWorkerRemoteReleaseState: id => this.orcaStore.getWorkerRemoteReleaseState(id),
        saveWorkerRemoteReport: (id, pending, message, done) => this.orcaStore.saveWorkerRemoteReport(id, pending, message, done),
        saveRemoteWorkerOpen: (device, id) => this.orcaStore.saveRemoteWorkerOpen(device, id),
        removeRemoteWorkerOpen: id => this.orcaStore.removeRemoteWorkerOpen(id),
        listOrphanRemoteWorkerOpens: id => this.orcaStore.listOrphanRemoteWorkerOpens(id),
        addRemoteWorker: input => this.orcaStore.addRemoteWorker(input),
        removeWorker: id => this.orcaStore.removeWorker(id),
      },
    });
    this.orcaStore.setRemoteWorkerStatusProvider((session, device) => this.orcaRemoteController.runtime.isRemote(session) ? ({
      deviceName: this.orcaRemoteController.deviceName(device),
      reachable: this.orcaRemoteController.runtime.isReachable(session),
    }) : undefined);
    this.channelBindings = new TerminalImBindings({ database: this.database, logger: options.logger, beforeOpen: this.storageReady, assertCurrent: () => { if (this.closed) throw new Error('TASK_HOST_CLOSED'); } });
    this.channelDefaults = new TerminalImDefaults({ root: options.profileDir, assertCurrent: () => this.guard({ source: 'local' }), changed: channel => this.emit('maker:remote-resources:changed', { collectionId: 'channels', channel }) });
    this.channelSessionDefaults = createImSessionDefaults({
      getCapabilities: kind => this.channelRuntime().getCapabilities(kind),
      listProviders: () => this.models.views(),
      readImDefaultSettings: channel => this.channelDefaults.read(channel),
      readImRemoteProviderRoute: route => readRemoteProviderRoute(route, async (deviceId, channel, args) => {
        this.guard({ source: 'local' });
        if (!options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        const result = await options.remoteInvoke(deviceId, channel, args);
        this.guard({ source: 'local' });
        return result;
      }),
      log: options.logger,
    });
    this.mcpApps=new TerminalMcpApps({database:this.database,conversations:this.conversations,secrets:options.secretStore,secretsLocked:options.secretsLocked,logger:options.logger,
      assertCurrent:()=>this.guard({source:'local'}),send:(...args)=>this.sendMcpAppMessage(...args),request:(id,request,signal)=>this.interaction(id,request,signal)});
    this.capabilities = new TerminalCapabilities({apps:this.mcpApps,root:options.profileDir,secrets:options.secretStore,secretsLocked:options.secretsLocked,assertCurrent:()=>{if(this.closed)throw new Error('TASK_HOST_CLOSED');},changed:()=>{this.emit('maker:mcp:changed',{});this.emit('maker:remote-resources:changed',{collectionId:'skills'});this.emit('maker:remote-resources:changed',{collectionId:'mcp'});},workingDirs:async()=>[...new Set((await this.storage.list()).filter(row=>!row.deleted).map(row=>row.workDir))]});
    this.models = new TerminalModelConfig(options.profileDir, options.secretStore, kind => this.authState(kind), options.catalog, options.createAgent ? undefined : async kind => { const binary = this.binaries.get(kind); return binary ? discoverNativeModels(kind, binary, options.profileDir, options.logger) : []; }, options.region, options.logger, this.database);
    this.models.onVisibilityChanged(()=>this.emit('maker:provider:changed',{}));
    this.utility = new TerminalUtilityModels({
      root: options.profileDir, models: this.models, log: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      changed: () => this.emit('maker:remote-resources:changed', { collectionId: 'auxiliary-models' }),
      native: {
        listAvailableAgents: () => ENGINES.filter(kind => Boolean(this.binaries.get(kind))),
        getAgentAuthState: async kind => { await this.ready; return this.authState(kind); },
        oneShot: (kind, prompt, opts) => this.nativeUtilityText(kind, prompt, opts),
      },
    });
    this.routes = new TerminalTaskRoutes({
      appliedCodexRoutes: () => [...this.codexProviderRoutes.values()].flatMap(entry => entry.routes),
      listActiveSessions: () => [...this.live.values()].flatMap(task => task.maker.listActiveSessions()),
      wakeSession: id => this.inputCoordinator?.wakeSession(id, 'pending-credential-switch-applied'),
      credentialApplied: payload => this.emit('maker:session-credential-switch-applied', payload),
      credentialFailed: payload => this.emit('maker:session-credential-switch-failed', payload),
      storage: this.storage, context: this.taskContext, models: this.models, logger: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      getSession: id => this.live.get(id)?.maker.getSession(id),
      hasPendingInteraction: id => [...this.pending.values()].some(pending => pending.sessionId === id),
      closeSession: id => this.closeTask(id), bootstrap: async id => { await this.ensureLive(id); },
      select: input => this.selection(input), messages: id => this.contextMessages(id, Infinity),
      withCloseSuppressed: async (id, run) => {
        const previous = this.routeClosures.has(id); this.routeClosures.add(id);
        try { return await run(); } finally { if (!previous) this.routeClosures.delete(id); }
      },
      changed: async id => {
        const row = await this.storage.get(id); if (!row) return;
        this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(row) });
      },
      onRebuilt: id => { this.inputCoordinator.clearError(id); this.wireNoteMemory.reset(id); },
      getRecoveryAbortSignal: id => {
        if (this.inputCoordinator.hasPendingQueuedWork(id)) { this.inputCoordinator.clearError(id); return AbortSignal.abort(); }
        return this.inputCoordinator.getInputAbortSignal(id);
      },
      pendingChanged: (id, intent) => { if (intent) this.runtimeControl.recordUserSessionRuntimeMutation(id); this.emit('local-db:sessions:patched', { sessionId: id, patch: { agentSwitchIntent: intent } }); },
      replay: (...args) => this.replayRecoveredTask(...args),
      hasExternalOwner: id => Boolean(this.channelBindings.store.findByTarget(id) || this.pluginSetup?.surface.isHeadlessGhostSetupTurn(id)),
    });
    this.remoteWorkerForwarder = createOrcaRemoteWorkerForwarder({
      getOwnerToken: () => this.closed ? null : this,
      readSession: async id => { const row = await this.storage.get(id); return row ? { status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active', orcaRemoteLead: row.orcaRemoteLead ?? null } : null; },
      remoteInvoke: async (device, channel, args) => {
        this.guard({ source: 'local' });
        if (!options.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
        const result = await options.remoteInvoke(device, channel, args);
        return result.ok ? { ok: true, result: result.result } : { ok: false, error: { code: result.error?.code ?? 'IPC_ERROR', message: result.error?.message ?? 'Remote worker bridge unavailable' } };
      },
      getActiveInputClientIds: id => this.inputCoordinator.getActiveInputClientIds(id),
      getAcceptedInputProvenance: id => this.inputCoordinator.getAcceptedInputProvenance(id),
    });
    this.remoteWorkers = createTerminalRemoteWorkerHost({
      storage: this.storage, deviceId: options.deviceId, workerBridge: Boolean(options.remoteInvoke),
      guard: context => this.guard(context), withLock: (id, work) => this.routes.withLock(id, work),
      providers: deviceId => deviceId
        ? options.remoteInvoke ? readDeviceProviderViews(options.remoteInvoke, deviceId) : Promise.reject(new Error('REMOTE_AGENT_UNAVAILABLE'))
        : this.models.views(),
      locations: () => options.remoteWorkerLocations?.() ?? Promise.resolve([]),
      create: async (request, lead, guard) => {
        await this.create({ ...request }, guard, undefined, { id: request.sessionId, lead });
        guard(); const row = await this.storage.get(request.sessionId); guard();
        if (!row) throw new Error('TASK_NOT_FOUND'); return row;
      },
      changed: row => { this.emit('terminal:tasks:changed', { sessionId: row.id }); this.emit('local-db:sessions:patched', { sessionId: row.id, patch: this.guiSession(row) }); },
    });
    this.channelControl = new TerminalImControl({ tasks: this, logger: options.logger,
      assertCurrent: () => this.guard({ source: 'local' }),
      readDeviceProviders: id => {
        if (!options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        return readDeviceProviderViews(options.remoteInvoke, id);
      },
    });
    this.channelOrchestrators = new TerminalImOrchestrators(this);
    this.orcaDispatcher = this.createOrcaDispatcher();
    const reorder = createQueueReorderAdapter({ getLiveSession: id => this.live.get(id)?.maker.getSession(id),
      hasSendToSessionLock: id => this.routes.isLocked(id), getCoordinator: () => this.inputCoordinator });
    this.orcaQueue = {
      snapshot: async id => { await this.inputCoordinator.ensureQueueRestored(id); return this.inputCoordinator.getQueueControlSnapshot(id).pendingQueue; },
      remove: async (id, clientId, expected) => {
        if (!this.inputCoordinator.hasQueuedItemWhere(id, item => item.clientId === clientId && (!expected || item === expected))) return false;
        this.inputCoordinator.remove(id, clientId);
        await (await this.database).inputQueue.awaitAgentInputQueueSnapshotPersistence(id);
        return !this.inputCoordinator.hasPendingQueueItem(id, clientId);
      },
      replace: async (id, clientId, next, expected) => {
        const replaced = (!expected || this.inputCoordinator.hasQueuedItemWhere(id, item => item === expected))
          && this.inputCoordinator.replaceQueuedMessage(id, clientId, next);
        await (await this.database).inputQueue.awaitAgentInputQueueSnapshotPersistence(id);
        return replaced;
      },
      merge: async (id, ids, build) => {
        const result = this.inputCoordinator.mergeQueuedMessagesAtomically(id, ids, build);
        await (await this.database).inputQueue.awaitAgentInputQueueSnapshotPersistence(id);
        return result.merged;
      },
      move: async (id, clientId, position) => {
        const result = await reorder.moveStoredControlMessage(id, clientId, position);
        await (await this.database).inputQueue.awaitAgentInputQueueSnapshotPersistence(id);
        return result;
      },
    };

    this.orcaTeamService = this.createOrcaTeamControls();
    options.ssh?.setLiveTurnChecker(hostId=>[...this.live.values()].some(({session})=>session.remoteHostId===hostId&&session.isTurnRunning()));
    this.orcaLifecycle = createTerminalOrcaLifecycle({
      store: this.orcaStore, tasks: this.storage, models: this.models, team: this.orcaTeamService, remote: this.orcaRemoteController,
      remoteInvoke: options.remoteInvoke, selfDeviceId: () => options.deviceId, worktrees: () => this.worktrees,
      guard: () => { this.guard({ source: 'local' }); this.orcaAction.getStore()?.(); },
      withLock: (id, work) => this.routes.withLock(id, work),
      authority: id => this.captureOrcaAuthority(id),
      validatePlan: async (...args) => {
        const row = await this.storage.get(args[0].leadSessionId);
        if (this.pluginSessions?.validateWorkerPlan) return this.pluginSessions.validateWorkerPlan(...args);
        if (row?.source === 'plugin') throw new Error('PLUGIN_TASK_AUTHORITY_UNAVAILABLE');
        await args[3]?.(); return undefined;
      },
      bootstrap: async input => {
        const id = string(input.id), current = this.orcaAction.getStore();
        if (input.remoteHostId && !this.sshRuntime) throw new Error('SSH_RUNTIME_UNAVAILABLE');
        this.orcaBootOptions.set(id, input);
        try {
          await this.create(input, () => { this.guard({ source: 'local' }); current?.(); }, undefined, undefined, { id, role: 'worker' });
          const task = this.live.get(id);
          if (!task) throw new Error('TASK_NOT_ACTIVE');
          return { session: task.session, didInjectOrcaInstructions: task.didInjectOrcaInstructions, didInjectProjectContext: false };
        } finally { this.orcaBootOptions.delete(id); }
      },
      live: id => this.live.get(id)?.maker.getSession(id),
      close: id => this.closeTask(id),
      archive: async id => { await this.patchMeta(id, { status: 'archived' }, () => this.guard({ source: 'local' })); },
      forget: id => { this.manualOrcaInterrupts.delete(id); this.orcaTeamService.clearAutoBridgeState(id); },
      readyMessage: async (id, message, current) => {
        await current?.();
        const task = await this.ensureLive(id);
        const result = await task.session.send({ type: 'user', content: message }, {
          planMode: false, throwOnStartFailure: true, onAccepted: current,
          [AUTO_REVIEW_SOURCE_CONTENT]: '', [AUTO_REVIEW_DELEGATED_CONTINUATION]: true,
        });
        if (!result.accepted) throw new Error('ORCA_WORKER_READY_FAILED');
      },
      changed: leadSessionId => this.emit('maker:orca:worker-changed', { leadSessionId }),
      created: sessionId => this.emit('local-db:sessions:created', { sessionId }),
    }).lifecycle;
    this.orcaTools = createTerminalOrcaTools({
      store: this.orcaStore, tasks: this.storage, lifecycle: this.orcaLifecycle, team: this.orcaTeamService, remote: this.orcaRemoteController,
      selfDeviceId: options.deviceId,
      providers: id => id ? options.remoteInvoke ? readDeviceProviderViews(options.remoteInvoke, id) : Promise.reject(new Error('REMOTE_AGENT_UNAVAILABLE')) : this.models.views(),
      locations: () => options.remoteWorkerLocations?.() ?? Promise.resolve([]),
      authorize: ctx => async input => {
        const current = this.orcaMcpGuard(ctx, input.sessionId);
        current();
        return { ok: true, run: async operation => this.orcaAction.run(current, async () => { current(); const result = await operation(); current(); return result; }) };
      },
      authority: id => this.captureOrcaAuthority(id), live: id => this.live.get(id)?.maker.getSession(id),
      resume: (id, current) => this.routes.withLock(id, async () => {
        await current(); const row = await this.storage.get(id);
        if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND');
        await current(); await this.ensureLive(id); await current();
      }),
      end: id => this.endOrca(id),
      latestText: async id => (await this.conversations).latest.latestMessageText(id, 'assistant'),
      running: id => this.isTurnRunning(id), paused: id => this.inputCoordinator.isQueuePaused(id),
      changed: leadSessionId => this.emit('maker:orca:worker-changed', { leadSessionId }),
      warn: error => options.logger.warn('ORCA_WORKER_RESUME_FAILED', { error: String(error) }),
    });
    this.builtinTools=new PluginRegistry({settingsReader:new SettingsReader({logger:options.logger,userDataPath:options.profileDir})});
    this.deviceTools=new TerminalDeviceTools({profileDir:options.profileDir,logger:options.logger,plugins:this.builtinTools,secrets:options.secretStore,ssh:options.ssh,desktopInputBinary:options.desktopInputBinary,assertCurrent:()=>this.guard({source:'local'}),
      uploadRoots:async id=>{const row=await this.storage.get(id);this.guard({source:'local'});return row&&!row.deleted&&!row.archived&&!row.remoteHostId&&row.workDir?[row.workDir]:[];}});
    for(const [channel,handler] of this.deviceTools.handlers)this.botHandlers.set(channel,handler);
    if(options.ssh)this.sshRuntime=new TerminalSshRuntime({profileDir:options.profileDir,ssh:options.ssh,secrets:options.secretStore,logger:options.logger,orcaStore:this.orcaStore,
      providers:()=>this.sshMcpProviders(),appServerIds:()=>this.mcpApps.remoteServerIds(),memoryEnabled:()=>this.knowledge?.snapshot().memory??false,
      collabEnabled:()=>this.builtinTools.isEnabled('collab'),hasLiveTurn:id=>[...this.live.values()].some(task=>task.session.remoteHostId===id&&this.isTurnRunning(task.session.id)),
      drainPersistQueue:async()=>{await this.storage.flush();await(await this.conversations).persistence.drainPersistQueue();},assertCurrent:()=>this.guard({source:'local'})});
    this.orcaIpc = createTerminalOrcaIpc({ store: this.orcaStore, lifecycle: this.orcaLifecycle, team: this.orcaTeamService, api: this.orcaTools.api,
      authority: id => this.captureOrcaAuthority(id), remote: id => this.orcaRemoteController.runtime.isRemote(id),
      hasUserMessageSince: async (id, at) => (await this.messages(id, { limit: Infinity }, true)).some(message => message.role === 'user' && Date.parse(message.createdAt) >= at),
    });
    this.orcaIdle = createOrcaIdleReleaseWatcher({
      readIdleReleaseMinutes: () => this.orcaStore.settings().workerIdleReleaseMinutes,
      listCandidates: at => this.orcaStore.idleCandidates(at), getSession: id => this.live.get(id)?.maker.getSession(id) ?? null,
      withSessionLock: (id, work) => this.routes.withLock(id, work),
      hasPendingInput: async id => this.isTurnRunning(id) || (await this.storage.queued(id)).length > 0 || [...this.pending.values()].some(request => request.sessionId === id),
      markReleased: (candidate, at) => this.orcaStore.markIdleReleased(candidate, at), touchWorker: (id, at) => this.orcaStore.touchWorker(id, at),
      closeSession: id => this.closeTask(id), broadcastWorkerChanged: leadSessionId => this.emit('maker:orca:worker-changed', { leadSessionId }),
      now: Date.now, timer: { setInterval: (work, delay) => { const timer = setInterval(work, delay); timer.unref(); return timer; }, clearInterval }, log: options.logger,
    });
    this.channelBindings.store.onChange(event => this.emit('binding:changed', {
      sessionId: event.value, attached: event.value !== null, channel: event.identity.channel, userId: event.identity.userId,
    }));
    this.unregisterPathAuthorization=registerTerminalSessionPathHost({logger:options.logger,
      session:id=>this.closed?undefined:this.live.get(id)?.maker.getSession(id),
      confirm:(id,payload)=>this.requestPluginWrite(id,payload)});
    this.ready = this.initialize();
  }
  private async initializeInputCoordinator() {
    const database = await this.database, conversations = await this.conversations;
    const store = database.inputQueue;
    const media = await this.media.persisted();
    this.attachments = createAttachmentNormalizer({
      temporaryDirectory: os.tmpdir, logger: this.options.logger,
      imageCacheStore: media.imageCacheStore, cindyMediaBlobStore: media.blobStore, cindyMediaLedger: media.ledger,
      ingestMedia: (params, db) => {
        const context = this.inputInvocation.getStore() ?? { source: 'local' as const };
        const scope = media.journal.captureMediaRefCompensationScope();
        const check = () => { this.guard(context); scope.assertStillValid(); params.assertStillValid?.(); };
        check();
        return media.ingestMedia({ ...params, assertStillValid: check, refCompensationScope: { ...scope, assertStillValid: check } }, db ?? database.db.drizzle);
      },
      materializeRemoteAttachment: (...args) => {
        const context = this.inputInvocation.getStore() ?? { source: 'local' as const };
        this.guard(context);
        if (!this.options.remoteAttachments) throw new Error('ATTACHMENT_TRANSFER_UNAVAILABLE');
        return this.options.remoteAttachments.materializeRemoteAttachment(...args);
      },
      removeRemote: key => {
        if (!this.options.remoteAttachments) throw new Error('ATTACHMENT_TRANSFER_UNAVAILABLE');
        return this.options.remoteAttachments.removeRemote(key);
      },
    });
    this.inputReferences = createAgentInputReferenceHydrator(() => {
      this.guard(this.inputInvocation.getStore() ?? { source: 'local' }); return database.getDbClient();
    });
    const contextFor = async (id: string, clientId?: string, canonical?: AgentInputSendOpts): Promise<TaskInvocationContext> => {
      const captured = clientId ? this.inputContexts.get(id + ':' + clientId) : undefined;
      const receipt = !captured && clientId ? await this.storage.submission(id, clientId) : null;
      const context: TaskInvocationContext = captured ? { ...captured } : receipt ? { ...receipt, source: receipt.source ?? 'local', normalizedInput: true,
        ...(receipt.sharedTask ? { assertCurrent: () => { throw new Error('SHARED_TASK_REVALIDATION_REQUIRED'); } } : {}) }
        : { source: 'local', normalizedInput: true };
      if (canonical) {
        const persisted = canonical.persistUserMessage, origin = persisted?.origin;
        if (origin?.kind !== 'orca') { delete context.collaboration; delete context.orca; }
        else if (!context.orca) context.collaboration = await captureTerminalOrcaInput(this.orcaStore, this.storage, id,
          { origin, persistedContent: persisted?.content ?? '' });
        if (origin?.kind !== 'scheduler') delete context.scheduler; else if (origin.runId) context.scheduler = { ...origin, runId: origin.runId };
        if (origin?.kind !== 'session') { delete context.sender; delete context.deliveryProof; }
        if (!persisted?.sourcePlugin) { delete context.plugin; delete context.targetPlugin; }
        if (!persisted?.sharedTaskAuthor) delete context.sharedTask;
        context.sourceDevice = canonical.sourceDevice;
      }
      return context;
    };
    const assertItem = async (id: string, item: AgentInputQueuedMessage) => {
      const context = await contextFor(id, item.clientId); this.guard(context);
      if (item.origin?.kind === 'orca' && !context.collaboration && !context.orca) {
        context.collaboration = await captureTerminalOrcaInput(this.orcaStore, this.storage, id, item);
        this.inputContexts.set(id + ':' + item.clientId, context);
      }
      if (context.collaboration) await assertTerminalOrcaInput(this.orcaStore, this.storage, id, context.collaboration);
      if (context.orca) await assertRemoteWorkerAssignment(this.storage, id, context.orca);
      if (item.clientId.startsWith('plugin-target:') || context.targetPlugin) await this.assertPluginTargetInput(id, item.clientId);
      if (context.deliveryProof) await validateTaskDelivery(this.options.remoteInvoke, context.deliveryProof);
      this.guard(context);
    };
    const awaitQueueSnapshot = async (id: string) => {
      this.inputCoordinator.retryQueueSnapshotPersistence(id);
      await store.awaitAgentInputQueueSnapshotPersistence(id);
    };
    const attachmentLifecycle = this.attachmentLifecycle = createQueuedAttachmentLifecycle(this.options.logger, awaitQueueSnapshot);
    this.autoTitle = createSessionAutoTitle({ ...conversations.titles, logger: this.options.logger,
      generateMakerSessionTitle: (message, agentKind, sessionId) => this.generateTaskTitle({ message, agentKind, sessionId }) });
    this.autoTitle.registerSessionAutoTitleHooks();
    const sessionReferences = createSessionReferenceResolver({
      getDbClient: () => { this.guard(this.inputInvocation.getStore() ?? { source: 'local' }); return database.getDbClient(); },
      getSelfDeviceId: () => this.options.deviceId ?? null,
      ...createSessionTerminalReader(database.getDbClient),
      invokeRemote: async (deviceId, channel, args) => {
        const context = this.inputInvocation.getStore() ?? { source: 'local' as const };
        this.guard(context);
        if (!this.options.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
        const result = await this.options.remoteInvoke(deviceId, channel, args);
        this.guard(context);
        return { ok: true, result };
      },
    });
    this.runtimeRecovery = createTerminalRuntimeRecovery({tasks:this,profileDir:this.options.profileDir,database,conversations,events:this.eventRuntime,
      control:this.runtimeControl,axes:this.runtimeAxes,coordinator:()=>this.inputCoordinator,scheduler:this.schedulerRecovery,
      live:id=>this.live.get(id)?.maker.getSession(id),close:id=>this.closeTask(id),
      withCloseSuppressed:(id,work)=>this.withRehydrateCloseSuppressed(id,work),guard:()=>this.guard({source:'local'}),log:this.options.logger});
    this.initializeSessionBindings();
    const coordinator = new AgentInputCoordinator<TaskInvocationContext>({
      isResumableTurnErrorCandidate:this.runtimeRecovery.canRecoverTurn,
      onResumableTurnError:this.runtimeRecovery.recover,
      onResumableTurnErrorDiscarded:this.runtimeRecovery.discarded,
      hasPendingCredentialSwitch: id => this.routes.credentials.has(id),
      resolveSessionReferences: sessionReferences.resolveSessionReferences,
      screenUserMessage: (id, text, item) => {
        const session = this.live.get(id)?.maker.getSession(id);
        const model = resolveGhostUserHookModel(session?.isTurnRunning() === true, session?.model, item.createOpts.model);
        return withGhostUserHookModel(model, () => this.pluginEvents?.sessions.screenGhostUserMessage(id, text) ?? Promise.resolve({action:'allow' as const}));
      },
      onUserMessageBlocked: (sessionId, item, verdict) => this.emit('ghosts:message-blocked', {sessionId,clientId:item.clientId,text:item.text,...verdict}),
      onUserMessageRewritten: (sessionId, item, info) => {
        revokeTrustedDesktopQueuedOrigin(item);
        this.emit('ghosts:message-rewritten', {sessionId,clientId:item.clientId,...info});
      },
      sendToAgent: async (id, message, createOpts, sendOpts) => {
        await this.runtimeRecovery.noteInput(id,createOpts);
        const clientId = sendOpts.persistUserMessage?.clientId;
        const context = await contextFor(id, clientId, sendOpts);
        this.guard(context);
        const receiptId = sendOpts.persistUserMessage?.autoResume ? this.activeSubmissions.get(id) ?? clientId : clientId;
        if (receiptId) {
          this.activeSubmissions.set(id, receiptId);
          if (context.collaboration || context.orca || context.plugin || context.targetPlugin || context.scheduler || context.sender || context.deliveryProof)
            this.externalSubmissions.set(id, receiptId);
          await this.updateReceipt(id, receiptId, 'sending');
        }
        try {
          const result = await this.sendNative(id, message, { ...context, normalizedInput: false }, sendOpts, createOpts);
          if (receiptId && result.accepted && this.activeSubmissions.get(id) === receiptId) await this.updateReceipt(id, receiptId, 'running');
          if (!result.accepted && this.activeSubmissions.get(id) === receiptId) {
            this.activeSubmissions.delete(id); this.externalSubmissions.delete(id);
          }
          return result.outcome;
        } catch (error) {
          if (receiptId) await this.updateReceipt(id, receiptId, 'failed', error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'SEND_FAILED');
          if (this.activeSubmissions.get(id) === receiptId) { this.activeSubmissions.delete(id); this.externalSubmissions.delete(id); }
          throw error;
        }
      },
      steerToAgent: async (id, message, sendOpts) => {
        const context = await contextFor(id, sendOpts.messageUuid);
        const host = await this.originalSteerTransaction(context);
        const expectedText = this.trustedDesktopSteerText.getStore();
        await host.steerToAgentAccepted(id, message, expectedText === undefined ? sendOpts : attachTrustedDesktopSendContext(message, sendOpts, expectedText));
      },
      abortSession: async id => { await this.cancelTaskRecovery(id); const session = this.live.get(id)?.maker.getSession(id); if (session) await this.stopTaskTurn(session); },
      isTurnRunning: id => this.turnLifecycle.running(id) || this.starts.has(id) || this.sending.has(id)
        || this.queueMutations.has(id) || this.stoppingTasks.has(id) || this.live.get(id)?.maker.getSession(id)?.isTurnRunning() === true,
      isLiveTurnRunning: id => this.live.get(id)?.maker.getSession(id)?.isTurnRunning() ?? false,
      isLiveSessionPresent: id => this.live.has(id),
      getTurnGeneration: id => this.live.get(id)?.maker.getSession(id)?.getTurnGeneration() ?? null,
      getObservedCurrentTurnTerminal: id => this.live.get(id)?.maker.getSession(id)?.getObservedCurrentTurnTerminal(),
      getTurnSessionIdentity: id => this.live.get(id)?.maker.getSession(id) ?? null,
      hasPendingInteraction: id => [...this.pending.values()].some(item => item.sessionId === id),
      getAgentKind: id => this.live.get(id)?.maker.getSession(id)?.agentKind ?? null,
      getSdkSessionId: async id => (await this.storage.get(id))?.sdkSessionId,
      beforeDispatchUserTurn: async (id, item) => {
        await assertItem(id, item);
        this.eventRuntime.bookkeeping.markReplacementDispatching(id, item.clientId);
        this.uiSignals.publishUiTurnDispatching(id, item.clientId);
        await this.gitSnapshots.coordinator.onTurnStart(id);
        await assertItem(id, item);
      },
      onAcceptedQueuedMessage: async (id, item, restored) => {
        await assertItem(id, item);
        if(item.clientId.startsWith('bot-dm:')) {
          if(!this.botDirectMessages)throw new AcceptedCallbackDispatchCancelled('Bot message recovery unavailable');
          if(restored)await this.botDirectMessages.assertRestoredQueuedDelivery(id,item.clientId);
        }
        // These paths already await the same acceptance callback in their
        // persisted native dispatch; do not run its side effects twice.
        const acceptedContext=await contextFor(id,item.clientId);
        if(!acceptedContext.collaboration&&!acceptedContext.scheduler)
          await this.orcaDispatcher.runQueuedOrcaInterAgentAcceptedCallback(id,item);
        await this.botDelegations?.acceptQueuedSessionInput(id,item.clientId,item.supersedesUserClientId,restored,item.retrySourceClientId);
        this.schedulerDiscardWatchers.delete(item.clientId); this.schedulerPreparations.delete(item.clientId);
      },
      onSteerAccepted: async (id, item) => {
        await this.todoDelivery?.settleTodoDispatch(id,item.clientId,true);
        this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId);
        await this.updateReceipt(id, item.clientId, 'completed');
      },
      onUserMessagePersisting: (id, item) => attachmentLifecycle.markQueuedAttachmentPersistenceStarted(id, item.clientId),
      onUserMessagePersisted: (id, item) => { void attachmentLifecycle.queuedAttachmentOwnership.settleDurable(id, item.clientId); },
      onUserMessagePersistenceFailed: (id, item, opts) => attachmentLifecycle.settleQueuedAttachmentPersistenceFailure(id, item.clientId, opts.retainForRetry),
      onQueueEmptied: id => this.sessionActivity?.service.notifyQueueEmptied(id),
      onDiscardedQueuedMessage: (id, item) => {
        void this.todoDelivery?.settleTodoDispatch(id,item.clientId,false);
        this.botWelcomeReceipts.settle(id,item.clientId,false);
        const watcher = this.schedulerDiscardWatchers.get(item.clientId);
        this.schedulerDiscardWatchers.delete(item.clientId); this.schedulerPreparations.delete(item.clientId);
        try { watcher?.(); } catch (error) { this.options.logger.warn('Scheduler discard listener failed', { error: String(error) }); }
        attachmentLifecycle.discardQueuedAttachmentOwnership(id, item.clientId);
        this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId);
        this.settleUndispatchedRetry(id, item, 'cancelled');
        void this.updateReceipt(id, item.clientId, 'interrupted', 'INPUT_REMOVED');
      },
      onUndispatchedUserTurn: (id, item, disposition) => {
        void this.todoDelivery?.settleTodoDispatch(id,item.clientId,false);
        this.botWelcomeReceipts.settle(id,item.clientId,false);
        this.uiSignals.publishUiTurnUndispatched(id, item.clientId);
        this.changes.store.clearPendingTurnChangeSets(id);
        this.gitSnapshots.coordinator.onTurnAbort(id);
        this.eventRuntime.bookkeeping.rollbackReplacementPreview(id, item.clientId);
        this.settleUndispatchedRetry(id, item, disposition);
        void this.updateReceipt(id, item.clientId, disposition === 'cancelled' ? 'interrupted' : 'failed',
          disposition === 'cancelled' ? 'INPUT_REMOVED' : 'SEND_FAILED');
      },
      onRejectedUserTurn: (id, item) => {
        void settleUndispatchedBotGroupTurn(this.botGroupChat??null,id,item.clientId,'failed',this.inputCoordinator.getProjection(id).error)
          .catch(()=>this.options.logger.warn('Bot group undispatched input settlement failed',{sessionId:id}));
        this.botWelcomeReceipts.settle(id,item.clientId,false);
        void this.updateReceipt(id, item.clientId, 'failed', 'SEND_FAILED');
        if (!item.autoResume) this.eventRuntime.bookkeeping.surfaceSuppressedErrorForRetry(id, item.clientId);
      },
      onUserEnqueue: id => {
        this.uiSignals.publishUiSessionIntervention(id);
        this.routes.recovery.runtime.cancelRecovery(id);
        this.eventRuntime.bookkeeping.supersedeUnclaimedErrorForUserIntervention(id);
        this.schedulerRecovery.failPendingSchedulerAutoResume(id);
      },
      onAutomaticEnqueue: id => {
        this.routes.recovery.runtime.cancelRecovery(id);
        this.eventRuntime.bookkeeping.supersedeUnclaimedErrorForUserIntervention(id);
        this.schedulerRecovery.failPendingSchedulerAutoResume(id);
      },
      onUserAction:id=>this.usageWaits?.usageLimitAutoResume.noteUserAction(id),
      onUsageLimitedTurnError:(id,signals,item,token)=>{if(!this.schedulerRecovery.onUsageLimitedTurnError(id,signals,item,token))void this.usageWaits.usageLimitAutoResume.onTurnError(id,signals,token);},
      onInputDispatchSettled:async(id,item,accepted)=>{
        this.botWelcomeReceipts.settle(id,item.clientId,accepted);
        await this.todoDelivery?.settleTodoDispatch(id,item.clientId,accepted);
      },
      onDispatchedUserTurn: async (id, item, preVendorDispatchAt) => {
        this.botDelegations?.confirmQueuedSessionInputDispatched(id,item.clientId);
        this.recoveryInputs.dispatched(id, item);
        if (item.originalSyntheticTrigger === 'continue') {
          try { await conversations.activeTurn.ackSessionTurnEndedDurable(id, preVendorDispatchAt); }
          catch (error) { this.options.logger.warn('continue dispatched ack failed', {sessionId:id,error:String(error)}); }
        }
      },
      onUiRetry: (id, clientId, source, token) => {
        this.recoveryInputs.retry(id, clientId, source, token);
        if (source === 'manual') {
          this.routes.recovery.runtime.cancelRecovery(id);
          this.schedulerRecovery.failPendingSchedulerAutoResume(id);
          this.turnLifecycle.noteUserSend(id);
          this.eventRuntime.interrupted.noteUserSend(id);
        }
        this.uiSignals.publishUiContinuation(id, clientId);
      },
      onUnconfirmedAutoResumeTurn: this.recoveryInputs.unconfirmed,
      emitProjection: projection => {this.botInputProjectionListener?.(projection);this.usageWaits?.onProjection(projection);this.schedulerRecovery.emitProjection(projection);this.emit('maker:input:projection', projection);},
      persistQueueSnapshot: store.saveAgentInputQueueSnapshot,
      loadClearBoundary: async id => (await this.storage.get(id))?.clearedAt,
      loadQueueSnapshot:async id=>{await this.botDelegations?.restorePauseForSession(id);await this.usageWaits?.restoreSavedUsageLimitWait(id);return store.loadAgentInputQueueSnapshot(id);},
      getPersistedClientIds: store.getPersistedInputClientIds,
      createUserMessage: (id, body, opts) => this.taskContext.enqueue('queue-user:' + id + ':' + body.clientId,
        () => this.storage.writeUserMessage(id, body, opts)),
      rewindPersistedUserMessageAfterClear: conversations.messages.rewindPersistedUserMessageAfterClear,
    }, {
      logger: this.options.logger,
      getSharedTaskContext: () => { const context = this.inputInvocation.getStore(); return context?.sharedTask ? context : undefined; },
      assertSharedTaskQueueMutation: (context, id, operation, item) => {
        this.guard(context ?? this.inputInvocation.getStore() ?? { source: 'local' });
        if (context?.sharedTask && !context.sharedTaskCapture) throw new Error('SHARED_TASK_REVALIDATION_REQUIRED');
        assertSharedTaskQueueMutation(context?.sharedTaskCapture, id, operation, item);
      },
      restoreTrustedDesktopQueuedOrigin, revokeTrustedDesktopQueuedOrigin,
      touchUserSendInDb: conversations.activity.touchUserSendInDb,
      createUserMessage: conversations.messages.createMessage,
    });
    this.inputCoordinator = coordinator;
    this.sessionControls=createTerminalSessionControl({tasks:this,getDbClient:()=>database.getDbClient(),guard:()=>this.guard(this.currentInvocation()),
      live:id=>this.live.get(id)?.maker.getSession(id),coordinator,conversations,control:this.runtimeControl,recovery:this.runtimeRecovery,events:this.eventRuntime,
      formatForwardedRequest:(source,supplement)=>source.userText===null?supplement:formatLocalizedForwardedRequest(source,supplement,this.options.language?.()??'en'),
    });
    this.inputBoundary = createMakerInputBoundary({ inputCoordinator: coordinator, ...conversations.snapshot, ...conversations.clear,
      getPersistedInputClientIds: store.getPersistedInputClientIds, log: this.options.logger,
      assertReviewExternalInputAllowed: async id => {
        const source = (await this.storage.get(id))?.source ?? null;
        assertCindyMakeSessionAvailable(source);
        await assertReviewSessionExternalInputAllowed(id, () => source);
      },
    });
    this.clearSessionContext=createSessionClear({
      ...this.inputBoundary,...conversations.clear,
      ...createBotWorkingMemory({getDbClient:()=>this.usage.getDbClient()}),
      inputCoordinator:coordinator,agentHandoffPending:this.taskContext.handoff,wireNoteMemory:this.wireNoteMemory,
      userDataDirectory:()=>this.options.dataRoot??this.options.profileDir,
      isDeviceLinkInvoke:()=>this.inputInvocation.getStore()?.source==='remote',
      assertReviewExternalInputAllowed:async id=>{
        this.guard(this.currentInvocation());
        const source=(await this.storage.get(id))?.source??null;
        assertCindyMakeSessionAvailable(source);
        await assertReviewSessionExternalInputAllowed(id,()=>source);
      },
      resetSessionRuntime:id=>{
        this.workdirs.recovery.discard(id);
        this.routes.recovery.runtime.cancelRecovery(id);
        this.turnLifecycle.guard.noteSessionReset(id);
        this.eventRuntime.interrupted.noteSessionReset(id);
        this.eventRuntime.bookkeeping.teardown(id);
      },
      goalClearObserver:id=>{void this.goals?.controller.clearGoal(id);},
      log:this.options.logger,
    });
    this.inputHandlers.set('maker:input:clear-session',(_event,id,at)=>this.clearSessionContext(id,at));
    const controlHost: Parameters<typeof registerMakerInputControls<TaskInvocationContext, TaskInvocationContext>>[0] = {
      inputCoordinator: coordinator, ...this.inputBoundary, ...conversations.snapshot,
      ipcMain: { handle: (channel, handler) => { this.inputHandlers.set(channel, (event, ...args) => {
        if (typeof args[0] === 'string') this.inputSessions.add(args[0]);
        return handler(event, ...args);
      }); } },
      isDeviceLinkInvoke: () => this.inputInvocation.getStore()?.source === 'remote',
      assertTrustedAppRendererEvent: event => {
        this.guard(event);
        if (this.inputInvocation.getStore() !== event) throw new Error('UNTRUSTED_TASK_INVOCATION');
      },
      readInputDeliveryClientIds, ...store,
      awaitAgentInputQueueSnapshotPersistence: async id => {
        coordinator.retryQueueSnapshotPersistence(id);
        await store.awaitAgentInputQueueSnapshotPersistence(id);
      },
      getAgentIslandService: () => this.sessionActivity.service,
      readQueuedEditorProvenance: () => {
        const context = this.inputInvocation.getStore();
        return { sourceDevice: context?.sourceDevice, isMobile: context?.sourceDevice?.platform === 'mobile' };
      },
      stampQueuedEditProvenance: (id, item, remote, editor) => {
        const context = this.inputInvocation.getStore() ?? { source: 'local' as const };
        this.guard(context);
        this.inputContexts.set(id + ':' + item.clientId, context);
        this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(item.clientId);
        return stampTrustedDeviceLinkQueuedOrigin(
          stampTrustedDesktopQueuedOrigin(stampMobileClientOrigin(item, editor.isMobile), remote, true),
          remote, editor.sourceDevice);
      },
    };
    registerMakerInputControls(controlHost);
    registerMakerInputSubmission({
      ...controlHost, ...this.inputBoundary, ...this.attachments, ...this.inputReferences, ...attachmentLifecycle,
      inputCoordinator: coordinator,
      assertReviewExternalInputAllowed: async id => {
        const source = (await this.storage.get(id))?.source ?? null;
        assertCindyMakeSessionAvailable(source);
        await assertReviewSessionExternalInputAllowed(id, () => source);
      },
      getCurrentDbClientSnapshot: () => { this.guard(this.currentInvocation()); return database.getCurrentDbClientSnapshot(); },
      withSessionPermissionChange: (id, work) => this.permissionChanges.withSessionPermissionChange(id, work),
      prepareSharedTaskInput: async (id, item) => {
        const context = this.currentInvocation();
        this.inputSessions.add(id); coordinator.setExecutionPaused(id, !this.pendingDispatchReady);
        this.inputContexts.set(id + ':' + item.clientId, context);
        if (!context.sharedTask) return item;
        const capture = context.sharedTaskCapture;
        if (!capture) throw new Error('SHARED_TASK_REVALIDATION_REQUIRED');
        const row = await this.storage.get(id); this.guard(context);
        if (!row || row.archived || row.deleted || !row.workDir) throw new Error('TASK_NOT_FOUND');
        const existing = coordinator.getQueueControlSnapshot(id).pendingQueue.find(queued => queued.clientId === item.clientId);
        const refs = new Set<string>();
        if (existing && capture.authorize('input.edit', {sessionId:id, authorAccountId:existing.sharedTaskAuthor?.accountId ?? '', state:'pending'})) {
          for (const file of existing.files ?? []) for (const ref of [file.path, file.url]) if (ref) refs.add(ref);
        }
        return stampSharedTaskInput(item, capture, {
          agentKind: row.agentKind, workingDir: row.workDir, model: row.model, providerId: row.providerId,
          effort: row.effort, permissionMode: row.permissionMode, fastMode: row.fastMode, planMode: row.planMode,
          remoteHostId: row.remoteHostId, resumeSessionId: row.sdkSessionId, orcaRole: row.orcaRole,
        }, refs);
      },
      getMakerIfReady: () => ({ getSession: id => this.live.get(id)?.maker.getSession(id) }),
      isMobileControllerInvoke: () => this.currentInvocation().sourceDevice?.platform === 'mobile',
      readDeviceLinkInvokeSourceDevice: () => this.currentInvocation().sourceDevice,
      getResolvedMainLocale: () => this.options.language?.() ?? 'en',
      prepareDeviceLinkAutoTitle: createRemoteInputAutoTitle({ ...this.autoTitle, log: this.options.logger,
        isDeviceLinkInvoke: controlHost.isDeviceLinkInvoke,
        labels: () => {
          const locale = this.options.language?.() ?? 'en';
          return ({ 'zh-CN': { image:'图片', file:'文件' }, 'zh-TW': {image:'圖片',file:'檔案'},
            ja:{image:'画像',file:'ファイル'}, ko:{image:'이미지',file:'파일'} } as Record<string,{image:string;file:string}>)[locale] ?? {image:'Image',file:'File'};
        },
      }),
      hasInputDeliveryCancellation: store.hasInputDeliveryCancellation,
      trustedDesktopSteerText: this.trustedDesktopSteerText,
    });
  }
  private async initialize() {
    this.ownerDatabase = await this.database;
    await privateDirectory(this.options.profileDir);
    const initialized=await Promise.allSettled([this.storageReady,this.orcaStore.ready,this.models.open(),this.media.ready,this.capabilities.ready,this.channelBindings.ready,this.channelDefaults.ready,this.utility.ready,...ENGINES.map(async kind=>this.binaries.set(kind,await findAgentBinary(kind,this.options.binaryPaths?.[kind])))]);
    const failed=initialized.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;
    const defaults=this.models.defaults;
    const assertDefaultOwner=()=>this.guard({source:'local'});
    this.defaultModels=createAppDefaultModelControl({
      ...defaults.cache,...this.models.visibility.mirror,
      waitForModelVisibilityMirror:()=>this.models.waitForModelVisibility(),
      activeOwnerScopeKey:()=>{assertDefaultOwner();return defaults.ownerScope;},
      isAppSessionBoundaryPending:()=>this.closed,
      getActiveDataOwnerPushStamp:()=>{assertDefaultOwner();return defaults.stamp;},
      getDesktopProviderService:()=>({listProviders:options=>this.models.views(options)}),
      getMakerIfReady:()=>({listAvailableAgents:()=>ENGINES.filter(kind=>!!this.binaries.get(kind))}),
      getSelectedNewMakerRoute:owner=>{defaults.synchronize();return defaults.cache.getSelectedNewMakerRoute(owner);},
      readRemoteProviderRoute:async route=>{if(!this.options.remoteInvoke)throw new Error('REMOTE_UNAVAILABLE');return readRemoteProviderRoute(route,this.options.remoteInvoke);},
    });
    this.defaultModels.configureAppDefaultModelSelection(selection=>{
      void this.models.applyDefaultModelSelection(selection,assertDefaultOwner).catch(error=>
        this.options.logger.warn('Default model preference could not be saved',{code:(error as {code?:unknown})?.code}));
    });
    this.usage = await openTerminalUsage({ database: await this.database, conversations: await this.conversations,
      models: this.models, profileDir: this.options.profileDir, region: this.options.region ?? 'global', logger: this.options.logger,
      assertCurrent: () => { if (this.dataClosed) throw new Error('TASK_HOST_CLOSED'); }, emit: (channel, payload) => this.emit(channel, payload) });
    this.mediaRuntime = await openTerminalMediaRuntime({database: await this.database, models:this.models,usage:this.usage,media:this.media,secrets:this.options.secretStore,profileDir:this.options.profileDir,region:this.options.region??'global',logger:this.options.logger,locale:()=>this.options.language?.()??'en',assertCurrent:()=>{if(this.dataClosed)throw new Error('TASK_HOST_CLOSED');}});
    const conversations = await this.conversations;
    this.conversationRuntime=conversations;
    const database=await this.database;
    this.nativeHistory = createTerminalNativeHistory({ database, conversations, profileDir: this.options.profileDir,
      assertCurrent: () => this.guard({ source: 'local' }) });
    const dialogueSettings=createDialogueWorkspaceSettings({
      activeOwnerScopeKey:()=>conversations.broadcastTap.captureDataOwnerBroadcastScope().ownerScopeKey!,
      ownerScopedUserDataPath:(...parts)=>path.join(this.options.profileDir,...parts),createLogger:()=>this.options.logger,
    });
    this.dialogueWorkspaceRoots=dialogueSettings.dialogueWorkspaceRoots;
    this.dialogueWorkspace=createDialogueWorkspace(dialogueSettings);
    this.workdirs=createTerminalWorkdirs({profileDir:this.options.profileDir,logger:this.options.logger,...dialogueSettings,
      assertCurrent:()=>this.guard({source:'local'}),
      readBoundWorkingDir:async id=>[this.live.get(id)?.maker.getSession(id)?.workDir??null,(await this.storage.get(id))?.workDir??null],
      getManagedWorktreeReadinessForSession:async(id,dir)=>{
        if(!this.worktrees)throw new Error('WORKTREE_HOST_UNAVAILABLE');
        return this.worktrees.restore.getManagedWorktreeReadinessForSession(id,dir);
      },
      listActiveSessions:()=>[...this.live.values()].map(({session})=>({id:session.id,workDir:session.workDir,remoteHostId:session.remoteHostId})),
      emit:(channel,payload)=>this.emit(channel,payload),t:key=>createRuntimeTranslator(mainLocaleResources,()=>this.options.language?.()??'en').t(key),
    });
    this.gitSnapshots=createTerminalGitSnapshots({database,dataRoot:this.options.dataRoot??this.options.profileDir,logger:this.options.logger,
      assertCurrent:()=>{if(this.dataClosed)throw new Error('TASK_HOST_CLOSED');},
      maker:{getSessionMeta:id=>this.storage.get(id),oneShot:(kind,prompt,options)=>this.nativeUtilityText(kind,prompt,{
        ...options,beforeDispatch:options?.beforeDispatch?async()=>options.beforeDispatch!():undefined,
      })},
      isAgentOneShotRouteDisabled:async agentKind=>{
        try{await this.models.select({agentKind,providerId:agentKind==='codex'?'openai':'anthropic'});return false;}catch{return true;}
      },
    });
    this.eventBindings.gitSnapshots=this.gitSnapshots.coordinator;
    const opening=this.sessionOpening=createSessionOpening({...database,...conversations.rowMapper,...this.dialogueWorkspace,...this.gitSnapshots});
    opening.setSessionOpeningModelAdmission(async body=>{
      const selected=await this.selection({...body,agentKind:body.agentKind?dbToMakerAgentKind(body.agentKind):undefined});
      return {...body,...selected.selection,agentKind:makerToDbAgentKind(selected.selection.agentKind)};
    });
    this.storage.configureOpening(opening);
    this.conversationChannels=conversations.channels;
    const forks = createSessionFork({
      ...conversations.rowMapper, ...conversations.messages,
      getDbClient: () => {this.guard(this.currentInvocation()); return database.getDbClient();},
      inferProviderIdForModel: (model, kind) => this.models.inferProviderIdForModel(model, kind),
      remoteBackgroundInvoke: this.invokeHelperRemote,
      forkSdkSession: async (id, kind, options) => {
        const context = this.currentInvocation();
        const agent = kind === 'codex'
          ? await this.createNativeControlAgent(id, {model:options.model, providerId:options.providerId}, true)
          : createOfflineHistoryAgent({kind, sourceSessionId:id, profileDir:this.options.profileDir,
            binaryPath:this.binaries.get(kind) ?? terminalNodeExecutable(), logger:this.options.logger});
        try {this.guard(context); const result=await agent.forkSdkSession(options); this.guard(context); return result;}
        finally {await agent.dispose();}
      },
    });
    const forkChannel = new AsyncLocalStorage<string>();
    createSessionForkIpc<TaskInvocationContext>({
      ...forks, logger:this.options.logger,
      ipcMain:{handle:(channel,handler)=>this.botHandlers.set(channel,(context,...args)=>{this.guard(context);return forkChannel.run(channel,()=>handler(context,...args));})},
      assertTrustedAppRendererEvent: context => this.guard(context),
      getDeviceLinkInvokeContext: () => {
        const context=this.currentInvocation();
        return context.source==='remote'?{channel:forkChannel.getStore()!,controllerDeviceId:context.deviceId,sharedTask:context.sharedTask}:null;
      },
      emitSessionCreated:id=>{this.guard(this.currentInvocation());this.emit('local-db:sessions:created',{sessionId:id});},
    }).registerMakerForkIpc();
    const rewind = createSessionRewind({
      ...forks, ...this.gitSnapshots, ...conversations.rowMapper, ...conversations.persistence, ...conversations.prRefs,
      getDbClient:()=>{this.guard(this.currentInvocation());return database.getDbClient();},
      getMaker:()=>({getSession:id=>this.live.get(id)?.maker.getSession(id),getSessionMeta:id=>this.storage.get(id)}),
      createLogger:()=>this.options.logger,
    });
    const rewindInput = createSessionRewindInputBoundary({
      getCoordinator:()=>this.inputCoordinator, rewinding:new Set<string>(), logger:this.options.logger,
      stopGoal:async id=>{await this.cancelTaskRecovery(id);await this.goals.controller.pauseGoal(id,'paused: stopped by user');},
    });
    createSessionRewindIpc<TaskInvocationContext>({
      ...rewind, ...rewindInput, ...this.routes.locks, ...conversations.persistence,
      ...conversations.broadcastTap, ...conversations.subagentService, ...conversations.subagents, ...conversations.subagentFence,
      ...createBotWorkingMemory({getDbClient:()=>{this.guard(this.currentInvocation());return database.getDbClient();}}),
      withSendToSessionLock:(id,action)=>this.routes.withLock(id,action),
      ipcMain:{handle:(channel,handler)=>this.botHandlers.set(channel,(context,...args)=>{this.guard(context);return handler(context,...args);})},
      createLogger:()=>this.options.logger,getGoalController:()=>this.goals?.controller,
      agentHandoffPending:this.taskContext.handoff,ownerScopedUserDataPath:()=>this.options.profileDir,
    }).registerMakerRewindIpc();
    const workingMemory = createBotWorkingMemory({getDbClient:()=>{this.guard(this.currentInvocation());return database.getDbClient();}});
    registerMakerMessageDeleteHandler({handle:(channel,handler)=>this.botHandlers.set(channel,(context,...args)=>{this.guard(context);return handler(context,...args);})},{
      getSessionRow:async id=>{this.guard(this.currentInvocation());return (await database.getDbClient().drizzle.select({status:persistedSessionRows.status,agentKind:persistedSessionRows.agentKind}).from(persistedSessionRows).where(dbEq(persistedSessionRows.id,id)).limit(1))[0]??null;},
      getMessage:conversations.messages.getMessageDeletionTarget,
      listMessagesForContext:id=>conversations.messages.listMessagesForAgentHandoff(id,400),
      pruneWorkingMemory:(id,ids)=>workingMemory.pruneWorkingMemoryForSession(id,this.options.profileDir,ids),
      getLiveSession:id=>this.live.get(id)?.maker.getSession(id),
      hasBackgroundActivity:id=>this.eventRuntime.claudeActivity.getClaudeSessionBackgroundActivity(id),
      closeSession:id=>this.closeTask(id),drainPersistQueue:conversations.persistence.drainPersistQueue,
      commitDeletion:conversations.messages.commitMessageDeletion,
      setPendingHandoff:(id,text,generation)=>this.taskContext.handoff.set(id,text,generation),
      readPendingHandoffGeneration:id=>this.taskContext.handoff.readGeneration(id),
      onCommitted:({sessionId,deletedClientIds,subagentRunIds,updatedAt,preview},requestedClientId)=>{
        this.guard(this.currentInvocation());
        conversations.messages.broadcastMessageDeleted({sessionId,clientId:requestedClientId,clientIds:deletedClientIds});
        for(const runId of subagentRunIds)conversations.subagentService.broadcastSubagentRunsChanged({sessionId,runId,created:false,firstForSession:false});
        conversations.notifications.broadcastSessionPatched(sessionId,{sdkSessionId:null,updatedAt:new Date(updatedAt).toISOString(),preview});
      },
      withCloseSuppressed:(id,action)=>this.withRehydrateCloseSuppressed(id,action),log:this.options.logger,
    });
    this.history=createTerminalHistory({database:await this.database,conversations,models:this.models,
      profileDir:this.options.profileDir,dataRoot:this.options.dataRoot??this.options.profileDir,logger:this.options.logger,
      dialogueWorkspaceRoots:dialogueSettings.dialogueWorkspaceRoots,
      account:this.options.accountContext??(()=>({mode:'local',isAuthenticated:false,userId:null,membershipKind:null})),
      assertCurrent:()=>this.guard({source:'local'}),
    });
    if(this.options.listOrcaDevices&&this.options.remoteInvoke){
      this.history.deps.remote=createHistoryRemoteDeps({listDevices:this.options.listOrcaDevices,captureAccess:()=>this.captureHelperOwner(),invoke:this.invokeHelperRemote});
      this.history.deps.getMessages=args=>readChatHistoryMessages(args,{readLocal:this.history.readers.getMessagesForHistory,invokeRemote:this.invokeHelperRemote});
    }
    await this.history.reconcile();
    registerSearchHandlers<TaskInvocationContext>({...this.history,isDeviceLinkInvoke:()=>this.currentInvocation().source==='remote',
      ipcMain:{handle:(channel,handler)=>this.botHandlers.set(channel,(context,...args)=>{this.guard(context);if(context.sharedTask)throw new Error('OWNER_REQUIRED');return handler(context,...args);})}});
    this.summary = createSessionTaskSummary({ ...conversations.latest, ...conversations.broadcastTap,
      getDbClient: () => { this.guard({ source: 'local' }); return (this.usage.getDbClient()); },
      createLogger: () => this.options.logger,
      activeOwnerScopeKey: () => conversations.broadcastTap.captureDataOwnerBroadcastScope().ownerScopeKey!,
      isAppSessionBoundaryPending: () => this.closed,
      getMaker: () => this.utility.nativeAgents(), agentSupportsOneShot,
      requestUtilityText: (_maker, prompt, options) => this.utility.request(prompt, options),
      getEffectiveAuxiliaryModelChain: () => this.utility.effective(),
      getEffectiveAuxiliaryModelChainSnapshot: () => this.utility.effectiveSnapshot(),
      isAgentOneShotRouteDisabled: async agentKind => {
        try { await this.models.select({ agentKind, providerId: agentKind === 'codex' ? 'openai' : 'anthropic' }); return false; }
        catch { return true; }
      },
      broadcastLocal: conversations.broadcastLocal,
    });
    this.generatedImages=await openTerminalGeneratedImages({database:await this.database,conversations,media:this.media,
      profileDir:this.options.profileDir,isCurrent:()=>!this.dataClosed,
      t:(key,params)=>{let text=createRuntimeTranslator(mainLocaleResources,()=>this.options.language?.()??'en').t(key);for(const [name,value] of Object.entries(params??{}))text=text.replaceAll(`{{${name}}}`,String(value));return text;},
      invoke:async(device,channel,args,opts)=>{opts?.preSend?.();if(!this.options.remoteInvoke)throw new Error('REMOTE_SOURCE_REQUIRED');return this.options.remoteInvoke(device,channel,args);},
      publish:(sessionId,event,persistId,resolvedContent)=>this.emit('maker:event',{sessionId,event,persistId,resolvedContent}),
      materializeSshRemoteMedia:this.options.materializeSshRemoteMedia??(async()=>({ok:false,error:'REMOTE_SOURCE_REQUIRED'})),
    });
    registerMakerReadHandlers({handle:(channel,handler)=>this.botHandlers.set(channel,(context,...args)=>{this.guard(context);return handler(context,...args);})},{
      getMaker:()=>this.channelRuntime(),
      apiKeyPresent:()=>Boolean(this.models.gatewayCredentials()),
      recoverImage:(sessionId,imageId)=>this.generatedImages.recover(sessionId,imageId),
      isRemoteInvoke:()=>this.currentInvocation().source==='remote',
      assertRemoteInputControlBoundary:(sessionId,remote,opts)=>this.inputBoundary.assertRemoteInputControlBoundary(sessionId,remote,opts),
      getPluginRegistry:()=>this.builtinTools,
      builtinProviders:()=>this.builtinMcpCatalog(),
      isManagedDialogueWorkspace:dir=>this.dialogueWorkspace.isManagedDialogueWorkspace(dir),
    });
    const registerBackground = (channel: string, handler: (context: TaskInvocationContext, ...args: unknown[]) => unknown | Promise<unknown>) =>
      this.botHandlers.set(channel, (context, ...args) => { this.guard(context); return handler(context, ...args); });
    registerBackground('maker:session-background-activity', (_context, sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) throwIpcError('INVALID_PARAMS', 'sessionId required');
      return { active: this.eventRuntime.claudeActivity.getClaudeSessionBackgroundActivity(sessionId) };
    });
    registerBackground('maker:session-background-activity:list', () => ({
      sessionIds: this.eventRuntime.claudeActivity.listActiveClaudeBackgroundActivitySessions(),
    }));
    registerBackground('maker:session-background-tasks:list', (_context, sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) throwIpcError('INVALID_PARAMS', 'sessionId required');
      const live = this.live.get(sessionId)?.maker.getSession(sessionId);
      return { tasks: live?.listBackgroundTasks() ?? [], pendingContinuations: live?.countPendingWakeContinuations() ?? 0 };
    });
    registerBackground('maker:agent-task:stop', async (_context, sessionId, taskId) => {
      if (typeof sessionId !== 'string' || !sessionId) throwIpcError('INVALID_PARAMS', 'sessionId required');
      if (typeof taskId !== 'string' || !taskId) throwIpcError('INVALID_PARAMS', 'taskId required');
      const live = this.live.get(sessionId)?.maker.getSession(sessionId);
      if (!live) return { ok: true };
      try { await live.stopBackgroundTask(taskId); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/not supported/i.test(message)) throwIpcError('UNSUPPORTED_CAPABILITY', 'stopBackgroundTask is not supported for this session');
        throwIpcError('INTERNAL', `failed to stop background task: ${message}`);
      }
      return { ok: true };
    });
    registerBackground('maker:session-background-tasks:stop', async (_context, sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId) throwIpcError('INVALID_PARAMS', 'sessionId required');
      this.routes.recovery.runtime.cancelRecovery(sessionId);
      await this.goals.controller.pauseGoal(sessionId, 'paused: stopped by user');
      await this.closeTask(sessionId);
      this.eventRuntime.claudeActivity.clearClaudeSessionBackgroundActivity(sessionId);
      return { ok: true };
    });
    this.eventBindings.pendingCredentialSwitch = this.routes.credentials;
    this.eventBindings.onAutoResumeFailed=this.schedulerRecovery.failPendingSchedulerAutoResume;
    this.eventRuntime=createTerminalTaskEvents({conversations,usage:this.usage,models:this.models,summary:this.summary,
      lifecycle:this.turnLifecycle,changes:this.changes,profileDir:this.options.profileDir,region:this.options.region??'global',logger:this.options.logger,
      current:()=>!this.dataClosed,coordinator:()=>this.inputCoordinator,
      provider:id=>this.runtimeProvider(id),
      fastMode:id=>this.live.get(id)?.maker.getSession(id)?.getFastMode()??false,
      model:async id=>this.live.get(id)?.maker.getSession(id)?.model??(await this.storage.get(id))?.model??'',
      pluginEvents:()=>this.pluginEvents,hasPendingInteraction:id=>[...this.pending.values()].some(entry=>entry.sessionId===id),
      clearPendingInteraction:requestId=>{const entry=this.pending.get(requestId);if(!entry)return null;this.pending.delete(requestId);entry.persistedByEvent=true;return {kind:entry.request.kind,request:entry.request,persistId:entry.persistId,resolve:entry.settle};},
      overflow:this.routes.recovery.runtime,orca:this.orcaTeamService,wireNoteMemory:this.wireNoteMemory,images:this.generatedImages,
      emit:(channel,payload)=>this.emit(channel,payload),
      activityBridge: () => this.sessionActivity.bridge,
      t:key=>createRuntimeTranslator(mainLocaleResources,()=>this.options.language?.()??'en').t(key),bindings:this.eventBindings,
      onSuccessfulProductTurn:(id,owner)=>this.settleLegacyProductTurn(id,'completed',owner),
      onUnsuccessfulProductTurn:(id,owner)=>this.settleLegacyProductTurn(id,'failed',owner),
    });
    this.sessionActivity = await createTerminalSessionActivity({
      database, conversations, log: this.options.logger,
      t: key => createRuntimeTranslator(mainLocaleResources, () => this.options.language?.() ?? 'en').t(key),
      current: () => !this.closed && !this.dataClosed,
      resolveMedia: url => this.media.resolveMediaUrl(url),
      emit: (channel, payload) => this.emit(channel, payload),
      withSessionRouteLock: (id, work) => this.routes.withLock(id, work),
      patchSessionMetaInDb: (id, patch, options) => this.sessions.service.patchSessionMetaInDb(id, patch, { ...options, beforeWrite: () => { this.guard(this.currentInvocation()); options.beforeWrite(); } }),
      hasImBinding: id => !!this.channelBindings.store.findByTarget(id),
      remoteInvoke: async (id, channel, args) => {
        try { if (!this.options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE'); return { ok: true, result: await this.options.remoteInvoke(id, channel, args) }; }
        catch (error) { return { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }; }
      },
      assertTrustedAppRendererEvent: context => this.guard(context),
      isDeviceLinkInvoke: () => this.inputInvocation.getStore()?.source === 'remote',
      getCoordinator: () => this.inputCoordinator,
      getBookkeeping: () => this.eventRuntime.bookkeeping,
      getSession: id => this.live.get(id)?.session,
      isKnownOrcaWorkerSession: id => this.storage.peek(id)?.orcaRole === 'worker' || !!this.storage.peek(id)?.orcaRemoteLead,
      isRemoteAuthRetryErrorEvent: this.eventRuntime.guards.isRemoteAuthRetryErrorEvent,
      isGatewayProxyTokenRecoveryErrorEvent: this.eventRuntime.deps.isGatewayProxyTokenRecoveryErrorEvent,
    });
    for (const id of this.channelBindings.store.listAttachedTargets()) {
      const row = await this.storage.get(id);
      const identity = this.channelBindings.store.findByTarget(id);
      if (identity && (!row || row.deleted || row.archived)) await this.channelBindings.store.detachIfTarget(identity, id);
    }
    for (const kind of ENGINES) this.engineCapabilities.set(kind, ({'claude-code':ClaudeCodeAgent,codex:CodexAgent,pi:PiAgent}[kind]).getDeclaredCapabilities());
    const hostedFile=await readPrivateFile(path.join(this.options.profileDir,'hosted-runtimes.json'));
    if(hostedFile){const ids=JSON.parse(hostedFile.toString());if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)))throw new Error('INVALID_HOSTED_RUNTIME_INDEX');for(const id of ids)this.hostedRuntimeIds.add(id);}
    this.storage.beforeUserMessageWrite = this.recoveryInputs.beforePersist;
    await this.initializeInputCoordinator();
    const transcriptRelocation = createClaudeTranscriptRelocation({
      getDbClient: () => { this.guard(this.currentInvocation()); return database.getDbClient(); },
      defaultClaudeConfigDirCandidates: () => [process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')],
      logger: this.options.logger,
    });
    transcriptRelocation.setLiveCcSessionBridge({
      resolveSdkSessionId: id => this.live.get(id)?.maker.getSession(id)?.sdkSessionId ?? null,
      closeSession: id => this.closeTask(id),
    });
    this.sessions = await createTerminalSessions({
      database, conversations, opening, storage: this.storage, dialogue: this.dialogueWorkspace, activity: this.sessionActivity,
      dialogueWorkspaceRoots: dialogueSettings.dialogueWorkspaceRoots,
      summaries: this.summary, attachments: this.channelFiles, profileDir: this.options.profileDir,
      logger: this.options.logger, current: () => !this.closed,
      assertCurrent: () => this.guard(this.currentInvocation()), context: () => this.currentInvocation(),
      worktrees: () => this.worktrees,
      emit: (channel, payload) => this.emit(channel, payload),
      emitLocal: (channel, payload) => (this.options.emitLocal ?? this.options.emit)(channel, [payload]),
      withRouteLock: (id, action) => this.routes.withLock(id, action),
      cleanupRuntime: id => {
        this.lastLiveUsage.forgetSessionLastLiveUsage(id); this.routes.cancel(id); this.groupBindings.delete(id); this.workdirs.recovery.discard(id);
        this.routes.recovery.runtime.cancelRecovery(id); this.routes.clearProvider(id);
      },
      isAlive: id => this.live.has(id) || this.starts.has(id),
      closeTask: async id => { await this.cancelTaskRecovery(id); await this.closeTask(id); await this.storage.reconcileWorktreeReferences(id); },
      closeSharedTask: this.options.beforeTaskUnavailable,
      notifyGhostSessionEvent: (...args) => this.pluginEvents?.sessions.notifyGhostSessionEvent(...args),
      removeTurnChangeSetsForSession: id => this.changes.store.removeTurnChangeSetsForSession(id),
      settleMakeTasksForSession: id => this.makeManager.settleTasksForSession(id),
      recycleCindyMakeTask: async (id, db, isCurrent) => {
        if (!isCurrent()) return;
        const [row] = await db.select({ source: persistedSessionRows.source }).from(persistedSessionRows).where(dbEq(persistedSessionRows.id, id));
        if (row) assertCindyMakeSessionAvailable(row.source);
      },
      transcriptRelocation,
      options: { resolveContextWindow: session => resolveSessionContextWindow(this.models.catalogRuntime.getActiveCatalog(), session), closeIdleSessionForMove: async id => {
        const session = this.live.get(id)?.maker.getSession(id);
        if (this.starts.has(id) || this.sending.has(id) || session?.isTurnRunning()) return false;
        await this.closeTask(id); return true;
      } },
      t: key => createRuntimeTranslator(mainLocaleResources, () => this.options.language?.() ?? 'en').t(key),
    });
    this.initializeModelSelection(database, conversations);
    this.sessionActivity.service.setCompletionDeferResolver(id => this.inputCoordinator.hasPendingQueuedWork(id) || this.orcaTeamService.hasPendingWorkerReports(id));
    this.goals=createTerminalGoals({database,conversations,models:this.models,usage:this.usage,dataRoot:this.options.dataRoot??this.options.profileDir,logger:this.options.logger,
      runtime:{agentHandoffPending:this.taskContext.handoff,...this.uiSignals},coordinator:this.inputCoordinator,
      session:id=>this.live.get(id)?.maker.getSession(id),
      ensureSession:async id=>{try{return (await this.ensureLive(id)).session;}catch(error){this.options.logger.warn('Goal session restore failed',{sessionId:id,error:String(error)});return undefined;}},
      acquireRoute:id=>this.routes.acquireForSend(id),isSessionInTurn:id=>this.eventRuntime.activity.isSessionInTurn(id),
      resolveSessionRuntimeRoute:(id,_kind,row)=>({providerId:this.routes.providers.hasSessionProvider(id)?this.routes.provider(id):row?.providerId??null,modelId:this.live.get(id)?.maker.getSession(id)?.model??row?.model}),
      isSessionSharedTaskActive:id=>this.options.isSessionShared?.(id)??false,
      hasPendingInteraction:id=>[...this.pending.values()].some(entry=>entry.sessionId===id),canDispatch:()=>!this.closed&&this.pendingDispatchReady,
      assertCurrent:()=>{if(this.dataClosed)throw new Error('TASK_HOST_CLOSED');},snapshots:this.gitSnapshots.coordinator,emit:(channel,payload)=>this.emit(channel,payload),
    });
    this.eventBindings.goalIdle=id=>{void this.goals.idle(id).catch(error=>this.options.logger.warn('Goal idle recovery failed',{sessionId:id,error:String(error)}));};
    this.usageWaits=createUsageLimitWaitHost({
      ...conversations.snapshot,coordinator:()=>this.inputCoordinator,getDbClient:()=>database.getDbClient(),log:this.options.logger,
      activeOwnerScopeKey:()=>conversations.broadcastTap.captureDataOwnerBroadcastScope().ownerScopeKey!,
      ownerScopedUserDataPath:(...parts)=>path.join(this.options.profileDir,...parts),isPassive:()=>!this.pendingDispatchReady,
      isSessionSharedTaskActive:id=>this.options.isSessionShared?.(id)??false,
      goalOwnsUsageLimitProbe:async id=>{const goal=await this.goals.controller.getStatus(id);return goal?.status==='active'||goal?.status==='usageLimited';},
      resolveSessionRuntimeRoute:(id,_kind,row)=>({providerId:this.routes.providers.hasSessionProvider(id)?this.routes.provider(id):row?.providerId??null,modelId:this.live.get(id)?.maker.getSession(id)?.model??row?.model??null}),
      limits:this.goals.limits,
      remoteBackgroundInvoke:async(device,channel,args,options)=>{
        this.guard({source:'local'});options?.preSend?.();
        if(!this.options.remoteInvoke)throw new Error('REMOTE_SOURCE_REQUIRED');
        return this.options.remoteInvoke(device,channel,args);
      },
      readClaudeSubscriptionUsageSnapshotForDeviceLink:this.usage.accounts.readClaudeSubscriptionUsage,
      readCodexAccountUsageSnapshotWithWebRefresh:this.usage.accounts.readCodexAccountUsage,
      beforeContinue: this.schedulerRecovery.beforeContinue,
    });
    this.eventBindings.usageLimitAutoResume=this.usageWaits.usageLimitAutoResume;
    this.usageApi=createTerminalUsageApi({usage:this.usage,conversations,models:this.models,root:this.options.profileDir,logger:this.options.logger,deviceId:this.options.deviceId,
      ownerId:()=>database.getCurrentDbClientUserId(),assertCurrent:()=>this.guard({source:'local'}),
      restored:provider=>this.usageWaits.usageLimitAutoResume.resumeRestored(id=>this.usageWaits.hasRestoredCodexQuota(id,provider)),
    });
    for (const row of await this.storage.list()) {
      this.inputSessions.add(row.id);
      this.inputCoordinator.setExecutionPaused(row.id, !this.pendingDispatchReady);
      await this.inputCoordinator.ensureQueueRestored(row.id);
      if (row.groupBinding) this.groupBindings.set(row.id, row.groupBinding);

    }
    this.guard({ source: 'local' });
    await this.orcaRemoteController.start();
    this.guard({ source: 'local' });
    this.orcaIdle.start();
    this.nativeArchive = createTerminalNativeArchive({
      database, logger: this.options.logger, assertCurrent: () => this.guard({ source: 'local' }),
      withSessionRouteLocks: this.sessions.routes.withSessionRouteLocks,
      session: id => this.live.get(id)?.maker.getSession(id),
      liveAgent: id => this.live.get(id)?.agent,
      canUseRemote: id => this.options.ssh?.pool.get(id)?.getStatus() === 'ready',
      createAgent: id => this.createNativeControlAgent(id),
    });
    const nativeArchive = this.nativeArchive;
    this.sessions.archive.setSessionArchiveSyncRequester(() => { void nativeArchive.request(); });
    this.taskTags=createTaskTags<TaskInvocationContext>({...conversations.broadcastTap,...conversations.notifications,
      getDbClient:()=>{this.guard({source:'local'});return database.getDbClient();},logger:this.options.logger,broadcastLocal:conversations.broadcastLocal,
      ipcMain:{handle:(channel,handler)=>this.botHandlers.set(channel,handler)},
      assertTrustedAppRendererEvent:context=>{this.guard(context);if(context.sharedTask)throw new Error('OWNER_REQUIRED');},
    });
    this.taskTags.registerTaskTagsIpc();
    void nativeArchive.request();
    await this.sessions.service.resumeDeletedPiSubagentCleanup();
    if(this.pendingDispatchReady)void this.goals.restore().catch(error=>this.options.logger.warn('Goal startup restore failed',{error:String(error)}));
  }
  private orcaMcpGuard(context: McpProviderContext, expectedId?: string): () => void {
    const ctx = context.getSessionContext ? context.getSessionContext() : context;
    if (!ctx?.sessionId || expectedId && ctx.sessionId !== expectedId) throw new Error('TASK_MCP_SCOPE_MISMATCH');
    const id = ctx.sessionId, instance = ctx.sessionInstanceId;
    const session = this.live.get(id)?.maker.getSession(id);
    if (!instance || !session || session.instanceId !== instance) throw new Error('TASK_MCP_SCOPE_MISMATCH');
    return () => { this.guard({ source: 'local' }); if (this.live.get(id)?.maker.getSession(id) !== session || session.getStatus() !== 'active') throw new Error('TASK_MCP_SCOPE_REVOKED'); };
  }
  private sshMcpProviders(): McpProvider[] {
    // Legacy remote Codex routes carry an authenticated thread but deliberately
    // omit the instance capability. Ordinary account data keeps that contract;
    // it must not manufacture Full Access authority for helper/Orca controls.
    const accountDataGuard = (ctx: import('@cindy/mcps').LiziMcpSessionContext) => {
      const id = ctx.sessionId, session = id ? this.live.get(id)?.maker.getSession(id) : undefined;
      if (!id || !session || !ctx.remoteHostId || session.remoteHostId !== ctx.remoteHostId ||
        (ctx.sessionInstanceId !== undefined && ctx.sessionInstanceId !== session.instanceId)) throw new Error('TASK_MCP_SCOPE_MISMATCH');
      return () => { this.guard({ source: 'local' }); if (this.live.get(id)?.maker.getSession(id) !== session || session.getStatus() !== 'active') throw new Error('TASK_MCP_SCOPE_REVOKED'); };
    };
    const helper: McpProvider = {name:'cindy_helper',toClaudeSdkConfig:context=>{
      const input=()=>{const active=context.getSessionContext?.()??context;this.orcaMcpGuard(context)();return {sessionId:active.sessionId!,workingDir:active.workingDir,agentKind:active.agentKind};};
      return {type:'sdk',name:'cindy_helper',instance:createXdtHelperMcpServer({
        history:this.historyDeps(),
      resolveSurface:({sessionId})=>this.helperSurface(sessionId),
      sessionControl:this.sessionControls.service,
      ...(this.botDelegations?{sessionTasks:{
        startSessionTask:this.botDelegations.startSessionTask,
        messageSessionTask:({callerSessionId,taskId,reply})=>this.botDelegations!.messageSessionTask(callerSessionId,taskId,reply),
        getSessionTask:({callerSessionId,taskId,queuedMessageId})=>this.botDelegations!.getSessionTask(callerSessionId,taskId,queuedMessageId),
        stopSessionTask:({callerSessionId,taskId,mode})=>this.botDelegations!.stopSessionTask(callerSessionId,taskId,mode),
        inspectSessionTaskRoute:({callerSessionId,taskId})=>this.botDelegations!.inspectSessionTaskRoute(callerSessionId,taskId),
        advanceSessionTaskRoute:({callerSessionId,taskId,expectedGeneration,selectionToken})=>this.botDelegations!.advanceSessionTaskRoute(callerSessionId,taskId,expectedGeneration,selectionToken),
      }}:{}),sessionQueue:{listSessionQueue:async id=>(await this.sessionQueueReader()).listSessionQueue(id),listSessionQueuedCounts:async ids=>(await this.sessionQueueReader()).listSessionQueuedCounts(ids)},
        setCurrentSessionTitle:args=>this.helperDeps(input()).setCurrentSessionTitle!(args),
        sendToSession:args=>this.helperDeps(input()).sendToSession!(args),
        authorizeCall:async call=>{const current=this.orcaMcpGuard(context);current();const decision=await this.authorizeTaskToolCall?.(call);if(decision&&!decision.ok)return decision;return {ok:true,run:async operation=>{const run=async()=>{current();const result=await operation();current();return result;};return decision?.run?decision.run(run):run();}};},
      },context)};
    }};
    return [...gateBuiltinMcpProviders(this.deviceTools.providers,this.builtinTools),this.orcaTools.provider,this.localWorkerMcpProvider(),helper,...(this.knowledge?[this.knowledge.sshProvider(accountDataGuard)]:[]),...this.mcpApps.remoteProviders()];
  }
  private async endOrca(id: string) {
    return this.routes.withLock(id, async () => {
      const authority = await this.captureOrcaAuthority(id), team = await this.orcaStore.getActiveTeamByLead(id);
      await authority.assertCurrent();
      if (team) {
        for (const worker of await this.orcaStore.listWorkersByLead(id)) {
          await authority.assertCurrent();
          const result = await this.orcaTeamService.archiveWorker({ callerLeadSessionId: id, workerId: worker.id, beforeArchive: authority.assertCurrent });
          if (!result.ok) throw new Error(result.message);
        }
        await authority.assertCurrent(); await this.orcaStore.markTeamEnded(team.id, 'completed');
        await this.orcaStore.markWorkerStatusesByTeam(team.id, 'done');
      } else {
        for (const worker of await this.orcaStore.reconcileInactiveTeamWorkersForLead(id)) {
          await authority.assertCurrent(); await this.closeTask(worker);
          this.orcaTeamService.clearAutoBridgeState(worker);
        }
      }
      await authority.assertCurrent(); await this.orcaStore.setSessionOrcaRole(id, null);
      await this.live.get(id)?.maker.getSession(id)?.setVendorOptions({ orcaRole: null, orcaWorkflowId: null, orcaLeadSessionId: null, initialWorker: null });
      this.emit('maker:orca:worker-changed', { leadSessionId: id });
    });
  }
  private localWorkerMcpProvider(id?: string): McpProvider {
    return { name: 'orca_worker_bridge', toClaudeSdkConfig: context => {
      const callerId=()=>{const active=context.getSessionContext?.()??context;const value=id??active.sessionId;if(!value)throw new Error('TASK_MCP_SCOPE_MISMATCH');return value;};
      const current = () => this.orcaMcpGuard(context, callerId())();
      const linkForCaller = async (input: { workerId?: string; workerSessionId?: string }) => {
        current();
        if (input.workerSessionId && input.workerSessionId !== callerId()) throw new Error('TASK_MCP_SCOPE_MISMATCH');
        const link = await this.orcaStore.getWorkerLink({ ...input, workerSessionId: callerId() });
        if (!link) return null;
        const [team, worker, lead] = await Promise.all([this.orcaStore.getActiveTeamByLead(link.leadSessionId), this.storage.get(callerId()), this.storage.get(link.leadSessionId)]);
        current();
        return team?.id === link.teamId && worker && !worker.deleted && !worker.archived && lead && !lead.deleted && !lead.archived ? link : null;
      };
      return createOrcaWorkerBridgeMcpProvider({
        logger: this.options.logger, sharedBridge: true, manageWorkerStatus: false,
        ensureSession: async meta => { current(); const link = await linkForCaller({ workerSessionId: callerId() });
          if (link?.leadSessionId !== meta.sessionId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
          const task = await this.ensureLive(meta.sessionId); current(); return task.session; },
        orcaTeamStore: {
          getWorkerLink: async input => {
            const link = await linkForCaller(input);
            if (!link) return null;
            const { effort, permissionMode, ...leadSession } = link.leadSession;
            return { ...link, workflowId: link.teamId, leadSession: { ...leadSession,
              permissionMode: permission(permissionMode), ...(effort ? { effort: effort as import('@cindy/maker-core').Effort } : {}) } };
          },
          updateWorkerStatus: async (workerId, status) => { const link = await linkForCaller({ workerId }); if (!link) throw new Error('ORCA_ASSIGNMENT_REVOKED'); await this.orcaStore.updateWorkerStatus(workerId, status); },
        },
        persistUserMessage: async (target, message) => { current(); await this.storage.append(target, { kind: 'user', clientId: message.clientId, message: { type: 'user', content: message.content } }); },
        readLeadHistory: async input => {
          const link = await linkForCaller({ workerSessionId: callerId() });
          if (link?.leadSessionId !== input.leadSessionId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
          const page = await createRemoteHistory(this.historyDeps(), taskId => this.storage.get(taskId), current, this.history.readLatestSessionTerminal).messages({
            sessionId: input.leadSessionId, fromMs: input.fromMs, toMs: null, roles: ['user', 'assistant'],
            workdir: null, agentKind: null, limit: input.limit, cursor: input.cursor, order: 'asc', includeRewound: false });
          current(); return { ...page, items: page.items.flatMap(item => item.role === 'user' || item.role === 'assistant'
            ? [{ ...item, role: item.role, agentMeta: item.agentMeta ?? null }] : []) };
        },
        dispatchInterAgentMessage: async input => {
          const link = await linkForCaller({ workerId: input.workerId, workerSessionId: callerId() });
          if (input.source !== 'worker' || link?.leadSessionId !== input.targetSessionId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
          const capture = this.orcaTeamService.captureWorkerTerminalTurn(callerId());
          const result = await this.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(input);
          if (result.ok) await this.orcaTeamService.settleReportedWorker(capture);
          return result;
        },
      }).toClaudeSdkConfig(context);
    } };
  }
  private async captureOrcaAuthority(id: string) {
    const current = this.orcaAction.getStore();
    const row = await this.storage.get(id);
    if (!row || row.archived || row.deleted || row.orcaRole === 'worker' || row.orcaRemoteLead && row.orcaRemoteLead.releasedAt === undefined) throw new Error('ORCA_LEAD_UNAVAILABLE');
    const plugin = this.pluginSessions?.captureOrcaAuthority
      ? await this.pluginSessions.captureOrcaAuthority(id, this.activeSubmissions.get(id)) : undefined;
    if (!plugin && row.source === 'plugin') throw new Error('PLUGIN_TASK_AUTHORITY_UNAVAILABLE');
    const assertCurrent = async () => {
      this.guard({ source: 'local' }); current?.();
      const latest = await this.storage.get(id);
      if (!latest || latest.archived || latest.deleted || latest.source !== row.source || latest.orcaRole === 'worker') throw new Error('ORCA_LEAD_UNAVAILABLE');
      await plugin?.assertCurrent(); this.guard({ source: 'local' }); current?.();
    };
    await assertCurrent(); return { permissionMode: plugin?.permissionMode, assertCurrent };
  }
  private async authState(kind: AgentKind) {
    if (kind === 'codex' && this.models?.openAiAccount()) return { authenticated: this.models.openAiAccount()!.connected(), authSource: 'oauth' as const };
    const cached = this.authCache.get(kind);
    if (cached && Date.now() - cached.at < 15_000) return cached.value;
    const value = await (this.options.nativeStatus ?? nativeAuthState)(kind, this.binaries.get(kind) ?? null);
    this.authCache.set(kind, { at: Date.now(), value });
    return value;
  }
  private createOrcaDispatcher() {
    const createOpts = (row: TerminalTaskMeta) => ({ agentKind: row.agentKind, workingDir: row.workDir,
      model: row.model, providerId: row.providerId, effort: row.effort, fastMode: row.fastMode,
      permissionMode: row.permissionMode, orcaRole: row.orcaRole });
    return createOrcaInterAgentDispatcher<TerminalTaskMeta>({
      createId: randomUUID,
      getSessionMeta: id => this.storage.get(id),
      getSessionRowSnapshot: async id => { const row = await this.storage.get(id); return row ? {
        title: row.title ?? null, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active',
        userSendAt: row.userSendAt ?? null,
      } : null; },
      getLiveSession: id => this.live.get(id)?.maker.getSession(id),
      readAutoReviewHistory: async id => (await this.contextMessages(id, Infinity)).map(row => ({ ...row, agentMeta: row.agentMeta ?? null })),
      // Every terminal turn has a durable receipt, including an idle target.
      // Only explicit same-turn steering may bypass the new-turn queue.
      shouldQueueNewTurn: () => true,
      hasSendToSessionLock: id => this.routes.isLocked(id),
      withSendToSessionLock: (id, work) => this.routes.withLock(id, work),
      hasPendingAgentSwitch: id => this.routes.intent(id) !== null,
      steerControlInput: (id, item, expected) => this.steerOrcaInput(id, item, expected),
      buildCreateOptsForQueuedSession: async (_id, row) => createOpts(row),
      enqueueQueuedMessage: async (id, item) => { await this.enqueueOrcaInput(id, item); },
      reserveNextQueuedMessage: async (id, item, onReserved, beforeReserve) => {
        await this.enqueueOrcaInput(id, item, true, onReserved, beforeReserve);
        return true;
      },
      validateImageAttachments: async paths => {
        const images = [];
        for (const reference of paths) {
          const file = path.isAbsolute(reference) ? reference : (await this.media.resolveManaged(reference)).path;
          const ext = path.extname(file).toLowerCase(), mimeType = ({ '.png': 'image/png', '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' } as Record<string, string>)[ext];
          const info = await stat(file);
          if (!mimeType || !info.isFile() || info.size > 64 * 1024 * 1024) return { ok: false, message: 'INVALID_IMAGE_ATTACHMENT' };
          images.push({ path: file, name: path.basename(file), ext, size: info.size, mimeType });
        }
        return { ok: true, images };
      },
      resolveWorkerSessionLink: id => this.orcaStore.getWorkerLink({ workerId: id }),
      resolveWorkerSenderLabel: async (id, fallback) => {
        const link = await this.orcaStore.getWorkerLink({ workerId: id });
        return link ? (await this.orcaStore.listWorkersByLead(link.leadSessionId)).find(worker => worker.id === id)?.role ?? fallback : fallback;
      },
      // The shared dispatcher's cold/direct ports retain the same durable
      // ingress if its scheduling policy changes in a future host version.
      sendToSessionInternal: async input => {
        const row = await this.storage.get(input.targetSessionId);
        if (!row || row.deleted || row.archived) return { ok: false, errorCode: 'NOT_FOUND', message: 'TASK_NOT_FOUND' };
        if (input.onAccepted) this.orcaDispatcher.registerQueuedOrcaInterAgentAcceptedCallback(input.clientId,
          input.onAccepted, input.onAcceptedRollback, input.onAcceptedCommit);
        try {
          await this.enqueueOrcaInput(row.id, { clientId: input.clientId, text: input.message, persistedContent: input.persistedContent,
            origin: input.origin, model: row.model, effort: row.effort ?? '', permissionMode: row.permissionMode ?? 'ask', workingDir: row.workDir,
            createOpts: createOpts(row), chatMessage: { clientId: input.clientId, role: 'user', content: input.persistedContent, createdAt: new Date().toISOString() } });
          return { ok: true, targetSessionId: row.id, agentKind: row.agentKind, wakeKind: 'queued', targetTitle: row.title ?? null,
            targetLastUserSendAt: row.userSendAt ? new Date(row.userSendAt).toISOString() : null };
        } catch (error) { this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(input.clientId); throw error; }
      },
      createDbMessage: (id, input) => this.storage.append(id, { kind: 'user', message: { type: 'user', content: input.content },
        clientId: input.clientId, origin: 'local', agentMeta: input.agentMeta }),
      beginDirectTurnChangeSet: async (id, clientId) => { await this.changes.begin((await this.ensureLive(id)).session, clientId); },
      abortDirectTurnChangeSet: id => this.changes.store.clearPendingTurnChangeSets(id),
      isSessionRunningError: error => error instanceof Error && error.message === 'SESSION_RUNNING',
      log: this.options.logger,
    }, this.options.logger);
  }
  private async enqueueOrcaInput(id: string, item: AgentInputQueuedMessage, atHead = false,
    onReserved?: () => void, beforeReserve?: () => Promise<void>) {
    await this.ready;
    return this.mutateQueued(id, async () => {
        await beforeReserve?.();
        const collaboration = await captureTerminalOrcaInput(this.orcaStore, this.storage, id, item);
        const receipt = await this.submit(id, { text: item.text, files: item.files, mentions: item.mentions },
          { requestId: item.clientId }, { source: 'local', collaboration }, atHead);
        await onReserved?.();
        return receipt;
    });
  }
  private async mutateQueued<T>(id: string, work: () => Promise<T>): Promise<T> {
    return this.routes.withLock(id, async () => {
      this.queueMutations.add(id);
      try { return await work(); }
      finally { this.queueMutations.delete(id); setImmediate(() => this.drain(id)); }
    });
  }
  private createOrcaTeamControls(): OrcaTeamService {
    const changed = (leadSessionId: string) => this.emit('maker:orca:worker-changed', { leadSessionId });
    const closeIfIdle = async (id: string) => {
      await this.inputCoordinator.ensureQueueRestored(id);
      if (!this.inputCoordinator.isQueueRestored(id) || this.inputCoordinator.hasPendingQueuedWork(id)
        || this.inputCoordinator.hasQueuedItemWhere(id, () => true, { includeRecovery: true })) return false;
      const session = this.live.get(id)?.maker.getSession(id);
      return session ? session.closeIfIdle() : true;
    };
    return createOrcaTeamService(this.orcaRemoteController.wrapTeamDeps({
      isWorkerLabelLockedByPlan: async input => this.pluginSessions?.isWorkerLabelLockedByPlan?.(input) ?? false,
      onLeadWorkerReportsSettled: id => {
        if (this.eventRuntime && !isSessionTurnDispatchBoundaryBusy(this.eventRuntime.activity, id, this.live.get(id)?.session))
          this.sessionActivity?.service.notifyQueueEmptied(id);
      },
      captureControlAuthority: async leadId => {
        // The shared queue tools also let a Worker manage collaboration input
        // in its own queue. Resolve its real Lead without granting a new team.
        const worker = (await this.storage.get(leadId))?.orcaRole === 'worker'
          ? await this.orcaStore.getWorkerLink({ workerSessionId: leadId }) : null;
        const authorityId = worker?.leadSessionId ?? leadId;
        const authority = await this.captureOrcaAuthority(authorityId);
        const team = await this.orcaStore.getActiveTeamByLead(authorityId);
        if (worker && team?.id !== worker.teamId) throw new Error('ORCA_TEAM_NOT_FOUND');
        return async () => {
          await authority.assertCurrent();
          this.guard({ source: 'local' });
          const [current, row, link] = await Promise.all([this.orcaStore.getActiveTeamByLead(authorityId), this.storage.get(leadId),
            worker ? this.orcaStore.getWorkerLink({ workerSessionId: leadId }) : null]);
          if (current?.id !== team?.id || !row || row.deleted || row.archived || worker && link?.workerId !== worker.workerId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
        };
      },
      captureDeliveryAuthority: async leadId => {
        const owner = this.options.currentOwnerSession?.();
        const readRow = async () => {
          const row = await this.storage.get(leadId);
          return row ? {
            status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active',
            clearedAt: row.clearedAt ?? null,
            permissionMode: row.permissionMode ?? 'default',
            planModeEnabled: row.planMode ?? false,
          } : null;
        };
        const live = () => this.live.get(leadId)?.maker.getSession(leadId) ?? null;
        const baselines = captureOrcaDeliveryBaselines({ row: await readRow(), live: live() });
        return async () => {
          this.guard({ source: 'local' });
          const row = await readRow(), currentOwner = this.options.currentOwnerSession?.();
          this.guard({ source: 'local' });
          if (owner?.dataOwnerId !== currentOwner?.dataOwnerId || owner?.generation !== currentOwner?.generation
            || evaluateOrcaDeliveryScope({ ...baselines, row, live: live() }) !== 'ok') {
            throw new Error('ORCA_ASSIGNMENT_REVOKED');
          }
        };
      },
      getWorkerLinkBySessionId: workerSessionId => this.orcaStore.getWorkerLink({ workerSessionId }),
      getWorkerLinkByWorkerId: workerId => this.orcaStore.getWorkerLink({ workerId }),
      listWorkersByLead: id => this.orcaStore.listWorkersByLead(id),
      getLiveSession: id => this.live.get(id)?.maker.getSession(id) ?? null,
      resumeWorkerSession: worker => this.routes.withLock(worker.sessionId, async () => {
        const link = await this.orcaStore.getWorkerLink({ workerId: worker.id, workerSessionId: worker.sessionId });
        if (!link || (await this.orcaStore.getActiveTeamByLead(link.leadSessionId))?.id !== link.teamId) throw new Error('ORCA_ASSIGNMENT_REVOKED');
        await this.ensureLive(worker.sessionId);
      }),
      updateWorkerStatus: (id, status) => this.orcaStore.updateWorkerStatus(id, status),
      updateWorkerIdentity: input => this.orcaStore.updateWorkerIdentity(input),
      markWorkerIdle: id => this.orcaStore.markWorkerIdle(id),
      markWorkerIdleIfStatus: (id, status) => this.orcaStore.markWorkerIdleIfStatus(id, status),
      restoreWorkerDoneIfIdle: id => this.orcaStore.restoreWorkerDoneIfIdle(id),
      closeWorkerSession: (id, beforeClose, sendLockHeld) => {
        const close = async () => {
          await beforeClose?.(); this.manualOrcaInterrupts.set(id, { markedAt: Date.now(), reason: 'lead_idle' });
          const session = this.live.get(id)?.maker.getSession(id);
          if (session) await session.abort();
          await beforeClose?.(); await this.closeTask(id);
        };
        return sendLockHeld ? close() : this.routes.withLock(id, close);
      },
      closeWorkerSessionIfIdle: (id, lockHeld) => lockHeld ? closeIfIdle(id) : this.routes.withLock(id, () => closeIfIdle(id)),
      hasPendingWorkerInput: async id => {
        await this.inputCoordinator.ensureQueueRestored(id).catch(() => undefined);
        return !this.inputCoordinator.isQueueRestored(id) || this.inputCoordinator.hasPendingQueuedWork(id)
          || this.inputCoordinator.hasQueuedItemWhere(id, () => true, { includeRecovery: true });
      },
      hasSendToSessionLock: id => this.routes.isLocked(id),
      withSessionSendLock: (id, work) => this.routes.withLock(id, work),
      archiveWorkerSession: async (id, beforeMutation) => {
        const scope = this.sessions.service.captureSessionRecycleScope();
        await this.orcaStore.archiveSingleWorkerSession(id, beforeMutation);
        await beforeMutation?.();
        this.sessions.service.scheduleWorktreeRecycleForStatusChange(id, 'archived', scope);
      },
      getManualInterrupt: id => this.manualOrcaInterrupts.get(id) ?? null,
      clearManualInterrupt: id => { this.manualOrcaInterrupts.delete(id); },
      restoreManualInterrupt: (id, snapshot) => { this.manualOrcaInterrupts.set(id, snapshot); },
      forgetWorkerSession: id => { this.manualOrcaInterrupts.delete(id); this.orcaTeamService.clearAutoBridgeState(id); },
      broadcastOrcaWorkerChanged: changed,
      dispatchWorkerMessage: async params => {
        const result = await this.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...params, source: 'lead', senderLabel: 'Lead',
          rawContent: params.message, meta: params.dispatchMeta });
        return result.ok ? { ...result, targetTitle: result.targetTitle ?? null, targetLastUserSendAt: result.targetLastUserSendAt ?? null } : result;
      },
      reserveWorkerMessage: async params => {
        const result = await this.orcaDispatcher.reserveNextOrcaInterAgentMessage({ ...params, source: 'lead', senderLabel: 'Lead',
          rawContent: params.message, meta: params.dispatchMeta });
        return result.ok ? { ...result, targetTitle: result.targetTitle ?? null, targetLastUserSendAt: result.targetLastUserSendAt ?? null } : result;
      },
      requestWorkerInterrupt: async id => {
        this.manualOrcaInterrupts.set(id, { markedAt: Date.now(), reason: 'lead_interrupt' });
        const session = this.live.get(id)?.maker.getSession(id);
        const result = session ? await session.requestGracefulStop() : { status: this.starts.has(id) || this.sending.has(id) ? 'unconfirmed' as const : 'no-active-turn' as const };
        return { stopOutcome: result.status, queuePaused: this.inputCoordinator.isQueuePaused(id) };
      },
      getWorkerQueuePaused: id => this.inputCoordinator.isQueuePaused(id),
      getSessionQueueSnapshot: async id => {
        await this.inputCoordinator.ensureQueueRestored(id);
        const snapshot = this.inputCoordinator.getQueueControlSnapshot(id);
        return { pendingQueue: snapshot.pendingQueue, steeringClientIds: snapshot.steeringQueueClientIds,
          consumingClientIds: this.inputCoordinator.getQueueInspection(id).filter(item => item.consuming).map(item => item.queuedMessageId),
          isWorking: this.isTurnRunning(id), willQueue: this.inputCoordinator.shouldQueueNewTurn(id) || this.routes.isLocked(id), queuePaused: this.inputCoordinator.isQueuePaused(id) };
      },
      ensureWorkerQueueRestored: async id => { await this.ready; await this.inputCoordinator.ensureQueueRestored(id); return this.inputCoordinator.isQueueRestored(id); },
      removeQueuedMessage: (id, clientId, expected) => this.orcaQueue.remove(id, clientId, expected),
      replaceQueuedMessage: (id, clientId, next, expected) => this.orcaQueue.replace(id, clientId, next, expected),
      mergeQueuedMessages: (id, clientIds, build) => this.orcaQueue.merge(id, clientIds, build),
      moveQueuedMessage: (id, clientId, position) => this.orcaQueue.move(id, clientId, position),
      steerStoredQueuedMessage: (id, clientId) => this.steerQueuedOrcaInput(id, clientId),
      sendAutoBridgeToLead: async (id, message, workerId) => {
        const result = await this.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ targetSessionId: id, rawContent: message,
          source: 'worker', senderLabel: 'Worker', workerId, meta: { source: 'orca', context: `worker_auto_bridge/${id}/${workerId}` } });
        return { accepted: result.ok };
      },
      log: this.options.logger,
    }));
  }
  /** Called with the route lock held, including by the shared dispatcher. */
  private steerOrcaInput(id: string, item: AgentInputQueuedMessage,
    expected: { session: object; turnGeneration: number }, targetPlugin?: { id: string; name: string }): Promise<ControlSteerOutcome> {
    const operation = this.performOrcaSteer(id, item, expected, targetPlugin);
    this.steerOperations.add(operation);
    void operation.finally(() => this.steerOperations.delete(operation)).catch(() => undefined);
    return operation;
  }
  private async performOrcaSteer(id: string, item: AgentInputQueuedMessage,
    expected: { session: object; turnGeneration: number }, targetPlugin?: { id: string; name: string }): Promise<ControlSteerOutcome> {
    const collaboration = targetPlugin ? undefined : await captureTerminalOrcaInput(this.orcaStore, this.storage, id, item);
    this.inputContexts.set(id + ':' + item.clientId, { source: 'local', collaboration, targetPlugin });
    const result = await this.inputCoordinator.steerControlInput(id,
      this.inputCoordinator.hasPendingQueueItem(id, item.clientId) ? { queuedClientId: item.clientId } : { item },
      { ...expected, beforeMutation: () => targetPlugin ? this.assertPluginTargetInput(id, item.clientId)
        : assertTerminalOrcaInput(this.orcaStore, this.storage, id, collaboration!) });
    await (await this.database).inputQueue.awaitAgentInputQueueSnapshotPersistence(id);
    return result;
  }
  private async steerQueuedOrcaInput(id: string, clientId: string): Promise<QueuedSteerOutcome> {
    const live = this.live.get(id)?.maker.getSession(id);
    if (!live?.isTurnRunning()) return { kind: 'queued', reason: 'NO_ACTIVE_TURN' };
    if (!live.capabilities.sameTurnSteer.supported || live.remoteHostId) return { kind: 'queued', reason: 'STEER_UNSUPPORTED' };
    if (this.routes.isLocked(id)) return { kind: 'queued', reason: 'INPUT_BOUNDARY_BUSY' };
    const expected = { session: live, turnGeneration: live.getTurnGeneration() };
    return this.routes.withLock(id, async () => {
      const item = (await this.orcaQueue.snapshot(id)).find(row => row.clientId === clientId);
      if (!item) return { kind: 'gone' };
      const result = await this.steerOrcaInput(id, item, expected);
      if (result === 'steered') return { kind: 'steered' };
      if (result === 'rejected') return { kind: 'gone' };
      return { kind: 'queued', reason: result === 'queued' ? 'STEER_UNCERTAIN'
        : live.isTurnRunning() ? 'INPUT_BOUNDARY_BUSY' : 'NO_ACTIVE_TURN' };
    });
  }
  private emit(channel: string, payload: unknown, destination: 'all' | 'local' | 'remote' = 'all', extra: unknown[] = []) {
    if (this.closed) return;
    if (destination !== 'remote' && channel === 'local-db:sessions:patched') {
      const value = payload as { sessionId?: string; patch?: Record<string, unknown> };
      if (value.sessionId && value.patch) this.sessionActivity?.metadata(value.sessionId, value.patch);
    }
    if (destination !== 'remote' && ['local-db:messages:created','local-db:messages:deleted','local-db:messages:agent-meta-updated'].includes(channel)) {
      const sessionId=(payload as {sessionId?:string})?.sessionId;if(sessionId)this.storage.noteMessageChanged(sessionId);
    }
    if (destination !== 'remote' && channel === 'local-db:messages:created') {
      const event = payload as { sessionId?: string; message?: { role?: string } };
      if (event?.sessionId && event.message?.role === 'user') this.orcaIpc?.history.notifyUserMessagePersisted(event.sessionId);
    }
    try {
      if (destination === 'remote') this.options.emitRemote?.(channel, [payload]);
      else (destination === 'local' ? this.options.emitLocal ?? this.options.emit : this.options.emit)(channel, [payload, ...extra]);
    }
    catch { this.options.logger.warn('Terminal subscriber delivery failed', { channel }); }
  }
  private view(row: TerminalTaskMeta) {
    const live = this.live.get(row.id);
    const { pendingHandoff: _handoff, goalContinuation: _goal, ...publicRow } = row;
    return { ...publicRow, sessionId: row.id, status: live?.session.getStatus() ?? 'idle', isTurnRunning: this.isTurnRunning(row.id), pendingInteractions: [...this.pending.values()].filter(p => p.sessionId === row.id && !p.migrated).map(p => p.request), ...(this.persistenceFaults.has(row.id) ? { persistenceError: true } : {}) };
  }
  private guiSession(row: TerminalTaskMeta) {
    return {
      ...this.view(row),
      userId: '', workingDir: row.workDir, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active',
      runtimeStatus: this.live.get(row.id)?.maker.getSession(row.id)?.getStatus() ?? 'idle',
      agentKind: row.agentKind === 'claude-code' ? 'cc' : row.agentKind,
      sdkSessionId: row.sdkSessionId ?? null, providerId: row.providerId ?? null,
      agentSwitchIntent: this.routes.intent(row.id),
      planModeEnabled: row.planMode ?? false, fastMode: row.fastMode ?? false,
      pinnedAt: row.pinnedAt ? new Date(row.pinnedAt).toISOString() : null,
      parentSessionId: row.parentSessionId ?? null, remoteHostId: row.remoteHostId ?? null, agentDeviceId: row.agentDeviceId ?? null,
      createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
      userSendAt: row.userSendAt ? new Date(row.userSendAt).toISOString() : null,
      ...(row.source === 'feishu' ? { feishuBotAppId: row.imBotContextId ?? null, feishuOpenId: row.imUserId ?? null } : {}),
      totalTokenUsage: (this.live.get(row.id)?.maker.getSession(row.id)?.getUsageSnapshot() ?? row.usage)?.tokenUsage ?? 0, totalCostUsd: (this.live.get(row.id)?.maker.getSession(row.id)?.getUsageSnapshot() ?? row.usage)?.costUsd ?? 0, contextTokens: (this.live.get(row.id)?.maker.getSession(row.id)?.getUsageSnapshot() ?? row.usage)?.contextTokens ?? 0, contextWindow: (this.live.get(row.id)?.maker.getSession(row.id)?.getUsageSnapshot() ?? row.usage)?.contextWindow ?? 0,
      extraDirs: [], writableDirs: [],
    };
  }
  resolveManaged(url: string, sessionId?: string) { return this.media.resolveManaged(url, sessionId); }
  async configureProvider(action:'create'|'edit',provider:unknown,keys:unknown,context:InvocationContext) {
    await this.ready;
    this.guard(context);
    await this.models.saveProvider(provider,keys,action==='create',()=>this.guard(context));
    this.emit('maker:provider:changed',{});
    return {success:true};
  }
  registerCapabilityResources(registry:import('@cindy/device-link').RemoteResourceRegistry,configuration:import('../configuration.js').TerminalConfiguration) { registerCapabilityResources(registry,this.capabilities,configuration); registerUtilityModelResources(registry, this.utility); }
  /** Reuse media adoption for independently persisted companion transcripts.
   * The caller supplies its own profileDir to normalizeTaskInput, owns acceptance
   * callbacks, and does not create a regular task in this host. */
  attachmentHost(): Pick<InputHost, 'ingestAttachment' | 'resolveAttachment'> {
    return {
      ingestAttachment: this.options.ingestAttachment ?? ((input,context) => this.media.ingest(input, () => this.guard(context))),
      resolveAttachment: async (reference,context,sessionId) => {
        this.guard(context);
        if(reference.startsWith('cindy-media://')) return this.media.resolveManaged(reference, context.sharedTask ? sessionId : undefined);
        if(!this.options.resolveAttachment) throw new Error('ATTACHMENT_RESOLVER_REQUIRED');
        const value=await this.options.resolveAttachment(reference,context,sessionId);this.guard(context);return value;
      },
    };
  }
  async resumePending(){
    await this.ready;this.guard({source:'local'});
    const ids=[...this.inputSessions],lock='owner-startup:'+randomUUID();
    for(const id of ids)this.inputCoordinator.setInteractionLock(id,lock,true);
    try{
      this.pendingDispatchReady=true;
      for(const id of ids)this.inputCoordinator.setExecutionPaused(id,false);
      await this.usageWaits.restoreUsageLimitWaits();
      this.guard({source:'local'});
    }catch(error){
      this.pendingDispatchReady=false;
      for(const id of ids)this.inputCoordinator.setExecutionPaused(id,true);
      throw error;
    }finally{for(const id of ids)this.inputCoordinator.setInteractionLock(id,lock,false);}
    for(const id of ids)this.drain(id);
    await this.goals.restore();
  }
  configurePluginSessions(hooks: TerminalPluginSessionHooks): TerminalPluginSessionPort {
    this.pluginSessions = hooks;
    const guard = () => this.guard({ source: 'local' });
    const execution = (id: string) => {
      const session = this.live.get(id)?.maker.getSession(id);
      return session && (session.isTurnRunning() || session.getTurnControlSnapshot().pendingInteractionCount > 0)
        ? { instanceId: session.instanceId, generation: session.getTurnGeneration() } : null;
    };
    return {
      resolve: async route => {
        guard(); const { selection } = await this.selection({ ...route, ...(route.agentKind ? {agentKind:route.agentKind==='cc'?'claude-code':route.agentKind}: {}) }); guard();
        return { agentKind: selection.agentKind==='claude-code'?'cc':selection.agentKind, providerId:selection.providerId, model:selection.model, effort:selection.effort??'', fastMode:route.fastMode??false };
      },
      create: async (input, current, onPersistenceStarted) => {
        const check=()=>{guard();current();}; check();
        await this.create({title:input.title,...input.route,agentKind:input.route.agentKind==='cc'?'claude-code':input.route.agentKind,permissionMode:input.permissionMode,...(input.workingDir?{workingDir:input.workingDir}:{})}, check, {id:input.id,hidden:input.hidden,onPersistenceStarted});
      },
      read: async id => {
        const row=await this.storage.get(id); guard();
        if(!row || row.source!=='plugin' || row.agentDeviceId || row.remoteHostId || row.orcaRole&&row.orcaRole!=='lead')return null;
        const runtime=await this.runtimeRecovery.readProfiles(id);guard();
        const selected=runtime?.pendingMutation?.profile??runtime?.effective;
        const kind=selected?.agentKind??row.agentKind;
        const resolvedConfig={agentKind:kind==='claude-code'?'cc' as const:kind,providerId:selected?.providerId??row.providerId??'',model:selected?.model??row.model,effort:selected?.effort??row.effort??'',fastMode:selected?.fastMode??row.fastMode??false};
        const status=row.deleted?'deleted' as const:row.archived?'archived' as const:'active' as const;
        const revision=Number.parseInt(createHash('sha256').update(JSON.stringify([resolvedConfig,row.permissionMode,row.planMode,row.workDir,status,row.clearedAt])).digest('hex').slice(0,12),16);
        return {taskId:id,title:row.title??'',status,revision,resolvedConfig,workingDir:row.workDir,permissionMode:row.permissionMode,planModeEnabled:row.planMode===true,hidden:row.hiddenAt!=null};
      },
      setModel: async(id,route,current)=>{
        guard();await current();
        const control=this.sessionControls.service;
        const state=await control.getSessionRuntime({targetSessionId:id});
        if(!state.ok)throw new PluginTaskError('TASK_NOT_FOUND',state.message);
        await current();guard();
        const target=route.agentKind==='cc'?'claude-code':route.agentKind;
        const pending=state.runtime.pendingMutation?.profile.agentKind;
        const selectHarness=state.runtime.effectiveProfile.agentKind!==target||pending!==undefined&&pending!==target;
        const result=await control.setSessionRuntime({targetSessionId:id,expectedGeneration:state.runtime.runtimeGeneration,
          beforeMutation:current,patch:{...(selectHarness?{harness:target}:{}),model:route.model,providerId:route.providerId,
            effort:(route.effort||null) as import('@cindy/maker-core').Effort|null,fastMode:route.fastMode}});
        guard();if(!result.ok)throw new PluginTaskError(result.errorCode,result.message);
        return {status:result.status};
      },
      live: id=>{guard();return this.live.get(id)?.maker.getSession(id);},
      inspect: async id=>{const pending=await this.storage.queued(id);guard();return {execution:execution(id),pending:pending.map(row=>({clientId:row.requestId}))};},
      dispatch: async (plugin,id,clientId,text,images,current)=>{
        const check=()=>{guard();current();};check();
        const attachments=[];
        for(const image of images){const media=await this.media.ingest({sessionId:id,bytes:image.buffer,mimeType:image.mimeType,name:image.name},check);check();attachments.push({type:'image' as const,path:media.path,mimeType:image.mimeType,name:image.name});}
        const receipt=await this.submit(id,{text,...(attachments.length?{files:attachments}:{})},{requestId:clientId},{source:'local',plugin,assertCurrent:check});
        check();return {ok:!['failed','interrupted'].includes(receipt.status)};
      },
      cancel: async (id,clientIds,expected,current)=>{
        const check=()=>{guard();current();};check();
        for(const receipt of await this.storage.queued(id))if(clientIds.includes(receipt.requestId))await this.removeQueued(id,receipt.requestId,{source:'local',assertCurrent:check});
        if(!expected)return 'cancelled';
        return this.routes.withLock(id,async()=>{check();if(!isSameSessionExecution(execution(id),expected))return 'stale' as const;await this.invoke('maker:input:stop',[id],{source:'local',assertCurrent:check});check();return 'stopping' as const;});
      },
      hidden: async(id,value,current)=>{guard();current();const row=await this.storage.update(id,{hiddenAt:value?Date.now():null});guard();current();this.emit('terminal:tasks:changed',{sessionId:id});this.emit('local-db:sessions:patched',{sessionId:id,patch:this.guiSession(row)});},
      history: async id=>{const rows=await this.contextMessages(id,Infinity);guard();return rows.map(row=>({...row,agentMeta:row.agentMeta??null}));},
      withTaskLock: (id,run)=>this.routes.withLock(id,run),
      withPermissionLock: (id,run)=>this.permissionChanges.withSessionPermissionChange(id,run),
      assertIdle: async(id,unstarted,current)=>{
        const check=()=>{guard();current();};check();await this.ready;check();
        if(unstarted){
          const row=await this.storage.get(id);check();
          if(!row)throw new PluginTaskError('TASK_NOT_FOUND','Task not found');
          if(row.userSendAt!=null)throw new PluginTaskError('TASK_BUSY','Only an unstarted task can request write access');
          const user=await (await this.database).getDbClient().queryOne<{id:string}>('SELECT id FROM messages WHERE session_id = ? AND role = ? LIMIT 1',[id,'user']);
          check();if(user)throw new PluginTaskError('TASK_BUSY','Only an unstarted task can request write access');
        }
        const pending=await this.storage.queued(id);check();
        if(pending.length||this.isTurnRunning(id)||this.starts.has(id)||this.sending.has(id)||[...this.pending.values()].some(value=>value.sessionId===id))throw new PluginTaskError('TASK_BUSY','Wait for the current turn before changing permission');
      },
      confirmPermission: async(id,input,current,signal)=>{
        const task=await this.ensureLive(id);guard();current();
        // This is an owner setting, not permission to resume a paused turn.
        // It uses the same authenticated pending UI without releasing the queue.
        const result=await this.interaction(id,{kind:'permission',requestId:randomUUID(),toolName:'cindy.plugin.task.writeAccess',title:input.title,description:`${input.message}\n\n${input.detail}`,input:{}},signal,undefined,true);
        guard();current();
        return this.live.get(id)===task&&result.kind==='permission'&&result.behavior==='allow';
      },
      changePermission: async(id,mode,current,persistPreferences)=>{
        guard();current();
        const row=await this.storage.get(id);guard();current();
        if(!row)throw new PluginTaskError('TASK_NOT_FOUND','Task not found');
        const previous=permission(row.permissionMode==='default'?'ask':row.permissionMode??'ask'),live=this.live.get(id)?.maker.getSession(id);
        let touched=false;
        try{
          if(live)await live.setPermissionMode(mode);guard();current();
          touched=true;await this.storage.update(id,{permissionMode:mode});guard();current();
          await persistPreferences();guard();current();
        }catch(error){
          if(live)await live.setPermissionMode(previous).catch(()=>this.options.logger.warn('PLUGIN_PERMISSION_ROLLBACK_FAILED'));
          if(touched)await this.storage.update(id,{permissionMode:previous}).catch(()=>this.options.logger.warn('PLUGIN_PERMISSION_PERSIST_ROLLBACK_FAILED'));
          throw error;
        }
        this.emit('terminal:tasks:changed',{sessionId:id});
        this.emit('local-db:sessions:patched',{sessionId:id,patch:{permissionMode:mode}});
      },
    };
  }
  configurePluginEvents(events: TerminalPluginEvents) {
    this.pluginEvents = events;
    for (const task of this.live.values()) this.bindPluginEvents(task);
  }
  private bindPluginEvents(task: LiveTask) {
    if (!this.pluginEvents || this.pluginEventSessions.has(task.session)) return;
    this.pluginEventSessions.add(task.session);
    const tap = this.pluginEvents.sessions.createGhostSessionTap(task.session.id);
    task.dispose.push(tap.dispose, task.session.onEvent(event => {
      if(this.dataClosed||this.eventRuntime.guards.isFencedStaleSessionTerminal(task.session.id,event))return;
      tap.handleEvent(event);
    }));
    this.installTaskInteractionObserver(task.session,tap.interactionObserver);
    task.dispose.push(() => installInteractionLifecycleObserver(task.session, null));
  }
  configurePlugins(factory:(context:PluginTaskContext)=>Promise<TerminalPluginTask>,setup:TerminalPluginSetup){this.pluginFactory=factory;this.pluginSetup=setup;}
  private readonly pluginPermissions = createPluginSessionPermissions({
    session: id => this.closed ? undefined : this.live.get(id)?.maker.getSession(id),
    workingDir: async id => (await this.storage.get(id))?.workDir ?? null,
  });
  requestHostPermission = this.pluginPermissions.request;
  async beginChannelInteraction(id:string,registration:Parameters<typeof beginInteractionRoute>[1]){
    const task=await this.ensureLive(id);
    return beginInteractionRoute(task.session,registration);
  }
  /** Trusted channel adapters use the same running tasks as GUI/TUI clients.
   * The channel repository must commit the task before attaching its runtime. */
  channelRuntime(): ReturnType<ImTurnHost['getMaker']> {
    return this.channelMaker ??= {
      on: listener => { this.guard({source:'local'}); this.makerObservers.add(listener); return () => { this.makerObservers.delete(listener); }; },
      getSession: id => {
        if (this.closed) return undefined;
        const session = this.live.get(id)?.maker.getSession(id);
        return session?.getStatus() === 'active' ? session : undefined;
      },
      getCapabilities: kind => {
        const capabilities = this.engineCapabilities.get(kind);
        if (!capabilities) throw new Error('TASK_HOST_NOT_READY');
        return capabilities;
      },
      getAgentAuthState: async kind => { await this.ready; this.guard({source:'local'}); return this.authState(kind); },
      createSession: async input => {
        await this.ready; this.guard({source:'local'});
        if (!input.id) throw new Error('CHANNEL_TASK_ID_REQUIRED');
        const row = await this.storage.get(input.id);
        if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND');
        this.guard({source:'local'});
        const hydrated = this.channelHydration.get(input.id);
        this.channelHydration.delete(input.id);
        // The committed task is authoritative. A stale channel attachment may
        // not overwrite a model selection changed by GUI while it was loading.
        if (hydrated && (hydrated.providerId !== undefined && hydrated.providerId !== (row.providerId ?? null)
          || hydrated.effort !== undefined && hydrated.effort !== (row.effort ?? 'high')
          || hydrated.fastMode !== undefined && hydrated.fastMode !== (row.fastMode ?? false))) throw new Error('CHANNEL_TASK_ROUTE_CHANGED');
        if (this.live.get(input.id)?.maker.getSession(input.id)?.getStatus() !== 'active' && input.vendorOptions) this.channelVendorOptions.set(input.id, input.vendorOptions);
        return (await this.ensureLive(input.id)).session;
      },
    };
  }
  private async contextMessages(id: string, limit: number): Promise<Array<import('@cindy/im-runtime/planReconcile').PlanReconcileCandidateRow & { rowid: number }>> {
    const rows = await this.messages(id, { limit }, true);
    return rows.reverse().map(row => {
      let content: unknown = row.content;
      if (typeof row.content === 'string' && (row.role === 'tool_use' || row.role === 'agent_switch')) { try { content = JSON.parse(row.content); } catch { /* historical plain text */ } }
      return { clientId: row.clientId, rowid: row.rowid!, role: row.role, content, createdAt: Date.parse(row.createdAt), agentMeta: row.agentMeta ? {...row.agentMeta} : null };
    });
  }
  private async replayRecoveredTask(...[id, content, wireContent, recovery]: Parameters<ContextOverflowRolloverDeps['replayUserMessage']>): Promise<{ accepted: boolean }> {
    this.guard({ source: 'local', signal: recovery?.signal });
    const row = await this.storage.get(id);
    if (!row || row.deleted || row.archived || this.channelBindings.store.findByTarget(id) || this.pluginSetup?.surface.isHeadlessGhostSetupTurn(id)) return { accepted: false };
    const projection = createAutoReviewIntentProjection();
    const history = await this.contextMessages(id, Infinity);
    const source = recovery?.continueFromHistory ? recovery.sourceUserContent : content;
    const wire = persistedUserContentToWireMessage(wireContent ?? content);
    const outgoing = await this.taskContext.prepareHandoff(id, typeof wire === 'string' ? { type: 'user', content: wire } : wire as UserMessage);
    const task = await this.ensureLive(id);
    const result = await task.session.send(outgoing.message, {
      signal: recovery?.signal,
      [AUTO_REVIEW_SOURCE_CONTENT]: projection.readText(source) ?? '',
      [AUTO_REVIEW_USER_INTENT]: projection.restore(history.map(message => ({ ...message, agentMeta: message.agentMeta ?? null }))),
      ...(recovery?.continueFromHistory ? { [INHERITED_CAPABILITY_SELECTION]: recovery.sourceCapabilitySelectionText,
        [PI_CACHE_RECOVERY_EXPECTATION]: recovery.piCacheCompatibility, ...(recovery.piCacheCompatibility ? { retryUserClientId: recovery.sourceUserClientId } : {}) } : {}),
      onAccepted: () => { this.guard({ source: 'local', signal: recovery?.signal }); this.turnLifecycle.noteUserSend(id); },
    });
    if (result.accepted) outgoing.accepted();
    return { accepted: result.accepted };
  }
  channelTurnHost(): ImTurnHost {
    const guard = () => this.guard({ source: 'local' });
    const hydrate = (id: string, patch: NonNullable<ReturnType<typeof this.channelHydration.get>>) => {
      guard(); this.channelHydration.set(id, { ...this.channelHydration.get(id), ...patch });
    };
    const update = async (id: string, patch: Partial<TerminalTaskMeta>) => {
      guard();
      const row = await this.storage.updateIf(id, current => !current.deleted, patch, guard);
      guard();
      if (!row) throw new Error('TASK_NOT_FOUND');
      this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(row) });
    };
    return this.channelHost ??= {
      getMaker: () => this.channelRuntime(),
      createLogger: scope => this.options.logger.child(scope),
      readSession: async id => {
        await this.ready; guard();
        const row = await this.storage.get(id); guard();
        return row ? { id: row.id, agentKind: row.agentKind, workingDir: row.workDir, title: row.title, status: row.deleted ? 'deleted' : row.archived ? 'archived' : 'active', orcaRole: row.orcaRole ?? null,
          model: row.model, providerId: row.providerId ?? null, agentDeviceId: row.agentDeviceId ?? null, remoteHostId: row.remoteHostId ?? null,
          sdkSessionId: row.sdkSessionId ?? null, effort: row.effort ?? 'high', fastMode: row.fastMode ?? false,
          permissionMode: permission(row.permissionMode === 'default' ? 'ask' : row.permissionMode ?? 'ask'), workspaceKind: row.workspaceKind ?? 'project' } : null;
      },
      persistSdkSessionId: (id, value) => update(id, { sdkSessionId: value }),
      listProviders: () => this.models.views(),
      readImRemoteProviderRoute: route => readRemoteProviderRoute(route, async (device, channel, args) => {
        guard(); if (!this.options.remoteInvoke) throw new Error('REMOTE_TRANSPORT_UNAVAILABLE');
        const result = await this.options.remoteInvoke(device, channel, args); guard(); return result;
      }),
      readXdGatewayApiKey: async () => { guard(); const key = await this.models.credential('xd', 'claude-code'); guard(); return key; },
      hasCustomProviderKey: async (provider, kind) => { guard(); const key = await this.models.credential(provider, kind); guard(); return Boolean(key); },
      isCredentialModeSwitchBusyError,
      hydrateSessionProvider: (id, providerId) => hydrate(id, { providerId }),
      setSessionEffort: (id, effort) => hydrate(id, { effort }),
      setSessionFastMode: (id, fastMode) => hydrate(id, { fastMode }),
      wireSessionToIpcExternal: session => { guard(); if (this.live.get(session.id)?.maker.getSession(session.id) !== session) throw new Error('TASK_RUNTIME_REPLACED'); },
      repoTouchUserSent: id => update(id, { userSendAt: Date.now() }),
      readPermissionMode: async id => { guard(); const row = await this.storage.get(id); guard(); return row && !row.deleted ? permission(row.permissionMode === 'default' ? 'ask' : row.permissionMode ?? 'ask') : null; },
      updatePermissionMode: (id, mode) => update(id, { permissionMode: mode }),
      bindingStore: this.channelBindings.store,
      persistUserMessage: args => this.persistChannelMessage(args),
      adoptStagedInboundFiles: (...args) => this.channelFiles.adoptStagedInboundFiles(...args),
      beginTurnChangeSetAtDispatch: (session, anchor) => this.changes.begin(session, anchor),
      clearPendingTurnChangeSets: id => this.changes.store.clearPendingTurnChangeSets(id),
      takePendingInteractionsForSession: id => this.takeChannelInteractions(id),
      noteSilentStopUserSend: id => this.turnLifecycle.noteUserSend(id),
      stopSessionTurnExplicitly: async id => { guard(); const session = this.live.get(id)?.maker.getSession(id); if (session) await this.stopTaskTurn(session); },
      onSilentStopSettled: (id, callback) => this.turnLifecycle.onSettled(id, callback),
      agentHandoffPending: this.taskContext.handoff,
      enqueueDurableWrite: (label, write) => this.taskContext.enqueue(label, write),
      listMessagesForAgentHandoff: (id, limit) => this.contextMessages(id, limit),
      peekGoalInactiveNote: id => this.taskContext.peekGoalInactiveNote(id),
      isSilencedSchedulerTurn: origin => origin?.kind === 'scheduler' && Boolean(origin.runId) && this.schedulerDeps?.getScheduler().isRunSilenced(origin.runId!) === true,
      beginHeadlessGhostSetupTurn: id => {
        guard(); return (this.pluginSetup?.surface ?? this.channelPluginSurface).beginHeadlessGhostSetupTurn(id);
      },
      bindRuntimeRecoveryNotice: (...args) => this.channelRecovery.bindRuntimeRecoveryNotice(...args),
      redactToolInputForUntrustedBoundary,
      generateAndPersistFbotTitle: async (id, text, prefix) => {
        const generated = await this.generateTaskTitle({ sessionId: id, message: text });
        if (!generated) return null;
        const title = fbotTitle(generated, prefix); await update(id, { title }); return title;
      },
      generateImSessionTitleText: (id, text) => this.generateTaskTitle({ sessionId: id, message: text }),
      persistGeneratedSessionTitle: (id, title) => update(id, { title }),
      resolveSessionErrorContext: async id => {
        guard(); const row = await this.storage.get(id); if (!row || row.deleted) return {};
        const providers = row.agentDeviceId && this.options.remoteInvoke ? await readDeviceProviderViews(this.options.remoteInvoke, row.agentDeviceId) : await this.models.views();
        guard(); const provider = providers.find(provider => provider.id === row.providerId);
        return { taskLabel: row.title, providerLabel: provider?.name, modelLabel: provider?.models[row.agentKind]?.find(model => model.id === row.model)?.name ?? row.model };
      },
      resolveCindyMediaUrl: url => this.media.resolveMediaUrl(url),
      resolveXdtImageUrl: url => this.media.resolveLegacyImageUrl(url),
      materializeLocalMarkdownImages: args => this.materializeChannelImages(args),
      changeSessionPermissionMode: args => this.changeChannelPermission(args),
    };
  }
  channelTurnDependencies(channel?: TerminalChannelRouteConfig): import('@cindy/im-runtime/turnRunner').ImTurnRunnerDeps {
    const follower = channel && createTerminalChannelRouteFollower(channel, {
      storage: this.storage, routes: this.routes, defaults: this.channelSessionDefaults,
      listProviders: () => this.models.views(), assertCurrent: () => this.guard({ source: 'local' }), logger: this.options.logger,
    });
    return { acquirePendingAgentSwitch: (id, options) => this.routes.acquireForSend(id, options?.channelOwned && follower ? () => follower.syncUnderLock(id) : undefined),
      ...(follower ? { channelDefaultRoute: follower } : {}),
      prepareUnhealthySession: async id => { await this.routes.withLock(id, () => this.routes.recovery.runtime.prepareUnhealthySession(id)); },
    };
  }
  channelCardHost(): ImCardHost {
    const guard = () => this.guard({ source: 'local' });
    const update = async (id: string, patch: Partial<TerminalTaskMeta>) => {
      guard();
      const row = await this.storage.updateIf(id, current => !current.deleted && !current.archived, patch, guard);
      if (!row) throw new Error('TASK_NOT_FOUND');
      this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(row) });
    };
    const turns = this.channelTurnHost();
    return this.channelCards ??= {
      ...this.channelControl.commands, ...this.channelControl.account,
      createLogger: scope => this.options.logger.child(scope),
      bindingStore: this.channelBindings.store,
      getMaker: () => ({
        getSessionMeta: async id => { guard(); return this.storage.get(id); },
        getCapabilities: kind => this.channelRuntime().getCapabilities(kind),
        createSession: async input => {
          guard();
          const id = input.id && await this.storage.get(input.id) ? input.id : (await this.create({ ...input }, guard)).id;
          return (await this.ensureLive(id)).session;
        },
        closeSession: async id => { guard(); await this.closeTask(id); },
      }),
      normalizeSessionProviderId: value => value === undefined ? undefined : value?.trim() || null,
      setSessionProvider: (id, provider) => this.routes.hydrateProvider(id, provider),
      withSendToSessionLock: (id, action) => this.routes.withLock(id, action),
      selectModelUnderLock: async (id, model, provider, effort) => {
        const row = await this.storage.get(id);
        guard();
        await this.routes.selectModelUnderLock(id, model, provider, {
          effort, fastMode: this.live.get(id)?.session.getFastMode() ?? row?.fastMode ?? false,
        }, undefined, guard);
        await this.routes.deps.onUserRouteSelectionLanded?.(id);
      },
      cancelPendingAgentSwitchForSession: id => this.routes.cancel(id),
      getTaskDefaults: () => {
        guard(); const selection = this.models.snapshot().defaultSelection;
        return selection?.agentKind === 'claude-code' ? { ...selection, effort: selection.effort ?? 'high', permissionMode: 'ask', fastMode: false } : null;
      },
      resolveNewTaskDefaultModelRoute: async kind => {
        await this.ready; guard();
        const saved = this.models.snapshot().defaultSelection;
        try { const route = await this.selection(saved?.agentKind === kind ? { ...saved } : { agentKind: kind }); guard(); return route.selection; }
        catch { guard(); return null; }
      },
      resolveLenientSessionRoute: async (kind, model, providerId, options) => {
        guard(); const views = await this.models.views(); guard();
        const route: Awaited<ReturnType<ImCardHost['resolveLenientSessionRoute']>> = resolveLenientRoute(views, kind, model, providerId, options);
        if (options.desiredFastMode && route.model && (route.model !== model || route.providerId !== providerId)) {
          const provider = route.providerId ? views.find(row => row.id === route.providerId) : sourcesForModel(views, route.model, kind)[0];
          route.fastMode = provider && modelSupportsFastMode(provider, route.model, kind)
            && (options.desiredFastMode !== 'ultrafast' || kind === 'codex' && provider.models.codex?.some(row => row.id === route.model && row.supportsUltrafastMode)) ? options.desiredFastMode : false;
        }
        return route;
      },
      listSessionsForWorkspace: this.channelControl.projects.listSessionsForWorkspace,
      exitControl: (...args) => { guard(); this.channelControl.state.exitControl(...args); },
      generateTakeoverSummary: async id => {
        guard(); const text = await (await this.conversations).latest.latestNonEmptyMessageText(id, 'assistant'); guard();
        return text || null;
      },
      broadcastSessionCreated: id => { guard(); this.emit('local-db:sessions:created', { sessionId: id }); },
      readImDefaultSettings: channel => this.channelDefaults.read(channel),
      readModelRouteSnapshot: async id => {
        guard(); const row = await this.storage.get(id); guard();
        return row ? { model: row.model, providerId: row.providerId ?? null, agentDeviceId: row.agentDeviceId ?? null, effort: row.effort ?? 'high' } : null;
      },
      switchSessionWorkingDir: (id, directory, workspaceKind) => this.routes.withLock(id, async () => {
        guard();
        if (!path.isAbsolute(directory) || !(await stat(directory)).isDirectory()) throw new Error('WORKING_DIRECTORY_NOT_FOUND');
        await this.closeTask(id);
        await this.clearSessionContext(id);
        await update(id, { workDir: directory, workspaceKind });
        this.emit('local-db:sessions:created', { sessionId: id });
      }),
      touchUserSent: id => turns.repoTouchUserSent(id),
      updateModelEffort: async (id, model, effort, provider) => {
        guard(); const row = await this.storage.get(id); if (!row) throw new Error('TASK_NOT_FOUND');
        const resolved = await this.selection({ ...row, model, effort, providerId: provider === undefined ? row.providerId : provider });
        await update(id, resolved.selection);
      },
      markImSessionManualRouteOverride: async id => { await this.routes.deps.onUserRouteSelectionLanded?.(id); },
      readImRemoteProviderRoute: turns.readImRemoteProviderRoute,
      readPermissionMode: turns.readPermissionMode, updatePermissionMode: turns.updatePermissionMode,
      changeSessionPermissionMode: turns.changeSessionPermissionMode,
      lookupPending, resolvePending,
    };
  }
  resetChannelTask: ImCommandHost['resetImSessionToChannelDefaults'] = async (id, config, prepared, channel) => {
    await this.ready;
    const guard = () => this.guard({ source: 'local' });
    await this.routes.withLock(id, async () => {
      const row = await this.storage.get(id);
      if (!row || row.deleted || row.archived) throw new Error('TASK_NOT_FOUND');
      const defaults = prepared ?? await this.channelSessionDefaults.resolveImSessionDefaults(config, undefined, channel);
      const directory = channel === 'wechat' && prepared?.workingDir ? prepared.workingDir : row.workDir;
      const { input, resolved, cwd } = await this.admitTask({ ...defaults, workingDir: directory }, id, guard);
      await this.closeTask(id);
      guard();
      await this.clearSessionContext(id);
      guard();
      const fingerprint = prepared?.defaultRouteFingerprint ?? ('fingerprint' in defaults ? defaults.fingerprint : this.channelSessionDefaults.readImDefaultSettingsFingerprint(channel));
      const patch: Partial<TerminalTaskMeta> = {
        ...resolved.selection, workDir: cwd, permissionMode: permission(defaults.permissionMode), fastMode: defaults.fastMode,
        agentDeviceId: input.agentDeviceId ? string(input.agentDeviceId) : undefined,
        groupBinding: input.groupBinding as TerminalTaskMeta['groupBinding'],
        ...(row.usage ? { usage: { ...row.usage, contextTokens: 0, contextWindow: resolved.route.model.contextWindow ?? 0 } } : {}),
        imDefaultRoute: buildImDefaultRouteRecord(fingerprint, { ...resolved.selection, agentDeviceId: input.agentDeviceId ? string(input.agentDeviceId) : null, effort: resolved.selection.effort ?? null }),
      };
      const updated = await this.storage.updateIf(id, current => !current.deleted && !current.archived, patch, guard);
      if (!updated) throw new Error('TASK_NOT_FOUND');
      this.routes.cancel(id);
      this.channelHydration.delete(id);
      if (updated.groupBinding) this.groupBindings.set(id, updated.groupBinding); else this.groupBindings.delete(id);
      this.emit('local-db:sessions:patched', { sessionId: id, patch: this.guiSession(updated) });
    });
  };
  async persistChannelMessage(args: Parameters<ImTurnHost['persistUserMessage']>[0]): ReturnType<ImTurnHost['persistUserMessage']> {
    await this.ready;
    const guard = () => this.guard({ source: 'local' });
    guard();
    const conversations = await this.conversations;
    const service = createImMessagePersistence({
      ...conversations.messages,
      enqueueDurableWrite: conversations.persistence.enqueueDurableWrite,
      logger: this.options.logger,
      createMessage: async (id, body) => { guard(); return this.storage.writeUserMessage(id, body); },
    });
    return service.persistUserMessage(args);
  }
  async materializeChannelImages(args: Parameters<ImTurnHost['materializeLocalMarkdownImages']>[0]): ReturnType<ImTurnHost['materializeLocalMarkdownImages']> {
    await this.ready;
    const guard = () => this.guard({ source: 'local' });
    guard();
    const row = await this.storage.get(args.sessionId);
    if (!row || row.deleted) throw new Error('TASK_NOT_FOUND');
    const assertTaskCurrent = async () => {
      guard();
      const current = await this.storage.get(row.id);
      if (!current || current.deleted || current.workDir !== row.workDir || current.clearedAt !== row.clearedAt || current.sdkSessionId !== row.sdkSessionId || current.agentKind !== row.agentKind) throw new Error('TASK_IMAGE_SCOPE_CHANGED');
      guard();
    };
    const scope = { id: row.id, workingDir: row.workDir, sdkSessionId: row.sdkSessionId ?? null, agentKind: row.agentKind === 'claude-code' ? 'cc' : row.agentKind, remoteHostId: row.remoteHostId ?? null, status: row.archived ? 'archived' : 'active', clearedAt: row.clearedAt ?? null };
    const result = await this.media.channelImages({ ...args, workingDir: row.workDir }, (id, text) => {
      if (id !== row.id) throw new Error('TASK_SCOPE_MISMATCH');
      return this.media.materializeTaskImages(scope, text, guard, assertTaskCurrent);
    });
    await assertTaskCurrent();
    return result;
  }
  changeChannelPermission(args: Parameters<ImTurnHost['changeSessionPermissionMode']>[0]) {
    return changeSessionPermissionMode(args, {
      captureAccount: () => ({ assertCurrent: () => this.guard({ source: 'local' }), isCurrent: () => !this.closed }),
      withSessionPermissionChange: (id, operation) => this.permissionChanges.withSessionPermissionChange(id, operation),
    });
  }
  private async nativeUtilityText(kind: AgentKind, prompt: string, opts: Parameters<UtilityNativeAgents['oneShot']>[2]) {
    await this.ready; this.guard({ source: 'local' });
    if (!agentSupportsOneShot(kind)) throw new Error('UTILITY_NATIVE_ROUTE_UNAVAILABLE');
    const id = `utility-${randomUUID()}`;
    const chosen = await this.models.select({ agentKind: kind, providerId: kind === 'codex' ? 'openai' : 'anthropic', model: opts?.model });
    const revision = this.models.revision();
    const current = async () => !this.closed && revision === this.models.revision() && !this.models.isMutating() && (!opts?.beforeDispatch || await opts.beforeDispatch());
    const binary = this.binaries.get(kind);
    if (!binary || !await current()) throw new Error('UTILITY_NATIVE_ROUTE_UNAVAILABLE');
    const agent = await (this.options.createAgent ?? createTerminalAgent)({ piRuntimeOwner: this.piRuntimeOwner, profileDir: this.options.profileDir, taskId: id, ...chosen, binaryPath: binary, models: this.models, logger: this.options.logger });
    try {
      if (!await current()) throw new Error('UTILITY_ROUTE_CHANGED');
      return await agent.oneShot(prompt, { ...opts, beforeDispatch: current });
    } finally {
      await agent.dispose();
      await rm(path.join(this.options.profileDir, 'engines', 'codex', id), { recursive: true, force: true });
    }
  }
  private permissionReviewer(guard:()=>void,prepare:(request:AutoReviewRequest)=>Promise<AutoReviewRequest>,signal?:AbortSignal|(()=>AbortSignal)):AutoReviewDelegate {
    const review:AutoReviewDelegate=request=>this.utility.reviewPermission(request,guard,typeof signal==='function'?signal():signal);
    review.prepareRequest=async request=>{
      guard();const prepared=await prepare(request);guard();return prepared;
    };
    return review;
  }
  requestChannelUtilityText(_channel: import('@cindy/im-runtime/imDefaultSettings').ImDefaultSettingsChannel, prompt: string, opts: import('@cindy/model-providers/utilityTextRequest').UtilityTextRequestOptions) {
    return this.utility.request(prompt, opts);
  }

  generateTaskTitle(input: { message: string; sessionId?: string; agentKind?: AgentKind }): Promise<string | null> {
    if (this.pluginEvents?.sessions.hasEnabledUserMessageHookGhost()) return Promise.resolve(null);
    const operation = this.runTaskTitle(input);
    this.utilityWork.add(operation);
    void operation.finally(() => this.utilityWork.delete(operation)).catch(() => {});
    return operation;
  }
  private async runTaskTitle(input: { message: string; sessionId?: string; agentKind?: AgentKind }): Promise<string | null> {
    try {
      await this.ready; this.guard({ source: 'local' });
      if (!input.message.trim()) return null;
      const row = input.sessionId ? await this.storage.get(input.sessionId) : null;
      if (input.sessionId && (!row || row.deleted)) return null;
      const revision = this.models.revision();
      const current = async () => {
        if (this.closed || revision !== this.models.revision()) return false;
        if (!row) return true;
        const latest = await this.storage.get(row.id);
        return !this.closed && Boolean(latest && !latest.deleted && latest.agentKind === row.agentKind && latest.providerId === row.providerId && latest.model === row.model && latest.agentDeviceId === row.agentDeviceId && latest.clearedAt === row.clearedAt);
      };
      if (row?.agentDeviceId) {
        if (!this.options.remoteInvoke) return null;
        const response = await this.options.remoteInvoke(row.agentDeviceId, 'maker:generate-title', [{ message: input.message.slice(0, 200), agentKind: row.agentKind }]);
        return response.ok && await current() ? validateTitleOutput((response.result as { title?: string } | undefined)?.title, AUTO_TITLE_MAX_CHARS) : null;
      }
      const output = await this.utility.request(buildAutoTitlePrompt(input.message.trim().slice(0, 200), this.options.language?.() ?? 'en'), {
        maxTokens: AUTO_TITLE_MAX_CHARS * 4, timeoutMs: 12_000,
        signal: this.utilityAbort.signal, beforeDispatch: current,
        validateResponse: value => Boolean(validateTitleOutput(value, 256)),
        responseInstructions: 'Output only the short conversation title requested by the user message, without quotation marks or ending punctuation.',
      });
      if (!output.ok) return null;
      if (!await current()) return null;
      const title = validateTitleOutput(output.text, 256);
      return title ? Array.from(title).slice(0, AUTO_TITLE_MAX_CHARS).join('') : null;
    } catch { return null; }
  }
  configureKnowledge(knowledge?: Pick<TerminalKnowledge, 'createRuntime' | 'snapshot' | 'sshProvider' | 'memory' | 'providerCatalog'>) { this.knowledge = knowledge; }
  configureChannelTools(factory: NonNullable<TerminalTaskHost['channelTools']>) { this.channelTools = factory; }
  pluginPermissionSnapshot = (id: string, instance?: string) => this.pluginPermissions.snapshot(id, instance);
  requestPluginWrite = (id: string, payload: import('@cindy/plugin-runtime/grantTypes').GhostGrantConfirmPayload, signal?: AbortSignal) => this.pluginPermissions.confirm(id, payload, signal);
  async createSchedulerPromptRunner(notifier: import('@cindy/maker-scheduler').Notifier) {
    await this.ready;
    const guard = () => this.guard({ source: 'local' });
    guard();
    const conversations = await this.conversations, database = await this.database;
    const maker: ScheduleMaker = {
      ...this.channelRuntime(),
      isSessionAlive: id => !!this.channelRuntime().getSession(id),
      listActiveSessions: () => [...this.live.values()].flatMap(task => task.maker.listActiveSessions()),
      getSessionMeta: id => this.storage.get(id),
      closeSession: async (id, reason) => {
        guard();
        if (reason === 'runtime-refresh') await this.withRehydrateCloseSuppressed(id, () => this.closeTask(id));
        else await this.closeTask(id);
      },
      createSession: async input => {
        guard();
        const id = input.id ?? randomUUID(), existing = await this.storage.get(id);
        guard();
        if (input.vendorOptions) this.channelVendorOptions.set(id, input.vendorOptions);
        if (!existing) await this.create({ ...input, id }, guard);
        else if (!this.channelRuntime().getSession(id)) {
          if (existing.deleted || existing.archived) throw new Error('TASK_NOT_FOUND');
          const chosen = await this.selection({ ...existing, ...input, agentKind: input.agentKind ?? existing.agentKind });
          guard();
          await this.storage.update(id, { ...chosen.selection, permissionMode: input.permissionMode ?? existing.permissionMode,
            planMode: input.planMode ?? existing.planMode, fastMode: input.fastMode ?? existing.fastMode });
          await this.ensureLive(id, chosen);
        }
        guard(); return this.channelRuntime().getSession(id)!;
      },
    };
    const identity = createCodexProviderIdentity({
      appliedRoutes: () => [...this.codexProviderRoutes.values()].flatMap(entry => entry.routes),
      allAppliedRoutes: () => [...this.codexProviderRoutes.values()].flatMap(entry => entry.routes),
    });
    const credentials = createCredentialModeSwitch({
      ...identity, getActiveCatalog: () => this.models.activeCatalog(),
      hasClaudeNativeLogin: () => !!this.models.nativeClaude?.usageAccount(),
      withRehydrateCloseSuppressed: (id, action) => this.withRehydrateCloseSuppressed(id, action),
    });
    const turn = this.channelTurnHost();
    const restoreScheduledTarget = createScheduledTargetRestore({
      ...conversations.snapshot,
      restoreArchivedSessionForSend: (id, options) => this.restoreArchivedSessionForSend(id, options),
      withSessionRouteLock: (id, action) => this.routes.withLock(id, action),
      getManagedWorktreeReadinessForSession: (id, directory) => {
        if (!this.worktrees) throw new Error('WORKTREE_HOST_UNAVAILABLE');
        return this.worktrees.restore.getManagedWorktreeReadinessForSession(id, directory);
      },
    });
    this.scheduledModels ??= createTerminalScheduledModels({ tasks: this, database, guard, control: this.runtimeControl, remoteInvoke: this.options.remoteInvoke });
    this.routes.restoreScheduledPreferences = this.scheduledModels.restore;
    this.routes.clearScheduledPreference = id => this.scheduledModels!.updateScheduledPreference(id, null);
    const projectScheduled = createScheduledModelProjection(this.runtimeControl.projectSessionRuntimeControl);
    conversations.rowMapper.setSessionRuntimeProjector(row => {
      const baseline = parseScheduledModelBaseline(row.scheduledModelBaseline);
      return baseline ? projectScheduled(row.id, baseline) : this.runtimeControl.projectSessionRuntimeControl(row.id, {
        agentKind: dbToMakerAgentKind(row.agentKind), model: row.model, providerId: row.providerId?.trim() || null,
        effort: row.effort as import('@cindy/maker-core').Effort, fastMode: row.fastMode,
      });
    });
    const { MakerScheduleRunner } = createMakerScheduleRunner({
      ...conversations.messages, ...conversations.snapshot, ...conversations.activity, ...conversations.broadcastTap,
      ...this.eventRuntime.scheduledOutput, ...credentials, ...identity, ...this.dialogueWorkspace,
      // Node owns one proxy/credential snapshot per native process. A provider
      // change must rebuild that process before the shared runner dispatches.
      shouldCloseSessionForCredentialSwitch: input => credentials.shouldCloseSessionForCredentialSwitch(input)
        || (!input.remoteHostId && input.agentKind !== 'pi' && input.currentProviderId !== input.nextProviderId),
      restoreScheduledTarget,
      shouldApplyExclusiveProviderRerouteLive: provider => shouldApplyExclusiveProviderReroute(provider, this.models.providerSources()),
      getSessionProvider: id => this.routes.provider(id),
      setSessionProvider: (id, provider) => { guard(); this.routes.hydrateProvider(id, provider); },
      hydrateSessionProvider: (id, provider) => { if (this.routes.provider(id) === null) this.routes.hydrateProvider(id, provider ?? null); },
      setSessionEffort: this.runtimeAxes.setSessionEffort,
      setSessionFastMode: (id, fast) => this.runtimeAxes.setSessionFastMode(id, fast ?? false),
      wireSessionToIpc: turn.wireSessionToIpcExternal,
      isSessionInTurn: id => this.isTurnRunning(id),
      noteSilentStopUserSend: id => this.turnLifecycle.noteUserSend(id),
      onSilentStopSettled: (id, listener) => this.turnLifecycle.onSettled(id, listener),
      agentHandoffPending: this.taskContext.handoff,
      beginHeadlessGhostSetupTurn: turn.beginHeadlessGhostSetupTurn,
      resolveWorkingDir: (schedule, id) => {
        if (!this.worktrees) throw new Error('WORKTREE_HOST_UNAVAILABLE');
        return createScheduledWorkdirResolver({ WorktreeManager: this.worktrees.manager, WorktreePool: this.worktrees.pool,
          resolveFreshSourceBranch: this.worktrees.freshBase.resolveFreshSourceBranch })(schedule, id);
      },
      WorktreePool: { releaseWorktree: async id => { if (this.worktrees) await this.worktrees.pool.releaseWorktree(id); } },
    });
    const buildInput = createSessionControlInputBuilder({ buildCreateOptsForQueuedSession: async (id, _meta, inheritPlan) => {
      const row = await this.storage.get(id); guard(); if (!row) throw new Error('TASK_NOT_FOUND');
      return { agentKind: row.agentKind, model: row.model, providerId: row.providerId, workingDir: row.workDir,
        remoteHostId: row.remoteHostId, agentDeviceId: row.agentDeviceId, effort: row.effort, fastMode: row.fastMode,
        permissionMode: row.permissionMode, planMode: inheritPlan ? row.planMode : false, orcaRole: row.orcaRole };
    } });
    const queue = createSchedulerQueueBridge({ maker, inputCoordinator: this.inputCoordinator,
      ...conversations.snapshot, createId: randomUUID,
      isDispatchBoundaryBusy: (id, session) => isSessionTurnDispatchBoundaryBusy(this.eventRuntime.activity, id, session),
      schedulerQueuedPromptDiscardWatchers: this.schedulerDiscardWatchers, schedulerQueuedPromptPreparations: this.schedulerPreparations,
      enqueueSendToSessionMessage: async params => {
        const queued = await buildInput(params); guard();
        this.orcaDispatcher.registerQueuedOrcaInterAgentAcceptedCallback(params.clientId,
          () => params.onAccepted({ permissionMode: queued.createOpts.permissionMode, planMode: queued.createOpts.planMode }), params.onAcceptedRollback);
        this.inputContexts.set(params.targetSessionId + ':' + params.clientId, { source: 'local', scheduler: params.origin });
        this.inputCoordinator.enqueue(params.targetSessionId, queued);
        await database.inputQueue.awaitAgentInputQueueSnapshotPersistence(params.targetSessionId);
      },
    });
    return new MakerScheduleRunner({ maker, getDb: () => { guard(); return database.getDbClient().drizzle; }, notifier, logger: this.options.logger,
      readAutoReviewHistory: async id => { await conversations.persistence.drainPersistQueue(); return conversations.messages.listMessagesForAgentHandoff(id, null, undefined, 'authorization'); },
      beforeDispatchUserTurn: id => this.gitSnapshots.coordinator.onTurnStart(id),
      onUndispatchedUserTurn: id => { this.gitSnapshots.coordinator.onTurnAbort(id); this.changes.store.clearPendingTurnChangeSets(id); },
      findUsageLimitWait: this.usageWaits.findSchedulerUsageLimitWait,
      acquirePendingAgentSwitch: this.scheduledModels.acquire, prepareModelPreferences: this.scheduledModels.prepare,
      resolveModelSelection: this.scheduledModels.resolve, applyPiModelSelectionUnderLock: this.scheduledModels.applyPi,
      onSessionCreated: id => this.emit('local-db:sessions:created', { sessionId: id }),
      schedulerQueue: { ...queue, isAutoResumePending: this.schedulerRecovery.isSchedulerAutoResumePending,
        getLastUserActionAt: id => this.inputCoordinator.getLastUserActionAt(id),
        onAutoResumeFailed: this.schedulerRecovery.onSchedulerAutoResumeFailed, cancelAutoResume: this.schedulerRecovery.cancelSchedulerAutoResume },
      isAgentOnOtherDevice: async id => { const row = await this.storage.get(id); guard(); return !!row?.agentDeviceId && !row.remoteHostId; },
      checkModelRoute: (kind, model, provider) => this.models.verdict(kind, model, provider),
      resolveRouteCopyCapabilities: async (kind, provider, id) => {
        const model = (await this.models.views()).find(item => item.id === provider)?.models[kind]?.find(item => item.id === id);
        guard(); return model ? { efforts: model.efforts, defaultEffort: model.defaultEffort, supportsFastMode: model.supportsFastMode === true,
          supportsUltrafastMode: model.supportsUltrafastMode } : null;
      },
      resolveDefaultModelRoute: async (kind, provider, model) => {
        const chosen = await this.models.select({ agentKind: kind, ...(provider ? { providerId: provider } : {}), ...(model ? { model } : {}) });
        guard(); return { model: chosen.selection.model, providerId: chosen.selection.providerId, catalogKnown: true };
      },
    });
  }

  private readonly botWelcomeReceipts=createQueuedDispatchReceipts();
  private botSessionInput?: (input:BotSessionMessage)=>ReturnType<BotDirectMessageServiceDeps['dispatch']>;
  private todoDelivery?:ReturnType<typeof createBotTodoDelivery>;
  botRuntimeEpochRefresh?:TerminalBotServicesHost['requestBotRuntimeEpochRefresh'];
  private botInputProjectionListener?: (value:unknown)=>void;
  mayServeBackgroundRead(version:string|null){return this.usageApi.mayServeBackgroundRead(version);}
  configureBotInputProjection(listener:(value:unknown)=>void){this.botInputProjectionListener=listener;}
  registerCompanionIpc(channel:string,handler:(context:TaskInvocationContext,...args:any[])=>unknown){this.botHandlers.set(channel,handler);}
  companionPendingInteractions(id:string){return [...this.taskActionConfirm.pendingSnapshots(id),...(this.pluginSetup?.bridge.pendingSnapshots(id)??[]),...(this.options.protectedInput?.handoff.pendingSnapshots(id)??[]),...[...this.pending.values()].filter(p=>p.sessionId===id&&!p.migrated).map(p=>({request:p.request}))];}
  async connectBotTodoDelivery(todo:ReturnType<typeof createBotTodoAccess>) {
    const database=await this.database;
    this.todoDelivery=createBotTodoDelivery({...todo,...database.inputQueue,
      getCurrentDbClientSnapshot:database.getCurrentDbClientSnapshot,isAppSessionBoundaryPending:()=>this.closed,
      inputCoordinator:this.inputCoordinator,log:this.options.logger,
      send:async({sessionId,message,displayText,requestId,assertCurrent})=>{
        assertCurrent();if(!this.botSessionInput)throw new Error('BOT_SERVICES_NOT_READY');
        const result=await this.botSessionInput({targetSessionId:sessionId,message,persistedContent:displayText,
          clientId:requestId,onAccepted:assertCurrent,autoReviewUserText:{kind:'delegated-continuation'}});
        if(result.ok&&result.wakeKind==='queued')await database.inputQueue.awaitAgentInputQueueSnapshotPersistence(sessionId);
        assertCurrent();return {ok:result.ok,queued:result.ok&&result.wakeKind==='queued',...(!result.ok?{error:result.message}:{})};
      },
    });
  }
  private botDispatch?: (input:BotSessionMessage)=>ReturnType<BotDirectMessageServiceDeps['dispatch']>;
  async connectOriginalGroupServices(input: {
    resources: import('@cindy/device-link').RemoteResourceRegistry;
    companionCloud?: BotGroupChatServiceDeps['companionCloud'];
    withChatServer?: (local: BotGroupChatService, deps: BotGroupChatServiceDeps,
      readPersistedReplyText: ReturnType<typeof createBotGroupChatRuntime>['readPersistedReplyText']) => BotGroupChatService;
    trashItem(fullPath: string): Promise<void>;
    onStepSettled?: BotGroupChatServiceDeps['onStepSettled'];
    notifications?: BotGroupStepNotificationDelivery;
  }) {
    if (!this.bots || !this.worktrees) throw new Error('BOT_SERVICES_NOT_READY');
    const database=await this.database, conversations=await this.conversations, media=await this.media.persisted();
    const guard=()=>this.guard({source:'local'});
    const getDbClient=()=>{guard();return database.getDbClient();};
    const original=createBotGroupChatRuntime({getDbClient});
    const remote=createBotGroupRemoteResources({getDbClient,remoteResourceRegistry:input.resources,...conversations.broadcastTap});
    const attachments=createBotGroupAttachmentRuntime({
      ...media,getDbClient,parseRemoteAttachmentRef,
      materializeRemoteAttachment:(...args)=>{
        guard();if(!this.options.remoteAttachments)throw new Error('ATTACHMENT_TRANSFER_UNAVAILABLE');
        return this.options.remoteAttachments.materializeRemoteAttachment(...args);
      },
      removeRemote:key=>{
        guard();if(!this.options.remoteAttachments)throw new Error('ATTACHMENT_TRANSFER_UNAVAILABLE');
        return this.options.remoteAttachments.removeRemote(key);
      },
    }).createBotGroupAttachmentStore({ownerRoot:()=>this.options.profileDir,log:this.options.logger});
    const worktrees=this.worktrees;
    const workDir=createBotGroupWorkDir({
      ownerRoot:()=>this.options.profileDir,
      detectRepo:async dir=>{const result=await worktrees.manager.detectCwd(dir);return {gitInstalled:result.gitInstalled,isGitRepo:result.isGitRepo};},
      prepareWorktree:async projectDir=>{
        const manager=worktrees.manager;
        const result=await prepareHandoffWorktree({getForSession:manager.getForSession,listAll:manager.listAll,
          detectCwd:manager.detectCwd,suggestName:manager.suggestName,listBranches:manager.listBranches,
          resolveCommit:manager.revParseCommit,createWorktree:manager.createWorktree,createId:randomUUID,
          resolveFreshSource:worktrees.freshBase.resolveFreshSourceBranch},undefined,projectDir);
        return result.ok?{ok:true as const,sessionId:result.sessionId,workingDir:result.meta.path,branch:result.meta.branch}:result;
      },
      git:async(args,cwd)=>(await worktrees.gitExec(args,cwd,{timeoutMs:10000})).stdout,
      trashItem:input.trashItem,
    });
    const permissions=createSessionPermissionPersistence(getDbClient);
    const validation=createProjectDirectoryValidation({dialogueWorkspaceRoots:this.dialogueWorkspaceRoots,
      normalizeRecentWorkdirPath:conversations.recent.normalizeRecentWorkdirPath});
    const deps:BotGroupChatServiceDeps={
      ensureLane:async params=>{
        try{return await this.bots!.profiles.ensureBotGroupLaneSession(params);}
        catch(error){return {ok:false as const,errorCode:'LANE_UNAVAILABLE',message:error instanceof Error?error.message:String(error)};}
      },
      dispatch:({attachments,...params})=>this.dispatchBotMessage({...params,...(attachments?.length?{files:attachments.map(attachment=>({
        id:attachment.id,name:attachment.name,originalName:attachment.name,path:attachment.path??attachment.url??'',
        ...(attachment.url?{url:attachment.url}:{}),ext:path.extname(attachment.name).toLowerCase(),size:attachment.size,
        category:attachment.category,mimeType:attachment.mimeType,...(attachment.annotated?{annotated:true}:{}),
      }))}:{})}),
      prepareAttachments:attachments.prepare,
      abortLane:async id=>{await this.invoke('maker:abort-session',[id],{source:'local'});},
      closeLanes:async ids=>{await Promise.all(ids.map(id=>this.closeTask(id).catch(()=>undefined)));},
      syncLanePermission:async(laneId,botId)=>{
        const [canonical]=await getDbClient().drizzle.select({mode:persistedSessionRows.permissionMode}).from(botSessionLinks)
          .innerJoin(persistedSessionRows,dbEq(persistedSessionRows.id,botSessionLinks.sessionId))
          .where(dbAnd(dbEq(botSessionLinks.botId,botId),dbEq(botSessionLinks.role,'canonical'),dbIsNull(botSessionLinks.archivedAt))).limit(1);
        const mode=canonical?.mode;if(!mode||!isSessionPermissionMode(mode))return;
        const live=this.live.get(laneId)?.maker.getSession(laneId);
        if(live){if(live.stablePermissionModeState?.mode!==mode)await live.setPermissionMode(mode as Parameters<Session['setPermissionMode']>[0]);return;}
        if(!await permissions.persistPermissionModeWithoutRuntime(laneId,mode))throw new Error('Group lane permission could not be persisted');
      },
      hasPendingInteraction:id=>[...this.pending.values()].some(pending=>pending.sessionId===id),
      decidePlan:createBotGroupPlanDecider((prompt,options)=>this.utility.request(prompt,options)),workDir,
      validateProjectDir:async dir=>{
        try{const checked=await validation.validateExistingLocalProjectDirectory(dir);return checked.ok?{ok:true as const,dir:checked.workingDir}:{ok:false as const,message:'这个文件夹不能用作项目文件夹'};}
        catch{return {ok:false as const,message:'项目文件夹不存在'};}
      },
      captureOwnerScope:conversations.broadcastTap.captureDataOwnerBroadcastScope,
      isOwnerScopeCurrent:scope=>conversations.broadcastTap.isDataOwnerBroadcastScopeCurrent(scope),
      onChanged:(payload,scope)=>{
        if(scope&&!conversations.broadcastTap.isDataOwnerBroadcastScopeCurrent(scope))return;
        this.emit(MAKER_PUSH.BOT_GROUP_CHANGED,payload);
        this.emit('maker:remote-resources:changed',{collectionId:'bot-groups',resourceRefs:[{collectionId:'bot-groups',kind:'bot-group',id:payload.groupId}]});
      },
      companionCloud:input.companionCloud,
      onStepSettled:input.notifications?createBotGroupStepNotification({
        ...input.notifications, ...conversations.broadcastTap,
        botGroupMembersVisibleRemotely:remote.botGroupMembersVisibleRemotely,log:this.options.logger,
      }):input.onStepSettled,log:this.options.logger,
    };
    this.botGroupChat?.dispose();
    const local=original.createBotGroupChatService(deps);
    this.botGroupChat=input.withChatServer?input.withChatServer(local,deps,original.readPersistedReplyText):local;
    this.eventBindings.botGroupChat=this.botGroupChat;
    remote.registerBotGroupRemoteResourceProvider(()=>this.botGroupChat??null);
    registerBotGroupHandlers<TaskInvocationContext>({
      ipcMain:{handle:(channel,handler)=>{this.botHandlers.set(channel,handler);}},getService:()=>this.botGroupChat,
      assertTrustedAppRendererEvent:context=>{this.guard(context);if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');},
    });
  }

  async dispatchBotMessage(input:BotSessionMessage) {
    this.guard({source:'local'});
    if(!this.botDispatch)throw new Error('BOT_SERVICES_NOT_READY');
    return this.botDispatch(input);
  }
  async unlockSecretServices() {
    await this.mcpApps.unlock();
    await this.capabilities.invoke('maker:mcp:custom:refresh', [], {source:'local'});
  }
  async continueInputHandoff(sessionId: string, requestId: string, message: string) {
    await this.inputCoordinator.ensureQueueRestored(sessionId).catch(() => undefined);
    const result = await this.dispatchBotMessage({
      targetSessionId: sessionId, message,
      persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${message}`,
      clientId: `input-handoff-result:${requestId}`,
    });
    if (!result.ok) throw new Error(`Input handoff continuation not accepted: ${result.errorCode}`);
  }
  async prepareBotSessionForImSend(id:string) {
    this.guard({source:'local'});
    const database=await this.database;
    return createBotImSendGuard({
      getDbClient:()=>{this.guard({source:'local'});return database.getDbClient();},
      reconcileBotModelRoute:sessionId=>this.reconcileBotRoute?.(sessionId)??Promise.resolve(),
      getSession:sessionId=>this.live.get(sessionId)?.maker.getSession(sessionId),
      refreshBotCapabilityEpochBeforeSend:session=>this.refreshBotCapabilityBeforeSend?.(session)??Promise.resolve(),
    })(id);
  }
  private skillReader?:ReturnType<typeof createTerminalSkillReader>;
  async listAgentSkills(kind:AgentKind,options:Parameters<ReturnType<typeof createTerminalSkillReader>['listAgentSkills']>[1]) {
    await this.ready;this.guard({source:'local'});
    this.skillReader??=createTerminalSkillReader({profileDir:this.options.profileDir,storage:this.storage,logger:this.options.logger,
      capabilities:this.capabilities,binary:kind=>this.binaries.get(kind)??null,ssh:this.options.ssh,sshRuntime:this.sshRuntime,
      assertCurrent:()=>this.guard({source:'local'})});
    return this.skillReader.listAgentSkills(kind,options);
  }
  private builtinMcpCatalog(): McpProvider[] {
    this.guard({source:'local'});
    const providers: McpProvider[] = [...this.deviceTools.providers,{name:TASK_CORE_MCP_NAMES.helper},this.orcaTools.provider,this.localWorkerMcpProvider()];
    if(this.schedulerDeps)providers.push({name:TASK_CORE_MCP_NAMES.scheduler});
    if(this.knowledge)providers.push(...this.knowledge.providerCatalog());
    if(this.pluginFactory)providers.push({name:TERMINAL_PLUGIN_MCP_NAME});
    if(this.channelTools)providers.push(...Object.keys(this.channelTools(()=>{
      const context=getLiziMcpSessionContext();
      if(!context)throw new Error('TASK_MCP_SCOPE_MISMATCH');
      return context;
    },{})).map(name=>({name})));
    return gateBuiltinMcpProviders(providers,this.builtinTools);
  }
  async connectOriginalBotServices(input:{memory:TerminalBotServicesHost['memory'];resourceRoot():string;listBotImChannels:NonNullable<BotProfileRuntimeDeps['listBotImChannels']>;isCompanionShadowed(id:string):boolean;messageTransport?:BotMessageTransport}) {
    await this.ready;
    const database=await this.database;
    const catalog=createTerminalBotCatalog({
      root:this.options.profileDir,memory:input.memory,capabilities:this.capabilities,mcpApps:this.mcpApps,
      getDbClient:()=>database.getDbClient(),getMaker:()=>({listAgentSkills:(...args)=>this.listAgentSkills(...args)}),
      getPluginRegistry:()=>this.builtinTools,builtinProviders:()=>this.builtinMcpCatalog(),
      resolveBotAgentKind:async(id,chain)=>(await this.reconcileBotRoute?.preview(id,chain))?.agentKind??null,
      services:()=>{if(!this.bots)throw new Error('BOT_SERVICES_NOT_READY');return this.bots;},
      listBotImChannels:input.listBotImChannels,
      remoteFiles:id=>{if(!this.options.ssh)throw new Error('SSH_RUNTIME_UNAVAILABLE');return this.options.ssh.pi.getRemoteAgentFileOps!(id);},
      assertCurrent:()=>this.guard({source:'local'}),
    });
    return this.connectBotServices({...input,...catalog});
  }
  private async connectBotServices(input:{memory:TerminalBotServicesHost['memory'];resourceRoot():string;capabilityDeps:TerminalBotServicesHost['capabilityDeps'];runtimeDeps:BotProfileRuntimeDeps;isCompanionShadowed(id:string):boolean;messageTransport?:BotMessageTransport}) {
    await this.ready;
    if(this.bots)throw new Error('BOT_SERVICES_ALREADY_CONNECTED');
    const database=await this.database,conversations=await this.conversations;
    const guard=()=>this.guard({source:'local'});
    const getDbClient=()=>{guard();return database.getDbClient();};
    const owner=conversations.broadcastTap.captureDataOwnerBroadcastScope();
    const ownerScope=()=>{guard();return owner.ownerScopeKey!;};
    const maker={getSession:(id:string)=>this.live.get(id)?.maker.getSession(id),closeSession:(id:string)=>this.closeTask(id)};
    const models=this.runtimeRecovery.models;
    const raw=async(id:string)=>(await getDbClient().drizzle.select().from(persistedSessionRows).where(dbEq(persistedSessionRows.id,id)).limit(1))[0];
    const synthesize=(id:string,options:MakerSessionCreateOpts)=>preparePersistedOrcaSessionStart(id,options,{
      getSessionRole:taskId=>this.orcaStore.getSessionOrcaRole(taskId),
      getWorkerLink:taskId=>this.orcaStore.getWorkerLink({workerSessionId:taskId}),
      getRemoteLead:async taskId=>(await this.storage.get(taskId))?.orcaRemoteLead??null,
      warn:(message,fields)=>this.options.logger.warn(message,fields),
    });
    const preflight=async(options:MakerSessionCreateOpts)=>{
      guard();if(!this.bots)throw new Error('BOT_SERVICES_NOT_READY');
      const snapshot=await this.bots.runtime.hydrateBotProfileRuntime({...options},input.runtimeDeps,{persistSnapshot:false});guard();return snapshot;
    };
    this.refreshBotCapabilityBeforeSend=createBotCapabilityPreflight({getDbClient,coordinator:this.eventRuntime.compact,
      buildCreateOptsWithStderr:options=>options,synthesizeOrcaVendorOptionsFromDb:synthesize,
      readSessionExtraDirsFromDb:async id=>{const row=await raw(id);return row?.extraDirs?JSON.parse(row.extraDirs):[];},
      preflightBotRuntimeResources:preflight,
    });
    const reconcile=this.reconcileBotRoute=createBotModelRouteReconciler({
      ownerEpoch:this.runtimeControl.captureSessionRuntimeControlOwnerEpoch,
      withSessionLock:(id,work)=>this.routes.withLock(id,work),
      read:createBotModelRouteReader({getDbClient,maker,...models,...this.runtimeControl,...this.runtimeAxes,...this.routes.providers,agentSwitchPending:this.routes.pending}),
      apply:async(id,route,current)=>{await this.routes.applySystemUnderLock(id,{...route,agentDeviceId:route.agentDeviceId??null},current.agentKind);},
    });
    this.eventBindings.botRefresh=createBotRuntimeRefreshHost({
      getDbClient,maker,log:this.options.logger,withSendToSessionLock:(id,work)=>this.routes.withLock(id,work),
      hasPendingAgentInteractionForSession:id=>[...this.pending.values()].some(item=>item.sessionId===id),
      hasPendingAgentSwitch:id=>!!this.routes.pending.get(id),applyPendingAgentSwitch:async id=>this.routes.applySystemUnderLock(id,null,maker.getSession(id)?.agentKind??dbToMakerAgentKind((await raw(id))?.agentKind)),
      buildCreateOptsWithStderr:options=>({...options}),synthesizeOrcaVendorOptionsFromDb:synthesize,
      readSessionExtraDirsFromDb:async id=>{const row=await raw(id);return row?.extraDirs?JSON.parse(row.extraDirs):[];},
      checkWorkDirExists:(...args)=>this.workdirs.check(...args),
      ensureRemoteReadyForSessionStart:async({createOpts})=>{if(createOpts.remoteHostId){if(!this.sshRuntime)throw new Error('SSH_AGENT_ROUTE_UNAVAILABLE');await this.sshRuntime.prepare(createOpts.agentKind,createOpts.remoteHostId);}},
      withRehydrateCloseSuppressed:(id,work)=>this.withRehydrateCloseSuppressed(id,work),preflightBotRuntimeResources:preflight,
      bootstrapSession:async options=>{
        const id=options.id;if(!id)throw new Error('TASK_ID_REQUIRED');
        this.preparedSessionStarts.set(id,{options,didInjectOrcaInstructions:await this.prepareNativeSessionOptions(id,options)});
        try{return {session:(await this.ensureLive(id)).session};}finally{this.preparedSessionStarts.delete(id);}
      },
      markOrcaRoleIfNeeded:async(id,role)=>{if(role)await this.storage.update(id,{orcaRole:role});},
      broadcastSessionCreated:id=>this.emit('local-db:sessions:created',{sessionId:id}),
    });
    const requestRefresh:TerminalBotServicesHost['requestBotRuntimeEpochRefresh']=this.botRuntimeEpochRefresh=async(id,reason)=>{
      const refresh=(session:Session)=>{this.eventRuntime.compact.noteBoundary(session);return this.eventRuntime.compact.attempt(session);};
      try{
        const live=()=>maker.getSession(id);
        const result=reason==='model'?await refreshBotRuntimeAfterModelSelection({current:live,select:()=>reconcile.profileChanged(id),refresh}):live()?await refresh(live()!):'not-bot';
        return result==='refreshed';
      }catch(error){this.options.logger.warn('Bot runtime capability epoch refresh failed',{sessionId:id,reason,error:error instanceof Error?error.message:String(error)});return false;}
    };
    const auxiliary=createAuxiliaryTextRequest({
      readModels:async()=>{await this.utility.ready;return [...this.utility.effective().refs];},readOwnerScope:ownerScope,
      requestText:(prompt,options)=>this.utility.request(prompt,options),isAppSessionBoundaryPending:()=>this.closed,
      getEffectiveAuxiliaryModelChain:()=>this.utility.effective(),getEffectiveAuxiliaryModelChainSnapshot:()=>this.utility.effectiveSnapshot(),
      isAgentOneShotRouteDisabled:async kind=>{try{await this.models.select({agentKind:kind,providerId:kind==='codex'?'openai':'anthropic'});return false;}catch{return true;}},
      getMaker:()=>({oneShot:(kind,prompt,options)=>this.nativeUtilityText(kind,prompt,{...options,beforeDispatch:options?.beforeDispatch?async()=>options.beforeDispatch!():undefined})}),logger:this.options.logger,
    });
    this.botRuntimeDeps=input.runtimeDeps;this.botMemory=input.memory;
    this.bots=await openTerminalBotServices({
      ...input,...models,...this.defaultModels,...this.models.visibility.mirror,
      getDbClient,tryGetDbClient:()=>this.closed?null:getDbClient(),getMakerIfReady:()=>this.closed?null:maker,
      activeOwnerScopeKey:ownerScope,isAppSessionBoundaryPending:()=>this.closed,
      ownerScopedUserDataPath:()=>this.options.profileDir,legacyUserDataPath:()=>this.options.profileDir,
      logger:this.options.logger,mapper:conversations.rowMapper,
      ensureProjectGitInitialized:this.gitSnapshots.ensureProjectGitInitialized,readGitSafetySettings:this.gitSnapshots.readGitSafetySettings,
      requestBotRuntimeEpochRefresh:requestRefresh,getResolvedMainLocale:()=>this.options.language?.()??'en',
      coordinateBotCanonicalReplacement:(id,work)=>this.routes.withLock(id,async()=>{
        const live=maker.getSession(id);
        if(isBotCanonicalReplacementBusy({turnRunning:live?.isTurnRunning()===true,backgroundTaskCount:live?.listBackgroundTasks().length??0,
          trackedTurn:this.eventRuntime.activity.isSessionInTurn(id),leasedTurn:await this.turnLifecycle.leases.isTurnActive(id),pendingInteraction:[...this.pending.values()].some(item=>item.sessionId===id)}))
          throwIpcError('SESSION_RUNNING','The teammate task is still running or waiting for input.');
        return work();
      }),
      broadcastBotRemoteResourceChanged:conversations.botInvalidation.broadcastBotRemoteResourceChanged,
      signalBotAutonomyBotsChanged:()=>{for(const listener of this.botRosterListeners){try{listener();}catch{}}},
      notifyAgentIslandCompanionChanged:id=>this.sessionActivity.companionChanged(id),
      broadcastProfileChanged:payload=>this.emit(MAKER_PUSH.BOT_PROFILE_CHANGED,payload),
      broadcastSessionPatched:(id,patch)=>this.emit('local-db:sessions:patched',{sessionId:id,patch}),
      createMessage:conversations.messages.createMessage,subscribeNewMakerDefaults:this.models.defaults.cache.subscribeNewMakerDefaults,
      requestAuxiliaryText:args=>auxiliary({...args,signal:AbortSignal.any([this.utilityAbort.signal,...(args.signal?[args.signal]:[])])}),
      captureDataOwnerBroadcastScope:conversations.broadcastTap.captureDataOwnerBroadcastScope,
      waitForModelVisibilityMirror:()=>this.models.waitForModelVisibility(),getDesktopProviderService:()=>({listProviders:options=>this.models.views(options)}),
      requestUtilityText:(prompt,options)=>this.utility.request(prompt,options),
      listCustomMcpServers:async(...args)=>(await this.mcpApps.configuration()).listCustomMcpServers(...args),
      media:this.media,mediaRuntime:this.mediaRuntime,
    });
    const readSenderIdentity=createSessionSenderIdentityReader(getDbClient);
    const buildInput=this.sessionControls.buildInput;
    this.botDispatch=createBotSessionDispatcher({
      getDbClient,maker:{getSessionMeta:id=>this.storage.get(id)},getSessionRowSnapshot:conversations.snapshot.getSessionRowSnapshot,
      getInputCoordinator:()=>({
        ensureQueueRestored:id=>this.inputCoordinator.ensureQueueRestored(id),
        isQueueRestored:id=>this.inputCoordinator.isQueueRestored(id),
        hasPendingQueueItem:(...args)=>this.inputCoordinator.hasPendingQueueItem(...args),
        hasQueuedItemWhere:(...args)=>this.inputCoordinator.hasQueuedItemWhere(...args),
        remove:(...args)=>this.inputCoordinator.remove(...args),
        enqueue:(id,...args)=>{guard();this.inputSessions.add(id);return this.inputCoordinator.enqueue(id,...args);},
      }),
      createId:randomUUID,buildSessionControlInputItem:buildInput,readSenderIdentity,welcomeDispatchReceipts:this.botWelcomeReceipts,
      sendToSessionInternal:this.botSessionInput=params=>this.routes.withLock(params.targetSessionId,async()=>{
        guard();const row=await this.storage.get(params.targetSessionId);
        if(!row||row.deleted||row.archived)return {ok:false as const,errorCode:'NOT_FOUND',message:'Task unavailable'};
        await this.inputCoordinator.ensureQueueRestored(row.id);
        if(!this.inputCoordinator.isQueueRestored(row.id))throw new Error('Task queue restoration is incomplete');
        const clientId=params.clientId??randomUUID();
        const queued=await buildInput({...params,meta:row,clientId,persistedContent:params.persistedContent??params.message,
          origin:sessionQueueOriginForDispatcher({dispatcherSessionId:params.dispatcherSessionId,...await readSenderIdentity(params.dispatcherSessionId),message:params.message})});
        if(params.onAccepted)this.orcaDispatcher.registerQueuedOrcaInterAgentAcceptedCallback(clientId,params.onAccepted,params.onAcceptedRollback);
        const enqueue=()=>{guard();this.inputSessions.add(row.id);this.inputCoordinator.enqueue(row.id,queued,{resumeRestorePausedQueue:true});};
        try{
          if(params.authorizationGuard)await commitBotAuthorizationInput(params.authorizationGuard,enqueue);else enqueue();
          await database.inputQueue.awaitAgentInputQueueSnapshotPersistence(row.id);guard();
          return {ok:true as const,targetSessionId:row.id,wakeKind:'queued' as const,queuedMessageId:clientId};
        }catch(error){this.orcaDispatcher.discardQueuedOrcaInterAgentAcceptedCallback(clientId);throw error;}
      }),
    });
    this.bots.invitations.setBotInvitationWelcomeDispatch(input=>this.dispatchBotMessage(input));
    const canonical=createBotCanonicalSessionRecovery({getDbClient,...createBotCanonicalSessionRegistry(getDbClient),
      createBotCanonicalSession:this.bots.profiles.createBotCanonicalSession,
      broadcastSessionCreated:id=>this.emit('local-db:sessions:created',{sessionId:id})});
    const translate=createRuntimeTranslator(mainLocaleResources,()=>this.options.language?.()??'en');
    this.authorizeTaskToolCall=createTaskToolCallAuthorizer({
      getDb:()=>this.closed?null:getDbClient(),isScopeCurrent:db=>!this.closed&&db===getDbClient(),
      authorizeAction:createTaskActionHost({tryGetDbClient:()=>this.closed?null:getDbClient(),isAppSessionBoundaryPending:()=>this.closed,
        authorizeGroupTool:this.bots.groups.authorizeGroupTool,
      }).createDesktopTaskActionAuthorizer({
        getSession:maker.getSession,
        input:id=>{
          const accepted=this.inputCoordinator.getAcceptedInputProvenance(id),session=maker.getSession(id);
          const input={input:accepted,executing:!!accepted||!!session?.isTurnRunning()};
          const ownerInput=this.inputCoordinator.isActiveInputOwnerAuthored(id);
          return {key:JSON.stringify(input),permission:resolveGhostFsSessionSnapshot(maker.getSession,id,session?.instanceId),ownerInput,
            automatic:!!accepted&&!ownerInput,orcaSenderSessionId:accepted?.orcaSenderSessionId,
            boundary:`${session?.instanceId??''}:${this.inputCoordinator.getGeneration(id)}`};
        },
        confirm:async(id,tool,args)=>(await this.taskActionConfirm.request(id,{
          title:translate.t('taskActionConfirmation.title'),description:translate.t(tool==='start_session_task'?'taskActionConfirmation.delegation':'taskActionConfirmation.once'),
          action:{toolName:`mcp__cindy_helper__${tool}`,input:args as Record<string,unknown>,confirmation:'task_action'},
        })).confirmed,
      }),
    });

    const formatForwardedRequest=(source:import('@cindy/maker-shared/forwarded-request-types').ForwardedRequestSource,supplement:string)=>
      source.userText===null?supplement:formatLocalizedForwardedRequest(source,supplement,this.options.language?.()??'en');
    const delegationRuntime=createBotDelegationRuntime({
      getDbClient,logger:this.options.logger,t:key=>translate.t(key),
      signalBotAutonomyBotsChanged:()=>{for(const listener of this.botRosterListeners)listener();},
      ownerScopedUserDataPath:()=>this.options.profileDir,legacyUserDataPath:()=>this.options.profileDir,
      authorizeGroupTool:this.bots.groups.authorizeGroupTool,formatForwardedRequest,captureAgentRequest:createAgentRequestCapture(formatForwardedRequest),
      ...this.sessionOpening,...this.sessions.service,...conversations.messages,...conversations.rowMapper,
      createBotCanonicalSession:this.bots.profiles.createBotCanonicalSession,...createBotCanonicalSessionRegistry(getDbClient),
      ...this.botParentLifecycle,...this.defaultModels,
    });
    const control=this.sessionControls.service;
    const flushInput=(id:string)=>database.inputQueue.awaitAgentInputQueueSnapshotPersistence(id);
    this.botDelegations=delegationRuntime.createBotDelegationService({
      postGroupTaskMessage:input=>this.botGroupChat?.postCompanionTaskMessage(input)??Promise.resolve({ok:false,errorCode:'GROUP_CHANNEL_UNAVAILABLE',retryable:false}),
      captureRequest:this.sessionControls.captureRequest,
      readSessionExecution:id=>{const session=maker.getSession(id);return session?{instanceId:session.instanceId,generation:session.getTurnGeneration()}:null;},
      withSessionLock:this.routes.locks.withSessionRestartLock,
      taskControl:{
        steer:control.steerSession,stop:control.stopSessionTurn,
        isActive:id=>{const session=maker.getSession(id);return !!session&&(session.isTurnRunning()||session.getTurnControlSnapshot().pendingInteractionCount>0);},
        holdInput:(id,held)=>{
          this.inputCoordinator.setExecutionPaused(id,held||!this.pendingDispatchReady);
          return held?[]:this.releaseDeferredInteractions(id);
        },
        waitForInputBoundary:id=>this.routes.withLock(id,async()=>undefined),
        preparePause:async id=>{await this.cancelTaskRecovery(id);await this.goals.controller.pauseGoal(id,'paused: stopped by user');},
        restoreInput:id=>this.inputCoordinator.ensureQueueRestored(id),flushInput,
        resumeInput:async id=>{this.inputCoordinator.resume(id);},
      },
      ...(this.worktrees?{
        prepareWorktree:async(workingDir:string)=>{
          const manager=this.worktrees!.manager;
          const result=await prepareHandoffWorktree({getForSession:manager.getForSession,listAll:manager.listAll,detectCwd:manager.detectCwd,
            suggestName:manager.suggestName,listBranches:manager.listBranches,resolveCommit:manager.revParseCommit,
            createWorktree:manager.createWorktree,createId:randomUUID,resolveFreshSource:this.worktrees!.freshBase.resolveFreshSourceBranch},undefined,workingDir);
          return result.ok?{ok:true as const,sessionId:result.sessionId,workingDir:result.meta.path}:result;
        },
        getWorktree:this.worktrees.manager.getForSession,reconcileWorktree:this.worktrees.manager.reconcileSessionTransfer,
        withTransferredWorktree:this.worktrees.manager.withTransferredSession,
        discardUnusedWorktree:async(id:string)=>{if(!await this.storage.get(id))await this.worktrees!.manager.removeWorktreeForSession(id);},
      }:{}),
      taskQueue:{
        inspect:async(id,caller)=>{await this.inputCoordinator.ensureQueueRestored(id);if(!this.inputCoordinator.isQueueRestored(id))throw new Error('Task queue restoration is incomplete');
          return this.inputCoordinator.getQueueInspection(id).filter(item=>item.source==='session'&&item.sourceLabel===caller)
            .map(item=>({queuedMessageId:item.queuedMessageId,consuming:item.consuming,message:item.content}));},
        update:control.updateQueuedMessage,cancel:control.cancelQueuedMessage,
      },
      readCallerPermission:id=>{const state=maker.getSession(id)?.stablePermissionModeState;return state?.mode?{mode:state.mode,generation:state.generation}:null;},
      readCallerRuntime:id=>{const session=maker.getSession(id);return session?{
        agentKind:makerToDbAgentKind(session.agentKind),agentDeviceId:session.agentDeviceId??null,model:session.model,
        providerId:this.routes.providers.getSessionProvider(id)??null,effort:(this.runtimeAxes.getSessionEffort(id)??undefined) as import('@cindy/maker-core').Effort|undefined,
        fastMode:this.runtimeAxes.getSessionFastMode(id),
      }:null;},
      taskRoute:createBotSessionTaskRouteBridge({getSessionRuntime:control.getSessionRuntime,setSessionRuntime:control.setSessionRuntime,
        readConfiguredCandidate:(caller,current,child)=>this.runtimeRecovery.readBotFallbackCandidate(caller,current,child)}),
      dispatch:({onAccepted,...params})=>this.dispatchBotMessage({...params,resumeWithStoredPermissionMode:true,
        onAccepted:onAccepted?async replayed=>{try{await onAccepted(replayed);}catch(error){
          if(error instanceof GroupToolAuthorizationError||error instanceof TaskActionAuthorizationError)throw new AcceptedCallbackDispatchCancelled(error.message);throw error;
        }}:undefined,
      }),
      discardDelegationQueuedInputs:(id,delegation)=>discardDelegationQueuedInputs(this.inputCoordinator,id,delegation,flushInput),
      abortSession:async id=>{await this.invoke('maker:abort-session',[id],{source:'local'});},closeSession:maker.closeSession,
      broadcastSessionCreated:id=>this.emit('local-db:sessions:created',{sessionId:id}),
      onChanged:payload=>this.emit(MAKER_PUSH.BOT_DELEGATION_CHANGED,payload),
      resolveInteraction:(id,decision)=>this.pending.get(id)?.decide(decision)??false,
      hasPendingInput:id=>this.inputCoordinator.getQueueControlSnapshot(id).pendingQueue.length>0,
      readPendingInputClientIds:id=>this.inputCoordinator.getQueueControlSnapshot(id).pendingQueue.flatMap(item=>[
        item.clientId,...(item.supersedesUserClientId?[item.supersedesUserClientId]:[]),...(item.retrySourceClientId?[item.retrySourceClientId]:[])]),
      collectArtifacts:async(id,inputs)=>{
        await this.changes.store.waitForTurnChangeSetSeal(id);const accepted=new Set(inputs);
        const changes=(await this.changes.store.listTurnChangeSets(id)).filter(change=>accepted.has(change.anchorClientId));
        const files=new Map<string,{path:string;absolutePath:string;status:'added'|'modified'|'deleted'|'renamed'}>();
        for(const change of changes)for(const file of change.files)files.set(file.path,{path:file.path,absolutePath:path.resolve(change.cwd,file.path),
          status:file.status==='added'||file.status==='untracked'||file.status==='copied'?'added':file.status==='deleted'?'deleted':file.status==='renamed'?'renamed':'modified'});
        return [...files.values()];
      },
    });
    const lifecycleRuntime=createBotLifecycleRuntime({
      getDbClient,...this.botProfileLocks,activeOwnerScopeKey:ownerScope,isAppSessionBoundaryPending:()=>this.closed,
      ownerScopedUserDataPath:()=>this.options.profileDir,legacyUserDataPath:()=>this.options.profileDir,logger:this.options.logger,
      deleteBotProfileAndDetachSessionsInDb:this.sessions.service.deleteBotProfileAndDetachSessionsInDb,
      ...createBotCanonicalSessionRegistry(getDbClient),
      broadcastBotRemoteResourceChanged:conversations.botInvalidation.broadcastBotRemoteResourceChanged,
      broadcastBotLifecycleChanged:payload=>{for(const listener of this.botRosterListeners)listener();this.emit(MAKER_PUSH.BOT_LIFECYCLE_CHANGED,payload);},
    });
    this.botLifecycle=lifecycleRuntime.createBotLifecycleService({
      maker,getDelegationService:()=>this.botDelegations??null,restartRuntime:(id,current)=>this.restartOriginalBotRuntime(id,current),
      onPaused:id=>this.botLifecycleHooks.onPaused?.(id),
      onResumed:async id=>{void this.botDelegations?.resumeCompletionDelivery(id);await this.botLifecycleHooks.onResumed?.(id);},
      onBeforeDelete:id=>this.botLifecycleHooks.onBeforeDelete?.(id),
      onDeleted:(id,current)=>this.botLifecycleHooks.onDeleted?.(id,current),
      onLifecycleChanged:id=>this.botLifecycleHooks.onLifecycleChanged?.(id),
    });
    registerBotLifecycleActionHandler<TaskInvocationContext>({service:this.botLifecycle,
      ipcMain:{handle:(channel,handler)=>this.botHandlers.set(channel,handler)},
      assertTrustedAppRendererEvent:context=>{this.guard(context);if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');},
    });
    this.eventBindings.botDelegation=this.botDelegations;
    registerBotDelegationHandlers<TaskInvocationContext>({service:this.botDelegations,
      ipcMain:{handle:(channel,handler)=>this.botHandlers.set(channel,handler)},
      isDeviceLinkInvoke:()=>this.currentInvocation().source==='remote',
      assertTrustedAppRendererEvent:context=>{this.guard(context);if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');},
    });


    this.botDirectMessages=createBotDirectMessageRuntime({
      getDbClient,createMessage:conversations.messages.createMessage,isCompanionShadowed:input.isCompanionShadowed,
      ...this.botProfileLocks,authorizeGroupTool:this.bots.groups.authorizeGroupTool,
      groupAuthorizationError:()=>new GroupToolAuthorizationError(false,translate.t('groupTools.authorizationRequired')),
      readForwardedRequestSource,matchesForwardedRequest,t:key=>translate.t(key),
    }).createBotDirectMessageService({
      transport:input.messageTransport,ensureCanonicalSession:canonical.ensureCanonicalSession,
      captureOwnerScope:conversations.broadcastTap.captureDataOwnerBroadcastScope,
      isOwnerScopeCurrent:scope=>!this.closed&&conversations.broadcastTap.isDataOwnerBroadcastScopeCurrent(scope),
      hasQueuedDelivery:async(id,clientId)=>{await this.inputCoordinator.ensureQueueRestored(id);guard();return this.inputCoordinator.hasKnownClientId(id,clientId);},
      discardQueuedDelivery:async(id,clientId,assertOwner)=>{await this.inputCoordinator.ensureQueueRestored(id);guard();assertOwner();this.inputCoordinator.remove(id,clientId);},
      dispatch:async request=>{
        const result=await this.dispatchBotMessage({...request,onAccepted:request.onAccepted?async()=>{
          try{await request.onAccepted!();}catch(error){throw new AcceptedCallbackDispatchCancelled(error instanceof Error?error.message:String(error));}
        }:undefined});
        return result.ok?result:{...result,message:result.message??'Bot message delivery failed'};
      },
      onChanged:(payload,scope)=>{if(scope&&!conversations.broadcastTap.isDataOwnerBroadcastScopeCurrent(scope))return;this.emit(MAKER_PUSH.BOT_DIRECT_MESSAGE_CHANGED,payload);},
    });
    await this.botRestore.restoreCurrentOwner();
    registerBotDirectMessageHandlers<TaskInvocationContext>({
      ipcMain:{handle:(channel,handler)=>{this.botHandlers.set(channel,handler);}},
      isDeviceLinkInvoke:()=>this.currentInvocation().source==='remote',
      assertTrustedAppRendererEvent:context=>{this.guard(context);if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');},
      getService:()=>this.botDirectMessages,
    });
    registerBotProfileHandlers<TaskInvocationContext>({
      ...this.bots.profiles,...models,...this.defaultModels,getDbClient,tryGetDbClient:()=>this.closed?null:getDbClient(),
      isDeviceLinkInvoke:()=>this.currentInvocation().source==='remote',
      assertTrustedAppRendererEvent:context=>{this.guard(context);if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');},
      ipcMain:{handle:(channel,handler)=>{this.botHandlers.set(channel,handler);}},
      validateBotCapabilityAdditions:this.bots.capabilities.validateAdditions,
    });
    registerBotContentHandlers<TaskInvocationContext>({
      ...this.bots.profiles,...this.bots.creation,...this.bots.skills,...conversations.rowMapper,...this.history,getDbClient,memory:this.bots.memory,
      assertTrustedAppRendererEvent:context=>{this.guard(context);if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');},
      ipcMain:{handle:(channel,handler)=>{this.botHandlers.set(channel,handler);}},
    });
    return this.bots;
  }

  configureScheduler(deps?: import('../../../../packages/lizi-mcps/src/types.js').SchedulerMcpDeps) {this.schedulerDeps=deps;this.eventRuntime?.scheduledOutput.setSilencedRunProbe(runId=>this.schedulerDeps?.getScheduler().isRunSilenced(runId)===true);}
  private companionHelperFactory?: (input:{sessionId:string;workingDir:string;agentKind:AgentKind})=>Pick<import('@cindy/mcps').XdtHelperMcpDeps,'botWorkbench'|'botRoutines'|'botProfiles'|'teammateHome'>;
  configureCompanionHelper(factory:NonNullable<TerminalTaskHost['companionHelperFactory']>){
    this.companionHelperFactory=factory;
    return ()=>{if(this.companionHelperFactory===factory)this.companionHelperFactory=undefined;};
  }
  isTaskInputOwnerAuthored(id:string){this.guard({source:'local'});return this.inputCoordinator.isActiveInputOwnerAuthored(id);}
  private projectHelper?:Pick<import('@cindy/mcps').XdtHelperMcpDeps,'createProject'|'projectManagement'|'moveSession'>;
  configureProjectHelper(value:typeof this.projectHelper){this.projectHelper=value;}
  helperDeps(input:{sessionId:string;workingDir:string;agentKind:AgentKind;setTitle?:(title:string)=>Promise<void>;title?:()=>string}):import('../../../../packages/lizi-mcps/src/lizi_xdtHelperMcpServer.js').XdtHelperMcpDeps {
    return {
      ...this.projectHelper,
      ...createSessionBatchHelper({tryGetDbClient:()=>this.closed?null:this.usage.getDbClient(),renameSessionTitlesInDb:(...args)=>this.sessions.service.renameSessionTitlesInDb(...args),setSessionsStatusInDb:(...args)=>this.sessions.service.setSessionsStatusInDb(...args)}),
      setRemoteSessionsStatus:this.options.helperRemoteInvoke?createRemoteSessionsStatusSetter({captureAccess:()=>this.captureHelperOwner(),invoke:this.invokeHelperRemote}):undefined,
      sessionTags:async(caller,request)=>{if(!this.taskTags)throw new Error('HOST_NOT_READY');const result=await this.taskTags.executeTaskTags(request,caller);return ['update','delete'].includes(request.action)?{...result,sessions:[]}:result;},
      ...this.companionHelperFactory?.(input),
      ...(this.options.remoteInvoke?{sendToRemoteSession:params=>this.remoteSessionHandoff(
        {deviceId:params.deviceId,sessionId:params.sessionId},
        {message:params.message,sender:async()=>{const row=await this.storage.get(params.dispatcherSessionId);return {sessionId:params.dispatcherSessionId,...(row?.title?{title:row.title}:{})};}})}:{}),
      history:this.historyDeps(),
      resolveSurface:({sessionId})=>this.helperSurface(sessionId),
      authorizeCall:call=>this.authorizeTaskToolCall?this.authorizeTaskToolCall(call):Promise.resolve({ok:true}),
      sessionControl:this.sessionControls.service,
      ...(this.botDelegations?{sessionTasks:{
        startSessionTask:this.botDelegations.startSessionTask,
        messageSessionTask:({callerSessionId,taskId,reply})=>this.botDelegations!.messageSessionTask(callerSessionId,taskId,reply),
        getSessionTask:({callerSessionId,taskId,queuedMessageId})=>this.botDelegations!.getSessionTask(callerSessionId,taskId,queuedMessageId),
        stopSessionTask:({callerSessionId,taskId,mode})=>this.botDelegations!.stopSessionTask(callerSessionId,taskId,mode),
        inspectSessionTaskRoute:({callerSessionId,taskId})=>this.botDelegations!.inspectSessionTaskRoute(callerSessionId,taskId),
        advanceSessionTaskRoute:({callerSessionId,taskId,expectedGeneration,selectionToken})=>this.botDelegations!.advanceSessionTaskRoute(callerSessionId,taskId,expectedGeneration,selectionToken),
      }}:{}),
      botCapabilities:this.bots?.capabilities,
      ...(this.botDirectMessages?{botMessaging:{
        messageAgent:this.botDirectMessages.messageAgent,sendToUser:this.botDirectMessages.sendToUser,
        checkMessage:this.botDirectMessages.checkMessage,listAgents:({callerSessionId}:{callerSessionId:string})=>this.botDirectMessages!.listAgents(callerSessionId),
      }}:{}),
      ...(this.bots?{botSkills:{list:this.bots.skills.listBotSkillsForSession,save:this.bots.skills.saveBotSkillForSession}}:{}),
      setCurrentSessionTitle:async({sessionId,title})=>{if(sessionId!==input.sessionId)throw new Error('TASK_SCOPE_MISMATCH');if(input.setTitle)await input.setTitle(title);else await this.patchMeta(sessionId,{title});return {ok:true,sessionId,title};},
      sendToSession:async params=>{
        let id=params.targetSessionId;const existing=id?await this.storage.get(id):null;
        if(id&&!existing)return {ok:false,errorCode:'NOT_FOUND',message:'Task not found'};
        if(existing?.deleted)return {ok:false,errorCode:'DELETED',message:'Task is deleted'};
        if(existing?.archived)return {ok:false,errorCode:'ARCHIVED',message:'Task is archived'};
        if(!id){
          const sessionId=randomUUID();let workingDir=params.workingDir??input.workingDir;
          if(params.useWorktree){
            if(!this.worktrees)return {ok:false,errorCode:'WORKTREE_UNAVAILABLE',message:'Worktree creation is not configured'};
            const source=await this.worktrees.workerProjects.resolveWorkerWorktreeSource(workingDir);
            const fresh=await this.worktrees.freshBase.resolveFreshSourceBranch(workingDir,source);
            workingDir=await this.worktrees.workerProjects.createWorkerWorktree(sessionId,workingDir,fresh.sourceBranch);
          }
          try{const created=await this.create({id:sessionId,workingDir,title:params.title,...(params.agentKind?{agentKind:params.agentKind}:{}),...(params.model?{model:params.model}:{}),...(params.effort?{effort:params.effort}:{}),...(params.fast!==undefined?{fastMode:params.fast}:{})},()=>this.guard({source:'local'}));id=created.id;}
          catch(error){if(params.useWorktree&&!await this.storage.get(sessionId))await this.worktrees!.manager.cancelPrecreatedWorktree(sessionId,{path:this.worktrees!.manager.getForSession(sessionId)?.path},{canRemove:async()=>!await this.storage.get(sessionId)});throw error;}
        }
        const target=await this.storage.get(id);if(!target)throw new Error('TASK_NOT_FOUND');
        const receipt=await this.submit(id,{text:params.message},{},{source:'local',sender:{sessionId:input.sessionId,title:input.title?.()}});
        return {ok:true,targetSessionId:id,agentKind:target.agentKind,wakeKind:existing?'queued':'created',targetTitle:target.title,targetLastUserSendAt:null,queuedMessageId:receipt.requestId,providerId:target.providerId??null,model:target.model};
      },
      sessionQueue: {
        listSessionQueue: async id => {
          await this.ready;
          return (await this.sessionQueueReader()).listSessionQueue(id);
        },
        listSessionQueuedCounts: async ids => {
          await this.ready;
          return (await this.sessionQueueReader()).listSessionQueuedCounts(ids);
        },
      }
    };
  }
  readonly invokeHelperRemote=async(deviceId:string,channel:string,args:unknown[],options?:{preSend?:()=>void}):Promise<import('@cindy/device-link').InvokeResultPayload>=>{
    this.guard({source:'local'});options?.preSend?.();
    if(this.options.helperRemoteInvoke){const result=await this.options.helperRemoteInvoke(deviceId,channel,args,options);this.guard({source:'local'});return result;}
    if(!this.options.remoteInvoke)return {ok:false,error:{code:'NOT_CONNECTED',message:'Remote connection is unavailable'}};
    const result=await this.options.remoteInvoke(deviceId,channel,args);this.guard({source:'local'});
    const code=result.error?.code,message=result.error?.message??'Remote request failed';
    return result.ok?{ok:true,result:result.result}:{ok:false,error:{code:'IPC_ERROR',message:code&&code!=='IPC_ERROR'&&/^[A-Z0-9_]+$/.test(code)?`[${code}] ${message}`:message}};
  };
  private captureHelperOwner(){
    this.guard({source:'local'});const owner=this.options.currentOwnerSession?.();
    const current=()=>{this.guard({source:'local'});const next=this.options.currentOwnerSession?.();if(owner?.dataOwnerId!==next?.dataOwnerId||owner?.generation!==next?.generation)throw new Error('OWNER_CHANGED');};
    current();return current;
  }
  private readonly receiveSessionHandoff=createSessionHandoffHandler({
    matchesForwardedRequest,
    validate:async(deviceId,proof)=>{
      try{await validateTaskDelivery(this.options.remoteInvoke,{controllerDeviceId:deviceId,...proof},proof.release);return true;}
      catch{return false;}
    },
    send:async input=>{
      const context=this.inputInvocation.getStore();if(!context?.deliveryProof)throw new Error('AUTHENTICATED_OWNER_REQUIRED');
      this.guard(context);
      const row=await this.storage.get(input.targetSessionId);
      if(!row)return {ok:false,errorCode:'NOT_FOUND',message:'Task not found'};
      if(row.deleted)return {ok:false,errorCode:'DELETED',message:'Task is deleted'};
      if(row.archived)return {ok:false,errorCode:'ARCHIVED',message:'Task is archived'};
      const proof={...context.deliveryProof,autoReviewUserText:input.autoReviewUserText,senderTitle:input.origin.kind==='session'?input.origin.senderSessionTitle:undefined};
      await this.submit(input.targetSessionId,{text:input.message},{requestId:input.clientId},{...context,deliveryProof:proof,taskActionDeliveryGuard:input.taskActionDeliveryGuard});
      // This is the original forceQueue path. Starting a native turn is not a
      // delivery receipt: the sender must retain authority until settlement.
      return {ok:true,agentKind:row.agentKind,wakeKind:'queued',targetTitle:row.title,targetLastUserSendAt:null};
    },
  });
  private readonly remoteSessionHandoff=createRemoteSessionHandoff({
    captureAccess:()=>{this.guard({source:'local'});return ()=>this.guard({source:'local'});},
    invoke:(...args)=>this.invokeHelperRemote(...args),
    captureRequest:async(id,text)=>{
      this.guard({source:'local'});const active=this.inputCoordinator.getAcceptedInputProvenance(id);
      const database=await this.database;
      const links=await database.getDbClient().drizzle.select({role:botSessionLinks.role}).from(botSessionLinks)
        .where(dbAnd(dbEq(botSessionLinks.sessionId,id),dbIsNull(botSessionLinks.archivedAt))).limit(8);
      const preserve=links.some(link=>['canonical','group','channel'].includes(link.role));
      const capture=createAgentRequestCapture((source,supplement)=>formatLocalizedForwardedRequest(source,supplement,this.options.language?.()??'en'));
      const result=await capture(id,text,active??null,async()=>(await this.contextMessages(id,Infinity)).filter(row=>row.role==='user').slice(-1).map(row=>({...row,agentMeta:row.agentMeta??null})),preserve);
      this.guard({source:'local'});return result;
    },
  });
  private async helperSurface(sessionId: string) {
    this.guard({source:'local'});
    const database=await this.database;
    const readExecution=(id:string)=>{
      const input=this.inputCoordinator.getAcceptedInputProvenance(id);
      return {input,executing:!!input||!!this.live.get(id)?.session.isTurnRunning()};
    };
    const surface=await resolveHelperSurface(database.getDbClient(),sessionId,readExecution);
    this.guard({source:'local'});
    return surface;
  }
  private async sessionQueueReader() {
    this.guard({ source: 'local' });
    const database = await this.database;
    return createSessionQueueReader({
      getSessionMeta: id => this.storage.get(id),
      inputCoordinator: this.inputCoordinator,
      ...database.inputQueue,
      isDbClientNotReadyError: database.isDbClientNotReadyError,
    });
  }
  observeTask(id:string, listener:(event:AgentEvent)=>void) {const set=this.taskObservers.get(id)??new Set();set.add(listener);this.taskObservers.set(id,set);return ()=>{set.delete(listener);if(!set.size)this.taskObservers.delete(id);};}
  notificationOrigin(id: string) { return this.inputCoordinator.getAcceptedInputProvenance(id)?.originKind; }
  notificationHasActiveWork(id: string) {
    return this.turnLifecycle.running(id) || this.eventRuntime.activity.isSessionInTurn(id)
      || this.live.get(id)?.maker.getSession(id)?.isTurnRunning() === true || this.inputCoordinator.hasPendingQueuedWork(id);
  }
  listBindings() { return Object.fromEntries(this.groupBindings); }
  async sessionGroup(id: string) { const row = await this.storage.get(id); return row?.groupBinding ? { groupDeviceId: row.groupBinding.groupDeviceId ?? null, providerId: row.groupBinding.providerId } : null; }
  isTurnRunning(id: string): boolean { return this.eventRuntime?.activity.isSessionInTurn(id)===true || (this.inputCoordinator?.getQueueControlSnapshot(id).steeringQueueClientIds.length ?? 0) > 0 || this.turnLifecycle.running(id) || this.starts.has(id) || this.sending.has(id) || this.activeSubmissions.has(id) || this.live.get(id)?.maker.getSession(id)?.isTurnRunning() === true; }
  async submitScheduled(id: string, text: string, origin: Omit<ScheduledOrigin, 'kind'> & { requestId?: string; assertCurrent?: () => void }) {
    return this.submit(id, { text }, { requestId: origin.requestId ?? randomUUID() }, { source: 'local', assertCurrent: origin.assertCurrent, scheduler: { kind: 'scheduler', scheduleId: origin.scheduleId, scheduleName: origin.scheduleName, runId: origin.runId, firedAt:origin.firedAt } });
  }
  isBusy(): boolean { return this.hosted.size > 0 || this.starts.size > 0 || this.sending.size > 0 || this.pending.size > 0 || [...this.inputSessions].some(id => this.inputCoordinator?.hasPendingQueuedWork(id)) || [...this.live.values()].some(task => this.isTurnRunning(task.session.id)); }
  isAgentAvailable(kind: AgentKind): boolean { return Boolean(this.binaries.get(kind)); }
  async refreshBinaries(paths?: Partial<Record<AgentKind, string>>): Promise<void> {
    await Promise.all(ENGINES.map(async kind => this.binaries.set(kind, await findAgentBinary(kind, paths?.[kind] ?? this.options.binaryPaths?.[kind]))));
    this.authCache.clear();
  }
  async purgeHostedTranscripts(hostSessionIds: readonly string[], _nativeIds: readonly string[] = []): Promise<void> {
    await this.ready;
    for(const id of hostSessionIds){ if(!this.hostedRuntimeIds.has(id))continue;
      for(const kind of ['codex','pi'])await rm(path.join(this.options.profileDir,'engines',kind,id),{recursive:true,force:true});
      this.hostedRuntimeIds.delete(id);
    }
    await this.persistHostedIndex();
  }
  private persistHostedIndex(){this.hostedWrites=this.hostedWrites.then(()=>atomicPrivateWrite(path.join(this.options.profileDir,'hosted-runtimes.json'),JSON.stringify([...this.hostedRuntimeIds])));return this.hostedWrites;}
  async startHosted(input: HostedStartInput): Promise<import('@cindy/maker-core').AgentSessionHandle> {
    await this.ready;
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(input.hostSessionId)||await this.storage.get(input.hostSessionId))throw new Error('INVALID_HOST_SESSION_ID');
    this.hostedRuntimeIds.add(input.hostSessionId);await this.persistHostedIndex();
    // Sharing needs a per-run outbound credential boundary; never hand the local
    // native account or long-lived provider key to an isolated guest process.
    const chosen = await this.models.select({ agentKind: input.kind, providerId: input.options.providerId, model: input.options.model });
    if (input.guest && (chosen.route.provider.source !== 'user' || !input.guestProvider || !this.options.authorizeGuestRequest)) throw new Error('GUEST_PROVIDER_PROXY_REQUIRED');
    const authorizeRequest = input.guest && input.guestProvider ? (model: string) => this.options.authorizeGuestRequest!({sessionId:input.hostSessionId,providerId:chosen.selection.providerId,routeToken:input.guestProvider!.routeToken,model}) : chosen.route.provider.source === 'user' && this.options.authorizeHostedRequest ? (model: string) => this.options.authorizeHostedRequest!({sessionId:input.hostSessionId,providerId:chosen.selection.providerId,model}) : undefined;
    if (authorizeRequest && !await authorizeRequest(chosen.selection.model)) throw new Error('GUEST_PROVIDER_UNAUTHORIZED');
    const binary = this.binaries.get(input.kind);
    if (!binary) throw new Error('ENGINE_NOT_INSTALLED');
    let active=true;
    const reviewAbort=new AbortController();
    const guardReview=()=>{this.guard({source:'local'});if(!active)throw new Error('HOSTED_TASK_CLOSED');};
    const reviewAutoPermissionAction=this.permissionReviewer(guardReview,async request=>{
      if(request.sessionId&&request.sessionId!==input.hostSessionId)throw new Error('TASK_AUTHORITY_CHANGED');
      if(authorizeRequest&&!await authorizeRequest(chosen.selection.model))throw new Error('GUEST_PROVIDER_UNAUTHORIZED');
      const {delegatedTask:_delegation,authorizationError:_error,...ordinary}=request;
      return ordinary;
    },reviewAbort.signal);
    const agent = await (this.options.createAgent ?? createTerminalAgent)({ piRuntimeOwner: this.piRuntimeOwner, reviewAutoPermissionAction, profileDir: this.options.profileDir, taskId: input.hostSessionId, selection: chosen.selection, route: chosen.route, binaryPath: binary, models: this.models, logger: this.options.logger, authorizeRequest, ...(input.guest ? {guestHome:input.guestHome} : {}) });
    let runtimeLease: WorktreeRuntimeLease | null = null;
    try {
      if (this.worktrees) runtimeLease = await this.worktrees.runtime.acquireWorktreeRuntimeLease(input.hostSessionId, input.shadowDir);
      guardReview();
      const handle = await agent.startSession(hostedStartOptions(input));
      const close = handle.close.bind(handle);
      handle.close = async () => { active=false;reviewAbort.abort();this.hosted.delete(handle); try { await close(); } finally { await agent.dispose(); } if (runtimeLease) { await this.worktrees!.runtime.releaseWorktreeRuntimeLease(runtimeLease); runtimeLease = null; } };
      if (this.closed) { await handle.close(); throw new Error('TASK_HOST_CLOSED'); }
      this.hosted.add(handle);
      return handle;
    } catch (error) { active=false;reviewAbort.abort();await agent.dispose(); if (runtimeLease) await this.worktrees!.runtime.releaseWorktreeRuntimeLease(runtimeLease); throw error; }
  }
  async companionProviderViews(device?: string) {
    this.guard({source:'local'});
    if (!device) return this.models.views();
    if (!this.options.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
    return readDeviceProviderViews(this.options.remoteInvoke, device);
  }
  async resolveCompanionModel(choice: import('../remote/companions/models.js').CompanionModel, id: string, workingDir: string) {
    const {input,resolved}=await this.admitTask({...choice,workingDir},id,()=>this.guard({source:'local'}));
    return {...resolved,modelRevision:this.models.revision(),
      ...(input.agentDeviceId?{agentDeviceId:string(input.agentDeviceId)}:{}),
      ...(input.groupBinding?{groupBinding:input.groupBinding as import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding}:{})};
  }
  companionDeviceStarter(tools: Awaited<ReturnType<typeof createTaskTools>>, memory: import('@cindy/maker-core').MakerMemoryManager) {
    if (!this.options.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
    return createDeviceAgentStarter({remoteInvoke:this.options.remoteInvoke,rgPath:()=> 'rg',
      codexPath:()=>this.binaries.get('codex')??undefined,mcpProviders:()=>tools.providers,
      prepareMcpBridge:async(_providers,_logger,context)=>tools.pi(context),makerMemory:()=>memory,logger:this.options.logger});
  }
  private async prepareOriginalInput(id: string, input: unknown, context: TaskInvocationContext): Promise<UserMessage | string> {
    this.guard(context);
    const message = typeof input === 'string' || input && typeof input === 'object' && (input as UserMessage).type === 'user'
      ? input as UserMessage | string : await this.message(id, input, context);
    const normalized = await this.attachments.normalizeUserMessage(id, message);
    this.guard(context);
    const cache = (await this.media.persisted()).imageCacheStore;
    const urls = cache.collectSessionImageUrls(message);
    if (urls.length) {
      const marked = await cache.markFilesCommitted(urls);
      if (marked.errors) this.options.logger.warn('mark image cache committed had errors', { sessionId: id, ...marked });
    }
    this.guard(context);
    return normalized as UserMessage | string;
  }
  private async originalSteerTransaction(context: TaskInvocationContext) {
    const database = await this.database, conversations = await this.conversations;
    return createMakerSteerTransaction({
          getDbClient: () => { this.guard(context); return database.getDbClient(); },
          assertReviewExternalInputAllowed: async sid => {
            const source = (await this.storage.get(sid))?.source ?? null;
            assertCindyMakeSessionAvailable(source);
            await assertReviewSessionExternalInputAllowed(sid, () => source);
          },
          maker: { getSession: sid => this.live.get(sid)?.maker.getSession(sid), getSessionMeta: sid => this.storage.get(sid) },
          log: this.options.logger,
          prepareUserMessageForAgent: (sid, input) => this.prepareOriginalInput(sid, input, context),
          readReplyQuoteNote: conversations.replyQuote.readReplyQuoteNote,
          readAutoReviewHistory: async sid => (await this.contextMessages(sid, Infinity)).map(row => ({ ...row, agentMeta: row.agentMeta ?? null })),
          getHostSourceDevice: () => ({ deviceId: this.options.deviceId ?? '' }),
          isMobileControllerInvoke: () => context.sourceDevice?.platform === 'mobile',
          isDeviceLinkInvoke: () => context.source === 'remote',
          getResolvedMainLocale: () => this.options.language?.() ?? 'en', wireNoteMemory: this.wireNoteMemory,
          readSessionSource: async sid => (await this.storage.get(sid))?.source ?? null,
          mcpAppModelContext: sid => this.mcpApps.runtime.mcpAppModelContext(sid),
          ...this.inputBoundary,
          publishUiSessionIntervention: sid => {this.uiSignals.publishUiSessionIntervention(sid);this.turnLifecycle.noteUserSend(sid); this.routes.recovery.runtime.cancelRecovery(sid); },
        });
  }
  private async sendMcpAppMessage(...args: Parameters<import('@cindy/app-runtime/mcp-apps/host').McpAppsHostDeps['sendMessage']>) {
    const sender=createAppMessageSender<TerminalTaskMeta>({
      owner:()=>this.dataClosed?undefined:this.ownerDatabase?.getCurrentDbClientSnapshot(),
      readClearBoundary:async id=>(await this.storage.get(id))?.clearedAt??null,
      restoreQueue:id=>this.inputCoordinator.ensureQueueRestored(id),
      clearBoundary:id=>this.inputCoordinator.getClearBoundaryMs(id),
      shouldQueue:id=>this.inputCoordinator.shouldQueueNewTurn(id)||this.routes.isLocked(id),
      getSessionMeta:id=>this.storage.get(id),createClientId:randomUUID,
      buildQueueItem:createSessionControlInputBuilder({buildCreateOptsForQueuedSession:async(_id,row:TerminalTaskMeta)=>({agentKind:row.agentKind,model:row.model,providerId:row.providerId,workingDir:row.workDir,remoteHostId:row.remoteHostId,agentDeviceId:row.agentDeviceId,effort:row.effort,fastMode:row.fastMode,permissionMode:row.permissionMode,planMode:row.planMode,orcaRole:row.orcaRole})}),
      enqueue:(id,item)=>{this.inputSessions.add(id);this.inputCoordinator.enqueue(id,item);},
      sendToAgentAccepted:(id,message,createOpts,sendOpts)=>this.sendNative(string(id),message,{source:'local'},sendOpts as AgentInputSendOpts | undefined,createOpts as AgentInputCreateOpts | undefined),
    });
    await sender(...args);
  }
  private async originalSendTransaction(context: TaskInvocationContext) {
    const runtime = await this.conversations;
    const database = await this.database;
    const guard = () => this.guard(context);
    const raw = async (id: string) => {
      guard();
      const [row] = await database.getDbClient().drizzle.select().from(persistedSessionRows).where(dbEq(persistedSessionRows.id, id)).limit(1);
      guard();
      return row;
    };
    const createOptions = async (id: string): Promise<MakerSessionCreateOpts> => {
      const row = await this.storage.get(id); guard();
      if (!row || row.deleted) throw new Error('TASK_NOT_FOUND');
      return { id, agentKind: row.agentKind, workingDir: row.workDir, title: row.title, model: row.model,
        providerId: row.providerId, agentDeviceId: row.agentDeviceId, remoteHostId: row.remoteHostId,
        effort: row.effort, permissionMode: row.permissionMode, fastMode: row.fastMode,
        planMode: row.planMode, resumeSessionId: row.sdkSessionId, orcaRole: row.orcaRole };
    };
    const synthesize: MakerSendTransactionDeps['synthesizeOrcaVendorOptionsFromDb'] = (id, opts) =>
      preparePersistedOrcaSessionStart(id, opts, {
        getSessionRole: sid => this.orcaStore.getSessionOrcaRole(sid),
        getWorkerLink: sid => this.orcaStore.getWorkerLink({ workerSessionId: sid }),
        getRemoteLead: async sid => (await this.storage.get(sid))?.orcaRemoteLead ?? null,
        warn: (message, fields) => this.options.logger.warn(message, fields),
      });
    return createMakerSendTransaction({
      previewUserPrompt: this.sessionActivity.bridge.notifyAgentIslandUserPrompt,
      dispatchUserPromptPreview: this.sessionActivity.bridge.dispatchAgentIslandUserPrompt,
      commitUserPromptPreview: this.sessionActivity.bridge.commitAgentIslandUserPrompt,
      rollbackUserPromptPreview: this.sessionActivity.bridge.rollbackAgentIslandUserPrompt,
      getSession: id => {
        guard(); const session = this.live.get(id)?.maker.getSession(id);
        if (!session || !context.sharedTask) return session;
        return new Proxy(session, { get(target, key) {
          if (key === 'send') return (message: Parameters<Session['send']>[0], opts: Parameters<Session['send']>[1]) => target.send(message, {
            ...opts, turnPermissionPolicy: { origin: { kind: 'desktop' }, confirmationSurface: 'desktop',
              autoReviewContext: { requesterAuthority: 'guest', source: 'group' }, forceConfirmToolCall: () => false },
          });
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      },
      closeSession: id => this.closeTask(id),
      getSessionMeta: id => this.storage.get(id),
      readAutoReviewHistory: async id => (await this.contextMessages(id, Infinity)).map(row => ({ ...row, agentMeta: row.agentMeta ?? null })),
      readScheduledPermissions: async id => { const row = await raw(id); return row ? { permissionMode: row.permissionMode, planModeEnabled: row.planModeEnabled } : null; },
      preflightBotRuntimeResources: async opts => {
        guard();
        if(this.bots&&this.botRuntimeDeps){await this.bots.runtime.hydrateBotProfileRuntime({...opts},this.botRuntimeDeps,{persistSnapshot:false});guard();}
        const resource = await this.capabilities.runtime({ workingDir: opts.workingDir ?? '', agentKind: opts.agentKind });
        await resource.close(); guard();
      },
      ensureRemoteReadyForSessionStart: async ({ session, createOpts }) => {
        guard();
        const remoteHostId=session?.remoteHostId??(createOpts as MakerSessionCreateOpts|undefined)?.remoteHostId;
        if(remoteHostId){
          const kind=session?.agentKind??(createOpts as MakerSessionCreateOpts|undefined)?.agentKind;
          if(!kind||!this.sshRuntime)throw new Error('SSH_AGENT_ROUTE_UNAVAILABLE');
          await this.sshRuntime.prepare(kind,remoteHostId);
        }
      },
      checkWorkDirExists:(...args)=>this.workdirs.check(...args),
      statDirectory:this.workdirs.statWorkingDirectory,
      resolveRecoveredWorkingDir:(id,dir)=>this.workdirs.recovery.resolve(id,dir),
      peekWorkingDirectoryRecoveryNote:(id,dir)=>this.workdirs.recovery.peek(id,dir),
      consumeWorkingDirectoryRecoveryNote:(id,note)=>this.workdirs.recovery.consume(id,note),
      readSessionWorkingDirFromDb: async id => (await raw(id))?.workingDir ?? null,
      readSessionWorkingDirState: async id => { const row = await raw(id); return { exists: !!row, workingDir: row?.workingDir ?? null }; },
      readSessionExtraDirsFromDb: async id => { const value = (await raw(id))?.extraDirs; return value ? JSON.parse(value) : []; },
      readSessionWritableDirsFromDb: async id => { const value = (await raw(id))?.writableDirs; return value ? JSON.parse(value) : []; },
      isOrcaMcpHydrated: id => this.live.get(id)?.didInjectOrcaInstructions === true,
      buildCreateOptsWithStderr: opts => ({ ...opts }),
      synthesizeOrcaVendorOptionsFromDb: synthesize,
      withRehydrateCloseSuppressed: (id, run) => this.withRehydrateCloseSuppressed(id, run),
      bootstrapSession: async opts => {
        if (!opts.id) throw new Error('TASK_ID_REQUIRED');
        const task = await this.ensureLive(opts.id); guard();
        return { session: task.session, didInjectOrcaInstructions: task.didInjectOrcaInstructions, didInjectProjectContext: false };
      },
      markOrcaRoleIfNeeded: async (id, role) => { if (role) await this.storage.update(id, { orcaRole: role }); },
      broadcastSessionCreated: id => this.emit('local-db:sessions:created', { sessionId: id }),
      prepareSendUserMessage: (id, message) => this.prepareOriginalInput(id, message, context),
      materializeDirectSendOssAttachments: this.attachments.materializeDirectSendOssAttachments,
      createDbMessage: (id, body, opts) => this.storage.writeUserMessage(id, body, opts),
      rewindPersistedUserMessageAfterClear: runtime.messages.rewindPersistedUserMessageAfterClear,
      readPiUserEntry: runtime.messages.readPiUserEntry,
      linkPiUserEntry: (id, clientId, piEntryId) => runtime.messages.patchMessageAgentMeta(id, clientId, { piEntryId }),
      reconcileCreateOptsWithDb: async (id, opts) => { Object.assign(opts, await createOptions(id)); },
      readWorkingDirectoryRecoveryCreateOpts: createOptions,
      peekPendingHandoff: id => this.taskContext.handoff.peek(id),
      consumePendingHandoff: id => this.taskContext.handoff.consume(id),
      peekGoalInactiveNote: id => this.taskContext.peekGoalInactiveNote(id),
      planRepeatableWireNotes: (id, notes, options) => this.wireNoteMemory.plan(id, notes, options),
      readTaskSource: async id => (await raw(id))?.source ?? null,
      isMobileClientInvoke: () => context.sourceDevice?.platform === 'mobile',
      isSessionRunningError: error => error instanceof Error && /SESSION_RUNNING/.test(error.message),
      assertBeforeVendorDispatch: () => guard(),
      log: this.options.logger,
    }, {
      ...this.channelSignals,
      getResolvedMainLocale: () => this.options.language?.() ?? 'en',
      mcpAppModelContext: id => this.mcpApps.runtime.mcpAppModelContext(id),
    });
  }
  private async sendNative(id: string, input: unknown, context: TaskInvocationContext, sendOpts?: AgentInputSendOpts, createOpts?: AgentInputCreateOpts) {
        this.cancelIdleReclaim(id);
        if (this.persistenceFaults.has(id)) throw new Error('TASK_HISTORY_WRITE_FAILED');
        if (this.sending.has(id) || this.turnLifecycle.running(id) || this.live.get(id)?.maker.getSession(id)?.isTurnRunning()) throw new Error('SESSION_RUNNING');
        const message: UserMessage = typeof input === 'string' ? { type: 'user', content: input }
          : input && typeof input === 'object' && (input as UserMessage).type === 'user' ? input as UserMessage
          : await this.message(id, input, context);
        const releaseRoute = await this.routes.acquireForSend(id, this.reconcileBotRoute?async()=>{await this.reconcileBotRoute!(id,true);return false;}:undefined, !!context.scheduler);
        try {
          // Parsing attachments and waiting for the route lane can outlive
          // another accepted turn. Recheck before appending a visible user row.
          if (this.sending.has(id) || this.turnLifecycle.running(id) || this.live.get(id)?.maker.getSession(id)?.isTurnRunning()) throw new Error('SESSION_RUNNING');
          await runSchedulerQueuedPreparation(sendOpts?.persistUserMessage?.clientId, this.schedulerPreparations,
            () => { if (sendOpts?.persistUserMessage?.clientId) this.schedulerDiscardWatchers.delete(sendOpts.persistUserMessage.clientId); });
          this.sending.add(id);
          let task = await this.ensureLive(id);
          this.guard(context);
          if(context.deliveryProof){await validateTaskDelivery(this.options.remoteInvoke,context.deliveryProof);this.guard(context);}
          if(context.plugin){if(!this.pluginSessions)throw new Error('PLUGIN_TASKS_UNAVAILABLE');await this.pluginSessions.assertDispatch(context.plugin.id,id);this.guard(context);}
          if (context.orca) { await assertRemoteWorkerAssignment(this.storage, id, context.orca); this.guard(context); }
          if (context.collaboration) { await assertTerminalOrcaInput(this.orcaStore, this.storage, id, context.collaboration); this.guard(context); }
          const agentMeta = context.collaboration ? { origin: context.collaboration.origin } : context.orca ? { origin: context.orca.origin } : context.plugin || context.targetPlugin ? {sourcePlugin:{pluginId:(context.plugin ?? context.targetPlugin)!.id,name:(context.plugin ?? context.targetPlugin)!.name}} : context.deliveryProof ? {origin:{kind:'session' as const,senderSessionId:`${context.deliveryProof.controllerDeviceId}::${context.deliveryProof.sessionId}`,senderSessionTitle:context.deliveryProof.senderTitle,displayText:context.deliveryProof.message}} : context.sender ? {origin:{kind:'session' as const,senderSessionId:context.sender.sessionId,senderSessionTitle:context.sender.title,displayText:inputPlainText(message)}} : context.scheduler ? { origin: context.scheduler } : context.sharedTask ? { sharedTaskAuthor: { sharedTaskId: context.sharedTask.sharedTaskId, sessionId: id, memberId: context.sharedTask.memberId, accountId: context.sharedTask.accountId, displayName: context.sharedTask.name ?? context.sharedTask.memberId } } : context.source === 'remote' && context.sourceDevice ? { sourceDevice: context.sourceDevice } : undefined;
          this.changes.assertCanDispatch(task.session.workDir);
          const historyMessage = terminalOrcaHistoryMessage(message, context.collaboration);
          const stored = { clientId: sendOpts?.persistUserMessage?.clientId ?? this.activeSubmissions.get(id) ?? randomUUID() };
          const sender = await this.originalSendTransaction(context);
          const row = await this.storage.get(id); this.guard(context);
          if (!row) throw new Error('TASK_NOT_FOUND');
          let changeSetStarted = false;
          let restoredOrcaReport = false;
          try {
            const result = await sender.sendToAgentAccepted(id, message, createOpts, {
              ...sendOpts,
              ...(context.scheduler ? { origin: context.scheduler } : {}),
              [AUTO_REVIEW_SOURCE_CONTENT]: message.content,
              ...(context.collaboration || context.orca || context.plugin || context.targetPlugin || context.sender || context.deliveryProof || context.sharedTask
                ? { [AUTO_REVIEW_DELEGATED_CONTINUATION]: true } : {}),
              ...(context.sourceDevice ? { sourceDevice: context.sourceDevice } : {}),
              fromDeviceLinkClient: context.source === 'remote',
              signal: context.signal,
              persistUserMessage: {
                ...sendOpts?.persistUserMessage,
                ...agentMeta, clientId: stored.clientId,
                content: sendOpts?.persistUserMessage?.content ?? (typeof historyMessage.content === 'string' ? historyMessage.content : JSON.parse(persistedInput(historyMessage))),
                delivery: 'turn', expectedClearBoundaryMs: sendOpts?.persistUserMessage?.expectedClearBoundaryMs ?? row.clearedAt ?? null,
                onPersisting: () => { this.guard(context); sendOpts?.persistUserMessage?.onPersisting?.(); },
                shouldBroadcast: () => { try { this.guard(context); return sendOpts?.persistUserMessage?.shouldBroadcast?.() ?? true; } catch { return false; } },
                onPersisted: async () => {
                  await sendOpts?.persistUserMessage?.onPersisted?.();
                  task = this.live.get(id) ?? task;
                this.guard(context);
                if (context.targetPlugin) await this.assertPluginTargetInput(id, stored.clientId);
                if (context.orca) await assertRemoteWorkerAssignment(this.storage, id, context.orca);
                if (context.collaboration) await assertTerminalOrcaInput(this.orcaStore, this.storage, id, context.collaboration);
                if(context.plugin){if(!this.pluginSessions)throw new Error('PLUGIN_TASKS_UNAVAILABLE');await this.pluginSessions.accept(context.plugin.id,id,stored.clientId!,{instanceId:task.session.instanceId,generation:task.session.getTurnGeneration()});this.guard(context);}
                this.turnLifecycle.noteUserSend(id);
                await this.changes.begin(task.session, stored.clientId!);
                changeSetStarted = true;
                if(!this.gitSnapshots.coordinator.hasPendingTurnStart(id))await this.gitSnapshots.coordinator.onTurnStart(id);
                if (context.collaboration || context.scheduler) {
                  if (context.collaboration) await assertTerminalOrcaInput(this.orcaStore, this.storage, id, context.collaboration);
                  const accepted = this.orcaDispatcher.runQueuedOrcaInterAgentAcceptedCallback(id, { clientId: stored.clientId! });
                  if (accepted) await accepted;
                  else if (context.collaboration?.source === 'lead' && this.orcaTeamService) {
                    // Callback closures cannot survive a process restart. The
                    // durable assignment restores the shared service's report ownership.
                    this.orcaTeamService.restoreWorkerPendingReport(id, context.collaboration);
                    restoredOrcaReport = true;
                  }
                  if (context.collaboration) await this.orcaTeamService?.handleWorkerTurnStarted(id);
                }
                this.guard(context);
                },
              },
            });
            if (context.collaboration || context.scheduler) {
              await this.orcaDispatcher.settleQueuedOrcaInterAgentAcceptedCallback(id,
                { persistUserMessage: { clientId: stored.clientId!, content: persistedInput(historyMessage), delivery: 'turn' } },
                result.outcome);
              if (!result.accepted && restoredOrcaReport) this.orcaTeamService?.clearAutoBridgeState(id);
            }
            if (!result.accepted && changeSetStarted) {this.changes.store.clearPendingTurnChangeSets(id);this.gitSnapshots.coordinator.onTurnAbort(id);}
            return result;
          } catch (error) {
            if (context.collaboration || context.scheduler) {
              await this.orcaDispatcher.rollbackQueuedOrcaInterAgentAcceptedCallback(id, stored.clientId);
              if (restoredOrcaReport) this.orcaTeamService?.clearAutoBridgeState(id);
            }
            if (changeSetStarted) {this.changes.store.clearPendingTurnChangeSets(id);this.gitSnapshots.coordinator.onTurnAbort(id);} throw error;
          }
        } finally { this.sending.delete(id); releaseRoute(); }
  }
  private runtimeProvider(id: string): string | null {
    return this.routes?.providers.hasSessionProvider(id) ? this.routes.provider(id) : this.live.get(id)?.selection.providerId ?? this.storage.peekProvider(id);
  }
  private async selection(input: Record<string, unknown>) {
    if(input.remoteHostId && input.agentKind==='codex') {
      if(input.agentDeviceId)throw new Error('CONFLICTING_EXECUTION_HOSTS');
      if(!this.options.ssh)throw new Error('SSH_RUNTIME_UNAVAILABLE');
      const providers=await this.options.ssh.codexProviders(string(input.remoteHostId));
      if(input.providerId && input.providerId!=='openai')throw new Error('SSH_CODEX_USES_REMOTE_NATIVE_CONNECTION');
      const provider=providers[0], model=provider?.models.codex?.find(model=>!input.model||model.id===input.model);
      if(!provider||!model)throw new Error('REMOTE_MODEL_ROUTE_UNAVAILABLE');
      const route=resolveRoute(providers,provider.id,model.id,'codex');
      if(!route)throw new Error('REMOTE_MODEL_ROUTE_UNAVAILABLE');
      return {selection:{agentKind:'codex' as const,providerId:provider.id,model:model.id,...(input.effort?{effort:input.effort as ModelSelection['effort']}:{})},route};
    }
    if (input.agentDeviceId) {
      if (!this.options.remoteInvoke) throw new Error('REMOTE_AGENT_UNAVAILABLE');
      const providers = await readDeviceProviderViews(this.options.remoteInvoke, string(input.agentDeviceId));
      const kinds = input.agentKind ? [input.agentKind as AgentKind] : [...ENGINES];
      for (const kind of kinds) {
        const provider = providers.find(p => p.connected && !p.suspended && (!input.providerId || p.id === input.providerId) && p.models[kind]?.some(m => !m.disabled && (!input.model ? m.defaultEnabled !== false : m.id === input.model)));
        const model = provider?.models[kind]?.find(m => !m.disabled && (!input.model ? m.defaultEnabled !== false : m.id === input.model));
        if (!provider || !model) continue;
        const route = resolveRoute(providers, provider.id, model.id, kind);
        if (route) return { selection: { agentKind: kind, providerId: provider.id, model: model.id, ...(input.effort ? { effort: input.effort as ModelSelection['effort'] } : {}) }, route };
      }
      throw new Error('REMOTE_MODEL_ROUTE_UNAVAILABLE');
    }
    if (input.model && input.providerId && input.agentKind) return this.models.select({ agentKind: input.agentKind, providerId: input.providerId, model: input.model, ...(input.effort ? { effort: input.effort } : {}) });
    if (input.agentKind && !input.model && !input.providerId) {
      const preferred = (await this.models.snapshot()).defaultSelection;
      if (preferred?.agentKind === input.agentKind) return this.models.select({ ...preferred, ...(input.effort ? { effort: input.effort } : {}) });
    }
    if (input.agentKind || input.providerId || input.model) {
      const providers = await this.models.views();
      const kinds = input.agentKind ? [input.agentKind as AgentKind] : [...ENGINES];
      for (const kind of kinds) {
        const provider = providers.find(p => p.connected && (!input.providerId || p.id === input.providerId) && p.models[kind]?.some(m => !m.disabled && (!input.model ? m.defaultEnabled !== false : m.id === input.model)));
        const model = provider?.models[kind]?.find(m => !m.disabled && (!input.model ? m.defaultEnabled !== false : m.id === input.model));
        if (provider && model) return this.models.select({ agentKind: kind, providerId: provider.id, model: model.id, ...(input.effort ? { effort: input.effort } : {}) });
      }
      throw new Error('MODEL_ROUTE_UNAVAILABLE');
    }
    return this.models.select();
  }
  private async admitTask(input: Record<string, unknown>, id: string, guard: () => void) {
    if (this.options.resolveExecutionRoute) { const execution = await this.options.resolveExecutionRoute(input, id); if (execution) input = { ...input, ...execution }; guard(); }
    let resolved = await this.selection(input);
    if (this.options.resolveExecutionRoute && !input.groupBinding) {
      const execution = await this.options.resolveExecutionRoute({ ...input, ...resolved.selection }, id);
      guard();
      if (execution) { input = { ...input, ...execution }; resolved = await this.selection(input); }
    }
    guard();
    const requestedCwd = input.workingDir ?? input.workDir ?? this.dialogueWorkspace.ensureDialogueWorkspaceDir(id,Date.now());
    if(!input.workingDir&&!input.workDir)input={...input,workspaceKind:'dialogue'};
    if (typeof requestedCwd !== 'string' || !(input.remoteHostId?path.posix:path).isAbsolute(requestedCwd)) throw new Error('WORKING_DIRECTORY_MUST_BE_ABSOLUTE');
    let cwd:string=requestedCwd;
    if(input.remoteHostId){
      if(input.agentDeviceId)throw new Error('CONFLICTING_EXECUTION_TARGETS');
      if(!this.options.ssh)throw new Error('SSH_AGENT_ROUTE_UNAVAILABLE');
      if(!input.workingDir&&!input.workDir)throw new Error('REMOTE_WORKING_DIRECTORY_REQUIRED');
      guard();const value=await this.options.ssh.statPath(string(input.remoteHostId),cwd);guard();
      if(value.kind!=='dir')throw new Error('WORKING_DIRECTORY_NOT_FOUND');
      cwd=value.resolvedPath;
    }else{
      if (!input.workingDir && !input.workDir) await privateDirectory(cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error('WORKING_DIRECTORY_NOT_FOUND');
    }
    guard();
    return { input, resolved, cwd };
  }
  channelRepository(config: ImOrchestratorConfig, namespace: ImSessionNamespace, options: { projectSwitching?: boolean } = {}) {
    const guard = () => this.guard({ source: 'local' });
    return createTerminalImSessionRepo({
      ready: this.ready, database: this.database, profileDir: this.options.profileDir, logger: this.options.logger,
      storage: this.storage, bindings: this.channelBindings, defaults: this.channelSessionDefaults,
      withSessionRouteLock: (id, task) => this.routes.withLock(id, task),
      assertCurrent: guard,
      retireDeletedPiSubagentState: id => this.sessions.deletion.retireDeletedPiSubagentState(id),
      admit: async (row, title) => {
        const { input, resolved, cwd } = await this.admitTask({ ...row, title, workingDir: row.workingDir }, row.id, guard);
        return { id: row.id, ...resolved.selection, workDir: cwd, title, permissionMode: permission(row.permissionMode), fastMode: row.fastMode, ...(input.agentDeviceId ? { agentDeviceId: string(input.agentDeviceId) } : {}),
      ...(input.remoteHostId?{remoteHostId:string(input.remoteHostId)}:{}), ...(input.groupBinding ? { groupBinding: input.groupBinding as import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding } : {}) };
      },
      changed: (row, kind) => {
        this.emit('terminal:tasks:changed', { sessionId: row.id });
        this.emit(`local-db:sessions:${kind}`, kind === 'created' ? { sessionId: row.id } : { sessionId: row.id, patch: this.guiSession(row) });
      },
    }, config, namespace, options);
  }
  private async create(input: Record<string, unknown>, guard: () => void, plugin?: {id:string;hidden?:boolean;onPersistenceStarted():void}, remoteWorker?: {id:string;lead:OrcaRemoteLead}, collaboration?: { id: string; role: 'worker' }) {
    const id = plugin?.id ?? remoteWorker?.id ?? collaboration?.id ?? (input.id === undefined ? randomUUID() : string(input.id));
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('INVALID_TASK_ID');
    const admitted = await this.admitTask(input, id, guard);
    const { resolved } = admitted;
    // Plugin task roots become authorization facts for later worker plans.
    // Persist their admitted identity, including macOS /var → /private/var.
    const cwd = plugin && !admitted.input.remoteHostId ? await realpath(admitted.cwd) : admitted.cwd;
    input = admitted.input;
    if (input.fastMode !== undefined && typeof input.fastMode !== 'boolean' && input.fastMode !== 'ultrafast') throw new Error('INVALID_ARGUMENT');
    if (input.thinkingEnabled !== undefined && typeof input.thinkingEnabled !== 'boolean') throw new Error('INVALID_ARGUMENT');
    guard(); plugin?.onPersistenceStarted();
    this.models.defaults.synchronize();
    const defaultTuning=this.models.defaults.cache.getNewMakerModelTuning(this.models.defaults.ownerScope,resolved.selection.agentKind,resolved.selection.providerId,resolved.selection.model);
    const fastMode=input.fastMode??defaultTuning.fastMode;
    const persist = () => this.storage.create({
      ...(plugin ? { source: 'plugin', hiddenAt: plugin.hidden ? Date.now() : null } : {}),
      ...(remoteWorker ? { orcaRemoteLead: remoteWorker.lead } : {}),
      ...(collaboration ? { orcaRole: collaboration.role } : {}),
      ...(input.workspaceKind === 'dialogue' || input.workspaceKind === 'project' ? { workspaceKind: input.workspaceKind } : {}),
      id, ...resolved.selection, workDir: cwd,
      ...(input.remoteHostId?{remoteHostId:string(input.remoteHostId)}:{}),
      ...(this.worktrees?.manager.getForSession(id)?.path ? { worktreePath: this.worktrees.manager.getForSession(id)!.path } : {}),
      title: typeof input.title === 'string' ? input.title : typeof this.options.defaultTitle === 'function' ? this.options.defaultTitle() : this.options.defaultTitle ?? DEFAULT_DRAFT_SESSION_TITLE,
      permissionMode: input.permissionMode ? permission(input.permissionMode) : 'default',
      ...(typeof input.planMode === 'boolean' ? { planMode: input.planMode } : {}),
      ...(fastMode !== undefined ? { fastMode: fastMode as boolean | 'ultrafast' } : {}),
      ...(typeof input.thinkingEnabled === 'boolean' ? { thinkingEnabled: input.thinkingEnabled } : {}),
      ...(input.agentDeviceId ? { agentDeviceId: string(input.agentDeviceId) } : {}),
      ...(input.groupBinding ? { groupBinding: input.groupBinding as TerminalTaskMeta['groupBinding'] } : {}),
    }, guard);
    if (this.worktrees) await this.worktrees.cancellation.withPrecreatedSessionOperationLock(id, async () => { guard(); this.worktrees!.manager.assertPrecreatedSessionNotCancelled(id); await persist(); });
    else await persist();
    guard();
    if(input.groupBinding)this.groupBindings.set(id,input.groupBinding as import('@cindy/remote-agent/groups/bindings').ProviderGroupBinding);
    guard();
    await this.ensureLive(id, resolved);
    this.emit('terminal:tasks:changed', { sessionId: id });
    return this.view((await this.storage.get(id))!);
  }
  private restoreSessionInteraction(session: Session) {
    installDesktopInteractionHandler(session,(request,shared)=>this.interaction(session.id,request,undefined,shared),(sourceRequestId,decision)=>{
      for(const pending of this.pending.values())if(pending.sessionId===session.id&&pending.sourceRequestId===sourceRequestId){pending.settle(decision);return true;}
      return false;
    });
  }
  private async prepareNativeSessionOptions(id: string, options: MakerSessionCreateOpts): Promise<boolean> {
    const bootstrap = this.orcaBootOptions.get(id);
    if (bootstrap?.vendorOptions) options.vendorOptions = {...options.vendorOptions, ...bootstrap.vendorOptions};
    const didInject = await preparePersistedOrcaSessionStart(id, options, {
      getSessionRole: taskId => this.orcaStore.getSessionOrcaRole(taskId),
      getWorkerLink: taskId => this.orcaStore.getWorkerLink({workerSessionId: taskId}),
      getRemoteLead: async taskId => (await this.storage.get(taskId))?.orcaRemoteLead ?? null,
      warn: (message, fields) => this.options.logger.warn(message, fields),
    });
    const database = await this.database;
    const storage = createOriginalSessionStorage(() => {this.guard({source: 'local'}); return database.getDbClient();});
    const extraDirs = await storage.readSessionExtraDirsFromDb(id);
    if (extraDirs.length) options.extraDirs = extraDirs;
    return didInject;
  }
  private async createNativeControlAgent(id: string, selection: {model?: string; providerId?: string | null} = {}, historicalCodex = false): Promise<BaseAgent> {
    this.guard({source: 'local'});
    const row = await this.storage.get(id);
    if (!row || row.deleted || !historicalCodex && row.agentKind !== 'codex') throw new Error('TASK_NOT_FOUND');
    const chosen = await this.selection({...row, ...selection, agentKind:'codex'});
    const binary = this.binaries.get('codex');
    if (!binary && !row.remoteHostId) throw new Error('ENGINE_NOT_INSTALLED');
    this.guard({source: 'local'});
    return (this.options.createAgent ?? createTerminalAgent)({ piRuntimeOwner: this.piRuntimeOwner,
      profileDir: this.options.profileDir, taskId: id, ...chosen,
      binaryPath: binary ?? terminalNodeExecutable(), models: this.models, logger: this.options.logger,
      remoteHostId: row.remoteHostId, ssh: this.options.ssh, sshRuntime: this.sshRuntime,
      codexHistory: this.nativeHistory.codex,
    });
  }
  private initializeModelSelection(database: NodeDatabase, conversations: TerminalConversations) {
    const guard = () => this.guard({source: 'local'});
    const prepared = new WeakMap<MakerSessionCreateOpts, boolean>();
    const rehydrateColdPiRuntimeForWindowVerification = createColdPiRehydrationForWindowVerification({
      hasLiveSession: id => !!this.live.get(id)?.maker.getSession(id),
      loadSessionRow: async id => {guard(); return (await database.getDbClient().drizzle.select().from(persistedSessionRows).where(dbEq(persistedSessionRows.id, id)).limit(1))[0];},
      buildCreateOpts: (id, row): MakerSessionCreateOpts => ({id, agentKind: 'pi', workingDir: row.workingDir,
        model: row.model, providerId: row.providerId, effort: (row.effort ?? undefined) as MakerSessionCreateOpts['effort'],
        fastMode: row.fastMode ?? false, permissionMode: permission(row.permissionMode), planMode: !!row.planModeEnabled,
        title: row.title ?? undefined, resumeSessionId: row.sdkSessionId}),
      checkWorkDirExists: (...args) => this.workdirs.check(...args),
      prepareCreateOpts: async (id, options) => {prepared.set(options, await this.prepareNativeSessionOptions(id, options));},
      bootstrapSession: async options => {
        const id = options.id!;
        this.preparedSessionStarts.set(id, {options, didInjectOrcaInstructions: prepared.get(options)!});
        try {await this.ensureLive(id);} finally {this.preparedSessionStarts.delete(id);}
      },
    });
    const service = createTerminalModelSelection({tasks: this, database, conversations, control: this.runtimeControl,
      axes: this.runtimeAxes, log: this.options.logger, guard, invocation: () => this.currentInvocation(),
      remoteInvoke: this.options.remoteInvoke, createControlAgent: (id, selection) => this.createNativeControlAgent(id, selection),
      maker: {getSession: id => this.live.get(id)?.maker.getSession(id), getSessionMeta: id => this.storage.get(id),
        listActiveSessions: () => [...this.live.values()].flatMap(task => task.maker.listActiveSessions()),
        closeSession: id => this.closeTask(id),
        closeSessionIfCurrent: (session, reason, options) => this.live.get(session.id)?.maker.closeSessionIfCurrent(session, reason, options) ?? Promise.resolve()},
      readSessionRuntimeProfiles: this.runtimeRecovery.readProfiles,
      profileDir: this.options.profileDir, binaryPath: kind => this.binaries.get(kind) ?? undefined,
      currentOwnerSession: () => this.options.currentOwnerSession?.() ?? {dataOwnerId: null, generation: 0},
      isSessionInTurn: id => this.eventRuntime.activity.isSessionInTurn(id),
      wakeSessionInputAfterCredentialSwitch: id => this.inputCoordinator.wakeSession(id, 'credential-switch-applied-inline'),
      withRehydrateCloseSuppressed: (id, run) => this.withRehydrateCloseSuppressed(id, run),
      getSessionLastLiveUsage: this.lastLiveUsage.getSessionLastLiveUsage,
      rehydrateColdPiRuntimeForWindowVerification,
      getCodexProxyAuthInjectionState: id => [...this.codexProviderRoutes.values()].find(entry => entry.sessionId === id)?.authInjection ?? null,
      persistSessionFields: this.sessions.service.persistSessionFields,
      recordSessionContextSnapshot: this.usage.recordSessionContextSnapshot,
      listSshCodexProviders: id => {if (!this.options.ssh) throw new Error('SSH_RUNTIME_UNAVAILABLE'); return this.options.ssh.codexProviders(id);},
      assertModelRouteUsable: async (kind, model, providerId, remoteHostId) => {
        if (kind === 'codex' && remoteHostId) return (await this.selection({agentKind: kind, model, providerId, remoteHostId})).selection.providerId;
        const verdict = await this.models.routeVerdict.verdictForModelRoute(kind, model, providerId);
        guard();
        if (verdict.kind === 'reject') throwIpcError('INVALID_PARAMS', describeModelRouteRejection(verdict.reason, model, providerId));
        return verdict.kind === 'reroute' ? verdict.providerId : undefined;
      },
    });
    this.routes.connectModelSelection(service, this.runtimeControl);
  }
  private initializeSessionBindings() {
    const events=this.eventRuntime, conversations=this.conversationRuntime;
    this.sessionBindings=createSessionBindingLifecycle({
      log:this.options.logger,
      restoreInteractionListener:session=>this.restoreSessionInteraction(session),
      beforeReplace:session=>this.runtimeRecovery.leases.release(session),
      onBind:session=>{this.runtimeRecovery.leases.bindContinuationOnlyAutoResumeLease(session);this.installTaskInteractionObserver(session);},
      broadcastStatus:(session,status)=>this.emit('maker:status-changed',{sessionId:session.id,status}),
      captureCloseContext:session=>{
        this.lastLiveUsage.rememberSessionLastLiveUsage(session.id, session.getUsageSnapshot());
        const closeReason=this.live.get(session.id)?.maker.getSessionCloseReason(session)??'unexpected';
        const preserveAutoResumeIntent=this.runtimeRecovery.leases.shouldPreserveContinuationOnlyAutoResume(session,closeReason)
          ||this.runtimeRecovery.leases.shouldPreserveSessionRuntimeFallbackAutoResume(session,closeReason)
          ||(closeReason==='unexpected'&&session.wasClosedByRuntime()&&this.inputCoordinator.hasUsageLimitRecovery(session.id));
        this.runtimeRecovery.leases.release(session);
        return {closeReason,preserveAutoResumeIntent};
      },
      cleanupClosedSession:(session,context)=>{
        const id=session.id,requestId=this.activeSubmissions.get(id);
        this.taskActionConfirm.cleanupForSession(id,'session_closed');
        if(requestId&&!context.preserveAutoResumeIntent&&!this.routeClosures.has(id)){
          this.activeSubmissions.delete(id);this.externalSubmissions.delete(id);
          void this.updateReceipt(id,requestId,'interrupted','SESSION_CLOSED',this.submissionText.get(id))
            .catch(()=>this.options.logger.warn('Closed task receipt could not be persisted',{sessionId:id}));
          this.submissionText.delete(id);
        }
        runSessionCloseCleanup(context.preserveAutoResumeIntent,{
          cleanupInteractions:()=>{for(const pending of [...this.pending.values()])if(pending.sessionId===id)pending.settle(decisionForDismissal(pending.request));},
          preserveAutoResume:()=>this.options.logger.info('Preserving original automatic continuation across native replacement',{sessionId:id}),
          resetAutoResume:()=>{events.interrupted.noteSessionReset(id);events.bookkeeping.teardown(id);this.usageWaits?.usageLimitAutoResume.noteSessionClosed(id);},
          shouldPreserveInputBoundary:()=>this.routeClosures.has(id),
          closeInputCoordinator:options=>this.inputCoordinator.onSessionClosed(id,{...options,wakeQueuedInput:!this.closed&&context.closeReason==='unexpected'&&session.wasClosedByRuntime()}),
          cleanupRuntimeState:()=>{
            this.routes.credentials.onSessionClosed(id);
            this.eventBindings.deferredCodexRestart?.onSessionSettled();this.eventBindings.gatewayCodexRestart?.onSessionSettled();
            this.inputCoordinator.onExternalTurnSettled(id);
            try{this.eventBindings.refreshRemoteCodexMcp?.(id);}catch(error){this.options.logger.warn('Remote MCP refresh failed during session close',{sessionId:id,error:String(error)});}
            this.gitSnapshots?.coordinator.onSessionClosed(id);
            events.deps.lastReportedCostUsdBySession.delete(id);events.deps.lastReportedModelUsageBySession.delete(id);
            events.deps.turnModelPromiseBySession.delete(id);events.deps.turnUsageContextBySession.delete(id);
            this.turnLifecycle.wallClock.clear(id);this.turnLifecycle.usageTargets.clear(id);events.claudeOutputLagTimingGuard.clear(id);
            events.claudeActivity.clearClaudeSessionBackgroundActivity(id);
            conversations.persistence.clearSessionPersistState(id);
            conversations.subagentFence.clearSubagentObservationRewindState(id);
            this.sessionActivity.bridge.handleAgentIslandSessionClosedAfterCleanup(id,'process-closed');
          },
        });
      },
      beforeCloseTeardown:session=>{events.compact.clearForClosedSession(session);events.deps.pendingFailedTurnAssistantPersistId.delete(session.id);},
      finalizeClosedSession:session=>{
        events.activity.deleteSession(session.id);
        conversations.activeTurn.markSessionTurnEndedOnClose(session.id);
      },
    });
  }
  private ensureLive(id: string, resolved?: { selection: ModelSelection; route: ResolvedRoute; modelRevision?: number }): Promise<LiveTask> {
    const reclaim = this.idleReclaims.get(id);
    if (reclaim) return reclaim.then(() => this.ensureLive(id, resolved));
    const existing = this.live.get(id);
    if (existing && existing.session.getStatus() === 'active' && (existing.session.isTurnRunning() || existing.capabilityRevision===this.capabilities.revision() && existing.modelRevision===this.models.revision())) return Promise.resolve(existing);
    const starting = this.starts.get(id);
    if (starting) return starting;
    const result = this.start(id, resolved);
    this.starts.set(id, result);
    void result.finally(() => { this.starts.delete(id); this.scheduleIdleReclaim(id); }).catch(() => undefined);
    return result;
  }
  private async withRehydrateCloseSuppressed<T>(id: string, run: () => Promise<T>): Promise<T> {
    const previous = this.routeClosures.has(id); this.routeClosures.add(id);
    try { return await run(); } finally { if (!previous) this.routeClosures.delete(id); }
  }
  private async start(id: string, resolved?: { selection: ModelSelection; route: ResolvedRoute; modelRevision?: number }): Promise<LiveTask> {
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    const row = await this.storage.get(id);
    if (!row) throw new Error('TASK_NOT_FOUND');
    const persistedWorkingDir=row.workDir;
    const workspaceOptions:MakerSessionCreateOpts=this.preparedSessionStarts.get(id)?.options??{id,agentKind:row.agentKind,model:row.model,workingDir:row.workDir,remoteHostId:row.remoteHostId};
    await this.bots?.workspace.prepareBotWorkspaceRuntime(workspaceOptions);
    row.workDir=workspaceOptions.workingDir??row.workDir;
    row.remoteHostId=workspaceOptions.remoteHostId;
    if(!row.remoteHostId){
      row.workDir=this.workdirs.recovery.resolve(id,row.workDir);
      await this.workdirs.recovery.observe(id,row.workDir).catch(error=>this.options.logger.warn('Working directory observation failed',{sessionId:id,code:(error as {code?:unknown})?.code}));
    }
    const previous = this.live.get(id);
    // Retiring an idle/dead runtime is part of the accepted input's recovery.
    // Preserve its queue and boundary just as the original lazy bootstrap does.
    if (previous) await this.withRehydrateCloseSuppressed(id, () => this.closeTask(id));
    if (!resolved && row.groupBinding && this.options.resolveExecutionRoute) { const execution=await this.options.resolveExecutionRoute({agentDeviceId:row.agentDeviceId,providerId:row.providerId!,model:row.model,agentKind:row.agentKind,groupBinding:row.groupBinding},id); if (!execution) throw new Error('GROUP_UNAVAILABLE'); resolved=await this.selection(execution); }
    const chosen = resolved ?? await this.selection({ remoteHostId:row.remoteHostId, agentDeviceId: row.agentDeviceId, agentKind: row.agentKind, providerId: row.providerId, model: row.model, ...(row.effort ? { effort: row.effort } : {}) });
    const modelRevision = 'modelRevision' in chosen && typeof chosen.modelRevision === 'number' ? chosen.modelRevision : this.models.revision();
    if (modelRevision !== this.models.revision() || this.models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
    const binary = this.binaries.get(chosen.selection.agentKind);
    if(row.remoteHostId){if(!this.sshRuntime)throw new Error('SSH_AGENT_ROUTE_UNAVAILABLE');await this.sshRuntime.prepare(chosen.selection.agentKind,row.remoteHostId);}
    if (!binary && !row.agentDeviceId && !row.remoteHostId) throw new Error('ENGINE_NOT_INSTALLED');
    if (!row.remoteHostId && this.worktrees?.runtime.managedWorktreeRoot(row.workDir)) {
      const readiness = await this.worktrees.restore.getManagedWorktreeReadinessForSession(id, row.workDir);
      if (readiness !== 'ready') throw new Error(readiness === 'gone' ? 'WORKTREE_GONE' : 'WORKTREE_RECOVERY_PENDING');
    }
      const defaultOptions: MakerSessionCreateOpts = { id, agentKind: chosen.selection.agentKind, workingDir: row.workDir, title: row.title, ...(row.remoteHostId?{remoteHostId:row.remoteHostId}:{}), ...(row.agentDeviceId ? { agentDeviceId: row.agentDeviceId } : {}), model: chosen.selection.model, providerId: chosen.selection.providerId, effort: chosen.selection.effort, permissionMode: row.permissionMode, fastMode: row.fastMode, planMode: row.planMode, thinkingEnabled: row.thinkingEnabled, vendorOptions: this.channelBindings.store.findByTarget(id) ? undefined : this.channelOrchestrators.vendorOptionsForSession(id) ?? this.channelVendorOptions.get(id), ...(row.sdkSessionId ? { resumeSessionId: row.sdkSessionId } : {}) };
      const prepared = this.preparedSessionStarts.get(id);
      const createOptions = prepared?.options ?? defaultOptions;
      const didInjectOrcaInstructions = prepared?.didInjectOrcaInstructions ?? await this.prepareNativeSessionOptions(id, createOptions);
    if(workspaceOptions.workspaceKind)createOptions.workspaceKind=workspaceOptions.workspaceKind;
    const botSnapshot=this.bots&&this.botRuntimeDeps?await this.bots.runtime.hydrateBotProfileRuntime(createOptions,this.botRuntimeDeps):null;
    let botFailureStage:'prepare'|'agent-start'|'storage'='prepare';
    try {
    const capability = await this.capabilities.runtime({workingDir:row.workDir,agentKind:chosen.selection.agentKind,remoteHostId:row.remoteHostId});
    const knowledge = await this.knowledge?.createRuntime({ sessionId: id, workingDir: row.workDir, agentKind: chosen.selection.agentKind, remoteHostId:row.remoteHostId },
      botSnapshot&&this.botMemory&&createOptions.makerMemoryScopeKey?{memory:this.botMemory,scopeKey:createOptions.makerMemoryScopeKey,assertCurrent:async()=>{this.guard({source:'local'});const owner=(await this.database).getDbClient();const [profile]=await owner.drizzle.select({status:botProfileRows.status}).from(botProfileRows).where(dbEq(botProfileRows.id,botSnapshot.botId)).limit(1);if(profile?.status!=='active')throw new Error('BOT_SESSION_INACTIVE');}}:undefined);
    let lease:LiveTask|undefined,revoked=false;
    let reviewAbort=new AbortController();
    const isCurrent=()=>!this.closed&&!revoked&&(!lease||this.live.get(id)===lease);
    const assertCurrent=()=>{if(!isCurrent())throw new Error('TASK_PLUGIN_SCOPE_REVOKED');};
    const instanceId=()=>{assertCurrent();if(!lease)throw new Error('TASK_NOT_READY');return lease.session.instanceId;};
    let plugin:TerminalPluginTask|undefined;
    try{plugin=await this.pluginFactory?.({sessionId:id,workingDir:row.workDir,source:row.source,instanceId,assertCurrent,snapshot:()=>this.pluginPermissionSnapshot(id,instanceId()),confirm:(payload,signal)=>this.requestPluginWrite(id,payload,signal)});}
    catch(error){await knowledge?.close();await capability.close();throw error;}
    let tools: Awaited<ReturnType<typeof createTaskTools>>;
    try { tools = await createTaskTools({ memoryScopeKey:knowledge?.scopeKey,pluginRegistry:this.builtinTools,getVendorOptions:()=>createOptions.vendorOptions, getSession: sid => this.live.get(sid)?.maker.getSession(sid), providerAllowed:name=>isBotMcpServerAllowed(createOptions.botRuntimeProfile?.mcpPolicy,name), factoryCapabilities: capability.factoryCapabilities, logger: this.options.logger, sessionId: id, workingDir: row.workDir, agentKind: chosen.selection.agentKind,
      extraProviders: [...this.deviceTools.providers,...(knowledge?.providers??[]),this.orcaTools.provider, row.orcaRemoteLead && this.options.remoteInvoke ? createOrcaRemoteWorkerMcpProvider(async (context, tool, args) => {
        assertCurrent();
        if (context.sessionId !== id || !lease || context.sessionInstanceId !== lease.session.instanceId) throw new Error('TASK_MCP_SCOPE_MISMATCH');
        const result = await this.remoteWorkerForwarder.forwardTool(context, tool, args);
        assertCurrent(); return result;
      }, this.options.logger) : this.localWorkerMcpProvider(id)],
      appServerIds:capability.appServerIds,
      extraFactories: {...capability.factories,...plugin?.factories,...this.channelTools?.(() => {
        if (!isCurrent()) throw new Error('TASK_TOOLS_REVOKED');
        const session = this.live.get(id)?.maker.getSession(id);
        if (!session) throw new Error('TASK_NOT_ACTIVE');
        return { sessionId: id, sessionInstanceId: session.instanceId, workingDir: row.workDir, agentKind: chosen.selection.agentKind, vendorOptions: { ...createOptions.vendorOptions, source: row.source, ...(row.source === 'feishu' && row.imUserId ? { feishuChatId: row.imUserId } : {}) } };
      }, { source: row.source })},
      isCurrent,
      scheduler: this.schedulerDeps,
      helper: this.helperDeps({sessionId:id,workingDir:row.workDir,agentKind:chosen.selection.agentKind,title:()=>row.title}),
    }); } catch(error) { revoked=true;reviewAbort.abort();plugin?.close();await knowledge?.close(); await capability.close(); throw error; }
    applyBotRuntimeToolPolicy({options:createOptions,snapshot:botSnapshot,
      disabledPluginIds:this.builtinTools.getDisabledRuntimePluginIds(row.workDir),providers:tools.providers});
    const reviewAutoPermissionAction=this.permissionReviewer(assertCurrent,async request=>{
      const current=await this.storage.get(id);
      if(!current||current.deleted||current.archived||current.workDir!==persistedWorkingDir||request.sessionId&&request.sessionId!==id)throw new Error('TASK_AUTHORITY_CHANGED');
      const {delegatedTask:_delegation,authorizationError:_error,...ordinary}=request;
      // Plugin-created tasks require their own live receipt; never reinterpret
      // a lost delegation as authority from the owner of an ordinary task.
      const workerLink = current.orcaRole === 'worker' ? await this.orcaStore.getWorkerLink({ workerSessionId: id }) : null;
      const pluginOwned = current.source === 'plugin' || workerLink && (await this.storage.get(workerLink.leadSessionId))?.source === 'plugin';
      if(pluginOwned)return this.pluginSessions ? this.pluginSessions.review(ordinary) : {...ordinary,authorizationError:'The plugin task authorization receipt is unavailable.'};
      return ordinary;
    },()=>reviewAbort.signal);
    let agent;
    try { agent = await (this.options.createAgent ?? createTerminalAgent)({ piRuntimeOwner: this.piRuntimeOwner, runtimeAxes: this.runtimeAxes, registerCodexProviderRoutes: routes => { const key = randomUUID(); this.codexProviderRoutes.set(key, {sessionId: id, routes, authInjection: 'env-key'}); return () => this.codexProviderRoutes.delete(key); }, codexHistory: this.nativeHistory.codex, proxyObservation:this.eventRuntime.proxyObservation(id,chosen.route,chosen.selection.agentKind), reviewAutoPermissionAction, profileDir: this.options.profileDir, taskId: id, selection: chosen.selection, route: chosen.route, binaryPath: binary ?? terminalNodeExecutable(), models: this.models, logger: this.options.logger, tools, turnChangeCapture: this.changes.capture, taskShellEnv:()=>this.options.protectedInput?.envFor(id)??{}, remote: Boolean(row.agentDeviceId), remoteHostId:row.remoteHostId,ssh:this.options.ssh,sshRuntime:this.sshRuntime,capabilities:capability,getGhostRosterPrompt:plugin?.getGhostRosterPrompt, memory: knowledge?.memory, contactsEnabled: knowledge?.contactsEnabled, getContactsPromptState: () => this.knowledge?.snapshot().contacts ? 'enabled' : 'disabled' }); } catch (error) { revoked=true;reviewAbort.abort();plugin?.close();await tools.close(); await knowledge?.close(); await capability.close(); throw error; }
    const startDeviceAgentSession = row.agentDeviceId && this.options.remoteInvoke ? createDeviceAgentStarter({ captureKnownFileBefore: this.changes.capture.beforeKnownFileWrite, noteOpaqueTurnChange: this.changes.capture.noteOpaqueWrite, remoteInvoke: this.options.remoteInvoke, rgPath: () => 'rg', codexPath: () => this.binaries.get('codex') ?? undefined, mcpProviders: () => tools.providers, prepareMcpBridge: async (_providers, _logger, context) => tools.pi(context), makerMemory: () => knowledge?.memory, logger: this.options.logger }) : undefined;
    let runtimeWorktreeLease: WorktreeRuntimeLease | null = null;
    const maker = new Maker({ agents: { [chosen.selection.agentKind]: agent }, storage: this.storage, logger: this.options.logger, ...(knowledge ? {makerMemory:knowledge.memory} : {}), ...(startDeviceAgentSession ? { startDeviceAgentSession } : {}) });
    const stopObservingMaker = maker.on(event => {
      for (const observer of this.makerObservers) {
        try { observer(event); } catch { this.options.logger.warn('Channel task lifecycle observer failed'); }
      }
    });
    try {
      if (modelRevision !== this.models.revision() || this.models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
      assertCurrent();
      if (this.worktrees) {
        runtimeWorktreeLease = await this.worktrees.runtime.acquireWorktreeRuntimeLease(id, row.workDir);
        assertCurrent(); this.worktrees.manager.assertPrecreatedSessionNotCancelled(id);
      }
      botFailureStage='agent-start';
      const session = await maker.createSession(createOptions);
      botFailureStage='storage';
      if(botSnapshot)await this.bots!.runtime.markBotProfileRuntimeApplied(botSnapshot);
      this.wireNoteMemory.reset(id);
      if (modelRevision !== this.models.revision() || this.models.isMutating()) throw new Error('MODEL_CONFIGURATION_CHANGED');
      const task: LiveTask = { didInjectOrcaInstructions, cancelReview:()=>{reviewAbort.abort();reviewAbort=new AbortController();}, revoke:()=>{revoked=true;reviewAbort.abort();plugin?.close();},plugin,capabilityRevision:capability.revision,modelRevision, maker, agent, session, selection: chosen.selection, dispose: [() => {revoked=true;reviewAbort.abort();plugin?.close();}, () => tools.close(), () => knowledge?.close(), () => capability.close()] };
      lease=task;this.live.set(id, task);
      this.restoreSessionInteraction(session);
      const binding=this.sessionBindings.beginBinding(session)!;
      this.bindPluginEvents(task);
      binding.disposers.push(this.turnLifecycle.bind(session));
      (await this.conversations).persistence.noteSessionAgentKind(id,makerToDbAgentKind(session.agentKind));
      binding.disposers.push(session.onEvent(event => this.onEvent(id, event)));
      this.sessionBindings.attachStatusListener(binding);
      if (runtimeWorktreeLease) { const worktreeLease = runtimeWorktreeLease, worktrees = this.worktrees!; task.dispose.push(() => worktrees.runtime.releaseWorktreeRuntimeLease(worktreeLease)); }
      task.dispose.push(stopObservingMaker);
      if (this.closed) { await this.closeTask(id); throw new Error('TASK_HOST_CLOSED'); }
      return task;
    } catch (error) { revoked=true;reviewAbort.abort();plugin?.close();try { await maker.shutdown(); if (runtimeWorktreeLease) await this.worktrees!.runtime.releaseWorktreeRuntimeLease(runtimeWorktreeLease); } finally { stopObservingMaker(); } await tools.close(); await knowledge?.close(); await capability.close(); throw error; }
    }catch(error){
      if(botSnapshot)await this.bots!.runtime.markBotProfileRuntimeFailed(botSnapshot,{stage:botFailureStage,error}).catch(cause=>this.options.logger.warn('Bot startup failure could not be recorded',{sessionId:id,error:String(cause)}));
      throw error;
    }
  }

  private onEvent(id: string, event: AgentEvent) {
    const session=this.live.get(id)?.maker.getSession(id);
    if(!session||this.dataClosed||this.eventRuntime.guards.isFencedStaleSessionTerminal(id,event))return;
    this.changes.store.noteTurnDiffEvent(id,event,session.remoteHostId!==null);
    const requestId=this.activeSubmissions.get(id);
    if(requestId&&event.sessionInstanceId&&typeof event.sessionTurnGeneration==='number')
      this.legacyExecutionReceipts.set(`${id}:${event.sessionInstanceId}:${event.sessionTurnGeneration}`,requestId);
    this.eventRuntime.handle(session,event);
    // Original overflow recovery may rebuild an externally dispatched task but
    // deliberately leaves retry to its sender. Settle that sender's legacy
    // acknowledgement from the native terminal, independently of GUI suppression.
    if (requestId && this.externalSubmissions.get(id) === requestId && isTerminalTurnErrorEvent(event) && isContextOverflowErrorData(event.data))
      void this.settleLegacyProductTurn(id, 'failed', captureProductTurnFailureOwner(session, event));
    for(const observer of this.taskObservers.get(id)??[])observer(event);
    // Legacy internal submission receipts are transport acknowledgements. The
    // shared event pipeline exclusively owns transcript writes and GUI pushes.
    if(requestId&&event.turnScope!=='background'&&event.type==='text'){
      const data=event.data as {text?:string;isFinal?:boolean};
      this.submissionText.set(id,data.isFinal===true?data.text??'':(this.submissionText.get(id)??'')+(data.text??''));
    }
  }
  private async settleLegacyProductTurn(id:string,status:'completed'|'failed',owner?:ProductTurnFailureOwner) {
    // Silent-stop continuation still owns the logical request until its actual
    // reply or exhaustion. Failed turns must still settle during native teardown.
    if (status === 'completed' && this.turnLifecycle.running(id)) return;
    // The shared pipeline calls this only after recovery ownership has settled.
    // An error without a paired done still holds the native lease briefly; it
    // must not strand the exact failed execution's transport acknowledgement.
    const key=owner?`${id}:${owner.instanceId}:${owner.generation}`:undefined;
    const requestId=key?this.legacyExecutionReceipts.get(key):undefined;
    if(key)this.legacyExecutionReceipts.delete(key);
    await this.conversationRuntime.persistence.drainPersistQueue();
    if(requestId&&this.activeSubmissions.get(id)===requestId){
      this.activeSubmissions.delete(id);this.externalSubmissions.delete(id);
      await this.updateReceipt(id,requestId,status,status==='failed'?'TURN_FAILED':undefined,this.submissionText.get(id));
      this.submissionText.delete(id);
    }
    setImmediate(()=>this.drain(id));
    this.scheduleIdleReclaim(id);
  }
  private installTaskInteractionObserver(session:Session,plugin?:Parameters<typeof installInteractionLifecycleObserver>[1]){
    installInteractionLifecycleObserver(session,{
      onStart:(request,route)=>{plugin?.onStart?.(request,route);void this.botDelegations?.handleInteractionStart(session.id,request).catch(error=>this.options.logger.warn('Failed to project task interaction',{error:String(error)}));},
      onEnd:(request,route)=>{plugin?.onEnd?.(request,route);void this.botDelegations?.handleInteractionEnd(session.id,request).catch(error=>this.options.logger.warn('Failed to clear task interaction',{error:String(error)}));},
    });
  }
  async restartOriginalBotRuntime(id:string,assertCurrent:()=>void){
    await restartBotRuntime(id,assertCurrent,{
      stopInput:sessionId=>{
        this.conversationRuntime.persistence.flushAssistantBlock(sessionId);
        this.conversationRuntime.persistence.flushOrphanToolResults(sessionId,null);
        this.turnLifecycle.guard.noteSessionReset(sessionId);this.eventRuntime.interrupted.noteSessionReset(sessionId);this.eventRuntime.bookkeeping.teardown(sessionId);
        this.routes.recovery.runtime.cancelRecovery(sessionId);
        this.inputCoordinator.stop(sessionId,{keepQueue:true,pauseQueue:true,resumeOnUserInput:true});
      },
      withSessionLock:this.routes.locks.withSessionRestartLock,
      rebuild:async(sessionId,current,signal)=>{
        await this.goals.controller.pauseGoal(sessionId,'paused: stopped by user');current();
        for(const pending of this.pending.values())if(pending.sessionId===sessionId)pending.settle(decisionForDismissal(pending.request));
        await this.routes.recovery.runtime.prepareNativeSessionRecovery(sessionId,null,current,signal);
      },
      onClosed:sessionId=>this.inputCoordinator.onSessionClosed(sessionId),
    });
  }
  private releaseDeferredInteractions(id:string):string[]{
    if(this.inputCoordinator.isQueuePaused(id))return [];
    const applied:string[]=[];
    for(const [requestId,pending]of this.pending){
      if(pending.sessionId!==id||!pending.deferred)continue;
      const decision=pending.deferred;pending.deferred=undefined;
      if(pending.decide(decision))applied.push(requestId);
    }
    return applied;
  }
  private interaction(id: string, request: InteractionRequest, signal?: AbortSignal, shared?:SharedPermission, ownerSetting = false): Promise<InteractionDecision> {
    const persistence=this.conversationRuntime.persistence;
    const activity = this.sessionActivity;
    const interactionEpoch = activity.bridge.shouldNotifyAgentIslandForSession(id) ? activity.service.captureInteractionEpoch(id) : null;
    persistence.flushAssistantBlock(id);
    const publicRequest = { ...request, ...(request.kind === 'permission' ? { input: redactToolInputForUntrustedBoundary(request.toolName, request.input) as Record<string, unknown> } : {}), requestId: randomUUID() };
    return new Promise(resolve => {
      let finished=false;
      const settle = (decision: InteractionDecision) => {
        if(finished)return;
        finished=true;
        pending.shared?.settle(decision);
        if(!pending.persistedByEvent&&(request.kind==='ask_user_question'||request.kind==='plan_review'))
          persistence.onInteractionResolved(id,pending.persistId,request.kind,publicRequest,(pending.shared?.decision??decision) as unknown as Record<string,unknown>);
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(publicRequest.requestId);
        this.emit('maker:interaction-dismissed', { sessionId: id, requestId: publicRequest.requestId });
        activity.bridge.handleAgentIslandInteractionDismissed(id, publicRequest.requestId);
        resolve(pending.shared?.decision??decision);
      };
      const cancel = () => settle(decisionForDismissal(publicRequest));
      const pending:Pending={persistId:persistence.onInteractionMessage(id,publicRequest),sessionId:id,sourceRequestId:request.requestId,request:publicRequest,settle,shared,decide:decision=>{
        if(decision.kind!==request.kind||finished||pending.shared?.decision||pending.deferred||this.pending.get(publicRequest.requestId)!==pending)return false;
        if(this.inputCoordinator.isQueuePaused(id)&&!ownerSetting){pending.deferred=decision;return true;}
        settle(decision);
        return true;
      }};
      this.pending.set(publicRequest.requestId,pending);
      if(shared){shared.decide=decision=>decision.kind==='permission'&&pending.decide(decision);void shared.result.then(settle);}
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted || this.closed) { cancel(); return; }
      this.emit('maker:interaction-request', { sessionId: id, request: publicRequest });
      activity.bridge.handleAgentIslandInteractionAfterBroadcast(this.live.get(id)?.session ?? { id }, publicRequest, interactionEpoch);
    });
  }
  /** Taking over an already-running task shares permissions with its original
   * terminal. Other cards transfer presentation only; the host retains stop,
   * cancellation and deferred-answer ownership. */
  takeChannelInteractions(id: string): ReturnType<ImTurnHost['takePendingInteractionsForSession']> {
    this.guard({ source: 'local' });
    const taken: ReturnType<ImTurnHost['takePendingInteractionsForSession']> = [];
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId !== id || pending.migrated || pending.shared) continue;
      if (pending.request.kind === 'permission') {
        const shared = createSharedPermission();
        pending.shared = shared;
        shared.decide = decision => decision.kind === 'permission' && pending.decide(decision);
        void shared.result.then(pending.settle);
        taken.push({ requestId, request: pending.request, sharedPermission: shared, resolve: shared.decide });
      } else {
        pending.migrated = true;
        taken.push({ requestId, request: pending.request, resolve: decision => { pending.decide(decision); } });
        this.emit('maker:interaction-dismissed', { sessionId: id, requestId, reason: 'migrated_to_feishu' });
      }
    }
    return taken;
  }
  private permissionUpdates(value: unknown): Record<string,unknown>[] {
    if(!Array.isArray(value)||value.length===0)throw new Error('INVALID_PERMISSION_UPDATES');
    return value.map(record);
  }
  private assertSharedInteraction(id:string,decision:Record<string,unknown>) {
    const request=this.pending.get(id)?.request;
    const deny=()=>{throw new Error('SHARED_TASK_PERMISSION_DENIED');};
    if(!request||!['permission','ask_user_question','plan_review'].includes(request.kind)||decision.kind!==request.kind||decision.updatedInput!==undefined)deny();
    if(request!.kind!=='permission') {if(decision.permissionUpdates!==undefined)deny();return;}
    const permission=request as Extract<InteractionRequest,{kind:'permission'}>;
    if(['cindy.app.update','cindy.app.auto_update'].includes(permission.toolName))deny();
    if(decision.permissionUpdates===undefined)return;
    const updates=this.permissionUpdates(decision.permissionUpdates);
    const suggestions=permission.suggestions;
    if(!Array.isArray(suggestions))deny();
    for(const update of updates){
      if(update.destination!=='session')deny();
      if(update.type==='codexSessionApproval'){if(Object.keys(update).some(key=>!['type','destination'].includes(key)))deny();}
      else if(update.type!=='addRules'||update.behavior!=='allow'||Object.keys(update).some(key=>!['type','behavior','destination','rules'].includes(key))||!Array.isArray(update.rules)||!update.rules.length||!update.rules.every(raw=>{const rule=record(raw);return rule.toolName===permission.toolName&&Object.keys(rule).every(key=>['toolName','ruleContent'].includes(key))&&(rule.ruleContent===undefined||typeof rule.ruleContent==='string');}))deny();
      if(!suggestions!.some(suggestion=>JSON.stringify(suggestion)===JSON.stringify(update)))deny();
    }
  }
  private resolveInteraction(requestId: string, input: unknown) {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('INTERACTION_NOT_PENDING');
    const raw = record(input);
    if (raw.kind !== pending.request.kind) throw new Error('INTERACTION_KIND_MISMATCH');
    let decision: InteractionDecision;
    if (raw.kind === 'ask_user_question') {
      const answers = record(raw.answers);
      if (Object.values(answers).some(value => typeof value !== 'string')) throw new Error('INVALID_ANSWERS');
      decision = { kind: 'ask_user_question', answers: answers as Record<string, string> };
    } else {
      if (raw.behavior !== 'allow' && raw.behavior !== 'deny') throw new Error('INVALID_PERMISSION_DECISION');
      decision = raw.kind === 'permission'
        ? { kind: 'permission', behavior: raw.behavior, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}), ...(raw.updatedInput !== undefined ? { updatedInput: record(raw.updatedInput) } : {}), ...(raw.permissionUpdates !== undefined ? { permissionUpdates: this.permissionUpdates(raw.permissionUpdates) } : {}) }
        : { kind: 'plan_review', behavior: raw.behavior, ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}), ...(typeof raw.editedPlan === 'string' ? { editedPlan: raw.editedPlan } : {}) };
    }
    return { success: pending.decide(decision) };
  }
  private cancelIdleReclaim(id: string) {
    const timer = this.idleReclaimTimers.get(id);
    if (timer) clearTimeout(timer);
    this.idleReclaimTimers.delete(id);
  }
  private scheduleIdleReclaim(id: string) {
    this.cancelIdleReclaim(id);
    const task = this.live.get(id), row = this.storage.peek(id);
    if (this.closed || !task || task.session.agentKind !== 'codex' || task.session.getStatus() !== 'active' || this.isTurnRunning(id)
      || !row?.userSendAt || row.remoteHostId || row.agentDeviceId || row.groupBinding || row.orcaRole
      || row.orcaRemoteLead || row.reviewMode || row.parentSessionId || task.plugin
      || (row.source && row.source !== 'desktop')) return;
    const current = () => !this.closed && this.idleReclaimTimers.get(id) === timer && this.live.get(id) === task;
    const timer = setTimeout(() => {
      const attempt = this.reclaimIdleCodexTask(id, current).then(reclaimed => {
        if (!reclaimed && current()) this.scheduleIdleReclaim(id);
      }).catch(() => {
        this.options.logger.warn('Idle Codex runtime reclamation failed', { sessionId: id });
      }).finally(() => {
        if (this.idleReclaimTimers.get(id) === timer) this.idleReclaimTimers.delete(id);
        this.idleReclaimAttempts.delete(attempt);
      });
      this.idleReclaimAttempts.add(attempt);
    }, 5 * 60_000);
    timer.unref();
    this.idleReclaimTimers.set(id, timer);
  }
  /** The optional idle-period guard fences a timer invalidated by new input. */
  async reclaimIdleCodexTask(id: string, stillIdle: () => boolean = () => true): Promise<boolean> {
    await this.ready;
    // Reclamation is opportunistic: never queue behind a send waiting for a
    // human decision, or make that decision depend on the reclaim returning.
    if (this.closed || !stillIdle() || this.routes.isLocked(id) || this.isTurnRunning(id)) return false;
    return this.routes.withLock(id, async () => {
      const task = this.live.get(id);
      if (!task || task.session.agentKind !== 'codex') return false;
      await this.inputCoordinator.ensureQueueRestored(id);
      await this.conversationRuntime.persistence.drainPersistQueue();
      const row = await this.storage.get(id);
      const goal = await this.goals.controller.getStatus(id);
      // Keep the first experiment away from runtimes owned by another lifecycle.
      if (!row?.sdkSessionId || !row.userSendAt || row.agentKind !== 'codex' || row.remoteHostId || row.agentDeviceId
        || row.groupBinding || (row.source && row.source !== 'desktop') || row.orcaRole || row.orcaRemoteLead || row.reviewMode
        || row.parentSessionId || row.pendingHandoff || row.goalContinuation || goal
        || row.archived || row.deleted || task.plugin) return false;
      const busy = () => this.closed || !stillIdle() || !this.pendingDispatchReady || this.live.get(id) !== task
        || this.closingTasks.has(task) || this.isTurnRunning(id) || this.stoppingTasks.has(id)
        || this.queueMutations.has(id) || this.persistenceFaults.has(id) || !!this.routes.pending.get(id)
        || this.routes.credentials.has(id) || this.options.isSessionShared?.(id) === true
        || !this.inputCoordinator.isQueueRestored(id) || this.inputCoordinator.isQueuePaused(id)
        || this.inputCoordinator.hasPendingQueuedWork(id) || this.inputCoordinator.hasUsageLimitRecovery(id)
        || this.inputCoordinator.hasQueuedItemWhere(id, () => true, { includeRecovery: true })
        || this.companionPendingInteractions(id).length > 0 || task.session.listBackgroundTasks().length > 0;
      if (busy()) return false;
      // Install the bootstrap fence before reserving Session.close. The route
      // lock serializes sends; other ensureLive callers also await full teardown.
      const work = Promise.resolve().then(() => this.withRehydrateCloseSuppressed(id, async () => {
        if (busy() || !await task.session.closeIfIdle()) return false;
        await this.closeTask(id);
        return true;
      }));
      this.idleReclaims.set(id, work);
      try { return await work; }
      finally { if (this.idleReclaims.get(id) === work) this.idleReclaims.delete(id); }
    });
  }
  private closeTask(id: string): Promise<void> {
    this.cancelIdleReclaim(id);
    const task=this.live.get(id);
    if(!task)return Promise.resolve();
    const pending=this.closingTasks.get(task);if(pending)return pending;
    const work = this.closeTaskRuntime(id, task).finally(() => {
      if (this.closingTasks.get(task) === work) this.closingTasks.delete(task);
    });
    this.closingTasks.set(task, work);
    return work;
  }
  private async closeTaskRuntime(id: string, task: LiveTask) {
    this.lastLiveUsage.rememberSessionLastLiveUsage(id, task.session.getUsageSnapshot());
    this.options.protectedInput?.handoff.cleanupForSession(id);
    this.pluginSetup?.bridge.cleanupForSession(id,'session_closed');
    // Interrupted turns may have newer usage than the last done event. Save the
    // final live reading before detach so a cold model switch sees that pressure.
    await this.storage.updateIf(id, row => !row.deleted, { usage: task.session.getUsageSnapshot() }, () => {});
    for (const pending of [...this.pending.values()]) if (pending.sessionId === id) pending.settle(decisionForDismissal(pending.request));
    if (!this.closed) await task.maker.closeSession(id, this.routeClosures.has(id) ? 'agent-switch' : 'requested');
    const report = await task.maker.shutdown({ reason: this.closed ? this.shutdownReason : 'navigation' });
    if (report.sessionFailures.length) throw new AggregateError(report.sessionFailures.map(failure => failure.error), 'Native task shutdown remains unconfirmed');
    task.revoke();
    await this.changes.store.finalizeTurnChangeSet(id, null, 'partial');
    this.changes.store.clearPendingTurnChangeSets(id);
    for (const dispose of task.dispose) await dispose();
    if(this.live.get(id)===task)this.live.delete(id);
  }
  private async stopTaskTurn(session: Session) {
    this.live.get(session.id)?.cancelReview();
    this.sessionActivity?.bridge.handleAgentIslandSessionStopped(session);
    await this.turnLifecycle.stop(session);
  }
  private settleUndispatchedRetry(id: string, item: AgentInputQueuedMessage, disposition: 'cancelled' | 'failed') {
    const auto = item.autoResume === true;
    if (auto) this.recoveryInputs.settleUndispatchedInterruptedAutoResume(id, item);
    if (disposition === 'failed') this.eventRuntime.bookkeeping.surfaceSuppressedErrorForRetry(id, item.clientId);
    else if (this.eventRuntime.bookkeeping.flushSuppressedErrorForRetry(id, item.clientId))
      this.sessionActivity?.bridge.handleAgentIslandSessionStopped(this.live.get(id)?.session ?? id);
    if (!auto) this.recoveryInputs.settleUndispatchedInterruptedAutoResume(id, item);
  }
  private async cancelTaskRecovery(id: string) {
    this.turnLifecycle.guard.noteSessionReset(id);
    this.eventRuntime.interrupted.noteSessionReset(id);
    this.eventRuntime.bookkeeping.teardown(id);
    this.routes.recovery.runtime.cancelRecovery(id);
    const requestId = this.activeSubmissions.get(id);
    if (requestId && this.activeSubmissions.get(id) === requestId) {
      this.activeSubmissions.delete(id);
      this.externalSubmissions.delete(id);
      await this.updateReceipt(id, requestId, 'interrupted', 'INPUT_STOPPED', this.submissionText.get(id));
      this.submissionText.delete(id);
    }
  }
  currentInvocation(): TaskInvocationContext {
    const context = this.inputInvocation.getStore() ?? { source: 'local' as const };
    this.guard(context); return context;
  }
  private guard(context: TaskInvocationContext) {
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    if (context.signal?.aborted) throw new Error('REQUEST_ABORTED');
    context.assertCurrent?.();
  }
  async invoke(channel: string, args: unknown[] = [], context: TaskInvocationContext = { source: 'local' }): Promise<unknown> {
    this.guard(context);
    const stopsTask = ['maker:input:stop', 'maker:abort-session', 'maker:close-session', 'terminal:tasks:delete'].includes(channel)
      || channel === 'local-db:sessions:update' && record(args[1] ?? {}).status !== undefined && record(args[1]).status !== 'active';
    const stoppingId = stopsTask ? string(args[0]) : undefined;
    if (stoppingId) {
      this.stoppingTasks.set(stoppingId, (this.stoppingTasks.get(stoppingId) ?? 0) + 1);
    }
    try {
      const result = await this.inputInvocation.run(context, () => this.dispatch(channel, args, context));
      this.guard(context);
      return result;
    } finally {
      if (stoppingId) {
        const remaining = (this.stoppingTasks.get(stoppingId) ?? 1) - 1;
        if (remaining) this.stoppingTasks.set(stoppingId, remaining);
        else this.stoppingTasks.delete(stoppingId);
        if (!remaining && channel === 'maker:input:stop' && record(args[1] ?? {}).pauseQueue === false) this.drain(stoppingId);
      }
    }
  }
  private gitSafetyWire() {
    const state=this.gitSnapshots.readGitSafetySettingsState();
    return {...state.value,isCustomized:state.isCustomized,defaultMode:state.defaults.mode,defaultAutoSnapshotEnabled:state.defaults.autoSnapshotEnabled};
  }
  private async dispatch(channel: string, args: unknown[], context: TaskInvocationContext): Promise<unknown> {
    await this.ready;
    if (this.closed) throw new Error('TASK_HOST_CLOSED');
    if (!Array.isArray(args)) throw new Error('INVALID_ARGUMENTS');
    this.guard(context);
    if(this.sessionActivity?.channels.includes(channel))return this.sessionActivity.invoke(channel,args,context);
    if(this.usageApi?.has(channel))return this.usageApi.invoke(channel,args,context);
    if (context.source==='remote'&&(channel==='maker:model-disable:set'||['maker:provider:test-connection','maker:provider:models-fetch'].includes(channel)))throw new Error('LOCAL_CONFIGURATION_REQUIRED');
    if (context.source === 'remote' && channel.startsWith('terminal:models:')) throw new Error('LOCAL_CONFIGURATION_REQUIRED');
    if (context.source === 'remote' && channel.startsWith('maker:provider:custom:') && (!context.ownerId || !context.deviceId || !context.assertCurrent)) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
    if (context.source === 'remote' && channel.startsWith('maker:provider:custom:') && args[1] && Object.keys(record(args[1])).length) throw new Error('PROTECTED_SECRET_SUBMISSION_REQUIRED');
    if (context.sharedTask) {
      const allowed = ['local-db:messages:around','local-db:messages:around-client-id','local-db:messages:view','local-db:messages:view-intent','local-db:messages:work-details','maker:provider:list', 'maker:get-capabilities', 'maker:input:stop', 'maker:input:resume', 'maker:input:remove', 'maker:input:update-text', 'maker:input:update-content', 'maker:input:move', 'maker:input:set-expanded', 'maker:input:set-edit-lock', 'maker:input:set-interaction-lock', 'maker:input:enqueue', 'maker:input:get-projection', 'maker:send', 'maker:abort-session', 'maker:session-in-turn', 'maker:get-context-usage', 'maker:get-pending-interactions', 'maker:resolve-interaction', 'local-db:sessions:get', 'local-db:messages:list', 'local-db:history:messages', 'terminal:tasks:turn-status'];
      if (!allowed.includes(channel)) throw new Error('SHARED_TASK_PERMISSION_DENIED');
      if(channel==='maker:provider:list' && args.length && (args.length>1||!args[0]||typeof args[0]!=='object'||Object.keys(args[0] as object).some(key=>!['includeCapabilities','capabilities'].includes(key))))throw new Error('INVALID_ARGUMENT');
      if(channel==='maker:get-capabilities'&&!ENGINES.includes(args[0] as AgentKind))throw new Error('INVALID_ENGINE');
      const target = channel==='maker:provider:list'||channel==='maker:get-capabilities' ? context.sharedTask.sessionId : channel === 'maker:resolve-interaction' ? this.pending.get(string(args[0]))?.sessionId : channel === 'local-db:history:messages' ? record(args[0]).sessionId : args[0];
      if (target !== context.sharedTask.sessionId) throw new Error('SHARED_TASK_SCOPE_MISMATCH');
    }
    if (channel === 'maker:input:stop') await this.inputBoundary.assertRemoteInputControlBoundary(string(args[0]), context.source === 'remote', args[1], 'stop');
    const stopWorker = ['maker:input:stop', 'maker:abort-session', 'maker:close-session', 'terminal:tasks:delete'].includes(channel)
      || channel === 'local-db:sessions:update' && record(args[1] ?? {}).status !== undefined && record(args[1]).status !== 'active';
    // Revoke recovery before the first asynchronous metadata/report read. Its
    // commit guard must already be cancelled if a waiting write resumes now.
    if (stopWorker) this.routes.recovery.runtime.cancelRecovery(string(args[0]));
    if (stopWorker && (await this.storage.get(string(args[0])))?.orcaRole === 'worker') {
      this.guard(context);
      this.manualOrcaInterrupts.set(string(args[0]), { markedAt: Date.now(), reason: 'user_stop' });
    }
    if (REMOTE_WORKER_CHANNELS.includes(channel as typeof REMOTE_WORKER_CHANNELS[number])) return this.remoteWorkers(channel, args, context);
    if (WORKTREE_CHANNELS.includes(channel as typeof WORKTREE_CHANNELS[number])) {
      if (!this.worktreeIpc) throw new Error('WORKTREE_HOST_UNAVAILABLE');
      return this.worktreeIpc(channel, args, context);
    }
    if (ORCA_CONTROL_CHANNELS.includes(channel as typeof ORCA_CONTROL_CHANNELS[number])) {
      if (context.source === 'remote' && (!context.deviceId || !context.ownerId || !context.assertCurrent)) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
      return this.orcaAction.run(() => this.guard(context), () => this.orcaIpc.invoke(channel, args));
    }
    const botHandler=this.botHandlers.get(channel);if(botHandler)return botHandler(context,...args);
    if(channel==='local-db:recent-workdirs:list'||channel==='local-db:recent-workdirs:remove')return (await this.conversations).invoke(channel,args,context);
    if (this.sessions.has(channel)) return this.sessions.invoke(channel, args, context);
    if(channel===MCP_APPS_INVOKE)return this.mcpApps.invoke(args,context);
    if(CAPABILITY_CHANNELS.includes(channel))return this.capabilities.invoke(channel,args,context);
    const inputHandler = this.inputHandlers.get(channel);
    if (inputHandler) return inputHandler(context, ...args);
    if(this.goals.handles(channel))return this.goals.invoke(channel,args);
    switch (channel) {
      case 'maker:generate-title': {
        const input = record(args[0]);
        if (typeof input.message !== 'string' || input.agentKind !== undefined && !ENGINES.includes(input.agentKind as AgentKind)) throw new Error('INVALID_ARGUMENT');
        return { title: await this.generateTaskTitle({ message: input.message, ...(input.sessionId ? { sessionId: string(input.sessionId) } : {}), ...(input.agentKind ? { agentKind: input.agentKind as AgentKind } : {}) }) };
      }
      case 'maker:input:stop': {
        const id = string(args[0]);
        await this.goals.controller.pauseGoal(id,'paused: stopped by user');
        await this.inputCoordinator.ensureQueueRestored(id);
        await this.cancelTaskRecovery(id);
        const projection = this.inputCoordinator.stop(id, args[1] ? record(args[1]) : undefined);
        await (await this.database).inputQueue.awaitAgentInputQueueSnapshotPersistence(id);
        return projection;
      }
      case 'maker:input:cancel-usage-limit-wait': return this.inputCoordinator.cancelUsageLimitWait(string(args[0]));
      case 'maker:git-safety:get': return this.gitSafetyWire();
      case 'maker:git-safety:set': {
        const mode=typeof args[0]==='boolean'?(args[0]?'all-projects':'off'):args[0];
        if(mode!=='off'&&mode!=='existing-git'&&mode!=='all-projects')throw new Error('INVALID_PARAMS:git safety mode required');
        this.gitSnapshots.writeGitSafetyMode(mode);return this.gitSafetyWire();
      }
      case 'maker:git-safety:reset': this.gitSnapshots.resetGitSafetySettings();return this.gitSafetyWire();
      case 'maker:turn-change-sets:list': return this.changes.store.listTurnChangeSets(string(args[0]));
      case 'maker:turn-change-sets:get': {
        if (!Array.isArray(args[1]) || args[1].length > 16 || args[1].some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(id))) throw new Error('INVALID_ARGUMENT');
        return this.changes.store.getTurnChangeSets(string(args[0]), args[1] as string[]);
      }
      case 'maker:turn-change-set:apply': {
        if (args[2] !== 'undo' && args[2] !== 'reapply') throw new Error('INVALID_ARGUMENT');
        return this.changes.apply(string(args[0]), string(args[1]), args[2], () => this.guard(context));
      }
      case 'maker:get-new-maker-defaults': { const kind=args[0];if(!ENGINES.includes(kind as AgentKind))throw new Error('INVALID_ARGUMENT');this.models.defaults.synchronize();return this.models.defaults.cache.getRemoteNewMakerDefaults(kind as AgentKind); }
      case 'maker:get-capabilities': {
        const kind=string(args[0]) as AgentKind;if(!ENGINES.includes(kind))throw new Error('INVALID_ENGINE');
        const capabilities=this.channelRuntime().getCapabilities(kind);
        return {...capabilities,supportsSessionAgentSwitch:true,supportsSessionAgentSwitchCas:true,supportsModelWindowSwitchGuard:true,supportsScheduleIntervalNullClear:true,supportsSchedulePreRunHook:true};
      }
      case 'maker:get-session-tree': return (await this.ensureLive(string(args[0]))).session.getSessionTree();
      case 'maker:set-thinking-enabled': {if(typeof args[1]!=='boolean')throw new Error('INVALID_ARGUMENT');const id=string(args[0]);await (await this.ensureLive(id)).session.setThinkingEnabled(args[1]);await this.storage.update(id,{thinkingEnabled:args[1]});return {success:true};}

      case 'maker:session:handoff': {
        if(context.source!=='remote'||!context.deviceId||!context.assertCurrent||context.sharedTask)throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        if(record(args[0]).action==='task-action-capability')return {taskActionVersion:1};
        if(record(args[0]).action==='validate-task-action'){
          const raw=record(args[0]);
          const request={receiptId:string(raw.receiptId),sessionId:string(raw.sessionId),targetSessionId:string(raw.targetSessionId),message:string(raw.message),release:raw.release===true};
          const valid=await validateRemoteTaskActionReceipt(context.deviceId,request);this.guard(context);
          return {valid,...(request.release?{released:valid}:{})};
        }
        const proof=readTaskDelivery(args[0],context.deviceId);
        return this.inputInvocation.run({...context,deliveryProof:proof},()=>this.receiveSessionHandoff(context.deviceId!,args[0]));
      }

      case 'binding:resolve-session': {
        if (context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        const identity = typeof args[0] === 'string' ? this.channelBindings.store.findByTarget(args[0]) : null;
        return { attached: identity !== null, identity, displayName: null };
      }
      case 'binding:list-attached': {
        if (context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        return { sessionIds: this.channelBindings.store.listAttachedTargets() };
      }
      case 'binding:revoke': {
        if (context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        const id = string(args[0]), identity = this.channelBindings.store.findByTarget(id);
        if (!identity || !await this.channelBindings.store.detachIfTarget(identity, id)) return { ok: true, alreadyDetached: true };
        this.guard(context);
        await this.channelOrchestrators.notifyRevoked(identity).catch(() => this.options.logger.warn('IM_DETACH_NOTICE_FAILED'));
        return { ok: true, alreadyDetached: false };
      }
      case 'local-db:history:messages': return createRemoteHistory(this.historyDeps(), id => this.storage.get(id), () => this.guard(context), this.history.readLatestSessionTerminal).messages(args[0]);
      case 'local-db:history:query': {
        if (context.sharedTask) throw new Error('AUTHENTICATED_OWNER_REQUIRED');
        return createRemoteHistory(this.historyDeps(), id => this.storage.get(id), () => this.guard(context), this.history.readLatestSessionTerminal).query(args[0]);
      }
      case 'maker:create-session': return this.create(record(args[0] ?? {}), () => this.guard(context));
      case 'terminal:tasks:submit': return this.submit(string(args[0]), args[1], args[2] === undefined ? {} : record(args[2]), context);
      case 'terminal:tasks:turn-status': { const receipt = await this.storage.submission(string(args[0]), string(args[1])); if (!receipt) throw new Error('SUBMISSION_NOT_FOUND'); return this.receiptView(receipt); }
      case 'terminal:tasks:status': return this.storage.submission(string(args[0]), string(args[1]));
      case 'terminal:tasks:wait': return this.waitReceipt(string(args[0]), string(args[1]), args[2] === undefined ? {} : record(args[2]), context);
      case 'terminal:tasks:list': return (await this.storage.list()).filter(row=>!row.hiddenAt).map(row => this.view(row));
      case 'local-db:orca-workflows:get-by-lead': return this.orcaStore.getTeamByLeadSession(string(args[0]));
      case ORCA_EXECUTION_DEVICES_CHANNEL: return { devices: await this.orcaRemoteController.listExecutionDevices() };
      case 'local-db:orca-workflows:get-by-worker-session': return this.orcaStore.getTeamByWorkerSession(string(args[0]));
      case 'local-db:orca-workflows:list-workers-by-lead': return this.orcaStore.listWorkersByLead(string(args[0]));
      case 'local-db:orca-workflows:list-workers-by-leads': {
        if (!Array.isArray(args[0]) || args[0].length > 200) throw new Error('INVALID_ARGUMENT');
        return this.orcaStore.listWorkersByLeads(args[0].map(id => string(id)));
      }
      case 'local-db:messages:list':
      case 'local-db:messages:around':
      case 'local-db:messages:around-client-id':
      case 'local-db:messages:view':
      case 'local-db:messages:work-details':
      case 'local-db:messages:view-intent': {
        const runtime = await this.conversations;
        await runtime.persistence.drainPersistQueue();
        this.guard(context);
        return runtime.invoke(channel, args, context);
      }
      case 'terminal:tasks:get': { const row = await this.storage.get(string(args[0])); if (!row) throw new Error('TASK_NOT_FOUND'); return this.view(row); }
      case 'terminal:tasks:history': { const page = args[1] === undefined ? {} : record(args[1]); return this.storage.history(string(args[0]), Number(page.after ?? 0), Number(page.limit ?? 200)); }
      case 'terminal:tasks:rename': { const row = await this.storage.update(string(args[0]), { title: string(args[1]) }); this.emit('terminal:tasks:changed', { sessionId: row.id }); return this.view(row); }
      case 'terminal:tasks:delete': { const id = string(args[0]); await this.patchMeta(id, { status: 'deleted' }, () => this.guard(context)); return { success: true }; }
      case 'maker:list-active': { const sessions = [...this.live.values()].map(({ session }) => ({ sessionId: session.id, agentKind: session.agentKind, workDir: session.workDir, capabilities: session.capabilities, isTurnRunning: session.isTurnRunning() })); return args[0] && record(args[0]).snapshotVersion === 2 ? { format: 'active-sessions-v2', sessions } : sessions; }
      case 'maker:any-session-in-turn': return [...this.live.values()].some(task => task.session.isTurnRunning());
      case 'maker:session:turn-active': return { inTurn: this.isTurnRunning(string(args[0])) };
      case 'maker:session-in-turn': return this.live.get(string(args[0]))?.session.isTurnRunning() ?? false;
      case 'maker:plugin-setup:submit-inline': {if(context.source!=='local')throw new Error('LOCAL_ONLY_COMMAND');const request=parseGhostSetupInlineSubmitRequest(args[0]);return {accepted:Boolean(request&&this.pluginSetup?.bridge.submitInline(request.requestId,request))};}
      case 'maker:get-pending-interactions': return [...(!context.sharedTask?this.taskActionConfirm.pendingSnapshots(string(args[0])):[]),...(!context.sharedTask?this.pluginSetup?.bridge.pendingSnapshots(string(args[0]))??[]:[]),...(!context.sharedTask ? this.options.protectedInput?.handoff.pendingSnapshots(string(args[0]))??[] : []), ...[...this.pending.values()].filter(p => p.sessionId === args[0] && !p.migrated && (!context.sharedTask || ['permission','ask_user_question','plan_review'].includes(p.request.kind))).map(p => ({ request: p.request }))];
      case 'maker:resolve-interaction': {if(!context.sharedTask&&this.taskActionConfirm.resolveFromIpc(string(args[0]),args[1],{isDeviceLink:context.source==='remote',assertTrustedSender:()=>this.guard(context)}))return {success:true};if(!context.sharedTask&&this.pluginSetup?.bridge.pendingSnapshots().some(item=>item.request.requestId===args[0]))return {accepted:this.pluginSetup.bridge.resolve(string(args[0]),args[1])};if(!context.sharedTask&&this.options.protectedInput?.handoff.isCurrent(string(args[0])))return this.options.protectedInput.handoff.resolve(string(args[0]),args[1],context.source==='remote'?{deviceId:context.deviceId}:{local:true});if(context.sharedTask)this.assertSharedInteraction(string(args[0]),record(args[1]));return this.resolveInteraction(string(args[0]), args[1]);}
      case 'maker:close-session': { const id = string(args[0]); await this.cancelTaskRecovery(id); if (this.starts.has(id)) throw new Error('TASK_STARTING'); await this.closeTask(id); return { success: true }; }
      case 'maker:abort-session': { const id=string(args[0]);await this.goals.controller.pauseGoal(id,'paused: stopped by user');await this.cancelTaskRecovery(id);this.options.protectedInput?.handoff.cleanupForSession(id);this.pluginSetup?.bridge.cleanupForSession(id,'session_aborted');this.taskActionConfirm.cleanupForSession(id,'session_aborted');const task = this.live.get(id); if(task)await this.stopTaskTurn(task.session); return { success: true }; }
      case 'maker:send': {
        if (this.stoppingTasks.has(string(args[0]))) throw new Error('SESSION_STOPPING');
        if (args[1] && typeof args[1] === 'object' && typeof (args[1] as Record<string, unknown>).clientId === 'string') {
          const receipt = await this.submit(string(args[0]), args[1], { requestId: (args[1] as Record<string, unknown>).clientId }, context);
          return { accepted: !['failed', 'interrupted'].includes(receipt.status), requestId: receipt.requestId, clientId: receipt.requestId, status: receipt.status, ...(receipt.error ? { reason: receipt.error } : {}) };
        }
        return this.sendNative(string(args[0]), args[1], context);
      }
      case 'maker:steer': {
        const id = string(args[0]), remote = context.source === 'remote';
        const boundary = await this.inputBoundary.assertRemoteInputControlBoundary(id, remote, args[2]);
        const sanitized = attachMainOwnedInputBoundary(args[2], boundary);
        const options = remote ? stampDirectSendSourceDevice(sanitized, context.sourceDevice) : attachTrustedDesktopSendContext(args[1], sanitized);
        return (await this.originalSteerTransaction(context)).steerToAgentAccepted(id, args[1], options);
      }
      case 'maker:get-context-usage': return (await this.ensureLive(string(args[0]))).session.getContextUsage();
      case 'maker:navigate-session-tree': {
        const sessionId = string(args[0]);
        const entryId = string(args[1]);
        const raw = args[2] == null ? {} : record(args[2]);
        if (raw.summarize !== undefined && typeof raw.summarize !== 'boolean') throw new Error('INVALID_ARGUMENT');
        if (raw.customInstructions !== undefined && typeof raw.customInstructions !== 'string') throw new Error('INVALID_ARGUMENT');
        const live = await this.ensureLive(sessionId);
        if (!live.session.capabilities.sessionTree?.supported) return null;
        const conversations = await this.conversations;
        const database = await this.database;
        const { result, hiddenClientIds, now } = await this.routes.withLock(sessionId, async () => {
          const result = await live.session.navigateSessionTree(entryId, {
            summarize: raw.summarize === true,
            ...(typeof raw.customInstructions === 'string' ? { customInstructions: raw.customInstructions } : {}),
          });
          const now = Date.now();
          const rehydrated = await database.getDbClient().tx('session.treeRehydrate', {
            sessionId,
            now,
            contextTokens: result.contextTokens,
            contextWindow: result.contextWindow,
            messages: result.messages.map(message => ({
              id: randomUUID(), clientId: message.clientId, role: message.role,
              content: JSON.stringify(message.content), toolUseId: message.toolUseId ?? null,
              agentMeta: message.agentMeta ? JSON.stringify(message.agentMeta) : null,
              agentKind: 'pi' as const, createdAt: message.createdAt,
            })),
          });
          return { result, hiddenClientIds: rehydrated.hiddenClientIds, now };
        });
        if (hiddenClientIds.length > 0) conversations.messages.broadcastMessageDeleted({ sessionId, clientId: hiddenClientIds[0]!, clientIds: hiddenClientIds });
        const visibleRows = await conversations.messages.readMessagesList(sessionId, { limit: Infinity });
        for (const row of visibleRows) conversations.messages.broadcastMessageRow(sessionId, row);
        conversations.notifications.broadcastSessionPatched(sessionId, {
          clearedAt: null, contextTokens: result.contextTokens, contextWindow: result.contextWindow,
          updatedAt: new Date(now).toISOString(), _count: { messages: visibleRows.length },
        });
        return { tree: result.tree, draftText: result.draftText, cancelled: result.cancelled === true };
      }
      case 'maker:get-session-agent-switch-intent': return this.routes.intent(string(args[0]));
      case 'maker:switch-session-agent': {
        const opts = args[6] === undefined ? {} : record(args[6]);
        if (context.source === 'remote' && opts.confirmedContextWindow !== undefined) throw new Error('PRECONDITION_FAILED');
        if (context.sharedTask && opts.agentDeviceId !== undefined) throw new Error('UNSUPPORTED_CAPABILITY');
        return this.routes.select({ sessionId: args[0], targetAgentKind: args[1], model: args[2], providerId: args[3], effort: args[4], fastMode: args[5], thinking: args[7], ...(opts.agentDeviceId !== undefined ? { agentDeviceId: opts.agentDeviceId } : {}), ...(opts.confirmedContextWindow !== undefined ? { confirmedContextWindow: opts.confirmedContextWindow } : {}), assertSelectionCurrent: () => this.guard(context) });
      }
      case 'maker:set-model': {
        const terminalOptions = args[2] && typeof args[2] === 'object' ? record(args[2]) : undefined;
        let terminalSelection: Record<string, unknown> | undefined;
        if (terminalOptions && ['effort', 'fastMode', 'thinking', 'confirmedContextWindow'].some(key => Object.hasOwn(terminalOptions, key))) {
          const row = await this.storage.get(string(args[0])); this.guard(context);
          terminalSelection = {...terminalOptions,
            effort: Object.hasOwn(terminalOptions, 'effort') ? terminalOptions.effort : row?.effort ?? null,
            fastMode: terminalOptions.fastMode ?? row?.fastMode ?? false};
        }
        const wire = normalizeDeviceLinkSetModelWireArgs(context.source === 'remote',
          context.controllerCapabilities?.includes(CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1) === true,
          terminalOptions ? terminalOptions.providerId : args[2], args[3], terminalOptions ? terminalSelection : args[4]);
        const opts = wire.selection === undefined ? {} : record(wire.selection);
        if (context.source === 'remote' && opts.confirmedContextWindow !== undefined) throw new Error('PRECONDITION_FAILED');
        const result = await this.routes.selectModel(string(args[0]), string(args[1]), wire.providerId, opts, wire.expectedAgentSwitchRevision, () => this.guard(context));
        return result;
      }
      case 'maker:set-effort': return this.routes.setRuntimeAxis(channel, args[0], args[1]);
      case 'maker:set-permission-mode': {
        const task = await this.ensureLive(string(args[0])), mode = permission(args[1]);
        const result = await this.changeChannelPermission({ sessionId: task.session.id, mode, modes: task.session.capabilities.permissionModes, confirmedFullAccess: true,
          readPreviousMode: async () => { const row = await this.storage.get(task.session.id); return row ? permission(row.permissionMode === 'default' ? 'ask' : row.permissionMode ?? 'ask') : null; },
          getLiveSession: () => this.live.get(task.session.id)?.maker.getSession(task.session.id) ?? null,
          persist: async value => { this.guard(context); await this.storage.update(task.session.id, { permissionMode: value }); this.guard(context); },
        });
        if (result.kind !== 'changed') throw new Error(result.kind === 'failed' || result.kind === 'invalid' ? result.reason : 'PERMISSION_CONFIRMATION_REQUIRED');
        return { success: true };
      }
      case 'maker:get-plugin-write-access-recovery': case 'maker:retry-plugin-write-access': {
        if(context.source!=='local'||context.sharedTask)throw new Error('LOCAL_ONLY_COMMAND');
        if(!this.pluginSessions)return {granted:false,available:false};
        return this.pluginSessions.recoverWriteAccess(string(args[0]),channel==='maker:retry-plugin-write-access',()=>this.guard(context));
      }
      case 'maker:set-plan-mode': {
        if(typeof args[1]!=='boolean')throw new Error('INVALID_ARGUMENT');
        const id=string(args[0]),enabled=args[1];
        return this.permissionChanges.withSessionPermissionChange(id,async()=>{
          this.guard(context);const task=await this.ensureLive(id);this.guard(context);
          await task.session.setPlanMode(enabled);this.guard(context);
          await this.storage.update(id,{planMode:enabled});return {success:true};
        });
      }
      case 'maker:set-fast-mode': return this.routes.setRuntimeAxis(channel, args[0], args[1]);
      case 'maker:compact-session': return (await this.ensureLive(string(args[0]))).session.compactSession(typeof args[1] === 'string' ? args[1] : undefined);
      case 'maker:list-available-agents': return ENGINES.filter(kind => Boolean(this.binaries.get(kind)));
      case 'maker:list-agent-commands': {
        const kind = string(args[0]) as AgentKind;
        if (!ENGINES.includes(kind)) throw new Error('INVALID_ENGINE');
        const sessionId = args[1] && typeof args[1] === 'object' ? (record(args[1]).sessionId as string | undefined) : undefined;
        const live = sessionId ? this.live.get(sessionId)?.maker : undefined;
        if (live) return { success: true, commands: live.listAgentCommands(kind) };
        const binary = this.binaries.get(kind);
        if (!binary) return { success: false, commands: [], error: 'ENGINE_NOT_INSTALLED' };
        const agent = kind === 'codex'
          ? new CodexAgent({ binaryPath: binary, runtimeConfig: { userDataPath: this.options.profileDir }, logger: this.options.logger, auth: { getState: async () => ({ authenticated: false }), getAuthEnv: async () => ({}), triggerLogin: async () => { throw new Error('USE_NATIVE_CLI_LOGIN'); }, logout: async () => { throw new Error('USE_NATIVE_CLI_LOGOUT'); } } })
          : createOfflineHistoryAgent({ kind, sourceSessionId: `command-list-${kind}`, profileDir: this.options.profileDir, binaryPath: binary, logger: this.options.logger });
        try { return { success: true, commands: agent.listAgentCommands() }; }
        finally { await agent.dispose(); }
      }
      case 'maker:list-agent-skills': {
        const kind = string(args[0]) as AgentKind;
        if (!ENGINES.includes(kind)) throw new Error('INVALID_ENGINE');
        const params = args[1] && typeof args[1] === 'object' ? record(args[1]) : {};
        return { success: true, ...(await this.listAgentSkills(kind, params as Parameters<ReturnType<typeof createTerminalSkillReader>['listAgentSkills']>[1])) };
      }
      case 'maker:list-customizations': {
        const params = args[0] && typeof args[0] === 'object' ? record(args[0]) : {};
        const requested = typeof params.agentKind === 'string' ? [params.agentKind as AgentKind] : ENGINES;
        const result = { items: [] as unknown[], errors: [] as unknown[] };
        for (const kind of requested) {
          if (!ENGINES.includes(kind)) { result.errors.push({ agentKind: kind, error: 'INVALID_ENGINE' }); continue; }
          const binary = this.binaries.get(kind);
          if (!binary) { result.errors.push({ agentKind: kind, error: 'ENGINE_NOT_INSTALLED' }); continue; }
          const agent = kind === 'codex'
            ? new CodexAgent({ binaryPath: binary, runtimeConfig: { userDataPath: this.options.profileDir }, logger: this.options.logger, auth: { getState: async () => ({ authenticated: false }), getAuthEnv: async () => ({}), triggerLogin: async () => { throw new Error('USE_NATIVE_CLI_LOGIN'); }, logout: async () => { throw new Error('USE_NATIVE_CLI_LOGOUT'); } } })
            : createOfflineHistoryAgent({ kind, sourceSessionId: `customization-list-${kind}`, profileDir: this.options.profileDir, binaryPath: binary, logger: this.options.logger });
          try {
            const listed = await agent.listCustomizations({
              workingDirs: Array.isArray(params.workingDirs) ? params.workingDirs.filter((value): value is string => typeof value === 'string') : [],
              forceReload: params.forceReload === true,
              kinds: Array.isArray(params.kinds) ? params.kinds.filter((value): value is string => typeof value === 'string') : undefined,
            });
            result.items.push(...listed.items.map(item => ({ ...item, engine: kind })));
            result.errors.push(...listed.errors);
          } catch (error) { result.errors.push({ agentKind: kind, error: error instanceof Error ? error.message : String(error) }); }
          finally { await agent.dispose(); }
        }
        return { success: true, ...result };
      }
      case 'maker:agent:status': { const kind = string(args[0]) as AgentKind; if (!ENGINES.includes(kind)) throw new Error('INVALID_ENGINE'); const binary = this.binaries.get(kind) ?? null; const auth = await this.authState(kind); return { binaryReady: Boolean(binary), binaryPath: binary, authReady: auth.authenticated, ...auth }; }
      case 'maker:agent:binary-version': {
        const kind = string(args[0]) as AgentKind;
        if (!ENGINES.includes(kind)) throw new Error('INVALID_ENGINE');
        const binaryPath = this.binaries.get(kind) ?? null;
        if (!binaryPath) return { kind, binaryPath: null, version: null, latestVersion: null, updateAvailable: false, latestCheckFailed: false, error: 'binary_not_ready' };
        try {
          const result = await runNative(binaryPath, ['--version'], { timeout: 5000 });
          const version = (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0] || null;
          return { kind, binaryPath, version, latestVersion: null, updateAvailable: false, latestCheckFailed: false, ...(version ? {} : { error: 'empty --version output' }) };
        } catch (error) {
          return { kind, binaryPath, version: null, latestVersion: null, updateAvailable: false, latestCheckFailed: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      case 'maker:auxiliary-model-settings:get': return this.utility.state();
      case 'maker:auxiliary-model-settings:set': return this.utility.update(args[0], () => this.guard(context));
      case 'terminal:models:context-owner': {const owner = this.options.currentOwnerSession?.() ?? {dataOwnerId: null, generation: 0}; return {dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation};}
      case 'maker:model-context-limit:get': case 'maker:model-context-limit:set': case 'maker:model-context-limit:reset': return this.routes.configureModelContext(channel, args);
      case 'maker:provider:list': {
        const owner=this.options.currentOwnerSession?.() ?? {dataOwnerId:null,generation:0};
        const providers=await this.models.views({allowSideEffects:context.source==='local'});
        const snapshot=await this.models.providerListSnapshot(providers,owner);
        this.guard(context);
        const current=this.options.currentOwnerSession?.() ?? owner;
        if(current.dataOwnerId!==owner.dataOwnerId || current.generation!==owner.generation)throw new Error('OWNER_CHANGED');
        return snapshot;
      }
      case 'maker:provider:presets': return {presets:this.models.presets()};
      case 'maker:provider:test-connection': return testConnection(this.models,args[0],()=>this.guard(context),context.signal);
      case 'maker:provider:models-fetch': return fetchModels(this.models,args[0],()=>this.guard(context),context.signal);
      case 'maker:provider:models-refresh': case 'maker:provider:models-rediscover': {const result=await this.models.refresh(string(args[0]));this.emit('maker:provider:changed',{});return result;}
      case 'maker:provider:models-auto-refresh': {if(!['providers-open','model-selector-open'].includes(string(args[0])))throw new Error('INVALID_REFRESH_TRIGGER');await this.models.views();return {ok:true};}
      case 'maker:provider:custom:disconnect': await this.models.disconnect(string(args[0]),()=>this.guard(context));this.emit('maker:provider:changed',{});return {ok:true};
      case 'maker:model-disable:set': await this.models.setDisabled(args[0],()=>this.guard(context));this.emit('maker:provider:changed',{});return {ok:true};
      case 'terminal:models:get': return this.models.snapshot();
      case 'terminal:models:set-default': await this.models.setDefault(args[0], () => this.guard(context)); return this.models.snapshot();
      case 'terminal:models:reset-default': await this.models.resetDefault(() => this.guard(context)); return this.models.snapshot();
      case 'maker:provider:custom:create': case 'maker:provider:custom:update': return this.configureProvider(channel.endsWith(':create')?'create':'edit',args[0],args[1]??{},context);
      case 'maker:provider:custom:delete': await this.models.deleteProvider(string(args[0]), () => this.guard(context)); this.emit('maker:provider:changed', {}); return { success: true };
      default: {const conversations=await this.conversations;if(conversations.hasChannel(channel))return conversations.invoke(channel,args,context);throw new Error(`UNSUPPORTED_CHANNEL:${channel}`);}
    }
  }
  private async updateReceipt(id: string, requestId: string, status: Submission['status'], error?: string, finalText?: string) {
    try {
      // Original GUI/TUI input uses the canonical queue/message receipt. Only
      // older internal adapters still own a terminal receipt during migration.
      if (!await this.storage.submission(id, requestId)) return null;
      const receipt = await this.storage.updateSubmission(id, requestId, status, error, finalText);
      if(receipt.plugin)await this.pluginSessions?.onSubmission(receipt);
      this.emit('terminal:tasks:submission', receipt);
      for (const listener of this.receiptListeners) listener(receipt);
      if(receipt.deliveryProof && ['completed','failed','interrupted'].includes(receipt.status))void validateTaskDelivery(this.options.remoteInvoke,receipt.deliveryProof,true).catch(()=>undefined);
      return receipt;
    } catch { this.options.logger.error('Terminal submission persistence failed'); return null; }
  }
  private receiptView(receipt: Submission) {
    const pendingRequests = [...this.pending.values()].filter(item => item.sessionId === receipt.sessionId).map(item => item.request);
    return { ...receipt, clientId: receipt.requestId, status: pendingRequests.length && ['running', 'sending'].includes(receipt.status) ? 'waiting' : receipt.status === 'sending' ? 'running' : receipt.status, errorCode: receipt.error ?? null, finalText: receipt.finalText ?? (this.activeSubmissions.get(receipt.sessionId) === receipt.requestId ? this.submissionText.get(receipt.sessionId) : '') ?? '', pendingRequests };
  }
  private async submit(id: string, input: unknown, options: Record<string, unknown>, context: TaskInvocationContext, atHead = false) {
    const lifecycle: AttachmentLifecycle = {cleanup:[],accepted:[]};
    try {
    const message = await this.message(id, input, context, lifecycle);
    const requestId = options.requestId === undefined ? randomUUID() : string(options.requestId);
    if(context.deliveryProof){
      if(requestId!==`remote-task-action:${context.deliveryProof.receiptId}`||!/^remote-task-action:[a-zA-Z0-9_-]{1,100}$/.test(requestId))throw new Error('INVALID_REQUEST_ID');
    }else if (!(context.plugin ? /^plugin-task:[a-zA-Z0-9_-]{1,100}$/ : context.targetPlugin ? /^plugin-target:[a-zA-Z0-9_-]{1,100}$/ : /^[a-zA-Z0-9_-]{1,100}$/).test(requestId)) throw new Error('INVALID_REQUEST_ID');
    const sendAtMs = options.sendAtMs === undefined ? undefined : Number(options.sendAtMs);
    if (sendAtMs !== undefined && (!Number.isFinite(sendAtMs) || sendAtMs < 0)) throw new Error('INVALID_SEND_TIME');
    const fingerprint = createHash('sha256').update(JSON.stringify({ message, memberId: context.sharedTask?.memberId, pluginId:context.plugin?.id, targetPlugin:context.targetPlugin, orca:context.orca, collaboration:context.collaboration, sendAtMs })).digest('hex');
    const claimed = await this.permissionChanges.withSessionPermissionChange(id,()=>this.storage.claimSubmission(id, requestId, fingerprint, () => this.guard(context), { message, source: context.source, deviceId: context.deviceId, sourceDevice: context.sourceDevice, ownerId: context.ownerId, sharedTask: context.sharedTask, scheduler: context.scheduler, sender:context.sender, plugin:context.plugin, targetPlugin:context.targetPlugin, orca:context.orca, collaboration:context.collaboration, deliveryProof:context.deliveryProof, sendAtMs }, atHead));
    for(const accepted of lifecycle.accepted) await accepted().catch(()=>this.options.logger.warn('ATTACHMENT_RELAY_CLEANUP_FAILED'));
    if (!claimed.created) return claimed.receipt;
    // Acceptance is durable before work begins; reconnecting with the same key
    // returns the original receipt, including after a process restart.
    await this.enqueueSubmission(id, message, requestId, { ...context, signal: undefined }, sendAtMs, atHead);
    return claimed.receipt;
    } finally { await Promise.allSettled(lifecycle.cleanup.map(cleanup=>cleanup())); }
  }
  private async enqueueSubmission(id: string, message: UserMessage, requestId: string, context: TaskInvocationContext, sendAtMs?: number, atHead = false) {
    const row = await this.storage.get(id); if (!row) throw new Error('TASK_NOT_FOUND');
    this.inputSessions.add(id); this.inputCoordinator.setExecutionPaused(id, !this.pendingDispatchReady);
    await this.inputCoordinator.ensureQueueRestored(id); this.guard(context);
    const content = persistedInput(terminalOrcaHistoryMessage(message, context.collaboration));
    const files = typeof message.content === 'string' ? [] : await Promise.all(message.content
      .filter(block => block.type === 'image' || block.type === 'file').map(async (block, index) => ({
        id: requestId + '-' + index, name: path.basename(block.path), path: block.path, ext: path.extname(block.path),
        size: (await stat(block.path)).size, category: block.type === 'image' ? 'image' as const : 'file' as const,
        mimeType: block.mimeType ?? 'application/octet-stream', ...('managedUrl' in block ? { url: block.managedUrl } : {}),
      })));
    const origin = context.collaboration?.origin ?? context.orca?.origin ?? context.scheduler
      ?? (context.deliveryProof ? {kind:'session' as const,senderSessionId:`${context.deliveryProof.controllerDeviceId}::${context.deliveryProof.sessionId}`,senderSessionTitle:context.deliveryProof.senderTitle,displayText:inputPlainText(message)}
        :context.sender ? { kind: 'session' as const, senderSessionId: context.sender.sessionId, senderSessionTitle: context.sender.title, displayText: inputPlainText(message) } : undefined);
    const item: AgentInputQueuedMessage = { clientId: requestId, text: inputPlainText(message), persistedContent: content,
      durableDelivery: true, model: row.model, effort: row.effort ?? '', permissionMode: row.permissionMode ?? 'default', workingDir: row.workDir,
      origin, ...(files.length ? { files } : {}),
      ...(context.plugin || context.targetPlugin ? { sourcePlugin: { pluginId: (context.plugin ?? context.targetPlugin)!.id, name: (context.plugin ?? context.targetPlugin)!.name } } : {}),
      ...(context.sharedTask ? { sharedTaskAuthor: { sharedTaskId: context.sharedTask.sharedTaskId, sessionId: id, memberId: context.sharedTask.memberId, accountId: context.sharedTask.accountId, displayName: context.sharedTask.name ?? context.sharedTask.memberId } } : {}),
      sourceDevice: context.sourceDevice, fromMobileClient: context.sourceDevice?.platform === 'mobile', fromDeviceLinkClient: context.source === 'remote',
      autoReviewUserText: context.deliveryProof?.autoReviewUserText ?? (context.collaboration || context.orca || context.scheduler || context.sender || context.deliveryProof || context.plugin || context.targetPlugin || context.sharedTask ? '' : inputPlainText(message)),
      chatMessage: { clientId: requestId, role: 'user', content, createdAt: new Date().toISOString() },
      createOpts: { agentKind: row.agentKind, model: row.model, providerId: row.providerId, workingDir: row.workDir,
        effort: row.effort, fastMode: row.fastMode, permissionMode: row.permissionMode, orcaRole: row.orcaRole },
    };
    if(context.deliveryProof)bindTaskActionInput(id,item,context.taskActionDeliveryGuard);
    const stamped = item.origin || item.sourcePlugin || item.sharedTaskAuthor || context.deliveryProof ? item
      : stampTrustedDeviceLinkQueuedOrigin(stampTrustedDesktopQueuedOrigin(item, context.source === 'remote'), context.source === 'remote', context.sourceDevice);
    this.inputContexts.set(id + ':' + requestId, context);
    if (atHead) this.inputCoordinator.reserveNextInput(id, stamped);
    else this.inputCoordinator.enqueue(id, stamped, { sendAtMs });
    await (await this.database).inputQueue.awaitAgentInputQueueSnapshotPersistence(id);
  }
  private drain(id: string) {
    if (!this.closed && this.pendingDispatchReady && !this.queueMutations.has(id)) this.inputCoordinator?.wakeSession(id, 'host-state-changed');
  }
  private async requireQueued(id: string, clientId: string, context: TaskInvocationContext) {
    await this.inputCoordinator.ensureQueueRestored(id);
    const item = this.inputCoordinator.getQueueControlSnapshot(id).pendingQueue.find(item => item.clientId === clientId);
    if (!item) throw new Error('QUEUED_MESSAGE_NOT_FOUND');
    this.guard(context);
    if (context.sharedTask && item.sharedTaskAuthor?.memberId !== context.sharedTask.memberId) throw new Error('SHARED_TASK_INPUT_NOT_OWNED');
    return item;
  }
  private async removeQueued(id: string, clientId: string, context: TaskInvocationContext) {
    await this.requireQueued(id, clientId, context);
    this.inputCoordinator.remove(id, clientId);
    const store = (await this.database).inputQueue;
    await store.saveCancelledInputDelivery(id, clientId);
    await store.awaitAgentInputQueueSnapshotPersistence(id);
  }
  private async projection(id: string, options: Record<string, unknown> = {}) {
    if (!await this.storage.get(id)) throw new Error('TASK_NOT_FOUND');
    await this.inputCoordinator.ensureQueueRestored(id);
    const requested = options.deliveryClientIds;
    if (requested !== undefined && (!Array.isArray(requested) || requested.length > 100 || requested.some(id => typeof id !== 'string' || id.length > 100))) throw new Error('INVALID_DELIVERY_CLIENT_IDS');
    const deliveryReceipts = Array.isArray(requested) ? await (await this.database).inputQueue.readInputDeliveryReceipts(id, requested) : undefined;
    return { ...this.inputCoordinator.getProjection(id), inputDeliveryVersion: 1, ...(deliveryReceipts ? { deliveryReceipts } : {}) };
  }
  private async waitReceipt(id: string, requestId: string, options: Record<string, unknown>, context: TaskInvocationContext) {
    const current = await this.storage.submission(id, requestId);
    if (!current) throw new Error('SUBMISSION_NOT_FOUND');
    if (['completed', 'failed', 'interrupted'].includes(current.status)) return current;
    const timeout = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(30_000, options.timeoutMs)) : 25_000;
    return new Promise<Submission>((resolve, reject) => {
      const finish = (receipt: Submission) => { cleanup(); resolve(receipt); };
      const listener = (receipt: Submission) => { if (receipt.requestId === requestId && receipt.sessionId === id && ['completed', 'failed', 'interrupted'].includes(receipt.status)) finish(receipt); };
      const abort = () => { cleanup(); reject(new Error('REQUEST_ABORTED')); };
      const timer = setTimeout(() => { void this.storage.submission(id, requestId).then(receipt => { if (receipt) finish(receipt); else abort(); }); }, timeout);
      const cleanup = () => { clearTimeout(timer); this.receiptListeners.delete(listener); context.signal?.removeEventListener('abort', abort); };
      this.receiptListeners.add(listener);
      context.signal?.addEventListener('abort', abort, { once: true });
      // Subscribe first, then re-read to close the completion/read race.
      void this.storage.submission(id, requestId).then(receipt => { if (receipt) listener(receipt); }).catch(abort);
      if (context.signal?.aborted) abort();
    });
  }
  private async message(id: string, value: unknown, context: TaskInvocationContext, lifecycle?: AttachmentLifecycle): Promise<UserMessage> {
    if (context.normalizedInput) return value as UserMessage;
    const row = await this.storage.get(id); if (!row) throw new Error('TASK_NOT_FOUND');
    return normalizeTaskInput({...this.options, ingestAttachment: this.options.ingestAttachment ?? ((input,ctx)=>this.media.ingest(input,()=>this.guard(ctx))), resolveAttachment: async (reference,ctx,sid) => reference.startsWith('cindy-media://') ? this.media.resolveManaged(reference,ctx.sharedTask ? sid : undefined) : this.options.resolveAttachment ? this.options.resolveAttachment(reference,ctx,sid) : Promise.reject(new Error('ATTACHMENT_RESOLVER_REQUIRED'))},id,value,context,row.workDir,()=>this.guard(context),lifecycle);
  }
  private async messages(id: string, options: Record<string, unknown>, internal = false) {
    const {messages, persistence} = await this.conversations;
    // Accepted writes and native history imports share the original reader. The
    // transport never reconstructs messages from provider event text.
    await persistence.drainPersistQueue();
    if (!internal) return messages.readMessagesList(id, options);
    const limit = typeof options.limit === 'number' ? options.limit : 200;
    const rows: Awaited<ReturnType<typeof messages.readMessagesList>> = [];
    let before = options.before;
    for (;;) {
      const page = await messages.readMessagesList(id, {...options, limit: Math.min(100, limit - rows.length), before});
      rows.push(...page);
      if (page.length < Math.min(100, limit - rows.length + page.length) || rows.length >= limit || !page.length) return rows;
      before = page.at(-1)!.id;
    }
  }
  historyDeps(): import('@cindy/mcps').XdtHelperHistoryDeps {
    return this.history.deps;
  }
  async companionHistory() {
    const conversations=await this.conversations;
    const media=await this.media.persisted();
    const database=await this.database;
    this.guard({source:'local'});
    await conversations.persistence.drainPersistQueue();
    return createCompanionLocalHistory({
      getDbClient:()=>{this.guard({source:'local'});return database.getDbClient();},
      createMessage:(...args)=>{this.guard({source:'local'});return conversations.messages.createMessage(...args);},
      commitChatImageUrls:(...args)=>{this.guard({source:'local'});return media.commitChatImageUrls(...args);},
    });
  }
  async restoreArchivedSessionForSend(id: string, options: SessionRestoreOptions = {}) {
    this.guard({ source: 'local' });
    return this.sessions.service.restoreArchivedSessionForSend(id, options);
  }

  private async patchMeta(id: string, patch: Record<string, unknown>, guard: () => void = () => {}) {
    guard();
    const result = await this.sessions.service.patchSessionMetaInDb(id, patch, { beforeWrite: guard });
    await this.storage.get(id);
    this.emit('terminal:tasks:changed', { sessionId: id });
    return result;
  }

  close(options?: { reason: 'app-quit' | 'account-boundary' }): Promise<void> {
    if (!this.closing) this.shutdownReason = options?.reason ?? 'app-quit';
    this.closing ??= (async()=>{
      const errors:unknown[]=[];
      try{await this.shutdown();}catch(error){errors.push(error);}
      try{await this.piRuntimeOwner.close(this.shutdownReason);}catch(error){errors.push(error);}
      try{await this.bots?.close();}catch(error){errors.push(error);}
      try{await this.mediaRuntime?.close();}catch(error){errors.push(error);}
      this.dataClosed = true;
      if(!this.options.database){try{await this.database.then(db=>db.close(),()=>undefined);}catch(error){errors.push(error);}}
      if(errors.length===1)throw errors[0];
      if(errors.length>1)throw new AggregateError(errors,'Task host shutdown failed');
    })();
    return this.closing;
  }
  private async shutdown() {
    this.closed = true;
    for (const id of this.idleReclaimTimers.keys()) this.cancelIdleReclaim(id);
    await Promise.allSettled([...this.idleReclaimAttempts]);
    this.unregisterPathAuthorization();
    this.botWelcomeReceipts.close();
    this.utilityAbort.abort();
    await this.bots?.close();
    await this.mediaRuntime?.close();
    this.conversationRuntime?.activeTurn.freezeSessionActiveTurnMarkers();
    this.sessions?.archive.setSessionArchiveSyncRequester(null);
    await this.nativeArchive?.close();
    await this.sessions?.service.stopDeletedPiSubagentCleanup();
    this.sessionActivity?.close();
    this.usageWaits?.suspendUsageLimitWaits();
    const earlyGoals=this.goals;
    await earlyGoals?.close();
    await this.worktrees?.close();
    await this.sessions?.service.flushSessionWorktreeRecycle();
    this.orcaIdle.stop();
    this.orcaRemoteController.stop();
    this.utilityAbort.abort();
    await this.utility.close();
    const recovery = [...this.inputSessions].map(id => this.cancelTaskRecovery(id));
    const channelHandlers = this.channelControl.close();
    await this.channelOrchestrators.close();
    await channelHandlers;
    this.turnLifecycle.close();
    for (const id of this.inputSessions) this.inputCoordinator?.setExecutionPaused(id, true);
    // Initializers have all settled even when one failed. Close the stores and
    // native handles that did open; the start caller retains the original error.
    await this.ready.catch(()=>{});
    this.conversationRuntime?.activeTurn.freezeSessionActiveTurnMarkers();
    this.sessions?.archive.setSessionArchiveSyncRequester(null);
    await this.nativeArchive?.close();
    await this.sessions?.service.stopDeletedPiSubagentCleanup();
    this.usageWaits?.suspendUsageLimitWaits();
    await this.sessions?.service.flushSessionWorktreeRecycle();
    await this.usageWaits?.flushUsageLimitWaits();
    if(this.goals!==earlyGoals)await this.goals?.close();
    await this.history?.close();
    this.usageApi?.close();
    this.usage?.accounts.close();
    await Promise.allSettled(this.utilityWork);
    await Promise.allSettled(recovery);
    await Promise.allSettled(this.starts.values());
    for(const entry of this.taskActionConfirm.pendingSnapshots())this.taskActionConfirm.cleanupForSession(entry.sessionId,'session_closed');
    for (const id of this.inputSessions) this.inputCoordinator?.onSessionClosed(id);
    await Promise.allSettled(this.steerOperations);
    await Promise.all([...this.live.keys()].map(id => this.closeTask(id)));
    await this.skillReader?.close();
    await this.sshRuntime?.close();
    await this.deviceTools.close();
    this.eventRuntime?.close();
    this.workdirs?.close();
    await this.gitSnapshots?.close();
    await this.generatedImages?.close();
    await this.turnLifecycle.flush();
    await (await this.conversations).persistence.drainPersistQueue();
    await Promise.all([...this.inputSessions].map(id => this.conversationRuntime.activeTurn.drainSessionActiveTurnWrites(id)));
    this.makerObservers.clear();
    this.channelVendorOptions.clear();
    for (const row of await this.storage.list()) this.routes.credentials.clear(row.id);
    this.routes.providers.clearAllSessionProviders();
    this.lastLiveUsage.clearAllSessionLastLiveUsage();
    this.botGroupChat?.dispose();
    this.botGroupChat=undefined;
    this.eventBindings.botGroupChat=undefined;
    this.botDelegations?.dispose();
    this.botDelegations=undefined;
    this.runtimeAxes.clearAllSessionRuntimeAxes();
    this.runtimeControl.clearAllSessionRuntimeControlStates();
    this.channelHydration.clear();
    const inputStore = (await this.database).inputQueue;
    await Promise.all([...this.inputSessions].map(id => inputStore.awaitAgentInputQueueSnapshotPersistence(id)));
    await this.taskContext.close();
    await this.orcaStore.close();
    await this.channelBindings.close();
    await this.channelDefaults.close();
    await this.capabilities.close();
    await this.mcpApps.close();
    await Promise.allSettled([...this.hosted].map(handle => handle.close()));
    await Promise.all([this.storage.flush(), this.models.close(), this.media.close(), this.changes.close()]);
    await this.worktrees?.taskLeases.flush();
  }
}
