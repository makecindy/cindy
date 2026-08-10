import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';

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

    expect(bridge.getTaskUsage('agent-a')).toEqual({
      totalTokens: 185,
      inputTokens: 170,
      outputTokens: 15,
      cacheReadTokens: 20,
      cacheCreateTokens: 0,
    });
    expect(bridge.getTaskUsage('agent-b')).toEqual({
      totalTokens: 230,
      inputTokens: 200,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
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

    expect(bridge.getTaskUsage('agent-a')).toEqual({
      totalTokens: 110,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
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
    expect(bridge.getTaskUsage('agent-inflight')).toEqual({
      totalTokens: 110,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
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

    expect(bridge.getTaskUsage('agent-inflight')).toEqual({
      totalTokens: 110,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
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
    expect(bridge.getTaskUsage('agent-streaming')).toEqual({
      totalTokens: 110,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
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

    expect(bridge.getTaskUsage('agent-a')).toEqual({
      totalTokens: 110,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    expect(bridge.getTaskUsage('agent-b')).toEqual({
      totalTokens: 220,
      inputTokens: 200,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
  });
});
