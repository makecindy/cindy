import type Database from 'better-sqlite3';

import type { DbSlimmingResultRecord } from './maintenanceStore';
import { runDbSlimmingMaintenance } from './dbSlimmingMaintenance';
import {
  clearDbSlimmingRequest,
  readDbSlimmingRequest,
  writeDbSlimmingResult,
} from './maintenanceStore';

interface DbSlimmingStartupLog {
  info(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
}

export interface RunPendingDbSlimmingAtStartupOptions {
  userDataDir: string;
  dbFilePath: string;
  ownerId: string;
  leaseKind: 'reader' | 'writer';
  loadVectorExtension: (db: Database.Database) => boolean;
  log: DbSlimmingStartupLog;
  now?: () => number;
  runMaintenance?: typeof runDbSlimmingMaintenance;
}

export type PendingDbSlimmingStartupOutcome =
  | { handled: false; originalDatabaseReady: true }
  | {
      handled: true;
      result: DbSlimmingResultRecord;
      originalDatabaseReady: boolean;
    };

/**
 * Consumes the cross-restart marker only after the schema lease is acquired and
 * before the normal database connection is opened. A reader lease records a
 * safe failure instead of attempting any file replacement.
 */
export async function runPendingDbSlimmingAtStartup(
  options: RunPendingDbSlimmingAtStartupOptions,
): Promise<PendingDbSlimmingStartupOutcome> {
  let request: ReturnType<typeof readDbSlimmingRequest> = null;
  try {
    request = readDbSlimmingRequest(options.userDataDir);
  } catch (error) {
    options.log.error('invalid database slimming request marker was discarded', {
      error: error instanceof Error ? error.message : String(error),
    });
    clearDbSlimmingRequest(options.userDataDir);
    return { handled: false, originalDatabaseReady: true };
  }

  if (!request || request.ownerId !== options.ownerId) {
    return { handled: false, originalDatabaseReady: true };
  }

  if (options.leaseKind !== 'writer') {
    const result: DbSlimmingResultRecord = {
      id: request.id,
      ownerId: request.ownerId,
      status: 'failed',
      finishedAt: (options.now ?? Date.now)(),
      archiveAgeMonths: request.archiveAgeMonths,
      reason: 'database-in-use',
      originalDatabaseRestored: true,
    };
    try {
      writeDbSlimmingResult(options.userDataDir, result);
      clearDbSlimmingRequest(options.userDataDir);
    } catch (error) {
      options.log.warn('database slimming in-use result could not be persisted', {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    options.log.warn('database slimming skipped because this startup does not own the writer lease', {
      requestId: request.id,
    });
    return { handled: true, result, originalDatabaseReady: true };
  }

  const runMaintenance = options.runMaintenance ?? runDbSlimmingMaintenance;
  const maintenance = await runMaintenance({
    userDataDir: options.userDataDir,
    dbFilePath: options.dbFilePath,
    request,
    loadVectorExtension: options.loadVectorExtension,
    log: options.log,
  });
  return { handled: true, ...maintenance };
}
