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
        hidden_at INTEGER, pinned_at INTEGER, attention_reason TEXT, attention_at INTEGER,
        canonical_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE bot_profile_versions (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, identity_source TEXT NOT NULL, capabilities_json TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE(bot_id, version)
      );
      CREATE TABLE bot_session_links (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        profile_version INTEGER NOT NULL, role TEXT NOT NULL, route_key TEXT,
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

  it('keeps durable Bot attention monotonic and lets only a later success clear it', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });

    expect(tx(db, { name: 'bots.updateAttention', args: {
      botId: 'bot-1', reason: 'provider_auth_or_access', observedAt: 20,
    } })).toEqual({ changed: true });
    expect(
      db.prepare('SELECT attention_reason AS reason, attention_at AS at FROM bot_profiles WHERE id = ?')
        .get('bot-1'),
    ).toEqual({ reason: 'provider_auth_or_access', at: 20 });

    expect(tx(db, { name: 'bots.updateAttention', args: {
      botId: 'bot-1', reason: null, observedAt: 19,
    } })).toEqual({ changed: false });
    expect(tx(db, { name: 'bots.updateAttention', args: {
      botId: 'bot-1', reason: 'provider_quota_limit', observedAt: 18,
    } })).toEqual({ changed: false });
    expect(
      db.prepare('SELECT attention_reason AS reason, attention_at AS at FROM bot_profiles WHERE id = ?')
        .get('bot-1'),
    ).toEqual({ reason: 'provider_auth_or_access', at: 20 });

    expect(tx(db, { name: 'bots.updateAttention', args: {
      botId: 'bot-1', reason: null, observedAt: 20,
    } })).toEqual({ changed: true });
    expect(
      db.prepare('SELECT attention_reason AS reason, attention_at AS at FROM bot_profiles WHERE id = ?')
        .get('bot-1'),
    ).toEqual({ reason: null, at: null });
  });

  it('updates roster-only hidden and pinned state without minting a ProfileVersion', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });

    expect(tx(db, { name: 'bots.updateProfile', args: {
      id: 'bot-1', hiddenAt: 2, pinnedAt: 3,
      identitySource: 'identity', capabilitiesJson: '{}', profileContentChanged: false,
      expectedCurrentVersion: 1, now: 3,
    } })).toEqual({ currentVersion: 1 });
    expect(
      db.prepare('SELECT hidden_at AS hiddenAt, pinned_at AS pinnedAt, current_version AS version FROM bot_profiles WHERE id = ?')
        .get('bot-1'),
    ).toEqual({ hiddenAt: 2, pinnedAt: 3, version: 1 });

    expect(tx(db, { name: 'bots.updateProfile', args: {
      id: 'bot-1', hiddenAt: null, pinnedAt: null,
      identitySource: 'identity', capabilitiesJson: '{}', profileContentChanged: false,
      expectedCurrentVersion: 1, now: 4,
    } })).toEqual({ currentVersion: 1 });
    expect(
      db.prepare('SELECT hidden_at AS hiddenAt, pinned_at AS pinnedAt FROM bot_profiles WHERE id = ?')
        .get('bot-1'),
    ).toEqual({ hiddenAt: null, pinnedAt: null });
  });

  it('creates a local-first profile and keeps one permanent canonical Session', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });

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
      created: false, canonicalSessionId: 'session-1', archivedCanonicalSessionId: null,
    });
    expect(db.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-1'))
      .toBe('active');
    expect(db.prepare("SELECT session_id FROM bot_session_links WHERE role = 'canonical'").pluck().get())
      .toBe('session-1');
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
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

  it('treats the canonical link as authority and repairs only the compatibility mirror', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });
    db.prepare(`INSERT INTO sessions
      (id, title, workspace_kind, model, effort, permission_mode, status, total_token_usage,
       total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind,
       extra_dirs, source, created_at, updated_at)
      VALUES ('canonical', 'Hermes', 'dialogue', 'claude-sonnet-4-6', 'high', 'ask', 'active',
       0, 0, 0, 0, 0, 0, 'cc', '[]', 'bot', 2, 2)`).run();
    db.prepare(`INSERT INTO bot_session_links
      (id, bot_id, session_id, profile_version, role, created_at)
      VALUES ('link-canonical', 'bot-1', 'canonical', 1, 'canonical', 2)`).run();
    db.prepare(`INSERT INTO sessions
      (id, title, workspace_kind, model, effort, permission_mode, status, total_token_usage,
       total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind,
       extra_dirs, source, created_at, updated_at)
      VALUES ('stale', 'Old', 'dialogue', 'claude-sonnet-4-6', 'high', 'ask', 'archived',
       0, 0, 0, 0, 0, 0, 'cc', '[]', 'bot', 2, 2)`).run();
    db.prepare("UPDATE bot_profiles SET canonical_session_id = 'stale' WHERE id = 'bot-1'").run();

    expect(tx(db, { name: 'bots.reconcileCanonicalLink', args: { botId: 'bot-1', now: 3 } }))
      .toEqual({ status: 'repaired-mirror', canonicalSessionId: 'canonical' });
    expect(db.prepare('SELECT canonical_session_id FROM bot_profiles WHERE id = ?').pluck().get('bot-1'))
      .toBe('canonical');
    expect(tx(db, { name: 'bots.reconcileCanonicalLink', args: { botId: 'bot-1', now: 4 } }))
      .toEqual({ status: 'unchanged', canonicalSessionId: 'canonical' });
  });

  it('migrates a valid legacy pointer into the canonical link exactly once', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });
    db.prepare(`INSERT INTO sessions
      (id, title, workspace_kind, model, effort, permission_mode, status, total_token_usage,
       total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind,
       extra_dirs, source, created_at, updated_at)
      VALUES ('legacy', 'Hermes', 'dialogue', 'claude-sonnet-4-6', 'high', 'ask', 'active',
       0, 0, 0, 0, 0, 0, 'cc', '[]', 'bot', 2, 2)`).run();
    db.prepare("UPDATE bot_profiles SET canonical_session_id = 'legacy' WHERE id = 'bot-1'").run();

    expect(tx(db, { name: 'bots.reconcileCanonicalLink', args: { botId: 'bot-1', now: 3 } }))
      .toEqual({ status: 'migrated', canonicalSessionId: 'legacy' });
    expect(db.prepare("SELECT role, session_id FROM bot_session_links WHERE bot_id = 'bot-1'").get())
      .toEqual({ role: 'canonical', session_id: 'legacy' });
    expect(tx(db, { name: 'bots.reconcileCanonicalLink', args: { botId: 'bot-1', now: 4 } }))
      .toEqual({ status: 'unchanged', canonicalSessionId: 'legacy' });
    expect(db.prepare("SELECT COUNT(*) FROM bot_session_links WHERE bot_id = 'bot-1'").pluck().get())
      .toBe(1);
  });

  it('fails closed when the legacy pointer is missing or points at an existing non-canonical link', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });
    db.prepare(`INSERT INTO sessions
      (id, title, workspace_kind, model, effort, permission_mode, status, total_token_usage,
       total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind,
       extra_dirs, source, created_at, updated_at)
      VALUES ('gone', 'Gone', 'dialogue', 'claude-sonnet-4-6', 'high', 'ask', 'deleted',
       0, 0, 0, 0, 0, 0, 'cc', '[]', 'bot', 2, 2)`).run();
    db.prepare("UPDATE bot_profiles SET canonical_session_id = 'gone' WHERE id = 'bot-1'").run();
    expect(tx(db, { name: 'bots.reconcileCanonicalLink', args: { botId: 'bot-1', now: 2 } }))
      .toEqual({ status: 'missing-session', canonicalSessionId: null });
    expect(db.prepare("SELECT COUNT(*) FROM bot_session_links WHERE bot_id = 'bot-1'").pluck().get())
      .toBe(0);

    db.prepare(`INSERT INTO sessions
      (id, title, workspace_kind, model, effort, permission_mode, status, total_token_usage,
       total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind,
       extra_dirs, source, created_at, updated_at)
      VALUES ('route-session', 'Hermes', 'dialogue', 'claude-sonnet-4-6', 'high', 'ask', 'active',
       0, 0, 0, 0, 0, 0, 'cc', '[]', 'bot', 3, 3)`).run();
    db.prepare("UPDATE bot_profiles SET canonical_session_id = 'route-session' WHERE id = 'bot-1'").run();
    db.prepare(`INSERT INTO bot_session_links
      (id, bot_id, session_id, profile_version, role, created_at)
      VALUES ('link-route', 'bot-1', 'route-session', 1, 'route', 3)`).run();
    expect(tx(db, { name: 'bots.reconcileCanonicalLink', args: { botId: 'bot-1', now: 4 } }))
      .toEqual({ status: 'conflict', canonicalSessionId: null });
    expect(db.prepare("SELECT role FROM bot_session_links WHERE bot_id = 'bot-1'").pluck().get())
      .toBe('route');
  });
});
