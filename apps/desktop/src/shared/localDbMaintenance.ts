export const DB_SLIMMING_ARCHIVE_AGE_OPTIONS = ['7-days', 1, 3, 6] as const;
export type DbSlimmingArchiveAge = (typeof DB_SLIMMING_ARCHIVE_AGE_OPTIONS)[number];
export const DB_SLIMMING_DEFAULT_ARCHIVE_AGE: DbSlimmingArchiveAge = '7-days';
export const DB_SLIMMING_STARTUP_PROGRESS_CHANGED_CHANNEL =
  'local-db:maintenance:startup-progress-changed';

export type DbSlimmingBackupLocation = 'database-directory' | 'custom-directory';

export interface DbSlimmingScanInput {
  /** Legacy wire key retained so existing numeric month requests stay readable. */
  archiveAgeMonths: DbSlimmingArchiveAge;
  /** Explicit opt-in: active tasks are excluded from cleanup by default. */
  includeActiveTasks?: boolean;
}

export interface DbSlimmingScanResult {
  scanId: string;
  archiveAgeMonths: DbSlimmingArchiveAge;
  includeActiveTasks: boolean;
  scannedAt: number;
  archivedBeforeMs: number;
  activeTaskCount: number;
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

export type DbSlimmingStartupPhase =
  | 'preparing'
  | 'backing-up'
  | 'copying'
  | 'cleaning'
  | 'compacting'
  | 'verifying'
  | 'finalizing'
  | 'cancelling';

export interface DbSlimmingMaintenanceProgress {
  phase: Exclude<DbSlimmingStartupPhase, 'cancelling'>;
  progress: number;
  cancellable: boolean;
}

/** Renderer-safe startup projection. It intentionally contains no database or backup path. */
export interface DbSlimmingStartupProgress
  extends Omit<DbSlimmingMaintenanceProgress, 'phase'> {
  requestId: string;
  phase: DbSlimmingStartupPhase;
  startedAt: number;
  updatedAt: number;
  estimatedTotalMs: number;
}

export interface DbSlimmingStartupCancelResult {
  cancelled: boolean;
}

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
      archiveAgeMonths: DbSlimmingArchiveAge;
      /** Missing on results written before active-task cleanup was introduced. */
      activeTaskCount?: number;
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
      archiveAgeMonths: DbSlimmingArchiveAge;
      reason: DbSlimmingFailureReason;
      originalDatabaseRestored: boolean;
    };
