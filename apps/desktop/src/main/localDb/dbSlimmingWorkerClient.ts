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
    let cancellable = options.request.phase === 'scheduled';
    let lastProgress = 0;
    let lastPhase: string | null = null;
    const vacuumPath = `${options.dbFilePath}.slimming-${options.request.id}.work.vacuum`;
    const estimatedAfterBytes = Math.max(
      16 * 1024 * 1024,
      options.request.beforeBytes - (options.request.estimatedMessageBytes ?? options.request.beforeBytes / 2),
    );

    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(vacuumProgressTimer);
      options.signal?.removeEventListener('abort', cancel);
      if (!exited) {
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
        if (cancellable) {
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

    const cancel = (): void => {
      if (settled || !cancellable || cancelRequested) return;
      cancelRequested = true;
      try {
        child.kill();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    const vacuumProgressTimer = setInterval(() => {
      if (settled || lastPhase !== 'compacting') return;
      try {
        const outputBytes = fs.statSync(vacuumPath).size;
        const fraction = Math.min(0.95, outputBytes / estimatedAfterBytes);
        const progress = VACUUM_PROGRESS_START + fraction * VACUUM_PROGRESS_SPAN;
        if (progress <= lastProgress) return;
        lastProgress = progress;
        options.onProgress?.({ phase: 'compacting', progress, cancellable: true });
      } catch {
        // VACUUM INTO creates its output lazily; absence before the first page is normal.
      }
    }, 500);
    vacuumProgressTimer.unref?.();

    child.on('message', (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const typed = message as DbSlimmingProcessMessage;
      if (typed.type === 'ready') {
        if (ready || cancelRequested) return;
        ready = true;
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
        options.onProgress?.({ ...typed.progress, progress: lastProgress });
        return;
      }
      if (typed.type === 'commit-ready') {
        if (cancelRequested) return;
        cancellable = false;
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
      fail(new Error(`database cleanup process error: ${args.map(String).join(' ')}`));
    });
    child.on('exit', (code) => {
      exited = true;
      if (cancelRequested) {
        finish(() => reject(new DbSlimmingCancelledError()));
        return;
      }
      if (!settled) fail(new Error(`database cleanup process exited with code ${code}`));
    });

    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
  });
}
