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

import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';

export const LOCAL_PROFILE_MIGRATION_TMP_SUFFIX = '.local-profile-migration-tmp';
export const LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX = '.local-profile-migration.json';
export const LOCAL_PROFILE_MIGRATION_LEASE_SUFFIX = '.local-profile-migration-lease';

const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export interface LocalProfileDataMigrationFs {
  pathExists(file: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  createFileExclusive(file: string, contents: string): Promise<boolean>;
  copyFile(source: string, target: string): Promise<void>;
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
    let handle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      handle = await fs.promises.open(file, 'wx', 0o600);
      await handle.writeFile(contents, 'utf8');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
      await fs.promises.rm(file, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  copyFile: (source, target) => fs.promises.copyFile(source, target),
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

export type LocalProfileMigrationReservation =
  'claimed' | 'already-owned' | 'owned-by-other' | 'failed';

/**
 * Reserve local-v1 synchronously at the cloud-owner commit edge. This is a
 * machine-level marker, not user content, so the auth commit can persist the
 * ownership decision before any later renderer/database hook runs.
 */
export function reserveLocalProfileDataOwner(
  ownerId: string,
  userDataDir: string,
  dbFilePrefix: string,
): LocalProfileMigrationReservation {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || normalizedOwnerId === LOCAL_PROFILE_DATA_OWNER_ID) return 'failed';
  const marker = path.join(
    userDataDir,
    `${dbFilePrefix}-${LOCAL_PROFILE_DATA_OWNER_ID}${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`,
  );
  const contents = `${JSON.stringify({ ownerId: normalizedOwnerId, claimedAt: Date.now() })}\n`;
  let handle: number | undefined;
  let created = false;
  try {
    handle = fs.openSync(marker, 'wx', 0o600);
    created = true;
    fs.writeSync(handle, contents, undefined, 'utf8');
    return 'claimed';
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') {
      if (created) {
        try {
          fs.unlinkSync(marker);
        } catch {
          // Best-effort cleanup; the caller will fail closed on the next attempt.
        }
      }
      return 'failed';
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { ownerId?: unknown };
      return parsed.ownerId === normalizedOwnerId ? 'already-owned' : 'owned-by-other';
    } catch {
      return 'failed';
    }
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        // The marker contents are already written; close failure is non-fatal.
      }
    }
  }
}

interface LocalProfileMigrationMarker {
  ownerId: string;
}

async function readMigrationMarker(
  deps: LocalProfileDataMigrationDeps,
): Promise<LocalProfileMigrationMarker | null> {
  const marker = migrationMarkerPath(deps);
  if (!(await deps.fs.pathExists(marker))) return null;
  const parsed = JSON.parse(await deps.fs.readFile(marker)) as unknown;
  const ownerId =
    parsed && typeof parsed === 'object' ? (parsed as { ownerId?: unknown }).ownerId : null;
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw new Error('local profile migration marker is invalid');
  }
  return { ownerId: ownerId.trim() };
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
  const tempFiles = [dbTmp];
  const sidecars: Array<{ tmp: string; final: string }> = [];
  try {
    await deps.fs.copyFile(sourceDb, dbTmp);
    for (const suffix of DB_SIDECAR_SUFFIXES) {
      const source = `${sourceDb}${suffix}`;
      if (!(await deps.fs.pathExists(source))) continue;
      const final = `${targetDb}${suffix}`;
      const tmp = `${final}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}.${attemptId}`;
      await deps.fs.copyFile(source, tmp);
      tempFiles.push(tmp);
      sidecars.push({ tmp, final });
    }

    // Establish ownership of the main database before publishing any WAL
    // sidecar. A process that loses this no-replace commit must leave no
    // sidecars behind for the winner's database file group.
    await deps.fs.link(dbTmp, targetDb);
    // Commit sidecars only after the main database link has won. A sidecar that
    // already exists belongs to the process that won the main-file race; never
    // replace it.
    for (const sidecar of sidecars) {
      try {
        await deps.fs.link(sidecar.tmp, sidecar.final);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
      }
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await Promise.all(tempFiles.map((file) => deps.fs.removeIfExists(file)));
  }
}

/**
 * Copy local-v1's closed database into the verified cloud owner's database.
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
  let leaseHeld = false;
  try {
    const markerClaim = await claimMigrationMarker(normalizedOwnerId, deps);
    if (markerClaim === 'owned-by-other') return { status: 'claimed-by-other-owner' };
    // Reserve the local namespace even when it is currently empty. Otherwise a
    // later account could create or adopt local content after the first account
    // has already crossed the login boundary.
    if (!(await deps.fs.pathExists(sourceDb))) return { status: 'no-local-db' };
    // Serialize the complete database-file-group adoption across processes. The
    // owner marker deliberately allows same-owner readers, so it cannot itself
    // protect the copy; this lease keeps one process from cleaning or publishing
    // another process's temporary database/WAL files.
    leaseHeld = await deps.fs.createFileExclusive(
      lease,
      `${JSON.stringify({ ownerId: normalizedOwnerId, leaseId: randomUUID(), claimedAt: Date.now() })}\n`,
    );
    if (!leaseHeld) return { status: 'target-exists' };
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
    if (leaseHeld) await deps.fs.removeIfExists(lease).catch(() => undefined);
  }
}

export function createProductionLocalProfileDataMigrationDeps(
  userDataDir: string,
  dbFilePrefix: string,
): LocalProfileDataMigrationDeps {
  return { userDataDir, dbFilePrefix, fs: realFs };
}
