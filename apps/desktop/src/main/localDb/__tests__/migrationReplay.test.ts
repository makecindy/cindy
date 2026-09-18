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

function indexNames(db: Database.Database, tableName: string): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL")
    .all(tableName)
    .map((row) => String((row as { name: unknown }).name));
}

function indexExists(db: Database.Database, indexName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(indexName) !==
    undefined
  );
}

function triggerExists(db: Database.Database, triggerName: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(triggerName) !==
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
  it('adds runtime provenance without certifying or changing legacy context values', () => {
    const { db, cleanup } = createTempDb();
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-context-provenance-'));
    try {
      db.exec(`CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, context_tokens INTEGER, context_window INTEGER);
        INSERT INTO sessions VALUES ('legacy', 140500, 1050000);`);
      const migration = listMigrations(drizzleDir()).find((item) => item.fileName.endsWith('_context_window_runtime.sql'))!;
      copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
      runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: migration.seq - 1 });
      expect(db.prepare('SELECT * FROM sessions').get()).toEqual({
        id: 'legacy', context_tokens: 140500, context_window: 1050000, context_window_runtime: null,
      });
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanup();
    }
  });

  it.each(['missing table', 'legacy table', 'existing column'] as const)(
    'replays the scheduled Harness migration safely with %s',
    (state) => {
      const { db, cleanup } = createTempDb();
      const stagedDir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-scheduled-harness-'));
      try {
        db.exec('CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        const migration = listMigrations(drizzleDir()).find((item) => item.seq === 104)!;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        mkdirSync(path.join(stagedDir, 'scripts'));
        copyFileSync(migration.tsScriptPath!, path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath!)));
        if (state !== 'missing table') {
          db.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, agent_kind TEXT, model TEXT);
            INSERT INTO schedules VALUES ('legacy-schedule', 'codex', 'legacy-model');`);
          if (state === 'existing column') {
            db.exec(`ALTER TABLE schedules ADD model_agent_kind TEXT;
              UPDATE schedules SET model_agent_kind = 'pi';`);
          }
        }
        for (let replay = 0; replay < 2; replay += 1) {
          const result = runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: 103 });
          expect(result.applied.map((item) => item.seq)).toEqual([104]);
          if (state === 'missing table') {
            expect(tableExists(db, 'schedules')).toBe(false);
          } else {
            expect(db.prepare('SELECT * FROM schedules').all()).toEqual([{
              id: 'legacy-schedule', agent_kind: 'codex', model: 'legacy-model',
              model_agent_kind: state === 'existing column' ? 'pi' : null,
            }]);
          }
          expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").pluck().get()).toBe('104');
        }
      } finally {
        rmSync(stagedDir, { recursive: true, force: true });
        cleanup();
      }
    },
  );

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
      const unreadRunPlan = db
        .prepare(
          `EXPLAIN QUERY PLAN
           SELECT count(*) FROM schedule_runs
           WHERE read_at IS NULL
             AND status IN ('success', 'failed', 'aborted', 'interrupted')`,
        )
        .all() as Array<{ detail: string }>;

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
      expect(tableExists(db, 'schedule_session_latest_runs')).toBe(true);
      expect(indexExists(db, 'idx_messages_active_error_tail')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_running_schedule')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_running_heartbeat')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_running_legacy')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_unread_terminal')).toBe(true);
      expect(indexExists(db, 'idx_schedule_runs_session_latest')).toBe(true);
      expect(indexExists(db, 'idx_skill_usage_exposures_skill_recent')).toBe(true);
      expect(indexExists(db, 'idx_skill_usage_exposures_skill_recent_any_version')).toBe(true);
      expect(indexExists(db, 'idx_skill_usage_exposures_analyzer_recent_source')).toBe(true);
      expect(triggerExists(db, 'schedule_session_latest_run_insert')).toBe(true);
      expect(triggerExists(db, 'schedule_session_latest_run_delete')).toBe(true);
      expect(triggerExists(db, 'schedule_session_latest_run_update')).toBe(true);
      expect(unreadRunPlan.some((row) => row.detail.includes('idx_schedule_runs_unread_terminal')))
        .toBe(true);

      db.prepare("INSERT INTO sessions (id, created_at, updated_at) VALUES ('s-cjk', 1, 1)").run();
      db.prepare(
        `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
         VALUES ('m-cjk', 'c-cjk', 's-cjk', 'user', '登录报错了', 1)`,
      ).run();
      const indexed = db
        .prepare('SELECT content FROM messages_fts WHERE message_id = ?')
        .get('m-cjk') as { content: string };
      expect(indexed.content).toBe('登 录 报 错 了');
      expect(
        db
          .prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH '\"登 录\"'")
          .pluck()
          .all(),
      ).toEqual(['m-cjk']);
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
    const replay0060Dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-drizzle-only0060-'));
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

      // 只重放本测试要证明幂等的 0060。把 schema_version 人为倒退后重放所有
      // 后续 DDL 并不是受支持的恢复路径；新表 migration 也不应被迫做成可重复 CREATE。
      const migration0060 = listMigrations(drizzleDir()).find((migration) => migration.seq === 60);
      expect(migration0060).toBeDefined();
      copyFileSync(migration0060!.sqlPath, path.join(replay0060Dir, migration0060!.fileName));
      if (migration0060!.tsScriptPath) {
        mkdirSync(path.join(replay0060Dir, 'scripts'), { recursive: true });
        copyFileSync(
          migration0060!.tsScriptPath,
          path.join(replay0060Dir, 'scripts', path.basename(migration0060!.tsScriptPath)),
        );
      }
      const replayResult = runMigrationReplay(db, { drizzleDir: replay0060Dir, currentVersion: 59 });
      expect(replayResult.applied.map((migration) => migration.seq)).toEqual([60]);
      const replayRows = db
        .prepare(
          `SELECT id, permission_mode, plan_mode_enabled FROM sessions ORDER BY id`,
        )
        .all();
      expect(replayRows).toEqual(rows);
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      rmSync(replay0060Dir, { recursive: true, force: true });
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
        CREATE TABLE right_sidebar_tabs (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL
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
      // fixture 故意不建 schedules(最小库 + 各迁移自带守卫的设计):0084 的
      // 裸 ALTER 靠 runner 的冻结缺陷守卫跳过,迁移链必须能走完而不是中途炸掉。
      expect(tableExists(db, 'schedules')).toBe(false);
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
  it('skips the frozen 0110 duplicate-column ALTER on a database that already owns the column', () => {
    const { db, cleanup: cleanupDb } = createTempDb();
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-renumbered-replay-'));
    try {
      const migration = listMigrations(drizzleDir()).find(
        (item) => item.fileName === '0110_green_unus.sql',
      )!;
      copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));

      // 旧 checkout 已在 0108_loose_puppet_master 落过同一列：裸 ALTER 会 duplicate column。
      db.exec(
        `CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
         CREATE TABLE sessions (id TEXT PRIMARY KEY, context_window_budget INTEGER);`
      );

      const result = runMigrationReplay(db, {
        drizzleDir: stagedDir,
        currentVersion: migration.seq - 1,
      });

      expect(result.applied.map((item) => item.seq)).toEqual([migration.seq]);
      expect(columnNames(db, 'sessions')).toContain('context_window_budget');
      expect(
        db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get(),
      ).toBe(String(migration.seq));
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanupDb();
    }
  });

  it('still applies the 0110 ALTER on a database without the column', () => {
    const { db, cleanup: cleanupDb } = createTempDb();
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-renumbered-replay-plain-'));
    try {
      const migration = listMigrations(drizzleDir()).find(
        (item) => item.fileName === '0110_green_unus.sql',
      )!;
      copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
      db.exec(
        `CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
         CREATE TABLE sessions (id TEXT PRIMARY KEY);`
      );

      runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: migration.seq - 1 });

      expect(columnNames(db, 'sessions')).toContain('context_window_budget');
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanupDb();
    }
  });
/** 旧重编号血统的 bot 私聊表：缺 sender_name/recipient_name，其余与 0108 后一致。 */
const RENUMBERED_BOT_TABLES_SQL = `
  CREATE TABLE bot_profiles (id TEXT PRIMARY KEY);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, context_window_budget INTEGER);
  CREATE TABLE bot_direct_message_threads (
    id text PRIMARY KEY NOT NULL, bot_a_id text NOT NULL, bot_b_id text NOT NULL,
    status text DEFAULT 'active' NOT NULL, close_reason text,
    message_count integer DEFAULT 0 NOT NULL, max_messages integer NOT NULL,
    expires_at integer NOT NULL, blocked_until integer, created_at integer NOT NULL,
    updated_at integer NOT NULL, closed_at integer,
    FOREIGN KEY (bot_a_id) REFERENCES bot_profiles(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (bot_b_id) REFERENCES bot_profiles(id) ON UPDATE no action ON DELETE cascade
  );
  CREATE TABLE bot_direct_messages (
    id text PRIMARY KEY NOT NULL, thread_id text NOT NULL, sequence integer NOT NULL,
    sender_bot_id text NOT NULL, recipient_bot_id text NOT NULL, sender_session_id text,
    recipient_session_id text, delivery_status text DEFAULT 'pending' NOT NULL,
    content text NOT NULL, created_at integer NOT NULL, bridge_session_id text,
    FOREIGN KEY (thread_id) REFERENCES bot_direct_message_threads(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (sender_bot_id) REFERENCES bot_profiles(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (recipient_bot_id) REFERENCES bot_profiles(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (sender_session_id) REFERENCES sessions(id) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (recipient_session_id) REFERENCES sessions(id) ON UPDATE no action ON DELETE set null
  );
  CREATE UNIQUE INDEX uniq_bot_dm_threads_active_pair ON bot_direct_message_threads (bot_a_id,bot_b_id);
  CREATE INDEX idx_bot_dm_threads_pair_updated ON bot_direct_message_threads (bot_a_id,bot_b_id,updated_at);
  CREATE UNIQUE INDEX uniq_bot_direct_messages_thread_sequence ON bot_direct_messages (thread_id,sequence);
  CREATE INDEX idx_bot_direct_messages_thread_created ON bot_direct_messages (thread_id,created_at);
  INSERT INTO bot_direct_message_threads (id,bot_a_id,bot_b_id,max_messages,expires_at,created_at,updated_at)
    VALUES ('thread-1','bot-a','bot-b',20,0,1,1);
  INSERT INTO bot_direct_messages (id,thread_id,sequence,sender_bot_id,recipient_bot_id,content,created_at,bridge_session_id)
    VALUES ('msg-1','thread-1',1,'bot-a','bot-b','legacy content',1,'bridge-1');
`;

  it('converges the renumbered bot DM lineage to the 0108 structure and keeps rows', () => {
    const { db, cleanup: cleanupDb } = createTempDb();
    const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-renumbered-bot-dm-'));
    try {
      const migration = listMigrations(drizzleDir()).find(
        (item) => item.fileName === '0108_lowly_scarlet_witch.sql',
      )!;
      copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
      db.exec('CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
      // fixture 里用简化的 bot_profiles/sessions 占位表，关外键以便造历史数据。
      db.pragma('foreign_keys = OFF');
      db.exec(RENUMBERED_BOT_TABLES_SQL);
      db.pragma('foreign_keys = ON');

      runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: migration.seq - 1 });

      // 本用例只 staged 了 0108：重建后应与 0108 执行完那一刻的形状一致（无 bridge_session_id）。
      expect(columnNames(db, 'bot_direct_messages')).toEqual([
        'id','thread_id','sequence','sender_bot_id','recipient_bot_id','sender_session_id',
        'recipient_session_id','delivery_status','sender_name','recipient_name','content',
        'created_at',
      ]);
      expect(indexNames(db, 'bot_direct_messages').sort()).toEqual([
        'idx_bot_direct_messages_thread_created',
        'uniq_bot_direct_messages_thread_sequence',
      ]);
      expect(db.prepare('SELECT content, sender_name, recipient_name FROM bot_direct_messages').get()).toEqual({
        content: 'legacy content',
        sender_name: null,
        recipient_name: null,
      });
    } finally {
      rmSync(stagedDir, { recursive: true, force: true });
      cleanupDb();
    }
  });
});