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
