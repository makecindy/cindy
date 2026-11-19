import type { RateMark } from './runningTokenRateHistory.js';

/**
 * How one finished turn ran, kept with its usage details so the chart shown
 * while it ran can be shown again afterwards. Display only.
 *
 * Both series sit on the turn's generation-time axis (model time, without tool
 * runs and waits) and are capped by the host, so the size does not grow with
 * the length of the turn.
 */
export interface GenerationTrace {
  /** Generation time the turn covered. */
  durationMs: number;
  /** Model requests the turn made. */
  requests: number;
  /** Speed readings: `[atMs, tokensPerSecond]`. */
  speed: Array<[number, number]>;
  /**
   * Finished requests: `[atMs, thinkingTokens, requests]`. `thinkingTokens` is -1
   * when the provider reported no split; `requests` is above 1 once the host
   * merged neighbours to stay within its cap.
   */
  marks: Array<[number, number, number]>;
  /**
   * Output tokens, reasoning included, of the requests that reported a reasoning
   * split: what the turn's reasoning is a share of. 0 when none did.
   */
  reportedOutputTokens: number;
}

const MAX_TRACE_ENTRIES = 512;

function finiteAtLeast(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

/** Parse a trace from an agent event or persisted message data; anything malformed drops it whole. */
export function normalizeGenerationTrace(value: unknown): GenerationTrace | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!finiteAtLeast(raw.durationMs, 0) || !finiteAtLeast(raw.requests, 1)) return undefined;
  if (!Array.isArray(raw.speed) || !Array.isArray(raw.marks)) return undefined;
  if (raw.speed.length > MAX_TRACE_ENTRIES || raw.marks.length > MAX_TRACE_ENTRIES) return undefined;
  const speed: GenerationTrace['speed'] = [];
  for (const entry of raw.speed) {
    if (!Array.isArray(entry) || !finiteAtLeast(entry[0], 0) || !finiteAtLeast(entry[1], 0)) return undefined;
    speed.push([entry[0], entry[1]]);
  }
  const marks: GenerationTrace['marks'] = [];
  for (const entry of raw.marks) {
    if (!Array.isArray(entry) || !finiteAtLeast(entry[0], 0) || !finiteAtLeast(entry[1], -1) ||
      !finiteAtLeast(entry[2], 1)) return undefined;
    marks.push([entry[0], entry[1], Math.floor(entry[2])]);
  }
  if (marks.length === 0) return undefined;
  return {
    durationMs: raw.durationMs,
    requests: Math.floor(raw.requests),
    speed,
    marks,
    reportedOutputTokens: finiteAtLeast(raw.reportedOutputTokens, 0) ? raw.reportedOutputTokens : 0,
  };
}

/**
 * Whether a stored trace has anything to draw: a speed curve needs two readings,
 * the strokes need a provider that reported its reasoning split. A short turn
 * from a provider that reports none has neither, and gets no chart at all
 * rather than an empty frame.
 */
export function traceHasChart(trace: GenerationTrace): boolean {
  return trace.speed.length > 1 || trace.marks.some((mark) => mark[1] >= 0);
}

/** The marks of a stored trace in the shape the live chart keeps them. */
export function traceRateMarks(trace: GenerationTrace): RateMark[] {
  return trace.marks.map(([durationMs, thinkingTokens, requests]) => ({
    durationMs,
    thinkingTokens: thinkingTokens < 0 ? null : thinkingTokens,
    requests,
  }));
}

/** One drawn stroke: the requests that finished within one slice of the time axis. */
export interface ThinkingColumn {
  /** Slice position, 0-based from the left. */
  column: number;
  /** Reasoning tokens of those requests; null when none of them reported a split. */
  thinkingTokens: number | null;
}

/**
 * Group marks into at most `columns` equal slices of `[fromMs, toMs]`, so a turn
 * of any length draws at a fixed width. Marks outside the range are not drawn.
 */
export function binThinkingMarks(
  marks: readonly RateMark[],
  fromMs: number,
  toMs: number,
  columns: number,
): ThinkingColumn[] {
  const span = toMs - fromMs;
  const out: ThinkingColumn[] = [];
  for (const mark of marks) {
    if (mark.durationMs < fromMs || mark.durationMs > toMs) continue;
    const column = span > 0
      ? Math.min(columns - 1, Math.floor(((mark.durationMs - fromMs) / span) * columns))
      : columns - 1;
    const last = out.at(-1);
    if (last && last.column === column) {
      if (mark.thinkingTokens !== null) last.thinkingTokens = (last.thinkingTokens ?? 0) + mark.thinkingTokens;
    } else {
      out.push({ column, thinkingTokens: mark.thinkingTokens });
    }
  }
  return out;
}

/**
 * Stroke length for a reasoning amount. Square-root scaled so one very long
 * think does not flatten the rest; a request that reported none still leaves
 * `floor`, so a run of answers given without thinking stays visible.
 */
export function thinkingStrokeLength(tokens: number, maxTokens: number, maxLength: number, floor: number): number {
  if (!(tokens > 0) || !(maxTokens > 0)) return floor;
  return Math.max(floor, Math.sqrt(Math.min(tokens, maxTokens) / maxTokens) * maxLength);
}

/**
 * Reasoning as a share of output, for display: the one number that compares
 * across turns of different lengths. Null when there is no output to divide by.
 */
export function formatThinkingShare(thinkingTokens: number, outputTokens: number): string | null {
  if (!(outputTokens > 0) || !(thinkingTokens >= 0)) return null;
  const percent = Math.min(100, (thinkingTokens / outputTokens) * 100);
  // A sliver of reasoning is not none: keep it apart from a true zero.
  if (percent > 0 && percent < 1) return '<1%';
  return `${Math.round(percent)}%`;
}
