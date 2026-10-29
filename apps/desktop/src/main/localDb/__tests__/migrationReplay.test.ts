import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { listMigrations, runMigrationReplay } from '../migrationRunner';
import { initializeTaskTagPresets } from '../taskTagPresets';

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
  it.each(['missing', 'legacy', 'partial'])(
    'replays remote report persistence with %s Worker schema',
    (shape) => {
      const { db, cleanup } = createTempDb();
      try {
        // Later migrations need the sessions and task tables these Worker fixtures omit.
        db.exec("CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL); CREATE TABLE sessions (id TEXT PRIMARY KEY)");
        if (shape !== 'missing') db.exec(`CREATE TABLE orca_workers (id TEXT PRIMARY KEY${shape === 'partial' ? ', pending_remote_report TEXT' : ''}); INSERT INTO orca_workers (id) VALUES ('worker-1');`);
        db.exec("CREATE TABLE bot_delegations (id TEXT PRIMARY KEY)");
        db.exec("INSERT INTO sessions (id) VALUES ('legacy-session')");
        // These reduced historical fixtures still need the group table present since schema 83.
        db.exec(readFileSync(path.join(drizzleDir(), '0083_gray_katie_power.sql'), 'utf-8'));
        db.exec(readFileSync(path.join(drizzleDir(), '0088_thankful_captain_midlands.sql'), 'utf-8'));
        const result = runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 124 });
        expect(result.applied.map((migration) => migration.seq)).toEqual([
          125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137,
        ]);
        expect(columnNames(db, 'chat_cache_rooms')).toEqual(['namespace', 'room_id', 'state', 'version']);
        expect(columnNames(db, 'sessions')).toContain('scheduled_model_baseline');
        expect(columnNames(db, 'sessions')).toContain('notifications_muted');
        expect(columnNames(db, 'sessions')).toContain('last_activity_at');
        expect(db.prepare('SELECT last_activity_at FROM sessions').get()).toEqual({ last_activity_at: null });
        expect(tableExists(db, 'plugin_usage_subjects')).toBe(true);
        expect(tableExists(db, 'plugin_usage_events')).toBe(true);
        expect(columnNames(db, 'plugin_usage_events')).toContain('entry_kind');
        expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='plugin_usage_events_pending_idx'").get()).toEqual({ name: 'plugin_usage_events_pending_idx' });
        expect(tableExists(db, 'orca_remote_opens')).toBe(true);
        if (shape !== 'missing') {
        expect(columnNames(db, 'orca_workers')).toEqual(expect.arrayContaining(['pending_remote_report', 'remote_stop_confirmed_at']));
        expect(db.prepare('SELECT id FROM orca_workers').all()).toEqual([{ id: 'worker-1' }]);
      }
      } finally {
        cleanup();
      }
    },
  );
  it('keeps existing tool usage when upgrading the invocation ledger', () => {
    const { db, cleanup } = createTempDb();
    try {
      db.exec("CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      db.exec(readFileSync(path.join(drizzleDir(), '0128_demonic_odin.sql'), 'utf-8'));
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)');
      db.prepare('INSERT INTO plugin_usage_subjects (id,source_kind,ghost_id,display_name,recording_started_at) VALUES (?,?,?,?,?)')
        .run('subject', 'manual', 'plugin', 'Plugin', 100);
      db.prepare('INSERT INTO plugin_usage_events (call_id,subject_id,history_generation,occurred_at,tool_name) VALUES (?,?,?,?,?)')
        .run('legacy-tool', 'subject', 0, 100, 'run');
      // These reduced historical fixtures still need the group table present since schema 83.
      db.exec(readFileSync(path.join(drizzleDir(), '0083_gray_katie_power.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0088_thankful_captain_midlands.sql'), 'utf-8'));
      runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 131 });
      expect(db.prepare('SELECT call_id,subject_id,occurred_at,entry_kind FROM plugin_usage_events').all()).toEqual([
        { call_id: 'legacy-tool', subject_id: 'subject', occurred_at: 100, entry_kind: 'tool' },
      ]);
    } finally { cleanup(); }
  });
  it('rolls back migration 131 on failure and safely retries from schema 130', () => {
    const { db, cleanup } = createTempDb();
    try {
      const tempDrizzle = createTempDrizzleDir();
      try {
        copyFileSync(
          path.join(drizzleDir(), '0131_amused_puff_adder.sql'),
          path.join(tempDrizzle.dir, '0131_amused_puff_adder.sql'),
        );
        db.exec(`
          CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO migration_meta (key, value) VALUES ('schema_version', '130');
          CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL);
          INSERT INTO migration_history VALUES (130, '0130_parallel_devos.sql', 'fixture-hash', 1);
          CREATE TABLE sessions (id TEXT PRIMARY KEY);
          INSERT INTO sessions (id) VALUES ('existing-session');
          CREATE TRIGGER fail_schema_version_131
          BEFORE UPDATE ON migration_meta
          WHEN NEW.key = 'schema_version' AND NEW.value = '131'
          BEGIN
            SELECT RAISE(ABORT, 'injected schema version failure');
          END;
        `);

        expect(() => runMigrationReplay(db, { drizzleDir: tempDrizzle.dir })).toThrow(
          'injected schema version failure',
        );
        expect(columnNames(db, 'sessions')).not.toContain('last_activity_at');
        expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").pluck().get()).toBe('130');
        expect(db.prepare('SELECT count(*) FROM migration_history WHERE seq = 131').pluck().get()).toBe(0);

        db.exec('DROP TRIGGER fail_schema_version_131');
        const retry = runMigrationReplay(db, { drizzleDir: tempDrizzle.dir });

        expect(retry.applied.map((migration) => migration.seq)).toEqual([131]);
        expect(columnNames(db, 'sessions')).toContain('last_activity_at');
        expect(db.prepare("SELECT value FROM migration_meta WHERE key = 'schema_version'").pluck().get()).toBe('131');
        expect(db.prepare('SELECT count(*) FROM migration_history WHERE seq = 131').pluck().get()).toBe(1);
        expect(db.prepare('SELECT id FROM sessions').all()).toEqual([{ id: 'existing-session' }]);
      } finally {
        tempDrizzle.cleanup();
      }
    } finally { cleanup(); }
  });
  it('adds nullable sessions.hidden_at to a populated database without touching existing tasks', () => {
    const { db, cleanup } = createTempDb();
    try {
      db.exec("CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, pinned_at INTEGER, updated_at INTEGER NOT NULL); INSERT INTO sessions VALUES ('a', 'Visible', 'active', NULL, 1), ('b', 'Pinned', 'archived', 5, 2);");
      db.exec("CREATE TABLE bot_delegations (id TEXT PRIMARY KEY)");
      // These reduced historical fixtures still need the group table present since schema 83.
      db.exec(readFileSync(path.join(drizzleDir(), '0083_gray_katie_power.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0088_thankful_captain_midlands.sql'), 'utf-8'));
      const result = runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 125 });
      expect(result.applied.map((migration) => migration.seq)[0]).toBe(126);
      expect(columnNames(db, 'sessions')).toContain('hidden_at');
      expect(db.prepare('SELECT id, title, status, pinned_at, updated_at, hidden_at FROM sessions ORDER BY id').all()).toEqual([
        { id: 'a', title: 'Visible', status: 'active', pinned_at: null, updated_at: 1, hidden_at: null },
        { id: 'b', title: 'Pinned', status: 'archived', pinned_at: 5, updated_at: 2, hidden_at: null },
      ]);
      db.prepare("UPDATE sessions SET hidden_at = 9 WHERE id = 'a'").run();
      expect(db.prepare("SELECT count(*) AS n FROM sessions WHERE hidden_at IS NULL").get()).toEqual({ n: 1 });
    } finally { cleanup(); }
  });
  it('defaults sessions.notifications_muted to unmuted on a populated database', () => {
    const { db, cleanup } = createTempDb();
    try {
      db.exec("CREATE TABLE migration_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE migration_history (seq INTEGER PRIMARY KEY, file_name TEXT NOT NULL, content_hash TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT INTO sessions VALUES ('a', 'Loud', 'active', 1), ('b', 'Archived', 'archived', 2);");
      db.exec("CREATE TABLE plugin_usage_events (call_id TEXT PRIMARY KEY)");
      // These reduced historical fixtures still need the group table present since schema 83.
      db.exec(readFileSync(path.join(drizzleDir(), '0083_gray_katie_power.sql'), 'utf-8'));
      db.exec(readFileSync(path.join(drizzleDir(), '0088_thankful_captain_midlands.sql'), 'utf-8'));
      const result = runMigrationReplay(db, { drizzleDir: drizzleDir(), currentVersion: 129 });
      expect(result.applied.map((migration) => migration.seq)).toEqual([
        130, 131, 132, 133, 134, 135, 136, 137,
      ]);
      expect(columnNames(db, 'sessions')).toContain('notifications_muted');
      // 存量任务全部回填为「未静音」：升级不能替用户少发提醒。
      expect(db.prepare('SELECT id, notifications_muted FROM sessions ORDER BY id').all()).toEqual([
        { id: 'a', notifications_muted: 0 },
        { id: 'b', notifications_muted: 0 },
      ]);
      db.prepare("UPDATE sessions SET notifications_muted = 1 WHERE id = 'a'").run();
      expect(db.prepare('SELECT id FROM sessions WHERE notifications_muted = 0').all()).toEqual([{ id: 'b' }]);
    } finally { cleanup(); }
  });
  it('commits the complete fresh schema and task presets in one outer transaction', () => {
    const { db, cleanup } = createTempDb();
    try {
      db.transaction(() => {
        runMigrationReplay(db, { drizzleDir: drizzleDir() });
        initializeTaskTagPresets(db);
      })();
      expect(
        db.prepare("SELECT value FROM migration_meta WHERE key='schema_version'").pluck().get(),
      ).toBe(String(maxMigrationSeq()));
      expect(
        db.prepare("SELECT count(*) FROM task_tags WHERE id LIKE 'preset:%'").pluck().get(),
      ).toBe(6);
      expect(db.prepare('SELECT count(*) FROM task_tags').pluck().get()).toBe(12);
    } finally {
      cleanup();
    }
  });
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

  // Migration tier: upgrading an existing automation must preserve its content
  // and legacy inheritance; partial fixtures and an already-added column are safe.
  it.each(['missing table', 'legacy table', 'existing column'])(
    'replays the scheduled Agent location migration with %s', (state) => {
      const { db, cleanup } = createTempDb();
      const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-scheduled-agent-location-'));
      try {
        db.exec('CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)');
        const migration = listMigrations(drizzleDir()).find((item) => item.fileName.endsWith('_schedule_model_location.sql'))!;
        copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
        mkdirSync(path.join(stagedDir, 'scripts'));
        copyFileSync(migration.tsScriptPath!, path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath!)));
        if (state !== 'missing table') {
          db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY, prompt TEXT); INSERT INTO schedules VALUES ('old', 'keep this prompt');");
          if (state === 'existing column') db.exec("ALTER TABLE schedules ADD model_agent_device_id TEXT; UPDATE schedules SET model_agent_device_id = 'shared:owner';");
        }
        for (let replay = 0; replay < 2; replay += 1) {
          runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: migration.seq - 1 });
          if (state === 'missing table') expect(tableExists(db, 'schedules')).toBe(false);
          else expect(db.prepare('SELECT * FROM schedules').all()).toEqual([{ id: 'old', prompt: 'keep this prompt',
            model_agent_device_id: state === 'existing column' ? 'shared:owner' : null }]);
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
      expect(tableExists(db, 'bot_groups')).toBe(true);
      expect(tableExists(db, 'bot_group_members')).toBe(true);
      expect(tableExists(db, 'bot_group_messages')).toBe(true);
      expect(indexExists(db, 'uniq_bot_group_messages_group_sequence')).toBe(true);
      expect(indexExists(db, 'uniq_bot_group_messages_group_client')).toBe(true);
      expect(indexExists(db, 'idx_bot_group_members_bot')).toBe(true);
      expect(tableExists(db, 'bot_group_plans')).toBe(true);
      expect(tableExists(db, 'bot_group_plan_steps')).toBe(true);
      expect(indexExists(db, 'idx_bot_group_plans_group_created')).toBe(true);
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
});
