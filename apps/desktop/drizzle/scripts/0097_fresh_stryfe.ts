import type Database from 'better-sqlite3';

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const columns = new Set(tableColumnNames(db, 'sessions'));
  if (!columns.has('list_preview')) {
    db.exec('ALTER TABLE sessions ADD COLUMN list_preview text');
  }
  if (!columns.has('list_preview_role')) {
    db.exec('ALTER TABLE sessions ADD COLUMN list_preview_role text');
  }
  if (!columns.has('list_message_count')) {
    db.exec('ALTER TABLE sessions ADD COLUMN list_message_count integer');
  }
}

module.exports = { run };
