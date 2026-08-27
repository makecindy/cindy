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
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  createBetterSqliteDatabase,
  restrictDbFilePermissions,
} from './localDb/betterSqliteFactory.js';
import { LOCAL_PROFILE_DATA_OWNER_ID } from './profile/profileRegistryModel.js';
import { atomicWriteFileSync, readAtomicFileSync } from './utils/atomicWriteFile.js';

export const LOCAL_PROFILE_MIGRATION_TMP_SUFFIX = '.local-profile-migration-tmp';
export const LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX = '.local-profile-migration.json';
export const LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX = '.mutation-lock.sqlite';

const LOCAL_PROFILE_MIGRATION_LOCK_TIMEOUT_MS = 30_000;
const LOCAL_PROFILE_MIGRATION_LOCK_RETRY_MS = 25;

const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export interface LocalProfileDataMigrationFs {
  pathExists(file: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  readDir(directory: string): Promise<string[]>;
  backupDatabase(source: string, target: string): Promise<void>;
  link(source: string, target: string): Promise<void>;
  removeIfExists(file: string): Promise<void>;
}

export interface LocalProfileDataMigrationDeps {
  userDataDir: string;
  dbFilePrefix: string;
  fs: LocalProfileDataMigrationFs;
  /** True only while no other live process can keep writing the local-v1 source. */
  hasExclusiveSourceAccess?: () => boolean;
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
      throw error;
    }
  },
  readFile: (file) => fs.promises.readFile(file, 'utf8'),
  readDir: (directory) => fs.promises.readdir(directory),
  backupDatabase: async (source, target) => {
    // Restrict the destination before SQLite starts its potentially long
    // online backup; chmod-after-backup leaves a readable snapshot window.
    const handle = fs.openSync(target, 'w', 0o600);
    fs.closeSync(handle);
    const db = createBetterSqliteDatabase(source, { readonly: true, fileMustExist: true });
    try {
      await db.backup(target);
      restrictDbFilePermissions(target);
    } finally {
      db.close();
    }
  },
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

type LocalProfileMigrationLockDb = ReturnType<typeof createBetterSqliteDatabase>;

type LocalProfileMigrationLockAttempt =
  | { status: 'acquired'; db: LocalProfileMigrationLockDb }
  | { status: 'busy' }
  | { status: 'failed'; error: unknown };

function migrationLockPath(marker: string): string {
  return `${marker}${LOCAL_PROFILE_MIGRATION_LOCK_DB_SUFFIX}`;
}

function tryAcquireLocalProfileMigrationLock(marker: string): LocalProfileMigrationLockAttempt {
  const lockDbPath = migrationLockPath(marker);
  let db: LocalProfileMigrationLockDb | null = null;
  try {
    fs.mkdirSync(path.dirname(lockDbPath), { recursive: true });
    db = createBetterSqliteDatabase(lockDbPath);
    db.pragma('busy_timeout = 0');
    db.exec('BEGIN IMMEDIATE');
    return { status: 'acquired', db };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the acquisition error; close is best effort on a failed open.
    }
    const code = (error as { code?: string } | null)?.code;
    return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
      ? { status: 'busy' }
      : { status: 'failed', error };
  }
}

function releaseLocalProfileMigrationLock(db: LocalProfileMigrationLockDb): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Closing the connection still releases SQLite's OS-level lock.
  }
  db.close();
}

function withLocalProfileMigrationLock<T>(marker: string, fallback: T, operation: () => T): T {
  const attempt = tryAcquireLocalProfileMigrationLock(marker);
  if (attempt.status !== 'acquired') return fallback;
  try {
    return operation();
  } finally {
    releaseLocalProfileMigrationLock(attempt.db);
  }
}

async function acquireLocalProfileMigrationLock(
  marker: string,
): Promise<LocalProfileMigrationLockDb> {
  const deadline = performance.now() + LOCAL_PROFILE_MIGRATION_LOCK_TIMEOUT_MS;
  for (;;) {
    const attempt = tryAcquireLocalProfileMigrationLock(marker);
    if (attempt.status === 'acquired') return attempt.db;
    if (attempt.status === 'failed') {
      throw new Error(
        `failed to acquire local profile migration lock: ${
          attempt.error instanceof Error ? attempt.error.message : String(attempt.error)
        }`,
      );
    }
    if (performance.now() >= deadline) {
      throw new Error('timed out acquiring local profile migration lock');
    }
    await new Promise<void>((resolve) =>
      setTimeout(resolve, LOCAL_PROFILE_MIGRATION_LOCK_RETRY_MS),
    );
  }
}

/**
 * Serialize process registration with local-profile adoption. Adoption already
 * holds this same crash-released SQLite writer lock through snapshot publication;
 * a new process must publish its runtime record under the lock so it either
 * becomes visible before adoption's exclusivity check or starts after the cloud
 * target is durable.
 */
export async function withLocalProfileMigrationStartupBarrier<T>(
  userDataDir: string,
  dbFilePrefix: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const marker = path.join(
    userDataDir,
    `${dbFilePrefix}-${LOCAL_PROFILE_DATA_OWNER_ID}${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`,
  );
  const lockDb = await acquireLocalProfileMigrationLock(marker);
  try {
    return await operation();
  } finally {
    releaseLocalProfileMigrationLock(lockDb);
  }
}

export type LocalProfileMigrationReservation =
  'claimed' | 'already-owned' | 'owned-by-other' | 'failed';

export interface LocalProfileMigrationReservationDetails {
  status: LocalProfileMigrationReservation;
  /** The durable namespace owner observed or created by this attempt. */
  ownerId?: string;
  claimToken?: string;
}

export type PendingLocalProfileReservationRecovery = 'none' | 'finalized' | 'released' | 'failed';

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
  let dirFd: number | undefined;
  try {
    dirFd = fs.openSync(path.dirname(marker), 'r');
    fs.fsyncSync(dirFd);
  } catch (error) {
    // Directory handles are not supported by every Windows filesystem. The
    // final-file flush remains the durability barrier there; POSIX errors are
    // surfaced because the directory entry is otherwise not durable.
    if (process.platform !== 'win32') throw error;
  } finally {
    if (dirFd !== undefined) fs.closeSync(dirFd);
  }
}

function flushPublishedDatabase(targetDb: string): void {
  // Hard-link publication is not durable until the published inode and its
  // containing directory have both crossed their filesystem barriers.
  const finalHandle = fs.openSync(targetDb, 'r+');
  try {
    fs.fsyncSync(finalHandle);
  } finally {
    fs.closeSync(finalHandle);
  }
  syncMarkerDirectory(targetDb);
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
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'EEXIST') return 'exists';
      // A few supported userData filesystems do not implement hard links.
      // Preserve the no-replace claim point with an exclusive copy instead of
      // falling back to rename (which could replace another owner's marker).
      if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(code ?? '')) {
        throw error;
      }
      try {
        fs.copyFileSync(tmp, marker, fsConstants.COPYFILE_EXCL);
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException | null)?.code === 'EEXIST') return 'exists';
        throw fallbackError;
      }
    }
    const finalHandle = fs.openSync(marker, 'r+');
    try {
      fs.fsyncSync(finalHandle);
    } finally {
      fs.closeSync(finalHandle);
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

function replaceLocalProfileMigrationMarker(marker: string, contents: string): void {
  atomicWriteFileSync(marker, contents);
  // Windows requires a writable handle for FlushFileBuffers. The marker is
  // created with owner-only permissions, so r+ is safe on POSIX as well.
  const finalHandle = fs.openSync(marker, 'r+');
  try {
    fs.fsyncSync(finalHandle);
  } finally {
    fs.closeSync(finalHandle);
  }
  syncMarkerDirectory(marker);
}

function restoreClaimedLocalProfileMarker(candidate: string, marker: string): boolean {
  try {
    // Restore only into an absent canonical path; never overwrite a newer
    // reservation that may have appeared after this process claimed candidate.
    fs.linkSync(candidate, marker);
    fs.unlinkSync(candidate);
    syncMarkerDirectory(marker);
    return true;
  } catch {
    // Keeping the claimed candidate is safer than deleting ownership evidence.
    return false;
  }
}

function reserveLocalProfileDataOwnerWhileLocked(
  normalizedOwnerId: string,
  marker: string,
  provisional: boolean,
): LocalProfileMigrationReservationDetails {
  const claimToken = provisional ? randomUUID() : undefined;
  const contents = `${JSON.stringify({
    ownerId: normalizedOwnerId,
    ...(claimToken ? { claimToken } : {}),
    claimedAt: Date.now(),
  })}\n`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // Restore an atomic-write backup before deciding that the namespace is
      // unclaimed. A stranded `.bak` is still a valid ownership snapshot.
      const raw = readAtomicFileSync(marker);
      if (raw === null) throw Object.assign(new Error('marker is absent'), { code: 'ENOENT' });
      const parsed = parseLocalProfileMigrationMarker(raw);
      if (parsed) {
        if (parsed.ownerId !== normalizedOwnerId) {
          return { status: 'owned-by-other', ownerId: parsed.ownerId };
        }
        if (!provisional && parsed.claimToken) {
          replaceLocalProfileMigrationMarker(
            marker,
            `${JSON.stringify({ ownerId: normalizedOwnerId, claimedAt: Date.now() })}\n`,
          );
        }
        return { status: 'already-owned', ownerId: normalizedOwnerId };
      }
      // A malformed marker is not evidence of an unused namespace. It may be
      // a damaged committed owner record, so preserve it and fail closed rather
      // than allowing a later account to adopt the retained local database.
      return { status: 'failed' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        return { status: 'failed' };
      }
    }
    try {
      if (publishLocalProfileMigrationMarker(marker, contents) === 'claimed') {
        return {
          status: 'claimed',
          ownerId: normalizedOwnerId,
          ...(claimToken ? { claimToken } : {}),
        };
      }
    } catch {
      return { status: 'failed' };
    }
  }
  return { status: 'failed' };
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
  return withLocalProfileMigrationLock(marker, { status: 'failed' }, () =>
    reserveLocalProfileDataOwnerWhileLocked(normalizedOwnerId, marker, true),
  );
}

/** Reserve or finalize ownership for an owner whose cloud session is already durable. */
export function reserveCommittedLocalProfileDataOwnerDetailed(
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
  return withLocalProfileMigrationLock<LocalProfileMigrationReservationDetails>(
    marker,
    { status: 'failed' },
    () => reserveLocalProfileDataOwnerWhileLocked(normalizedOwnerId, marker, false),
  );
}

export function reserveCommittedLocalProfileDataOwner(
  ownerId: string,
  userDataDir: string,
  dbFilePrefix: string,
): LocalProfileMigrationReservation {
  return reserveCommittedLocalProfileDataOwnerDetailed(ownerId, userDataDir, dbFilePrefix).status;
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
  return withLocalProfileMigrationLock(marker, false, () => {
    const candidate = `${marker}.release.${randomUUID()}`;
    try {
      // Atomically claim the exact marker before checking the token. This
      // prevents a stale read from unlinking another reservation.
      fs.renameSync(marker, candidate);
      const parsed = parseLocalProfileMigrationMarker(fs.readFileSync(candidate, 'utf8'));
      if (!parsed || parsed.ownerId !== normalizedOwnerId || parsed.claimToken !== claimToken) {
        restoreClaimedLocalProfileMarker(candidate, marker);
        return false;
      }
      fs.unlinkSync(candidate);
      syncMarkerDirectory(marker);
      return true;
    } catch {
      if (fs.existsSync(candidate)) restoreClaimedLocalProfileMarker(candidate, marker);
      return false;
    }
  });
}

/**
 * Settle a durable pre-commit claim before another cloud-owner transition.
 * A token belonging to the currently committed owner is finalized in place;
 * any other token is an interrupted reservation and is released. Markers
 * without a token are already committed and are never changed here.
 */
export function recoverPendingLocalProfileDataOwner(
  committedOwnerId: string | null,
  userDataDir: string,
  dbFilePrefix: string,
): PendingLocalProfileReservationRecovery {
  const normalizedCommittedOwnerId = committedOwnerId?.trim() || null;
  const marker = path.join(
    userDataDir,
    `${dbFilePrefix}-${LOCAL_PROFILE_DATA_OWNER_ID}${LOCAL_PROFILE_MIGRATION_MARKER_SUFFIX}`,
  );
  return withLocalProfileMigrationLock<PendingLocalProfileReservationRecovery>(
    marker,
    'failed',
    () => {
      try {
        // atomicWriteFileSync may leave the only valid snapshot in .bak after
        // an interrupted Windows backup exchange. Restore it before deciding
        // whether a pending claim exists.
        const raw = readAtomicFileSync(marker);
        if (raw === null) return 'none';
        const parsed = parseLocalProfileMigrationMarker(raw);
        if (!parsed) return 'failed';
        if (!parsed.claimToken) return 'none';
        if (parsed.ownerId === normalizedCommittedOwnerId) {
          replaceLocalProfileMigrationMarker(
            marker,
            `${JSON.stringify({ ownerId: parsed.ownerId, claimedAt: Date.now() })}\n`,
          );
          return 'finalized';
        }
        fs.unlinkSync(marker);
        syncMarkerDirectory(marker);
        return 'released';
      } catch {
        return 'failed';
      }
    },
  );
}

async function cleanupTemps(deps: LocalProfileDataMigrationDeps, targetDb: string): Promise<void> {
  const directory = path.dirname(targetDb);
  const targetName = path.basename(targetDb);
  const prefixes = [
    `${targetName}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`,
    ...DB_SIDECAR_SUFFIXES.map(
      (suffix) => `${targetName}${suffix}${LOCAL_PROFILE_MIGRATION_TMP_SUFFIX}`,
    ),
  ];
  const entries = await deps.fs.readDir(directory);
  for (const entry of entries) {
    if (prefixes.some((prefix) => entry === prefix || entry.startsWith(`${prefix}.`))) {
      await deps.fs.removeIfExists(path.join(directory, entry));
    }
  }
}

async function databaseFileGroupState(
  deps: LocalProfileDataMigrationDeps,
  database: string,
): Promise<{ mainExists: boolean; sidecarExists: boolean }> {
  const [mainExists, ...sidecarResults] = await Promise.all([
    deps.fs.pathExists(database),
    ...DB_SIDECAR_SUFFIXES.map((suffix) => deps.fs.pathExists(`${database}${suffix}`)),
  ]);
  return { mainExists, sidecarExists: sidecarResults.some(Boolean) };
}

export type PassiveLocalProfileAdoptionPreflight =
  | { status: 'not-required'; reason: 'no-local-db' | 'target-exists' | 'claimed-by-other-owner' }
  | { status: 'required' }
  | { status: 'failed'; error: string };

/**
 * Read-only guard for a passive shared-userData process. Passive instances must
 * not claim or copy local-v1, but they also must not create an empty cloud target
 * while the authoritative owner still needs to adopt the retained source.
 */
export async function inspectPassiveLocalProfileAdoption(
  ownerId: string,
  deps: LocalProfileDataMigrationDeps,
): Promise<PassiveLocalProfileAdoptionPreflight> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || normalizedOwnerId === LOCAL_PROFILE_DATA_OWNER_ID) {
    return { status: 'failed', error: 'invalid cloud owner for local profile adoption' };
  }

  const sourceDb = dbPath(deps, LOCAL_PROFILE_DATA_OWNER_ID);
  const targetDb = dbPath(deps, normalizedOwnerId);
  try {
    const targetState = await databaseFileGroupState(deps, targetDb);
    if (targetState.sidecarExists && !targetState.mainExists) {
      return {
        status: 'failed',
        error: 'target database sidecar exists without its main database',
      };
    }
    if (targetState.mainExists) return { status: 'not-required', reason: 'target-exists' };
    const sourceState = await databaseFileGroupState(deps, sourceDb);
    if (sourceState.sidecarExists && !sourceState.mainExists) {
      return {
        status: 'failed',
        error: 'source database sidecar exists without its main database',
      };
    }
    if (!sourceState.mainExists) {
      if (deps.hasExclusiveSourceAccess && !deps.hasExclusiveSourceAccess()) {
        return {
          status: 'failed',
          error: 'local profile database adoption deferred: concurrent live instance',
        };
      }
      return { status: 'not-required', reason: 'no-local-db' };
    }

    try {
      const parsed = parseLocalProfileMigrationMarker(
        await deps.fs.readFile(migrationMarkerPath(deps)),
      );
      if (!parsed) {
        return { status: 'failed', error: 'local profile owner marker is malformed' };
      }
      if (parsed.ownerId !== normalizedOwnerId) {
        return { status: 'not-required', reason: 'claimed-by-other-owner' };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      // A missing marker can be repaired only by the primary instance. Until
      // then, preserve the source by keeping this create-capable path closed.
    }
    return { status: 'required' };
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
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
  let published = false;
  try {
    // SQLite's online backup API takes one coherent snapshot even while another
    // process is writing the WAL. The resulting standalone database therefore
    // needs no source -wal/-shm files and can be published as one atomic entry.
    await deps.fs.backupDatabase(sourceDb, dbTmp);
    if (deps.hasExclusiveSourceAccess && !deps.hasExclusiveSourceAccess()) {
      throw new Error('local profile database adoption deferred: concurrent live instance');
    }
    // Claim the target with a no-replace filesystem primitive. Never use
    // rename here: a later initializer must lose with EEXIST rather than
    // overwrite the database already published by the first initializer.
    const linked = await claimDatabaseTargetWithoutReplacement(deps, dbTmp, targetDb);
    if (!linked) return false;
    published = true;
    flushPublishedDatabase(targetDb);
    return true;
  } catch (error) {
    if (published) await deps.fs.removeIfExists(targetDb);
    throw error;
  } finally {
    await deps.fs.removeIfExists(dbTmp);
  }
}

async function claimDatabaseTargetWithoutReplacement(
  deps: LocalProfileDataMigrationDeps,
  dbTmp: string,
  targetDb: string,
): Promise<boolean> {
  try {
    await deps.fs.link(dbTmp, targetDb);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
    throw error;
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
  const marker = migrationMarkerPath(deps);
  let lockDb: LocalProfileMigrationLockDb | null = null;
  try {
    lockDb = await acquireLocalProfileMigrationLock(marker);
    const reservation = reserveLocalProfileDataOwnerWhileLocked(normalizedOwnerId, marker, false);
    if (reservation.status === 'owned-by-other') return { status: 'claimed-by-other-owner' };
    if (reservation.status === 'failed') {
      throw new Error('failed to reserve local profile owner');
    }
    // Reserve the local namespace even when it is currently empty. Otherwise a
    // later account could create or adopt local content after the first account
    // has already crossed the login boundary.
    // Check the target first: an existing cloud database remains authoritative
    // and must open even while another live instance shares userData.
    const targetState = await databaseFileGroupState(deps, targetDb);
    if (targetState.sidecarExists && !targetState.mainExists) {
      throw new Error('target database sidecar exists without its main database');
    }
    if (targetState.mainExists || targetState.sidecarExists) {
      await cleanupTemps(deps, targetDb);
      return { status: 'target-exists' };
    }
    const sourceState = await databaseFileGroupState(deps, sourceDb);
    if (sourceState.sidecarExists && !sourceState.mainExists) {
      throw new Error('source database sidecar exists without its main database');
    }
    if (!sourceState.mainExists) {
      if (deps.hasExclusiveSourceAccess && !deps.hasExclusiveSourceAccess()) {
        throw new Error('local profile database adoption deferred: concurrent live instance');
      }
      return { status: 'no-local-db' };
    }
    // The same crash-released SQLite writer lock serializes marker repair and
    // the complete snapshot publication. No PID identity or reclaimable lease
    // file is involved, so a crashed process cannot block adoption forever.
    if (deps.hasExclusiveSourceAccess && !deps.hasExclusiveSourceAccess()) {
      throw new Error('local profile database adoption deferred: concurrent live instance');
    }
    const adopted = await copyDatabaseAtomically(deps, sourceDb, targetDb);
    return adopted ? { status: 'adopted', sourceDb, targetDb } : { status: 'target-exists' };
  } catch (error) {
    // Migration snapshots are shared across processes. Only the SQLite writer
    // lock owner may classify matching UUID files as stale; a contender that
    // timed out before acquiring the lock must not unlink the active holder's
    // snapshot while SQLite is still writing it.
    if (lockDb) await cleanupTemps(deps, targetDb).catch(() => undefined);
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (lockDb) releaseLocalProfileMigrationLock(lockDb);
  }
}

export function createProductionLocalProfileDataMigrationDeps(
  userDataDir: string,
  dbFilePrefix: string,
  hasExclusiveSourceAccess?: () => boolean,
): LocalProfileDataMigrationDeps {
  return {
    userDataDir,
    dbFilePrefix,
    fs: realFs,
    ...(hasExclusiveSourceAccess ? { hasExclusiveSourceAccess } : {}),
  };
}
