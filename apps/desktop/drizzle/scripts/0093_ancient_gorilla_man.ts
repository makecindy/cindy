import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db
    .prepare(`PRAGMA table_info('schedule_runs')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
  if (!columns.includes('sdk_estimated_value_amount')) {
    db.exec(
      'ALTER TABLE schedule_runs ADD COLUMN sdk_estimated_value_amount real DEFAULT 0 NOT NULL',
    );
  }
}

module.exports = { run };
