/**
 * Claude Code SDKMessage → maker-core 语义 AgentEvent 翻译器。
 *
 * 设计来源:从 desktop apps/desktop/src/main/agentManager.ts:processMessage 搬迁,
 * 去掉 desktop-only 字段(LiveSession 状态机、token 计数累积、stderr 等)。
 * 翻译后的事件数据形状 byte-for-byte 与老 cc-agent:stream-event payload 对齐,
 * 让 renderer 的 ccAgentChatStore.handleStreamEvent 可以无修改消费。
 *
 * 一阶段限制:
 * - usage 详细累加不做(只在 message_delta 时输出 raw token 数,renderer 自己用什么算什么)
 * - tool_progress 状态文案字典不接(直接打 'Running...' 占位)
 *
 * Stage 2 C2: agentMeta 提取已接通 (handleAssistant 用 extractAssistantMeta),
 * rewind / fork 反向找 prior assistant 锚点要靠这个; ctx.rt.lastAssistantMeta
 * 跨 stream_event 兜底 (老链路 agentManager.ts:2214 同款)。
 */

import type { AgentEvent, AgentTaskStatus, AgentTaskUsage, AgentTaskUpdateEventData } from '../../types/events.js';
import { normalizeWorkflowProgressEntries } from '@cindy/maker-shared/agent-task';
import {
  extractNonSecretErrorSignals,
  redactSensitiveText,
} from '@cindy/maker-shared/error-redaction';
import {
  holdStandaloneStopTokenDelta,
  stripInternalWebCitations,
  type StandaloneStopTokenHold,
} from '@cindy/maker-shared/internal-citation';
import type { createAsyncQueue } from '../shared/async-queue.js';
import { stripTerminalControlSequences } from '../shared/terminal-output.js';
import { formatOverloadRetryMessage, parseOverloadError } from '../shared/overload-error.js';
import {
  CONTEXT_OVERFLOW_REASON,
  isContextOverflowErrorMessage,
} from '../shared/context-overflow-error.js';
import type { UsageTracker } from '../shared/usage-tracker.js';
import { attachLiveGeneration } from '../shared/live-generation-snapshot.js';
import {
  beginClaudeGeneration,
  finalizeClaudeGeneration,
  markClaudeGenerationUnreliable,
  newClaudeGenerationState,
  pauseClaudeGeneration,
  resetClaudeGenerationTiming,
  resumeClaudeGeneration,
  type ClaudeGenerationState,
} from './generation-timing.js';

// ── 共享 turn / runtime 状态 ─────────────────────────────────────────────────
//
// 跨 SDKMessage 维持:
//  - turnState.text / toolUses/apiCalls: 一个 turn 内 assistant text、tool/API 调用计数, 给 turn end 日志用
//  - thinkingBuf: thinking_delta 跨多个 stream_event 累积; assistant.thinking final 时关闭

export interface TurnState {
  text: string;
  toolUses: number;
  /** 本 turn 内真实 Claude API call 次数；message_start 触发时递增。 */
  apiCalls: number;
  /** 本 turn 是否已收到 compact_boundary；收到后 result usage 不应覆盖 compact 后 context。 */
  sawCompactBoundary: boolean;
  /**
   * 本 turn 是否已向 UI 推过 text event(assistant text block 或流式 text_delta)。
   * handleResult 里 result.result 兜底补推的判据:整轮一个 text 都没推过时才补,
   * 避免与已推正文重复。空串不置位(见两处置位点)。
   */
  hasEmittedText: boolean;
  /**
   * 本 turn 已推给 UI 的全部 text(assistant block + 流式 delta,按到达顺序拼接)。
   * turn-end 时与 result.result 做前缀比对,只补 UI 缺失的尾部(末尾截断兜底),绝不重复推。
   * 这是修复 e7ea882b 盲区(末尾截断)的依据:hasEmittedText 是 per-turn 布尔,无法区分
   * "整轮全空"和"前面推过、最后一段被截断";uiEmittedText 让兜底能精确算出缺哪一段。
   */
  uiEmittedText: string;
  /**
   * SDK API retry / assistant error envelope 的暂存详情。两者都不是可靠的 turn
   * 终态: Claude Code 可能随后自动重试并返回成功 result。只有最终
   * result.is_error 才把它推成 terminal error；成功 result 直接丢弃，避免下游
   * 提前收口重试中的 turn。
   */
  pendingApiError: {
    message: string;
    sdkError: string;
    agentMeta?: Record<string, unknown>;
    errorStatus?: number | null;
    usageLimit?: boolean;
    retryAttempt?: number;
    maxRetries?: number;
  } | null;
  /**
   * 本 turn 是否由 maker 侧主动 interrupt(用户点停止 handle.abort() / upstream
   * idle watchdog, 都走 q.interrupt())。SDK 被 interrupt 后会 drain 出
   * ResultMessage(error_during_execution, is_error=true)走正常 result 路径——
   * 这不是上游失败, turn-end 的 is_error 兜底必须跳过, 否则:用户手动停止被
   * 误报成"执行失败"通知(本 PR 要消灭的那类误报); watchdog 场景则双发 error
   * banner(watchdog 自己已推过带 reason 的 terminal error)。置位点在 index.ts
   * 的 abort() 与 watchdog 超时回调, interrupt 之前打。
   */
  interruptRequested: boolean;
  /**
   * send 代际计数(index.ts 的 beginNewTurn 自增)。interrupt 置位时把当时代际
   * 快照进 interruptGeneration —— handleResult 收到被打断的 is_error result 时,
   * 若代际已前进(新 send 已接管), 该迟到 result 必须**整条丢弃**(不发 error 也
   * 不发 status Done/done):它的 done 会被 main 当作**当前** turn 的边界,提前
   * 清掉/完成新 turn(coordinator onTurnEvent done)。代际未变(常规用户停止)
   * 则保持既有收尾(静音 error + 完整 Done/done, 花费记账依赖 done)。
   */
  generation: number;
  /** interrupt 置位时的 generation 快照(见 generation 注释)。 */
  interruptGeneration: number;
  /**
   * 最近一条 assistant API 消息是否带「实质内容」(非空 text 或任何非 thinking 块;
   * thinking / redacted_thinking 不算)。逐条 assistant 消息覆盖写,turn end
   * 时留下的即"最后一条 assistant 消息"的判定,是 silent-stop 观测的核心依据:
   * 上游偶发用一条空内容消息收尾整个 turn(空 thinking + end_turn,或 SSE 流被
   * 静默中断后 stop_reason 缺失;社区同型报告 anthropics/claude-code#50597 /
   * #38905),任务做到一半"看起来正常结束"。默认 true(fail-safe:本 turn 还没
   * 见过 assistant 消息时不参与判定)。
   */
  lastAssistantMsgHadSubstance: boolean;
  /**
   * The price variant captured when the current turn's next provider request
   * was accepted. The SDK may deliver message_start after a runtime Fast-mode
   * toggle, so usage translation must not read the mutable session setting for
   * that already-dispatched request.
   */
  nextRequestPriceVariant?: 'standard' | 'priority';
  /**
   * 本 turn 最近一条 assistant API message id。Vertex 路由用 `msg_vrtx_`
   * 前缀作为输出 token 延迟结算的确定性证据；result 本身不携带该 id，
   * 因此必须在 assistant 消息到达时按 turn 暂存，再随 done 交给 host。
   */
  lastAssistantRequestId?: string;
}

export interface RuntimeState {
  currentThinking: { blockId: string; startedAt: number; text: string } | null;
  /** tool_use.id → tool_use.name。用于在 tool_result echo 时区分命令输出和内容结果。 */
  toolUseIdToName: Map<string, string>;
  /**
   * SDK child assistant 消息按 parent_tool_use_id 隔离的真实模型。
   * 并发 subagent 的完整消息与 stream_event 都会交错，不能用会话级元数据推断。
   */
  streamModelByParentToolUseId: Map<string, string>;
  /** Agent 工具回执里的权威模型，优先级高于流式事件里的 wire model。 */
  resolvedSubagentModelByParentToolUseId: Map<string, string>;
  /** 已经通过 agent_task_update 下发过的模型；与 stream map 分离，避免漏发或重复发。 */
  publishedSubagentModelByParentToolUseId: Map<string, string>;
  /** parent tool_use.id 对应的最近任务状态；晚到的模型观测不能把终态倒退成 running。 */
  subagentStatusByParentToolUseId: Map<string, AgentTaskStatus>;
  /** task_id 到启动它的 Agent tool_use.id 的别名映射。 */
  subagentParentToolUseIdByTaskId: Map<string, string>;
  /**
   * 已被 SDK 明确标记为 local_agent / remote_agent 的 task_id。
   * Claude 后续进度与终态帧可能省略 task_type / tool_use_id；一旦确认，
   * 该身份在本 RuntimeState 生命周期内保持单向锁存，避免持久记录停在 running。
   */
  confirmedSubagentTaskIds: Set<string>;
  /** 明确属于 local_bash / local_workflow 的 task_id；稀疏后续帧继续排除。 */
  excludedSubagentTaskIds: Set<string>;
  /**
   * 上一次 SDK assistant 消息提取出来的 agentMeta (uuid / sdkSessionId / model / ...).
   * 主 agent 的 stream_event 累积时用它补齐 transcript 锚点；subagent stream
   * 则必须按 parent_tool_use_id 隔离，不能共享这份会话级状态。
   * 老链路 agentManager.ts:2214 (session.lastAssistantMeta) 同款。
   */
  lastAssistantMeta: Record<string, unknown> | null;
  /**
   * Claude Code QueryEngine 的 result.usage 是当前子进程 session 内累计值。
   * translator 在 handleResult 里按上一条 result 做 delta, 再把 per-turn usage 交给 UsageTracker。
   */
  lastResultUsageAggregate: ResultUsageAggregate | null;
  /**
   * 按 parent + content-block index 隔离的停止符清洗缓冲。text_delta 可能把
   * `<|eos|>` 拆开，必须先拼回该块的快照再清洗。`emitted` 只表示本块是否已
   * 发出可见正文，不能看整轮 `uiEmittedText`，也不能跨 text block 复用。
   */
  streamStopTokenByKey: Map<string, StandaloneStopTokenHold>;
  /** Per-parent active provider request used to merge message_start + message_delta usage. */
  activeUsageSegmentByParent: Map<string, string>;
  /** Price variant frozen for the active request of each parent stream. */
  activeUsagePriceVariantByParent: Map<string, 'standard' | 'priority'>;
  /** Price variant captured for the next request before its message_start arrives. */
  pendingUsagePriceVariantByParent: Map<string, 'standard' | 'priority'>;
  usageSegmentSeq: number;
  generation: ClaudeGenerationState;
}

export function newRuntimeState(): RuntimeState {
  return {
    currentThinking: null,
    toolUseIdToName: new Map(),
    streamModelByParentToolUseId: new Map(),
    resolvedSubagentModelByParentToolUseId: new Map(),
    publishedSubagentModelByParentToolUseId: new Map(),
    subagentStatusByParentToolUseId: new Map(),
    subagentParentToolUseIdByTaskId: new Map(),
    confirmedSubagentTaskIds: new Set(),
    excludedSubagentTaskIds: new Set(),
    lastAssistantMeta: null,
    lastResultUsageAggregate: null,
    streamStopTokenByKey: new Map(),
    activeUsageSegmentByParent: new Map(),
    activeUsagePriceVariantByParent: new Map(),
    pendingUsagePriceVariantByParent: new Map(),
    usageSegmentSeq: 0,
    generation: newClaudeGenerationState(),
  };
}

function ccLiveStatus(
  ctx: TranslateContext,
  status: string,
  isRunning: boolean,
): { status: string; isRunning: boolean } & ReturnType<UsageTracker['snapshot']> {
  return {
    status,
    ...attachLiveGeneration(ctx.tracker.snapshot(), {
      outputTokens: ctx.tracker.getTurnUsage().output,
      closedDurationMs: ctx.rt.generation.durationMs,
      openStartedAt: ctx.rt.generation.startedAt,
      reliable: ctx.rt.generation.reliable,
    }),
    isRunning,
  };
}

/**
 * 清掉一个 turn 的非 usage 累积状态(usage 由 UsageTracker.endTurn 内部 reset)。
 * turn 收尾共用:正常 Done/done 路径与 empty-response 终态 error 提前 return 路径。
 */
function resetTurnState(turn: TurnState): void {
  turn.text = '';
  turn.toolUses = 0;
  turn.apiCalls = 0;
  turn.sawCompactBoundary = false;
  turn.hasEmittedText = false;
  turn.uiEmittedText = '';
  turn.pendingApiError = null;
  turn.interruptRequested = false;
  turn.lastAssistantMsgHadSubstance = true;
  turn.lastAssistantRequestId = undefined;
  // generation / interruptGeneration 刻意不清: 代际跨 turn 单调递增(见字段注释)。
}

type ResultUsageAggregate = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
};

function resultUsageToTurnDelta(
  previous: ResultUsageAggregate | null,
  current: ResultUsageAggregate,
): ResultUsageAggregate {
  if (!previous) return current;
  const aggregateReset =
    current.inputTokens < previous.inputTokens ||
    current.outputTokens < previous.outputTokens ||
    (
      current.cacheReadTokens !== undefined &&
      previous.cacheReadTokens !== undefined &&
      current.cacheReadTokens < previous.cacheReadTokens
    ) ||
    (
      current.cacheCreateTokens !== undefined &&
      previous.cacheCreateTokens !== undefined &&
      current.cacheCreateTokens < previous.cacheCreateTokens
    );
  if (aggregateReset) return current;
  return {
    inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
    cacheReadTokens: current.cacheReadTokens === undefined
      ? undefined
      : Math.max(0, current.cacheReadTokens - (previous.cacheReadTokens ?? 0)),
    cacheCreateTokens: current.cacheCreateTokens === undefined
      ? undefined
      : Math.max(0, current.cacheCreateTokens - (previous.cacheCreateTokens ?? 0)),
  };
}

function normalizeModelForContextWindow(model: string): string {
  return model.replace(/\[1m\]$/, '');
}

function modelIdsMatchForContextWindow(a: string, b: string): boolean {
  const left = normalizeModelForContextWindow(a);
  const right = normalizeModelForContextWindow(b);
  return left === right || left.startsWith(right) || right.startsWith(left);
}

/**
 * 从一条 SDK assistant message 抽 cc 元信息 (uuid / parent_tool_use_id / session_id +
 * 内层 message.{model, stop_reason, id, usage})。shape 与 desktop CcMeta 对齐 (camelCase)。
 * 老链路 agentManager.ts:ccMetaFromAssistant 同款; 缺字段一律不写入。
 */
export function extractAssistantMeta(rawMsg: unknown): Record<string, unknown> {
  const msg = rawMsg as {
    uuid?: string;
    parentUuid?: string;
    parent_uuid?: string;
    session_id?: string;
    parent_tool_use_id?: string | null;
    message?: {
      id?: string;
      model?: string;
      stop_reason?: string | null;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
  };
  const meta: Record<string, unknown> = {};
  if (typeof msg.uuid === 'string') meta.uuid = msg.uuid;
  if (typeof msg.session_id === 'string') meta.sdkSessionId = msg.session_id;
  if (typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id) {
    meta.parentUuid = msg.parent_tool_use_id;
  }
  const transcriptParentUuid =
    (typeof msg.parentUuid === 'string' && msg.parentUuid)
      ? msg.parentUuid
      : (typeof msg.parent_uuid === 'string' && msg.parent_uuid)
          ? msg.parent_uuid
          : undefined;
  if (transcriptParentUuid) meta.transcriptParentUuid = transcriptParentUuid;
  const inner = msg.message;
  if (inner) {
    if (typeof inner.model === 'string') meta.model = inner.model;
    if (typeof inner.stop_reason === 'string') meta.stopReason = inner.stop_reason;
    if (typeof inner.id === 'string') meta.requestId = inner.id;
    if (inner.usage) {
      meta.usage = {
        inputTokens: inner.usage.input_tokens,
        outputTokens: inner.usage.output_tokens,
        cacheReadInputTokens: inner.usage.cache_read_input_tokens,
        cacheCreationInputTokens: inner.usage.cache_creation_input_tokens,
      };
    }
  }
  return meta;
}

// ── 工具:从 user echo 里抽 tool_result 全文 ──────────────────────────────────
// (复刻 agentManager.ts:88-114 extractToolResultFullText)

// Host 侧显式镜像 cc-code 的 SHELL_TOOL_NAMES；上游新增 shell 工具时必须同步维护。
// TaskOutput 读取的是任务/agent 输出，不等同于终端工具结果。
const TERMINAL_OUTPUT_TOOL_NAMES = new Set(['Bash', 'PowerShell']);

function normalizeToolResultFullText(
  pair: { toolUseId: string; fullText: string },
  rt: RuntimeState,
): { toolUseId: string; fullText: string } {
  const toolName = rt.toolUseIdToName.get(pair.toolUseId);
  if (!toolName || !TERMINAL_OUTPUT_TOOL_NAMES.has(toolName)) return pair;
  return {
    toolUseId: pair.toolUseId,
    fullText: stripTerminalControlSequences(pair.fullText),
  };
}

function extractToolResultFullText(
  message: { content?: unknown } | undefined,
  rt: RuntimeState,
): Array<{ toolUseId: string; fullText: string }> {
  if (!message?.content || typeof message.content === 'string') return [];
  if (!Array.isArray(message.content)) return [];
  const out: Array<{ toolUseId: string; fullText: string }> = [];
  for (const block of message.content as unknown[]) {
    const pair = readToolResultFullText(block);
    if (pair) {
      const normalized = normalizeToolResultFullText(pair, rt);
      if (normalized.fullText.length > 0) out.push(normalized);
    }
  }
  return out;
}

function readToolResultFullText(blockRaw: unknown): { toolUseId: string; fullText: string } | null {
  if (!blockRaw || typeof blockRaw !== 'object') return null;
  const b = blockRaw as { type?: unknown; tool_use_id?: unknown; content?: unknown };
  if (b.type !== 'tool_result') return null;
  if (typeof b.tool_use_id !== 'string' || b.tool_use_id.length === 0) return null;
  const inner = b.content;
  let fullText = '';
  if (typeof inner === 'string') {
    fullText = inner;
  } else if (Array.isArray(inner)) {
    const parts: string[] = [];
    for (const sub of inner) {
      if (sub && typeof sub === 'object' && (sub as { type?: unknown }).type === 'text') {
        const t = (sub as { text?: unknown }).text;
        if (typeof t === 'string') parts.push(t);
      }
    }
    fullText = parts.join('\n');
  }
  return { toolUseId: b.tool_use_id, fullText };
}

/**
 * 从 Agent 工具回执中提取任务身份、生命周期与权威模型。
 * Claude Code 会把最终解析后的模型放在 tool_use_result.resolvedModel；同步前台
 * Agent 直接返回 completed，异步 Agent 返回 async_launched。两者都比根据请求参数
 * 或流式子消息时序推断可靠，应直接投影成 AgentTaskUpdate。
 */
interface SubagentToolResult {
  taskId: string;
  parentToolUseId: string;
  prompt?: string;
  model?: string;
  status: 'running' | 'completed';
  usage?: AgentTaskUsage;
}

function readResultNumber(
  result: Record<string, unknown>,
  camelKey: string,
  snakeKey: string,
): number | undefined {
  const value = result[camelKey] ?? result[snakeKey];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function extractSubagentToolResult(
  msg: {
    message?: { content?: unknown };
    tool_use_result?: unknown;
    toolUseResult?: unknown;
  },
): SubagentToolResult | null {
  const rawResult = msg.tool_use_result ?? msg.toolUseResult;
  if (!rawResult || typeof rawResult !== 'object' || Array.isArray(rawResult)) return null;
  const result = rawResult as Record<string, unknown>;
  const isAsync = result.isAsync === true || result.is_async === true;
  const status = result.status;
  const rawAgentId = result.agentId ?? result.agent_id;
  const agentId = typeof rawAgentId === 'string' && rawAgentId ? rawAgentId : undefined;
  const isAsyncLaunch = isAsync || status === 'async_launched';
  // completed 很常见，必须同时有 Agent 专属的 agentId 才能识别为同步子任务回执。
  const isCompletedAgent = status === 'completed' && Boolean(agentId);
  if (!isAsyncLaunch && !isCompletedAgent) return null;

  const model = typeof result.resolvedModel === 'string'
    ? result.resolvedModel
    : typeof result.resolved_model === 'string'
      ? result.resolved_model
      : undefined;
  const content = msg.message?.content;
  let toolResult: { toolUseId: string; fullText: string } | null = null;
  if (Array.isArray(content)) {
    for (const block of content) {
      toolResult = readToolResultFullText(block);
      if (toolResult) break;
    }
  }
  if (!toolResult) return null;

  const taskId = agentId ?? toolResult.toolUseId;
  const prompt = typeof result.prompt === 'string' && result.prompt
    ? result.prompt
    : undefined;
  const usage: AgentTaskUsage = {};
  const totalTokens = readResultNumber(result, 'totalTokens', 'total_tokens');
  const toolUses = readResultNumber(result, 'totalToolUseCount', 'total_tool_use_count');
  const durationMs = readResultNumber(result, 'totalDurationMs', 'total_duration_ms');
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  if (toolUses !== undefined) usage.toolUses = toolUses;
  if (durationMs !== undefined) usage.durationMs = durationMs;
  return {
    taskId,
    parentToolUseId: toolResult.toolUseId,
    model,
    prompt,
    status: isCompletedAgent ? 'completed' : 'running',
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
  };
}

// ── cache 命中率日志格式化 ───────────────────────────────────────────────────
// hitRate 按"百分比 + 1 位小数"输出, 没数据返 'n/a'。
// 配 read/create/uncached/apiCalls 一起打, 看 hitRate 时能立刻判断样本量够不够代表性。

function formatCacheBucket(b: {
  read: number;
  create: number;
  uncachedInput: number;
  apiCalls: number;
  hitRate: number | null;
}): {
  hitRate: string;
  read: number;
  create: number;
  uncached: number;
  apiCalls: number;
} {
  return {
    hitRate: b.hitRate === null ? 'n/a' : `${(b.hitRate * 100).toFixed(1)}%`,
    read: b.read,
    create: b.create,
    uncached: b.uncachedInput,
    apiCalls: b.apiCalls,
  };
}

// ── 主翻译器 ─────────────────────────────────────────────────────────────────

const TURN_END_LOGGER_KEY = 'SDK ◀ turn end (result)';
void TURN_END_LOGGER_KEY; // 只是给调用方对照参考

type EventQueue = ReturnType<typeof createAsyncQueue<AgentEvent>>;
interface TranslatorLog {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

interface TranslateContext {
  rt: RuntimeState;
  turn: TurnState;
  log: TranslatorLog;
  /**
   * 当前 runtime 参数 getter —— turn start/end 日志读这三个,
   * setModel/setEffort/setPermissionMode 修改后能立刻反映到下一行日志,
   * 不会因为闭包捕获 startSession 时的初始值而打陈旧数据。
   */
  getModel: () => string;
  /**
   * Maker capabilities 中当前模型的 contextWindow。
   * Claude Code SDK 对未知第三方模型会回 200K 默认值; maker 侧配置更准时用它覆盖。
   */
  getModelContextWindow?: () => number | undefined;
  getEffort: () => string;
  getPermissionMode: () => string;
  getFastMode?: () => boolean;
  /** SDK session_id 第一次出现时的回调, agent 用来回填 sdkSessionId */
  onSessionId: (sdkSessionId: string | undefined) => void;
  /**
   * 当前已知的 SDK session_id (agent 闭包持有)。
   * 仅诊断日志用, getter 形式确保读到的是最新值 (system init 那一步会回填)。
   */
  getSdkSessionId: () => string | undefined;
  /** Whether the current SDK query starts its cumulative modelUsage at zero. */
  modelUsageCumulativeStartsAtZero?: () => boolean;
  /**
   * 当前 session 的展示 title —— 由调用方 (register.ts) 每次 send 时透传进来,
   * 同样仅用于诊断日志, 不参与业务。允许 undefined / 跨 turn 变化。
   */
  getLogTitle: () => string | undefined;
  /**
   * Stage 2 B': SDK 原始 usage 通过 tracker 累加, 翻译器只在 push status 时
   * 走 tracker.snapshot() 取最终数值, 不再自己算 (避免再次出现 currentTurn 不累加 /
   * contextWindow 写死 0 这类与老 agentManager 不一致的 bug)。
   */
  tracker: UsageTracker;
  /**
   * turn 结束 (result 事件) 时回调, agent 用来清 turnInFlight 标记。
   * 缺省 = 不回调 (旧调用方零改动)。
   */
  onTurnEnd?: () => void;
  /**
   * upstream-response-idle watchdog / loop guard: assistant / stream_event 含 tool_use 时回调。
   * parentToolUseId 用于隔离并发 subagent；缺省表示顶层 agent。
   */
  onToolUseStart?: (
    toolUseId: string,
    toolName?: unknown,
    input?: unknown,
    parentToolUseId?: string,
  ) => void;
  /**
   * upstream-response-idle watchdog: user 含 tool_result 时出队, 配对 onToolUseStart。
   * 不要复用 extractToolResultFullText — 那里 fullText.length>0 过滤会漏空内容 result
   * (Bash 无 stdout / Write 成功 / MCP return null), 导致 pendingToolIds 永远漏减,
   * watchdog 整 turn 失效。parentToolUseId 与 tool_use 同源，用于隔离并发 subagent。
   */
  onToolResultDone?: (toolUseId: string, output: string, parentToolUseId?: string) => void;
  onSubagentTaskLaunched?: (task: {
    taskId: string;
    parentToolUseId: string;
    prompt: string;
    model?: string;
  }) => void;
  getSubagentTaskUsage?: (taskId: string) => AgentTaskUsage | undefined;
  /**
   * Maker Memory flush 观察器 — 翻译 status / message_delta event 时, push 完
   * eventQueue 后调一下 (传当前 contextTokens / contextWindow 让 controller 算 ratio)。
   * 缺省 = 不回调 (makerMemoryEnabled 关时 agent 不注入)。
   */
  onUsageUpdate?: (contextTokens: number, contextWindow: number) => void;
  /**
   * Maker Memory flush 观察器 — compact_boundary 事件后调, controller 重置 fired 标记。
   * 缺省 = 不回调。
   */
  onCompactBoundary?: () => void;
}

export function translateSdkMessage(
  rawMsg: unknown,
  queue: EventQueue,
  ctx: TranslateContext,
): void {
  const msg = rawMsg as {
    type?: string;
    subtype?: string;
    session_id?: string;
    parent_tool_use_id?: string | null;
    model?: string;
    message?: { content?: Array<Record<string, unknown>>; role?: string };
    event?: Record<string, unknown>;
    summary?: string;
    preceding_tool_use_ids?: string[];
    tool_name?: string;
    error?: string;
    stop_reason?: string;
    is_error?: boolean;
    duration_ms?: number;
    duration_api_ms?: number;
    num_turns?: number;
    total_cost_usd?: number;
    terminal_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    /** SDK 在 result 里按 modelId 给出真实跑过的模型(支持 turn 内 setModel 切换累加) */
    modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number }>;
    result?: string;
    [k: string]: unknown;
  };

  switch (msg.type) {
    case 'system': {
      handleSystem(msg, queue, ctx);
      return;
    }

    case 'assistant': {
      handleAssistant(msg, queue, ctx);
      return;
    }

    case 'user': {
      // streaming-input 模式下 SDK 不 echo 真实 user 输入, 只 echo tool_result 包装的 user message
      // 这里只关心后者: 抽 tool_result_full 给 renderer (老 agentManager.ts:2178-2207 同等逻辑)
      const parentToolUseId = typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id
        ? msg.parent_tool_use_id
        : undefined;
      const fullPairs = extractToolResultFullText(msg.message, ctx.rt);
      for (const pair of fullPairs) {
        queue.push({
          type: 'tool_result_full',
          data: { toolUseId: pair.toolUseId, fullText: pair.fullText },
          source: 'claude-code',
        });
      }
      const subagentResult = extractSubagentToolResult(msg);
      if (subagentResult) {
        const { taskId, parentToolUseId, model, prompt, status, usage } = subagentResult;
        const actualModel = model
          ?? ctx.rt.resolvedSubagentModelByParentToolUseId.get(parentToolUseId)
          ?? ctx.rt.streamModelByParentToolUseId.get(parentToolUseId);
        ctx.rt.subagentParentToolUseIdByTaskId.set(taskId, parentToolUseId);
        ctx.rt.confirmedSubagentTaskIds.add(taskId);
        ctx.rt.excludedSubagentTaskIds.delete(taskId);
        // 迟到的 async_launched 回执（status=running）不得把已有终态降级回 running：
        // 事件乱序时（task_notification: completed 先到）这会让 Renderer 永久转圈。
        // 状态机只允许 running → 终态，终态后到达的 launch 回执只补元数据、不改状态。
        const previousStatus = ctx.rt.subagentStatusByParentToolUseId.get(parentToolUseId);
        const isTerminal = previousStatus === 'completed'
          || previousStatus === 'failed'
          || previousStatus === 'stopped';
        const effectiveStatus = status === 'running' && isTerminal
          ? previousStatus!
          : status;
        ctx.rt.subagentStatusByParentToolUseId.set(parentToolUseId, effectiveStatus);
        if (model) {
          ctx.rt.resolvedSubagentModelByParentToolUseId.set(parentToolUseId, model);
        }
        if (actualModel) {
          ctx.rt.publishedSubagentModelByParentToolUseId.set(parentToolUseId, actualModel);
        }
        if (status === 'running' && prompt && !isTerminal) {
          ctx.onSubagentTaskLaunched?.({ taskId, parentToolUseId, prompt, model: actualModel });
        }
        queue.push({
          type: 'agent_task_update',
          data: {
            provider: 'claude-code',
            taskId,
            parentToolUseId,
            status: effectiveStatus,
            subagentObservation: {
              // A synchronous completed Agent result may be the first and only
              // lifecycle observation. It is authoritative to create the run,
              // while the completed status still keeps the record terminal.
              kind: 'spawn',
              logicalSubagentId: taskId,
              parentToolUseId,
            },
            ...(actualModel ? { model: actualModel } : {}),
            ...(usage ? { usage } : {}),
          },
          source: 'claude-code',
        });
      }
      // 单独遍历: 不能复用 extractToolResultFullText, 见 onToolResultDone JSDoc。
      const completedToolUseIds = new Set(fullPairs.map((pair) => pair.toolUseId));
      const content = msg.message?.content;
      if (ctx.onToolResultDone) {
        if (Array.isArray(content)) {
          for (const blockRaw of content as unknown[]) {
            const rawPair = readToolResultFullText(blockRaw);
            const pair = rawPair ? normalizeToolResultFullText(rawPair, ctx.rt) : null;
            if (!pair) continue;
            completedToolUseIds.add(pair.toolUseId);
            ctx.onToolResultDone(pair.toolUseId, pair.fullText, parentToolUseId);
          }
        }
      } else if (Array.isArray(content)) {
        for (const blockRaw of content as unknown[]) {
          const pair = readToolResultFullText(blockRaw);
          if (pair) completedToolUseIds.add(pair.toolUseId);
        }
      }
      for (const toolUseId of completedToolUseIds) {
        resumeClaudeGeneration(ctx.rt.generation, toolUseId);
        ctx.rt.toolUseIdToName.delete(toolUseId);
      }
      if (completedToolUseIds.size > 0) {
        // The SDK emits the tool-result echo immediately before it dispatches
        // the next provider request. Capture the mutable Fast setting here,
        // after tool execution has completed, rather than at the previous
        // message_delta (which can be much earlier than the next request).
        ctx.rt.pendingUsagePriceVariantByParent.set(
          parentToolUseId ?? '__main__',
          ctx.getFastMode?.() ? 'priority' : 'standard',
        );
      }
      return;
    }

    case 'stream_event': {
      handleStreamEvent(msg, queue, ctx);
      return;
    }

    case 'tool_use_summary': {
      queue.push({
        type: 'tool_result',
        data: {
          summary: msg.summary,
          toolUseIds: msg.preceding_tool_use_ids,
        },
        source: 'claude-code',
      });
      return;
    }

    case 'tool_progress': {
      queue.push({
        type: 'status',
        data: {
          status: `${msg.tool_name ?? 'tool'} running...`,
          tokenUsage: 0,
          contextTokens: 0,
          contextWindow: 0,
          isRunning: true,
        },
        source: 'claude-code',
      });
      return;
    }

    case 'result': {
      handleResult(msg, queue, ctx);
      return;
    }

    case 'control_response': {
      // SDK 对每个 control request (setModel / applyFlagSettings / setPermissionMode / interrupt 等)
      // 都会回一条 control_response。这里只打日志做可见性 —— 排查"我点了切模型怎么没反应"很有用。
      // 不 push 任何 event 给上层 (renderer 不需要感知, IPC payload 也不必膨胀)。
      handleControlResponse(rawMsg, ctx);
      return;
    }

    default: {
      // 未识别 type: 走 logger.warn (诊断用), 不再 emit vendor-raw —— renderer
      // default case 直接丢, 走 IPC 也是浪费。Codex translator 同款做法。
      ctx.log.warn('SDK ▷ unhandled message type', {
        type: (rawMsg as { type?: unknown }).type,
        preview: JSON.stringify(rawMsg).slice(0, 200),
      });
      return;
    }
  }
}

// ── control_response ─────────────────────────────────────────────────────────

function handleControlResponse(rawMsg: unknown, ctx: TranslateContext): void {
  const msg = rawMsg as { response?: unknown };
  const resp = msg.response as
    | { subtype: 'success'; request_id?: string; response?: Record<string, unknown> }
    | { subtype: 'error'; request_id?: string; error?: string }
    | undefined;
  if (!resp || typeof resp !== 'object') {
    ctx.log.warn('SDK ◇ control_response: malformed', { raw: rawMsg });
    return;
  }
  if (resp.subtype === 'error') {
    ctx.log.warn('SDK ◇ control_response error', {
      requestId: resp.request_id,
      error: resp.error,
    });
    return;
  }
  // success: response payload 因 control 类型而异 (setModel 通常空, getMcpServerStatus 会带数据)
  ctx.log.debug('SDK ◇ control_response ok', {
    requestId: resp.request_id,
    response: resp.response,
  });
}

// ── system 子分支 ─────────────────────────────────────────────────────────────

function handleSystem(
  msg: {
    subtype?: string;
    uuid?: string;
    session_id?: string;
    model?: string;
    permissionMode?: string;
    status?: string;
    compact_metadata?: { trigger?: 'manual' | 'auto'; pre_tokens?: number; post_tokens?: number; duration_ms?: number };
    task_id?: string;
    tool_use_id?: string;
    description?: string;
    prompt?: string;
    task_type?: string;
    workflow_name?: string;
    output_file?: string;
    summary?: string;
    usage?: Record<string, number | undefined>;
    last_tool_name?: string;
    attempt?: number;
    max_retries?: number;
    retry_delay_ms?: number;
    error_status?: number | null;
    error?: string;
    // task_updated 专属:增量补丁(SDKTaskUpdatedMessage.patch)。只声明渲染需要的字段,
    // end_time / total_paused_ms / is_backgrounded 目前不进事件流。
    patch?: { status?: string; description?: string; error?: string };
  },
  queue: EventQueue,
  ctx: TranslateContext,
): void {
  if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
    // model / permissionMode 优先用 SDK 在 init 里回执的真实值; effort SDK 不返回, 用 mutable 态。
    ctx.log.debug('SDK ▶ turn start (system init)', {
      sdkSessionId: msg.session_id,
      model: msg.model ?? ctx.getModel(),
      effort: ctx.getEffort(),
      permissionMode: msg.permissionMode ?? ctx.getPermissionMode(),
    });
    ctx.onSessionId(msg.session_id);
    return;
  }
  if (msg.subtype === 'status') {
    if (msg.status === 'compacting' || msg.status === 'thinking') {
      queue.push({
        type: 'status',
        data: {
          status: msg.status === 'compacting' ? 'Compacting...' : 'Thinking...',
          tokenUsage: 0,
          contextTokens: 0,
          contextWindow: 0,
          isRunning: true,
        },
        source: 'claude-code',
      });
    }
    return;
  }
  if (msg.subtype === 'api_retry') {
    // SDKAPIRetryMessage 明确表示本次 API 失败仍在自动重试，不是 turn 终态。
    // 除日志外也暂存最后一次 retry 的错误详情，覆盖 SDK 没有额外发送
    // assistant.error envelope、最终 ResultMessage 又没有 result 文本的路径。
    // 已有 envelope 时保留其中的人话文案与 transcript metadata，只补 retry 元数据。
    const previous = ctx.turn.pendingApiError;
    const hasAssistantEnvelope = previous?.agentMeta !== undefined;
    const sdkError = redactSensitiveText(hasAssistantEnvelope ? previous.sdkError : (msg.error || 'unknown'));
    const statusLabel = msg.error_status == null ? 'connection error' : `HTTP ${msg.error_status}`;
    const retryLabel = typeof msg.attempt === 'number' && typeof msg.max_retries === 'number'
      ? `, retry ${msg.attempt}/${msg.max_retries}`
      : '';
    ctx.turn.pendingApiError = {
      message: hasAssistantEnvelope
        ? previous.message
        : `SDK API request failed: ${sdkError} (${statusLabel}${retryLabel})`,
      sdkError,
      ...(hasAssistantEnvelope ? { agentMeta: previous.agentMeta } : {}),
      errorStatus: msg.error_status,
      retryAttempt: msg.attempt,
      maxRetries: msg.max_retries,
    };
    ctx.log.info('SDK API request retrying', {
      attempt: msg.attempt,
      maxRetries: msg.max_retries,
      retryDelayMs: msg.retry_delay_ms,
      errorStatus: msg.error_status,
      sdkError: redactSensitiveText(msg.error ?? 'unknown'),
    });
    // SDK 正在自己退避重试 → 透出**非终止**进度，别让用户对着无提示的转圈干等
    // （PR #790 给 Codex `Reconnecting N/M` 做的是同一件事）。恢复后由后续正常
    // 事件按现有机制自动清除，不结束 turn、不落 error 行。
    //
    // **绝不在这里自己重投**：SDK 已带退避重试（529 overloaded / 429 / 连接错误
    // 都走它），客户端再叠一层会把一次上游过载放大成指数级请求，而失败请求照扣
    // 额度。Codex 那侧要自己重投只是因为 app-server 对容量拒绝根本不重试。
    //
    // 第 1 次不透出：单次抖动 SDK 一次重试就过，提示只会闪一下徒增噪音（与
    // codex translator 持续重试透出的防噪口径一致）。
    //
    // **只透出过载类**：这条 message 是内部英文 SDK 字符串，renderer 的 ErrorBanner
    // 只对过载与网络形态做本地化替换。若把 429、500 这类也透出来，各语言用户会直接
    // 看到裸英文，而它们在本改动之前是静默的——那是实打实的回归。其它重试类别保持
    // 原样静默，需要时另行补本地化再放开。
    //
    // 判据是 parseOverloadError 的**两种**形态都算（`overloaded`：529 /
    // overloaded_error；`capacity`：`at capacity`），不只 529：renderer 侧的镜像
    // (renderer/utils/overloadError.ts) 对两种形态都有本地化文案，所以放开 capacity
    // 不会产生裸英文；反过来只认 529 会把一条措辞为 `at capacity` 的过载错误静默掉，
    // 用户看到的是"什么都没发生"。
    const overloadRetry =
      typeof msg.attempt === 'number' &&
      typeof msg.max_retries === 'number' &&
      msg.attempt >= 2 &&
      parseOverloadError(`${sdkError} ${statusLabel}`, msg.error_status ?? undefined) !== null;
    if (overloadRetry) {
      queue.push({
        type: 'error',
        data: {
          // 进度用 `(auto-retry N/M)` 后缀编码，与 Codex 侧同一套跨 agent 协议，
          // renderer 只需一份解析。原始状态留在正文里供分类与折叠查看。
          message: formatOverloadRetryMessage(
            `SDK API request failed: ${sdkError} (${statusLabel})`,
            msg.attempt as number,
            msg.max_retries as number,
          ),
          isTerminal: false,
          willRetry: true,
          ...(msg.error_status != null ? { errorStatus: msg.error_status } : {}),
        },
        source: 'claude-code',
      });
    }
    return;
  }
  if (msg.subtype === 'compact_boundary') {
    const meta = msg.compact_metadata ?? {};
    ctx.log.info('SDK ◾ compact_boundary', meta);
    // compact 后 context 缩小 — 更新 tracker 使后续 snapshot().contextTokens 反映真实值
    const postTokens = meta.post_tokens ?? 0;
    ctx.tracker.setContextTokensAfterCompact(postTokens);
    ctx.turn.sawCompactBoundary = true;
    queue.push({
      type: 'compact_boundary',
      data: {
        ...(typeof msg.uuid === 'string' && msg.uuid ? { boundaryId: msg.uuid } : {}),
        trigger: meta.trigger ?? 'auto',
        preTokens: meta.pre_tokens ?? 0,
        postTokens,
        durationMs: meta.duration_ms ?? 0,
      },
      source: 'claude-code',
    });
    ctx.onCompactBoundary?.();
    return;
  }
  if (
    msg.subtype === 'task_started' ||
    msg.subtype === 'task_progress' ||
    msg.subtype === 'task_notification'
  ) {
    const update = toClaudeTaskUpdate(msg, ctx.rt, ctx.getSubagentTaskUsage);
    if (update) {
      queue.push({
        type: 'agent_task_update',
        data: update,
        source: 'claude-code',
      });
    }
    return;
  }
  // task_updated 是 tasks-panel 用的增量补丁(status / description / error),
  // 与上面三个事件共用 agent_task_update 通道 —— 下游 makerChatStore 按 taskId 做
  // 字段级 merge,故这里只需带上补丁里变化的字段。
  if (msg.subtype === 'task_updated') {
    const update = toClaudeTaskUpdatedPatch(msg, ctx.rt);
    if (update) {
      queue.push({
        type: 'agent_task_update',
        data: update,
        source: 'claude-code',
      });
    }
    return;
  }
}

function toClaudeTaskUsage(
  usage: Record<string, number | undefined> | undefined,
): AgentTaskUsage | undefined {
  if (!usage) return undefined;
  const out: AgentTaskUsage = {};
  if (typeof usage.total_tokens === 'number') out.totalTokens = usage.total_tokens;
  if (typeof usage.tool_uses === 'number') out.toolUses = usage.tool_uses;
  if (typeof usage.duration_ms === 'number') out.durationMs = usage.duration_ms;
  return Object.keys(out).length > 0 ? out : undefined;
}

function toClaudeTaskUpdate(msg: {
  subtype?: string;
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  prompt?: string;
  task_type?: string;
  workflow_name?: string;
  status?: string;
  output_file?: string;
  summary?: string;
  usage?: Record<string, number | undefined>;
  last_tool_name?: string;
  // SDK .d.ts 未声明、运行时存在的字段;无契约,必须经 normalize 收窄后才能下发。
  workflow_progress?: unknown;
}, rt: RuntimeState, getSubagentTaskUsage?: (taskId: string) => AgentTaskUsage | undefined): AgentTaskUpdateEventData | null {
  if (!msg.task_id) return null;
  const parentToolUseId = msg.tool_use_id
    ?? rt.subagentParentToolUseIdByTaskId.get(msg.task_id);
  if (parentToolUseId) {
    rt.subagentParentToolUseIdByTaskId.set(msg.task_id, parentToolUseId);
  }
  let status: AgentTaskStatus = 'running';
  if (msg.subtype === 'task_notification') {
    status = msg.status === 'failed' || msg.status === 'stopped' ? msg.status : 'completed';
  }
  if (parentToolUseId) {
    // 事件乱序防线（与 user 消息回执分支同一条不变量）：终态后的 task_started /
    // task_progress（恒 running）不得把内部终态登记降级回运行中。注意只挡 Map
    // 回写、不改事件投影——迟到的 running 帧仍按 running 下发，由下游
    // terminalBackgroundTaskIds 等按 taskId 的终态闩统一丢弃，两道闸口径一致。
    const previousStatus = rt.subagentStatusByParentToolUseId.get(parentToolUseId);
    const wouldDowngrade = status === 'running'
      && (previousStatus === 'completed' || previousStatus === 'failed' || previousStatus === 'stopped');
    if (!wouldDowngrade) {
      rt.subagentStatusByParentToolUseId.set(parentToolUseId, status);
    }
  }
  const sdkUsage = toClaudeTaskUsage(msg.usage);
  const hostUsage = msg.subtype === 'task_notification'
    ? getSubagentTaskUsage?.(msg.task_id)
    : undefined;
  // SDK 有非零统计时继续信任 SDK；只有明确为 0 / 缺失时才用 host 观测值修正。
  const usage = hostUsage && (sdkUsage?.totalTokens ?? 0) === 0
    ? { ...sdkUsage, totalTokens: hostUsage.totalTokens }
    : sdkUsage;
  const model = parentToolUseId
    ? rt.resolvedSubagentModelByParentToolUseId.get(parentToolUseId)
      ?? rt.streamModelByParentToolUseId.get(parentToolUseId)
    : undefined;
  if (parentToolUseId && model) {
    rt.publishedSubagentModelByParentToolUseId.set(parentToolUseId, model);
  }
  // CLI 对纯心跳帧节流省略该字段;收窄失败/缺失都不下发(undefined = 下游沿用上一帧)。
  const workflowProgress = normalizeWorkflowProgressEntries(msg.workflow_progress);
  const taskType = msg.task_type;
  const explicitlySubagent = taskType === 'local_agent' || taskType === 'remote_agent';
  const explicitlyExcluded = taskType === 'local_bash' || taskType === 'local_workflow';
  if (explicitlySubagent) {
    rt.confirmedSubagentTaskIds.add(msg.task_id);
    rt.excludedSubagentTaskIds.delete(msg.task_id);
  } else if (explicitlyExcluded && !rt.confirmedSubagentTaskIds.has(msg.task_id)) {
    rt.excludedSubagentTaskIds.add(msg.task_id);
  }
  const isExcludedTask =
    !rt.confirmedSubagentTaskIds.has(msg.task_id) &&
    (explicitlyExcluded || rt.excludedSubagentTaskIds.has(msg.task_id));
  const isKnownSubagent =
    !isExcludedTask &&
    (Boolean(parentToolUseId) || explicitlySubagent || rt.confirmedSubagentTaskIds.has(msg.task_id));
  const subagentObservation = !isExcludedTask && isKnownSubagent
    ? {
        kind:
          msg.subtype === 'task_started'
            ? 'spawn' as const
            : msg.subtype === 'task_notification'
              ? 'terminal' as const
              : 'progress' as const,
        logicalSubagentId: msg.task_id,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      }
    : undefined;
  return {
    provider: 'claude-code',
    taskId: msg.task_id,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    status,
    ...(msg.description ? { title: msg.description } : {}),
    ...(msg.prompt ? { description: msg.prompt } : {}),
    ...(msg.summary ? { summary: msg.summary } : {}),
    ...(msg.output_file ? { outputFile: msg.output_file } : {}),
    ...(msg.task_type ? { taskType: msg.task_type } : {}),
    ...(msg.workflow_name ? { workflowName: msg.workflow_name } : {}),
    ...(msg.last_tool_name ? { lastToolName: msg.last_tool_name } : {}),
    ...(usage ? { usage } : {}),
    ...(model ? { model } : {}),
    ...(workflowProgress ? { workflowProgress } : {}),
    ...(subagentObservation ? { subagentObservation } : {}),
  };
}

/**
 * SDKTaskUpdatedMessage(subtype: 'task_updated')→ AgentTaskUpdateEventData。
 *
 * task_updated 与 task_started/progress/notification 结构不同:它只带 task_id + patch
 * (无 tool_use_id / usage / workflow_name),是任务状态变化的增量补丁。下游 store 按
 * taskId 做字段级 merge,所以这里只回填补丁里真正变化的字段;缺失字段留给 merge 保留旧值。
 *
 * 关键:内部 AgentTaskStatus 恒为必填,而 patch.status 是可选的。若补丁里既无 status
 * 又无 error(纯 description / backgrounded 变更),直接返回 null 不下发 —— 否则会被迫
 * emit 一个 'running',把已到终态(completed/failed/stopped)的任务错误重置回运行中。
 */
function toClaudeTaskUpdatedPatch(msg: {
  task_id?: string;
  patch?: { status?: string; description?: string; error?: string };
}, rt: RuntimeState): AgentTaskUpdateEventData | null {
  if (!msg.task_id || !msg.patch) return null;
  const { status: rawStatus, description, error } = msg.patch;
  const hasStatus = typeof rawStatus === 'string' && rawStatus.length > 0;
  const hasError = typeof error === 'string' && error.length > 0;
  if (!hasStatus && !hasError) return null;
  const status = mapTaskUpdatedStatus(rawStatus, hasError);
  const parentToolUseId = rt.subagentParentToolUseIdByTaskId.get(msg.task_id);
  const isExcludedTask =
    !rt.confirmedSubagentTaskIds.has(msg.task_id) &&
    rt.excludedSubagentTaskIds.has(msg.task_id);
  const isKnownSubagent =
    !isExcludedTask &&
    (Boolean(parentToolUseId) || rt.confirmedSubagentTaskIds.has(msg.task_id));
  if (isKnownSubagent && parentToolUseId) {
    rt.subagentStatusByParentToolUseId.set(parentToolUseId, status);
  }
  return {
    provider: 'claude-code',
    taskId: msg.task_id,
    ...(parentToolUseId ? { parentToolUseId } : {}),
    status,
    ...(isKnownSubagent
      ? {
          subagentObservation: {
            kind: status === 'running' ? 'progress' : 'terminal',
            logicalSubagentId: msg.task_id,
            ...(parentToolUseId ? { parentToolUseId } : {}),
          },
        }
      : {}),
    ...(description ? { title: description } : {}),
    ...(hasError ? { summary: error } : {}),
  };
}

/**
 * patch.status(pending/running/completed/failed/killed)→ 内部 AgentTaskStatus。
 * killed → stopped;pending → running;无法识别的 status 但带 error → failed。
 */
function mapTaskUpdatedStatus(status: string | undefined, hasError: boolean): AgentTaskStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'killed':
      return 'stopped';
    case 'running':
    case 'pending':
      return 'running';
    default:
      return hasError ? 'failed' : 'running';
  }
}

// ── assistant 子分支 ─────────────────────────────────────────────────────────

/**
 * 只有不可见的 thinking 块不算 assistant 的实质产出。未知/新增块按有实质内容
 * 保守处理，避免 SDK 增加 server tool / control block 后被误判成 silent stop。
 */
function assistantBlockHasSubstance(block: Record<string, unknown>): boolean {
  if (block.type === 'text') {
    // Silent-stop 看上游有没有交出 text block，不看展示层清洗后还剩什么。
    // 整条只剩 `<|eos|>` 仍算正常收口；泄漏只在可见文本 / 落库路径隐藏。
    return typeof block.text === 'string' && block.text.length > 0;
  }
  if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    return false;
  }
  return true;
}

function handleAssistant(
  msg: {
    message?: { content?: Array<Record<string, unknown>> };
    error?: string;
    parent_tool_use_id?: string | null;
  },
  queue: EventQueue,
  ctx: TranslateContext,
): void {
  // agent-meta: 抽 SDK uuid / parent_tool_use_id / sdkSessionId / model / ...
  // 给本 turn 内所有 push 用；正常消息才缓存到 ctx.rt.lastAssistantMeta 给 stream_event 兜底
  // (mid-turn text_delta / message_delta 没有自己的 uuid, 落库时取最近一条 assistant
  // 的 meta 作为 fallback, 让 messages.agent_meta 行能被 fork/rewind 反查到)。
  const assistantMeta = extractAssistantMeta(msg);
  if (
    typeof assistantMeta.requestId === 'string' &&
    assistantMeta.requestId.startsWith('msg_vrtx_')
  ) {
    ctx.turn.lastAssistantRequestId = assistantMeta.requestId;
  }

  // SDK API-error envelope: msg.error 是 SDKAssistantMessageError tag
  // (invalid_request / authentication_failed / rate_limit / server_error /
  // billing_error / max_output_tokens / unknown), message.content 是 cc-code
  // 在 services/api/errors.ts 已经写好的人话解释 (PROMPT_TOO_LONG_ERROR_MESSAGE,
  // "Run /rewind to recover.", CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE 等)。
  // SDK 内部用 isApiErrorMessage 标识这条不是真 turn, 但跨 SDK JSON 边界这个
  // flag 没透出, 只剩 msg.error。这里早走两件事:
  //  1) 暂存人话错误详情,等最终 ResultMessage 决定是否报错。envelope 后 SDK
  //     仍可能自动重试成功,此时提前推 terminal error 会让 desktop / Slack 先
  //     收口当前 turn,后续成功结果无法修正;
  //  2) **不**把 content 里的 text 当普通 assistant text 推到 chat —— 旧实现
  //     会推, 导致同一条人话既出现在聊天气泡又出现在 banner, 而且作为普通
  //     assistant message 落库, 后续 fork/rewind 把它一起带走, 旧 session 的
  //     错误 envelope 就这样污染到新 session 了。
  if (msg.error) {
    const errorText = (msg.message?.content ?? [])
      .map((b) => {
        const blk = b as { type?: string; text?: string };
        return blk.type === 'text' && typeof blk.text === 'string' ? blk.text : '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    const errorMessage = errorText || `SDK error: ${msg.error}`;
    const errorSignals = extractNonSecretErrorSignals(errorMessage);
    ctx.turn.pendingApiError = {
      ...ctx.turn.pendingApiError,
      message: redactSensitiveText(errorMessage),
      sdkError: redactSensitiveText(msg.error),
      agentMeta: assistantMeta,
      ...(errorSignals.errorStatus !== undefined
        ? { errorStatus: errorSignals.errorStatus }
        : {}),
      ...(errorSignals.usageLimit ? { usageLimit: true } : {}),
    };
    return;
  }

  // 一条正常 assistant 消息证明先前 API-error envelope 已恢复；避免同一 turn
  // 后续另一次失败误用旧 envelope 的错误详情。错误 envelope 也不能成为
  // lastAssistantMeta，避免恢复后的 fallback text 错绑到错误消息的 transcript 锚点。
  ctx.turn.pendingApiError = null;
  ctx.rt.lastAssistantMeta = assistantMeta;

  const parentToolUseId = typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id
    ? msg.parent_tool_use_id
    : undefined;
  // 子代理完整 assistant 没有 message_delta 时，result.usage 仍含其子输出，
  // 而父级 Agent 工具区间已从分母排除。与 message_delta 路径同样 fail-closed。
  if (parentToolUseId) markClaudeGenerationUnreliable(ctx.rt.generation);
  // 完整 child assistant 是实际执行模型的正式观测来源。SDK 不保证 child 的
  // partial message_start 一定向外暴露，所以不能只靠 handleStreamEvent 填模型；
  // 同时保持 main 新增的 loop guard 按 parent scope 读取同一张 stream model 表。
  // resolvedModel 若已由启动回执给出仍保持更高优先级；这里把观测提升成 parent-linked
  // task update，让实时卡片与后续 task_notification 都能沿用同一个 actual model。
  const assistantModel = typeof assistantMeta.model === 'string' && assistantMeta.model
    ? assistantMeta.model
    : undefined;
  if (parentToolUseId && assistantModel) {
    ctx.rt.streamModelByParentToolUseId.set(parentToolUseId, assistantModel);
    const actualModel = ctx.rt.resolvedSubagentModelByParentToolUseId.get(parentToolUseId)
      ?? assistantModel;
    const publishedModel = ctx.rt.publishedSubagentModelByParentToolUseId.get(parentToolUseId);
    if (publishedModel !== actualModel) {
      let taskId: string | undefined;
      for (const [candidateTaskId, candidateParentId] of ctx.rt.subagentParentToolUseIdByTaskId) {
        if (candidateParentId !== parentToolUseId) continue;
        taskId = candidateTaskId;
        break;
      }
      if (!taskId) {
        // child assistant 可能早于稳定 taskId 到达。只保留模型观测，等后续生命周期
        // 事件用真实 taskId 发布，避免按 parentToolUseId 造出无法收口的第二条任务。
      } else {
        const status = ctx.rt.subagentStatusByParentToolUseId.get(parentToolUseId) ?? 'running';
        ctx.rt.publishedSubagentModelByParentToolUseId.set(parentToolUseId, actualModel);
        queue.push({
          type: 'agent_task_update',
          data: {
            provider: 'claude-code',
            taskId,
            parentToolUseId,
            status,
            model: actualModel,
            subagentObservation: {
              kind: status === 'running' ? 'progress' : 'terminal',
              logicalSubagentId: taskId,
              parentToolUseId,
            },
          },
          source: 'claude-code',
        });
      }
    }
  }

  const content = msg.message?.content ?? [];
  // silent-stop 观测素材: 本条消息是否带实质内容(非空 text / 非 thinking 块)。
  // 未知块 fail-safe 为有内容，避免 SDK 新 block 被误续跑。
  // 逐条覆盖写, turn end 时留下的就是最后一条 assistant 消息的判定(见 TurnState 字段注释)。
  ctx.turn.lastAssistantMsgHadSubstance = content.some(assistantBlockHasSubstance);
  for (const blockRaw of content) {
    const block = blockRaw as { type?: string; text?: string; name?: string; id?: string; input?: unknown; thinking?: string; signature?: string };
    if (block.type === 'text' && typeof block.text === 'string') {
      const parentStreamKey = parentToolUseId ?? '__main__';
      const prefix = `${parentStreamKey}:`;
      for (const key of ctx.rt.streamStopTokenByKey.keys()) {
        if (key === parentStreamKey || key.startsWith(prefix)) {
          ctx.rt.streamStopTokenByKey.delete(key);
        }
      }
      const visibleText = stripInternalWebCitations(block.text);
      ctx.turn.text += visibleText;
      if (visibleText.length > 0) {
        ctx.turn.hasEmittedText = true;
        ctx.turn.uiEmittedText += visibleText;
        queue.push({
          type: 'text',
          data: { text: visibleText, isFinal: true },
          source: 'claude-code',
          agentMeta: assistantMeta,
        });
      }
    } else if (block.type === 'tool_use') {
      ctx.turn.toolUses += 1;
      // ctx.log.info('SDK ▷ tool_use', {
      //   toolName: block.name,
      //   toolUseId: block.id,
      //   turnToolUses: ctx.turn.toolUses,
      // });
      const toolUseId = rememberClaudeToolUseId(ctx, block.id, block.name);
      if (toolUseId) {
        // 完整 assistant 消息已带工具参数,即使没有 stream_event 也可在此停表。
        pauseClaudeGenerationForToolUse(ctx, toolUseId);
        ctx.onToolUseStart?.(toolUseId, block.name, block.input, parentToolUseId);
      }
      queue.push({
        type: 'tool_use',
        data: {
          toolUseId: block.id,
          toolName: block.name,
          input: block.input,
        },
        source: 'claude-code',
        agentMeta: assistantMeta,
      });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      const cur = ctx.rt.currentThinking;
      const blockId = cur?.blockId ?? `thinking-${block.signature?.slice(0, 12) ?? Date.now()}`;
      const durationMs = cur ? Date.now() - cur.startedAt : 0;
      queue.push({
        type: 'thinking',
        data: { stage: 'final', blockId, text: block.thinking, durationMs },
        source: 'claude-code',
        agentMeta: assistantMeta,
      });
      ctx.rt.currentThinking = null;
    } else if (block.type === 'redacted_thinking') {
      const blockId = `redacted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      queue.push({
        type: 'thinking',
        data: { stage: 'redacted', blockId },
        source: 'claude-code',
        agentMeta: assistantMeta,
      });
    }
  }
}

function rememberClaudeToolUseId(
  ctx: TranslateContext,
  toolUseId: unknown,
  toolName: unknown,
): string | null {
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return null;
  const existingName = ctx.rt.toolUseIdToName.get(toolUseId);
  ctx.rt.toolUseIdToName.set(
    toolUseId,
    typeof toolName === 'string' && toolName.length > 0
      ? toolName
      : (existingName ?? ''),
  );
  return toolUseId;
}

function pauseClaudeGenerationForToolUse(
  ctx: TranslateContext,
  toolUseId: unknown,
): void {
  if (typeof toolUseId !== 'string' || toolUseId.length === 0) return;
  pauseClaudeGeneration(ctx.rt.generation, toolUseId);
}

function pauseClaudeGenerationForKnownTools(ctx: TranslateContext): void {
  for (const toolUseId of ctx.rt.toolUseIdToName.keys()) {
    pauseClaudeGenerationForToolUse(ctx, toolUseId);
  }
}

// ── stream_event 子分支(content_block_delta / message_delta / message_start) ──

function handleStreamEvent(
  msg: {
    event?: Record<string, unknown>;
    parent_tool_use_id?: string | null;
  },
  queue: EventQueue,
  ctx: TranslateContext,
): void {
  const event = msg.event as {
    type?: string;
    index?: number;
    delta?: Record<string, unknown>;
    usage?: Record<string, number>;
    message?: { model?: string; usage?: Record<string, number> };
    content_block?: { type?: string; id?: string; name?: string; input?: unknown };
  } | undefined;
  if (!event) return;

  const parentToolUseId = typeof msg.parent_tool_use_id === 'string' && msg.parent_tool_use_id
    ? msg.parent_tool_use_id
    : undefined;

  // 冗余 add: 防 SDK 顺序契约变化 (stream_event 先于 assistant message yield), Set 幂等。
  if (event.type === 'content_block_start') {
    const cb = event.content_block;
    if (cb && cb.type === 'text') {
      const blockIndex = typeof event.index === 'number' ? event.index : 0;
      ctx.rt.streamStopTokenByKey.delete(`${parentToolUseId ?? '__main__'}:${blockIndex}`);
    }
    if (cb && cb.type === 'tool_use') {
      const toolUseId = rememberClaudeToolUseId(ctx, cb.id, cb.name);
      if (toolUseId) {
        // watchdog / loop-guard 仍要立刻拿到 tool id。生成计时要等
        // message_delta 或完整 assistant tool_use: content_block_start
        // 早于参数 input_json_delta,这里停表会把参数生成时间从分母抠掉,
        // 而后续 message_delta 仍把这些 token 加进 outputTokens。
        ctx.onToolUseStart?.(toolUseId, cb.name, cb.input, parentToolUseId);
      }
    }
  }

  // SDKPartialAssistantMessage 自带 parent_tool_use_id；并发 subagent 会在同一 Query
  // 事件流中交错，必须按 parent 隔离模型，不能使用会话级 lastAssistantMeta 串联。
  // 老 SDK / 单测若没有 wrapper 元数据，才保留旧兜底行为。
  const parentStreamKey = parentToolUseId ?? '__main__';
  const blockIndex = typeof event.index === 'number' ? event.index : 0;
  const streamKey = `${parentStreamKey}:${blockIndex}`;
  const eventModel = event.message?.model;
  if (typeof eventModel === 'string' && eventModel) {
    ctx.rt.streamModelByParentToolUseId.set(parentStreamKey, eventModel);
  }
  const streamModel = typeof eventModel === 'string' && eventModel
    ? eventModel
    : ctx.rt.streamModelByParentToolUseId.get(parentStreamKey);
  const fallbackMeta: Record<string, unknown> | undefined = parentToolUseId
    ? {
        parentUuid: parentToolUseId,
        ...(streamModel ? { model: streamModel } : {}),
      }
    : ctx.rt.lastAssistantMeta
      ? {
          ...ctx.rt.lastAssistantMeta,
          ...(streamModel ? { model: streamModel } : {}),
        }
      : streamModel
        ? { model: streamModel }
        : undefined;

  if (event.type === 'content_block_delta') {
    const delta = event.delta as { type?: string; text?: string; thinking?: string } | undefined;
    if (!delta) return;
    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      const buffer = ctx.rt.streamStopTokenByKey.get(streamKey)
        ?? { pending: '', emitted: false };
      const visibleDelta = holdStandaloneStopTokenDelta(buffer, delta.text);
      ctx.rt.streamStopTokenByKey.set(streamKey, buffer);
      if (visibleDelta && visibleDelta.length > 0) {
        ctx.turn.hasEmittedText = true;
        ctx.turn.uiEmittedText += visibleDelta;
        queue.push({
          type: 'text',
          data: { text: visibleDelta, isFinal: false },
          source: 'claude-code',
          agentMeta: fallbackMeta,
        });
      }
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      // 第一次见 thinking_delta 时 lazy-init 一个 buffer (老链路 agentManager.ts:2322-2335)
      if (!ctx.rt.currentThinking) {
        const blockId = `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        ctx.rt.currentThinking = { blockId, startedAt: Date.now(), text: '' };
        queue.push({
          type: 'thinking',
          data: { stage: 'start', blockId, startedAt: ctx.rt.currentThinking.startedAt },
          source: 'claude-code',
          agentMeta: fallbackMeta,
        });
      }
      ctx.rt.currentThinking.text += delta.thinking;
      queue.push({
        type: 'thinking',
        data: {
          stage: 'delta',
          blockId: ctx.rt.currentThinking.blockId,
          text: delta.thinking,
        },
        source: 'claude-code',
        agentMeta: fallbackMeta,
      });
    }
    return;
  }

  if (event.type === 'message_delta') {
    // message_delta 是整条 assistant 消息(含工具参数 token)生成完毕后的
    // 第一个事件。在此停表,才能排除工具执行/审批等待,又不把参数生成
    // 区间从 tok/s 分母里抠掉。
    pauseClaudeGenerationForKnownTools(ctx);
    const usage = event.usage;
    if (usage) {
      const dIn = usage.input_tokens ?? 0;
      const dOut = usage.output_tokens ?? 0;
      const dCacheRead = usage.cache_read_input_tokens ?? 0;
      const dCacheCreate = usage.cache_creation_input_tokens ?? 0;
      // 累加进 tracker (跨多个 message_delta 会一直涨 —— 对标老 agentManager.ts:2362-2365
      // 的 session.currentTurn{Input,Output,CacheRead,CacheCreate}Tokens += dX)
      const segmentId =
        ctx.rt.activeUsageSegmentByParent.get(parentStreamKey) ??
        `claude:${++ctx.rt.usageSegmentSeq}:${parentStreamKey}`;
      ctx.rt.activeUsageSegmentByParent.set(parentStreamKey, segmentId);
      const priceVariant =
        ctx.rt.activeUsagePriceVariantByParent.get(parentStreamKey) ??
        ctx.rt.pendingUsagePriceVariantByParent.get(parentStreamKey) ??
        ctx.turn.nextRequestPriceVariant ??
        (ctx.getFastMode?.() ? 'priority' : 'standard');
      const hasCompleteUsageSnapshot = [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
      ].every((field) => Object.prototype.hasOwnProperty.call(usage, field));
      ctx.tracker.upsertApiCallUsage(segmentId, {
        id: segmentId,
        model: streamModel ?? ctx.getModel(),
        priceVariant,
        inputTokens: dIn,
        outputTokens: dOut,
        cacheReadTokens: dCacheRead,
        cacheCreateTokens: dCacheCreate,
        complete: hasCompleteUsageSnapshot,
      });
      if (parentToolUseId && dOut > 0) markClaudeGenerationUnreliable(ctx.rt.generation);
      // 每次 API 回合的 token 增量打一行 —— 一个 turn 可能多个 message_delta(工具循环),
      // 让人看日志能直观看到 token 是怎么涨上去的, 而不是只在 turn end 看到一个总数。
      ctx.log.debug('SDK ▷ token usage (message_delta)', {
        sdkSessionId: ctx.getSdkSessionId(),
        title: ctx.getLogTitle(),
        delta: { in: dIn, out: dOut, cacheRead: dCacheRead, cacheCreate: dCacheCreate },
        cumulative: ctx.tracker.snapshot(),
      });
      // 数值全部走 tracker.snapshot() —— 单一可信源, 不再自己拼
      const snap = ctx.tracker.snapshot();
      queue.push({
        type: 'status',
        data: ccLiveStatus(ctx, 'Generating...', true),
        source: 'claude-code',
      });
      // Maker Memory flush 观察 (A 轻版: 只打日志). 缺省没注册时 no-op。
      ctx.onUsageUpdate?.(snap.contextTokens, snap.contextWindow);
    }
    return;
  }

  if (event.type === 'message_start') {
    // 新 API call 开始, 清掉残留 thinking buffer。
    // message_start 内 message.model 是这一 API call 真实用的模型,
    // setModel 切换后这里会先反映出来 —— 打日志方便排查"为什么这一轮跑了别的模型"。
    ctx.rt.currentThinking = null;
    ctx.log.debug('SDK ▷ API call start (message_start)', {
      model: event.message?.model ?? ctx.getModel(),
    });
    ctx.turn.apiCalls += 1;
    const segmentId = `claude:${++ctx.rt.usageSegmentSeq}:${parentStreamKey}`;
    ctx.rt.activeUsageSegmentByParent.set(parentStreamKey, segmentId);
    const priceVariant =
      ctx.rt.pendingUsagePriceVariantByParent.get(parentStreamKey) ??
      ctx.turn.nextRequestPriceVariant ??
      (ctx.getFastMode?.() ? 'priority' : 'standard');
    ctx.rt.pendingUsagePriceVariantByParent.delete(parentStreamKey);
    ctx.rt.activeUsagePriceVariantByParent.set(parentStreamKey, priceVariant);

    // 第三方 proxy(如 litellm)或官方端点通常在 message_start 给出 input_tokens
    const usage = event.message?.usage as Record<string, number> | undefined;
    if (usage) {
      const dIn = usage.input_tokens ?? 0;
      const dCacheRead = usage.cache_read_input_tokens ?? 0;
      const dCacheCreate = usage.cache_creation_input_tokens ?? 0;
      if (dIn > 0 || dCacheRead > 0 || dCacheCreate > 0) {
        ctx.tracker.upsertApiCallUsage(segmentId, {
          id: segmentId,
          model: event.message?.model ?? streamModel ?? ctx.getModel(),
          priceVariant,
          inputTokens: dIn,
          outputTokens: 0,
          cacheReadTokens: dCacheRead,
          cacheCreateTokens: dCacheCreate,
          complete: false,
        });
      }
    }

    // 不清 tracker —— message_start 在 turn 中可能出现多次(工具循环每次 API call 都会触发),
    // 老链路 agentManager.ts:2400-2407 这里也是带 currentTurn 累计, 不重置。
    beginClaudeGeneration(ctx.rt.generation);
    queue.push({
      type: 'status',
      data: ccLiveStatus(ctx, 'Generating...', true),
      source: 'claude-code',
    });
    return;
  }
}

// ── result 子分支(turn end) ─────────────────────────────────────────────────

function handleResult(
  msg: {
    stop_reason?: string;
    is_error?: boolean;
    duration_ms?: number;
    duration_api_ms?: number;
    num_turns?: number;
    total_cost_usd?: number;
    terminal_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; costUSD?: number; contextWindow?: number }>;
    result?: string;
  },
  queue: EventQueue,
  ctx: TranslateContext,
): void {
  // 被打断 turn 的迟到 result, 且其后新 send 已接管(代际前进): 整条丢弃。
  // 不能走任何收尾 —— usage endTurn 会关错新 turn 的桶, status Done/done 会被
  // main 当作当前 turn 边界提前终结新 turn(见 TurnState.generation)。标记随
  // 消费清除;被打断 turn 的 usage 尾巴随之丢失(可接受: 打断路径自身已推过
  // 带 reason 的 terminal error, 记账以新 turn 为准)。
  if (
    msg.is_error &&
    ctx.turn.interruptRequested &&
    ctx.turn.generation !== ctx.turn.interruptGeneration
  ) {
    ctx.turn.interruptRequested = false;
    ctx.log.debug('dropping stale interrupted result (superseded by a newer send)', {
      generation: ctx.turn.generation,
      interruptGeneration: ctx.turn.interruptGeneration,
    });
    return;
  }
  const finalText = (typeof msg.result === 'string' && msg.result.length > 0)
    ? msg.result
    : ctx.turn.text;
  // 顶层 model 表示当前 runtime model; modelUsage 是累计分桶, 只作为诊断字段。
  const currentModel = ctx.getModel();
  const modelsUsed = msg.modelUsage ? Object.keys(msg.modelUsage) : [];

  // contextWindow: 优先取当前 model 的 modelUsage[model].contextWindow,
  // 否则按 model prefix 匹配, 再否则取 modelUsage 里最大的非零 contextWindow。
  // 完全对标 agentManager.ts:2600-2616 三段 fallback。
  // 0 表示"SDK 未给", renderer 端有 model prefix → 200K/1M 兜底。
  let contextWindow = 0;
  let contextWindowSource:
    | 'sdk:modelUsage:exact'
    | 'sdk:modelUsage:prefix'
    | 'sdk:modelUsage:max'
    | 'fallback:model-capability-config' = 'fallback:model-capability-config';
  let contextWindowFallbackReason = msg.modelUsage
    ? 'modelUsage.contextWindow missing'
    : 'modelUsage missing';
  if (msg.modelUsage) {
    const exact = msg.modelUsage[currentModel];
    if (exact?.contextWindow) {
      contextWindow = exact.contextWindow;
      contextWindowSource = 'sdk:modelUsage:exact';
      contextWindowFallbackReason = '';
    } else {
      const prefixEntry = Object.entries(msg.modelUsage).find(([k]) =>
        modelIdsMatchForContextWindow(currentModel, k),
      );
      if (prefixEntry?.[1]?.contextWindow) {
        contextWindow = prefixEntry[1].contextWindow;
        contextWindowSource = 'sdk:modelUsage:prefix';
        contextWindowFallbackReason = '';
      } else {
        for (const mu of Object.values(msg.modelUsage)) {
          const candidateWindow = mu.contextWindow ?? 0;
          if (candidateWindow > contextWindow) {
            contextWindow = candidateWindow;
            contextWindowSource = 'sdk:modelUsage:max';
            contextWindowFallbackReason = '';
          }
        }
      }
    }
  }
  // 窗口口径: catalog(host 按 agent 声明的 capabilities.availableModels[].contextWindow,
  // 经 ctx.getModelContextWindow 透传)是权威值, 但**只在以下两种情形**覆盖 SDK 上报值:
  //  (a) SDK 的窗口确实属于**当前模型**(modelUsage 里有 key 去 [1m] 后与当前模型完全相等
  //      且带正窗口)—— 这是折扣模型被 [1m] 误报 1M 的主场景, 用 catalog 锁回真实窗口
  //      (如 codex/gpt-5.5 cc=272k), 让 auto-compact / memory-flush 按真实窗口触发。
  //  (b) SDK 没给窗口或只给了 unknown-model 默认小窗口(≤200K)—— 升级到 catalog。
  // **不覆盖** SDK 给了某个**别的模型**的非默认窗口(>200K)的情形: 典型是 turn 运行中途切了
  // 模型(mutableModel 立即变, 但 msg.modelUsage 仍是产出本 result 的旧模型), 此时 SDK 窗口
  // 才是这一轮真实模型的窗口, 用 catalog(新模型)覆盖会把快照记错。
  // 关键: 判"属于当前模型"必须用**归一后严格相等**, 不能用 modelIdsMatchForContextWindow 的
  // startsWith 松匹配 —— 否则 `gpt-5.4-mini`(272k)会被当成当前 `gpt-5.4`(1M)的匹配, 切模型后
  // 把 mini 的 result 窗口错记成 1M(Codex P2)。[1m] 后缀差异由 normalize 去掉后仍相等。
  const configuredContextWindow = ctx.getModelContextWindow?.();
  const normalizedCurrentModel = normalizeModelForContextWindow(currentModel);
  const sdkWindowIsForCurrentModel =
    !!msg.modelUsage &&
    Object.entries(msg.modelUsage).some(
      ([k, mu]) =>
        normalizeModelForContextWindow(k) === normalizedCurrentModel && (mu?.contextWindow ?? 0) > 0,
    );
  const sdkWindowUnknownOrDefault = contextWindow <= 200_000; // 0=未给; ≤200K=unknown-model 默认
  if (
    typeof configuredContextWindow === 'number' &&
    configuredContextWindow > 0 &&
    configuredContextWindow !== contextWindow &&
    (sdkWindowIsForCurrentModel || sdkWindowUnknownOrDefault)
  ) {
    contextWindowFallbackReason =
      contextWindow > 0
        ? `configured contextWindow ${configuredContextWindow} overrides SDK modelUsage ${contextWindow}`
        : '';
    contextWindow = configuredContextWindow;
    contextWindowSource = 'fallback:model-capability-config';
  }
  ctx.tracker.setContextWindow(contextWindow);

  const resultUsage = msg.usage
    ? resultUsageToTurnDelta(ctx.rt.lastResultUsageAggregate, {
        inputTokens: msg.usage.input_tokens ?? 0,
        outputTokens: msg.usage.output_tokens ?? 0,
        cacheReadTokens: msg.usage.cache_read_input_tokens,
        cacheCreateTokens: msg.usage.cache_creation_input_tokens,
      })
    : undefined;
  // 记下覆盖前的真实 aggregate 基线: 空响应轮(result.usage 报 0)要在下方 empty-response
  // 守卫里**还原**它。否则基线被这 0 覆盖后, 下一个真实 turn 会拿 SDK 的累计 result.usage
  // 去减 0, 把整段历史 token 全算到那一轮、虚高单轮 usage/context 账务(Codex P2)。
  const aggregateBeforeThisResult = ctx.rt.lastResultUsageAggregate;
  if (msg.usage) {
    ctx.rt.lastResultUsageAggregate = {
      inputTokens: msg.usage.input_tokens ?? 0,
      outputTokens: msg.usage.output_tokens ?? 0,
      cacheReadTokens: msg.usage.cache_read_input_tokens,
      cacheCreateTokens: msg.usage.cache_creation_input_tokens,
    };
  }

  if (resultUsage) {
    ctx.tracker.ingestTurnAggregateCacheStats({
      inputTokens: resultUsage.inputTokens,
      cacheReadTokens: resultUsage.cacheReadTokens,
      cacheCreateTokens: resultUsage.cacheCreateTokens,
    });
  }

  // 空响应判定(提前到 endTurn 之前算): 本轮发起过 API call 但 0 产出(无 UI 文本 /
  // 无 result 兜底文本 / 无 tool 调用)且本轮 usage 增量全 0 —— 典型是模型网关(尤其折扣
  // 网关)在大上下文 / 高负载下短路返回 HTTP 200 + 空 SSE 流(input_tokens=0)。提前算的原因:
  //  (a) 让下面的 endTurn 在空响应轮**不要** replaceLastApi(守卫加 !isEmptyResponseTurn),
  //      否则会用本轮 0 增量覆盖 tracker.lastApi、把 contextTokens 清成 0 —— auto-compact /
  //      memory-flush / UI 环看不到真实 context, 用户重试会反复撞同一超限空响应而非先压缩。
  //      保留上一轮真实 lastApi 才能让护栏在空响应后仍按真实占用决策。
  //  (b) 收口处复用同一判定 surface terminal error。
  // 守卫: !is_error(is_error 另有 envelope/WARN, 不重复)、!sawCompactBoundary(compact-only
  //   空轮合法)、apiCalls>0(排除 "result 无 API call" 的合法退化, 见对应单测)。
  // usage 判 0 用 per-turn delta(resultUsage), **不能**用 msg.usage —— 后者是子进程 session
  // 累计值, 长会话本轮空响应时仍带历史非零 input_tokens 会漏判(正是长会话"假死"场景)。
  // result.usage 缺失(resultUsage=undefined)时**回退到 tracker 的本轮累计**, 而不是当成全 0:
  // 有些 provider 不在 result 报 usage, 但已通过 message_start / message_delta 上报并被
  // ingestApiCallUsage 累进 currentTurn。若此时当成全 0, "消耗了 token 但 result 没带 usage"
  // 的正常轮会被误判成空响应 terminal error(Codex P2)。tracker.getTurnUsage() 在 endTurn
  // 之前读到的正是本轮 streamed 累计;真正的空网关响应该累计也为 0, 不影响判定。
  const emitted = ctx.turn.uiEmittedText;
  const full = !msg.is_error && typeof msg.result === 'string'
    ? stripInternalWebCitations(msg.result)
    : '';
  let turnUsageDeltaAllZero: boolean;
  if (resultUsage) {
    turnUsageDeltaAllZero =
      resultUsage.inputTokens === 0 &&
      resultUsage.outputTokens === 0 &&
      (resultUsage.cacheReadTokens ?? 0) === 0 &&
      (resultUsage.cacheCreateTokens ?? 0) === 0;
  } else {
    const trackerTurn = ctx.tracker.getTurnUsage();
    turnUsageDeltaAllZero =
      trackerTurn.input === 0 &&
      trackerTurn.output === 0 &&
      trackerTurn.cacheRead === 0 &&
      trackerTurn.cacheCreate === 0;
  }
  const isEmptyResponseTurn =
    !msg.is_error &&
    !ctx.turn.sawCompactBoundary &&
    emitted.length === 0 &&
    full.length === 0 &&
    ctx.turn.toolUses === 0 &&
    ctx.turn.apiCalls > 0 &&
    turnUsageDeltaAllZero;

  // 上下文超限终态判定(提前到 endTurn 之前算, #1429): 超限请求被上游 400 整体拒绝,
  // 不返回 usage —— tracker.lastApi 停在上一次成功值(会话重启后首轮就失败则是 0),
  // 圆环显示低占用甚至 0%, auto-compact 的 ratio 永远到不了阈值, 会话进入
  // "超限 → 无 usage → 不压缩 → 重试再超限"的自锁。提前算的原因(与 isEmptyResponseTurn
  // 的提前同构):
  //  (a) 在 endTurn 前 markContextOverflow() 把 tracker 锁到窗口满载, endSnapshot 的
  //      contextTokens 如实反映"已超限"(status Done / done 事件跟随);
  //  (b) 下方 ctx.onUsageUpdate 用该 endSnapshot 把 ratio=1.0 喂给 auto-compact /
  //      memory-flush, turn end 即触发一次静默 /compact。best-effort: 压缩请求自身
  //      发送全量历史, 真超限时可能同样失败; 失败轮不产生 compact_boundary,
  //      AutoCompactController.fired 保持置位, 不会循环重压;
  //  (c) endTurn 的 replaceLastApi 守卫加 !isContextOverflowTurn: 失败轮的 usage delta
  //      通常为 0, 放任覆盖会把 (a) 刚锁上的满载值又冲回 0;
  //  (d) is_error 分支给 error 事件带 CONTEXT_OVERFLOW_REASON, renderer 按稳定 key
  //      隐藏必败的 Retry 并给出压缩 / 新开会话入口。
  // 判定文本 = result 原文 + pendingApiError.message(信息可能只在其一; pattern 只认
  // 错误措辞形态, 与 provider 无关)。interruptRequested 排除与下方 is_error 分支一致。
  const isContextOverflowTurn =
    Boolean(msg.is_error) &&
    !ctx.turn.interruptRequested &&
    isContextOverflowErrorMessage(
      `${typeof msg.result === 'string' ? msg.result : ''}\n${ctx.turn.pendingApiError?.message ?? ''}`,
    );
  if (isContextOverflowTurn) ctx.tracker.markContextOverflow();

  // turn 桶快照 — endTurn 会清掉 turn 桶, 必须在调用之前先取出来给后面日志用
  const preTurnEndCacheStats = ctx.tracker.getCacheStats();
  const turnUsageSegments = ctx.tracker.getTurnUsageSegments();
  const segmentTotals = turnUsageSegments.reduce<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  }>(
    (sum, segment) => ({
      inputTokens: sum.inputTokens + segment.inputTokens,
      outputTokens: sum.outputTokens + segment.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + (segment.cacheReadTokens ?? 0),
      cacheCreateTokens: sum.cacheCreateTokens + (segment.cacheCreateTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 },
  );
  const segmentsMatchResult = resultUsage
    ? segmentTotals.inputTokens === resultUsage.inputTokens &&
      segmentTotals.outputTokens === resultUsage.outputTokens &&
      segmentTotals.cacheReadTokens === (resultUsage.cacheReadTokens ?? 0) &&
      segmentTotals.cacheCreateTokens === (resultUsage.cacheCreateTokens ?? 0)
    : false;
  // Only declare request segments complete when an independent turn delta
  // proves that they cover every token bucket. A matching request count is not
  // enough: some providers report cache usage only in the terminal aggregate.
  // On the first result after resume that aggregate may still include history,
  // so a mismatch must fail closed to token-only accounting rather than price
  // an incomplete set of requests.
  const usageSegmentsComplete = segmentsMatchResult;
  const finalTextForLogs = msg.is_error ? redactSensitiveText(finalText) : finalText;

  // turn end usage 锁定: Claude Code result.usage 是 session aggregate,
  // 这里先转成 turn delta; tracker.endTurn 内部覆盖 currentTurn 然后返回 snapshot 再 reset。
  finalizeClaudeGeneration(ctx.rt.generation);
  const liveTurnOutput = resultUsage?.outputTokens ?? ctx.tracker.getTurnUsage().output;
  const liveGeneration = ctx.rt.generation;
  const endSnapshot = ctx.tracker.endTurn(
    resultUsage
      ? {
          inputTokens: resultUsage.inputTokens,
          outputTokens: resultUsage.outputTokens,
          cacheReadTokens: resultUsage.cacheReadTokens,
          cacheCreateTokens: resultUsage.cacheCreateTokens,
          costUsd: msg.total_cost_usd,
          // 空响应轮不 replaceLastApi: 否则用本轮 0 增量覆盖 lastApi, 丢掉上一轮真实 context。
          // 超限轮同理: markContextOverflow 刚锁上的满载值不能被失败轮的 0 增量冲掉。
          replaceLastApi:
            ctx.turn.apiCalls === 1 &&
            !ctx.turn.sawCompactBoundary &&
            !isEmptyResponseTurn &&
            !isContextOverflowTurn,
        }
      : undefined,
  );

  // Maker Memory flush / auto-compact 观察 — turn end 时用 endTurn 后的最终
  // contextTokens/contextWindow 算 ratio,否则 result-only cache tokens 会晚一轮触发。
  ctx.onUsageUpdate?.(endSnapshot.contextTokens, endSnapshot.contextWindow);

  // per-model cost 分桶 (覆盖语义, msg.modelUsage[model].costUSD 是子进程内累计)。
  // 不入 snapshot, 不影响 UI, 仅供日志与未来按模型展示。
  if (msg.modelUsage) {
    const modelCosts: Record<string, number> = {};
    for (const [model, mu] of Object.entries(msg.modelUsage)) {
      if (typeof mu.costUSD === 'number') modelCosts[model] = mu.costUSD;
    }
    ctx.tracker.ingestModelCosts(modelCosts);
  }

  // cache 命中率 — 同时打 turn / session 两个粒度, 排查第三方 proxy 透传问题用
  // (走 tracker.getCacheStats() 拿; 注意要在 endTurn() 之前调用, 否则 turn 桶已被清零)
  // 但本函数中 endTurn 已经在上面执行了, 这里读到的 turn 桶必然是空 —— 所以改成
  // 在 endTurn 之前先快照一份 turnCacheStats 出来, 这里只读 session。
  // ↑ 见下方 endTurn 调用前的 preTurnEndCacheStats。
  ctx.log.debug('SDK ◀ turn end (result)', {
    model: currentModel,
    modelsUsed: modelsUsed.length > 0 ? modelsUsed : undefined,
    effort: ctx.getEffort(),
    permissionMode: ctx.getPermissionMode(),
    stopReason: msg.stop_reason,
    terminalReason: msg.terminal_reason,
    isError: msg.is_error,
    durationMs: msg.duration_ms,
    durationApiMs: msg.duration_api_ms,
    numTurns: msg.num_turns,
    apiCalls: ctx.turn.apiCalls,
    costUsd: msg.total_cost_usd,
    inputTokens: msg.usage?.input_tokens,
    outputTokens: msg.usage?.output_tokens,
    cacheReadTokens: msg.usage?.cache_read_input_tokens,
    contextWindow,
    contextWindowSource,
    contextWindowFallbackReason: contextWindowFallbackReason || undefined,
    costByModel: ctx.tracker.getCostByModel(),
    cacheStats: {
      turn: formatCacheBucket(preTurnEndCacheStats.turn),
      session: formatCacheBucket(ctx.tracker.getCacheStats().session),
    },
    toolUses: ctx.turn.toolUses,
    output: finalTextForLogs || '<empty>',
  });
  // turn 以 error 结束时上面只有 DEBUG 落盘 — debug 关 (release 默认 info) 时用户
  // 上报的 maker.log 里会完全看不到这次失败 (API 限流 / 上游 5xx /
  // error_during_execution / context 超限等)。补一条 WARN 保证 info 级可见。
  if (msg.is_error) {
    ctx.log.warn('SDK ◀ turn ended with error', {
      stopReason: msg.stop_reason,
      terminalReason: msg.terminal_reason,
      durationMs: msg.duration_ms,
      output: finalTextForLogs || '<empty>',
    });
  }
  // 流式截断兜底(后缀 diff 版)—— 覆盖两种截断:
  //   ① 整轮全空:上游 SSE 首包后 stall,一个 text event 都没推过(uiEmittedText 空)。
  //   ② 末尾截断:前面 call 推过旁白(uiEmittedText 非空),但最后一次 call 的最终回复被截断,
  //      只在 result.result 里、没推过 UI —— e7ea882b 的 !hasEmittedText 守卫覆盖不到这种。
  // result.result 是 SDK 兜出的本 turn 完整 assistant 文本;uiEmittedText 是我们实际推给 UI 的部分。
  // 二者做前缀比对,只补 UI 缺的那段(fallbackTail),绝不重复 —— renderer 的 DUP-SKIP 只能挡
  // "完全相同",挡不住"整段 result 与已推旁白部分重叠",所以必须在这里精确切尾,不能整段补。
  //  - full(emitted 空)     : 补整段(= e7ea882b 原行为)
  //  - tail(full 以 emitted 为前缀且更长): 只补尾部 —— 修复盲区②
  //  - complete(full===emitted)          : 已完整,不补(绝大多数正常 turn 走这)
  //  - mismatch(前缀对不上)              : 保守不补,退化成现状(宁可漏补也不错乱/重复)
  // is_error 时整段不补:error envelope 文本走单独 error event/banner,补了会与 banner 重复。
  // 刻意不带 agentMeta:补推文本是"孤儿正文",lastAssistantMeta 当锚点会污染 fork/rewind。
  // emitted / full 已在上方(空响应判定处)算好, 这里复用。
  let fallbackTail = '';
  if (full.length > 0) {
    if (emitted.length === 0) {
      fallbackTail = full;
    } else if (full.startsWith(emitted)) {
      fallbackTail = full.slice(emitted.length);
    }
  }
  if (fallbackTail.length > 0) {
    queue.push({
      type: 'text',
      // fallbackTail 是「UI 尚未收到的追加段」，不是整条 assistant 全文。
      // 按 delta 发出才能在已有气泡中正确追加，随后的 done 负责收口。
      data: { text: fallbackTail, isFinal: false },
      source: 'claude-code',
    });
  }
  // silent-stop 判定: turn 内干过活(有 tool 调用),或整轮没有任何用户可见正文,且最后
  // 一条 assistant 消息没有实质内容(典型: 只有 thinking 块),result 也没兜出可补的
  // 文本 —— 上游把 turn 静默收了尾,用户侧表现为"干着干着停了、看起来像正常结束"。已知
  // 上游形态: 模型偶发 thinking-only 空响应(anthropics/claude-code#50597,
  // stop_reason=end_turn)与 SSE 流被静默中断后 SDK 按正常结束处理(#38905, 此形态
  // stop_reason 常缺失)。与 isEmptyResponseTurn(整轮 0 产出 + usage 全 0)互斥:
  // 零 tool 但零可见正文也必须命中:第一次自动补发「继续」后,上游可能再次只返回
  // thinking；旧的 toolUses > 0 守卫会把第二次当正常完成。已有可见正文的零 tool turn
  // 则不扩张判定。沿用 turn 收尾同款排除项: is_error(另有 error 收尾)、
  // interruptRequested(用户停止/watchdog)、sawCompactBoundary(compact 轮合法空)。
  // 命中后事件流仍走正常 Done/done 收尾(记账/收口零变更), 只在 done.data 附加
  // silentStop 标记交给 host 的自动续跑守卫决策; WARN 日志保留作 dev 排查。
  const isSilentStopTurn =
    !msg.is_error &&
    !ctx.turn.interruptRequested &&
    !ctx.turn.sawCompactBoundary &&
    !isEmptyResponseTurn &&
    (ctx.turn.toolUses > 0 || ctx.turn.uiEmittedText.length === 0) &&
    !ctx.turn.lastAssistantMsgHadSubstance &&
    fallbackTail.length === 0;
  if (isSilentStopTurn) {
    ctx.log.warn('SDK ◀ turn ended by silent stop (last assistant message had no content)', {
      model: currentModel,
      stopReason: msg.stop_reason ?? null,
      terminalReason: msg.terminal_reason,
      apiCalls: ctx.turn.apiCalls,
      toolUses: ctx.turn.toolUses,
      turnTextLen: ctx.turn.uiEmittedText.length,
      resultTextLen: full.length,
    });
  }
  // 空响应兜底: isEmptyResponseTurn 已在上方(endTurn 之前)算好并解释。命中即"本轮发起过
  // API call 但 0 产出且 usage 增量全 0", 典型是模型网关短路返回空 SSE。此前这种 turn 会
  // 静默走 Done, 用户侧表现为"发了消息啥也没发生 / 会话假死"。这里显式 surface 成 error。
  if (isEmptyResponseTurn) {
    ctx.log.warn('SDK ◀ turn produced empty response (0 content, usage all zero)', {
      model: currentModel,
      apiCalls: ctx.turn.apiCalls,
      stopReason: msg.stop_reason,
      terminalReason: msg.terminal_reason,
    });
    // 终态收尾: 只发一条 isTerminal error 就结束本 turn, **不再**发 status Done / done。
    // 这个零用量异常无需 done 记账。若在 terminal error 之后再发 done, 同一 turn
    // 会被下游双重收尾:
    //   - session.ts: done / 终止型 error 都会清 currentTurnOrigin, 先来的 terminal error
    //     清掉后, 后随 done 拿不到 origin → IM/orca 按 origin 收口的卡片永不 finalize。
    //   - register.ts: done→onTurnEnd 与 terminal error→onTurnAbort 同 turn 都触发。
    // 这里复用尾部的 resetTurnState + onTurnEnd 清理后 return。
    queue.push({
      type: 'error',
      data: {
        message:
          '模型返回了空响应(本轮未产出任何文本、未调用工具,且用量为 0)。多见于模型网关在大上下文 / 高负载下短路返回空流,请重试。',
        isTerminal: true,
        reason: 'empty-response',
      },
      source: 'claude-code',
    });
    // 还原 aggregate 基线: 本轮空响应的 result.usage(0)不能成为下一轮 delta 的基线,
    // 否则下一真实 turn 会从 0 起算、把整段历史 token 全算到那一轮(Codex P2)。
    ctx.rt.lastResultUsageAggregate = aggregateBeforeThisResult;
    resetTurnState(ctx.turn);
    resetClaudeGenerationTiming(ctx.rt.generation);
    ctx.onTurnEnd?.();
    return;
  }
  // is_error result 才是 API-error envelope 的权威终态。此前 envelope 会立即推
  // terminal error,即使 SDK 随后自动重试成功也会让下游提前收口；现在成功 result
  // 会在 resetTurnState 中丢弃 pendingApiError，失败 result 则在这里一次性报错。
  // 无 API-error envelope 的 is_error 也继续走同一兜底，避免 renderer 的 state.error
  // 不置位 →
  // running→stopped 的通知链路把这次失败当正常完成(桌面/飞书通知"已完成")。
  // 这里补一条 terminal error, 然后**继续**走下方 status Done + done 收尾——与
  // API-error envelope 场景的既有失败序列(error → status Done → done)完全同构,
  // 也与 codex 的 failed 序列(error → done)一致。不能砍掉 done: main 的花费记账
  // (register.ts 'done' && source='claude-code' 分支, daily/session/per-message
  // 四个 sink)只从 done 的 result payload(usage / modelUsage / total_cost_usd)
  // 读数, is_error turn 有真实消耗, 砍 done 会丢整轮账(Codex review P2)。
  // empty-response 轮不同: usage 全 0 无账可丢, 保持其"只发 error"的收尾不变。
  // interruptRequested(用户 stop / watchdog 主动 interrupt)也跳过: SDK 被 interrupt
  // 后 drain 出的 error_during_execution result 不是上游失败, 补 error 会把"用户点
  // 停止"误报成"执行失败"、并让 watchdog 场景双发 banner(见 TurnState 字段注释)。
  if (msg.is_error && !ctx.turn.interruptRequested) {
    const pendingApiError = ctx.turn.pendingApiError;
    const rawResult = typeof msg.result === 'string' ? msg.result.trim() : '';
    const resultSignals = extractNonSecretErrorSignals(rawResult);
    const errDetail = redactSensitiveText(rawResult);
    const errorStatus = resultSignals.errorStatus ?? pendingApiError?.errorStatus;
    const usageLimit = pendingApiError?.usageLimit === true || resultSignals.usageLimit;
    const errorMessage = pendingApiError?.agentMeta
      ? pendingApiError.message
      : errDetail || pendingApiError?.message;
    // 上下文超限带稳定 reason key(判定在上方 endTurn 前已算好): renderer 靠它
    // 隐藏必败的 Retry(原样重发必然再撞同一个 4xx)并给出压缩 / 新开会话入口;
    // 文案匹配仅作历史持久化错误行的兜底(overload reason 同款分层)。
    const overflowReason = isContextOverflowTurn ? { reason: CONTEXT_OVERFLOW_REASON } : {};
    queue.push({
      type: 'error',
      data: pendingApiError
        ? {
            message: errorMessage,
            sdkError: pendingApiError.sdkError,
            isTerminal: true,
            ...overflowReason,
            ...(errorStatus !== undefined ? { errorStatus } : {}),
            ...(usageLimit ? { usageLimit: true } : {}),
            ...(pendingApiError.retryAttempt !== undefined
              ? { retryAttempt: pendingApiError.retryAttempt }
              : {}),
            ...(pendingApiError.maxRetries !== undefined
              ? { maxRetries: pendingApiError.maxRetries }
              : {}),
          }
        : errDetail
        ? {
            message: errDetail,
            isTerminal: true,
            ...overflowReason,
            ...(errorStatus !== undefined ? { errorStatus } : {}),
            ...(usageLimit ? { usageLimit: true } : {}),
          }
        // reason 是稳定 key, renderer 按它走 i18n(规则 18); message 仅作非
        // renderer 消费方(IM/orca)的兜底文案。
        : { message: '任务执行失败（模型未返回错误详情）。', isTerminal: true, reason: 'turn-failed' },
      source: 'claude-code',
      ...(pendingApiError?.agentMeta ? { agentMeta: pendingApiError.agentMeta } : {}),
    });
  }
  // turn end status: isRunning=false + status='Done'; 数值全部走 endSnapshot
  queue.push({
    type: 'status',
    data: {
      status: 'Done',
      ...attachLiveGeneration(endSnapshot, {
        outputTokens: liveTurnOutput,
        closedDurationMs: liveGeneration.durationMs,
        openStartedAt: null,
        reliable: liveGeneration.reliable,
      }),
      isRunning: false,
    },
    source: 'claude-code',
  });
  // silentStop 标记随 done 透传给 host: main 的自动续跑守卫据此决策(补发「继续」或
  // surface 耗尽提示)。data 为 unknown 形状、既有消费方(记账 / IM / orca)均按需
  // typeof 读字段, 加字段零影响; 不命中时 done 与现状逐字节一致。
  const safeResult =
    msg.is_error && typeof msg.result === 'string'
      ? { ...msg, result: redactSensitiveText(msg.result) }
      : msg;
  const resultWithUsageSegments = {
    ...safeResult,
    usageSegments: turnUsageSegments,
    usageSegmentsComplete,
    modelUsageCumulativeStartsAtZero: ctx.modelUsageCumulativeStartsAtZero?.() === true,
  };
  const resultWithAssistantMessageId = ctx.turn.lastAssistantRequestId
    ? { ...resultWithUsageSegments, assistant_message_id: ctx.turn.lastAssistantRequestId }
    : resultWithUsageSegments;
  queue.push({
    type: 'done',
    data:
      isSilentStopTurn
        ? { ...resultWithAssistantMessageId, silentStop: true }
        : resultWithAssistantMessageId,
    source: 'claude-code',
  });
  // reset turn 累积 (tracker 内部已经在 endTurn 里 reset 了 currentTurn,这里只清非 usage 状态)
  resetTurnState(ctx.turn);
  ctx.rt.activeUsageSegmentByParent.clear();
  resetClaudeGenerationTiming(ctx.rt.generation);
  // turn 结束钩子 — agent 用来清 turnInFlight 标记 (rewind preview/commit 前置守卫读它)
  ctx.onTurnEnd?.();
}
