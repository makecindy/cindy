/**
 * Build a `DbClient` over an already-open better-sqlite3 handle.
 *
 * The Desktop entry owns its module-level connection; a Node host owns its own.
 * Both wrap the identical transaction handlers, so callers see one storage
 * contract regardless of which process opened the database. Electron is not
 * imported here on purpose.
 */

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

import type * as schema from '../schema.js';
import { isSqliteVecAvailable } from '../sqliteVecLoader.js';
import type { DbClient } from './DbClient.js';
import { tx as runInprocTx } from '../worker/opHandlers/tx.js';
import type { LocalWorktreeReference } from '../worker/worktreeReferences.js';
import { readLocalWorktreeReferences } from '../worker/worktreeReferences.js';

export interface DbHandleClientDeps {
  /** The live connection this client speaks through. */
  db: Database.Database;
  drizzle: BetterSQLite3Database<typeof schema>;
  /** Closes the connection when the owner disposes the client. */
  dispose?: () => Promise<void>;
  nativeBinding?: string;
}

export function createDbClientForHandle(deps: DbHandleClientDeps): DbClient {
  let disposed = false;
  return {
    readLocalWorktreeReferences: async (): Promise<LocalWorktreeReference[]> =>
      readLocalWorktreeReferences(deps.db, Database, deps.nativeBinding),
    query: async <T = unknown>(sql: string, params: unknown[] = []) =>
      deps.db.prepare(sql).all(...params) as T[],
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
      deps.db.prepare(sql).get(...params) as T | undefined,
    exec: async (sql: string, params: unknown[] = []) => deps.db.prepare(sql).run(...params),
    tx: (async (name: string, args: unknown) =>
      runInprocTx(deps.db, { name, args })) as DbClient['tx'],
    get drizzle() {
      return deps.drizzle;
    },
    get vecAvailable() {
      return isSqliteVecAvailable();
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await deps.dispose?.();
    },
  };
}
