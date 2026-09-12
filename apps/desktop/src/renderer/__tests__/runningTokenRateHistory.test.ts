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

  it('bounds samples and excludes evicted samples from the observed peak', () => {
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
    expect(history.peak).toBe(1);
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
    outputTokens: 20,
    generationDurationMs: 500,
  });
  expect(next.samples.map((sample) => sample.rate)).toEqual([100, 50, 40]);
  expect(next.samples.map((sample) => sample.durationMs)).toEqual([1000, 2000, 2500]);
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
