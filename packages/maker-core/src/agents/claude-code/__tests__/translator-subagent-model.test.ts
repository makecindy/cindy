import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../../types/events.js';
import { createAsyncQueue } from '../../shared/async-queue.js';
import { UsageTracker } from '../../shared/usage-tracker.js';
import {
  newRuntimeState,
  translateSdkMessage,
  type TurnState,
} from '../translator.js';

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
