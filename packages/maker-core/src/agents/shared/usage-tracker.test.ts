import { describe, expect, it } from 'vitest';

import { UsageTracker } from './usage-tracker';

/**
 * getTurnUsage — Codex done 事件按真实 per-turn 用量记账的数据源。
 * 关键约束: 在 endTurn (会用 aggregate 覆盖后 reset) 之前取, 拿到的是
 * tokenUsage/updated 逐次 ingest 的累加值。
 */
describe('UsageTracker.getTurnUsage', () => {
  it('accumulates across multiple API calls within a turn', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheCreateTokens: 0 });
    tracker.ingestApiCallUsage({ inputTokens: 20, outputTokens: 30, cacheReadTokens: 500, cacheCreateTokens: 0 });

    expect(tracker.getTurnUsage()).toEqual({ input: 120, output: 80, cacheRead: 1500, cacheCreate: 0 });
  });

  it('returns a copy — mutating the result does not affect the tracker', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreateTokens: 0 });

    const snap = tracker.getTurnUsage();
    snap.input = 9999;
    expect(tracker.getTurnUsage().input).toBe(10);
  });

  it('value captured before endTurn survives the reset; bucket is zeroed after', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheCreateTokens: 0 });

    const captured = tracker.getTurnUsage();
    // Codex 链路的 endTurn 只有 contextTokens 降级值可给 — 覆盖语义不应污染已捕获的值
    tracker.endTurn({ inputTokens: 999_999, outputTokens: 0 });

    expect(captured).toEqual({ input: 100, output: 50, cacheRead: 200, cacheCreate: 0 });
    expect(tracker.getTurnUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });

  it('beginTurn clears any stale bucket from an aborted turn', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({ inputTokens: 42, outputTokens: 7, cacheReadTokens: 0, cacheCreateTokens: 0 });

    tracker.beginTurn();
    expect(tracker.getTurnUsage()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 });
  });

  it('adds result-only cache tokens to cache stats without double counting prior usage', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({ inputTokens: 10, outputTokens: 0 });

    tracker.ingestTurnAggregateCacheStats({
      inputTokens: 10,
      cacheReadTokens: 90,
      cacheCreateTokens: 5,
    });

    const stats = tracker.getCacheStats();
    expect(stats.turn).toMatchObject({
      read: 90,
      create: 5,
      uncachedInput: 10,
      apiCalls: 1,
    });
    expect(stats.turn.hitRate).toBeCloseTo(90 / 105);
    expect(stats.session).toMatchObject({
      read: 90,
      create: 5,
      uncachedInput: 10,
      apiCalls: 1,
    });
  });
});
