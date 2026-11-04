import path from 'node:path';

import Database from 'better-sqlite3';

import {
  createSqliteExclusiveFileLock,
  type SqliteExclusiveFileLock,
} from '@cindy/maker-core/runtime-owner-lock';

export interface HostRuntimeLease {
  held: true;
  lockPath: string;
  release(): void;
}

export interface HostRuntimeLeaseBusy {
  held: false;
  lockPath: string;
  reason: 'held-by-other-process' | 'unavailable';
}

export type HostRuntimeLeaseResult = HostRuntimeLease | HostRuntimeLeaseBusy;

/**
 * One runtime writer per profile. SQLite's OS-level exclusive lock releases on
 * process death, so a crash cannot leave the profile permanently owned — and a
 * second host, whatever port it picks, cannot start a competing runtime.
 */
export function acquireHostRuntimeLease(userDataDir: string, ownerId: string): HostRuntimeLeaseResult {
  const lockPath = path.join(userDataDir, `cindy-host-runtime-${ownerId}.lock.db`);
  const lock: SqliteExclusiveFileLock = createSqliteExclusiveFileLock(
    lockPath,
    (file) => new Database(file, { timeout: 0 }),
  );
  try {
    if (!lock.tryAcquire()) {
      return { held: false, lockPath, reason: 'held-by-other-process' };
    }
  } catch {
    return { held: false, lockPath, reason: 'unavailable' };
  }
  return {
    held: true,
    lockPath,
    release: () => lock.release(),
  };
}
