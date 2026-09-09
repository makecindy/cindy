import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { utilityProcess } from 'electron';

import type {
  RunDbSlimmingMaintenanceOptions,
  RunDbSlimmingMaintenanceOutcome,
} from './dbSlimmingMaintenance';
import {
  BETTER_SQLITE_NATIVE_BINDING_ENV,
  resolveBetterSqliteModuleEntry,
  resolveBetterSqliteNativeBinding,
} from './betterSqliteFactory';
import type {
  DbSlimmingProcessCommand,
  DbSlimmingProcessMessage,
} from './dbSlimmingProcessProtocol';
import { resolveSqliteVecExtPath } from './sqliteVecLoader';

const BETTER_SQLITE_MODULE_ENV = 'CINDY_DB_SLIMMING_BETTER_SQLITE_MODULE';
const VACUUM_PROGRESS_START = 58;
const VACUUM_PROGRESS_SPAN = 30;
export const DB_SLIMMING_WORKER_READY_TIMEOUT_MS = 30_000;
export const DB_SLIMMING_WORKER_TERMINATION_TIMEOUT_MS = 10_000;
const DB_SLIMMING_WORKER_INACTIVITY_BASE_MS = 5 * 60_000;
const DB_SLIMMING_WORKER_INACTIVITY_PER_GIB_MS = 2 * 60_000;
const DB_SLIMMING_WORKER_INACTIVITY_MAX_MS = 2 * 60 * 60_000;
const GIB_BYTES = 1024 ** 3;

interface DbSlimmingUtilityProcessLike {
  postMessage(message: DbSlimmingProcessCommand): void;
  on(event: 'message', listener: (message: unknown) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'error', listener: (...args: unknown[]) => void): void;
  kill(): boolean;
}

/** The isolated process failed before acknowledging that maintenance could begin. */
export class DbSlimmingWorkerStartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DbSlimmingWorkerStartupError';
  }
}

export class DbSlimmingCancelledError extends Error {
  constructor() {
    super('database cleanup was cancelled');
    this.name = 'DbSlimmingCancelledError';
  }
}

/** The utility process stopped while only disposable copies had been touched. */
export class DbSlimmingWorkerPreReplacementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DbSlimmingWorkerPreReplacementError';
  }
}

/** The caller may fail visibly, but must keep exclusive database access until exit. */
export class DbSlimmingWorkerTerminationUnconfirmedError extends Error {
  constructor(
    readonly terminationConfirmed: Promise<void>,
    options?: ErrorOptions,
  ) {
    super('database cleanup process termination was not confirmed', options);
    this.name = 'DbSlimmingWorkerTerminationUnconfirmedError';
  }
}

/** Keeps an external exclusivity guard alive until the utility process really exits. */
export function deferReleaseUntilDbSlimmingWorkerTermination(
  error: unknown,
  release: () => void,
): boolean {
  if (!(error instanceof DbSlimmingWorkerTerminationUnconfirmedError)) return false;
  void error.terminationConfirmed.then(release);
  return true;
}

/** Allows large databases proportionally more silent native-call time without permitting a hang forever. */
export function dbSlimmingWorkerInactivityTimeoutMs(beforeBytes: number): number {
  const databaseBytes = Number.isFinite(beforeBytes) ? Math.max(0, beforeBytes) : 0;
  return Math.min(
    DB_SLIMMING_WORKER_INACTIVITY_MAX_MS,
    DB_SLIMMING_WORKER_INACTIVITY_BASE_MS +
      Math.ceil((databaseBytes / GIB_BYTES) * DB_SLIMMING_WORKER_INACTIVITY_PER_GIB_MS),
  );
}

function forkDbSlimmingUtilityProcess(): DbSlimmingUtilityProcessLike {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const moduleEntry = resolveBetterSqliteModuleEntry();
  if (moduleEntry) env[BETTER_SQLITE_MODULE_ENV] = moduleEntry;
  const nativeBinding = resolveBetterSqliteNativeBinding();
  if (nativeBinding) env[BETTER_SQLITE_NATIVE_BINDING_ENV] = nativeBinding;
  return utilityProcess.fork(path.join(__dirname, 'dbSlimmingMaintenanceProcess.js'), [], {
    cwd: os.tmpdir(),
    env,
    serviceName: 'cindy-database-cleanup',
    stdio: 'ignore',
  });
}

function isProgressMessage(
  value: unknown,
): value is Extract<DbSlimmingProcessMessage, { type: 'progress' }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Partial<Extract<DbSlimmingProcessMessage, { type: 'progress' }>>;
  const progress = message.progress;
  return (
    message.type === 'progress' &&
    Boolean(progress) &&
    typeof progress!.progress === 'number' &&
    Number.isFinite(progress!.progress) &&
    typeof progress!.cancellable === 'boolean' &&
    [
      'preparing',
      'backing-up',
      'copying',
      'cleaning',
      'compacting',
      'verifying',
      'finalizing',
    ].includes(String(progress!.phase))
  );
}

/** Keeps DELETE / FTS / VACUUM outside Electron Main and makes long native calls cancellable. */
export function runDbSlimmingMaintenanceInWorker(
  options: RunDbSlimmingMaintenanceOptions,
  fork: () => DbSlimmingUtilityProcessLike = forkDbSlimmingUtilityProcess,
): Promise<RunDbSlimmingMaintenanceOutcome> {
  let child: DbSlimmingUtilityProcessLike;
  try {
    child = fork();
  } catch (error) {
    throw new DbSlimmingWorkerStartupError('database cleanup process could not start', {
      cause: error,
    });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let ready = false;
    let exited = false;
    let cancelRequested = false;
    let terminationRequested = false;
    let commitSent = false;
    let timeoutError: Error | null = null;
    let cancellable = options.request.phase === 'scheduled';
    let lastProgress = 0;
    let lastPhase: string | null = null;
    let watchdogTimer: NodeJS.Timeout | null = null;
    let terminationTimer: NodeJS.Timeout | null = null;
    const vacuumPath = `${options.dbFilePath}.slimming-${options.request.id}.work.vacuum`;
    const inactivityTimeoutMs = dbSlimmingWorkerInactivityTimeoutMs(options.request.beforeBytes);
    let confirmTermination!: () => void;
    const terminationConfirmed = new Promise<void>((resolveTermination) => {
      confirmTermination = resolveTermination;
    });
    const terminationUnconfirmedError = (cause: unknown): Error =>
      new DbSlimmingWorkerTerminationUnconfirmedError(terminationConfirmed, { cause });
    const estimatedAfterBytes = Math.max(
      16 * 1024 * 1024,
      options.request.beforeBytes - (options.request.estimatedMessageBytes ?? options.request.beforeBytes / 2),
    );

    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(vacuumProgressTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      options.signal?.removeEventListener('abort', cancel);
      if (!exited && !terminationRequested) {
        try {
          child.kill();
        } catch {
          // The one-shot utility process may already have exited after its result.
        }
      }
      complete();
    };

    const fail = (error: Error): void => {
      finish(() => {
        if (!ready) {
          reject(
            new DbSlimmingWorkerStartupError('database cleanup process failed before ready', {
              cause: error,
            }),
          );
          return;
        }
        if (!commitSent) {
          reject(
            new DbSlimmingWorkerPreReplacementError(
              'database cleanup process stopped before replacement',
              { cause: error },
            ),
          );
          return;
        }
        reject(error);
      });
    };

    const rejectWithoutAssumingDatabaseSafety = (error: Error): void => {
      finish(() => reject(error));
    };

    const armTerminationConfirmation = (): void => {
      if (settled) return;
      if (terminationTimer) clearTimeout(terminationTimer);
      terminationTimer = setTimeout(() => {
        if (settled || exited) return;
        const cause = timeoutError ?? new Error('database cleanup cancellation did not stop');
        timeoutError = null;
        rejectWithoutAssumingDatabaseSafety(terminationUnconfirmedError(cause));
      }, DB_SLIMMING_WORKER_TERMINATION_TIMEOUT_MS);
      terminationTimer.unref?.();
    };

    const requestTermination = (error: Error): void => {
      if (settled || terminationRequested) return;
      terminationRequested = true;
      timeoutError = error;
      if (watchdogTimer) clearTimeout(watchdogTimer);
      try {
        child.kill();
      } catch (killError) {
        timeoutError = null;
        rejectWithoutAssumingDatabaseSafety(terminationUnconfirmedError(killError));
        return;
      }
      armTerminationConfirmation();
    };

    const armWatchdog = (timeoutMs: number, stage: string): void => {
      if (settled || terminationRequested) return;
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        requestTermination(new Error(`database cleanup process timed out while ${stage}`));
      }, timeoutMs);
      watchdogTimer.unref?.();
    };

    const cancel = (): void => {
      if (settled || !cancellable || cancelRequested) return;
      cancelRequested = true;
      terminationRequested = true;
      if (watchdogTimer) clearTimeout(watchdogTimer);
      try {
        child.kill();
      } catch (error) {
        rejectWithoutAssumingDatabaseSafety(terminationUnconfirmedError(error));
        return;
      }
      armTerminationConfirmation();
    };

    const vacuumProgressTimer = setInterval(() => {
      if (settled || lastPhase !== 'compacting') return;
      try {
        const outputBytes = fs.statSync(vacuumPath).size;
        const fraction = Math.min(0.95, outputBytes / estimatedAfterBytes);
        const progress = VACUUM_PROGRESS_START + fraction * VACUUM_PROGRESS_SPAN;
        if (progress <= lastProgress) return;
        lastProgress = progress;
        armWatchdog(inactivityTimeoutMs, 'compacting the database');
        options.onProgress?.({ phase: 'compacting', progress, cancellable: true });
      } catch {
        // VACUUM INTO creates its output lazily; absence before the first page is normal.
      }
    }, 500);
    vacuumProgressTimer.unref?.();

    child.on('message', (message: unknown) => {
      if (terminationRequested) return;
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const typed = message as DbSlimmingProcessMessage;
      if (typed.type === 'ready') {
        if (ready || cancelRequested) return;
        ready = true;
        armWatchdog(inactivityTimeoutMs, 'running database cleanup');
        child.postMessage({
          type: 'start',
          input: {
            userDataDir: options.userDataDir,
            dbFilePath: options.dbFilePath,
            request: options.request,
            sqliteVecExtensionPath: resolveSqliteVecExtPath(),
          },
        });
        return;
      }
      if (isProgressMessage(typed)) {
        lastProgress = Math.max(lastProgress, typed.progress.progress);
        lastPhase = typed.progress.phase;
        cancellable = typed.progress.cancellable;
        armWatchdog(inactivityTimeoutMs, `running phase ${typed.progress.phase}`);
        options.onProgress?.({ ...typed.progress, progress: lastProgress });
        return;
      }
      if (typed.type === 'commit-ready') {
        if (cancelRequested) return;
        cancellable = false;
        commitSent = true;
        armWatchdog(inactivityTimeoutMs, 'committing the cleaned database');
        child.postMessage({ type: 'commit' });
        return;
      }
      if (typed.type === 'log') {
        options.log[typed.level](typed.message, typed.meta);
        return;
      }
      if (typed.type === 'error') {
        const error = new Error(typed.error.message);
        if (typed.error.stack) error.stack = typed.error.stack;
        fail(error);
        return;
      }
      if (typed.type === 'result') {
        finish(() => resolve(typed.outcome));
      }
    });
    child.on('error', (...args) => {
      // A process error does not prove the child has exited. Keep the writer
      // lease and wait for exit (or the fail-closed termination guard).
      if (terminationRequested) return;
      requestTermination(
        new Error(`database cleanup process error: ${args.map(String).join(' ')}`),
      );
    });
    child.on('exit', (code) => {
      exited = true;
      confirmTermination();
      const pendingTimeout = timeoutError;
      timeoutError = null;
      if (cancelRequested) {
        finish(() => reject(new DbSlimmingCancelledError()));
        return;
      }
      if (pendingTimeout) {
        fail(pendingTimeout);
        return;
      }
      if (!settled) fail(new Error(`database cleanup process exited with code ${code}`));
    });

    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    else armWatchdog(DB_SLIMMING_WORKER_READY_TIMEOUT_MS, 'waiting for readiness');
  });
}
