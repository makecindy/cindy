import type { TokenSpeedSnapshot } from '@cindy/maker-shared/usage-format';

/**
 * Live tok/s, ported from the Pi `pi-token-speed` extension (MIT, gsanhueza)
 * with its `estimate` count strategy and `average` end-of-stream behaviour:
 *
 * - one measurement per turn, started by the first content block;
 * - each text / thinking delta (and every tool argument delta) is
 *   counted with the word-boundary estimate `/\w+|[^\s\w]/g`;
 * - current speed = tokens in the last 1s window / time since the token
 *   before them, or since generation resumed (min 100ms); a window with
 *   fewer than 5 tokens keeps the previous reading;
 * - the clock pauses when a tool call ends and resumes when
 *   the next content block starts or the next counted delta arrives;
 * - at turn end the count is snapped to the provider's real output and the
 *   speed becomes total tokens / elapsed generation time.
 *
 * Display only: never feeds billing, cache or context accounting.
 */
const WINDOW_MS = 1_000;
const MIN_SPAN_MS = 100;
/** A window with fewer tokens than this is noise (e.g. one stray token before a summary). */
const MIN_WINDOW_TOKENS = 5;
const COMPACTION_THRESHOLD = 5_000;
const PUBLISH_INTERVAL_MS = 250;
const TOKEN_REGEX = /\w+|[^\s\w]/g;

export function estimateDeltaTokens(text: string): number {
  return text ? (text.match(TOKEN_REGEX)?.length ?? 0) : 0;
}

export class TokenSpeedMeter {
  private started = false;
  private streaming = false;
  private paused = false;
  private tokenCount = 0;
  private startTime = 0;
  private endTime = 0;
  private startPause = 0;
  private pausedMs = 0;
  /** Where the generation clock last (re)started: turn start or the end of a tool pause. */
  private resumedAt = 0;
  private tps = 0;
  private events: { time: number; tokens: number }[] = [];
  private windowStartIndex = 0;
  private lastPublishAt = -Infinity;
  private invalid = false;

  /** New turn: forget the previous measurement. */
  reset(): void {
    this.started = false;
    this.streaming = false;
    this.paused = false;
    this.tokenCount = 0;
    this.startTime = 0;
    this.endTime = 0;
    this.pausedMs = 0;
    this.resumedAt = 0;
    this.tps = 0;
    this.events = [];
    this.windowStartIndex = 0;
    this.lastPublishAt = -Infinity;
    this.invalid = false;
  }

  /**
   * The generation clock is wrong for the rest of this turn (host suspended or
   * the clock went backwards): wall-clock time would dilute the speed, so show none.
   */
  invalidate(): void {
    this.invalid = true;
  }

  /**
   * A content block started. The first one starts the turn's measurement; a
   * later one ends a tool pause, because the model is generating again even
   * when it streams nothing yet (e.g. thinking that is only summarised later).
   */
  start(now = Date.now()): void {
    if (this.started) {
      this.resume(now);
      return;
    }
    this.started = true;
    this.streaming = true;
    this.startTime = now;
    this.endTime = now;
    this.resumedAt = now;
  }

  /** Records one streamed delta. Returns true when a status refresh is due. */
  recordDelta(text: string, now = Date.now()): boolean {
    this.start(now);
    if (!this.streaming) return false;
    const tokens = estimateDeltaTokens(text);
    if (tokens <= 0) return false;
    this.tokenCount += tokens;
    this.events.push({ time: now, tokens });
    if (this.windowStartIndex >= COMPACTION_THRESHOLD) {
      // Keep the event before the window: it bounds the span of the window's first token.
      this.events.splice(0, this.windowStartIndex - 1);
      this.windowStartIndex = 1;
    }
    this.tps = this.windowTps(now) ?? this.tps;
    if (now - this.lastPublishAt < PUBLISH_INTERVAL_MS) return false;
    this.lastPublishAt = now;
    return true;
  }

  /** A tool call finished generating; its execution is not generation time. */
  pause(now = Date.now()): void {
    if (!this.streaming || this.paused) return;
    this.paused = true;
    this.startPause = now;
  }

  private resume(now: number): void {
    if (!this.streaming || !this.paused) return;
    this.paused = false;
    this.pausedMs += now - this.startPause;
    this.resumedAt = now;
    // Pre-pause output must not count toward the post-pause window, whose span starts here.
    this.windowStartIndex = this.events.length;
  }

  /** Turn end. `realOutputTokens` replaces the estimate when the provider reported it. */
  stop(realOutputTokens?: number, now = Date.now()): void {
    if (this.streaming) {
      this.streaming = false;
      // Ending inside a tool pause: the pause is not generation time either.
      this.endTime = this.paused ? this.startPause : now;
      this.events = [];
      this.windowStartIndex = 0;
    }
    if (realOutputTokens !== undefined && Number.isFinite(realOutputTokens) && realOutputTokens > 0) {
      this.tokenCount = realOutputTokens;
    }
  }

  snapshot(now = Date.now()): TokenSpeedSnapshot | undefined {
    if (!this.started || this.invalid || this.tokenCount <= 0) return undefined;
    const elapsedMs = this.elapsedMs(now);
    const average = elapsedMs > 0 ? (this.tokenCount * 1_000) / elapsedMs : 0;
    return {
      rate: this.streaming ? this.tps : average,
      average,
      tokens: Math.round(this.tokenCount),
      elapsedMs,
      streaming: this.streaming,
    };
  }

  private elapsedMs(now: number): number {
    if (!this.started) return 0;
    // An open tool pause is excluded too, so elapsed time never runs backwards on resume.
    const end = !this.streaming ? this.endTime : this.paused ? this.startPause : now;
    return Math.max(0, end - this.startTime - this.pausedMs);
  }

  /** Undefined when the window holds too little to measure; the last reading stays. */
  private windowTps(now: number): number | undefined {
    const windowStart = now - WINDOW_MS;
    while (this.windowStartIndex < this.events.length && this.events[this.windowStartIndex].time < windowStart) {
      this.windowStartIndex += 1;
    }
    if (this.windowStartIndex >= this.events.length) return undefined;
    let windowTokens = 0;
    for (let i = this.windowStartIndex; i < this.events.length; i += 1) windowTokens += this.events[i].tokens;
    if (windowTokens < MIN_WINDOW_TOKENS) return undefined;
    // The first token in the window was generated after the token before it (or after
    // generation resumed), not at its arrival. Pi extends the span this way only when the
    // whole window shares one timestamp; providers also flush stalled or summarised
    // output as several deltas a few ms apart, which would otherwise read as thousands
    // of tok/s.
    const previous = this.windowStartIndex > 0 ? this.events[this.windowStartIndex - 1].time : this.startTime;
    const spanStart = Math.max(previous, this.resumedAt);
    return (1_000 * windowTokens) / Math.max(now - spanStart, MIN_SPAN_MS);
  }
}

/**
 * Codex streams reasoning summaries, not all generated tokens. Measure accepted
 * provider usage against its paired generation clock instead of counting text.
 * Smooth the last three intervals by time, never by averaging their rates.
 */
export class UsageTokenSpeedMeter {
  private tokens = 0;
  private elapsedMs = 0;
  private baseline = { tokens: 0, elapsedMs: 0 };
  private intervals: { tokens: number; elapsedMs: number }[] = [];
  private streaming = true;
  private invalid = false;

  reset(): void {
    this.tokens = 0;
    this.elapsedMs = 0;
    this.baseline = { tokens: 0, elapsedMs: 0 };
    this.intervals = [];
    this.streaming = true;
    this.invalid = false;
  }

  invalidate(): void {
    this.invalid = true;
  }

  recordUsage(tokens: number, elapsedMs: number): void {
    if (this.invalid || !this.streaming) return;
    if (!Number.isFinite(tokens) || !Number.isFinite(elapsedMs) ||
      tokens < this.tokens || elapsedMs < this.elapsedMs) {
      this.invalidate();
      return;
    }
    // Repeated usage cannot pair old tokens with a newer clock.
    if (tokens === this.tokens) return;
    this.tokens = tokens;
    this.elapsedMs = elapsedMs;
    const duration = elapsedMs - this.baseline.elapsedMs;
    if (duration < 1_000) return;
    this.intervals.push({ tokens: tokens - this.baseline.tokens, elapsedMs: duration });
    this.intervals = this.intervals.slice(-3);
    this.baseline = { tokens, elapsedMs };
  }

  stop(): void {
    this.streaming = false;
  }

  snapshot(): TokenSpeedSnapshot | undefined {
    if (this.invalid || this.tokens <= 0 || this.elapsedMs <= 0) return undefined;
    const total = this.intervals.reduce((sum, interval) => ({
      tokens: sum.tokens + interval.tokens,
      elapsedMs: sum.elapsedMs + interval.elapsedMs,
    }), { tokens: 0, elapsedMs: 0 });
    const average = this.tokens * 1_000 / this.elapsedMs;
    return {
      rate: this.streaming ? (total.elapsedMs > 0 ? total.tokens * 1_000 / total.elapsedMs : 0) : average,
      average,
      tokens: this.tokens,
      elapsedMs: this.elapsedMs,
      streaming: this.streaming,
    };
  }
}
