export interface SqliteLockDatabase {
  exec(sql: string): void;
  pragma(sql: string): unknown;
  close(): void;
}

export interface SqliteExclusiveFileLock {
  /** Nonblocking: returns false only when another connection owns the lock. */
  tryAcquire(): boolean;
  /** Idempotently releases this connection's exclusive lock. */
  release(): void;
  isHeld(): boolean;
}

export type OpenSqliteLockDatabase = (lockPath: string) => SqliteLockDatabase;

export function isSqliteLockContention(error: unknown): boolean;

/**
 * Create a process lock using SQLite's native file locking. The caller must
 * provide a driver configured with zero busy timeout.
 */
export function createSqliteExclusiveFileLock(
  lockPath: string,
  openDatabase: OpenSqliteLockDatabase,
): SqliteExclusiveFileLock;
