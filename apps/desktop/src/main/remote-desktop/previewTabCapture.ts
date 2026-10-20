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

export interface TabCaptureOptions {
  guest(): CaptureGuest | null;
  /** The tab is still the one this lease was granted for. */
  isCurrent(): boolean;
  /** Capture keeps failing or hanging beyond the budget; called once, then the source is stopped. */
  onUnavailable(): void;
  now?(): number;
  timeoutMs?: number;
  unavailableAfterMs?: number;
  /** First JPEG quality tried (0..1). */
  jpegQuality?: number;
}

/** Scales to the frame budget: long edge ≤ 1280, JPEG ≤ REMOTE_DESKTOP_MAX_FRAME_BYTES. */
export function encodeTabFrame(image: TabImage, jpegQuality = 0.65): string | null {
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
    if (jpeg.length > 0 && jpeg.length <= REMOTE_DESKTOP_MAX_FRAME_BYTES)
      return jpeg.toString('base64');
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
 * Frames of one preview tab via `capturePage`. One capture is in flight at a time: a
 * caller arriving meanwhile gets no frame rather than a second capture. A capture that
 * outlives the timeout is abandoned by generation: its late result is dropped and the
 * tab itself is never touched (a `capturePage` timeout is not a cancellation).
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

  constructor(private readonly options: TabCaptureOptions) {}

  /** Source frame counter and the time the last frame was produced (diagnostics). */
  get stats(): { sequence: number; lastFrameAt: number } {
    return { sequence: this.sequence, lastFrameAt: this.lastFrameAt };
  }

  stop(): void {
    this.stopped = true;
    this.generation++; // a capture still running belongs to no one
  }

  async frame(): Promise<string | null> {
    if (this.stopped || !this.options.isCurrent()) return null;
    if (this.inFlight) return null;
    if (this.expired() || this.pending >= MAX_PENDING_CAPTURES) return this.fail();
    const guest = this.options.guest();
    if (!guest || guest.isDestroyed()) return null;
    const generation = ++this.generation;
    this.inFlight = true;
    this.pending++;
    let raw: Promise<TabImage>;
    try {
      raw = guest.capturePage();
    } catch {
      this.inFlight = false;
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
        return this.failed();
      }
      const jpeg = this.options.isCurrent()
        ? encodeTabFrame(image, this.options.jpegQuality)
        : null;
      if (jpeg === null) return this.failed();
      this.failingSince = null;
      this.lastFrameAt = this.now();
      this.sequence++;
      return jpeg;
    } catch {
      if (generation !== this.generation || this.stopped) return null;
      return this.failed();
    } finally {
      if (timer) clearTimeout(timer);
      this.inFlight = false;
    }
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
    }
    return null;
  }
}
