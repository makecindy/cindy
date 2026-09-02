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
      hidden_at INTEGER,
      pinned_at INTEGER,
      attention_reason TEXT,
      attention_at INTEGER,
      current_version INTEGER NOT NULL DEFAULT 1,
      canonical_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      profile_version INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL,
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
    INSERT INTO bot_profiles (
      id, display_name, description, avatar, avatar_color, status,
      current_version, canonical_session_id, created_at, updated_at
    ) VALUES (
      'bot-1', 'Helper', '', '🤖', 'violet', 'active', 1, 'canonical', 1, 1
    );
    INSERT INTO bot_session_links VALUES
      ('link-canonical', 'bot-1', 'canonical', 1, 'canonical', NULL, 1, NULL),
      ('link-delegation', 'bot-1', 'delegation-session', 1, 'delegation', 'delegation:d-1', 1, NULL);
    INSERT INTO sessions VALUES
      ('canonical', 'bot', 'active', 1),
      ('delegation-session', 'bot', 'active', 1);
  `);
  return sqlite;
}

function row(sqlite: Database.Database, table: string, id: string) {
  return sqlite.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
}

describe('Bot lifecycle coordinator', () => {
  let sqlite: Database.Database;
  let closeSession: ReturnType<typeof vi.fn>;
  let cancelDelegationsForBot: ReturnType<typeof vi.fn>;
  let deleteProfileAndDetachSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sqlite = createDatabase();
    const db = drizzle(sqlite);
    h.db = db;
    h.tx = async (name, args) => runWorkerTx(sqlite, { name: name as never, args } as never);
    closeSession = vi.fn(async () => undefined);
    cancelDelegationsForBot = vi.fn(async () => 2);
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
      deleteProfileAndDetachSessions,
      now: () => 10,
    });
  }

  it('pauses the Bot and closes its linked sessions', async () => {
    const result = await service().run({ botId: 'bot-1', action: 'pause' });

    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('paused');
    expect(
      sqlite.prepare(
        "SELECT session_id FROM bot_lifecycle_events WHERE event_type = 'pause-requested'",
      ).get(),
    ).toEqual({ session_id: 'canonical' });
    expect(cancelDelegationsForBot).toHaveBeenCalledWith('bot-1', expect.any(String));
    expect(closeSession).toHaveBeenCalledTimes(2);
    expect(closeSession).toHaveBeenCalledWith('canonical');
    expect(closeSession).toHaveBeenCalledWith('delegation-session');
    expect(result).toMatchObject({ status: 'paused', affected: { sessions: 2, delegations: 2 } });
  });

  it('uses the canonical registry even when the compatibility mirror disagrees', async () => {
    sqlite.prepare(
      "UPDATE bot_profiles SET canonical_session_id = 'stale-mirror' WHERE id = 'bot-1'",
    ).run();

    await service().run({ botId: 'bot-1', action: 'pause' });

    expect(
      sqlite.prepare(
        "SELECT session_id FROM bot_lifecycle_events WHERE event_type = 'pause-requested'",
      ).get(),
    ).toEqual({ session_id: 'canonical' });
    expect(closeSession).toHaveBeenCalledWith('canonical');
    expect(closeSession).not.toHaveBeenCalledWith('stale-mirror');
  });

  it('does not reclaim a mirror-only Session when the canonical registry is missing', async () => {
    sqlite.prepare(
      "DELETE FROM bot_session_links WHERE bot_id = 'bot-1' AND role = 'canonical'",
    ).run();

    await service().run({ botId: 'bot-1', action: 'pause' });

    expect(
      sqlite.prepare(
        "SELECT session_id FROM bot_lifecycle_events WHERE event_type = 'pause-requested'",
      ).get(),
    ).toEqual({ session_id: null });
    expect(closeSession).not.toHaveBeenCalledWith('canonical');
  });

  it('resumes a paused Bot back to active', async () => {
    const lifecycle = service();
    await lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const result = await lifecycle.run({ botId: 'bot-1', action: 'resume' });

    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    expect(
      sqlite.prepare(
        "SELECT session_id FROM bot_lifecycle_events WHERE event_type = 'resumed'",
      ).get(),
    ).toEqual({ session_id: 'canonical' });
    expect(result.status).toBe('active');
  });

  it('refuses to resume or pause an archived Bot', async () => {
    sqlite.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = 'bot-1'").run();
    const lifecycle = service();

    await expect(lifecycle.run({ botId: 'bot-1', action: 'resume' })).rejects.toThrow('当前状态');
    await expect(lifecycle.run({ botId: 'bot-1', action: 'pause' })).rejects.toThrow('当前状态');
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('fails closed before touching sessions when the pause transaction loses a concurrent race', async () => {
    const realTx = h.tx!;
    h.tx = vi.fn(async (name, args) => {
      if (name === 'bots.pauseLifecycle') {
        throw Object.assign(new Error('Bot 生命周期已被另一处操作更新'), { code: 'PRECONDITION_FAILED' });
      }
      return realTx(name, args);
    });
    const lifecycle = service();

    await expect(lifecycle.run({ botId: 'bot-1', action: 'pause' })).rejects.toThrow('已被另一处操作更新');
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
    expect(cancelDelegationsForBot).not.toHaveBeenCalled();
    expect(closeSession).not.toHaveBeenCalled();
  });

  it('coalesces simultaneous lifecycle actions for one Bot', async () => {
    let release!: () => void;
    closeSession.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const lifecycle = service();
    const first = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const second = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalled());
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
  });

  it('queues a different lifecycle action instead of losing it behind pause', async () => {
    let release!: () => void;
    closeSession.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const lifecycle = service();
    const pausing = lifecycle.run({ botId: 'bot-1', action: 'pause' });
    const resuming = lifecycle.run({ botId: 'bot-1', action: 'resume' });
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalled());
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('paused');
    release();
    await pausing;
    await resuming;
    expect(row(sqlite, 'bot_profiles', 'bot-1').status).toBe('active');
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

  it('pauses, archives and detaches sessions when permanently deleting a Bot', async () => {
    const result = await service().run({
      botId: 'bot-1',
      action: 'delete',
      confirmName: 'Helper',
      keepTaskHistory: true,
    });

    expect(sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-1'").get()).toBeUndefined();
    expect(row(sqlite, 'bot_session_links', 'link-canonical').role).toBe('history');
    expect(row(sqlite, 'bot_session_links', 'link-delegation').role).toBe('history');
    expect(deleteProfileAndDetachSessions).toHaveBeenCalledWith(
      'bot-1',
      expect.arrayContaining(['canonical', 'delegation-session']),
      true,
    );
    expect(row(sqlite, 'sessions', 'canonical')).toMatchObject({
      source: 'desktop',
      status: 'archived',
    });
    expect(result).toMatchObject({ action: 'delete', status: 'deleted', affected: { sessions: 2 } });
  });

  it('keeps transcripts as ordinary deleted tasks when discarding history', async () => {
    const result = await service().run({
      botId: 'bot-1',
      action: 'delete',
      confirmName: 'Helper',
      keepTaskHistory: false,
    });

    expect(deleteProfileAndDetachSessions).toHaveBeenCalledWith(
      'bot-1',
      expect.arrayContaining(['canonical', 'delegation-session']),
      false,
    );
    expect(result).toMatchObject({ action: 'delete', status: 'deleted' });
  });
});
