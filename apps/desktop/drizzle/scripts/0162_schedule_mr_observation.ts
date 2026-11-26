import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(schedule_runs)').all() as Array<{ name: string }>;
  if (!columns.length) return;
  const names = new Set(columns.map(column => column.name));
  if (!names.has('mr_observation')) db.exec('ALTER TABLE schedule_runs ADD COLUMN mr_observation TEXT');
  if (['schedule_id', 'status', 'fired_at', 'id'].every(name => names.has(name))) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_schedule_runs_mr_observation ON schedule_runs(schedule_id, status, fired_at, id) WHERE mr_observation IS NOT NULL');
  }
}

module.exports = { run };
