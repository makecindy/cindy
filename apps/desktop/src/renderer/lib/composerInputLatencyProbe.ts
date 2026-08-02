import type { Logger } from '@/lib/logger';

type FrameHandle = number;

export interface ComposerInputLatencyProbe {
  /** Mark a committed editor update and measure until the next animation frame. */
  markUpdate(input: { kind: 'document' | 'selection'; composing: boolean; docSize: number }): void;
  dispose(): void;
}

export interface ComposerInputLatencyProbeOptions {
  now?: () => number;
  requestFrame?: (callback: FrameRequestCallback) => FrameHandle;
  cancelFrame?: (handle: FrameHandle) => void;
  log?: Pick<Logger, 'debug'>;
  thresholdMs?: number;
  windowMs?: number;
  maxLogsPerWindow?: number;
}

const DEFAULT_THRESHOLD_MS = 100;
const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_MAX_LOGS_PER_WINDOW = 20;

/**
 * Low-volume composer transaction probe.
 *
 * It intentionally records only timing and document size. The probe does not
 * retain editor text, paths, session ids, or any other user content. Multiple
 * updates in one frame are coalesced; an IME composition update is ignored.
 */
export function createComposerInputLatencyProbe(
  options: ComposerInputLatencyProbeOptions = {},
): ComposerInputLatencyProbe {
  const log = options.log;
  const maxLogsPerWindow = options.maxLogsPerWindow ?? DEFAULT_MAX_LOGS_PER_WINDOW;

  // Without a log sink or a positive, finite log budget nothing can ever be
  // recorded, so skip touching the clock and RAF entirely.
  if (!log || !Number.isFinite(maxLogsPerWindow) || maxLogsPerWindow <= 0) {
    return {
      markUpdate(): void {},
      dispose(): void {},
    };
  }

  const now = options.now ?? (() => performance.now());
  const requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;

  let pendingFrame: FrameHandle | null = null;
  let pendingStartedAt = 0;
  let pendingDocSize = 0;
  let pendingKind: 'document' | 'selection' = 'document';
  let windowStartedAt = 0;
  let windowCount = 0;
  let disposed = false;

  const admit = (timestamp: number): boolean => {
    if (timestamp - windowStartedAt >= windowMs) {
      windowStartedAt = timestamp;
      windowCount = 0;
    }
    if (windowCount >= maxLogsPerWindow) return false;
    windowCount += 1;
    return true;
  };

  const flush = (frameTimestamp: number): void => {
    pendingFrame = null;
    if (disposed) return;
    const durationMs = frameTimestamp - pendingStartedAt;
    if (durationMs < thresholdMs || !log || !admit(frameTimestamp)) return;
    log.debug(
      `composer:input-slow kind=${pendingKind} dur=${Math.round(durationMs)}ms docSize=${pendingDocSize}`,
    );
  };

  return {
    markUpdate({ kind, composing, docSize }): void {
      if (disposed || composing) return;
      const timestamp = now();
      if (pendingFrame !== null) {
        if (kind === 'document') pendingKind = 'document';
        pendingDocSize = Math.max(0, Math.round(docSize));
        return;
      }
      pendingStartedAt = timestamp;
      pendingKind = kind;
      pendingDocSize = Math.max(0, Math.round(docSize));
      pendingFrame = requestFrame(flush);
    },
    dispose(): void {
      disposed = true;
      if (pendingFrame !== null) {
        cancelFrame(pendingFrame);
        pendingFrame = null;
      }
    },
  };
}

export const __composerInputLatencyProbeDefaultsForTest = {
  thresholdMs: DEFAULT_THRESHOLD_MS,
  windowMs: DEFAULT_WINDOW_MS,
  maxLogsPerWindow: DEFAULT_MAX_LOGS_PER_WINDOW,
};
