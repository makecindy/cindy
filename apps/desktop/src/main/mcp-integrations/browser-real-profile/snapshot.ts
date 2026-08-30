import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import {
  MANAGED_CDP_PORT,
  MANAGED_PROFILE,
  REAL_MANAGED_PROFILE,
} from '../browser-managed-config.js';
import { REAL_PROFILE_READ_DENIED } from '../../../shared/browserBackend.js';
import { resolveSourceBrowserFromOs } from './source.js';
import {
  isRealProfileError,
  RealProfileError,
  type InstalledChromium,
  type SnapshotResult,
} from './types.js';

const COMPLETE_MARKER = '.cindy-real-profile-complete';

/** SQLite auth databases that must be copied consistently (online-backup). */
const AUTH_DB_RELATIVE_PATHS = [
  'Cookies',
  path.join('Network', 'Cookies'),
  'Login Data',
  'Login Data For Account',
  'Web Data',
] as const;

const PLAIN_PROFILE_FILES = ['Preferences'] as const;

const SNAPSHOT_PROFILE_RELATIVE_PATHS = [
  ...AUTH_DB_RELATIVE_PATHS,
  ...PLAIN_PROFILE_FILES,
] as const;

const COOKIE_DB_CANDIDATES = ['Cookies', path.join('Network', 'Cookies')] as const;

/** Profile wrapper under the runtime (`browser/Cindy-real`). Cleanup deletes this whole tree. */
export function realProfileProfileDir(runtimeDir: string): string {
  return path.join(runtimeDir, 'browser', REAL_MANAGED_PROFILE);
}

/**
 * Chrome `--user-data-dir` for the consented snapshot. The vendored runtime
 * launches `CONFIG_DIR/browser/<profile>/user-data`, so cookies must land here
 * — not in the profile wrapper itself.
 */
export function realProfileDestDir(runtimeDir: string): string {
  return path.join(realProfileProfileDir(runtimeDir), 'user-data');
}

export function isolatedProfileDestDir(runtimeDir: string): string {
  return path.join(runtimeDir, 'browser', 'Cindy');
}

export function lastUsedProfileName(localStateRaw: string): string {
  try {
    const parsed = JSON.parse(localStateRaw) as { profile?: { last_used?: unknown } };
    const lastUsed = parsed.profile?.last_used;
    if (typeof lastUsed === 'string' && lastUsed.trim()) return lastUsed.trim();
  } catch {
    // Fall through to Default when Local State is missing or malformed.
  }
  return 'Default';
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Copies last_used cookies into dest `Default`. Chrome still honors
 * Local State `profile.last_used`, so a verbatim copy would open the original
 * folder (often an empty `Profile 2`) and look signed-out. Point every
 * selection field at Default and keep only that info_cache entry, taking
 * metadata from the source last_used profile when present. Stamp the chip
 * name to `Cindy` so a copied "Dash" / "Person 1" label never leaks; launch
 * decoration uses the same display name.
 */
export function rewriteLocalStateForManagedDefault(
  localStateRaw: string,
  sourceProfile: string,
): string {
  let parsed =
    asObject(
      (() => {
        try {
          return JSON.parse(localStateRaw) as unknown;
        } catch {
          return {};
        }
      })(),
    ) ?? {};
  const profile = { ...(asObject(parsed.profile) ?? {}) };
  const infoCache = asObject(profile.info_cache) ?? {};
  const sourceInfo = {
    ...(asObject(infoCache[sourceProfile]) ?? asObject(infoCache.Default) ?? {}),
  };
  sourceInfo.name = MANAGED_PROFILE;
  sourceInfo.shortcut_name = MANAGED_PROFILE;
  sourceInfo.user_name = MANAGED_PROFILE;
  profile.last_used = 'Default';
  profile.last_active_profiles = ['Default'];
  profile.profiles_order = ['Default'];
  profile.profiles_created = 1;
  profile.show_picker_on_startup = false;
  profile.info_cache = { Default: sourceInfo };
  parsed = { ...parsed, profile };
  return `${JSON.stringify(parsed)}\n`;
}

/** Chrome user-profile folders that are not dest `Default` leftover from a previous launch. */
const EXTRA_CHROME_PROFILE_DIR = /^(Profile \d+|Guest Profile)$/;

export function pruneExtraChromeProfiles(userDataDir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(userDataDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!EXTRA_CHROME_PROFILE_DIR.test(entry.name)) continue;
    fs.rmSync(path.join(userDataDir, entry.name), { recursive: true, force: true });
  }
}

/** HTTP / GPU caches that cannot replay a login. Dest Default is otherwise rebuilt. */
const DISCARDABLE_PROFILE_CACHE_NAMES = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
]);

/**
 * Drop leftover Local Storage / IndexedDB / Service Worker / etc. from a
 * previous source profile. Keep only this snapshot's auth files and caches.
 */
export function pruneNonAuthProfileState(destProfileDir: string): void {
  const keep = new Set<string>(DISCARDABLE_PROFILE_CACHE_NAMES);
  for (const relative of SNAPSHOT_PROFILE_RELATIVE_PATHS) {
    keep.add(relative.split(/[/\\]/)[0] ?? relative);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(destProfileDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    fs.rmSync(path.join(destProfileDir, entry.name), { recursive: true, force: true });
  }
}

export function profileIsLocked(options: {
  profileDir: string;
  platform: NodeJS.Platform;
}): boolean {
  if (options.platform !== 'win32') return false;
  for (const relative of COOKIE_DB_CANDIDATES) {
    const cookieDb = path.join(options.profileDir, relative);
    if (!fs.existsSync(cookieDb)) continue;
    try {
      const fd = fs.openSync(cookieDb, 'r+');
      fs.closeSync(fd);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return true;
    }
  }
  return false;
}

function isPermissionDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

function tryOpenRead(filePath: string): 'ok' | 'missing' | 'denied' {
  try {
    const fd = fs.openSync(filePath, 'r');
    fs.closeSync(fd);
    return 'ok';
  } catch (err) {
    if (isPermissionDenied(err)) return 'denied';
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'ok';
  }
}

function tryOpenDir(dirPath: string): 'ok' | 'missing' | 'denied' {
  try {
    const dir = fs.opendirSync(dirPath);
    dir.closeSync();
    return 'ok';
  } catch (err) {
    if (isPermissionDenied(err)) return 'denied';
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    return 'ok';
  }
}

/**
 * Open-only probe of the source Chromium profile. Does not copy cookies.
 * `readable: true` means Full Disk Access is already granted or not the blocker
 * (missing Chrome / missing files). Tests must pass a fake `source`.
 */
export function probeSourceProfileReadAccess(source: InstalledChromium): { readable: boolean } {
  const userData = tryOpenDir(source.userDataDir);
  if (userData === 'denied') return { readable: false };
  if (userData === 'missing') return { readable: true };

  const localStatePath = path.join(source.userDataDir, 'Local State');
  const localState = tryOpenRead(localStatePath);
  if (localState === 'denied') return { readable: false };

  let sourceProfile = 'Default';
  if (localState === 'ok') {
    try {
      sourceProfile = lastUsedProfileName(fs.readFileSync(localStatePath, 'utf8'));
    } catch (err) {
      if (isPermissionDenied(err)) return { readable: false };
    }
  }

  const sourceProfileDir = path.join(source.userDataDir, sourceProfile);
  const profileDir = tryOpenDir(sourceProfileDir);
  if (profileDir === 'denied') return { readable: false };

  for (const relative of AUTH_DB_RELATIVE_PATHS) {
    const result = tryOpenRead(path.join(sourceProfileDir, relative));
    if (result === 'denied') return { readable: false };
  }
  return { readable: true };
}

/** Production entry: resolve the OS source browser, then probe. Never returns paths. */
export function probeOsSourceProfileReadAccess(options?: {
  resolveSource?: () => InstalledChromium;
}): { readable: boolean } {
  try {
    const source = (options?.resolveSource ?? resolveSourceBrowserFromOs)();
    return probeSourceProfileReadAccess(source);
  } catch (err) {
    if (isRealProfileError(err) && err.code === 'NO_CHROMIUM') return { readable: true };
    if (isPermissionDenied(err)) return { readable: false };
    return { readable: true };
  }
}

function throwReadDenied(): never {
  throw new RealProfileError('COPY_FAILED', REAL_PROFILE_READ_DENIED);
}

function secureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows cannot always chmod; the snapshot still lives under userData.
  }
}

const SQLITE_SIDECARS = ['-wal', '-shm', '-journal'] as const;

function removeSqliteAndSidecars(filePath: string): void {
  fs.rmSync(filePath, { force: true });
  for (const suffix of SQLITE_SIDECARS) {
    fs.rmSync(filePath + suffix, { force: true });
  }
}

function publishStagedFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  removeSqliteAndSidecars(dest);
  fs.renameSync(src, dest);
  for (const suffix of SQLITE_SIDECARS) {
    const side = src + suffix;
    if (fs.existsSync(side)) {
      fs.renameSync(side, dest + suffix);
    }
  }
}

/**
 * Swap this snapshot's auth files onto dest only after the staging tree is
 * complete. Dest HTTP/GPU caches stay; leftover Cookies vs Network/Cookies,
 * Login Data, and site credential stores from a previous source do not.
 */
function publishStagedSnapshot(options: {
  stagingDir: string;
  destDir: string;
  copiedRelative: ReadonlySet<string>;
}): void {
  const { stagingDir, destDir, copiedRelative } = options;
  secureDir(path.dirname(destDir));
  secureDir(destDir);
  const destProfileDir = path.join(destDir, 'Default');
  secureDir(destProfileDir);
  secureDir(path.join(destProfileDir, 'Network'));

  publishStagedFile(path.join(stagingDir, 'Local State'), path.join(destDir, 'Local State'));

  for (const relative of SNAPSHOT_PROFILE_RELATIVE_PATHS) {
    const destFile = path.join(destProfileDir, relative);
    const stagingFile = path.join(stagingDir, 'Default', relative);
    if (copiedRelative.has(relative)) {
      publishStagedFile(stagingFile, destFile);
    } else {
      removeSqliteAndSidecars(destFile);
    }
  }

  pruneNonAuthProfileState(destProfileDir);
  pruneExtraChromeProfiles(destDir);
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

async function copySqliteDatabase(src: string, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  removeSqliteAndSidecars(dest);
  if (typeof backup !== 'function') {
    throw new Error('sqlite backup API unavailable');
  }
  const source = new DatabaseSync(src, { readOnly: true, timeout: 5000 });
  try {
    // Node 24 / Electron 41: backup is module-level `backup(sourceDb, dest)`.
    // DatabaseSync#backup does not exist; copyFile + WAL sidecars is not a
    // consistent snapshot while the source Chrome is open.
    await backup(source, dest);
  } finally {
    source.close();
  }
}

async function copyAuthFile(src: string, dest: string, isSqlite: boolean): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (isSqlite) {
    await copySqliteDatabase(src, dest);
    return;
  }
  await fs.promises.copyFile(src, dest);
}

export async function snapshotRealProfile(options: {
  source: InstalledChromium;
  destDir: string;
  platform?: NodeJS.Platform;
}): Promise<SnapshotResult> {
  const platform = options.platform ?? process.platform;
  const destDir = options.destDir;
  if (
    path.basename(destDir) !== 'user-data' ||
    path.basename(path.dirname(destDir)) !== REAL_MANAGED_PROFILE
  ) {
    throw new RealProfileError(
      'COPY_FAILED',
      `Refusing to snapshot into ${path.basename(path.dirname(destDir))}/${path.basename(destDir)}; expected ${REAL_MANAGED_PROFILE}/user-data.`,
    );
  }

  const localStatePath = path.join(options.source.userDataDir, 'Local State');
  let localStateRaw = '{}';
  try {
    if (fs.existsSync(localStatePath)) {
      localStateRaw = fs.readFileSync(localStatePath, 'utf8');
    }
  } catch (err) {
    if (isPermissionDenied(err)) throwReadDenied();
    throw err;
  }
  const sourceProfile = lastUsedProfileName(localStateRaw);
  const sourceProfileDir = path.join(options.source.userDataDir, sourceProfile);

  if (!fs.existsSync(sourceProfileDir)) {
    throw new RealProfileError(
      'NO_AUTH_DB',
      `Chrome profile folder "${sourceProfile}" was not found.`,
    );
  }

  if (profileIsLocked({ profileDir: sourceProfileDir, platform })) {
    throw new RealProfileError(
      'PROFILE_LOCKED',
      'Chrome is locking its cookie database. Quit Chrome completely (including the tray icon) and try again.',
    );
  }

  secureDir(path.dirname(destDir));
  let stagingDir = '';

  try {
    stagingDir = fs.mkdtempSync(`${destDir}.staging-`);
    secureDir(stagingDir);
    const stagingProfileDir = path.join(stagingDir, 'Default');
    secureDir(stagingProfileDir);
    secureDir(path.join(stagingProfileDir, 'Network'));

    const filesCopied: string[] = [];
    const copiedRelative = new Set<string>();
    let authDbCopied = 0;

    await fs.promises.writeFile(
      path.join(stagingDir, 'Local State'),
      rewriteLocalStateForManagedDefault(localStateRaw, sourceProfile),
      'utf8',
    );
    filesCopied.push('Local State');

    for (const relative of AUTH_DB_RELATIVE_PATHS) {
      const src = path.join(sourceProfileDir, relative);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(stagingProfileDir, relative);
      try {
        await copyAuthFile(src, dest, true);
        filesCopied.push(path.join('Default', relative));
        copiedRelative.add(relative);
        authDbCopied += 1;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (isPermissionDenied(err) && platform !== 'win32') throwReadDenied();
        if (platform === 'win32' && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
          throw new RealProfileError(
            'PROFILE_LOCKED',
            'Chrome is locking its cookie database. Quit Chrome completely and try again.',
          );
        }
        throw new RealProfileError(
          'COPY_FAILED',
          `Failed to copy ${relative} from the system browser profile.`,
        );
      }
    }

    const copiedCookie =
      copiedRelative.has('Cookies') || copiedRelative.has(path.join('Network', 'Cookies'));
    if (!copiedCookie || authDbCopied === 0) {
      throw new RealProfileError(
        'NO_AUTH_DB',
        'Could not copy cookie or login databases from the system browser profile.',
      );
    }

    for (const relative of PLAIN_PROFILE_FILES) {
      const src = path.join(sourceProfileDir, relative);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(stagingProfileDir, relative);
      await fs.promises.copyFile(src, dest);
      filesCopied.push(path.join('Default', relative));
      copiedRelative.add(relative);
    }

    publishStagedSnapshot({ stagingDir, destDir, copiedRelative });

    await fs.promises.writeFile(
      path.join(destDir, COMPLETE_MARKER),
      JSON.stringify({ sourceProfile, sourceKind: options.source.kind }),
      'utf8',
    );

    return {
      destDir,
      sourceKind: options.source.kind,
      sourceProfile,
      filesCopied,
    };
  } catch (err) {
    if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

function completeMarkerPath(destDir: string): string {
  return path.join(destDir, COMPLETE_MARKER);
}

function isManagedCdpPort(port: unknown): port is number {
  return (
    typeof port === 'number' &&
    Number.isInteger(port) &&
    port >= MANAGED_CDP_PORT &&
    port < MANAGED_CDP_PORT + 20
  );
}

/** CDP port last used for Cindy-real, stored on the existing complete marker. */
export function readCopiedLoginsCdpPort(runtimeDir: string): number | null {
  if (!runtimeDir) return null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(completeMarkerPath(realProfileDestDir(runtimeDir)), 'utf8'),
    ) as {
      cdpPort?: unknown;
    };
    return isManagedCdpPort(parsed.cdpPort) ? parsed.cdpPort : null;
  } catch {
    return null;
  }
}

export function rememberCopiedLoginsCdpPort(runtimeDir: string, port: number): void {
  if (!runtimeDir || !isManagedCdpPort(port)) return;
  const file = completeMarkerPath(realProfileDestDir(runtimeDir));
  if (!fs.existsSync(file)) return;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  fs.writeFileSync(file, JSON.stringify({ ...parsed, cdpPort: port }), 'utf8');
}

export function cleanupRealProfileSnapshots(runtimeDir: string): void {
  const profileDir = realProfileProfileDir(runtimeDir);
  if (path.basename(profileDir) !== REAL_MANAGED_PROFILE) return;
  if (!fs.existsSync(profileDir)) return;
  fs.rmSync(profileDir, { recursive: true, force: true });
}

/**
 * Delete the Cindy-real copy, then run `then`. If delete throws, `then` does
 * not run — Settings must keep consent on so the user can retry.
 */
export function cleanupCopiedLoginsThen(runtimeDir: string | null, then: () => void): void {
  if (runtimeDir) cleanupRealProfileSnapshots(runtimeDir);
  then();
}
