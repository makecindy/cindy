import fs from 'node:fs';

export type DatabaseSizeWarningStatus = { databaseBytes: number | null };

export interface DatabaseSizeWarningStatusDeps {
  getCurrentDbPath: () => string | null;
  getCurrentUserId: () => string | null;
  resolveDbPathForUser: (userId: string) => string;
  statSync?: (filePath: string) => { isFile(): boolean; size: number };
}

/** Sum the SQLite database and optional sidecar files for the active account. */
export function collectDatabaseSizeWarningStatus(
  deps: DatabaseSizeWarningStatusDeps,
): DatabaseSizeWarningStatus {
  const userId = deps.getCurrentUserId();
  const dbFilePath = deps.getCurrentDbPath() ?? (userId ? deps.resolveDbPathForUser(userId) : null);
  if (!dbFilePath) return { databaseBytes: null };

  const statSync = deps.statSync ?? ((filePath: string) => fs.statSync(filePath));
  let databaseBytes = 0;
  let found = false;
  for (const candidate of [
    dbFilePath,
    `${dbFilePath}-wal`,
    `${dbFilePath}-shm`,
    `${dbFilePath}-journal`,
  ]) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) {
        databaseBytes += stat.size;
        found = true;
      }
    } catch {
      // SQLite sidecar files are optional and may disappear between checks.
    }
  }
  return { databaseBytes: found ? databaseBytes : null };
}
