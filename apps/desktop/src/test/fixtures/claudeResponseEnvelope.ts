/**
 * 合成的 Claude Code SDK 输入，经生产 translator 翻译后同时喂给官方与个人两条
 * Telegram bot 收口路径。正文与 thinking 块拆在不同 envelope、共用同一个
 * `message.id`，即 #6574 的最小输入；不是线上会话抓包。
 */
import type { AgentEvent } from '@cindy/maker-core';
import { createAsyncQueue } from '../../../../../packages/maker-core/src/agents/shared/async-queue.js';
import { UsageTracker } from '../../../../../packages/maker-core/src/agents/shared/usage-tracker.js';
import { newRuntimeState, translateSdkMessage, type TurnState } from '../../../../../packages/maker-core/src/agents/claude-code/translator.js';

/** 返回 translator 产出的事件序列，调用方按自己的收口入口回放。 */
export async function claudeResponseEnvelopeEvents(
  tailType: 'thinking' | 'redacted_thinking',
  tailMessageId: string | undefined,
): Promise<AgentEvent[]> {
  const queue = createAsyncQueue<AgentEvent>();
  const turn: TurnState = {
    text: '', toolUses: 0, apiCalls: 0, sawCompactBoundary: false,
    hasEmittedText: false, uiEmittedText: '', pendingApiError: null,
    interruptRequested: false, generation: 0, interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
  const ctx = {
    rt: newRuntimeState(), turn, tracker: new UsageTracker(),
    log: { debug() {}, info() {}, warn() {} },
    getModel: () => 'claude-fable-5', getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const, onSessionId() {},
    getSdkSessionId: () => undefined, getLogTitle: () => undefined,
    getModelContextWindow: () => 1_000_000,
  };
  for (const message of [
    { type: 'stream_event', event: { type: 'message_start', message: {
      model: 'claude-fable-5', usage: { input_tokens: 1000 },
    } } },
    { type: 'assistant', message: { id: 'tool-reply', content: [
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
    ] } },
    { type: 'assistant', uuid: 'text-envelope', message: { id: 'reply-A', content: [
      { type: 'text', text: 'Completed answer.' },
    ] } },
    { type: 'assistant', uuid: 'tail-envelope', message: { id: tailMessageId, content: [
      tailType === 'thinking' ? { type: tailType, thinking: 'Reasoning', signature: 'sig' }
        : { type: tailType, data: 'opaque' },
    ] } },
    { type: 'result', stop_reason: 'end_turn', result: '', total_cost_usd: 0.1,
      usage: { input_tokens: 1000, output_tokens: 2 } },
  ]) translateSdkMessage(message, queue, ctx);
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}
