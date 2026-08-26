import fs from 'node:fs';
import path from 'node:path';

import {
  DB_SLIMMING_ARCHIVE_AGE_OPTIONS,
  type DbSlimmingArchiveAge,
  DbSlimmingBackupLocation,
  DbSlimmingFailureReason,
  DbSlimmingResult,
} from '../../shared/localDbMaintenance';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile';

const REQUEST_FILE_NAME = 'db-slimming-request.json';
const RESULT_FILE_NAME = 'db-slimming-result.json';
const BACKUP_INDEX_FILE_NAME = 'db-slimming-backups.json';
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DbSlimmingRequestPhase =
  | 'scheduled'
  | 'swap-prepared'
  | 'replacement-installed'
  | 'rollback-completed'
  | 'committed';

/** Cross-restart request owned by main. It never accepts a database path from Renderer. */
export interface DbSlimmingRequestRecord {
  version: 1;
  id: string;
  ownerId: string;
  createdAt: number;
  scannedAt: number;
  archivedBeforeMs: number;
  archiveAgeMonths: DbSlimmingArchiveAge;
  deletedTaskCount: number;
  archivedTaskCount: number;
  messageCount: number;
  estimatedMessageBytes?: number;
  beforeBytes: number;
  backupEnabled: boolean;
  backupDirectory?: string;
  phase: DbSlimmingRequestPhase;
  rollbackFailureReason?: DbSlimmingFailureReason;
}

/** The marker was readable, but its JSON or validated record shape is invalid. */
export class InvalidDbSlimmingRequestMarkerError extends Error {
  constructor(cause?: unknown) {
    super('invalid database slimming request marker');
    this.name = 'InvalidDbSlimmingRequestMarkerError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** Persisted result keeps the privileged backup path out of the Renderer contract. */
export type DbSlimmingResultRecord =
  | (Extract<DbSlimmingResult, { status: 'completed' }> & {
      ownerId: string;
      backupPath?: string;
    })
  | (Extract<DbSlimmingResult, { status: 'failed' }> & { ownerId: string });

interface DbSlimmingBackupIndexRecord {
  version: 1;
  owners: Record<
    string,
    {
      currentPath: string;
      stalePaths: string[];
    }
  >;
}

export function dbSlimmingRequestPath(userDataDir: string): string {
  return path.join(userDataDir, REQUEST_FILE_NAME);
}

export function dbSlimmingResultPath(userDataDir: string): string {
  return path.join(userDataDir, RESULT_FILE_NAME);
}

function dbSlimmingBackupIndexPath(userDataDir: string): string {
  return path.join(userDataDir, BACKUP_INDEX_FILE_NAME);
}

export function readDbSlimmingRequest(userDataDir: string): DbSlimmingRequestRecord | null {
  const raw = readAtomicFileSync(dbSlimmingRequestPath(userDataDir));
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new InvalidDbSlimmingRequestMarkerError(error);
  }
  if (!isDbSlimmingRequestRecord(value)) {
    throw new InvalidDbSlimmingRequestMarkerError();
  }
  return value;
}

export function writeDbSlimmingRequest(
  userDataDir: string,
  request: DbSlimmingRequestRecord,
): void {
  atomicWriteFileSync(dbSlimmingRequestPath(userDataDir), JSON.stringify(request));
}

export function clearDbSlimmingRequest(userDataDir: string): boolean {
  return removeAtomicMarker(dbSlimmingRequestPath(userDataDir));
}

export function readDbSlimmingResult(userDataDir: string): DbSlimmingResultRecord | null {
  const raw = readAtomicFileSync(dbSlimmingResultPath(userDataDir));
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (!isDbSlimmingResultRecord(value)) {
    throw new Error('invalid database slimming result marker');
  }
  return value;
}

export function writeDbSlimmingResult(userDataDir: string, result: DbSlimmingResultRecord): void {
  atomicWriteFileSync(dbSlimmingResultPath(userDataDir), JSON.stringify(result));
}

export function clearDbSlimmingResult(userDataDir: string): boolean {
  return removeAtomicMarker(dbSlimmingResultPath(userDataDir));
}

export function publicDbSlimmingResult(record: DbSlimmingResultRecord): DbSlimmingResult {
  if (record.status === 'failed') {
    const { ownerId: _ownerId, ...result } = record;
    return result;
  }
  const { ownerId: _ownerId, backupPath: _backupPath, ...result } = record;
  return result;
}

export function adoptDbSlimmingBackup(
  userDataDir: string,
  ownerId: string,
  backupPath: string,
): void {
  if (!ownerId || !isSlimmingBackupPath(backupPath)) {
    throw new Error('invalid database slimming backup index input');
  }
  const index = readDbSlimmingBackupIndex(userDataDir);
  const previous = index.owners[ownerId];
  const stalePaths = [
    ...(previous?.stalePaths ?? []),
    ...(previous && !pathsEqual(previous.currentPath, backupPath)
      ? [previous.currentPath]
      : []),
  ].filter((candidate, position, all) =>
    !pathsEqual(candidate, backupPath) &&
    all.findIndex((other) => pathsEqual(other, candidate)) === position,
  );
  index.owners[ownerId] = { currentPath: backupPath, stalePaths };
  writeDbSlimmingBackupIndex(userDataDir, index);

  const remaining = stalePaths.filter((candidate) => !removeBackupFamily(candidate));
  if (remaining.length !== stalePaths.length) {
    index.owners[ownerId] = { currentPath: backupPath, stalePaths: remaining };
    try {
      writeDbSlimmingBackupIndex(userDataDir, index);
    } catch {
      // The first index write already made the new verified backup authoritative.
      // Keeping already-removed paths in stalePaths is safe and lets a future
      // adoption retry the idempotent cleanup without invalidating the backup.
    }
  }
}

function readDbSlimmingBackupIndex(userDataDir: string): DbSlimmingBackupIndexRecord {
  const raw = readAtomicFileSync(dbSlimmingBackupIndexPath(userDataDir));
  if (raw === null) return { version: 1, owners: {} };
  const value: unknown = JSON.parse(raw);
  if (!isDbSlimmingBackupIndexRecord(value)) {
    throw new Error('invalid database slimming backup index');
  }
  return value;
}

function writeDbSlimmingBackupIndex(
  userDataDir: string,
  index: DbSlimmingBackupIndexRecord,
): void {
  atomicWriteFileSync(dbSlimmingBackupIndexPath(userDataDir), JSON.stringify(index));
}

function removeBackupFamily(filePath: string): boolean {
  try {
    for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]) {
      fs.rmSync(candidate, { force: true, maxRetries: 3, retryDelay: 20 });
    }
    return true;
  } catch {
    return false;
  }
}

function removeAtomicMarker(filePath: string): boolean {
  for (const candidate of [filePath, `${filePath}.bak`]) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.rmSync(candidate, { force: true });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 3 || !['EBUSY', 'EACCES', 'EPERM'].includes(code ?? '')) break;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          20 * (attempt + 1),
        );
      }
    }
  }
  return !fs.existsSync(filePath) && !fs.existsSync(`${filePath}.bak`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDbSlimmingRequestRecord(value: unknown): value is DbSlimmingRequestRecord {
  if (!isRecord(value)) return false;
  if (
    value.version !== 1 ||
    typeof value.id !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.id) ||
    typeof value.ownerId !== 'string' ||
    value.ownerId.length === 0 ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.scannedAt) ||
    !isFiniteNumber(value.archivedBeforeMs) ||
    !isArchiveAge(value.archiveAgeMonths) ||
    !Number.isInteger(value.deletedTaskCount) ||
    !Number.isInteger(value.archivedTaskCount) ||
    !Number.isInteger(value.messageCount) ||
    (value.estimatedMessageBytes !== undefined &&
      (!isFiniteNumber(value.estimatedMessageBytes) || value.estimatedMessageBytes < 0)) ||
    !isFiniteNumber(value.beforeBytes) ||
    typeof value.backupEnabled !== 'boolean' ||
    ![
      'scheduled',
      'swap-prepared',
      'replacement-installed',
      'rollback-completed',
      'committed',
    ].includes(
      String(value.phase),
    )
  ) {
    return false;
  }
  const rollbackFailureIsValid =
    value.phase === 'rollback-completed'
      ? isFailureReason(value.rollbackFailureReason)
      : value.rollbackFailureReason === undefined;
  return (
    rollbackFailureIsValid &&
    (value.backupDirectory === undefined ||
      (typeof value.backupDirectory === 'string' && path.isAbsolute(value.backupDirectory)))
  );
}

function isDbSlimmingResultRecord(value: unknown): value is DbSlimmingResultRecord {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    !REQUEST_ID_PATTERN.test(value.id) ||
    typeof value.ownerId !== 'string' ||
    !isFiniteNumber(value.finishedAt) ||
    !isArchiveAge(value.archiveAgeMonths)
  ) {
    return false;
  }
  if (value.status === 'failed') {
    return (
      isFailureReason(value.reason) && typeof value.originalDatabaseRestored === 'boolean'
    );
  }
  if (value.status !== 'completed') return false;
  return (
    Number.isInteger(value.deletedTaskCount) &&
    Number.isInteger(value.archivedTaskCount) &&
    Number.isInteger(value.messageCount) &&
    isFiniteNumber(value.beforeBytes) &&
    isFiniteNumber(value.afterBytes) &&
    isFiniteNumber(value.reclaimedBytes) &&
    typeof value.backupCreated === 'boolean' &&
    (value.backupLocation === undefined || isBackupLocation(value.backupLocation)) &&
    (value.backupPath === undefined ||
      (typeof value.backupPath === 'string' && path.isAbsolute(value.backupPath)))
  );
}

function isDbSlimmingBackupIndexRecord(value: unknown): value is DbSlimmingBackupIndexRecord {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.owners)) return false;
  return Object.entries(value.owners).every(([ownerId, entry]) => {
    if (!ownerId || !isRecord(entry) || typeof entry.currentPath !== 'string') return false;
    if (!isSlimmingBackupPath(entry.currentPath) || !Array.isArray(entry.stalePaths)) return false;
    return entry.stalePaths.every(
      (candidate) => typeof candidate === 'string' && isSlimmingBackupPath(candidate),
    );
  });
}

function isFailureReason(value: unknown): value is DbSlimmingFailureReason {
  return [
    'backup-failed',
    'cleanup-failed',
    'database-in-use',
    'insufficient-space',
    'integrity-check-failed',
    'replacement-failed',
    'recovery-failed',
  ].includes(String(value));
}

function isBackupLocation(value: unknown): value is DbSlimmingBackupLocation {
  return value === 'database-directory' || value === 'custom-directory';
}

function isArchiveAge(value: unknown): value is DbSlimmingArchiveAge {
  return DB_SLIMMING_ARCHIVE_AGE_OPTIONS.includes(value as DbSlimmingArchiveAge);
}

function pathsEqual(left: string, right: string): boolean {
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function isSlimmingBackupPath(filePath: string): boolean {
  return path.isAbsolute(filePath) && path.basename(filePath).endsWith('.slimming-backup');
}
