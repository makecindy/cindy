import type Database from 'better-sqlite3';

/**
 * 0093 — 幂等添加 sessions.search_mode_enabled。
 *
 * SQLite 的 ALTER TABLE ADD COLUMN 不能安全重放,所以 SQL 文件只保留占位语句,
 * 这里用 PRAGMA table_info 守卫加列。
 */
function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const sessionColumns = new Set(tableColumnNames(db, 'sessions'));
  if (!sessionColumns.has('search_mode_enabled')) {
    db.exec('ALTER TABLE sessions ADD COLUMN search_mode_enabled integer DEFAULT false NOT NULL');
  }
}

module.exports = { run };
