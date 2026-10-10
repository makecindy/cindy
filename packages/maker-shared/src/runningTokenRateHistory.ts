interface RateCounters {
  durationMs: number;
  outputTokens: number;
}

/** Display-only stream measurement. Never use these counters for billing or context. */
export interface ResponseSpeedSnapshot {
  phase: 'waiting' | 'generating' | 'paused' | 'complete';
  /** Local provider-turn start, or SDK stream start (not network TTFT). */
  waitOrigin: 'turn' | 'stream';
  firstResponseMs: number | null;
  waitingMs: number;
  outputTokens: number;
  durationMs: number;
  estimated: boolean;
  recentRate: number | null;
  averageRate: number | null;
  samples: RateSample[];
  sampledAt: number;
  /** Fresh observed output, including warm-up before the first full rate window. */
  hasRecentOutput?: boolean;
  /** Explicit native tool execution, distinct from streamed tool arguments. */
  toolActive?: boolean;
  /** Display annotation from an explicit terminal event, never inferred from silence. */
  outcome?: 'failed' | 'cancelled';
  /** True requires an explicit retry event; false can acknowledge native recovery. */
  retrying?: boolean;
}

export function responseSpeedActivity(speed: ResponseSpeedSnapshot, now = Date.now()):
  'waiting' | 'generating' | 'quiet' | 'tool' | 'paused' | 'complete' | 'failed' | 'cancelled' | 'retrying' {
  if (speed.phase === 'complete') return speed.outcome ?? 'complete';
  if (speed.retrying) return 'retrying';
  if (speed.phase === 'waiting') return 'waiting';
  if (speed.phase === 'paused') return speed.toolActive ? 'tool' : 'paused';
  return now - speed.sampledAt < RATE_SAMPLE_FRESH_MS &&
    (speed.hasRecentOutput ?? speed.recentRate !== null) ? 'generating' : 'quiet';
}

export function responseSpeedHistory(speed: ResponseSpeedSnapshot, now = Date.now()): RateHistory {
  return {
    ...emptyRateHistory(null),
    samples: speed.samples,
    peak: Math.max(0, ...speed.samples.map((sample) => sample.rate)),
    latestRate: speed.outcome || speed.retrying || (speed.phase === 'generating' && now - speed.sampledAt >= RATE_SAMPLE_FRESH_MS) ? null : speed.recentRate,
    latestSampleAt: speed.sampledAt,
  };
}

/** Optional additive wire field: old hosts simply omit it. Reject malformed peer data. */
export function readResponseSpeedSnapshot(value: unknown, observedAt?: number): ResponseSpeedSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const speed = value as ResponseSpeedSnapshot;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!['waiting', 'generating', 'paused', 'complete'].includes(speed.phase) ||
    !['turn', 'stream'].includes(speed.waitOrigin) || typeof speed.estimated !== 'boolean' ||
    !finite(speed.waitingMs) || !finite(speed.outputTokens) || !finite(speed.durationMs) ||
    !finite(speed.sampledAt) || (speed.hasRecentOutput !== undefined && typeof speed.hasRecentOutput !== 'boolean') ||
    (speed.toolActive !== undefined && typeof speed.toolActive !== 'boolean') ||
    (speed.outcome !== undefined && !['failed', 'cancelled'].includes(speed.outcome)) ||
    (speed.retrying !== undefined && typeof speed.retrying !== 'boolean') ||
    (speed.firstResponseMs !== null && !finite(speed.firstResponseMs)) ||
    (speed.recentRate !== null && !finite(speed.recentRate)) ||
    (speed.averageRate !== null && !finite(speed.averageRate)) || !Array.isArray(speed.samples)) return undefined;
  return { ...speed, sampledAt: observedAt ?? speed.sampledAt, samples: speed.samples.slice(-60).filter((point) =>
    point && finite(point.durationMs) && finite(point.outputTokens) && finite(point.rate)) };
}

/** Terminal errors/abort can lack a final provider snapshot. Freeze the last observation. */
export function stopResponseSpeed(speed: ResponseSpeedSnapshot | undefined, outcome?: ResponseSpeedSnapshot['outcome']): ResponseSpeedSnapshot | undefined {
  if (!speed || (speed.phase === 'complete' && (!outcome || speed.outcome === outcome))) return speed;
  const terminalOutcome = outcome ?? speed.outcome;
  return { ...speed, phase: 'complete', ...(terminalOutcome ? { outcome: terminalOutcome } : {}), retrying: false,
    recentRate: terminalOutcome ? null : speed.averageRate,
    estimated: Boolean(terminalOutcome) || speed.estimated || speed.phase === 'generating' || speed.phase === 'waiting' };
}

/** Pause displayed generation only after an explicit automatic retry event. */
export function retryResponseSpeed(speed: ResponseSpeedSnapshot | undefined): ResponseSpeedSnapshot | undefined {
  if (!speed || speed.phase === 'complete') return speed;
  return { ...speed, phase: 'paused', retrying: true, recentRate: null,
    hasRecentOutput: false };
}

/** Actual output ends the retry annotation without inventing a throughput sample. */
export function resumeResponseSpeed(speed: ResponseSpeedSnapshot | undefined): ResponseSpeedSnapshot | undefined {
  return speed?.retrying && speed.phase !== 'complete'
    ? { ...speed, phase: speed.toolActive ? 'paused' : 'generating', retrying: false, hasRecentOutput: false, recentRate: null }
    : speed;
}

/** Preserve terminal/retry annotations across ordinary status tails; a new turn clears them. */
export function mergeResponseSpeedStatus(previous: ResponseSpeedSnapshot | undefined,
  incoming: ResponseSpeedSnapshot | undefined, isRunning: boolean, isTurnStart: boolean): ResponseSpeedSnapshot | undefined {
  const baseline = isTurnStart ? undefined : previous;
  const next = incoming ?? baseline;
  if (!isRunning) return stopResponseSpeed(next, baseline?.outcome);
  if (baseline?.retrying && next && incoming?.retrying !== false) {
    // Usage calibration can raise tokens without any new output. Only a new
    // stream sample or explicit tool execution can recover a status-only view.
    const newSample = next.hasRecentOutput === true &&
      (next.samples.at(-1)?.durationMs ?? 0) > (baseline.samples.at(-1)?.durationMs ?? 0);
    if (!(next.toolActive && !baseline.toolActive) && !newSample) return retryResponseSpeed({ ...next, phase: 'paused' });
  }
  return next;
}

/** A finalized speed denominator may only pair with the same real output count. */
export function calibratedResponseDuration(value: unknown, outputTokens: number): number | undefined {
  const speed = readResponseSpeedSnapshot(value);
  return speed?.phase === 'complete' && !speed.outcome && !speed.estimated && speed.averageRate !== null &&
    speed.outputTokens === outputTokens && speed.durationMs > 0 ? speed.durationMs : undefined;
}

export interface RateSample extends RateCounters {
  /** Cumulative measured generation time across turns, excluding unmeasured gaps. */
  durationMs: number;
  rate: number;
}

// Millisecond-scale usage batches are not meaningful throughput measurements.
const MIN_SAMPLE_DURATION_MS = 1000;
export const RATE_SAMPLE_FRESH_MS = 1_000;

export interface RateHistory {
  startedAt: number | null;
  baseline: RateCounters | null;
  // Track resets even while the measurement baseline waits for a full window.
  lastReport: RateCounters | null;
  samples: RateSample[];
  peak: number;
  latestRate: number | null;
  latestSampleAt?: number;
}

export function emptyRateHistory(startedAt: number | null): RateHistory {
  return {
    startedAt,
    baseline: null,
    lastReport: null,
    samples: [],
    peak: 0,
    latestRate: null,
  };
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
    now?: number;
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
      (generationDurationMs < previous.durationMs ||
        outputTokens < previous.outputTokens));
  // Reset only the measurement baseline; completed intervals remain in the chart.
  const current = reset
    ? {
        ...history,
        startedAt,
        baseline: null,
        lastReport: null,
        latestRate: null,
      }
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
  if (outputTokens > 0 && outputTokens === previous?.outputTokens)
    return observed;
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
    latestSampleAt: input.now ?? Date.now(),
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

export function saveCachedRateHistory(
  sessionKey: string,
  history: RateHistory,
): void {
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
