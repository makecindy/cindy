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

  it('preserves request boundaries for request-scoped pricing', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({
      inputTokens: 40_000,
      outputTokens: 500,
      cacheReadTokens: 10_000,
      cacheCreateTokens: 0,
      reasoningTokens: 100,
    });
    tracker.ingestApiCallUsage({
      inputTokens: 45_000,
      outputTokens: 700,
      cacheReadTokens: 5_000,
      cacheCreateTokens: 0,
      reasoningTokens: 200,
    });

    const segments = tracker.getTurnUsageSegments();
    expect(segments).toEqual([
      {
        inputTokens: 40_000,
        outputTokens: 500,
        cacheReadTokens: 10_000,
        cacheCreateTokens: 0,
        reasoningTokens: 100,
      },
      {
        inputTokens: 45_000,
        outputTokens: 700,
        cacheReadTokens: 5_000,
        cacheCreateTokens: 0,
        reasoningTokens: 200,
      },
    ]);

    segments[0]!.inputTokens = 999_999;
    expect(tracker.getTurnUsageSegments()[0]?.inputTokens).toBe(40_000);
  });

  it('merges split frames for one request without double-counting repeated input/cache', () => {
    const tracker = new UsageTracker();
    tracker.upsertApiCallUsage('request-1', {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 900,
      cacheCreateTokens: 50,
      complete: false,
    });
    tracker.upsertApiCallUsage('request-1', {
      inputTokens: 100,
      outputTokens: 25,
      cacheReadTokens: 900,
      cacheCreateTokens: 50,
      complete: true,
    });

    expect(tracker.getTurnUsage()).toEqual({
      input: 100,
      output: 25,
      cacheRead: 900,
      cacheCreate: 50,
    });
    expect(tracker.getTurnUsageSegments()).toEqual([
      {
        id: 'request-1',
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 900,
        cacheCreateTokens: 50,
        reasoningTokens: 0,
        costUsd: 0,
        complete: true,
      },
    ]);
  });

  it('keeps the request model and price variant captured by the first frame', () => {
    const tracker = new UsageTracker();
    tracker.upsertApiCallUsage('request-1', {
      model: 'claude-opus-4-8',
      priceVariant: 'priority',
      inputTokens: 100,
      outputTokens: 0,
    });
    tracker.upsertApiCallUsage('request-1', {
      model: 'claude-sonnet-4-8',
      priceVariant: 'standard',
      inputTokens: 100,
      outputTokens: 25,
    });

    expect(tracker.getTurnUsageSegments()[0]).toMatchObject({
      model: 'claude-opus-4-8',
      priceVariant: 'priority',
      inputTokens: 100,
      outputTokens: 25,
    });
  });

  it('clears request segments at both beginTurn and endTurn boundaries', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({ inputTokens: 10, outputTokens: 1 });
    tracker.beginTurn();
    expect(tracker.getTurnUsageSegments()).toEqual([]);

    tracker.ingestApiCallUsage({ inputTokens: 20, outputTokens: 2 });
    const captured = tracker.getTurnUsageSegments();
    tracker.endTurn({ inputTokens: 20, outputTokens: 2 });
    expect(captured).toEqual([
      { inputTokens: 20, outputTokens: 2, cacheReadTokens: 0, cacheCreateTokens: 0 },
    ]);
    expect(tracker.getTurnUsageSegments()).toEqual([]);
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

/**
 * markContextOverflow — 上下文超限终态的自锁解除(#1429)。
 * 超限请求被 400 整体拒绝、不返回 usage 时, lastApi 停在旧值(重启后是 0):
 * 圆环显示 0%、auto-compact 的 ratio 永远到不了阈值。锁到窗口满载后
 * snapshot().contextTokens = contextWindow, ratio=1.0 让 turn end 压缩得以触发。
 */
describe('UsageTracker.markContextOverflow', () => {
  it('locks contextTokens to the window when below it (fresh tracker after restart)', () => {
    const tracker = new UsageTracker();
    tracker.setContextWindow(272_000);
    expect(tracker.snapshot().contextTokens).toBe(0);

    tracker.markContextOverflow();
    expect(tracker.snapshot()).toMatchObject({ contextTokens: 272_000, contextWindow: 272_000 });
  });

  it('locks contextTokens to the window when a previous successful turn left a lower value', () => {
    const tracker = new UsageTracker();
    tracker.setContextWindow(272_000);
    tracker.ingestApiCallUsage({ inputTokens: 1_000, outputTokens: 10, cacheReadTokens: 199_000 });
    expect(tracker.snapshot().contextTokens).toBe(200_000);

    tracker.markContextOverflow();
    expect(tracker.snapshot().contextTokens).toBe(272_000);
  });

  it('keeps the real reading when it already meets/exceeds the window', () => {
    const tracker = new UsageTracker();
    tracker.setContextWindow(272_000);
    tracker.ingestApiCallUsage({ inputTokens: 280_000, outputTokens: 10 });

    tracker.markContextOverflow();
    // 真实读数比伪造值更诚实 —— 不动
    expect(tracker.snapshot().contextTokens).toBe(280_000);
  });

  it('is a no-op when the window is unknown ("无估算" principle)', () => {
    const tracker = new UsageTracker();
    tracker.ingestApiCallUsage({ inputTokens: 5_000, outputTokens: 10 });

    tracker.markContextOverflow();
    expect(tracker.snapshot()).toMatchObject({ contextTokens: 5_000, contextWindow: 0 });
  });

  it('survives endTurn without replaceLastApi (the failed-turn zero delta must not wipe it)', () => {
    const tracker = new UsageTracker();
    tracker.setContextWindow(272_000);
    tracker.markContextOverflow();

    // 超限失败轮: translator 对 overflow 轮传 replaceLastApi:false(守卫加 !isContextOverflowTurn)
    const snap = tracker.endTurn({ inputTokens: 0, outputTokens: 0, replaceLastApi: false });
    expect(snap.contextTokens).toBe(272_000);
    expect(tracker.snapshot().contextTokens).toBe(272_000);
  });
});
