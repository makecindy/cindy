/**
 * makerChatStore — Module-level store for Maker chat (Claude / Codex), sharded by sessionId.
 * ---------------------------------------------------------------------------
 * This store replaces the previous hook-local state in `useCCAgentChat`. The
 * hook used to keep `messages / isStreaming / agentStatus / refs...` in a
 * single React instance, which meant switching `sessionId` wiped the state
 * of the previous session and — worse — the effect cleanup called
 * `stopCCAgentSession`, killing the running SDK query in the main process.
 *
 * Here every session owns its own `SessionChatState` slice inside a module-
 * level `Map`. IPC events are received through a single global listener
 * (installed once via `initGlobalListeners`) and routed to the correct slice
 * by `event.sessionId`. Components subscribe to a single slice via
 * `useSyncExternalStore`; slices for other sessions keep updating in the
 * background and are preserved across switches.
 *
 * Preserved semantics:
 * - F-CHAT-2 auto-naming (Haiku + 3s fallback, once per session)
 * - F-CHAT-3 tool_use / tool_result / assistant persistence
 * - F-SYNC-2 paginated loadOlderMessages
 * - User-initiated stopSession (NOT called on session switch anymore)
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushStampCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import {
  formatRemoteError,
  isDeviceUnresponsiveRemoteError,
  isTransientRemoteError,
} from '@cindy/maker-shared/device-link-contract';
import {
  applyCodexPlanSnapshotOnDone,
  getLatestMessageTodoState,
  isAgentPlanToolName,
  isSubagentParentToolUseId,
  markCodexPlanTurnFailed,
} from '@cindy/maker-shared/message-render';
import {
  normalizeWorkflowProgressEntries,
  type WorkflowProgressEntry,
} from '@cindy/maker-shared/agent-task';
import {
  isProductTurnDoneEvent,
  isTurnContinuationBoundaryEvent,
} from '@cindy/maker-shared/turn-continuation';
import { normalizeAutoTitle } from '@cindy/maker-shared/session-title';
import type { MessageRole, Message, MessageAutomationOrigin } from '@/lib/ccAgent.types';
import type { AttachedFile, MentionedResource, SerializedAttachedFile } from '@/lib/fileTypes';
import type {
  AgentInputCreateOpts,
  AgentInputProjection,
  AgentInputQueuedMessage,
  AgentInputRecovery,
  AgentInputSessionRef,
  AgentInputReference,
} from '../../shared/agentInputQueue';
import { normalizeAgentInputClearBoundaryMs } from '../../shared/agentInputQueue';
import { hasUserVisibleText } from '../../shared/visibleText';
import { readReviewRunMeta } from '../../shared/reviewRun';
import {
  deriveAutoTitleSeed,
  reconcileSessionRefsForText,
  type AutoTitleFallbackLabels,
  type AutoTitleSeed,
} from '../../shared/agentInputQueue';
import { providerSecretStorageKey } from '../../shared/providerSecrets';
import {
  GHOST_HOST_NOTICE_KEYS,
  GHOST_SECRET_VALUE_MAX_CHARS,
  GHOST_SETUP_MAX_INTERACTION_STEPS,
  isGhostSetupErrorCode,
} from '../../shared/ghost';
import type {
  GhostSetupActionKind,
  GhostSetupAllowedAction,
  GhostSetupErrorCode,
  GhostSetupStepPhase,
} from '../../shared/ghost';
import * as messageService from '@/lib/messageService';
import * as sessionService from '@/lib/sessionService';
// device-link 透明传输:远程(被控设备)会话的操作/读取走隧道,本地会话零变化。
import {
  makerApiFor,
  makerApiForDevice,
  getSessionFor,
  listMessagesFor,
  aroundMessagesFor,
  aroundMessagesByClientIdFor,
  aroundMessagesByClientIdForDevice,
  dismissErrorMessageFor,
  isRemoteSession,
  isRemoteSessionSticky,
  type RoutableMaker,
} from '@/lib/makerTransport';
import {
  remoteProjectsStore,
  requestRemoteReseed,
} from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { clearCachedMessages, readCachedMessages } from '@/features/device-link/mirrorCacheClient';
import {
  noteRemoteSessionSyncCompleted,
  noteRemoteSessionSyncStarted,
  setRemoteTerminalErrorProbe,
} from '@/lib/sessionAttentionStore';
import {
  applyRemoteSessionActivity,
  removeRemoteSessionActivityEntry,
} from '@/features/device-link/remoteSessionActivityStore';
import { setMirrorEffort, setMirrorFast } from '@/state/deviceLinkModelMirror';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';
import { emitAutoTitlePreview, emitAutoTitlePreviewCleared, emitPatch } from '@/lib/sessionsBus';
import { createLogger } from '@/lib/logger';
import {
  markSessionAutomaticHistoryLoadCompleted,
  resetSessionAutomaticHistoryLoadCompletion,
} from '@/lib/sessionScrollStore';
import { extractIpcError } from '@/utils/ipcError';
import { tryBeginAgentSendDispatch } from '@/lib/agentSwitchCoordinator';
import { getUserPrompt } from '@/lib/userPromptStore';
import { getMakerMemoryEnabled } from '@/lib/memorySettingsStore';
import {
  isRemoteDataOwnerPushCurrent,
  resetRemoteDataOwnerPushFence,
} from '@/lib/remoteDataOwnerPushFence';
import { buildUserMessageAttachmentPayload } from '@/lib/messageAttachmentPayload';
import {
  parseIssueEnvRegion,
  parseOptionalGithubUserIdentity,
  parseIssueSuggestedPublicName,
  parseIssueSubmissionIdentity,
  type IssueSubmissionIdentity,
} from '@/lib/issueConfirmPayload';
import { resolveStaleCodexSubscriptionValueEstimate } from '../../shared/codexSubscriptionValue';
import { normalizeTurnUsageDetails, type TurnUsageDetails } from '../../shared/turnUsageDetails';
import {
  legacyUsdMoney,
  normalizeRegionalMoney,
  type RegionalMoney,
} from '../../shared/regionalMoney';
import type { PersistedSessionReferenceMetadata } from '../../shared/sessionReferenceMetadata';
import { isSessionUpgrading } from '@/state/ccMgrUpgradeStore';
import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { openUrlInSidebarBrowser } from '@/features/right-sidebar/lib/openInSidebarBrowser';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import {
  extractUsageLimitRecoveryHint,
  type UsageLimitRecoveryHint,
} from '@/lib/usageLimitRecovery';
import { parseReconnectAttemptMessage } from '@/utils/networkError';

import {
  materializeAnnotatedAttachmentsForSend,
  needsAnnotationMaterialize,
} from '@/lib/annotationBurnIn';

const log = createLogger('CcAgentChatStore');
// perf-baseline(与 MessageStream / sidebar 的 perf/session-switch 探针同通道):
// history:ingest 量化首次历史加载的同步摄取段(mapServerMessages + mergeMessages
// + setState),用于会话切换卡顿归因;<30ms 不打,避免噪音。
const perfLog = createLogger('perf/session-switch');
export const EMPTY_TASK_UPDATES: ReadonlyMap<string, AgentTaskUpdate> = new Map();
/** Max consecutive legacy CC/XD auto auth-retries per remote session before surfacing the error. */
const MAX_REMOTE_AUTH_RETRIES = 2;
/** Bound best-effort main-side /clear guard arming so local cleanup cannot hang forever. */
const CLEAR_SESSION_GUARD_TIMEOUT_MS = 500;
const REMOTE_CONTENT_TRUNCATED_PLACEHOLDER = '[remote content truncated: payload too large]';

/**
 * maker-core 远端分支把不可恢复的远端错误编码成 `[REMOTE_*] 英文兜底文案` 的
 * message(见 packages/maker-core/src/agents/claude-code/index.ts)。renderer
 * 直接显示会裸露英文 code,这里把已知 code 映射成 i18n 文案(规则 17)。未知
 * code / 漏翻时回退到去掉 `[CODE]` 前缀的英文原文,绝不把 `[REMOTE_*]` 显给用户。
 */
const BRACKET_ERROR_CODE_RE = /(?:^|: Error: )\[([A-Z0-9_]+)\]\s*([\s\S]*)$/;
const REMOTE_ERROR_CODE_RE = /(?:^|: Error: )\[(REMOTE_[A-Z_]+)\]\s*([\s\S]*)$/;
const DEVICE_LINK_CHAT_ERROR_CODES: ReadonlySet<string> = new Set([
  'DEVICE_LINK_CONTROL_DISABLED',
  'DEVICE_LINK_MEDIA_TRANSFER_FAILED',
] as const);
/**
 * 非 `REMOTE_*` / 非 device-link 的会话级提示码 —— agent runtime 用同一套
 * `[CODE] fallback text` 约定把「这件事用户该知道」告诉 renderer,不新增事件类型。
 * 未登记的 code 仍然回退到英文兜底文案(绝不把 `[CODE]` 裸露给用户)。
 */
const AGENT_RUNTIME_CHAT_ERROR_CODES: ReadonlySet<string> = new Set([
  // Auto 档下审阅器没跑起来(与「模型判定动作危险」不同,后者刻意保持静默)。
  'AUTO_REVIEW_UNAVAILABLE',
] as const);
const REMOTE_HEAVY_INBOUND_CHANNELS: ReadonlySet<string> = new Set([
  'maker:event',
  'maker:status-changed',
  'maker:input:projection',
  'maker:interaction-request',
  'maker:interaction-dismissed',
  'local-db:messages:created',
  'usage:message-turn-cost',
  'maker:session-model-pref:changed',
]);

type RemoteTerminalSessionTombstone = {
  deviceId: string;
  status: 'deleted' | 'archived';
};

/**
 * A terminal session push is a lifecycle boundary, not just another clear.
 * Keep that fact outside the evictable session slice so late remote frames
 * cannot call getOrCreateState and resurrect a deleted/archived task.
 */
const remoteTerminalSessionTombstones = new Map<string, RemoteTerminalSessionTombstone>();

function markRemoteTerminalSessionTombstone(
  deviceId: string,
  sessionId: string,
  status: 'deleted' | 'archived',
): void {
  const previous = remoteTerminalSessionTombstones.get(sessionId);
  if (previous?.status === 'deleted') return;
  remoteTerminalSessionTombstones.set(sessionId, { deviceId, status });
}

function isRemoteTerminalSessionTombstoned(sessionId: string, deviceId: string): boolean {
  const tombstone = remoteTerminalSessionTombstones.get(sessionId);
  return tombstone !== undefined && tombstone.deviceId === deviceId;
}

function isRemoteDeletedSessionSendBlocked(sessionId: string): boolean {
  const deviceId = getStickySessionDeviceId(sessionId);
  if (!deviceId) return false;
  return (
    remoteTerminalSessionTombstones.get(sessionId)?.deviceId === deviceId &&
    remoteTerminalSessionTombstones.get(sessionId)?.status === 'deleted'
  );
}

/**
 * Archived tasks may be explicitly unarchived.  Only an authoritative active
 * session row from a fresh remote snapshot can release that tombstone; an
 * out-of-order `status: active` patch is intentionally ignored and merely
 * requests a reseed through remoteProjectsStore.
 */
function releaseArchivedRemoteTerminalTombstones(): void {
  if (remoteTerminalSessionTombstones.size === 0) return;
  const activeSessions = remoteProjectsStore.getMergedRemoteSessions();
  for (const [sessionId, tombstone] of remoteTerminalSessionTombstones) {
    if (tombstone.status !== 'archived') continue;
    const active = activeSessions.some(
      (session) =>
        session.id === sessionId &&
        session.deviceLinkDeviceId === tombstone.deviceId &&
        session.status !== 'archived' &&
        session.status !== 'deleted',
    );
    if (active) remoteTerminalSessionTombstones.delete(sessionId);
  }
}

function resolveEstimatedTurnCostUsd(
  rawCostUsd: number,
  turnCostIsEstimate: boolean,
  turnUsageDetails: TurnUsageDetails | undefined,
  modelOverride?: string | null,
): number {
  if (!turnCostIsEstimate) return rawCostUsd;
  const recomputed = resolveStaleCodexSubscriptionValueEstimate(
    rawCostUsd,
    turnUsageDetails,
    modelOverride,
  );
  return typeof recomputed === 'number' && Number.isFinite(recomputed) && recomputed > 0
    ? recomputed
    : rawCostUsd;
}

export function decodeRemoteErrorMessage(msg: string): string {
  const bracketMatch = BRACKET_ERROR_CODE_RE.exec(msg);
  const bracketCode = bracketMatch?.[1];
  if (
    bracketCode &&
    (DEVICE_LINK_CHAT_ERROR_CODES.has(bracketCode) ||
      AGENT_RUNTIME_CHAT_ERROR_CODES.has(bracketCode))
  ) {
    return i18n.t(`chat.remoteError.${bracketCode}`, {
      defaultValue: bracketMatch[2] || msg,
    });
  }
  const m = REMOTE_ERROR_CODE_RE.exec(msg);
  if (!m) return msg;
  const fallback = m[2] || msg;
  return i18n.t(`chat.remoteError.${m[1]}`, { defaultValue: fallback });
}
// 专门给"出现在用户面前的红色 ErrorBanner"打日志,scope 以 `maker/` 开头
// 是为了让它落在统一 agent 流(agent-*.ndjson,跟 agent runtime 抛出的底层错误同一份,
// 且带 sessionId 可按 session 过滤),用户截图反馈时直接拉这一份就能看到完整因果链。
const bannerErrLog = createLogger('maker/error-banner');
import {
  type ImageRef,
  type PastedTextRange,
  type SlashCommandRange,
  parseUserContent,
  stringifyUserContent,
} from '@/lib/imageRef';
import {
  saveDraft as saveComposerDraft,
  plainTextToTiptapDoc,
  setRemoteOptimisticAttachmentUrls,
} from '@/lib/composerDraftStore';
import {
  clearIssueConfirmDraft,
  clearIssueConfirmDraftsForSession,
  type IssueConfirmDraft,
} from '@/lib/issueConfirmDraftStore';
import {
  canStartComposerSteer,
  canStartQueuedSteer,
  deriveErrorRetryText,
  isQueuePausedWithPending,
  isSendBusyForQueue,
  popQueueTailState,
} from '@/lib/makerQueueState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Mirror: also defined in main/agentManager.ts
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface ChatMessage {
  clientId: string;
  /** chat-text-quote:开头 blockquote 为引用功能产出(渲染判据),见 imageRef.ts。 */
  quotesEncoded?: boolean;
  /** Hidden semantic projection metadata for rich user-message references. */
  agentReferences?: AgentInputReference[];
  /** Local display metadata; the Agent receives `content` without markers. */
  pastedTextRanges?: PastedTextRange[];
  /** Exact slash ranges; empty means the composer confirmed no slash command. */
  slashCommandRanges?: SlashCommandRange[];
  /**
   * DB-backed remote history row order. Required for stable merges when several
   * messages share the same createdAt millisecond.
   */
  rowid?: number;
  role: MessageRole;
  content: string;
  /** Display-safe summaries for resolved session links in this user message. */
  sessionReferences?: PersistedSessionReferenceMetadata[];
  /**
   * SDK 的 tool_use_id (toolu_vrtx_...)。
   * - tool_use 消息: 自身的 id
   * - tool_result 消息: 关联的 tool_use id (多对一时存第一个,其余用 adjacency 兜底)
   * MessageStream 用它做 toolUseId-based 配对,不再依赖消息相邻顺序——这样
   * 在 case 'done' 给 SDK 不发 tool_use_summary 的工具自建 orphan
   * tool_result 消息时,即便插在末尾或重新从 DB 加载乱序,也能正确配对。
   */
  toolUseId?: string;
  toolName?: string;
  toolInput?: unknown;
  /**
   * Renderer-local timestamp for the latest in-place `update_plan` payload.
   * `createdAt` remains the persisted message creation time and must not be
   * rewritten because it also participates in message ordering.
   */
  planUpdatedAtMs?: number;
  /** Main stamped this persisted Codex plan at the successful done boundary. */
  terminalPlanSnapshot?: boolean;
  /** Host time when the successful Codex plan seal was applied. */
  terminalPlanAtMs?: number;
  /**
   * 产生这条消息的模型 raw id(读自 agentMeta.model)。对 subagent 子消息而言
   * 即子代理实际跑的模型(如 'claude-haiku-4-5-20251001')。仅 SDK 带 model 的
   * 消息有值。用于在 Agent/Task 工具行上反查并渲染子代理模型 chip。
   */
  model?: string;
  /**
   * Host 在 SDK `done` 边界写入的持久化 turn seal。通常位于最后一条 assistant；
   * 无 assistant 文本的 Codex 失败轮会把 false 写在所属 update_plan 行，防止后续轮次
   * 的成功边界误收口旧计划。
   */
  turnCompleted?: boolean;
  /**
   * 若本消息由 subagent(Agent/Task 工具)spawn 的子代理产生,则为父 Agent
   * 工具调用的 toolUseId(读自 agentMeta.parentUuid = SDK parent_tool_use_id)。
   * 主线程消息无此字段。MessageStream 据此建 parentToolUseId→model 映射,
   * 把子代理模型挂回对应的 Agent 行。命名避开 transcriptParentUuid 混淆。
   */
  parentToolUseId?: string;
  isStreaming?: boolean;
  /**
   * agent-meta: user 消息走"乐观显示先、main 落库后转正"的两阶段。
   * 落库未确认时 true；收到 cc-agent:user-message-persisted 事件后清掉。
   * UI 可以据此显示 spinner / 灰色态（本轮不做，留给后续）。
   */
  isPendingPersist?: boolean;
  /**
   * 意识拦截(订阅槽①):本条用户消息被某意识钩子拦下(未入库、未起 turn)。
   * 气泡照常显示(未发出),其下渲一条 error 红条,内容 = 意识返回的文本
   * (reason,直接显示,主机不加框)。用户用消息的编辑铅笔改了重发(普通
   * 重发,不 rewind)。纯 UI 态,不落库:离开会话再回来即消失。
   */
  blockedByGhost?: { ghostId: string; ghostName: string; reason: string };
  /**
   * 出口钩子(will-assistant-message)后台处理中标记:该 assistant 回复已显示,
   * 意识还在跑(润色/自绘,最长 5 分钟)。AssistantMessage 据此挂一条"意识处理中"
   * 轻指示;意识返回(rewrite/render)或超时后由 pending=false 广播清掉。纯 UI 瞬态。
   * 注:自绘卡本身走 ghostCardStore(byCallId 命中本条 clientId),不在此字段。
   */
  ghostReplyPending?: boolean;
  /**
   * scheduler 注入的 user 消息来源标记(读自 agentMeta.origin),UserMessage
   * 据此在气泡上方渲染"由自动化任务发送"标签。手动输入的消息无此字段。
   */
  automationOrigin?: MessageAutomationOrigin;
  /** user 消息投递方式:普通新 turn 或运行中 steer。 */
  delivery?: 'turn' | 'steer';
  /** Hook 来源元数据(IM 平台 + 用户干净原文 + thread 上下文),UserMessage 据此渲染 Cindy 任务卡片。 */
  hookSource?: {
    im: string;
    channelName?: string | null;
    userText?: string;
    threadContext?: Array<{ author: string; text: string; isBot?: boolean }>;
  };
  /** /goal 目标设定/更新标记:该 user 消息是目标文案,renderer 在气泡上方渲「目标 / 目标已更新」徽标。 */
  goalBadge?: { updated: boolean };
  /** F7.2: ask_user message fields */
  askUserStatus?: 'pending' | 'answered' | 'expired';
  askUserRequestId?: string;
  askUserReply?: string | null;
  /** All questions in this AskUserQuestion call */
  askUserQuestions?: AskUserQuestionItem[];
  /** All answers: questionText → reply */
  askUserAnswers?: Record<string, string>;
  // Legacy single-question fields (kept for history compat)
  askUserOptions?: Array<{ label: string; description?: string }>;
  askUserPageIndicator?: string;
  /**
   * F-CMD: local-only system card (not persisted)。
   * 例外:'goal-complete' 不是 ephemeral —— 它由 mapServerMessages 从持久化的
   * agentMeta.goalCompletion 派生(仿 fork divider 从 session 元数据派生),重开会话仍在。
   */
  systemCardType?:
    | 'help'
    | 'cost'
    | 'context'
    | 'pwd'
    | 'status'
    | 'compact'
    | 'cmd'
    | 'goal-complete'
    | 'goal-resumed'
    | 'learn'
    | 'review'
    | 'auto-resume'
    /**
     * 中断自愈**进行中**(退避窗口内,由 projection.autoResumePending 驱动的 ephemeral
     * 卡)。与 'auto-resume' 的分工:那条是自愈**已完成**、由落库的 autoResume user 行
     * 派生、重开会话仍在;这条只活在退避那几秒,补发一发出就撤掉。
     */
    | 'auto-resume-pending'
    | 'agent-switch';
  systemCardData?: Record<string, unknown>;
  /** FP-3: plan_review message fields */
  planReviewStatus?: 'pending' | 'approved' | 'revised' | 'expired' | 'cancelled';
  planReviewRequestId?: string;
  planReviewPlan?: string; // Markdown content
  planReviewFilePath?: string; // Path to the plan file
  planReviewFeedback?: string; // User's revision feedback (when revised)
  /**
   * role='error' 持久化行的稳定失败原因 key(maker-core 下发,如 'empty-response' /
   * 'turn-failed')。ErrorMessageCard 渲染时优先按它走 i18n,无 key 时显示 content
   * 里的原始 message 文案。live 报错仍走 ErrorBanner(store.error),与本字段无关。
   */
  errorReason?: string;
  /**
   * 产生这条 error 行的 provider(错误发生时刻的快照,main 侧 onTurnErrorEvent
   * 从 session-provider-store 同步取值落进 content.providerId)。错误分类必须绑
   * 这个来源,不能用可中途切换的 session.providerId —— 否则恢复历史错误时会把
   * 别家 provider 的额度错误误判成 Cindy AI 余额不足(或反向丢失充值入口)。
   * undefined = 来源不明(老行 / 未显式选择 provider),读侧不启用余额分类。
   */
  errorProviderId?: string;
  /**
   * interrupted-turn-resume:app 退出中断行(errorReason='app-exit-interrupted')
   * 被用户点「忽略」后置 true(content.dismissed 持久化)。banner 与红点判定
   * 都排除 dismissed 的行。其它 error 行恒为 undefined。
   */
  errorDismissed?: boolean;
  /**
   * [UI_ACTION_TRIGGER] 合成指令行(隐藏续跑 / Mivo 图片按钮):保留在 messages
   * 里参与时序判定(error-tail banner 的「尾部」不能忽视它 —— 过滤掉会让旧
   * error 行在续跑已被接受后仍被判为尾部,banner 重现可重复发送,review P2),
   * 但 MessageStream 渲染 null、content 置空不外泄原文。
   */
  isSyntheticTrigger?: boolean;
  /**
   * image-local-cache: image attachments for rendering in the message stream.
   * Two shapes coexist:
   *   - ImageRef ({ url, mimeType, originalName }) — primary, persisted form.
   *   - { base64, mimeType, originalName? }       — F6 fallback, in-memory only.
   * Renderers branch on `'url' in img` to pick the right `<img src>`.
   */
  images?: Array<ImageRef | { base64: string; mimeType: string; originalName?: string }>;
  /** F-MSG-DOC: document/file attachments (path) for rendering as @path in message stream */
  files?: Array<{ name: string; path: string }>;
  /**
   * Legacy CC/XD remote auth-retry / cc-mgr upgrade retry payload: the original send's
   * attachments + mentions, kept on the user message so an auto-retry (or the
   * UpgradeBanner resend) can replay the exact same turn. Set at send time,
   * not persisted to the server.
   */
  retryFiles?: AttachedFile[];
  retryMentions?: MentionedResource[];
  /**
   * Thinking message fields (extended thinking from Anthropic API).
   *
   * thinking messages stream in memory, then persist once at final/redacted so
   * reopening a session can restore the final card without per-token writes.
   *
   * - thinkingDurationMs: 0 while streaming; final ms when block closes.
   * - thinkingStartedAt:  Date.now() at first delta (used for live elapsed display).
   * - thinkingRedacted:   true → server-redacted, no plaintext available.
   */
  thinkingDurationMs?: number;
  thinkingStartedAt?: number;
  thinkingRedacted?: boolean;
  /** Epoch ms of the persisted final/redacted thinking event. */
  thinkingFinishedAtMs?: number;
  /**
   * ISO timestamp used by MessageActionBar to render relative-time text
   * ("刚刚" / "N 分钟前" / ...). Set at creation time for live messages and
   * preserved from server `Message.createdAt` on history restore.
   * Optional: hook tolerates undefined and renders empty (no crash).
   */
  createdAt?: string;
  /**
   * Per-turn 费用 (USD) — main 在 turn 结束时挂到该轮最后一条 assistant 上
   * (agentMeta.turnCostUsd 持久化 + usage:message-turn-cost 实时推送)。
   * 仅 assistant 消息可能有值;MessageActionBar 据此显示"本轮消耗"。
   */
  turnCostUsd?: number;
  turnMoney?: RegionalMoney;
  /** true = 订阅模式下的 token 价值;false = API 账单 cost / API 单价折算 cost。 */
  turnCostIsEstimate?: boolean;
  /** 用户从最近一条真实输入至本消息的累计成本；只用于消息旁展示。 */
  userTurnCostUsd?: number;
  userTurnMoney?: RegionalMoney;
  userTurnCostIsEstimate?: boolean;
  /** 本轮 token/cache 明细;旧消息或未拿到 usage 时缺省。 */
  turnUsageDetails?: TurnUsageDetails;
  /**
   * 本轮模型降级标记 — main 在 turn 结束检测到所选模型家族整轮缺席于实际
   * modelUsage 时挂到该轮收尾 assistant 上(agentMeta.modelMismatch 持久化 +
   * usage:message-model-mismatch 实时推送)。AssistantMessage 渲染降级提示行。
   */
  modelMismatch?: { selected: string; actual: string };
  /** 历史行由 device-link 压缩过;merge 时不能覆盖控制端已有的完整实时内容。 */
  remoteContentTruncated?: boolean;
  /** 历史页由 device-link 裁掉过部分行;分页状态需保持可继续加载。 */
  remoteRowsTrimmed?: boolean;
  /**
   * 这一行来自远程会话的本地冷缓存(见 features/device-link/mirrorCacheClient.ts),
   * **不是**被控端本次确认过的权威行。首拉落地前必须整批剔除:mergeMessages 只增不删,
   * 留着的话被控端 /clear、rewind 或删掉的消息会在控制端永久残留。纯内存标记,不落 DB。
   */
  cacheHydrated?: boolean;
}

export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentTaskUpdate {
  provider: 'claude-code' | 'codex' | 'pi';
  taskId: string;
  parentToolUseId?: string;
  status: AgentTaskStatus;
  title?: string;
  description?: string;
  summary?: string;
  outputFile?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
  lastToolName?: string;
  taskType?: string;
  workflowName?: string;
  /** `null` is an explicit live-update instruction to clear a stale model badge. */
  model?: string | null;
  reasoningEffort?: string;
  receiverThreadIds?: string[];
  /**
   * workflow 逐 agent 进度树(taskType=local_workflow 时由 task_progress 事件携带)。
   * CLI 对纯心跳帧节流省略本字段,merge 必须沿用上一帧,绝不能清空。
   * 与 `@cindy/maker-shared/agent-task` 的 AgentTaskUpdate 保持 lockstep。
   */
  workflowProgress?: WorkflowProgressEntry[];
  createdAt?: string;
  updatedAt?: string;
}

export interface AgentStatus {
  status: string;
  tokenUsage: number;
  /** Accumulated session cost in USD across all turns. */
  costUsd: number;
  /** Current context window fill level (latest single API call input_tokens). */
  contextTokens: number;
  /** Context window size from SDK modelUsage (0 = not yet known). */
  contextWindow: number;
  isRunning: boolean;
  startedAt: number | null;
  /**
   * Side-channel running (mivo MJ 按钮等不走 LLM 的后台任务)。
   * RunningStatusBar 据此把 token 计数行隐藏掉, 避免显示"上一轮残留 718 tokens"
   * 误导用户以为这次 mivo 也消耗了 token。
   */
  sideTaskRunning?: boolean;
}

/** F-PERM-2: Pending permission request data stored per-session. */
export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
  suggestions?: unknown[];
}

/** F7.2: Pending ask-user-question data — holds ALL questions for the wizard. */
export interface PendingAskUser {
  requestId: string;
  questions: AskUserQuestionItem[];
}

export type PluginSetupAction = GhostSetupAllowedAction;
type PluginSetupInlineFormAction = Extract<GhostSetupAllowedAction, { kind: 'inline_form' }>;

export interface PendingPluginSetup {
  requestId: string;
  revision: number;
  /** Settled but retained briefly so the card can show terminal feedback. */
  terminal?: true;
  ghost: {
    id: string;
    name: string;
    iconDataUrl?: string;
  };
  intro?: string;
  steps: Array<{
    id: string;
    groupId: string;
    groupMode: 'any_of';
    title: string;
    description: string;
    phase: GhostSetupStepPhase;
    action?: PluginSetupAction;
    /** Preferred stable failure identity; localized by this Renderer. */
    errorCode?: GhostSetupErrorCode;
    /** Legacy controlled-Desktop fallback only. */
    errorMessage?: string;
  }>;
}

function isPluginSetupInteractionPending(setup: PendingPluginSetup | null): boolean {
  return setup !== null && setup.terminal !== true;
}

function hasPendingPluginSetupInteraction(
  current: PendingPluginSetup | null,
  queue: readonly PendingPluginSetup[],
): boolean {
  return (
    isPluginSetupInteractionPending(current) ||
    queue.some((setup) => isPluginSetupInteractionPending(setup))
  );
}

export type PluginSetupViewerState = 'expanded' | 'minimized';

export interface PluginSetupCommandInFlight {
  requestId: string;
  action: 'run_action' | 'submit_form' | 'cancel';
  actionId?: string;
}

export interface PluginSetupInlineFormValues {
  value: string;
}

/**
 * F-AUQ-DRAFT: Per-session draft of in-progress AskUserQuestion answers.
 *
 * Why this exists: AskUserQuestionPrompt is rendered inside a conditional
 * branch in CCAgentSessionView (`pendingAskUser ? <Prompt> : ...`). Switching
 * to another session unmounts it, losing local useState (currentIndex /
 * answers). On return, the prompt remounts with `useState(0)` and the user is
 * forced to re-answer from step 1.
 *
 * The draft is keyed by `requestId` so that a NEW question batch (different
 * requestId) is not contaminated by a stale draft — the component compares
 * `draft.requestId === pending.requestId` before hydrating.
 *
 * Only `currentIndex` + `answers` are persisted; `selectedLabels` /
 * `customInput` / `showCustomInput` are derived (see
 * `computeSelectionForIndex` in AskUserQuestionPrompt) and intentionally
 * recomputed on remount to avoid double-source-of-truth.
 */
export interface AskUserDraft {
  requestId: string;
  currentIndex: number;
  answers: Record<string, string>;
}

/** FP-3: Pending plan-review data for the Plan Viewer Card. */
export interface PendingPlanReview {
  requestId: string;
  plan: string;
  planFilePath: string;
}

/**
 * submit_github_issue 工具的提交前确认卡片数据(kind='issue_confirm')。
 * main 侧 IssueConfirmBridge broadcast 过来,用户在 IssueConfirmCard 上
 * 编辑/确认/取消后经 respondToIssueConfirm 回包。ephemeral —— 不落库,
 * 超时/会话清理由 main 兜底并广播 INTERACTION_DISMISSED 清卡。
 */
export interface PendingIssueConfirm {
  requestId: string;
  draft: IssueConfirmDraft;
  /**
   * 只读展示的环境信息(main 会附进 issue body)。`region` 是本构建的区域身份
   * (中国版 / 国际版 / 开发版);main 侧 payload 未带时按 undefined 处理,卡片
   * 省略该段而不是猜一个区域。
   */
  env: {
    appVersion: string;
    platform: string;
    arch: string;
    osVersion: string;
    region?: CindyRegion;
  };
  /**
   * Main 提供的默认身份。新版 Main 始终传平台 Bot；旧版 Main 可能已经固定为
   * GitHub 用户，Renderer 必须保留该形状，不能让升级中的确认卡静默消失。
   */
  submissionIdentity: IssueSubmissionIdentity;
  /** 当前验证可用时才提供的 GitHub 用户本人身份。 */
  githubUserIdentity?: Extract<IssueSubmissionIdentity, { kind: 'github-user' }>;
  /** 平台代发的建议公开署名；缺失时卡片使用本地化“匿名”。 */
  suggestedPublicName?: string;
}

/**
 * ghost_call 过户 workdir 外文件的确认卡片数据(kind='ghost_grant_confirm')。
 * main 侧 GhostGrantConfirmBridge broadcast 要过户的文件清单(路径/大小/图片
 * 缩略预览);用户点允许后 main 才继续过户给意识。ephemeral —— 不落库,
 * 超时/会话清理由 main 兜底并广播 INTERACTION_DISMISSED 清卡。
 */
export interface PendingGhostGrantConfirm {
  requestId: string;
  ghostId: string;
  ghostName: string;
  /**
   * attachments = 媒体文件交给意识;dir = 上传目录/文件;save_dir = 允许意识
   * 往目录里存文件;fs_write = 意识申请写工作目录文件(会话 permission 为
   * 逐条确认档时逐次弹,同目录本会话批一次);workspace = 意识申请以该目录
   * 为工作区在侧边栏创建/复用会话入口(不过户字节)。
   */
  lane: 'attachments' | 'dir' | 'save_dir' | 'fs_write' | 'workspace';
  items: Array<{
    name: string;
    absPath: string;
    size: number;
    mimeType?: string;
    previewDataUrl?: string;
    isDirectory?: boolean;
    fileCount?: number;
  }>;
}

/**
 * rename_sessions 工具的写入前确认卡片数据(kind='rename_sessions_confirm')。
 * main 侧确认桥 broadcast 当前将写入的变更清单;用户确认后 main 才继续写库。
 */
export interface PendingRenameSessionsConfirm {
  requestId: string;
  changes: Array<{
    sessionId: string;
    currentTitle: string | null;
    newTitle: string;
    workingDir: string | null;
    updatedAt: string;
  }>;
}

/** FP-3: Plan Viewer Card display state. */
export type PlanViewerState = 'expanded' | 'half' | 'minimized' | 'edit';

/**
 * F-AUQ-MIN-1: AskUserQuestion viewer display state.
 * - expanded:  full-height Prompt card (default for every new pendingAskUser)
 * - minimized: 880×44 collapsed bar in the ChatInput slot (UI-only fold; SDK
 *   stays suspended, pendingAskUser is unchanged)
 *
 * Lives at SessionChatState top level for symmetry with `planViewerState`.
 * Only meaningful when `pendingAskUser != null`. Never persisted (no IPC, no
 * localStorage, no DB column).
 *
 * 重置行为：会话切换后回到 'expanded' 由 CCAgentSessionView 的 sessionId useEffect
 * 负责（不在 store 内做，因为 store 不感知"当前活跃 sessionId"）。
 */
export type AskUserViewerState = 'expanded' | 'minimized';

/**
 * F-QUEUE-1 / F-QUEUE-DEFER: Queued user message — captured at send time so
 * subsequent UI changes (model swap, permission mode swap, workingDir change)
 * don't affect already-queued messages.
 *
 * F-QUEUE-DEFER (2026-05): The user-facing ChatMessage (the bubble in the
 * message stream) is NOT pushed to `messages[]` at sendMessage time anymore.
 * It rides along inside `chatMessage`; main input projection decides whether
 * it remains queued or has been accepted into the visible message stream.
 * Until then, the message lives only in `pendingQueue` and is rendered by
 * `PendingQueuePanel` above the ChatInput.
 */
export interface QueuedMessage extends Omit<
  AgentInputQueuedMessage,
  'chatMessage' | 'files' | 'mentions'
> {
  files?: SerializedAttachedFile[];
  mentions?: MentionedResource[];
  /**
   * F-QUEUE-DEFER: 预构建的 user ChatMessage 形态。sendMessage 时一次性 build
   * 好(含 images/files/createdAt),交给 main input coordinator 做接受/排队判定。
   * 在 main projection 确认接受前 UI 只能在 `pendingQueue` 里看到这条(由
   * PendingQueuePanel 渲染),消息流里不出现。
   */
  chatMessage: ChatMessage & { role: 'user' };
  /** device-link 控制端本地态：enqueue 尚未确认受理；不进入 wire / DB。 */
  isPendingEnqueue?: boolean;
}

interface RemoteOptimisticSendRecord {
  queued: QueuedMessage;
  recoverySequence: number;
  /** 注册发送时的账号代际；切号后任何迟到 Promise 都必须失效。 */
  dataOwner: DataOwnerGeneration;
  /** 首次解析到的被控设备；重试期间绝不重新按 sessionId 路由。 */
  deviceId: string;
  /** Click-time remote `/clear` token; null means the controller knew no clear yet. */
  /** `undefined` means the controller has not observed a boundary yet. */
  expectedClearBoundaryMs: number | null | undefined;
  /** Clear generation captured at click time, used when the token was unknown. */
  clearGeneration: number;
  /** An unknown-token record is probing the pinned host before first dispatch. */
  clearBoundaryProbeInFlight: boolean;
  /** The first probe settled, including the legacy projection-without-token path. */
  clearBoundaryProbeCompleted: boolean;
  /** A stale-token rejection may reopen the boundary probe at most once. */
  clearBoundaryRecoveryAttempted: boolean;
  /** Skip the cached boundary once after a stale-token rejection. */
  forceClearBoundaryProbe: boolean;
  deliveryMode: MessageDeliveryMode;
  accepted: boolean;
  currentlyQueued: boolean;
  phase: 'preflight' | 'dispatching' | 'waiting-for-connection' | 'accepted';
  dispatching: boolean;
  attempt: number;
  beforeEnqueue?: () => Promise<boolean>;
  preflightCompleted: boolean;
  /** 标注附件仍在本机烧录；完成前必须挡住本条及后续 FIFO 派发。 */
  materializationPending: boolean;
  /** steer 已可能送达但 ACK 丢失；后续 pump 只对账，绝不再次 steer。 */
  steerDispatchUncertain: boolean;
  authRetryPersistOnProjectionError?: SendMessageOpts['authRetryPersistOnProjectionError'];
  onRemoteOptimisticFailure?: SendMessageOpts['onRemoteOptimisticFailure'];
  /** Media needed by either dispatch or composer recovery while this item is pending. */
  attachmentUrls: string[];
  /** 点击时副作用中必须等附件烧录成功的部分（当前为自动起名）。 */
  onMaterializationReady?: (queued: QueuedMessage) => void;
  /** Composer already resolved true; a later pump failure must restore it. */
  composerResolvedOptimistically: boolean;
}

interface RemoteOptimisticSendScope {
  /** 点击发送时解析到的被控设备；附件物化期间不得重新路由。 */
  deviceId: string;
  /** 点击发送时的账号代际；附件物化迟到后必须按它判失效。 */
  dataOwner: DataOwnerGeneration;
  /** 跨物化/outbox 的点击顺序；owner boundary 恢复 composer 时保持 FIFO。 */
  recoverySequence: number;
  /** 点击时的 /clear 代际；预注册等待期间发生 clear 时旧发送必须失效。 */
  clearGeneration: number;
  /** Click-time remote `/clear` token used as the main-side precondition. */
  /** `undefined` means the controller has not observed a boundary yet. */
  expectedClearBoundaryMs: number | null | undefined;
}

let nextRemoteOptimisticRecoverySequence = 0;

function captureRemoteOptimisticSendScope(
  sessionId: string,
  callback?: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']>,
): RemoteOptimisticSendScope | null {
  const transition = findRemoteOptimisticComposerTransition(sessionId, callback);
  if (transition) {
    return {
      deviceId: transition.deviceId,
      dataOwner: transition.dataOwner,
      recoverySequence: transition.recoverySequence,
      clearGeneration: transition.clearGeneration,
      expectedClearBoundaryMs: transition.expectedClearBoundaryMs,
    };
  }
  const deviceId = getStickySessionDeviceId(sessionId);
  return deviceId
    ? {
        deviceId,
        dataOwner: getDataOwnerGeneration(),
        recoverySequence: nextRemoteOptimisticRecoverySequence++,
        clearGeneration: rendererClearGenerationBySession.get(sessionId) ?? 0,
        expectedClearBoundaryMs: getKnownRemoteInputClearBoundary(sessionId),
      }
    : null;
}

interface RemoteOptimisticMaterializationRecovery {
  clientId: string;
  sessionId: string;
  deviceId: string;
  dataOwner: DataOwnerGeneration;
  recoverySequence: number;
  clearGeneration: number;
  /** `undefined` means the controller has not observed a boundary yet. */
  expectedClearBoundaryMs: number | null | undefined;
  attachmentUrls: string[];
  kind: 'composer-transition' | 'materialization';
  /** Delete/archive ended the task; a late ChatInput continuation must not restore it. */
  invalidatedByPurge: boolean;
  callback?: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']>;
}

/** device-link 乐观发送事实账本，独立于可被 projection 覆盖的 pendingQueue。 */
const remoteOptimisticSends = new Map<string, Map<string, RemoteOptimisticSendRecord>>();
/**
 * Last clear token observed from the remote mirror/projection. Missing map entry
 * means unknown (for example an older controlled desktop omitted the field);
 * an entry with `null` is an explicit "never cleared" boundary.
 */
const remoteInputClearBoundaryBySession = new Map<string, number | null>();
type RemoteInputProjectionProbeState = {
  deviceId: string;
  dataOwner: DataOwnerGeneration;
  clearGeneration: number;
  status: 'ready' | 'blocked';
  /** `undefined` is a successful legacy projection with no boundary field. */
  boundary: number | null | undefined;
  error?: unknown;
};

type RemoteInputProjectionRequest = {
  deviceId: string;
  dataOwner: DataOwnerGeneration;
  clearGeneration: number;
  settled: boolean;
  promise: Promise<InputProjectionRequestResult>;
};

type InputProjectionRequestResult = {
  projection: AgentInputProjection;
  current: boolean;
};

/**
 * Projection reads are shared between the normal session hydration path and
 * the optimistic outbox preflight. Auto-title / origin reconciliation can
 * start a read in the same tick as a send; issuing a second read here both
 * wastes a weak-link round trip and can consume a different transient result.
 */
const remoteInputProjectionProbeStateBySession = new Map<string, RemoteInputProjectionProbeState>();
const remoteInputProjectionRequests = new Map<string, RemoteInputProjectionRequest>();
const remoteOptimisticMaterializationRecoveries = new Map<
  string,
  RemoteOptimisticMaterializationRecovery
>();
const remoteOptimisticLocallyRemoved = new Map<string, Set<string>>();
const remoteOptimisticSettlingTimers = new Map<
  string,
  Map<string, ReturnType<typeof setTimeout>>
>();
const remoteOptimisticSettlingChecks = new Set<string>();
const REMOTE_OPTIMISTIC_SETTLING_TIMEOUT_MS = 10_000;
const REMOTE_OUTBOX_RETRY_DELAY_MS = 1_500;
const remoteOptimisticPumps = new Map<string, Promise<void>>();
const remoteOptimisticRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Last remote presence state observed by this renderer, used to detect real reconnect edges. */
const remotePresenceOnlineByDevice = new Map<string, boolean>();
const remoteClearInFlight = new Set<string>();
/**
 * A remote clear is a content fence, not just a renderer-side reset.  When the
 * controlled device is offline the local UI may still accept new messages, but
 * those messages must not be sent until the host has acknowledged the clear.
 * Keep this state separate from `remoteClearInFlight`: the latter only covers
 * the initial invoke, while this fence survives a timeout/rejection and retries
 * on reconnect.
 */
interface RemoteClearFence {
  sessionId: string;
  deviceId: string;
  dataOwner: DataOwnerGeneration;
  clearedAt: string;
  /** Host-owned boundary observed before this clear request was dispatched. */
  clearBoundaryBeforeRequest: number | null | undefined;
  clearGeneration: number;
  /** The last clear invoke may have reached the host but lost its response. */
  deliveryUncertain: boolean;
  dispatching: boolean;
}

const remoteClearFences = new Map<string, RemoteClearFence>();
const remoteClearRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const REMOTE_CLEAR_RETRY_DELAY_MS = 1_500;
const DEFINITELY_UNDELIVERED_REMOTE_STEER_MARKERS = [
  'DEVICE_LINK_DEVICE_OFFLINE',
  'DEVICE_UNRESPONSIVE',
] as const;
const REMOTE_OPTIMISTIC_DATA_OWNER_BOUNDARY_ERROR_CODE = 'REMOTE_OPTIMISTIC_DATA_OWNER_BOUNDARY';
const REMOTE_OPTIMISTIC_SESSION_PURGED_ERROR_CODE = 'REMOTE_OPTIMISTIC_SESSION_PURGED';

function clearRemoteClearRetryTimer(sessionId: string): void {
  const timer = remoteClearRetryTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  remoteClearRetryTimers.delete(sessionId);
}

function isRemoteClearFenceCurrent(sessionId: string, fence?: RemoteClearFence): boolean {
  const current = fence ?? remoteClearFences.get(sessionId);
  return Boolean(
    current &&
    remoteClearFences.get(sessionId) === current &&
    isDataOwnerGenerationCurrent(current.dataOwner) &&
    getStickySessionDeviceId(sessionId) === current.deviceId &&
    (rendererClearGenerationBySession.get(sessionId) ?? 0) === current.clearGeneration,
  );
}

function hasPendingRemoteClearFence(sessionId: string): boolean {
  const fence = remoteClearFences.get(sessionId);
  if (!fence) return false;
  if (isRemoteClearFenceCurrent(sessionId, fence)) return true;
  clearRemoteClearRetryTimer(sessionId);
  remoteClearFences.delete(sessionId);
  return false;
}

function scheduleRemoteClearRetry(sessionId: string): void {
  if (!hasPendingRemoteClearFence(sessionId) || remoteClearRetryTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    remoteClearRetryTimers.delete(sessionId);
    void retryRemoteClearFence(sessionId);
  }, REMOTE_CLEAR_RETRY_DELAY_MS);
  remoteClearRetryTimers.set(sessionId, timer);
}

function armRemoteClearFence(sessionId: string, deviceId: string, clearedAt: string): void {
  const dataOwner = getDataOwnerGeneration();
  const clearGeneration = rendererClearGenerationBySession.get(sessionId) ?? 0;
  // `clearedAt` is the request identity and local renderer fence only. The
  // controlled host owns the authoritative boundary and may have a different
  // wall clock, so never seed the remote boundary map with the controller's
  // timestamp. The ACK projection below is the first value allowed to update
  // `remoteInputClearBoundaryBySession`.
  clearRemoteClearRetryTimer(sessionId);
  remoteClearFences.set(sessionId, {
    sessionId,
    deviceId,
    dataOwner,
    clearedAt,
    clearBoundaryBeforeRequest: getKnownRemoteInputClearBoundary(sessionId),
    clearGeneration,
    deliveryUncertain: true,
    dispatching: false,
  });
}

function noteRemoteClearDispatchError(
  sessionId: string,
  deviceId: string,
  clearedAt: string,
  error: unknown,
): void {
  const fence = remoteClearFences.get(sessionId);
  if (
    !fence ||
    fence.deviceId !== deviceId ||
    fence.clearedAt !== clearedAt ||
    !isRemoteClearFenceCurrent(sessionId, fence)
  ) {
    return;
  }
  fence.deliveryUncertain = !isDefinitelyUndeliveredRemoteMutationError(error);
}

function clearRemoteClearFence(sessionId: string, opts: { pump?: boolean } = {}): void {
  clearRemoteClearRetryTimer(sessionId);
  if (!remoteClearFences.delete(sessionId)) return;
  if (opts.pump !== false) pumpRemoteOptimisticSendsAfterCurrent(sessionId);
}

type RemoteClearProbeAssessment = 'applied' | 'not-applied' | 'inconclusive';

function assessRemoteClearProbe(
  fence: RemoteClearFence,
  projection: AgentInputProjection,
): RemoteClearProbeAssessment {
  if (!Object.prototype.hasOwnProperty.call(projection, 'clearBoundaryMs')) {
    // Legacy hosts cannot prove the clear through a projection. Preserve their
    // existing retry behavior after a successful round trip confirms the host
    // is reachable again.
    return 'not-applied';
  }
  const observed = normalizeAgentInputClearBoundaryMs(projection.clearBoundaryMs);
  if (observed === undefined) return 'inconclusive';
  const baseline = fence.clearBoundaryBeforeRequest;
  if (baseline === undefined) {
    // A current authoritative numeric projection is safer to treat as the lost
    // clear ACK than to risk destructively clearing post-request messages a
    // second time. Normal hydrated sessions always have a null/numeric baseline;
    // this is only the legacy/incomplete-hydration edge.
    return typeof observed === 'number' ? 'applied' : 'not-applied';
  }
  if (baseline === null) {
    return typeof observed === 'number' ? 'applied' : 'not-applied';
  }
  if (typeof observed !== 'number' || observed < baseline) return 'inconclusive';
  return observed > baseline ? 'applied' : 'not-applied';
}

function resolveRemoteClearFenceFromProjection(
  sessionId: string,
  deviceId: string,
  clearedAt: string,
  projection: AgentInputProjection,
  opts: { pump?: boolean; acknowledgment?: 'direct' | 'probe' } = {},
): boolean {
  const fence = remoteClearFences.get(sessionId);
  if (
    !fence ||
    fence.deviceId !== deviceId ||
    fence.clearedAt !== clearedAt ||
    !isRemoteClearFenceCurrent(sessionId, fence)
  ) {
    return false;
  }
  if (opts.acknowledgment === 'probe' && assessRemoteClearProbe(fence, projection) !== 'applied') {
    return false;
  }
  const hasAuthoritativeBoundary = Object.prototype.hasOwnProperty.call(
    projection,
    'clearBoundaryMs',
  );
  if (hasAuthoritativeBoundary) {
    const observed = normalizeAgentInputClearBoundaryMs(projection.clearBoundaryMs);
    const known = remoteInputClearBoundaryBySession.get(sessionId);
    // The host timestamp is authoritative; do not compare it with the
    // controller's `clearedAt`. We can still reject malformed or regressing
    // host projections against a token already observed from that same host.
    if (
      observed === undefined ||
      (typeof known === 'number' &&
        (observed === null || (typeof observed === 'number' && observed < known)))
    ) {
      return false;
    }
  }
  // For modern projections, record the host token and retire the fence through
  // the same acknowledgement path used by push/session patches. This keeps
  // the clock-independent ordering rule in one place even if the caller later
  // drops the rest of the projection as stale. Legacy projections omit the
  // field, so resolve immediately for compatibility.
  if (hasAuthoritativeBoundary) {
    observeRemoteInputClearBoundary(sessionId, projection.clearBoundaryMs, {
      acknowledgePendingFence: true,
    });
  } else {
    clearRemoteClearFence(sessionId, opts);
  }
  return true;
}

type RemoteClearOperationResult<T> =
  { kind: 'value'; value: T } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

async function awaitRemoteClearOperation<T>(
  promise: Promise<T>,
): Promise<RemoteClearOperationResult<T>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ kind: 'value' as const, value }),
        (error) => ({ kind: 'error' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ kind: 'timeout' }), CLEAR_SESSION_GUARD_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function retryRemoteClearFence(sessionId: string): Promise<void> {
  const fence = remoteClearFences.get(sessionId);
  if (!isRemoteClearFenceCurrent(sessionId, fence) || fence!.dispatching) return;
  const current = fence!;
  current.dispatching = true;
  try {
    if (current.deliveryUncertain) {
      const probeOperation = beginInputProjectionOperation(sessionId, current.deviceId);
      const probeResult = await awaitRemoteClearOperation(
        probeOperation.api.input.getProjection(sessionId),
      );
      if (!isRemoteClearFenceCurrent(sessionId, current)) return;
      if (probeResult.kind !== 'value') {
        scheduleRemoteClearRetry(sessionId);
        return;
      }
      const assessment = assessRemoteClearProbe(current, probeResult.value);
      if (assessment === 'applied') {
        const resolved = resolveRemoteClearFenceFromProjection(
          sessionId,
          current.deviceId,
          current.clearedAt,
          probeResult.value,
          { pump: false, acknowledgment: 'probe' },
        );
        applyInputProjectionOperationResponse(sessionId, probeOperation, probeResult.value);
        if (resolved) pumpRemoteOptimisticSendsAfterCurrent(sessionId);
        else scheduleRemoteClearRetry(sessionId);
        return;
      }
      const applied = applyInputProjectionOperationResponse(
        sessionId,
        probeOperation,
        probeResult.value,
      );
      if (!applied || assessment === 'inconclusive') {
        scheduleRemoteClearRetry(sessionId);
        return;
      }
      current.deliveryUncertain = false;
    }

    if (!isRemoteClearFenceCurrent(sessionId, current)) return;
    const operation = beginInputProjectionOperation(sessionId, current.deviceId);
    current.deliveryUncertain = true;
    const result = await awaitRemoteClearOperation(
      operation.api.input.clearSession(sessionId, current.clearedAt),
    );
    if (!isRemoteClearFenceCurrent(sessionId, current)) return;
    if (result.kind === 'value') {
      const resolved = resolveRemoteClearFenceFromProjection(
        sessionId,
        current.deviceId,
        current.clearedAt,
        result.value,
        { pump: false },
      );
      applyInputProjectionOperationResponse(sessionId, operation, result.value);
      if (resolved) pumpRemoteOptimisticSendsAfterCurrent(sessionId);
      else scheduleRemoteClearRetry(sessionId);
    } else {
      if (result.kind === 'error') {
        current.deliveryUncertain = !isDefinitelyUndeliveredRemoteMutationError(result.error);
      }
      scheduleRemoteClearRetry(sessionId);
    }
  } catch (error) {
    if (isRemoteClearFenceCurrent(sessionId, current)) {
      log.warn('remote clear retry failed; keeping clear fence:', error);
      scheduleRemoteClearRetry(sessionId);
    }
  } finally {
    if (remoteClearFences.get(sessionId) === current) current.dispatching = false;
  }
}

function createRemoteOptimisticSessionPurgedError(): Error {
  return Object.assign(
    new Error('Remote optimistic send cancelled because the session was purged'),
    {
      code: REMOTE_OPTIMISTIC_SESSION_PURGED_ERROR_CODE,
    },
  );
}

export function isRemoteOptimisticDataOwnerBoundaryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === REMOTE_OPTIMISTIC_DATA_OWNER_BOUNDARY_ERROR_CODE
  );
}

export function isRemoteOptimisticSessionPurgedError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === REMOTE_OPTIMISTIC_SESSION_PURGED_ERROR_CODE
  );
}

function remoteOptimisticSendRecords(
  sessionId: string,
  create = false,
): Map<string, RemoteOptimisticSendRecord> | undefined {
  const current = remoteOptimisticSends.get(sessionId);
  if (current || !create) return current;
  const next = new Map<string, RemoteOptimisticSendRecord>();
  remoteOptimisticSends.set(sessionId, next);
  return next;
}

function collectRemoteOptimisticAttachmentUrls(
  files: readonly { url?: string; annotationSourceUrl?: string }[] | undefined,
): string[] {
  const urls = new Set<string>();
  for (const file of files ?? []) {
    if (file.url) urls.add(file.url);
    if (file.annotationSourceUrl) urls.add(file.annotationSourceUrl);
  }
  return [...urls];
}

function syncRemoteOptimisticAttachmentUrls(): void {
  const urls = new Set<string>();
  for (const recovery of remoteOptimisticMaterializationRecoveries.values()) {
    for (const url of recovery.attachmentUrls) urls.add(url);
  }
  for (const records of remoteOptimisticSends.values()) {
    for (const record of records.values()) {
      for (const url of record.attachmentUrls) urls.add(url);
    }
  }
  setRemoteOptimisticAttachmentUrls([...urls]);
}

function findRemoteOptimisticComposerTransition(
  sessionId: string,
  callback: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']> | undefined,
): RemoteOptimisticMaterializationRecovery | undefined {
  if (!callback) return undefined;
  for (const recovery of remoteOptimisticMaterializationRecoveries.values()) {
    if (
      recovery.kind === 'composer-transition' &&
      recovery.sessionId === sessionId &&
      recovery.callback === callback
    ) {
      return recovery;
    }
  }
  return undefined;
}

function isRemoteOptimisticMaterializationRecoveryActive(
  recovery: RemoteOptimisticMaterializationRecovery,
): boolean {
  return (
    !recovery.invalidatedByPurge &&
    isDataOwnerGenerationCurrent(recovery.dataOwner) &&
    (rendererClearGenerationBySession.get(recovery.sessionId) ?? 0) === recovery.clearGeneration
  );
}

export function isRemoteOptimisticComposerTransitionActive(
  sessionId: string,
  callback: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']>,
): boolean {
  const transition = findRemoteOptimisticComposerTransition(sessionId, callback);
  return Boolean(transition && isRemoteOptimisticMaterializationRecoveryActive(transition));
}

function isRemoteOptimisticSendScopeActive(
  sessionId: string,
  scope: RemoteOptimisticSendScope,
): boolean {
  return (
    scope.dataOwner.dataOwnerId !== null &&
    isDataOwnerGenerationCurrent(scope.dataOwner) &&
    (rendererClearGenerationBySession.get(sessionId) ?? 0) === scope.clearGeneration
  );
}

function registerRemoteOptimisticSend(
  sessionId: string,
  queued: QueuedMessage,
  deviceId: string,
  deliveryMode: MessageDeliveryMode,
  dataOwner: DataOwnerGeneration,
  recoverySequence: number,
  expectedClearBoundaryMs: number | null | undefined,
  opts?: SendMessageOpts,
  recoveryFiles?: readonly AttachedFile[],
  materializationPending = false,
): RemoteOptimisticSendRecord {
  const record: RemoteOptimisticSendRecord = {
    queued,
    recoverySequence,
    dataOwner,
    deviceId,
    expectedClearBoundaryMs,
    clearGeneration: rendererClearGenerationBySession.get(sessionId) ?? 0,
    clearBoundaryProbeInFlight: false,
    clearBoundaryProbeCompleted: false,
    clearBoundaryRecoveryAttempted: false,
    forceClearBoundaryProbe: false,
    deliveryMode,
    accepted: false,
    currentlyQueued: false,
    phase: 'preflight',
    dispatching: false,
    attempt: 0,
    beforeEnqueue: opts?.beforeEnqueue,
    preflightCompleted: opts?.beforeEnqueue === undefined,
    materializationPending,
    steerDispatchUncertain: false,
    authRetryPersistOnProjectionError: opts?.authRetryPersistOnProjectionError,
    onRemoteOptimisticFailure: opts?.onRemoteOptimisticFailure,
    attachmentUrls: [
      ...new Set([
        ...collectRemoteOptimisticAttachmentUrls(queued.files),
        ...collectRemoteOptimisticAttachmentUrls(recoveryFiles),
      ]),
    ],
    composerResolvedOptimistically: false,
  };
  remoteOptimisticSendRecords(sessionId, true)!.set(queued.clientId, record);
  const composerTransition = findRemoteOptimisticComposerTransition(
    sessionId,
    opts?.onRemoteOptimisticFailure,
  );
  if (
    composerTransition?.recoverySequence === recoverySequence &&
    composerTransition.deviceId === deviceId
  ) {
    // The outbox record is now the live recovery/media owner. Remove the
    // click-time bridge only after installing it, then publish one atomic URL
    // projection so another window can never observe a zero-reference gap.
    remoteOptimisticMaterializationRecoveries.delete(composerTransition.clientId);
  }
  syncRemoteOptimisticAttachmentUrls();
  return record;
}

function registerRemoteOptimisticMaterializationRecovery(
  scope: RemoteOptimisticSendScope,
  sessionId: string,
  recoveryFiles?: readonly AttachedFile[],
  callback?: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']>,
  kind: RemoteOptimisticMaterializationRecovery['kind'] = 'materialization',
): string {
  if (kind === 'materialization') {
    const transition = findRemoteOptimisticComposerTransition(sessionId, callback);
    if (
      transition?.recoverySequence === scope.recoverySequence &&
      transition.deviceId === scope.deviceId
    ) {
      transition.attachmentUrls = [
        ...new Set([
          ...transition.attachmentUrls,
          ...collectRemoteOptimisticAttachmentUrls(recoveryFiles),
        ]),
      ];
      syncRemoteOptimisticAttachmentUrls();
      return transition.clientId;
    }
  }
  const clientId = `materializing:${crypto.randomUUID()}`;
  remoteOptimisticMaterializationRecoveries.set(clientId, {
    clientId,
    sessionId,
    deviceId: scope.deviceId,
    dataOwner: scope.dataOwner,
    recoverySequence: scope.recoverySequence,
    clearGeneration: scope.clearGeneration,
    expectedClearBoundaryMs: scope.expectedClearBoundaryMs,
    attachmentUrls: collectRemoteOptimisticAttachmentUrls(recoveryFiles),
    kind,
    invalidatedByPurge: false,
    ...(callback ? { callback } : {}),
  });
  syncRemoteOptimisticAttachmentUrls();
  return clientId;
}

/**
 * Bridge the click-time composer clear to the store's synchronous outbox
 * registration. This closes the only interval where the draft has already
 * disappeared but neither recovery ownership nor media live refs existed.
 */
export function beginRemoteOptimisticComposerTransition(
  sessionId: string,
  recoveryFiles: readonly AttachedFile[] | undefined,
  callback: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']>,
): () => void {
  if (isRemoteDeletedSessionSendBlocked(sessionId)) return () => {};
  const scope = captureRemoteOptimisticSendScope(sessionId);
  if (!scope || scope.dataOwner.dataOwnerId === null) return () => {};
  const recoveryId = registerRemoteOptimisticMaterializationRecovery(
    scope,
    sessionId,
    recoveryFiles,
    callback,
    'composer-transition',
  );
  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearRemoteOptimisticMaterializationRecovery(recoveryId);
  };
}

function clearRemoteOptimisticMaterializationRecovery(clientId: string | null): void {
  if (!clientId) return;
  const recovery = remoteOptimisticMaterializationRecoveries.get(clientId);
  if (!recovery || !remoteOptimisticMaterializationRecoveries.delete(clientId)) return;
  syncRemoteOptimisticAttachmentUrls();
  // A later FIFO item may have been waiting behind this click-time bridge.
  pumpRemoteOptimisticSendsAfterCurrent(recovery.sessionId);
}

function clearRemoteOptimisticMaterializationRecoveriesForSession(
  sessionId: string,
  opts: {
    preserveComposerTransitions?: boolean;
    markComposerTransitionsPurged?: boolean;
  } = {},
): void {
  let changed = false;
  for (const [clientId, recovery] of remoteOptimisticMaterializationRecoveries) {
    if (recovery.sessionId !== sessionId) continue;
    if (opts.preserveComposerTransitions && recovery.kind === 'composer-transition') {
      // 保留旧 clear generation 的零引用 tombstone，直到 ChatInput 的迟到 onSend
      // continuation 自己 release。否则删掉后它会重新捕获当前 generation，把已删除 /
      // 已清空任务复活。
      if (recovery.attachmentUrls.length > 0) {
        recovery.attachmentUrls = [];
        changed = true;
      }
      if (opts.markComposerTransitionsPurged) {
        recovery.invalidatedByPurge = true;
      }
      continue;
    }
    remoteOptimisticMaterializationRecoveries.delete(clientId);
    changed = true;
  }
  if (changed) syncRemoteOptimisticAttachmentUrls();
}

function restoreRemoteOptimisticMaterializationRecovery(
  clientId: string | null,
  error?: unknown,
): void {
  const recovery = clientId ? remoteOptimisticMaterializationRecoveries.get(clientId) : undefined;
  if (!recovery?.callback || !isRemoteOptimisticMaterializationRecoveryActive(recovery)) {
    return;
  }
  try {
    recovery.callback(recovery.clientId, error);
  } catch (restoreError) {
    log.warn('remote optimistic materialization restore failed:', restoreError);
  }
}

async function runRemoteOptimisticMaterialization(
  recoveryId: string | null,
  materialize: Promise<AttachedFile[] | undefined>,
  dispatch: (prepared: AttachedFile[] | undefined) => Promise<boolean>,
): Promise<boolean> {
  try {
    const prepared = await materialize;
    const accepted = await dispatch(prepared);
    if (!accepted) restoreRemoteOptimisticMaterializationRecovery(recoveryId);
    return accepted;
  } catch (error) {
    restoreRemoteOptimisticMaterializationRecovery(recoveryId, error);
    throw error;
  } finally {
    // On success dispatch has synchronously registered the outbox record before
    // its Promise resolves. On failure the callback has synchronously restored
    // the draft. Either way another live-ref domain is in place before release.
    clearRemoteOptimisticMaterializationRecovery(recoveryId);
  }
}

function markRemoteOptimisticSendAccepted(
  sessionId: string,
  clientId: string,
  queued?: QueuedMessage,
): void {
  const record = remoteOptimisticSendRecords(sessionId)?.get(clientId);
  if (!record) return;
  record.accepted = true;
  record.currentlyQueued = true;
  record.phase = 'accepted';
  record.preflightCompleted = true;
  if (queued) record.queued = queued;
}

function markRemoteOptimisticSendWaiting(sessionId: string, clientId: string): void {
  const record = remoteOptimisticSendRecords(sessionId)?.get(clientId);
  if (!record || record.accepted) return;
  record.phase = 'waiting-for-connection';
  record.dispatching = false;
  scheduleRemoteOptimisticRetry(sessionId);
}

function isDeferredRemoteSendError(error: unknown): boolean {
  // DEVICE_UNRESPONSIVE is intentionally permanent for bounded retry helpers,
  // but an input message is different: keeping it locally is safer than
  // presenting a false failure while the circuit is open.
  return (
    isTransientRemoteError(error) ||
    isDeviceUnresponsiveRemoteError(error) ||
    isRemoteInputStateUnavailableError(error)
  );
}

function isRemoteInputStateUnavailableError(error: unknown): boolean {
  return formatRemoteError(error).includes('REMOTE_OPTIMISTIC_SESSION_STATE_UNAVAILABLE');
}

function isRemoteInputPreparationSupersededError(error: unknown): boolean {
  return formatRemoteError(error).includes('REMOTE_OPTIMISTIC_INPUT_SUPERSEDED');
}

function isRemoteInputClearBoundaryError(error: unknown): boolean {
  return formatRemoteError(error).includes('REMOTE_OPTIMISTIC_INPUT_CLEARED');
}

/**
 * Steer is not idempotent on older controlled desktops. Retry only failures
 * that the renderer-facing IPC contract can prove happened before dispatch.
 * DEVICE_LINK_NOT_CONNECTED intentionally does not qualify: main folds both
 * local NOT_CONNECTED/LINK_NOT_OPEN/BACKPRESSURE and an in-flight disconnect
 * into that one code, so retrying it could duplicate a steer that already ran.
 */
function isDefinitelyUndeliveredRemoteMutationError(error: unknown): boolean {
  const formatted = formatRemoteError(error);
  return DEFINITELY_UNDELIVERED_REMOTE_STEER_MARKERS.some((marker) => formatted.includes(marker));
}

function isDefinitelyUndeliveredRemoteSteerError(error: unknown): boolean {
  return isDefinitelyUndeliveredRemoteMutationError(error);
}

function isAmbiguousRemoteSteerError(error: unknown): boolean {
  return (
    isDeferredRemoteSendError(error) &&
    !isDefinitelyUndeliveredRemoteSteerError(error) &&
    !isRemoteInputStateUnavailableError(error)
  );
}

function isRemoteAroundClientIdMiss(error: unknown): boolean {
  return formatRemoteError(error).includes('NOT_FOUND');
}

/**
 * A terminal session-state rejection must never enter the ambiguous-delivery
 * reconciliation path. That path intentionally retries a steer as enqueue
 * when both authorities report no evidence; doing that for a deleted/missing
 * task would turn a definitive failure into a duplicate or a permanently
 * settling outbox record.
 */
function isTerminalRemoteInputError(error: unknown): boolean {
  const formatted = formatRemoteError(error);
  return formatted.includes('NOT_FOUND') || formatted.includes('REMOTE_OPTIMISTIC_SESSION_PURGED');
}

function clearRemoteOptimisticRetryTimer(sessionId: string): void {
  const timer = remoteOptimisticRetryTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  remoteOptimisticRetryTimers.delete(sessionId);
}

function scheduleRemoteOptimisticRetry(sessionId: string): void {
  if (remoteOptimisticRetryTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    remoteOptimisticRetryTimers.delete(sessionId);
    void pumpRemoteOptimisticSends(sessionId);
  }, REMOTE_OUTBOX_RETRY_DELAY_MS);
  remoteOptimisticRetryTimers.set(sessionId, timer);
}

function firstUnacceptedRemoteOptimisticSend(
  sessionId: string,
): RemoteOptimisticSendRecord | undefined {
  const records = remoteOptimisticSendRecords(sessionId);
  let first: RemoteOptimisticSendRecord | undefined;
  for (const record of records?.values() ?? []) {
    if (!isDataOwnerGenerationCurrent(record.dataOwner)) {
      clearRemoteOptimisticSend(sessionId, record.queued.clientId);
      continue;
    }
    if (
      !record.accepted &&
      (first === undefined || record.recoverySequence < first.recoverySequence)
    ) {
      first = record;
    }
  }
  // beginRemoteOptimisticComposerTransition 与 outbox 注册之间仍有一个同步桥。
  // 若更早点击还停在桥上，后发记录即使已就绪也不能越过它。
  let oldestBridgeSequence = Number.POSITIVE_INFINITY;
  for (const recovery of remoteOptimisticMaterializationRecoveries.values()) {
    if (
      recovery.sessionId === sessionId &&
      isRemoteOptimisticMaterializationRecoveryActive(recovery) &&
      recovery.recoverySequence < oldestBridgeSequence
    ) {
      oldestBridgeSequence = recovery.recoverySequence;
    }
  }
  if (first && oldestBridgeSequence < first.recoverySequence) return undefined;
  return first;
}

function scheduleRemoteOptimisticSettlingRetirement(sessionId: string, clientId: string): void {
  let timers = remoteOptimisticSettlingTimers.get(sessionId);
  if (!timers) {
    timers = new Map();
    remoteOptimisticSettlingTimers.set(sessionId, timers);
  }
  if (timers.has(clientId)) return;
  const timer = setTimeout(() => {
    timers!.delete(clientId);
    if (timers!.size === 0) remoteOptimisticSettlingTimers.delete(sessionId);
    const checkKey = `${sessionId}\u0000${clientId}`;
    if (remoteOptimisticSettlingChecks.has(checkKey)) return;
    remoteOptimisticSettlingChecks.add(checkKey);
    void reconcileRemoteOptimisticSettling(sessionId, clientId).finally(() => {
      remoteOptimisticSettlingChecks.delete(checkKey);
    });
  }, REMOTE_OPTIMISTIC_SETTLING_TIMEOUT_MS);
  timers.set(clientId, timer);
}

/**
 * A projected queue item can disappear before the durable `messages:created`
 * push reaches the controller.  The settling timer is therefore only a
 * reconciliation trigger; it is never permission to delete an accepted
 * message.  Keep the record alive and retry against the pinned device until
 * the authoritative row is found (or another terminal boundary clears it).
 */
async function reconcileRemoteOptimisticSettling(
  sessionId: string,
  clientId: string,
): Promise<void> {
  const record = remoteOptimisticSendRecords(sessionId)?.get(clientId);
  if (!record || !record.accepted || !isDataOwnerGenerationCurrent(record.dataOwner)) return;

  let settled = false;
  try {
    const rows = await aroundMessagesByClientIdForDevice(record.deviceId, sessionId, clientId, {
      radius: 0,
    });
    if (!isRemoteOptimisticSendRegistered(sessionId, record)) return;
    const persisted = rows.find((message) => message.clientId === clientId);
    if (persisted) {
      const [mapped] = mapServerMessages([persisted]);
      // Do not resurrect a purged/LRU session merely to settle a late ACK.
      if (mapped && sessions.has(sessionId)) {
        setState(sessionId, (s) => {
          const existing = s.messages.find((message) => message.clientId === clientId);
          const messages = existing
            ? s.messages.map((message) =>
                message.clientId === clientId
                  ? hydratePersistedMessage(message, mapped, {
                      preserveExistingToolResultContent: true,
                      preserveExistingCodexPlanContent: true,
                    })
                  : message,
              )
            : mergeMessages([mapped], s.messages, {
                preserveExistingToolResultContent: true,
                preserveExistingCodexPlanContent: true,
              });
          const pendingQueue = s.pendingQueue.filter((item) => item.clientId !== clientId);
          if (messages === s.messages && pendingQueue.length === s.pendingQueue.length) return s;
          return {
            ...s,
            messages,
            pendingQueue,
            isFirstMessage: mapped.role === 'user' ? false : s.isFirstMessage,
          };
        });
      }
      clearRemoteOptimisticSend(sessionId, clientId);
      settled = true;
      markSessionHasUserMessage(sessionId);
      void reconcileRemoteMessages(sessionId);
    }
  } catch (error) {
    // NOT_FOUND is a conclusive negative for this attempt, not a terminal
    // failure.  A delayed DB commit or a dropped push must remain recoverable.
    if (!isRemoteAroundClientIdMiss(error)) {
      log.warn('remote optimistic settling reconciliation failed:', error);
    }
  } finally {
    const current = remoteOptimisticSendRecords(sessionId)?.get(clientId);
    if (!settled && current === record && record.accepted) {
      scheduleRemoteOptimisticSettlingRetirement(sessionId, clientId);
    }
  }
}

function cancelRemoteOptimisticSettlingRetirement(sessionId: string, clientId: string): void {
  const timers = remoteOptimisticSettlingTimers.get(sessionId);
  const timer = timers?.get(clientId);
  if (timer) clearTimeout(timer);
  timers?.delete(clientId);
  if (timers?.size === 0) remoteOptimisticSettlingTimers.delete(sessionId);
}

function retainOrClearRemoteOptimisticSendAfterProjection(
  sessionId: string,
  clientId: string,
): void {
  const hasPendingMessage = getOrCreateState(sessionId).messages.some(
    (message) => message.clientId === clientId && message.isPendingPersist,
  );
  if (hasPendingMessage) {
    scheduleRemoteOptimisticSettlingRetirement(sessionId, clientId);
  } else {
    clearRemoteOptimisticSend(sessionId, clientId);
  }
}

function clearRemoteOptimisticSend(sessionId: string, clientId: string): void {
  const records = remoteOptimisticSends.get(sessionId);
  const deleted = records?.delete(clientId) === true;
  if (records?.size === 0) remoteOptimisticSends.delete(sessionId);
  cancelRemoteOptimisticSettlingRetirement(sessionId, clientId);
  const removed = remoteOptimisticLocallyRemoved.get(sessionId);
  removed?.delete(clientId);
  if (removed?.size === 0) remoteOptimisticLocallyRemoved.delete(sessionId);
  remoteOptimisticSettlingChecks.delete(`${sessionId}\u0000${clientId}`);
  if (deleted) syncRemoteOptimisticAttachmentUrls();
}

function clearRemoteOptimisticSendsForSession(sessionId: string): void {
  const deleted = remoteOptimisticSends.delete(sessionId);
  remoteInputProjectionRequests.delete(sessionId);
  remoteInputProjectionProbeStateBySession.delete(sessionId);
  clearRemoteOptimisticRetryTimer(sessionId);
  remoteOptimisticPumps.delete(sessionId);
  const timers = remoteOptimisticSettlingTimers.get(sessionId);
  if (timers) {
    for (const timer of timers.values()) clearTimeout(timer);
    remoteOptimisticSettlingTimers.delete(sessionId);
  }
  for (const key of remoteOptimisticSettlingChecks) {
    if (key.startsWith(`${sessionId}\u0000`)) remoteOptimisticSettlingChecks.delete(key);
  }
  remoteOptimisticLocallyRemoved.delete(sessionId);
  if (deleted) syncRemoteOptimisticAttachmentUrls();
}

/**
 * AuthContext 在发布新 data owner 之前同步调用。先在旧 owner 的 composer 命名空间
 * 恢复尚未确认受理的正文/附件，再清账本与 UI；之后任何迟到 invoke / projection
 * 都会同时被 Map identity 与 data-owner generation 挡住，不能跨账号继续投递或恢复。
 */
export function cancelRemoteOptimisticSendsForDataOwnerBoundary(): void {
  invalidateLiveIngressForDataOwnerBoundary();
  // Invalidate standalone projection reads/operations before restoring drafts
  // or publishing the next owner. Their promises may settle independently of
  // the optimistic outbox and must not write old-owner state into the new slice.
  invalidateInputProjectionRequestsForDataOwnerBoundary();
  for (const sessionId of remoteClearFences.keys()) {
    clearRemoteClearFence(sessionId, { pump: false });
  }

  const recoveries: Array<{
    clientId: string;
    recoverySequence: number;
    callback: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']>;
  }> = [];

  for (const recovery of remoteOptimisticMaterializationRecoveries.values()) {
    if (
      recovery.invalidatedByPurge ||
      !isDataOwnerGenerationCurrent(recovery.dataOwner) ||
      !recovery.callback
    ) {
      continue;
    }
    recoveries.push({
      clientId: recovery.clientId,
      recoverySequence: recovery.recoverySequence,
      callback: recovery.callback,
    });
  }

  const clientIdsBySession = new Map<string, Set<string>>();
  for (const [sessionId, records] of remoteOptimisticSends) {
    clientIdsBySession.set(sessionId, new Set(records.keys()));
    for (const record of records.values()) {
      if (
        !record.accepted &&
        record.composerResolvedOptimistically &&
        record.onRemoteOptimisticFailure &&
        isDataOwnerGenerationCurrent(record.dataOwner)
      ) {
        recoveries.push({
          clientId: record.queued.clientId,
          recoverySequence: record.recoverySequence,
          callback: record.onRemoteOptimisticFailure,
        });
      }
    }
  }

  const error = Object.assign(
    new Error('Remote optimistic send cancelled at data-owner boundary'),
    { code: REMOTE_OPTIMISTIC_DATA_OWNER_BOUNDARY_ERROR_CODE },
  );
  recoveries.sort((left, right) => left.recoverySequence - right.recoverySequence);
  for (const recovery of recoveries) {
    try {
      recovery.callback(recovery.clientId, error);
    } catch (restoreError) {
      log.warn('remote optimistic composer restore failed at data-owner boundary:', restoreError);
    }
  }

  // Restore callbacks synchronously publish their draft attachment URLs while
  // the outbox/materialization refs are still live. Only then retire the old
  // owner records, so main never observes a cleanup-eligible gap between the
  // two ownership domains.
  for (const [clientId, recovery] of remoteOptimisticMaterializationRecoveries) {
    if (
      recovery.kind === 'composer-transition' &&
      isDataOwnerGenerationCurrent(recovery.dataOwner)
    ) {
      // Keep a zero-ref tombstone until ChatInput's pending onSend settles.
      // A late continuation then reuses the original owner generation and is
      // rejected instead of capturing the newly signed-in owner.
      recovery.attachmentUrls = [];
      continue;
    }
    remoteOptimisticMaterializationRecoveries.delete(clientId);
  }
  syncRemoteOptimisticAttachmentUrls();
  for (const [sessionId, clientIds] of clientIdsBySession) {
    clearRemoteOptimisticSendsForSession(sessionId);
    if (sessions.has(sessionId)) {
      setState(sessionId, (state) => ({
        ...state,
        pendingQueue: state.pendingQueue.filter((item) => !clientIds.has(item.clientId)),
        messages: state.messages.filter(
          (message) => !(clientIds.has(message.clientId) && message.isPendingPersist),
        ),
      }));
    }
  }
}

/** Clear deferred live ingress work before AuthContext publishes a new owner. */
export function invalidateLiveIngressForDataOwnerBoundary(): void {
  clearTextDeltaFlushTimer();
  pendingTextDeltaBatches.clear();
  clearDeferredStateNotificationTimer();
  pendingDeferredStateNotifications.clear();
  pendingMessageCreatedPatches.clear();
  remotePresenceOnlineByDevice.clear();
  resetRemoteDataOwnerPushFence();
}

function cancelRemoteOptimisticSendsForSessionPurge(sessionId: string): void {
  bumpInteractionReconcileEpoch(sessionId);
  clearRemoteClearFence(sessionId, { pump: false });
  const recoveries: Array<{
    clientId: string;
    recoverySequence: number;
    callback: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']>;
  }> = [];

  for (const recovery of remoteOptimisticMaterializationRecoveries.values()) {
    if (
      recovery.sessionId === sessionId &&
      recovery.callback &&
      isDataOwnerGenerationCurrent(recovery.dataOwner)
    ) {
      recoveries.push({
        clientId: recovery.clientId,
        recoverySequence: recovery.recoverySequence,
        callback: recovery.callback,
      });
    }
  }
  for (const record of remoteOptimisticSendRecords(sessionId)?.values() ?? []) {
    if (
      !record.accepted &&
      record.composerResolvedOptimistically &&
      record.onRemoteOptimisticFailure &&
      isDataOwnerGenerationCurrent(record.dataOwner)
    ) {
      recoveries.push({
        clientId: record.queued.clientId,
        recoverySequence: record.recoverySequence,
        callback: record.onRemoteOptimisticFailure,
      });
    }
  }

  clearRemoteOptimisticMaterializationRecoveriesForSession(sessionId, {
    preserveComposerTransitions: true,
    markComposerTransitionsPurged: true,
  });
  const error = createRemoteOptimisticSessionPurgedError();
  recoveries.sort((left, right) => left.recoverySequence - right.recoverySequence);
  for (const recovery of recoveries) {
    try {
      recovery.callback(recovery.clientId, error);
    } catch (callbackError) {
      log.warn('remote optimistic composer purge callback failed:', callbackError);
    }
  }

  clearRemoteOptimisticSendsForSession(sessionId);
}

/**
 * A remote `/clear` is a non-terminal owner boundary. Drop only the optimistic
 * state that predates the new token, restore drafts with the ordinary failure
 * callback, and leave a composer-transition tombstone for late ChatInput
 * continuations. Unlike purge/delete this must not surface a purge error.
 */
function cancelRemoteOptimisticSendsForRemoteClear(
  sessionId: string,
  clearBoundaryMs: number,
  opts: { historicalHydration?: boolean } = {},
): void {
  // 历史 hydration 也会走到这里,但它只清理旧 optimistic 状态,并没有替换当前消息窗口;
  // 因此只作废在途请求,不能把已经完成的自动补载误判成新窗口。
  bumpMessagesEpoch(sessionId);
  bumpInteractionReconcileEpoch(sessionId);
  invalidateInputProjectionRequests(sessionId);
  const pinnedDeviceId = getStickySessionDeviceId(sessionId);
  invalidateRemoteMessageCache(sessionId, pinnedDeviceId);

  const recoveries: Array<{
    clientId: string;
    recoverySequence: number;
    callback: NonNullable<SendMessageOpts['onRemoteOptimisticFailure']>;
  }> = [];
  const recordClientIds = new Set<string>();
  const currentClearGeneration = rendererClearGenerationBySession.get(sessionId) ?? 0;
  const isRecordSupersededByClear = (record: RemoteOptimisticSendRecord): boolean => {
    if (opts.historicalHydration) {
      // This is the first numeric token observed after a controller restart.
      // The token and click timestamps may come from different devices, so no
      // wall-clock comparison can prove that an existing optimistic record was
      // created after the clear. Retire every pre-hydration record; sends made
      // after this observation capture the known token synchronously.
      return true;
    }
    // A generation change is the authoritative click-time ordering signal. It
    // handles unknown-token records without misclassifying a send created after
    // a historical clear was first observed.
    if (record.clearGeneration < currentClearGeneration) return true;
    // The record was created after this clear was observed but the controller
    // still has no token (legacy host or a pending probe). Let its own probe /
    // main-side precondition decide; it belongs to the new generation.
    if (record.expectedClearBoundaryMs === undefined) return false;
    if (record.expectedClearBoundaryMs === null) return true;
    return (
      typeof record.expectedClearBoundaryMs === 'number' &&
      record.expectedClearBoundaryMs < clearBoundaryMs
    );
  };
  const isRecoverySupersededByClear = (
    recovery: RemoteOptimisticMaterializationRecovery,
  ): boolean => {
    if (opts.historicalHydration) {
      // Materialisation has no authoritative remote token until dispatch. For
      // the same clock-independent first-hydration rule as queue records,
      // retire every recovery that predates this observation; new recoveries
      // capture the known token in their scope.
      return true;
    }
    if (recovery.clearGeneration < currentClearGeneration) return true;
    if (recovery.expectedClearBoundaryMs === undefined) return false;
    if (recovery.expectedClearBoundaryMs === null) return true;
    return (
      typeof recovery.expectedClearBoundaryMs === 'number' &&
      recovery.expectedClearBoundaryMs < clearBoundaryMs
    );
  };
  for (const recovery of remoteOptimisticMaterializationRecoveries.values()) {
    if (recovery.sessionId !== sessionId || !recovery.callback) continue;
    if (!isDataOwnerGenerationCurrent(recovery.dataOwner)) continue;
    if (!isRecoverySupersededByClear(recovery)) continue;
    recoveries.push({
      clientId: recovery.clientId,
      recoverySequence: recovery.recoverySequence,
      callback: recovery.callback,
    });
  }
  for (const record of remoteOptimisticSendRecords(sessionId)?.values() ?? []) {
    if (!isRecordSupersededByClear(record)) continue;
    recordClientIds.add(record.queued.clientId);
    if (
      !record.accepted &&
      record.composerResolvedOptimistically &&
      record.onRemoteOptimisticFailure &&
      isDataOwnerGenerationCurrent(record.dataOwner)
    ) {
      recoveries.push({
        clientId: record.queued.clientId,
        recoverySequence: record.recoverySequence,
        callback: record.onRemoteOptimisticFailure,
      });
    }
  }

  for (const [clientId, recovery] of remoteOptimisticMaterializationRecoveries) {
    if (recovery.sessionId !== sessionId || !isRecoverySupersededByClear(recovery)) continue;
    if (recovery.kind === 'composer-transition') {
      // Keep a tombstone until the late ChatInput continuation releases it; it
      // must not capture the post-clear generation and recreate the send.
      recovery.attachmentUrls = [];
      recovery.invalidatedByPurge = true;
    } else {
      remoteOptimisticMaterializationRecoveries.delete(clientId);
    }
  }
  syncRemoteOptimisticAttachmentUrls();
  recoveries.sort((left, right) => left.recoverySequence - right.recoverySequence);
  const restored = new Set<string>();
  for (const recovery of recoveries) {
    if (restored.has(recovery.clientId)) continue;
    restored.add(recovery.clientId);
    try {
      recovery.callback(recovery.clientId, undefined);
    } catch (error) {
      log.warn('remote optimistic composer restore failed at clear boundary:', error);
    }
  }
  for (const clientId of recordClientIds) {
    clearRemoteOptimisticSend(sessionId, clientId);
  }

  if (sessions.has(sessionId)) {
    setState(sessionId, (state) => {
      const pendingQueue = state.pendingQueue.filter((item) => !recordClientIds.has(item.clientId));
      const messages = state.messages.filter(
        (message) => !(recordClientIds.has(message.clientId) && message.isPendingPersist),
      );
      const steeringQueueClientIds = state.steeringQueueClientIds.filter(
        (clientId) => !recordClientIds.has(clientId),
      );
      if (
        pendingQueue === state.pendingQueue &&
        messages === state.messages &&
        steeringQueueClientIds === state.steeringQueueClientIds
      ) {
        return state;
      }
      return {
        ...state,
        pendingQueue,
        messages,
        steeringQueueClientIds,
        queueAbortPending: false,
        queueInteractionLocks: [],
        queueEditLocks: [],
      };
    });
  }
}

function markRemoteOptimisticLocallyRemoved(sessionId: string, clientId: string): void {
  let removed = remoteOptimisticLocallyRemoved.get(sessionId);
  if (!removed) {
    removed = new Set<string>();
    remoteOptimisticLocallyRemoved.set(sessionId, removed);
  }
  removed.add(clientId);
}

function unmarkRemoteOptimisticLocallyRemoved(sessionId: string, clientId: string): void {
  const removed = remoteOptimisticLocallyRemoved.get(sessionId);
  removed?.delete(clientId);
  if (removed?.size === 0) remoteOptimisticLocallyRemoved.delete(sessionId);
}

export type MessageDeliveryMode = 'queue' | 'steer';

/** 仅影响 selector/chip 的乐观展示；agentKind 始终保留真实 reducer 路由。 */
export interface AgentSwitchIntentRecord {
  target: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean;
}

export type ContinuationInFlightProjectionCapability = 'unknown' | 'supported' | 'legacy';

export interface SessionChatState {
  /**
   * 该 session 用哪个 agent (Claude / Codex)。 sendMessage 据此走 maker.send 时
   * 透传 agentKind, maker:event 收到事件时按 agentKind 决定走 Claude reducer 还是
   * Codex reducer。ensureInitialMessages 从 DB sessions.agent_kind 读出来灌进。
   * 默认 'claude-code' 兼容老路径(老 session row 没有此字段时按 Claude 处理)。
   */
  agentKind: 'claude-code' | 'codex' | 'pi';
  /** 下一条消息发送时才由 main 应用的跨引擎切换意图。 */
  agentSwitchIntent: AgentSwitchIntentRecord | null;
  /**
   * 意图的单调修订号:**任何来源**(本端登记/撤销、被控端 push 回流、另一窗口)真正改变
   * 意图时 +1,只增不减。异步读回的新鲜度判定必须用它,不能比较意图值本身——外部把意图
   * 从 null 改成非空又清回 null 时,值与引用都会回到相等,过期响应会被误判为新鲜而复活
   * 已取消的意图(ABA)。
   */
  agentSwitchIntentRev: number;
  /**
   * Remote codex target (P2): SSH host alias from `@cindy/maker-remote-ssh`
   * pool。null/undefined = 本地 session。ensureInitialMessages 从 DB
   * sessions.remote_host_id 灌进, lazy-create 时透传给 maker.send.createOpts,
   * agent 据此选 transport (stdio vs SSH-bridged daemon)。
   */
  remoteHostId: string | null;
  /** Internal: prevents infinite auth-retry loops for remote sessions. */
  _authRetryInFlight?: boolean;
  /** Internal: clientId of the last user message that triggered auth-retry (prevents re-retrying same message). */
  _authRetryAttemptedClientId?: string;
  /** Original remote auth error to persist if an accepted retry later fails through an input projection. */
  _authRetryPersistOnProjectionError?: {
    clientId: string;
    data: Record<string, unknown> | null;
    agentMeta: Record<string, unknown> | null;
  };
  /**
   * Internal: consecutive auto-retry count for this session. Hard cap against
   * the rare loop where the key refreshes successfully every time but the
   * remote daemon keeps returning 401 (per-message guard alone can't stop it —
   * each retry creates a new user message with a fresh clientId). Reset to 0 on
   * a successful `done` event.
   */
  _authRetryCount?: number;
  messages: ChatMessage[];
  /** Live subagent / task status keyed by parent tool_use id and task id. */
  taskUpdates?: ReadonlyMap<string, AgentTaskUpdate>;
  isStreaming: boolean;
  agentStatus: AgentStatus;
  error: string | null;
  /** 当前 terminal error 是否为可恢复的账号用量限制，以及可识别的重置时刻。 */
  usageLimitRecovery?: UsageLimitRecoveryHint | null;
  /**
   * 当前 terminal error 的稳定 reason key(maker-core/main 下发,如
   * 'silent-stop-exhausted')。ErrorBanner 据此渲染专用 action(「继续」按钮);
   * 仅在 error 非空时有意义,error 被清/被无 reason 的错误覆盖时同步清。
   */
  errorReason?: string | null;
  recoverableError: string | null;
  /**
   * 输入投影自带的 recovery 镜像（main 的 retry 权威状态）。renderer 侧人工
   * Retry 登记本端意图时用它区分 queue-head（原样重发既有队首项）与
   * active-turn（克隆 / 续跑指令）——projection 线上本就有该字段，仅镜像，
   * 不改协议。
   */
  inputRecovery: AgentInputRecovery;
  /**
   * 当前已派发 turn 的 retry 候选文本。
   *
   * 这个字段在 dispatchToSdk 那一刻从 QueuedMessage snapshot 写入，done/error/stop
   * 时清掉。errorRetryText 只能从这里取，不能从 messages[] 反推；否则 UI-trigger
   * 这类没有 user bubble 的 turn 报错时，会误拿更早的历史 user 消息出来重试。
   */
  activeTurnRetryText: string | null;
  /**
   * ErrorBanner 的 Retry 目标，由出错路径显式写入。
   *
   * 不能在 UI 里从 messages[] 倒找最后一条 user：排队语义下，messages[] 只代表
   * 已经发给 agent 的内容，pendingQueue 才是还没派发的内容。旧逻辑在有队列时
   * 会把已经发出去的话当成“待重试消息”再次走 sendMessage，结果重新出现在队列里。
   *
   * 字段名沿用“Text”是历史包袱；pre-accept 失败时这里存的是队首 retry token。
   * 纯附件消息没有 text，但仍然有完整 QueuedMessage snapshot，所以不能因为
   * text 为空就隐藏 Retry。ErrorBanner 只把 token 原样带回 store，真正重试时
   * 只 drain 现有 pendingQueue[0]，不会把 token 当用户输入发给 agent。
   * 这里把“能不能重试、重试哪条”收口到 store，避免展示层猜错。
   */
  errorRetryText: string | null;
  /**
   * 凭证切换等待态(main projection 透传):发送需重启共享 codex 进程,被列出的
   * 会话挡住;队首保留、结束后 main 自动重发。渲染为等待横幅(非错误)。
   */
  credentialSwitchWait: { clientId?: string; blockedBySessionIds: string[] } | null;
  /**
   * Main coordinator 中已经离开 pendingQueue、但仍占有 dispatch/turn 边界的
   * Continue clientId。用于让中断横幅在「离队 → running/session patch」窗口
   * 保持熄灭，同时不影响用户取消仍在队列中的 Continue 后恢复横幅。
   */
  continuationInFlightClientId: string | null;
  /**
   * 当前 vendor turn 的续跑发起项 clientId。它由 main 绑定在 ActiveTurn 上，steer 顶替
   * activeTurn 后仍保持原值，因此 Renderer 重载 / 新窗口也能恢复归属。
   */
  continuationTurnClientId: string | null;
  /**
   * 当前 projection 是否支持 `continuationTurnClientId`：
   * unknown = 尚未收到投影；supported = 字段显式存在（值可以是 null）；
   * legacy = 旧被控端完全缺省字段，只能回落到 running + 最后一条输入的兼容判据。
   * 不能用 `?? null` 推断：新版显式 null 需要挡住无关 Goal turn，旧版缺省需要兼容。
   */
  continuationInFlightProjectionCapability: ContinuationInFlightProjectionCapability;
  isLoadingMore: boolean;
  hasMoreMessages: boolean;
  /**
   * 窗口里是否掺进过"孤岛" —— 跳转补齐失败时 merge 的 around 窗口,它与已加载的尾部窗口
   * 之间隔着没加载的历史。
   *
   * 为什么需要它:补齐的快速通道原来只判 `messages.some(clientId === target)`,那是**成员**
   * 判定而不是**连续覆盖**判定。孤岛一旦落进窗口,再跳同一个目标就会命中 some()、直接返回
   * covered 而不补齐,于是"中间缺失"再也修不好(#676 review)。有孤岛时快速通道失效,
   * 每次跳转都重新从最新翻页,让这个状态可自愈。
   *
   * 只由**把窗口清空、从最新重新拉起**的路径清回 false:reloadMessages(rewind / origin
   * 漂移重载)、clearSessionAfterGuard(/clear)、_demoteIdleSessions(空闲降级)、
   * _purgeSession(整条移除,重建后回到默认 false)。
   *
   * 反过来,这几处**刻意不清**(都在 #676 review 里逐条确认过):
   *  - `covered`:到达本次目标只证明"尾部 → 本目标"连续,不证明更早的孤岛都被跨过;
   *  - `_trimMessagesIfNeeded`:`slice(-TRIM_TARGET)` 只保证"最新 200 行",不保证连续;
   *  - 首拉落地:它只是把最新一页 merge 进来,孤岛与尾段之间的洞还在(游标交还给最新页
   *    下沿,好让往上翻能穿过去)。
   */
  historyWindowHasIsland?: boolean;
  isFirstMessage: boolean;
  streamingClientId: string | null;
  streamingText: string;
  oldestMessageId: string | null;
  /** Guard so we only do the initial history fetch once per session slice. */
  historyLoaded: boolean;
  /** SDK-internal session id; null until the first `init` message of a turn lands. */
  sdkSessionId: string | null;
  /** F-PERM-2: Currently pending permission request; null when none. */
  pendingPermission: PendingPermission | null;
  /** F7.2: Currently pending ask-user-question; null when none. */
  pendingAskUser: PendingAskUser | null;
  /** Host-owned plugin setup snapshot; updates replace by monotonic revision. */
  pendingPluginSetup: PendingPluginSetup | null;
  /**
   * Additional setup requests for this session, in first-seen order.
   *
   * Only the head prompt is interactive. Snapshot updates replace the matching
   * request in place, and dismissal promotes the next request without losing it.
   */
  pendingPluginSetupQueue: PendingPluginSetup[];
  /** UI-only fold state for the current plugin setup prompt. */
  pluginSetupViewerState: PluginSetupViewerState;
  /** Prevents duplicate commands until Main publishes a newer snapshot/dismissal. */
  pluginSetupCommandInFlight: PluginSetupCommandInFlight | null;
  /**
   * F-AUQ-MIN-1: AskUserQuestion viewer display state. Only meaningful while
   * pendingAskUser != null. Reset to 'expanded' every time a new
   * pendingAskUser is created OR cleared (so a new question never inherits
   * the previous one's collapsed preference).
   */
  askUserViewerState: AskUserViewerState;
  /**
   * F-AUQ-DRAFT: In-progress wizard answers for the current pendingAskUser.
   * Survives session-switch remount of `AskUserQuestionPrompt`. Set to null
   * when no question is pending or when the question is resolved/aborted.
   * See AskUserDraft typedef for the staleness contract.
   */
  askUserDraft: AskUserDraft | null;
  /** FP-3: Currently pending plan-review; null when none. */
  pendingPlanReview: PendingPlanReview | null;
  /** issue_confirm: 提交 GitHub issue 前的确认卡片; null when none. */
  pendingIssueConfirm: PendingIssueConfirm | null;
  /** rename_sessions_confirm: 批量改名写入前的确认卡片; null when none. */
  pendingRenameSessionsConfirm: PendingRenameSessionsConfirm | null;
  /** ghost_grant_confirm: ghost_call 过户 workdir 外文件的确认卡片; null when none. */
  pendingGhostGrantConfirm: PendingGhostGrantConfirm | null;
  /** FP-3: Plan Viewer Card display state (only meaningful when pendingPlanReview != null). */
  planViewerState: PlanViewerState;
  /** FP-3: Last non-minimized state — used to restore from minimized via the "+" button. */
  lastExpandedPlanViewerState: 'expanded' | 'half' | 'edit';
  /**
   * F-QUEUE-1 / F-QUEUE-2 / F-QUEUE-DEFER: FIFO queue of user messages
   * submitted while the agent was busy (running, awaiting permission,
   * awaiting ask_user, awaiting plan review).
   *
   * F-QUEUE-DEFER (2026-05): Entries are NOT yet rendered in the message
   * stream — only `PendingQueuePanel` shows them. The main input coordinator
   * owns the transaction that accepts a queued row into the active turn.
   *
   * Drained head-first on `done` unless the queue is explicitly paused, a
   * global row interaction lock is active, or the current head is being edited.
   * NOT drained on `error`
   * (anti-cascade). User Stop preserves and pauses the queue; Clear still wipes
   * it.
   */
  pendingQueue: QueuedMessage[];
  /**
   * Messages currently being delivered as same-turn 插话.
   *
   * This includes both queued-row 插话 and Cmd/Ctrl+Enter composer 插话. The
   * marker is intentionally separate from `pendingQueue`: composer 插话 may not
   * have a queued row at all, but it still has to block `drainQueueHead`.
   * Otherwise a just-finished turn can dispatch the next queued message while
   * `maker:steer` is still crossing renderer → main → maker-core, and the
   * 插话 can land on the wrong newly-started turn. Failed steers remove the
   * optimistic user bubble and preserve the original queued snapshot.
   */
  steeringQueueClientIds: string[];
  /** Queue is paused by an explicit Stop and resumes only via the queue Continue button. */
  queuePaused: boolean;
  /**
   * Short-lived global locks for mutating queued row order.
   *
   * This deliberately replaces the old "expanded panel freezes drain" model:
   * looking at the queue is now passive, but drag-sort mutates the meaning of
   * every position, so a just-finished turn must not dispatch while the list is
   * reordering.
   */
  queueInteractionLocks: string[];
  /**
   * ClientIds currently being edited. Unlike drag-sort, text editing should not
   * freeze unrelated rows ahead of it: if the user edits the third queued message
   * while the current task finishes, the second message may still dispatch. Drain
   * waits only when the queue head is one of these ids, then resumes on unlock.
   */
  queueEditLocks: string[];
  /**
   * Stop has asked main/maker-core to abort the active turn, but that abort has
   * not reached a safe boundary yet.
   *
   * Renderer marks the UI idle immediately after Stop so the button recovers.
   * Queue drain still has to wait: Claude's streaming input can otherwise accept
   * the next queued message into the very turn the user tried to stop. Continue
   * may clear `queuePaused` first; `drainQueueHead` remains the single guard that
   * decides when dispatch is actually safe.
   */
  queueAbortPending: boolean;
  /**
   * Pure visual state for queues longer than the inline limit. It only decides
   * whether the tail after the first three rows is visible; it must never gate
   * `drainQueueHead`.
   */
  queueExpanded: boolean;
  /** Fast Mode toggle state — session-level, OFF by default, only meaningful for supported models. */
  fastMode: boolean;
  /**
   * 计划模式一级开关(与 permissionMode 正交)。开关入口在 composer「+」菜单;
   * 计划批准后 agent 自动退出, 经 plan_mode_changed → sessions:patched →
   * mirrorSessionFields 回流为 false。
   */
  planModeEnabled: boolean;
  /**
   * planModeEnabled 的本地写入单调计数(setPlanMode / 一次性消耗 / 镜像 / seed)。
   * ensureInitialMessages 的行水合是并行异步读:fetch 期间发生过本地写入时,
   * 读回的行值已陈旧,按此计数丢弃,防止刚被消耗的勾选被复燃(bot review P2)。
   */
  planModeRev: number;
  /**
   * 最近一次 running→stopped 是否来自 skipTurnReset side-task(mivo 图片按钮等
   * 不走 LLM 的后台任务)。side-task 刻意保留 state.error(上一轮真实失败的
   * banner 不该被侧任务清掉),但它的结束**不是** turn 终态——running-status
   * 通知判定读到保留的旧 error 会把成功的侧任务误报成「执行失败」(PR #485
   * review)。transition snapshot 与 hasSessionTerminalError 都按此豁免。
   */
  lastStopWasSideTask: boolean;
  /**
   * 后台 subagent「唤醒桥接」标记(claude-code 专用)。
   *
   * 背景:新版 claude 二进制里 Agent(Task)工具默认后台运行——主 turn 先结束
   * (isRunning=false),subagent 完成后 SDK 经 task_notification 自动开新 turn
   * (wake turn)。task 终态 → wake turn 首个 isRunning:true status 之间有一段
   * 毫秒~秒级空窗,若不桥接,running 快照会在此空窗闪出一次 running→stopped
   * 转换,误发「会话已完成」通知 + 侧栏 spinner 抖动。
   *
   * 置位:agent_task_update 里 wake 型任务(local_agent / local_workflow)到达
   *   completed / failed 终态、且当时没有 turn 在跑(!agentStatus.isRunning)。
   *   stopped(killed)不置位——interrupt 杀掉的任务不会有 wake turn 跟进。
   * 清除:真实 turn 的任意 status update(wake turn 的 message_start 必发
   *   isRunning:true)/ stopSession / session closed 兜底 / clearSession /
   *   reloadMessages。
   */
  pendingTaskWake: boolean;
  /**
   * agent-meta: 上一条 SDK assistant message 的 cc 元信息——mid-turn 抢救
   * assistant 累积流（tool_use / ask_user / plan_review 切流时把累积文本落
   * assistant）能拿到对应的 SDK 元信息。
   * 每收到带 agentMeta 的 stream event 时刷新；done/error 时清掉。
   */
  lastAgentMeta: import('@/lib/ccAgent.types').AgentMeta | null;
}

export type SessionChatLightState = Pick<
  SessionChatState,
  | 'agentStatus'
  | 'isStreaming'
  | 'error'
  | 'usageLimitRecovery'
  | 'errorReason'
  | 'recoverableError'
  | 'errorRetryText'
  | 'credentialSwitchWait'
  | 'continuationInFlightClientId'
  | 'continuationTurnClientId'
  | 'continuationInFlightProjectionCapability'
  | 'isLoadingMore'
  | 'hasMoreMessages'
  | 'historyWindowHasIsland'
  | 'isFirstMessage'
  | 'historyLoaded'
  | 'pendingPermission'
  | 'pendingAskUser'
  | 'pendingPluginSetup'
  | 'pluginSetupViewerState'
  | 'pluginSetupCommandInFlight'
  | 'askUserViewerState'
  | 'askUserDraft'
  | 'pendingPlanReview'
  | 'pendingIssueConfirm'
  | 'pendingRenameSessionsConfirm'
  | 'pendingGhostGrantConfirm'
  | 'planViewerState'
  | 'lastExpandedPlanViewerState'
  | 'pendingQueue'
  | 'steeringQueueClientIds'
  | 'queuePaused'
  | 'queueExpanded'
  | 'fastMode'
  | 'planModeEnabled'
  | 'agentSwitchIntent'
>;

function createInitialState(): SessionChatState {
  return {
    agentKind: 'claude-code',
    agentSwitchIntent: null,
    agentSwitchIntentRev: 0,
    remoteHostId: null,
    messages: [],
    taskUpdates: EMPTY_TASK_UPDATES,
    isStreaming: false,
    agentStatus: {
      status: '',
      tokenUsage: 0,
      costUsd: 0,
      contextTokens: 0,
      contextWindow: 0,
      isRunning: false,
      startedAt: null,
    },
    error: null,
    usageLimitRecovery: null,
    errorReason: null,
    recoverableError: null,
    inputRecovery: null,
    activeTurnRetryText: null,
    errorRetryText: null,
    credentialSwitchWait: null,
    continuationInFlightClientId: null,
    continuationTurnClientId: null,
    continuationInFlightProjectionCapability: 'unknown',
    isLoadingMore: false,
    hasMoreMessages: true,
    historyWindowHasIsland: false,
    isFirstMessage: true,
    streamingClientId: null,
    streamingText: '',
    pendingPermission: null,
    pendingAskUser: null,
    pendingPluginSetup: null,
    pendingPluginSetupQueue: [],
    pluginSetupViewerState: 'expanded',
    pluginSetupCommandInFlight: null,
    askUserViewerState: 'expanded',
    askUserDraft: null,
    pendingPlanReview: null,
    pendingIssueConfirm: null,
    pendingRenameSessionsConfirm: null,
    pendingGhostGrantConfirm: null,
    planViewerState: 'expanded',
    lastExpandedPlanViewerState: 'expanded',
    oldestMessageId: null,
    historyLoaded: false,
    sdkSessionId: null,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    queueExpanded: false,
    fastMode: false,
    planModeEnabled: false,
    planModeRev: 0,
    lastStopWasSideTask: false,
    pendingTaskWake: false,
    lastAgentMeta: null,
  };
}

/** Stable empty snapshot for callers without a sessionId. */
export const EMPTY_SESSION_STATE: SessionChatState = Object.freeze({
  agentKind: 'claude-code',
  agentSwitchIntent: null,
  agentSwitchIntentRev: 0,
  remoteHostId: null,
  messages: [],
  taskUpdates: EMPTY_TASK_UPDATES,
  isStreaming: false,
  agentStatus: {
    status: '',
    tokenUsage: 0,
    costUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    isRunning: false,
    startedAt: null,
  },
  error: null,
  usageLimitRecovery: null,
  errorReason: null,
  recoverableError: null,
  inputRecovery: null,
  activeTurnRetryText: null,
  errorRetryText: null,
  credentialSwitchWait: null,
  continuationInFlightClientId: null,
  continuationTurnClientId: null,
  continuationInFlightProjectionCapability: 'unknown',
  isLoadingMore: false,
  hasMoreMessages: false,
  historyWindowHasIsland: false,
  isFirstMessage: true,
  streamingClientId: null,
  streamingText: '',
  oldestMessageId: null,
  historyLoaded: true,
  sdkSessionId: null,
  pendingPermission: null,
  pendingAskUser: null,
  pendingPluginSetup: null,
  pendingPluginSetupQueue: [],
  pluginSetupViewerState: 'expanded',
  pluginSetupCommandInFlight: null,
  askUserViewerState: 'expanded',
  askUserDraft: null,
  pendingPlanReview: null,
  pendingIssueConfirm: null,
  pendingRenameSessionsConfirm: null,
  pendingGhostGrantConfirm: null,
  planViewerState: 'expanded',
  lastExpandedPlanViewerState: 'expanded',
  pendingQueue: [],
  steeringQueueClientIds: [],
  queuePaused: false,
  queueInteractionLocks: [],
  queueEditLocks: [],
  queueAbortPending: false,
  queueExpanded: false,
  fastMode: false,
  planModeEnabled: false,
  planModeRev: 0,
  lastStopWasSideTask: false,
  pendingTaskWake: false,
  lastAgentMeta: null,
}) as SessionChatState;

// ---------------------------------------------------------------------------
// Store internals
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionChatState>();
const listeners = new Map<string, Set<() => void>>();
const lightSnapshotCache = new Map<string, SessionChatLightState>();

/**
 * #2194: clientIds of user messages sent from THIS renderer's composer.
 * sendMessageCore / steerMessageCore are the choke points every local send
 * (composer send, edit-resend, steer, device-link send initiated on this
 * desktop) passes through, so those local user messages are recorded there.
 * Further paths register separately: local UI triggers (silent-stop Continue /
 * app-exit Continue / Mivo) in sendUiTriggerCore; a manual Retry in
 * retryLastError (clone via the receipt's supersedesUserClientId, hidden
 * continue via originalSyntheticTrigger, queue-head redispatch via the
 * mirrored inputRecovery captured at click time); and queue actions that
 * dispatch a restored/externally-queued row (resumeQueue, steerQueuedMessage)
 * at click time.
 * MessageStream uses this to tell an explicit local send — which force-pins
 * the viewport to the tail — apart from user messages injected by other
 * entries (IM channels, a mobile client driving the session remotely,
 * scheduler runs), which must not steal the reading position. Memory-only
 * by design: the force-pin only matters at send time; after a renderer
 * restart the restore path owns the viewport anchor.
 */
const localSentUserMessageIds = new Map<string, Set<string>>();
/** Generous per-session cap — the lookup only matters right after sending. */
const LOCAL_SENT_IDS_CAP = 200;

function markLocalSentUserMessage(sessionId: string, clientId: string): void {
  let ids = localSentUserMessageIds.get(sessionId);
  if (!ids) {
    ids = new Set();
    localSentUserMessageIds.set(sessionId, ids);
  }
  // 已存在时直接返回：重复登记不该无谓逐出最旧 id（容量会掉到 CAP-1，
  //  Copilot review nit）。
  if (ids.has(clientId)) return;
  if (ids.size >= LOCAL_SENT_IDS_CAP) {
    const oldest = ids.values().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }
  ids.add(clientId);
}

/**
 * Roll back a speculative mark (e.g. queued steer marked before the IPC when
 * main persists before resolving). Never recreates a purged session's entry.
 */
function unmarkLocalSentUserMessage(sessionId: string, clientId: string): void {
  localSentUserMessageIds.get(sessionId)?.delete(clientId);
}

/** Whether the given user message was sent from this renderer's composer. */
function isLocalSentUserMessage(sessionId: string, clientId: string): boolean {
  return localSentUserMessageIds.get(sessionId)?.has(clientId) ?? false;
}

/**
 * #2194: 人工 Retry（active-turn）的一次性本端意图。main 的
 * performRetryLastError 在返回 projection 前就 emit 并 scheduleDrain
 * （queueMicrotask），续跑 / 克隆行可能抢在 retry 的 IPC 回执前经
 * localDb.messages.onCreated 落库、被 MessageStream 基线化为外部
 * （Codex review P1）。但 main 的 emit 先于 scheduleDrain，投影事件必然
 * 先于落库广播携带本次产物——点击时记下意图（含点击时刻的队列快照），
 * applyInputProjection 时凭意图同步认领新 clientId，不等回执。
 * 回执 settle 时无条件清意图（兜底清理）。
 */
const pendingLocalRetryIntents = new Map<string, { queueIds: Set<string> }>();

/**
 * 与 retryLastError 回执扫描同口径：retry 生效（resumed）时 main 在 unshift
 * 前同步清掉 error / recovery，投影必然双空，且 unshift → emit 同步、队首
 * 必然是本次产物；未生效的投影（含 superseded）里没有本次产物，意图继续
 * pending 等生效投影或回执清理。点击后首个 error/recovery 双空的投影就是
 * 本次生效投影（其它路径并发清 error 本身就让本次 retry superseded），
 * 无论是否认领到产物都消费意图——一次性语义。
 */
function claimLocalRetryProductFromProjection(projection: AgentInputProjection): void {
  const intent = pendingLocalRetryIntents.get(projection.sessionId);
  if (!intent) return;
  if (projection.error !== null || projection.recovery !== null) return;
  pendingLocalRetryIntents.delete(projection.sessionId);
  if (!sessions.has(projection.sessionId)) return;
  const headClientId = projection.pendingQueue[0]?.clientId;
  for (const item of projection.pendingQueue) {
    if (intent.queueIds.has(item.clientId)) continue;
    if (item.supersedesUserClientId) {
      markLocalSentUserMessage(projection.sessionId, item.clientId);
    } else if (
      item.originalSyntheticTrigger === 'continue' &&
      item.autoResume !== true &&
      headClientId === item.clientId
    ) {
      markLocalSentUserMessage(projection.sessionId, item.clientId);
    }
  }
}

/**
 * F-SB-7: Global listeners — notified whenever ANY session's state changes.
 * Used by Sidebar to track running status across all sessions without needing
 * to subscribe to each session individually.
 */
const globalListeners = new Set<() => void>();

// 工具事件风暴时仍同步写入权威 state，但把 React/sidebar 订阅通知压成每会话每帧一次。
// Stop、terminal、interaction 等控制路径会取消该会话的待发通知并立即广播最新快照。
const HIGH_FREQUENCY_NOTIFY_INTERVAL_MS = 32;
const HIGH_FREQUENCY_NOTIFY_MAX_SESSIONS_PER_TICK = 8;
const pendingDeferredStateNotifications = new Set<string>();
const pendingMessageCreatedPatches = new Map<string, string>();
let deferredStateNotificationTimer: ReturnType<typeof setTimeout> | null = null;

function hasDeferredStateWork(): boolean {
  return pendingDeferredStateNotifications.size > 0 || pendingMessageCreatedPatches.size > 0;
}

function clearDeferredStateNotificationTimer(): void {
  if (!deferredStateNotificationTimer) return;
  clearTimeout(deferredStateNotificationTimer);
  deferredStateNotificationTimer = null;
}

function scheduleDeferredStateNotifications(): void {
  if (deferredStateNotificationTimer) return;
  deferredStateNotificationTimer = setTimeout(
    flushDeferredStateNotifications,
    HIGH_FREQUENCY_NOTIFY_INTERVAL_MS,
  );
}

function emitStateNotifications(sessionId: string): void {
  listeners.get(sessionId)?.forEach((cb) => {
    cb();
  });
}

function flushPendingMessageCreatedPatch(sessionId: string): void {
  const updatedAt = pendingMessageCreatedPatches.get(sessionId);
  if (!updatedAt) return;
  pendingMessageCreatedPatches.delete(sessionId);
  emitPatch(sessionId, { updatedAt });
}

function flushDeferredStateNotifications(): void {
  deferredStateNotificationTimer = null;
  const sessionIds = [
    ...new Set([...pendingDeferredStateNotifications, ...pendingMessageCreatedPatches.keys()]),
  ].slice(0, HIGH_FREQUENCY_NOTIFY_MAX_SESSIONS_PER_TICK);
  let stateChanged = false;
  for (const sessionId of sessionIds) {
    if (pendingDeferredStateNotifications.delete(sessionId)) {
      stateChanged = true;
      emitStateNotifications(sessionId);
    }
  }
  if (stateChanged) {
    globalListeners.forEach((cb) => {
      cb();
    });
  }
  for (const sessionId of sessionIds) flushPendingMessageCreatedPatch(sessionId);
  if (hasDeferredStateWork()) scheduleDeferredStateNotifications();
}

function queueDeferredStateNotification(sessionId: string): void {
  pendingDeferredStateNotifications.add(sessionId);
  scheduleDeferredStateNotifications();
}

function queueMessageCreatedPatch(sessionId: string, updatedAt: string): void {
  pendingMessageCreatedPatches.set(sessionId, updatedAt);
  // patch 也进入同一个 FIFO session 集合。否则 Map-only 的 no-op DB echo 会永远排在
  // 持续活跃的前 8 个 state session 之后，slice 上限会让 sidebar patch 饥饿。
  queueDeferredStateNotification(sessionId);
}

function discardDeferredStateWork(sessionId: string): void {
  pendingDeferredStateNotifications.delete(sessionId);
  pendingMessageCreatedPatches.delete(sessionId);
  if (!hasDeferredStateWork()) clearDeferredStateNotificationTimer();
}

/**
 * Per-session onTitleUpdate callback. Registered lazily by `useCCAgentChat`
 * and invoked on `done` / sendMessage (auto-naming, sidebar refresh). We keep
 * only the most recent callback per session — the consumer is always the
 * single mounted `CCAgentSessionView`.
 */
const titleUpdateCallbacks = new Map<string, () => void>();

// 当前用户的展示名 — AuthContext mount / user 变化时通过 setCurrentUserName
// 同步, 由 main input coordinator 透传给 maker.send 让 turn-start status 文案带上
// "<userName> Just Wait ..."。模块级 cache 避免污染 sendMessage 整条调用链。
let currentUserName: string | undefined;
export function setCurrentUserName(name: string | null | undefined): void {
  currentUserName = name?.trim() || undefined;
}

// ---------------------------------------------------------------------------
// LRU session cache — caps memory to MAX_CACHED_SESSIONS active slices.
// Oldest idle sessions are evicted first; streaming/running sessions are
// never evicted mid-flight.
// ---------------------------------------------------------------------------

const MAX_CACHED_SESSIONS = 20;

/**
 * LRU access order — oldest (least-recently-used) at index 0, newest at end.
 * Maintained in sync with `sessions`; an id in `_accessOrder` always has a
 * corresponding entry in `sessions` and vice-versa.
 */
const _accessOrder: string[] = [];

/** Move `sessionId` to the MRU end of the access list. */
function _touchSession(sessionId: string): void {
  const idx = _accessOrder.indexOf(sessionId);
  if (idx !== -1) _accessOrder.splice(idx, 1);
  _accessOrder.push(sessionId);
}

/**
 * stall 看门狗信号:最近一次为该 session 收到入站事件(本机 / 被控端 push 转发)的时刻(ms)。
 * 刻意放模块级 Map、**不进 SessionChatState** —— ingest 是 per-token/per-frame 热路径,
 * 写它绝不能触发 setState / emitPatch / 重渲染。控制端 stall 看门狗定时读它判「静默多久」。
 */
const _lastInboundEventAt = new Map<string, number>();
const rendererClearBoundaryBySession = new Map<string, number>();
const rendererClearGenerationBySession = new Map<string, number>();

type RemoteInputClearBoundary = number | null | undefined;

function observeRemoteInputClearBoundary(
  sessionId: string,
  rawBoundary: unknown,
  opts: { acknowledgePendingFence?: boolean } = {},
): RemoteInputClearBoundary {
  const normalized = normalizeAgentInputClearBoundaryMs(rawBoundary);
  if (normalized === undefined) {
    return remoteInputClearBoundaryBySession.has(sessionId)
      ? remoteInputClearBoundaryBySession.get(sessionId)
      : undefined;
  }

  const hadPrevious = remoteInputClearBoundaryBySession.has(sessionId);
  const previous = remoteInputClearBoundaryBySession.get(sessionId);
  const pendingFence = remoteClearFences.get(sessionId);
  const pendingFenceIsCurrent = Boolean(
    pendingFence && isRemoteClearFenceCurrent(sessionId, pendingFence),
  );
  const acknowledgesPendingFence = Boolean(
    pendingFenceIsCurrent &&
    typeof normalized === 'number' &&
    (opts.acknowledgePendingFence === true ||
      pendingFence!.clearBoundaryBeforeRequest === null ||
      (typeof pendingFence!.clearBoundaryBeforeRequest === 'number' &&
        normalized > pendingFence!.clearBoundaryBeforeRequest)),
  );
  let advanced = false;
  if (!hadPrevious) {
    remoteInputClearBoundaryBySession.set(sessionId, normalized);
    // The first numeric token may describe a historical clear that happened
    // before this controller received its first snapshot. The controller and
    // the controlled host do not share a clock, so timestamps cannot establish
    // ordering here. Retire every record/recovery that has not already captured
    // an authoritative token; a record created after hydration captures the
    // known token synchronously and is therefore preserved.
    if (typeof normalized === 'number' && !acknowledgesPendingFence && !pendingFenceIsCurrent) {
      cancelRemoteOptimisticSendsForRemoteClear(sessionId, normalized, {
        historicalHydration: true,
      });
    }
    advanced = false;
  } else if (
    typeof normalized === 'number' &&
    (previous === null || (typeof previous === 'number' && normalized > previous))
  ) {
    // Clear boundaries are an append-only log. A delayed /clear patch or an
    // older reseed must never move the controller back to an earlier epoch.
    remoteInputClearBoundaryBySession.set(sessionId, normalized);
    advanced = true;
  }

  if (typeof normalized === 'number') {
    const rendererBoundary = rendererClearBoundaryBySession.get(sessionId);
    if (rendererBoundary === undefined || normalized > rendererBoundary) {
      rendererClearBoundaryBySession.set(sessionId, normalized);
    }
  }

  // A generic projection/session patch only acknowledges the pending clear
  // when it strictly advances the host boundary captured before dispatch. A
  // direct clear response passes the explicit option above because the response
  // itself proves execution even if two host events share one millisecond.
  if (acknowledgesPendingFence) {
    clearRemoteClearFence(sessionId, { pump: false });
  }

  if (advanced && typeof normalized === 'number' && !acknowledgesPendingFence) {
    remoteInputProjectionProbeStateBySession.delete(sessionId);
    remoteInputProjectionRequests.delete(sessionId);
    bumpRendererClearGeneration(sessionId);
    // A clear received from another controller invalidates the local outbox at
    // the same boundary. This is deliberately scoped to the session; it must
    // not tear down the device-link/relay shared connection.
    cancelRemoteOptimisticSendsForRemoteClear(sessionId, normalized);
  }
  return remoteInputClearBoundaryBySession.get(sessionId);
}

function isRemoteInputProjectionProbeStateCurrent(
  sessionId: string,
  state: RemoteInputProjectionProbeState,
  deviceId: string,
): boolean {
  return (
    state.deviceId === deviceId &&
    isDataOwnerGenerationCurrent(state.dataOwner) &&
    getStickySessionDeviceId(sessionId) === deviceId &&
    (rendererClearGenerationBySession.get(sessionId) ?? 0) === state.clearGeneration
  );
}

function isAcceptedRemoteProjectionBoundary(
  sessionId: string,
  projection: AgentInputProjection,
): boolean {
  if (!Object.prototype.hasOwnProperty.call(projection, 'clearBoundaryMs')) return true;
  const incoming = normalizeAgentInputClearBoundaryMs(projection.clearBoundaryMs);
  if (incoming === undefined) return false;
  const known = remoteInputClearBoundaryBySession.get(sessionId);
  return !(
    typeof known === 'number' &&
    (incoming === null || (typeof incoming === 'number' && incoming < known))
  );
}

function noteRemoteInputProjectionSuccess(
  sessionId: string,
  deviceId: string,
  dataOwner: DataOwnerGeneration,
  clearGeneration: number,
  projection: AgentInputProjection,
): void {
  if (
    !isDataOwnerGenerationCurrent(dataOwner) ||
    getStickySessionDeviceId(sessionId) !== deviceId ||
    (rendererClearGenerationBySession.get(sessionId) ?? 0) !== clearGeneration ||
    !isAcceptedRemoteProjectionBoundary(sessionId, projection)
  ) {
    return;
  }
  const boundary = Object.prototype.hasOwnProperty.call(projection, 'clearBoundaryMs')
    ? normalizeAgentInputClearBoundaryMs(projection.clearBoundaryMs)
    : undefined;
  remoteInputProjectionProbeStateBySession.set(sessionId, {
    deviceId,
    dataOwner,
    clearGeneration,
    status: 'ready',
    boundary,
  });
}

function noteRemoteInputProjectionFailure(
  sessionId: string,
  deviceId: string,
  dataOwner: DataOwnerGeneration,
  clearGeneration: number,
  error: unknown,
): void {
  if (
    !isDataOwnerGenerationCurrent(dataOwner) ||
    getStickySessionDeviceId(sessionId) !== deviceId ||
    (rendererClearGenerationBySession.get(sessionId) ?? 0) !== clearGeneration
  ) {
    return;
  }
  remoteInputProjectionProbeStateBySession.set(sessionId, {
    deviceId,
    dataOwner,
    clearGeneration,
    status: 'blocked',
    boundary: undefined,
    error,
  });
}

function clearRemoteInputProjectionProbeFailure(sessionId: string, deviceId?: string): void {
  const state = remoteInputProjectionProbeStateBySession.get(sessionId);
  if (!state || state.status !== 'blocked' || (deviceId && state.deviceId !== deviceId)) return;
  remoteInputProjectionProbeStateBySession.delete(sessionId);
}

function getKnownRemoteInputClearBoundary(sessionId: string): RemoteInputClearBoundary {
  if (remoteInputClearBoundaryBySession.has(sessionId)) {
    return remoteInputClearBoundaryBySession.get(sessionId);
  }
  const deviceId = getStickySessionDeviceId(sessionId);
  if (!deviceId) return undefined;
  const session = remoteProjectsStore
    .getDeviceSessions(deviceId)
    .find((candidate) => candidate.id === sessionId);
  if (!session || !Object.prototype.hasOwnProperty.call(session, 'clearedAt')) return undefined;
  return observeRemoteInputClearBoundary(sessionId, session.clearedAt);
}

function getRemoteInputClearBoundaryOpts(
  sessionId: string,
): { expectedClearBoundaryMs: number | null } | undefined {
  if (!getStickySessionDeviceId(sessionId)) return undefined;
  const boundary = getKnownRemoteInputClearBoundary(sessionId);
  return boundary === undefined ? undefined : { expectedClearBoundaryMs: boundary };
}

function observeRemoteInputClearBoundariesFromSnapshot(): void {
  for (const session of remoteProjectsStore.getMergedRemoteSessions()) {
    if (!Object.prototype.hasOwnProperty.call(session, 'clearedAt')) continue;
    observeRemoteInputClearBoundary(session.id, session.clearedAt);
  }
}

/** 标记该 session 刚收到一帧入站事件(O(1) 原始数写入,无分配、无 notify)。 */
function _markInboundEvent(sessionId: string): void {
  _lastInboundEventAt.set(sessionId, Date.now());
}

function isRemoteHeavyInboundChannel(channel: string): boolean {
  return REMOTE_HEAVY_INBOUND_CHANNELS.has(channel);
}

/** 读最近入站事件时刻;无记录返回 undefined(看门狗以 mount 时刻兜底)。 */
function getLastInboundEventAt(sessionId: string): number | undefined {
  return _lastInboundEventAt.get(sessionId);
}

function bumpRendererClearGeneration(sessionId: string): void {
  rendererClearGenerationBySession.set(
    sessionId,
    (rendererClearGenerationBySession.get(sessionId) ?? 0) + 1,
  );
}

function noteRendererClearBoundary(sessionId: string, clearedAt: string): void {
  const parsed = normalizeAgentInputClearBoundaryMs(clearedAt);
  if (typeof parsed !== 'number') return;
  const current = rendererClearBoundaryBySession.get(sessionId);
  if (current === undefined || parsed > current) {
    rendererClearBoundaryBySession.set(sessionId, parsed);
    bumpRendererClearGeneration(sessionId);
  }
}

function isBeforeOrAtRendererClearBoundary(sessionId: string, createdAt: string): boolean {
  const boundary = rendererClearBoundaryBySession.get(sessionId);
  if (boundary === undefined) return false;
  const parsed = new Date(createdAt).getTime();
  return Number.isFinite(parsed) && parsed <= boundary;
}

/**
 * Remove a session's slice from every in-memory structure.
 * Safe to call for sessions that may not be in the Map (no-op for unknowns).
 * Also exported as `purgeSession` so callers (delete/archive handlers) can
 * explicitly free a specific session.
 */
function _purgeSession(sessionId: string): void {
  discardPendingTextDelta(sessionId);
  discardDeferredStateWork(sessionId);
  clearIssueConfirmDraftsForSession(sessionId);
  // 代际递增(bump 而非 delete,原因见 _messagesEpoch 注释):作废 in-flight 翻页,
  // 避免其提交把旧窗口 merge 进 purge 后重建的空 slice。
  invalidateMessageHistoryWindow(sessionId);
  invalidateInputProjectionRequests(sessionId);
  // 删除 / 归档 / LRU 都是 renderer owner 边界。作废仍在附件物化或 composer
  // 交接中的迟到 continuation，且不写入 /clear 的历史时间边界。
  bumpRendererClearGeneration(sessionId);
  cancelRemoteOptimisticSendsForSessionPurge(sessionId);
  sessions.delete(sessionId);
  localSentUserMessageIds.delete(sessionId);
  pendingLocalRetryIntents.delete(sessionId);
  // 状态快照同步失效:该会话若有 running / pending / 待投递 transition 条目,
  // 不能在缓存里残留(purge 不走 setState,需单独置位)。
  _stopTransitions.delete(sessionId);
  markStatusSnapshotDirty();
  listeners.delete(sessionId);
  lightSnapshotCache.delete(sessionId);
  titleUpdateCallbacks.delete(sessionId);
  _historyFetchInFlight.delete(sessionId);
  // 会话已被永久移出缓存:在途请求由 sessions.has(sessionId) 守卫作废,token 条目无需
  // 留作墓碑;新建同 id 会用全局递增 token,不会重新放行旧响应。
  _historyFetchToken.delete(sessionId);
  _historyLoadOrigin.delete(sessionId);
  // 冷缓存 hydrate 的两个守卫随会话一起收掉(会话都没了,守卫留着只是无用条目)。
  _cacheHydrateStarted.delete(sessionId);
  _cacheHydrateSuppressed.delete(sessionId);
  _lastViewedAt.delete(sessionId);
  _lastInboundEventAt.delete(sessionId);
  const i = _accessOrder.indexOf(sessionId);
  if (i !== -1) _accessOrder.splice(i, 1);
}

/**
 * Evict the oldest idle session(s) until the cache is within MAX_CACHED_SESSIONS.
 * Sessions that are currently streaming or running are skipped — we never evict
 * an in-flight session.
 */
function _evictLruIfNeeded(): void {
  while (sessions.size > MAX_CACHED_SESSIONS) {
    const candidate = _accessOrder.find((id) => {
      const s = sessions.get(id);
      // 与 _trimMessagesIfNeeded / _demoteIdleSessions 对齐:绝不回收仍被 mounted view
      // 看着的 session(多窗/分屏副屏钉的 idle 会话),否则 _purgeSession 删 listeners
      // 会把活 view 打成 stale/blank。
      // 后台 subagent 空窗(hasBackgroundAgentWork)同样算 in-flight,
      // 驱逐会丢 taskUpdates 让 sidebar spinner 熄灭。远程会话豁免(同折算口径)。
      return (
        s &&
        !s.isStreaming &&
        !s.agentStatus.isRunning &&
        !hasBackgroundAgentWork(id, s) &&
        !remoteOptimisticSends.has(id) &&
        ![...remoteOptimisticMaterializationRecoveries.values()].some(
          (recovery) =>
            recovery.sessionId === id && isRemoteOptimisticMaterializationRecoveryActive(recovery),
        ) &&
        !_activeViewSessions.has(id)
      );
    });
    if (!candidate) break; // all sessions are active — can't evict safely
    _purgeSession(candidate);
  }
}

// ---------------------------------------------------------------------------
// MEM-OPT-1: Per-session message trimming — cap the in-memory messages array
// so streaming O(n) copies and buildRenderItems scans stay bounded.
// ---------------------------------------------------------------------------

const TRIM_THRESHOLD = 300;
const TRIM_TARGET = 200;

function _isSessionBusy(sessionId: string, s: SessionChatState): boolean {
  return !!(
    s.isStreaming ||
    s.agentStatus.isRunning ||
    // A device-link optimistic send is still an in-flight user action even if
    // the remote projection has not materialized it into pendingQueue yet.
    // Keep trim/demote from dropping its local bubble while the relay recovers.
    remoteOptimisticSends.has(sessionId) ||
    [...remoteOptimisticMaterializationRecoveries.values()].some(
      (recovery) =>
        recovery.sessionId === sessionId &&
        isRemoteOptimisticMaterializationRecoveryActive(recovery),
    ) ||
    // wake 型后台任务在跑 / 唤醒桥接中 — turn 间空窗但会话仍在工作,demote /
    // trim 掉会把 taskUpdates 清空,running 快照当场熄灭(等于把 bug 换个姿势复现)。
    // 远程会话豁免(与折算口径一致,保留 demote 这条自愈路径)。
    hasBackgroundAgentWork(sessionId, s) ||
    s.pendingPermission ||
    s.pendingAskUser ||
    hasPendingPluginSetupInteraction(s.pendingPluginSetup, s.pendingPluginSetupQueue) ||
    s.pendingPlanReview ||
    s.pendingIssueConfirm ||
    s.pendingRenameSessionsConfirm ||
    s.pendingGhostGrantConfirm
  );
}

function _trimMessagesIfNeeded(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (!state || state.messages.length <= TRIM_THRESHOLD) return;
  if (_isSessionBusy(sessionId, state)) return;
  if (_activeViewSessions.has(sessionId)) return;

  // 裁剪等于一次代际重置:它砍掉窗口中段、把 oldestMessageId 清空,in-flight 的翻页 /
  // 跳转补齐若仍按 pre-trim 游标提交,就会把更老的一页直接接到保留的尾部上 —— 中间被裁掉
  // 的区间成了新的空洞,而补齐还可能据此判 covered 并清掉孤岛标记(#676 review)。
  // 所以照 reloadMessages / clear / edit-last 同一规矩:bump epoch 作废 in-flight,并由
  // 本次重置自己释放分页锁。
  bumpMessagesEpoch(sessionId);
  setState(sessionId, (s) => {
    // 兜底早返(当前不可达:上面三道守卫都在 bump 之前,而 setState 是同步的、拿到的就是
    // 同一份 state)。仍然要放锁:epoch 已经 bump 掉,in-flight 的翻页 / 补齐已被作废且
    // 刻意不自清,漏这一处就会让行首守卫把该会话的翻页永久卡住(#676 review greptile)。
    if (s.messages.length <= TRIM_THRESHOLD) {
      return s.isLoadingMore ? { ...s, isLoadingMore: false } : s;
    }
    const preTrimPlanState = getLatestMessageTodoState(s.messages);
    const trimmedMessages = s.messages.slice(-TRIM_TARGET);
    const trimmedPlanState = getLatestMessageTodoState(trimmedMessages);
    const needsPlanReloadAfterTrim =
      s.historyLoaded &&
      preTrimPlanState.insertion !== null &&
      (!trimmedPlanState.hasPlanEvent || !trimmedPlanState.isResolved);

    return {
      ...s,
      messages: trimmedMessages,
      hasMoreMessages: true,
      oldestMessageId: null,
      isLoadingMore: false,
      ...(needsPlanReloadAfterTrim ? { historyLoaded: false } : {}),
      // 孤岛标记**保持原值**:`slice(-TRIM_TARGET)` 只保证"取最新的 200 行",不保证这 200 行
      // 连续 —— 若先前几次深跳留下多个孤岛、而真正连续的尾段不足 200 行,裁剪结果里就还夹着
      // 孤岛。清掉标记会让 canFocusWithoutJumpLoad 把命中孤岛当成已覆盖直接 focus,而从孤岛
      // 边界往上翻又取不到那段更新的缺失区间 → 洞永久固化,直到整会话重载(#676 review)。
      //
      // 代价是出现过孤岛的会话在裁剪后仍会多做补齐尝试;方向上是安全的那一侧。
      // 真正清零只发生在"整窗从最新重建"的路径(reloadMessages / clear / demote / purge)。
      // 注意游标被清成 null:此时补齐会从最新页重新起翻(见 backfillHistoryUntil 的首页分支),
      // 恰好能穿过缺失区间自愈。
    };
  });
}

// ---------------------------------------------------------------------------
// MEM-OPT-2: Soft eviction — demote idle sessions by clearing their messages
// after DEMOTE_IDLE_MS. Re-entering a demoted session triggers
// ensureInitialMessages to reload from DB.
// ---------------------------------------------------------------------------

const DEMOTE_IDLE_MS = 5 * 60_000;
const DEMOTE_CHECK_INTERVAL_MS = 30_000;

const _lastViewedAt = new Map<string, number>();
let _demoteTimerHandle: ReturnType<typeof setInterval> | null = null;

// MEM-OPT-2 active-view set: 哪些 session 当前被 mounted view 看着。
// Demote / trim 跳过 set 内的 session。Set 取代了原 _activeViewSessionId 单例，
// 因为 Orca 双栏会同时挂 lead + worker 两个 view，单例下后挂的会把先挂的
// 误判成 idle 触发 demote 清空 messages。
//
// 当前不支持"同一 sessionId 多 view 同时挂载"（leave 会立即从 set 删除）。
// 如未来出现 popup/preview 等场景，再升级为引用计数 Map。
// Ref-counted: a session may be open in multiple views (e.g. two side-by-side panels).
// Only the last leaveView() call (count → 0) should apply pending error clears.
const _activeViewSessions = new Map<string, number>();

// Sessions that had a terminal error persisted while actively viewed.
// On leave, history is invalidated and live error banner is cleared so the
// reloaded history shows only the persisted ErrorMessageCard.
const _pendingErrorClearOnLeave = new Set<string>();

function enterView(sessionId: string): () => void {
  _activeViewSessions.set(sessionId, (_activeViewSessions.get(sessionId) ?? 0) + 1);
  _lastViewedAt.delete(sessionId);
  _ensureDemoteTimer();
  return () => leaveView(sessionId);
}

function leaveView(sessionId: string): void {
  const count = _activeViewSessions.get(sessionId);
  if (!count) return;
  if (count > 1) {
    // Other views still showing this session; just decrement, don't apply pending clear yet.
    _activeViewSessions.set(sessionId, count - 1);
    return;
  }
  _activeViewSessions.delete(sessionId);
  _lastViewedAt.set(sessionId, Date.now());
  if (_pendingErrorClearOnLeave.has(sessionId)) {
    _pendingErrorClearOnLeave.delete(sessionId);
    setState(sessionId, (s) => ({
      ...s,
      ...(s.historyLoaded ? { historyLoaded: false } : {}),
      ...(s.error ? { error: null, usageLimitRecovery: null, errorRetryText: null } : {}),
    }));
  }
  _trimMessagesIfNeeded(sessionId);
}

function _demoteIdleSessions(): void {
  const now = Date.now();
  const toDemote: string[] = [];
  for (const [sessionId, state] of sessions) {
    if (_activeViewSessions.has(sessionId)) continue;
    if (_isSessionBusy(sessionId, state)) continue;
    if (state.pendingQueue.length > 0) continue;
    if (state.messages.length === 0) continue;
    const lastViewed = _lastViewedAt.get(sessionId);
    if (lastViewed === undefined) continue;
    if (now - lastViewed < DEMOTE_IDLE_MS) continue;
    toDemote.push(sessionId);
  }
  for (const sessionId of toDemote) {
    // 与 reloadMessages / clear / edit-last / grouped-delete / trim 同一规矩:清空窗口
    // 等于代际重置,必须 bump epoch 作废 in-flight 的翻页 / 跳转补齐,并由本次重置释放
    // 分页锁。漏 bump 的后果是 in-flight 那一页按 demote 前的游标提交,把一段脱离上下文
    // 的旧历史 merge 进空切片(或重开后的新切片),最近的消息反而缺席(#676 review)。
    invalidateMessageHistoryWindow(sessionId);
    setState(sessionId, (s) => ({
      ...s,
      messages: [],
      taskUpdates: new Map(),
      historyLoaded: false,
      oldestMessageId: null,
      hasMoreMessages: true,
      isLoadingMore: false,
      historyWindowHasIsland: false,
    }));
  }
}

function _ensureDemoteTimer(): void {
  if (_demoteTimerHandle) return;
  _demoteTimerHandle = setInterval(_demoteIdleSessions, DEMOTE_CHECK_INTERVAL_MS);
}

function _stopDemoteTimer(): void {
  if (_demoteTimerHandle) {
    clearInterval(_demoteTimerHandle);
    _demoteTimerHandle = null;
  }
}

function getOrCreateState(sessionId: string): SessionChatState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = createInitialState();
    sessions.set(sessionId, state);
    _touchSession(sessionId);
    _evictLruIfNeeded();
  } else {
    _touchSession(sessionId);
  }
  return state;
}

function setState(
  sessionId: string,
  updater: (prev: SessionChatState) => SessionChatState,
  opts: { deferNotification?: boolean } = {},
): void {
  const prev = getOrCreateState(sessionId);
  const next = updater(prev);
  if (next === prev) return;
  const previousIssueRequestId = prev.pendingIssueConfirm?.requestId;
  if (previousIssueRequestId && next.pendingIssueConfirm?.requestId !== previousIssueRequestId) {
    clearIssueConfirmDraft(sessionId, previousIssueRequestId);
  }
  sessions.set(sessionId, next);
  // running-status 快照缓存失效(getRunningSnapshot 纯 getter 契约:只有
  // mutation 才允许让下一次读重算)。必须在 notify 之前置位。
  markStatusSnapshotDirty();
  if (opts.deferNotification) {
    queueDeferredStateNotification(sessionId);
    return;
  }
  // 控制事件优先：当前通知已经包含此前同步写入的所有高频状态，撤掉迟到批次。
  pendingDeferredStateNotifications.delete(sessionId);
  if (!hasDeferredStateWork()) clearDeferredStateNotificationTimer();
  emitStateNotifications(sessionId);
  // F-SB-7: notify global listeners so Sidebar can track all sessions
  globalListeners.forEach((cb) => {
    cb();
  });
  // messages:created 的侧栏时间戳与 chat state 保持原有先后：先通知消息，再 patch 列表。
  flushPendingMessageCreatedPatch(sessionId);
  if (!hasDeferredStateWork()) clearDeferredStateNotificationTimer();
}

function notify(sessionId: string): void {
  emitStateNotifications(sessionId);
}

/**
 * 「正在自动继续」ephemeral 卡的固定 clientId。每个会话一份 state，所以固定串足够；
 * 用固定值而不是随机 id，是为了让插入幂等（同一接管窗口内 projection 会 emit 多次）。
 */
/** 浅比较两份 systemCardData（只有原始值字段），用来避免无变化时替换消息引用。 */
function shallowEqualRecord(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown>,
): boolean {
  if (!a) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

const AUTO_RESUME_PENDING_CLIENT_ID = '__auto_resume_pending__';
/** Codex app-server 自带的 Reconnecting N/M 进行态行。与 Cindy 接管行分开，避免
 * 无关的 input projection 把仍在进行中的原生重连误删。 */
const CODEX_RECONNECT_PENDING_CLIENT_ID = '__codex_reconnect_pending__';

function removeCodexReconnectPendingCard(messages: ChatMessage[]): ChatMessage[] {
  if (!messages.some((message) => message.clientId === CODEX_RECONNECT_PENDING_CLIENT_ID)) {
    return messages;
  }
  return messages.filter((message) => message.clientId !== CODEX_RECONNECT_PENDING_CLIENT_ID);
}

function removeResumePendingCards(messages: ChatMessage[]): ChatMessage[] {
  if (
    !messages.some(
      (message) =>
        message.clientId === CODEX_RECONNECT_PENDING_CLIENT_ID ||
        message.clientId === AUTO_RESUME_PENDING_CLIENT_ID,
    )
  ) {
    return messages;
  }
  return messages.filter(
    (message) =>
      message.clientId !== CODEX_RECONNECT_PENDING_CLIENT_ID &&
      message.clientId !== AUTO_RESUME_PENDING_CLIENT_ID,
  );
}

function upsertCodexReconnectPendingCard(
  messages: ChatMessage[],
  data: Record<string, unknown>,
): ChatMessage[] {
  const existingIndex = messages.findIndex(
    (message) => message.clientId === CODEX_RECONNECT_PENDING_CLIENT_ID,
  );
  const card: ChatMessage = {
    clientId: CODEX_RECONNECT_PENDING_CLIENT_ID,
    role: 'assistant',
    content: '',
    isStreaming: false,
    systemCardType: 'auto-resume-pending',
    systemCardData: data,
    createdAt: new Date().toISOString(),
  };
  if (existingIndex >= 0) {
    const existing = messages[existingIndex];
    if (existing && shallowEqualRecord(existing.systemCardData, data)) return messages;
    return messages.map((message, index) =>
      index === existingIndex
        ? { ...existing, ...card, createdAt: existing.createdAt ?? card.createdAt }
        : message,
    );
  }
  return collapseConsecutiveAutoResumeRows([...messages, card]);
}

function isCodexUserActionableRetryError(data: unknown): boolean {
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const message = typeof root.message === 'string' ? root.message : '';
  const sdkError = typeof root.sdkError === 'string' ? root.sdkError : '';
  const rawStatus = root.errorStatus ?? root.status;
  const status =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string' && rawStatus.trim() !== ''
        ? Number(rawStatus)
        : null;
  const authError =
    sdkError === 'authentication_failed' ||
    sdkError === 'authentication_error' ||
    status === 401 ||
    /\b401\b|Missing bearer|authentication_(?:error|failed)|invalid[\s_-]*api[\s_-]*key|api key not valid/i.test(
      message,
    );
  return authError || extractUsageLimitRecoveryHint(data) !== null;
}

/**
 * Codex 原生重连行只应在真正的 turn 进展或明确收尾时让位。
 *
 * `maker:event` 里还混着后台任务更新、tool_result、thinking 等旁路事件；它们
 * 可能属于同一会话但不代表重连已经恢复。Codex 子代理的 descendant 状态通知不会走这条
 * 主事件流，而是专用的 `agent_task_update`；但协作控制调用本身仍可能以 `tool_use` 进入流。
 * `collab:*` 是这类控制调用的稳定命名空间，不代表根 turn 已经恢复，因此不能让它提前
 * 清掉原生行。其它 `tool_use` 仍作为根 turn 的实质进展边界，并与 main 的
 * `isSubstantiveProgressEvent` 对齐。文本仍共用可见文本判据，避免空白 delta 误报恢复。
 */
function isCodexReconnectRecoveryOutput(event: CCAgentStreamEvent): boolean {
  if (event.type === 'text') {
    const text = (event.data as { text?: unknown } | null | undefined)?.text;
    return hasUserVisibleText(text);
  }
  if (event.type === 'tool_use') {
    const toolName = (event.data as { toolName?: unknown } | null | undefined)?.toolName;
    return typeof toolName !== 'string' || !toolName.startsWith('collab:');
  }
  return event.type === 'done' && !isTurnContinuationBoundaryEvent(event);
}

/** Main 的接管 projection 与随后 maker:event 来自两个 channel。只有活动行里保存的
 * 原始错误与终态 event 完全一致，才把 event 视为同一次接管的广播回声；不能仅凭存在
 * 一张 pending 卡就吞掉后来其它 turn 的错误。 */
function hasMatchingAutoResumePendingError(messages: ChatMessage[], data: unknown): boolean {
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const message = typeof root.message === 'string' ? root.message : '';
  if (!message) return false;
  return messages.some(
    (item) =>
      item.clientId === AUTO_RESUME_PENDING_CLIENT_ID &&
      typeof item.systemCardData?.error === 'string' &&
      item.systemCardData.error === message,
  );
}

function applyInputProjection(
  projection: AgentInputProjection,
  opts: { supersedeQueries?: boolean } = {},
): void {
  if (!projection.sessionId) return;
  const knownClearBoundary = remoteInputClearBoundaryBySession.get(projection.sessionId);
  if (typeof knownClearBoundary === 'number') {
    const hasBoundary = Object.prototype.hasOwnProperty.call(projection, 'clearBoundaryMs');
    const incomingBoundary = hasBoundary
      ? normalizeAgentInputClearBoundaryMs(projection.clearBoundaryMs)
      : undefined;
    // Once a numeric clear token is known, a modern projection carrying an
    // older/null token is not authoritative for *any* field. Even an empty
    // stale projection could otherwise overwrite the new epoch's error or
    // lock state. An omitted field is the legacy-client compatibility path.
    if (
      hasBoundary &&
      (typeof incomingBoundary !== 'number' || incomingBoundary < knownClearBoundary)
    ) {
      return;
    }
  }
  // A clear projection is emitted before the sessions row patch. Observe it
  // before applying queue state or pumping the optimistic outbox, otherwise an
  // old local item can be re-enqueued into the freshly cleared context.
  if (Object.prototype.hasOwnProperty.call(projection, 'clearBoundaryMs')) {
    observeRemoteInputClearBoundary(projection.sessionId, projection.clearBoundaryMs);
  }
  if (opts.supersedeQueries !== false) {
    supersedeInputProjectionRequests(projection.sessionId);
  }
  // #2194: 人工 Retry 的一次性意图认领——必须在落库广播（onCreated）可能
  // 到达之前完成登记，main 的 emit 先于 scheduleDrain，这里一定更早。
  claimLocalRetryProductFromProjection(projection);
  // wire 上「字段缺省」就是旧被控端的能力信号；新版没有续跑项时也会显式发 null。
  // 必须在 `?? null` 归一化前按 own property 读取，不能让 undefined/null 混淆版本。
  const continuationInFlightProjectionCapability: ContinuationInFlightProjectionCapability =
    Object.prototype.hasOwnProperty.call(projection, 'continuationTurnClientId')
      ? 'supported'
      : 'legacy';
  const projectedContinuationTurnClientId = projection.continuationTurnClientId ?? null;
  // A reconnect can briefly clear remoteProjectsStore. The projection still
  // belongs to the remote task during that window, so use the sticky origin
  // for optimistic settling/rollback semantics.
  const remoteProjection = isRemoteSessionSticky(projection.sessionId);
  const optimisticRecords = remoteOptimisticSendRecords(projection.sessionId);
  const projectedQueue = projection.pendingQueue as QueuedMessage[];
  const projectedIds = new Set(projectedQueue.map((item) => item.clientId));
  for (const queued of projectedQueue) {
    markRemoteOptimisticSendAccepted(projection.sessionId, queued.clientId, queued);
    cancelRemoteOptimisticSettlingRetirement(projection.sessionId, queued.clientId);
  }
  if (optimisticRecords) {
    for (const record of optimisticRecords.values()) {
      record.currentlyQueued = projectedIds.has(record.queued.clientId);
    }
  }
  let settlingClientIds: string[] = [];
  setState(projection.sessionId, (s) => {
    // DB created 可能先于 projection 回来；正式消息已经占据 transcript 的同一
    // clientId 位置时，不要让稍晚的旧 pendingQueue 再造一行重复队列项。
    const persistedMessageIds = new Set(
      s.messages.filter((message) => !message.isPendingPersist).map((message) => message.clientId),
    );
    const authoritativeQueue = projectedQueue.filter(
      (item) => !persistedMessageIds.has(item.clientId),
    );
    // 旧 projection 先到时保留仍在 enqueue RPC 在途中的本地 sending 行；
    // 一旦权威队列出现同 clientId，就由权威条目接管并移除本地标记。
    const authoritativeIds = new Set(authoritativeQueue.map((item) => item.clientId));
    const pendingQueue = [...authoritativeQueue];
    if (optimisticRecords) {
      for (const record of optimisticRecords.values()) {
        if (record.accepted || authoritativeIds.has(record.queued.clientId)) continue;
        if (s.messages.some((message) => message.clientId === record.queued.clientId)) continue;
        pendingQueue.push({ ...record.queued, isPendingEnqueue: true });
      }
    }

    // 队首连续出队 / steer 标记才进入 settling；中段删除不制造幽灵气泡。
    const currentQueueIds = new Set(pendingQueue.map((item) => item.clientId));
    let vanishedPrefixEnd = 0;
    while (
      vanishedPrefixEnd < s.pendingQueue.length &&
      !currentQueueIds.has(s.pendingQueue[vanishedPrefixEnd].clientId)
    ) {
      vanishedPrefixEnd += 1;
    }
    const locallyRemoved = remoteOptimisticLocallyRemoved.get(projection.sessionId);
    const previousSteeringIds = new Set(s.steeringQueueClientIds);
    const currentSteeringIds = new Set(projection.steeringQueueClientIds);
    const settlingQueueItems = s.pendingQueue.filter((item, index) => {
      if (!remoteProjection) return false;
      if (persistedMessageIds.has(item.clientId)) return false;
      if (currentQueueIds.has(item.clientId)) return false;
      if (locallyRemoved?.has(item.clientId)) return false;
      return (
        index < vanishedPrefixEnd ||
        previousSteeringIds.has(item.clientId) ||
        currentSteeringIds.has(item.clientId)
      );
    });
    settlingClientIds = settlingQueueItems.map((item) => item.clientId);
    // Only trigger if the retried message is still stuck in the pending queue:
    // projection.error is queue-level (string | null, no clientId), so we correlate
    // via pendingQueue. If the retry message was already dispatched and the agent
    // failed again, a new maker:event error will handle persistence instead.
    const authRetryProjectionError =
      s._authRetryPersistOnProjectionError &&
      projection.error &&
      projection.pendingQueue.some(
        (q) => q.clientId === s._authRetryPersistOnProjectionError!.clientId,
      )
        ? s._authRetryPersistOnProjectionError
        : null;
    if (authRetryProjectionError) {
      void makerApiFor(projection.sessionId).input.persistTurnErrorDeferred(
        projection.sessionId,
        authRetryProjectionError.data,
        authRetryProjectionError.agentMeta,
      );
    }
    // 视觉连续性兜底: sendMessage 在"agent 空闲假设"下会乐观把 user 气泡
    // (isPendingPersist) 提前 push 进 messages。如果某条乐观气泡的 clientId 仍停在
    // main 回投的 pendingQueue 里, 说明它实际被排了队(renderer/main busy 判定 race)
    // 或派发失败回退 —— 这条不该同时以消息流气泡 + 队列灰字两种形态出现。撤回乐观
    // 气泡, 回落到队列态。真正被立即派发的那条 clientId 不在 pendingQueue 里, 气泡
    // 保留, 之后 localDb.messages.onCreated 广播按 clientId dedupe 不会重复。
    const queuedIds = new Set(pendingQueue.map((q) => q.clientId));
    const dedupedMessages =
      queuedIds.size > 0 && s.messages.some((m) => m.isPendingPersist && queuedIds.has(m.clientId))
        ? s.messages.filter((m) => !(m.isPendingPersist && queuedIds.has(m.clientId)))
        : s.messages;
    const withSettlingMessages = settlingQueueItems.reduce<ChatMessage[]>((messages, item) => {
      if (messages.some((message) => message.clientId === item.clientId)) return messages;
      return [...messages, { ...item.chatMessage, isPendingPersist: true }];
    }, dedupedMessages);
    // Codex 原生重连已经被 host 接管、进入凭证切换等待或明确回落时，原生进行态行
    // 必须让位给 Cindy 的接管行、凭证切换状态或终态错误。没有这些字段的普通
    // projection 不触碰它，以免无关队列投影把正在更新的 N/M 进度提前擦掉。
    const projectionSettledCodexReconnect = Boolean(
      projection.autoResumePending || projection.error || projection.credentialSwitchWait,
    );
    const messagesBeforeAutoResume = projectionSettledCodexReconnect
      ? removeCodexReconnectPendingCard(withSettlingMessages)
      : withSettlingMessages;
    // 中断自愈接管中 → 在流末尾挂一条 ephemeral 的「正在自动继续」分隔条(不落库);
    // 接管结束(补发已发出 / 放弃 / 用户自己接手)由同一处撤掉。红横幅只留给最终失败,
    // 所以这几秒里 projection.error 是 null,用户看到的就只有这条低调提示。
    const autoResumePending = !!projection.autoResumePending;
    const hasPendingCard = messagesBeforeAutoResume.some(
      (m) => m.clientId === AUTO_RESUME_PENDING_CLIENT_ID,
    );
    const pendingCardData = projection.autoResumePending
      ? ({ ...projection.autoResumePending } as Record<string, unknown>)
      : null;
    const withPendingCard = autoResumePending
      ? hasPendingCard
        ? // 卡已在:必须把最新展示信息写回去 —— 同一次中断的进度会连续更新
          // (1/5 → 2/5 …),原样保留旧卡的话进度永远停在第一次(copilot review)。
          // 只在内容真的变了时才换引用,避免每次 projection 都触发无谓重渲染。
          messagesBeforeAutoResume.map((m) =>
            m.clientId === AUTO_RESUME_PENDING_CLIENT_ID &&
            pendingCardData &&
            !shallowEqualRecord(m.systemCardData, pendingCardData)
              ? { ...m, systemCardData: pendingCardData }
              : m,
          )
        : [
            ...messagesBeforeAutoResume,
            {
              clientId: AUTO_RESUME_PENDING_CLIENT_ID,
              role: 'assistant' as const,
              content: '',
              isStreaming: false,
              systemCardType: 'auto-resume-pending' as const,
              ...(pendingCardData ? { systemCardData: pendingCardData } : {}),
              createdAt: new Date().toISOString(),
            },
          ]
      : hasPendingCard
        ? messagesBeforeAutoResume.filter((m) => m.clientId !== AUTO_RESUME_PENDING_CLIENT_ID)
        : messagesBeforeAutoResume;
    // 折叠:同一次中断事件里,ephemeral 进行中行与它前面那些已落库的重连行只显示最新
    // 一条(否则第 2 次重连时会看到「未成功」+「重新连接中 2/5」两行并存)。
    const messages = collapseConsecutiveAutoResumeRows(withPendingCard);
    // main 可能重复投影同一条 error。相对时间（如 "Try again in 1h"）只能在错误首次出现
    // 时锚定；每次都按新的 Date.now() 重算会让恢复时间持续后移，也会制造无意义的新对象。
    const usageLimitRecovery = !projection.error
      ? null
      : projection.error === s.error
        ? s.usageLimitRecovery
        : extractUsageLimitRecoveryHint({ message: projection.error });
    return {
      ...s,
      messages,
      pendingQueue,
      steeringQueueClientIds: projection.steeringQueueClientIds,
      queuePaused: projection.queuePaused,
      queueExpanded: projection.queueExpanded,
      queueInteractionLocks: projection.queueInteractionLocks,
      queueEditLocks: projection.queueEditLocks,
      queueAbortPending: projection.queueAbortPending,
      error: projection.error,
      usageLimitRecovery,
      // projection 覆盖 error(dispatch 失败等,无 reason 语义)→ reason 一并清,
      // 避免 silent-stop 的「继续」按钮挂在一条不相干的错误上。
      errorReason: null,
      // 进入凭证切换等待态时同步清 stale recoverableError:等待中的消息永不 dispatch,
      // 没有 stream/turn-done 事件替它清 —— 残留会让视图的 error(=recoverableError
      // 回落)遮住等待横幅,复现"静默排队"(review P2 2026-07-04)。
      recoverableError:
        projection.error || projection.credentialSwitchWait ? null : s.recoverableError,
      errorRetryText: projection.errorRetryText,
      credentialSwitchWait: projection.credentialSwitchWait ?? null,
      continuationInFlightClientId: projection.continuationInFlightClientId ?? null,
      continuationTurnClientId: projectedContinuationTurnClientId,
      continuationInFlightProjectionCapability,
      // 线上字段镜像（旧被控端缺省回落 null），供人工 Retry 区分 queue-head /
      // active-turn 归属（#2194 本端意图登记）。
      inputRecovery: projection.recovery ?? null,
      ...(authRetryProjectionError ? { _authRetryPersistOnProjectionError: undefined } : {}),
    };
  });
  for (const clientId of settlingClientIds) {
    scheduleRemoteOptimisticSettlingRetirement(projection.sessionId, clientId);
  }
  if (optimisticRecords) {
    const current = getOrCreateState(projection.sessionId);
    for (const [clientId, record] of optimisticRecords) {
      record.currentlyQueued = current.pendingQueue.some(
        (item) => item.clientId === clientId && item.isPendingEnqueue !== true,
      );
      if (!record.accepted || record.currentlyQueued) continue;
      const hasPendingMessage = current.messages.some(
        (message) => message.clientId === clientId && message.isPendingPersist,
      );
      if (hasPendingMessage) {
        scheduleRemoteOptimisticSettlingRetirement(projection.sessionId, clientId);
      } else {
        clearRemoteOptimisticSend(projection.sessionId, clientId);
      }
    }
  }
  if (remoteProjection) void pumpRemoteOptimisticSends(projection.sessionId);
}

function markSessionHasUserMessage(sessionId: string): void {
  // A late DB acknowledgement must not recreate a session slice that was
  // already purged by delete/archive/LRU cleanup.
  if (!sessions.has(sessionId)) return;
  setState(sessionId, (s) => {
    if (!s.isFirstMessage) return s;
    return { ...s, isFirstMessage: false };
  });
}

function requestInputProjection(
  sessionId: string,
  pinnedDeviceId?: string,
): Promise<InputProjectionRequestResult | undefined> {
  if (!sessionId) return Promise.resolve(undefined);
  const origin = pinnedDeviceId ?? getStickySessionDeviceId(sessionId);
  if (origin) {
    const existing = remoteInputProjectionRequests.get(sessionId);
    if (
      existing &&
      !existing.settled &&
      existing.deviceId === origin &&
      isDataOwnerGenerationCurrent(existing.dataOwner) &&
      (rendererClearGenerationBySession.get(sessionId) ?? 0) === existing.clearGeneration
    ) {
      return existing.promise;
    }
  } else if (typeof window === 'undefined' || !window.electronAPI?.maker?.input?.getProjection) {
    return Promise.resolve(undefined);
  }

  const dataOwner = getDataOwnerGeneration();
  const epoch = beginInputProjectionRequest(sessionId, origin);
  const clearGeneration = rendererClearGenerationBySession.get(sessionId) ?? 0;
  const api = origin ? makerApiForDevice(origin) : makerApiFor(sessionId);
  let request!: RemoteInputProjectionRequest;
  let promise: Promise<InputProjectionRequestResult>;
  try {
    promise = api.input.getProjection(sessionId).then(
      (projection) => {
        request.settled = true;
        const current = isCurrentInputProjectionRequest(sessionId, origin, epoch, dataOwner);
        if (origin && current) {
          noteRemoteInputProjectionSuccess(
            sessionId,
            origin,
            dataOwner,
            clearGeneration,
            projection,
          );
        }
        if (current) {
          applyInputProjection(projection, { supersedeQueries: false });
        }
        return { projection, current };
      },
      (error) => {
        request.settled = true;
        if (origin && isCurrentInputProjectionRequest(sessionId, origin, epoch, dataOwner)) {
          noteRemoteInputProjectionFailure(sessionId, origin, dataOwner, clearGeneration, error);
        }
        throw error;
      },
    );
  } catch (error) {
    const rejected = Promise.reject<InputProjectionRequestResult>(error);
    request = {
      deviceId: origin ?? '',
      dataOwner,
      clearGeneration,
      settled: true,
      promise: rejected,
    };
    if (origin && isCurrentInputProjectionRequest(sessionId, origin, epoch, dataOwner)) {
      noteRemoteInputProjectionFailure(sessionId, origin, dataOwner, clearGeneration, error);
    }
    void rejected.catch((err) => log.warn('get input projection failed:', err));
    return rejected;
  }
  request = {
    deviceId: origin ?? '',
    dataOwner,
    clearGeneration,
    settled: false,
    promise,
  };
  if (origin) remoteInputProjectionRequests.set(sessionId, request);
  // Keep cleanup/logging detached from the returned chain. The outbox awaits
  // the one-hop result above, so a fast projection still reaches dispatch in
  // the same microtask budget as the former direct probe.
  void promise.then(
    () => {
      if (origin && remoteInputProjectionRequests.get(sessionId) === request) {
        remoteInputProjectionRequests.delete(sessionId);
      }
    },
    (err) => {
      if (origin && remoteInputProjectionRequests.get(sessionId) === request) {
        remoteInputProjectionRequests.delete(sessionId);
      }
      log.warn('get input projection failed:', err);
    },
  );
  return promise;
}

// ---------------------------------------------------------------------------
// Stream event handling
// ---------------------------------------------------------------------------

/**
 * Replace a single message that matches `predicate` with `updater(message)`.
 *
 * Streaming hot path optimization: text/thinking deltas land on a freshly
 * appended message that is almost always at (or near) the tail of the
 * array. A reverse scan turns the common case from O(n) to O(1); the
 * shallow array copy is still O(n) but the per-element callback overhead
 * of the previous `.map(...)` implementation is gone.
 *
 * Returns the original array if no match is found, so callers can compare
 * by identity to detect a no-op.
 */
function replaceMessage(
  messages: ChatMessage[],
  predicate: (m: ChatMessage) => boolean,
  updater: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (predicate(messages[i])) {
      const next = messages.slice();
      next[i] = updater(messages[i]);
      return next;
    }
  }
  return messages;
}

type HydratePersistedMessageOptions = {
  preserveExistingToolResultContent?: boolean;
  preserveExistingCodexPlanContent?: boolean;
};

function hydratePersistedMessage(
  existing: ChatMessage,
  persisted: ChatMessage,
  options: HydratePersistedMessageOptions = {},
): ChatMessage {
  const hydrated = {
    ...existing,
    ...persisted,
    ...(existing.retryFiles ? { retryFiles: existing.retryFiles } : {}),
    ...(existing.retryMentions ? { retryMentions: existing.retryMentions } : {}),
  };
  if (
    options.preserveExistingCodexPlanContent === true &&
    existing.role === 'tool_use' &&
    persisted.role === 'tool_use' &&
    existing.toolName === 'update_plan' &&
    persisted.toolName === 'update_plan' &&
    existing.toolUseId === persisted.toolUseId &&
    typeof existing.toolInput === 'object' &&
    existing.toolInput !== null &&
    typeof persisted.toolInput === 'object' &&
    persisted.toolInput !== null &&
    Array.isArray((existing.toolInput as { plan?: unknown }).plan) &&
    Array.isArray((persisted.toolInput as { plan?: unknown }).plan) &&
    // Ordinary DB echoes can lag behind the live Codex event, including rows
    // whose old payload happens to be fully completed or empty. Only Main's
    // explicit done-boundary stamp may close a newer in-memory plan.
    persisted.terminalPlanSnapshot !== true
  ) {
    hydrated.toolInput = existing.toolInput;
    hydrated.content = existing.content;
  }
  if (
    existing.role === 'ask_user' &&
    persisted.role === 'ask_user' &&
    shouldPreserveLiveAskUserState(existing.askUserStatus, persisted.askUserStatus)
  ) {
    hydrated.askUserStatus = existing.askUserStatus;
    hydrated.askUserReply = existing.askUserReply;
    hydrated.askUserAnswers = existing.askUserAnswers;
  }
  if (
    existing.role === 'plan_review' &&
    persisted.role === 'plan_review' &&
    shouldPreserveLivePlanReview(existing, persisted)
  ) {
    hydrated.planReviewStatus = existing.planReviewStatus;
    hydrated.planReviewFeedback = existing.planReviewFeedback;
    hydrated.planReviewPlan = existing.planReviewPlan;
    hydrated.planReviewFilePath = existing.planReviewFilePath;
  }
  const preservedExistingContent = shouldPreserveExistingContent(existing, persisted, options);
  if (preservedExistingContent) {
    hydrated.content = existing.content;
    if (
      existing.role === 'tool_use' &&
      persisted.role === 'tool_use' &&
      persisted.remoteContentTruncated === true
    ) {
      hydrated.toolInput = existing.toolInput;
      hydrated.toolName = existing.toolName;
      hydrated.toolUseId = existing.toolUseId;
    }
  }
  if (
    persisted.remoteContentTruncated !== true ||
    (preservedExistingContent && existing.remoteContentTruncated !== true)
  ) {
    delete hydrated.remoteContentTruncated;
  }
  if (persisted.remoteRowsTrimmed !== true) delete hydrated.remoteRowsTrimmed;
  delete hydrated.isPendingPersist;
  return shallowEqualChatMessage(existing, hydrated) ? existing : hydrated;
}

function shouldPreserveExistingContent(
  existing: ChatMessage,
  persisted: ChatMessage,
  options: HydratePersistedMessageOptions,
): boolean {
  if (existing.content === null || existing.content === undefined) return false;
  if (existing.role !== persisted.role) return false;
  if (persisted.remoteContentTruncated === true)
    return shouldPreserveExistingForRemoteTruncated(existing, persisted);
  return (
    existing.role === 'tool_result' &&
    persisted.role === 'tool_result' &&
    options.preserveExistingToolResultContent === true
  );
}

function shouldPreserveExistingForRemoteTruncated(
  existing: ChatMessage,
  persisted: ChatMessage,
): boolean {
  if (hasOnlyRemoteContentPlaceholder(existing)) return false;
  if (hasOnlyRemoteContentPlaceholder(persisted)) return true;
  if (existing.remoteContentTruncated !== true) return true;
  return (
    remoteTruncatedMessageReadableSize(existing) >= remoteTruncatedMessageReadableSize(persisted)
  );
}

function remoteTruncatedMessageReadableSize(message: ChatMessage): number {
  return (
    valueReadableSize(message.content) +
    valueReadableSize(message.toolInput) +
    valueReadableSize(message.toolName) +
    valueReadableSize(message.toolUseId)
  );
}

function valueReadableSize(value: unknown): number {
  if (value == null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function hasOnlyRemoteContentPlaceholder(message: ChatMessage): boolean {
  return (
    message.remoteContentTruncated === true &&
    message.content === REMOTE_CONTENT_TRUNCATED_PLACEHOLDER
  );
}

function shouldPreserveLiveAskUserState(
  existing: ChatMessage['askUserStatus'],
  persisted: ChatMessage['askUserStatus'],
): boolean {
  if (!existing) return false;
  if (persisted === 'expired') return existing !== 'expired';
  if (persisted === 'pending') return existing !== 'pending';
  return false;
}

function shouldPreserveLivePlanReviewState(
  existing: ChatMessage['planReviewStatus'],
  persisted: ChatMessage['planReviewStatus'],
): boolean {
  if (!existing) return false;
  if (persisted === 'expired') return existing !== 'expired';
  if (persisted === 'pending') return existing !== 'pending';
  return false;
}

function shouldPreserveLivePlanReview(existing: ChatMessage, persisted: ChatMessage): boolean {
  if (shouldPreserveLivePlanReviewState(existing.planReviewStatus, persisted.planReviewStatus)) {
    return true;
  }
  return (
    existing.planReviewStatus === 'pending' &&
    persisted.planReviewStatus === 'pending' &&
    existing.planReviewRequestId === persisted.planReviewRequestId
  );
}

function shallowEqualChatMessage(a: ChatMessage, b: ChatMessage): boolean {
  const aKeys = Object.keys(a) as Array<keyof ChatMessage>;
  const bKeys = Object.keys(b) as Array<keyof ChatMessage>;
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.is(a[key], b[key]));
}

function isoFromEpochMs(value: unknown, fallbackMs = Date.now()): string {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : fallbackMs;
  return new Date(ms).toISOString();
}

/**
 * F1-a Option C 纯展示原语:按 main 下发的 persistId 找 tool_result 气泡,有则用权威
 * content 整体替换(content 没变则 no-op 避免无谓 re-render),无则新建。内容重排/落库
 * 都在 main(messagePersistBroadcaster),这里不做任何 summary↔全文判断、不持有 Map。
 */
function upsertToolResultMessage(
  state: SessionChatState,
  persistId: string,
  content: string,
  toolUseId: string | undefined,
): SessionChatState {
  const idx = state.messages.findIndex((m) => m.clientId === persistId && m.role === 'tool_result');
  if (idx >= 0) {
    if (state.messages[idx].content === content) return state;
    const next = state.messages.slice();
    next[idx] = { ...next[idx], content };
    return { ...state, messages: next };
  }
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        clientId: persistId,
        role: 'tool_result',
        content,
        toolUseId,
        isStreaming: false,
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

function isTerminalErrorData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return true;
  const errorData = data as { isTerminal?: unknown; willRetry?: unknown };
  if (typeof errorData.isTerminal === 'boolean') return errorData.isTerminal;
  if (typeof errorData.willRetry === 'boolean') return !errorData.willRetry;
  return true;
}

function normalizeAgentTaskUpdate(
  data: unknown,
  source?: 'claude-code' | 'codex' | 'pi',
): AgentTaskUpdate | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  const taskId = typeof raw.taskId === 'string' && raw.taskId.length > 0 ? raw.taskId : undefined;
  const parentToolUseId =
    typeof raw.parentToolUseId === 'string' && raw.parentToolUseId.length > 0
      ? raw.parentToolUseId
      : undefined;
  if (!taskId && !parentToolUseId) return null;
  const rawStatus = raw.status;
  const status: AgentTaskStatus =
    rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped'
      ? rawStatus
      : 'running';
  const provider =
    raw.provider === 'codex' || raw.provider === 'claude-code' || raw.provider === 'pi'
      ? raw.provider
      : source === 'codex'
        ? 'codex'
        : source === 'pi'
          ? 'pi'
          : 'claude-code';
  const usageRaw =
    raw.usage && typeof raw.usage === 'object' ? (raw.usage as Record<string, unknown>) : null;
  const usage = usageRaw
    ? {
        ...(typeof usageRaw.totalTokens === 'number' ? { totalTokens: usageRaw.totalTokens } : {}),
        ...(typeof usageRaw.toolUses === 'number' ? { toolUses: usageRaw.toolUses } : {}),
        ...(typeof usageRaw.durationMs === 'number' ? { durationMs: usageRaw.durationMs } : {}),
      }
    : undefined;
  const workflowProgress = normalizeWorkflowProgressEntries(raw.workflowProgress);
  return {
    provider,
    taskId: taskId ?? parentToolUseId!,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    status,
    ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
    ...(typeof raw.description === 'string' && raw.description
      ? { description: raw.description }
      : {}),
    ...(typeof raw.summary === 'string' && raw.summary ? { summary: raw.summary } : {}),
    ...(typeof raw.outputFile === 'string' && raw.outputFile ? { outputFile: raw.outputFile } : {}),
    ...(usage && Object.keys(usage).length > 0 ? { usage } : {}),
    ...(typeof raw.lastToolName === 'string' && raw.lastToolName
      ? { lastToolName: raw.lastToolName }
      : {}),
    ...(typeof raw.taskType === 'string' && raw.taskType ? { taskType: raw.taskType } : {}),
    ...(typeof raw.workflowName === 'string' && raw.workflowName
      ? { workflowName: raw.workflowName }
      : {}),
    ...(raw.model === null
      ? { model: null }
      : typeof raw.model === 'string' && raw.model
        ? { model: raw.model }
        : {}),
    ...(typeof raw.reasoningEffort === 'string' && raw.reasoningEffort
      ? { reasoningEffort: raw.reasoningEffort }
      : {}),
    ...(Array.isArray(raw.receiverThreadIds)
      ? {
          receiverThreadIds: raw.receiverThreadIds.filter(
            (id): id is string => typeof id === 'string',
          ),
        }
      : {}),
    ...(workflowProgress ? { workflowProgress } : {}),
    ...(typeof raw.createdAt === 'string' && raw.createdAt ? { createdAt: raw.createdAt } : {}),
    ...(typeof raw.updatedAt === 'string' && raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
  };
}

function mergeAgentTaskUpdate(
  prev: AgentTaskUpdate | undefined,
  next: AgentTaskUpdate,
): AgentTaskUpdate {
  if (!prev) return next;
  return {
    ...prev,
    ...next,
    usage: next.usage ?? prev.usage,
    title: next.title ?? prev.title,
    description: next.description ?? prev.description,
    summary: next.summary ?? prev.summary,
    outputFile: next.outputFile ?? prev.outputFile,
    lastToolName: next.lastToolName ?? prev.lastToolName,
    // CLI 节流帧不带 workflowProgress(undefined = 沿用旧树),必须保留上一帧。
    workflowProgress: next.workflowProgress ?? prev.workflowProgress,
    createdAt: prev.createdAt ?? next.createdAt,
    model: next.model === null ? null : next.model ?? prev.model,
    updatedAt: next.updatedAt ?? prev.updatedAt,
  };
}

/**
 * 会「唤醒」主 agent 的后台任务类型(SDK task_started.task_type)。这类任务
 * 完成后 SDK 必定自动开新 turn(task_notification 注入),所以任务在跑 =
 * 会话仍在工作,sidebar running 快照要把它折算进 running。
 *
 * 刻意排除:
 *  - local_bash  — 后台 shell 可能是长驻进程(dev server 等),折进去会永久转圈;
 *  - remote_agent — 云端任务生命周期不受本地控制,保守不折;
 *  - 未知/缺失 task_type — 白名单外一律不折,宁可少转不可多转。
 */
const WAKE_AGENT_TASK_TYPES: ReadonlySet<string> = new Set(['local_agent', 'local_workflow']);

function isWakeAgentTask(task: AgentTaskUpdate): boolean {
  return (
    task.provider === 'claude-code' &&
    typeof task.taskType === 'string' &&
    WAKE_AGENT_TASK_TYPES.has(task.taskType)
  );
}

/**
 * 会话是否有仍在运行的 wake 型后台任务(subagent / workflow)。
 * getRunningSnapshot / LRU 驱逐守卫共用:这类任务在跑时会话视为 busy。
 * taskUpdates 里 taskId / parentToolUseId 别名指向同一 merged 对象,boolean
 * 判定重复遍历无碍。
 */
function hasRunningWakeTask(state: SessionChatState): boolean {
  const tasks = state.taskUpdates;
  if (!tasks || tasks.size === 0) return false;
  for (const task of tasks.values()) {
    if (task.status === 'running' && isWakeAgentTask(task)) return true;
  }
  return false;
}

/**
 * 折算总入口:该会话是否有「本地」后台 agent 工作(wake 任务在跑 / 唤醒桥接中)。
 * getRunningSnapshot / _isSessionBusy / _evictLruIfNeeded 统一走这里。
 *
 * 远程(device-link 控制端)会话豁免(review P1):mirror 事件有设计内的丢失
 * 窗口(断连/重连),而 taskUpdates 不在 reconcile 对账覆盖内、stall 看门狗只认
 * agentStatus.isRunning——终态事件掉在窗口里的话 spinner 会永久转且无自愈路径,
 * demote 兜底还会被 busy 守卫自己挡掉。远程侧宁可保持修复前行为(空窗期不转),
 * 换确定性;被控端本机的 sidebar 折算不受影响。
 */
function hasBackgroundAgentWork(sessionId: string, state: SessionChatState): boolean {
  if (!state.pendingTaskWake && !hasRunningWakeTask(state)) return false;
  return !isRemoteSession(sessionId);
}

/**
 * 把 taskUpdates 里 running 任务标为 stopped。
 *  - scope='all'(session closed 兜底):事件流已断,所有 provider / 类型的
 *    running 残留都只会让 spinner / tasks 面板永久卡住,全部收口。
 *  - scope='wake'(用户 Stop):只收 wake 型(local_agent / local_workflow)。
 *    后台 bash(dev server)/ codex / remote 任务不因 interrupt 而死,标 stopped
 *    是错误显示——静默型任务只在状态变化时推事件,窗口期没有 task_progress
 *    帮它翻回 running(review P2)。
 * 别名键共享同一对象——用旧→新映射保持共享关系,维持 isSameAgentTaskAlias 语义。
 * 若之后 SDK 仍推送该任务的 task_progress(任务实际存活),条目会被翻回 running,
 * 状态自愈,不会误杀。
 */
function stopRunningAgentTasks(
  tasks: ReadonlyMap<string, AgentTaskUpdate> | undefined,
  scope: 'all' | 'wake',
): ReadonlyMap<string, AgentTaskUpdate> | undefined {
  if (!tasks || tasks.size === 0) return tasks;
  let changed = false;
  const replaced = new Map<AgentTaskUpdate, AgentTaskUpdate>();
  const next = new Map<string, AgentTaskUpdate>();
  for (const [key, task] of tasks) {
    if (task.status !== 'running' || (scope === 'wake' && !isWakeAgentTask(task))) {
      next.set(key, task);
      continue;
    }
    let stopped = replaced.get(task);
    if (!stopped) {
      stopped = { ...task, status: 'stopped' };
      replaced.set(task, stopped);
    }
    next.set(key, stopped);
    changed = true;
  }
  return changed ? next : tasks;
}

/**
 * 快照对账收口:把「早于快照请求就已 running、但 main 权威表里已不存在」的
 * claude-code 条目标 stopped —— 终态 agent_task_update 丢失时的自愈路径
 * (此前 taskUpdates 不在任何 reconcile 覆盖内,终态掉帧 = spinner 永久转)。
 *
 * 时序安全性(为何不会误杀在跑任务):main 的 runningBackgroundTasks 在
 * translator push 事件时旁路更新,严格先于事件抵达 renderer——store 里能看到
 * running 的任务,main 表在更早时刻必然有它。candidates 限定为**发起快照请求
 * 之前**就已 running 的 taskId:请求在飞窗口内新启动的任务不在候选集,不收;
 * 候选任务若不在其后拉到的快照里,说明 main 侧已出表(终态/被停/会话不活跃),
 * 收口正确。即便极端竞态下收错,后续真实事件(task_progress → running /
 * task_notification → 终态)仍会覆盖回来,非终局性错误。
 *
 * 仅 provider==='claude-code'(快照通道只覆盖 claude-code 的任务表;codex /
 * pi 条目对空快照没有任何含义)。别名键(taskId / parentToolUseId)共享同一
 * 新对象,口径 = stopRunningAgentTasks。
 */
function reconcileStaleRunningTasks(
  state: SessionChatState,
  snapshot: ReadonlyArray<{ taskId: string; toolUseId?: string }>,
  candidates: ReadonlySet<string>,
): SessionChatState {
  const tasks = state.taskUpdates;
  if (!tasks || tasks.size === 0) return state;
  const alive = new Set<string>();
  for (const t of snapshot) {
    if (t && typeof t.taskId === 'string' && t.taskId) alive.add(t.taskId);
    if (t && typeof t.toolUseId === 'string' && t.toolUseId) alive.add(t.toolUseId);
  }
  let changed = false;
  const replaced = new Map<AgentTaskUpdate, AgentTaskUpdate>();
  const next = new Map<string, AgentTaskUpdate>();
  for (const [key, task] of tasks) {
    const stale =
      task.status === 'running' &&
      task.provider === 'claude-code' &&
      candidates.has(task.taskId) &&
      !alive.has(task.taskId) &&
      !(task.parentToolUseId && alive.has(task.parentToolUseId));
    if (!stale) {
      next.set(key, task);
      continue;
    }
    let stopped = replaced.get(task);
    if (!stopped) {
      stopped = { ...task, status: 'stopped' as const };
      replaced.set(task, stopped);
    }
    next.set(key, stopped);
    changed = true;
  }
  return changed ? { ...state, taskUpdates: next } : state;
}

function isSameAgentTaskAlias(left: AgentTaskUpdate, right: AgentTaskUpdate): boolean {
  if (left.taskId === right.taskId) return true;
  if (left.parentToolUseId && left.parentToolUseId === right.taskId) return true;
  if (right.parentToolUseId && right.parentToolUseId === left.taskId) return true;
  return Boolean(
    left.parentToolUseId && right.parentToolUseId && left.parentToolUseId === right.parentToolUseId,
  );
}

/**
 * ask_user 答案 → answered 气泡的人类可读 reply 摘要。三处复用(答题端 answerUserQuestion、
 * 对端 resolve 收敛的 permission_dismissed、历史重建 mapServerMessages)必须逐字一致,
 * 否则同一问题在不同路径下渲染出不同 reply。单点收口防漂。
 */
function formatAskUserReply(answers: Record<string, string>): string {
  return Object.entries(answers)
    .map(([q, a]) => `${q}: ${a || '(skipped)'}`)
    .join('\n');
}

/**
 * Opus 4.8+ / Fable 5 默认 thinking display='omitted':API 只回加密 signature,
 * thinking 明文是空串、也没有任何 thinking_delta(所以 translator 的 durationMs
 * 恒为 0)。这种块渲染出来就是一行既无内容、时长又是假的("Thought for 1s",
 * formatDuration 把 0 钳成 1s)的噪音卡片 —— 直接不建卡。
 * 判定收紧到 text 空 && durationMs===0:真实流过 delta 的块 durationMs>0,
 * 即使最终文本为空也保留(时长本身是真实信息);redacted 块走独立 stage,不经此判定。
 * 上游恢复 summarized 明文下发后(delta / text 回来),此判定自动不再命中。
 */
export function isOmittedThinkingPlaceholder(text: string, durationMs: number): boolean {
  return text === '' && durationMs === 0;
}

/** pi 旧版 translator 把结构化 redacted 块误存成了这条可见占位文本。 */
function isLegacyRedactedThinkingPlaceholder(m: Message, text: string): boolean {
  return m.agentKind === 'pi' && text.trim() === '[Reasoning redacted]';
}

// F1-a: 所有 agent 消息(assistant/tool_use/tool_result/thinking/ask_user/plan_review)
// 的落库已收口 main(messagePersistBroadcaster),handleStreamEvent 退化为纯 UI reducer、
// 不再写库 → 不再需要 sessionId 形参(已从签名移除,各调用点同步去掉第三个实参)。
export function handleStreamEvent(
  inputState: SessionChatState,
  event: CCAgentStreamEvent,
): SessionChatState {
  const reconnectAttempt =
    event.type === 'error'
      ? parseReconnectAttemptMessage(
          typeof (event.data as { message?: unknown } | null | undefined)?.message === 'string'
            ? (event.data as { message: string }).message
            : '',
        )
      : null;
  const isCodexReconnectProgress =
    event.type === 'error' &&
    event.source === 'codex' &&
    !isTerminalErrorData(event.data) &&
    reconnectAttempt !== null &&
    !isCodexUserActionableRetryError(event.data);
  const hasCodexReconnectRecoveryOutput = isCodexReconnectRecoveryOutput(event);
  const shouldClearCodexReconnectPendingCard =
    event.type === 'error' ? !isCodexReconnectProgress : hasCodexReconnectRecoveryOutput;
  const stateBeforeReconnectCleanup =
    !hasCodexReconnectRecoveryOutput || inputState.recoverableError == null
      ? inputState
      : { ...inputState, recoverableError: null };
  const messagesAfterReconnectCleanup = shouldClearCodexReconnectPendingCard
    ? removeCodexReconnectPendingCard(stateBeforeReconnectCleanup.messages)
    : stateBeforeReconnectCleanup.messages;
  const state =
    messagesAfterReconnectCleanup === stateBeforeReconnectCleanup.messages
      ? stateBeforeReconnectCleanup
      : { ...stateBeforeReconnectCleanup, messages: messagesAfterReconnectCleanup };
  // agent-meta: 任何带 agentMeta 的事件都刷新 lastAgentMeta——mid-turn 抢救
  // assistant 累积流时拿这份当 fallback。直接 mutate state 不行，下面各 case
  // 在 return 时把它合并进去；如果 case 没主动处理 lastAgentMeta，由下面统一兜底。
  const incomingMeta = event.agentMeta ?? null;
  // assistant 展示元数据投影:
  // - model / parentUuid 让纯文本子代理在 streaming 阶段也能反查模型 chip;
  // - turnCompleted 由 main 在 done 边界盖到该 SDK turn 的最后一条 assistant 上,
  //   让后台任务自动续跑时前一轮正式总结不会被后续补充回复顶掉。
  const assistantMetaFields: {
    model?: string;
    parentToolUseId?: string;
    turnCompleted?: boolean;
  } = {
    ...(typeof incomingMeta?.model === 'string' && incomingMeta.model
      ? { model: incomingMeta.model }
      : {}),
    ...(typeof incomingMeta?.parentUuid === 'string' && incomingMeta.parentUuid
      ? { parentToolUseId: incomingMeta.parentUuid }
      : {}),
    ...(incomingMeta?.turnCompleted === true ? { turnCompleted: true } : {}),
  };
  switch (event.type) {
    case 'text': {
      const { text, isFinal, isFullText } = event.data as {
        text: string;
        isFinal: boolean;
        isFullText?: boolean;
      };

      if (isFinal) {
        // Confirmation of streamed text, or a non-streaming final burst.
        if (!state.streamingClientId && text) {
          // Guard: if the last message is an assistant with identical content,
          // this is a duplicate isFinal event from the SDK — skip it.
          const last = state.messages[state.messages.length - 1];
          if (last && last.role === 'assistant' && last.content === text && !last.isStreaming) {
            return state;
          }

          // F1-a: clientId 用 main 下发的 persistId(落库由 main 单点做,见
          // messagePersistBroadcaster);main onCreated 回来时同 id 命中 dedup,不新增。
          // persistId 缺失(异常)时退回随机 id,只保证渲染、不保证 dedup。
          const clientId = event.persistId ?? crypto.randomUUID();

          return {
            ...state,
            lastAgentMeta: incomingMeta ?? state.lastAgentMeta,
            messages: [
              ...state.messages,
              {
                clientId,
                role: 'assistant',
                content: text,
                isStreaming: false,
                createdAt: new Date().toISOString(),
                ...assistantMetaFields,
              },
            ],
          };
        }
        // 流式中的 isFinal 不重复落库。只有显式 isFullText 是 SDK 权威全文，
        // 可校准在途气泡；Claude Code 的局部 text block / 截断尾段不能覆盖整条消息。
        // subagent-model-chip: 流式起点的 delta 事件不带 agentMeta(见 CCAgentStreamEvent
        // 注释:delta 类无此字段),只有这条来自 SDK assistant message 的 isFinal 带 ——
        // 把 model/parentToolUseId 补写到在途流式 assistant 消息上,否则纯文本(零工具)
        // 子代理在流式渲染期间 buildSubagentModelMap 始终为空、chip 缺失(仅重载后才补上)。
        const hasAssistantFields =
          assistantMetaFields.model !== undefined ||
          assistantMetaFields.parentToolUseId !== undefined ||
          assistantMetaFields.turnCompleted === true;
        const shouldCalibrateText = Boolean(
          isFullText === true && text && state.streamingClientId && text !== state.streamingText,
        );
        if (!incomingMeta && !hasAssistantFields && !shouldCalibrateText) return state;
        return {
          ...state,
          ...(shouldCalibrateText ? { streamingText: text } : {}),
          ...(incomingMeta ? { lastAgentMeta: incomingMeta } : {}),
          ...((hasAssistantFields || shouldCalibrateText) && state.streamingClientId
            ? {
                messages: replaceMessage(
                  state.messages,
                  (m) => m.clientId === state.streamingClientId,
                  (m) => ({
                    ...m,
                    ...(shouldCalibrateText ? { content: text } : {}),
                    ...assistantMetaFields,
                  }),
                ),
              }
            : {}),
        };
      }

      // Delta update
      if (!state.streamingClientId) {
        // F1-a: 在途流式气泡用 main 下发的 persistId 当 clientId(贯穿本 block 所有 delta),
        // 让该 block 最终由 main 落库后的 onCreated 同 id 命中 dedup。
        const clientId = event.persistId ?? crypto.randomUUID();
        return {
          ...state,
          streamingClientId: clientId,
          streamingText: text,
          messages: [
            ...state.messages,
            {
              clientId,
              role: 'assistant',
              content: text,
              isStreaming: true,
              createdAt: new Date().toISOString(),
              ...assistantMetaFields,
            },
          ],
        };
      }

      const nextText = state.streamingText + text;
      const id = state.streamingClientId;
      return {
        ...state,
        streamingText: nextText,
        messages: replaceMessage(
          state.messages,
          (m) => m.clientId === id,
          (m) => ({ ...m, content: nextText }),
        ),
      };
    }

    case 'thinking': {
      // Extended thinking from Anthropic API. Persisted on `final`/`redacted`
      // so reopening the session restores the cards (see mapServerMessages).
      // Live `start`/`delta` updates remain in-memory only — no per-token
      // network round-trip.
      // Stages mirror the Anthropic SDK's content-block lifecycle:
      //   start    → create new in-progress message
      //   delta    → append text to that message's content
      //   final    → freeze with duration; mark not streaming; persist
      //   redacted → standalone locked message (no plaintext); persist
      const data = event.data as
        | { stage: 'start'; blockId: string; startedAt: number }
        | { stage: 'delta'; blockId: string; text: string }
        | { stage: 'final'; blockId: string; text: string; durationMs: number }
        | { stage: 'redacted'; blockId: string };

      if (data.stage === 'start') {
        // Thinking starts at the head of an API call, possibly before any
        // assistant text. Don't finalize streamingText here — text deltas
        // may resume on the *same* assistant message after the thinking
        // block closes (per Anthropic content-block ordering).
        return {
          ...state,
          messages: [
            ...state.messages,
            {
              clientId: data.blockId,
              role: 'thinking',
              content: '',
              isStreaming: true,
              thinkingStartedAt: data.startedAt,
              createdAt: isoFromEpochMs(data.startedAt),
              ...assistantMetaFields,
            },
          ],
        };
      }

      if (data.stage === 'delta') {
        return {
          ...state,
          messages: replaceMessage(
            state.messages,
            (m) => m.clientId === data.blockId && m.role === 'thinking',
            (m) => ({ ...m, content: m.content + data.text }),
          ),
        };
      }

      if (data.stage === 'final') {
        // Known limitation: if `start` was somehow lost in flight (IPC order
        // is guaranteed by Electron, so this should never happen in practice),
        // the fallback below pushes the message at the END of the array — it
        // will visually render AFTER any tool_use cards that arrived between
        // start and final. Acceptable for a defensive fallback that should
        // never fire; making it position-aware would require sorting by
        // creation timestamp.
        //
        // F1-a Phase 6: thinking 落库已收口 main(messagePersistBroadcaster.onThinkingEvent
        // 在 thinking final 落 { kind, text, durationMs, isRedacted:false })。clientId 仍是
        // 稳定的 data.blockId(main/renderer 同源,本就跨窗幂等),renderer 只做 UI。
        // Defensive: if the start event was missed (e.g. very fast thinking
        // that arrived only as the final block), create the message now
        // rather than dropping the content.
        const exists = state.messages.some((m) => m.clientId === data.blockId);
        if (!exists) {
          // omitted-display 占位块(空文本 + 0 时长,无 start/delta 先行)不建卡,
          // 见 isOmittedThinkingPlaceholder 注释。落库仍由 main 照常进行,只是不渲染。
          if (isOmittedThinkingPlaceholder(data.text, data.durationMs)) {
            return state;
          }
          return {
            ...state,
            messages: [
              ...state.messages,
              {
                clientId: data.blockId,
                role: 'thinking',
                content: data.text,
                isStreaming: false,
                thinkingDurationMs: data.durationMs,
                thinkingStartedAt: Date.now() - data.durationMs,
                createdAt: new Date().toISOString(),
                ...assistantMetaFields,
              },
            ],
          };
        }
        return {
          ...state,
          messages: state.messages.map((m) =>
            m.clientId === data.blockId && m.role === 'thinking'
              ? {
                  ...m,
                  content: data.text, // overwrite with authoritative full text
                  isStreaming: false,
                  thinkingDurationMs: data.durationMs,
                  // subagent-model-chip: thinking 'start' 的 delta 常不带 agentMeta,
                  // 真正的 model/parentUuid 在这条 final(来自 SDK message)才到 —— 补写,
                  // 覆盖纯 thinking(无 text/tool)子代理被 stop/fail 的运行时场景。
                  ...assistantMetaFields,
                }
              : m,
          ),
        };
      }

      // stage === 'redacted' —— 加密推理不进渲染列表。部分 vendor（如 pi）会先发
      // thinking start、到 end 才能从 partial block 确认 redacted；因此还要删掉同
      // blockId 的瞬时占位，不能只阻止新增。
      //
      // 这类块没有任何明文可读,卡片只能显示"无法显示的思考过程";上游(如 Grok 开了
      // 服务端搜索)一轮能产出十几条,会把真实产出淹掉。落库仍由 main(onThinkingEvent)
      // 照旧收口、encrypted_content 也不受影响(回放走 agent 侧 transcript,不依赖这里),
      // 这里只是不展示。恢复展示 = 删掉这个提前 return,并同步 mapServerMessages 的同名过滤。
      //
      // 不展示 ≠ 丢事件:仍按本函数开头的不变量刷新 lastAgentMeta(带 agentMeta 的事件都要刷,
      // mid-turn 抢救 assistant 累积流时拿它当 fallback)。否则这条事件携带的 model /
      // parentUuid 会被静默吞掉。
      const hasLivePlaceholder = state.messages.some(
        (m) => m.clientId === data.blockId && m.role === 'thinking',
      );
      if (!hasLivePlaceholder) {
        return incomingMeta ? { ...state, lastAgentMeta: incomingMeta } : state;
      }
      return {
        ...state,
        messages: state.messages.filter(
          (m) => !(m.clientId === data.blockId && m.role === 'thinking'),
        ),
        ...(incomingMeta ? { lastAgentMeta: incomingMeta } : {}),
      };
    }

    case 'agent_task_update': {
      const update = normalizeAgentTaskUpdate(event.data, event.source);
      if (!update) return incomingMeta ? { ...state, lastAgentMeta: incomingMeta } : state;
      const nextMap = new Map(state.taskUpdates ?? []);
      const keys = new Set<string>([update.taskId]);
      if (update.parentToolUseId) keys.add(update.parentToolUseId);
      for (const [key, value] of nextMap) {
        if (!isSameAgentTaskAlias(value, update)) continue;
        keys.add(key);
        keys.add(value.taskId);
        if (value.parentToolUseId) keys.add(value.parentToolUseId);
      }
      const existing = [...keys]
        .map((key) => nextMap.get(key))
        .find((value): value is AgentTaskUpdate => Boolean(value));
      const now = new Date().toISOString();
      const timedUpdate: AgentTaskUpdate = {
        ...update,
        createdAt: update.createdAt ?? existing?.createdAt ?? now,
        updatedAt: update.updatedAt ?? now,
      };
      let merged: AgentTaskUpdate | undefined;
      for (const key of keys) {
        merged = mergeAgentTaskUpdate(nextMap.get(key), merged ?? timedUpdate);
      }
      if (!merged) merged = timedUpdate;
      for (const key of keys) nextMap.set(key, merged);
      // 唤醒桥接(见 pendingTaskWake 字段注释):wake 型任务在「无 turn 在跑」的
      // 空窗里到达 completed / failed 终态 → SDK 马上会自动开 wake turn,置位
      // 桥接标记撑住 running 快照,防止空窗里闪出假的 running→stopped 转换。
      // stopped(interrupt 杀掉)不置位——不会有 wake turn 跟进,置了就永久转圈。
      // 已知竞态(有意接受):任务终态若恰在主 turn Done 前一瞬到达(isRunning
      // 仍 true),不置桥接 → 紧跟的 Done 会提前发一次 done 通知,wake turn 结束
      // 再发一次(即退化为修复前行为,不劣于现状;反向置位会被紧跟的 Done 清掉,
      // renderer 侧无法彻底关死)。
      const wakesAfterTerminal =
        (merged.status === 'completed' || merged.status === 'failed') &&
        isWakeAgentTask(merged) &&
        !state.agentStatus.isRunning;
      return {
        ...state,
        lastAgentMeta: incomingMeta ?? state.lastAgentMeta,
        taskUpdates: nextMap,
        pendingTaskWake: state.pendingTaskWake || wakesAfterTerminal,
      };
    }

    case 'tool_use': {
      const { toolUseId, toolName, input } = event.data as {
        toolUseId: string;
        toolName: string;
        input: unknown;
      };

      // F1-a: 在飞 assistant 文本 + tool_use 的落库都已收口 main(messagePersistBroadcaster
      // 在 tool_use 边界先 flushAssistantBlock 再落 tool_use),renderer 这里只做 UI:
      // finalize 在飞气泡 + 用 main 下发的 persistId 建 tool_use 气泡(onCreated 同 id dedup)。
      // Finalize any in-flight assistant message first
      const finalized = finalizeStreamingInState(state);
      const clientId = event.persistId ?? crypto.randomUUID();

      const existingUpdatableToolIdx =
        toolName === 'update_plan' || toolName === 'web_search'
          ? finalized.messages.findIndex(
              (m) => m.role === 'tool_use' && m.toolName === toolName && m.toolUseId === toolUseId,
            )
          : -1;
      if (existingUpdatableToolIdx >= 0) {
        const messages = finalized.messages.slice();
        messages[existingUpdatableToolIdx] = {
          ...messages[existingUpdatableToolIdx],
          content: formatToolUseSummary(toolName, input),
          toolInput: input,
          ...(toolName === 'update_plan'
            ? { planUpdatedAtMs: Date.now(), terminalPlanSnapshot: false }
            : {}),
        };
        return {
          ...finalized,
          messages,
        };
      }

      return {
        ...finalized,
        messages: [
          ...finalized.messages,
          {
            clientId,
            role: 'tool_use',
            content: formatToolUseSummary(toolName, input),
            toolUseId,
            toolName,
            toolInput: input,
            ...(toolName === 'update_plan' ? { planUpdatedAtMs: Date.now() } : {}),
            isStreaming: false,
            createdAt: new Date().toISOString(),
            // subagent-model-chip: 透传 SDK model / parent_tool_use_id,让
            // Agent/Task 行能反查出子代理跑的模型。仅 present 才写(主线程
            // tool_use 无 parentUuid)。
            ...(typeof incomingMeta?.model === 'string' && incomingMeta.model
              ? { model: incomingMeta.model }
              : {}),
            ...(typeof incomingMeta?.parentUuid === 'string' && incomingMeta.parentUuid
              ? { parentToolUseId: incomingMeta.parentUuid }
              : {}),
          },
        ],
      };
    }

    case 'tool_result': {
      // F1-a Option C: tool_result 的内容重排(summary↔全文、buffer 归并、多 toolUseId)
      // + 落库全在 main(messagePersistBroadcaster.onToolResultEvent)。renderer 纯展示:
      // 用 main 下发的 persistId + resolvedContent 建/更新气泡;无 persistId(main 仍在
      // buffer、暂无显示)→ no-op。气泡 clientId == persistId,onCreated 同 id dedup。
      if (!event.persistId) return state;
      const { toolUseIds } = event.data as { toolUseIds?: unknown };
      const primaryToolUseId = Array.isArray(toolUseIds)
        ? toolUseIds.find((id): id is string => typeof id === 'string' && id.length > 0)
        : undefined;
      return upsertToolResultMessage(
        state,
        event.persistId,
        typeof event.resolvedContent === 'string' ? event.resolvedContent : '',
        primaryToolUseId,
      );
    }

    case 'tool_result_full': {
      // F1-a Option C: 解析(覆盖更新 / eager-create / buffer)+ 落库都在 main
      // (onToolResultFullEvent)。renderer 纯展示:main 返回 persistId 才有显示变更
      // (整体替换内容 / 新建);buffer 或内容未变 → main 不下发 persistId → no-op。
      if (!event.persistId) return state;
      const { toolUseId } = event.data as { toolUseId?: unknown };
      return upsertToolResultMessage(
        state,
        event.persistId,
        typeof event.resolvedContent === 'string' ? event.resolvedContent : '',
        typeof toolUseId === 'string' ? toolUseId : undefined,
      );
    }

    case 'done': {
      // silent-stop:上游空内容消息静默收尾,main 守卫 1.5s 后会自动续跑(或弹耗尽横幅)。
      // 保持 isRunning=true,避免 renderer 的 500ms 完成去抖触发假完成通知。守卫非续跑
      // 决策通过 exhausted terminal error 广播到达 renderer,那时才正确设 isRunning=false。
      if ((event.data as { silentStop?: boolean } | null | undefined)?.silentStop === true) {
        return state;
      }
      if (isTurnContinuationBoundaryEvent(event)) {
        // A claimed done seals one SDK turn, while its provider-owned
        // continuation keeps the product turn alive. Finalize only the
        // current assistant segment and preserve all product-level state.
        const finalized = finalizeStreamingInState(state);
        return {
          ...finalized,
          streamingText: '',
          isStreaming: true,
          lastAgentMeta: incomingMeta ?? state.lastAgentMeta,
          agentStatus: {
            ...state.agentStatus,
            isRunning: true,
            startedAt: state.agentStatus.startedAt ?? Date.now(),
          },
        };
      }
      // F1-a: assistant 文本落库已收口 main(messagePersistBroadcaster 在 done 边界
      // flushAssistantBlock),renderer 这里只做 UI 收尾(finalize 在飞气泡)。
      const finalized = finalizeStreamingInState(state);

      // Side-effect (titleUpdateCallbacks) is fired by the stream handler in
      // `initGlobalListeners`, not from inside this reducer — reducers stay pure.

      // F7.6 / FP-3: Mark any pending ask_user + plan_review messages as expired on session done.
      // image-local-cache: MEM-3 removed — `images` is now an ImageRef[]
      // (xdt-image:// URLs), not base64 buffers. There is nothing heavy to
      // strip; the URLs must persist so the message keeps rendering.
      //
      // 计划模式(issue #475)例外:Codex 的 plan_review 是 **turn 间**交互 —— agent 在
      // turn/completed 之后才 dispatch 审批,且交互经 resolver 直通通道先于队列里的
      // done 事件到达 renderer,done 清扫会把刚弹出的计划卡片瞬间标过期(一闪即逝 bug)。
      // Claude 的 plan_review 发生在 turn 内(ExitPlanMode 阻塞中),done 必然晚于决策,
      // 清扫语义不变。真正的放弃路径(abort/close)由 main 的 interaction dismissal
      // (permission_dismissed 事件)负责标 expired,不依赖这里。
      const keepPlanReviewAcrossDone = state.agentKind === 'codex';
      const cleanedMessages = finalized.messages.map((m) => {
        let next = m;
        if (m.isStreaming) next = { ...next, isStreaming: false };
        if (m.role === 'ask_user' && m.askUserStatus === 'pending') {
          next = { ...next, askUserStatus: 'expired' as const };
        }
        if (
          !keepPlanReviewAcrossDone &&
          m.role === 'plan_review' &&
          m.planReviewStatus === 'pending'
        ) {
          next = { ...next, planReviewStatus: 'expired' as const };
        }
        return next;
      });

      const terminalData = event.data as
        { cancelled?: unknown; plan?: unknown; raw?: { id?: unknown; status?: unknown } }
        | null
        | undefined;
      const terminalTurnId = typeof terminalData?.raw?.id === 'string' ? terminalData.raw.id : null;
      const terminalTurnStatus =
        typeof terminalData?.raw?.status === 'string' ? terminalData.raw.status : null;
      const doneMessages =
        event.source === 'codex'
          ? applyCodexPlanSnapshotOnDone(
              cleanedMessages,
              terminalData?.plan,
              terminalTurnId,
              terminalTurnStatus,
              Date.now(),
              terminalData?.cancelled === true,
            ).messages
          : cleanedMessages;

      // F1-a Option C: tool-result-image 孤儿 flush(turn 末残留 pendingFullText)已收口
      // main(messagePersistBroadcaster.flushOrphanToolResults),落库后经 onCreated append
      // 到 renderer。renderer done 不再自建 orphan、不再持有 toolUseId/pendingFullText 任何
      // Map(单一真相源在 main)。

      return {
        ...finalized,
        messages: [...doneMessages],
        streamingText: '',
        isStreaming: false,
        recoverableError: null,
        activeTurnRetryText: null,
        errorRetryText: finalized.error ? finalized.errorRetryText : null,
        pendingPermission: null,
        pendingAskUser: null,
        continuationTurnClientId: null,
        // F-AUQ-MIN-5: viewerState lives with pendingAskUser — when the
        // pending question is gone, reset so the next one starts expanded.
        askUserViewerState: 'expanded',
        // F-AUQ-DRAFT: pending question gone → in-progress wizard draft is
        // meaningless, drop it so the next question starts clean.
        askUserDraft: null,
        pendingPlanReview: keepPlanReviewAcrossDone ? state.pendingPlanReview : null,
        pendingIssueConfirm: null,
        pendingRenameSessionsConfirm: null,
        pendingGhostGrantConfirm: null,
        // agent-meta: turn 结束清空，下一 turn 重新累积。
        lastAgentMeta: null,
        queueAbortPending: false,
        agentStatus: {
          ...state.agentStatus,
          isRunning: false,
          startedAt: null,
        },
      };
    }

    case 'error': {
      const {
        message: errMsgRaw,
        reason,
        errorStatus,
      } = event.data as {
        message: string;
        reason?: string;
        errorStatus?: number | null;
      };
      const safeErrMsgRaw = redactSensitiveText(errMsgRaw);
      const safeErrMsg =
        typeof errorStatus === 'number' &&
        Number.isInteger(errorStatus) &&
        errorStatus >= 100 &&
        errorStatus <= 599 &&
        !new RegExp(`\\b${errorStatus}\\b`).test(safeErrMsgRaw)
          ? `${safeErrMsgRaw} (HTTP ${errorStatus})`
          : safeErrMsgRaw;
      // 空响应/无详情失败 banner 文案走 i18n(四语言),不直接渲染 maker-core 发来的
      // 中文 message(规则 18:UI 文案必须 i18n)。maker-core 用稳定 reason 当 key
      // ('empty-response' / 'turn-failed'), message 仅作非 renderer 消费方(IM/orca)的兜底。
      const errMsg =
        reason === 'empty-response'
          ? i18n.t('logic.errors.emptyResponse')
          : reason === 'turn-failed'
            ? i18n.t('logic.errors.turnFailed')
            : reason === 'silent-stop-exhausted'
              ? i18n.t('logic.errors.silentStopExhausted')
              : reason === 'codex-auto-review-unavailable'
                ? i18n.t('logic.errors.codexAutoReviewUnavailable')
                : decodeRemoteErrorMessage(safeErrMsg);
      const isTerminalError = isTerminalErrorData(event.data);
      if (!isTerminalError) {
        // Codex app-server 的有限重连进度是进行态，不是用户需要处理的错误。
        // 复用 Cindy 自动接管活动行的视觉通道，固定 clientId 原地更新 N/M；
        // host 接管成功后 projection 会先撤掉这条原生行并交棒给自己的 pending 行。
        if (isCodexReconnectProgress) {
          const hasAutoResumePendingCard = state.messages.some(
            (message) => message.clientId === AUTO_RESUME_PENDING_CLIENT_ID,
          );
          // 终态错误之后跨 channel 到达的迟到 Reconnecting 不能复活运行态。
          // 正常首个重连事件没有 error/retry token,仍按进行中的 turn 点亮 spinner；
          // 已有 Cindy 接管卡时则保留当前 running 快照，交给 projection 的权威状态。
          const terminalized = state.error !== null || state.errorRetryText !== null;
          if (terminalized && !hasAutoResumePendingCard) {
            return {
              ...state,
              messages: removeCodexReconnectPendingCard(state.messages),
            };
          }
          return {
            ...state,
            messages: hasAutoResumePendingCard
              ? state.messages
              : upsertCodexReconnectPendingCard(state.messages, {
                  attempt: reconnectAttempt.attempt,
                  maxAttempts: reconnectAttempt.maxAttempts,
                }),
            error: null,
            usageLimitRecovery: null,
            errorReason: null,
            recoverableError: null,
            errorRetryText: null,
            isStreaming: hasAutoResumePendingCard ? state.isStreaming : true,
            agentStatus: {
              ...(hasAutoResumePendingCard
                ? state.agentStatus
                : {
                    ...state.agentStatus,
                    isRunning: true,
                    startedAt: state.agentStatus.startedAt ?? Date.now(),
                  }),
            },
          };
        }
        return {
          ...state,
          error: null,
          usageLimitRecovery: null,
          // 非终止 error 此前恒清 reason(那时没有任何非终止 error 带 reason)。过载
          // 重投是第一个需要它的: renderer 靠 reason 判定"是否过载"来渲染本地化的
          // 重试进度, 而重投恰恰只在**非终止**态发生 —— 清掉就等于 UI 侧只能回退
          // 文案匹配。其它非终止 error 仍不带 reason, 行为不变。
          errorReason: reason ?? null,
          recoverableError: errMsg,
          errorRetryText: null,
          isStreaming: true,
          agentStatus: {
            ...state.agentStatus,
            isRunning: true,
            startedAt: state.agentStatus.startedAt ?? Date.now(),
          },
        };
      }
      const finalized = finalizeStreamingInState(state);
      const derivedRetryText = deriveErrorRetryText(finalized);
      const suppressAutoResumeBroadcastError =
        event.source === 'codex' &&
        !isCodexUserActionableRetryError(event.data) &&
        hasMatchingAutoResumePendingError(finalized.messages, event.data);
      // main coordinator 在终止型 error 时**先**同步 emit projection(errorRetryText
      // = projectionRetryText 的权威 retry token,active-turn 恢复恒非空)再 broadcast
      // 本事件,所以此刻 finalized.errorRetryText 可能已经持有 main 的 token。本地推导
      // 只覆盖 renderer 直发的 turn(activeTurnRetryText 仅由 markDispatchStarted 写入);
      // main drain 派发的 turn(排队消息、纯附件/语音等)推导恒为 null,若在此把 token
      // 盖掉,ErrorBanner 的 Retry 按钮会消失、只剩关闭(2026-07-13 "Request timed out"
      // 只有取消按钮实锤)。无条件保留,不做队首匹配校验:active-turn 恢复的 token
      // 本就不指向队首,而 errorRetryText 在 turn start / dispatch / clearError 时
      // 都会清空,能留到这里的非空值只可能属于本次错误。
      const preservedRetryText = finalized.errorRetryText || null;
      // Suppress spurious "remote daemon closed" banner during user-initiated
      // cc-mgr upgrade — force-upgrade IPC kills the daemon → U2 fallback pushes
      // an error event with reason='remote_daemon_closed'. Expected, not a real
      // failure. Daemon dying outside upgrade still surfaces a normal banner.
      const isPlannedUpgradeClose =
        reason === 'remote_daemon_closed' && isSessionUpgrading(event.sessionId);
      // 没有 done 的 codex 终态 error:该 turn 的计划行等不到章,也等不到
      // persistCodexPlanOnDone 的 turnCompleted:false。立即在内存里补失败印记
      // (main 的 persistCodexPlanOnTerminalError 落库版本随行广播稍后到达),
      // 否则钉住面板会把全勾完的失败计划当旧数据兜底退场。
      const terminalErrorMessages =
        event.source === 'codex'
          ? markCodexPlanTurnFailed(finalized.messages).messages
          : finalized.messages;
      return {
        ...finalized,
        messages: suppressAutoResumeBroadcastError
          ? [...terminalErrorMessages]
          : terminalErrorMessages.filter(
              (message) => message.clientId !== AUTO_RESUME_PENDING_CLIENT_ID,
            ),
        // coordinator 已经先发 autoResumePending projection 时，终态 maker:event
        // 只是同一次失败的广播回声，不能把接管态重新点成红色横幅。若接管失败，
        // projection 会先撤掉 pending 行并带 error 到达，此处仍正常落红。
        error: isPlannedUpgradeClose || suppressAutoResumeBroadcastError ? null : errMsg,
        usageLimitRecovery:
          isPlannedUpgradeClose || suppressAutoResumeBroadcastError
            ? null
            : extractUsageLimitRecoveryHint(event.data),
        errorReason:
          isPlannedUpgradeClose || suppressAutoResumeBroadcastError ? null : (reason ?? null),
        recoverableError: null,
        errorRetryText: derivedRetryText ?? preservedRetryText,
        isStreaming: false,
        activeTurnRetryText: null,
        continuationTurnClientId: null,
        queueAbortPending: false,
        streamingText: '', // MEM-4: finalizeStreamingInState intentionally keeps streamingText for
        // the 'done' path to consume — reset it explicitly on error so the
        // accumulated delta text doesn't linger in memory.
        pendingPermission: null,
        pendingAskUser: null,
        // F-AUQ-MIN-5: same reset as the 'done' path.
        askUserViewerState: 'expanded',
        // F-AUQ-DRAFT: same reset as the 'done' path.
        askUserDraft: null,
        pendingPlanReview: null,
        pendingIssueConfirm: null,
        pendingRenameSessionsConfirm: null,
        pendingGhostGrantConfirm: null,
        // agent-meta: turn 异常结束也清空。
        lastAgentMeta: null,
        // 出错也是 turn 终结：清掉 isRunning，否则 RunningStatusBar 会一直停在
        // 初始 "Let's go" 文案上 shimmer 闪个不停（done 路径有同样的复位）。
        agentStatus: {
          ...state.agentStatus,
          isRunning: false,
          startedAt: null,
        },
      };
    }

    case 'permission_request': {
      const data = event.data as {
        requestId: string;
        toolName: string;
        input: Record<string, unknown>;
        title?: string;
        displayName?: string;
        description?: string;
        suggestions?: unknown[];
      };
      return {
        ...state,
        pendingPermission: {
          requestId: data.requestId,
          toolName: data.toolName,
          input: data.input,
          title: data.title,
          displayName: data.displayName,
          description: data.description,
          suggestions: data.suggestions,
        },
      };
    }

    case 'permission_dismissed': {
      // Main process auto-resolved the in-flight permission request (e.g. user
      // switched permissionMode mid-prompt, permission timed out, or session
      // closed). Drop the matching pending prompt so the input is no longer
      // gated and the UI cannot keep showing a stale interaction.
      const data = event.data as { requestId: string; reason?: string; decision?: unknown };
      // reason==='resolved' 且带 decision:交互被某一端答了(本端乐观清 / 对端经此广播收敛)。
      // 据此把被点中的 ask/plan 卡片翻成「已回答」(与答题端、reload 后一致);其它 reason
      // (timeout / mode_changed / session_closed 等真·放弃)resolved 为 null,仍标 expired。
      const resolved =
        data.reason === 'resolved' && data.decision && typeof data.decision === 'object'
          ? (data.decision as Record<string, unknown>)
          : null;
      if (state.pendingPermission?.requestId === data.requestId) {
        return { ...state, pendingPermission: null };
      }
      if (state.pendingPluginSetup?.requestId === data.requestId) {
        const [nextSetup = null, ...remainingSetups] = state.pendingPluginSetupQueue;
        return {
          ...state,
          pendingPluginSetup: nextSetup,
          pendingPluginSetupQueue: remainingSetups,
          pluginSetupViewerState: 'expanded',
          pluginSetupCommandInFlight: null,
        };
      }
      const queuedSetupIndex = state.pendingPluginSetupQueue.findIndex(
        (setup) => setup.requestId === data.requestId,
      );
      if (queuedSetupIndex >= 0) {
        return {
          ...state,
          pendingPluginSetupQueue: state.pendingPluginSetupQueue.filter(
            (_, index) => index !== queuedSetupIndex,
          ),
        };
      }
      if (state.pendingIssueConfirm?.requestId === data.requestId) {
        // issue 确认卡被 main 兜底关闭(超时/会话清理),ephemeral 无落库,直接清。
        return { ...state, pendingIssueConfirm: null };
      }
      if (state.pendingRenameSessionsConfirm?.requestId === data.requestId) {
        // 批量改名确认卡被 main 兜底关闭(超时/会话清理),ephemeral 无落库,直接清。
        return { ...state, pendingRenameSessionsConfirm: null };
      }
      if (state.pendingGhostGrantConfirm?.requestId === data.requestId) {
        // ghost 过户确认卡被 main 兜底关闭(超时/会话清理),ephemeral 无落库,直接清。
        return { ...state, pendingGhostGrantConfirm: null };
      }
      if (state.pendingAskUser?.requestId === data.requestId) {
        // resolved + answers → 翻成 answered 并填答案(与答题端 answerUserQuestion 同款 reply / answers,
        // 卡片据此渲染 ✓ 选项);否则(真·放弃)标 expired。
        const answers = resolved?.answers as Record<string, string> | undefined;
        const askUserReply = answers ? formatAskUserReply(answers) : '';
        return {
          ...state,
          pendingAskUser: null,
          askUserViewerState: 'expanded',
          // F-AUQ-DRAFT: question dismissed → drop draft.
          askUserDraft: null,
          messages: state.messages.map((m) =>
            m.role === 'ask_user' &&
            m.askUserRequestId === data.requestId &&
            m.askUserStatus === 'pending'
              ? answers
                ? {
                    ...m,
                    askUserStatus: 'answered' as const,
                    askUserReply,
                    askUserAnswers: answers,
                  }
                : { ...m, askUserStatus: 'expired' as const }
              : m,
          ),
        };
      }
      if (state.pendingPlanReview?.requestId === data.requestId) {
        // resolved → approve=approved / reject=revised(+ feedback,与答题端 respondToPlanReview 一致);
        // 否则(真·放弃)标 expired。
        const behavior = resolved ? (resolved.behavior === 'allow' ? 'allow' : 'deny') : null;
        // dismissed 标记 = 「取消本次审阅」(deny 但不是修订反馈), 镜像成 cancelled 而非 revised。
        const resolvedDismissed = behavior === 'deny' && resolved?.dismissed === true;
        const planReviewFeedback =
          behavior === 'deny' && !resolvedDismissed && typeof resolved?.reason === 'string'
            ? resolved.reason
            : undefined;
        return {
          ...state,
          pendingPlanReview: null,
          planViewerState: 'expanded',
          lastExpandedPlanViewerState: 'expanded',
          messages: state.messages.map((m) =>
            m.role === 'plan_review' &&
            m.planReviewRequestId === data.requestId &&
            m.planReviewStatus === 'pending'
              ? behavior
                ? {
                    ...m,
                    planReviewStatus:
                      behavior === 'allow'
                        ? ('approved' as const)
                        : resolvedDismissed
                          ? ('cancelled' as const)
                          : ('revised' as const),
                    planReviewFeedback,
                  }
                : { ...m, planReviewStatus: 'expired' as const }
              : m,
          ),
        };
      }
      return state;
    }

    case 'ask_user_question': {
      const data = event.data as {
        requestId: string;
        questions: AskUserQuestionItem[];
      };
      // F1-a: ask_user 消息的落库(+ 在飞 assistant flush)已收口 main
      // (messagePersistBroadcaster.onInteractionMessage,在 setInteractionListener 里),
      // renderer 只做 UI:finalize 在飞气泡 + 用 main 下发的 persistId 建 ask_user 气泡
      // (onCreated 同 id dedup;answered 回写也命中这条 persistId 单行)。persistId 缺失
      // (异常)退回随机仅保渲染。
      const finalized = finalizeStreamingInState(state);
      const clientId = event.persistId ?? crypto.randomUUID();

      // Use first question text as display content
      const displayContent = data.questions.map((q) => q.question).join(' / ');

      // 去重:同 requestId 的 ask 气泡已存在(历史加载 / 快照重建 / live 与 onCreated 竞态)→
      // 就地翻回 pending,不 append。否则会出现重复气泡(真机实测的「多一条消息」)。
      const existingAskIdx = finalized.messages.findIndex(
        (m) => m.role === 'ask_user' && m.askUserRequestId === data.requestId,
      );
      const askMessages =
        existingAskIdx >= 0
          ? finalized.messages.map((m, i) =>
              i === existingAskIdx
                ? {
                    ...m,
                    content: displayContent,
                    isStreaming: false,
                    askUserStatus: 'pending' as const,
                    askUserReply: null,
                    askUserQuestions: data.questions,
                  }
                : m,
            )
          : [
              ...finalized.messages,
              {
                clientId,
                role: 'ask_user' as const,
                content: displayContent,
                isStreaming: false,
                askUserStatus: 'pending' as const,
                askUserRequestId: data.requestId,
                askUserReply: null,
                askUserQuestions: data.questions,
                createdAt: new Date().toISOString(),
              },
            ];

      return {
        ...finalized,
        pendingAskUser: {
          requestId: data.requestId,
          questions: data.questions,
        },
        // F-AUQ-MIN-1: Every new pendingAskUser starts expanded — even if the
        // previous question in this same session was minimized. Folding never
        // carries across questions.
        askUserViewerState: 'expanded',
        // F-AUQ-DRAFT: Same logic — a new question batch must never inherit a
        // stale draft, even if for some reason the previous draft happened to
        // share the same requestId. The component additionally guards via
        // `draft.requestId === pending.requestId` before hydrating.
        askUserDraft: null,
        messages: askMessages,
      };
    }

    case 'plan_review': {
      const data = event.data as {
        requestId: string;
        plan: string;
        planFilePath: string;
      };
      // Guard against malformed events (Minor #6): empty requestId or plan
      // would produce an un-resolvable pending review. Drop on the floor.
      if (!data.requestId || !data.plan) return state;
      // F1-a: plan_review 消息的落库(+ 在飞 assistant flush)已收口 main
      // (onInteractionMessage),renderer 只做 UI:finalize + 用 main 下发的 persistId 建
      // plan_review 气泡(onCreated dedup;answered/feedback 回写命中这条 persistId 单行)。
      const finalized = finalizeStreamingInState(state);
      const clientId = event.persistId ?? crypto.randomUUID();

      // 去重(同 ask_user):同 requestId 的 plan_review 气泡已存在 → 就地翻回 pending,不 append。
      const existingPlanIdx = finalized.messages.findIndex(
        (m) => m.role === 'plan_review' && m.planReviewRequestId === data.requestId,
      );
      const planMessages =
        existingPlanIdx >= 0
          ? finalized.messages.map((m, i) =>
              i === existingPlanIdx
                ? {
                    ...m,
                    isStreaming: false,
                    planReviewStatus: 'pending' as const,
                    planReviewPlan: data.plan,
                    planReviewFilePath: data.planFilePath,
                    planReviewFeedback: undefined,
                  }
                : m,
            )
          : [
              ...finalized.messages,
              {
                clientId,
                role: 'plan_review' as const,
                // content is a display-only string (mirrors ask_user's pattern).
                // The Markdown source of truth lives in planReviewPlan — keep
                // content empty so we don't accidentally drift from it.
                content: '',
                isStreaming: false,
                planReviewStatus: 'pending' as const,
                planReviewRequestId: data.requestId,
                planReviewPlan: data.plan,
                planReviewFilePath: data.planFilePath,
                createdAt: new Date().toISOString(),
              },
            ];

      return {
        ...finalized,
        pendingPlanReview: {
          requestId: data.requestId,
          plan: data.plan,
          planFilePath: data.planFilePath,
        },
        // Default to expanded + remember as the restore target for minimized
        planViewerState: 'expanded',
        lastExpandedPlanViewerState: 'expanded',
        messages: planMessages,
      };
    }

    case 'compact_boundary': {
      // F-COMPACT-1: SDK auto-compacted the conversation. Insert a local-only
      // divider message so the user understands why old context "vanished".
      // Not persisted — on session reload the SDK will replay history with
      // the boundary embedded in transcript-loaded messages, so we'd risk
      // double-rendering if we wrote this row to DB.
      const data = event.data as {
        boundaryId?: string;
        trigger: 'manual' | 'auto';
        preTokens: number;
        postTokens: number;
        durationMs: number;
      };
      const boundaryId =
        typeof data.boundaryId === 'string' && data.boundaryId ? data.boundaryId : undefined;
      const clientId = boundaryId ? `compact:${boundaryId}` : crypto.randomUUID();
      // History replay and the live stream can deliver the same SDK boundary.
      // Deduplicate before finalizing anything so a replay cannot end the new
      // work segment that started after the original boundary.
      if (boundaryId && state.messages.some((message) => message.clientId === clientId)) {
        return state;
      }
      const finalized = finalizeStreamingInState(state);
      return {
        ...finalized,
        messages: [
          ...finalized.messages,
          {
            clientId,
            role: 'assistant' as const,
            content: '',
            isStreaming: false,
            systemCardType: 'compact',
            systemCardData: data as unknown as Record<string, unknown>,
            createdAt: new Date().toISOString(),
          },
        ],
      };
    }

    default:
      return state;
  }
}

function finalizeStreamingInState(state: SessionChatState): SessionChatState {
  const id = state.streamingClientId;
  if (!id) return state;
  return {
    ...state,
    messages: state.messages.map((m) => (m.clientId === id ? { ...m, isStreaming: false } : m)),
    streamingClientId: null,
    // Keep streamingText until caller (e.g. 'done') has consumed it
  };
}

/**
 * Bug-B 兜底护栏:main 端 session 进入 status='closed' 时,renderer 强制清掉
 * isRunning / startedAt / streamingClientId 以及所有 isStreaming 标记,防止 UI
 * 永久卡 "Generating..."。
 *
 * 触发场景(一句话):**任何**让 main 端 session.close() 跑完 setStatus('closed')
 * 的路径 — 用户主动 close / rehydrate / disableOrca / Maker.shutdown / 未知隐藏
 * 路径 — 只要 `done` 事件因为时序 race 没在 close 之前送达 renderer, 之前
 * 的实现就会让 `agentStatus.isRunning=true` 永久留着。这条护栏不依赖 `done`,
 * 只依赖 status_changed: closed, 因此一定能把卡死的 UI 拉回来。
 *
 * 不动 messages 内容, 只翻状态 flag。pending interaction 一并标过期(session
 * 都关了, 这些回应永远不会再来, 留着就 ghost 锁 UI)。
 */
function forceFinalizeOnSessionClosed(state: SessionChatState): SessionChatState {
  // session closed = 事件流已断,running 后台任务全部收口(scope='all')。
  // 只算一次,guard 与下方 return 共用(finalizeStreamingInState 不动 taskUpdates)。
  const stoppedTasks = stopRunningAgentTasks(state.taskUpdates, 'all');
  // 已经不在跑 + 没有 pending 也没有 streaming → no-op, 不要无谓地新建对象触发订阅
  if (
    !state.agentStatus.isRunning &&
    !state.agentStatus.startedAt &&
    !state.streamingClientId &&
    !state.isStreaming &&
    !state.pendingPermission &&
    !state.pendingAskUser &&
    !state.pendingPluginSetup &&
    state.pendingPluginSetupQueue.length === 0 &&
    !state.pendingPlanReview &&
    !state.pendingIssueConfirm &&
    !state.pendingRenameSessionsConfirm &&
    !state.pendingGhostGrantConfirm &&
    !state.messages.some((m) => m.isStreaming) &&
    !state.queueAbortPending &&
    state.steeringQueueClientIds.length === 0 &&
    state.continuationTurnClientId === null &&
    !state.pendingTaskWake &&
    !state.messages.some(
      (message) =>
        message.clientId === CODEX_RECONNECT_PENDING_CLIENT_ID ||
        message.clientId === AUTO_RESUME_PENDING_CLIENT_ID,
    ) &&
    stoppedTasks === state.taskUpdates
  ) {
    return state;
  }
  const finalized = finalizeStreamingInState(state);
  // status=closed is also the cancellation signal for an in-flight steer that
  // lost the race with close/clear. If the late IPC reject is later classified
  // as NO_ACTIVE_TURN, the missing marker tells the catch path not to fallback
  // into a fresh normal turn.
  const steeringIds = new Set(finalized.steeringQueueClientIds);
  const cleared = removeResumePendingCards(
    finalized.messages.map((m) => {
      let next = m;
      if (m.isStreaming) next = { ...next, isStreaming: false };
      if (m.role === 'ask_user' && m.askUserStatus === 'pending') {
        next = { ...next, askUserStatus: 'expired' as const };
      }
      if (m.role === 'plan_review' && m.planReviewStatus === 'pending') {
        next = { ...next, planReviewStatus: 'expired' as const };
      }
      return next;
    }),
  ).filter((m) => !steeringIds.has(m.clientId));
  return {
    ...finalized,
    messages: cleared,
    streamingText: '',
    isStreaming: false,
    recoverableError: null,
    activeTurnRetryText: null,
    errorRetryText: null,
    pendingPermission: null,
    pendingAskUser: null,
    pendingPluginSetup: null,
    pendingPluginSetupQueue: [],
    pluginSetupViewerState: 'expanded',
    pluginSetupCommandInFlight: null,
    askUserViewerState: 'expanded',
    askUserDraft: null,
    pendingPlanReview: null,
    pendingIssueConfirm: null,
    pendingRenameSessionsConfirm: null,
    pendingGhostGrantConfirm: null,
    queueAbortPending: false,
    steeringQueueClientIds: [],
    continuationTurnClientId: null,
    // session 都关了,后台任务事件流已断:running 残留任务标 stopped、唤醒桥接
    // 清零,否则 running 快照(折算了后台任务)会让 spinner 永久转下去。
    taskUpdates: stoppedTasks,
    pendingTaskWake: false,
    agentStatus: {
      ...finalized.agentStatus,
      isRunning: false,
      startedAt: null,
    },
  };
}

function handleStatusUpdate(
  state: SessionChatState,
  update: CCAgentStatusUpdate,
): SessionChatState {
  if (isTurnContinuationBoundaryEvent(update) && update.isRunning === false) {
    // The paired status(false) is only an SDK segment boundary. Keep the
    // product turn running until its unclaimed terminal tail arrives.
    return state;
  }
  const startedAt = update.isRunning ? (state.agentStatus.startedAt ?? Date.now()) : null;

  // skipTurnReset: side-channel running 信号 (mivo MJ 按钮等不走 LLM 的后台任务)。
  // 只翻 isRunning + 接收新的 status 文案("Mivo …"), 不当 turn 起止处理 —
  // 不重置 tokenUsage / costUsd, 也不接受 update 里的 0 占位 token 值, 全部
  // 保留 state 现有值, 避免把上一轮真实的 cost / context 数字打回零。
  // sideTaskRunning 标记让 RunningStatusBar 把 token 计数行隐藏掉 (mivo 不
  // 消耗 token, 显示上一轮残留数字会误导用户)。
  if (update.skipTurnReset) {
    return {
      ...state,
      // side-task 结束标记: 见 lastStopWasSideTask 文档。启动时复位, 结束时置位。
      lastStopWasSideTask: update.isRunning ? state.lastStopWasSideTask : true,
      agentStatus: {
        ...state.agentStatus,
        status: update.status || state.agentStatus.status,
        isRunning: update.isRunning,
        startedAt,
        sideTaskRunning: update.isRunning,
      },
      isStreaming: update.isRunning
        ? true
        : !update.isRunning && state.isStreaming
          ? false
          : state.isStreaming,
    };
  }

  // Turn-complete updates (Done + !isRunning) carry authoritative values from
  // getContextUsage() when contextWindow is known. Interrupted compact can end
  // with a placeholder 0/0 snapshot; do not let that erase the last real value.
  const isTurnComplete = !update.isRunning && update.status === 'Done';
  // Detect new turn start: isRunning flips from false → true.
  const isTurnStart = update.isRunning && !state.agentStatus.isRunning;

  // On turn start, reset per-turn metrics to 0 so the status bar
  // doesn't briefly flash the previous turn's values.
  const tu = isTurnStart
    ? 0
    : isTurnComplete || (update.tokenUsage && update.tokenUsage > 0)
      ? update.tokenUsage
      : state.agentStatus.tokenUsage;
  const hasContextSnapshot =
    typeof update.contextWindow === 'number' &&
    update.contextWindow > 0 &&
    typeof update.contextTokens === 'number' &&
    update.contextTokens >= 0;
  const ct =
    (isTurnComplete && hasContextSnapshot) || (update.contextTokens && update.contextTokens > 0)
      ? update.contextTokens
      : state.agentStatus.contextTokens;
  const cw =
    (isTurnComplete && hasContextSnapshot) || (update.contextWindow && update.contextWindow > 0)
      ? update.contextWindow
      : state.agentStatus.contextWindow;
  const cu = isTurnStart
    ? 0
    : update.costUsd != null && update.costUsd > 0
      ? update.costUsd
      : state.agentStatus.costUsd;

  // Context values are pushed by agentManager after each turn complete via getContextUsage().

  return {
    ...state,
    // 真实 turn 的起/止都把 side-task 标记复位(它只描述「最近一次 stop」)。
    lastStopWasSideTask: false,
    // 真实 turn 的任意 status 都终结唤醒桥接:wake turn 启动(message_start 发
    // isRunning:true)是正常路径;wake turn 秒挂(只来 error + Done)也在这里
    // 收口,防止桥接标记漏网永久撑住 running 快照。skipTurnReset 已提前 return。
    pendingTaskWake: false,
    agentStatus: {
      status: update.status,
      tokenUsage: tu,
      costUsd: cu,
      contextTokens: ct,
      contextWindow: cw,
      isRunning: update.isRunning,
      startedAt,
    },
    activeTurnRetryText: isTurnComplete ? null : state.activeTurnRetryText,
    continuationTurnClientId: update.isRunning ? state.continuationTurnClientId : null,
    // 新 turn 真正启动(isRunning false→true)时清掉上一轮残留的终态 error:
    // coordinator 路径的 send 经 projection error:null 清横幅,但 direct send
    // (scheduler / send-to-session / goal 等不走 coordinator 的路径)不发
    // projection —— 残留 error 会让 useSessionRunningStatus 在本轮
    // running→stopped 时经 hasSessionTerminalError fallback 读到旧值,把成功
    // 的后台 turn 误报成「执行失败」通知(bot review P2)。skipTurnReset 的
    // side-channel running 信号已在上方早退,不会误清。
    error: isTurnStart ? null : state.error,
    usageLimitRecovery: isTurnStart ? null : state.usageLimitRecovery,
    errorReason: isTurnStart ? null : state.errorReason,
    errorRetryText: isTurnStart || (isTurnComplete && !state.error) ? null : state.errorRetryText,
    recoverableError: isTurnComplete ? null : state.recoverableError,
    isStreaming: update.isRunning
      ? true
      : !update.isRunning && state.isStreaming
        ? false
        : state.isStreaming,
  };
}

// ---------------------------------------------------------------------------
// Global IPC listener — installed exactly once (F-PSI-4)
// ---------------------------------------------------------------------------

let globalListenersInitialized = false;

/**
 * Collected unsubscribe functions — populated by initGlobalListeners,
 * drained by __teardownGlobalListeners (tests / HMR).
 */
const ipcUnsubscribers: Array<() => void> = [];

const TEXT_DELTA_BATCH_INTERVAL_MS = 32;
// 多个后台 session 同时流式补文本时，单 tick 限流避免同步 store 提交挤占前台交互。
const TEXT_DELTA_MAX_SESSIONS_PER_FLUSH_TICK = 8;

type MakerEventPayload = {
  sessionId?: string;
  event?: {
    type: string;
    data: unknown;
    source?: 'claude-code' | 'codex' | 'pi';
    agentMeta?: Record<string, unknown>;
    turnContinuationId?: number;
  };
  persistId?: string;
  resolvedContent?: string;
} | null;

/** Metadata carried beside a live main → renderer or device-link push. */
type LiveIngressContext = {
  ownerStamp?: unknown;
  remoteDeviceId?: string;
  ownerStampPresent?: boolean;
};

function isCurrentLiveIngress(context?: LiveIngressContext): boolean {
  if (!context) return true;
  const hasStamp = context.ownerStampPresent ?? context.ownerStamp !== undefined;
  if (!context.remoteDeviceId) {
    // Older preload builds did not expose Electron's third IPC argument. Keep
    // their local event stream compatible; stamped frames are fail-closed.
    return !hasStamp || isDataOwnerPushStampCurrent(context.ownerStamp);
  }

  return isRemoteDataOwnerPushCurrent(context.remoteDeviceId, context.ownerStamp, hasStamp);
}

function isCurrentLocalLiveIngress(ownerStamp: unknown): boolean {
  return isCurrentLiveIngress({
    ownerStamp,
    ownerStampPresent: ownerStamp !== undefined,
  });
}

function sameLiveIngressScope(a: LiveIngressContext, b: LiveIngressContext): boolean {
  if (a.remoteDeviceId !== b.remoteDeviceId) return false;
  const aStamp = isDataOwnerPushStamp(a.ownerStamp) ? a.ownerStamp : null;
  const bStamp = isDataOwnerPushStamp(b.ownerStamp) ? b.ownerStamp : null;
  if (aStamp === null || bStamp === null) return aStamp === bStamp;
  return (
    aStamp.dataOwnerId === bStamp.dataOwnerId && aStamp.ownerGeneration === bStamp.ownerGeneration
  );
}

type PendingTextDeltaBatch = {
  text: string;
  dataOwner: DataOwnerGeneration;
  ingress: LiveIngressContext;
  source?: 'claude-code' | 'codex' | 'pi';
  persistId?: string;
  agentMeta?: Record<string, unknown>;
};

const pendingTextDeltaBatches = new Map<string, PendingTextDeltaBatch>();
let textDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

// ── 后台任务对账定时器(活动熄灭触发的 stale running 自愈)────────────────
// 触发沿:onSessionBackgroundActivityChanged 的 active:false(CC 子进程停止调
// 模型 —— 正是终态事件若丢失、stale running 开始显形的时刻)。延迟给正常终态
// 事件 / wake turn 落地留窗口,到点后拉一次快照走 seed+对账;每会话至多一个
// 待执行定时器(防抖),active:true 到达即取消。只在翻转沿触发,不轮询。
const BACKGROUND_TASK_RECONCILE_DELAY_MS = 3000;
const backgroundTaskReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelBackgroundTaskReconcile(sessionId: string): void {
  const timer = backgroundTaskReconcileTimers.get(sessionId);
  if (timer !== undefined) {
    clearTimeout(timer);
    backgroundTaskReconcileTimers.delete(sessionId);
  }
}

function scheduleBackgroundTaskReconcile(sessionId: string): void {
  cancelBackgroundTaskReconcile(sessionId);
  backgroundTaskReconcileTimers.set(
    sessionId,
    setTimeout(() => {
      backgroundTaskReconcileTimers.delete(sessionId);
      // 触发沿复查远程归属(粘滞版):调度沿已筛过,但 3s 窗口内会话可能被识别
      // 为远程(启动期 registry 迟到水合等)。误放行的代价是拿本机空快照把镜像
      // 里真实在跑的任务错误收口,必须再拦一次。
      if (isRemoteSessionSticky(sessionId)) return;
      // 候选集在发起请求前捕获(时序论证见 reconcileStaleRunningTasks);此刻
      // 已无 running 条目则无账可对,不发无谓 IPC。定时器只在 store 对象初始化
      // 之后才可能到点,前向引用 makerChatStore 安全。
      const staleRunningCandidates = makerChatStore.captureRunningClaudeTaskIds(sessionId);
      if (staleRunningCandidates.size === 0) return;
      const api = window.electronAPI?.maker;
      if (!api?.listSessionBackgroundTasks) return;
      void api
        .listSessionBackgroundTasks(sessionId)
        .then(({ tasks }) => {
          if (!Array.isArray(tasks)) return;
          // 响应落地前再复查一次:请求在飞期间远程注册表才完成会话水合的话,
          // 本机「查无此会话」的空表不可用于收口镜像任务。
          if (isRemoteSessionSticky(sessionId)) return;
          makerChatStore.seedBackgroundTaskSnapshots(sessionId, tasks, { staleRunningCandidates });
        })
        .catch(() => {
          // 静默:与其余快照拉取失败同口径(失败不对账,下次翻转沿 / 挂载重试)。
        });
    }, BACKGROUND_TASK_RECONCILE_DELAY_MS),
  );
}

/**
 * Defensive wrapper: contextBridge proxies may not preserve the return type.
 * Ensures we always get a callable unsubscribe function and pushes it onto
 * the teardown list.
 */
function bindIpc(
  subscribe: unknown,
  handler: (data: unknown, ownerStamp?: unknown) => void,
  label: string,
): void {
  if (typeof subscribe !== 'function') {
    log.warn(`${label}: subscribe is not available; teardown will no-op`);
    ipcUnsubscribers.push(() => {});
    return;
  }
  const result = (subscribe as (cb: (data: unknown, ownerStamp?: unknown) => void) => unknown)(
    handler,
  );
  if (typeof result === 'function') {
    ipcUnsubscribers.push(result as () => void);
  } else {
    log.warn(`${label}: unsubscribe not returned; teardown will no-op`);
    ipcUnsubscribers.push(() => {});
  }
}

function isTextDeltaEvent(event: NonNullable<MakerEventPayload>['event']): boolean {
  if (event?.type !== 'text') return false;
  const data = event.data as { text?: unknown; isFinal?: unknown } | null;
  return data?.isFinal === false && typeof data.text === 'string';
}

function isHighFrequencyStreamEvent(event: NonNullable<MakerEventPayload>['event']): boolean {
  return (
    !!event &&
    (event.type === 'tool_use' ||
      event.type === 'tool_result' ||
      event.type === 'tool_result_full' ||
      event.type === 'thinking')
  );
}

function dispatchStreamEventPayload(
  sessionId: string,
  event: NonNullable<MakerEventPayload>['event'],
  persistId?: string,
  resolvedContent?: string,
  deferNotification = false,
): void {
  if (!event) return;
  const streamEvent = {
    sessionId,
    type: event.type,
    data: event.data,
    source: event.source,
    agentMeta: event.agentMeta as import('./ccAgent.types').CcMeta | undefined,
    ...(event.turnContinuationId !== undefined
      ? { turnContinuationId: event.turnContinuationId }
      : {}),
    persistId,
    resolvedContent,
  } as CCAgentStreamEvent;
  supersedeInputProjectionOnTerminalEvent(sessionId, streamEvent);
  setState(sessionId, (s) => handleStreamEvent(s, streamEvent), { deferNotification });
}

function clearTextDeltaFlushTimer(): void {
  if (!textDeltaFlushTimer) return;
  clearTimeout(textDeltaFlushTimer);
  textDeltaFlushTimer = null;
}

function discardPendingTextDelta(sessionId: string): void {
  pendingTextDeltaBatches.delete(sessionId);
  if (pendingTextDeltaBatches.size === 0) clearTextDeltaFlushTimer();
}

function flushPendingTextDelta(sessionId: string, deferNotification = false): void {
  const pending = pendingTextDeltaBatches.get(sessionId);
  if (!pending) return;
  pendingTextDeltaBatches.delete(sessionId);
  if (pendingTextDeltaBatches.size === 0) clearTextDeltaFlushTimer();

  if (!isDataOwnerGenerationCurrent(pending.dataOwner) || !isCurrentLiveIngress(pending.ingress)) {
    return;
  }

  dispatchStreamEventPayload(
    sessionId,
    {
      type: 'text',
      source: pending.source,
      data: { text: pending.text, isFinal: false },
      ...(pending.agentMeta ? { agentMeta: pending.agentMeta } : {}),
    },
    pending.persistId,
    undefined,
    deferNotification,
  );
}

function flushAllPendingTextDeltas(): void {
  textDeltaFlushTimer = null;
  let flushedCount = 0;
  for (const sessionId of [...pendingTextDeltaBatches.keys()]) {
    flushPendingTextDelta(sessionId);
    flushedCount += 1;
    if (flushedCount >= TEXT_DELTA_MAX_SESSIONS_PER_FLUSH_TICK) break;
  }
  if (pendingTextDeltaBatches.size > 0) scheduleTextDeltaFlush();
}

function scheduleTextDeltaFlush(): void {
  if (textDeltaFlushTimer) return;
  textDeltaFlushTimer = setTimeout(flushAllPendingTextDeltas, TEXT_DELTA_BATCH_INTERVAL_MS);
}

function enqueueTextDeltaPayload(
  sessionId: string,
  event: NonNullable<MakerEventPayload>['event'],
  persistId?: string,
  ingress: LiveIngressContext = {},
): void {
  if (!event) return;
  const data = event.data as { text?: unknown };
  const text = typeof data.text === 'string' ? data.text : '';
  const dataOwner = getDataOwnerGeneration();
  let existing = pendingTextDeltaBatches.get(sessionId);
  if (
    existing &&
    (!isDataOwnerGenerationCurrent(existing.dataOwner) ||
      !sameLiveIngressScope(existing.ingress, ingress))
  ) {
    discardPendingTextDelta(sessionId);
    existing = undefined;
  }
  if (existing) {
    existing.text += text;
    if (!existing.persistId && persistId) existing.persistId = persistId;
    if (event.source) existing.source = event.source;
    if (event.agentMeta) existing.agentMeta = event.agentMeta;
  } else {
    pendingTextDeltaBatches.set(sessionId, {
      text,
      dataOwner,
      ingress,
      source: event.source,
      persistId,
      ...(event.agentMeta ? { agentMeta: event.agentMeta } : {}),
    });
  }
  scheduleTextDeltaFlush();
}

const PLUGIN_SETUP_STEP_PHASES = new Set<GhostSetupStepPhase>([
  'pending',
  'action_running',
  'waiting_external',
  'verifying',
  'satisfied',
  'failed',
  'cancelled',
]);

const PLUGIN_SETUP_ACTION_KINDS = new Set<GhostSetupActionKind>([
  'oauth_connect',
  'open_plugin_settings',
  'manage_connection',
  'open_client_settings',
]);

function parsePluginSetupInlineFormAction(
  rawAction: Record<string, unknown>,
): PluginSetupInlineFormAction | null {
  const rawForm = rawAction.form;
  if (!rawForm || typeof rawForm !== 'object' || Array.isArray(rawForm)) return null;
  const rawFields = (rawForm as Record<string, unknown>).fields;
  if (!Array.isArray(rawFields) || rawFields.length !== 1) return null;

  const rawField = rawFields[0];
  if (!rawField || typeof rawField !== 'object' || Array.isArray(rawField)) return null;
  const field = rawField as Record<string, unknown>;
  let externalLink: { url: string } | undefined;
  if (field.externalLink !== undefined) {
    if (
      !field.externalLink ||
      typeof field.externalLink !== 'object' ||
      Array.isArray(field.externalLink)
    ) {
      return null;
    }
    const rawLink = field.externalLink as Record<string, unknown>;
    if (
      Object.keys(rawLink).length !== 1 ||
      typeof rawLink.url !== 'string' ||
      rawLink.url.length === 0 ||
      rawLink.url.length > 200
    ) {
      return null;
    }
    try {
      const parsed = new URL(rawLink.url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    } catch {
      return null;
    }
    externalLink = { url: rawLink.url };
  }
  if (
    field.id !== 'value' ||
    field.type !== 'secret' ||
    typeof field.label !== 'string' ||
    field.label.length === 0 ||
    field.label.length > 120 ||
    (field.description !== undefined &&
      (typeof field.description !== 'string' || field.description.length > 500)) ||
    (field.placeholder !== undefined &&
      (typeof field.placeholder !== 'string' || field.placeholder.length > 120)) ||
    field.required !== true ||
    typeof field.maxLength !== 'number' ||
    !Number.isSafeInteger(field.maxLength) ||
    field.maxLength < 1 ||
    field.maxLength > GHOST_SECRET_VALUE_MAX_CHARS
  ) {
    return null;
  }

  return {
    id: rawAction.id as string,
    kind: 'inline_form',
    form: {
      fields: [
        {
          id: field.id,
          type: 'secret',
          label: field.label,
          ...(typeof field.description === 'string' ? { description: field.description } : {}),
          ...(typeof field.placeholder === 'string' ? { placeholder: field.placeholder } : {}),
          ...(externalLink ? { externalLink } : {}),
          required: true,
          maxLength: field.maxLength,
        },
      ],
    },
  };
}

/** Strict renderer boundary parser: unknown push data never reaches the card. */
export function parsePendingPluginSetup(request: {
  requestId?: unknown;
  revision?: unknown;
  terminal?: unknown;
  ghost?: unknown;
  intro?: unknown;
  steps?: unknown;
}): PendingPluginSetup | null {
  if (
    typeof request.requestId !== 'string' ||
    request.requestId.length === 0 ||
    request.requestId.length > 256 ||
    typeof request.revision !== 'number' ||
    !Number.isSafeInteger(request.revision) ||
    request.revision < 0 ||
    !request.ghost ||
    typeof request.ghost !== 'object' ||
    !Array.isArray(request.steps) ||
    request.steps.length === 0 ||
    request.steps.length > GHOST_SETUP_MAX_INTERACTION_STEPS ||
    (request.terminal !== undefined && request.terminal !== true) ||
    (request.intro !== undefined &&
      (typeof request.intro !== 'string' || request.intro.length > 500))
  ) {
    return null;
  }

  const ghost = request.ghost as Record<string, unknown>;
  if (
    typeof ghost.id !== 'string' ||
    ghost.id.length === 0 ||
    ghost.id.length > 256 ||
    typeof ghost.name !== 'string' ||
    ghost.name.length === 0 ||
    ghost.name.length > 256
  ) {
    return null;
  }

  const steps: PendingPluginSetup['steps'] = [];
  for (const rawStep of request.steps) {
    if (!rawStep || typeof rawStep !== 'object') return null;
    const step = rawStep as Record<string, unknown>;
    if (
      typeof step.id !== 'string' ||
      step.id.length === 0 ||
      step.id.length > 256 ||
      (step.groupId !== undefined &&
        (typeof step.groupId !== 'string' ||
          step.groupId.length === 0 ||
          step.groupId.length > 256)) ||
      (step.groupMode !== undefined && step.groupMode !== 'any_of') ||
      typeof step.title !== 'string' ||
      step.title.length === 0 ||
      step.title.length > 120 ||
      typeof step.description !== 'string' ||
      step.description.length > 500 ||
      typeof step.phase !== 'string' ||
      !PLUGIN_SETUP_STEP_PHASES.has(step.phase as GhostSetupStepPhase) ||
      (step.errorCode !== undefined && !isGhostSetupErrorCode(step.errorCode)) ||
      (step.errorMessage !== undefined &&
        (typeof step.errorMessage !== 'string' || step.errorMessage.length > 500))
    ) {
      return null;
    }

    let action: PluginSetupAction | undefined;
    if (step.action !== undefined) {
      if (!step.action || typeof step.action !== 'object') return null;
      const rawAction = step.action as Record<string, unknown>;
      if (
        typeof rawAction.id !== 'string' ||
        rawAction.id.length === 0 ||
        rawAction.id.length > 256 ||
        typeof rawAction.kind !== 'string'
      ) {
        return null;
      }
      if (rawAction.kind === 'inline_form') {
        const parsedInline = parsePluginSetupInlineFormAction(rawAction);
        if (!parsedInline) return null;
        action = parsedInline;
      } else {
        if (!PLUGIN_SETUP_ACTION_KINDS.has(rawAction.kind as GhostSetupActionKind)) return null;
        action = {
          id: rawAction.id,
          kind: rawAction.kind as Exclude<GhostSetupActionKind, 'inline_form'>,
        };
      }
    }

    steps.push({
      id: step.id,
      // Older controlled Desktops did not project group identity. Treat each
      // legacy step as its own group while preserving strict validation when
      // the new fields are present.
      groupId: typeof step.groupId === 'string' ? step.groupId : step.id,
      groupMode: 'any_of',
      title: step.title,
      description: step.description,
      phase: step.phase as GhostSetupStepPhase,
      ...(action ? { action } : {}),
      ...(isGhostSetupErrorCode(step.errorCode) ? { errorCode: step.errorCode } : {}),
      ...(typeof step.errorMessage === 'string' ? { errorMessage: step.errorMessage } : {}),
    });
  }

  const iconDataUrl =
    typeof ghost.iconDataUrl === 'string' &&
    ghost.iconDataUrl.length <= 512_000 &&
    ghost.iconDataUrl.startsWith('data:image/')
      ? ghost.iconDataUrl
      : undefined;
  return {
    requestId: request.requestId,
    revision: request.revision,
    ...(request.terminal === true ? { terminal: true as const } : {}),
    ghost: {
      id: ghost.id,
      name: ghost.name,
      ...(iconDataUrl ? { iconDataUrl } : {}),
    },
    ...(typeof request.intro === 'string' ? { intro: request.intro } : {}),
    steps,
  };
}

interface GlobalListenerOptions {
  /**
   * Only the primary renderer owns legacy remote-auth recovery. Auxiliary renderers still
   * consume the shared event stream, but must not read credentials, restart sessions, resend
   * messages, or persist a retry failure independently.
   */
  ownsRemoteAuthRetry?: boolean;
}

function initGlobalListeners(options: GlobalListenerOptions = {}): void {
  if (globalListenersInitialized) return; // idempotent for StrictMode / HMR
  globalListenersInitialized = true;
  const ownsRemoteAuthRetry = options.ownsRemoteAuthRetry !== false;

  // ── Maker 主事件流: 一根管子接所有 vendor → maker AgentEvent ──
  // 老链路是 8 个独立 IPC channel; 新链路一个 maker:event 通道,按 event.type 分发。
  // 数据 shape 由 maker-core/agents/claude-code/translator.ts 翻译, 形状对齐老 cc-agent 协议,
  // handleStreamEvent / handleStatusUpdate 不需改动。
  // device-link:同一个 handler 既接本机 maker:event,也接被控端经 onRemotePush
  // 转发回来的远程 maker:event(按 sessionId 命中同一 reducer,与来源无关)。
  const handleMakerEventRaw = (raw: unknown, ingress: LiveIngressContext = {}) => {
    if (!isCurrentLiveIngress(ingress)) return;
    const dataOwnerAtIngress = getDataOwnerGeneration();
    const payload = raw as MakerEventPayload;
    if (!payload?.sessionId || !payload.event) return;
    const { sessionId, event } = payload;
    const persistId = payload.persistId;
    const resolvedContent = payload.resolvedContent;

    if (isTextDeltaEvent(event)) {
      enqueueTextDeltaPayload(sessionId, event, persistId, ingress);
      return;
    }
    const deferNotification = isHighFrequencyStreamEvent(event);
    flushPendingTextDelta(sessionId, deferNotification);

    // session_id: 老链路是单独 IPC channel, 新链路融进 maker:event (Claude / Codex 同源)
    if (event.type === 'session_id') {
      const sdkSessionId = typeof event.data === 'string' ? event.data : undefined;
      if (!sdkSessionId) return;
      const current = getOrCreateState(sessionId);
      if (current.sdkSessionId === sdkSessionId) return;
      setState(sessionId, (s) => ({ ...s, sdkSessionId }));
      if (!isDataOwnerGenerationCurrent(dataOwnerAtIngress)) return;
      sessionService
        .update(sessionId, { sdkSessionId })
        .catch((err) => log.warn('Failed to persist sdkSessionId:', err));
      return;
    }

    // status: 形状对齐 CCAgentStatusUpdate, Claude / Codex 共享。
    // 持久化 (totalCostUsd / contextTokens / contextWindow → sessions 表) 已搬到 main 端的
    // sessionSpendBroadcaster, renderer 只更新 in-memory agentStatus, 不再 IPC 写库 (避免多 window 竞写)。
    if (event.type === 'status') {
      const update = {
        sessionId,
        ...(event.data as Record<string, unknown>),
        ...(event.turnContinuationId !== undefined
          ? { turnContinuationId: event.turnContinuationId }
          : {}),
      } as CCAgentStatusUpdate;
      if (!isTurnContinuationBoundaryEvent(event) && !update.skipTurnReset && !update.isRunning) {
        supersedeInputProjectionRequests(sessionId, { supersedeOperations: true });
      }
      setState(sessionId, (s) => handleStatusUpdate(s, update));
      return;
    }

    // 其他事件: 套成 CCAgentStreamEvent 交给 handleStreamEvent (text/thinking/tool_use/tool_result/...)
    // 协议归一化后 Claude 与 Codex 走同一条路径 — translator 各自把 SDK 事件翻成统一 AgentEvent
    // 形态, 此处不再按 source 分支。Codex 端 agentMeta 始终为 null (SDK 无 uuid 概念)。
    // Stage 2 C2: 透传 event.agentMeta — Claude translator handleAssistant 从 SDK uuid /
    // parent_tool_use_id / sdkSessionId / model / ... 提取并塞在 event 顶层, 这里把它转到
    // CCAgentStreamEvent.agentMeta 让 handleStreamEvent 落库 messages.agent_meta 行,
    // fork / rewind 反向找 prior assistant 锚点要靠这个字段。
    // Legacy CC/XD remote auth-retry: 在 reducer 写 error 之前拦截,避免 error banner 闪烁。
    if (event.type === 'error') {
      const errData =
        (event.data as { sdkError?: string; message?: string; errorStatus?: number }) ?? {};
      const isAuthError =
        errData.sdkError === 'authentication_failed' ||
        errData.errorStatus === 401 ||
        /authentication_error|invalid.*api.key|401/i.test(errData.message ?? '');
      const preSnap = getOrCreateState(sessionId);
      const authRetryCount = preSnap._authRetryCount ?? 0;
      if (
        ownsRemoteAuthRetry &&
        isAuthError &&
        preSnap.remoteHostId &&
        preSnap.agentKind === 'claude-code' &&
        !preSnap._authRetryInFlight &&
        authRetryCount < MAX_REMOTE_AUTH_RETRIES
      ) {
        const lastUser = [...preSnap.messages].reverse().find((m) => m.role === 'user');
        const lastUserClientId = lastUser?.clientId;
        // Per-message retry guard: same user message only auto-retried once.
        // Session-level count guard (_authRetryCount): hard cap on consecutive
        // retries — the per-message guard can't stop a chain because each retry
        // sends a fresh user message with a new clientId.
        if (lastUserClientId && preSnap._authRetryAttemptedClientId === lastUserClientId) {
          // Already retried this message — show error, don't loop.
        } else {
          setState(sessionId, (s) => ({
            ...s,
            _authRetryInFlight: true,
            _authRetryAttemptedClientId: lastUserClientId,
            _authRetryCount: (s._authRetryCount ?? 0) + 1,
          }));
          const retryText =
            lastUser && typeof lastUser.content === 'string' && lastUser.content.length > 0
              ? lastUser.content
              : null;
          const retryFiles = (lastUser as { retryFiles?: unknown[] } | undefined)?.retryFiles as
            Parameters<typeof sendMessage>[6] | undefined;
          const retryMentions = (lastUser as { retryMentions?: unknown[] } | undefined)
            ?.retryMentions as Parameters<typeof sendMessage>[7] | undefined;
          const hasRetryPayload = !!(
            retryText ||
            (retryFiles && retryFiles.length > 0) ||
            (retryMentions && retryMentions.length > 0)
          );
          void (async () => {
            try {
              if (!isDataOwnerGenerationCurrent(dataOwnerAtIngress)) return;
              // 本地 only:网关 key 不再有服务器副本可拉。改为校验本机 safeStorage 是否
              // 有 key —— 有则关闭并重发会话(重连时把本机 key 重新下发给 remote host);
              // 没有则中止重试,让 error banner 浮现,提示用户在本机重填 key。
              const localKey = await window.electronAPI.safeStorageRead(
                providerSecretStorageKey('xd'),
              );
              if (!isDataOwnerGenerationCurrent(dataOwnerAtIngress)) return;
              if (!localKey) {
                throw new Error('no local api key available');
              }
              // preserveWorkspace: 鉴权重连是瞬态 close+resend,会话继续,工作区必须保留。
              await makerApiFor(sessionId).closeSession(sessionId, { preserveWorkspace: true });
              await new Promise((r) => setTimeout(r, 1500));
              if (!isDataOwnerGenerationCurrent(dataOwnerAtIngress)) return;
              if (hasRetryPayload) {
                const row = await sessionService.get(sessionId);
                if (!isDataOwnerGenerationCurrent(dataOwnerAtIngress)) return;
                if (row.workingDir && row.model) {
                  const retryAccepted = await sendMessage(
                    sessionId,
                    retryText ?? '',
                    row.model,
                    row.effort ?? 'high',
                    row.permissionMode ?? 'default',
                    row.workingDir,
                    retryFiles,
                    retryMentions,
                    {
                      agentReferences: lastUser?.agentReferences,
                      pastedTextRanges: lastUser?.pastedTextRanges,
                      slashCommandRanges: lastUser?.slashCommandRanges,
                      authRetryPersistOnProjectionError: {
                        data: event.data as Record<string, unknown> | null,
                        agentMeta: event.agentMeta ?? null,
                      },
                    },
                  );
                  if (!retryAccepted) {
                    throw new Error('retry enqueue failed');
                  }
                } else {
                  throw new Error('session row missing workingDir/model');
                }
              } else {
                throw new Error('no retry payload');
              }
            } catch {
              if (!isDataOwnerGenerationCurrent(dataOwnerAtIngress)) return;
              // 重试失败——main 侧已跳过持久化（isRemoteAuthRetry），在此补落。
              // device-link 控制端经 makerApiFor 路由到被控端 main（不直调本地 IPC）;
              // 同时透传 agentMeta 供 flushAssistantBlock 边界 meta 兜底与 dedup key。
              void makerApiFor(sessionId).input.persistTurnErrorDeferred(
                sessionId,
                event.data as Record<string, unknown> | null,
                event.agentMeta ?? null,
              );
              const terminalErrorEvent = {
                sessionId,
                type: 'error',
                data: event.data,
              } as CCAgentStreamEvent;
              supersedeInputProjectionOnTerminalEvent(sessionId, terminalErrorEvent);
              setState(sessionId, (s) => handleStreamEvent(s, terminalErrorEvent));
            } finally {
              if (isDataOwnerGenerationCurrent(dataOwnerAtIngress)) {
                setState(sessionId, (s) => ({ ...s, _authRetryInFlight: false }));
              }
            }
          })();
          return;
        }
      }
      // guard fall-through（cap 超限 / 已重试同消息）：重试不会发生。
      // 仅 legacy CC/XD 在此补落：main 侧只对 CC remote auth error 跳过持久化
      // （isRemoteAuthRetryErrorEvent 对 codex 直接返回 false），由这里的 deferred
      // IPC 兜底。Codex remote auth error 在 main 侧走正常 onTurnErrorEvent 热路径
      // 落库；这里再落会双写——Codex 事件无 agentMeta，main 又在广播后 reset turn
      // 身份，两次落库的 dedup key 对不上，重开会话会出现重复错误卡。
      // 限制仅当 preSnap.remoteHostId 已加载时才触发：
      //   - 对于已加载的远程会话，能确认无 retry 在途，可安全落库。
      //   - 对于从未打开的后台会话（remoteHostId 为 null），无法判断另一个窗口
      //     是否正在 retry；贸然落库若 retry 成功会留下虚假错误卡，不落库则
      //     等价于旧行为（重启后错误丢失）—— 保守起见不做 deferred。
      if (
        ownsRemoteAuthRetry &&
        isAuthError &&
        preSnap.remoteHostId &&
        preSnap.agentKind === 'claude-code' &&
        !preSnap._authRetryInFlight
      ) {
        void makerApiFor(sessionId).input.persistTurnErrorDeferred(
          sessionId,
          event.data as Record<string, unknown> | null,
          event.agentMeta ?? null,
        );
      }
    }

    dispatchStreamEventPayload(sessionId, event, persistId, resolvedContent, deferNotification);

    // done / error 副作用 (从老 stream listener 搬过来)
    if (isProductTurnDoneEvent(event)) {
      if (
        event.source === 'codex' &&
        (event.data as { silentStop?: boolean } | null | undefined)?.silentStop !== true
      ) {
        // Codex 的 plan_review 跨 done 存活。done 会先作废旧快照，因此立即另起一代
        // Host 权威快照，补回 live push 丢失时的审批卡；fire-and-forget 不阻塞流 reducer。
        void reconcilePendingInteractions(sessionId).catch(() => undefined);
      }
      titleUpdateCallbacks.get(sessionId)?.();
      // A successful turn means auth recovered — reset the consecutive auth-retry
      // counter so a future 401 can auto-retry again.
      setState(sessionId, (s) =>
        s._authRetryCount || s._authRetryPersistOnProjectionError
          ? { ...s, _authRetryCount: 0, _authRetryPersistOnProjectionError: undefined }
          : s,
      );
      // MEM-OPT-1: trim non-active sessions after turn completes
      queueMicrotask(() => _trimMessagesIfNeeded(sessionId));
    }
    if (event.type === 'error') {
      const errData = (event.data as { message?: string; sdkError?: string }) ?? {};
      const errMsg = redactSensitiveText(errData.message ?? '');
      // sdkError 是 cc-code SDKAssistantMessageError tag (invalid_request /
      // authentication_failed / rate_limit / ...), claude-code translator 在
      // 透传 API-error envelope 时塞过来。message 现在是 SDK 写好的人话解释
      // (PROMPT_TOO_LONG / "Run /rewind to recover" 等),tag 留作分类 + 兜底匹配。
      const sdkError = errData.sdkError ?? null;
      // 落一条结构化日志,方便从 agent 流 (agent-*.ndjson) 反查"是哪条 user message + 哪个
      // session/model 触发了这次 banner 报错"。state 取的是 reducer 跑完之后的快照
      // (上面 setState 已经写入),所以 messages / lastAgentMeta 都是最新的。
      const snap = getOrCreateState(sessionId);
      const lastUser = [...snap.messages].reverse().find((m) => m.role === 'user');
      const lastUserText = lastUser
        ? typeof lastUser.content === 'string'
          ? lastUser.content
          : '<non-text>'
        : null;
      bannerErrLog.error(
        'SDK error surfaced to user',
        JSON.stringify({
          sessionId,
          sdkError,
          message: errMsg,
          sdkSessionId: snap.sdkSessionId ?? null,
          model: snap.lastAgentMeta?.model ?? null,
          lastUserText: lastUserText ? lastUserText.slice(0, 500) : null,
          lastUserTruncated: !!(lastUserText && lastUserText.length > 500),
        }),
      );
      // 本地 only:网关 key 不再有服务器副本,401 不再触发"从服务器重拉 key"。
      // 远程会话的 401 自动重连重试在上面的 reducer-前拦截分支处理(校验本机 key);
      // 本地会话则直接让 error banner 浮现,提示用户在设置里重填 key。
    }
  };
  bindIpc(
    window.electronAPI.maker.onEvent,
    (raw, ownerStamp) =>
      handleMakerEventRaw(raw, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'maker-event',
  );

  // ── Maker session status: 兜底护栏, 防 "Generating..." 永久卡死 ────────────
  // main 端 session.close() 跑完会 broadcast status_changed: closed; renderer
  // 之前只把它当实验页用的状态展示, **主聊天 store 没有任何 listener**。结果是
  // 一旦 close 跟 turn end 的 done 事件 race(done 没在 close 之前送达 renderer),
  // agentStatus.isRunning 就永远停在 true, UI "Generating..." 永久转圈。
  //
  // 触发 close 的路径很多(rehydrate / disableOrca / shutdown / 隐藏的 IPC 调用),
  // 真正的"凶手"还在用 [DEBUG-TEMP] 日志追。这条护栏不依赖修好 close 路径,
  // 只要 main 端把 closed 状态广播出来, 就保证 UI 一定能解锁。
  const handleMakerStatusRaw = (raw: unknown, ingress: LiveIngressContext = {}) => {
    if (!isCurrentLiveIngress(ingress)) return;
    const payload = raw as { sessionId?: string; status?: string } | null;
    if (!payload?.sessionId || payload.status !== 'closed') return;
    bumpInteractionReconcileEpoch(payload.sessionId);
    supersedeInputProjectionRequests(payload.sessionId, { supersedeOperations: true });
    flushPendingTextDelta(payload.sessionId);
    setState(payload.sessionId, forceFinalizeOnSessionClosed);
  };
  bindIpc(
    window.electronAPI.maker.onStatusChanged,
    (raw, ownerStamp) =>
      handleMakerStatusRaw(raw, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'maker-status-changed',
  );

  const handleInputProjectionRaw = (
    raw: unknown,
    sourceDeviceId?: string,
    ingress: LiveIngressContext = {},
  ) => {
    if (!isCurrentLiveIngress(ingress)) return;
    const projection = raw as AgentInputProjection | null;
    if (!projection?.sessionId) return;
    if (
      sourceDeviceId !== undefined &&
      remoteProjectsStore.getSessionDeviceId(projection.sessionId) !== sourceDeviceId
    ) {
      return;
    }
    applyInputProjection(projection);
  };
  bindIpc(
    window.electronAPI.maker.onInputProjection,
    (raw, ownerStamp) =>
      handleInputProjectionRaw(raw, undefined, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'maker-input-projection',
  );

  // ── Maker interaction request: permission/ask/plan 三合一,按 kind 分发 ──
  const handleInteractionRequestRaw = (raw: unknown, ingress: LiveIngressContext = {}) => {
    if (!isCurrentLiveIngress(ingress)) return;
    const payload = raw as {
      sessionId?: string;
      request?: { kind: string; requestId: string; [k: string]: unknown };
      persistId?: string;
    } | null;
    if (!payload?.sessionId || !payload.request) return;
    const { sessionId, request } = payload;
    const kind = request.kind;
    if (
      (kind !== 'permission' &&
        kind !== 'ask_user_question' &&
        kind !== 'plugin_setup' &&
        kind !== 'plan_review' &&
        kind !== 'issue_confirm' &&
        kind !== 'rename_sessions_confirm' &&
        kind !== 'ghost_grant_confirm') ||
      typeof request.requestId !== 'string' ||
      request.requestId.length === 0
    ) {
      return;
    }
    // 先过滤未知 kind，避免未来 interaction 只触发文本 flush 却没有对应 UI 边界处理。
    flushPendingTextDelta(sessionId);
    // F1-a Phase 5: ask_user / plan_review 消息由 main 落库并下发 persistId,renderer
    // 用它当气泡 clientId(permission 无此字段)。
    const persistId = payload.persistId;

    if (request.kind === 'permission') {
      const data: CCAgentPermissionRequestPayload = {
        sessionId,
        requestId: request.requestId,
        toolName: (request.toolName as string) ?? '',
        input: (request.input as Record<string, unknown>) ?? {},
        title: typeof request.title === 'string' ? request.title : undefined,
        displayName: typeof request.displayName === 'string' ? request.displayName : undefined,
        description: typeof request.description === 'string' ? request.description : undefined,
        suggestions: Array.isArray(request.suggestions) ? request.suggestions : undefined,
      };
      setState(sessionId, (s) =>
        handleStreamEvent(s, { sessionId, type: 'permission_request', data }),
      );
      return;
    }

    if (request.kind === 'ask_user_question') {
      const data: CCAgentAskUserQuestionPayload = {
        sessionId,
        requestId: request.requestId,
        questions: request.questions as CCAgentAskUserQuestionPayload['questions'],
      };
      setState(sessionId, (s) =>
        handleStreamEvent(s, { sessionId, type: 'ask_user_question', data, persistId }),
      );
      return;
    }

    if (request.kind === 'plugin_setup') {
      const parsed = parsePendingPluginSetup(request);
      if (!parsed) return;
      setState(sessionId, (s) => {
        const current = s.pendingPluginSetup;
        if (!current) {
          return {
            ...s,
            pendingPluginSetup: parsed,
            pluginSetupViewerState: 'expanded',
            pluginSetupCommandInFlight: null,
          };
        }
        if (current.requestId === parsed.requestId) {
          if (parsed.revision < current.revision) return s;
          const advanced = parsed.revision > current.revision;
          return {
            ...s,
            pendingPluginSetup: parsed,
            pluginSetupCommandInFlight: advanced ? null : s.pluginSetupCommandInFlight,
          };
        }

        const queuedIndex = s.pendingPluginSetupQueue.findIndex(
          (setup) => setup.requestId === parsed.requestId,
        );
        if (queuedIndex >= 0) {
          const queued = s.pendingPluginSetupQueue[queuedIndex];
          if (parsed.revision < queued.revision) return s;
          const nextQueue = s.pendingPluginSetupQueue.slice();
          nextQueue[queuedIndex] = parsed;
          return { ...s, pendingPluginSetupQueue: nextQueue };
        }

        return {
          ...s,
          pendingPluginSetupQueue: [...s.pendingPluginSetupQueue, parsed],
        };
      });
      return;
    }

    if (request.kind === 'plan_review') {
      const data: CCAgentPlanReviewPayload = {
        sessionId,
        requestId: request.requestId,
        plan: (request.plan as string) ?? '',
        planFilePath: (request.planFilePath as string) ?? '',
      };
      setState(sessionId, (s) =>
        handleStreamEvent(s, { sessionId, type: 'plan_review', data, persistId }),
      );
      return;
    }

    if (request.kind === 'issue_confirm') {
      // ephemeral 卡片(同 permission 语义,无 persistId 不落库),直接写 state,
      // 不走 handleStreamEvent —— 它不属于 agent 事件流。
      const draft = request.draft as PendingIssueConfirm['draft'] | undefined;
      // region 必须先 Omit 掉再重建成 unknown:交叉类型做不到这件事
      // (`CindyRegion & unknown` 仍是 `CindyRegion`),那样写会让 TS 以为 IPC 传来的
      // region 已经是合法值,下面的白名单校验看着像在校验、实际没有类型层面的约束。
      const rawEnv = request.env as
        (Omit<PendingIssueConfirm['env'], 'region'> & { region?: unknown }) | undefined;
      const submissionIdentity = parseIssueSubmissionIdentity(request.submissionIdentity);
      if (!draft || !rawEnv || !submissionIdentity) return;
      // 新版 Main:平台默认 + 可选 GitHub 身份。旧版 Main:只传已经固定的单一
      // 身份；若它固定为 GitHub，不能凭新版字段再虚构平台切换入口。
      const githubUserIdentity =
        submissionIdentity.kind === 'platform'
          ? parseOptionalGithubUserIdentity(request.githubUserIdentity)
          : undefined;
      const suggestedPublicName =
        submissionIdentity.kind === 'platform'
          ? parseIssueSuggestedPublicName(request.suggestedPublicName)
          : undefined;
      // region 过一遍白名单:非法值宁可不展示区域,也不能把 CN 版说成默认版。
      const env = { ...rawEnv, region: parseIssueEnvRegion(rawEnv.region) };
      setState(sessionId, (s) => ({
        ...s,
        pendingIssueConfirm: {
          requestId: request.requestId,
          draft,
          env,
          submissionIdentity,
          githubUserIdentity,
          suggestedPublicName,
        },
      }));
      return;
    }

    if (request.kind === 'rename_sessions_confirm') {
      // ephemeral 卡片(同 permission 语义,无 persistId 不落库),直接写 state。
      const rawChanges = Array.isArray(request.changes) ? request.changes : null;
      if (!rawChanges) return;
      const changes = rawChanges
        .map((item) => parseRenameSessionsConfirmItem(item))
        .filter((item): item is PendingRenameSessionsConfirm['changes'][number] => !!item);
      if (changes.length === 0) return;
      setState(sessionId, (s) => ({
        ...s,
        pendingRenameSessionsConfirm: { requestId: request.requestId, changes },
      }));
      return;
    }

    if (request.kind === 'ghost_grant_confirm') {
      // ephemeral 卡片(同 permission 语义,无 persistId 不落库),直接写 state。
      const parsed = parseGhostGrantConfirmRequest(request);
      if (!parsed) return;
      setState(sessionId, (s) => ({ ...s, pendingGhostGrantConfirm: parsed }));
      return;
    }
  };

  const handleLiveInteractionRequestRaw = (raw: unknown, ingress: LiveIngressContext = {}) => {
    if (!isCurrentLiveIngress(ingress)) return;
    const sessionId = (raw as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      bumpInteractionReconcileEpoch(sessionId);
    }
    handleInteractionRequestRaw(raw, ingress);
  };
  bindIpc(
    window.electronAPI.maker.onInteractionRequest,
    (raw, ownerStamp) =>
      handleLiveInteractionRequestRaw(raw, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'maker-interaction-request',
  );
  // 模块级桥接:供 reconcilePendingInteractions(打开/重连会话时的快照重建)复用同一套
  // 按 kind 分发逻辑。handler 只依赖模块级 setState/handleStreamEvent,无闭包局部状态,引用安全。
  applyInteractionRequestRef = handleInteractionRequestRaw;

  // ── Maker interaction dismissed: setPermissionMode 切换 / close 时关掉对话框 ──
  const handleInteractionDismissedRaw = (raw: unknown, ingress: LiveIngressContext = {}) => {
    if (!isCurrentLiveIngress(ingress)) return;
    const payload = raw as { sessionId?: string; requestId?: string; reason?: string } | null;
    if (!payload?.sessionId || !payload.requestId) return;
    // 老 CCAgentPermissionDismissedPayload 要 reason / resolvedAs union 字面值。
    // maker 端 reason 是字符串自由文本(如 'session_closed'/'mode_changed_to_xx'),
    // 落在 union 之外的就 cast 一下 —— renderer 只用它清 pending 状态, 不读 reason 字段。
    const dismissPayload = payload as {
      sessionId: string;
      requestId: string;
      reason?: string;
      resolvedAs?: 'allow' | 'deny';
      decision?: unknown;
    };
    // reason==='resolved' 时 main 会带上决策内容(ask 的 answers / plan 的 behavior+reason);
    // 透传给 permission_dismissed 处理,让被点中的 ask/plan 卡片翻成「已回答」而非 expired。
    const data = {
      sessionId: dismissPayload.sessionId,
      requestId: dismissPayload.requestId,
      reason: dismissPayload.reason ?? 'mode_changed_to_bypassPermissions',
      resolvedAs: dismissPayload.resolvedAs ?? 'deny',
      decision: dismissPayload.decision,
    };
    const sessionId = payload.sessionId;
    setState(sessionId, (s) =>
      handleStreamEvent(s, { sessionId, type: 'permission_dismissed', data }),
    );
  };
  const handleLiveInteractionDismissedRaw = (raw: unknown, ingress: LiveIngressContext = {}) => {
    if (!isCurrentLiveIngress(ingress)) return;
    const sessionId = (raw as { sessionId?: unknown } | null)?.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      bumpInteractionReconcileEpoch(sessionId);
    }
    handleInteractionDismissedRaw(raw, ingress);
  };
  bindIpc(
    window.electronAPI.maker.onInteractionDismissed,
    (raw, ownerStamp) =>
      handleLiveInteractionDismissedRaw(raw, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'maker-interaction-dismissed',
  );

  // Main 端写库的消息推送(接管路径 persistUserMessage / persistAssistantMessage),也复用给
  // device-link 远程会话(被控端 messages:created 经 onRemotePush 转发,注入同一套 in-memory state)。
  function handleMessageCreatedRaw(raw: unknown, ingress: LiveIngressContext = {}): void {
    if (!isCurrentLiveIngress(ingress)) return;
    const payload = raw as { sessionId?: string; message?: Message } | null;
    if (!payload?.sessionId || !payload.message) return;
    const { sessionId, message } = payload;
    if (isBeforeOrAtRendererClearBoundary(sessionId, message.createdAt)) return;
    const [mapped] = mapServerMessages([message]);
    if (!mapped) return;
    clearRemoteOptimisticSend(sessionId, mapped.clientId);
    const current = getOrCreateState(sessionId);
    const existing = current.messages.find((candidate) => candidate.clientId === mapped.clientId);
    const isLiveToolEcho =
      existing?.role === mapped.role &&
      (mapped.role === 'tool_use' || mapped.role === 'tool_result');
    // Stop 会乐观置 Idle，但真正的 interrupt 可能还在 IPC 队列里；此时旧 turn 继续喷出的
    // live tool + DB echo 仍必须走批通知，否则按钮一按下就退化回事故中的逐行 React fan-out。
    const deferNotification =
      current.agentStatus.isRunning || current.isStreaming || isLiveToolEcho;
    setState(
      sessionId,
      (s) => {
        const hydrateOptions = {
          preserveExistingToolResultContent: true,
          preserveExistingCodexPlanContent: true,
        } as const;
        const existingIdx = s.messages.findIndex((m) => m.clientId === mapped.clientId);
        const existing = existingIdx >= 0 ? s.messages[existingIdx] : undefined;
        const canHydrateInPlace =
          existing !== undefined &&
          existing.role === mapped.role &&
          (mapped.role === 'tool_use' || mapped.role === 'tool_result');
        if (canHydrateInPlace) {
          // live tool 事件先建行、DB onCreated 随后回声是事故现场的绝大多数路径。
          // 位置已经确定，直接原位 hydrate；旧实现仍调用 mergeMessages，导致每一条
          // 回声都对不断增长的整段消息重新遍历并排序，1,500+ 行时拖死 Renderer。
          // 仅限 tool 行：thinking 的 persisted createdAt 会回填块开始时间，必须让
          // mergeMessages 重排；assistant 等其它角色也保留原有权威时间线语义。
          const hydrated = hydratePersistedMessage(existing, mapped, hydrateOptions);
          if (hydrated === existing) return s;
          const nextMessages = s.messages.slice();
          nextMessages[existingIdx] = hydrated;
          return {
            ...s,
            messages: nextMessages,
            isFirstMessage: mapped.role === 'user' ? false : s.isFirstMessage,
          };
        }
        const nextMessages = mergeMessages([mapped], s.messages, hydrateOptions);
        const pendingQueue = s.pendingQueue.filter((item) => item.clientId !== mapped.clientId);
        if (nextMessages === s.messages && pendingQueue.length === s.pendingQueue.length) return s;
        return {
          ...s,
          messages: nextMessages,
          pendingQueue,
          isFirstMessage: mapped.role === 'user' ? false : s.isFirstMessage,
        };
      },
      { deferNotification },
    );
    // sidebar 排序时间轴 — 让接管路径下新消息也能 bump session 顺序。
    const updatedAt = new Date().toISOString();
    if (deferNotification) queueMessageCreatedPatch(sessionId, updatedAt);
    else emitPatch(sessionId, { updatedAt });
  }

  // 消息本地删除推送:本机多窗口与 device-link 控制端共用同一 reducer。
  // 新 payload 一次带齐整轮 clientIds；旧 host 仍回退到单个 clientId。
  function handleMessageDeletedRaw(raw: unknown, ingress: LiveIngressContext = {}): void {
    if (!isCurrentLiveIngress(ingress)) return;
    const payload = raw as {
      sessionId?: string;
      clientId?: string;
      clientIds?: unknown;
    } | null;
    if (!payload?.sessionId) return;
    const clientIds = Array.isArray(payload.clientIds)
      ? payload.clientIds.filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        )
      : typeof payload.clientId === 'string' && payload.clientId.length > 0
        ? [payload.clientId]
        : [];
    removeMessagesByClientIds(payload.sessionId, clientIds);
  }

  function handleUsageMessageTurnCostRaw(raw: unknown, ingress: LiveIngressContext = {}): void {
    if (!isCurrentLiveIngress(ingress)) return;
    const p = raw as {
      sessionId?: string;
      clientId?: string;
      turnMoney?: unknown;
      turnCostUsd?: number;
      turnCostIsEstimate?: boolean;
      userTurnMoney?: unknown;
      userTurnCostUsd?: number;
      userTurnCostIsEstimate?: boolean;
      turnUsageDetails?: unknown;
    } | null;
    if (!p?.sessionId || !p.clientId) return;
    const turnCostIsEstimate = p.turnCostIsEstimate === true;
    const turnUsageDetails = normalizeTurnUsageDetails(p.turnUsageDetails);
    const normalizedTurnMoney = normalizeRegionalMoney(p.turnMoney);
    const legacyTurnCostUsd =
      typeof p.turnCostUsd === 'number' && p.turnCostUsd > 0
        ? resolveEstimatedTurnCostUsd(p.turnCostUsd, turnCostIsEstimate, turnUsageDetails)
        : undefined;
    const turnMoney =
      normalizedTurnMoney ??
      (legacyTurnCostUsd !== undefined ? legacyUsdMoney(legacyTurnCostUsd) : undefined);
    const { sessionId, clientId } = p;
    // 用户轮累计与当前 segment 金额是**两个独立事实**,必须各自判定 —— 一次用户请求
    // 含多个 SDK segment 时,前面的 segment 有真实费用、收尾 segment 缺报价,payload
    // 就只有 userTurnMoney + turnUsageDetails。把累计金额的解析放在 turnMoney 分支
    // 之内,这一轮已经花掉的钱会被 token 顶掉(不变量正本见 shared/turnCostPayload.ts)。
    const userTurnMoney =
      normalizeRegionalMoney(p.userTurnMoney) ??
      (typeof p.userTurnCostUsd === 'number' && p.userTurnCostUsd > 0
        ? legacyUsdMoney(p.userTurnCostUsd)
        : undefined);
    const userTurnCostUsd =
      typeof p.userTurnCostUsd === 'number' && p.userTurnCostUsd > 0
        ? p.userTurnCostUsd
        : undefined;
    const userTurnCostPatch = userTurnMoney
      ? {
          userTurnMoney,
          ...(userTurnCostUsd ? { userTurnCostUsd } : {}),
          userTurnCostIsEstimate: p.userTurnCostIsEstimate === true,
        }
      : {};
    // 无当前 segment 金额 = main 的 recordTurnUsageOnMessage(算不出报价的轮次):
    // 更新明细 + 可能存在的整轮累计,让 action bar 优先显示已花的钱、否则退回 token。
    // 三者都没有才是真的无事可做。
    if (!turnMoney || !(turnMoney.amount > 0)) {
      if (!turnUsageDetails && !userTurnMoney) return;
      setState(sessionId, (s) => {
        const idx = s.messages.findIndex((m) => m.clientId === clientId);
        if (idx < 0) return s;
        const msgs = s.messages.slice();
        msgs[idx] = {
          ...msgs[idx],
          ...userTurnCostPatch,
          ...(turnUsageDetails ? { turnUsageDetails } : {}),
        };
        return { ...s, messages: msgs };
      });
      return;
    }
    const resolvedTurnCostUsd = turnMoney.currency === 'USD' ? turnMoney.amount : undefined;
    setState(sessionId, (s) => {
      const idx = s.messages.findIndex((m) => m.clientId === clientId);
      if (idx < 0) return s;
      const msgs = s.messages.slice();
      msgs[idx] = {
        ...msgs[idx],
        turnMoney,
        ...(resolvedTurnCostUsd !== undefined ? { turnCostUsd: resolvedTurnCostUsd } : {}),
        turnCostIsEstimate,
        ...userTurnCostPatch,
        ...(turnUsageDetails ? { turnUsageDetails } : {}),
      };
      return { ...s, messages: msgs };
    });
  }

  // 模型降级标记实时推送(main 的 modelMismatchBroadcaster,与 turn-cost 同款
  // 「落库 agent_meta + 广播」两路;历史加载路径由 buildChatMessages 兜底)。
  function handleUsageMessageModelMismatchRaw(
    raw: unknown,
    ingress: LiveIngressContext = {},
  ): void {
    if (!isCurrentLiveIngress(ingress)) return;
    const p = raw as {
      sessionId?: string;
      clientId?: string;
      modelMismatch?: { selected?: unknown; actual?: unknown } | null;
    } | null;
    if (!p?.sessionId || !p.clientId) return;
    const mm = p.modelMismatch;
    if (
      !mm ||
      typeof mm.selected !== 'string' ||
      !mm.selected ||
      typeof mm.actual !== 'string' ||
      !mm.actual
    )
      return;
    const { sessionId, clientId } = p;
    const modelMismatch = { selected: mm.selected, actual: mm.actual };
    setState(sessionId, (s) => {
      const idx = s.messages.findIndex((m) => m.clientId === clientId);
      if (idx < 0) return s;
      const msgs = s.messages.slice();
      msgs[idx] = { ...msgs[idx], modelMismatch };
      return { ...s, messages: msgs };
    });
  }

  // ── device-link:被控端转发回来的 renderer 广播事件,喂进上面同一套 handler ──
  // payload = { deviceId, channel, payload };按原 channel 路由到对应 handler,
  // 按 sessionId 命中既有 reducer —— 远程会话因此和本地会话共用一套流式 / 审批 / 消息渲染。
  // 控制端是纯镜像:被控端的 sessions / messages 读模型变更也由这里驱动 remoteProjectsStore,
  // 不做任何乐观预测(被控端 = 单一真相源)。
  bindIpc(
    // 可选调用兜底:测试 / HMR 先于 main 重启时 window.electronAPI.deviceLink 可能尚未注入,
    // 直接取 .onRemotePush 会让 initGlobalListeners 整体崩掉(与下方 onUsageMessageTurnCost 同款防御)。
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.deviceLink?.onRemotePush?.(cb),
    (raw, localOwnerStamp) => {
      if (!isCurrentLocalLiveIngress(localOwnerStamp)) return;
      const push = raw as {
        deviceId?: string;
        channel?: string;
        payload?: unknown;
        ownerStamp?: unknown;
      } | null;
      if (!push?.channel) return;
      const remoteIngress: LiveIngressContext = push.deviceId
        ? {
            remoteDeviceId: push.deviceId,
            ownerStamp: push.ownerStamp,
            ownerStampPresent: Object.prototype.hasOwnProperty.call(push, 'ownerStamp'),
          }
        : {};
      if (!isCurrentLiveIngress(remoteIngress)) return;
      const inboundPayload = push.payload as {
        sessionId?: string;
        patch?: Record<string, unknown>;
      } | null;
      const inboundSid = inboundPayload?.sessionId;
      const terminalPatch =
        push.channel === 'local-db:sessions:patched' &&
        push.deviceId !== undefined &&
        typeof inboundSid === 'string' &&
        (inboundPayload?.patch?.status === 'deleted' ||
          inboundPayload?.patch?.status === 'archived');
      // A terminal patch itself establishes the tombstone.  Every later frame
      // for that device/session is ignored until an authoritative active
      // snapshot proves an archived task was explicitly restored.
      if (terminalPatch) {
        markRemoteTerminalSessionTombstone(
          push.deviceId!,
          inboundSid!,
          inboundPayload?.patch?.status as 'deleted' | 'archived',
        );
      } else if (
        push.deviceId &&
        inboundSid &&
        isRemoteTerminalSessionTombstoned(inboundSid, push.deviceId)
      ) {
        if (
          push.channel === 'local-db:sessions:patched' &&
          inboundPayload?.patch?.status === 'active'
        ) {
          requestRemoteReseed(push.deviceId);
        }
        return;
      }
      // stall 看门狗信号:只用重会话流刷新 lastInboundEventAt。列表级轻量 activity/patch
      // 可能仍在持续抵达,但 maker:event 重 topic 已经断流;若这里也刷新会掩盖卡死。
      if (inboundSid && isRemoteHeavyInboundChannel(push.channel)) _markInboundEvent(inboundSid);
      switch (push.channel) {
        case 'maker:event':
          handleMakerEventRaw(push.payload, remoteIngress);
          break;
        case 'maker:status-changed':
          handleMakerStatusRaw(push.payload, remoteIngress);
          break;
        case 'maker:input:projection':
          if (!push.deviceId) break;
          handleInputProjectionRaw(push.payload, push.deviceId, remoteIngress);
          break;
        case 'maker:interaction-request':
          handleLiveInteractionRequestRaw(push.payload, remoteIngress);
          break;
        case 'maker:interaction-dismissed':
          handleLiveInteractionDismissedRaw(push.payload, remoteIngress);
          break;
        case 'local-db:messages:created':
          // 远程会话的持久化消息(接管路径)→ 注入 in-memory state(同本机)。
          handleMessageCreatedRaw(push.payload, remoteIngress);
          break;
        case 'local-db:messages:deleted':
          handleMessageDeletedRaw(push.payload, remoteIngress);
          break;
        case 'usage:message-turn-cost':
          handleUsageMessageTurnCostRaw(push.payload, remoteIngress);
          break;
        case 'usage:message-model-mismatch':
          handleUsageMessageModelMismatchRaw(push.payload, remoteIngress);
          break;
        case 'usage:session-spend-changed': {
          // 被控端 session 终身累计 cost 落库推送(sessionSpendBroadcaster 走裸 UPDATE、
          // 不发 sessions:patched)→ 镜像进远程项目分片;打开中的远程会话底部 $ chip 经
          // session.totalCostUsd → useSessionSpend 初值重置显示最新值。
          const p = push.payload as {
            sessionId?: string;
            totalMoney?: unknown;
            totalCostUsd?: number;
          } | null;
          const totalMoney =
            normalizeRegionalMoney(p?.totalMoney) ??
            (typeof p?.totalCostUsd === 'number' &&
            Number.isFinite(p.totalCostUsd) &&
            p.totalCostUsd >= 0
              ? legacyUsdMoney(p.totalCostUsd)
              : undefined);
          if (push.deviceId && p?.sessionId && totalMoney) {
            remoteProjectsStore.applyPatch(push.deviceId, p.sessionId, {
              totalMoney,
              ...(typeof p.totalCostUsd === 'number' ? { totalCostUsd: p.totalCostUsd } : {}),
            });
          }
          break;
        }
        case 'usage:session-tokens-changed': {
          // 同上:session 终身累计 token 镜像(chip tooltip 的 token 累计行)。
          const p = push.payload as { sessionId?: string; totalTokens?: number } | null;
          if (
            push.deviceId &&
            p?.sessionId &&
            typeof p.totalTokens === 'number' &&
            Number.isFinite(p.totalTokens) &&
            p.totalTokens >= 0
          ) {
            remoteProjectsStore.applyPatch(push.deviceId, p.sessionId, {
              totalTokenUsage: p.totalTokens,
            });
          }
          break;
        }
        case 'local-db:sessions:patched': {
          // 被控端会话元数据 / 设置变更 → 就地镜像到远程项目分片(取代乐观覆盖)。
          const p = push.payload as { sessionId?: string; patch?: Record<string, unknown> } | null;
          if (push.deviceId && p?.sessionId && p.patch) {
            const terminal = p.patch.status === 'deleted' || p.patch.status === 'archived';
            if (!terminal && isRemoteTerminalSessionTombstoned(p.sessionId, push.deviceId)) {
              if (p.patch.status === 'active') requestRemoteReseed(push.deviceId);
              break;
            }
            const ownsSession = getStickySessionDeviceId(p.sessionId) === push.deviceId;
            if (Object.prototype.hasOwnProperty.call(p.patch, 'clearedAt')) {
              observeRemoteInputClearBoundary(p.sessionId, p.patch.clearedAt);
            }
            remoteProjectsStore.applyPatch(push.deviceId, p.sessionId, p.patch);
            if (terminal && ownsSession) {
              // A background task can be deleted or archived from another
              // controller while this renderer still owns an offline outbox.
              // Retire it at the authoritative push boundary so reconnect
              // cannot dispatch into a task that no longer exists.
              removeRemoteSessionActivityEntry(p.sessionId);
              _purgeSession(p.sessionId);
              break;
            }
            // fast 开关读 chat in-memory,分片更新不灌它 → 这里把 fastMode 同步进来(以被控端为准)。
            mirrorSessionFields(p.sessionId, p.patch);
            // 会话在被控端被删除 / 归档 → 同步清掉活动镜像,避免孤儿状态点。
            if (terminal) {
              removeRemoteSessionActivityEntry(p.sessionId);
            }
          }
          break;
        }
        case 'local-db:sessions:activity': {
          // 被控端灵动岛 relay 的列表级实时活动(phase / attention)→ 控制端远程会话行
          // 右侧状态槽(error 红 / awaiting 蓝 / running spinner / 完成未读绿)。
          // 与手机端 applySessionActivity 同一套保留语义,详见 remoteSessionActivityStore。
          if (push.deviceId) applyRemoteSessionActivity(push.deviceId, push.payload);
          break;
        }
        case 'local-db:sessions:created':
          // 无 row 数据 → 重拉该设备会话列表(reconcile,非直接造壳)。
          if (push.deviceId) requestRemoteReseed(push.deviceId);
          break;
        case 'local-db:session:error-persisted': {
          // 被控端 terminal error 落库脏信号 → 让控制端已加载历史的远程会话同样失效,
          // 下次用户打开该会话时从被控端重拉,error 卡得以正常出现。
          // 当前正在被查看的会话:保留 live ErrorBanner 不干扰,但登记 pending,离开时再清。
          const ep = push.payload as { sessionId?: string } | null;
          if (ep?.sessionId) {
            const epState = sessions.get(ep.sessionId);
            if (epState) {
              if (_activeViewSessions.has(ep.sessionId)) {
                // Keep live banner; register pending so the error card appears on leave.
                // Mirrors the local onErrorPersisted path including the streaming case.
                _pendingErrorClearOnLeave.add(ep.sessionId);
              } else {
                setState(ep.sessionId, (s) => ({
                  ...s,
                  ...(s.historyLoaded ? { historyLoaded: false } : {}),
                  ...(s.error
                    ? { error: null, usageLimitRecovery: null, errorRetryText: null }
                    : {}),
                }));
              }
            }
          }
          break;
        }
        case 'maker:session-model-pref:changed': {
          // 旧被控端 / 旧控制端的 session-scoped pref 回流兼容:只更新当前控制端显示镜像,
          // 不碰本机 providerModelMemory、不回写被控端。新链路以 NEW_MAKER_DRAFT_CHANGED 的
          // providerModelMemory 全量镜像为权威。
          const p = push.payload as {
            sessionId?: string;
            agent?: AgentKind;
            providerId?: string;
            model?: string;
            effort?: string;
            fast?: boolean;
          } | null;
          if (p?.sessionId && p.agent && p.providerId && p.model) {
            const scopeKey = `session:${p.sessionId}`;
            if (p.effort !== undefined) {
              setMirrorEffort(scopeKey, p.agent, p.providerId, p.model, p.effort as Effort);
            }
            if (p.fast !== undefined) {
              setMirrorFast(scopeKey, p.agent, p.providerId, p.model, p.fast);
            }
          }
          break;
        }
        default:
          break;
      }
    },
    'device-link-remote-push',
  );

  // ── device-link:会话来源解析后重载历史 ──
  // remoteProjectsStore 注入 / 变更某会话的 deviceId(bootstrap / reseed / patch)时,
  // 把启动竞速里以 origin=undefined 误命中本机空库的已打开远程会话重载一次(经隧道拉真历史)。
  // 纯来源漂移驱动,正常 patched 推送(current===loaded)不误重载。teardown 时随其它监听一并清。
  {
    const unsub = remoteProjectsStore.subscribe(() => {
      // Snapshot/reseed can be the first clear signal (the projection or patch
      // may have been dropped). Reconcile boundaries before any subscriber or
      // outbox pump can observe the new shard.
      observeRemoteInputClearBoundariesFromSnapshot();
      releaseArchivedRemoteTerminalTombstones();
      reconcileOpenSessionOrigins();
      // A remote shard can be reseeded before the relay presence event reaches
      // this renderer. Treat that as a reconnect edge for the in-memory outbox.
      const remoteOutboxSessionIds = new Set([
        ...remoteOptimisticSends.keys(),
        ...remoteClearFences.keys(),
      ]);
      for (const sessionId of remoteOutboxSessionIds) {
        clearRemoteInputProjectionProbeFailure(sessionId);
        void retryRemoteClearFence(sessionId);
        void pumpRemoteOptimisticSends(sessionId);
      }
    });
    ipcUnsubscribers.push(typeof unsub === 'function' ? unsub : () => {});
  }

  // device-link exposes both the relay status and per-device presence. They
  // are optional in older test bridges / older preload snapshots, so a missing
  // callback must not prevent the rest of the maker listeners from installing.
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.deviceLink?.onStatusChanged?.(cb as never),
    (raw, ownerStamp) => {
      if (
        !isCurrentLiveIngress({
          ownerStamp,
          ownerStampPresent: ownerStamp !== undefined,
        })
      ) {
        return;
      }
      const status = (raw as { status?: string } | null)?.status;
      if (status !== 'online') return;
      const remoteOutboxSessionIds = new Set([
        ...remoteOptimisticSends.keys(),
        ...remoteClearFences.keys(),
      ]);
      for (const sessionId of remoteOutboxSessionIds) {
        clearRemoteInputProjectionProbeFailure(sessionId);
        void retryRemoteClearFence(sessionId);
        pumpRemoteOptimisticSendsAfterCurrent(sessionId);
      }
    },
    'device-link-status-changed-for-outbox',
  );
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.deviceLink?.onPresenceChanged?.(cb as never),
    (raw, ownerStamp) => {
      if (
        !isCurrentLiveIngress({
          ownerStamp,
          ownerStampPresent: ownerStamp !== undefined,
        })
      ) {
        return;
      }
      const presence = raw as { deviceId?: string; online?: boolean } | null;
      if (!presence?.deviceId) return;
      const wasOnline = remotePresenceOnlineByDevice.get(presence.deviceId);
      remotePresenceOnlineByDevice.set(presence.deviceId, presence.online === true);
      if (presence.online !== true) return;
      // Only a real offline -> online edge may indicate that the controlled
      // process restarted and reset its local owner generation. Busy/name/
      // settings presence updates also carry online=true; those must retain
      // the monotonic fence so a late older frame stays rejected.
      if (wasOnline !== true) resetRemoteDataOwnerPushFence(presence.deviceId);
      for (const [sessionId, records] of remoteOptimisticSends) {
        if ([...records.values()].some((record) => record.deviceId === presence.deviceId)) {
          clearRemoteInputProjectionProbeFailure(sessionId, presence.deviceId);
          pumpRemoteOptimisticSendsAfterCurrent(sessionId);
        }
      }
      for (const [sessionId, fence] of remoteClearFences) {
        if (fence.deviceId === presence.deviceId) void retryRemoteClearFence(sessionId);
      }
    },
    'device-link-presence-changed-for-outbox',
  );

  // ── Main 端写库的消息推送 (e.g. feishu /ctr 接管路径下 persistUserMessage /
  //   persistAssistantMessage) ──
  // renderer 自己发出的 user 消息已经乐观 push 过, 落库后这条 broadcast 也会到,
  //   按 clientId dedupe 避免重复显示。
  // 接管路径下 main 端写的 user/assistant 消息 renderer 没乐观 push,
  //   这里直接补进 messages 数组让 UI 立刻看到。
  bindIpc(
    window.electronAPI.localDb.messages.onCreated,
    (raw, ownerStamp) =>
      handleMessageCreatedRaw(raw, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'local-db-messages-created',
  );
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.localDb.messages.onDeleted?.(cb),
    (raw, ownerStamp) =>
      handleMessageDeletedRaw(raw, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'local-db-messages-deleted',
  );

  // ── terminal error 脏信号 ──
  // terminal error 行落库后 main 发此信号(不走 messages:created,避免 live 会话
  // ErrorBanner + ErrorMessageCard 双显示)。
  // 只对真后台(非 streaming、且未被 activeView 查看)的会话做两件事:
  //   1. historyLoaded=true → 置 false,下次用户打开时 ensureInitialMessages 重拉。
  //   2. store.error 存在(live ErrorBanner) → 清掉,让重拉后 ErrorMessageCard 独自出现。
  // 正在被查看的会话跳过:它们有 live ErrorBanner(含 Retry/Cancel),不应被脏信号干扰。
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.localDb.messages.onErrorPersisted?.(cb),
    (raw: unknown, ownerStamp?: unknown) => {
      if (
        !isCurrentLiveIngress({
          ownerStamp,
          ownerStampPresent: ownerStamp !== undefined,
        })
      ) {
        return;
      }
      const p = raw as { sessionId?: string } | null;
      if (!p?.sessionId) return;
      const state = sessions.get(p.sessionId);
      if (!state) return;
      if (_activeViewSessions.has(p.sessionId)) {
        // Keep live banner during active view (or when a follow-up turn is streaming
        // in the active view); invalidate + clear on leave so the ErrorMessageCard
        // appears the next time the user enters the session.
        _pendingErrorClearOnLeave.add(p.sessionId);
        return;
      }
      // Background session (not in active view), possibly streaming a follow-up turn.
      // ensureInitialMessages guards against mid-stream reload, so marking
      // historyLoaded=false here is safe; the error card will surface when the user
      // opens the session after the current turn finishes.
      setState(p.sessionId, (s) => ({
        ...s,
        ...(s.historyLoaded ? { historyLoaded: false } : {}),
        ...(s.error ? { error: null, usageLimitRecovery: null, errorRetryText: null } : {}),
      }));
    },
    'local-db-session-error-persisted',
  );

  // ── per-turn 费用推送 (turnCostBroadcaster) ──
  // main 在 turn 结束后把该轮费用 patch 进最后一条 assistant 的 agent_meta 并广播;
  // 这里按 clientId 找到消息补上字段(MessageActionBar 显示)。消息不在内存
  // (会话未打开 / 已被 rewind) → no-op,后开窗口走历史加载读 agent_meta 同源补齐。
  // 可选调用兜底:renderer HMR 先于 main 重启时老 preload 没有这个 fanOut,
  // 直接取值会让 initGlobalListeners 整体崩掉(费用推送丢了无妨,历史加载兜底)。
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.onUsageMessageTurnCost?.(cb),
    (raw, ownerStamp) =>
      handleUsageMessageTurnCostRaw(raw, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'usage-message-turn-cost',
  );
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.onUsageMessageModelMismatch?.(cb),
    (raw, ownerStamp) =>
      handleUsageMessageModelMismatchRaw(raw, {
        ownerStamp,
        ownerStampPresent: ownerStamp !== undefined,
      }),
    'usage-message-model-mismatch',
  );

  // ── 意识拦截(订阅槽①):用户消息被钩子拦下 ──
  // 有乐观气泡(空闲即发)→ 原地降级为被拦态;没有(会话忙,消息只以队列
  // 灰字存在,drain 到头才被拦)→ 用广播带回的原文补渲一条被拦气泡——
  // 两条路都保证用户看得见"这条被谁拦了",绝不无声蒸发。被拦消息本就没
  // 入库,离开会话即消失(UI 瞬态,预期语义)。
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.ghosts?.onUserMessageBlocked?.(cb),
    (raw: unknown, ownerStamp?: unknown) => {
      if (!isCurrentLocalLiveIngress(ownerStamp)) return;
      const p = raw as {
        sessionId?: string;
        clientId?: string;
        ghostId?: string;
        ghostName?: string;
        reason?: string;
        text?: string;
      } | null;
      if (!p?.sessionId || !p.clientId || !p.ghostId) return;
      const blocked = {
        ghostId: p.ghostId,
        ghostName: p.ghostName ?? p.ghostId,
        reason: p.reason ?? '',
      };
      setState(p.sessionId, (s) => {
        if (s.messages.some((m) => m.clientId === p.clientId)) {
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.clientId === p.clientId
                ? { ...m, blockedByGhost: blocked, isPendingPersist: false }
                : m,
            ),
          };
        }
        const appended: ChatMessage = {
          clientId: p.clientId!,
          role: 'user',
          content: p.text ?? '',
          isStreaming: false,
          createdAt: new Date().toISOString(),
          blockedByGhost: blocked,
        };
        return { ...s, messages: [...s.messages, appended] };
      });
    },
    'ghosts-user-message-blocked',
  );

  // ── 意识改写(订阅槽①):用户消息正文被钩子优化 ──
  // main 已用改写版落库 + 送 agent;这里把乐观气泡 content 静默换成改写版
  // (无标记,所见即送给 AI 的),保持气泡与 AI 实收一致。乐观气泡(空闲发)
  // 必在;会话忙时排队消息无乐观气泡,找不到就忽略——落库后 messages:created
  // 会用改写版 content 显示。
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.ghosts?.onUserMessageRewritten?.(cb),
    (raw: unknown, ownerStamp?: unknown) => {
      if (!isCurrentLocalLiveIngress(ownerStamp)) return;
      const p = raw as { sessionId?: string; clientId?: string; text?: string } | null;
      if (!p?.sessionId || !p.clientId || typeof p.text !== 'string') return;
      setState(p.sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.clientId === p.clientId ? { ...m, content: p.text! } : m,
        ),
      }));
    },
    'ghosts-user-message-rewritten',
  );

  // ── 出口钩子(will-assistant-message):AI 回复被润色改写 ──
  // main 已把改写版落库(updateMessageContent);这里把已显示的 assistant 气泡
  // content 静默换成改写版(与落库一致)。找不到该 clientId(极少:消息还没
  // hydrate)则忽略——messages:created/更新会带最终内容。
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.ghosts?.onAssistantMessageRewritten?.(cb),
    (raw: unknown, ownerStamp?: unknown) => {
      if (!isCurrentLocalLiveIngress(ownerStamp)) return;
      const p = raw as { sessionId?: string; clientId?: string; text?: string } | null;
      if (!p?.sessionId || !p.clientId || typeof p.text !== 'string') return;
      setState(p.sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.clientId === p.clientId ? { ...m, content: p.text!, ghostReplyPending: false } : m,
        ),
      }));
    },
    'ghosts-assistant-message-rewritten',
  );

  // ── 出口钩子(will-assistant-message):后台处理中/完成的轻指示 ──
  // 回复已显示、意识还在跑那段(最长 5 分钟)挂"意识处理中";完成(pending=false)
  // 或超时清掉。render(自绘卡)的呈现切换由 ghostCardStore 驱动(byCallId 命中
  // 本条 clientId),此处只管指示位。
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.ghosts?.onAssistantMessagePending?.(cb),
    (raw: unknown, ownerStamp?: unknown) => {
      if (!isCurrentLocalLiveIngress(ownerStamp)) return;
      const p = raw as { sessionId?: string; clientId?: string; pending?: boolean } | null;
      if (!p?.sessionId || !p.clientId || typeof p.pending !== 'boolean') return;
      setState(p.sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) =>
          m.clientId === p.clientId ? { ...m, ghostReplyPending: p.pending } : m,
        ),
      }));
    },
    'ghosts-assistant-message-pending',
  );

  // ── 意识钩子熔断(订阅槽①):连续失败降级只旁听,提示用户 ──
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.ghosts?.onHookFused?.(cb),
    (raw: unknown, ownerStamp?: unknown) => {
      if (!isCurrentLocalLiveIngress(ownerStamp)) return;
      const p = raw as { name?: string } | null;
      if (!p) return;
      toast.error(i18n.t('chat.ghostHook.fused', { name: p.name ?? '' }));
    },
    'ghosts-hook-fused',
  );

  // ── 意识系统提示(notify 槽 + 主机代言 notice):壳与身份头(图标+名字)
  // 主机画。两种来源同通道:意识自发的带 text(main 侧已资格审/净化/限速,
  // 原样作纯文本渲染);主机代言的带 textKey/textArgs(凭证入库、授权成功等
  // 主机权威事件)——文案跟用户语言走,按 GHOST_HOST_NOTICE_KEYS 白名单翻译,
  // 白名单外静默丢(防版本错配把生肉 key 摆上界面)。
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.ghosts?.onNotify?.(cb),
    (raw: unknown, ownerStamp?: unknown) => {
      if (!isCurrentLocalLiveIngress(ownerStamp)) return;
      const p = raw as {
        name?: string;
        iconDataUrl?: string;
        text?: string;
        textKey?: string;
        textArgs?: Record<string, string>;
        tone?: string;
      } | null;
      if (!p || typeof p.name !== 'string') return;
      let text: string | null = null;
      if (typeof p.text === 'string') {
        text = p.text;
      } else if (
        typeof p.textKey === 'string' &&
        (GHOST_HOST_NOTICE_KEYS as readonly string[]).includes(p.textKey)
      ) {
        text = i18n.t(`chat.ghostNotify.${p.textKey}`, p.textArgs ?? {});
      }
      if (!text) return;
      const tone =
        p.tone === 'success' || p.tone === 'warning' || p.tone === 'error' ? p.tone : 'info';
      toast[tone](text, {
        // 正文最长 200 字;时长按文案长度自适应——「连接成功:@xxx」这类短讯
        // 3s 足够,长文案给足 6s 读完(error 走库默认 8s);hover 会暂停消失
        ...(tone === 'error' ? {} : { duration: text.length <= 24 ? 3000 : 6000 }),
        source: { name: p.name, ...(p.iconDataUrl ? { iconDataUrl: p.iconDataUrl } : {}) },
      });
    },
    'ghosts-notify',
  );

  // ── 插件预览开页(preview 槽):main 已按身份卡白名单守门 + 限速 + 解析
  // 落点会话,这里只落地——右侧栏开 web-browser 标签,并弹带插件身份头的
  // 轻提示(用户明确知道"这个页面是谁开的",不是自己点出来的也不慌)。
  // 广播到达全部窗口,但只有主窗口处理:openUrlInSidebarBrowser 内部的
  // routeSidebarCommand 会按"贴附/抽离"把命令送到正确归宿;抽离的侧栏子窗口
  // 若也处理,同一条广播会开出两个标签。
  bindIpc(
    (cb: (data: unknown, ownerStamp?: unknown) => void) =>
      window.electronAPI.ghosts?.onPreviewOpen?.(cb),
    (raw: unknown, ownerStamp?: unknown) => {
      if (!isCurrentLocalLiveIngress(ownerStamp)) return;
      if (isSidebarWindow()) return;
      const p = raw as {
        name?: string;
        iconDataUrl?: string;
        sessionId?: string;
        url?: string;
      } | null;
      if (!p || typeof p.name !== 'string') return;
      if (typeof p.sessionId !== 'string' || typeof p.url !== 'string') return;
      // userInitiated:false —— 这是插件在后台干完活自己要求开的页,不是用户点的。
      // 标签照常落地、内容照常加载,但不得把侧边栏子窗口抢到前台打断用户
      // (detached 形态 + Windows 上 focus() 即抢前台)。
      void openUrlInSidebarBrowser(p.sessionId, p.url, { userInitiated: false }).catch(() => {
        /* 标签落地失败(会话桶异常等)不致命,静默 */
      });
      toast.info(i18n.t('chat.ghostPreview.opened'), {
        duration: 3000,
        source: { name: p.name, ...(p.iconDataUrl ? { iconDataUrl: p.iconDataUrl } : {}) },
      });
    },
    'ghosts-preview-open',
  );

  // ── 后台活动熄灭 → stale running 对账(终态事件丢失的自动自愈)──
  // 数据源与 sessionBackgroundActivityStore 同一广播;这里只做调度,拉取与
  // 收口逻辑在 scheduleBackgroundTaskReconcile。仅本机会话:device-link 镜像
  // 会话的快照有降级空表窗口,不可当权威(与远程豁免 running 折算同口径)。
  // 远程判定用**粘滞版**(与面板水合、Stop gating 同口径):relay 瞬断重连会
  // 清空注册表,非粘滞判定在该窗口把远程会话误判成本机 → 到点拿本机空快照把
  // 镜像里真实在跑的任务错误收口;触发沿(timer 到点)还会再复查一次。
  // 可选调用兜底:老 preload 没有该 fanOut 时不得让 initGlobalListeners 整体崩掉。
  bindIpc(
    (cb: (data: unknown) => void) =>
      window.electronAPI?.maker?.onSessionBackgroundActivityChanged?.(cb),
    (raw: unknown) => {
      const p = raw as { sessionId?: string; active?: boolean } | null;
      if (!p || typeof p.sessionId !== 'string' || !p.sessionId) return;
      if (p.active) {
        cancelBackgroundTaskReconcile(p.sessionId);
        return;
      }
      if (isRemoteSessionSticky(p.sessionId)) return;
      // 调度前粗筛:没有 running 条目就不必挂定时器;到点后还会再次捕获候选集。
      if (makerChatStore.captureRunningClaudeTaskIds(p.sessionId).size === 0) return;
      scheduleBackgroundTaskReconcile(p.sessionId);
    },
    'session-background-activity-reconcile',
  );
}

/** Primarily for tests — tears down the global listeners. */
function __teardownGlobalListeners(): void {
  for (const unsub of ipcUnsubscribers) unsub();
  ipcUnsubscribers.length = 0;
  globalListenersInitialized = false;
  _stopDemoteTimer();
  clearTextDeltaFlushTimer();
  pendingTextDeltaBatches.clear();
  for (const timer of backgroundTaskReconcileTimers.values()) clearTimeout(timer);
  backgroundTaskReconcileTimers.clear();
  clearDeferredStateNotificationTimer();
  pendingDeferredStateNotifications.clear();
  pendingMessageCreatedPatches.clear();
  _pendingErrorClearOnLeave.clear();
  remotePresenceOnlineByDevice.clear();
  resetRemoteDataOwnerPushFence();
  const remoteOptimisticSessionIds = new Set([
    ...remoteOptimisticSends.keys(),
    ...remoteOptimisticRetryTimers.keys(),
    ...remoteOptimisticSettlingTimers.keys(),
  ]);
  for (const sessionId of remoteOptimisticSessionIds) {
    clearRemoteOptimisticSendsForSession(sessionId);
  }
  for (const sessionId of remoteClearFences.keys()) {
    clearRemoteClearFence(sessionId, { pump: false });
  }
  remoteOptimisticMaterializationRecoveries.clear();
  syncRemoteOptimisticAttachmentUrls();
  remoteOptimisticPumps.clear();
  remoteOptimisticLocallyRemoved.clear();
  remoteClearInFlight.clear();
  remoteInputProjectionRequests.clear();
  remoteInputProjectionProbeStateBySession.clear();
  // A test/HMR teardown starts a fresh renderer epoch. Session LRU/view
  // eviction intentionally does not clear these maps: a reconnect can rebuild
  // the mirror with an empty shard and still needs the last known clear token.
  remoteInputClearBoundaryBySession.clear();
  rendererClearBoundaryBySession.clear();
  rendererClearGenerationBySession.clear();
  // Stage 2 C1: 老的 cc-agent:* fan-out 已退役, __resetCCAgentFanOuts 也跟着删了。
  // 新链路 maker:* fan-out 当前不会泄漏 (initGlobalListeners 顶部 if guard +
  // dispose 时调对应 unsub()), 不需要 reset 兜底; 真发现 HMR fan-out 重复时
  // 再给 maker.* 的 4 个 fanOut 加一个 __resetMakerFanOuts。
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function subscribe(sessionId: string, cb: () => void): () => void {
  let set = listeners.get(sessionId);
  if (!set) {
    set = new Set();
    listeners.set(sessionId, set);
  }
  set.add(cb);
  return () => {
    const s = listeners.get(sessionId);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) listeners.delete(sessionId);
  };
}

function selectLightState(state: SessionChatState): SessionChatLightState {
  return {
    agentSwitchIntent: state.agentSwitchIntent,
    agentStatus: state.agentStatus,
    isStreaming: state.isStreaming,
    error: state.error,
    usageLimitRecovery: state.usageLimitRecovery,
    errorReason: state.errorReason,
    recoverableError: state.recoverableError,
    errorRetryText: state.errorRetryText,
    credentialSwitchWait: state.credentialSwitchWait,
    continuationInFlightClientId: state.continuationInFlightClientId,
    continuationTurnClientId: state.continuationTurnClientId,
    continuationInFlightProjectionCapability: state.continuationInFlightProjectionCapability,
    isLoadingMore: state.isLoadingMore,
    hasMoreMessages: state.hasMoreMessages,
    historyWindowHasIsland: state.historyWindowHasIsland,
    isFirstMessage: state.isFirstMessage,
    historyLoaded: state.historyLoaded,
    pendingPermission: state.pendingPermission,
    pendingAskUser: state.pendingAskUser,
    pendingPluginSetup: state.pendingPluginSetup,
    pluginSetupViewerState: state.pluginSetupViewerState,
    pluginSetupCommandInFlight: state.pluginSetupCommandInFlight,
    askUserViewerState: state.askUserViewerState,
    askUserDraft: state.askUserDraft,
    pendingPlanReview: state.pendingPlanReview,
    pendingIssueConfirm: state.pendingIssueConfirm,
    pendingRenameSessionsConfirm: state.pendingRenameSessionsConfirm,
    pendingGhostGrantConfirm: state.pendingGhostGrantConfirm,
    planViewerState: state.planViewerState,
    lastExpandedPlanViewerState: state.lastExpandedPlanViewerState,
    pendingQueue: state.pendingQueue,
    steeringQueueClientIds: state.steeringQueueClientIds,
    queuePaused: state.queuePaused,
    queueExpanded: state.queueExpanded,
    fastMode: state.fastMode,
    planModeEnabled: state.planModeEnabled,
  };
}

function lightStateEquals(a: SessionChatLightState, b: SessionChatLightState): boolean {
  return (
    a.agentSwitchIntent === b.agentSwitchIntent &&
    a.agentStatus === b.agentStatus &&
    a.isStreaming === b.isStreaming &&
    a.error === b.error &&
    a.usageLimitRecovery === b.usageLimitRecovery &&
    a.errorReason === b.errorReason &&
    a.recoverableError === b.recoverableError &&
    a.errorRetryText === b.errorRetryText &&
    a.credentialSwitchWait === b.credentialSwitchWait &&
    a.continuationInFlightClientId === b.continuationInFlightClientId &&
    a.continuationTurnClientId === b.continuationTurnClientId &&
    a.continuationInFlightProjectionCapability === b.continuationInFlightProjectionCapability &&
    a.isLoadingMore === b.isLoadingMore &&
    a.hasMoreMessages === b.hasMoreMessages &&
    a.historyWindowHasIsland === b.historyWindowHasIsland &&
    a.isFirstMessage === b.isFirstMessage &&
    a.historyLoaded === b.historyLoaded &&
    a.pendingPermission === b.pendingPermission &&
    a.pendingAskUser === b.pendingAskUser &&
    a.pendingPluginSetup === b.pendingPluginSetup &&
    a.pluginSetupViewerState === b.pluginSetupViewerState &&
    a.pluginSetupCommandInFlight === b.pluginSetupCommandInFlight &&
    a.askUserViewerState === b.askUserViewerState &&
    a.askUserDraft === b.askUserDraft &&
    a.pendingPlanReview === b.pendingPlanReview &&
    a.pendingIssueConfirm === b.pendingIssueConfirm &&
    a.pendingRenameSessionsConfirm === b.pendingRenameSessionsConfirm &&
    a.pendingGhostGrantConfirm === b.pendingGhostGrantConfirm &&
    a.planViewerState === b.planViewerState &&
    a.lastExpandedPlanViewerState === b.lastExpandedPlanViewerState &&
    a.pendingQueue === b.pendingQueue &&
    a.steeringQueueClientIds === b.steeringQueueClientIds &&
    a.queuePaused === b.queuePaused &&
    a.queueExpanded === b.queueExpanded &&
    a.fastMode === b.fastMode &&
    a.planModeEnabled === b.planModeEnabled
  );
}

function getLightSnapshot(sessionId: string): SessionChatLightState {
  const next = selectLightState(getOrCreateState(sessionId));
  const cached = lightSnapshotCache.get(sessionId);
  if (cached && lightStateEquals(cached, next)) return cached;
  lightSnapshotCache.set(sessionId, next);
  return next;
}

function subscribeLight(sessionId: string, cb: () => void): () => void {
  let prev = getLightSnapshot(sessionId);
  return subscribe(sessionId, () => {
    const next = getLightSnapshot(sessionId);
    if (next === prev) return;
    prev = next;
    cb();
  });
}

function getSnapshot(sessionId: string): SessionChatState {
  return getOrCreateState(sessionId);
}

/**
 * Sidebar unsent-content indicator read: does this session have a PAUSED,
 * non-empty pending queue? Deliberately a NON-creating read (`sessions.get`,
 * not `getOrCreateState`) — the sidebar queries this for every listed session,
 * and `getOrCreateState` would touch the LRU + materialize phantom state for
 * sessions the user never opened. Returns false when no state exists.
 */
function hasPausedQueue(sessionId: string): boolean {
  const state = sessions.get(sessionId);
  return state ? isQueuePausedWithPending(state) : false;
}

/**
 * F-SB-7: Subscribe to ALL session state changes. Fires whenever any session's
 * state updates. Used by Sidebar to track running status across sessions.
 */
function subscribeAll(cb: () => void): () => void {
  globalListeners.add(cb);
  return () => {
    globalListeners.delete(cb);
  };
}

/**
 * F-SB-7: Per-session status info exposed to Sidebar.
 * `isRunning`            — agent is actively processing.
 * `hasError`             — session ended with an error (used to suppress done notification).
 * `hasPendingAskUser`    — session is waiting for user to answer a question.
 * `hasPendingPermission` — session is waiting for user to grant permission.
 * `hasPendingPlanReview` — session is waiting for user to review a plan (FP-3).
 * `hasPendingPluginSetup` — session is waiting for local plugin setup.
 */
export interface SessionStatusInfo {
  isRunning: boolean;
  hasError: boolean;
  /** 本次 running→stopped 来自 skipTurnReset side-task(mivo 等): 终态通知全跳过。 */
  sideTask?: boolean;
  hasPendingAskUser: boolean;
  hasPendingPermission: boolean;
  hasPendingPlanReview: boolean;
  hasPendingPluginSetup: boolean;
}

/**
 * F-SB-7: Returns a snapshot of all tracked sessions' status.
 * Only includes sessions that are either running or have an error.
 * The returned Map is referentially stable when nothing changed.
 *
 * 契约(2026-07 卡顿修复,useSyncExternalStore 要求):getRunningSnapshot 是
 * **纯 getter**——两次 notify 之间无论被调用多少次,永远返回同一个引用。
 * 实现:mutation 咽喉(setState / purge)只把 _statusSnapshotDirty 置位,
 * getter 在 dirty 时才重算并缓存。旧实现在 getter 内部消费 running→stopped
 * transition(第一次读到、第二次就删),连续调用返回不同 Map,触发 React
 * "getSnapshot should be cached" 警告并在高频更新下放大重渲染。
 *
 * running→stopped 的一次性投递改为显式调度:重算时检测到边沿 → 条目进
 * _stopTransitions(合并进快照,携带 hasError / sideTask / pending 标志)→
 * 调度一个 macrotask 统一清除 + 再次 notify。所有订阅者在同一代快照里
 * 都能看到 transition(不再被"谁先读谁消费"的 race 抢走);清除后条目消失,
 * error-only 会话不会常驻累积(与旧设计的防累积目标一致)。消费方本就
 * 兼容"条目已消失"(hasSessionTerminalError / wasLastStopSideTask 兜底)。
 */
let _statusSnapshot: ReadonlyMap<string, SessionStatusInfo> = new Map();
let _statusSnapshotDirty = true;
/** 待投递的 running→stopped 一次性条目(键 = sessionId)。 */
const _stopTransitions = new Map<string, SessionStatusInfo>();
let _stopTransitionClearScheduled = false;

/** mutation 侧唯一入口:状态可能变了,下次读快照时重算。 */
function markStatusSnapshotDirty(): void {
  _statusSnapshotDirty = true;
}

/**
 * transition 条目的显式清除:macrotask 里统一清空 + notify 全局订阅者。
 * 用 setTimeout(0) 而非 microtask,给 React 一个完整任务周期把携带 transition
 * 的那代快照渲染/派发出去;即使个别订阅者错过(自身 effect 晚于清除),
 * 它们的边沿检测有 store 权威查询兜底(见 useSessionRunningStatus)。
 */
function scheduleStopTransitionClear(): void {
  if (_stopTransitionClearScheduled) return;
  _stopTransitionClearScheduled = true;
  setTimeout(() => {
    _stopTransitionClearScheduled = false;
    if (_stopTransitions.size === 0) return;
    _stopTransitions.clear();
    _statusSnapshotDirty = true;
    globalListeners.forEach((cb) => {
      cb();
    });
  }, 0);
}

function computeRunningSnapshot(): Map<string, SessionStatusInfo> {
  const next = new Map<string, SessionStatusInfo>();
  for (const [id, state] of sessions) {
    const hasPendingAskUser = state.pendingAskUser !== null;
    const hasPendingPermission = state.pendingPermission !== null;
    const hasPendingPlanReview = state.pendingPlanReview !== null;
    const hasPendingPluginSetup = hasPendingPluginSetupInteraction(
      state.pendingPluginSetup,
      state.pendingPluginSetupQueue,
    );

    // 后台 subagent 折算:主 turn 已结束但 wake 型后台任务(local_agent /
    // local_workflow)还在跑,或正处于「任务终态 → wake turn 启动」的桥接空窗
    // (pendingTaskWake)——两种情况会话都仍在工作,sidebar spinner 不该停、
    // 「已完成」通知不该发。任务全部终态后 SDK 自动开 wake turn 接续 running,
    // 真正的 running→stopped 转换推迟到最终 turn 结束才发生。
    // (远程会话豁免,见 hasBackgroundAgentWork 注释。)
    const bgTaskRunning = hasBackgroundAgentWork(id, state);

    if (state.agentStatus.isRunning || bgTaskRunning) {
      // Currently running — always include.
      next.set(id, {
        isRunning: true,
        hasError: false,
        hasPendingAskUser,
        hasPendingPermission,
        hasPendingPlanReview,
        hasPendingPluginSetup,
      });
    } else if (
      hasPendingAskUser ||
      hasPendingPermission ||
      hasPendingPlanReview ||
      hasPendingPluginSetup
    ) {
      // Session has a pending prompt for the user — include so the Sidebar
      // can show the "needs attention" notification dot.
      next.set(id, {
        isRunning: false,
        hasError: false,
        hasPendingAskUser,
        hasPendingPermission,
        hasPendingPlanReview,
        hasPendingPluginSetup,
      });
    }
  }

  // running→stopped 边沿检测(对比上一代快照):生成一次性投递条目。
  // side-task(skipTurnReset)结束不是 turn 终态:整个 transition 标记为
  // sideTask,通知判定(done/error/dot)全部跳过(见 lastStopWasSideTask)。
  for (const [id, prev] of _statusSnapshot) {
    if (!prev.isRunning) continue;
    if (next.get(id)?.isRunning) continue;
    const state = sessions.get(id);
    if (!state) continue; // 会话已 purge:无终态可投递
    _stopTransitions.set(id, {
      isRunning: false,
      hasError: !!state.error && !state.lastStopWasSideTask,
      sideTask: state.lastStopWasSideTask,
      hasPendingAskUser: state.pendingAskUser !== null,
      hasPendingPermission: state.pendingPermission !== null,
      hasPendingPlanReview: state.pendingPlanReview !== null,
      hasPendingPluginSetup: hasPendingPluginSetupInteraction(
        state.pendingPluginSetup,
        state.pendingPluginSetupQueue,
      ),
    });
  }

  // 合并待投递条目(覆盖 pending 分支的同 id 条目,与旧 else-if 优先级一致);
  // 期间又跑起来的会话 transition 作废(新 turn 已接续,不该报终态)。
  for (const [id, info] of _stopTransitions) {
    if (next.get(id)?.isRunning) {
      _stopTransitions.delete(id);
      continue;
    }
    if (!sessions.has(id)) {
      _stopTransitions.delete(id); // 已 purge:条目随之作废
      continue;
    }
    next.set(id, info);
  }
  if (_stopTransitions.size > 0) scheduleStopTransitionClear();
  return next;
}

function getRunningSnapshot(): ReadonlyMap<string, SessionStatusInfo> {
  if (!_statusSnapshotDirty) return _statusSnapshot;
  _statusSnapshotDirty = false;
  const next = computeRunningSnapshot();
  // Referential equality check — avoid re-renders when nothing changed
  if (next.size === _statusSnapshot.size) {
    let same = true;
    for (const [id, info] of next) {
      const prev = _statusSnapshot.get(id);
      if (
        !prev ||
        prev.isRunning !== info.isRunning ||
        prev.hasError !== info.hasError ||
        prev.sideTask !== info.sideTask ||
        prev.hasPendingAskUser !== info.hasPendingAskUser ||
        prev.hasPendingPermission !== info.hasPendingPermission ||
        prev.hasPendingPlanReview !== info.hasPendingPlanReview ||
        prev.hasPendingPluginSetup !== info.hasPendingPluginSetup
      ) {
        same = false;
        break;
      }
    }
    if (same) return _statusSnapshot;
  }
  _statusSnapshot = next;
  return _statusSnapshot;
}

/**
 * F-SB-7: Authoritative terminal-error read for a session, independent of the
 * running-status snapshot generation. Stop-transition entries now live in the
 * snapshot for a full delivery window (until the scheduled clear fires) and
 * reads no longer consume them — but a subscriber whose effect runs late
 * (e.g. a debounced timer) can still observe the entry-already-cleared
 * generation and must not fall back to hasError=false — it queries here
 * instead.
 */
/** 最近一次 running→stopped 是否来自 side-task(见 lastStopWasSideTask)。
 * useSessionRunningStatus 在 transition entry 已被调度清除后以此兜底,
 * 使 side-task 结束不触发 done/error 终态通知。 */
function wasLastStopSideTask(sessionId: string): boolean {
  return !!sessions.get(sessionId)?.lastStopWasSideTask;
}

function hasSessionTerminalError(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  // side-task 结束保留的旧 error 不算「本次 run 的终态失败」(与 transition
  // snapshot 的豁免同口径, 见 lastStopWasSideTask)。
  return !!s?.error && !s.lastStopWasSideTask;
}

// 远程回执 error 免疫的兜底探针:活动镜像缺条目(推送丢失 / 未达)时,
// sessionAttentionStore 回落到消息层的终止错误判定(注入避免循环依赖)。
setRemoteTerminalErrorProbe(hasSessionTerminalError);

interface ActiveSessionSnapshot {
  sessionId: string;
  agentKind: 'claude-code' | 'codex' | 'pi';
  isTurnRunning: boolean;
}

function isActiveSessionSnapshot(value: unknown): value is ActiveSessionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.sessionId === 'string' &&
    (item.agentKind === 'claude-code' || item.agentKind === 'codex' || item.agentKind === 'pi') &&
    typeof item.isTurnRunning === 'boolean'
  );
}

/**
 * Renderer reload recovery: main keeps the live SDK sessions, but this module's
 * in-memory `isStreaming` state is lost. Pull the main-side turn snapshot once
 * after listeners are installed so Stop/running indicators recover without
 * waiting for another status event.
 */
function syncActiveTurnsFromMain(): void {
  const listActive = window.electronAPI?.maker?.listActive;
  if (typeof listActive !== 'function') return;

  void listActive()
    .then((items) => {
      if (!Array.isArray(items)) return;
      const active = items.filter(isActiveSessionSnapshot);
      for (const item of active) {
        setState(item.sessionId, (s) => {
          const agentKindPatch = s.agentKind === item.agentKind ? null : item.agentKind;
          if (!item.isTurnRunning) {
            return agentKindPatch ? { ...s, agentKind: agentKindPatch } : s;
          }
          return {
            ...s,
            ...(agentKindPatch ? { agentKind: agentKindPatch } : {}),
            isStreaming: true,
            error: null,
            usageLimitRecovery: null,
            errorReason: null,
            recoverableError: null,
            activeTurnRetryText: null,
            errorRetryText: null,
            agentStatus: {
              ...s.agentStatus,
              status: s.agentStatus.status || 'Running',
              isRunning: true,
              startedAt: s.agentStatus.startedAt ?? Date.now(),
            },
          };
        });
      }
    })
    .catch((err) => log.warn('Failed to sync active maker sessions:', err));
}

function setTitleUpdateCallback(sessionId: string, cb: (() => void) | undefined): void {
  if (cb) titleUpdateCallbacks.set(sessionId, cb);
  else titleUpdateCallbacks.delete(sessionId);
}

/**
 * initGlobalListeners 注入的「interaction-request 分发」引用,供 reconcilePendingInteractions
 * 复用(打开/重连会话时把当前挂起交互重建成可操作面板)。handler 无闭包局部依赖。
 */
let applyInteractionRequestRef: ((raw: unknown) => void) | null = null;

/**
 * 快照重建:拉取某会话当前挂起的交互(permission/ask/plan)并重建可操作面板。
 *
 * 背景:pending 交互状态原本只由实时 INTERACTION_REQUEST push 设置 —— 在交互挂起**之后**
 * 才打开/重连/刷新该会话的窗口(典型:控制端「新窗口」打开远程会话)会错过那条 push,
 * 面板不显示。这里经 makerApiFor(按来源路由:本机本机 IPC / 远程隧道)主动拉快照,
 * 喂给同一套分发逻辑重建(ask/plan 按 requestId 去重,复用历史里那条消息,不产生重复)。
 */
function reconcilePendingInteractions(
  sessionId: string,
  isCurrent?: () => boolean,
): Promise<number> {
  if (!sessionId) return Promise.resolve(0);
  // The interaction snapshot is an async read, so its lifecycle must be
  // independent from the optional history-load guard supplied by only some
  // callers.  Purge/clear/reload advance messagesEpoch; an origin change
  // means the response came from a different authority.  Keep the captured
  // values even when no session slice exists yet: an unmounted session may
  // legitimately be materialized by a fresh interaction snapshot, while a
  // purged session cannot be resurrected because its epoch/tombstone changes.
  const interactionEpochAtStart = _messagesEpoch.get(sessionId) ?? 0;
  const interactionAuthorityEpochAtStart = _inputProjectionAuthorityEpoch.get(sessionId) ?? 0;
  const interactionDataOwnerAtStart = getDataOwnerGeneration();
  // Only the newest interaction snapshot may mutate the pending-card slice.
  // This also covers a dismiss/answer/request event arriving while the host
  // query is in flight, and prevents an older concurrent reconcile from
  // subtractively deleting a newer plugin_setup card.
  const interactionReconcileEpochAtStart = beginInteractionReconcile(sessionId);
  const interactionOriginAtStart = remoteProjectsStore.getSessionDeviceId(sessionId);
  const stickyDeviceAtStart = getStickySessionDeviceId(sessionId);
  const isCurrentInteractionReconcile = () =>
    isDataOwnerGenerationCurrent(interactionDataOwnerAtStart) &&
    (_messagesEpoch.get(sessionId) ?? 0) === interactionEpochAtStart &&
    (_inputProjectionAuthorityEpoch.get(sessionId) ?? 0) === interactionAuthorityEpochAtStart &&
    (_interactionReconcileEpoch.get(sessionId) ?? 0) === interactionReconcileEpochAtStart &&
    remoteProjectsStore.getSessionDeviceId(sessionId) === interactionOriginAtStart &&
    (!stickyDeviceAtStart || !isRemoteTerminalSessionTombstoned(sessionId, stickyDeviceAtStart)) &&
    (!isCurrent || isCurrent());
  if (!isCurrentInteractionReconcile()) return Promise.resolve(0);
  // best-effort 面板重建:对既有调用方仍是 fire-and-forget。它被 ensureInitialMessages 的
  // listMessagesFor.then 内联调用,若 getPendingInteractions **同步**抛错(如某路由分支
  // API 缺失)而不只是 reject,异常会冒泡到外层 .catch 把 historyLoaded 误打回 false。
  // 故把同步调用也包进 try/catch —— 重建失败绝不能影响历史加载。
  // 返回结果 promise(resolve 值 = 实际重建的挂起交互数;失败会 reject,内部已挂
  // 日志 catch 防 unhandledrejection):reconcileRemoteMessages 把它并入同步代数完成
  // 语义——needs-interaction 未读的 passive 远程回执必须等交互面板真实重建后才放行,
  // 且守卫早退路径只在真有提示(count>0)时才算一代完成。
  try {
    const interactionApi = stickyDeviceAtStart
      ? makerApiForDevice(stickyDeviceAtStart)
      : makerApiFor(sessionId);
    const run = interactionApi.getPendingInteractions(sessionId).then((list) => {
      if (!isCurrentInteractionReconcile()) return 0;
      if (!Array.isArray(list)) return 0;
      // A successful list response is the Host-authoritative snapshot for Setup
      // interactions. Reconcile it subtractively before replaying the snapshot so
      // a Device Link reconnect cannot leave cards that the Host already closed.
      // Other interaction kinds keep their existing replay semantics.
      const authoritativePluginSetupIds = new Set<string>();
      for (const item of list) {
        const request = item?.request;
        if (
          request?.kind === 'plugin_setup' &&
          typeof request.requestId === 'string' &&
          request.requestId.length > 0
        ) {
          authoritativePluginSetupIds.add(request.requestId);
        }
      }
      if (!isCurrentInteractionReconcile()) return 0;
      setState(sessionId, (state) => {
        const currentSurvives =
          state.pendingPluginSetup !== null &&
          authoritativePluginSetupIds.has(state.pendingPluginSetup.requestId);
        const survivingQueue = state.pendingPluginSetupQueue.filter(
          (setup) =>
            authoritativePluginSetupIds.has(setup.requestId) &&
            (!currentSurvives || setup.requestId !== state.pendingPluginSetup?.requestId),
        );
        const nextCurrent = currentSurvives
          ? state.pendingPluginSetup
          : (survivingQueue.shift() ?? null);
        const currentChanged = nextCurrent !== state.pendingPluginSetup;
        const queueChanged =
          survivingQueue.length !== state.pendingPluginSetupQueue.length ||
          survivingQueue.some((setup, index) => setup !== state.pendingPluginSetupQueue[index]);
        const nextCommand =
          state.pluginSetupCommandInFlight &&
          authoritativePluginSetupIds.has(state.pluginSetupCommandInFlight.requestId)
            ? state.pluginSetupCommandInFlight
            : null;

        if (!currentChanged && !queueChanged && nextCommand === state.pluginSetupCommandInFlight) {
          return state;
        }
        return {
          ...state,
          pendingPluginSetup: nextCurrent,
          pendingPluginSetupQueue: survivingQueue,
          pluginSetupViewerState: currentChanged ? 'expanded' : state.pluginSetupViewerState,
          pluginSetupCommandInFlight: nextCommand,
        };
      });
      for (const item of list) {
        if (!isCurrentInteractionReconcile()) return 0;
        applyInteractionRequestRef?.({
          sessionId,
          request: item.request,
          persistId: item.persistId,
        });
      }
      return list.length;
    });
    run.catch((err) => log.warn('reconcilePendingInteractions failed', err));
    return run;
  } catch (err) {
    log.warn('reconcilePendingInteractions failed', err);
    const rejected = Promise.reject<number>(err);
    rejected.catch(() => undefined);
    return rejected;
  }
}

/**
 * Ensure the initial history has been fetched for this session. Idempotent —
 * subsequent calls after the first successful fetch are no-ops.
 */
// Guard set to prevent concurrent fetches (historyLoaded stays false until data arrives)
const _historyFetchInFlight = new Set<string>();
/** 首拉请求 token:origin 变化 / reload / purge 时作废旧 Promise,防本机竞态响应回写远程会话。 */
const _historyFetchToken = new Map<string, number>();
let _nextHistoryFetchToken = 0;

function invalidateHistoryFetch(sessionId: string): void {
  _historyFetchToken.set(sessionId, ++_nextHistoryFetchToken);
}

/**
 * device-link:记录每个 session 的历史「按哪个 origin(deviceId)加载」。
 * undefined = 本机会话 / 加载时来源尚未解析;string = 已解析的被控设备 id。
 *
 * 背景:控制端启动时路由可能**先于** remote-projects bootstrap 恢复到某远程会话,
 * 此刻 getSessionDeviceId 仍是 undefined → ensureInitialMessages 误命中本机空库
 * (被控端 row 不在本地)→ 拿到空历史且 historyLoaded=true 卡死,即便随后 mapping
 * 注入也不再重试。reconcileOpenSessionOrigins 据此 Map 检测 origin 漂移
 * (undefined→deviceId)后重载,经隧道拉被控端真历史。
 */
const _historyLoadOrigin = new Map<string, string | undefined>();

/**
 * input projection 请求的来源与代际守卫。
 *
 * projection 查询可能跨过 device-link origin 切换:启动时先按本机来源发起的请求,可能在
 * 远程来源已经接管后才返回。若无守卫,旧本机 projection 会覆盖远程 projection(尤其把
 * continuationTurnClientId 从非空写回 null),让仍在运行的续跑行停止转圈。
 *
 * origin 变化时 epoch 单调递增,因此即使来源经历 A→undefined→A 的 ABA 也不会重新放行
 * 更早请求。查询按 origin + epoch 丢弃旧响应；直接操作按 origin + authority epoch 拒绝
 * 来源漂移或终态前发出的响应。实时 push 另在接收点按 source device 校验。
 */
const _inputProjectionOrigin = new Map<string, string | undefined>();
const _inputProjectionEpoch = new Map<string, number>();
const _inputProjectionAuthorityEpoch = new Map<string, number>();
let _nextInputProjectionEpoch = 0;

/**
 * Interaction snapshots have their own lifecycle epoch. A pending
 * permission/ask/plan card is not message history: dismissing or answering it
 * must invalidate an older `getPendingInteractions()` response without
 * cancelling unrelated message pagination.
 */
const _interactionReconcileEpoch = new Map<string, number>();

function bumpInteractionReconcileEpoch(sessionId: string): number {
  const next = (_interactionReconcileEpoch.get(sessionId) ?? 0) + 1;
  _interactionReconcileEpoch.set(sessionId, next);
  return next;
}

function beginInteractionReconcile(sessionId: string): number {
  return bumpInteractionReconcileEpoch(sessionId);
}

function nextInputProjectionEpoch(): number {
  _nextInputProjectionEpoch += 1;
  return _nextInputProjectionEpoch;
}

function supersedeInputProjectionRequests(
  sessionId: string,
  opts: { supersedeOperations?: boolean } = {},
): void {
  const origin = remoteProjectsStore.getSessionDeviceId(sessionId);
  _inputProjectionOrigin.set(sessionId, origin);
  const epoch = nextInputProjectionEpoch();
  _inputProjectionEpoch.set(sessionId, epoch);
  if (opts.supersedeOperations) {
    _inputProjectionAuthorityEpoch.set(sessionId, epoch);
  }
}

function invalidateInputProjectionRequests(sessionId: string): void {
  _inputProjectionOrigin.delete(sessionId);
  _inputProjectionEpoch.delete(sessionId);
  remoteInputProjectionRequests.delete(sessionId);
  remoteInputProjectionProbeStateBySession.delete(sessionId);
  // authority 代际不能 delete：pre-purge 操作可能捕获 0，delete 后回落 0 会误放行，
  // 并通过 setState 复活已 purge 的 session。保留单调墓碑，与 messagesEpoch 同理。
  _inputProjectionAuthorityEpoch.set(sessionId, nextInputProjectionEpoch());
}

/**
 * An account/local-mode boundary invalidates standalone projection operations
 * too. They do not necessarily have a remote optimistic outbox record, so
 * clearing only the outbox would still let an old owner's late projection
 * mutate the new owner's session slice.
 */
function invalidateInputProjectionRequestsForDataOwnerBoundary(): void {
  const sessionIds = new Set<string>([
    ...sessions.keys(),
    ..._inputProjectionOrigin.keys(),
    ..._inputProjectionEpoch.keys(),
    ..._inputProjectionAuthorityEpoch.keys(),
    ...remoteInputProjectionRequests.keys(),
  ]);
  for (const sessionId of sessionIds) invalidateInputProjectionRequests(sessionId);
}

function beginInputProjectionRequest(sessionId: string, origin: string | undefined): number {
  _inputProjectionOrigin.set(sessionId, origin);
  const epoch = nextInputProjectionEpoch();
  _inputProjectionEpoch.set(sessionId, epoch);
  return epoch;
}

function noteInputProjectionOrigin(
  sessionId: string,
  origin: string | undefined,
): { epoch: number; changed: boolean } {
  const previous = _inputProjectionOrigin.get(sessionId);
  if (!_inputProjectionOrigin.has(sessionId) || previous !== origin) {
    _inputProjectionOrigin.set(sessionId, origin);
    const epoch = nextInputProjectionEpoch();
    _inputProjectionEpoch.set(sessionId, epoch);
    _inputProjectionAuthorityEpoch.set(sessionId, epoch);
    return { epoch, changed: true };
  }
  return { epoch: _inputProjectionEpoch.get(sessionId)!, changed: false };
}

function isCurrentInputProjectionOrigin(sessionId: string, origin: string | undefined): boolean {
  return getStickySessionDeviceId(sessionId) === origin;
}

function isCurrentInputProjectionRequest(
  sessionId: string,
  origin: string | undefined,
  epoch: number,
  dataOwner: DataOwnerGeneration,
): boolean {
  return (
    isDataOwnerGenerationCurrent(dataOwner) &&
    isCurrentInputProjectionOrigin(sessionId, origin) &&
    (_inputProjectionEpoch.get(sessionId) ?? 0) === epoch
  );
}

interface InputProjectionOperation {
  api: RoutableMaker;
  origin: string | undefined;
  pinnedDeviceId?: string;
  dataOwner: DataOwnerGeneration;
  epoch: number;
}

/**
 * 捕获一次会返回 projection 的操作路由。`api` 与 origin 必须在同一时刻定格：
 * origin 漂移后重新调用 makerApiFor 会把同一业务意图错发到另一台设备。
 * authority epoch 只由终态 / 来源切换推进；普通 push 与同源并发操作仍按响应到达顺序落地。
 */
function beginInputProjectionOperation(
  sessionId: string,
  pinnedDeviceId?: string,
): InputProjectionOperation {
  // Queue controls are still writes to the session owner. The live mirror can
  // be empty for a short window while relay subscriptions are rebuilding, but
  // stickySessionOrigin retains the last authoritative device and prevents a
  // weak-link click from falling back to the controller's local maker.
  const routedDeviceId = pinnedDeviceId ?? getStickySessionDeviceId(sessionId);
  const origin = routedDeviceId;
  return {
    api: routedDeviceId ? makerApiForDevice(routedDeviceId) : makerApiFor(sessionId),
    origin,
    ...(pinnedDeviceId ? { pinnedDeviceId } : {}),
    dataOwner: getDataOwnerGeneration(),
    epoch: _inputProjectionAuthorityEpoch.get(sessionId) ?? 0,
  };
}

function applyInputProjectionOperationResponse(
  sessionId: string,
  operation: InputProjectionOperation,
  projection: AgentInputProjection,
): boolean {
  if (
    !isDataOwnerGenerationCurrent(operation.dataOwner) ||
    (operation.pinnedDeviceId
      ? getStickySessionDeviceId(sessionId) !== operation.pinnedDeviceId
      : !isCurrentInputProjectionOrigin(sessionId, operation.origin)) ||
    (_inputProjectionAuthorityEpoch.get(sessionId) ?? 0) !== operation.epoch
  ) {
    return false;
  }
  // 直接操作响应会 supersede 早先的查询；apply 的默认路径负责推进查询 epoch。
  applyInputProjection(projection);
  return true;
}

/**
 * Renderer 收到权威 turn 终态时，同时作废所有此前发出的 projection 查询。
 * reducer 本身保持纯函数；调用方在 setState 前执行这条时序屏障。
 */
function supersedeInputProjectionOnTerminalEvent(
  sessionId: string,
  event: Pick<CCAgentStreamEvent, 'type' | 'data' | 'turnContinuationId'>,
): void {
  if (isTurnContinuationBoundaryEvent(event)) return;
  if (event.type === 'done') {
    if ((event.data as { silentStop?: boolean } | null | undefined)?.silentStop !== true) {
      bumpInteractionReconcileEpoch(sessionId);
      supersedeInputProjectionRequests(sessionId, { supersedeOperations: true });
    }
    return;
  }
  if (event.type === 'error' && isTerminalErrorData(event.data)) {
    bumpInteractionReconcileEpoch(sessionId);
    supersedeInputProjectionRequests(sessionId, { supersedeOperations: true });
  }
}

function runInputProjectionOperation(
  sessionId: string,
  invoke: (input: RoutableMaker['input']) => Promise<AgentInputProjection>,
): Promise<{ applied: boolean; projection: AgentInputProjection }> {
  const operation = beginInputProjectionOperation(sessionId);
  return invoke(operation.api.input).then((projection) => ({
    applied: applyInputProjectionOperationResponse(sessionId, operation, projection),
    projection,
  }));
}

type RemoteOptimisticDispatchResult =
  | { kind: 'accepted' }
  | { kind: 'retry' }
  | { kind: 'deferred' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: unknown };

type RemoteOptimisticPreparationResult =
  | { kind: 'ready' }
  | { kind: 'deferred' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error?: unknown };

function isRemoteOptimisticSendRegistered(
  sessionId: string,
  record: RemoteOptimisticSendRecord,
): boolean {
  return (
    remoteOptimisticSendRecords(sessionId)?.get(record.queued.clientId) === record &&
    isDataOwnerGenerationCurrent(record.dataOwner)
  );
}

async function prepareRemoteOptimisticSend(
  sessionId: string,
  record: RemoteOptimisticSendRecord,
): Promise<RemoteOptimisticPreparationResult> {
  if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
  if (hasPendingRemoteClearFence(sessionId)) {
    record.phase = 'waiting-for-connection';
    scheduleRemoteClearRetry(sessionId);
    return { kind: 'deferred' };
  }
  if (record.materializationPending) {
    record.phase = 'preflight';
    return { kind: 'deferred' };
  }
  if (!record.preflightCompleted && record.beforeEnqueue) {
    record.phase = 'preflight';
    try {
      const proceed = await record.beforeEnqueue();
      if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
      if (!proceed) return { kind: 'failed' };
      record.preflightCompleted = true;
    } catch (error) {
      if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
      if (!isDeferredRemoteSendError(error)) return { kind: 'failed', error };
      markRemoteOptimisticSendWaiting(sessionId, record.queued.clientId);
      return { kind: 'deferred' };
    }
  } else {
    record.preflightCompleted = true;
  }

  // Any send without a known token probes the pinned host before dispatch. This
  // includes steer: a clear boundary is a content-ownership fence, not merely
  // an enqueue concern. Older hosts may reject the projection invoke; the
  // compatibility fallback below still permits the original steer attempt.
  const forceProbe = record.forceClearBoundaryProbe;
  if (
    !forceProbe &&
    record.expectedClearBoundaryMs === undefined &&
    !record.clearBoundaryProbeCompleted
  ) {
    const knownBoundary = getKnownRemoteInputClearBoundary(sessionId);
    if (knownBoundary !== undefined) {
      record.expectedClearBoundaryMs = knownBoundary;
      record.clearBoundaryProbeCompleted = true;
    }
  }
  if (
    !forceProbe &&
    record.expectedClearBoundaryMs === undefined &&
    !record.clearBoundaryProbeCompleted
  ) {
    const probeState = remoteInputProjectionProbeStateBySession.get(sessionId);
    if (
      probeState &&
      isRemoteInputProjectionProbeStateCurrent(sessionId, probeState, record.deviceId)
    ) {
      if (
        probeState.status === 'blocked' &&
        (isDeferredRemoteSendError(probeState.error) ||
          isRemoteInputClearBoundaryError(probeState.error))
      ) {
        markRemoteOptimisticSendWaiting(sessionId, record.queued.clientId);
        return { kind: 'deferred' };
      }
      record.expectedClearBoundaryMs = probeState.boundary;
      record.clearBoundaryProbeCompleted = true;
    }
  }
  if (
    record.expectedClearBoundaryMs === undefined &&
    (!record.clearBoundaryProbeCompleted || forceProbe)
  ) {
    record.clearBoundaryProbeInFlight = true;
    try {
      const projectionResult = await requestInputProjection(sessionId, record.deviceId);
      if (!isRemoteOptimisticSendRegistered(sessionId, record)) {
        return { kind: 'cancelled' };
      }
      if (projectionResult && !projectionResult.current) {
        markRemoteOptimisticSendWaiting(sessionId, record.queued.clientId);
        return { kind: 'deferred' };
      }
      const projection = projectionResult?.projection;
      if (projection) {
        const hasBoundary = Object.prototype.hasOwnProperty.call(projection, 'clearBoundaryMs');
        if (hasBoundary) {
          const observedBoundary = normalizeAgentInputClearBoundaryMs(projection.clearBoundaryMs);
          if (observedBoundary === undefined) {
            return {
              kind: 'failed',
              error: new Error('Remote input projection carried an invalid clear boundary'),
            };
          }
          // A push/snapshot may have already advanced the local mirror while the
          // probe was in flight. Never regress to that probe's stale token.
          const currentBoundary = remoteInputClearBoundaryBySession.get(sessionId);
          record.expectedClearBoundaryMs =
            typeof currentBoundary === 'number' &&
            (observedBoundary === null || observedBoundary < currentBoundary)
              ? currentBoundary
              : observedBoundary;
        }
      }
      // `requestInputProjection` has already applied the response. Marking the
      // record complete here avoids a second apply/pump cycle and lets all later
      // FIFO items reuse the same modern/legacy capability result.
      record.clearBoundaryProbeCompleted = true;
      record.forceClearBoundaryProbe = false;
      record.clearGeneration = rendererClearGenerationBySession.get(sessionId) ?? 0;
    } catch (error) {
      if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
      // A clear may be sealing while the relay is otherwise healthy. Keep the
      // local bubble and retry after the boundary settles instead of restoring
      // the composer as a permanent failure. Other projection failures retain
      // the pre-probe compatibility path: enqueue can still be attempted, and
      // main will enforce its own clear/state checks.
      if (isDeferredRemoteSendError(error) || isRemoteInputClearBoundaryError(error)) {
        markRemoteOptimisticSendWaiting(sessionId, record.queued.clientId);
        return { kind: 'deferred' };
      }
      record.forceClearBoundaryProbe = false;
      record.clearBoundaryProbeCompleted = true;
    } finally {
      record.clearBoundaryProbeInFlight = false;
    }
  }

  return { kind: 'ready' };
}

async function reconcileUncertainRemoteSteer(
  sessionId: string,
  record: RemoteOptimisticSendRecord,
  operation: InputProjectionOperation,
): Promise<RemoteOptimisticDispatchResult> {
  const [projectionResult, persistedResult] = await Promise.allSettled([
    operation.api.input.getProjection(sessionId),
    aroundMessagesByClientIdForDevice(record.deviceId, sessionId, record.queued.clientId, {
      radius: 0,
    }),
  ]);
  if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };

  let projectionConclusive = false;
  let persistedLookupConclusive = false;
  let hasAcceptanceEvidence = false;
  let freshProjection: AgentInputProjection | null = null;

  if (projectionResult.status === 'fulfilled') {
    projectionConclusive = true;
    freshProjection = projectionResult.value;
    hasAcceptanceEvidence =
      freshProjection.pendingQueue.some((item) => item.clientId === record.queued.clientId) ||
      freshProjection.steeringQueueClientIds?.includes(record.queued.clientId) === true;
  } else {
    log.warn('remote optimistic steer projection reconciliation failed:', projectionResult.reason);
  }

  if (persistedResult.status === 'fulfilled') {
    persistedLookupConclusive = true;
    hasAcceptanceEvidence ||= persistedResult.value.some(
      (message) => message.clientId === record.queued.clientId,
    );
  } else if (isRemoteAroundClientIdMiss(persistedResult.reason)) {
    // around-client-id 用 NOT_FOUND 表达“该 clientId 尚未落库”。这是一次成功的
    // 否定查询，不应被当成断线继续悬置。
    persistedLookupConclusive = true;
  } else {
    log.warn('remote optimistic steer DB reconciliation failed:', persistedResult.reason);
  }

  if (hasAcceptanceEvidence) {
    record.steerDispatchUncertain = false;
    markRemoteOptimisticSendAccepted(sessionId, record.queued.clientId);
  }
  if (freshProjection) {
    applyInputProjectionOperationResponse(sessionId, operation, freshProjection);
  }
  if (hasAcceptanceEvidence) {
    const current = remoteOptimisticSendRecords(sessionId)?.get(record.queued.clientId);
    if (!current?.currentlyQueued) {
      retainOrClearRemoteOptimisticSendAfterProjection(sessionId, record.queued.clientId);
    }
    markSessionHasUserMessage(sessionId);
    void reconcileRemoteMessages(sessionId);
    return { kind: 'accepted' };
  }

  if (projectionConclusive && persistedLookupConclusive) {
    // 两个权威面都确认没有这条 steer。改用同一 clientId enqueue：若 steer 恰好
    // 在查询后才被 main 接管，coordinator 的 queue/active/steering/recent 窗口
    // 会把这次补投幂等去重；否则消息获得一个可靠的排队落点。
    record.steerDispatchUncertain = false;
    record.deliveryMode = 'queue';
    record.phase = 'preflight';
    return { kind: 'retry' };
  }

  markRemoteOptimisticSendWaiting(sessionId, record.queued.clientId);
  return { kind: 'deferred' };
}

async function dispatchRemoteOptimisticSend(
  sessionId: string,
  record: RemoteOptimisticSendRecord,
): Promise<RemoteOptimisticDispatchResult> {
  if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
  if (record.accepted) return { kind: 'accepted' };
  if (record.dispatching) return { kind: 'deferred' };
  record.dispatching = true;
  record.phase = 'dispatching';
  record.attempt += 1;
  clearRemoteOptimisticRetryTimer(sessionId);

  const operation = beginInputProjectionOperation(sessionId, record.deviceId);
  try {
    if (record.deliveryMode === 'steer') {
      if (record.steerDispatchUncertain) {
        return await reconcileUncertainRemoteSteer(sessionId, record, operation);
      }
      const accepted = await operation.api.input.steer(sessionId, record.queued, {
        touchUserSend: true,
        ...(record.expectedClearBoundaryMs !== undefined
          ? { expectedClearBoundaryMs: record.expectedClearBoundaryMs }
          : {}),
      });
      if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
      if (!accepted) throw new Error('Remote steer was not accepted');
      markRemoteOptimisticSendAccepted(sessionId, record.queued.clientId);
      void requestInputProjection(sessionId);
      return { kind: 'accepted' };
    }
    const projection = await operation.api.input.enqueue(sessionId, record.queued, {
      sendAtMs: Date.now(),
      ...(record.expectedClearBoundaryMs !== undefined
        ? { expectedClearBoundaryMs: record.expectedClearBoundaryMs }
        : {}),
    });
    if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
    markRemoteOptimisticSendAccepted(sessionId, record.queued.clientId);
    if (record.authRetryPersistOnProjectionError) {
      setState(sessionId, (s) => ({
        ...s,
        _authRetryPersistOnProjectionError: {
          clientId: record.queued.clientId,
          ...record.authRetryPersistOnProjectionError!,
        },
      }));
    }
    const applied = applyInputProjectionOperationResponse(sessionId, operation, projection);
    if (applied) markSessionHasUserMessage(sessionId);
    if (!projection.pendingQueue.some((item) => item.clientId === record.queued.clientId)) {
      retainOrClearRemoteOptimisticSendAfterProjection(sessionId, record.queued.clientId);
    }
    return { kind: 'accepted' };
  } catch (error) {
    if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
    if (isRemoteInputPreparationSupersededError(error)) {
      // The host invalidated the input while it was being prepared (for
      // example, a remote clear advanced the coordinator generation). This
      // message is no longer safe to re-probe or enqueue; restore the draft
      // immediately without surfacing a user-facing error.
      return { kind: 'failed', error: undefined };
    }
    if (isRemoteInputClearBoundaryError(error)) {
      // The clear token can advance between the click-time probe and dispatch.
      // Re-open the probe exactly once so a stale renderer token can recover;
      // if the host still rejects the refreshed token, settle normally instead
      // of spinning the outbox forever.
      if (record.clearBoundaryRecoveryAttempted) {
        return { kind: 'failed', error: undefined };
      }
      record.clearBoundaryRecoveryAttempted = true;
      record.expectedClearBoundaryMs = undefined;
      record.clearBoundaryProbeCompleted = false;
      record.clearBoundaryProbeInFlight = false;
      record.forceClearBoundaryProbe = true;
      remoteInputProjectionProbeStateBySession.delete(sessionId);
      remoteInputProjectionRequests.delete(sessionId);
      markRemoteOptimisticSendWaiting(sessionId, record.queued.clientId);
      return { kind: 'deferred' };
    }
    if (isTerminalRemoteInputError(error)) {
      return { kind: 'failed', error };
    }
    if (record.deliveryMode === 'steer' && isAmbiguousRemoteSteerError(error)) {
      record.steerDispatchUncertain = true;
      return await reconcileUncertainRemoteSteer(sessionId, record, operation);
    }
    let reconciliationError: unknown;
    let reconciled = false;
    try {
      // An invoke timeout is ambiguous. Ask the same pinned device before
      // deciding whether it is safe to send again with the same clientId.
      const fresh = await operation.api.input.getProjection(sessionId);
      if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
      const freshHasQueue = fresh.pendingQueue.some(
        (item) => item.clientId === record.queued.clientId,
      );
      const freshHasSteeringMarker =
        fresh.steeringQueueClientIds?.includes(record.queued.clientId) === true;
      if (freshHasQueue || freshHasSteeringMarker) {
        markRemoteOptimisticSendAccepted(sessionId, record.queued.clientId);
        reconciled = true;
      } else {
        const current = remoteOptimisticSendRecords(sessionId)?.get(record.queued.clientId);
        if (current) current.currentlyQueued = false;
      }
      applyInputProjectionOperationResponse(sessionId, operation, fresh);
    } catch (projectionError) {
      if (!isRemoteOptimisticSendRegistered(sessionId, record)) return { kind: 'cancelled' };
      reconciliationError = projectionError;
      log.warn('remote optimistic send reconciliation failed:', projectionError);
    }

    if (reconciled) {
      const current = remoteOptimisticSendRecords(sessionId)?.get(record.queued.clientId);
      if (!current?.currentlyQueued) {
        retainOrClearRemoteOptimisticSendAfterProjection(sessionId, record.queued.clientId);
      }
      markSessionHasUserMessage(sessionId);
      return { kind: 'accepted' };
    }
    const shouldDefer =
      record.deliveryMode === 'steer'
        ? isDefinitelyUndeliveredRemoteSteerError(error)
        : isDeferredRemoteSendError(error) || isDeferredRemoteSendError(reconciliationError);
    if (shouldDefer) {
      markRemoteOptimisticSendWaiting(sessionId, record.queued.clientId);
      return { kind: 'deferred' };
    }
    return { kind: 'failed', error };
  } finally {
    record.dispatching = false;
  }
}

function settleRemoteOptimisticFailure(sessionId: string, clientId: string, error?: unknown): void {
  const record = remoteOptimisticSendRecords(sessionId)?.get(clientId);
  if (record?.composerResolvedOptimistically && isDataOwnerGenerationCurrent(record.dataOwner)) {
    try {
      record.onRemoteOptimisticFailure?.(clientId, error);
    } catch (restoreError) {
      log.warn('remote optimistic composer restore failed:', restoreError);
    }
  }
  // The callback republishes restored draft attachment URLs synchronously.
  // Retire the outbox ref afterwards so media protection transfers without a
  // cleanup-eligible gap in main's renderer registry.
  clearRemoteOptimisticSend(sessionId, clientId);
  setState(sessionId, (s) => ({
    ...s,
    pendingQueue: s.pendingQueue.filter((item) => item.clientId !== clientId),
    messages: s.messages.filter(
      (message) => !(message.clientId === clientId && message.isPendingPersist),
    ),
    ...(error !== undefined
      ? {
          error: decodeRemoteErrorMessage(error instanceof Error ? error.message : String(error)),
          usageLimitRecovery: null,
          errorReason: null,
          recoverableError: null,
          errorRetryText: null,
        }
      : {}),
  }));
}

async function pumpRemoteOptimisticSends(sessionId: string): Promise<void> {
  const existing = remoteOptimisticPumps.get(sessionId);
  if (existing) return existing;
  // Self-reference is intentional: a detached clear/owner generation must not
  // keep draining after a newer pump replaces this Promise in the registry.
  // eslint-disable-next-line prefer-const
  let run!: Promise<void>;
  run = (async () => {
    while (true) {
      const record = firstUnacceptedRemoteOptimisticSend(sessionId);
      if (!record || record.dispatching) return;
      const prepared = await prepareRemoteOptimisticSend(sessionId, record);
      if (prepared.kind === 'deferred') return;
      if (prepared.kind === 'cancelled') {
        if (remoteOptimisticPumps.get(sessionId) !== run) return;
        continue;
      }
      if (prepared.kind === 'failed') {
        settleRemoteOptimisticFailure(sessionId, record.queued.clientId, prepared.error);
        continue;
      }
      const result = await dispatchRemoteOptimisticSend(sessionId, record);
      if (result.kind === 'deferred') return;
      if (result.kind === 'retry') continue;
      // A DB ACK may retire this record before its invoke response arrives. That
      // cancellation settles only the current item; later FIFO entries still need
      // the active pump to dispatch them deterministically. A clear/owner boundary,
      // however, detaches the old pump so it cannot race a newer generation.
      if (result.kind === 'cancelled') {
        if (remoteOptimisticPumps.get(sessionId) !== run) return;
        continue;
      }
      if (result.kind === 'failed') {
        settleRemoteOptimisticFailure(sessionId, record.queued.clientId, result.error);
        continue;
      }
    }
  })().finally(() => {
    if (remoteOptimisticPumps.get(sessionId) === run) remoteOptimisticPumps.delete(sessionId);
  });
  remoteOptimisticPumps.set(sessionId, run);
  return run;
}

function pumpRemoteOptimisticSendsAfterCurrent(sessionId: string): void {
  const existing = remoteOptimisticPumps.get(sessionId);
  if (!existing) {
    void pumpRemoteOptimisticSends(sessionId);
    return;
  }
  const clearGenerationAtSchedule = rendererClearGenerationBySession.get(sessionId) ?? 0;
  const dataOwnerAtSchedule = getDataOwnerGeneration();
  const rerunIfCurrent = () => {
    if (!isDataOwnerGenerationCurrent(dataOwnerAtSchedule)) return;
    if ((rendererClearGenerationBySession.get(sessionId) ?? 0) !== clearGenerationAtSchedule) {
      return;
    }
    void pumpRemoteOptimisticSends(sessionId);
  };
  void existing.then(rerunIfCurrent, rerunIfCurrent);
}

/**
 * 会直接触发 Agent 工作的 input 操作统一入口。与纯投影操作分开，避免 setExpanded / 清锁
 * 等内部收尾在切换期间被拒后残留状态；compact / retry / resume 这类用户派发则从 RPC
 * 发起前直到 settle 全程占住发送 token，保持点击顺序。
 */
function runAgentDispatchProjectionOperation(
  sessionId: string,
  invoke: (input: RoutableMaker['input']) => Promise<AgentInputProjection>,
): Promise<{ applied: boolean; projection: AgentInputProjection }> {
  return withAgentSendDispatch(
    sessionId,
    () => Promise.reject(new Error('Agent switch is still in progress')),
    () => runInputProjectionOperation(sessionId, invoke),
  );
}

/**
 * 会话消息切片的代际号:整体重置切片的路径递增——reloadMessages(rewind / origin
 * 漂移重载)、clearSessionAfterGuard(/clear)、_purgeSession(删除 / 归档 / LRU 驱逐)、
 * dropMessagesFromClientId(edit-last 截断)、removeMessagesByClientIds(分组删除)、
 * _trimMessagesIfNeeded(超长裁剪)、_demoteIdleSessions(空闲降级)、
 * reconcileRemoteMessages 的权威重建分支(远程对账翻满上限仍未接回已知区段)。
 * 判据只有一条:**这次改动是否换掉了窗口整体或 oldestMessageId** —— 换了就必须 bump,
 * 并由这条路径自己释放分页锁(被作废的请求分辨不出锁属于哪一代,不会代清)。
 * loadOlderMessages 的追页循环在发起时快照代际,提交前比对——不一致说明
 * 追页期间切片已被整体重置,拉回的窗口作废(只复位 spinner,不把可能已软删的行
 * merge 回刚清空的 slice)。追页循环把竞态窗口从 1 次 RTT 拉长到最多 10 次
 * (隧道下可达数秒),这层守卫随之补上(subagent review 记录的既有竞态类别)。
 * purge 时保留条目(bump 而非 delete)是**有意**的:删掉会让"捕获 0 → purge → 重建后仍是 0"
 * 的路径误判为未变。代价是这张表随本进程见过的 sessionId 单调增长(每条一个 number),
 * 上界是历史会话数 —— 拿不回来,但也换不掉:删条目就等于放弃这层守卫。
 */
const _messagesEpoch = new Map<string, number>();

function bumpMessagesEpoch(sessionId: string): void {
  _messagesEpoch.set(sessionId, (_messagesEpoch.get(sessionId) ?? 0) + 1);
}

/**
 * 作废当前逻辑历史窗口:既让在途分页不能提交回旧窗口,也让下一次挂载重新获得自动
 * 补载预算。在真正替换当前窗口的路径中,纯内存 trim 是唯一例外——它正是要保留
 * “这个窗口已经自动补过”的事实,避免切回会话后重复拉同一段历史,所以仍只调用
 * bumpMessagesEpoch。
 */
function invalidateMessageHistoryWindow(sessionId: string): void {
  bumpMessagesEpoch(sessionId);
  resetSessionAutomaticHistoryLoadCompletion(sessionId);
}

function isCurrentHistoryFetch(
  sessionId: string,
  token: number,
  origin: string | undefined,
  epoch: number,
): boolean {
  return (
    sessions.has(sessionId) &&
    _historyFetchToken.get(sessionId) === token &&
    (_messagesEpoch.get(sessionId) ?? 0) === epoch &&
    remoteProjectsStore.getSessionDeviceId(sessionId) === origin
  );
}

/** 只释放仍属于这次请求的首拉占用,不误伤 reload 后已经接管的新请求。 */
function releaseHistoryFetchIfCurrent(sessionId: string, token: number): void {
  if (_historyFetchToken.get(sessionId) === token) {
    _historyFetchInFlight.delete(sessionId);
  }
}

/**
 * 释放一条被代际作废的首拉,并在没有新请求接管时补发当前代的首拉。
 *
 * 消息删除 / clear / trim 等路径会 bump `_messagesEpoch` 令在途响应失效,但它们
 * 不一定会主动重载。若这里仅释放 in-flight 占用,会留下 historyLoaded=false 的
 * 会话,而挂载中的视图不会再次触发 ensureInitialMessages。只有这次请求仍持有
 * token、代际确实变化、会话仍存在且没有其它请求接管时才重试,避免与 reload / purge
 * 或新一轮首拉重复发起。
 */
function retryInvalidatedInitialHistoryFetchIfNeeded(
  sessionId: string,
  token: number,
  origin: string | undefined,
  epoch: number,
): void {
  const ownsFetch = _historyFetchToken.get(sessionId) === token;
  const epochChanged = (_messagesEpoch.get(sessionId) ?? 0) !== epoch;
  const originUnchanged = remoteProjectsStore.getSessionDeviceId(sessionId) === origin;
  releaseHistoryFetchIfCurrent(sessionId, token);
  if (!ownsFetch || !epochChanged || !originUnchanged || !sessions.has(sessionId)) return;
  const state = sessions.get(sessionId);
  if (!state || state.historyLoaded || _historyFetchInFlight.has(sessionId)) return;
  ensureInitialMessages(sessionId);
}

/**
 * DB sessions.agent_kind('cc' / 'codex' / 'pi')→ maker-core AgentKind 的唯一映射点。
 * 缺失 / 异常值走 fallback(默认 'claude-code',老 row 兼容)。所有从 session
 * row 派生 agentKind 的地方必须走这里,不要在调用点手写三元(历史上多处各写
 * 一份,遗漏 fallback 语义差异被 review 逐个揪出)。
 */
function dbAgentKindToMakerKind(
  dbKind: string | null | undefined,
  fallback: 'claude-code' | 'codex' | 'pi' = 'claude-code',
): 'claude-code' | 'codex' | 'pi' {
  if (dbKind === 'codex') return 'codex';
  if (dbKind === 'cc') return 'claude-code';
  if (dbKind === 'pi') return 'pi';
  return fallback;
}

/**
 * 已发起过冷缓存 hydrate 的会话(每次"从空切片开始加载"只 hydrate 一次)。
 * fresh 首拉落地时清条目 —— 之后若切片被整体重置(rewind / origin 漂移重载)且缓存
 * 仍然有效,下一轮 ensureInitialMessages 可以再借它一次。
 */
const _cacheHydrateStarted = new Set<string>();

/**
 * 「这个会话的盘上缓存已经过期,在权威数据回来之前一律不许 hydrate」。
 *
 * 与 `_cacheHydrateStarted` 的区别是**粘滞**:rewind 之类的作废式重载之后,如果紧随的
 * 权威首拉失败(被控端离线),`_cacheHydrateStarted` 会被放开以便下次重试,而缓存本身仍是
 * rewind 之前的旧窗口 —— 那时重挂会话就会把已经被软删的消息重新画上去(review: codex P1)。
 * 只有权威响应真正落地(它同时会刷新盘上缓存)才解除。
 */
const _cacheHydrateSuppressed = new Set<string>();

/**
 * 远程会话:从本地冷缓存乐观 hydrate 最近一页(并行于 fresh 首拉)。
 *
 * 只在**切片仍为空且 fresh 还没落地**时种入,种入的行打 `cacheHydrated` 标记,
 * 由首拉落地时整批换掉。刻意不动 `historyLoaded` / `oldestMessageId`,并把
 * `hasMoreMessages` 留在 false:缓存窗口通常只活几百毫秒(fresh 到达前),
 * 拿缓存的游标去翻页会和随后落地的权威窗口打架(见首拉里孤岛游标那段);
 * 被控端离线时也不该发出注定失败的隧道翻页请求。
 *
 * 本机会话不参与:它的历史就在本机 SQLite,读它本来就是即时的。
 */
function hydrateRemoteMessagesFromCache(sessionId: string): void {
  const deviceId = remoteProjectsStore.getSessionDeviceId(sessionId);
  if (!deviceId) return;
  const epochAtStart = _messagesEpoch.get(sessionId) ?? 0;
  const isCurrentHydration = () =>
    sessions.has(sessionId) && (_messagesEpoch.get(sessionId) ?? 0) === epochAtStart;
  // 作废式重载(rewind)之后盘上那份是过期窗口:权威数据没落地之前一律不借。
  if (_cacheHydrateSuppressed.has(sessionId)) return;
  if (_cacheHydrateStarted.has(sessionId)) return;
  _cacheHydrateStarted.add(sessionId);
  void readCachedMessages(deviceId, sessionId).then((rows) => {
    if (!isCurrentHydration()) return;
    if (rows.length === 0) return;
    // 缓存页整页都是"渲染后不留可见锚点"的行(orphan tool_result / 隐藏 thinking /
    // 合成指令行)时**不种入**:mapServerMessages 会产出非空数组,但 MessageStream 渲染 0 项,
    // 而 CCAgentSessionView 又会因 messages 非空而收起 loading 覆盖层 —— 被控端离线时
    // 就是一片永久空白(review: codex P1)。这种页对首屏没有价值,让 loading 照常显示、
    // 交给 fresh 首拉的 no-anchor-backfill 往前翻页处理。
    const mapped = mapServerMessages(rows).map((message) => ({
      ...message,
      cacheHydrated: true as const,
    }));
    if (rows.every(isNonAnchorHistoryRow) && getLatestMessageTodoState(mapped).insertion === null) {
      return;
    }
    if (mapped.length === 0) return;
    // 读缓存这一跳期间归属可能已经变了:设备被移除(mapping 消失)或会话换到了另一台设备。
    // 只看 chat state 挡不住这种情况 —— 于是 A 设备的历史会被种进一个已经不属于 A 的会话,
    // 而新的权威首拉若离线失败,屏上留着的就是**另一台机器**的消息(review: codex P1)。
    // 与写缓存那侧同一条纪律:落地前重核归属。
    if (remoteProjectsStore.getSessionDeviceId(sessionId) !== deviceId) return;
    // 抑制标记也要在**落地前**再看一眼:这次读是在 rewind 之前发起的,而 rewind 期间
    // 切片被清空并置了抑制 —— 只在入口检查挡不住这笔在途的读,它会把 rewind 之前的行
    // 插进刚清空的切片,权威首拉再失败就一直留在屏上(review: codex P1)。
    if (_cacheHydrateSuppressed.has(sessionId)) return;
    if (!isCurrentHydration()) return;
    setState(sessionId, (s) => {
      // fresh 已经落地 / 期间已有实时消息进来 → 缓存没有价值了,原样返回不动切片。
      if (s.historyLoaded || s.messages.length > 0) return s;
      // hasMoreMessages 显式压成 false:缓存窗口期间不许向上翻页。翻回来的权威老行
      // 不带 cacheHydrated,首拉落地剔除缓存行后会在窗口中间留出一段洞,得靠后续翻页
      // 才收敛。首拉通常几百毫秒就到并写回真实的 hasMore,压掉这段的代价近乎为零。
      return { ...s, messages: mapped, hasMoreMessages: false };
    });
  });
}

/**
 * fresh 首拉**落地**:放开 hydrate 守卫(切片此后由权威数据主导),粘滞抑制也一并解除 ——
 * 权威响应到达时缓存已被同一条链刷新过(见 makerTransport 的写点),不再是过期窗口。
 */
/**
 * 权威侧作废了这个远程会话的历史(/clear、删消息、rewind 与 edit-last 截断):
 *  1. 置粘滞抑制 —— 在途的 `readCachedMessages` 回调会在落地前再查一次它,不会把刚被删掉
 *     的行插回空切片。这些路径都**不会**触发最新页重拉,没有"权威接管"来纠正
 *     (review: codex P1);
 *  2. 清盘 —— 进程内标记跨重启就没了,盘上那份必须一起消失。
 * 本机会话没有缓存,直接 no-op。
 */
function invalidateRemoteMessageCache(sessionId: string, pinnedDeviceId?: string): void {
  const deviceId =
    pinnedDeviceId ??
    getStickySessionDeviceId(sessionId) ??
    remoteProjectsStore.getSessionDeviceId(sessionId);
  if (!deviceId) return;
  _cacheHydrateStarted.add(sessionId);
  _cacheHydrateSuppressed.add(sessionId);
  clearCachedMessages(deviceId, sessionId);
}

function settleCacheHydration(sessionId: string): void {
  _cacheHydrateStarted.delete(sessionId);
  _cacheHydrateSuppressed.delete(sessionId);
}

/**
 * fresh 首拉**失败**(典型:被控端离线):只放开「本轮已发起」的守卫以便下次重试,
 * **不解除**粘滞抑制 —— 缓存过期这件事不会因为一次失败的请求而改变。
 */
function releaseCacheHydrationAfterFailure(sessionId: string): void {
  _cacheHydrateStarted.delete(sessionId);
}

function ensureInitialMessages(sessionId: string): void {
  const state = getOrCreateState(sessionId);
  requestInputProjection(sessionId);
  // Prefetch and other non-mounted callers still create a cache entry. Give
  // that entry the same bounded lifetime as a viewed session so a cancelled
  // navigation cannot leave messages permanently exempt from soft eviction.
  if (!_activeViewSessions.has(sessionId)) {
    _lastViewedAt.set(sessionId, Date.now());
    _ensureDemoteTimer();
  }
  if (state.historyLoaded) return;
  if (_historyFetchInFlight.has(sessionId)) return;
  const historyEpochAtStart = _messagesEpoch.get(sessionId) ?? 0;
  const historyOriginAtStart = remoteProjectsStore.getSessionDeviceId(sessionId);
  const historyFetchToken = ++_nextHistoryFetchToken;
  _historyFetchToken.set(sessionId, historyFetchToken);
  const isCurrentHistoryLoad = () =>
    isCurrentHistoryFetch(sessionId, historyFetchToken, historyOriginAtStart, historyEpochAtStart);
  // 行水合并行异步读的陈旧性守卫: fetch 启动时定格 rev, 应用时比对(见 planModeRev)。
  const planModeRevAtFetchStart = state.planModeRev;

  // Mark in-flight to prevent concurrent callers from double-fetching.
  // historyLoaded stays false until data actually arrives.
  _historyFetchInFlight.add(sessionId);
  // 记录本次加载所依据的 origin(可能 undefined)。remote-projects 注入该会话来源后,
  // reconcileOpenSessionOrigins 比对此值发现漂移 → 重载(见上方说明)。
  _historyLoadOrigin.set(sessionId, historyOriginAtStart);

  // 远程会话:与 fresh 首拉**并行**从冷缓存乐观 hydrate,让冷启动 / 被控端离线时
  // 立刻看到上次看到的最近一页(而不是空白 + spinner)。不设 historyLoaded ——
  // fresh 仍在路上,它落地时会把这些 cacheHydrated 行整批剔掉再 merge(见下方两个提交分支)。
  hydrateRemoteMessagesFromCache(sessionId);

  // Seed sdkSessionId from the server so resume works on app restart.
  // device-link 远程 session 经隧道读被控端 row(本地 DB 没有,直接 get 会 404)。
  getSessionFor(sessionId)
    .then((session) => {
      if (
        !isCurrentHistoryFetch(
          sessionId,
          historyFetchToken,
          historyOriginAtStart,
          historyEpochAtStart,
        )
      ) {
        // The history list owns the shared in-flight guard and will settle the
        // invalidated generation. Do not release it while that request is still
        // pending, otherwise a caller could start a second initial fetch beside it.
        return;
      }
      setState(sessionId, (s) => {
        const updates: Partial<SessionChatState> = {};
        // agentKind 是真实 reducer 路由,始终跟随 DB；乐观切换展示单独放在
        // agentSwitchIntent,两者不能混槽。
        const nextAgentKind = dbAgentKindToMakerKind(session.agentKind);
        if (s.agentKind !== nextAgentKind) {
          updates.agentKind = nextAgentKind;
        }
        // Remote codex target (P2): restore from DB so lazy-create after
        // restart routes back to the same remote machine.
        const nextRemoteHostId = session.remoteHostId ?? null;
        if (s.remoteHostId !== nextRemoteHostId) {
          updates.remoteHostId = nextRemoteHostId;
        }
        if (session.sdkSessionId && s.sdkSessionId !== session.sdkSessionId) {
          updates.sdkSessionId = session.sdkSessionId;
        }
        // Restore persisted fastMode so FastToggle reflects the DB state on session switch / restart.
        if (session.fastMode !== undefined && s.fastMode !== session.fastMode) {
          updates.fastMode = session.fastMode;
        }
        // 计划模式同 fastMode: 从 DB 恢复, 让「+」菜单勾选态 / chip 跨切换与重启保持。
        // rev 守卫: fetch 期间发生过本地写入(典型: pending 首发已消耗一次性勾选)
        // 时,读回的行值陈旧,丢弃 —— 防止刚被消耗的勾选被复燃(bot review P2)。
        if (
          session.planModeEnabled !== undefined &&
          s.planModeRev === planModeRevAtFetchStart &&
          s.planModeEnabled !== session.planModeEnabled
        ) {
          updates.planModeEnabled = session.planModeEnabled;
        }
        // 重启 / session 切换时从 DB 恢复 cost + context 进圆环。
        // tokenUsage 不恢复 —— 它是 per-turn 内存值, 新 session 打开就该归 0,
        // 显示"上一 turn 残留" UI 上是误导 (用户决策, sessions.total_token_usage 列保留但停用)。
        if (
          session.contextTokens > 0 ||
          session.contextWindow > 0 ||
          (session.totalCostUsd ?? 0) > 0
        ) {
          updates.agentStatus = {
            ...s.agentStatus,
            costUsd: session.totalCostUsd ?? s.agentStatus.costUsd,
            contextTokens: session.contextTokens || s.agentStatus.contextTokens,
            contextWindow: session.contextWindow || s.agentStatus.contextWindow,
          };
        }
        return Object.keys(updates).length > 0 ? { ...s, ...updates } : s;
      });
    })
    .catch((err) => {
      if (
        !isCurrentHistoryFetch(
          sessionId,
          historyFetchToken,
          historyOriginAtStart,
          historyEpochAtStart,
        )
      ) {
        // See the resolve branch above: let listMessagesFor settle the shared
        // initial-fetch guard and decide whether the current generation retries.
        return;
      }
      const ipcError = extractIpcError(err);
      if (ipcError?.code === 'NOT_FOUND') {
        log.debug('session metadata unavailable during initial routing', ipcError.code);
      } else {
        log.warn('Failed to fetch session for sdkSessionId:', err);
      }
    });

  listMessagesFor(sessionId)
    .then(async (existing) => {
      if (
        !isCurrentHistoryFetch(
          sessionId,
          historyFetchToken,
          historyOriginAtStart,
          historyEpochAtStart,
        )
      ) {
        retryInvalidatedInitialHistoryFetchIfNeeded(
          sessionId,
          historyFetchToken,
          historyOriginAtStart,
          historyEpochAtStart,
        );
        return;
      }
      if (existing.length === 0) {
        if (
          !isCurrentHistoryFetch(
            sessionId,
            historyFetchToken,
            historyOriginAtStart,
            historyEpochAtStart,
          )
        ) {
          retryInvalidatedInitialHistoryFetchIfNeeded(
            sessionId,
            historyFetchToken,
            historyOriginAtStart,
            historyEpochAtStart,
          );
          return;
        }
        // 权威侧确认这个会话没有可见消息(被控端 /clear、rewind 到头、消息被删干净)。
        // 冷缓存 hydrate 出来的行必须在这里一并抹掉,否则控制端会一直显示被清掉的正文。
        // 盘上那份不用在这里单独删:listMessagesFor 的写点收到空页时就把缓存清了。
        settleCacheHydration(sessionId);
        if (!isCurrentHistoryLoad()) return;
        setState(sessionId, (s) => ({
          ...s,
          messages: s.messages.some((m) => m.cacheHydrated === true)
            ? s.messages.filter((m) => m.cacheHydrated !== true)
            : s.messages,
          historyLoaded: true,
          hasMoreMessages: false,
        }));
        _historyFetchInFlight.delete(sessionId);
        // 历史加载完 → 重建当前挂起交互(新窗口/重连/刷新打开时面板才会出现)。
        void reconcilePendingInteractions(sessionId, isCurrentHistoryLoad).catch(() => undefined);
        return;
      }

      // no-anchor / plan-boundary backfill: 初始页若全是"渲染后不留可见锚点"的行,映射结果就是空列表,
      // 而 MessageStream 在 visibleRenderItems.length === 0 时不触发自动翻页 —— 结果是
      // DB 里有 2000+ 条消息,重启后 ChatView 渲染 0 项,看起来"内容消失了"。
      // 四类命中(见 isNonAnchorHistoryRow):
      //   - 全是 tool_result:配对的 tool_use 父消息在更老的页里,orphan 会被丢弃;
      //   - 全是被隐藏的 thinking 行:如一轮搜索密集、在产出可见正文前就失败的会话,
      //     最新 50 行可能全是加密推理;
      //   - 计划工具行:计划只在输入框上方的胶囊呈现,不在消息流中留锚点;
      //   - 合成指令行:渲染 null,混在这些行里同样撑不出可见锚点。
      //
      // PinnedPlanPanel 的唯一数据源同样是当前消息窗口。计划工具行不再在消息流中渲染,
      // 所以冷开超过一页的会话时,如果最近一次 plan 在更早页,胶囊会直接消失。这里也继续
      // 往前翻到最近 plan 边界,保证初始窗口能派生当前计划快照。
      //
      // 无锚点按 10 页(500 行)兜底。计划胶囊分两段:
      //   - 当前窗口没有任何计划事件时,最多探测 10 页,避免从未使用计划的长会话全量拉历史;
      //   - 已看到计划事件但最新 TaskUpdate 还缺创建/列表边界时,最多再补 10 页。
      let merged: Message[] = existing;
      let oldestRow = oldestMessageRow(merged, 'newest-first');
      if (!oldestRow) {
        if (
          !isCurrentHistoryFetch(
            sessionId,
            historyFetchToken,
            historyOriginAtStart,
            historyEpochAtStart,
          )
        ) {
          retryInvalidatedInitialHistoryFetchIfNeeded(
            sessionId,
            historyFetchToken,
            historyOriginAtStart,
            historyEpochAtStart,
          );
          return;
        }
        setState(sessionId, (s) => ({
          ...s,
          historyLoaded: true,
          hasMoreMessages: false,
        }));
        _historyFetchInFlight.delete(sessionId);
        void reconcilePendingInteractions(sessionId).catch(() => undefined);
        return;
      }
      let hasMore = serverMessagePageHasMore(existing);
      const MAX_NO_ANCHOR_BACKFILL_PAGES = 10;
      const MAX_PLAN_DISCOVERY_BACKFILL_PAGES = 10;
      const MAX_PLAN_RESOLUTION_BACKFILL_PAGES = 10;

      // Make the newest page visible as soon as it arrives. `historyLoaded`
      // deliberately remains false until the optional anchor/plan backfill is
      // complete: several consumers use that flag to gate remote reconciliation
      // and resume/restore side effects. `isLoadingMore` is the shared lock that
      // keeps user-triggered pagination from racing this background backfill.
      const initialHasVisibleAnchor = existing.some((row) => !isNonAnchorHistoryRow(row));
      const initialPlanState = historyRowsPlanBackfillState(existing, hasMore);
      const initialNeedsBackfill =
        hasMore &&
        (existing.every(isNonAnchorHistoryRow) ||
          !initialPlanState.hasPlanEvent ||
          !initialPlanState.isResolved);
      if (initialHasVisibleAnchor) {
        const initialMapped = mapServerMessages(existing);
        const initialOldestId = oldestRow.id;
        settleCacheHydration(sessionId);
        setState(sessionId, (s) => ({
          ...s,
          // Keep historyLoaded=false until the full initial window is ready;
          // MessageStream renders this fresh page directly from `messages`.
          historyLoaded: false,
          messages: mergeMessages(
            initialMapped,
            s.messages.some((m) => m.cacheHydrated === true)
              ? s.messages.filter((m) => m.cacheHydrated !== true)
              : s.messages,
            {},
            'newest-first',
          ),
          isFirstMessage: false,
          oldestMessageId:
            s.historyWindowHasIsland === true
              ? initialOldestId
              : (oldestServerMessageIdForWindow(
                  existing,
                  s.messages,
                  s.oldestMessageId,
                  'newest-first',
                ) ?? initialOldestId),
          hasMoreMessages: hasMore,
          isLoadingMore: initialNeedsBackfill,
        }));
      } else if (initialNeedsBackfill) {
        // The newest page has no renderable anchor, so there is nothing useful
        // to publish yet. Still acquire the shared pagination lock before the
        // first background await: a stale/local-only row may already give
        // loadOlderMessages a cursor, and it must not race this backfill.
        setState(sessionId, (s) => ({ ...s, isLoadingMore: true }));
      }
      let pagesFetched = 0;
      let planResolutionPagesFetched = 0;
      while (hasMore) {
        if (!isCurrentHistoryLoad()) return;
        const needsAnchorBackfill =
          merged.every(isNonAnchorHistoryRow) && pagesFetched < MAX_NO_ANCHOR_BACKFILL_PAGES;
        const planState = historyRowsPlanBackfillState(merged, hasMore);
        const needsPlanResolution =
          planState.hasPlanEvent &&
          !planState.isResolved &&
          planResolutionPagesFetched < MAX_PLAN_RESOLUTION_BACKFILL_PAGES;
        const needsPlanBackfill = planState.hasPlanEvent
          ? needsPlanResolution
          : pagesFetched < MAX_PLAN_DISCOVERY_BACKFILL_PAGES;
        if (!needsAnchorBackfill && !needsPlanBackfill) break;

        pagesFetched += 1;
        if (needsPlanResolution) planResolutionPagesFetched += 1;
        try {
          const older = await listMessagesFor(sessionId, {
            limit: 50,
            before: oldestRow.id,
          });
          if (
            !isCurrentHistoryFetch(
              sessionId,
              historyFetchToken,
              historyOriginAtStart,
              historyEpochAtStart,
            )
          ) {
            retryInvalidatedInitialHistoryFetchIfNeeded(
              sessionId,
              historyFetchToken,
              historyOriginAtStart,
              historyEpochAtStart,
            );
            return;
          }
          if (older.length === 0) {
            hasMore = false;
            break;
          }
          merged = [...merged, ...older];
          oldestRow = oldestMessageRow(merged, 'newest-first') ?? oldestRow;
          hasMore = serverMessagePageHasMore(older);
        } catch (err) {
          log.warn('no-anchor history backfill failed', err);
          break;
        }
      }

      // perf/session-switch 探针纯诊断:整段测量走 import.meta.env.DEV,生产
      // 构建里 Vite 把常量折成 false 后 dead-code 消除,零开销。
      const ingestStartMs = import.meta.env.DEV ? performance.now() : 0;
      if (
        !isCurrentHistoryFetch(
          sessionId,
          historyFetchToken,
          historyOriginAtStart,
          historyEpochAtStart,
        )
      ) {
        retryInvalidatedInitialHistoryFetchIfNeeded(
          sessionId,
          historyFetchToken,
          historyOriginAtStart,
          historyEpochAtStart,
        );
        return;
      }
      const mapped = mapServerMessages(merged);
      const oldestId = oldestRow.id;
      settleCacheHydration(sessionId);
      if (!isCurrentHistoryLoad()) return;
      setState(sessionId, (s) => ({
        ...s,
        historyLoaded: true,
        // Merge: keep any messages already appended by streaming events
        // (unlikely here since we gate history load on first mount, but
        // preserves slice invariants).
        //
        // 冷缓存 hydrate 的行先**整批剔除**再 merge:mergeMessages 只增不删,权威页里
        // 已经不存在的缓存行(被控端 /clear、rewind、删消息)否则会永久留在窗口里。
        // 仍在权威页里的那些会由 mapped 原样带回来,不会闪。
        messages: mergeMessages(
          mapped,
          s.messages.some((m) => m.cacheHydrated === true)
            ? s.messages.filter((m) => m.cacheHydrated !== true)
            : s.messages,
          {},
          'newest-first',
        ),
        isFirstMessage: false,
        // 窗口里掺着跳转孤岛时,**本页的下沿**接管游标,不再取"两者中更老的那个"。
        //
        // 序列(#676 review codex P1):会话刚打开就直接深跳,首拉还没回来 → 补齐无从下手、
        // 退回 around 孤岛并用孤岛下沿播种游标(那时窗口里只有孤岛,只能这么播)。随后首拉
        // 的最新页落地,若仍保留更老的孤岛游标,缺失区间恰好比它**更新**:普通向上翻页与
        // 孤岛感知重试都只会请求比孤岛更老的行,那段洞永远拉不回来,除非整会话重载。
        // 换成最新页下沿后,往上翻会一页页穿过那段洞,补齐也能真正命中目标并自愈。
        //
        // 孤岛标记**不清**:洞还在,直到翻页真的把它填上。
        oldestMessageId:
          s.historyWindowHasIsland === true
            ? oldestId
            : (oldestServerMessageIdForWindow(
                merged,
                s.messages,
                s.oldestMessageId,
                'newest-first',
              ) ?? oldestId),
        hasMoreMessages: hasMore,
        isLoadingMore: false,
      }));
      if (import.meta.env.DEV) {
        const ingestDurMs = performance.now() - ingestStartMs;
        if (ingestDurMs >= 30) {
          perfLog.debug(
            `history:ingest sid=${sessionId} rows=${merged.length} dur=${Math.round(ingestDurMs)}ms`,
          );
        }
      }
      _historyFetchInFlight.delete(sessionId);
      // 历史加载完 → 重建当前挂起交互:历史里被转 expired 的 ask/plan 在此翻回 pending
      // (按 requestId 去重,不重复),permission 重新置 pendingPermission。
      void reconcilePendingInteractions(sessionId, isCurrentHistoryLoad).catch(() => undefined);
    })
    .catch(() => {
      if (
        !isCurrentHistoryFetch(
          sessionId,
          historyFetchToken,
          historyOriginAtStart,
          historyEpochAtStart,
        )
      ) {
        retryInvalidatedInitialHistoryFetchIfNeeded(
          sessionId,
          historyFetchToken,
          historyOriginAtStart,
          historyEpochAtStart,
        );
        return;
      }
      // Allow retry on next mount
      _historyFetchInFlight.delete(sessionId);
      _historyFetchToken.delete(sessionId);
      // 首拉失败(典型:被控端离线)→ 放开「本轮已发起」的守卫以便下次重试,但**不解除**
      // rewind 之类的粘滞抑制(见 releaseCacheHydrationAfterFailure)。屏上已 hydrate 的
      // 缓存行**保持不动**:离线时它是用户唯一能看到的历史,清掉纯属倒退。
      releaseCacheHydrationAfterFailure(sessionId);
      setState(sessionId, (s) => ({ ...s, historyLoaded: false }));
    });
}

/**
 * rewind-session: force-reload the message slice from server after a rewind
 * commit. Server already soft-deleted (rewind_at) the truncated rows and the
 * messages.list IPC filters them out, so a fresh fetch yields the truncated
 * view automatically. Resets pagination cursors and isStreaming flags so the
 * slice looks like a clean session (re-)open.
 */
function reloadMessages(sessionId: string, opts?: { allowCacheHydrate?: boolean }): void {
  discardPendingTextDelta(sessionId);
  // 代际递增:作废 in-flight 的 loadOlderMessages 追页窗口(见 _messagesEpoch 注释)。
  invalidateMessageHistoryWindow(sessionId);
  invalidateHistoryFetch(sessionId);
  // Drop the in-flight guard so ensureInitialMessages can run again.
  _historyFetchInFlight.delete(sessionId);
  _historyFetchToken.delete(sessionId);
  // 默认**不借**冷缓存:rewind 截断这类重载的起因恰恰意味着盘上那份缓存已经过期,
  // hydrate 它只会先闪一下刚被截掉的消息。重载后的首拉照常刷新缓存。
  //
  // 例外是启动竞速里的 origin 解析重载(undefined → deviceId):那次重载并没有让缓存
  // 过期,反而是这个会话**第一次**知道自己是远程会话。压着不 hydrate 的话,被控端离线时
  // 首拉必然失败,屏上就只剩空白 + spinner —— 而离线可见正是这份缓存的存在理由
  // (review: codex P1)。调用方据此显式放开(见 reconcileOpenSessionOrigins)。
  if (opts?.allowCacheHydrate) {
    _cacheHydrateStarted.delete(sessionId);
    _cacheHydrateSuppressed.delete(sessionId);
  } else {
    _cacheHydrateStarted.add(sessionId);
    // 粘滞:即使紧随的权威首拉失败(被控端离线),重挂会话也不许再借那份过期缓存。
    _cacheHydrateSuppressed.add(sessionId);
    // 但粘滞标记只活在**本进程**里:rewind 之后权威首拉失败、用户直接退出 app,重启后
    // 标记没了而盘上那份还是 rewind 之前的窗口 —— 下次离线冷启动照样 hydrate 出已被软删
    // 的消息(review: codex P1)。所以同时把盘上那份清掉:缓存是纯优化,重载后的首拉
    // 成功时会重新写上。
    invalidateRemoteMessageCache(sessionId);
  }
  setState(sessionId, (s) => {
    const optimisticRecords = remoteOptimisticSendRecords(sessionId);
    const optimisticMessages = optimisticRecords
      ? s.messages.filter(
          (message) => message.isPendingPersist === true && optimisticRecords.has(message.clientId),
        )
      : [];
    return {
      ...s,
      // Origin reconciliation may reload history immediately after the local
      // outbox projects a bubble (for example when auto-title preview notifies
      // remoteProjectsStore). Preserve those unacknowledged local rows while
      // the authoritative history window resets.
      messages: optimisticMessages,
      taskUpdates: new Map(),
      pendingTaskWake: false,
      historyLoaded: false,
      hasMoreMessages: false,
      oldestMessageId: null,
      isStreaming: false,
      // 窗口从最新重新拉起 → 不再有孤岛。
      historyWindowHasIsland: false,
      // 分页锁归本次重置释放:窗口和游标都清了,in-flight 的翻页 / 跳转补齐也已被上面的
      // bumpMessagesEpoch 作废,锁再留着只会让行首守卫卡住下一次翻页。由这里清而不是
      // 让被作废的请求代清 —— 它们无法分辨锁是自己那一代的还是重置后新代际的(#676 review)。
      isLoadingMore: false,
    };
  });
  ensureInitialMessages(sessionId);
}

/** 消息菜单删除的本地镜像：移除本动作覆盖的 clientId，并清掉关联的 live task 别名。 */
function removeMessagesByClientIds(
  sessionId: string,
  clientIds: readonly string[],
  options: { invalidateHistory?: boolean } = {},
): void {
  const deletedClientIds = new Set(clientIds.filter(Boolean));
  if (deletedClientIds.size === 0) return;
  // 远程会话:删消息(菜单删除镜像 / 被控端 messages:deleted 推送)**不会**触发"最新页"
  // 重拉 —— 那是唯一的写缓存路径。盘上那份还带着刚被删掉的行,此刻退出 app,下次离线冷
  // 启动就把它 hydrate 回来(review: codex P1)。缓存是纯优化,清掉即可(下一次成功的
  // 最新页拉取会重新写上)。
  invalidateRemoteMessageCache(sessionId);
  discardPendingTextDelta(sessionId);
  // 作废删除提交前发起的历史分页，避免旧页响应把已经清除的行重新 merge 回来。
  if (options.invalidateHistory !== false) invalidateMessageHistoryWindow(sessionId);
  setState(sessionId, (s) => {
    const removedMessages = s.messages.filter((message) => deletedClientIds.has(message.clientId));
    const messages = s.messages.filter((message) => !deletedClientIds.has(message.clientId));
    const deletedTaskAliases = new Set<string>(deletedClientIds);
    for (const message of removedMessages) {
      if (message.toolUseId) deletedTaskAliases.add(message.toolUseId);
      if (message.parentToolUseId) deletedTaskAliases.add(message.parentToolUseId);
    }
    let taskUpdates = s.taskUpdates;
    if (taskUpdates && taskUpdates.size > 0) {
      const nextTaskUpdates = new Map<string, AgentTaskUpdate>();
      let changed = false;
      for (const [key, task] of taskUpdates) {
        if (
          deletedTaskAliases.has(key) ||
          deletedTaskAliases.has(task.taskId) ||
          (task.parentToolUseId !== undefined && deletedTaskAliases.has(task.parentToolUseId))
        ) {
          changed = true;
          continue;
        }
        nextTaskUpdates.set(key, task);
      }
      if (changed) taskUpdates = nextTaskUpdates;
    }
    // 第四条 epoch-reset 路径:上面 invalidateHistory 时已 bump epoch 作废 in-flight
    // 的翻页 / 跳转补齐,锁同样由本次重置释放。被作废的请求不会代清(它们分辨不出锁
    // 属于哪一代),漏清会让行首守卫把该会话的翻页永久卡住 —— 既有回归
    // 「discards an in-flight paging window after grouped deletion」正守着这条。
    const lockReset = options.invalidateHistory !== false ? { isLoadingMore: false } : {};
    if (messages.length === s.messages.length && taskUpdates === s.taskUpdates) {
      // 删除推送只涉及本渲染层窗口之外的行(典型:另一个窗口 / 设备删的消息)时,本地
      // 没有任何行要移除 —— 但 epoch 已经 bump 了,in-flight 请求照样被作废。这条早退
      // 路径同样必须放锁,否则该会话的翻页与跳转会永久卡住(#676 review)。
      return s.isLoadingMore && options.invalidateHistory !== false ? { ...s, ...lockReset } : s;
    }
    return {
      ...s,
      messages,
      taskUpdates,
      isFirstMessage: !messages.some((message) => message.role === 'user'),
      ...lockReset,
    };
  });
}

/** 旧调用点兼容：精确移除一个 clientId。 */
function removeMessageByClientId(sessionId: string, clientId: string): void {
  removeMessagesByClientIds(sessionId, [clientId], { invalidateHistory: false });
}

/**
 * edit-last-message: 本地裁掉从 clientId(含)开始的所有消息。
 *
 * 编辑最后一条 user 消息 = rewindCommit(后端已把 target 及其之后的行软删)
 * + 立即重发新文本。这里不走 reloadMessages(清空 + 异步重拉会和重发的乐观
 * 气泡竞态,产生"整屏清空→回填"的闪烁,违反视觉连续性),而是按后端软删的
 * 同一语义在内存里确定性裁剪:target 起(含)整段移除,与 rewind.commit 事务的
 * selectRewindMessageIds(createdAt >= target)对齐。clientId 不在列表时 no-op。
 */
function dropMessagesFromClientId(sessionId: string, clientId: string): void {
  // edit-last 已经在权威侧提交了 rewind,而"重发"可能失败(受支持的失败路径)—— 那时不会有
  // 任何最新页拉取来刷新缓存,盘上仍是 rewind 之前的尾巴(review: codex P1)。
  invalidateRemoteMessageCache(sessionId);
  discardPendingTextDelta(sessionId);
  // 代际递增:这是与 reloadMessages / _purgeSession 并列的第三条"切片被本地截断"
  // 路径,同样必须作废 in-flight 的分页 / 跳转补齐。漏 bump 的后果是它们把 rewind
  // 刚软删掉的行当作有效响应 merge 回渲染层(#676 review)。clientId 不在列表时
  // 也照 bump:代价只是让 in-flight 分页重新取一次,比漏作废安全。
  invalidateMessageHistoryWindow(sessionId);
  setState(sessionId, (s) => {
    const idx = s.messages.findIndex((m) => m.clientId === clientId);
    // 目标已经不在切片里(reload / 重开把它清掉了)也必须放锁:上面 bump 过 epoch,
    // in-flight 请求已被作废,而它们刻意不自清 —— 漏这条早退路径同样会让翻页永久卡住
    // (#676 review,与 removeMessagesByClientIds 的 unchanged-state 早退同一形状)。
    if (idx < 0) return s.isLoadingMore ? { ...s, isLoadingMore: false } : s;
    // taskUpdates 必须随裁剪一起重置(对齐 reloadMessages):buildRenderItems
    // 会把「没有匹配到已渲染 tool_use」的 task update 兜底渲染成独立任务卡片,
    // 被裁 turn 的残留 update 会以孤儿卡片的形式回到消息流(bot review P1)。
    // 早于裁剪点的历史任务卡失去 update 后回落为按消息内容渲染——与
    // reloadMessages / 冷启动后的历史渲染同语义,无回归。
    return {
      ...s,
      messages: s.messages.slice(0, idx),
      taskUpdates: new Map(),
      isStreaming: false,
      // 同 reloadMessages / clearSessionAfterGuard:本地截断也是 epoch-reset 路径,
      // 锁由它自己释放。上面已 bump epoch 作废 in-flight 请求,而它们的 finally 会
      // 因 epoch 变化跳过清理(避免误解锁新代际),漏清就会让翻页永久卡住(#676 review)。
      isLoadingMore: false,
    };
  });
}

/**
 * device-link:remote-projects 注入 / 变更会话来源后,把「来源已漂移」的已打开会话
 * 重载一次。典型场景:控制端启动竞速里以 origin=undefined 命中本机空库的远程会话,
 * 待 remoteProjectsStore 注入其 deviceId(undefined→string)后经隧道重载真历史。
 *
 * 仅在来源真正解析 / 改变时重载(current 已定义且与加载时不同):
 *  - 本机会话:current 恒 undefined → 永不触发。
 *  - 已正确加载的远程会话:current === loaded → 普通 patched 推送不误重载。
 *  - 设备下线(current 变 undefined):跳过——视图随即被移除,重载只会命中本机空库。
 * reloadMessages → ensureInitialMessages 会以新 origin 重记 _historyLoadOrigin,
 * 故下一轮 current === loaded,不会自激循环。
 */
function reconcileOpenSessionOrigins(): void {
  for (const sessionId of sessions.keys()) {
    const current = remoteProjectsStore.getSessionDeviceId(sessionId);
    // 即使当前来源暂时为空也要推进 projection 代际:否则 A→断连→A 的 ABA 会让
    // 最初按 A 发起的旧查询在来源恢复后重新通过检查,覆盖恢复后的权威投影。
    const originChange = noteInputProjectionOrigin(sessionId, current);
    if (originChange.changed) {
      bumpInteractionReconcileEpoch(sessionId);
      // 来源变更后旧设备的 owner / capability 都失效。在新来源 projection 回来前
      // fail closed，不能让 B 的历史沿用 A 的精确 owner 或 legacy 兜底。
      setState(sessionId, (state) => ({
        ...state,
        continuationInFlightClientId: null,
        continuationTurnClientId: null,
        continuationInFlightProjectionCapability: 'unknown',
      }));
    }
    if (current === undefined) continue;
    const loaded = _historyLoadOrigin.get(sessionId);
    if (current === loaded) continue;
    // undefined → deviceId 是启动竞速的**首次解析**(上一次首拉命中的是本机空库),
    // 缓存并未因此过期 → 放开 hydrate,让被控端离线时也能看到上次的最近一页。
    // 设备之间真的换了 origin(string → 另一个 string)时不放开:那是另一台机器的历史。
    reloadMessages(sessionId, { allowCacheHydrate: loaded === undefined });
  }
}

/**
 * device-link:对账打开的远程会话消息(host-authoritative heal)。
 *
 * 背景:被控端实时流(maker:event / messages:created)走重 topic `push`,fire-and-forget
 * 有损 —— 断连窗口 / 被控端重启(订阅 registry 清空)/ relay 丢帧都会让某一轮消息静默丢失;
 * 而打开的远程会话首拉(ensureInitialMessages)后只靠 live push 增长、从不补,丢了就永久缺
 * (除非重开)。这里经隧道重拉最近一页,用 mergeMessages 按 clientId **合并去重、保序**地把
 * 被控端有、控制端缺的消息补回(不清空、不闪)。被控端 DB = 单一真相源。
 *
 * 触发源在 useRemoteSessionSync:WS 重连 / 被控端回在线 / turn 结束 / 窗口聚焦 / 手动重新同步。
 *
 * 守卫:
 *  - 仅远程会话(本机会话 push 不丢)→ 本机零回归。
 *  - historyLoaded=false → 交给 ensureInitialMessages,不重复拉。
 *  - isStreaming=true → 跳过(不打断在串的 turn;turn 结束会再触发一次)。
 *    例外:`opts.force`(仅 stall 看门狗在**被控端权威报 not-running 之后**才传)放行 ——
 *    此时 isStreaming 是「卡死残留」而非真在串,必须能补回丢失的终态/消息。
 *  - 无新 clientId → no-op(不产生新数组引用,避免无谓重渲染)。
 */
/**
 * 同一会话的对账**单飞 + 尾随重跑**:已有一次在飞就不再并发第二次,只把"期间又被触发过"记下来,
 * 等这次收尾后补跑一次。
 *
 * 为什么必须单飞:两次对账重叠会产生一整族只有并发才成立的错况 —— 旧那次拿过期的 existingIds
 * 覆盖新窗口、用陈旧快照 hydrate 更新的行、bump 代际清掉别人刚拿到的分页锁、浅重叠的后继把深翻
 * 的前驱整段丢掉、以及"谁解释了这次代际 bump"的出处追踪。#676 的 review 连着七八轮都在这族里:
 * 每加一道谓词(seq / rebuilt / rebuildEpoch / superseded 补交)就长出新的角落。单飞把这族问题
 * 从根上消掉,而不是继续加谓词。
 *
 * 为什么不是"排队":排队会让最新的触发等一次可能长达数秒的隧道翻页。这里是**合并**:第二次触发
 * 不自己跑,而是保证当前这次结束后再跑一次最新的 —— 触发不丢,也不并发。
 *
 * 交互面板重建(reconcilePendingInteractions)照旧立刻跑:它幂等,而 turn 内的权限 / ask / plan
 * 提示必须尽快重建,不能被合并推迟。
 */
const _remoteReconcileInFlight = new Map<
  string,
  { run: Promise<void>; rerun: boolean; rerunForce: boolean }
>();

function reconcileRemoteMessages(sessionId: string, opts?: { force?: boolean }): Promise<void> {
  // 返回完成 promise 供调用方需要时等待;既有调用方均按 fire-and-forget 使用。
  if (!sessionId || !isRemoteSession(sessionId)) return Promise.resolve();
  const inFlight = _remoteReconcileInFlight.get(sessionId);
  if (inFlight) {
    inFlight.rerun = true;
    if (opts?.force) inFlight.rerunForce = true;
    void reconcilePendingInteractions(sessionId).catch(() => undefined);
    return inFlight.run;
  }
  const entry: { run: Promise<void>; rerun: boolean; rerunForce: boolean } = {
    run: Promise.resolve(),
    rerun: false,
    rerunForce: false,
  };
  _remoteReconcileInFlight.set(sessionId, entry);
  entry.run = (async () => {
    try {
      await runRemoteReconcile(sessionId, opts);
    } finally {
      const rerun = entry.rerun;
      const rerunForce = entry.rerunForce;
      // 先摘掉在飞标记,再补跑 —— 补跑会自己建新的 entry,期间来的触发继续被那一份合并。
      _remoteReconcileInFlight.delete(sessionId);
      if (rerun && sessions.has(sessionId)) {
        await reconcileRemoteMessages(sessionId, rerunForce ? { force: true } : undefined);
      }
    }
  })();
  // 显式挂一个吞掉的 rejection handler:返回的 promise 语义不变(仍然会 reject,需要的调用方照样
  // 能 await 到),但 Node / renderer 不再把它当成 unhandled rejection —— 绝大多数调用方是
  // `void makerChatStore.reconcileRemoteMessages(...)` 这种 fire-and-forget(#676 review copilot)。
  // 旧实现靠 `run.then(onOk, onErr)` 顺带完成了这件事,单飞包装接手后必须自己补上。
  void entry.run.catch(() => undefined);
  return entry.run;
}

function runRemoteReconcile(sessionId: string, opts?: { force?: boolean }): Promise<void> {
  // 挂起交互面板重建**无条件先行**,不受下方 isStreaming 守卫约束:turn 内弹出的
  // permission / ask / plan 正是 isStreaming=true 的常见态(pendingPermission 与
  // isRunning 共存),断连重连 / 聚焦时若被守卫吞掉,交互面板不重建、用户无法回应,
  // 会话会卡死。同时它并入下方同步代的完成语义(finally 处 await):needs-interaction
  // 未读的 passive 远程回执必须等提示真实重建后才放行。
  const interactionsSync = reconcilePendingInteractions(sessionId);
  const state = sessions.get(sessionId);
  if (!state || !state.historyLoaded || (state.isStreaming && !opts?.force)) {
    // 消息对账被守卫挡下,但交互重建照跑。为它单独开一代:turn 进行中的
    // needs-interaction 未读,其「内容」就是权限 / ask / plan 提示本身——提示真实
    // 重建(count>0)才算一代完成,挂起的 passive 回执随之放行,不必等 turn 结束。
    // count=0 不上报:isStreaming 可能是终帧丢失的卡死残留(completed 未读在挂),
    // 没有提示可展示,不能凭一次空交互拉取放行回执——等 turn-end / 看门狗 finalize
    // 后的完整消息对账。重建失败同样不上报,由下一轮触发补齐。
    const guardedSyncToken = noteRemoteSessionSyncStarted(sessionId);
    interactionsSync.then(
      (count) => {
        if (count > 0) noteRemoteSessionSyncCompleted(sessionId, guardedSyncToken);
      },
      () => undefined,
    );
    // 映射成 Promise<void> 并吞掉 rejection(engine 路径 fire-and-forget 无 catch;
    // 失败已由 reconcilePendingInteractions 内部日志记录)。
    return interactionsSync.then(
      () => undefined,
      () => undefined,
    );
  }
  const existingIds = new Set(state.messages.map((m) => m.clientId));
  // 起始快照的**对象引用**表:提交时用它区分"这一行期间被 live push 动过没有"。ChatMessage 不可变,
  // 只有内容真变了才会换新对象,所以引用相同 ⇒ 没被动过 ⇒ 可以用权威快照 hydrate;引用变了就只补
  // 不改,免得几秒前取的页把更新的内容盖回去(#676 review codex P1)。
  const rowsAtStart = new Map(state.messages.map((m) => [m.clientId, m]));
  // 代际快照:对账要翻最多 10 页(隧道下可达数秒),这期间窗口可能已被别的路径整体重建
  // ——包括**另一次对账**:CCAgentSessionView 会直接发起一次,而 useRemoteSessionSync
  // 独立地 fire-and-forget 再排一次,两次可以重叠。旧的那次若不比对代际就落地,会拿着
  // 过期的 existingIds 覆盖新窗口,还会 bump 代际、把新一次跳转刚拿到的分页锁清掉
  // (那次跳转随即被作废,同时放开了另一个请求去抢游标)(#676 review codex P1)。
  const reconcileEpochAtStart = _messagesEpoch.get(sessionId) ?? 0;
  // 远程回执新鲜度括号:启动记代、成功完成上报(失败不报)。回执只被「入队之后
  // 才启动且成功完成」的对账放行,见 sessionAttentionStore 的门槛说明。
  const syncToken = noteRemoteSessionSyncStarted(sessionId);
  // 拉回的窗口是否真实进入 UI(或确证无需应用);isStreaming 守卫丢弃合并时置 false。
  let windowApplied = true;
  const run = (async () => {
    try {
      // 断连窗口 / 被控端重启可能丢失 > 一页的消息;只拉最近一页会在更早处留永久空洞。
      // 从最近一页向更早翻,直到:某页与已有消息重叠(clientId 命中 = 已接回已知区段)/
      // 翻到历史起点(不足一页)/ 触上限(10 页 = 500 行防御)。累计后一次 mergeMessages
      // 合并去重保序补回被控端有、控制端缺的消息(被控端 DB = 单一真相源)。
      const MAX_PAGES = 10;
      const collected: Message[] = [];
      let before: string | undefined;
      let reachedKnownWindow = false;
      let reachedHistoryStart = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const rows = await listMessagesFor(sessionId, { limit: 50, before });
        if (rows.length === 0) {
          reachedHistoryStart = true;
          break;
        }
        collected.push(...rows);
        const hasKnownOverlap = rows.some((r) => existingIds.has(r.clientId));
        const overlapDecision = getRemoteReconciliationOverlapDecision(rows, hasKnownOverlap);
        if (overlapDecision.reachedKnownWindow) reachedKnownWindow = true;
        if (overlapDecision.shouldStop) {
          break; // 接回已知区段,无需再往前
        }
        if (!serverMessagePageHasMore(rows)) {
          reachedHistoryStart = true;
          break; // 已到历史起点
        }
        const oldest = oldestMessageRow(rows, 'newest-first');
        if (!oldest) {
          reachedHistoryStart = true;
          break;
        }
        before = oldest.id;
      }
      if (collected.length === 0) return;
      // 本次对账整体作废的两种情形:
      //  1. 代际已变:窗口被 rewind / clear / trim / demote / 另一次对账重建过;
      //  2. 已经有一次**更晚启动**的对账成功落地过:它读到的是更新的真相,本次的 existingIds
      //     与拉回的行都过期了。判据刻意放在提交点而不是启动点 —— 后启动那次可能中途 reject,
      //     那时旧那次拉回的缺失窗口还是有效的,丢掉它等于把这次 heal 整个作废,而对账都是
      //     fire-and-forget、空闲会话没有保证的重试(#676 review codex P1)。
      // 两种都不能落地(会覆盖新窗口、用过期字段 hydrate 更新的行),更不能 bump 代际去清掉
      // 新代际的分页锁。不上报同步完成,交给下一轮触发。
      //
      // 代际比对是唯一一道:同一会话的对账已经单飞(见 reconcileRemoteMessages 的包装),
      // 所以"代际变了"必然来自真正的窗口重置(rewind / clear / trim / demote / purge),
      // 不可能是另一次对账。本次拉回的行与 existingIds 都属于旧代际 → 整体作废,不上报同步完成,
      // 交给下一轮触发(单飞的尾随重跑也会补上)。
      const epochNow = _messagesEpoch.get(sessionId) ?? 0;
      if (epochNow !== reconcileEpochAtStart) {
        windowApplied = false;
        return;
      }
      const mapped = mapServerMessages(collected);
      // 翻满上限仍没接回已知区段 → 下面走权威重建分支:整片旧窗口被换掉、oldestMessageId
      // 也被改写。这是第八条"整体重建窗口"的路径,必须 bump epoch 作废 in-flight 的翻页 /
      // 跳转补齐 —— 否则那些请求会带着**重建前**的游标返回,把一段脱离上下文的旧历史接到
      // 新窗口上;更坏的是若那一页里有跳转目标,补齐会判 covered、连孤岛标记都不留,退化成
      // 本 PR 要修的那个静默空洞(#676 review codex P1)。
      //
      // 取舍:被作废的跳转会返回 null,用户那次搜索跳转落空、需要再点一次。反过来(让跳转
      // 赢、把对账推到下一轮触发)会让被控端权威内容继续缺着,而走到这个分支本身就说明本地
      // 窗口已经严重过期。所以让权威重建赢。
      //
      // historyWindowHasIsland 按"是否保留了晚到的本地行"决定清不清,见下方 lateArrivals。
      const isContiguous = reachedKnownWindow;
      // 代际 bump 与分页锁释放都**只在重建确定提交时**做。不能放在 setState 外面提前 bump:
      // 更新器里的 isStreaming 守卫可能否掉重建。也不能等 setState 通知完成后才 bump:
      // MessageStream 要在同一次通知里观察到窗口已失效、重置已挂载的自动补载预算。
      // updater 同步执行且下面所有早退都已经结束,在 return 新 state 前失效正好满足两边。
      setState(sessionId, (s) => {
        // promise 期间可能已开始新 turn(streaming)→ 放弃本次合并,turn 结束会再触发。
        // force 时(stall 看门狗已确认被控端 not-running)放行:此处 isStreaming 是卡死残留。
        // 丢弃合并 = 拉回的窗口没进 UI:置 windowApplied=false,本次不得上报同步完成
        // (否则挂起的远程已读回执会在缺帧内容尚未展示时被放行),等 turn 结束的下一轮。
        if (s.isStreaming && !opts?.force) {
          windowApplied = false;
          return s;
        }
        // 权威重建时保留下来的"快照之后新到的本地行"(典型:分页期间的 remote push,也可能是
        // 并发跳转刚 merge 进来的孤岛)。
        const lateArrivals = isContiguous
          ? []
          : s.messages.filter((message) => !existingIds.has(message.clientId));
        // 只给"启动到现在没被动过"的行开 hydrate 口子:其余只补不改。单飞之后,期间唯一可能动过
        // 这些行的就是 live push(messages:created),它比本次快照更新,不该被旧快照盖回去。
        const untouchedSinceStart = new Set<string>();
        for (const message of s.messages) {
          if (rowsAtStart.get(message.clientId) === message) {
            untouchedSinceStart.add(message.clientId);
          }
        }
        const messages = isContiguous
          ? mergeMessages(
              mapped,
              s.messages,
              { addOnly: true, addOnlyExcept: untouchedSinceStart },
              'newest-first',
            )
          : mergeAuthoritativeRemoteWindow(mapped, lateArrivals, 'newest-first');
        // 无缺失且无权威字段变化 → 不换引用(视同已应用)。
        if (messages === s.messages) return s;
        if (isContiguous) return { ...s, messages };
        invalidateMessageHistoryWindow(sessionId);
        const oldestRow = oldestMessageRow(collected, 'newest-first');
        // 保留下来的晚到行是否**可证明**与新窗口连续:
        //  - 比权威窗口最新一行还新 → 就是分页期间的 live push,接在尾部,连续;
        //  - 落在权威窗口时间范围之内 → 那段范围本身是连续拉回来的,不产生洞;
        //  - 比权威窗口最老一行还老 → 与新窗口之间隔着没加载的历史,**是孤岛**。
        // 第三种典型来源:搜索补齐在 existingIds 快照之后落地,它相对旧窗口是 covered、
        // 所以标记还是 false,重建把旧窗口换掉之后它就成了孤岛(#676 review codex P1)。
        // 所以这里必须**按事实赋值**,而不是"没有晚到行才清、否则沿用旧值"。
        //
        // 判据只认"落在权威窗口的时间范围**之内**":那段范围是本次连续翻回来的,所以范围内
        // 的行不可能在它与新窗口之间留洞。范围**之外**的一律按孤岛处理,包括比最新一行还新的
        // —— device-link 的实时推送是有损的(fire-and-forget),被控端连产多行时可能只送到
        // 最后一行,"比权威窗口更新"只证明它来得更晚,不证明中间那几行也送到了
        // (#676 review codex P1)。代价是分页期间来过 push 的会话会多做一次补齐尝试,
        // 换来的是不会把有损通道造成的缺口当成连续。
        // 比较必须走 (createdAt, rowid) 这条完整时间线,不能只比毫秒:同一毫秒里插入的两行
        // 靠 rowid 定序(messages 表与分页都用它),只比时间戳会把"与权威窗口最新行同毫秒、
        // 但 rowid 更大"的晚到行判成范围内,而它与权威窗口之间那一行可能正好被有损推送丢了
        // (#676 review codex P1)。
        const newestRow = newestMessageRowForWindow(collected);
        const authoritativeClientIds = new Set(collected.map((row) => row.clientId));
        const hasDetachedArrival =
          oldestRow !== null &&
          newestRow !== null &&
          lateArrivals.some((message) => {
            // 本次权威页里就带着它 → 必然连续。
            if (authoritativeClientIds.has(message.clientId)) return false;
            // thinking 行要换回**落库那条时间线**再比:mapServerMessages 把它的 createdAt 改写成
            // `finishedAt - durationMs`(块的开始时刻,渲染层算时长用),而 oldestRow / newestRow
            // 是原始 DB 行。混着比会让一个"想了很久"的 thinking 落在页范围里,而它与权威窗口之间
            // 那一行可能正好被有损推送丢了(#676 review codex P1)。换算不出来就保守判脱离。
            const timelineRow = thinkingSafeTimelineRow(message);
            if (timelineRow === null) return true;
            const cmpOldest = compareMessageTimeline(timelineRow, oldestRow);
            if (cmpOldest < 0) return true;
            const cmpNewest = compareMessageTimeline(timelineRow, newestRow);
            if (cmpNewest > 0) return true;
            // 与某个边界打平 ⇒ 同毫秒且至少一侧没有 rowid(rowid 唯一,都有则不会打平)。
            // 生产的 local-db:messages:created 广播走 messageToCamel,**不带 rowid**
            // (list 结果才带),所以 live push 与边界同毫秒时根本排不出先后 —— 中间那一行
            // 可能正好被有损推送丢了。这种无法判定的情况保守按脱离处理(#676 review codex P1)。
            //
            // 另一条路是"让广播也带上 rowid",但那要改 IPC / 隧道 payload 形状(跨端 wire),
            // 为一个边界精度换协议改动不值当;保守判脱离的代价只是多做一次补齐尝试。
            return cmpOldest === 0 || cmpNewest === 0;
          });
        return {
          ...s,
          messages,
          oldestMessageId: oldestRow?.id ?? s.oldestMessageId,
          hasMoreMessages: !reachedHistoryStart,
          // 锁归本次重置释放(与 reloadMessages / clear / trim / demote 同规矩):被作废的
          // 请求不会代清,漏清会让行首守卫把该会话的翻页永久卡住。
          isLoadingMore: false,
          historyWindowHasIsland: hasDetachedArrival,
        };
      });
    } finally {
      // 消息路径的早返 / 异常都要等交互重建落定;交互失败会让 run reject(替换原结果),
      // 语义正确:本代不完成。
      await interactionsSync;
    }
  })();
  run.then(
    () => {
      // 只有拉回的窗口真实进入 UI(或确证无需应用:host 无消息 / 无差异)才上报完成;
      // 被 isStreaming 守卫丢弃的合并不算,防止回执在缺帧内容未展示时被放行。
      if (windowApplied) noteRemoteSessionSyncCompleted(sessionId, syncToken);
    },
    (err) => log.warn('reconcileRemoteMessages failed', { sessionId, err: String(err) }),
  );
  return run;
}

/**
 * 远程会话 stall 看门狗在**确认被控端 turn 已结束**后,把控制端镜像卡死的 turn 态强制收尾。
 * 复用 forceFinalizeOnSessionClosed(已实现 isRunning/startedAt/streamingClientId/isStreaming
 * 清零 + pending 交互过期),不重写。
 *
 * 幂等 & race-safe:forceFinalizeOnSessionClosed 对「已收尾」状态早返 no-op(不新建对象),
 * setState 的 next===prev 短路不通知 —— 故晚到的真 done/closed 帧再跑其正常 reducer 也无害
 * (flag 已清 → no-op 或无害重清),不会复活已死 turn、不会双 finalize。
 * 仅远程会话生效(本机 push 不丢)→ 本机零回归。
 */
function finalizeStuckRemoteTurn(sessionId: string): void {
  if (!isRemoteSession(sessionId)) return;
  // 看门狗确认被控端已停止 = 权威终态；在清本地 owner 前先作废所有旧查询，
  // 防止 stall 期间悬挂的 getProjection 随后把已死 turn 重新点亮。
  bumpInteractionReconcileEpoch(sessionId);
  supersedeInputProjectionRequests(sessionId, { supersedeOperations: true });
  flushPendingTextDelta(sessionId); // 收尾前把残留增量落定,避免丢最后一截文本
  setState(sessionId, forceFinalizeOnSessionClosed);
}

/**
 * 向上翻页单次手势最多追加的页数(每页 50 行)。
 *
 * 为什么要追页:重度 agentic 会话里,单个 turn 动辄几百行 tool_use / tool_result /
 * thinking——单页 50 行可能整页都是同一 turn 的中段工作过程,渲染层
 * (MessageStream 的 groupWorkRuns / groupAnsweredTurnItems)会把它们全部折进
 * 顶部已折叠的「已工作 Xs」组,可见高度零增长。用户看到 spinner 转完却
 * "什么都没加载出来",要反复滚动很多次才憋出一条可见消息(2026-07 用户反馈)。
 * 只有 user 行是可靠的可见锚点(turn 边界,必然渲染独立消息;中段正文 / thinking
 * 在最后一段 thinking 之前的都会被折叠),所以带着 spinner 连续追页直到页里出现
 * user 行或翻完历史。页数打满即使没见到 user 行也先提交——游标已推进,下次手势
 * 从更老的位置继续,每次手势至少推进 MAX_LOAD_OLDER_PAGES × 50 行。
 */
const MAX_LOAD_OLDER_PAGES = 10;

/**
 * 加载并提交更早的历史。返回 true 仅表示当前缓存窗口确实向前推进;
 * 行首守卫、空页、全程失败、代际作废和提交异常都返回 false。
 * automatic=true 时只在推进成功后耗尽该缓存窗口的跨 mount 自动补载预算。
 */
function loadOlderMessages(sessionId: string, automatic = false): Promise<boolean> {
  const state = getOrCreateState(sessionId);
  if (state.isLoadingMore || !state.hasMoreMessages) return Promise.resolve(false);

  let firstPageOpts: { limit: number; before?: string; beforeTs?: number };
  if (state.oldestMessageId) {
    firstPageOpts = { limit: 50, before: state.oldestMessageId };
  } else if (state.messages.length > 0) {
    const oldest = state.messages[0];
    if (!oldest.createdAt) return Promise.resolve(false);
    const ts = new Date(oldest.createdAt).getTime();
    if (!Number.isFinite(ts)) return Promise.resolve(false);
    firstPageOpts = { limit: 50, beforeTs: ts };
  } else {
    return Promise.resolve(false);
  }

  setState(sessionId, (s) => ({ ...s, isLoadingMore: true }));

  // 代际快照:追页期间会话被 rewind/reload/purge 时,提交前比对发现代际已变
  // 即作废本次窗口(拉回的行可能已被服务端软删,merge 回去会让被裁剪的消息复活)。
  const epochAtStart = _messagesEpoch.get(sessionId) ?? 0;

  // 远程会话(device-link)往上翻页加载更多历史:会话与消息只在被控端,必须走 origin-aware
  // 的 listMessagesFor(本地会话回落 messageService.list),否则查控制端空库 → 旧历史加载为空。
  // 与初始加载 / backfill(本文件其余处)保持一致。
  return (async () => {
    try {
      const collected: Message[] = [];
      // 跨页按 clientId 去重:mergeMessages 只对"新批 vs 已有"去重,不去重批内
      // 重复;游标异常(如远端排序不稳)返回重叠页时,不去重会把同一行灌多份。
      const collectedClientIds = new Set<string>();
      let pageOpts = firstPageOpts;
      // 初值 true:首页就 fetch 失败时不能把 hasMoreMessages 误收成 false(要留给用户重试)。
      let hasMore = true;
      let oldestId: string | null = state.oldestMessageId;
      try {
        for (let page = 0; page < MAX_LOAD_OLDER_PAGES; page++) {
          const rows = await listMessagesFor(sessionId, pageOpts);
          if (rows.length === 0) {
            hasMore = false;
            break;
          }
          for (const row of rows) {
            if (collectedClientIds.has(row.clientId)) continue;
            collectedClientIds.add(row.clientId);
            collected.push(row);
          }
          const oldestRow = oldestMessageRow(rows, 'newest-first');
          if (oldestRow) oldestId = oldestRow.id;
          hasMore = serverMessagePageHasMore(rows);
          if (!hasMore) break; // 已到历史起点
          // 页里出现真实 user 行 = 拿到可见锚点,本次手势已有内容可渲染,停止追页。
          // 合成指令行(isSyntheticTriggerRow)渲染 null,不算可见锚点。
          if (rows.some((row) => row.role === 'user' && !isSyntheticTriggerRow(row))) break;
          if (!oldestRow) break;
          pageOpts = { limit: 50, before: oldestRow.id };
        }
      } catch (err) {
        // 半程失败:已拉到的页照常提交(游标推进、内容不丢),hasMoreMessages 维持
        // 可重试;全程失败(collected 空)走下面的空分支只还原 spinner。
        log.warn('loadOlderMessages page fetch failed', { sessionId, err: String(err) });
      }

      // 代际比对:追页期间切片被整体重置(reloadMessages / /clear / edit-last 截断 /
      // purge)→ 本次窗口作废,直接退出且**不碰 isLoadingMore**。
      //
      // 早先这里会顺手复位 spinner,理由是"reload 的 setState 不清 isLoadingMore"。
      // 那条前提已经不成立:三条 epoch-reset 路径(reloadMessages /
      // clearSessionAfterGuard / dropMessagesFromClientId)现在各自显式释放锁。而在
      // 重置之后,新代际很可能已经开始自己的分页并重新置了锁 —— 这里再无条件清一次,
      // 就是把别人的锁放掉,让后续滚动 / 跳转并发去抢同一个游标,重新制造游标回退与
      // 重复分页(#676 review)。谁重置谁释放,被作废的请求一律不碰。
      if ((_messagesEpoch.get(sessionId) ?? 0) !== epochAtStart) return false;

      if (collected.length === 0) {
        setState(sessionId, (s) => ({
          ...s,
          // 只有确证翻完(空页)才收 hasMoreMessages;fetch 失败保持原值让用户可重试。
          hasMoreMessages: hasMore ? s.hasMoreMessages : false,
          isLoadingMore: false,
        }));
        return false;
      }

      const mapped = mapServerMessages(collected);
      let didAdvanceWindow = false;
      setState(sessionId, (s) => {
        const messages = mergeMessages(mapped, s.messages, {}, 'newest-first');
        const nextOldestMessageId = oldestId ?? s.oldestMessageId;
        didAdvanceWindow =
          messages.length > s.messages.length || nextOldestMessageId !== s.oldestMessageId;
        return {
          ...s,
          messages,
          oldestMessageId: nextOldestMessageId,
          hasMoreMessages: hasMore,
          isLoadingMore: false,
        };
      });
      if (didAdvanceWindow && automatic) {
        markSessionAutomaticHistoryLoadCompleted(sessionId);
      }
      return didAdvanceWindow;
    } catch (err) {
      // map/merge/commit 阶段兜底(subagent review P1):任何异常都必须复位
      // isLoadingMore,否则行首守卫会让该会话永久无法再翻页(spinner 卡死)。
      log.warn('loadOlderMessages commit failed', { sessionId, err: String(err) });
      // 但只放**自己那一代**的锁。当前代码里这条 catch 只可能在代际比对**之后**触发
      // (所有 await 都在内层 try 里,fetch reject 被它吞掉、随后照常走比对),所以这道守卫
      // 今天不可达;加上它是为了让"谁重置谁释放、被作废的请求一律不碰锁"这条不变式
      // 不依赖调用顺序 —— 将来若有人在比对之前插入 await,不至于又变成"误放别人的锁"
      // (#676 review greptile)。
      if ((_messagesEpoch.get(sessionId) ?? 0) === epochAtStart) {
        setState(sessionId, (s) => ({ ...s, isLoadingMore: false }));
      }
      return false;
    }
  })();
}

/**
 * 跳转补齐的预算:按**行数**计,并把它当作 render item 数的保守上界。
 *
 * 为什么要有预算:MessageStream 的锚定渲染窗口(visibleRenderItems 的
 * firstVisibleItemKey 分支)是 `slice(startIdx)` —— 从锚点一直切到末尾、没有上界。
 * 补齐把 messages 变长后,跳转到很早的位置就会一次挂载"锚点 → 末尾"的全部 item。
 *
 * 为什么不再按 role / 工具名折算:折算模型必须逐一追平 buildRenderItems 的每种 item
 * 展开规则,而那套规则会持续演化。#676 的 review 连着四轮各挖出一种被低估的展开路径:
 * agent_task 卡(每个 Agent/Task/Workflow 调用 1:1)、按空洞切段后的孤立单行调用、
 * ghost_call 配卡后的独立 ghost_card、TodoWrite / update_plan 的 agent_plan 卡
 * (该卡现已移出流内,计划改钉在 composer 上方的 PinnedPlanPanel;历史结论不变)、
 * 以及结果含媒体时额外产出的 tool_media —— 每次都是"某行额外产生 item",而折算恰恰
 * 假设"多行合成一个 item"。低估预算的方向是危险的那一侧(放进更多实际渲染量),所以
 * 不再猜比例:一行最多产出一个可见 item 的量级,直接按行数当上界。
 *
 * 代价说清楚:工具密集的会话补齐能力因此下降(600 行而不是折算后的两千多行),更早
 * 退回不连续的 around 窗口 —— 那时由渲染层的 HISTORY_GAP_SPLIT_MS 守卫兜底,不会折出
 * 跨空洞的假组或谎报时长。这条取舍的根因仍是锚定窗口没有上界:只要它在,补齐规模就得
 * 受渲染体量牵制。彻底的解法是把锚定窗口做成双向有界 + 配套向下扩窗(与滚到顶时的
 * expandWindow 对称),它要联动改 MessageStream 的 startIdx / windowAtTop /
 * isNearBottom / expandWindow / handleScroll 五处派生,且滚动手感必须实机验证,
 * 故留作独立改动。
 *
 * 600 是 RENDER_WINDOW_INITIAL_ITEMS(80)的 7.5 倍量级:可感知但不冻结。预算对照的是
 * **窗口总行数**(s.messages.length),不是单次跳转的新增量 —— 否则连续几次向更早处跳转
 * 会各自重新起算,把挂载树累积到几千行。
 */
const JUMP_BACKFILL_MAX_ITEMS = 600;
const JUMP_BACKFILL_PAGE_SIZE = 100;

/**
 * 请求次数安全上限,与行预算分开计。
 *
 * 不能只按"页数"计预算:device-link 会话的 messages:list 结果超过 relay 帧上限时,
 * sliceRemoteMessageWindowForChannel 只返回一个很短的前缀并打 remoteRowsTrimmed。
 * 那种分片每次只带回几行,若和整页共用同一个计数器,远程会话会在远未取到 2000 行时
 * 就耗尽预算、退回不连续的 around 窗口(#676 review)。所以体量走
 * JUMP_BACKFILL_MAX_ITEMS,请求次数只作为防死循环的独立兜底。
 */
const JUMP_BACKFILL_MAX_REQUESTS = 80;

/**
 * 补齐结果。每一态对应一套 fallback 处置,合并任意两态都会踩坑:
 *
 * - `covered`    已补齐,窗口连续。游标 / hasMore 归 backfill 维护,fallback 不得回退。
 * - `exhausted`  沿旧游标翻到历史起点仍未命中(目标已被 rewind 软删等)。backfill 自己已
 *                把 hasMoreMessages 置 false,但 fallback 随后**要**把它改回 true —— 它
 *                merge 进来的 around 行可能比旧游标更早,"旧游标之上没有更多"这个结论对
 *                合并后的新边界不成立;钉死 false 会让向上翻页永久停在孤岛上沿。
 * - `busy`       让位给正在飞行的 loadOlderMessages。锁是别人的,fallback **不能**写
 *                isLoadingMore —— 提前释放会让下一次滚动/跳转从同一游标再开一个请求,
 *                正是这把锁要防的游标竞态。
 * - `unavailable` 超页数上限或请求异常。同 `exhausted`:fallback 置 hasMore=true,
 *                因为 merge 进来的 around 行会把窗口上沿推到旧游标之外。
 * - `cancelled`  切片被 rewind / clear / purge 故意重置。调用方**不能**再 merge 之前
 *                抓到的 around 行,否则会把刚被移除的消息(甚至已 purge 的切片)塞回窗口。
 */
type JumpBackfillOutcome = 'covered' | 'exhausted' | 'busy' | 'unavailable' | 'cancelled';

/**
 * 把当前窗口从最新连续向上补齐,直到 `covered` 判定命中目标。
 *
 * 为什么要补:跳转到历史消息如果只把目标附近的窗口 merge 进来,它与已加载的尾部
 * 窗口之间会隔着一段没加载的历史——渲染层看到两段"相邻"item,中间的 user 行(唯一
 * 的 turn 边界)全部缺席,整段被折成一个「已工作 Xs」,用户看到的就是"中间掉了很多
 * 条消息"(实测一条组吞掉 47 小时、40 条 user 消息)。补齐后窗口始终是"某点 → 最新"
 * 的连续区间:没有空洞,向下滚也一定能回到最新。
 *
 * 用现有 `before` 游标向上翻页实现,不需要给 messages:list 加 `after` 方向,
 * 因而不触碰 device-link 隧道的跨端 wire protocol。远程会话经 listMessagesFor
 * 自动走 origin-aware 路由。
 */
async function backfillHistoryUntil(
  sessionId: string,
  /**
   * 要连上的目标行 clientId。
   *
   * 判定"已覆盖"只能看**本次翻页真正取回来的行**里有没有它,不能看合并后的 messages 里
   * 有没有:退回 around 窗口时目标本来就以孤岛形式躺在 messages 里,拿合并后的数组判定,
   * 重试的第一页(哪怕内容完全无关)就会让判定成立、进而把孤岛标记清掉,"中间缺失"于是
   * 永远补不回来(#676 review)。翻页是从最新连续向上的,所以"本页取到目标"等价于
   * "从最新到目标已经连续"。
   */
  targetClientId: string,
  /**
   * 跳转发起时(**around 请求之前**)的 epoch 快照。必须由调用方传入:在这里才取
   * 就会漏掉 around 请求自己那个 await —— 若 /clear、rewind、purge 发生在 around
   * 请求飞行期间,函数内取到的已经是重置后的值,epochChanged() 永远为 false,陈旧的
   * around 行会被当成新代际 merge 回窗口,复活刚被移除的消息。
   */
  epochAtStart: number,
): Promise<{ outcome: JumpBackfillOutcome; ownsPagingLock: boolean }> {
  const epochChanged = () => (_messagesEpoch.get(sessionId) ?? 0) !== epochAtStart;
  // ownsPagingLock 随 outcome 一起交回调用方:提交时只有**自己置过锁**的那次才可以清它、
  // 才可以写游标。锁优先的守卫与成员快速通道都在置锁之前返回,它们没有所有权
  // (#676 review codex P1)。
  if (epochChanged()) return { outcome: 'cancelled', ownsPagingLock: false };

  // 锁优先,连"目标已在窗口内"这种零成本情况也不例外(#676 review)。
  //
  // 与 loadOlderMessages 共用 isLoadingMore 这把锁:它已在飞行中时不抢游标。两个流程
  // 并发读写同一个 oldestMessageId,响应乱序会让游标回退、重复拉页并耗尽上限;让位后
  // 退回 around 窗口(窗口可能不连续,由渲染层的空洞守卫兜底)比制造游标错乱更安全。
  // 反向由下面立刻置位 isLoadingMore 挡住后续 loadOlderMessages。
  //
  // 为什么不能先判 covered:covered 会让 commitAroundWindow 去写 oldestMessageId,
  // 那在别人持锁期间同样破坏游标单调性。busy 分支只做权威 merge、不碰任何分页状态,
  // 所以锁被占用时一律 busy —— 返回 busy 而不是 unavailable,是因为锁是别人的,
  // fallback 路径不得代为释放。
  if (getOrCreateState(sessionId).isLoadingMore) return { outcome: 'busy', ownsPagingLock: false };
  // 快速通道只在窗口没有孤岛时可信:some(clientId) 是成员判定,不是连续覆盖判定。窗口里
  // 掺过孤岛(补齐失败时 merge 的 around 窗口)时,目标可能正是那座孤岛上的行 —— 直接返回
  // covered 就等于承认"中间缺失"永久修不好。有孤岛时一律走下面的翻页补齐,让它自愈。
  const stateBeforeFetch = getOrCreateState(sessionId);
  if (
    stateBeforeFetch.historyWindowHasIsland !== true &&
    stateBeforeFetch.messages.some((message) => message.clientId === targetClientId)
  ) {
    // 窗口本身连续(无孤岛)时,成员判定就等于覆盖判定,可以零成本短路。
    // 注意 ownsPagingLock=false:这条路一个请求都没发、也没置锁,所以提交时不得清锁、
    // 不得写游标 —— 否则两个 around 响应同时落地时,这一次会把另一次刚拿到的锁清掉、
    // 并覆写它的游标(#676 review codex P1)。
    return { outcome: 'covered', ownsPagingLock: false };
  }

  setState(sessionId, (s) => ({ ...s, isLoadingMore: true }));

  // 页面**累积到本地**,循环结束才发布一次 state。
  //
  // 逐页 setState 的代价:device-link 帧裁剪会把每次响应压到只有几行,于是这个循环可能跑
  // 接近 80 次,每次都发布一个新的 messages 数组 —— 订阅者被通知 80 次、每次都重建一棵
  // 越来越大的消息树,还伴随反复的滚动锚定 churn,整体 O(请求数 × 窗口大小)。跳转期间
  // 用户等的是落点,中间态没有价值(#676 review)。一次性发布还顺带缩小了"半成品窗口被
  // trim / demote 等逻辑观察到"的窗口。
  //
  // 预算对照**窗口总量**(已有窗口 + 本次累积),不是本次跳转的新增量:先前跳转 merge 进来
  // 的行还留在 s.messages 里,只看新增量会让连续几次深跳各加一整份预算。
  const baseWindowSize = getOrCreateState(sessionId).messages.length;
  const collected: Message[] = [];
  const collectedIds = new Set<string>();
  let cursorId: string | null = getOrCreateState(sessionId).oldestMessageId;
  let hasMoreAtEnd = true;

  /**
   * 把累积的页一次性并入窗口。
   *
   * collected 为空时直接 return、**不改任何 state** —— 包括 hasMoreMessages:一页都没取到
   * 时该改成什么值取决于为何结束(触顶 / 异常 / 超预算),只有调用点知道,所以由调用点各自
   * setState(#676 review)。
   */
  const publishCollected = (): void => {
    if (collected.length === 0) return;
    const mapped = mapServerMessages(collected);
    setState(sessionId, (s) => ({
      ...s,
      // addOnly:这些页可能是几秒前取到的,期间 live push 可能已经更新过其中某行;
      // 用旧快照 hydrate 会把 live 更新盖回去(见 mergeMessages 的 addOnly 说明)。
      messages: mergeMessages(mapped, s.messages, { addOnly: true }, 'newest-first'),
      historyLoaded: true,
      isFirstMessage: false,
      oldestMessageId: cursorId ?? s.oldestMessageId,
      hasMoreMessages: hasMoreAtEnd,
      isLoadingMore: true,
    }));
  };

  try {
    for (
      let request = 0;
      request < JUMP_BACKFILL_MAX_REQUESTS &&
      baseWindowSize + collected.length < JUMP_BACKFILL_MAX_ITEMS;
      request++
    ) {
      // 本次能再取多少行:预算按**窗口总量**算,而每页最多带回 PAGE_SIZE 行。只在循环条件里
      // 判"还没到上限"的话,最后一次请求可以把窗口顶出上限近一整页(#676 review copilot),
      // 所以把 limit 夹到剩余额度上,让上限真正是上限。
      const remainingBudget = JUMP_BACKFILL_MAX_ITEMS - (baseWindowSize + collected.length);
      const pageLimit = Math.min(JUMP_BACKFILL_PAGE_SIZE, remainingBudget);
      // 首页(窗口为空)不带游标 —— messages:list 默认返回最新一页。
      const opts: { limit: number; before?: string } = { limit: pageLimit };
      if (cursorId) opts.before = cursorId;

      const rows = await listMessagesFor(sessionId, opts);
      // 代际比对:追页期间 rewind / clear / purge 重置了切片 → 本次跳转整体作废,
      // 累积的页一并丢弃(它们属于旧代际)。
      if (epochChanged()) return { outcome: 'cancelled', ownsPagingLock: true };
      if (rows.length === 0) {
        hasMoreAtEnd = false;
        publishCollected();
        setState(sessionId, (s) => ({ ...s, hasMoreMessages: false }));
        return { outcome: 'exhausted', ownsPagingLock: true };
      }

      // 跨页按 clientId 去重:游标异常(如远端排序不稳)返回重叠页时,不去重会灌多份。
      for (const row of rows) {
        if (collectedIds.has(row.clientId)) continue;
        collectedIds.add(row.clientId);
        collected.push(row);
      }
      const oldestRow = oldestMessageRow(rows, 'newest-first');
      // 游标必须真的往更早处推进。远端排序 / 游标异常(before 没被正确消费、重复返回同一页)
      // 时,不检测就会打满 80 个请求而 collected 几乎不增长(#676 review copilot)。
      if (!oldestRow || oldestRow.id === opts.before) {
        publishCollected();
        return { outcome: 'unavailable', ownsPagingLock: true };
      }
      cursorId = oldestRow.id;
      // 满页判定要对照**本次实际请求的 limit**:预算收尾时 limit 被夹小了,拿 PAGE_SIZE 去比
      // 会把一页满页误判成"历史到底了"、错误地把 hasMoreMessages 关掉。
      hasMoreAtEnd = serverMessagePageHasMore(rows, pageLimit);

      // 只认"本页真的取到了目标" —— 窗口里有它可能只是先前 fallback 留下的孤岛。
      if (rows.some((row) => row.clientId === targetClientId)) {
        publishCollected();
        return { outcome: 'covered', ownsPagingLock: true };
      }
      // 已翻到历史起点仍没命中:目标不在本会话可见历史里(例如被 rewind 软删)。
      if (!hasMoreAtEnd) {
        publishCollected();
        return { outcome: 'exhausted', ownsPagingLock: true };
      }
    }
    // 触到窗口预算或请求上限:上方还有历史,hasMore 保持 true 让用户继续向上翻。
    publishCollected();
    return { outcome: 'unavailable', ownsPagingLock: true };
  } catch (err) {
    log.warn('backfillHistoryUntil failed', { sessionId, err: String(err) });
    // 半程失败:已拉到的页照常提交(与 loadOlderMessages 同口径,游标推进、内容不丢)。
    // 但请求 reject 也可能发生在切片被重置之后(典型:远程会话在 /clear 期间断链),
    // 那种情况不能当成"可重试的失败"交回调用方 —— 它会 merge 陈旧的 around 行、把重置
    // 刚移除的消息复活,purge 后还会把已删的切片重新 materialize 出来(#676 review)。
    // 注意 cancelled 也要报"持有过锁":重置路径会自己清锁,但若它先于本次置锁发生过…
    // 实际上 epoch 变了就一律由重置路径收口,调用方不会提交,ownsPagingLock 不被使用。
    if (epochChanged()) return { outcome: 'cancelled', ownsPagingLock: true };
    publishCollected();
    return { outcome: 'unavailable', ownsPagingLock: true };
  }
  // 注意:这里**不释放**分页锁 —— 它一路持有到调用方的 commitAroundWindow(见那里的
  // isLoadingMore 处置)。
  //
  // 原先在 finally 里释放,于是"backfill 返回"与"调用方提交"之间多出一个 microtask 空档:
  // 另一次跳转(隧道响应的 continuation 尤其容易排在这里)可以在空档里抢到锁,随后旧那次的
  // exhausted / unavailable 提交又把 isLoadingMore 清掉 —— 新持有者的游标就暴露给并发分页了
  // (#676 review codex P1)。改为持有到提交:backfill 返回后到 commitAroundWindow 之间全是
  // 同步代码,没有可插入的空档。
  //
  // 被作废(cancelled)那条路不释放:epoch 已变说明重置路径接管了,而重置路径自己会清锁 ——
  // 被作废的请求不该代劳(它分辨不出锁属于哪一代)。
}

/**
 * 跳转入口的收尾:把 around 行 merge 进窗口,并按补齐结果决定游标 / 锁怎么落。
 * 两个入口(按 message id / 按 clientId)共用,避免五态处置在两处漂移。
 *
 * around 行是权威内容,除 `cancelled` 外每条路径都要 merge —— 重复跳转同一条消息
 * 时靠它把本地旧内容 hydrate 成最新(典型:tool_result 由 verbose 收敛成权威短内容)。
 */
/**
 * around 快照能否 hydrate 跳转目标那一行 —— 只有"跳转期间它没被动过"才可以。
 *
 * 目标行的 hydrate 是 around 提交的目的(重复跳转把本地 verbose 的 tool_result 收敛成权威
 * 内容),但 around 是在补齐循环**之前**取的:若这期间 local-db:messages:created 把目标行更新
 * 过,拿旧快照 hydrate 就会把更新的内容 / 元数据盖回去(#676 review codex P1)。
 *
 * 判据用**对象引用**:store 里的 ChatMessage 是不可变的,只有内容真的变了才会被换成新对象
 * (mergeMessages / hydratePersistedMessage 都有 shallowEqual 短路)。引用没变 ⇒ 没被动过。
 * 这样不需要给每条消息加修订号(messages 表没有 updatedAt)。
 *
 * 跳转前窗口里本来就没有这一行(before === undefined)时照常放行:那一行是被 merge **新增**
 * 进来的,不存在"盖掉更新"的问题。
 */
function hydrateTargetIfUntouched(
  sessionId: string,
  targetClientId: string | null,
  before: ChatMessage | undefined,
): string | null {
  if (!targetClientId) return null;
  const now = getOrCreateState(sessionId).messages.find(
    (message) => message.clientId === targetClientId,
  );
  // 一条判据同时覆盖两种情形:
  //  - 跳转前就有这一行:引用没变 ⇒ 期间没被 live push 动过 → 可以 hydrate;
  //  - 跳转前没有这一行(before === undefined):现在仍然没有才放行。若期间被 push 补进来了,
  //    那份内容比 around 快照**更新**,拿旧快照 hydrate 就是回退(#676 review codex P1)。
  return now === before ? targetClientId : null;
}

function commitAroundWindow(
  sessionId: string,
  rows: Message[],
  mapped: ChatMessage[],
  outcome: JumpBackfillOutcome,
  /**
   * 本次跳转是否**自己置过**分页锁(backfillHistoryUntil 一路持有到这里)。
   *
   * 不持有时(锁被 loadOlderMessages 占着 → busy;或成员快速通道零成本短路 → covered)
   * 一律只做权威 merge:游标 / hasMore / isLoadingMore 全都不碰。碰了就是改别人的分页状态
   * —— 清掉别人刚拿到的锁、或把游标覆写成"更新的值"破坏单调性(#676 review codex P1)。
   */
  ownsPagingLock: boolean,
  /**
   * 本次跳转的目标 clientId —— around 快照只被允许 hydrate 这一行。
   *
   * around 是在整个补齐循环**之前**取的,隧道下可能已经陈旧好几秒;期间 live push 可能已经把
   * 窗口里某行更新过。默认 hydrate 是 persisted 赢,于是陈旧的 around 快照会把更新的内容 /
   * 元数据盖回去(#676 review codex P1)。
   *
   * 但对**目标那一行**,hydrate 恰恰是这次提交的目的:重复跳转同一条消息时靠它把本地
   * verbose 的 tool_result 收敛成权威内容(既有回归 makerChatStoreAroundClientId 守着)。
   * 所以只给目标开口子,其余一律只补缺行。
   */
  hydrateClientId: string | null,
): void {
  setState(sessionId, (s) => {
    const messages = mergeMessages(
      mapped,
      s.messages,
      {
        addOnly: true,
        ...(hydrateClientId ? { addOnlyExcept: new Set([hydrateClientId]) } : {}),
      },
      'oldest-first',
    );
    if (!ownsPagingLock) {
      // mergeMessages 只增不减 → "长度没变"等价于"没引入可能不连续的行"。
      const addedRows = messages.length !== s.messages.length;
      // busy 意味着补齐**根本没跑**(让位给正在飞行的分页),这次 merge 进来的 around 行与
      // 尾部窗口之间可能隔着没加载的历史 → 记上孤岛,否则下次跳同一目标会命中成员快速通道、
      // 永远修不回连续。
      //
      // covered 且不持锁 = 成员快速通道:它成立的前提就是"窗口无孤岛且目标在窗口里",
      // 所以 radius 内的邻居与目标同处连续区间,不产生孤岛,标记不动。
      const marksIsland = outcome === 'busy' && addedRows;
      if (marksIsland) return { ...s, messages, historyWindowHasIsland: true };
      // 真正的 no-op(merge 没换引用、也不用记孤岛)直接返回原 state:setState 只要
      // next !== prev 就通知订阅者,白发一次会让整棵消息树重渲染(#676 review copilot)。
      return messages === s.messages ? s : { ...s, messages };
    }
    // 已补齐:hasMore 归 backfill 维护,不能被 around 窗口的边界回退。
    // 但游标要取两侧更早的那个:radius 决定的 around 窗口可能含比"命中那一页的
    // oldestMessageId"更早的行(目标落在该页靠旧的一侧时),只 merge 不推进游标会让
    // 下一次向上翻页重复已加载区间、连翻几次都看不到新内容(#676 review)。
    // oldestServerMessageIdForWindow 本身就是"取更早者"的语义。
    if (outcome === 'covered') {
      return {
        ...s,
        messages,
        // 锁由本次提交释放(backfill 一路持有到这里,见那里的说明)。
        isLoadingMore: false,
        // 与其它 outcome 同口径:跳转成功也意味着历史已经加载过、不再是空会话。
        // 漏掉会让依赖这两个标志的 UI / 副作用判定在"只经跳转建立窗口"的路径上不一致
        // (#676 review copilot)。
        historyLoaded: true,
        isFirstMessage: false,
        // 注意这里**不清**孤岛标记。补齐到达目标只证明"尾部 → 本次目标"连续,不证明更早的
        // 孤岛都被跨过:先前一次失败的深跳留下孤岛 A,之后跳一个更近的目标 B 并补齐成功,
        // B↔A 之间的洞和 A 自己的行都还在。清掉唯一的 boolean 会让之后跳回 A 走成员快速
        // 通道、永不修复(#676 review 给的两孤岛序列)。
        oldestMessageId: oldestServerMessageIdForWindow(
          rows,
          s.messages,
          s.oldestMessageId,
          'oldest-first',
        ),
      };
    }
    // mergeMessages 只增不减 → "长度没变"等价于"这次 merge 没引入任何新行"。
    const addedRows = messages.length !== s.messages.length;
    return {
      ...s,
      messages,
      historyLoaded: true,
      isFirstMessage: false,
      // 游标:已有连续窗口时**留在它的边缘**,不跟着孤岛前移(#676 review)。
      //
      // 退回 around 窗口时,缺失的区间比那座孤岛更新。若把 oldestMessageId 推到孤岛上,
      // 之后正常的向上翻页只会取比孤岛更老的行 —— 缺失区间再也拉不回来,而重试也救不了
      // (窗口已经吃满预算,补齐一个请求都不会发)。保留在连续段最老处,向上翻页就会
      // 一页页填补连续段与孤岛之间的空档。
      //
      // 但窗口还没有游标时(会话首次打开就直接跳转,尾部窗口尚未建立)必须用 around 窗口的
      // 边界播种,否则游标为 null 会让下一次翻页从最新重新开始、把跳转位置顶掉 ——
      // 既有回归「hands the cursor back to the latest page when initial history resolves after
      // a jump」与「keeps search result windows in chronological order across jumps」守着这条。
      oldestMessageId:
        s.oldestMessageId ?? oldestServerMessageIdForWindow(rows, s.messages, null, 'oldest-first'),
      // hasMoreMessages:**merge 真的加进了行**时置 true,否则保持原值。
      //
      // 置 true 的理由:那些新行比旧游标更早(否则早就 covered 了),窗口最老边界因此前移,
      // "从旧游标往上没有更多"这个结论对新边界不成立,而 around 行之上是否还有历史是未知的。
      // 锁成 false 会让用户再也翻不动这段历史(makerChatStoreActiveView 的 loadOlder 系列
      // 8 个用例覆盖这个语义)。
      //
      // 但一行都没加进来时,窗口边界没动,旧结论仍然成立:此时若把已经确证为 false 的
      // hasMoreMessages 翻回 true,已经完整翻到历史起点的会话会重新亮起"还有更多历史",
      // 每次窗口内搜索都会把它重新亮一次(#676 review codex P1)。
      hasMoreMessages: addedRows ? true : s.hasMoreMessages,
      // 锁由本次提交释放。
      isLoadingMore: false,
      // 退回 around 窗口 = 窗口里多了一座孤岛(它与尾部窗口之间隔着没加载的历史)。
      // 同理:没加进任何行就没有新孤岛,保持原值。
      historyWindowHasIsland: addedRows ? true : s.historyWindowHasIsland,
    };
  });
}

async function loadAroundMessage(
  sessionId: string,
  messageId: string,
  opts?: { radius?: number },
): Promise<ChatMessage | null> {
  // epoch 必须在 around 请求**之前**快照:这个 await 本身也是竞态窗口,若
  // /clear、rewind、purge 发生在它飞行期间,之后再取就已经是重置后的值,陈旧的
  // around 行会被当成新代际 merge 回窗口。
  const epochAtStart = _messagesEpoch.get(sessionId) ?? 0;
  // 按来源路由:远程会话经隧道 local-db:messages:around(直连本机会查控制端空库,跳转必失败)。
  const rows = await aroundMessagesFor(sessionId, messageId, opts);
  if (rows.length === 0) return null;

  const mapped = mapServerMessages(rows);
  const targetRow = rows.find((row) => row.id === messageId) ?? null;
  const targetClientId = targetRow?.clientId ?? null;
  // 补齐可能跑好几秒;先记下目标行**当前的对象引用**,提交时据此判断它有没有被 live push 动过
  // (见 hydrateTargetIfUntouched)。
  const targetRowBeforeBackfill = targetClientId
    ? getOrCreateState(sessionId).messages.find((message) => message.clientId === targetClientId)
    : undefined;

  // 优先把窗口从最新连续补齐到目标,不留历史空洞(见 backfillHistoryUntil)。
  // 补不到(超上限 / 翻完 / 让位并发分页)则退回 around 窗口 merge:此时窗口仍不
  // 连续,由渲染层的 HISTORY_GAP_SPLIT_MS 守卫兜底,不至于把两段折成一个工作组。
  const { outcome, ownsPagingLock } = targetClientId
    ? await backfillHistoryUntil(sessionId, targetClientId, epochAtStart)
    : {
        outcome: ((_messagesEpoch.get(sessionId) ?? 0) !== epochAtStart
          ? 'cancelled'
          : 'unavailable') as JumpBackfillOutcome,
        // 没有 targetClientId 时根本没调 backfill,也就没有锁。
        ownsPagingLock: false,
      };

  // 切片在跳转期间被 rewind / clear / purge 重置:整个跳转作废。绝不能再 merge
  // 之前抓到的 around 行,那会把刚被移除的消息重新塞回窗口。
  //
  // outcome 只反映 backfill **返回那一刻**的代际。它 return 之后、本函数从 await 恢复
  // 之前还有一个 microtask 间隙:重置的延续可能正好插在这里,于是 backfill 用旧代际算出
  // 的 covered / exhausted 仍是"有效"的,而切片已经清空。所以 merge 前再校验一次
  // (#676 review)。
  //
  // exhausted **不**在作废条件里:它仍会走下面的 around merge,让跳转能定位到目标。这是一个
  // 已知取舍 —— exhausted 意味着一路翻到历史起点都没见到目标,而 around 与 list 两个
  // handler 的可见性过滤同口径(都过滤 rewind_at 与 clearedAt),所以这种矛盾态只能是两次
  // 查询之间目标被别处删除 / rewound,此时 around 快照已陈旧。把它一并作废在正确性上更
  // 干净,但会反转十几处既有测试的 mock 前提(它们用 around 播种窗口而 list 默认返回空页),
  // 故留作独立改动;陈旧行的生命周期止于会话重建(reload / clear / demote / trim),
  // 不持久化、不跨会话(#676 review)。
  if (outcome === 'cancelled' || (_messagesEpoch.get(sessionId) ?? 0) !== epochAtStart) return null;

  commitAroundWindow(
    sessionId,
    rows,
    mapped,
    outcome,
    ownsPagingLock,
    hydrateTargetIfUntouched(sessionId, targetClientId, targetRowBeforeBackfill),
  );

  if (!targetClientId) return null;
  return (
    getOrCreateState(sessionId).messages.find((message) => message.clientId === targetClientId) ??
    null
  );
}

async function loadAroundMessageClientId(
  sessionId: string,
  clientId: string,
  opts?: { radius?: number },
): Promise<ChatMessage | null> {
  // 同 loadAroundMessage:epoch 在 around 请求之前快照,覆盖该请求自身的竞态窗口。
  const epochAtStart = _messagesEpoch.get(sessionId) ?? 0;
  const rows = await aroundMessagesByClientIdFor(sessionId, clientId, opts);
  if (rows.length === 0) return null;

  const mapped = mapServerMessages(rows);

  // 同 loadAroundMessage:先连续补齐,避免跳转窗口与尾部窗口之间留下历史空洞。
  // 同 loadAroundMessage:补齐之前记下目标行的对象引用,提交时判断它有没有被 live push 动过。
  const targetRowBeforeBackfill = getOrCreateState(sessionId).messages.find(
    (message) => message.clientId === clientId,
  );

  const { outcome, ownsPagingLock } = await backfillHistoryUntil(sessionId, clientId, epochAtStart);

  // 切片被重置 → 跳转作废,不 merge 旧的 around 行。merge 前再校验一次 epoch:outcome
  // 只反映 backfill 返回那一刻的代际,它 return 之后到这里恢复之间还有一个 microtask
  // 间隙(见 loadAroundMessage 同款注释)。
  //
  // exhausted 不作废,取舍见 loadAroundMessage 的同款注释。
  if (outcome === 'cancelled' || (_messagesEpoch.get(sessionId) ?? 0) !== epochAtStart) return null;

  commitAroundWindow(
    sessionId,
    rows,
    mapped,
    outcome,
    ownsPagingLock,
    hydrateTargetIfUntouched(sessionId, clientId, targetRowBeforeBackfill),
  );

  return (
    getOrCreateState(sessionId).messages.find((message) => message.clientId === clientId) ?? null
  );
}

function buildQueuedMessage(
  sessionId: string,
  text: string,
  model: string,
  effort: string,
  permissionMode: string,
  workingDir: string,
  files?: AttachedFile[],
  mentions?: MentionedResource[],
  opts?: {
    vendorOptions?: Record<string, unknown>;
    /** chat-text-quote:text 开头 blockquote 为引用功能拼接产出(渲染判据)。 */
    quotesEncoded?: boolean;
    agentReferences?: AgentInputReference[];
    pastedTextRanges?: PastedTextRange[];
    slashCommandRanges?: SlashCommandRange[];
    authRetryPersistOnProjectionError?: {
      data: Record<string, unknown> | null;
      agentMeta: Record<string, unknown> | null;
    };
    /** 订阅槽①:透传一次性跳过意识拦截钩标记(预留;v1 无强制发送 UI,无调用点置位)。 */
    bypassGhostHooks?: boolean;
  },
  identity?: { clientId: string; createdAt: string },
): QueuedMessage {
  const clientId = identity?.clientId ?? crypto.randomUUID();
  const attachmentPayload = buildUserMessageAttachmentPayload(files);
  const { serializedFiles, imageAttachments, fileAttachments, persistImageRefs, persistFileRefs } =
    attachmentPayload;
  const sessionRefs = extractSessionRefs(text);
  const createOpts = buildCreateOptsForCurrentSession(
    sessionId,
    model,
    effort,
    permissionMode,
    workingDir,
    opts,
  );

  const chatMessage: ChatMessage & { role: 'user' } = {
    clientId,
    role: 'user',
    content: text,
    isStreaming: false,
    createdAt: identity?.createdAt ?? new Date().toISOString(),
    ...(opts?.quotesEncoded === true && { quotesEncoded: true }),
    ...(opts?.agentReferences?.length && { agentReferences: opts.agentReferences }),
    ...(opts?.pastedTextRanges?.length && { pastedTextRanges: opts.pastedTextRanges }),
    ...(opts?.slashCommandRanges !== undefined && {
      slashCommandRanges: opts.slashCommandRanges,
    }),
    ...(imageAttachments && imageAttachments.length > 0 && { images: imageAttachments }),
    ...(fileAttachments && fileAttachments.length > 0 && { files: fileAttachments }),
    ...(files && files.length > 0 && { retryFiles: files }),
    ...(mentions && mentions.length > 0 && { retryMentions: mentions }),
  };

  // agent-meta: 提前算好持久化 content，避免 main 落库时再做转换。
  // image-local-cache: 只把 ImageRef 形态（含 url）的图片塞进持久化 JSON；
  // F6 fallback (base64) 留在内存里，不进 storage（spec F6 验收条件）。
  // file-persist: fileAttachments 已经是 {name, path} 形态，与 FileRef 完全一致，
  // 一并塞进持久化 JSON，重启后 mapServerMessages 能把 chip 复原。
  const persistedContent = stringifyUserContent(
    text,
    persistImageRefs,
    persistFileRefs,
    opts?.quotesEncoded === true,
    opts?.pastedTextRanges,
    opts?.slashCommandRanges,
    [],
    opts?.agentReferences,
  );

  return {
    clientId,
    text,
    persistedContent,
    model,
    effort,
    permissionMode,
    workingDir,
    vendorOptions: opts?.vendorOptions,
    files: serializedFiles,
    mentions,
    ...(sessionRefs.length > 0 ? { sessionRefs } : {}),
    agentReferences: opts?.agentReferences,
    chatMessage,
    createOpts,
    userName: currentUserName,
    ...(opts?.bypassGhostHooks ? { bypassGhostHooks: true } : {}),
  };
}

function completeRemoteOptimisticMaterialization(
  sessionId: string,
  clientId: string,
  buildMaterializedQueued: () => QueuedMessage,
): void {
  const record = remoteOptimisticSendRecords(sessionId)?.get(clientId);
  if (
    !record ||
    !record.materializationPending ||
    !isRemoteOptimisticSendRegistered(sessionId, record)
  ) {
    return;
  }

  const previousQueued = record.queued;
  const queued = buildMaterializedQueued();
  // createOpts / userName 属于点击时快照。附件烧录期间设置或登录态可能变化，
  // 不能让迟到物化把这条消息悄悄改成新的发送配置。
  queued.createOpts = previousQueued.createOpts;
  if (previousQueued.userName === undefined) delete queued.userName;
  else queued.userName = previousQueued.userName;

  record.queued = queued;
  record.materializationPending = false;
  record.phase = 'preflight';
  record.attachmentUrls = [
    ...new Set([...record.attachmentUrls, ...collectRemoteOptimisticAttachmentUrls(queued.files)]),
  ];
  syncRemoteOptimisticAttachmentUrls();

  setState(sessionId, (state) => {
    let changed = false;
    const pendingQueue = state.pendingQueue.map((item) => {
      if (item.clientId !== clientId || item.isPendingEnqueue !== true) return item;
      changed = true;
      return { ...queued, isPendingEnqueue: true };
    });
    const messages = state.messages.map((message) => {
      if (message.clientId !== clientId || message.isPendingPersist !== true) return message;
      changed = true;
      return { ...queued.chatMessage, isPendingPersist: true };
    });
    return changed ? { ...state, pendingQueue, messages } : state;
  });
  const onMaterializationReady = record.onMaterializationReady;
  delete record.onMaterializationReady;
  onMaterializationReady?.(queued);
  pumpRemoteOptimisticSendsAfterCurrent(sessionId);
}

function extractSessionRefs(
  text: string,
  previous?: readonly AgentInputSessionRef[],
): NonNullable<AgentInputQueuedMessage['sessionRefs']> {
  // 粘滞版归属解析(与 learn/goal/makerTransport 链路对齐):relay 瞬时重连
  // 会 clear sessionId→deviceId 注册表,裸查表在这个窗口把远程会话错判成
  // 本地 → 引用解析落到控制端空本地库,内容注入失败。
  return reconcileSessionRefsForText(text, previous, getStickySessionDeviceId);
}

export function buildCreateOptsForCurrentSession(
  sessionId: string,
  model: string,
  effort: string,
  permissionMode: string,
  workingDir: string,
  opts?: { vendorOptions?: Record<string, unknown> },
): AgentInputCreateOpts {
  const current = getOrCreateState(sessionId);
  const deviceLinkRemote = isRemoteSessionSticky(sessionId);
  return {
    agentKind: current.agentKind,
    workingDir,
    model,
    effort,
    permissionMode,
    fastMode: current.fastMode,
    planMode: current.planModeEnabled,
    displayReasoning: 'summarized',
    userPrompt: getUserPrompt(),
    // device-link routes to the target desktop, so omit the controller setting.
    // SSH remote follows the controller's global setting like local sessions:
    // memory lives on this machine, scoped per hostId+remote path
    // (maker-core buildMemoryScopeKey), and reaches the remote agent via the
    // host HTTP MCP bridge.
    ...(deviceLinkRemote ? {} : { makerMemoryEnabled: getMakerMemoryEnabled() }),
    ...(current.remoteHostId ? { remoteHostId: current.remoteHostId } : {}),
    ...(opts?.vendorOptions ? { vendorOptions: opts.vendorOptions } : {}),
    ...(current.sdkSessionId ? { resumeSessionId: current.sdkSessionId } : {}),
  };
}

function touchSessionUserSend(sessionId: string, workingDir: string, wasFirst: boolean): void {
  const sendAt = new Date();
  const userSendAtIso = sendAt.toISOString();
  // 侧栏时间轴读 sessions.updatedAt,乐观更新同步 bump 让 sidebar 立即跳到"刚发过"
  // (main 侧 touchUserSendInDb 也会写 updatedAt,广播回来的 patch 值一致、幂等)。
  emitPatch(
    sessionId,
    wasFirst
      ? { workingDir, userSendAt: userSendAtIso, updatedAt: userSendAtIso }
      : { userSendAt: userSendAtIso, updatedAt: userSendAtIso },
  );
}

/**
 * Pure visual toggle for queues longer than the inline display limit. It never
 * gates drain; queue dispatch is controlled only by queuePaused and interaction
 * locks.
 */
function setQueueExpanded(sessionId: string, expanded: boolean): void {
  if (!sessionId) return;
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  runInputProjectionOperation(sessionId, (input) =>
    boundaryOpts
      ? input.setExpanded(sessionId, expanded, boundaryOpts)
      : input.setExpanded(sessionId, expanded),
  ).catch((err) => log.warn('setQueueExpanded failed:', err));
}

function resumeQueue(sessionId: string): void {
  if (!sessionId) return;
  // #2194 (Codex review P2): 暂停队列的「继续」是本端点击意图——恢复后 drain
  // 派发的队首项落库时会作为新尾部 user 行出现，不登记则门控误判为外部注入，
  // 续跑在屏幕外开始（队列可能来自上一次 renderer 生命周期或外部入口）。
  // 点击时刻快照队首。main 的 resume 在返回 projection 前就会 emit 并
  // scheduleDrain，快的恢复队列上队首行可能抢在回执回调前落库、被基线化为
  // 外部（Codex review P2）：点击意图在点击时刻已确定，先登记，回执确认未
  // 生效（仍 paused / 队首已不在队列）或 IPC 失败再回滚（会话已 purge 时
  // 回滚为 no-op，不会复活条目）。
  const preResumeState = sessions.get(sessionId);
  const preResumeHeadClientId =
    preResumeState?.queuePaused === true
      ? (preResumeState.pendingQueue[0]?.clientId ?? null)
      : null;
  if (preResumeHeadClientId) {
    markLocalSentUserMessage(sessionId, preResumeHeadClientId);
  }
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  runAgentDispatchProjectionOperation(sessionId, (input) =>
    boundaryOpts ? input.resume(sessionId, boundaryOpts) : input.resume(sessionId),
  )
    .then(({ projection }) => {
      if (
        preResumeHeadClientId &&
        !(
          sessions.has(sessionId) &&
          projection.queuePaused === false &&
          projection.pendingQueue.some((item) => item.clientId === preResumeHeadClientId)
        )
      ) {
        unmarkLocalSentUserMessage(sessionId, preResumeHeadClientId);
      }
    })
    .catch((err) => {
      if (preResumeHeadClientId) {
        unmarkLocalSentUserMessage(sessionId, preResumeHeadClientId);
      }
      log.warn('resumeQueue failed:', err);
    });
}

function setQueueInteractionLock(sessionId: string, lockId: string, locked: boolean): void {
  if (!sessionId || !lockId) return;
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  runInputProjectionOperation(sessionId, (input) =>
    boundaryOpts
      ? input.setInteractionLock(sessionId, lockId, locked, boundaryOpts)
      : input.setInteractionLock(sessionId, lockId, locked),
  ).catch((err) => log.warn('setQueueInteractionLock failed:', err));
}

function setQueueEditLock(sessionId: string, clientId: string, locked: boolean): void {
  if (!sessionId || !clientId) return;
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  runInputProjectionOperation(sessionId, (input) =>
    boundaryOpts
      ? input.setEditLock(sessionId, clientId, locked, boundaryOpts)
      : input.setEditLock(sessionId, clientId, locked),
  ).catch((err) => log.warn('setQueueEditLock failed:', err));
}

function moveQueueItem(sessionId: string, clientId: string, targetIndex: number): void {
  if (!sessionId || !clientId) return;
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  runInputProjectionOperation(sessionId, (input) =>
    boundaryOpts
      ? input.move(sessionId, clientId, targetIndex, boundaryOpts)
      : input.move(sessionId, clientId, targetIndex),
  ).catch((err) => log.warn('moveQueueItem failed:', err));
}

/**
 * F-QUEUE-DEFER: Remove a single un-dispatched queued message by clientId.
 * Used by the ✕ button on each row of `PendingQueuePanel`. Safe to call any
 * time — if the entry has already been dispatched (no longer in queue) this
 * is a no-op. Does NOT touch `messages[]` because the entry never had a
 * bubble (per F-QUEUE-DEFER bubble lifecycle).
 */
function removeFromQueue(sessionId: string, clientId: string): void {
  if (!sessionId || !clientId) return;
  markRemoteOptimisticLocallyRemoved(sessionId, clientId);
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  runInputProjectionOperation(sessionId, (input) =>
    boundaryOpts
      ? input.remove(sessionId, clientId, boundaryOpts)
      : input.remove(sessionId, clientId),
  )
    .then(() => clearRemoteOptimisticSend(sessionId, clientId))
    .catch((err) => {
      unmarkRemoteOptimisticLocallyRemoved(sessionId, clientId);
      log.warn('removeFromQueue failed:', err);
    });
}

/**
 * F-QUEUE-DEFER: 编辑一条已入队但尚未派发的消息文本。仅替换 text/persistedContent/
 * chatMessage.content，附件、@mention、model、effort、permissionMode、workingDir
 * 全部沿用入队时的 snapshot —— 用户在编辑期间改了模型/权限模式不会回灌到这条历史
 * 队列项。空字符串 / 与原值相同 / clientId 找不到 → no-op（删除走 removeFromQueue）。
 * persistedContent 解析失败时降级为纯文本写回，避免落库时丢字段。
 */
function updateQueueItem(sessionId: string, clientId: string, newText: string): void {
  if (!sessionId || !clientId) return;
  const trimmed = newText.trim();
  if (!trimmed) return;
  const queued = getOrCreateState(sessionId).pendingQueue.find((q) => q.clientId === clientId);
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  runInputProjectionOperation(sessionId, (input) =>
    boundaryOpts
      ? input.updateText(
          sessionId,
          clientId,
          newText,
          extractSessionRefs(newText, queued?.sessionRefs),
          undefined,
          boundaryOpts,
        )
      : input.updateText(
          sessionId,
          clientId,
          newText,
          extractSessionRefs(newText, queued?.sessionRefs),
        ),
  ).catch((err) => log.warn('updateQueueItem failed:', err));
}

/**
 * 已确认「不再需要自动起名」的会话(main 返回 done=true:已起过名,或用户手动
 * 改过名)。纯粹是省 IPC 的缓存 —— 权威判定始终在 main。
 *
 * 只在 main 明确给出 done=true 时登记:瞬时失败(IPC/DB 异常、模型无结果)不登记,
 * 下一条带文字的消息会重试,不会因一次抖动把会话永久钉在占位标题上。
 */
const autoNameSettled = new Set<string>();

/**
 * 每个会话最近一次起名尝试的轮次号(sessionId → attempt)。
 *
 * 用户在首次 `maker:auto-title` 返回前连着发两条文字时,两次都会通过 `autoNameSettled`
 * 检查、各起一次尝试。若**较早**那次失败,它的撤回不能动预览 —— 更晚的尝试仍在飞,
 * 预览还有主人,撤回会让标题白闪一次「未命名任务」(PR #1031 review P1)。
 * 与 SessionMenuSheet 的 `renameSeqRef`、搜索框的 `requestSeqRef` 同款守卫。
 */
const autoNameAttempts = new Map<string, number>();

/** 纯附件消息合成占位标题时的类别兜底词(拿不到任何文件名时才用)。 */
function autoTitleFallbackLabels(): AutoTitleFallbackLabels {
  return {
    image: i18n.t('ccAgent.autoTitle.image'),
    file: i18n.t('ccAgent.autoTitle.file'),
  };
}

/**
 * 触发自动起名。
 *
 * **权威逻辑全在 main**(`maker:auto-title`):资格判定、立即占位、智能标题覆盖、
 * 条件写与合成占位归属表都在那边。renderer 只负责给素材,原因是同一个会话既可能
 * 被本机发送、也可能被另一台设备远控,归属表若分散在两个进程会互相误判成「用户
 * 手动改名」而永久跳过替换(PR #510 review)。标题落库后 main 广播
 * `sessions:patched`,sessionsStore 据此更新侧边栏。
 *
 * device-link 远程会话例外:权威标题由**被控端** main 写,控制端这里只在自己的
 * 投影层登记一条即时预览,免得干等一次隧道往返。
 *
 * 整条链路 fire-and-forget,失败只打日志,不阻塞发送主流程。
 */
function scheduleAutoName(
  sessionId: string,
  text: string,
  agentKind: 'claude-code' | 'codex' | 'pi',
  isUserText = true,
): void {
  // 与 main 共用 normalizeAutoTitle,两端算出的占位串逐字一致,回流时不跳变。
  const fallbackTitle = normalizeAutoTitle(text);
  // 连描述都合成不出来(既无文字也无可命名附件):保留默认标题,留给下一条消息。
  if (!fallbackTitle) return;
  // mirror clear / relay reconnect can empty remoteProjectsStore after the
  // message was accepted. Keep the title preview on the last known device too;
  // otherwise this same remote message is treated as a local title update.
  if (getStickySessionDeviceId(sessionId)) {
    // 带上 isUserText:合成描述对应「被控端先写占位、之后还要换掉」,要登记成系统
    // 占位归属;用户文字对应的标题可能就此定稿,登记了会让后续预览一直盖着它。
    remoteProjectsStore.setPendingTitlePreview(sessionId, fallbackTitle, isUserText);
    return;
  }
  if (autoNameSettled.has(sessionId)) return;
  // 本机会话的即时标题预览 —— 与上面远程分支的 setPendingTitlePreview 对称。
  //
  // 没有这一步,标题要等「IPC 往返 → main 读库 → 写占位 → 广播 sessions:patched」
  // 整条链路走完才更新:用户明明已经按下回车,侧边栏 / 会话头却还显示着建会话时的
  // 默认占位。main 随后写入的就是这里的 fallbackTitle(同一套 deriveAutoTitleSeed
  // 素材 + 同一个 normalizeAutoTitle),所以回流时不跳变。
  //
  // 「标题是否仍是哨兵」的判定在 sessionsStore 的订阅处(它持有列表缓存);本函数
  // 也被「补起名」路径调用(每条带文字的消息都来一次),无条件写会把用户手动改过的
  // 名在 UI 上顶掉。走 bus 而不是直接 import sessionsStore:后者会把它的模块级
  // 订阅副作用拉进所有 import 本模块的加载链。
  //
  // 单独 try:预览纯属锦上添花,它失败既不能打断下面的起名 IPC,更不能把异常抛回
  // sendMessageCore 打断消息入队(与本函数其余副作用同一条契约)。
  try {
    emitAutoTitlePreview(sessionId, fallbackTitle);
  } catch (err) {
    log.warn('Failed to emit auto-title preview:', err);
  }
  // 一次起名尝试的**唯一**收尾:三种结束方式(正常 resolve / IPC reject / 同步抛错)
  // 都走这里,判据只有一条 —— **main 没确认写入(`applied` 不为 true)就撤回预览**。
  //
  // reject 与同步抛错建模成「没有结果」,与 `{ applied: false }` 落在同一分支:
  // `runSessionAutoTitle` 在「资格读失败 / 占位与智能标题两段都没写进去」时是
  // **正常 resolve** 出 `applied: false` 的,只挂 `.catch` 会漏掉这一整类
  // (PR #1031 review P1)。把收尾收敛成一个函数,是为了不再出现第四条漏掉的路径。
  //
  // `applied: false, done: true`(用户已手动改过名)同样撤回:DB 里是用户的标题,
  // 叠加层不该继续盖着;store 那边的守卫会发现缓存里已不是这次预览而自动让位。
  const attempt = (autoNameAttempts.get(sessionId) ?? 0) + 1;
  autoNameAttempts.set(sessionId, attempt);
  const settleAutoName = (result?: { applied?: boolean; done?: boolean }): void => {
    if (result?.done) autoNameSettled.add(sessionId);
    if (result?.applied) return;
    // 更晚的尝试已经起飞 → 预览归它,本次失败不撤回(否则标题白闪一次兜底文案)。
    if (autoNameAttempts.get(sessionId) !== attempt) return;
    clearAutoTitlePreviewSafely(sessionId);
  };
  // 整条链路对发送主流程必须是无副作用的:起名失败(桥接缺失 / IPC 抛错)只记日志,
  // 绝不能把异常抛回 sendMessageCore 打断消息入队。
  try {
    void window.electronAPI.maker
      .autoTitle({ sessionId, text, agentKind, isUserText })
      .then(settleAutoName)
      .catch((err) => {
        // 不登记 settled —— 下一条带文字的消息会重试。
        log.warn('Failed to auto-name session:', err);
        settleAutoName();
      });
  } catch (err) {
    log.warn('Failed to invoke auto-title IPC:', err);
    settleAutoName();
  }
}

/**
 * main 没确认写入 → 撤回上面那次乐观预览。
 *
 * 预览是「马上会有权威标题回流」的赌注,它的失效条件是权威标题落地。起名没写成时
 * 那个条件永远不成立:叠加层会在每次全量刷新后继续顶着 DB 里的哨兵,会话永久显示一个
 * **库里并不存在**的标题(重启后又变回「未命名任务」,同一会话两种标题)。宁可退回可
 * 解释的兜底文案 —— 而且没登记 `autoNameSettled`,下一条带文字的消息会重试起名。
 *
 * 万一 IPC 是「写库成功、响应丢了」,撤回也不会造成错误状态:main 已经广播过
 * `sessions:patched`,store 那边的迟到撤回守卫(比对缓存里是否仍是这次预览)会让位。
 *
 * 同上契约:撤回自身失败只记日志,绝不外抛打断发送主流程。
 */
function clearAutoTitlePreviewSafely(sessionId: string): void {
  try {
    emitAutoTitlePreviewCleared(sessionId);
  } catch (err) {
    log.warn('Failed to clear auto-title preview:', err);
  }
}

/**
 * 非首条消息的补起名:标题仍是系统占位的会话,在用户发出第一句**带文字**的消息
 * 时把标题换成他写的内容。三类会话会走到这里:
 *
 *   - 首条消息是纯附件(只贴图没打字)的会话:标题此时是合成占位(文件名 /
 *     「图片」等),用户一打字就换成他自己的话。
 *   - 同上但连描述都合成不出来、标题仍是 "New Maker" 的会话。
 *   - fork 出来的会话:标题是占位的 "[Fork] <源标题>"(剥离 fork 为
 *     "[Fork·已剥离] ..."),天然带历史消息(isFirstMessage=false),走不到普通
 *     首条消息的起名分支。
 *
 * 素材同样经 {@link deriveAutoTitleSeed} 推导,与首条消息共用一套口径:直接拿
 * `projectLiteralUserText` 会把 mention chip 序列化出的 `@<path>` 当成用户散文,
 * 既违反「合成描述不喂标题模型」的契约,也可能让标题里出现 wire token
 * (PR #510 review)。
 *
 * 只有 `isUserText=true` 才补起名:纯附件的后续消息不该把已有的合成占位换成
 * 另一个文件名。是否仍是系统占位由 main 判定(它持有 DB 与归属表),这里不再读
 * 会话行 —— 远程会话的行根本不在本机 DB 里,读它只会抛错。
 */
function maybeAutoNameUnnamedSession(
  sessionId: string,
  seed: AutoTitleSeed | null,
  agentKind: 'claude-code' | 'codex' | 'pi',
): void {
  if (!seed?.isUserText) return;
  scheduleAutoName(sessionId, seed.text, agentKind, true);
}

/**
 * 返回值:入队 intent 是否被 main 接受(true = enqueue resolve;false = 参数
 * 不合法被本函数拦下,或 enqueue reject——此时 error 态已写入 store)。
 * 绝大多数调用方是 fire-and-forget,不需要消费;edit-last-message 的重发
 * 路径用它决定是否把编辑文本落 composer 草稿兜底(rewind 已 commit,文本
 * 不能丢)。
 */
type SendMessageOpts = {
  vendorOptions?: Record<string, unknown>;
  /** 本条消息正文前缀含「选中引用」编码块,渲染侧据此启用胶囊化解析。 */
  quotesEncoded?: boolean;
  agentReferences?: AgentInputReference[];
  pastedTextRanges?: PastedTextRange[];
  slashCommandRanges?: SlashCommandRange[];
  authRetryPersistOnProjectionError?: {
    data: Record<string, unknown> | null;
    agentMeta: Record<string, unknown> | null;
  };
  /** 一次性跳过意识拦截钩(订阅槽①,预留;v1 无强制发送 UI):透传到排队项。 */
  bypassGhostHooks?: boolean;
  /** 远程预检在乐观投影建立后执行；false 时按 clientId 精确回滚。 */
  beforeEnqueue?: () => Promise<boolean>;
  /** 远程乐观发送在稍后确认永久失败时恢复 composer。 */
  onRemoteOptimisticFailure?: (clientId: string, error?: unknown) => void;
};

/** remote(SSH / device-link)会话:标注编辑数据指向控制端本地缓存,发送时剥离。 */
function isRemoteMediaSession(sessionId: string): boolean {
  return Boolean(getOrCreateState(sessionId).remoteHostId ?? getStickySessionDeviceId(sessionId));
}

/**
 * 共享发送边界：同步完成「无切换在途」检查与发送 token 登记，并保证同步抛错和
 * Promise settle 两条路径都会释放。`task` 仍在当前调用栈内启动，保留 sendMessage
 * 对 planMode 等点击时语义的同步定格。
 */
function withAgentSendDispatch<T>(
  sessionId: string,
  onSwitchPending: () => Promise<T>,
  task: () => Promise<T>,
): Promise<T> {
  const finishAgentSendDispatch = tryBeginAgentSendDispatch(sessionId);
  if (!finishAgentSendDispatch) return onSwitchPending();
  try {
    return task().finally(finishAgentSendDispatch);
  } catch (err) {
    finishAgentSendDispatch();
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function sendMessage(
  sessionId: string,
  text: string,
  model: string,
  effort: string,
  permissionMode: string,
  workingDir: string,
  files?: AttachedFile[],
  mentions?: MentionedResource[],
  opts?: SendMessageOpts,
): Promise<boolean> {
  if (!sessionId) return Promise.resolve(false);
  // Allow send if there is text OR files
  if ((!text.trim() && (!files || files.length === 0)) || !workingDir)
    return Promise.resolve(false);
  if (isRemoteDeletedSessionSendBlocked(sessionId)) return Promise.resolve(false);
  const remoteScopeAtStart = captureRemoteOptimisticSendScope(
    sessionId,
    opts?.onRemoteOptimisticFailure,
  );
  // A remote clear is allowed to seal in the background. Register the local
  // optimistic item and let its pump wait on the clear fence; local sessions
  // retain the historical synchronous guard.
  if (remoteClearInFlight.has(sessionId) && !remoteScopeAtStart) return Promise.resolve(false);
  if (remoteScopeAtStart && !isRemoteOptimisticSendScopeActive(sessionId, remoteScopeAtStart)) {
    return Promise.resolve(false);
  }
  const clearGenerationAtStart =
    remoteScopeAtStart?.clearGeneration ?? rendererClearGenerationBySession.get(sessionId) ?? 0;

  // 共享发送边界兜住 composer 之外的入口（编辑重发、恢复等）。ChatInput 会从引用
  // 水合阶段先持有一层 token；这里允许嵌套登记，确保未来新增调用方也不会绕过
  // session-agent-switch 的双向互斥。检查与登记同步完成，不给切换插入空窗。
  return withAgentSendDispatch(
    sessionId,
    () => Promise.resolve(false),
    () => {
      // 非破坏性标注:发送时刻才把矢量笔迹烧录成位图(模型只认位图)。仅在真的
      // 存在待烧录附件时才走 async 物化——其余消息保持**全同步**发送路径,守住
      // "planMode 点击即消耗 / enqueue 在点击同步栈内发生"的既有语义
      // (planReviewDoneRace 测试守护;CI 曾因无条件 await 让步一拍而红)。
      if (!needsAnnotationMaterialize(files)) {
        return sendMessageCore(
          sessionId,
          text,
          model,
          effort,
          permissionMode,
          workingDir,
          files,
          mentions,
          opts,
          clearGenerationAtStart,
          remoteScopeAtStart,
        );
      }
      if (remoteScopeAtStart) {
        const identity = {
          clientId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        const stripAnnotationMeta = isRemoteMediaSession(sessionId);
        // 先用原图建立稳定 clientId 的本地气泡/outbox，再后台烧录标注。这样
        // ChatInput 立即拿到 true、可继续输入；pump 会被 materializationPending
        // 挡住，绝不会把未烧录 payload 发到被控端。
        const accepted = sendMessageCore(
          sessionId,
          text,
          model,
          effort,
          permissionMode,
          workingDir,
          files,
          mentions,
          opts,
          clearGenerationAtStart,
          remoteScopeAtStart,
          files,
          identity,
          true,
        );
        void accepted.then(
          (optimisticallyAccepted) => {
            if (!optimisticallyAccepted) return;
            void materializeAnnotatedAttachmentsForSend(files, sessionId, {
              stripAnnotationMeta,
            })
              .then((prepared) => {
                completeRemoteOptimisticMaterialization(sessionId, identity.clientId, () =>
                  buildQueuedMessage(
                    sessionId,
                    text,
                    model,
                    effort,
                    permissionMode,
                    workingDir,
                    prepared,
                    mentions,
                    opts,
                    identity,
                  ),
                );
              })
              .catch((error) => {
                const record = remoteOptimisticSendRecords(sessionId)?.get(identity.clientId);
                if (record?.materializationPending) {
                  settleRemoteOptimisticFailure(sessionId, identity.clientId, error);
                }
              });
          },
          () => undefined,
        );
        return accepted;
      }
      return runRemoteOptimisticMaterialization(
        null,
        materializeAnnotatedAttachmentsForSend(files, sessionId, {
          stripAnnotationMeta: isRemoteMediaSession(sessionId),
        }),
        (prepared) =>
          sendMessageCore(
            sessionId,
            text,
            model,
            effort,
            permissionMode,
            workingDir,
            prepared,
            mentions,
            opts,
            clearGenerationAtStart,
            remoteScopeAtStart,
            files,
          ),
      );
    },
  );
}

/** sendMessage 的主体(附件已完成标注物化)。无 await 前置,整个主体同步执行。 */
async function sendMessageCore(
  sessionId: string,
  text: string,
  model: string,
  effort: string,
  permissionMode: string,
  workingDir: string,
  files?: AttachedFile[],
  mentions?: MentionedResource[],
  opts?: SendMessageOpts,
  clearGenerationAtStart = 0,
  remoteScopeAtStart: RemoteOptimisticSendScope | null = null,
  recoveryFiles?: readonly AttachedFile[],
  identity?: { clientId: string; createdAt: string },
  materializationPending = false,
): Promise<boolean> {
  if (
    (remoteClearInFlight.has(sessionId) && !remoteScopeAtStart) ||
    (remoteScopeAtStart
      ? !isRemoteOptimisticSendScopeActive(sessionId, remoteScopeAtStart)
      : (rendererClearGenerationBySession.get(sessionId) ?? 0) !== clearGenerationAtStart)
  ) {
    return false;
  }
  const current = getOrCreateState(sessionId);
  const wasFirst = current.isFirstMessage;

  const queued = buildQueuedMessage(
    sessionId,
    text,
    model,
    effort,
    permissionMode,
    workingDir,
    files,
    mentions,
    opts,
    identity,
  );
  // #2194: 登记本端发送——MessageStream 的强 pin 只认这个集合，外部入口
  // （IM / 手机端 / 定时任务）注入的 user 消息不抢视口。后续路径 return false
  // （如 beforeEnqueue 回滚）会留下一个永不渲染的 id，无害。
  markLocalSentUserMessage(sessionId, queued.clientId);

  const deviceLinkRemote = remoteScopeAtStart !== null;
  const remoteRecord = remoteScopeAtStart
    ? registerRemoteOptimisticSend(
        sessionId,
        queued,
        remoteScopeAtStart.deviceId,
        'queue',
        remoteScopeAtStart.dataOwner,
        remoteScopeAtStart.recoverySequence,
        remoteScopeAtStart.expectedClearBoundaryMs,
        opts,
        recoveryFiles ?? files,
        materializationPending,
      )
    : undefined;
  if (deviceLinkRemote && !remoteRecord) return false;

  // device-link 乐观第一拍：空闲沿用消息流气泡，忙时也立即显示 sending 队列行。
  if (deviceLinkRemote && isSendBusyForQueue(current)) {
    setState(sessionId, (s) =>
      s.pendingQueue.some((item) => item.clientId === queued.clientId)
        ? s
        : { ...s, pendingQueue: [...s.pendingQueue, { ...queued, isPendingEnqueue: true }] },
    );
  } else if (!isSendBusyForQueue(current)) {
    setState(sessionId, (s) =>
      s.messages.some((m) => m.clientId === queued.clientId)
        ? s
        : { ...s, messages: [...s.messages, { ...queued.chatMessage, isPendingPersist: true }] },
    );
  }

  if (!deviceLinkRemote && opts?.beforeEnqueue) {
    try {
      if (!(await opts.beforeEnqueue())) {
        clearRemoteOptimisticSend(sessionId, queued.clientId);
        setState(sessionId, (s) => ({
          ...s,
          pendingQueue: s.pendingQueue.filter((item) => item.clientId !== queued.clientId),
          messages: s.messages.filter(
            (message) => !(message.clientId === queued.clientId && message.isPendingPersist),
          ),
        }));
        return false;
      }
    } catch (err) {
      clearRemoteOptimisticSend(sessionId, queued.clientId);
      setState(sessionId, (s) => ({
        ...s,
        pendingQueue: s.pendingQueue.filter((item) => item.clientId !== queued.clientId),
        messages: s.messages.filter(
          (message) => !(message.clientId === queued.clientId && message.isPendingPersist),
        ),
      }));
      throw err;
    }
  }

  // 一次性契约收口(bot review P2):计划勾选在**点击发送**时消耗——本条消息的计划
  // 意图已定格在行内快照(createOpts.planMode,派发时经 SendOptions.planMode 权威
  // 生效),这里立即熄灭 store/DB/runtime 的勾选,会话忙时连续排队的后续消息不再
  // 重复携带计划意图。(steer 插话不走此消耗:它并入 in-flight turn,勾选留给
  // 下一个真正的新 turn。)
  if (queued.createOpts.planMode === true) {
    void setPlanMode(sessionId, false).catch(() => {
      /* setPlanMode 内部已记日志 */
    });
  }

  // Renderer 只做 UI 乐观排序；DB user_send_at 和队列事务都由 main coordinator
  // 在 enqueue intent 内处理。这里不再本地 mutate pendingQueue，也不再触发 drain。
  touchSessionUserSend(sessionId, workingDir, wasFirst);

  // Auto-naming (F-CHAT-2) — only fires for the first message in the session,
  // and that is by definition not busy (queue would have been dispatched on a
  // previous turn). Safe to leave outside the isBusy branch.
  // 首条与补起名共用同一套素材推导:用户没打字时 seed.isUserText=false,
  // 只写合成占位、不调标题模型。
  const commitAutoTitle = (titleQueued = queued) => {
    const autoTitleSeed = deriveAutoTitleSeed(titleQueued, autoTitleFallbackLabels());
    if (wasFirst) {
      // 用会话真实 agentKind 起名 — 之前写死 'claude-code',导致 Codex 会话也
      // 用 Claude haiku 起标题:纯 Codex 用户(无 Claude 鉴权)会 oneShot 失败 →
      // fallback 原话,表现为"Codex 会话标题没有智能总结"。current.agentKind 已是
      // maker 格式('claude-code' | 'codex' | 'pi'),直接透传。起名走立即占位 + 后台覆盖。
      if (autoTitleSeed) {
        scheduleAutoName(
          sessionId,
          autoTitleSeed.text,
          current.agentKind,
          autoTitleSeed.isUserText,
        );
      }
      return;
    }
    // 补起名:首条是纯附件(只贴图没打字)、标题还是合成占位或默认名的会话,以及
    // fork 出来的占位标题会话,都在第一条带文字的消息上把标题换成用户写的内容。
    maybeAutoNameUnnamedSession(sessionId, autoTitleSeed, current.agentKind);
  };
  if (materializationPending && remoteRecord) {
    remoteRecord.onMaterializationReady = commitAutoTitle;
  } else {
    commitAutoTitle();
  }

  if (deviceLinkRemote && remoteRecord) {
    // Device-link sends are locally accepted as soon as their immutable outbox
    // record and optimistic projection exist. The pump owns even the first
    // preflight/invoke so a weak link never holds the composer dispatch lock.
    remoteRecord.composerResolvedOptimistically = true;
    void pumpRemoteOptimisticSends(sessionId);
    return true;
  }

  const operation = beginInputProjectionOperation(sessionId);
  return operation.api.input
    .enqueue(sessionId, queued, { sendAtMs: Date.now() })
    .then((projection) => {
      if (opts?.authRetryPersistOnProjectionError) {
        setState(sessionId, (s) => ({
          ...s,
          _authRetryPersistOnProjectionError: {
            clientId: queued.clientId,
            ...opts.authRetryPersistOnProjectionError!,
          },
        }));
      }
      const applied = applyInputProjectionOperationResponse(sessionId, operation, projection);
      if (applied) markSessionHasUserMessage(sessionId);
      return true;
    })
    .catch((err) => {
      // 远端 lazy-create/startSession 抛的 [REMOTE_*] 不可恢复错误走 IPC reject 落这里
      // (不经 stream error event reducer),同样要解码成 i18n 文案,别裸显 bracket code。
      const message = decodeRemoteErrorMessage(err instanceof Error ? err.message : String(err));
      setState(sessionId, (s) => ({
        ...s,
        error: message,
        usageLimitRecovery: null,
        errorReason: null,
        recoverableError: null,
        errorRetryText: null,
      }));
      return false;
    });
}

function compactSession(
  sessionId: string,
  model: string,
  effort: string,
  permissionMode: string,
  workingDir: string,
  opts?: { vendorOptions?: Record<string, unknown> },
): Promise<boolean> {
  if (!sessionId || !workingDir) return Promise.resolve(false);
  const current = getOrCreateState(sessionId);
  if (current.agentKind === 'codex') return Promise.resolve(false);
  const createOpts = buildCreateOptsForCurrentSession(
    sessionId,
    model,
    effort,
    permissionMode,
    workingDir,
    opts,
  );
  // /compact 是控制 turn(上下文压缩), 与 sendUiTrigger 同口径: 显式普通执行,
  // 不进计划模式、不消耗用户的一次性勾选(false 语义见 SendOptions.planMode)。
  createOpts.planMode = false;
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  return (
    runAgentDispatchProjectionOperation(sessionId, (input) =>
      input.compact(sessionId, createOpts, {
        userName: currentUserName,
        ...(boundaryOpts ?? {}),
      }),
    )
      // RPC 已执行成功时保留既有返回语义；origin 漂移只丢控制端镜像回写。
      .then(({ projection }) => projection.error === null)
      .catch((err) => {
        const message = decodeRemoteErrorMessage(err instanceof Error ? err.message : String(err));
        setState(sessionId, (s) => ({
          ...s,
          error: message,
          usageLimitRecovery: null,
          recoverableError: null,
          errorRetryText: null,
        }));
        return false;
      })
  );
}

function steerMessage(
  sessionId: string,
  text: string,
  model: string,
  effort: string,
  permissionMode: string,
  workingDir: string,
  files?: AttachedFile[],
  mentions?: MentionedResource[],
  opts?: {
    vendorOptions?: Record<string, unknown>;
    quotesEncoded?: boolean;
    agentReferences?: AgentInputReference[];
    pastedTextRanges?: PastedTextRange[];
    slashCommandRanges?: SlashCommandRange[];
    beforeEnqueue?: () => Promise<boolean>;
    onRemoteOptimisticFailure?: (clientId: string, error?: unknown) => void;
  },
): Promise<boolean> {
  if (!sessionId || (!text.trim() && (!files || files.length === 0)) || !workingDir) {
    return Promise.resolve(false);
  }
  if (isRemoteDeletedSessionSendBlocked(sessionId)) return Promise.resolve(false);
  const remoteScopeAtStart = captureRemoteOptimisticSendScope(
    sessionId,
    opts?.onRemoteOptimisticFailure,
  );
  if (remoteClearInFlight.has(sessionId) && !remoteScopeAtStart) return Promise.resolve(false);
  if (remoteScopeAtStart && !isRemoteOptimisticSendScopeActive(sessionId, remoteScopeAtStart)) {
    return Promise.resolve(false);
  }
  const clearGenerationAtStart =
    remoteScopeAtStart?.clearGeneration ?? rendererClearGenerationBySession.get(sessionId) ?? 0;
  const current = getOrCreateState(sessionId);
  if (!canStartComposerSteer(current)) {
    // 镜像里有在飞 steer 事务 → 静默拒绝对用户就是"没反应", 留痕 + 主动向
    // main 拉一次 projection 自愈: 若镜像 stale (漏收 emit), 下一次点击就能恢复。
    log.warn('steerMessage rejected: steering marker present in mirror', {
      sessionId,
      steeringQueueClientIds: current.steeringQueueClientIds,
      queueAbortPending: current.queueAbortPending,
    });
    requestInputProjection(sessionId);
    return Promise.resolve(false);
  }
  return withAgentSendDispatch(
    sessionId,
    () => Promise.resolve(false),
    () => {
      // 同 sendMessage:无待烧录附件走全同步路径;有则物化后进同一核心。
      if (!needsAnnotationMaterialize(files)) {
        return steerMessageCore(
          sessionId,
          text,
          model,
          effort,
          permissionMode,
          workingDir,
          files,
          mentions,
          opts,
          clearGenerationAtStart,
          remoteScopeAtStart,
        );
      }
      if (remoteScopeAtStart) {
        const identity = {
          clientId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };
        const stripAnnotationMeta = isRemoteMediaSession(sessionId);
        const accepted = steerMessageCore(
          sessionId,
          text,
          model,
          effort,
          permissionMode,
          workingDir,
          files,
          mentions,
          opts,
          clearGenerationAtStart,
          remoteScopeAtStart,
          files,
          identity,
          true,
        );
        void accepted.then(
          (optimisticallyAccepted) => {
            if (!optimisticallyAccepted) return;
            void materializeAnnotatedAttachmentsForSend(files, sessionId, {
              stripAnnotationMeta,
            })
              .then((prepared) => {
                completeRemoteOptimisticMaterialization(sessionId, identity.clientId, () =>
                  buildQueuedMessage(
                    sessionId,
                    text,
                    model,
                    effort,
                    permissionMode,
                    workingDir,
                    prepared,
                    mentions,
                    opts,
                    identity,
                  ),
                );
              })
              .catch((error) => {
                const record = remoteOptimisticSendRecords(sessionId)?.get(identity.clientId);
                if (record?.materializationPending) {
                  settleRemoteOptimisticFailure(sessionId, identity.clientId, error);
                }
              });
          },
          () => undefined,
        );
        return accepted;
      }
      return runRemoteOptimisticMaterialization(
        null,
        materializeAnnotatedAttachmentsForSend(files, sessionId, {
          stripAnnotationMeta: isRemoteMediaSession(sessionId),
        }),
        (prepared) =>
          steerMessageCore(
            sessionId,
            text,
            model,
            effort,
            permissionMode,
            workingDir,
            prepared,
            mentions,
            opts,
            clearGenerationAtStart,
            remoteScopeAtStart,
            files,
          ),
      );
    },
  );
}

/** steerMessage 的主体(附件已完成标注物化)。 */
async function steerMessageCore(
  sessionId: string,
  text: string,
  model: string,
  effort: string,
  permissionMode: string,
  workingDir: string,
  files?: AttachedFile[],
  mentions?: MentionedResource[],
  opts?: {
    vendorOptions?: Record<string, unknown>;
    quotesEncoded?: boolean;
    agentReferences?: AgentInputReference[];
    pastedTextRanges?: PastedTextRange[];
    slashCommandRanges?: SlashCommandRange[];
    beforeEnqueue?: () => Promise<boolean>;
    onRemoteOptimisticFailure?: (clientId: string, error?: unknown) => void;
  },
  clearGenerationAtStart = 0,
  remoteScopeAtStart: RemoteOptimisticSendScope | null = null,
  recoveryFiles?: readonly AttachedFile[],
  identity?: { clientId: string; createdAt: string },
  materializationPending = false,
): Promise<boolean> {
  if (
    (remoteClearInFlight.has(sessionId) && !remoteScopeAtStart) ||
    (remoteScopeAtStart
      ? !isRemoteOptimisticSendScopeActive(sessionId, remoteScopeAtStart)
      : (rendererClearGenerationBySession.get(sessionId) ?? 0) !== clearGenerationAtStart)
  ) {
    return false;
  }
  const queued = buildQueuedMessage(
    sessionId,
    text,
    model,
    effort,
    permissionMode,
    workingDir,
    files,
    mentions,
    opts,
    identity,
  );
  // #2194: 与 sendMessageCore 相同——本端 steer 也是明确的本地发送意图。
  markLocalSentUserMessage(sessionId, queued.clientId);
  const deviceLinkRemote = remoteScopeAtStart !== null;
  const remoteDeviceId = remoteScopeAtStart?.deviceId;
  const remoteRecord = remoteScopeAtStart
    ? registerRemoteOptimisticSend(
        sessionId,
        queued,
        remoteScopeAtStart.deviceId,
        'steer',
        remoteScopeAtStart.dataOwner,
        remoteScopeAtStart.recoverySequence,
        remoteScopeAtStart.expectedClearBoundaryMs,
        opts,
        recoveryFiles ?? files,
        materializationPending,
      )
    : undefined;
  if (deviceLinkRemote && !remoteRecord) return false;
  if (deviceLinkRemote) {
    setState(sessionId, (s) =>
      s.messages.some((message) => message.clientId === queued.clientId)
        ? s
        : { ...s, messages: [...s.messages, { ...queued.chatMessage, isPendingPersist: true }] },
    );
  }
  const rollbackOptimisticSteer = () => {
    if (!deviceLinkRemote) return;
    clearRemoteOptimisticSend(sessionId, queued.clientId);
    setState(sessionId, (s) => ({
      ...s,
      messages: s.messages.filter(
        (message) => !(message.clientId === queued.clientId && message.isPendingPersist),
      ),
    }));
  };
  if (!deviceLinkRemote && opts?.beforeEnqueue) {
    try {
      if (!(await opts.beforeEnqueue())) {
        rollbackOptimisticSteer();
        return false;
      }
    } catch (err) {
      rollbackOptimisticSteer();
      throw err;
    }
  }
  touchSessionUserSend(sessionId, workingDir, false);
  // 补起名同样要覆盖 steer:首条是纯附件的会话标题此时是合成占位,而用户完全
  // 可能趁这一轮还在跑就用「插话」写下第一句话。只走普通发送的话,这句话不会
  // 改名,标题会一直停在附件名直到他再排队发一条(PR #510 review P1)。
  // 素材在入队前推导(此刻 queued 还在手里),但**只有输入被受理才改名**:同会话
  // 已有在飞 steer / Stop 边界 / 输入锁都会让它被拒,拒掉的文本不该改名。
  const agentKind = getOrCreateState(sessionId).agentKind;
  const commitAutoTitle = (titleQueued = queued) =>
    maybeAutoNameUnnamedSession(
      sessionId,
      deriveAutoTitleSeed(titleQueued, autoTitleFallbackLabels()),
      agentKind,
    );
  if (deviceLinkRemote && remoteRecord) {
    // Match ordinary remote sends: the first steer attempt also belongs to the
    // outbox pump, so an invoke timeout cannot keep Send disabled. Auto-title
    // follows the local acceptance point and permanent failure restores text.
    if (materializationPending) remoteRecord.onMaterializationReady = commitAutoTitle;
    else commitAutoTitle();
    remoteRecord.composerResolvedOptimistically = true;
    void pumpRemoteOptimisticSends(sessionId);
    return true;
  }

  const steerApi = remoteDeviceId ? makerApiForDevice(remoteDeviceId) : makerApiFor(sessionId);
  return steerApi.input
    .steer(sessionId, queued, { touchUserSend: true })
    .then(async (ok) => {
      if (ok) {
        commitAutoTitle();
        requestInputProjection(sessionId);
        return true;
      }
      // steer 失败后拉一次权威 projection:投递结果不确定时 coordinator 会把这条
      // 消息物化进暂停队列(ack 超时 / post-send abort)。物化即"已处置"——文本
      // 由队列行接管显示,这里必须返回 true 让 composer 清空草稿,否则用户面前
      // 同时存在暂停行 + 草稿,再次发送会双份消费(review #939 第五轮)。
      try {
        const operation = beginInputProjectionOperation(sessionId, remoteDeviceId);
        const latest = await operation.api.input.getProjection(sessionId);
        const latestHasQueuedItem = latest.pendingQueue.some((q) => q.clientId === queued.clientId);
        if (!applyInputProjectionOperationResponse(sessionId, operation, latest)) {
          rollbackOptimisticSteer();
          return false;
        }
        if (latestHasQueuedItem) {
          // 物化进队列 = 这条输入已被主端接管、日后会派发,与受理同等 —— 起名也要
          // 跟上,否则纯附件/fork 之后的第一句话恰好在这条不确定路径上不改名
          // (review P1)。是否真该改名仍由 main 权威判定。
          commitAutoTitle();
          return true;
        }
      } catch (err) {
        log.warn('steer materialization check failed:', err);
      }
      rollbackOptimisticSteer();
      return false;
    })
    .catch((err) => {
      // 远端 lazy-create/startSession 抛的 [REMOTE_*] 不可恢复错误走 IPC reject 落这里
      // (不经 stream error event reducer),同样要解码成 i18n 文案,别裸显 bracket code。
      const message = decodeRemoteErrorMessage(err instanceof Error ? err.message : String(err));
      rollbackOptimisticSteer();
      setState(sessionId, (s) => ({
        ...s,
        error: message,
        usageLimitRecovery: null,
        recoverableError: null,
        errorRetryText: null,
      }));
      return false;
    });
}

/** 被拦消息重发在途集合(clientId):find 与撤气泡之间隔一个会话行 await,
 *  连点两次会重发两条——in-flight 守卫把第二次挡在门口。 */
const resendBlockedInFlight = new Set<string>();

/**
 * 订阅槽①:被拦消息经消息流编辑铅笔重发(UserMessageEditBox 的 commit 覆盖)。
 * 被拦消息从未落库、无 turn 可 rewind,所以走普通 sendMessage(不 rewind);
 * **不 bypass 钩子**——用户改干净了自然通过,没改干净就再次被拦(拦截即
 * 发不出去,没有强制放行)。newText = 编辑后的文本。发送参数从会话行现取。
 * 失败抛错,让 EditBox 保留编辑态。
 */
async function resendBlockedMessage(
  sessionId: string,
  clientId: string,
  newText: string,
  opts?: {
    quotesEncoded?: boolean;
    agentReferences?: AgentInputReference[];
    pastedTextRanges?: PastedTextRange[];
    slashCommandRanges?: SlashCommandRange[];
  },
): Promise<void> {
  if (!sessionId || !clientId) throw new Error('resendBlockedMessage: missing session/client id');
  if (resendBlockedInFlight.has(clientId)) return;
  const state = getOrCreateState(sessionId);
  const msg = state.messages.find((m) => m.clientId === clientId && m.blockedByGhost);
  if (!msg) throw new Error('resendBlockedMessage: message not found');
  // 会话行读取也是本次用户重发的一部分；token 必须在第一个 await 前登记。
  const finishAgentSendDispatch = tryBeginAgentSendDispatch(sessionId);
  if (!finishAgentSendDispatch) throw new Error('Agent switch is still in progress');
  resendBlockedInFlight.add(clientId);
  try {
    const row = await sessionService.get(sessionId);
    if (!row.workingDir || !row.model)
      throw new Error('resendBlockedMessage: session row missing model/workingDir');
    // 先撤掉被拦气泡(重发会 push 一条新 clientId 的乐观气泡,避免两条并存)。
    setState(sessionId, (s) => ({
      ...s,
      messages: s.messages.filter((m) => m.clientId !== clientId),
    }));
    try {
      const dispatched = await sendMessage(
        sessionId,
        newText,
        row.model,
        row.effort ?? 'medium',
        row.permissionMode ?? 'default',
        row.workingDir,
        msg.retryFiles,
        msg.retryMentions,
        opts?.quotesEncoded ||
          opts?.agentReferences?.length ||
          opts?.pastedTextRanges?.length ||
          opts?.slashCommandRanges !== undefined
          ? {
              ...(opts?.quotesEncoded ? { quotesEncoded: true } : {}),
              ...(opts?.agentReferences?.length ? { agentReferences: opts.agentReferences } : {}),
              ...(opts?.pastedTextRanges?.length
                ? { pastedTextRanges: opts.pastedTextRanges }
                : {}),
              ...(opts?.slashCommandRanges !== undefined
                ? { slashCommandRanges: opts.slashCommandRanges }
                : {}),
            }
          : undefined,
      );
      if (!dispatched) throw new Error('resendBlockedMessage: enqueue failed');
    } catch (err) {
      // 派发失败:把被拦气泡塞回原处再抛——气泡一撤 EditBox 即随组件卸载,
      // "失败抛错让 EditBox 保留编辑态"的承诺就落空了,用户编辑的文本会凭空
      // 消失。恢复后气泡仍是被拦态,用户可再点编辑重试。
      setState(sessionId, (s) =>
        s.messages.some((m) => m.clientId === clientId)
          ? s
          : { ...s, messages: [...s.messages, msg] },
      );
      throw err;
    }
  } finally {
    resendBlockedInFlight.delete(clientId);
    finishAgentSendDispatch();
  }
}

function steerQueuedMessage(sessionId: string, clientId: string): Promise<boolean> {
  if (!sessionId || !clientId) return Promise.resolve(false);
  // Capture the target before entering the dispatch coordinator. A relay
  // reconnect may clear remoteProjectsStore while the coordinator is waiting;
  // retrying through makerApiFor(sessionId) in that window would address the
  // controller's local maker instead of the queued message's host.
  const remoteDeviceId = getStickySessionDeviceId(sessionId);
  const steerApi = remoteDeviceId ? makerApiForDevice(remoteDeviceId) : makerApiFor(sessionId);
  const current = getOrCreateState(sessionId);
  const queued = current.pendingQueue.find((q) => q.clientId === clientId);
  if (!queued) {
    // 行已被 drain/移除但 UI 还没刷过来 (race)。留痕 + 拉 projection 重同步。
    log.warn('steerQueuedMessage rejected: clientId not in pendingQueue mirror', {
      sessionId,
      clientId,
    });
    requestInputProjection(sessionId);
    return Promise.resolve(false);
  }
  if (!canStartQueuedSteer(current, clientId)) {
    // 同 steerMessage: 静默拒绝必须留痕, 并自愈可能 stale 的镜像。
    log.warn('steerQueuedMessage rejected: steering marker present in mirror', {
      sessionId,
      clientId,
      steeringQueueClientIds: current.steeringQueueClientIds,
      queueAbortPending: current.queueAbortPending,
    });
    requestInputProjection(sessionId);
    return Promise.resolve(false);
  }
  return withAgentSendDispatch(
    sessionId,
    () => Promise.resolve(false),
    () => {
      // #2194 (Codex review P1): main 的 steer 在返回成功**之前**就
      // persistAcceptedUserMessage，onCreated 推送可能抢在回执登记前把该行
      // 基线化为外部消息——校验通过后、IPC 之前先登记，确定失败再回滚
      // （unmark 不会复活已 purge 会话的条目）。
      markLocalSentUserMessage(sessionId, clientId);
      return steerApi.input
        .steer(sessionId, queued, {
          removeFromQueue: true,
          ...getRemoteInputClearBoundaryOpts(sessionId),
        })
        .then((ok) => {
          if (!ok) unmarkLocalSentUserMessage(sessionId, clientId);
          requestInputProjection(sessionId);
          return ok;
        })
        .catch((err) => {
          unmarkLocalSentUserMessage(sessionId, clientId);
          // 远端 lazy-create/startSession 抛的 [REMOTE_*] 不可恢复错误走 IPC reject 落这里
          // (不经 stream error event reducer),同样要解码成 i18n 文案,别裸显 bracket code。
          const message = decodeRemoteErrorMessage(
            err instanceof Error ? err.message : String(err),
          );
          setState(sessionId, (s) => ({
            ...s,
            error: message,
            usageLimitRecovery: null,
            recoverableError: null,
            errorRetryText: null,
          }));
          return false;
        });
    },
  );
}

/**
 * User-initiated stop. NOT called on session switch — that was the bug we
 * are fixing. Only fires when the user clicks the Stop button (or any other
 * explicit intent to abort).
 *
 * Queue semantics (2026-06): Stop no longer means "clear or shift gears" when
 * there are pending messages. If the caller keeps the queue, Stop aborts the
 * current turn and puts the queue into an explicit paused state; only the
 * queue's Continue button resumes drain. This avoids the old surprise where a
 * user stopped the current task but the next queued message immediately fired.
 */
function stopSession(
  sessionId: string,
  opts?: {
    keepQueue?: boolean;
    pauseQueue?: boolean;
    expectedClearBoundaryMs?: number | null;
  },
): void {
  if (!sessionId) return;
  const remoteDeviceId = getStickySessionDeviceId(sessionId);
  // Stop 的乐观终态必须立即作废此前同源查询与旧操作；不能等响应回来，
  // 否则旧结果会在 abort 往返期间把刚清掉的 owner 重新写回。先推进再捕获，
  // 让 Stop 自己的权威响应仍属于新代际。
  bumpInteractionReconcileEpoch(sessionId);
  supersedeInputProjectionRequests(sessionId, { supersedeOperations: true });
  const operation = beginInputProjectionOperation(sessionId, remoteDeviceId);
  const clearBoundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  const stopOpts =
    opts || clearBoundaryOpts
      ? {
          ...(opts ?? {}),
          ...(clearBoundaryOpts ?? {}),
        }
      : undefined;
  operation.api.input
    .stop(sessionId, stopOpts)
    .then((projection) => {
      applyInputProjectionOperationResponse(sessionId, operation, projection);
    })
    .catch((err) => log.warn('maker.input.stop failed:', err));
  // 控制请求必须先跨过 preload IPC。事故现场积压了 1,500+ 条大体积 tool/DB 事件；
  // 本地文本与 DB 批次收口即便变慢，也不能把真正的 turn/interrupt 挡在它们后面。
  flushPendingTextDelta(sessionId);
  setState(sessionId, (s) => {
    const id = s.streamingClientId;
    // F7.6 / FP-3: expire any pending ask_user + plan_review messages on stop
    const msgs = removeResumePendingCards(
      s.messages.map((m) => {
        if (id && m.clientId === id) return { ...m, isStreaming: false };
        if (m.role === 'ask_user' && m.askUserStatus === 'pending') {
          return { ...m, askUserStatus: 'expired' as const };
        }
        if (m.role === 'plan_review' && m.planReviewStatus === 'pending') {
          return { ...m, planReviewStatus: 'expired' as const };
        }
        return m;
      }),
    );

    return {
      ...s,
      messages: msgs,
      streamingClientId: null,
      streamingText: '',
      isStreaming: false,
      recoverableError: null,
      activeTurnRetryText: null,
      errorRetryText: null,
      pendingPermission: null,
      continuationTurnClientId: null,
      pendingAskUser: null,
      // F-AUQ-MIN-5: Stop session — pending question is gone, reset viewer.
      askUserViewerState: 'expanded',
      // F-AUQ-DRAFT: Stop wipes the question, draft is no longer meaningful.
      askUserDraft: null,
      pendingPlanReview: null,
      // 用户主动 Stop:wake 型 running 任务标 stopped、唤醒桥接清零,让 running
      // 快照立即回落。只收 wake 型——后台 bash / codex 任务不因 interrupt 而死,
      // 全标会造成 tasks 面板窗口期显示错(review P2)。若 SDK 侧任务实际还活着,
      // 后续 task_progress 会把条目翻回 running,状态自愈。
      taskUpdates: stopRunningAgentTasks(s.taskUpdates, 'wake'),
      pendingTaskWake: false,
      agentStatus: {
        status: 'Idle',
        // Preserve all token/cost values — ring keeps showing last known context capacity
        tokenUsage: s.agentStatus.tokenUsage,
        costUsd: s.agentStatus.costUsd,
        contextTokens: s.agentStatus.contextTokens,
        contextWindow: s.agentStatus.contextWindow,
        isRunning: false,
        startedAt: null,
      },
    };
  });

  // No immediate drain here. If pauseQueue=true, Continue may clear queuePaused
  // before the abort has actually settled, so queueAbortPending keeps the drain
  // closed until the abort promise or a turn boundary releases it.
}

/**
 * F-QUEUE-3 legacy helper: Pop the most recently enqueued (un-dispatched) user
 * message and write its text back to the ChatInput composer.
 *
 * The current Stop button no longer calls this. Stop now pauses the queue; this
 * helper is kept for any explicit "undo queued draft" affordance that may come
 * back later.
 *
 * Returns true when a queued message was popped (caller should NOT proceed to
 * abort), false when the queue was empty (caller should run stopSession).
 *
 * F-QUEUE-DEFER (2026-05): bubble is no longer pushed at sendMessage time, so
 * the historical messages.filter(clientId) below is a no-op for tail entries
 * (they never had a bubble). Kept for safety in case a future code path pushes
 * a bubble before queueing.
 *
 * Behavior:
 *  - Removes the tail QueuedMessage from `pendingQueue`.
 *  - Overwrites the composer draft with the queued text (attachments are
 *    intentionally dropped — a future enhancement could deserialize them).
 *  - Does NOT call abort and does NOT touch isStreaming / pendingPermission /
 *    pendingAskUser / pendingPlanReview — the in-flight turn keeps running.
 */
function popQueueTail(sessionId: string): boolean {
  if (!sessionId) return false;
  const current = getOrCreateState(sessionId);
  const result = popQueueTailState(current);
  if (!result.tail) return false;

  setState(sessionId, () => result.state);

  // Notify ChatInput's draft subscriber so it force-setContent the editor.
  // Default (non-silent) so the listener fires.
  saveComposerDraft(sessionId, {
    text: plainTextToTiptapDoc(result.tail.text),
    attachments: [],
  });

  return true;
}

/**
 * Dismiss the error banner without retrying. Pure UI state — no persistence.
 */
function clearError(sessionId: string): void {
  if (!sessionId) return;
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  runInputProjectionOperation(sessionId, (input) =>
    boundaryOpts ? input.clearError(sessionId, boundaryOpts) : input.clearError(sessionId),
  ).catch((err) => log.warn('clearError failed:', err));
  setState(sessionId, (s) => {
    if (
      s.error == null &&
      s.usageLimitRecovery == null &&
      s.recoverableError == null &&
      s.errorRetryText == null
    ) {
      return s;
    }
    return {
      ...s,
      error: null,
      usageLimitRecovery: null,
      errorReason: null,
      recoverableError: null,
      errorRetryText: null,
    };
  });
}

function retryLastError(sessionId: string): Promise<void> {
  if (!sessionId) return Promise.resolve();
  // 续跑语义在 main:coordinator 判定失败 turn 已有 assistant 产出时,用共享英文
  // 常量 CONTINUE_AFTER_ERROR_PROMPT 替代重发原文(shared/interruptedTurn.ts),
  // renderer 不传文案、不做判定。
  // retryLastError 在 main 内会先 await 历史查询再入队，必须从点击时刻起占住与
  // Agent 切换共享的发送 token；否则后点的切换能越过这段查询，让重试改由新 Agent 执行。
  // #2194 (review P1): 人工 Retry 是本地意图，但重试项由 main 在
  // performRetryLastError 以**新 clientId** 生成，发送侧登记不到。权威归属：
  // 人工 retry 的零产出克隆项自带 `supersedesUserClientId`（仅 manual 非 auto
  // 路径设置，见 agent-input-coordinator.ts），直接按字段辨认——不猜队首差分
  // （异步窗口内可能混入外部入队）、不做文本猜测（维护者口径，#2222）。
  // 有产出分支的隐藏续跑指令由 main 显式清掉 supersedes 字段，但它同样是本次
  // 点击的产物：按 `originalSyntheticTrigger === 'continue'` 且非 autoResume
  // 辨认（auto 自动续跑不是用户动作，不标记；Codex review P1）。
  // queue-head（派发前失败）分支 main 原样重发**既有队首项**——没有新
  // clientId、没有 supersedesUserClientId。以点击时刻镜像的 inputRecovery
  // （projection 线上自带字段）取权威 clientId；重载后内存标记丢失时，续跑
  // 落库的新行仍能识别为本端意图（Codex review P2）。
  const preRetryRecovery = sessions.get(sessionId)?.inputRecovery ?? null;
  const preRetryQueueHeadClientId =
    preRetryRecovery?.kind === 'queue-head' ? preRetryRecovery.clientId : null;
  // 点击时刻的队列快照：回执里只登记**新出现**的项。点击前就在队列里的外部
  // 入队项（例如被 main 按文本标记 originalSyntheticTrigger='continue' 的
  // 外部项）不属于本次点击的产物，不能误认（Greptile review P1）。
  const preRetryQueueIds = new Set(
    (sessions.get(sessionId)?.pendingQueue ?? []).map((item) => item.clientId),
  );
  // active-turn 重试的产物 clientId 由 main 生成、点击时刻未知，而 main 的
  // scheduleDrain（queueMicrotask）可能抢在 IPC 回执前把产物行落库——但
  // main 的 emit 先于 scheduleDrain，投影事件更早。记下一次性意图（含点击
  // 时刻队列快照），applyInputProjection 凭意图同步认领（Codex review P1）；
  // 回执 settle 时清理。queue-head 分支不产生新项，走下面的 id 预登记。
  if (preRetryRecovery?.kind === 'active-turn') {
    pendingLocalRetryIntents.set(sessionId, { queueIds: preRetryQueueIds });
  }
  // queue-head 重试的 clientId 点击时刻已知，但 main 的 scheduleDrain 经
  // queueMicrotask 在返回 projection 前就会跑，重发的队首行可能抢在回执
  // 回调前落库、被基线化为外部（Codex review P2）：先预登记，回执确认未
  // 生效或 IPC 失败再回滚（会话已 purge 时回滚为 no-op）。
  if (preRetryQueueHeadClientId) {
    markLocalSentUserMessage(sessionId, preRetryQueueHeadClientId);
  }
  const boundaryOpts = getRemoteInputClearBoundaryOpts(sessionId);
  return runAgentDispatchProjectionOperation(sessionId, (input) =>
    boundaryOpts ? input.retryLastError(sessionId, boundaryOpts) : input.retryLastError(sessionId),
  ).then(
    ({ projection }) => {
      // 一次性意图的兜底清理：正常路径下 applyInputProjection 已凭意图认领
      // 并消费；未消费时（投影 stale 被丢 / 顺序异常）回执扫描仍是 fallback。
      pendingLocalRetryIntents.delete(sessionId);
      // 扫**回执自带的投影快照**而非当前 state：回执由 main 在 scheduleDrain 之前
      // 同步生成（agent-input-coordinator.ts performRetryLastError 末尾），必然含
      // 本次克隆；drain 可能抢在本回调前消费克隆并推送新投影覆盖 state
      // （Greptile review P1），那时扫 state.pendingQueue 会漏记。
      // 会话在 retry settle 前被 purge 时不登记——否则会把 localSentUserMessageIds
      // 条目重新创建出来（泄漏 + 同 id 会话重建后旧标记复活，Copilot review nit）。
      // purge 本身会清掉预登记，这里直接返回即可。
      if (!sessions.has(sessionId)) return;
      // 本次 retry 生效（outcome 'resumed'）时 main 在 unshift 前同步清掉
      // error / recovery，回执必然双空；superseded / no-op 时 recovery 原样
      // 保留，回执里根本没有本次点击的产物——并发出现在队首的外部 continue
      // 项不得误认（Greptile review P1）。
      const retryTookEffect = projection.error === null && projection.recovery === null;
      if (retryTookEffect) {
        for (const item of projection.pendingQueue) {
          if (preRetryQueueIds.has(item.clientId)) continue;
          if (item.supersedesUserClientId) {
            markLocalSentUserMessage(sessionId, item.clientId);
          } else if (
            item.originalSyntheticTrigger === 'continue' &&
            item.autoResume !== true &&
            projection.pendingQueue[0]?.clientId === item.clientId
          ) {
            // 有产出人工 retry 的隐藏续跑指令：合成行渲染 null，不登记则续跑产出
            // 在屏幕外开始（Codex review P1）。auto 自动续跑不标记。
            // 还须是回执队首：retry 生效时 main 把本次续跑指令 unshift 到队首，
            // 且 unshift → getProjection 之间无 await（同步），队首必然是本次
            // 产物；并发的外部入队项只会被压在下面（Greptile review P1）。
            markLocalSentUserMessage(sessionId, item.clientId);
          }
        }
      }
      // queue-head 重试的预登记确认：仅当回执确认本次重试生效（error 清空且
      // recovery 已清）且**队首项仍在回执队列**（被本次 retry 重新武装，main
      // 同步 getProjection 先于 drain）才保留；若已被并发 drain 消费派发
      // （不在队列）或本次 retry 实为 superseded / no-op，回滚预登记——留着
      // 会让该外部行落库时误触发强制回底（Greptile review P1）。
      if (
        preRetryQueueHeadClientId &&
        !(
          retryTookEffect &&
          projection.pendingQueue.some((item) => item.clientId === preRetryQueueHeadClientId)
        )
      ) {
        unmarkLocalSentUserMessage(sessionId, preRetryQueueHeadClientId);
      }
    },
    (err) => {
      // IPC 失败：本次点击没有产生任何效果，清意图 + 回滚 queue-head 预登记。
      pendingLocalRetryIntents.delete(sessionId);
      if (preRetryQueueHeadClientId) {
        unmarkLocalSentUserMessage(sessionId, preRetryQueueHeadClientId);
      }
      throw err;
    },
  );
}

/**
 * silent-stop 耗尽横幅的「继续」按钮:清横幅 + 以合成 UI 动作发一条隐藏续跑指令
 * (复用 CONTINUE_AFTER_ERROR_PROMPT,与 coordinator 失败续跑同语义;renderer 按
 * [UI_ACTION_TRIGGER] 前缀过滤,不渲染气泡)。它走 sendUiTrigger → coordinator
 * enqueue → makerSendTransaction 落库,天然给 main 的 silent-stop 守卫充值额度
 * (点击是真实人类动作)。与 retryLastError 不同:耗尽横幅是 main 合成事件,
 * coordinator 无 recovery 状态,retryLastError 会 no-op,必须走本方法。
 */
function continueAfterSilentStop(sessionId: string): void {
  if (!sessionId) return;
  void sendUiTrigger(sessionId, CONTINUE_AFTER_ERROR_PROMPT).then(
    () => {
      setState(sessionId, (s) => ({
        ...s,
        error: null,
        usageLimitRecovery: null,
        errorReason: null,
        errorRetryText: null,
      }));
    },
    (err) => {
      log.warn('continueAfterSilentStop failed:', err);
    },
  );
}

/**
 * error-tail-banner:「忽略/关闭」会话尾部的 role='error' 行(中断标记行与普通
 * 失败行共用)。乐观更新内存消息的 errorDismissed(banner 判定即时熄灭,切换会话
 * 回来不复现),再走 dismiss-error 持久化(main 侧 merge,不丢原字段)。
 * dismissErrorMessageFor 按会话来源路由:远程会话经隧道写到被控端 DB(allowlist
 * 窄口径写),重连/历史重拉后不复活;老被控端不识别该 channel 时 catch 吞错,
 * 退化为本视图内存隐藏。
 *
 * 返回值 = **是否落库成功**(不会 reject):红点是告警查询的派生投影,调用方必须
 * 等落库完成再重算,否则重算会与这次异步写竞态 —— 读到旧状态就仍判定告警存在,
 * 横幅已消失而红点卡住。远程会话的调用方还要靠这个布尔决定是否发 explicit ack:
 * 隧道写失败时不能清红点,否则横幅已回滚重现而红点没了(PR #879 review P1)。
 *
 * 落库失败时**回滚乐观更新**(errorDismissed 置回 false):否则横幅已被乐观隐藏、
 * 而库里的告警仍在,重算会把红点恢复,用户看到「红点在但没有横幅可处置」,只能重载
 * 才恢复。回滚后横幅重新出现,与红点重新一致,用户可以再试。
 */
function dismissErrorTailMessage(sessionId: string, clientId: string): Promise<boolean> {
  if (!sessionId || !clientId) return Promise.resolve(false);
  const setDismissed = (dismissed: boolean): void => {
    setState(sessionId, (s) => ({
      ...s,
      messages: s.messages.map((m) =>
        m.clientId === clientId && m.role === 'error' ? { ...m, errorDismissed: dismissed } : m,
      ),
    }));
  };
  setDismissed(true);
  // 收敛成 Promise<boolean>:dismissErrorMessageFor 返回 Promise<unknown>(IPC 结果),
  // 调用方只关心「写成功了没有」。
  return dismissErrorMessageFor(sessionId, clientId).then(
    () => true,
    (err: unknown) => {
      log.warn('persist error dismiss failed, rolling back optimistic dismiss:', err);
      setDismissed(false);
      return false;
    },
  );
}

/**
 * F-CLEAR-1: Clear the current session's conversation context.
 * - Stops any running agent query
 * - Resets in-memory state (messages cleared, sdkSessionId nulled)
 * - Persists clearedAt + sdkSessionId=null to the server so old messages
 *   are permanently hidden and the next query starts a fresh conversation
 * - Stays on the same session (no navigation, no new session created)
 */
function clearSession(sessionId: string): Promise<void> {
  if (!sessionId) return Promise.resolve();
  const clearedAt = new Date().toISOString();

  return clearSessionAfterGuard(sessionId, clearedAt);
}

async function clearSessionAfterGuard(sessionId: string, clearedAt: string): Promise<void> {
  if (remoteClearInFlight.has(sessionId)) return;
  remoteClearInFlight.add(sessionId);
  try {
    await clearSessionAfterGuardImpl(sessionId, clearedAt);
  } finally {
    remoteClearInFlight.delete(sessionId);
  }
}

async function clearSessionAfterGuardImpl(sessionId: string, clearedAt: string): Promise<void> {
  // Pin the clear lifecycle to the last known device before any await. The
  // mirror is intentionally cleared below, so live origin lookup is no longer
  // reliable for either clearSession or closeSession.
  const remoteDeviceId = getStickySessionDeviceId(sessionId);
  noteRendererClearBoundary(sessionId, clearedAt);
  // Invalidate old history/projection operations before the first network await.
  // The clear guard itself must be the new authority generation, otherwise an
  // older projection can win the race and reinsert pre-clear queue state.
  invalidateMessageHistoryWindow(sessionId);
  bumpInteractionReconcileEpoch(sessionId);
  supersedeInputProjectionRequests(sessionId, { supersedeOperations: true });
  if (remoteDeviceId) {
    // Arm before the first remote await. New sends made while the invoke is
    // pending are accepted into the local optimistic ledger but cannot cross
    // the host's clear boundary.
    armRemoteClearFence(sessionId, remoteDeviceId, clearedAt);
  }
  clearRemoteOptimisticMaterializationRecoveriesForSession(sessionId, {
    preserveComposerTransitions: true,
    markComposerTransitionsPurged: true,
  });
  clearRemoteOptimisticSendsForSession(sessionId);
  // 远程会话:/clear 之后**不会**再有一次"最新页"拉取(唯一写缓存的那条路径),盘上那份
  // 仍是清空前的正文 —— 此刻退出 app,下次离线冷启动就把已经被清掉的对话 hydrate 回来
  // (review: codex P1)。放在守卫之前:无论守卫成功、失败还是超时,缓存都必须消失。
  invalidateRemoteMessageCache(sessionId, remoteDeviceId);
  // Arm main-side clear guards before closing the CLI and clearing renderer state.
  let guardTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let guardResult:
    | { kind: 'projection'; projection: AgentInputProjection }
    | { kind: 'error'; err: unknown }
    | { kind: 'timeout' };
  const clearOperation = beginInputProjectionOperation(sessionId, remoteDeviceId);
  try {
    guardResult = await Promise.race([
      clearOperation.api.input.clearSession(sessionId, clearedAt).then(
        (projection) => ({ kind: 'projection' as const, projection }),
        (err) => ({ kind: 'error' as const, err }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        guardTimeoutId = setTimeout(
          () => resolve({ kind: 'timeout' }),
          CLEAR_SESSION_GUARD_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    guardResult = { kind: 'error', err };
  } finally {
    if (guardTimeoutId) clearTimeout(guardTimeoutId);
  }
  if (guardResult.kind === 'projection') {
    let remoteClearResolved = true;
    if (remoteDeviceId) {
      remoteClearResolved = resolveRemoteClearFenceFromProjection(
        sessionId,
        remoteDeviceId,
        clearedAt,
        guardResult.projection,
        { pump: false },
      );
    }
    applyInputProjectionOperationResponse(sessionId, clearOperation, guardResult.projection);
    if (remoteDeviceId) {
      if (remoteClearResolved) pumpRemoteOptimisticSendsAfterCurrent(sessionId);
      else scheduleRemoteClearRetry(sessionId);
    }
  } else if (guardResult.kind === 'error') {
    const err = guardResult.err;
    log.warn('maker.input.clearSession failed:', err);
    if (remoteDeviceId) {
      noteRemoteClearDispatchError(sessionId, remoteDeviceId, clearedAt, err);
      scheduleRemoteClearRetry(sessionId);
    }
  } else {
    log.warn('maker.input.clearSession timed out; continuing local clear', { sessionId });
    if (remoteDeviceId) scheduleRemoteClearRetry(sessionId);
  }

  _lastViewedAt.delete(sessionId);
  discardPendingTextDelta(sessionId);
  // Close the CLI subprocess entirely (not just interrupt — we want a fresh context).
  // preserveWorkspace: /clear 后停留在同一会话,worktree / cwd 必须原样保留,
  // 否则 onClose 副作用会把活会话的工作区静默 stash+删除(2026-07 实报)。
  const closePromise = clearOperation.api
    .closeSession(sessionId, { preserveWorkspace: true })
    .catch((err) => log.warn('maker.closeSession failed:', err));

  // The remote guard may have been waiting while the user composed another
  // message. Those records belong to the post-clear generation: clear the old
  // transcript, but keep their local optimistic rows until the host accepts
  // them. Pre-clear records were already removed before the guard invoke.
  const postClearOptimisticClientIds = new Set(
    [...(remoteOptimisticSendRecords(sessionId)?.values() ?? [])]
      .filter(
        (record) =>
          isDataOwnerGenerationCurrent(record.dataOwner) &&
          record.clearGeneration === (rendererClearGenerationBySession.get(sessionId) ?? 0),
      )
      .map((record) => record.queued.clientId),
  );

  // Clear in-memory state; preserve isFirstMessage so the view stays in ChatView
  // with an empty message list (matches /clear semantics). The epoch was bumped
  // before the guard await above, so old history responses are already invalid.
  setState(sessionId, (s) => {
    return {
      ...s,
      messages: s.messages.filter(
        (message) => message.isPendingPersist && postClearOptimisticClientIds.has(message.clientId),
      ),
      taskUpdates: new Map(),
      pendingTaskWake: false,
      streamingClientId: null,
      streamingText: '',
      isStreaming: false,
      // 窗口清空 → 按构造没有孤岛,标记必须一起清零(与 reloadMessages / trim / demote
      // 同规矩)。漏清的后果不是数据错而是永久降级:covered 刻意保留孤岛标记(到达本次
      // 目标不证明更早的洞都补上了),于是 /clear 之后这个会话永远被判为"不连续",
      // canFocusWithoutJumpLoad 拒绝每一次窗口内命中,每次搜索跳转都白跑一轮补齐
      // (#676 review)。
      historyWindowHasIsland: false,
      // 分页锁归本次重置释放(与 reloadMessages / dropMessagesFromClientId 同规矩):
      // 上面刚 bump epoch 作废了 in-flight 的翻页 / 跳转补齐,而被作废的请求不会(也不该)
      // 代清这把锁 —— 它们分辨不出锁属于哪一代。漏清会让行首守卫把该会话的翻页永久
      // 卡住(#676 review)。
      isLoadingMore: false,
      error: null,
      usageLimitRecovery: null,
      errorReason: null,
      recoverableError: null,
      activeTurnRetryText: null,
      errorRetryText: null,
      pendingPermission: null,
      pendingAskUser: null,
      pendingPluginSetup: null,
      pendingPluginSetupQueue: [],
      pluginSetupViewerState: 'expanded',
      pluginSetupCommandInFlight: null,
      // F-AUQ-MIN-5: Clear session — wipe viewer state too.
      askUserViewerState: 'expanded',
      // F-AUQ-DRAFT: Clear session also wipes any in-progress draft.
      askUserDraft: null,
      pendingPlanReview: null,
      pendingIssueConfirm: null,
      pendingQueue: s.pendingQueue.filter((item) =>
        postClearOptimisticClientIds.has(item.clientId),
      ),
      steeringQueueClientIds: [],
      queuePaused: false,
      queueAbortPending: false,
      queueInteractionLocks: [],
      queueEditLocks: [],
      // F-QUEUE-DEFER: queue panel auto-collapses with the queue.
      queueExpanded: false,
      sdkSessionId: null,
      historyLoaded: true,
      hasMoreMessages: false,
      oldestMessageId: null,
      agentStatus: {
        status: '',
        tokenUsage: 0,
        costUsd: 0,
        contextTokens: 0,
        contextWindow: 0,
        isRunning: false,
        startedAt: null,
      },
    };
  });

  // Persist: null out sdkSessionId (fresh conversation) + set clearedAt
  // device-link 远程会话由被控端 maker:input:clear-session handler 权威落库并广播
  // sessions:patched；控制端本地 DB 没有该 row，不能在这里写。
  if (remoteDeviceId) {
    await closePromise;
    return;
  }
  sessionService
    .update(sessionId, { sdkSessionId: null, clearedAt })
    .then(() => {
      // clearSession 不改变列表成员、也不改变 _count.messages（物理 row 还在）
      // 只 patch 这两个字段同步到 sidebar，别再全量 refresh。
      emitPatch(sessionId, { sdkSessionId: null, clearedAt, updatedAt: clearedAt });
    })
    .catch((err) => log.error('clearSession failed:', err));
  await closePromise;
}

/**
 * F-CMD: Insert a local-only system card into the message stream.
 * Not persisted to the database — purely ephemeral UI.
 */
function insertSystemCard(
  sessionId: string,
  cardType: 'help' | 'cost' | 'context' | 'pwd' | 'status' | 'compact' | 'cmd' | 'learn',
  data?: Record<string, unknown>,
): string | null {
  if (!sessionId) return null;
  const clientId = crypto.randomUUID();
  setState(sessionId, (s) => {
    // learn 卡按 runId 幂等:store 是模块级常驻的,SessionView 卸载重挂
    // (切去 SkillHub 再回来)会重跑恢复逻辑,若已有同 runId 的卡必须跳过,
    // 否则每次切页都多插一张重复卡。setState 内判重保证无竞态。
    if (cardType === 'learn' && data?.runId != null) {
      const exists = s.messages.some(
        (m) => m.systemCardType === 'learn' && m.systemCardData?.runId === data.runId,
      );
      if (exists) return s;
    }
    return {
      ...s,
      messages: [
        ...s.messages,
        {
          clientId,
          role: 'assistant' as const,
          content: '',
          isStreaming: false,
          systemCardType: cardType,
          systemCardData: data,
          createdAt: new Date().toISOString(),
        },
      ],
    };
  });
  return clientId;
}

/**
 * learn 卡移到消息流末尾 —— 提案就绪(及每轮修订刷新)时调用:卡片是在
 * /learn 发出时插入的,长叙述输出后它留在会话顶部,用户视线在底部,
 * 「查看提案」入口容易被错过、误以为已装好(Chris 实测反馈)。
 * 卡片保持同一条消息对象(clientId 不变),只调整位置;已在末尾则不动。
 */
function moveLearnCardToEnd(sessionId: string, runId: string): void {
  if (!sessionId || !runId) return;
  setState(sessionId, (s) => {
    const idx = s.messages.findIndex(
      (m) => m.systemCardType === 'learn' && m.systemCardData?.runId === runId,
    );
    if (idx < 0 || idx === s.messages.length - 1) return s;
    const messages = [...s.messages];
    const [card] = messages.splice(idx, 1);
    messages.push(card);
    return { ...s, messages };
  });
}

/**
 * F-CMD: Patch the latest message's `systemCardData` in place. Used by async
 * SystemCard fillers (e.g. /context's IPC roundtrip) — insert with a loading
 * sentinel first, then merge in the resolved payload here.
 *
 * No-op if the latest message is not a system card (defensive: another
 * message could have streamed in between insert + IPC return).
 */
function updateLastSystemCardData(sessionId: string, patch: Record<string, unknown>): void {
  if (!sessionId) return;
  setState(sessionId, (s) => {
    if (s.messages.length === 0) return s;
    const lastIdx = s.messages.length - 1;
    const last = s.messages[lastIdx];
    if (!last?.systemCardType) return s;
    const messages = s.messages.slice();
    messages[lastIdx] = {
      ...last,
      systemCardData: { ...(last.systemCardData ?? {}), ...patch },
    };
    return { ...s, messages };
  });
}

function updateSystemCardData(
  sessionId: string,
  clientId: string,
  patch: Record<string, unknown>,
): void {
  if (!sessionId || !clientId) return;
  setState(sessionId, (s) => {
    const targetIdx = s.messages.findIndex((m) => m.clientId === clientId && !!m.systemCardType);
    if (targetIdx < 0) return s;
    const target = s.messages[targetIdx];
    const messages = s.messages.slice();
    messages[targetIdx] = {
      ...target,
      systemCardData: { ...(target.systemCardData ?? {}), ...patch },
    };
    return { ...s, messages };
  });
}

/**
 * F7.4/F7.5: Send all user answers for ask-user-question to the main process.
 * Updates the corresponding ask_user message to 'answered' state.
 */
function answerUserQuestion(
  sessionId: string,
  requestId: string,
  answers: Record<string, string>,
): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingAskUser) return;
  if (state.pendingAskUser.requestId !== requestId) return;
  bumpInteractionReconcileEpoch(sessionId);

  // Build a human-readable reply summary
  const replySummary = formatAskUserReply(answers);

  // Find the clientId for persistence update
  const askMsg = state.messages.find(
    (m) => m.askUserRequestId === requestId && m.askUserStatus === 'pending',
  );

  // Update message to answered + clear pendingAskUser
  setState(sessionId, (s) => ({
    ...s,
    pendingAskUser: null,
    // F-AUQ-MIN-5: question resolved — reset viewer for the next one.
    askUserViewerState: 'expanded',
    // F-AUQ-DRAFT: question resolved — drop the draft so a future question
    // (potentially with the same questions[] payload) starts at step 1.
    askUserDraft: null,
    messages: s.messages.map((m) =>
      m.askUserRequestId === requestId && m.askUserStatus === 'pending'
        ? {
            ...m,
            askUserStatus: 'answered' as const,
            askUserReply: replySummary,
            askUserAnswers: answers,
          }
        : m,
    ),
  }));

  // F7.6: Persist answered state via PATCH API。
  // device-link 远程会话:被控端在 RESOLVE_INTERACTION 里权威落库(onInteractionResolved),
  // 控制端再写就是写自己的空库(dead write + 错误日志)→ 远程跳过,只本机会话走这条。
  if (askMsg && !isRemoteSession(sessionId)) {
    messageService
      .updateContent(sessionId, askMsg.clientId, {
        requestId,
        questions: askMsg.askUserQuestions ?? null,
        status: 'answered',
        answers,
      })
      .catch((err) => log.error('Failed to persist ask_user answered state:', err));
  }

  // Send to maker (InteractionDecision kind: 'ask_user_question')
  makerApiFor(sessionId)
    .resolveInteraction(requestId, { kind: 'ask_user_question', answers })
    .catch((err) => log.error('Failed to answer user question:', err));
}

function respondToPluginSetup(
  sessionId: string,
  requestId: string,
  action: 'run_action' | 'submit_form' | 'cancel',
  actionId?: string,
  values?: PluginSetupInlineFormValues,
): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  const pending = state.pendingPluginSetup;
  if (!pending || pending.requestId !== requestId || state.pluginSetupCommandInFlight) return;

  const selectedAction = actionId
    ? pending.steps.find((step) => step.action?.id === actionId)?.action
    : undefined;
  if (action === 'run_action') {
    if (!selectedAction || selectedAction.kind === 'inline_form') return;
  } else if (action === 'submit_form') {
    if (
      isRemoteSession(sessionId) ||
      !selectedAction ||
      selectedAction.kind !== 'inline_form' ||
      typeof values?.value !== 'string'
    ) {
      return;
    }
    const value = values.value.trim();
    const field = selectedAction.form.fields[0];
    if (value.length === 0 || value.length > field.maxLength) return;

    bumpInteractionReconcileEpoch(sessionId);
    const command: PluginSetupCommandInFlight = {
      requestId,
      action,
      actionId: selectedAction.id,
    };
    setState(sessionId, (s) => ({ ...s, pluginSetupCommandInFlight: command }));
    window.electronAPI.maker
      .submitPluginSetupInline({
        requestId,
        actionId: selectedAction.id,
        expectedRevision: pending.revision,
        value,
      })
      .catch(() => {
        // Do not attach IPC error details here: this path carries a secret.
        log.error('Failed to submit plugin setup form');
        setState(sessionId, (s) =>
          s.pluginSetupCommandInFlight === command ? { ...s, pluginSetupCommandInFlight: null } : s,
        );
      });
    return;
  }

  bumpInteractionReconcileEpoch(sessionId);
  const command: PluginSetupCommandInFlight = {
    requestId,
    action,
    ...(actionId ? { actionId } : {}),
  };
  setState(sessionId, (s) => ({ ...s, pluginSetupCommandInFlight: command }));

  makerApiFor(sessionId)
    .resolveInteraction(requestId, {
      kind: 'plugin_setup',
      action,
      ...(actionId ? { actionId } : {}),
      expectedRevision: pending.revision,
    })
    .catch((err) => {
      log.error('Failed to respond to plugin setup:', err);
      setState(sessionId, (s) =>
        s.pluginSetupCommandInFlight === command ? { ...s, pluginSetupCommandInFlight: null } : s,
      );
    });
}

/**
 * F-PERM-2: Send a permission decision to the main process and clear pendingPermission.
 */
function respondToPermission(sessionId: string, result: CCAgentPermissionResult): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingPermission) return;

  const { requestId } = state.pendingPermission;
  bumpInteractionReconcileEpoch(sessionId);

  // Clear the pending permission immediately so the UI updates
  setState(sessionId, (s) => ({ ...s, pendingPermission: null }));

  // Send to maker (InteractionDecision kind: 'permission')
  makerApiFor(sessionId)
    .resolveInteraction(requestId, {
      kind: 'permission',
      behavior: result.behavior,
      updatedInput: (result as { updatedInput?: Record<string, unknown> }).updatedInput,
      reason: (result as { message?: string }).message,
      permissionUpdates: Array.isArray(result.updatedPermissions)
        ? result.updatedPermissions
        : undefined,
    })
    .catch((err) => log.error('Failed to respond to permission:', err));
}

/**
 * issue_confirm: 把确认卡片结果回给 main(IssueConfirmBridge)并清 pendingIssueConfirm。
 * confirmed=true 时携带卡片当前的 title/body/type(用户编辑版,main 以此为准)、
 * 用户选择的提交身份、平台代发公开署名(publicName)和 renderer 界面语言(uiLanguage)。
 */
function respondToIssueConfirm(
  sessionId: string,
  result:
    | {
        confirmed: true;
        title: string;
        body: string;
        type: 'bug' | 'feature';
        submissionIdentity: IssueSubmissionIdentity;
        publicName?: string;
        uiLanguage: string;
      }
    | { confirmed: false },
): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingIssueConfirm) return;

  const { requestId } = state.pendingIssueConfirm;
  bumpInteractionReconcileEpoch(sessionId);

  // 先清 UI,再回包(同 respondToPermission 的时序)。
  setState(sessionId, (s) => ({ ...s, pendingIssueConfirm: null }));

  makerApiFor(sessionId)
    .resolveInteraction(requestId, result)
    .catch((err) => log.error('Failed to respond to issue confirm:', err));
}

function parseRenameSessionsConfirmItem(
  raw: unknown,
): PendingRenameSessionsConfirm['changes'][number] | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.sessionId !== 'string' ||
    typeof obj.newTitle !== 'string' ||
    typeof obj.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    sessionId: obj.sessionId,
    currentTitle: typeof obj.currentTitle === 'string' ? obj.currentTitle : null,
    newTitle: obj.newTitle,
    workingDir: typeof obj.workingDir === 'string' ? obj.workingDir : null,
    updatedAt: obj.updatedAt,
  };
}

/**
 * rename_sessions_confirm: 把确认卡片结果回给 main(RenameSessionsConfirmBridge)
 * 并清 pendingRenameSessionsConfirm。confirmed=true 不携带可编辑字段,main 以
 * 发起确认时重新 dry-run 得到的变更清单为准。
 */
function respondToRenameSessionsConfirm(
  sessionId: string,
  result: { confirmed: true } | { confirmed: false },
): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingRenameSessionsConfirm) return;

  const { requestId } = state.pendingRenameSessionsConfirm;
  bumpInteractionReconcileEpoch(sessionId);

  setState(sessionId, (s) => ({ ...s, pendingRenameSessionsConfirm: null }));

  makerApiFor(sessionId)
    .resolveInteraction(requestId, result)
    .catch((err) => log.error('Failed to respond to rename sessions confirm:', err));
}

/** ghost_grant_confirm 请求 payload 校验(shape 非法整条丢弃,不渲染半残卡)。 */
function parseGhostGrantConfirmRequest(request: {
  requestId: string;
  [k: string]: unknown;
}): PendingGhostGrantConfirm | null {
  const lane = request.lane;
  if (
    lane !== 'attachments' &&
    lane !== 'dir' &&
    lane !== 'save_dir' &&
    lane !== 'fs_write' &&
    lane !== 'workspace'
  )
    return null;
  if (typeof request.ghostId !== 'string' || typeof request.ghostName !== 'string') return null;
  const rawItems = Array.isArray(request.items) ? request.items : null;
  if (!rawItems || rawItems.length === 0) return null;
  const items: PendingGhostGrantConfirm['items'] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj.name !== 'string' ||
      typeof obj.absPath !== 'string' ||
      typeof obj.size !== 'number'
    ) {
      return null;
    }
    items.push({
      name: obj.name,
      absPath: obj.absPath,
      size: obj.size,
      mimeType: typeof obj.mimeType === 'string' ? obj.mimeType : undefined,
      previewDataUrl: typeof obj.previewDataUrl === 'string' ? obj.previewDataUrl : undefined,
      isDirectory: obj.isDirectory === true ? true : undefined,
      fileCount: typeof obj.fileCount === 'number' ? obj.fileCount : undefined,
    });
  }
  return {
    requestId: request.requestId,
    ghostId: request.ghostId,
    ghostName: request.ghostName,
    lane,
    items,
  };
}

/**
 * ghost_grant_confirm: 把过户确认结果回给 main(GhostGrantConfirmBridge)并清
 * pendingGhostGrantConfirm。confirmed=true 表示用户允许本次过户(按本次请求
 * 的文件清单整批生效,不可部分勾选——与 attachments 整批语义一致)。
 */
function respondToGhostGrantConfirm(
  sessionId: string,
  result: { confirmed: true; allowDirs?: boolean } | { confirmed: false },
): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingGhostGrantConfirm) return;

  const { requestId } = state.pendingGhostGrantConfirm;
  bumpInteractionReconcileEpoch(sessionId);

  setState(sessionId, (s) => ({ ...s, pendingGhostGrantConfirm: null }));

  makerApiFor(sessionId)
    .resolveInteraction(requestId, result)
    .catch((err) => log.error('Failed to respond to ghost grant confirm:', err));
}

/**
 * FP-3: Send a plan-review decision to the main process and clear pendingPlanReview.
 * approved → agent exits plan mode and starts coding; plan_review message → 'approved'
 * feedback  → agent stays in plan mode and revises;     plan_review message → 'revised'
 */
function respondToPlanReview(
  sessionId: string,
  requestId: string,
  approved: boolean,
  feedback?: string,
): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingPlanReview) return;
  if (state.pendingPlanReview.requestId !== requestId) return;

  const nextStatus = approved ? 'approved' : 'revised';
  const trimmedFeedback = feedback?.trim() ?? '';
  bumpInteractionReconcileEpoch(sessionId);

  // Find the clientId for persistence update
  const planMsg = state.messages.find(
    (m) =>
      m.role === 'plan_review' &&
      m.planReviewRequestId === requestId &&
      m.planReviewStatus === 'pending',
  );

  setState(sessionId, (s) => ({
    ...s,
    pendingPlanReview: null,
    // Reset viewer state so the next review starts fresh
    planViewerState: 'expanded',
    lastExpandedPlanViewerState: 'expanded',
    messages: s.messages.map((m) =>
      m.role === 'plan_review' &&
      m.planReviewRequestId === requestId &&
      m.planReviewStatus === 'pending'
        ? {
            ...m,
            planReviewStatus: nextStatus as 'approved' | 'revised',
            planReviewFeedback: approved ? undefined : trimmedFeedback || undefined,
          }
        : m,
    ),
  }));

  // Persist answered state via PATCH API。远程会话由被控端权威落库(见 answerUserQuestion 注释),
  // 控制端跳过避免 dead write;本机会话保持原样。
  if (planMsg && !isRemoteSession(sessionId)) {
    messageService
      .updateContent(sessionId, planMsg.clientId, {
        requestId,
        plan: planMsg.planReviewPlan ?? '',
        planFilePath: planMsg.planReviewFilePath ?? '',
        status: nextStatus,
        feedback: approved ? null : trimmedFeedback || null,
      })
      .catch((err) => log.error('Failed to persist plan_review state:', err));
  }

  // Send to maker (InteractionDecision kind: 'plan_review')
  // approved → behavior='allow' + editedPlan = current pending.plan (用户改过的版本)
  // 拒绝 → behavior='deny' + reason=feedback (模型读到 feedback 知道为什么被拒)
  makerApiFor(sessionId)
    .resolveInteraction(requestId, {
      kind: 'plan_review',
      behavior: approved ? 'allow' : 'deny',
      editedPlan: approved ? state.pendingPlanReview.plan : undefined,
      reason: approved ? undefined : trimmedFeedback || undefined,
    })
    .catch((err) => log.error('Failed to respond to plan review:', err));
}

/**
 * 取消本次计划审阅(issue #475):与批准/反馈并列的第三条出路。
 * 关闭卡片、气泡标 cancelled;决策发 deny + dismissed 标记 ——
 *   - Codex: 结束本轮计划循环,不发修订 turn(dismissed 语义,见 maker-core;下一条消息回常规模式);
 *   - Claude: ExitPlanMode 以默认理由被拒,模型收到后收尾等待,计划模式不变。
 * 持久化与 respondToPlanReview 同款(远程会话由被控端权威落库,本机 PATCH)。
 */
function cancelPlanReview(sessionId: string, requestId: string): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingPlanReview) return;
  if (state.pendingPlanReview.requestId !== requestId) return;
  bumpInteractionReconcileEpoch(sessionId);

  const planMsg = state.messages.find(
    (m) =>
      m.role === 'plan_review' &&
      m.planReviewRequestId === requestId &&
      m.planReviewStatus === 'pending',
  );

  setState(sessionId, (s) => ({
    ...s,
    pendingPlanReview: null,
    planViewerState: 'expanded',
    lastExpandedPlanViewerState: 'expanded',
    messages: s.messages.map((m) =>
      m.role === 'plan_review' &&
      m.planReviewRequestId === requestId &&
      m.planReviewStatus === 'pending'
        ? { ...m, planReviewStatus: 'cancelled' as const, planReviewFeedback: undefined }
        : m,
    ),
  }));

  if (planMsg && !isRemoteSession(sessionId)) {
    messageService
      .updateContent(sessionId, planMsg.clientId, {
        requestId,
        plan: planMsg.planReviewPlan ?? '',
        planFilePath: planMsg.planReviewFilePath ?? '',
        status: 'cancelled',
        feedback: null,
      })
      .catch((err) => log.error('Failed to persist cancelled plan_review state:', err));
  }

  makerApiFor(sessionId)
    .resolveInteraction(requestId, {
      kind: 'plan_review',
      behavior: 'deny',
      dismissed: true,
    })
    .catch((err) => log.error('Failed to cancel plan review:', err));
}

/**
 * FP-edit: Update the in-memory pending plan content as the user types in
 * the Plan Viewer's edit mode. This is purely renderer-side state — the
 * actual disk write is debounced by the UI layer and goes through the
 * `cc-agent:plan-file-write` IPC. We also patch the matching pending
 * plan_review message so the chat history reflects the edited version.
 */
function updatePendingPlanReviewContent(
  sessionId: string,
  requestId: string,
  content: string,
): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingPlanReview) return;
  if (state.pendingPlanReview.requestId !== requestId) return;
  if (state.pendingPlanReview.plan === content) return;

  setState(sessionId, (s) => {
    if (!s.pendingPlanReview || s.pendingPlanReview.requestId !== requestId) {
      return s;
    }
    return {
      ...s,
      pendingPlanReview: { ...s.pendingPlanReview, plan: content },
      messages: s.messages.map((m) =>
        m.role === 'plan_review' &&
        m.planReviewRequestId === requestId &&
        m.planReviewStatus === 'pending'
          ? { ...m, planReviewPlan: content }
          : m,
      ),
    };
  });
}

/**
 * FP-3: Switch Plan Viewer Card display state. UI-only; does not touch IPC.
 * Tracks the last non-minimized state so the "+" button can restore correctly.
 */
/**
 * Toggle Fast Mode for a session.
 * Server-first: persist to DB, then update store + push to SDK via IPC.
 */
async function setFastMode(
  sessionId: string,
  enabled: boolean,
  sourceRemoteDeviceId?: string,
): Promise<void> {
  if (!sessionId) return;
  // device-link 远程会话:控制端纯镜像 —— 只发运行时隧道 setX(被控端 set-fast-mode 仅 codex
  // 生效,非 codex 自动 no-op),被控端持久化后广播 sessions:patched 回流到分片(取代乐观覆盖)。
  // setState 是当前打开会话的 in-memory 即时反馈;sidebar 分片由回流更新。隧道失败必须 reject,
  // 让上层不要把 New Maker draft default 误同步到一个未实际保存的 Fast 值。显式 device ID
  // 来自操作开始时的稳定 scope，relay origin 短暂缺失时仍必须走同一被控端。
  const remoteDeviceId = sourceRemoteDeviceId ?? getStickySessionDeviceId(sessionId);
  if (remoteDeviceId) {
    const previousFastMode = getOrCreateState(sessionId).fastMode;
    setState(sessionId, (s) => (s.fastMode === enabled ? s : { ...s, fastMode: enabled }));
    try {
      const remoteMaker = makerApiForDevice(remoteDeviceId);
      await remoteMaker.setFastMode(sessionId, enabled);
    } catch (err) {
      setState(sessionId, (s) =>
        s.fastMode === enabled ? { ...s, fastMode: previousFastMode } : s,
      );
      log.warn('setFastMode IPC failed (remote):', err);
      throw err;
    }
    return;
  }
  try {
    await sessionService.update(sessionId, { fastMode: enabled });
    setState(sessionId, (s) => {
      if (s.fastMode === enabled) return s;
      return { ...s, fastMode: enabled };
    });
    // 无条件推 IPC:codex → agent setFastMode;claude-code → main 记 bridge 会话态
    // (chatgpt/ 模型经订阅 handler 的 prefs 生效),其余在 main 侧安全 no-op。
    await window.electronAPI.maker.setFastMode(sessionId, enabled).catch((err: unknown) => {
      log.warn('setFastMode IPC failed:', err);
    });
  } catch (err) {
    log.warn('setFastMode persist failed:', err);
    throw err;
  }
}

/**
 * 切换计划模式(与 permissionMode 正交)。
 * 与 setFastMode 同款双路径:
 *  - 远程会话:控制端纯镜像, 只发运行时隧道 setPlanMode, 被控端持久化后经
 *    sessions:patched 回流收敛; 失败回滚乐观值并 reject。
 *  - 本机会话:server-first —— sessionService.update({ planModeEnabled }) 落库,
 *    再推 maker runtime(session 未 spawn / 已 close 时 no-op, 下次 lazy-create
 *    由 createOpts.planMode 兜底)。
 */
async function setPlanMode(sessionId: string, enabled: boolean): Promise<void> {
  if (!sessionId) return;
  const remoteDeviceId = getStickySessionDeviceId(sessionId);
  if (remoteDeviceId) {
    const previous = getOrCreateState(sessionId).planModeEnabled;
    setState(sessionId, (s) =>
      s.planModeEnabled === enabled
        ? s
        : { ...s, planModeEnabled: enabled, planModeRev: s.planModeRev + 1 },
    );
    try {
      await makerApiForDevice(remoteDeviceId).setPlanMode(sessionId, enabled);
    } catch (err) {
      setState(sessionId, (s) =>
        s.planModeEnabled === enabled
          ? { ...s, planModeEnabled: previous, planModeRev: s.planModeRev + 1 }
          : s,
      );
      log.warn('setPlanMode IPC failed (remote):', err);
      throw err;
    }
    return;
  }
  // 乐观先行(bot review P2):store(下一次 createOpts / lazy-create 读)与 maker
  // runtime(已 spawn 会话的 send 读 agent 武装态)都必须在任何 await 之前可见,
  // 否则「勾选后立即回车」会以未武装状态发出(maker:send 对已存在会话忽略
  // createOpts)。setPlanMode IPC 同步 invoke 也保证其先于后续 send IPC 到达 main。
  const previous = getOrCreateState(sessionId).planModeEnabled;
  setState(sessionId, (s) =>
    s.planModeEnabled === enabled
      ? s
      : { ...s, planModeEnabled: enabled, planModeRev: s.planModeRev + 1 },
  );
  const runtimePush = window.electronAPI.maker
    .setPlanMode(sessionId, enabled)
    .catch((err: unknown) => {
      log.warn('setPlanMode IPC failed:', err);
    });
  try {
    await sessionService.update(sessionId, { planModeEnabled: enabled });
  } catch (err) {
    // 持久化失败 → 回滚乐观值(store + runtime 尽力), UI 不谎报已开启。
    setState(sessionId, (s) =>
      s.planModeEnabled === enabled
        ? { ...s, planModeEnabled: previous, planModeRev: s.planModeRev + 1 }
        : s,
    );
    void window.electronAPI.maker.setPlanMode(sessionId, previous).catch(() => {});
    log.warn('setPlanMode persist failed:', err);
    throw err;
  }
  await runtimePush;
}

/**
 * Reset Fast Mode to OFF.
 * Server-first: persist false to DB, then update store + push to SDK via IPC.
 * Used when model changes automatically invalidate fast mode.
 */
async function resetFastMode(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const remoteDeviceId = getStickySessionDeviceId(sessionId);
  if (remoteDeviceId) {
    setState(sessionId, (s) => (!s.fastMode ? s : { ...s, fastMode: false }));
    await makerApiForDevice(remoteDeviceId)
      .setFastMode(sessionId, false)
      .catch((err: unknown) => {
        log.warn('resetFastMode IPC failed (remote):', err);
      });
    return;
  }
  try {
    await sessionService.update(sessionId, { fastMode: false });
    setState(sessionId, (s) => {
      if (!s.fastMode) return s;
      return { ...s, fastMode: false };
    });
    // 与 setFastMode 同理:无条件推,main 按 agentKind / 模型分流。
    await window.electronAPI.maker.setFastMode(sessionId, false).catch((err: unknown) => {
      log.warn('resetFastMode IPC failed:', err);
    });
  } catch (err) {
    log.warn('resetFastMode persist failed:', err);
  }
}

function setPlanViewerState(sessionId: string, next: PlanViewerState): void {
  if (!sessionId) return;
  setState(sessionId, (s) => {
    if (s.planViewerState === next) return s;
    const lastExpanded: 'expanded' | 'half' | 'edit' =
      next === 'minimized' ? s.lastExpandedPlanViewerState : next;
    return {
      ...s,
      planViewerState: next,
      lastExpandedPlanViewerState: lastExpanded,
    };
  });
}

/**
 * F-AUQ-MIN-2 / F-AUQ-MIN-4: Switch the AskUserQuestion viewer state.
 * UI-only — does NOT touch the SDK / pendingAskUser. The pending question
 * stays exactly as it is; only the rendering toggles between full Prompt
 * card and 880×44 minimized bar. Safe to call when no pending question
 * exists (no-op via the equality short-circuit below).
 */
function setAskUserViewerState(sessionId: string, next: AskUserViewerState): void {
  if (!sessionId) return;
  setState(sessionId, (s) => {
    if (s.askUserViewerState === next) return s;
    return { ...s, askUserViewerState: next };
  });
}

function setPluginSetupViewerState(sessionId: string, next: PluginSetupViewerState): void {
  if (!sessionId) return;
  setState(sessionId, (s) => {
    if (s.pluginSetupViewerState === next) return s;
    return { ...s, pluginSetupViewerState: next };
  });
}

/**
 * F-AUQ-DRAFT: Persist the in-progress AskUserQuestion wizard state
 * (currentIndex + answers) per session so it survives the session-switch
 * remount of `AskUserQuestionPrompt`.
 *
 * Pass `null` to clear (e.g. caller decides the draft is no longer relevant).
 * The store also clears it autonomously whenever pendingAskUser transitions
 * (done / error / dismissed / stop / clear / answer / new question).
 *
 * Equality short-circuit avoids a re-render storm: the component writes back
 * after every keystroke / option click, but identical objects are deduped via
 * shallow comparison of (requestId, currentIndex, answers identity).
 */
function setAskUserDraft(sessionId: string, next: AskUserDraft | null): void {
  if (!sessionId) return;
  setState(sessionId, (s) => {
    const prev = s.askUserDraft;
    if (prev === next) return s;
    if (
      prev &&
      next &&
      prev.requestId === next.requestId &&
      prev.currentIndex === next.currentIndex &&
      prev.answers === next.answers
    ) {
      return s;
    }
    return { ...s, askUserDraft: next };
  });
}

/**
 * Close a session's SDK query entirely — kills the CLI subprocess.
 * Called on session delete/archive. Does NOT clear in-memory chat state
 * (the caller navigates away or refreshes the session list).
 */
function closeSessionQuery(sessionId: string): void {
  if (!sessionId) return;
  makerApiFor(sessionId)
    .closeSession(sessionId)
    .catch((err) => log.warn('maker.closeSession failed:', err));
}

/**
 * `[UI_ACTION_TRIGGER]` — magic prefix marking a renderer-synthesized user
 * message that should NEVER be rendered in the chat bubble list. mapServerMessages
 * filters these out so they stay invisible after a session reload too.
 *
 * The LLM still sees the full prompt (no filtering on the wire). Rationale
 * (历史,源自老 mivo 按钮链路,该链路已随 lizi_mivo MCP 退役,2026-07-13;
 * 现存使用方:隐藏续跑指令):
 *   - mivo MJ button clicks (U1/V1/Animate/...) need to flow through agent
 *     context so the resulting xdt-image:// URL is resolvable when the user
 *     later says "上面那张图". Pre-2026-05 these clicks went through a
 *     renderer-only broadcast that the LLM never saw.
 *   - We can't force tool_choice deterministically through either Claude
 *     Agent SDK or Codex turn/start protocol, so the trigger uses a strong
 *     imperative prompt format (`[UI_ACTION_TRIGGER]` tag + explicit JSON
 *     params + reverse bans on commentary/thinking/refusal). On Opus/Sonnet
 *     class models this is near-100% deterministic.
 */
// 唯一定义点在 shared/interruptedTurn.ts(main 侧 DB 派生消费也要用同一常量
// 排除合成行,review P2);此处 import + re-export 保持既有 renderer 调用点不变。
import {
  CONTINUE_AFTER_ERROR_PROMPT,
  syntheticTriggerKind,
  UI_ACTION_TRIGGER_PREFIX,
} from '../../shared/interruptedTurn.js';
export { UI_ACTION_TRIGGER_PREFIX };

/**
 * Send a UI-triggered synthetic user message (hidden continue prompt / Mivo
 * image action) through the **normal coordinator enqueue path**(review P2:
 * 此前直调 maker:send 绕过 AgentInputCoordinator,合成续跑 turn 再次 terminal
 * error 时 coordinator 侧 active=null、不建 recovery,live ErrorBanner 的重试
 * 按钮点了没反应)。走 enqueue 后失败自然获得 active-turn recovery,重试语义
 * (零产出克隆重发 / 有产出续跑)与普通消息完全一致。
 *
 * 与 sendMessage 的差异:
 *   - 不 push 乐观气泡(UI_ACTION_TRIGGER 前缀文本,mapServerMessages 渲染时
 *     过滤;排队态由 pendingQueueRowPresentation 的 synthetic 变体展示);
 *   - 不消耗计划模式一次性勾选:createOpts.planMode 强制 false(合成指令显式
 *     普通执行);
 *   - createOpts 的水合敏感字段(agentKind/resume/fastMode/remoteHostId)从
 *     fetch 到的 DB session row 派生,store 态只兜底 —— 重启后 banner 可能在
 *     ensureInitialMessages 行播种落地前被点击(review P2);
 *   - session 行缺失时回退旧 direct-send(无 createOpts):已 spawn 的
 *     in-memory session 照常收,未 spawn 才 throw NOT_FOUND 让用户感知。
 *
 * Errors are reported via promise rejection; the caller (ChatImageActions /
 * error-tail banner) toasts or恢复红条。
 */

function sendUiTriggerCore(sessionId: string, prompt: string): Promise<void> {
  const state = getOrCreateState(sessionId);
  // UI triggers can be invoked from an error card while the mirror is being
  // reseeded. Pin every mutation in this attempt to the device that owned the
  // session when the action started.
  const remoteDeviceId = getStickySessionDeviceId(sessionId);
  const triggerApi = remoteDeviceId ? makerApiForDevice(remoteDeviceId) : makerApiFor(sessionId);
  const originalTail = state.messages[state.messages.length - 1];
  // Freeze the row the user acted on before session lookup / dispatch. A fast
  // continuation failure may append a new error before send resolves; that new
  // error must keep its retry banner.
  const continuedErrorTailClientId =
    syntheticTriggerKind(prompt) === 'continue' &&
    originalTail?.role === 'error' &&
    !originalTail.errorDismissed
      ? originalTail.clientId
      : null;
  // device-link 远程会话:get/enqueue 都走传输层(getSessionFor 远程读被控 row,
  // makerApiFor(...) 远程隧道到被控端 coordinator)。
  return getSessionFor(sessionId)
    .catch((err) => {
      log.warn('sendUiTrigger: fetch session for createOpts failed', err);
      return null;
    })
    .then((session) => {
      if (!session?.workingDir) {
        // 行缺失兜底:direct send,行为与旧实现一致。
        // 无 pendingQueue 可取消，continue 在直发 accepted 后 durable ack；成功后再 dismiss
        // 尾部 error（主路径 enqueue 不能在排队阶段 dismiss，否则取消后续跑后入口丢失）。
        const sendDirect = (ackInterruptedTurnOnDispatch = false) =>
          triggerApi
            .send(sessionId, { type: 'user', content: prompt }, undefined, {
              userName: currentUserName ?? undefined,
              ...(ackInterruptedTurnOnDispatch ? { ackInterruptedTurnOnDispatch: true } : {}),
            })
            .then((result) => {
              if (result.accepted === false) {
                throw new Error(result.reason ?? 'Maker send was not accepted before dispatch');
              }
            });
        if (syntheticTriggerKind(prompt) !== 'continue') return sendDirect();
        // 执行端 maker:send 在进入 vendor 前冻结自己的时钟，并仅在 accepted 后
        // durable ack；device-link 控制端不再跨设备传时间戳。老执行端忽略该选项
        // 时安全降级为“不确认旧中断”，不会因时钟偏差抹掉新的中断。
        return sendDirect(true).then(() => {
          if (continuedErrorTailClientId) {
            dismissErrorTailMessage(sessionId, continuedErrorTailClientId);
          }
        });
      }
      const queued = buildQueuedMessage(
        sessionId,
        prompt,
        session.model,
        session.effort,
        session.permissionMode,
        session.workingDir,
      );
      queued.createOpts = {
        ...queued.createOpts,
        agentKind: dbAgentKindToMakerKind(session.agentKind, state.agentKind),
        fastMode: session.fastMode ?? state.fastMode,
        planMode: false,
        ...(session.providerId !== undefined ? { providerId: session.providerId } : {}),
        ...((session.sdkSessionId ?? state.sdkSessionId)
          ? { resumeSessionId: (session.sdkSessionId ?? state.sdkSessionId) as string }
          : {}),
        // SSH remote 与本地同语义: Maker Memory 跟随控制端全局开关 (scope 由
        // maker-core 按 remoteHostId+workingDir 隔离), 这里不再强制关闭;
        // device-link 仍由目标端自己的设置决定 (buildQueuedMessage 已省略)。
        // 远端 SSH 会话:重启后 lazy-create 缺它会把远端 workingDir 当本地路径。
        ...(session.remoteHostId ? { remoteHostId: session.remoteHostId } : {}),
      };
      // #2194 (Codex review P1): 本地 UI 触发器（silent-stop「继续」/ 中断横幅
      // 「继续任务」/ Mivo 触发）是本端点击意图——合成行虽不渲染气泡，但点击后
      // 用户要看到续跑产出，必须按本端发送登记以触发强制回底；未读计数对
      // isSyntheticTrigger 行一律跳过，不会因此产生幻影未读。direct-send 兜底
      // 分支的 clientId 由执行端生成，renderer 无从登记（行缺失的稀有路径）。
      markLocalSentUserMessage(sessionId, queued.clientId);
      const operation = beginInputProjectionOperation(sessionId, remoteDeviceId);
      return operation.api.input
        .enqueue(sessionId, queued, { sendAtMs: Date.now() })
        .then((projection) => {
          applyInputProjectionOperationResponse(sessionId, operation, projection);
        });
    })
    .catch((err) => {
      log.warn('sendUiTrigger failed', err);
      throw err instanceof Error ? err : new Error(String(err));
    });
}

function sendUiTrigger(sessionId: string, prompt: string): Promise<void> {
  if (!sessionId) return Promise.reject(new Error('sendUiTrigger: empty sessionId'));
  return withAgentSendDispatch(
    sessionId,
    () => Promise.reject(new Error('Agent switch is still in progress')),
    () => sendUiTriggerCore(sessionId, prompt),
  );
}

/**
 * session-agent-switch:切换 IPC 成功后由 ChatInput 调用。翻转 in-memory
 * agentKind(事件 reducer 路由 + createOpts 派生都读它)并清掉旧引擎的
 * sdkSessionId——否则 buildCreateOpts 会把旧引擎的原生会话 id 当 resume 目标
 * (main 侧 reconcileCreateOptsWithDb 是兜底,这里是第一现场收敛)。
 */
function noteAgentSwitched(sessionId: string, agentKind: 'claude-code' | 'codex' | 'pi'): void {
  if (!sessionId) return;
  setState(sessionId, (s) =>
    s.agentKind === agentKind && s.sdkSessionId === null && s.agentSwitchIntent === null
      ? s
      : {
          ...s,
          agentKind,
          sdkSessionId: null,
          agentSwitchIntent: null,
          // 意图被真实切换消费掉也是一次变更,在途读回据此作废。
          ...(s.agentSwitchIntent === null
            ? {}
            : { agentSwitchIntentRev: s.agentSwitchIntentRev + 1 }),
        },
  );
}

/**
 * session-agent-switch 意图制:main 侧只登记切换意图(deferred),真切换在下一条
 * 消息发送时刻执行。renderer 用本表把用户的选择**乐观**呈现出来(chip / 选择器 /
 * capabilities 立即跟随目标引擎),DB 与 reducer 路由保持旧值。意图属于 session
 * state,因此 setState 会驱动所有展示消费点重渲染；真切换 patched 到达时清意图。
 */
function noteAgentSwitchIntent(
  sessionId: string,
  target: 'claude-code' | 'codex' | 'pi',
  opts: { model: string; providerId: string | null; effort?: string; fastMode?: boolean },
): void {
  if (!sessionId) return;
  setState(sessionId, (s) => ({
    ...s,
    agentSwitchIntent: {
      target,
      model: opts.model,
      providerId: opts.providerId,
      effort: opts.effort,
      fastMode: opts.fastMode,
    },
    agentSwitchIntentRev: s.agentSwitchIntentRev + 1,
  }));
}

/** 用户选回当前引擎或 main 明确取消意图:只移除展示覆盖。 */
function clearAgentSwitchIntent(sessionId: string): void {
  if (!sessionId) return;
  setState(sessionId, (s) =>
    s.agentSwitchIntent === null
      ? s
      : { ...s, agentSwitchIntent: null, agentSwitchIntentRev: s.agentSwitchIntentRev + 1 },
  );
}

function getAgentSwitchIntent(sessionId: string): AgentSwitchIntentRecord | null {
  return sessions.get(sessionId)?.agentSwitchIntent ?? null;
}

/**
 * 意图的单调修订号(不存在的会话按 0)。异步读回的新鲜度判定读它——值比较会被 ABA
 * (null → 已登记 → null)骗过,修订号不会。
 */
function getAgentSwitchIntentRev(sessionId: string): number {
  return sessions.get(sessionId)?.agentSwitchIntentRev ?? 0;
}

/**
 * main 的 pending 意图投影(PublicAgentSwitchIntent,字段名 targetAgentKind)收窄成
 * store 记录(target)。形状不合法 / 非意图 → null,按「无意图」处理。
 */
function normalizeAgentSwitchIntent(value: unknown): AgentSwitchIntentRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (
    item.targetAgentKind !== 'claude-code' &&
    item.targetAgentKind !== 'codex' &&
    item.targetAgentKind !== 'pi'
  )
    return null;
  if (typeof item.model !== 'string' || item.model.length === 0) return null;
  // providerId 缺失按 null(与 main projectPendingAgentSwitchIntent 的 `?? null` 对齐);
  // 只有出现非 string / 非空值的脏值才判非法,避免协议演进时静默丢掉合法意图。
  if (item.providerId != null && typeof item.providerId !== 'string') return null;
  if (item.effort !== undefined && typeof item.effort !== 'string') return null;
  if (item.fastMode !== undefined && typeof item.fastMode !== 'boolean') return null;
  return {
    target: item.targetAgentKind,
    model: item.model,
    providerId: typeof item.providerId === 'string' ? item.providerId : null,
    ...(typeof item.effort === 'string' && item.effort.length > 0 ? { effort: item.effort } : {}),
    ...(typeof item.fastMode === 'boolean' ? { fastMode: item.fastMode } : {}),
  };
}

function agentSwitchIntentEquals(
  a: AgentSwitchIntentRecord | null,
  b: AgentSwitchIntentRecord | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.target === b.target &&
    a.model === b.model &&
    a.providerId === b.providerId &&
    a.effort === b.effort &&
    a.fastMode === b.fastMode
  );
}

/**
 * 「意图的权威态在会话所在端」:被控端(或本机另一个窗口)登记 / 清除 pending 意图后,
 * main 经 sessions:patched 广播 agentSwitchIntent 字段;device-link 远程会话打开时
 * 控制端还会主动读回一次。两条 sink 都汇到这里。
 *
 * 幂等:值等价即 no-op —— 本端乐观登记后收到自己的回声不会重建对象、不触发多余重渲染,
 * 也不会与用户正在进行的选择打架。null / 非法值 = 无意图 → 清除。
 */
function mirrorAgentSwitchIntent(sessionId: string, value: unknown): void {
  if (!sessionId) return;
  const next = normalizeAgentSwitchIntent(value);
  if (agentSwitchIntentEquals(sessions.get(sessionId)?.agentSwitchIntent ?? null, next)) return;
  if (!next) {
    clearAgentSwitchIntent(sessionId);
    return;
  }
  setState(sessionId, (s) => ({
    ...s,
    agentSwitchIntent: next,
    agentSwitchIntentRev: s.agentSwitchIntentRev + 1,
  }));
}

function setSessionRuntime(
  sessionId: string,
  opts: {
    agentKind?: 'claude-code' | 'codex' | 'pi';
    fastMode?: boolean;
    planModeEnabled?: boolean;
  },
): void {
  if (!sessionId) return;
  setState(sessionId, (s) => {
    const nextAgentKind = opts.agentKind ?? s.agentKind;
    const nextFastMode = opts.fastMode ?? s.fastMode;
    const nextPlanMode = opts.planModeEnabled ?? s.planModeEnabled;
    if (
      s.agentKind === nextAgentKind &&
      s.fastMode === nextFastMode &&
      s.planModeEnabled === nextPlanMode
    )
      return s;
    return {
      ...s,
      agentKind: nextAgentKind,
      fastMode: nextFastMode,
      planModeEnabled: nextPlanMode,
      ...(s.planModeEnabled !== nextPlanMode ? { planModeRev: s.planModeRev + 1 } : {}),
    };
  });
}

function setContextWindow(sessionId: string, contextWindow: number | undefined): void {
  if (
    !sessionId ||
    contextWindow === undefined ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  )
    return;
  const nextContextWindow = Math.floor(contextWindow);
  setState(sessionId, (s) => {
    if (s.agentStatus.contextWindow === nextContextWindow) return s;
    return {
      ...s,
      agentStatus: {
        ...s.agentStatus,
        contextWindow: nextContextWindow,
      },
    };
  });
}

/**
 * device-link「以被控端为准」:被控端会话行变更(sessions:patched)回流时,把其中的 fastMode
 * 镜像进 chat in-memory(fast 开关读这里,见 useCCAgentChat)。只镜像 fastMode —— model/effort/
 * permission 的显示已走 serverSession / 远程分片(prop 驱动),无需在此重复镜像。
 *
 * 幂等:值未变即 no-op,绝不与用户本地乐观切换打架。本机会话同样安全(本机 setFastMode 的乐观
 * setState 已设好值,后续若有同值 patched 也是 no-op)。两个 sink 调用:控制端 onRemotePush 的
 * sessions:patched(远程会话回流)+ CCAgentSessionView 的本地 sessionsPush.onPatched(被控端本机)。
 */
function mirrorSessionFields(
  sessionId: string,
  patch:
    | {
        fastMode?: unknown;
        planModeEnabled?: unknown;
        agentKind?: unknown;
        agentSwitchIntent?: unknown;
        agentSwitchIntentCanceled?: unknown;
      }
    | null
    | undefined,
): void {
  if (!sessionId || !patch) return;
  if (patch.agentSwitchIntentCanceled === true) clearAgentSwitchIntent(sessionId);
  // 意图登记 / 覆盖 / 清除的回流(main onPendingSwitchChanged)。必须判字段存在性:
  // 不带该字段的普通 patch(标题、preview、token 计数…)不能被当成「意图已清空」,
  // 否则任何无关广播都会擦掉用户已登记的切换意图。
  if ('agentSwitchIntent' in patch) mirrorAgentSwitchIntent(sessionId, patch.agentSwitchIntent);
  // session-agent-switch:引擎翻转必须镜像进 chat in-memory——maker:event 的
  // reducer 按 state.agentKind 分流(Claude / Codex 两套),非发起窗口若停在旧值,
  // 新引擎的事件会被旧引擎 reducer 错误处理(2026-07-20 审计实锤)。随引擎翻转
  // 同步清 sdkSessionId(旧引擎的原生会话 id 对新引擎无意义,与 noteAgentSwitched
  // 口径一致)。幂等:发起窗口已 noteAgentSwitched → 同值 no-op。
  if (patch.agentKind === 'cc' || patch.agentKind === 'codex' || patch.agentKind === 'pi') {
    const nextKind = dbToMakerAgentKind(patch.agentKind);
    setState(sessionId, (s) => {
      const intentApplied = s.agentSwitchIntent?.target === nextKind;
      if (s.agentKind === nextKind && !intentApplied) return s;
      return {
        ...s,
        agentKind: nextKind,
        sdkSessionId: null,
        // 意图被真实切换消费 = 一次意图变更,推进修订号让在途读回作废。
        ...(intentApplied
          ? { agentSwitchIntent: null, agentSwitchIntentRev: s.agentSwitchIntentRev + 1 }
          : {}),
      };
    });
  }
  if (typeof patch.fastMode === 'boolean') {
    const next = patch.fastMode;
    setState(sessionId, (s) => (s.fastMode === next ? s : { ...s, fastMode: next }));
  }
  // 计划模式同 fastMode 语义镜像:承接「计划批准 → agent 自动退出」的 plan_mode_changed
  // 回流(persistSessionFields 广播), 让「+」菜单勾选与 chip 即时熄灭。
  if (typeof patch.planModeEnabled === 'boolean') {
    const next = patch.planModeEnabled;
    setState(sessionId, (s) =>
      s.planModeEnabled === next
        ? s
        : { ...s, planModeEnabled: next, planModeRev: s.planModeRev + 1 },
    );
  }
}

export const makerChatStore = {
  initGlobalListeners,
  subscribe,
  subscribeLight,
  getSnapshot,
  getLightSnapshot,
  /** Non-creating read: session has a paused, non-empty pending queue (sidebar indicator). */
  hasPausedQueue,
  mirrorSessionFields,
  /** F-SB-7: Subscribe to all session changes (for Sidebar running indicators). */
  subscribeAll,
  /** F-SB-7: Get a snapshot of currently running session IDs. */
  getRunningSnapshot,
  /** F-SB-7: Authoritative terminal-error read, immune to snapshot-generation races. */
  hasSessionTerminalError,
  wasLastStopSideTask,
  ensureInitialMessages,
  reloadMessages,
  /** 消息菜单:本地移除一次删除动作覆盖的整轮记录。 */
  removeMessagesByClientIds,
  /** 旧调用点兼容:本地精确移除一条消息。 */
  removeMessageByClientId,
  /** edit-last-message: 本地裁掉从 clientId(含)开始的消息段(镜像 rewind 软删)。 */
  dropMessagesFromClientId,
  loadOlderMessages,
  loadAroundMessage,
  loadAroundMessageClientId,
  sendMessage,
  /** #2194: MessageStream 强 pin 门控——区分本端发送与外部注入的 user 消息。 */
  isLocalSentUserMessage,
  beginRemoteOptimisticComposerTransition,
  cancelRemoteOptimisticSendsForDataOwnerBoundary,
  // /goal 从首页新建的会话不经普通发送路径,自动起名漏触发 —— 暴露此动作让调用方用目标文案补起名。
  autoNameSession: scheduleAutoName,
  compactSession,
  steerMessage,
  steerQueuedMessage,
  /** 订阅槽①:被意识钩子拦下的消息经编辑铅笔重发(普通重发,不 rewind、不 bypass)。 */
  resendBlockedMessage,
  /**
   * UI-trigger send path for renderer-synthesized agent prompts (currently:
   * mivo button clicks). Skips bubble + queue, prompt is filtered by
   * UI_ACTION_TRIGGER_PREFIX on display.
   */
  sendUiTrigger,
  stopSession,
  /** F-QUEUE-3: pop the most recent un-dispatched queued message. */
  popQueueTail,
  /** F-QUEUE-DEFER: toggle queue tail visibility; does not pause drain. */
  setQueueExpanded,
  /** Resume a paused queue and try dispatching the current head. */
  resumeQueue,
  /** Move a queued row to a new insertion index. */
  moveQueueItem,
  /** Toggle a short-lived edit/drag lock that prevents auto-drain races. */
  setQueueInteractionLock,
  /** Toggle a head-only edit lock for a queued row. */
  setQueueEditLock,
  /** F-QUEUE-DEFER: remove a single queued message by clientId (✕ button). */
  removeFromQueue,
  /** F-QUEUE-DEFER: edit a single queued message's text (✏️ button). */
  updateQueueItem,
  clearSession,
  /** Dismiss the error banner without retrying. */
  clearError,
  /** Retry the typed recovery target owned by main coordinator. */
  retryLastError,
  /** silent-stop 耗尽横幅「继续」:清横幅 + 隐藏续跑指令(见函数注释)。 */
  continueAfterSilentStop,
  /** error-tail-banner:忽略会话尾部错误行(乐观 + 持久化 dismissed)。 */
  dismissErrorTailMessage,
  /** Close a session's SDK query (for delete/archive cleanup). */
  closeSessionQuery,
  /**
   * MEM-1: Immediately free all in-memory state for a session.
   * Call this after a session is deleted or archived so the Map,
   * listeners, and any cached base64 images are garbage-collected.
   */
  purgeSession: _purgeSession,
  /** Seed runtime-only state before a session view has mounted and loaded DB metadata. */
  setSessionRuntime,
  noteAgentSwitched,
  noteAgentSwitchIntent,
  clearAgentSwitchIntent,
  getAgentSwitchIntent,
  /** 意图的单调修订号;异步读回的新鲜度判定用它,值比较会被 ABA 骗过。 */
  getAgentSwitchIntentRev,
  /** 会话所在端(被控端 / 另一窗口)的权威 pending 意图回流镜像;幂等,值等价即 no-op。 */
  mirrorAgentSwitchIntent,
  /** Update the displayed context window immediately after local model switches. */
  setContextWindow,
  /** MEM-OPT-2: Mark a session view mounted; returns a disposer for unmount. */
  enterView,
  /** MEM-OPT-2: Mark a session view unmounted. */
  leaveView,
  insertSystemCard,
  moveLearnCardToEnd,
  updateLastSystemCardData,
  updateSystemCardData,
  respondToPermission,
  respondToIssueConfirm,
  respondToRenameSessionsConfirm,
  respondToGhostGrantConfirm,
  answerUserQuestion,
  respondToPluginSetup,
  respondToPlanReview,
  cancelPlanReview,
  updatePendingPlanReviewContent,
  setFastMode,
  resetFastMode,
  setPlanMode,
  setPlanViewerState,
  /** F-AUQ-MIN-2/4: minimize/restore the AskUserQuestion prompt UI. */
  setAskUserViewerState,
  /** Minimize/restore the Host-owned plugin setup prompt UI. */
  setPluginSetupViewerState,
  /** F-AUQ-DRAFT: persist in-progress wizard state across session switch. */
  setAskUserDraft,
  setTitleUpdateCallback,
  syncActiveTurnsFromMain,
  /**
   * 当前 running 的 claude-code 后台任务 taskId 集合(按 taskId 归一,别名键去重)。
   * 用途:快照对账的候选集捕获 —— 必须在发起 listSessionBackgroundTasks **之前**
   * 调用,请求在飞窗口内新启动的任务才不会被误收(见 reconcileStaleRunningTasks)。
   */
  captureRunningClaudeTaskIds: (sessionId: string): ReadonlySet<string> => {
    const tasks = sessions.get(sessionId)?.taskUpdates;
    const out = new Set<string>();
    if (!tasks) return out;
    for (const task of tasks.values()) {
      if (task.status === 'running' && task.provider === 'claude-code') out.add(task.taskId);
    }
    return out;
  },
  /**
   * 后台任务快照水合:把 main 的 listSessionBackgroundTasks 结果补进 taskUpdates。
   * 只补「store 里完全没见过」的任务 —— 事件流是唯一实时源,快照可能落后于刚到
   * 的终态事件,已存在的条目(无论何状态)绝不用快照的 running 覆盖复活。
   * 消费方:useBackgroundBashTasks(会话挂载 / reloadMessages 清空 taskUpdates 后)、
   * BackgroundTasksBody(面板挂载)、活动熄灭触发的延迟对账。
   *
   * opts.staleRunningCandidates(可选):对账收口 —— 调用方在**发起快照请求前**
   * 从 store 捕获的 running claude-code taskId 集合;seed 完成后,候选集内仍
   * running 且不在快照中的条目标 stopped(终态事件丢失的自愈,时序论证见
   * reconcileStaleRunningTasks)。仅本机会话可传:device-link 镜像会话的快照
   * 有降级空表窗口,不可当权威(与远程豁免 running 折算同口径)。
   */
  seedBackgroundTaskSnapshots: (
    sessionId: string,
    tasks: Array<{ taskId: string; taskType?: string; toolUseId?: string; title?: string }>,
    opts?: { staleRunningCandidates?: ReadonlySet<string> },
  ): void => {
    const candidates = opts?.staleRunningCandidates;
    if (!tasks.length && !(candidates && candidates.size > 0)) return;
    setState(sessionId, (s) => {
      let next = s;
      for (const t of tasks) {
        if (!t || typeof t.taskId !== 'string' || !t.taskId) continue;
        const seen =
          next.taskUpdates?.has(t.taskId) ||
          (t.toolUseId ? next.taskUpdates?.has(t.toolUseId) : false);
        if (seen) continue;
        next = handleStreamEvent(next, {
          sessionId,
          type: 'agent_task_update',
          source: 'claude-code',
          data: {
            provider: 'claude-code',
            taskId: t.taskId,
            status: 'running',
            ...(t.taskType ? { taskType: t.taskType } : {}),
            ...(t.toolUseId ? { parentToolUseId: t.toolUseId } : {}),
            ...(t.title ? { title: t.title } : {}),
          },
        } as CCAgentStreamEvent);
      }
      if (candidates && candidates.size > 0) {
        next = reconcileStaleRunningTasks(next, tasks, candidates);
      }
      return next;
    });
  },
  /** Exposed for tests only. */
  __teardownGlobalListeners,
  /** Exposed for tests only: unlike getSnapshot, this probe never creates a session slice. */
  __hasSessionForTest: (sessionId: string): boolean => sessions.has(sessionId),
  /** Exposed for tests only: isolate remote terminal lifecycle tombstones. */
  __resetRemoteTerminalTombstonesForTest: (): void => {
    remoteTerminalSessionTombstones.clear();
  },
  /** Exposed for tests only: 非首条消息的补起名(纯附件首条 / fork 占位)。 */
  __autoNameUnnamedSessionForTest: maybeAutoNameUnnamedSession,
  /** Exposed for tests only: 清空「已确认无需起名」缓存,隔离用例间状态。 */
  __resetAutoNameStateForTest: (): void => {
    autoNameSettled.clear();
    autoNameAttempts.clear();
  },
  /** Exposed for tests only: 把 stream event 打进真实 store(驱动 getRunningSnapshot 等)。 */
  __applyStreamEventForTest: (sessionId: string, event: CCAgentStreamEvent): void => {
    supersedeInputProjectionOnTerminalEvent(sessionId, event);
    setState(sessionId, (s) => handleStreamEvent(s, event));
  },
  /** Exposed for tests only: 把 status update 打进真实 store。 */
  __applyStatusUpdateForTest: (sessionId: string, update: CCAgentStatusUpdate): void => {
    if (!isTurnContinuationBoundaryEvent(update) && !update.skipTurnReset && !update.isRunning) {
      supersedeInputProjectionRequests(sessionId, { supersedeOperations: true });
    }
    setState(sessionId, (s) => handleStatusUpdate(s, update));
  },
  /** Exposed for tests only. */
  __hydratePersistedMessageForTest: hydratePersistedMessage,
  /** Exposed for tests only. */
  __mapServerMessagesForTest: mapServerMessages,
  /** Exposed for tests only: 历史初始页 backfill 的"无可见锚点"判定。 */
  __isNonAnchorHistoryRowForTest: isNonAnchorHistoryRow,
  /** Exposed for tests only. */
  __mergeMessagesForTest: mergeMessages,
  /** Exposed for tests only. */
  __serverMessagePageHasMoreForTest: serverMessagePageHasMore,
  /** Exposed for tests only. */
  __shouldStopRemoteReconciliationAtOverlapForTest: shouldStopRemoteReconciliationAtOverlap,
  /** Exposed for tests only. */
  __getRemoteReconciliationOverlapDecisionForTest: getRemoteReconciliationOverlapDecision,
  /** Exposed for tests only. */
  __oldestMessageRowForTest: oldestMessageRow,
  /**
   * device-link:remote-projects 来源解析后重载已打开会话的历史。生产路径由
   * initGlobalListeners 里的 remoteProjectsStore.subscribe 自动驱动;导出供单测直接调用,
   * 免去整套 initGlobalListeners 的 electronAPI mock。
   */
  reconcileOpenSessionOrigins,
  /**
   * device-link:对账打开的远程会话消息(重拉最近一页 + 合并去重,补回 push 丢失的消息)。
   * 由 useRemoteSessionSync 在重连 / 被控端回在线 / turn 结束 / 聚焦 / 手动同步时调用。
   * `opts.force` 仅供 stall 看门狗在确认被控端 not-running 后放行 isStreaming 守卫。
   */
  reconcileRemoteMessages,
  /** stall 看门狗:读某 session 最近入站事件时刻(ms),判「卡死 Generating 但久未收 push」。 */
  getLastInboundEventAt,
  /** stall 看门狗:确认被控端 turn 已结束后,强制收尾控制端卡死的远程 turn(幂等)。 */
  finalizeStuckRemoteTurn,
  /**
   * 打开/重连/刷新会话时重建当前挂起的交互面板(permission/ask/plan)。pending 状态原本
   * 只由实时 push 设置,中途加入的窗口靠这个快照查询补回。ensureInitialMessages 自动调用;
   * useRemoteSessionSync 在重连 / 聚焦时也调,补回断连期间产生的交互。
   */
  reconcilePendingInteractions,
  __activeViewTest: {
    getActiveSessionIds: () => [..._activeViewSessions.keys()],
    getLastViewedAt: (sessionId: string) => _lastViewedAt.get(sessionId),
  },
};

// ---------------------------------------------------------------------------
// Helpers (verbatim from old hook)
// ---------------------------------------------------------------------------

type RemoteRowsOrder = 'newest-first' | 'oldest-first';

/** 自愈活动行的两种卡型（ephemeral 进行中 + 落库记录）。 */
const AUTO_RESUME_CARD_TYPES = new Set(['auto-resume', 'auto-resume-pending']);

/**
 * 这一行对用户是不是"实质内容"（用来切分自愈事件的边界）。
 *
 * **必须与 main 的产出判据同语义**（`interruptedTurnAutoResume.isSubstantiveProgressEvent`：
 * 用户看得见的文本、或工具调用）。不一致的后果是两边对"还在不在同一次中断里"的判断分叉：
 * 开了 reasoning 的重连只吐 thinking 就再次失败时，main 仍把它算在同一段（attempt 2/5），
 * 而这里若把 thinking 行当成边界，卡片就不再折叠——一次中断在流里堆出多行，正是「连续重连
 * 原地更新同一行」要避免的（codex P1）。
 *
 * 「看得见」不自己判：与 main 共用 `shared/visibleText.ts` 的 `hasUserVisibleText`（纯空白与
 * 零宽字符都算看不见）。各写一份必然漂移 —— `trim()` 挡不住 U+200B 这类零宽字符就是实例
 * （greptile P2）。
 */
function isSubstantiveChatRow(message: ChatMessage): boolean {
  // 其它系统卡（compact / goal 分隔条等）算边界:它们之后的重连属于新一段。
  if (message.systemCardType && !AUTO_RESUME_CARD_TYPES.has(message.systemCardType)) return true;
  // 隐藏的合成指令行（含我们自己补发的续跑指令）不算内容。
  if (message.isSyntheticTrigger === true) return false;
  // thinking 不算产出（与 main 一致）：用户没看到任何回答，那次重连也就没成功。
  if (message.role === 'thinking') return false;
  return typeof message.content === 'string'
    ? hasUserVisibleText(message.content)
    : message.content != null;
}

/**
 * 把**同一次中断事件**的多条自愈行折叠成一行。
 *
 * 一次中断可能连续重连多次（1/5 → 2/5 → …），每次都会真的补发一条续跑消息、因此每次
 * 都在 DB 里留一行。但那是同一个事件的推进过程，不是 5 件事——流里堆 5 条「重新连接」
 * 既吵又读不出"还在同一次重连里"。所以只保留**最后一条**（它带最新计数与最终结果），
 * 前面的退回隐藏占位（去掉 systemCardType 后就是普通合成指令行，渲染 null）。
 *
 * 边界是"实质内容"：模型一旦产出过东西，后面的中断就是新一段，不再折叠进来——这与
 * main 侧「有产出就重置连续计数」的判据是同一条线。
 */
function collapseConsecutiveAutoResumeRows(messages: ChatMessage[]): ChatMessage[] {
  let sawCardSinceContent = false;
  let changed = false;
  let out: ChatMessage[] | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    const cardType = message.systemCardType;
    if (cardType && AUTO_RESUME_CARD_TYPES.has(cardType)) {
      if (sawCardSinceContent) {
        if (!out) out = messages.slice();
        // 去掉卡型后就是普通合成指令行(渲染 null),仍留在流里参与时序判定。
        const stripped: ChatMessage = { ...message };
        delete stripped.systemCardType;
        delete stripped.systemCardData;
        out[i] = stripped;
        changed = true;
      } else {
        sawCardSinceContent = true;
      }
      continue;
    }
    if (isSubstantiveChatRow(message)) sawCardSinceContent = false;
  }
  return changed && out ? out : messages;
}

function mergeMessages(
  serverMsgs: ChatMessage[],
  existing: ChatMessage[],
  /**
   * addOnly:只补窗口里缺的行,**不**用 server 快照去 hydrate 已有的行。
   *
   * 给"取回来很久之后才发布"的来源用(跳转补齐的多页循环:第一页可能在几秒前就取到了,
   * 期间 local-db:messages:created 可能已经把某行更新过)。默认的 hydrate 是
   * `{...existing, ...persisted}`,persisted 赢 —— 那时旧快照会把 live 更新盖回去
   * (#676 review codex P1)。彻底解法需要每条消息的修订号,而 messages 表没有 updatedAt,
   * 属于跨层改动;这里先把"发布延迟最长"的那个来源摘出去。
   */
  options: HydratePersistedMessageOptions & {
    addOnly?: boolean;
    /** addOnly 的白名单:这些 clientId 仍然照常 hydrate。 */
    addOnlyExcept?: ReadonlySet<string>;
  } = {},
  rowsOrder: RemoteRowsOrder = 'oldest-first',
): ChatMessage[] {
  const serverOrder = new Map(serverMsgs.map((message, index) => [message.clientId, index]));
  if (existing.length === 0) {
    return collapseConsecutiveAutoResumeRows(
      sortMessagesChronologically(serverMsgs, serverOrder, rowsOrder),
    );
  }
  const serverByClientId = new Map(serverMsgs.map((message) => [message.clientId, message]));
  const seen = new Set<string>();
  let changed = false;
  const hydratedExisting = existing.map((message) => {
    seen.add(message.clientId);
    const persisted = serverByClientId.get(message.clientId);
    if (!persisted) return message;
    if (options.addOnly === true && options.addOnlyExcept?.has(message.clientId) !== true) {
      return message;
    }
    const hydrated = hydratePersistedMessage(message, persisted, options);
    if (hydrated !== message) changed = true;
    return hydrated;
  });
  const filtered = serverMsgs.filter((m) => !seen.has(m.clientId));
  if (filtered.length > 0) changed = true;
  const sorted = sortMessagesChronologically(
    [...hydratedExisting, ...filtered],
    serverOrder,
    rowsOrder,
  );
  const sameOrder =
    sorted.length === existing.length &&
    sorted.every((message, index) => message === existing[index]);
  return !changed && sameOrder ? existing : collapseConsecutiveAutoResumeRows(sorted);
}

/** 对账找不到重叠时,用远端权威窗口替换旧缓存窗口,只保留对账期间新到的消息。 */
function mergeAuthoritativeRemoteWindow(
  serverMsgs: ChatMessage[],
  lateArrivals: ChatMessage[],
  rowsOrder: RemoteRowsOrder,
): ChatMessage[] {
  if (serverMsgs.length === 0) return lateArrivals;
  // addOnly:lateArrivals 全是"快照之后才到"的行,它们比 serverMsgs 更新,不能被旧快照 hydrate
  // (#676 review codex P1)。权威行本身是新增,不受影响。
  return mergeMessages(serverMsgs, lateArrivals, { addOnly: true }, rowsOrder);
}

function sortMessagesChronologically(
  messages: ChatMessage[],
  serverOrder: Map<string, number> = new Map(),
  rowsOrder: RemoteRowsOrder = 'oldest-first',
): ChatMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const timeDiff = messageTime(a.message.createdAt) - messageTime(b.message.createdAt);
      if (!Number.isNaN(timeDiff) && timeDiff !== 0) return timeDiff;
      const rowidDiff = messageRowid(a.message) - messageRowid(b.message);
      if (!Number.isNaN(rowidDiff) && rowidDiff !== 0) return rowidDiff;
      const aServerOrder = serverOrder.get(a.message.clientId);
      const bServerOrder = serverOrder.get(b.message.clientId);
      if (
        aServerOrder !== undefined &&
        bServerOrder !== undefined &&
        aServerOrder !== bServerOrder
      ) {
        return rowsOrder === 'oldest-first'
          ? aServerOrder - bServerOrder
          : bServerOrder - aServerOrder;
      }
      return a.index - b.index;
    })
    .map((item) => item.message);
}

function oldestServerMessageIdForWindow(
  rows: Message[],
  existingMessages: ChatMessage[],
  previousOldestId: string | null,
  rowsOrder: RemoteRowsOrder,
): string | null {
  const oldestRow = oldestMessageRow(rows, rowsOrder);
  if (!oldestRow) return previousOldestId;
  if (!previousOldestId) return oldestRow.id;

  const existingOldest = oldestChatMessage(existingMessages);
  if (!existingOldest) {
    return previousOldestId;
  }
  return compareMessageTimeline(oldestRow, existingOldest) < 0 ? oldestRow.id : previousOldestId;
}

/**
 * 把一条窗口内消息换算回"落库那条时间线"上的可比对象(与原始 DB 行同口径)。
 *
 * 只有 thinking 需要换算:mapServerMessages 会把它的 createdAt 改写成 `finishedAt - durationMs`
 * (渲染层拿它当块的开始时刻算时长)。拿改写后的值去跟原始 DB 行比大小,就是在混两条时间线。
 * 换算不出来(没有 thinkingFinishedAtMs)时返回 null,调用方按"无法判定 ⇒ 保守判脱离"处理。
 */
function thinkingSafeTimelineRow(
  message: ChatMessage,
): { createdAt?: string; rowid?: number } | null {
  if (message.role !== 'thinking') return message;
  if (typeof message.thinkingFinishedAtMs !== 'number') return null;
  if (!Number.isFinite(message.thinkingFinishedAtMs)) return null;
  return {
    createdAt: new Date(message.thinkingFinishedAtMs).toISOString(),
    rowid: message.rowid,
  };
}

/**
 * 权威窗口里最新的一行(判"晚到的行是否落在权威范围内"用)。
 *
 * 用 compareMessageTimeline 取最大,而不是只比毫秒:同毫秒的多行靠 rowid 定序,只比毫秒可能
 * 挑到 rowid 更小的那行当"最新边界",于是把同毫秒、rowid 更大的**范围内**晚到行误判成脱离
 * (#676 review copilot)。与 oldestMessageRow 同口径。
 */
function newestMessageRowForWindow(rows: Message[]): Message | null {
  let newest: Message | null = null;
  for (const row of rows) {
    if (!Number.isFinite(messageTime(row.createdAt))) continue;
    if (newest === null || compareMessageTimeline(row, newest) > 0) newest = row;
  }
  return newest;
}

function oldestMessageRow(
  rows: Message[],
  rowsOrder: RemoteRowsOrder = 'oldest-first',
): Message | null {
  if (rows.length === 0) return null;
  return (
    rows
      .map((message, index) => ({ message, index }))
      .sort((a, b) => {
        const timeDiff = messageTime(a.message.createdAt) - messageTime(b.message.createdAt);
        if (!Number.isNaN(timeDiff) && timeDiff !== 0) return timeDiff;
        const rowidDiff = messageRowid(a.message) - messageRowid(b.message);
        if (!Number.isNaN(rowidDiff) && rowidDiff !== 0) return rowidDiff;
        return rowsOrder === 'oldest-first' ? a.index - b.index : b.index - a.index;
      })[0]?.message ?? null
  );
}

function oldestChatMessage(rows: ChatMessage[]): ChatMessage | null {
  return (
    rows
      .filter((message) => Number.isFinite(messageTime(message.createdAt)))
      .sort(compareMessageTimeline)[0] ?? null
  );
}

function serverMessagePageHasMore(rows: Message[], pageSize = 50): boolean {
  return rows.length >= pageSize || rows.some((row) => row.agentMeta?.remoteRowsTrimmed === true);
}

function historyRowsPlanBackfillState(
  rows: Message[],
  taskHistoryMayBeIncomplete: boolean,
): {
  hasPlanEvent: boolean;
  isResolved: boolean;
} {
  const state = getLatestMessageTodoState(mapServerMessages(rows), {
    taskHistoryMayBeIncomplete,
  });
  return {
    hasPlanEvent: state.hasPlanEvent,
    isResolved: state.isResolved,
  };
}

function shouldStopRemoteReconciliationAtOverlap(
  rows: Message[],
  hasKnownOverlap: boolean,
): boolean {
  if (!hasKnownOverlap) return false;
  // device-link row-trimmed pages are only a partial window. Even if they overlap
  // with live-pushed messages, we still need to page older rows to fill the gap.
  return !rows.some((row) => row.agentMeta?.remoteRowsTrimmed === true);
}

function getRemoteReconciliationOverlapDecision(
  rows: Message[],
  hasKnownOverlap: boolean,
): { reachedKnownWindow: boolean; shouldStop: boolean } {
  return {
    reachedKnownWindow: hasKnownOverlap,
    shouldStop: shouldStopRemoteReconciliationAtOverlap(rows, hasKnownOverlap),
  };
}

function messageTime(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function messageRowid(message: { rowid?: number }): number {
  return typeof message.rowid === 'number' && Number.isFinite(message.rowid)
    ? message.rowid
    : Number.NaN;
}

function compareMessageTimeline(
  a: { createdAt?: string; rowid?: number },
  b: { createdAt?: string; rowid?: number },
): number {
  const timeDiff = messageTime(a.createdAt) - messageTime(b.createdAt);
  if (!Number.isNaN(timeDiff) && timeDiff !== 0) return timeDiff;
  const rowidDiff = messageRowid(a) - messageRowid(b);
  if (!Number.isNaN(rowidDiff) && rowidDiff !== 0) return rowidDiff;
  return 0;
}

function mapServerCreatedAt(
  cm: ChatMessage,
  rawCreatedAt: string | number | undefined,
): string | undefined {
  const persistedMs =
    cm.role === 'thinking' && typeof cm.thinkingFinishedAtMs === 'number'
      ? cm.thinkingFinishedAtMs
      : rawCreatedAt === undefined
        ? Number.NaN
        : new Date(rawCreatedAt).getTime();
  if (!Number.isFinite(persistedMs)) return undefined;
  if (cm.role === 'thinking') {
    // Thinking rows are persisted at final/redacted time; prefer the event time
    // stored in content because DB insert can run later behind the write queue.
    // ChatMessage.createdAt is consumed as the block start time by work-group
    // duration calculation.
    const durationMs =
      typeof cm.thinkingDurationMs === 'number' && Number.isFinite(cm.thinkingDurationMs)
        ? Math.max(0, cm.thinkingDurationMs)
        : 0;
    return new Date(persistedMs - durationMs).toISOString();
  }
  return new Date(persistedMs).toISOString();
}

/**
 * Synthetic UI-trigger user rows(隐藏续跑 / Mivo 按钮指令)不再被过滤丢弃,
 * 而是保留 + 打标 isSyntheticTrigger(review P2):它们经 coordinator enqueue
 * 正常落库,是时序的一部分 —— 过滤掉会让 error-tail banner 的「尾部」判定在
 * 续跑已被接受、可见产出未到达(排队/立即重载)时仍把旧 error 行当最后一条
 * 可见消息,banner 重现并允许重复发送续跑。打标行由 MessageStream 渲染 null、
 * content 置空,视觉上与从前的过滤等价。判定同时覆盖 raw-string 与 JSON 包裹
 * 的 `{text, ...}` 两种 content 形态。
 * (模块级共享:mapServerMessages 打标用,loadOlderMessages 的可见锚点判定
 * 也用它排除"渲染 null 的 user 行"。)
 */
function isSyntheticTriggerRow(m: Message): boolean {
  if (m.role !== 'user') return false;
  const c = m.content;
  if (typeof c === 'string') return c.startsWith(UI_ACTION_TRIGGER_PREFIX);
  if (c && typeof c === 'object') {
    const text = (c as { text?: unknown }).text;
    return typeof text === 'string' && text.startsWith(UI_ACTION_TRIGGER_PREFIX);
  }
  return false;
}

/**
 * 该 thinking 服务端行是否**不进渲染列表**(DB 行照旧保留,只是不展示)。
 *
 * 三类:
 *   - `isRedacted` 加密推理:没有任何明文可读,卡片只能显示"无法显示的思考过程",对用户是
 *     纯噪音;上游开服务端工具后一轮能出十几条,会淹掉真实产出。与 live 路径
 *     (handleStreamEvent 的 stage==='redacted')同判定。
 *   - pi 旧版 translator 丢失 redacted 标记后落下的精确 `[Reasoning redacted]` 占位:
 *     无需改库,历史恢复时按同一语义隐藏。
 *   - omitted-display 占位行(空文本 + 0 时长,非 redacted):不复原成 "Thought for 1s" 卡片。
 *     上游恢复明文下发后新数据自然不再命中。
 *
 * 单一来源:mapServerMessages 的过滤与 `isNonAnchorHistoryRow` 的 backfill 判定都用它,
 * 避免"过滤掉了却没触发补页"这类漂移。将来要恢复展示某一类,只改这里。
 */
function isHiddenThinkingRow(m: Message): boolean {
  if (m.role !== 'thinking' || !m.content || typeof m.content !== 'object') return false;
  const c = m.content as Record<string, unknown>;
  if (c.isRedacted === true) return true;
  const text = typeof c.text === 'string' ? c.text : '';
  if (isLegacyRedactedThinkingPlaceholder(m, text)) return true;
  const durationMs = typeof c.durationMs === 'number' ? c.durationMs : 0;
  return isOmittedThinkingPlaceholder(text, durationMs);
}

/**
 * 该服务端行**渲染后不会留下可见锚点**(初始页全是这类行时必须继续往前翻页)。
 *
 * 五类:
 *   - `tool_result`:配对的 tool_use 父消息可能在更老的页里,MessageStream 会丢弃 orphan;
 *   - 被 `isHiddenThinkingRow` 过滤掉的行:直接不进渲染列表;
 *   - 计划工具调用:MessageStream 会吞掉,只更新 composer 上方的计划胶囊;
 *   - 合成指令行(`isSyntheticTriggerRow`):MessageStream 渲染 null、content 置空,
 *     与 `loadOlderMessages` 的可见锚点判定同口径(见该处「合成指令行渲染 null,不算可见
 *     锚点」)。少了这一类,一页里只要混进一条合成 user 行就会被当成锚点提前停止回填,
 *     而它映射后同样不产生可见内容 —— 症状与完全不回填一样;
 *   - 子代理内部行(`isSubagentInternalHistoryRow`):`buildRenderItems` 在入口整体剔除,
 *     一条都不进渲染列表。子代理密集的会话最新一页可能**全部**是这类行(实测本机库里
 *     单会话可达上万条),漏登记就会重现上面那种「DB 里有几千条、重开渲染 0 项」的症状。
 *
 * 任何组合占满整页,都会让映射结果为空,而 MessageStream 在 `visibleRenderItems.length === 0`
 * 时不触发自动翻页 —— 结果是 DB 里有几千条消息、重开会话却渲染 0 项,更老的用户/助手消息
 * 再也拉不回来。
 */
function isNonAnchorHistoryRow(m: Message): boolean {
  return (
    m.role === 'tool_result' ||
    isHiddenThinkingRow(m) ||
    isAgentPlanHistoryToolUseRow(m) ||
    isSyntheticTriggerRow(m) ||
    isSubagentInternalHistoryRow(m)
  );
}

/**
 * 服务端行是子代理内部消息(`buildRenderItems` 会整体剔除,见该处 Pass -1)。
 *
 * 判据与渲染侧共用同一个形态函数:只认 SDK tool-parent 形态,legacy Claude 导入存在
 * 同一字段上的普通 transcript 链边不算 —— 否则父会话自己的正文会被当成无锚点行。
 */
function isSubagentInternalHistoryRow(m: Message): boolean {
  const parent = m.agentMeta?.parentUuid;
  return typeof parent === 'string' && parent.length > 0 && isSubagentParentToolUseId(parent);
}

function isAgentPlanHistoryToolUseRow(m: Message): boolean {
  if (m.role !== 'tool_use') return false;
  return isAgentPlanToolName(historyToolName(m));
}

function historyToolName(m: Message): string | undefined {
  if (!m.content || typeof m.content !== 'object') return undefined;
  const toolName = (m.content as Record<string, unknown>).toolName;
  return typeof toolName === 'string' ? toolName : undefined;
}

function mapServerMessages(serverMsgs: Message[]): ChatMessage[] {
  // Build per-clientId createdAt lookup so we can patch it onto every
  // mapped ChatMessage uniformly (each branch below builds a different
  // shape, easier to attach the timestamp once at the end).
  const createdAtById = new Map(serverMsgs.map((m) => [m.clientId, m.createdAt]));
  const rowidById = new Map(serverMsgs.map((m) => [m.clientId, m.rowid]));
  const remoteContentTruncatedById = new Map(
    serverMsgs.map((m) => [m.clientId, m.agentMeta?.remoteContentTruncated === true]),
  );
  const remoteRowsTrimmedById = new Map(
    serverMsgs.map((m) => [m.clientId, m.agentMeta?.remoteRowsTrimmed === true]),
  );
  const filtered = serverMsgs.filter((m) => !isHiddenThinkingRow(m));
  const ordered = filtered.sort(compareMessageTimeline);
  const legacyUserTurnCosts = projectLegacyUserTurnCosts(ordered);
  const mapped = ordered.map((m) => {
    if (m.role === 'tool_use' && m.content && typeof m.content === 'object') {
      const c = m.content as Record<string, unknown>;
      const toolName = typeof c.toolName === 'string' ? c.toolName : '';
      const toolInput = c.input ?? null;
      // toolUseId 来源:DB 列(新数据) → fallback 旧数据存在 content.toolUseId 里
      const toolUseId =
        (typeof m.toolUseId === 'string' && m.toolUseId.length > 0 ? m.toolUseId : undefined) ??
        (typeof c.toolUseId === 'string' && c.toolUseId.length > 0 ? c.toolUseId : undefined);
      return {
        clientId: m.clientId,
        role: m.role,
        content: formatToolUseSummary(toolName, toolInput),
        toolUseId,
        toolName,
        toolInput,
        ...(toolName === 'update_plan' && c.terminalPlanSnapshot === true
          ? {
              terminalPlanSnapshot: true,
              ...(typeof c.terminalPlanAtMs === 'number'
                ? { terminalPlanAtMs: c.terminalPlanAtMs }
                : {}),
            }
          : {}),
        ...(toolName === 'update_plan' && c.turnCompleted === false
          ? { turnCompleted: false }
          : {}),
        isStreaming: false,
        // subagent-model-chip: 从持久化 agentMeta 复原 model / parentUuid,
        // 让历史重载后 Agent/Task 行也能显示子代理模型 chip(透传点 B)。
        ...(typeof m.agentMeta?.model === 'string' && m.agentMeta.model
          ? { model: m.agentMeta.model }
          : {}),
        // 只提升 SDK tool-parent 形态(toolu_ / call_):legacy Claude 导入把
        // transcript 链边(preceding-user-uuid 这类非 RFC 串)也存在 parentUuid 上,
        // 无条件提升会让顶层计划行被判成子代理、普通 user 行被当成合成边界,而
        // 保留裸字段的 mobile / main 不会——同一份历史两端分组分叉(review P2)。
        ...(typeof m.agentMeta?.parentUuid === 'string' &&
        isSubagentParentToolUseId(m.agentMeta.parentUuid)
          ? { parentToolUseId: m.agentMeta.parentUuid }
          : {}),
      };
    }
    // F7.6: Restore ask_user messages from server
    if (m.role === 'ask_user' && m.content && typeof m.content === 'object') {
      const c = m.content as Record<string, unknown>;
      const status = c.status as string | undefined;
      // On restart, pending messages become expired (session is gone)
      const resolvedStatus = status === 'answered' ? 'answered' : 'expired';

      // v2 format: questions[] + answers Record
      const questions = Array.isArray(c.questions)
        ? (c.questions as AskUserQuestionItem[])
        : undefined;
      const answers =
        c.answers && typeof c.answers === 'object'
          ? (c.answers as Record<string, string>)
          : undefined;

      // Build display content from questions or legacy question field
      const displayContent = questions
        ? questions.map((q) => q.question).join(' / ')
        : typeof c.question === 'string'
          ? c.question
          : '';

      // Build reply summary from answers or legacy reply field
      const replySummary = answers
        ? formatAskUserReply(answers)
        : typeof c.reply === 'string'
          ? c.reply
          : null;

      return {
        clientId: m.clientId,
        role: m.role,
        content: displayContent,
        isStreaming: false,
        askUserStatus: resolvedStatus as 'answered' | 'expired',
        askUserRequestId: typeof c.requestId === 'string' ? c.requestId : undefined,
        askUserReply: replySummary,
        askUserQuestions: questions,
        askUserAnswers: answers,
        // Legacy compat fields
        askUserOptions: c.options as Array<{ label: string; description?: string }> | undefined,
        askUserPageIndicator: typeof c.pageIndicator === 'string' ? c.pageIndicator : undefined,
      };
    }
    // Restore thinking messages from server (write-once at final, see
    // 'thinking' case in handleStreamEvent for the persisted content shape).
    if (m.role === 'thinking' && m.content && typeof m.content === 'object') {
      const c = m.content as Record<string, unknown>;
      const text = typeof c.text === 'string' ? c.text : '';
      const durationMs = typeof c.durationMs === 'number' ? c.durationMs : 0;
      const isRedacted = c.isRedacted === true;
      const finishedAt =
        typeof c.finishedAt === 'number'
          ? c.finishedAt
          : typeof c.finishedAt === 'string'
            ? new Date(c.finishedAt).getTime()
            : undefined;
      return {
        clientId: m.clientId,
        role: m.role,
        content: text,
        isStreaming: false,
        thinkingDurationMs: durationMs,
        thinkingRedacted: isRedacted,
        ...(typeof finishedAt === 'number' && Number.isFinite(finishedAt)
          ? { thinkingFinishedAtMs: finishedAt }
          : {}),
        // No thinkingStartedAt on restore — the live elapsed counter only
        // matters for the in-progress state; restored cards are always final.
        // subagent-model-chip: 该分支在默认分支(下方投影 model/parentUuid)之前 return,
        // 所以这里要单独补 —— 否则纯 thinking 子代理重载后 buildSubagentModelMap 收不到。
        ...(typeof m.agentMeta?.model === 'string' && m.agentMeta.model
          ? { model: m.agentMeta.model }
          : {}),
        ...(typeof m.agentMeta?.parentUuid === 'string' &&
        isSubagentParentToolUseId(m.agentMeta.parentUuid)
          ? { parentToolUseId: m.agentMeta.parentUuid }
          : {}),
      };
    }
    // FP-3: Restore plan_review messages from server
    if (m.role === 'plan_review' && m.content && typeof m.content === 'object') {
      const c = m.content as Record<string, unknown>;
      const rawStatus = typeof c.status === 'string' ? c.status : undefined;
      // On restart, pending messages become expired (session is gone)
      const resolvedStatus: 'approved' | 'revised' | 'expired' | 'cancelled' =
        rawStatus === 'approved'
          ? 'approved'
          : rawStatus === 'revised'
            ? 'revised'
            : rawStatus === 'cancelled'
              ? 'cancelled'
              : 'expired';
      const plan = typeof c.plan === 'string' ? c.plan : '';
      const planFilePath = typeof c.planFilePath === 'string' ? c.planFilePath : '';
      const feedback = typeof c.feedback === 'string' ? c.feedback : undefined;

      return {
        clientId: m.clientId,
        role: m.role,
        // content is display-only; the Markdown source of truth is
        // planReviewPlan (mirrors the event-side fix above).
        content: '',
        isStreaming: false,
        planReviewStatus: resolvedStatus,
        planReviewRequestId: typeof c.requestId === 'string' ? c.requestId : undefined,
        planReviewPlan: plan,
        planReviewFilePath: planFilePath,
        planReviewFeedback: feedback,
      };
    }
    // terminal error 持久化行(main 的 onTurnErrorEvent 落库,不广播):历史加载
    // 时还原成静态错误卡。content = { message, reason?, sdkError? };message 是
    // 兜底文案,reason 是稳定 key,ErrorMessageCard 渲染时按 reason 走 i18n。
    if (m.role === 'error') {
      if (typeof m.content === 'string') {
        return {
          clientId: m.clientId,
          role: m.role,
          content: m.content,
          isStreaming: false,
        };
      }
      const c = (m.content && typeof m.content === 'object' ? m.content : {}) as Record<
        string,
        unknown
      >;
      const message = typeof c.message === 'string' ? c.message : '';
      const reason = typeof c.reason === 'string' ? c.reason : undefined;
      const errorProviderId =
        typeof c.providerId === 'string' && c.providerId ? c.providerId : undefined;
      return {
        clientId: m.clientId,
        role: m.role,
        content: message,
        isStreaming: false,
        ...(reason ? { errorReason: reason } : {}),
        // 错误发生时的 provider 快照:恢复后的分类按它走,不用当前 session.providerId。
        ...(errorProviderId ? { errorProviderId } : {}),
        // interrupted-turn-resume:「忽略」的持久化标记(updateContent 写入)。
        ...(c.dismissed === true ? { errorDismissed: true } : {}),
      };
    }
    // session-agent-switch:引擎切换边界行 → 'agent-switch' system card(与
    // compact 分隔同视觉语言)。role 投影成 'assistant' 走 SystemCard 渲染管线
    // (工作组分组守卫天然排除 systemCardType 消息,无需改 MessageStream);
    // 交接全文放 systemCardData.handoff,由卡片展开入口按需查看,不进对话正文。
    if (m.role === 'agent_switch') {
      const c = (m.content && typeof m.content === 'object' ? m.content : {}) as Record<
        string,
        unknown
      >;
      return {
        clientId: m.clientId,
        role: 'assistant' as const,
        content: '',
        isStreaming: false,
        systemCardType: 'agent-switch' as const,
        systemCardData: {
          fromAgentKind: typeof c.fromAgentKind === 'string' ? c.fromAgentKind : '',
          toAgentKind: typeof c.toAgentKind === 'string' ? c.toAgentKind : '',
          fromModel: typeof c.fromModel === 'string' ? c.fromModel : null,
          toModel: typeof c.toModel === 'string' ? c.toModel : null,
          handoff: typeof c.handoff === 'string' ? c.handoff : '',
          resumed: c.resumed === true,
        },
      };
    }
    // image-local-cache: user role messages may have JSON-shaped content
    // ({ text, images: ImageRef[], files: FileRef[] }) — pull text + images
    // + files out, keep all three. Older plain-text messages fall through
    // unchanged (parsed.images / parsed.files default to []).
    if (m.role === 'user') {
      if (isSyntheticTriggerRow(m)) {
        // 合成指令行:占位参与时序,不渲染、不外泄原文。
        return {
          clientId: m.clientId,
          role: m.role,
          content: '',
          isStreaming: false,
          isSyntheticTrigger: true,
          // 中断自动续跑补发的续跑指令带 [UI_ACTION_TRIGGER] 前缀(复用人工「继续」
          // 那条常量),会先命中本分支 —— 但它同样是**自动**动作,必须渲染「已自动
          // 继续」分隔线(MessageStream 对 systemCardType 的处理刻意优先于 synthetic
          // early-return)。少这一句,用户看到的是任务自己接着跑了、没有任何交代。
          ...(m.agentMeta?.autoResume === true
            ? {
                systemCardType: 'auto-resume' as const,
                systemCardData: {
                  ...(m.agentMeta.autoResumeInfo ?? {}),
                  ...(m.agentMeta.autoResumeOutcome
                    ? { outcome: m.agentMeta.autoResumeOutcome }
                    : {}),
                },
              }
            : {}),
        };
      }
      // silent-stop 自动续跑注入的「继续」(agentMeta.autoResume,main 守卫落库):
      // 不渲染用户气泡,渲染「已自动继续」分隔线(SystemCard,与 compact 分隔同
      // 语言)。历史加载与 messages:created 直推两条路径都经过这里,live/重开一致。
      if (m.agentMeta?.autoResume === true) {
        return {
          clientId: m.clientId,
          role: m.role,
          content: '',
          isStreaming: false,
          isSyntheticTrigger: true,
          systemCardType: 'auto-resume' as const,
          // 展示信息只有「中断自愈」那条路径带(silent-stop 本身没有 error / 次数)。
          // SystemCard 据此二选一:带信息 → 三态重连行;不带 → silent-stop 原来的
          // 「已自动继续」分隔条(见 hasInterruptionContext)。
          systemCardData: {
            ...(m.agentMeta.autoResumeInfo ?? {}),
            ...(m.agentMeta.autoResumeOutcome ? { outcome: m.agentMeta.autoResumeOutcome } : {}),
          },
        };
      }
      const parsed = parseUserContent(m.content);
      // scheduler 注入的消息带 agentMeta.origin(历史加载与 messages:created
      // 直推两条路径都经过这里),透传给 UserMessage 渲染来源标签。
      const origin = m.agentMeta?.origin;
      const delivery = m.agentMeta?.delivery;
      const goalObjective = m.agentMeta?.goalObjective;
      const hookSource = m.agentMeta?.hookSource;
      return {
        clientId: m.clientId,
        role: m.role,
        content: parsed.text,
        isStreaming: false,
        ...(parsed.images.length > 0 && { images: parsed.images }),
        ...(parsed.files.length > 0 && { files: parsed.files }),
        ...(parsed.quotesEncoded === true && { quotesEncoded: true }),
        ...(parsed.agentReferences?.length && {
          agentReferences: parsed.agentReferences,
        }),
        ...(parsed.pastedTextRanges?.length && {
          pastedTextRanges: parsed.pastedTextRanges,
        }),
        ...(parsed.slashCommandRanges !== undefined && {
          slashCommandRanges: parsed.slashCommandRanges,
        }),
        ...(parsed.sessionReferences && parsed.sessionReferences.length > 0
          ? { sessionReferences: parsed.sessionReferences }
          : {}),
        ...(origin?.kind === 'scheduler' && { automationOrigin: origin }),
        ...(delivery === 'turn' || delivery === 'steer' ? { delivery } : {}),
        ...(goalObjective ? { goalBadge: goalObjective } : {}),
        ...(hookSource ? { hookSource } : {}),
        // 子代理内部的 user 行(SDK parent_tool_use_id):投影给计划归属判定,
        // 否则 maker-shared 会把它当成"用户开新话题"切断主线程计划 session。
        // 只提升 SDK tool-parent 形态:legacy Claude 导入把 transcript 链边
        // (preceding-user-uuid 这类非 RFC 串)也存在 parentUuid 上,无条件提升会
        // 反过来把**普通 user 行**当成子代理内部消息,新计划继续复用旧 session/key、
        // 跨话题合并计划卡(review P1)。
        ...(typeof m.agentMeta?.parentUuid === 'string' &&
        isSubagentParentToolUseId(m.agentMeta.parentUuid)
          ? { parentToolUseId: m.agentMeta.parentUuid }
          : {}),
      };
    }
    // /goal 达成记录:持久消息(role:'assistant' + 空 content + agentMeta.goalCompletion)
    // → 派生成一张 'goal-complete' system card(走 SystemCard 渲染管线,与 compact/fork
    // divider 同源:从持久数据每次重新派生,重开会话仍在)。复用 systemCardType 通道,
    // 工作组分组守卫已天然排除 systemCardType 消息,无需改 MessageStream。
    if (m.role === 'assistant' && m.agentMeta?.goalCompletion) {
      return {
        clientId: m.clientId,
        role: m.role,
        content: '',
        isStreaming: false,
        systemCardType: 'goal-complete' as const,
        systemCardData: { ...m.agentMeta.goalCompletion },
      };
    }
    // /goal 提示记录(usageLimited 到点自动续跑)→ 'goal-resumed' system card,同上派生。
    if (m.role === 'assistant' && m.agentMeta?.goalNotice) {
      return {
        clientId: m.clientId,
        role: m.role,
        content: '',
        isStreaming: false,
        systemCardType: 'goal-resumed' as const,
        systemCardData: { kind: m.agentMeta.goalNotice },
      };
    }
    const reviewRun = m.role === 'assistant' ? readReviewRunMeta(m.agentMeta?.reviewRun) : null;
    if (reviewRun) {
      return {
        clientId: m.clientId,
        role: m.role,
        content: '',
        isStreaming: false,
        systemCardType: 'review' as const,
        systemCardData: {
          ...reviewRun,
          result: typeof m.content === 'string' ? m.content : '',
        },
      };
    }
    const agentMeta = m.agentMeta;
    const turnUsageDetails =
      m.role === 'assistant' ? normalizeTurnUsageDetails(agentMeta?.turnUsageDetails) : undefined;
    const normalizedTurnMoney =
      m.role === 'assistant' ? normalizeRegionalMoney(agentMeta?.turnCost) : undefined;
    const legacyTurnCostUsd =
      m.role === 'assistant' &&
      typeof agentMeta?.turnCostUsd === 'number' &&
      agentMeta.turnCostUsd > 0
        ? resolveEstimatedTurnCostUsd(
            agentMeta.turnCostUsd,
            agentMeta.turnCostIsEstimate === true,
            turnUsageDetails,
            agentMeta.model,
          )
        : undefined;
    const persistedTurnMoney =
      m.role === 'assistant'
        ? (normalizedTurnMoney ??
          (legacyTurnCostUsd !== undefined ? legacyUsdMoney(legacyTurnCostUsd) : undefined))
        : undefined;
    // 用户轮累计与当前 segment 费用各自独立读(不变量正本见 shared/turnCostPayload.ts):
    // 收尾 segment 缺报价的轮次只落了 userTurnCost + turnUsageDetails,若把它嵌在
    // persistedTurnMoney > 0 的分支里,重开会话后整轮已花的钱会被 token 顶掉。
    const persistedUserTurnMoney =
      m.role === 'assistant' && agentMeta
        ? (normalizeRegionalMoney(agentMeta.userTurnCost) ??
          (typeof agentMeta.userTurnCostUsd === 'number' && agentMeta.userTurnCostUsd > 0
            ? legacyUsdMoney(agentMeta.userTurnCostUsd)
            : undefined))
        : undefined;
    const persistedUserTurnCostPatch =
      agentMeta && persistedUserTurnMoney
        ? {
            userTurnMoney: persistedUserTurnMoney,
            ...(typeof agentMeta.userTurnCostUsd === 'number' && agentMeta.userTurnCostUsd > 0
              ? { userTurnCostUsd: agentMeta.userTurnCostUsd }
              : {}),
            userTurnCostIsEstimate: agentMeta.userTurnCostIsEstimate === true,
          }
        : {};
    // 新数据的显式 turn seal 权威高于旧历史兜底：失败/中断轮也可能带 usage 或费用，
    // `false` 不能因此被重新推成成功。只有 seal 缺失的存量行才用收尾费用/明细补 true。
    const persistedTurnCompleted =
      m.role !== 'assistant'
        ? undefined
        : typeof agentMeta?.turnCompleted === 'boolean'
          ? agentMeta.turnCompleted
          : (persistedTurnMoney?.amount ?? 0) > 0 || turnUsageDetails !== undefined
            ? true
            : undefined;
    return {
      clientId: m.clientId,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      // tool_result 消息也带 toolUseId(DB 列),让 MessageStream 能按 id 配对
      ...(m.role === 'tool_result' && typeof m.toolUseId === 'string' && m.toolUseId.length > 0
        ? { toolUseId: m.toolUseId }
        : {}),
      // SDK done turn seal；存量会话 seal 缺失时才用 turn 费用/明细补成功边界。
      ...(persistedTurnCompleted !== undefined ? { turnCompleted: persistedTurnCompleted } : {}),
      // 本轮 token 明细独立于金额挂载:Pi/新模型算不出报价的轮次只有它，
      // UI 据此退回显示 token，历史加载不能把它绑在 money 分支。
      ...(m.role === 'assistant' && turnUsageDetails ? { turnUsageDetails } : {}),
      // 整轮累计费用同样独立挂载:无价收尾轮只有它,没有 turnCost。
      ...persistedUserTurnCostPatch,
      // assistant 上挂的 per-turn 费用(main turn 结束时 patch 进 agent_meta)
      ...(m.role === 'assistant' && agentMeta && persistedTurnMoney && persistedTurnMoney.amount > 0
        ? (() => {
            const turnCostUsd =
              persistedTurnMoney.currency === 'USD' ? persistedTurnMoney.amount : undefined;
            return {
              turnMoney: persistedTurnMoney,
              ...(turnCostUsd !== undefined ? { turnCostUsd } : {}),
              turnCostIsEstimate: agentMeta.turnCostIsEstimate === true,
            };
          })()
        : {}),
      // assistant 上挂的模型降级标记(main turn 结束检测命中时 patch 进 agent_meta)
      ...(m.role === 'assistant' &&
      typeof m.agentMeta?.modelMismatch?.selected === 'string' &&
      m.agentMeta.modelMismatch.selected &&
      typeof m.agentMeta.modelMismatch.actual === 'string' &&
      m.agentMeta.modelMismatch.actual
        ? { modelMismatch: m.agentMeta.modelMismatch }
        : {}),
      // subagent-model-chip: 历史重载时,纯文本子代理(全程不调工具)的子消息是
      // assistant/thinking 而非 tool_use,模型只在它们的 agentMeta 上。这里和
      // tool_use 分支同款投影 model / parentUuid,让 buildSubagentModelMap 也能从
      // 这类消息反查出子代理模型(实时态由 update.model 兜底,本处补"重载"缺口)。
      // 主线程 assistant 只有 model 无 parentUuid → 不会进 map,无副作用。
      ...(typeof m.agentMeta?.model === 'string' && m.agentMeta.model
        ? { model: m.agentMeta.model }
        : {}),
      ...(typeof m.agentMeta?.parentUuid === 'string' &&
      isSubagentParentToolUseId(m.agentMeta.parentUuid)
        ? { parentToolUseId: m.agentMeta.parentUuid }
        : {}),
      isStreaming: false,
    };
  });
  return mapped.map((cm): ChatMessage => {
    const ts = createdAtById.get(cm.clientId);
    const iso = mapServerCreatedAt(cm, ts);
    const rowid = rowidById.get(cm.clientId);
    const remoteContentTruncated = remoteContentTruncatedById.get(cm.clientId) === true;
    const remoteRowsTrimmed = remoteRowsTrimmedById.get(cm.clientId) === true;
    const legacyUserTurnCost = legacyUserTurnCosts.get(cm.clientId);
    if (
      !iso &&
      rowid === undefined &&
      !remoteContentTruncated &&
      !remoteRowsTrimmed &&
      !legacyUserTurnCost
    ) {
      return cm;
    }
    return {
      ...cm,
      ...(legacyUserTurnCost ?? {}),
      ...(iso ? { createdAt: iso } : {}),
      ...(rowid !== undefined ? { rowid } : {}),
      ...(remoteContentTruncated ? { remoteContentTruncated: true } : {}),
      ...(remoteRowsTrimmed ? { remoteRowsTrimmed: true } : {}),
    };
  });
}

/**
 * Device-link can load history from a peer that predates persisted
 * userTurnCost. Rebuild only those missing display totals from the ordered
 * rows returned by that peer; raw per-segment values remain untouched.
 */
function projectLegacyUserTurnCosts(
  serverMsgs: Message[],
): Map<string, Pick<ChatMessage, 'userTurnMoney' | 'userTurnCostUsd' | 'userTurnCostIsEstimate'>> {
  const projected = new Map<
    string,
    Pick<ChatMessage, 'userTurnMoney' | 'userTurnCostUsd' | 'userTurnCostIsEstimate'>
  >();
  let hasRealUserBoundary = false;
  let costUsd = 0;
  let hasEstimatedValue = false;
  for (const message of serverMsgs) {
    if (message.role === 'user' && message.agentMeta?.autoResume !== true) {
      hasRealUserBoundary = true;
      costUsd = 0;
      hasEstimatedValue = false;
      continue;
    }
    if (message.role !== 'assistant' || !hasRealUserBoundary) continue;
    const meta = message.agentMeta;
    if (
      typeof meta?.turnCostUsd !== 'number' ||
      !Number.isFinite(meta.turnCostUsd) ||
      meta.turnCostUsd <= 0
    ) {
      continue;
    }
    costUsd += meta.turnCostUsd;
    hasEstimatedValue ||= meta.turnCostIsEstimate === true;
    if (
      !normalizeRegionalMoney(meta.userTurnCost) &&
      (typeof meta.userTurnCostUsd !== 'number' || !(meta.userTurnCostUsd > 0))
    ) {
      projected.set(message.clientId, {
        userTurnMoney: legacyUsdMoney(costUsd),
        userTurnCostUsd: costUsd,
        userTurnCostIsEstimate: hasEstimatedValue,
      });
    }
  }
  return projected;
}

function formatToolUseSummary(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown> | null;
  if (!inp) return `${toolName}()`;

  const keyParamMap: Record<string, string[]> = {
    Read: ['file_path', 'path'],
    Edit: ['file_path'],
    Write: ['file_path'],
    Bash: ['command'],
    Glob: ['pattern'],
    Grep: ['pattern'],
  };

  const paramKeys = keyParamMap[toolName];
  if (paramKeys) {
    for (const key of paramKeys) {
      if (inp[key]) {
        const val = String(inp[key]);
        const display = val.length > 60 ? `${val.slice(0, 57)}...` : val;
        return `${toolName}(${display})`;
      }
    }
  }

  return `${toolName}()`;
}

// `notify` kept here for potential future external dispatchers.
void notify;

// ---------------------------------------------------------------------------
// HMR teardown — ensure old listeners are disposed before the module reloads
// ---------------------------------------------------------------------------
// 双保险:
// 1. accept(noop) 让 vite 把本模块当成 HMR 边界, 不冒泡触发上层 full reload 之外
//    的未控路径; dispose 钩子在新模块加载前一定跑。
// 2. dispose 里先调 preload 的 __resetMakerFanOuts() 强制清零 maker.* 4 个 fanOut
//    的 listeners Set —— bindIpc(line 1318-1335) 拿到的 unsubscribe 是跨 contextBridge
//    proxy, 不保证可调; 旧模块的 unsub 调不到 → 旧 callback 残留在 fanOut Set →
//    新模块注册新 callback 后同 IPC event 被分发两次, 在两份独立 sessions Map 上
//    各跑一次 reducer, 用 randomUUID 的 case (tool_use/tool_result/text:isFinal)
//    全部落库 2 条。reset 不依赖 unsub 是否能跨 context 调用。
// 3. 然后再调 __teardownGlobalListeners 把本模块的 ipcUnsubscribers 抽空, 兜底
//    未来本模块若接非 maker.* 的 fanOut(reset 不覆盖) 也能正常清理。
if (import.meta.hot) {
  import.meta.hot.accept(() => {});
  import.meta.hot.dispose(() => {
    try {
      window.electronAPI?.maker?.__resetMakerFanOuts?.();
    } catch {
      /* preload 未暴露(老版本) / window 被销毁 — swallow, 退回 unsub 路径 */
    }
    __teardownGlobalListeners();
  });
}
