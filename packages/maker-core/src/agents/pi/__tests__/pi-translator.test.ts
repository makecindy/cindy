/**
 * pi translator 单测 —— 纯函数,验证事件映射正确性(不 spawn pi / 不连网关)。
 * 重点:compaction 边界事件、turn 级 usage 累计与 done 上报、reset 时机。
 */

import { describe, expect, it, vi } from 'vitest';

import { createPiTranslateContext, translatePiEvent, usageSnapshotOf } from '../translator.js';
import type { AgentEvent } from '../../../types/events.js';
import type { AsyncQueue } from '../../shared/async-queue.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { PiRpcEvent } from '../rpc-client.js';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function makeQueue(): { queue: AsyncQueue<AgentEvent>; events: AgentEvent[] } {
  const events: AgentEvent[] = [];
  // translatePiEvent 只调 queue.push;其余 AsyncQueue 接口在此不需要。
  const queue = { push: (e: AgentEvent) => { events.push(e); }, end: () => {} } as unknown as AsyncQueue<AgentEvent>;
  return { queue, events };
}

const ev = (e: Record<string, unknown>): PiRpcEvent => e as unknown as PiRpcEvent;

describe('pi translator', () => {
  it('maps compaction_end (threshold) → compact_boundary with token deltas + updates contextTokens', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'threshold', result: { tokensBefore: 150000, estimatedTokensAfter: 32000 } }),
      queue,
      ctx,
    );
    const cb = events.find((e) => e.type === 'compact_boundary');
    expect(cb).toBeDefined();
    const data = cb!.data as { trigger: string; preTokens?: number; postTokens?: number };
    expect(data.trigger).toBe('auto');
    expect(data.preTokens).toBe(150000);
    expect(data.postTokens).toBe(32000);
    expect(ctx.contextTokens).toBe(32000);
  });

  it('maps manual compaction trigger through to compact_boundary', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(
      ev({ type: 'compaction_end', reason: 'manual', result: { tokensBefore: 100, estimatedTokensAfter: 20 } }),
      queue,
      ctx,
    );
    const cb = events.find((e) => e.type === 'compact_boundary');
    expect((cb!.data as { trigger: string }).trigger).toBe('manual');
  });

  it('accumulates turn usage and attaches it to the done event on agent_settled', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3 } },
      }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);

    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    const usage = (done!.data as { usage: Record<string, number> }).usage;
    expect(usage.inputTokens).toBe(100);
    expect(usage.outputTokens).toBe(20);
    expect(usage.cacheReadTokens).toBe(5);
    expect(usage.cacheCreationTokens).toBe(3);
    // 快照累计 input+output。
    expect(usageSnapshotOf(ctx).tokenUsage).toBe(120);
    // done.data.result 带上最终回复文本 —— register.ts 的 will-assistant-message 出口钩子
    // 与 Orca worker 终态 finalText 都读它,不带上就对 Pi 静默跳过(codex review P1)。
    expect((done!.data as { result?: unknown }).result).toBe('hi');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'status',
      data: expect.objectContaining({ status: 'Done', isRunning: false }),
    }));
  });

  it('done.result carries the last assistant message text (multi-message turn) and resets per turn', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    // 文本 → 纯 tool_call(无文本)→ 最终文本:result 应取最后一条有文本的回复。
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking…' }], usage: { input: 10, output: 2 } } }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }], usage: { input: 5, output: 1 } } }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'final answer' }], usage: { input: 5, output: 3 } } }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
    const done = events.find((e) => e.type === 'done');
    expect((done!.data as { result?: unknown }).result).toBe('final answer');

    // 新 turn:result 归零,不带上一 turn 的回复。
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    expect(ctx.finalAssistantText).toBe('');
    const events2 = makeQueue();
    translatePiEvent(ev({ type: 'agent_settled' }), events2.queue, ctx);
    const done2 = events2.events.find((e) => e.type === 'done');
    expect((done2!.data as { result?: unknown }).result).toBe('');
  });

  it('resets turn usage counters on the next agent_start', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue } = makeQueue();
    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx);
    translatePiEvent(
      ev({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 50, output: 10 } } }),
      queue,
      ctx,
    );
    translatePiEvent(ev({ type: 'agent_settled' }), queue, ctx);
    expect(ctx.turnInput).toBe(50);

    translatePiEvent(ev({ type: 'agent_start' }), queue, ctx); // 新 turn 重置
    expect(ctx.turnInput).toBe(0);
    expect(ctx.turnOutput).toBe(0);
    expect(ctx.turnCacheRead).toBe(0);
    expect(ctx.turnCacheWrite).toBe(0);
  });

  it('preserves pi redacted thinking as a structured redacted event', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_start',
          contentIndex: 0,
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '', redacted: true }],
          },
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: '[Reasoning redacted]',
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '[Reasoning redacted]', redacted: true }],
          },
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: '[Reasoning redacted]',
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '[Reasoning redacted]', redacted: true }],
          },
        },
      }),
      queue,
      ctx,
    );

    expect(events).toEqual([{
      type: 'thinking',
      data: { stage: 'redacted', blockId: 'pi-think-1' },
      source: 'pi',
    }]);
  });

  it('cleans up a visible placeholder when redaction is only known at thinking_end', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_start',
          contentIndex: 0,
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '' }],
          },
        },
      }),
      queue,
      ctx,
    );
    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: '[Reasoning redacted]',
        },
      }),
      queue,
      ctx,
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: 'thinking',
        data: expect.objectContaining({ stage: 'start', blockId: 'pi-think-1' }),
      }),
      {
        type: 'thinking',
        data: { stage: 'redacted', blockId: 'pi-think-1' },
        source: 'pi',
      },
    ]);
  });

  it('keeps interleaved text and multiple redacted blocks in one assistant message hidden', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();
    const firstPartialContent = [
      { type: 'text', text: 'first section' },
      { type: 'thinking', thinking: '[Reasoning redacted]', redacted: true },
    ];
    const secondPartialContent = [
      ...firstPartialContent,
      { type: 'text', text: 'second section' },
      { type: 'thinking', thinking: '[Reasoning redacted]', redacted: true },
    ];

    translatePiEvent(ev({ type: 'message_start' }), queue, ctx);
    translatePiEvent(ev({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'first section' },
    }), queue, ctx);
    for (const [contentIndex, content] of [
      [1, firstPartialContent],
      [3, secondPartialContent],
    ] as const) {
      translatePiEvent(ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_start',
          contentIndex,
          partial: { role: 'assistant', content },
        },
      }), queue, ctx);
      translatePiEvent(ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex,
          content: '[Reasoning redacted]',
          partial: { role: 'assistant', content },
        },
      }), queue, ctx);
      if (contentIndex === 1) {
        translatePiEvent(ev({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: 'second section' },
        }), queue, ctx);
      }
    }
    translatePiEvent(ev({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: secondPartialContent,
        model: 'xai/grok-4.5',
        stopReason: 'stop',
      },
    }), queue, ctx);

    expect(events.filter((event) => event.type === 'thinking')).toEqual([
      {
        type: 'thinking',
        data: { stage: 'redacted', blockId: 'pi-think-1' },
        source: 'pi',
      },
      {
        type: 'thinking',
        data: { stage: 'redacted', blockId: 'pi-think-2' },
        source: 'pi',
      },
    ]);
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', data: { text: 'first section', isFinal: false }, source: 'pi' },
      { type: 'text', data: { text: 'second section', isFinal: false }, source: 'pi' },
      expect.objectContaining({
        type: 'text',
        data: { text: 'first section\n\nsecond section', isFinal: true },
      }),
    ]);
  });

  it('keeps ordinary pi thinking_end as visible final thinking', () => {
    const ctx = createPiTranslateContext(noopLogger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'thinking_end',
          contentIndex: 0,
          content: 'visible reasoning',
          partial: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'visible reasoning' }],
          },
        },
      }),
      queue,
      ctx,
    );

    expect(events.at(-1)).toEqual({
      type: 'thinking',
      data: expect.objectContaining({
        stage: 'final',
        blockId: 'pi-think-1',
        text: 'visible reasoning',
      }),
      source: 'pi',
    });
  });

  it('accepts the thinking-level status notification without warning', () => {
    const warn = vi.fn();
    const logger: Logger = { ...noopLogger, warn };
    const ctx = createPiTranslateContext(logger);
    const { queue, events } = makeQueue();

    translatePiEvent(
      ev({ type: 'thinking_level_changed', thinkingLevel: 'high' }),
      queue,
      ctx,
    );

    expect(events).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});
