import { createBetterSqliteDatabase, restrictDbFilePermissions } from './betterSqliteFactory';
import { createDatabaseMaintenance } from '@cindy/runtime-db/dbSlimmingMaintenance';
export type { DbSlimmingMaintenanceLog, RunDbSlimmingMaintenanceOptions, RunDbSlimmingMaintenanceOutcome } from '@cindy/runtime-db/dbSlimmingMaintenance';
export const { dbSlimmingTemporaryBytesRequired, dbVolumeFreeBytes, estimateDbFilesBytes, runDbSlimmingMaintenance, discardCancelledDbSlimmingMaintenance } = createDatabaseMaintenance({ createBetterSqliteDatabase, restrictDbFilePermissions });
