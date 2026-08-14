import { describe, expect, it } from 'vitest';

import {
  ClaudeOutputLagTimingGuard,
  computeModelUsageDeltas,
  type ModelUsageCumulative,
  type ModelUsageDeltaEntry,
} from '../modelUsageDelta';

function snap(over: Partial<ModelUsageCumulative> = {}): ModelUsageCumulative {
  return {
    costUSD: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    ...over,
  };
}

describe('computeModelUsageDeltas', () => {
  it('first report: full cumulative becomes the delta', () => {
    const { next, deltas } = computeModelUsageDeltas(undefined, {
      'claude-opus-4-8': {
        costUSD: 0.5,
        inputTokens: 100,
        outputTokens: 200,
        cacheReadInputTokens: 3000,
        cacheCreationInputTokens: 400,
      },
    });
    expect(deltas).toEqual([
      {
        model: 'claude-opus-4-8',
        costUsdDelta: 0.5,
        inputTokensDelta: 100,
        outputTokensDelta: 200,
        cacheReadTokensDelta: 3000,
        cacheCreateTokensDelta: 400,
      },
    ]);
    expect(next.get('claude-opus-4-8')).toEqual(snap({
      costUSD: 0.5,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadInputTokens: 3000,
      cacheCreationInputTokens: 400,
    }));
  });

  it('monotonic increase: delta = cumulative - last', () => {
    const prev = new Map([['m', snap({ costUSD: 1, inputTokens: 10, outputTokens: 20 })]]);
    const { deltas } = computeModelUsageDeltas(prev, {
      m: { costUSD: 1.25, inputTokens: 15, outputTokens: 26, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    expect(deltas).toEqual([
      {
        model: 'm',
        costUsdDelta: 0.25,
        inputTokensDelta: 5,
        outputTokensDelta: 6,
        cacheReadTokensDelta: 0,
        cacheCreateTokensDelta: 0,
      },
    ]);
  });

  it('cumulative reset (subprocess respawn): rebase from zero, no negative delta', () => {
    const prev = new Map([['m', snap({ costUSD: 2, inputTokens: 1000, outputTokens: 500 })]]);
    const { next, deltas } = computeModelUsageDeltas(prev, {
      m: { costUSD: 0.1, inputTokens: 50, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    // 归零后整体 rebase: 本次累计全额计入 (而不是部分字段钳 0 的混合口径)
    expect(deltas).toEqual([
      {
        model: 'm',
        costUsdDelta: 0.1,
        inputTokensDelta: 50,
        outputTokensDelta: 30,
        cacheReadTokensDelta: 0,
        cacheCreateTokensDelta: 0,
      },
    ]);
    expect(next.get('m')!.costUSD).toBe(0.1);
  });

  it('multi-model: independent deltas, unchanged model omitted', () => {
    const prev = new Map([
      ['a', snap({ costUSD: 1, inputTokens: 10 })],
      ['b', snap({ costUSD: 0.5, inputTokens: 5 })],
    ]);
    const { deltas } = computeModelUsageDeltas(prev, {
      a: { costUSD: 1.5, inputTokens: 20, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      b: { costUSD: 0.5, inputTokens: 5, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    expect(deltas.map((d) => d.model)).toEqual(['a']);
  });

  it('model absent from current report keeps its previous snapshot', () => {
    const prev = new Map([['stale', snap({ costUSD: 3 })]]);
    const { next, deltas } = computeModelUsageDeltas(prev, {
      fresh: { costUSD: 0.2, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    });
    expect(deltas.map((d) => d.model)).toEqual(['fresh']);
    expect(next.get('stale')).toEqual(snap({ costUSD: 3 }));
  });

  it('missing / malformed fields sanitize to zero instead of NaN', () => {
    const { deltas } = computeModelUsageDeltas(undefined, {
      m: { costUSD: 'oops', inputTokens: -5, outputTokens: Infinity },
      '': { costUSD: 1 },
    });
    expect(deltas).toEqual([]);
  });
});

describe('ClaudeOutputLagTimingGuard', () => {
  const lagged: ModelUsageDeltaEntry[] = [
    {
      model: 'claude-opus-4-8',
      costUsdDelta: 0,
      inputTokensDelta: 100,
      outputTokensDelta: 7,
      cacheReadTokensDelta: 20_000,
      cacheCreateTokensDelta: 0,
    },
  ];
  const settled: ModelUsageDeltaEntry[] = [
    {
      model: 'claude-opus-4-8',
      costUsdDelta: 0,
      inputTokensDelta: 100,
      outputTokensDelta: 3_200,
      cacheReadTokensDelta: 20_000,
      cacheCreateTokensDelta: 0,
    },
  ];

  it('suppresses the detected turn and the following backfill turn only', () => {
    const guard = new ClaudeOutputLagTimingGuard();
    expect(guard.evaluate('session-1', lagged, true, 'msg_vrtx_1')).toEqual({
      detected: true,
      suppressTiming: true,
    });
    expect(guard.evaluate('session-1', settled, true)).toEqual({
      detected: false,
      suppressTiming: true,
    });
    expect(guard.evaluate('session-1', settled, true)).toEqual({
      detected: false,
      suppressTiming: false,
    });
  });

  it('keeps a lagged continuation product turn suppressed through its final segment', () => {
    const guard = new ClaudeOutputLagTimingGuard();
    expect(guard.evaluate('session-1', lagged, false, 'msg_vrtx_1').suppressTiming).toBe(true);
    expect(guard.evaluate('session-1', settled, true).suppressTiming).toBe(true);
    expect(guard.evaluate('session-1', settled, true).suppressTiming).toBe(true);
    expect(guard.evaluate('session-1', settled, true).suppressTiming).toBe(false);
  });

  it('clears pending suppression per session', () => {
    const guard = new ClaudeOutputLagTimingGuard();
    guard.evaluate('session-1', lagged, true, 'msg_vrtx_1');
    guard.clear('session-1');
    expect(guard.evaluate('session-1', settled, true).suppressTiming).toBe(false);
  });

  it('does not suppress a legitimate short reply without Vertex evidence', () => {
    const guard = new ClaudeOutputLagTimingGuard();
    expect(guard.evaluate('session-1', lagged, true)).toEqual({
      detected: false,
      suppressTiming: false,
    });
  });

  it('does not arm next-turn suppression from a failed Vertex turn', () => {
    const guard = new ClaudeOutputLagTimingGuard();
    expect(guard.evaluate('session-1', lagged, true, 'msg_vrtx_1', false)).toEqual({
      detected: false,
      suppressTiming: false,
    });
    expect(guard.evaluate('session-1', settled, true)).toEqual({
      detected: false,
      suppressTiming: false,
    });
  });
});
