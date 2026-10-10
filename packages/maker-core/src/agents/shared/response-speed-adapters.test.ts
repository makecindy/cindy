import { afterEach, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../types/events.js';
import type { AsyncQueue } from './async-queue.js';
import type { Logger } from '../../interfaces/logger.js';
import { UsageTracker } from './usage-tracker.js';
import { newRuntimeState, translateSdkMessage, type TurnState } from '../claude-code/translator.js';
import { createPiTranslateContext, disposePiTranslateContext, translatePiEvent, usageSnapshotOf } from '../pi/translator.js';
import type { PiRpcEvent } from '../pi/rpc-client.js';
import { beginCodexGenerationTurn, newCodexRuntimeState, translateAgentMessageDelta,
  translateItemNotification, pauseCodexGeneration } from '../codex/translator.js';

afterEach(() => vi.restoreAllMocks());
function harness() {
  const events: AgentEvent[] = [];
  const queue = { push: (event: AgentEvent) => events.push(event) } as unknown as AsyncQueue<AgentEvent>;
  return { events, queue };
}
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

it('Pi publishes streaming estimates with untouched billing/cache counters, then calibrates two tool rounds', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const { queue, events } = harness();
  const ctx = createPiTranslateContext(log as unknown as Logger);
  const send = (now: number, event: Record<string, unknown>) => {
    clock.mockReturnValue(now); translatePiEvent(event as unknown as PiRpcEvent, queue, ctx);
  };
  try {
    send(1_000, { type: 'agent_start' });
    send(2_000, { type: 'message_start', message: { role: 'assistant' } });
    send(3_000, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'a'.repeat(40) } });
    send(4_000, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: 'b'.repeat(40) } });
    expect(usageSnapshotOf(ctx)).toMatchObject({ tokenUsage: 0, outputTokens: 0,
      responseSpeed: { firstResponseMs: 2_000, estimated: true, outputTokens: 20 } });
    expect(events.some((event) => event.type === 'status' &&
      ((event.data as { responseSpeed?: { recentRate: number } }).responseSpeed?.recentRate ?? 0) > 0)).toBe(true);
    send(5_000, { type: 'message_end', message: { role: 'assistant', content: [],
      usage: { input: 10, output: 100, cacheRead: 20, cacheWrite: 5 }, duration: 3_000 } });
    send(6_000, { type: 'tool_execution_start', toolCallId: 't', toolName: 'bash', args: {} });
    expect(usageSnapshotOf(ctx).responseSpeed).toMatchObject({ phase: 'paused', toolActive: true, recentRate: null });
    send(16_000, { type: 'tool_execution_end', toolCallId: 't', toolName: 'bash', result: { content: [] } });
    expect(events.filter(event => event.type === 'status').at(-1)?.data).toMatchObject({
      responseSpeed: { phase: 'waiting', toolActive: false, waitingMs: 0, durationMs: 2_000 },
    });
    send(17_000, { type: 'message_start', message: { role: 'toolResult' } });
    expect(usageSnapshotOf(ctx).responseSpeed).toMatchObject({ phase: 'waiting', waitingMs: 1_000 });
    send(17_000, { type: 'message_start', message: { role: 'assistant' } });
    send(18_000, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'answer' } });
    send(19_000, { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer' }],
      usage: { input: 10, output: 50 }, duration: 2_000 } });
    send(20_000, { type: 'agent_settled' });
    expect(usageSnapshotOf(ctx).responseSpeed).toMatchObject({ phase: 'complete', estimated: false,
      outputTokens: 150, durationMs: 3_000, averageRate: 50 });
    expect((events.find((event) => event.type === 'done')!.data as { usage: unknown }).usage)
      .toMatchObject({ inputTokens: 20, outputTokens: 150, cacheReadTokens: 20,
        cacheCreationTokens: 5, durationMs: 3_000 });
    send(21_000, { type: 'agent_start' });
    expect(usageSnapshotOf(ctx).responseSpeed).toMatchObject({ firstResponseMs: null, outputTokens: 0, samples: [] });
  } finally { disposePiTranslateContext(ctx); }
});

it('Claude measures only SDK stream wait, keeps child output separate, and deduplicates message usage', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const { queue, events } = harness();
  const turn: TurnState = { text: '', toolUses: 0, apiCalls: 0, sawCompactBoundary: false,
    hasEmittedText: false, uiEmittedText: '', pendingApiError: null, interruptRequested: false,
    generation: 0, interruptGeneration: 0, lastAssistantMsgHadSubstance: true };
  const ctx = { rt: newRuntimeState(), turn, log, getModel: () => 'test-model',
    getEffort: () => 'high', getPermissionMode: () => 'auto', onSessionId: vi.fn(),
    getSdkSessionId: () => undefined, getLogTitle: () => undefined, tracker: new UsageTracker() };
  const stream = (now: number, event: Record<string, unknown>, parent_tool_use_id?: string) => {
    clock.mockReturnValue(now); translateSdkMessage({ type: 'stream_event', event, parent_tool_use_id }, queue, ctx);
  };
  stream(1_000, { type: 'message_start', message: { id: 'm1', model: 'test-model' } });
  stream(2_000, { type: 'content_block_start', content_block: { type: 'thinking' } });
  stream(2_000, { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'a'.repeat(40) } });
  stream(3_000, { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: 'b'.repeat(40) } });
  const beforeChild = ctx.rt.generation.responseSpeed.snapshot();
  stream(3_000, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'child'.repeat(100) } }, 'child');
  expect(ctx.rt.generation.responseSpeed.snapshot()).toEqual(beforeChild);
  stream(4_000, { type: 'message_delta', usage: { output_tokens: 100 } });
  stream(5_000, { type: 'message_delta', usage: { output_tokens: 100 } });
  clock.mockReturnValue(20_000);
  translateSdkMessage({ type: 'result', subtype: 'success', result: 'done', usage: { output_tokens: 100 } }, queue, ctx);
  const done = events.find((event) => event.type === 'done')!.data as { responseSpeed: unknown };
  expect(done.responseSpeed).toMatchObject({ waitOrigin: 'stream', firstResponseMs: 1_000,
    outputTokens: 100, durationMs: 2_000, estimated: false, averageRate: 50 });
});

it('Codex counts the shared snapshot/delta cursor once and pauses while tools own the turn', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
  const rt = newCodexRuntimeState();
  const { queue } = harness();
  const ctx = { rt, log };
  beginCodexGenerationTurn(rt, 'turn', 1_000);
  clock.mockReturnValue(2_000);
  translateAgentMessageDelta({ threadId: 'thread', turnId: 'turn', itemId: 'msg', delta: 'a'.repeat(40) }, queue, ctx);
  clock.mockReturnValue(3_000);
  translateItemNotification('updated', { threadId: 'thread', turnId: 'turn', item:
    { id: 'msg', type: 'agentMessage', text: 'a'.repeat(40) } }, queue, ctx);
  expect(rt.responseSpeed.snapshot().outputTokens).toBe(10);
  pauseCodexGeneration(rt, 'turn', 'tool', 4_000);
  clock.mockReturnValue(15_000);
  rt.responseSpeed.finish(100);
  expect(rt.responseSpeed.snapshot()).toMatchObject({ waitOrigin: 'turn', firstResponseMs: 1_000,
    durationMs: 2_000, outputTokens: 100, averageRate: 50 });
  // Reset disposes the old generation heartbeat without altering the completed speed snapshot.
  beginCodexGenerationTurn(rt, 'next', 16_000);
  pauseCodexGeneration(rt, 'next', 'cleanup', 16_000);
});

it('Pi publishes even an unclassified native retry without adding an error banner, then recovers on content', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const { queue, events } = harness();
  const ctx = createPiTranslateContext(log as unknown as Logger);
  try {
    translatePiEvent({ type: 'agent_start' } as PiRpcEvent, queue, ctx);
    clock.mockReturnValue(2000);
    translatePiEvent({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3,
      errorMessage: 'unclassified upstream error' } as PiRpcEvent, queue, ctx);
    expect(events.filter(event => event.type === 'error')).toHaveLength(0);
    expect(events.filter(event => event.type === 'status').at(-1)?.data).toMatchObject({
      responseSpeed: { retrying: true, recentRate: null } });
    clock.mockReturnValue(12000);
    translatePiEvent({ type: 'message_start', message: { role: 'assistant' } } as PiRpcEvent, queue, ctx);
    translatePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'recovered' } } as PiRpcEvent, queue, ctx);
    expect(usageSnapshotOf(ctx).responseSpeed).toMatchObject({ retrying: false, durationMs: 0 });
    ctx.responseSpeed.finish();
    const settledEvents = events.length;
    translatePiEvent({ type: 'auto_retry_start', attempt: 2, maxAttempts: 3 } as PiRpcEvent, queue, ctx);
    expect(events).toHaveLength(settledEvents);
  } finally { disposePiTranslateContext(ctx); }
});

it('Claude publishes its first native retry without an error banner and excludes backoff from generation', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const { queue, events } = harness();
  const turn: TurnState = { text: '', toolUses: 0, apiCalls: 0, sawCompactBoundary: false,
    hasEmittedText: false, uiEmittedText: '', pendingApiError: null, interruptRequested: false,
    generation: 0, interruptGeneration: 0, lastAssistantMsgHadSubstance: true };
  const ctx = { rt: newRuntimeState(), turn, log, getModel: () => 'test-model',
    getEffort: () => 'high', getPermissionMode: () => 'auto', onSessionId: vi.fn(),
    getSdkSessionId: () => undefined, getLogTitle: () => undefined, tracker: new UsageTracker() };
  translateSdkMessage({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3,
    retry_delay_ms: 10000, error_status: 500, error: 'api_error' }, queue, ctx);
  expect(events.filter(event => event.type === 'error')).toHaveLength(0);
  expect(events.filter(event => event.type === 'status').at(-1)?.data).toMatchObject({
    responseSpeed: { retrying: true, recentRate: null } });
  clock.mockReturnValue(12000);
  translateSdkMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'recovered' } } }, queue, ctx);
  translateSdkMessage({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }, queue, ctx);
  expect(ctx.rt.generation.responseSpeed.snapshot().retrying).not.toBe(true);
  expect(ctx.rt.generation.responseSpeed.snapshot().durationMs).toBe(0);
  ctx.turn.interruptRequested = true;
  const stoppedEvents = events.length;
  translateSdkMessage({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 3,
    retry_delay_ms: 1000, error_status: 529, error: 'overloaded_error' }, queue, ctx);
  expect(events).toHaveLength(stoppedEvents);
});
