import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import { CONTEXT_OVERFLOW_REASON } from '../../shared/context-overflow-error.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

/**
 * 上下文超限终态(#1429)的翻译层行为:
 *  (a) error 事件带 CONTEXT_OVERFLOW_REASON(renderer 隐藏必败 Retry 的依据);
 *  (b) tracker 锁到窗口满载 → status Done / done 的 endSnapshot 如实显示"已超限",
 *      onUsageUpdate 拿到 ratio=1.0(turn end 的 auto-compact 判定由此触发);
 *  (c) 失败轮的 0 增量 usage 不得把 (b) 刚锁上的值又冲回 0(replaceLastApi 守卫)。
 */

// #1429 实踩的 litellm/Azure 原文(经 xd 网关)。
const OVERFLOW_ERROR_TEXT =
  'API Error: 400 litellm.BadRequestError: AzureException BadRequestError - { "error": { "message": "Your input exceeds the context window of this model. Please adjust your input and try again.", "type": "invalid_request_error", "param": "input", "code": "context_length_exceeded" } }';

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
    getModel: () => 'gpt-5.6-sol',
    getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker,
    getModelContextWindow: () => 272_000,
    onUsageUpdate: vi.fn(),
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

describe('Claude Code translator context-overflow terminal result', () => {
  it('tags the terminal error with the stable reason and locks the tracker to a full window', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);
    // 会话重启后首轮就失败的最坏形态: tracker 全新, lastApi=0(圆环本来会一直 0%)。
    ctx.turn.apiCalls = 1;

    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: OVERFLOW_ERROR_TEXT,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        // 400 被上游整体拒绝: SDK 的 result.usage 停在会话累计旧值, 本轮 delta 为 0。
        usage: { input_tokens: 0, output_tokens: 0 },
        modelUsage: {
          'gpt-5.6-sol': { inputTokens: 0, outputTokens: 0, costUSD: 0, contextWindow: 272_000 },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect(error!.data).toMatchObject({ isTerminal: true, reason: CONTEXT_OVERFLOW_REASON });

    // (b) endSnapshot 如实显示满载 —— status Done 事件与 tracker 本体一致
    const done = events.find((e) => e.type === 'status');
    expect(done!.data).toMatchObject({ contextTokens: 272_000, contextWindow: 272_000 });
    expect(tracker.snapshot().contextTokens).toBe(272_000);

    // auto-compact / memory-flush 观察到 ratio=1.0
    expect(ctx.onUsageUpdate).toHaveBeenCalledWith(272_000, 272_000);
  });

  it('detects overflow that is only present in the pending API-error envelope', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);
    ctx.turn.apiCalls = 1;
    ctx.turn.pendingApiError = {
      message: OVERFLOW_ERROR_TEXT,
      sdkError: 'api_error',
    };

    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: '',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const error = events.find((e) => e.type === 'error');
    expect(error!.data).toMatchObject({ isTerminal: true, reason: CONTEXT_OVERFLOW_REASON });
    expect(tracker.snapshot().contextTokens).toBe(272_000);
  });

  it('does NOT tag ordinary terminal errors and does NOT touch the tracker', async () => {
    const tracker = new UsageTracker();
    tracker.setContextWindow(272_000);
    tracker.ingestApiCallUsage({ inputTokens: 50_000, outputTokens: 10 });
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);
    ctx.turn.apiCalls = 1;

    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: 'Internal server error, please retry later.',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error!.data as { reason?: string }).reason).toBeUndefined();
    // 普通失败不伪造读数
    expect(tracker.snapshot().contextTokens).toBe(50_000);
  });

  it('does NOT mark an interrupted turn even when the drained result text matches', async () => {
    // interrupt 后 drain 出的 result 不是上游失败(is_error 兜底同款排除),
    // 不能借它把圆环推到 100%。
    const tracker = new UsageTracker();
    tracker.setContextWindow(272_000);
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);
    ctx.turn.apiCalls = 1;
    ctx.turn.interruptRequested = true;

    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: OVERFLOW_ERROR_TEXT,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
      },
      queue,
      ctx,
    );

    await drain(queue);
    expect(tracker.snapshot().contextTokens).toBe(0);
  });

  it('keeps the locked value when the failed turn carries a real (non-zero) usage delta', async () => {
    // 单 API 轮的 replaceLastApi 语义对正常轮保留; 超限轮守卫 !isContextOverflowTurn
    // 确保失败轮 usage(常为 0 或残缺)不覆盖满载标记。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);
    ctx.turn.apiCalls = 1;

    translateSdkMessage(
      {
        type: 'result',
        is_error: true,
        result: OVERFLOW_ERROR_TEXT,
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 1_234, output_tokens: 0 },
      },
      queue,
      ctx,
    );

    await drain(queue);
    expect(tracker.snapshot().contextTokens).toBe(272_000);
  });
});
