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

describe('Claude Code translator is_error result guard', () => {
  it('carries the assistant API message id into done for Vertex lag detection', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          id: 'msg_vrtx_123',
          content: [{ type: 'text', text: '完成' }],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        result: '完成',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 20_000, output_tokens: 7 },
        modelUsage: {
          'claude-opus-4-8': {
            inputTokens: 20_000,
            outputTokens: 7,
            costUSD: 0,
            contextWindow: 200_000,
          },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const done = events.find((event) => event.type === 'done');
    expect(done?.data).toMatchObject({ assistant_message_id: 'msg_vrtx_123' });
  });

  it('surfaces a terminal error AND keeps the Done/done tail when is_error arrives without a prior envelope', async () => {
    // 原 bug 路径②: result.is_error 但 turn 内没有任何 API-error envelope → 旧实现只发
    // status Done + done, renderer 的 state.error 不置位, 失败被通知成"已完成"。
    // 修复后序列 = error → status Done → done, 与 envelope 场景既有失败序列同构;
    // done 不能砍: main 的花费记账只从 done 的 result payload 读数(Codex review P2)。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 100 } } } },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: 'API request failed: model not available',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 2 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 100, outputTokens: 2, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const errIdx = events.findIndex((e) => e.type === 'error');
    const doneIdx = events.findIndex((e) => e.type === 'done');
    expect(errIdx, 'is_error result must surface a terminal error').toBeGreaterThanOrEqual(0);
    expect(events[errIdx]?.data).toMatchObject({ message: 'API request failed: model not available', isTerminal: true });
    // done 尾巴保留(usage 记账依赖), 且在 error 之后。
    expect(doneIdx, 'done must still be emitted for usage accounting').toBeGreaterThan(errIdx);
    expect(
      events.some((e) => e.type === 'status' && (e.data as { status?: string }).status === 'Done'),
      'Done status preserved',
    ).toBe(true);
    // 错误文本只走 error banner: text fallback 的 full 计算源头排除 is_error
    // (full = !msg.is_error && ...), msg.result 不会被补推成正文气泡 / 落库。
    expect(events.some((e) => e.type === 'text'), 'error detail must NOT be duplicated as a text event').toBe(false);
  });

  it('redacts credentials from Claude API error envelopes and terminal results', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'assistant',
        error: 'authentication_failed',
        message: {
          content: [
            {
              type: 'text',
              text: 'Invalid proxy server token; Received API Key = sk-live-123456789; Key Hash (Token) = hash-abc',
            },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: 'Authorization: Bearer secret-token',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 1, outputTokens: 1, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const error = events.find((event) => event.type === 'error');
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain('sk-live-123456789');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('hash-abc');
    expect(serialized).toContain('[REDACTED]');
    expect(JSON.stringify(ctx.log.debug.mock.calls)).not.toContain('secret-token');
    expect(JSON.stringify(ctx.log.warn.mock.calls)).not.toContain('secret-token');
    expect(ctx.log.warn).toHaveBeenCalledWith(
      'SDK ◀ turn ended with error',
      expect.objectContaining({ output: 'Authorization: [REDACTED]' }),
    );
  });

  it('preserves non-secret status and quota signals from a redacted terminal result', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: 'Authorization: Bearer secret-token, status=429, quota exhausted',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {
          'codex/gpt-5.5': {
            inputTokens: 1,
            outputTokens: 1,
            costUSD: 0,
            contextWindow: 272_000,
          },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const error = events.find((event) => event.type === 'error');
    expect(error?.data).toMatchObject({
      message: 'Authorization: [REDACTED]',
      errorStatus: 429,
      usageLimit: true,
      isTerminal: true,
    });
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('preserves non-secret signals from an error envelope when the terminal result is empty', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'assistant',
        error: 'rate_limit',
        message: {
          content: [
            {
              type: 'text',
              text: 'Authorization: Bearer secret-token, status=429, quota exhausted',
            },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: '',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 0 },
        modelUsage: {
          'codex/gpt-5.5': {
            inputTokens: 1,
            outputTokens: 0,
            costUSD: 0,
            contextWindow: 272_000,
          },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const error = events.find((event) => event.type === 'error');
    expect(error?.data).toMatchObject({
      message: 'Authorization: [REDACTED]',
      errorStatus: 429,
      usageLimit: true,
      isTerminal: true,
    });
    expect(JSON.stringify(events)).not.toContain('secret-token');
  });

  it('falls back to reason=turn-failed when is_error carries no result text', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 100 } } } },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 0 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 100, outputTokens: 0, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err?.data).toMatchObject({ reason: 'turn-failed', isTerminal: true });
    // done 尾巴保留(usage 记账依赖)。
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('discards a provisional API-error envelope when the SDK retry later succeeds', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'assistant',
        error: 'unknown',
        uuid: 'retry-error-envelope',
        message: {
          model: 'codex/gpt-5.5',
          content: [{ type: 'text', text: 'API Error: The operation timed out.' }],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 1_000,
        error_status: null,
        error: 'unknown',
      },
      queue,
      ctx,
    );

    expect(queue.pending, 'retryable envelope must not close the turn').toBe(0);

    translateSdkMessage(
      {
        type: 'result',
        is_error: false,
        result: 'Recovered after retry.',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 5 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 100, outputTokens: 5, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'text' && (e.data as { text?: string }).text === 'Recovered after retry.')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(ctx.turn.pendingApiError).toBeNull();
    expect(ctx.rt.lastAssistantMeta, 'error envelope must not become a transcript anchor').toBeNull();
    expect(ctx.log.info).toHaveBeenCalledWith('SDK API request retrying', expect.objectContaining({
      attempt: 1,
      errorStatus: null,
    }));
  });

  it('surfaces one detailed terminal error when an API-error envelope ends in an error result', async () => {
    // envelope 先暂存，最终 is_error result 才推一次 terminal error；Done/done 继续
    // 保留给下游收口与 usage 记账。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 100 } } } },
      queue,
      ctx,
    );
    const pendingBeforeEnvelope = queue.pending;
    // API-error envelope: assistant 消息带 error tag。
    translateSdkMessage(
      {
        type: 'assistant',
        error: 'rate_limit',
        message: {
          model: 'codex/gpt-5.5',
          content: [{ type: 'text', text: 'Rate limited — retry later.' }],
        },
      },
      queue,
      ctx,
    );
    expect(queue.pending, 'envelope alone is provisional').toBe(pendingBeforeEnvelope);
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 3,
        retry_delay_ms: 1_000,
        error_status: 500,
        error: 'server_error',
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: 'Rate limited — retry later. Authorization: Basic dXNlcjpwYXNz; status=429',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 2 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 100, outputTokens: 2, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors, 'exactly one terminal error (at result)').toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({
      message: 'Rate limited — retry later.',
      sdkError: 'rate_limit',
      errorStatus: 429,
      isTerminal: true,
    });
    const done = events.find((e) => e.type === 'done');
    expect(done, 'done tail preserved for envelope-closed turns').toBeDefined();
    expect((done?.data as { result?: string }).result).toBe(
      'Rate limited — retry later. Authorization: [REDACTED]; status=429',
    );
  });

  it('keeps api_retry details when the final failure has no assistant error envelope', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 3,
        max_retries: 3,
        retry_delay_ms: 4_000,
        error_status: null,
        error: 'unknown',
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 0 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 100, outputTokens: 0, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const errors = events.filter((e) => e.type === 'error');
    // 只有一条终态：这是 connection error（非过载），重试进行中**不**透出进度。
    // 透出的 message 是内部英文 SDK 字符串，只有过载与网络形态会被 ErrorBanner
    // 本地化替换；把其它类别也透出来会让各语言用户看到裸英文（review #844 P1）。
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({
      message: 'SDK API request failed: unknown (connection error, retry 3/3)',
      sdkError: 'unknown',
      errorStatus: null,
      retryAttempt: 3,
      maxRetries: 3,
      isTerminal: true,
    });
    expect(errors[0]?.agentMeta, 'api_retry has no assistant transcript anchor').toBeUndefined();
    expect(events.some((e) => e.type === 'done'), 'done tail remains available for usage accounting').toBe(true);
  });

  // SDK 自带退避重试（529 overloaded / 429 / 连接错误都走它）。这组用例锁住
  // "透出进度但绝不自己重投"：客户端再叠一层重试会把一次上游过载放大成指数级
  // 请求，而失败请求照扣额度。
  it('does not surface the first api_retry (single blip would only flicker)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 10,
        retry_delay_ms: 1_000,
        error_status: 529,
        error: 'overloaded_error',
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it.each([
    { label: '429 rate limit', error_status: 429, error: 'rate_limit_error' },
    { label: '500 server error', error_status: 500, error: 'api_error' },
    { label: 'connection error', error_status: null, error: 'unknown' },
  ])('does not surface non-overload retry progress ($label)', async ({ error_status, error }) => {
    // 这些类别的 message 不会被 ErrorBanner 本地化，透出等于给所有语言的用户
    // 一段裸英文；改动前它们是静默的，必须保持静默（review #844 P1）。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 3,
        max_retries: 10,
        retry_delay_ms: 2_000,
        error_status,
        error,
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('surfaces 529 overload retries as non-terminal progress carrying errorStatus', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 2_000,
        error_status: 529,
        error: 'overloaded_error',
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const errors = events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.data).toMatchObject({
      // errorStatus 必须透出：renderer 靠它把 529 判成过载而不是普通网络错误。
      errorStatus: 529,
      isTerminal: false,
      willRetry: true,
    });
    // 进度后缀与 Codex 侧同一套跨 agent 协议，renderer 只需一份解析。
    expect((errors[0]?.data as { message: string }).message).toContain('(auto-retry 2/10)');
    expect((errors[0]?.data as { message: string }).message).toContain('HTTP 529');
    // 非终止 → 不得让上层收口本轮。
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  it('does NOT emit a fallback error for an interrupted turn (user stop / watchdog)', async () => {
    // 用户点停止(handle.abort)与 watchdog 都走 q.interrupt(), SDK 随后 drain 出
    // error_during_execution 的 is_error result——这不是上游失败, 不能补 terminal
    // error, 否则"用户点停止"被误报成"执行失败"通知、watchdog 场景双发 banner
    // (review P1)。interrupt 发起处已置 interruptRequested。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 100 } } } },
      queue,
      ctx,
    );
    ctx.turn.interruptRequested = true; // abort()/watchdog 在 q.interrupt() 前置位
    translateSdkMessage(
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 2 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 100, outputTokens: 2, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error'), 'interrupted turn must stay quiet (no fallback error)').toBe(false);
    // 收尾与改动前一致: status Done + done 照发(usage 记账也保留)。
    expect(events.some((e) => e.type === 'done')).toBe(true);
    // 标记随 turn 收尾复位, 不污染下一轮。
    expect(ctx.turn.interruptRequested).toBe(false);
  });

  it('drops a stale interrupted result entirely when a newer send has taken over', async () => {
    // interrupt 后用户立刻发新消息(beginNewTurn 代际前进), 被打断 turn 的
    // error_during_execution result 迟到 drain: 不能发 error(误报), 也不能发
    // status Done/done(会被 main 当作**当前** turn 边界, 提前终结新 turn),
    // 必须整条丢弃并消费标记(review P2)。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    ctx.turn.interruptRequested = true;
    ctx.turn.interruptGeneration = 0; // interrupt 发生在第 0 代
    ctx.turn.generation = 1; // 新 send 已接管(beginNewTurn 自增)
    translateSdkMessage(
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 2 },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(events, 'stale interrupted result must be dropped entirely').toEqual([]);
    // 标记随消费清除, 新 turn 的真实 is_error 兜底不受影响。
    expect(ctx.turn.interruptRequested).toBe(false);
  });

  it('does not affect a normal non-error turn (Done/done, no error)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'codex/gpt-5.5', usage: { input_tokens: 100 } } } },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        result: 'all good',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 100, output_tokens: 5 },
        modelUsage: { 'codex/gpt-5.5': { inputTokens: 100, outputTokens: 5, costUSD: 0, contextWindow: 272_000 } },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
