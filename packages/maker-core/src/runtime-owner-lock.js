/**
 * SQLite-backed process ownership lock. The caller supplies the SQLite driver
 * so Desktop and Node hosts can share the same on-disk lock protocol.
 */
export function isSqliteLockContention(error) {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  if ([
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'SQLITE_BUSY_SNAPSHOT',
    'SQLITE_BUSY_RECOVERY',
    'SQLITE_BUSY_TIMEOUT',
    '5',
    '6',
  ].includes(code)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

/**
 * Hold SQLite's OS-level exclusive lock until release(). The lock database is
 * only a coordination file; it stores no profile, account, or user data.
 */
export function createSqliteExclusiveFileLock(lockPath, openDatabase) {
  let database = null;

  const closeQuietly = (handle) => {
    try {
      handle.exec('ROLLBACK');
    } catch {
      // No open transaction.
    }
    try {
      handle.close();
    } catch {
      // Already closed.
    }
  };

  return {
    tryAcquire() {
      if (database) return true;
      let handle = null;
      try {
        handle = openDatabase(lockPath);
        handle.pragma('journal_mode = DELETE');
        handle.pragma('busy_timeout = 0');
        handle.exec('BEGIN EXCLUSIVE');
        handle.exec('CREATE TABLE IF NOT EXISTS ownership_lock (id INTEGER PRIMARY KEY NOT NULL)');
        database = handle;
        return true;
      } catch (error) {
        if (handle) closeQuietly(handle);
        if (isSqliteLockContention(error)) return false;
        throw error;
      }
    },
    release() {
      if (!database) return;
      closeQuietly(database);
      database = null;
    },
    isHeld() {
      return database !== null;
    },
  };
}
