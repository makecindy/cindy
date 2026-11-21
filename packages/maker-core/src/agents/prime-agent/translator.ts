/**
 * Prime Agent RPC 事件 → Cindy `AgentEvent` 翻译层。
 *
 * 形状对齐 codex / pi translator(renderer 通用消费):
 *  - text:     { text, isFinal }            delta 追加 / final 全文 overwrite
 *  - thinking: { stage, blockId, text, startedAt?, durationMs? }
 *  - tool_use: { toolUseId, toolName, input }
 *  - tool_result_full: { toolUseId, fullText, isError }
 *  - tool_result:      { summary, toolUseIds }
 *  - status:   { status, ...UsageSnapshot 展开, isRunning }
 *  - done:     { type: 'prime-agent/agent_settled', requestUsage, ... }
 *
 * ## 核心难点: `agent_end` → `agent_settled` 合成
 *
 * Cindy 的 `translator`(pi 侧)只认 `agent_settled` 作为 turn 终态, `agent_end` 被显式忽略
 * (packages/maker-core/src/agents/pi/translator.ts:990-992 "可能跟 retry / compaction /
 * queued follow-up; 终态一律等 agent_settled")。而 Prime Agent 全仓 grep `agent_settled`
 * **0 命中**, 只有 `agent_end`。
 *
 * 这里把每个 `agent_end` 帧**重写**成 `agent_settled` 后送进同一条收口路径
 * (`translateSettledFrame`), 而不是在 `agent_end` 分支里复制一份收口逻辑 ——
 * 两个入口共用一条代码路径, 不存在漂移风险; 未来 Prime Agent 若补上 `agent_settled`,
 * 走的是同一个函数。
 *
 * ### 为什么「一个 agent_end == 一轮收口」在 Prime Agent 上成立
 *
 * `agent_end` 的唯一 emit 点是 `run_loop` 的终态: `run_loop` 的**每一条**退出路径都恰好
 * emit 一次 `AgentEnd` 后 return(crates/pa-agent/src/agent_loop/run.rs:84 / 119 / 147 /
 * 156 / 181 / 201 / 230 / 246), 入口 `entry.rs:31` 或 `:84` emit 一次 `AgentStart`。
 * steering / follow-up / continuation 消息都在 `run_loop` **内部**折叠(run.rs:209-241),
 * 不会另起一个 run —— 端到端用例因此断言 "one run, two turns, one `agent_end`"
 * (crates/pa-cli/tests/rpc_mode_e2e.rs:438-442)。
 *
 * 唯一会在一轮里出现第二个 run 的路径是 prompt 准入的 session command 的
 * `continuation_message`(crates/pa-daemon/src/rpc/prompt_commands.rs:194-201),
 * 它经 `prompt_injected_message` 另起一个 run; 那一轮仍然只产生**一个** `agent_end`
 * (前一个 run 从未启动)。
 *
 * `agent.rs:511` 的合成 `AgentEnd` 是 run 启动失败时的兜底终态, 同样只有一个。
 *
 * 换言之: Prime Agent 的 `agent_end` 语义 = pi 的 `agent_settled`, 而 pi 的 `agent_end`
 * (run 级) 在 Prime Agent 侧不存在独立事件。所以合成是语义等价, 不是近似。
 */

import { randomUUID } from 'node:crypto';
import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import type { StartSessionOptions } from '../base-agent.js';
import type { Logger } from '../../interfaces/logger.js';
import { nativeToolMediaFields } from '@cindy/maker-shared/tool-process-media';
import type { AgentEvent, UsageSnapshot } from '../../types/index.js';
import type { AgentKind } from '../../types/common.js';
import type { AsyncQueue } from '../shared/async-queue.js';
import { attachLiveGeneration } from '../shared/live-generation-snapshot.js';
import { TokenSpeedMeter } from '../shared/token-speed.js';
import { RequestUsageTracker, type UsageSegment } from '../shared/usage-tracker.js';
import type { PrimeAgentRpcEvent } from './rpc-client.js';

/**
 * Prime Agent 在 Cindy 侧的身份字面量。
 *
 * 两个 union 当前都是 `'claude-code' | 'codex' | 'pi'` 闭集, **没有** `'prime-agent'`:
 *   - `AgentKind`            — packages/maker-core/src/types/common.ts:8
 *   - `AgentEvent.source`    — packages/maker-core/src/types/events.ts
 * 本阶段按任务纪律不碰 `types/` 登记点(属于下一阶段), 所以这里本地声明字面量, 在赋值处
 * 收窄回原类型。下一阶段把 `'prime-agent'` 加进这两个 union 时, 这两个 cast 是整个
 * prime-agent 目录里**唯一**需要删掉的东西。
 */
export const PRIME_AGENT_SOURCE = 'prime-agent' as AgentEvent['source'];
export const PRIME_AGENT_KIND = 'prime-agent' as AgentKind;

/** Prime Agent assistant usage 的线形状(crates/pa-agent/src/types.rs `Usage`)。 */
interface PrimeAgentUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** Prime Agent assistant message 的线形状(`AssistantMessage`, serde camelCase)。 */
interface PrimeAgentAssistantMessage {
  role: 'assistant';
  content?: Array<Record<string, unknown>>;
  usage?: PrimeAgentUsage;
  /** provider-reported duration when the runtime supplies one. */
  duration?: number;
  /** generation-start wall-clock timestamp (milliseconds). */
  timestamp?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface PrimeAgentTranslateContext {
  logger: Logger;
  /** get_state 拿到的 contextWindow(模型切换时更新)。 */
  contextWindow: number;
  /** Applied compaction budget; separate from the native request capacity. */
  workingContextWindow?: number;
  /** turn 内累计 input+output; turn 结束 reset。 */
  turnTokens: number;
  /** turn 内 usage 分量累计(did-turn-end / ghost 订阅上报用); agent_start reset。 */
  turnInput: number;
  turnOutput: number;
  turnCacheRead: number;
  turnCacheWrite: number;
  requestUsageTracker: RequestUsageTracker;
  turnUsageSegments: UsageSegment[];
  turnUsageSegmentsComplete: boolean;
  turnUsageSegmentSeq: number;
  turnSettled: boolean;
  /** 最后一次 API call 的 context 占用(input + cacheRead + cacheWrite)。 */
  contextTokens: number;
  /** 跨 turn 累计成本。 */
  costUsd: number;
  /** agent run 是否进行中(send 的 streamingBehavior 判定也用它)。 */
  isStreaming: boolean;
  /** agent_start 代际; 主动停止只允许影响登记时所在的这一轮。 */
  turnGeneration: number;
  /** Host prompt 已发出、但对应 agent_start 尚未到达。 */
  pendingHostTurnStartToken: symbol | null;
  /** 当前 turn 内尚未被终态消费的 Host 主动停止请求。 */
  hostAbortRequestGeneration: number | null;
  hostAbortRequestTokens: Set<symbol>;
  /** Runtime-local namespace: persisted thinking IDs must not collide after context recreation. */
  thinkingIdPrefix: string;
  /** thinking 块序号(blockId 生成)。 */
  thinkingSeq: number;
  /** contentIndex → 当前消息内的 thinking block 状态。 */
  thinkingBlocks: Map<number, PrimeAgentThinkingBlock>;
  /**
   * 本 turn 最后一条 assistant 回复全文(正常 stop 即使无文字也覆盖; agent_start 重置)。
   * 用于 done.data.result —— 与 CC/Codex 对齐: register.ts 的 will-assistant-message
   * 出口钩子与 Orca worker 终态 finalText 都读 done.data.result。
   */
  finalAssistantText: string;
  /** Latest assistant stop reason for classifying the settled turn outcome. */
  finalAssistantStopReason: string | null;
  /**
   * Prime Agent 会先用 message_end(stopReason=error) 报 provider 错误。暂存到
   * agent_end 再终态上报, 避免一次可恢复错误提前收口整个 turn。
   */
  pendingAssistantError: PrimeAgentPendingAssistantError | null;
  /** A terminal provider error already emitted before agent_end. */
  terminalAssistantErrorEmitted: boolean;
  /** 整轮 wall-clock 起点; 只用于诊断, 不参与 TPS。 */
  turnWallClockStartedAt: number;
  /** Live tok/s shown in the status bar. */
  tokenSpeed: TokenSpeedMeter;
  /** Last running status text, reused by speed-only refreshes. */
  lastRunningStatus: string;
  generationDurationMs: number;
  /** Open generation interval start; 0 while tools/user waits own the turn. */
  generationOpenAt: number;
  /** False when any reported output lacks compatible parent generation timing. */
  generationTimingReliable: boolean;
  generationHeartbeatAt: number;
  generationHeartbeatTimer: ReturnType<typeof setInterval> | null;
  generationHeartbeatReliable: boolean;
  /**
   * 是否真的见过本轮的 `agent_start`。Prime Agent 在 run 启动失败时会**只**发合成
   * `agent_end`(crates/pa-agent/src/agent.rs:500-516), 没有配对的 agent_start;
   * 该标记让 translator 能区分「正常收口」与「无开始的兜底终态」。
   */
  sawAgentStart: boolean;
}

interface PrimeAgentThinkingBlock {
  blockId: string;
  startedAt: number;
  redacted: boolean;
}

interface PrimeAgentPendingAssistantError {
  message: string;
  sdkError: string;
  reason?: 'output-limit' | 'context-overflow' | 'stream-interrupted';
}

export function createPrimeAgentTranslateContext(logger: Logger): PrimeAgentTranslateContext {
  return {
    logger,
    contextWindow: 0,
    turnTokens: 0,
    turnInput: 0,
    turnOutput: 0,
    turnCacheRead: 0,
    turnCacheWrite: 0,
    requestUsageTracker: new RequestUsageTracker(),
    turnUsageSegments: [],
    turnUsageSegmentsComplete: true,
    turnUsageSegmentSeq: 0,
    turnSettled: false,
    contextTokens: 0,
    costUsd: 0,
    isStreaming: false,
    turnGeneration: 0,
    pendingHostTurnStartToken: null,
    hostAbortRequestGeneration: null,
    hostAbortRequestTokens: new Set(),
    thinkingIdPrefix: `prime-agent-think-${randomUUID()}`,
    thinkingSeq: 0,
    thinkingBlocks: new Map(),
    finalAssistantText: '',
    finalAssistantStopReason: null,
    pendingAssistantError: null,
    terminalAssistantErrorEmitted: false,
    turnWallClockStartedAt: 0,
    tokenSpeed: new TokenSpeedMeter(),
    lastRunningStatus: 'Working…',
    generationDurationMs: 0,
    generationOpenAt: 0,
    generationTimingReliable: true,
    generationHeartbeatAt: 0,
    generationHeartbeatTimer: null,
    generationHeartbeatReliable: true,
    sawAgentStart: false,
  };
}

export type PrimeAgentHostAbortRequestToken = symbol;
export type PrimeAgentHostTurnStartToken = symbol;

/** 在 prompt RPC 发出前登记其尚未到达的 agent_start。 */
export function markPrimeAgentHostTurnStartPending(
  ctx: PrimeAgentTranslateContext,
): PrimeAgentHostTurnStartToken {
  const token = Symbol('prime-agent-host-turn-start');
  ctx.pendingHostTurnStartToken = token;
  return token;
}

/** 明确得知 prompt 未启动时, 只撤销对应的待开始标记。 */
export function rollbackPrimeAgentHostTurnStart(
  ctx: PrimeAgentTranslateContext,
  token: PrimeAgentHostTurnStartToken,
): void {
  if (ctx.pendingHostTurnStartToken !== token) return;
  ctx.pendingHostTurnStartToken = null;
  // A stop requested before agent_start targets the pending generation. If the
  // matching prompt is later rejected, that generation never exists, so its
  // accepted stop must not be inherited by the next real turn.
  if (ctx.hostAbortRequestGeneration === ctx.turnGeneration + 1) {
    clearPrimeAgentHostAbortRequests(ctx);
  }
}

/**
 * 在 abort RPC 发出前登记 Host 主动停止, 避免 Prime Agent 的 aborted 终态先于 RPC
 * 回执到达。token 让并发或迟到的失败回滚只能撤销自己的请求。
 */
export function markPrimeAgentHostAbortRequested(
  ctx: PrimeAgentTranslateContext,
): PrimeAgentHostAbortRequestToken {
  const targetGeneration = !ctx.isStreaming && ctx.pendingHostTurnStartToken !== null
    ? ctx.turnGeneration + 1
    : ctx.turnGeneration;
  if (ctx.hostAbortRequestGeneration !== targetGeneration) {
    ctx.hostAbortRequestTokens.clear();
    ctx.hostAbortRequestGeneration = targetGeneration;
  }
  const token = Symbol('prime-agent-host-abort-request');
  ctx.hostAbortRequestTokens.add(token);
  return token;
}

/** Abort RPC 未被接受时回滚对应请求, 防止旧标记吞掉后续真实断流。 */
export function rollbackPrimeAgentHostAbortRequest(
  ctx: PrimeAgentTranslateContext,
  token: PrimeAgentHostAbortRequestToken,
): void {
  ctx.hostAbortRequestTokens.delete(token);
  if (ctx.hostAbortRequestTokens.size === 0) ctx.hostAbortRequestGeneration = null;
}

export function isCurrentTurnHostAbortRequested(
  ctx: PrimeAgentTranslateContext,
  includePendingTurn = false,
): boolean {
  // Native frames classify the started generation. Executor loss can also
  // terminate an idle pending prompt whose agent_start will never arrive.
  return ctx.hostAbortRequestTokens.size > 0 && (
    ctx.hostAbortRequestGeneration === ctx.turnGeneration ||
    (includePendingTurn && !ctx.isStreaming && ctx.pendingHostTurnStartToken !== null &&
      ctx.hostAbortRequestGeneration === ctx.turnGeneration + 1)
  );
}

function clearPrimeAgentHostAbortRequests(ctx: PrimeAgentTranslateContext): void {
  ctx.hostAbortRequestTokens.clear();
  ctx.hostAbortRequestGeneration = null;
}

const GENERATION_HEARTBEAT_MS = 5_000;
const GENERATION_SUSPEND_GAP_MS = 30_000;

function stopGenerationHeartbeat(ctx: PrimeAgentTranslateContext): void {
  if (ctx.generationHeartbeatTimer !== null) clearInterval(ctx.generationHeartbeatTimer);
  ctx.generationHeartbeatTimer = null;
  ctx.generationHeartbeatAt = 0;
  ctx.generationOpenAt = 0;
}

/** Release translator-owned resources when a session ends outside a normal turn boundary. */
export function disposePrimeAgentTranslateContext(ctx: PrimeAgentTranslateContext): void {
  stopGenerationHeartbeat(ctx);
  ctx.isStreaming = false;
  ctx.pendingHostTurnStartToken = null;
  clearPrimeAgentHostAbortRequests(ctx);
  ctx.pendingAssistantError = null;
  ctx.terminalAssistantErrorEmitted = false;
  ctx.thinkingBlocks.clear();
  ctx.sawAgentStart = false;
}

function sampleGenerationHeartbeat(ctx: PrimeAgentTranslateContext, now = Date.now()): void {
  if (
    ctx.generationHeartbeatAt > 0 &&
    now - ctx.generationHeartbeatAt > GENERATION_HEARTBEAT_MS + GENERATION_SUSPEND_GAP_MS
  ) {
    ctx.generationHeartbeatReliable = false;
    ctx.tokenSpeed.invalidate();
  }
  ctx.generationHeartbeatAt = now;
}

function startGenerationHeartbeat(ctx: PrimeAgentTranslateContext): void {
  stopGenerationHeartbeat(ctx);
  ctx.generationHeartbeatReliable = true;
  ctx.generationHeartbeatAt = Date.now();
  ctx.generationOpenAt = ctx.generationHeartbeatAt;
  const timer = setInterval(() => sampleGenerationHeartbeat(ctx), GENERATION_HEARTBEAT_MS);
  timer.unref?.();
  ctx.generationHeartbeatTimer = timer;
}

export function usageSnapshotOf(ctx: PrimeAgentTranslateContext): UsageSnapshot {
  return attachLiveGeneration(
    {
      requestUsage: ctx.requestUsageTracker.snapshot(),
      tokenUsage: ctx.turnTokens,
      contextTokens: ctx.contextTokens,
      contextWindow: ctx.workingContextWindow && ctx.workingContextWindow > 0
        ? Math.min(ctx.workingContextWindow, ctx.contextWindow)
        : ctx.contextWindow,
      costUsd: ctx.costUsd,
    },
    {
      tokenSpeed: ctx.tokenSpeed.snapshot(),
      outputTokens: ctx.turnOutput,
      durationMs: ctx.generationDurationMs,
      openStartedAt: ctx.generationOpenAt > 0 ? ctx.generationOpenAt : null,
      reliable: ctx.generationTimingReliable && ctx.generationHeartbeatReliable,
    },
  );
}

function pushStatus(
  queue: AsyncQueue<AgentEvent>,
  ctx: PrimeAgentTranslateContext,
  text: string,
  isRunning: boolean,
  extras?: Pick<AgentEvent, 'turnScope'>,
): void {
  if (isRunning) ctx.lastRunningStatus = text;
  queue.push({
    type: 'status',
    data: { status: text, ...usageSnapshotOf(ctx), isRunning },
    source: PRIME_AGENT_SOURCE,
    ...(extras?.turnScope ? { turnScope: extras.turnScope } : {}),
  });
}

/** Idle compact is not a product turn; mark it background so host/UI do not latch busy. */
function idleCompactScope(ctx: PrimeAgentTranslateContext): Pick<AgentEvent, 'turnScope'> | undefined {
  return ctx.isStreaming ? undefined : { turnScope: 'background' };
}

function latchCompactTurnScope(
  ctx: PrimeAgentTranslateContext,
): Pick<AgentEvent, 'turnScope'> | undefined {
  return idleCompactScope(ctx);
}

function applyUsage(
  ctx: PrimeAgentTranslateContext,
  usage: PrimeAgentUsage | undefined,
  model?: string,
): void {
  if (!usage) return;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  ctx.turnTokens += input + output;
  ctx.turnInput += input;
  ctx.turnOutput += output;
  ctx.turnCacheRead += cacheRead;
  ctx.turnCacheWrite += cacheWrite;
  ctx.contextTokens = input + cacheRead + cacheWrite;
  const cost = usage.cost?.total;
  if (typeof cost === 'number' && Number.isFinite(cost)) ctx.costUsd += cost;
  ctx.requestUsageTracker.ingest({
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheWrite,
  });
  ctx.turnUsageSegments.push({
    id: `prime-agent:${++ctx.turnUsageSegmentSeq}`,
    ...(model ? { model } : {}),
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreateTokens: cacheWrite,
    ...(typeof cost === 'number' && Number.isFinite(cost) ? { costUsd: cost } : {}),
  });
}

function assistantTextOf(message: PrimeAgentAssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Prime Agent 的显式请求失败, 区别于裸 abort 或 Host 主动停止。
 * `errorMessage` 由 provider 层写入(run.rs:76-89 的 StopReason::Error 分支)。
 */
function isAbortedRequest(error: string): boolean {
  return /^Request was aborted[.!]?$/i.test(error.trim());
}

function assistantErrorOf(rawError: string): PrimeAgentPendingAssistantError {
  const error = rawError.trim() || 'Prime Agent request failed';
  const reason: PrimeAgentPendingAssistantError['reason'] =
    /context (length|window)|too long|maximum context/i.test(error)
      ? 'context-overflow'
      : isAbortedRequest(error) || /interrupt|reset|econnreset|socket hang up/i.test(error)
        ? 'stream-interrupted'
        : undefined;
  return { message: error, sdkError: error, ...(reason ? { reason } : {}) };
}

/** A provider error Prime Agent reports at message_end(stopReason=error). */
function isTransientAssistantFailure(message: PrimeAgentAssistantMessage): boolean {
  if (message.stopReason === 'error') return true;
  if (message.stopReason !== 'aborted') return false;
  const errorMessage = message.errorMessage?.trim() ?? '';
  return errorMessage.length > 0 && (isAbortedRequest(errorMessage)
    || /interrupt|reset|econnreset|socket hang up|network/i.test(errorMessage));
}

/** Prime Agent 的 compaction_end: `result` 为 null 即跳过/失败, 不是压缩成功。 */
export function isFailedOrAbortedPrimeAgentCompaction(
  event: Pick<PrimeAgentRpcEvent, 'type'> & { aborted?: unknown; result?: unknown },
): boolean {
  if (event.type !== 'compaction_end') return false;
  if (event.aborted === true) return true;
  return event.result == null;
}

/**
 * 是否是「宿主请求的」压缩。Prime Agent 的 `compaction_frame` 只产 `reason:"requested"`
 * (crates/pa-daemon/src/rpc/commands.rs:465-484) —— 无论是 `compact` RPC 还是 prompt
 * 准入的 `/compact`, 走的都是这一个 reason。
 */
function isRequestedCompaction(event: PrimeAgentRpcEvent): boolean {
  return event.reason === 'requested';
}

function toolResultFullText(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'object' && item !== null) {
      const rec = item as Record<string, unknown>;
      if (rec.type === 'text' && typeof rec.text === 'string') parts.push(rec.text);
      else if (rec.type === 'image') parts.push('[image]');
    }
  }
  return parts.join('\n');
}

/**
 * `agent_end` 的 `messages` 是本次 run 的完整消息表(crates/pa-agent/src/types.rs
 * `AgentEvent::AgentEnd { messages }`)。当某条 assistant `message_end` 因帧丢失
 * 没被翻译到时, 用它兜底恢复 `done.data.result` —— Host 的出口钩子靠这个字段。
 */
function fallbackAssistantTextFromRun(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue;
    const rec = message as Record<string, unknown>;
    if (rec.role !== 'assistant') continue;
    const content = rec.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const item = block as Record<string, unknown>;
      if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
        parts.push(item.text);
      }
    }
  }
  return parts.join('\n\n');
}

/** 主入口: 一帧 Prime Agent RPC 事件 → 0..n 个 AgentEvent。 */
export function translatePrimeAgentEvent(
  event: PrimeAgentRpcEvent,
  queue: AsyncQueue<AgentEvent>,
  ctx: PrimeAgentTranslateContext,
): void {
  switch (event.type) {
    case 'agent_start': {
      ctx.turnGeneration += 1;
      ctx.sawAgentStart = true;
      ctx.pendingHostTurnStartToken = null;
      if (ctx.hostAbortRequestGeneration !== ctx.turnGeneration) {
        clearPrimeAgentHostAbortRequests(ctx);
      }
      ctx.isStreaming = true;
      ctx.turnTokens = 0;
      ctx.turnInput = 0;
      ctx.turnOutput = 0;
      ctx.turnCacheRead = 0;
      ctx.turnCacheWrite = 0;
      ctx.turnUsageSegments = [];
      ctx.turnUsageSegmentsComplete = true;
      ctx.turnUsageSegmentSeq = 0;
      ctx.turnSettled = false;
      ctx.finalAssistantText = '';
      ctx.finalAssistantStopReason = null;
      ctx.pendingAssistantError = null;
      ctx.terminalAssistantErrorEmitted = false;
      ctx.turnWallClockStartedAt = Date.now();
      ctx.tokenSpeed.reset();
      ctx.generationDurationMs = 0;
      ctx.generationTimingReliable = true;
      stopGenerationHeartbeat(ctx);
      ctx.thinkingBlocks.clear();
      pushStatus(queue, ctx, 'Working…', true);
      return;
    }

    case 'turn_start':
      return;

    case 'message_start': {
      // Prime Agent also starts user prompts and tool results; only assistant
      // messages are model requests that open generation timing.
      const role = (event.message as { role?: string } | undefined)?.role;
      if (role && role !== 'assistant') return;
      ctx.thinkingBlocks.clear();
      startGenerationHeartbeat(ctx);
      pushStatus(queue, ctx, 'Working…', true);
      return;
    }

    case 'message_update': {
      const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!delta || typeof delta.type !== 'string') return;
      observeTokenSpeed(delta, queue, ctx);
      handleAssistantDelta(delta, queue, ctx);
      return;
    }

    case 'message_end': {
      const message = event.message as PrimeAgentAssistantMessage | undefined;
      if (!message || message.role !== 'assistant') return;
      applyUsage(ctx, message.usage, message.model);
      const hadGenerationHeartbeat = ctx.generationHeartbeatAt > 0;
      sampleGenerationHeartbeat(ctx);
      const messageDurationMs =
        typeof message.duration === 'number' &&
        Number.isFinite(message.duration) &&
        message.duration > 0
          ? message.duration
          : hadGenerationHeartbeat &&
              ctx.generationHeartbeatReliable &&
              typeof message.timestamp === 'number' &&
              Number.isFinite(message.timestamp) &&
              message.timestamp > 0
            ? Date.now() - message.timestamp
            : 0;
      stopGenerationHeartbeat(ctx);
      if (messageDurationMs > 0) {
        ctx.generationDurationMs += messageDurationMs;
      } else if ((message.usage?.output ?? 0) > 0) {
        // A single untimed output-bearing message makes the whole turn's TPS
        // denominator partial. Keep token/cost accounting, but do not publish it.
        ctx.generationTimingReliable = false;
      }
      const fullText = assistantTextOf(message);
      ctx.finalAssistantStopReason = typeof message.stopReason === 'string'
        ? message.stopReason
        : null;
      const hostInitiatedAbort = message.stopReason === 'aborted'
        && isCurrentTurnHostAbortRequested(ctx);
      const transientAssistantFailure = !hostInitiatedAbort && isTransientAssistantFailure(message);
      if (transientAssistantFailure) {
        const rawError = message.errorMessage?.trim() || fullText.trim()
          || 'Prime Agent request failed';
        ctx.pendingAssistantError = assistantErrorOf(rawError);
      } else {
        // A normal assistant message proves an earlier provider failure recovered.
        ctx.pendingAssistantError = null;
      }
      // A successful but empty final request must not inherit progress from an
      // earlier tool round; settlement needs to see it for bounded silent-stop recovery.
      if (!transientAssistantFailure && message.stopReason === 'stop') {
        ctx.finalAssistantText = fullText;
      }
      if (!transientAssistantFailure && fullText.length > 0) {
        // 覆盖为本 turn 最新一条有文本的 assistant 回复, agent_end 作 done.result 上报。
        ctx.finalAssistantText = fullText;
        queue.push({
          type: 'text',
          data: { text: fullText, isFinal: true, isFullText: true },
          source: PRIME_AGENT_SOURCE,
          agentMeta: {
            model: message.model,
            stopReason: message.stopReason,
            usage: message.usage,
          },
        });
      }
      pushStatus(queue, ctx, 'Working…', true);
      return;
    }

    case 'tool_execution_start': {
      const toolUseId = String(event.toolCallId ?? '');
      const toolName = String(event.toolName ?? 'tool');
      const toolArgs = (event.args as Record<string, unknown>) ?? {};
      queue.push({
        type: 'tool_use',
        data: {
          toolUseId,
          ...parseMessageToolUse({
            role: 'tool_use',
            content: { toolName, input: toolArgs },
            toolUseId,
          }),
        },
        source: PRIME_AGENT_SOURCE,
      });
      pushStatus(queue, ctx, `Running ${toolName}…`, true);
      return;
    }

    // Prime Agent 发 tool_execution_progress / tool_execution_update, 但没有子代理
    // 进度子协议 —— 均忽略(工具的实时状态由 tool_use / tool_result_full 承载)。
    case 'tool_execution_update':
    case 'tool_execution_progress':
      return;

    case 'tool_execution_end': {
      const toolUseId = String(event.toolCallId ?? '');
      const isError = event.isError === true;
      const fullText = toolResultFullText(event.result);
      const toolName = String(event.toolName ?? '');
      queue.push({
        type: 'tool_result_full',
        data: {
          toolUseId,
          fullText,
          isError,
          ...nativeToolMediaFields((event.result as { content?: unknown } | null)?.content),
        },
        source: PRIME_AGENT_SOURCE,
      });
      queue.push({
        type: 'tool_result',
        data: { summary: isError ? 'failed' : 'done', toolUseIds: [toolUseId] },
        source: PRIME_AGENT_SOURCE,
      });
      if (toolName) pushStatus(queue, ctx, `Running ${toolName}…`, true);
      return;
    }

    case 'turn_end':
      // Prime Agent 的 turn_end 只在每个 assistant turn 边界发(run.rs:113-117),
      // 不是 turn 终态; usage 已由 message_end 计入。忽略。
      return;

    // ---- Prime Agent 的 turn 终态 → 合成 agent_settled (见文件头说明) ----
    case 'agent_end': {
      if (!ctx.sawAgentStart) {
        // run 启动失败的兜底终态(crates/pa-agent/src/agent.rs:500-516): 没有配对的
        // agent_start, Host 侧也没有对应 turn 需要收口。记录后仍然收口一次, 保证
        // 任何挂起的 Host turn 状态机能出去。
        ctx.logger.warn('prime-agent agent_end without a matching agent_start', {
          turnGeneration: ctx.turnGeneration,
        });
      }
      translateSettledFrame(event, queue, ctx);
      return;
    }

    // 前向兼容: 未来版本若补上 agent_settled, 走同一条收口路径。
    case 'agent_settled': {
      translateSettledFrame(event, queue, ctx);
      return;
    }

    case 'compaction_start': {
      pushStatus(queue, ctx, 'Compacting context…', true, latchCompactTurnScope(ctx));
      return;
    }

    case 'compaction_end': {
      const compactScope = idleCompactScope(ctx);
      if (isFailedOrAbortedPrimeAgentCompaction(event)) {
        // 失败/跳过不是压缩边界。请求式压缩仍要收口 Compacting 状态, 避免圆环卡 running。
        if (isRequestedCompaction(event) && !ctx.isStreaming) {
          pushStatus(queue, ctx, 'Done', false, compactScope);
        }
        return;
      }
      const result = event.result as
        | { tokensBefore?: number; estimatedTokensAfter?: number }
        | null;
      queue.push({
        type: 'compact_boundary',
        data: {
          // Prime Agent 的 compaction 帧**只有** `reason:"requested"`
          // (crates/pa-daemon/src/rpc/commands.rs:465-484 `compaction_frame`) ——
          // 没有 pi 的 'manual' / 'threshold' 之分。`requested` 就是宿主发起的手动压缩;
          // 其它值(未来版本)才当 auto。
          trigger: isRequestedCompaction(event) ? 'manual' : 'auto',
          preTokens: result?.tokensBefore,
          postTokens: result?.estimatedTokensAfter,
        },
        source: PRIME_AGENT_SOURCE,
        ...compactScope,
      });
      if (result && typeof result.estimatedTokensAfter === 'number') {
        ctx.contextTokens = result.estimatedTokensAfter;
      }
      // 请求式压缩事件必须闭环: compaction_start 已把 isRunning 置 true, 若不收口,
      // renderer 圆环会永久卡 running、新 contextTokens 也送不回去。仅非流式中收口;
      // 会话内压缩发生在活跃 turn 内(turn 结束经 agent_end 自然收口)。
      if (isRequestedCompaction(event) && !ctx.isStreaming) {
        pushStatus(queue, ctx, 'Done', false, compactScope);
      }
      return;
    }

    // Prime Agent 会发的非 turn 事件: 都不影响 AgentEvent 流。
    case 'goal_update':
    case 'thinking_level_changed':
    case 'session_info_changed':
      return;

    default:
      ctx.logger.warn('prime-agent translator: unhandled event dropped', { type: event.type });
  }
}

/**
 * turn 收口的唯一路径。`agent_end`(以及未来可能的 `agent_settled`)都重写进这里。
 *
 * 与 pi 的 `agent_settled` 分支同构: 先按最终 assistant 消息分类终态(failed /
 * cancelled / completed), 需要时先 push 一条 terminal error, 再 push done, 最后把
 * status 收成 Done(isRunning=false)。
 */
function translateSettledFrame(
  event: PrimeAgentRpcEvent,
  queue: AsyncQueue<AgentEvent>,
  ctx: PrimeAgentTranslateContext,
): void {
  if (ctx.turnSettled) return;
  ctx.turnSettled = true;
  ctx.isStreaming = false;
  ctx.tokenSpeed.stop(ctx.turnOutput);
  stopGenerationHeartbeat(ctx);
  const hostAbortRequested = isCurrentTurnHostAbortRequested(ctx);
  const pendingAssistantError = hostAbortRequested ? null : ctx.pendingAssistantError;
  if (ctx.finalAssistantText.trim().length === 0) {
    // 兜底: 某条 assistant message_end 帧丢失时, 用 run 级 messages 恢复 result。
    const fallback = fallbackAssistantTextFromRun(event.messages);
    if (fallback.length > 0) ctx.finalAssistantText = fallback;
  }
  // Classify the final assistant message at settlement, after the run folded its
  // queued steering / follow-up / continuation messages. A host Stop still wins.
  const outputLimited = !hostAbortRequested
    && !ctx.terminalAssistantErrorEmitted
    && ctx.finalAssistantStopReason === 'length';
  const usage = {
    inputTokens: ctx.turnInput,
    outputTokens: ctx.turnOutput,
    cacheReadTokens: ctx.turnCacheRead,
    cacheCreationTokens: ctx.turnCacheWrite,
    segments: ctx.turnUsageSegments.map((segment) => ({ ...segment })),
    segmentsComplete: ctx.turnUsageSegmentsComplete,
    // durationMs is deliberately generation-only. If Prime Agent does not report
    // a per-assistant generation duration, omit it instead of charging tool
    // execution / user waits to TPS.
    ...(ctx.generationTimingReliable && ctx.generationDurationMs > 0
      ? { durationMs: ctx.generationDurationMs }
      : {}),
    ...(ctx.turnWallClockStartedAt > 0
      ? { turnDurationMs: Math.max(0, Date.now() - ctx.turnWallClockStartedAt) }
      : {}),
  };
  const terminalError = pendingAssistantError ?? (outputLimited ? {
    message: 'Prime Agent reached the model output limit. The response may be incomplete.',
    sdkError: 'Prime Agent response stopped at the model output limit',
    reason: 'output-limit' as const,
    // Consumers may settle on this error and ignore the paired done.
    result: ctx.finalAssistantText,
    usage,
  } : null);
  const outcome = terminalError
    ? 'failed'
    : hostAbortRequested || ctx.finalAssistantStopReason === 'aborted'
      ? 'cancelled'
      : 'completed';
  ctx.pendingAssistantError = null;
  clearPrimeAgentHostAbortRequests(ctx);
  if (terminalError) {
    queue.push({
      type: 'error',
      data: { ...terminalError, isTerminal: true },
      source: PRIME_AGENT_SOURCE,
    });
  }
  const silentStop = outcome === 'completed'
    && !hostAbortRequested
    && pendingAssistantError === null
    && !ctx.terminalAssistantErrorEmitted
    && ctx.finalAssistantText.trim().length === 0;
  if (silentStop) {
    ctx.logger.warn('prime-agent turn settled without a user-facing assistant reply', {
      turnGeneration: ctx.turnGeneration,
      inputTokens: ctx.turnInput,
      outputTokens: ctx.turnOutput,
    });
  }
  queue.push({
    type: 'done',
    data: {
      type: 'prime-agent/agent_settled',
      requestUsage: ctx.requestUsageTracker.snapshot(),
      // 本 turn 最终 assistant 回复文本。与 CC/Codex 的 done.data.result 对齐:
      // register.ts 的 will-assistant-message 出口钩子与 Orca worker 终态 finalText
      // 都读 done.data.result, 不带上就会对 Prime Agent 静默跳过这些钩子。
      result: outputLimited || outcome === 'completed' ? ctx.finalAssistantText : '',
      status: outcome,
      ...(silentStop ? { silentStop: true } : {}),
      // ghost 订阅 did-turn-end 的 usage 上报(subscriptionGateway.normalizeTurnUsage
      // 认 camelCase); 与 CC/Codex 的 done.usage 对齐。
      usage,
    },
    source: PRIME_AGENT_SOURCE,
  });
  // 与 Claude/Codex 的 turn-end status 契约一致: Desktop main 以
  // isRunning=false + status=Done 持久化 context 快照。
  pushStatus(queue, ctx, 'Done', false);
}

/** Mirrors pi-token-speed's message_update handlers. */
function observeTokenSpeed(
  delta: Record<string, unknown>,
  queue: AsyncQueue<AgentEvent>,
  ctx: PrimeAgentTranslateContext,
): void {
  if (!ctx.isStreaming) return;
  switch (delta.type) {
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
      ctx.tokenSpeed.start();
      return;
    case 'toolcall_delta':
    case 'text_delta':
    case 'thinking_delta':
      if (typeof delta.delta === 'string' && ctx.tokenSpeed.recordDelta(delta.delta)) {
        pushStatus(queue, ctx, ctx.lastRunningStatus, true);
      }
      return;
    case 'toolcall_end':
      ctx.tokenSpeed.pause();
      return;
  }
}

function handleAssistantDelta(
  delta: Record<string, unknown>,
  queue: AsyncQueue<AgentEvent>,
  ctx: PrimeAgentTranslateContext,
): void {
  const contentIndex = typeof delta.contentIndex === 'number' ? delta.contentIndex : 0;

  switch (delta.type) {
    case 'text_delta': {
      if (typeof delta.delta === 'string' && delta.delta.length > 0) {
        queue.push({ type: 'text', data: { text: delta.delta, isFinal: false }, source: PRIME_AGENT_SOURCE });
      }
      return;
    }

    case 'thinking_start': {
      ensureThinkingBlock(
        contentIndex,
        queue,
        ctx,
        isRedactedThinkingDelta(delta, contentIndex),
      );
      return;
    }

    case 'thinking_delta': {
      const redacted = isRedactedThinkingDelta(delta, contentIndex);
      const block = ensureThinkingBlock(contentIndex, queue, ctx, redacted);
      if (redacted && !block.redacted) {
        block.redacted = true;
        queue.push({
          type: 'thinking',
          data: { stage: 'redacted', blockId: block.blockId },
          source: PRIME_AGENT_SOURCE,
        });
        return;
      }
      if (block.redacted) return;
      if (typeof delta.delta === 'string' && delta.delta.length > 0) {
        queue.push({
          type: 'thinking',
          data: { stage: 'delta', blockId: block.blockId, text: delta.delta },
          source: PRIME_AGENT_SOURCE,
        });
      }
      return;
    }

    case 'thinking_end': {
      const redacted = isRedactedThinkingDelta(delta, contentIndex);
      const block = ensureThinkingBlock(contentIndex, queue, ctx, redacted);
      ctx.thinkingBlocks.delete(contentIndex);
      if (redacted || block.redacted) {
        queue.push({
          type: 'thinking',
          data: { stage: 'redacted', blockId: block.blockId },
          source: PRIME_AGENT_SOURCE,
        });
        return;
      }
      queue.push({
        type: 'thinking',
        data: {
          stage: 'final',
          blockId: block.blockId,
          text: typeof delta.content === 'string' ? delta.content : '',
          durationMs: Date.now() - block.startedAt,
        },
        source: PRIME_AGENT_SOURCE,
      });
      return;
    }

    // text_start/text_end 由 message_end 全文校准覆盖; toolcall_* 由
    // tool_execution_* 覆盖; 终端 Start/Done/Error 不骑 message_update
    // (crates/pa-core/src/session_engine/session_events.rs:96-98)。
    case 'start':
    case 'text_start':
    case 'text_end':
    case 'toolcall_start':
    case 'toolcall_delta':
    case 'toolcall_end':
    case 'done':
    case 'error':
      return;

    default:
      ctx.logger.warn('prime-agent translator: unhandled assistant delta', { type: delta.type });
  }
}

/**
 * Prime Agent 把 redacted 标记放在 partial 的当前 AssistantMessage block 上。
 * 必须恢复成结构化 stage:redacted, 否则占位文本会被当成普通 thinking 落库并显示。
 * 字符串判定兼容未附 partial 的旧版 thinking_end 帧。
 */
function isRedactedThinkingDelta(delta: Record<string, unknown>, contentIndex: number): boolean {
  const partial = delta.partial;
  if (typeof partial === 'object' && partial !== null) {
    const content = (partial as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const block = content[contentIndex];
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'thinking' &&
        (block as { redacted?: unknown }).redacted === true
      ) {
        return true;
      }
    }
  }
  return delta.content === '[Reasoning redacted]';
}

function ensureThinkingBlock(
  contentIndex: number,
  queue: AsyncQueue<AgentEvent>,
  ctx: PrimeAgentTranslateContext,
  redacted = false,
): PrimeAgentThinkingBlock {
  const existing = ctx.thinkingBlocks.get(contentIndex);
  if (existing) return existing;
  const block: PrimeAgentThinkingBlock = {
    blockId: `${ctx.thinkingIdPrefix}-${++ctx.thinkingSeq}`,
    startedAt: Date.now(),
    redacted,
  };
  ctx.thinkingBlocks.set(contentIndex, block);
  if (!redacted) {
    queue.push({
      type: 'thinking',
      data: { stage: 'start', blockId: block.blockId, startedAt: block.startedAt },
      source: PRIME_AGENT_SOURCE,
    });
  }
  return block;
}

/** 供 index.ts 复用: StartSessionOptions 里 translator 需要的字段子集。 */
export type PrimeAgentStartSessionOptions = StartSessionOptions;
