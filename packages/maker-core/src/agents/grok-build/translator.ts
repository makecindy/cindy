/**
 * Grok Build ACP `session/update` → Cindy AgentEvent.
 *
 *   agent_message_chunk → text { text, isFinal }
 *   agent_thought_chunk → thinking { stage, blockId, text, ... }
 *   tool_call           → tool_use { toolUseId, toolName, input }
 *   tool_call_update completed/failed → tool_result_full + tool_result
 *   usage_update        → status with UsageSnapshot
 *   session/prompt result → done
 */

import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
import type { AcpContentBlock, AcpSessionPromptResult, AcpSessionUpdate, AcpToolCall } from './types.js';
import { isRecord } from './types.js';

export const GROK_BUILD_SOURCE = 'grok-build' as const;

function textOf(content: AcpContentBlock | undefined): string {
  if (!content) return '';
  if (content.type === 'text' && typeof content.text === 'string') return content.text;
  return '';
}

/**
 * AcpSessionUpdate 末尾有 `{ sessionUpdate: string; [key: string]: unknown }` 兜底成员,
 * 判别式是 string,所以 switch 收窄后 content 仍是 unknown。内容来自外部进程,这里按
 * 结构校验再收窄,而不是硬转。
 */
function contentOf(content: unknown): AcpContentBlock | undefined {
  if (!isRecord(content) || typeof content.type !== 'string') return undefined;
  return content as AcpContentBlock;
}

function toolNameOf(call: Partial<AcpToolCall>): string {
  return call.title || call.kind || 'tool';
}

function stringifyOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function translateSessionUpdate(
  update: AcpSessionUpdate,
  ctx: { thoughtBlockId?: string },
): AgentEvent[] {
  const events: AgentEvent[] = [];
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const text = textOf(contentOf(update.content));
      if (!text) break;
      events.push({
        type: 'text',
        data: { text, isFinal: false },
        source: GROK_BUILD_SOURCE,
      });
      break;
    }
    case 'agent_thought_chunk': {
      const text = textOf(contentOf(update.content));
      if (!text) break;
      events.push({
        type: 'thinking',
        data: {
          stage: 'delta',
          blockId: ctx.thoughtBlockId ?? 'grok-thought',
          text,
        },
        source: GROK_BUILD_SOURCE,
      });
      break;
    }
    case 'tool_call': {
      const call = update as AcpToolCall & { sessionUpdate: 'tool_call' };
      events.push({
        type: 'tool_use',
        data: {
          toolUseId: call.toolCallId,
          toolName: toolNameOf(call),
          input: isRecord(call.rawInput) ? call.rawInput : {},
        },
        source: GROK_BUILD_SOURCE,
      });
      break;
    }
    case 'tool_call_update': {
      const call = update as Partial<AcpToolCall> & {
        sessionUpdate: 'tool_call_update';
        toolCallId: string;
      };
      if (call.status !== 'completed' && call.status !== 'failed') break;
      const content = stringifyOutput(call.rawOutput ?? call.content);
      const isError = call.status === 'failed';
      events.push({
        type: 'tool_result_full',
        data: {
          toolUseId: call.toolCallId,
          toolName: toolNameOf(call),
          content,
          isError,
        },
        source: GROK_BUILD_SOURCE,
      });
      events.push({
        type: 'tool_result',
        data: {
          toolUseId: call.toolCallId,
          toolName: toolNameOf(call),
          content,
          isError,
        },
        source: GROK_BUILD_SOURCE,
      });
      break;
    }
    case 'usage_update': {
      const snapshot = usageFromUpdate(update);
      events.push({
        type: 'status',
        data: {
          status: 'running',
          ...snapshot,
        },
        source: GROK_BUILD_SOURCE,
      });
      break;
    }
    default:
      break;
  }
  return events;
}

export function usageFromUpdate(update: Extract<AcpSessionUpdate, { sessionUpdate: 'usage_update' }> | Record<string, unknown>): UsageSnapshot {
  const rec = update as Record<string, unknown>;
  const input = typeof rec.inputTokens === 'number' ? rec.inputTokens : 0;
  const output = typeof rec.outputTokens === 'number' ? rec.outputTokens : 0;
  const used = typeof rec.used === 'number' ? rec.used : input + output;
  const size = typeof rec.size === 'number' ? rec.size : 0;
  const cost = isRecord(rec.cost) && typeof rec.cost.amount === 'number' ? rec.cost.amount : 0;
  return {
    tokenUsage: used,
    contextTokens: used,
    contextWindow: size,
    costUsd: cost,
    outputTokens: output || undefined,
  };
}

export function translatePromptResult(result: AcpSessionPromptResult): AgentEvent {
  return {
    type: 'done',
    data: { stopReason: result.stopReason },
    source: GROK_BUILD_SOURCE,
  };
}

export function translateError(message: string, isTerminal = true): AgentEvent {
  return {
    type: 'error',
    data: { message, isTerminal },
    source: GROK_BUILD_SOURCE,
  };
}
