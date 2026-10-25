import { discardCancelledDbSlimmingMaintenance } from './dbSlimmingMaintenance';
import { runDbSlimmingMaintenanceInWorker } from './dbSlimmingWorkerClient';
import { createDatabaseStartupMaintenance } from '@cindy/runtime-db/dbSlimmingStartup';
export type { RunPendingDbSlimmingAtStartupOptions, PendingDbSlimmingStartupOutcome } from '@cindy/runtime-db/dbSlimmingStartup';
export const { runPendingDbSlimmingAtStartup } = createDatabaseStartupMaintenance({ discardCancelledDbSlimmingMaintenance, runDbSlimmingMaintenanceInWorker });
