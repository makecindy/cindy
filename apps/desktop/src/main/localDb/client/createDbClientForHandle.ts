/**
 * Build a `DbClient` over an already-open better-sqlite3 handle.
 *
 * The Desktop entry owns its module-level connection; a Node host owns its own.
 * Both wrap the identical transaction handlers, so callers see one storage
 * contract regardless of which process opened the database. Electron is not
 * imported here on purpose.
 */

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DbErrorBoundary } from './DbErrorBoundary.js';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';

import * as schema from '../schema.js';
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
  onCorruption?: (error: Error) => void;
}

export function createDbClientForHandle(deps: DbHandleClientDeps): DbClient {
  let disposed = false;
  const boundary = new DbErrorBoundary({ onCorruption: deps.onCorruption });
  const guarded = new WeakMap<object, object>();
  const run = <T>(fn: () => T): T => {
    if (disposed) throw new Error('DbClient is disposed');
    boundary.assertAvailable();
    try { return fn(); } catch (error) { boundary.observeError(error); throw error; }
  };
  // Guard the connection and prepared statements, not just the public query
  // wrappers. Native Drizzle transactions can catch an error inside a callback;
  // the very next statement must already be blocked in that same callback.
  function guard<T extends object>(value: T): T {
    const existing = guarded.get(value);
    if (existing) return existing as T;
    // A facade target avoids violating native read-only property invariants
    // (better-sqlite3's transaction variants are non-configurable properties).
    const facade = typeof value === 'function' ? function () {} : Object.create(Object.getPrototypeOf(value));
    const proxy = new Proxy(facade, {
      get(_target, prop) {
        const member = Reflect.get(value, prop, value);
        if (prop === 'database' && member && typeof member === 'object') return guard(member);
        if (typeof member !== 'function') return member;
        if (typeof value === 'function') return guard(member);
        return (...args: unknown[]) => run(() => {
          if (prop === 'transaction' && typeof args[0] === 'function') {
            const callback = args[0] as (...values: unknown[]) => unknown;
            args = [(...values: unknown[]) => {
              const result = callback(...values);
              // A swallowed corruption must roll back, never commit a
              // partially executed transaction. Native rollback is cleanup.
              boundary.assertAvailable();
              return result;
            }, ...args.slice(1)];
          }
          const result = Reflect.apply(member, value, args);
          return result === value || prop === 'prepare' || prop === 'transaction' || prop === 'iterate'
            ? guard(result) : result;
        });
      },
      apply(_target, receiver, args) {
        return run(() => Reflect.apply(value as unknown as (...args: unknown[]) => unknown, receiver, args));
      },
    }) as T;
    guarded.set(value, proxy);
    return proxy;
  }
  let guardedDrizzle: BetterSQLite3Database<typeof schema> | undefined;
  return {
    readLocalWorktreeReferences: async (): Promise<LocalWorktreeReference[]> =>
      run(() => readLocalWorktreeReferences(guard(deps.db), Database, deps.nativeBinding)),
    query: async <T = unknown>(sql: string, params: unknown[] = []) =>
      run(() => guard(deps.db).prepare(sql).all(...params) as T[]),
    queryOne: async <T = unknown>(sql: string, params: unknown[] = []) =>
      run(() => guard(deps.db).prepare(sql).get(...params) as T | undefined),
    exec: async (sql: string, params: unknown[] = []) => run(() => guard(deps.db).prepare(sql).run(...params)),
    tx: (async (name: string, args: unknown) =>
      run(() => runInprocTx(guard(deps.db), { name, args }))) as DbClient['tx'],
    get drizzle() {
      // Preserve native synchronous Drizzle semantics while sharing the same
      // connection and isolation boundary as RPC/transaction consumers.
      guardedDrizzle ??= drizzle(guard(deps.db), { schema });
      return guardedDrizzle;
    },
    observeCorruption: (error: Error) => boundary.observeError(error),
    get corruptionError() { return boundary.failure; },
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
