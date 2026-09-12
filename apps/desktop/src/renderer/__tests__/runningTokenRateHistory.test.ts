import { describe, expect, it } from 'vitest';
import {
  emptyRateHistory,
  recordRunningTokenRate,
} from '@/features/cc-agent/lib/runningTokenRateHistory';

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
    expect(recordRunningTokenRate(first, { ...input, startedAt: 2 }).samples).toEqual([]);
    expect(
      recordRunningTokenRate(first, { ...input, outputTokens: 50, generationDurationMs: 500 })
        .samples,
    ).toEqual([]);
    expect(
      recordRunningTokenRate(first, { ...input, generationReliable: false }).baseline,
    ).toBeNull();
    expect(recordRunningTokenRate(first, { ...input, generationDurationMs: NaN }).samples).toEqual(
      [],
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

  it('bounds samples and retains the observed interval peak', () => {
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
    expect(history.samples).toHaveLength(120);
    expect(history.peak).toBe(1000);
  });
});

it('records final usage without losing the completed turn identity, then resets on a new turn', () => {
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
  expect(recordRunningTokenRate(terminal, { ...input, startedAt: 2 }).samples).toEqual([]);
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
