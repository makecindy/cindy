/**
 * unified-downloader — M1: Public Facade.
 * ---------------------------------------------------------------------------
 * Public downloader assembly and lifecycle are maintained in this module.
 *
 * The ONLY public entry point of the downloader module. Callers (UpdateService,
 * ccdManager, future consumers) must depend on this file — not on internals.
 *
 * Contract invariants (re-stated; full version in tech spec):
 *   1. download() resolves DownloadResult or rejects DownloadError, no other types.
 *   2. Progress describes the current attempt (a fresh retry may restart at zero).
 *   3. resolve implies SHA256 already verified — no need to re-check.
 */

import path from 'node:path';
import { Scheduler } from './scheduler';
import { DownloadError, type DownloadOptions, type DownloadResult } from './types';

let _scheduler: Scheduler | null = null;
function getScheduler(): Scheduler {
  if (_scheduler === null) {
    _scheduler = new Scheduler({ maxConcurrent: 1 });
  }
  return _scheduler;
}

function validate(opts: DownloadOptions): void {
  if (typeof opts?.url !== 'string' || opts.url.length === 0) {
    throw new DownloadError('INVALID_ARG', 'url is required');
  }
  if (typeof opts?.targetPath !== 'string' || !path.isAbsolute(opts.targetPath)) {
    throw new DownloadError('INVALID_ARG', 'targetPath must be absolute');
  }
  if (typeof opts?.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(opts.sha256)) {
    throw new DownloadError('INVALID_ARG', 'sha256 must be 64-char hex');
  }
  for (const value of [opts.expectedSize, opts.maxBytes]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new DownloadError('INVALID_ARG', 'Download size must be a nonnegative integer');
    }
  }
  if ((opts.expectedSize ?? 0) > (opts.maxBytes ?? Infinity)) {
    throw new DownloadError('SIZE', 'Expected download exceeds allowed size');
  }
  for (const value of Object.values(opts.timeout ?? {})) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new DownloadError('INVALID_ARG', 'Invalid download timeout');
  }
}

/**
 * Download a file with single-flight dedupe, resume, retry, and SHA256 verify.
 *
 * Throws (synchronously) on invalid args. Otherwise returns a Promise that
 * resolves only after the file is at `targetPath` and verified.
 */
export function download(opts: DownloadOptions): Promise<DownloadResult> {
  validate(opts);
  const normalized = {
    ...opts,
    targetPath: path.resolve(opts.targetPath),
    sha256: opts.sha256.toLowerCase(),
  };
  if (!opts.timeout?.totalMs) return getScheduler().enqueue(normalized);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  if (opts.signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeout.totalMs);
  return getScheduler()
    .enqueue({ ...normalized, signal: controller.signal })
    .catch((error) => {
      if (timedOut) throw new DownloadError('TIMEOUT', 'Download total time limit exceeded');
      throw error;
    })
    .finally(() => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
    });
}

/**
 * Remove the `.part` and `.meta.json` sidecars for a target. Idempotent.
 * Caller should `abort()` any in-flight signal first if a download is active.
 */
export function cleanup(targetPath: string): Promise<void> {
  if (!path.isAbsolute(targetPath)) {
    return Promise.reject(new DownloadError('INVALID_ARG', 'targetPath must be absolute'));
  }
  return getScheduler().cleanup(targetPath);
}

/** Snapshot of currently-active downloads. Read-only. */
export function getActive(): ReadonlyArray<{
  url: string;
  targetPath: string;
  loaded: number;
}> {
  return getScheduler().listActive();
}

export type {
  DownloadOptions,
  DownloadResult,
  ProgressEvent,
  RetryEvent,
  ResumeEvent,
  DownloadErrorCode,
  RetryConfig,
  TimeoutConfig,
  Logger,
} from './types';
export { DownloadError } from './types';
