import fs from 'node:fs';
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

/**
 * Discover the owner when the caller did not name one.
 *
 * Desktop names each account database `cindy-<owner>.db`; a profile with exactly
 * one such file has an unambiguous owner. Several accounts are ambiguous, so the
 * host refuses to guess and stays uninitialized until one is supplied.
 */
export function discoverHostOwner(userDataDir) {
  let entries;
  try {
    entries = fs.readdirSync(userDataDir);
  } catch {
    return { ownerId: null, reason: 'profile directory is unreadable' };
  }
  const owners = new Set();
  for (const entry of entries) {
    const match = /^cindy-(.+)\.db$/.exec(entry);
    if (!match) continue;
    if (match[1].includes('.lock')) continue;
    owners.add(match[1]);
  }
  if (owners.size === 1) return { ownerId: [...owners][0], reason: null };
  if (owners.size === 0) return { ownerId: null, reason: 'no account database in this profile' };
  return { ownerId: null, reason: `profile has ${owners.size} accounts; name one with CINDY_HOST_OWNER` };
}

/** Same per-owner database file naming Desktop uses. */
export function ownerDatabasePath(userDataDir, ownerId) {
  if (typeof ownerId !== 'string' || ownerId.length === 0) throw new Error('owner id is required');
  if (ownerId === '.' || ownerId === '..' || /[\\/]/.test(ownerId)) {
    throw new Error('owner id must be a single safe path segment');
  }
  return path.join(userDataDir, `${DB_FILE_PREFIX}-${ownerId}.db`);
}
