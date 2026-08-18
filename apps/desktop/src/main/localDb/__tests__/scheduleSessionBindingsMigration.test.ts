import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const { default: migration0094 } = (await import(
  '../../../../drizzle/scripts/0094_add_schedule_session_bindings'
)) as { default: { run(db: Database.Database): void } };

describe('0094 schedule-session bindings migration', () => {
  it('backfills the newest run, remains idempotent, and keeps trigger writes monotonic', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        CREATE TABLE schedules (id TEXT PRIMARY KEY);
        CREATE TABLE schedule_runs (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
          session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
          fired_at INTEGER NOT NULL
        );
        CREATE TABLE schedule_session_bindings (
          schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          last_run_at INTEGER NOT NULL,
          PRIMARY KEY (schedule_id, session_id)
        );
        INSERT INTO schedules (id) VALUES ('schedule-1');
        INSERT INTO sessions (id) VALUES ('session-a'), ('session-b');
        INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at) VALUES
          ('run-old', 'schedule-1', 'session-a', 100),
          ('run-new', 'schedule-1', 'session-a', 300),
          ('run-unbound', 'schedule-1', NULL, 400);
        INSERT INTO schedule_session_bindings (schedule_id, session_id, last_run_at)
        VALUES ('schedule-1', 'session-a', 250);
      `);

      migration0094.run(db);
      migration0094.run(db);

      expect(
        db.prepare(
          'SELECT schedule_id, session_id, last_run_at FROM schedule_session_bindings ORDER BY session_id',
        ).all(),
      ).toEqual([{ schedule_id: 'schedule-1', session_id: 'session-a', last_run_at: 300 }]);

      db.prepare('UPDATE schedule_runs SET session_id = ? WHERE id = ?').run(
        'session-b',
        'run-unbound',
      );
      db.prepare(
        'INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at) VALUES (?, ?, ?, ?)',
      ).run('run-older-still', 'schedule-1', 'session-a', 50);

      expect(
        db.prepare(
          'SELECT schedule_id, session_id, last_run_at FROM schedule_session_bindings ORDER BY session_id',
        ).all(),
      ).toEqual([
        { schedule_id: 'schedule-1', session_id: 'session-a', last_run_at: 300 },
        { schedule_id: 'schedule-1', session_id: 'session-b', last_run_at: 400 },
      ]);

      db.exec('DELETE FROM schedule_runs');
      expect(db.prepare('SELECT COUNT(*) FROM schedule_session_bindings').pluck().get()).toBe(2);

      db.prepare('DELETE FROM sessions WHERE id = ?').run('session-a');
      expect(
        db.prepare('SELECT session_id FROM schedule_session_bindings').pluck().all(),
      ).toEqual(['session-b']);

      db.prepare('DELETE FROM schedules WHERE id = ?').run('schedule-1');
      expect(db.prepare('SELECT COUNT(*) FROM schedule_session_bindings').pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });
});
