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
  const hasSchedules = tableExists(db, 'schedules');
  if (hasSchedules && !tableColumnNames(db, 'schedules').has('session_title_template')) {
    db.exec('ALTER TABLE `schedules` ADD `session_title_template` text');
  }

  const hasScheduleRuns = tableExists(db, 'schedule_runs');
  const runColumns = hasScheduleRuns ? tableColumnNames(db, 'schedule_runs') : new Set<string>();
  if (runColumns.has('session_id') && runColumns.has('schedule_id')) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS `idx_schedule_runs_session_schedule` ' +
        'ON `schedule_runs` (`session_id`, `schedule_id`)',
    );
  }

  if (
    !hasSchedules ||
    !tableExists(db, 'sessions') ||
    !runColumns.has('schedule_id') ||
    !runColumns.has('session_id') ||
    !runColumns.has('fired_at')
  ) {
    return;
  }

  if (!tableExists(db, 'schedule_session_bindings')) {
    db.exec(`
      CREATE TABLE schedule_session_bindings (
        schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        last_run_at INTEGER NOT NULL,
        PRIMARY KEY (schedule_id, session_id)
      )
    `);
  }

  const bindingColumns = tableColumnNames(db, 'schedule_session_bindings');
  if (
    !bindingColumns.has('schedule_id') ||
    !bindingColumns.has('session_id') ||
    !bindingColumns.has('last_run_at')
  ) {
    return;
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_schedule_session_bindings_session_schedule
    ON schedule_session_bindings (session_id, schedule_id);

    INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
    SELECT run.schedule_id, run.session_id, MAX(run.fired_at)
    FROM schedule_runs AS run
    INNER JOIN schedules AS schedule_row ON schedule_row.id = run.schedule_id
    INNER JOIN sessions AS session_row ON session_row.id = run.session_id
    WHERE run.session_id IS NOT NULL AND run.fired_at IS NOT NULL
    GROUP BY run.schedule_id, run.session_id
    ON CONFLICT(schedule_id, session_id) DO UPDATE SET
      last_run_at = MAX(schedule_session_bindings.last_run_at, excluded.last_run_at);

    CREATE TRIGGER IF NOT EXISTS schedule_runs_bind_session_after_insert
    AFTER INSERT ON schedule_runs
    WHEN NEW.session_id IS NOT NULL
      AND NEW.fired_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM schedules WHERE id = NEW.schedule_id)
      AND EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id)
    BEGIN
      INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
      VALUES (NEW.schedule_id, NEW.session_id, NEW.fired_at)
      ON CONFLICT(schedule_id, session_id) DO UPDATE SET
        last_run_at = MAX(schedule_session_bindings.last_run_at, excluded.last_run_at);
    END;

    CREATE TRIGGER IF NOT EXISTS schedule_runs_bind_session_after_update
    AFTER UPDATE OF schedule_id, session_id, fired_at ON schedule_runs
    WHEN NEW.session_id IS NOT NULL
      AND NEW.fired_at IS NOT NULL
      AND EXISTS (SELECT 1 FROM schedules WHERE id = NEW.schedule_id)
      AND EXISTS (SELECT 1 FROM sessions WHERE id = NEW.session_id)
    BEGIN
      INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
      VALUES (NEW.schedule_id, NEW.session_id, NEW.fired_at)
      ON CONFLICT(schedule_id, session_id) DO UPDATE SET
        last_run_at = MAX(schedule_session_bindings.last_run_at, excluded.last_run_at);
    END;
  `);
}

module.exports = { run };
