import { normalizeGenerationTrace, type GenerationTrace } from './generationTrace.js';

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
export const RATE_SAMPLE_FRESH_MS = 60_000;

/** A finished model request on the chart's time axis (cumulative generation time). */
export interface RateMark {
  durationMs: number;
  /** Reasoning tokens the provider reported for it; null when it reported no split. */
  thinkingTokens: number | null;
  /** How many requests this mark stands for. */
  requests: number;
}

export interface RateHistory {
  startedAt: number | null;
  baseline: RateCounters | null;
  // Track resets even while the measurement baseline waits for a full window.
  lastReport: RateCounters | null;
  samples: RateSample[];
  peak: number;
  latestRate: number | null;
  latestSampleAt?: number;
  /** Host speed mode: chart x-offset of the current turn and its last elapsed time. */
  speedOffsetMs?: number;
  speedElapsedMs?: number;
  /** Host speed mode: requests that finished, oldest first. Old hosts never report any. */
  marks?: RateMark[];
  /** Turn and request index of the newest mark, so a repeated snapshot adds nothing. */
  markStartedAt?: number | null;
  markIndex?: number;
  /**
   * Reasoning and output tokens of this turn's finished requests that reported a
   * reasoning split: the turn's reasoning share so far. Unset until one did.
   */
  turnThinkingTokens?: number;
  turnThinkingOutputTokens?: number;
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
const MAX_RATE_MARKS = 240;

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
        peak: history.startedAt !== startedAt ? 0 : history.peak,
        baseline: null,
        lastReport: null,
        latestRate: null,
        speedOffsetMs: undefined,
        speedElapsedMs: undefined,
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
    peak: Math.max(current.peak, rate),
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

/**
 * Host-measured tok/s (the stream, corrected by the usage each request reports; see
 * maker-core `calibrated-token-speed.ts`). Optional additive status field: old hosts omit it and the
 * counter-based history above stays in charge.
 */
export interface TokenSpeedSnapshot {
  /** Sliding-window rate while streaming; final average once the turn ended. */
  rate: number;
  /** Tokens / elapsed generation time (snapped to real output at turn end). */
  average: number;
  tokens: number;
  /** Generation time excluding tool pauses. */
  elapsedMs: number;
  streaming: boolean;
  /** Highest measured recent speed in this product turn; old hosts omit it. */
  peak?: number;
  /** Display-only cumulative output when some reported tokens had no matching model time. */
  totalOutputTokens?: number;
  /** The newest finished request of this turn; old hosts omit it. */
  request?: TokenSpeedRequestMark;
  /** Bounded host-owned turn history, restores requests missed while this view was absent. */
  trace?: GenerationTrace;
}

/** One finished model request, placed on the same axis as `elapsedMs`. */
export interface TokenSpeedRequestMark {
  /** 1-based position of the request in its turn. */
  index: number;
  /** `elapsedMs` when it finished. */
  atMs: number;
  /** Reasoning tokens the provider reported for it; absent when it reported no split. */
  thinkingTokens?: number;
  /** Its output tokens, reasoning included. */
  outputTokens?: number;
}

function readRequestMark(value: unknown): TokenSpeedRequestMark | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const mark = value as Partial<TokenSpeedRequestMark>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!finite(mark.index) || mark.index < 1 || !finite(mark.atMs)) return undefined;
  return { index: Math.floor(mark.index), atMs: mark.atMs,
    ...(finite(mark.thinkingTokens) ? { thinkingTokens: Math.floor(mark.thinkingTokens) } : {}),
    ...(finite(mark.outputTokens) ? { outputTokens: Math.floor(mark.outputTokens) } : {}) };
}

export function readTokenSpeedSnapshot(value: unknown): TokenSpeedSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const speed = value as Partial<TokenSpeedSnapshot>;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!finite(speed.rate) || !finite(speed.average) || !finite(speed.tokens) ||
    !finite(speed.elapsedMs) || typeof speed.streaming !== 'boolean') return undefined;
  const trace = normalizeGenerationTrace(speed.trace);
  return { rate: speed.rate, average: speed.average, tokens: speed.tokens,
    ...(trace ? { trace } : {}),
    elapsedMs: speed.elapsedMs, streaming: speed.streaming,
    ...(finite(speed.totalOutputTokens) && speed.totalOutputTokens >= speed.tokens
      ? { totalOutputTokens: speed.totalOutputTokens } : {}),
    ...(finite(speed.peak) ? { peak: speed.peak } : {}),
    ...(readRequestMark(speed.request) ? { request: readRequestMark(speed.request) } : {}) };
}

/** Record a host speed snapshot into the same chart model as counter samples. */
export function recordTokenSpeed(
  history: RateHistory,
  input: { startedAt: number | null; speed: TokenSpeedSnapshot; now?: number },
): RateHistory {
  const { speed } = input;
  const startedAt = input.startedAt ?? history.startedAt;
  // A new turn restarts the host clock; keep earlier points and continue the axis after them.
  // Within the same turn, provisional wait credit can be trimmed down once a real speed settles.
  const sameTurn = startedAt !== null && history.startedAt === startedAt;
  const reset = history.startedAt !== startedAt || history.speedOffsetMs === undefined ||
    (!sameTurn && speed.elapsedMs < (history.speedElapsedMs ?? 0));
  const lastSampleDuration = history.samples.at(-1)?.durationMs;
  const baseOffset = reset ? (lastSampleDuration ?? 0) : (history.speedOffsetMs ?? 0);
  // Keep plotted points monotonic when a mid-turn settle rewinds elapsedMs so sampling does not stall.
  const offset = !reset &&
    lastSampleDuration !== undefined &&
    baseOffset + speed.elapsedMs < lastSampleDuration
    ? lastSampleDuration - speed.elapsedMs
    : baseOffset;
  const request = speed.request;
  const newMark = request !== undefined && startedAt !== null &&
    (history.markStartedAt !== startedAt || request.index > (history.markIndex ?? 0));
  const previousMarks = history.marks ?? [];
  const sameMarkTurn = history.markStartedAt === startedAt;
  // A share needs both numbers from the same request.
  const shareTokens = newMark && request.thinkingTokens !== undefined && (request.outputTokens ?? 0) > 0
    ? { thinking: request.thinkingTokens, output: request.outputTokens! } : undefined;
  const next: RateHistory = {
    ...history,
    ...(newMark ? {
      marks: [
        ...previousMarks.slice(-(MAX_RATE_MARKS - 1)),
        {
          // A settle can trim earlier provisional time; a mark never moves left of the one before it.
          durationMs: Math.max(offset + request.atMs, previousMarks.at(-1)?.durationMs ?? 0),
          thinkingTokens: request.thinkingTokens ?? null,
          requests: 1,
        },
      ],
      markStartedAt: startedAt,
      markIndex: request.index,
      turnThinkingTokens: shareTokens
        ? (sameMarkTurn ? history.turnThinkingTokens ?? 0 : 0) + shareTokens.thinking
        : sameMarkTurn ? history.turnThinkingTokens : undefined,
      turnThinkingOutputTokens: shareTokens
        ? (sameMarkTurn ? history.turnThinkingOutputTokens ?? 0 : 0) + shareTokens.output
        : sameMarkTurn ? history.turnThinkingOutputTokens : undefined,
    } : {}),
    ...(speed.trace ? {
      marks: [
        ...(sameMarkTurn ? previousMarks.filter((mark) => mark.durationMs <= baseOffset) : previousMarks),
        ...speed.trace.marks.map(([atMs, thinking, requests]) => ({
          durationMs: offset + atMs, thinkingTokens: thinking < 0 ? null : thinking, requests,
        })),
      ].slice(-MAX_RATE_MARKS),
      markStartedAt: startedAt,
      markIndex: speed.trace.requests,
      turnThinkingTokens: speed.trace.reportedOutputTokens > 0
        ? speed.trace.marks.reduce((sum, mark) => sum + Math.max(0, mark[1]), 0) : undefined,
      turnThinkingOutputTokens: speed.trace.reportedOutputTokens || undefined,
    } : {}),
    startedAt,
    baseline: null,
    lastReport: null,
    speedOffsetMs: offset,
    speedElapsedMs: speed.elapsedMs,
    peak: Math.max(history.startedAt !== startedAt ? 0 : history.peak, speed.peak ?? 0,
      speed.streaming ? speed.rate : 0),
    // The final average has its own UI field. It is not a new recent-speed sample.
    // While a new request warms up (streaming with rate 0), clear any stale previous-request rate.
    latestRate: speed.streaming
      ? (speed.rate > 0 ? speed.rate : null)
      : (reset ? null : history.latestRate),
    latestSampleAt: speed.streaming
      ? (speed.rate > 0 ? (input.now ?? Date.now()) : undefined)
      : (reset ? undefined : history.latestSampleAt),
  };
  const at = offset + speed.elapsedMs;
  const lastAt = reset ? offset : (lastSampleDuration ?? offset);
  if (!speed.streaming || speed.rate <= 0 || at - lastAt < MIN_SAMPLE_DURATION_MS) return next;
  const samples = [
    ...history.samples.slice(-(MAX_RATE_SAMPLES - 1)),
    { durationMs: at, outputTokens: speed.tokens, rate: speed.rate },
  ];
  return { ...next, samples };
}
