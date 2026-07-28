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
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { applyCodexPlanSnapshotOnDone } from '@cindy/maker-shared/message-render';
import type { MessageRole, Message, MessageAutomationOrigin } from '@/lib/ccAgent.types';
import type { AttachedFile, MentionedResource, SerializedAttachedFile } from '@/lib/fileTypes';
import type {
  AgentInputCreateOpts,
  AgentInputProjection,
  AgentInputQueuedMessage,
  AgentInputSessionRef,
  AgentInputReference,
} from '../../shared/agentInputQueue';
import {
  deriveAutoTitleSeed,
  getAgentFacingText,
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
  dismissErrorMessageFor,
  isRemoteSession,
} from '@/lib/makerTransport';
import {
  remoteProjectsStore,
  requestRemoteReseed,
} from '@/features/device-link/remoteProjectsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
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
import { emitPatch } from '@/lib/sessionsBus';
import { createLogger } from '@/lib/logger';
import { getUserPrompt } from '@/lib/userPromptStore';
import { getMakerMemoryEnabled } from '@/lib/memorySettingsStore';
import { buildUserMessageAttachmentPayload } from '@/lib/messageAttachmentPayload';
import {
  parseIssueEnvRegion,
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
  if (bracketCode && DEVICE_LINK_CHAT_ERROR_CODES.has(bracketCode)) {
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
import { saveDraft as saveComposerDraft, plainTextToTiptapDoc } from '@/lib/composerDraftStore';
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
   * 产生这条消息的模型 raw id(读自 agentMeta.model)。对 subagent 子消息而言
   * 即子代理实际跑的模型(如 'claude-haiku-4-5-20251001')。仅 SDK 带 model 的
   * 消息有值。用于在 Agent/Task 工具行上反查并渲染子代理模型 chip。
   */
  model?: string;
  /**
   * Host 在 SDK `done` 边界写入的持久化 turn seal。一个真实用户请求可能因后台任务
   * 完成而自动续跑多个 SDK turn；每个 seal 都代表一条应保留在「已工作」外的正式回复。
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
    | 'auto-resume'
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
}

export type AgentTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface AgentTaskUpdate {
  provider: 'claude-code' | 'codex';
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
  model?: string;
  reasoningEffort?: string;
  receiverThreadIds?: string[];
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
  draft: { title: string; body: string; type: 'bug' | 'feature' };
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
  /** main 已经选定、确认后不会自动切换的实际 GitHub 作者身份。 */
  submissionIdentity: IssueSubmissionIdentity;
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
}

export type MessageDeliveryMode = 'queue' | 'steer';

/** 仅影响 selector/chip 的乐观展示；agentKind 始终保留真实 reducer 路由。 */
export interface AgentSwitchIntentRecord {
  target: 'claude-code' | 'codex';
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean;
}

export interface SessionChatState {
  /**
   * 该 session 用哪个 agent (Claude / Codex)。 sendMessage 据此走 maker.send 时
   * 透传 agentKind, maker:event 收到事件时按 agentKind 决定走 Claude reducer 还是
   * Codex reducer。ensureInitialMessages 从 DB sessions.agent_kind 读出来灌进。
   * 默认 'claude-code' 兼容老路径(老 session row 没有此字段时按 Claude 处理)。
   */
  agentKind: 'claude-code' | 'codex';
  /** 下一条消息发送时才由 main 应用的跨引擎切换意图。 */
  agentSwitchIntent: AgentSwitchIntentRecord | null;
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
  /**
   * 当前 terminal error 的稳定 reason key(maker-core/main 下发,如
   * 'silent-stop-exhausted')。ErrorBanner 据此渲染专用 action(「继续」按钮);
   * 仅在 error 非空时有意义,error 被清/被无 reason 的错误覆盖时同步清。
   */
  errorReason?: string | null;
  recoverableError: string | null;
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
  isLoadingMore: boolean;
  hasMoreMessages: boolean;
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
  | 'errorReason'
  | 'recoverableError'
  | 'errorRetryText'
  | 'credentialSwitchWait'
  | 'continuationInFlightClientId'
  | 'isLoadingMore'
  | 'hasMoreMessages'
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
    errorReason: null,
    recoverableError: null,
    activeTurnRetryText: null,
    errorRetryText: null,
    credentialSwitchWait: null,
    continuationInFlightClientId: null,
    isLoadingMore: false,
    hasMoreMessages: true,
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
  errorReason: null,
  recoverableError: null,
  activeTurnRetryText: null,
  errorRetryText: null,
  credentialSwitchWait: null,
  continuationInFlightClientId: null,
  isLoadingMore: false,
  hasMoreMessages: false,
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
 * F-SB-7: Global listeners — notified whenever ANY session's state changes.
 * Used by Sidebar to track running status across all sessions without needing
 * to subscribe to each session individually.
 */
const globalListeners = new Set<() => void>();

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

function noteRendererClearBoundary(sessionId: string, clearedAt: string): void {
  const parsed = new Date(clearedAt).getTime();
  if (!Number.isFinite(parsed)) return;
  const current = rendererClearBoundaryBySession.get(sessionId);
  if (current === undefined || parsed > current) {
    rendererClearBoundaryBySession.set(sessionId, parsed);
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
  // 代际递增(bump 而非 delete,原因见 _messagesEpoch 注释):作废 in-flight 翻页,
  // 避免其提交把旧窗口 merge 进 purge 后重建的空 slice。
  bumpMessagesEpoch(sessionId);
  sessions.delete(sessionId);
  // 状态快照同步失效:该会话若有 running / pending / 待投递 transition 条目,
  // 不能在缓存里残留(purge 不走 setState,需单独置位)。
  _stopTransitions.delete(sessionId);
  markStatusSnapshotDirty();
  listeners.delete(sessionId);
  lightSnapshotCache.delete(sessionId);
  titleUpdateCallbacks.delete(sessionId);
  _historyFetchInFlight.delete(sessionId);
  _historyLoadOrigin.delete(sessionId);
  _lastViewedAt.delete(sessionId);
  _lastInboundEventAt.delete(sessionId);
  rendererClearBoundaryBySession.delete(sessionId);
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

  setState(sessionId, (s) => {
    if (s.messages.length <= TRIM_THRESHOLD) return s;
    return {
      ...s,
      messages: s.messages.slice(-TRIM_TARGET),
      hasMoreMessages: true,
      oldestMessageId: null,
    };
  });
}

// ---------------------------------------------------------------------------
// MEM-OPT-2: Soft eviction — demote idle sessions by clearing their messages
// after DEMOTE_IDLE_MS. Re-entering a demoted session triggers
// ensureInitialMessages to reload from DB.
// ---------------------------------------------------------------------------

const DEMOTE_IDLE_MS = 60_000;
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
      ...(s.error ? { error: null, errorRetryText: null } : {}),
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
    setState(sessionId, (s) => ({
      ...s,
      messages: [],
      taskUpdates: new Map(),
      historyLoaded: false,
      oldestMessageId: null,
      hasMoreMessages: true,
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

function setState(sessionId: string, updater: (prev: SessionChatState) => SessionChatState): void {
  const prev = getOrCreateState(sessionId);
  const next = updater(prev);
  if (next === prev) return;
  sessions.set(sessionId, next);
  // running-status 快照缓存失效(getRunningSnapshot 纯 getter 契约:只有
  // mutation 才允许让下一次读重算)。必须在 notify 之前置位。
  markStatusSnapshotDirty();
  listeners.get(sessionId)?.forEach((cb) => {
    cb();
  });
  // F-SB-7: notify global listeners so Sidebar can track all sessions
  globalListeners.forEach((cb) => {
    cb();
  });
}

function notify(sessionId: string): void {
  listeners.get(sessionId)?.forEach((cb) => {
    cb();
  });
}

function applyInputProjection(projection: AgentInputProjection): void {
  if (!projection.sessionId) return;
  setState(projection.sessionId, (s) => {
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
    const queuedIds = new Set(projection.pendingQueue.map((q) => q.clientId));
    const messages =
      queuedIds.size > 0 && s.messages.some((m) => m.isPendingPersist && queuedIds.has(m.clientId))
        ? s.messages.filter((m) => !(m.isPendingPersist && queuedIds.has(m.clientId)))
        : s.messages;
    return {
      ...s,
      messages,
      pendingQueue: projection.pendingQueue as QueuedMessage[],
      steeringQueueClientIds: projection.steeringQueueClientIds,
      queuePaused: projection.queuePaused,
      queueExpanded: projection.queueExpanded,
      queueInteractionLocks: projection.queueInteractionLocks,
      queueEditLocks: projection.queueEditLocks,
      queueAbortPending: projection.queueAbortPending,
      error: projection.error,
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
      ...(authRetryProjectionError ? { _authRetryPersistOnProjectionError: undefined } : {}),
    };
  });
}

function markSessionHasUserMessage(sessionId: string): void {
  setState(sessionId, (s) => {
    if (!s.isFirstMessage) return s;
    return { ...s, isFirstMessage: false };
  });
}

function requestInputProjection(sessionId: string): void {
  if (!sessionId) return;
  makerApiFor(sessionId)
    .input.getProjection(sessionId)
    .then(applyInputProjection)
    .catch((err) => log.warn('get input projection failed:', err));
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
    Array.isArray((persisted.toolInput as { plan?: unknown }).plan)
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
  source?: 'claude-code' | 'codex',
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
    raw.provider === 'codex' || raw.provider === 'claude-code'
      ? raw.provider
      : source === 'codex'
        ? 'codex'
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
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
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
    createdAt: prev.createdAt ?? next.createdAt,
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

// F1-a: 所有 agent 消息(assistant/tool_use/tool_result/thinking/ask_user/plan_review)
// 的落库已收口 main(messagePersistBroadcaster),handleStreamEvent 退化为纯 UI reducer、
// 不再写库 → 不再需要 sessionId 形参(已从签名移除,各调用点同步去掉第三个实参)。
export function handleStreamEvent(
  inputState: SessionChatState,
  event: CCAgentStreamEvent,
): SessionChatState {
  const state =
    event.type === 'error' || inputState.recoverableError == null
      ? inputState
      : { ...inputState, recoverableError: null };
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
      const { text, isFinal } = event.data as { text: string; isFinal: boolean };

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
        // 流式中的 isFinal 不重复落库，但仍要刷新 lastAgentMeta（done 时抢救用）。
        // subagent-model-chip: 流式起点的 delta 事件不带 agentMeta(见 CCAgentStreamEvent
        // 注释:delta 类无此字段),只有这条来自 SDK assistant message 的 isFinal 带 ——
        // 把 model/parentToolUseId 补写到在途流式 assistant 消息上,否则纯文本(零工具)
        // 子代理在流式渲染期间 buildSubagentModelMap 始终为空、chip 缺失(仅重载后才补上)。
        const hasAssistantFields =
          assistantMetaFields.model !== undefined ||
          assistantMetaFields.parentToolUseId !== undefined ||
          assistantMetaFields.turnCompleted === true;
        if (!incomingMeta && !hasAssistantFields) return state;
        return {
          ...state,
          ...(incomingMeta ? { lastAgentMeta: incomingMeta } : {}),
          ...(hasAssistantFields && state.streamingClientId
            ? {
                messages: replaceMessage(
                  state.messages,
                  (m) => m.clientId === state.streamingClientId,
                  (m) => ({ ...m, ...assistantMetaFields }),
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

      // stage === 'redacted' —— 加密推理不进渲染列表。
      //
      // 这类块没有任何明文可读,卡片只能显示"无法显示的思考过程";上游(如 Grok 开了
      // 服务端搜索)一轮能产出十几条,会把真实产出淹掉。落库仍由 main(onThinkingEvent)
      // 照旧收口、encrypted_content 也不受影响(回放走 agent 侧 transcript,不依赖这里),
      // 这里只是不展示。恢复展示 = 删掉这个提前 return,并同步 mapServerMessages 的同名过滤。
      //
      // 不展示 ≠ 丢事件:仍按本函数开头的不变量刷新 lastAgentMeta(带 agentMeta 的事件都要刷,
      // mid-turn 抢救 assistant 累积流时拿它当 fallback)。否则这条事件携带的 model /
      // parentUuid 会被静默吞掉。
      return incomingMeta ? { ...state, lastAgentMeta: incomingMeta } : state;
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

      const existingUpdatePlanIdx =
        toolName === 'update_plan'
          ? finalized.messages.findIndex(
              (m) =>
                m.role === 'tool_use' && m.toolName === 'update_plan' && m.toolUseId === toolUseId,
            )
          : -1;
      if (existingUpdatePlanIdx >= 0) {
        const messages = finalized.messages.slice();
        messages[existingUpdatePlanIdx] = {
          ...messages[existingUpdatePlanIdx],
          content: formatToolUseSummary(toolName, input),
          toolInput: input,
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

      const terminalData =
        event.data as { plan?: unknown; raw?: { id?: unknown; status?: unknown } } | null | undefined;
      const terminalTurnId = typeof terminalData?.raw?.id === 'string' ? terminalData.raw.id : null;
      const terminalTurnStatus =
        typeof terminalData?.raw?.status === 'string' ? terminalData.raw.status : null;
      const doneMessages = event.source === 'codex'
        ? applyCodexPlanSnapshotOnDone(
            cleanedMessages,
            terminalData?.plan,
            terminalTurnId,
            terminalTurnStatus,
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
        return {
          ...state,
          error: null,
          errorReason: null,
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
      return {
        ...finalized,
        error: isPlannedUpgradeClose ? null : errMsg,
        errorReason: isPlannedUpgradeClose ? null : (reason ?? null),
        recoverableError: null,
        errorRetryText: derivedRetryText ?? preservedRetryText,
        isStreaming: false,
        activeTurnRetryText: null,
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
    !state.pendingTaskWake &&
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
  const cleared = finalized.messages
    .map((m) => {
      let next = m;
      if (m.isStreaming) next = { ...next, isStreaming: false };
      if (m.role === 'ask_user' && m.askUserStatus === 'pending') {
        next = { ...next, askUserStatus: 'expired' as const };
      }
      if (m.role === 'plan_review' && m.planReviewStatus === 'pending') {
        next = { ...next, planReviewStatus: 'expired' as const };
      }
      return next;
    })
    .filter((m) => !steeringIds.has(m.clientId));
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
    // 新 turn 真正启动(isRunning false→true)时清掉上一轮残留的终态 error:
    // coordinator 路径的 send 经 projection error:null 清横幅,但 direct send
    // (scheduler / send-to-session / goal 等不走 coordinator 的路径)不发
    // projection —— 残留 error 会让 useSessionRunningStatus 在本轮
    // running→stopped 时经 hasSessionTerminalError fallback 读到旧值,把成功
    // 的后台 turn 误报成「执行失败」通知(bot review P2)。skipTurnReset 的
    // side-channel running 信号已在上方早退,不会误清。
    error: isTurnStart ? null : state.error,
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
    source?: 'claude-code' | 'codex';
    agentMeta?: Record<string, unknown>;
  };
  persistId?: string;
  resolvedContent?: string;
} | null;

type PendingTextDeltaBatch = {
  text: string;
  source?: 'claude-code' | 'codex';
  persistId?: string;
  agentMeta?: Record<string, unknown>;
};

const pendingTextDeltaBatches = new Map<string, PendingTextDeltaBatch>();
let textDeltaFlushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Defensive wrapper: contextBridge proxies may not preserve the return type.
 * Ensures we always get a callable unsubscribe function and pushes it onto
 * the teardown list.
 */
function bindIpc(
  subscribe: (cb: (data: unknown) => void) => unknown,
  handler: (data: unknown) => void,
  label: string,
): void {
  const result = subscribe(handler);
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

function dispatchStreamEventPayload(
  sessionId: string,
  event: NonNullable<MakerEventPayload>['event'],
  persistId?: string,
  resolvedContent?: string,
): void {
  if (!event) return;
  setState(sessionId, (s) =>
    handleStreamEvent(s, {
      sessionId,
      type: event.type,
      data: event.data,
      source: event.source,
      agentMeta: event.agentMeta as import('./ccAgent.types').CcMeta | undefined,
      persistId,
      resolvedContent,
    } as CCAgentStreamEvent),
  );
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

function flushPendingTextDelta(sessionId: string): void {
  const pending = pendingTextDeltaBatches.get(sessionId);
  if (!pending) return;
  pendingTextDeltaBatches.delete(sessionId);
  if (pendingTextDeltaBatches.size === 0) clearTextDeltaFlushTimer();

  dispatchStreamEventPayload(
    sessionId,
    {
      type: 'text',
      source: pending.source,
      data: { text: pending.text, isFinal: false },
      ...(pending.agentMeta ? { agentMeta: pending.agentMeta } : {}),
    },
    pending.persistId,
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
): void {
  if (!event) return;
  const data = event.data as { text?: unknown };
  const text = typeof data.text === 'string' ? data.text : '';
  const existing = pendingTextDeltaBatches.get(sessionId);
  if (existing) {
    existing.text += text;
    if (!existing.persistId && persistId) existing.persistId = persistId;
    if (event.source) existing.source = event.source;
    if (event.agentMeta) existing.agentMeta = event.agentMeta;
  } else {
    pendingTextDeltaBatches.set(sessionId, {
      text,
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

function initGlobalListeners(): void {
  if (globalListenersInitialized) return; // idempotent for StrictMode / HMR
  globalListenersInitialized = true;

  // ── Maker 主事件流: 一根管子接所有 vendor → maker AgentEvent ──
  // 老链路是 8 个独立 IPC channel; 新链路一个 maker:event 通道,按 event.type 分发。
  // 数据 shape 由 maker-core/agents/claude-code/translator.ts 翻译, 形状对齐老 cc-agent 协议,
  // handleStreamEvent / handleStatusUpdate 不需改动。
  // device-link:同一个 handler 既接本机 maker:event,也接被控端经 onRemotePush
  // 转发回来的远程 maker:event(按 sessionId 命中同一 reducer,与来源无关)。
  const handleMakerEventRaw = (raw: unknown) => {
    const payload = raw as MakerEventPayload;
    if (!payload?.sessionId || !payload.event) return;
    const { sessionId, event } = payload;
    const persistId = payload.persistId;
    const resolvedContent = payload.resolvedContent;

    if (isTextDeltaEvent(event)) {
      enqueueTextDeltaPayload(sessionId, event, persistId);
      return;
    }
    flushPendingTextDelta(sessionId);

    // session_id: 老链路是单独 IPC channel, 新链路融进 maker:event (Claude / Codex 同源)
    if (event.type === 'session_id') {
      const sdkSessionId = typeof event.data === 'string' ? event.data : undefined;
      if (!sdkSessionId) return;
      const current = getOrCreateState(sessionId);
      if (current.sdkSessionId === sdkSessionId) return;
      setState(sessionId, (s) => ({ ...s, sdkSessionId }));
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
      } as CCAgentStatusUpdate;
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
              // 本地 only:网关 key 不再有服务器副本可拉。改为校验本机 safeStorage 是否
              // 有 key —— 有则关闭并重发会话(重连时把本机 key 重新下发给 remote host);
              // 没有则中止重试,让 error banner 浮现,提示用户在本机重填 key。
              const localKey = await window.electronAPI.safeStorageRead(
                providerSecretStorageKey('xd'),
              );
              if (!localKey) {
                throw new Error('no local api key available');
              }
              // preserveWorkspace: 鉴权重连是瞬态 close+resend,会话继续,工作区必须保留。
              await makerApiFor(sessionId).closeSession(sessionId, { preserveWorkspace: true });
              await new Promise((r) => setTimeout(r, 1500));
              if (hasRetryPayload) {
                const row = await sessionService.get(sessionId);
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
              // 重试失败——main 侧已跳过持久化（isRemoteAuthRetry），在此补落。
              // device-link 控制端经 makerApiFor 路由到被控端 main（不直调本地 IPC）;
              // 同时透传 agentMeta 供 flushAssistantBlock 边界 meta 兜底与 dedup key。
              void makerApiFor(sessionId).input.persistTurnErrorDeferred(
                sessionId,
                event.data as Record<string, unknown> | null,
                event.agentMeta ?? null,
              );
              setState(sessionId, (s) =>
                handleStreamEvent(s, {
                  sessionId,
                  type: 'error',
                  data: event.data,
                } as CCAgentStreamEvent),
              );
            } finally {
              setState(sessionId, (s) => ({ ...s, _authRetryInFlight: false }));
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

    dispatchStreamEventPayload(sessionId, event, persistId, resolvedContent);

    // done / error 副作用 (从老 stream listener 搬过来)
    if (event.type === 'done') {
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
  bindIpc(window.electronAPI.maker.onEvent, handleMakerEventRaw, 'maker-event');

  // ── Maker session status: 兜底护栏, 防 "Generating..." 永久卡死 ────────────
  // main 端 session.close() 跑完会 broadcast status_changed: closed; renderer
  // 之前只把它当实验页用的状态展示, **主聊天 store 没有任何 listener**。结果是
  // 一旦 close 跟 turn end 的 done 事件 race(done 没在 close 之前送达 renderer),
  // agentStatus.isRunning 就永远停在 true, UI "Generating..." 永久转圈。
  //
  // 触发 close 的路径很多(rehydrate / disableOrca / shutdown / 隐藏的 IPC 调用),
  // 真正的"凶手"还在用 [DEBUG-TEMP] 日志追。这条护栏不依赖修好 close 路径,
  // 只要 main 端把 closed 状态广播出来, 就保证 UI 一定能解锁。
  const handleMakerStatusRaw = (raw: unknown) => {
    const payload = raw as { sessionId?: string; status?: string } | null;
    if (!payload?.sessionId || payload.status !== 'closed') return;
    flushPendingTextDelta(payload.sessionId);
    setState(payload.sessionId, forceFinalizeOnSessionClosed);
  };
  bindIpc(window.electronAPI.maker.onStatusChanged, handleMakerStatusRaw, 'maker-status-changed');

  const handleInputProjectionRaw = (raw: unknown) => {
    const projection = raw as AgentInputProjection | null;
    if (!projection?.sessionId) return;
    applyInputProjection(projection);
  };
  bindIpc(
    window.electronAPI.maker.onInputProjection,
    handleInputProjectionRaw,
    'maker-input-projection',
  );

  // ── Maker interaction request: permission/ask/plan 三合一,按 kind 分发 ──
  const handleInteractionRequestRaw = (raw: unknown) => {
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
        | (Omit<PendingIssueConfirm['env'], 'region'> & { region?: unknown })
        | undefined;
      const submissionIdentity = parseIssueSubmissionIdentity(request.submissionIdentity);
      if (!draft || !rawEnv || !submissionIdentity) return;
      // region 过一遍白名单:非法值宁可不展示区域,也不能把 CN 版说成默认版。
      const env = { ...rawEnv, region: parseIssueEnvRegion(rawEnv.region) };
      setState(sessionId, (s) => ({
        ...s,
        pendingIssueConfirm: {
          requestId: request.requestId,
          draft,
          env,
          submissionIdentity,
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
  bindIpc(
    window.electronAPI.maker.onInteractionRequest,
    handleInteractionRequestRaw,
    'maker-interaction-request',
  );
  // 模块级桥接:供 reconcilePendingInteractions(打开/重连会话时的快照重建)复用同一套
  // 按 kind 分发逻辑。handler 只依赖模块级 setState/handleStreamEvent,无闭包局部状态,引用安全。
  applyInteractionRequestRef = handleInteractionRequestRaw;

  // ── Maker interaction dismissed: setPermissionMode 切换 / close 时关掉对话框 ──
  const handleInteractionDismissedRaw = (raw: unknown) => {
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
  bindIpc(
    window.electronAPI.maker.onInteractionDismissed,
    handleInteractionDismissedRaw,
    'maker-interaction-dismissed',
  );

  // Main 端写库的消息推送(接管路径 persistUserMessage / persistAssistantMessage),也复用给
  // device-link 远程会话(被控端 messages:created 经 onRemotePush 转发,注入同一套 in-memory state)。
  function handleMessageCreatedRaw(raw: unknown): void {
    const payload = raw as { sessionId?: string; message?: Message } | null;
    if (!payload?.sessionId || !payload.message) return;
    const { sessionId, message } = payload;
    if (isBeforeOrAtRendererClearBoundary(sessionId, message.createdAt)) return;
    const [mapped] = mapServerMessages([message]);
    if (!mapped) return;
    setState(sessionId, (s) => {
      const idx = s.messages.findIndex((m) => m.clientId === mapped.clientId);
      if (idx >= 0) {
        const nextMessages = mergeMessages([mapped], s.messages, {
          preserveExistingToolResultContent: true,
          preserveExistingCodexPlanContent: true,
        });
        return {
          ...s,
          messages: nextMessages,
          isFirstMessage: mapped.role === 'user' ? false : s.isFirstMessage,
        };
      }
      return {
        ...s,
        messages: mergeMessages([mapped], s.messages, {
          preserveExistingToolResultContent: true,
          preserveExistingCodexPlanContent: true,
        }),
        isFirstMessage: mapped.role === 'user' ? false : s.isFirstMessage,
      };
    });
    // sidebar 排序时间轴 — 让接管路径下新消息也能 bump session 顺序。
    emitPatch(sessionId, { updatedAt: new Date().toISOString() });
  }

  // 消息本地删除推送:本机多窗口与 device-link 控制端共用同一 reducer。
  // 新 payload 一次带齐整轮 clientIds；旧 host 仍回退到单个 clientId。
  function handleMessageDeletedRaw(raw: unknown): void {
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

  function handleUsageMessageTurnCostRaw(raw: unknown): void {
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
        ? resolveEstimatedTurnCostUsd(
            p.turnCostUsd,
            turnCostIsEstimate,
            turnUsageDetails,
          )
        : undefined;
    const turnMoney =
      normalizedTurnMoney ??
      (legacyTurnCostUsd !== undefined
        ? legacyUsdMoney(legacyTurnCostUsd)
        : undefined);
    if (!turnMoney || !(turnMoney.amount > 0)) return;
    const { sessionId, clientId } = p;
    const userTurnMoney =
      normalizeRegionalMoney(p.userTurnMoney) ??
      (typeof p.userTurnCostUsd === 'number' && p.userTurnCostUsd > 0
        ? legacyUsdMoney(p.userTurnCostUsd)
        : undefined);
    const userTurnCostUsd =
      typeof p.userTurnCostUsd === 'number' && p.userTurnCostUsd > 0
        ? p.userTurnCostUsd
        : undefined;
    const resolvedTurnCostUsd =
      turnMoney.currency === 'USD'
        ? turnMoney.amount
        : undefined;
    setState(sessionId, (s) => {
      const idx = s.messages.findIndex((m) => m.clientId === clientId);
      if (idx < 0) return s;
      const msgs = s.messages.slice();
      msgs[idx] = {
        ...msgs[idx],
        turnMoney,
        ...(resolvedTurnCostUsd !== undefined
          ? { turnCostUsd: resolvedTurnCostUsd }
          : {}),
        turnCostIsEstimate,
        ...(userTurnMoney
          ? {
              userTurnMoney,
              ...(userTurnCostUsd ? { userTurnCostUsd } : {}),
              userTurnCostIsEstimate: p.userTurnCostIsEstimate === true,
            }
          : {}),
        ...(turnUsageDetails ? { turnUsageDetails } : {}),
      };
      return { ...s, messages: msgs };
    });
  }

  // 模型降级标记实时推送(main 的 modelMismatchBroadcaster,与 turn-cost 同款
  // 「落库 agent_meta + 广播」两路;历史加载路径由 buildChatMessages 兜底)。
  function handleUsageMessageModelMismatchRaw(raw: unknown): void {
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
    (cb) => window.electronAPI.deviceLink?.onRemotePush?.(cb),
    (raw) => {
      const push = raw as { deviceId?: string; channel?: string; payload?: unknown } | null;
      if (!push?.channel) return;
      // stall 看门狗信号:只用重会话流刷新 lastInboundEventAt。列表级轻量 activity/patch
      // 可能仍在持续抵达,但 maker:event 重 topic 已经断流;若这里也刷新会掩盖卡死。
      const inboundSid = (push.payload as { sessionId?: string } | null)?.sessionId;
      if (inboundSid && isRemoteHeavyInboundChannel(push.channel)) _markInboundEvent(inboundSid);
      switch (push.channel) {
        case 'maker:event':
          handleMakerEventRaw(push.payload);
          break;
        case 'maker:status-changed':
          handleMakerStatusRaw(push.payload);
          break;
        case 'maker:input:projection':
          handleInputProjectionRaw(push.payload);
          break;
        case 'maker:interaction-request':
          handleInteractionRequestRaw(push.payload);
          break;
        case 'maker:interaction-dismissed':
          handleInteractionDismissedRaw(push.payload);
          break;
        case 'local-db:messages:created':
          // 远程会话的持久化消息(接管路径)→ 注入 in-memory state(同本机)。
          handleMessageCreatedRaw(push.payload);
          break;
        case 'local-db:messages:deleted':
          handleMessageDeletedRaw(push.payload);
          break;
        case 'usage:message-turn-cost':
          handleUsageMessageTurnCostRaw(push.payload);
          break;
        case 'usage:message-model-mismatch':
          handleUsageMessageModelMismatchRaw(push.payload);
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
              ...(typeof p.totalCostUsd === 'number'
                ? { totalCostUsd: p.totalCostUsd }
                : {}),
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
            remoteProjectsStore.applyPatch(push.deviceId, p.sessionId, p.patch);
            // fast 开关读 chat in-memory,分片更新不灌它 → 这里把 fastMode 同步进来(以被控端为准)。
            mirrorSessionFields(p.sessionId, p.patch);
            // 会话在被控端被删除 / 归档 → 同步清掉活动镜像,避免孤儿状态点。
            if (p.patch.status === 'deleted' || p.patch.status === 'archived') {
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
                  ...(s.error ? { error: null, errorRetryText: null } : {}),
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
    const unsub = remoteProjectsStore.subscribe(reconcileOpenSessionOrigins);
    ipcUnsubscribers.push(typeof unsub === 'function' ? unsub : () => {});
  }

  // ── Main 端写库的消息推送 (e.g. feishu /ctr 接管路径下 persistUserMessage /
  //   persistAssistantMessage) ──
  // renderer 自己发出的 user 消息已经乐观 push 过, 落库后这条 broadcast 也会到,
  //   按 clientId dedupe 避免重复显示。
  // 接管路径下 main 端写的 user/assistant 消息 renderer 没乐观 push,
  //   这里直接补进 messages 数组让 UI 立刻看到。
  bindIpc(
    window.electronAPI.localDb.messages.onCreated,
    handleMessageCreatedRaw,
    'local-db-messages-created',
  );
  bindIpc(
    (cb) => window.electronAPI.localDb.messages.onDeleted?.(cb),
    handleMessageDeletedRaw,
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
    (cb) => window.electronAPI.localDb.messages.onErrorPersisted?.(cb),
    (raw: unknown) => {
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
        ...(s.error ? { error: null, errorRetryText: null } : {}),
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
    (cb) => window.electronAPI.onUsageMessageTurnCost?.(cb),
    handleUsageMessageTurnCostRaw,
    'usage-message-turn-cost',
  );
  bindIpc(
    (cb) => window.electronAPI.onUsageMessageModelMismatch?.(cb),
    handleUsageMessageModelMismatchRaw,
    'usage-message-model-mismatch',
  );

  // ── 意识拦截(订阅槽①):用户消息被钩子拦下 ──
  // 有乐观气泡(空闲即发)→ 原地降级为被拦态;没有(会话忙,消息只以队列
  // 灰字存在,drain 到头才被拦)→ 用广播带回的原文补渲一条被拦气泡——
  // 两条路都保证用户看得见"这条被谁拦了",绝不无声蒸发。被拦消息本就没
  // 入库,离开会话即消失(UI 瞬态,预期语义)。
  bindIpc(
    (cb) => window.electronAPI.ghosts?.onUserMessageBlocked?.(cb),
    (raw: unknown) => {
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
    (cb) => window.electronAPI.ghosts?.onUserMessageRewritten?.(cb),
    (raw: unknown) => {
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
    (cb) => window.electronAPI.ghosts?.onAssistantMessageRewritten?.(cb),
    (raw: unknown) => {
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
    (cb) => window.electronAPI.ghosts?.onAssistantMessagePending?.(cb),
    (raw: unknown) => {
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
    (cb) => window.electronAPI.ghosts?.onHookFused?.(cb),
    (raw: unknown) => {
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
    (cb) => window.electronAPI.ghosts?.onNotify?.(cb),
    (raw: unknown) => {
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
    (cb) => window.electronAPI.ghosts?.onPreviewOpen?.(cb),
    (raw: unknown) => {
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
}

/** Primarily for tests — tears down the global listeners. */
function __teardownGlobalListeners(): void {
  for (const unsub of ipcUnsubscribers) unsub();
  ipcUnsubscribers.length = 0;
  globalListenersInitialized = false;
  _stopDemoteTimer();
  clearTextDeltaFlushTimer();
  pendingTextDeltaBatches.clear();
  _pendingErrorClearOnLeave.clear();
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
    errorReason: state.errorReason,
    recoverableError: state.recoverableError,
    errorRetryText: state.errorRetryText,
    credentialSwitchWait: state.credentialSwitchWait,
    continuationInFlightClientId: state.continuationInFlightClientId,
    isLoadingMore: state.isLoadingMore,
    hasMoreMessages: state.hasMoreMessages,
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
    a.errorReason === b.errorReason &&
    a.recoverableError === b.recoverableError &&
    a.errorRetryText === b.errorRetryText &&
    a.credentialSwitchWait === b.credentialSwitchWait &&
    a.continuationInFlightClientId === b.continuationInFlightClientId &&
    a.isLoadingMore === b.isLoadingMore &&
    a.hasMoreMessages === b.hasMoreMessages &&
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
  agentKind: 'claude-code' | 'codex';
  isTurnRunning: boolean;
}

function isActiveSessionSnapshot(value: unknown): value is ActiveSessionSnapshot {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.sessionId === 'string' &&
    (item.agentKind === 'claude-code' || item.agentKind === 'codex') &&
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
function reconcilePendingInteractions(sessionId: string): Promise<number> {
  if (!sessionId) return Promise.resolve(0);
  // best-effort 面板重建:对既有调用方仍是 fire-and-forget。它被 ensureInitialMessages 的
  // listMessagesFor.then 内联调用,若 getPendingInteractions **同步**抛错(如某路由分支
  // API 缺失)而不只是 reject,异常会冒泡到外层 .catch 把 historyLoaded 误打回 false。
  // 故把同步调用也包进 try/catch —— 重建失败绝不能影响历史加载。
  // 返回结果 promise(resolve 值 = 实际重建的挂起交互数;失败会 reject,内部已挂
  // 日志 catch 防 unhandledrejection):reconcileRemoteMessages 把它并入同步代数完成
  // 语义——needs-interaction 未读的 passive 远程回执必须等交互面板真实重建后才放行,
  // 且守卫早退路径只在真有提示(count>0)时才算一代完成。
  try {
    const run = makerApiFor(sessionId)
      .getPendingInteractions(sessionId)
      .then((list) => {
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
            survivingQueue.some(
              (setup, index) => setup !== state.pendingPluginSetupQueue[index],
            );
          const nextCommand =
            state.pluginSetupCommandInFlight &&
            authoritativePluginSetupIds.has(state.pluginSetupCommandInFlight.requestId)
              ? state.pluginSetupCommandInFlight
              : null;

          if (
            !currentChanged &&
            !queueChanged &&
            nextCommand === state.pluginSetupCommandInFlight
          ) {
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
 * 会话消息切片的代际号:整体重置切片的路径递增——reloadMessages(rewind / origin
 * 漂移重载)、clearSessionAfterGuard(/clear)、_purgeSession(删除 / 归档 / LRU 驱逐)。
 * loadOlderMessages 的追页循环在发起时快照代际,提交前比对——不一致说明
 * 追页期间切片已被整体重置,拉回的窗口作废(只复位 spinner,不把可能已软删的行
 * merge 回刚清空的 slice)。追页循环把竞态窗口从 1 次 RTT 拉长到最多 10 次
 * (隧道下可达数秒),这层守卫随之补上(subagent review 记录的既有竞态类别)。
 * purge 时保留条目(bump 而非 delete):删掉会让"捕获 0 → purge → 重建后仍是 0"
 * 的路径误判为未变;条目仅一个 number,不清理无泄漏压力。
 */
const _messagesEpoch = new Map<string, number>();

function bumpMessagesEpoch(sessionId: string): void {
  _messagesEpoch.set(sessionId, (_messagesEpoch.get(sessionId) ?? 0) + 1);
}

/**
 * DB sessions.agent_kind('cc' / 'codex')→ maker-core AgentKind 的唯一映射点。
 * 缺失 / 异常值走 fallback(默认 'claude-code',老 row 兼容)。所有从 session
 * row 派生 agentKind 的地方必须走这里,不要在调用点手写三元(历史上多处各写
 * 一份,遗漏 fallback 语义差异被 review 逐个揪出)。
 */
function dbAgentKindToMakerKind(
  dbKind: string | null | undefined,
  fallback: 'claude-code' | 'codex' = 'claude-code',
): 'claude-code' | 'codex' {
  if (dbKind === 'codex') return 'codex';
  if (dbKind === 'cc') return 'claude-code';
  return fallback;
}

function ensureInitialMessages(sessionId: string): void {
  const state = getOrCreateState(sessionId);
  requestInputProjection(sessionId);
  if (state.historyLoaded) return;
  if (_historyFetchInFlight.has(sessionId)) return;
  // 行水合并行异步读的陈旧性守卫: fetch 启动时定格 rev, 应用时比对(见 planModeRev)。
  const planModeRevAtFetchStart = state.planModeRev;

  // Mark in-flight to prevent concurrent callers from double-fetching.
  // historyLoaded stays false until data actually arrives.
  _historyFetchInFlight.add(sessionId);
  // 记录本次加载所依据的 origin(可能 undefined)。remote-projects 注入该会话来源后,
  // reconcileOpenSessionOrigins 比对此值发现漂移 → 重载(见上方说明)。
  _historyLoadOrigin.set(sessionId, remoteProjectsStore.getSessionDeviceId(sessionId));

  // Seed sdkSessionId from the server so resume works on app restart.
  // device-link 远程 session 经隧道读被控端 row(本地 DB 没有,直接 get 会 404)。
  getSessionFor(sessionId)
    .then((session) => {
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
    .catch((err) => log.warn('Failed to fetch session for sdkSessionId:', err));

  listMessagesFor(sessionId)
    .then(async (existing) => {
      if (existing.length === 0) {
        setState(sessionId, (s) => ({
          ...s,
          historyLoaded: true,
          hasMoreMessages: false,
        }));
        _historyFetchInFlight.delete(sessionId);
        // 历史加载完 → 重建当前挂起交互(新窗口/重连/刷新打开时面板才会出现)。
        reconcilePendingInteractions(sessionId);
        return;
      }

      // no-anchor-backfill: 初始页若全是"渲染后不留可见锚点"的行,映射结果就是空列表,
      // 而 MessageStream 在 visibleRenderItems.length === 0 时不触发自动翻页 —— 结果是
      // DB 里有 2000+ 条消息,重启后 ChatView 渲染 0 项,看起来"内容消失了"。
      // 两类命中(见 isNonAnchorHistoryRow):
      //   - 全是 tool_result:配对的 tool_use 父消息在更老的页里,orphan 会被丢弃;
      //   - 全是被隐藏的 thinking 行:如一轮搜索密集、在产出可见正文前就失败的会话,
      //     最新 50 行可能全是加密推理;
      //   - 合成指令行:渲染 null,混在上面两类里同样撑不出可见锚点。
      // 这里继续往前翻页,直到出现可渲染锚点或翻完。
      // 上限 10 页(500 行)防御异常长的连续无锚点队列。
      let merged: Message[] = existing;
      let oldestRow = oldestMessageRow(merged, 'newest-first');
      if (!oldestRow) {
        setState(sessionId, (s) => ({
          ...s,
          historyLoaded: true,
          hasMoreMessages: false,
        }));
        _historyFetchInFlight.delete(sessionId);
        reconcilePendingInteractions(sessionId);
        return;
      }
      let hasMore = serverMessagePageHasMore(existing);
      const MAX_BACKFILL_PAGES = 10;
      let pagesFetched = 0;
      while (
        hasMore &&
        pagesFetched < MAX_BACKFILL_PAGES &&
        merged.every(isNonAnchorHistoryRow)
      ) {
        pagesFetched += 1;
        try {
          const older = await listMessagesFor(sessionId, {
            limit: 50,
            before: oldestRow.id,
          });
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
      const mapped = mapServerMessages(merged);
      const oldestId = oldestRow.id;
      setState(sessionId, (s) => ({
        ...s,
        historyLoaded: true,
        // Merge: keep any messages already appended by streaming events
        // (unlikely here since we gate history load on first mount, but
        // preserves slice invariants).
        messages: mergeMessages(mapped, s.messages, {}, 'newest-first'),
        isFirstMessage: false,
        oldestMessageId:
          oldestServerMessageIdForWindow(merged, s.messages, s.oldestMessageId, 'newest-first') ??
          oldestId,
        hasMoreMessages: hasMore,
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
      reconcilePendingInteractions(sessionId);
    })
    .catch(() => {
      // Allow retry on next mount
      _historyFetchInFlight.delete(sessionId);
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
function reloadMessages(sessionId: string): void {
  discardPendingTextDelta(sessionId);
  // 代际递增:作废 in-flight 的 loadOlderMessages 追页窗口(见 _messagesEpoch 注释)。
  bumpMessagesEpoch(sessionId);
  // Drop the in-flight guard so ensureInitialMessages can run again.
  _historyFetchInFlight.delete(sessionId);
  setState(sessionId, (s) => ({
    ...s,
    messages: [],
    taskUpdates: new Map(),
    pendingTaskWake: false,
    historyLoaded: false,
    hasMoreMessages: false,
    oldestMessageId: null,
    isStreaming: false,
  }));
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
  discardPendingTextDelta(sessionId);
  // 作废删除提交前发起的历史分页，避免旧页响应把已经清除的行重新 merge 回来。
  if (options.invalidateHistory !== false) bumpMessagesEpoch(sessionId);
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
    if (messages.length === s.messages.length && taskUpdates === s.taskUpdates) {
      return s;
    }
    return {
      ...s,
      messages,
      taskUpdates,
      isFirstMessage: !messages.some((message) => message.role === 'user'),
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
  discardPendingTextDelta(sessionId);
  setState(sessionId, (s) => {
    const idx = s.messages.findIndex((m) => m.clientId === clientId);
    if (idx < 0) return s;
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
    if (current === undefined) continue;
    if (current === _historyLoadOrigin.get(sessionId)) continue;
    reloadMessages(sessionId);
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
function reconcileRemoteMessages(sessionId: string, opts?: { force?: boolean }): Promise<void> {
  // 返回完成 promise 供调用方需要时等待;既有调用方均按 fire-and-forget 使用。
  if (!sessionId || !isRemoteSession(sessionId)) return Promise.resolve();
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
      const mapped = mapServerMessages(collected);
      setState(sessionId, (s) => {
        // promise 期间可能已开始新 turn(streaming)→ 放弃本次合并,turn 结束会再触发。
        // force 时(stall 看门狗已确认被控端 not-running)放行:此处 isStreaming 是卡死残留。
        // 丢弃合并 = 拉回的窗口没进 UI:置 windowApplied=false,本次不得上报同步完成
        // (否则挂起的远程已读回执会在缺帧内容尚未展示时被放行),等 turn 结束的下一轮。
        if (s.isStreaming && !opts?.force) {
          windowApplied = false;
          return s;
        }
        const isContiguous = reachedKnownWindow;
        const messages = isContiguous
          ? mergeMessages(mapped, s.messages, {}, 'newest-first')
          : mergeAuthoritativeRemoteWindow(
              mapped,
              s.messages.filter((message) => !existingIds.has(message.clientId)),
              'newest-first',
            );
        if (messages === s.messages) return s; // 无缺失且无权威字段变化 → 不换引用(视同已应用)
        if (isContiguous) return { ...s, messages };
        const oldestRow = oldestMessageRow(collected, 'newest-first');
        return {
          ...s,
          messages,
          oldestMessageId: oldestRow?.id ?? s.oldestMessageId,
          hasMoreMessages: !reachedHistoryStart,
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

function loadOlderMessages(sessionId: string): void {
  const state = getOrCreateState(sessionId);
  if (state.isLoadingMore || !state.hasMoreMessages) return;

  let firstPageOpts: { limit: number; before?: string; beforeTs?: number };
  if (state.oldestMessageId) {
    firstPageOpts = { limit: 50, before: state.oldestMessageId };
  } else if (state.messages.length > 0) {
    const oldest = state.messages[0];
    if (!oldest.createdAt) return;
    const ts = new Date(oldest.createdAt).getTime();
    if (!Number.isFinite(ts)) return;
    firstPageOpts = { limit: 50, beforeTs: ts };
  } else {
    return;
  }

  setState(sessionId, (s) => ({ ...s, isLoadingMore: true }));

  // 代际快照:追页期间会话被 rewind/reload/purge 时,提交前比对发现代际已变
  // 即作废本次窗口(拉回的行可能已被服务端软删,merge 回去会让被裁剪的消息复活)。
  const epochAtStart = _messagesEpoch.get(sessionId) ?? 0;

  // 远程会话(device-link)往上翻页加载更多历史:会话与消息只在被控端,必须走 origin-aware
  // 的 listMessagesFor(本地会话回落 messageService.list),否则查控制端空库 → 旧历史加载为空。
  // 与初始加载 / backfill(本文件其余处)保持一致。
  void (async () => {
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

      // 代际比对:追页期间切片被整体重置(rewind reloadMessages / /clear / purge)
      // → 本次窗口作废,只复位 spinner(reload 的 setState 不清 isLoadingMore,这里
      // 不复位会让行首守卫永久卡住翻页)。此点之后到 setState 提交全程同步,无新竞态窗口。
      if ((_messagesEpoch.get(sessionId) ?? 0) !== epochAtStart) {
        setState(sessionId, (s) => ({ ...s, isLoadingMore: false }));
        return;
      }

      if (collected.length === 0) {
        setState(sessionId, (s) => ({
          ...s,
          // 只有确证翻完(空页)才收 hasMoreMessages;fetch 失败保持原值让用户可重试。
          hasMoreMessages: hasMore ? s.hasMoreMessages : false,
          isLoadingMore: false,
        }));
        return;
      }

      const mapped = mapServerMessages(collected);
      setState(sessionId, (s) => ({
        ...s,
        messages: mergeMessages(mapped, s.messages, {}, 'newest-first'),
        oldestMessageId: oldestId ?? s.oldestMessageId,
        hasMoreMessages: hasMore,
        isLoadingMore: false,
      }));
    } catch (err) {
      // map/merge/commit 阶段兜底(subagent review P1):任何异常都必须复位
      // isLoadingMore,否则行首守卫会让该会话永久无法再翻页(spinner 卡死)。
      log.warn('loadOlderMessages commit failed', { sessionId, err: String(err) });
      setState(sessionId, (s) => ({ ...s, isLoadingMore: false }));
    }
  })();
}

async function loadAroundMessage(
  sessionId: string,
  messageId: string,
  opts?: { radius?: number },
): Promise<ChatMessage | null> {
  // 按来源路由:远程会话经隧道 local-db:messages:around(直连本机会查控制端空库,跳转必失败)。
  const rows = await aroundMessagesFor(sessionId, messageId, opts);
  if (rows.length === 0) return null;

  const mapped = mapServerMessages(rows);
  const targetRow = rows.find((row) => row.id === messageId) ?? null;
  const targetClientId = targetRow?.clientId ?? null;
  setState(sessionId, (s) => {
    const messages = mergeMessages(mapped, s.messages, {}, 'oldest-first');
    const oldestMessageId = oldestServerMessageIdForWindow(
      rows,
      s.messages,
      s.oldestMessageId,
      'oldest-first',
    );
    return {
      ...s,
      messages,
      historyLoaded: true,
      isFirstMessage: false,
      oldestMessageId,
      hasMoreMessages: true,
      isLoadingMore: false,
    };
  });

  if (!targetClientId) return null;
  return mapped.find((message) => message.clientId === targetClientId) ?? null;
}

async function loadAroundMessageClientId(
  sessionId: string,
  clientId: string,
  opts?: { radius?: number },
): Promise<ChatMessage | null> {
  const rows = await aroundMessagesByClientIdFor(sessionId, clientId, opts);
  if (rows.length === 0) return null;

  const mapped = mapServerMessages(rows);
  setState(sessionId, (s) => {
    const messages = mergeMessages(mapped, s.messages, {}, 'oldest-first');
    const oldestMessageId = oldestServerMessageIdForWindow(
      rows,
      s.messages,
      s.oldestMessageId,
      'oldest-first',
    );
    return {
      ...s,
      messages,
      historyLoaded: true,
      isFirstMessage: false,
      oldestMessageId,
      hasMoreMessages: true,
      isLoadingMore: false,
    };
  });

  return mapped.find((message) => message.clientId === clientId) ?? null;
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
): QueuedMessage {
  const clientId = crypto.randomUUID();
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
    createdAt: new Date().toISOString(),
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

function extractSessionRefs(
  text: string,
  previous?: readonly AgentInputSessionRef[],
): NonNullable<AgentInputQueuedMessage['sessionRefs']> {
  // 粘滞版归属解析(与 learn/goal/makerTransport 链路对齐):relay 瞬时重连
  // 会 clear sessionId→deviceId 注册表,裸查表在这个窗口把远程会话错判成
  // 本地 → 引用解析落到控制端空本地库,内容注入失败。
  return reconcileSessionRefsForText(text, previous, getStickySessionDeviceId);
}

function buildCreateOptsForCurrentSession(
  sessionId: string,
  model: string,
  effort: string,
  permissionMode: string,
  workingDir: string,
  opts?: { vendorOptions?: Record<string, unknown> },
): AgentInputCreateOpts {
  const current = getOrCreateState(sessionId);
  const deviceLinkRemote = isRemoteSession(sessionId);
  const sshRemote = Boolean(current.remoteHostId);
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
    // device-link routes to the target desktop, so omit the controller setting;
    // SSH still starts the agent through this process and must not inherit the
    // controller's default-enabled Maker Memory for a remote working directory.
    ...(deviceLinkRemote
      ? {}
      : { makerMemoryEnabled: sshRemote ? false : getMakerMemoryEnabled() }),
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
  makerApiFor(sessionId)
    .input.setExpanded(sessionId, expanded)
    .then(applyInputProjection)
    .catch((err) => log.warn('setQueueExpanded failed:', err));
}

function resumeQueue(sessionId: string): void {
  if (!sessionId) return;
  makerApiFor(sessionId)
    .input.resume(sessionId)
    .then(applyInputProjection)
    .catch((err) => log.warn('resumeQueue failed:', err));
}

function setQueueInteractionLock(sessionId: string, lockId: string, locked: boolean): void {
  if (!sessionId || !lockId) return;
  makerApiFor(sessionId)
    .input.setInteractionLock(sessionId, lockId, locked)
    .then(applyInputProjection)
    .catch((err) => log.warn('setQueueInteractionLock failed:', err));
}

function setQueueEditLock(sessionId: string, clientId: string, locked: boolean): void {
  if (!sessionId || !clientId) return;
  makerApiFor(sessionId)
    .input.setEditLock(sessionId, clientId, locked)
    .then(applyInputProjection)
    .catch((err) => log.warn('setQueueEditLock failed:', err));
}

function moveQueueItem(sessionId: string, clientId: string, targetIndex: number): void {
  if (!sessionId || !clientId) return;
  makerApiFor(sessionId)
    .input.move(sessionId, clientId, targetIndex)
    .then(applyInputProjection)
    .catch((err) => log.warn('moveQueueItem failed:', err));
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
  makerApiFor(sessionId)
    .input.remove(sessionId, clientId)
    .then(applyInputProjection)
    .catch((err) => log.warn('removeFromQueue failed:', err));
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
  makerApiFor(sessionId)
    .input.updateText(
      sessionId,
      clientId,
      newText,
      extractSessionRefs(newText, queued?.sessionRefs),
    )
    .then(applyInputProjection)
    .catch((err) => log.warn('updateQueueItem failed:', err));
}

/**
 * 已确认「不再需要自动起名」的会话(main 返回 done=true:已起过名,或用户手动
 * 改过名)。纯粹是省 IPC 的缓存 —— 权威判定始终在 main。
 *
 * 只在 main 明确给出 done=true 时登记:瞬时失败(IPC/DB 异常、模型无结果)不登记,
 * 下一条带文字的消息会重试,不会因一次抖动把会话永久钉在占位标题上。
 */
const autoNameSettled = new Set<string>();

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
  agentKind: 'claude-code' | 'codex',
  isUserText = true,
): void {
  // 与 main 的 normalizeAutoTitle 同一套规则,两端算出的占位串一致,回流时不跳变。
  const fallbackTitle = text.replace(/\s+/g, ' ').trim().slice(0, 40).trimEnd();
  // 连描述都合成不出来(既无文字也无可命名附件):保留默认标题,留给下一条消息。
  if (!fallbackTitle) return;
  if (isRemoteSession(sessionId)) {
    // 带上 isUserText:合成描述对应「被控端先写占位、之后还要换掉」,要登记成系统
    // 占位归属;用户文字对应的标题可能就此定稿,登记了会让后续预览一直盖着它。
    remoteProjectsStore.setPendingTitlePreview(sessionId, fallbackTitle, isUserText);
    return;
  }
  if (autoNameSettled.has(sessionId)) return;
  // 整条链路对发送主流程必须是无副作用的:起名失败(桥接缺失 / IPC 抛错)只记日志,
  // 绝不能把异常抛回 sendMessageCore 打断消息入队。
  try {
    void window.electronAPI.maker
      .autoTitle({ sessionId, text, agentKind, isUserText })
      .then((result) => {
        if (result?.done) autoNameSettled.add(sessionId);
      })
      .catch((err) => {
        // 不登记 settled —— 下一条带文字的消息会重试。
        log.warn('Failed to auto-name session:', err);
      });
  } catch (err) {
    log.warn('Failed to invoke auto-title IPC:', err);
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
  agentKind: 'claude-code' | 'codex',
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
};

/** remote(SSH / device-link)会话:标注编辑数据指向控制端本地缓存,发送时剥离。 */
function isRemoteMediaSession(sessionId: string): boolean {
  return Boolean(
    getOrCreateState(sessionId).remoteHostId ?? remoteProjectsStore.getSessionDeviceId(sessionId),
  );
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
    );
  }
  return materializeAnnotatedAttachmentsForSend(files, sessionId, {
    stripAnnotationMeta: isRemoteMediaSession(sessionId),
  }).then((prepared) =>
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
    ),
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
): Promise<boolean> {
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
  );

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
  const autoTitleSeed = deriveAutoTitleSeed(queued, autoTitleFallbackLabels());
  if (wasFirst) {
    // 用会话真实 agentKind 起名 — 之前写死 'claude-code',导致 Codex 会话也
    // 用 Claude haiku 起标题:纯 Codex 用户(无 Claude 鉴权)会 oneShot 失败 →
    // fallback 原话,表现为"Codex 会话标题没有智能总结"。current.agentKind 已是
    // maker 格式('claude-code' | 'codex'),直接透传。起名走立即占位 + 后台覆盖。
    if (autoTitleSeed) {
      scheduleAutoName(sessionId, autoTitleSeed.text, current.agentKind, autoTitleSeed.isUserText);
    }
  } else {
    // 补起名:首条是纯附件(只贴图没打字)、标题还是合成占位或默认名的会话,以及
    // fork 出来的占位标题会话,都在第一条带文字的消息上把标题换成用户写的内容。
    maybeAutoNameUnnamedSession(sessionId, autoTitleSeed, current.agentKind);
  }

  // 视觉连续性: agent 空闲 + 队列为空时, main coordinator 会立即派发这条(见
  // agent-input-coordinator.enqueue 的 immediate 分支)。提前乐观把 user 气泡 push
  // 进消息流, 让"按 Enter → 气泡出现"既无队列灰字闪烁、也没有等 DB 广播回投的空窗。
  // busy 判定取镜像于 main getDrainableHead(isSendBusyForQueue = boundary busy ||
  // 队列非空)。派发落库后 localDb.messages.onCreated 广播按 clientId dedupe 不会重复;
  // 若 race 导致 main 实际排了队 / 派发失败回退, applyInputProjection 会按 pendingQueue
  // 的 clientId 撤回这条乐观气泡, 回落到队列态。
  if (!isSendBusyForQueue(current)) {
    setState(sessionId, (s) =>
      s.messages.some((m) => m.clientId === queued.clientId)
        ? s
        : { ...s, messages: [...s.messages, { ...queued.chatMessage, isPendingPersist: true }] },
    );
  }

  return makerApiFor(sessionId)
    .input.enqueue(sessionId, queued, { sendAtMs: Date.now() })
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
      applyInputProjection(projection);
      markSessionHasUserMessage(sessionId);
      return true;
    })
    .catch((err) => {
      // 远端 lazy-create/startSession 抛的 [REMOTE_*] 不可恢复错误走 IPC reject 落这里
      // (不经 stream error event reducer),同样要解码成 i18n 文案,别裸显 bracket code。
      const message = decodeRemoteErrorMessage(err instanceof Error ? err.message : String(err));
      // 远程会话:enqueue reject(NOT_CONNECTED / ACCESS_REVOKED / DEVICE_LINK_MEDIA_TRANSFER_FAILED 等)
      // 后不会有 input projection 回来撤回乐观气泡,这里按 clientId 主动移除,避免一条没真正发出的
      // 消息残留在 transcript。本地会话走 projection 撤回(busy 排队/派发失败回落),不动。
      setState(sessionId, (s) => ({
        ...s,
        messages: isRemoteSession(sessionId)
          ? s.messages.filter((m) => !(m.clientId === queued.clientId && m.isPendingPersist))
          : s.messages,
        error: message,
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
  return makerApiFor(sessionId)
    .input.compact(sessionId, createOpts, { userName: currentUserName })
    .then((projection) => {
      applyInputProjection(projection);
      return projection.error === null;
    })
    .catch((err) => {
      const message = decodeRemoteErrorMessage(err instanceof Error ? err.message : String(err));
      setState(sessionId, (s) => ({
        ...s,
        error: message,
        recoverableError: null,
        errorRetryText: null,
      }));
      return false;
    });
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
  },
): Promise<boolean> {
  if (!sessionId || (!text.trim() && (!files || files.length === 0)) || !workingDir) {
    return Promise.resolve(false);
  }
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
    );
  }
  return materializeAnnotatedAttachmentsForSend(files, sessionId, {
    stripAnnotationMeta: isRemoteMediaSession(sessionId),
  }).then((prepared) =>
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
    ),
  );
}

/** steerMessage 的主体(附件已完成标注物化),同步构建并入队。 */
function steerMessageCore(
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
  },
): Promise<boolean> {
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
  );
  touchSessionUserSend(sessionId, workingDir, false);
  // 补起名同样要覆盖 steer:首条是纯附件的会话标题此时是合成占位,而用户完全
  // 可能趁这一轮还在跑就用「插话」写下第一句话。只走普通发送的话,这句话不会
  // 改名,标题会一直停在附件名直到他再排队发一条(PR #510 review P1)。
  // 素材在入队前推导(此刻 queued 还在手里),但**只有输入被受理才改名**:同会话
  // 已有在飞 steer / Stop 边界 / 输入锁都会让它被拒,拒掉的文本不该改名。
  const autoTitleSeed = deriveAutoTitleSeed(queued, autoTitleFallbackLabels());
  const agentKind = getOrCreateState(sessionId).agentKind;
  const commitAutoTitle = () => maybeAutoNameUnnamedSession(sessionId, autoTitleSeed, agentKind);
  return makerApiFor(sessionId)
    .input.steer(sessionId, queued, { touchUserSend: true })
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
        const latest = await makerApiFor(sessionId).input.getProjection(sessionId);
        applyInputProjection(latest);
        if (latest.pendingQueue.some((q) => q.clientId === queued.clientId)) {
          // 物化进队列 = 这条输入已被主端接管、日后会派发,与受理同等 —— 起名也要
          // 跟上,否则纯附件/fork 之后的第一句话恰好在这条不确定路径上不改名
          // (review P1)。是否真该改名仍由 main 权威判定。
          commitAutoTitle();
          return true;
        }
      } catch (err) {
        log.warn('steer materialization check failed:', err);
      }
      return false;
    })
    .catch((err) => {
      // 远端 lazy-create/startSession 抛的 [REMOTE_*] 不可恢复错误走 IPC reject 落这里
      // (不经 stream error event reducer),同样要解码成 i18n 文案,别裸显 bracket code。
      const message = decodeRemoteErrorMessage(err instanceof Error ? err.message : String(err));
      setState(sessionId, (s) => ({
        ...s,
        error: message,
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
  }
}

function steerQueuedMessage(sessionId: string, clientId: string): Promise<boolean> {
  if (!sessionId || !clientId) return Promise.resolve(false);
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
  return makerApiFor(sessionId)
    .input.steer(sessionId, queued, { removeFromQueue: true })
    .then((ok) => {
      requestInputProjection(sessionId);
      return ok;
    })
    .catch((err) => {
      // 远端 lazy-create/startSession 抛的 [REMOTE_*] 不可恢复错误走 IPC reject 落这里
      // (不经 stream error event reducer),同样要解码成 i18n 文案,别裸显 bracket code。
      const message = decodeRemoteErrorMessage(err instanceof Error ? err.message : String(err));
      setState(sessionId, (s) => ({
        ...s,
        error: message,
        recoverableError: null,
        errorRetryText: null,
      }));
      return false;
    });
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
  opts?: { keepQueue?: boolean; pauseQueue?: boolean },
): void {
  if (!sessionId) return;
  flushPendingTextDelta(sessionId);
  makerApiFor(sessionId)
    .input.stop(sessionId, opts)
    .then(applyInputProjection)
    .catch((err) => log.warn('maker.input.stop failed:', err));
  setState(sessionId, (s) => {
    const id = s.streamingClientId;
    // F7.6 / FP-3: expire any pending ask_user + plan_review messages on stop
    const msgs = s.messages.map((m) => {
      if (id && m.clientId === id) return { ...m, isStreaming: false };
      if (m.role === 'ask_user' && m.askUserStatus === 'pending') {
        return { ...m, askUserStatus: 'expired' as const };
      }
      if (m.role === 'plan_review' && m.planReviewStatus === 'pending') {
        return { ...m, planReviewStatus: 'expired' as const };
      }
      return m;
    });

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
  makerApiFor(sessionId)
    .input.clearError(sessionId)
    .then(applyInputProjection)
    .catch((err) => log.warn('clearError failed:', err));
  setState(sessionId, (s) => {
    if (s.error == null && s.recoverableError == null && s.errorRetryText == null) return s;
    return { ...s, error: null, errorReason: null, recoverableError: null, errorRetryText: null };
  });
}

function retryLastError(sessionId: string): void {
  if (!sessionId) return;
  // 续跑语义在 main:coordinator 判定失败 turn 已有 assistant 产出时,用共享英文
  // 常量 CONTINUE_AFTER_ERROR_PROMPT 替代重发原文(shared/interruptedTurn.ts),
  // renderer 不传文案、不做判定。
  makerApiFor(sessionId)
    .input.retryLastError(sessionId)
    .then(applyInputProjection)
    .catch((err) => log.warn('retryLastError failed:', err));
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
      setState(sessionId, (s) => ({ ...s, error: null, errorReason: null, errorRetryText: null }));
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
 */
function dismissErrorTailMessage(sessionId: string, clientId: string): void {
  if (!sessionId || !clientId) return;
  setState(sessionId, (s) => ({
    ...s,
    messages: s.messages.map((m) =>
      m.clientId === clientId && m.role === 'error' ? { ...m, errorDismissed: true } : m,
    ),
  }));
  dismissErrorMessageFor(sessionId, clientId).catch((err) =>
    log.warn('persist error dismiss failed:', err),
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
function clearSession(sessionId: string): void {
  if (!sessionId) return;
  const clearedAt = new Date().toISOString();

  void clearSessionAfterGuard(sessionId, clearedAt);
}

async function clearSessionAfterGuard(sessionId: string, clearedAt: string): Promise<void> {
  noteRendererClearBoundary(sessionId, clearedAt);
  // Arm main-side clear guards before closing the CLI and clearing renderer state.
  let guardTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let guardResult:
    | { kind: 'projection'; projection: AgentInputProjection }
    | { kind: 'error'; err: unknown }
    | { kind: 'timeout' };
  try {
    guardResult = await Promise.race([
      makerApiFor(sessionId)
        .input.clearSession(sessionId, clearedAt)
        .then(
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
    applyInputProjection(guardResult.projection);
  } else if (guardResult.kind === 'error') {
    const err = guardResult.err;
    log.warn('maker.input.clearSession failed:', err);
  } else {
    log.warn('maker.input.clearSession timed out; continuing local clear', { sessionId });
  }

  _lastViewedAt.delete(sessionId);
  discardPendingTextDelta(sessionId);
  // Close the CLI subprocess entirely (not just interrupt — we want a fresh context).
  // preserveWorkspace: /clear 后停留在同一会话,worktree / cwd 必须原样保留,
  // 否则 onClose 副作用会把活会话的工作区静默 stash+删除(2026-07 实报)。
  makerApiFor(sessionId)
    .closeSession(sessionId, { preserveWorkspace: true })
    .catch((err) => log.warn('maker.closeSession failed:', err));

  // Clear in-memory state; preserve isFirstMessage so the view stays in ChatView
  // with an empty message list (matches /clear semantics).
  // 代际递增:/clear 与 reloadMessages / purge 同属"整体重置切片",作废 in-flight
  // 的 loadOlderMessages 追页窗口——否则晚到的翻页提交会把清空前的行 merge 回来,
  // 已 clear 的对话在界面上复活(subagent review P1;bump 点清单见 _messagesEpoch 注释)。
  bumpMessagesEpoch(sessionId);
  setState(sessionId, (s) => {
    return {
      ...s,
      messages: [],
      taskUpdates: new Map(),
      pendingTaskWake: false,
      streamingClientId: null,
      streamingText: '',
      isStreaming: false,
      error: null,
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
      pendingQueue: [],
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
  if (isRemoteSession(sessionId)) return;
  sessionService
    .update(sessionId, { sdkSessionId: null, clearedAt })
    .then(() => {
      // clearSession 不改变列表成员、也不改变 _count.messages（物理 row 还在）
      // 只 patch 这两个字段同步到 sidebar，别再全量 refresh。
      emitPatch(sessionId, { sdkSessionId: null, clearedAt, updatedAt: clearedAt });
    })
    .catch((err) => log.error('clearSession failed:', err));
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
 * confirmed=true 时携带卡片当前的 title/body/type(用户编辑版,main 以此为准)
 * 和 renderer 界面语言(uiLanguage,main 附进 issue body 的环境块)。
 */
function respondToIssueConfirm(
  sessionId: string,
  result:
    | { confirmed: true; title: string; body: string; type: 'bug' | 'feature'; uiLanguage: string }
    | { confirmed: false },
): void {
  if (!sessionId) return;
  const state = getOrCreateState(sessionId);
  if (!state.pendingIssueConfirm) return;

  const { requestId } = state.pendingIssueConfirm;

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
  if (sourceRemoteDeviceId || isRemoteSession(sessionId)) {
    const previousFastMode = getOrCreateState(sessionId).fastMode;
    setState(sessionId, (s) => (s.fastMode === enabled ? s : { ...s, fastMode: enabled }));
    try {
      const remoteMaker = sourceRemoteDeviceId
        ? makerApiForDevice(sourceRemoteDeviceId)
        : makerApiFor(sessionId);
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
  if (isRemoteSession(sessionId)) {
    const previous = getOrCreateState(sessionId).planModeEnabled;
    setState(sessionId, (s) =>
      s.planModeEnabled === enabled
        ? s
        : { ...s, planModeEnabled: enabled, planModeRev: s.planModeRev + 1 },
    );
    try {
      await makerApiFor(sessionId).setPlanMode(sessionId, enabled);
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
  if (isRemoteSession(sessionId)) {
    setState(sessionId, (s) => (!s.fastMode ? s : { ...s, fastMode: false }));
    await makerApiFor(sessionId)
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

function sendUiTrigger(sessionId: string, prompt: string): Promise<void> {
  if (!sessionId) return Promise.reject(new Error('sendUiTrigger: empty sessionId'));
  const state = getOrCreateState(sessionId);
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
          makerApiFor(sessionId)
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
      const deviceLinkRemote = isRemoteSession(sessionId);
      queued.createOpts = {
        ...queued.createOpts,
        agentKind: dbAgentKindToMakerKind(session.agentKind, state.agentKind),
        fastMode: session.fastMode ?? state.fastMode,
        planMode: false,
        ...(session.providerId !== undefined ? { providerId: session.providerId } : {}),
        ...((session.sdkSessionId ?? state.sdkSessionId)
          ? { resumeSessionId: (session.sdkSessionId ?? state.sdkSessionId) as string }
          : {}),
        // buildQueuedMessage may have used a pre-hydration store snapshot.
        // The DB row is authoritative here: SSH lazy-create must not inherit
        // controller-local Cindy Memory. Device-link keeps target ownership.
        ...(session.remoteHostId && !deviceLinkRemote ? { makerMemoryEnabled: false } : {}),
        // 远端 SSH 会话:重启后 lazy-create 缺它会把远端 workingDir 当本地路径。
        ...(session.remoteHostId ? { remoteHostId: session.remoteHostId } : {}),
      };
      return makerApiFor(sessionId)
        .input.enqueue(sessionId, queued, { sendAtMs: Date.now() })
        .then((projection) => {
          applyInputProjection(projection);
        });
    })
    .catch((err) => {
      log.warn('sendUiTrigger failed', err);
      throw err instanceof Error ? err : new Error(String(err));
    });
}

/**
 * session-agent-switch:切换 IPC 成功后由 ChatInput 调用。翻转 in-memory
 * agentKind(事件 reducer 路由 + createOpts 派生都读它)并清掉旧引擎的
 * sdkSessionId——否则 buildCreateOpts 会把旧引擎的原生会话 id 当 resume 目标
 * (main 侧 reconcileCreateOptsWithDb 是兜底,这里是第一现场收敛)。
 */
function noteAgentSwitched(sessionId: string, agentKind: 'claude-code' | 'codex'): void {
  if (!sessionId) return;
  setState(sessionId, (s) =>
    s.agentKind === agentKind && s.sdkSessionId === null && s.agentSwitchIntent === null
      ? s
      : { ...s, agentKind, sdkSessionId: null, agentSwitchIntent: null },
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
  target: 'claude-code' | 'codex',
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
  }));
}

/** 用户选回当前引擎或 main 明确取消意图:只移除展示覆盖。 */
function clearAgentSwitchIntent(sessionId: string): void {
  if (!sessionId) return;
  setState(sessionId, (s) =>
    s.agentSwitchIntent === null ? s : { ...s, agentSwitchIntent: null },
  );
}

function getAgentSwitchIntent(sessionId: string): AgentSwitchIntentRecord | null {
  return sessions.get(sessionId)?.agentSwitchIntent ?? null;
}

function setSessionRuntime(
  sessionId: string,
  opts: { agentKind?: 'claude-code' | 'codex'; fastMode?: boolean; planModeEnabled?: boolean },
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
        agentSwitchIntentCanceled?: unknown;
      }
    | null
    | undefined,
): void {
  if (!sessionId || !patch) return;
  if (patch.agentSwitchIntentCanceled === true) clearAgentSwitchIntent(sessionId);
  // session-agent-switch:引擎翻转必须镜像进 chat in-memory——maker:event 的
  // reducer 按 state.agentKind 分流(Claude / Codex 两套),非发起窗口若停在旧值,
  // 新引擎的事件会被旧引擎 reducer 错误处理(2026-07-20 审计实锤)。随引擎翻转
  // 同步清 sdkSessionId(旧引擎的原生会话 id 对新引擎无意义,与 noteAgentSwitched
  // 口径一致)。幂等:发起窗口已 noteAgentSwitched → 同值 no-op。
  if (patch.agentKind === 'cc' || patch.agentKind === 'codex') {
    const nextKind = patch.agentKind === 'codex' ? 'codex' : 'claude-code';
    setState(sessionId, (s) => {
      const intentApplied = s.agentSwitchIntent?.target === nextKind;
      if (s.agentKind === nextKind && !intentApplied) return s;
      return {
        ...s,
        agentKind: nextKind,
        sdkSessionId: null,
        ...(intentApplied ? { agentSwitchIntent: null } : {}),
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
   * 后台任务快照水合:把 main 的 listSessionBackgroundTasks 结果补进 taskUpdates。
   * 只补「store 里完全没见过」的任务 —— 事件流是唯一实时源,快照可能落后于刚到
   * 的终态事件,已存在的条目(无论何状态)绝不用快照的 running 覆盖复活。
   * 消费方:useBackgroundBashTasks(会话挂载 / reloadMessages 清空 taskUpdates 后)。
   */
  seedBackgroundTaskSnapshots: (
    sessionId: string,
    tasks: Array<{ taskId: string; taskType?: string; toolUseId?: string; title?: string }>,
  ): void => {
    if (!tasks.length) return;
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
      return next;
    });
  },
  /** Exposed for tests only. */
  __teardownGlobalListeners,
  /** Exposed for tests only: 非首条消息的补起名(纯附件首条 / fork 占位)。 */
  __autoNameUnnamedSessionForTest: maybeAutoNameUnnamedSession,
  /** Exposed for tests only: 清空「已确认无需起名」缓存,隔离用例间状态。 */
  __resetAutoNameStateForTest: (): void => {
    autoNameSettled.clear();
  },
  /** Exposed for tests only: 把 stream event 打进真实 store(驱动 getRunningSnapshot 等)。 */
  __applyStreamEventForTest: (sessionId: string, event: CCAgentStreamEvent): void =>
    setState(sessionId, (s) => handleStreamEvent(s, event)),
  /** Exposed for tests only: 把 status update 打进真实 store。 */
  __applyStatusUpdateForTest: (sessionId: string, update: CCAgentStatusUpdate): void =>
    setState(sessionId, (s) => handleStatusUpdate(s, update)),
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

function mergeMessages(
  serverMsgs: ChatMessage[],
  existing: ChatMessage[],
  options: HydratePersistedMessageOptions = {},
  rowsOrder: RemoteRowsOrder = 'oldest-first',
): ChatMessage[] {
  const serverOrder = new Map(serverMsgs.map((message, index) => [message.clientId, index]));
  if (existing.length === 0) return sortMessagesChronologically(serverMsgs, serverOrder, rowsOrder);
  const serverByClientId = new Map(serverMsgs.map((message) => [message.clientId, message]));
  const seen = new Set<string>();
  let changed = false;
  const hydratedExisting = existing.map((message) => {
    seen.add(message.clientId);
    const persisted = serverByClientId.get(message.clientId);
    if (!persisted) return message;
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
  return !changed && sameOrder ? existing : sorted;
}

/** 对账找不到重叠时,用远端权威窗口替换旧缓存窗口,只保留对账期间新到的消息。 */
function mergeAuthoritativeRemoteWindow(
  serverMsgs: ChatMessage[],
  lateArrivals: ChatMessage[],
  rowsOrder: RemoteRowsOrder,
): ChatMessage[] {
  if (serverMsgs.length === 0) return lateArrivals;
  return mergeMessages(serverMsgs, lateArrivals, {}, rowsOrder);
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
 * 两类:
 *   - `isRedacted` 加密推理:没有任何明文可读,卡片只能显示"无法显示的思考过程",对用户是
 *     纯噪音;上游开服务端工具后一轮能出十几条,会淹掉真实产出。与 live 路径
 *     (handleStreamEvent 的 stage==='redacted')同判定。
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
  const durationMs = typeof c.durationMs === 'number' ? c.durationMs : 0;
  return isOmittedThinkingPlaceholder(text, durationMs);
}

/**
 * 该服务端行**渲染后不会留下可见锚点**(初始页全是这类行时必须继续往前翻页)。
 *
 * 三类:
 *   - `tool_result`:配对的 tool_use 父消息可能在更老的页里,MessageStream 会丢弃 orphan;
 *   - 被 `isHiddenThinkingRow` 过滤掉的行:直接不进渲染列表;
 *   - 合成指令行(`isSyntheticTriggerRow`):MessageStream 渲染 null、content 置空,
 *     与 `loadOlderMessages` 的可见锚点判定同口径(见该处「合成指令行渲染 null,不算可见
 *     锚点」)。少了这一类,一页里只要混进一条合成 user 行就会被当成锚点提前停止回填,
 *     而它映射后同样不产生可见内容 —— 症状与完全不回填一样。
 *
 * 任何组合占满整页,都会让映射结果为空,而 MessageStream 在 `visibleRenderItems.length === 0`
 * 时不触发自动翻页 —— 结果是 DB 里有几千条消息、重开会话却渲染 0 项,更老的用户/助手消息
 * 再也拉不回来。
 */
function isNonAnchorHistoryRow(m: Message): boolean {
  return m.role === 'tool_result' || isHiddenThinkingRow(m) || isSyntheticTriggerRow(m);
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
        isStreaming: false,
        // subagent-model-chip: 从持久化 agentMeta 复原 model / parentUuid,
        // 让历史重载后 Agent/Task 行也能显示子代理模型 chip(透传点 B)。
        ...(typeof m.agentMeta?.model === 'string' && m.agentMeta.model
          ? { model: m.agentMeta.model }
          : {}),
        ...(typeof m.agentMeta?.parentUuid === 'string' && m.agentMeta.parentUuid
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
        ...(typeof m.agentMeta?.parentUuid === 'string' && m.agentMeta.parentUuid
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
      return {
        clientId: m.clientId,
        role: m.role,
        content: message,
        isStreaming: false,
        ...(reason ? { errorReason: reason } : {}),
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
    const agentMeta = m.agentMeta;
    const turnUsageDetails =
      m.role === 'assistant'
        ? normalizeTurnUsageDetails(agentMeta?.turnUsageDetails)
        : undefined;
    const normalizedTurnMoney =
      m.role === 'assistant'
        ? normalizeRegionalMoney(agentMeta?.turnCost)
        : undefined;
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
        ? normalizedTurnMoney ??
          (legacyTurnCostUsd !== undefined
            ? legacyUsdMoney(legacyTurnCostUsd)
            : undefined)
        : undefined;
    return {
      clientId: m.clientId,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      // tool_result 消息也带 toolUseId(DB 列),让 MessageStream 能按 id 配对
      ...(m.role === 'tool_result' && typeof m.toolUseId === 'string' && m.toolUseId.length > 0
        ? { toolUseId: m.toolUseId }
        : {}),
      // SDK done turn seal:新数据用 turnCompleted；存量会话已有 turnCostUsd 的收尾
      // assistant 等价可推导，直接补投影让本修复对历史复现会话立即生效。
      ...(m.role === 'assistant' && (
        agentMeta?.turnCompleted === true ||
        (persistedTurnMoney?.amount ?? 0) > 0
      )
        ? { turnCompleted: true }
        : {}),
      // assistant 上挂的 per-turn 费用(main turn 结束时 patch 进 agent_meta)
      ...(m.role === 'assistant' &&
      agentMeta &&
      persistedTurnMoney &&
      persistedTurnMoney.amount > 0
        ? (() => {
            const turnCostUsd =
              persistedTurnMoney.currency === 'USD'
                ? persistedTurnMoney.amount
                : undefined;
            const persistedUserTurnMoney =
              normalizeRegionalMoney(agentMeta.userTurnCost) ??
              (typeof agentMeta.userTurnCostUsd === 'number' &&
              agentMeta.userTurnCostUsd > 0
                ? legacyUsdMoney(agentMeta.userTurnCostUsd)
                : undefined);
            return {
              turnMoney: persistedTurnMoney,
              ...(turnCostUsd !== undefined ? { turnCostUsd } : {}),
              turnCostIsEstimate: agentMeta.turnCostIsEstimate === true,
              ...(persistedUserTurnMoney
                ? {
                    userTurnMoney: persistedUserTurnMoney,
                    ...(typeof agentMeta.userTurnCostUsd === 'number' &&
                    agentMeta.userTurnCostUsd > 0
                      ? { userTurnCostUsd: agentMeta.userTurnCostUsd }
                      : {}),
                    userTurnCostIsEstimate: agentMeta.userTurnCostIsEstimate === true,
                  }
                : {}),
              ...(turnUsageDetails ? { turnUsageDetails } : {}),
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
      ...(typeof m.agentMeta?.parentUuid === 'string' && m.agentMeta.parentUuid
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
): Map<
  string,
  Pick<
    ChatMessage,
    'userTurnMoney' | 'userTurnCostUsd' | 'userTurnCostIsEstimate'
  >
> {
  const projected = new Map<
    string,
    Pick<
      ChatMessage,
      'userTurnMoney' | 'userTurnCostUsd' | 'userTurnCostIsEstimate'
    >
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
