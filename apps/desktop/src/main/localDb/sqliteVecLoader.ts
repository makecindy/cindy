import path from 'node:path';
import { app } from 'electron';
import { createLogger } from '../logger';
import { createSqliteVecLoader } from '@cindy/runtime-db/sqliteVecLoader';
export type { SqliteVecLoadResult } from '@cindy/runtime-db/sqliteVecLoader';
export const { resolveSqliteVecExtPath, loadSqliteVec, getSqliteVecState, isSqliteVecAvailable, getSqliteVecVersion, resetSqliteVecState } = createSqliteVecLoader(() => {
 const filename = process.platform === 'win32' ? 'vec0.dll' : process.platform === 'linux' ? 'vec0.so' : 'vec0.dylib';
 const relPath = path.join('native', 'sqlite-vec', `${process.platform}-${process.arch}`, filename);
 return app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', relPath) : path.resolve(__dirname, '..', '..', relPath);
}, createLogger('localDb/sqliteVec'));
