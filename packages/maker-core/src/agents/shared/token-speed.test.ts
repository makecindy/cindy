import { describe, expect, it } from 'vitest';
import { estimateDeltaTokens, TokenSpeedMeter, UsageTokenSpeedMeter } from './token-speed.js';

describe('TokenSpeedMeter (pi-token-speed algorithm)', () => {
  it('counts deltas with the word/punctuation estimate, one token per CJK character', () => {
    expect(estimateDeltaTokens('Hello, world!')).toBe(4);
    expect(estimateDeltaTokens('你好世界')).toBe(4);
    expect(estimateDeltaTokens('  ')).toBe(0);
  });

  it('reports tokens in the last second over the time since the token before them', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    // 10 tokens every 100ms → 100 tok/s.
    for (let t = 100; t <= 2_000; t += 100) meter.recordDelta('a b c d e f g h i j', t);
    const speed = meter.snapshot(2_000)!;
    expect(speed.streaming).toBe(true);
    // Window [1000, 2000] holds 11 events (110 tokens), generated since the token at 900.
    expect(speed.rate).toBeCloseTo(100, 5);
    expect(speed.tokens).toBe(200);
  });

  it('keeps the last rate during a stall, like the extension status bar', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    for (let t = 100; t <= 1_000; t += 100) meter.recordDelta('a b c d e', t);
    const before = meter.snapshot(1_000)!.rate;
    expect(meter.snapshot(9_000)!.rate).toBe(before);
  });

  it('extends a single-timestamp burst back to the previous token', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a', 0);
    // 5s stall, then 500 tokens flushed at once.
    meter.recordDelta(Array.from({ length: 500 }, () => 'w').join(' '), 5_000);
    expect(meter.snapshot(5_000)!.rate).toBeCloseTo(100, 5);
  });

  it('reads output flushed as several deltas after hidden thinking at its real pace', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c d e f g h i j', 1_000);
    meter.pause(1_000);
    // The tool ran for 9s, then the model thought for 10s without streaming anything.
    meter.start(10_000);
    const chunk = Array.from({ length: 250 }, () => 'w').join(' ');
    meter.recordDelta(chunk, 20_000);
    meter.recordDelta(chunk, 20_100);
    meter.recordDelta(chunk, 20_250);
    const live = meter.snapshot(20_250)!;
    expect(live.rate).toBeCloseTo(750 / 10.25, 5);
    meter.stop(1_200, 20_250);
    // 1s before the tool + 10.25s after it; the tool's 9s are excluded.
    expect(meter.snapshot()!).toMatchObject({ elapsedMs: 11_250, tokens: 1_200 });
  });

  it('keeps the previous reading while the window holds only a stray token', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a', 50);
    expect(meter.snapshot(50)!.rate).toBe(0);
    meter.recordDelta('a b c d e f g h i j', 1_000);
    const reading = meter.snapshot(1_000)!.rate;
    expect(reading).toBeGreaterThan(0);
    meter.pause(1_000);
    meter.start(3_000);
    meter.recordDelta('x', 5_500);
    expect(meter.snapshot(5_500)!.rate).toBe(reading);
  });

  it('excludes tool pauses from elapsed time and resumes on the next delta', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c d e f g h i j', 1_000);
    meter.pause(1_000);
    meter.recordDelta('a b c d e f g h i j', 31_000);
    meter.stop(undefined, 32_000);
    const speed = meter.snapshot(40_000)!;
    expect(speed.elapsedMs).toBe(2_000);
    expect(speed.average).toBe(10);
  });

  it('never lets elapsed time run backwards across an open pause', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c d e f g h i j', 1_000);
    meter.pause(1_000);
    expect(meter.snapshot(20_000)!.elapsedMs).toBe(1_000);
    meter.recordDelta('a', 30_000);
    expect(meter.snapshot(30_000)!.elapsedMs).toBe(1_000);
    meter.pause(30_500);
    meter.stop(undefined, 60_000);
    expect(meter.snapshot(90_000)!.elapsedMs).toBe(1_500);
  });

  it('does not credit output from before a short pause to the time after it', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    // 100 tok/s for a second, a 100ms tool call, then 10 tokens over 100ms.
    for (let t = 100; t <= 1_000; t += 100) meter.recordDelta('a b c d e f g h i j', t);
    meter.pause(1_000);
    meter.start(1_100);
    meter.recordDelta('a b c d e f g h i j', 1_200);
    expect(meter.snapshot(1_200)!.rate).toBeCloseTo(100, 5);
  });

  it('keeps measuring from the token before the window across compaction', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    // Two one-token deltas per ms is a steady 2000 tok/s; the stream crosses the
    // compaction threshold while the window's first event is still inside the window.
    let lowest = Infinity;
    for (let t = 1; t <= 8_000; t += 1) {
      meter.recordDelta('a', t);
      meter.recordDelta('a', t);
      if (t >= 1_500) lowest = Math.min(lowest, meter.snapshot(t)!.rate);
    }
    expect(lowest).toBeCloseTo(2_000, 5);
  });

  it('shows nothing for the rest of a turn whose clock was invalidated, until reset', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c d e f g h i j', 1_000);
    meter.invalidate();
    meter.recordDelta('a b c d e f g h i j', 300_000);
    meter.stop(20, 301_000);
    expect(meter.snapshot(301_000)).toBeUndefined();
    meter.reset();
    meter.start(0);
    meter.recordDelta('a b c d e f g h i j', 1_000);
    expect(meter.snapshot(1_000)?.tokens).toBe(10);
  });

  it('snaps to the real output at the end and reports the average', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c', 500);
    meter.stop(400, 2_000);
    const speed = meter.snapshot(5_000)!;
    expect(speed).toMatchObject({ streaming: false, tokens: 400, elapsedMs: 2_000, average: 200, rate: 200 });
  });

  it('keeps the estimate when the provider reported no output', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c d', 1_000);
    meter.stop(0, 2_000);
    expect(meter.snapshot()!.tokens).toBe(4);
  });

  it('has nothing to show before the first token and after reset', () => {
    const meter = new TokenSpeedMeter();
    expect(meter.snapshot()).toBeUndefined();
    meter.start(0);
    expect(meter.snapshot(10)).toBeUndefined();
    meter.recordDelta('a', 20);
    meter.reset();
    expect(meter.snapshot()).toBeUndefined();
  });

  it('throttles refresh signals to four per second', () => {
    const meter = new TokenSpeedMeter();
    const due = [0, 50, 100, 260, 300, 520].map((t) => meter.recordDelta('a b c d e', t));
    expect(due).toEqual([true, false, false, true, false, true]);
  });

  it('marks streaming as false during a pause and reports average without live rate inflation', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    for (let t = 100; t <= 1_000; t += 100) meter.recordDelta('a b c d e f g h i j', t);
    const live = meter.snapshot(1_000)!;
    expect(live.streaming).toBe(true);
    expect(live.rate).toBeCloseTo(100, 5);
    expect(live.peak).toBeCloseTo(100, 5);

    meter.pause(1_000);
    // While a tool runs for 10s, streaming must be false and rate should report average.
    const paused = meter.snapshot(11_000)!;
    expect(paused.streaming).toBe(false);
    expect(paused.rate).toBeCloseTo(100, 5);
    expect(paused.elapsedMs).toBe(1_000);
    expect(paused.peak).toBeCloseTo(100, 5);

    // Resuming with new delta resumes live streaming.
    meter.start(11_000);
    meter.recordDelta('a b c d e f g h i j', 11_100);
    const resumed = meter.snapshot(11_100)!;
    expect(resumed.streaming).toBe(true);
  });

  it('discards sub-100ms bursts from creating artificial high-rate spikes', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    // 175 tokens arriving at 10ms (sub-100ms span)
    meter.recordDelta(Array.from({ length: 175 }, () => 'w').join(' '), 10);
    const snap = meter.snapshot(10)!;
    // Rate must not be 1750 (175 tokens / 100ms minimum divisor)
    expect(snap.rate).toBe(0);
    // Nor may the average divide by the 10ms window: it stays 0 below one second.
    expect(snap).toMatchObject({ average: 0, rate: 0 });
  });

  it('keeps a sub-100ms burst out of subsequent windows so the next delta reads its own pace without inflating peak', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    // 175 tokens arriving at 10ms (sub-100ms held burst)
    meter.recordDelta(Array.from({ length: 175 }, () => 'w').join(' '), 10);
    expect(meter.snapshot(10)!.rate).toBe(0);
    expect(meter.snapshot(10)!.peak).toBeUndefined();

    // At 110ms, a normal 5-token delta arrives. The 175-token burst must not be
    // combined into this window (which would read ~1 636 tok/s and inflate peak):
    // the reading must reflect only the new delta measured over [10, 110].
    meter.recordDelta('a b c d e', 110);
    const snap = meter.snapshot(110)!;
    expect(snap.rate).toBeCloseTo((5 * 1_000) / (110 - 10), 5);
    expect(snap.peak).toBeCloseTo(50, 5);
    expect(snap.tokens).toBe(180);
  });

  it('publishes no average for a turn shorter than one second, even once paused', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c d e f g h i j', 900);
    meter.pause(900);
    const paused = meter.snapshot(30_000)!;
    expect(paused).toMatchObject({ streaming: false, tokens: 10, elapsedMs: 900, average: 0, rate: 0 });
    // A second of generation makes the same count measurable again.
    meter.start(30_000);
    meter.recordDelta('a', 30_100);
    expect(meter.snapshot(30_100)!.average).toBeCloseTo(11, 5);
    meter.stop(10, 30_100);
    expect(meter.snapshot()!.average).toBeCloseTo(10, 5);
  });

  it('discards a held burst flushed faster than any real decode speed', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    // 100 tok/s up to a tool pause, then the held output arrives in one 100ms frame.
    for (let t = 100; t <= 3_000; t += 100) meter.recordDelta('a b c d e f g h i j', t);
    const steady = meter.snapshot(3_000)!.rate;
    expect(steady).toBeCloseTo(100, 5);
    meter.pause(3_000);
    meter.start(10_000);
    meter.recordDelta(Array.from({ length: 12_000 }, () => 'w').join(' '), 10_100);
    const burst = meter.snapshot(10_100)!;
    // 12 000 tokens over the 100ms minimum span is 120 000 tok/s: not a
    // measurement, so the last reading stays and the peak never absorbs it.
    expect(burst.rate).toBeCloseTo(steady, 5);
    expect(burst.peak).toBeCloseTo(steady, 5);
  });

  it('keeps the burst out of the following windows so the next delta reads its own pace', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    // Steady 100 tok/s before the burst, so the last valid reading is 100.
    for (let t = 100; t <= 1_000; t += 100) meter.recordDelta('a b c d e f g h i j', t);
    const steady = meter.snapshot(1_000)!.rate;
    expect(steady).toBeCloseTo(100, 5);
    // A held burst is flushed in one 100ms frame → 1 750 tokens / 0.1s = 17 500
    // tok/s, above any real decode speed, so it is discarded as unmeasurable.
    meter.recordDelta(Array.from({ length: 1_750 }, () => 'w').join(' '), 1_100);
    expect(meter.snapshot(1_100)!.rate).toBeCloseTo(steady, 5);
    expect(meter.snapshot(1_100)!.peak).toBeCloseTo(steady, 5);
    // 110ms later a normal 5-token delta arrives. The burst must not be part of
    // its window: 1 755 tokens / 110ms would read ~15 954 tok/s (and 180 tokens
    // would still read 1 636), so the reading must come from the new delta alone,
    // measured [1 100, 1 210], and the peak must not absorb the burst.
    meter.recordDelta('a b c d e', 1_210);
    const after = meter.snapshot(1_210)!;
    expect(after.rate).toBeCloseTo((5 * 1_000) / 110, 5);
    expect(after.peak).toBeCloseTo(steady, 5);
  });

  it('syncs output tokens without resetting elapsed timing', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c', 500);
    expect(meter.snapshot(500)!.tokens).toBe(3);
    meter.syncOutputTokens(50);
    expect(meter.snapshot(500)!.tokens).toBe(50);
    expect(meter.snapshot(500)!.elapsedMs).toBe(500);
  });

  it('calibrates downwards when the provider reports less output than the estimate', () => {
    const meter = new TokenSpeedMeter();
    meter.start(0);
    meter.recordDelta('a b c d e f g h i j k l', 1_000);
    expect(meter.snapshot(1_000)!.tokens).toBe(12);
    meter.syncOutputTokens(5);
    // The stale estimate must not survive: it was never billed output.
    expect(meter.snapshot(1_000)).toMatchObject({ tokens: 5, average: 5 });
    // Repeated syncs are totals, not deltas.
    meter.syncOutputTokens(5);
    expect(meter.snapshot(1_000)!.tokens).toBe(5);
    meter.stop(4, 2_000);
    expect(meter.snapshot()!.tokens).toBe(4);
  });
});

describe('UsageTokenSpeedMeter', () => {
  // Regression: a long Codex run can report more output while tool-paused
  // generation time is frozen. Existing tests only covered backwards clocks.
  // Unit: the public snapshot must withdraw the bad interval and recover.
  it('excludes output without elapsed time and resumes from the next paired interval', () => {
    const meter = new UsageTokenSpeedMeter();
    meter.recordUsage(100, 1_000);
    meter.recordUsage(2_122_500, 1_000);
    expect(meter.snapshot()).toBeUndefined();
    meter.recordUsage(2_122_877, 11_000);
    expect(meter.snapshot()).toMatchObject({ tokens: 477, elapsedMs: 11_000, rate: 37.7 });
    expect(meter.snapshot()?.average).toBeCloseTo(477 / 11);
  });

  it('keeps paired totals and peak across native continuations but resets a new user turn', () => {
    const meter = new UsageTokenSpeedMeter();
    meter.recordUsage(1_000, 10_000);
    meter.stop();
    meter.startSegment();
    expect(meter.snapshot()).toBeUndefined();
    meter.recordUsage(377, 10_000);
    expect(meter.snapshot()).toMatchObject({ tokens: 1_377, elapsedMs: 20_000, average: 68.85, peak: 100 });
    meter.reset();
    meter.recordUsage(377, 10_000);
    expect(meter.snapshot()).toMatchObject({ tokens: 377, elapsedMs: 10_000, average: 37.7, peak: 37.7 });
  });

  it('uses the last three paired intervals weighted by duration, including hidden output', () => {
    const meter = new UsageTokenSpeedMeter();
    expect(meter.snapshot()).toBeUndefined();
    meter.recordUsage(10, 500);
    expect(meter.snapshot()?.rate).toBe(0);
    meter.recordUsage(50, 1_000);
    meter.recordUsage(150, 5_000);
    expect(meter.snapshot()?.rate).toBe(30);
    meter.recordUsage(190, 6_000);
    meter.recordUsage(250, 8_000);
    // Last three intervals: (100 + 40 + 60) / (4 + 1 + 2).
    expect(meter.snapshot()?.rate).toBeCloseTo(200 / 7);
    meter.recordUsage(250, 20_000);
    expect(meter.snapshot()?.elapsedMs).toBe(8_000);
    meter.stop();
    expect(meter.snapshot()).toMatchObject({ streaming: false, average: 31.25, tokens: 250, elapsedMs: 8_000 });
    meter.recordUsage(300, 30_000);
    expect(meter.snapshot()?.tokens).toBe(250);
  });

  it('withdraws invalid or backwards measurements until the next turn', () => {
    const meter = new UsageTokenSpeedMeter();
    for (const [tokens, elapsed] of [[90, 2_000], [110, 900], [NaN, 2_000]]) {
      meter.reset();
      meter.recordUsage(100, 1_000);
      meter.recordUsage(tokens, elapsed);
      expect(meter.snapshot()).toBeUndefined();
    }
    meter.reset();
    meter.recordUsage(20, 1_000);
    expect(meter.snapshot()?.rate).toBe(20);
    meter.invalidate();
    expect(meter.snapshot()).toBeUndefined();
  });
});
