/**
 * pi RPC 事件 → AgentEvent 翻译层。
 *
 * 形状对齐 codex translator(renderer 通用消费):
 *  - text:     { text, isFinal }            delta 追加 / final 全文 overwrite
 *  - thinking: { stage, blockId, text, startedAt?, durationMs? }
 *  - tool_use: { toolUseId, toolName, input }
 *  - tool_result_full: { toolUseId, fullText, isError }
 *  - tool_result:      { summary, toolUseIds }
 *  - status:   { status, ...UsageSnapshot 展开, isRunning }
 *  - done:     { type: 'pi/agent_settled', ... }
 *
 * 文本策略:pi 一条 assistant 消息可含多个 text block(text→toolcall→text),
 * renderer 的 isFinal 语义是"整条消息全文 overwrite"——因此流式期间只发 delta,
 * message_end 时把该消息全部 text block 拼接发一次 isFinal:true 校准。
 */

import type { Logger } from '../../interfaces/logger.js';
import { PI_SUBAGENT_TOOL_NAME } from '@cindy/maker-shared/agent-task';
import {
  extractNonSecretErrorSignals,
  redactSensitiveText,
} from '@cindy/maker-shared/error-redaction';
import type { AgentEvent, AgentTaskUpdateEventData, UsageSnapshot } from '../../types/index.js';
import type { AsyncQueue } from '../shared/async-queue.js';
import {
  UPSTREAM_OVERLOAD_REASON,
  formatOverloadRetryMessage,
  parseOverloadError,
} from '../shared/overload-error.js';
import type { PiRpcEvent } from './rpc-client.js';
import { parsePiSubagentProgress, type PiSubagentUsage } from './subagent-progress.js';

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

interface PiAssistantMessage {
  role: 'assistant';
  content?: Array<Record<string, unknown>>;
  usage?: PiUsage;
  /** provider-reported duration when the runtime supplies one. */
  duration?: number;
  /** Pi v0.83 generation-start wall-clock timestamp (milliseconds). */
  timestamp?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface PiPendingAssistantError {
  message: string;
  sdkError: string;
  errorStatus?: 401 | 429 | 529;
  usageLimit?: true;
}

interface PiThinkingBlock {
  blockId: string;
  startedAt: number;
  redacted: boolean;
}

export interface PiTranslateContext {
  logger: Logger;
  /** get_state 拿到的 contextWindow(模型切换时更新)。 */
  contextWindow: number;
  /** turn 内累计 input+output;turn 结束 reset。 */
  turnTokens: number;
  /** turn 内 usage 分量累计(did-turn-end / ghost 订阅上报用);agent_start reset。 */
  turnInput: number;
  turnOutput: number;
  turnCacheRead: number;
  turnCacheWrite: number;
  /** 最后一次 API call 的 context 占用(input + cacheRead + cacheWrite)。 */
  contextTokens: number;
  /** 跨 turn 累计成本。 */
  costUsd: number;
  /** agent run 是否进行中(send 的 streamingBehavior 判定也用它)。 */
  isStreaming: boolean;
  /** thinking 块序号(blockId 生成)。 */
  thinkingSeq: number;
  /** contentIndex → 当前消息内的 thinking block 状态。 */
  thinkingBlocks: Map<number, PiThinkingBlock>;
  /**
   * 本 turn 最后一条 assistant 消息的全文(每次非空 message_end 覆盖;agent_start 重置)。
   * 用于 agent_settled 的 done.data.result —— 与 CC/Codex 对齐:register.ts 的
   * will-assistant-message 出口钩子与 Orca worker 终态 finalText 都读 done.data.result,
   * 不带上就会对 Pi 静默跳过这些钩子(codex review P1)。
   */
  finalAssistantText: string;
  /**
   * Pi 会先用 message_end(stopReason=error) 报 provider 错误，之后仍可能自动重试。
   * 暂存到 agent_settled 再终态上报，避免一次可恢复错误提前收口整个 turn。
   */
  pendingAssistantError: PiPendingAssistantError | null;
  /** 整轮 wall-clock 起点；只用于诊断，不参与 TPS。 */
  turnWallClockStartedAt: number;
  generationDurationMs: number;
  /** False when any reported output lacks compatible parent generation timing. */
  generationTimingReliable: boolean;
  generationHeartbeatAt: number;
  generationHeartbeatTimer: ReturnType<typeof setInterval> | null;
  generationHeartbeatReliable: boolean;
  /**
   * 每个子代理调用(taskId)最近一次上报的**累计**委派用量。进度帧报累计值,这里存上次值
   * 用来算增量,避免同一批用量被反复加进 turn 记账。与其它 turn 计数器同点(agent_start)清空。
   */
  delegatedUsage: Map<string, PiSubagentUsage>;
  /**
   * Tool calls explicitly identified as Cindy's PI Subagent extension.
   *
   * Preserve the display title across the start/update/end event split so the
   * terminal update remains self-describing even for consumers that do not
   * reduce it into the preceding live-card state.
   */
  subagentToolCalls: Map<string, AgentTaskUpdateEventData>;
}

export function createPiTranslateContext(logger: Logger): PiTranslateContext {
  return {
    logger,
    contextWindow: 0,
    turnTokens: 0,
    turnInput: 0,
    turnOutput: 0,
    turnCacheRead: 0,
    turnCacheWrite: 0,
    contextTokens: 0,
    costUsd: 0,
    isStreaming: false,
    thinkingSeq: 0,
    thinkingBlocks: new Map(),
    finalAssistantText: '',
    turnWallClockStartedAt: 0,
    generationDurationMs: 0,
    generationTimingReliable: true,
    generationHeartbeatAt: 0,
    generationHeartbeatTimer: null,
    generationHeartbeatReliable: true,
    delegatedUsage: new Map(),
    subagentToolCalls: new Map(),
    pendingAssistantError: null,
  };
}

const PI_GENERATION_HEARTBEAT_MS = 5_000;
const PI_GENERATION_SUSPEND_GAP_MS = 30_000;

function stopPiGenerationHeartbeat(ctx: PiTranslateContext): void {
  if (ctx.generationHeartbeatTimer !== null) clearInterval(ctx.generationHeartbeatTimer);
  ctx.generationHeartbeatTimer = null;
  ctx.generationHeartbeatAt = 0;
}

/** Release translator-owned resources when a Pi session ends outside a normal turn boundary. */
export function disposePiTranslateContext(ctx: PiTranslateContext): void {
  stopPiGenerationHeartbeat(ctx);
  ctx.isStreaming = false;
  ctx.pendingAssistantError = null;
  ctx.subagentToolCalls.clear();
}

function samplePiGenerationHeartbeat(ctx: PiTranslateContext, now = Date.now()): void {
  if (
    ctx.generationHeartbeatAt > 0 &&
    now - ctx.generationHeartbeatAt >
      PI_GENERATION_HEARTBEAT_MS + PI_GENERATION_SUSPEND_GAP_MS
  ) {
    ctx.generationHeartbeatReliable = false;
  }
  ctx.generationHeartbeatAt = now;
}

function startPiGenerationHeartbeat(ctx: PiTranslateContext): void {
  stopPiGenerationHeartbeat(ctx);
  ctx.generationHeartbeatReliable = true;
  ctx.generationHeartbeatAt = Date.now();
  const timer = setInterval(() => samplePiGenerationHeartbeat(ctx), PI_GENERATION_HEARTBEAT_MS);
  timer.unref?.();
  ctx.generationHeartbeatTimer = timer;
}

export function usageSnapshotOf(ctx: PiTranslateContext): UsageSnapshot {
  return {
    tokenUsage: ctx.turnTokens,
    contextTokens: ctx.contextTokens,
    contextWindow: ctx.contextWindow,
    costUsd: ctx.costUsd,
  };
}

function pushStatus(
  queue: AsyncQueue<AgentEvent>,
  ctx: PiTranslateContext,
  text: string,
  isRunning: boolean,
): void {
  queue.push({
    type: 'status',
    data: { status: text, ...usageSnapshotOf(ctx), isRunning },
    source: 'pi',
  });
}

function applyUsage(ctx: PiTranslateContext, usage: PiUsage | undefined): void {
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
}

/**
 * 把子代理(委派)的用量并进本 turn 的记账。
 *
 * 进度帧报的是**累计**值(丢一帧不该让那段用量永久消失),所以这里按 taskId 记住上次值、
 * 只加增量。回退的累计值(理论上不该出现)按 0 处理,绝不产生负增量。
 *
 * 刻意**不动 `ctx.contextTokens`**:那是"最后一次 API 调用占了多少上下文",而子代理有它
 * 自己独立的上下文窗口 —— 混进来会让父会话的上下文占用条读数虚高。
 */
function applyDelegatedUsage(
  ctx: PiTranslateContext,
  taskId: string,
  cumulative: PiSubagentUsage | undefined,
): void {
  if (!cumulative || !taskId) return;
  const previous = ctx.delegatedUsage.get(taskId);
  const delta = {
    input: Math.max(0, cumulative.input - (previous?.input ?? 0)),
    output: Math.max(0, cumulative.output - (previous?.output ?? 0)),
    cacheRead: Math.max(0, cumulative.cacheRead - (previous?.cacheRead ?? 0)),
    cacheWrite: Math.max(0, cumulative.cacheWrite - (previous?.cacheWrite ?? 0)),
    cost: Math.max(0, cumulative.cost - (previous?.cost ?? 0)),
  };
  ctx.delegatedUsage.set(taskId, cumulative);
  ctx.turnTokens += delta.input + delta.output;
  ctx.turnInput += delta.input;
  ctx.turnOutput += delta.output;
  ctx.turnCacheRead += delta.cacheRead;
  ctx.turnCacheWrite += delta.cacheWrite;
  ctx.costUsd += delta.cost;
  // Child progress exposes wall-clock card duration, not generation-only time.
  // Once child output joins the numerator, parent-only timing cannot produce a
  // compatible TPS denominator, so retain usage but omit speed for this turn.
  if (delta.output > 0) ctx.generationTimingReliable = false;
}

function assistantTextOf(message: PiAssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n\n');
}

function piAssistantErrorOf(rawError: string): PiPendingAssistantError {
  const signals = extractNonSecretErrorSignals(rawError);
  const redactedError = redactSensitiveText(rawError);
  return {
    message: redactedError,
    sdkError: redactedError,
    ...(signals.errorStatus !== undefined ? { errorStatus: signals.errorStatus } : {}),
    ...(signals.usageLimit ? { usageLimit: true } : {}),
  };
}

function parsePiAutoRetryProgress(
  event: PiRpcEvent,
): { attempt: number; maxAttempts: number } | null {
  const attempt = event.attempt;
  const maxAttempts = event.maxAttempts;
  if (
    typeof attempt !== 'number'
    || typeof maxAttempts !== 'number'
    || !Number.isSafeInteger(attempt)
    || !Number.isSafeInteger(maxAttempts)
    || attempt < 1
    || maxAttempts < attempt
  ) {
    return null;
  }
  return { attempt, maxAttempts };
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
 * pi 的 thinking 事件把 redacted 标记放在 partial 的当前 AssistantMessage block 上。
 * 必须恢复成结构化 stage:redacted，否则占位文本会被当成普通 thinking 落库并显示。
 * 字符串判定兼容未附 partial 的旧版 thinking_end RPC 帧。
 */
function isRedactedThinkingDelta(delta: Record<string, unknown>, contentIndex: number): boolean {
  const partial = delta.partial;
  if (typeof partial === 'object' && partial !== null) {
    const content = (partial as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const block = content[contentIndex];
      if (
        typeof block === 'object'
        && block !== null
        && (block as { type?: unknown }).type === 'thinking'
        && (block as { redacted?: unknown }).redacted === true
      ) {
        return true;
      }
    }
  }
  return delta.content === '[Reasoning redacted]';
}

/** 主入口:一帧 pi RPC 事件 → 0..n 个 AgentEvent。 */
export function translatePiEvent(
  event: PiRpcEvent,
  queue: AsyncQueue<AgentEvent>,
  ctx: PiTranslateContext,
): void {
  switch (event.type) {
    case 'agent_start': {
      ctx.isStreaming = true;
      ctx.turnTokens = 0;
      ctx.turnInput = 0;
      ctx.turnOutput = 0;
      ctx.turnCacheRead = 0;
      ctx.turnCacheWrite = 0;
      ctx.finalAssistantText = '';
      ctx.pendingAssistantError = null;
      ctx.turnWallClockStartedAt = Date.now();
      ctx.generationDurationMs = 0;
      ctx.generationTimingReliable = true;
      stopPiGenerationHeartbeat(ctx);
      // 与其它 turn 计数器同点清:新 turn 的委派用量不该跟上一 turn 的累计值作差,
      // 也避免长会话里 taskId 条目无界堆积。
      ctx.delegatedUsage.clear();
      ctx.subagentToolCalls.clear();
      pushStatus(queue, ctx, 'Working…', true);
      return;
    }

    case 'turn_start':
      return;

    case 'message_start': {
      ctx.thinkingBlocks.clear();
      startPiGenerationHeartbeat(ctx);
      return;
    }

    case 'message_update': {
      const delta = event.assistantMessageEvent as Record<string, unknown> | undefined;
      if (!delta || typeof delta.type !== 'string') return;
      handleAssistantDelta(delta, queue, ctx);
      return;
    }

    case 'message_end': {
      const message = event.message as PiAssistantMessage | undefined;
      if (!message || message.role !== 'assistant') return;
      applyUsage(ctx, message.usage);
      const hadGenerationHeartbeat = ctx.generationHeartbeatAt > 0;
      samplePiGenerationHeartbeat(ctx);
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
      stopPiGenerationHeartbeat(ctx);
      if (messageDurationMs > 0) {
        ctx.generationDurationMs += messageDurationMs;
      } else if ((message.usage?.output ?? 0) > 0) {
        // A single untimed output-bearing message makes the whole turn's TPS
        // denominator partial. Keep token/cost accounting, but do not publish it.
        ctx.generationTimingReliable = false;
      }
      const fullText = assistantTextOf(message);
      if (message.stopReason === 'error') {
        const rawError = message.errorMessage?.trim() || fullText.trim() || 'Pi agent request failed';
        ctx.pendingAssistantError = piAssistantErrorOf(rawError);
      } else {
        // A normal assistant message proves an earlier provider failure recovered.
        ctx.pendingAssistantError = null;
      }
      if (message.stopReason !== 'error' && fullText.length > 0) {
        // 覆盖为本 turn 最新一条有文本的 assistant 回复,agent_settled 作 done.result 上报。
        ctx.finalAssistantText = fullText;
        queue.push({
          type: 'text',
          data: { text: fullText, isFinal: true, isFullText: true },
          source: 'pi',
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
          toolName,
          input: toolArgs,
        },
        source: 'pi',
      });
      if (toolName === PI_SUBAGENT_TOOL_NAME && toolUseId) {
        const rawTitle = toolArgs.agent;
        const title = typeof rawTitle === 'string' && rawTitle.trim()
          ? rawTitle.trim().slice(0, 96)
          : undefined;
        const update: AgentTaskUpdateEventData = {
          provider: 'pi',
          taskId: toolUseId,
          parentToolUseId: toolUseId,
          status: 'running',
          ...(title ? { title } : {}),
          subagentObservation: {
            kind: 'spawn',
            logicalSubagentId: toolUseId,
            parentToolUseId: toolUseId,
          },
        };
        ctx.subagentToolCalls.set(toolUseId, update);
        queue.push({ type: 'agent_task_update', data: update, source: 'pi' });
      }
      pushStatus(queue, ctx, `Running ${toolName}…`, true);
      return;
    }

    case 'tool_execution_update': {
      // 子代理卡的实时状态:`subagent` 工具用 pi 原生的 onUpdate 流上报 tokens /
      // 工具调用数 / 耗时(卡片的 tool_use / tool_result 由 start / end 分支承载)。
      // 其它工具的流式中间结果照旧忽略 —— 载荷不带标记时 parse 返回 null。
      const progress = parsePiSubagentProgress(event.partialResult);
      if (progress) {
        const previousUpdate = ctx.subagentToolCalls.get(progress.update.taskId);
        if (previousUpdate) {
          ctx.subagentToolCalls.set(progress.update.taskId, {
            ...previousUpdate,
            ...progress.update,
          });
        }
        // 委派用量并进本 turn 的记账。子代理是独立 pi 进程,它的请求不走父进程的 usage 流,
        // 不在这里显式并进来,done.data.usage 与 register.ts 持久化的 session token/cost
        // 就会漏掉全部子代理花费(review)。
        applyDelegatedUsage(ctx, progress.update.taskId, progress.delegatedUsage);
        queue.push({ type: 'agent_task_update', data: progress.update, source: 'pi' });
      }
      return;
    }

    case 'tool_execution_end': {
      const toolUseId = String(event.toolCallId ?? '');
      const isError = event.isError === true;
      const fullText = toolResultFullText(event.result);
      queue.push({
        type: 'tool_result_full',
        data: { toolUseId, fullText, isError },
        source: 'pi',
      });
      queue.push({
        type: 'tool_result',
        data: { summary: isError ? 'failed' : 'done', toolUseIds: [toolUseId] },
        source: 'pi',
      });
      const subagentToolCall = ctx.subagentToolCalls.get(toolUseId);
      if (subagentToolCall) {
        ctx.subagentToolCalls.delete(toolUseId);
        // Progress is the authoritative child lifecycle. A successful batch
        // tool result can still contain failed children, while cancellation
        // may finish the wrapper with isError=true after the child stopped.
        // Only a still-running child is completed/failed by the wrapper frame.
        const status = subagentToolCall.status === 'running'
          ? (isError ? 'failed' : 'completed')
          : subagentToolCall.status;
        queue.push({
          type: 'agent_task_update',
          data: {
            ...subagentToolCall,
            provider: 'pi',
            taskId: toolUseId,
            parentToolUseId: toolUseId,
            status,
            subagentObservation: {
              kind: 'terminal',
              logicalSubagentId: toolUseId,
              parentToolUseId: toolUseId,
            },
          },
          source: 'pi',
        });
      }
      return;
    }

    case 'turn_end': {
      const message = event.message as PiAssistantMessage | undefined;
      if (message?.role === 'assistant' && !message.usage) return;
      return;
    }

    case 'agent_end':
      // 可能跟 retry / compaction / queued follow-up;终态一律等 agent_settled。
      return;

    case 'agent_settled': {
      ctx.isStreaming = false;
      stopPiGenerationHeartbeat(ctx);
      const pendingAssistantError = ctx.pendingAssistantError;
      ctx.pendingAssistantError = null;
      if (pendingAssistantError) {
        queue.push({
          type: 'error',
          data: {
            ...pendingAssistantError,
            isTerminal: true,
          },
          source: 'pi',
        });
      }
      queue.push({
        type: 'done',
        data: {
          type: 'pi/agent_settled',
          // 本 turn 最终 assistant 回复文本。与 CC/Codex 的 done.data.result 对齐:
          // register.ts 的 will-assistant-message 出口钩子与 Orca worker 终态 finalText
          // 都读 done.data.result,不带上就会对 Pi 静默跳过这些钩子(codex review P1)。
          result: ctx.finalAssistantText,
          // ghost 订阅 did-turn-end 的 usage 上报(subscriptionGateway.normalizeTurnUsage
          // 认 camelCase);与 CC/Codex 的 done.usage 对齐,让插件能显示 pi turn 的用量。
          usage: {
            inputTokens: ctx.turnInput,
            outputTokens: ctx.turnOutput,
            cacheReadTokens: ctx.turnCacheRead,
            cacheCreationTokens: ctx.turnCacheWrite,
            // durationMs is deliberately generation-only. If Pi does not report a
            // per-assistant generation duration, omit it instead of charging tool
            // execution / user waits to TPS.
            ...(ctx.generationTimingReliable && ctx.generationDurationMs > 0
              ? { durationMs: ctx.generationDurationMs }
              : {}),
            ...(ctx.turnWallClockStartedAt > 0
              ? { turnDurationMs: Math.max(0, Date.now() - ctx.turnWallClockStartedAt) }
              : {}),
          },
        },
        source: 'pi',
      });
      // 与 Claude/Codex 的 turn-end status 契约一致：Desktop main 以
      // isRunning=false + status=Done 持久化 context 快照。
      pushStatus(queue, ctx, 'Done', false);
      return;
    }

    case 'auto_retry_start': {
      // 走 CC/Codex 同一套 `(auto-retry N/M)` 跨 agent 协议。这个后缀在 mobile /
      // Telegram 投影里**只表示过载**，不能拿去编码未分类 5xx —— 否则手机会把普通
      // 供应商故障显示成「模型服务繁忙」。
      //
      // 第 1 次不透出：单次抖动 pi 一次重试就过，提示只会闪一下徒增噪音
      // （与 claude-code translator 的 api_retry 防噪口径一致）。
      // 未分类错误同样静默：渠道 / 手机没有对应本地化契约，CC 也只透过载类。
      const progress = parsePiAutoRetryProgress(event);
      if (!progress || progress.attempt < 2) return;
      const sdkError = typeof event.errorMessage === 'string'
        ? redactSensitiveText(event.errorMessage)
        : undefined;
      const rawMessage = (sdkError && sdkError.trim())
        || ctx.pendingAssistantError?.message
        || '';
      const signals = extractNonSecretErrorSignals(rawMessage);
      const errorStatus = ctx.pendingAssistantError?.errorStatus ?? signals.errorStatus;
      if (parseOverloadError(rawMessage, errorStatus) === null) return;
      queue.push({
        type: 'error',
        data: {
          message: formatOverloadRetryMessage(rawMessage, progress.attempt, progress.maxAttempts),
          isTerminal: false,
          willRetry: true,
          reason: UPSTREAM_OVERLOAD_REASON,
          ...(sdkError ? { sdkError } : {}),
          ...(errorStatus !== undefined ? { errorStatus } : {}),
        },
        source: 'pi',
      });
      return;
    }

    case 'auto_retry_end': {
      if (event.success === true) {
        ctx.pendingAssistantError = null;
        return;
      }
      const rawFinalError = typeof event.finalError === 'string' && event.finalError.trim()
        ? event.finalError.trim()
        : null;
      const finalError = rawFinalError
        ? piAssistantErrorOf(rawFinalError)
        : ctx.pendingAssistantError ?? piAssistantErrorOf('pi auto-retry failed');
      ctx.pendingAssistantError = null;
      queue.push({
        type: 'error',
        data: {
          ...finalError,
          isTerminal: true,
        },
        source: 'pi',
      });
      return;
    }

    case 'compaction_start': {
      pushStatus(queue, ctx, 'Compacting context…', true);
      return;
    }

    case 'compaction_end': {
      const result = event.result as { tokensBefore?: number; estimatedTokensAfter?: number } | null;
      queue.push({
        type: 'compact_boundary',
        data: {
          trigger: event.reason === 'manual' ? 'manual' : 'auto',
          preTokens: result?.tokensBefore,
          postTokens: result?.estimatedTokensAfter,
        },
        source: 'pi',
      });
      if (result && typeof result.estimatedTokensAfter === 'number') {
        ctx.contextTokens = result.estimatedTokensAfter;
      }
      // #1933 review:手动压缩事件必须闭环。compaction_start 已把 isRunning 置 true,
      // 若不收口,renderer 圆环会永久卡 running、新 contextTokens 也送不回去。
      // 仅 manual 收口:auto 压缩发生在活跃 turn 内(turn 结束经 agent_settled 自然收口),
      // 且若压缩期间用户已开始新 turn(ctx.isStreaming)也不能收口,否则会误杀新 turn。
      if (event.reason === 'manual' && !ctx.isStreaming) {
        pushStatus(queue, ctx, 'Done', false);
      }
      return;
    }

    case 'queue_update':
    case 'thinking_level_changed':
    case 'summarization_retry_scheduled':
    case 'summarization_retry_attempt_start':
    case 'summarization_retry_finished':
    case 'bash_execution_update':
      return;

    case 'extension_error': {
      ctx.logger.warn('pi extension error', {
        extensionPath: event.extensionPath,
        event: event.event,
        error: event.error,
      });
      return;
    }

    default:
      ctx.logger.warn('pi translator: unhandled event dropped', { type: event.type });
  }
}

function handleAssistantDelta(
  delta: Record<string, unknown>,
  queue: AsyncQueue<AgentEvent>,
  ctx: PiTranslateContext,
): void {
  const contentIndex = typeof delta.contentIndex === 'number' ? delta.contentIndex : 0;

  switch (delta.type) {
    case 'text_delta': {
      if (typeof delta.delta === 'string' && delta.delta.length > 0) {
        queue.push({ type: 'text', data: { text: delta.delta, isFinal: false }, source: 'pi' });
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
          source: 'pi',
        });
        return;
      }
      if (block.redacted) return;
      if (typeof delta.delta === 'string' && delta.delta.length > 0) {
        queue.push({
          type: 'thinking',
          data: { stage: 'delta', blockId: block.blockId, text: delta.delta },
          source: 'pi',
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
          source: 'pi',
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
        source: 'pi',
      });
      return;
    }

    // text_start/text_end 由 message_end 全文校准覆盖;toolcall_* 由 tool_execution_* 覆盖。
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
      ctx.logger.warn('pi translator: unhandled assistant delta', { type: delta.type });
  }
}

function ensureThinkingBlock(
  contentIndex: number,
  queue: AsyncQueue<AgentEvent>,
  ctx: PiTranslateContext,
  redacted = false,
): PiThinkingBlock {
  const existing = ctx.thinkingBlocks.get(contentIndex);
  if (existing) return existing;
  const block = {
    blockId: `pi-think-${++ctx.thinkingSeq}`,
    startedAt: Date.now(),
    redacted,
  };
  ctx.thinkingBlocks.set(contentIndex, block);
  if (!redacted) {
    queue.push({
      type: 'thinking',
      data: { stage: 'start', blockId: block.blockId, startedAt: block.startedAt },
      source: 'pi',
    });
  }
  return block;
}
