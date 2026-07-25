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

describe('Claude Code translator context window', () => {
  it('preserves the SDK uuid as the compact boundary identity', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary-1',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 200_000,
          post_tokens: 20_000,
          duration_ms: 100,
        },
      },
      queue,
      {
        rt: newRuntimeState(),
        turn: createTurnState(),
        log: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        getModel: () => 'gpt-5.4',
        getEffort: () => 'high',
        getPermissionMode: () => 'auto',
        onSessionId: vi.fn(),
        getSdkSessionId: () => undefined,
        getLogTitle: () => undefined,
        tracker,
      },
    );

    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);

    expect(events).toEqual([
      expect.objectContaining({
        type: 'compact_boundary',
        data: expect.objectContaining({ boundaryId: 'compact-boundary-1' }),
      }),
    ]);
  });

  it('emits provider-neutral task updates from Claude task system messages', async () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = {
      rt: newRuntimeState(),
      turn: createTurnState(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      getModel: () => 'claude-sonnet-4-5',
      getEffort: () => 'high',
      getPermissionMode: () => 'auto',
      onSessionId: vi.fn(),
      getSdkSessionId: () => undefined,
      getLogTitle: () => undefined,
      tracker,
    };

    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Review auth flow',
        prompt: 'Check the auth flow',
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        description: 'Review auth flow',
        summary: 'Read login code',
        last_tool_name: 'Read',
        usage: { total_tokens: 1200, tool_uses: 3, duration_ms: 2500 },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        tool_use_id: 'toolu-1',
        status: 'completed',
        output_file: '/tmp/task.md',
        summary: 'Auth flow looks correct',
      },
      queue,
      ctx,
    );

    queue.end();
    const events: AgentEvent[] = [];
    for await (const event of queue) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      'agent_task_update',
      'agent_task_update',
      'agent_task_update',
    ]);
    expect(events[0].data).toMatchObject({
      provider: 'claude-code',
      taskId: 'task-1',
      parentToolUseId: 'toolu-1',
      status: 'running',
      title: 'Review auth flow',
      description: 'Check the auth flow',
    });
    expect(events[1].data).toMatchObject({
      status: 'running',
      summary: 'Read login code',
      lastToolName: 'Read',
      usage: { totalTokens: 1200, toolUses: 3, durationMs: 2500 },
    });
    expect(events[2].data).toMatchObject({
      status: 'completed',
      outputFile: '/tmp/task.md',
      summary: 'Auth flow looks correct',
    });
  });

  it('prefers maker model capability when SDK reports the unknown-model 200K default', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 2 },
        modelUsage: {
          'qwen/qwen3.7-max': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 200_000,
          },
        },
      },
      queue,
      {
        rt: newRuntimeState(),
        turn: createTurnState(),
        log: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        getModel: () => 'qwen/qwen3.7-max',
        getEffort: () => 'low',
        getPermissionMode: () => 'auto',
        onSessionId: vi.fn(),
        getSdkSessionId: () => undefined,
        getLogTitle: () => undefined,
        tracker,
        getModelContextWindow: () => 992_000,
      },
    );

    expect(tracker.snapshot().contextWindow).toBe(992_000);
  });

  it('prefers maker catalog window over an inflated SDK 1M for budget-routed models', () => {
    // 回归(防御性): 即便 SDK modelUsage 仍按 [1m] 历史口径上报 1M(toSdkModelString
    // 已不再给 codex/* 加 [1m], 但此处保留对"SDK 若上报 1M"的兜底覆盖),
    // catalog cc 侧权威值 272k 必须向下覆盖, 否则 auto-compact / memory-flush ratio
    // 按 1M 算永不触发, 对话冲过折扣网关真实上限(~24 万 token)后空转, 会话"假死"。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 2 },
        modelUsage: {
          'codex/gpt-5.5[1m]': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      {
        rt: newRuntimeState(),
        turn: createTurnState(),
        log: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        getModel: () => 'codex/gpt-5.5',
        getEffort: () => 'high',
        getPermissionMode: () => 'auto',
        onSessionId: vi.fn(),
        getSdkSessionId: () => undefined,
        getLogTitle: () => undefined,
        tracker,
        getModelContextWindow: () => 272_000,
      },
    );

    expect(tracker.snapshot().contextWindow).toBe(272_000);
  });

  it('does NOT override the SDK window with the catalog value on a mid-turn model switch', () => {
    // 回归(Codex P2): turn 运行中切模型时 getModel() 已是新模型(codex/gpt-5.5, catalog 272k),
    // 但 msg.modelUsage 还是产出本 result 的旧模型(gpt-5.5[1m], 1M)。此时 SDK 窗口(1M)才是
    // 这一轮真实模型的窗口, 不能被新模型 catalog(272k)覆盖 —— 否则 Done 快照 / 压缩决策记错。
    // 当前模型未命中 modelUsage(exact/prefix 都不中)→ source='max', >200K → 不覆盖。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 2 },
        modelUsage: {
          'gpt-5.5[1m]': { inputTokens: 10, outputTokens: 2, costUSD: 0, contextWindow: 1_000_000 },
        },
      },
      queue,
      {
        rt: newRuntimeState(),
        turn: createTurnState(),
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        getModel: () => 'codex/gpt-5.5', // 切到折扣版后, 旧的 gpt-5.5[1m] turn 才收口
        getEffort: () => 'high',
        getPermissionMode: () => 'auto',
        onSessionId: vi.fn(),
        getSdkSessionId: () => undefined,
        getLogTitle: () => undefined,
        tracker,
        getModelContextWindow: () => 272_000,
      },
    );

    expect(tracker.snapshot().contextWindow).toBe(1_000_000);
  });

  it('does NOT override a similarly-prefixed other model window after a model switch (mini vs base)', () => {
    // 回归(Codex P2): modelIdsMatchForContextWindow 用 startsWith 松匹配, 'gpt-5.4-mini' 会被
    // 当成当前 'gpt-5.4' 的 prefix 命中。切到 gpt-5.4(catalog 1M)后, 旧的 gpt-5.4-mini(272k)
    // turn 收口时不能把 mini 的真实 272k 覆盖成 gpt-5.4 的 1M —— 门控改用归一严格相等后, mini
    // key 不等于 gpt-5.4 → 不覆盖, 保留 272k。
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 2 },
        modelUsage: {
          'gpt-5.4-mini': { inputTokens: 10, outputTokens: 2, costUSD: 0, contextWindow: 272_000 },
        },
      },
      queue,
      {
        rt: newRuntimeState(),
        turn: createTurnState(),
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
        getModel: () => 'gpt-5.4', // 切到 base 模型后, 旧的 gpt-5.4-mini turn 才收口
        getEffort: () => 'high',
        getPermissionMode: () => 'auto',
        onSessionId: vi.fn(),
        getSdkSessionId: () => undefined,
        getLogTitle: () => undefined,
        tracker,
        getModelContextWindow: () => 1_000_000, // gpt-5.4 catalog window
      },
    );

    expect(tracker.snapshot().contextWindow).toBe(272_000);
  });

  it('matches SDK modelUsage keys that include the 1m suffix', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: { input_tokens: 10, output_tokens: 2 },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      {
        rt: newRuntimeState(),
        turn: createTurnState(),
        log: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        getModel: () => 'gpt-5.4',
        getEffort: () => 'high',
        getPermissionMode: () => 'auto',
        onSessionId: vi.fn(),
        getSdkSessionId: () => undefined,
        getLogTitle: () => undefined,
        tracker,
        getModelContextWindow: () => 1_000_000,
      },
    );

    expect(tracker.snapshot().contextWindow).toBe(1_000_000);
  });

  it('keeps result-only cache tokens in context usage', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 5,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      {
        rt: newRuntimeState(),
        turn: createTurnState(),
        log: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        getModel: () => 'gpt-5.4',
        getEffort: () => 'high',
        getPermissionMode: () => 'auto',
        onSessionId: vi.fn(),
        getSdkSessionId: () => undefined,
        getLogTitle: () => undefined,
        tracker,
        getModelContextWindow: () => 1_000_000,
      },
    );

    expect(tracker.snapshot().contextTokens).toBe(105);
  });

  it('uses result cache tokens for single-call turns even after message_start input usage', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = {
      rt: newRuntimeState(),
      turn: createTurnState(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      getModel: () => 'gpt-5.4',
      getEffort: () => 'high' as const,
      getPermissionMode: () => 'auto' as const,
      onSessionId: vi.fn(),
      getSdkSessionId: () => undefined,
      getLogTitle: () => undefined,
      tracker,
      getModelContextWindow: () => 1_000_000,
    };

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 10 },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 90,
          cache_creation_input_tokens: 5,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );

    expect(tracker.snapshot().contextTokens).toBe(105);
  });

  it('uses result cache tokens for single API calls even when message_delta also reports usage', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = {
      rt: newRuntimeState(),
      turn: createTurnState(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      getModel: () => 'gpt-5.4',
      getEffort: () => 'high' as const,
      getPermissionMode: () => 'auto' as const,
      onSessionId: vi.fn(),
      getSdkSessionId: () => undefined,
      getLogTitle: () => undefined,
      tracker,
      getModelContextWindow: () => 1_000_000,
    };

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 10 },
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
          usage: { output_tokens: 2 },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 90,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );

    expect(tracker.snapshot().contextTokens).toBe(100);
  });

  it('converts cumulative result usage into per-turn context usage', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = {
      rt: newRuntimeState(),
      turn: createTurnState(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      getModel: () => 'gpt-5.4',
      getEffort: () => 'high' as const,
      getPermissionMode: () => 'auto' as const,
      onSessionId: vi.fn(),
      getSdkSessionId: () => undefined,
      getLogTitle: () => undefined,
      tracker,
      getModelContextWindow: () => 1_000_000,
    };

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 10 },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_read_input_tokens: 90,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 10,
            outputTokens: 1,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );

    expect(tracker.snapshot().contextTokens).toBe(100);

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 20 },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 30,
          output_tokens: 2,
          cache_read_input_tokens: 170,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 30,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );

    expect(tracker.snapshot().contextTokens).toBe(100);
    expect(tracker.getCacheStats().session).toMatchObject({
      read: 170,
      uncachedInput: 30,
      apiCalls: 2,
    });
  });

  it('treats result usage after query rebuild as a fresh aggregate when baseline is reset', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = {
      rt: newRuntimeState(),
      turn: createTurnState(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      getModel: () => 'gpt-5.4',
      getEffort: () => 'high' as const,
      getPermissionMode: () => 'auto' as const,
      onSessionId: vi.fn(),
      getSdkSessionId: () => undefined,
      getLogTitle: () => undefined,
      tracker,
      getModelContextWindow: () => 1_000_000,
    };

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 100 },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_read_input_tokens: 200,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 100,
            outputTokens: 1,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );
    expect(tracker.snapshot().contextTokens).toBe(300);

    ctx.rt.lastResultUsageAggregate = null;

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 120 },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 120,
          output_tokens: 1,
          cache_read_input_tokens: 220,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 120,
            outputTokens: 1,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );

    expect(tracker.snapshot().contextTokens).toBe(340);
  });

  it('preserves message_start cache tokens when result usage omits cache fields', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = {
      rt: newRuntimeState(),
      turn: createTurnState(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      getModel: () => 'gpt-5.4',
      getEffort: () => 'high' as const,
      getPermissionMode: () => 'auto' as const,
      onSessionId: vi.fn(),
      getSdkSessionId: () => undefined,
      getLogTitle: () => undefined,
      tracker,
      getModelContextWindow: () => 1_000_000,
    };

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 90,
            },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 10,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );

    expect(tracker.snapshot().contextTokens).toBe(100);
  });

  it('uses result cache tokens after aborted turn state is reset before the next turn', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const turn = createTurnState();
    const ctx = {
      rt: newRuntimeState(),
      turn,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      getModel: () => 'gpt-5.4',
      getEffort: () => 'high' as const,
      getPermissionMode: () => 'auto' as const,
      onSessionId: vi.fn(),
      getSdkSessionId: () => undefined,
      getLogTitle: () => undefined,
      tracker,
      getModelContextWindow: () => 1_000_000,
    };

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 10 },
          },
        },
      },
      queue,
      ctx,
    );

    tracker.beginTurn();
    turn.text = '';
    turn.toolUses = 0;
    turn.apiCalls = 0;
    turn.sawCompactBoundary = false;
    turn.hasEmittedText = false;
    turn.uiEmittedText = '';

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 20 },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 20,
          output_tokens: 2,
          cache_read_input_tokens: 80,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 20,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );

    expect(tracker.snapshot().contextTokens).toBe(100);
  });

  it('does not replace previous context usage when result arrives without an API call', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({
      inputTokens: 100,
      outputTokens: 1,
      cacheReadTokens: 200,
      cacheCreateTokens: 0,
    });
    const queue = createAsyncQueue<AgentEvent>();

    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 0,
            outputTokens: 0,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      {
        rt: newRuntimeState(),
        turn: createTurnState(),
        log: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        },
        getModel: () => 'gpt-5.4',
        getEffort: () => 'high',
        getPermissionMode: () => 'auto',
        onSessionId: vi.fn(),
        getSdkSessionId: () => undefined,
        getLogTitle: () => undefined,
        tracker,
        getModelContextWindow: () => 1_000_000,
      },
    );

    expect(tracker.snapshot().contextTokens).toBe(300);
  });

  it('preserves compacted context tokens when final result usage arrives after compact_boundary', () => {
    const tracker = new UsageTracker();
    const queue = createAsyncQueue<AgentEvent>();
    const ctx = {
      rt: newRuntimeState(),
      turn: createTurnState(),
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
      getModel: () => 'gpt-5.4',
      getEffort: () => 'high' as const,
      getPermissionMode: () => 'auto' as const,
      onSessionId: vi.fn(),
      getSdkSessionId: () => undefined,
      getLogTitle: () => undefined,
      tracker,
      getModelContextWindow: () => 1_000_000,
    };

    translateSdkMessage(
      {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: {
            model: 'gpt-5.4[1m]',
            usage: { input_tokens: 200_000 },
          },
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: {
          trigger: 'auto',
          pre_tokens: 200_000,
          post_tokens: 20_000,
          duration_ms: 100,
        },
      },
      queue,
      ctx,
    );
    translateSdkMessage(
      {
        type: 'result',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          input_tokens: 200_000,
          output_tokens: 2,
        },
        modelUsage: {
          'gpt-5.4[1m]': {
            inputTokens: 200_000,
            outputTokens: 2,
            costUSD: 0,
            contextWindow: 1_000_000,
          },
        },
      },
      queue,
      ctx,
    );

    expect(tracker.snapshot().contextTokens).toBe(20_000);
  });
});
