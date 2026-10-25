import { createLogger, maskPath } from '../logger';
import { createSqliteFactory } from '@cindy/runtime-db/betterSqliteFactory';
export const { BETTER_SQLITE_NATIVE_BINDING_ENV, getElectronNativeBindingPath, resolveBetterSqliteNativeBinding, resolveBetterSqliteModuleEntry, createBetterSqliteDatabase, restrictDbFilePermissions } = createSqliteFactory({ logger: createLogger('localDb/betterSqliteFactory'), maskPath: value => maskPath(value) });
