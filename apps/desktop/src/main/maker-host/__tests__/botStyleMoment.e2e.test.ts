/**
 * Host-level e2e for #4124 / #4128: Bot communication style → hydrate prompt,
 * and Bot moment memory → real store / MEMORY.md / next-session snapshot.
 *
 * True components: worker txs, hydrateBotProfileRuntime, MakerMemoryManager.
 * Electron is the vitest stub. SQLite is real better-sqlite3 (no store mocks).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';
import { MakerMemoryManager } from '../../../../../../packages/maker-core/src/memory/manager.js';
import {
  buildBotMemoryScopeKey,
  memoryScopeDirName,
  parseBotMemoryScopeKey,
} from '../../../../../../packages/maker-core/src/memory/storage.js';
import { MemoryError } from '../../../../../../packages/maker-core/src/memory/types.js';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current';
import type { DbClient } from '../../localDb/client/DbClient';
import {
  botLifecycleEvents,
  botProfiles,
  botProfileVersions,
  botRuntimeSnapshots,
  botSessionLinks,
  sessions,
} from '../../localDb/schema';
import { tx as runWorkerTx } from '../../localDb/worker/opHandlers/tx';
import { hydrateBotProfileRuntime } from '../../maker-ipc/botProfileRuntime';
import type { MakerSessionCreateOpts } from '../../maker-ipc/sessionRequest';

const BOT_ID = 'style-moment-bot';
const SESSION_ID = 'canonical-style-moment';
const WARM_STYLE = {
  tone: 'warm',
  addressUserAs: 'Chris',
  selfName: '小助',
  replyLength: 'short',
  emojiDensity: 'none',
} as const;
const CUSTOM_TONE = '像实验室记录员一样说话，先结论后依据。';

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function openHarnessDb(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL DEFAULT 'New Maker',
      working_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'ask',
      status TEXT NOT NULL DEFAULT 'active',
      sdk_session_id TEXT,
      total_token_usage INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      total_cost_amount REAL NOT NULL DEFAULT 0,
      total_cost_currency TEXT,
      total_cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      context_tokens INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 0,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      summary TEXT,
      provider_id TEXT,
      user_send_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      orca_role TEXT,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      writable_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      source TEXT NOT NULL DEFAULT 'desktop',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      feishu_open_id TEXT,
      feishu_bot_app_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      one_m INTEGER NOT NULL DEFAULT 0,
      codex_history_has_product_prompt INTEGER,
      codex_plan_json TEXT,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER,
      list_preview TEXT,
      list_preview_role TEXT,
      list_message_count INTEGER
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT DEFAULT '' NOT NULL,
      avatar TEXT DEFAULT '🤖' NOT NULL,
      avatar_color TEXT DEFAULT 'violet' NOT NULL,
      status TEXT DEFAULT 'active' NOT NULL,
      hidden_at INTEGER,
      pinned_at INTEGER,
      attention_reason TEXT,
      attention_at INTEGER,
      current_version INTEGER DEFAULT 1 NOT NULL,
      canonical_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_profile_versions (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      identity_source TEXT DEFAULT '' NOT NULL,
      capabilities_json TEXT DEFAULT '{}' NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_bot_profile_versions_bot_version
      ON bot_profile_versions(bot_id, version);
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      profile_version INTEGER DEFAULT 1 NOT NULL,
      role TEXT NOT NULL,
      route_key TEXT,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_bot_session_links_session ON bot_session_links(session_id);
    CREATE UNIQUE INDEX uniq_bot_session_links_canonical_per_bot
      ON bot_session_links(bot_id) WHERE role = 'canonical';
    CREATE TABLE bot_runtime_snapshots (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      profile_version INTEGER NOT NULL,
      agent_kind TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      memory_scope_key TEXT,
      configured_json TEXT DEFAULT '{}' NOT NULL,
      resolved_json TEXT DEFAULT '{}' NOT NULL,
      status TEXT NOT NULL,
      prepared_at INTEGER DEFAULT 0 NOT NULL,
      applied_at INTEGER,
      failed_at INTEGER,
      failure_json TEXT
    );
    CREATE TABLE bot_lifecycle_events (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT DEFAULT '{}' NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return sqlite;
}

function capabilitiesJson(style?: unknown): string {
  return JSON.stringify({
    permissions: 'auto',
    memory: true,
    ...(style ? { style } : {}),
  });
}

describe('Bot style + moment host e2e', () => {
  let sqlite: Database.Database;
  let memoryRoot: string;
  let manager: MakerMemoryManager;
  let botScope: string;

  async function runTx(name: string, args: unknown): Promise<unknown> {
    return runWorkerTx(sqlite, { name, args });
  }

  async function seedBot(style?: unknown): Promise<void> {
    const now = Date.now();
    await runTx('bots.createProfile', {
      id: BOT_ID,
      displayName: '风格时刻伙伴',
      description: '',
      avatar: '🤖',
      avatarColor: 'violet',
      identitySource: '你是测试用的伙伴。身份以这段 SOUL 为准。',
      capabilitiesJson: capabilitiesJson(style),
      now,
    });
    const created = await runTx('bots.replaceCanonicalSession', {
      botId: BOT_ID,
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
      session: {
        id: SESSION_ID,
        title: '风格时刻伙伴',
        workingDir: path.join(memoryRoot, 'workspace'),
        workspaceKind: 'dialogue',
        model: 'gpt-5.4',
        effort: 'high',
        permissionMode: 'ask',
        agentKind: 'codex',
        remoteHostId: null,
        providerId: null,
        extraDirs: '[]',
        source: 'bot',
        createdAt: now + 1,
        updatedAt: now + 1,
      },
      now: now + 1,
    });
    expect(created).toMatchObject({ created: true, canonicalSessionId: SESSION_ID });
  }

  async function updateStyle(style: unknown | null, expectedCurrentVersion: number): Promise<number> {
    const now = Date.now();
    const result = (await runTx('bots.updateProfile', {
      id: BOT_ID,
      identitySource: '你是测试用的伙伴。身份以这段 SOUL 为准。',
      capabilitiesJson: capabilitiesJson(style ?? undefined),
      profileContentChanged: true,
      expectedCurrentVersion,
      now,
    })) as { currentVersion: number };
    return result.currentVersion;
  }

  function sessionOpts(): MakerSessionCreateOpts {
    return {
      id: SESSION_ID,
      agentKind: 'codex',
      workingDir: path.join(memoryRoot, 'workspace'),
      workspaceKind: 'dialogue',
      model: 'gpt-5.4',
      permissionMode: 'ask',
    };
  }

  async function hydrate(opts = sessionOpts()) {
    return hydrateBotProfileRuntime(
      opts,
      {
        readMemoryIndex: async (scopeKey) => {
          const store = await manager.getStore(scopeKey);
          return store.getIndex();
        },
      },
      { persistSnapshot: false },
    );
  }

  function momentArgs(name: string, overrides: Record<string, unknown> = {}) {
    return {
      type: 'moment' as const,
      name,
      title: `时刻 ${name}`,
      description: `${name} 的一句话`,
      body: `${name} 的正文：用户确认过的重要节点。`,
      ...overrides,
    };
  }

  beforeEach(async () => {
    memoryRoot = await mkdtemp(path.join(tmpdir(), 'cindy-bot-style-moment-e2e-'));
    sqlite = openHarnessDb();
    const drizzleDb = drizzle(sqlite, {
      schema: {
        sessions,
        botProfiles,
        botProfileVersions,
        botSessionLinks,
        botRuntimeSnapshots,
        botLifecycleEvents,
      },
    });
    const client = {
      drizzle: drizzleDb,
      tx: async (name: string, args: unknown) => runWorkerTx(sqlite, { name, args }) as never,
      query: async () => [],
      queryOne: async () => undefined,
      exec: async () => ({ changes: 0, lastInsertRowid: 0 }),
      vecAvailable: false,
      dispose: async () => undefined,
    } as unknown as DbClient;
    setCurrentDbClient(client, 'e2e-style-moment');
    botScope = buildBotMemoryScopeKey(BOT_ID);
    manager = new MakerMemoryManager({
      basePath: memoryRoot,
      sqliteFactory: (filePath) => {
        mkdirSync(path.dirname(filePath), { recursive: true });
        return new Database(filePath);
      },
      agents: {},
      logger: noopLogger,
      initialEnabled: true,
      ownerScopeKey: () => 'e2e-owner:1',
      isIndependentScope: (scopeKey) => parseBotMemoryScopeKey(scopeKey) !== null,
      config: { maxMomentIndexEntries: 2 },
    });
  });

  afterEach(async () => {
    manager.dispose();
    sqlite.close();
    clearCurrentDbClient();
    await rm(memoryRoot, { recursive: true, force: true });
  });

  it('persists style through worker txs and injects 说话习惯 on hydrate', async () => {
    await seedBot(WARM_STYLE);
    const opts = sessionOpts();
    await hydrate(opts);

    const stable = opts.botProfileContextPrompt ?? '';
    expect(stable).toContain('## 说话习惯');
    expect(stable).toContain('温暖、亲近');
    expect(stable).toContain('「Chris」');
    expect(stable).toContain('「小助」');
    expect(stable).toContain('不要使用 emoji');
    expect(stable).toContain('用 memory_write 记成 type moment');
    expect(stable).not.toContain('bot_memory(action:"write")');

    const piOpts = { ...sessionOpts(), agentKind: 'pi' as const };
    await hydrate(piOpts);
    expect(piOpts.botProfileContextPrompt).toContain('用 bot_memory(action:"write")记成 type "moment"');
    expect(piOpts.botProfileContextPrompt).not.toContain('用 memory_write 记成 type moment');

    await updateStyle({ tone: 'professional' }, 1);
    const afterProfessional = sessionOpts();
    await hydrate(afterProfessional);
    expect(afterProfessional.botProfileContextPrompt).toContain('专业、克制');
    expect(afterProfessional.botProfileContextPrompt).not.toContain('温暖、亲近');

    await updateStyle({ tone: 'custom', customTone: CUSTOM_TONE }, 2);
    const afterCustom = sessionOpts();
    await hydrate(afterCustom);
    expect(afterCustom.botProfileContextPrompt).toContain(CUSTOM_TONE);
    expect(afterCustom.botProfileContextPrompt).not.toContain('专业、克制');

    await updateStyle(null, 3);
    const afterClear = sessionOpts();
    await hydrate(afterClear);
    expect(afterClear.botProfileContextPrompt ?? '').not.toContain('## 说话习惯');

    const snapshots = sqlite
      .prepare('SELECT id FROM bot_runtime_snapshots WHERE session_id = ?')
      .all(SESSION_ID);
    expect(snapshots).toEqual([]);
  });

  it('writes bot moments onto disk, indexes them, and rejects project-scope moment', async () => {
    await seedBot(WARM_STYLE);

    const written = await manager.write(botScope, momentArgs('first-deep-dive', {
      occurredAt: '2026-09-08',
      significance: 'high',
      sourceSession: SESSION_ID,
    }));
    expect(written.ok).toBe(true);
    expect(written.filename).toBe('moment_first-deep-dive.md');
    expect(existsSync(path.join(
      memoryRoot,
      'maker-memory',
      memoryScopeDirName(botScope),
      'moment_first-deep-dive.md',
    ))).toBe(true);

    const store = await manager.getStore(botScope);
    const record = await store.read('moment_first-deep-dive.md');
    expect(record.frontmatter.type).toBe('moment');
    expect(record.frontmatter.occurredAt).toBe('2026-09-08');
    expect(record.frontmatter.significance).toBe('high');
    expect(record.frontmatter.sourceSession).toBe(SESSION_ID);
    expect(record.body).toContain('用户确认过的重要节点');

    await manager.write(botScope, momentArgs('m1', { occurredAt: '2026-06-01' }));
    await manager.write(botScope, momentArgs('m2', { occurredAt: '2026-07-01' }));
    await manager.write(botScope, momentArgs('m3', { occurredAt: '2026-08-01' }));

    const index = await store.getIndex();
    expect(index).toContain('## moment');
    expect(index).toContain('moment_first-deep-dive.md');
    expect(index).toContain('moment_m3.md');
    expect(index).not.toContain('moment_m2.md');
    expect(index).not.toContain('moment_m1.md');
    expect(index).toContain('_(仅显示最近 2 条时刻; 更早的内容用 memory_search 检索)_');
    expect(index.indexOf('moment_first-deep-dive.md')).toBeLessThan(index.indexOf('moment_m3.md'));

    const overflowHits = await store.search('m1', { type: 'moment' });
    expect(overflowHits.some((hit) => hit.filename === 'moment_m1.md')).toBe(true);

    const projectDir = path.join(memoryRoot, 'project-workdir');
    mkdirSync(projectDir, { recursive: true });
    await expect(manager.write(projectDir, momentArgs('project-leak'))).rejects.toBeInstanceOf(MemoryError);
    await expect(manager.write(projectDir, momentArgs('project-leak'))).rejects.toMatchObject({
      code: 'invalid-type',
    });

    const opts = sessionOpts();
    const snapshot = await hydrate(opts);
    expect(snapshot).toMatchObject({ botId: BOT_ID, sessionId: SESSION_ID });
    expect(opts.makerMemoryScopeKey).toBe(botScope);
    expect(opts.makerMemoryIndexSnapshot).toContain('## Bot Memory');
    expect(opts.makerMemoryIndexSnapshot).toContain('This is the only durable memory for this Bot. Memory tools operate only on this Bot Home.');
    expect(opts.makerMemoryIndexSnapshot).toContain('## moment');
    expect(opts.makerMemoryIndexSnapshot).toContain('时刻 first-deep-dive');
    expect(opts.makerMemoryIndexSnapshot).toContain('_(仅显示最近 2 条时刻; 更早的内容用 memory_search 检索)_');
    expect(opts.botProfileContextPrompt).toContain('## 说话习惯');

    const piOpts = { ...sessionOpts(), agentKind: 'pi' as const };
    await hydrate(piOpts);
    expect(piOpts.makerMemoryIndexSnapshot).toContain('Use the direct `bot_memory` tool');
    expect(piOpts.makerMemoryIndexSnapshot).not.toContain('Memory tools operate only on this Bot Home.');
  });
});
