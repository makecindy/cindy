import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runMigrationReplay } from '../migrationRunner';

const MIGRATION = '0092_motionless_hiroim.sql';
const cleanups: Array<() => void> = [];

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

function runBotMigration(db: ReturnType<typeof createBetterSqliteDatabase>): void {
  const desktopRoot = path.resolve(__dirname, '../../../..');
  const stagedDir = mkdtempSync(path.join(tmpdir(), 'cindy-bot-migration-step-'));
  copyFileSync(path.join(desktopRoot, 'drizzle', MIGRATION), path.join(stagedDir, MIGRATION));
  mkdirSync(path.join(stagedDir, 'scripts'));
  copyFileSync(
    path.join(desktopRoot, 'drizzle', 'scripts', MIGRATION.replace(/\.sql$/, '.ts')),
    path.join(stagedDir, 'scripts', MIGRATION.replace(/\.sql$/, '.ts')),
  );
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

describe('Bot release migration', () => {
  it('creates the final Bot schema after the published main migration lineage', () => {
    const db = createDb();
    runBotMigration(db);

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
    expect(indexExists(db, 'uniq_bot_session_links_route')).toBe(true);
    expect(indexExists(db, 'uniq_bot_workspace_leases_active_binding_key')).toBe(true);
    expect(indexExists(db, 'right_sidebar_tabs_bot_delegations_singleton_idx')).toBe(true);
  });

  it('enforces canonical, route, project, and sidebar ownership uniqueness', () => {
    const db = createDb();
    runBotMigration(db);
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
