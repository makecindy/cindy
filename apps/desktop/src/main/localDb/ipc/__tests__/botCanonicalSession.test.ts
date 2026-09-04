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

import { createBotCanonicalSession, registerBotIpc } from '../bots';
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
      last_error TEXT,
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      completed_at INTEGER,
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

    await invoke('local-db:bots:renew-if-due', { botId: 'bot-lizi' });
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





it('does not rotate a canonical task with a durable queued input', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.sqlite!.prepare(
      `INSERT INTO agent_input_queue_snapshots
      (session_id, payload, updated_at) VALUES (?, '[]', 1)`,
    ).run(created.canonicalSessionId);

    await expect(
      createBotCanonicalSession({
        botId: 'bot-1',
        expectedCanonicalSessionId: created.canonicalSessionId,
        expectedProfileVersion: 1,
        allowRotation: true,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
    expect(
      h
        .sqlite!.prepare('SELECT status FROM sessions WHERE id = ?')
        .pluck()
        .get(created.canonicalSessionId),
    ).toBe('active');
    expect(h.sqlite!.prepare('SELECT COUNT(*) FROM sessions').pluck().get()).toBe(1);
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

  it('never turns a transient canonical read failure into an implicit Renew', async () => {
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

  it('reports canonical health and exposes lifecycle events without renderer-owned scope', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    const health = await invoke('local-db:bots:health', 'bot-1');
    expect(health).toMatchObject({
      botId: 'bot-1',
      status: 'healthy',
      canonical: {
        sessionId: created.session.id,
        sessionStatus: 'active',
        linked: true,
        profileVersion: 1,
        runtimeStatus: 'not-started',
      },
      issues: [],
    });

    const events = await invoke('local-db:bots:lifecycle-events', { botId: 'bot-1' });
    expect(events.map((event: { eventType: string }) => event.eventType)).toEqual(
      expect.arrayContaining(['created', 'canonical-created']),
    );
  });

  it('projects durable typed attention into Bot list and health', async () => {
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
    const health = await invoke('local-db:bots:health', 'bot-1');
    expect(health).toMatchObject({
      failureReason: 'provider_quota_limit',
      needsAttention: true,
      status: 'attention',
      issues: expect.arrayContaining([{ code: 'durable-attention' }]),
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
    await hydrateBotProfileRuntime(engineOff, {
      isMemoryEngineEnabled: () => false,
      readMemoryIndex: async () => '# Bot facts\n- Durable fact',
    }, { persistSnapshot: false });
    expect(engineOff.makerMemoryEnabled).toBe(true);
    expect(engineOff.makerMemoryIndexSnapshot).toContain('Durable fact');

    const engineOn = makeOpts();
    await hydrateBotProfileRuntime(engineOn, {
      isMemoryEngineEnabled: () => true,
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

  it('compacts the canonical Chat in place instead of replacing its real Session', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const compactSession = vi.fn(async (instructions?: string) => ({
      tokensBefore: 100,
      estimatedTokensAfter: 20,
      instructions,
    }));
    h.getSession.mockReturnValue({
      capabilities: { manualCompact: { supported: true } },
      compactSession,
    });

    const result = await invoke('local-db:bots:compact-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: created.session.id,
      instructions: 'Keep the durable Bot identity and active commitments.',
    });
    expect(result).toMatchObject({ compacted: true, canonicalSessionId: created.session.id });
    expect(compactSession).toHaveBeenCalledWith(
      'Keep the durable Bot identity and active commitments.',
    );
    expect(h.sqlite!.prepare("SELECT COUNT(*) FROM bot_session_links WHERE role = 'canonical'").pluck().get())
      .toBe(1);
    expect(h.sqlite!.prepare("SELECT COUNT(*) FROM bot_session_links WHERE role = 'history'").pluck().get())
      .toBe(0);
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
          allowRotation: true,
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

  /**
   * 注意作用域：这条（以及本 describe 里其它委派用例）**桩掉了 dispatch 与 turn 结算**，
   * 测的是 `botDelegationService` 的状态机与投影——不是「子任务真的跑起来了」。
   * 去程真的能不能起、回程真的有没有落回发起方的对话，见文件末尾
   * `Bot delegation end-to-end runtime` 那个 describe。
   */
  it('wakes a target Bot without a canonical task, runs a child task, and returns the result', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: {
        harness: 'codex',
        model: 'gpt-5.5',
        permissions: 'trusted',
      },
    });
    expect(
      h.sqlite!.prepare('SELECT canonical_session_id FROM bot_profiles WHERE id = ?').pluck().get(
        'bot-2',
      ),
    ).toBeNull();
    const dispatch = vi.fn(
      async (params: { targetSessionId: string; onAccepted?: () => Promise<void> | void }) => {
        await params.onAccepted?.();
        return {
          ok: true as const,
          targetSessionId: params.targetSessionId,
          wakeKind: 'already-active' as const,
        };
      },
    );
    const abortSession = vi.fn(async () => undefined);
    const closeSession = vi.fn(async () => undefined);
    const broadcastSessionCreated = vi.fn();
    const service = createBotDelegationService({
      dispatch,
      abortSession,
      closeSession,
      broadcastSessionCreated,
      now: () => 1_000,
      createId: () => 'delegation-1',
    });
    try {
      const delegated = await service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Research the release compatibility matrix.',
        timeoutMs: 60_000,
      });
      expect(delegated).toMatchObject({
        ok: true,
        delegationId: 'delegation-1',
        childSessionId: 'session-3',
        targetBotId: 'bot-2',
        depth: 1,
        status: 'running',
      });
      expect(
        h.sqlite!.prepare('SELECT canonical_session_id FROM bot_profiles WHERE id = ?').pluck().get(
          'bot-2',
        ),
      ).toBe('session-2');
      expect(broadcastSessionCreated).toHaveBeenCalledWith('session-2');
      expect(broadcastSessionCreated).toHaveBeenCalledWith('session-3');
      expect(
        h
          .sqlite!.prepare(
            'SELECT source, parent_session_id AS parentSessionId, agent_kind AS agentKind FROM sessions WHERE id = ?',
          )
          .get('session-3'),
      ).toEqual({ source: 'bot', parentSessionId: 'session-1', agentKind: 'codex' });
      expect(
        h
          .sqlite!.prepare(
            'SELECT bot_id AS botId, role, route_key AS routeKey FROM bot_session_links WHERE session_id = ?',
          )
          .get('session-3'),
      ).toEqual({ botId: 'bot-2', role: 'delegation', routeKey: 'delegation:delegation-1' });
      expect(
        h.sqlite!.prepare(`SELECT role, content FROM messages
          WHERE session_id = 'session-2' ORDER BY created_at, rowid`).all(),
      ).toEqual([
        {
          role: 'assistant',
          content: '',
        },
      ]);
      await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-2',
        expectedCanonicalSessionId: 'session-2',
        expectedProfileVersion: 1,
      });
      expect(
        h.sqlite!.prepare('SELECT canonical_session_id FROM bot_profiles WHERE id = ?').pluck().get(
          'bot-2',
        ),
      ).toBe('session-2');
      expect(
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-2'),
      ).toBe('active');

      h.sqlite!.prepare('UPDATE sessions SET total_token_usage = 900 WHERE id = ?').run(
        'session-3',
      );
      await service.settleSession({
        childSessionId: 'session-3',
        outcome: 'done',
        resultText: 'All supported clients remain compatible.',
      });
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, tokens_used AS tokensUsed, result_summary AS resultSummary FROM bot_delegations WHERE id = ?',
          )
          .get('delegation-1'),
      ).toEqual({
        status: 'completed',
        tokensUsed: 900,
        resultSummary: 'All supported clients remain compatible.',
      });
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          targetSessionId: 'session-1',
          message: expect.stringContaining('All supported clients remain compatible.'),
        }),
      );
      // 子任务归档由 bots.finishDelegation tx 在同一事务内完成(旧接线走通用
      // sessions.setStatus 被 bot 守卫拒单,错误还被吞掉 —— PR #2829 QA 缺陷 B)。
      expect(closeSession).toHaveBeenCalledWith('session-3');
      expect(
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-3'),
      ).toBe('archived');
      expect(
        h
          .sqlite!.prepare('SELECT role FROM bot_session_links WHERE session_id = ?')
          .pluck()
          .get('session-3'),
      ).toBe('history');
      expect(
        h.sqlite!.prepare(`SELECT role, content FROM messages
          WHERE session_id = 'session-2' ORDER BY created_at, rowid`).all(),
      ).toEqual([
        {
          role: 'assistant',
          content: '',
        },
        {
          role: 'assistant',
          content: '',
        },
      ]);
      expect(
        h.sqlite!.prepare('SELECT count(*) FROM messages WHERE session_id = ?').pluck().get(
          'session-4',
        ),
      ).toBe(0);
      await service.settleSession({
        childSessionId: 'session-3',
        outcome: 'done',
        resultText: 'Duplicate completion must not append another result.',
      });
      expect(
        h.sqlite!.prepare(`SELECT count(*) FROM messages
          WHERE session_id = 'session-2' AND client_id = ?`).pluck().get(
          'bot-delegation-target-result:delegation-1',
        ),
      ).toBe(1);
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-3',
          targetBotId: 'bot-1',
          objective: 'A historical task must not start new work.',
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    } finally {
      service.dispose();
    }
  });

  it('keeps a failed delegation visible in the target Bot canonical task', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
    });
    const service = createBotDelegationService({
      dispatch: vi.fn(
        async (params: { targetSessionId: string; onAccepted?: () => Promise<void> | void }) => {
          await params.onAccepted?.();
          return {
            ok: true as const,
            targetSessionId: params.targetSessionId,
            wakeKind: 'already-active' as const,
          };
        },
      ),
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-failed-visible',
      now: () => 1_500,
    });
    try {
      const delegated = await service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Investigate a deliberately failing task.',
      });
      expect(delegated).toMatchObject({ ok: true, childSessionId: 'session-3' });
      await service.settleSession({
        childSessionId: 'session-3',
        outcome: 'error',
        error: 'The dependency was unavailable.',
      });
      expect(
        h.sqlite!.prepare(`SELECT role, content FROM messages
          WHERE session_id = 'session-2' ORDER BY created_at, rowid`).all(),
      ).toEqual([
        {
          role: 'assistant',
          content: '',
        },
        {
          role: 'assistant',
          content: '',
        },
      ]);
    } finally {
      service.dispose();
    }
  });

  it('cancels active delegation descendants when the parent canonical Session is recovered', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
    });
    const abortSession = vi.fn(async () => undefined);
    const service = createBotDelegationService({
      dispatch: vi.fn(async (params: { targetSessionId: string }) => ({
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: 'queued' as const,
      })),
      abortSession,
      createId: () => 'delegation-parent-renew',
      now: () => 6_000,
    });
    try {
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: 'Remain bounded to this parent task.',
        }),
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-3' });
      h.sqlite!.prepare("UPDATE sessions SET status = 'deleted' WHERE id = 'session-1'").run();
      await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1',
        expectedCanonicalSessionId: 'session-1',
        expectedProfileVersion: 1,
      });

      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck().get(
          'delegation-parent-renew',
        ),
      ).toBe('cancelled');
      expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-3')).toBe(
        'archived',
      );
      expect(abortSession).toHaveBeenCalledWith('session-3');
      expect(
        h.sqlite!.prepare(`SELECT role, content FROM messages
          WHERE session_id = 'session-2' AND client_id = ?`).get(
          'bot-delegation-target-result:delegation-parent-renew',
        ),
      ).toEqual({ role: 'assistant', content: '' });
    } finally {
      service.dispose();
    }
  });

  it('rejects delegation cycles and can cancel an active child', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
    });
    const dispatch = vi.fn(async (params: { targetSessionId: string }) => ({
      ok: true as const,
      targetSessionId: params.targetSessionId,
      wakeKind: 'queued' as const,
    }));
    const abortSession = vi.fn(async () => undefined);
    let id = 0;
    const service = createBotDelegationService({
      dispatch,
      abortSession,
      createId: () => `delegation-${++id}`,
      now: () => 2_000,
    });
    try {
      const first = await service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Prepare research.',
        maxDepth: 2,
      });
      expect(first).toMatchObject({ ok: true, childSessionId: 'session-3' });
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-3',
          targetBotId: 'bot-1',
          objective: 'Send the same work back.',
          maxDepth: 2,
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'DELEGATION_CYCLE' });

      await expect(service.cancelDelegation('session-1', 'delegation-1')).resolves.toMatchObject({
        ok: true,
        childSessionId: 'session-3',
      });
      expect(abortSession).toHaveBeenCalledWith('session-3');
      expect(
        h
          .sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?')
          .pluck()
          .get('delegation-1'),
      ).toBe('cancelled');
      expect(
        h.sqlite!.prepare(`SELECT role, content FROM messages
          WHERE session_id = 'session-2' AND client_id = ?`).get(
          'bot-delegation-target-result:delegation-1',
        ),
      ).toEqual({ role: 'assistant', content: '' });
    } finally {
      service.dispose();
    }
  });

  it('resumes an interrupted running delegation with a stable restart client id', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
    });
    const first = createBotDelegationService({
      dispatch: vi.fn(
        async (params: { targetSessionId: string; onAccepted?: () => Promise<void> | void }) => {
          await params.onAccepted?.();
          return {
            ok: true as const,
            targetSessionId: params.targetSessionId,
            wakeKind: 'already-active' as const,
          };
        },
      ),
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-running-restart',
      now: () => 30_000,
    });
    try {
      await expect(
        first.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: 'Continue after a host restart.',
        }),
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-3', status: 'running' });
    } finally {
      first.dispose();
    }
    h.sqlite!.prepare(
      `
      UPDATE sessions
      SET active_turn_started_at = 31000, last_turn_ended_at = 30000
      WHERE id = 'session-3'
    `,
    ).run();

    const dispatch = vi.fn(async (params: { targetSessionId: string }) => ({
      ok: true as const,
      targetSessionId: params.targetSessionId,
      wakeKind: 'already-active' as const,
    }));
    const restored = createBotDelegationService({
      dispatch,
      abortSession: vi.fn(async () => undefined),
      now: () => 32_000,
    });
    try {
      await restored.restore();
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          targetSessionId: 'session-3',
          clientId: 'bot-delegation-resume:delegation-running-restart:31000',
          message: expect.stringContaining('Continue after a host restart.'),
        }),
      );
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, last_error AS lastError FROM bot_delegations WHERE id = ?',
          )
          .get('delegation-running-restart'),
      ).toEqual({ status: 'running', lastError: null });
    } finally {
      restored.dispose();
    }
  });

  it('times out an interrupted delegation before restart recovery can dispatch it again', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
    });
    const first = createBotDelegationService({
      dispatch: vi.fn(
        async (params: { targetSessionId: string; onAccepted?: () => Promise<void> | void }) => {
          await params.onAccepted?.();
          return {
            ok: true as const,
            targetSessionId: params.targetSessionId,
            wakeKind: 'already-active' as const,
          };
        },
      ),
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-expired-restart',
      now: () => 40_000,
    });
    try {
      await first.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Do not resume after the deadline.',
        timeoutMs: 1_000,
      });
    } finally {
      first.dispose();
    }

    const dispatch = vi.fn();
    const abortSession = vi.fn(async () => undefined);
    const restored = createBotDelegationService({
      dispatch,
      abortSession,
      now: () => 42_000,
    });
    try {
      await restored.restore();
      expect(dispatch).not.toHaveBeenCalled();
      expect(abortSession).toHaveBeenCalledWith('session-3');
      expect(
        h.sqlite!
          .prepare('SELECT status FROM bot_delegations WHERE id = ?')
          .pluck()
          .get('delegation-expired-restart'),
      ).toBe('failed');
      expect(
        h.sqlite!.prepare(`SELECT role, content FROM messages
          WHERE session_id = 'session-2' AND client_id = ?`).get(
          'bot-delegation-target-result:delegation-expired-restart',
        ),
      ).toEqual({ role: 'assistant', content: '' });
    } finally {
      restored.dispose();
    }
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

describe('Bot teammate collaboration', () => {
  it('does not start a call when its requesting-timeline card cannot persist', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-planner',
      name: 'Planner Bot',
      capabilities: { harness: 'codex', model: 'gpt-5.5', permissions: 'trusted' },
    });

    const dispatch = vi.fn(async () => ({
      ok: true as const,
      targetSessionId: 'never-dispatched',
      wakeKind: 'already-active' as const,
    }));
    const abortSession = vi.fn(async () => undefined);
    const persistTimelineMessage = vi.fn(async (params: { clientId: string }) => {
      if (params.clientId.startsWith('bot-delegation-request:')) {
        throw new Error('timeline temporarily unavailable');
      }
    });
    const service = createBotDelegationService({
      dispatch,
      abortSession,
      persistTimelineMessage,
      now: () => 10_000,
      createId: () => 'missing-card-call',
    });

    try {
      const result = await service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-planner',
        objective: '做一件不能隐身启动的工作。',
      });

      expect(result).toMatchObject({
        ok: false,
        errorCode: 'PARENT_TIMELINE_PERSIST_FAILED',
      });
      expect(dispatch).not.toHaveBeenCalled();
      expect(persistTimelineMessage).toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'bot-delegation-request:missing-card-call' }),
      );
      expect(persistTimelineMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'bot-delegation-target-request:missing-card-call' }),
      );
      expect(persistTimelineMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'bot-delegation-target-result:missing-card-call' }),
      );
      expect(abortSession).toHaveBeenCalledTimes(1);
      expect(
        h.sqlite!
          .prepare('SELECT status FROM bot_delegations WHERE id = ?')
          .pluck()
          .get('missing-card-call'),
      ).toBe('failed');

      // A restart must not backfill an orphan result card into the target task when the
      // corresponding request was never projected and the work never started.
      persistTimelineMessage.mockClear();
      await service.restore();
      expect(persistTimelineMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'bot-delegation-target-request:missing-card-call' }),
      );
      expect(persistTimelineMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ clientId: 'bot-delegation-target-result:missing-card-call' }),
      );
    } finally {
      service.dispose();
    }
  });

  it('runs a two-stage teammate relay and lets the requester interject mid-flight', async () => {
    // 连环编排的完整链路：Cindy 先叫策划，策划完再拿它的结论去叫设计；期间还能
    // 对正在忙的伙伴补一句话。断言覆盖三件事：委派先后成立、消息流里的锚点顺序
    // 正确、插话按归属 / 状态 / 幂等收口。
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-planner',
      name: 'Planner Bot',
      capabilities: { harness: 'codex', model: 'gpt-5.5', permissions: 'trusted' },
    });
    await invoke('local-db:bots:create', {
      id: 'bot-designer',
      name: 'Designer Bot',
      capabilities: { harness: 'codex', model: 'gpt-5.5', permissions: 'trusted' },
    });

    const dispatch = vi.fn(
      async (params: { targetSessionId: string; onAccepted?: () => Promise<void> | void }) => {
        await params.onAccepted?.();
        return {
          ok: true as const,
          targetSessionId: params.targetSessionId,
          wakeKind: 'already-active' as const,
        };
      },
    );
    const resolveInteraction = vi.fn(() => true);
    let clock = 10_000;
    let ids = 0;
    const service = createBotDelegationService({
      dispatch,
      abortSession: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      broadcastSessionCreated: vi.fn(),
      resolveInteraction,
      now: () => clock,
      createId: () => {
        ids += 1;
        return `gen-${ids}`;
      },
    });

    try {
      // ── 第一棒：策划 ───────────────────────────────────────────────────
      const planning = await service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-planner',
        objective: '给「伙伴协作」做一版方案。',
        timeoutMs: 600_000,
      });
      expect(planning).toMatchObject({ ok: true, targetBotId: 'bot-planner', depth: 1 });
      const firstId = (planning as { delegationId: string }).delegationId;
      const firstChild = (planning as { childSessionId: string }).childSessionId;

      // 发起方消息流里出现协作卡锚点（空正文 + 结构化标记）。
      const anchor = h.sqlite!
        .prepare('SELECT role, content, agent_meta AS agentMeta FROM messages WHERE session_id = ? AND client_id = ?')
        .get('session-1', `bot-delegation-request:${firstId}`) as
        | { role: string; content: string; agentMeta: string }
        | undefined;
      expect(anchor).toMatchObject({ role: 'assistant', content: '' });
      expect(readBotCollaborationMeta(JSON.parse(anchor!.agentMeta).botCollaboration)).toMatchObject(
        {
          role: 'delegation-request',
          delegationId: firstId,
          fromBotId: 'bot-1',
          toBotId: 'bot-planner',
          toBotName: 'Planner Bot',
          parentSessionId: 'session-1',
          childSessionId: firstChild,
        },
      );
      // 目标伙伴主任务里的请求镜像同样带标记（客座来访 + 回跳发起方任务）。
      const guestRequest = h.sqlite!
        .prepare('SELECT agent_meta AS agentMeta FROM messages WHERE client_id = ?')
        .get(`bot-delegation-target-request:${firstId}`) as { agentMeta: string } | undefined;
      expect(
        readBotCollaborationMeta(JSON.parse(guestRequest!.agentMeta).botCollaboration),
      ).toMatchObject({ role: 'guest-request', parentSessionId: 'session-1' });

      // 子任务里的授权先回到发起伙伴：同一 call 进入 waiting，伙伴代答后继续。
      const permissionRequest = {
        kind: 'permission' as const,
        requestId: 'permission-1',
        toolName: 'write_file',
        input: { path: '/private/hidden' },
        title: '写入方案文件',
      };
      await service.handleInteractionStart(firstChild, permissionRequest);
      const waiting = await service.listDelegations('session-1');
      expect(waiting).toMatchObject({
        ok: true,
        delegations: [{
          id: firstId,
          status: 'waiting',
          pendingInteraction: {
            requestId: 'permission-1',
            kind: 'permission',
            summary: '写入方案文件',
          },
        }],
      });
      expect(waiting.ok && waiting.delegations[0]?.pendingInteraction).not.toHaveProperty('request');
      expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
        targetSessionId: 'session-1',
        clientId: `bot-delegation-interaction:${firstId}:permission-1`,
        message: expect.stringContaining('action=reply'),
      }));
      await expect(
        service.reply('session-1', firstId, { kind: 'approve' }),
      ).resolves.toMatchObject({ ok: true, delegationId: firstId });
      expect(resolveInteraction).toHaveBeenCalledWith('permission-1', {
        kind: 'permission',
        behavior: 'allow',
      });
      await service.handleInteractionEnd(firstChild, permissionRequest);
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck().get(firstId),
      ).toBe('running');

      // ── 忙时插话 ──────────────────────────────────────────────────────
      clock = 12_000;
      const nudge = await service.interjectDelegation(
        'session-1',
        firstId,
        '  先别铺开，我只要三条。  ',
        'nudge-1',
      );
      expect(nudge).toEqual({
        ok: true,
        delegationId: firstId,
        childSessionId: firstChild,
        queued: false,
      });
      expect(dispatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          targetSessionId: firstChild,
          clientId: `bot-delegation-interject:${firstId}:nudge-1`,
          persistedContent: expect.stringContaining('先别铺开，我只要三条。'),
        }),
      );
      const mirror = h.sqlite!
        .prepare('SELECT role, content, agent_meta AS agentMeta FROM messages WHERE session_id = ? AND client_id = ?')
        .get('session-1', `bot-delegation-interject-mirror:${firstId}:nudge-1`) as
        | { role: string; content: string; agentMeta: string }
        | undefined;
      // 正文两端的空白被裁掉：留痕记的是那句话，不是输入框里的手抖。
      expect(mirror).toMatchObject({ role: 'assistant', content: '先别铺开，我只要三条。' });
      expect(readBotCollaborationMeta(JSON.parse(mirror!.agentMeta).botCollaboration)).toMatchObject(
        { role: 'interjection', delegationId: firstId },
      );

      // 同一幂等 token 重发只留一条留痕。
      await service.interjectDelegation('session-1', firstId, '重复的一句', 'nudge-1');
      expect(
        h.sqlite!
          .prepare('SELECT count(*) FROM messages WHERE session_id = ? AND client_id = ?')
          .pluck()
          .get('session-1', `bot-delegation-interject-mirror:${firstId}:nudge-1`),
      ).toBe(1);

      // 归属：别的任务不能往这个委派里塞话，且不泄露「有这么个委派」。
      await expect(
        service.interjectDelegation('session-2', firstId, '我不是发起方'),
      ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_FOUND' });
      await expect(
        service.interjectDelegation('session-1', firstId, '   '),
      ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_ARGS' });

      // ── 第一棒收口 ────────────────────────────────────────────────────
      clock = 20_000;
      await service.settleSession({
        childSessionId: firstChild,
        outcome: 'done',
        resultText: '方案定三条：先对齐、再做卡、最后接插话。',
      });
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck().get(firstId),
      ).toBe('completed');
      // 完成信号是一条用户不可见的内部指令:synthetic-trigger 前缀让渲染 / 预览 /
      // 搜索统一隐藏,可见终态由协作卡承载;内部 call id 只在这条隐藏指令里用于续接。
      const completion = dispatch.mock.calls
        .map(([params]) => params as unknown as {
          message: string;
          persistedContent?: string;
          clientId?: string;
        })
        .find((params) => params.clientId === `bot-delegation-completion:${firstId}`);
      expect(completion!.message.startsWith(UI_ACTION_TRIGGER_PREFIX)).toBe(true);
      expect(completion!.message).toContain('方案定三条：先对齐、再做卡、最后接插话。');
      expect(completion!.message).toContain('Planner Bot');
      expect(completion!.message).toContain(firstId);
      expect(completion!.message).not.toContain(firstChild);
      expect(completion!.persistedContent).toBe(completion!.message);

      // 终态后不再接受插话。
      await expect(
        service.interjectDelegation('session-1', firstId, '再改一版'),
      ).resolves.toMatchObject({ ok: false, errorCode: 'ALREADY_TERMINAL' });

      // Bot 拿到终态回执后可以沿同一个 call 继续：旧子任务留在历史里，同一张卡
      // 指向新子任务并重新进入运行态，不再制造第二个互不相干的 call。
      clock = 25_000;
      const continued = await service.reply('session-1', firstId, {
        kind: 'message',
        text: '把第三条改成先验收再交付。',
      });
      expect(continued).toMatchObject({
        ok: true,
        delegationId: firstId,
        resumed: true,
        queued: false,
      });
      const continuedChild = continued.ok ? continued.childSessionId ?? '' : '';
      expect(continuedChild).not.toBe('');
      expect(continuedChild).not.toBe(firstChild);
      expect(
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get(firstChild),
      ).toBe('archived');
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck().get(firstId),
      ).toBe('running');
      expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({
        targetSessionId: continuedChild,
        clientId: `bot-delegation-start:${firstId}`,
        persistedContent: expect.stringContaining('把第三条改成先验收再交付。'),
      }));
      clock = 27_000;
      await service.settleSession({
        childSessionId: continuedChild,
        outcome: 'done',
        resultText: '方案已改：先对齐、再做卡、最后先验收再交付。',
      });

      // ── 第二棒：拿第一棒的结论去叫设计 ───────────────────────────────
      const firstResult = h.sqlite!
        .prepare('SELECT result_summary AS resultSummary FROM bot_delegations WHERE id = ?')
        .get(firstId) as { resultSummary: string };
      clock = 30_000;
      const design = await service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-designer',
        objective: `按这版方案出界面稿：${firstResult.resultSummary}`,
        timeoutMs: 600_000,
      });
      expect(design).toMatchObject({ ok: true, targetBotId: 'bot-designer', depth: 1 });
      const secondId = (design as { delegationId: string }).delegationId;
      expect(secondId).not.toBe(firstId);

      // 两张协作卡按发生顺序留在发起方的消息流里。
      const anchors = h.sqlite!
        .prepare(
          `SELECT client_id AS clientId FROM messages
             WHERE session_id = 'session-1' AND client_id LIKE 'bot-delegation-request:%'
             ORDER BY created_at, rowid`,
        )
        .all() as Array<{ clientId: string }>;
      expect(anchors.map((row) => row.clientId)).toEqual([
        `bot-delegation-request:${firstId}`,
        `bot-delegation-request:${secondId}`,
      ]);
      // 第二棒的目标读到的是第一棒的结论，不是原始需求。任务全文只进子任务去程,
      // 目标主任务里只留协作卡锚点,不再复读一遍。
      expect(
        h.sqlite!.prepare('SELECT objective FROM bot_delegations WHERE id = ?').pluck().get(secondId),
      ).toContain('先对齐、再做卡、最后先验收再交付');
      expect(
        h.sqlite!.prepare('SELECT role, content FROM messages WHERE client_id = ?')
          .get(`bot-delegation-target-request:${secondId}`),
      ).toEqual({ role: 'assistant', content: '' });

      const secondChild = (design as { childSessionId: string }).childSessionId;
      clock = 40_000;
      await service.settleSession({
        childSessionId: secondChild,
        outcome: 'done',
        resultText: '界面稿两张：协作卡与客座气泡。',
      });
      expect(
        h.sqlite!
          .prepare('SELECT id, status FROM bot_delegations ORDER BY created_at, rowid')
          .all(),
      ).toEqual([
        { id: firstId, status: 'completed' },
        { id: secondId, status: 'completed' },
      ]);
    } finally {
      service.dispose();
    }
  });


  it('recovers the teammate answer, not the collaboration card it left behind', async () => {
    // 嵌套委派下,子任务自己也会派活 —— 那会在它的时间线上留下协作卡锚点(空正文)
    // 与插话留痕,两者都是 assistant 行。重启恢复若直接取"最后一条 assistant",
    // 上一层拿到的"结果"就会变成一句催促,或者干脆是空的。
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'trusted' },
    });
    const first = createBotDelegationService({
      dispatch: vi.fn(
        async (params: { targetSessionId: string; onAccepted?: () => Promise<void> | void }) => {
          await params.onAccepted?.();
          return {
            ok: true as const,
            targetSessionId: params.targetSessionId,
            wakeKind: 'already-active' as const,
          };
        },
      ),
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-nested',
      now: () => 50_000,
    });
    try {
      await expect(
        first.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: '查一下兼容性矩阵。',
        }),
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-3' });
    } finally {
      first.dispose();
    }

    const insertMessage = h.sqlite!.prepare(
      `INSERT INTO messages (id, client_id, session_id, role, content, agent_meta, created_at)
       VALUES (?, ?, 'session-3', 'assistant', ?, ?, ?)`,
    );
    insertMessage.run('m-answer', 'answer', '矩阵查完了：三个版本都兼容。', null, 51_000);
    // 子任务转手派给了别人,时间线上落了一张协作卡锚点(空正文)。
    insertMessage.run(
      'm-card',
      'bot-delegation-request:delegation-inner',
      '',
      JSON.stringify({ botCollaboration: { v: 1, role: 'delegation-request', delegationId: 'x' } }),
      52_000,
    );
    insertMessage.run(
      'm-nudge',
      'bot-delegation-interject-mirror:delegation-inner:t1',
      '快一点',
      JSON.stringify({ botCollaboration: { v: 1, role: 'interjection', delegationId: 'x' } }),
      53_000,
    );
    h.sqlite!
      .prepare(
        `UPDATE sessions SET active_turn_started_at = 51000, last_turn_ended_at = 54000
           WHERE id = 'session-3'`,
      )
      .run();

    const restored = createBotDelegationService({
      dispatch: vi.fn(async (params: { targetSessionId: string }) => ({
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: 'already-active' as const,
      })),
      abortSession: vi.fn(async () => undefined),
      now: () => 55_000,
    });
    try {
      await restored.restore();
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, result_summary AS resultSummary FROM bot_delegations WHERE id = ?',
          )
          .get('delegation-nested'),
      ).toEqual({ status: 'completed', resultSummary: '矩阵查完了：三个版本都兼容。' });
    } finally {
      restored.dispose();
    }
  });
});

/**
 * 委派全链（真链路）。
 *
 * 与上面那些委派用例的区别，就是这一整个 describe 存在的理由：**它们桩掉了 dispatch**。
 * 桩 dispatch 等于假设「消息一送必到、子任务一定跑得起来」，于是测到的只是
 * `botDelegationService` 内部的状态机——真机上断掉的恰恰是被假设掉的那一段：
 * 子任务因为没继承目标伙伴的执行配置（来源/档位）而**根本起不来**，委派停在 waiting
 * 无限重试，协作卡永远转圈，结果永远回不来。
 *
 * 这里把桩下移一层：dispatch 是真的（按主机通路的判据逐条走：clientId 去重 → 会话行
 * 存在与状态 → 账号/模型来源就绪门 → harness 鉴权 → 落库 → 起 turn），只有「模型
 * 进程」这一层是假的。委派服务、外发队列、localDb、事件接线全部是真的。
 */
describe('Bot delegation end-to-end runtime', () => {
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
    accountReady?: () => boolean;
    replyFor?: (sessionId: string) => string;
  } = {}) {
    const accountReady = options.accountReady ?? (() => true);
    const started: StartedTurn[] = [];
    const pendingTurns: string[] = [];
    const changed: Array<{ delegationId: string; status: string }> = [];
    let currentTime = 10_000;
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
      // harness 鉴权：来源（provider）解析不出来就起不来。真机上这条长这样：
      // "AGENT_NOT_READY: pi not authenticated: cindy_gateway_key_unavailable"。
      if (!row.providerId) {
        return {
          ok: false as const,
          errorCode: 'AGENT_NOT_READY',
          message: `${row.agentKind} not authenticated: cindy_gateway_key_unavailable`,
        };
      }
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
      pendingTurns.push(params.targetSessionId);
      return {
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: 'resumed' as const,
      };
    };

    const delegation = createBotDelegationService({
      dispatch,
      abortSession: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      broadcastSessionCreated: vi.fn(),
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
        const sessionId = pendingTurns.shift()!;
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
    await invoke('local-db:bots:create', { id: 'bot-b', name: '目标伙伴', capabilities: base });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-a',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
  }

  it('starts the child task and lands the result back in the requesting conversation', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({
      replyFor: (sessionId) =>
        sessionId === 'session-3' ? '结论：三个版本都兼容。' : `${sessionId} 收到。`,
    });
    try {
      const delegated = await runtime.delegation.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-b',
        objective: '查一下版本兼容矩阵。',
      });
      expect(delegated).toMatchObject({ ok: true, childSessionId: 'session-3', status: 'running' });

      // 去程第一跳：子任务真的被启动了，而且带着目标伙伴自己的执行配置。
      // 真机断裂点就在这一行：provider_id 为空 → harness 起不来 → 委派停在 waiting。
      expect(runtime.started).toContainEqual({
        sessionId: 'session-3',
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
    } finally {
      runtime.dispose();
    }
  });

  it('runs A→B→C and wakes every requester with the real result', async () => {
    await seedPair();
    await invoke('local-db:bots:create', {
      id: 'bot-c',
      name: '第三棒',
      capabilities: {
        harness: 'pi',
        model: 'grok-4.5',
        permissions: 'trusted',
        providerId: PROVIDER,
        effort: 'high',
        fastMode: true,
      },
    });
    const runtime = createDelegationRuntime();
    try {
      const first = await runtime.delegation.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-b',
        objective: '先查兼容矩阵，再据此出一版结论。',
        maxDepth: 2,
      });
      expect(first).toMatchObject({ ok: true, status: 'running' });
      const firstChild = first.ok ? first.childSessionId : '';

      const nested = await runtime.delegation.delegateToBot({
        callerSessionId: firstChild,
        targetBotId: 'bot-c',
        objective: '查三个版本的兼容矩阵。',
      });
      expect(nested).toMatchObject({ ok: true, status: 'running', depth: 2 });
      const nestedChild = nested.ok ? nested.childSessionId : '';

      await runtime.settleChild(nestedChild, '矩阵查完了：三个版本都兼容。');
      const nestedCompletion = `bot-delegation-completion:${nested.ok ? nested.delegationId : ''}`;
      expect(
        h.sqlite!.prepare('SELECT role, content FROM messages WHERE session_id = ? AND client_id = ?')
          .get(firstChild, nestedCompletion),
      ).toEqual({
        role: 'user',
        content: expect.stringContaining('矩阵查完了：三个版本都兼容。'),
      });
      expect(runtime.started.some((turn) => turn.sessionId === firstChild)).toBe(true);

      await runtime.settleChild(firstChild, '策划结论：三个版本都兼容，可以出稿。');
      const firstCompletion = `bot-delegation-completion:${first.ok ? first.delegationId : ''}`;
      expect(
        h.sqlite!.prepare('SELECT role, content FROM messages WHERE session_id = ? AND client_id = ?')
          .get('session-1', firstCompletion),
      ).toEqual({
        role: 'user',
        content: expect.stringContaining('策划结论：三个版本都兼容，可以出稿。'),
      });
      expect(runtime.started.some((turn) => turn.sessionId === 'session-1')).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  it('recovers the child answer from the transcript when done.result is empty', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const delegated = await runtime.delegation.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-b',
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

  it('fails a delegation visibly when no account provider is available instead of hanging', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ accountReady: () => false });
    try {
      const delegated = await runtime.delegation.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-b',
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

      // 协作卡靠这条推送翻终态；没有它，卡片就永远停在「进行中」。用户看到的
      // 失败交代由卡片承载——账号没就绪时连完成指令都送不进会话,卡片就是兜底。
      expect(runtime.changed.at(-1)).toEqual({ delegationId, status: 'failed' });
    } finally {
      runtime.dispose();
    }
  });

  it('gives up a delegation whose child task can never authenticate', async () => {
    // 目标伙伴没有配置来源 → 子任务继承到的也是空来源 → harness 永远起不来。
    // 这正是真机取证里那条 "AGENT_NOT_READY: pi not authenticated" 的形状。
    await seedPair({ providerId: null });
    vi.useFakeTimers();
    const runtime = createDelegationRuntime();
    try {
      const delegated = await runtime.delegation.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-b',
        objective: '起不来的活也要有终点。',
      });
      expect(delegated).toMatchObject({ ok: true, status: 'queued' });
      const delegationId = delegated.ok ? delegated.delegationId : '';
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck().get(delegationId),
      ).toBe('queued');
      expect(
        h.sqlite!.prepare('SELECT provider_id FROM sessions WHERE id = ?').pluck().get('session-3'),
      ).toBeNull();

      // 退避重试是有上限的：1+2+4+8+16 秒之后必须收口，而不是一直转到委派超时
      // （默认 30 分钟）——那半小时里用户看到的只有一个一直转圈的协作卡。
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
});
