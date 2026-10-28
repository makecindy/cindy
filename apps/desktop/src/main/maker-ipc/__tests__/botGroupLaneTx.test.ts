import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sqlite: null as import('better-sqlite3').Database | null }));
vi.mock('electron', () => ({ app: { getPath: () => '/unused-user-data' } }));
vi.mock('../../appSessionState.js', () => ({ ownerScopedUserDataPath: () => '/unused-owner-root' }));
vi.mock('../../localDb/client/current.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  return { getDbClient: () => ({ drizzle: drizzle(h.sqlite!) }) };
});

import { tx } from '../../localDb/worker/opHandlers/tx.js';
import { BotPlanWorkDirUnavailableError, prepareBotWorkspaceRuntime } from '../botWorkspaceRuntime.js';
import { ensureBotChatOnlyWorkspaceDir } from '../botProfileFolder.js';
import { chatGroupLaneRouteKey, chatGroupTalkRouteKey } from '../../../shared/botGroupChat.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';

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
    agentKind: 'claude-code',
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
  let ownerRoot: string;
  let queries: string[];

  beforeEach(async () => {
    ownerRoot = await mkdtemp(path.join(tmpdir(), 'bot-lane-start-'));
    queries = [];
    db = h.sqlite = new Database(':memory:', { verbose: query => queries.push(String(query)) });
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE bot_profiles (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        current_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE bot_profile_versions (bot_id TEXT, version INTEGER, capabilities_json TEXT);
      INSERT INTO bot_profile_versions VALUES ('mimi',3,'{"permissions":"ask"}'), ('abu',1,'{"permissions":"ask"}');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, working_dir TEXT, workspace_kind TEXT, model TEXT,
        scheduled_model_baseline TEXT,
        effort TEXT, permission_mode TEXT, status TEXT NOT NULL, sdk_session_id TEXT,
        total_token_usage INTEGER, total_cost_usd REAL, context_tokens INTEGER,
        context_window INTEGER, fast_mode INTEGER, plan_mode_enabled INTEGER, cleared_at INTEGER,
        pinned_at INTEGER, user_send_at INTEGER, agent_kind TEXT, orca_role TEXT,
        parent_session_id TEXT, forked_at_message_id TEXT, worktree_path TEXT, extra_dirs TEXT,
        remote_host_id TEXT, agent_device_id TEXT, provider_id TEXT, source TEXT NOT NULL, created_at INTEGER,
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

  afterEach(async () => {
    db.close();
    await rm(ownerRoot, { recursive: true, force: true });
  });

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

  it('creates a separate 分工 Session per plan that works in the plan directory', () => {
    tx(db, { name: 'bots.createGroupLane', args: { botId: 'mimi', groupId: 'g1', routeKey: 'group:g1', session: laneSession('lane-1') } });
    const step = { ...laneSession('step-1'), workingDir: '/work/site-wt', workspaceKind: 'project' };
    expect(tx(db, { name: 'bots.createGroupLane', args: { botId: 'mimi', groupId: 'g1', routeKey: 'group:g1:plan:p1', session: step } }))
      .toEqual({ sessionId: 'step-1', created: true });
    expect(db.prepare("SELECT working_dir, workspace_kind FROM sessions WHERE id = 'step-1'").get())
      .toEqual({ working_dir: '/work/site-wt', workspace_kind: 'project' });
    expect(db.prepare("SELECT route_key FROM bot_session_links WHERE session_id = 'step-1'").get())
      .toEqual({ route_key: 'group:g1:plan:p1' });
  });

  it.each(['owner', 'tools', 'chat'] as const)('starts and restores a server plan lane with %s access without a local plan table', async mode => {
    const routeKey = `${chatGroupLaneRouteKey('g1', { mode, revision: 1 })}:plan:server-plan`;
    const workingDir = mode === 'chat'
      ? await ensureBotChatOnlyWorkspaceDir(ownerRoot, 'mimi', routeKey)
      : path.join(ownerRoot, 'project-worktree');
    await mkdir(workingDir, { recursive: true });
    const workspaceKind = mode === 'chat' ? 'dialogue' : 'project';
    const session = { ...laneSession('server-step'), workingDir, workspaceKind };
    // The real creation transaction persists the lane and its workspace, but no
    // bot_group_plans row: plan state lives on the chat server.
    tx(db, { name: 'bots.createGroupLane', args: { botId: 'mimi', groupId: 'g1', routeKey, session } });
    const ensureWorkspaceDir = vi.fn(async () => '/private-bot-home');
    for (let start = 0; start < 2; start++) {
      const opts: MakerSessionCreateOpts = { id: session.id, agentKind: 'claude-code', model: session.model, workingDir: '/stale-project', workspaceKind: 'project', remoteHostId: 'stale-host' };
      await prepareBotWorkspaceRuntime(opts, { ownerUserDataPath: () => ownerRoot, ensureWorkspaceDir });
      expect(opts).toMatchObject({ workingDir, workspaceKind, remoteHostId: undefined });
      expect((await stat(opts.workingDir)).isDirectory()).toBe(true);
    }
    expect(ensureWorkspaceDir).not.toHaveBeenCalled();
  });

  // bot-group-chat.md §7.0: a queue turn has no project folder. It starts where its group lane works:
  // the teammate's own place, or the grant's isolated chat folder for chat-only access.
  it.each(['owner', 'tools', 'chat'] as const)('starts a %s queue lane where its group lane works', async mode => {
    const access = { mode, revision: 1 };
    const routeKey = chatGroupTalkRouteKey('g1', access, 'queue-1');
    const workingDir = mode === 'chat' ? await ensureBotChatOnlyWorkspaceDir(ownerRoot, 'mimi', chatGroupLaneRouteKey('g1', access)) : '/private-bot-home';
    const session = { ...laneSession('queue-step'), workingDir, workspaceKind: 'dialogue' };
    tx(db, { name: 'bots.createGroupLane', args: { botId: 'mimi', groupId: 'g1', routeKey, session } });
    const ensureWorkspaceDir = vi.fn(async () => '/private-bot-home');
    const opts: MakerSessionCreateOpts = { id: session.id, agentKind: 'claude-code', model: session.model, workingDir: '', workspaceKind: 'project', remoteHostId: 'stale-host' };
    await prepareBotWorkspaceRuntime(opts, { ownerUserDataPath: () => ownerRoot, ensureWorkspaceDir });
    expect(opts).toMatchObject({ workingDir, workspaceKind: 'dialogue', remoteHostId: undefined });
  });

  it.each(['', ':plan:server-plan'])('isolates chat-only startup%s even with a matching legacy project plan and stale session directory', async suffix => {
    const routeKey = `${chatGroupLaneRouteKey('g1', { mode: 'chat', revision: 2 })}${suffix}`;
    const workingDir = await ensureBotChatOnlyWorkspaceDir(ownerRoot, 'mimi', routeKey);
    const projectDir = path.join(ownerRoot, 'private-project');
    await mkdir(projectDir);
    db.exec('CREATE TABLE bot_group_plans (id TEXT PRIMARY KEY, group_id TEXT, work_dir TEXT)');
    db.prepare('INSERT INTO bot_group_plans VALUES (?, ?, ?)').run('server-plan', 'g1', projectDir);
    const session = { ...laneSession('chat-step'), workingDir, workspaceKind: 'dialogue' };
    tx(db, { name: 'bots.createGroupLane', args: { botId: 'mimi', groupId: 'g1', routeKey, session } });
    // Recovery must not trust a prior startup's incorrect project projection.
    db.prepare('UPDATE sessions SET working_dir = ?, workspace_kind = ? WHERE id = ?').run(projectDir, 'project', session.id);
    await rm(workingDir, { recursive: true });
    const opts: MakerSessionCreateOpts = { id: session.id, agentKind: 'claude-code', model: session.model, workingDir: projectDir, workspaceKind: 'project' };
    const ensureWorkspaceDir = vi.fn(async () => '/private-bot-home');
    queries.length = 0;
    await prepareBotWorkspaceRuntime(opts, { ownerUserDataPath: () => ownerRoot, ensureWorkspaceDir });
    expect(opts).toMatchObject({ workingDir, workspaceKind: 'dialogue', remoteHostId: undefined });
    expect((await stat(workingDir)).isDirectory()).toBe(true);
    expect(queries.some(query => query.includes('bot_group_plans'))).toBe(false);
    expect(ensureWorkspaceDir).not.toHaveBeenCalled();
  });

  it.each(['owner', 'tools'] as const)('fails closed when a %s server plan has no usable recorded workspace', async mode => {
    const routeKey = `${chatGroupLaneRouteKey('g1', { mode, revision: 1 })}:plan:server-plan`;
    const session = { ...laneSession('server-step'), workingDir: path.join(ownerRoot, 'missing'), workspaceKind: 'project' };
    tx(db, { name: 'bots.createGroupLane', args: { botId: 'mimi', groupId: 'g1', routeKey, session } });
    const ensureWorkspaceDir = vi.fn(async () => '/private-bot-home');
    for (const recorded of [session.workingDir, null]) {
      db.prepare('UPDATE sessions SET working_dir = ? WHERE id = ?').run(recorded, session.id);
      const opts: MakerSessionCreateOpts = { id: session.id, agentKind: 'claude-code', model: session.model, workingDir: ownerRoot, workspaceKind: 'project' };
      await expect(prepareBotWorkspaceRuntime(opts, { ensureWorkspaceDir })).rejects.toBeInstanceOf(BotPlanWorkDirUnavailableError);
      expect(opts.workingDir).toBe(ownerRoot);
    }
    expect(ensureWorkspaceDir).not.toHaveBeenCalled();
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

  describe('IM channel lanes (connection handed to a Bot)', () => {
    const groupKey = 'im:telegram:777:g:-100123';
    const topicKey = 'im:telegram:777:g:-100123:t:9';

    it('creates one hidden channel lane per route key without a group-member check and reuses it', () => {
      // abu is active but not a member of any local group.
      const args = { botId: 'abu', routeKey: groupKey, session: laneSession('im-lane-1') };
      expect(tx(db, { name: 'bots.createChannelLane', args })).toEqual({ sessionId: 'im-lane-1', created: true });
      expect(tx(db, { name: 'bots.createChannelLane', args: { ...args, session: laneSession('im-lane-2') } }))
        .toEqual({ sessionId: 'im-lane-1', created: false });
      // A topic is its own lane.
      expect(tx(db, { name: 'bots.createChannelLane', args: { ...args, routeKey: topicKey, session: laneSession('im-topic') } }))
        .toEqual({ sessionId: 'im-topic', created: true });
      expect(db.prepare("SELECT bot_id, role, route_key, profile_version FROM bot_session_links WHERE session_id = 'im-lane-1'").get())
        .toEqual({ bot_id: 'abu', role: 'channel', route_key: groupKey, profile_version: 1 });
      expect(db.prepare("SELECT source, status FROM sessions WHERE id = 'im-lane-1'").get())
        .toEqual({ source: 'bot', status: 'active' });
    });

    it('opens a fresh lane once the previous one for the same route key is archived', () => {
      tx(db, { name: 'bots.createChannelLane', args: { botId: 'mimi', routeKey: groupKey, session: laneSession('im-old') } });
      expect(tx(db, {
        name: 'bots.archiveChannelLanes',
        args: { routeKey: groupKey, routeKeyPrefix: null, exceptBotId: null, now: 77 },
      })).toEqual({ archivedSessionIds: ['im-old'] });
      expect(db.prepare("SELECT archived_at FROM bot_session_links WHERE session_id = 'im-old'").get())
        .toEqual({ archived_at: 77 });
      expect(db.prepare("SELECT status FROM sessions WHERE id = 'im-old'").get()).toEqual({ status: 'archived' });
      expect(tx(db, { name: 'bots.createChannelLane', args: { botId: 'mimi', routeKey: groupKey, session: laneSession('im-new') } }))
        .toEqual({ sessionId: 'im-new', created: true });
    });

    it('archives a whole connection by prefix, keeping the newly bound Bot and other connections', () => {
      tx(db, { name: 'bots.createChannelLane', args: { botId: 'mimi', routeKey: groupKey, session: laneSession('im-mimi') } });
      tx(db, { name: 'bots.createChannelLane', args: { botId: 'abu', routeKey: topicKey, session: laneSession('im-abu') } });
      tx(db, { name: 'bots.createChannelLane', args: { botId: 'mimi', routeKey: 'im:telegram:7770:g:1', session: laneSession('im-other') } });
      tx(db, { name: 'bots.createGroupLane', args: { botId: 'mimi', groupId: 'g1', routeKey: 'group:g1', session: laneSession('lane-1') } });
      expect(tx(db, {
        name: 'bots.archiveChannelLanes',
        args: { routeKey: null, routeKeyPrefix: 'im:telegram:777:', exceptBotId: 'abu', now: 5 },
      })).toEqual({ archivedSessionIds: ['im-mimi'] });
      expect(db.prepare("SELECT id, status FROM sessions WHERE id IN ('im-mimi','im-abu','im-other','lane-1') ORDER BY id").all())
        .toEqual([
          { id: 'im-abu', status: 'active' },
          { id: 'im-mimi', status: 'archived' },
          { id: 'im-other', status: 'active' },
          { id: 'lane-1', status: 'active' },
        ]);
    });

    it('refuses lanes for unavailable Bots and non-IM route keys', () => {
      expect(() => tx(db, {
        name: 'bots.createChannelLane',
        args: { botId: 'kapi', routeKey: groupKey, session: laneSession('im-x') },
      })).toThrow(expect.objectContaining({ code: 'BOT_UNAVAILABLE' }));
      expect(() => tx(db, {
        name: 'bots.createChannelLane',
        args: { botId: 'mimi', routeKey: 'group:g1', session: laneSession('im-y') },
      })).toThrow();
      expect(() => tx(db, {
        name: 'bots.archiveChannelLanes',
        args: { routeKey: groupKey, routeKeyPrefix: 'im:telegram:777:', exceptBotId: null, now: 1 },
      })).toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'im-%'").get()).toEqual({ n: 0 });
    });

    it('starts a channel lane in the Bot Home workspace', async () => {
      tx(db, { name: 'bots.createChannelLane', args: { botId: 'mimi', routeKey: groupKey, session: laneSession('im-lane-1') } });
      const ensureWorkspaceDir = vi.fn(async () => '/bots/mimi/workspace');
      const opts: MakerSessionCreateOpts = { id: 'im-lane-1', agentKind: 'claude-code', model: 'model-a', workingDir: '/stale', workspaceKind: 'project', remoteHostId: 'stale-host' };
      await prepareBotWorkspaceRuntime(opts, { ownerUserDataPath: () => ownerRoot, ensureWorkspaceDir, legacyUserDataPath: () => '/legacy' });
      expect(opts).toMatchObject({ workingDir: '/bots/mimi/workspace', workspaceKind: 'dialogue', remoteHostId: undefined });
      expect(ensureWorkspaceDir).toHaveBeenCalledWith(ownerRoot, 'mimi', '/legacy');
    });

    it('deletes channel lanes instead of keeping them as task history when a Bot is deleted', () => {
      tx(db, { name: 'bots.createChannelLane', args: { botId: 'mimi', routeKey: groupKey, session: laneSession('im-lane-1') } });
      db.exec("UPDATE bot_profiles SET status = 'archived' WHERE id = 'mimi'");
      expect(tx(db, {
        name: 'bots.deleteProfile',
        args: { botId: 'mimi', sessionIds: ['mimi-main', 'im-lane-1'], keepTaskHistory: true, at: 50 },
      })).toEqual({ sessionIds: ['mimi-main', 'im-lane-1'], status: 'archived' });
      expect(db.prepare('SELECT id, source, status FROM sessions ORDER BY id').all()).toEqual([
        { id: 'im-lane-1', source: 'bot', status: 'deleted' },
        { id: 'mimi-main', source: 'desktop', status: 'archived' },
      ]);
    });
  });
});
