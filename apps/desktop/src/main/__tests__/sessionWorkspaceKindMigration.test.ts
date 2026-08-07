import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

// Production keeps migration helpers CommonJS; Vitest loads the TS helper through
// its transformer and consumes the CommonJS default export.
const { default: migration } = (await import('../../../drizzle/scripts/0024_ensure_session_workspace_kind')) as {
  default: { run: (db: Database.Database) => void };
};

function columnNames(db: Database.Database): string[] {
  return db.prepare("PRAGMA table_info('sessions')").all().map((row) => String((row as { name: unknown }).name));
}

function indexNames(db: Database.Database): string[] {
  return db.prepare("PRAGMA index_list('sessions')").all().map((row) => String((row as { name: unknown }).name));
}

describe('0024 ensure session workspace kind migration', () => {
  it('repairs DBs whose migration version advanced before workspace_kind existed', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE migration_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO migration_meta (key, value) VALUES ('schema_version', '22');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Maker',
        working_dir TEXT
      );
    `);

    migration.run(db);

    expect(columnNames(db)).toContain('workspace_kind');
    expect(indexNames(db)).toContain('idx_sessions_workspace_kind');
    db.close();
  });

  it('is idempotent when 0021 already created the column and index', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'New Maker',
        working_dir TEXT,
        workspace_kind TEXT NOT NULL DEFAULT 'project'
      );
      CREATE INDEX idx_sessions_workspace_kind ON sessions (workspace_kind);
    `);

    migration.run(db);

    expect(columnNames(db).filter((name) => name === 'workspace_kind')).toHaveLength(1);
    expect(indexNames(db).filter((name) => name === 'idx_sessions_workspace_kind')).toHaveLength(1);
    db.close();
  });
});
