import type Database from 'better-sqlite3';

function columnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function run(db: Database.Database): void {
  const existing = columnNames(db, 'sessions');
  if (existing.size === 0 || existing.has('created_by_session')) return;
  db.exec('ALTER TABLE `sessions` ADD `created_by_session` text');
}

module.exports = { run };
