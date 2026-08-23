import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAsyncQueue } from '../shared/async-queue.js';
import { UsageTracker } from '../shared/usage-tracker.js';
import type { AgentEvent } from '../../types/events.js';
import {
  beginClaudeGeneration,
  finalizeClaudeGeneration,
  newClaudeGenerationState,
  pauseClaudeGeneration,
  resetClaudeGenerationTiming,
  resumeClaudeGeneration,
} from './generation-timing.js';
import { newRuntimeState, translateSdkMessage, type TurnState } from './translator.js';

describe('claude generation timing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('excludes tool intervals from the generation denominator', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const state = newClaudeGenerationState();
    beginClaudeGeneration(state, 1_000);
    pauseClaudeGeneration(state, 'tool-1', 1_400);
    resumeClaudeGeneration(state, 'tool-1', 5_000);
    finalizeClaudeGeneration(state, 5_200);
    expect(state.reliable).toBe(true);
    expect(state.durationMs).toBe(600);
    expect(state.startedAt).toBeNull();
  });

  it('stops the heartbeat when the session is reset without a result event', () => {
    vi.useFakeTimers();
    try {
      const state = newClaudeGenerationState();
      beginClaudeGeneration(state, 1_000);
      expect(state.heartbeatTimer).not.toBeNull();
      resetClaudeGenerationTiming(state);
      expect(state.heartbeatTimer).toBeNull();
      expect(state.heartbeatAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks timing unreliable when pausing without a generation start boundary', () => {
    const state = newClaudeGenerationState();
    pauseClaudeGeneration(state, 'tool-1', 1_400);
    resumeClaudeGeneration(state, 'tool-1', 5_000);
    finalizeClaudeGeneration(state, 5_200);
    expect(state.reliable).toBe(false);
  });
});

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
    nextRequestPriceVariant: 'standard',
  };
}

function createTranslatorCtx() {
  return {
    rt: newRuntimeState(),
    turn: createTurnState(),
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    getModel: () => 'claude-sonnet-4.5',
    getEffort: () => 'medium' as const,
    getPermissionMode: () => 'auto' as const,
    onSessionId: vi.fn(),
    getSdkSessionId: () => undefined,
    getLogTitle: () => undefined,
    tracker: new UsageTracker(),
  };
}

describe('claude generation pause boundaries', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps generating through tool-argument deltas and pauses on message_delta', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 10 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBe(1_000);
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);

    vi.setSystemTime(1_200);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', input: {} },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBe(1_000);
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);
    expect(ctx.rt.generation.durationMs).toBe(0);

    vi.setSystemTime(1_600);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBe(1_000);
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);

    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 40 },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.has('toolu_1')).toBe(true);
    expect(ctx.rt.generation.durationMs).toBe(800);
    expect(ctx.rt.generation.reliable).toBe(true);

    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
  });

  it('pauses on a completed assistant tool_use when stream_event never arrived', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 10 } },
        },
      },
      queue,
      ctx,
    );

    vi.setSystemTime(1_500);
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_2',
              name: 'Read',
              input: { file_path: '/tmp/a' },
            },
          ],
        },
      },
      queue,
      ctx,
    );

    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.has('toolu_2')).toBe(true);
    expect(ctx.rt.generation.durationMs).toBe(500);
    expect(ctx.rt.generation.reliable).toBe(true);

    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
  });

  it('marks timing unreliable when a completed tool_use arrives without message_start', () => {
    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_3',
              name: 'Read',
              input: { file_path: '/tmp/a' },
            },
          ],
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.has('toolu_3')).toBe(true);
    expect(ctx.rt.generation.reliable).toBe(false);
    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
  });

  it('attaches live generation fields to the terminal snapshot without message_delta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 10 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'done' }] },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 40 },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);
    const doneStatus = events.find(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Done',
    );
    expect(doneStatus?.data).toMatchObject({
      isRunning: false,
      outputTokens: 40,
      generationDurationMs: 800,
      generationReliable: true,
      generationActive: false,
    });
    resetClaudeGenerationTiming(ctx.rt.generation);
    vi.useRealTimers();
  });

  it('merges message_start and message_delta usage into one request segment', async () => {
    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'claude-sonnet-4.5',
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 900,
              cache_creation_input_tokens: 50,
            },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 50,
          },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.tracker.getTurnUsage()).toEqual({
      input: 100,
      output: 25,
      cacheRead: 900,
      cacheCreate: 50,
    });
    expect(ctx.tracker.getTurnUsageSegments()).toHaveLength(1);

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
        },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);
    const done = events.find((event) => event.type === 'done');
    expect(done?.data).toMatchObject({
      usageSegmentsComplete: true,
      usageSegments: [
        {
          model: 'claude-sonnet-4.5',
          inputTokens: 100,
          outputTokens: 25,
          cacheReadTokens: 900,
          cacheCreateTokens: 50,
          complete: true,
        },
      ],
    });
  });

  it('freezes the current request and captures the next tool-loop request variant at the tool boundary', () => {
    let fastMode = false;
    const ctx = {
      ...createTranslatorCtx(),
      getFastMode: () => fastMode,
    };
    const queue = createAsyncQueue<AgentEvent>();
    // The first request was accepted on standard before its message_start
    // arrived; the user toggles Fast while that response is still in flight.
    ctx.turn.nextRequestPriceVariant = 'standard';
    fastMode = true;
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 100 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: {
            input_tokens: 100,
            output_tokens: 25,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      queue,
      ctx,
    );

    // The first response requests a tool. Fast is toggled while the tool is
    // running, and the SDK's tool-result echo is the boundary at which the
    // next provider request's variant is captured.
    fastMode = false;
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
        },
      },
      queue,
      ctx,
    );
    fastMode = true;
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }],
        },
      },
      queue,
      ctx,
    );

    // The next provider request is dispatched after the tool result and gets
    // its own priority segment.
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 200 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: {
            input_tokens: 200,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      queue,
      ctx,
    );

    expect(ctx.tracker.getTurnUsageSegments()).toEqual([
      expect.objectContaining({ inputTokens: 100, outputTokens: 25, priceVariant: 'standard' }),
      expect.objectContaining({ inputTokens: 200, outputTokens: 10, priceVariant: 'priority' }),
    ]);
    queue.end();
  });

  it('fails closed when a resumed result aggregate cannot prove streamed segment completeness', async () => {
    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 100 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 25 } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 2,
        num_turns: 1,
        usage: {
          // First result after resume can include historical usage, and some
          // providers only reveal cache tokens here. Request count alone must
          // not turn the streamed subset into an exact priced total.
          input_tokens: 1_100,
          output_tokens: 225,
          cache_read_input_tokens: 500,
        },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);
    const done = events.find((event) => event.type === 'done');
    expect(done?.data).toMatchObject({
      usageSegmentsComplete: false,
      usageSegments: [
        {
          model: 'claude-sonnet-4.5',
          inputTokens: 100,
          outputTokens: 25,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          complete: false,
        },
      ],
    });
  });

  it('marks timing unreliable for a complete subagent assistant without message_delta', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 10 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.reliable).toBe(true);
    translateSdkMessage(
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu-agent',
        message: { content: [{ type: 'text', text: 'child output' }] },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.reliable).toBe(false);
    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
    vi.useRealTimers();
  });
});
