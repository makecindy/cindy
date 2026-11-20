import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

import type { DatabaseConstructor } from './runtime.js';
import { isSqliteCorruption } from '../client/sqliteCorruption.js';

/** Machine-local deletion evidence only; never exposes messages or credentials. */
export interface LocalWorktreeReference {
  id: string;
  status: string | null;
  source: string | null;
  workingDir: string | null;
  worktreePath: string | null;
  currentDatabase: boolean;
}

function referenceQuery(db: Database.Database): string {
  const info = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  const columns = new Set(info.map((column) => column.name));
  const hasWorktree = columns.has('worktree_path');
  const hasSource = columns.has('source');
  const hasRemote = columns.has('remote_host_id');
  // These columns were added in 0005, 0007 and 0038 respectively. Unknown
  // layouts must not silently become an incomplete set of deletion evidence.
  if (!['id', 'status', 'working_dir'].every((name) => columns.has(name))
    || (hasSource && !hasWorktree) || (hasRemote && !hasSource)) {
    throw new Error('unsupported task reference schema');
  }
  // Keep every legacy row protective, including terminal rows: missing metadata
  // is not evidence that a directory can be deleted. No other owner's DB is migrated.
  const status = hasRemote ? 'status' : 'NULL';
  return `SELECT id, ${status} AS status, ${hasSource ? 'source' : 'NULL'} AS source, `
    + `working_dir AS workingDir, ${hasWorktree ? 'worktree_path' : 'NULL'} AS worktreePath `
    + `FROM sessions${hasRemote ? ' WHERE remote_host_id IS NULL' : ''}`;
}

/**
 * Read every known legacy task database through short-lived read-only handles.
 * No migrations, pragmas that write, or owner switching. Any unreadable source
 * invalidates the entire view, rather than turning its tasks into apparent orphans.
 */
export function readLocalWorktreeReferences(
  current: Database.Database,
  DatabaseCtor: DatabaseConstructor,
  nativeBinding?: string,
): LocalWorktreeReference[] {
  const location = current.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>;
  const databasePath = location.find((entry) => entry.name === 'main')?.file;
  if (!databasePath || !path.isAbsolute(databasePath)) throw new Error('task database path unavailable');
  const currentPath = path.resolve(databasePath);
  const root = path.dirname(currentPath);
  if (fs.existsSync(path.join(root, 'profiles')) && fs.readdirSync(path.join(root, 'profiles')).length) {
    throw new Error('profile database catalog requires a compatible reader');
  }
  const names = fs.readdirSync(root).filter((name) => /^(?:cindy|xdt)-.+\.db$/.test(name));
  if (!names.includes(path.basename(currentPath))) throw new Error('unknown task database layout');
  const rows: LocalWorktreeReference[] = [];
  for (const name of names) {
    const file = path.join(root, name);
    if (!fs.lstatSync(file).isFile()) throw new Error('task database is not a regular file');
    const isCurrent = file === currentPath;
    let db: Database.Database | undefined;
    try {
      db = isCurrent ? current : new DatabaseCtor(file, {
        readonly: true, fileMustExist: true, ...(nativeBinding ? { nativeBinding } : {}),
      });
      // Inspect columns and rows in one read snapshot if another instance upgrades the DB.
      const source = db;
      const references = source.transaction(() => source.prepare(referenceQuery(source)).all())() as Omit<LocalWorktreeReference, 'currentDatabase'>[];
      rows.push(...references.map((row) => ({ ...row, currentDatabase: isCurrent })));
    } catch (error) {
      // A failed catalog scan remains fail-closed, but a different owner's
      // damaged read-only source does not quarantine this client's connection.
      if (!isCurrent && isSqliteCorruption(error)) {
        throw Object.assign(new Error('Task reference source is corrupt'), { code: 'DB_REFERENCE_SOURCE_CORRUPT', cause: error });
      }
      throw error;
    } finally {
      if (!isCurrent) db?.close();
    }
  }
  // A source created during the scan has not been checked yet.
  const after = fs.readdirSync(root).filter((name) => /^(?:cindy|xdt)-.+\.db$/.test(name));
  if (after.length !== names.length || after.some((name) => !names.includes(name))) {
    throw new Error('task database catalog changed during scan');
  }
  return rows;
}
