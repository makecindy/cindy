interface RateCounters {
  durationMs: number;
  outputTokens: number;
}

export interface RateSample extends RateCounters {
  /** Cumulative measured generation time across turns, excluding unmeasured gaps. */
  durationMs: number;
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
  latestRate: number | null;
}

export function emptyRateHistory(startedAt: number | null): RateHistory {
  return { startedAt, baseline: null, lastReport: null, samples: [], peak: 0, latestRate: null };
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
  const previous = history.lastReport;
  const reset =
    history.startedAt !== startedAt ||
    (previous !== null &&
      (generationDurationMs < previous.durationMs || outputTokens < previous.outputTokens));
  // Reset only the measurement baseline; completed intervals remain in the chart.
  const current = reset
    ? { ...history, startedAt, baseline: null, lastReport: null, latestRate: null }
    : history;
  if (
    !generationReliable ||
    startedAt === null ||
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(generationDurationMs) ||
    outputTokens < 0 ||
    generationDurationMs < 0
  ) {
    return current.baseline || current.lastReport || current.latestRate !== null
      ? { ...current, baseline: null, lastReport: null, latestRate: null }
      : current;
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
  // An explicitly empty output stream can still measure zero throughput.
  if (outputTokens > 0 && outputTokens === previous?.outputTokens) return observed;
  if (durationDelta === 0) {
    // A corrected count without a matching time cannot produce a rate.
    return { ...observed, baseline };
  }
  // Keep accumulating both counters, including at completion. An unfinished
  // window must not replace the last valid rate or inflate the observed peak.
  if (durationDelta < MIN_SAMPLE_DURATION_MS) return observed;
  const rate = (tokenDelta * 1000) / durationDelta;
  if (!Number.isFinite(rate)) return { ...observed, baseline };
  const samples = [
    ...current.samples.slice(-(MAX_RATE_SAMPLES - 1)),
    {
      durationMs: (current.samples.at(-1)?.durationMs ?? 0) + durationDelta,
      outputTokens,
      rate,
    },
  ];
  return {
    ...observed,
    baseline,
    samples,
    peak: Math.max(...samples.map((sample) => sample.rate)),
    latestRate: rate,
  };
}

const MAX_CACHED_SESSIONS = 20;

/**
 * 进程内按会话缓存速度历史：切到其他任务再切回同一任务时图表不清零。
 * 刻意不落盘（磁盘持久化超出本功能边界），应用重启后自然清零。
 */
const rateHistoryBySession = new Map<string, RateHistory>();

export function loadCachedRateHistory(sessionKey: string): RateHistory | null {
  const cached = rateHistoryBySession.get(sessionKey);
  if (!cached) return null;
  // Map 按插入序迭代：读到的会话移到队尾，淘汰从队头取最久未用的。
  rateHistoryBySession.delete(sessionKey);
  rateHistoryBySession.set(sessionKey, cached);
  return cached;
}

export function saveCachedRateHistory(sessionKey: string, history: RateHistory): void {
  // 没有采样点就没有可恢复的图表，不必占缓存名额。
  if (history.samples.length === 0) return;
  rateHistoryBySession.delete(sessionKey);
  rateHistoryBySession.set(sessionKey, history);
  while (rateHistoryBySession.size > MAX_CACHED_SESSIONS) {
    const oldestKey = rateHistoryBySession.keys().next().value;
    if (oldestKey === undefined) break;
    rateHistoryBySession.delete(oldestKey);
  }
}

/** 整体清空；供测试与将来的登出/数据清理流程使用。 */
export function clearRateHistoryCache(): void {
  rateHistoryBySession.clear();
}
