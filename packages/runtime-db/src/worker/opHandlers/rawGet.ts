import type Database from 'better-sqlite3';

import { normalizeSqlArgs } from './query.js';

export function rawGet(db: Database.Database, args: unknown): unknown[] | undefined {
  const { sql, params } = normalizeSqlArgs(args);
  return db.prepare(sql).raw().get(...params) as unknown[] | undefined;
}
