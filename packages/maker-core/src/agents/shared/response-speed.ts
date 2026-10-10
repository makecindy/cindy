import type { ResponseSpeedSnapshot, RateSample } from '@cindy/maker-shared/usage-format';

const WINDOW_MS = 1_000;
const WINDOW_BUCKET_MS = 4;
const REFRESH_MS = 250;
const MAX_SAMPLES = 60;

/**
 * Inspired by pi-token-speed's separate wait/stream clocks and usage reconciliation.
 * Original implementation: estimates characters, never treats a transport chunk as a token.
 * Only display facts leave this object; UsageTracker remains the accounting authority.
 */
export class ResponseSpeedTracker {
  private origin: 'turn' | 'stream' = 'turn';
  private startedAt: number | null = null;
  private firstAt: number | null = null;
  private waitingAt: number | null = null;
  private tools = new Set<string>();
  private openAt: number | null = null;
  private closedMs = 0;
  private phase: ResponseSpeedSnapshot['phase'] = 'waiting';
  private retrying = false;
  private retryObserved = false;
  private settledTokens = 0;
  private units = 0;
  private reported: number | null = null;
  private allCalibrated = true;
  private measurable = true;
  private segment = 0;
  private lastSampleAt = 0;
  private lastDeltaAt: number | null = null;
  private window: { time: number; units: number }[] = [];
  private points: (RateSample & { segment: number; units: number })[] = [];

  constructor(origin: 'turn' | 'stream' = 'turn') { this.origin = origin; }

  reset(origin: 'turn' | 'stream', now = Date.now()): void {
    this.origin = origin;
    this.startedAt = now;
    this.waitingAt = now;
    this.tools.clear();
    this.firstAt = this.openAt = null;
    this.closedMs = this.settledTokens = this.units = 0;
    this.reported = null;
    this.allCalibrated = this.measurable = true;
    this.phase = 'waiting';
    this.retrying = this.retryObserved = false;
    this.segment = 0;
    this.lastSampleAt = 0;
    this.lastDeltaAt = null;
    this.window = [];
    this.points = [];
  }

  /** A new request starts waiting again; tools and prompt processing are not generation. */
  beginRequest(now = Date.now()): void {
    if (this.startedAt === null || this.phase === 'complete') this.reset(this.origin, now);
    this.endResponse(undefined, now);
    if (this.origin === 'stream' && this.firstAt === null) this.startedAt = now;
    this.phase = 'waiting';
    this.waitingAt = now;
  }

  content(now = Date.now()): void {
    if (this.startedAt === null || this.phase === 'complete') return;
    if (this.firstAt === null) this.firstAt = now;
    if (this.openAt === null) {
      this.openAt = now;
      this.window = [];
    }
    this.phase = 'generating';
    this.retrying = false;
    this.waitingAt = null;
  }

  delta(text: string, now = Date.now()): boolean {
    if (!text || this.startedAt === null || this.phase === 'complete') return false;
    this.content(now);
    // Additive across arbitrary chunks; no regex word-boundary or per-delta rounding.
    let units = 0;
    for (const character of text) units += character.charCodeAt(0) > 0xff ? 0.67 * character.length : 0.25;
    this.units += units;
    this.reported = null;
    this.lastDeltaAt = now;
    // Fixed bucket boundaries never move forward as new units arrive. At most
    // four milliseconds of the oldest edge expire early; old output cannot
    // keep renewing itself in a high-frequency stream.
    const bucketAt = Math.floor(now / WINDOW_BUCKET_MS) * WINDOW_BUCKET_MS;
    const bucket = this.window.at(-1);
    if (bucket?.time === bucketAt) bucket.units += units;
    else this.window.push({ time: bucketAt, units });
    this.prune(now);
    if (now - this.lastSampleAt < REFRESH_MS) return false;
    this.lastSampleAt = now;
    const rate = this.recent(now);
    if (rate !== null) {
      this.points.push({ durationMs: this.duration(now), outputTokens: this.settledTokens + this.units,
        rate, segment: this.segment, units: this.units });
      this.points = this.points.slice(-MAX_SAMPLES);
    }
    return true;
  }

  pause(now = Date.now()): void {
    if (this.openAt !== null) this.closedMs += Math.max(0, now - this.openAt);
    this.openAt = null;
    if (this.phase !== 'complete') this.phase = 'paused';
    this.window = [];
    this.waitingAt = null;
  }

  /** A native retry event proves automatic recovery, even when no error banner is emitted. */
  beginRetry(now = Date.now()): boolean {
    if (this.startedAt === null) this.reset(this.origin, now);
    if (this.phase === 'complete') return false;
    this.pause(now);
    this.retrying = this.retryObserved = true;
    return true;
  }

  toolStarted(id: string): void { if (id) this.tools.add(id); }
  toolEnded(id: string): boolean { return this.tools.delete(id); }

  reportOutput(output: number | undefined): void {
    if (output !== undefined && Number.isFinite(output) && output >= 0) this.reported = output;
  }

  /** Provider counts for this assistant response, including a legitimate zero. */
  endResponse(output?: number, now = Date.now()): void {
    this.pause(now);
    this.reportOutput(output);
    const count = this.reported ?? this.units;
    if (count > 0 && this.units === 0) this.measurable = false;
    if (this.units > 0) {
      const factor = count / this.units;
      this.points = this.points.map((point) => point.segment === this.segment
        ? { ...point, rate: point.rate * factor,
            outputTokens: this.settledTokens + point.units * factor } : point);
    }
    if (this.reported === null && this.units > 0) this.allCalibrated = false;
    this.settledTokens += count;
    this.units = 0;
    this.reported = null;
    this.segment += 1;
  }

  /** Codex exposes cumulative turn usage, rather than a stable request-end pair. */
  finish(total?: number, now = Date.now()): void {
    if (this.phase === 'complete') return;
    this.endResponse(undefined, now);
    if (total !== undefined && Number.isFinite(total) && total >= 0) {
      if (this.settledTokens > 0) {
        const factor = total / this.settledTokens;
        this.points = this.points.map((point) => ({ ...point,
          rate: point.rate * factor, outputTokens: point.outputTokens * factor }));
      } else if (total > 0) this.measurable = false;
      this.settledTokens = total;
      this.allCalibrated = true;
    }
    this.phase = 'complete';
    this.retrying = false;
  }

  invalidate(): void { this.measurable = false; }

  snapshot(now = Date.now()): ResponseSpeedSnapshot {
    this.prune(now);
    const outputTokens = Math.round(this.settledTokens + (this.reported ?? this.units));
    const durationMs = this.duration(now);
    const averageRate = this.measurable && durationMs > 0
      ? outputTokens * 1_000 / durationMs : null;
    return {
      phase: this.phase, waitOrigin: this.origin,
      firstResponseMs: this.startedAt !== null && this.firstAt !== null
        ? Math.max(0, this.firstAt - this.startedAt) : null,
      waitingMs: this.phase === 'waiting' && this.waitingAt !== null
        ? Math.max(0, now - this.waitingAt) : 0,
      outputTokens, durationMs,
      estimated: !this.allCalibrated || (this.units > 0 && this.reported === null),
      recentRate: this.phase === 'complete' ? averageRate : this.recent(now),
      averageRate,
      samples: this.measurable ? this.points.map(({ durationMs, outputTokens, rate }) =>
        ({ durationMs, outputTokens, rate })) : [],
      sampledAt: now,
      hasRecentOutput: this.phase === 'generating' && this.window.length > 0,
      toolActive: this.tools.size > 0,
      ...(this.retryObserved ? { retrying: this.retrying } : {}),
    };
  }

  private duration(now: number): number {
    return this.closedMs + (this.openAt === null ? 0 : Math.max(0, now - this.openAt));
  }
  private prune(now: number): void {
    this.window = this.window.filter((point) => now - point.time < WINDOW_MS);
    // A monotonic one-second window has at most 251 fixed buckets. Bound even
    // malformed/backwards clocks without renewing discarded output's lifetime.
    if (this.window.length > 256) this.window = this.window.slice(-256);
  }
  private recent(now: number): number | null {
    if (!this.measurable || this.openAt === null || this.lastDeltaAt === null) return null;
    const elapsed = Math.min(WINDOW_MS, Math.max(0, now - this.openAt));
    if (elapsed < WINDOW_MS || this.window.length === 0) return null;
    return this.window.reduce((sum, point) => sum + point.units, 0) * 1_000 / elapsed;
  }
}
