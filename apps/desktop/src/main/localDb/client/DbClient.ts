import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { createLogger } from '../../logger.js';
import { ensureReady, getDrizzle, getRawDb } from '../index.js';
import type * as schema from '../schema.js';
import { isSqliteVecAvailable } from '../sqliteVecLoader.js';
import { DbErrorBoundary } from './DbErrorBoundary.js';
import type { DbTransport } from './DbTransport.js';
import { UtilityProcessTransport } from './UtilityProcessTransport.js';
import { WorkerThreadTransport } from './WorkerThreadTransport.js';
import { createDrizzleProxy } from './drizzleProxy.js';
import type { DbTxArgsByName, DbTxName, DbTxResultByName } from './tx/types.js';
import { tx as runInprocTx } from '../worker/opHandlers/tx.js';

export interface DbClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | undefined>;
  exec(
    sql: string,
    params?: unknown[],
  ): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
  tx<N extends DbTxName>(
    name: N,
    args: DbTxArgsByName[N],
    transferList?: unknown[],
  ): Promise<DbTxResultByName[N]>;
  tx<R = unknown>(name: string, args: unknown, transferList?: unknown[]): Promise<R>;
  drizzle: BetterSQLite3Database<typeof schema>;
  readonly vecAvailable: boolean;
  dispose(): Promise<void>;
}

export type DbTransportKind = 'worker-thread' | 'utility-process';

export interface CreateDbClientOptions {
  transport?: DbTransportKind;
  userId?: string;
  dbPath?: string;
  drizzleDir?: string;
  sqliteVecExtPath?: string;
  nativeBinding?: string;
  betterSqliteModulePath?: string;
  workerScriptPath?: string;
  useInlineWorker?: boolean;
}

export async function createDbClient(opts: CreateDbClientOptions = {}): Promise<DbClient> {
  if (process.env.XDT_DB_INPROC === 'true') {
    return createInprocDbClient(opts);
  }

  const kind = resolveTransportKind(opts.transport);
  let transport = createTransport(kind, opts);
  const boundary = new DbErrorBoundary();
  let disposed = false;
  let unavailableError: Error | null = null;
  const bindTransportEvents = (): void => {
    if (kind === 'utility-process') return;
    transport.on('log', (event) => {
      const logger = createLogger(event.scope || 'DbClient');
      logger[event.level]('[DbClient] worker event', event.payload);
    });
  };
  bindTransportEvents();

  const rebindTerminationHandler = (): void => {
    if (kind === 'utility-process') return;
    transport.onTerminated((info) => {
      if (disposed) return;
      const { shouldRestart } = boundary.onWorkerTerminated(info);
      if (shouldRestart && kind === 'worker-thread') {
        transport = createTransport(kind, opts);
        bindTransportEvents();
        rebindTerminationHandler();
      } else {
        unavailableError = new Error('db worker terminated and auto-restart is exhausted');
      }
    });
  };
  rebindTerminationHandler();

  const client: DbClient = {
    query: (sql, params) =>
      withTransport('query', () => transport.send('query', { sql, params: params ?? [] })),
    queryOne: (sql, params) =>
      withTransport('queryOne', () => transport.send('queryOne', { sql, params: params ?? [] })),
    exec: (sql, params) =>
      withTransport('exec', () => transport.send('exec', { sql, params: params ?? [] })),
    tx: (name: string, args: unknown, transferList?: unknown[]) =>
      withTransport('tx', () => transport.send('tx', { name, args }, transferList)),
    drizzle: createDrizzleProxy(() => transport) as BetterSQLite3Database<typeof schema>,
    get vecAvailable() {
      return (transport as DbTransport & { isVecAvailable?: boolean }).isVecAvailable ?? false;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await boundary.wrap('dispose', () => transport.close());
    },
  };

  async function withTransport<T>(opName: string, fn: () => Promise<T>): Promise<T> {
    if (unavailableError) throw unavailableError;
    return boundary.wrap(opName, fn);
  }

  return client;
}

export async function createInprocDbClient(opts: CreateDbClientOptions = {}): Promise<DbClient> {
  if (opts.userId) {
    const ready = await ensureReady(opts.userId);
    if (!ready.ready) {
      throw new Error(`inproc localDb ensureReady failed: ${ready.error.code}: ${ready.error.message}`);
    }
  }

  return {
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

function resolveTransportKind(explicit?: DbTransportKind): DbTransportKind {
  if (explicit === 'utility-process' || (!explicit && process.env.XDT_DB_TRANSPORT === 'utility-process')) {
    const log = createLogger('DbClient');
    log.warn('utility-process transport not implemented; falling back to worker-thread');
    return 'worker-thread';
  }
  if (explicit) return explicit;
  return 'worker-thread';
}

function createTransport(kind: DbTransportKind, opts: CreateDbClientOptions): DbTransport {
  if (kind === 'utility-process') {
    return new UtilityProcessTransport({ userId: opts.userId });
  }
  return new WorkerThreadTransport({
    userId: opts.userId,
    dbPath: opts.dbPath,
    drizzleDir: opts.drizzleDir,
    sqliteVecExtPath: opts.sqliteVecExtPath,
    nativeBinding: opts.nativeBinding,
    betterSqliteModulePath: opts.betterSqliteModulePath,
    workerScriptPath: opts.workerScriptPath,
    useInlineWorker: opts.useInlineWorker,
  });
}
