import type Database from 'better-sqlite3';

export interface SqlArgs {
  sql: string;
  params: unknown[];
}

export function normalizeSqlArgs(args: unknown): SqlArgs {
  if (!args || typeof args !== 'object') {
    throw Object.assign(new Error('sql args must be an object'), { code: 'INVALID_ARGS' });
  }
  const { sql, params } = args as SqlArgs;
  if (typeof sql !== 'string' || sql.length === 0) {
    throw Object.assign(new Error('sql must be a non-empty string'), { code: 'INVALID_ARGS' });
  }
  return { sql, params: Array.isArray(params) ? params : [] };
}

export function query(db: Database.Database, args: unknown): unknown[] {
  const { sql, params } = normalizeSqlArgs(args);
  return db.prepare(sql).all(...params);
}

export function queryOne(db: Database.Database, args: unknown): unknown | undefined {
  const { sql, params } = normalizeSqlArgs(args);
  return db.prepare(sql).get(...params);
}
