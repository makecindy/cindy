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
import type { AgentEvent, UsageSnapshot } from '../../types/index.js';
import type { AsyncQueue } from '../shared/async-queue.js';
import type { PiRpcEvent } from './rpc-client.js';

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
  model?: string;
  stopReason?: string;
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
  };
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

function assistantTextOf(message: PiAssistantMessage): string {
  const parts: string[] = [];
  for (const block of message.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n\n');
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
      pushStatus(queue, ctx, 'Working…', true);
      return;
    }

    case 'turn_start':
      return;

    case 'message_start': {
      ctx.thinkingBlocks.clear();
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
      const fullText = assistantTextOf(message);
      if (fullText.length > 0) {
        // 覆盖为本 turn 最新一条有文本的 assistant 回复,agent_settled 作 done.result 上报。
        ctx.finalAssistantText = fullText;
        queue.push({
          type: 'text',
          data: { text: fullText, isFinal: true },
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
      queue.push({
        type: 'tool_use',
        data: {
          toolUseId: String(event.toolCallId ?? ''),
          toolName: String(event.toolName ?? 'tool'),
          input: (event.args as Record<string, unknown>) ?? {},
        },
        source: 'pi',
      });
      pushStatus(queue, ctx, `Running ${String(event.toolName ?? 'tool')}…`, true);
      return;
    }

    case 'tool_execution_update':
      return;

    case 'tool_execution_end': {
      const toolUseId = String(event.toolCallId ?? '');
      const isError = event.isError === true;
      queue.push({
        type: 'tool_result_full',
        data: { toolUseId, fullText: toolResultFullText(event.result), isError },
        source: 'pi',
      });
      queue.push({
        type: 'tool_result',
        data: { summary: isError ? 'failed' : 'done', toolUseIds: [toolUseId] },
        source: 'pi',
      });
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
      queue.push({
        type: 'error',
        data: {
          message: `Transient provider error, retrying (${String(event.attempt)}/${String(event.maxAttempts)})…`,
          isTerminal: false,
          willRetry: true,
          sdkError: typeof event.errorMessage === 'string' ? event.errorMessage : undefined,
        },
        source: 'pi',
      });
      return;
    }

    case 'auto_retry_end': {
      if (event.success === true) return;
      queue.push({
        type: 'error',
        data: {
          message: typeof event.finalError === 'string' ? event.finalError : 'pi auto-retry failed',
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
