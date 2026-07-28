import type Database from 'better-sqlite3';

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName) !== undefined
  );
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'schedules')) return;
  const columns = new Set(tableColumnNames(db, 'schedules'));
  if (!columns.has('active_claim_fired_at')) {
    db.exec('ALTER TABLE schedules ADD COLUMN active_claim_fired_at integer');
  }
}

module.exports = { run };
