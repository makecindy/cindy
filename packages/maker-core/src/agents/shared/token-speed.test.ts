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
});

describe('UsageTokenSpeedMeter', () => {
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
