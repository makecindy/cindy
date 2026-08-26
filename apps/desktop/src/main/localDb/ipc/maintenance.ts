import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import type {
  DbSlimmingArchiveMonths,
  DbSlimmingBackupDirectorySelection,
  DbSlimmingResult,
  DbSlimmingScanInput,
  DbSlimmingScanResult,
  DbSlimmingScheduleInput,
  DbSlimmingScheduleResult,
} from '../../../shared/localDbMaintenance';
import {
  DB_SLIMMING_ARCHIVE_MONTH_OPTIONS,
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
  confirmWithoutBackup(): Promise<boolean>;
  revealFile(filePath: string): Promise<boolean>;
  relaunch(): void;
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
      const archiveAgeMonths = validateArchiveAgeMonths(input?.archiveAgeMonths);
      const owner = captureReadyOwner();
      const scannedAt = Date.now();
      const archivedBeforeMs = archiveCutoffForMonths(scannedAt, archiveAgeMonths);
      const row = await deps.getDbClient().queryOne<ScanAggregateRow>(
        `WITH target_sessions AS (
           SELECT id, status
             FROM sessions
            WHERE ((status = 'deleted' AND updated_at <= ?)
               OR (status = 'archived' AND updated_at <= ?))
              AND EXISTS (SELECT 1 FROM messages WHERE messages.session_id = sessions.id)
         )
         SELECT
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
        [scannedAt, archivedBeforeMs],
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
        scannedAt,
        archivedBeforeMs,
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

        if (!input.backupEnabled && !(await deps.confirmWithoutBackup())) {
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
          deletedTaskCount: scan.deletedTaskCount,
          archivedTaskCount: scan.archivedTaskCount,
          messageCount: scan.messageCount,
          beforeBytes: scan.databaseBytes,
          backupEnabled: input.backupEnabled,
          ...(backupDirectory ? { backupDirectory } : {}),
          phase: 'scheduled',
        });
        scanGrants.delete(scan.scanId);
        if (input.backupDirectoryGrantId) {
          directoryGrants.delete(input.backupDirectoryGrantId);
        }
        deps.relaunch();
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

function validateArchiveAgeMonths(value: unknown): DbSlimmingArchiveMonths {
  if (!DB_SLIMMING_ARCHIVE_MONTH_OPTIONS.includes(value as DbSlimmingArchiveMonths)) {
    throwIpcError('INVALID_PARAMS', 'archive age months must be 1, 3, or 6');
  }
  return value as DbSlimmingArchiveMonths;
}

/** Subtracts calendar months and clamps month-end dates (for example Mar 31 -> Feb 28). */
export function archiveCutoffForMonths(
  scannedAt: number,
  archiveAgeMonths: DbSlimmingArchiveMonths,
): number {
  const cutoff = new Date(scannedAt);
  const dayOfMonth = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - archiveAgeMonths);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return cutoff.getTime();
}
