import { createBetterSqliteDatabase } from '../betterSqliteFactory.js';
import type { CreateDbClientOptions } from './DbClient.js';

/**
 * Minimal main-owned SQLite connection for a process-lifetime coordination lock.
 *
 * This is intentionally not a general DbClient: ordinary runtime data access stays
 * on the async worker transport. The Orca dispatch lease needs one connection whose
 * transaction cannot disappear behind DbClient's transparent worker restart. A zero
 * busy timeout keeps every synchronous main-process call non-blocking; contention is
 * retried asynchronously by the lease coordinator.
 */
export interface IsolatedSqliteClient {
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(
    sql: string,
    params?: unknown[],
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  dispose(): Promise<void>;
}

export async function createIsolatedSqliteClient(
  options: CreateDbClientOptions,
): Promise<IsolatedSqliteClient> {
  if (!options.dbPath) {
    throw new Error('isolated SQLite client requires an explicit dbPath');
  }
  const db = createBetterSqliteDatabase(
    options.dbPath,
    options.nativeBinding ? { nativeBinding: options.nativeBinding } : {},
  );
  db.pragma('busy_timeout = 0');
  let disposed = false;

  const assertOpen = (): void => {
    if (disposed) throw new Error('isolated SQLite client is disposed');
  };

  return {
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) => {
      assertOpen();
      return db.prepare(sql).get(...params) as T | undefined;
    },
    exec: async (sql, params = []) => {
      assertOpen();
      return db.prepare(sql).run(...params);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      db.close();
    },
  };
}
