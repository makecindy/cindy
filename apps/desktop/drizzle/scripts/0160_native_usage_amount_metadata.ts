import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = (table: string) => db.prepare('SELECT name FROM pragma_table_info(?)').pluck().all(table);
  const sessions = columns('sessions');
  if (sessions.length && !sessions.includes('total_cost_usd_is_approximate')) {
    db.exec('ALTER TABLE sessions ADD total_cost_usd_is_approximate integer DEFAULT false NOT NULL');
  }
  const runs = columns('schedule_runs');
  if (runs.length && !runs.includes('other_estimated_value_amount')) {
    db.exec('ALTER TABLE schedule_runs ADD other_estimated_value_amount real DEFAULT 0 NOT NULL');
  }
}

module.exports = { run };
