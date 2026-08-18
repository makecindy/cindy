import type Database from 'better-sqlite3';

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

function tableColumnNames(db: Database.Database, tableName: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info('${tableName}')`)
      .all()
      .map((row) => String((row as { name: unknown }).name)),
  );
}

function run(db: Database.Database): void {
  if (!tableExists(db, 'schedules') || !tableExists(db, 'sessions')) return;
  const runColumns = tableColumnNames(db, 'schedule_runs');
  if (
    !runColumns.has('schedule_id')
    || !runColumns.has('session_id')
    || !runColumns.has('fired_at')
  ) {
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_session_bindings (
      schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      last_run_at INTEGER NOT NULL,
      PRIMARY KEY (schedule_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_schedule_session_bindings_session_schedule
    ON schedule_session_bindings (session_id, schedule_id);

    INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
    SELECT schedule_id, session_id, MAX(fired_at)
    FROM schedule_runs
    WHERE session_id IS NOT NULL
    GROUP BY schedule_id, session_id
    ON CONFLICT(schedule_id, session_id) DO UPDATE SET
      last_run_at = MAX(schedule_session_bindings.last_run_at, excluded.last_run_at);

    CREATE TRIGGER IF NOT EXISTS schedule_runs_bind_session_after_insert
    AFTER INSERT ON schedule_runs
    WHEN NEW.session_id IS NOT NULL
    BEGIN
      INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
      VALUES (NEW.schedule_id, NEW.session_id, NEW.fired_at)
      ON CONFLICT(schedule_id, session_id) DO UPDATE SET
        last_run_at = MAX(schedule_session_bindings.last_run_at, excluded.last_run_at);
    END;

    CREATE TRIGGER IF NOT EXISTS schedule_runs_bind_session_after_update
    AFTER UPDATE OF schedule_id, session_id, fired_at ON schedule_runs
    WHEN NEW.session_id IS NOT NULL
    BEGIN
      INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
      VALUES (NEW.schedule_id, NEW.session_id, NEW.fired_at)
      ON CONFLICT(schedule_id, session_id) DO UPDATE SET
        last_run_at = MAX(schedule_session_bindings.last_run_at, excluded.last_run_at);
    END;
  `);
}

module.exports = { run };
