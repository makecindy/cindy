import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tx } from '../tx.js';

describe('Bot named worker transactions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, working_dir TEXT, workspace_kind TEXT NOT NULL,
        model TEXT NOT NULL, effort TEXT NOT NULL, permission_mode TEXT NOT NULL, status TEXT NOT NULL,
        sdk_session_id TEXT, total_token_usage INTEGER NOT NULL, total_cost_usd REAL NOT NULL,
        context_tokens INTEGER NOT NULL, context_window INTEGER NOT NULL, fast_mode INTEGER NOT NULL,
        plan_mode_enabled INTEGER NOT NULL, cleared_at INTEGER, pinned_at INTEGER, user_send_at INTEGER,
        agent_kind TEXT NOT NULL, orca_role TEXT, parent_session_id TEXT, forked_at_message_id TEXT,
        worktree_path TEXT, extra_dirs TEXT NOT NULL, remote_host_id TEXT, provider_id TEXT,
        source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_profiles (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL, avatar TEXT NOT NULL,
        avatar_color TEXT NOT NULL, status TEXT NOT NULL, current_version INTEGER NOT NULL,
        canonical_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_profile_versions (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, identity_source TEXT NOT NULL, capabilities_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(bot_id, version)
      );
      CREATE TABLE bot_channels (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, enabled INTEGER NOT NULL, config_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_session_links (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        profile_version INTEGER NOT NULL, role TEXT NOT NULL, channel_id TEXT, route_key TEXT,
        created_at INTEGER NOT NULL, archived_at INTEGER
      );
      CREATE UNIQUE INDEX uniq_bot_canonical ON bot_session_links(bot_id) WHERE role = 'canonical';
      CREATE TABLE bot_lifecycle_events (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL, event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => db.close());

  it('creates a local-first profile and atomically installs and renews canonical sessions', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });
    expect(db.prepare('SELECT kind FROM bot_channels').pluck().all()).toEqual(['local']);

    const session = (id: string, now: number) => ({
      id, title: 'Hermes', workingDir: `/tmp/${id}`, workspaceKind: 'dialogue',
      model: 'claude-sonnet-4-6', effort: 'high', permissionMode: 'ask', agentKind: 'cc',
      remoteHostId: null, providerId: null, extraDirs: '[]', source: 'bot',
      createdAt: now, updatedAt: now,
    });
    expect(tx(db, { name: 'bots.replaceCanonicalSession', args: {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
      session: session('session-1', 2), now: 2,
    } })).toMatchObject({ created: true, canonicalSessionId: 'session-1' });
    expect(tx(db, { name: 'bots.replaceCanonicalSession', args: {
      botId: 'bot-1', expectedCanonicalSessionId: 'session-1', expectedProfileVersion: 1,
      session: session('session-2', 3), now: 3,
    } })).toEqual({
      created: true, canonicalSessionId: 'session-2', archivedCanonicalSessionId: 'session-1',
    });
    expect(db.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-1'))
      .toBe('archived');
    expect(db.prepare("SELECT session_id FROM bot_session_links WHERE role = 'canonical'").pluck().get())
      .toBe('session-2');
  });

  it('does not insert a losing canonical CAS session', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });
    const result = tx(db, { name: 'bots.replaceCanonicalSession', args: {
      botId: 'bot-1', expectedCanonicalSessionId: 'stale', expectedProfileVersion: 1,
      session: {
        id: 'loser', title: 'Hermes', workingDir: '/tmp/loser', workspaceKind: 'dialogue',
        model: 'claude-sonnet-4-6', effort: 'high', permissionMode: 'ask', agentKind: 'cc',
        remoteHostId: null, providerId: null, extraDirs: '[]', source: 'bot', createdAt: 2, updatedAt: 2,
      }, now: 2,
    } });
    expect(result).toEqual({ created: false, canonicalSessionId: null, archivedCanonicalSessionId: null });
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(0);
  });
});
