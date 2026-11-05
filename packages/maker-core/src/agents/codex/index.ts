Warning: truncated output (original token count: 199437)
Total output lines: 15691

/**
 * CodexAgent — 路线 A 完整版 (Phase 1+2+3+4 全打通)。
 *
 * Transport: 自家 AppServerHost (shared codex app-server 子进程 + JSON-RPC NDJSON),
 * 完全取代 @openai/codex-sdk。
 *
 * 能力清单 (vs Phase 1):
 *  - ✅ 基础对话: thread/start + turn/start + turn/interrupt + 7 类 notification 翻译
 *  - ✅ Resume:    thread/resume (Phase 3) — archive→unarchive 真续聊, 不开新 thread
 *  - ✅ Approval:  setRequestHandler 接 commandExecution / fileChange RequestApproval
 *                  → dispatchInteraction (复用 Claude 那条 PermissionPrompt 通道)
 *  - ✅ 运行时切:  setModel / setEffort / setPermissionMode 都生效, 下一 turn 自动透传
 *  - ✅ Fork:      thread/fork(lastTurnId)；分页历史查询原生边界，旧 daemon 回退 rollback
 *  - ✅ oneShot:   走 host 临时 thread (起标题), Phase 4 删 SDK dep 后唯一通路
 *
 * 输出契约:
 *  - AgentSessionHandle 只暴露 provider-neutral 的可选能力，不泄漏 Codex
 *    thread / app-server 协议类型
 *  - 事件流只 emit 已存在的 AgentEvent type union 成员
 *  - renderer 不感知 thread_id / app-server 任何概念
 */

import {
  describeDeviceHostedLinkActivity,
  deviceHostedEnvironmentNote,
  deviceHostedGhostRoster,
  deviceHostedGuestSessionRoot,
  isInsideDeviceHostedRoot,
  stripTrailingSlashes,
} from '../shared/device-hosted.js';
import {
  assertNoCodexUserInstructions,
  CODEX_DEVICE_HOSTED_GUEST_THREAD_CONFIG,
  codexGuestFeatureOverrides,
  listCodexFeatures,
  withoutCodexSpawnModelOverrides,
} from './device-hosted-guest.js';
import { LIBRARY_READ_ROOT, withLibraryNativeReadContext } from '../shared/library-native-read.js';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { structuredPatch } from 'diff';
import { syncCodexArchiveState } from './archive-state.js';
import { readCodexThreadMcpServerTools } from './mcp-server-tools.js';
import { readAccountRateLimitsWithRefresh } from './app-server/account-rate-limits.js';

import {
  BaseAgent,
  LOCAL_AGENT_CLIENT,
  INHERITED_CAPABILITY_SELECTION,
  PINNED_SKILL_INVOCATION,
  CodexResumePreparationBlockedError,
  OneShotError,
  AgentNotAuthenticatedError,
  AgentStartupStoppedError,
  TurnPermissionPolicyUnsupportedError,
  type AgentSessionHandle,
  type AgentDeps,
  type CodexExtraSpawnConfig,
  type StartSessionOptions,
  type OneShotOptions,
  type PinnedSkillInvocation,
  type RefreshLocalModelsOptions,
  type SendOptions,
  type TurnPermissionPolicy,
} from '../base-agent.js';
import { skillEntryPath, snapshotDisabledSkillLaunch, currentDisabledSkillLaunchPaths } from '../shared/skill-activation.js';
import { snapshotManagedSkillGrants } from '../shared/managed-skill-policy.js';
import type { AgentCredentialMode } from '../../interfaces/auth-adapter.js';
import type {
  Capabilities,
  EffortDescriptor,
  PermissionModeDescriptor,
} from '../../types/capabilities.js';
import type {
  AgentEvent,
  ForkSdkSessionOptions,
  ForkSdkSessionResult,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
  UsageSnapshot,
} from '../../types/events.js';
import { isTurnWatchdogLivenessEvent } from '../../types/events.js';
import type { AuthState, Effort, PermissionMode, UserMessage } from '../../types/common.js';
import type {
  AgentBuiltinCommand,
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from '../../types/palette.js';
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import type {
  MemoryStatus,
  MemorySetResult,
  MemoryResetResult,
} from '../../types/memory.js';
import type {
  AccountRateLimitsResponse,
  ConsumeAccountRateLimitResetCreditParams,
  ConsumeAccountRateLimitResetCreditResponse,
} from '../../types/account-rate-limits.js';
import {
  capabilitySelectionAddedByPlanEdit,
  findCapabilityRouteOverride,
  isCapabilityRouteInvocationAllowed,
} from '../../types/capability-routing.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import {
  assertReviewMessageContentPaths,
  buildReviewReadGrants,
} from '../shared/review-read-scope.js';
import { REVIEW_READ_TOOLS, callReviewReadTool, isWindowsReviewLocalPath, reviewReadDenied } from './review-read-tools.js';
import {
  annotatePermissionRequestForAutoReview,
  composeAutoReviewIntentWithApprovedPlan,
  composeAutoReviewIntentWithClarification,
  createAutoReviewConfirmUndeliveredNotice,
  createAutoReviewUnavailableNotice,
  extractAutoReviewUserIntent,
  appendAutoReviewUserIntent,
  normalizeAutoReviewUserIntent,
  createAutoReviewActionContext,
  type AutoReviewUserIntent,
  isSystemPermissionDenialReason,
  formatPermissionDenial,
  resolveAutoReviewDecision,
  withAutoReviewContext,
  toolAutoReviewAction,
  type AutoReviewDecision,
} from '../shared/auto-review-decision.js';
import type { ReviewableAction } from '../shared/auto-review.js';
import { UsageTracker } from '../shared/usage-tracker.js';
import { attachLiveGeneration, sampleGenerationDuration } from '../shared/live-generation-snapshot.js';
import { getDefaultImageResizer } from '../shared/image-resizer.js';
import { formatManagedImageReferences } from '../shared/managed-image-reference.js';
import { REVIEW_SENSITIVE_CREDENTIAL_GLOB_PATTERNS } from '../shared/sensitive-credential-paths.js';
import { pickTurnStartStatus, type OneShotState } from '../shared/turn-start-phrases.js';
import {
  OVERLOAD_RETRY_MAX_ATTEMPTS,
  overloadRetryDelayMs,
  parseOverloadError,
} from '../shared/overload-error.js';
import { isRemoteCompactEncryptedContentError } from '../shared/remote-compact-encrypted-error.js';
import { listCodexModels } from './app-server/list-models.js';
import { buildCodexEnv } from './env-builder.js';
import type { CodexErrorInfo } from './app-server/protocol.js';
import {
  buildCodexBotSkillConfigOverrides,
  buildCodexBotMcpConfigOverrides,
  buildCodexCapabilityConfigOverrides,
  buildCodexCapabilitySkillConfigOverrides,
  buildCodexSessionCapabilityRoutingPolicy,
  mergeCodexSkillConfigOverrides,
  requiresCodexCapabilitySkillDiscovery,
} from './capability-routing.js';
import { scanCodexCustomizations } from './customization-scanner.js';
import { commandExecutionDisplayInput } from './command-display.js';
import { asyncUserInputQuestions } from './async-user-input.js';
import {
  codexUserAgentAtLeast,
  supportsCodexThreadRollback,
  supportsCodexApprovalsReviewerProtocol,
  supportsCodexReadonlyReferenceDirs,
  supportsCodexCapabilityRoutingProtocol,
  supportsCodexResumeExcludeTurns,
  supportsCodexForkExcludeTurns,
  supportsCodexNativeTurnFork,
} from './version-gates.js';
import {
  emptyUserInputResponse,
  normalizeRequestUserInputQuestions,
  normalizeDynamicAskUserQuestions,
  questionsToAskUserItems,
  responseFromAskUserAnswers,
  responseFromPermissionDecision,
  dynamicToolResponseFromUserInput,
  userInputQuestionsFingerprint,
  userInputAnswersByPosition,
  responseFromUserInputAnswersByPosition,
  hasSubmittedUserInput,
  formatAskUserContinuationMessage,
  MAX_REQUEST_USER_INPUT_QUESTIONS,
  MAX_REQUEST_USER_INPUT_OPTIONS,
  type UserInputAnswersByPosition,
} from './request-user-input.js';
import {
  dedupeCells,
  extractAliveYieldCellsFromCodexItem,
  extractSettledYieldCellIdsFromCodexItem,
  extractYieldedExecCellsFromCodexItem,
  formatYieldContinuationPrompt,
  type YieldedExecCell,
} from './yielded-exec-cell.js';
import {
  newCodexRuntimeState,
  isAuthRelatedErrorMessage,
  classifyCodexError,
  translateErrorNotification,
  translateItemNotification,
  beginCodexGenerationTurn,
  codexGenerationDurationMs,
  finalizeCodexGenerationTurn,
  finishCodexSamplingTurn,
  pauseCodexGeneration,
  resetCodexGenerationTiming,
  resumeCodexGeneration,
  translateAgentMessageDelta,
  translateReasoningSummaryTextDelta,
  translateReasoningSummaryPartAdded,
  translateReasoningTextDelta,
  translateAccountRateLimitsUpdated,
  translatePlanUpdatedNotification,
  extractRolloutUpdatePlanFunctionCallEvent,
  finalizeCodexCitationText,
  readCodexSubagentSpawnRegistration,
  type CodexRuntimeState,
} from './translator.js';
import {
  createSubagentLiveCardTracker,
  type SubagentLiveCardUpdate,
  type SubagentSpawnItemPhase,
} from './subagent-live-cards.js';
import {
  TurnRetryTracker,
  RETRY_ESCALATION_MAX_ELAPSED_MS,
  buildBackendUnreachableMessage,
  type OutboundPathFact,
} from './retry-escalation.js';
import {
  CompactionStormTracker,
  buildCompactionStormTerminalError,
} from './compaction-storm.js';
import {
  assertCodexRolloutRewriteSupported,
  readCodexRolloutModelProvider,
  sanitizeCodexForkRolloutFileInPlace,
} from './rollout-sanitize.js';
import { hasCurrentTeammateInstructions, teammateRuntimeInstructionItem } from './teammate-runtime-instructions.js';
import { CodexHistoryRecoveryRequiredError, isCodexHistoryRecoveryRequired } from './history-recovery.js';
import { CodexForkError, type CodexForkStage } from './fork-error.js';
import { resolveForkTurnAnchor } from './fork-turn-anchor.js';
import { parseReconnectAttemptMessage } from '../shared/network-error.js';
import { extractNonSecretErrorSignals } from '@cindy/maker-shared/error-redaction';
import { AppServerHost, CodexNativeInitializationStoppedError, type ThreadEventHandlers, type ThreadSubscription } from './app-server/host.js';
import { AppServerRequestTimeoutError, type RequestProgressDeadline } from './app-server/client.js';
import { useCodexHistoryHome, type CodexExternalAuth } from './app-server/external-auth.js';
import {
  isTerminalRateLimitRetryExhaustion,
  TERMINAL_RATE_LIMIT_RETRY_MAX_ATTEMPTS,
  terminalRateLimitRetryDelayMs,
} from './terminal-rate-limit-retry.js';
import { createStdioTransport } from './app-server/stdioTransport.js';
import { CodexInteractionBroker } from './interaction-broker.js';
import { SYSTEM_PROMPT_APPEND as MAKER_CODEX_SYSTEM_PROMPT_APPEND } from './system-prompt-append.js';
import { nativeAutoReviewContinuationConfig } from './native-auto-review-policy.js';
import { sendCodexApprovalFeedback } from './approval-feedback.js';
import { MAKER_MEMORY_RULES } from '../../memory/system-prompt.js';
import { MemoryFlushController } from '../../memory/flush-controller.js';
import { resolveMemoryScopeKey } from '../../memory/scope-resolver.js';
import { CODEX_AGENT_COMMANDS } from './commands.js';
import {
  canReuseCodexHostForCredentialMode,
  isCindyProviderCodexRemoteCompactionRoute,
  resolveAgentCredentialMode,
  resolveEffectiveCredentialModeFromAuthSource,
} from '../credential-mode.js';
import {
  Method,
  codexErrorInfoTag,
  type AskForApproval,
  type ApprovalsReviewer,
  type ApprovalDecision,
  type ItemGuardianApprovalReviewCompletedNotification,
  type ItemGuardianApprovalReviewStartedNotification,
  type GuardianWarningNotification,
  type CodexModelListResponse,
  type CommandExecutionRequestApprovalParams,
  type CommandExecutionRequestApprovalResponse,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type DynamicToolSpec,
  type ItemEnvelope,
  type FileChangeRequestApprovalParams,
  type FileChangeRequestApprovalResponse,
  type McpServerElicitationRequestParams,
  type CollaborationModeParam,
  type McpServerElicitationRequestResponse,
  type CodexMcpServerStatusListResponse,
  type PermissionsRequestApprovalParams,
  type PermissionsRequestApprovalResponse,
  type ServerRequestResolvedNotification,
  type SandboxMode,
  type SandboxPolicy,
  type ServiceTier,
  type SkillMetadata,
  type SkillsListResponse,
  type ThreadForkParams,
  type ThreadForkResponse,
  type ThreadRollbackParams,
  type ThreadRollbackResponse,
  type ThreadTurnsListParams,
  type ThreadTurnsListResponse,
  type ThreadResumeParams,
  type ThreadResumeResponse,
  type ThreadSettingsUpdateParams,
  type ThreadSettingsUpdateResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type ToolRequestUserInputParams,
  type ToolRequestUserInputQuestion,
  type ToolRequestUserInputResponse,
  type TokenUsageBreakdown,
  type TurnPlanUpdatedNotification,
  type TurnStartParams,
  type TurnStartResponse,
  type UserInput,
} from './app-server/protocol.js';

interface TurnReplayRetryPolicy {
  kind: 'capacity' | 'terminal-rate-limit';
  maxAttempts: number;
  delayMs: (attempt: number) => number;
}

const CAPACITY_RETRY_POLICY: TurnReplayRetryPolicy = {
  kind: 'capacity',
  maxAttempts: OVERLOAD_RETRY_MAX_ATTEMPTS,
  delayMs: overloadRetryDelayMs,
};

const TERMINAL_RATE_LIMIT_RETRY_POLICY: TurnReplayRetryPolicy = {
  kind: 'terminal-rate-limit',
  maxAttempts: TERMINAL_RATE_LIMIT_RETRY_MAX_ATTEMPTS,
  delayMs: terminalRateLimitRetryDelayMs,
};

type CodexEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

const CODEX_MINIMAL_EFFORT_MODELS = new Set([
  'bytedance-seed/seed-2.1-pro',
  'z-ai/glm-5.2',
  // Muse Wonder：XD Gateway ID 与 Meta Model API 官方 ID（自定义连接经 alias 继承同一档位）。
  'meta/muse-wonder-1.0',
  'muse-wonder-1.0',
]);

/**
 * item.type → chip status 文案 (对齐 claude-code 6 类). null = 该 item 不触发 chip 切换
 * (imageView/plan/userMessage/hookPrompt 等是 completed-only 或 UI 不暴露的 item)。
 */
function statusTextForItem(item: { type?: string; command?: string; tool?: string; kind?: string }): string | null {
  switch (item.type) {
    case 'reasoning':            return 'Thinking...';
    case 'agentMessage':         return 'Generating...';
    case 'commandExecution': {
      // command 首词在 Windows 下可能是 `"C:\\...\\powershell.exe"` 完整路径带引号 —
      // 直接拿会刷出超长 chip。剥引号 → 取 basename → 去 .exe 后缀, 显示 `powershell running...`。
      const firstToken = (item.command ?? '').trim().split(/\s+/)[0] ?? '';
      const unquoted = firstToken.replace(/^["']|["']$/g, '');
      const basename = unquoted.split(/[\\/]/).pop() || '';
      const head = basename.replace(/\.exe$/i, '') || 'shell';
      return `${head} running...`;
    }
    case 'fileChange':           return 'Editing files...';
    case 'mcpToolCall':          return `${item.tool ?? 'mcp'} running...`;
    case 'dynamicToolCall':      return `${item.tool ?? 'tool'} running...`;
    case 'collabAgentToolCall':  return `${item.tool ?? 'agent'} running...`;
    // interacted/interrupted 活动(followup/send/interrupt 的伴生事件)不是新代理
    // 启动,不闪启动状态 —— itemStarted 在 translator 静默这些 kind 之前就会推 chip。
    case 'subAgentActivity':     return item.kind === 'started' ? 'Spawning agent...' : null;
    case 'webSearch':            return 'Searching web...';
    case 'imageGeneration':      return 'Generating image...';
    case 'contextCompaction':    return 'Compacting...';
    default:                     return null;
  }
}

/**
 * maker Effort → Codex app-server 可透传档。
 *
 * Seed 2.1 Pro、GLM-5.2 与 Muse Wonder 的官方档位包含 minimal，原样下发；其他模型继续
 * 把 minimal 收敛到 low。max / ultra 直接透传，不再静默降级为 xhigh(issue #352)。
 * 某模型是否真支持某档位由目录 efforts 与 UI/reconcile 门控保证。
 */
function clampEffortForCodex(model: string, e: Effort): CodexEffort | undefined {
  // Desktop's persisted no-effort sentinel is an empty string, not a Codex enum.
  // Keep it in session state, but let app-server use its default on the wire.
  if (!e) return undefined;
  if (e === 'minimal' && !CODEX_MINIMAL_EFFORT_MODELS.has(model)) return 'low';
  return e;
}

function normalizeTailTurnsToDrop(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Codex app-server 对分页线程(0.153+ 的 SQLite 索引历史)拒绝 thread/rollback:
 * JSON-RPC -32600 "paginated threads do not support thread/rollback"。原地回退
 * 遇到它要改走 thread/fork(lastTurnId) 绕行(#4421),其它错误照常上抛。
 */
export function isCodexPaginatedRollbackUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /paginated threads? do(?:es)? not support thread\/rollback/i.test(message);
}

/**
 * Codex 0.156.0 起 app-server 移除了 deprecated 的 thread/rollback(openai/codex#44915,
 * 官方指引改用 thread/revert / thread/fork)。老客户端仍调它时 daemon 走通用未知方法
 * 拒绝:JSON-RPC -32600 "Invalid request: unknown variant `thread/rollback`, expected
 * one of ..."(#4994)。这类错误与分页拒绝同样意味着「原地回退不可用」,要改走
 * thread/fork(lastTurnId) 而不是裸抛成「编辑重发失败,请重试」。
 */
export function isCodexRollbackMethodRemovedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /unknown variant [`'"]?thread\/rollback[`'"]?/i.test(message);
}

/** thread/rollback 因分页线程或运行时已移除而不可用,都应改走原生 turn 边界 fork。 */
export function isCodexRollbackUnavailableError(error: unknown): boolean {
  return isCodexPaginatedRollbackUnsupportedError(error) || isCodexRollbackMethodRemovedError(error);
}

function normalizeNativeForkTurnId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function nativeForkAnchorAgentMeta(threadId: string, turnId: string): Record<string, unknown> {
  return {
    nativeForkAnchor: {
      agentKind: 'codex',
      sdkSessionId: threadId,
      kind: 'turn',
      id: turnId,
    },
  };
}

function prefixId(value: string | undefined): string | undefined {
  return value ? value.slice(0, 8) : undefined;
}

function isRemoteLikePath(p: string): boolean {
  return p.startsWith('/') && process.platform === 'win32';
}

function buildCodexDeveloperInstructions(parts: {
  makerMemoryRules?: string;
  ghostRosterPrompt?: string;
  runtimeSystemPrompt?: string;
  makerMemoryIndex?: string;
  botProfilePrompt?: string;
  botProfileContextPrompt?: string;
  botUserProfilePrompt?: string;
  userPrompt?: string;
  answerDeliveryPrompt?: string;
}): string {
  return [
    parts.botProfilePrompt,
    parts.answerDeliveryPrompt,
    MAKER_CODEX_SYSTEM_PROMPT_APPEND,
    parts.makerMemoryRules,
    parts.ghostRosterPrompt,
    parts.botProfileContextPrompt,
    parts.runtimeSystemPrompt,
    parts.makerMemoryIndex,
    parts.botUserProfilePrompt,
    parts.userPrompt,
  ]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join('\n\n');
}

/**
 * Build the host-map key for a (potentially remote) session.
 *
 * The CodexAgent keeps one `AppServerHost` per "target" — local spawn vs
 * each distinct remote ssh host. Reusing a host across sessions in the same
 * target is load-bearing: the codex app-server caches initialize state +
 * keeps a single thread namespace per process, so two sessions on the same
 * remoteHostId MUST land on the same host instance.
 *
 * Empty / undefined / null / falsy remoteHostId → 'local' (a missing remote
 * id is always interpreted as "run on this machine", never as a sentinel
 * remote alias).
 *
 * Exported as a module-level pure function so the routing rule has unit
 * coverage independent of the CodexAgent class (which is otherwise hard to
 * instantiate without full host deps).
 */
export function hostKey(remoteHostId?: string | null): string {
  return remoteHostId ? `remote:${remoteHostId}` : 'local';
}

/** Preserve legacy identities unless the concrete route excludes official OAuth. */
export function codexLocalAuthHostIdentity(key: string, policy?: 'isolated' | 'legacy-shared'): string {
  return policy === 'isolated' ? `${key}:external-auth` : key;
}

/** One identity calculation for initial creation, route reselection and writer handoff. */
function localSessionHostIdentity(input: {
  sessionId: string;
  remoteHostId?: string;
  accountSessionHost: boolean;
  accountProviderId?: string;
  reviewMode: boolean;
  customContext: boolean;
  storage?: { sqliteHome: string; historyHome: string };
  policy: 'isolated' | 'legacy-shared';
  environmentIdentity?: string;
  /** 受邀者会话用独立的 CODEX_HOME，每个任务一个 app-server(同一受邀者目录可被多个任务共用)。 */
  guestSession?: boolean;
}): string {
  const base = input.accountSessionHost
    ? `local-account:${input.accountProviderId ?? 'openai'}:session:${input.sessionId}`
    : input.guestSession ? `${LOCAL_GUEST_HOST_PREFIX}${input.sessionId || randomUUID()}`
    : input.reviewMode ? localReviewHostKey(input.sessionId)
      : input.customContext ? localCustomContextHostKey(input.sessionId) : hostKey(input.remoteHostId);
  return codexLocalAuthHostIdentity(base + (input.environmentIdentity ? `:environment:${input.environmentIdentity}` : '') + (input.storage
    ? `:storage:${input.storage.sqliteHome}:history:${input.storage.historyHome}` : ''), input.policy);
}

const LOCAL_CONTROL_PLANE_HOST_PREFIX = 'local-control:';
/** 受邀者(供应商分享)任务的 app-server：独立 CODEX_HOME，随任务关闭退役。 */
const LOCAL_GUEST_HOST_PREFIX = 'local-guest:';
// One bridge is shared by every local host, including account and utility hosts.
const LOCAL_MCP_REFRESH_KEY = 'local-mcp-refresh';
const LOCAL_CONFIGURATION_CHANGE_KEY = LOCAL_MCP_REFRESH_KEY;
// Only raised before a caller sends a thread RPC; safe to select a fresh route.
class CodexRouteSelectionChangedError extends Error {
  constructor(message = 'Codex route changed during startup', readonly retryable = true) { super(message); }
}

async function awaitCodexRouteSelection<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const CODEX_MODEL_LIST_RPC_TIMEOUT_MS = 20_000;
const CODEX_MODEL_REFRESH_DEADLINE_MS = 20_000;

function localControlPlaneHostKey(credentialMode: AgentCredentialMode): string {
  return `${LOCAL_CONTROL_PLANE_HOST_PREFIX}${credentialMode}`;
}

function isLocalControlPlaneHostKey(key: string): boolean {
  return key.startsWith(LOCAL_CONTROL_PLANE_HOST_PREFIX);
}

/**
 * 一次性 fork host key。thread/fork 的响应体与源 thread 历史成正比、无上界,
 * 不能与正在服务活跃 session 的共享 host 同进程 —— 单条超限 NDJSON 会熔断整条
 * 连接,把无关 session 一起拖下水(故障半径隔离,见 forkSdkSession)。
 * 随机后缀保证并发 fork 互不复用。
 */
const LOCAL_FORK_HOST_PREFIX = 'local-fork:';

function localForkHostKey(): string {
  return `${LOCAL_FORK_HOST_PREFIX}${randomUUID()}`;
}

function isLocalForkHostKey(key: string): boolean {
  return key.startsWith(LOCAL_FORK_HOST_PREFIX);
}

/** Review threads use a one-session app-server so native Codex memory cannot leak in. */
const LOCAL_REVIEW_HOST_PREFIX = 'local-review:';
/** Codex Desktop's built-in Apps server has no user-configurable MCP transport. */
const CODEX_APPS_MCP_SERVER_NAME = 'codex_apps';

function localReviewHostKey(sessionId: string): string {
  return `${LOCAL_REVIEW_HOST_PREFIX}${sessionId || randomUUID()}`;
}

function isLocalReviewHostKey(key: string): boolean {
  return key.startsWith(LOCAL_REVIEW_HOST_PREFIX);
}

/** Explicit custom windows need a static catalog, so each such session gets its own app-server. */
const LOCAL_CUSTOM_CONTEXT_HOST_PREFIX = 'local-custom-context:';

function localCustomContextHostKey(sessionId: string): string {
  return `${LOCAL_CUSTOM_CONTEXT_HOST_PREFIX}${sessionId || randomUUID()}`;
}

function isLocalCustomContextHostKey(key: string): boolean {
  return key.startsWith(LOCAL_CUSTOM_CONTEXT_HOST_PREFIX);
}

/**
 * maker permissionMode → app-server { approvalPolicy, approvalsReviewer, sandbox }。
 *
 * Phase 2 起 'ask' 走 'on-request' — server 真发 CommandExecutionRequestApproval,
 * 我们 setRequestHandler 接住转 dispatchInteraction → UI 弹 PermissionPrompt。
 */
type CodexPermissionConfig = {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  approvalsReviewer?: ApprovalsReviewer;
};
function mapPermissionToCodex(
  permissionMode: string | undefined,
  approvalsReviewerProtocolSupported: boolean,
  approvalsReviewerRouteSupported: boolean,
): CodexPermissionConfig {
  const manualApprovalConfig: CodexPermissionConfig = {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    ...(approvalsReviewerProtocolSupported ? { approvalsReviewer: 'user' } : {}),
  };
  // 严格 kebab-case (v2.rs serde rename_all="kebab-case"), camelCase 会被 server -32600 reject
  switch (permissionMode) {
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'auto':
      if (!approvalsReviewerProtocolSupported || !approvalsReviewerRouteSupported) {
        // 旧 app-server 或未验证 reviewer 模型路由时回退到人工 on-request。
        // 不能用 untrusted:它拒绝 require_escalated,即使用户批准普通命令,
        // 网络/沙箱外写入仍会留在受限 sandbox 内。新版协议显式写 user,
        // 还可覆盖恢复 thread 中 sticky 的 auto_review;旧版则安全省略未知字段。
        return manualApprovalConfig;
      }
      // Codex app-server 原生 auto_review 与 Claude Auto 的分工一致:
      // 常规 workspace 动作直接执行,越界动作交给内置 reviewer 判断,而不是交给 UI。
      // workspace-write 仍是硬安全边界; auto_review 只替换审批者,不扩大沙箱。
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' };
    default:
      return manualApprovalConfig;
  }
}

const READONLY_REFERENCES_PERMISSION_PROFILE = 'cindy-readonly-references';
const REVIEW_PERMISSION_PROFILE = 'cindy-review-readonly';
const REVIEW_CREDENTIAL_GLOB_DENIES: Record<string, 'deny'> = Object.fromEntries(
  REVIEW_SENSITIVE_CREDENTIAL_GLOB_PATTERNS.map((pattern) => [pattern, 'deny'] as const),
);

function quoteReviewConfigSegment(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderReviewConfigSegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : quoteReviewConfigSegment(value);
}

function pluginIdFromCodexSkillPath(skillPath: string): string | null {
  const segments = skillPath.replace(/\\/g, '/').split('/');
  for (let index = 0; index < segments.length; index += 1) {
    if (
      segments[index] === 'plugins' &&
      segments[index + 1] === 'cache' &&
      segments[index + 2] &&
      segments[index + 3]
    ) {
      return `${segments[index + 3]}@${segments[index + 2]}`;
    }
    if (
      segments[index] === 'bundled-marketplaces' &&
      segments[index + 1] &&
      segments[index + 2] === 'plugins' &&
      segments[index + 3]
    ) {
      const marketplace = segments[index + 1].replace(/\.staging-[^/]+$/, '');
      return `${segments[index + 3]}@${marketplace}`;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasCodexMcpTransport(value: unknown): boolean {
  const config = asRecord(value);
  return [config.command, config.url].some(
    (transport) => typeof transport === 'string' && transport.trim().length > 0,
  );
}

/**
 * SandboxMode (thread/start 用 kebab enum) → SandboxPolicy (turn/start 用 tag union)。
 * 两者**字段名 + 类型都不一样**, 是 Codex 协议的不对称设计 — turn/start 接 SandboxPolicy
 * 让 server 能在 turn 中途切换更细粒度的沙盒配置。
 *
 * 简单映射: 各模式取默认值 (server 端字段都有 #[serde(default)], 省略即可)。
 *
 * extraWritableRoots: 仅 workspaceWrite 模式生效, 把 workspace 之外的额外路径加进
 * 可写白名单, 让 apply_patch 不被 "writing outside of the project" 预检拦掉。
 * 当前用途: 把 <CODEX_HOME>/memories/ 加进去, 让 codex 自家 MemoryTool 的写入流程
 * (model 用 apply_patch 改 memory_summary.md / MEMORY.md) 不撞预检。
 */
function sandboxModeToPolicy(mode: SandboxMode, extraWritableRoots: string[] = []): SandboxPolicy {
  switch (mode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly' };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        ...(extraWritableRoots.length > 0 ? { writableRoots: extraWritableRoots } : {}),
      };
  }
}

/** maker InteractionDecision.behavior → Codex ApprovalDecision (camelCase serde)。 */
function mapBehaviorToApproval(behavior: 'allow' | 'deny'): ApprovalDecision {
  return behavior === 'allow' ? 'accept' : 'decline';
}

const ASK_USER_DYNAMIC_TOOL_NAMESPACE = 'cindy';
const LEGACY_ASK_USER_DYNAMIC_TOOL_NAMESPACE = 'xdt_maker';
const ASK_USER_DYNAMIC_TOOL_NAME = 'ask_user_question';
const ASK_USER_DYNAMIC_TOOL_CANONICAL_NAME =
  `${ASK_USER_DYNAMIC_TOOL_NAMESPACE}__${ASK_USER_DYNAMIC_TOOL_NAME}`;
const CODEX_SUBAGENT_ASK_USER_QUESTION_DENIAL_MESSAGE =
  'User questions are only available to the root agent. Report the question to the parent agent, which can decide whether to ask the user.';
const DISABLE_ASK_USER_DYNAMIC_TOOL_FALLBACK = process.env.XDT_CODEX_DISABLE_ASK_USER_DYNAMIC_TOOL === '1';
// xAI rejects Codex namespace dynamic tools in its Responses `tools[]` schema.
const CODEX_DYNAMIC_TOOL_UNSUPPORTED_PROVIDER_IDS = new Set(['xai']);

const ASK_USER_DYNAMIC_TOOL: DynamicToolSpec = {
  type: 'function',
  name: ASK_USER_DYNAMIC_TOOL_CANONICAL_NAME,
  description: [
    'Use this tool instead of listing choices or asking in prose when the user asks to choose, pick a direction, select an approach, or narrow options before you continue.',
    'Use it for product preferences, game/design/business directions, business judgments, and choices between materially different approaches.',
    'Use it when the next useful step depends on the user selecting among options, even if you could provide a generic list yourself.',
    'Ask 1 to 3 short questions in a single call when those questions are independent; do not make several back-to-back calls for independent clarification questions.',
    'Use a later follow-up call only when the next question depends on the user answer to an earlier question.',
    'Do not use it for routine implementation details; choose a reasonable default.',
    'This tool does not replace authorization for destructive or external actions.',
    'Codex code-mode returns the awaited result as a JSON string shaped like {"question-id":{"answers":["Choice"]}}; it is not an MCP CallToolResult object.',
    'In functions.exec, use: const raw = await tools.cindy__ask_user_question({ questions: [...] }); const answers = JSON.parse(raw); text(JSON.stringify(answers));',
    'Do not read .content or .structuredContent from the result; expose the raw or parsed answer with text(...) before the exec cell ends.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
      questions: {
        type: 'array',
        description: 'One to three short user-facing questions to ask together. Bundle independent choices into this array instead of calling the tool repeatedly.',
        minItems: 1,
        maxItems: MAX_REQUEST_USER_INPUT_QUESTIONS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question'],
          properties: {
            id: { type: 'string', description: 'Stable answer key for this question.' },
            header: { type: 'string', description: 'Short label shown above the question.' },
            question: { type: 'string', description: 'Clear question text for the user.' },
            options: {
              type: 'array',
              description: 'Optional single-select answer choices. Omit when free-form input is needed.',
              maxItems: MAX_REQUEST_USER_INPUT_OPTIONS,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label'],
                properties: {
                  label: { type: 'string', description: 'Short option label returned as the answer.' },
                  description: { type: 'string', description: 'Brief explanation of when this option is appropriate.' },
                },
              },
            },
            isOther: { type: 'boolean', description: 'Whether the user may provide a free-form answer outside the listed options.' },
          },
        },
      },
    },
  },
};

interface ActiveToolContext {
  type: 'mcpToolCall' | 'dynamicToolCall' | 'fileChange';
  arguments?: unknown;
  changes?: unknown;
  turnId?: string | null;
  server?: string | null;
  /**
   * Codex attaches the owning plugin id to mcpToolCall items. `null` means the
   * configured server is user-owned (including a user server shadowing a
   * plugin server); `undefined` means this app-server did not provide
   * provenance, so routing must fail closed.
   */
  pluginId?: string | null;
  namespace?: string | null;
  tool?: string | null;
}

function isAskUserDynamicTool(params: Pick<DynamicToolCallParams, 'namespace' | 'tool'>): boolean {
  if (params.namespace === null && params.tool === ASK_USER_DYNAMIC_TOOL_CANONICAL_NAME) {
    return true;
  }
  return (
    (params.namespace === ASK_USER_DYNAMIC_TOOL_NAMESPACE ||
      params.namespace === LEGACY_ASK_USER_DYNAMIC_TOOL_NAMESPACE) &&
    params.tool === ASK_USER_DYNAMIC_TOOL_NAME
  );
}

function shouldRegisterAskUserDynamicTool(opts: Pick<StartSessionOptions, 'model' | 'providerId'>): boolean {
  if (DISABLE_ASK_USER_DYNAMIC_TOOL_FALLBACK) return false;
  return supportsCodexDynamicTools(opts);
}

function supportsCodexDynamicTools(
  opts: Pick<StartSessionOptions, 'model' | 'providerId'>,
): boolean {
  const providerId = typeof opts.providerId === 'string' ? opts.providerId.trim() : '';
  if (CODEX_DYNAMIC_TOOL_UNSUPPORTED_PROVIDER_IDS.has(providerId)) return false;
  if (!providerId && opts.model.startsWith('xai/')) return false;
  return true;
}

interface PendingUserInputInteraction {
  interactionPromise: Promise<UserInputAnswersByPosition>;
  cancelledPromise: Promise<void>;
  cancel: () => void;
}

interface LiveAskUserRequest {
  requestId: string;
  turnId: string | null;
  questions: ToolRequestUserInputQuestion[];
  detached: boolean;
  continuationStarted: boolean;
  delivery?: 'async';
  permissionPolicy: TurnPermissionPolicy | null;
  capabilitySelectionText: string;
  autoReviewIntent: AutoReviewUserIntent;
}

function normalizeServiceTier(serviceTier: ServiceTier | null | undefined): ServiceTier | null | undefined {
  return serviceTier === 'priority' ? 'fast' : serviceTier;
}

function fastModeFromServiceTier(serviceTier: ServiceTier | null | undefined): boolean | 'ultrafast' {
  return serviceTier === 'ultrafast' ? 'ultrafast' : normalizeServiceTier(serviceTier) === 'fast';
}

function skillDescription(skill: SkillMetadata): string | undefined {
  return (
    skill.interface?.shortDescription?.trim() ||
    skill.shortDescription?.trim() ||
    skill.description?.trim() ||
    undefined
  );
}

function isPaletteVisibleCodexSkill(skill: SkillMetadata): boolean {
  if (!skill.enabled || skill.scope === 'admin') return false;

  if (skill.scope === 'system') {
    const normalizedPath = skill.path.replace(/\\/g, '/').replace(/\/$/, '');
    return skill.name.toLowerCase() === 'skill-creator'
      && /\/skills\/\.system\/skill-creator(?:\/skill\.md)?$/i.test(normalizedPath);
  }

  // Codex plugins can contribute internal skills and currently report them as scope=user.
  // They remain available to Codex's own dispatch, but Cindy's slash palette should only
  // expose installed user/repo skills instead of every plugin implementation detail.
  const normalizedPath = skill.path.replace(/\\/g, '/');
  return !/\/plugins\/cache\/[^/]+\/[^/]+\/[^/]+\/skills\//i.test(normalizedPath);
}

function paletteVisibleCodexSkills(skills: readonly SkillMetadata[]): SkillMetadata[] {
  const visible = skills.filter(isPaletteVisibleCodexSkill);
  const installedNames = new Set(visible
    .filter((skill) => skill.scope !== 'system')
    .map((skill) => skill.name.toLowerCase()));
  return visible.filter((skill) => skill.scope !== 'system' || !installedNames.has(skill.name.toLowerCase()));
}

function selectInvocableCodexSkill(skills: readonly SkillMetadata[], name: string): SkillMetadata | undefined {
  const matching = skills.filter((skill) => skill.enabled && skill.name.toLowerCase() === name.toLowerCase());
  return matching.find((skill) => skill.scope !== 'system' && skill.scope !== 'admin')
    ?? matching[0];
}

function parseLeadingSlashToken(text: string): { name: string; rest: string } | null {
  const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match?.[1]) return null;
  return { name: match[1], rest: match[2] ?? '' };
}

function isExpectedTurnIdMismatchError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return code === -32600 && /expected active turn id\b[\s\S]*\bbut found\b/i.test(message);
}

/**
 * Match the app-server's canonical missing-rollout response. This alone does
 * not prove a thread was unused; indexed history also needs a metadata check.
 * Wrapped messages, other JSON-RPC codes, or populated data are not equivalent.
 */
export function isExactNoRolloutThreadResumeError(error: unknown, threadId: string): boolean {
  return isExactThreadLookupError(error,
    `codex app-server thread/resume error -32600: no rollout found for thread id ${threadId}`);
}

function isExactUnloadedThreadReadError(error: unknown, threadId: string): boolean {
  return isExactThreadLookupError(error,
    `codex app-server thread/read error -32600: thread not loaded: ${threadId}`);
}

/** A native refusal proves no writer was loaded, and the selected route is active. */
function isSavedModelProviderMismatch(error: unknown, selectedProvider: string | undefined): boolean {
  if (!selectedProvider || typeof error !== 'object' || error === null) return false;
  const { code, data } = error as { code?: unknown; data?: Record<string, unknown> };
  return code === -32600 && data?.type === 'modelProviderMismatch'
    && data.currentModelProvider === selectedProvider
    && typeof data.modelProvider === 'string' && data.modelProvider.length > 0
    && data.modelProvider !== selectedProvider;
}

function isExactArchivedThreadResumeError(error: unknown, threadId: string): boolean {
  return isExactThreadLookupError(error,
    `codex app-server thread/resume error -32600: session ${threadId} is archived. Run \`codex unarchive ${threadId}\` to unarchive it first.`);
}

function isExactThreadLookupError(error: unknown, message: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; data?: unknown; message?: unknown };
  return candidate.code === -32600 && Object.hasOwn(error, 'data') && candidate.data === undefined
    && candidate.message === message;
}

// 插话 (steer) 时 turn/steer RPC 的 ack 有界等待上限。AppServerClient.request
// 本身没有超时, app-server 卡死时裸 await 会永久挂起 → coordinator steering marker
// 永久残留 → 后续插话点击被静默吞掉。正常情况下 ack 是毫秒级, 10s 足够宽裕。
const STEER_ACK_TIMEOUT_MS = 10_000;

// 权限收紧 fail-safe 的 turn/interrupt RPC ack 有界等待上限。没有超时的话,
// app-server / 连接无响应时该 RPC 永久悬挂 —— 既不走重试、也不透出失败提示,
// 免审 turn 将无声继续跑 (review #969 第六轮 Greptile P1)。取值与 steer 同款 10s。
const TIGHTEN_INTERRUPT_ACK_TIMEOUT_MS = 10_000;

// Permission profile refresh / replacement runs before turn/start and therefore
// sits on the message acceptance path. Keep its app-server acknowledgement
// bounded so a live-but-unresponsive daemon cannot freeze the queued message or
// ignore Stop.
const PROFILE_LIFECYCLE_ACK_TIMEOUT_MS = 10_000;
// 生命周期请求内层 host.request 在接受期限之外保留的晚到响应窗口(#5772 review): 外层
// requestProfileLifecycle 到点按「did not acknowledge」收口, 但请求可能已在服务端执行
// (thread/start 可能已建出新线程)。内层必须严格晚于外层收口, 晚到响应才能到达 resolveOnce
// 的迟到分支跑 onLateResolve 清理(退订脱线线程 / 退役不确定的 host); 两层同上限会让
// AppServerClient 到点删除 pending、丢弃晚到响应, 清理永远不会执行。窗口到点后由
// AppServerClient 显式删除 pending, 作为超时响应的显式清理。
const PROFILE_LIFECYCLE_LATE_RESPONSE_GRACE_MS = 5 * 60_000;

// The Browser fallback route is resolved before thread/start, so the app-server
// can only answer its readiness query against the global MCP inventory. Keep
// that pre-thread probe bounded: a slow unrelated MCP server must not stretch
// Codex session creation to the companion's full startup timeout (which may be
// as high as 120 seconds). Once a concrete thread exists, callers can use the
// thread-scoped status API instead of this pre-thread path.
const CODEX_BROWSER_USE_READINESS_PROBE_TIMEOUT_MS = 2_000;
// A single short miss can race the MCP child process finishing its cold start.
// Retry once before freezing the thread's capability routing, while keeping a
// genuinely unavailable companion bounded to two short probes.
const CODEX_BROWSER_USE_READINESS_PROBE_ATTEMPTS = 2;

// thread/start / thread/resume / turn/start 的 RPC 上限。AppServerClient.request
// 默认无超时 — 远端 daemon 失联 (SSH 隧道半开 / daemon 挂起但 socket 未断) 时
// 裸 await 永久挂起, session 永远停在 generating (issue #677 同类断链面)。
// 60s 足够覆盖慢 SSH 链路 + daemon 冷启动, 超时后走既有的「启动失败」收口
// (terminal error + Done status)。注意: 超时只代表**我们不再等**, server 侧
// 可能实际已建 thread/turn — 迟到事件按 stale turn 丢弃, 不影响 UI 复位。
const CRITICAL_THREAD_RPC_TIMEOUT_MS = 60_000;
// 设备托管会话(项目在另一台电脑)的上述 RPC 在任务隧道还有往来时顺延(#5764): 线程启动经设备
// 互联逐个读项目说明与 Skill, 实测约 35 轮串行往返, 慢链路下合法地超过 60s。隧道连续 30s 没有
// 往来、或从发出起等满 5 分钟, 仍按超时收口(错误里带链路计数)。
const HOSTED_THREAD_RPC_IDLE_MS = 30_000;
const HOSTED_THREAD_RPC_MAX_MS = 5 * 60_000;
// 设备托管：执行环境已断开时，下一轮开始前查询它状态的上限(只在隧道上已没有执行环境连接时查)。
const HOSTED_ENVIRONMENT_STATUS_TIMEOUT_MS = 10_000;

/**
 * upstream-response-idle watchdog 阈值 — codex 侧对齐 claude-code 的同名机制
 * (claude-code/index.ts parseIdleTimeoutMs)。默认 30min, env
 * `XDT_CODEX_IDLE_TIMEOUT_MS` (ms) 覆盖, 设 0 关闭。
 *
 * 背景: codex 此前只有 willRetry 风暴的终局升级 (retry-escalation.ts) —— 那只覆盖
 * "daemon 在不停重试并如实上报"的情形。daemon **静默**卡死 (后端连接半开、内部
 * 死锁、app-server 不再投递任何通知) 时没有任何兜底, turn 在 UI 上永远转圈。
 *
 * 计时语义与 claude 侧一致: 只在"客户端把 ball 交给上游、等上游回话"期间计时。
 *  - 有未完成的工具类 item (命令执行 / MCP / 动态工具 / web 搜索 / 图像生成) →
 *    停表: 工具执行由 daemon 侧承担, 长 build / 拉大表 / 等审批不该被误杀。
 *  - 投递给上层的**产品进展**事件 (reasoning / text delta / tool item) → 重置。
 *    status / account_usage / 非终态 error / turn_diff 不算（见 isTurnWatchdogLivenessEvent）。
 * 触发后走 turn/interrupt (与用户手动 Stop 同路径, 不销毁 thread), 并推一条终态
 * error, reason 与 claude 侧共用 'upstream_response_idle_timeout'。
 */
const CODEX_UPSTREAM_IDLE_TIMEOUT_DEFAULT_MS = 30 * 60_000;

/** upstream-idle 看门狗的计时分片长度(见 armUpstreamIdleSlice)。 */
const CODEX_UPSTREAM_IDLE_SLICE_MS = 60_000;

/** 分片实际耗时超出片长这么多 → 判为进程被系统挂起过,该片不计入额度。 */
const CODEX_UPSTREAM_IDLE_SUSPEND_GAP_MS = 30_000;

/**
 * Codex app-server `Reconnecting... N/M` 的总等待上限。复用 retry-escalation
 * 的 120s 语义，避免有限重连提示在最后一档之后静默卡住；这是整个重连序列的
 * deadline，不会因为后续的 `2/5`、`3/5` 提示重新计时。
 */
const CODEX_RECONNECT_STALL_TIMEOUT_MS = RETRY_ESCALATION_MAX_ELAPSED_MS;

/**
 * WebSocket 重试用尽后 Codex 改走 HTTPS 时推的 `warning`。之后要先上传完整历史才有事件,
 * 慢网下可达数分钟,不再属于重连序列:清掉重连 deadline,由 Codex 自身 HTTP 超时与
 * upstream-idle 看门狗兜底。
 */
const CODEX_HTTPS_FALLBACK_WARNING_PREFIX = 'Falling back from WebSockets to HTTPS transport';

/** 只含空白、格式字符或控制字符的 text delta 不算重连已经恢复。 */
const CODEX_INVISIBLE_TEXT_PATTERN = /[\s\p{Cf}\p{Cc}]/gu;

function hasVisibleCodexText(text: unknown): boolean {
  return typeof text === 'string' && text.replace(CODEX_INVISIBLE_TEXT_PATTERN, '').length > 0;
}

function parseCodexIdleTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return CODEX_UPSTREAM_IDLE_TIMEOUT_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return CODEX_UPSTREAM_IDLE_TIMEOUT_DEFAULT_MS;
  return Math.floor(n);
}

/**
 * "球不在上游"的 item 类型白名单:这些 item 在 started → completed 之间由 daemon
 * 侧执行(或在等用户审批),期间上游不欠我们回话,idle watchdog 必须停表。
 * 与 translator 的 item 分派保持同一词表(codex/translator.ts)。
 */
const CODEX_TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageGeneration',
  'imageView',
  'fileChange',
]);

/**
 * Codex 权限档的严格度序（数值越大越严）。Codex 只支持 ask / auto /
 * bypassPermissions 三档，其余取值走 clamp 后不会到这里；未知值按最严处理，
 * 让比较偏向「需要中断」而不是放行。
 *
 * 用途：判断过载重投持的**冻结**策略是否比当前选择的档更宽。只比较最近一次
 * 模式转换会漏掉 Full access → Ask → Auto 这类中间态。
 */
function codexPermissionStrictnessRank(mode: PermissionMode): number {
  switch (mode) {
    case 'bypassPermissions':
      return 0;
    case 'auto':
      return 1;
    case 'ask':
      return 2;
    default:
      return 2;
  }
}

// 计划批准后自动发起实施 turn 的固定输入 — 与官方 TUI 逐字一致
// (codex-rs/tui/src/chatwidget/plan_implementation.rs 的
// PLAN_IMPLEMENTATION_CODING_MESSAGE), 模型对这句有训练分布上的既有理解。
const PLAN_IMPLEMENTATION_MESSAGE = 'Implement the plan.';
const CODEX_INHERITED_CAPABILITY_SELECTION = Symbol('codexInheritedCapabilitySelection');
// 计划实施/修订 turn 的**审查意图**:这些 turn 的 message 是固定内部串('Implement the plan.'),
// 直接拿它当 review intent 会让灰区 reviewer 完全看不到用户原始请求与获批计划(codex 报)。
const CODEX_AUTO_REVIEW_INTENT = Symbol('codexAutoReviewIntent');
const CODEX_YIELD_CONTINUATION = Symbol('codexYieldContinuation');
const CODEX_INTERNAL_CONTINUATION = Symbol('codexInternalContinuation');
const CODEX_INTERACTION_CONTINUATION = Symbol('codexInteractionContinuation');
const YIELD_CONTINUATION_MAX_ATTEMPTS = 2;
type CodexInternalSendOptions = SendOptions & {
  [CODEX_INHERITED_CAPABILITY_SELECTION]?: string;
  [CODEX_AUTO_REVIEW_INTENT]?: AutoReviewUserIntent;
  [CODEX_YIELD_CONTINUATION]?: number;
  [CODEX_INTERNAL_CONTINUATION]?: true;
  [CODEX_INTERACTION_CONTINUATION]?: true;
};
type InteractionContinuationClaim = {
  id: number;
  state: 'awaiting' | 'active' | 'cancelled';
  settled: boolean;
  pendingBoundaryEvents: number;
  turnIds: Set<string>;
  requestIds: Set<string>;
  pendingSends: number;
  sendTail: Promise<void>;
  abort: AbortController;
};
type YieldContinuationClaim = {
  id: number;
  state: 'awaiting' | 'active' | 'cancelled';
  cells: YieldedExecCell[];
  settledCellIds: Set<string>;
  pendingBoundaryEvents: number;
  settled: boolean;
  retryCount: number;
  originTurnId: string;
  continuationTurnId: string | null;
  permissionPolicy: TurnPermissionPolicy | null;
  capabilitySelectionText: string;
  autoReviewIntent: AutoReviewUserIntent;
  deferredPlanText: string | null;
  deferredPlanTurnId: string | null;
  deferredPlanCapabilitySelectionText: string;
};
const SYSTEM_PLAN_REVIEW_DISMISSAL_REASONS = new Set([
  'no_listener_attached',
  'no_interaction_resolver',
  'interaction_resolver_error',
  'user_rejected',
]);

// ── 能力声明 (Phase 3 全开) ──────────────────────────────────────────────────

// 模型清单 SSoT 已迁至目录 packages/model-providers/catalog/providers.json。
// availableModels 起始为空,由 host 从 BUNDLED_CATALOG 派生后经 capabilityAdditions 注入
// (见 apps/desktop/src/main/maker-host/catalog-to-descriptors.ts)。

const CODEX_EFFORTS: EffortDescriptor[] = [
  { id: 'low', displayName: 'Low', description: 'Fast responses with minimal reasoning' },
  { id: 'medium', displayName: 'Medium', description: 'Balanced reasoning depth' },
  { id: 'high', displayName: 'High', description: 'Deeper reasoning for harder tasks' },
  { id: 'xhigh', displayName: 'Extra High', description: 'Extended reasoning budget' },
  // max/ultra 仅部分模型支持(如 GPT-5.6 Sol);实际是否可选由该模型目录 efforts 决定,
  // 这里只提供 agent 级档名/描述兜底(桌面 i18n effortLevels.* 优先)。
  { id: 'max', displayName: 'Maximum', description: 'Very high reasoning budget (model-dependent)' },
  { id: 'ultra', displayName: 'Ultra', description: 'Maximum reasoning budget (model-dependent)' },
];

const CODEX_PERMISSION_MODES: PermissionModeDescriptor[] = [
  { id: 'ask', displayName: 'Default permissions', description: '工作区内可读写,需要更多权限时询问' },
  { id: 'auto', displayName: 'Auto', description: '工作区沙箱内自动执行,越界操作交给自动审查器;高风险操作可能拒绝或询问' },
  { id: 'bypassPermissions', displayName: 'Full access', description: '可改任意文件、跑联网命令,免询问;风险高' },
];

const CAPABILITIES: Capabilities = {
  // Phase 3: turn/start 透传 model 即可 — server 接受 per-turn override
  switchModel: { supported: true },
  availableModels: [],
  hasFastMode: true,
  effort: { supported: true },
  effortLevels: CODEX_EFFORTS,
  reasoningDisplay: ['off', 'summarized'],
  permissionModes: CODEX_PERMISSION_MODES,
  setPermissionModeMidSession: { supported: true },
  turnPermissionPolicy: {
    supported: { supported: true },
    // Full access can mutate workspace files without a host approval callback.
    unsupportedPermissionModes: ['bypassPermissions'],
  },
  // 计划模式一级开关: app-server experimental collaborationMode ({ mode:'plan' }) +
  // plan item 捕获 → plan_review 审批 → 批准后自动发起实施 turn (对齐官方 TUI 流程)。
  planMode: { supported: true },
  multimodal: {
    text: { supported: true },
    image: { supported: true },
    file: { supported: true },
  },
  // Phase 3: thread/fork 已实现 (uuidMap 空, Codex 没有 message uuid 概念但不影响 fork 本身)
  fork: { supported: true },
  // Codex app-server 支持 thread/rollback 裁剪对话 turn；它不做文件回滚。
  // 产品的“代码 + 对话”回退由 Git rollback 负责代码部分，再调用此能力裁剪对话。
  rewind: { supported: true },
  abort: { supported: true },
  sameTurnSteer: { supported: true },
  memory: {
    supported: { supported: true },
    displayName: '记忆 (实验性)',
    description: '从对话中生成新记忆并在后续对话中召回 (Codex Feature::MemoryTool, 默认关)',
    stage: 'experimental',
    defaultEnabled: false,
    resettable: true,
    // experimentalFeature/enablement/set 是 in-memory 进程级覆盖, server 自动 reload_user_config
    // 通知所有 live thread, 真正立即生效
    setEnabledMidSession: { supported: true },
  },
  // Codex app-server 0.144.6+ 支持 runtimeWorkspaceRoots + named permission
  // profiles；每 turn 覆盖 roots，因此会话中途增删可在下一 turn 生效。
  extraDirs: { supported: true },
  writableDirs: { supported: true },
};

// ── UserMessage → app-server UserInput[] ─────────────────────────────────────

function stripFileUrl(raw: string): string {
  return raw.startsWith('file://') ? raw.slice('file://'.length) : raw;
}

function basenameForMention(rawPath: string): string {
  const pathWithoutScheme = stripFileUrl(rawPath);
  // CodeQL flags regex-based separator trimming on user-controlled paths as a
  // potential slow-regex sink. Path mention labels only need simple separator
  // handling, so keep this branch deterministic and allocation-light.
  let end = pathWithoutScheme.length;
  while (end > 0 && isPathSeparator(pathWithoutScheme.charCodeAt(end - 1))) {
    end -= 1;
  }
  const trimmed = pathWithoutScheme.slice(0, end);
  const lastPosixSlash = trimmed.lastIndexOf('/');
  const lastWinSlash = trimmed.lastIndexOf('\\');
  const lastSlash = Math.max(lastPosixSlash, lastWinSlash);
  return (lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed) || trimmed || 'file';
}

function isPathSeparator(code: number): boolean {
  return code === 47 || code === 92; // '/' or '\'
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isWindowsPath(rawPath: string): boolean {
  return (
    (
      rawPath.length >= 3 &&
      isAsciiLetter(rawPath.charCodeAt(0)) &&
      rawPath.charCodeAt(1) === 58 &&
      isPathSeparator(rawPath.charCodeAt(2))
    ) ||
    rawPath.startsWith('\\\\')
  );
}

function resolveMentionPath(rawPath: string, workingDir?: string): string {
  const stripped = stripFileUrl(rawPath);
  if (!workingDir) return stripped;
  if (isWindowsPath(stripped) || path.posix.isAbsolute(stripped)) return stripped;
  if (isWindowsPath(workingDir)) return path.win32.resolve(workingDir, stripped);
  if (path.posix.isAbsolute(workingDir)) return path.posix.resolve(workingDir, stripped);
  return path.resolve(workingDir, stripped);
}

function isToolMentionPath(mentionPath: string): boolean {
  return mentionPath.startsWith('app://') || mentionPath.startsWith('plugin://');
}

interface ReferencedPath {
  kind: 'file' | 'dir';
  label: string;
  path: string;
}

const FILES_MENTIONED_HEADER = '# Files mentioned by the user:';
const DIRECTORIES_MENTIONED_HEADER = '# Directories mentioned by the user:';
const USER_REQUEST_HEADER = '## My request for Codex:';

function referencedPathForBlock(
  rawPath: string,
  workingDir: string | undefined,
  kind: 'file' | 'dir' | 'agent' | undefined,
): ReferencedPath {
  const resolved = resolveMentionPath(rawPath, workingDir);
  return {
    kind: kind === 'dir' ? 'dir' : 'file',
    label: basenameForMention(resolved),
    path: resolved,
  };
}

function appendReferencedPathSection(lines: string[], header: string, refs: ReferencedPath[]): void {
  if (refs.length === 0) return;
  if (lines.length > 0) lines.push('');
  lines.push(header, '');
  for (const ref of refs) {
    lines.push(`## ${ref.label}: ${ref.path}`, '');
  }
  lines.pop();
}

function formatReferencedPathsForCodex(refs: ReferencedPath[], requestText: string): string {
  const lines: string[] = [];
  appendReferencedPathSection(lines, FILES_MENTIONED_HEADER, refs.filter((ref) => ref.kind === 'file'));
  appendReferencedPathSection(lines, DIRECTORIES_MENTIONED_HEADER, refs.filter((ref) => ref.kind === 'dir'));

  if (requestText.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(USER_REQUEST_HEADER, requestText);
  }

  return lines.join('\n');
}

function userMessageText(content: UserMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is Extract<(typeof content)[number], { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * 把 UserMessage content 转成 codex app-server 的 UserInput 数组。
 *
 * Async 而非 sync —— LocalImage 的 path 会先经过 image-resizer 透明替换为缩好的
 * 缓存副本路径(命中走缓存近乎 0ms, miss 后台 sharp 处理 ~200-500ms), codex
 * Rust 端读到的就是缩好的文件, 显著节省 vision token。
 *
 * 远程 http(s):// 图片不动 (resizer 不抓远程图)。失败安全降级回原 path。
 */
export async function toAppServerInput(
  content: UserMessage['content'],
  workingDir?: string,
): Promise<UserInput[]> {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }

  const resizer = getDefaultImageResizer();
  // 同 turn 多张本地图并发缩, semaphore 在 resizer 内部控并发上限
  const localImageJobs = new Map<number, Promise<string>>();
  content.forEach((block, idx) => {
    if (block.type !== 'image') return;
    const raw = block.path;
    if (raw.startsWith('http://') || raw.startsWith('https://')) return;
    localImageJobs.set(idx, resizer.process(stripFileUrl(raw)));
  });
  const resizedPaths = new Map<number, string>();
  for (const [idx, p] of localImageJobs) {
    resizedPaths.set(idx, await p);
  }

  type PlannedInput = UserInput | { type: 'referencedPathsPreamble' } | { type: 'requestText'; text: string };
  const inputs: UserInput[] = [];
  const plannedInputs: PlannedInput[] = [];
  const referencedPaths: ReferencedPath[] = [];
  const requestTexts: string[] = [];
  let preambleInserted = false;

  const insertPreambleOnce = (): void => {
    if (preambleInserted) return;
    plannedInputs.push({ type: 'referencedPathsPreamble' });
    preambleInserted = true;
  };

  content.forEach((block, idx) => {
    if (block.type === 'text') {
      requestTexts.push(block.text);
      insertPreambleOnce();
      plannedInputs.push({ type: 'requestText', text: block.text });
    } else if (block.type === 'image') {
      // 协议两个变体 (v2.rs UserInput):
      //   - Image { url: string }       — 远程 http(s):// URL, server fetch
      //   - LocalImage { path: string } — 本地绝对路径, server 自己读 (path 不带 file:// 前缀!)
      // 桌面端附件 99% 是本地图, 走 LocalImage; 只在 path 是 http(s):// 时走 Image。
      const raw = block.path;
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        plannedInputs.push({ type: 'image', url: raw });
      } else {
        // 去掉可能带的 file:// 前缀, server 期望裸路径 (PathBuf)。
        // 优先用 resizer 缩好的副本, miss 时降级回原 path。
        const finalPath = resizedPaths.get(idx) ?? stripFileUrl(raw);
        plannedInputs.push({ type: 'localImage', path: finalPath });
      }
    } else if (block.type === 'file') {
      referencedPaths.push(referencedPathForBlock(block.path, workingDir, 'file'));
      insertPreambleOnce();
    } else if (block.type === 'mention') {
      if (!block.kind && isToolMentionPath(block.path)) {
        plannedInputs.push({ type: 'mention', name: block.name || basenameForMention(block.path), path: block.path });
      } else {
        referencedPaths.push(referencedPathForBlock(block.path, workingDir, block.kind));
        insertPreambleOnce();
      }
    }
  });
  if (referencedPaths.length > 0) {
    const preamble = formatReferencedPathsForCodex(referencedPaths, requestTexts.join('\n'));
    for (const item of plannedInputs) {
      if (item.type === 'referencedPathsPreamble') {
        inputs.push({ type: 'text', text: preamble });
      } else if (item.type === 'requestText') {
        // Text is already folded into the Desktop-style request section.
      } else {
        inputs.push(item);
      }
    }
  } else {
    for (const item of plannedInputs) {
      if (item.type === 'referencedPathsPreamble') {
        // No path references: keep the previous per-block text behavior below.
      } else if (item.type === 'requestText') {
        inputs.push({ type: 'text', text: item.text });
      } else {
        inputs.push(item);
      }
    }
  }
  const managedImageReferences = formatManagedImageReferences(content);
  if (managedImageReferences) inputs.push({ type: 'text', text: managedImageReferences });
  if (inputs.length === 0) inputs.push({ type: 'text', text: '' });
  return inputs;
}

interface ParsedTurnDiffHunk {
  raw: string;
  section: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
  oldLines: string[];
  newLines: string[];
}

type CanonicalTurnDiffHunk = ParsedTurnDiffHunk;

interface ComposedTurnDiffBlock {
  block: string;
  complete: boolean;
}

const MAX_TURN_DIFF_COMPOSE_LINES = 20_000;
const MAX_TURN_DIFF_COMPOSE_HUNKS = 512;
const TURN_DIFF_COMPOSE_TIMEOUT_MS = 50;

function parseTurnDiffHunk(raw: string): ParsedTurnDiffHunk | null {
  const normalized = raw.replace(/\n+$/, '');
  const lineBreak = normalized.indexOf('\n');
  const header = lineBreak >= 0 ? normalized.slice(0, lineBreak) : normalized;
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
  if (!match) return null;
  const lines = lineBreak >= 0 ? normalized.slice(lineBreak + 1).split('\n') : [];
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines) {
    if (line === '\\ No newline at end of file') continue;
    if (line.startsWith('\\')) return null;
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === ' ' || prefix === '-') oldLines.push(content);
    if (prefix === ' ' || prefix === '+') newLines.push(content);
    if (prefix !== ' ' && prefix !== '-' && prefix !== '+') return null;
  }
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (oldLines.length !== oldCount || newLines.length !== newCount) return null;
  return {
    raw: normalized,
    section: match[5] ?? '',
    oldStart: Number(match[1]),
    oldCount,
    newStart: Number(match[3]),
    newCount,
    lines,
    oldLines,
    newLines,
  };
}

function formatTurnDiffRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function serializeTurnDiffHunk(hunk: CanonicalTurnDiffHunk): string {
  const header = `@@ -${formatTurnDiffRange(hunk.oldStart, hunk.oldCount)} +${formatTurnDiffRange(hunk.newStart, hunk.newCount)} @@${hunk.section}`;
  return hunk.lines.length > 0 ? `${header}\n${hunk.lines.join('\n')}` : header;
}

function turnDiffHunksOverlap(
  hunk: CanonicalTurnDiffHunk,
  start: number,
  count: number,
): boolean {
  const hunkEnd = hunk.newStart + hunk.newCount;
  const incomingEnd = start + count;
  if (count === 0) return start >= hunk.newStart && start <= hunkEnd;
  if (hunk.newCount === 0) return hunk.newStart >= start && hunk.newStart <= incomingEnd;
  return Math.max(hunk.newStart, start) < Math.min(hunkEnd, incomingEnd);
}

function mapCurrentTurnDiffPositionToBase(
  position: number,
  hunks: readonly CanonicalTurnDiffHunk[],
): number {
  let delta = 0;
  for (const hunk of hunks) {
    if (hunk.newStart + hunk.newCount <= position) {
      delta += hunk.newCount - hunk.oldCount;
    }
  }
  return position - delta;
}

function createCanonicalTurnDiffHunks(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): CanonicalTurnDiffHunk[] | null {
  if (oldLines.length + newLines.length > MAX_TURN_DIFF_COMPOSE_LINES) return null;
  const patch = structuredPatch(
    'a',
    'b',
    oldLines.length > 0 ? `${oldLines.join('\n')}\n` : '',
    newLines.length > 0 ? `${newLines.join('\n')}\n` : '',
    '',
    '',
    { context: 3, timeout: TURN_DIFF_COMPOSE_TIMEOUT_MS },
  );
  if (!patch) return null;
  return patch.hunks.map((hunk) => {
    const lines = [...hunk.lines];
    const oldSide: string[] = [];
    const newSide: string[] = [];
    for (const line of lines) {
      const content = line.slice(1);
      if (line[0] === ' ' || line[0] === '-') oldSide.push(content);
      if (line[0] === ' ' || line[0] === '+') newSide.push(content);
    }
    const canonical: CanonicalTurnDiffHunk = {
      raw: '',
      section: '',
      oldStart: oldStart + hunk.oldStart - (hunk.oldLines === 0 ? 2 : 1),
      oldCount: hunk.oldLines,
      newStart: newStart + hunk.newStart - (hunk.newLines === 0 ? 2 : 1),
      newCount: hunk.newLines,
      lines,
      oldLines: oldSide,
      newLines: newSide,
    };
    canonical.raw = serializeTurnDiffHunk(canonical);
    return canonical;
  });
}

function applyTurnDiffHunk(
  current: CanonicalTurnDiffHunk[],
  incoming: ParsedTurnDiffHunk,
  applyStart: number,
): boolean {
  const overlapping = current.filter((hunk) =>
    turnDiffHunksOverlap(hunk, applyStart, incoming.oldCount));
  const delta = incoming.newCount - incoming.oldCount;
  if (overlapping.length === 0) {
    const mappedOldStart = mapCurrentTurnDiffPositionToBase(applyStart, current);
    for (const hunk of current) {
      if (hunk.newStart >= applyStart + incoming.oldCount) hunk.newStart += delta;
    }
    current.push({
      ...incoming,
      oldStart: incoming.oldCount === 0 ? mappedOldStart - 1 : mappedOldStart,
      newStart: incoming.newCount === 0 ? applyStart - 1 : applyStart,
    });
    return current.length <= MAX_TURN_DIFF_COMPOSE_HUNKS;
  }

  overlapping.sort((a, b) => a.newStart - b.newStart);
  const overlappingSet = new Set(overlapping);
  const regionStart = Math.min(applyStart, overlapping[0]!.newStart);
  const regionEnd = Math.max(
    applyStart + incoming.oldCount,
    ...overlapping.map((hunk) => hunk.newStart + hunk.newCount),
  );
  const regionLength = regionEnd - regionStart;
  if (regionLength > MAX_TURN_DIFF_COMPOSE_LINES) return false;
  const currentRegion: Array<string | undefined> = new Array(regionLength);
  const placeLines = (start: number, lines: readonly string[]): boolean => {
    const offset = start - regionStart;
    for (let index = 0; index < lines.length; index += 1) {
      const position = offset + index;
      if (position < 0 || position >= currentRegion.length) return false;
      const existing = currentRegion[position];
      if (existing !== undefined && existing !== lines[index]) return false;
      currentRegion[position] = lines[index];
    }
    return true;
  };
  for (const hunk of overlapping) {
    if (!placeLines(hunk.newStart, hunk.newLines)) return false;
  }
  if (!placeLines(applyStart, incoming.oldLines)) return false;
  if (currentRegion.some((line) => line === undefined)) return false;
  const knownCurrentRegion = currentRegion as string[];

  const baseRegion: string[] = [];
  let cursor = regionStart;
  for (const hunk of overlapping) {
    const gapEnd = hunk.newStart - regionStart;
    baseRegion.push(...knownCurrentRegion.slice(cursor - regionStart, gapEnd));
    baseRegion.push(...hunk.oldLines);
    cursor = hunk.newStart + hunk.newCount;
  }
  baseRegion.push(...knownCurrentRegion.slice(cursor - regionStart));

  const replacementOffset = applyStart - regionStart;
  const finalRegion = [
    ...knownCurrentRegion.slice(0, replacementOffset),
    ...incoming.newLines,
    ...knownCurrentRegion.slice(replacementOffset + incoming.oldCount),
  ];
  const oldStart = mapCurrentTurnDiffPositionToBase(
    regionStart,
    current.filter((hunk) => !overlappingSet.has(hunk)),
  );
  const composed = createCanonicalTurnDiffHunks(baseRegion, finalRegion, oldStart, regionStart);
  if (!composed) return false;

  const remaining = current.filter((hunk) => !overlappingSet.has(hunk));
  for (const hunk of remaining) {
    if (hunk.newStart >= regionEnd) hunk.newStart += delta;
  }
  current.splice(0, current.length, ...remaining, ...composed);
  return current.length <= MAX_TURN_DIFF_COMPOSE_HUNKS;
}

function composeTurnDiffBlocks(
  blocks: string[],
  splitBlock: (block: string) => { header: string; hunks: string[] },
): ComposedTurnDiffBlock {
  const parsedBlocks = blocks.map(splitBlock);
  const rawHunks = parsedBlocks.flatMap((block) => block.hunks);
  if (
    rawHunks.length > MAX_TURN_DIFF_COMPOSE_HUNKS
    || rawHunks.reduce((sum, hunk) => sum + hunk.split('\n').length - 1, 0)
      > MAX_TURN_DIFF_COMPOSE_LINES
  ) return { block: '', complete: false };
  const stripIndexLine = (header: string): string => header
    .split('\n')
    .filter((line) => !line.startsWith('index '))
    .join('\n');
  const header = stripIndexLine(parsedBlocks[0]?.header ?? '');
  if (
    !header
    || parsedBlocks.some((block) =>
      stripIndexLine(block.header) !== header || block.hunks.length === 0)
  ) return { block: '', complete: false };
  const firstHunks = parsedBlocks[0]!.hunks.map(parseTurnDiffHunk);
  if (firstHunks.some((hunk) => hunk === null)) return { block: '', complete: false };
  const canonical = firstHunks as CanonicalTurnDiffHunk[];
  const seenHunks = new Set(canonical.map((hunk) => hunk.raw));
  for (const block of parsedBlocks.slice(1)) {
    let blockDelta = 0;
    for (const rawHunk of block.hunks) {
      const incoming = parseTurnDiffHunk(rawHunk);
      if (incoming && seenHunks.has(incoming.raw)) {
        blockDelta += incoming.newCount - incoming.oldCount;
        continue;
      }
      const applyStart = incoming
        ? incoming.oldStart + blockDelta + (incoming.oldCount === 0 ? 1 : 0)
        : 0;
      if (!incoming || !applyTurnDiffHunk(canonical, incoming, applyStart)) {
        return { block: '', complete: false };
      }
      seenHunks.add(incoming.raw);
      blockDelta += incoming.newCount - incoming.oldCount;
    }
  }
  const body = canonical
    .sort((a, b) => a.oldStart - b.oldStart || a.newStart - b.newStart)
    .map(serializeTurnDiffHunk)
    .join('\n');
  return { block: `${header}${body ? `\n${body}` : ''}\n`, complete: true };
}

// ── Agent 实现 ────────────────────────────────────────────────────────────────

export class CodexAgent extends BaseAgent {
  readonly kind = 'codex' as const;
  readonly capabilities: Capabilities;

  /**
   * Hosts keyed by target — `'local'` 或 `remote:<remoteHostId>`。每个 target
   * 一个 AppServerHost (= 一个 codex app-server, 本地 spawn / 远端 daemon-bridged
   * 都对应自己的)。
   *
   * 为什么不是单 host: 用户可能同时开本地 session 和 ssh 远端 session, 两条路
   * 走不同 transport (StdioTransport vs SshDaemonTransport), 没法共用一个 host。
   * "1 agent N host" 是 codex 端做不到 "1 server N transport" 的必然后果。
   */
  private hosts = new Map<string, AppServerHost>();
  private archiveHostKeys = new Set<string>();

  /** Project the host's durable task status through Codex's own storage API. */
  async syncThreadArchiveState(opts: {
    threadId: string;
    archived: boolean;
    remoteHostId?: string;
    assertCurrent: () => void;
  }): Promise<void> {
    opts.assertCurrent();
    const storage = opts.remoteHostId ? undefined : await this.deps.resolveCodexThreadStorage?.(opts.threadId, { readOnly: true });
    if (!opts.remoteHostId && this.deps.resolveCodexThreadStorage && !storage) {
      throw new Error('Codex archive storage is unavailable');
    }
    opts.assertCurrent();
    let target: { key: string; host: AppServerHost } | undefined;
    // Unsubscribe does not release the native writer immediately. Use its host
    // when it still owns this thread; never kill a shared host to move a file.
    for (const [key, host] of this.hosts) {
      if (this.archiveHostKeys.has(key) || !host.writerCandidate) continue;
      if (opts.remoteHostId ? key !== hostKey(opts.remoteHostId) : !key.startsWith('local')) continue;
      let cursor: string | null = null;
      do {
        const page: { data: string[]; nextCursor?: string | null } = await host.request(
          'thread/loaded/list', { cursor }, { timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS },
        );
        opts.assertCurrent();
        if (page.data.includes(opts.threadId)) { target = { key, host }; break; }
        cursor = page.nextCursor ?? null;
      } while (cursor);
      if (target) break;
    }
    const key = opts.remoteHostId ? hostKey(opts.remoteHostId)
      : `local:archive:${JSON.stringify(storage ? [storage.historyHome, storage.sqliteHome] : [])}`;
    await this.withHostOperation(async () => {
      opts.assertCurrent();
      if (target && this.hosts.get(target.key) === target.host) return target;
      if (!opts.remoteHostId) this.archiveHostKeys.add(key);
      const host = await this.getHost(opts.remoteHostId, undefined, {
        keyOverride: key, hostPurpose: 'control-plane',
        // Local archive hosts never run turns; skip the MCP bridge they would never use.
        ...(!opts.remoteHostId ? { nativeStorageOnly: true } : {}),
        ...(storage ? { historyHome: storage.historyHome, sqliteHome: storage.sqliteHome } : {}),
      });
      return { key, host };
    }, async (host) => {
      const init = await host.ensureStarted();
      opts.assertCurrent();
      const rollout = await syncCodexArchiveState(
        (method, params) => host.request(method, params, { timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS }),
        opts.threadId, opts.archived, opts.assertCurrent,
      );
      opts.assertCurrent();
      if (!opts.remoteHostId) {
        const home = storage?.sqliteHome ?? init.codexHome;
        if (home) await this.deps.recordCodexThreadLocation?.(opts.threadId, home, rollout);
      }
    });
  }

  /** A backfill reuses one control host per storage root, then releases them. */
  async releaseArchiveHosts(): Promise<void> {
    for (const key of this.archiveHostKeys) {
      await this.retireHostKey(key, 'Codex archive sync finished', {
        failIfActive: true, logPrefix: 'codex archive host cleanup', throwOnShutdownFailure: true,
      });
      this.archiveHostKeys.delete(key);
    }
  }

  /**
   * getHost() 的 in-flight Promise 去重, per target — 创建过程含 3 个 await
   * (auth.getState / buildCodexEnv / prepareCodexExtraSpawnConfig), 不去重则
   * 启动期间并发 (skillHubScanner / startSession / IPC list) 各看到 hosts.get(...)=undefined,
   * 各自 spawn 一个 codex app-server 子进程, 第二个会覆盖 hosts.set(...), 第一个变孤儿。
   */
  private hostPromises = new Map<string, {
    promise: Promise<AppServerHost>;
    credentialMode: AgentCredentialMode | undefined;
    credentialModeResolved: boolean;
    generation: number;
  }>();

  /**
   * 本地 app-server 的 spawn-time 凭证形态(超集归一化后的实际 spawn 形态)。
   *
   * 方案 A(2026-07)后的复用语义:oauth-bearer spawn 是「订阅超集 host」——proxy 按
   * 请求/会话换网关 key,gateway-key 会话可直接复用它(见 canReuseCodexHostForCredentialMode),
   * 订阅与 API 会话得以并行,不再因来源切换重建 host。反向仍然重建:env-key spawn 的
   * 进程服务不了订阅会话。createHost 对本地 gateway-key 诉求做超集归一化(有 OAuth 时
   * 升格为 oauth-bearer spawn),登记的就是归一化后的形态。
   */
  private hostCredentialModes = new Map<string, AgentCredentialMode | undefined>();
  /**
   * createHost 时从(本来就要做的)auth.getState 推出的归一化凭证形态。
   * hostCredentialModes 登记实际 spawn 形态 —— getHost 快路径对实际形态与诉求
   * 做逐字比较(implicit-implicit / 同显式),零 IO;本表只在快路径
   * 不等、需要跨形态仲裁时参与 canReuseCodexHostForCredentialMode 比较(review P2:
   * 归一化解析含 fs,不允许进无条件路径)。
   */
  private hostEffectiveCredentialModes = new Map<string, AgentCredentialMode | undefined>();

  /**
   * target host 的生命周期版本。只在 agent 主动替换/销毁 host 时递增。
   * transport error 的同对象自愈不递增,保留现有 session 内恢复能力。
   */
  private hostGenerations = new Map<string, number>();

  /**
   * createHost 调用计数 —— 按 host key 诊断 in-flight 去重是否生效。
   * 正常每个 host key 的生命周期内每次 dispose 之间应该恰好 +1; 出现 >1 说明 hostPromise 去重失效
   * (旧 bug: 会 spawn 多个 codex app-server 子进程, 前面的变孤儿)。
   */
  private createHostSeqByKey = new Map<string, number>();

  /**
   * thread/start|resume 已开始但尚未 subscribeThread 的会话绑定计数。
   *
   * activeSubscriptions 只能覆盖已订阅的 session;这个 lease 补上 thread 创建成功到订阅
   * 建立前的短窗口,避免 credential switch 在中途 retire host 造成新会话 stale。
   */
  private hostSessionBindingLeases = new Map<string, number>();

  /**
   * 本地 host 凭证形态切换锁。
   *
   * 切换期间旧 host 还在 map 里,但已经进入 draining 状态;同 key 的新 getHost 必须先等
   * 当前切换完成,不能继续把新 session 挂到即将 retire 的旧 host 上。
   */
  private hostCredentialModeSwitches = new Map<string, Promise<void>>();

  /** 同 key 必须等旧 writer 退出；失败仅清本次 Promise，保留 Host 供下次重查。 */
  private retiringHosts = new Map<string, {
    host: AppServerHost;
    generation: number;
    promise: Promise<void> | null;
  }>();
  // Keep exact-process exit evidence even after its reusable registry entry is gone.
  private hostRetirementResults = new WeakMap<AppServerHost, Promise<void>>();

  /**
   * app-server 启动时返回的 $CODEX_HOME 绝对路径 (InitializeResponse.codexHome)。
   * 用来推 codex 自家 memory 数据目录 (<CODEX_HOME>/memories/), 进而把它加进 turn/start
   * 的 sandboxPolicy.workspaceWrite.writableRoots, 让 codex 内置 MemoryTool 写
   * memory_summary.md / MEMORY.md 时不被 "writing outside of the project" 预检拦掉。
   *
   * 启动时由 ensureStarted() 返回值填; dispose 后清零, 下次 host 重建再填。
   */
  private codexHome: string | null = null;

  /**
   * 各 app-server host 已 push 的 memoryOverride 值。
   *
   * memoryOverride 是 host 端的意图, app-server 是另一个进程, 不会自动同步; 必须主动
   * RPC (experimentalFeature/enablement/set) 推过去。本字段按 host key 记录
   * "上次 push 的值是什么", 让 ensureMemoryOverridePushed 可以判断 "需不需要再 push"。
   *
   * 重置时机:
   *  - host 重建/dispose: server 重启会丢内存 enablement, 清掉对应 key 让下次 ensure 再 push
   *  - setMemory 后立即 RPC 同步所有 live host; 无 live host 时在下一次 startSession ensure 时补齐
   */
  private memoryOverridePushedByHost = new Map<string, boolean | undefined>();
  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(CAPABILITIES);
  }

  /**
   * Agent 内置 command —— 见 ./commands.ts。当前 codex 白名单为空,
   * 内置 slash 全走 app-server skills/list 归 'agent-skill' 类目。
   */
  override listAgentCommands(): AgentBuiltinCommand[] {
    return CODEX_AGENT_COMMANDS;
  }

  /**
   * Skill 扫描 —— 与老 listSlashCommands 共享同一套 listSkillsForCwd / 未授权静默处理,
   * 只是包成新的 AgentSkillCommand 形状(kind='agent-skill')。
   */
  override async listAgentSkills(opts: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    // Codex app-server 的 skills/list 强制要求 cwd；无项目的新对话用 HOME 作为
    // 查询上下文，既能发现全局 skills，又不会误带任意项目的 repo skills。
    const workingDir = opts.workingDir || os.homedir();
    try {
      const { skills, errors } = await this.listSkillsForCwd(
        workingDir,
        opts.forceReload ?? false,
        opts.remoteHostId,
      );
      const out: ListAgentSkillsResult = {
        skills: paletteVisibleCodexSkills(skills)
          .map((skill) => ({
            kind: 'agent-skill' as const,
            name: skill.name,
            description: skillDescription(skill),
            source: 'skill' as const,
            path: skill.path,
            scope: skill.scope,
            enabled: skill.enabled,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
      if (errors.length > 0) out.errors = errors;
      return out;
    } catch (err) {
      if (err instanceof AgentNotAuthenticatedError) {
        return { skills: [] };
      }
      throw err;
    }
  }

  /**
   * Codex customization 入口 —— 纯文件系统扫描，不触发 app-server。
   *
   * 扫描 ~/.agents/skills/ + ~/.codex/skills/ + project skill dirs。
   * 用于 SkillHub 管理页面（快速发现磁盘上的 skill）。
   * 运行时技能列表（command palette）走 listAgentSkills → RPC，不受影响。
   */
  async listCustomizations(opts: ListCustomizationsOptions): Promise<ListCustomizationsResult> {
    return this.deps.scanLocalCustomizations
      ? this.deps.scanLocalCustomizations('codex', opts)
      : scanCodexCustomizations(opts);
  }

  private async listSkillsForCwd(
    workingDir: string,
    forceReload: boolean,
    remoteHostId?: string,
  ): Promise<{ skills: SkillMetadata[]; errors: Array<{ path?: string; message: string }> }> {
    return this.withHostOperation(async () => remoteHostId
      ? { key: hostKey(remoteHostId), host: await this.getHost(remoteHostId) }
      : this.getUtilityHost(),
    host => this.listSkillsForHost(host, workingDir, forceReload));
  }

  /**
   * 本机的 Skill、插件与 MCP 逐项关闭(线程级覆盖)。不传 keep 时全部关闭(Review)；受邀者的
   * 托管会话用 keep 保留它自己的 Skill、Codex 自带 Skill 与经隧道的 MCP。
   */
  private async buildLocalCapabilityIsolationConfig(
    host: AppServerHost,
    workingDir: string,
    keep?: {
      skill: (skillPath: string, scope?: SkillMetadata['scope']) => boolean;
      mcpServer: (serverName: string) => boolean;
      plugin?: (pluginId: string) => boolean;
      allSkills?: true;
    },
  ): Promise<Record<string, unknown>> {
    const { skills, errors } = keep?.allSkills ? { skills: [], errors: [] } : await this.listSkillsForHost(
      host,
      workingDir,
      false,
      CRITICAL_THREAD_RPC_TIMEOUT_MS,
    );
    const unscopedSkillError = errors.find((error) => !error.path);
    if (unscopedSkillError && !keep?.skill('')) throw new Error(unscopedSkillError.message);

    const configResponse = await host.request<{ config?: Record<string, unknown> }>(
      Method.ConfigRead,
      { includeLayers: false },
      { timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS },
    );
    const effectiveConfig = asRecord(configResponse.config);
    const configuredMcp = asRecord(effectiveConfig.mcp_servers);
    const configuredPlugins = asRecord(effectiveConfig.plugins);
    const configuredMcpServerNames = new Set(
      Object.entries(configuredMcp)
        .filter(([, serverConfig]) => hasCodexMcpTransport(serverConfig))
        .map(([serverName]) => serverName),
    );
    const transportConfiguredMcpServerNames = new Set(configuredMcpServerNames);
    for (const pluginConfig of Object.values(configuredPlugins)) {
      const pluginMcp = asRecord(asRecord(pluginConfig).mcp_servers);
      for (const [serverName, serverConfig] of Object.entries(pluginMcp)) {
        if (!hasCodexMcpTransport(serverConfig)) continue;
        transportConfiguredMcpServerNames.add(serverName);
      }
    }
    const unconfiguredRuntimeMcpServerNames = new Set<string>();
    let cursor: string | null = null;
    do {
      const status: CodexMcpServerStatusListResponse =
        await host.request<CodexMcpServerStatusListResponse>(
        Method.McpServerStatusList,
        { cursor, limit: 100, detail: 'toolsAndAuthOnly', threadId: null },
        { timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS },
      );
      for (const server of status.data) {
        if (
          !transportConfiguredMcpServerNames.has(server.name) &&
          server.name !== CODEX_APPS_MCP_SERVER_NAME
        ) {
          unconfiguredRuntimeMcpServerNames.add(server.name);
        }
      }
      cursor = status.nextCursor;
    } while (cursor !== null);
    if (unconfiguredRuntimeMcpServerNames.size > 0) {
      throw new Error(
        `Codex reported runtime MCP servers without transport-bearing config: ${[
          ...unconfiguredRuntimeMcpServerNames,
        ].sort().join(', ')}`,
      );
    }

    const skillPaths = new Set([
      ...skills.filter((skill) => !keep?.skill(skill.path, skill.scope)).map((skill) => skill.path),
      ...errors.flatMap((error) => (error.path && !keep?.skill(error.path) ? [error.path] : [])),
    ]);
    const pluginIds = new Set(Object.keys(configuredPlugins));
    for (const skillPath of skillPaths) {
      const pluginId = pluginIdFromCodexSkillPath(skillPath);
      if (pluginId) pluginIds.add(pluginId);
    }

    const isolationConfig: Record<string, unknown> = {};
    if (skillPaths.size > 0) {
      isolationConfig['skills.config'] = [...skillPaths]
        .sort()
        .map((skillPath) => ({ path: skillPath, enabled: false }));
    }
    // Only configured MCP entries have a command/url transport that can
    // accept a per-thread `.enabled=false` merge. `codex_apps` is an
    // app-server builtin surfaced by mcpServerStatus/list but absent from
    // config/read; synthesizing an override for it makes Codex 0.145.0
    // reject thread/start with "invalid transport". Apps are isolated by
    // `features.apps=false` instead.
    for (const serverName of configuredMcpServerNames) {
      if (keep?.mcpServer(serverName)) continue;
      isolationConfig[
        `mcp_servers.${renderReviewConfigSegment(serverName)}.enabled`
      ] = false;
    }
    for (const pluginId of pluginIds) {
      if (!keep?.plugin?.(pluginId)) {
        isolationConfig[`plugins.${quoteReviewConfigSegment(pluginId)}.enabled`] = false;
      }
      const pluginMcp = asRecord(asRecord(configuredPlugins[pluginId]).mcp_servers);
      for (const [serverName, serverConfig] of Object.entries(pluginMcp)) {
        if (!hasCodexMcpTransport(serverConfig)) continue;
        isolationConfig[
          `plugins.${quoteReviewConfigSegment(pluginId)}.mcp_servers.${renderReviewConfigSegment(serverName)}.enabled`
        ] = false;
      }
    }
    return isolationConfig;
  }

  private async listSkillsForHost(
    host: AppServerHost,
    workingDir: string,
    forceReload: boolean,
    timeoutMs?: number,
  ): Promise<{ skills: SkillMetadata[]; errors: Array<{ path?: string; message: string }> }> {
    const params = {
      cwds: [workingDir],
      forceReload,
      perCwdExtraUserRoots: null,
    };
    const response = timeoutMs == null
      ? await host.request<SkillsListResponse>(Method.SkillsList, params)
      : await host.request<SkillsListResponse>(Method.SkillsList, params, { timeoutMs });
    const entry = response.data.find((item) => item.cwd === workingDir) ?? response.data[0];
    return {
      skills: entry?.skills ?? [],
      errors: (entry?.errors ?? []).map((err) => ({ path: err.path, message: err.message })),
    };
  }

  /**
   * 懒创建 host (但 spawn 由 ensureStarted 触发)。
   *
   * **Auth gate**: 第一次创建前先 `auth.getState()`,未授权直接抛
   * `AgentNotAuthenticatedError` — 不让 codex app-server 子进程在 "未登录" 状态下
   * 起来 (起来后 auth.json 即使写好也读不到,会导致首 turn 401)。
   *
   * 复合检查: 已经有 host 时不重复 getState — host 存在即说明之前授权过且 dispose
   * 钩子还没触发(logout 时会 dispose 清掉)。这样热路径 (每次 send) 不会多一次 fs 读。
   */
  private canReuseHostCredentialMode(
    currentMode: AgentCredentialMode | undefined,
    requestedMode: AgentCredentialMode | undefined,
  ): boolean {
    // 语义在 credential-mode.ts:两侧都是归一化后的形态,同族即复用;codex 额外放宽
    // 「oauth-bearer 超集 host 服务 gateway-key 会话」(方案 A,proxy 按请求换网关 key)。
    // 解析不出形态(undefined)保持保守语义要求重建,不把意图不明的会话挂到显式凭证进程上。
    return canReuseCodexHostForCredentialMode(currentMode, requestedMode);
  }

  private canReuseHostForCredentialRequest(
    host: AppServerHost,
    currentMode: AgentCredentialMode | undefined,
    requestedMode: AgentCredentialMode | undefined,
  ): boolean {
    if (!this.canReuseHostCredentialMode(currentMode, requestedMode)) return false;
    // provider-oauth(如 xAI)的真实鉴权和 model rewrite 都在 loopback proxy 内完成。
    // 如果当前 host 是 proxy 不可用时退化启动的直连 gateway host, family 虽然可复用,
    // 但请求会绕过 proxy 而误路由;必须重建或由 active-session gate fail closed。
    if (requestedMode === 'provider-oauth' && !host.isCodexProxyActive()) return false;
    // 超集复用(oauth-bearer host 承载 gateway-key 会话)同样硬依赖 proxy:换网关 key
    // 发生在 proxy 路由层,退化直连的 oauth host 上 key 会话会带 OAuth token 直打网关 → 401。
    if (
      requestedMode === 'gateway-key' &&
      currentMode === 'oauth-bearer' &&
      !host.isCodexProxyActive()
    ) return false;
    return true;
  }

  /**
   * oauth 超集 host 复用 gateway-key 诉求前，单独验证网关凭证仍然可用。
   * host 自己通过 OAuth auth gate 只能证明订阅身份有效，不能替代 API Key 校验；
   * 否则缺 key 的 XD 会话会被错误挂载，直到首个请求才以 401 失败。
   */
  private async assertSupersetRequestedCredentialAvailable(
    currentMode: AgentCredentialMode | undefined,
    requestedMode: AgentCredentialMode | undefined,
  ): Promise<void> {
    if (currentMode !== 'oauth-bearer' || requestedMode !== 'gateway-key') return;
    const state = await this.deps.auth.getState({ credentialMode: 'gateway-key' });
    if (!state.authenticated) {
      throw new AgentNotAuthenticatedError(
        'codex',
        `codex gateway credentials unavailable: ${state.errorReason ?? 'no_credentials'}`,
      );
    }
  }

  /**
   * 归一化本地会话的凭证形态:显式指定原样返回;未指定(providerId=null 的会话)则读
   * auth fallback 的 authSource 推出它实际会用的钥匙形态。返回值只用于 host 复用比较
   * 与登记,**不**改变 spawn 时传给 adapter 的 authOptions(spawn 行为字节级不变)。
   */
  private async resolveEffectiveLocalCredentialMode(
    requested: AgentCredentialMode | undefined,
  ): Promise<AgentCredentialMode | undefined> {
    if (requested) return requested;
    try {
      const state = await this.deps.auth.getState();
      const resolved = resolveEffectiveCredentialModeFromAuthSource(undefined, state.authSource);
      if (resolved) {
        // 只在跨形态仲裁时才会走到这里(懒解析),频率低;debug 级避免刷日志。
        this.deps.logger.debug('codex getHost: implicit credential mode resolved from auth fallback', {
          authSource: state.authSource,
          resolved,
        });
      } else {
        this.deps.logger.warn('codex getHost: implicit credential mode unresolved; keeping legacy strict comparison', {
          authenticated: state.authenticated,
          errorReason: state.errorReason,
        });
      }
      return resolved;
    } catch (error) {
      this.deps.logger.warn('codex getHost: implicit credential mode resolution failed; keeping legacy strict comparison', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private bumpHostGeneration(key: string): number {
    const next = (this.hostGenerations.get(key) ?? 0) + 1;
    this.hostGenerations.set(key, next);
    return next;
  }

  private acquireHostSessionBindingLease(key: string): () => void {
    this.hostSessionBindingLeases.set(key, (this.hostSessionBindingLeases.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.hostSessionBindingLeases.get(key) ?? 1) - 1;
      if (next <= 0) this.hostSessionBindingLeases.delete(key);
      else this.hostSessionBindingLeases.set(key, next);
    };
  }

  private hostActiveUseCount(
    key: string,
    host: AppServerHost,
    opts: { ignoreBindingLeases?: number } = {},
  ): number {
    const bindingLeases = Math.max(
      0,
      (this.hostSessionBindingLeases.get(key) ?? 0) - (opts.ignoreBindingLeases ?? 0),
    );
    return host.activeSubscriptions + bindingLeases;
  }

  private async shutdownHostForCredentialModeChange(
    key: string,
    host: AppServerHost,
    fromMode: AgentCredentialMode | undefined,
    toMode: AgentCredentialMode | undefined,
    opts: { ignoreBindingLeases?: number; forceRestart?: boolean } = {},
  ): Promise<void> {
    while (true) {
      const previous = this.hostCredentialModeSwitches.get(key);
      if (!previous) break;
      await previous.catch(() => undefined);
    }
    const run = this.shutdownHostForCredentialModeChangeUnlocked(key, host, fromMode, toMode, opts);
    this.hostCredentialModeSwitches.set(key, run);
    try {
      await run;
    } finally {
      if (this.hostCredentialModeSwitches.get(key) === run) {
        this.hostCredentialModeSwitches.delete(key);
      }
    }
  }

  private async waitForHostCredentialModeSwitch(key: string, skipConfigurationGuard = false): Promise<void> {
    while (true) {
      const switching = (!skipConfigurationGuard && !key.startsWith('remote:')
        ? this.hostCredentialModeSwitches.get(LOCAL_CONFIGURATION_CHANGE_KEY)
        : undefined) ?? this.hostCredentialModeSwitches.get(key);
      if (!switching) return;
      await switching.catch(() => undefined);
    }
  }

  /** Current local consumers, including unresolved startup which may freeze this credential. */
  getLocalHostKeysForCredentialMode(credentialMode?: AgentCredentialMode): string[] {
    return [...new Set([
      ...this.hosts.keys(), ...this.hostPromises.keys(),
      ...this.hostSessionBindingLeases.keys(), ...this.retiringHosts.keys(),
    ])].filter((candidate) => {
      if (candidate.startsWith('remote:')) return false;
      if (!credentialMode) return true;
      const mode = this.hostEffectiveCredentialModes.get(candidate)
        ?? this.hostCredentialModes.get(candidate)
        ?? this.hostPromises.get(candidate)?.credentialMode;
      return mode === undefined || mode === credentialMode;
    });
  }

  async beginLocalHostCredentialChange(
    reason = 'CodexAgent local credential state changed',
    options: { allLocalHosts?: boolean; credentialMode?: AgentCredentialMode; targetHostKey?: string; forceRetire?: boolean; busyError?: () => Error } = {},
  ): Promise<{
    affectedHostKeys: readonly string[];
    assertIdle(): void;
    retireActiveHost(): Promise<void>;
    finalize(): Promise<void>;
    release(): void;
  }> {
    const key = options.allLocalHosts ? LOCAL_MCP_REFRESH_KEY : hostKey();
    // Check and reserve in the same synchronous segment. An await-only gate
    // allows two callers to pass before either has installed its reservation.
    while (true) {
      const pending = options.allLocalHosts
        ? [...this.hostCredentialModeSwitches.values()]
        : [this.hostCredentialModeSwitches.get(LOCAL_MCP_REFRESH_KEY), this.hostCredentialModeSwitches.get(key)]
          .filter((value): value is Promise<void> => value !== undefined);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
    // 配置代次只在变更真正落地(host 被退役 / finalize 通过 busy 检查)时才推进。
    // 预约本身已经通过 hostCredentialModeSwitches 挡住新的 host 获取;若在预约时就推进代次,
    // 一次因 busy 被拒绝、随后 release 的变更也会让所有正在准备 host 的会话判定「路由已变」而
    // 重来——hook-control 每 2 秒重试一次被拒的 MCP 刷新时,新启动的 Codex 任务会连续撞满 7 次
    // 重试并以 LAZY_CREATE_FAILED 收场(2026-10-19 实排:伙伴会话长时间 busy,窗口期内任何 Codex
    // 任务都无法启动)。
    let generationBumped = false;
    const commitConfigurationChange = (): void => {
      if (generationBumped) return;
      generationBumped = true;
      this.bumpHostGeneration(LOCAL_CONFIGURATION_CHANGE_KEY);
    };

    let releaseSwitch!: () => void;
    const switchPromise = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    this.hostCredentialModeSwitches.set(key, switchPromise);
    let released = false;
    let hostRetired = false;

    const cleanup = (): void => {
      if (released) return;
      released = true;
      if (this.hostCredentialModeSwitches.get(key) === switchPromise) {
        this.hostCredentialModeSwitches.delete(key);
      }
      releaseSwitch();
    };

    const affectedKeys = (): string[] => options.allLocalHosts
      ? this.getLocalHostKeysForCredentialMode(options.credentialMode)
        .filter((candidate) => options.targetHostKey === undefined || candidate === options.targetHostKey)
      : [key];
    const activeUseCount = (): number => affectedKeys().reduce((count, candidate) => {
      const host = this.hosts.get(candidate);
      return count + (host
        ? this.hostActiveUseCount(candidate, host)
        : (this.hostSessionBindingLeases.get(candidate) ?? 0))
        + (options.allLocalHosts && this.hostPromises.has(candidate) ? 1 : 0);
    }, 0);
    const retire = async (): Promise<void> => {
      for (const candidate of affectedKeys()) {
        await this.retireHostKey(candidate, reason, {
          failIfActive: options.allLocalHosts === true && options.forceRetire !== true,
          rejectBeforeMutation: options.allLocalHosts === true && options.forceRetire !== true,
          logPrefix: 'codex local credential hard cut',
          throwOnShutdownFailure: true,
        });
      }
      commitConfigurationChange();
    };

    return {
      affectedHostKeys: affectedKeys(),
      assertIdle: () => {
        const count = activeUseCount();
        if (count > 0) {
          throw options.busyError?.() ?? new Error(
            `Cannot restart local Codex host while ${count} active Codex session(s) are attached`,
          );
        }
      },
      retireActiveHost: async () => {
        if (released || hostRetired) return;
        await retire();
        hostRetired = true;
      },
      finalize: async () => {
        if (released) return;
        try {
          if (!hostRetired) {
            if (options.allLocalHosts) {
              if (!options.forceRetire && activeUseCount() > 0) throw options.busyError?.() ?? new Error('Cannot refresh MCP while local Codex hosts are active or starting');
              await retire();
            } else {
              await this.disposeLocalHostForCredentialChangeUnlocked(key, reason);
              commitConfigurationChange();
            }
          }
        } finally {
          cleanup();
        }
      },
      release: cleanup,
    };
  }

  private async shutdownHostForCredentialModeChangeUnlocked(
    key: string,
    host: AppServerHost,
    fromMode: AgentCredentialMode | undefined,
    toMode: AgentCredentialMode | undefined,
    opts: { ignoreBindingLeases?: number; forceRestart?: boolean } = {},
  ): Promise<void> {
    if (this.hosts.get(key) !== host) return;
    const currentMode = this.hostCredentialModes.get(key);
    // 仲裁用归一化形态(登记于 createHost,零额外 IO);缺失时回退原始形态。
    const currentEffective = this.hostEffectiveCredentialModes.get(key) ?? currentMode;
    if (
      !opts.forceRestart
      && this.canReuseHostForCredentialRequest(host, currentEffective, toMode)
    ) {
      return;
    }

    let activeUseCount = this.hostActiveUseCount(key, host, opts);
    const coordinator = this.deps.prepareCodexLocalCredentialModeSwitch;
    if (coordinator) {
      await coordinator({
        hostKey: key,
        fromMode: currentMode,
        fromModeEffective: currentEffective,
        toMode,
        activeSubscriptions: activeUseCount,
      });
      if (this.hosts.get(key) !== host) return;
      activeUseCount = this.hostActiveUseCount(key, host, opts);
      if (activeUseCount > 0) {
        throw new Error(
          `Cannot switch Codex credential mode; active Codex session(s) still attached after coordination: ${activeUseCount}`,
        );
      }
    } else if (activeUseCount > 0) {
      throw new Error(
        `Cannot switch Codex credential mode while ${activeUseCount} active Codex session(s) are attached`,
      );
    }

    this.deps.logger.info('codex createHost: credential mode changed, restarting local app-server', {
      key,
      fromMode: currentMode ?? fromMode ?? 'fallback',
      fromModeEffective: currentEffective ?? 'unresolved',
      toMode: toMode ?? 'fallback',
      forcedBySubagentRoutingProfile: opts.forceRestart === true,
    });
    const retirement = this.beginHostRetirement(key, host, 'CodexAgent credential mode changed');
    this.hosts.delete(key);
    this.hostCredentialModes.delete(key);
    this.hostEffectiveCredentialModes.delete(key);
    this.memoryOverridePushedByHost.delete(key);
    this.bumpHostGeneration(key);
    if (key === hostKey()) this.codexHome = null;
    this.createHostSeqByKey.delete(key);
    try {
      await retirement;
    } catch (error) {
      this.deps.logger.warn('codex host shutdown after credential mode change failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private routeResolutionAbort = new AbortController();

  private async resolveLocalAuthSelection(providerId: string | null | undefined, model: string) {
    const signal = this.routeResolutionAbort.signal;
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      await awaitCodexRouteSelection(this.waitForHostCredentialModeSwitch(LOCAL_CONFIGURATION_CHANGE_KEY), signal);
      signal.throwIfAborted();
      const generation = this.hostGenerations.get(LOCAL_CONFIGURATION_CHANGE_KEY);
      const resolved = await awaitCodexRouteSelection(
        Promise.resolve(this.deps.resolveCodexLocalAuthPolicy?.(providerId, model, signal) ?? 'legacy-shared'), signal,
      );
      signal.throwIfAborted();
      const policy = typeof resolved === 'string' ? resolved : resolved.policy;
      const isCurrent = () => !signal.aborted
        && generation === this.hostGenerations.get(LOCAL_CONFIGURATION_CHANGE_KEY)
        && !this.hostCredentialModeSwitches.has(LOCAL_CONFIGURATION_CHANGE_KEY)
        && (typeof resolved === 'string' || resolved.isCurrent());
      if (isCurrent()) return { policy, isCurrent };
      if (attempt >= 7) throw new CodexRouteSelectionChangedError('Codex route changed repeatedly during selection', false);
    }
  }

  private async getHost(
    remoteHostId?: string,
    credentialMode?: AgentCredentialMode,
    opts: {
      providerId?: string;
      ignoreBindingLeases?: number;
      routeIsCurrent?: () => boolean;
      routeSignal?: AbortSignal;
      reuseExistingUtilityHost?: boolean;
      localAuthPolicy?: 'isolated' | 'legacy-shared';
      keyOverride?: string;
      hostPurpose?: 'control-plane' | 'review' | 'custom-context';
      /** Archive-only control host: native storage RPCs, no turns, no MCP bridge. */
      nativeStorageOnly?: boolean;
      localToolCatalog?: string;
      customContextModel?: string;
      customContextWindow?: number;
      customContextProviderId?: string | null;
      sqliteHome?: string;
      historyHome?: string;
      /** 受邀者任务的 app-server：值是分享给它的供应商(见 prepareCodexExtraSpawnConfig)。 */
      deviceHostedGuestProviderId?: string;
      deviceHostedGuestSessionId?: string;
      deviceHostedGuestModelIds?: readonly string[];
    } = {},
  ): Promise<AppServerHost> {
    const key = opts.keyOverride ?? (opts.providerId ? `local-account:${opts.providerId}` : hostKey(remoteHostId));
    const assertRouteCurrent = (): void => {
      if (opts.routeIsCurrent && !opts.routeIsCurrent()) throw new CodexRouteSelectionChangedError();
    };
    // spawnMode = 调用方原始诉求(undefined 保持 adapter fallback,spawn 行为不变)。
    // 复用判定分两级(review P2:归一化解析走 getState、含 reconcile/fs,不允许进
    // 无条件路径):
    //   快路径:原始诉求与登记的原始形态逐字相等(implicit-implicit / 同显式)→
    //           直接复用,零 IO,与本次改动前的行为完全一致;
    //   仲裁路径:快路径不等时,才把隐式诉求懒解析成归一化形态(同一次 getHost 内
    //           memo,显式诉求无需解析),与登记的归一化形态(createHost 时零额外
    //           IO 推出)做 canReuseCodexHostForCredentialMode 同族比较。
    const spawnMode = remoteHostId ? undefined : credentialMode;
    let requestedEffectiveMemo: { value: AgentCredentialMode | undefined } | null =
      remoteHostId || credentialMode ? { value: spawnMode } : null;
    const resolveRequestedEffective = async (): Promise<AgentCredentialMode | undefined> => {
      if (!requestedEffectiveMemo) {
        requestedEffectiveMemo = { value: await this.resolveEffectiveLocalCredentialMode(undefined) };
      }
      return requestedEffectiveMemo.value;
    };
    const hasCompatibleSubagentRoutingProfile = async (
      host: AppServerHost,
      hostCredentialMode?: AgentCredentialMode,
    ): Promise<boolean> => {
      if (this.deps.resolveCodexSubagentRoutingSignature) {
        const signature = host.getSubagentRoutingSignature() ?? 'default';
        const desired = await this.deps.resolveCodexSubagentRoutingSignature(
          this.deps.mcpProviders ?? [],
          {
            ...(opts.providerId ? { providerId: opts.providerId } : {}),
            credentialMode: hostCredentialMode,
            ...(opts.hostPurpose ? { hostPurpose: opts.hostPurpose } : {}),
            ...(opts.deviceHostedGuestProviderId
              ? { deviceHostedGuestProviderId: opts.deviceHostedGuestProviderId }
              : {}),
          },
        );
        return signature === desired;
      }
      const profile = host.getSubagentRoutingProfile();
      if (profile === 'default' || profile === 'smart') return true;
      const requested = await resolveRequestedEffective();
      return profile === 'oauth-default'
        ? requested === 'oauth-bearer'
        : requested !== 'oauth-bearer';
    };
    const canReuseRegistered = async (
      host: AppServerHost,
      registeredRaw: AgentCredentialMode | undefined,
      registeredEffective: AgentCredentialMode | undefined,
    ): Promise<boolean> => {
      if (registeredRaw === spawnMode) {
        return spawnMode !== 'provider-oauth' || host.isCodexProxyActive();
      }
      const requested = await resolveRequestedEffective();
      const current = registeredEffective ?? registeredRaw;
      if (!this.canReuseHostForCredentialRequest(host, current, requested)) return false;
      await this.assertSupersetRequestedCredentialAvailable(current, requested);
      return true;
    };
    while (true) {
      if (!remoteHostId) await awaitCodexRouteSelection(this.waitForHostCredentialModeSwitch(key), opts.routeSignal);
      assertRouteCurrent();
      const retiring = this.retiringHosts.get(key);
      if (retiring) {
        await this.beginHostRetirement(key, retiring.host, 'recheck retirement before Host reuse');
        continue;
      }

      const existing = this.hosts.get(key);
      if (existing) {
        // Preserve getUtilityHost's reuse semantics if a switch finished while it awaited getHost.
        if (opts.reuseExistingUtilityHost) return existing;
        const currentMode = this.hostCredentialModes.get(key);
        const currentEffective = this.hostEffectiveCredentialModes.get(key);
        const subagentRoutingProfileCompatible = remoteHostId
          || await hasCompatibleSubagentRoutingProfile(
            existing,
            currentEffective ?? currentMode,
          );
        if (
          remoteHostId
          || (subagentRoutingProfileCompatible
            && await canReuseRegistered(existing, currentMode, currentEffective))
        ) {
          if (this.hosts.get(key) !== existing || this.retiringHosts.has(key)
            || (!remoteHostId && this.hostCredentialModeSwitches.has(LOCAL_MCP_REFRESH_KEY))) continue;
assertRouteCurrent();
          return existing;
        }
        await this.shutdownHostForCredentialModeChange(
          key,
          existing,
          currentMode,
          await resolveRequestedEffective(),
          {
            ...opts,
            forceRestart: !subagentRoutingProfileCompatible,
          },
        );
        continue;
      }

      const inflight = this.hostPromises.get(key);
      if (inflight) {
        if (opts.reuseExistingUtilityHost) {
          await inflight.promise;
          continue;
        }
        // inflight 的归一化形态要等 createHost 内 getState 完成才知道,这里按
        // undefined(保守)参与仲裁:跨形态请求会走重建,与改动前语义一致。
        // in-flight host 还不知道 codexProxyActive。provider-oauth 只复用同为 provider-oauth
        // 的 in-flight host(该路径 proxy 不可用会 fatal reject);不挂到 gateway/oauth 启动中的
        // host 上,避免它最终退化成 non-proxy 直连进程。
        const mayReuseInflight = !(spawnMode === 'provider-oauth' && inflight.credentialMode !== 'provider-oauth');
        // gateway-key 冷启动可能在 createHost 内升格成 oauth-bearer。若并发的订阅
        // 会话恰好在 auth fallback 尚未返回时进来，先等同一个 in-flight host 定型，
        // 再按注册后的实际形态仲裁；不能提前 supersede，避免无意义双 spawn。
        const mayResolveAsOauthSuperset =
          !inflight.credentialModeResolved &&
          spawnMode === 'oauth-bearer' &&
          inflight.credentialMode === 'gateway-key';
        if (remoteHostId || mayResolveAsOauthSuperset || (mayReuseInflight && (
          inflight.credentialMode === spawnMode ||
          this.canReuseHostCredentialMode(inflight.credentialMode, await resolveRequestedEffective())
        ))) {
          if (remoteHostId) {
            const host = await inflight.promise;
            if (this.hosts.get(key) !== host || this.retiringHosts.has(key)) continue;
            return host;
          }
          let inflightHost: AppServerHost;
          try {
            inflightHost = await inflight.promise;
          } catch (error) {
            if (!mayResolveAsOauthSuperset) throw error;
            // 订阅请求只是在等待 gateway-key 冷启动完成凭据校验、确认它是否会
            // 升格成 OAuth 超集 host；若该校验自身失败(缺 key / key 过期),不能把
            // gateway 的失败传染给凭据有效的订阅会话。failed promise 的 finally
            // 已清掉 hostPromises，重新仲裁会独立创建 oauth-bearer host。
            this.deps.logger.warn('codex getHost: unresolved gateway inflight failed; retrying OAuth host independently', {
              error: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          const registeredRaw = this.hostCredentialModes.get(key) ?? inflight.credentialMode;
          const registeredEffective = this.hostEffectiveCredentialModes.get(key);
          if (
            await hasCompatibleSubagentRoutingProfile(
              inflightHost,
              registeredEffective ?? registeredRaw,
            )
            && await canReuseRegistered(inflightHost, registeredRaw, registeredEffective)
          ) {
            if (this.hosts.get(key) !== inflightHost || this.retiringHosts.has(key)
              || this.hostCredentialModeSwitches.has(LOCAL_MCP_REFRESH_KEY)) continue;
assertRouteCurrent();
            return inflightHost;
          }
          continue;
        }
        const requestedEffective = await resolveRequestedEffective();
        const currentInflight = this.hostPromises.get(key);
        if (currentInflight?.promise === inflight.promise) {
          this.hostPromises.delete(key);
        }
        inflight.promise.then(
          async (inflightHost) => {
            if (this.hosts.get(key) === inflightHost) {
              const subagentRoutingProfileCompatible =
                await hasCompatibleSubagentRoutingProfile(
                  inflightHost,
                  this.hostEffectiveCredentialModes.get(key) ?? inflight.credentialMode,
                );
              await this.shutdownHostForCredentialModeChange(
                key,
                inflightHost,
                inflight.credentialMode,
                requestedEffective,
                {
                  ...opts,
                  forceRestart: !subagentRoutingProfileCompatible,
                },
              );
              return;
            }
            await inflightHost.retire('CodexAgent credential mode changed while host was starting');
          },
          () => undefined,
        ).catch(() => undefined);
      }

      if (this.retiringHosts.has(key) || this.hosts.has(key) || this.hostPromises.has(key)) continue;
      if (!remoteHostId && this.hostCredentialModeSwitches.has(LOCAL_MCP_REFRESH_KEY)) continue;
      assertRouteCurrent();
      const generation = this.bumpHostGeneration(key);
      // 超集归一化发生在 createHost 内(gateway-key → oauth-bearer);通过回调同步
      // in-flight 登记,让并发的 oauth-bearer 诉求命中复用而不是 supersede 重建。
      let inflightEntry: {
        promise: Promise<AppServerHost>;
        credentialMode: AgentCredentialMode | undefined;
        credentialModeResolved: boolean;
        generation: number;
      } | null = null;
      const promise = this.createHost(
        remoteHostId,
        key,
        spawnMode,
        generation,
        (resolvedMode) => {
          if (inflightEntry) {
            inflightEntry.credentialMode = resolvedMode;
            inflightEntry.credentialModeResolved = true;
          }
        },
        opts.hostPurpose,
        opts.customContextModel,
        opts.customContextWindow,
        opts.providerId,
        opts.sqliteHome,
        opts.historyHome,
        opts.localAuthPolicy,
        opts.routeIsCurrent,
        opts.deviceHostedGuestProviderId,
        opts.nativeStorageOnly,
        opts.deviceHostedGuestSessionId,
        opts.deviceHostedGuestModelIds,
        opts.localToolCatalog,
        opts.customContextProviderId,
      ).finally(() => {
        // 成功: this.hosts 已赋值, 后续走快路径; 失败: 清掉 promise 让下次调用能重试
        const current = this.hostPromises.get(key);
        if (current?.promise === promise) this.hostPromises.delete(key);
      });
      inflightEntry = {
        promise,
        credentialMode: spawnMode,
        credentialModeResolved: remoteHostId !== undefined || spawnMode !== 'gateway-key',
        generation,
      };
      this.hostPromises.set(key, inflightEntry);
      const host = await promise;
      if (this.hosts.get(key) !== host || this.retiringHosts.has(key)
        || (!remoteHostId && this.hostCredentialModeSwitches.has(LOCAL_MCP_REFRESH_KEY))) continue;
assertRouteCurrent();
      return host;
    }
  }

  /** Reserve the returned host before handing it to a non-thread operation. */
  private async acquireHostOperation(
    getHost: () => Promise<{ key: string; host: AppServerHost }>,
  ): Promise<{ key: string; host: AppServerHost; release: () => void }> {
    while (true) {
      const { key, host } = await getHost();
      if (key.startsWith('remote:')) return { key, host, release: () => {} };
      // No await between validation and reservation, including after getHost resolves.
      if (this.hostCredentialModeSwitches.has(LOCAL_MCP_REFRESH_KEY)
        || this.hostCredentialModeSwitches.has(key)
        || this.retiringHosts.has(key)
        || this.hosts.get(key) !== host) {
        await this.waitForHostCredentialModeSwitch(key);
        continue;
      }
      const generation = this.hostGenerations.get(key);
      const release = this.acquireHostSessionBindingLease(key);
      return { key, host, release: () => {
        if (this.hostGenerations.get(key) === generation) release();
      } };
    }
  }

  private async withHostOperation<T>(
    getHost: () => Promise<{ key: string; host: AppServerHost }>,
    operation: (host: AppServerHost, key: string) => Promise<T>,
  ): Promise<T> {
    const { key, host, release } = await this.acquireHostOperation(getHost);
    try {
      return await operation(host, key);
    } finally {
      release();
    }
  }

  private async getUtilityHost(): Promise<{ key: string; host: AppServerHost }> {
    const key = hostKey();
    while (true) {
      await this.waitForHostCredentialModeSwitch(key);
      if (this.hostCredentialModeSwitches.has(LOCAL_MCP_REFRESH_KEY)) continue;
      const retiring = this.retiringHosts.get(key);
      if (retiring) {
        await this.beginHostRetirement(key, retiring.host, 'recheck retirement before utility use');
        continue;
      }
      const existing = this.hosts.get(key);
      if (existing) return { key, host: existing };
      const inflight = this.hostPromises.get(key);
      if (!inflight) return { key, host: await this.getHost(undefined, undefined, { reuseExistingUtilityHost: true }) };
      const host = await inflight.promise;
      if (this.hosts.get(key) !== host || this.retiringHosts.has(key)) continue;
      return { key, host };
    }
  }

  /** Start the local OAuth host used by non-model account control-plane RPCs. */
  private async withStartedAccountHost<T>(providerId: string | undefined, operation: (host: AppServerHost) => Promise<T>, startupTimeoutMs?: number): Promise<T> {
    const credentialMode = 'oauth-bearer';
    const key = providerId ? `local-account:${providerId}:control-plane` : localControlPlaneHostKey(credentialMode);
    return this.withHostOperation(async () => ({
      key,
      host: await this.getHost(undefined, credentialMode, { providerId, keyOverride: key, hostPurpose: 'control-plane' }),
    }), async (host) => {
      const init = startupTimeoutMs
        ? await host.ensureStartedWithTimeout(startupTimeoutMs, 'account token refresh')
        : await host.ensureStarted();
      if (init.codexHome && !providerId) this.codexHome = init.codexHome;
      return operation(host);
    });
  }

  /** Read one SSH host's complete native catalog without publishing it as local discovery. */
  async listRemoteModels(remoteHostId: string): Promise<CodexModelListResponse['data']> {
    if (!remoteHostId) throw new Error('SSH host is required');
    return this.withHostOperation(async () => ({
      key: hostKey(remoteHostId), host: await this.getHost(remoteHostId),
    }), async (host, key) => {
      await host.ensureStartedWithTimeout(CODEX_MODEL_REFRESH_DEADLINE_MS, 'remote model list');
      const deadline = Date.now() + CODEX_MODEL_REFRESH_DEADLINE_MS;
      const models = await listCodexModels((cursor) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new AppServerRequestTimeoutError('remote model list', CODEX_MODEL_REFRESH_DEADLINE_MS);
        return host.request<CodexModelListResponse>(Method.ModelList,
          { cursor, limit: 100, includeHidden: false },
          { timeoutMs: Math.min(remaining, CODEX_MODEL_LIST_RPC_TIMEOUT_MS) });
      });
      if (this.hosts.get(key) !== host) throw new Error('SSH Codex connection changed');
      return models;
    });
  }

  /**
   * 向本地 app-server 实时读取完整模型清单并交给宿主。
   * 不能只读 models_cache.json：OAuth 登录前会清旧 cache，model/list 也是 cache ready barrier。
   */
  override async refreshLocalModels(options?: RefreshLocalModelsOptions): Promise<boolean> {
    const credentialMode = options?.credentialMode;
    if (!credentialMode) return this.refreshLocalModelsWithinDeadline(options);

    const key = codexLocalAuthHostIdentity(
      options?.providerId ? `local-account:${options.providerId}:models` : localControlPlaneHostKey(credentialMode),
      credentialMode === 'gateway-key' ? 'isolated' : 'legacy-shared',
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AppServerRequestTimeoutError('model refresh', CODEX_MODEL_REFRESH_DEADLINE_MS));
      }, CODEX_MODEL_REFRESH_DEADLINE_MS);
    });
    try {
      return await Promise.race([
        this.refreshLocalModelsWithinDeadline(options),
        deadline,
      ]);
    } catch (error) {
      if (error instanceof AppServerRequestTimeoutError) {
        await this.retireHostKey(key, 'Codex control-plane model refresh timed out', {
          failIfActive: false,
          logPrefix: 'codex model refresh',
        });
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async refreshLocalModelsWithinDeadline(
    options?: RefreshLocalModelsOptions,
  ): Promise<boolean> {
    const credentialMode = options?.credentialMode;
    // 显式 provider 刷新使用独立 control-plane app-server。不能为了发一次 model/list
    // 切换共享 local host 的凭证形态：切换协调器会关闭空闲会话，忙碌会话则直接拒绝。
    const key = codexLocalAuthHostIdentity(
      options?.providerId ? `local-account:${options.providerId}:models` : credentialMode
        ? localControlPlaneHostKey(credentialMode) : hostKey(),
      credentialMode === 'gateway-key' ? 'isolated' : 'legacy-shared',
    );
    return this.withHostOperation(async () => ({
      key: credentialMode ? key : hostKey(),
      host: credentialMode
        ? await this.getHost(undefined, credentialMode, {
          providerId: options?.providerId,
          ...(credentialMode === 'gateway-key' ? { localAuthPolicy: 'isolated' as const } : {}),
          keyOverride: key,
          hostPurpose: 'control-plane',
        })
        : (await this.getUtilityHost()).host,
    }), async (host) => {
      const init = await host.ensureStarted();
      if (init.codexHome && !options?.providerId) this.codexHome = init.codexHome;

      const models: CodexModelListResponse['data'] = [];
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      try {
        do {
          const page: CodexModelListResponse = await host.request<CodexModelListResponse>(
            Method.ModelList,
            {
              cursor,
              limit: 100,
              includeHidden: false,
            },
            { timeoutMs: CODEX_MODEL_LIST_RPC_TIMEOUT_MS },
          );
          models.push(...(Array.isArray(page.data) ? page.data : []));
          const next: string | null = typeof page.nextCursor === 'string' && page.nextCursor.length > 0
            ? page.nextCursor
            : null;
          if (next && seenCursors.has(next)) {
            throw new Error(`Codex app-server model/list repeated cursor: ${next}`);
          }
          if (next) seenCursors.add(next);
          cursor = next;
        } while (cursor !== null);
      } catch (error) {
        if (credentialMode && error instanceof AppServerRequestTimeoutError) {
          await this.retireHostKey(key, 'Codex control-plane model/list timed out', {
            failIfActive: false,
            logPrefix: 'codex model list refresh',
          });
        }
        throw error;
      }

      // Auth 切换 / logout 可能在分页请求期间 retire 旧 host。旧账号的迟到响应绝不能
      // 覆盖新账号目录；只有仍登记为当前 local host 的结果才允许交给宿主。
      if (this.hosts.get(key) !== host || !this.deps.onCodexLocalModelsListed) return false;
      if (options?.providerId) await this.deps.onCodexLocalModelsListed(models, options.providerId);
      else await this.deps.onCodexLocalModelsListed(models);
      return true;
    });
  }

  /** Read ChatGPT subscription windows and banked reset credits via app-server RPC. */
  override async readAccountRateLimits(providerId?: string): Promise<AccountRateLimitsResponse> {
    // This RPC is credential-specific, unlike model/list or memory utilities. Requiring
    // oauth-bearer prevents a gateway/provider host from reading or mutating the wrong
    // account context; getHost refuses to replace a differently-authenticated active host.
    return this.withStartedAccountHost(providerId,
      host => readAccountRateLimitsWithRefresh((method, params, options) => host.request(method, params, options)));
  }

  /** Consume one reset credit on the non-model app-server control plane. */
  override async consumeAccountRateLimitResetCredit(
    params: ConsumeAccountRateLimitResetCreditParams,
    providerId?: string,
  ): Promise<ConsumeAccountRateLimitResetCreditResponse> {
    return this.withStartedAccountHost(providerId,
      host => host.request<ConsumeAccountRateLimitResetCreditResponse>(Method.AccountRateLimitResetCreditConsume, params));
  }

  private async createHost(
    remoteHostId: string | undefined,
    key: string,
    credentialMode: AgentCredentialMode | undefined,
    generation: number,
    onSpawnCredentialModeResolved?: (mode: AgentCredentialMode | undefined) => void,
    hostPurpose?: 'control-plane' | 'review' | 'custom-context',
    customContextModel?: string,
    customContextWindow?: number,
    providerId?: string,
    sqliteHome?: string,
    historyHome?: string,
    localAuthPolicy?: 'isolated' | 'legacy-shared',
    routeIsCurrent?: () => boolean,
    deviceHostedGuestProviderId?: string,
    nativeStorageOnly?: boolean,
    deviceHostedGuestSessionId?: string,
    deviceHostedGuestModelIds?: readonly string[],
    localToolCatalog?: string,
    customContextProviderId?: string | null,
  ): Promise<AppServerHost> {
    const seq = (this.createHostSeqByKey.get(key) ?? 0) + 1;
    this.createHostSeqByKey.set(key, seq);
    // 诊断日志: 正常每次 dispose 之间 seq 只应该出现一次。出现 seq>=2 或 hadHost=true
    // = in-flight 去重失效, 多个 codex app-server 子进程被 spawn, 前面的会变孤儿。
    // 正常路径走 info, 异常路径才升级到 error, 避免首次启动刷 ERROR 误导排查。
    const hadHost = this.hosts.has(key);
    const abnormal = seq > 1 || hadHost;
    const level = abnormal ? 'error' : 'info';
    this.deps.logger[level]('codex createHost: spawning app-server', {
      seq,
      hadHost,
      key,
      credentialMode: credentialMode ?? 'fallback',
      generation,
    });
    const assertCurrentGeneration = (stage: string): void => {
      if (routeIsCurrent && !routeIsCurrent()) throw new CodexRouteSelectionChangedError();
      if ((this.hostGenerations.get(key) ?? 0) === generation) return;
      throw new Error(`Codex app-server host creation was superseded before ${stage}`);
    };
    // 方案 A(订阅超集 spawn):本地 gateway-key 诉求且 auth fallback 实际持有 OAuth 时,
    // 升格为 oauth-bearer spawn。超集进程经 proxy 按会话换网关 key(XD/折扣计费不变),
    // 同时还能服务订阅会话 —— 订阅/API 会话真正并行,不再因来源切换重建 host 排队。
    let spawnCredentialMode = credentialMode;
    let requestedGatewayState: AuthState | null = null;
    if (!remoteHostId && localAuthPolicy !== 'isolated' && credentialMode === 'gateway-key') {
      // 即使升格为 OAuth spawn,API 会话的出口仍依赖 gateway key,必须先验证原诉求。
      requestedGatewayState = await this.deps.auth.getState({ credentialMode: 'gateway-key' });
      assertCurrentGeneration('gateway credential validation');
      if (!requestedGatewayState.authenticated) {
        throw new AgentNotAuthenticatedError(
          'codex',
          `codex gateway credentials unavailable: ${requestedGatewayState.errorReason ?? 'no_credentials'}`,
        );
      }
      // 受邀者任务的 app-server 不升格：超集进程会带上本机用户的订阅登录，受邀者只能用分享的供应商。
      if (!deviceHostedGuestProviderId) {
        try {
          const fallbackState = await this.deps.auth.getState();
          if (fallbackState.authenticated && fallbackState.authSource === 'oauth') {
            spawnCredentialMode = 'oauth-bearer';
            this.deps.logger.info('codex createHost: upgrading gateway-key spawn to oauth superset host', { key });
          }
        } catch (error) {
          this.deps.logger.warn('codex createHost: superset spawn resolution failed; keeping gateway-key spawn', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        assertCurrentGeneration('superset spawn resolution');
      }
    }

    // 超集升格硬依赖 proxy。proxy 不可用时降级回原 gateway-key spawn 重来一轮;
    // 降级后 upgraded=false,循环至多跑两轮必收敛。
    const baseExtraArgs = !remoteHostId && this.deps.disableCodexPluginRuntime
      ? ['--disable', 'plugins', '--disable', 'remote_plugin']
      : [];
    let effectiveMode: AgentCredentialMode | undefined;
    let env: Record<string, string> = {};
    let extraArgs = [...baseExtraArgs];
    let codexProxyActive = false;
    let codexBrowserUseAvailable = false;
    let codexBrowserUseVersion: string | undefined;
    let codexBrowserUseStartupTimeoutMs: number | undefined;
    let remoteCompactionProviderId: string | undefined;
    let cindyRemoteCompactionProviderId: string | undefined;
    let localCompactionProviderId: string | undefined;
    let defaultModelProviderId: string | undefined;
    let codexCustomProviderRoutes: CodexExtraSpawnConfig['codexCustomProviderRoutes'];
    let buildSessionMcpConfig: CodexExtraSpawnConfig['buildSessionMcpConfig'];
    let subagentModelFallback: string | undefined;
    let subagentRoute: CodexExtraSpawnConfig['subagentRoute'];
    let smartSubagentRoutes: CodexExtraSpawnConfig['smartSubagentRoutes'];
    let codexSubagentRoutingSignature: string | undefined;
    let codexOpenAiWebSocketsEnabled = true;
    let codexSubagentRoutingProfile: CodexExtraSpawnConfig['codexSubagentRoutingProfile'] = 'default';
    let hostRetirementCleanup: CodexExtraSpawnConfig['onHostRetired'];
    // Capture the owner/account reader before any asynchronous authentication work.
    const readAccountTokens = !remoteHostId && historyHome
      ? this.deps.createCodexAuthTokenReader?.(providerId)
      : undefined;
    for (;;) {
      const upgradedToSuperset = spawnCredentialMode !== credentialMode;
      onSpawnCredentialModeResolved?.(spawnCredentialMode);
      const authOptions = spawnCredentialMode || providerId ? { credentialMode: spawnCredentialMode, ...(providerId ? { providerId } : {}) } : undefined;
      const state =
        spawnCredentialMode === 'gateway-key' && requestedGatewayState
          ? requestedGatewayState
          : await this.deps.auth.getState(authOptions);
      assertCurrentGeneration('auth');
      if (!state.authenticated) {
        throw new AgentNotAuthenticatedError('codex', `codex not authenticated: ${state.errorReason ?? 'no_credentials'}`);
      }
      effectiveMode =
        spawnCredentialMode ?? resolveEffectiveCredentialModeFromAuthSource(undefined, state.authSource);
      env = await buildCodexEnv(this.deps.auth, this.deps.runtimeConfig, authOptions);
      assertCurrentGeneration('env');

      extraArgs = [...baseExtraArgs];
      codexProxyActive = false;
      codexBrowserUseAvailable = false;
      codexBrowserUseVersion = undefined;
      codexBrowserUseStartupTimeoutMs = undefined;
      remoteCompactionProviderId = undefined;
      cindyRemoteCompactionProviderId = undefined;
      localCompactionProviderId = undefined;
      defaultModelProviderId = undefined;
      codexCustomProviderRoutes = undefined;
      buildSessionMcpConfig = undefined;
      subagentModelFallback = undefined;
      subagentRoute = undefined;
      smartSubagentRoutes = undefined;
      codexSubagentRoutingSignature = undefined;
      codexOpenAiWebSocketsEnabled = true;
      codexSubagentRoutingProfile = 'default';
      hostRetirementCleanup = undefined;
      if (this.deps.prepareCodexExtraSpawnConfig) {
        try {
          const cfg = await this.deps.prepareCodexExtraSpawnConfig(
            this.deps.mcpProviders ?? [],
            {
              remoteHostId,
              ...(providerId ? { providerId } : {}),
              ...(key.startsWith('local-account:') ? { codexHome: env.CODEX_HOME } : {}),
              ...(!remoteHostId && historyHome ? { runtimeCodexHome: historyHome } : {}),
              // 受邀者任务的 app-server 与账号会话一样走按 host 分开的 proxy(鉴权注入方式冻结在这个 host 上)，
              // 不改写本机用户任务共用的 proxy 状态。
              ...(key.startsWith('local-account:') || key.startsWith(LOCAL_GUEST_HOST_PREFIX) || deviceHostedGuestProviderId || localToolCatalog
                ? { accountHostKey: `${key}:${generation}` } : {}),
              credentialMode: spawnCredentialMode,
              ...(localAuthPolicy === 'isolated'
                ? { localAuthPolicy, hostScopeKey: `${key}:${generation}` }
                : {}),
              ...(spawnCredentialMode !== credentialMode
                ? { requestedCredentialMode: credentialMode }
                : {}),
              ...(hostPurpose ? { hostPurpose } : {}),
              ...(nativeStorageOnly ? { nativeStorageOnly } : {}),
              ...(hostPurpose === 'custom-context'
                ? {
                    customContextModel,
                    customContextWindow,
                    customContextProviderId,
                    customContextHostKey: `${key}:${generation}`,
                  }
                : {}),
              ...(deviceHostedGuestProviderId ? { deviceHostedGuestProviderId, deviceHostedGuestSessionId, deviceHostedGuestModelIds } : {}),
            },
          );
          hostRetirementCleanup = cfg.onHostRetired;
          assertCurrentGeneration('spawn config');
          if (
            cfg.requiredSpawnCredentialMode
            && cfg.requiredSpawnCredentialMode !== spawnCredentialMode
          ) {
            this.deps.logger.info('codex createHost: host routing requires a compatible spawn credential mode', {
              key,
              requestedCredentialMode: credentialMode ?? 'fallback',
              previousSpawnCredentialMode: spawnCredentialMode ?? 'fallback',
              requiredSpawnCredentialMode: cfg.requiredSpawnCredentialMode,
            });
            await hostRetirementCleanup?.();
            hostRetirementCleanup = undefined;
            // 受邀者任务不换凭证形态(换了就不再是分享的那个供应商的凭证)。
            if (localAuthPolicy === 'isolated' || deviceHostedGuestProviderId) {
              throw Object.assign(new Error('Codex route requires official OAuth on an external-auth host'), { codexSpawnConfigFatal: true });
            }
            spawnCredentialMode = cfg.requiredSpawnCredentialMode;
            continue;
          }
          Object.assign(env, cfg.extraEnv);
          extraArgs = [
            ...baseExtraArgs,
            ...(deviceHostedGuestProviderId ? withoutCodexSpawnModelOverrides(cfg.extraArgs) : cfg.extraArgs),
          ];
          buildSessionMcpConfig = cfg.buildSessionMcpConfig;
          // 受邀者任务不接受任何子代理改道(子代理沿用会话模型，留在分享的供应商内)。
          subagentModelFallback = deviceHostedGuestProviderId ? undefined : cfg.subagentModelFallback;
          subagentRoute = deviceHostedGuestProviderId ? undefined : cfg.subagentRoute;
          smartSubagentRoutes = deviceHostedGuestProviderId ? undefined : cfg.smartSubagentRoutes;
          codexSubagentRoutingSignature = cfg.codexSubagentRoutingSignature;
          codexOpenAiWebSocketsEnabled = cfg.codexOpenAiWebSocketsEnabled !== false;
          codexSubagentRoutingProfile = cfg.codexSubagentRoutingProfile ?? 'default';
          codexProxyActive = cfg.codexProxyActive === true && !remoteHostId;
          defaultModelProviderId = codexProxyActive ? cfg.codexDefaultModelProviderId : undefined;
          // Remote daemons own their browser companion and its CODEX_HOME;
          // preserve the host-provided availability snapshot instead of
          // forcing every remote target into the local fail-closed state.
          codexBrowserUseAvailable = cfg.codexBrowserUseAvailable === true;
          codexBrowserUseVersion = cfg.codexBrowserUseVersion;
          codexBrowserUseStartupTimeoutMs = cfg.codexBrowserUseStartupTimeoutMs;
          // OpenAI 身份 provider 依赖 loopback proxy 路由订阅直连;proxy 不可用
          // (退化直连网关)时不得下发,否则远端压缩请求会打到不支持它的上游。
          if (codexProxyActive && cfg.codexRemoteCompactionProviderId) {
            remoteCompactionProviderId = cfg.codexRemoteCompactionProviderId;
          }
          if (codexProxyActive && cfg.codexCindyRemoteCompactionProviderId) {
            cindyRemoteCompactionProviderId = cfg.codexCindyRemoteCompactionProviderId;
            localCompactionProviderId = cfg.codexLocalCompactionProviderId;
          }
          if (codexProxyActive && cfg.codexCustomProviderRoutes?.length) {
            codexCustomProviderRoutes = cfg.codexCustomProviderRoutes;
          }
          this.deps.logger.info('codex MCP bridge ready', {
            providers: this.deps.mcpProviders?.length ?? 0,
            extraArgsCount: extraArgs.length,
            codexProxyActive,
          });
        } catch (e) {
          await hostRetirementCleanup?.();
          hostRetirementCleanup = undefined;
          if (e instanceof CodexRouteSelectionChangedError) throw e;
          const isFatalSpawnConfigError =
            (typeof e === 'object' && e !== null &&
              (e as { codexSpawnConfigFatal?: unknown }).codexSpawnConfigFatal === true);
          if (isFatalSpawnConfigError && upgradedToSuperset) {
            this.deps.logger.warn('codex createHost: superset spawn hit fatal proxy error; downgrading to gateway-key spawn', {
              key,
              message: (e as Error).message,
            });
            spawnCredentialMode = credentialMode;
            continue;
          }
          this.deps.logger.error(
            isFatalSpawnConfigError
              ? 'codex MCP bridge prep failed with fatal spawn config error'
              : 'codex MCP bridge prep failed, continuing without lizi MCP',
            { message: (e as Error).message },
          );
          if (isFatalSpawnConfigError) throw e;
        }
      }
      if (upgradedToSuperset && !codexProxyActive) {
        this.deps.logger.warn('codex createHost: superset spawn lacks loopback proxy; downgrading to gateway-key spawn', { key });
        await hostRetirementCleanup?.();
        hostRetirementCleanup = undefined;
        spawnCredentialMode = credentialMode;
        continue;
      }
      break;
    }
    if (!remoteHostId && sqliteHome) extraArgs.push('-c', `sqlite_home=${JSON.stringify(sqliteHome)}`);
    if (localToolCatalog) extraArgs.push('-c', `model_catalog_json=${JSON.stringify(localToolCatalog)}`);
    let externalAuth: CodexExternalAuth | undefined;
    const requireEphemeralAuth = !remoteHostId && (localAuthPolicy === 'isolated'
      || (!!historyHome && path.resolve(historyHome) !== path.resolve(env.CODEX_HOME ?? '')));
    if (!remoteHostId && hostPurpose === 'control-plane' && effectiveMode === 'oauth-bearer' && env.CODEX_HOME) {
      // Managed refresh must read the selected account's file, not an inherited identity.
      env = useCodexHistoryHome(env, env.CODEX_HOME);
    }
    if (requireEphemeralAuth) {
      // Extra spawn configuration above intentionally uses the TARGET credential
      // home (proxy auth, model catalogs and account controls). Only the native
      // runtime uses the canonical history home, including lineage/writer locks.
      env = useCodexHistoryHome(env, historyHome ?? env.CODEX_HOME);
      extraArgs.push('-c', 'cli_auth_credentials_store="ephemeral"');
      if (effectiveMode === 'oauth-bearer') {
        if (!readAccountTokens) {
          await hostRetirementCleanup?.();
          throw new Error('Codex account authentication bridge is unavailable');
        }
        externalAuth = {
          readTokens: async (refresh, staleAccessToken) => {
            assertCurrentGeneration('external authentication');
            // Validate scope before opening a native credential control-plane host.
            let tokens = await readAccountTokens();
            assertCurrentGeneration('external authentication scope');
            if (refresh && tokens.accessToken === staleAccessToken) {
              await this.withStartedAccountHost(providerId, async (accountHost) => {
                assertCurrentGeneration('account token refresh');
                await accountHost.request('account/read', { refreshToken: true }, { timeoutMs: 8_000 });
              }, 8_000);
              tokens = await readAccountTokens();
            }
            assertCurrentGeneration('external authentication result');
            return tokens;
          },
        };
      }
    }
    if (baseExtraArgs.length > 0) {
      this.deps.logger.info('Codex plugin runtime disabled for local app-server', {
        plugins: false,
        remotePlugin: false,
      });
    }
    try {
      assertCurrentGeneration('transport');
    } catch (error) {
      await hostRetirementCleanup?.();
      hostRetirementCleanup = undefined;
      throw error;
    }

    // 选 transport: 本地 → StdioTransport (spawn codex app-server)
    //               远端 → host 注入的 getRemoteCodexTransport (SSH+daemon+proxy+ws)
    // 注意: 远端路径下 env/extraArgs/buildCodexEnv 不参与 — 远端 daemon 由远端
    // isolated CODEX_HOME 的配置驱动, 我们走 daemon control socket 拿到的协议
    // channel, 不在本地起进程, 所以本地的 env / -c overrides 没有意义。MCP 桥接
    // 改由 desktop 侧在 session start 前置完成 (remote-ssh/codex-remote-mcp.ts):
    // 往远端 config.toml 写 mcp_servers 段, daemon 经 SSH remote-forward 直连
    // 本机 HTTP bridge, tool call 按 params._meta.threadId 路由(与本地一致)。
    let createTransport: (modelProvider?: string) => import('./app-server/transport.js').Transport;
    if (remoteHostId) {
      if (!this.deps.getRemoteCodexTransport) {
        throw new Error(
          `codex remote session requested (remoteHostId=${remoteHostId}) but host did not provide getRemoteCodexTransport`,
        );
      }
      const provider = this.deps.getRemoteCodexTransport;
      createTransport = () => provider(remoteHostId);
    } else {
      const binaryPath = this.deps.binaryPath;
      createTransport = (modelProvider) => createStdioTransport({
        binaryPath,
        env,
        extraArgs: modelProvider
          ? [...extraArgs, '-c', `model_provider=${JSON.stringify(modelProvider)}`]
          : extraArgs,
        // 必须把注销函数交回 transport：进程退出后登记要随之移除，
        // 退出回收（codex-tool-tree-reaper）据此认领 PID，残留登记遇 PID 复用会误杀。
        onProcessSpawned: (pid) => this.deps.registerLocalCodexAppServerProcess?.({
          pid,
          role:
            hostPurpose === 'control-plane'
              ? 'control-plane-service'
              : 'task-host',
        }),
      });
    }

    const host = new AppServerHost({
      createTransport,
      supportsModelProviderSelection: codexProxyActive && !remoteHostId,
      defaultModelProviderId,
      externalAuth,
      requireEphemeralAuth,
      logger: this.deps.logger,
      // 自报名只进 codex app-server 的 userAgent 展示串,无门控消费
      // (2026-07-17 随品牌翻转改 cindy;上游 gating 走 originator,与此无关)。
      clientInfo: { name: 'cindy', version: '0.0.0' },
      codexProxyActive,
      codexBrowserUseAvailable,
      codexBrowserUseVersion,
      codexBrowserUseStartupTimeoutMs,
      remoteCompactionProviderId,
      cindyRemoteCompactionProviderId,
      localCompactionProviderId,
      codexCustomProviderRoutes,
      buildSessionMcpConfig,
      subagentModelFallback,
      subagentRoute,
      smartSubagentRoutes,
      codexSubagentRoutingSignature,
      getSubagentIdentity: (childThreadId) =>
        this.deps.getCodexSubagentIdentity?.({ childThreadId }),
      codexOpenAiWebSocketsEnabled,
      codexSubagentRoutingProfile,
      onRetired: hostRetirementCleanup,
      // app-server 对失败 RPC 返回 cloudRequirements + Auth/relogin 结构化错误时,当前 host
      // 持有的 token 已不可用。stderr 与工具输出只做诊断,绝不驱动鉴权状态。保留 host 只会
      // 持续撞鉴权失败; auth.invalidate 会触发 logout + 通知 UI 重登。延后到 microtask
      // 防止在 JSON-RPC response 分发回调里同步收割自己。远端也走同一结构化协议路径。
      onAuthInvalidated: (reason) => {
        const usesLocalAuth = !remoteHostId && localAuthPolicy !== 'isolated';
        this.deps.logger.warn('codex auth invalidated', {
          reason,
          key,
          localAuthWillEnterUnprovenRecovery: usesLocalAuth,
        });
        Promise.resolve()
          .then(async () => {
            if (usesLocalAuth) {
              try {
                // The app-server protocol does not expose which auth.json generation the child
                // loaded. Parent-side snapshots before spawn, after initialize, or per request can
                // all race that read, so they cannot authorize credential deletion or logout.
                await this.deps.auth.invalidate?.(reason, {
                  providerId,
                  credentialAttribution: 'unproven',
                });
              } catch (e) {
                this.deps.logger.error('auth.invalidate threw', { message: (e as Error).message });
              }
            }
            // 防御兜底: 只收掉报错的 host key。远端 daemon 的 auth 失效不应该扩散到
            // local host 或其它 remote host,否则无关会话会绕过 Session.close 变 stale。
            try {
              await this.retireHostKey(key, `CodexAgent auth invalidated: ${reason}`, {
                failIfActive: false,
                logPrefix: 'codex auth invalidated',
              });
            } catch { /* no-op */ }
          })
          .catch(() => undefined);
      },
    });
    try {
      assertCurrentGeneration('registration');
    } catch (error) {
      await host.retire('CodexAgent host creation superseded');
      throw error;
    }
    this.hosts.set(key, host);
    // 登记超集归一化后的实际 spawn 形态,供后续复用仲裁。
    this.hostCredentialModes.set(key, spawnCredentialMode);
    this.hostEffectiveCredentialModes.set(key, effectiveMode);
    return host;
  }

  /**
   * Phase 4: oneShot 也走 host (临时 thread, 跑完 release subscription, server 端 thread state
   * 自然 GC)。不再依赖 @openai/codex-sdk。
   *
   * 用 gpt-5.4-mini + tmpdir + sandbox readOnly + approvalPolicy never (起标题不能弹审批)。
   *
   * 失败语义: 跟 claude-code/oneShot 对齐, 抛 OneShotError (timeout/malformed),
   * 调用方按 reason 决定 catch/swallow。OneShotOptions 中 model/maxTokens 字段当前忽略
   * (Codex host 协议没暴露 max_tokens; model 走 thread/start 那已是默认 mini), signal 接通。
   */
  async oneShot(prompt: string, opts?: OneShotOptions): Promise<string> {
    const log = this.deps.logger.child('codex/oneShot');
    const timeoutMs = opts?.timeoutMs ?? 30_000;
    const developerInstructions = [opts?.systemPrompt, opts?.responseInstructions]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n');
    // OneShotOptions.maxTokens 在 Codex 协议层就没暴露 (protocol.ts ThreadStartParams /
    // TurnStartParams 都没 max_tokens 字段) —— 静默忽略, 但调用方传了就 warn 一下,
    // 避免未来加新 oneShot 场景时 "我设了上限怎么没生效" 的隐性 bug。
    // (注意: 即使塞进 ThreadStartParams.config, ChatGPT 订阅的
    // chatgpt.com/backend-api/codex 端点对 max_output_tokens 也直接 400,
    // 见 anthropic-responses-bridge/src/translate-request.ts:290 —— 这条路由
    // 上游就拒绝该参数, 不是协议层漏字段那么简单。)
    if (opts?.maxTokens !== undefined) {
      log.warn(`maxTokens=${opts.maxTokens} ignored — Codex host protocol does not expose max_tokens`);
    }
    let releaseHost: (() => void) | undefined;
    let subscription: ThreadSubscription | null = null;
    try {
      const leased = await this.acquireHostOperation(() => this.getUtilityHost());
      releaseHost = leased.release;
      const { host } = leased;
      await host.ensureStarted();

      // Host startup can await credential discovery and process readiness. The
      // caller may have been replaced during that window, so perform the final
      // ownership/configuration check immediately before the real thread/start
      // dispatch. A rejected guard must not create a thread for the old owner.
      if (opts?.beforeDispatch && !(await opts.beforeDispatch())) {
        throw new OneShotError('network', 'Codex oneShot dispatch guard rejected');
      }

      // 创建临时 thread (跟主 session 共享 server 但 thread state 隔离)
      const startResp = await host.request<ThreadStartResponse>(Method.ThreadStart, {
        cwd: os.tmpdir(),
        model: opts?.model ?? 'gpt-5.4-mini',
        approvalPolicy: 'never',
        sandbox: 'read-only', // kebab-case (v2.rs SandboxMode)
        // Auxiliary title/summary calls must not start a native Goal loop either.
        config: { 'features.goals': false },
        ...(developerInstructions ? { developerInstructions } : {}),
      } as ThreadStartParams);
      const threadId = startResp.thread.id;

      // 等首条 agentMessage.completed 文本; 出 error 通知用 sentinel object 区分超时/正常
      type OneShotResult = { kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'error'; message: string };
      let resolve: (r: OneShotResult) => void = () => {};
      const result = new Promise<OneShotResult>((res) => {
        resolve = res;
      });
      let currentTurnId: string | null = null;
      let resolved = false;

      subscription = host.subscribeThread(threadId, {
        turnStarted: (params) => {
          currentTurnId = params.turn.id;
        },
        itemCompleted: (params) => {
          if (resolved) return;
          const item = params.item as { type?: string; text?: string };
          if (item.type === 'agentMessage' && typeof item.text === 'string') {
            resolved = true;
            resolve({ kind: 'text', text: item.text.trim() });
          }
        },
        turnCompleted: () => {
          if (!resolved) {
            resolved = true;
            resolve({ kind: 'empty' });
          }
        },
        error: (params) => {
          if (resolved) return;
          // willRetry=true 是 codex server 可自愈的暂时错误(transient blip /
          // "Reconnecting... N/5"),server 会自动重连重试,不应中断 turn — 与主
          // 会话 error handler、translator 及 protocol.ts ErrorNotification 注释
          // 一致。忽略它,继续等 agentMessage / turnCompleted / 自家超时,否则像
          // 起标题这种短任务会被一次上游抖动直接打成 OneShotError。
          if (params.willRetry === true) {
            log.debug('oneShot transient error (will retry), ignored', {
              message: params.error?.message,
            });
            return;
          }
          resolved = true;
          log.warn('oneShot error notification', { message: params.error?.message });
          resolve({ kind: 'error', message: params.error?.message ?? 'unknown codex error' });
        },
      });

      // thread/start 创建了临时 thread 后,到 turn/start 之间仍可能发生 owner 切换。
      // 再次复核并在拒绝时释放订阅,避免把旧 owner 的 prompt 发进已创建的 thread。
      if (opts?.beforeDispatch && !(await opts.beforeDispatch())) {
        const pendingSubscription = subscription;
        subscription = null;
        try {
          await pendingSubscription?.release();
        } catch (releaseError) {
          log.warn('oneShot dispatch guard rejected; failed to release temporary thread', {
            error: releaseError instanceof Error ? releaseError.message : String(releaseError),
          });
        }
        throw new OneShotError('network', 'Codex oneShot dispatch guard rejected before turn/start');
      }

      await host.request(Method.TurnStart, {
        threadId,
        input: [{ type: 'text', text: prompt }],
      } as TurnStartParams);

      // 自家超时 sentinel (kind 'timeout'), 走外部 signal 也走同一通道
      const timeoutP = new Promise<OneShotResult>((res) => {
        const t = setTimeout(() => res({ kind: 'error', message: '__TIMEOUT__' }), timeoutMs);
        opts?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          res({ kind: 'error', message: '__ABORTED__' });
        });
      });
      const r = await Promise.race([result, timeoutP]);

      // 如果 turn 没结束就拿到结果, 主动 interrupt 避免 server 继续算
      if (r.kind === 'text' && currentTurnId) {
        host.request(Method.TurnInterrupt, { threadId, turnId: currentTurnId }).catch(() => undefined);
      }

      if (r.kind === 'text') {
        if (!r.text) throw new OneShotError('malformed', 'Empty agentMessage from codex');
        return r.text;
      }
      if (r.kind === 'empty') {
        throw new OneShotError('malformed', 'Codex turn completed without agentMessage');
      }
      // r.kind === 'error'
      if (r.message === '__TIMEOUT__') {
        throw new OneShotError('timeout', `Codex oneShot timed out after ${timeoutMs}ms`);
      }
      if (r.message === '__ABORTED__') {
        // 外部 abort 不归类成 OneShotError (跟 claude 端一致)。Claude 端走 SDK 抛 web 标准
        // AbortError (DOMException), 这里手动 abort 也用同款类型, 让调用方一律靠
        // err.name === 'AbortError' 或 signal.aborted 判断, 不用区分 agent。
        throw new DOMException('aborted', 'AbortError');
      }
      throw new OneShotError('malformed', `Codex error: ${r.message}`);
    } catch (err) {
      if (err instanceof OneShotError) {
        log.error('oneShot failed', { reason: err.reason, error: err.message });
        throw err;
      }
      log.error('oneShot failed', { error: String(err) });
      // 网络/host 启动等未分类失败统一归 'network' (跟 claude 端 mapAnthropicError 一致)
      throw new OneShotError('network', err instanceof Error ? err.message : String(err));
    } finally {
      try { await subscription?.release(); } catch { /* no-op */ }
      releaseHost?.();
    }
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    const signal = this.routeResolutionAbort.signal;
    for (let attempt = 0; ; attempt++) {
      const startup = {
        signal, threadDispatched: false,
        cleanup: undefined as (() => Promise<void>) | undefined,
        customContext: undefined as (() => Promise<void>) | undefined,
      };
      try {
        signal.throwIfAborted();
        return await this.startSessionInternal(opts, (cleanup) => {
          startup.customContext = cleanup ?? undefined;
        }, startup);
      } catch (error) {
        if (!startup.threadDispatched
          && (error instanceof CodexRouteSelectionChangedError || error instanceof CodexNativeInitializationStoppedError || signal.aborted)) {
          // No thread was submitted. Release this startup's lease and retire only
          // an unused host; another live handle's process belongs to that handle.
          await startup.cleanup?.();
          if (!signal.aborted && error instanceof CodexRouteSelectionChangedError && error.retryable && attempt < 7) continue;
          throw new AgentStartupStoppedError(signal.aborted ? signal.reason : error);
        }
        if (startup.customContext) {
          await startup.customContext();
          // Retirement of this isolated local host proves the failed startup
          // cannot keep using its workdir. Propagate that proof to Maker so its
          // onStartFailed hook releases the directory lease.
          if (!opts.remoteHostId) throw new AgentStartupStoppedError(error);
        }
        throw error;
      }
    }
  }

  private async startSessionInternal(
    opts: StartSessionOptions,
    registerFailedCustomContextStartupCleanup: (cleanup: (() => Promise<void>) | null) => void,
    startup: { signal: AbortSignal; threadDispatched: boolean; cleanup?: () => Promise<void> },
  ): Promise<AgentSessionHandle> {
    // scope 带完整 s:<sessionId> 前缀 → host logger 落盘时提取 business sessionId,
    // 路由到 sessions/<id>/<date>.ndjson (logger.ts extractSessionId / sessionAgentSlot)。
    const sid = opts.sessionId ?? '';
    const log = this.deps.logger.child(sid ? `s:${sid}/codex` : 'codex');
    const reviewMode = opts.reviewMode === true;
    // 设备托管：Codex 在本机运行(本机的登录与供应商)，项目、文件与命令在任务所在电脑上。
    // 那台电脑经隧道提供 Codex 原生的 exec-server 环境，命令、读写与补丁都在那里执行；
    // Cindy 工具也经隧道。opts.workingDir 是本机影子目录。
    const hosted = opts.deviceHosted && !opts.remoteHostId && !reviewMode ? opts.deviceHosted : undefined;
    const hostedEnvironmentId = hosted ? `cindy-device-${randomUUID()}` : undefined;
    // 受邀者(另一个账号)：本机用户的插件、技能、MCP、hooks、connectors、记忆与全局说明不进入会话。
    const hostedGuest = hosted?.guest === true;
    // 受邀者只能用分享给它的那一个供应商(启动来源就是它)：app-server 不升格、不开智能子代理调配，
    // 自定义供应商路由与按模型分流也只留它(见 prepareCodexExtraSpawnConfig 的 deviceHostedGuestProviderId)。
    const guestProviderId = hostedGuest ? hosted?.guestProvider?.providerId : undefined;
    // Input handoff askpass for this owner's own local tasks. The app-server is
    // shared, so the variables reach this thread's commands through its config.
    const taskShellEnvConfig = Object.fromEntries(Object.entries(
      !opts.remoteHostId && !hosted && !reviewMode && sid
        ? this.deps.runtimeConfig.taskShellEnv?.({ sessionId: sid }) ?? {}
        : {},
    ).map(([name, value]) => [`shell_environment_policy.set.${name}`, value]));
    if (hostedGuest && (!guestProviderId || guestProviderId !== opts.providerId)) {
      throw new Error('[REMOTE_AGENT_PROVIDER_NOT_ALLOWED] this provider is not allowed for remote use on this computer');
    }
    // 受邀者必须有自己的 CODEX_HOME：只有独占的 app-server 才能按受邀者收窄供应商与子代理路由，
    // 与本机用户任务共用的 app-server 带着本机用户的登录与调配设置。
    if (hostedGuest && !hosted?.guestHome) {
      throw new Error('[REMOTE_AGENT_UNSUPPORTED] Cannot start Codex for a shared user without its own Codex home on this computer.');
    }
    /** 受邀者能用的技能：Codex 自带的，以及受邀者带来的(会话目录内)。 */
    const guestSkillAllowed = hosted && hostedGuest
      ? (() => {
        const guestRoot = deviceHostedGuestSessionRoot(hosted, opts.workingDir);
        return (skillPath: string, scope?: SkillMetadata['scope']): boolean =>
          scope === 'system' || isInsideDeviceHostedRoot(skillPath, guestRoot);
      })()
      : undefined;
    const botSkillGrants = !opts.remoteHostId && !reviewMode
      ? snapshotManagedSkillGrants(opts.botRuntimeProfile?.skillPolicy) : undefined;
    let refreshedBotSkillConfig: Record<string, unknown> | undefined;
    if (reviewMode && opts.remoteHostId) {
      throw new Error('Cindy Review currently supports local Codex sessions only');
    }

    log.info('startSession', {
      model: opts.model,
      providerId: opts.providerId ?? null,
      effort: opts.effort ?? 'default',
      fastMode: opts.fastMode ?? 'default',
      workDir: opts.workingDir,
      resume: opts.resumeSessionId ?? 'new',
      remoteHostId: opts.remoteHostId ?? null,
      reviewMode,
      mcpProvidersCount: this.deps.mcpProviders?.length ?? 0,
    });

    // ── Maker Memory: 启动时预拉 MEMORY.md 索引 + 写入规范段 ────────────────
    // thread/start 仍把 developerInstructions 写入新 thread; thread/resume 在普通非 proxy
    // 路径只在 host 明确告知历史未含产品 prompt 时补发一次,避免常规 resume 重复堆积。
    // WS 与 teammate thread 恢复时始终携带当前值:Codex 的 SessionMeta 不持久化该字段,冷恢复若只
    // 依赖历史里的旧 developer message,后续 compact 重建 canonical context 时会丢产品
    // prompt。Codex 0.145 对仍在内存中的 loaded thread 会忽略 resume override,且冷恢复
    // 首轮的 steady-state diff 不补一条发生变化的 plain developer_instructions；正常
    // resume 沿用同一份文本时历史里已有它,compact 也会从当前 cold-resume 配置重建。
    // proxy active 时两条路径都用同一份构建结果登记到 registry。跟 userPrompt 同语义 — 启动时快照,跨 session 不实时同步。
    let makerMemoryRules = '';
    let makerMemoryIndex = '';
    let memoryFlushController: MemoryFlushController | null = null;
    // opts.makerMemoryEnabled 优先 (per-session, renderer 透传); fallback 到 runtimeConfig。
    const makerMemoryFlag = reviewMode
      ? false
      : opts.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled ?? false;
    const makerMemory = this.deps.makerMemory;
    const makerMemoryEnabled = makerMemoryFlag === true && !!makerMemory;
    // SSH remote 的 workingDir 是远端路径 — store 定位统一经 scope key;
    // 本地会话额外做 git worktree 归一化 (#2379)。已注入的 makerMemoryScopeKey
    // (含 bot:) 原样透传。Maker Memory 关闭时跳过 git 探测 (Codex #2399 P1):
    // 解析结果本就不会被用, 失败还能空耗 3s timeout。
    const memoryScopeKey = makerMemoryEnabled
      ? (opts.makerMemoryScopeKey ?? (await resolveMemoryScopeKey(opts.workingDir, opts.remoteHostId)))
      : (opts.makerMemoryScopeKey ?? opts.workingDir);
    // This per-session injection flag must not mutate the shared manager.
    if (makerMemoryEnabled && makerMemory) {
      try {
        // 设备托管：记忆在任务所在电脑上，只用随启动选项带来的快照，不打开本机记忆库。
        const store = hosted ? null : await makerMemory.getStore(memoryScopeKey);
        makerMemoryRules = opts.makerMemoryScopeKey?.startsWith('bot:')
          ? ''
          : MAKER_MEMORY_RULES;
        makerMemoryIndex = opts.makerMemoryIndexSnapshot ?? (store ? await store.getIndex() : '');
        memoryFlushController = new MemoryFlushController({
          logger: log.child('memory-flush'),
          workdir: memoryScopeKey,
          agentKind: 'codex',
        });
        log.debug('maker memory loaded for session', {
          rulesBytes: makerMemoryRules.length,
          indexBytes: makerMemoryIndex.length,
        });
      } catch (e) {
        log.warn('maker memory load failed at session start (skipping injection)', {
          error: String(e),
        });
      }
    }

    const eventQueue: AsyncQueue<AgentEvent> = createAsyncQueue<AgentEvent>();
    const usageTracker = new UsageTracker();
    const translatorRt: CodexRuntimeState = newCodexRuntimeState();
    const liveUsageSnapshot = () => {
      const speed = translatorRt.generationTimingReliable ? translatorRt.tokenSpeed.snapshot() : undefined;
      return attachLiveGeneration({ ...usageTracker.snapshot(), requestUsage: usageTracker.getRequestMetering() }, {
        tokenSpeed: speed,
        // Legacy clients use these fields: they must share the speed snapshot's
        // measured numerator/denominator, never the billing ledger's lifetime.
        outputTokens: speed?.tokens ?? translatorRt.generationOutputTokens,
        durationMs: speed?.elapsedMs ?? 0,
        openStartedAt: translatorRt.generationStartedAt,
        reliable: speed !== undefined,
      });
    };
    /**
     * 本 turn 用于**目录查找**的模型 id, 在构造 turnParams 时快照(取 mutableCatalogModel,
     * 不是送上游的 wire 值 —— 见该变量注释)。
     *
     * 不能在 usage 事件里读 mutableModel: setModel 虽然文档写「下一 turn 才生效」,
     * 赋值却是**即时**的, 于是活跃 turn 期间切模型会让这一 turn 还在产出的用量
     * 按**下一个**模型的目录窗口收敛。turn 结束后不清空 —— 迟到的 usage 事件
     * 归属的仍是它那一 turn 的模型。
     */
    let activeTurnModel: string | undefined = opts.model;
    let activeTurnContextLimit = this.deps.resolveModelContextLimit?.(opts.providerId, opts.model) ?? null;
    let activeTurnCompactionPct = this.deps.resolveModelCompactionPct?.(opts.providerId, opts.model) ?? 90;
    /**
     * 任务级工作上下文预算（tokens）：host 已按目录上限与模型级上限收敛。
     * 优先于模型级上限/目录默认；host 在预算变化时直接触发重建，不走热切。
     */
    let mutableContextWindowBudget: number | null =
      typeof opts.contextWindowBudget === 'number' && Number.isSafeInteger(opts.contextWindowBudget)
      && opts.contextWindowBudget > 0
        ? opts.contextWindowBudget
        : null;
    /**
     * 本 turn 实际路由的 provider,与 activeTurnModel 同时快照。
     *
     * 不能用 opts.providerId: 它是**会话创建时**冻结的值,而 idle 会话可以热切 provider ——
     * host 的 applyRuntimeSetModelChange 会带着 `{ providerId }` 调 setModel。窗口上限按
     * (provider, model) 解析, 只更新 model 会让下一 turn 拿新模型去问**旧路由**。
     */
    let activeTurnProviderId: string | null | undefined = opts.providerId;
    let lastNativeContextWindow: number | null = null;
    let lastNativeContextWindowTurnId: string | null = null;
    let hasActivatedRootTurn = false;
    /**
     * Native usage reports the effective usable window, including model limits and
     * reserved headroom. Catalog windows and requested limits cannot replace it,
     * even after a model switch. Only use turn-scoped configuration/catalog data
     * as a fallback until native has reported a valid window. Missing fields in
     * later events must not erase an already observed native capacity.
     */
    const resolveUsageContextWindow = (reported: number | null): number | null => {
      if (reported !== null && Number.isFinite(reported) && reported > 0) {
        lastNativeContextWindow = reported;
        return reported;
      }
      if (lastNativeContextWindow !== null) return lastNativeContextWindow;
      const configured = activeTurnContextLimit;
      if (configured && Number.isFinite(configured) && configured > 0) return configured;
      const verified = activeTurnModel
        ? (this.deps.resolveVerifiedContextWindow?.(activeTurnProviderId, activeTurnModel) ?? null)
        : null;
      return verified !== null && Number.isFinite(verified) && verified > 0 ? verified : null;
    };

    let sdkSessionId: string | undefined;
    let currentTurnId: string | null = null;
    // app-server emits one cumulative diff per thread. Descendant threads use
    // different turn ids, but their changes belong to the active root turn;
    // retain each thread's latest snapshot and publish one merged diff.
    const turnDiffSnapshots = new Map<string, string>();
    const splitTurnDiffBlocks = (diff: string): string[] => diff
      .split(/(?=^diff --git )/m)
      .filter((block) => block.startsWith('diff --git '));
    const splitTurnDiffBlockHunks = (block: string): { header: string; hunks: string[] } => {
      const normalized = block.endsWith('\n') ? block.slice(0, -1) : block;
      const firstHunk = normalized.search(/^@@ /m);
      if (firstHunk < 0) return { header: normalized, hunks: [] };
      return {
        header: normalized.slice(0, firstHunk).replace(/\n+$/, ''),
        hunks: normalized.slice(firstHunk).split(/(?=^@@ )/m).filter(Boolean),
      };
    };
    const mergeTurnDiffSnapshots = (): { diff: string; complete: boolean } => {
      const blocks = new Map<string, string[]>();
      for (const snapshot of turnDiffSnapshots.values()) {
        for (const block of splitTurnDiffBlocks(snapshot)) {
          const parsed = splitTurnDiffBlockHunks(block);
          const key = parsed.header.split('\n', 1)[0] ?? parsed.header;
          const existing = blocks.get(key) ?? [];
          existing.push(block);
          blocks.set(key, existing);
        }
      }
      let complete = true;
      let diff = '';
      for (const fileBlocks of blocks.values()) {
        if (fileBlocks.length === 1) {
          diff += fileBlocks[0]!.endsWith('\n') ? fileBlocks[0] : `${fileBlocks[0]}\n`;
          continue;
        }
        const composed = composeTurnDiffBlocks(fileBlocks, splitTurnDiffBlockHunks);
        complete &&= composed.complete;
        diff += composed.block;
      }
      return { diff, complete };
    };
    const publishTurnDiff = (threadKey: string, turnId: string, diff: string): void => {
      if (diff) turnDiffSnapshots.set(threadKey, diff);
      else turnDiffSnapshots.delete(threadKey);
      const merged = mergeTurnDiffSnapshots();
      eventQueue.push({
        type: 'turn_diff',
        data: {
          turnId,
          diff: merged.diff,
          cwd: opts.workingDir,
          isComplete: merged.complete,
        },
        source: 'codex',
      });
    };
    let isTurnInFlight = false;
    const yieldedExecCellsByTurnId = new Map<string, Map<string, YieldedExecCell[]>>();
    const yieldContinuationClaims = new Map<number, YieldContinuationClaim>();
    const interactionContinuationClaims = new Map<number, InteractionContinuationClaim>();
    let interactionContinuation: InteractionContinuationClaim | null = null;
    const interactionIdleWaiters = new Set<() => void>();
    const yieldContinuationListeners = new Set<(
      continuationId: number,
      state: 'awaiting' | 'active' | 'cancelled',
    ) => void>();
    let nextYieldContinuationId = 1;
    let activeYieldContinuationId: number | null = null;
    let yieldContinuationInFlight = false;
    let yieldContinuationAbort: AbortController | null = null;
    let yieldContinuationIdleWaiters: Array<(cancelled: boolean) => void> = [];
    let yieldContinuationProductFailed = false;
    const emitYieldContinuationState = (
      continuationId: number,
      state: 'awaiting' | 'active' | 'cancelled',
    ): void => {
      for (const listener of [...yieldContinuationListeners]) {
        try {
          listener(continuationId, state);
        } catch (e) {
          log.warn('yield continuation listener threw', { error: String(e) });
        }
      }
    };
    const activeYieldContinuationClaim = (): YieldContinuationClaim | null =>
      activeYieldContinuationId === null
        ? null
        : yieldContinuationClaims.get(activeYieldContinuationId) ?? null;
    const releaseSettledYieldContinuationClaim = (claim: YieldContinuationClaim): void => {
      if (!claim.settled || claim.pendingBoundaryEvents > 0) return;
      yieldContinuationClaims.delete(claim.id);
    };
    // Human replies use the existing product-boundary contract, but never the
    // yield claim itself: an answer may have to wait for a yielded cell first.
    const retainInteractionContinuation = (turnId: string, requestId: string): InteractionContinuationClaim => {
      const claim = interactionContinuation ?? {
        id: nextYieldContinuationId++, state: 'awaiting' as const, settled: false,
        pendingBoundaryEvents: 0, turnIds: new Set<string>(), requestIds: new Set<string>(),
        pendingSends: 0, sendTail: Promise.resolve(), abort: new AbortController(),
      };
      interactionContinuation = claim;
      interactionContinuationClaims.set(claim.id, claim);
      claim.turnIds.add(turnId);
      claim.requestIds.add(requestId);
      claim.state = 'awaiting';
      return claim;
    };
    const releaseInteractionClaim = (claim: InteractionContinuationClaim): void => {
      if (claim.settled && claim.pendingBoundaryEvents === 0) interactionContinuationClaims.delete(claim.id);
    };
    const retireInteractionClaim = (claim: InteractionContinuationClaim, cancelled: boolean, notifyCancellation = cancelled): void => {
      claim.settled = true;
      if (interactionContinuation === claim) interactionContinuation = null;
      if (cancelled) {
        // Failure must be delivered as an error, not as a cancellation callback:
        // scheduled consumers treat that callback as successful teardown.
        claim.state = notifyCancellation ? 'cancelled' : 'active';
        claim.abort.abort();
        if (notifyCancellation) emitYieldContinuationState(claim.id, 'cancelled');
      }
      releaseInteractionClaim(claim);
    };
    const cancelInteractionContinuation = (reason: string, notifyCancellation = false): InteractionContinuationClaim | null => {
      const claim = interactionContinuation;
      if (!claim) return null;
      retireInteractionClaim(claim, true, notifyCancellation);
      for (const requestId of claim.requestIds) {
        eventQueue.push({ type: 'interaction_dismissed',
          data: { requestId, reason, resolvedAs: 'deny' }, source: 'codex' });
      }
      claim.requestIds.clear();
      return claim;
    };
    const interactionCanFinish = (claim: InteractionContinuationClaim): boolean =>
      !claim.settled && claim.requestIds.size === 0 && claim.pendingSends === 0 &&
      !isTurnInFlight && !isTurnStartPending && !activeYieldContinuationClaim() && !yieldContinuationInFlight;
    const finishIdleInteraction = (claim: InteractionContinuationClaim, cancelled = false): void => {
      if (!interactionCanFinish(claim)) return;
      retireInteractionClaim(claim, cancelled);
      // SDK usage was already delivered on its claimed boundary. Never replay it.
      eventQueue.push({ type: 'done', data: { type: 'codex/event/task_complete', cancelled }, source: 'codex' });
      eventQueue.push({ type: 'status', data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false }, source: 'codex' });
    };
    const finishInteractionWithoutFollowUp = (requestId: string): void => {
      const claim = interactionContinuation;
      if (!claim?.requestIds.delete(requestId)) return;
      finishIdleInteraction(claim, true);
    };
    const flushInteractionIdleWaiters = (): void => {
      for (const resolve of [...interactionIdleWaiters]) resolve();
    };
    async function sendInteractionContinuation(
      requestId: string, message: UserMessage, options: CodexInternalSendOptions,
      failureContext: string,
      steerTurnId?: string | null,
    ): Promise<void> {
      const claim = interactionContinuation;
      if (!claim || !claim.requestIds.delete(requestId) || claim.settled) return;
      claim.pendingSends += 1;
      claim.sendTail = claim.sendTail.then(async () => {
        if (claim.settled || closed) return;
        if (steerTurnId && isTurnInFlight && currentTurnId === steerTurnId) {
          try {
            await handle.steer!(message, { ...options, signal: claim.abort.signal });
            return;
          } catch (error) {
            if (claim.settled || closed) return;
            // Only a definite pre-accept rejection can become a fresh turn.
            // A timeout/transport failure may already have delivered the answer.
            const message = error instanceof Error ? error.message : String(error);
            if (!/\bno active (?:Codex )?turn to steer\b/i.test(message)) {
              eventQueue.push({ type: 'error', data: {
                message: `Async question answer delivery failed: ${message}`, isTerminal: false,
              }, source: 'codex' });
              return;
            }
          }
        }
        if (await waitForYieldContinuationIdle()) return;
        while (!claim.settled && (isTurnInFlight || isTurnStartPending)) {
          await new Promise<void>((resolve) => {
            const wake = () => {
              interactionIdleWaiters.delete(wake);
              claim.abort.signal.removeEventListener('abort', wake);
              resolve();
            };
            interactionIdleWaiters.add(wake);
            claim.abort.signal.addEventListener('abort', wake, { once: true });
          });
        }
        if (claim.settled || closed) return;
        claim.state = 'active';
        emitYieldContinuationState(claim.id, 'active');
        await handle.send(message, { ...options, signal: claim.abort.signal,
          throwOnStartFailure: true, [CODEX_INTERACTION_CONTINUATION]: true } as CodexInternalSendOptions);
      }).catch((error: unknown) => {
        if (claim.settled || closed) return;
        cancelInteractionContinuation('interaction_continuation_failed');
        eventQueue.push({ type: 'error', data: {
          message: `${failureContext}: ${String(error)}`, isTerminal: true,
        }, source: 'codex' });
        eventQueue.push({ type: 'status', data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false }, source: 'codex' });
        eventQueue.push({ type: 'done', data: { type: 'codex/event/task_complete' }, source: 'codex' });
      }).finally(() => {
        claim.pendingSends -= 1;
        finishIdleInteraction(claim);
      });
      await claim.sendTail;
    }
    const yieldItemLedgerKey = (record: Record<string, unknown> | null): string => {
      if (!record) return '';
      for (const key of ['id', 'call_id', 'callId'] as const) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) return value;
      }
      return '';
    };
    const abortYieldContinuationSend = (): void => {
      const pending = yieldContinuationAbort;
      yieldContinuationAbort = null;
      try {
        pending?.abort();
      } catch (error) {
        log.debug('yield continuation abort controller threw', { error: String(error) });
      }
    };
    const forgetSettledYieldCells = (turnId: string, item: unknown): void => {
      const settledIds = extractSettledYieldCellIdsFromCodexItem(item);
      if (settledIds.length === 0) return;
      const existing = yieldedExecCellsByTurnId.get(turnId);
      if (existing) {
        for (const [itemId, cells] of [...existing.entries()]) {
          const remaining = cells.filter((cell) => !settledIds.includes(cell.cellId));
          if (remaining.length === 0) existing.delete(itemId);
          else existing.set(itemId, remaining);
        }
        if (existing.size === 0) yieldedExecCellsByTurnId.delete(turnId);
      }
      const claim = activeYieldContinuationClaim();
      if (!claim) return;
      for (const cellId of settledIds) claim.settledCellIds.add(cellId);
    };
    const rememberYieldedExecCells = (
      turnId: string | undefined,
      item: unknown,
      phase: 'updated' | 'completed',
    ): void => {
      if (!turnId) return;
      if (completedTurnIds.has(turnId) || terminalErroredTurnIds.has(turnId)) return;
      const record = item && typeof item === 'object' && !Array.isArray(item)
        ? item as Record<string, unknown>
        : null;
      const itemId = yieldItemLedgerKey(record);
      const cells = dedupeCells([
        ...extractYieldedExecCellsFromCodexItem(item),
        ...extractAliveYieldCellsFromCodexItem(item),
      ]);
      const existing = yieldedExecCellsByTurnId.get(turnId) ?? new Map<string, YieldedExecCell[]>();
      if (cells.length === 0) {
        if (phase === 'completed' && itemId) {
          // Named completions drop that item. Nameless completions share the
          // anonymous bucket; an unmarked sibling (short exec Exit 0) must not
          // wipe still-running cells. Settled waits drop one cell_id via
          // forgetSettledYieldCells below — never delete('').
          existing.delete(itemId);
        }
      } else if (itemId) {
        existing.set(itemId, cells);
      } else if (phase === 'completed') {
        // Nameless exec and wait share the same anonymous bucket. A later wait
        // that is still running must accumulate, not replace the yielded exec.
        // Only completed snapshots are authoritative; nameless itemUpdated
        // cannot later be forgotten without an id.
        const anonymous = existing.get('') ?? [];
        existing.set('', dedupeCells([...anonymous, ...cells]));
      }
      if (existing.size === 0) yieldedExecCellsByTurnId.delete(turnId);
      else yieldedExecCellsByTurnId.set(turnId, existing);
      forgetSettledYieldCells(turnId, item);
    };
    const cellsForCompletedTurn = (turnId: string): YieldedExecCell[] => {
      const byItem = yieldedExecCellsByTurnId.get(turnId);
      if (!byItem) return [];
      return dedupeCells([...byItem.values()].flat());
    };
    const attachYieldContinuationClaim = (
      event: AgentEvent,
      claim: YieldContinuationClaim,
    ): void => {
      event.turnContinuationId = claim.id;
      claim.pendingBoundaryEvents += 1;
    };
    const mintYieldContinuationClaim = (
      cells: YieldedExecCell[],
      originTurnId: string,
      retryCount: number,
    ): YieldContinuationClaim => {
      const claim: YieldContinuationClaim = {
        id: nextYieldContinuationId++,
        state: 'awaiting',
        cells,
        settledCellIds: new Set(),
        pendingBoundaryEvents: 0,
        settled: false,
        retryCount,
        originTurnId,
        continuationTurnId: null,
        permissionPolicy: activeTurnPermissionPolicy,
        capabilitySelectionText: '',
        autoReviewIntent: '',
        deferredPlanText: null,
        deferredPlanTurnId: null,
        deferredPlanCapabilitySelectionText: '',
      };
      yieldContinuationClaims.set(claim.id, claim);
      activeYieldContinuationId = claim.id;
      yieldContinuationProductFailed = false;
      log.info('yield continuation claim created', {
        continuationId: claim.id,
        originTurnId,
        cellIds: cells.map((cell) => cell.cellId),
        retryCount,
      });
      return claim;
    };
    const claimOwnsTurn = (claim: YieldContinuationClaim, turnId: string | null | undefined): boolean => {
      if (!turnId) return false;
      return claim.originTurnId === turnId || claim.continuationTurnId === turnId;
    };
    const bindYieldContinuationTurn = (turnId: string): void => {
      const claim = activeYieldContinuationClaim();
      if (!claim || claim.settled || claim.continuationTurnId) return;
      claim.continuationTurnId = turnId;
    };
    const flushYieldContinuationIdleWaiters = (cancelled = false): void => {
      if (!cancelled && (activeYieldContinuationClaim() != null || yieldContinuationInFlight)) return;
      const waiters = yieldContinuationIdleWaiters;
      yieldContinuationIdleWaiters = [];
      for (const resolve of waiters) resolve(cancelled);
    };
    const waitForYieldContinuationIdle = async (): Promise<boolean> => {
      if (yieldContinuationProductFailed) return true;
      if (activeYieldContinuationClaim() == null && !yieldContinuationInFlight) return false;
      return await new Promise<boolean>((resolve) => {
        yieldContinuationIdleWaiters.push(resolve);
      });
    };
    const emitCancelledYieldProductDone = (): void => {
      eventQueue.push({
        type: 'done',
        data: {
          type: 'codex/event/task_complete',
          cancelled: true,
        },
        source: 'codex',
      });
      eventQueue.push({
        type: 'status',
        data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
        source: 'codex',
      });
    };
    const cancelActiveYieldContinuation = (reason: string): YieldContinuationClaim | null => {
      const claim = activeYieldContinuationClaim();
      abortYieldContinuationSend();
      if (!claim || claim.settled) return null;
      claim.state = 'cancelled';
      claim.settled = true;
      activeYieldContinuationId = null;
      yieldContinuationInFlight = false;
      log.info('yield continuation cancelled', { reason, continuationId: claim.id });
      emitYieldContinuationState(claim.id, 'cancelled');
      releaseSettledYieldContinuationClaim(claim);
      flushYieldContinuationIdleWaiters(true);
      // Cancel is a product terminal. Do not leak a deferred plan cycle into the
      // next user send after Stop / owned-turn failure / replacement send.
      planCycleActive = false;
      proposedPlanText = null;
      return claim;
    };
    const discardYieldContinuationClaims = (reason: string): void => {
      abortYieldContinuationSend();
      if (yieldContinuationClaims.size > 0) {
        log.debug('discarding yield continuation claims', {
          reason,
          continuationIds: [...yieldContinuationClaims.keys()],
        });
      }
      activeYieldContinuationId = null;
      yieldContinuationInFlight = false;
      yieldedExecCellsByTurnId.clear();
      for (const claim of yieldContinuationClaims.values()) {
        claim.settled = true;
        releaseSettledYieldContinuationClaim(claim);
      }
      yieldContinuationClaims.clear();
      flushYieldContinuationIdleWaiters(true);
    };
    const releaseYieldContinuationEvent = (event: AgentEvent): void => {
      if (event.turnContinuationId === undefined) return;
      const interactionClaim = interactionContinuationClaims.get(event.turnContinuationId);
      if (interactionClaim) {
        interactionClaim.pendingBoundaryEvents = Math.max(0, interactionClaim.pendingBoundaryEvents - 1);
        releaseInteractionClaim(interactionClaim);
        return;
      }
      const claim = yieldContinuationClaims.get(event.turnContinuationId);
      if (!claim) return;
      claim.pendingBoundaryEvents = Math.max(0, claim.pendingBoundaryEvents - 1);
      releaseSettledYieldContinuationClaim(claim);
    };
    const emitYieldContinuationFailure = (opts: {
      reason: 'yield-continuation-start-failed' | 'yield-continuation-incomplete';
      message: string;
      cells: YieldedExecCell[];
      detail?: string;
    }): void => {
      cancelInteractionContinuation(opts.reason);
      log.warn(
        opts.reason === 'yield-continuation-start-failed'
          ? 'yield continuation turn failed to start'
          : 'yield continuation did not retrieve execution results',
        {
          reason: opts.reason,
          ...(opts.detail ? { detail: opts.detail } : {}),
          cellIds: opts.cells.map((cell) => cell.cellId),
        },
      );
      eventQueue.push({
        type: 'error',
        data: {
          message: opts.message,
          isTerminal: true,
          reason: opts.reason,
        },
        source: 'codex',
      });
      eventQueue.push({
        type: 'status',
        data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
        source: 'codex',
      });
      // Failure is a product terminal. Latch so later ask_user / plan answers
      // cannot treat idle as permission to start another turn, and dismiss
      // unfinished cards from the failed product turn.
      yieldContinuationProductFailed = true;
      flushYieldContinuationIdleWaiters(true);
      planCycleActive = false;
      proposedPlanText = null;
      dismissAllPending(opts.reason, 'deny');
      dismissAllPendingUserInput(opts.reason);
    };
    const emitYieldContinuationStartFailure = (error: unknown, cells: YieldedExecCell[]): void => {
      emitYieldContinuationFailure({
        reason: 'yield-continuation-start-failed',
        message: `yield continuation turn failed to start: ${String(error)}`,
        cells,
        detail: String(error),
      });
    };
    // Missing progress or exhausted retries do not prove a handle was lost.
    // Even not-found can mean a completed cell was already consumed.
    const emitYieldContinuationIncomplete = (cells: YieldedExecCell[], reason: string): void => {
      emitYieldContinuationFailure({
        reason: 'yield-continuation-incomplete',
        message: 'Unable to retrieve the execution result. Automatic continuation has stopped. Ask the assistant to check the existing execution result.',
        cells,
        detail: reason,
      });
    };
    async function startYieldContinuation(claim: YieldContinuationClaim): Promise<void> {
      if (closed || yieldContinuationInFlight || claim.state !== 'awaiting' || claim.settled) return;
      yieldContinuationInFlight = true;
      claim.state = 'active';
      emitYieldContinuationState(claim.id, 'active');
      const abort = new AbortController();
      yieldContinuationAbort = abort;
      const sendOptions: CodexInternalSendOptions = {
        [CODEX_YIELD_CONTINUATION]: claim.retryCount + 1,
        [CODEX_INTERNAL_CONTINUATION]: true,
        throwOnStartFailure: true,
        signal: abort.signal,
        ...(claim.permissionPolicy
          ? { turnPermissionPolicy: claim.permissionPolicy }
          : {}),
        ...(claim.capabilitySelectionText
          ? { [CODEX_INHERITED_CAPABILITY_SELECTION]: claim.capabilitySelectionText }
          : {}),
        ...(claim.autoReviewIntent
          ? { [CODEX_AUTO_REVIEW_INTENT]: claim.autoReviewIntent }
          : {}),
      };
      try {
        await handle.send(
          { type: 'user', content: formatYieldContinuationPrompt(claim.cells) },
          sendOptions,
        );
      } catch (error) {
        const alreadySettled = claim.settled || abort.signal.aborted;
        if (activeYieldContinuationId === claim.id) activeYieldContinuationId = null;
        yieldContinuationInFlight = false;
        if (alreadySettled) {
          releaseSettledYieldContinuationClaim(claim);
          return;
        }
        claim.settled = true;
        emitYieldContinuationStartFailure(error, claim.cells);
        releaseSettledYieldContinuationClaim(claim);
      } finally {
        if (yieldContinuationAbort === abort) yieldContinuationAbort = null;
        if (claim.settled || activeYieldContinuationId !== claim.id) {
          yieldContinuationInFlight = false;
        }
      }
    }
    /**
     * 本 handle 上「起过多少个 turn」的单调计数器,每个新 turn 首次被置活时 +1。
     *
     * 存在的唯一理由:延迟很久的善后动作(upstream-idle 看门狗那条要等两次 interrupt
     * ack、最长 20s)不能只看**当下**有没有 turn 在跑 —— 新 turn 完全可能在这段窗口里
     * 起来又正常结束,把 isTurnInFlight / currentTurnId 双双复位,善后于是误判成"没人
     * 用了"并关掉这个已被证明健康的 host(review #944 第十八轮 P1)。存量瞬时状态答不了
     * "期间有没有发生过新活儿",单调计数器可以。
     *
     * 与 sendGeneration 的区别:那个按 send() 计数,起不来 turn 的 send(RPC 失败、
     * 被拒)也会 +1,而计划实施 turn 这类不经 send 的路径反而不 +1。这里要的恰恰是
     * "turn 被置活"这件事。
     */
    let turnStartGeneration = 0;
    let isTurnStartPending = false;
    // turn/start RPC 失败(超时/拒绝)后置位: server 可能实际已建 turn,
    // 迟到的孤儿 turnStarted 由 turnStarted handler 拦下并补 interrupt。
    let turnStartFailedWithoutTurnId = false;
    // 孤儿守卫生效期间又有新 turn/start 在飞时, 到达的 turnStarted 归属不明
    // (协议不带 request id: 可能是失败 RPC 的孤儿, 也可能是在飞 RPC 合法的
    // started-before-resp) — 先缓冲隔离, 等响应到了按 turnId 对账: 一致激活,
    // 不一致 interrupt + 墓碑 (codex R9 P2)。缓冲期间不置 currentTurnId,
    // 孤儿 turn 的 item 事件不会被渲染到本次 send 下。
    const bufferedOrphanTurnIds = new Set<string>();
    type TurnCompletedParams = Parameters<NonNullable<ThreadEventHandlers['turnCompleted']>>[0];
    // 缓冲隔离期间到达的**所有** turn 事件按 turnId 排队 (greptile R11 P1 +
    // codex R12 P1): 对账证明合法时激活后按到达序重放 (早期 item/usage 不丢,
    // 终态自然收口 …99437 tokens truncated…
          riskLevel: params.review.riskLevel,
          rationale: params.review.rationale,
        });
      }
    };

    // ── subscribeThread: notification 路由 + approval handlers ─────────────
    const handlers: ThreadEventHandlers = {
      // 强制退役(账号切换/auth 失效)时由 host 发结构化信号，按本会话自身真实状态收口。
      // 空闲/已完成 → 静默失效；真实在飞(turn in-flight / turn/start pending /
      // overload retry) → 清理在途状态并推终态 error + Done。
      // 不能在 host 层用空 turnId 的 transport error 广播：error handler 的
      // targetsPendingTurn 要求非空 turnId、wasTurnRunning 不含 overload retry，
      // pending/retry 会话会收不了口（busy 永久卡死）。所以由这里统一收口。
      hostForcedRetire: ({ reason }) => {
        sessionHostForceRetired = true;
        subscriptionInvalidatedByTransport = false;
        resetCodexGenerationTiming(translatorRt);

        const hadPendingWork =
          isTurnInFlight
          || isTurnStartPending
          || overloadRetryPending()
          || yieldContinuationInFlight
          || activeYieldContinuationClaim() != null;
        log.info('Codex session forced retirement received', {
          threadId,
          turnId: currentTurnId,
          reason,
          hadPendingWork,
          pendingToolCount: pendingToolItemIds.size,
        });
        if (!hadPendingWork) {
          log.info('idle Codex session invalidated by forced host retirement', { threadId });
          eventQueue.end();
          return;
        }
        discardYieldContinuationClaims('app-server force-retired');

        // turn/start 可能尚未返回 id。先把所有在途请求标为已收口并隔离，随后 RPC
        // reject/迟到 resolve 时复用既有 finally/墓碑路径，不再发第二组终态。
        markInFlightStartsTerminallySettled();
        quarantineAllInFlightStarts();
        discardOverloadRetry('app-server force-retired');
        // 强制退役后 host 不再投递后代 turn/completed 通知, 与 close /
        // transport-error 同款: 先把仍在跑的子代理卡收成终态, 否则渲染端在
        // parent 已推 Done 之后仍会看到子代理卡永久转圈。
        for (const update of subagentLiveCards.drainRunningForShutdown()) emitSubagentCardUpdate(update);
        subagentLiveCards.clear();
        dismissAllPending('app_server_force_retired', 'deny');
        dismissAllPendingUserInput('transport_error');
        activeToolContexts.clear();
        approvalDenials.clear();
        completedActiveToolTurns.clear();
        capabilitySelectionTextByTurnId.clear();
        capabilitySelectionTextByThreadId.clear();
        descendantParentThreadByThreadId.clear();
        rootTurnIdByDescendantThreadId.clear();
        terminalDescendantTurnIds.clear();
        stopActiveRolloutPlanFallback();
        resetUpstreamIdleForTurnEnd();
        if (currentTurnId) terminalErroredTurnIds.add(currentTurnId);
        currentTurnId = null;
        isTurnInFlight = false;
        isTurnStartPending = false;
        currentTurnPlanModeActive = false;
        pendingTurnStartPlanMode = null;

        eventQueue.push({
          type: 'error',
          data: {
            message: `app-server force-retired: ${reason}`,
            isTerminal: true,
            willRetry: false,
            reason: 'app-server-force-retired',
          },
          source: 'codex',
        });
        eventQueue.push({
          type: 'status',
          data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
          source: 'codex',
        });
        // 该 host 已被永久替换，handle 不可能原地恢复。结束内部事件流，让已启动的
        // Session 走既有 auto-close → Maker lazy create；尚未启动 event loop 的
        // Session 会在下一次 send 明确失败后 drain 到这里并重建。
        eventQueue.end();
      },
      threadStarted: (params) => {
        const sid = params.thread?.id;
        if (sid && sid !== sdkSessionId) sdkSessionId = sid;
        if (sdkSessionId) {
          eventQueue.push({ type: 'session_id', data: sdkSessionId, source: 'codex' });
        }
      },
      descendantThreadStarted: (params) => {
        // 0.145 不会为 spawn 出的子线程发 thread/started(血缘主路径已改走 spawn item,
        // 见 registerDescendantThreadRouting);保留本 handler 兼容会发的新版 codex,
        // 它还带 thread.model —— 实际模型观测值优先于 spawn 参数与配置兜底。
        const childThreadId = params.thread.id;
        const parentThreadId = params.thread.parentThreadId;
        if (!parentThreadId || childThreadId === parentThreadId) return;
        const observedIdentity = host.getObservedSubagentIdentity?.(childThreadId);
        const childModel = observedIdentity?.model ?? (
          typeof params.thread.model === 'string' && params.thread.model.length > 0
            ? params.thread.model
            : undefined
        );
        registerDescendantThreadRouting(childThreadId, parentThreadId);
        const replayed = subagentLiveCards.noteDescendantThread(childThreadId, parentThreadId, childModel);
        if (replayed) {
          emitSubagentCardUpdate(replayed, descendantUpdateLifecycle(childThreadId));
        }
      },
      descendantNotification: handleDescendantNotification,
      turnStarted: (params) => {
        // turn/start RPC 已失败(超时/拒绝)但 daemon 实际已建 turn — 迟到的孤儿
        // turnStarted 不得重新激活已报终态错误的会话 (greptile P1): 立墓碑 +
        // 补 interrupt 让 daemon 停掉这个没人消费的 turn。分支先于 stale 闸
        // (codex R15 P1): 闸对 idle 孤儿只立墓碑, turnStarted 必须走这里补
        // interrupt; 被闸先拦就发不出了。已墓碑/已完成的 id 不重复进分支
        // (interrupt 不重复发), 交给下面的闸拦。
        if (
          turnStartFailedWithoutTurnId
          && currentTurnId === null
          && !terminalErroredTurnIds.has(params.turn.id)
          && !completedTurnIds.has(params.turn.id)
        ) {
          if (isTurnStartPending) {
            // 新 turn/start 在飞 → 归属不明 (失败 RPC 的孤儿 vs 在飞 RPC 合法的
            // started-before-resp, 协议层无法区分): 缓冲隔离, 等响应按 turnId
            // 对账 (codex R9 P2)。直接接受会让孤儿 turn 的 item 事件渲染到
            // 本次 send 下。
            bufferedOrphanTurnIds.add(params.turn.id);
            log.debug('buffering ambiguous turnStarted until turn/start response arrives', {
              turnId: params.turn.id,
              threadId,
            });
            return;
          }
          terminalErroredTurnIds.add(params.turn.id);
          log.warn('ignoring orphan turnStarted from a failed turn/start — interrupting server-side turn', {
            turnId: params.turn.id,
            threadId,
          });
          if (threadId) {
            host.request(Method.TurnInterrupt, { threadId, turnId: params.turn.id })
              .catch((e: unknown) => {
                log.warn('orphan turn interrupt failed (best-effort)', {
                  turnId: params.turn.id,
                  error: e instanceof Error ? e.message : String(e),
                });
              });
          }
          return;
        }
        // terminal error 已经为该 turn 收口时，晚到的 start 只能忽略，等待 completed 做清理。
        if (shouldIgnoreStaleTurnEvent(params.turn.id)) return;
        // 终态已先到的 turn (墓碑) 不得被乱序晚到的 started 重新置活。
        if (turnsCompletedBeforeStartResp.has(params.turn.id)) return;
        threadMayHaveRollout = true;
        const wasSameTurn = currentTurnId === params.turn.id;
        // started 先于响应到达时归属方只能推断: 只有一个 start 在飞 → 就是它; 多个 → 认不出,
        // 不登记(读取方按"归属不明"从严处理)。
        const startedOwnerEntries = [...inFlightStarts.entries()];
        const startedOwner = startedOwnerEntries.length === 1
          ? startedOwnerEntries[0]
          : undefined;
        const existingTurnOrigin = turnOriginByTurnId.get(params.turn.id);
        const turnModel = startedOwner?.[1].model ?? existingTurnOrigin?.model ?? activeTurnModel;
        const startedServiceTier = startedOwner?.[1].serviceTier;
        const turnServiceTier = startedServiceTier !== undefined
          ? startedServiceTier
          : existingTurnOrigin?.serviceTier;
        turnOriginByTurnId.set(params.turn.id, {
          startSeq: startedOwner?.[0] ?? null,
          sendGen: startedOwner?.[1].sendGen ?? sendGeneration,
          startedAtMs:
            startedOwner?.[1].startedAtMs
            ?? (existingTurnOrigin
              ? existingTurnOrigin.startedAtMs
              : (startedOwnerEntries.length === 0 ? Date.now() : 0)),
          ...(turnModel ? { model: turnModel } : {}),
          ...(turnServiceTier !== undefined ? { serviceTier: turnServiceTier } : {}),
        });
        // Notifications may arrive before the turn/start RPC response. Bind the
        // selector at the same unique-owner boundary as turnOrigin so an early
        // MCP elicitation sees the accepted send's capability choice. Multiple
        // starts, quarantined starts, and already-settled cancellations remain
        // unbound and therefore fail closed.
        if (
          !wasSameTurn &&
          startedOwner &&
          !startedOwner[1].quarantined &&
          !startedOwner[1].terminalSettled
        ) {
          bindRootCapabilitySelection(
            params.turn.id,
            startedOwner[1].capabilitySelectionText,
          );
        }
        activateRootTurn(params.turn.id);
        // turn 开始 → 球在上游,起 idle 表。后续产品进展会重置;status / account_usage 心跳不算。
        armUpstreamIdle();
        // turn/start 在飞期间权限档或可写根被收紧 (turnStarted 通知可能先于 turn/start resp
        // 到达) → 拿到 id 立即补中断, 与 handleTurnStartResp 互斥消费同一标记。
        if (pendingTightenInterrupt || pendingWritableRootRevocationInterrupt) {
          pendingTightenInterrupt = false;
          pendingWritableRootRevocationInterrupt = false;
          void interruptTurnForPermissionTighten(params.turn.id);
        }
        if (!wasSameTurn) currentTurnPlanModeActive = pendingTurnStartPlanMode ?? planCycleActive;
        terminalErroredTurnIds.delete(params.turn.id);
        // Generation starts at the local receipt of turn/started, never at the
        // earlier RPC response. The helper is idempotent for duplicate started
        // notifications, including when the response already adopted this id.
        beginCodexGenerationTurn(translatorRt, params.turn.id);
        // 产出记账**不在这里清**: 它按 turn id 存(producedOutputTurnIds), 新 turn 天然
        // 从"零产出"起算, 同一 turn 的重复 / 迟到 started 也不会抹掉已记的账 —— 这两条
        // 以前靠 `if (!wasSameTurn)` 的时序守卫维持(review #844 codex P1), 现在是结构性的。
        // **不在这里重置 overloadRetry.attempt**:过载重投本身会开出新 turn,
        // 在这里清预算等于每次重投都续满次数 → 容量故障期无限重试烧额度。
        // 预算只在 send() 收到用户新消息时重置。
        log.debug('SDK ▶ turn start', {
          turnId: params.turn.id,
          model: mutableModel,
          effort: mutableEffort,
          permissionMode: mutablePermissionMode,
          serviceTier: serviceTierState.value ?? null,
          fastMode: fastModeFromServiceTier(serviceTierState.value),
        });
      },
      tokenUsageUpdated: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.tokenUsageUpdated?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        const reportedWindow = params.tokenUsage?.modelContextWindow;
        if (typeof reportedWindow === 'number' && Number.isFinite(reportedWindow) && reportedWindow > 0) {
          lastNativeContextWindowTurnId = params.turnId || null;
        }
        lastModelContextWindow = resolveUsageContextWindow(reportedWindow ?? null);
        usageTracker.setContextWindow(lastModelContextWindow ?? 0);
        const last = params.tokenUsage?.last;
        if (!last) return;
        lastTurnTokenUsage = last;
        const cached = last.cachedInputTokens ?? 0;
        const cacheWrite = last.cacheWriteInputTokens ?? 0;
        const totalInput = last.inputTokens ?? 0;
        const uncachedInput = Math.max(0, totalInput - cached - cacheWrite);
        const cumulativeTotal = params.tokenUsage?.total;
        if (!cumulativeTotal) return;
        const previousCursor = acceptedUsageTotalByThread.get(params.threadId);
        const previousTotal =
          previousCursor?.generation === usageExecutionGeneration ? previousCursor.total : undefined;
        const hasBillableLast =
          last.inputTokens > 0 ||
          last.cachedInputTokens > 0 ||
          cacheWrite > 0 ||
          last.outputTokens > 0 ||
          last.reasoningOutputTokens > 0;
        // A lower cursor can be an out-of-order frame, so it is not sufficient
        // evidence of a new execution generation. A genuinely new thread gets
        // a distinct threadId and therefore a fresh map entry. Same-thread
        // resets need an explicit host/process generation before they can be
        // accepted safely; guessing here would double-charge delayed frames.
        const isNewUsageSegment =
          hasBillableLast &&
          Number.isFinite(cumulativeTotal.totalTokens) &&
          cumulativeTotal.totalTokens > 0 &&
          (previousTotal === undefined || cumulativeTotal.totalTokens > previousTotal.totalTokens);
        if (isNewUsageSegment) {
          const turnServiceTier = turnOriginByTurnId.get(params.turnId)?.serviceTier;
          acceptedUsageTotalByThread.set(params.threadId, {
            generation: usageExecutionGeneration,
            total: { ...cumulativeTotal },
          });
          usageTracker.ingestApiCallUsage({
            inputTokens: uncachedInput,
            // outputTokens already includes the reasoning subset. Adding
            // reasoningOutputTokens again double-counts completion usage.
            outputTokens: last.outputTokens ?? 0,
            cacheReadTokens: cached,
            cacheCreateTokens: cacheWrite,
            reasoningTokens: last.reasoningOutputTokens ?? 0,
            model: turnOriginByTurnId.get(params.turnId)?.model ?? activeTurnModel ?? mutableModel,
            priceVariant: opts.resolveUsagePriceVariant?.({
              threadId: params.threadId,
              inputTokens: totalInput,
              outputTokens: last.outputTokens ?? 0,
              cacheReadTokens: cached,
            }) ?? ((turnServiceTier !== undefined ? turnServiceTier : serviceTierState.value) === 'ultrafast'
              ? 'ultrafast'
              : fastModeFromServiceTier(turnServiceTier !== undefined ? turnServiceTier : serviceTierState.value)
                ? 'priority'
                : 'standard'),
          });
          // Input/cache-only segments still belong in the ledger, but cannot
          // pair already reported output with a later generation denominator.
          if (last.outputTokens > 0) {
            translatorRt.generationOutputTokens += last.outputTokens;
            translatorRt.generationOutputDurationMs = sampleGenerationDuration(
              translatorRt.generationDurationMs,
              translatorRt.generationStartedAt,
            );
            if (translatorRt.generationTimingReliable) {
              translatorRt.tokenSpeed.recordUsage(
                translatorRt.generationOutputTokens,
                translatorRt.generationOutputDurationMs,
              );
            } else {
              translatorRt.tokenSpeed.invalidate();
            }
          }
          maybePushUsageRefresh();
          // Maker Memory flush 观察 (A 轻版: 只打日志). makerMemoryEnabled 关时 controller 为 null。
          if (memoryFlushController) {
            const snap = usageTracker.snapshot();
            memoryFlushController.onUsageUpdate(snap.contextTokens, snap.contextWindow);
          }
        } else {
          log.debug('ignoring duplicate or out-of-order Codex usage snapshot', {
            threadId: params.threadId,
            turnId: params.turnId,
            previousTotal: previousTotal?.totalTokens ?? null,
            cumulativeTotal: cumulativeTotal.totalTokens,
          });
        }
        // 压缩风暴熔断 (见 compaction-storm.ts)。喂**上报的 input 总量**而不是
        // usageTracker 快照: 判据比的是「压缩前后同一口径的水位」, 而 tracker 的
        // contextTokens 掺了本地口径的换算与跨 turn 累计, 拿它比会把口径差当成压缩效果。
        const stormDecision = compactionStormTracker.noteUsage(totalInput, Date.now());
        if (stormDecision?.escalate) {
          // reason 与 message 一起取: renderer 会用 reason 的本地化文案盖掉 message,
          // 两者必须同源, 否则用户看到的那半可能与证据不符 (见该函数注释)。
          const { reason, message } = buildCompactionStormTerminalError({
            ineffectiveCount: stormDecision.ineffectiveCount,
            contextTokens: stormDecision.contextTokens,
            elapsedMs: stormDecision.elapsedMs,
            switchedModel: modelSwitchRecord,
          });
          log.error('codex compaction storm escalated to terminal error (compaction not converging)', {
            threadId,
            turnId: params.turnId,
            ineffectiveCount: stormDecision.ineffectiveCount,
            // pre / post 一起记: 排查时最有说服力的一行就是"把 pre 那么大的历史压完,
            // 总量还是 post" —— 风暴时典型是 30k 的历史压出 326k 的总量。
            preCompactionTokens: stormDecision.preCompactionTokens,
            contextTokens: stormDecision.contextTokens,
            elapsedMs: stormDecision.elapsedMs,
            reportedContextWindow: params.tokenUsage?.modelContextWindow ?? null,
            effectiveContextWindow: lastModelContextWindow,
            reason,
            ...(modelSwitchRecord ? { modelSwitch: modelSwitchRecord } : {}),
          });
          // 熔断后重新计数: 用户若选择继续 (发新消息前上游又压了几轮), 不会因为
          // 残留计数在下一条 usage 上立刻二次熔断。
          compactionStormTracker.reset();
          // 复用 idle watchdog 的收口路径 (终态墓碑 + error + turn 收口 + interrupt)。
          // ignorePendingTools: idle watchdog 停表是因为"球在 daemon 手里, 不该算它
          // 超时"; 而这里的判据是"压缩本身失效了", 与球在谁手里无关。留着那道闸只会
          // 让残留的未收口工具条目把熔断挡在门外, 用户继续看着它循环。
          onUpstreamIdleTimeout({
            reason,
            message,
            logLabel: 'compaction storm — interrupting current turn',
            ignorePendingTools: true,
          });
        }
      },
      turnDiffUpdated: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.turnDiffUpdated?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        publishTurnDiff(threadId, params.turnId, params.diff);
      },
      turnCompleted: (params) => {
        // buffered turn 的终态同样进队列等对账 (greptile R11 P1 + codex R12 P1):
        // 合法 → 激活后按序重放, handleTurnCompleted 自然收口 send; 孤儿 →
        // 整队丢弃。直接处理会让孤儿 completed 提前收口在飞 send
        // (handleTurnCompleted 在 currentTurnId===null 下也收口 emit done);
        // 直接丢弃会把尸体 turn 激活成 in-flight, send 永久卡 generating。
        if (enqueueIfBufferedTurn(params.turn.id, () => handlers.turnCompleted?.(params))) return;
        // 只拦 idle 孤儿 (codex R15 P1): 无 pending 时它的 completed 会走
        // currentTurnId===null 的收口分支 emit 假 done。这里**只**落墓碑, 不补 interrupt ——
        // 这个 turn 已经结束了, interrupt 是纯浪费的 RPC(与 tombstoneIdleOrphanTurn 的分工)。
        // terminal/completed
        // 墓碑 turn 的迟到 completed 仍走 handleTurnCompleted 的正常
        // bookkeeping (suppressTerminalUi 分支, 不重复出 UI 事件) — 不能上
        // 整个 stale 闸。
        if (isIdleOrphanTurnId(params.turn.id)) {
          terminalErroredTurnIds.add(params.turn.id);
          return;
        }
        handleTurnCompleted(params);
      },
      itemStarted: (params) => {
        // 血缘不能跟着 turn 对账队列一起迟到:AppServerHost 只为未知 child 缓冲 5s。
        // 卡片/翻译仍在队列内,这里只保留 provisional claim；父 turn 被接受后
        // 重放 item 才 commit root route，孤儿则 discard。
        const reservedChildThreadIds = reserveSubagentSpawnLineage(params.item);
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.itemStarted?.(params), {
          modelWork: itemRepresentsModelWork(params.item),
        })) {
          rememberPendingSpawnLineage(params.turnId, reservedChildThreadIds);
          return;
        }
        if (shouldIgnoreStaleTurnEvent(params.turnId)) {
          discardPendingSpawnLineageIds(reservedChildThreadIds);
          return;
        }
        if (params.item.type === 'contextCompaction' && !compactingTurnIds.has(params.turnId)) {
          compactingTurnIds.add(params.turnId);
          // Native compaction owns this wait; retain the bounded upstream-idle
          // watchdog instead of interrupting it on an earlier reconnect deadline.
          if (params.turnId === currentTurnId) {
            clearReconnectStall();
            turnRetryTracker.reset();
          }
        }
        if (interceptProposedPlanItem(params.turnId, params.item)) {
          discardPendingSpawnLineageIds(reservedChildThreadIds);
          return;
        }
        // 模型已开始产出 → 本 turn 不再适合被过载重投整体重放。SDK echo 类 item
        // (userMessage 等)不算产出, 见 itemRepresentsModelWork。
        if (itemRepresentsModelWork(params.item)) {
          producedOutputTurnIds.add(params.turnId);
          noteRecoveryModelWork(params.turnId, params.item);
        }
        noteActiveToolContext(params.item, params.turnId);
        noteToolItemLifecycle(params.item, 'started');
        if (interceptAsyncUserInput(params, 'started')) return;
        // 先登记再翻译:子线程通知可能紧随 spawn item 到达,映射就位才不丢首帧。
        const translatedItem = withFrozenSubagentSpawnIdentity(params.item, params.turnId);
        const translatedParams = translatedItem === params.item
          ? params
          : { ...params, item: translatedItem };
        const replayedSubagentUpdate = noteSubagentSpawnItem(
          translatedItem,
          params.turnId,
          'started',
        );
        pushItemStatus(translatedItem);
        translateItemNotification('started', translatedParams, eventQueue, {
          rt: translatorRt,
          log,
          onCompactBoundary: handleCompactBoundary,
        });
        // 重放帧后发:translator 刚推的 running 帧不得把已重放出的终态盖回去。
        if (replayedSubagentUpdate) emitSubagentCardUpdate(replayedSubagentUpdate);
      },
      itemUpdated: (params) => {
        const reservedChildThreadIds = reserveSubagentSpawnLineage(params.item);
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.itemUpdated?.(params), {
          modelWork: itemRepresentsModelWork(params.item),
        })) {
          rememberPendingSpawnLineage(params.turnId, reservedChildThreadIds);
          return;
        }
        if (shouldIgnoreStaleTurnEvent(params.turnId)) {
          discardPendingSpawnLineageIds(reservedChildThreadIds);
          return;
        }
        if (interceptProposedPlanItem(params.turnId, params.item)) {
          discardPendingSpawnLineageIds(reservedChildThreadIds);
          return;
        }
        if (itemRepresentsModelWork(params.item)) {
          producedOutputTurnIds.add(params.turnId);
          noteRecoveryModelWork(params.turnId, params.item);
        }
        noteActiveToolContext(params.item, params.turnId);
        rememberYieldedExecCells(params.turnId, params.item, 'updated');
        if (interceptAsyncUserInput(params, 'updated')) return;
        // updated 也要登记映射,顺序与 started / completed 一致(先登记 → 翻译 → 后发重放帧)。
        // V1 的 spawn 是长跑 item(started → updated* → completed):started 那帧若没到我们手里
        // (turn 缓冲、stale turn 丢弃、上游省略),映射就要一直等到 completed 才建立 —— 期间
        // 子线程的 item / token / turn 终态全被缓冲,卡片在整个运行期(可能好几分钟)没有实时
        // 数据,最后才一次性补上。那恰好是本 PR 要解决的问题本身(review)。
        const translatedItem = withFrozenSubagentSpawnIdentity(params.item, params.turnId);
        const translatedParams = translatedItem === params.item
          ? params
          : { ...params, item: translatedItem };
        const replayedSubagentUpdateOnUpdated = noteSubagentSpawnItem(
          translatedItem,
          params.turnId,
          'updated',
        );
        translateItemNotification('updated', translatedParams, eventQueue, {
          rt: translatorRt,
          log,
          onCompactBoundary: handleCompactBoundary,
        });
        if (replayedSubagentUpdateOnUpdated) {
          emitSubagentCardUpdate(replayedSubagentUpdateOnUpdated);
        }
      },
      itemCompleted: (params) => {
        const reservedChildThreadIds = reserveSubagentSpawnLineage(params.item);
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.itemCompleted?.(params), {
          modelWork: itemRepresentsModelWork(params.item),
        })) {
          rememberPendingSpawnLineage(params.turnId, reservedChildThreadIds);
          return;
        }
        const collabTerminalKey = collabTerminalItemKey(params.turnId, params.item);
        if (collabTerminalKey && handledCollabTerminalItemIds.has(collabTerminalKey)) {
          discardPendingSpawnLineageIds(reservedChildThreadIds);
          return;
        }
        let isLateCollabTerminal = false;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) {
          // A non-transport terminal error can close the logical turn before the
          // authoritative turn/completed arrives. Keep the same one-shot late
          // collab carve-out open for that error tombstone, otherwise the stale
          // guard would swallow the child's terminal item and leave its task card
          // running forever.
          if (
            !collabTerminalKey
            || (!completedTurnIds.has(params.turnId) && !terminalErroredTurnIds.has(params.turnId))
          ) {
            discardPendingSpawnLineageIds(reservedChildThreadIds);
            return;
          }
          isLateCollabTerminal = true;
        }
        if (interceptProposedPlanItem(params.turnId, params.item)) {
          discardPendingSpawnLineageIds(reservedChildThreadIds);
          return;
        }
        if (collabTerminalKey) handledCollabTerminalItemIds.add(collabTerminalKey);
        if (params.item.type === 'contextCompaction') {
          compactingTurnIds.delete(params.turnId);
          if (threadModelProvider === localSummaryProvider && overloadRetry?.automaticRecoveryAttempted) {
            completedSummaryRecoveryTurnIds.add(params.turnId);
          }
        }
        if (itemRepresentsModelWork(params.item)) {
          producedOutputTurnIds.add(params.turnId);
          noteRecoveryModelWork(params.turnId, params.item);
        }
        if (interceptAsyncUserInput(params, 'completed')) return;
        noteAssistantReplyCandidate(params.turnId, params.item);
        completeActiveToolContext(params.item, params.turnId);
        rememberYieldedExecCells(params.turnId, params.item, 'completed');
        // This late item belongs to an already-terminal parent. The parent
        // cleanup already cleared its pending tools; touching the shared
        // lifecycle set here would re-arm the currently active turn's idle
        // watchdog with a fresh budget.
        if (!isLateCollabTerminal) noteToolItemLifecycle(params.item, 'completed');
        // 防御:spawn item 的 started phase 若被上游省略,completed 仍能补上映射。
        const translatedItem = withFrozenSubagentSpawnIdentity(params.item, params.turnId);
        const translatedParams = translatedItem === params.item
          ? params
          : { ...params, item: translatedItem };
        const replayedSubagentUpdateOnCompleted = noteSubagentSpawnItem(
          translatedItem,
          params.turnId,
          'completed',
        );
        const itemEventQueue = isLateCollabTerminal
          ? {
            push: (event: AgentEvent) => eventQueue.push({
              ...event,
              turnScope: 'background',
              // Missing ownership fails closed only if a later /clear exists.
              backgroundTurnStartedAt:
                turnOriginByTurnId.get(params.turnId)?.startedAtMs ?? 0,
            }),
            end: () => eventQueue.end(),
            clear: () => eventQueue.clear(),
            get pending() { return eventQueue.pending; },
            [Symbol.asyncIterator]: () => eventQueue[Symbol.asyncIterator](),
          } as AsyncQueue<AgentEvent>
          : eventQueue;
        const denialKey = approvalDenialKey(params.threadId, params.turnId, params.item.id);
        const approvalDenialReason = approvalDenials.get(denialKey)?.reason;
        approvalDenials.delete(denialKey);
        translateItemNotification('completed', translatedParams, itemEventQueue, {
          rt: translatorRt,
          log,
          approvalDenialReason,
          onCompactBoundary: handleCompactBoundary,
        });
        // A late V1 spawn completion is the spawn tool closing, not necessarily
        // the child closing. Reassert a running compact state, or an explicit
        // failed/stopped tracker state; a completed replay would only duplicate
        // the translator's own frame.
        const shouldReplayLateSubagentState =
          collabItemHasRunningAgentState(params.item)
          || replayedSubagentUpdateOnCompleted?.status === 'failed'
          || replayedSubagentUpdateOnCompleted?.status === 'stopped';
        if (!isLateCollabTerminal || shouldReplayLateSubagentState) {
          if (replayedSubagentUpdateOnCompleted) {
            emitSubagentCardUpdate(
              replayedSubagentUpdateOnCompleted,
              isLateCollabTerminal
                ? {
                  turnScope: 'background',
                  backgroundTurnStartedAt:
                    turnOriginByTurnId.get(params.turnId)?.startedAtMs ?? 0,
                }
                : {},
            );
          }
        }
        // item 完成后, 若 turn 仍在跑, 先回到 'Generating...' 兜底 — 下一条 item 起来会再覆盖。
        // turn/completed 在 turn 结束时会 push 'Done' 终态, 不需要在这里特判。
        // 迟到的旧 turn 收口只允许发 background 结果,不能给当前 turn 注入前台状态。
        if (isTurnInFlight && !isLateCollabTerminal) pushStatus('Generating...');
      },
      agentMessageDelta: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.agentMessageDelta?.(params), {
          modelWork: true,
        })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        producedOutputTurnIds.add(params.turnId);
        noteRecoveryModelWork(params.turnId);
        translateAgentMessageDelta(params, eventQueue, { rt: translatorRt, log });
        maybePushUsageRefresh();
      },
      turnPlanUpdated: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.turnPlanUpdated?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        latestPlanByTurn.set(params.turnId, params.plan);
        translatePlanUpdatedNotification(params, eventQueue);
      },
      reasoningSummaryTextDelta: (params) => {
        // thinking 流同样算产出(与非缓冲路径一致)。
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.reasoningSummaryTextDelta?.(params), { modelWork: true })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        // thinking 流也算产出：模型已经在这一轮里工作了，整体重放不再等价。
        producedOutputTurnIds.add(params.turnId);
        noteRecoveryModelWork(params.turnId);
        translateReasoningSummaryTextDelta(params, eventQueue, { rt: translatorRt, log });
        maybePushUsageRefresh();
      },
      reasoningSummaryPartAdded: (params) => {
        // thinking 流同样算产出(与非缓冲路径一致)。
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.reasoningSummaryPartAdded?.(params), { modelWork: true })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        producedOutputTurnIds.add(params.turnId);
        noteRecoveryModelWork(params.turnId);
        translateReasoningSummaryPartAdded(params, eventQueue, { rt: translatorRt, log });
      },
      reasoningTextDelta: (params) => {
        // thinking 流同样算产出(与非缓冲路径一致)。
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.reasoningTextDelta?.(params), { modelWork: true })) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        producedOutputTurnIds.add(params.turnId);
        noteRecoveryModelWork(params.turnId);
        translateReasoningTextDelta(params, eventQueue, { rt: translatorRt, log });
        maybePushUsageRefresh();
      },
      accountRateLimitsUpdated: (params) =>
        translateAccountRateLimitsUpdated(params, eventQueue, { rt: translatorRt, log }),
      threadStatusChanged: (params) => {
        // Idle / NotLoaded / SystemError 由 turn/completed + error 主导, 这里不重复 emit。
        // 只把 Active.activeFlags 翻成 "Waiting on approval/input..." status 文案。
        if (!isTurnInFlight) return;
        if (params.status.type !== 'active') return;
        const flags = params.status.activeFlags;
        if (flags.includes('waitingOnApproval')) pushStatus('Waiting on approval...');
        else if (flags.includes('waitingOnUserInput')) pushStatus('Waiting on input...');
      },
      threadSettingsUpdated: (params) => {
        // server 端权威设置快照 (响应我们的 thread/settings/update, 或 server 自身降级)。
        // 把本地 mutable 三态对齐 server 真相 —— 最关键是 serviceTier: 模型不支持 fast
        // 时 server 会把它降级, 这里第一时间感知, getFastMode() 立刻反映正确值, 不必等
        // 某个 turn 的响应推断。通知恒带完整 ThreadSettings, 故 serviceTier 总是 present。
        const s = params.threadSettings;
        const before = serviceTierState.value ?? null;
        const beforeModel = mutableModel;
        serviceTierState.value = normalizeServiceTier(s.serviceTier) ?? null;
        // 只对齐 wire 值: server 会把请求 id 规范化(`gpt-5.4` → `gpt-5.4-codex`),那个变体
        // 目录里没有。**刻意不动 mutableCatalogModel** —— 否则窗口上限会因为查不到目录条目
        // 而停止收敛(见该变量注释)。
        if (typeof s.model === 'string' && s.model) mutableModel = s.model;
        if (mutableModel !== beforeModel) {
          refreshCodexAutoReviewerRoute(params.threadId);
        }
        // ReasoningEffort 的 'none' 不属于 Effort; 排除后其余值都是合法 Effort, 无需 cast。
        // A server default must not replace an explicit no-effort session choice.
        if (mutableEffort && s.effort && s.effort !== 'none') mutableEffort = s.effort;
        if (before !== (serviceTierState.value ?? null)) {
          log.debug('thread/settings/updated reconciled serviceTier', {
            threadId: params.threadId,
            from: before,
            to: serviceTierState.value ?? null,
            fastMode: fastModeFromServiceTier(serviceTierState.value),
          });
        }
      },
      autoApprovalReviewStarted: (params: ItemGuardianApprovalReviewStartedNotification) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.autoApprovalReviewStarted?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        log.debug('Codex automatic approval review started', {
          reviewId: params.reviewId,
          turnId: params.turnId,
          targetItemId: params.targetItemId,
          actionType: params.action.type,
        });
      },
      autoApprovalReviewCompleted: (params) => {
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.autoApprovalReviewCompleted?.(params))) return;
        if (shouldIgnoreStaleTurnEvent(params.turnId)) return;
        handleGuardianReviewCompleted(params);
      },
      guardianWarning: (params: GuardianWarningNotification) => {
        // The completed review carries the actionable denial/timeout details. Keep the
        // warning for diagnostics to avoid rendering a duplicate error card.
        log.warn('Codex Guardian warning', { threadId: params.threadId, message: params.message });
      },
      warning: (params) => {
        if (params.message.startsWith(CODEX_HTTPS_FALLBACK_WARNING_PREFIX)) {
          log.info('codex fell back to HTTPS transport; reconnect deadline cleared', { threadId });
          clearReconnectStall();
        }
      },
      error: (params) => {
        // buffered turn 的 error (含终态) 同样进队列等对账 (greptile R11 P1 +
        // codex R12 P1): 合法 → 激活后重放走正常终端路径收口 send; 孤儿 →
        // 丢弃, 不得让孤儿 error 终结合法 send。
        if (enqueueIfBufferedTurn(params.turnId, () => handlers.error?.(params))) return;
        let effectiveParams = params;
        let isTerminalError = params.willRetry !== true;
        const isTransportError = params.scope === 'transport';
        if (isTransportError) {
          subscriptionInvalidatedByTransport = true;
          // 订阅已作废(app-server 崩了 / IO 断开)→ 后代通知**永远不会再到**,而 tracker 只靠
          // 后代 turn/completed 写终态。不在这里收口,渲染端会一直留着最后一帧 running:进程
          // 早就死了,子代理卡还在原地转圈(review)。这条路径与 close() / cleanup-failure 是
          // 同一类,只是入口不同 —— 复用同一套终态快照 + 清 tracker。
          for (const update of subagentLiveCards.drainRunningForShutdown()) emitSubagentCardUpdate(update);
          subagentLiveCards.clear();
          dismissAllPendingUserInput('transport_error');
          activeToolContexts.clear();
          approvalDenials.clear();
          completedActiveToolTurns.clear();
          capabilitySelectionTextByTurnId.clear();
          capabilitySelectionTextByThreadId.clear();
          descendantParentThreadByThreadId.clear();
          rootTurnIdByDescendantThreadId.clear();
          terminalDescendantTurnIds.clear();
          submittedUserInputByTurn.clear();
          clearAllPendingUserInputInteractions();
          cancelActiveYieldContinuation('transport error');
        }
        if (!isTransportError && shouldIgnoreStaleTurnEvent(params.turnId)) return;
        const targetsPendingTurn = isTurnStartPending && currentTurnId === null && Boolean(params.turnId);
        // 空 turnId 的容量拒绝: 过载重投的 RPC 还在飞、而它的 turnStarted 尚未到达时,
        // currentTurnId 是 null 且 isTurnInFlight 是 false —— 上面两条既有判据都不成立,
        // 这条错误会被当 stale 整条丢掉。后果是既不落墓碑也不记账, 随后到达的
        // turn/start 响应把这个已经报过容量失败的 turn 激活成活跃 turn, 剩余重投预算
        // 被绕过, 只能等它自己的 turn/completed 收口成硬失败(review #844 codex P1)。
        // 只对**过载类**放行: 其它空 id 终态错误(含 transport)保持既有行为, 免得把
        // 与本轮无关的错误误认成"针对当前 turn"。
        // 判据用 isTurnStartPending 而**不是** overloadRetry.inFlight: 后者只由重投路径
        // 设置, 初始投递的 turn/start 在飞时永远为 false —— 那个窗口里的空 id 容量拒绝
        // 一样会被丢掉, 响应随后激活一个已被拒的 turn, 自动重投预算整轮白给
        // (review #844 codex P1)。
        // 归属唯一时(只有一个 start 在飞)才认它。两个及以上在飞时这条通知无法归属:
        // 既不能接管重投(猜错就重放已跑过工具的 turn), 也**不能**让它走终态 —— 后者会
        // 拿别人的错误把当前这一轮判死, 而那一轮的响应随后照样会被激活, 于是"UI 已收口、
        // 工具还在跑"(review #844 codex P1)。
        // 不认 → 落到既有的 `stale codex terminal error ignored` 分支被丢掉, 这是安全的:
        // 真属于某个 turn 的话, server 随后会为那个 turn 发权威的 turn/completed(failed),
        // 收口由它完成。
        // 判定同样优先吃结构化 codexErrorInfo, 文案只作老 daemon 兜底: 这条判据决定
        // 空 id 的容量拒绝能不能被归属到在飞的 turn/start, 漏判 = 整轮重投预算白给。
        const idLessCapacityError =
          params.turnId === ''
          && isTerminalError
          && parseOverloadError(
            params.error?.message ?? '',
            extractNonSecretErrorSignals(params.error?.message ?? '').errorStatus,
            codexErrorInfoTag(params.error?.codexErrorInfo),
          ) !== null;
        const idLessAttributable = inFlightStarts.size === 1;
        const targetsIdLessPendingStart =
          idLessCapacityError
          && isTurnStartPending
          && currentTurnId === null
          && idLessAttributable;
        // 空 id 的容量拒绝什么时候才算"活跃 turn 的"。
        //
        // 判据是**它自己的 admission 还没回包**: 空 turnId 这个形状的含义就是"server 还没能
        // 告诉你是哪个 turn", 也就是容量在 admission 阶段被拒。活跃 turn 的 turn/start 若已
        // 经回包, 它早就过了 admission —— 之后真为它发的容量错误一定带得上 turnId。所以此时
        // 的空 id 通知只可能来自别处(最典型: 被 Stop 的旧 send, 它的 turn id 我们从没学到),
        // 认在活跃 turn 头上的后果是: scheduleTurnReplayRetry 拿 currentTurnId 当死 turn, 把一
        // 个正常在跑的 turn 落墓碑、撤销重投、推 Done, 而 server 侧那个 turn 还在执行工具
        // (review #844 codex/greptile P1)。
        //
        // 覆盖三种此前漏掉或猜错的形状, 收敛成一条:
        //  - 活跃 turn 的 start 已 settle、登记表里躺着**别人**的 start(Stop 留下的旧 RPC);
        //  - 活跃 turn 的 start 已 settle、且**没有任何** start 在飞(上一条的对称情形);
        //  - 归属未知(拿不到 origin.startSeq)。
        // 保留的是唯一合法形状: started-before-resp —— 活跃 turn 是它自己那次仍在飞的 start
        // 生出来的, 那条空 id 拒绝确实可能是它的 admission。
        // 只收紧**容量**这一类: 其它空 id 终态错误保持既有行为, 免得顺手改了无关语义。
        const activeTurnStartSeq =
          currentTurnId !== null ? turnOriginByTurnId.get(currentTurnId)?.startSeq ?? null : null;
        const idLessCapacityTargetsActiveTurn =
          isTurnInFlight
          && currentTurnId !== null
          && activeTurnStartSeq !== null
          && inFlightStarts.has(activeTurnStartSeq)
          && !hasOtherInFlightStart(activeTurnStartSeq);
        const targetsCurrentTurn =
          params.turnId === currentTurnId
          || (params.turnId === ''
            && isTurnInFlight
            && (!idLessCapacityError || idLessCapacityTargetsActiveTurn))
          || targetsPendingTurn
          || targetsIdLessPendingStart;
        if (
          !isTerminalError &&
          targetsCurrentTurn &&
          parseReconnectAttemptMessage(params.error?.message ?? '') !== null
        ) {
          // error notification 可能抢在 turnStarted / turn/start response 前到达；这里
          // 先按 params.turnId 绑定 deadline，turnStarted 随后会把 generation 重新绑定
          // 到已接受的 turn，不让这类乱序事件漏掉静默重连卡死。
          armReconnectStall(params.turnId || currentTurnId);
        }
        if (isTerminalError && isTransportError && !targetsCurrentTurn) {
          translateErrorNotification(effectiveParams, eventQueue, { rt: translatorRt, log });
          return;
        }
        if (isTerminalError && !targetsCurrentTurn) {
          log.warn('stale codex terminal error ignored', {
            errorTurnId: params.turnId,
            currentTurnId,
            isTurnInFlight,
          });
          return;
        }
        // ── retry-loop 终局升级 (issue #677) ──
        // 远端摸不到 Codex 后端时 daemon 无限发 willRetry=true — 协议层设计上
        // willRetry 不收口, 但持续性不可达 (403 / Network unreachable / timeout)
        // 意味着 retry 永远不会成功。同 turn 计数/时长超阈值后合成终态错误,
        // 落入下面与原生终态 error 完全相同的收口路径。
        // auth 相关错误 (缺失 401 / 无效凭证 marker) 排除: 它们走 auth 修复 UX
        // (「同步登录态」/ 重新登录), 升级成「后端不可达」会抢路径并误导排查
        // (review: PR #715 五轮审核 P1 — 判定与 translator 共用 isAuthRelated*)。
        // rate-limit / usage-limit (429 / quota) 同样排除 (codex R12 P2):
        // 那是 provider 让等的正常退避窗口, daemon 的 willRetry 会在窗口后
        // 成功; 升级成「后端不可达」+ proxy/VPN 引导既误杀可恢复重试又误导
        // 排查方向。willRetry 透出 (networkRetryNotice) 不受影响, 用户仍能
        // 看到「在限流退避」。
        if (!isTerminalError && targetsCurrentTurn) {
          const rawMessage = params.error?.message ?? '';
          const retrySignals = extractNonSecretErrorSignals(rawMessage);
          const isRateLimitBackoff = retrySignals.errorStatus === 429 || retrySignals.usageLimit;
          const isCompactionReconnect =
            compactingTurnIds.has(params.turnId || currentTurnId || '') &&
            parseReconnectAttemptMessage(rawMessage) !== null;
          // The upstream-idle watchdog bounds native compaction. A later
          // reconnect notice must not reintroduce the short retry deadline.
          if (!isAuthRelatedErrorMessage(rawMessage) && !isRateLimitBackoff && !isCompactionReconnect) {
            const decision = turnRetryTracker.track(
              params.turnId || currentTurnId || '(pending)',
              Date.now(),
            );
            if (decision.escalate) {
              // 本地收口后 daemon 侧原 turn 还在无限 retry — fire-and-forget 补
              // interrupt, 否则它继续烧远端资源, 还可能与下一轮 send 的新 turn
              // 撞车 (review: PR #715 五轮审核 P1)。失败仅 warn: 本地已按终态
              // 处理, daemon 死亡/重启时该 turn 自然消失。
              if (params.threadId && params.turnId) {
                host.request(Method.TurnInterrupt, {
                  threadId: params.threadId,
                  turnId: params.turnId,
                }).catch((e: unknown) => {
                  log.warn('escalated turn interrupt failed (best-effort)', {
                    turnId: params.turnId,
                    error: e instanceof Error ? e.message : String(e),
                  });
                });
              }
              // 出站路径快照只对本地有意义 (远端 daemon 自己出网, 见
              // buildBackendUnreachableMessage 注释)。必须带 threadId: host 侧靠它
              // 定位本次请求实际打的上游 (codex 的出口随会话 provider 变), 查不到就
              // 返回 null 而不是拿「最近一条」凑。读取按 best-effort: 诊断绝不能反过来
              // 把已经在收口的错误路径搞崩。
              let outboundPath = null as OutboundPathFact | null;
              if (!opts.remoteHostId && this.deps.getOutboundPathFact) {
                try {
                  outboundPath = this.deps.getOutboundPathFact({
                    threadId: params.threadId,
                  }) ?? null;
                } catch (e) {
                  log.warn('outbound path fact lookup failed (best-effort)', {
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
              }
              const message = buildBackendUnreachableMessage({
                isRemote: Boolean(opts.remoteHostId),
                remoteHostId: opts.remoteHostId,
                retryCount: decision.retryCount,
                elapsedMs: decision.elapsedMs,
                lastError: rawMessage,
                outboundPath,
              });
              log.error('codex retry-loop escalated to terminal error (backend unreachable)', {
                threadId: params.threadId,
                turnId: params.turnId,
                retryCount: decision.retryCount,
                elapsedMs: decision.elapsedMs,
                // 与用户看到的消息同源;`at` 让排查者判断这条判定有多新
                // (系统代理判定有 TTL 缓存, 陈旧快照要按陈旧解读)。
                ...(outboundPath ? { outboundPath } : {}),
              });
              effectiveParams = { ...params, willRetry: false, error: { message } };
              isTerminalError = true;
            }
          }
        }
        const wasTurnRunning =
          isTurnInFlight
          || targetsPendingTurn
          || yieldContinuationInFlight
          || activeYieldContinuationClaim() != null
          || interactionContinuation != null;
        if (isTerminalError && targetsCurrentTurn && !isTransportError) {
          const recoveryTurnId = effectiveParams.turnId || currentTurnId || '';
          // error notification 只登记恢复意图并保持 logical turn 运行；
          // 权威 turn/completed 才负责收口旧 turn 与发起一次 HTTP 重投。
          if (recordAutomaticRecoveryIntent(recoveryTurnId, effectiveParams.error)) return;
        }
        // 服务过载(模型容量不足)时接管重投：translator 命中 capacity 才回调，
        // 拿到进度就把错误透成非终止状态，本函数随后跳过 Done 收口。
        let turnReplayRetryScheduled = false;
        translateErrorNotification(effectiveParams, eventQueue, {
          rt: translatorRt,
          log,
          onSamplingAttemptFailed: () => assistantReplyByTurn.delete(effectiveParams.turnId),
          tryTakeOverOverload: () => {
            // 只接管 app-server 本来就不重试的容量拒绝(原始 willRetry !== true)。
            // TurnRetryTracker 把持续 retry 升级成终态的那条路径不接管：那说明
            // daemon 已经重试很久仍不行，我们再叠一层退避重投属于双层重试。
            if (params.willRetry === true) return null;
            const progress = scheduleTurnReplayRetry(effectiveParams.turnId || currentTurnId);
            if (progress) turnReplayRetryScheduled = true;
            return progress;
          },
          tryTakeOverTerminalRateLimit: () => {
            // willRetry=true 仍归 daemon 自己退避，绝不叠第二层。这里只接它已经明确
            // 耗尽内部 retry budget 的终态 429；usageLimitExceeded 由判定器排除。
            if (params.willRetry === true) return null;
            const rawMessage = effectiveParams.error?.message ?? '';
            const signals = extractNonSecretErrorSignals(rawMessage);
            if (
              !isTerminalRateLimitRetryExhaustion(
                rawMessage,
                signals.errorStatus,
                effectiveParams.error?.codexErrorInfo,
              )
            ) {
              return null;
            }
            const deadTurnId = effectiveParams.turnId || currentTurnId;
            if (!deadTurnId || inFlightStarts.size > 0) return null;
            const progress = scheduleTurnReplayRetry(
              deadTurnId,
              TERMINAL_RATE_LIMIT_RETRY_POLICY,
            );
            if (progress) turnReplayRetryScheduled = true;
            return progress;
          },
        });
        // 与 translator 的 terminal 判定保持一致：willRetry=false 或缺省都视为终态。
        if (!isTerminalError) return;
        const terminalTurnId = effectiveParams.turnId || currentTurnId;
        if (turnReplayRetryScheduled) {
          // 死掉的 turn **必须**落墓碑：app-server 随后还会为它发正常的
          // turn/completed(failed)，没有墓碑 handleTurnCompleted 就会 emit terminal
          // error + done，把 UI 与 goal turn 直接收口，我们刚透出的非终止重试状态
          // 白费。重投会开出新的 turn id，不受这块墓碑影响。
          if (terminalTurnId) terminalErroredTurnIds.add(terminalTurnId);
          // **刻意不推任何 status**：renderer 的 handleStreamEvent 会在每个非 error
          // 事件上清掉 recoverableError，紧跟其后的 status 会立刻把刚透出的本地化
          // 「模型服务繁忙，正在自动重试（N/M）」横幅冲掉（review #844 codex P1）。
          // 会话状态本来就还是 running（没推 Done），退避期间的用户可见提示由那条
          // 非终止 error 横幅承担。
          return;
        }
        if (terminalTurnId) {
          terminalErroredTurnIds.add(terminalTurnId);
          dismissPendingUserInputForTurn(terminalTurnId, 'turn_failed');
          clearActiveToolContextsForTurn(terminalTurnId);
        }
        stopActiveRolloutPlanFallback();
        isTurnInFlight = false;
        currentTurnId = null;
        if (!wasTurnRunning) return;
        // 没接管(预算耗尽 / 已有产出 / 非容量错误)且这一轮确实在跑 → 下面推 Done 收口。
        // 同上: 收口即撤销重投资格, 否则延后标记会在别的 start settle 时补排。
        revokeOverloadRetryOnTerminalSettle('terminal error notification');
        // yield claim 让 isTurnRunning() 在 SDK turn 结束后仍为 true。transport
        // 路径在订阅作废时已经结算；非 transport 的终态 error 同样会推 Done,
        // 若不在这里同步取消, UI 已失败而后续 send 仍被 SESSION_RUNNING 拒绝。
        cancelActiveYieldContinuation('terminal error');
        eventQueue.push({
          type: 'status',
          data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
          source: 'codex',
        });
      },
      commandExecutionApproval,
      fileChangeApproval,
      mcpServerElicitation,
      permissionsApproval,
      serverRequestResolved: handleServerRequestResolved,
      requestUserInput,
      dynamicToolCall,
    };
    try {
      assertCurrentHost('thread subscription');
      subscription = host.subscribeThread(threadId, handlers);
    } finally {
      releaseHostBindingLeaseIfNeeded();
    }

    function resubscribeAfterTransportErrorIfNeeded(): void {
      if (!subscriptionInvalidatedByTransport) return;
      assertCurrentHost('resubscribe');
      subscription = host.subscribeThread(threadId, handlers);
      subscriptionInvalidatedByTransport = false;
    }

    async function closeSessionHandle(
      opts: { retireHostOnCleanupFailure?: boolean } = {},
    ): Promise<void> {
      if (closed) return;
      closed = true;
      cancelInteractionContinuation('session_closed', true);
      translatorRt.samplingSegments.clear();
      resetCodexGenerationTiming(translatorRt);
      clearReconnectStall();
      resetUpstreamIdleForTurnEnd();
      unregisterCodexMcpContext(threadId);
      unregisterDescendantCodexMcpContexts();
      activeToolContexts.clear();
      approvalDenials.clear();
      completedActiveToolTurns.clear();
      capabilitySelectionTextByTurnId.clear();
      capabilitySelectionTextByThreadId.clear();
      descendantParentThreadByThreadId.clear();
      rootTurnIdByDescendantThreadId.clear();
      terminalDescendantTurnIds.clear();
      // 会话收口后子代理卡不再有消费者。清状态**之前**必须先把仍在跑的卡收成终态:
      // 之后后代通知永远不会再到,只清内部状态会让渲染端一直留着最后一帧 running,卡片
      // 永久转圈(review)。
      for (const update of subagentLiveCards.drainRunningForShutdown()) emitSubagentCardUpdate(update);
      subagentLiveCards.clear();
      // close 时 buffer 里可能还有等对账的挂起请求 (codex R17 P2):
      // 统一按拒绝释放, 否则 handler 永远悬挂, dispatchServerRequest
      // 永不返回, server 侧请求卡死。
      discardYieldContinuationClaims('session closed');
      abandonBufferedTurns('session closed');
      abandonPendingCapabilitySteers();
      // 把挂起的 approval 强制 deny + emit interaction_dismissed (UI 关 dialog),
      // 否则 server 那边没回 response 会卡; UI 上的 PermissionPrompt 也会留尸
      try { dismissAllPending('session_closed', 'deny'); } catch (e) { log.warn('dismissAllPending threw', { error: String(e) }); }
      try { dismissAllPendingUserInput('session_closed'); } catch (e) { log.warn('dismissAllPendingUserInput threw', { error: String(e) }); }
      try { clearAllPendingUserInputInteractions(); } catch (e) { log.warn('clear pending user input threw', { error: String(e) }); }
      try { stopActiveRolloutPlanFallback(); } catch (e) { log.warn('stop rollout plan fallback threw', { error: String(e) }); }
      // 挂起的过载重投计时器必须清掉：否则会话已关，计时器到点仍会对已释放的
      // thread 发 turn/start（assertCurrentHost 会抛，但那是在无人接收的
      // setTimeout 回调里，白留一次失败与一条误导日志）。
      try { discardOverloadRetry('session_closed'); } catch (e) { log.warn('cancel overload retry threw', { error: String(e) }); }
      await releaseCurrentThreadSubscription('session close subscription release', {
        retireHostOnFailure: opts.retireHostOnCleanupFailure ?? true,
      });
      try { eventQueue.end(); } catch (e) { log.warn('eventQueue.end threw', { error: String(e) }); }
    }
    // ── AgentSessionHandle ──────────────────────────────────────────────────
    const requestUserInterrupt = (turnId: string) => {
      let cancelTools: (() => void) | undefined;
      try {
        if (sid && opts.sessionInstanceId) {
          cancelTools = this.deps.prepareCodexMcpToolCancellation?.({
            sessionId: sid, sessionInstanceId: opts.sessionInstanceId, threadId,
          });
        }
      } catch { log.warn('Could not capture Codex MCP calls for user stop'); }
      return host.request(Method.TurnInterrupt, { threadId, turnId }).then(result => {
        // The ACK is a definite stop signal. Do not wait for tool completion or retry.
        try { cancelTools?.(); } catch { log.warn('Could not cancel Codex MCP calls after user stop'); }
        return result;
      });
    };

    const handle: AgentSessionHandle = {
      disabledSkillPaths: disabledSkillSnapshot,
      getAutoReviewOwner: () => currentApprovalConfig().approvalsReviewer === 'auto_review' ? 'native' : 'cindy',
      reviewAutoPermissionAction: async (action) => {
        const decision = await reviewAutoAction(action);
        if (decision.unavailable) autoReviewUnavailableNotice.notify(decision.reason);
        return decision;
      },
      get id() { return sdkSessionId ?? '<pending>'; },
      agentKind: 'codex',
      get model() { return mutableModel; },
      get codexProxyActive() { return hostUsesCodexProxy; },
      get codexHostKey() { return currentHostKey; },
      get codexThreadModelProviderId() { return codexThreadModelProviderId; },
      get codexThreadMayHaveRollout() { return threadMayHaveRollout; },
      get codexCindyRemoteCompactionCompatible() {
        return cindyProviderRemoteCompactionCompatible;
      },
      get codexProductPromptDelivery() { return codexProductPromptDelivery; },

      validateSendOptions(sendOpts: SendOptions) {
        if (sendOpts.toolsDisabled && (!host.isCodexProxyActive() || !textOnlyPolicyCleanups.has(threadId))) {
          throw new Error('Host text-only turns require an active Codex request policy proxy.');
        }
        if (
          sendOpts.turnPermissionPolicy &&
          mutablePermissionMode === 'bypassPermissions' &&
          // Internal continuations belong to the turn the owner just took over.
          // New externally supplied policy turns still undergo normal admission.
          !(sendOpts as CodexInternalSendOptions)[CODEX_INTERNAL_CONTINUATION] &&
          !(sendOpts as CodexInternalSendOptions)[CODEX_INTERACTION_CONTINUATION]
        ) {
          throw new TurnPermissionPolicyUnsupportedError(
            'codex',
            mutablePermissionMode,
          );
        }
      },

      async send(message: UserMessage, sendOpts?: SendOptions) {
        if (rejectClosedOrCancelledSend(sendOpts, 'before start')) {
          return;
        }
        const internalOpts = sendOpts as CodexInternalSendOptions | undefined;
        const yieldAttempt = internalOpts?.[CODEX_YIELD_CONTINUATION];
        const isContinuation = internalOpts?.[CODEX_INTERNAL_CONTINUATION] === true
          || internalOpts?.[CODEX_INTERACTION_CONTINUATION] === true;
        const nextToolsDisabled = isContinuation ? activeToolsDisabled : sendOpts?.toolsDisabled === true;
        if (handle.isTurnRunning?.() && activeToolsDisabled !== nextToolsDisabled) {
          throw new Error('Cannot change the tool policy while a Codex turn is active.');
        }
        if (yieldAttempt == null && internalOpts?.[CODEX_INTERNAL_CONTINUATION] !== true) {
          cancelActiveYieldContinuation('new send');
          yieldContinuationProductFailed = false;
        }
        // 用户开启新 turn = 旧重连序列作废；deadline 不得跨 turn 误伤新请求。
        clearReconnectStall();
        if (sendOpts) handle.validateSendOptions?.(sendOpts);
        activeTurnPermissionPolicy = sendOpts?.turnPermissionPolicy ?? null;
        activeToolsDisabled = nextToolsDisabled;
        const capabilitySelectionText =
          (sendOpts as CodexInternalSendOptions | undefined)?.[
            CODEX_INHERITED_CAPABILITY_SELECTION
          ] ?? sendOpts?.[INHERITED_CAPABILITY_SELECTION] ?? userMessageText(message.content);
        assertCurrentHost('turn/start');
        resubscribeAfterTransportErrorIfNeeded();
        // 新 turn 总是携带当前 (可能已收紧的) 策略, 上一轮残留的延迟中断标记
        // 不得误伤本 turn (典型: 上次 turn/start 终失败, 标记未被 id 到达点消费)。
        pendingTightenInterrupt = false;
        pendingWritableRootRevocationInterrupt = false;
        // 上一 send 周期的墓碑一并清空 (仅用于拦本周期内抢跑的终态)。
        turnsCompletedBeforeStartResp.clear();
        // 用户发新消息 = 上一轮的过载重投彻底作废(它要重投的是旧消息)。
        // 这里也是**唯一**重置重投预算的地方，见 turnStarted 的说明。
        discardOverloadRetry('new send');
        // 压缩风暴计数按用户消息归零: 每条消息都重新获得一次完整的判定机会, 熔断
        // 过一次不会让后续消息一压就断; 反过来病因没解决时也只要几轮就会再次熔断。
        compactionStormTracker.reset();
        // 产出记账不需要按 send 归零: 它按 turn id 存, 新一轮读的是新 turn 的账。
        // 早先的标量要在这里清, 是因为"新 turn 的响应 / 容量错误先于它的 turnStarted
        // 到达"时会读到上一个 turn 的状态(review #844 codex P1); 按 id 记账后这类乱序
        // 不再影响判定, 也不会再被别的 turn(含被 Stop 的旧 send 的孤儿)污染。
        const mySendGen = ++sendGeneration;
        isTurnStartPending = true;
        if (!isContinuation) translatorRt.tokenSpeed.reset();
        usageTracker.beginTurn();
        log.debug('send ▶ user message', {
          model: mutableModel,
          effort: mutableEffort,
          permissionMode: mutablePermissionMode,
          serviceTier: serviceTierState.value ?? null,
          threadId,
          logTitle: sendOpts?.logTitle,
        });
        // turn-start status: 抽样 recurring + one-shot 引导 (含阶梯 pity 保底)。
        // 命中 one-shot 时推进展示次数, 并清 pity 计数让下一档保底独立累计。
        const turnStartPick = pickTurnStartStatus(sendOpts?.userName, oneShotTipState);
        if (turnStartPick.oneShotId) {
          const id = turnStartPick.oneShotId;
          oneShotTipState.displayed.set(id, (oneShotTipState.displayed.get(id) ?? 0) + 1);
          oneShotTipState.pity.delete(id);
        }
        lastStatusText = turnStartPick.text;
        lastUsageRefreshAt = Date.now();
        eventQueue.push({
          type: 'status',
          data: {
            status: turnStartPick.text,
            ...liveUsageSnapshot(),
            isRunning: true,
          },
          source: 'codex',
        });

        // Phase 3: 把 mutable 配置每 turn 透传 — server 接受 per-turn 覆盖。
        // **关键**: 无引用目录时用 sandboxPolicy: SandboxPolicy；有引用目录时继承
        // thread/start / thread/resume 已激活的 named permissions profile。profile
        // selector 不能在 turn/start 重复发送，见 ensureWorkspacePermissionProfileForNextTurn。
        // effort 同理: 协议层只能在 turn/start 透传 (v2.rs:5800), thread/start 不接;
        // 用户在 session 创建时选的 effort 也是靠 first turn/start 这里传过去才生效。
        let turnWorkspaceConfig: ReturnType<typeof currentTurnWorkspaceConfig>;
        let turnThreadWorkspaceConfig: ReturnType<typeof currentThreadWorkspaceConfig>;
        let turnThreadProfileFingerprint: string | null;
        try {
          const contextRefresh = ensureContextLimitForNextTurn(sendOpts?.signal);
          if (contextRefresh) await contextRefresh;
          const profileRefresh = ensureWorkspacePermissionProfileForNextTurn(sendOpts?.signal);
          if (profileRefresh) await profileRefresh;
          const environmentRepair = repairHostedEnvironmentIfDisconnected();
          if (environmentRepair) await environmentRepair;
          turnWorkspaceConfig = currentTurnWorkspaceConfig();
          // A stale-daemon retry must hydrate the exact thread-level profile
          // that matches this turn, not mutable settings changed while the
          // original turn/start RPC was pending.
          turnThreadWorkspaceConfig = currentThreadWorkspaceConfig();
          turnThreadProfileFingerprint = currentWorkspacePermissionProfileFingerprint();
        } catch (e) {
          isTurnStartPending = false;
          endPlanCycleAfterPreStartFailure('workspace permission profile refresh failed');
          flushDeferredTerminalTurnCompletionsIfIdle();
          rejectIfCancelled(sendOpts, 'send');
          const message = `Failed to restore Codex workspace permissions: ${String(e)}`;
          log.error('workspace permission profile refresh failed', { error: String(e), threadId });
          // Yield continuation owns its product terminal. Emitting here would
          // duplicate the later yield-continuation-start-failed events.
          if (yieldAttempt == null && !internalOpts?.[CODEX_INTERACTION_CONTINUATION]) {
            eventQueue.push({
              type: 'error',
              data: { message, isTerminal: true },
              source: 'codex',
            });
            eventQueue.push({
              type: 'status',
              data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
              source: 'codex',
            });
          }
          if (sendOpts?.throwOnStartFailure) throw new Error(message);
          return;
        }
        const { approvalPolicy, approvalsReviewer } = turnWorkspaceConfig;
        // 记录本 turn 是否由无人值守策略发射。普通降级路由显式使用 user reviewer,
        // 与 Ask 权限等价；policy turn 则以 untrusted + read-only 发射，并由 host
        // 自动接受非强制回调，仍属于无人值守执行。
        turnLaunchedUnattended =
          approvalPolicy === 'never' ||
          approvalsReviewer === 'auto_review' ||
          (activeTurnPermissionPolicy !== null && mutablePermissionMode === 'auto');
        if (!turnLaunchedUnattended) {
          pendingTightenInterrupt = false;
        }
        let turnInput: TurnStartParams['input'];
        try {
          turnInput = await toTurnInput(
            withLibraryNativeReadContext(message.content, mutableLibraryRoot, mutableExtraDirs),
            sendOpts?.[PINNED_SKILL_INVOCATION],
          );
        } catch (e) {
          isTurnStartPending = false;
          flushDeferredTerminalTurnCompletionsIfIdle();
          throw e;
        }
        if (rejectClosedOrCancelledSend(sendOpts, 'after input preparation')) {
          isTurnStartPending = false;
          abandonBufferedTurns('send cancelled after input preparation');
          flushDeferredTerminalTurnCompletionsIfIdle();
          return;
        }
        const autoReviewIntent = (sendOpts as CodexInternalSendOptions | undefined)?.[
          CODEX_AUTO_REVIEW_INTENT
        ];
        // A detached answer is applied immediately, including revocations while waiting
        // for a yielded tool. Reusing that exact snapshot is not a second user input.
        // Intervening input or a different authority still requires a fresh transition.
        if (
          autoReviewIntent !== currentAutoReviewIntent
          || JSON.stringify(currentAutoReviewAuthority ?? null) !== JSON.stringify(autoReviewContext() ?? null)
        ) {
          setAutoReviewIntent(autoReviewIntent ?? appendAutoReviewUserIntent(priorAutoReviewIntent(), message.content, sendOpts), { authority: autoReviewContext() });
        }
        assertCurrentHost('turn/start');
        // 本条消息的计划意图:sendOpts.planMode 是点击发送瞬间的快照(排队行透传),
        // 权威于 agent 当前武装态;undefined 走旧语义(消耗武装态)。一次性语义:
        // 消耗时 emit plan_mode_changed 让 UI 勾选熄灭;显式 false(排队普通消息后
        // 用户重新勾选)不消耗武装态。修订 turn 由 runPlanReviewFlow 内部 send
        // (无 planMode 快照), planCycleActive 仍在 → 继续携带 plan。
        const explicitNormalTurn = sendOpts?.planMode === false;
        const requestedPlanTurn = sendOpts?.planMode ?? mutablePlanMode;
        const continuePlanCycleThisTurn = planCycleActive && !explicitNormalTurn;
        if (requestedPlanTurn) {
          planCycleActive = true;
          if (mutablePlanMode && sendOpts?.planMode !== false) {
            mutablePlanMode = false;
            eventQueue.push({ type: 'plan_mode_changed', data: { enabled: false }, source: 'codex' });
          }
        }
        // sticky 语义要求进过 plan 的线程后续持续复位, 见 collaborationModeForTurn。
        const collaborationMode = collaborationModeForTurn(requestedPlanTurn, continuePlanCycleThisTurn);
        const turnStartsInPlanMode = collaborationMode?.mode === 'plan';
        const turnParams: TurnStartParams = {
          threadId,
          input: turnInput,
          ...turnWorkspaceConfig,
          effort: clampEffortForCodex(mutableModel, mutableEffort),
          // 强制 reasoning summary='auto' — 不依赖用户 ~/.codex/config.toml 写没写
          // model_reasoning_summary, 让 thinking 文本在所有用户机器上一致流式出。
          // (v2.rs:5801-5803 turn/start 的 summary 会 override server config)
          summary: 'auto',
          ...(mutableModel && mutableModel !== 'gpt-5' ? { model: mutableModel } : {}),
          ...(serviceTierState.value !== undefined ? { serviceTier: serviceTierState.value } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
        };
        // 这一 turn 的用量按这里发出去的 (provider, model) 归属上下文窗口 —— 之后 setModel
        // 立即改这两个值也不会串到还在产出的本 turn (见 activeTurnModel / capContextWindow)。
        activeTurnModel = mutableCatalogModel;
        activeTurnContextLimit = effectiveThreadContextWindow(appliedContextLimit);
        activeTurnCompactionPct = currentCompactionPct() ?? 90;
        activeTurnProviderId = mutableProviderId;
        const markTurnConfigAccepted = (): void => {
          threadMayHaveRollout = true;
          if (turnParams.collaborationMode?.mode === 'plan') {
            threadTouchedPlanMode = true;
            planModeDefaultMarkerNeeded = true;
            return;
          }
          if (turnParams.collaborationMode?.mode === 'default') {
            threadTouchedPlanMode = true;
            if (turnParams.collaborationMode.settings.developer_instructions === null) {
              planModeDefaultMarkerNeeded = false;
            }
          }
        };
        // A sandboxPolicy overrides the thread-local profile. Invalidate before
        // the request crosses the acceptance boundary: the peer can accept the
        // turn even if the local transport loses the response.
        if ('sandboxPolicy' in turnWorkspaceConfig) {
          workspacePermissionProfileActive = false;
          workspacePermissionProfileFingerprint = null;
        }
        // After turn/start is attempted, resume before ever replacing this
        // thread. Only an explicit "no rollout found" proves it stayed unused.
        threadMayHaveRollout = true;
        pendingTurnStartPlanMode = turnStartsInPlanMode;
        // turn/start 失败若是 "thread not found" — 通常 daemon 重启 (sync auth /
        // OOM / 服务器 reboot / 我们主动 pkill) 导致 in-memory thread state 丢失,
        // 但 disk rollout 还在。自动 thread/resume hydrate 回 daemon 然后重 turn/start,
        // 用户体验:透明续聊, 不感知 daemon 重启过。
        //
        // 只动 error path, happy path 完全不变 (规则 19: 不影响 cache hit /
        // 性能 / 准确性 4 指标)。重试只发生在 "thread not found" 字符串匹配时,
        // 普通 LLM 错误 / 超时 / auth 失败照原路径报错。
        const handleTurnStartResp = (resp: TurnStartResponse, ownerSeq: number): void => {
          if (resp.turn?.id) {
            const startEntry = inFlightStarts.get(ownerSeq);
            const pendingAutomaticRecovery = overloadRetry?.pendingAutomaticRecovery;
            if (
              startEntry
              && pendingAutomaticRecovery?.deadTurnId === resp.turn.id
              && startEntry.sendGen === overloadRetry?.sendGen
            ) {
              // completed 已经把该 turn 记为终态，下面不会重新激活；这里仅补权威
              // 归属，供 start finally flush completed 后的一次 HTTP 重投校验。
              turnOriginByTurnId.set(resp.turn.id, {
                startSeq: ownerSeq,
                sendGen: startEntry.sendGen,
                startedAtMs: startEntry.startedAtMs,
                ...(startEntry.model ? { model: startEntry.model } : {}),
                ...(startEntry.serviceTier !== undefined ? { serviceTier: startEntry.serviceTier } : {}),
              });
            }
            // 缓冲的歧义 started 对账 (codex R9 P2): 本响应确立在飞 RPC 的
            // turnId — 缓冲里 id 一致的是它的合法 started (下方正常激活),
            // 不一致的是失败 RPC 的孤儿 (interrupt + 墓碑, 没人消费)。
            //
            // 但"不是我的"只有在**没有别的 start 在飞**时才等于"是孤儿": Stop 会武装孤儿
            // 守卫, 于是下一轮 send 的 turnStarted 同样先进这个**会话级共享**的缓冲集; 被
            // Stop 的旧 RPC 若是 resolve(而不是 reject)回来, 它照样走到这里, 把新一轮那条
            // 合法 started 当孤儿坐实 —— 墓碑 + interrupt 之后新一轮的响应拒绝激活, 那一轮
            // 永久卡 generating(review #844 codex P1, 与隔离路径同源)。
            //
            // 非唯一权威时只做能确定的那一半: 把自己的 id 从缓冲里摘掉(否则 stale 闸会继续
            // 忽略它已激活 turn 的事件), 其余留给仍在飞的那些 start 去对账。
            if (bufferedOrphanTurnIds.size > 0) {
              const wasBuffered = bufferedOrphanTurnIds.has(resp.turn.id);
              const soleAuthority = !hasOtherInFlightStart(ownerSeq);
              if (!soleAuthority) {
                bufferedOrphanTurnIds.delete(resp.turn.id);
                log.debug('turn/start response is not the sole reconciler — leaving other buffered turns', {
                  acceptedTurnId: resp.turn.id,
                  remaining: [...bufferedOrphanTurnIds],
                  threadId,
                });
              }
              for (const bufferedId of soleAuthority ? bufferedOrphanTurnIds : []) {
                if (bufferedId === resp.turn.id) continue;
                terminalErroredTurnIds.add(bufferedId);
                // 孤儿的事件队列整队丢弃 (greptile R11 P1) — 任何事件都不得
                // 渲染到 / 收口本次 send; 挂起的审批/输入请求按拒绝释放
                // (codex R12 P1)。
                bufferedTurnEventQueues.delete(bufferedId);
                settleBufferedTurnReconcile(bufferedId, false);
                log.warn('buffered turnStarted proven orphan by turn/start response — interrupting', {
                  turnId: bufferedId,
                  acceptedTurnId: resp.turn.id,
                  threadId,
                });
                if (threadId) {
                  host.request(Method.TurnInterrupt, { threadId, turnId: bufferedId }).catch((e2: unknown) => {
                    log.warn('buffered orphan turn interrupt failed (best-effort)', {
                      turnId: bufferedId,
                      error: e2 instanceof Error ? e2.message : String(e2),
                    });
                  });
                }
              }
              if (soleAuthority) bufferedOrphanTurnIds.clear();
              if (wasBuffered) {
                // 合法 started 曾被缓冲: 补做 turnStarted 正常路径被跳过的
                // per-turn 状态重置 (与 turnStarted handler 同款)。
                proposedPlanText = null;
                translatorRt.lastAuthErrorKey = null;
                translatorRt.networkRetryNotice = null;
                turnRetryTracker.reset();
              }
            }
            // turn/start 成功后孤儿守卫**保持**, 不解除 (codex R14 P1): 失败
            // RPC 的孤儿证据 (turnStarted/error/completed) 可能任意晚才到 —
            // 解除后迟到的孤儿 started 在 currentTurnId===null 窗口会被正常
            // 激活成假 running (会话永久卡)。守卫保持下: 未知 id 的迟到
            // started 按孤儿墓碑 + interrupt; 合法 turn 的 started 由
            // currentTurnId 匹配 (重复 started 幂等) 或 buffered 对账放行,
            // 不受影响。守卫在 RPC 失败路径 (4413) 已把在飞 buffer 坐实孤儿,
            // 语义依然自洽。
            // 墓碑: 该 turn 的终态已抢在本响应之前到达 (典型: 收紧补中断后
            // turnCompleted(interrupted) 先回), 不得重新置活, 否则会话卡 running。
            const alreadyCompleted = turnsCompletedBeforeStartResp.has(resp.turn.id);
            // The app-server's response is the first authoritative proof of the
            // tier it accepted.  Calibrate the per-turn origin before replaying
            // any notifications that arrived while turn/start was in flight;
            // otherwise a buffered tokenUsageUpdated can be priced with the
            // requested Fast tier even when the server downgraded the turn.
            if (Object.hasOwn(resp, 'serviceTier')) {
              const acceptedServiceTier = normalizeServiceTier(resp.serviceTier) ?? null;
              const startEntry = inFlightStarts.get(ownerSeq);
              if (startEntry) startEntry.serviceTier = acceptedServiceTier;
              const origin = turnOriginByTurnId.get(resp.turn.id);
              if (origin) origin.serviceTier = acceptedServiceTier;
              serviceTierState.value = acceptedServiceTier;
              log.debug('turn/start response serviceTier', {
                turnId: resp.turn.id,
                serviceTier: serviceTierState.value,
                fastMode: fastModeFromServiceTier(serviceTierState.value),
                note: 'serviceTier calibrated before buffered turn replay',
              });
            }
            // 强退守卫 (Greptile P1 on #1720): hostForcedRetire 已把本会话终态收口
            // (eventQueue.end), 迟到的 turn/start 成功响应不得重新激活。正常流程里
            // client.close() 会 reject 挂起 RPC 且 quarantine 已在 adoptUnidentifiedDeadTurn
            // 落墓碑, 这里再显式挡一道, 不依赖那些间接语义 —— 否则 currentTurnId /
            // isTurnInFlight 复活后事件队列已 end, 上层 busy 永久卡死。
            if (!alreadyCompleted && !terminalErroredTurnIds.has(resp.turn.id) && !sessionHostForceRetired) {
              // The app-server has now acknowledged which turn owns this
              // input. Bind explicit source selection before buffered tool
              // requests are released, and never on a pre-accept failure.
              bindRootCapabilitySelection(
                resp.turn.id,
                capabilitySelectionText,
              );
              // 权威归属: 这个 turn 由本次 start 生出, 属于本轮 send。
              const turnModel = startEntry?.model ?? activeTurnModel;
              const turnServiceTier = startEntry?.serviceTier !== undefined
                ? startEntry.serviceTier
                : turnOriginByTurnId.get(resp.turn.id)?.serviceTier;
              turnOriginByTurnId.set(resp.turn.id, {
                startSeq: ownerSeq,
                sendGen: mySendGen,
                startedAtMs:
                  startEntry?.startedAtMs
                  ?? turnOriginByTurnId.get(resp.turn.id)?.startedAtMs
                  ?? Date.now(),
                ...(turnModel ? { model: turnModel } : {}),
                ...(turnServiceTier !== undefined ? { serviceTier: turnServiceTier } : {}),
              });
              activateRootTurn(resp.turn.id);
              currentTurnPlanModeActive = turnStartsInPlanMode;
              pendingTurnStartPlanMode = null;
              startRolloutPlanFallback(resp.turn.id);
              // 合法 buffered turn 激活成功: 挂起的审批/输入请求放行 (走正常
              // UI 流程), 再按到达序重放缓存事件 (greptile R11 P1 +
              // codex R12 P1): 早期 item/usage 不再永久丢失; 队列里若有终态
              // (turn 在缓冲期间已结束), 重放自然收口 send — 不会把尸体 turn
              // 挂成 in-flight 永久卡 generating。重放闭包重进 handler 时
              // buffer 已清空 + currentTurnId 已置, 全部走正常路径。
              settleBufferedTurnReconcile(resp.turn.id, true);
              const replayQueue = bufferedTurnEventQueues.get(resp.turn.id);
              if (replayQueue) {
                bufferedTurnEventQueues.delete(resp.turn.id);
                log.debug('replaying buffered events for accepted turn', {
                  turnId: resp.turn.id,
                  eventCount: replayQueue.length,
                });
                for (const replay of replayQueue) replay();
              }
              // Any claim not consumed by a replayed spawn item is stale residue from a
              // malformed/duplicate queue entry; clear it without touching committed routes.
              discardPendingSpawnLineage(resp.turn.id);
            } else {
              // 未激活 (墓碑): 队列丢弃, 挂起请求按拒绝释放 — 不得穿透。
              bufferedTurnEventQueues.delete(resp.turn.id);
              settleBufferedTurnReconcile(resp.turn.id, false);
            }
            // turn/start 在飞期间权限档或可写根被收紧 → 本 turn 携带的还是旧宽松策略,
            // 拿到 id 立即补中断 (fire-and-forget, 失败仅 warn); turn 已终结则
            // 收紧目的已达成, 消费标记即可, 不再发无意义的 interrupt。
            if (pendingTightenInterrupt || pendingWritableRootRevocationInterrupt) {
              pendingTightenInterrupt = false;
              pendingWritableRootRevocationInterrupt = false;
              if (!alreadyCompleted) void interruptTurnForPermissionTighten(resp.turn.id);
            }
          }
        };
        // 登记本轮的过载重投器。闭包持有 turnParams 与本轮的响应处理逻辑，因此
        // 重投投递的是同一条用户消息、同一套策略，不受期间 mutable 配置变化影响。
        //
        // 刻意**不**复用 happy path 的整段 send 逻辑：`usageTracker.beginTurn()`、
        // turn-start status 抽样、planMode 武装态消耗都是"用户发了一条消息"的
        // 一次性副作用，重投是同一条消息的再次投递，重跑那些会让用量统计与
        // 计划模式状态错乱。
        let continueNativeHistory = false;
        overloadRetry = {
          attempt: 0,
          automaticRecoveryAttempted: false,
          pendingAutomaticRecovery: null,
          timer: null,
          inFlight: false,
          isCancelled: () => sendOpts?.signal?.aborted === true,
          launchedPermissionMode: mutablePermissionMode,
          ...(turnParams.serviceTier !== undefined ? { serviceTier: turnParams.serviceTier } : {}),
          sendGen: mySendGen,
          deferredCapacityFailure: null,
          disposeSignalWatch: null,
          retry: async (continueHistory = false) => {
            continueNativeHistory ||= continueHistory;
            const state = overloadRetry;
            // 发出前复检：本轮 send 的取消信号在退避等待期间才 abort（coordinator
            // 撤单、上层超时）时不走 handle.abort()，计时器到点仍会把一条已被取消
            // 的消息重新投出去。
            if (closed || !state || state.isCancelled()) {
              log.info('codex overload retry skipped (send already cancelled)', { threadId });
              if (state) settleCancelledOverloadRetry(state, 'cancelled before retry send');
              return;
            }
            assertCurrentHost('turn/start overload retry');
            resubscribeAfterTransportErrorIfNeeded();
            // RPC 在途也算忙（见 isTurnRunning 注释）：计时器已清、turn 未激活的
            // 这段窗口若报 idle，并发 send 会把原消息挤掉。
            state.inFlight = true;
            const retryStartSeq = beginTurnStart(
              state.sendGen,
              capabilitySelectionText,
              state.serviceTier,
            );
            // RPC 是否走完了成功路径。补排延后的容量失败**只能**在成功路径上做:
            // finally 先于外层 state.retry().catch 执行, 若 RPC 已经 reject 却在这里
            // 排上新计时器, 紧随其后的 catch 会推终态 error + Done 收口 UI, 而那个
            // 计时器没人取消 —— 会话已收口, 原消息却在稍后被静默重投并真的执行工具
            // 副作用(review #844 codex P1)。失败路径统一由外层 catch 报终态。
            let rpcSettledOk = false;
            try {
              // 必须带超时：AppServerHost.request 默认不超时，daemon / 远端传输
              // 卡住时这个 RPC 会永久在飞，而 inFlight 被算作忙 → 会话永久卡死
              // 且无人可解（review #844 codex P1）。与正常 turn/start 同款边界。
              const resp = await host.request<TurnStartResponse>(Method.TurnStart,
                { ...turnParams, threadId, ...(continueNativeHistory ? { input: [] } : {}) }, {
                ...criticalThreadRpcOptions(),
              });
              // **发出后再复检**：RPC 在途期间 Stop / close / 撤单都拦不住它——
              // 计时器早已清空，cancelOverloadRetry 无从取消；abort() 又因为
              // currentTurnId 仍是 null 而直接返回。此时若照常激活，一个已被用户
              // 撤销的 turn 会真的跑起来并执行命令、改文件。
              // server 侧 turn 已经启动，所以不能只是丢掉响应：落墓碑挡住它的后续
              // 事件，并 best-effort interrupt 把它停掉（与上方孤儿 turn 同款处理）。
              const cancelledMidFlight =
                closed || state.isCancelled() || overloadRetry !== state;
              if (cancelledMidFlight) {
                const staleTurnId = resp.turn?.id;
                log.warn('codex overload retry cancelled while turn/start was in flight', {
                  threadId,
                  turnId: staleTurnId ?? null,
                  closed,
                  aborted: sendOpts?.signal?.aborted ?? false,
                });
                if (staleTurnId) {
                  terminalErroredTurnIds.add(staleTurnId);
                  if (threadId) {
                    host
                      .request(Method.TurnInterrupt, { threadId, turnId: staleTurnId })
                      .catch((e: unknown) => {
                        log.warn('cancelled overload retry interrupt failed (best-effort)', {
                          turnId: staleTurnId,
                          error: e instanceof Error ? e.message : String(e),
                        });
                      });
                  }
                }
                // server 侧 turn 已挡掉, 但逻辑 turn 还得有人收口(同上)。
                settleCancelledOverloadRetry(state, 'cancelled while turn/start was in flight');
                return;
              }
              markTurnConfigAccepted();
              adoptUnidentifiedDeadTurn(resp, retryStartSeq);
              handleTurnStartResp(resp, retryStartSeq);
              rpcSettledOk = true;
            } finally {
              state.inFlight = false;
              if (!rpcSettledOk && overloadRetry === state) {
                state.pendingAutomaticRecovery = null;
              }
              // 注销本次请求(isTurnStartPending 由登记表重算, 不会误清别的请求的状态)。
              endTurnStart(retryStartSeq);
              flushDeferredTerminalTurnCompletionsIfIdle();
              // 在途期间又撞容量、当时被延后的那条失败在这里收尾。只有新 turn 确实
              // 没能激活时才补排（它被落了墓碑、响应因此拒绝激活）；turn 活了就说明
              // 那条错误针对的是别的 turn，不该重排。预算耗尽时必须自己推终态，
              // 否则逻辑 send 永久悬空。
              // 同上: 延后的失败若属于另一轮仍活着的 send, 与本次 RPC 成败无关。
              rescheduleDeferredCapacityFailure(
                overloadRetry ?? state,
                overloadRetry === state ? rpcSettledOk : true,
              );
            }
          },
        };
        // 退避窗口里的取消要**立刻**收口, 不能等计时器到点。isCancelled() 是轮询式的,
        // 只在 retry() 里被读到; 只 abort signal(不走 handle.abort())时, 会话会在剩余
        // 退避里继续 isTurnRunning()===true —— 最多 30s 内后续排队消息全被挡住, 上层
        // 派发闩也不释放(review #844 greptile P1)。
        const armedRetryState = overloadRetry;
        const sendSignal = sendOpts?.signal;
        if (armedRetryState && sendSignal) {
          const onSendAbort = (): void => {
            if (overloadRetry !== armedRetryState) return;
            // 两类要收口的状态:
            //  1. 重投还会发生(退避等待 / RPC 在途 / 失败已延后等补排);
            //  2. 重投已经把一个 turn 跑起来了(计时器已消费、inFlight 已清、
            //     currentTurnId 已置)。这时若直接 return, 取消既不落墓碑也不
            //     interrupt, 那个 turn 会继续执行命令与文件改动
            //     (review #844 greptile P1)。
            // 判据用 attempt > 0 限定在"本轮确实被重投接管过"上: 没发生过重投的
            // 普通 send 里 signal 仍只是**受理前**的取消边界, 语义不变。
            const retryOwnsActiveTurn =
              (armedRetryState.attempt > 0 || armedRetryState.automaticRecoveryAttempted)
              && (currentTurnId !== null || isTurnInFlight);
            if (!overloadRetryPending(armedRetryState) && !retryOwnsActiveTurn) return;
            cancelOverloadRetry('send signal aborted');
            settleCancelledOverloadRetry(armedRetryState, 'send signal aborted');
          };
          sendSignal.addEventListener('abort', onSendAbort, { once: true });
          armedRetryState.disposeSignalWatch = () => {
            sendSignal.removeEventListener('abort', onSendAbort);
          };
        }
        let finalErr: unknown = null;
        // 初始 RPC 在飞期间到达的空 id 容量拒绝只会被"延后"(不排计时器), 由下面的
        // finally 在响应处理完之后补排 —— 保证任一时刻只有一个 turn/start 在飞。
        const initialStartSeq = beginTurnStart(
          mySendGen,
          capabilitySelectionText,
          turnParams.serviceTier,
        );
        let initialStartSettledOk = false;
        /** 本次请求是否已被 Stop / 撤单收口过(条目会在 finally 里删掉, 所以先取出来)。 */
        let initialStartSettledByCancel = false;
        try {
          const resp = await host.request<TurnStartResponse>(Method.TurnStart, turnParams, {
            ...criticalThreadRpcOptions(),
          });
          markTurnConfigAccepted();
          adoptUnidentifiedDeadTurn(resp, initialStartSeq);
          // yield continuation 带 throwOnStartFailure + AbortSignal: 取消检查会
          // 抛, 不能把墓碑/interrupt 写在 return 后面。先隔离已被 server 接受
          // 的 turn, 再让取消检查抛/返回, 迟到的 turnStarted 才会撞墓碑。
          isolateCancelledTurnStart(resp, sendOpts, 'after turn/start');
          if (rejectClosedOrCancelledSend(sendOpts, 'after turn/start')) {
            return;
          }
          handleTurnStartResp(resp, initialStartSeq);
          initialStartSettledOk = true;
        } catch (e) {
          if (isLocalAcceptBoundaryError(e)) {
            throw e;
          }
          if (/thread not found/i.test(String(e))) {
            log.info('turn/start hit "thread not found" — daemon likely restarted, attempting thread/resume + retry', {
              threadId,
            });
            try {
              // **必须先重 subscribe**: daemon 重启会触发 transport error →
              // host.shutdown() 清空 this.subscribers Map (host.ts:373), 原 subscription
              // 失效。如果不重 subscribe, thread/resume + turn/start retry RPC 都会成功,
              // 但 daemon 推回的 turnStarted / agentMessage / 任何 notification routing
              // 找不到 handler 全部 silent drop, UI 永远转圈 (currentTurnId 从未被 set,
              // isTurnInFlight 永远 false, token 流也没人消费)。
              // 用同一个 handlers 对象 re-subscribe (host.subscribers.set 覆盖语义),
              // 保存当前订阅句柄，确保重建后的关闭路径仍会释放原生线程。
              assertCurrentHost('thread/resume retry subscribe');
              subscription = host.subscribeThread(threadId, handlers);
              const resumeModel = mutableModel;
              const resumeServiceTierGeneration = serviceTierMutationGeneration;
              const resumeParams: ThreadResumeParams = {
                threadId,
                ...(resumeExcludeTurnsSupported ? { excludeTurns: true } : {}),
                cwd: opts.workingDir,
                ...turnThreadWorkspaceConfig,
                ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
                ...(resumeModel && resumeModel !== 'gpt-5' ? { model: resumeModel } : {}),
                ...(serviceTierState.value !== undefined ? { serviceTier: serviceTierState.value } : {}),
                ...(developerInstructions && !useProxyChannel ? { developerInstructions } : {}),
              };
              const resumeResp = await host.request<ThreadResumeResponse>(Method.ThreadResume, resumeParams, {
                ...criticalThreadRpcOptions(),
              });
              if (mutableModel === resumeModel && resumeModel === 'gpt-5' && resumeResp.model) {
                mutableModel = resumeResp.model;
                // 与 thread/start 的哨兵解析同理:'gpt-5' 是占位、不是目录条目, 解析出的真实
                // id 才能用来查窗口上限。漏掉这行会让恢复后的 turn 一直按 'gpt-5' 去查(查不到
                // → 不收敛), 这也是本文件第三处哨兵解析, 三处必须一致。
                mutableCatalogModel = resumeResp.model;
              }
              if (
                Object.hasOwn(resumeResp, 'serviceTier') &&
                resumeServiceTierGeneration === serviceTierMutationGeneration
              ) {
                serviceTierState.value = normalizeServiceTier(resumeResp.serviceTier) ?? null;
              } else if (resumeServiceTierGeneration !== serviceTierMutationGeneration) {
                void pushThreadSettings({ serviceTier: serviceTierState.value ?? null });
              }
              turnParams.effort = clampEffortForCodex(mutableModel, mutableEffort);
              if (mutableModel && mutableModel !== 'gpt-5') {
                turnParams.model = mutableModel;
              } else {
                delete turnParams.model;
              }
              // 恢复路径可能把 'gpt-5' 哨兵解析成具体路由模型 —— 重投的 turn 用的是新值,
              // 窗口归属必须跟着改写走, 否则查不到目录条目、沿用 app-server 的基础模型窗口。
              activeTurnModel = mutableCatalogModel;
              activeTurnContextLimit = effectiveThreadContextWindow(appliedContextLimit);
              activeTurnCompactionPct = currentCompactionPct() ?? 90;
              activeTurnProviderId = mutableProviderId;
              if (serviceTierState.value !== undefined) {
                turnParams.serviceTier = serviceTierState.value ?? null;
              } else {
                delete turnParams.serviceTier;
              }
              if (turnParams.collaborationMode) {
                turnParams.collaborationMode.settings.model = mutableModel;
                turnParams.collaborationMode.settings.reasoning_effort =
                  clampEffortForCodex(mutableModel, mutableEffort) ?? null;
              }
              workspacePermissionProfileActive = 'permissions' in turnThreadWorkspaceConfig;
              workspacePermissionProfileFingerprint = workspacePermissionProfileActive
                ? turnThreadProfileFingerprint
                : null;
              threadMayHaveRollout = true;
              // The stale-daemon path has crossed an explicit app-server
              // execution boundary. Reset all thread cursors before the retry;
              // every thread on the daemon shares the same process-level
              // cumulative usage source.
              resetAcceptedUsageCursors('thread/resume after stale daemon');
              if (collaborationMode?.mode === 'default') {
                planModeDefaultMarkerNeeded = true;
                if (turnParams.collaborationMode?.mode === 'default') {
                  turnParams.collaborationMode.settings.developer_instructions = null;
                }
              }
              log.info('thread/resume after stale daemon ok, retrying turn/start', { threadId });
              const resp = await host.request<TurnStartResponse>(Method.TurnStart, turnParams, {
                ...criticalThreadRpcOptions(),
              });
              markTurnConfigAccepted();
              adoptUnidentifiedDeadTurn(resp, initialStartSeq);
              isolateCancelledTurnStart(resp, sendOpts, 'after turn/start retry');
              if (rejectClosedOrCancelledSend(sendOpts, 'after turn/start retry')) {
                return;
              }
              handleTurnStartResp(resp, initialStartSeq);
              initialStartSettledOk = true;
            } catch (retryErr) {
              if (isLocalAcceptBoundaryError(retryErr)) throw retryErr;
              log.error('thread/resume + retry turn/start failed', {
                originalError: String(e),
                retryError: String(retryErr),
              });
              finalErr = retryErr;
            }
          } else {
            finalErr = e;
          }
        } finally {
          // 条目即将被删, 先把"已由取消收口"取出来供下面的 finalErr 分支判断。
          const initialStartEntry = inFlightStarts.get(initialStartSeq);
          initialStartSettledByCancel = initialStartEntry?.terminalSettled === true;
          if (
            !initialStartSettledOk
            && overloadRetry?.sendGen === mySendGen
          ) {
            overloadRetry.pendingAutomaticRecovery = null;
          }
          // 先注销本次请求(isTurnStartPending 由登记表重算) —— 无条件置 false 会在两个
          // start 并存时清掉属于**另一个**请求的状态(review #844 codex P1)。注销必须早于
          // flush: 后者按 idle 与否决定是否放行缓存的终态。
          endTurnStart(initialStartSeq);
          pendingTurnStartPlanMode = null;
          flushDeferredTerminalTurnCompletionsIfIdle();
          // 初始 RPC 已 settle → 现在才允许重投计时器排上（顺序见
          // inFlightStarts 的注释）。终失败路径 settledOk 为 false，不补排；那条由下面的
          // discardOverloadRetry + terminal error 收口。
          const armedState = overloadRetry;
          if (armedState) {
            // rpcSettledOk 的本意是"我这次 RPC 失败了, 别在推终态之外再排一个计时器"。
            // 但延后的那条失败可能属于**另一轮仍然活着的** send(它的容量错误在我还在飞时
            // 到达, 于是只被记账): 那一轮的命运与我这次 RPC 成败无关, 用我的失败去压掉它
            // 会让它既不重投也不收口(写本轮回归用例时实测到, review 未提)。
            const ownedByThisSend = armedState.sendGen === mySendGen;
            rescheduleDeferredCapacityFailure(
              armedState,
              ownedByThisSend ? initialStartSettledOk : true,
            );
          }
        }
        if (finalErr) {
          // 容量通知可能先于本次 turn/start 响应到达(协议允许的乱序), 那时重投
          // 计时器已经排上。原始请求随后终失败 → 下面会推 terminal error + Done,
          // UI 与调用方都已按失败处理; 若不把重投一起废掉, 计时器到点会重投一条
          // 已判失败的消息, 副作用在用户看不到的地方执行(review #844 codex P1)。
          // 只废弃**属于本轮**的重投状态: Stop 之后下一轮 send 可能已经装上了自己的
          // overloadRetry, 无条件 discard 会把它连同它记账的延后失败一起清掉 —— 那一轮
          // 于是既不重投也不收口(review #844 codex P1)。
          if (overloadRetry?.sendGen === mySendGen) {
            discardOverloadRetry('original turn/start failed');
          }
          // 计划模式: turn 从未启动就终失败 → 结束半开循环(与 turnCompleted 的
          // failed 分支同语义), 否则 planCycleActive 泄漏, 下一条常规消息仍会
          // 携带 collaborationMode plan(勾选与 chip 早已熄灭, 行为与 UI 脱节)。
          endPlanCycleAfterPreStartFailure('turn/start failed');
          // RPC 级失败(超时/拒绝)不代表 server 没建 turn — daemon 可能已接受
          // turn/start 只是响应没回来。立孤儿守卫: 之后迟到的 turnStarted 不得
          // 重新激活会话 (greptile P1: 已报终态错误的会话又回到 generating)。
          // turnStarted 也可能已先于响应到达并被接受 (started-before-resp 是
          // 协议允许的乱序) — 此时 currentTurnId/isTurnInFlight 已置位, 失败
          // 收口必须把这个活跃 turn 一起收掉; 缓冲的歧义 started 同样坐实成孤儿
          // (greptile R6 P1 + codex R9 P2)。细节见 helper 顶注。
          quarantineTurnsAfterStartFailure('original turn/start failed', {
            ownsSession: sendGeneration === mySendGen,
          });
          log.error('turn/start failed', { error: String(finalErr) });
          // Stop / 撤单已经为这一轮推过终态时不得再推一组: 否则取消被改报成"启动失败",
          // 且 coordinator / 活动状态 / goal 会对同一个 turn 收口两次
          // (review #844 greptile P1)。
          if (initialStartSettledByCancel) {
            log.info('turn/start failure suppressed — this send was already settled by cancel', {
              threadId,
            });
          } else if (yieldAttempt == null && !internalOpts?.[CODEX_INTERACTION_CONTINUATION]) {
            eventQueue.push({
              type: 'error',
              data: { message: `turn/start failed: ${String(finalErr)}`, isTerminal: true },
              source: 'codex',
            });
            eventQueue.push({
              type: 'status',
              data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
              source: 'codex',
            });
          }
          if (sendOpts?.throwOnStartFailure) {
            throw new Error(`Codex turn/start failed: ${String(finalErr)}`);
          }
        }
        if (rejectClosedOrCancelledSend(sendOpts, 'before resolving send')) {
          return;
        }
        flushInteractionIdleWaiters();
      },

      async steer(message: UserMessage, sendOpts?: SendOptions) {
        rejectIfCancelled(sendOpts, 'steer');
        assertCurrentHost('turn/steer');
        if (closed) {
          log.warn('steer called on closed session');
          throw new Error('No active Codex turn to steer: session is closed');
        }
        const steeredTurnId = currentTurnId;
        if (!isTurnInFlight || !steeredTurnId) {
          throw new Error('No active Codex turn to steer');
        }
        // Validate content before steering. `toTurnInput` can touch local
        // files/images; if that fails, leaving the current turn untouched is
        // better than sending a broken 插话.
        const input = await toTurnInput(message.content);
        rejectIfCancelled(sendOpts, 'steer');
        if (closed) {
          throw new Error('No active Codex turn to steer: session is closed');
        }
        if (!isTurnInFlight || currentTurnId !== steeredTurnId) {
          // Conversion can take long enough for a fast turn to finish. Do not
          // silently route a stale 插话 into a later turn; renderer keeps the
          // original queue/composer content and can retry through the normal path.
          throw new Error('No active Codex turn to steer');
        }
        // 同轮注入(2026-07-12 产品决策,与 Claude 对齐):turn/steer 把消息追加进
        // in-flight turn,不打断当前工作,模型在下一个工具调用边界消化这条输入
        // (与 Codex 官方 CLI 排队消息 "submitted after next tool call" 同语义)。
        // 需要真打断的用户自己点 Stop。挂起的审批 / user-input 不 dismiss——turn
        // 没有被打断,它们仍然有效。
        // (历史:2026-06 曾以「模型继续旧工具计划」为由改成 interrupt+follow-up,
        // 那正是注入语义的预期行为,现按统一产品决策回归注入。)
        // expectedTurnId 是 stale-client 防线:server 端 turn 已结束时会报
        // "no active turn to steer",或在当前已有另一 turn 时报告 expected/found
        // id 不匹配。后者同样是明确的 pre-accept 拒绝,需归一化为 no-active-turn,
        // 让 coordinator fallback 成普通派发,消息不丢。
        log.debug('steer ▶ inject into active turn', {
          threadId,
          turnId: steeredTurnId,
        });
        // turn/steer 的 ack 没有内建超时 (AppServerClient.request 会一直挂等);
        // app-server 卡死 / 不回包时裸 await 会让 steer promise 永久 pending,
        // coordinator 的 steering marker 随之永久残留 —— 后续所有插话点击被静默
        // 吞掉、队列 drain 冻结 (2026-06 用户反馈"插话没反应"的根因之一)。
        // 这里给 ack 加有界等待; abort (Stop / close) 复用 rejectIfCancelled
        // 同款取消文案。
        // ⚠️ turn/steer 是 content-bearing RPC(消息本体随请求送出),与旧
        // turn/interrupt(幂等控制信号)不同,超时后请求无法撤回、结果不确定
        // (review #939 P1):RPC 迟到成功时消息其实已注入当前 turn,而上层已按
        // 失败处理。超时错误 message 携带 'did not acknowledge' 特征,coordinator
        // 据此把该行保留为**暂停队列**交用户决策、不自动重派,堵住"已注入 +
        // turn 结束后队列再发一遍"的重复消费;这里同时给在飞 RPC 挂
        // late-resolution 观察,迟到结果留日志现场。
        assertCurrentHost('turn/steer');
        const capabilitySelectionText = userMessageText(message.content);
        const settleCapabilitySteer = registerPendingCapabilitySteer(
          steeredTurnId,
          capabilitySelectionText,
        );
        let steerRpc: Promise<unknown>;
        try {
          steerRpc = host.request(Method.TurnSteer, {
            threadId,
            input,
            expectedTurnId: steeredTurnId,
          });
        } catch (error) {
          settleCapabilitySteer(false);
          throw error;
        }
        let ackSettled = false;
        let capabilitySteerAccepted = false;
        try {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              cleanup();
              // post-send abort(review #939 第二轮 P2):RPC 已发出,Stop/close
              // 赢在 ack 返回前时结果同样不确定——server 仍可能迟到接受注入。
              // coordinator 的 Stop 语义已把队列置为暂停保留 / 显式清空的用户
              // 可控态,这里留 warn 现场 + 交给下方 late-resolution 观察器,
              // 文案保留 'cancelled before acceptance' 前缀(测试与日志兼容)。
              log.warn('turn/steer aborted while request in flight; delivery uncertain', {
                threadId,
                turnId: steeredTurnId,
              });
              reject(new Error('Codex steer cancelled before acceptance; delivery uncertain (request already dispatched)'));
            };
            const timer = setTimeout(() => {
              cleanup();
              reject(new Error(`Codex turn/steer did not acknowledge within ${STEER_ACK_TIMEOUT_MS}ms`));
            }, STEER_ACK_TIMEOUT_MS);
            const cleanup = () => {
              clearTimeout(timer);
              sendOpts?.signal?.removeEventListener('abort', onAbort);
            };
            if (sendOpts?.signal?.aborted) {
              onAbort();
              return;
            }
            sendOpts?.signal?.addEventListener('abort', onAbort, { once: true });
            steerRpc.then(
              () => {
                cleanup();
                resolve();
              },
              (err) => {
                cleanup();
                reject(err instanceof Error ? err : new Error(String(err)));
              },
            );
          });
          ackSettled = true;
          capabilitySteerAccepted = true;
        } catch (error) {
          if (isExpectedTurnIdMismatchError(error)) {
            // app-server 已明确拒绝该 stale expectedTurnId,消息没有注入其它 turn。
            // 标记 RPC 已 settle,避免把这类确定性拒绝误当成 timeout/abort 在飞请求。
            ackSettled = true;
            throw new Error('No active Codex turn to steer', { cause: error });
          }
          throw error;
        } finally {
          // Only an authoritative ACK may extend this turn's explicit source
          // selection. Requests emitted before that ACK wait on this entry;
          // rejection/timeout/abort releases them against the previous state.
          settleCapabilitySteer(capabilitySteerAccepted);
          if (!ackSettled) {
            // 超时 / abort 后请求仍在飞:迟到成功说明消息已注入但上层已按失败
            // 处理(队列行被暂停保留),留 warn 现场供排查;迟到失败静默吞掉,
            // 防 unhandled rejection。
            steerRpc.then(
              () => {
                // The timeout/abort already released waiting MCP requests
                // against the previous selection. A later authoritative ACK
                // must still update subsequent requests while this turn lives.
                recordAcceptedCapabilitySteer(
                  steeredTurnId,
                  capabilitySelectionText,
                );
                log.warn('turn/steer acknowledged after local timeout/abort; message may already be injected', {
                  threadId,
                  turnId: steeredTurnId,
                });
              },
              () => {},
            );
          }
        }
        // ack 成功 = server 已确认接受注入,消息已进入该 turn 的输入(即使本地
        // 已先收到 turn 终态事件,ack 与终态乱序)。这里必须按**已投递**成功返回
        // (review #939 第二轮 P1)——此前按 NO_ACTIVE_TURN 抛出会让 coordinator
        // fallback 把同一条消息再作为普通 turn 重发,模型消费两次。turn 已死时
        // "steer activeTurn 等不到终态事件"的收口责任在 coordinator 侧:它在
        // accepted 落库后自查 isTurnRunning,已终结则立即合成收口,队列不冻结。
        if (!isTurnInFlight || currentTurnId !== steeredTurnId) {
          log.info('turn/steer acknowledged after local turn end; treated as delivered', {
            threadId,
            turnId: steeredTurnId,
          });
        }
        setAutoReviewIntent(appendAutoReviewUserIntent(priorAutoReviewIntent(), message.content, sendOpts));
      },

      async requestGracefulStop(stopOpts) {
        if (!currentTurnId && interactionContinuation) {
          await handle.abort();
          return;
        }
        const retryState = overloadRetry;
        if (
          retryState &&
          overloadRetryPending(retryState) &&
          settleStoppedOverloadRetry(
            retryState,
            'graceful stop while an automatic retry was pending',
          )
        ) {
          return;
        }
        if (closed || !currentTurnId) throw new Error('No active Codex turn to stop');
        if (skipIfStaleHost('turn/interrupt')) {
          throw new Error('Codex host is stale');
        }
        const turnId = currentTurnId;
        const upstreamIdleRemainingAtStop = captureWatchdogRemainingMs(
          upstreamIdleTimer,
          upstreamIdleRemainingMs,
          upstreamIdleSliceStartedAt,
        );
        const reconnectRemainingAtStop = reconnectStallTurnId === turnId
          ? captureWatchdogRemainingMs(
              reconnectStallTimer,
              reconnectStallRemainingMs,
              reconnectStallSliceStartedAt,
            )
          : null;
        const reconnectGenerationAtStop = reconnectStallTurnGeneration;
        let watchdogActivityVersionAtStop = 0;
        let watchdogsRestored = false;
        const restoreWatchdogsIfStillRunning = (): void => {
          if (
            watchdogsRestored ||
            closed ||
            !isTurnInFlight ||
            currentTurnId !== turnId ||
            watchdogActivityVersion !== watchdogActivityVersionAtStop
          ) {
            return;
          }
          watchdogsRestored = true;
          if (upstreamIdleRemainingAtStop === null) {
            // turn/start 已受理但 started 通知尚未到达时可能尚未起表；保留原有失败兜底。
            armUpstreamIdle();
          } else {
            restoreUpstreamIdle(upstreamIdleRemainingAtStop);
          }
          if (reconnectRemainingAtStop !== null) {
            restoreReconnectStall(
              turnId,
              reconnectGenerationAtStop,
              reconnectRemainingAtStop,
            );
          }
        };
        turnInterruptOrigins.set(turnId, { source: 'user-stop' });
        dismissAllPending('turn_interrupted', 'deny');
        dismissPendingUserInputForTurn(turnId, 'turn_interrupted');
        // dismiss 会同步发布本地 interaction 投影；它不是 provider 进展，不能把刚捕获的
        // 剩余 deadline 重置为满额。先让这些本地事件收口，再统一清表并锁存活动代次。
        resetUpstreamIdleForTurnEnd();
        watchdogActivityVersionAtStop = watchdogActivityVersion;
        try {
          const interruptRequest = requestUserInterrupt(turnId);
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              cleanup();
              restoreWatchdogsIfStillRunning();
              reject(new Error('Codex graceful stop confirmation timed out'));
            };
            const cleanup = () => stopOpts?.signal?.removeEventListener('abort', onAbort);
            if (stopOpts?.signal?.aborted) {
              onAbort();
              return;
            }
            stopOpts?.signal?.addEventListener('abort', onAbort, { once: true });
            interruptRequest.then(
              () => {
                cleanup();
                resolve();
              },
              (error) => {
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
              },
            );
          });
        } catch (error) {
          restoreWatchdogsIfStillRunning();
          if (turnInterruptOrigins.get(turnId)?.source === 'user-stop') {
            turnInterruptOrigins.delete(turnId);
          }
          throw error;
        }
      },

      async abort() {
        const cancelledInteraction = cancelInteractionContinuation('turn_interrupted', true);
        if (cancelledInteraction) dismissAllPendingUserInput('turn_interrupted');
        const cancelledYield = cancelActiveYieldContinuation('aborted');
        // isolateCancelledTurnStart tombstones an accepted turn whose TurnStart
        // RPC is still pending, and that tombstone swallows interrupted
        // turn/completed. Only then emit an unclaimed cancelled done so Session
        // releases currentTurnAttemptToken. After the RPC has returned,
        // provider interrupted already emits one product Done — synthesizing
        // another here would settle the next attempt.
        if ((cancelledYield && isTurnStartPending) ||
          (cancelledInteraction && (!currentTurnId || isTurnStartPending))) {
          emitCancelledYieldProductDone();
        }
        clearReconnectStall();
        // 用户点 Stop = 明确不想继续这一轮，挂起的过载重投必须一起撤掉。
        // 放在 currentTurnId 判空之前：重投等待期间 turn 已死、currentTurnId 为
        // null，此时正是最需要响应 Stop 的时刻（否则计时器到点又发一个新 turn）。
        const retryState = overloadRetry;
        if (
          retryState &&
          overloadRetryPending(retryState) &&
          settleStoppedOverloadRetry(retryState, 'stopped while an automatic retry was pending')
        ) {
          return;
        }
        discardOverloadRetry('aborted');
        if (closed) return;
        if (currentTurnId) {
          // User intent wins terminal attribution. Keep an explicit marker
          // instead of merely deleting policy provenance so late blocked-item
          // notifications cannot re-arm it before turn/completed arrives.
          turnInterruptOrigins.set(currentTurnId, { source: 'user-stop' });
        }
        dismissAllPending('turn_interrupted', 'deny');
        if (!currentTurnId) return;
        if (skipIfStaleHost('turn/interrupt')) return;
        // 中断已在进行:收 idle 表,别让 watchdog 在收口窗口里再开一次火。
        resetUpstreamIdleForTurnEnd();
        dismissPendingUserInputForTurn(currentTurnId, 'turn_interrupted');
        try {
          await requestUserInterrupt(currentTurnId);
        } catch (e) {
          log.warn('turn/interrupt threw', { error: String(e) });
        }
      },

      getCurrentTurnId() {
        return currentTurnId;
      },

      async close() {
        await closeSessionHandle();
        await retireSingleSessionHost();
      },

      events(): AsyncIterable<AgentEvent> {
        const consumedEventStream = async function* (): AsyncGenerator<AgentEvent> {
          for await (const event of eventQueue) {
            try {
              yield event;
            } finally {
              releaseYieldContinuationEvent(event);
            }
          }
        };
        return consumedEventStream();
      },

      getCodexContextWindowInfo: async () => {
        if (opts.remoteHostId || !this.deps.resolveCodexContextWindowInfo) return null;
        const model = activeTurnModel ?? mutableModel;
        const reportedWindow = lastNativeContextWindow;
        const contextLimit = activeTurnContextLimit;
        const compactRatio = activeTurnCompactionPct / 100;
        try {
          const response = await host.request<{ config?: Record<string, unknown> }>(
            Method.ConfigRead, { includeLayers: false, cwd: opts.workingDir }, { timeoutMs: 5_000 },
          );
          if (!response.config) return null;
          const config = { ...response.config };
          if (contextLimit !== null) {
            config.model_context_window = contextLimit;
            config.model_auto_compact_token_limit = Math.floor(
              contextLimit * compactRatio,
            );
          }
          return await this.deps.resolveCodexContextWindowInfo(
            model, config, reportedWindow, ...(accountSessionHost && sessionCodexHome ? [sessionCodexHome] as const : []),
          );
        } catch { return null; }
      },

      readMcpServerTools: (serverName: string) => readCodexThreadMcpServerTools(
        (method, params, requestOpts) => host.request(method, params, requestOpts),
        threadId,
        serverName,
      ),

      getUsageSnapshot(): UsageSnapshot {
        return liveUsageSnapshot();
      },

      setInteractionResolver(resolver: InteractionResolver) {
        interactionResolver = resolver;
      },

      requiresModelSwitchRebuild: modelSwitchRequiresRebuild,

      // ── Phase 3: 运行时切换 (下一 turn 才生效, 内部已是 mutable 闭包) ──
      async setModel(
        newModel: string,
        setOpts?: { providerId?: string | null; contextWindowBudget?: number | null },
      ) {
        if (reviewMode) return;
        if (setOpts?.contextWindowBudget !== undefined) {
          mutableContextWindowBudget = setOpts.contextWindowBudget;
        }
        if (await modelSwitchRequiresRebuild(newModel, setOpts)) {
          const error = new Error(
            'Codex model switch requires rebuilding the current session handle',
          );
          (error as { code?: string }).code = 'CODEX_MODEL_SWITCH_REQUIRES_REBUILD';
          throw error;
        }
        // provider 可能在 model 不变时单独切换(同一 id 换路由), 所以先记 provider 再做 model 去重。
        // 窗口上限按 (provider, model) 解析, 漏掉这一步会让后续 turn 拿新模型去问旧路由。
        const prevProviderId = mutableProviderId;
        if (setOpts && Object.hasOwn(setOpts, 'providerId')) mutableProviderId = setOpts.providerId;
        if (newModel === mutableModel) {
          if (mutableProviderId !== prevProviderId) {
            autoReviewDecisionCache.clear();
            autoReviewUnavailableNotice.reset();
            autoReviewConfirmUndeliveredNotice.reset();
            refreshCodexAutoReviewerRoute(threadId);
          }
          return;
        }
        const prevModel = mutableModel;
        const prevCatalogModel = mutableCatalogModel;
        log.debug('setModel', { from: mutableModel, to: newModel, providerId: mutableProviderId ?? null });
        // 压缩风暴诊断用 (见 modelSwitchRecord): 首个 from 是 codex 一直拿来算窗口
        // 的那个模型, 后续切换只更新 to; 切回 from 则整条清空 (诱因已消失)。
        // **基准取 prevCatalogModel 而不是 prevModel**: 后者可能已被 server 规范化成
        // 只在 wire 上存在的变体, 与用户选的目录 id 比不相等 —— 详见 modelSwitchRecord。
        // 拿不到目录口径的来源时 (catalog 快照缺失) 不记录: 宁可走不猜原因的兜底文案,
        // 也不要把用户引向一个他点不到的 id。
        const prevSwitchRecord = modelSwitchRecord;
        const switchOrigin = modelSwitchRecord?.from ?? prevCatalogModel;
        modelSwitchRecord =
          !switchOrigin || newModel === switchOrigin
            ? null
            : { from: switchOrigin, to: newModel };
        mutableModel = newModel;
        autoReviewDecisionCache.clear();
        // 换模型 / 换路由可能正好修掉了审阅器不可用的原因;换完又不可用值得再提醒一次。
        autoReviewUnavailableNotice.reset();
        autoReviewConfirmUndeliveredNotice.reset();
        // 用户显式选的一定是目录 id(选择器就是从目录渲染的)。
        mutableCatalogModel = newModel;
        try {
          refreshCodexAutoReviewerRoute(threadId);
          // thread 已启动 → 立即经 thread/settings/update 推给 server (sticky); 未启动则由
          // 首个 thread/start 携带。沿用 turn/start 的 'gpt-5'=server 默认哨兵约定 (省略),
          // 避免把占位 model id 发给 server。失败时 turn/start 透传仍是兜底。
          if (newModel && newModel !== 'gpt-5') await pushThreadSettings({ model: newModel });
        } catch (e) {
          // 抛回调用方前把三个快照恢复原值。host 的 applyRuntimeSetModelChange 在异常分支
          // 会把 session 的 provider route 恢复成旧值; 我们这边若留着新值, 下一 turn 就会
          // 走旧路由却按新 (provider, model) 解析窗口上限 —— 两边分叉正是收敛出错的根源。
          //
          // 当前**走不到这里**: 上面两个调用各自内部都已 catch(registerCodexReviewer…
          // 落 warn 后保留安全路由; pushThreadSettings 吞掉 RPC 失败, 靠 turn/start 透传
          // 兜底)。留这层是结构性防御 —— 以后有人往这段加会抛的步骤时, 快照不会悄悄与
          // 实际路由分叉。也因为当前不可达, 没有对应单测能触发它。
          mutableProviderId = prevProviderId;
          mutableModel = prevModel;
          mutableCatalogModel = prevCatalogModel;
          modelSwitchRecord = prevSwitchRecord;
          throw e;
        }
      },

      async setEffort(newEffort: Effort) {
        if (reviewMode) return;
        if (newEffort === mutableEffort) return; // 去重: 值没变不重推
        const clamped = clampEffortForCodex(mutableModel, newEffort);
        log.debug('setEffort', { from: mutableEffort, to: newEffort, clamped });
        mutableEffort = newEffort;
        // thread 已启动 → 立即经 thread/settings/update 生效; 未启动由首个 turn/start
        // 携带 (TurnStartParams.effort, v2.rs:5800)。发 clamp 后的值, 与 turn/start 一致。
        if (clamped !== undefined) await pushThreadSettings({ effort: clamped });
      },

      getEffort() {
        return mutableEffort;
      },

      async setPermissionMode(newMode: PermissionMode) {
        if (reviewMode) {
          log.debug('setPermissionMode ignored for host-owned hard read-only session', {
            requested: newMode,
            reviewMode,
          });
          return;
        }
        log.debug('setPermissionMode', { from: mutablePermissionMode, to: newMode });
        // 用户自己动过权限档 → 一次性提示重新武装(与 Claude 同口径)。
        // 档位变了 → 连**裁决缓存**一起清。缓存 key 不含 permissionMode,切离 Auto 再切回时
        // 会命中先前那条 `unavailable` block —— 审阅器早就恢复了,同一个动作还是被拒
        // (greptile P1 of #1574)。一次性提示同步重新武装:用户既然接管过,之后又不可用
        // 值得再提醒一次。
        if (newMode !== mutablePermissionMode) {
          autoReviewDecisionCache.clear();
          autoReviewUnavailableNotice.reset();
          autoReviewConfirmUndeliveredNotice.reset();
        }
        // Full access 才能批量放行挂起的 ask。切到 Auto 时，已有请求不能绕过
        // reviewer / 人工降级审批，先 fail-closed 关闭；后续重试按当前路由能力
        // 选择 auto_review 或 user reviewer。
        const allowPending = newMode === 'bypassPermissions';
        dismissAllPending(`permission_mode_changed_to_${newMode}`, allowPending ? 'allow' : 'deny', true);
        const wasAuto = mutablePermissionMode === 'auto';
        const wasBypass = mutablePermissionMode === 'bypassPermissions';
        const wasOpen = wasAuto || wasBypass;
        const tightensCurrentTurn =
          (newMode === 'ask' && wasOpen) ||
          (newMode === 'auto' && wasBypass);
        mutablePermissionMode = newMode;
        // 下一 turn 通过 approvalPolicy + 已激活的 profile / sandboxPolicy 透传。
        //
        // 收紧兜底 (auto/bypass → ask): 见 interruptTurnForPermissionTighten 顶注。
        // turn id 已知 → 立即中断; turn/start 在飞 (id 未回) → 置标记, 由
        // handleTurnStartResp / turnStarted 在拿到 id 的瞬间补中断。放宽则清标记
        // (收紧后又切回宽松档, 在飞的 turn 无需再中断)。
        // 过载重投持的是**冻结**策略。只看最近一次转换会漏掉 Full access → Ask →
        // Auto 这类中间态：Ask→Auto 不算收紧会把标记清掉，而冻结的 Full access 仍然
        // 比 Auto 宽，重投出来的 turn 就能以 Full access 执行（review #844 codex P1）。
        // 按严格度排序直接比冻结档与当前档。
        const retryPolicyLooserThanNow = overloadRetryPolicyLooserThan(newMode);
        if (!tightensCurrentTurn && !retryPolicyLooserThanNow) {
          pendingTightenInterrupt = false;
        } else if (!closed && (turnLaunchedUnattended || retryPolicyLooserThanNow)) {
          // 只中断 auto_review / never / Auto policy turn;普通 user reviewer 发射的
          // turn 审批请求照常流经本地、收紧即时生效,期间 UI 短暂切过宽松档
          // 不构成中断理由。
          // retryPolicyLooserThanNow 是过载重投的补充判据: 挂起的重投冻结的是发射时
          // 那档策略, 只看"最近一次转换算不算收紧"会漏掉 Full access → Ask → Auto
          // 这类中间态(review #844 codex P1)。
          if (currentTurnId !== null) {
            await interruptTurnForPermissionTighten(currentTurnId);
          } else if (isTurnStartPending || overloadRetry?.timer != null || overloadRetry?.inFlight === true) {
            // 过载退避等待中 / 重投 RPC 在途时，既没有 currentTurnId 也不一定有
            // isTurnStartPending，但重投持着的 turnParams 是**收紧之前**冻结的旧
            // 宽松策略。不置这个标记，重投出来的 turn 会在权限已被撤销后继续执行
            // 工具（review #844 codex P1）。与 turn/start 在飞的处理同构：标记由
            // handleTurnStartResp 在拿到 turn id 的瞬间消费并补中断。
            pendingTightenInterrupt = true;
          }
        }
      },

      async setExtraDirs(newDirs: string[], libraryRoot?: string | null) {
        if (reviewMode) return;
        // 低版本不得假授权:setExtraDirs 非空必须闸 app-server ≥0.144.6,抛错留给宿主记 not-granted。
        if (newDirs.length > 0 && !readonlyReferenceDirsSupported) {
          throw new Error(
            `Codex reference directories require app-server 0.144.6 or newer (current: ${initResp.userAgent ?? 'unknown'})`,
          );
        }
        mutableLibraryRoot = opts.remoteHostId ? undefined : (libraryRoot ?? (mutableLibraryRoot === undefined ? undefined : null));
        if (
          mutableExtraDirs.length === newDirs.length
          && mutableExtraDirs.every((dir, index) => dir === newDirs[index])
        ) return;
        mutableExtraDirs = [...newDirs];
        autoReviewDirectoryGeneration++;
        log.debug('setExtraDirs', { count: mutableExtraDirs.length });
      },

      async setWritableDirs(newDirs: string[]) {
        if (reviewMode) return;
        if (newDirs.length > 0 && !readonlyReferenceDirsSupported) {
          throw new Error(
            `Codex writable directories require app-server 0.144.6 or newer (current: ${initResp.userAgent ?? 'unknown'})`,
          );
        }
        if (
          mutableWritableDirs.length === newDirs.length &&
          mutableWritableDirs.every((dir, index) => dir === newDirs[index])
        ) return;
        // The active turn keeps the thread-local profile selected before
        // turn/start. Compare against that activated snapshot, not the mutable
        // list: a root added only for the next turn cannot require revocation.
        let revokesActiveProfileRoot = false;
        if (workspacePermissionProfileActive && workspacePermissionProfileFingerprint !== null) {
          try {
            const parsedFingerprint = JSON.parse(workspacePermissionProfileFingerprint) as {
              writableDirs?: unknown;
            };
            const activeRoots = parsedFingerprint.writableDirs;
            const nextRoots = new Set(newDirs);
            revokesActiveProfileRoot = !Array.isArray(activeRoots)
              || activeRoots.some((dir) => typeof dir !== 'string' || !nextRoots.has(dir));
          } catch {
            // Internal profile state that cannot be proven safe is tightened
            // fail-closed by stopping any turn that may still hold it.
            revokesActiveProfileRoot = true;
          }
        }
        mutableWritableDirs = [...newDirs];
        autoReviewDirectoryGeneration++;
        log.debug('setWritableDirs', { count: mutableWritableDirs.length });
        if (closed) return;
        if (currentTurnId !== null && revokesActiveProfileRoot) {
          await interruptTurnForPermissionTighten(currentTurnId);
          return;
        }
        if (
          isTurnStartPending
          || overloadRetry?.timer != null
          || overloadRetry?.inFlight === true
        ) {
          // Re-adding every root before the id arrives restores the old
          // profile's authority and cancels this root-specific interruption.
          pendingWritableRootRevocationInterrupt = revokesActiveProfileRoot;
        }
      },

      async setPlanMode(enabled: boolean) {
        if (reviewMode) return;
        if (mutablePlanMode === enabled) return;
        mutablePlanMode = enabled;
        log.debug('setPlanMode', { enabled });
        // 下一 turn 经 turn/start.collaborationMode 生效 (与 permissionMode 同款
        // "下一 turn 透传"语义); 中途关闭时挂起的 plan_review 由用户自行处理。
      },

      getPlanMode() {
        return mutablePlanMode;
      },

      getExecutionPlanMode() {
        return mutablePlanMode || planCycleActive || currentTurnPlanModeActive;
      },

      async setFastMode(enabled: boolean | 'ultrafast') {
        if (reviewMode && opts.fastModePolicy?.isAllowed() !== false) return;
        if (opts.fastModePolicy?.isAllowed() === false) enabled = false;
        // Compare exact tiers; undefined/null/default all mean standard.
        if (opts.fastModePolicy?.isAllowed() !== false && fastModeFromServiceTier(serviceTierState.value) === enabled) return;
        const next: ServiceTier | null = enabled === 'ultrafast' ? 'ultrafast' : enabled ? 'fast' : null;
        log.debug('setFastMode', { from: serviceTierState.value ?? null, to: next });
        serviceTierMutationGeneration += 1;
        serviceTierState.value = next;
        // thread 已启动 → 立即经 thread/settings/update 生效 (serviceTier 双 Option:
        // 'fast'=开 / null=清空 standard); 未启动则由首个 thread/start 携带。server 端
        // 若因模型不支持 fast 而降级, 会经 thread/settings/updated 通知回带, handlers
        // 里把 serviceTierState.value 对齐到权威值。失败时 turn/start 透传仍是兜底。
        await pushThreadSettings({ serviceTier: next }, opts.fastModePolicy?.isAllowed() === false);
      },

      async setVendorOptions(patch: Record<string, unknown>) {
        // Keep the same vendorOptions object so active MCP handlers and the
        // host bridge see runtime Orca role/workflow updates by reference.
        Object.assign(vo, patch);
        registerRootCodexMcpContext();
        for (const descendantThreadId of descendantMcpThreadIds) {
          registerCodexMcpContext(descendantThreadId, 'descendant');
        }
        log.debug('setVendorOptions', {
          patchKeys: Object.keys(patch),
        });
      },

      getFastMode() {
        return fastModeFromServiceTier(serviceTierState.value);
      },

      async previewRewindFiles() {
        // Codex 的 thread/rollback 只裁剪对话上下文，不提供文件 checkpoint dry-run。
        // 代码回退由产品层 Git rollback 负责；单独点 Rewind 时 UI 会显示“无文件改动”。
        return {
          canRewind: true,
          filesChanged: [],
          insertions: 0,
          deletions: 0,
        };
      },

      async commitRewindFiles(_userUuid, _priorAssistantUuid, rewindOpts) {
        const tailTurnsToDrop = normalizeTailTurnsToDrop(rewindOpts?.tailTurnsToDrop);
        if (tailTurnsToDrop <= 0) {
          log.warn('commitRewindFiles called without tailTurnsToDrop; skipping thread/rollback', {
            threadId,
          });
          return { sdkSessionId: threadId };
        }
        const previousThreadId = threadId;
        let replacementThread: ThreadRollbackResponse['thread'] | undefined;
        // 运行时 ≥ 0.156.0 已移除 thread/rollback(#4994):不再白发一次注定 -32600 的
        // 请求,直接走原生边界 fork。版本未知/更老的 daemon 仍先试 rollback。
        let rollbackUnavailableReason: string | undefined = supportsCodexThreadRollback(initResp.userAgent)
          ? undefined
          : `thread/rollback removed in Codex app-server ${initResp.userAgent ?? 'unknown'} (0.156.0+)`;
        if (!rollbackUnavailableReason) {
          log.info('commitRewindFiles ▶ thread/rollback', {
            threadId,
            tailTurnsToDrop,
          });
          assertCurrentHost('thread/rollback');
          try {
            const rollbackResp = await host.request<ThreadRollbackResponse>(
              Method.ThreadRollback,
              { threadId, numTurns: tailTurnsToDrop } as ThreadRollbackParams,
            );
            replacementThread = rollbackResp.thread;
          } catch (error) {
            if (!isCodexRollbackUnavailableError(error)) throw error;
            rollbackUnavailableReason = isCodexRollbackMethodRemovedError(error)
              ? `thread/rollback rejected as unknown method by Codex app-server ${initResp.userAgent ?? 'unknown'}`
              : 'paginated thread rejects thread/rollback';
          }
        }
        if (!replacementThread) {
          // 分页线程(#4421)或运行时已移除该方法(#4994):app-server 不支持按 turn 数
          // 裁剪,改用与 forkSdkSession 相同的原生边界 fork —— 目标之前最后一个已完成
          // turn 作 lastTurnId,thread/fork 出一条截断后的新线程并把活动线程切过去。
          // native turn 计数含失败/重试轮次,与可见 user 消息数不一一对应,所以边界只认
          // 宿主传来的持久化锚点或按事件时间戳经 thread/turns/list 解析,绝不按 numTurns 数。
          //
          // daemon 以 unknown variant 拒绝 thread/rollback 本身就证明它 ≥ 0.156.0(该方法
          // 在此版本才被移除),原生 fork 与 thread/turns/list 必然可用;userAgent 缺失或
          // 无法解析时不能再拿版本串否决 fork(#5002 review P1)。
          const unavailableReason = rollbackUnavailableReason ?? 'thread/rollback unavailable';
          const rollbackMethodRemoved = unavailableReason.includes('unknown method')
            || unavailableReason.includes('removed in Codex');
          if (
            rewindOpts?.rewindsToNativeThreadStart === true
            && !normalizeNativeForkTurnId(rewindOpts.lastTurnId)
            && rewindOpts.forkAtTimestampMs === undefined
          ) {
            // 目标是当前原生线程的第一轮(宿主按消息时间线确认):前面没有 turn 可作
            // fork 边界,裁掉全部 turn 等价于一条空线程。按当前配置新开线程并切过去,
            // 旧线程与 fork 路径一样保留不动(#4994)。
            log.info('commitRewindFiles ▶ rewinding to native thread start; replacing with a fresh thread', {
              threadId,
              tailTurnsToDrop,
              reason: unavailableReason,
            });
            await replaceThreadWithCurrentProfile();
            currentTurnId = null;
            isTurnInFlight = false;
            log.info('commitRewindFiles ◀ fresh thread replaced rewound thread', {
              previousThreadId,
              threadId,
              tailTurnsToDrop,
            });
            return sdkSessionId ? { sdkSessionId } : {};
          }
          if (!rollbackMethodRemoved && !supportsCodexNativeTurnFork(initResp.userAgent)) {
            throw new Error(
              `Codex app-server ${initResp.userAgent ?? 'unknown'}: ${unavailableReason} and predates native turn fork (0.145.0); rewind is unavailable for this thread`,
            );
          }
          let lastTurnId = normalizeNativeForkTurnId(rewindOpts?.lastTurnId);
          if (!lastTurnId) {
            if (!rollbackMethodRemoved && !codexUserAgentAtLeast(initResp.userAgent, [0, 153, 4])) {
              throw new Error(
                `Codex app-server ${initResp.userAgent ?? 'unknown'}: ${unavailableReason} and cannot list native turns (0.153.4); rewind is unavailable for this thread`,
              );
            }
            lastTurnId = await resolveForkTurnAnchor(
              (method, params) => host.request<ThreadTurnsListResponse>(method, params as ThreadTurnsListParams),
              threadId,
              rewindOpts?.forkAtTimestampMs,
            );
          }
          log.info('commitRewindFiles ▶ thread/rollback unavailable; forking at native turn boundary', {
            threadId,
            tailTurnsToDrop,
            lastTurnId,
            reason: unavailableReason,
          });
          assertCurrentHost('thread/fork (rewind)');
          const forkParams: ThreadForkParams = {
            threadId,
            lastTurnId,
            ...(rollbackMethodRemoved || supportsCodexForkExcludeTurns(initResp.userAgent) ? { excludeTurns: true } : {}),
            ...(opts.workingDir ? { cwd: opts.workingDir } : {}),
            // Native fork reloads the host defaults rather than inheriting the
            // source thread's overrides. Reapply the task's execution environment,
            // MCP routes and capability isolation before the new runtime starts.
            ...currentThreadWorkspaceConfig(),
            ...(threadModelProvider ? { modelProvider: threadModelProvider } : {}),
            ...(mutableModel && mutableModel !== 'gpt-5' ? { model: mutableModel } : {}),
            ...(serviceTierState.value !== undefined ? { serviceTier: serviceTierState.value } : {}),
            ...(developerInstructions && !useProxyChannel ? { developerInstructions } : {}),
          };
          const forkResp = await withMcpDiscoveryContext(() => host.request<ThreadForkResponse>(
            Method.ThreadFork, forkParams, criticalThreadRpcOptions(),
          ));
          replacementThread = forkResp.thread;
        }
        const nextThreadId = replacementThread.id || previousThreadId;
        await recordNativeThreadLocation(replacementThread);
        if (nextThreadId !== previousThreadId) {
          const released = await releaseCurrentThreadSubscription('thread/rollback subscription release');
          if (!released) {
            throw staleHostError('thread/rollback subscription cleanup');
          }
          unregisterCodexMcpContext(previousThreadId);
          if (closed) {
            await unsubscribeDetachedThread(
              nextThreadId,
              'thread/rollback replacement cleanup after close',
            );
            log.info('commitRewindFiles discarded replacement after concurrent close', {
              previousThreadId,
              nextThreadId,
            });
            return sdkSessionId ? { sdkSessionId } : {};
          }
          threadId = nextThreadId;
          sdkSessionId = nextThreadId;
          workspacePermissionProfileActive = false;
          workspacePermissionProfileFingerprint = null;
          threadMayHaveRollout = true;
          subscription = host.subscribeThread(threadId, handlers);
          registerRootCodexMcpContext();
          refreshCodexAutoReviewerRoute(threadId);
          registerCodexDeveloperInstructions(threadId, registeredDeveloperInstructions);
          eventQueue.push({ type: 'session_id', data: sdkSessionId, source: 'codex' });
        } else {
          sdkSessionId = threadId;
          threadMayHaveRollout = true;
        }
        currentTurnId = null;
        isTurnInFlight = false;
        log.info('commitRewindFiles ◀ thread/rollback done', {
          threadId,
          tailTurnsToDrop,
        });
        return sdkSessionId ? { sdkSessionId } : {};
      },

      isTurnRunning() {
        // 本方法是 Session.send() 的 in-flight guard 判据（另见上方 turn/start
        // 失败收口处的注释）。过载重投把这一轮拆成了两段 app-server 侧「没有活着
        // 的 turn」但逻辑上没结束的窗口，只看 isTurnInFlight 都会漏：并发 send
        // 被误接受后，send() 开头的 cancelOverloadRetry 会把原消息静默丢掉。
        //
        // 三种状态见 overloadRetryPending 的注释(退避等待 / RPC 在途 / 失败已延后
        // 等补排)。漏掉"已延后"那种时, Session.send() 会把会话当 idle 接受第二条
        // 消息, 把第一条的重投状态连同它仍在飞的原始 RPC 一起丢掉
        // (review #844 codex P1)。三者都在 retry() 的 finally /
        // rescheduleDeferredCapacityFailure / cancelOverloadRetry 里必定复位。
        // **不把 `isTurnStartPending` 一起算进来**：正常 send 路径上它必须保持
        // idle 语义——终态先于 turn/start 响应到达时（协议允许的乱序），
        // coordinator 要看到 idle 才能收口，否则 send 挂死（既有用例
        // "accepts terminal error before TurnStartResponse…" 锁的就是这条）。
        //
        // yield continuation claim 把 provider turn/completed 与产品结束拆开:
        // 等 cell / 续段尚未启动时 isTurnInFlight 已是 false, 但仍是同一产品请求。
        return isTurnInFlight
          || overloadRetryPending()
          || yieldContinuationInFlight
          || activeYieldContinuationClaim() != null
          || interactionContinuation != null;
      },

      beginTurnContinuationWait(continuationId?: number) {
        if (continuationId === undefined) return null;
        return yieldContinuationClaims.get(continuationId)?.state
          ?? interactionContinuationClaims.get(continuationId)?.state ?? null;
      },

      onTurnContinuationChange(listener) {
        yieldContinuationListeners.add(listener);
        return () => yieldContinuationListeners.delete(listener);
      },
    };

    if (opts.resumeSessionId && threadMayHaveRollout) {
      const schedulerRefresh = ensureSchedulerMcpForResumedThread();
      if (schedulerRefresh) await schedulerRefresh;
    }
    return handle;
  }

  /**
   * Phase 3: thread/fork — Codex 协议层 fork 当前 thread 成新 thread。
   *
   * 与 Claude 不同:
   *  - Claude fork 可 truncate 到指定 message uuid (sdkForkSession upToMessageId)
   *  - Codex 新消息保存原生 turn id,直接用 lastTurnId 精确 fork
   *  - 老消息没有原生锚点时,分页 daemon 查 turn 元数据；旧 daemon 才用 rollback
   *
   * opts.upToMessageId 在 Codex 这里被忽略。uuidMap 返回空 — Codex 不使用
   * Claude message uuid；原生 turn 锚点由 usedNativeForkAnchor 单独声明可复用。
   */
  private hasLocalCodexHome(): boolean {
    return Boolean(this.codexHome) && !isRemoteLikePath(this.codexHome ?? '');
  }

  private async findRolloutPath(threadId: string, preferredPath?: string, homeOverride?: string): Promise<string> {
    if (preferredPath && !isRemoteLikePath(preferredPath)) {
      const preferredName = path.basename(preferredPath);
      if (preferredName.startsWith('rollout-') && preferredName.endsWith(`${threadId}.jsonl`)) {
        try {
          const stat = await fs.stat(preferredPath);
          if (stat.isFile()) return preferredPath;
        } catch {
          // Fall through to the normal CODEX_HOME scan when preparation only
          // returned a stale state-db pointer.
        }
      }
    }
    const codexHome = homeOverride ?? this.codexHome;
    if (!codexHome || isRemoteLikePath(codexHome)) {
      throw new Error('Codex rollout path is unavailable for this session');
    }

    const roots = [
      path.join(codexHome, 'sessions'),
      path.join(codexHome, 'archived_sessions'),
    ];
    let bestPath = '';
    let bestMtimeMs = -1;

    const visit = async (dir: string): Promise<void> => {
      let entries: Array<import('node:fs').Dirent>;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!entry.name.startsWith('rollout-') || !entry.name.endsWith(`${threadId}.jsonl`)) continue;
        const stat = await fs.stat(full);
        if (stat.mtimeMs > bestMtimeMs) {
          bestPath = full;
          bestMtimeMs = stat.mtimeMs;
        }
      }
    };

    for (const root of roots) {
      await visit(root);
    }
    if (!bestPath) {
      throw new Error(`Codex rollout not found for thread ${threadId}`);
    }
    return bestPath;
  }

  async requiresCodexThreadHostTransfer(
    opts: Parameters<BaseAgent['requiresCodexThreadHostTransfer']>[0],
  ): Promise<boolean> {
    if (opts.remoteHostId) return false;
    const observedHosts = new Set<AppServerHost>();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const hosts = new Map([...this.hosts].filter(([key]) => key.startsWith('local')));
      const generations = new Map([...this.hostGenerations].filter(([key]) => key.startsWith('local')));
      const writerCandidates = new Map([...hosts.values()].map((host) => [host, host.writerCandidate]));
      for (const host of hosts.values()) observedHosts.add(host);
      const registryCurrent = () => {
        const currentHosts = [...this.hosts].filter(([key]) => key.startsWith('local'));
        const currentGenerations = [...this.hostGenerations].filter(([key]) => key.startsWith('local'));
        return currentHosts.length === hosts.size && currentGenerations.length === generations.size
          && currentHosts.every(([key, host]) => hosts.get(key) === host && writerCandidates.get(host) === host.writerCandidate)
          && currentGenerations.every(([key, generation]) => generations.get(key) === generation);
      };
      const settleRetirements = async () => {
        for (const [key, entry] of this.retiringHosts) {
          if (key.startsWith('local')) observedHosts.add(entry.host);
        }
        // Do not retry a failed retirement here: callers must not commit a new
        // route after a failed exit proof, even if the registry later changes.
        await awaitCodexRouteSelection(Promise.all([...observedHosts].map((host) =>
          this.hostRetirementResults.get(host))), this.routeResolutionAbort.signal);
      };
      await settleRetirements();
      if (!registryCurrent()) continue;
      const selection = await this.resolveLocalAuthSelection(opts.providerId, opts.model);
      const contextWindow = opts.reviewMode ? null
        : await this.deps.resolveCodexThreadContextWindow?.(opts.providerId, opts.model);
      const accountProviderId = this.deps.isCodexAccountProvider?.(opts.providerId) ? opts.providerId! : undefined;
      const storage = await this.deps.resolveCodexThreadStorage?.(opts.threadId);
      const companionEnvironment = opts.sessionId
        ? await this.deps.resolveSessionEnvironment?.(opts.sessionId) : undefined;
      const targetKey = localSessionHostIdentity({
        sessionId: opts.sessionId ?? '', accountProviderId,
        accountSessionHost: accountProviderId !== undefined || this.deps.isolateCodexAccountSessions === true,
        reviewMode: opts.reviewMode === true,
        customContext: typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0,
        storage, policy: selection.policy, environmentIdentity: companionEnvironment?.identity,
      });
      if (!selection.isCurrent()) throw new CodexRouteSelectionChangedError();
      for (const [key, host] of hosts) {
        if (!registryCurrent()) break;
        if (key === targetKey || !host.writerCandidate) continue;
        let cursor: string | null = null;
        do {
          const result: { data: string[]; nextCursor?: string | null } | null = await awaitCodexRouteSelection(
            host.request<{ data: string[]; nextCursor?: string | null }>('thread/loaded/list', { cursor }, { timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS }),
            this.routeResolutionAbort.signal,
          ).catch((error) => { if (!registryCurrent()) return null; throw error; });
          if (!selection.isCurrent()) throw new CodexRouteSelectionChangedError();
          if (!result || !registryCurrent()) break;
          // A closed business handle does not release the native 0.153 writer.
          if (result.data?.includes(opts.threadId)) return true;
          cursor = result.nextCursor ?? null;
        } while (cursor !== null);
      }
      await settleRetirements();
      if (!registryCurrent()) continue;
      if (!selection.isCurrent()) throw new CodexRouteSelectionChangedError();
      return false;
    }
    throw new CodexRouteSelectionChangedError('Codex writer registry did not stabilize', false);
  }

  async forkSdkSession(opts: ForkSdkSessionOptions): Promise<ForkSdkSessionResult> {
    const log = this.deps.logger.child('codex/fork');
    const tailTurnsToDrop = normalizeTailTurnsToDrop(opts.tailTurnsToDrop);
    let lastTurnId = normalizeNativeForkTurnId(opts.lastTurnId);
    const forkAccountId = this.deps.isCodexAccountProvider?.(opts.providerId) ? opts.providerId! : undefined;
    const forkCredentialMode = forkAccountId ? 'oauth-bearer' : resolveAgentCredentialMode({
      agentKind: 'codex',
      providerId: opts.providerId,
      model: opts.model,
    });

    // Codex 0.153 keeps unsubscribed threads loaded for 30 minutes. Even an
    // exact native-turn fork must own a one-shot host: returning its child ID
    // before that process exits leaves a writer that blocks a different host
    // from resuming the child. Never retire the shared host to release it.
    // 故障半径隔离(2026-08-08 实排):thread/fork 的响应体与源 thread 历史成正比、
    // 无上界 —— 47MB rollout 实测产出 31MiB 单行 NDJSON,超过 client 16MiB
    // maxLineBytes 守卫后整条连接被熔断,当时共享 utility host 上挂着的 5 个活跃
    // session 全部同时报错。fork 是离线控制面操作(不跑 turn、无订阅者),改用
    // 唯一 key 的一次性 app-server:超限只让 fork 自己失败,不波及活跃任务。
    const forkRouteSignal = this.routeResolutionAbort.signal;
    const forkBaseHostKey = forkAccountId ? `local-account:${forkAccountId}:${localForkHostKey()}` : localForkHostKey();
    let forkHostKey = forkBaseHostKey;
    let releaseForkLease: (() => void) | undefined;
    let forkHost: AppServerHost | undefined;
    let forkHostRetired = false;
    let stage: CodexForkStage = 'source-prepare';
    let operationFailed = false;
    let forkFailure: CodexForkError | undefined;
    const createdThreadIds = new Set<string>();
    const cleanupCreatedThreads = async (): Promise<void> => {
      if (!forkHost || createdThreadIds.size === 0) return;
      for (const threadId of createdThreadIds) {
        try {
          // Request graceful cleanup before retiring the one-shot host.
          // Since 0.153 this only schedules unload, so the process shutdown
          // below is the barrier that releases the writer and allows the new
          // session to resume with its own MCP instance configuration.
          await forkHost.unsubscribeThread(threadId);
        } catch (error) {
          log.warn('fork child cleanup failed; ephemeral fork host will be retired', {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      }
      createdThreadIds.clear();
    };
    const retireForkHost = async (throwOnShutdownFailure: boolean): Promise<void> => {
      if (!forkHost || forkHostRetired) return;
      // retireHostKey removes the unique host from the registry before closing
      // its transport. Even when close reports an error, a second registry
      // lookup cannot make that same process safer to reuse.
      forkHostRetired = true;
      await this.retireHostKey(forkHostKey, 'Codex fork host is single-use', {
        failIfActive: false,
        logPrefix: 'codex fork host cleanup',
        expectedHost: forkHost,
        throwOnShutdownFailure,
      });
    };
    log.info('forkSdkSession ▶', {
      sourceSdkSessionId: opts.sourceSdkSessionId,
      upToMessageId: opts.upToMessageId,
      lastTurnId,
      tailTurnsToDrop,
      stripEncryptedReasoning: opts.stripEncryptedReasoning === true,
      forkHostKey,
      note: 'Codex 精确 fork: 独立一次性 host 上 thread/fork 后按需 thread/rollback 新 thread 尾部 turn',
    });
    try {
      const guestCodexHome = opts.hostedGuestHome ? path.join(opts.hostedGuestHome, 'codex') : undefined;
      // 受邀者的 fork 只能走分享的供应商：没有供应商时不退回成普通 host(那会用上本机用户的登录)。
      if (guestCodexHome && !opts.providerId) throw new Error('shared-provider Codex fork requires the shared provider');
      const forkStorage = guestCodexHome
        ? { historyHome: guestCodexHome, sqliteHome: guestCodexHome }
        : await this.deps.resolveCodexThreadStorage?.(opts.sourceSdkSessionId);
      // Fork requires actual history; it must never use resume's unused-thread recovery.
      if (forkStorage?.rolloutPath && !(await fs.lstat(forkStorage.rolloutPath)).isFile()) {
        throw new CodexResumePreparationBlockedError('Codex fork history is unavailable');
      }
      // Source history inspection must not depend on the credentials we are leaving.
      let preparedSourcePath = opts.stripEncryptedReasoning && !guestCodexHome
        ? await this.deps.prepareCodexResumeSession?.(opts.sourceSdkSessionId)
        : undefined;
      let historyChecked = false;
      if (opts.stripEncryptedReasoning && (preparedSourcePath || this.codexHome)) {
        await assertCodexRolloutRewriteSupported(preparedSourcePath || await this.findRolloutPath(opts.sourceSdkSessionId));
        historyChecked = true;
      }
      const forkSqliteHome = forkStorage?.sqliteHome;
      let forkCodexHome: string | undefined;
      let forkDispatched = false;
      const { host, resp, initResp, usedNativeForkAnchor } = await (async () => {
        for (let attempt = 0; ; attempt++) {
          forkRouteSignal.throwIfAborted();
          const selection = await this.resolveLocalAuthSelection(opts.providerId, opts.model ?? '');
          forkHostKey = codexLocalAuthHostIdentity(forkBaseHostKey, selection.policy);
          forkHostRetired = false;
          stage = 'host-create';
          try {
            const leased = await this.acquireHostOperation(async () => {
            const host = await this.getHost(undefined, forkCredentialMode, {
              keyOverride: forkHostKey,
              ...(forkAccountId ? { providerId: forkAccountId } : {}),
              ...(forkSqliteHome ? { sqliteHome: forkSqliteHome } : {}),
              ...(forkStorage ? { historyHome: forkStorage.historyHome } : {}),
              // 受邀者的 fork 同样要有独占的、按会话收窄的 proxy。fork 只做 thread/fork 与 rollback、
              // 不跑 turn：会话 id 用这次 fork 独有、不登记的 key，受邀者守门因此拒绝它经分享供应商发出的
              // 任何请求，不会借到源任务或其他受邀者的授权。
              ...(guestCodexHome && opts.providerId ? {
                deviceHostedGuestProviderId: opts.providerId,
                deviceHostedGuestSessionId: forkBaseHostKey,
                deviceHostedGuestModelIds: opts.model ? [opts.model] : [],
                nativeStorageOnly: true,
              } : {}),
              routeIsCurrent: selection.isCurrent,
              routeSignal: forkRouteSignal,
              ...(selection.policy === 'isolated' ? { localAuthPolicy: selection.policy } : {}),
              hostPurpose: 'control-plane',
            });
            return { key: forkHostKey, host };
            });
            const { host } = leased;
            releaseForkLease = leased.release;
            forkHost = host;
            stage = 'host-start';
            const initResp = await host.ensureStarted();
            // Child rollout discovery scans this.codexHome. The fork host may be
            // the first host started by this process, so hydrate it here.
            forkCodexHome = initResp.codexHome ?? undefined;
            if (forkCodexHome && !forkAccountId && !forkStorage) this.codexHome = forkCodexHome;
            // Imported Codex threads may still live under another CODEX_HOME. Resume
            // already asks the desktop host to link/adopt their state and rollout;
            // fork must cross the same preparation boundary before thread/fork or the
            // fork app-server cannot resolve a freshly imported thread.
            // A first host may have just created the managed state DB needed for imports.
            stage = 'source-prepare';
            if (!guestCodexHome) preparedSourcePath ??= await this.deps.prepareCodexResumeSession?.(opts.sourceSdkSessionId);
            if (opts.stripEncryptedReasoning && !historyChecked) {
              // Check before allocating a child: indexed native history must go through
              // Cindy's handoff recovery, never a file rewrite that invalidates Codex's DB.
              await assertCodexRolloutRewriteSupported(preparedSourcePath || await this.findRolloutPath(opts.sourceSdkSessionId));
            }
            if (
              !lastTurnId && (tailTurnsToDrop > 0 || opts.forkAtTimestampMs !== undefined) && !opts.stripEncryptedReasoning
              && codexUserAgentAtLeast(initResp.userAgent, [0, 153, 4])
            ) {
              // Older/failed messages have no persisted UI anchor. Paginated threads
              // reject rollback, so resolve the requested boundary with metadata only
              // before allocating a child. Never rewrite indexed rollout files.
              lastTurnId = await resolveForkTurnAnchor(
                (method, params) => host.request(method, params),
                opts.sourceSdkSessionId,
                opts.forkAtTimestampMs,
              );
            }
            forkRouteSignal.throwIfAborted();
            if (!selection.isCurrent()) throw new CodexRouteSelectionChangedError();
            const usedNativeForkAnchor = Boolean(
              lastTurnId && !opts.stripEncryptedReasoning && supportsCodexNativeTurnFork(initResp.userAgent),
            );
            let guestForkConfig: Record<string, unknown> | undefined;
            if (guestCodexHome) {
              // Fork starts a native runtime even without a turn. It must not
              // initialize the provider's MCP or connectors while copying history;
              // the child receives its consumer routes when startSession resumes it.
              await assertNoCodexUserInstructions(forkCodexHome);
              const features = await listCodexFeatures(cursor => host.request(
                Method.ExperimentalFeatureList, { cursor, limit: 100 },
                { timeoutMs: CRITICAL_THREAD_RPC_TIMEOUT_MS },
              ));
              guestForkConfig = {
                ...await this.buildLocalCapabilityIsolationConfig(host, opts.workingDir ?? guestCodexHome),
                ...CODEX_DEVICE_HOSTED_GUEST_THREAD_CONFIG,
                ...codexGuestFeatureOverrides(features),
              };
            }
            const params: ThreadForkParams = {
              threadId: opts.sourceSdkSessionId,
              ...(preparedSourcePath ? { path: preparedSourcePath } : {}),
              ...(!usedNativeForkAnchor ? { persistExtendedHistory: true } : {}),
              ...(usedNativeForkAnchor ? { lastTurnId } : {}),
              // 响应体瘦身:fork 后 Cindy 自己的会话数据负责历史展示,thread.turns 全量
              // 回传只会撑爆单行上限。老 daemon 不认识该字段则保持 legacy 行为 —— 此时
              // 一次性 host 的隔离仍兜住故障半径。
              ...(supportsCodexForkExcludeTurns(initResp.userAgent) ? { excludeTurns: true } : {}),
              ...(opts.workingDir ? { cwd: opts.workingDir } : {}),
              ...(guestForkConfig ? { config: guestForkConfig } : {}),
            };
            // Once dispatched, a lost response may still mean a child was allocated.
            stage = 'thread-fork';
            const resp = await host.request<ThreadForkResponse>(Method.ThreadFork, params, {
              beforeDispatch: () => {
                forkRouteSignal.throwIfAborted();
                if (!selection.isCurrent()) throw new CodexRouteSelectionChangedError();
                forkDispatched = true;
              },
            });
            return { host, resp, initResp, usedNativeForkAnchor };
          } catch (error) {
            if (!forkDispatched && error instanceof CodexRouteSelectionChangedError && !forkRouteSignal.aborted) {
              await retireForkHost(true);
              releaseForkLease?.();
              releaseForkLease = undefined;
              forkHost = undefined;
              if (attempt < 7) continue;
            }
            if (opts.stripEncryptedReasoning && error instanceof AgentNotAuthenticatedError) {
              throw new CodexHistoryRecoveryRequiredError();
            }
            throw error;
          }
        }
      })();
      let newSdkSessionId = resp.thread.id;
      if (forkCodexHome && typeof resp.thread.path === 'string') {
        await this.deps.recordCodexThreadLocation?.(newSdkSessionId, forkSqliteHome ?? forkCodexHome, resp.thread.path);
      }
      createdThreadIds.add(newSdkSessionId);
      if (!usedNativeForkAnchor && tailTurnsToDrop > 0) {
        const rollbackParams: ThreadRollbackParams = {
          threadId: newSdkSessionId,
          numTurns: tailTurnsToDrop,
        };
        // thread/rollback 没有 excludeTurns 对应物,响应仍可能携带完整历史;
        // 超限时熔断的只是这台一次性 host,活跃 session 不受影响。
        stage = 'thread-rollback';
        if (!supportsCodexThreadRollback(initResp.userAgent)) {
          // 0.156.0+ 已移除 thread/rollback(#4994)。走到这里只剩没有原生锚点的
          // 尾裁(例如剥离加密 reasoning 的跨供应商 fork),daemon 会以 -32600
          // unknown variant 拒绝;直接给出可定位的错误,子线程仍由 finally 清理。
          throw new Error(
            `Codex app-server ${initResp.userAgent ?? 'unknown'} removed thread/rollback (0.156.0+); cannot trim ${tailTurnsToDrop} tail turn(s) without a native turn anchor`,
          );
        }
        const rollbackResp = await host.request<ThreadRollbackResponse>(
          Method.ThreadRollback,
          rollbackParams,
        );
        const rollbackThreadId = rollbackResp.thread.id || newSdkSessionId;
        createdThreadIds.add(rollbackThreadId);
        newSdkSessionId = rollbackThreadId;
        if (forkCodexHome && typeof rollbackResp.thread.path === 'string') {
          await this.deps.recordCodexThreadLocation?.(newSdkSessionId, forkSqliteHome ?? forkCodexHome, rollbackResp.thread.path);
        }
      }
      if (opts.stripEncryptedReasoning) {
        // Legacy unindexed history can be sanitized after the one-shot writer closes.
        // Indexed history was rejected before fork; a second guard inside the sanitizer
        // also protects against a newer child format returned by the native daemon.
        stage = 'child-cleanup';
        await cleanupCreatedThreads();
        stage = 'host-retire';
        await retireForkHost(true);
        stage = 'child-sanitize';
        const childRolloutPath = await this.findRolloutPath(newSdkSessionId, undefined, forkCodexHome);
        const sanitizeStats = await sanitizeCodexForkRolloutFileInPlace(childRolloutPath);
        log.info('fork child rollout sanitized', {
          newSdkSessionId,
          unsafeLines: sanitizeStats.unsafeLines,
          rewrittenLines: sanitizeStats.rewrittenLines,
          strippedBytes: sanitizeStats.strippedBytes,
        });
      }
      log.info('forkSdkSession ◀', { newSdkSessionId, tailTurnsToDrop });
      return {
        newSdkSessionId,
        uuidMap: new Map(),
        ...(usedNativeForkAnchor ? { usedNativeForkAnchor: true } : {}),
      };
    } catch (error) {
      operationFailed = true;
      // Recovery and authentication are control signals consumed by callers.
      if (
        isCodexHistoryRecoveryRequired(error) ||
        error instanceof AgentNotAuthenticatedError ||
        error instanceof CodexResumePreparationBlockedError ||
        (error instanceof Error && error.name === 'AbortError')
      ) throw error;
      forkFailure = new CodexForkError(stage, error);
      throw forkFailure;
    } finally {
      try {
        await cleanupCreatedThreads();
      } catch (error) {
        // A cleanup failure must never replace the primary failure.
        if (!operationFailed) {
          operationFailed = true;
          forkFailure = new CodexForkError('child-cleanup', error);
          throw forkFailure;
        }
        if (forkFailure) forkFailure.cleanupFailed = true;
      } finally {
        // 一次性 host 用完即收,无论成败。key 唯一、无 session 绑定,
        // retire 不会波及任何共享 host 或活跃会话。
        try {
          if (forkHost && !forkHostRetired) {
            // Unsubscribe is not a writer-release barrier. Never publish a
            // successful fork unless physical shutdown has been confirmed.
            await retireForkHost(true).catch((err) => {
              if (!operationFailed) throw new CodexForkError('host-retire', err);
              if (forkFailure) forkFailure.cleanupFailed = true;
              log.warn('fork host retire failed', {
                forkHostKey,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        } finally {
          releaseForkLease?.();
        }
      }
    }
  }

  /**
   * app.before-quit 调一次, 杀所有 codex app-server 子进程 (本地 spawn + 远端
   * SSH-bridged 各一份)。Windows 不会随父进程死, 必须显式收割。幂等。
   */
  async dispose(): Promise<void> {
    this.routeResolutionAbort.abort(new Error('Codex route selection cancelled by dispose'));
    this.routeResolutionAbort = new AbortController();
    this.deps.logger.error('codex dispose called', {
      hostCount: this.hosts.size,
      inflightCount: this.hostPromises.size,
      createHostSeqByKey: Object.fromEntries(this.createHostSeqByKey),
    });
    // 如果有正在创建中的 host (logout 撞上启动期 in-flight getHost), 等它出来再 shutdown,
    // 否则刚 spawn 出来的子进程没人收 → 孤儿。await 失败说明创建本身炸了, 没东西可收。
    //
    // **before-quit 兜底**: hostPromise 卡住 (auth.getState hang / prepareCodexExtraSpawnConfig
    // hang) 时不能让 dispose 跟着卡到 lifecycle 6s 超时, 否则 SIGTERM 永远发不出。安全性:
    // hostPromise resolve 之前真正的 child spawn 还没发生 (start() 在 ensureStarted
    // 里才调, app-server/host.ts), 所以超时跳过 host.shutdown 不会留孤儿子进程。
    if (this.hostPromises.size > 0) {
      const inflightSnapshot = Array.from(this.hostPromises.values()).map((entry) => entry.promise);
      for (const key of this.hostPromises.keys()) {
        this.bumpHostGeneration(key);
      }
      try {
        await Promise.race([
          Promise.allSettled(inflightSnapshot),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('hostPromise timeout in dispose (1500ms)')), 1500),
          ),
        ]);
      } catch (e) {
        this.deps.logger.warn('codex dispose: hostPromise await skipped', {
          message: (e as Error).message,
        });
      }
    }
    // `dispose()` is normally used during app shutdown, but auth/config
    // boundaries can reach it while a turn is still attached.  Retiring a
    // host silently clears its subscribers; without the same structured
    // notification used by `retireHostKey(..., failIfActive: false)`, an
    // in-flight Computer Use turn remains busy forever after its transport
    // disappears. Notify hosts before retirement so the
    // session can emit its terminal interruption and release its input/turn
    // ownership.
    const hostsToRetire = new Map<string, AppServerHost>();
    for (const [key, host] of this.hosts) hostsToRetire.set(key, host);
    for (const [key, entry] of this.retiringHosts) {
      if (!hostsToRetire.has(key)) hostsToRetire.set(key, entry.host);
    }
    const retirements: Promise<void>[] = [];
    for (const [key, host] of hostsToRetire) {
      host.notifySubscribersOfForcedRetire('CodexAgent.dispose()');
      retirements.push(this.beginHostRetirement(key, host, 'CodexAgent.dispose()'));
    }
    for (const key of this.hosts.keys()) {
      this.hostGenerations.set(key, (this.hostGenerations.get(key) ?? 0) + 1);
    }
    this.hosts.clear();
    this.hostPromises.clear();
    this.hostCredentialModes.clear();
    this.hostEffectiveCredentialModes.clear();
    this.hostSessionBindingLeases.clear();
    this.hostCredentialModeSwitches.clear();
    // 进程重启后 server 端 in-memory enablement 会丢, 重置 push flag 让下次 ensure 再 push 一次
    this.memoryOverridePushedByHost.clear();
    // codexHome 也跟着 host 走: 下次 ensureStarted() 会用新 server 的返回值重新填,
    // 防止用户中途切 CODEX_HOME (改 auth / 重登) 后这边还拿着老路径。
    this.codexHome = null;
    if (retirements.length > 0) {
      // 并发 shutdown — 互不依赖, 一起更快收完。失败不阻断其他。
      await Promise.allSettled(retirements);
    }
    // dispose 完毕 → 重置 seq, 下次 createHost 重新从 1 开始计数 (logout/切账号场景)
    this.createHostSeqByKey.clear();
  }

  /**
   * 本地 Codex 凭证状态变化时只重置 local app-server。
   *
   * 远端 host 使用 remote daemon / remote 用户配置；本地 key、OAuth 或 proxy 注入状态变化
   * 不应该 retire `remote:*` host，否则远端 session 会绕过 Session.close 留下 stale 状态。
   */
  async disposeLocalHostForCredentialChange(reason = 'CodexAgent local credential state changed'): Promise<void> {
    const switchGuard = await this.beginLocalHostCredentialChange(reason);
    await switchGuard.finalize();
  }

  /**
   * 本地 Codex OAuth/logout 失效时强制收掉共享 local host 与独立 control-plane hosts。
   *
   * 这些 host 都持有本机凭证，账号边界变化后不能继续复用；remote hosts 使用远端
   * 用户配置，不在本次清理范围内。
   */
  async forceDisposeLocalHostForAuthChange(
    reason = 'CodexAgent local auth changed',
    options: { preserveExternalAuth?: boolean } = {},
  ): Promise<void> {
    const keys = new Set<string>([hostKey(), codexLocalAuthHostIdentity(hostKey(), 'isolated')]);
    for (const key of this.hosts.keys()) {
      if (
        key.startsWith('local-account:openai:') || isLocalControlPlaneHostKey(key) ||
        isLocalForkHostKey(key) ||
        isLocalReviewHostKey(key) ||
        isLocalCustomContextHostKey(key) ||
        // 受邀者任务的 app-server 用本机用户的登录：登出 / 换号后同样立即退役。
        key.startsWith(LOCAL_GUEST_HOST_PREFIX)
      ) keys.add(key);
    }
    for (const key of this.hostPromises.keys()) {
      if (
        key.startsWith('local-account:openai:') || isLocalControlPlaneHostKey(key) ||
        isLocalForkHostKey(key) ||
        isLocalReviewHostKey(key) ||
        isLocalCustomContextHostKey(key) ||
        // 受邀者任务的 app-server 用本机用户的登录：登出 / 换号后同样立即退役。
        key.startsWith(LOCAL_GUEST_HOST_PREFIX)
      ) keys.add(key);
    }
    await Promise.all(Array.from(keys).filter((key) =>
      !options.preserveExternalAuth || !key.endsWith(':external-auth'),
    ).map((key) =>
      this.retireHostKey(key, reason, {
        failIfActive: false,
        logPrefix: 'codex local auth restart',
        throwOnShutdownFailure: key.startsWith('local-account:'),
      })));
  }

  async disposeAccountHosts(providerId: string): Promise<void> {
    const prefix = `local-account:${providerId}:`;
    const keys = new Set([...this.hosts.keys(), ...this.hostPromises.keys()]);
    await Promise.all([...keys].filter((key) => key.startsWith(prefix)).map((key) =>
      this.retireHostKey(key, 'Codex account credentials changed', { failIfActive: false, logPrefix: 'codex account', throwOnShutdownFailure: true })));
  }

  /** Release a stale SSH connection after its daemon was explicitly restarted. */
  async disposeRemoteHostAfterRestart(remoteHostId: string): Promise<void> {
    await this.retireHostKey(hostKey(remoteHostId), 'SSH Codex daemon restarted', {
      failIfActive: true,
      logPrefix: 'codex remote restart',
      throwOnShutdownFailure: true,
    });
  }

  private async disposeLocalHostForCredentialChangeUnlocked(key: string, reason: string): Promise<void> {
    await this.retireHostKey(key, reason, {
      failIfActive: true,
      logPrefix: 'codex local credential restart',
    });
  }

  private beginHostRetirement(key: string, host: AppServerHost, reason: string): Promise<void> {
    const existing = this.retiringHosts.get(key);
    if (existing?.host === host && existing.promise) return existing.promise;
    const entry = existing?.host === host ? existing : {
      host,
      generation: this.hostGenerations.get(key) ?? 0,
      promise: null as Promise<void> | null,
    };
    const promise = Promise.resolve().then(() => host.retire(reason, { throwOnTransportError: true }));
    entry.promise = promise;
    this.hostRetirementResults.set(host, promise);
    this.retiringHosts.set(key, entry);
    // 失败保留 key/Host 屏障；下次请求可重查迟到的 exit，不自动重试或另启 writer。
    void promise.then(() => {
      if (this.retiringHosts.get(key) === entry) this.retiringHosts.delete(key);
    }, () => {
      if (entry.promise === promise) entry.promise = null;
    });
    return promise;
  }

  private async retireHostKey(
    key: string,
    reason: string,
    opts: {
      failIfActive: boolean;
      logPrefix: string;
      /** Optional identity fence for delayed cleanup from an older handle. */
      expectedHost?: AppServerHost;
      expectedGeneration?: number;
      /** Propagate shutdown failure to callers that must not mutate persisted state afterward. */
      throwOnShutdownFailure?: boolean;
      /** Refuse (counting an in-flight creation as active) before cancelling or mutating anything. */
      rejectBeforeMutation?: boolean;
    },
  ): Promise<void> {
    const retiring = this.retiringHosts.get(key);
    if (retiring
      && (!opts.expectedHost || opts.expectedHost === retiring.host)
      && (opts.expectedGeneration === undefined || opts.expectedGeneration === retiring.generation)) {
      try {
        await this.beginHostRetirement(key, retiring.host, reason);
      } catch (error) {
        if (opts.throwOnShutdownFailure) throw error;
      }
      return;
    }
    let expectedGeneration = opts.expectedGeneration;
    const matchesExpectedHost = (): boolean => {
      if (opts.expectedHost && this.hosts.get(key) !== opts.expectedHost) return false;
      if (
        expectedGeneration !== undefined &&
        (this.hostGenerations.get(key) ?? 0) !== expectedGeneration
      ) {
        return false;
      }
      return true;
    };
    if (!matchesExpectedHost()) {
      this.deps.logger.warn(`${opts.logPrefix}: stale host cleanup skipped`, {
        key,
        reason,
      });
      return;
    }
    // 本地配置变更守卫(allLocalHosts)的拒绝必须发生在任何状态改动之前:下面处理 in-flight 创建时会
    // 推进 key 代次并摘掉 hostPromises,若之后才因 active 抛错,正在创建的 host 会以「superseded」
    // 失败,等于一次被拒绝的退役仍然打掉了正在启动的会话。in-flight 创建本身也算 active(与守卫
    // assertIdle 口径一致)。只对该守卫生效:远程 daemon 重启清理同样 failIfActive,却依赖取消
    // 模型发现等占用的 in-flight 创建(review #6396)。
    if (opts.failIfActive && opts.rejectBeforeMutation) {
      const host = this.hosts.get(key);
      const activeUseCount = (host
        ? this.hostActiveUseCount(key, host)
        : (this.hostSessionBindingLeases.get(key) ?? 0))
        + (this.hostPromises.has(key) ? 1 : 0);
      if (activeUseCount > 0) {
        throw new Error(
          `Cannot restart local Codex host while ${activeUseCount} active Codex session(s) are attached`,
        );
      }
    }
    const inflight = this.hostPromises.get(key);
    if (inflight) {
      const bumpedGeneration = this.bumpHostGeneration(key);
      if (expectedGeneration !== undefined) expectedGeneration = bumpedGeneration;
      this.hostPromises.delete(key);
      try {
        await Promise.race([
          inflight.promise.catch(() => undefined),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('local hostPromise timeout in credential restart (1500ms)')), 1500),
          ),
        ]);
      } catch (e) {
        this.deps.logger.warn(`${opts.logPrefix}: hostPromise await skipped`, {
          message: (e as Error).message,
        });
      }
      // The in-flight entry may have been replaced while we waited for it.
      // Never let an old handle's delayed cleanup delete the newer host.
      if (!matchesExpectedHost()) {
        this.deps.logger.warn(`${opts.logPrefix}: stale host cleanup skipped after await`, {
          key,
          reason,
        });
        return;
      }
    }

    const host = this.hosts.get(key);
    const activeUseCount = host
      ? this.hostActiveUseCount(key, host)
      : (this.hostSessionBindingLeases.get(key) ?? 0);
    if (opts.failIfActive && activeUseCount > 0) {
      throw new Error(
        `Cannot restart local Codex host while ${activeUseCount} active Codex session(s) are attached`,
      );
    }
    if (!opts.failIfActive && activeUseCount > 0) {
      this.deps.logger.warn(`${opts.logPrefix}: retiring host with active sessions`, {
        key,
        activeUseCount,
      });
      // 强杀 host 不走 Session.close —— 先把终态 transport error 广播给订阅者,
      // 让每个 session 自己收口 turn 状态 (isTurnInFlight→false + 补发 isRunning:false)。
      // 不广播的话上层 busy 判定永久 stale:输入排队不派发、Stop 的 abort 锁解不开、
      // 凭证切换 busy 重试风暴 (2026-07-19 auth app_session_terminated 实排)。
      host?.notifySubscribersOfForcedRetire(reason);
    }

    const retirement = host ? this.beginHostRetirement(key, host, reason) : undefined;
    this.hosts.delete(key);
    this.hostPromises.delete(key);
    this.hostCredentialModes.delete(key);
    this.hostEffectiveCredentialModes.delete(key);
    this.hostSessionBindingLeases.delete(key);
    this.memoryOverridePushedByHost.delete(key);
    if (key === hostKey()) this.codexHome = null;
    this.createHostSeqByKey.delete(key);
    this.bumpHostGeneration(key);
    if (!host) return;
    try {
      await retirement;
    } catch (error) {
      this.deps.logger.warn(`${opts.logPrefix}: host shutdown failed`, {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      if (opts.throwOnShutdownFailure) throw error;
    }
  }

  // ── Memory 实现 ────────────────────────────────────────────────────────
  // 范围: codex Feature::MemoryTool ("memories", 实验性, 默认关)。
  // 控制走 experimentalFeature/enablement/set (in-memory 进程级 + 自动热重载所有 live thread),
  // 不写 config.toml 文件; 数据落 <CODEX_HOME>/memories/ + state_*.sqlite。

  async getMemoryStatus(): Promise<MemoryStatus> {
    // config/read 返回的 effective config 已经把 in-memory enablement 合并进去了
    // (config_processor.rs:99-110), 所以 setMemory 后立刻 read 也能看到新值
    try {
      return await this.withHostOperation(() => this.getUtilityHost(), async (host, key) => {
        // app-server 重启后 in-memory enablement 会丢, server 端回到 config.toml 默认值 (memories=false);
        // 读之前先把 maker 端持久化的 memoryOverride 同步过去, 否则 Settings 界面显示的是 server 默认值,
        // 不是用户上次保存的设置。ensureMemoryOverridePushed 内部用 memoryOverridePushed 去重, 已 push 是 no-op。
        await host.ensureStarted();
        await this.ensureMemoryOverridePushed(host, key).catch((e) => {
          this.deps.logger.warn('codex.getMemoryStatus: ensureMemoryOverridePushed failed', {
            error: e instanceof Error ? e.message : String(e),
          });
        });
        type ConfigReadResp = { config?: { features?: { memories?: boolean } } };
        const resp = await host.request<ConfigReadResp>(Method.ConfigRead, { includeLayers: false });
        const enabled = resp.config?.features?.memories ?? false;
        return {
          enabled,
          // memoryOverride 没设过时 enabled 来自 config.toml + server 默认, 算 'user-config';
          // host 显式覆盖过算 'host-runtime'
          source: this.memoryOverride === undefined ? 'user-config' : 'host-runtime',
        };
      });
    } catch (err) {
      if (err instanceof AgentNotAuthenticatedError) {
        // 未授权 → host 起不来, 报推断值 (codex 默认 false)
        return {
          enabled: this.memoryOverride ?? false,
          source: this.memoryOverride === undefined ? 'agent-default' : 'host-runtime',
        };
      }
      throw err;
    }
  }

  async setMemory(enabled: boolean): Promise<MemorySetResult> {
    const log = this.deps.logger.child('codex/setMemory');
    log.info('setMemory ▶', { from: this.memoryOverride, to: enabled });
    this.memoryOverride = enabled;
    // A refresh already owns admission; the replacement host will read this override.
    if (this.hostCredentialModeSwitches.has(LOCAL_MCP_REFRESH_KEY)) return { effective: 'next-session' };
    // 立即 push, 让所有 live thread 通过 server 端 reload_user_config 拿到新值
    try {
      const localSessionHosts = Array.from(this.hosts.entries()).filter(
        ([key]) =>
          !key.startsWith('remote:') &&
          !isLocalControlPlaneHostKey(key) &&
          !isLocalForkHostKey(key) &&
          !isLocalReviewHostKey(key),
      );
      if (localSessionHosts.length === 0) {
        log.info('setMemory ◀ no live app-server, will apply on next session');
        return { effective: 'next-session' };
      }
      await Promise.all(localSessionHosts.map(async ([key, host]) => {
        // Only thread-serving local hosts receive Maker Memory. Remote hosts own
        // their native setting; model-list control-plane hosts have no live threads.
        const generation = this.hostGenerations.get(key);
        const release = this.acquireHostSessionBindingLease(key);
        try {
          await host.request(Method.ExperimentalFeatureEnablementSet, {
            enablement: { memories: enabled },
          });
          this.memoryOverridePushedByHost.set(key, enabled);
          return key;
        } finally {
          if (this.hostGenerations.get(key) === generation) release();
        }
      }));
      log.info('setMemory ◀ pushed to app-server, hot-reloaded all live threads');
      return { effective: 'immediate' };
    } catch (err) {
      if (err instanceof AgentNotAuthenticatedError) {
        // 未授权 → host 起不来, 但 memoryOverride 已记下, 等下次 ensure (startSession 触发) 再 push
        log.warn('setMemory: not authenticated, deferring push to next session');
        this.memoryOverridePushedByHost.clear();
        return { effective: 'next-session' };
      }
      // server 端 RPC 失败 → 把 push flag 重置, 下次 ensure 再试
      this.memoryOverridePushedByHost.clear();
      throw err;
    }
  }

  async resetMemory(): Promise<MemoryResetResult> {
    const log = this.deps.logger.child('codex/resetMemory');
    log.info('resetMemory ▶');
    return this.withHostOperation(() => this.getUtilityHost(), async (host) => {
      // server 端清 <CODEX_HOME>/memories/ 目录 + state_*.sqlite 的 memory stage 数据;
      // 不影响各 thread 的 memory_mode (用户随后改 thread/memoryMode/set 才动那个)
      await host.request(Method.MemoryReset, {});
      log.info('resetMemory ◀ ok');
      // server 不返回数量统计, removedEntries / removedBytes 留 undefined
      return {};
    });
  }

  /**
   * memoryOverride 同步到 app-server。
   *
   * 调用时机:
   *  - 每次 startSession 调一次 (在 host.ensureStarted 之后)
   *  - 内部已用 memoryOverridePushed 去重, 已 push 同样的值就 no-op
   *
   * 失败语义: 抛错由调用方决定。startSession 那边会 catch + warn + 继续, 不让
   * memory 配置 block 主对话流。
   */
  private async ensureMemoryOverridePushed(
    host: AppServerHost,
    key: string,
    forcedValue?: boolean,
  ): Promise<void> {
    const targetValue = forcedValue ?? this.memoryOverride;
    if (targetValue === undefined) return; // 没设 override 不动 server, 让 server 走自带配置
    if (this.memoryOverridePushedByHost.get(key) === targetValue) return; // 已 push 同值, no-op
    await host.request(Method.ExperimentalFeatureEnablementSet, {
      enablement: { memories: targetValue },
    });
    this.memoryOverridePushedByHost.set(key, targetValue);
    this.deps.logger.info('codex: memoryOverride pushed to app-server', {
      memories: targetValue,
    });
  }
}

