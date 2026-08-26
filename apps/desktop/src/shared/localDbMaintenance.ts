export const DB_SLIMMING_ARCHIVE_MONTH_OPTIONS = [1, 3, 6] as const;
export type DbSlimmingArchiveMonths = (typeof DB_SLIMMING_ARCHIVE_MONTH_OPTIONS)[number];
export const DB_SLIMMING_DEFAULT_ARCHIVE_MONTHS: DbSlimmingArchiveMonths = 3;

export type DbSlimmingBackupLocation = 'database-directory' | 'custom-directory';

export interface DbSlimmingScanInput {
  archiveAgeMonths: DbSlimmingArchiveMonths;
}

export interface DbSlimmingScanResult {
  scanId: string;
  archiveAgeMonths: DbSlimmingArchiveMonths;
  scannedAt: number;
  archivedBeforeMs: number;
  deletedTaskCount: number;
  archivedTaskCount: number;
  messageCount: number;
  estimatedMessageBytes: number;
  databaseBytes: number;
  temporaryBytesRequired: number;
  databaseVolumeFreeBytes: number | null;
}

export interface DbSlimmingBackupDirectorySelection {
  selected: boolean;
  grantId?: string;
  displayPath?: string;
}

export interface DbSlimmingScheduleInput {
  scanId: string;
  backupEnabled: boolean;
  backupDirectoryGrantId?: string;
}

export type DbSlimmingScheduleResult = { scheduled: true } | { scheduled: false };

export type DbSlimmingFailureReason =
  | 'backup-failed'
  | 'cleanup-failed'
  | 'database-in-use'
  | 'insufficient-space'
  | 'integrity-check-failed'
  | 'replacement-failed'
  | 'recovery-failed';

export type DbSlimmingResult =
  | {
      id: string;
      status: 'completed';
      finishedAt: number;
      archiveAgeMonths: DbSlimmingArchiveMonths;
      deletedTaskCount: number;
      archivedTaskCount: number;
      messageCount: number;
      beforeBytes: number;
      afterBytes: number;
      reclaimedBytes: number;
      backupCreated: boolean;
      backupLocation?: DbSlimmingBackupLocation;
    }
  | {
      id: string;
      status: 'failed';
      finishedAt: number;
      archiveAgeMonths: DbSlimmingArchiveMonths;
      reason: DbSlimmingFailureReason;
      originalDatabaseRestored: boolean;
    };
