function tableHasColumns(db, name, requiredColumns) {
  const table = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  if (!table) return false;
  const columns = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
  return requiredColumns.every((column) => columns.has(column));
}

function run(db) {
  if (tableHasColumns(db, 'messages', ['session_id', 'created_at', 'role', 'rewind_at'])) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_active_error_tail
        ON messages (session_id, created_at)
        WHERE role = 'error' AND rewind_at IS NULL;
    `);
  }

  if (
    tableHasColumns(db, 'schedule_runs', [
      'id',
      'schedule_id',
      'session_id',
      'fired_at',
      'status',
      'read_at',
      'heartbeat_at',
    ])
  ) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_running_schedule
        ON schedule_runs (schedule_id) WHERE status = 'running';
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_running_heartbeat
        ON schedule_runs (heartbeat_at)
        WHERE status = 'running' AND heartbeat_at IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_running_legacy
        ON schedule_runs (fired_at)
        WHERE status = 'running' AND heartbeat_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_unread_terminal
        ON schedule_runs (schedule_id, status, fired_at)
        WHERE read_at IS NULL
          AND status IN ('success', 'failed', 'aborted', 'interrupted');
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_session_latest
        ON schedule_runs (session_id, fired_at, id) WHERE session_id IS NOT NULL;
    `);
  }

  if (
    tableHasColumns(db, 'sessions', ['id']) &&
    tableHasColumns(db, 'schedule_runs', ['id', 'session_id', 'fired_at'])
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schedule_session_latest_runs (
        session_id text PRIMARY KEY NOT NULL,
        run_id text NOT NULL,
        fired_at integer NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON UPDATE no action ON DELETE cascade,
        FOREIGN KEY (run_id) REFERENCES schedule_runs(id) ON UPDATE no action ON DELETE cascade
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_session_latest_runs_run
        ON schedule_session_latest_runs (run_id);
    `);
  }

  if (
    !tableHasColumns(db, 'schedule_runs', ['id', 'session_id', 'fired_at']) ||
    !tableHasColumns(db, 'schedule_session_latest_runs', ['session_id', 'run_id', 'fired_at'])
  ) {
    return;
  }

  db.exec(`
    DELETE FROM schedule_session_latest_runs;
    INSERT INTO schedule_session_latest_runs (session_id, run_id, fired_at)
    SELECT session_id, id, fired_at
    FROM (
      SELECT session_id, id, fired_at,
        ROW_NUMBER() OVER (
          PARTITION BY session_id
          ORDER BY fired_at DESC, id DESC
        ) AS position
      FROM schedule_runs
      WHERE session_id IS NOT NULL
    )
    WHERE position = 1;

    CREATE TRIGGER IF NOT EXISTS schedule_session_latest_run_insert
    AFTER INSERT ON schedule_runs
    WHEN NEW.session_id IS NOT NULL
    BEGIN
      INSERT INTO schedule_session_latest_runs (session_id, run_id, fired_at)
      VALUES (NEW.session_id, NEW.id, NEW.fired_at)
      ON CONFLICT(session_id) DO UPDATE SET
        run_id = excluded.run_id,
        fired_at = excluded.fired_at
      WHERE excluded.fired_at > schedule_session_latest_runs.fired_at
        OR (excluded.fired_at = schedule_session_latest_runs.fired_at
          AND excluded.run_id > schedule_session_latest_runs.run_id);
    END;

    CREATE TRIGGER IF NOT EXISTS schedule_session_latest_run_delete
    AFTER DELETE ON schedule_runs
    WHEN OLD.session_id IS NOT NULL
    BEGIN
      DELETE FROM schedule_session_latest_runs
      WHERE session_id = OLD.session_id AND run_id = OLD.id;
      INSERT INTO schedule_session_latest_runs (session_id, run_id, fired_at)
      SELECT OLD.session_id, id, fired_at
      FROM schedule_runs
      WHERE session_id = OLD.session_id
      ORDER BY fired_at DESC, id DESC
      LIMIT 1
      ON CONFLICT(session_id) DO UPDATE SET
        run_id = excluded.run_id,
        fired_at = excluded.fired_at;
    END;

    CREATE TRIGGER IF NOT EXISTS schedule_session_latest_run_update
    AFTER UPDATE OF session_id, fired_at ON schedule_runs
    BEGIN
      DELETE FROM schedule_session_latest_runs
      WHERE session_id = OLD.session_id AND run_id = OLD.id;
      INSERT INTO schedule_session_latest_runs (session_id, run_id, fired_at)
      SELECT OLD.session_id, id, fired_at
      FROM schedule_runs
      WHERE OLD.session_id IS NOT NULL AND session_id = OLD.session_id
      ORDER BY fired_at DESC, id DESC
      LIMIT 1
      ON CONFLICT(session_id) DO UPDATE SET
        run_id = excluded.run_id,
        fired_at = excluded.fired_at;
      INSERT INTO schedule_session_latest_runs (session_id, run_id, fired_at)
      SELECT NEW.session_id, NEW.id, NEW.fired_at
      WHERE NEW.session_id IS NOT NULL
      ON CONFLICT(session_id) DO UPDATE SET
        run_id = excluded.run_id,
        fired_at = excluded.fired_at
      WHERE excluded.fired_at > schedule_session_latest_runs.fired_at
        OR (excluded.fired_at = schedule_session_latest_runs.fired_at
          AND excluded.run_id > schedule_session_latest_runs.run_id);
    END;
  `);
}

module.exports = { run };
