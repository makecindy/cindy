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
 *   fewer than 5 tokens keeps the previous reading, and a reading above
 *   10 000 tok/s is discarded as a flushed burst, never shown as a spike and
 *   never counted towards the following windows either;
 * - the clock pauses when a tool call ends and resumes when
 *   the next content block starts or the next counted delta arrives;
 * - at turn end the count is snapped to the provider's real output and the
 *   speed becomes total tokens / elapsed generation time.
 *
 * Display only: never feeds billing, cache or context accounting.
 */
const WINDOW_MS = 1_000;
const MIN_SPAN_MS = 100;
/**
 * No provider generates faster than this. A window reading above it is not a
 * measurement but a held/queued burst being flushed in one frame (e.g. output
 * released after a stall or a hidden thinking block), so it is discarded rather
 * than shown as a spike. Mirrors magpie's `MaxDecodeSpeed` guard.
 */
const MAX_VALID_TPS = 10_000;
/**
 * Below one second the turn average is not a measurement: dividing a handful of
 * tokens by a few hundred ms reads as thousands of tok/s. Same threshold the
 * desktop renderer uses (`formatOutputTokenRateValue`) and magpie's `MinDecodeMs`.
 */
const MIN_VALID_DURATION_MS = 1_000;
/** A window with fewer tokens than this is noise (e.g. one stray token before a summary). */
const MIN_WINDOW_TOKENS = 5;
const COMPACTION_THRESHOLD = 5_000;
const PUBLISH_INTERVAL_MS = 250;
const TOKEN_REGEX = /\w+|[^\s\w]/g;

function isRealOutput(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

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
  private peak = 0;
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
    this.peak = 0;
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

    // Detect single-frame held bursts: when a vendor flushes a large block
    // much faster than any real generation speed, it must not join the live
    // sliding window or dilute/pollute subsequent genuine deltas.
    const lastTime = this.events.length > 0 ? this.events[this.events.length - 1].time : this.startTime;
    const deltaSpan = Math.max(0, now - Math.max(lastTime, this.resumedAt));
    const arrivalSpan = deltaSpan > 0 ? deltaSpan : tokens < MIN_WINDOW_TOKENS ? MIN_SPAN_MS : 1;
    if ((tokens * 1_000) / arrivalSpan > MAX_VALID_TPS) {
      this.windowStartIndex = this.events.length;
      this.resumedAt = now;
      if (now - this.lastPublishAt < PUBLISH_INTERVAL_MS) return false;
      this.lastPublishAt = now;
      return true;
    }

    this.events.push({ time: now, tokens });
    if (this.windowStartIndex >= COMPACTION_THRESHOLD) {
      // Keep the event before the window: it bounds the span of the window's first token.
      this.events.splice(0, this.windowStartIndex - 1);
      this.windowStartIndex = 1;
    }
    const tps = this.windowTps(now);
    if (tps !== undefined) {
      this.tps = tps;
      this.peak = Math.max(this.peak, tps);
    }
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
    if (isRealOutput(realOutputTokens)) this.setOutputTokens(realOutputTokens);
  }

  /**
   * Turn progress: replace the streamed estimate with the provider's real output
   * for this turn. The estimate is only a stand-in, so a smaller real value must
   * calibrate it downwards too — otherwise a tool round that streamed text the
   * provider did not bill keeps inflating the count.
   */
  syncOutputTokens(realOutputTokens?: number): void {
    // A real provider total replaces the estimate in either direction, including
    // zero: a tool round that streamed text the provider did not bill must not
    // keep a non-zero count alive.
    if (realOutputTokens === undefined || !Number.isFinite(realOutputTokens)) return;
    this.setOutputTokens(Math.max(0, realOutputTokens));
  }

  /**
   * Exact calibration: `realOutputTokens` is the turn's output as reported by the
   * provider, not a delta. Streaming estimates and the live window readings must
   * not survive a correction that moves the count either way.
   */
  setOutputTokens(realOutputTokens: number): void {
    if (!Number.isFinite(realOutputTokens) || realOutputTokens < 0) return;
    if (realOutputTokens === this.tokenCount) return;
    this.tokenCount = realOutputTokens;
    // The window still describes estimated deltas; a calibrated count invalidates it.
    this.events = [];
    this.windowStartIndex = 0;
    this.tps = 0;
  }

  snapshot(now = Date.now()): TokenSpeedSnapshot | undefined {
    if (!this.started || this.invalid || this.tokenCount <= 0) return undefined;
    const elapsedMs = this.elapsedMs(now);
    // A sub-second turn has no stable denominator: publishing it would report a
    // spike, so the average stays 0 (`rate` follows it while not streaming).
    const average = elapsedMs >= MIN_VALID_DURATION_MS ? (this.tokenCount * 1_000) / elapsedMs : 0;
    const isStreaming = this.streaming && !this.paused;
    return {
      rate: isStreaming ? this.tps : average,
      average,
      tokens: Math.round(this.tokenCount),
      elapsedMs,
      streaming: isStreaming,
      ...(this.peak > 0 ? { peak: this.peak } : {}),
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
    const span = now - spanStart;
    // A whole held burst landing in a few ms reads far above any real decode
    // speed; treat it as unmeasurable so the previous reading stays. Drop it
    // from later windows so the next genuine delta does not divide the whole
    // burst by its own short gap (e.g. 180 tokens over 110ms reads 1 600 tok/s).
    if ((1_000 * windowTokens) / Math.max(span, 1) > MAX_VALID_TPS) {
      this.windowStartIndex = this.events.length;
      this.resumedAt = now;
      return undefined;
    }
    if (span < MIN_SPAN_MS) return undefined;
    return (1_000 * windowTokens) / span;
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
  private peak = 0;
  private source = { tokens: 0, elapsedMs: 0 };
  private baseline = { tokens: 0, elapsedMs: 0 };
  private intervals: { tokens: number; elapsedMs: number }[] = [];
  private streaming = true;
  private invalid = false;
  private paired = true;
  private observed = false;
  /** A native turn with missing timing cannot attach its full billed output to a duration. */
  private completeSegment = true;

  reset(): void {
    this.tokens = 0;
    this.elapsedMs = 0;
    this.peak = 0;
    this.intervals = [];
    this.startSegment();
  }

  /** Native continuation: its counters restart together; measured product-turn totals remain. */
  startSegment(): void {
    this.source = { tokens: 0, elapsedMs: 0 };
    this.baseline = { tokens: this.tokens, elapsedMs: this.elapsedMs };
    this.streaming = true;
    this.invalid = false;
    this.paired = true;
    this.observed = false;
    this.completeSegment = true;
  }

  isReliable(): boolean {
    return !this.invalid && this.paired;
  }

  isSegmentComplete(): boolean {
    return this.completeSegment && !this.invalid;
  }

  invalidate(): void {
    this.invalid = true;
  }

  recordUsage(tokens: number, elapsedMs: number): void {
    if (this.invalid || !this.streaming) return;
    if (!Number.isFinite(tokens) || !Number.isFinite(elapsedMs) ||
      tokens < this.source.tokens || elapsedMs < this.source.elapsedMs) {
      this.invalidate();
      return;
    }
    // Repeated usage cannot pair old tokens with a newer clock.
    if (tokens === this.source.tokens) return;
    const tokenDelta = tokens - this.source.tokens;
    const durationDelta = elapsedMs - this.source.elapsedMs;
    this.source = { tokens, elapsedMs };
    if (durationDelta === 0) {
      // Code-mode/background tools can leave the generation clock paused while
      // output keeps arriving. Drop this unpaired interval from BOTH statistics;
      // never attach its tokens to the next interval's time or to the average.
      this.paired = false;
      this.completeSegment = false;
      this.intervals = [];
      this.baseline = { tokens: this.tokens, elapsedMs: this.elapsedMs };
      return;
    }
    this.paired = true;
    this.observed = true;
    this.tokens += tokenDelta;
    this.elapsedMs += durationDelta;
    const duration = this.elapsedMs - this.baseline.elapsedMs;
    if (duration < 1_000) return;
    this.intervals.push({ tokens: this.tokens - this.baseline.tokens, elapsedMs: duration });
    this.intervals = this.intervals.slice(-3);
    this.baseline = { tokens: this.tokens, elapsedMs: this.elapsedMs };
    const total = this.recentTotal();
    this.peak = Math.max(this.peak, total.tokens * 1_000 / total.elapsedMs);
  }

  stop(): void {
    this.streaming = false;
  }

  private recentTotal(): { tokens: number; elapsedMs: number } {
    return this.intervals.reduce((sum, interval) => ({
      tokens: sum.tokens + interval.tokens,
      elapsedMs: sum.elapsedMs + interval.elapsedMs,
    }), { tokens: 0, elapsedMs: 0 });
  }

  snapshot(): TokenSpeedSnapshot | undefined {
    if (!this.isReliable() || !this.observed || this.tokens <= 0 || this.elapsedMs <= 0) return undefined;
    const total = this.recentTotal();
    const average = this.tokens * 1_000 / this.elapsedMs;
    return {
      rate: this.streaming ? (total.elapsedMs > 0 ? total.tokens * 1_000 / total.elapsedMs : 0) : average,
      average,
      tokens: this.tokens,
      elapsedMs: this.elapsedMs,
      streaming: this.streaming,
      peak: this.peak,
    };
  }
}
