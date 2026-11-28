/**
 * Prime Agent translator 单元测试。
 *
 * 核心覆盖: **`agent_end` → `agent_settled` 合成**(turn 收口)。
 * Cindy 的 turn 状态机只认 `agent_settled`(见 packages/maker-core/src/agents/pi/
 * translator.ts:990-992 的对照), 而 Prime Agent 全仓只有 `agent_end` —— 每个
 * `agent_end` 必须让 turn 收口, 否则 Host 会永久停在 running。
 *
 * 所有断言里的帧形状都对着 Prime Agent 源码:
 *   - 事件信封        crates/pa-core/src/session_engine/session_events.rs:119-205
 *   - 流式 delta      crates/pa-core/src/session_engine/session_events.rs:14-100
 *   - stopReason 线名 crates/pa-agent/src/types.rs:60-71 (stop/length/toolUse/error/aborted)
 *   - run 终态        crates/pa-agent/src/agent_loop/run.rs:84/119/147/156/181/201/230/246
 */

import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../../types/events.js';
import type { AsyncQueue } from '../../shared/async-queue.js';
import {
  PRIME_AGENT_SOURCE,
  createPrimeAgentTranslateContext,
  markPrimeAgentHostAbortRequested,
  translatePrimeAgentEvent,
} from '../translator.js';
import type { PrimeAgentRpcEvent } from '../rpc-client.js';

function makeLogger() {
  const warns: unknown[] = [];
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn((...args: unknown[]) => { warns.push(args); }),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => logger,
  };
  return { logger, warns };
}

function makeQueue() {
  const items: AgentEvent[] = [];
  const queue: AsyncQueue<AgentEvent> = {
    push(item: AgentEvent): boolean {
      items.push(item);
      return true;
    },
    end(): void { /* no-op for tests */ },
    clear(): void { items.length = 0; },
    get pending(): number { return items.length; },
    [Symbol.asyncIterator]: () => {
      let index = 0;
      return {
        next: async (): Promise<IteratorResult<AgentEvent>> =>
          index < items.length
            ? { value: items[index++] as AgentEvent, done: false }
            : { value: undefined as never, done: true },
      };
    },
  };
  return { queue, items };
}

interface Harness {
  queue: AsyncQueue<AgentEvent>;
  items: AgentEvent[];
  feed: (event: Record<string, unknown>) => void;
  types: () => string[];
  last: (type: string) => AgentEvent | undefined;
}

function makeHarness(): Harness {
  const { logger } = makeLogger();
  const { queue, items } = makeQueue();
  const ctx = createPrimeAgentTranslateContext(logger);
  return {
    queue,
    items,
    feed: (event) => translatePrimeAgentEvent(event as PrimeAgentRpcEvent, queue, ctx),
    types: () => items.map((item) => item.type),
    last: (type) => [...items].reverse().find((item) => item.type === type),
  };
}

/** 一条带 usage 的 assistant `message_end` 帧(形状对 session_events.rs:155-158)。 */
function assistantMessageEnd(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      content: text.length > 0 ? [{ type: 'text', text }] : [],
      model: 'faux-1',
      stopReason: 'stop',
      usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cost: { total: 0.5 } },
      ...overrides,
    },
  };
}

describe('Prime Agent translator — agent_end → agent_settled 合成', () => {
  it('agent_end alone closes the turn with a done event typed prime-agent/agent_settled', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('hello'));
    h.feed({ type: 'agent_end', messages: [] });

    const done = h.last('done');
    expect(done, 'agent_end must synthesize the turn terminal').toBeDefined();
    expect(done?.data).toMatchObject({
      type: 'prime-agent/agent_settled',
      status: 'completed',
      result: 'hello',
    });
    // turn 收口的另一半: status 必须落到 isRunning=false。
    const status = h.last('status');
    expect(status?.data).toMatchObject({ isRunning: false });
  });

  it('agent_end settles exactly once (a second frame cannot re-close the turn)', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('one'));
    h.feed({ type: 'agent_end', messages: [] });
    const doneCountAfterFirst = h.types().filter((type) => type === 'done').length;
    h.feed({ type: 'agent_end', messages: [] });
    const doneCountAfterSecond = h.types().filter((type) => type === 'done').length;

    expect(doneCountAfterFirst).toBe(1);
    expect(doneCountAfterSecond).toBe(1);
  });

  it('a native agent_settled frame (future Prime Agent) takes the same settlement path', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('via settled'));
    h.feed({ type: 'agent_settled' });

    expect(h.last('done')?.data).toMatchObject({
      type: 'prime-agent/agent_settled',
      status: 'completed',
      result: 'via settled',
    });
  });

  it('agent_end with no preceding agent_start still settles (run-start failure tail)', () => {
    // crates/pa-agent/src/agent.rs:500-516: run 启动失败时只发合成 AgentEnd,
    // 没有配对的 AgentStart。Host 侧任何挂起的 turn 状态机仍必须能出去。
    const { logger, warns } = makeLogger();
    const { queue, items } = makeQueue();
    const ctx = createPrimeAgentTranslateContext(logger);
    translatePrimeAgentEvent(
      { type: 'agent_end', messages: [] } as PrimeAgentRpcEvent,
      queue,
      ctx,
    );

    expect(items.some((item) => item.type === 'done')).toBe(true);
    expect(warns.length, 'the missing agent_start is recorded for diagnosis').toBeGreaterThan(0);
  });

  it('recovers done.data.result from agent_end.messages when message_end never arrived', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    // 故意不发 assistant message_end —— 模拟该帧丢失。
    h.feed({
      type: 'agent_end',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'recovered reply' }] },
      ],
    });

    expect(h.last('done')?.data).toMatchObject({ result: 'recovered reply' });
  });

  it('a host abort classifies the settled turn as cancelled, not failed', () => {
    const { logger } = makeLogger();
    const { queue, items } = makeQueue();
    const ctx = createPrimeAgentTranslateContext(logger);
    translatePrimeAgentEvent({ type: 'agent_start' } as PrimeAgentRpcEvent, queue, ctx);
    markPrimeAgentHostAbortRequested(ctx);
    translatePrimeAgentEvent(
      assistantMessageEnd('', { stopReason: 'aborted' }) as PrimeAgentRpcEvent,
      queue,
      ctx,
    );
    translatePrimeAgentEvent({ type: 'agent_end', messages: [] } as PrimeAgentRpcEvent, queue, ctx);

    const done = [...items].reverse().find((item) => item.type === 'done');
    expect(done?.data).toMatchObject({ status: 'cancelled' });
    expect(items.some((item) => item.type === 'error')).toBe(false);
  });

  it('stopReason=length surfaces a terminal error and a failed outcome', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('partial', { stopReason: 'length' }));
    h.feed({ type: 'agent_end', messages: [] });

    const error = h.last('error');
    expect(error?.data).toMatchObject({ isTerminal: true, reason: 'output-limit' });
    expect(h.last('done')?.data).toMatchObject({ status: 'failed' });
  });

  it('a provider error at message_end(stopReason=error) settles as failed', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('', { stopReason: 'error', errorMessage: 'upstream 503' }));
    h.feed({ type: 'agent_end', messages: [] });

    expect(h.last('error')?.data).toMatchObject({ isTerminal: true });
    expect(h.last('done')?.data).toMatchObject({ status: 'failed' });
  });

  it('a normal assistant message clears an earlier transient provider error', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('', { stopReason: 'error', errorMessage: 'upstream 503' }));
    h.feed(assistantMessageEnd('recovered'));
    h.feed({ type: 'agent_end', messages: [] });

    expect(h.items.some((item) => item.type === 'error')).toBe(false);
    expect(h.last('done')?.data).toMatchObject({ status: 'completed', result: 'recovered' });
  });
});

describe('Prime Agent translator — streaming shape', () => {
  it('maps the full happy-path frame sequence to AgentEvents', () => {
    const h = makeHarness();
    // 对着真二进制实测的时序(见 smoke 测试与探针输出)。
    h.feed({ type: 'agent_start' });
    h.feed({ type: 'turn_start' });
    h.feed({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    h.feed({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    h.feed({ type: 'message_start', message: { role: 'assistant', content: [] } });
    h.feed({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'text_start', contentIndex: 0 },
    });
    h.feed({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'he' }] },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'he' },
    });
    h.feed({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'llo' },
    });
    h.feed(assistantMessageEnd('hello'));
    h.feed({ type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } });
    h.feed({ type: 'agent_end', messages: [] });

    // 流式 delta 追加, message_end 全文校准。
    const textEvents = h.items.filter((item) => item.type === 'text');
    expect(textEvents.map((item) => item.data)).toEqual([
      { text: 'he', isFinal: false },
      { text: 'llo', isFinal: false },
      { text: 'hello', isFinal: true, isFullText: true },
    ]);
    // 每条事件都带 Prime Agent 来源标识。
    expect(h.items.every((item) => item.source === PRIME_AGENT_SOURCE)).toBe(true);
    expect(h.types().at(-1)).toBe('status');
  });

  it('ignores user / custom message_start+message_end pairs', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed({ type: 'message_start', message: { role: 'custom', content: [] } });
    h.feed({ type: 'message_end', message: { role: 'custom', content: [] } });
    h.feed({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
    h.feed({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });

    expect(h.types()).not.toContain('text');
    expect(h.types()).not.toContain('tool_use');
  });

  it('maps tool_execution_start/end to tool_use + tool_result_full + tool_result', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
    });
    h.feed({
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      isError: false,
      result: { content: [{ type: 'text', text: 'hi\n' }] },
    });

    expect(h.items.find((item) => item.type === 'tool_use')?.data).toMatchObject({
      toolUseId: 'call-1',
    });
    expect(h.items.find((item) => item.type === 'tool_result_full')?.data).toMatchObject({
      toolUseId: 'call-1',
      fullText: 'hi\n',
      isError: false,
    });
    expect(h.items.find((item) => item.type === 'tool_result')?.data).toMatchObject({
      summary: 'done',
      toolUseIds: ['call-1'],
    });
  });

  it('maps a failed tool result with isError=true', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed({
      type: 'tool_execution_end',
      toolCallId: 'call-2',
      toolName: 'bash',
      isError: true,
      result: { content: [{ type: 'text', text: 'boom' }] },
    });

    expect(h.items.find((item) => item.type === 'tool_result_full')?.data).toMatchObject({
      isError: true,
      fullText: 'boom',
    });
    expect(h.items.find((item) => item.type === 'tool_result')?.data).toMatchObject({
      summary: 'failed',
    });
  });

  it('maps thinking deltas into start/delta/final stages with a stable blockId', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 },
    });
    h.feed({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'reason' },
    });
    h.feed({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: 'reason' },
    });

    const stages = h.items.filter((item) => item.type === 'thinking').map((item) => item.data);
    expect(stages).toHaveLength(3);
    expect(stages[0]).toMatchObject({ stage: 'start' });
    expect(stages[1]).toMatchObject({ stage: 'delta', text: 'reason' });
    expect(stages[2]).toMatchObject({ stage: 'final', text: 'reason' });
    // 同一 contentIndex 的三次事件必须共用同一个 blockId。
    expect(new Set(stages.map((stage) => (stage as { blockId: string }).blockId)).size).toBe(1);
  });

  it('ignores toolcall_* deltas (tool_execution_* owns the tool lifecycle)', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 },
    });
    h.feed({
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"a"' },
    });

    expect(h.types()).not.toContain('tool_use');
    expect(h.types()).not.toContain('text');
  });

  it('accumulates turn usage across assistant messages and reports it on done', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('first'));
    h.feed(assistantMessageEnd('second'));
    h.feed({ type: 'agent_end', messages: [] });

    expect(h.last('done')?.data).toMatchObject({
      usage: {
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
      },
    });
  });

  it('resets turn usage counters at the next agent_start', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('first'));
    h.feed({ type: 'agent_end', messages: [] });
    h.feed({ type: 'agent_start' });
    h.feed(assistantMessageEnd('second'));
    h.feed({ type: 'agent_end', messages: [] });

    const dones = h.items.filter((item) => item.type === 'done');
    expect(dones).toHaveLength(2);
    expect(dones[1]?.data).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 20 },
      result: 'second',
    });
  });
});

describe('Prime Agent translator — compaction and non-turn events', () => {
  it('maps a successful compaction to compact_boundary', () => {
    const h = makeHarness();
    h.feed({ type: 'compaction_start', reason: 'requested' });
    h.feed({
      type: 'compaction_end',
      reason: 'requested',
      result: { tokensBefore: 9000, estimatedTokensAfter: 1200 },
    });

    expect(h.items.find((item) => item.type === 'compact_boundary')?.data).toMatchObject({
      trigger: 'manual',
      preTokens: 9000,
      postTokens: 1200,
    });
  });

  it('treats a skipped compaction (result null) as no boundary', () => {
    const h = makeHarness();
    h.feed({ type: 'compaction_start', reason: 'requested' });
    h.feed({ type: 'compaction_end', reason: 'requested', result: null });

    expect(h.types()).not.toContain('compact_boundary');
  });

  it('maps reason!=requested to an auto compaction trigger', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed({
      type: 'compaction_end',
      reason: 'threshold',
      result: { tokensBefore: 9000, estimatedTokensAfter: 1200 },
    });

    expect(h.items.find((item) => item.type === 'compact_boundary')?.data).toMatchObject({
      trigger: 'auto',
    });
  });

  it('drops non-turn events (goal_update / thinking_level_changed / session_info_changed)', () => {
    const h = makeHarness();
    h.feed({ type: 'goal_update', goal: { active: false } });
    h.feed({ type: 'thinking_level_changed', level: 'high' });
    h.feed({ type: 'session_info_changed', name: 'my session' });

    expect(h.items).toHaveLength(0);
  });

  it('drops turn_start / turn_end / tool_execution_progress / tool_execution_update', () => {
    const h = makeHarness();
    h.feed({ type: 'agent_start' });
    h.feed({ type: 'turn_start' });
    h.feed({ type: 'turn_end', message: { role: 'assistant', content: [] } });
    h.feed({ type: 'tool_execution_progress', toolCallId: 'c', toolName: 'bash', elapsedMs: 10 });
    h.feed({ type: 'tool_execution_update', toolCallId: 'c', toolName: 'bash', args: {}, partialResult: null });

    expect(h.types()).toEqual(['status']);
  });

  it('warns and drops an unknown event type', () => {
    const { logger, warns } = makeLogger();
    const { queue, items } = makeQueue();
    const ctx = createPrimeAgentTranslateContext(logger);
    translatePrimeAgentEvent({ type: 'some_future_event' } as PrimeAgentRpcEvent, queue, ctx);

    expect(items).toHaveLength(0);
    expect(warns.length).toBeGreaterThan(0);
  });
});
