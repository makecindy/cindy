interface RateCounters {
  durationMs: number;
  outputTokens: number;
}

export interface RateSample extends RateCounters {
  rate: number;
}

// Millisecond-scale usage batches are not meaningful throughput measurements.
const MIN_SAMPLE_DURATION_MS = 1000;

export interface RateHistory {
  startedAt: number | null;
  baseline: RateCounters | null;
  // Track resets even while the measurement baseline waits for a full window.
  lastReport: RateCounters | null;
  samples: RateSample[];
  peak: number;
}

export function emptyRateHistory(startedAt: number | null): RateHistory {
  return { startedAt, baseline: null, lastReport: null, samples: [], peak: 0 };
}

/** Real usage reports are sparse: this is the latest measured interval, not an instantaneous rate. */
export function recordRunningTokenRate(
  history: RateHistory,
  input: {
    startedAt: number | null;
    outputTokens: number;
    generationDurationMs: number;
    generationReliable: boolean;
  },
): RateHistory {
  const { outputTokens, generationDurationMs, generationReliable } = input;
  // Terminal status clears startedAt before the status bar finishes its linger/fade.
  // Keep its identity so a final paired usage report can still be recorded.
  const startedAt = input.startedAt ?? history.startedAt;
  const previous = history.lastReport;
  const reset =
    history.startedAt !== startedAt ||
    (previous !== null &&
      (generationDurationMs < previous.durationMs || outputTokens < previous.outputTokens));
  const current = reset ? emptyRateHistory(startedAt) : history;
  if (
    !generationReliable ||
    startedAt === null ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(generationDurationMs) ||
    outputTokens < 0 ||
    generationDurationMs < 0
  ) {
    return current.baseline || current.samples.length ? emptyRateHistory(startedAt) : current;
  }
  if (
    previous?.durationMs === generationDurationMs &&
    previous.outputTokens === outputTokens &&
    !reset
  ) {
    return current;
  }
  const baseline = { durationMs: generationDurationMs, outputTokens };
  const observed = { ...current, lastReport: baseline };
  if (!current.baseline) {
    // Opening midway through a turn must not label its cumulative average as a recent sample.
    return { ...observed, baseline };
  }
  const durationDelta = generationDurationMs - current.baseline.durationMs;
  const tokenDelta = outputTokens - current.baseline.outputTokens;
  // A time-only refresh cannot close a token interval: the matching usage may
  // arrive later in a batch. Keep both counters anchored to the last sample.
  if (outputTokens === previous?.outputTokens) return observed;
  if (durationDelta === 0) {
    // A corrected count without a matching time cannot produce a rate.
    return { ...observed, baseline };
  }
  // Keep accumulating both counters, including at completion. An unfinished
  // window must not replace the last valid rate or inflate the observed peak.
  if (durationDelta < MIN_SAMPLE_DURATION_MS) return observed;
  const rate = (tokenDelta * 1000) / durationDelta;
  if (!Number.isFinite(rate)) return { ...observed, baseline };
  return {
    ...observed,
    baseline,
    samples: [...current.samples.slice(-119), { ...baseline, rate }],
    peak: Math.max(current.peak, rate),
  };
}
