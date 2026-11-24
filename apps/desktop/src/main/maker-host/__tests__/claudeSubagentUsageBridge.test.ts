import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createAsyncQueue } from '../../../../../../packages/maker-core/src/agents/shared/async-queue.js';
import { UsageTracker } from '../../../../../../packages/maker-core/src/agents/shared/usage-tracker.js';
import { translateSdkMessage, newRuntimeState, type TurnState } from '../../../../../../packages/maker-core/src/agents/claude-code/translator.js';
import { type AgentEvent } from '../../../../../../packages/maker-core/src/types/events.js';
import { normalizeTurnUsageSegments, resolveClaudeTurnCostSinks } from '../../usage/turnCostCalculator.js';


import {
  ClaudeSubagentUsageBridge,
  createClaudeSubagentUsageRequestTransform,
  createClaudeSubagentUsageResponseObserver,
} from '../claude-subagent-usage-bridge.js';

function requestPayload(model: string, prompt: string): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'user', content: '<system-reminder>context</system-reminder>' },
      { role: 'user', content: prompt },
    ],
  };
}

function requestBody(model: string, prompt: string): Buffer {
  return Buffer.from(JSON.stringify(requestPayload(model, prompt)));
}

function reserveRequest(
  bridge: ClaudeSubagentUsageBridge,
  reqId: number,
  model: string,
  prompt: string,
): void {
  const transform = createClaudeSubagentUsageRequestTransform(bridge);
  expect(transform(requestPayload(model, prompt), {
    reqId,
    method: 'POST',
    url: '/v1/messages',
    headers: {},
  })).toBeNull();
}

function sse(inputTokens: number, outputTokens: number, cacheReadTokens = 0): Buffer {
  const frames = [
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: inputTokens,
          cache_read_input_tokens: cacheReadTokens,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
    { type: 'message_delta', usage: { input_tokens: 0, output_tokens: outputTokens } },
    { type: 'message_stop' },
  ];
  return Buffer.from(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
}

function openObservation(
  bridge: ClaudeSubagentUsageBridge,
  reqId: number,
  model: string,
  prompt: string,
) {
  const observer = createClaudeSubagentUsageResponseObserver(bridge);
  const sink = observer({
    reqId,
    method: 'POST',
    url: '/v1/messages',
    upstreamBase: 'https://example.com',
    status: 200,
    requestHeaders: {},
    responseHeaders: { 'content-type': 'text/event-stream' },
    requestBody: requestBody(model, prompt),
  });
  expect(sink).toBeTruthy();
  return sink;
}

function observe(
  bridge: ClaudeSubagentUsageBridge,
  reqId: number,
  model: string,
  prompt: string,
  response: Buffer,
): void {
  reserveRequest(bridge, reqId, model, prompt);
  const sink = openObservation(bridge, reqId, model, prompt);
  sink?.onData?.(response);
  sink?.onEnd?.();
}

describe('ClaudeSubagentUsageBridge', () => {
  it('attributes concurrent responses by prompt and uses latest input plus cumulative output', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-a',
      parentToolUseId: 'toolu-a',
      prompt: 'Solve calculator problem A',
      model: 'codex/gpt-5.6-terra',
    });
    bridge.registerTask({
      taskId: 'agent-b',
      parentToolUseId: 'toolu-b',
      prompt: 'Solve calculator problem B',
      model: 'codex/gpt-5.6-terra',
    });

    observe(bridge, 1, 'codex/gpt-5.6-terra', 'Solve calculator problem A', sse(100, 10, 20));
    observe(bridge, 2, 'codex/gpt-5.6-terra', 'Solve calculator problem B', sse(200, 30));
    observe(bridge, 3, 'codex/gpt-5.6-terra', 'Solve calculator problem A', sse(150, 5, 20));

    expect(bridge.getTaskUsage('agent-a')).toEqual({ totalTokens: 185 });
    expect(bridge.getTaskUsage('agent-b')).toEqual({ totalTokens: 230 });
  });

  it('does not observe unrelated parent-agent requests', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-a',
      parentToolUseId: 'toolu-a',
      prompt: 'Solve calculator problem A',
      model: 'codex/gpt-5.6-terra',
    });
    reserveRequest(bridge, 1, 'claude-opus-4-6', 'Parent prompt');
    const observer = createClaudeSubagentUsageResponseObserver(bridge);
    const sink = observer({
      reqId: 1,
      method: 'POST',
      url: '/v1/messages',
      upstreamBase: 'https://example.com',
      status: 200,
      requestHeaders: {},
      responseHeaders: { 'content-type': 'text/event-stream' },
      requestBody: requestBody('claude-opus-4-6', 'Parent prompt'),
    });

    expect(sink).toBeNull();
    expect(bridge.getTaskUsage('agent-a')).toBeUndefined();
  });

  it('keeps the request reservation through a recoverable non-2xx response', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-a',
      parentToolUseId: 'toolu-a',
      prompt: 'Solve calculator problem A',
      model: 'codex/gpt-5.6-terra',
    });
    reserveRequest(bridge, 1, 'codex/gpt-5.6-terra', 'Solve calculator problem A');

    const observer = createClaudeSubagentUsageResponseObserver(bridge);
    const context = {
      reqId: 1,
      method: 'POST',
      url: '/v1/messages',
      upstreamBase: 'https://example.com',
      requestHeaders: {},
      requestBody: requestBody('codex/gpt-5.6-terra', 'Solve calculator problem A'),
    } as const;
    expect(observer({
      ...context,
      status: 400,
      responseHeaders: { 'content-type': 'application/json' },
    })).toBeNull();

    const sink = observer({
      ...context,
      status: 200,
      responseHeaders: { 'content-type': 'text/event-stream' },
    });
    expect(sink).toBeTruthy();
    sink?.onData?.(sse(100, 10));
    sink?.onEnd?.();

    expect(bridge.getTaskUsage('agent-a')).toEqual({ totalTokens: 110 });
  });

  it('does not evict a task reserved by an in-flight response at the tracking limit', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-inflight',
      parentToolUseId: 'toolu-inflight',
      prompt: 'Solve the slow calculator problem',
      model: 'codex/gpt-5.6-terra',
    });
    reserveRequest(bridge, 1, 'codex/gpt-5.6-terra', 'Solve the slow calculator problem');
    const sink = openObservation(
      bridge,
      1,
      'codex/gpt-5.6-terra',
      'Solve the slow calculator problem',
    );

    for (let index = 0; index < 205; index += 1) {
      bridge.registerTask({
        taskId: `agent-${index}`,
        parentToolUseId: `toolu-${index}`,
        prompt: `Solve calculator problem ${index}`,
        model: 'codex/gpt-5.6-terra',
      });
    }

    sink?.onData?.(sse(100, 10));
    sink?.onEnd?.();
    expect(bridge.getTaskUsage('agent-inflight')).toEqual({ totalTokens: 110 });
  });

  it('rejects reservation overflow without dropping protection for older in-flight responses', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-inflight',
      parentToolUseId: 'toolu-inflight',
      prompt: 'Solve the long-running calculator problem',
      model: 'codex/gpt-5.6-terra',
    });
    const payload = requestPayload(
      'codex/gpt-5.6-terra',
      'Solve the long-running calculator problem',
    );

    for (let reqId = 1; reqId <= 1_000; reqId += 1) {
      expect(bridge.reserveRequest(reqId, payload)).toBe('agent-inflight');
    }
    expect(bridge.reserveRequest(1_001, payload)).toBeNull();

    for (let index = 0; index < 205; index += 1) {
      bridge.registerTask({
        taskId: `agent-overflow-${index}`,
        parentToolUseId: `toolu-overflow-${index}`,
        prompt: `Solve overflow calculator problem ${index}`,
        model: 'codex/gpt-5.6-terra',
      });
    }

    const oldest = openObservation(
      bridge,
      1,
      'codex/gpt-5.6-terra',
      'Solve the long-running calculator problem',
    );
    oldest?.onData?.(sse(100, 10));
    oldest?.onEnd?.();

    expect(bridge.getTaskUsage('agent-inflight')).toEqual({ totalTokens: 110 });
    expect(bridge.reserveRequest(1_001, payload)).toBe('agent-inflight');
  });

  it('moves active streaming responses out of the pending cap while keeping their task protected', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-streaming',
      parentToolUseId: 'toolu-streaming',
      prompt: 'Solve the streaming calculator problem',
      model: 'codex/gpt-5.6-terra',
    });
    const payload = requestPayload(
      'codex/gpt-5.6-terra',
      'Solve the streaming calculator problem',
    );
    const sinks: Array<ReturnType<typeof openObservation>> = [];

    for (let reqId = 1; reqId <= 1_001; reqId += 1) {
      expect(bridge.reserveRequest(reqId, payload)).toBe('agent-streaming');
      sinks.push(
        openObservation(
          bridge,
          reqId,
          'codex/gpt-5.6-terra',
          'Solve the streaming calculator problem',
        ),
      );
    }

    for (let index = 0; index < 205; index += 1) {
      bridge.registerTask({
        taskId: `agent-stream-pressure-${index}`,
        parentToolUseId: `toolu-stream-pressure-${index}`,
        prompt: `Solve stream pressure problem ${index}`,
        model: 'codex/gpt-5.6-terra',
      });
    }

    sinks[0]?.onData?.(sse(100, 10));
    sinks[0]?.onEnd?.();
    expect(bridge.getTaskUsage('agent-streaming')).toEqual({ totalTokens: 110 });
  });

  it('prefers the longest matching prompt when prompts overlap', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    bridge.registerTask({
      taskId: 'agent-short',
      parentToolUseId: 'toolu-short',
      prompt: '修复认证问题',
      model: 'codex/gpt-5.6-terra',
    });
    bridge.registerTask({
      taskId: 'agent-long',
      parentToolUseId: 'toolu-long',
      prompt: '修复认证问题并补测试',
      model: 'codex/gpt-5.6-terra',
    });

    expect(bridge.reserveRequest(1, {
      model: 'codex/gpt-5.6-terra',
      messages: [{ role: 'user', content: '修复认证问题并补测试' }],
    })).toBe('agent-long');
  });

  it('keeps identical prompt tasks bound to request ids when responses arrive out of order', () => {
    const bridge = new ClaudeSubagentUsageBridge();
    for (const suffix of ['a', 'b']) {
      bridge.registerTask({
        taskId: `agent-${suffix}`,
        parentToolUseId: `toolu-${suffix}`,
        prompt: 'Solve the same calculator problem',
        model: 'codex/gpt-5.6-terra',
      });
    }

    reserveRequest(bridge, 1, 'codex/gpt-5.6-terra', 'Solve the same calculator problem');
    reserveRequest(bridge, 2, 'codex/gpt-5.6-terra', 'Solve the same calculator problem');

    const second = openObservation(
      bridge,
      2,
      'codex/gpt-5.6-terra',
      'Solve the same calculator problem',
    );
    second?.onData?.(sse(200, 20));
    second?.onEnd?.();
    const first = openObservation(
      bridge,
      1,
      'codex/gpt-5.6-terra',
      'Solve the same calculator problem',
    );
    first?.onData?.(sse(100, 10));
    first?.onEnd?.();

    expect(bridge.getTaskUsage('agent-a')).toEqual({ totalTokens: 110 });
    expect(bridge.getTaskUsage('agent-b')).toEqual({ totalTokens: 220 });
  });
});

function billingFixture() {
  const bridge = new ClaudeSubagentUsageBridge();
  const queue = createAsyncQueue<AgentEvent>();
  const sdkSessionId = 'sdk-session';
  const turn: TurnState = {
    text: '', toolUses: 0, apiCalls: 0, sawCompactBoundary: false, hasEmittedText: false,
    uiEmittedText: '', pendingApiError: null, interruptRequested: false, generation: 0,
    interruptGeneration: 0, lastAssistantMsgHadSubstance: true,
  };
  const ctx = {
    rt: newRuntimeState(), turn, tracker: new UsageTracker(),
    getModel: () => 'main-model', getSdkSessionId: () => sdkSessionId,
    getEffort: () => 'medium', getPermissionMode: () => 'auto', getLogTitle: () => undefined,
    log: { debug() {}, info() {}, warn() {} }, onSessionId() {},
    onSubagentTaskLaunched: (task: Parameters<typeof bridge.registerTask>[0]) =>
      bridge.registerTask(task),
    getSubagentTaskUsage: (id: string, sid?: string) => bridge.getTaskUsage(id, sid),
  };
  return { bridge, queue, sdkSessionId, ctx };
}

const cacheCases = [
  { name: 'missing read bucket, late 300k', start: { cache_creation_input_tokens: 0 }, aggregate: { cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 }, expected: null },
  { name: 'missing write bucket, late 300k', start: { cache_read_input_tokens: 0 }, aggregate: { cache_read_input_tokens: 0, cache_creation_input_tokens: 300_000 }, expected: null },
  { name: 'independent zero buckets', start: {}, aggregate: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, expected: 0.002 },
  { name: 'neither source reports cache', start: {}, aggregate: {}, expected: null },
  { name: 'SDK confirms 300k', start: {}, aggregate: {}, expected: 0.302 },
  { name: 'SDK observes 300k, aggregate agrees', start: {}, aggregate: { cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 }, expected: 0.302 },
  { name: 'unknown prior cache baseline', start: { cache_read_input_tokens: 300_000 }, aggregate: { cache_read_input_tokens: 300_000, cache_creation_input_tokens: 0 }, expected: null },
  { name: 'explicit zero buckets', start: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, aggregate: {}, expected: 0.002 },
] as const;

it.each([
  ...Object.entries({
    proxy: 0.0027, 'sdk-and-proxy': 0.0027, legacy: null, truncated: null, 'foreign-session': null,
    untagged: null, 'late-launch': null, 'early-response': 0.0027, 'middle-delta': 0.304,
    'same-response-cycles': 0.3027, 'truncated-second-cycle': null, 'malformed-next-cycle': null, 'reused-request-id': 0.0074,
    'resumed-agent': 0.0054, 'ambiguous-resume': 0.0027, 'restarted-stream': 0.0027, 'restart-without-output': null,
  }).map(([mode, expected]) => ({ mode, name: mode, cache: undefined, expected })),
  ...cacheCases.map(cache => ({ mode: 'proxy', name: cache.name, cache, expected: cache.expected })),
])('prices the main model and only identifiable completed background requests ($name)',
  async ({ mode, cache, expected }) => {
    const { bridge, queue, sdkSessionId, ctx } = billingFixture();
    const model = 'child-model';
    const prompt = 'Count the blue flowers';
    bridge.registerTask({ taskId: 'finished-task', parentToolUseId: 'older-tool', prompt, model });
    const usage = { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const childUsage = cache ? { input_tokens: 100, output_tokens: 10, ...cache.start } : {
      ...usage, cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
    };
    const splitResponse = mode === 'same-response-cycles' || mode === 'truncated-second-cycle';
    const repeatedId = mode === 'reused-request-id';
    const resumed = mode === 'resumed-agent' || mode === 'ambiguous-resume';
    const middleUsage = {
      input_tokens: 150, output_tokens: 12, cache_read_input_tokens: 300_000, cache_creation_input_tokens: 80,
      cache_creation: { ephemeral_1h_input_tokens: 40 },
    };
    const emit = (msg: Parameters<typeof translateSdkMessage>[0]) => translateSdkMessage(msg, queue, ctx);
    function sdkRequest(id: string, model: string, parent?: string, sdkUsage = cache?.name.startsWith('SDK ')
      ? { ...usage, cache_read_input_tokens: 300_000 } : childUsage) {
      emit({ type: 'stream_event', parent_tool_use_id: parent, event: {
        type: 'message_start', message: { id, model, usage: parent ? sdkUsage : usage },
      } });
      if (parent && resumed) return;
      for (const event of [
        ...(parent && mode === 'middle-delta' ? [{ type: 'message_delta', usage: { cache_read_input_tokens: 300_000 } }] : []),
        { type: 'message_delta', usage: parent ? (cache?.name === 'SDK confirms 300k' ? sdkUsage : { output_tokens: sdkUsage.output_tokens }) : usage }, { type: 'message_stop' },
      ]) emit({ type: 'stream_event', parent_tool_use_id: parent, event });
    }
    if (cache?.name === 'unknown prior cache baseline') {
      emit({ type: 'result', result: 'previous turn', usage: { input_tokens: 20, output_tokens: 5 } });
    }
    sdkRequest('msg-main', 'main-model');
    if (mode !== 'late-launch') {
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-a', name: 'Agent', input: { prompt } }] } });
    }
    const launch = (parent = 'tool-a') => emit({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: parent, content: 'launched' }] },
      tool_use_result: { isAsync: true, agentId: 'agent-a', resolvedModel: model, prompt },
    });
    if (mode !== 'early-response') launch();
    if (mode === 'sdk-and-proxy' || mode === 'middle-delta' || cache?.name.startsWith('SDK ')) sdkRequest('msg-child', model, 'tool-a');
    if (mode === 'sdk-and-proxy') {
      // A second SDK block shares this provider request with the first block and both proxy receipts.
      sdkRequest('msg-child', model, 'tool-a');
    }
    if (mode === 'same-response-cycles') {
      sdkRequest('msg-child', model, 'tool-a', { ...childUsage, cache_read_input_tokens: 300_000 });
    }
    if (repeatedId) {
      sdkRequest('msg-child', model, 'tool-a');
      emit({ type: 'user', parent_tool_use_id: 'tool-a', message: { content: [
        { type: 'tool_result', tool_use_id: 'inner-tool', content: 'ok' },
      ] } });
      sdkRequest('msg-child', model, 'tool-a', { ...childUsage, input_tokens: 200, output_tokens: 20 });
    }
    if (resumed) {
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-b', name: 'Agent', input: { prompt } }] } });
      launch('tool-b');
      sdkRequest('msg-child', model, 'tool-a');
      if (mode === 'resumed-agent') sdkRequest('msg-resumed', model, 'tool-b');
    }
    if (mode !== 'legacy') {
      const transform = createClaudeSubagentUsageRequestTransform(bridge);
      for (const reqId of resumed ? [3, 1, 4, 2] : [1, 2]) {
        transform(requestPayload(model, prompt), {
          reqId, method: 'POST', url: '/v1/messages',
          headers: {
            'x-claude-code-session-id': mode === 'foreign-session' ? 'foreign' : sdkSessionId,
            ...(mode === 'untagged' ? {} : { 'x-claude-code-agent-id': 'agent-a' }),
          },
        });
        const sink = createClaudeSubagentUsageResponseObserver(bridge)({
          reqId, method: 'POST', url: '/v1/messages', upstreamBase: 'https://example.test', status: 200,
          requestHeaders: {}, responseHeaders: { 'content-type': 'text/event-stream' },
          requestBody: requestBody(model, prompt),
        });
        const secondRequest = repeatedId && reqId === 2;
        const frames = [
          ...(splitResponse ? [
            { type: 'message_start', message: { id: 'msg-child', model, usage: { ...usage, output_tokens: 0 } } },
            { type: 'message_delta', usage: { output_tokens: 0 } }, { type: 'message_stop' },
          ] : []),
          ...(['restarted-stream', 'restart-without-output'].includes(mode) ? [
            { type: 'message_start', message: { id: 'abandoned', model, usage } },
            { type: 'message_delta', usage: middleUsage },
          ] : []),
          { type: 'message_start', message: { id: reqId > 2 ? 'msg-resumed' : 'msg-child', model, usage: {
            ...childUsage, ...(splitResponse ? { cache_read_input_tokens: 300_000 } : {}),
            input_tokens: splitResponse ? undefined : secondRequest ? 200 : 100, output_tokens: 0,
          } } },
          ...(mode === 'middle-delta' ? [{ type: 'message_delta', usage: middleUsage }] : []),
          { type: 'message_delta', usage: {
            ...(mode === 'restart-without-output' ? {} : { output_tokens: secondRequest ? 20 : 10 }),
            ...(!cache ? { cache_creation: mode === 'sdk-and-proxy' ? { ephemeral_1h_input_tokens: 0 } : { ephemeral_5m_input_tokens: 20 } } : {}),
          } },
          ...(mode === 'truncated' || mode === 'truncated-second-cycle' ? [] : [{ type: 'message_stop' }]),
        ];
        sink?.onData?.(Buffer.from(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')));
        const tail = mode === 'malformed-next-cycle' ? 'data: {"type":"message_start"' : ': keepalive\n\ndata: [DONE]\n\n';
        sink?.onData?.(Buffer.from(tail));
        sink?.onEnd?.();
      }
    }
    if (mode === 'early-response') {
      emit({ type: 'system', subtype: 'task_notification', status: 'completed', task_id: 'agent-a', tool_use_id: 'tool-a' });
      launch();
    }
    const childInput = repeatedId ? 300 : mode === 'middle-delta' ? 150 : resumed ? 200 : 100;
    const childOutput = repeatedId ? 30 : mode === 'middle-delta' ? 12 : resumed ? 20 : 10;
    const reportedCache: { cache_read_input_tokens?: number; cache_creation_input_tokens?: number } = cache?.aggregate ?? {
      cache_read_input_tokens: splitResponse || mode === 'middle-delta' ? 300_000 : 0,
      cache_creation_input_tokens: mode === 'middle-delta' ? 80 : resumed || repeatedId ? 100 : 50,
    };
    const priorTurn = cache?.name === 'unknown prior cache baseline';
    emit({ type: 'result', result: 'done', usage: { input_tokens: childInput + (priorTurn ? 120 : 100), output_tokens: childOutput + (priorTurn ? 15 : 10), ...reportedCache } });
    queue.end();
    let segments = normalizeTurnUsageSegments([]);
    let complete = false;
    for await (const event of queue) {
      if (event.type !== 'done') continue;
      const done = event.data as { usageSegments?: unknown; usageSegmentsComplete?: boolean };
      segments = normalizeTurnUsageSegments(done.usageSegments);
      complete = done.usageSegmentsComplete === true;
    }
    const childSegment = segments.find(segment => segment.model === model);
    if (mode === 'sdk-and-proxy') {
      const childSegments = segments.filter(segment => segment.model === model);
      expect(childSegments).toHaveLength(1);
      expect(childSegments[0]).toMatchObject({ complete: true, cacheCreate1hTokens: 30 });
    }
    if (mode === 'same-response-cycles') expect(childSegment).toMatchObject({ cacheReadTokens: 300_000, outputTokens: 10, complete: true });
    if (mode === 'truncated-second-cycle' || mode === 'malformed-next-cycle') expect(childSegment).toBeUndefined();
    if (repeatedId) {
      expect(segments.filter(s => s.model === model).map(s => [s.inputTokens, s.outputTokens])).toEqual([[100, 10], [200, 20]]);
      expect(complete).toBe(true);
    }
    if (mode === 'restarted-stream') expect(childSegment?.outputTokens).toBe(10);
    if (mode === 'restart-without-output') expect(childSegment).toBeUndefined();
    if (mode === 'middle-delta') {
      expect(childSegment).toMatchObject({
        inputTokens: 150, outputTokens: 12, cacheReadTokens: 300_000, cacheCreateTokens: 80, cacheCreate1hTokens: 40,
      });
    }
    if (resumed) {
      expect(segments.filter(segment => segment.model === model).map(segment => [segment.id?.split(':').at(-1), segment.complete])).toEqual(
        mode === 'resumed-agent' ? [['tool-a', true], ['tool-b', true]] : [['tool-a', true]],
      );
    }
    const models = ['main-model', model];
    const { perModel } = resolveClaudeTurnCostSinks(models.map(model => ({
      model, inputTokensDelta: model === 'child-model' ? childInput : 100, outputTokensDelta: model === 'child-model' ? childOutput : 10, cacheReadTokensDelta: model === 'child-model' ? reportedCache.cache_read_input_tokens ?? 0 : 0,
      cacheCreateTokensDelta: model === 'child-model' ? reportedCache.cache_creation_input_tokens ?? 0 : 0, costUsdDelta: 0,
    })), { supplier: Object.fromEntries(models.map((modelId, index) => [modelId, {
      modelId, providerId: 'supplier', source: 'user-override', currency: 'USD', approximate: true,
      inputPerMtok: 10 * (index + 1), outputPerMtok: 0, cacheReadPerMtok: 1, cacheCreatePerMtok: 5, cacheCreate1hPerMtok: 20,
    }])) }, { providerId: 'supplier', billingRoute: 'provider-api', region: 'global' }, segments, complete);
    expect(perModel.map(row => [row.model, row.money?.amount ?? null])).toEqual([
      ['main-model', 0.001], [model, expected], ...(mode === 'ambiguous-resume' ? [[model, null]] : []),
    ]);
  },
);

it.each(['fresh', 'stale-only', 'late-finish', 'previous-parent', 'reused-id', 'previous-parent-sdk-id', 'unregistered-id', 'same-turn-overlap'])(
  'charges a resumed background task only for requests belonging to its current invocation (%s)',
  async mode => {
    const { bridge, queue, sdkSessionId, ctx } = billingFixture();
    const model = 'child-model';
    const prompt = 'Count flowers';
    const usage = { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const emit = (msg: Parameters<typeof translateSdkMessage>[0]) => translateSdkMessage(msg, queue, ctx);
    const launch = (parent: string, beforeLaunchReceipt?: () => void) => {
      emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: parent, input: { prompt } }] } });
      beforeLaunchReceipt?.();
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: parent, content: 'launched' }] },
        tool_use_result: { isAsync: true, agentId: 'agent-a', resolvedModel: model, prompt: mode === 'unregistered-id' ? undefined : prompt } });
    };
    const reserve = (reqId: number, id: string, input = 100) => {
      createClaudeSubagentUsageRequestTransform(bridge)(requestPayload(model, prompt), {
        reqId, method: 'POST', url: '/v1/messages',
        headers: { 'x-claude-code-session-id': sdkSessionId, 'x-claude-code-agent-id': 'agent-a' },
      });
      const sink = openObservation(bridge, reqId, model, prompt);
      return () => {
        const frames = [
          { type: 'message_start', message: { id, model, usage: { ...usage, input_tokens: input } } },
          { type: 'message_delta', usage: { output_tokens: input / 10 } }, { type: 'message_stop' },
        ];
        sink?.onData?.(Buffer.from(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('')));
        sink?.onEnd?.();
      };
    };
    const settle = (requests: number) => {
      emit({ type: 'result', result: 'done', usage: { ...usage, input_tokens: 100 * requests, output_tokens: 10 * requests } });
      ctx.turn.generation++;
      ctx.tracker.beginTurn();
    };
    launch('first-parent');
    settle(0);

    // The existing task continues without an Agent/Task call in turn two.
    const finishOld = reserve(1, 'old');
    if (mode !== 'late-finish') finishOld();
    for (const event of [
      { type: 'message_start', message: { id: 'old', model, usage } },
      { type: 'message_delta', usage }, { type: 'message_stop' },
    ]) emit({ type: 'stream_event', parent_tool_use_id: 'first-parent', event });
    settle(1);

    const overlappingSdkId = mode === 'previous-parent-sdk-id' || mode === 'same-turn-overlap';
    if (mode === 'same-turn-overlap') launch('earlier-current-parent');
    launch('new-parent', () => {
      if (mode === 'unregistered-id') reserve(2, 'old', 200)();
      if (mode === 'previous-parent' || overlappingSdkId) reserve(2, 'still-running')();
    });
    if (mode === 'late-finish') finishOld();
    if (mode === 'fresh' || mode === 'reused-id') reserve(2, mode === 'reused-id' ? 'old' : 'fresh', mode === 'reused-id' ? 200 : 100)();
    const currentInput = (overlappingSdkId || mode === 'reused-id' || mode === 'unregistered-id') ? 200 : 100;
    if (mode === 'unregistered-id') {
      emit({ type: 'stream_event', parent_tool_use_id: 'new-parent', event: {
        type: 'message_start', message: { id: 'old', model, usage: { input_tokens: 200 } },
      } });
    }
    if (overlappingSdkId) {
      for (const event of [
        { type: 'message_start', message: { id: 'still-running', model, usage: { ...usage, input_tokens: 200 } } },
        { type: 'message_delta', usage: { output_tokens: 20 } }, { type: 'message_stop' },
      ]) emit({ type: 'stream_event', parent_tool_use_id: 'new-parent', event });
    }
    settle(1 + currentInput / 100);
    queue.end();

    const charges: Array<{ ids: Array<string | undefined>; amount: number | null }> = [];
    for await (const event of queue) {
      if (event.type !== 'done') continue;
      const done = event.data as { usageSegments?: unknown; usageSegmentsComplete?: boolean };
      const segments = normalizeTurnUsageSegments(done.usageSegments);
      if (charges.length === 2 && overlappingSdkId) {
        expect(segments).toMatchObject([{ inputTokens: 200, outputTokens: 20, complete: false }]);
      }
      const delta = charges.length === 2 ? currentInput : charges.length ? 100 : 0;
      const { perModel } = resolveClaudeTurnCostSinks([{
        model, inputTokensDelta: delta, outputTokensDelta: delta / 10,
        cacheReadTokensDelta: 0, cacheCreateTokensDelta: 0, costUsdDelta: 0,
      }], { supplier: { [model]: {
        modelId: model, providerId: 'supplier', source: 'user-override', currency: 'USD', approximate: true,
        inputPerMtok: 20, outputPerMtok: 0,
      } } }, { providerId: 'supplier', billingRoute: 'provider-api', region: 'global' }, segments, done.usageSegmentsComplete);
      charges.push({ ids: segments.map(s => s.id), amount: perModel[0]?.money?.amount ?? null });
    }
    expect(charges).toHaveLength(3);
    expect(charges[1]?.amount).toBe(0.002);
    if (overlappingSdkId || mode === 'unregistered-id') {
      expect(charges[2]?.amount).toBe(0.004);
      expect(charges[2]?.ids).toEqual([expect.stringMatching(/^claude:\d+:new-parent$/)]);
      return;
    }
    const fresh = mode === 'fresh' || mode === 'reused-id';
    expect(charges[2]?.amount).toBe(mode === 'reused-id' ? 0.004 : fresh ? 0.002 : null);
    expect(charges[2]?.ids).toEqual(fresh ? [`claude:proxy/${mode === 'reused-id' ? 'old' : 'fresh'}:new-parent`] : []);
  },
);

it('retains an accepted billing receipt when the card registry evicts its task', () => {
  const bridge = new ClaudeSubagentUsageBridge();
  const sdkSessionId = 'sdk';
  for (let reqId = 1; reqId <= 201; reqId++) {
    const taskId = `task-${reqId}`;
    bridge.registerTask({ taskId, parentToolUseId: `tool-${reqId}`, prompt: 'count' });
    bridge.reserveRequest(reqId, requestPayload('child', 'count'), sdkSessionId, taskId);
    const sink = createClaudeSubagentUsageResponseObserver(bridge)({
      reqId, method: 'POST', url: '/v1/messages', upstreamBase: 'https://example.test',
      status: 200, requestHeaders: {}, responseHeaders: { 'content-type': 'application/json' },
      requestBody: requestBody('child', 'count'),
    });
    sink?.onData?.(Buffer.from(JSON.stringify({
      id: `msg-${reqId}`, model: 'child', usage: { input_tokens: 3, output_tokens: 1 },
    })));
    sink?.onEnd?.();
  }
  expect(bridge.getTaskUsage('task-1', sdkSessionId)?.billing?.segments).toMatchObject([
    { id: 'msg-1', inputTokens: 3, outputTokens: 1 },
  ]);
  expect(bridge.getTaskUsage('task-1', sdkSessionId)?.billing).toBeUndefined();
});
