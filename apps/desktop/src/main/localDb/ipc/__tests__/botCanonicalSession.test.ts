import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_TEMPLATE_PRESET_IDENTITIES } from '../../../../shared/botTemplatePreset';

import {
  botDelegations,
  botLifecycleEvents,
  botProfiles,
  botProfileVersions,
  botRuntimeSnapshots,
  botSessionLinks,
  messages,
  sessions,
} from '../../schema';

const h = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
  sqlite: null as Database.Database | null,
  tx: null as null | ((name: string, args: unknown) => Promise<unknown>),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  nextSession: 0,
  worktrees: [] as Array<{
    sessionId: string;
    name: string;
    path: string;
    baseRepo: string;
    branch: string;
    sourceBranch: string;
    createdAt: string;
  }>,
  removeWorktree: vi.fn(async () => {
    h.worktrees = [];
  }),
  isSessionAlive: vi.fn(() => false),
  remove: vi.fn(async () => undefined),
  ensureGit: vi.fn(async () => undefined),
  closeSession: vi.fn(async () => undefined),
  getSession: vi.fn(() => null as {
    capabilities?: { manualCompact?: { supported?: boolean } };
    compactSession: (instructions?: string) => Promise<unknown>;
  } | null),
  ensureDialogue: vi.fn((sessionId: string) => `/tmp/cindy-bot-test/${sessionId}`),
  searchConversations: vi.fn(),
  requestRuntimeRefresh: vi.fn(),
  seedTemplateSkills: vi.fn(async () => ({ completedNow: true, skills: [] })),
  ownerScopeKey: 'owner-a:1',
  ownerBoundaryPending: false,
}));

vi.mock('node:fs/promises', () => ({ default: { rm: h.remove } }));
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/cindy-bot-test'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));
vi.mock('../../client/current', () => ({
  getDbClient: () => ({ drizzle: h.db, tx: h.tx }),
  tryGetDbClient: () => ({ drizzle: h.db, tx: h.tx }),
}));
vi.mock('../../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: vi.fn(),
}));
vi.mock('../../../sessionIds.js', () => ({
  resolveBusinessSessionId: () => `session-${++h.nextSession}`,
}));
vi.mock('../../dialogueWorkspace.js', () => ({
  ensureDialogueWorkspaceDir: h.ensureDialogue,
}));
vi.mock('../../../git-snapshot/projectGitBootstrap.js', () => ({
  ensureProjectGitInitialized: h.ensureGit,
}));
vi.mock('../../../maker-host/git-safety-settings-store.js', () => ({
  readGitSafetySettings: () => ({ autoSnapshotEnabled: true }),
}));
vi.mock('../../../maker-host/index.js', () => ({
  getMakerIfReady: () => ({
    isSessionAlive: h.isSessionAlive,
    closeSession: h.closeSession,
    getSession: h.getSession,
  }),
}));
vi.mock('../../../worktree/index.js', () => ({
  WorktreeManager: {
    createWorktree: vi.fn(),
    getForSession: vi.fn(
      (sessionId: string) => h.worktrees.find((meta) => meta.sessionId === sessionId) ?? null,
    ),
    listAll: vi.fn(() => h.worktrees),
    removeWorktreeForSession: h.removeWorktree,
  },
  restoreWorktreeForSession: vi.fn(async () => ({ ok: false, reason: 'gone' })),
  worktreeStore: {
    set: vi.fn(async () => undefined),
    del: vi.fn(),
  },
}));
vi.mock('../../../maker-ipc/botRemoteWorkspaceService.js', () => ({
  createRemoteBotWorktree: vi.fn(),
  inspectRemoteBotWorktree: vi.fn(),
  removeRemoteBotWorktree: vi.fn(),
}));
vi.mock('../../conversationSearch.js', () => ({
  searchConversations: h.searchConversations,
}));
vi.mock('../../../maker-ipc/botRuntimeEpochRefreshSignal.js', () => ({
  requestBotRuntimeEpochRefresh: h.requestRuntimeRefresh,
}));
vi.mock('../../../maker-ipc/botTemplateSkillSeed.js', () => ({
  seedBotTemplateSkills: h.seedTemplateSkills,
}));
vi.mock('../../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../appSessionState.js')>();
  return {
    ...actual,
    activeOwnerScopeKey: () => h.ownerScopeKey,
    isAppSessionBoundaryPending: () => h.ownerBoundaryPending,
    ownerScopedUserDataPath: () => `/tmp/cindy-bot-test/${h.ownerScopeKey}`,
  };
});

import {
  createBotCanonicalSession,
  registerBotIpc,
  getBotRemoteResourceSource,
  listBotRemoteResourceSources,
} from '../bots';
import { tx as runWorkerTx } from '../../worker/opHandlers/tx.js';
import { assertTrustedAppRendererEvent } from '../../../security/trustedAppRenderer.js';
import { runDeviceLinkInvokeContext } from '../../../device-link/invoke-context.js';
import {
  hydrateBotProfileRuntime,
  markBotProfileRuntimeApplied,
  markBotProfileRuntimeFailed,
} from '../../../maker-ipc/botProfileRuntime';
import { createBotDelegationService } from '../../../maker-ipc/botDelegationService';
import {
  BOT_DELEGATION_MAX_DISPATCH_ATTEMPTS,
} from '../../../maker-ipc/botDelegationDispatchOutcome';
import { ACCOUNT_PROVIDER_NOT_READY_CODE } from '../../../../shared/accountProviderReadiness';
import { configureBotCanonicalReplacementCoordinator } from '../../../maker-ipc/botCanonicalReplacementCoordinator';
import type { MakerSessionCreateOpts } from '../../../maker-ipc/sessionRequest';
import { parseBotDelegationPlanSnapshot } from '../../../../shared/botDelegation';
import { readBotCollaborationMeta } from '../../../../shared/botCollaboration';
import { UI_ACTION_TRIGGER_PREFIX } from '../../../../shared/interruptedTurn';
import { resolveBotCanonicalSession } from '../../../maker-ipc/botCanonicalSessionRegistry';

function testSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createDb(filename = ':memory:'): void {
  const sqlite = new Database(filename);
  sqlite.pragma('foreign_keys = ON');
  if (filename !== ':memory:') sqlite.pragma('journal_mode = WAL');
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
    CREATE TABLE messages (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_use_id TEXT,
      agent_meta TEXT,
      agent_kind TEXT,
      created_at INTEGER NOT NULL,
      rewind_at INTEGER
    );
    CREATE TABLE agent_input_queue_snapshots (
      session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
    CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);
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
    CREATE TABLE bot_delegations (
      id TEXT PRIMARY KEY NOT NULL,
      requesting_bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      target_bot_id TEXT REFERENCES bot_profiles(id) ON DELETE CASCADE,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      child_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      objective TEXT NOT NULL,
      context_refs_json TEXT DEFAULT '[]' NOT NULL,
      artifact_refs_json TEXT DEFAULT '[]' NOT NULL,
      permission_snapshot_json TEXT DEFAULT '{}' NOT NULL,
      lineage_json TEXT DEFAULT '[]' NOT NULL,
      target_profile_version INTEGER,
      depth INTEGER DEFAULT 1 NOT NULL,
      budget_tokens INTEGER,
      tokens_used INTEGER DEFAULT 0 NOT NULL,
      status TEXT DEFAULT 'queued' NOT NULL,
      result_summary TEXT,
      output_artifacts_json TEXT DEFAULT '[]' NOT NULL,
      pending_interaction_json TEXT,
      last_error TEXT,
      run_sequence INTEGER DEFAULT 1 NOT NULL,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      completed_at INTEGER,
      completion_delivered_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  h.sqlite = sqlite;
  const rawDb = drizzle(sqlite, {
    schema: {
      sessions,
      botProfiles,
      botProfileVersions,
      botDelegations,
      botSessionLinks,
      botRuntimeSnapshots,
      botLifecycleEvents,
      messages,
    },
  });
  h.db = rawDb;
  h.tx = async (name, args) => runWorkerTx(sqlite, { name: name as never, args } as never);
}

async function invoke(channel: string, body: unknown): Promise<any> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`${channel} handler not registered`);
  return handler({}, body);
}
beforeEach(async () => {
  vi.clearAllMocks();
  h.handlers.clear();
  h.nextSession = 0;
  h.worktrees = [];
  h.isSessionAlive.mockReturnValue(false);
  h.ensureGit.mockResolvedValue(undefined);
  h.closeSession.mockClear();
  h.getSession.mockReset();
  h.getSession.mockReturnValue(null);
  h.ownerScopeKey = 'owner-a:1';
  h.ownerBoundaryPending = false;
  h.searchConversations.mockResolvedValue({
    query: '',
    results: [],
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  });
  configureBotCanonicalReplacementCoordinator(async (_sessionId, operation) => operation());
  h.sqlite?.close();
  createDb();
  registerBotIpc();
  await invoke('local-db:bots:create', {
    id: 'bot-1',
    name: 'Release Bot',
    capabilities: {
      harness: 'pi',
      model: 'grok-4.5',
      permissions: 'trusted',
    },
  });
});

describe('Bot canonical Session lifecycle', () => {

  it('projects canonical remote identity without exposing profile instructions or runtime snapshots', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'remote-writer', name: 'Writer', identitySource: 'Private background',
      capabilities: { permissions: 'auto', userContextSource: 'Private user context' },
    });
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: created.id, expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const source = await getBotRemoteResourceSource(created.id);
    expect(source).toMatchObject({ id: created.id, name: 'Writer', canonicalSessionId: canonical.session.id });
    expect(JSON.stringify(source)).not.toContain('Private');
    expect(source).not.toHaveProperty('capabilities');
    expect(source).not.toHaveProperty('sessions');
    expect((await listBotRemoteResourceSources()).map((row) => row.id)).toContain(created.id);
    h.sqlite!.prepare('UPDATE bot_profiles SET hidden_at = 1 WHERE id = ?').run(created.id);
    expect((await listBotRemoteResourceSources()).map((row) => row.id)).not.toContain(created.id);
  });

  it('uses the official Bot defaults when created without renderer capabilities', async () => {
    await invoke('local-db:bots:create', {
      id: 'bot-defaults',
      name: 'Default Bot',
    });

    const row = h.sqlite!
      .prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1')
      .get('bot-defaults') as { capabilities_json: string };
    const capabilities = JSON.parse(row.capabilities_json) as {
      modelChain?: Array<Record<string, unknown>>;
      skills?: unknown[];
      toolsets?: unknown[];
      mcpServers?: unknown[];
    };

    expect(capabilities.modelChain?.[0]).toMatchObject({
      harness: 'pi',
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'high',
    });
    expect(capabilities.skills).toEqual([]);
    expect(capabilities.toolsets).toEqual([]);
    expect(capabilities.mcpServers).toEqual([]);
  });

  it('persists the first greeting and canonical task in the main-owned create path', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'bot-welcome',
      name: 'Welcome Bot',
      welcomeMessage: '你好，我已经准备好了。',
    });
    const sessionId = created.canonicalSessionId as string;
    expect(sessionId).toBeTruthy();
    expect(
      h.sqlite!.prepare('SELECT role, content FROM messages WHERE session_id = ? AND client_id = ?')
        .get(sessionId, 'bot-welcome:bot-welcome'),
    ).toEqual({ role: 'assistant', content: '你好，我已经准备好了。' });
  });

  it('does not project a created profile across an owner switch during the database write', async () => {
    const runTx = h.tx!;
    h.tx = async (name, args) => {
      const result = await runTx(name, args);
      h.ownerScopeKey = 'owner-b:2';
      return result;
    };

    await expect(
      invoke('local-db:bots:create', {
        id: 'bot-owner-switch',
        name: 'Owner A Bot',
        templateId: 'cindy',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.seedTemplateSkills).not.toHaveBeenCalledWith(
      expect.anything(),
      'bot-owner-switch',
      expect.anything(),
    );
  });

  it.each(['profile', 'skills', 'avatar', 'welcome', 'failed'])('keeps initial invitation %s preparation from racing with profile edits', async (stage) => {
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ?')
      .run(JSON.stringify({ invitation: { id: 'invite-1', stage } }), 'bot-1');
    await expect(invoke('local-db:bots:update', { id: 'bot-1', name: 'New name' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.sqlite!.prepare('SELECT display_name AS name, current_version FROM bot_profiles WHERE id = ?').get('bot-1'))
      .toEqual({ name: 'Release Bot', current_version: 1 });
  });

  it('allows profile edits while an existing companion retries only its portrait', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ?')
      .run(JSON.stringify({ invitation: { id: 'invite-1', stage: 'avatar' } }), 'bot-1');
    const updated = await invoke('local-db:bots:update', { id: 'bot-1', name: 'New name' });
    expect(updated.name).toBe('New name');
    expect(updated.invitation.stage).toBe('avatar');
  });

  it('stops profile saving before projecting or writing files under a newly selected owner', async () => {
    const runTx = h.tx!;
    h.tx = async (name, args) => {
      const result = await runTx(name, args);
      if (name === 'bots.updateProfile') h.ownerScopeKey = 'owner-b:2';
      return result;
    };
    await expect(invoke('local-db:bots:update', {
      id: 'bot-1', identitySource: 'Only belongs to owner A',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.requestRuntimeRefresh).not.toHaveBeenCalled();
  });

  it('does not create a canonical task after the account changes during workspace preparation', async () => {
    h.ensureGit.mockImplementationOnce(async () => {
      h.ownerScopeKey = 'owner-b:2';
    });
    await expect(invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.sqlite!.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual({ count: 0 });
  });

  it('projects the newest runtime snapshot without returning historical capability payloads', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const insert = h.sqlite!.prepare(`INSERT INTO bot_runtime_snapshots
      (id, bot_id, session_id, profile_version, agent_kind, working_dir, status, prepared_at, configured_json)
      VALUES (?, 'bot-1', ?, 1, 'pi', '/workspace', 'prepared', ?, ?)`);
    for (let i = 1; i <= 100; i++) {
      insert.run(`snapshot-${i}`, created.session.id, i, JSON.stringify({ generation: i }));
    }
    const profile = await invoke('local-db:bots:get', 'bot-1');
    expect(profile.sessions).toHaveLength(1);
    expect(profile.sessions[0].runtimeSnapshot).toMatchObject({
      preparedAt: 100, configured: { generation: 100 },
    });
    expect(h.sqlite!.prepare('SELECT COUNT(*) AS count FROM bot_runtime_snapshots').get())
      .toEqual({ count: 100 });
  });

  it('persists a preset and retries its Skill install before the first task', async () => {
    h.seedTemplateSkills.mockRejectedValueOnce(new Error('disk busy'));
    await invoke('local-db:bots:create', {
      id: 'bot-dash',
      name: 'Dash',
      templateId: 'dash',
      capabilities: { toolsetMode: 'allowlist', toolsets: ['docs'] },
    });

    const row = h.sqlite!
      .prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1')
      .get('bot-dash') as { capabilities_json: string };
    expect(JSON.parse(row.capabilities_json)).toMatchObject({
      templateId: 'dash',
      toolsets: ['docs'],
    });

    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-dash',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    expect(h.seedTemplateSkills).toHaveBeenNthCalledWith(1, expect.any(String), 'bot-dash', 'dash');
    expect(h.seedTemplateSkills).toHaveBeenNthCalledWith(2, expect.any(String), 'bot-dash', 'dash');
  });

  it('recovers Skills for an older built-in partner without a stored template id', async () => {
    await invoke('local-db:bots:create', {
      id: 'bot-legacy-cindy',
      name: 'Cindy',
      identitySource: BOT_TEMPLATE_PRESET_IDENTITIES.cindy,
      capabilities: { toolsetMode: 'allowlist', toolsets: ['docs'] },
    });
    expect(h.seedTemplateSkills).not.toHaveBeenCalledWith(
      expect.any(String),
      'bot-legacy-cindy',
      'cindy',
    );

    await invoke('local-db:bots:list', {});

    expect(h.seedTemplateSkills).toHaveBeenCalledWith(
      expect.any(String),
      'bot-legacy-cindy',
      'cindy',
    );
  });

  it('does not infer a template after the partner identity was customized', async () => {
    await invoke('local-db:bots:create', {
      id: 'bot-customized-cindy',
      name: 'Cindy',
      identitySource: `${BOT_TEMPLATE_PRESET_IDENTITIES.cindy}\n\n# 我的补充`,
    });

    await invoke('local-db:bots:list', {});

    expect(h.seedTemplateSkills).not.toHaveBeenCalledWith(
      expect.any(String),
      'bot-customized-cindy',
      expect.anything(),
    );
  });

  it('refreshes an existing runtime after a delayed preset Skill recovery', async () => {
    h.seedTemplateSkills
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockRejectedValueOnce(new Error('disk still busy'));
    await invoke('local-db:bots:create', {
      id: 'bot-lizi',
      name: 'LiZi',
      templateId: 'lizi',
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-lizi',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    await invoke('local-db:bots:get', 'bot-lizi');
    expect(h.requestRuntimeRefresh).toHaveBeenCalledWith(created.canonicalSessionId, 'resource');
  });

  it('rejects an unknown template before creating a profile', async () => {
    await expect(
      invoke('local-db:bots:create', {
        id: 'bot-unknown-template',
        name: 'Unknown',
        templateId: 'designer',
      }),
    ).rejects.toThrow('未知的伙伴模板');
    expect(
      h.sqlite!.prepare('SELECT id FROM bot_profiles WHERE id = ?').get('bot-unknown-template'),
    ).toBeUndefined();
  });

  it('allows device-link to read Bot projections without weakening local renderer trust', async () => {
    const list = h.handlers.get('local-db:bots:list');
    const get = h.handlers.get('local-db:bots:get');
    expect(list).toBeTypeOf('function');
    expect(get).toBeTypeOf('function');

    vi.mocked(assertTrustedAppRendererEvent).mockClear();
    await list!({});
    await get!({}, 'bot-1');
    expect(assertTrustedAppRendererEvent).toHaveBeenCalledTimes(2);

    vi.mocked(assertTrustedAppRendererEvent).mockClear();
    const remoteList = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'mobile-1', channel: 'local-db:bots:list' },
      () => list!({}),
    );
    const remoteGet = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'mobile-1', channel: 'local-db:bots:get' },
      () => get!({}, 'bot-1'),
    );
    expect(assertTrustedAppRendererEvent).not.toHaveBeenCalled();
    for (const projection of [...(remoteList as any[]), remoteGet]) {
      expect(projection).toMatchObject({
        id: 'bot-1',
        name: 'Release Bot',
      });
      expect(projection).not.toHaveProperty('identitySource');
      expect(projection).not.toHaveProperty('userContextSource');
      expect(projection).not.toHaveProperty('capabilities');
    }
  });

  it('freezes provider, model, effort, and Fast Mode into the canonical Session', async () => {
    await invoke('local-db:bots:create', {
      id: 'bot-model-profile',
      name: 'Model Profile Bot',
      capabilities: {
        harness: 'codex',
        providerId: 'openai',
        model: 'gpt-5.6-sol',
        effort: 'xhigh',
        fastMode: true,
        permissions: 'ask',
      },
    });

    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-model-profile',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    expect(created.session).toMatchObject({
      agentKind: 'codex',
      providerId: 'openai',
      model: 'gpt-5.6-sol',
      effort: 'xhigh',
      fastMode: true,
    });
  });

  it.each([
    ['pi', 'z-ai/glm-5.3-flash'],
    ['claude', 'claude-sonnet-4-6'],
    ['codex', 'gpt-5.6-sol'],
  ])('keeps automatic review on the %s canonical task', async (harness, model) => {
    const profile = await invoke('local-db:bots:create', {
      id: `auto-${harness}`, name: 'Auto review companion',
      capabilities: { harness, model, permissions: 'auto' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: profile.id, expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    expect(created.session).toMatchObject({ permissionMode: 'auto', agentKind: harness === 'claude' ? 'cc' : harness });
  });

  it.each([
    [undefined, 'auto'],
    ['auto', 'auto'],
    ['ask', 'ask'],
    ['trusted', 'bypassPermissions'],
  ])('creates a canonical task with permission %s mapped to %s', async (permissions, permissionMode) => {
    const profile = await invoke('local-db:bots:create', {
      id: 'bot-permission', name: 'Permission Bot',
      capabilities: permissions ? { permissions } : {},
    });
    expect(profile.capabilities.permissions).toBe(permissions ?? 'auto');
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: profile.id, expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    expect(created.session.permissionMode).toBe(permissionMode);
    // The permission chip persists the canonical task's choice. Reopening it must
    // retain that choice rather than reapplying the profile's creation default.
    h.sqlite!.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?')
      .run('ask', created.session.id);
    const reopened = await invoke('local-db:bots:create-canonical-session', {
      botId: profile.id, expectedCanonicalSessionId: created.session.id, expectedProfileVersion: 1,
    });
    expect(reopened.session.permissionMode).toBe('ask');
  });

  it('preserves an explicitly empty model when a Pi Bot has no selectable model', async () => {
    await invoke('local-db:bots:create', {
      id: 'bot-pi-default',
      name: 'Pi Default Bot',
      capabilities: {
        harness: 'pi',
        providerId: null,
        model: '',
        effort: '',
        permissions: 'ask',
      },
    });

    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-pi-default',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    expect(created.session).toMatchObject({
      agentKind: 'pi',
      providerId: null,
      model: '',
    });
  });

  it('repairs a physically missing canonical task using the persisted pointer as its CAS', async () => {
    h.sqlite!.pragma('foreign_keys = OFF');
    h.sqlite!
      .prepare("UPDATE bot_profiles SET canonical_session_id = 'missing-canonical' WHERE id = 'bot-1'")
      .run();
    h.sqlite!.pragma('foreign_keys = ON');

    const repaired = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: 'missing-canonical',
      expectedProfileVersion: 1,
      recoverMissingOnly: true,
    });

    expect(repaired).toMatchObject({ created: true, canonicalSessionId: 'session-1' });
    expect(
      h.sqlite!.prepare('SELECT canonical_session_id FROM bot_profiles WHERE id = ?').pluck().get('bot-1'),
    ).toBe('session-1');
    expect(
      h.sqlite!
        .prepare('SELECT event_type, payload_json FROM bot_lifecycle_events WHERE session_id = ?')
        .get('session-1'),
    ).toMatchObject({
      event_type: 'canonical-recovered',
      payload_json: expect.stringContaining('missing-canonical'),
    });
  });

  it('never turns a transient canonical read failure into an implicit replacement', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    await expect(
      invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1',
        expectedCanonicalSessionId: created.session.id,
        expectedProfileVersion: 1,
        recoverMissingOnly: true,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(
      h.sqlite!.prepare('SELECT canonical_session_id FROM bot_profiles WHERE id = ?').pluck().get('bot-1'),
    ).toBe(created.session.id);
    expect(
      h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get(created.session.id),
    ).toBe('active');
  });

  it('keeps the same healthy main task across dates and long idle periods', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.sqlite!
      .prepare('UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?')
      .run(1, 1, created.session.id);

    const reopened = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: created.session.id,
      expectedProfileVersion: 1,
    });

    expect(reopened).toMatchObject({
      created: false,
      canonicalSessionId: created.session.id,
    });
    expect(h.sqlite!.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
    expect(
      h.sqlite!
        .prepare("SELECT COUNT(*) FROM bot_session_links WHERE role = 'history'")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it('rejects ordinary canonical creation for an archived Bot', async () => {
    h.sqlite!.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = 'bot-1'").run();

    await expect(
      invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1',
        expectedCanonicalSessionId: null,
        expectedProfileVersion: 1,
      }),
    ).rejects.toThrow('archived');
    expect(h.sqlite!.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(0);
  });

  it('projects durable typed attention into the Bot list', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.sqlite!.prepare(`UPDATE bot_profiles
      SET attention_reason = 'provider_quota_limit', attention_at = 42
      WHERE id = 'bot-1'`).run();

    const [profile] = await invoke('local-db:bots:list', undefined);
    expect(profile).toMatchObject({
      id: 'bot-1',
      failureReason: 'provider_quota_limit',
      needsAttention: true,
    });
  });

  it('resolves Bot history ids in main and never accepts a renderer-owned search scope', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.searchConversations.mockResolvedValue({
      query: 'release',
      results: [],
      vectorUsed: false,
      vectorSkipReason: null,
      poolCapped: false,
    });

    await invoke('local-db:bots:search-history', {
      botId: 'bot-1',
      query: 'release',
      limit: 12,
      sessionIds: ['foreign-session'],
    });

    expect(h.searchConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'release',
        limit: 12,
        filters: expect.objectContaining({ sessionIds: [created.session.id] }),
      }),
      { sessionSources: null },
    );
  });

  it('records runtime preparation separately from successful Agent startup', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const snapshot = await hydrateBotProfileRuntime({
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    });

    expect(snapshot).toMatchObject({
      botId: 'bot-1',
      sessionId: created.session.id,
      profileVersion: 1,
      resolutionStatus: 'applied',
    });
    expect(
      h
        .sqlite!.prepare(
          'SELECT status, prepared_at AS preparedAt, applied_at AS appliedAt, failed_at AS failedAt FROM bot_runtime_snapshots WHERE id = ?',
        )
        .get(snapshot!.snapshotId),
    ).toMatchObject({
      status: 'prepared',
      appliedAt: null,
      failedAt: null,
    });

    await expect(markBotProfileRuntimeApplied(snapshot!)).resolves.toBe(true);
    expect(
      h
        .sqlite!.prepare(
          'SELECT status, applied_at AS appliedAt, failed_at AS failedAt FROM bot_runtime_snapshots WHERE id = ?',
        )
        .get(snapshot!.snapshotId),
    ).toMatchObject({
      status: 'applied',
      failedAt: null,
    });
    expect(
      h
        .sqlite!.prepare(
          'SELECT event_type FROM bot_lifecycle_events WHERE bot_id = ? ORDER BY created_at ASC',
        )
        .all('bot-1'),
    ).toEqual(
      expect.arrayContaining([
        { event_type: 'runtime-prepared' },
        { event_type: 'runtime-applied' },
      ]),
    );
    expect(
      h.sqlite!.prepare('SELECT attention_reason, attention_at FROM bot_profiles WHERE id = ?')
        .get('bot-1'),
    ).toEqual({ attention_reason: null, attention_at: null });
  });

  it('freezes only Bot Home and USER memory references into the runtime snapshot', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      userContextSource: 'Call the user Chris. Prefer concise Chinese updates.',
      capabilities: { memory: true },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 2,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    };
    const readMemoryIndex = vi.fn(async (scopeKey: string) =>
      scopeKey.startsWith('bot:') ? '# Bot facts\n- Durable fact' : '# Project facts\n- Read only',
    );

    const snapshot = await hydrateBotProfileRuntime(opts, { readMemoryIndex });

    expect(snapshot?.memoryRefs).toEqual([
      expect.objectContaining({ kind: 'bot', access: 'read-write', status: 'captured' }),
      expect.objectContaining({ kind: 'user', access: 'read-only', status: 'captured' }),
    ]);
    expect(opts.makerMemoryIndexSnapshot).toContain('## Bot Memory');
    expect(opts.makerMemoryIndexSnapshot).toContain('Durable fact');
    expect(opts.makerMemoryIndexSnapshot).not.toContain('Project Memory');
    expect(opts.makerMemoryIndexSnapshot).toContain('only durable memory for this Bot');
    expect(opts.botUserProfilePrompt).toContain('## User Profile');
    expect(opts.botUserProfilePrompt).toContain('Call the user Chris');
    const row = h
      .sqlite!.prepare(
        `SELECT configured_json AS configuredJson, resolved_json AS resolvedJson
         FROM bot_runtime_snapshots WHERE id = ?`,
      )
      .get(snapshot!.snapshotId) as { configuredJson: string; resolvedJson: string };
    const configured = JSON.parse(row.configuredJson) as Record<string, unknown>;
    const resolved = JSON.parse(row.resolvedJson) as { memoryRefs: Array<Record<string, unknown>> };
    expect(configured).toMatchObject({
      schemaVersion: 1,
      profile: {
        botId: 'bot-1',
        version: 2,
        userContextSha256: testSha256('Call the user Chris. Prefer concise Chinese updates.'),
      },
      execution: {
        agentKind: 'pi',
        model: 'grok-4.5',
        providerId: null,
        permissionMode: 'bypassPermissions',
        workspaceKind: 'dialogue',
        remote: false,
      },
      memory: true,
    });
    expect(resolved.memoryRefs).toHaveLength(2);
    expect(row.resolvedJson).not.toContain('Durable fact');
    expect(row.resolvedJson).not.toContain('Call the user Chris');
  });

  it('degrades without blocking when a frozen memory source cannot be read', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    };

    const snapshot = await hydrateBotProfileRuntime(opts, {
      readMemoryIndex: async (scopeKey) => {
        if (scopeKey.startsWith('bot:')) throw new Error('memory unavailable');
        return '';
      },
    });

    expect(snapshot?.resolutionStatus).toBe('degraded');
    expect(snapshot?.memoryRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'bot', status: 'unavailable' }),
      ]),
    );
    expect(snapshot?.memoryRefs.some((ref) => ref.kind === 'project')).toBe(false);
  });

  it('keeps Bot Home Memory independent from the global Maker Memory switch', async () => {
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { memory: true } });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 2,
    });
    const makeOpts = (): MakerSessionCreateOpts => ({
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    });

    const engineOff = makeOpts();
    engineOff.makerMemoryEnabled = false;
    await hydrateBotProfileRuntime(engineOff, {
      readMemoryIndex: async () => '# Bot facts\n- Durable fact',
    }, { persistSnapshot: false });
    expect(engineOff.makerMemoryEnabled).toBe(true);
    expect(engineOff.makerMemoryIndexSnapshot).toContain('Durable fact');

    const engineOn = makeOpts();
    engineOn.makerMemoryEnabled = true;
    await hydrateBotProfileRuntime(engineOn, {
      readMemoryIndex: async () => '# Bot facts\n- Durable fact',
    }, { persistSnapshot: false });
    expect(engineOn.makerMemoryEnabled).toBe(true);
    // Both settings states resolve to the same Bot-owned memory space.
    expect(engineOff.makerMemoryScopeKey).toBe(engineOn.makerMemoryScopeKey);
  });

  it('refuses to start a remote Bot when its native Skill catalog is unavailable', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: '/srv/cindy-bot',
      remoteHostId: 'remote-host-1',
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    };

    await expect(hydrateBotProfileRuntime(opts, {
      listSkills: async () => {
        throw new Error('remote catalog unavailable');
      },
    })).rejects.toThrow('remote catalog unavailable');

    const snapshots = h.sqlite!
      .prepare('SELECT id FROM bot_runtime_snapshots WHERE session_id = ?')
      .all(created.session.id);
    expect(snapshots).toEqual([]);
  });

  it('resolves every remote capability catalog against the target host', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const inputs: Array<{ kind: string; remoteHostId?: string }> = [];
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'codex',
      workingDir: '/srv/cindy-bot',
      remoteHostId: 'remote-host-1',
      workspaceKind: 'project',
      model: 'gpt-5.4',
      permissionMode: 'ask',
    };

    await hydrateBotProfileRuntime(opts, {
      listSkills: async (input) => {
        inputs.push({ kind: 'skills', remoteHostId: input.remoteHostId });
        return [];
      },
      listMcpServers: async (input) => {
        inputs.push({ kind: 'mcp', remoteHostId: input.remoteHostId });
        return [];
      },
      listToolsets: async (input) => {
        inputs.push({ kind: 'toolsets', remoteHostId: input.remoteHostId });
        return [];
      },
    });

    expect(inputs).toEqual([
      { kind: 'skills', remoteHostId: 'remote-host-1' },
      { kind: 'mcp', remoteHostId: 'remote-host-1' },
      { kind: 'toolsets', remoteHostId: 'remote-host-1' },
    ]);
  });

  it('keeps ambient catalogs only as explicit disabled rows under legacy inherit', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'ask',
    };

    await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [
        {
          name: 'research',
          path: '/skills/research/SKILL.md',
          enabled: true,
          runtimeCommandName: 'skill:research',
        },
      ],
      fingerprintSkillSource: async () => 'a'.repeat(64),
      listMcpServers: async () => [
        {
          name: 'docs',
          source: 'custom',
          available: true,
        },
      ],
      listToolsets: async () => [
        {
          id: 'browser',
          name: 'Browser',
          available: true,
        },
      ],
    });

    expect(opts.botRuntimeProfile).toMatchObject({
      skillPolicy: {
        mode: 'allowlist',
        configured: [],
        catalog: [expect.objectContaining({ name: 'research' })],
      },
      mcpPolicy: { mode: 'allowlist', configured: [] },
      toolsetPolicy: { mode: 'allowlist', configured: [] },
    });
  });

  it('refreshes canonical Skill resources in place when their fingerprint changes', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      capabilities: { skills: ['release'], skillMode: 'allowlist' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 2,
    });
    const makeOpts = (): MakerSessionCreateOpts => ({
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    });
    const listSkills = async () => [{
      name: 'release',
      path: '/skills/release/SKILL.md',
      enabled: true,
      runtimeCommandName: 'skill:release',
    }];

    const first = await hydrateBotProfileRuntime(makeOpts(), {
      listSkills,
      readSkillSource: async () => '# Release\nVersion one',
    });
    await markBotProfileRuntimeApplied(first!);

    const resumed = await hydrateBotProfileRuntime(makeOpts(), {
      listSkills,
      readSkillSource: async () => '# Release\nVersion one',
    });
    expect(resumed?.runtimeEpochChanged).toBe(false);
    expect(resumed?.resolvedSkillEntries).toEqual([
      expect.objectContaining({
        runtimeCommandName: 'skill:release',
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    const refreshed = await hydrateBotProfileRuntime(makeOpts(), {
      listSkills,
      readSkillSource: async () => '# Release\nVersion two',
    });
    expect(refreshed?.sessionId).toBe(created.session.id);
    expect(refreshed?.resolvedSkillEntries).toEqual([
      expect.objectContaining({
        runtimeCommandName: 'skill:release',
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(refreshed?.resolvedSkillEntries[0]?.contentSha256).not.toBe(
      resumed?.resolvedSkillEntries[0]?.contentSha256,
    );
    expect(refreshed?.runtimeEpochChanged).toBe(true);
  });

  /*
    「TA 学会的」闭环的挂载端:伙伴自己沉淀的技能必须在下一次会话真的被挂进去。

    它们走独立的 ownSkills 通道,不进 catalog / configured —— allowlist 管的是
    「用户允许这个伙伴保留哪些 harness 发现到的 Skill」,而这些是伙伴自己写的
    文件,恒挂载,不该被用户的勾选误关掉。
  */
  it('mounts the Bot\'s own learned Skills into the next task', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      capabilities: { skills: [], skillMode: 'inherit' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 2,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    };

    await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [],
      listOwnSkills: async ({ botId }) => ({
        pluginRoot: `/userdata/bot-skills/${botId}`,
        skills: [{
          name: 'weekly-report',
          description: 'How I put the weekly report together',
          path: `/userdata/bot-skills/${botId}/skills/weekly-report`,
          filePath: `/userdata/bot-skills/${botId}/skills/weekly-report/SKILL.md`,
        }],
      }),
    }, { persistSnapshot: false });

    expect(opts.botRuntimeProfile?.skillPolicy.ownSkills).toEqual([
      {
        name: 'weekly-report',
        description: 'How I put the weekly report together',
        path: '/userdata/bot-skills/bot-1/skills/weekly-report',
        filePath: '/userdata/bot-skills/bot-1/skills/weekly-report/SKILL.md',
      },
    ]);
    // Claude Code 只会开关它自己发现到的 Skill,所以还要给它一个本地 plugin 根。
    expect(opts.botRuntimeProfile?.skillPolicy.ownSkillPluginRoots).toEqual([
      '/userdata/bot-skills/bot-1',
    ]);
    // 用户配的 Skill 那一栏不受影响。
    expect(opts.botRuntimeProfile?.skillPolicy.catalog).toEqual([]);
  });

  it('does not mount local learned Skills into a remote Bot task', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
      remoteHostId: 'box',
    };

    await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [],
      listOwnSkills: async () => ({
        pluginRoot: '/userdata/bot-skills/bot-1',
        skills: [{ name: 'weekly-report', description: '', path: '/userdata/bot-skills/bot-1/skills/weekly-report' }],
      }),
    }, { persistSnapshot: false });

    // 路径是本机的,远端 harness 打不开 —— 挂一串死路径比不挂更糟。
    expect(opts.botRuntimeProfile?.skillPolicy.ownSkills).toBeUndefined();
    expect(opts.botRuntimeProfile?.skillPolicy.ownSkillPluginRoots).toBeUndefined();
  });

  it('does not promise or mount a local Bot Home into a remote task', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: '/remote/workspace',
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
      remoteHostId: 'box',
    };
    const readProfileFolder = vi.fn(async () => ({
      homeDir: '/local/userData/bots/bot-1',
      systemPromptOverride: 'local-only overlay',
    }));

    await hydrateBotProfileRuntime(opts, { readProfileFolder }, { persistSnapshot: false });

    expect(readProfileFolder).not.toHaveBeenCalled();
    expect(opts.writableDirs).toBeUndefined();
    expect(opts.extraDirs).toBeUndefined();
    expect(opts.botProfileContextPrompt).not.toContain('/local/userData/bots/bot-1');
    expect(opts.botProfileContextPrompt).not.toContain('local-only overlay');
  });

  /*
    伙伴在任务里刚学会一个技能,紧接着还得能续跑同一个任务。所以自有技能
    不进 skillResources —— 那是冻结漂移检查的口径,进去就等于「一学会就
    再也 resume 不了」。
  */
  it('lets a Bot resume its own task right after it learned something new', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const makeOpts = (): MakerSessionCreateOpts => ({
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    });

    const first = await hydrateBotProfileRuntime(makeOpts(), {
      listSkills: async () => [],
      listOwnSkills: async () => ({ pluginRoot: '/userdata/bot-skills/bot-1', skills: [] }),
    });
    await markBotProfileRuntimeApplied(first!);

    const resumed = makeOpts();
    await expect(hydrateBotProfileRuntime(resumed, {
      listSkills: async () => [],
      listOwnSkills: async () => ({
        pluginRoot: '/userdata/bot-skills/bot-1',
        skills: [{ name: 'weekly-report', description: '', path: '/userdata/bot-skills/bot-1/skills/weekly-report' }],
      }),
    })).resolves.toBeTruthy();
    expect(resumed.botRuntimeProfile?.skillPolicy.ownSkills).toHaveLength(1);
  });

  it('keeps a Bot startable when its own skill shelf cannot be read', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    };

    const snapshot = await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [],
      listOwnSkills: async () => {
        throw new Error('disk unavailable');
      },
    }, { persistSnapshot: false });

    // 读不出自己的技能架子不是「用户配的 Skill 有一条不可用」,不该稀释降级信号。
    expect(snapshot?.resolutionStatus).toBe('applied');
    expect(snapshot?.unavailableSkills).toEqual([]);
    expect(opts.botRuntimeProfile?.skillPolicy.ownSkills).toBeUndefined();
  });

  it('removes a Skill from the native runtime catalog when its source cannot be fingerprinted', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      capabilities: { skills: ['release'], skillMode: 'allowlist' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 2,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    };

    const snapshot = await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [{
        name: 'release',
        path: '/skills/release/SKILL.md',
        enabled: true,
        runtimeCommandName: 'skill:release',
      }],
      fingerprintSkillSource: async () => {
        throw new Error('unreadable');
      },
    });

    expect(snapshot).toMatchObject({
      resolvedSkills: [],
      unavailableSkills: ['skill:release'],
      resolutionStatus: 'degraded',
    });
    expect(opts.botRuntimeProfile?.skillPolicy).toMatchObject({
      mode: 'allowlist',
      catalog: [expect.objectContaining({
        name: 'release',
        enabled: false,
        runtimeStatus: 'failed',
      })],
    });
  });

  it('refreshes canonical MCP generations and Toolset versions in place', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      capabilities: {
        mcpServers: ['docs'],
        mcpMode: 'allowlist',
        toolsets: ['contacts'],
        toolsetMode: 'allowlist',
      },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 2,
    });
    const makeOpts = (): MakerSessionCreateOpts => ({
      id: created.session.id,
      agentKind: 'codex',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'gpt-5.4',
      permissionMode: 'ask',
    });
    const hydrate = (mcpGeneration: string, toolsetVersion: string) =>
      hydrateBotProfileRuntime(makeOpts(), {
        listMcpServers: async () => [{
          name: 'docs',
          source: 'custom',
          available: true,
          generation: mcpGeneration,
        }],
        listToolsets: async () => [{
          id: 'contacts',
          name: 'Contacts',
          available: true,
          version: toolsetVersion,
        }],
      });

    const first = await hydrate('http:1000', '1.0.0');
    await markBotProfileRuntimeApplied(first!);
    await expect(hydrate('http:1000', '1.0.0')).resolves.toMatchObject({
      resolvedMcpServers: ['docs'],
      resolvedToolsets: ['contacts'],
      runtimeEpochChanged: false,
    });
    await expect(hydrate('http:1001', '1.0.0')).resolves.toMatchObject({
      sessionId: created.session.id,
      resolvedMcpServers: ['docs'],
      runtimeEpochChanged: true,
    });
    await expect(hydrate('http:1000', '2.0.0')).resolves.toMatchObject({
      sessionId: created.session.id,
      resolvedToolsets: ['contacts'],
      runtimeEpochChanged: true,
    });
  });

  it('preflights a frozen resource bundle without creating a runtime snapshot', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'codex',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'gpt-5.4',
      permissionMode: 'ask',
    };

    await hydrateBotProfileRuntime(opts, {}, { persistSnapshot: false });

    const snapshots = h.sqlite!
      .prepare('SELECT id FROM bot_runtime_snapshots WHERE session_id = ?')
      .all(created.session.id);
    expect(snapshots).toEqual([]);
  });

  it('marks startup failure without persisting the raw error message', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const snapshot = await hydrateBotProfileRuntime({
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    });
    const startupError = Object.assign(new Error('private prompt contents'), {
      code: 'SPAWN_FAILED',
    });

    await expect(
      markBotProfileRuntimeFailed(snapshot!, {
        stage: 'agent-start',
        error: startupError,
      }),
    ).resolves.toBe(true);
    const row = h
      .sqlite!.prepare(
        'SELECT status, applied_at AS appliedAt, failed_at AS failedAt, failure_json AS failureJson FROM bot_runtime_snapshots WHERE id = ?',
      )
      .get(snapshot!.snapshotId) as {
      status: string;
      appliedAt: number | null;
      failedAt: number | null;
      failureJson: string;
    };
    expect(row).toMatchObject({ status: 'failed', appliedAt: null });
    expect(row.failedAt).toEqual(expect.any(Number));
    expect(JSON.parse(row.failureJson)).toEqual({
      stage: 'agent-start',
      errorName: 'Error',
      errorCode: 'SPAWN_FAILED',
    });
    expect(row.failureJson).not.toContain('private prompt contents');
  });

  it('projects a user-actionable runtime failure onto the Bot Profile', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const snapshot = await hydrateBotProfileRuntime({
      id: created.session.id,
      agentKind: 'pi',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    });

    await expect(markBotProfileRuntimeFailed(snapshot!, {
      stage: 'agent-start',
      error: new Error('Error code: 403 - invalid API key'),
    })).resolves.toBe(true);
    expect(
      h.sqlite!.prepare('SELECT attention_reason AS reason, attention_at AS at FROM bot_profiles WHERE id = ?')
        .get('bot-1'),
    ).toEqual({ reason: 'provider_auth_or_access', at: expect.any(Number) });
  });

  it('advances only the canonical link and adopts the new ProfileVersion without replacing the Chat', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const initialSnapshot = await hydrateBotProfileRuntime({
      id: 'session-1',
      agentKind: 'pi',
      workingDir: '/tmp/cindy-bot-test/session-1',
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
    });
    await markBotProfileRuntimeApplied(initialSnapshot!);
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      identitySource: 'You are the version two identity.',
      capabilities: { memory: false },
    });
    const resumedOpts: MakerSessionCreateOpts = {
      id: 'session-1',
      agentKind: 'pi' as const,
      workingDir: '/tmp/cindy-bot-test/session-1',
      workspaceKind: 'dialogue' as const,
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions' as const,
      resumeSessionId: '/tmp/pi-session.jsonl',
    };

    expect(
      h.sqlite!
        .prepare("SELECT profile_version FROM bot_session_links WHERE bot_id = 'bot-1' AND role = 'canonical'")
        .pluck()
        .get(),
    ).toBe(2);
    const resumedSnapshot = await hydrateBotProfileRuntime(resumedOpts);
    expect(resumedSnapshot?.sessionId).toBe('session-1');
    expect(resumedSnapshot?.profileVersion).toBe(2);
    expect(resumedSnapshot?.runtimeEpochChanged).toBe(true);
    expect(resumedOpts.botProfilePrompt).toBe('You are the version two identity.');
    expect(resumedOpts.makerMemoryEnabled).toBe(false);
    expect(h.requestRuntimeRefresh).toHaveBeenCalledWith('session-1', 'profile');
  });

  it('persists a default SOUL in the first ProfileVersion', () => {
    const identity = h
      .sqlite!.prepare(
        'SELECT identity_source FROM bot_profile_versions WHERE bot_id = ? AND version = 1',
      )
      .pluck()
      .get('bot-1');

    expect(identity).toContain('You are Release Bot');
    expect(identity).toContain('intelligent AI assistant running as a Cindy Bot');
  });

  it('restores the persisted default SOUL when an identity is explicitly cleared', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      name: 'Renamed Bot',
      identitySource: '   ',
    });

    const row = h
      .sqlite!.prepare(
        'SELECT version, identity_source AS identitySource FROM bot_profile_versions WHERE bot_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get('bot-1') as { version: number; identitySource: string };
    expect(row.version).toBe(2);
    expect(row.identitySource).toContain('You are Renamed Bot');
  });

  it('returns the winner without removing the permanent workspace when a stale create loses the CAS', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const stale = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    expect(stale).toMatchObject({ created: false, canonicalSessionId: 'session-1' });
    expect(
      h.sqlite!.prepare("SELECT id FROM sessions WHERE source = 'bot' ORDER BY id").pluck().all(),
    ).toEqual(['session-1']);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('does not create a replacement after the Bot is paused during the canonical CAS', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const baseTx = h.tx!;
    h.tx = async (name, args) => {
      if (name === 'bots.replaceCanonicalSession') {
        h.sqlite!.prepare("UPDATE bot_profiles SET status = 'paused' WHERE id = 'bot-1'").run();
      }
      return baseTx(name, args);
    };
    try {
      await expect(
        createBotCanonicalSession({
          botId: 'bot-1',
          expectedCanonicalSessionId: created.canonicalSessionId,
          expectedProfileVersion: 1,
        }),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    } finally {
      h.tx = baseTx;
    }

    expect(h.sqlite!.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
    expect(
      h
        .sqlite!.prepare('SELECT status FROM sessions WHERE id = ?')
        .pluck()
        .get(created.canonicalSessionId),
    ).toBe('active');
  });

  it('recovers a soft-deleted canonical without resurrecting the deleted Session', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = 'session-1'").run();

    const recovered = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: 'session-1',
      expectedProfileVersion: 1,
    });

    expect(recovered).toMatchObject({ created: true, canonicalSessionId: 'session-2' });
    expect(
      h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-1'),
    ).toBe('deleted');
  });

});

describe('Bots list conversation projection', () => {
  /** messages.content is a serialized structure, exactly like production rows. */
  function insertMessage(
    sessionId: string,
    row: {
      id: string;
      role: 'user' | 'assistant' | 'tool_use';
      content: unknown;
      createdAt: number;
      rewindAt?: number;
      agentMeta?: unknown;
    },
  ): void {
    h.sqlite!
      .prepare(
        `INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        row.id,
        row.id,
        sessionId,
        row.role,
        JSON.stringify(row.content),
        row.agentMeta === undefined ? null : JSON.stringify(row.agentMeta),
        row.createdAt,
        row.rewindAt ?? null,
      );
  }

  async function canonicalFor(botId: string): Promise<string> {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId,
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    return created.canonicalSessionId as string;
  }

  it('projects the latest visible canonical message as preview + timestamp', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'user',
      content: { text: 'Check the release branch' },
      createdAt: 1_000,
    });
    insertMessage(sessionId, {
      id: 'm2',
      role: 'assistant',
      content: 'Two checks are still red.',
      createdAt: 2_000,
    });

    const [projection] = await invoke('local-db:bots:list', undefined);
    expect(projection).toMatchObject({
      id: 'bot-1',
      lastMessagePreview: 'Two checks are still red.',
      lastMessageAt: 2_000,
    });
    const single = await invoke('local-db:bots:get', 'bot-1');
    expect(single.lastMessagePreview).toBe('Two checks are still red.');
  });

  it('reports no conversation for a Bot whose canonical task is still empty', async () => {
    await canonicalFor('bot-1');
    const single = await invoke('local-db:bots:get', 'bot-1');
    expect(single.lastMessagePreview).toBeNull();
    expect(single.lastMessageAt).toBeNull();
  });

  it('skips rewind-truncated, tool, hidden auto-resume and unextractable rows', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'user',
      content: { text: 'The only real message' },
      createdAt: 1_000,
    });
    insertMessage(sessionId, {
      id: 'm2',
      role: 'assistant',
      content: 'Rolled back by rewind',
      createdAt: 2_000,
      rewindAt: 2_500,
    });
    insertMessage(sessionId, {
      id: 'm3',
      role: 'tool_use',
      content: { name: 'Bash', input: {} },
      createdAt: 3_000,
    });
    insertMessage(sessionId, {
      id: 'm4',
      role: 'user',
      content: { text: 'continue' },
      createdAt: 4_000,
      agentMeta: { autoResume: true },
    });
    // Attachment-only send: no text to extract, must not shadow the real row.
    insertMessage(sessionId, {
      id: 'm5',
      role: 'user',
      content: { attachments: ['a.png'] },
      createdAt: 5_000,
    });

    const single = await invoke('local-db:bots:get', 'bot-1');
    expect(single.lastMessagePreview).toBe('The only real message');
    expect(single.lastMessageAt).toBe(1_000);
  });

  it('never leaks one Bot conversation into another Bot row', async () => {
    await invoke('local-db:bots:create', { id: 'bot-2', name: 'Research Bot' });
    const first = await canonicalFor('bot-1');
    const second = await canonicalFor('bot-2');
    insertMessage(first, {
      id: 'm1',
      role: 'assistant',
      content: 'Belongs to bot-1',
      createdAt: 1_000,
    });
    insertMessage(second, {
      id: 'm2',
      role: 'assistant',
      content: 'Belongs to bot-2',
      createdAt: 2_000,
    });

    const rows = (await invoke('local-db:bots:list', undefined)) as Array<{
      id: string;
      lastMessagePreview: string | null;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get('bot-1')?.lastMessagePreview).toBe('Belongs to bot-1');
    expect(byId.get('bot-2')?.lastMessagePreview).toBe('Belongs to bot-2');
  });

  it('honours the /clear boundary of the canonical task', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'assistant',
      content: 'Before clear',
      createdAt: 1_000,
    });
    h.sqlite!.prepare('UPDATE sessions SET cleared_at = 1500 WHERE id = ?').run(sessionId);

    let single = await invoke('local-db:bots:get', 'bot-1');
    expect(single.lastMessagePreview).toBeNull();

    insertMessage(sessionId, {
      id: 'm2',
      role: 'assistant',
      content: 'After clear',
      createdAt: 2_000,
    });
    single = await invoke('local-db:bots:get', 'bot-1');
    expect(single.lastMessagePreview).toBe('After clear');
  });

  it('keeps the Bot conversation preview out of the device-link projection', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'assistant',
      content: 'Local only',
      createdAt: 1_000,
    });
    const remote = await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'mobile-1', channel: 'local-db:bots:get' },
      () => h.handlers.get('local-db:bots:get')!({}, 'bot-1'),
    );
    expect(remote).not.toHaveProperty('lastMessagePreview');
  });

  it('reports who sent the latest visible message', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'assistant',
      content: 'Reply first',
      createdAt: 1_000,
    });
    expect((await invoke('local-db:bots:get', 'bot-1')).lastMessageRole).toBe('assistant');

    insertMessage(sessionId, {
      id: 'm2',
      role: 'user',
      content: { text: 'Then the user' },
      createdAt: 2_000,
    });
    expect((await invoke('local-db:bots:get', 'bot-1')).lastMessageRole).toBe('user');

    await invoke('local-db:bots:create', { id: 'bot-empty', name: 'Empty Bot' });
    expect((await invoke('local-db:bots:get', 'bot-empty')).lastMessageRole).toBeNull();
  });
});

describe('Bots list unread projection', () => {
  function insertMessage(
    sessionId: string,
    row: {
      id: string;
      role: 'user' | 'assistant' | 'tool_use';
      content: unknown;
      createdAt: number;
      rewindAt?: number;
      agentMeta?: unknown;
    },
  ): void {
    h.sqlite!
      .prepare(
        `INSERT INTO messages (id, client_id, session_id, role, content, tool_use_id, agent_meta, agent_kind, created_at, rewind_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)`,
      )
      .run(
        row.id,
        row.id,
        sessionId,
        row.role,
        JSON.stringify(row.content),
        row.agentMeta === undefined ? null : JSON.stringify(row.agentMeta),
        row.createdAt,
        row.rewindAt ?? null,
      );
  }

  async function canonicalFor(botId: string): Promise<string> {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId,
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    return created.canonicalSessionId as string;
  }

  async function unreadFor(
    botId: string,
    lastReadAtByBotId?: Record<string, number>,
  ): Promise<number> {
    const rows = (await invoke(
      'local-db:bots:list',
      lastReadAtByBotId ? { lastReadAtByBotId } : undefined,
    )) as Array<{ id: string; unreadCount: number }>;
    return rows.find((row) => row.id === botId)!.unreadCount;
  }

  it('counts only replies that landed after the read position', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'assistant',
      content: 'Already seen',
      createdAt: 1_000,
    });
    insertMessage(sessionId, {
      id: 'm2',
      role: 'assistant',
      content: 'New one',
      createdAt: 3_000,
    });
    insertMessage(sessionId, {
      id: 'm3',
      role: 'assistant',
      content: 'New two',
      createdAt: 4_000,
    });

    expect(await unreadFor('bot-1', { 'bot-1': 2_000 })).toBe(2);
    // A read position exactly on a row means that row has been seen.
    expect(await unreadFor('bot-1', { 'bot-1': 4_000 })).toBe(0);
  });

  it('reports zero when the caller has no read position for that Bot', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'assistant',
      content: 'Backlog that must not light up the list',
      createdAt: 1_000,
    });

    expect(await unreadFor('bot-1')).toBe(0);
    expect(await unreadFor('bot-1', {})).toBe(0);
    expect(await unreadFor('bot-1', { 'bot-1': Number.NaN as unknown as number })).toBe(0);
    expect(await unreadFor('bot-1', { 'bot-1': -1 })).toBe(0);
  });

  it('never counts user sends, internal Bot messages, rewound rows, or auto-resume prompts', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'user',
      content: { text: 'My own message' },
      createdAt: 2_000,
    });
    insertMessage(sessionId, {
      id: 'm2',
      role: 'assistant',
      content: 'Rolled back by rewind',
      createdAt: 3_000,
      rewindAt: 3_500,
    });
    insertMessage(sessionId, {
      id: 'm3',
      role: 'assistant',
      content: 'Auto resume noise',
      createdAt: 4_000,
      agentMeta: { autoResume: true },
    });
    insertMessage(sessionId, {
      id: 'm4',
      role: 'assistant',
      content: '',
      agentMeta: {
        botDirectMessage: {
          v: 1,
          threadId: 'thread-1',
          direction: 'received',
        },
      },
      createdAt: 4_500,
    });
    insertMessage(sessionId, {
      id: 'm5',
      role: 'tool_use',
      content: { name: 'Bash', input: {} },
      createdAt: 5_000,
    });

    insertMessage(sessionId, {
      id: 'private-reply', role: 'assistant', content: 'Acknowledged my teammate',
      agentMeta: { botPrivateReply: true }, createdAt: 5_500,
    });

    expect(await unreadFor('bot-1', { 'bot-1': 1_000 })).toBe(0);

    insertMessage(sessionId, {
      id: 'm6',
      role: 'assistant',
      content: 'The one real reply',
      createdAt: 6_000,
    });
    expect(await unreadFor('bot-1', { 'bot-1': 1_000 })).toBe(1);
  });

  it('honours the /clear boundary even when the read position is older', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'm1',
      role: 'assistant',
      content: 'Before clear',
      createdAt: 2_000,
    });
    h.sqlite!.prepare('UPDATE sessions SET cleared_at = 2500 WHERE id = ?').run(sessionId);

    expect(await unreadFor('bot-1', { 'bot-1': 1_000 })).toBe(0);

    insertMessage(sessionId, {
      id: 'm2',
      role: 'assistant',
      content: 'After clear',
      createdAt: 3_000,
    });
    expect(await unreadFor('bot-1', { 'bot-1': 1_000 })).toBe(1);
  });

  it('never leaks one Bot unread count into another Bot row', async () => {
    await invoke('local-db:bots:create', { id: 'bot-2', name: 'Research Bot' });
    const first = await canonicalFor('bot-1');
    const second = await canonicalFor('bot-2');
    insertMessage(first, { id: 'm1', role: 'assistant', content: 'One', createdAt: 2_000 });
    insertMessage(second, { id: 'm2', role: 'assistant', content: 'Two', createdAt: 2_000 });
    insertMessage(second, { id: 'm3', role: 'assistant', content: 'Three', createdAt: 3_000 });

    const readState = { 'bot-1': 1_000, 'bot-2': 1_000 };
    expect(await unreadFor('bot-1', readState)).toBe(1);
    expect(await unreadFor('bot-2', readState)).toBe(2);
    // A read position for one Bot must not silence the other.
    expect(await unreadFor('bot-2', { 'bot-1': 9_000 })).toBe(0);
  });

  it('stops counting at the badge cap instead of scanning the whole task', async () => {
    const sessionId = await canonicalFor('bot-1');
    for (let index = 0; index < 150; index += 1) {
      insertMessage(sessionId, {
        id: `m${index}`,
        role: 'assistant',
        content: `Reply ${index}`,
        createdAt: 2_000 + index,
      });
    }

    expect(await unreadFor('bot-1', { 'bot-1': 1_000 })).toBe(100);
  });

  it('keeps unread accounting out of the device-link projection', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'm1', role: 'assistant', content: 'Local', createdAt: 2_000 });

    const remote = (await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'mobile-1', channel: 'local-db:bots:list' },
      () => h.handlers.get('local-db:bots:list')!({}, { lastReadAtByBotId: { 'bot-1': 1_000 } }),
    )) as Array<Record<string, unknown>>;

    expect(remote[0]).not.toHaveProperty('unreadCount');
    expect(remote[0]).not.toHaveProperty('lastMessageRole');
  });
});

describe('Bot avatar sentinel persistence', () => {
  // A Bot avatar is either one grapheme or a reserved `cindy://avatar/…`
  // sentinel resolving to bundled artwork (renderer/features/bots/
  // botAvatarIdentity.ts). The create/update guards used to cap avatar text at
  // 16 chars, which rejected every sentinel — including the shipped Cindy
  // assistant template and every auto-assigned character.
  it('accepts the official and preset sentinels on create and update', async () => {
    await invoke('local-db:bots:create', {
      id: 'bot-official',
      name: 'Cindy',
      avatar: 'cindy://avatar/official',
      avatarColor: 'graphite',
    });
    expect(await invoke('local-db:bots:get', 'bot-official')).toMatchObject({
      avatar: 'cindy://avatar/official',
    });

    await invoke('local-db:bots:create', {
      id: 'bot-preset',
      name: 'Sora',
      avatar: 'cindy://avatar/preset/whitecat',
      avatarColor: 'teal',
    });
    expect(await invoke('local-db:bots:get', 'bot-preset')).toMatchObject({
      avatar: 'cindy://avatar/preset/whitecat',
    });

    await invoke('local-db:bots:update', {
      id: 'bot-preset',
      avatar: 'cindy://avatar/preset/melody',
    });
    expect(await invoke('local-db:bots:get', 'bot-preset')).toMatchObject({
      avatar: 'cindy://avatar/preset/melody',
    });
  });

  it('still refuses an avatar long enough to smuggle a URL or a blob', async () => {
    await expect(
      invoke('local-db:bots:create', {
        id: 'bot-long-avatar',
        name: 'Overlong',
        avatar: `https://example.com/${'a'.repeat(200)}.png`,
      }),
    ).rejects.toThrow();
  });

  it('refuses short local paths, data URIs and multi-grapheme text', async () => {
    for (const avatar of ['/tmp/a.png', 'C:\\a.png', 'data:image/png;base64,AA==', 'AB']) {
      await expect(
        invoke('local-db:bots:create', {
          id: `bot-invalid-${avatar.length}`,
          name: 'Invalid avatar',
          avatar,
        }),
      ).rejects.toThrow('avatar 只能是一个表情');
    }
  });

  it('ignores a stale full-form autosave instead of rolling back a newer avatar', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      avatar: '🚀',
      expectedAvatar: '🤖',
    });
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      avatar: '🤖',
      expectedAvatar: 'cindy://avatar/official',
      description: 'This non-avatar field still saves',
    });

    expect(await invoke('local-db:bots:get', 'bot-1')).toMatchObject({
      avatar: '🚀',
      description: 'This non-avatar field still saves',
    });
  });
});

/**
 * 伙伴后台任务全链（真链路）。
 *
 * 与只验证服务内部数据的用例不同，这里保留真实 dispatch 判定链。
 * 桩 dispatch 等于假设「消息一送必到、子任务一定跑得起来」，于是测到的只是
 * `botDelegationService` 内部的状态机——真机上断掉的恰恰是被假设掉的那一段：
 * 子任务如果没继承发起伙伴的执行配置（来源/档位）就根本起不来，
 * 任务卡也会永远转圈。
 *
 * 这里把桩下移一层：dispatch 是真的（按主机通路的判据逐条走：clientId 去重 → 会话行
 * 存在与状态 → 账号/模型来源就绪门 → harness 鉴权 → 落库 → 起 turn），只有「模型
 * 进程」这一层是假的。后台任务服务、外发队列、localDb、事件接线全部是真的。
 */
describe('Bot Session task end-to-end runtime', () => {
  const PROVIDER = 'localstub';

  interface StartedTurn {
    sessionId: string;
    providerId: string | null;
    model: string;
    effort: string;
    fastMode: number;
    agentKind: string;
  }

  function createDelegationRuntime(options: {
    readCallerRuntime?: Parameters<typeof createBotDelegationService>[0]['readCallerRuntime'];
    accountReady?: () => boolean;
    transientUnavailable?: () => boolean;
    replyFor?: (sessionId: string) => string;
    startTime?: number;
    resolveInteraction?: NonNullable<
      Parameters<typeof createBotDelegationService>[0]['resolveInteraction']
    >;
  } = {}) {
    const accountReady = options.accountReady ?? (() => true);
    const started: StartedTurn[] = [];
    const pendingTurns: Array<{ sessionId: string; queued: boolean }> = [];
    const changed: Array<{ delegationId: string; status: string }> = [];
    let currentTime = options.startTime ?? 10_000;
    let seq = 0;

    const readSession = (sessionId: string) =>
      h
        .sqlite!.prepare(
          `SELECT status, model, provider_id AS providerId, effort,
                  fast_mode AS fastMode, agent_kind AS agentKind
           FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as
        | {
            status: string;
            model: string;
            providerId: string | null;
            effort: string;
            fastMode: number;
            agentKind: string;
          }
        | undefined;

    const hasMessage = (sessionId: string, clientId: string): boolean =>
      h.sqlite!.prepare('SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?')
        .get(sessionId, clientId) !== undefined;

    const writeMessage = (
      sessionId: string,
      clientId: string,
      role: 'user' | 'assistant',
      content: string,
    ): void => {
      h.sqlite!.prepare(
        `INSERT OR IGNORE INTO messages (id, client_id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(`msg-${++seq}`, clientId, sessionId, role, content, currentTime);
    };

    /**
     * 主机投递通路的等价实现（apps/desktop/src/main/maker-ipc/register.ts 的
     * dispatchBotSessionMessage → sendToSessionInternal）。判据顺序刻意与真机一致：
     * 任何一条在真机上会挡住会话启动的门，这里也必须挡住。
     */
    const dispatch = async (params: {
      targetSessionId: string;
      message: string;
      persistedContent?: string;
      clientId?: string;
      onAccepted?: () => void | Promise<void>;
    }) => {
      if (params.clientId && hasMessage(params.targetSessionId, params.clientId)) {
        await params.onAccepted?.();
        return {
          ok: true as const,
          targetSessionId: params.targetSessionId,
          wakeKind: 'already-active' as const,
        };
      }
      const row = readSession(params.targetSessionId);
      if (!row) {
        return {
          ok: false as const,
          errorCode: 'NOT_FOUND',
          message: `session ${params.targetSessionId} not found`,
        };
      }
      if (row.status !== 'active') {
        return {
          ok: false as const,
          errorCode: row.status === 'deleted' ? 'DELETED' : 'ARCHIVED',
          message: `session ${params.targetSessionId} is ${row.status}`,
        };
      }
      // maker-host 的 prepareStartOptions 门：没登录 / 正在切账号时会话根本不会启动。
      if (!accountReady()) {
        return {
          ok: false as const,
          errorCode: 'AGENT_NOT_READY',
          message: `${ACCOUNT_PROVIDER_NOT_READY_CODE}: account provider models are not ready`,
        };
      }
      if (options.transientUnavailable?.()) {
        return {
          ok: false as const,
          errorCode: 'TEMPORARILY_UNAVAILABLE',
          message: 'runtime is restarting',
        };
      }
      // harness 鉴权：来源（provider）解析不出来就起不来。真机上这条长这样：
      // "AGENT_NOT_READY: pi not authenticated: cindy_gateway_key_unavailable"。
      if (!row.providerId) {
        return {
          ok: false as const,
          errorCode: 'AGENT_NOT_READY',
          message: `${row.agentKind} not authenticated: cindy_gateway_key_unavailable`,
        };
      }
      const queuedBehindRunningTurn = pendingTurns.some(
        (turn) => turn.sessionId === params.targetSessionId,
      );
      started.push({
        sessionId: params.targetSessionId,
        providerId: row.providerId,
        model: row.model,
        effort: row.effort,
        fastMode: row.fastMode,
        agentKind: row.agentKind,
      });
      const clientId = params.clientId ?? `auto-${++seq}`;
      writeMessage(
        params.targetSessionId,
        clientId,
        'user',
        params.persistedContent ?? params.message,
      );
      await params.onAccepted?.();
      h.sqlite!.prepare('UPDATE sessions SET active_turn_started_at = ? WHERE id = ?')
        .run(currentTime, params.targetSessionId);
      pendingTurns.push({ sessionId: params.targetSessionId, queued: queuedBehindRunningTurn });
      return {
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: queuedBehindRunningTurn ? 'queued' as const : 'resumed' as const,
      };
    };

    const abortSession = vi.fn(async () => undefined);
    const delegation = createBotDelegationService({
      readCallerRuntime: options.readCallerRuntime,
      dispatch,
      abortSession,
      closeSession: vi.fn(async () => undefined),
      broadcastSessionCreated: vi.fn(),
      resolveInteraction: options.resolveInteraction,
      hasPendingInput: (sessionId) => pendingTurns.some(
        (turn) => turn.sessionId === sessionId && turn.queued,
      ),
      onChanged: (payload) => {
        changed.push({ delegationId: payload.delegationId, status: payload.status });
      },
      now: () => currentTime,
      createId: () => `delegation-${++seq}`,
    });

    /**
     * 真机上 turn 结束是异步事件；register.ts 在 `done` 上调 settleSession。
     * 这里同构：dispatch 只负责把 turn 排上，回合结算单独发生。
     */
    const runPendingTurns = async (): Promise<void> => {
      while (pendingTurns.length > 0) {
        const { sessionId } = pendingTurns.shift()!;
        const reply = options.replyFor?.(sessionId) ?? `${sessionId} 的结论。`;
        writeMessage(sessionId, `assistant-${++seq}`, 'assistant', reply);
        h.sqlite!.prepare(
          `UPDATE sessions SET total_token_usage = total_token_usage + 100,
             last_turn_ended_at = ? WHERE id = ?`,
        ).run(currentTime, sessionId);
        await delegation.settleSession({
          childSessionId: sessionId,
          outcome: 'done',
          resultText: reply,
        });
      }
    };

    const settleChild = async (sessionId: string, reply: string): Promise<void> => {
      const pendingIndex = pendingTurns.findIndex((turn) => turn.sessionId === sessionId);
      if (pendingIndex >= 0) pendingTurns.splice(pendingIndex, 1);
      writeMessage(sessionId, `assistant-${++seq}`, 'assistant', reply);
      h.sqlite!.prepare(
        `UPDATE sessions SET total_token_usage = total_token_usage + 100,
           last_turn_ended_at = ? WHERE id = ?`,
      ).run(currentTime, sessionId);
      await delegation.settleSession({
        childSessionId: sessionId,
        outcome: 'done',
        resultText: reply,
      });
    };

    return {
      delegation,
      abortSession,
      started,
      changed,
      runPendingTurns,
      settleChild,
      dispose: () => {
        delegation.dispose();
      },
      advance: (ms: number) => {
        currentTime += ms;
      },
    };
  }

  async function seedPair(capabilities: Record<string, unknown> = {}): Promise<void> {
    const base = {
      harness: 'pi',
      model: 'grok-4.5',
      permissions: 'trusted',
      providerId: PROVIDER,
      effort: 'high',
      fastMode: true,
      ...capabilities,
    };
    await invoke('local-db:bots:create', { id: 'bot-a', name: '发起方伙伴', capabilities: base });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-a',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
  }

  it.each(['cc', 'codex'])('starts a child on the actual %s route after its Bot changes engines', async (agentKind) => {
    await seedPair();
    const runtime = createDelegationRuntime({
      readCallerRuntime: () => ({
        agentKind, model: 'active-model', providerId: 'active-provider', effort: 'low', fastMode: false,
      }),
    });
    try {
      const result = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1', objective: 'Verify the selected runtime.',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(runtime.started).toContainEqual({
        sessionId: result.childSessionId, agentKind, model: 'active-model',
        providerId: 'active-provider', effort: 'low', fastMode: 0,
      });
    } finally {
      runtime.delegation.dispose();
    }
  });

  it('starts the child task and lands the result back in the requesting conversation', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({
      replyFor: () => '结论：三个版本都兼容。',
    });
    try {
      const delegated = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '查一下版本兼容矩阵。',
      });
      expect(delegated).toMatchObject({ ok: true, status: 'running' });
      expect(delegated).not.toHaveProperty('targetBotId');
      const childSessionId = delegated.ok ? delegated.childSessionId : '';

      // 后台任务真的被启动了，而且沿用发起伙伴当前任务的执行配置。
      expect(runtime.started).toContainEqual({
        sessionId: childSessionId,
        providerId: PROVIDER,
        model: 'grok-4.5',
        effort: 'high',
        fastMode: 1,
        agentKind: 'pi',
      });

      await runtime.runPendingTurns();
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, result_summary AS resultSummary FROM bot_delegations WHERE id = ?',
          )
          .get(delegated.ok ? delegated.delegationId : ''),
      ).toEqual({ status: 'completed', resultSummary: '结论：三个版本都兼容。' });

      // 回程：完成信号直接经主机通路落到发起方的对话里,是一条隐藏的内部指令行。
      const completionClientId = `bot-delegation-completion:${
        delegated.ok ? delegated.delegationId : ''
      }`;
      const completionRow = h
        .sqlite!.prepare('SELECT role, content FROM messages WHERE session_id = ? AND client_id = ?')
        .get('session-1', completionClientId) as { role: string; content: string };
      expect(completionRow.role).toBe('user');
      expect(completionRow.content).toContain('结论：三个版本都兼容。');
      expect(completionRow.content.startsWith(UI_ACTION_TRIGGER_PREFIX)).toBe(true);
      // 发起方那一侧也真的被唤醒了（否则「结果回到 A 的对话」只是写了一行数据库）。
      expect(runtime.started.some((turn) => turn.sessionId === 'session-1')).toBe(true);
      expect(runtime.changed.at(-1)).toEqual({
        delegationId: delegated.ok ? delegated.delegationId : '',
        status: 'completed',
      });
      expect(
        h.sqlite!.prepare('SELECT completion_delivered_at FROM bot_delegations WHERE id = ?')
          .pluck().get(delegated.ok ? delegated.delegationId : ''),
      ).toBe(10_000);
    } finally {
      runtime.dispose();
    }
  });

  it('delivers every continued run once without reusing the previous completion receipt', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '先交第一版。',
        title: '月报',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await runtime.settleChild(started.childSessionId, '第一版结果。');

      const continued = await runtime.delegation.messageSessionTask(
        'session-1',
        started.delegationId,
        { kind: 'message', text: '补上风险清单再交一次。' },
      );
      expect(continued).toMatchObject({ ok: true, resumed: true });
      if (!continued.ok || !continued.childSessionId) return;
      expect(continued.childSessionId).not.toBe(started.childSessionId);
      await runtime.settleChild(continued.childSessionId, '第二版结果，含风险清单。');

      const receipts = h.sqlite!.prepare(
        `SELECT client_id AS clientId, content FROM messages
         WHERE session_id = 'session-1' AND client_id LIKE ? ORDER BY rowid`,
      ).all(`bot-delegation-completion:${started.delegationId}%`) as Array<{
        clientId: string;
        content: string;
      }>;
      expect(receipts).toEqual([
        expect.objectContaining({
          clientId: `bot-delegation-completion:${started.delegationId}`,
          content: expect.stringContaining('第一版结果。'),
        }),
        expect.objectContaining({
          clientId: `bot-delegation-completion:${started.delegationId}:2`,
          content: expect.stringContaining('第二版结果，含风险清单。'),
        }),
      ]);
      await expect(
        runtime.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: { title: '月报', status: 'completed', result: '第二版结果，含风险清单。' },
      });
    } finally {
      runtime.dispose();
    }
  });

  it('waits for a queued follow-up turn before completing an active Session task', async () => {
    await seedPair();
    let childTurn = 0;
    const runtime = createDelegationRuntime({
      replyFor: (sessionId) => sessionId === 'session-1'
        ? '发起方已接手。'
        : (++childTurn === 1 ? '旧方向的阶段结果。' : '已按补充要求完成的最终结果。'),
    });
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '先整理一版方案。',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await expect(
        runtime.delegation.messageSessionTask('session-1', started.delegationId, {
          kind: 'message',
          text: '补充：最后必须带风险清单。',
          idempotencyKey: 'follow-up-1',
        }),
      ).resolves.toMatchObject({ ok: true, queued: true, resumed: false });

      await runtime.runPendingTurns();
      await expect(
        runtime.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: { status: 'completed', result: '已按补充要求完成的最终结果。' },
      });
      expect(
        h.sqlite!.prepare(
          `SELECT COUNT(*) FROM messages
           WHERE session_id = 'session-1' AND client_id = ?`,
        ).pluck().get(`bot-delegation-completion:${started.delegationId}`),
      ).toBe(1);
    } finally {
      runtime.dispose();
    }
  });

  it('recovers the child answer from the transcript when done.result is empty', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const delegated = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '查一下版本兼容矩阵。',
      });
      const childSessionId = delegated.ok ? delegated.childSessionId : '';
      h.sqlite!.prepare(
        `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
         VALUES (?, ?, ?, 'assistant', ?, ?)`,
      ).run(
        'ans-1',
        'assistant-final',
        childSessionId,
        '三个版本都兼容。交付物：cindy-media://blobs/recovered-result.png',
        20_000,
      );
      await runtime.delegation.settleSession({
        childSessionId,
        outcome: 'done',
        resultText: '',
      });
      expect(
        h.sqlite!.prepare('SELECT result_summary FROM bot_delegations WHERE id = ?').pluck()
          .get(delegated.ok ? delegated.delegationId : ''),
      ).toBe('三个版本都兼容。交付物：cindy-media://blobs/recovered-result.png');
      expect(
        h.sqlite!.prepare('SELECT content FROM messages WHERE session_id = ? AND client_id = ?')
          .pluck()
          .get('session-1', `bot-delegation-completion:${delegated.ok ? delegated.delegationId : ''}`),
      ).toContain('三个版本都兼容。');
      expect(runtime.started.some((turn) => turn.sessionId === 'session-1')).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  it('fails a Session task visibly when no account provider is available instead of hanging', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ accountReady: () => false });
    try {
      const delegated = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '未登录时也必须给个交代。',
      });
      expect(delegated).toMatchObject({ ok: true, status: 'failed' });
      const delegationId = delegated.ok ? delegated.delegationId : '';

      const row = h
        .sqlite!.prepare('SELECT status, last_error AS lastError FROM bot_delegations WHERE id = ?')
        .get(delegationId) as { status: string; lastError: string };
      expect(row.status).toBe('failed');
      expect(row.lastError).toContain('ACCOUNT_NOT_READY');
      expect(row.lastError).toContain('需要登录后才能执行');

      // 任务卡靠这条推送翻终态；没有它，卡片就永远停在「进行中」。用户看到的
      // 失败交代由卡片承载——账号没就绪时连完成指令都送不进会话,卡片就是兜底。
      expect(runtime.changed.at(-1)).toEqual({ delegationId, status: 'failed' });
    } finally {
      runtime.dispose();
    }
  });

  it('gives up a Session task whose child task can never authenticate', async () => {
    // 目标伙伴没有配置来源 → 子任务继承到的也是空来源 → harness 永远起不来。
    // 这正是真机取证里那条 "AGENT_NOT_READY: pi not authenticated" 的形状。
    await seedPair({ providerId: null });
    vi.useFakeTimers();
    const runtime = createDelegationRuntime();
    try {
      const delegated = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '起不来的活也要有终点。',
      });
      expect(delegated).toMatchObject({ ok: true, status: 'queued' });
      const delegationId = delegated.ok ? delegated.delegationId : '';
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck().get(delegationId),
      ).toBe('queued');
      expect(
        h.sqlite!.prepare('SELECT provider_id FROM sessions WHERE id = ?').pluck().get(delegated.ok ? delegated.childSessionId : ''),
      ).toBeNull();
      await expect(
        runtime.delegation.messageSessionTask('session-1', delegationId, {
          kind: 'message',
          text: '启动前追加的内容不能抢在原任务前面。',
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'SESSION_TASK_NOT_READY' });

      // 退避重试是有上限的：1+2+4+8+16 秒之后必须收口，而不是一直转到任务超时
      // （默认 30 分钟）——那半小时里用户看到的只有一个一直转圈的任务卡。
      await vi.advanceTimersByTimeAsync(120_000);
      const finalRow = h
        .sqlite!.prepare('SELECT status, last_error AS lastError FROM bot_delegations WHERE id = ?')
        .get(delegationId) as { status: string; lastError: string };
      expect(finalRow.status).toBe('failed');
      expect(finalRow.lastError).toContain('DISPATCH_UNAVAILABLE');
      expect(finalRow.lastError).toContain(`连续 ${BOT_DELEGATION_MAX_DISPATCH_ATTEMPTS} 次`);
      expect(runtime.changed.at(-1)).toEqual({ delegationId, status: 'failed' });
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('waits for approval and resumes the same Session task after approval', async () => {
    await seedPair();
    const resolveInteraction = vi.fn(() => true);
    const runtime = createDelegationRuntime({ resolveInteraction });
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '写入一个需要授权的文件。',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const request = {
        kind: 'permission' as const,
        requestId: 'permission-1',
        toolName: 'write_file',
        input: { path: '/tmp/report.md' },
        title: '写入报告',
      };
      await runtime.delegation.handleInteractionStart(started.childSessionId, request);
      await expect(
        runtime.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: {
          task_id: started.delegationId,
          status: 'waiting',
          pendingInteraction: {
            requestId: 'permission-1',
            kind: 'permission',
          },
        },
      });

      await expect(
        runtime.delegation.messageSessionTask('session-1', started.delegationId, {
          kind: 'approve',
        }),
      ).resolves.toMatchObject({ ok: true, resumed: false });
      expect(resolveInteraction).toHaveBeenCalledWith('permission-1', {
        kind: 'permission',
        behavior: 'allow',
      });

      await runtime.delegation.handleInteractionEnd(started.childSessionId, request);
      await expect(
        runtime.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: { status: 'running', pendingInteraction: null },
      });
    } finally {
      runtime.dispose();
    }
  });

  it('does not charge user-decision time against the Session task deadline', async () => {
    await seedPair();
    vi.useFakeTimers();
    const runtime = createDelegationRuntime({ resolveInteraction: () => true });
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '等待用户确认时暂停计时。',
        timeoutMs: 1_000,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      const request = {
        kind: 'permission' as const,
        requestId: 'permission-pause-clock',
        toolName: 'write_file',
        input: { path: '/tmp/report.md' },
      };
      await runtime.delegation.handleInteractionStart(started.childSessionId, request);
      runtime.advance(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck()
          .get(started.delegationId),
      ).toBe('waiting');

      await runtime.delegation.handleInteractionEnd(started.childSessionId, request);
      runtime.advance(999);
      await vi.advanceTimersByTimeAsync(999);
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck()
          .get(started.delegationId),
      ).toBe('running');
      runtime.advance(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck()
          .get(started.delegationId),
      ).toBe('failed');
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps the waiting summary durable until a restarted child turn is accepted', async () => {
    await seedPair();
    vi.useFakeTimers();
    const beforeRestart = createDelegationRuntime({ startTime: 10_000 });
    const started = await beforeRestart.delegation.startSessionTask({
      callerSessionId: 'session-1',
      objective: '重启时保留等待事项。',
      timeoutMs: 30_000,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      beforeRestart.dispose();
      vi.useRealTimers();
      return;
    }
    const request = {
      kind: 'permission' as const,
      requestId: 'permission-before-restart',
      toolName: 'write_file',
      input: { path: '/tmp/report.md' },
      title: '写入报告',
    };
    await beforeRestart.delegation.handleInteractionStart(started.childSessionId, request);
    beforeRestart.dispose();

    let unavailable = true;
    const afterRestart = createDelegationRuntime({
      startTime: 20_000,
      transientUnavailable: () => unavailable,
    });
    try {
      await afterRestart.delegation.restore();
      await expect(
        afterRestart.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: {
          status: 'waiting',
          pendingInteraction: {
            requestId: 'permission-before-restart',
            kind: 'permission',
            summary: '写入报告',
          },
        },
      });
      await expect(
        afterRestart.delegation.messageSessionTask('session-1', started.delegationId, {
          kind: 'approve',
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'INTERACTION_REHYDRATING' });

      unavailable = false;
      afterRestart.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(
        afterRestart.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: { status: 'running', pendingInteraction: null },
      });
      await expect(
        afterRestart.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: { deadline_at: 51_000 },
      });
      expect(
        h.sqlite!.prepare('SELECT pending_interaction_json FROM bot_delegations WHERE id = ?')
          .pluck().get(started.delegationId),
      ).toBeNull();
    } finally {
      afterRestart.dispose();
      vi.useRealTimers();
    }
  });

  it('stops an active Session task and aborts its child Session', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '停止前会持续执行的工作。',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await expect(
        runtime.delegation.stopSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        delegationId: started.delegationId,
        childSessionId: started.childSessionId,
      });
      expect(runtime.abortSession).toHaveBeenCalledWith(started.childSessionId);
      await expect(
        runtime.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({ ok: true, task: { status: 'cancelled' } });
    } finally {
      runtime.dispose();
    }
  });

  it('does not claim a Session task stopped when the child rejects cancellation', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    runtime.abortSession.mockRejectedValueOnce(new Error('runtime unavailable'));
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '只有真正停下才算停止成功。',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await expect(
        runtime.delegation.stopSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({ ok: false, errorCode: 'STOP_FAILED' });
      await expect(
        runtime.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({ ok: true, task: { status: 'running' } });
    } finally {
      runtime.dispose();
    }
  });

  it('does not wake a paused Bot to report lifecycle-owned task cancellation', async () => {
    await seedPair();
    const beforeRestart = createDelegationRuntime();
    const started = await beforeRestart.delegation.startSessionTask({
      callerSessionId: 'session-1',
      objective: '暂停伙伴时一起停止。',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      beforeRestart.dispose();
      return;
    }
    await beforeRestart.delegation.cancelDelegationsForBot('bot-a', 'Bot paused.');
    expect(
      h.sqlite!.prepare('SELECT completion_delivered_at FROM bot_delegations WHERE id = ?')
        .pluck().get(started.delegationId),
    ).not.toBeNull();
    h.sqlite!.prepare("UPDATE bot_profiles SET status = 'paused' WHERE id = 'bot-a'").run();
    beforeRestart.dispose();

    const afterRestart = createDelegationRuntime();
    try {
      await afterRestart.delegation.restore();
      expect(afterRestart.started.some((turn) => turn.sessionId === 'session-1')).toBe(false);
    } finally {
      afterRestart.dispose();
    }
  });

  it('reports an expired Session task as timed-out through the public task view', async () => {
    await seedPair();
    vi.useFakeTimers();
    const runtime = createDelegationRuntime();
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '超时后必须明确收口。',
        timeoutMs: 1_000,
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      runtime.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck()
          .get(started.delegationId),
      ).toBe('failed');
      await expect(
        runtime.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: {
          status: 'timed-out',
          error: '到了约定时间后台任务还没有交回结果',
        },
      });
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it('recovers a completed child result when the app restores active tasks', async () => {
    await seedPair();
    const beforeRestart = createDelegationRuntime();
    const started = await beforeRestart.delegation.startSessionTask({
      callerSessionId: 'session-1',
      objective: '应用重启后也要收到结果。',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      beforeRestart.dispose();
      return;
    }
    h.sqlite!.prepare(
      `INSERT INTO messages (id, client_id, session_id, role, content, created_at)
       VALUES (?, ?, ?, 'assistant', ?, ?)`,
    ).run(
      'restored-answer',
      'restored-answer-client',
      started.childSessionId,
      '重启后恢复的结果。',
      20_000,
    );
    h.sqlite!.prepare(
      `UPDATE sessions
       SET active_turn_started_at = ?, last_turn_ended_at = ?
       WHERE id = ?`,
    ).run(10_000, 20_000, started.childSessionId);
    beforeRestart.dispose();

    const afterRestart = createDelegationRuntime();
    try {
      await afterRestart.delegation.restore();
      await expect(
        afterRestart.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({
        ok: true,
        task: { status: 'completed', result: '重启后恢复的结果。' },
      });
      expect(afterRestart.started.some((turn) => turn.sessionId === 'session-1')).toBe(true);
    } finally {
      afterRestart.dispose();
    }
  });

  it('re-delivers a terminal result whose durable completion wake is still pending', async () => {
    await seedPair();
    const beforeRestart = createDelegationRuntime();
    const started = await beforeRestart.delegation.startSessionTask({
      callerSessionId: 'session-1',
      objective: '崩溃窗口后补送完成结果。',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      beforeRestart.dispose();
      return;
    }
    await beforeRestart.settleChild(started.childSessionId, '需要可靠补送的结果。');
    h.sqlite!.prepare('DELETE FROM messages WHERE session_id = ? AND client_id = ?').run(
      'session-1',
      `bot-delegation-completion:${started.delegationId}`,
    );
    h.sqlite!.prepare(
      'UPDATE bot_delegations SET completion_delivered_at = NULL WHERE id = ?',
    ).run(started.delegationId);
    beforeRestart.dispose();

    const afterRestart = createDelegationRuntime();
    try {
      await afterRestart.delegation.restore();
      expect(
        h.sqlite!.prepare('SELECT content FROM messages WHERE session_id = ? AND client_id = ?')
          .pluck().get('session-1', `bot-delegation-completion:${started.delegationId}`),
      ).toContain('需要可靠补送的结果。');
      expect(
        h.sqlite!.prepare('SELECT completion_delivered_at FROM bot_delegations WHERE id = ?')
          .pluck().get(started.delegationId),
      ).toBe(10_000);
    } finally {
      afterRestart.dispose();
    }
  });

  it('returns a completed task to the requesting Bot current canonical Session', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '主任务异常恢复后也要把结果送回来。',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      // 走真实异常恢复入口，而不是手工伪造链接；恢复不能把仍在运行的子任务取消。
      h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = 'session-1'").run();
      const recovered = await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-a',
        expectedCanonicalSessionId: 'session-1',
        expectedProfileVersion: 1,
      });
      const currentSessionId = recovered.canonicalSessionId as string;
      await expect(resolveBotCanonicalSession('bot-a')).resolves.toEqual({
        status: 'resolved',
        sessionId: currentSessionId,
      });
      expect(
        h.sqlite!.prepare(
          'SELECT status, parent_session_id AS parentSessionId FROM bot_delegations WHERE id = ?',
        ).get(started.delegationId),
      ).toEqual({ status: 'running', parentSessionId: currentSessionId });
      expect(
        h.sqlite!.prepare('SELECT parent_session_id FROM sessions WHERE id = ?').pluck()
          .get(started.childSessionId),
      ).toBe(currentSessionId);
      expect(
        h.sqlite!.prepare('SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?')
          .get(currentSessionId, `bot-delegation-request:${started.delegationId}`),
      ).toBeTruthy();

      await runtime.delegation.settleSession({
        childSessionId: started.childSessionId,
        outcome: 'done',
        resultText: '异常恢复后的交付结果。',
      });

      expect(runtime.started.some((turn) => turn.sessionId === currentSessionId)).toBe(true);
      expect(
        h.sqlite!.prepare(
          'SELECT content FROM messages WHERE session_id = ? AND client_id = ?',
        ).pluck().get(
          currentSessionId,
          `bot-delegation-completion:${started.delegationId}`,
        ),
      ).toContain('异常恢复后的交付结果。');
    } finally {
      runtime.dispose();
    }
  });

  it('moves a finished task card to a recovered canonical task', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '完成后也不能丢掉任务卡。',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      await runtime.settleChild(started.childSessionId, '已经完成。');

      h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = 'session-1'").run();
      const recovered = await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-a',
        expectedCanonicalSessionId: 'session-1',
        expectedProfileVersion: 1,
      });
      const currentSessionId = recovered.canonicalSessionId as string;
      expect(
        h.sqlite!.prepare('SELECT parent_session_id FROM bot_delegations WHERE id = ?').pluck()
          .get(started.delegationId),
      ).toBe(currentSessionId);
      expect(
        h.sqlite!.prepare('SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?')
          .get(currentSessionId, `bot-delegation-request:${started.delegationId}`),
      ).toBeTruthy();
    } finally {
      runtime.dispose();
    }
  });

  it('lets only the requesting Bot control its Session task', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1',
        objective: '只能由发起方控制。',
      });
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      await invoke('local-db:bots:create', {
        id: 'bot-b',
        name: '另一个伙伴',
        capabilities: {
          harness: 'pi',
          model: 'grok-4.5',
          providerId: PROVIDER,
          permissions: 'trusted',
        },
      });
      const other = await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-b',
        expectedCanonicalSessionId: null,
        expectedProfileVersion: 1,
      });
      const otherSessionId = other.canonicalSessionId as string;

      await expect(
        runtime.delegation.getSessionTask(otherSessionId, started.delegationId),
      ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
      await expect(
        runtime.delegation.messageSessionTask(otherSessionId, started.delegationId, {
          kind: 'message',
          text: '试图修改别人的任务。',
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
      await expect(
        runtime.delegation.stopSessionTask(otherSessionId, started.delegationId),
      ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
      await expect(
        runtime.delegation.getSessionTask('session-1', started.delegationId),
      ).resolves.toMatchObject({ ok: true, task: { status: 'running' } });
    } finally {
      runtime.dispose();
    }
  });
});
