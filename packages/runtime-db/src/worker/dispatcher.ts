import type Database from 'better-sqlite3';

import { closeDb } from './opHandlers/closeDb.js';
import { exec } from './opHandlers/exec.js';
import { query, queryOne } from './opHandlers/query.js';
import { rawAll } from './opHandlers/rawAll.js';
import { rawGet } from './opHandlers/rawGet.js';
import { run } from './opHandlers/run.js';
import { tx } from './opHandlers/tx.js';

export async function dispatch(
  op: string,
  args: unknown,
  db: Database.Database,
): Promise<unknown> {
  switch (op) {
    case 'query':
      return query(db, args);
    case 'queryOne':
      return queryOne(db, args);
    case 'exec':
      return exec(db, args);
    case 'rawAll':
      return rawAll(db, args);
    case 'rawGet':
      return rawGet(db, args);
    case 'run':
      return run(db, args);
    case 'tx':
      return tx(db, args);
    case 'closeDb':
      return closeDb(db);
    default:
      throw Object.assign(new Error(`unknown op: ${op}`), { code: 'UNKNOWN_OP' });
  }
}

export function serializeWorkerError(err: unknown): {
  code: string;
  message: string;
  stack?: string;
} {
  return {
    code:
      err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'WORKER_RPC_ERROR',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
}
