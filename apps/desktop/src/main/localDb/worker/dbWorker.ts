import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import type Database from 'better-sqlite3';

import type { RpcRequest, RpcResponse, WorkerEvent } from '../client/DbTransport.js';
import { dispatch, serializeWorkerError } from './dispatcher.js';
import { readLocalWorktreeReferences } from './worktreeReferences.js';
import {
  createWorkerDatabase,
  type DatabaseConstructor,
  type DbWorkerRuntimeOptions,
} from './runtime.js';

interface DbWorkerStartupOptions extends DbWorkerRuntimeOptions {
  betterSqliteModulePath?: string;
}

const workerPort = parentPort;
if (!workerPort) throw new Error('db worker must be spawned via worker_threads');
const activeWorkerPort = workerPort;

const moduleRequire = createRequire(import.meta.url);
const startupOptions = (workerData ?? {}) as DbWorkerStartupOptions;
const DatabaseCtor = loadDatabaseConstructor(startupOptions.betterSqliteModulePath);

let db: Database.Database | null = null;
let initError: { code: string; message: string; stack?: string } | null = null;

setDatabase(startupOptions);

activeWorkerPort.on('message', async (req: RpcRequest) => {
  try {
    const result = await dispatchRequest(req);
    activeWorkerPort.postMessage({ id: req.id, ok: true, result } satisfies RpcResponse);
  } catch (err) {
    activeWorkerPort.postMessage({
      id: req.id,
      ok: false,
      error: serializeWorkerError(err),
    } satisfies RpcResponse);
  }
});

function loadDatabaseConstructor(modulePath: string | undefined): DatabaseConstructor {
  const mod = moduleRequire(modulePath || 'better-sqlite3') as
    | DatabaseConstructor
    | { default?: DatabaseConstructor };
  if (typeof mod === 'function') return mod;
  if (typeof mod.default === 'function') return mod.default;
  throw new Error('better-sqlite3 module did not export a Database constructor');
}

function setDatabase(opts: DbWorkerStartupOptions): void {
  try {
    db = createWorkerDatabase(DatabaseCtor, opts, {
      postLog: (payload) => postEvent('log', payload),
      postVecStatus: (payload) => postEvent('vec-status', payload),
    });
    initError = null;
  } catch (err) {
    initError = serializeWorkerError(err);
    db = null;
    postEvent('log', {
      level: 'error',
      scope: 'db-worker',
      payload: {
        event: 'dbWorker.init.failed',
        userId: opts.userId,
        dbPath: opts.dbPath,
        error: initError.message,
        code: initError.code,
      },
    });
  }
}

async function dispatchRequest(req: RpcRequest): Promise<unknown> {
  const readyDb = requireReadyDb();
  if (req.op === 'worktreeReferences') {
    return readLocalWorktreeReferences(readyDb, DatabaseCtor, startupOptions.nativeBinding);
  }
  if (req.op === 'echoTransfer') {
    const { buffer } = (req.args ?? {}) as { buffer?: { byteLength?: number } };
    return { byteLength: typeof buffer?.byteLength === 'number' ? buffer.byteLength : 0 };
  }
  if (req.op === 'sleep') {
    const { ms } = (req.args ?? {}) as { ms?: unknown };
    const durationMs = Number(ms) || 0;
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return { slept: durationMs };
  }
  const result = await dispatch(req.op, req.args, readyDb);
  if (req.op === 'closeDb') {
    db = null;
  }
  return result;
}

function requireReadyDb(): Database.Database {
  if (db) return db;
  const err = new Error(initError ? initError.message : 'db worker is not initialized') as
    Error & { code?: string };
  err.code = initError ? initError.code : 'INIT_FAILED';
  throw err;
}

function postEvent<T extends WorkerEvent['event']>(
  event: T,
  payload: Extract<WorkerEvent, { event: T }>['payload'],
): void {
  activeWorkerPort.postMessage({ event, payload } as WorkerEvent);
}
