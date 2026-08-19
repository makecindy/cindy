import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent, AgentTaskUpdateEventData } from '../../../types/events.js';
import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';

type AgentTaskUpdateEvent = AgentEvent & {
  type: 'agent_task_update';
  data: AgentTaskUpdateEventData;
};

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

function createCtx(overrides: {
  onSubagentTaskLaunched?: (task: {
    taskId: string;
    parentToolUseId: string;
    prompt: string;
    model?: string;
  }) => void;
  getSubagentTaskUsage?: (taskId: string) => { totalTokens?: number } | undefined;
} = {}) {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'claude-opus-4-6',
    getEffort: () => 'medium',
    getPermissionMode: () => 'auto',
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker: new UsageTracker(),
    ...overrides,
  };
}

async function collect(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

describe('Claude Code assistant text streaming contract', () => {
  it('emits live deltas before the final assistant text block', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    for (const [uuid, text] of [
      ['stream-1', 'Hello '],
      ['stream-2', 'world'],
    ] as const) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid,
          session_id: 'sdk-session',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        },
        queue,
        ctx,
      );
    }
    translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'assistant-final',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toEqual([
      expect.objectContaining({
        type: 'text',
        data: { text: 'Hello ', isFinal: false },
        source: 'claude-code',
      }),
      expect.objectContaining({
        type: 'text',
        data: { text: 'world', isFinal: false },
        source: 'claude-code',
      }),
      expect.objectContaining({
        type: 'text',
        data: { text: 'Hello world', isFinal: true },
        source: 'claude-code',
      }),
    ]);
    expect(textEvents[2]?.data).not.toHaveProperty('isFullText');
  });

  it('keeps multiple final text blocks marked as local blocks rather than full-message replacements', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'assistant-multi-block',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        message: {
          model: 'claude-opus-4-6',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents.map((event) => event.data)).toEqual([
      { text: 'first', isFinal: true },
      { text: 'second', isFinal: true },
    ]);
  });

  it('does not emit a leaked Grok stop token as assistant text', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'assistant-eos',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        message: {
          model: 'grok-4.6',
          content: [{ type: 'text', text: '<|eos|>' }],
        },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toEqual([]);
    expect(ctx.turn.hasEmittedText).toBe(false);
    expect(ctx.turn.uiEmittedText).toBe('');
    expect(ctx.turn.lastAssistantMsgHadSubstance).toBe(true);
  });

  it('does not emit a stop token split across streaming deltas', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    for (const [uuid, text] of [
      ['stream-eos-1', '<|eo'],
      ['stream-eos-2', 's|>'],
    ] as const) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid,
          session_id: 'sdk-session',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        },
        queue,
        ctx,
      );
    }

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toEqual([]);
    expect(ctx.turn.hasEmittedText).toBe(false);
    expect(ctx.turn.uiEmittedText).toBe('');
  });

  it('does not emit a stop token split as a single-character prefix', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    for (const [uuid, text] of [
      ['stream-lt-1', '<'],
      ['stream-lt-2', '|eos|>'],
    ] as const) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid,
          session_id: 'sdk-session',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        },
        queue,
        ctx,
      );
    }

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toEqual([]);
    expect(ctx.turn.hasEmittedText).toBe(false);
    expect(ctx.turn.uiEmittedText).toBe('');
  });

  it('does not emit leading whitespace from a split standalone stop token', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    for (const [uuid, text] of [
      ['stream-ws-1', '  <|eo'],
      ['stream-ws-2', 's|>'],
    ] as const) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid,
          session_id: 'sdk-session',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        },
        queue,
        ctx,
      );
    }

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toEqual([]);
    expect(ctx.turn.hasEmittedText).toBe(false);
    expect(ctx.turn.uiEmittedText).toBe('');
  });

  it('keeps an embedded stop token in streamed assistant prose', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    for (const [uuid, text] of [
      ['stream-embed-1', 'The token is '],
      ['stream-embed-2', '<|eos|>'],
    ] as const) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid,
          session_id: 'sdk-session',
          parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        },
        queue,
        ctx,
      );
    }

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents.map((event) => event.data)).toEqual([
      { text: 'The token is ', isFinal: false },
      { text: '<|eos|>', isFinal: false },
    ]);
    expect(ctx.turn.uiEmittedText).toBe('The token is <|eos|>');
  });

  it('keeps later tool-loop prose after a final assistant envelope', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'assistant-first',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        message: {
          model: 'claude-opus-4-6',
          content: [{ type: 'text', text: '先看一眼。' }],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'stream-second',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '再改一处。' } },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents.map((event) => event.data)).toEqual([
      { text: '先看一眼。', isFinal: true },
      { text: '再改一处。', isFinal: false },
    ]);
    expect(ctx.turn.uiEmittedText).toBe('先看一眼。再改一处。');
  });

  it('does not mix concurrent stream prefixes when sanitizing stop tokens', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'stream-a',
        session_id: 'sdk-session',
        parent_tool_use_id: 'toolu-a',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '<|eo' } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'stream-b',
        session_id: 'sdk-session',
        parent_tool_use_id: 'toolu-b',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toEqual([
      expect.objectContaining({
        data: { text: 'answer', isFinal: false },
        agentMeta: expect.objectContaining({ parentUuid: 'toolu-b' }),
      }),
    ]);
    expect(ctx.turn.uiEmittedText).toBe('answer');
    expect(ctx.rt.streamStopTokenByKey.get('toolu-a:0')).toEqual({
      pending: '<|eo',
      emitted: false,
    });
  });

  it('still drops a split stop token after another stream has emitted prose', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'stream-a-1',
        session_id: 'sdk-session',
        parent_tool_use_id: 'toolu-a',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '<|eo' } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'stream-b',
        session_id: 'sdk-session',
        parent_tool_use_id: 'toolu-b',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'stream-a-2',
        session_id: 'sdk-session',
        parent_tool_use_id: 'toolu-a',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 's|>' } },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toEqual([
      expect.objectContaining({
        data: { text: 'answer', isFinal: false },
        agentMeta: expect.objectContaining({ parentUuid: 'toolu-b' }),
      }),
    ]);
    expect(ctx.turn.uiEmittedText).toBe('answer');
    expect(ctx.rt.streamStopTokenByKey.get('toolu-a:0')).toEqual({
      pending: '<|eos|>',
      emitted: false,
    });
  });

  it('still drops a later standalone stop token after earlier same-stream prose', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'assistant-first',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        message: {
          model: 'grok-4.6',
          content: [{ type: 'text', text: '先看一眼。' }],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'stream-eos',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '<|eos|>' } },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents.map((event) => event.data)).toEqual([
      { text: '先看一眼。', isFinal: true },
    ]);
    expect(ctx.turn.uiEmittedText).toBe('先看一眼。');
    expect(ctx.rt.streamStopTokenByKey.get('__main__:0')).toEqual({
      pending: '<|eos|>',
      emitted: false,
    });
  });

  it('drops a later text-block leftover after earlier prose in the same envelope', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'block-0',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先看一眼。' } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'block-1-start',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'block-1',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '<|eos|>' } },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents.map((event) => event.data)).toEqual([
      { text: '先看一眼。', isFinal: false },
    ]);
    expect(ctx.rt.streamStopTokenByKey.get('__main__:1')).toEqual({
      pending: '<|eos|>',
      emitted: false,
    });
  });

  it('keeps a result fallback tail unmarked so it cannot replace accumulated streaming text', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'stream_event',
        uuid: 'stream-prefix',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello ' } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        result: 'Hello world',
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      queue,
      ctx,
    );

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents.map((event) => event.data)).toEqual([
      { text: 'Hello ', isFinal: false },
      { text: 'world', isFinal: false },
    ]);
  });
});

describe('Claude Code translator subagent model attribution', () => {
  it('keeps an early full child model without publishing a temporary task id', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    // 即使 partial message_start 已先写入 stream map，完整 assistant 仍必须把模型
    // 提升成 task update；stream map 本身不是「已经对 UI 发布」的证据。
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_agent_a',
        event: {
          type: 'message_start',
          message: { model: 'codex/gpt-5.6-sol', usage: { input_tokens: 0 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'child-assistant',
        session_id: 'sdk-session',
        parent_tool_use_id: 'toolu_agent_a',
        message: {
          model: 'codex/gpt-5.6-sol',
          content: [{ type: 'text', text: 'child answer' }],
        },
      },
      queue,
      ctx,
    );

    const events = await collect(queue);
    expect(events.find((event) => event.type === 'agent_task_update')).toBeUndefined();
    expect(events.find((event) => event.type === 'text')?.agentMeta).toEqual(
      expect.objectContaining({
        parentUuid: 'toolu_agent_a',
        model: 'codex/gpt-5.6-sol',
      }),
    );
  });

  it('publishes the saved child model when the stable task id arrives', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent_a',
        message: { model: 'codex/gpt-5.6-sol', content: [] },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-a',
        tool_use_id: 'toolu_agent_a',
        task_type: 'local_agent',
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0]?.data).toMatchObject({
      taskId: 'agent-a',
      parentToolUseId: 'toolu_agent_a',
      status: 'running',
      model: 'codex/gpt-5.6-sol',
    });
  });

  it('keeps the child actual model on the later terminal task update', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent_a',
        message: { model: 'codex/gpt-5.6-sol', content: [] },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-a',
        tool_use_id: 'toolu_agent_a',
        status: 'completed',
        usage: { total_tokens: 42 },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent =>
        event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      taskId: 'agent-a',
      parentToolUseId: 'toolu_agent_a',
      status: 'completed',
      model: 'codex/gpt-5.6-sol',
    });
  });

  it('does not reopen a terminal task when the full child assistant arrives late', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-a',
        tool_use_id: 'toolu_agent_a',
        status: 'completed',
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent_a',
        message: { model: 'codex/gpt-5.6-sol', content: [] },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      taskId: 'agent-a',
      parentToolUseId: 'toolu_agent_a',
      status: 'completed',
      model: 'codex/gpt-5.6-sol',
      subagentObservation: {
        kind: 'terminal',
        logicalSubagentId: 'agent-a',
        parentToolUseId: 'toolu_agent_a',
      },
    });
  });

  it('preserves a terminal task_updated status when the full child assistant arrives late', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_a', content: 'launched' }],
        },
        toolUseResult: {
          isAsync: true,
          agentId: 'agent-a',
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'agent-a',
        patch: { status: 'completed' },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent_a',
        message: { model: 'codex/gpt-5.6-sol', content: [] },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      taskId: 'agent-a',
      parentToolUseId: 'toolu_agent_a',
      status: 'completed',
      model: 'codex/gpt-5.6-sol',
      subagentObservation: {
        kind: 'terminal',
        logicalSubagentId: 'agent-a',
        parentToolUseId: 'toolu_agent_a',
      },
    });
  });

  it('keeps two concurrent subagent stream models isolated from the parent agent', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    for (const parentToolUseId of ['toolu_agent_a', 'toolu_agent_b']) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid: `stream-${parentToolUseId}`,
          session_id: 'sdk-session',
          parent_tool_use_id: parentToolUseId,
          event: {
            type: 'message_start',
            message: { model: 'gpt-5.6-sol', usage: { input_tokens: 0 } },
          },
        },
        queue,
        ctx,
      );
    }

    // 父 agent 的 assistant 事件插进两个 child stream 之间，模拟真实并发交错。
    translateSdkMessage(
      {
        type: 'assistant',
        uuid: 'parent-assistant',
        session_id: 'sdk-session',
        parent_tool_use_id: null,
        message: { model: 'claude-opus-4-6', content: [] },
      },
      queue,
      ctx,
    );

    for (const [parentToolUseId, text] of [
      ['toolu_agent_a', 'answer A'],
      ['toolu_agent_b', 'answer B'],
    ] as const) {
      translateSdkMessage(
        {
          type: 'stream_event',
          uuid: `stream-${parentToolUseId}`,
          session_id: 'sdk-session',
          parent_tool_use_id: parentToolUseId,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
        },
        queue,
        ctx,
      );
    }

    const textEvents = (await collect(queue)).filter((event) => event.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents.map((event) => event.agentMeta)).toEqual([
      expect.objectContaining({ parentUuid: 'toolu_agent_a', model: 'gpt-5.6-sol' }),
      expect.objectContaining({ parentUuid: 'toolu_agent_b', model: 'gpt-5.6-sol' }),
    ]);
  });

  it('projects async Agent resolvedModel into the task update as the authoritative label', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_agent_a',
              content: [{ type: 'text', text: 'Async agent launched successfully.' }],
            },
          ],
        },
        tool_use_result: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'agent-a',
          resolvedModel: 'codex/gpt-5.6-sol',
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].data).toEqual({
      provider: 'claude-code',
      taskId: 'agent-a',
      parentToolUseId: 'toolu_agent_a',
      status: 'running',
      model: 'codex/gpt-5.6-sol',
      subagentObservation: {
        kind: 'spawn',
        logicalSubagentId: 'agent-a',
        parentToolUseId: 'toolu_agent_a',
      },
    });
  });

  it('does not downgrade a terminal task when the async launch receipt arrives late', async () => {
    // 事件乱序（P1-3）：task_notification: completed 先到，async_launched 回执后到。
    // 修复前事件序列会变成 completed → running，Renderer 永久转圈。
    const queue = createAsyncQueue<AgentEvent>();
    const onSubagentTaskLaunched = vi.fn();
    const ctx = createCtx({ onSubagentTaskLaunched });

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-a',
        tool_use_id: 'toolu_agent_a',
        status: 'completed',
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_agent_a',
              content: [{ type: 'text', text: 'Async agent launched successfully.' }],
            },
          ],
        },
        tool_use_result: {
          isAsync: true,
          status: 'async_launched',
          agentId: 'agent-a',
          prompt: 'Survey the codebase',
          resolvedModel: 'codex/gpt-5.6-sol',
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    // 迟到的 launch 回执保留终态、只补模型元数据；也不重放 onSubagentTaskLaunched。
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      taskId: 'agent-a',
      parentToolUseId: 'toolu_agent_a',
      status: 'completed',
      model: 'codex/gpt-5.6-sol',
    });
    expect(onSubagentTaskLaunched).not.toHaveBeenCalled();
  });

  it('keeps the internal terminal latch when task_started/task_progress arrive late (projection unchanged)', async () => {
    // 迟到的 task_started/task_progress 事件仍按 running 投影下发（下游
    // terminalBackgroundTaskIds 按 taskId 丢弃，两道闸口径一致）；但内部终态登记
    // 不得被降级——迟到的 child assistant 读 Map 时必须仍看到终态。
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-a',
        tool_use_id: 'toolu_agent_a',
        status: 'failed',
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'agent-a',
        tool_use_id: 'toolu_agent_a',
      },
      queue,
      ctx,
    );
    // 迟到的 child assistant：读内部 Map 投影状态。若上面的 task_progress 把 Map
    // 降级回 running，这里会推 running 帧；终态闩保住时应为 failed。
    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_agent_a',
        message: { model: 'codex/gpt-5.6-sol', content: [] },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent =>
        event.type === 'agent_task_update',
    );
    const progressFrame = taskUpdates.find(
      (event) => event.data.subagentObservation?.kind === 'progress'
        && event.data.taskId === 'agent-a',
    );
    // 迟到的 task_progress 投影保持 running（交给下游终态闩丢弃，translator 不改写）。
    expect(progressFrame?.data.status).toBe('running');
    // 最后一帧（child assistant）读内部闩，终态未被降级。
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      status: 'failed',
      model: 'codex/gpt-5.6-sol',
    });
  });

  it('projects a synchronous completed Agent result with its actual model and usage', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const onSubagentTaskLaunched = vi.fn();
    const ctx = createCtx({ onSubagentTaskLaunched });

    translateSdkMessage(
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_sync_agent',
              content: [{ type: 'text', text: 'The agent completed successfully.' }],
            },
          ],
        },
        toolUseResult: {
          status: 'completed',
          agentId: 'agent-sync',
          prompt: 'Review the current changes',
          resolvedModel: 'vendor-a/model-sol',
          totalTokens: 22_113,
          totalToolUseCount: 0,
          totalDurationMs: 4_949,
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].data).toEqual({
      provider: 'claude-code',
      taskId: 'agent-sync',
      parentToolUseId: 'toolu_sync_agent',
      status: 'completed',
      model: 'vendor-a/model-sol',
      usage: { totalTokens: 22_113, toolUses: 0, durationMs: 4_949 },
      subagentObservation: {
        kind: 'spawn',
        logicalSubagentId: 'agent-sync',
        parentToolUseId: 'toolu_sync_agent',
      },
    });
    expect(onSubagentTaskLaunched).not.toHaveBeenCalled();
  });

  it('accepts snake_case fields from a synchronous completed Agent result', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_sync_agent', content: 'done' }],
        },
        tool_use_result: {
          status: 'completed',
          agent_id: 'agent-sync',
          resolved_model: 'provider-b/model-terra',
          total_tokens: 84,
          total_tool_use_count: 2,
          total_duration_ms: 1_250,
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates[0]?.data).toMatchObject({
      taskId: 'agent-sync',
      parentToolUseId: 'toolu_sync_agent',
      status: 'completed',
      model: 'provider-b/model-terra',
      usage: { totalTokens: 84, toolUses: 2, durationMs: 1_250 },
      subagentObservation: { kind: 'spawn' },
    });
  });

  it('uses a child runtime model when a completed Agent result has no resolvedModel', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          model: 'claude-opus-4-6',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_sync_agent',
              name: 'Agent',
              input: { prompt: 'Review changes', model: 'requested-model' },
            },
          ],
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_sync_agent',
        message: { model: 'vendor-runtime/model-actual', content: [] },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_sync_agent', content: 'done' }],
        },
        toolUseResult: {
          status: 'completed',
          agentId: 'agent-sync',
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      taskId: 'agent-sync',
      parentToolUseId: 'toolu_sync_agent',
      status: 'completed',
      model: 'vendor-runtime/model-actual',
      subagentObservation: { kind: 'spawn' },
    });
    expect(taskUpdates.at(-1)?.data).not.toMatchObject({ model: 'requested-model' });
  });

  it('lets a full child assistant replace an earlier stream model when no resolvedModel exists', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_sync_agent',
        event: {
          type: 'message_start',
          message: { model: 'vendor-stream/model-early', usage: { input_tokens: 0 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_sync_agent', content: 'done' }],
        },
        toolUseResult: { status: 'completed', agentId: 'agent-sync' },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_sync_agent',
        message: { model: 'vendor-assistant/model-actual', content: [] },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates.at(-2)?.data).toMatchObject({
      taskId: 'agent-sync',
      status: 'completed',
      model: 'vendor-stream/model-early',
      subagentObservation: { kind: 'spawn' },
    });
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      taskId: 'agent-sync',
      status: 'completed',
      model: 'vendor-assistant/model-actual',
      subagentObservation: { kind: 'terminal' },
    });
  });

  it('keeps resolvedModel authoritative over a later full child assistant', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_sync_agent', content: 'done' }],
        },
        toolUseResult: {
          status: 'completed',
          agentId: 'agent-sync',
          resolvedModel: 'vendor-resolved/model-authoritative',
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_sync_agent',
        message: { model: 'vendor-assistant/model-late', content: [] },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      taskId: 'agent-sync',
      status: 'completed',
      model: 'vendor-resolved/model-authoritative',
    });
  });

  it('repairs zero task tokens from host usage and preserves zero tool uses', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const usageByTaskId = new Map([
      ['agent-a', 185],
      ['agent-b', 230],
    ]);
    const ctx = createCtx({
      getSubagentTaskUsage: (taskId) => {
        const totalTokens = usageByTaskId.get(taskId);
        return totalTokens === undefined ? undefined : { totalTokens };
      },
    });

    const stream = (
      parentToolUseId: string,
      event: Record<string, unknown>,
    ) => translateSdkMessage(
      {
        type: 'stream_event',
        session_id: 'sdk-session',
        parent_tool_use_id: parentToolUseId,
        event,
      },
      queue,
      ctx,
    );

    stream('toolu_agent_a', {
      type: 'message_start',
      message: {
        model: 'codex/gpt-5.6-terra',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      },
    });
    stream('toolu_agent_b', {
      type: 'message_start',
      message: { model: 'codex/gpt-5.6-sol', usage: { input_tokens: 200 } },
    });
    stream('toolu_agent_a', {
      type: 'message_delta',
      usage: { input_tokens: 0, output_tokens: 10 },
    });
    stream('toolu_agent_b', {
      type: 'message_delta',
      usage: { input_tokens: 0, output_tokens: 30 },
    });
    for (const [taskId, parentToolUseId] of [
      ['agent-a', 'toolu_agent_a'],
      ['agent-b', 'toolu_agent_b'],
    ] as const) {
      translateSdkMessage(
        {
          type: 'system',
          subtype: 'task_notification',
          task_id: taskId,
          tool_use_id: parentToolUseId,
          status: 'completed',
          usage: { total_tokens: 0, tool_uses: 0, duration_ms: 1000 },
        },
        queue,
        ctx,
      );
    }

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates.map((event) => event.data)).toEqual([
      expect.objectContaining({
        taskId: 'agent-a',
        parentToolUseId: 'toolu_agent_a',
        model: 'codex/gpt-5.6-terra',
        usage: { totalTokens: 185, toolUses: 0, durationMs: 1000 },
      }),
      expect.objectContaining({
        taskId: 'agent-b',
        parentToolUseId: 'toolu_agent_b',
        model: 'codex/gpt-5.6-sol',
        usage: { totalTokens: 230, toolUses: 0, durationMs: 1000 },
      }),
    ]);
  });

  it('keeps resolvedModel authoritative over the child stream model', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_a', content: 'launched' }],
        },
        toolUseResult: {
          isAsync: true,
          agentId: 'agent-a',
          resolvedModel: 'codex/gpt-5.6-terra',
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu_agent_a',
        event: {
          type: 'message_start',
          message: { model: 'gpt-5.6-terra', usage: { input_tokens: 100 } },
        },
      },
      queue,
      ctx,
    );
    // notification 缺 tool_use_id 时也应通过 task id 别名找回 parent/model。
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'agent-a',
        status: 'completed',
        usage: { total_tokens: 42 },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event) => event.type === 'agent_task_update',
    );
    expect(taskUpdates.at(-1)?.data).toMatchObject({
      taskId: 'agent-a',
      parentToolUseId: 'toolu_agent_a',
      model: 'codex/gpt-5.6-terra',
      usage: { totalTokens: 42 },
    });
  });
});

describe('Claude Code sidechain launch failure projection', () => {
  it('projects a pre-task sidechain error envelope as a failed parent-visible task', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        error: 'authentication_failed',
        parent_tool_use_id: 'toolu_launch_fail',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'The requested model is not available for your account.' },
          ],
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].data).toMatchObject({
      provider: 'claude-code',
      taskId: 'toolu_launch_fail',
      parentToolUseId: 'toolu_launch_fail',
      status: 'failed',
      subagentObservation: {
        kind: 'spawn',
        logicalSubagentId: 'toolu_launch_fail',
        parentToolUseId: 'toolu_launch_fail',
      },
    });
    expect(taskUpdates[0].data.description).toContain('not available for your account');
    // 标题不下发：由渲染层按 locale 生成，避免 maker-core 输出单语言文案。
    expect(taskUpdates[0].data).not.toHaveProperty('title');
  });

  it('does not project a retryable sidechain error before the SDK retries', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    // rate_limit / server_error / unknown 是 SDK 自己退避重试的 tag；SDK 仍可能
    // 自愈并发出 task_started，所以这里不得提前锁死成 failed。
    translateSdkMessage(
      {
        type: 'assistant',
        error: 'rate_limit',
        parent_tool_use_id: 'toolu_retryable',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Rate limited, retrying.' }],
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(0);
    expect(ctx.turn.pendingApiError).toBeNull();
  });

  it('projects a retryable sidechain error once the SDK retries are exhausted (api_retry before envelope)', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();
    // api_retry 先到且已耗尽（attempt === max_retries）：记下本 turn 已耗尽的 tag。
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 3,
        max_retries: 3,
        error: 'rate_limit',
        error_status: 429,
        retry_delay_ms: 100,
      },
      queue,
      ctx,
    );
    // 终态 error envelope 随后到达：tag 已耗尽 → 投影失败终态（#2967 收口）。
    translateSdkMessage(
      {
        type: 'assistant',
        error: 'rate_limit',
        parent_tool_use_id: 'toolu_retry_exhausted',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Rate limited.' }],
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].data).toMatchObject({
      taskId: 'toolu_retry_exhausted',
      parentToolUseId: 'toolu_retry_exhausted',
      status: 'failed',
    });
  });

  it('projects a retryable sidechain error when api_retry exhausts after the envelope', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();
    // envelope 先到：记 open 等待，暂不投影。
    translateSdkMessage(
      {
        type: 'assistant',
        error: 'rate_limit',
        parent_tool_use_id: 'toolu_retry_exhausted',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Rate limited.' }],
        },
      },
      queue,
      ctx,
    );
    // api_retry 耗尽随后到达：对 open 的同 tag sidechain 补发失败终态。
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 3,
        max_retries: 3,
        error: 'rate_limit',
        error_status: 429,
        retry_delay_ms: 100,
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].data).toMatchObject({
      taskId: 'toolu_retry_exhausted',
      parentToolUseId: 'toolu_retry_exhausted',
      status: 'failed',
    });
  });

  it('does not project a retryable sidechain error while the SDK is still retrying (then self-heals)', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        error: 'rate_limit',
        parent_tool_use_id: 'toolu_retryable',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Rate limited, retrying.' }],
        },
      },
      queue,
      ctx,
    );
    // 仍在重试（attempt < max_retries），随后自愈产生真实 task_id：不得投影失败。
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'api_retry',
        attempt: 1,
        max_retries: 3,
        error: 'rate_limit',
        error_status: 429,
        retry_delay_ms: 100,
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-self-healed',
        tool_use_id: 'toolu_retryable',
        task_type: 'local_agent',
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent => event.type === 'agent_task_update',
    );
    // 只有 task_started 的 running 帧，没有 failed 投影。
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].data).toMatchObject({
      taskId: 'agent-self-healed',
      status: 'running',
    });
  });

  it('does not leak a sidechain error into the main turn pendingApiError', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    translateSdkMessage(
      {
        type: 'assistant',
        error: 'authentication_failed',
        parent_tool_use_id: 'toolu_launch_fail',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Model unavailable.' }],
        },
      },
      queue,
      ctx,
    );
    await collect(queue);

    expect(ctx.turn.pendingApiError).toBeNull();
  });

  it('does not re-emit a failed task when the parent already has a known task id', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = createCtx();

    // 先有 task_started：登记 taskId → parentToolUseId 映射。
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'agent-a',
        tool_use_id: 'toolu_launch_fail',
        task_type: 'local_agent',
      },
      queue,
      ctx,
    );
    // 再遇 sidechain error envelope：已有 taskId，执行期失败由
    // task_notification:failed 收口，不应再合成一条 failed 任务。
    translateSdkMessage(
      {
        type: 'assistant',
        error: 'server_error',
        parent_tool_use_id: 'toolu_launch_fail',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Boom.' }],
        },
      },
      queue,
      ctx,
    );

    const taskUpdates = (await collect(queue)).filter(
      (event): event is AgentTaskUpdateEvent => event.type === 'agent_task_update',
    );
    expect(taskUpdates).toHaveLength(1);
    expect(taskUpdates[0].data.status).toBe('running');
  });
});
