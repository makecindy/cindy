import { REMOTE_DESKTOP_MAX_FRAME_BYTES } from '@cindy/device-link';

/** The slice of Electron's NativeImage a tab frame needs. */
export interface TabImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality?: 'good' | 'better' | 'best';
  }): TabImage;
  toJPEG(quality: number): Buffer;
  /** Raw BGRA pixels, rows tight (`width * 4`); only used to notice that nothing changed. */
  toBitmap?(): Buffer;
}
export interface CaptureGuest {
  isDestroyed(): boolean;
  capturePage(): Promise<TabImage>;
}

/** Longest edge of a sent frame, in pixels. */
export const PREVIEW_FRAME_MAX_EDGE = 1280;
/** One `capturePage` that takes longer than this is abandoned (the call itself cannot be cancelled). */
export const PREVIEW_CAPTURE_TIMEOUT_MS = 2_000;
/** Captures that keep failing or hanging for this long (from the first failure) mean the tab can no longer be captured. */
export const PREVIEW_CAPTURE_UNAVAILABLE_MS = 6_000;
/** Abandoned `capturePage` calls still pending in Chromium; more than this means it is wedged. */
const MAX_PENDING_CAPTURES = 3;

/** `capturePage` cannot go faster than this however much the viewer asks for. */
export const PREVIEW_MAX_STREAM_FPS = 30;
/** Pull period once the picture has been still for a while (5 fps). */
export const PREVIEW_STILL_INTERVAL_MS = 200;
/** A background viewer (picture-in-picture) never gets more than 10 fps. */
export const PREVIEW_BACKGROUND_MIN_INTERVAL_MS = 100;
/** How long the full rate lasts after the last seen change. */
export const PREVIEW_ACTIVE_HOLD_MS = 1_500;
/** How long the full rate lasts after input reached the tab (and after the lease began). */
export const PREVIEW_INPUT_ACTIVE_MS = 2_000;
/** A still picture is re-sent from the cache at this period so the viewer's watchdog is fed. */
export const PREVIEW_RESEND_MS = 1_000;
/**
 * Even a picture that looks unchanged is captured and encoded for real this often: the
 * change check samples a grid, and this bounds how long a change between grid points can
 * go unseen.
 */
export const PREVIEW_FULL_REFRESH_MS = 3_000;
/** Sample spacing of the change check, in device pixels (and the cap on samples). */
const SAMPLE_STEP = 12;
const MAX_SAMPLES = 16_384;
/** Relay frames are small and uncommon: the old fixed quality. */
const RELAY_JPEG_QUALITY = 0.55;

export interface TabCaptureOptions {
  guest(): CaptureGuest | null;
  /** The tab is still the one this lease was granted for. */
  isCurrent(): boolean;
  /** Capture keeps failing or hanging beyond the budget; called once, then the source is stopped. */
  onUnavailable(): void;
  /** One `capturePage` outlived its timeout (the picture may have stopped being produced). */
  onStall?(): void;
  now?(): number;
  /** Waiting between pulls; tests drive the clock with it. */
  sleep?(ms: number): Promise<void>;
  timeoutMs?: number;
  unavailableAfterMs?: number;
  /** Quality (0..1) of relay frames. */
  jpegQuality?: number;
}

/**
 * What a frame is for. `stream` feeds the local WebRTC pipeline: one encode at the profile's
 * quality and size budget, unchanged pictures skipped, pull rate adapted. `relay` is the
 * compatibility fallback: small budget, every call is a real capture.
 */
export type FrameRequest =
  { purpose: 'relay' } | { purpose: 'stream'; fps: number; quality: number; maxBytes: number };

/** Scales to the frame budget: long edge ≤ 1280, JPEG ≤ `maxBytes` (re-encoding while over). */
export function encodeTabFrame(
  image: TabImage,
  jpegQuality = 0.65,
  maxBytes = REMOTE_DESKTOP_MAX_FRAME_BYTES,
): string | null {
  if (image.isEmpty()) return null;
  let current = image;
  const { width, height } = current.getSize();
  if (width < 1 || height < 1) return null;
  const edge = Math.max(width, height);
  if (edge > PREVIEW_FRAME_MAX_EDGE) {
    const scale = PREVIEW_FRAME_MAX_EDGE / edge;
    current = current.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good',
    });
  }
  let quality = Math.min(100, Math.max(30, Math.round(jpegQuality * 100)));
  for (let attempt = 0; attempt < 5; attempt++) {
    const jpeg = current.toJPEG(quality);
    if (jpeg.length > 0 && jpeg.length <= maxBytes) return jpeg.toString('base64');
    if (quality > 40) {
      quality = Math.max(30, quality - 20);
      continue;
    }
    const size = current.getSize();
    current = current.resize({
      width: Math.max(1, Math.floor(size.width * 0.75)),
      height: Math.max(1, Math.floor(size.height * 0.75)),
      quality: 'good',
    });
  }
  return null; // Drop only this frame.
}

/**
 * A fixed grid of pixels of a BGRA bitmap, every `SAMPLE_STEP` device pixels. Two pictures
 * with the same grid are treated as unchanged; a change smaller than a grid cell can slip
 * through, which `PREVIEW_FULL_REFRESH_MS` bounds. Null when the bitmap cannot be read.
 */
export function sampleBitmap(bitmap: Buffer, width: number, height: number): Uint32Array | null {
  if (width < 1 || height < 1 || bitmap.length < width * height * 4) return null;
  const step = Math.max(SAMPLE_STEP, Math.ceil(Math.sqrt((width * height) / MAX_SAMPLES)));
  const columns = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const samples = new Uint32Array(columns * rows);
  let index = 0;
  for (let y = 0; y < height; y += step) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += step) samples[index++] = bitmap.readUInt32LE(row + x * 4);
  }
  return samples;
}

function sameSamples(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Frames of one preview tab via `capturePage`. One capture is in flight at a time: a
 * caller arriving meanwhile gets no frame rather than a second capture. A capture that
 * outlives the timeout is abandoned by generation: its late result is dropped and the
 * tab itself is never touched (a `capturePage` timeout is not a cancellation).
 *
 * Stream frames are paced here, not by the viewer's fixed timer: the full rate (≤30 fps)
 * while the picture moves or input just arrived, about 5 fps once it is still, ≤10 fps for a
 * background viewer, and none at all while the viewer is hidden. A picture that did not
 * change costs one capture and a cheap comparison, no resize and no encode.
 */
export class TabCaptureSource {
  private generation = 0;
  private inFlight = false;
  private pending = 0;
  private stopped = false;
  /** When the current run of failed captures began; null while captures succeed. */
  private failingSince: number | null = null;
  private sequence = 0;
  private lastFrameAt = 0;
  private skipped = 0;
  private resent = 0;

  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private lastEncodeAt = Number.NEGATIVE_INFINITY;
  private lastChangeAt = Number.NEGATIVE_INFINITY;
  private activeUntil: number;
  private signature: Uint32Array | null = null;
  private cached: string | null = null;
  private view = { hidden: false, background: false };
  private wake: (() => void) | null = null;

  constructor(private readonly options: TabCaptureOptions) {
    // The first moments of a lease are live: the viewer has just arrived.
    this.activeUntil = this.now() + PREVIEW_INPUT_ACTIVE_MS;
  }

  /**
   * Source frame counter and the time the last real frame was produced. Re-sent cached
   * frames do not move them: a resend is not a new picture. `skipped` counts pulls that
   * found the picture unchanged and did no encode.
   */
  get stats(): { sequence: number; lastFrameAt: number; skipped: number; resent: number } {
    return {
      sequence: this.sequence,
      lastFrameAt: this.lastFrameAt,
      skipped: this.skipped,
      resent: this.resent,
    };
  }

  /** Input reached the tab: its effect is on screen within moments, so capture it at once. */
  nudge(): void {
    this.activeUntil = Math.max(this.activeUntil, this.now() + PREVIEW_INPUT_ACTIVE_MS);
    this.lastAttemptAt = Number.NEGATIVE_INFINITY;
    this.wake?.();
  }

  /** The phone hid the viewer, or shows it small (picture-in-picture). */
  setView(view: { hidden?: boolean; background?: boolean }): void {
    const wasHidden = this.view.hidden;
    this.view = {
      hidden: view.hidden ?? this.view.hidden,
      background: view.background ?? this.view.background,
    };
    if (wasHidden && !this.view.hidden) {
      // Back on screen: show the current picture, not the one from when it was hidden.
      this.lastAttemptAt = Number.NEGATIVE_INFINITY;
      this.activeUntil = Math.max(this.activeUntil, this.now() + PREVIEW_INPUT_ACTIVE_MS);
    }
    this.wake?.();
  }

  stop(): void {
    this.stopped = true;
    this.generation++; // a capture still running belongs to no one
    this.wake?.();
  }

  async frame(request: FrameRequest = { purpose: 'relay' }): Promise<string | null> {
    if (this.stopped || !this.options.isCurrent()) return null;
    if (this.inFlight) return null;
    this.inFlight = true;
    try {
      if (request.purpose === 'stream') {
        if (!(await this.waitUntilDue(request))) return null;
        // Hidden: nothing is shown, so nothing is captured; the cached picture keeps the
        // viewer's watchdog fed. Before any picture exists a hidden viewer still needs one.
        if (this.view.hidden && this.cached !== null) return this.resend();
      }
      return await this.captureAndEncode(request);
    } finally {
      this.inFlight = false;
    }
  }

  private async waitUntilDue(
    request: Extract<FrameRequest, { purpose: 'stream' }>,
  ): Promise<boolean> {
    for (;;) {
      if (this.stopped || !this.options.isCurrent()) return false;
      const wait = this.dueAt(request) - this.now();
      if (wait <= 0) return true;
      const sleep =
        this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      await Promise.race([
        sleep(wait),
        new Promise<void>((resolve) => {
          this.wake = resolve;
        }),
      ]);
      this.wake = null;
    }
  }

  private dueAt(request: Extract<FrameRequest, { purpose: 'stream' }>): number {
    if (this.view.hidden && this.cached !== null) return this.lastSentAt + PREVIEW_RESEND_MS;
    const now = this.now();
    const active = now < Math.max(this.activeUntil, this.lastChangeAt + PREVIEW_ACTIVE_HOLD_MS);
    const fps = Math.max(1, Math.min(request.fps, PREVIEW_MAX_STREAM_FPS));
    let interval = active ? 1000 / fps : PREVIEW_STILL_INTERVAL_MS;
    if (this.view.background) interval = Math.max(interval, PREVIEW_BACKGROUND_MIN_INTERVAL_MS);
    return this.lastAttemptAt + interval;
  }

  private resend(): string | null {
    this.lastSentAt = this.now();
    this.resent++;
    return this.cached;
  }

  private async captureAndEncode(request: FrameRequest): Promise<string | null> {
    if (this.expired() || this.pending >= MAX_PENDING_CAPTURES) return this.fail();
    const guest = this.options.guest();
    if (!guest || guest.isDestroyed()) return null;
    const generation = ++this.generation;
    this.lastAttemptAt = this.now();
    this.pending++;
    let raw: Promise<TabImage>;
    try {
      raw = guest.capturePage();
    } catch {
      this.pending--;
      return this.failed();
    }
    // Always settles the bookkeeping, even for an abandoned call that returns much later.
    const settle = () => {
      this.pending--;
    };
    raw.then(settle, settle);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const image = await Promise.race([
        raw,
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            this.options.timeoutMs ?? PREVIEW_CAPTURE_TIMEOUT_MS,
          );
        }),
      ]);
      if (generation !== this.generation || this.stopped) return null; // late or stopped
      if (image === null) {
        this.generation++; // abandon: whatever this call returns later is dropped
        try {
          this.options.onStall?.();
        } catch {
          // A stall hook must not change what a timeout means.
        }
        return this.failed();
      }
      if (!this.options.isCurrent()) return this.failed();
      return request.purpose === 'stream'
        ? this.encodeStream(image, request)
        : this.encodeRelay(image);
    } catch {
      if (generation !== this.generation || this.stopped) return null;
      return this.failed();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private encodeRelay(image: TabImage): string | null {
    const jpeg = encodeTabFrame(image, this.options.jpegQuality ?? RELAY_JPEG_QUALITY);
    if (jpeg === null) return this.failed();
    this.failingSince = null;
    this.lastFrameAt = this.now();
    this.sequence++;
    return jpeg;
  }

  private encodeStream(
    image: TabImage,
    request: Extract<FrameRequest, { purpose: 'stream' }>,
  ): string | null {
    if (image.isEmpty()) return this.failed();
    const now = this.now();
    const size = image.getSize();
    let samples: Uint32Array | null = null;
    try {
      const bitmap = image.toBitmap?.();
      if (bitmap) samples = sampleBitmap(bitmap, size.width, size.height);
    } catch {
      samples = null; // cannot tell: treat the picture as changed
    }
    const changed =
      samples === null || this.signature === null || !sameSamples(samples, this.signature);
    this.signature = samples;
    this.failingSince = null; // the capture itself worked
    if (!changed && this.cached !== null && now - this.lastEncodeAt < PREVIEW_FULL_REFRESH_MS) {
      this.skipped++;
      return now - this.lastSentAt >= PREVIEW_RESEND_MS ? this.resend() : null;
    }
    const jpeg = encodeTabFrame(image, request.quality, request.maxBytes);
    if (jpeg === null) return this.failed();
    if (changed) this.lastChangeAt = now;
    this.cached = jpeg;
    this.lastEncodeAt = now;
    this.lastSentAt = now;
    this.lastFrameAt = now;
    this.sequence++;
    return jpeg;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Only a capture that was started and failed or hung counts; idle time never does. */
  private expired(): boolean {
    return (
      this.failingSince !== null &&
      this.now() - this.failingSince >
        (this.options.unavailableAfterMs ?? PREVIEW_CAPTURE_UNAVAILABLE_MS)
    );
  }

  private failed(): null {
    this.failingSince ??= this.now();
    return this.expired() || this.pending >= MAX_PENDING_CAPTURES ? this.fail() : null;
  }

  private fail(): null {
    if (!this.stopped) {
      this.stopped = true;
      this.generation++;
      this.options.onUnavailable();
      this.wake?.();
    }
    return null;
  }
}
