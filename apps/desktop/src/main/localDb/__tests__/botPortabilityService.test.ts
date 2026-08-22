import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tar from 'tar';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  tx: null as null | ((name: string, args: unknown) => Promise<unknown>),
}));

vi.mock('../client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db, tx: h.tx }),
}));

import {
  exportBotBehaviorBundle,
  importBotBehaviorBundle,
} from '../botPortabilityService.js';
import { tx as runWorkerTx } from '../worker/opHandlers/tx.js';

describe('Bot behavior bundle round trip', () => {
  let sqlite: Database.Database;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-bot-portability-test-'));
    sqlite = new Database(':memory:');
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE bot_profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '🤖',
        avatar_color TEXT NOT NULL DEFAULT 'violet',
        status TEXT NOT NULL DEFAULT 'active',
        current_version INTEGER NOT NULL DEFAULT 1,
        canonical_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_profile_versions (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        identity_source TEXT NOT NULL DEFAULT '',
        capabilities_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        UNIQUE(bot_id, version)
      );
      CREATE TABLE bot_channels (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_automation_links (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        schedule_id TEXT,
        project_binding_id TEXT,
        target_route_id TEXT,
        created_with_profile_version INTEGER NOT NULL,
        durable_note_namespace TEXT,
        execution_policy_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'active',
        suspended_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_lifecycle_events (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        session_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        job_type TEXT NOT NULL DEFAULT 'prompt',
        job_config TEXT,
        execution_mode TEXT NOT NULL DEFAULT 'agent',
        script_config TEXT,
        source TEXT,
        project_config_id TEXT,
        legacy_session_fallback INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL DEFAULT 'cron',
        cron_expr TEXT NOT NULL,
        timezone TEXT NOT NULL,
        recurring INTEGER NOT NULL DEFAULT 1,
        manual INTEGER NOT NULL DEFAULT 0,
        interval_ms INTEGER,
        agent_kind TEXT NOT NULL,
        model TEXT,
        provider_id TEXT,
        effort TEXT,
        fast_mode INTEGER NOT NULL DEFAULT 0,
        working_dir TEXT,
        workspace_kind TEXT NOT NULL DEFAULT 'project',
        use_worktree INTEGER NOT NULL DEFAULT 0,
        target_session_id TEXT,
        persistent_session INTEGER NOT NULL DEFAULT 0,
        silent_when_idle INTEGER NOT NULL DEFAULT 0,
        pre_run_hook_command TEXT,
        pre_run_hook_timeout_ms INTEGER,
        skip_log_session_id TEXT,
        notify_desktop INTEGER NOT NULL DEFAULT 1,
        notify_feishu INTEGER NOT NULL DEFAULT 0,
        notify_wecom_group INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_fired_at INTEGER,
        last_finished_at INTEGER,
        next_fire_at INTEGER,
        expire_at INTEGER
      );
    `);
    const db = drizzle(sqlite);
    h.db = db;
    h.tx = async (name, args) => runWorkerTx(sqlite, { name: name as never, args } as never);
    sqlite.exec(`
      INSERT INTO bot_profiles VALUES
        ('bot-source', 'Release Bot', 'Ships releases', '🚀', 'blue', 'active', 1, NULL, 1, 1);
      INSERT INTO bot_profile_versions VALUES
        ('bot-source:v1', 'bot-source', 1,
         'Use sk-abcdefghijklmnopqrstuvwxyz123456 safely',
         '{"model":"claude-sonnet-4-6","harness":"claude","skills":["release"],"userContextSource":"Owner path /Users/chris/private"}', 1);
      INSERT INTO bot_channels VALUES
        ('local', 'bot-source', 'local', 1, '{}', 1, 1),
        ('telegram', 'bot-source', 'telegram', 1, '{"accountKey":"secret-account"}', 1, 1);
    `);
  });

  afterEach(async () => {
    sqlite.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('exports a redacted behavior package and imports it without bindings or runtime state', async () => {
    const archive = path.join(tempDir, 'release.cindybot');
    const exported = await exportBotBehaviorBundle('bot-source', archive);
    expect(exported.redactionCount).toBeGreaterThan(0);

    sqlite.exec("DELETE FROM bot_profiles WHERE id = 'bot-source'");
    const imported = await importBotBehaviorBundle(archive);
    expect(imported.canceled).toBe(false);
    expect(imported.disabledChannels).toEqual(['telegram']);

    const profile = sqlite.prepare(
      'SELECT display_name, canonical_session_id FROM bot_profiles WHERE id = ?',
    ).get(imported.botId) as { display_name: string; canonical_session_id: string | null };
    expect(profile).toEqual({ display_name: 'Release Bot', canonical_session_id: null });

    const channels = sqlite.prepare(
      'SELECT kind, enabled, config_json FROM bot_channels WHERE bot_id = ? ORDER BY kind',
    ).all(imported.botId);
    expect(channels).toEqual([
      { kind: 'local', enabled: 1, config_json: '{}' },
      { kind: 'telegram', enabled: 0, config_json: '{}' },
    ]);

    const version = sqlite.prepare(
      'SELECT identity_source, capabilities_json FROM bot_profile_versions WHERE bot_id = ?',
    ).get(imported.botId) as { identity_source: string; capabilities_json: string };
    expect(version.identity_source).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
    expect(version.capabilities_json).not.toContain('/Users/chris/private');
    expect(version.capabilities_json).not.toContain('secret-account');
    expect(JSON.parse(version.capabilities_json)).toMatchObject({
      permissions: 'ask',
      automation: false,
    });
  });

  it('refuses to overwrite an existing Bot with the same name', async () => {
    const archive = path.join(tempDir, 'release.cindybot');
    await exportBotBehaviorBundle('bot-source', archive);
    await expect(importBotBehaviorBundle(archive)).rejects.toThrow('不会覆盖现有 Bot');
    expect(sqlite.prepare('SELECT count(*) AS count FROM bot_profiles').get()).toEqual({ count: 1 });
  });

  it('rejects undeclared files even when the tar paths themselves are safe', async () => {
    const root = path.join(tempDir, 'malicious');
    await fs.mkdir(root);
    await Promise.all([
      fs.writeFile(path.join(root, 'bot.json'), '{}'),
      fs.writeFile(path.join(root, 'SOUL.md'), ''),
      fs.writeFile(path.join(root, 'USER.md'), ''),
      fs.writeFile(path.join(root, 'auth.json'), '{"token":"secret"}'),
    ]);
    const archive = path.join(tempDir, 'malicious.cindybot');
    await tar.c({ gzip: true, cwd: tempDir, file: archive }, ['malicious']);
    await expect(importBotBehaviorBundle(archive)).rejects.toThrow('未声明文件');
  });
});
