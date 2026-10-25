import type Database from 'better-sqlite3';

import { normalizeSqlArgs } from './query.js';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export function exec(db: Database.Database, args: unknown): RunResult {
  const { sql, params } = normalizeSqlArgs(args);
  const info = db.prepare(sql).run(...params);
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}
