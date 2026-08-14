import { describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';

// silent-stop 判定单测:上游偶发用一条空内容 assistant 消息收尾"干到一半"的
// turn(空 thinking + end_turn,或 SSE 静默中断后 stop_reason 缺失;社区同型
// anthropics/claude-code#50597 / #38905)。验证三件事:
//  1) 命中形态时落 WARN 日志(dev 排查);
//  2) 命中时 done.data 附加 silentStop 标记(host 自动续跑守卫的决策信号);
//  3) 事件流其余零变更 —— status Done + done 照发、不发 error(与 empty-response
//     终态收尾路径明确区分);不命中时 done.data 不带标记。

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
    getModel: () => 'claude-fable-5',
    getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker,
    getModelContextWindow: () => 1_000_000,
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

function doneSilentStopFlag(events: AgentEvent[]): boolean | undefined {
  const done = events.find((e) => e.type === 'done');
  return (done?.data as { silentStop?: boolean } | undefined)?.silentStop;
}

function silentStopWarned(ctx: ReturnType<typeof createCtx>): boolean {
  return ctx.log.warn.mock.calls.some(
    ([message]) => typeof message === 'string' && message.includes('silent stop'),
  );
}

/** 干活形态的前半段: 一条带 tool_use 的 assistant 消息(toolUses>0 且 substance=true)。 */
function pushToolUseMessage(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>, ctx: ReturnType<typeof createCtx>): void {
  translateSdkMessage(
    { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 1000 } } } },
    queue,
    ctx,
  );
  translateSdkMessage(
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/tmp/a' } }] },
    },
    queue,
    ctx,
  );
}

/** 事故形态的收尾: 最后一条 assistant 消息只有一个空 thinking 块(#50597 指纹)。 */
function pushEmptyThinkingMessage(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>, ctx: ReturnType<typeof createCtx>): void {
  translateSdkMessage(
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } },
    queue,
    ctx,
  );
}

const NON_EMPTY_USAGE = { input_tokens: 1000, output_tokens: 2 };

describe('Claude Code translator silent-stop observation (log only)', () => {
  it('logs a silent-stop WARN when a mid-task turn ends with an empty assistant message (stop_reason missing)', async () => {
    // #38905 形态: SSE 静默中断, result 无 stop_reason、无兜底文本。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '继续分析中', signature: 'sig-2' }] } },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'result', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(silentStopWarned(ctx), 'must log silent-stop WARN').toBe(true);
    // done.data 附加 silentStop 标记给 host 守卫; 其余收尾照旧, 不发 error。
    expect(doneSilentStopFlag(events), 'done.data.silentStop must be true').toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(events.some((e) => e.type === 'status' && (e.data as { status?: string }).status === 'Done')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('logs a silent-stop WARN for the end_turn variant too (#50597 fingerprint)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    pushEmptyThinkingMessage(queue, ctx);
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  it('does NOT log when the final assistant message carries text (normal completion)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '任务完成。' }] } },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', result: '任务完成。', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events), 'normal turn done.data must NOT carry silentStop').toBeUndefined();
  });

  it('does NOT log when the final assistant message is a tool_use (AskUserQuestion-like waits)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
  });

  it('does NOT log on an is_error result (error path owns that turn)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    pushEmptyThinkingMessage(queue, ctx);
    translateSdkMessage(
      { type: 'result', is_error: true, result: 'boom', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
  });

  it('does NOT log when the turn was interrupted by maker (user stop / watchdog)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    pushEmptyThinkingMessage(queue, ctx);
    ctx.turn.interruptRequested = true;
    translateSdkMessage(
      { type: 'result', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
  });

  it('marks a zero-tool thinking-only turn as a silent stop', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 1000 } } } },
      queue,
      ctx,
    );
    pushEmptyThinkingMessage(queue, ctx);
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  it('marks the thinking-only auto-resume turn after a tool turn also silently stops', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    pushEmptyThinkingMessage(queue, ctx);
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 2000 } } } },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '续跑后仍在分析', signature: 'sig-2' }] } },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0.2,
        usage: { input_tokens: 2000, output_tokens: 4 },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const flags = events
      .filter((event) => event.type === 'done')
      .map((event) => (event.data as { silentStop?: boolean }).silentStop);
    expect(flags).toEqual([true, true]);
  });

  it('does NOT mark a zero-tool turn that already emitted visible text before trailing thinking', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 1000 } } } },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '先给你结论。' }] } },
      queue,
      ctx,
    );
    pushEmptyThinkingMessage(queue, ctx);
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events)).toBeUndefined();
  });

  it('treats unknown assistant blocks as substance instead of auto-resuming them', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 1000 } } } },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'server_tool_use', id: 'server-tool-1', name: 'web_search' }] },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events)).toBeUndefined();
  });

  it('does NOT log when result.result repairs the missing tail (truncation fallback already recovers)', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    pushEmptyThinkingMessage(queue, ctx);
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', result: '最终回复', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    // 尾部兜底把 result.result 补推成了正文, turn 对用户可见地"有产出"。
    expect(events.some((e) => e.type === 'text' && (e.data as { text?: string }).text === '最终回复')).toBe(true);
  });

  it('does NOT double-report an empty-response turn (that guard owns whole-turn-empty)', async () => {
    // 整轮 0 产出 + usage 全 0 走 isEmptyResponseTurn 的终态 error 收尾, silent-stop 不叠加。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    translateSdkMessage(
      { type: 'stream_event', event: { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 0 } } } },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(events.some((e) => e.type === 'error' && (e.data as { reason?: string }).reason === 'empty-response')).toBe(true);
    expect(silentStopWarned(ctx)).toBe(false);
  });
});
