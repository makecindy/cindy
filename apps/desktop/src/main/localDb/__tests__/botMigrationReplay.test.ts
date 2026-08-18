import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { listMigrations, runMigrationReplay } from '../migrationRunner';

const MIGRATIONS = ['0093_bots_runtime_foundation.sql'] as const;
const cleanups: Array<() => void> = [];
const canReplayPublishedLineage = process.platform === 'darwin' || process.platform === 'win32';
const lineageIt = canReplayPublishedLineage ? it : it.skip;

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function createDb() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-bot-migration-'));
  const db = createBetterSqliteDatabase(path.join(dir, 'bots.db'));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE migration_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    CREATE TABLE migration_history (
      seq INTEGER PRIMARY KEY NOT NULL,
      file_name TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, status TEXT DEFAULT 'active' NOT NULL);
    CREATE TABLE schedules (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE schedule_runs (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE right_sidebar_tabs (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL
    );
  `);
  return db;
}

function sqliteVecFilename(): string {
  return process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib';
}

function createPublishedV91Db() {
  const desktopRoot = path.resolve(__dirname, '../../../..');
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-bot-v91-'));
  const db = createBetterSqliteDatabase(path.join(dir, 'bots-v91.db'));
  const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-bot-v91-lineage-'));
  cleanups.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(stagedDir, { recursive: true, force: true });
  });
  db.loadExtension(
    path.join(
      desktopRoot,
      'native',
      'sqlite-vec',
      `${process.platform}-${process.arch}`,
      sqliteVecFilename(),
    ),
  );
  for (const migration of listMigrations(path.join(desktopRoot, 'drizzle'))) {
    if (migration.seq >= 92) continue;
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
  db.pragma('foreign_keys = ON');
  return db;
}

function runBotMigrations(db: ReturnType<typeof createBetterSqliteDatabase>): void {
  const desktopRoot = path.resolve(__dirname, '../../../..');
  const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-bot-migration-step-'));
  for (const migration of MIGRATIONS) {
    copyFileSync(path.join(desktopRoot, 'drizzle', migration), path.join(stagedDir, migration));
    const companion = path.join(
      desktopRoot,
      'drizzle',
      'scripts',
      migration.replace(/\.sql$/, '.ts'),
    );
    if (existsSync(companion)) {
      mkdirSync(path.join(stagedDir, 'scripts'), { recursive: true });
      copyFileSync(companion, path.join(stagedDir, 'scripts', path.basename(companion)));
    }
  }
  try {
    runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: 91 });
  } finally {
    rmSync(stagedDir, { recursive: true, force: true });
  }
}

function columns(db: ReturnType<typeof createBetterSqliteDatabase>, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => String((row as { name: unknown }).name));
}

function indexExists(db: ReturnType<typeof createBetterSqliteDatabase>, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name),
  );
}

describe('Bot release migrations', () => {
  lineageIt('replays the published v91 lineage and preserves legacy IM storage byte-for-byte', () => {
    const db = createPublishedV91Db();
    db.exec(`
      INSERT INTO sessions
        (id, title, working_dir, status, source, im_bot_context_id, im_user_id,
         provider_id, extra_dirs, created_at, updated_at)
      VALUES
        ('legacy-telegram', 'Telegram history', '/repo/telegram', 'active', 'telegram',
         'personal-bot', 'owner-1', 'provider-1', '["/readonly"]', 10, 11),
        ('legacy-feishu', 'Feishu history', '/repo/feishu', 'archived', 'feishu',
         NULL, NULL, NULL, '[]', 12, 13);
      UPDATE sessions
        SET feishu_bot_app_id = 'feishu-app', feishu_open_id = 'open-user'
        WHERE id = 'legacy-feishu';
      INSERT INTO messages
        (id, client_id, session_id, role, content, agent_meta, agent_kind, created_at)
      VALUES
        ('message-1', 'client-1', 'legacy-telegram', 'user',
         '{"text":"keep me"}', '{"replyMessageId":"42"}', 'cc', 20);
      INSERT INTO im_bindings
        (channel, bot_context_id, user_id, scope_key, target_session_id, attached_at,
         attached_via_card_message_id)
      VALUES ('telegram', 'personal-bot', 'owner-1', 'topic-7', 'legacy-telegram', 21, 'card-1');
      INSERT INTO hook_group_messages
        (provider, chat_id, thread_id, message_id, chat_name, author, is_bot, text,
         file_names, sent_at, created_at)
      VALUES ('telegram-personal:personal-bot', '-1001', '7', '42', 'Release group',
         'Owner', 0, 'historical context', '["spec.pdf"]', 22, 23);
    `);
    const legacySnapshot = {
      sessions: db
        .prepare(`SELECT * FROM sessions WHERE id LIKE 'legacy-%' ORDER BY id`)
        .all(),
      messages: db.prepare(`SELECT * FROM messages WHERE id = 'message-1'`).all(),
      bindings: db.prepare(`SELECT * FROM im_bindings`).all(),
      groupHistory: db.prepare(`SELECT * FROM hook_group_messages`).all(),
    };

    runBotMigrations(db);

    expect({
      sessions: db
        .prepare(`SELECT * FROM sessions WHERE id LIKE 'legacy-%' ORDER BY id`)
        .all(),
      messages: db.prepare(`SELECT * FROM messages WHERE id = 'message-1'`).all(),
      bindings: db.prepare(`SELECT * FROM im_bindings`).all(),
      groupHistory: db.prepare(`SELECT * FROM hook_group_messages`).all(),
    }).toEqual(legacySnapshot);
    expect(db.prepare('SELECT COUNT(*) FROM bot_profiles').pluck().get()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM bot_im_migrations').pluck().get()).toBe(0);
    expect(
      db
        .prepare(`SELECT id FROM sessions WHERE source = 'telegram' AND im_bot_context_id = ?`)
        .pluck()
        .all('personal-bot'),
    ).toEqual(['legacy-telegram']);
  });

  it('keeps 0092 and 0093 additive so an older IM reader sees no legacy table rewrite', () => {
    const desktopRoot = path.resolve(__dirname, '../../../..');
    for (const migration of MIGRATIONS) {
      const sql = readFileSync(path.join(desktopRoot, 'drizzle', migration), 'utf-8');
      expect(sql).not.toMatch(/^\s*(?:ALTER|DROP|UPDATE|DELETE)\b/im);
    }
  });

  it('creates the final Bot schema after the published main migration lineage', () => {
    const db = createDb();
    runBotMigrations(db);

    expect(columns(db, 'bot_runtime_snapshots')).toEqual(
      expect.arrayContaining(['prepared_at', 'applied_at', 'failed_at', 'failure_json']),
    );
    expect(columns(db, 'bot_automation_runs')).toEqual(
      expect.arrayContaining([
        'execution_plan_json',
        'target_route_owner_generation_snapshot',
        'output_artifacts_json',
      ]),
    );
    expect(columns(db, 'bot_workspace_leases')).toContain('lease_key');
    expect(columns(db, 'bot_inbox_items')).toEqual(
      expect.arrayContaining(['subscription_id', 'processing_session_id', 'result_delivery_status']),
    );
    expect(indexExists(db, 'uniq_bot_session_links_route')).toBe(true);
    expect(indexExists(db, 'uniq_bot_workspace_leases_active_binding_key')).toBe(true);
    expect(indexExists(db, 'uniq_bot_inbox_subscription_event')).toBe(true);
    expect(indexExists(db, 'uniq_bot_session_event_ledger_key')).toBe(true);
    expect(indexExists(db, 'right_sidebar_tabs_bot_delegations_singleton_idx')).toBe(true);
  });

  it('enforces canonical, route, project, and sidebar ownership uniqueness', () => {
    const db = createDb();
    runBotMigrations(db);
    db.exec(`
      INSERT INTO bot_profiles (id, display_name, created_at, updated_at)
        VALUES ('bot-1', 'Bot One', 1, 1);
      INSERT INTO bot_channels (id, bot_id, kind, created_at, updated_at)
        VALUES ('channel-1', 'bot-1', 'telegram', 1, 1);
      INSERT INTO sessions (id, status) VALUES
        ('session-1', 'active'), ('session-2', 'active'),
        ('session-3', 'active'), ('session-4', 'active');
      INSERT INTO bot_session_links
        (id, bot_id, session_id, profile_version, role, channel_id, route_key, created_at)
        VALUES ('route-1', 'bot-1', 'session-1', 1, 'route', 'channel-1', 'chat:1', 1);
      INSERT INTO bot_session_links
        (id, bot_id, session_id, profile_version, role, created_at)
        VALUES ('canonical-1', 'bot-1', 'session-3', 1, 'canonical', 1);
      INSERT INTO bot_project_bindings
        (id, bot_id, project_key, working_dir, is_default, created_at, updated_at)
        VALUES ('project-1', 'bot-1', 'local:/repo', '/repo', 1, 1, 1);
      INSERT INTO right_sidebar_tabs (id, session_id, kind)
        VALUES ('tab-1', 'session-1', 'bot-delegations');
    `);

    expect(() => db.prepare(`INSERT INTO bot_session_links
      (id, bot_id, session_id, profile_version, role, channel_id, route_key, created_at)
      VALUES ('route-2', 'bot-1', 'session-2', 1, 'route', 'channel-1', 'chat:1', 2)`).run())
      .toThrow();
    expect(() => db.prepare(`INSERT INTO bot_session_links
      (id, bot_id, session_id, profile_version, role, created_at)
      VALUES ('canonical-2', 'bot-1', 'session-4', 1, 'canonical', 2)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO bot_channels
      (id, bot_id, kind, created_at, updated_at)
      VALUES ('channel-2', 'bot-1', 'telegram', 2, 2)`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO bot_project_bindings
      (id, bot_id, project_key, working_dir, is_default, created_at, updated_at)
      VALUES ('project-2', 'bot-1', 'local:/other', '/other', 1, 2, 2)`).run()).toThrow();
    expect(() => db.prepare(`INSERT INTO right_sidebar_tabs (id, session_id, kind)
      VALUES ('tab-2', 'session-1', 'bot-delegations')`).run()).toThrow();
  });
});
