import { runDbSlimmingMaintenance } from './dbSlimmingMaintenance';
import { connectDatabaseMaintenanceProcess, type DatabaseMaintenanceParentPort } from '@cindy/runtime-db/dbSlimmingMaintenanceProcess';
const port = (process as unknown as { parentPort?: DatabaseMaintenanceParentPort }).parentPort;
if (!port) throw new Error('database cleanup process requires an Electron parent port');
connectDatabaseMaintenanceProcess(port, runDbSlimmingMaintenance);
