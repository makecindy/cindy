import type Database from 'better-sqlite3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .some((row) => String((row as { name: unknown }).name) === column);
}

function run(db: Database.Database): void {
  if (!hasColumn(db, 'sessions', 'context_window_budget')) {
    db.exec('ALTER TABLE `sessions` ADD `context_window_budget` integer');
  }
}

module.exports = { run };
