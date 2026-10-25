import Database from 'better-sqlite3';
import { createLogger } from '../../logger.js';
import { ensureReady, getDrizzle, getRawDb } from '../index.js';
import { isSqliteVecAvailable } from '../sqliteVecLoader.js';
import { DbErrorBoundary } from './DbErrorBoundary.js';
import type { DbTransport } from './DbTransport.js';
import { UtilityProcessTransport } from './UtilityProcessTransport.js';
import { WorkerThreadTransport } from './WorkerThreadTransport.js';
import { tx as runInprocTx } from '../worker/opHandlers/tx.js';
import { readLocalWorktreeReferences } from '../worker/worktreeReferences.js';
import { createDbClientFactory, type DbClient, type CreateDbClientOptions, type DbTransportKind } from '@cindy/runtime-db';
export type { DbClient, CreateDbClientOptions, DbTransportKind } from '@cindy/runtime-db';

export const createDbClient = createDbClientFactory({
  createLogger,
  createInprocClient: createInprocDbClient,
  createTransport,
  createErrorBoundary: () => new DbErrorBoundary(),
});

export async function createInprocDbClient(opts: CreateDbClientOptions = {}): Promise<DbClient> {
  if (opts.userId) {
    const ready = await ensureReady(opts.userId);
    if (!ready.ready) {
      throw new Error(`inproc localDb ensureReady failed: ${ready.error.code}: ${ready.error.message}`);
    }
  }

  return {
    readLocalWorktreeReferences: async () =>
      readLocalWorktreeReferences(getRawDb(), Database, opts.nativeBinding, opts.appDataRoot),
    query: async <T = unknown>(sql: string, params: unknown[] = []) =>
      getRawDb().prepare(sql).all(...params) as T[],
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
      getRawDb().prepare(sql).get(...params) as T | undefined,
    exec: async (sql, params = []) => getRawDb().prepare(sql).run(...params),
    tx: async (name: string, args: unknown) =>
      runInprocTx(getRawDb(), { name, args }) as never,
    get drizzle() {
      return getDrizzle();
    },
    get vecAvailable() {
      return isSqliteVecAvailable();
    },
    dispose: async () => {
      // The legacy in-proc handle is owned by the existing localDb lifecycle.
    },
  };
}

function createTransport(kind: DbTransportKind, opts: CreateDbClientOptions): DbTransport {
  if (kind === 'utility-process') {
    return new UtilityProcessTransport({ userId: opts.userId });
  }
  return new WorkerThreadTransport({
    userId: opts.userId,
    dbPath: opts.dbPath,
    appDataRoot: opts.appDataRoot,
    drizzleDir: opts.drizzleDir,
    sqliteVecExtPath: opts.sqliteVecExtPath,
    nativeBinding: opts.nativeBinding,
    betterSqliteModulePath: opts.betterSqliteModulePath,
    workerScriptPath: opts.workerScriptPath,
    useInlineWorker: opts.useInlineWorker,
  });
}
