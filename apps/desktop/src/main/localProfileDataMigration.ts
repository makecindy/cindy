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
const DB_COPY_PENDING_SUFFIX = '.local-profile-copy-pending';
const DB_COPY_PENDING_VERSION = 1;

const LOCAL_PROFILE_MIGRATION_LOCK_TIMEOUT_MS = 30_000;
const LOCAL_PROFILE_MIGRATION_LOCK_RETRY_MS = 25;

const DB_SIDECAR_SUFFIXES = ['-wal', '-shm'] as const;

export interface LocalProfileDataMigrationFs {
  pathExists(file: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  readDir(directory: string): Promise<string[]>;
  backupDatabase(source: string, target: string): Promise<void>;
  link(source: string, target: string): Promise<void>;
  /** Publish a complete snapshot without replacing an existing target. */
  copyNoReplace(source: string, target: string): Promise<void>;
  removeIfExists(file: string): Promise<void>;
}

export interface LocalProfileDataMigrationDeps {
  userDataDir: string;
  dbFilePrefix: string;
  fs: LocalProfileDataMigrationFs;
  /** True only while no other live process can keep writing the local-v1 source. */
  hasExclusiveSourceAccess?: () => boolean;
  /**
   * Optional OS-level startup barrier held across snapshot publication. Windows
   * uses it to exclude packaged builds that predate the runtime registry.
   */
  acquireSourcePublicationBarrier?: () => Promise<{
    isHeld(): boolean;
    release(): Promise<void>;
  }>;
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
  copyNoReplace: async (source, target) => {
    const pending = `${target}${DB_COPY_PENDING_SUFFIX}`;
    const attemptId = randomUUID();
    writePendingDatabaseCopyMarker(pending, {
      version: DB_COPY_PENDING_VERSION,
      attemptId,
      phase: 'claiming',
    });
    let sourceHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    let targetHandle: Awaited<ReturnType<typeof fs.promises.open>> | undefined;
    try {
      sourceHandle = await fs.promises.open(source, 'r');
      try {
        // O_EXCL is the no-replace claim. Keep the marker in `claiming` until
        // wx succeeds; before that point it is only an intention and must not
        // authorize recovery to delete a target created by another process.
        targetHandle = await fs.promises.open(target, 'wx', 0o600);
        // A durable `copying` marker now proves that this process obtained the
        // exclusive target claim. Recovery may remove only targets with that
        // proof after an interrupted copy.
        updatePendingDatabaseCopyMarker(pending, {
          version: DB_COPY_PENDING_VERSION,
          attemptId,
          phase: 'copying',
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') {
          // The target is authoritative when another initializer won the
          // no-replace claim. Persist that outcome before best-effort cleanup
          // so a restart can never treat this marker as our partial target.
          try {
            updatePendingDatabaseCopyMarker(pending, {
              version: DB_COPY_PENDING_VERSION,
              attemptId,
              phase: 'raced',
            });
          } catch {
            // Keep the original EEXIST as the authoritative result.
          }
          // Cleanup is best effort and must never hide the original EEXIST,
          // because the existing target is authoritative.
          await fs.promises.rm(pending, { force: true }).catch(() => undefined);
        }
        throw error;
      }
      const chunk = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await sourceHandle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await targetHandle.write(
            chunk,
            offset,
            bytesRead - offset,
            position + offset,
          );
          if (bytesWritten <= 0) throw new Error('short write while copying database snapshot');
          offset += bytesWritten;
        }
        position += bytesRead;
      }
      await targetHandle.sync();
      await targetHandle.close();
      targetHandle = undefined;
      await sourceHandle.close();
      sourceHandle = undefined;
      // The open target handle was synced immediately before close; only the
      // parent directory entry still needs an explicit barrier here.
      syncMarkerDirectory(target);
      updatePendingDatabaseCopyMarker(pending, {
        version: DB_COPY_PENDING_VERSION,
        attemptId,
        phase: 'published',
      });
      await fs.promises.rm(pending, { force: true }).catch(() => undefined);
    } finally {
      await targetHandle?.close().catch(() => undefined);
      await sourceHandle?.close().catch(() => undefined);
    }
  },
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

type PendingDatabaseCopyMarker = {
  version: typeof DB_COPY_PENDING_VERSION;
  attemptId: string;
  phase: 'claiming' | 'copying' | 'raced' | 'published';
};

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

function flushFile(file: string): void {
  const handle = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function writePendingDatabaseCopyMarker(
  pending: string,
  marker: PendingDatabaseCopyMarker,
): void {
  const handle = fs.openSync(pending, 'wx', 0o600);
  try {
    const bytes = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(handle, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('short write while publishing database copy marker');
      offset += written;
    }
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  syncMarkerDirectory(pending);
}

function updatePendingDatabaseCopyMarker(
  pending: string,
  marker: PendingDatabaseCopyMarker,
): void {
  atomicWriteFileSync(pending, `${JSON.stringify(marker)}\n`);
  flushFile(pending);
  syncMarkerDirectory(pending);
}

function parsePendingDatabaseCopyMarker(raw: string): PendingDatabaseCopyMarker | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PendingDatabaseCopyMarker>;
    if (
      parsed.version !== DB_COPY_PENDING_VERSION ||
      typeof parsed.attemptId !== 'string' ||
      !parsed.attemptId ||
      (parsed.phase !== 'claiming' &&
        parsed.phase !== 'copying' &&
        parsed.phase !== 'raced' &&
        parsed.phase !== 'published')
    ) {
      return null;
    }
    return {
      version: DB_COPY_PENDING_VERSION,
      attemptId: parsed.attemptId,
      phase: parsed.phase,
    };
  } catch {
    return null;
  }
}

function flushPublishedDatabase(targetDb: string): void {
  // Hard-link publication is not durable until the published inode and its
  // containing directory have both crossed their filesystem barriers.
  flushFile(targetDb);
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
      // Copy into a private pending path first. The canonical marker must not
      // become visible until the complete payload is durable; COPYFILE_EXCL
      // directly on the canonical path can leave a truncated marker after a
      // process or machine interruption.
      if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(code ?? '')) {
        throw error;
      }
      const pending = `${marker}.pending`;
      try {
        if (fs.existsSync(marker)) return 'exists';
        fs.copyFileSync(tmp, pending, fsConstants.COPYFILE_EXCL);
        flushFile(pending);
        syncMarkerDirectory(pending);
        if (fs.existsSync(marker)) return 'exists';
        fs.renameSync(pending, marker);
        const finalHandle = fs.openSync(marker, 'r+');
        try {
          fs.fsyncSync(finalHandle);
        } finally {
          fs.closeSync(finalHandle);
        }
        syncMarkerDirectory(marker);
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException | null)?.code === 'EEXIST') return 'exists';
        throw fallbackError;
      } finally {
        if (fs.existsSync(pending) && fs.existsSync(marker)) {
          try {
            fs.unlinkSync(pending);
          } catch {
            // The canonical marker is authoritative; leave a complete pending
            // copy for the next recovery pass if cleanup is temporarily busy.
          }
        }
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
    if (fs.existsSync(marker)) return false;
    // rename is available on all supported userData filesystems, including
    // those without hard-link support, and publishes the complete candidate
    // in one atomic operation while the migration lock is held.
    fs.renameSync(candidate, marker);
    syncMarkerDirectory(marker);
    return true;
  } catch {
    // Keeping the claimed candidate is safer than deleting ownership evidence.
    return false;
  }
}

function recoverReleasedLocalProfileMigrationMarker(
  marker: string,
  committedOwnerId: string | null,
): Exclude<PendingLocalProfileReservationRecovery, 'none'> | null {
  const candidate = `${marker}.release`;
  if (!fs.existsSync(candidate)) return null;
  // A release candidate is created by renaming the canonical marker while the
  // migration lock is held. Seeing another canonical/pending marker beside it
  // is not a state we can attribute safely, so preserve all evidence.
  if (fs.existsSync(marker) || fs.existsSync(`${marker}.pending`)) return 'failed';

  let parsed: LocalProfileMigrationMarker | null = null;
  try {
    parsed = parseLocalProfileMigrationMarker(fs.readFileSync(candidate, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed) return 'failed';

  // Tokenless markers are already committed ownership records. A release call
  // can only have moved one here before it verified a stale/wrong claim token;
  // restore it regardless of the current account rather than deleting it.
  if (!parsed.claimToken) {
    return restoreClaimedLocalProfileMarker(candidate, marker) ? null : 'failed';
  }
  if (parsed.ownerId === committedOwnerId) {
    if (!restoreClaimedLocalProfileMarker(candidate, marker)) return 'failed';
    replaceLocalProfileMigrationMarker(
      marker,
      `${JSON.stringify({ ownerId: parsed.ownerId, claimedAt: Date.now() })}\n`,
    );
    return 'finalized';
  }

  try {
    fs.unlinkSync(candidate);
    syncMarkerDirectory(marker);
    return 'released';
  } catch {
    return 'failed';
  }
}

function recoverPendingLocalProfileMigrationMarker(marker: string): void {
  const pending = `${marker}.pending`;
  if (!fs.existsSync(pending)) return;
  if (fs.existsSync(marker)) {
    try {
      fs.unlinkSync(pending);
      syncMarkerDirectory(marker);
    } catch {
      // The canonical marker is authoritative; a later pass can retry cleanup.
    }
    return;
  }
  let parsed: LocalProfileMigrationMarker | null = null;
  try {
    parsed = parseLocalProfileMigrationMarker(fs.readFileSync(pending, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    fs.unlinkSync(pending);
    syncMarkerDirectory(marker);
    return;
  }
  flushFile(pending);
  syncMarkerDirectory(pending);
  if (fs.existsSync(marker)) return;
  fs.renameSync(pending, marker);
  const finalHandle = fs.openSync(marker, 'r+');
  try {
    fs.fsyncSync(finalHandle);
  } finally {
    fs.closeSync(finalHandle);
  }
  syncMarkerDirectory(marker);
}

function reserveLocalProfileDataOwnerWhileLocked(
  normalizedOwnerId: string,
  marker: string,
  provisional: boolean,
): LocalProfileMigrationReservationDetails {
  try {
    recoverPendingLocalProfileMigrationMarker(marker);
  } catch {
    return { status: 'failed' };
  }
  // A previous release may have moved the canonical marker to this candidate
  // and failed to restore it. Treat that stranded ownership evidence as busy;
  // never let a later owner claim the namespace while it is unresolved.
  if (fs.existsSync(`${marker}.release`)) return { status: 'failed' };
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
    const candidate = `${marker}.release`;
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
        const releasedMarkerRecovery = recoverReleasedLocalProfileMigrationMarker(
          marker,
          normalizedCommittedOwnerId,
        );
        if (releasedMarkerRecovery) return releasedMarkerRecovery;
        recoverPendingLocalProfileMigrationMarker(marker);
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

type DatabasePublicationRecovery = 'clean' | 'ambiguous';

type PassivePendingDatabaseCopyMarkerRead =
  | { status: 'absent' }
  | { status: 'present'; raw: string }
  | { status: 'recovery-required' };

function readPendingDatabaseCopyMarkerForPassivePreflight(
  pending: string,
): PassivePendingDatabaseCopyMarkerRead {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { status: 'present', raw: fs.readFileSync(pending, 'utf8') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      // Passive preflight is deliberately read-only. During atomicWriteFileSync's
      // Windows backup exchange the canonical marker can be absent while .bak is
      // the writer's only valid snapshot. Restoring it here would race the writer
      // outside the migration lock, so leave both paths untouched and fail closed.
      if (fs.existsSync(`${pending}.bak`)) return { status: 'recovery-required' };
      // The writer may have completed the exchange and removed .bak between the
      // failed read and the backup check. Re-read canonical once before deciding
      // that no publication marker exists.
      if (attempt === 1) return { status: 'absent' };
    }
  }
  return { status: 'absent' };
}

async function recoverIncompleteDatabasePublication(
  deps: LocalProfileDataMigrationDeps,
  targetDb: string,
): Promise<DatabasePublicationRecovery> {
  const pending = `${targetDb}${DB_COPY_PENDING_SUFFIX}`;
  const raw = readAtomicFileSync(pending);
  if (raw === null) return 'clean';
  const marker = parsePendingDatabaseCopyMarker(raw);
  if (!marker) throw new Error('database copy pending marker is malformed');

  const targetState = await databaseFileGroupState(deps, targetDb);
  if (marker.phase === 'claiming') {
    // A competing cloud initializer may have won after our marker was
    // persisted. An ambiguous marker must never authorize deleting or opening
    // that target; leave both files in place and fail closed.
    if (targetState.mainExists || targetState.sidecarExists) return 'ambiguous';
    await deps.fs.removeIfExists(pending);
    return 'clean';
  }
  if (marker.phase === 'published') {
    // The snapshot was fully flushed before marker cleanup. Preserve the
    // target and retire only the bookkeeping marker.
    if (!targetState.mainExists) {
      for (const suffix of DB_SIDECAR_SUFFIXES) {
        await deps.fs.removeIfExists(`${targetDb}${suffix}`);
      }
    }
    await deps.fs.removeIfExists(pending);
    return 'clean';
  }

  if (marker.phase === 'raced') {
    // Another initializer won the no-replace claim. Never remove its target;
    // retire only this process's bookkeeping marker.
    await deps.fs.removeIfExists(pending).catch(() => undefined);
    return 'clean';
  }

  // Only the explicit copying phase proves that this process won the target's
  // O_EXCL claim. It is therefore the only state allowed to remove a partial
  // target and retry adoption after a crash.
  await deps.fs.removeIfExists(targetDb);
  for (const suffix of DB_SIDECAR_SUFFIXES) {
    await deps.fs.removeIfExists(`${targetDb}${suffix}`);
  }
  await deps.fs.removeIfExists(pending);
  return 'clean';
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
    if (targetState.mainExists) {
      const pendingMarker = readPendingDatabaseCopyMarkerForPassivePreflight(
        `${targetDb}${DB_COPY_PENDING_SUFFIX}`,
      );
      if (pendingMarker.status === 'recovery-required') {
        return {
          status: 'failed',
          error: 'database copy pending marker recovery requires migration lock',
        };
      }
      if (pendingMarker.status === 'present') {
        const pending = parsePendingDatabaseCopyMarker(pendingMarker.raw);
        if (!pending) {
          return { status: 'failed', error: 'database copy pending marker is malformed' };
        }
        if (pending.phase === 'claiming') {
          return {
            status: 'failed',
            error: 'database copy publication has an unproven target owner',
          };
        }
        if (pending.phase === 'copying') {
          return { status: 'failed', error: 'target database copy is incomplete' };
        }
      }
      return { status: 'not-required', reason: 'target-exists' };
    }
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
    if (deps.hasExclusiveSourceAccess && !deps.hasExclusiveSourceAccess()) {
      throw new Error('local profile database adoption deferred: concurrent live instance');
    }
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
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'EEXIST') return false;
    if (!['EXDEV', 'EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS'].includes(code ?? '')) {
      throw error;
    }
    try {
      await deps.fs.copyNoReplace(dbTmp, targetDb);
      return true;
    } catch (fallbackError) {
      if ((fallbackError as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
      throw fallbackError;
    }
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
  let sourcePublicationBarrier: Awaited<
    ReturnType<NonNullable<LocalProfileDataMigrationDeps['acquireSourcePublicationBarrier']>>
  > | null = null;
  try {
    lockDb = await acquireLocalProfileMigrationLock(marker);
    const reservation = reserveLocalProfileDataOwnerWhileLocked(normalizedOwnerId, marker, false);
    if (reservation.status === 'owned-by-other') return { status: 'claimed-by-other-owner' };
    if (reservation.status === 'failed') {
      throw new Error('failed to reserve local profile owner');
    }
    const recovery = await recoverIncompleteDatabasePublication(deps, targetDb);
    if (recovery === 'ambiguous') {
      return {
        status: 'failed',
        error: 'database copy publication has an unproven target owner',
      };
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
    if (deps.acquireSourcePublicationBarrier) {
      sourcePublicationBarrier = await deps.acquireSourcePublicationBarrier();
    }
    const guardedDeps: LocalProfileDataMigrationDeps = sourcePublicationBarrier
      ? {
          ...deps,
          hasExclusiveSourceAccess: () =>
            sourcePublicationBarrier?.isHeld() === true &&
            (deps.hasExclusiveSourceAccess?.() ?? true),
        }
      : deps;
    const sourceState = await databaseFileGroupState(guardedDeps, sourceDb);
    if (sourceState.sidecarExists && !sourceState.mainExists) {
      throw new Error('source database sidecar exists without its main database');
    }
    if (!sourceState.mainExists) {
      if (guardedDeps.hasExclusiveSourceAccess && !guardedDeps.hasExclusiveSourceAccess()) {
        throw new Error('local profile database adoption deferred: concurrent live instance');
      }
      return { status: 'no-local-db' };
    }
    // The same crash-released SQLite writer lock serializes marker repair and
    // the complete snapshot publication. No PID identity or reclaimable lease
    // file is involved, so a crashed process cannot block adoption forever.
    if (guardedDeps.hasExclusiveSourceAccess && !guardedDeps.hasExclusiveSourceAccess()) {
      throw new Error('local profile database adoption deferred: concurrent live instance');
    }
    const adopted = await copyDatabaseAtomically(guardedDeps, sourceDb, targetDb);
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
    await sourcePublicationBarrier?.release().catch(() => undefined);
  }
}

export function createProductionLocalProfileDataMigrationDeps(
  userDataDir: string,
  dbFilePrefix: string,
  hasExclusiveSourceAccess?: () => boolean,
  acquireSourcePublicationBarrier?: LocalProfileDataMigrationDeps['acquireSourcePublicationBarrier'],
): LocalProfileDataMigrationDeps {
  return {
    userDataDir,
    dbFilePrefix,
    fs: realFs,
    ...(hasExclusiveSourceAccess ? { hasExclusiveSourceAccess } : {}),
    ...(acquireSourcePublicationBarrier ? { acquireSourcePublicationBarrier } : {}),
  };
}
