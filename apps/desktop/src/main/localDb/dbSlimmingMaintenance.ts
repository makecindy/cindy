import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import type {
  DbSlimmingFailureReason,
  DbSlimmingMaintenanceProgress,
} from '../../shared/localDbMaintenance';
import { createBetterSqliteDatabase, restrictDbFilePermissions } from './betterSqliteFactory';
import {
  adoptDbSlimmingBackup,
  clearDbSlimmingRequest,
  readDbSlimmingResult,
  type DbSlimmingRequestRecord,
  type DbSlimmingResultRecord,
  writeDbSlimmingRequest,
  writeDbSlimmingResult,
} from './maintenanceStore';

const TEMP_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export interface DbSlimmingMaintenanceLog {
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

export interface RunDbSlimmingMaintenanceOptions {
  userDataDir: string;
  dbFilePath: string;
  request: DbSlimmingRequestRecord;
  loadVectorExtension?: (db: Database.Database) => boolean;
  now?: () => number;
  log: DbSlimmingMaintenanceLog;
  signal?: AbortSignal;
  onProgress?: (progress: DbSlimmingMaintenanceProgress) => void;
  beforeReplacement?: () => Promise<void>;
}

export interface RunDbSlimmingMaintenanceOutcome {
  result: DbSlimmingResultRecord;
  originalDatabaseReady: boolean;
}

interface MaintenancePaths {
  work: string;
  rollback: string;
  backupFinal: string | null;
  backupPrevious: string | null;
  backupCandidate: string | null;
  backupLocation: 'database-directory' | 'custom-directory' | undefined;
  defaultDirectoryBackup: boolean;
}

interface TargetCounts {
  deletedTaskCount: number;
  archivedTaskCount: number;
  messageCount: number;
}

class DbSlimmingMaintenanceError extends Error {
  constructor(
    readonly reason: DbSlimmingFailureReason,
    message: string,
    readonly originalDatabaseReady = true,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DbSlimmingMaintenanceError';
  }
}

/** Conservative peak space: one working copy plus SQLite's VACUUM scratch copy. */
export function dbSlimmingTemporaryBytesRequired(databaseBytes: number): number {
  return Math.max(0, Math.ceil(databaseBytes * 2 + TEMP_SPACE_MARGIN_BYTES));
}

export function dbVolumeFreeBytes(dbFilePath: string): number | null {
  return directoryFreeBytes(path.dirname(dbFilePath));
}

export function estimateDbFilesBytes(dbFilePath: string): number {
  let total = 0;
  for (const candidate of [dbFilePath, `${dbFilePath}-wal`]) {
    try {
      total += fs.statSync(candidate).size;
    } catch {
      // Missing WAL files are normal after a clean checkpoint.
    }
  }
  return total;
}

/**
 * Runs only while ensureReady owns the schema writer lease and before the normal
 * database connection or worker is opened. All destructive work happens on a
 * copy; the original remains the rollback source until the replacement passes.
 */
export async function runDbSlimmingMaintenance(
  options: RunDbSlimmingMaintenanceOptions,
): Promise<RunDbSlimmingMaintenanceOutcome> {
  const now = options.now ?? Date.now;
  let request = options.request;
  const paths = maintenancePaths(options.dbFilePath, request);
  let replacementInstalled = request.phase === 'replacement-installed';
  let committed = request.phase === 'committed';

  reportProgress(options, 'preparing', 2, request.phase === 'scheduled');

  try {
    // A failed rollback-marker write leaves the previous replacement-installed
    // marker on disk, while the restored replacement is parked back at work.
    // Advance that durable state before treating the active database as the
    // committed replacement on a later startup.
    if (request.phase === 'replacement-installed' && fs.existsSync(paths.work)) {
      request = {
        ...request,
        phase: 'rollback-completed',
        rollbackFailureReason: request.rollbackFailureReason ?? 'recovery-failed',
      };
      writeDbSlimmingRequest(options.userDataDir, request);
    }

    if (request.phase === 'rollback-completed') {
      const originalDatabaseReady = verifyDatabaseFile(options.dbFilePath);
      const result: DbSlimmingResultRecord = {
        id: request.id,
        ownerId: request.ownerId,
        status: 'failed',
        finishedAt: now(),
        archiveAgeMonths: request.archiveAgeMonths,
        reason: originalDatabaseReady
          ? (request.rollbackFailureReason ?? 'recovery-failed')
          : 'recovery-failed',
        originalDatabaseRestored: originalDatabaseReady,
      };
      if (!originalDatabaseReady) {
        return { result, originalDatabaseReady: false };
      }
      try {
        writeDbSlimmingResult(options.userDataDir, result);
      } catch (error) {
        options.log.warn('database slimming rollback result could not be persisted', {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { result, originalDatabaseReady: true };
      }
      if (!finalizeFailedCleanup(options.userDataDir, paths)) {
        options.log.warn('database slimming rollback cleanup will be retried', {
          requestId: request.id,
        });
      }
      return { result, originalDatabaseReady: true };
    }

    if (request.phase === 'committed') {
      if (!verifyDatabaseFile(options.dbFilePath)) {
        throw new DbSlimmingMaintenanceError(
          'recovery-failed',
          'committed replacement database is invalid',
          false,
        );
      }
      let result: DbSlimmingResultRecord | null = null;
      try {
        result = readDbSlimmingResult(options.userDataDir);
      } catch (error) {
        options.log.warn('committed database slimming result could not be read', {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (
        !result ||
        result.id !== request.id ||
        result.ownerId !== request.ownerId ||
        result.status !== 'completed'
      ) {
        registerInstalledBackup(options, request, paths);
        result = completedResult(request, paths, options.dbFilePath, now());
        writeDbSlimmingResult(options.userDataDir, result);
      }
      try {
        finalizeCommittedCleanup(options.userDataDir, paths);
      } catch (error) {
        options.log.warn('database slimming committed cleanup will be retried', {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { result, originalDatabaseReady: true };
    }

    if (request.phase === 'swap-prepared') {
      restoreOriginalDatabase(options.dbFilePath, paths, options.log);
      request = { ...request, phase: 'scheduled' };
      writeDbSlimmingRequest(options.userDataDir, request);
    } else if (request.phase === 'replacement-installed') {
      if (!verifyDatabaseFile(options.dbFilePath)) {
        throw new DbSlimmingMaintenanceError(
          'integrity-check-failed',
          'replacement database did not pass startup recovery validation',
        );
      }
      registerInstalledBackup(options, request, paths);
      const recoveredResult = completedResult(request, paths, options.dbFilePath, now());
      try {
        writeDbSlimmingResult(options.userDataDir, recoveredResult);
      } catch (error) {
        options.log.warn('database slimming recovery result could not be persisted', {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { result: recoveredResult, originalDatabaseReady: true };
      }
      request = { ...request, phase: 'committed' };
      try {
        writeDbSlimmingRequest(options.userDataDir, request);
        committed = true;
        finalizeCommittedCleanup(options.userDataDir, paths);
      } catch (error) {
        options.log.warn('database slimming recovery cleanup will be retried', {
          requestId: request.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { result: recoveredResult, originalDatabaseReady: true };
    }

    recoverInterruptedCustomBackupInstall(paths);
    cleanupUncommittedArtifacts(paths);
    assertMaintenanceSpace(options.dbFilePath, request, paths);
    reportProgress(options, 'preparing', 5, true);

    const beforeBytes = estimateDbFilesBytes(options.dbFilePath);
    request = { ...request, beforeBytes };
    writeDbSlimmingRequest(options.userDataDir, request);

    const source = openSourceDatabase(options.dbFilePath);
    try {
      if (paths.backupCandidate && paths.backupFinal) {
        reportProgress(options, 'backing-up', 7, true);
        await createAndInstallCustomBackup(source, paths, options.log, (fraction) => {
          reportProgress(options, 'backing-up', 7 + fraction * 13, true);
        });
        registerInstalledBackup(options, request, paths, true);
      }
      removeDatabaseFamily(paths.work);
      try {
        const progressStart = paths.backupCandidate ? 20 : 7;
        const progressSpan = paths.backupCandidate ? 20 : 33;
        reportProgress(options, 'copying', progressStart, true);
        await source.backup(paths.work, {
          progress: (progress) => {
            const fraction = backupFraction(progress);
            reportProgress(
              options,
              'copying',
              progressStart + fraction * progressSpan,
              true,
            );
            return 4_096;
          },
        });
      } catch (error) {
        throw new DbSlimmingMaintenanceError('cleanup-failed', 'working copy failed', true, {
          cause: error,
        });
      }
    } finally {
      source.close();
    }

    const targetCounts = compactWorkingCopy(paths.work, request, options);
    request = { ...request, ...targetCounts };
    writeDbSlimmingRequest(options.userDataDir, request);

    reportProgress(options, 'finalizing', 96, false);
    await options.beforeReplacement?.();
    request = { ...request, phase: 'swap-prepared' };
    writeDbSlimmingRequest(options.userDataDir, request);
    installReplacement(options.dbFilePath, paths);
    replacementInstalled = true;

    request = { ...request, phase: 'replacement-installed' };
    writeDbSlimmingRequest(options.userDataDir, request);
    // The verified VACUUM INTO output is renamed within the same directory.
    // Re-reading the same multi-gigabyte file after each rename adds no useful
    // corruption coverage and makes cleanup scale with several full DB scans.
    registerInstalledBackup(options, request, paths, true);

    const result = completedResult(request, paths, options.dbFilePath, now());
    try {
      writeDbSlimmingResult(options.userDataDir, result);
    } catch (error) {
      options.log.warn('database slimming result could not be persisted', {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { result, originalDatabaseReady: true };
    }
    request = { ...request, phase: 'committed' };
    try {
      writeDbSlimmingRequest(options.userDataDir, request);
      committed = true;
      finalizeCommittedCleanup(options.userDataDir, paths);
    } catch (error) {
      // The replacement and the completed result are already durable. Keep the
      // on-disk committed marker so the next startup can retry artifact cleanup
      // instead of reporting a false failure or rolling back a database that
      // already passed both integrity checks.
      options.log.warn('database slimming committed cleanup will be retried', {
        requestId: request.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    options.log.info('database slimming completed', {
      requestId: request.id,
      deletedTasks: request.deletedTaskCount,
      archivedTasks: request.archivedTaskCount,
      messages: request.messageCount,
      reclaimedBytes: result.reclaimedBytes,
      backupCreated: result.backupCreated,
    });
    reportProgress(options, 'finalizing', 100, false);
    return { result, originalDatabaseReady: true };
  } catch (error) {
    const maintenanceError = normalizeMaintenanceError(error);
    let originalDatabaseReady = maintenanceError.originalDatabaseReady;
    let rollbackMarkerDurable = false;
    let recoveryStateDurable = true;
    if (!committed && (replacementInstalled || request.phase === 'swap-prepared')) {
      try {
        restoreOriginalDatabase(options.dbFilePath, paths, options.log);
        originalDatabaseReady = verifyDatabaseFile(options.dbFilePath);
      } catch (restoreError) {
        originalDatabaseReady = false;
        options.log.error('database slimming rollback failed', {
          requestId: request.id,
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
      }
      if (originalDatabaseReady) {
        try {
          request = {
            ...request,
            phase: 'rollback-completed',
            rollbackFailureReason: maintenanceError.reason,
          };
          writeDbSlimmingRequest(options.userDataDir, request);
          rollbackMarkerDurable = true;
        } catch (markerError) {
          recoveryStateDurable = false;
          options.log.warn('database slimming rollback marker could not be advanced', {
            requestId: request.id,
            error: markerError instanceof Error ? markerError.message : String(markerError),
          });
        }
      }
    }
    const result: DbSlimmingResultRecord = {
      id: request.id,
      ownerId: request.ownerId,
      status: 'failed',
      finishedAt: now(),
      archiveAgeMonths: request.archiveAgeMonths,
      reason: originalDatabaseReady ? maintenanceError.reason : 'recovery-failed',
      originalDatabaseRestored: originalDatabaseReady,
    };
    let resultPersisted = false;
    try {
      writeDbSlimmingResult(options.userDataDir, result);
      resultPersisted = true;
    } catch (resultError) {
      options.log.warn('database slimming result marker could not be written', {
        requestId: request.id,
        error: resultError instanceof Error ? resultError.message : String(resultError),
      });
    }
    if (originalDatabaseReady && recoveryStateDurable) {
      if (rollbackMarkerDurable) {
        if (resultPersisted && !finalizeFailedCleanup(options.userDataDir, paths)) {
          options.log.warn('database slimming rollback cleanup will be retried', {
            requestId: request.id,
          });
        }
      } else if (resultPersisted && !finalizeFailedCleanup(options.userDataDir, paths)) {
        options.log.warn('database slimming failed cleanup will be retried', {
          requestId: request.id,
        });
      }
    }
    options.log.error('database slimming failed', {
      requestId: request.id,
      reason: result.reason,
      originalDatabaseReady: originalDatabaseReady && recoveryStateDurable,
      error: maintenanceError.message,
    });
    return { result, originalDatabaseReady: originalDatabaseReady && recoveryStateDurable };
  }
}

function maintenancePaths(
  dbFilePath: string,
  request: DbSlimmingRequestRecord,
): MaintenancePaths {
  const dbDir = path.dirname(dbFilePath);
  const customBackupDir = request.backupDirectory
    ? path.resolve(request.backupDirectory)
    : undefined;
  const defaultDirectoryBackup =
    request.backupEnabled &&
    (!customBackupDir || pathsEqual(customBackupDir, path.resolve(dbDir)));
  const backupDir = request.backupEnabled ? (customBackupDir ?? dbDir) : null;
  const backupFinal = backupDir
    ? path.join(backupDir, `${path.basename(dbFilePath)}.slimming-backup`)
    : null;
  return {
    work: `${dbFilePath}.slimming-${request.id}.work`,
    rollback: `${dbFilePath}.slimming-${request.id}.rollback`,
    backupFinal,
    backupPrevious: backupFinal ? `${backupFinal}.${request.id}.previous` : null,
    backupCandidate:
      request.backupEnabled && !defaultDirectoryBackup && backupFinal
        ? `${backupFinal}.${request.id}.candidate`
        : null,
    backupLocation: request.backupEnabled
      ? defaultDirectoryBackup
        ? 'database-directory'
        : 'custom-directory'
      : undefined,
    defaultDirectoryBackup,
  };
}

function assertMaintenanceSpace(
  dbFilePath: string,
  request: DbSlimmingRequestRecord,
  paths: MaintenancePaths,
): void {
  const databaseBytes = Math.max(request.beforeBytes, estimateDbFilesBytes(dbFilePath));
  const dbDir = path.dirname(dbFilePath);
  let required = dbSlimmingTemporaryBytesRequired(databaseBytes);
  const backupDir = paths.backupCandidate ? path.dirname(paths.backupCandidate) : null;
  if (backupDir) {
    let backupDirStat: fs.Stats;
    try {
      backupDirStat = fs.statSync(backupDir);
    } catch (error) {
      throw new DbSlimmingMaintenanceError(
        'backup-failed',
        'backup destination is unavailable',
        true,
        { cause: error },
      );
    }
    if (!backupDirStat.isDirectory()) {
      throw new DbSlimmingMaintenanceError('backup-failed', 'backup destination is not a directory');
    }
  }
  if (backupDir && directoriesShareVolume(dbDir, backupDir)) {
    required += databaseBytes;
  }
  const dbFree = directoryFreeBytes(dbDir);
  if (dbFree !== null && dbFree < required) {
    throw new DbSlimmingMaintenanceError(
      'insufficient-space',
      `database volume needs ${required} bytes but only ${dbFree} bytes are free`,
    );
  }
  if (paths.backupCandidate && backupDir && !directoriesShareVolume(dbDir, backupDir)) {
    const backupFree = directoryFreeBytes(backupDir);
    const backupRequired = databaseBytes + TEMP_SPACE_MARGIN_BYTES;
    if (backupFree !== null && backupFree < backupRequired) {
      throw new DbSlimmingMaintenanceError(
        'insufficient-space',
        `backup volume needs ${backupRequired} bytes but only ${backupFree} bytes are free`,
      );
    }
  }
}

function openSourceDatabase(dbFilePath: string): Database.Database {
  let db: Database.Database;
  try {
    db = createBetterSqliteDatabase(dbFilePath, { fileMustExist: true });
  } catch (error) {
    throw new DbSlimmingMaintenanceError(
      'cleanup-failed',
      'source database could not be opened',
      false,
      { cause: error },
    );
  }
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('wal_checkpoint(TRUNCATE)');
    verifyOpenDatabase(db);
    restrictDbFilePermissions(dbFilePath);
    return db;
  } catch (error) {
    db.close();
    throw new DbSlimmingMaintenanceError('integrity-check-failed', 'source database is invalid', true, {
      cause: error,
    });
  }
}

async function createAndInstallCustomBackup(
  source: Database.Database,
  paths: MaintenancePaths,
  log: DbSlimmingMaintenanceLog,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const candidate = paths.backupCandidate;
  const finalPath = paths.backupFinal;
  const previous = paths.backupPrevious;
  if (!candidate || !finalPath || !previous) return;
  removeDatabaseFamily(candidate);
  removeDatabaseFamily(previous);
  try {
    await source.backup(candidate, {
      progress: (progress) => {
        onProgress?.(backupFraction(progress));
        return 4_096;
      },
    });
    if (!verifyDatabaseFile(candidate)) {
      throw new Error('backup integrity check failed');
    }
    restrictDbFilePermissions(candidate);
    if (fs.existsSync(finalPath)) renameWithRetry(finalPath, previous);
    try {
      renameWithRetry(candidate, finalPath);
    } catch (error) {
      if (fs.existsSync(previous) && !fs.existsSync(finalPath)) {
        renameWithRetry(previous, finalPath);
      }
      throw error;
    }
    removeDatabaseFamily(previous);
    restrictDbFilePermissions(finalPath);
  } catch (error) {
    removeDatabaseFamily(candidate);
    log.warn('database slimming backup creation failed', {
      backupName: path.basename(finalPath),
      error: error instanceof Error ? error.message : String(error),
    });
    throw new DbSlimmingMaintenanceError('backup-failed', 'database backup failed', true, {
      cause: error,
    });
  }
}

function compactWorkingCopy(
  workPath: string,
  request: DbSlimmingRequestRecord,
  options: RunDbSlimmingMaintenanceOptions,
): TargetCounts {
  const vacuumPath = `${workPath}.vacuum`;
  removeDatabaseFamily(vacuumPath);
  let db: Database.Database | null = createBetterSqliteDatabase(workPath, { fileMustExist: true });
  try {
    // This copy is disposable and the untouched source remains the rollback
    // authority. Avoid writing a second copy of changed pages to a rollback
    // journal; a crash simply discards this work file on the next startup.
    db.pragma('journal_mode = OFF');
    db.pragma('synchronous = OFF');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    if (tableExists(db, 'chat_messages_vec_v1')) {
      if (!options.loadVectorExtension?.(db)) {
        throw new DbSlimmingMaintenanceError(
          'cleanup-failed',
          'sqlite vector extension is required to clean message vectors',
        );
      }
    }

    db.exec('DROP TABLE IF EXISTS temp.db_slimming_targets');
    db.exec('CREATE TEMP TABLE db_slimming_targets (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    db.prepare(
      `INSERT INTO temp.db_slimming_targets (id, status)
       SELECT id, status
         FROM sessions
        WHERE ((status = 'deleted' AND updated_at <= ?)
           OR (status = 'archived' AND updated_at <= ?))
          AND EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id)`,
    ).run(request.scannedAt, request.archivedBeforeMs);

    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN t.status = 'deleted' THEN 1 ELSE 0 END) AS deletedTaskCount,
           SUM(CASE WHEN t.status = 'archived' THEN 1 ELSE 0 END) AS archivedTaskCount,
           (SELECT COUNT(*)
              FROM messages m
              JOIN temp.db_slimming_targets target ON target.id = m.session_id) AS messageCount
         FROM temp.db_slimming_targets t`,
      )
      .get() as {
      deletedTaskCount: number | null;
      archivedTaskCount: number | null;
      messageCount: number;
    };
    const targetCounts: TargetCounts = {
      deletedTaskCount: counts.deletedTaskCount ?? 0,
      archivedTaskCount: counts.archivedTaskCount ?? 0,
      messageCount: counts.messageCount ?? 0,
    };

    const activeDb = db;
    const messagesFtsDeleteTriggerSql = triggerSql(activeDb, 'messages_fts_delete');
    const sessionColumns = new Set(
      (
        activeDb.prepare("PRAGMA table_info('sessions')").all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    const listProjectionColumns = [
      'list_preview',
      'list_preview_role',
      'list_message_count',
    ].filter((column) => sessionColumns.has(column));
    reportProgress(options, 'cleaning', 44, true);
    const cleanup = activeDb.transaction(() => {
      // message_id/session_id are UNINDEXED FTS columns. Letting the trigger run
      // once per message turns a large cleanup into N full FTS scans. Drop only
      // this trigger inside the transaction, scan FTS once by session, clear
      // its stable rowid map in bulk, then restore the exact schema SQL.
      if (messagesFtsDeleteTriggerSql) {
        activeDb.exec('DROP TRIGGER messages_fts_delete');
      }
      if (tableExists(activeDb, 'messages_fts')) {
        activeDb.exec(
          `DELETE FROM messages_fts
            WHERE session_id IN (SELECT id FROM temp.db_slimming_targets)`,
        );
      }
      if (tableExists(activeDb, 'messages_fts_rows')) {
        activeDb.exec(
          `DELETE FROM messages_fts_rows
            WHERE message_id IN (
              SELECT message.id
                FROM messages message
                JOIN temp.db_slimming_targets target ON target.id = message.session_id
            )`,
        );
      }
      if (
        tableExists(activeDb, 'chat_messages_vec_v1') &&
        tableExists(activeDb, 'embedding_jobs')
      ) {
        activeDb.exec(
          `DELETE FROM chat_messages_vec_v1
            WHERE rowid IN (
              SELECT job.rowid
                FROM embedding_jobs job
                JOIN messages message ON message.id = job.source_id
                JOIN temp.db_slimming_targets target ON target.id = message.session_id
               WHERE job.source = 'chat'
            )`,
        );
      }
      if (tableExists(activeDb, 'embedding_jobs')) {
        activeDb.exec(
          `DELETE FROM embedding_jobs
            WHERE source = 'chat'
              AND source_id IN (
                SELECT message.id
                  FROM messages message
                  JOIN temp.db_slimming_targets target ON target.id = message.session_id
              )`,
        );
      }
      activeDb.exec(
        `DELETE FROM messages
          WHERE session_id IN (SELECT id FROM temp.db_slimming_targets)`,
      );
      if (listProjectionColumns.length > 0) {
        activeDb.exec(
          `UPDATE sessions
              SET ${listProjectionColumns.map((column) => `${column} = NULL`).join(', ')}
            WHERE id IN (SELECT id FROM temp.db_slimming_targets)`,
        );
      }
      if (messagesFtsDeleteTriggerSql) activeDb.exec(messagesFtsDeleteTriggerSql);
    });
    cleanup();

    db.exec('DROP TABLE temp.db_slimming_targets');
    reportProgress(options, 'compacting', 58, true);
    // VACUUM INTO writes the compact database once. In-place VACUUM first
    // builds a temporary database and then copies it back over the working
    // file, doubling the final write volume for large profiles.
    db.prepare('VACUUM INTO ?').run(vacuumPath);
    restrictDbFilePermissions(vacuumPath);
    db.close();
    db = null;
    reportProgress(options, 'verifying', 90, true);
    if (!verifyDatabaseFile(vacuumPath)) {
      throw new DbSlimmingMaintenanceError(
        'integrity-check-failed',
        'compacted working database did not pass integrity checks',
      );
    }
    restrictDbFilePermissions(vacuumPath);
    removeDatabaseFamily(workPath);
    renameWithRetry(vacuumPath, workPath);
    restrictDbFilePermissions(workPath);
    return targetCounts;
  } catch (error) {
    if (error instanceof DbSlimmingMaintenanceError) throw error;
    throw new DbSlimmingMaintenanceError('cleanup-failed', 'database cleanup failed', true, {
      cause: error,
    });
  } finally {
    db?.close();
    removeDatabaseFamily(vacuumPath);
  }
}

export function discardCancelledDbSlimmingMaintenance(
  userDataDir: string,
  dbFilePath: string,
  request: DbSlimmingRequestRecord,
): void {
  const paths = maintenancePaths(dbFilePath, request);
  recoverInterruptedCustomBackupInstall(paths);
  if (!cleanupUncommittedArtifacts(paths)) {
    throw new Error('cancelled database slimming artifacts could not be removed');
  }
  clearDbSlimmingRequestOrThrow(userDataDir);
}

function reportProgress(
  options: RunDbSlimmingMaintenanceOptions,
  phase: DbSlimmingMaintenanceProgress['phase'],
  progress: number,
  cancellable: boolean,
): void {
  options.onProgress?.({
    phase,
    progress: Math.min(100, Math.max(0, progress)),
    cancellable,
  });
}

function backupFraction(progress: Database.BackupMetadata): number {
  if (progress.totalPages <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - progress.remainingPages / progress.totalPages));
}

function installReplacement(dbFilePath: string, paths: MaintenancePaths): void {
  try {
    removeSidecars(dbFilePath);
    if (paths.defaultDirectoryBackup) {
      if (!paths.backupFinal || !paths.backupPrevious) {
        throw new Error('default backup paths are missing');
      }
      removeDatabaseFamily(paths.backupPrevious);
      if (fs.existsSync(paths.backupFinal)) {
        renameWithRetry(paths.backupFinal, paths.backupPrevious);
      }
      renameWithRetry(dbFilePath, paths.backupFinal);
      renameWithRetry(paths.work, dbFilePath);
      restrictDbFilePermissions(paths.backupFinal);
    } else {
      removeDatabaseFamily(paths.rollback);
      renameWithRetry(dbFilePath, paths.rollback);
      renameWithRetry(paths.work, dbFilePath);
    }
    restrictDbFilePermissions(dbFilePath);
  } catch (error) {
    throw new DbSlimmingMaintenanceError('replacement-failed', 'database replacement failed', true, {
      cause: error,
    });
  }
}

function restoreOriginalDatabase(
  dbFilePath: string,
  paths: MaintenancePaths,
  log: DbSlimmingMaintenanceLog,
): void {
  removeSidecars(dbFilePath);
  const replacementWasInstalled = fs.existsSync(dbFilePath) && !fs.existsSync(paths.work);
  if (paths.defaultDirectoryBackup) {
    const backup = paths.backupFinal;
    if (!backup) throw new Error('default backup path is missing during rollback');
    if ((!fs.existsSync(dbFilePath) || replacementWasInstalled) && !fs.existsSync(backup)) {
      throw new Error('original database backup is missing during rollback');
    }
    if (!fs.existsSync(dbFilePath) || replacementWasInstalled) {
      if (replacementWasInstalled) renameWithRetry(dbFilePath, paths.work);
      renameWithRetry(backup, dbFilePath);
    }
    if (paths.backupPrevious && fs.existsSync(paths.backupPrevious)) {
      renameWithRetry(paths.backupPrevious, backup);
    }
  } else if (!fs.existsSync(dbFilePath) || replacementWasInstalled) {
    if (!fs.existsSync(paths.rollback)) {
      throw new Error('original database rollback file is missing');
    }
    if (replacementWasInstalled) renameWithRetry(dbFilePath, paths.work);
    renameWithRetry(paths.rollback, dbFilePath);
  }
  if (!fs.existsSync(dbFilePath) || !verifyDatabaseFile(dbFilePath)) {
    throw new Error('original database could not be restored');
  }
  restrictDbFilePermissions(dbFilePath);
  log.warn('database slimming replacement rolled back', { databaseName: path.basename(dbFilePath) });
}

function completedResult(
  request: DbSlimmingRequestRecord,
  paths: MaintenancePaths,
  dbFilePath: string,
  finishedAt: number,
): Extract<DbSlimmingResultRecord, { status: 'completed' }> {
  const afterBytes = estimateDbFilesBytes(dbFilePath);
  return {
    id: request.id,
    ownerId: request.ownerId,
    status: 'completed',
    finishedAt,
    archiveAgeMonths: request.archiveAgeMonths,
    deletedTaskCount: request.deletedTaskCount,
    archivedTaskCount: request.archivedTaskCount,
    messageCount: request.messageCount,
    beforeBytes: request.beforeBytes,
    afterBytes,
    reclaimedBytes: Math.max(0, request.beforeBytes - afterBytes),
    backupCreated: request.backupEnabled,
    ...(paths.backupLocation ? { backupLocation: paths.backupLocation } : {}),
    ...(request.backupEnabled && paths.backupFinal
      ? { backupPath: paths.backupFinal }
      : {}),
  };
}

function registerInstalledBackup(
  options: RunDbSlimmingMaintenanceOptions,
  request: DbSlimmingRequestRecord,
  paths: MaintenancePaths,
  alreadyVerified = false,
): void {
  if (!request.backupEnabled || !paths.backupFinal) return;
  if (!alreadyVerified && !verifyDatabaseFile(paths.backupFinal)) {
    throw new DbSlimmingMaintenanceError(
      'backup-failed',
      'installed database slimming backup did not pass integrity checks',
    );
  }
  try {
    adoptDbSlimmingBackup(options.userDataDir, request.ownerId, paths.backupFinal);
  } catch (error) {
    throw new DbSlimmingMaintenanceError(
      'backup-failed',
      'database slimming backup retention state could not be committed',
      true,
      { cause: error },
    );
  }
}

function triggerSql(db: Database.Database, triggerName: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
    .get(triggerName) as { sql: string | null } | undefined;
  if (!row) return null;
  if (!row.sql) throw new Error(`trigger ${triggerName} has no restorable SQL`);
  return row.sql;
}

function verifyDatabaseFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  let db: Database.Database | null = null;
  try {
    db = createBetterSqliteDatabase(filePath, { readonly: true, fileMustExist: true });
    verifyOpenDatabase(db);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort probe close.
    }
  }
}

function verifyOpenDatabase(db: Database.Database): void {
  const quickCheck = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
  if (!quickCheck || Object.values(quickCheck)[0] !== 'ok') {
    throw new Error('PRAGMA quick_check failed');
  }
  const foreignKeyIssue = db.prepare('PRAGMA foreign_key_check').get();
  if (foreignKeyIssue) throw new Error('PRAGMA foreign_key_check failed');
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
      .get(tableName),
  );
}

function finalizeCommittedCleanup(userDataDir: string, paths: MaintenancePaths): void {
  if (!cleanupAfterCommit(paths)) {
    throw new Error('database slimming committed artifacts could not be removed');
  }
  clearDbSlimmingRequestOrThrow(userDataDir);
}

function finalizeFailedCleanup(userDataDir: string, paths: MaintenancePaths): boolean {
  return cleanupUncommittedArtifacts(paths) && clearDbSlimmingRequest(userDataDir);
}

function clearDbSlimmingRequestOrThrow(userDataDir: string): void {
  if (!clearDbSlimmingRequest(userDataDir)) {
    throw new Error('database slimming request marker could not be cleared');
  }
}

function cleanupAfterCommit(paths: MaintenancePaths): boolean {
  const artifacts = [
    paths.work,
    `${paths.work}.vacuum`,
    paths.rollback,
    paths.backupPrevious,
    paths.backupCandidate,
  ].filter((candidate): candidate is string => candidate !== null);
  return artifacts.map((candidate) => removeDatabaseFamily(candidate)).every(Boolean);
}

function recoverInterruptedCustomBackupInstall(paths: MaintenancePaths): void {
  if (!paths.backupCandidate || !paths.backupFinal || !paths.backupPrevious) return;
  if (!fs.existsSync(paths.backupPrevious)) return;
  try {
    if (!fs.existsSync(paths.backupFinal) || !verifyDatabaseFile(paths.backupFinal)) {
      removeDatabaseFamily(paths.backupFinal);
      renameWithRetry(paths.backupPrevious, paths.backupFinal);
    }
  } catch (error) {
    throw new DbSlimmingMaintenanceError(
      'backup-failed',
      'interrupted database slimming backup could not be recovered',
      true,
      { cause: error },
    );
  }
}

function cleanupUncommittedArtifacts(paths: MaintenancePaths): boolean {
  const artifacts = [
    paths.work,
    `${paths.work}.vacuum`,
    paths.rollback,
    paths.backupPrevious,
    paths.backupCandidate,
  ].filter((candidate): candidate is string => candidate !== null);
  return artifacts.map((candidate) => removeDatabaseFamily(candidate)).every(Boolean);
}

function removeDatabaseFamily(filePath: string): boolean {
  return [filePath, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${filePath}${suffix}`)]
    .map((candidate) => removeExactFile(candidate))
    .every(Boolean);
}

function removeSidecars(filePath: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) removeExactFile(`${filePath}${suffix}`);
}

function removeExactFile(filePath: string): boolean {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(filePath, { force: true });
      return !fs.existsSync(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || !['EBUSY', 'EACCES', 'EPERM'].includes(code ?? '')) {
        return !fs.existsSync(filePath);
      }
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        20 * (attempt + 1),
      );
    }
  }
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || !['EBUSY', 'EACCES', 'ENOTEMPTY'].includes(code ?? '')) throw error;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        20 * (attempt + 1),
      );
    }
  }
}

function directoryFreeBytes(directory: string): number | null {
  try {
    if (typeof fs.statfsSync !== 'function') return null;
    const stat = fs.statfsSync(directory);
    return stat.bsize * stat.bavail;
  } catch {
    return null;
  }
}

function pathsEqual(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function directoriesShareVolume(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return pathsEqual(path.parse(path.resolve(left)).root, path.parse(path.resolve(right)).root);
  }
  try {
    return fs.statSync(left).dev === fs.statSync(right).dev;
  } catch {
    // On platforms/filesystems where device ids are unavailable, a matching
    // volume root is the safest conservative fallback for the common case.
    const leftRoot = path.parse(path.resolve(left)).root;
    const rightRoot = path.parse(path.resolve(right)).root;
    return pathsEqual(leftRoot, rightRoot);
  }
}

function normalizeMaintenanceError(error: unknown): DbSlimmingMaintenanceError {
  if (error instanceof DbSlimmingMaintenanceError) return error;
  return new DbSlimmingMaintenanceError(
    'cleanup-failed',
    error instanceof Error ? error.message : String(error),
    true,
    { cause: error },
  );
}
