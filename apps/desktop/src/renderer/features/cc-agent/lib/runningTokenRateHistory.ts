export interface RateSample {
  durationMs: number;
  outputTokens: number;
  rate: number;
}

export interface RateHistory {
  startedAt: number | null;
  baseline: { durationMs: number; outputTokens: number } | null;
  samples: RateSample[];
  peak: number;
}

export function emptyRateHistory(startedAt: number | null): RateHistory {
  return { startedAt, baseline: null, samples: [], peak: 0 };
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
  const previous = history.baseline;
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
  const baseline = { durationMs: generationDurationMs, outputTokens };
  if (!current.baseline) {
    // Opening midway through a turn must not label its cumulative average as a recent sample.
    return { ...current, baseline };
  }
  const durationDelta = generationDurationMs - current.baseline.durationMs;
  const tokenDelta = outputTokens - current.baseline.outputTokens;
  if (durationDelta === 0 && tokenDelta === 0) return current;
  if (durationDelta === 0) {
    // A corrected count without a matching time cannot produce a rate.
    return { ...current, baseline };
  }
  const rate = (tokenDelta * 1000) / durationDelta;
  if (!Number.isFinite(rate)) return { ...current, baseline };
  return {
    startedAt,
    baseline,
    samples: [...current.samples.slice(-119), { ...baseline, rate }],
    peak: Math.max(current.peak, rate),
  };
}
