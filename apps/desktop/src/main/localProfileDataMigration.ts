/**
 * Adopt the account-free local profile database for the first verified cloud
 * owner on this installation.
 *
 * The local and cloud sessions intentionally use different database filenames.
 * On the first local → cloud transition, copying the local database before the
 * cloud DbClient opens preserves the user's conversations and projects without
 * weakening the normal per-owner database boundary. Existing cloud data is
 * never overwritten; a later, explicit merge can handle that conflict.
 */

import fs from 'original-fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createBetterSqliteDatabase,
  restrictDbFilePermissions,
} from './localDb/betterSqliteFactory.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';

export const LOCAL_PROFILE_MIGRATION_TMP_SUFFIX = '.local-profile-migration-tmp';
export const LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX = '.local-profile-migration.json';
export const LOCAL_PROFILE_MIGRATION_LEASE_SUFFIX = '.local-profile-migration-lease';

const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export interface LocalProfileDataMigrationFs {
  pathExists(file: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  createFileExclusive(file: string, contents: string): Promise<boolean>;
  rename(source: string, target: string): Promise<void>;
  backupDatabase(source: string, target: string): Promise<void>;
  link(source: string, target: string): Promise<void>;
  removeIfExists(file: string): Promise<void>;
}

export interface LocalProfileDataMigrationDeps {
  userDataDir: string;
  dbFilePrefix: string;
  fs: LocalProfileDataMigrationFs;
}

export type LocalProfileDataMigrationResult =
  | { status: 'no-local-db' }
  | { status: 'target-exists' }
  | { status: 'claimed-by-other-owner' }
  | { status: 'adopted'; sourceDb: string; targetDb: string }
  | { status: 'failed'; error: string };

const realFs: LocalProfileDataMigrationFs = {
  pathExists: async (file) => {
    try {
      await fs.promises.access(file);
      return true;
    } catch {
      return false;
    }
  },
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  createFileExclusive: async (file, contents) => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      handle = await fs.promises.open(tmp, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.promises.link(tmp, file);
      try {
        syncMarkerDirectory(file);
      } catch (error) {
        await fs.promises.rm(file, { force: true }).catch(() => undefined);
        throw error;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    }
  },
  backupDatabase: async (source, target) => {
    const db = createBetterSqliteDatabase(source, { readonly: true, fileMustExist: true });
    try {
      await db.backup(target);
      restrictDbFilePermissions(target);
    } finally {
      db.close();
    }
  },
  rename: (source, target) => fs.promises.rename(source, target),
  link: (source, target) => fs.promises.link(source, target),
  removeIfExists: (file) => fs.promises.rm(file, { force: true }),
};

function dbPath(deps: LocalProfileDataMigrationDeps, ownerId: string): string {
  return path.join(deps.userDataDir, `${deps.dbFilePrefix}-${ownerId}.db`);
}

function migrationMarkerPath(deps: LocalProfileDataMigrationDeps): string {
  return path.join(
    deps.userDataDir,
    `${deps.dbFilePrefix}-${LOCAL_PROFILE_DATA_OWNER_ID}${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`,
  );
}

function migrationLeasePath(targetDb: string): string {
  return `${targetDb}${LOCAL_PROFILE_MIGRATION_LEASE_SUFFIX}`;
}

interface LocalProfileMigrationLease {
  ownerId: string;
  leaseId: string;
  pid: number;
  claimedAt: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== 'ESRCH';
  }
}

function parseMigrationLease(raw: string): LocalProfileMigrationLease | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LocalProfileMigrationLease>;
    if (
      typeof parsed.ownerId === 'string' &&
      typeof parsed.leaseId === 'string' &&
      Number.isInteger(parsed.pid) &&
      typeof parsed.claimedAt === 'number'
    ) {
      return parsed as LocalProfileMigrationLease;
    }
  } catch {
    // A torn record is recoverable because production lease publication is atomic.
  }
  return null;
}

async function removeMigrationLeaseIfMatches(
  deps: LocalProfileDataMigrationDeps,
  lease: string,
  expectedLeaseId: string | null,
): Promise<boolean> {
  const candidate = `${lease}.reclaim.${randomUUID()}`;
  try {
    // Rename claims the exact directory entry that was inspected. If another
    // process reclaimed or replaced it first, this fails without touching the
    // replacement lease.
    await deps.fs.rename(lease, candidate);
  } catch {
    return false;
  }

  const current = parseMigrationLease(await deps.fs.readFile(candidate).catch(() => ''));
  const matches =
    expectedLeaseId === null ? current === null : current?.leaseId === expectedLeaseId;
  if (matches) {
    await deps.fs.removeIfExists(candidate);
    return true;
  }

  // Put a lease we did not own back only when the destination is still vacant;
  // never replace a newer lease that won the race while we inspected this one.
  try {
    await deps.fs.link(candidate, lease);
    await deps.fs.removeIfExists(candidate);
  } catch {
    // A newer lease may already occupy the path; keep the candidate for the
    // next cleanup pass rather than deleting another process's lease.
  }
  return false;
}

async function acquireMigrationLease(
  deps: LocalProfileDataMigrationDeps,
  lease: string,
  ownerId: string,
): Promise<string | null> {
  const leaseId = randomUUID();
  const contents = `${JSON.stringify({
    ownerId,
    leaseId,
    pid: process.pid,
    claimedAt: Date.now(),
  } satisfies LocalProfileMigrationLease)}\n`;
  for (;;) {
    if (await deps.fs.createFileExclusive(lease, contents)) return leaseId;

    const current = parseMigrationLease(await deps.fs.readFile(lease).catch(() => ''));

    if (current && isProcessAlive(current.pid)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      continue;
    }
    if (await removeMigrationLeaseIfMatches(deps, lease, current?.leaseId ?? null)) {
      continue;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export type LocalProfileMigrationReservation =
  'claimed' | 'already-owned' | 'owned-by-other' | 'failed';

export interface LocalProfileMigrationReservationDetails {
  status: LocalProfileMigrationReservation;
  claimToken?: string;
}

interface LocalProfileMigrationMarker {
  ownerId: string;
  claimToken?: string;
}

function parseLocalProfileMigrationMarker(raw: string): LocalProfileMigrationMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LocalProfileMigrationMarker>;
    if (typeof parsed.ownerId !== 'string' || !parsed.ownerId.trim()) return null;
    if (
      parsed.claimToken !== undefined &&
      (typeof parsed.claimToken !== 'string' || !parsed.claimToken)
    ) {
      return null;
    }
    return {
      ownerId: parsed.ownerId.trim(),
      ...(parsed.claimToken ? { claimToken: parsed.claimToken } : {}),
    };
  } catch {
    return null;
  }
}

function syncMarkerDirectory(marker: string): void {
  if (process.platform === 'win32') return;
  const dirFd = fs.openSync(path.dirname(marker), 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

function publishLocalProfileMigrationMarker(
  marker: string,
  contents: string,
): 'claimed' | 'exists' {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  const tmp = `${marker}.${randomUUID()}.tmp`;
  let handle: number | undefined;
  try {
    handle = fs.openSync(tmp, 'wx', 0o600);
    const bytes = Buffer.from(contents, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(handle, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('short write while publishing local profile owner marker');
      offset += written;
    }
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    try {
      fs.linkSync(tmp, marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return 'exists';
      throw error;
    }
    syncMarkerDirectory(marker);
    return 'claimed';
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // Best-effort close before removing the private candidate.
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // A random private candidate cannot affect ownership decisions.
    }
  }
}

function restoreClaimedMarker(candidate: string, marker: string): boolean {
  try {
    fs.linkSync(candidate, marker);
    fs.unlinkSync(candidate);
    syncMarkerDirectory(marker);
    return true;
  } catch {
    // Never replace a newer marker. Keeping the claimed candidate is safer
    // than deleting ownership evidence that this attempt did not own.
    return false;
  }
}

function reclaimInvalidLocalProfileMarker(marker: string, inspectedRaw: string): boolean {
  const candidate = `${marker}.reclaim.${randomUUID()}`;
  try {
    fs.renameSync(marker, candidate);
  } catch {
    return false;
  }
  let movedRaw = '';
  try {
    movedRaw = fs.readFileSync(candidate, 'utf8');
  } catch {
    // An unreadable entry that we atomically claimed is safe to discard.
  }
  if (movedRaw !== inspectedRaw || parseLocalProfileMigrationMarker(movedRaw)) {
    restoreClaimedMarker(candidate, marker);
    return false;
  }
  try {
    fs.unlinkSync(candidate);
    syncMarkerDirectory(marker);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reserve local-v1 synchronously at the cloud-owner commit edge. This is a
 * machine-level marker, not user content, so the auth commit can persist the
 * ownership decision before any later renderer/database hook runs.
 */
export function reserveLocalProfileDataOwnerDetailed(
  ownerId: string,
  userDataDir: string,
  dbFilePrefix: string,
): LocalProfileMigrationReservationDetails {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || normalizedOwnerId === LOCAL_PROFILE_DATA_OWNER_ID) {
    return { status: 'failed' };
  }
  const marker = path.join(
    userDataDir,
    `${dbFilePrefix}-${LOCAL_PROFILE_DATA_OWNER_ID}${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`,
  );
  const claimToken = randomUUID();
  const contents = `${JSON.stringify({
    ownerId: normalizedOwnerId,
    claimToken,
    claimedAt: Date.now(),
  })}\n`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (publishLocalProfileMigrationMarker(marker, contents) === 'claimed') {
        return { status: 'claimed', claimToken };
      }
      const raw = fs.readFileSync(marker, 'utf8');
      const parsed = parseLocalProfileMigrationMarker(raw);
      if (parsed) {
        return parsed.ownerId === normalizedOwnerId
          ? { status: 'already-owned' }
          : { status: 'owned-by-other' };
      }
      if (reclaimInvalidLocalProfileMarker(marker, raw)) continue;
      return { status: 'failed' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') continue;
      return { status: 'failed' };
    }
  }
  return { status: 'failed' };
}

export function reserveLocalProfileDataOwner(
  ownerId: string,
  userDataDir: string,
  dbFilePrefix: string,
): LocalProfileMigrationReservation {
  return reserveLocalProfileDataOwnerDetailed(ownerId, userDataDir, dbFilePrefix).status;
}

export function releaseLocalProfileDataOwner(
  ownerId: string,
  userDataDir: string,
  dbFilePrefix: string,
  claimToken: string,
): boolean {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || !claimToken) return false;
  const marker = path.join(
    userDataDir,
    `${dbFilePrefix}-${LOCAL_PROFILE_DATA_OWNER_ID}${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`,
  );
  const candidate = `${marker}.release.${randomUUID()}`;
  try {
    fs.renameSync(marker, candidate);
    const parsed = parseLocalProfileMigrationMarker(fs.readFileSync(candidate, 'utf8'));
    if (!parsed || parsed.ownerId !== normalizedOwnerId || parsed.claimToken !== claimToken) {
      return false;
    }
    fs.unlinkSync(candidate);
    syncMarkerDirectory(marker);
    return true;
  } catch {
    return false;
  } finally {
    if (fs.existsSync(candidate)) restoreClaimedMarker(candidate, marker);
  }
}

async function readMigrationMarker(
  deps: LocalProfileDataMigrationDeps,
): Promise<LocalProfileMigrationMarker | null> {
  const marker = migrationMarkerPath(deps);
  if (!(await deps.fs.pathExists(marker))) return null;
  const parsed = parseLocalProfileMigrationMarker(await deps.fs.readFile(marker));
  if (!parsed) {
    throw new Error('local profile migration marker is invalid');
  }
  return parsed;
}

async function claimMigrationMarker(
  ownerId: string,
  deps: LocalProfileDataMigrationDeps,
): Promise<'claimed' | 'owned-by-other'> {
  const marker = migrationMarkerPath(deps);
  const contents = `${JSON.stringify({ ownerId, claimedAt: Date.now() })}\n`;
  if (await deps.fs.createFileExclusive(marker, contents)) return 'claimed';
  const existing = await readMigrationMarker(deps);
  return existing?.ownerId === ownerId ? 'claimed' : 'owned-by-other';
}

async function cleanupTemps(deps: LocalProfileDataMigrationDeps, targetDb: string): Promise<void> {
  await deps.fs.removeIfExists(`${targetDb}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`);
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    await deps.fs.removeIfExists(`${targetDb}${suffix}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`);
  }
}

async function copyDatabaseAtomically(
  deps: LocalProfileDataMigrationDeps,
  sourceDb: string,
  targetDb: string,
): Promise<boolean> {
  await cleanupTemps(deps, targetDb);
  const attemptId = randomUUID();
  const dbTmp = `${targetDb}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}.${attemptId}`;
  try {
    // SQLite's online backup API takes one coherent snapshot even while another
    // process is writing the WAL. The resulting standalone database therefore
    // needs no source -wal/-shm files and can be published as one atomic entry.
    await deps.fs.backupDatabase(sourceDb, dbTmp);
    await deps.fs.link(dbTmp, targetDb);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await deps.fs.removeIfExists(dbTmp);
  }
}

/**
 * Snapshot local-v1's database into the verified cloud owner's database.
 * This function is deliberately pure with respect to application state: the
 * caller must invoke it after owner verification and before opening the target
 * DbClient. It never deletes or overwrites the local source.
 */
export async function adoptLocalProfileDatabase(
  ownerId: string,
  deps: LocalProfileDataMigrationDeps,
): Promise<LocalProfileDataMigrationResult> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || normalizedOwnerId === LOCAL_PROFILE_DATA_OWNER_ID) {
    return { status: 'no-local-db' };
  }

  const sourceDb = dbPath(deps, LOCAL_PROFILE_DATA_OWNER_ID);
  const targetDb = dbPath(deps, normalizedOwnerId);
  const lease = migrationLeasePath(targetDb);
  let leaseId: string | null = null;
  try {
    const markerClaim = await claimMigrationMarker(normalizedOwnerId, deps);
    if (markerClaim === 'owned-by-other') return { status: 'claimed-by-other-owner' };
    // Reserve the local namespace even when it is currently empty. Otherwise a
    // later account could create or adopt local content after the first account
    // has already crossed the login boundary.
    if (!(await deps.fs.pathExists(sourceDb))) return { status: 'no-local-db' };
    // Serialize the complete database-file-group adoption across processes. The
    // owner marker deliberately allows same-owner readers, so it cannot itself
    // protect the snapshot; this lease keeps one process from cleaning or
    // publishing another process's temporary database.
    leaseId = await acquireMigrationLease(deps, lease, normalizedOwnerId);
    if (!leaseId) return { status: 'target-exists' };
    if (await deps.fs.pathExists(targetDb)) {
      await cleanupTemps(deps, targetDb);
      return { status: 'target-exists' };
    }
    const adopted = await copyDatabaseAtomically(deps, sourceDb, targetDb);
    return adopted ? { status: 'adopted', sourceDb, targetDb } : { status: 'target-exists' };
  } catch (error) {
    await cleanupTemps(deps, targetDb).catch(() => undefined);
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (leaseId) await removeMigrationLeaseIfMatches(deps, lease, leaseId).catch(() => false);
  }
}

export function createProductionLocalProfileDataMigrationDeps(
  userDataDir: string,
  dbFilePrefix: string,
): LocalProfileDataMigrationDeps {
  return { userDataDir, dbFilePrefix, fs: realFs };
}
