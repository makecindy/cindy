import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { tx } from '../tx.js';
import { normalizeBotProfileModelChain } from '../../../ipc/botProfileVersioning';
import { createBotModelRouteReconciler } from '../../../../maker-ipc/botModelRouteReconciler';
import { createScheduledModelScope, writeScheduledModelBaselineIfProfileCurrent } from '../../../../maker-ipc/scheduledModelSelection';
import { normalizeBotModelChain } from '../../../../../shared/botModelChain';
import type { ScheduledModelSelection } from '../../../../maker-ipc/scheduledModelSelection';

describe('Bot named worker transactions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, working_dir TEXT, workspace_kind TEXT NOT NULL,
        model TEXT NOT NULL, effort TEXT NOT NULL, permission_mode TEXT NOT NULL, status TEXT NOT NULL,
        scheduled_model_baseline TEXT,
        sdk_session_id TEXT, total_token_usage INTEGER NOT NULL, total_cost_usd REAL NOT NULL,
        context_tokens INTEGER NOT NULL, context_window INTEGER NOT NULL, fast_mode INTEGER NOT NULL,
        plan_mode_enabled INTEGER NOT NULL, cleared_at INTEGER, pinned_at INTEGER, user_send_at INTEGER,
        agent_kind TEXT NOT NULL, orca_role TEXT, parent_session_id TEXT, forked_at_message_id TEXT,
        worktree_path TEXT, extra_dirs TEXT NOT NULL, remote_host_id TEXT, provider_id TEXT, agent_device_id TEXT,
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

  // #6759: exercise the actual save transaction, then discard process-local
  // reconciliation state before IM preparation and automation restore.
  function savedModelFixture() {
    const original: ScheduledModelSelection = {
      agentKind: 'codex', model: 'old', providerId: 'connected-custom', effort: 'high', fastMode: false,
    };
    let current = { ...original, model: 'temporary' };
    let owner = 'account-a';
    const capabilities = (model: string) => JSON.stringify({ modelChain: [{
      harness: 'codex', model, providerId: 'connected-custom', effort: 'high', fastMode: false,
    }] });
    tx(db, { name: 'bots.createProfile', args: {
      id: 'saved-bot', displayName: 'Saved', description: '', avatar: '', avatarColor: 'blue',
      identitySource: 'identity', capabilitiesJson: capabilities('old'), now: 1,
    } });
    tx(db, { name: 'bots.replaceCanonicalSession', args: {
      botId: 'saved-bot', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
      session: { id: 'saved-session', title: 'Saved', workingDir: '/tmp/saved-session',
        workspaceKind: 'dialogue', model: 'temporary', effort: 'high', permissionMode: 'ask',
        agentKind: 'codex', remoteHostId: null, providerId: 'connected-custom', extraDirs: '[]',
        source: 'bot', createdAt: 2, updatedAt: 2 }, now: 2,
    } });
    const readBaseline = () => db.prepare('SELECT scheduled_model_baseline FROM sessions WHERE id = ?')
      .pluck().get('saved-session') as string | null;
    const writeBaseline = (value: string | null) => {
      db.prepare('UPDATE sessions SET scheduled_model_baseline = ? WHERE id = ?').run(value, 'saved-session');
    };
    writeBaseline(JSON.stringify({ ...original, scopeId: 'automation' }));
    const pause = (paused: boolean) => {
      db.prepare('UPDATE bot_profiles SET status = ? WHERE id = ?').run(paused ? 'paused' : 'active', 'saved-bot');
    };
    const save = (model: string, expectedCurrentVersion = 1, extra: Record<string, unknown> = {}) => tx(db, {
      name: 'bots.updateProfile', args: { id: 'saved-bot', expectedCurrentVersion,
        identitySource: 'identity', capabilitiesJson: capabilities(model), profileContentChanged: true, now: 3, ...extra },
    });
    let failApply = false;
    const reconcile = () => createBotModelRouteReconciler({
      ownerEpoch: () => owner,
      read: async () => {
        const row = db.prepare(`SELECT p.status, v.capabilities_json AS capabilities FROM bot_profiles p
          JOIN bot_profile_versions v ON v.bot_id = p.id AND v.version = p.current_version
          WHERE p.id = 'saved-bot'`).get() as { status: string; capabilities: string };
        return row.status === 'active' ? {
          chain: normalizeBotModelChain(JSON.parse(row.capabilities).modelChain), current,
          hasRuntimeOverride: false, scheduledModelBaseline: readBaseline(),
        } : null;
      },
      apply: async (_id, route) => {
        if (failApply) throw new Error('provider unavailable');
        current = { ...route, effort: route.effort as ScheduledModelSelection['effort'] };
      },
      onSelectionAccepted: async () => { writeBaseline(null); },
    });
    const scopeDeps: Parameters<typeof createScheduledModelScope>[0] = {
      read: async () => ({ profile: current, baseline: readBaseline(),
        profileRevision: db.prepare("SELECT json_array(id, current_version) FROM bot_profiles WHERE id = 'saved-bot'").pluck().get() as string,
      }),
      write: async (sessionId, baseline, revision, expectedBaseline) => {
        if (baseline) return writeScheduledModelBaselineIfProfileCurrent({
          exec: async (sql, params) => db.prepare(sql).run(...params),
        }, sessionId, baseline, revision ?? null, expectedBaseline);
        writeBaseline(null);
      },
      apply: async (_id, route) => { current = route; }, isBusy: () => false, createId: () => 'unused',
    };
    const scope = createScheduledModelScope(scopeDeps);
    return { original, readBaseline, pause, save, reconcile, scope, scopeDeps, writeBaseline, current: () => current,
      changeOwner: () => { owner = 'account-b'; }, failApply: (fail: boolean) => { failApply = fail; } };
  }

  // Permission-only saves can now create a Profile version without model input.
  // Exercise their intersection with the durable automation restore transaction.
  it.each([false, true])('preserves the fallback on a permission-only save (stale payload: %s)', async stalePayload => {
    const h = savedModelFixture();
    const baseline = h.readBaseline();
    expect(tx(db, { name: 'bots.updateProfile', args: {
      id: 'saved-bot', expectedCurrentVersion: 1, now: 3, profileContentChanged: false,
      canonicalPermissionMode: 'bypassPermissions',
      ...(stalePayload ? { capabilitiesJson: JSON.stringify({ model: 'stale' }) } : {}),
    } })).toEqual({ currentVersion: 2 });
    expect(h.readBaseline()).toBe(baseline);
    const saved = db.prepare('SELECT identity_source AS identity, capabilities_json AS config FROM bot_profile_versions WHERE version = 2')
      .get() as { identity: string; config: string };
    expect(saved.identity).toBe('identity');
    expect(JSON.parse(saved.config)).toMatchObject({ permissions: 'trusted', modelChain: [{ model: 'old' }] });
    expect(db.prepare('SELECT permission_mode FROM sessions').pluck().get()).toBe('bypassPermissions');
    await h.reconcile()('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current()).toMatchObject(h.original);
  });

  it('accepts a model save without reverting a newer permission choice', async () => {
    const h = savedModelFixture();
    tx(db, { name: 'bots.persistSessionPermission', args: { sessionId: 'saved-session', mode: 'bypassPermissions' } });
    h.save('permanent');
    expect(JSON.parse(h.readBaseline()!)).toMatchObject({ pendingBotProfileVersion: 2 });
    expect(JSON.parse(db.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE version = 2').pluck().get() as string))
      .toMatchObject({ permissions: 'trusted' });
    await h.reconcile()('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current().model).toBe('permanent');
    expect(h.readBaseline()).toBeNull();
    expect(db.prepare('SELECT permission_mode FROM sessions').pluck().get()).toBe('bypassPermissions');
  });

  it('keeps the baseline and permission when the expected Profile version is missing', () => {
    const h = savedModelFixture();
    const baseline = h.readBaseline();
    db.prepare('DELETE FROM bot_profile_versions').run();
    expect(() => h.save('permanent', 1, { canonicalPermissionMode: 'bypassPermissions' }))
      .toThrowError(expect.objectContaining({ code: 'PRECONDITION_FAILED' }));
    expect(h.readBaseline()).toBe(baseline);
    expect(db.prepare('SELECT permission_mode FROM sessions').pluck().get()).toBe('ask');
    expect(db.prepare('SELECT current_version FROM bot_profiles').pluck().get()).toBe(1);
  });

  it.each(['restart', 'account-change'])('accepts a paused permanent save after %s before restoring automation', async boundary => {
    const h = savedModelFixture();
    h.pause(true);
    let reconcile = h.reconcile();
    h.save('permanent');
    await reconcile.profileChanged('saved-session');
    if (boundary === 'restart') reconcile = h.reconcile();
    else h.changeOwner();
    h.pause(false);
    await reconcile('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current().model).toBe('permanent');
    expect(h.readBaseline()).toBeNull();
  });

  it('accepts a same-route permanent save after restart without restoring the old provider choice', async () => {
    const h = savedModelFixture();
    h.pause(true);
    h.save('temporary');
    h.pause(false);
    await h.reconcile()('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current().model).toBe('temporary');
    expect(h.readBaseline()).toBeNull();
  });

  it('keeps the durable save and old baseline on failure, without restoring it while paused', async () => {
    const h = savedModelFixture();
    h.pause(true);
    h.save('permanent');
    const pending = h.readBaseline();
    await h.scope.restore('saved-session');
    expect(h.current().model).toBe('temporary');
    expect(h.readBaseline()).toBe(pending);
    h.pause(false);
    h.failApply(true);
    await expect(h.reconcile()('saved-session')).rejects.toThrow('provider unavailable');
    expect(h.readBaseline()).toBe(pending);
    h.failApply(false);
    await h.reconcile()('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current().model).toBe('permanent');
  });

  it('does not invalidate a baseline for a non-model profile edit or a rejected save', async () => {
    const h = savedModelFixture();
    const baseline = h.readBaseline();
    h.save('old', 1, { identitySource: 'new identity' });
    expect(h.readBaseline()).toBe(baseline);
    expect(() => h.save('permanent')).toThrow('Profile');
    expect(h.readBaseline()).toBe(baseline);
    await h.reconcile()('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current()).toMatchObject(h.original);
  });

  it.each(['canonical', 'group', 'channel', 'thread', 'background', 'archived'])('marks only following profile links: %s', role => {
    const h = savedModelFixture();
    const baseline = h.readBaseline();
    if (role === 'archived') db.prepare('UPDATE bot_session_links SET archived_at = 4').run();
    else db.prepare('UPDATE bot_session_links SET role = ?').run(role);
    h.save('permanent');
    if (role === 'background' || role === 'archived') expect(h.readBaseline()).toBe(baseline);
    else expect(JSON.parse(h.readBaseline()!)).toMatchObject({ pendingBotProfileVersion: 2, model: 'old' });
  });

  it('rolls back the pending marker with a failed profile transaction', () => {
    const h = savedModelFixture();
    const baseline = h.readBaseline();
    expect(() => h.save('permanent', 1, { canonicalPermissionMode: 'invalid' })).toThrow('permission mode');
    expect(h.readBaseline()).toBe(baseline);
    expect(db.prepare('SELECT current_version FROM bot_profiles').pluck().get()).toBe(1);
    expect(db.prepare('SELECT count(*) FROM bot_profile_versions').pluck().get()).toBe(1);
  });

  it('persists a permanent save even before the first automation scope exists', async () => {
    const h = savedModelFixture();
    h.writeBaseline(null);
    h.save('permanent');
    expect(JSON.parse(h.readBaseline()!)).toMatchObject({ pendingBotProfileVersion: 2 });
    await h.reconcile()('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current().model).toBe('permanent');
  });

  it.each(['save-before-begin', 'save-during-begin', 'save-after-begin'].flatMap(order =>
    [null, '{broken'].map(initialBaseline => ({ order, initialBaseline })),
  ))('serializes the real scope writer and permanent save: $order / $initialBaseline', async ({ order, initialBaseline }) => {
    const h = savedModelFixture();
    h.writeBaseline(initialBaseline);
    const scope = createScheduledModelScope({ ...h.scopeDeps,
      write: async (...args) => {
        if (order === 'save-during-begin') h.save('permanent');
        return h.scopeDeps.write(...args);
      },
    });
    if (order === 'save-before-begin') h.save('permanent');
    if (order === 'save-before-begin') await expect(scope.begin('saved-session')).rejects.toThrow('pending');
    else if (order === 'save-during-begin') await expect(scope.begin('saved-session')).rejects.toThrow('changed');
    else await scope.begin('saved-session');
    if (order === 'save-after-begin') h.save('permanent');
    expect(JSON.parse(h.readBaseline()!)).toMatchObject({ pendingBotProfileVersion: 2 });
    await h.reconcile()('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current().model).toBe('permanent');
    expect(h.readBaseline()).toBeNull();
  });

  it('retries capture across an unrelated profile revision and preserves a rolled-back save', async () => {
    const h = savedModelFixture();
    h.writeBaseline(null);
    const scope = createScheduledModelScope({ ...h.scopeDeps, write: async (...args) => {
      expect(() => h.save('permanent', 1, { canonicalPermissionMode: 'invalid' })).toThrow('permission mode');
      h.save('old', 1, { identitySource: 'new identity' });
      return h.scopeDeps.write(...args);
    } });
    await expect(scope.begin('saved-session')).rejects.toThrow('changed');
    expect(h.readBaseline()).toBeNull();
    await expect(h.scope.begin('saved-session')).resolves.toBe('unused');
    expect(JSON.parse(h.readBaseline()!).pendingBotProfileVersion).toBeUndefined();
  });

  it('preserves runtime fallback when a non-model edit normalizes a legacy chain-only profile', async () => {
    const h = savedModelFixture();
    const fallback = { ...h.original, model: 'runtime-fallback', scopeId: 'automation' };
    h.writeBaseline(JSON.stringify(fallback));
    const previous = JSON.parse(db.prepare('SELECT capabilities_json FROM bot_profile_versions').pluck().get() as string);
    expect(previous.model).toBeUndefined();
    const next = normalizeBotProfileModelChain({ ...previous, skills: ['new-skill'] });
    h.save('old', 1, { capabilitiesJson: JSON.stringify(next), identitySource: 'edited identity' });
    expect(h.readBaseline()).toBe(JSON.stringify(fallback));
    await h.reconcile()('saved-session');
    await h.scope.restore('saved-session');
    expect(h.current().model).toBe('runtime-fallback');
  });

  it('atomically rejects duplicate names and a second Cindy without touching the first profile', () => {
    const args = { id: 'first', displayName: 'Renamed', description: '', avatar: '🤖', avatarColor: 'blue', identitySource: 'Custom identity', capabilitiesJson: '{"templateId":"cindy"}', now: 1 };
    tx(db, { name: 'bots.createProfile', args });
    expect(() => tx(db, { name: 'bots.createProfile', args: { ...args, id: 'second', displayName: 'Cindy' } })).toThrow('matching companion');
    expect(() => tx(db, { name: 'bots.createProfile', args: { ...args, id: 'third', displayName: 'Ｒｅｎａｍｅｄ ', capabilitiesJson: '{}' } })).toThrow('matching companion');
    expect(db.prepare('SELECT id, display_name FROM bot_profiles').all()).toEqual([{ id: 'first', display_name: 'Renamed' }]);
    expect(db.prepare('SELECT count(*) AS n FROM bot_profile_versions').get()).toEqual({ n: 1 });
  });

  it('keeps distinct names after settings edits and allows re-adding an archived identity', () => {
    const args = { id: 'first', displayName: 'Cindy', description: '', avatar: '🤖', avatarColor: 'blue', identitySource: 'Identity', capabilitiesJson: '{"templateId":"cindy"}', now: 1 };
    tx(db, { name: 'bots.createProfile', args });
    tx(db, { name: 'bots.createProfile', args: { ...args, id: 'second', displayName: 'Mika', capabilitiesJson: '{}' } });
    expect(() => tx(db, { name: 'bots.updateProfile', args: { id: 'second', expectedCurrentVersion: 1, displayName: ' cindy ', now: 2 } })).toThrow('this name');
    db.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = 'first'").run();
    tx(db, { name: 'bots.createProfile', args: { ...args, id: 'third' } });
    expect(db.prepare('SELECT count(*) AS n FROM bot_profiles').get()).toEqual({ n: 3 });
  });

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

  // #6895: model saves must retire only live profile-following restores, and
  // a later write failure must roll back both the profile and the restore clear.
  it('retires only active profile-following restores atomically with the model save', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{}', now: 1,
    } });
    for (const role of ['canonical', 'group', 'channel', 'thread', 'worker', 'archived']) {
      db.prepare(`INSERT INTO sessions
        (id, title, workspace_kind, model, effort, permission_mode, status, total_token_usage,
         total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind,
         extra_dirs, source, created_at, updated_at, scheduled_model_baseline)
        VALUES (?, 'Hermes', 'dialogue', 'temporary', 'high', 'ask', 'active',
         0, 0, 0, 0, 0, 0, 'codex', '[]', 'bot', 2, 2, 'old-route')`).run(role);
      db.prepare(`INSERT INTO bot_session_links
        (id, bot_id, session_id, profile_version, role, created_at, archived_at)
        VALUES (?, 'bot-1', ?, 1, ?, 2, ?)`).run(`link-${role}`, role, role === 'archived' ? 'channel' : role, role === 'archived' ? 3 : null);
    }
    const args = { id: 'bot-1', identitySource: 'identity', capabilitiesJson: '{"model":"new"}',
      profileContentChanged: true, expectedCurrentVersion: 1, clearScheduledModelBaseline: true, now: 4 };
    // Fail the permission write after restore retirement, not its early input
    // validation, so this still verifies rollback of the combined transaction.
    db.exec(`CREATE TRIGGER reject_permission_write BEFORE UPDATE OF permission_mode ON sessions
      BEGIN SELECT RAISE(ABORT, 'permission write failed'); END`);
    expect(() => tx(db, { name: 'bots.updateProfile', args: { ...args, canonicalPermissionMode: 'auto' } }))
      .toThrow('permission write failed');
    expect(db.prepare('SELECT current_version FROM bot_profiles').pluck().get()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) FROM sessions WHERE scheduled_model_baseline IS NOT NULL').pluck().get()).toBe(6);
    db.exec('DROP TRIGGER reject_permission_write');
    tx(db, { name: 'bots.updateProfile', args });
    const restores = db.prepare('SELECT id, scheduled_model_baseline AS baseline FROM sessions ORDER BY id')
      .all() as Array<{ id: string; baseline: string }>;
    for (const row of restores) {
      if (row.id === 'archived' || row.id === 'worker') expect(row.baseline).toBe('old-route');
      else expect(JSON.parse(row.baseline)).toMatchObject({ pendingBotProfileVersion: 2, model: 'temporary' });
    }
    expect(db.prepare('SELECT current_version FROM bot_profiles').pluck().get()).toBe(2);
  });
  // #6782: production worker transactions; unit tier. Existing tests do not
  // interleave a composer permission commit with a settings save captured earlier.
  it.each([['ask', 'bypassPermissions', 'trusted'], ['trusted', 'ask', 'ask']])(
    'keeps the explicit permission when an older model save lands afterwards (%s → %s)',
    (previousPermission, mode, expectedPermission) => {
      tx(db, { name: 'bots.createProfile', args: {
        id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
        identitySource: 'identity', capabilitiesJson: JSON.stringify({ permissions: previousPermission, model: 'old' }), now: 1,
      } });
      db.prepare(`INSERT INTO sessions
        (id, title, workspace_kind, model, effort, permission_mode, status, total_token_usage,
         total_cost_usd, context_tokens, context_window, fast_mode, plan_mode_enabled, agent_kind,
         extra_dirs, source, created_at, updated_at)
        VALUES ('canonical', 'Hermes', 'dialogue', 'model', 'high', 'ask', 'active',
         0, 0, 0, 0, 0, 0, 'cc', '[]', 'bot', 2, 2)`).run();
      db.prepare(`INSERT INTO bot_session_links
        (id, bot_id, session_id, profile_version, role, created_at)
        VALUES ('link', 'bot-1', 'canonical', 1, 'canonical', 2)`).run();
      tx(db, { name: 'bots.persistSessionPermission', args: { sessionId: 'canonical', mode } });
      tx(db, { name: 'bots.updateProfile', args: {
        id: 'bot-1', expectedCurrentVersion: 1, profileContentChanged: true,
        identitySource: 'identity', capabilitiesJson: JSON.stringify({ permissions: previousPermission, model: 'new' }), now: 3,
      } });
      expect(JSON.parse(db.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE version = 2').pluck().get() as string))
        .toEqual({ permissions: expectedPermission, model: 'new' });
      expect(db.prepare("SELECT permission_mode FROM sessions WHERE id = 'canonical'").pluck().get()).toBe(mode);
    },
  );

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

  // #6782: production named transactions must propagate a canonical choice in both
  // directions. Existing tests never changed permission after creating a channel.
  // Minimal failure: ask main + ask channel, save main bypass -> channel stayed ask.
  // Unit tier, isolated SQLite; this also covers new-lane snapshots and old-data repair.
  it('cascades canonical permissions without changing history or delegated work', () => {
    tx(db, { name: 'bots.createProfile', args: {
      id: 'bot-1', displayName: 'Hermes', description: '', avatar: '🤖', avatarColor: 'violet',
      identitySource: 'identity', capabilitiesJson: '{"permissions":"ask"}', now: 1,
    } });
    const session = (id: string) => ({ id, title: id, workingDir: '/tmp/fixture', workspaceKind: 'dialogue',
      model: 'm', effort: 'high', permissionMode: 'ask', agentKind: 'codex', extraDirs: '[]', source: 'bot', createdAt: 1, updatedAt: 1 });
    tx(db, { name: 'bots.replaceCanonicalSession', args: {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1, session: session('main'), now: 1,
    } });
    tx(db, { name: 'bots.createChannelLane', args: { botId: 'bot-1', routeKey: 'im:feishu:g:1', session: session('feishu') } });
    for (const role of ['group', 'thread', 'delegation', 'history']) {
      db.prepare(`INSERT INTO sessions SELECT ?, title, working_dir, workspace_kind, model, effort, permission_mode, status,
        scheduled_model_baseline, sdk_session_id, total_token_usage, total_cost_usd, context_tokens, context_window, fast_mode,
        plan_mode_enabled, cleared_at, pinned_at, user_send_at, agent_kind, orca_role, parent_session_id, forked_at_message_id,
        worktree_path, extra_dirs, remote_host_id, provider_id, agent_device_id, source, created_at, updated_at FROM sessions WHERE id = 'main'`).run(role);
      db.prepare('INSERT INTO bot_session_links (id, bot_id, session_id, profile_version, role, created_at, archived_at) VALUES (?, ?, ?, 1, ?, 1, ?)')
        .run(role, 'bot-1', role, role, role === 'history' ? 1 : null);
    }
    const mode = (id: string) => db.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get(id);
    for (const next of ['bypassPermissions', 'auto', 'ask']) {
      tx(db, { name: 'bots.persistSessionPermission', args: { sessionId: 'main', mode: next } });
      expect(['main', 'feishu', 'group', 'thread'].map(mode)).toEqual([next, next, next, next]);
      expect(['delegation', 'history'].map(mode)).toEqual(['ask', 'ask']);
    }
    // A stale preflight must not mint a lane with authority older than the Profile.
    tx(db, { name: 'bots.persistSessionPermission', args: { sessionId: 'main', mode: 'bypassPermissions' } });
    tx(db, { name: 'bots.createChannelLane', args: { botId: 'bot-1', routeKey: 'im:feishu:g:2', session: session('new') } });
    expect(mode('new')).toBe('bypassPermissions');
    db.prepare("UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = 'bot-1'").run(JSON.stringify({ permissions: 'ask' }));
    expect(tx(db, { name: 'bots.reconcileLanePermission', args: { sessionId: 'feishu' } }))
      .toMatchObject({ mode: 'bypassPermissions', canonicalSessionId: 'main' });
    expect(['main', 'feishu', 'group', 'thread', 'new'].map(mode))
      .toEqual(Array(5).fill('bypassPermissions'));
    expect(JSON.parse(db.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ?').pluck().get('bot-1') as string).permissions)
      .toBe('trusted');
    // Main is authoritative in both directions; never choose the widest snapshot.
    db.prepare("UPDATE sessions SET permission_mode = 'ask' WHERE id = 'main'").run();
    expect(tx(db, { name: 'bots.reconcileLanePermission', args: { sessionId: 'main' } }))
      .toMatchObject({ mode: 'ask', canonicalSessionId: 'main' });
    expect(['main', 'feishu', 'group', 'thread', 'new'].map(mode)).toEqual(Array(5).fill('ask'));
    expect(['delegation', 'history'].map(mode)).toEqual(['ask', 'ask']);
    expect(tx(db, { name: 'bots.reconcileLanePermission', args: { sessionId: 'history' } })).toMatchObject({ mode: null });
    expect(db.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(7);
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
