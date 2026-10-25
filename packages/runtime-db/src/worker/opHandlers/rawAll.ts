import type Database from 'better-sqlite3';

import { normalizeSqlArgs } from './query.js';

export function rawAll(db: Database.Database, args: unknown): unknown[][] {
  const { sql, params } = normalizeSqlArgs(args);
  return db.prepare(sql).raw().all(...params) as unknown[][];
}
