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
    getModel: () => 'deepseek-flash-latest',
    getEffort: () => 'high' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker,
    getModelContextWindow: () => 512_000,
  };
}

async function drain(queue: ReturnType<typeof createAsyncQueue<AgentEvent>>): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

const MESSAGE_ID = '0217956000000000000000000000000000000000000000000000';

function startEvent(usage: Record<string, number>, id = MESSAGE_ID) {
  return {
    type: 'stream_event' as const,
    event: {
      type: 'message_start',
      message: { id, model: 'deepseek-flash-latest', usage },
    },
  };
}

function deltaEvent(usage: Record<string, number>) {
  return {
    type: 'stream_event' as const,
    event: {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage,
    },
  };
}

function stopEvent() {
  return { type: 'stream_event' as const, event: { type: 'message_stop' } };
}

function completedRequest(usage: Record<string, number>, id = MESSAGE_ID) {
  return [startEvent(usage, id), deltaEvent(usage), stopEvent()] as const;
}

describe('Claude Code translator proxied multi-block usage', () => {
  it('merges provider cycles that reuse one message id into a single request segment', async () => {
    const tracker = new UsageTracker();
    const ctx = createCtx(tracker);
    const queue = createAsyncQueue<AgentEvent>();

    // A proxied response is split into a thinking cycle and a text cycle. Both carry
    // the same provider message id; the first message_delta reports no output yet.
    for (const message of completedRequest({ input_tokens: 1000, cache_read_input_tokens: 50000 })) {
      translateSdkMessage(message, queue, ctx);
    }
    for (const message of completedRequest({
      input_tokens: 1000,
      cache_read_input_tokens: 50000,
      output_tokens: 120,
    })) {
      translateSdkMessage(message, queue, ctx);
    }
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0.01,
        result: 'ok',
        usage: {
          input_tokens: 2000,
          cache_read_input_tokens: 100000,
          cache_creation_input_tokens: 0,
          output_tokens: 120,
        },
        modelUsage: {
          'deepseek-flash-latest': {
            inputTokens: 1000,
            outputTokens: 120,
            cacheReadInputTokens: 50000,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
          },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const done = events.find((event) => event.type === 'done');
    const segments = (done?.data as { usageSegments?: Array<Record<string, number>> } | undefined)
      ?.usageSegments;
    expect(segments).toHaveLength(1);
    expect(segments?.[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 120,
      cacheReadTokens: 50000,
      complete: true,
    });
  });

  it('keeps distinct provider message ids as separate request segments', async () => {
    const tracker = new UsageTracker();
    const ctx = createCtx(tracker);
    const queue = createAsyncQueue<AgentEvent>();

    for (const message of completedRequest({ input_tokens: 1000, output_tokens: 10 })) {
      translateSdkMessage(message, queue, ctx);
    }
    for (const message of completedRequest(
      { input_tokens: 2000, output_tokens: 20 },
      'another-message-id',
    )) {
      translateSdkMessage(message, queue, ctx);
    }
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0.01,
        result: 'ok',
        usage: { input_tokens: 3000, output_tokens: 30 },
        modelUsage: {
          'deepseek-flash-latest': {
            inputTokens: 3000,
            outputTokens: 30,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
          },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const done = events.find((event) => event.type === 'done');
    const segments = (done?.data as { usageSegments?: Array<Record<string, number>> } | undefined)
      ?.usageSegments;
    expect(segments).toHaveLength(2);
    expect(segments?.map((segment) => segment.inputTokens)).toEqual([1000, 2000]);
  });

  it('starts a new segment when a tool result separates requests reusing one id', async () => {
    const tracker = new UsageTracker();
    const ctx = createCtx(tracker);
    const queue = createAsyncQueue<AgentEvent>();

    for (const message of completedRequest({ input_tokens: 1000, output_tokens: 10 })) {
      translateSdkMessage(message, queue, ctx);
    }
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        },
      },
      queue,
      ctx,
    );
    for (const message of completedRequest({ input_tokens: 2000, output_tokens: 20 })) {
      translateSdkMessage(message, queue, ctx);
    }
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0.01,
        result: 'ok',
        usage: { input_tokens: 3000, output_tokens: 30 },
        modelUsage: {
          'deepseek-flash-latest': {
            inputTokens: 3000,
            outputTokens: 30,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
          },
        },
      },
      queue,
      ctx,
    );

    const events = await drain(queue);
    const done = events.find((event) => event.type === 'done');
    const segments = (done?.data as { usageSegments?: Array<Record<string, number>> } | undefined)
      ?.usageSegments;
    expect(segments).toHaveLength(2);
    expect(segments?.map((segment) => segment.inputTokens)).toEqual([1000, 2000]);
  });
});
