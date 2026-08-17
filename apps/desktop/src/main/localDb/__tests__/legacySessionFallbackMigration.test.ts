import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Migration companion scripts intentionally use CommonJS so the runtime loader can replay them.
const { default: migration0079 } = (await import(
  '../../../../drizzle/scripts/0079_futuristic_hercules'
)) as { default: { run(db: Database.Database): void } };

describe('0079 legacy scheduler session fallback boundary', () => {
  it('marks existing schedules compatible while new schedules keep the isolated default', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          workspace_kind TEXT NOT NULL,
          working_dir TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          source TEXT NOT NULL,
          workspace_kind TEXT NOT NULL,
          working_dir TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO schedules (id, name, workspace_kind, working_dir, created_at)
        VALUES ('existing', 'Weekly summary', 'project', '/repo', 100);
        INSERT INTO sessions (id, title, source, workspace_kind, working_dir, created_at)
        VALUES ('existing-session', '[Schedule] Weekly summary', 'scheduler', 'project', '/repo', 101);
      `);

      migration0079.run(db);
      expect(
        db
          .prepare('SELECT legacy_session_fallback FROM schedules WHERE id = ?')
          .pluck()
          .get('existing'),
      ).toBe(1);

      db.prepare(`
        INSERT INTO schedules (id, name, workspace_kind, working_dir, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run('new', 'Weekly summary', 'project', '/repo', 200);
      // Companion scripts may be invoked directly while diagnosing migration state; reruns must
      // not grant legacy compatibility to schedules created after the original migration.
      migration0079.run(db);
      expect(
        db
          .prepare('SELECT legacy_session_fallback FROM schedules WHERE id = ?')
          .pluck()
          .get('new'),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('does not grant fallback to a recreated schedule when retained sessions predate it', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          workspace_kind TEXT NOT NULL,
          working_dir TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          source TEXT NOT NULL,
          workspace_kind TEXT NOT NULL,
          working_dir TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO schedules (id, name, workspace_kind, working_dir, created_at)
        VALUES ('replacement', 'Weekly summary', 'project', '/repo', 200);
        INSERT INTO sessions (id, title, source, workspace_kind, working_dir, created_at)
        VALUES ('retained-old', '[Schedule] Weekly summary', 'scheduler', 'project', '/repo', 100);
      `);

      migration0079.run(db);

      expect(
        db
          .prepare('SELECT legacy_session_fallback FROM schedules WHERE id = ?')
          .pluck()
          .get('replacement'),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('uses the title and timestamp guard for legacy schemas without workspace columns', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE schedules (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO schedules (id, name, created_at)
        VALUES ('legacy-replacement', 'Weekly summary', 200);
        INSERT INTO sessions (id, title, source, created_at)
        VALUES ('legacy-retained-old', '[Schedule] Weekly summary', 'scheduler', 100);
      `);

      migration0079.run(db);

      expect(
        db
          .prepare('SELECT legacy_session_fallback FROM schedules WHERE id = ?')
          .pluck()
          .get('legacy-replacement'),
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it('is a no-op for partial legacy replay databases without schedules', () => {
    const db = new Database(':memory:');
    try {
      expect(() => migration0079.run(db)).not.toThrow();
    } finally {
      db.close();
    }
  });
});
