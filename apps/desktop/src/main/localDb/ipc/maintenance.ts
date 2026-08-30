import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type {
  DbSlimmingArchiveAge,
  DbSlimmingBackupDirectorySelection,
  DbSlimmingResult,
  DbSlimmingScanInput,
  DbSlimmingScanResult,
  DbSlimmingScheduleInput,
  DbSlimmingScheduleResult,
} from '../../../shared/localDbMaintenance';
import {
  DB_SLIMMING_ARCHIVE_AGE_OPTIONS,
} from '../../../shared/localDbMaintenance';
import { throwIpcError } from '../../utils/ipcValidate';
import type { DbClient } from '../client/DbClient';
import {
  dbSlimmingTemporaryBytesRequired,
  dbVolumeFreeBytes,
  estimateDbFilesBytes,
} from '../dbSlimmingMaintenance';
import {
  clearDbSlimmingResult,
  publicDbSlimmingResult,
  readDbSlimmingRequest,
  readDbSlimmingResult,
  type DbSlimmingResultRecord,
  writeDbSlimmingRequest,
} from '../maintenanceStore';

const GRANT_TTL_MS = 30 * 60 * 1000;

interface OwnerSnapshot {
  ownerId: string;
  scopeKey: string;
}

interface ScanGrant extends DbSlimmingScanResult {
  ownerId: string;
  scopeKey: string;
  expiresAt: number;
}

interface DirectoryGrant {
  ownerId: string;
  scopeKey: string;
  directory: string;
  expiresAt: number;
}

interface ScanAggregateRow {
  activeTaskCount: number | null;
  deletedTaskCount: number | null;
  archivedTaskCount: number | null;
  messageCount: number;
  estimatedMessageBytes: number | null;
}

export interface LocalDbMaintenanceIpcDeps {
  captureOwner(): OwnerSnapshot | null;
  isOwnerCurrent(snapshot: OwnerSnapshot): boolean;
  getDbClient(): DbClient;
  getDbClientOwnerId(): string | null;
  getCurrentDbPath(): string | null;
  getUserDataDir(): string;
  canSchedule(): boolean;
  selectBackupDirectory(): Promise<string | null>;
  confirmActiveTaskCleanup(input: { backupEnabled: boolean }): Promise<boolean>;
  confirmWithoutBackup(): Promise<boolean>;
  revealFile(filePath: string): Promise<boolean>;
  relaunch(requestId: string): void;
}

/** Main-owned grants keep Renderer-supplied ids from becoming path or time authorization. */
export function createLocalDbMaintenanceIpcHandlers(deps: LocalDbMaintenanceIpcDeps) {
  const scanGrants = new Map<string, ScanGrant>();
  const directoryGrants = new Map<string, DirectoryGrant>();
  const resultCache = new Map<string, DbSlimmingResultRecord>();
  const pendingScheduleIds = new Set<string>();

  const captureReadyOwner = (): OwnerSnapshot => {
    const owner = deps.captureOwner();
    if (!owner || deps.getDbClientOwnerId() !== owner.ownerId) {
      throwIpcError('PRECONDITION_FAILED', 'database maintenance requires a ready data owner');
    }
    return owner;
  };

  const assertOwnerCurrent = (owner: OwnerSnapshot): void => {
    if (!deps.isOwnerCurrent(owner) || deps.getDbClientOwnerId() !== owner.ownerId) {
      throwIpcError('PRECONDITION_FAILED', 'database owner changed during maintenance request');
    }
  };

  const pruneExpiredGrants = (): void => {
    const now = Date.now();
    for (const [id, grant] of scanGrants) {
      if (grant.expiresAt <= now) scanGrants.delete(id);
    }
    for (const [id, grant] of directoryGrants) {
      if (grant.expiresAt <= now) directoryGrants.delete(id);
    }
  };

  const loadResultForOwner = (ownerId: string): DbSlimmingResultRecord | null => {
    const cached = resultCache.get(ownerId);
    if (cached) return cached;
    const stored = readDbSlimmingResult(deps.getUserDataDir());
    if (!stored || stored.ownerId !== ownerId) return null;
    resultCache.set(ownerId, stored);
    clearDbSlimmingResult(deps.getUserDataDir());
    return stored;
  };

  return {
    async scan(input: DbSlimmingScanInput): Promise<DbSlimmingScanResult> {
      const archiveAgeMonths = validateArchiveAge(input?.archiveAgeMonths);
      const includeActiveTasks = validateIncludeActiveTasks(input?.includeActiveTasks);
      const owner = captureReadyOwner();
      const scannedAt = Date.now();
      const archivedBeforeMs = archiveCutoffForAge(scannedAt, archiveAgeMonths);
      const row = await deps.getDbClient().queryOne<ScanAggregateRow>(
        `WITH target_sessions AS (
           SELECT id, status
             FROM sessions
            WHERE ((status = 'deleted' AND updated_at <= ?)
               OR (status = 'archived' AND updated_at <= ?)
               OR (? = 1 AND status = 'active' AND updated_at <= ?))
              AND EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id)
         )
         SELECT
           (SELECT COUNT(*) FROM target_sessions WHERE status = 'active') AS activeTaskCount,
           (SELECT COUNT(*) FROM target_sessions WHERE status = 'deleted') AS deletedTaskCount,
           (SELECT COUNT(*) FROM target_sessions WHERE status = 'archived') AS archivedTaskCount,
           (SELECT COUNT(*)
              FROM messages message
              JOIN target_sessions target ON target.id = message.session_id) AS messageCount,
           (SELECT COALESCE(SUM(
                     length(CAST(message.id AS BLOB)) +
                     length(CAST(message.client_id AS BLOB)) +
                     length(CAST(message.role AS BLOB)) +
                     length(CAST(message.content AS BLOB)) +
                     COALESCE(length(CAST(message.tool_use_id AS BLOB)), 0) +
                     COALESCE(length(CAST(message.agent_meta AS BLOB)), 0) +
                     COALESCE(length(CAST(message.agent_kind AS BLOB)), 0)
                   ), 0)
              FROM messages message
              JOIN target_sessions target ON target.id = message.session_id) AS estimatedMessageBytes`,
        [archivedBeforeMs, archivedBeforeMs, includeActiveTasks ? 1 : 0, archivedBeforeMs],
      );
      assertOwnerCurrent(owner);
      const dbFilePath = deps.getCurrentDbPath();
      if (!dbFilePath || !fs.existsSync(dbFilePath)) {
        throwIpcError('PRECONDITION_FAILED', 'database path is unavailable');
      }
      const databaseBytes = estimateDbFilesBytes(dbFilePath);
      const scanId = randomUUID();
      const result: DbSlimmingScanResult = {
        scanId,
        archiveAgeMonths,
        includeActiveTasks,
        scannedAt,
        archivedBeforeMs,
        activeTaskCount: row?.activeTaskCount ?? 0,
        deletedTaskCount: row?.deletedTaskCount ?? 0,
        archivedTaskCount: row?.archivedTaskCount ?? 0,
        messageCount: row?.messageCount ?? 0,
        estimatedMessageBytes: row?.estimatedMessageBytes ?? 0,
        databaseBytes,
        temporaryBytesRequired: dbSlimmingTemporaryBytesRequired(databaseBytes),
        databaseVolumeFreeBytes: dbVolumeFreeBytes(dbFilePath),
      };
      pruneExpiredGrants();
      scanGrants.set(scanId, {
        ...result,
        ownerId: owner.ownerId,
        scopeKey: owner.scopeKey,
        expiresAt: Date.now() + GRANT_TTL_MS,
      });
      return result;
    },

    async chooseBackupDirectory(): Promise<DbSlimmingBackupDirectorySelection> {
      const owner = captureReadyOwner();
      const directory = await deps.selectBackupDirectory();
      if (!directory) return { selected: false };
      assertOwnerCurrent(owner);
      const grantId = randomUUID();
      pruneExpiredGrants();
      directoryGrants.set(grantId, {
        ownerId: owner.ownerId,
        scopeKey: owner.scopeKey,
        directory,
        expiresAt: Date.now() + GRANT_TTL_MS,
      });
      return { selected: true, grantId, displayPath: directory };
    },

    async schedule(input: DbSlimmingScheduleInput): Promise<DbSlimmingScheduleResult> {
      if (!input || typeof input !== 'object') {
        throwIpcError('INVALID_PARAMS', 'database maintenance schedule input is required');
      }
      if (typeof input.scanId !== 'string' || typeof input.backupEnabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'invalid database maintenance schedule input');
      }
      pruneExpiredGrants();
      if (!deps.canSchedule()) {
        throwIpcError(
          'PRECONDITION_FAILED',
          'database maintenance cannot be scheduled from a shared passive instance',
        );
      }
      const owner = captureReadyOwner();
      const scan = scanGrants.get(input.scanId);
      if (
        !scan ||
        scan.ownerId !== owner.ownerId ||
        scan.scopeKey !== owner.scopeKey ||
        scan.expiresAt <= Date.now()
      ) {
        throwIpcError('PRECONDITION_FAILED', 'database maintenance scan expired; scan again');
      }
      if (scan.messageCount === 0) return { scheduled: false };
      if (pendingScheduleIds.has(scan.scanId)) {
        throwIpcError('PRECONDITION_FAILED', 'database maintenance confirmation is already open');
      }
      pendingScheduleIds.add(scan.scanId);
      try {
        let backupDirectory: string | undefined;
        let directoryGrant: DirectoryGrant | undefined;
        if (input.backupDirectoryGrantId !== undefined) {
          if (!input.backupEnabled || typeof input.backupDirectoryGrantId !== 'string') {
            throwIpcError('INVALID_PARAMS', 'invalid database backup directory selection');
          }
          directoryGrant = directoryGrants.get(input.backupDirectoryGrantId);
          if (
            !directoryGrant ||
            directoryGrant.ownerId !== owner.ownerId ||
            directoryGrant.scopeKey !== owner.scopeKey ||
            directoryGrant.expiresAt <= Date.now()
          ) {
            throwIpcError('PRECONDITION_FAILED', 'database backup directory selection expired');
          }
          backupDirectory = directoryGrant.directory;
        }

        if (
          scan.includeActiveTasks &&
          !(await deps.confirmActiveTaskCleanup({ backupEnabled: input.backupEnabled }))
        ) {
          return { scheduled: false };
        }
        if (
          !scan.includeActiveTasks &&
          !input.backupEnabled &&
          !(await deps.confirmWithoutBackup())
        ) {
          return { scheduled: false };
        }

        pruneExpiredGrants();
        if (!deps.canSchedule()) {
          throwIpcError(
            'PRECONDITION_FAILED',
            'database maintenance cannot be scheduled from a shared passive instance',
          );
        }
        assertOwnerCurrent(owner);
        const liveScan = scanGrants.get(scan.scanId);
        if (
          liveScan !== scan ||
          scan.expiresAt <= Date.now() ||
          (directoryGrant !== undefined &&
            directoryGrants.get(input.backupDirectoryGrantId!) !== directoryGrant)
        ) {
          throwIpcError(
            'PRECONDITION_FAILED',
            'database maintenance authorization expired during confirmation',
          );
        }
        const dbFilePath = deps.getCurrentDbPath();
        if (!dbFilePath || !fs.existsSync(dbFilePath)) {
          throwIpcError('PRECONDITION_FAILED', 'database path is unavailable');
        }
        const userDataDir = deps.getUserDataDir();
        let existingRequest: ReturnType<typeof readDbSlimmingRequest>;
        try {
          existingRequest = readDbSlimmingRequest(userDataDir);
        } catch {
          throwIpcError(
            'PRECONDITION_FAILED',
            'database maintenance request marker is unavailable',
          );
        }
        if (existingRequest) {
          throwIpcError(
            'PRECONDITION_FAILED',
            'database maintenance recovery is already pending',
          );
        }
        clearDbSlimmingResult(userDataDir);
        resultCache.delete(owner.ownerId);
        writeDbSlimmingRequest(userDataDir, {
          version: 1,
          id: scan.scanId,
          ownerId: owner.ownerId,
          createdAt: Date.now(),
          scannedAt: scan.scannedAt,
          archivedBeforeMs: scan.archivedBeforeMs,
          archiveAgeMonths: scan.archiveAgeMonths,
          includeActiveTasks: scan.includeActiveTasks,
          activeTaskCount: scan.activeTaskCount,
          deletedTaskCount: scan.deletedTaskCount,
          archivedTaskCount: scan.archivedTaskCount,
          messageCount: scan.messageCount,
          estimatedMessageBytes: scan.estimatedMessageBytes,
          beforeBytes: scan.databaseBytes,
          backupEnabled: input.backupEnabled,
          ...(backupDirectory ? { backupDirectory } : {}),
          phase: 'scheduled',
        });
        scanGrants.delete(scan.scanId);
        if (input.backupDirectoryGrantId) {
          directoryGrants.delete(input.backupDirectoryGrantId);
        }
        deps.relaunch(scan.scanId);
        return { scheduled: true };
      } finally {
        pendingScheduleIds.delete(scan.scanId);
      }
    },

    getLastResult(): DbSlimmingResult | null {
      const owner = captureReadyOwner();
      const result = loadResultForOwner(owner.ownerId);
      return result ? publicDbSlimmingResult(result) : null;
    },

    async openLastBackupDirectory(): Promise<{ opened: boolean }> {
      const owner = captureReadyOwner();
      const result = loadResultForOwner(owner.ownerId);
      if (!result || result.status !== 'completed' || !result.backupPath) {
        return { opened: false };
      }
      return { opened: await deps.revealFile(result.backupPath) };
    },
  };
}

function validateArchiveAge(value: unknown): DbSlimmingArchiveAge {
  if (!DB_SLIMMING_ARCHIVE_AGE_OPTIONS.includes(value as DbSlimmingArchiveAge)) {
    throwIpcError('INVALID_PARAMS', 'invalid database maintenance archive threshold');
  }
  return value as DbSlimmingArchiveAge;
}

function validateIncludeActiveTasks(value: unknown): boolean {
  // Missing means the legacy, safest scope for older callers.
  if (value === undefined) return false;
  if (typeof value !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'invalid active-task database maintenance option');
  }
  return value;
}

/** Uses an exact seven-day duration or calendar months with month-end clamping. */
export function archiveCutoffForAge(
  scannedAt: number,
  archiveAge: DbSlimmingArchiveAge,
): number {
  if (archiveAge === '7-days') {
    return scannedAt - 7 * 24 * 60 * 60 * 1000;
  }
  const cutoff = new Date(scannedAt);
  const dayOfMonth = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - archiveAge);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return cutoff.getTime();
}
