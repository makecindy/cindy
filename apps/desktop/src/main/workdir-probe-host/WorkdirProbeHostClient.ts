/**
 * Main-process proxy for bounded, cancellable directory probes.
 *
 * Node's fs.stat cannot cancel a wedged UNC/SMB request. Each probe therefore
 * runs in one of a small number of Electron utility processes. A timed-out
 * probe kills only its worker, releasing the slot and the worker's libuv state.
 * Queued probes wait for a slot within the same end-to-end deadline instead of
 * being rejected immediately merely because other shares are slow.
 */

import type {
  WorkdirProbeRequest,
  WorkdirProbeResponse,
  WorkdirProbeResult,
} from './protocol';
import { workdirDiagnosticErrorCode, workdirDiagnosticId } from '../workdirDiagnostics';

export interface WorkdirProbeChildLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(
    event: 'error',
    listener: (type: string, location: string, report: string) => void,
  ): void;
  kill(): boolean;
}

export interface WorkdirProbeLoggerLike {
  info?(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface WorkdirProbeHostClientDeps {
  fork: () => WorkdirProbeChildLike;
  log: WorkdirProbeLoggerLike;
  maxWorkers?: number;
  maxQueued?: number;
}

export type WorkdirProbeClientErrorCode =
  | 'WORKDIR_PROBE_TIMEOUT'
  | 'WORKDIR_PROBE_UNAVAILABLE';

export class WorkdirProbeClientError extends Error {
  constructor(
    readonly code: WorkdirProbeClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkdirProbeClientError';
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
  workerId?: number;
  resolve: (result: WorkdirProbeResult) => void;
  reject: (error: Error) => void;
  queueTimer?: ReturnType<typeof setTimeout>;
  probeTimer?: ReturnType<typeof setTimeout>;
}

interface ProbeWorker {
  id: number;
  child: WorkdirProbeChildLike;
  active?: ProbeEntry;
  terminating?: boolean;
  terminationRequestedAt?: number;
  lastRequestId?: number;
}

const DEFAULT_MAX_WORKERS = 2;
const DEFAULT_MAX_QUEUED = 32;

export class WorkdirProbeHostClient {
  private readonly maxWorkers: number;
  private readonly maxQueued: number;
  private readonly workers: ProbeWorker[] = [];
  private readonly queue: ProbeEntry[] = [];
  private readonly inFlightByPath = new Map<string, Promise<WorkdirProbeResult>>();
  private nextId = 1;
  private nextWorkerId = 1;
  private disposed = false;

  constructor(private readonly deps: WorkdirProbeHostClientDeps) {
    this.maxWorkers = deps.maxWorkers ?? DEFAULT_MAX_WORKERS;
    this.maxQueued = deps.maxQueued ?? DEFAULT_MAX_QUEUED;
  }

  probe(dir: string, key: string, timeoutMs: number, kind: WorkdirProbeRequest['kind'] = 'probe'): Promise<WorkdirProbeResult> {
    key = `${kind}:${key}`;
    if (this.disposed) {
      this.deps.log.warn('workdir probe rejected', {
        reason: 'disposed', code: 'WORKDIR_PROBE_UNAVAILABLE',
        operation: kind, directoryRef: workdirDiagnosticId(dir), ...this.poolDiagnostics(),
      });
      return Promise.reject(
        new WorkdirProbeClientError('WORKDIR_PROBE_UNAVAILABLE', 'probe host is disposed'),
      );
    }
    const existing = this.inFlightByPath.get(key);
    if (existing) return existing;
    if (this.queue.length >= this.maxQueued) {
      this.deps.log.warn('workdir probe rejected', {
        reason: 'queue-full', code: 'WORKDIR_PROBE_UNAVAILABLE',
        operation: kind, directoryRef: workdirDiagnosticId(dir), ...this.poolDiagnostics(),
      });
      return Promise.reject(
        new WorkdirProbeClientError('WORKDIR_PROBE_UNAVAILABLE', 'probe queue is full'),
      );
    }

    let entry!: ProbeEntry;
    const probe = new Promise<WorkdirProbeResult>((resolve, reject) => {
      const enqueuedAt = Date.now();
      entry = {
        kind,
        id: this.nextId++,
        dir,
        key,
        deadline: enqueuedAt + timeoutMs,
        enqueuedAt,
        resolve,
        reject,
      };
      this.schedule(entry);
    }).finally(() => {
      if (this.inFlightByPath.get(key) === probe) {
        this.inFlightByPath.delete(key);
      }
    });
    this.inFlightByPath.set(key, probe);
    return probe;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new WorkdirProbeClientError(
      'WORKDIR_PROBE_UNAVAILABLE',
      'probe host is disposed',
    );
    for (const queued of this.queue.splice(0)) {
      if (queued.queueTimer) clearTimeout(queued.queueTimer);
      this.rejectProbe(queued, error, 'disposed');
    }
    for (const worker of this.workers.splice(0)) {
      if (worker.active?.probeTimer) clearTimeout(worker.active.probeTimer);
      if (worker.active) this.rejectProbe(worker.active, error, 'disposed');
      worker.active = undefined;
      try {
        worker.child.kill();
      } catch {
        // The utility process may already have exited.
      }
    }
  }

  private schedule(entry: ProbeEntry): void {
    const idle = this.workers.find((worker) => !worker.active && !worker.terminating);
    if (idle) {
      this.startProbe(idle, entry);
      return;
    }
    if (this.workers.length < this.maxWorkers) {
      try {
        this.startProbe(this.createWorker(), entry);
      } catch (error) {
        this.rejectProbe(entry,
          new WorkdirProbeClientError(
            'WORKDIR_PROBE_UNAVAILABLE',
            `failed to start probe host: ${String(error)}`,
          ),
          'host-start-failed',
          error,
        );
      }
      return;
    }

    this.queue.push(entry);
    const remainingMs = this.remainingMs(entry);
    entry.queueTimer = setTimeout(() => {
      const index = this.queue.indexOf(entry);
      if (index < 0) return;
      this.queue.splice(index, 1);
      this.rejectProbe(entry,
        new WorkdirProbeClientError(
          'WORKDIR_PROBE_TIMEOUT',
          'timed out waiting for a probe slot',
        ),
        'queue-timeout',
      );
    }, remainingMs);
    entry.queueTimer.unref?.();
  }

  private createWorker(): ProbeWorker {
    const child = this.deps.fork();
    const worker: ProbeWorker = { child, id: this.nextWorkerId++ };
    this.workers.push(worker);
    this.deps.log.info?.('workdir probe worker created', { workerId: worker.id, ...this.poolDiagnostics() });
    child.on('message', (message) => {
      this.handleMessage(worker, message);
    });
    child.on('exit', (code) => {
      this.handleWorkerExit(worker, code);
    });
    child.on('error', () => {
      this.beginWorkerTermination(
        worker,
        new WorkdirProbeClientError('WORKDIR_PROBE_UNAVAILABLE', 'probe host failed'),
        'host-error',
      );
    });
    return worker;
  }

  private startProbe(worker: ProbeWorker, entry: ProbeEntry): void {
    if (entry.queueTimer) {
      clearTimeout(entry.queueTimer);
      entry.queueTimer = undefined;
    }
    const remainingMs = this.remainingMs(entry);
    if (remainingMs <= 0) {
      this.rejectProbe(entry,
        new WorkdirProbeClientError('WORKDIR_PROBE_TIMEOUT', 'directory probe deadline elapsed'),
        'deadline-before-dispatch',
      );
      this.drainQueue();
      return;
    }
    worker.active = entry;
    entry.startedAt = Date.now();
    entry.workerId = worker.id;
    worker.lastRequestId = entry.id;
    entry.probeTimer = setTimeout(() => {
      if (worker.active !== entry) return;
      this.beginWorkerTermination(
        worker,
        new WorkdirProbeClientError('WORKDIR_PROBE_TIMEOUT', 'directory probe timed out'),
        'response-timeout',
      );
    }, remainingMs);
    entry.probeTimer.unref?.();

    const request: WorkdirProbeRequest = {
      kind: entry.kind,
      id: entry.id,
      dir: entry.dir,
    };
    try {
      worker.child.postMessage(request);
    } catch (error) {
      this.beginWorkerTermination(
        worker,
        new WorkdirProbeClientError(
          'WORKDIR_PROBE_UNAVAILABLE',
          `probe host postMessage failed: ${String(error)}`,
        ),
        'dispatch-failed',
      );
    }
  }

  private handleMessage(worker: ProbeWorker, message: unknown): void {
    const entry = worker.active;
    if (!entry || !isProbeResponse(message) || message.id !== entry.id) return;
    if (entry.probeTimer) clearTimeout(entry.probeTimer);
    worker.active = undefined;
    if (!message.result.ok) {
      this.deps.log.warn('workdir probe filesystem result', {
        ...this.probeDiagnostics(entry), code: workdirDiagnosticErrorCode(message.result),
        reason: 'filesystem-error',
      });
    } else if (entry.kind === 'probe' && !message.result.isDirectory) {
      this.deps.log.warn('workdir probe filesystem result', {
        ...this.probeDiagnostics(entry), reason: 'not-directory',
      });
    }
    entry.resolve(message.result);
    this.drainQueue();
  }

  private beginWorkerTermination(worker: ProbeWorker, error: WorkdirProbeClientError, reason: string): void {
    if (worker.terminating) return;
    worker.terminating = true;
    worker.terminationRequestedAt = Date.now();
    const entry = worker.active;
    worker.active = undefined;
    if (entry?.probeTimer) clearTimeout(entry.probeTimer);
    if (entry) this.rejectProbe(entry, error, reason);
    this.deps.log.warn('workdir probe worker termination requested', {
      workerId: worker.id, requestId: worker.lastRequestId, reason, ...this.poolDiagnostics(),
    });
    try {
      if (!worker.child.kill()) {
        this.deps.log.warn('workdir probe host kill was not acknowledged; waiting for exit', {
          workerId: worker.id, requestId: worker.lastRequestId, ...this.poolDiagnostics(),
        });
      }
    } catch (killError) {
      this.deps.log.warn('failed to request workdir probe host termination; waiting for exit', {
        workerId: worker.id, requestId: worker.lastRequestId,
        code: workdirDiagnosticErrorCode(killError), ...this.poolDiagnostics(),
      });
    }
    // The worker remains in this.workers and therefore counts against
    // maxWorkers until Electron confirms exit. This is fail-closed: a process
    // that refuses to exit can reduce availability, but cannot multiply.
  }

  private handleWorkerExit(worker: ProbeWorker, code: number): void {
    if (!this.removeWorker(worker)) return;
    const entry = worker.active;
    worker.active = undefined;
    if (entry?.probeTimer) clearTimeout(entry.probeTimer);
    if (entry) this.rejectProbe(entry,
      new WorkdirProbeClientError('WORKDIR_PROBE_UNAVAILABLE', 'probe host exited'), 'host-exited',
    );
    this.deps.log.info?.('workdir probe worker exited', {
      workerId: worker.id, requestId: worker.lastRequestId, exitCode: code,
      terminationRequested: worker.terminating === true,
      terminationWaitMs: worker.terminationRequestedAt === undefined ? null : Date.now() - worker.terminationRequestedAt,
      ...this.poolDiagnostics(),
    });
    this.drainQueue();
  }

  private poolDiagnostics() {
    return {
      workers: this.workers.length,
      activeWorkers: this.workers.filter((worker) => worker.active).length,
      terminatingWorkers: this.workers.filter((worker) => worker.terminating).length,
      queued: this.queue.length,
      maxWorkers: this.maxWorkers,
      maxQueued: this.maxQueued,
    };
  }

  private probeDiagnostics(entry: ProbeEntry) {
    const now = Date.now();
    return {
      requestId: entry.id, workerId: entry.workerId, operation: entry.kind,
      directoryRef: workdirDiagnosticId(entry.dir),
      phase: entry.startedAt === undefined ? 'before-dispatch' : 'waiting-result',
      timeoutMs: entry.deadline - entry.enqueuedAt,
      elapsedMs: now - entry.enqueuedAt,
      queueWaitMs: (entry.startedAt ?? now) - entry.enqueuedAt,
      responseWaitMs: entry.startedAt === undefined ? null : now - entry.startedAt,
      ...this.poolDiagnostics(),
    };
  }

  private rejectProbe(entry: ProbeEntry, error: WorkdirProbeClientError, reason: string, cause?: unknown): void {
    this.deps.log.warn('workdir probe failed', {
      ...this.probeDiagnostics(entry), reason, code: workdirDiagnosticErrorCode(error),
      ...(cause === undefined ? {} : { causeCode: workdirDiagnosticErrorCode(cause) }),
    });
    entry.reject(error);
  }

  private removeWorker(worker: ProbeWorker): boolean {
    const index = this.workers.indexOf(worker);
    if (index < 0) return false;
    this.workers.splice(index, 1);
    return true;
  }

  private remainingMs(entry: ProbeEntry): number {
    return Math.max(0, entry.deadline - Date.now());
  }

  private drainQueue(): void {
    if (this.disposed) return;
    while (this.queue.length > 0) {
      const idle = this.workers.find((worker) => !worker.active && !worker.terminating);
      if (idle) {
        this.startProbe(idle, this.queue.shift()!);
        continue;
      }
      if (this.workers.length >= this.maxWorkers) return;
      const entry = this.queue.shift()!;
      try {
        this.startProbe(this.createWorker(), entry);
      } catch (error) {
        if (entry.queueTimer) clearTimeout(entry.queueTimer);
        this.rejectProbe(entry,
          new WorkdirProbeClientError(
            'WORKDIR_PROBE_UNAVAILABLE',
            `failed to restart probe host: ${String(error)}`,
          ),
          'host-restart-failed',
          error,
        );
      }
    }
  }
}

function isProbeResponse(message: unknown): message is WorkdirProbeResponse {
  if (!message || typeof message !== 'object') return false;
  const candidate = message as Partial<WorkdirProbeResponse>;
  if (candidate.kind !== 'result' || typeof candidate.id !== 'number') return false;
  const result = candidate.result as Partial<WorkdirProbeResult> | undefined;
  if (!result || typeof result.ok !== 'boolean') return false;
  return result.ok
    ? typeof (result as { isDirectory?: unknown }).isDirectory === 'boolean'
    : typeof (result as { code?: unknown }).code === 'string';
}
