/**
 * unified-downloader — M6: Scheduler + single-flight dedupe.
 * ---------------------------------------------------------------------------
 * Concurrency and queue-ordering invariants are maintained in this module.
 *
 * Responsibilities:
 *   - Single-flight: identical inputs share one Promise; conflicting target owners are rejected.
 *   - Concurrency cap (default 1) + FIFO queue.
 *   - fromCache short-circuit: if targetPath already exists & sha256 matches,
 *     resolve without HTTP while holding the queue slot during hashing.
 *   - Wraps executeOnce() with withRetry().
 */

import fs from 'node:fs';
import { DownloadError, type DownloadOptions, type DownloadResult, type Logger } from './types';
import { computeHash } from './integrity';
import { assertDownloadUrl, executeOnce, type TransportContext } from './transport';
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
  onAbort?: () => void;
}

export interface SchedulerOptions {
  maxConcurrent: number;
}

const defaultLogger: Logger = {
  warn: (msg, meta) => log.warn(msg, meta ?? ''),
  info: (msg, meta) => log.info(msg, meta ?? ''),
  error: (msg, meta) => log.error(msg, meta ?? ''),
  debug: () => {
    /* silent by default */
  },
};

export class Scheduler {
  private readonly maxConcurrent: number;
  private inflight = new Map<string, Promise<DownloadResult>>();
  private inputs = new Map<string, DownloadOptions>();
  private active = new Map<string, ActiveTask>();
  private queue: QueuedTask[] = [];

  constructor(opts: SchedulerOptions) {
    this.maxConcurrent = opts.maxConcurrent;
  }

  enqueue(opts: DownloadOptions): Promise<DownloadResult> {
    const key = this.makeKey(opts);
    if (opts.signal?.aborted)
      return Promise.reject(new DownloadError('ABORTED', 'Download aborted'));
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      const prior = this.inputs.get(key)!;
      // Different policies/cancellation owners must never borrow an in-flight result.
      const same = new Set([...Object.keys(prior), ...Object.keys(opts)]);
      if (
        [...same].every((name) => {
          const field = name as keyof DownloadOptions;
          return field === 'timeout' || field === 'retry'
            ? JSON.stringify(prior[field]) === JSON.stringify(opts[field])
            : prior[field] === opts[field];
        })
      )
        return existing;
      return Promise.reject(new DownloadError('INVALID_ARG', 'Download target is already in use'));
    }

    const promise = new Promise<DownloadResult>((resolve, reject) => {
      const task: QueuedTask = { key, opts, resolve, reject };
      task.onAbort = () => this.abortQueuedTask(task);
      opts.signal?.addEventListener('abort', task.onAbort, { once: true });
      this.queue.push(task);
      this.tryStart();
    });
    this.inflight.set(key, promise);
    this.inputs.set(key, opts);
    // 用双分支 then 做清理，避免 finally 返回的 rejected Promise 在调用方
    // 尚未来得及接住时触发 unhandledRejection。
    void promise.then(
      () => {
        this.inflight.delete(key);
        this.inputs.delete(key);
      },
      () => {
        this.inflight.delete(key);
        this.inputs.delete(key);
      },
    );
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
    return opts.targetPath;
  }

  private tryStart(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift();
      if (task === undefined) return;

      if (task.onAbort) {
        task.opts.signal?.removeEventListener('abort', task.onAbort);
        task.onAbort = undefined;
      }

      // Aborted while queued.
      if (task.opts.signal?.aborted === true) {
        task.reject(new DownloadError('ABORTED', 'aborted while queued'));
        continue;
      }

      void this.run(task);
    }
  }

  private abortQueuedTask(task: QueuedTask): void {
    const index = this.queue.indexOf(task);
    if (index < 0) return;
    this.queue.splice(index, 1);
    task.onAbort = undefined;
    task.reject(new DownloadError('ABORTED', 'aborted while queued'));
    // The aborted task did not consume an active slot, but another queued task
    // may now be startable when this callback races with a slot becoming free.
    this.tryStart();
  }

  private async run(task: QueuedTask): Promise<void> {
    const startedAt = Date.now();
    const logger: Logger = task.opts.logger ?? defaultLogger;

    // Reserve the slot BEFORE asynchronous cache hashing, including cache hits.
    this.active.set(task.key, { url: task.opts.url, targetPath: task.opts.targetPath, loaded: 0 });
    try {
      assertDownloadUrl(task.opts.url, task.opts);
      // ── fromCache short-circuit ──
      if (task.opts.existingTarget === 'error' && fs.existsSync(task.opts.targetPath)) {
        throw new DownloadError('EXISTS', 'Download target already exists');
      }
      try {
        if (fs.existsSync(task.opts.targetPath)) {
          const hash = await computeHash(task.opts.targetPath);
          const size = fs.statSync(task.opts.targetPath).size;
          if (task.opts.signal?.aborted) throw new DownloadError('ABORTED', 'Download aborted');
          if (
            hash === task.opts.sha256 &&
            size <= (task.opts.maxBytes ?? Infinity) &&
            (task.opts.expectedSize === undefined || size === task.opts.expectedSize)
          ) {
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
        if (err instanceof DownloadError) throw err;
        logger.debug?.('[downloader] fromCache check failed; falling through', {
          err: (err as Error).message,
        });
      }

      const ctx: TransportContext = {
        opts: {
          ...task.opts,
          onProgress: (event) => {
            const active = this.active.get(task.key);
            if (active) active.loaded = event.loaded;
            task.opts.onProgress?.(event);
          },
        },
        logger,
        signal: task.opts.signal,
        resumedFromBytes: 0,
      };

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
