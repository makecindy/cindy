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
  const columns = tableColumnNames(db, 'schedule_runs');
  if (!columns.has('session_id') || !columns.has('schedule_id')) return;
  db.exec(
    'CREATE INDEX IF NOT EXISTS `idx_schedule_runs_session_schedule` ' +
      'ON `schedule_runs` (`session_id`, `schedule_id`)',
  );
}

module.exports = { run };
