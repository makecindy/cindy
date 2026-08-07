import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
      .get(tableName),
  );
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'schedules')) return;
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS uniq_schedules_origin ON schedules(origin_kind, origin_id)',
  );
}

module.exports = { run };
