/**
 * Main-process async directory probes.
 *
 * Electron utility processes are deliberately not used here: on affected
 * Windows machines the utility process can be started successfully but never
 * deliver its first message. The fs/promises calls stay asynchronous and are
 * bounded by a small in-flight pool plus an end-to-end deadline. A timed-out
 * operation keeps its slot until the underlying I/O settles because Node does
 * not expose cancellation for fs promises.
 */

import { mkdir, realpath, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type { WorkdirProbeRequest, WorkdirProbeResult } from './protocol';
import { workdirDiagnosticErrorCode, workdirDiagnosticId } from '../workdirDiagnostics';

export interface MainProcessWorkdirProbeLogger {
  info?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface MainProcessWorkdirProbeFs {
  stat(dir: string): Promise<{ isDirectory(): boolean; dev?: number }>;
  mkdir(dir: string): Promise<void>;
  realpath(dir: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
}

export interface MainProcessWorkdirProbeClientDeps {
  log: MainProcessWorkdirProbeLogger;
  fs?: MainProcessWorkdirProbeFs;
  maxInFlight?: number;
  maxQueued?: number;
}

export type MainProcessWorkdirProbeErrorCode =
  'WORKDIR_PROBE_TIMEOUT' | 'WORKDIR_PROBE_UNAVAILABLE';

export class MainProcessWorkdirProbeError extends Error {
  constructor(
    readonly code: MainProcessWorkdirProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MainProcessWorkdirProbeError';
  }
}

interface ProbeEntry {
  kind: WorkdirProbeRequest['kind'];
  id: number;
  dir: string;
  key: string;
  deadline: number;
  enqueuedAt: number;
  startedAt?: number;
  resolve: (result: WorkdirProbeResult) => void;
  reject: (error: Error) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
  probeTimer?: ReturnType<typeof setTimeout>;
  inFlightPromise?: Promise<WorkdirProbeResult>;
  settled?: boolean;
}

const DEFAULT_MAX_IN_FLIGHT = 2;
const DEFAULT_MAX_QUEUED = 32;

const defaultFs: MainProcessWorkdirProbeFs = {
  stat: async (dir) => stat(dir),
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  realpath: (dir) => realpath(dir),
  readdir: async (dir) => readdir(dir),
};

export class MainProcessWorkdirProbeClient {
  private readonly maxInFlight: number;
  private readonly maxQueued: number;
  private readonly fs: MainProcessWorkdirProbeFs;
  private readonly queue: ProbeEntry[] = [];
  private readonly activeEntries = new Set<ProbeEntry>();
  private readonly inFlightByPath = new Map<string, Promise<WorkdirProbeResult>>();
  private active = 0;
  private nextId = 1;
  private disposed = false;

  constructor(private readonly deps: MainProcessWorkdirProbeClientDeps) {
    this.maxInFlight = deps.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
    this.maxQueued = deps.maxQueued ?? DEFAULT_MAX_QUEUED;
    this.fs = deps.fs ?? defaultFs;
  }

  probe(
    dir: string,
    key: string,
    timeoutMs: number,
    kind: WorkdirProbeRequest['kind'] = 'probe',
  ): Promise<WorkdirProbeResult> {
    if (this.disposed) {
      return Promise.reject(this.unavailable('probe host is disposed', dir, kind, 'disposed'));
    }
    const dedupeKey = `${kind}:${key}`;
    const existing = this.inFlightByPath.get(dedupeKey);
    if (existing) return existing;
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(this.unavailable('probe queue is full', dir, kind, 'queue-full'));
    }

    let entry!: ProbeEntry;
    const promise = new Promise<WorkdirProbeResult>((resolve, reject) => {
      const enqueuedAt = Date.now();
      entry = {
        kind,
        id: this.nextId++,
        dir,
        key: dedupeKey,
        deadline: enqueuedAt + timeoutMs,
        enqueuedAt,
        resolve,
        reject,
      };
      this.queue.push(entry);
      this.armQueueTimer(entry);
      this.drain();
    });
    entry.inFlightPromise = promise;
    this.inFlightByPath.set(dedupeKey, promise);
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = this.unavailable('probe host is disposed', '', 'probe', 'disposed');
    for (const entry of this.queue.splice(0)) {
      if (entry.queueTimer) clearTimeout(entry.queueTimer);
      this.rejectEntry(entry, error, 'disposed');
    }
    for (const entry of this.activeEntries) {
      this.rejectEntry(entry, error, 'disposed');
    }
  }

  private drain(): void {
    if (this.disposed) return;
    while (this.active < this.maxInFlight && this.queue.length > 0) {
      const entry = this.queue.shift()!;
      if (entry.queueTimer) clearTimeout(entry.queueTimer);
      if (this.remainingMs(entry) <= 0) {
        this.rejectEntry(
          entry,
          this.timeout('directory probe deadline elapsed'),
          'deadline-before-dispatch',
        );
        continue;
      }
      this.start(entry);
    }
  }

  private armQueueTimer(entry: ProbeEntry): void {
    entry.queueTimer = setTimeout(() => {
      const index = this.queue.indexOf(entry);
      if (index < 0) return;
      this.queue.splice(index, 1);
      this.rejectEntry(entry, this.timeout('timed out waiting for a probe slot'), 'queue-timeout');
    }, this.remainingMs(entry));
    entry.queueTimer.unref?.();
  }

  private start(entry: ProbeEntry): void {
    this.active += 1;
    this.activeEntries.add(entry);
    entry.startedAt = Date.now();
    const remainingMs = this.remainingMs(entry);
    entry.probeTimer = setTimeout(() => {
      if (entry.settled) return;
      this.rejectEntry(entry, this.timeout('directory probe timed out'), 'response-timeout');
    }, remainingMs);
    entry.probeTimer.unref?.();

    void this.execute(entry.kind, entry.dir).then(
      (result) => {
        if (!entry.settled) {
          this.clearProbeTimer(entry);
          if (!result.ok) {
            this.deps.log.warn('workdir probe filesystem result', {
              ...this.diagnostics(entry),
              reason: 'filesystem-error',
              code: workdirDiagnosticErrorCode({ code: result.code }),
            });
          }
          entry.settled = true;
          entry.resolve(result);
        }
        this.finishActive(entry);
      },
      (error) => {
        if (!entry.settled) {
          this.clearProbeTimer(entry);
          this.rejectEntry(
            entry,
            this.unavailable(
              'probe filesystem operation failed',
              entry.dir,
              entry.kind,
              'filesystem-failure',
              error,
            ),
            'filesystem-failure',
          );
        }
        this.finishActive(entry);
      },
    );
  }

  private finishActive(entry: ProbeEntry): void {
    this.activeEntries.delete(entry);
    if (entry.inFlightPromise && this.inFlightByPath.get(entry.key) === entry.inFlightPromise) {
      this.inFlightByPath.delete(entry.key);
    }
    this.release();
  }

  private async execute(
    kind: WorkdirProbeRequest['kind'],
    dir: string,
  ): Promise<WorkdirProbeResult> {
    try {
      if (kind === 'mkdir') {
        await this.fs.mkdir(dir);
        return { ok: true, isDirectory: true };
      }
      if (kind === 'realpath') {
        return { ok: true, isDirectory: true, path: await this.fs.realpath(dir) };
      }
      if (kind === 'similar') {
        const parent = path.dirname(dir);
        const target = path.basename(dir);
        if (!target || parent === dir) return { ok: true, isDirectory: false, path: null };
        const entries = await this.fs.readdir(parent);
        const match =
          entries.find((name) => name !== target && name.trim() === target.trim()) ??
          entries.find((name) => name !== target && name.toLowerCase() === target.toLowerCase());
        return { ok: true, isDirectory: false, path: match ? path.join(parent, match) : null };
      }
      const entry = await this.fs.stat(dir);
      return { ok: true, isDirectory: entry.isDirectory(), device: entry.dev };
    } catch (error) {
      return { ok: false, code: filesystemErrorCode(error) };
    }
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private clearProbeTimer(entry: ProbeEntry): void {
    if (entry.probeTimer) {
      clearTimeout(entry.probeTimer);
      entry.probeTimer = undefined;
    }
  }

  private rejectEntry(entry: ProbeEntry, error: Error, reason: string): void {
    if (entry.settled) return;
    this.clearProbeTimer(entry);
    entry.settled = true;
    this.deps.log.warn('workdir probe failed', {
      ...this.diagnostics(entry),
      reason,
      code: workdirDiagnosticErrorCode(error),
    });
    entry.reject(error);
    if (!this.activeEntries.has(entry) && entry.inFlightPromise) {
      if (this.inFlightByPath.get(entry.key) === entry.inFlightPromise) {
        this.inFlightByPath.delete(entry.key);
      }
    }
  }

  private diagnostics(entry: ProbeEntry) {
    const now = Date.now();
    return {
      requestId: entry.id,
      operation: entry.kind,
      directoryRef: workdirDiagnosticId(entry.dir),
      phase: entry.startedAt === undefined ? 'before-dispatch' : 'waiting-result',
      timeoutMs: entry.deadline - entry.enqueuedAt,
      elapsedMs: now - entry.enqueuedAt,
      queueWaitMs: (entry.startedAt ?? now) - entry.enqueuedAt,
      responseWaitMs: entry.startedAt === undefined ? null : now - entry.startedAt,
      active: this.active,
      queued: this.queue.length,
      maxInFlight: this.maxInFlight,
      maxQueued: this.maxQueued,
    };
  }

  private remainingMs(entry: ProbeEntry): number {
    return Math.max(0, entry.deadline - Date.now());
  }

  private timeout(message: string): MainProcessWorkdirProbeError {
    return new MainProcessWorkdirProbeError('WORKDIR_PROBE_TIMEOUT', message);
  }

  private unavailable(
    message: string,
    dir: string,
    kind: WorkdirProbeRequest['kind'],
    reason: string,
    cause?: unknown,
  ): MainProcessWorkdirProbeError {
    const error = new MainProcessWorkdirProbeError('WORKDIR_PROBE_UNAVAILABLE', message);
    this.deps.log.warn('workdir probe unavailable', {
      ...(dir ? { operation: kind, directoryRef: workdirDiagnosticId(dir) } : {}),
      reason,
      code: workdirDiagnosticErrorCode(error),
      ...(cause === undefined ? {} : { causeCode: workdirDiagnosticErrorCode(cause) }),
    });
    return error;
  }
}

function filesystemErrorCode(error: unknown): string {
  return error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'UNKNOWN';
}
