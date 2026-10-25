/**
 * unified-downloader — M5: Progress sampling + speed estimation.
 * ---------------------------------------------------------------------------
 * Progress normalization and throttling are maintained in this module.
 *
 * Produces RAW progress events: no clamping, no smoothing, no anti-rollback —
 * those are caller-side concerns (see updateProgressNormalizer.ts on the
 * UpdateService side).
 *
 * Throttle: emit on max(every 256 KB, every 200 ms).
 * Speed: 5-second sliding window across emit timestamps.
 */

import type { ProgressEvent } from './types.js';

const THROTTLE_BYTES = 256 * 1024;
const THROTTLE_MS = 200;
const SPEED_WINDOW_MS = 5000;

interface SpeedSample {
  ts: number;
  bytes: number;
}

export interface ProgressTrackerOptions {
  initialLoaded: number;
  total: number | null;
  onProgress?: (e: ProgressEvent) => void;
}

export class ProgressTracker {
  private loaded: number;
  private readonly total: number | null;
  private readonly onProgress: ((e: ProgressEvent) => void) | undefined;
  private lastEmitAt = 0;
  private lastEmitBytes: number;
  private samples: SpeedSample[] = [];

  constructor(opts: ProgressTrackerOptions) {
    this.loaded = opts.initialLoaded;
    this.total = opts.total;
    this.onProgress = opts.onProgress;
    this.lastEmitBytes = opts.initialLoaded;
    this.samples.push({ ts: Date.now(), bytes: opts.initialLoaded });
    // Emit once at construction so caller knows the resume point immediately.
    this.emit();
  }

  advance(deltaBytes: number): void {
    this.loaded += deltaBytes;
    const now = Date.now();
    const bytesSinceLastEmit = this.loaded - this.lastEmitBytes;
    const msSinceLastEmit = now - this.lastEmitAt;
    if (bytesSinceLastEmit >= THROTTLE_BYTES || msSinceLastEmit >= THROTTLE_MS) {
      this.emit();
    }
  }

  /** Force a final progress emit (e.g. just before resolve so UI sees 100%). */
  flush(): void {
    this.emit();
  }

  getLoaded(): number {
    return this.loaded;
  }

  private emit(): void {
    const now = Date.now();
    this.lastEmitAt = now;
    this.lastEmitBytes = this.loaded;
    this.samples.push({ ts: now, bytes: this.loaded });
    // Trim samples older than the sliding window.
    const cutoff = now - SPEED_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[0].ts < cutoff) {
      this.samples.shift();
    }

    const speedBps = this.computeSpeed();
    const percent =
      this.total !== null && this.total > 0
        ? (this.loaded / this.total) * 100
        : null;

    try {
      this.onProgress?.({
        loaded: this.loaded,
        total: this.total,
        percent,
        speedBps,
      });
    } catch {
      // Caller callback threw — swallow so the download isn't killed by UI bugs.
    }
  }

  private computeSpeed(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dtSec = (last.ts - first.ts) / 1000;
    if (dtSec < 1) return 0;
    return Math.round((last.bytes - first.bytes) / dtSec);
  }
}
