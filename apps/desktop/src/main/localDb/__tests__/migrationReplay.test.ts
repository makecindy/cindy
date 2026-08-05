import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { listMigrations, runMigrationReplay } from '../migrationRunner';

const canRunMigrationReplay = process.platform === 'win32' || process.platform === 'darwin';
const describeMigrationReplay = canRunMigrationReplay ? describe : describe.skip;

function desktopRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

function drizzleDir(): string {
  return path.join(desktopRoot(), 'drizzle');
}

function sqliteVecFilename(): string {
  if (process.platform === 'win32') return 'vec0.dll';
  if (process.platform === 'darwin') return 'vec0.dylib';
  throw new Error(`migration replay tests only support bundled sqlite-vec on macOS/Windows`);
}

function loadSqliteVec(db: Database.Database): void {
  const extPath = path.join(
    desktopRoot(),
    'native',
    'sqlite-vec',
    `${process.platform}-${process.arch}`,
    sqliteVecFilename(),
  );
  db.loadExtension(extPath);
}

function createTempDb(): { db: Database.Database; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-migration-replay-'));
  const dbPath = path.join(dir, 'replay.db');
  const db = createBetterSqliteDatabase(dbPath);
  loadSqliteVec(db);
  return {
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function createTempDrizzleDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-replay-'));
  writeFileSync(
    path.join(dir, '0000_create_marker.sql'),
    'CREATE TABLE migrated_marker (id TEXT PRIMARY KEY);\n',
    'utf-8',
  );
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function maxMigrationSeq(): number {
  return Math.max(...listMigrations(drizzleDir()).map((migration) => migration.seq));
}

function seedFixture(db: Database.Database, name: string): void {
  db.exec(readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));
}

function tableExists(db: Database.Database, tableName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName) !==
    undefined
  );
}

function indexExists(db: Database.Database, indexName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(indexName) !==
    undefined
  );
}

function columnNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${tableName}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

describeMigrationReplay('migration replay', () => {
  it('replays every drizzle migration into a fresh database', () => {
    const { db, cleanup } = createTempDb();
    try {
      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });
      const schemaVersion = db
        .prepare("SELECT value FROM migration_meta WHERE key='schema_version'")
        .pluck()
        .get();
      const historyCount = db.prepare('SELECT COUNT(*) FROM migration_history').pluck().get();
      const partialIndexes = db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type='index'
             AND name IN (
               'uniq_active_team_per_lead',
               'uniq_orca_workers_focused_per_team',
               'uniq_wechat_inbox_running_session',
               'uniq_wechat_sync_active'
             )
           ORDER BY name`,
        )
        .pluck()
        .all();

      expect(result.applied.map((migration) => migration.seq)).toEqual(
        listMigrations(drizzleDir()).map((migration) => migration.seq),
      );
      expect(schemaVersion).toBe(String(maxMigrationSeq()));
      expect(historyCount).toBe(result.applied.length);
      expect(partialIndexes).toEqual([
        'uniq_active_team_per_lead',
        'uniq_orca_workers_focused_per_team',
        'uniq_wechat_inbox_running_session',
        'uniq_wechat_sync_active',
      ]);
      expect(tableExists(db, 'wechat_sync_state')).toBe(true);
      expect(tableExists(db, 'wechat_inbox')).toBe(true);
      expect(tableExists(db, 'wechat_outbox')).toBe(true);
      expect(tableExists(db, 'wechat_file_attachments')).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('upgrades a schema v39 Orca workflow database through the 0040 script', () => {
    const { db, cleanup } = createTempDb();
    try {
      seedFixture(db, 'schema-v39-orca-workflow.sql');

      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });
      const workerRows = db
        .prepare(
          `SELECT id, team_id, role, focused
           FROM orca_workers
           ORDER BY created_at`,
        )
        .all();
      const expectedSeqs = listMigrations(drizzleDir())
        .filter((migration) => migration.seq > 39)
        .map((migration) => migration.seq);

      expect(result.applied.map((migration) => migration.seq)).toEqual(expectedSeqs);
      expect(tableExists(db, 'orca_workflows')).toBe(false);
      expect(tableExists(db, 'orca_teams')).toBe(true);
      expect(columnNames(db, 'orca_workers')).toEqual(
        expect.arrayContaining(['team_id', 'role', 'focused', 'idle_since']),
      );
      expect(columnNames(db, 'orca_workers')).not.toContain('workflow_id');
      expect(workerRows).toEqual([
        { id: 'worker-1', team_id: 'team-1', role: 'developer', focused: 1 },
        { id: 'worker-2', team_id: 'team-1', role: 'developer', focused: 0 },
      ]);
      expect(indexExists(db, 'uniq_active_team_per_lead')).toBe(true);
      expect(indexExists(db, 'uniq_orca_workers_focused_per_team')).toBe(true);
      expect(indexExists(db, 'idx_orca_workers_workflow_id')).toBe(false);
      expect(columnNames(db, 'schedules')).toContain('fast_mode');
    } finally {
      cleanup();
    }
  });

  it('converts legacy permission_mode=plan sessions into plan_mode_enabled via 0060', () => {
    const { db, cleanup } = createTempDb();
    // 复刻 0060 之前的库:拷贝 drizzle 目录并剔除 0060,重放到 0059 后再 seed。
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-pre0060-'));
    try {
      for (const migration of listMigrations(drizzleDir())) {
        if (migration.seq >= 60) continue;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        if (migration.tsScriptPath) {
          mkdirSync(path.join(stagedDir, 'scripts'), { recursive: true });
          copyFileSync(
            migration.tsScriptPath,
            path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath)),
          );
        }
      }
      runMigrationReplay(db, { drizzleDir: stagedDir });
      const now = Date.now();
      db.prepare(
        `INSERT INTO sessions (id, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run('legacy-plan-session', 'plan', now, now);
      db.prepare(
        `INSERT INTO sessions (id, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run('plain-session', 'acceptEdits', now, now);

      const result = runMigrationReplay(db, { drizzleDir: drizzleDir() });

      expect(result.applied.map((migration) => migration.seq)).toContain(60);
      expect(columnNames(db, 'sessions')).toContain('plan_mode_enabled');
      const rows = db
        .prepare(
          `SELECT id, permission_mode, plan_mode_enabled FROM sessions ORDER BY id`,
        )
        .all();
      expect(rows).toEqual([
        { id: 'legacy-plan-session', permission_mode: 'ask', plan_mode_enabled: 1 },
        { id: 'plain-session', permission_mode: 'acceptEdits', plan_mode_enabled: 0 },
      ]);

      const replayResult = runMigrationReplay(db, {
        drizzleDir: drizzleDir(),
        currentVersion: 59,
      });
      // 59 之后的迁移全部重放(0060 及以后陆续新增的都在内),不写死具体序号
      const expectedReplaySeqs = listMigrations(drizzleDir())
        .filter((migration) => migration.seq > 59)
        .map((migration) => migration.seq);
      expect(replayResult.applied.map((migration) => migration.seq)).toEqual(expectedReplaySeqs);
      const replayRows = db
        .prepare(
          `SELECT id, permission_mode, plan_mode_enabled FROM sessions ORDER BY id`,
        )
        .all();
      expect(replayRows).toEqual(rows);
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('bridges the exact legacy migration lineage through 0074 replay', () => {
    const { db, cleanup } = createTempDb();
    try {
      db.exec(`
        CREATE TABLE migration_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE migration_history (
          seq INTEGER PRIMARY KEY NOT NULL,
          file_name TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY NOT NULL,
          permission_mode TEXT
        );
        CREATE TABLE schedule_runs (
          id TEXT PRIMARY KEY NOT NULL
        );
        INSERT INTO sessions (id, permission_mode) VALUES ('legacy-plan', 'plan');
        INSERT INTO migration_history (seq, file_name, content_hash, applied_at) VALUES
          (47, '0047_add_session_summary.sql', '44c224320ca6f5059d5184deae8f5d074f97bfa6502f3d73a54894a962edaf15', 1047),
          (60, '0060_orange_penance.sql', 'd1dcd9ee1279ef86f5e0a136b8e1b786b11d462373f8ed464476ae3062312ffb', 1060),
          (62, '0062_third_pepper_potts.sql', '8a3ba2f92ebc495995f23a3727a65398fce1a877ffcb08d99df8705f21f49837', 1062),
          (63, '0063_secret_dreaming_celestial.sql', 'd07bdac33796fe1ba80230207f0bf5834d0bf9c9df0c68fe372cbbba42bc7ee8', 1063),
          (64, '0064_amusing_white_tiger.sql', 'ef297d4140b49cb3f6e87d58ea76e7f5a427fc6b3857a02210b9108650dcab23', 1064);
      `);

      const result = runMigrationReplay(db, {
        drizzleDir: drizzleDir(),
        currentVersion: 73,
      });

      expect(result.applied.map((migration) => migration.seq)).toEqual(
        listMigrations(drizzleDir()).filter((migration) => migration.seq > 73).map((migration) => migration.seq),
      );
      expect(
        db
          .prepare(`SELECT permission_mode, plan_mode_enabled FROM sessions WHERE id = ?`)
          .get('legacy-plan'),
      ).toEqual({ permission_mode: 'ask', plan_mode_enabled: 1 });
      expect(columnNames(db, 'sessions')).toEqual(
        expect.arrayContaining(['active_turn_started_at', 'active_turn_pid']),
      );
      expect(columnNames(db, 'schedule_runs')).toEqual(
        expect.arrayContaining([
          'heartbeat_at',
          'pre_run_hook_result',
          'cost_usd',
          'estimated_value_usd',
          'cost_attribution',
        ]),
      );
      expect(tableExists(db, 'project_aliases')).toBe(true);
      expect(tableExists(db, 'device_link_ownership')).toBe(true);
      expect(
        db
          .prepare(
            `SELECT seq, file_name
           FROM migration_history
           WHERE seq IN (47, 60, 62, 63, 64, 74, 75, 76, 77, 78)
           ORDER BY seq`,
          )
          .all(),
      ).toEqual([
        { seq: 47, file_name: '0047_lame_malice.sql' },
        { seq: 60, file_name: '0060_orange_penance.sql' },
        { seq: 62, file_name: '0062_flaky_mimic.sql' },
        { seq: 63, file_name: '0063_handy_tenebrous.sql' },
        { seq: 64, file_name: '0064_icy_bruce_banner.sql' },
        { seq: 74, file_name: '0074_bridge_legacy_migration_lineage.sql' },
        { seq: 75, file_name: '0075_complex_strong_guy.sql' },
        { seq: 76, file_name: '0076_melted_post.sql' },
        { seq: 77, file_name: '0077_nebulous_veda.sql' },
        { seq: 78, file_name: '0078_same_juggernaut.sql' },
      ]);
    } finally {
      cleanup();
    }
  });

  it('normalizes duplicate worker labels deterministically before enforcing uniqueness', () => {
    const { db, cleanup } = createTempDb();
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-pre0078-'));
    try {
      for (const migration of listMigrations(drizzleDir())) {
        if (migration.seq >= 78) continue;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        if (migration.tsScriptPath) {
          mkdirSync(path.join(stagedDir, 'scripts'), { recursive: true });
          copyFileSync(
            migration.tsScriptPath,
            path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath)),
          );
        }
      }
      runMigrationReplay(db, { drizzleDir: stagedDir });
      const now = Date.now();
      for (const id of ['lead', 'worker-1', 'worker-2', 'worker-3', 'worker-4']) {
        db.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)').run(id, now, now);
      }
      db.prepare(`INSERT INTO orca_teams
        (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
        .run('team-1', 'lead', 'active', now, now);
      const insertWorker = db.prepare(`INSERT INTO orca_workers
        (id, team_id, session_id, status, label, role, focused, created_at, updated_at)
        VALUES (?, 'team-1', ?, 'idle', ?, 'tester', 0, ?, ?)`);
      insertWorker.run('worker-row-1', 'worker-1', 'Tester', 1, 1);
      insertWorker.run('worker-row-2', 'worker-2', 'tester', 2, 2);
      insertWorker.run('worker-row-3', 'worker-3', 'tester-2', 3, 3);

      runMigrationReplay(db, { drizzleDir: drizzleDir() });

      expect(db.prepare('SELECT label FROM orca_workers ORDER BY created_at').pluck().all()).toEqual([
        'tester',
        'tester-3',
        'tester-2',
      ]);
      expect(tableExists(db, 'orca_worker_creation_reservations')).toBe(true);
      expect(indexExists(db, 'uniq_orca_workers_team_label')).toBe(true);
      expect(() => insertWorker.run('worker-row-4', 'worker-4', 'TESTER', 4, 4)).toThrow();
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it('keeps migration committed when the history side-write fails', () => {
    const { db, cleanup: cleanupDb } = createTempDb();
    const { dir, cleanup: cleanupDrizzle } = createTempDrizzleDir();
    try {
      db.exec(`
        CREATE TABLE migration_meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
        CREATE TABLE migration_history (
          seq INTEGER PRIMARY KEY NOT NULL
        );
      `);

      const historyFailures: Array<{ seq: number; fileName: string; error: unknown }> = [];
      const result = runMigrationReplay(db, {
        drizzleDir: dir,
        onMigrationHistoryWriteFailed: (failure) => {
          historyFailures.push(failure);
        },
      });
      const schemaVersion = db
        .prepare("SELECT value FROM migration_meta WHERE key='schema_version'")
        .pluck()
        .get();

      expect(result.applied.map((migration) => migration.seq)).toEqual([0]);
      expect(tableExists(db, 'migrated_marker')).toBe(true);
      expect(schemaVersion).toBe('0');
      expect(historyFailures).toHaveLength(1);
      expect(historyFailures[0]).toMatchObject({
        seq: 0,
        fileName: '0000_create_marker.sql',
      });
      expect(historyFailures[0]?.error).toBeInstanceOf(Error);
    } finally {
      cleanupDb();
      cleanupDrizzle();
    }
  });
});
