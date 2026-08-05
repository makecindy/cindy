/**
 * unified-downloader — M6: Scheduler + single-flight dedupe.
 * ---------------------------------------------------------------------------
 * Concurrency and queue-ordering invariants are maintained in this module.
 *
 * Responsibilities:
 *   - Single-flight: identical (url|targetPath|sha256) tuples share one Promise.
 *   - Concurrency cap (default 1) + FIFO queue.
 *   - fromCache short-circuit: if targetPath already exists & sha256 matches,
 *     resolve immediately without entering the queue work.
 *   - Wraps executeOnce() with withRetry().
 */

import fs from 'node:fs';
import {
  DownloadError,
  type DownloadOptions,
  type DownloadResult,
  type Logger,
} from './types';
import { computeHash } from './integrity';
import { executeOnce, type TransportContext } from './transport';
import { withRetry } from './retry';
import { deletePart, deleteMeta } from './resume';

import { createLogger } from '../logger';

const log = createLogger('scheduler');

interface ActiveTask {
  url: string;
  targetPath: string;
  loaded: number;
}

interface QueuedTask {
  key: string;
  opts: DownloadOptions;
  resolve: (r: DownloadResult) => void;
  reject: (e: Error) => void;
}

export interface SchedulerOptions {
  maxConcurrent: number;
}

const defaultLogger: Logger = {
  warn: (msg, meta) => log.warn(msg, meta ?? ''),
  info: (msg, meta) => log.info(msg, meta ?? ''),
  error: (msg, meta) => log.error(msg, meta ?? ''),
  debug: () => { /* silent by default */ },
};

export class Scheduler {
  private readonly maxConcurrent: number;
  private inflight = new Map<string, Promise<DownloadResult>>();
  private active = new Map<string, ActiveTask>();
  private queue: QueuedTask[] = [];

  constructor(opts: SchedulerOptions) {
    this.maxConcurrent = opts.maxConcurrent;
  }

  enqueue(opts: DownloadOptions): Promise<DownloadResult> {
    const key = this.makeKey(opts);

    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;

    const promise = new Promise<DownloadResult>((resolve, reject) => {
      this.queue.push({ key, opts, resolve, reject });
      this.tryStart();
    });
    this.inflight.set(key, promise);
    promise.finally(() => this.inflight.delete(key));
    return promise;
  }

  async cleanup(targetPath: string): Promise<void> {
    deletePart(targetPath);
    deleteMeta(targetPath);
  }

  listActive(): ReadonlyArray<{ url: string; targetPath: string; loaded: number }> {
    return Array.from(this.active.values()).map((t) => ({
      url: t.url,
      targetPath: t.targetPath,
      loaded: t.loaded,
    }));
  }

  private makeKey(opts: DownloadOptions): string {
    return `${opts.url}|${opts.targetPath}|${opts.sha256}`;
  }

  private tryStart(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task === undefined) return;

      // Aborted while queued.
      if (task.opts.signal?.aborted === true) {
        task.reject(new DownloadError('ABORTED', 'aborted while queued'));
        continue;
      }

      void this.run(task);
    }
  }

  private async run(task: QueuedTask): Promise<void> {
    const startedAt = Date.now();
    const logger: Logger = task.opts.logger ?? defaultLogger;

    // ── fromCache short-circuit ──
    try {
      if (fs.existsSync(task.opts.targetPath)) {
        const hash = await computeHash(task.opts.targetPath);
        if (hash === task.opts.sha256) {
          task.resolve({
            path: task.opts.targetPath,
            size: fs.statSync(task.opts.targetPath).size,
            sha256: hash,
            fromCache: true,
            durationMs: Date.now() - startedAt,
            resumedFromBytes: 0,
          });
          return;
        }
      }
    } catch (err) {
      logger.debug?.('[downloader] fromCache check failed; falling through', {
        err: (err as Error).message,
      });
    }

    const ctx: TransportContext = {
      opts: task.opts,
      logger,
      signal: task.opts.signal,
      resumedFromBytes: 0,
    };

    this.active.set(task.key, {
      url: task.opts.url,
      targetPath: task.opts.targetPath,
      loaded: 0,
    });

    try {
      const result = await withRetry(() => executeOnce(ctx), {
        config: task.opts.retry,
        signal: task.opts.signal,
        logger,
        onRetry: task.opts.onRetry,
      });
      task.resolve({
        path: task.opts.targetPath,
        size: result.size,
        sha256: result.sha256,
        fromCache: false,
        durationMs: Date.now() - startedAt,
        resumedFromBytes: ctx.resumedFromBytes,
      });
    } catch (err) {
      task.reject(err as Error);
    } finally {
      this.active.delete(task.key);
      this.tryStart();
    }
  }
}
