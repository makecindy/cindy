import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tx } from '../../localDb/worker/opHandlers/tx.js';

function laneSession(id: string) {
  return {
    id,
    title: '周末出游',
    workingDir: '/bots/mimi/workspace',
    workspaceKind: 'dialogue',
    model: 'model-a',
    effort: 'medium',
    fastMode: false,
    permissionMode: 'ask',
    agentKind: 'cc',
    remoteHostId: null,
    providerId: null,
    extraDirs: '[]',
    source: 'bot',
    createdAt: 10,
    updatedAt: 10,
  };
}

describe('Bot group lane transactions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE bot_profiles (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, working_dir TEXT, workspace_kind TEXT, model TEXT,
        effort TEXT, permission_mode TEXT, status TEXT NOT NULL, sdk_session_id TEXT,
        total_token_usage INTEGER, total_cost_usd REAL, context_tokens INTEGER,
        context_window INTEGER, fast_mode INTEGER, plan_mode_enabled INTEGER, cleared_at INTEGER,
        pinned_at INTEGER, user_send_at INTEGER, agent_kind TEXT, orca_role TEXT,
        parent_session_id TEXT, forked_at_message_id TEXT, worktree_path TEXT, extra_dirs TEXT,
        remote_host_id TEXT, provider_id TEXT, source TEXT NOT NULL, created_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_session_links (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        profile_version INTEGER NOT NULL DEFAULT 1,
        role TEXT NOT NULL,
        route_key TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER
      );
      CREATE TABLE bot_groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, reply_mode TEXT NOT NULL DEFAULT 'all',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_group_members (
        group_id TEXT NOT NULL REFERENCES bot_groups(id) ON DELETE CASCADE,
        bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, last_seen_sequence INTEGER NOT NULL DEFAULT 0,
        joined_at INTEGER NOT NULL, PRIMARY KEY (group_id, bot_id)
      );
      INSERT INTO bot_profiles VALUES ('mimi', 'active', 3), ('abu', 'active', 1), ('kapi', 'paused', 1);
      INSERT INTO bot_groups VALUES ('g1', '周末出游', 'all', 1, 1);
      INSERT INTO bot_group_members VALUES ('g1', 'mimi', 0, 0, 1), ('g1', 'kapi', 1, 0, 1);
      INSERT INTO sessions (id, status, source, updated_at) VALUES ('mimi-main', 'active', 'bot', 1);
      INSERT INTO bot_session_links (id, bot_id, session_id, role) VALUES ('m', 'mimi', 'mimi-main', 'canonical');
    `);
  });

  afterEach(() => db.close());

  it('creates one hidden group lane per member and reuses it', () => {
    const args = { botId: 'mimi', groupId: 'g1', routeKey: 'group:g1', session: laneSession('lane-1') };
    expect(tx(db, { name: 'bots.createGroupLane', args })).toEqual({ sessionId: 'lane-1', created: true });
    expect(tx(db, { name: 'bots.createGroupLane', args: { ...args, session: laneSession('lane-2') } }))
      .toEqual({ sessionId: 'lane-1', created: false });
    expect(db.prepare("SELECT bot_id, role, route_key, profile_version FROM bot_session_links WHERE session_id = 'lane-1'").get())
      .toEqual({ bot_id: 'mimi', role: 'group', route_key: 'group:g1', profile_version: 3 });
    expect(db.prepare("SELECT source, status FROM sessions WHERE id = 'lane-1'").get())
      .toEqual({ source: 'bot', status: 'active' });
  });

  it('refuses lanes for non-members and unavailable Bots', () => {
    expect(() => tx(db, {
      name: 'bots.createGroupLane',
      args: { botId: 'abu', groupId: 'g1', routeKey: 'group:g1', session: laneSession('lane-x') },
    })).toThrow(expect.objectContaining({ code: 'MEMBER_UNAVAILABLE' }));
    expect(() => tx(db, {
      name: 'bots.createGroupLane',
      args: { botId: 'kapi', groupId: 'g1', routeKey: 'group:g1', session: laneSession('lane-y') },
    })).toThrow(expect.objectContaining({ code: 'MEMBER_UNAVAILABLE' }));
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'lane-%'").get()).toEqual({ n: 0 });
  });

  it('deletes group lanes instead of keeping them as task history when a Bot is deleted', () => {
    tx(db, {
      name: 'bots.createGroupLane',
      args: { botId: 'mimi', groupId: 'g1', routeKey: 'group:g1', session: laneSession('lane-1') },
    });
    db.exec("UPDATE bot_profiles SET status = 'archived' WHERE id = 'mimi'");
    expect(tx(db, {
      name: 'bots.deleteProfile',
      args: { botId: 'mimi', sessionIds: ['mimi-main', 'lane-1'], keepTaskHistory: true, at: 50 },
    })).toEqual({ sessionIds: ['mimi-main', 'lane-1'], status: 'archived' });
    expect(db.prepare('SELECT id, source, status FROM sessions ORDER BY id').all()).toEqual([
      { id: 'lane-1', source: 'bot', status: 'deleted' },
      { id: 'mimi-main', source: 'desktop', status: 'archived' },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bot_group_members WHERE bot_id = 'mimi'").get()).toEqual({ n: 0 });
  });
});
