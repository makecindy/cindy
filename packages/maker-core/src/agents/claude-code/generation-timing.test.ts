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

  it('does not re-pause a settled id while the current interval is open', () => {
    const state = newClaudeGenerationState();
    beginClaudeGeneration(state, 1_000);
    pauseClaudeGeneration(state, 'tool-1', 1_400);
    resumeClaudeGeneration(state, 'tool-1', 5_000);
    expect(state.startedAt).toBe(5_000);
    expect(state.pendingToolIds.size).toBe(0);
    expect(state.settledPauseIds.has('tool-1')).toBe(true);

    pauseClaudeGeneration(state, 'tool-1', 5_500);
    expect(state.startedAt).toBe(5_000);
    expect(state.pendingToolIds.size).toBe(0);
    expect(state.reliable).toBe(true);
    expect(state.durationMs).toBe(400);
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

  it('keeps parent timing reliable for a complete subagent assistant without message_delta', () => {
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
    expect(ctx.rt.generation.reliable).toBe(true);
    expect(ctx.rt.generation.sawSubagent).toBe(true);
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.has('toolu-agent')).toBe(true);
    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
    vi.useRealTimers();
  });

  it('closes parent generation when a child stream arrives before the parent tool pause', async () => {
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
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.has('toolu-agent')).toBe(true);
    expect(ctx.rt.generation.durationMs).toBe(500);
    expect(ctx.rt.generation.reliable).toBe(true);
    expect(ctx.rt.generation.sawSubagent).toBe(true);

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-agent', name: 'Agent', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(5_000);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 80 },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.durationMs).toBe(500);
    expect(ctx.rt.generation.reliable).toBe(true);

    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 500 },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu-agent', content: 'child done' }],
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(5_400);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 15, output_tokens: 580 },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);

    const generating = events.filter(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Generating...',
    );
    expect(generating[1]?.data).toMatchObject({
      outputTokens: 0,
      generationReliable: false,
    });
    expect(generating.at(-1)?.data).toMatchObject({
      outputTokens: 80,
      generationReliable: true,
    });
    const doneStatus = events.find(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Done',
    );
    expect(doneStatus?.data).toMatchObject({
      outputTokens: 80,
      generationReliable: true,
      generationActive: false,
    });
    resetClaudeGenerationTiming(ctx.rt.generation);
    vi.useRealTimers();
  });

  it('hides live tok/s until the current parent request streams output', async () => {
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
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-agent-1', name: 'Agent', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 80 } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent-1',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent-1',
        event: { type: 'message_delta', usage: { output_tokens: 500 } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu-agent-1', content: 'child 1 done' }],
        },
      },
      queue,
      ctx,
    );

    vi.setSystemTime(2_200);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 20 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.reliable).toBe(true);

    vi.setSystemTime(2_600);
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent-2',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.reliable).toBe(true);
    expect(ctx.rt.generation.startedAt).toBeNull();

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-agent-2', name: 'Agent', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(2_800);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 40 } },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.reliable).toBe(true);

    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent-2',
        event: { type: 'message_delta', usage: { output_tokens: 200 } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu-agent-2', content: 'child 2 done' }],
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(3_200);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 40, output_tokens: 820 },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);

    const generating = events.filter(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Generating...',
    );
    const pendingCurrentParent = generating.filter((event) => {
      const data = event.data as { outputTokens?: number; generationReliable?: boolean };
      return data.outputTokens === 80 && data.generationReliable === false;
    });
    expect(pendingCurrentParent.length).toBeGreaterThan(0);
    expect(generating.at(-1)?.data).toMatchObject({
      outputTokens: 120,
      generationReliable: true,
    });
    const doneStatus = events.find(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Done',
    );
    expect(doneStatus?.data).toMatchObject({
      outputTokens: 120,
      generationReliable: true,
      generationActive: false,
    });
    resetClaudeGenerationTiming(ctx.rt.generation);
    vi.useRealTimers();
  });

  it('does not pin a pause id when a child stream arrives with no parent generation interval', () => {
    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.sawSubagent).toBe(true);
    expect(ctx.rt.generation.reliable).toBe(true);
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);
    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
  });

  it('does not let a settled-turn background child block the next parent generation', () => {
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
    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 80 } },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(2_200);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 10, output_tokens: 80 },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);
    expect(ctx.rt.generation.reliable).toBe(true);

    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent-bg',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.sawSubagent).toBe(true);
    expect(ctx.rt.generation.reliable).toBe(true);
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);

    vi.setSystemTime(3_000);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 20 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBe(3_000);
    expect(ctx.rt.generation.reliable).toBe(true);
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);
    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
    vi.useRealTimers();
  });

  it('does not re-pause a resumed background child during the next parent generation', () => {
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
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-agent-bg', name: 'Agent', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 80 } },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.pendingToolIds.has('toolu-agent-bg')).toBe(true);
    expect(ctx.rt.generation.startedAt).toBeNull();

    vi.setSystemTime(2_200);
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu-agent-bg', content: 'async_launched' }],
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);
    expect(ctx.rt.generation.startedAt).toBe(2_200);
    expect(ctx.rt.generation.settledPauseIds.has('toolu-agent-bg')).toBe(true);
    expect(ctx.rt.generation.reliable).toBe(true);

    vi.setSystemTime(3_000);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 20 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBe(2_200);

    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent-bg',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBe(2_200);
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);
    expect(ctx.rt.generation.reliable).toBe(true);

    vi.setSystemTime(3_400);
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent-2',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBeNull();
    expect(ctx.rt.generation.pendingToolIds.has('toolu-agent-2')).toBe(true);
    expect(ctx.rt.generation.reliable).toBe(true);
    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
    vi.useRealTimers();
  });

  it('does not reuse the previous parent request output after that assistant closes', async () => {
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
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-agent-1', name: 'Agent', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 80 } },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu-agent-1', name: 'Agent', input: {} }],
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.parentStreamedOutputIncomplete).toBe(false);

    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu-agent-1', content: 'child 1 done' }],
        },
      },
      queue,
      ctx,
    );

    vi.setSystemTime(2_600);
    translateSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu-agent-2', name: 'Agent', input: {} }],
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.parentStreamedOutputIncomplete).toBe(true);

    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent-2',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);
    expect(events.at(-1)?.data).toMatchObject({
      outputTokens: 80,
      generationReliable: false,
    });
    resetClaudeGenerationTiming(ctx.rt.generation);
    vi.useRealTimers();
  });

  it('excludes subagent output from parent live tok/s', async () => {
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
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu-agent', name: 'Agent', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 80 },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.reliable).toBe(true);
    expect(ctx.rt.generation.pendingToolIds.has('toolu-agent')).toBe(true);

    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 500 },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.reliable).toBe(true);
    expect(ctx.rt.generation.sawSubagent).toBe(true);

    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu-agent', content: 'child done' }],
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(2_200);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 15, output_tokens: 580 },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);

    const generating = events.filter(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Generating...',
    );
    expect(generating.at(-1)?.data).toMatchObject({
      outputTokens: 80,
      generationReliable: true,
    });
    const doneStatus = events.find(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Done',
    );
    expect(doneStatus?.data).toMatchObject({
      outputTokens: 80,
      generationReliable: true,
      generationActive: false,
    });
    resetClaudeGenerationTiming(ctx.rt.generation);
    vi.useRealTimers();
  });

  it('fails closed when a subagent is present but parent streamed output is incomplete', async () => {
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
        message: { content: [{ type: 'text', text: 'parent without delta' }] },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 500 },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.sawSubagent).toBe(true);
    expect(ctx.rt.generation.parentStreamedOutputIncomplete).toBe(true);
    expect(ctx.rt.generation.reliable).toBe(false);

    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 15, output_tokens: 580 },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);
    const generating = events.filter(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Generating...',
    );
    expect(generating.at(-1)?.data).toMatchObject({
      generationReliable: false,
    });
    const doneStatus = events.find(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Done',
    );
    expect(doneStatus?.data).toMatchObject({
      generationReliable: false,
      generationActive: false,
    });
    resetClaudeGenerationTiming(ctx.rt.generation);
    vi.useRealTimers();
  });

  it('fails closed live when a later parent request closes without usage', async () => {
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
        type: 'stream_event',
        event: {
          type: 'message_delta',
          usage: { output_tokens: 80 },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'first parent request' }] },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.parentStreamedOutputIncomplete).toBe(false);

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 8 } },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'parent without delta' }] },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.parentStreamedOutputIncomplete).toBe(true);

    translateSdkMessage(
      {
        type: 'stream_event',
        parent_tool_use_id: 'toolu-agent',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 5 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.reliable).toBe(false);

    vi.setSystemTime(1_800);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 23, output_tokens: 600 },
      },
      queue,
      ctx,
    );
    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);
    const generating = events.filter(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Generating...',
    );
    expect(generating.at(-1)?.data).toMatchObject({
      outputTokens: 80,
      generationReliable: false,
    });
    const doneStatus = events.find(
      (event) => event.type === 'status' && (event.data as { status?: string }).status === 'Done',
    );
    expect(doneStatus?.data).toMatchObject({
      outputTokens: 80,
      generationReliable: false,
      generationActive: false,
    });
    resetClaudeGenerationTiming(ctx.rt.generation);
    vi.useRealTimers();
  });

  it('does not freeze the next turn when a previous turn left an unresolved tool id', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const ctx = createTranslatorCtx();
    const queue = createAsyncQueue<AgentEvent>();

    // Turn 1: a tool_use streams but its tool_result echo never arrives
    // (SDK-internal tools like ToolSearch resolve without an echo), then the
    // turn ends.
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
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_stale', name: 'ToolSearch', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(1_500);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 40 } },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(2_000);
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
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);

    // Turn 2: the stale id must not re-enter pending, and the clock must
    // restart once this turn's only real tool resolves. Otherwise the
    // denominator freezes while output keeps accruing → runaway live tok/s.
    vi.setSystemTime(10_000);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 12 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBe(10_000);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_next', name: 'Read', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(10_400);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 100 } },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.pendingToolIds.has('toolu_stale')).toBe(false);
    expect(ctx.rt.generation.pendingToolIds.has('toolu_next')).toBe(true);
    expect(ctx.rt.generation.durationMs).toBe(400);

    vi.setSystemTime(10_600);
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_next', content: 'ok' }],
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);
    expect(ctx.rt.generation.startedAt).toBe(10_600);
    expect(ctx.rt.generation.reliable).toBe(true);

    resetClaudeGenerationTiming(ctx.rt.generation);
    queue.end();
    vi.useRealTimers();
  });

  it('unfreezes the clock at the next request when a tool result echo never arrives', async () => {
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
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_search', name: 'ToolSearch', input: {} },
        },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(1_500);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 50 } },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.pendingToolIds.has('toolu_search')).toBe(true);
    expect(ctx.rt.generation.durationMs).toBe(500);

    // The SDK resolved the tool internally without echoing a tool_result. A
    // new parent request proves every tool of the previous message settled —
    // the clock must restart instead of staying frozen for the rest of the
    // turn.
    vi.setSystemTime(4_000);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { model: 'claude-sonnet-4.5', usage: { input_tokens: 12 } },
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.pendingToolIds.size).toBe(0);
    expect(ctx.rt.generation.startedAt).toBe(4_000);
    expect(ctx.rt.generation.reliable).toBe(true);

    // A late echo for the internally settled id stays a no-op.
    vi.setSystemTime(4_100);
    translateSdkMessage(
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_search', content: 'loaded' }],
        },
      },
      queue,
      ctx,
    );
    expect(ctx.rt.generation.startedAt).toBe(4_000);
    expect(ctx.rt.generation.reliable).toBe(true);

    vi.setSystemTime(4_500);
    translateSdkMessage(
      {
        type: 'stream_event',
        event: { type: 'message_delta', usage: { output_tokens: 100 } },
      },
      queue,
      ctx,
    );
    vi.setSystemTime(4_800);
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: { input_tokens: 22, output_tokens: 150 },
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
      outputTokens: 150,
      generationReliable: true,
      generationActive: false,
      generationDurationMs: 1_300,
    });
    resetClaudeGenerationTiming(ctx.rt.generation);
    vi.useRealTimers();
  });
});
