import path from 'node:path';
import os from 'node:os';

/** Global is the unqualified build identity; only the CN build uses the bare product name. */
const USER_DATA_DIR_BY_REGION = Object.freeze({
  cn: 'Cindy',
  global: 'CindyGlobal',
});

const DB_FILE_PREFIX = 'cindy';

export function resolveHostRegion(raw = process.env.CINDY_HOST_REGION) {
  if (raw === undefined || raw === null || raw === '') return 'global';
  if (raw === 'cn' || raw === 'global') return raw;
  throw new Error(`CINDY_HOST_REGION must be "cn" or "global"; received ${JSON.stringify(raw)}`);
}

/**
 * Resolve the existing Desktop profile path without creating a second data root.
 * An explicit CINDY_HOST_DATA_DIR or XDT_USER_DATA_DIR keeps the current
 * userData semantics; otherwise the regional appData name is used.
 */
export function resolveHostDataDir(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env.CINDY_HOST_DATA_DIR?.trim() || env.XDT_USER_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const appData = options.appDataDir
    ?? env.APPDATA
    ?? (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Roaming')
        : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')));
  return path.join(appData, USER_DATA_DIR_BY_REGION[resolveHostRegion(env.CINDY_HOST_REGION)]);
}

/** Same per-owner database file naming Desktop uses. */
export function ownerDatabasePath(userDataDir, ownerId) {
  if (typeof ownerId !== 'string' || ownerId.length === 0) throw new Error('owner id is required');
  if (ownerId === '.' || ownerId === '..' || /[\\/]/.test(ownerId)) {
    throw new Error('owner id must be a single safe path segment');
  }
  return path.join(userDataDir, `${DB_FILE_PREFIX}-${ownerId}.db`);
}
