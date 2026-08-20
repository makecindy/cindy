import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../types/events.js';
import { createAsyncQueue } from '../shared/async-queue.js';
import {
  beginTrueForgeTurn,
  createTrueForgeTranslateState,
  finishTrueForgeTurn,
  rememberToolCalls,
  translateTrueForgeEvent,
} from './translator.js';

async function drain(
  queue: ReturnType<typeof createAsyncQueue<AgentEvent>>,
): Promise<AgentEvent[]> {
  queue.end();
  const events: AgentEvent[] = [];
  for await (const event of queue) events.push(event);
  return events;
}

describe('TrueForge event translation', () => {
  it('preserves text, assembled tool metadata, and exact continuation usage', async () => {
    const queue = createAsyncQueue<AgentEvent>();
    const state = createTrueForgeTranslateState(128_000);
    beginTrueForgeTurn(state);

    translateTrueForgeEvent({ type: 'turn.created' }, queue, state);
    translateTrueForgeEvent({ type: 'model.message.delta', content: 'Hello ' }, queue, state);
    translateTrueForgeEvent({ type: 'model.message.delta', content: 'world' }, queue, state);
    rememberToolCalls(state, [
      {
        id: 'call-1',
        function: { name: 'lookup', arguments: '{"query":"complete"}' },
      },
    ]);
    translateTrueForgeEvent(
      {
        type: 'model.message.delta',
        toolCalls: [{ id: 'call-1', function: { name: 'lookup', arguments: '}' } }],
      },
      queue,
      state,
    );
    translateTrueForgeEvent(
      {
        type: 'tool.response',
        toolCallId: 'call-1',
        content: 'result',
      },
      queue,
      state,
    );
    translateTrueForgeEvent(
      {
        type: 'turn.done',
        state: {
          metrics: {
            totalInputTokens: 10,
            totalOutputTokens: 4,
            totalTokens: 14,
          },
        },
      },
      queue,
      state,
    );
    translateTrueForgeEvent(
      {
        type: 'turn.done',
        state: {
          metrics: {
            totalInputTokens: 12,
            totalOutputTokens: 3,
            totalTokens: 15,
            totalCacheReadTokens: 5,
            totalCostInUsd: 0.02,
          },
        },
      },
      queue,
      state,
    );
    finishTrueForgeTurn(queue, state);

    const events = await drain(queue);
    expect(
      events
        .filter((event) => event.type === 'text')
        .map((event) => (event.data as { text: string }).text),
    ).toEqual(['Hello ', 'world']);
    const toolUse = events.find((event) => event.type === 'tool_use');
    expect(toolUse?.data).toMatchObject({
      toolUseId: 'call-1',
      toolName: 'lookup',
      input: { query: 'complete' },
    });
    const done = events.find((event) => event.type === 'done');
    expect(done?.data).toMatchObject({
      result: 'Hello world',
      usage: { inputTokens: 22, outputTokens: 7 },
    });
    expect(state.usage).toMatchObject({
      tokenUsage: 29,
      contextTokens: 17,
      costUsd: 0.02,
    });
  });

  it('translates 10k text deltas without loss', () => {
    const queue = createAsyncQueue<AgentEvent>();
    const state = createTrueForgeTranslateState(128_000);
    beginTrueForgeTurn(state);
    const startedAt = performance.now();
    for (let i = 0; i < 10_000; i += 1) {
      translateTrueForgeEvent({ type: 'model.message.delta', content: 'x' }, queue, state);
    }
    const elapsedMs = performance.now() - startedAt;
    expect(state.finalText).toHaveLength(10_000);
    expect(queue.pending).toBe(10_000);
    expect(elapsedMs).toBeLessThan(2_000);
  });
});
