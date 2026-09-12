export interface RateSample {
  /** Cumulative measured generation time across turns, excluding unmeasured gaps. */
  durationMs: number;
  outputTokens: number;
  rate: number;
}

export interface RateHistory {
  startedAt: number | null;
  baseline: { durationMs: number; outputTokens: number } | null;
  samples: RateSample[];
  peak: number;
  latestRate: number | null;
}

export function emptyRateHistory(startedAt: number | null): RateHistory {
  return { startedAt, baseline: null, samples: [], peak: 0, latestRate: null };
}

const MAX_RATE_SAMPLES = 60;

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
  // Reset only the measurement baseline; completed intervals remain in the chart.
  const current = reset ? { ...history, startedAt, baseline: null, latestRate: null } : history;
  if (
    !generationReliable ||
    startedAt === null ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(generationDurationMs) ||
    outputTokens < 0 ||
    generationDurationMs < 0
  ) {
    return current.baseline || current.latestRate !== null
      ? { ...current, baseline: null, latestRate: null }
      : current;
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
  const samples = [
    ...current.samples.slice(-(MAX_RATE_SAMPLES - 1)),
    {
      durationMs: (current.samples.at(-1)?.durationMs ?? 0) + durationDelta,
      outputTokens,
      rate,
    },
  ];
  return {
    startedAt,
    baseline,
    samples,
    peak: Math.max(...samples.map((sample) => sample.rate)),
    latestRate: rate,
  };
}
