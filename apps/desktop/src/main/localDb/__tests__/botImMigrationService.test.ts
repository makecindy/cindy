import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BotChannelConnection } from '../../../shared/botChannelRegistry.js';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
  tx: null as null | ((name: string, args: unknown) => Promise<unknown>),
  bindingPath: '',
  connection: {
    id: 'local:telegram:bot-account',
    kind: 'telegram' as const,
    ownership: 'local-adapter' as const,
    status: 'connected',
    connected: true,
    accountKey: 'bot-account',
    accountName: 'Personal Telegram',
    scopeKey: 'bot-account',
    routable: true,
    features: ['direct-messages', 'groups'] as const,
  } as BotChannelConnection,
  closeSession: vi.fn(async () => undefined),
  broadcastSessionPatched: vi.fn(),
  notifyAgentIslandSessionPatch: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/cindy-bot-im-migration-test') },
}));

vi.mock('../client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db, tx: h.tx }),
}));
vi.mock('../../im/index.js', () => ({
  listBotChannelConnections: () => [h.connection],
}));
vi.mock('../../im/accountBoundary.js', () => ({
  runImMigrationExclusive: async <T>(_scope: string, operation: () => Promise<T>) => operation(),
}));
vi.mock('../../hook-control/ipc.js', () => ({
  runHookBotMigrationExclusive: async <T>(_scope: string, operation: () => Promise<T>) =>
    operation(),
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: () => h.bindingPath,
}));
vi.mock('../../maker-host/index.js', () => ({
  getMakerIfReady: () => ({ closeSession: h.closeSession }),
}));
vi.mock('../ipc/sessions.js', () => ({
  broadcastSessionPatched: h.broadcastSessionPatched,
}));
vi.mock('../agentIslandSessionPatch.js', () => ({
  notifyAgentIslandSessionPatch: h.notifyAgentIslandSessionPatch,
}));

import {
  applyBotImMigration,
  planBotImMigration,
  rollbackBotImMigration,
} from '../botImMigrationService.js';
import { upsertBotRoute } from '../botRouteService.js';
import { tx as runWorkerTx } from '../worker/opHandlers/tx.js';

function createDb(): ReturnType<typeof drizzle> {
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
      source TEXT NOT NULL DEFAULT 'desktop',
      feishu_bot_app_id TEXT,
      feishu_open_id TEXT,
      im_bot_context_id TEXT,
      im_user_id TEXT,
      used_project_context INTEGER NOT NULL DEFAULT 0,
      one_m INTEGER NOT NULL DEFAULT 0,
      codex_history_has_product_prompt INTEGER,
      codex_plan_json TEXT,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      active_turn_started_at INTEGER,
      active_turn_pid INTEGER,
      last_turn_ended_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '🤖',
      avatar_color TEXT NOT NULL DEFAULT 'violet',
      status TEXT NOT NULL DEFAULT 'active',
      current_version INTEGER NOT NULL DEFAULT 1,
      canonical_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_channels (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_routes (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
      route_key TEXT NOT NULL,
      principal_key TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      thread_key TEXT,
      current_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      project_binding_id TEXT,
      capabilities_json TEXT NOT NULL,
      owner_device_id TEXT,
      owner_generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      suspended_status TEXT,
      last_activity_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_bot_routes_channel_route ON bot_routes(channel_id, route_key);
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      profile_version INTEGER NOT NULL,
      role TEXT NOT NULL,
      channel_id TEXT REFERENCES bot_channels(id) ON DELETE SET NULL,
      route_key TEXT,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_bot_session_links_session ON bot_session_links(session_id);
    CREATE TABLE im_bindings (
      channel TEXT NOT NULL,
      bot_context_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      target_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      attached_at INTEGER NOT NULL,
      attached_via_card_message_id TEXT,
      PRIMARY KEY(channel, bot_context_id, user_id, scope_key)
    );
    CREATE TABLE bot_im_migrations (
      id TEXT PRIMARY KEY NOT NULL,
      request_id TEXT NOT NULL UNIQUE,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
      route_id TEXT NOT NULL REFERENCES bot_routes(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL,
      ownership TEXT NOT NULL,
      kind TEXT NOT NULL,
      account_key TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      channel_before_json TEXT,
      route_before_json TEXT,
      adapter_bindings_json TEXT NOT NULL,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      applied_at INTEGER,
      rolled_back_at INTEGER
    );
    CREATE TABLE bot_im_migration_items (
      id TEXT PRIMARY KEY NOT NULL,
      migration_id TEXT NOT NULL REFERENCES bot_im_migrations(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      original_status TEXT NOT NULL,
      history_link_created INTEGER NOT NULL,
      session_archived INTEGER NOT NULL,
      applied_session_updated_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      rolled_back_at INTEGER
    );
    CREATE TABLE bot_lifecycle_events (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  h.sqlite = sqlite;
  const db = drizzle(sqlite);
  h.tx = async (name, args) => runWorkerTx(sqlite, { name: name as never, args } as never);
  return db;
}

beforeEach(async () => {
  h.closeSession.mockClear();
  h.broadcastSessionPatched.mockClear();
  h.notifyAgentIslandSessionPatch.mockClear();
  h.bindingPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-bot-im-migration-')),
    'hook-bindings.json',
  );
  h.connection = {
    id: 'local:telegram:bot-account',
    kind: 'telegram',
    ownership: 'local-adapter',
    status: 'connected',
    connected: true,
    accountKey: 'bot-account',
    accountName: 'Personal Telegram',
    scopeKey: 'bot-account',
    routable: true,
    features: ['direct-messages', 'groups'],
  };
  h.db = createDb();
  await h.db.insert((await import('../schema.js')).botProfiles).values({
    id: 'bot-1',
    displayName: 'Bot One',
    description: '',
    avatar: '🤖',
    avatarColor: 'violet',
    status: 'active',
    currentVersion: 3,
    canonicalSessionId: null,
    createdAt: 1,
    updatedAt: 1,
  });
  await h.db.insert((await import('../schema.js')).sessions).values({
    id: 'legacy-1',
    title: 'Legacy Telegram task',
    status: 'active',
    source: 'telegram',
    imBotContextId: 'bot-account',
    updatedAt: 10,
    createdAt: 10,
  });
});

afterEach(() => {
  fs.rmSync(path.dirname(h.bindingPath), { recursive: true, force: true });
});

describe('Bot IM migration service', () => {
  it('returns the same persisted Route when a lane is upserted concurrently', async () => {
    const schema = await import('../schema.js');
    await h.db!.insert(schema.botChannels).values({
      id: 'bot-1:telegram',
      botId: 'bot-1',
      kind: 'telegram',
      enabled: true,
      configJson: JSON.stringify({
        accountKey: 'bot-account',
        ownership: 'local-adapter',
      }),
      createdAt: 1,
      updatedAt: 1,
    });

    const [first, second] = await Promise.all([
      upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:telegram',
        routeKey: 'lane:stable',
        principalKey: 'chat-1',
      }),
      upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:telegram',
        routeKey: 'lane:stable',
        principalKey: 'chat-1',
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect(await h.db!.select().from(schema.botRoutes)).toHaveLength(1);
  });

  it('plans, atomically archives and links a legacy task without changing its source', async () => {
    const plan = await planBotImMigration({ botId: 'bot-1', connectionId: h.connection.id });
    expect(plan.canApply).toBe(true);
    expect(plan.candidates).toEqual([
      expect.objectContaining({ sessionId: 'legacy-1', status: 'active', source: 'telegram' }),
    ]);

    const applied = await applyBotImMigration({
      botId: 'bot-1',
      connectionId: h.connection.id,
      planHash: plan.planHash,
      requestId: 'request-1',
    });
    expect(applied.status).toBe('applied');
    expect(applied.migratedSessionCount).toBe(1);

    const schema = await import('../schema.js');
    const [session] = await h.db!.select().from(schema.sessions);
    expect(session.source).toBe('telegram');
    expect(session.status).toBe('archived');
    const [link] = await h.db!.select().from(schema.botSessionLinks);
    expect(link).toMatchObject({ botId: 'bot-1', sessionId: 'legacy-1', role: 'history' });
    const [channel] = await h.db!.select().from(schema.botChannels);
    expect(channel.enabled).toBe(true);
    expect(JSON.parse(channel.configJson)).toMatchObject({
      accountKey: 'bot-account',
      ownership: 'local-adapter',
    });
    const [mountSentinel] = await h.db!.select().from(schema.botRoutes);
    expect(JSON.parse(mountSentinel!.capabilitiesJson)).toMatchObject({ mountOnly: true });
    expect(mountSentinel!.currentSessionId).toBeNull();
    expect(h.closeSession).toHaveBeenCalledWith('legacy-1');
    expect(h.broadcastSessionPatched).toHaveBeenCalledWith('legacy-1', {
      status: 'archived',
    });

    const replay = await applyBotImMigration({
      botId: 'bot-1',
      connectionId: h.connection.id,
      planHash: plan.planHash,
      requestId: 'request-1',
    });
    expect(replay.id).toBe(applied.id);
    expect(await h.db!.select().from(schema.botImMigrationItems)).toHaveLength(1);
  });

  it('blocks migration while a legacy /ctr takeover still targets a candidate', async () => {
    const schema = await import('../schema.js');
    await h.db!.insert(schema.imBindings).values({
      channel: 'telegram',
      botContextId: 'bot-account',
      userId: 'owner',
      scopeKey: '',
      targetSessionId: 'legacy-1',
      attachedAt: 20,
      attachedViaCardMessageId: null,
    });

    const plan = await planBotImMigration({ botId: 'bot-1', connectionId: h.connection.id });
    expect(plan.canApply).toBe(false);
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({ code: 'im-takeover-active', sessionId: 'legacy-1' }),
    );
  });

  it('rolls back migration-owned state but preserves later manual Session changes', async () => {
    const schema = await import('../schema.js');
    const plan = await planBotImMigration({ botId: 'bot-1', connectionId: h.connection.id });
    const applied = await applyBotImMigration({
      botId: 'bot-1',
      connectionId: h.connection.id,
      planHash: plan.planHash,
      requestId: 'request-rollback',
    });
    await h
      .db!.update(schema.sessions)
      .set({ title: 'User changed this history', updatedAt: Date.now() + 10_000 })
      .where((await import('drizzle-orm')).eq(schema.sessions.id, 'legacy-1'));

    const rolledBack = await rollbackBotImMigration(applied.id);
    expect(rolledBack.status).toBe('rolled-back');
    const [session] = await h.db!.select().from(schema.sessions);
    expect(session.status).toBe('archived');
    expect(session.title).toBe('User changed this history');
    expect(await h.db!.select().from(schema.botSessionLinks)).toHaveLength(0);
    const [channel] = await h.db!.select().from(schema.botChannels);
    expect(channel.enabled).toBe(false);
  });

  it('restores an unchanged active legacy task on successful rollback', async () => {
    const schema = await import('../schema.js');
    const plan = await planBotImMigration({ botId: 'bot-1', connectionId: h.connection.id });
    const applied = await applyBotImMigration({
      botId: 'bot-1',
      connectionId: h.connection.id,
      planHash: plan.planHash,
      requestId: 'request-clean-rollback',
    });

    const rolledBack = await rollbackBotImMigration(applied.id);
    expect(rolledBack.status).toBe('rolled-back');
    const [session] = await h.db!.select().from(schema.sessions);
    expect(session.status).toBe('active');
    expect(h.broadcastSessionPatched).toHaveBeenLastCalledWith('legacy-1', {
      status: 'active',
    });
  });

  it('blocks ambiguous legacy Slack bindings that have no workspace identity', async () => {
    h.connection = {
      id: 'relay:slack:T1',
      kind: 'slack',
      ownership: 'server-relay',
      status: 'connected',
      connected: true,
      accountKey: 'T1',
      accountName: 'Workspace One',
      scopeKey: 'T1',
      routable: true,
      features: ['direct-messages', 'threads'],
    };
    fs.writeFileSync(
      h.bindingPath,
      JSON.stringify({
        'slack:account:slack': {
          'team-slack:C1:1.1': { sessionId: 'legacy-1', updatedAt: 10 },
        },
      }),
      'utf-8',
    );

    const plan = await planBotImMigration({ botId: 'bot-1', connectionId: h.connection.id });
    expect(plan.canApply).toBe(false);
    expect(plan.conflicts).toContainEqual(
      expect.objectContaining({ code: 'ambiguous-legacy-binding' }),
    );
  });

  it('removes and restores real relay binding files, then resumes rolling-back after a crash', async () => {
    const schema = await import('../schema.js');
    h.connection = {
      id: 'relay:telegram:binding-1',
      kind: 'telegram',
      ownership: 'server-relay',
      status: 'connected',
      connected: true,
      accountKey: 'bot-account',
      accountName: 'Official Telegram',
      scopeKey: 'bot-account',
      routable: true,
      features: ['direct-messages', 'durable-delivery'],
    };
    fs.writeFileSync(
      h.bindingPath,
      JSON.stringify({
        'telegram:account:telegram': {
          'telegram:dm:bot-account:user-1:g1': {
            sessionId: 'legacy-1',
            updatedAt: 10,
          },
        },
      }),
      'utf-8',
    );
    const plan = await planBotImMigration({ botId: 'bot-1', connectionId: h.connection.id });
    const applied = await applyBotImMigration({
      botId: 'bot-1',
      connectionId: h.connection.id,
      planHash: plan.planHash,
      requestId: 'request-relay-file',
    });
    expect(fs.readFileSync(h.bindingPath, 'utf-8')).not.toContain('legacy-1');

    // Simulate the process dying after the rollback transaction committed but
    // before the binding file and terminal audit state were finalized.
    const { eq } = await import('drizzle-orm');
    await h
      .db!.update(schema.sessions)
      .set({ status: 'active', updatedAt: 30 })
      .where(eq(schema.sessions.id, 'legacy-1'));
    await h
      .db!.delete(schema.botSessionLinks)
      .where(eq(schema.botSessionLinks.sessionId, 'legacy-1'));
    await h
      .db!.update(schema.botChannels)
      .set({ enabled: false, updatedAt: 30 })
      .where(eq(schema.botChannels.botId, 'bot-1'));
    await h
      .db!.update(schema.botRoutes)
      .set({ currentSessionId: null, status: 'archived', updatedAt: 30 })
      .where(eq(schema.botRoutes.botId, 'bot-1'));
    await h
      .db!.update(schema.botImMigrations)
      .set({ status: 'rolling-back' })
      .where(eq(schema.botImMigrations.id, applied.id));

    const recovered = await rollbackBotImMigration(applied.id);
    expect(recovered.status).toBe('rolled-back');
    expect(fs.readFileSync(h.bindingPath, 'utf-8')).toContain('legacy-1');
    expect((await h.db!.select().from(schema.sessions))[0]?.status).toBe('active');
  });
});
