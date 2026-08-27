import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const { default: migration0098 } = (await import(
  '../../../../drizzle/scripts/0098_schedule_session_title_bindings'
)) as { default: { run(db: Database.Database): void } };

function tableExists(db: Database.Database, tableName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

function indexExists(db: Database.Database, indexName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(indexName),
  );
}

function triggerExists(db: Database.Database, triggerName: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(triggerName),
  );
}

function columnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function bindingRows(
  db: Database.Database,
): Array<{ schedule_id: string; session_id: string; last_run_at: number }> {
  return db
    .prepare(
      'SELECT schedule_id, session_id, last_run_at FROM schedule_session_bindings ORDER BY session_id',
    )
    .all() as Array<{ schedule_id: string; session_id: string; last_run_at: number }>;
}

describe('0098 schedule-session title bindings migration', () => {
  it('is safe on an empty database', () => {
    const db = new Database(':memory:');
    try {
      expect(() => migration0098.run(db)).not.toThrow();
      expect(tableExists(db, 'schedule_session_bindings')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('upgrades the historical scheduler schema and keeps durable bindings monotonic', () => {
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
        INSERT INTO schedules (id) VALUES ('schedule-1');
        INSERT INTO sessions (id) VALUES ('session-a'), ('session-b');
        INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at) VALUES
          ('run-old', 'schedule-1', 'session-a', 100),
          ('run-new', 'schedule-1', 'session-a', 300),
          ('run-unbound', 'schedule-1', NULL, 400);
      `);

      migration0098.run(db);

      expect(columnNames(db, 'schedules')).toContain('session_title_template');
      expect(indexExists(db, 'idx_schedule_runs_session_schedule')).toBe(true);
      expect(tableExists(db, 'schedule_session_bindings')).toBe(true);
      expect(indexExists(db, 'idx_schedule_session_bindings_session_schedule')).toBe(true);
      expect(triggerExists(db, 'schedule_runs_bind_session_after_insert')).toBe(true);
      expect(triggerExists(db, 'schedule_runs_bind_session_after_update')).toBe(true);
      expect(bindingRows(db)).toEqual([
        { schedule_id: 'schedule-1', session_id: 'session-a', last_run_at: 300 },
      ]);

      db.prepare(
        'UPDATE schedule_session_bindings SET last_run_at = ? WHERE schedule_id = ? AND session_id = ?',
      ).run(500, 'schedule-1', 'session-a');
      migration0098.run(db);
      expect(bindingRows(db)).toEqual([
        { schedule_id: 'schedule-1', session_id: 'session-a', last_run_at: 500 },
      ]);

      db.prepare('UPDATE schedule_runs SET session_id = ?, fired_at = ? WHERE id = ?').run(
        'session-b',
        400,
        'run-unbound',
      );
      db.prepare('UPDATE schedule_runs SET fired_at = ? WHERE id = ?').run(600, 'run-new');
      db.prepare(
        'INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at) VALUES (?, ?, ?, ?)',
      ).run('run-older-still', 'schedule-1', 'session-a', 50);

      expect(bindingRows(db)).toEqual([
        { schedule_id: 'schedule-1', session_id: 'session-a', last_run_at: 600 },
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

  it('skips orphaned historical runs during backfill and trigger writes', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    try {
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY);
        CREATE TABLE schedules (id TEXT PRIMARY KEY);
        CREATE TABLE schedule_runs (
          id TEXT PRIMARY KEY,
          schedule_id TEXT,
          session_id TEXT,
          fired_at INTEGER
        );
        INSERT INTO schedules (id) VALUES ('schedule-1');
        INSERT INTO sessions (id) VALUES ('session-a');
        INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at) VALUES
          ('valid', 'schedule-1', 'session-a', 100),
          ('missing-schedule', 'schedule-missing', 'session-a', 200),
          ('missing-session', 'schedule-1', 'session-missing', 300);
      `);

      migration0098.run(db);
      expect(bindingRows(db)).toEqual([
        { schedule_id: 'schedule-1', session_id: 'session-a', last_run_at: 100 },
      ]);

      expect(() => {
        db.prepare(
          'INSERT INTO schedule_runs (id, schedule_id, session_id, fired_at) VALUES (?, ?, ?, ?)',
        ).run('orphan-after-migration', 'schedule-1', 'session-missing', 400);
      }).not.toThrow();
      expect(bindingRows(db)).toEqual([
        { schedule_id: 'schedule-1', session_id: 'session-a', last_run_at: 100 },
      ]);
    } finally {
      db.close();
    }
  });
});
