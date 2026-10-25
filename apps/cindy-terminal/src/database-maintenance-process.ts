import { createSqliteFactory } from '@cindy/runtime-db/betterSqliteFactory';
import { createDatabaseMaintenance } from '@cindy/runtime-db/dbSlimmingMaintenance';
import { connectDatabaseMaintenanceProcess } from '@cindy/runtime-db/dbSlimmingMaintenanceProcess';
import type { DbLogger } from '@cindy/runtime-db/logging';

if (!process.send) throw new Error('DATABASE_MAINTENANCE_REQUIRES_PARENT');
const report = (level: 'debug' | 'info' | 'warn' | 'error', message: string, ...fields: unknown[]) => {
  process.send?.({ type: 'log', level, message, meta: fields[0] });
};
const logger: DbLogger = {
  debug: (...args) => report('debug', ...args),
  info: (...args) => report('info', ...args),
  warn: (...args) => report('warn', ...args),
  error: (...args) => report('error', ...args),
};
const sqlite = createSqliteFactory({ logger, maskPath: () => '<private>' });
const maintenance = createDatabaseMaintenance(sqlite);
connectDatabaseMaintenanceProcess({
  postMessage: message => { process.send?.(message); },
  on: (_event, listener) => { process.on('message', data => listener({ data })); },
}, maintenance.runDbSlimmingMaintenance);
