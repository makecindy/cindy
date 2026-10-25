import path from 'node:path';
import { app } from 'electron';
import { createLogger } from '../logger';
import * as backup from './backup';
import { createDatabaseMigrations } from '@cindy/runtime-db/migrate';
export { hashMigrationFile } from '@cindy/runtime-db/migrate';
export const { getDrizzleDir, runMigrations, prepareBackupDiskSpace, pruneMigrationBackupsToBudget } = createDatabaseMigrations({ logger: createLogger('migrate'), backup, isPackaged: () => app.isPackaged, drizzleDirectory: () => app.isPackaged ? path.join(process.resourcesPath, 'drizzle') : path.resolve(__dirname, '../../drizzle') });
