import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const migration = require('../../../../drizzle/scripts/0090_retain_all_recent_workdirs.ts') as {
  run: (db: Database.Database) => void;
  runForPlatform: (db: Database.Database, platform: NodeJS.Platform) => void;
};

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT,
      workspace_kind TEXT NOT NULL,
      remote_host_id TEXT,
      working_dir TEXT,
      status TEXT NOT NULL,
      user_send_at INTEGER,
      updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE recent_workdirs (
      path TEXT PRIMARY KEY NOT NULL,
      last_used_at INTEGER NOT NULL
    );
  `);
});

afterEach(() => db.close());

function seedSession(input: {
  id: string;
  path: string;
  timestamp: number;
  source?: string;
  status?: string;
  remoteHostId?: string | null;
}): void {
  db.prepare(
    `INSERT INTO sessions (
       id, source, workspace_kind, remote_host_id, working_dir, status,
       user_send_at, updated_at, created_at
     ) VALUES (?, ?, 'project', ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.source ?? 'desktop',
    input.remoteHostId ?? null,
    input.path,
    input.status ?? 'active',
    input.timestamp,
    input.timestamp,
    input.timestamp,
  );
}

function recentRows(): Array<{ path: string; last_used_at: number }> {
  return db.prepare('SELECT path, last_used_at FROM recent_workdirs ORDER BY path').all() as Array<{
    path: string;
    last_used_at: number;
  }>;
}

describe('0090 retain all recent workdirs migration', () => {
  it('backfills every local project without a ten-project cap, including deleted sessions', () => {
    for (let index = 0; index < 14; index += 1) {
      seedSession({
        id: `session-${index}`,
        path: `/workspace/project-${index}`,
        timestamp: 1_000 + index,
        status: index === 0 ? 'deleted' : 'active',
      });
    }

    migration.run(db);

    expect(recentRows()).toHaveLength(14);
    expect(recentRows()).toContainEqual({ path: '/workspace/project-0', last_used_at: 1_000 });
  });

  it('backfills historical local plugin projects without admitting scheduler workdirs', () => {
    seedSession({
      id: 'plugin-archived',
      path: '/workspace/plugin-project',
      timestamp: 2_000,
      source: 'plugin',
      status: 'archived',
    });
    seedSession({
      id: 'scheduler-archived',
      path: '/workspace/scheduler-project',
      timestamp: 3_000,
      source: 'scheduler',
      status: 'archived',
    });
    seedSession({
      id: 'unknown-archived',
      path: '/workspace/unknown-project',
      timestamp: 4_000,
      source: 'future-source',
      status: 'archived',
    });

    migration.run(db);

    expect(recentRows()).toEqual([
      { path: '/workspace/plugin-project', last_used_at: 2_000 },
    ]);
  });

  it('normalizes duplicate path spellings and keeps the newest activity time', () => {
    seedSession({ id: 'old', path: 'D:\\work\\project-a\\', timestamp: 1_000 });
    seedSession({ id: 'new', path: 'D:/work/project-a', timestamp: 2_000 });

    migration.run(db);

    expect(recentRows()).toEqual([{ path: 'D:/work/project-a', last_used_at: 2_000 }]);
  });

  it('preserves a newer existing timestamp and is idempotent', () => {
    seedSession({ id: 'session-a', path: '/workspace/project-a', timestamp: 1_000 });
    db.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
      '/workspace/project-a',
      3_000,
    );

    migration.run(db);
    migration.run(db);

    expect(recentRows()).toEqual([{ path: '/workspace/project-a', last_used_at: 3_000 }]);
  });

  it('excludes remote projects and Cindy-managed worktrees', () => {
    seedSession({
      id: 'remote',
      path: '/workspace/remote',
      timestamp: 1_000,
      remoteHostId: 'host-a',
    });
    seedSession({
      id: 'managed',
      path: '/workspace/project/.cindy-worktrees/task-a',
      timestamp: 2_000,
    });
    seedSession({ id: 'local', path: '/workspace/local', timestamp: 3_000 });

    migration.run(db);

    expect(recentRows()).toEqual([{ path: '/workspace/local', last_used_at: 3_000 }]);
  });

  it('fails closed against a sparse legacy sessions table without source provenance', () => {
    db.exec(`
      DROP TABLE sessions;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        working_dir TEXT,
        created_at INTEGER
      );
      INSERT INTO sessions (id, working_dir, created_at)
      VALUES ('legacy', '/workspace/legacy', 4000);
      INSERT INTO recent_workdirs (path, last_used_at)
      VALUES ('/workspace/already-retained', 3000);
    `);

    migration.run(db);

    expect(recentRows()).toEqual([
      { path: '/workspace/already-retained', last_used_at: 3_000 },
    ]);
  });

  it('deduplicates legacy Windows drive and UNC casing identities', () => {
    db.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
      'D:/Work/Project-A',
      3_000,
    );
    db.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
      'd:/work/project-a',
      2_000,
    );
    db.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
      '//Server/Share/Project-B',
      4_000,
    );
    db.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
      '//server/share/project-b',
      5_000,
    );
    db.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
      'D:/ÉCOLE/Plugin-Project',
      5_500,
    );
    seedSession({
      id: 'plugin-windows',
      path: 'd:/école/plugin-project',
      timestamp: 6_000,
      source: 'plugin',
      status: 'archived',
    });

    migration.runForPlatform(db, 'win32');

    expect(recentRows()).toEqual([
      { path: '//server/share/project-b', last_used_at: 5_000 },
      { path: 'D:/Work/Project-A', last_used_at: 3_000 },
      { path: 'd:/école/plugin-project', last_used_at: 6_000 },
    ]);
  });

  it('keeps POSIX path casing distinct', () => {
    db.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
      '/Workspace/Project-A',
      1_000,
    );
    db.prepare('INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)').run(
      '/workspace/project-a',
      2_000,
    );

    migration.runForPlatform(db, 'linux');

    expect(recentRows()).toHaveLength(2);
  });
});
