import os from 'node:os';
import path from 'node:path';
import { utilityProcess } from 'electron';
import { BETTER_SQLITE_NATIVE_BINDING_ENV, resolveBetterSqliteModuleEntry, resolveBetterSqliteNativeBinding } from './betterSqliteFactory';
import { resolveSqliteVecExtPath } from './sqliteVecLoader';
import { createDatabaseMaintenanceWorker, type DbSlimmingUtilityProcessLike } from '@cindy/runtime-db/dbSlimmingWorkerClient';
export { DB_SLIMMING_WORKER_READY_TIMEOUT_MS, DB_SLIMMING_WORKER_TERMINATION_TIMEOUT_MS, DbSlimmingWorkerStartupError, DbSlimmingCancelledError, DbSlimmingWorkerPreReplacementError, DbSlimmingWorkerTerminationUnconfirmedError, deferReleaseUntilDbSlimmingWorkerTermination, dbSlimmingWorkerInactivityTimeoutMs } from '@cindy/runtime-db/dbSlimmingWorkerClient';
const BETTER_SQLITE_MODULE_ENV = 'CINDY_DB_SLIMMING_BETTER_SQLITE_MODULE';
function forkDbSlimmingUtilityProcess(): DbSlimmingUtilityProcessLike {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const moduleEntry = resolveBetterSqliteModuleEntry();
  if (moduleEntry) env[BETTER_SQLITE_MODULE_ENV] = moduleEntry;
  const nativeBinding = resolveBetterSqliteNativeBinding();
  if (nativeBinding) env[BETTER_SQLITE_NATIVE_BINDING_ENV] = nativeBinding;
  return utilityProcess.fork(path.join(__dirname, 'dbSlimmingMaintenanceProcess.js'), [], {
    cwd: os.tmpdir(),
    env,
    serviceName: 'cindy-database-cleanup',
    stdio: 'ignore',
  });
}

export const { runDbSlimmingMaintenanceInWorker } = createDatabaseMaintenanceWorker({ fork: forkDbSlimmingUtilityProcess, resolveSqliteVecExtPath });
