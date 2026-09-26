/**
 * unified-downloader — M4: Retry controller + error classification.
 * ---------------------------------------------------------------------------
 * Retry classification and backoff invariants are maintained in this module.
 *
 * Backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped at maxDelayMs, ±25% jitter).
 *
 * Retryable codes: NETWORK, HTTP_5XX, per-attempt TIMEOUT. Other failures are permanent.
 *
 * The sleep between attempts is interruptible — if the AbortSignal fires while
 * we're backing off, we throw `ABORTED` immediately without waiting out the
 * full delay.
 */

import { DownloadError, type RetryConfig, type Logger } from './types';

export const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 6,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitterRatio: 0.25,
};

export interface RetryOptions {
  config?: Partial<RetryConfig>;
  signal?: AbortSignal;
  logger: Logger;
  onRetry?: (e: { attempt: number; delayMs: number; cause: Error }) => void;
}

export async function withRetry<T>(task: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const cfg: RetryConfig = { ...DEFAULT_RETRY, ...(opts.config ?? {}) };
  let attempt = 0;
  let lastError: Error | null = null;

  while (attempt < cfg.maxAttempts) {
    if (opts.signal?.aborted) throw new DownloadError('ABORTED', 'Download aborted');
    attempt++;
    try {
      return await task();
    } catch (err) {
      lastError = err as Error;

      if (!isRetryable(err)) throw err;
      if (attempt >= cfg.maxAttempts) throw err;
      if (opts.signal?.aborted === true) {
        throw new DownloadError('ABORTED', 'aborted during retry');
      }

      const delayMs = computeBackoff(attempt, cfg);
      const code = err instanceof DownloadError ? err.code : 'UNKNOWN';
      opts.logger.warn?.(
        `[downloader] attempt ${attempt} failed (${code}); retry in ${delayMs}ms`,
        { error: (err as Error).message },
      );
      // attempt + 1 = the upcoming attempt (1-based as the spec promises).
      opts.onRetry?.({ attempt: attempt + 1, delayMs, cause: err as Error });

      await sleepInterruptible(delayMs, opts.signal);
    }
  }

  // Unreachable in practice; throw last error to satisfy the type system.
  throw lastError ?? new DownloadError('NETWORK', 'unknown retry exhaustion');
}

function isRetryable(err: unknown): boolean {
  if (!(err instanceof DownloadError)) return false;
  return err.code === 'NETWORK' || err.code === 'HTTP_5XX' || err.code === 'TIMEOUT';
}

/** Backoff: min(base * 2^(attempt-1), max) * (1 ± jitterRatio) */
function computeBackoff(attempt: number, cfg: RetryConfig): number {
  const exp = Math.min(cfg.baseDelayMs * Math.pow(2, attempt - 1), cfg.maxDelayMs);
  const jitter = (Math.random() * 2 - 1) * cfg.jitterRatio;
  return Math.max(0, Math.round(exp * (1 + jitter)));
}

function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DownloadError('ABORTED', 'aborted during backoff'));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      if (timer !== null) clearTimeout(timer);
      reject(new DownloadError('ABORTED', 'aborted during backoff'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
