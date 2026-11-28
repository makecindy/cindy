import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hostReleaseRegion } from './runtime-layout.mjs';

const DB_FILE_PREFIX = 'cindy';

/**
 * The Host's edition. A release is built for one (scripts/build.mjs --region) and answers that; a
 * CINDY_HOST_REGION naming the other edition refuses to start rather than being ignored. From source
 * CINDY_HOST_REGION chooses, global when unset, for development only. The account's realm is separate:
 * it only picks the sign-in and service endpoints.
 */
export function resolveHostRegion(raw = process.env.CINDY_HOST_REGION, release = hostReleaseRegion()) {
  const requested = raw === undefined || raw === null || raw === '' ? null : raw;
  if (requested !== null && requested !== 'cn' && requested !== 'global') {
    throw new Error(`CINDY_HOST_REGION must be "cn" or "global"; received ${JSON.stringify(raw)}`);
  }
  if (release === null) return requested ?? 'global';
  if (requested !== null && requested !== release) {
    throw new Error(`HOST_REGION_MISMATCH: this Cindy Host release is the ${release} edition, but CINDY_HOST_REGION is ${requested}. `
      + `Install the ${requested} release, or remove CINDY_HOST_REGION (a release does not need it).`);
  }
  return release;
}

/** Source and installed Hosts default to an independent profile. Existing
 * isolated previews keep their explicit CINDY_HOST_DATA_DIR / XDT_USER_DATA_DIR.
 * Reading Desktop data is always an explicit operator decision. */
export function resolveHostDataDir(options = {}) {
  const env = options.env ?? process.env;
  const explicit = env.CINDY_HOST_DATA_DIR?.trim() || env.XDT_USER_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const appData = resolveHostAppDataDir(options);
  return path.join(appData, 'CindyHost', resolveHostRegion(env.CINDY_HOST_REGION));
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

/**
 * The OS app-data root the Host shares with the desktop: the Skill mutation locks and the built-in
 * Skill bundle live under `<appData>/Cindy`, so both sides must resolve the same directory or their
 * cross-process exclusion silently splits. Electron's app.getPath('appData') does not follow $HOME on
 * macOS (measured 2026-11-17, release table row 25) while os.homedir() does, so a desktop that launches
 * the Host passes its own value in CINDY_HOST_APP_DATA_DIR and the Host uses it as given; only a Host
 * installed on its own computes it. A value that is not absolute is refused rather than guessed.
 */
export function resolveHostAppDataDir(options = {}) {
  const env = options.env ?? process.env;
  const passed = env.CINDY_HOST_APP_DATA_DIR;
  if (passed !== undefined && passed !== '') {
    if (!path.isAbsolute(passed)) throw new Error('CINDY_HOST_APP_DATA_DIR must be an absolute directory');
    if (!options.appDataDir) return passed;
  }
  return options.appDataDir
    ?? env.APPDATA
    ?? (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Roaming')
        : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')));
}
