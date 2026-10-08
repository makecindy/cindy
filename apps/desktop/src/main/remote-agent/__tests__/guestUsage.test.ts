import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@cindy/maker-core';

import { createGuestUsageMeter } from '../host/guestUsage';

const done = (data: Record<string, unknown>): AgentEvent => ({ type: 'done', data } as unknown as AgentEvent);

describe('guest usage meter', () => {
  it('turns cumulative Claude modelUsage into per-turn deltas and counts one turn per done', () => {
    const meter = createGuestUsageMeter('claude-code');
    const first = meter.observe(done({
      modelUsageCumulativeStartsAtZero: true,
      modelUsage: {
        'claude-opus': { inputTokens: 100, outputTokens: 40, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUSD: 0.5 },
        'claude-haiku': { inputTokens: 20, outputTokens: 2, costUSD: 0.01 },
      },
    }), 'opus');
    expect(first).toEqual([
      { model: 'claude-opus', turns: 1, inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheCreateTokens: 5, sdkCostUsd: 0.5 },
      { model: 'claude-haiku', turns: 0, inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0.01 },
    ]);
    const second = meter.observe(done({
      modelUsage: {
        'claude-opus': { inputTokens: 130, outputTokens: 70, cacheReadInputTokens: 10, cacheCreationInputTokens: 5, costUSD: 0.8 },
        'claude-haiku': { inputTokens: 20, outputTokens: 2, costUSD: 0.01 },
      },
    }), 'opus');
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ model: 'claude-opus', turns: 1, inputTokens: 30, outputTokens: 30 });
    expect(second[0].sdkCostUsd).toBeCloseTo(0.3);
  });

  it('still counts a turn when Claude reports no usage', () => {
    expect(createGuestUsageMeter('claude-code').observe(done({}), 'sonnet'))
      .toEqual([{ model: 'sonnet', turns: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 }]);
  });

  it('reads Codex and Pi per-turn usage against the current model', () => {
    expect(createGuestUsageMeter('codex').observe(done({ usage: { promptTokens: 9, completionTokens: 4, cachedTokens: 3, cacheCreationTokens: 1 } }), 'gpt-5.5'))
      .toEqual([{ model: 'gpt-5.5', turns: 1, inputTokens: 9, outputTokens: 4, cacheReadTokens: 3, cacheCreateTokens: 1, sdkCostUsd: 0 }]);
    expect(createGuestUsageMeter('pi').observe(done({ usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 1 } }), 'grok'))
      .toEqual([{ model: 'grok', turns: 1, inputTokens: 7, outputTokens: 2, cacheReadTokens: 1, cacheCreateTokens: 0, sdkCostUsd: 0 }]);
  });

  it('ignores events other than done and malformed numbers', () => {
    const meter = createGuestUsageMeter('codex');
    expect(meter.observe({ type: 'text', data: 'hi' } as unknown as AgentEvent, 'm')).toEqual([]);
    expect(meter.observe(done({ usage: { promptTokens: -5, completionTokens: 'x' } }), '')[0])
      .toMatchObject({ model: 'unknown', inputTokens: 0, outputTokens: 0 });
  });
});
