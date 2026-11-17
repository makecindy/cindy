/**
 * Turns the downloader's raw callbacks into the shared `DownloadProgress` every surface shows.
 * ---------------------------------------------------------------------------
 * The downloader reports raw transport bytes per attempt (a server that ignores Range
 * restarts from zero). This layer owns what users see, so each surface no longer has to:
 *   - bytes and percent never go backwards within one download;
 *   - retries carry their attempt number and reason (slow / network / timeout / server);
 *   - verifying and installing are explicit phases instead of a frozen bar;
 *   - pushes are throttled, but phase changes and the final byte are sent at once.
 */

import {
  type DownloadProgress,
  type DownloadProgressPhase,
  type DownloadRetryReason,
  initialDownloadProgress,
  isDownloadProgressActive,
} from '../../shared/downloadProgress';
import { DownloadError, type DownloadOptions } from './types';

const DEFAULT_THROTTLE_MS = 200;
/** Below the 100 that `downloadPercentLabel` reserves for finished work. */
const HELD_COMPLETE_PERCENT = 99.9;

export interface DownloadProgressReporterOptions {
  /** Receives every visible change. Exceptions are swallowed so UI bugs never stop a download. */
  emit: (progress: DownloadProgress) => void;
  initialPhase?: DownloadProgressPhase;
  /** Expected size when the caller already knows it (e.g. from a manifest). */
  total?: number | null;
  throttleMs?: number;
  now?: () => number;
  /**
   * The total may still grow (more parts discovered later), so stop short of 100% until
   * `setPhase('completed')`. Ollama pulls only learn each layer's size when it starts.
   */
  holdCompleteUntilDone?: boolean;
}

export interface DownloadProgressReporter {
  /** Spread into `download()` options. */
  readonly callbacks: Required<Pick<DownloadOptions, 'onProgress' | 'onRetry' | 'onVerifying'>>;
  /** Move to a phase the downloader cannot see (installing, completed, paused, …). */
  setPhase(phase: DownloadProgressPhase): void;
  /** Bytes from a source other than the shared downloader (e.g. a runtime's own pull API). */
  setBytes(loaded: number, total: number | null, speedBps?: number): void;
  /** Start a new download on the same surface; bytes may begin again from zero. */
  reset(phase?: DownloadProgressPhase, total?: number | null): void;
  snapshot(): DownloadProgress;
}

export function retryReasonOf(cause: unknown): DownloadRetryReason {
  if (cause instanceof DownloadError) {
    if (cause.code === 'TIMEOUT') return cause.timeoutReason === 'slow' ? 'slow' : 'timeout';
    if (cause.code === 'HTTP_5XX') return 'server';
  }
  return 'network';
}

export function createDownloadProgressReporter(
  options: DownloadProgressReporterOptions,
): DownloadProgressReporter {
  const throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = options.now ?? Date.now;
  let state: DownloadProgress = initialDownloadProgress(
    options.initialPhase,
    options.total ?? null,
  );
  let lastEmitAt = Number.NEGATIVE_INFINITY;

  const send = () => {
    lastEmitAt = now();
    try {
      options.emit({ ...state });
    } catch {
      /* A rendering bug must not abort the transfer. */
    }
  };

  const update = (next: Partial<DownloadProgress>, immediate: boolean) => {
    state = { ...state, ...next };
    if (immediate || now() - lastEmitAt >= throttleMs) send();
  };

  const applyBytes = (rawLoaded: number, rawTotal: number | null, speedBps: number) => {
    const total = rawTotal ?? state.total;
    // A restarted attempt reports fewer bytes; keep the bar where the user last saw it. A larger
    // total means more work was discovered (e.g. another model layer): the old floor no longer
    // describes the same job, so the percent may honestly drop.
    const sameWork = total === state.total;
    const loaded = sameWork ? Math.max(state.loaded, rawLoaded) : rawLoaded;
    const rawPercent = total && total > 0 ? (loaded / total) * 100 : null;
    const ceiling = options.holdCompleteUntilDone ? HELD_COMPLETE_PERCENT : 100;
    const percent =
      rawPercent === null
        ? null
        : Math.max(sameWork ? (state.percent ?? 0) : 0, Math.min(ceiling, rawPercent));
    // Time left follows what this request still has to fetch, not the floor kept for display.
    const remaining = total === null ? null : Math.max(0, total - rawLoaded);
    const etaSeconds = remaining !== null && speedBps > 0 ? Math.ceil(remaining / speedBps) : null;
    const phaseChanged = state.phase !== 'downloading';
    update(
      {
        phase: 'downloading',
        loaded,
        total,
        percent,
        speedBps,
        etaSeconds,
        retryReason: undefined,
      },
      phaseChanged || (total !== null && rawLoaded >= total),
    );
  };

  // The downloader may still deliver a callback after the user paused or cancelled.
  const settled = () => !isDownloadProgressActive(state.phase);

  return {
    callbacks: {
      onProgress: (event) => {
        if (!settled()) applyBytes(event.loaded, event.total, event.speedBps);
      },
      onRetry: (event) => {
        if (settled()) return;
        update(
          {
            phase: 'retrying',
            attempt: event.attempt,
            retryReason: retryReasonOf(event.cause),
            speedBps: 0,
            etaSeconds: null,
          },
          true,
        );
      },
      onVerifying: () => {
        if (settled()) return;
        update({ phase: 'verifying', speedBps: 0, etaSeconds: null, retryReason: undefined }, true);
      },
    },
    setPhase(phase) {
      if (phase === state.phase) return;
      const done = phase === 'completed';
      update(
        {
          phase,
          speedBps: 0,
          etaSeconds: null,
          retryReason: undefined,
          ...(done && state.total !== null ? { loaded: state.total, percent: 100 } : {}),
        },
        true,
      );
    },
    setBytes(loaded, total, speedBps = 0) {
      applyBytes(loaded, total, speedBps);
    },
    reset(phase = 'preparing', total = null) {
      state = initialDownloadProgress(phase, total);
      send();
    },
    snapshot: () => ({ ...state }),
  };
}
