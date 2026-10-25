import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '../schema.js';
import type { DbLogger } from '../logging.js';
import { DbErrorBoundary } from './DbErrorBoundary.js';
import type { DbTransport } from './DbTransport.js';
import { WorkerThreadTransport } from './WorkerThreadTransport.js';
import { createDrizzleProxy } from './drizzleProxy.js';
import type { DbTxArgsByName, DbTxName, DbTxResultByName } from './tx/types.js';
import type { LocalWorktreeReference } from '../worker/worktreeReferences.js';

export interface DbClient {
  /** Optional only for legacy transports; callers must preserve on absence. */
  readLocalWorktreeReferences?(): Promise<LocalWorktreeReference[]>;
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
  appDataRoot?: string;
  drizzleDir?: string;
  sqliteVecExtPath?: string;
  nativeBinding?: string;
  betterSqliteModulePath?: string;
  workerScriptPath?: string;
  useInlineWorker?: boolean;
}

export interface DbClientHost {
  createLogger(scope: string): DbLogger;
  createInprocClient?: (options: CreateDbClientOptions) => Promise<DbClient>;
  createTransport?: (kind: DbTransportKind, options: CreateDbClientOptions) => DbTransport;
  createErrorBoundary?: () => DbErrorBoundary;
}

/** The Desktop RPC/restart policy, shared by graphical and Node hosts. */
export function createDbClientFactory(host: DbClientHost) {
  const { createLogger } = host;
async function createDbClient(opts: CreateDbClientOptions = {}): Promise<DbClient> {
  if (process.env.XDT_DB_INPROC === 'true') {
    if (!host.createInprocClient) throw new Error('INPROC_DB_UNAVAILABLE');
    return host.createInprocClient(opts);
  }

  const kind = resolveTransportKind(opts.transport);
  let transport = createTransport(kind, opts);
  const boundary = host.createErrorBoundary?.() ?? new DbErrorBoundary({ logger: createLogger('db-worker') });
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
    readLocalWorktreeReferences: () =>
      withTransport('worktreeReferences', () => transport.send('worktreeReferences')),
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
  return host.createTransport?.(kind, opts) ?? new WorkerThreadTransport(opts);
}
  return createDbClient;
}
