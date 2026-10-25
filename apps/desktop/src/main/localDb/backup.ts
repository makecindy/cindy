import { createBetterSqliteDatabase, restrictDbFilePermissions } from './betterSqliteFactory';
import { createLogger } from '../logger';
import { createDatabaseBackup } from '@cindy/runtime-db/backup';
export type { RestoreResult } from '@cindy/runtime-db/backup';
export const { backupDb, cleanupFailedBackupArtifacts, listIsoBackups, restrictLegacyBackupPermissions, listNukeBackups, isoBackupTotalBudgetBytes, estimateDbSizeBytes, getFreeDiskBytes, pruneIsoBackupsToBudget, getCleanBackupPath, tryRestoreWithFallback } = createDatabaseBackup({ createBetterSqliteDatabase, restrictDbFilePermissions, logger: createLogger('backup') });
