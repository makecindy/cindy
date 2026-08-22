import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Maker } from '@cindy/maker-core';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  tx: null as null | ((name: string, args: unknown) => Promise<unknown>),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-bot-lifecycle-test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../schedule.js', () => ({
  awaitReadyWithTimeout: vi.fn(),
}));

vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: h.db, tx: h.tx }),
}));

import { createBotLifecycleService } from '../botLifecycleService.js';
import { tx as runWorkerTx } from '../../localDb/worker/opHandlers/tx.js';

function createDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
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
    CREATE TABLE bot_routes (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      route_key TEXT NOT NULL,
      principal_key TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      thread_key TEXT,
      current_session_id TEXT,
      project_binding_id TEXT,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      owner_device_id TEXT,
      owner_generation INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      suspended_status TEXT,
      last_activity_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_automation_links (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
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
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile_version INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL,
      channel_id TEXT,
      route_key TEXT,
      created_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE TABLE bot_lifecycle_events (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      session_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    INSERT INTO bot_profiles VALUES (
      'bot-1', 'Helper', '', '🤖', 'violet', 'active', 1, 'canonical', 1, 1
    );
    INSERT INTO bot_routes VALUES
      ('route-active', 'bot-1', 'channel-1', 'dm:a', 'a', 'dm:a', NULL, 'route-session', NULL, '{}', 'device-1', 3, 'active', NULL, 1, 1, 1),
      ('route-user-paused', 'bot-1', 'channel-1', 'dm:b', 'b', 'dm:b', NULL, NULL, NULL, '{}', NULL, 0, 'paused', NULL, NULL, 1, 1);
    INSERT INTO bot_automation_links VALUES
      ('auto-active', 'bot-1', 'schedule-active', NULL, NULL, 1, NULL, '{}', 'active', NULL, 1, 1),
      ('auto-user-paused', 'bot-1', 'schedule-paused', NULL, NULL, 1, NULL, '{}', 'paused', NULL, 1, 1);
    INSERT INTO bot_session_links VALUES
      ('link-canonical', 'bot-1', 'canonical', 1, 'canonical', NULL, NULL, 1, NULL),
      ('link-route', 'bot-1', 'route-session', 1, 'route', 'channel-1', 'dm:a', 1, NULL);
    INSERT INTO sessions VALUES
      ('canonical', 'bot', 'active', 1),
      ('route-session', 'bot', 'active', 1);
  `);
  return sqlite;
}

function row(sqlite: Database.Database, table: string, id: string) {
  return sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
}

describe('Bot lifecycle coordinator', () => {
  let sqlite: Database.Database;
  let closeSession: ReturnType<typeof vi.fn>;
  let pauseSchedule: ReturnType<typeof vi.fn>;
  let resumeSchedule: ReturnType<typeof vi.fn>;
  let cancelDelegationsForBot: ReturnType<typeof vi.fn>;
  let suspendForBot: ReturnType<typeof vi.fn>;
  let resumeForBot: ReturnType<typeof vi.fn>;
  let cancelForBot: ReturnType<typeof vi.fn>;
  let retainWorktrees: ReturnType<typeof vi.fn>;
  let releaseWorktrees: ReturnType<typeof vi.fn>;
  let createCanonicalSession: ReturnType<typeof vi.fn>;
  let deleteProfileAndDetachSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sqlite = createDatabase();
    const db = drizzle(sqlite);
    h.db = db;
    h.tx = async (name, args) => runWorkerTx(sqlite, { name: name as never, args } as never);
    closeSession = vi.fn(async () => undefined);
    pauseSchedule = vi.fn(async () => undefined);
    resumeSchedule = vi.fn(async () => undefined);
    cancelDelegationsForBot = vi.fn(async () => 2);
    suspendForBot = vi.fn(async () => 3);
    resumeForBot = vi.fn(async () => 3);
    cancelForBot = vi.fn(async () => 4);
    retainWorktrees = vi.fn(async () => 2);
    releaseWorktrees = vi.fn(async () => 2);
    createCanonicalSession = vi.fn(async () => {
      sqlite.prepare("INSERT INTO sessions VALUES ('restored-canonical', 'bot', 'active', 10)").run();
      sqlite.prepare(
        "INSERT INTO bot_session_links VALUES ('link-restored', 'bot-1', 'restored-canonical', 1, 'canonical', NULL, NULL, 10, NULL)",
      ).run();
      sqlite.prepare(
        "UPDATE bot_profiles SET canonical_session_id = 'restored-canonical', updated_at = 10 WHERE id = 'bot-1'",
      ).run();
      return { canonicalSessionId: 'restored-canonical' };
    });
    deleteProfileAndDetachSessions = vi.fn(async (
      botId: string,
      sessionIds: string[],
      keepTaskHistory: boolean,
    ) => {
      const status = keepTaskHistory ? 'archived' : 'deleted';
      for (const sessionId of sessionIds) {
        sqlite.prepare('UPDATE sessions SET source = ?, status = ? WHERE id = ?')
          .run('desktop', status, sessionId);
      }
      sqlite.prepare('DELETE FROM bot_profiles WHERE id = ?').run(botId);
    });
  });

  function service() {
    return createBotLifecycleService({
      maker: { closeSession } as unknown as Maker,
      getDelegationService: () => ({ cancelDelegationsForBot } as never),
      getOutboxService: () => ({ suspendForBot, resumeForBot, cancelForBot } as never),
      pauseSchedule,
      resumeSchedule,
      retainWorktrees,
      releaseWorktrees,
      createCanonicalSession,
      deleteProfileAndDetachSessions,
      now: () => 10,
    });
  }

  it('pauses only active resources and preserves user-paused state', async () => {
    const result = await service().run({ botId: 'bot-1', action: 'pause' });

    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('paused');
    expect(row(sqlite, 'bot_routes', 'route-active')).toMatchObject({
      status: 'paused',
      suspended_status: 'active',
      owner_generation: 4,
    });
    expect(row(sqlite, 'bot_routes', 'route-user-paused')).toMatchObject({
      status: 'paused',
      suspended_status: null,
    });
    expect(row(sqlite, 'bot_automation_links', 'auto-active')).toMatchObject({
      status: 'paused',
      suspended_status: 'active',
    });
    expect(row(sqlite, 'bot_automation_links', 'auto-user-paused')).toMatchObject({
      status: 'paused',
      suspended_status: null,
    });
    expect(pauseSchedule).toHaveBeenCalledTimes(1);
    expect(pauseSchedule).toHaveBeenCalledWith('schedule-active');
    expect(cancelDelegationsForBot).toHaveBeenCalledWith('bot-1', expect.any(String));
    expect(suspendForBot).toHaveBeenCalledWith('bot-1');
    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'paused',
      affected: { routes: 1, automations: 1, delegations: 2, deliveries: 3, sessions: 2 },
    });
  });

  it('restores only resources suspended by the Bot lifecycle', async () => {
    const lifecycle = service();
    await lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const result = await lifecycle.run({ botId: 'bot-1', action: 'resume' });

    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    expect(row(sqlite, 'bot_routes', 'route-active')).toMatchObject({
      status: 'active',
      suspended_status: null,
    });
    expect(row(sqlite, 'bot_routes', 'route-user-paused')).toMatchObject({
      status: 'paused',
      suspended_status: null,
    });
    expect(row(sqlite, 'bot_automation_links', 'auto-active')).toMatchObject({
      status: 'active',
      suspended_status: null,
    });
    expect(row(sqlite, 'bot_automation_links', 'auto-user-paused')).toMatchObject({
      status: 'paused',
      suspended_status: null,
    });
    expect(resumeSchedule).toHaveBeenCalledTimes(1);
    expect(resumeSchedule).toHaveBeenCalledWith('schedule-active');
    expect(resumeForBot).toHaveBeenCalledWith('bot-1');
    expect(result.status).toBe('active');
  });

  it('fails closed when a suspended schedule cannot resume', async () => {
    const lifecycle = service();
    await lifecycle.run({ botId: 'bot-1', action: 'pause' });
    resumeSchedule.mockRejectedValueOnce(new Error('scheduler offline'));

    await expect(lifecycle.run({ botId: 'bot-1', action: 'resume' })).rejects.toThrow(
      'Bot 仍保持暂停',
    );
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('paused');
    expect(row(sqlite, 'bot_automation_links', 'auto-active')).toMatchObject({
      status: 'paused',
      suspended_status: 'active',
    });
    expect(resumeForBot).not.toHaveBeenCalled();
  });

  it('fails closed before closing tasks or archiving when an active Automation cannot stop', async () => {
    pauseSchedule.mockRejectedValueOnce(new Error('scheduler did not acknowledge abort'));
    const lifecycle = service();

    await expect(lifecycle.run({ botId: 'bot-1', action: 'archive' })).rejects.toThrow(
      '无法安全停止',
    );

    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('paused');
    expect(row(sqlite, 'bot_automation_links', 'auto-active')).toMatchObject({
      status: 'paused',
      suspended_status: 'active',
    });
    expect(row(sqlite, 'sessions', 'canonical').status).toBe('active');
    expect(closeSession).not.toHaveBeenCalled();
    expect(cancelDelegationsForBot).not.toHaveBeenCalled();
    expect(cancelForBot).not.toHaveBeenCalled();
    expect(retainWorktrees).not.toHaveBeenCalled();
    expect(releaseWorktrees).not.toHaveBeenCalled();

    pauseSchedule.mockResolvedValueOnce(undefined);
    await expect(lifecycle.run({ botId: 'bot-1', action: 'archive' })).resolves.toMatchObject({
      status: 'archived',
    });
  });

  it('coalesces simultaneous lifecycle actions for one Bot', async () => {
    let release!: () => void;
    pauseSchedule.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const lifecycle = service();
    const first = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const second = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    await vi.waitFor(() => expect(pauseSchedule).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(pauseSchedule).toHaveBeenCalledTimes(1);
  });

  it('queues a different lifecycle action instead of losing it behind pause', async () => {
    let release!: () => void;
    pauseSchedule.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const lifecycle = service();
    const pausing = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const resuming = lifecycle.run({ botId: 'bot-1', action: 'resume' });
    await vi.waitFor(() => expect(pauseSchedule).toHaveBeenCalledTimes(1));
    expect(resumeSchedule).not.toHaveBeenCalled();
    release();
    await pausing;
    await resuming;
    expect(resumeSchedule).toHaveBeenCalledWith('schedule-active');
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
  });

  it('archives every Bot task and retains worktrees by default', async () => {
    const result = await service().run({ botId: 'bot-1', action: 'archive' });

    expect(row(sqlite, 'bot_profiles', 'bot-1')).toMatchObject({
      status: 'archived',
      canonical_session_id: null,
    });
    expect(row(sqlite, 'sessions', 'canonical').status).toBe('archived');
    expect(row(sqlite, 'sessions', 'route-session').status).toBe('archived');
    expect(row(sqlite, 'bot_session_links', 'link-canonical').role).toBe('history');
    expect(row(sqlite, 'bot_routes', 'route-active')).toMatchObject({
      status: 'paused',
      suspended_status: 'active',
    });
    expect(row(sqlite, 'bot_automation_links', 'auto-active')).toMatchObject({
      status: 'paused',
      suspended_status: 'active',
    });
    expect(cancelForBot).toHaveBeenCalledWith('bot-1', 'Bot archived');
    expect(retainWorktrees).toHaveBeenCalledWith('bot-1');
    expect(releaseWorktrees).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'archived',
      affected: { sessions: 2, routes: 2, automations: 2, deliveries: 4, worktrees: 2 },
    });
  });

  it('keeps the Bot archived when worktree recycling is safely refused', async () => {
    releaseWorktrees.mockRejectedValueOnce(new Error('worktree is dirty'));
    const result = await service().run({
      botId: 'bot-1',
      action: 'archive',
      worktreeDisposition: 'recycle',
    });

    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('archived');
    expect(result.warnings?.[0]).toContain('WORKTREE_DISPOSITION_FAILED');
    expect(retainWorktrees).not.toHaveBeenCalled();
  });

  it('restores into a fresh canonical task without reviving archived history', async () => {
    const lifecycle = service();
    await lifecycle.run({ botId: 'bot-1', action: 'archive' });
    const result = await lifecycle.run({ botId: 'bot-1', action: 'restore' });

    expect(createCanonicalSession).toHaveBeenCalledWith({
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    expect(row(sqlite, 'bot_profiles', 'bot-1')).toMatchObject({
      status: 'active',
      canonical_session_id: 'restored-canonical',
    });
    expect(row(sqlite, 'sessions', 'canonical').status).toBe('archived');
    expect(row(sqlite, 'sessions', 'route-session').status).toBe('archived');
    expect(row(sqlite, 'sessions', 'restored-canonical').status).toBe('active');
    expect(row(sqlite, 'bot_routes', 'route-active')).toMatchObject({
      status: 'active',
      suspended_status: null,
    });
    expect(row(sqlite, 'bot_routes', 'route-user-paused')).toMatchObject({
      status: 'paused',
      suspended_status: null,
    });
    expect(result).toMatchObject({
      action: 'restore',
      status: 'active',
      canonicalSessionId: 'restored-canonical',
    });
  });

  it('requires an exact Bot name before permanent deletion', async () => {
    await expect(service().run({
      botId: 'bot-1',
      action: 'delete',
      confirmName: 'helper',
    })).rejects.toThrow('完整 Bot 名称');
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    expect(deleteProfileAndDetachSessions).not.toHaveBeenCalled();
  });

  it('keeps transcripts as ordinary archived tasks when deleting a Bot', async () => {
    const result = await service().run({
      botId: 'bot-1',
      action: 'delete',
      confirmName: 'Helper',
      keepTaskHistory: true,
      worktreeDisposition: 'retain',
    });

    expect(
      sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-1'").get(),
    ).toBeUndefined();
    expect(deleteProfileAndDetachSessions).toHaveBeenCalledWith(
      'bot-1',
      ['canonical', 'route-session'],
      true,
    );
    expect(row(sqlite, 'sessions', 'canonical')).toMatchObject({
      source: 'desktop',
      status: 'archived',
    });
    expect(result).toMatchObject({ action: 'delete', status: 'deleted' });
  });
});
