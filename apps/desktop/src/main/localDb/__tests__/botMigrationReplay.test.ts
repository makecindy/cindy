import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { listMigrations, runMigrationReplay } from '../migrationRunner';

/**
 * 伙伴那批表落在哪个迁移里 —— **按内容找,不写死文件名**。
 *
 * 写死过一次,代价是这组用例整个失效:合主干时迁移撞号,按规矩重新生成之后文件从
 * 一个名字变成另一个名字,而这里还指着那个已经不存在的文件 —— 用例全部 ENOENT,
 * 伙伴迁移链的回归保护静默归零。
 *
 * 撞号重排是这个仓库的常态(迁移号先到先得),所以判据得跟着内容走:含 `bot_profiles`
 * 建表语句的那一个就是它。裁剪后 Bot 与伙伴私聊相关表都在这一份迁移里一次性
 * 建立,不再是分多个迁移逐步长出来的旧形态。找不到直接抛,不静默跳过 —— 那等于
 * 又回到没有保护的状态；具体表数由后面的结构断言负责,不在注释里写死。
 */
const ALL_MIGRATIONS = listMigrations(path.resolve(__dirname, '../../../..', 'drizzle'));
const BOT_MIGRATION_FILES = ALL_MIGRATIONS.filter((migration) =>
  readFileSync(migration.sqlPath, 'utf8').includes('CREATE TABLE `bot_profiles`'),
);
if (BOT_MIGRATION_FILES.length === 0) {
  throw new Error('找不到建 bot_profiles 的迁移 —— 伙伴迁移链的回归用例失去依据');
}
const MIGRATIONS = BOT_MIGRATION_FILES.map((migration) => migration.fileName);
/** 第一个含 Bot 表的迁移号；早于它的迁移代表「Bot 上线前」已发布主干的真实状态。 */
const FIRST_BOT_SEQ = Math.min(...BOT_MIGRATION_FILES.map((migration) => migration.seq));

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

/** 回放 Bot 表上线前、已发布主干的完整迁移链(不含任何 Bot 表)。 */
function createPreBotPublishedDb() {
  const desktopRoot = path.resolve(__dirname, '../../../..');
  const dir = mkdtempSync(path.join(tmpdir(), 'cindy-bot-pre-'));
  const db = createBetterSqliteDatabase(path.join(dir, 'bots-pre.db'));
  const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-bot-pre-lineage-'));
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
  for (const migration of ALL_MIGRATIONS) {
    if (migration.seq >= FIRST_BOT_SEQ) continue;
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
  const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-bot-migration-step-'));
  for (const migration of BOT_MIGRATION_FILES) {
    copyFileSync(migration.sqlPath, path.join(stagedDir, migration.fileName));
    if (migration.tsScriptPath) {
      mkdirSync(path.join(stagedDir, 'scripts'), { recursive: true });
      copyFileSync(
        migration.tsScriptPath,
        path.join(stagedDir, 'scripts', path.basename(migration.tsScriptPath)),
      );
    }
  }
  try {
    runMigrationReplay(db, { drizzleDir: stagedDir, currentVersion: FIRST_BOT_SEQ - 1 });
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
  lineageIt('replays the bot migration and preserves legacy IM storage byte-for-byte', () => {
    const db = createPreBotPublishedDb();
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
    expect(
      db
        .prepare(`SELECT id FROM sessions WHERE source = 'telegram' AND im_bot_context_id = ?`)
        .pluck()
        .all('personal-bot'),
    ).toEqual(['legacy-telegram']);
  });

  it('keeps the Bot migration additive so an older IM reader sees no legacy table rewrite', () => {
    const desktopRoot = path.resolve(__dirname, '../../../..');
    for (const migration of MIGRATIONS) {
      const sql = readFileSync(path.join(desktopRoot, 'drizzle', migration), 'utf-8');
      expect(sql).not.toMatch(/^\s*(?:DROP|UPDATE|DELETE)\b/im);
      expect(sql).not.toMatch(/^\s*ALTER TABLE `(?!bot_|right_sidebar_tabs|sessions)[^`]+`\b/im);
      expect(sql).not.toMatch(/^\s*ALTER TABLE `bot_[^`]+` (?!ADD\b)/im);
    }
  });

  it('creates the final Bot schema (6 tables) after the published main migration lineage', () => {
    const db = createDb();
    runBotMigrations(db);

    expect(columns(db, 'bot_profiles')).toEqual(
      expect.arrayContaining([
        'id', 'display_name', 'description', 'avatar', 'avatar_color', 'status',
        'hidden_at', 'pinned_at', 'attention_reason', 'attention_at',
        'current_version', 'canonical_session_id', 'created_at', 'updated_at',
      ]),
    );
    expect(columns(db, 'bot_profile_versions')).toEqual(
      expect.arrayContaining([
        'id', 'bot_id', 'version', 'identity_source', 'capabilities_json', 'created_at',
      ]),
    );
    expect(columns(db, 'bot_session_links')).toEqual(
      expect.arrayContaining([
        'id', 'bot_id', 'session_id', 'profile_version', 'role', 'route_key',
        'created_at', 'archived_at',
      ]),
    );
    expect(columns(db, 'bot_runtime_snapshots')).toEqual(
      expect.arrayContaining([
        'id', 'bot_id', 'session_id', 'profile_version', 'agent_kind', 'working_dir',
        'memory_scope_key', 'configured_json', 'resolved_json', 'status',
        'prepared_at', 'applied_at', 'failed_at', 'failure_json',
      ]),
    );
    expect(columns(db, 'bot_lifecycle_events')).toEqual(
      expect.arrayContaining([
        'id', 'bot_id', 'session_id', 'event_type', 'payload_json', 'created_at',
      ]),
    );
    expect(columns(db, 'bot_delegations')).toEqual(
      expect.arrayContaining([
        'id', 'requesting_bot_id', 'target_bot_id', 'parent_session_id', 'child_session_id',
        'objective', 'context_refs_json', 'artifact_refs_json', 'permission_snapshot_json',
        'lineage_json', 'target_profile_version', 'depth', 'budget_tokens', 'tokens_used',
        'status', 'result_summary', 'output_artifacts_json', 'pending_interaction_json',
        'last_error', 'run_sequence', 'created_at', 'accepted_at', 'completed_at',
        'completion_delivered_at', 'updated_at',
      ]),
    );

    expect(indexExists(db, 'idx_bot_profiles_status_updated')).toBe(true);
    expect(indexExists(db, 'idx_bot_profiles_canonical_session')).toBe(true);
    expect(indexExists(db, 'uniq_bot_profile_versions_bot_version')).toBe(true);
    expect(indexExists(db, 'uniq_bot_session_links_session')).toBe(true);
    expect(indexExists(db, 'uniq_bot_session_links_canonical_per_bot')).toBe(true);
    expect(indexExists(db, 'idx_bot_session_links_bot_role')).toBe(true);
    expect(indexExists(db, 'uniq_bot_delegations_child_session')).toBe(true);
    expect(indexExists(db, 'right_sidebar_tabs_bot_delegations_singleton_idx')).toBe(false);
    expect(indexExists(db, 'right_sidebar_tabs_bot_artifacts_singleton_idx')).toBe(true);
  });

  it('enforces canonical and artifact-tab uniqueness without reviving retired sidebar rules', () => {
    const db = createDb();
    runBotMigrations(db);
    db.exec(`
      INSERT INTO bot_profiles (id, display_name, created_at, updated_at)
        VALUES ('bot-1', 'Bot One', 1, 1);
      INSERT INTO sessions (id, status) VALUES
        ('session-1', 'active'), ('session-2', 'active');
      INSERT INTO bot_session_links
        (id, bot_id, session_id, profile_version, role, created_at)
        VALUES ('canonical-1', 'bot-1', 'session-1', 1, 'canonical', 1);
      INSERT INTO right_sidebar_tabs (id, session_id, kind)
        VALUES ('tab-1', 'session-1', 'bot-delegations');
    `);

    expect(() => db.prepare(`INSERT INTO bot_session_links
      (id, bot_id, session_id, profile_version, role, created_at)
      VALUES ('canonical-2', 'bot-1', 'session-2', 1, 'canonical', 2)`).run()).toThrow();
    // The retired delegation sidebar kind remains readable for old databases,
    // but no longer owns a schema-level singleton or a live UI surface.
    expect(() => db.prepare(`INSERT INTO right_sidebar_tabs (id, session_id, kind)
      VALUES ('tab-2', 'session-1', 'bot-delegations')`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO right_sidebar_tabs (id, session_id, kind)
      VALUES ('tab-3', 'session-1', 'bot-artifacts')`).run()).not.toThrow();
  });
});
