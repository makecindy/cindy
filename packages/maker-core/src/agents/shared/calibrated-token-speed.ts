import type { TokenSpeedSnapshot } from '@cindy/maker-shared/usage-format';

/**
 * Live tok/s for harnesses that report real output only when a request ends
 * (Claude Code `message_delta`, Codex `thread/tokenUsage/updated`, Pi
 * `message_end`), measured from the stream and corrected by that usage. Built
 * from recorded streams; replay one with `scripts/token-speed-replay.ts` to see
 * how close the readings are.
 *
 * - Visible deltas (text, tool arguments) arrive evenly; a character-class
 *   estimate lands within a few percent of their real token count.
 * - Thinking reaches the client as a summary about half the size of the real
 *   thinking, in bursts seconds apart, or as provider token estimates when it
 *   is redacted. Either one is scaled to the real thinking tokens that finished
 *   requests report. A summary opens with a few sentences however little was
 *   thought, so its first tokens count for less.
 * - Thinking that streams nothing at all (Codex reasoning) is counted by time, at
 *   the pace finished requests showed such thinking to run.
 * - The clock runs from a request's first byte. Output generated before it
 *   (what arrives with the first byte, a tool call that never streams, thinking
 *   that is reported but never shown) enters no rate, and its generation time
 *   is added back at the speed the stream was measured at. Until a turn has
 *   measured one, the wait for the first byte stands in and is replaced later.
 *
 * `tokens / elapsedMs` always equals `average`, so clients that divide the two
 * themselves read the same number.
 *
 * Display only: never feeds billing, cache or context accounting.
 */
export type SpeedDeltaKind = 'visible' | 'thinking';

/** One finished request, for logs: how far the stream estimate was from the real usage. */
export interface SpeedCalibrationReport {
  requestTokens: number;
  requestMs: number;
  /** Real speed of this request, first byte excluded; undefined when too short to measure. */
  requestTps?: number;
  thinkingTokens?: number;
  estimatedVisible: number;
  estimatedThinking: number;
  visibleScale: number;
  thinkingScale: number;
}

/** Visible output and provider estimates arrive evenly: five seconds read within about ±15%. */
const WINDOW_MS = 5_000;
const MIN_SPAN_MS = 2_000;
/** A thinking summary arrives in bursts seconds apart and needs a longer look to mean anything. */
const SUMMARY_WINDOW_MS = 30_000;
const SUMMARY_MIN_SPAN_MS = 10_000;
const MIN_WINDOW_TOKENS = 5;
/** What a delta of a few tokens arriving in the same millisecond is taken to have spanned. */
const MIN_BURST_SPAN_MS = 100;
/** Output released together with the first byte, or right after a silence, is backlog, not pace. */
const BACKLOG_MS = 300;
/** Shorter pauses are consecutive blocks of one response, not a new request. */
const NEW_REQUEST_PAUSE_MS = 500;
/** No provider generates faster; a reading above it is a flushed burst. */
const MAX_VALID_TPS = 10_000;
/** Below one second a rate is a handful of tokens over a few hundred ms. */
const MIN_VALID_DURATION_MS = 1_000;
/** A request shorter than this is mostly start-up: its speed is not shown as a reading. */
const MIN_READING_REQUEST_MS = 3_000;
const MIN_LEARN_TOKENS = 40;
/** How much of what earlier requests taught survives each new one. */
const SCALE_MEMORY = 0.6;
/** Estimated tokens a starting ratio is worth, so one short request cannot swing it. */
const SCALE_PRIOR_TOKENS = 300;
const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const PUBLISH_INTERVAL_MS = 250;
const COMPACTION_THRESHOLD = 1_024;
/**
 * Real thinking tokens per estimated token of the summary Claude models stream in
 * its place, past the summary's opening. Measured 1.9–2.1 across recorded requests;
 * a starting point only, blended out by the task's own ratio as requests with
 * thinking finish.
 */
export const CLAUDE_THINKING_SUMMARY_SCALE = 2;
/**
 * The opening of each Claude thinking summary: in recorded requests a summary of
 * up to about this many estimated tokens stood for half as many real ones, whatever
 * ratio the long ones had.
 */
export const CLAUDE_SUMMARY_LEAD_TOKENS = 100;
const SUMMARY_LEAD_SCALE = 0.5;
/** Output tokens a Claude tool call spends on its framing, which no delta carries. */
export const CLAUDE_TOOL_CALL_OVERHEAD_TOKENS = 60;

/** Fitted on a few thousand real Claude 5 responses; held-out per-response error p10–p90 0.91–1.16. */
const NARROW_CHARS_PER_TOKEN = 2.14;
const WIDE_TOKENS_PER_CHAR = 1.26;

/** CJK, kana, hangul and full-width forms take more than one token per character. */
function isWideChar(code: number): boolean {
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0xd840 && code <= 0xd87f);
}

/** How many characters of `text` are wide; all the estimate reads from a delta. */
export function countWideChars(text: string): number {
  let wide = 0;
  for (let i = 0; i < text.length; i += 1) if (isWideChar(text.charCodeAt(i))) wide += 1;
  return wide;
}

export function estimateStreamTokens(text: string): number {
  const wide = countWideChars(text);
  return (text.length - wide) / NARROW_CHARS_PER_TOKEN + wide * WIDE_TOKENS_PER_CHAR;
}

const WORD_OR_SYMBOL = /\w+|[^\s\w]/g;

/**
 * One token per word, symbol or CJK character (the `pi-token-speed` estimate):
 * closer than the character fit above for tokenizers other than Claude's.
 */
export function estimateWordTokens(text: string): number {
  return text ? (text.match(WORD_OR_SYMBOL)?.length ?? 0) : 0;
}

export interface TokenSpeedMeterOptions {
  /** Estimated tokens of one streamed delta; calibration scales it to the provider's real count. */
  estimate?: (text: string) => number;
  /** Estimated tokens at the start of each thinking summary that count for less. */
  summaryLeadTokens?: number;
  /**
   * Real thinking tokens per estimated token of streamed thinking, to start from.
   * Left out, thinking is not counted until one request has shown its ratio.
   */
  thinkingScale?: number;
}

/** Real tokens per estimated token, weighted towards the latest requests. */
class Scale {
  private real = 0;
  private estimated = 0;
  value = 1;
  known = false;

  /** A starting value for a ratio nothing has measured yet. */
  assume(value: number): void {
    if (this.known) return;
    this.real = value * SCALE_PRIOR_TOKENS;
    this.estimated = SCALE_PRIOR_TOKENS;
    this.value = value;
    this.known = true;
  }

  learn(real: number, estimated: number): void {
    this.real = this.real * SCALE_MEMORY + real;
    this.estimated = this.estimated * SCALE_MEMORY + estimated;
    this.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.real / this.estimated));
    this.known = true;
  }
}

type Measuring = 'yes' | 'no' | 'undecided';

export class CalibratedTokenSpeedMeter {
  // Calibration outlives a turn: the same task keeps its model and display mode.
  private visibleScale = new Scale();
  /** Summary text to real thinking: unknown until assumed or one request with thinking ends. */
  private thinkingTextScale = new Scale();
  private thinkingCountScale = new Scale();
  /** The last request speed this task measured: what an unmeasurable request is assumed to run at. */
  private lastRequestTps = 0;
  /** Real tokens and clock time of thinking that streamed nothing, for its pace. */
  private silentTokens = 0;
  private silentTokensMs = 0;
  private readonly estimate: (text: string) => number;
  private readonly summaryLeadTokens: number;

  private started = false;
  private stopped = false;
  private paused = false;
  private invalid = false;
  private lastTick = 0;
  private pausedAt = 0;
  /** Generation clock: runs from a request's first block to its end, across every block. */
  private clockMs = 0;
  private clockAtSettle = 0;
  /** Reported time of finished requests: their clock plus the time their first byte hid. */
  private settledMs = 0;
  private settledTokens = 0;
  private liveTokens = 0;
  private liveMs = 0;
  /** Clock time that carried measurable output; the window's time axis. */
  private flowMs = 0;
  private measuring: Measuring = 'yes';
  private undecidedMs = 0;
  private blockKind: SpeedDeltaKind = 'visible';
  /** A summary trails the thinking it describes: its first burst only marks where to measure from. */
  private awaitingSummary = false;
  private summaryLeadLeft = 0;
  private backlogUntilClock = 0;
  private backlogTokens = 0;
  /** Whether this request has streamed anything yet; one that never does arrived whole. */
  private streamed = false;
  private sawThinking = false;
  /** Clock time of this request's thinking blocks that carried nothing measurable. */
  private silentMs = 0;
  /** Requests timed by their wait because no speed was known yet, until one is. */
  private provisionalTokens = 0;
  private provisionalOwnMs = 0;
  private provisionalCreditMs = 0;
  private rawVisible = 0;
  /** Summary past each block's opening: the part the learned ratio applies to. */
  private rawThinkingText = 0;
  private rawThinkingLead = 0;
  private rawThinkingCount = 0;
  /** Every measured delta; one that is backlog carries no tokens and bounds the window. */
  private events: { at: number; tokens: number }[] = [];
  private windowStartIndex = 0;
  private boundaryIndex = -1;
  private boundaryUntil = -Infinity;
  private lastEventAt: number | null = null;
  private tps = 0;
  private peak = 0;
  private lastPublishAt = -Infinity;

  constructor(options: TokenSpeedMeterOptions = {}) {
    this.estimate = options.estimate ?? estimateStreamTokens;
    this.summaryLeadTokens = options.summaryLeadTokens ?? 0;
    if (options.thinkingScale !== undefined) this.thinkingTextScale.assume(options.thinkingScale);
    this.visibleScale.assume(1);
    this.thinkingCountScale.assume(1);
  }

  /** New turn: forget the measurement, keep what the task taught about its token ratios. */
  reset(): void {
    this.started = false;
    this.stopped = false;
    this.paused = false;
    this.invalid = false;
    this.lastTick = 0;
    this.pausedAt = 0;
    this.clockMs = 0;
    this.clockAtSettle = 0;
    this.settledMs = 0;
    this.settledTokens = 0;
    this.flowMs = 0;
    this.measuring = 'yes';
    this.blockKind = 'visible';
    this.awaitingSummary = false;
    this.backlogUntilClock = 0;
    this.events = [];
    this.windowStartIndex = 0;
    this.boundaryIndex = -1;
    this.boundaryUntil = -Infinity;
    this.lastEventAt = null;
    this.tps = 0;
    this.peak = 0;
    this.lastPublishAt = -Infinity;
    this.provisionalTokens = 0;
    this.provisionalOwnMs = 0;
    this.provisionalCreditMs = 0;
    this.clearLive();
  }

  /** Use `scale` for thinking summaries until this task has measured its own ratio. */
  assumeThinkingSummaryScale(scale: number): void {
    this.thinkingTextScale.assume(scale);
  }

  /** The clock is wrong for the rest of this turn (host suspended, time went backwards). */
  invalidate(): void {
    this.invalid = true;
  }

  /** A content block started: the model is generating, whether or not anything streams yet. */
  start(now = Date.now(), kind: SpeedDeltaKind = 'visible'): void {
    if (this.stopped) return;
    this.streamed = true;
    if (!this.started) {
      this.started = true;
      this.lastTick = now;
      this.openRequest();
    } else if (this.paused) {
      this.paused = false;
      this.lastTick = now;
      if (now - this.pausedAt >= NEW_REQUEST_PAUSE_MS) this.openRequest();
    } else {
      this.tick(now);
    }
    this.enterBlock(kind);
  }

  /** One streamed text delta. Returns true when a status refresh is due. */
  recordDelta(text: string, now = Date.now(), kind: SpeedDeltaKind = 'visible'): boolean {
    const raw = this.estimate(text);
    return raw > 0 ? this.record(raw, now, kind, false) : false;
  }

  /**
   * Output known as a token count rather than text: thinking the provider
   * withholds but counts (`thinking_delta.estimated_tokens`), or the framing of
   * a tool call. Returns true when a status refresh is due.
   */
  recordTokens(tokens: number, now = Date.now(), kind: SpeedDeltaKind = 'thinking'): boolean {
    return Number.isFinite(tokens) && tokens > 0 ? this.record(tokens, now, kind, true) : false;
  }

  /** A tool call finished generating, or the provider is backing off: not generation time. */
  pause(now = Date.now()): void {
    if (!this.started || this.stopped || this.paused) return;
    this.tick(now);
    this.paused = true;
    this.pausedAt = now;
  }

  /**
   * A request finished and reported real usage. `turnOutputTokens` is the turn's
   * real output so far, `thinkingTokens` the thinking share of this request, and
   * `requestWallMs` how long the request took from the moment it was sent, when
   * the harness knows. Replaces the stream estimate, learns from the difference,
   * and stops the clock until the next block.
   */
  settle(
    turnOutputTokens: number,
    now = Date.now(),
    thinkingTokens?: number,
    requestWallMs?: number,
  ): SpeedCalibrationReport | undefined {
    if (this.stopped) return undefined;
    if (this.started) {
      this.pause(now);
    } else {
      // The turn's first response never streamed (a tool call that arrives whole).
      this.started = true;
      this.paused = true;
      this.pausedAt = now;
      this.lastTick = now;
    }
    if (!Number.isFinite(turnOutputTokens)) return undefined;
    const requestTokens = turnOutputTokens - this.settledTokens;
    if (requestTokens < 0) return undefined;
    if (requestTokens === 0) {
      // The provider reported nothing billed for this request: what streamed is not output.
      this.discardRequest(now);
      return undefined;
    }
    const requestMs = this.clockMs - this.clockAtSettle;
    const leadThinking = this.rawThinkingLead * SUMMARY_LEAD_SCALE;
    const estimatedThinking = this.rawThinkingText + this.rawThinkingLead + this.rawThinkingCount;
    const reportedThinking = typeof thinkingTokens === 'number' && Number.isFinite(thinkingTokens) && thinkingTokens > 0
      ? Math.min(requestTokens, thinkingTokens) : undefined;
    // Without a reported split, what the visible output does not explain was thinking.
    const realThinking = reportedThinking ??
      (estimatedThinking >= MIN_LEARN_TOKENS
        ? Math.max(0, requestTokens - this.rawVisible * this.visibleScale.value) : 0);
    if ((reportedThinking !== undefined || estimatedThinking < MIN_LEARN_TOKENS) && this.rawVisible >= MIN_LEARN_TOKENS) {
      this.visibleScale.learn(requestTokens - realThinking, this.rawVisible);
    }
    if (realThinking > 0) {
      // A request mixes both thinking sources only across a display change; skip it.
      if (this.rawThinkingText >= MIN_LEARN_TOKENS && this.rawThinkingCount === 0) {
        if (realThinking > leadThinking) this.thinkingTextScale.learn(realThinking - leadThinking, this.rawThinkingText);
      } else if (this.rawThinkingCount >= MIN_LEARN_TOKENS && this.rawThinkingText + this.rawThinkingLead === 0) {
        this.thinkingCountScale.learn(realThinking, this.rawThinkingCount);
      }
    }
    // Output generated before the first byte: what arrived with it, thinking that was
    // reported but never shown, or all of a response that never streamed. Leave it out
    // of this request's speed, then credit its time at the speed the stream is known to run.
    const unseenThinking = reportedThinking !== undefined && !this.sawThinking ? reportedThinking : 0;
    const head = this.streamed
      ? Math.min(requestTokens, this.backlogTokens + unseenThinking) : requestTokens;
    const paced = requestTokens - head;
    let requestTps: number | undefined;
    if (requestMs >= MIN_VALID_DURATION_MS && paced >= MIN_WINDOW_TOKENS) {
      const rate = (paced * 1_000) / requestMs;
      if (rate <= MAX_VALID_TPS) requestTps = rate;
    }
    // Only a measured speed stands in for one that cannot be measured.
    const knownTps = requestTps ?? (this.lastRequestTps || this.tps);
    if (realThinking > 0 && this.silentMs >= MIN_VALID_DURATION_MS && estimatedThinking < MIN_LEARN_TOKENS) {
      this.silentTokens = this.silentTokens * SCALE_MEMORY + realThinking;
      this.silentTokensMs = this.silentTokensMs * SCALE_MEMORY + this.silentMs;
    }
    // The wait between sending and the first byte is all the time there was for it.
    const waitMs = requestWallMs !== undefined && Number.isFinite(requestWallMs)
      ? Math.max(0, requestWallMs - requestMs) : undefined;
    let creditMs: number;
    if (requestTps !== undefined) creditMs = (head * 1_000) / requestTps;
    // Too short to time, or never streamed: assume the speed measured so far.
    else if (knownTps > 0) creditMs = Math.max(0, (requestTokens * 1_000) / knownTps - requestMs);
    // Nothing measured yet: the wait is the only time there is to go by, for now.
    else creditMs = waitMs ?? 0;
    if (waitMs !== undefined) creditMs = Math.min(creditMs, waitMs);
    if (knownTps <= 0 && creditMs > 0) {
      this.provisionalTokens += requestTokens;
      this.provisionalOwnMs += requestMs;
      this.provisionalCreditMs += creditMs;
    } else if (requestTps !== undefined && this.provisionalTokens > 0) {
      // A real speed at last: the requests timed by their wait ran at it too.
      const credit = Math.max(0, (this.provisionalTokens * 1_000) / requestTps - this.provisionalOwnMs);
      this.settledMs -= Math.max(0, this.provisionalCreditMs - credit);
      this.provisionalTokens = 0;
      this.provisionalOwnMs = 0;
      this.provisionalCreditMs = 0;
    }
    const report: SpeedCalibrationReport = {
      requestTokens,
      requestMs,
      ...(requestTps !== undefined ? { requestTps } : {}),
      ...(reportedThinking !== undefined ? { thinkingTokens: reportedThinking } : {}),
      estimatedVisible: this.rawVisible,
      estimatedThinking,
      visibleScale: this.visibleScale.value,
      thinkingScale: this.rawThinkingCount > 0 ? this.thinkingCountScale.value : this.thinkingTextScale.value,
    };
    this.settledTokens = turnOutputTokens;
    this.settledMs += requestMs + creditMs;
    this.clockAtSettle = this.clockMs;
    this.clearLive();
    if (requestTps !== undefined) {
      this.lastRequestTps = requestTps;
      if (requestMs >= MIN_READING_REQUEST_MS) {
        // The exact speed of the request that just ended is the freshest reading there is.
        this.tps = requestTps;
        this.peak = Math.max(this.peak, requestTps);
      }
    }
    return report;
  }

  /** Turn end. `realOutputTokens` replaces the estimate when the provider reported it. */
  stop(realOutputTokens?: number, now = Date.now()): void {
    if (!this.started) return;
    if (!this.stopped) {
      this.pause(now);
      this.stopped = true;
    }
    // Nothing reported beyond the finished requests: what streamed since keeps its estimate.
    if (realOutputTokens === undefined || !(realOutputTokens > this.settledTokens)) return;
    // Usage that only arrived with the turn result still fixes the count and the time.
    this.settledTokens = realOutputTokens;
    this.settledMs += this.clockMs - this.clockAtSettle;
    this.clockAtSettle = this.clockMs;
    this.clearLive();
  }

  /**
   * What streamed since the last finished request cannot be paired with real usage
   * or time (billed nothing, or arrived while tools owned the turn): drop it, keep
   * what finished requests settled, and let the next request time itself from its
   * own first byte.
   */
  discardRequest(now = Date.now()): void {
    if (!this.started || this.stopped) return;
    this.pause(now);
    this.clockAtSettle = this.clockMs;
    this.clearLive();
    this.bound(this.flowMs);
  }

  /** The harness continues the same turn after ending it: keep the totals and measure on. */
  reopen(): void {
    this.stopped = false;
  }

  snapshot(now = Date.now()): TokenSpeedSnapshot | undefined {
    if (!this.started || this.invalid) return undefined;
    const streaming = !this.stopped && !this.paused;
    const sinceTick = streaming ? Math.max(0, now - this.lastTick) : 0;
    // Thinking that streams nothing counts by time, once its pace is known.
    const silentPace = this.silentTokensMs >= MIN_VALID_DURATION_MS ? this.silentTokens / this.silentTokensMs : 0;
    const silentMs = silentPace > 0
      ? this.silentMs + (this.blockKind === 'thinking' && this.measuring !== 'yes' ? sinceTick : 0) : 0;
    const tokens = this.settledTokens + this.liveTokens + silentMs * silentPace;
    if (tokens <= 0) return undefined;
    const elapsedMs = this.settledMs + this.liveMs + silentMs + (this.measuring === 'yes' ? sinceTick : 0);
    // A sub-second measurement has no stable denominator: it would publish a spike.
    const average = elapsedMs >= MIN_VALID_DURATION_MS ? (tokens * 1_000) / elapsedMs : 0;
    return {
      rate: streaming ? this.tps : average,
      average,
      tokens: Math.round(tokens),
      elapsedMs,
      streaming,
      ...(this.peak > 0 ? { peak: this.peak } : {}),
    };
  }

  /** A request's first block: what follows was generated from here on, bar the backlog. */
  private openRequest(): void {
    this.backlogUntilClock = this.clockMs + BACKLOG_MS;
    this.bound(this.flowMs);
    this.boundaryUntil = this.flowMs + BACKLOG_MS;
    this.lastEventAt = this.flowMs;
  }

  private enterBlock(kind: SpeedDeltaKind): void {
    // Thinking and visible output arrive at different rhythms; no window reads across the two.
    if (kind !== this.blockKind) this.bound(this.flowMs);
    this.blockKind = kind;
    if (kind === 'thinking') this.sawThinking = true;
    this.awaitingSummary = kind === 'thinking';
    this.summaryLeadLeft = kind === 'thinking' ? this.summaryLeadTokens : 0;
    this.undecidedMs = 0;
    // Thinking that streams nothing is time without output: it only counts once output shows.
    this.measuring = kind === 'visible' ? 'yes' : 'undecided';
  }

  private tick(now: number): void {
    if (this.started && !this.stopped && !this.paused) {
      const delta = Math.max(0, now - this.lastTick);
      this.clockMs += delta;
      if (this.measuring === 'yes') {
        this.liveMs += delta;
        this.flowMs += delta;
      } else {
        if (this.measuring === 'undecided') this.undecidedMs += delta;
        if (this.blockKind === 'thinking') this.silentMs += delta;
      }
    }
    this.lastTick = now;
  }

  private record(raw: number, now: number, kind: SpeedDeltaKind, counted: boolean): boolean {
    if (this.stopped) return false;
    if (!this.started || this.paused) this.start(now, kind);
    else this.tick(now);
    if (kind !== this.blockKind) this.enterBlock(kind);
    const summary = kind === 'thinking' && !counted;
    const lead = summary ? Math.min(raw, this.summaryLeadLeft) : 0;
    if (kind === 'visible') this.rawVisible += raw;
    else if (counted) this.rawThinkingCount += raw;
    else {
      this.summaryLeadLeft -= lead;
      this.rawThinkingLead += lead;
      this.rawThinkingText += raw - lead;
    }
    if (this.measuring === 'undecided') {
      // Measurable when the provider counts it or its summary ratio is known; the
      // first output then covers the thinking since the block started.
      if (counted || this.thinkingTextScale.known) {
        this.measuring = 'yes';
        this.silentMs -= this.undecidedMs;
        this.liveMs += this.undecidedMs;
        this.flowMs += this.undecidedMs;
      } else {
        this.measuring = 'no';
      }
      this.undecidedMs = 0;
    }
    const scale = kind === 'visible' ? this.visibleScale : counted ? this.thinkingCountScale : this.thinkingTextScale;
    const tokens = lead * SUMMARY_LEAD_SCALE + (raw - lead) * scale.value;
    // Output that cannot be measured still shows the model is at work: keep the status fresh.
    if (this.measuring !== 'yes') return this.publishDue(now);
    const at = this.flowMs;
    const windowMs = summary ? SUMMARY_WINDOW_MS : WINDOW_MS;
    const previousAt = this.lastEventAt;
    // After a silence longer than the window nothing links this output to a pace.
    if ((summary && this.awaitingSummary) || (this.lastEventAt !== null && at - this.lastEventAt > windowMs)) {
      this.boundaryUntil = at + BACKLOG_MS;
    }
    this.awaitingSummary = false;
    this.lastEventAt = at;
    if (this.clockMs < this.backlogUntilClock) {
      this.backlogTokens += tokens;
      this.bound(at);
      return this.publishDue(now);
    }
    this.liveTokens += tokens;
    // A burst faster than any provider generates is output held back and released at once
    // (a summary always arrives that way): it is no pace, and must not join the window or
    // dilute the deltas that follow it.
    const sincePrevious = previousAt === null ? 0 : at - previousAt;
    const arrivalMs = sincePrevious > 0 ? sincePrevious : tokens < MIN_WINDOW_TOKENS ? MIN_BURST_SPAN_MS : 1;
    if (!summary && (tokens * 1_000) / arrivalMs > MAX_VALID_TPS) {
      this.bound(at);
      return this.publishDue(now);
    }
    if (at <= this.boundaryUntil) this.bound(at);
    else this.events.push({ at, tokens });
    const reading = this.windowTps(at, windowMs, summary ? SUMMARY_MIN_SPAN_MS : MIN_SPAN_MS);
    if (reading !== undefined) {
      this.tps = reading;
      this.peak = Math.max(this.peak, reading);
    }
    return this.publishDue(now);
  }

  /** At most four status refreshes a second. */
  private publishDue(now: number): boolean {
    if (now - this.lastPublishAt < PUBLISH_INTERVAL_MS) return false;
    this.lastPublishAt = now;
    return true;
  }

  /** Marks `at` as a point no window may look behind. */
  private bound(at: number): void {
    this.events.push({ at, tokens: 0 });
    this.boundaryIndex = this.events.length - 1;
  }

  /**
   * Tokens in the last `windowMs` over the time since the delta before them: each
   * delta carries what was generated since the previous one. Undefined while there
   * is too little to measure; the last reading stays.
   */
  private windowTps(at: number, windowMs: number, minSpanMs: number): number | undefined {
    const events = this.events;
    while (this.windowStartIndex + 1 < events.length && events[this.windowStartIndex + 1].at <= at - SUMMARY_WINDOW_MS) {
      this.windowStartIndex += 1;
    }
    if (this.windowStartIndex >= COMPACTION_THRESHOLD) {
      events.splice(0, this.windowStartIndex);
      this.boundaryIndex = Math.max(-1, this.boundaryIndex - this.windowStartIndex);
      this.windowStartIndex = 0;
    }
    const lowest = Math.max(this.boundaryIndex, this.windowStartIndex) + 1;
    let first = events.length;
    let tokens = 0;
    while (first > lowest && events[first - 1].at > at - windowMs) {
      first -= 1;
      tokens += events[first].tokens;
    }
    if (first === events.length) return undefined;
    const span = at - events[first - 1].at;
    if (span < minSpanMs || tokens < MIN_WINDOW_TOKENS) return undefined;
    const rate = (tokens * 1_000) / span;
    return rate <= MAX_VALID_TPS ? rate : undefined;
  }

  private clearLive(): void {
    this.liveTokens = 0;
    this.liveMs = 0;
    this.undecidedMs = 0;
    this.backlogTokens = 0;
    this.streamed = false;
    this.sawThinking = false;
    this.silentMs = 0;
    this.rawVisible = 0;
    this.rawThinkingText = 0;
    this.rawThinkingLead = 0;
    this.rawThinkingCount = 0;
  }
}
