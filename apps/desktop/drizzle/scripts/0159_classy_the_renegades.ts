import type Database from 'better-sqlite3';

function tableColumnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function run(db: Database.Database): void {
  const workerColumns = new Set(tableColumnNames(db, 'orca_workers'));
  if (workerColumns.size === 0) return;
  if (!workerColumns.has('latest_report')) {
    db.exec('ALTER TABLE orca_workers ADD COLUMN latest_report text');
  }
}

module.exports = { run };
