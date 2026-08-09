import type Database from 'better-sqlite3';

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function run(db: Database.Database): void {
  const columns = tableColumnNames(db, 'schedules');
  if (columns.size === 0) return;
  if (!columns.has('origin_kind')) {
    db.exec('ALTER TABLE schedules ADD COLUMN origin_kind text');
  }
  if (!columns.has('origin_id')) {
    db.exec('ALTER TABLE schedules ADD COLUMN origin_id text');
  }
}

module.exports = { run };
