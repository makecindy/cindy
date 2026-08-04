/**
 * Codex app-server v2 Notification → maker-core 语义 AgentEvent 翻译器。
 *
 * **完全重写** (路线 A): 输入从 SDK ThreadEvent 换成 app-server v2 Notification 系列;
 * 输出 AgentEvent shape 与 claude-code/translator.ts **保持完全一致**, renderer 零改动。
 *
 * 协议真值 (只读):
 *   - codex-rs/app-server-protocol/src/protocol/v2.rs ThreadItem 枚举 (line 6082)
 *     #[serde(tag = "type", rename_all = "camelCase")] → 字段是 camelCase, 变体 tag 是 camelCase
 *     (e.g. "agentMessage" 不是 "agent_message")
 *   - 与上一版 SDK ThreadEvent 的差异 (重要):
 *     1. Reasoning 不再是单个 text, 而是 summary: string[] + content: string[]
 *     2. CommandExecution 加了 cwd / commandActions / processId / durationMs
 *        (cwd / commandActions 透传进 tool_use input; processId / durationMs 暂不用)
 *     3. **没有 todo_list item** — Codex v2 协议级删除, 用 Plan { id, text } 兜底
 *     4. WebSearch 多了 action: WebSearchAction (Search/OpenPage/FindInPage)
 *
 * 不在本文件做的事 (与上一版一致, 由 index.ts 处理):
 *  - thread/started → sessionId emit (index.ts 持 sdkSessionId 闭包)
 *  - thread/tokenUsage/updated → ingest usage (index.ts 持 tracker)
 *  - turn/completed → status + done event (index.ts 持 tracker snapshot)
 *  - turn-start status 文案 / userName → index.ts 在 send() 入口 push
 */

import {
  extractNonSecretErrorSignals,
  redactSensitiveText,
} from '@cindy/maker-shared/error-redaction';

import type { AgentEvent, AgentTaskStatus, AgentTaskUpdateEventData } from '../../types/events.js';
import { normalizeAccountRateLimitSnapshot } from '../../types/account-rate-limits.js';
import type { AsyncQueue } from '../shared/async-queue.js';
import { stripTerminalControlSequences } from '../shared/terminal-output.js';
import { parseReconnectAttemptMessage } from '../shared/network-error.js';
import {
  UPSTREAM_OVERLOAD_REASON,
  formatOverloadRetryMessage,
  parseOverloadError,
} from '../shared/overload-error.js';
import { commandExecutionDisplayInput, type CommandExecutionDisplayInput } from './command-display.js';
import { codexErrorInfoTag } from './app-server/protocol.js';
import type {
  ItemCompletedNotification,
  ItemStartedNotification,
  ItemUpdatedNotification,
  TurnPlanUpdatedNotification,
  ErrorNotification,
  ReasoningSummaryTextDeltaNotification,
  ReasoningSummaryPartAddedNotification,
  ReasoningTextDeltaNotification,
  AccountRateLimitsUpdatedNotification,
} from './app-server/protocol.js';

// ── 共享 runtime 状态 ────────────────────────────────────────────────────────
//
// 跨多个 Notification 维持的累积态。语义和上一版一致,
// 但因为 reasoning text 现在是数组 join 出来的, reasoningTextLen 跟踪 join 后总长。

export interface CodexRuntimeState {
  /** item.id → reasoning 第一次 emit 'start' 的时间 (Date.now ms)。 */
  reasoningStartedAt: Map<string, number>;
  /** item.id → reasoning 已 emit 文本字符长度 (上次 join 后总长)。 */
  reasoningTextLen: Map<string, number>;
  /** item.id → agentMessage 已 emit 文本字符长度(citation 归一化后的空间,见 handleAgentMessage)。 */
  itemTextLen: Map<string, number>;
  /** 已经 emit 过 tool_use 的 item.id (避免 started + 第一次 updated 重复)。 */
  emittedToolUse: Set<string>;
  /** 尚未 emit 的 Web Search 候选输入，供跨 started/updated/completed 快照补全。 */
  pendingWebSearchInput: Map<string, WebSearchInput>;
  /** 已 emit 的 Web Search 输入，用于判断 completed 是否带来权威参数更新。 */
  emittedWebSearchInput: Map<string, WebSearchInput>;
  /**
   * Auth retry-loop dedupe key (`<threadId>|<turnId>`)。daemon 撞 401 时
   * willRetry=true 通知会按 retry 频率 (~每秒) 持续发, 不 dedupe 会让
   * 下游 (makerChatStore case 'error' 走 refreshApiKeyFromServer / 结构化
   * error log / 频繁 banner surface) 全跟着触发风暴。turnStarted 时清,
   * 让下一个 turn 重新 emit 第一条 auth error。
   */
  lastAuthErrorKey: string | null;
  /**
   * 网络类 retry-loop 透出状态 (`<threadId>|<turnId>` → 已见次数)。daemon 撞
   * 502/连接失败等网络错误时 willRetry=true 默认被吞(瞬时抖动不该打扰用户),
   * 但网络长时间不通时 daemon 卡在 retry-loop、turn 无限转圈,用户毫无感知。
   * 同 turn 第 2 次网络类 willRetry 错误时透出**一条**非终止提示(之后同 turn
   * 不再发,防风暴;恢复后 renderer recoverableError 机制随正常事件自动清)。
   * turnStarted 时与 lastAuthErrorKey 一起清。
   */
  networkRetryNotice: { key: string; count: number; emitted: boolean } | null;
}

export function newCodexRuntimeState(): CodexRuntimeState {
  return {
    reasoningStartedAt: new Map(),
    reasoningTextLen: new Map(),
    itemTextLen: new Map(),
    emittedToolUse: new Set(),
    pendingWebSearchInput: new Map(),
    emittedWebSearchInput: new Map(),
    lastAuthErrorKey: null,
    networkRetryNotice: null,
  };
}

// ── 上下文 ────────────────────────────────────────────────────────────────────

interface TranslatorLog {
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  debug(msg: string, ctx?: Record<string, unknown>): void;
}

export interface CodexTranslateContext {
  rt: CodexRuntimeState;
  log: TranslatorLog;
  /**
   * Maker Memory flush 观察器 — codex contextCompaction completed 时调,
   * controller 重置 fired 阈值 (compact 后 context 又有空间, 可重新触发)。
   * 缺省 = 不回调 (makerMemoryEnabled 关时 agent 不注入)。
   */
  onCompactBoundary?: () => void;
  /**
   * 服务过载错误的重投接管钩子 (由 agent 层注入)。
   *
   * 返回进度 = agent 层已排好退避重投, 这条错误必须透成**非终止**状态并带上
   * 进度; 否则 UI 会先收口成失败再重投, 用户看到一次假失败闪烁。返回 null =
   * 没有重投预算或不满足重投条件, 按原路径当终止错误报。
   *
   * 分工原因: 能否重投只有 agent 层知道 (要看本 turn 有没有产出、预算还剩多少、
   * 会话是否已关), 而错误脱敏与 error 事件构造在 translator。缺省 = 不接管。
   */
  tryTakeOverOverload?: () => { attempt: number; maxAttempts: number } | null;
}

// ── 主入口: 三个 item.* notification 的统一分发 ────────────────────────────────

type ItemPhase = 'started' | 'updated' | 'completed';

export function translateItemNotification(
  phase: ItemPhase,
  notification:
    | ItemStartedNotification['params']
    | ItemUpdatedNotification['params']
    | ItemCompletedNotification['params'],
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const item = notification.item;
  if (!item || typeof item !== 'object') {
    ctx.log.warn('item notification missing item field', { phase });
    return;
  }
  const itemType = (item as { type?: unknown }).type;
  if (typeof itemType !== 'string') {
    ctx.log.warn('item missing type field', { phase, itemKeys: Object.keys(item) });
    return;
  }

  switch (itemType) {
    case 'agentMessage':
      handleAgentMessage(phase, item as unknown as AgentMessageItem, queue, ctx);
      return;
    case 'reasoning':
      handleReasoning(phase, item as unknown as ReasoningItem, queue, ctx);
      return;
    case 'commandExecution':
      handleCommandExecution(phase, item as unknown as CommandExecutionItem, queue, ctx);
      return;
    case 'mcpToolCall':
      handleMcpToolCall(phase, item as unknown as McpToolCallItem, queue, ctx);
      return;
    case 'dynamicToolCall':
      handleDynamicToolCall(phase, item as unknown as DynamicToolCallItem, queue, ctx);
      return;
    case 'collabAgentToolCall':
      handleCollabAgentToolCall(phase, item as unknown as CollabAgentToolCallItem, queue, ctx);
      return;
    case 'webSearch':
      handleWebSearch(phase, item as unknown as WebSearchItem, queue, ctx);
      return;
    case 'fileChange':
      handleFileChange(phase, item as unknown as FileChangeItem, queue, ctx);
      return;
    case 'plan':
      handlePlan(phase, item as unknown as PlanItem, queue, ctx);
      return;
    case 'imageView':
      handleImageView(phase, item as unknown as ImageViewItem, queue);
      return;
    case 'imageGeneration':
      handleImageGeneration(phase, item as unknown as ImageGenerationItem, queue);
      return;
    case 'contextCompaction':
      handleContextCompaction(phase, item as unknown as ContextCompactionItem, queue, ctx);
      return;
    // 以下 v2 item 类型故意不消费 (无 UI 对应概念, 不是 bug):
    //   userMessage:  SDK echo 用户输入, claude-code translator 也只挑 tool_result 包装的
    //   hookPrompt:   codex 用户配置 hook 注入的 prompt, UI 不展示
    //   enteredReviewMode / exitedReviewMode: codex review 子模式开关, maker 端无 review 概念
    case 'userMessage':
    case 'hookPrompt':
    case 'enteredReviewMode':
    case 'exitedReviewMode':
      return;
    default:
      ctx.log.warn('unhandled item type', { phase, itemType });
      return;
  }
}

/**
 * auth 缺失 (401/Unauthorized/Missing bearer) 判定 — daemon 怎么 retry 也不可能
 * 自愈, 必须用户介入。收紧 pattern: 避开非 HTTP-auth 错误误伤 (eg. 工具执行报错
 * "Unauthorized file system access" 含 Unauthorized 字面但不是 401)。要求带
 * \b401\b 边界, 或 Missing bearer 精确短语 (OpenAI 401 message 标准措辞)。
 *
 * 从 translateErrorNotification 抽出成 export — codex/index.ts 的 retry 升级
 * 逻辑要排除这一类 (auth 缺失走自己「同步登录态」的等待式 UX, 不应被升级成
 * 终态 backend-unreachable)。
 */
export function isAuthMissingErrorMessage(message: string, errorStatus?: number): boolean {
  return errorStatus === 401 || /\b401\b|Missing bearer/i.test(message);
}

/**
 * auth 相关错误 (缺失 OR 无效) 的更宽判定 — translator 会把
 * authentication_error / authentication_failed / invalid_api_key /
 * api key not valid 这些 marker 同样推断成 errorStatus=401 走 auth UX
 * (translateErrorNotification 的 hasAuthErrorMarker)。retry-loop 升级判定
 * 必须排除同一集合, 否则这些真 auth 错误会被升级成「后端不可达」终态,
 * 抢走 auth 修复路径并误导排查方向 (review: PR #715 五轮审核 P1)。
 *
 * 与 isAuthMissingErrorMessage 的分工: Missing 版只认「没给凭证」
 * (401 / Missing bearer), 用于触发「同步登录态」等待式 UX; Related 版
 * 额外认「凭证无效」类 marker, 只用于「不要按网络不可达处理」的排除判断。
 */
export function isAuthRelatedErrorMessage(message: string, errorStatus?: number): boolean {
  if (isAuthMissingErrorMessage(message, errorStatus)) return true;
  return /\bauthentication_(?:error|failed)\b|\binvalid[\s_-]*api[\s_-]*key\b|\bapi key not valid\b/i
    .test(message);
}

/** error notification (顶层非 item.*) → AgentEvent error。 */
export function translateErrorNotification(
  params: ErrorNotification['params'],
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const message = params.error?.message ?? 'codex error';
  const hasMissingBearer = /\bMissing bearer\b/i.test(message);
  const hasAuthErrorMarker =
    /\bauthentication_(?:error|failed)\b|\binvalid[\s_-]*api[\s_-]*key\b|\bapi key not valid\b/i.test(
      message,
    );
  const safeMessage = redactSensitiveText(message);
  const signals = extractNonSecretErrorSignals(message);
  const errorStatus =
    signals.errorStatus ?? (hasMissingBearer || hasAuthErrorMarker ? 401 : undefined);
  // 结构化错误标识。过载判定优先吃它(见下方 capacity 分支), 同时透出到 error data
  // 供诊断与下游归因。**不参与上面的 errorStatus 推断** —— 那条链路上挂着
  // renderer 的 401 banner 与 auth 修复 UX, 改推断依据会连带改这些行为。
  const errorInfoTag = codexErrorInfoTag(params.error?.codexErrorInfo);
  const safeErrorData = {
    message: safeMessage,
    ...(errorStatus !== undefined ? { errorStatus } : {}),
    ...(signals.usageLimit ? { usageLimit: true } : {}),
    ...(errorInfoTag !== undefined ? { codexErrorInfo: errorInfoTag } : {}),
  };
  // willRetry=true 的暂时错误 (transient API blip / 5xx blip), server 自己会重试 — 默认
  // 不 emit error event 给 UI,否则会把瞬时错误暴露成用户可见失败。**但** auth 缺失
  // (401/Unauthorized/Missing bearer) 是 daemon 怎么 retry 也不可能自愈的 —— 必须
  // 用户介入 (同步 auth 把 auth.json 推到远端 + 重启 daemon) 才能恢复。这种情况下
  // 不 emit 用户就看不到任何错误,turn 在 daemon retry-loop 里永远 hang。让 error
  // 透出来并标记 isTerminal=false → renderer 端 ErrorBanner 的 401 识别会触发 →
  // 显示「同步登录态」button；main 端 active-turn keepalive 继续保持,等待 daemon
  // retry 或用户修复登录态后的后续事件。
  const isAuthMissing = isAuthMissingErrorMessage(safeMessage, errorStatus);
  if (params.willRetry && !isAuthMissing) {
    ctx.log.warn('codex error (will retry)', { message: safeMessage, threadId: params.threadId, turnId: params.turnId });
    // Codex 自带明确的有限重连进度时，每档都透出，让 UI 从 1/5 持续更新到 5/5。
    // 这是非终止状态：turn 仍由 app-server 继续，不结束也不另起一次不安全的请求重放。
    if (parseReconnectAttemptMessage(safeMessage)) {
      queue.push({
        type: 'error',
        data: { ...safeErrorData, isTerminal: false, willRetry: true },
        source: 'codex',
      });
      return;
    }
    // 持续重试的错误 = daemon 卡在 retry-loop 里 turn 无限转圈。同 turn 第 2 次时
    // 透出**一条**非终止提示 (isTerminal:false, renderer 走 recoverableError →
    // "正在自动重试…" banner, 恢复后随正常事件自动清; 不结束 turn、不落 error 行)。
    // 第 1 次不透出: 单次抖动 daemon 一次重试就过, 提示只会闪一下徒增噪音。
    //
    // 不限定 networkish pattern (issue #677): 远端后端不可达的典型文案
    // ("unexpected status 403 Forbidden" / "failed to connect to websocket:
    // Network unreachable") 不命中 networkish, 但同样是「daemon 在空转」的信号,
    // 用户必须看得到。终局收口由 codex/index.ts 的 TurnRetryTracker 升级负责。
    const key = `${params.threadId ?? ''}|${params.turnId ?? ''}`;
    const notice = ctx.rt.networkRetryNotice;
    const count = notice?.key === key ? notice.count + 1 : 1;
    const emitted = notice?.key === key ? notice.emitted : false;
    ctx.rt.networkRetryNotice = { key, count, emitted };
    if (count >= 2 && !emitted) {
      ctx.rt.networkRetryNotice = { key, count, emitted: true };
      queue.push({
        type: 'error',
        data: { ...safeErrorData, isTerminal: false, willRetry: true },
        source: 'codex',
      });
    }
    return;
  }
  // willRetry=true 且 auth 缺失: daemon 401 retry-loop 会按重试频率 (~每秒) 持续发,
  // 不 dedupe 会让下游 (makerChatStore case 'error' 走 refreshApiKeyFromServer +
  // 结构化 error log + banner surface) 全跟着触发风暴。按 threadId+turnId 做 per-turn
  // dedupe: 同 turn 内同样的 auth retry 只 emit 第一条; turnStarted 时 rt.lastAuthErrorKey
  // reset, 下一个 turn 可以再 emit 一次。willRetry=false 不 dedupe (本来就是一次性升级)。
  if (params.willRetry && isAuthMissing) {
    const key = `${params.threadId ?? ''}|${params.turnId ?? ''}`;
    if (ctx.rt.lastAuthErrorKey === key) {
      ctx.log.debug('codex auth retry-loop dropped (already surfaced this turn)', { message: safeMessage, threadId: params.threadId, turnId: params.turnId });
      return;
    }
    ctx.rt.lastAuthErrorKey = key;
  }
  // 服务过载 (`Selected model is at capacity`): OpenAI 侧不重试就把 turn 判死,
  // 由 agent 层接管退避重投。接管成功时透成非终止状态并带进度后缀, renderer
  // 显示"模型繁忙, 正在重试 (N/M)"; 预算耗尽或条件不满足 (本 turn 已有产出)
  // 时 tryTakeOverOverload 返回 null, 落回下面的终止错误路径。
  const isCapacityError =
    parseOverloadError(safeMessage, signals.errorStatus, errorInfoTag)?.kind === 'capacity';
  // 过载错误一律带上稳定 reason key。renderer 隔着 IPC 投影拿不到 codexErrorInfo,
  // 靠这个 key 判定"是否过载"(ErrorBanner 的本地化文案 + 重试进度 + hideRetry 都由它
  // 驱动)。不带的话 renderer 只能回退到文案匹配 —— codex 改一次措辞, 用户就会在整段
  // 重试窗口里看到英文原文, 也就是本次改动要消除的那个依赖在 UI 侧原样残留。
  const overloadReason = isCapacityError ? { reason: UPSTREAM_OVERLOAD_REASON } : {};
  if (!params.willRetry && isCapacityError) {
    const progress = ctx.tryTakeOverOverload?.();
    if (progress) {
      queue.push({
        type: 'error',
        data: {
          ...safeErrorData,
          ...overloadReason,
          message: formatOverloadRetryMessage(safeMessage, progress.attempt, progress.maxAttempts),
          isTerminal: false,
          willRetry: true,
        },
        source: 'codex',
      });
      return;
    }
  }
  ctx.log.warn('codex turn error', { message: safeMessage, willRetry: params.willRetry, isAuthMissing, threadId: params.threadId, turnId: params.turnId });
  queue.push({
    type: 'error',
    data: {
      ...safeErrorData,
      ...overloadReason,
      isTerminal: !params.willRetry,
      willRetry: params.willRetry,
    },
    source: 'codex',
  });
}

export function translatePlanUpdatedNotification(
  params: TurnPlanUpdatedNotification['params'],
  queue: AsyncQueue<AgentEvent>,
): void {
  queue.push({
    type: 'tool_use',
    data: {
      toolUseId: `plan:${params.turnId}`,
      toolName: 'update_plan',
      input: {
        ...(params.explanation ? { explanation: params.explanation } : {}),
        plan: params.plan,
      },
    },
    source: 'codex',
  });
}

interface RolloutUpdatePlanFunctionCall {
  type: 'function_call';
  name: 'update_plan';
  call_id?: string;
  arguments?: string;
  internal_chat_message_metadata_passthrough?: {
    turn_id?: string;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseRolloutUpdatePlanFunctionCall(entry: unknown): RolloutUpdatePlanFunctionCall | null {
  const record = asRecord(entry);
  if (!record) return null;
  const payload = asRecord(record.payload);
  const item = payload?.type === 'function_call' ? payload : record;
  if (item.type !== 'function_call' || item.name !== 'update_plan') return null;
  return item as unknown as RolloutUpdatePlanFunctionCall;
}

/**
 * Codex app-server currently writes `update_plan` to rollout as a response
 * function_call even when no `turn/plan/updated` notification is emitted.
 * This narrow fallback translates only that exact rollout item shape.
 */
export function translateRolloutUpdatePlanFunctionCall(
  entry: unknown,
  queue: AsyncQueue<AgentEvent>,
  fallbackTurnId?: string,
  opts?: { requireTurnId?: boolean },
): { callId: string | null; turnId: string | null } | null {
  const parsed = extractRolloutUpdatePlanFunctionCallEvent(entry, fallbackTurnId, opts);
  if (!parsed) return null;
  queue.push(parsed.event);
  return { callId: parsed.callId, turnId: parsed.turnId };
}

export function extractRolloutUpdatePlanFunctionCallEvent(
  entry: unknown,
  fallbackTurnId?: string,
  opts?: { requireTurnId?: boolean },
): { event: AgentEvent; callId: string | null; turnId: string | null } | null {
  const item = parseRolloutUpdatePlanFunctionCall(entry);
  if (!item) return null;
  const turnId = item.internal_chat_message_metadata_passthrough?.turn_id ?? fallbackTurnId ?? null;
  if (opts?.requireTurnId && !turnId) return null;
  let input: Record<string, unknown>;
  try {
    const parsed = item.arguments ? JSON.parse(item.arguments) as unknown : {};
    input = asRecord(parsed) ?? { text: String(item.arguments ?? '') };
  } catch {
    input = { text: String(item.arguments ?? '') };
  }
  return {
    event: {
      type: 'tool_use',
      data: {
        toolUseId: turnId ? `plan:${turnId}` : `plan-call:${item.call_id ?? 'unknown'}`,
        toolName: 'update_plan',
        input,
      },
      source: 'codex',
    },
    callId: item.call_id ?? null,
    turnId,
  };
}

// ── ThreadItem 局部类型 (字段最小集, 对齐 v2.rs) ────────────────────────────

interface AgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
}

interface ReasoningItem {
  type: 'reasoning';
  id: string;
  /** v2: summary 是数组 (每条独立段落), 对外 join 成单一文本流。 */
  summary?: string[];
  /** v2: content 是数组 (内部 reasoning, 通常 OpenAI 不返还原文)。 */
  content?: string[];
}

type CommandExecutionStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

interface CommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd?: string;
  status: CommandExecutionStatus;
  /**
   * codex 侧 parse_command 的确定性解析产物（read / listFiles / search /
   * unknown,管道命令拆多项）。原样透传进 tool_use input,供 maker-shared
   * `describeToolUse` 生成人话意图（issue #450）;本层不消费不加工。
   */
  commandActions?: unknown[];
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

function commandExecutionInput(item: CommandExecutionItem): CommandExecutionDisplayInput {
  const input = commandExecutionDisplayInput(item.command, item.cwd);
  // 引用透传,零拷贝零加工 —— 热路径上不增加任何处理成本(规则 10)。
  if (Array.isArray(item.commandActions) && item.commandActions.length > 0) {
    input.commandActions = item.commandActions;
  }
  return input;
}

type McpToolCallStatus = 'inProgress' | 'completed' | 'failed';

interface McpToolCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  _meta?: unknown;
}

interface McpToolCallItem {
  type: 'mcpToolCall';
  id: string;
  server: string;
  tool: string;
  status: McpToolCallStatus;
  arguments?: unknown;
  result?: McpToolCallResult | null;
  error?: { message?: string; [k: string]: unknown } | null;
}

type WebSearchAction =
  | { type: 'search'; query?: string | null; queries?: string[] | null }
  | { type: 'open_page' | 'openPage'; url?: string | null }
  | { type: 'find_in_page' | 'findInPage'; url?: string | null; pattern?: string | null }
  | { type: string; [k: string]: unknown };

interface WebSearchItem {
  type: 'webSearch';
  id: string;
  query: string;
  action?: WebSearchAction | null;
}

interface WebSearchInput {
  query: string;
  action?: WebSearchAction;
}

type PatchApplyStatus = 'inProgress' | 'completed' | 'failed' | 'declined';
type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; [k: string]: unknown } | { type: string; [k: string]: unknown };

interface FileUpdateChange {
  path: string;
  kind: PatchChangeKind;
  diff: string;
}

interface FileChangeItem {
  type: 'fileChange';
  id: string;
  changes: FileUpdateChange[];
  status: PatchApplyStatus;
}

// v2.rs ThreadItem::Plan { id, text } — EXPERIMENTAL "proposed plan item content"。
// 单条 step 文本, codex 不一定按 started/updated/completed 全发。started/updated 先把
// 当前计划推给 UI，completed 再补 full/result 让历史详情有最终文本。
interface PlanItem {
  type: 'plan';
  id: string;
  text: string;
}

// v2.rs ThreadItem::DynamicToolCall — codex 自己 router 的"动态注册工具"
//   namespace + tool 拼出 toolName; arguments 透传; completed 给 contentItems 拼 fullText。
type DynamicToolCallStatus = 'inProgress' | 'completed' | 'failed';
type DynamicToolCallContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string }
  | { type: string; [k: string]: unknown };

interface DynamicToolCallItem {
  type: 'dynamicToolCall';
  id: string;
  namespace?: string | null;
  tool: string;
  arguments?: unknown;
  status: DynamicToolCallStatus;
  contentItems?: DynamicToolCallContentItem[] | null;
  success?: boolean | null;
  durationMs?: number | null;
}

// v2.rs ThreadItem::CollabAgentToolCall — codex 多 agent 协作 (spawn/sendInput/resume/wait/close)
//   tool enum 用 toolName 后缀; receiverThreadIds + agentsStates 进 input/result 透传给 UI 排查用。
type CollabAgentTool = 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent';
type CollabAgentToolCallStatus = 'inProgress' | 'completed' | 'failed';

interface CollabAgentToolCallItem {
  type: 'collabAgentToolCall';
  id: string;
  tool: CollabAgentTool;
  status: CollabAgentToolCallStatus;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  agentsStates: Record<string, unknown>;
}

// v2.rs ThreadItem::ImageView { id, path } — 模型读图 (本地绝对路径)。
interface ImageViewItem {
  type: 'imageView';
  id: string;
  path: string;
}

// v2.rs ThreadItem::ImageGeneration — 模型生成图; result 是 url/data URL, savedPath 落盘后才有。
interface ImageGenerationItem {
  type: 'imageGeneration';
  id: string;
  status: string;
  revisedPrompt?: string | null;
  result: string;
  savedPath?: string | null;
}

// v2.rs ThreadItem::ContextCompaction { id } — codex auto-compact 边界 (协议没给 token / duration)。
interface ContextCompactionItem {
  type: 'contextCompaction';
  id: string;
}

// ── agentMessage → text {isFinal} ───────────────────────────────────────────
// item.started / item.updated 出 delta (isFinal=false), item.completed 出 final 全文。
// Phase 1 没订阅 item/agentMessage/delta, 增量靠 item.updated 的 text 全量字段算 diff。

/**
 * Codex 正文里的内部文件引用标记 `:codex-file-citation{path="..." ...}`——对用户
 * 是不可读的内部语法,归一化成行内代码的文件路径。没有 path 属性的畸形标记整个
 * 剥掉,不把内部语法漏给用户。
 */
// 属性区 = 「非引号非花括号字符 或 双引号串」的序列:双引号串内允许出现 { } ,
// 且支持反斜杠转义(\" 表示文件名里的引号)——路径含花括号 / 引号都不会让标记
// 匹配失败而把内部语法漏给用户。
const CODEX_FILE_CITATION_RE = /:codex-file-citation\{((?:[^"{}]|"(?:[^"\\]|\\.)*")*)\}/g;
const CODEX_FILE_CITATION_OPEN = ':codex-file-citation{';

/**
 * 路径包成 Markdown 行内代码:围栏取「比路径内最长反引号连跑多一个」的反引号数,
 * 路径以反引号开头/结尾时按 CommonMark 规则两侧补空格——路径自身含反引号也不会
 * 把 code span 撑破。
 */
function inlineCodePath(path: string): string {
  const longestRun = path.match(/`+/g)?.reduce((max, run) => Math.max(max, run.length), 0) ?? 0;
  const fence = '`'.repeat(longestRun + 1);
  // 补空格垫的两种情形:路径以反引号开头/结尾(隔开围栏),或首尾都是空格且非全空格
  // (CommonMark 渲染器对这种 code span 会各剥一个空格,不垫会把真实路径的首尾空白
  // 剥掉指向别的文件;单侧空格渲染器不剥,不垫)。
  const symmetricSpace = path.startsWith(' ') && path.endsWith(' ') && path.trim().length > 0;
  const pad = path.startsWith('`') || path.endsWith('`') || symmetricSpace ? ' ' : '';
  return `${fence}${pad}${path}${pad}${fence}`;
}

export function normalizeCodexFileCitations(text: string): string {
  if (!text.includes(CODEX_FILE_CITATION_OPEN)) return text;
  return text.replace(CODEX_FILE_CITATION_RE, (_all, attrs: string) => {
    const path = extractCitationPath(attrs);
    return path ? inlineCodePath(path) : '';
  });
}

/**
 * 属性区取 path 值并解码。
 * - 属性名要求完整边界(串首或空白后的 `path=`):`display_path=` 这类「以 path 结尾」
 *   的别名不当作 path,也不遮蔽其后真正的 path 属性(review 反馈)。
 * - 只解 \" 与 \\ 两种转义——Windows 原生路径(C:\Users\...)里的反斜杠不是转义
 *   前缀,全量 \\(.) 反转义会把路径毁成 C:Users...(review 反馈)。
 * - UNC 前缀:开头**恰好两个**反斜杠视为原生 UNC 本体整体保留(\\server\share);
 *   更长的开头连跑(如转义形态 \\\\server)与其余位置按转义对解码,转义 UNC 解出
 *   恰好两个分隔符(review 反馈)。
 * - 取出后不做 trim——文件名首尾空白是路径的一部分,悄悄改写会指向另一个文件。
 */
function extractCitationPath(attrs: string): string | undefined {
  const raw = /(?:^|\s)path="((?:[^"\\]|\\.)*)"/.exec(attrs)?.[1];
  if (raw === undefined) return undefined;
  const nativeUnc = raw.startsWith('\\\\') && raw[2] !== '\\';
  const head = nativeUnc ? '\\\\' : '';
  const tail = (nativeUnc ? raw.slice(2) : raw).replace(/\\([\\"])/g, '$1');
  return head + tail;
}

// 闭合扫描的两种「未找到」:UNFINISHED = 扫描到文本末尾仍未闭合(可能是尚未写完、
// 会被后续 update 补全的截断尾巴);POISONED = 属性区出现裸 `{`,正则永不匹配,该
// 标记已确定畸形且追加文本也不会改变这一判定。
const CITATION_UNFINISHED = -1;
const CITATION_POISONED = -2;

/**
 * 属性区闭合 `}` 的位置(与 CODEX_FILE_CITATION_RE 同一口径:双引号串内的花括号
 * 不算边界);找不到时区分 CITATION_UNFINISHED 与 CITATION_POISONED。
 */
function findCitationClose(text: string, attrsStart: number): number {
  let inQuote = false;
  for (let i = attrsStart; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuote && ch === '\\') {
      i += 1; // 引号串内的转义对(如 \")整体跳过,与正则同口径。
    } else if (ch === '"') {
      inQuote = !inQuote;
    } else if (!inQuote && ch === '}') {
      return i;
    } else if (!inQuote && ch === '{') {
      return CITATION_POISONED;
    }
  }
  return CITATION_UNFINISHED;
}

/**
 * 从左到右结构化扫描,返回第一个「扫描到文本末尾仍未闭合」的标记开头;没有 → -1。
 * 完整标记整体跳过——路径引号串里出现的 OPEN 字面量属于已消费标记的内部,不会被
 * 误认成新的开头(review 反馈:文件名本身含 `:codex-file-citation{` 时,按最后一个
 * 裸字面量定位会带着错误的引号状态把完整标记判成未完成)。裸 `{` 的畸形标记(正则
 * 永不匹配、追加文本也救不回来)原样透出:只跳过开头字面量继续扫,不吞它后面的正文。
 */
function findUnfinishedCitationOpen(text: string): number {
  let from = 0;
  for (;;) {
    const open = text.indexOf(CODEX_FILE_CITATION_OPEN, from);
    if (open === -1) return -1;
    const close = findCitationClose(text, open + CODEX_FILE_CITATION_OPEN.length);
    if (close === CITATION_UNFINISHED) return open;
    from = close === CITATION_POISONED ? open + CODEX_FILE_CITATION_OPEN.length : close + 1;
  }
}

/**
 * 流式安全边界:全量文本尾部可能是一个尚未写完的 citation 标记(标记会被后续
 * update 补全),归一化后的文本对这段尾巴不是 append-only。返回可安全发出的原文
 * 前缀长度,未写完的尾巴按住等下一轮;completed 时全量补发,不丢内容。
 */
/**
 * final 文本统一口径(流式 completed 与历史 rollout 导入共用):先剥「扫描到文本
 * 末尾仍未闭合」的确定截断残尾(它之后没有正文可吞),再做 citation 归一化。
 * 契约:只做 raw→final 的**单次**转换(两个调用点都满足)。无标记文本原样返回,
 * 但展示形不承诺严格幂等——路径本身解码出完整标记字面量的极端文件名,二次处理
 * 会把生成的 code span 内容再替换;去重指纹因此不复用展示形,走独立的不动点
 * 规范形(见 localDb worker 的 canonicalizeCodexCitations)。
 */
export function finalizeCodexCitationText(text: string): string {
  const openAt = findUnfinishedCitationOpen(text);
  return normalizeCodexFileCitations(openAt === -1 ? text : text.slice(0, openAt));
}

export function stableCitationBoundary(text: string): number {
  const open = findUnfinishedCitationOpen(text);
  if (open !== -1) {
    return open;
  }
  const maxProbe = Math.min(text.length, CODEX_FILE_CITATION_OPEN.length - 1);
  for (let k = maxProbe; k > 0; k -= 1) {
    if (text.endsWith(CODEX_FILE_CITATION_OPEN.slice(0, k))) return text.length - k;
  }
  return text.length;
}

function handleAgentMessage(
  phase: ItemPhase,
  item: AgentMessageItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const rawText = item.text ?? '';
  // itemTextLen 记录的是**归一化后已发出**的长度:citation 替换会改变文本长度,
  // diff 必须在归一化空间里做,不能混用原文长度。
  const prevLen = ctx.rt.itemTextLen.get(item.id) ?? 0;

  if (phase === 'completed') {
    ctx.rt.itemTextLen.delete(item.id);
    // 既有契约:completed 只出 final 全文、不补 delta(desktop codexTranslator.test
    // 钉死 3 事件形状)。boundary 按住的尾段与「completed 才首次出现的文本」同一待遇:
    // 不进 delta 流,由 final 全文兜底(main 落库层 onAssistantTextEvent 的 isFinal
    // 分支以更长 final 覆盖 delta 累积,不丢内容)。
    // 输出被截断在标记中间(有明确的 open、永远等不到 close)时,把残尾剥掉——
    // 内部语法不该漏给用户;只剥「扫描到文本末尾仍未闭合」的确定截断残尾(它之后
    // 没有正文可吞),疑似前缀(不足完整 open 字面量)可能是真实正文,保留。
    // finalizeCodexCitationText 是与历史导入共用的统一口径。
    queue.push({
      type: 'text',
      data: { text: finalizeCodexCitationText(rawText), isFinal: true },
      source: 'codex',
    });
    return;
  }

  const emitted = normalizeCodexFileCitations(rawText.slice(0, stableCitationBoundary(rawText)));
  const delta = emitted.slice(prevLen);
  ctx.rt.itemTextLen.set(item.id, emitted.length);
  if (delta.length === 0) return;
  queue.push({
    type: 'text',
    data: { text: delta, isFinal: false },
    source: 'codex',
  });
}

// ── reasoning → thinking {stage} ─────────────────────────────────────────────
// v2 reasoning 是 { summary: string[], content: string[] } 两路文本数组。
// 对外当成单一文本流: 优先用 summary (OpenAI 实际填的字段), content 备选。
// summary.length=0 时整个 reasoning 不显示 (与 displayReasoning='off' 一致)。

function joinReasoningText(item: ReasoningItem): string {
  if (item.summary && item.summary.length > 0) return item.summary.join('\n\n');
  if (item.content && item.content.length > 0) return item.content.join('\n\n');
  return '';
}

// 不变式 (用户 A 决定): reasoning 全程无文本时, **不创建** thinking block —
// 不 emit start / delta / final 任何一项, renderer 也就不显示空卡片。
// reasoningStartedAt.has(item.id) 即等价于 "已 emit start", 用作"是否已建块"标志。

function handleReasoning(
  phase: ItemPhase,
  item: ReasoningItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const text = joinReasoningText(item);

  if (phase === 'started') {
    if (text.length === 0) return; // 文本为空, 暂不建块, 等 delta / completed 真有内容再说
    ensureReasoningStarted(item.id, queue, ctx);
    ctx.rt.reasoningTextLen.set(item.id, text.length);
    queue.push({
      type: 'thinking',
      data: { stage: 'delta', blockId: item.id, text },
      source: 'codex',
    });
    return;
  }

  if (phase === 'updated') {
    const prevLen = ctx.rt.reasoningTextLen.get(item.id) ?? 0;
    const delta = text.slice(prevLen);
    if (delta.length === 0) return;
    ensureReasoningStarted(item.id, queue, ctx);
    ctx.rt.reasoningTextLen.set(item.id, text.length);
    queue.push({
      type: 'thinking',
      data: { stage: 'delta', blockId: item.id, text: delta },
      source: 'codex',
    });
    return;
  }

  // completed: 无内容且无前置 emit → 整段静默丢弃 (用户 A: 不显示空 thinking 卡片)
  const alreadyStarted = ctx.rt.reasoningStartedAt.has(item.id);
  if (text.length === 0 && !alreadyStarted) return;
  if (!alreadyStarted) ensureReasoningStarted(item.id, queue, ctx); // 文本只在 completed 才出 (罕见)
  const startedAt = ctx.rt.reasoningStartedAt.get(item.id) ?? Date.now();
  const durationMs = Date.now() - startedAt;
  ctx.rt.reasoningStartedAt.delete(item.id);
  ctx.rt.reasoningTextLen.delete(item.id);
  queue.push({
    type: 'thinking',
    data: { stage: 'final', blockId: item.id, text, durationMs },
    source: 'codex',
  });
}

// ── reasoning delta 流 → thinking {stage:'delta'} ─────────────────────────────
// 三个 v2 notification 拆开消费 (item/started 不一定先到, delta 内部兜底 lazy-init
// 跟 claude-code translator handleStreamEvent thinking_delta 一样)。
//
// 累积语义 (server 端 v2.rs::ReasoningSummaryTextDeltaNotification 注释 + event_mapping.rs):
//   summaryPartAdded(idx=N)        → summary 数组里开第 N 段
//   summaryTextDelta(idx=N, txt)   → 追加 txt 到第 N 段
//   item/completed                 → emit thinking final 全文 (renderer 用全文 overwrite 校准)
//
// 我们这里的事件流:
//   summaryPartAdded(idx=0)          → 不发 (起始段, 不需要分隔符)
//   summaryPartAdded(idx>0)          → push thinking delta '\n\n' (段间分隔)
//   summaryTextDelta(_, delta)       → push thinking delta delta
//   textDelta(_, delta)              → 同 summaryTextDelta (raw 内容流)
//
// renderer (makerChatStore thinking case) 的行为:
//   delta = append, final = overwrite — 即便 delta 顺序乱了, final 全文也会校准。

/** delta 流的统一兜底: rt.reasoningStartedAt 没记过就 lazy-init + 发 thinking start。 */
function ensureReasoningStarted(
  itemId: string,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  if (ctx.rt.reasoningStartedAt.has(itemId)) return;
  const startedAt = Date.now();
  ctx.rt.reasoningStartedAt.set(itemId, startedAt);
  ctx.rt.reasoningTextLen.set(itemId, 0);
  queue.push({
    type: 'thinking',
    data: { stage: 'start', blockId: itemId, startedAt },
    source: 'codex',
  });
}

export function translateReasoningSummaryTextDelta(
  params: ReasoningSummaryTextDeltaNotification['params'],
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  if (!params.delta) return;
  ensureReasoningStarted(params.itemId, queue, ctx);
  const prevLen = ctx.rt.reasoningTextLen.get(params.itemId) ?? 0;
  ctx.rt.reasoningTextLen.set(params.itemId, prevLen + params.delta.length);
  queue.push({
    type: 'thinking',
    data: { stage: 'delta', blockId: params.itemId, text: params.delta },
    source: 'codex',
  });
}

export function translateReasoningSummaryPartAdded(
  params: ReasoningSummaryPartAddedNotification['params'],
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  // idx=0: 起始段, 无前置内容也无分隔符 — no-op (不预建空块, 等首条 textDelta 才 lazy-emit start)
  if (params.summaryIndex === 0) return;
  // idx>0 段间分隔符: 仅在已有内容 (start 已 emit) 时才插, 否则跳过 (避免空块)
  if (!ctx.rt.reasoningStartedAt.has(params.itemId)) return;
  const prevLen = ctx.rt.reasoningTextLen.get(params.itemId) ?? 0;
  ctx.rt.reasoningTextLen.set(params.itemId, prevLen + 2);
  queue.push({
    type: 'thinking',
    data: { stage: 'delta', blockId: params.itemId, text: '\n\n' },
    source: 'codex',
  });
}

export function translateReasoningTextDelta(
  params: ReasoningTextDeltaNotification['params'],
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  if (!params.delta) return;
  ensureReasoningStarted(params.itemId, queue, ctx);
  const prevLen = ctx.rt.reasoningTextLen.get(params.itemId) ?? 0;
  ctx.rt.reasoningTextLen.set(params.itemId, prevLen + params.delta.length);
  queue.push({
    type: 'thinking',
    data: { stage: 'delta', blockId: params.itemId, text: params.delta },
    source: 'codex',
  });
}

// ── commandExecution → tool_use + tool_result_full + tool_result ─────────────

function handleCommandExecution(
  phase: ItemPhase,
  item: CommandExecutionItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const input = commandExecutionInput(item);

  if (phase === 'started') {
    if (ctx.rt.emittedToolUse.has(item.id)) return;
    ctx.rt.emittedToolUse.add(item.id);
    queue.push({
      type: 'tool_use',
      data: {
        toolUseId: item.id,
        toolName: 'exec',
        input,
      },
      source: 'codex',
    });
    return;
  }

  if (phase === 'updated') {
    if (!ctx.rt.emittedToolUse.has(item.id)) {
      ctx.rt.emittedToolUse.add(item.id);
      queue.push({
        type: 'tool_use',
        data: {
          toolUseId: item.id,
          toolName: 'exec',
          input,
        },
        source: 'codex',
      });
    }
    return;
  }

  // completed
  const execEmitted = ctx.rt.emittedToolUse.has(item.id);
  ctx.rt.emittedToolUse.delete(item.id);
  if (!execEmitted) {
    queue.push({
      type: 'tool_use',
      data: {
        toolUseId: item.id,
        toolName: 'exec',
        input,
      },
      source: 'codex',
    });
  }
  const isError = item.status === 'failed' || item.status === 'declined';
  queue.push({
    type: 'tool_result_full',
    data: {
      toolUseId: item.id,
      fullText: stripTerminalControlSequences(item.aggregatedOutput ?? ''),
      isError,
    },
    source: 'codex',
  });
  const exitLabel = item.exitCode != null ? `Exit ${item.exitCode}` : item.status;
  queue.push({
    type: 'tool_result',
    data: { summary: exitLabel, toolUseIds: [item.id] },
    source: 'codex',
  });
}

// ── mcpToolCall → tool_use + tool_result_full + tool_result ──────────────────

function handleMcpToolCall(
  phase: ItemPhase,
  item: McpToolCallItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const toolName = `mcp:${item.server}:${item.tool}`;

  if (phase === 'started') {
    if (ctx.rt.emittedToolUse.has(item.id)) return;
    ctx.rt.emittedToolUse.add(item.id);
    queue.push({
      type: 'tool_use',
      data: {
        toolUseId: item.id,
        toolName,
        input: (item.arguments as Record<string, unknown>) ?? {},
      },
      source: 'codex',
    });
    return;
  }

  if (phase === 'updated') {
    if (!ctx.rt.emittedToolUse.has(item.id)) {
      ctx.rt.emittedToolUse.add(item.id);
      queue.push({
        type: 'tool_use',
        data: { toolUseId: item.id, toolName, input: (item.arguments as Record<string, unknown>) ?? {} },
        source: 'codex',
      });
    }
    return;
  }

  // completed
  ctx.rt.emittedToolUse.delete(item.id);
  const isError = !!item.error;
  let fullText = '';
  if (item.error?.message) {
    fullText = item.error.message;
  } else if (item.result) {
    fullText = mcpToolCallResultToFullText(item.result);
  }
  queue.push({
    type: 'tool_result_full',
    data: { toolUseId: item.id, fullText, isError },
    source: 'codex',
  });
  queue.push({
    type: 'tool_result',
    data: { summary: isError ? 'failed' : item.status, toolUseIds: [item.id] },
    source: 'codex',
  });
}

function mcpToolCallResultToFullText(result: McpToolCallResult): string {
  const textParts = mcpContentTextParts(result.content);
  if (textParts.length > 0) return textParts.join('\n');

  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent, null, 2);
    } catch {
      return String(result.structuredContent);
    }
  }

  if (result.content !== undefined) {
    try {
      return JSON.stringify(result.content, null, 2);
    } catch {
      return String(result.content);
    }
  }

  return '';
}

function mcpContentTextParts(content: unknown[] | undefined): string[] {
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts;
}

// ── webSearch → tool_use + tool_result_full + tool_result ────────────────────
// v2 的 legacy query 可能为空，真实动作优先在 action 中；归一成 query 供现有
// maker-shared / Desktop / Mobile 展示链路消费，同时保留 action 供展开详情核验。

function nonEmptyWebSearchText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function quoteWebSearchText(value: string): string {
  return `'${value.replace(/['\\]/g, (char) => `\\${char}`)}'`;
}

function webSearchActionDetail(action: WebSearchAction | null | undefined): string {
  if (!action) return '';
  switch (action.type) {
    case 'search': {
      const query = nonEmptyWebSearchText(action.query);
      if (query) return query;
      const queries = Array.isArray(action.queries)
        ? action.queries.map(nonEmptyWebSearchText).filter(Boolean)
        : [];
      if (queries.length === 0) return '';
      return queries.length > 1 ? `${queries[0]} ...` : queries[0];
    }
    case 'open_page':
    case 'openPage':
      return nonEmptyWebSearchText(action.url);
    case 'find_in_page':
    case 'findInPage': {
      const url = nonEmptyWebSearchText(action.url);
      const pattern = nonEmptyWebSearchText(action.pattern);
      if (pattern && url) return `${quoteWebSearchText(pattern)} in ${url}`;
      if (pattern) return quoteWebSearchText(pattern);
      return url;
    }
    default:
      return '';
  }
}

function webSearchInput(
  item: WebSearchItem,
  actionDetail = webSearchActionDetail(item.action),
): WebSearchInput {
  const query = actionDetail || nonEmptyWebSearchText(item.query);
  return {
    query,
    ...(item.action ? { action: item.action } : {}),
  };
}

function rememberWebSearchInput(
  item: WebSearchItem,
  input: WebSearchInput,
  actionDetail: string,
  ctx: CodexTranslateContext,
): WebSearchInput {
  const pending = ctx.rt.pendingWebSearchInput.get(item.id);
  // 真实 action 优先级最高；在它到达前，保留最新的非空 legacy query 作为兜底。
  if (input.query && (actionDetail || !webSearchActionDetail(pending?.action))) {
    ctx.rt.pendingWebSearchInput.set(item.id, input);
    return input;
  }
  return pending ?? input;
}

function emitWebSearchToolUse(
  item: WebSearchItem,
  input: WebSearchInput,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  ctx.rt.emittedToolUse.add(item.id);
  ctx.rt.emittedWebSearchInput.set(item.id, input);
  queue.push({
    type: 'tool_use',
    data: {
      toolUseId: item.id,
      toolName: 'web_search',
      input,
    },
    source: 'codex',
  });
}

function handleWebSearch(
  phase: ItemPhase,
  item: WebSearchItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const actionDetail = webSearchActionDetail(item.action);
  const currentInput = webSearchInput(item, actionDetail);
  const input = rememberWebSearchInput(item, currentInput, actionDetail, ctx);

  if (phase === 'started') {
    if (ctx.rt.emittedToolUse.has(item.id)) return;
    // started 的 legacy query 可能为空或只是占位符，updated 才补真实 action；
    // 延迟到 action 到达或 completed，避免旧参数先落库后无法无损更新。
    if (!actionDetail) return;
    emitWebSearchToolUse(item, input, queue, ctx);
    return;
  }
  if (phase === 'updated') {
    if (ctx.rt.emittedToolUse.has(item.id) || !actionDetail) return;
    emitWebSearchToolUse(item, input, queue, ctx);
    return;
  }

  // completed
  const toolUseEmitted = ctx.rt.emittedToolUse.has(item.id);
  const emittedInput = ctx.rt.emittedWebSearchInput.get(item.id);
  ctx.rt.emittedToolUse.delete(item.id);
  ctx.rt.pendingWebSearchInput.delete(item.id);
  ctx.rt.emittedWebSearchInput.delete(item.id);
  // 防御缺失 started/updated 的历史或异常事件序列，保持 tool_use → result 顺序。
  if (!toolUseEmitted) {
    // completed 仍无可展示参数时整条忽略，避免补发空白 tool_use 和孤立 result。
    if (!input.query) return;
    emitWebSearchToolUse(item, input, queue, ctx);
    ctx.rt.emittedToolUse.delete(item.id);
    ctx.rt.emittedWebSearchInput.delete(item.id);
  } else if (input.query && JSON.stringify(input) !== JSON.stringify(emittedInput)) {
    // started/updated 用于实时展示；completed 可能补充权威 URL、pattern 或修正后的
    // query。沿用同一 toolUseId 补发，由 Desktop 持久层与 renderer 原位更新。
    emitWebSearchToolUse(item, input, queue, ctx);
    ctx.rt.emittedToolUse.delete(item.id);
    ctx.rt.emittedWebSearchInput.delete(item.id);
  }
  queue.push({
    type: 'tool_result_full',
    data: { toolUseId: item.id, fullText: '', isError: false },
    source: 'codex',
  });
  queue.push({
    type: 'tool_result',
    data: { summary: 'done', toolUseIds: [item.id] },
    source: 'codex',
  });
}

// ── fileChange → tool_use + tool_result_full + tool_result ───────────────────
// v2 不流式 patch (吞掉了 outputDelta), 只在 completed 时一次性出。

function handleFileChange(
  phase: ItemPhase,
  item: FileChangeItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  if (phase !== 'completed') return;
  void ctx;
  queue.push({
    type: 'tool_use',
    data: {
      toolUseId: item.id,
      toolName: 'file_change',
      input: { changes: item.changes },
    },
    source: 'codex',
  });
  const isError = item.status === 'failed' || item.status === 'declined';
  const summary = item.changes.map((c) => `${c.kind.type} ${c.path}`).join('\n');
  queue.push({
    type: 'tool_result_full',
    data: { toolUseId: item.id, fullText: summary, isError },
    source: 'codex',
  });
  queue.push({
    type: 'tool_result',
    data: {
      summary: `${item.changes.length} file(s) ${item.status}`,
      toolUseIds: [item.id],
    },
    source: 'codex',
  });
}

// ── plan → tool_use(update_plan) + tool_result_full + tool_result ────────────
// v2 Plan item EXPERIMENTAL: { id, text } 单条提案文本。started/updated 也 emit
// update_plan，让 renderer 的计划卡片能实时出现；completed 补 tool_result 作为历史详情。

function handlePlan(
  phase: ItemPhase,
  item: PlanItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  void ctx;
  queue.push({
    type: 'tool_use',
    data: {
      toolUseId: item.id,
      toolName: 'update_plan',
      input: { text: item.text },
    },
    source: 'codex',
  });
  if (phase !== 'completed') return;
  queue.push({
    type: 'tool_result_full',
    data: { toolUseId: item.id, fullText: item.text, isError: false },
    source: 'codex',
  });
  queue.push({
    type: 'tool_result',
    data: { summary: 'plan updated', toolUseIds: [item.id] },
    source: 'codex',
  });
}

// ── dynamicToolCall → tool_use + tool_result_full + tool_result ──────────────
// 行为对齐 mcpToolCall: started 出 tool_use, updated 兜底, completed 拼 fullText。
// 区别: 工具名 dynamic:${namespace}:${tool}; contentItems 拼 fullText 时, inputImage 退化成
// "<image: url>" 占位 (image 主路径已经走 image event, 这里只为详情面板补全文本可读)。

function dynamicContentItemsToText(items: DynamicToolCallContentItem[] | null | undefined): string {
  if (!items || items.length === 0) return '';
  const parts: string[] = [];
  for (const it of items) {
    if (it.type === 'inputText' && typeof (it as { text?: unknown }).text === 'string') {
      parts.push((it as { text: string }).text);
    } else if (it.type === 'inputImage' && typeof (it as { imageUrl?: unknown }).imageUrl === 'string') {
      parts.push(`<image: ${(it as { imageUrl: string }).imageUrl}>`);
    }
  }
  return parts.join('\n');
}

function handleDynamicToolCall(
  phase: ItemPhase,
  item: DynamicToolCallItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const ns = item.namespace ?? '';
  const toolName = ns ? `dynamic:${ns}:${item.tool}` : `dynamic:${item.tool}`;

  if (phase === 'started') {
    if (ctx.rt.emittedToolUse.has(item.id)) return;
    ctx.rt.emittedToolUse.add(item.id);
    queue.push({
      type: 'tool_use',
      data: {
        toolUseId: item.id,
        toolName,
        input: (item.arguments as Record<string, unknown>) ?? {},
      },
      source: 'codex',
    });
    return;
  }

  if (phase === 'updated') {
    if (!ctx.rt.emittedToolUse.has(item.id)) {
      ctx.rt.emittedToolUse.add(item.id);
      queue.push({
        type: 'tool_use',
        data: { toolUseId: item.id, toolName, input: (item.arguments as Record<string, unknown>) ?? {} },
        source: 'codex',
      });
    }
    return;
  }

  // completed
  ctx.rt.emittedToolUse.delete(item.id);
  const isError = item.status === 'failed' || item.success === false;
  const fullText = dynamicContentItemsToText(item.contentItems);
  queue.push({
    type: 'tool_result_full',
    data: { toolUseId: item.id, fullText, isError },
    source: 'codex',
  });
  queue.push({
    type: 'tool_result',
    data: { summary: isError ? 'failed' : item.status, toolUseIds: [item.id] },
    source: 'codex',
  });
}

// ── collabAgentToolCall → tool_use + tool_result_full + tool_result ──────────
// codex 多 agent 协作 (spawn/sendInput/resume/wait/closeAgent)。
// toolName=collab:${tool}; input 透传 prompt / receivers / model / effort 让 UI 详情面板看到调度参数;
// completed 时把 agentsStates 压成线程状态摘要,避免子任务卡片展开后直接展示原始 JSON。

function formatCodexAgentStateLabel(state: unknown): string | undefined {
  if (typeof state === 'string') {
    const trimmed = state.trim();
    return trimmed || undefined;
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined;

  const record = state as Record<string, unknown>;
  for (const key of ['status', 'state', 'phase']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  for (const key of ['error', 'message', 'summary']) {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const oneLine = value.replace(/\s+/g, ' ').trim();
    return oneLine.length > 180 ? `${oneLine.slice(0, 179)}…` : oneLine;
  }
  return undefined;
}

function formatCodexAgentStatesSummary(states: Record<string, unknown> | null | undefined): string | undefined {
  const entries = Object.entries(states ?? {});
  if (entries.length === 0) return undefined;
  return entries
    .map(([threadId, state]) => {
      const label = formatCodexAgentStateLabel(state);
      return label ? `${threadId}: ${label}` : threadId;
    })
    .join('\n');
}

function handleCollabAgentToolCall(
  phase: ItemPhase,
  item: CollabAgentToolCallItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  const toolName = `collab:${item.tool}`;
  const input: Record<string, unknown> = {
    senderThreadId: item.senderThreadId,
    receiverThreadIds: item.receiverThreadIds,
  };
  if (item.prompt) input.prompt = item.prompt;
  if (item.model) input.model = item.model;
  if (item.reasoningEffort) input.reasoningEffort = item.reasoningEffort;

  if (phase === 'started') {
    if (ctx.rt.emittedToolUse.has(item.id)) return;
    ctx.rt.emittedToolUse.add(item.id);
    queue.push({
      type: 'tool_use',
      data: { toolUseId: item.id, toolName, input },
      source: 'codex',
    });
    queue.push({
      type: 'agent_task_update',
      data: toCodexTaskUpdate(item, 'running'),
      source: 'codex',
    });
    return;
  }

  if (phase === 'updated') {
    if (!ctx.rt.emittedToolUse.has(item.id)) {
      ctx.rt.emittedToolUse.add(item.id);
      queue.push({
        type: 'tool_use',
        data: { toolUseId: item.id, toolName, input },
        source: 'codex',
      });
    }
    queue.push({
      type: 'agent_task_update',
      data: toCodexTaskUpdate(item, 'running'),
      source: 'codex',
    });
    return;
  }

  // completed
  ctx.rt.emittedToolUse.delete(item.id);
  const isError = item.status === 'failed';
  const fullText = formatCodexAgentStatesSummary(item.agentsStates) ?? (isError ? 'failed' : item.status);
  queue.push({
    type: 'tool_result_full',
    data: { toolUseId: item.id, fullText, isError },
    source: 'codex',
  });
  queue.push({
    type: 'tool_result',
    data: { summary: isError ? 'failed' : item.status, toolUseIds: [item.id] },
    source: 'codex',
  });
  queue.push({
    type: 'agent_task_update',
    data: toCodexTaskUpdate(item, isError ? 'failed' : 'completed', fullText),
    source: 'codex',
  });
}

function toCodexTaskUpdate(
  item: CollabAgentToolCallItem,
  status: AgentTaskStatus,
  summary?: string,
): AgentTaskUpdateEventData {
  return {
    provider: 'codex',
    taskId: item.id,
    parentToolUseId: item.id,
    status,
    title: item.tool,
    ...(item.prompt ? { description: item.prompt } : {}),
    ...(summary ? { summary } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
    receiverThreadIds: item.receiverThreadIds,
    raw: { tool: item.tool, agentsStates: item.agentsStates },
  };
}

// ── imageView → image event (kind='view') ────────────────────────────────────
// 模型读了一张本地图。codex 一般只发 completed (path 必有), started/updated 防御性同样发 — 同一
// blockId, renderer 自己判重。

function handleImageView(
  phase: ItemPhase,
  item: ImageViewItem,
  queue: AsyncQueue<AgentEvent>,
): void {
  if (phase === 'updated') return;
  queue.push({
    type: 'image',
    data: { kind: 'view', blockId: item.id, path: item.path },
    source: 'codex',
  });
}

// ── imageGeneration → image event (kind='generation') ────────────────────────
// 模型生成图。result 优先识别为 url (http/data 协议头) — 否则当 path 兜底 (codex 偶尔直接给本地路径
// 不走 savedPath 字段)。savedPath 优先 path; 同时给 revisedPrompt / status 让 UI 显示生成参数。
// started 阶段 result/savedPath 通常没填, 只发 completed。

function isUrlLike(s: string): boolean {
  return /^(https?:|data:)/i.test(s);
}

function handleImageGeneration(
  phase: ItemPhase,
  item: ImageGenerationItem,
  queue: AsyncQueue<AgentEvent>,
): void {
  if (phase !== 'completed') return;
  const data: {
    kind: 'generation';
    blockId: string;
    path?: string;
    url?: string;
    revisedPrompt?: string;
    status?: string;
  } = {
    kind: 'generation',
    blockId: item.id,
    status: item.status,
  };
  if (item.revisedPrompt) data.revisedPrompt = item.revisedPrompt;
  if (item.savedPath) {
    data.path = item.savedPath;
  } else if (item.result) {
    if (isUrlLike(item.result)) data.url = item.result;
    else data.path = item.result;
  }
  queue.push({ type: 'image', data, source: 'codex' });
}

// ── contextCompaction → compact_boundary ─────────────────────────────────────
// codex auto-compact 边界 — 协议只给 id, 没有 trigger / pre/post tokens / duration。
// trigger 一律 'auto' (codex 没暴露手动 compact 入口给 UI), 其他字段 0 占位。
// 与 claude-code translator handleSystem (subtype=compact_boundary) 形状对齐。

function handleContextCompaction(
  phase: ItemPhase,
  item: ContextCompactionItem,
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  if (phase !== 'completed') return;
  ctx.log.info('codex ◾ contextCompaction', { id: item.id });
  queue.push({
    type: 'compact_boundary',
    data: {
      boundaryId: item.id,
      trigger: 'auto',
      preTokens: 0,
      postTokens: 0,
      durationMs: 0,
    },
    source: 'codex',
  });
  ctx.onCompactBoundary?.();
}

// ── account/rateLimits/updated → 'account_usage' event ───────────────────────
// 账号级 notification, host 已做 fan-out + replay 到所有 active subscriber, 这里
// 直接把 params.rateLimits 作为 event.data 透传给 renderer。data shape 不立类型
// (跟 image / compact_boundary 一样 inline), renderer 端 useAccountUsage hook
// 按字段嗅探解析。

export function translateAccountRateLimitsUpdated(
  params: AccountRateLimitsUpdatedNotification['params'],
  queue: AsyncQueue<AgentEvent>,
  ctx: CodexTranslateContext,
): void {
  void ctx;
  queue.push({
    type: 'account_usage',
    data: normalizeAccountRateLimitSnapshot(params.rateLimits),
    source: 'codex',
  });
}
