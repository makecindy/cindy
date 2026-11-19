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
  options: { id?: string; name?: string; payload?: Record<string, unknown>; isError?: boolean } = {},
): void {
  const id = options.id ?? 'worker-1';
  const name = options.name ?? 'mcp__cindy_orca__create_worker';
  const payload = options.payload ?? { ok: true, worker_id: 'w-1', dispatched: true, queued_message_id: 'm-1' };
  translateSdkMessage(
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name, input: { label: 'worker' } }] },
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
          tool_use_id: id,
          content: JSON.stringify(payload),
          ...(options.isError ? { is_error: true } : {}),
        }],
      },
    },
    queue,
    ctx,
  );
}

/** 同一轮并行派单：一条 assistant 消息里挂多个 tool_use，回执同批返回。 */
function pushWorkerToolBatch(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
  ctx: ReturnType<typeof createCtx>,
  calls: { name: string; payload: Record<string, unknown>; isError?: boolean }[],
): void {
  translateSdkMessage(
    {
      type: 'assistant',
      message: {
        content: calls.map((call, index) => ({
          type: 'tool_use',
          id: `worker-${index}`,
          name: call.name,
          input: { label: `worker-${index}` },
        })),
      },
    },
    queue,
    ctx,
  );
  translateSdkMessage(
    {
      type: 'user',
      message: {
        content: calls.map((call, index) => ({
          type: 'tool_result',
          tool_use_id: `worker-${index}`,
          content: JSON.stringify(call.payload),
          ...(call.isError ? { is_error: true } : {}),
        })),
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

  /**
   * 并行派单里只要有一项没派出去，主 Agent 就必须先报告失败项；
   * 成功项不能替整批拿到「零正文收口」豁免（两种回执顺序都验一遍）。
   */
  it.each([
    ['success first', { ok: true, dispatched: true, wake_kind: 'resumed', worker_id: 'w-1' }, { ok: false, errorCode: 'BUSY' }],
    ['failure first', { ok: false, errorCode: 'BUSY' }, { ok: true, dispatched: true, wake_kind: 'resumed', worker_id: 'w-1' }],
  ])('keeps silent-stop detection for a mixed dispatch batch (%s)', async (_label, first, second) => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolBatch(queue, ctx, [
      { name: 'mcp__cindy_orca__create_worker', payload: first as Record<string, unknown>, isError: (first as { ok?: boolean }).ok === false },
      { name: 'mcp__cindy_orca__send_to_worker', payload: second as Record<string, unknown>, isError: (second as { ok?: boolean }).ok === false },
    ]);
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  it('keeps silent-stop detection when a non-dispatch tool in the dispatch batch failed', async () => {
    // 并行批次 = 真实 send_to_worker 派发 + 非 Orca 工具报错(如 Read 失败)。
    // 失败项的名字不匹配派发工具,不能因此丢掉汇报义务:模型只回 thinking 收尾时,
    // 派发成功项的豁免会把失败静默吞掉(用户既不知道派发结果也不知道失败原因)。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolBatch(queue, ctx, [
      { name: 'mcp__cindy_orca__send_to_worker', payload: { ok: true, target_session_id: 's-1', wake_kind: 'queued', queued_message_id: 'm-1' } },
      { name: 'Read', payload: { error: 'ENOENT: no such file /tmp/a' }, isError: true },
    ]);
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(true);
    expect(doneSilentStopFlag(events)).toBe(true);
  });

  // #9221 review: old coverage only mixed errors into the dispatch batch.
  // A corrected ordinary error in an earlier batch must not cause a hidden
  // Continue after a later confirmed handoff. Real translator/done, unit tier.
  it('does not carry a repaired Read error into a later successful dispatch', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushWorkerToolResult(queue, ctx, {
      id: 'read-missing', name: 'Read', payload: { error: 'ENOENT' }, isError: true,
    });
    pushWorkerToolResult(queue, ctx, {
      id: 'read-corrected', name: 'Read', payload: { content: 'file body' },
    });
    pushWorkerToolResult(queue, ctx, {
      id: 'handoff', name: 'mcp__cindy_orca__send_to_worker',
      payload: { ok: true, wake_kind: 'resumed' },
    });
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBeUndefined();
    expect(silentStopWarned(ctx)).toBe(false);
  });

  // #9221: serialized role dispatches still owe the combined failure report.
  // Unlike a corrected Read error, an unscheduled role cannot silently vanish.
  // Real translator/done; unit tier. Visible reporting is the normal control.
  it.each([
    ['send-error', 'send_to_worker', { ok: false, errorCode: 'BUSY' }, true, false],
    ['send-no-signal', 'send_to_worker', { ok: true }, false, false],
    ['create-error', 'create_worker', { ok: false, errorCode: 'DENIED' }, true, false],
    ['create-no-signal', 'create_worker', { ok: true, worker_id: 'unstarted' }, false, false],
    ['reported', 'send_to_worker', { ok: false, errorCode: 'BUSY' }, true, true],
  ] as const)('retains serialized dispatch failure reports (%s)', async (_label, tool, payload, isError, reported) => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushWorkerToolResult(queue, ctx, { id: 'failed-role', name: `mcp__cindy_orca__${tool}`, payload, isError });
    pushWorkerToolResult(queue, ctx, { id: 'successful-role', name: 'mcp__cindy_orca__send_to_worker',
      payload: { ok: true, wake_kind: 'resumed' } });
    if (reported) translateSdkMessage({ type: 'assistant', message: { content: [
      { type: 'text', text: 'One role was dispatched; the other failed with BUSY.' },
    ] } }, queue, ctx);
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBe(reported ? undefined : true);
  });

  it('keeps the zero-body exemption when a non-dispatch tool in the batch succeeded', async () => {
    // 对照: 非 Orca 工具成功完成时不改变豁免判定 —— 干净派发批次仍可零正文收口。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolBatch(queue, ctx, [
      { name: 'mcp__cindy_orca__send_to_worker', payload: { ok: true, target_session_id: 's-1', wake_kind: 'queued', queued_message_id: 'm-2' } },
      { name: 'Read', payload: { content: 'file body' } },
    ]);
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events)).toBeUndefined();
  });

  it('keeps the zero-body exemption when every dispatch in the batch landed', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(tracker);

    pushWorkerToolBatch(queue, ctx, [
      { name: 'mcp__cindy_orca__create_worker', payload: { ok: true, worker_id: 'w-1', dispatched: true } },
      { name: 'mcp__cindy_orca__send_to_worker', payload: { ok: true, target_session_id: 's-1', wake_kind: 'queued', queued_message_id: 'm-2' } },
    ]);
    finishWithEmptyThinking(queue, ctx);

    const events = await drain(queue);
    expect(silentStopWarned(ctx)).toBe(false);
    expect(doneSilentStopFlag(events)).toBeUndefined();
  });

  // #9221: only promotion of this pending Worker message completes a steer
  // fallback. Observe production done; unrelated, failed or non-front moves do not.
  it.each(['promoted', 'wrong-message', 'not-front', 'failed', 'own-queue', 'unrelated'] as const)('tracks pending steer promotion (%s)', async (kind) => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    if (kind !== 'unrelated') pushWorkerToolResult(queue, ctx, {
      id: 'fallback', name: 'mcp__cindy_orca__send_to_worker',
      payload: { ok: true, target_session_id: 'session-1', wake_kind: 'queued', queued_message_id: 'message-1', steer_fallback_reason: 'BUSY' },
    });
    pushWorkerToolResult(queue, ctx, {
      id: 'promotion', name: 'mcp__cindy_orca__move_queued_message', isError: kind === 'failed',
      payload: { ok: kind !== 'failed', worker_id: kind === 'own-queue' ? null : 'worker-1',
        queued_message_id: kind === 'wrong-message' ? 'other-message' : 'message-1', position: kind === 'not-front' ? 1 : 0 },
    });
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBe(kind === 'promoted' ? undefined : true);
  });

  // #9221: create_workers user_report is mandatory even if the Lead wrongly
  // serializes another dispatch before reporting; ordinary corrected Read errors
  // still have their separate, existing per-batch recovery coverage.
  it.each([false, true])('retains a batch report across later dispatch (visible report=%s)', async (reported) => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushWorkerToolResult(queue, ctx, { id: 'batch', name: 'mcp__cindy_orca__create_workers',
      payload: { ok: true, request_count: 2, success_count: 1, failure_count: 1, user_report: 'one role failed', results: [] } });
    pushWorkerToolResult(queue, ctx, { id: 'later', name: 'mcp__cindy_orca__send_to_worker',
      payload: { ok: true, wake_kind: 'resumed' } });
    if (reported) translateSdkMessage({ type: 'assistant', message: { content: [
      { type: 'text', text: 'one role failed' },
    ] } }, queue, ctx);
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBe(reported ? undefined : true);
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
    finishWithEmptyThinking(queue, ctx);
    const nextQueue = createAsyncQueue<AgentEvent>();
    pushToolUseMessage(nextQueue, ctx);
    finishWithEmptyThinking(nextQueue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBeUndefined();
    expect(doneSilentStopFlag(await drain(nextQueue))).toBe(true);
  });

  // #9221: exercise the production translator's done signal, which controls the
  // host's hidden Continue and interruption separator. Existing cases did not
  // cover dispatch receipts. Unit tier; no worker, model, DB or network is used.
  it.each(['resumed', 'already-active', 'queued'])('accepts send_to_worker wake_kind=%s without a queue id', async (wakeKind) => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushWorkerToolResult(queue, ctx, {
      name: 'mcp__cindy_orca__send_to_worker',
      payload: { ok: true, wake_kind: wakeKind },
    });
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBeUndefined();
  });

  it.each([
    ['send_to_worker', { ok: true, wake_kind: 'idle' }],
    ['send_to_worker', { ok: false, wake_kind: 'resumed' }],
    ['interrupt_worker', { ok: true, dispatched: true }],
    ['interrupt_worker', { ok: true, queued_message_id: ' ' }],
    ['interrupt_worker', { ok: true, queued_message_id: 7 }],
    ['create_worker', { ok: true, dispatch_outcome: { kind: 'session-dispatch', dispatched: false, wakeKind: 'queued' } }],
  ])('keeps recovery for an unconfirmed %s receipt (%j)', async (name, payload) => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushWorkerToolResult(queue, ctx, { name: `mcp__cindy_orca__${name}`, payload });
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBe(true);
  });

  it.each(['mcp__other__create_worker', 'create_worker'])('does not exempt an unrelated tool named %s', async (name) => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushWorkerToolResult(queue, ctx, { name });
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBe(true);
  });

  it('does not grant the parent a zero-body exemption from a child dispatch', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushToolUseMessage(queue, ctx);
    translateSdkMessage({ type: 'assistant', parent_tool_use_id: 'child', message: {
      content: [{ type: 'tool_use', id: 'child-dispatch', name: 'mcp__cindy_orca__send_to_worker', input: {} }],
    } }, queue, ctx);
    translateSdkMessage({ type: 'user', parent_tool_use_id: 'child', message: {
      content: [{ type: 'tool_result', tool_use_id: 'child-dispatch', content: '{"ok":true,"wake_kind":"resumed"}' }],
    } }, queue, ctx);
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBe(true);
  });

  it('keeps recovery when the Lead starts another tool batch after dispatch', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushWorkerToolResult(queue, ctx);
    pushToolUseMessage(queue, ctx);
    translateSdkMessage({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'read completed' },
    ] } }, queue, ctx);
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBe(true);
  });

  it('does not let child errors revoke a confirmed parent dispatch', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx(new UsageTracker());
    pushWorkerToolResult(queue, ctx);
    translateSdkMessage({ type: 'user', parent_tool_use_id: 'child', message: { content: [
      { type: 'tool_result', tool_use_id: 'child-read', content: 'failed', is_error: true },
    ] } }, queue, ctx);
    finishWithEmptyThinking(queue, ctx);
    expect(doneSilentStopFlag(await drain(queue))).toBeUndefined();
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
