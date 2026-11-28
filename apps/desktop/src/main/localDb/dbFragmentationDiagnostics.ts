import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { resolveBetterSqliteNativeBinding } from './betterSqliteFactory';

export interface DbstatObjectBreakdown {
  name: string;
  pages: number;
  totalBytes: number;
  unusedBytes: number;
}

export interface DatabaseFragmentationReport {
  dbFilePath: string;
  mainBytes: number;
  walBytes: number;
  totalBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  freelistBytes: number;
  autoVacuum: number;
  dbstatUnusedBytes: number | null;
  topObjects: DbstatObjectBreakdown[];
}

export interface InspectDatabaseFragmentationOptions {
  topLimit?: number;
}

/**
 * Read-only SQLite space and B-tree page-fragmentation diagnostics.
 *
 * Opens the database with `readonly: true, fileMustExist: true` and reports direct
 * SQLite / filesystem measurements (`page_count`, `freelist_count`, `dbstat` unused
 * bytes). Writes no application data, installs no triggers, and triggers no manual
 * WAL checkpoint (note: SQLite's own WAL VFS may still map/create `-shm` when reading
 * a WAL-mode database).
 */
export function inspectDatabaseFragmentation(
  dbFilePath: string,
  options: InspectDatabaseFragmentationOptions = {},
): DatabaseFragmentationReport {
  const resolved = path.resolve(dbFilePath);
  const mainBytes = fs.statSync(resolved).size;
  let walBytes = 0;
  try {
    walBytes = fs.statSync(`${resolved}-wal`).size;
  } catch {
    walBytes = 0;
  }

  const topLimit = Math.max(0, Math.min(50, Math.floor(options.topLimit ?? 10)));
  const nativeBinding = resolveBetterSqliteNativeBinding();
  const db = new Database(resolved, {
    readonly: true,
    fileMustExist: true,
    ...(nativeBinding ? { nativeBinding } : {}),
  });

  try {
    const pageSize = Number(db.pragma('page_size', { simple: true }) ?? 4096);
    const pageCount = Number(db.pragma('page_count', { simple: true }) ?? 0);
    const freelistCount = Number(db.pragma('freelist_count', { simple: true }) ?? 0);
    const autoVacuum = Number(db.pragma('auto_vacuum', { simple: true }) ?? 0);
    const freelistBytes = freelistCount * pageSize;

    let dbstatUnusedBytes: number | null = null;
    let topObjects: DbstatObjectBreakdown[] = [];
    try {
      const totalRow = db
        .prepare('SELECT COALESCE(SUM(unused), 0) AS unusedBytes FROM dbstat')
        .get() as { unusedBytes?: number } | undefined;
      if (
        totalRow &&
        typeof totalRow.unusedBytes === 'number' &&
        Number.isFinite(totalRow.unusedBytes)
      ) {
        dbstatUnusedBytes = totalRow.unusedBytes;
      }
      if (topLimit > 0) {
        const rows = db
          .prepare(
            `SELECT name,
                    COUNT(*) AS pages,
                    COALESCE(SUM(pgsize), 0) AS totalBytes,
                    COALESCE(SUM(unused), 0) AS unusedBytes
               FROM dbstat
              GROUP BY name
              ORDER BY totalBytes DESC, name ASC
              LIMIT ?`,
          )
          .all(topLimit) as Array<{
          name: string;
          pages: number;
          totalBytes: number;
          unusedBytes: number;
        }>;
        topObjects = rows.map((row) => ({
          name: row.name,
          pages: Number(row.pages),
          totalBytes: Number(row.totalBytes),
          unusedBytes: Number(row.unusedBytes),
        }));
      }
    } catch {
      dbstatUnusedBytes = null;
      topObjects = [];
    }

    return {
      dbFilePath: resolved,
      mainBytes,
      walBytes,
      totalBytes: mainBytes + walBytes,
      pageSize,
      pageCount,
      freelistCount,
      freelistBytes,
      autoVacuum,
      dbstatUnusedBytes,
      topObjects,
    };
  } finally {
    db.close();
  }
}
