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

/**
 * 派发类工具的一次完整往返：tool_use + tool_result。
 * 回执正文按 lizi-mcps okPayload 的真实形状传（JSON 文本），toolName 可换成
 * create_workers / interrupt_worker / send_to_worker。
 */
function pushWorkerToolResult(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  options: { name?: string; payload?: Record<string, unknown>; isError?: boolean } = {},
): void {
  const name = options.name ?? 'mcp__cindy_orca__create_worker';
  const payload = options.payload ?? { ok: true, worker_id: 'w-1', dispatched: true, queued_message_id: 'm-1' };
  translateSdkMessage(
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'worker-1', name, input: { label: 'worker' } }] },
    },
    queue,
    ctx,
  );
  translateSdkMessage(
    {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'worker-1',
          content: JSON.stringify(payload),
          ...(options.isError ? { is_error: true } : {}),
        }],
      },
    },
    queue,
    ctx,
  );
}

/** 派发回执之后的正常收口形态：空 thinking + end_turn。 */
function finishWithEmptyThinking(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
): void {
  pushEmptyThinkingMessage(queue, ctx);
  translateSdkMessage(
    { type: 'result', stop_reason: 'end_turn', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
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

  it('hides a leaked Grok stop token without treating the wrap-up as silent-stop', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '<|eos|>' }] } },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'result', stop_reason: 'end_turn', result: '<|eos|>', total_cost_usd: 0.1, usage: NON_EMPTY_USAGE },
      queue,
      ctx,
    );

    const events = await drain(queue);
    expect(events.filter((event) => event.type === 'text')).toEqual([]);
    expect(ctx.turn.lastAssistantMsgHadSubstance).toBe(true);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events)).toBeUndefined();
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

  it('does NOT mark a successful Worker dispatch as a silent stop', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx);
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events)).toBeUndefined();
  });

  it('keeps silent-stop detection for a failed Worker dispatch', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx, { payload: { ok: false, errorCode: 'BUSY' }, isError: true });
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  /**
   * create_worker 没传 initial_task、或 Worker 建好但首条任务没送达时，
   * lizi-mcps 仍返回 ok=true（只带 dispatched=false / dispatch_outcome 失败）。
   * 这种回执不会有 Worker 回报，把空 thinking 收口当正常完成就会永久停摆。
   */
  it('keeps silent-stop detection when create_worker succeeded but dispatched nothing', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx, {
      payload: {
        ok: true,
        worker_id: 'w-1',
        dispatched: false,
        dispatch_outcome: { kind: 'host-send', accepted: false, wakeKind: 'idle' },
      },
    });
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  it('accepts dispatch_outcome session-dispatch as a real dispatch', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx, {
      payload: { ok: true, worker_id: 'w-1', dispatch_outcome: { kind: 'session-dispatch', dispatched: true, wakeKind: 'queued' } },
    });
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events)).toBeUndefined();
  });

  it('treats a queued interrupt_worker replacement as a real dispatch', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx, {
      name: 'mcp__cindy_orca__interrupt_worker',
      payload: { ok: true, target_session_id: 's-1', queued_message_id: 'm-9', stop_outcome: 'unsupported', queue_paused: false },
    });
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events)).toBeUndefined();
  });

  it('keeps silent-stop detection when interrupt_worker queued nothing', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx, {
      name: 'mcp__cindy_orca__interrupt_worker',
      payload: { ok: true, target_session_id: 's-1', stop_outcome: 'unsupported' },
    });
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  /**
   * create_workers 批量派发即使全部成功也带 user_report / 逐项结果，提示词要求
   * 先转告用户再收口，所以不能复用单 Worker 的「零正文即正常完成」豁免。
   */
  it('keeps silent-stop detection for a create_workers batch that must be reported', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx, {
      name: 'mcp__cindy_orca__create_workers',
      payload: {
        ok: true,
        request_count: 2,
        success_count: 1,
        failure_count: 1,
        user_report: '已创建 developer/w-1，reviewer 创建失败：DUPLICATE_LABEL',
      },
    });
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  it('keeps silent-stop detection when a send_to_worker steer fell back to the queue', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx, {
      name: 'mcp__cindy_orca__send_to_worker',
      payload: { ok: true, target_session_id: 's-1', wake_kind: 'queued', queued_message_id: 'm-3', steer_fallback_reason: 'INPUT_BOUNDARY_BUSY' },
    });
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    // steer 没插成时主 Agent 还要做队列提升，这一轮零正文收口不算正常完成。
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  it('resets the dispatch flag at turn end so the next turn keeps silent-stop detection', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolResult(queue, ctx);
    expect(ctx.turn.completedWorkerDispatch).toBe(true);
    finishWithEmptyThinking(queue, ctx);

    await drain(queue);
    // turn 收尾必须清掉，否则下一条普通任务的真正 thinking-only 中断不再恢复。
    expect(ctx.turn.completedWorkerDispatch).toBe(false);
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

  /**
   * #8240 regression / unit: exercise the production Claude translator. Existing visible-text
   * coverage used a zero-tool turn, while the `toolUses > 0` exception still marked this shape
   * silent. The minimal failure input is a tool call, visible assistant text, then only a
   * redacted_thinking block before end_turn; already-delivered text must prevent auto-resume.
   */
  it('does NOT mark a tool turn silent after visible text and trailing redacted thinking', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushToolUseMessage(queue, ctx);
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'text', text: '已经完成并给出结果。' }] } },
      queue,
      ctx,
    );
    translateSdkMessage(
      { type: 'assistant', message: { content: [{ type: 'redacted_thinking', data: 'opaque' }] } },
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
    expect(events.some((event) => event.type === 'text' && (event.data as { text?: string }).text === '已经完成并给出结果。')).toBe(true);
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
