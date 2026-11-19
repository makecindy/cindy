import { describe, expect, it } from 'vitest';
import {
  clearRateHistoryCache,
  emptyRateHistory,
  loadCachedRateHistory,
  recordRunningTokenRate,
  recordTokenSpeed,
  saveCachedRateHistory,
} from '@/features/cc-agent/lib/runningTokenRateHistory';
import { binThinkingMarks, formatThinkingShare, readTokenSpeedSnapshot, thinkingStrokeLength, traceHasChart } from '@cindy/maker-shared/usage-format';

const input = { startedAt: 1, outputTokens: 0, generationDurationMs: 0, generationReliable: true };
const begin = () => recordRunningTokenRate(emptyRateHistory(null), input);

describe('running speed history', () => {
  it('uses paired deltas rather than the cumulative turn average', () => {
    const first = recordRunningTokenRate(begin(), {
      ...input,
      outputTokens: 100,
      generationDurationMs: 1000,
    });
    const nextInput = { ...input, outputTokens: 150, generationDurationMs: 2000 };
    const next = recordRunningTokenRate(first, nextInput);
    expect(next.samples.map((sample) => sample.rate)).toEqual([100, 50]);
    expect(next.peak).toBe(100);
    expect(recordRunningTokenRate(next, nextInput)).toBe(next);
  });

  it('does not call a reconnect cumulative total the latest speed', () => {
    const first = recordRunningTokenRate(emptyRateHistory(null), {
      ...input,
      outputTokens: 1000,
      generationDurationMs: 10000,
    });
    expect(first.samples).toEqual([]);
    const next = recordRunningTokenRate(first, {
      ...input,
      outputTokens: 1100,
      generationDurationMs: 12000,
    });
    expect(next.samples[0].rate).toBe(50);
  });

  it('uses sparse real generation intervals without counting wall-clock waits', () => {
    const first = recordRunningTokenRate(begin(), {
      ...input,
      outputTokens: 1000,
      generationDurationMs: 10000,
    });
    const next = recordRunningTokenRate(first, {
      ...input,
      outputTokens: 1600,
      generationDurationMs: 30000,
    });
    expect(next.samples.at(-1)?.rate).toBe(30);
  });

  it('re-baselines on turn changes, counters resetting, or unreliable timing', () => {
    const first = recordRunningTokenRate(begin(), {
      ...input,
      outputTokens: 100,
      generationDurationMs: 1000,
    });
    const newTurn = recordRunningTokenRate(first, { ...input, startedAt: 2 });
    expect(newTurn.samples).toEqual(first.samples);
    expect(newTurn.latestRate).toBeNull();
    expect(
      recordRunningTokenRate(first, { ...input, outputTokens: 50, generationDurationMs: 500 })
        .samples,
    ).toEqual(first.samples);
    expect(
      recordRunningTokenRate(first, { ...input, generationReliable: false }).baseline,
    ).toBeNull();
    expect(recordRunningTokenRate(first, { ...input, generationDurationMs: NaN }).samples).toEqual(
      first.samples,
    );
  });

  it('does not turn a count correction with frozen time into a spike', () => {
    const first = recordRunningTokenRate(begin(), {
      ...input,
      outputTokens: 100,
      generationDurationMs: 1000,
    });
    const correction = recordRunningTokenRate(first, {
      ...input,
      outputTokens: 150,
      generationDurationMs: 1000,
    });
    expect(correction.samples).toEqual(first.samples);
    const next = recordRunningTokenRate(correction, {
      ...input,
      outputTokens: 200,
      generationDurationMs: 2000,
    });
    expect(next.samples.at(-1)?.rate).toBe(50);
  });

  it('bounds chart samples without losing the turn peak', () => {
    let history = recordRunningTokenRate(begin(), {
      ...input,
      outputTokens: 1000,
      generationDurationMs: 1000,
    });
    for (let n = 2; n <= 200; n++) {
      history = recordRunningTokenRate(history, {
        ...input,
        outputTokens: 1000 + n,
        generationDurationMs: n * 1000,
      });
    }
    expect(history.samples).toHaveLength(60);
    expect(history.peak).toBe(1000);
    expect(history.samples[0].durationMs).toBe(141000);
  });
});

it('records final usage and appends the next turn on a continuous generation timeline', () => {
  const active = recordRunningTokenRate(begin(), {
    ...input,
    outputTokens: 100,
    generationDurationMs: 1000,
  });
  const terminal = recordRunningTokenRate(active, {
    ...input,
    startedAt: null,
    outputTokens: 150,
    generationDurationMs: 2000,
  });
  expect(terminal.startedAt).toBe(1);
  expect(terminal.samples.map((sample) => sample.rate)).toEqual([100, 50]);
  expect(terminal.peak).toBe(100);
  const newTurn = recordRunningTokenRate(terminal, { ...input, startedAt: 2 });
  expect(newTurn.samples).toEqual(terminal.samples);
  expect(newTurn.latestRate).toBeNull();
  const next = recordRunningTokenRate(newTurn, {
    ...input,
    startedAt: 2,
    outputTokens: 40,
    generationDurationMs: 1000,
  });
  expect(next.samples.map((sample) => sample.rate)).toEqual([100, 50, 40]);
  expect(next.samples.map((sample) => sample.durationMs)).toEqual([1000, 2000, 3000]);
  expect(next.latestRate).toBe(40);
});

it('retains the chart while hidden or unreliable, then measures only new paired reports', () => {
  const active = recordRunningTokenRate(begin(), {
    ...input,
    outputTokens: 100,
    generationDurationMs: 1000,
  });
  const hidden = recordRunningTokenRate(active, {
    ...input,
    startedAt: null,
    generationReliable: false,
  });
  expect(hidden.samples).toEqual(active.samples);
  expect(hidden.latestRate).toBeNull();
  const resumed = recordRunningTokenRate(hidden, {
    ...input,
    outputTokens: 500,
    generationDurationMs: 10000,
  });
  expect(resumed.samples).toEqual(active.samples);
  const next = recordRunningTokenRate(resumed, {
    ...input,
    outputTokens: 550,
    generationDurationMs: 11000,
  });
  expect(next.samples.map((sample) => sample.rate)).toEqual([100, 50]);
  expect(next.samples.map((sample) => sample.durationMs)).toEqual([1000, 2000]);
});

describe('per-session speed history cache', () => {
  it('round-trips a history with samples and keeps the latest entry warm', () => {
    clearRateHistoryCache();
    saveCachedRateHistory('s1', emptyRateHistory(null));
    expect(loadCachedRateHistory('s1')).toBeNull();
    const history = recordRunningTokenRate(begin(), {
      ...input,
      outputTokens: 100,
      generationDurationMs: 1000,
    });
    saveCachedRateHistory('s1', history);
    const restored = loadCachedRateHistory('s1');
    expect(restored?.samples.map((sample) => sample.rate)).toEqual([100]);
    expect(restored?.baseline).toEqual(history.baseline);
  });

  it('evicts the least recently used session beyond the cap', () => {
    clearRateHistoryCache();
    const history = recordRunningTokenRate(begin(), {
      ...input,
      outputTokens: 100,
      generationDurationMs: 1000,
    });
    for (let n = 0; n < 20; n++) saveCachedRateHistory(`cap-${n}`, history);
    // 读 s0 让它变成最近使用，下一个新会话应淘汰 s1 而不是 s0。
    expect(loadCachedRateHistory('cap-0')).not.toBeNull();
    saveCachedRateHistory('cap-20', history);
    expect(loadCachedRateHistory('cap-1')).toBeNull();
    expect(loadCachedRateHistory('cap-0')).not.toBeNull();
    expect(loadCachedRateHistory('cap-20')).not.toBeNull();
  });
});

it('does not publish the 21 tokens / 1 ms spike, including at completion', () => {
  const first = recordRunningTokenRate(emptyRateHistory(null), {
    ...input,
    outputTokens: 3879,
    generationDurationMs: 102361,
  });
  const correction = recordRunningTokenRate(first, {
    ...input,
    outputTokens: 3900,
    generationDurationMs: 102362,
  });
  expect(correction.samples).toEqual([]);
  expect(correction.peak).toBe(0);
  const terminal = recordRunningTokenRate(correction, {
    ...input,
    startedAt: null,
    outputTokens: 3900,
    generationDurationMs: 102362,
  });
  expect(terminal.samples).toEqual([]);
  expect(terminal.peak).toBe(0);
});

it('accumulates frequent reports into a full window without losing tokens', () => {
  let history = begin();
  for (let n = 1; n < 10; n++) {
    history = recordRunningTokenRate(history, {
      ...input,
      outputTokens: n * 10,
      generationDurationMs: n * 100,
    });
    expect(history.samples).toEqual([]);
  }
  history = recordRunningTokenRate(history, {
    ...input,
    outputTokens: 100,
    generationDurationMs: 1000,
  });
  expect(history.samples.map((sample) => sample.rate)).toEqual([100]);
  const pending = recordRunningTokenRate(history, {
    ...input,
    outputTokens: 121,
    generationDurationMs: 1001,
  });
  expect(pending.samples).toEqual(history.samples);
  expect(pending.peak).toBe(100);
  const next = recordRunningTokenRate(pending, {
    ...input,
    outputTokens: 150,
    generationDurationMs: 2000,
  });
  expect(next.samples.map((sample) => sample.rate)).toEqual([100, 50]);
  expect(next.peak).toBe(100);
});

it('does not consume generation time before the matching output arrives', () => {
  const first = recordRunningTokenRate(begin(), {
    ...input,
    outputTokens: 100,
    generationDurationMs: 1000,
  });
  const timeOnly = recordRunningTokenRate(first, {
    ...input,
    outputTokens: 100,
    generationDurationMs: 2999,
  });
  expect(timeOnly.samples).toEqual(first.samples);
  const output = recordRunningTokenRate(timeOnly, {
    ...input,
    outputTokens: 200,
    generationDurationMs: 3000,
  });
  expect(output.samples.map((sample) => sample.rate)).toEqual([100, 50]);
  expect(output.peak).toBe(100);
});

it('detects a counter rollback within an unfinished sampling window', () => {
  const pending = recordRunningTokenRate(begin(), {
    ...input,
    outputTokens: 90,
    generationDurationMs: 900,
  });
  const reset = recordRunningTokenRate(pending, {
    ...input,
    outputTokens: 50,
    generationDurationMs: 500,
  });
  expect(reset.samples).toEqual([]);
  const next = recordRunningTokenRate(reset, {
    ...input,
    outputTokens: 100,
    generationDurationMs: 1500,
  });
  expect(next.samples.map((sample) => sample.rate)).toEqual([50]);
});

it('re-establishes the same report after reliability returns and preserves completed history', () => {
  const report = { ...input, outputTokens: 100, generationDurationMs: 1000 };
  const active = recordRunningTokenRate(begin(), report);
  const hidden = recordRunningTokenRate(active, { ...report, generationReliable: false });
  expect(hidden.lastReport).toBeNull();
  const resumed = recordRunningTokenRate(hidden, report);
  expect(resumed.baseline).toEqual(active.baseline);
  const short = recordRunningTokenRate(resumed, {
    ...report,
    outputTokens: 121,
    generationDurationMs: 1001,
  });
  expect(short.latestRate).toBeNull();
  expect(short.samples).toEqual(active.samples);
  expect(short.peak).toBe(100);
  const next = recordRunningTokenRate(short, {
    ...report,
    outputTokens: 150,
    generationDurationMs: 2000,
  });
  expect(next.latestRate).toBe(50);
  expect(next.samples.map((sample) => sample.durationMs)).toEqual([1000, 2000]);
});

describe('host token speed (Pi extension algorithm)', () => {
  const speed = (rate: number, elapsedMs: number, streaming = true) => ({
    rate,
    average: rate,
    tokens: Math.round((rate * elapsedMs) / 1000),
    elapsedMs,
    streaming,
  });

  it('shows the host rate as the latest speed and charts one point per second of generation', () => {
    let history = recordTokenSpeed(emptyRateHistory(null), { startedAt: 1, speed: speed(80, 300), now: 10 });
    expect(history.latestRate).toBe(80);
    expect(history.samples).toEqual([]);
    history = recordTokenSpeed(history, { startedAt: 1, speed: speed(90, 1200), now: 20 });
    history = recordTokenSpeed(history, { startedAt: 1, speed: speed(95, 1500), now: 30 });
    expect(history.samples.map((sample) => sample.durationMs)).toEqual([1200]);
    history = recordTokenSpeed(history, { startedAt: 1, speed: speed(70, 2300), now: 40 });
    expect(history.samples.map((sample) => sample.rate)).toEqual([90, 70]);
    expect(history.peak).toBe(95);
    expect(history.latestRate).toBe(70);
  });

  it('keeps the latest speed when the final average arrives, and continues the axis next turn', () => {
    let history = recordTokenSpeed(emptyRateHistory(null), { startedAt: 1, speed: speed(100, 1500) });
    history = recordTokenSpeed(history, { startedAt: 1, speed: speed(60, 2000, false) });
    expect(history.latestRate).toBe(100);
    expect(history.samples).toHaveLength(1);
    history = recordTokenSpeed(history, { startedAt: 2, speed: speed(50, 1100) });
    expect(history.samples.map((sample) => sample.durationMs)).toEqual([1500, 2600]);
  });

  it('has no current speed until the host has a reading, instead of showing 0 tok/s', () => {
    const first = recordTokenSpeed(emptyRateHistory(null), { startedAt: 1, speed: speed(0, 400) });
    expect(first.latestRate).toBeNull();
    const measured = recordTokenSpeed(first, { startedAt: 1, speed: speed(50, 900) });
    expect(measured.latestRate).toBe(50);
    expect(recordTokenSpeed(measured, { startedAt: 2, speed: speed(0, 100) }).latestRate).toBeNull();
  });

  it('restores the host peak after reconnect and resets it with a new product turn', () => {
    const snapshot = readTokenSpeedSnapshot({ ...speed(37.7, 10_000), peak: 100 })!;
    let history = recordTokenSpeed(emptyRateHistory(null), { startedAt: 1, speed: snapshot });
    expect(history.peak).toBe(100);
    for (let i = 2; i <= 70; i++) {
      history = recordTokenSpeed(history, { startedAt: 1, speed: speed(37.7, i * 10_000) });
    }
    expect(history.samples).toHaveLength(60);
    expect(history.peak).toBe(100);
    saveCachedRateHistory('continuation-peak', history);
    history = recordTokenSpeed(loadCachedRateHistory('continuation-peak')!, { startedAt: 2, speed: speed(20, 1_000) });
    expect(history.peak).toBe(20);
    clearRateHistoryCache();
  });

  it('accepts only well-formed host snapshots', () => {
    const measured = speed(10, 1000);
    expect(readTokenSpeedSnapshot({ ...measured, totalOutputTokens: 5300 })?.totalOutputTokens).toBe(5300);
    expect(readTokenSpeedSnapshot({ ...measured, totalOutputTokens: -1 })).toEqual(measured);
    expect(readTokenSpeedSnapshot(speed(10, 1000))).toEqual(speed(10, 1000));
    expect(readTokenSpeedSnapshot({ rate: 10 })).toBeUndefined();
    expect(readTokenSpeedSnapshot({ ...speed(10, 1000), rate: Number.NaN })).toBeUndefined();
    expect(readTokenSpeedSnapshot(null)).toBeUndefined();
  });

  it('does not treat a mid-turn provisional elapsedMs adjustment as a new turn reset and keeps plotting', () => {
    let history = recordTokenSpeed(emptyRateHistory(null), {
      startedAt: 1,
      speed: { rate: 80, average: 20, tokens: 200, elapsedMs: 10_000, streaming: true, peak: 80 },
      now: 100,
    });
    expect(history.latestRate).toBe(80);
    expect(history.samples.map((sample) => sample.durationMs)).toEqual([10_000]);
    history = recordTokenSpeed(history, {
      startedAt: 1,
      speed: { rate: 100, average: 100, tokens: 300, elapsedMs: 3_000, streaming: true, peak: 100 },
      now: 200,
    });
    expect(history.latestRate).toBe(100);
    expect(history.speedOffsetMs).toBe(7_000);
    expect(history.peak).toBe(100);

    history = recordTokenSpeed(history, {
      startedAt: 1,
      speed: { rate: 95, average: 98, tokens: 395, elapsedMs: 4_000, streaming: true, peak: 100 },
      now: 300,
    });
    expect(history.samples.map((sample) => ({ durationMs: sample.durationMs, rate: sample.rate }))).toEqual([
      { durationMs: 10_000, rate: 80 },
      { durationMs: 11_000, rate: 95 },
    ]);
  });

  it('clears latestRate while a new same-turn request warms up without dropping samples or peak', () => {
    let history = recordTokenSpeed(emptyRateHistory(null), {
      startedAt: 1,
      speed: { rate: 80, average: 75, tokens: 300, elapsedMs: 4_000, streaming: true, peak: 90 },
      now: 100,
    });
    expect(history.latestRate).toBe(80);
    expect(history.samples).toHaveLength(1);

    history = recordTokenSpeed(history, {
      startedAt: 1,
      speed: { rate: 0, average: 75, tokens: 310, elapsedMs: 4_200, streaming: true, peak: 90 },
      now: 200,
    });
    expect(history.latestRate).toBeNull();
    expect(history.samples).toHaveLength(1);
    expect(history.peak).toBe(90);

    history = recordTokenSpeed(history, {
      startedAt: 1,
      speed: { rate: 110, average: 85, tokens: 550, elapsedMs: 6_500, streaming: true, peak: 110 },
      now: 300,
    });
    expect(history.latestRate).toBe(110);
    expect(history.samples).toHaveLength(2);
    expect(history.peak).toBe(110);
  });
});

// 生产入口：recordTokenSpeed（状态栏速度图的历史）与 binThinkingMarks（图上的推理笔画）。
// 规则依据：宿主随速度快照上报最近一次完成的模型请求；同一快照每秒重复到达多次，
// 图上只能多出一笔，且「上报 0」（没推理就直接回答）与「没上报」必须可区分。unit。
describe('finished requests on the speed chart', () => {
  const speed = (elapsedMs: number, request?: { index: number; atMs: number; thinkingTokens?: number; outputTokens?: number }) => ({
    rate: 50, average: 50, tokens: Math.round(elapsedMs / 20), elapsedMs, streaming: true,
    ...(request ? { request } : {}),
  });

  it('adds one mark per finished request, however often its snapshot repeats', () => {
    let history = recordTokenSpeed(emptyRateHistory(null), { startedAt: 1, speed: speed(1200) });
    expect(history.marks).toBeUndefined();
    const first = { index: 1, atMs: 2000, thinkingTokens: 516, outputTokens: 1000 };
    history = recordTokenSpeed(history, { startedAt: 1, speed: speed(2000, first) });
    history = recordTokenSpeed(history, { startedAt: 1, speed: speed(2100, first) });
    history = recordTokenSpeed(history, { startedAt: 1, speed: speed(3500, { index: 2, atMs: 3400, thinkingTokens: 0, outputTokens: 720 }) });
    history = recordTokenSpeed(history, { startedAt: 1, speed: speed(4000, { index: 3, atMs: 3900, outputTokens: 5000 }) });
    expect(history.marks).toEqual([
      { durationMs: 2000, thinkingTokens: 516, requests: 1 },
      { durationMs: 3400, thinkingTokens: 0, requests: 1 },
      { durationMs: 3900, thinkingTokens: null, requests: 1 },
    ]);
    // The turn's share covers the requests that reported a split: 516 of 1,720, not of 6,720.
    expect(formatThinkingShare(history.turnThinkingTokens!, history.turnThinkingOutputTokens!)).toBe('30%');
    // The next turn starts its own share.
    history = recordTokenSpeed(history, { startedAt: 2, speed: speed(900, { index: 1, atMs: 800, thinkingTokens: 0, outputTokens: 200 }) });
    expect([history.turnThinkingTokens, history.turnThinkingOutputTokens]).toEqual([0, 200]);
  });

  it('reads the share so a sliver of reasoning is not shown as none', () => {
    expect(formatThinkingShare(0, 1000)).toBe('0%');
    expect(formatThinkingShare(4, 1000)).toBe('<1%');
    expect(formatThinkingShare(310, 1000)).toBe('31%');
    // No output to divide by: no share, rather than a made-up one.
    expect(formatThinkingShare(0, 0)).toBeNull();
  });

  it('keeps earlier marks and restarts request numbering when the next turn begins', () => {
    let history = recordTokenSpeed(emptyRateHistory(null),
      { startedAt: 1, speed: speed(1500, { index: 1, atMs: 1500, thinkingTokens: 40 }) });
    history = recordTokenSpeed(history,
      { startedAt: 2, speed: speed(1100, { index: 1, atMs: 1000, thinkingTokens: 900 }) });
    expect(history.marks?.map((mark) => mark.thinkingTokens)).toEqual([40, 900]);
    // The second turn continues the axis after the first: its mark is not left of the earlier one.
    expect(history.marks![1].durationMs).toBeGreaterThanOrEqual(history.marks![0].durationMs);
  });

  it('reads a request mark from the wire and drops a malformed one without dropping the speed', () => {
    const base = { rate: 1, average: 1, tokens: 1, elapsedMs: 1, streaming: true };
    expect(readTokenSpeedSnapshot({ ...base, request: { index: 2, atMs: 900, thinkingTokens: 0, outputTokens: 64 } })?.request)
      .toEqual({ index: 2, atMs: 900, thinkingTokens: 0, outputTokens: 64 });
    expect(readTokenSpeedSnapshot({ ...base, request: { index: 0, atMs: 900 } })).toEqual(base);
    expect(readTokenSpeedSnapshot({ ...base, request: { index: 1, atMs: 5, thinkingTokens: -3 } })?.request)
      .toEqual({ index: 1, atMs: 5 });
  });

  it('draws a turn of any length with a fixed number of strokes', () => {
    // 140 requests, one per second; every tenth one thinks.
    const marks = Array.from({ length: 140 }, (_, i) => ({
      durationMs: (i + 1) * 1000, thinkingTokens: i % 10 === 0 ? 1000 : 0, requests: 1,
    }));
    const columns = binThinkingMarks(marks, 0, 140_000, 28);
    expect(columns).toHaveLength(28);
    expect(columns[0]).toEqual({ column: 0, thinkingTokens: 1000 });
    expect(columns.at(-1)?.column).toBe(27);
    expect(columns.reduce((sum, column) => sum + (column.thinkingTokens ?? 0), 0)).toBe(14_000);
    // Three requests stay three strokes; one that reported no split has no amount, not zero.
    expect(binThinkingMarks([
      { durationMs: 1000, thinkingTokens: 512, requests: 1 },
      { durationMs: 50_000, thinkingTokens: null, requests: 1 },
      { durationMs: 100_000, thinkingTokens: 0, requests: 1 },
    ], 0, 100_000, 28).map((column) => [column.column, column.thinkingTokens]))
      .toEqual([[0, 512], [14, null], [27, 0]]);
  });

  it('gives a finished turn no chart when it has neither a curve nor reported reasoning', () => {
    const base = { durationMs: 900, requests: 1, reportedOutputTokens: 0 };
    // One reading is no curve, and -1 means the provider reported no split: an empty frame otherwise.
    expect(traceHasChart({ ...base, speed: [[800, 40]], marks: [[900, -1, 1]] })).toBe(false);
    expect(traceHasChart({ ...base, speed: [[400, 40], [800, 50]], marks: [[900, -1, 1]] })).toBe(true);
    // A reported zero is still something to show: the request answered without thinking.
    expect(traceHasChart({ ...base, speed: [], marks: [[900, 0, 1]] })).toBe(true);
  });

  it('keeps a request without reasoning visible beside a very long think', () => {
    expect(thinkingStrokeLength(0, 20_000, 20, 1.5)).toBe(1.5);
    expect(thinkingStrokeLength(20_000, 20_000, 20, 1.5)).toBe(20);
    // Square-root scale: a think forty times shorter is still a readable stroke, not a sliver.
    expect(thinkingStrokeLength(500, 20_000, 20, 1.5)).toBeGreaterThan(3);
  });
});


// Production recordTokenSpeed, regression #11543: a view opening after several requests
// must recover the host's whole-turn share and marks. Existing cases observe every request.
// Minimal input is one snapshot with index 3 and three completed requests. Tier: unit.
it('restores missed requests and the whole-turn reasoning share from a host trace', () => {
  const trace = { durationMs: 3000, requests: 3, speed: [],
    marks: [[1000, 10, 1], [2000, 20, 1], [3000, 0, 1]] as Array<[number, number, number]>,
    reportedOutputTokens: 100 };
  const speed = { rate: 30, average: 30, tokens: 100, elapsedMs: 3000, streaming: false,
    request: { index: 3, atMs: 3000, thinkingTokens: 0, outputTokens: 30 }, trace };
  const restored = recordTokenSpeed(emptyRateHistory(1), { startedAt: 1, speed });
  expect(restored.turnThinkingTokens).toBe(30);
  expect(restored.turnThinkingOutputTokens).toBe(100);
  expect(restored.marks).toHaveLength(3);
  const repeated = recordTokenSpeed(restored, { startedAt: 1, speed });
  expect(repeated.marks).toEqual(restored.marks);
  expect(readTokenSpeedSnapshot(speed)?.trace).toEqual(trace);
});
