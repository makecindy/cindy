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
 *   2. onProgress reports raw transport bytes; callers normalize display progress
 *      across retries (a server may reject resume and restart from zero).
 *   3. resolve implies SHA256 already verified — no need to re-check.
 */

import path from 'node:path';
import { Scheduler, type SchedulerOptions } from './scheduler.js';
import { DownloadError, type DownloadOptions, type DownloadResult } from './types.js';


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

function normalize(opts: DownloadOptions): DownloadOptions {
  validate(opts);
  return { ...opts, targetPath: path.resolve(opts.targetPath), sha256: opts.sha256.toLowerCase() };
}

/** A consumer-owned queue; plugin transfers never queue ahead of app updates. */
export function createDownloader(defaults: Omit<SchedulerOptions, 'maxConcurrent'> = {}) {
  const scheduler = new Scheduler({ ...defaults, maxConcurrent: 1 });
  return (opts: DownloadOptions): Promise<DownloadResult> => scheduler.enqueue(normalize(opts));
}

export function createDownloadService(defaults: Omit<SchedulerOptions, 'maxConcurrent'> = {}) {
  let scheduler: Scheduler | undefined;
  const get = () => scheduler ??= new Scheduler({ ...defaults, maxConcurrent: 1 });
  return {
    download: (opts: DownloadOptions): Promise<DownloadResult> => get().enqueue(normalize(opts)),
    cleanup: (targetPath: string): Promise<void> => !path.isAbsolute(targetPath)
      ? Promise.reject(new DownloadError('INVALID_ARG', 'targetPath must be absolute'))
      : get().cleanup(targetPath),
    getActive: () => get().listActive(),
  };
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
  DownloadRequest,
} from './types.js';
export { DownloadError } from './types.js';
