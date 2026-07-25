import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

function createTurnState(): TurnState {
  return {
    text: '',
    toolUses: 0,
    apiCalls: 0,
    sawCompactBoundary: false,
    hasEmittedText: false,
    uiEmittedText: '',
    pendingApiError: null,
    interruptRequested: false,
    generation: 0,
    interruptGeneration: 0,
    lastAssistantMsgHadSubstance: true,
  };
}

function createCtx(tracker: UsageTracker) {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'codex/gpt-5.5',
    getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker,
    getModelContextWindow: () => 272_000,
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

describe('Claude Code translator empty-response guard', () => {
  it('surfaces an empty-response error when an API call returns no content and zero usage', async () => {
    // 模拟折扣网关短路: message_start 发起一次 API call, 但整轮 0 文本 / 0 tool / usage 全 0。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'codex/gpt-5.5', usage: { input_tokens: 0 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {
          'codex/gpt-5.5': { inputTokens: 0, outputTokens: 0, costUSD: 0, contextWindow: 272_000 },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const err = events.find((e) => e.type === 'error');
    expect(err, 'should emit an error event for the empty turn').toBeDefined();
    expect(err?.data).toMatchObject({ reason: 'empty-response', isTerminal: true });
    // 终态收尾: 命中后只发 terminal error, 不再发 status Done / done —— 否则同一 turn
    // 会被下游双重收尾(origin 被清后 done 拿不到 origin / onTurnEnd 与 onTurnAbort 都触发)。
    expect(events.some((e) => e.type === 'done'), 'must NOT emit done after terminal error').toBe(false);
    expect(
      events.some((e) => e.type === 'status' && (e.data as { status?: string }).status === 'Done'),
      'must NOT emit Done status after terminal error',
    ).toBe(false);
  });

  it('flags an empty turn in a LONG session where msg.usage aggregate is still non-zero', async () => {
    // 回归(Codex P1): Claude Code result.usage 是 session 累计值。长会话里本轮空响应时,
    // msg.usage 仍带历史累计的非零 input_tokens, 用 msg.usage 判 0 会漏判 —— 正是长会话
    // "假死"场景。必须用 per-turn delta(resultUsage)判 0。本测试在旧实现(看 msg.usage)下失败。
    const tracker = new UsageTracker();
    const ctx = createCtx(tracker);

    // Turn 1: 正常完成一轮, 把 session 累计 aggregate 抬到非零 (input 1000 / output 50)。
    const q1 = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 1000 } } } },
      q1,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        result: 'ok',
        usage: { input_tokens: 1000, output_tokens: 50 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 1000, outputTokens: 50, costUSD: 0, contextWindow: 272_000 } },
      },
      q1,
      ctx,
    );
    await drain(q1);

    // Turn 2: 本轮 API call 空响应 —— 累计 aggregate 没变(仍 {1000,50}), 但本轮增量为 0。
    const q2 = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 0 } } } },
      q2,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1000, output_tokens: 50 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 1000, outputTokens: 50, costUSD: 0, contextWindow: 272_000 } },
      },
      q2,
      ctx,
    );
    const events = await drain(q2);

    const err = events.find(
      (e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'empty-response',
    );
    expect(err, 'long-session empty turn (aggregate non-zero, delta zero) must still be flagged').toBeDefined();
  });

  it('preserves prior context tokens on an empty turn (does not zero out lastApi)', async () => {
    // 回归(Codex P2): 空响应轮不能 replaceLastApi 把 contextTokens 清成 0, 否则 auto-compact /
    // memory-flush / UI 环丢失真实 context, 用户重试会反复撞同一超限空响应而非先压缩。
    const tracker = new UsageTracker();
    const ctx = createCtx(tracker);

    // Turn 1: 正常一轮, 真实 context ~5000 tokens。
    const q1 = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 5000 } } } },
      q1,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        result: 'ok',
        usage: { input_tokens: 5000, output_tokens: 50 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 5000, outputTokens: 50, costUSD: 0, contextWindow: 272_000 } },
      },
      q1,
      ctx,
    );
    await drain(q1);
    expect(tracker.snapshot().contextTokens).toBe(5000);

    // Turn 2: 空响应(message_start input 0, aggregate 不变 → 本轮增量 0)。
    const q2 = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 0 } } } },
      q2,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 5000, output_tokens: 50 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 5000, outputTokens: 50, costUSD: 0, contextWindow: 272_000 } },
      },
      q2,
      ctx,
    );
    const events = await drain(q2);

    // 仍报空响应错误...
    expect(events.some((e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'empty-response')).toBe(true);
    // ...但 context tokens 保留上一轮真实值, 没被清成 0。
    expect(tracker.snapshot().contextTokens).toBe(5000);
  });

  it('does NOT flag a turn that streamed usage but omitted result.usage', async () => {
    // 回归(Codex P2): 有些 provider 不在 result 报 usage, 但已通过 message_start/delta 上报
    // 非零 usage(ingest 进 tracker)。resultUsage=undefined 时不能当成全 0, 否则"消耗了
    // token 但 result 没带 usage"的正常轮会被误判成空响应。应回退到 tracker 本轮累计。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 500 } } } },
      queue,
      ctx,
    );
    // result 不带 usage 字段 → resultUsage=undefined; 但本轮已 streamed 500 input。
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 500, outputTokens: 0, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const err = events.find(
      (e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'empty-response',
    );
    expect(err, 'streamed-usage turn must NOT be flagged empty').toBeUndefined();
  });

  it('preserves the aggregate usage baseline across an empty turn (does not advance it to zero)', async () => {
    // 回归(Codex P2): 空响应轮 result.usage 报 0 时, 不能让它成为 lastResultUsageAggregate 基线,
    // 否则下一个真实 turn 会拿 SDK 累计 result.usage 去减 0、把整段历史 token 全算到那一轮。
    const tracker = new UsageTracker();
    const ctx = createCtx(tracker);

    // Turn 1: 真实一轮, 累计 aggregate 抬到 {1000, 50}。
    const q1 = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 1000 } } } },
      q1,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        result: 'ok',
        usage: { input_tokens: 1000, output_tokens: 50 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 1000, outputTokens: 50, costUSD: 0, contextWindow: 272_000 } },
      },
      q1,
      ctx,
    );
    await drain(q1);
    expect(ctx.rt.lastResultUsageAggregate?.inputTokens).toBe(1000);

    // Turn 2: 空响应, result.usage 报 0(网关短路)。
    const q2 = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 0 } } } },
      q2,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 0, outputTokens: 0, costUSD: 0, contextWindow: 272_000 } },
      },
      q2,
      ctx,
    );
    const events = await drain(q2);

    // 命中空响应错误, 且 aggregate 基线被还原到 turn1 的 {1000,50}(没被 0 污染)。
    expect(events.some((e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'empty-response')).toBe(true);
    expect(ctx.rt.lastResultUsageAggregate?.inputTokens).toBe(1000);
    expect(ctx.rt.lastResultUsageAggregate?.outputTokens).toBe(50);
  });

  it('does NOT flag a compact-only turn (sawCompactBoundary) as an empty response', async () => {
    // compact_boundary 那一轮可能压缩后无文本 / 工具、result usage 记 0, 属合法轮, 不该报错。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'codex/gpt-5.5', usage: { input_tokens: 0 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger: 'auto', pre_tokens: 200_000, post_tokens: 20_000, duration_ms: 100 },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {
          'codex/gpt-5.5': { inputTokens: 0, outputTokens: 0, costUSD: 0, contextWindow: 272_000 },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const err = events.find(
      (e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'empty-response',
    );
    expect(err).toBeUndefined();
  });

  it('does NOT flag an empty turn when usage is non-zero (model ran, just produced no text)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'codex/gpt-5.5', usage: { input_tokens: 100 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 2 },
        modelUsage: {
          'codex/gpt-5.5': { inputTokens: 100, outputTokens: 2, costUSD: 0, contextWindow: 272_000 },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const err = events.find(
      (e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'empty-response',
    );
    expect(err).toBeUndefined();
  });

  it('does NOT flag a result that arrives without any API call (apiCalls === 0)', async () => {
    // 已有的合法退化场景: result 到达但本轮没有任何 API call, usage 也全 0 —— 不是网关空响应。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {
          'codex/gpt-5.5': { inputTokens: 0, outputTokens: 0, costUSD: 0, contextWindow: 272_000 },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const err = events.find(
      (e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'empty-response',
    );
    expect(err).toBeUndefined();
  });
});
