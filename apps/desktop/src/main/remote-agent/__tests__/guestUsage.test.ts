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

  // Native Claude bypasses the HTTP proxy: streaming usage must settle before a long turn ends.
  // The SDK result may additionally include child-only usage; neither source may double-charge. Unit.
  it('reconciles live Claude model receipts with cumulative root and child totals', () => {
    const meter = createGuestUsageMeter('claude-code');
    const requestUsage = { epoch: 'native', models: [{ model: 'future-model', inputTokens: 100, outputTokens: 20 }] };
    expect(meter.observe({ type: 'status', data: { requestUsage } } as AgentEvent, 'root')[0])
      .toMatchObject({ model: 'future-model', inputTokens: 100, outputTokens: 20 });
    const result = { requestUsage, modelUsageCumulativeStartsAtZero: true, modelUsage: {
      'future-model': { inputTokens: 100, outputTokens: 25 }, 'child-model': { inputTokens: 40, outputTokens: 10 },
    } };
    const samples = meter.observe(done(result), 'root');
    expect(samples.find(row => row.model === 'future-model')).toMatchObject({ inputTokens: 0, outputTokens: 5 });
    expect(samples.find(row => row.model === 'child-model')).toMatchObject({ inputTokens: 40, outputTokens: 10 });
    expect(meter.observe(done(result), 'root').every(row => row.inputTokens === 0 && row.outputTokens === 0)).toBe(true);
  });

  it('reads Codex and Pi per-turn usage against the current model', () => {
    expect(createGuestUsageMeter('codex').observe(done({ usage: { promptTokens: 9, completionTokens: 4, cachedTokens: 3, cacheCreationTokens: 1 } }), 'gpt-5.5'))
      .toEqual([{ model: 'gpt-5.5', turns: 1, inputTokens: 9, outputTokens: 4, cacheReadTokens: 3, cacheCreateTokens: 1, sdkCostUsd: 0 }]);
    expect(createGuestUsageMeter('pi').observe(done({ usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 1 } }), 'grok'))
      .toEqual([{ model: 'grok', turns: 1, inputTokens: 7, outputTokens: 2, cacheReadTokens: 1, cacheCreateTokens: 0, sdkCostUsd: 0 }]);
  });

  // Unit regression: the first resumed SDK total establishes a baseline. Live
  // receipts covered by that total must not consume the following turn's delta.
  it('settles live receipts when a resumed Claude process establishes its baseline', () => {
    const meter = createGuestUsageMeter('claude-code');
    const requestUsage = { epoch: 'resumed', models: [{ model: 'model-a', inputTokens: 10, outputTokens: 5 }] };
    expect(meter.observe({ type: 'status', data: { requestUsage } } as AgentEvent, 'model-a')[0])
      .toMatchObject({ inputTokens: 10, outputTokens: 5 });
    meter.observe(done({ requestUsage, modelUsage: { 'model-a': { inputTokens: 110, outputTokens: 55 } } }), 'model-a');
    const next = meter.observe(done({ requestUsage, modelUsage: { 'model-a': { inputTokens: 120, outputTokens: 60 } } }), 'model-a');
    expect(next[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });

  // A long shared turn must settle model receipts before done, without charging retries twice.
  it.each(['codex', 'pi'])('meters %s request receipts by actual model across turns and runtime restarts', kind => {
    const meter = createGuestUsageMeter(kind);
    const snapshot = (epoch: string, outputTokens: number) => ({ type: 'status', data: { requestUsage: {
      epoch, models: [{ model: 'astra', inputTokens: 10, outputTokens, cacheReadTokens: 2 }],
    } } } as unknown as AgentEvent);
    expect(meter.observe(snapshot('run-a', 4), 'sol')[0]).toMatchObject({ model: 'astra', inputTokens: 10, outputTokens: 4, turns: 0 });
    expect(meter.observe(snapshot('run-a', 4), 'terra')).toEqual([]);
    expect(meter.observe(snapshot('run-a', 2), 'terra')).toEqual([]);
    expect(meter.observe(done({ usage: { promptTokens: 10, completionTokens: 4 } }), 'terra')[0]).toMatchObject({ turns: 1, inputTokens: 0, outputTokens: 0 });
    expect(meter.observe(snapshot('run-a', 6), 'terra')[0]).toMatchObject({ model: 'astra', inputTokens: 0, outputTokens: 2 });
    expect(meter.observe(snapshot('run-b', 1), 'terra')[0]).toMatchObject({ model: 'astra', inputTokens: 10, outputTokens: 1 });
  });

  it('ignores events other than done and malformed numbers', () => {
    const meter = createGuestUsageMeter('codex');
    expect(meter.observe({ type: 'text', data: 'hi' } as unknown as AgentEvent, 'm')).toEqual([]);
    expect(meter.observe(done({ usage: { promptTokens: -5, completionTokens: 'x' } }), '')[0])
      .toMatchObject({ model: 'unknown', inputTokens: 0, outputTokens: 0 });
  });
});
