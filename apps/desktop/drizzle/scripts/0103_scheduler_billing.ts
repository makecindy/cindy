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
  if (!columns.includes('cost_provider_attribution_version')) {
    db.exec(
      'ALTER TABLE schedule_runs ADD COLUMN cost_provider_attribution_version integer DEFAULT 1 NOT NULL',
    );
  }
  // Rows that predate provider attribution must fail closed to the legacy path.
  db.exec('UPDATE schedule_runs SET cost_provider_attribution_version = 0');
}

module.exports = { run };
