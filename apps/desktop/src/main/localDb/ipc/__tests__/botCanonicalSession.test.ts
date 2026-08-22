import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  botChannels,
  botAutomationLinks,
  botAutomationRuns,
  botDeliveryOutbox,
  botDelegations,
  botLifecycleEvents,
  botProfiles,
  botProfileVersions,
  botProjectBindings,
  botRuntimeSnapshots,
  botRoutes,
  botSessionLinks,
  botWorkspaceAttachments,
  botWorkspaceLeases,
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
  ensureDialogue: vi.fn((sessionId: string) => `/tmp/cindy-bot-test/${sessionId}`),
  searchConversations: vi.fn(),
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
  getMakerIfReady: () => ({ isSessionAlive: h.isSessionAlive, closeSession: h.closeSession }),
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

import { registerBotIpc } from '../bots';
import { tx as runWorkerTx } from '../../worker/opHandlers/tx.js';
import { assertTrustedAppRendererEvent } from '../../../security/trustedAppRenderer.js';
import { runDeviceLinkInvokeContext } from '../../../device-link/invoke-context.js';
import {
  claimBotRoute,
  ensureBotRouteSession,
  resolveBotRoute,
  resolveOrCreateBotRoute,
  setBotRouteStatus,
  updateBotRouteSession,
  upsertBotRoute,
} from '../../botRouteService';
import {
  prepareBotWorkspaceRuntime,
  reclaimPerTaskBotWorkspaceForSession,
  reconcileBotWorkspaceLeases,
} from '../../../maker-ipc/botWorkspaceRuntime';
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
import { createBotDeliveryOutboxService } from '../../../maker-ipc/botDeliveryOutboxService';
import { configureBotCanonicalReplacementCoordinator } from '../../../maker-ipc/botCanonicalReplacementCoordinator';
import type { MakerSessionCreateOpts } from '../../../maker-ipc/sessionRequest';
import { parseBotDelegationPlanSnapshot } from '../../../../shared/botDelegation';
import {
  readBotCollaborationMeta,
  readBotDelegationCompletionBody,
} from '../../../../shared/botCollaboration';

function testSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createDb(): void {
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
      extra_dirs TEXT NOT NULL DEFAULT '[]',
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
      last_turn_ended_at INTEGER
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
    CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
    CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);
    CREATE TABLE bot_profiles (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      description TEXT DEFAULT '' NOT NULL,
      avatar TEXT DEFAULT '🤖' NOT NULL,
      avatar_color TEXT DEFAULT 'violet' NOT NULL,
      status TEXT DEFAULT 'active' NOT NULL,
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
    CREATE TABLE bot_channels (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      enabled INTEGER DEFAULT 1 NOT NULL,
      config_json TEXT DEFAULT '{}' NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_bot_channels_bot_kind ON bot_channels(bot_id, kind);
    CREATE TABLE bot_session_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      profile_version INTEGER DEFAULT 1 NOT NULL,
      role TEXT NOT NULL,
      channel_id TEXT REFERENCES bot_channels(id) ON DELETE SET NULL,
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
    CREATE TABLE bot_project_bindings (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      project_key TEXT NOT NULL,
      working_dir TEXT NOT NULL,
      remote_host_id TEXT,
      default_branch TEXT,
      workspace_policy TEXT DEFAULT 'none' NOT NULL,
      is_default INTEGER DEFAULT false NOT NULL,
      allowed_paths_json TEXT DEFAULT '[]' NOT NULL,
      status TEXT DEFAULT 'active' NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_bot_project_bindings_bot_project
      ON bot_project_bindings(bot_id, project_key);
    CREATE UNIQUE INDEX uniq_bot_project_bindings_default_per_bot
      ON bot_project_bindings(bot_id) WHERE is_default = true AND status = 'active';
    CREATE TABLE bot_workspace_leases (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      project_binding_id TEXT NOT NULL REFERENCES bot_project_bindings(id) ON DELETE CASCADE,
      lease_key TEXT DEFAULT 'shared' NOT NULL,
      anchor_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      worktree_path TEXT,
      base_repo TEXT NOT NULL,
      branch TEXT,
      source_branch TEXT,
      remote_host_id TEXT,
      generation INTEGER DEFAULT 1 NOT NULL,
      status TEXT DEFAULT 'acquiring' NOT NULL,
      last_heartbeat_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      released_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_bot_workspace_leases_active_binding_key
      ON bot_workspace_leases(project_binding_id, lease_key)
      WHERE status IN ('acquiring', 'active', 'releasing');
    CREATE TABLE bot_workspace_attachments (
      id TEXT PRIMARY KEY NOT NULL,
      lease_id TEXT NOT NULL REFERENCES bot_workspace_leases(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL,
      access TEXT DEFAULT 'read-write' NOT NULL,
      created_at INTEGER NOT NULL,
      detached_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_bot_workspace_attachments_lease_session
      ON bot_workspace_attachments(lease_id, session_id, generation);
    CREATE UNIQUE INDEX uniq_bot_workspace_attachments_active_session
      ON bot_workspace_attachments(session_id) WHERE detached_at IS NULL;
    CREATE TABLE bot_delegations (
      id TEXT PRIMARY KEY NOT NULL,
      requesting_bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      target_bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      parent_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      child_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      objective TEXT NOT NULL,
      context_refs_json TEXT DEFAULT '[]' NOT NULL,
      artifact_refs_json TEXT DEFAULT '[]' NOT NULL,
      permission_snapshot_json TEXT DEFAULT '{}' NOT NULL,
      lineage_json TEXT DEFAULT '[]' NOT NULL,
      target_profile_version INTEGER NOT NULL,
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
    CREATE TABLE bot_automation_links (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      schedule_id TEXT,
      project_binding_id TEXT REFERENCES bot_project_bindings(id) ON DELETE SET NULL,
      target_route_id TEXT REFERENCES bot_routes(id) ON DELETE SET NULL,
      execution_policy_json TEXT DEFAULT '{}' NOT NULL,
      created_with_profile_version INTEGER NOT NULL,
      durable_note_namespace TEXT,
      status TEXT DEFAULT 'active' NOT NULL,
      suspended_status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_bot_automation_links_schedule
      ON bot_automation_links(schedule_id);
    CREATE TABLE bot_automation_runs (
      id TEXT PRIMARY KEY NOT NULL,
      automation_link_id TEXT NOT NULL,
      schedule_run_id TEXT,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      workspace_lease_id TEXT REFERENCES bot_workspace_leases(id) ON DELETE SET NULL,
      profile_version INTEGER NOT NULL,
      project_binding_id_snapshot TEXT,
      target_route_id_snapshot TEXT,
      target_route_owner_generation_snapshot INTEGER,
      working_dir_snapshot TEXT,
      remote_host_id_snapshot TEXT,
      worktree_path_snapshot TEXT,
      delivery_outbox_id TEXT,
      delivery_status TEXT DEFAULT 'not-requested' NOT NULL,
      delivery_error TEXT,
      result_text_snapshot TEXT,
      output_artifacts_json TEXT DEFAULT '[]' NOT NULL,
      error_message TEXT,
      execution_plan_json TEXT DEFAULT '{}' NOT NULL,
      status TEXT DEFAULT 'claimed' NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE bot_delivery_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      channel_id TEXT REFERENCES bot_channels(id) ON DELETE SET NULL,
      route_id TEXT,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      idempotency_key TEXT NOT NULL,
      payload_ref_json TEXT DEFAULT '{}' NOT NULL,
      owner_generation INTEGER DEFAULT 0 NOT NULL,
      status TEXT DEFAULT 'pending' NOT NULL,
      attempts INTEGER DEFAULT 0 NOT NULL,
      next_attempt_at INTEGER,
      last_error TEXT,
      delivery_receipt_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER
    );
    CREATE UNIQUE INDEX uniq_bot_delivery_outbox_idempotency
      ON bot_delivery_outbox(idempotency_key);
    CREATE TABLE bot_routes (
      id TEXT PRIMARY KEY NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bot_profiles(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES bot_channels(id) ON DELETE CASCADE,
      route_key TEXT NOT NULL,
      principal_key TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      thread_key TEXT,
      current_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      project_binding_id TEXT REFERENCES bot_project_bindings(id) ON DELETE SET NULL,
      capabilities_json TEXT DEFAULT '{}' NOT NULL,
      owner_device_id TEXT,
      owner_generation INTEGER DEFAULT 0 NOT NULL,
      status TEXT DEFAULT 'active' NOT NULL,
      suspended_status TEXT,
      last_activity_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uniq_bot_routes_channel_route
      ON bot_routes(channel_id, route_key);
  `);
  h.sqlite = sqlite;
  const rawDb = drizzle(sqlite, {
    schema: {
      sessions,
      botProfiles,
      botProfileVersions,
      botChannels,
      botAutomationLinks,
      botAutomationRuns,
      botDeliveryOutbox,
      botDelegations,
      botSessionLinks,
      botRuntimeSnapshots,
      botRoutes,
      botLifecycleEvents,
      botProjectBindings,
      botWorkspaceLeases,
      botWorkspaceAttachments,
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
        channels: [{ kind: 'local', enabled: true }],
      });
      expect(projection).not.toHaveProperty('identitySource');
      expect(projection).not.toHaveProperty('userContextSource');
      expect(projection).not.toHaveProperty('capabilities');
      expect(projection).not.toHaveProperty('projectBindings');
      expect(projection).not.toHaveProperty('workspaceLeases');
      expect(projection).not.toHaveProperty('routes');
      expect(projection.channels[0]).not.toHaveProperty('config');
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

  it('surfaces failed and dead-letter deliveries in Bot health', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const insert = h.sqlite!.prepare(`INSERT INTO bot_delivery_outbox (
      id, bot_id, idempotency_key, payload_ref_json, owner_generation, status,
      attempts, created_at, updated_at
    ) VALUES (?, 'bot-1', ?, '{}', 0, ?, 1, 1, 1)`);
    insert.run('delivery-failed', 'health-failed', 'failed');
    insert.run('delivery-dead-letter', 'health-dead-letter', 'dead-letter');

    const health = await invoke('local-db:bots:health', 'bot-1');
    expect(health).toMatchObject({
      status: 'attention',
      counts: {
        deliveries: 2,
        failedDeliveries: 1,
        deadLetterDeliveries: 1,
      },
      issues: expect.arrayContaining([
        { code: 'delivery-failed', count: 1 },
        { code: 'delivery-dead-letter', count: 1 },
      ]),
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
  });

  it('freezes Bot, project, and USER memory references into the exact runtime snapshot', async () => {
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
      expect.objectContaining({ kind: 'project', access: 'read-only', status: 'captured' }),
      expect.objectContaining({ kind: 'user', access: 'read-only', status: 'captured' }),
    ]);
    expect(opts.makerMemoryIndexSnapshot).toContain('## Bot Memory');
    expect(opts.makerMemoryIndexSnapshot).toContain('Durable fact');
    expect(opts.makerMemoryIndexSnapshot).toContain('## Project Memory (read-only excerpt)');
    // 项目索引只是上下文,伙伴的 memory_read / memory_search 打不开它(store 由
    // ctx.memoryScopeKey 定位,恒为 `bot:<botId>`)。不标注模型会照着索引去 read。
    expect(opts.makerMemoryIndexSnapshot).toContain('NOT in your memory store');
    expect(opts.makerMemoryIndexSnapshot).toContain('This is your own durable memory');
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
      // 2026-08-19 裁决:「定时干活」是标配, `normalizeBotAutomation` 在读取
      // 投影层一律归一为 true(见 shared/botAutomationCapability.ts)。
      automation: true,
    });
    expect(resolved.memoryRefs).toHaveLength(3);
    expect(row.resolvedJson).not.toContain('Durable fact');
    expect(row.resolvedJson).not.toContain('Call the user Chris');
  });

  it('freezes task-control permission in Profile context without polluting SOUL', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      capabilities: { sessionControlMode: 'coordinate' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 2,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind: 'codex',
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'gpt-5.4',
      permissionMode: 'ask',
    };

    const snapshot = await hydrateBotProfileRuntime(opts);

    expect(snapshot?.sessionControlMode).toBe('coordinate');
    expect(opts.botProfilePrompt).not.toContain('Cindy Task Control');
    expect(opts.botProfilePrompt).not.toContain('Cindy Bot Runtime');
    expect(opts.botProfileContextPrompt).toContain('## Cindy Bot Runtime');
    expect(opts.botProfileContextPrompt).toContain('Use `list_tools`');
    expect(opts.botProfileContextPrompt).toContain('offer the available delegation path');
    expect(opts.botProfileContextPrompt).toContain('## Cindy Task Control');
    expect(opts.botProfileContextPrompt).toContain('permits coordination');
    const row = h
      .sqlite!.prepare(
        `SELECT configured_json AS configuredJson, resolved_json AS resolvedJson
         FROM bot_runtime_snapshots WHERE id = ?`,
      )
      .get(snapshot!.snapshotId) as { configuredJson: string; resolvedJson: string };
    expect(JSON.parse(row.configuredJson)).toMatchObject({ sessionControlMode: 'coordinate' });
    expect(JSON.parse(row.resolvedJson)).toMatchObject({ sessionControlMode: 'coordinate' });
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
        expect.objectContaining({ kind: 'project', status: 'captured' }),
      ]),
    );
  });

  /**
   * 伙伴记忆终验:Bot 的 memory 能力位只能**收窄**到引擎现状。
   * 全局 Maker Memory 关着时 `cindy_memory` MCP server 根本不注册
   * (mcp-providers 的 isEnabled)、store 也打不开 —— 此时若仍按 Bot 的
   * `memory: true` 注入记忆 prompt, 就是让伙伴去调一个不存在的工具。
   */
  it('narrows the Bot memory capability to what the memory engine can actually serve', async () => {
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
      readMemoryIndex: async () => {
        throw new Error('maker memory disabled');
      },
    }, { persistSnapshot: false });
    expect(engineOff.makerMemoryEnabled).toBe(false);
    // 用户自己关了全局记忆开关不是「运行时解析降级」:不去读注定抛错的索引,
    // 也不把每次会话标成 degraded。
    expect(engineOff.makerMemoryIndexSnapshot).toBeUndefined();

    const engineOn = makeOpts();
    await hydrateBotProfileRuntime(engineOn, {
      isMemoryEngineEnabled: () => true,
      readMemoryIndex: async () => '# Bot facts\n- Durable fact',
    }, { persistSnapshot: false });
    expect(engineOn.makerMemoryEnabled).toBe(true);
    // 收窄不影响 scope key: 引擎回来后仍指向同一个伙伴记忆空间。
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

  it('materializes inherited capabilities into an immutable runtime allowlist', async () => {
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
      listSkills: async () => [{
        name: 'research',
        path: '/skills/research/SKILL.md',
        enabled: true,
        runtimeCommandName: 'skill:research',
      }],
      fingerprintSkillSource: async () => 'a'.repeat(64),
      listMcpServers: async () => [{
        name: 'docs',
        source: 'custom',
        available: true,
      }],
      listToolsets: async () => [{
        id: 'browser',
        name: 'Browser',
        available: true,
      }],
    });

    expect(opts.botRuntimeProfile).toMatchObject({
      skillPolicy: { mode: 'allowlist', configured: ['skill:research'] },
      mcpPolicy: { mode: 'allowlist', configured: ['docs'] },
      toolsetPolicy: { mode: 'allowlist', configured: ['browser'] },
    });
  });

  it('freezes Skill content for a task and requires Renew when the resource changes', async () => {
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
    expect(resumed?.resolvedSkillEntries).toEqual([
      expect.objectContaining({
        runtimeCommandName: 'skill:release',
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    await expect(hydrateBotProfileRuntime(makeOpts(), {
      listSkills,
      readSkillSource: async () => '# Release\nVersion two',
    })).rejects.toMatchObject({ code: 'BOT_RUNTIME_RESOURCE_DRIFT' });
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
        }],
      }),
    }, { persistSnapshot: false });

    expect(opts.botRuntimeProfile?.skillPolicy.ownSkills).toEqual([
      {
        name: 'weekly-report',
        description: 'How I put the weekly report together',
        path: '/userdata/bot-skills/bot-1/skills/weekly-report',
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
      catalog: [],
    });
  });

  it('freezes secret-free MCP generations and Toolset versions for a task', async () => {
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
    });
    await expect(hydrate('http:1001', '1.0.0')).rejects.toMatchObject({
      code: 'BOT_RUNTIME_RESOURCE_DRIFT',
    });
    await expect(hydrate('http:1000', '2.0.0')).rejects.toMatchObject({
      code: 'BOT_RUNTIME_RESOURCE_DRIFT',
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

  it('keeps the pinned ProfileVersion across resume and adopts the new version only after Renew', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
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

    const resumedSnapshot = await hydrateBotProfileRuntime(resumedOpts);
    expect(resumedSnapshot?.profileVersion).toBe(1);
    expect(resumedOpts.botProfilePrompt).toContain('You are Release Bot');
    expect(resumedOpts.botProfilePrompt).not.toContain('version two identity');

    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: 'session-1',
      expectedProfileVersion: 2,
    });
    const renewedOpts: MakerSessionCreateOpts = {
      ...resumedOpts,
      id: 'session-2',
      resumeSessionId: undefined,
      botProfilePrompt: undefined,
      botProfileContextPrompt: undefined,
      botRuntimeProfile: undefined,
    };
    const renewedSnapshot = await hydrateBotProfileRuntime(renewedOpts);
    expect(renewedSnapshot?.profileVersion).toBe(2);
    expect(renewedOpts.botProfilePrompt).toBe('You are the version two identity.');
    expect(renewedOpts.makerMemoryEnabled).toBe(false);
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

  it('uses the default project binding for a new canonical Session', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      isDefault: true,
      allowedPaths: ['/repo/product/docs'],
    });

    const result = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    expect(result.session).toMatchObject({
      workingDir: '/repo/product',
      workspaceKind: 'project',
    });
    expect(h.ensureDialogue).not.toHaveBeenCalled();
    expect(h.ensureGit).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDir: '/repo/product',
        workspaceKind: 'project',
      }),
    );
  });

  it('mounts a read-only Bot project without allocating a worktree lease', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/reference',
      remoteHostId: null,
      workspacePolicy: 'read-only',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const createWorktree = vi.fn();
    const opts = {
      id: 'session-1',
      agentKind: 'pi' as const,
      workingDir: '/tmp/placeholder',
      workspaceKind: 'dialogue' as const,
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions' as const,
    };

    await expect(prepareBotWorkspaceRuntime(opts, { createWorktree })).resolves.toMatchObject({
      workspacePolicy: 'read-only',
      workingDir: '/repo/reference',
    });

    expect(opts).toMatchObject({
      workingDir: '/repo/reference',
      workspaceKind: 'project',
      workspaceAccess: 'read-only',
    });
    expect(createWorktree).not.toHaveBeenCalled();
    expect(h.sqlite!.prepare('SELECT COUNT(*) FROM bot_workspace_leases').pluck().get()).toBe(0);
  });

  it('automatically releases a terminal per-task worktree without forcing unsafe cleanup', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'per-task',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const meta = {
      sessionId: 'session-1',
      name: 'bot-task',
      path: '/repo/product/.cindy-worktrees/bot-task',
      baseRepo: '/repo/product',
      branch: 'cindy/bot-task',
      sourceBranch: 'main',
      createdAt: new Date(0).toISOString(),
    };
    await prepareBotWorkspaceRuntime(
      {
        id: 'session-1',
        agentKind: 'pi',
        workingDir: '/repo/product',
        workspaceKind: 'project',
        model: 'grok-4.5',
      },
      {
        createId: () => 'lease-per-task-1',
        createWorktree: vi.fn(async () => ({ ok: true as const, meta })),
      },
    );
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = 'session-1'").run();

    const removeLocalWorktree = vi.fn(async () => undefined);
    await expect(
      reclaimPerTaskBotWorkspaceForSession('session-1', {
        now: () => 10,
        isSessionRuntimeAlive: () => false,
        removeLocalWorktree,
        listWorktrees: () => [],
        pathExists: async () => false,
      }),
    ).resolves.toBe(true);

    expect(removeLocalWorktree).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        isSessionRuntimeAlive: expect.any(Function),
        canRemove: expect.any(Function),
      }),
    );
    expect(
      h
        .sqlite!.prepare(
          'SELECT status, released_at AS releasedAt FROM bot_workspace_leases WHERE id = ?',
        )
        .get('lease-per-task-1'),
    ).toEqual({ status: 'released', releasedAt: 10 });
    expect(
      h
        .sqlite!.prepare(
          'SELECT detached_at AS detachedAt FROM bot_workspace_attachments WHERE lease_id = ?',
        )
        .get('lease-per-task-1'),
    ).toEqual({ detachedAt: 10 });
  });

  it('keeps a per-task worktree visible as error when the safety remover refuses it', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'per-task',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const meta = {
      sessionId: 'session-1',
      name: 'bot-task-dirty',
      path: '/repo/product/.cindy-worktrees/bot-task-dirty',
      baseRepo: '/repo/product',
      branch: 'cindy/bot-task-dirty',
      sourceBranch: 'main',
      createdAt: new Date(0).toISOString(),
    };
    await prepareBotWorkspaceRuntime(
      {
        id: 'session-1',
        agentKind: 'pi',
        workingDir: '/repo/product',
        workspaceKind: 'project',
        model: 'grok-4.5',
      },
      {
        createId: () => 'lease-per-task-dirty',
        createWorktree: vi.fn(async () => ({ ok: true as const, meta })),
      },
    );
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = 'session-1'").run();

    await expect(
      reclaimPerTaskBotWorkspaceForSession('session-1', {
        now: () => 20,
        isSessionRuntimeAlive: () => false,
        removeLocalWorktree: vi.fn(async () => {
          throw new Error('dirty worktree retained');
        }),
        listWorktrees: () => [meta],
        pathExists: async () => true,
      }),
    ).rejects.toThrow('dirty worktree retained');
    expect(
      h
        .sqlite!.prepare('SELECT status FROM bot_workspace_leases WHERE id = ?')
        .get('lease-per-task-dirty'),
    ).toEqual({ status: 'error' });
    expect(
      h
        .sqlite!.prepare(
          'SELECT detached_at AS detachedAt FROM bot_workspace_attachments WHERE lease_id = ?',
        )
        .get('lease-per-task-dirty'),
    ).toEqual({ detachedAt: null });
  });

  it('reclaims a per-task lease when its owning task row was physically lost', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'per-task',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const meta = {
      sessionId: 'session-1',
      name: 'bot-task-missing',
      path: '/repo/product/.cindy-worktrees/bot-task-missing',
      baseRepo: '/repo/product',
      branch: 'cindy/bot-task-missing',
      sourceBranch: 'main',
      createdAt: new Date(0).toISOString(),
    };
    await prepareBotWorkspaceRuntime(
      {
        id: 'session-1',
        agentKind: 'pi',
        workingDir: '/repo/product',
        workspaceKind: 'project',
        model: 'grok-4.5',
      },
      {
        createId: () => 'lease-per-task-missing',
        createWorktree: vi.fn(async () => ({ ok: true as const, meta })),
      },
    );
    h.sqlite!.pragma('foreign_keys = OFF');
    h.sqlite!.prepare("DELETE FROM sessions WHERE id = 'session-1'").run();
    h.sqlite!.pragma('foreign_keys = ON');

    await expect(
      reclaimPerTaskBotWorkspaceForSession('session-1', {
        now: () => 30,
        isSessionRuntimeAlive: () => false,
        removeLocalWorktree: vi.fn(async () => undefined),
        listWorktrees: () => [],
        pathExists: async () => false,
      }),
    ).resolves.toBe(true);
    expect(
      h.sqlite!
        .prepare('SELECT status FROM bot_workspace_leases WHERE id = ?')
        .pluck()
        .get('lease-per-task-missing'),
    ).toBe('released');
  });

  it('keeps one reuse lease across canonical Renew and attaches both Sessions', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const meta = {
      sessionId: 'session-1',
      name: 'bot-product',
      path: '/repo/product/.cindy-worktrees/bot-product',
      baseRepo: '/repo/product',
      branch: 'cindy/bot-product',
      sourceBranch: 'main',
      createdAt: new Date(0).toISOString(),
    };
    const createWorktree = vi.fn(async () => ({ ok: true as const, meta }));
    const getWorktreeForSession = vi.fn((sessionId: string) =>
      sessionId === 'session-1' ? meta : null,
    );
    const setWorktreeForSession = vi.fn(async () => undefined);
    const deleteWorktreeForSession = vi.fn();
    const firstOpts = {
      id: 'session-1',
      agentKind: 'pi' as const,
      workingDir: '/repo/product',
      workspaceKind: 'project' as const,
      model: 'grok-4.5',
    };
    await prepareBotWorkspaceRuntime(firstOpts, {
      createId: () => 'lease-1',
      createWorktree,
      getWorktreeForSession,
      setWorktreeForSession,
      deleteWorktreeForSession,
    });

    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: 'session-1',
      expectedProfileVersion: 1,
    });
    const secondOpts = {
      ...firstOpts,
      id: 'session-2',
      workingDir: '/repo/product',
    };
    await prepareBotWorkspaceRuntime(secondOpts, {
      createId: () => 'unused-lease',
      createWorktree,
      getWorktreeForSession,
      setWorktreeForSession,
      deleteWorktreeForSession,
    });

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(firstOpts.workingDir).toBe(meta.path);
    expect(secondOpts.workingDir).toBe(meta.path);
    expect(setWorktreeForSession).toHaveBeenCalledWith('session-2', {
      ...meta,
      sessionId: 'session-2',
    });
    expect(deleteWorktreeForSession).toHaveBeenCalledWith('session-1');
    expect(
      h
        .sqlite!.prepare(
          'SELECT lease_key AS leaseKey, anchor_session_id AS anchorSessionId, status FROM bot_workspace_leases',
        )
        .all(),
    ).toEqual([{ leaseKey: 'shared', anchorSessionId: 'session-2', status: 'active' }]);
    expect(
      h
        .sqlite!.prepare(
          'SELECT session_id AS sessionId FROM bot_workspace_attachments ORDER BY session_id',
        )
        .all(),
    ).toEqual([{ sessionId: 'session-1' }, { sessionId: 'session-2' }]);
  });

  it('creates and reuses a remote Bot worktree without registering a local worktree', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/remote/repo',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      remoteHostId: 'host-1',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const createRemoteWorktree = vi.fn(async () => ({
      path: '/remote/repo/.cindy-worktrees/lease-remote-1',
      baseRepo: '/remote/repo',
      branch: 'cindy/bot-lease-remote-1',
      sourceBranch: 'main',
    }));
    const inspectRemoteWorktree = vi.fn(async () => ({
      exists: true,
      branch: 'cindy/bot-lease-remote-1',
    }));
    const firstOpts = {
      id: 'session-1',
      agentKind: 'pi' as const,
      workingDir: '/remote/repo',
      workspaceKind: 'project' as const,
      model: 'grok-4.5',
    };
    await prepareBotWorkspaceRuntime(firstOpts, {
      createId: () => 'lease-remote-1',
      createRemoteWorktree,
      inspectRemoteWorktree,
    });
    expect(firstOpts).toMatchObject({
      workingDir: '/remote/repo/.cindy-worktrees/lease-remote-1',
      remoteHostId: 'host-1',
    });
    expect(h.worktrees).toEqual([]);

    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: 'session-1',
      expectedProfileVersion: 1,
    });
    const secondOpts = { ...firstOpts, id: 'session-2', workingDir: '/remote/repo' };
    await prepareBotWorkspaceRuntime(secondOpts, { createRemoteWorktree, inspectRemoteWorktree });
    expect(createRemoteWorktree).toHaveBeenCalledTimes(1);
    expect(
      h
        .sqlite!.prepare(
          'SELECT anchor_session_id AS anchorSessionId, remote_host_id AS remoteHostId FROM bot_workspace_leases',
        )
        .all(),
    ).toEqual([{ anchorSessionId: 'session-2', remoteHostId: 'host-1' }]);
  });

  it('rebuilds an interrupted remote acquisition from its durable lease id', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/remote/repo',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      remoteHostId: 'host-1',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.sqlite!.prepare(
      `INSERT INTO bot_workspace_leases (
        id, bot_id, project_binding_id, lease_key, anchor_session_id, worktree_path,
        base_repo, branch, source_branch, remote_host_id, generation, status, created_at, updated_at
      ) SELECT 'lease-remote-1', 'bot-1', id, 'shared', 'session-1', NULL,
        '/remote/repo', NULL, 'main', 'host-1', 1, 'acquiring', 1, 1
        FROM bot_project_bindings WHERE bot_id = 'bot-1'`,
    ).run();
    const createRemoteWorktree = vi.fn(async () => ({
      path: '/remote/repo/.cindy-worktrees/lease-remote-1',
      baseRepo: '/remote/repo',
      branch: 'cindy/bot-lease-remote-1',
      sourceBranch: 'main',
    }));
    await reconcileBotWorkspaceLeases({
      now: () => 2,
      createRemoteWorktree,
      inspectRemoteWorktree: vi.fn(async () => ({
        exists: true,
        branch: 'cindy/bot-lease-remote-1',
      })),
    });
    expect(createRemoteWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteHostId: 'host-1',
        leaseId: 'lease-remote-1',
        generation: 1,
      }),
    );
    expect(
      h
        .sqlite!.prepare(
          'SELECT status, worktree_path AS worktreePath FROM bot_workspace_leases WHERE id = ?',
        )
        .get('lease-remote-1'),
    ).toEqual({ status: 'active', worktreePath: '/remote/repo/.cindy-worktrees/lease-remote-1' });
  });

  it('blocks release while an active Bot Session still uses the lease', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const meta = {
      sessionId: 'session-1',
      name: 'bot-product',
      path: '/repo/product/.cindy-worktrees/bot-product',
      baseRepo: '/repo/product',
      branch: 'cindy/bot-product',
      sourceBranch: 'main',
      createdAt: new Date(0).toISOString(),
    };
    h.worktrees = [meta];
    await prepareBotWorkspaceRuntime(
      {
        id: 'session-1',
        agentKind: 'pi',
        workingDir: '/repo/product',
        workspaceKind: 'project',
        model: 'grok-4.5',
      },
      {
        createId: () => 'lease-1',
        createWorktree: vi.fn(async () => ({ ok: true as const, meta })),
        getWorktreeForSession: (sessionId) =>
          h.worktrees.find((item) => item.sessionId === sessionId) ?? null,
      },
    );

    await expect(
      invoke('local-db:bots:workspace-lease-release', {
        botId: 'bot-1',
        leaseId: 'lease-1',
        expectedGeneration: 1,
      }),
    ).rejects.toThrow('active Bot Session');
    expect(h.removeWorktree).not.toHaveBeenCalled();
  });

  it('releases an unreferenced lease and detaches its historical Sessions', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const meta = {
      sessionId: 'session-1',
      name: 'bot-product',
      path: '/repo/product/.cindy-worktrees/bot-product',
      baseRepo: '/repo/product',
      branch: 'cindy/bot-product',
      sourceBranch: 'main',
      createdAt: new Date(0).toISOString(),
    };
    h.worktrees = [meta];
    await prepareBotWorkspaceRuntime(
      {
        id: 'session-1',
        agentKind: 'pi',
        workingDir: '/repo/product',
        workspaceKind: 'project',
        model: 'grok-4.5',
      },
      {
        createId: () => 'lease-1',
        createWorktree: vi.fn(async () => ({ ok: true as const, meta })),
        getWorktreeForSession: (sessionId) =>
          h.worktrees.find((item) => item.sessionId === sessionId) ?? null,
      },
    );
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = 'session-1'").run();

    const profile = await invoke('local-db:bots:workspace-lease-release', {
      botId: 'bot-1',
      leaseId: 'lease-1',
      expectedGeneration: 1,
    });

    expect(h.removeWorktree).toHaveBeenCalledWith('session-1', expect.any(Object));
    expect(profile.workspaceLeases).toEqual([
      expect.objectContaining({ id: 'lease-1', status: 'released', generation: 1 }),
    ]);
    expect(
      h
        .sqlite!.prepare(
          'SELECT detached_at IS NOT NULL FROM bot_workspace_attachments WHERE lease_id = ?',
        )
        .pluck()
        .get('lease-1'),
    ).toBe(1);
  });

  it('repairs a lost lease anchor from the durable attachment and registered worktree', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const meta = {
      sessionId: 'orphaned-store-owner',
      name: 'bot-product',
      path: '/repo/product/.cindy-worktrees/bot-product',
      baseRepo: '/repo/product',
      branch: 'cindy/bot-product',
      sourceBranch: 'main',
      createdAt: new Date(0).toISOString(),
    };
    h.sqlite!.prepare(
      `INSERT INTO bot_workspace_leases (
        id, bot_id, project_binding_id, lease_key, anchor_session_id, worktree_path,
        base_repo, branch, source_branch, generation, status, created_at, updated_at
      ) SELECT 'lease-1', 'bot-1', id, 'shared', NULL, ?, ?, ?, ?, 1, 'active', 1, 1
        FROM bot_project_bindings WHERE bot_id = 'bot-1'`,
    ).run(meta.path, meta.baseRepo, meta.branch, meta.sourceBranch);
    h.sqlite!.prepare(
      `INSERT INTO bot_workspace_attachments (
        id, lease_id, session_id, generation, access, created_at, detached_at
      ) VALUES ('attachment-1', 'lease-1', 'session-1', 1, 'read-write', 1, NULL)`,
    ).run();
    const setWorktreeForSession = vi.fn(async () => undefined);
    const deleteWorktreeForSession = vi.fn();

    await reconcileBotWorkspaceLeases({
      now: () => 10,
      listWorktrees: () => [meta],
      pathExists: async () => true,
      setWorktreeForSession,
      deleteWorktreeForSession,
    });

    expect(setWorktreeForSession).toHaveBeenCalledWith('session-1', {
      ...meta,
      sessionId: 'session-1',
    });
    expect(deleteWorktreeForSession).toHaveBeenCalledWith('orphaned-store-owner');
    expect(
      h
        .sqlite!.prepare('SELECT anchor_session_id FROM bot_workspace_leases WHERE id = ?')
        .pluck()
        .get('lease-1'),
    ).toBe('session-1');
  });

  it('finishes an interrupted release only when both the store and directory are gone', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      isDefault: true,
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.sqlite!.prepare(
      `INSERT INTO bot_workspace_leases (
        id, bot_id, project_binding_id, lease_key, anchor_session_id, worktree_path,
        base_repo, branch, source_branch, generation, status, created_at, updated_at
      ) SELECT 'lease-1', 'bot-1', id, 'shared', 'session-1', '/gone/worktree',
        '/repo/product', 'cindy/bot-product', 'main', 1, 'releasing', 1, 1
        FROM bot_project_bindings WHERE bot_id = 'bot-1'`,
    ).run();
    h.sqlite!.prepare(
      `INSERT INTO bot_workspace_attachments (
        id, lease_id, session_id, generation, access, created_at, detached_at
      ) VALUES ('attachment-1', 'lease-1', 'session-1', 1, 'read-write', 1, NULL)`,
    ).run();

    await reconcileBotWorkspaceLeases({
      now: () => 10,
      listWorktrees: () => [],
      pathExists: async () => false,
    });

    expect(
      h
        .sqlite!.prepare(
          'SELECT status, released_at AS releasedAt FROM bot_workspace_leases WHERE id = ?',
        )
        .get('lease-1'),
    ).toEqual({ status: 'released', releasedAt: 10 });
    expect(
      h
        .sqlite!.prepare('SELECT detached_at FROM bot_workspace_attachments WHERE id = ?')
        .pluck()
        .get('attachment-1'),
    ).toBe(10);
  });

  it('marks an active lease without a durable worktree path as recoverable error', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      defaultBranch: 'main',
      workspacePolicy: 'reuse',
      isDefault: true,
    });
    h.sqlite!.prepare(
      `INSERT INTO bot_workspace_leases (
        id, bot_id, project_binding_id, lease_key, anchor_session_id, worktree_path,
        base_repo, branch, source_branch, generation, status, created_at, updated_at
      ) SELECT 'lease-missing-path', 'bot-1', id, 'shared', NULL, NULL,
        '/repo/product', NULL, 'main', 1, 'active', 1, 1
        FROM bot_project_bindings WHERE bot_id = 'bot-1'`,
    ).run();

    await reconcileBotWorkspaceLeases({
      now: () => 40,
      listWorktrees: () => [],
      pathExists: async () => false,
    });

    expect(
      h.sqlite!
        .prepare('SELECT status FROM bot_workspace_leases WHERE id = ?')
        .pluck()
        .get('lease-missing-path'),
    ).toBe('error');
  });

  it('rejects local allowed paths outside the bound project', async () => {
    await expect(
      invoke('local-db:bots:project-binding-upsert', {
        botId: 'bot-1',
        workingDir: '/repo/product',
        workspacePolicy: 'none',
        isDefault: true,
        allowedPaths: ['/repo/other'],
      }),
    ).rejects.toThrow('allowedPaths');
  });

  it('rejects remote allowed paths outside the bound project', async () => {
    await expect(
      invoke('local-db:bots:project-binding-upsert', {
        botId: 'bot-1',
        workingDir: '/srv/repos/product',
        remoteHostId: 'remote-1',
        workspacePolicy: 'none',
        isDefault: true,
        allowedPaths: ['/srv/secrets'],
      }),
    ).rejects.toThrow('allowedPaths');
  });

  it('fails closed when a persisted allowed-path snapshot escapes the bound project', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/product',
      workspacePolicy: 'none',
      isDefault: true,
      allowedPaths: ['/repo/product/docs'],
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.sqlite!.prepare(
      "UPDATE bot_project_bindings SET allowed_paths_json = '[\"/repo/other\"]' WHERE bot_id = 'bot-1'",
    ).run();
    const opts = {
      id: 'session-1',
      agentKind: 'pi' as const,
      workingDir: '/tmp/placeholder',
      workspaceKind: 'dialogue' as const,
      model: 'grok-4.5',
      permissionMode: 'ask' as const,
    };

    await expect(prepareBotWorkspaceRuntime(opts)).rejects.toThrow(
      'allowedPaths escaped the bound project',
    );
    expect(opts.workingDir).toBe('/tmp/placeholder');
  });

  it('removes a newly allocated dialogue workspace when Git initialization fails', async () => {
    h.ensureGit.mockRejectedValueOnce(new Error('git init failed'));

    await expect(
      invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1',
        expectedCanonicalSessionId: null,
        expectedProfileVersion: 1,
      }),
    ).rejects.toThrow('git init failed');
    expect(h.remove).toHaveBeenCalledWith('/tmp/cindy-bot-test/session-1', {
      recursive: true,
      force: true,
    });
  });

  it('creates and links the first canonical Session atomically with the Profile version', async () => {
    const result = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    expect(result).toMatchObject({
      created: true,
      canonicalSessionId: 'session-1',
      session: {
        id: 'session-1',
        title: 'Release Bot',
        source: 'bot',
        agentKind: 'pi',
        model: 'grok-4.5',
        permissionMode: 'bypassPermissions',
      },
    });
    expect(
      h
        .sqlite!.prepare('SELECT profile_version FROM bot_session_links WHERE session_id = ?')
        .pluck()
        .get('session-1'),
    ).toBe(1);
  });

  it('returns the winner and removes the unused workspace when a stale create loses the CAS', async () => {
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
    expect(h.remove).toHaveBeenCalledWith('/tmp/cindy-bot-test/session-2', {
      recursive: true,
      force: true,
    });
  });

  it('never removes a user project when a project-backed stale create loses the CAS', async () => {
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/user-project',
      workspacePolicy: 'none',
      isDefault: true,
      allowedPaths: [],
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    h.remove.mockClear();

    const stale = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });

    expect(stale).toMatchObject({ created: false, canonicalSessionId: 'session-1' });
    expect(h.remove).not.toHaveBeenCalled();
  });

  it('archives the previous Bot Session and promotes exactly one replacement on Renew', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const renewed = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: 'session-1',
      expectedProfileVersion: 1,
    });

    expect(renewed).toMatchObject({ created: true, canonicalSessionId: 'session-2' });
    expect(h.sqlite!.prepare('SELECT id, status FROM sessions ORDER BY id').all()).toEqual([
      { id: 'session-1', status: 'archived' },
      { id: 'session-2', status: 'active' },
    ]);
    expect(
      h
        .sqlite!.prepare(
          'SELECT session_id AS sessionId, role FROM bot_session_links ORDER BY session_id',
        )
        .all(),
    ).toEqual([
      { sessionId: 'session-1', role: 'history' },
      { sessionId: 'session-2', role: 'canonical' },
    ]);
    expect(h.closeSession).toHaveBeenCalledWith('session-1');
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
    const archiveSession = vi.fn(async (sessionId: string) => {
      h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(sessionId);
    });
    const closeSession = vi.fn(async () => undefined);
    const broadcastSessionCreated = vi.fn();
    const service = createBotDelegationService({
      dispatch,
      abortSession,
      archiveSession,
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
        budgetTokens: 2_000,
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
      ).toEqual({ botId: 'bot-2', role: 'route', routeKey: 'delegation:delegation-1' });
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
      ).toBe('session-4');
      expect(
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-2'),
      ).toBe('archived');

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
      expect(archiveSession).toHaveBeenCalledWith('session-3');
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

  it('confines Automation collaboration to the frozen target, deadline, depth, and aggregate budget', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    for (const [id, name] of [['bot-2', 'Research Bot'], ['bot-3', 'Unapproved Bot']]) {
      await invoke('local-db:bots:create', {
        id,
        name,
        capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'trusted' },
      });
    }
    const profileVersion = h.sqlite!.prepare(`
      SELECT capabilities_json AS capabilitiesJson, identity_source AS identitySource
      FROM bot_profile_versions WHERE bot_id = 'bot-1' AND version = 1
    `).get() as { capabilitiesJson: string; identitySource: string };
    const targetVersion = h.sqlite!.prepare(`
      SELECT capabilities_json AS capabilitiesJson, identity_source AS identitySource
      FROM bot_profile_versions WHERE bot_id = 'bot-2' AND version = 1
    `).get() as { capabilitiesJson: string; identitySource: string };
    const executionPlan = {
      version: 1,
      createdAt: 1_000,
      deadlineAt: 61_000,
      botId: 'bot-1',
      profile: {
        profileVersion: 1,
        agentKind: 'pi',
        model: 'grok-4.5',
        capabilitiesSha256: testSha256(profileVersion.capabilitiesJson),
        identitySha256: testSha256(profileVersion.identitySource),
        skills: [],
        skillMode: 'inherit',
        mcpServers: [],
        mcpMode: 'inherit',
        toolsets: [],
        toolsetMode: 'inherit',
        memoryEnabled: true,
        automationEnabled: false,
      },
      workspace: null,
      delivery: { targetRouteId: null, ownerGeneration: null },
      limits: { timeoutMs: 60_000, budgetTokens: 100, maxDelegationDepth: 1 },
      delegation: {
        mode: 'allowlist',
        targets: [{
          botId: 'bot-2',
          profileVersion: 1,
          capabilitiesSha256: testSha256(targetVersion.capabilitiesJson),
          identitySha256: testSha256(targetVersion.identitySource),
          defaultWorkspace: null,
        }],
      },
    };
    h.sqlite!.prepare(`
      INSERT INTO bot_automation_links (
        id, bot_id, execution_policy_json, created_with_profile_version,
        status, created_at, updated_at
      ) VALUES ('automation-1', 'bot-1', '{}', 1, 'active', 1000, 1000)
    `).run();
    h.sqlite!.prepare(`
      INSERT INTO bot_automation_runs (
        id, automation_link_id, session_id, profile_version,
        execution_plan_json, status, created_at, updated_at
      ) VALUES ('automation-run-1', 'automation-1', 'session-1', 1, ?, 'running', 1000, 1000)
    `).run(JSON.stringify(executionPlan));

    const abortSession = vi.fn(async () => undefined);
    let nextDelegation = 0;
    const service = createBotDelegationService({
      dispatch: vi.fn(async (params: { targetSessionId: string }) => ({
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: 'queued' as const,
      })),
      abortSession,
      createId: () => `automation-delegation-${++nextDelegation}`,
      now: () => 1_000,
    });
    try {
      await expect(service.listBots('session-1')).resolves.toMatchObject({
        ok: true,
        bots: [{
          id: 'bot-2',
          automationAuthorization: { state: 'allowed', reason: null },
        }],
      });
      await expect(service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-3',
        objective: 'This target was not frozen into the Automation plan.',
      })).resolves.toMatchObject({ ok: false, errorCode: 'AUTOMATION_TARGET_NOT_ALLOWED' });

      h.sqlite!.prepare("UPDATE bot_profiles SET current_version = 2 WHERE id = 'bot-2'").run();
      await expect(service.listBots('session-1')).resolves.toMatchObject({
        ok: true,
        bots: [{
          id: 'bot-2',
          automationAuthorization: {
            state: 'stale',
            reason: expect.stringContaining('Profile'),
          },
        }],
      });
      await expect(service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Do not adopt a changed target Profile.',
      })).resolves.toMatchObject({ ok: false, errorCode: 'AUTOMATION_TARGET_STALE' });
      h.sqlite!.prepare("UPDATE bot_profiles SET current_version = 1 WHERE id = 'bot-2'").run();

      h.sqlite!.prepare('UPDATE sessions SET total_token_usage = 60 WHERE id = ?').run('session-1');
      await expect(service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Do not reserve more than the Automation budget.',
        budgetTokens: 41,
      })).resolves.toMatchObject({ ok: false, errorCode: 'AUTOMATION_BUDGET_EXCEEDED' });
      await expect(service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Use the remaining bounded budget.',
        budgetTokens: 40,
        maxDepth: 5,
        timeoutMs: 120_000,
      })).resolves.toMatchObject({
        ok: true,
        childSessionId: 'session-3',
        depth: 1,
        deadlineAt: 61_000,
      });
      await expect(service.delegateToBot({
        callerSessionId: 'session-3',
        targetBotId: 'bot-3',
        objective: 'A nested Automation delegation must not exceed max depth.',
      })).resolves.toMatchObject({ ok: false, errorCode: 'MAX_DEPTH' });

      h.sqlite!.prepare('UPDATE sessions SET total_token_usage = 50 WHERE id = ?').run('session-3');
      await expect(service.enforceBudgetForSession('session-3', 50)).resolves.toBe(true);
      expect(h.sqlite!.prepare(
        'SELECT status, error_message AS errorMessage FROM bot_automation_runs WHERE id = ?',
      ).get('automation-run-1')).toMatchObject({
        status: 'failed',
        errorMessage: expect.stringContaining('(110/100)'),
      });
      expect(abortSession).toHaveBeenCalledWith('session-1');
    } finally {
      service.dispose();
    }
  });

  it('freezes the target workspace and only accepts references within both Bot project grants', async () => {
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
    });
    for (const botId of ['bot-1', 'bot-2']) {
      await invoke('local-db:bots:project-binding-upsert', {
        botId,
        workingDir: '/repo/shared',
        workspacePolicy: 'none',
        isDefault: true,
        allowedPaths: ['/repo/shared/docs'],
      });
    }
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const service = createBotDelegationService({
      dispatch: vi.fn(async (params: { targetSessionId: string }) => ({
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: 'queued' as const,
      })),
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-frozen-workspace',
      now: () => 4_000,
    });
    try {
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: 'Read the release contract.',
          contextRefs: ['docs/release.md'],
          artifactRefs: ['docs/result.md'],
        }),
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-3' });

      const snapshot = parseBotDelegationPlanSnapshot(
        h
          .sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?')
          .pluck()
          .get('delegation-frozen-workspace') as string,
      );
      expect(snapshot).not.toBeNull();
      expect(snapshot).toMatchObject({
        version: 1,
        targetCanonicalSessionId: 'session-2',
        workspace: {
          workingDir: '/repo/shared',
          workspacePolicy: 'none',
          allowedPaths: ['/repo/shared/docs'],
        },
        access: {
          contextRefs: ['docs/release.md'],
          artifactRefs: ['docs/result.md'],
        },
      });

      h.sqlite!.prepare(
        "UPDATE bot_project_bindings SET working_dir = '/repo/changed', updated_at = 5000 WHERE bot_id = 'bot-2'",
      ).run();
      const opts = {
        id: 'session-3',
        agentKind: 'pi' as const,
        workingDir: '/tmp/placeholder',
        workspaceKind: 'dialogue' as const,
        model: 'grok-4.5',
      };
      await expect(prepareBotWorkspaceRuntime(opts)).resolves.toMatchObject({
        projectBindingId: snapshot!.workspace!.bindingId,
        workingDir: '/repo/shared',
      });
      expect(opts.workingDir).toBe('/repo/shared');
    } finally {
      service.dispose();
    }
  });

  it('rejects traversal, cross-project, and ungranted Bot delegation references', async () => {
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
    });
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-1',
      workingDir: '/repo/shared',
      workspacePolicy: 'none',
      isDefault: true,
      allowedPaths: ['/repo/shared/docs'],
    });
    await invoke('local-db:bots:project-binding-upsert', {
      botId: 'bot-2',
      workingDir: '/repo/shared',
      workspacePolicy: 'none',
      isDefault: true,
      allowedPaths: ['/repo/shared/docs'],
    });
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const service = createBotDelegationService({
      dispatch: vi.fn(async (params: { targetSessionId: string }) => ({
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: 'queued' as const,
      })),
      abortSession: vi.fn(async () => undefined),
    });
    try {
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: 'Escape the project.',
          contextRefs: ['../secret.txt'],
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'INVALID_REFERENCE' });
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: 'Read an ungranted path.',
          contextRefs: ['src/private.ts'],
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'REFERENCE_NOT_ALLOWED' });

      h.sqlite!.prepare(
        "UPDATE bot_project_bindings SET project_key = 'other-project' WHERE bot_id = 'bot-2'",
      ).run();
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: 'Cross projects.',
          contextRefs: ['docs/release.md'],
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'REFERENCE_SCOPE_MISMATCH' });
    } finally {
      service.dispose();
    }
  });

  it('cancels active delegation descendants when the parent Bot task is renewed', async () => {
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

  it('inherits the parent depth and token ceilings for nested Bot delegations', async () => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    for (const [id, name] of [
      ['bot-2', 'Research Bot'],
      ['bot-3', 'Build Bot'],
      ['bot-4', 'Review Bot'],
    ]) {
      await invoke('local-db:bots:create', {
        id,
        name,
        capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
      });
    }
    let id = 0;
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
      createId: () => `nested-${++id}`,
      now: () => 2_500,
    });
    try {
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: 'Own the bounded parent task.',
          maxDepth: 2,
          budgetTokens: 1_000,
        }),
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-3', depth: 1 });

      await expect(
        service.delegateToBot({
          callerSessionId: 'session-3',
          targetBotId: 'bot-3',
          objective: 'Try to exceed the parent budget.',
          maxDepth: 5,
          budgetTokens: 1_001,
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'BUDGET_EXCEEDED' });

      await expect(
        service.delegateToBot({
          callerSessionId: 'session-3',
          targetBotId: 'bot-3',
          objective: 'Use a bounded child budget.',
          maxDepth: 5,
          budgetTokens: 500,
        }),
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-5', depth: 2 });
      expect(
        h
          .sqlite!.prepare('SELECT budget_tokens AS budgetTokens FROM bot_delegations WHERE id = ?')
          .get('nested-2'),
      ).toEqual({ budgetTokens: 500 });

      await expect(
        service.delegateToBot({
          callerSessionId: 'session-5',
          targetBotId: 'bot-4',
          objective: 'Try to raise the inherited max depth.',
          maxDepth: 5,
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'MAX_DEPTH' });
    } finally {
      service.dispose();
    }
  });

  it('durably enqueues a delegation completion instead of requiring the parent task to be online', async () => {
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
    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-1' }));
    const service = createBotDelegationService({
      dispatch,
      enqueueDelivery,
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-1',
      now: () => 3_000,
    });
    try {
      const delegated = await service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Prepare a durable result.',
      });
      expect(delegated).toMatchObject({ ok: true, childSessionId: 'session-3' });
      await service.settleSession({
        childSessionId: 'session-3',
        outcome: 'done',
        resultText: 'Result survives a temporarily unavailable parent.',
      });

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(enqueueDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: 'bot-1',
          sessionId: 'session-1',
          idempotencyKey: 'bot-delegation-completion:delegation-1',
          payload: expect.objectContaining({
            kind: 'session-message',
            targetSessionId: 'session-1',
            fallbackBotId: 'bot-1',
            clientId: 'bot-delegation-completion:delegation-1',
            message: expect.stringContaining('Result survives a temporarily unavailable parent.'),
          }),
        }),
      );
    } finally {
      service.dispose();
    }
  });

  it('exposes delegation completion delivery diagnostics for recovery', async () => {
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
    const outbox = createBotDeliveryOutboxService({
      createId: () => 'outbox-delegation-diagnostic',
      deliver: async (_row, _payload, attempt) => {
        await attempt.recordExternalDispatch({ retrySafe: false, transport: 'local-adapter' });
        await attempt.recordProgress({ textMessageId: 'possibly-sent', sentMediaCount: 1 });
        return {
          ok: false as const,
          retryable: true,
          errorCode: 'CHANNEL_SEND_FAILED',
          message: 'connection lost after dispatch',
        };
      },
      now: () => 3_250,
    });
    const service = createBotDelegationService({
      dispatch: async (params) => {
        await params.onAccepted?.();
        return {
          ok: true as const,
          targetSessionId: params.targetSessionId,
          wakeKind: 'already-active' as const,
        };
      },
      enqueueDelivery: outbox.enqueue,
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-diagnostic',
      now: () => 3_200,
    });
    try {
      const delegated = await service.delegateToBot({
        callerSessionId: 'session-1',
        targetBotId: 'bot-2',
        objective: 'Return a recoverable result.',
      });
      expect(delegated).toMatchObject({ ok: true });
      if (!delegated.ok) throw new Error(delegated.message);
      await service.settleSession({
        childSessionId: delegated.childSessionId,
        outcome: 'done',
        resultText: 'Result with cindy-media://blobs/result.png',
      });
      await outbox.drain();

      const listed = await service.listDelegations('session-1');
      expect(listed).toMatchObject({
        ok: true,
        delegations: [
          {
            id: 'delegation-diagnostic',
            outputArtifacts: [{ ref: 'cindy-media://blobs/result.png', kind: 'image' }],
            completionDelivery: {
              id: 'outbox-delegation-diagnostic',
              status: 'dead-letter',
              attempts: 1,
              diagnostic: {
                retrySafe: false,
                transport: 'local-adapter',
                textMessageId: 'possibly-sent',
                sentMediaCount: 1,
              },
            },
          },
        ],
      });
    } finally {
      service.dispose();
      outbox.dispose();
    }
  });

  it('keeps the parent IM Route on a Bot delegation completion delivery', async () => {
    const route = await upsertBotRoute({
      botId: 'bot-1',
      channelId: 'bot-1:local',
      routeKey: 'telegram:dm:bot-1:user-1',
    });
    const routed = await ensureBotRouteSession({
      routeId: route.id,
      ownerDeviceId: 'device-a',
    });
    await invoke('local-db:bots:create', {
      id: 'bot-2',
      name: 'Research Bot',
      capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
    });
    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-route' }));
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
      enqueueDelivery,
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-route',
      now: () => 3_500,
    });
    try {
      const delegated = await service.delegateToBot({
        callerSessionId: routed.sessionId,
        targetBotId: 'bot-2',
        objective: 'Return this result to the originating IM route.',
      });
      expect(delegated).toMatchObject({ ok: true });
      if (!delegated.ok) throw new Error(delegated.message);
      h.sqlite!.prepare(
        'UPDATE bot_routes SET owner_generation = owner_generation + 1 WHERE id = ?',
      ).run(route.id);
      await service.settleSession({
        childSessionId: delegated.childSessionId,
        outcome: 'done',
        resultText: 'Route-aware result.',
      });

      expect(enqueueDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          botId: 'bot-1',
          channelId: 'bot-1:local',
          routeId: route.id,
          sessionId: routed.sessionId,
          // Completion keeps the generation captured when the delegation was
          // created. The outbox rejects it instead of redirecting the old
          // result to the Route's newly claimed owner.
          ownerGeneration: routed.route.ownerGeneration,
          idempotencyKey: 'bot-delegation-completion:delegation-route',
        }),
      );
    } finally {
      service.dispose();
    }
  });

  it('deduplicates Bot deliveries and retries transient failures until delivered', async () => {
    let currentTime = 4_000;
    let nextId = 0;
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        retryable: true,
        errorCode: 'AGENT_NOT_READY',
        message: 'temporarily offline',
      })
      .mockResolvedValueOnce({
        ok: true as const,
        receipt: { channel: 'telegram', messageId: 'message-42' },
      });
    const service = createBotDeliveryOutboxService({
      deliver,
      now: () => currentTime,
      createId: () => `outbox-${++nextId}`,
    });
    try {
      const input = {
        botId: 'bot-1',
        sessionId: null,
        idempotencyKey: 'delegation-result:1',
        payload: {
          version: 1 as const,
          kind: 'session-message',
          targetSessionId: 'session-1',
          message: 'done',
        },
      };
      const first = await service.enqueue(input);
      const duplicate = await service.enqueue(input);
      expect(duplicate).toEqual(first);

      await service.drain();
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, attempts, next_attempt_at AS nextAttemptAt FROM bot_delivery_outbox WHERE id = ?',
          )
          .get(first.id),
      ).toEqual({ status: 'failed', attempts: 1, nextAttemptAt: 5_000 });

      currentTime = 5_000;
      await service.drain();
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, attempts, delivered_at AS deliveredAt, delivery_receipt_json AS deliveryReceiptJson FROM bot_delivery_outbox WHERE id = ?',
          )
          .get(first.id),
      ).toEqual({
        status: 'delivered',
        attempts: 2,
        deliveredAt: 5_000,
        deliveryReceiptJson: JSON.stringify({ channel: 'telegram', messageId: 'message-42' }),
      });
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(h.sqlite!.prepare('SELECT COUNT(*) FROM bot_delivery_outbox').pluck().get()).toBe(1);
    } finally {
      service.dispose();
    }
  });

  it('keeps multipart progress and the original dispatch time in the final receipt', async () => {
    let currentTime = 5_500;
    const service = createBotDeliveryOutboxService({
      now: () => currentTime,
      createId: () => 'outbox-progress-final',
      deliver: async (_row, _payload, attempt) => {
        await attempt.recordExternalDispatch({ retrySafe: true, transport: 'server-relay' });
        currentTime = 5_700;
        await attempt.recordProgress({ textMessageId: 'text-1', sentMediaCount: 1 });
        return { ok: true, receipt: { channel: 'telegram', messageId: 'media-1' } };
      },
    });
    try {
      await service.enqueue({
        botId: 'bot-1',
        idempotencyKey: 'progress-final',
        payload: { version: 1, kind: 'session-message' },
      });
      await service.drain();
      const row = h.sqlite!.prepare(
        'SELECT delivery_receipt_json AS receipt FROM bot_delivery_outbox WHERE id = ?',
      ).get('outbox-progress-final') as { receipt: string };
      expect(JSON.parse(row.receipt)).toEqual({
        externalDispatch: { retrySafe: true, transport: 'server-relay', startedAt: 5_500 },
        progress: { textMessageId: 'text-1', sentMediaCount: 1 },
        channel: 'telegram',
        messageId: 'media-1',
      });
    } finally {
      service.dispose();
    }
  });

  it('recovers a stale sending Bot delivery after a host restart', async () => {
    h.sqlite!.prepare(
      `
      INSERT INTO bot_delivery_outbox (
        id, bot_id, session_id, idempotency_key, payload_ref_json,
        owner_generation, status, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 'sending', 1, NULL, ?, ?)
    `,
    ).run(
      'outbox-stale',
      'bot-1',
      null,
      'stale-delivery',
      JSON.stringify({
        version: 1,
        kind: 'session-message',
        targetSessionId: 'session-1',
        message: 'recover me',
      }),
      1_000,
      1_000,
    );
    const deliver = vi.fn(async () => ({ ok: true as const }));
    const service = createBotDeliveryOutboxService({
      deliver,
      now: () => 70_000,
      sendingLeaseMs: 60_000,
    });
    try {
      await service.restore();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(
        h
          .sqlite!.prepare('SELECT status, attempts FROM bot_delivery_outbox WHERE id = ?')
          .get('outbox-stale'),
      ).toEqual({ status: 'delivered', attempts: 2 });
    } finally {
      service.dispose();
    }
  });

  it('does not replay a stale local-adapter delivery whose provider outcome is unknown', async () => {
    h.sqlite!.prepare(
      `
      INSERT INTO bot_delivery_outbox (
        id, bot_id, session_id, idempotency_key, payload_ref_json,
        owner_generation, status, attempts, next_attempt_at, delivery_receipt_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 0, 'sending', 1, NULL, ?, ?, ?)
    `,
    ).run(
      'outbox-local-ambiguous',
      'bot-1',
      null,
      'local-ambiguous',
      JSON.stringify({
        version: 1,
        kind: 'session-message',
        targetSessionId: 'session-1',
        message: 'do not duplicate me',
      }),
      JSON.stringify({
        externalDispatch: {
          retrySafe: false,
          transport: 'local-adapter',
          startedAt: 1_000,
        },
      }),
      1_000,
      1_000,
    );
    const deliver = vi.fn(async () => ({ ok: true as const }));
    const service = createBotDeliveryOutboxService({
      deliver,
      now: () => 70_000,
      sendingLeaseMs: 60_000,
    });
    try {
      await service.restore();
      expect(deliver).not.toHaveBeenCalled();
      expect(
        h.sqlite!.prepare(
          'SELECT status, attempts, last_error AS lastError FROM bot_delivery_outbox WHERE id = ?',
        ).get('outbox-local-ambiguous'),
      ).toEqual({
        status: 'dead-letter',
        attempts: 1,
        lastError:
          'DELIVERY_OUTCOME_UNKNOWN: local adapter may have delivered before the host stopped; automatic retry was suppressed to prevent a duplicate',
      });
    } finally {
      service.dispose();
    }
  });

  it('records an unknown local Bot final directly as a dead-letter recovery item', async () => {
    const deliver = vi.fn(async () => ({ ok: true as const }));
    const releaseResources = vi.fn(async () => undefined);
    const service = createBotDeliveryOutboxService({
      deliver,
      releaseResources,
      now: () => 71_000,
      createId: () => 'outbox-recorded-unknown',
    });
    try {
      const recorded = await service.recordUnknown({
        botId: 'bot-1',
        idempotencyKey: 'recorded-unknown',
        payload: {
          version: 1,
          kind: 'channel-final-recovery',
          text: 'possibly delivered final',
          mediaRefs: [`cindy-media://blobs/${'a'.repeat(64)}.png`],
        },
        errorCode: 'TELEGRAM_FINAL_UNCONFIRMED',
        message: 'content may already be delivered',
        transport: 'local-adapter',
        progress: { firstChunkConfirmed: false, unconfirmedChunks: [0] },
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(
        h.sqlite!.prepare(`
          SELECT status, attempts, payload_ref_json AS payloadRefJson, last_error AS lastError,
            delivery_receipt_json AS deliveryReceiptJson
          FROM bot_delivery_outbox WHERE id = ?
        `).get(recorded.id),
      ).toEqual({
        status: 'dead-letter',
        attempts: 1,
        payloadRefJson: JSON.stringify({
          version: 1,
          kind: 'channel-final-recovery',
          text: 'possibly delivered final',
          mediaRefs: [`cindy-media://blobs/${'a'.repeat(64)}.png`],
        }),
        lastError: 'TELEGRAM_FINAL_UNCONFIRMED: content may already be delivered',
        deliveryReceiptJson: JSON.stringify({
          externalDispatch: {
            retrySafe: false,
            transport: 'local-adapter',
            startedAt: 71_000,
          },
          progress: { firstChunkConfirmed: false, unconfirmedChunks: [0] },
        }),
      });
      await expect(service.retry(recorded.id, 'bot-1')).rejects.toThrow(
        'explicit duplicate-risk confirmation is required',
      );
      await expect(
        service.retry(recorded.id, 'bot-1', { allowDuplicateRisk: true }),
      ).resolves.toEqual({ id: recorded.id });
      await service.drain();
      expect(releaseResources).toHaveBeenCalledWith(
        {
          id: recorded.id,
          botId: 'bot-1',
          idempotencyKey: 'recorded-unknown',
        },
        {
          version: 1,
          kind: 'channel-final-recovery',
          text: 'possibly delivered final',
          mediaRefs: [`cindy-media://blobs/${'a'.repeat(64)}.png`],
        },
      );
    } finally {
      service.dispose();
    }
  });

  it('suppresses automatic retry when a local adapter fails after dispatch starts', async () => {
    let currentTime = 12_000;
    const deliver = vi.fn(async (_row, _payload, attempt) => {
      await attempt.recordExternalDispatch({ retrySafe: false, transport: 'local-adapter' });
      return {
        ok: false as const,
        retryable: true,
        errorCode: 'CHANNEL_SEND_FAILED',
        message: 'connection closed before acknowledgement',
      };
    });
    const service = createBotDeliveryOutboxService({
      deliver,
      now: () => currentTime,
      createId: () => 'outbox-local-failure',
    });
    try {
      const queued = await service.enqueue({
        botId: 'bot-1',
        idempotencyKey: 'local-failure',
        payload: {
          version: 1,
          kind: 'session-message',
          targetSessionId: 'session-1',
          message: 'possibly delivered',
        },
      });
      await service.drain();
      expect(
        h.sqlite!.prepare(
          'SELECT status, attempts, next_attempt_at AS nextAttemptAt, last_error AS lastError FROM bot_delivery_outbox WHERE id = ?',
        ).get(queued.id),
      ).toEqual({
        status: 'dead-letter',
        attempts: 1,
        nextAttemptAt: null,
        lastError:
          'DELIVERY_OUTCOME_UNKNOWN: CHANNEL_SEND_FAILED: connection closed before acknowledgement; local adapter may already have delivered, so automatic retry was suppressed',
      });
      currentTime += 60_000;
      await service.drain();
      expect(deliver).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
    }
  });

  it('persists multipart delivery progress before a local adapter failure', async () => {
    const deliver = vi.fn(async (_row, _payload, attempt) => {
      await attempt.recordExternalDispatch({ retrySafe: false, transport: 'local-adapter' });
      await attempt.recordProgress({ textMessageId: 'text-1', sentMediaCount: 1 });
      return {
        ok: false as const,
        retryable: true,
        errorCode: 'CHANNEL_MEDIA_SEND_FAILED',
        message: 'second attachment failed',
      };
    });
    const service = createBotDeliveryOutboxService({
      deliver,
      now: () => 15_000,
      createId: () => 'outbox-multipart-progress',
    });
    try {
      const queued = await service.enqueue({
        botId: 'bot-1',
        idempotencyKey: 'multipart-progress',
        payload: {
          version: 1,
          kind: 'session-message',
          targetSessionId: 'session-1',
          message: 'result with attachments',
        },
      });
      await service.drain();
      const row = h.sqlite!.prepare(
        'SELECT status, delivery_receipt_json AS receipt FROM bot_delivery_outbox WHERE id = ?',
      ).get(queued.id) as { status: string; receipt: string };
      expect(row.status).toBe('dead-letter');
      expect(JSON.parse(row.receipt)).toMatchObject({
        externalDispatch: { retrySafe: false, transport: 'local-adapter' },
        progress: { textMessageId: 'text-1', sentMediaCount: 1 },
      });
      await expect(service.retry(queued.id, 'bot-1')).rejects.toThrow(
        'explicit duplicate-risk confirmation is required',
      );
      await expect(
        service.retry(queued.id, 'bot-1', { allowDuplicateRisk: true }),
      ).resolves.toEqual({ id: queued.id });
    } finally {
      service.dispose();
    }
  });

  it('lists Bot deliveries without exposing payload content and includes recovery diagnostics', async () => {
    const service = createBotDeliveryOutboxService({
      deliver: async (_row, _payload, attempt) => {
        await attempt.recordExternalDispatch({ retrySafe: false, transport: 'local-adapter' });
        await attempt.recordProgress({ textMessageId: 'text-visible', sentMediaCount: 2 });
        return {
          ok: false as const,
          retryable: true,
          errorCode: 'CHANNEL_MEDIA_SEND_FAILED',
          message: 'last attachment failed',
        };
      },
      now: () => 16_000,
      createId: () => 'outbox-list-diagnostic',
    });
    try {
      await service.enqueue({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        idempotencyKey: 'list-diagnostic',
        payload: {
          version: 1,
          kind: 'session-message',
          message: 'private result must not be returned by the listing API',
        },
      });
      await service.drain();
      const listed = await service.listForBot('bot-1', 10);
      expect(listed).toContainEqual(expect.objectContaining({
        id: 'outbox-list-diagnostic',
        channelKind: 'local',
        payloadKind: 'session-message',
        status: 'dead-letter',
        diagnostic: expect.objectContaining({
          retrySafe: false,
          transport: 'local-adapter',
          textMessageId: 'text-visible',
          sentMediaCount: 2,
        }),
      }));
      expect(JSON.stringify(listed)).not.toContain('private result');
    } finally {
      service.dispose();
    }
  });

  it('manually retries a dead-letter delivery from a fresh attempt budget', async () => {
    let currentTime = 8_000;
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        retryable: false,
        errorCode: 'REMOTE_REJECTED',
        message: 'temporary account issue',
      })
      .mockResolvedValueOnce({ ok: true as const });
    const service = createBotDeliveryOutboxService({
      deliver,
      now: () => currentTime,
      createId: () => 'outbox-manual-retry',
    });
    try {
      const queued = await service.enqueue({
        botId: 'bot-1',
        idempotencyKey: 'manual-retry',
        payload: {
          version: 1,
          kind: 'session-message',
          targetSessionId: 'session-1',
          message: 'deliver me',
        },
      });
      await service.drain();
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, attempts, last_error AS lastError FROM bot_delivery_outbox WHERE id = ?',
          )
          .get(queued.id),
      ).toEqual({
        status: 'dead-letter',
        attempts: 1,
        lastError: 'REMOTE_REJECTED: temporary account issue',
      });

      currentTime = 9_000;
      await service.retry(queued.id, 'bot-1');
      await service.drain();
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, attempts, last_error AS lastError FROM bot_delivery_outbox WHERE id = ?',
          )
          .get(queued.id),
      ).toEqual({ status: 'delivered', attempts: 1, lastError: null });
      expect(deliver).toHaveBeenCalledTimes(2);
    } finally {
      service.dispose();
    }
  });

  it('does not manually retry a delivery while its Bot is paused', async () => {
    const service = createBotDeliveryOutboxService({
      deliver: vi.fn(async () => ({
        ok: false as const,
        retryable: false,
        errorCode: 'REMOTE_REJECTED',
        message: 'retry manually',
      })),
      createId: () => 'outbox-paused-bot-retry',
    });
    try {
      const queued = await service.enqueue({
        botId: 'bot-1',
        idempotencyKey: 'paused-bot-manual-retry',
        payload: { version: 1, kind: 'channel-message', text: 'do not deliver' },
      });
      await service.drain();
      h.sqlite!.prepare("UPDATE bot_profiles SET status = 'paused' WHERE id = 'bot-1'").run();

      await expect(service.retry(queued.id, 'bot-1')).rejects.toThrow(
        'Restore the Bot before retrying this delivery',
      );
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delivery_outbox WHERE id = ?').pluck().get(queued.id),
      ).toBe('dead-letter');
    } finally {
      service.dispose();
    }
  });

  it('does not manually retry a delivery after its Route switched tasks', async () => {
    const route = await upsertBotRoute({
      botId: 'bot-1',
      channelId: 'bot-1:local',
      routeKey: 'telegram:dm:bot-1:retry-task',
    });
    const routed = await ensureBotRouteSession({ routeId: route.id, ownerDeviceId: 'device-a' });
    const service = createBotDeliveryOutboxService({
      deliver: vi.fn(async () => ({
        ok: false as const,
        retryable: false,
        errorCode: 'REMOTE_REJECTED',
        message: 'retry manually',
      })),
      createId: () => 'outbox-stale-route-task',
    });
    try {
      const queued = await service.enqueue({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeId: route.id,
        sessionId: routed.sessionId,
        ownerGeneration: routed.route.ownerGeneration,
        idempotencyKey: 'stale-route-task',
        payload: { version: 1, kind: 'channel-message', text: 'do not deliver' },
      });
      await service.drain();
      h.sqlite!.prepare('UPDATE bot_routes SET current_session_id = NULL WHERE id = ?').run(route.id);

      await expect(service.retry(queued.id, 'bot-1')).rejects.toThrow(
        'Bot delivery route now points to a different task',
      );
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delivery_outbox WHERE id = ?').pluck().get(queued.id),
      ).toBe('dead-letter');
    } finally {
      service.dispose();
    }
  });

  it('does not manually retry through a changed Route owner generation', async () => {
    h.sqlite!.prepare(
      `
      INSERT INTO bot_routes (
        id, bot_id, channel_id, route_key, principal_key, scope_key,
        owner_generation, status, created_at, updated_at
      ) VALUES ('route-retry-owner', 'bot-1', 'bot-1:local', 'retry-owner',
        'local-user', 'local-scope', 1, 'active', 1, 1)
    `,
    ).run();
    const service = createBotDeliveryOutboxService({
      deliver: vi.fn(async () => ({
        ok: false as const,
        retryable: false,
        errorCode: 'REMOTE_REJECTED',
        message: 'retry manually',
      })),
      createId: () => 'outbox-stale-manual-retry',
    });
    try {
      const queued = await service.enqueue({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeId: 'route-retry-owner',
        ownerGeneration: 1,
        idempotencyKey: 'stale-manual-retry',
        payload: { version: 1, kind: 'channel-message', text: 'do not leak' },
      });
      await service.drain();
      h.sqlite!.prepare(
        "UPDATE bot_routes SET owner_generation = 2 WHERE id = 'route-retry-owner'",
      ).run();

      await expect(service.retry(queued.id, 'bot-1')).rejects.toThrow('route ownership changed');
      expect(
        h
          .sqlite!.prepare('SELECT status FROM bot_delivery_outbox WHERE id = ?')
          .pluck()
          .get(queued.id),
      ).toBe('dead-letter');
    } finally {
      service.dispose();
    }
  });

  it('retries an offline route but cancels a stale route-owner generation', async () => {
    h.sqlite!.prepare(
      `
      INSERT INTO bot_routes (
        id, bot_id, channel_id, route_key, principal_key, scope_key,
        owner_generation, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      'route-1',
      'bot-1',
      'bot-1:local',
      'local:test',
      'local-user',
      'local-scope',
      1,
      'offline',
      1_000,
      1_000,
    );
    let currentTime = 10_000;
    let nextId = 0;
    const deliver = vi.fn(async () => ({ ok: true as const }));
    const service = createBotDeliveryOutboxService({
      deliver,
      now: () => currentTime,
      createId: () => `route-outbox-${++nextId}`,
    });
    try {
      const retryable = await service.enqueue({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeId: 'route-1',
        ownerGeneration: 1,
        idempotencyKey: 'route-retry',
        payload: { version: 1, kind: 'channel-message', text: 'retry later' },
      });
      await service.drain();
      expect(deliver).not.toHaveBeenCalled();
      expect(
        h
          .sqlite!.prepare('SELECT status, attempts FROM bot_delivery_outbox WHERE id = ?')
          .get(retryable.id),
      ).toEqual({ status: 'failed', attempts: 1 });

      h.sqlite!.prepare("UPDATE bot_routes SET status = 'active' WHERE id = 'route-1'").run();
      currentTime = 11_000;
      await service.drain();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(
        h
          .sqlite!.prepare('SELECT status FROM bot_delivery_outbox WHERE id = ?')
          .pluck()
          .get(retryable.id),
      ).toBe('delivered');

      const stale = await service.enqueue({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeId: 'route-1',
        ownerGeneration: 1,
        idempotencyKey: 'route-stale',
        payload: { version: 1, kind: 'channel-message', text: 'must not leak' },
      });
      h.sqlite!.prepare("UPDATE bot_routes SET owner_generation = 2 WHERE id = 'route-1'").run();
      await service.drain();
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(
        h
          .sqlite!.prepare(
            'SELECT status, last_error AS lastError FROM bot_delivery_outbox WHERE id = ?',
          )
          .get(stale.id),
      ).toEqual({
        status: 'cancelled',
        lastError: 'STALE_ROUTE_OWNER: expected generation 1, current 2',
      });
    } finally {
      service.dispose();
    }
  });

  it('restores a waiting delegation and recreates a missing completion delivery', async () => {
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
      dispatch: vi.fn(async (params: { targetSessionId: string }) => ({
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: 'queued' as const,
      })),
      abortSession: vi.fn(async () => undefined),
      createId: () => 'delegation-restore',
      now: () => 20_000,
    });
    try {
      await expect(
        first.delegateToBot({
          callerSessionId: 'session-1',
          targetBotId: 'bot-2',
          objective: 'Resume after restart.',
        }),
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-3' });
    } finally {
      first.dispose();
    }
    h.sqlite!.prepare(
      "UPDATE bot_delegations SET status = 'waiting' WHERE id = 'delegation-restore'",
    ).run();

    const dispatch = vi.fn(
      async (params: {
        targetSessionId: string;
        clientId?: string;
        onAccepted?: () => Promise<void> | void;
      }) => {
        await params.onAccepted?.();
        return {
          ok: true as const,
          targetSessionId: params.targetSessionId,
          wakeKind: 'already-active' as const,
        };
      },
    );
    const enqueueDelivery = vi.fn(async () => ({ id: 'outbox-restored' }));
    const restored = createBotDelegationService({
      dispatch,
      enqueueDelivery,
      abortSession: vi.fn(async () => undefined),
      now: () => 21_000,
    });
    try {
      await restored.restore();
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          targetSessionId: 'session-3',
          clientId: 'bot-delegation-start:delegation-restore',
        }),
      );
      expect(
        h
          .sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?')
          .pluck()
          .get('delegation-restore'),
      ).toBe('running');

      h.sqlite!.prepare(
        `
        UPDATE bot_delegations
        SET status = 'completed', result_summary = ?, completed_at = ?, updated_at = ?
        WHERE id = ?
      `,
      ).run('Recovered result.', 22_000, 22_000, 'delegation-restore');
      await restored.restore();
      expect(enqueueDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: 'bot-delegation-completion:delegation-restore',
          payload: expect.objectContaining({
            message: expect.stringContaining('Recovered result.'),
          }),
        }),
      );
      expect(
        h.sqlite!.prepare(`SELECT role, content FROM messages
          WHERE session_id = 'session-2' AND client_id = ?`).get(
          'bot-delegation-target-result:delegation-restore',
        ),
      ).toEqual({ role: 'assistant', content: '' });
      await restored.restore();
      expect(
        h.sqlite!.prepare(`SELECT count(*) FROM messages
          WHERE session_id = 'session-2' AND client_id = ?`).pluck().get(
          'bot-delegation-target-result:delegation-restore',
        ),
      ).toBe(1);
    } finally {
      restored.dispose();
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
      ).toBe('timed-out');
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

  describe('Bot Route database lifecycle', () => {
    it('keeps Channel, project binding, and task ownership inside one Bot', async () => {
      await invoke('local-db:bots:create', {
        id: 'bot-2',
        name: 'Research Bot',
        capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
      });
      const bot2 = await invoke('local-db:bots:project-binding-upsert', {
        botId: 'bot-2',
        workingDir: '/repo/research',
        workspacePolicy: 'reuse',
        isDefault: true,
      });

      await expect(
        upsertBotRoute({
          botId: 'bot-1',
          channelId: 'bot-2:local',
          routeKey: 'wrong-channel',
        }),
      ).rejects.toThrow('Bot Channel does not exist');
      await expect(
        upsertBotRoute({
          botId: 'bot-1',
          channelId: 'bot-1:local',
          routeKey: 'wrong-project',
          projectBindingId: bot2.projectBindings[0].id,
        }),
      ).rejects.toThrow('Bot Project binding is unavailable');

      const route = await upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeKey: 'owned-route',
      });
      await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-2',
        expectedCanonicalSessionId: null,
        expectedProfileVersion: 1,
      });
      await expect(
        claimBotRoute({
          routeId: route.id,
          ownerDeviceId: 'device-a',
          currentSessionId: 'session-1',
        }),
      ).rejects.toThrow('Bot task is unavailable');
    });

    it('does not claim paused or archived Routes and prevents device stealing', async () => {
      const route = await upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeKey: 'claim-guard',
      });
      await setBotRouteStatus(route.id, 'paused');
      await expect(
        claimBotRoute({
          routeId: route.id,
          ownerDeviceId: 'device-a',
        }),
      ).rejects.toThrow('Bot Route is paused');

      await setBotRouteStatus(route.id, 'offline');
      const claimed = await claimBotRoute({
        routeId: route.id,
        ownerDeviceId: 'device-a',
      });
      expect(claimed).toMatchObject({
        status: 'active',
        ownerDeviceId: 'device-a',
        ownerGeneration: 3,
      });
      await expect(
        claimBotRoute({
          routeId: route.id,
          ownerDeviceId: 'device-b',
        }),
      ).rejects.toThrow('Bot Route is owned by another device');

      await setBotRouteStatus(route.id, 'archived');
      await expect(
        claimBotRoute({
          routeId: route.id,
          ownerDeviceId: 'device-a',
        }),
      ).rejects.toThrow('Bot Route is archived');
    });

    it('rejects stale owner generations when a Route changes state', async () => {
      const route = await upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeKey: 'generation-cas',
      });
      const first = await ensureBotRouteSession({
        routeId: route.id,
        ownerDeviceId: 'device-a',
      });
      await setBotRouteStatus(route.id, 'recovering');

      await expect(
        updateBotRouteSession({
          routeId: route.id,
          ownerDeviceId: 'device-a',
          ownerGeneration: first.route.ownerGeneration,
          currentSessionId: first.sessionId,
        }),
      ).rejects.toThrow('Bot Route ownership is stale');
    });

    it('creates on the first offline message, reuses while active, and archives on Renew', async () => {
      const route = await upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeKey: 'lifecycle',
      });
      expect(route.status).toBe('offline');

      const first = await ensureBotRouteSession({
        routeId: route.id,
        ownerDeviceId: 'device-a',
      });
      expect(first).toMatchObject({ sessionId: 'session-1', created: true });

      const reused = await ensureBotRouteSession({
        routeId: route.id,
        ownerDeviceId: 'device-a',
      });
      expect(reused).toMatchObject({ sessionId: 'session-1', created: false });

      const renewed = await ensureBotRouteSession({
        routeId: route.id,
        ownerDeviceId: 'device-a',
        forceRenew: true,
      });
      expect(renewed).toMatchObject({ sessionId: 'session-2', created: true });
      expect(renewed.route.ownerGeneration).toBe(first.route.ownerGeneration + 1);
      expect(
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-1'),
      ).toBe('archived');
      expect(
        h
          .sqlite!.prepare('SELECT role FROM bot_session_links WHERE session_id = ?')
          .pluck()
          .get('session-1'),
      ).toBe('history');
      expect(
        h
          .sqlite!.prepare('SELECT current_session_id FROM bot_routes WHERE id = ?')
          .pluck()
          .get(route.id),
      ).toBe('session-2');
      expect(
        h
          .sqlite!.prepare('SELECT event_type FROM bot_lifecycle_events WHERE session_id = ?')
          .pluck()
          .get('session-2'),
      ).toBe('route-session-renewed');
      expect(h.closeSession).toHaveBeenCalledWith('session-1');
    });

    it('does not replace a Route task when the shared runtime guard reports it busy', async () => {
      const route = await upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeKey: 'busy-renew',
      });
      const first = await ensureBotRouteSession({
        routeId: route.id,
        ownerDeviceId: 'device-a',
      });
      configureBotCanonicalReplacementCoordinator(async (sessionId, operation) => {
        if (sessionId === first.sessionId) {
          throw Object.assign(new Error('Bot task is busy'), { code: 'SESSION_RUNNING' });
        }
        return operation();
      });

      await expect(
        ensureBotRouteSession({
          routeId: route.id,
          ownerDeviceId: 'device-a',
          forceRenew: true,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_RUNNING' });
      expect(
        h.sqlite!.prepare('SELECT current_session_id FROM bot_routes WHERE id = ?').pluck().get(route.id),
      ).toBe(first.sessionId);
      expect(
        h.sqlite!.prepare('SELECT COUNT(*) FROM sessions').pluck().get(),
      ).toBe(1);
      expect(h.closeSession).not.toHaveBeenCalled();
    });

    it('allows only one replacement when duplicate Route renews race', async () => {
      const route = await upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeKey: 'renew-race',
      });
      const first = await ensureBotRouteSession({
        routeId: route.id,
        ownerDeviceId: 'device-a',
      });
      let entered = 0;
      let release!: () => void;
      const bothEntered = new Promise<void>((resolve) => {
        release = resolve;
      });
      configureBotCanonicalReplacementCoordinator(async (_sessionId, operation) => {
        entered += 1;
        if (entered === 2) release();
        else await bothEntered;
        return operation();
      });

      const results = await Promise.allSettled([
        ensureBotRouteSession({ routeId: route.id, ownerDeviceId: 'device-a', forceRenew: true }),
        ensureBotRouteSession({ routeId: route.id, ownerDeviceId: 'device-a', forceRenew: true }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(
        h.sqlite!.prepare('SELECT COUNT(*) FROM sessions').pluck().get(),
      ).toBe(2);
      expect(
        h.sqlite!.prepare('SELECT owner_generation FROM bot_routes WHERE id = ?').pluck().get(route.id),
      ).toBe(first.route.ownerGeneration + 1);
    });

    it('freezes the same provider and model configuration into each Route Session', async () => {
      await invoke('local-db:bots:create', {
        id: 'bot-route-model-profile',
        name: 'Route Model Bot',
        capabilities: {
          harness: 'pi',
          providerId: 'xai',
          model: 'grok-4.5',
          effort: 'max',
          fastMode: true,
          permissions: 'ask',
        },
      });
      const route = await upsertBotRoute({
        botId: 'bot-route-model-profile',
        channelId: 'bot-route-model-profile:local',
        routeKey: 'model-freeze',
      });

      const created = await ensureBotRouteSession({
        routeId: route.id,
        ownerDeviceId: 'device-a',
      });

      expect(
        h.sqlite!.prepare(`
          SELECT model, provider_id AS providerId, effort,
                 fast_mode AS fastMode, agent_kind AS agentKind
          FROM sessions WHERE id = ?
        `).get(created.sessionId),
      ).toEqual({
        model: 'grok-4.5',
        providerId: 'xai',
        effort: 'max',
        fastMode: 1,
        agentKind: 'pi',
      });
    });

    it('repairs a foreign task pointer without archiving the other Bot task', async () => {
      await invoke('local-db:bots:create', {
        id: 'bot-2',
        name: 'Research Bot',
        capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
      });
      await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-2',
        expectedCanonicalSessionId: null,
        expectedProfileVersion: 1,
      });
      const route = await upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeKey: 'corrupt-pointer',
      });
      h.sqlite!.prepare('UPDATE bot_routes SET current_session_id = ? WHERE id = ?').run(
        'session-1',
        route.id,
      );

      const repaired = await ensureBotRouteSession({
        routeId: route.id,
        ownerDeviceId: 'device-a',
      });
      expect(repaired).toMatchObject({ sessionId: 'session-2', created: true });
      expect(
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-1'),
      ).toBe('active');
      expect(
        h
          .sqlite!.prepare('SELECT role FROM bot_session_links WHERE session_id = ?')
          .pluck()
          .get('session-1'),
      ).toBe('canonical');
    });

    it('removes an unused dialogue workspace when the write transaction fails', async () => {
      const route = await upsertBotRoute({
        botId: 'bot-1',
        channelId: 'bot-1:local',
        routeKey: 'transaction-cleanup',
      });
      const baseTx = h.tx;
      h.tx = async () => {
        throw new Error('simulated transaction failure');
      };
      try {
        await expect(
          ensureBotRouteSession({
            routeId: route.id,
            ownerDeviceId: 'device-a',
          }),
        ).rejects.toThrow('simulated transaction failure');
        expect(h.remove).toHaveBeenCalledWith('/tmp/cindy-bot-test/session-1', {
          recursive: true,
          force: true,
        });
      } finally {
        h.tx = baseTx;
      }
    });

    it('resolves only the concrete IM account bound to a Channel', async () => {
      await invoke('local-db:bots:create', {
        id: 'bot-2',
        name: 'Research Bot',
        capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
      });
      await invoke('local-db:bots:channel-upsert', {
        botId: 'bot-1',
        kind: 'telegram',
        enabled: true,
        config: { accountKey: 'telegram-account-a', ownership: 'local-adapter' },
      });
      await invoke('local-db:bots:channel-upsert', {
        botId: 'bot-2',
        kind: 'telegram',
        enabled: true,
        config: { accountKey: 'telegram-account-b', ownership: 'local-adapter' },
      });

      await expect(
        resolveOrCreateBotRoute({
          platform: 'telegram',
          accountKey: 'telegram-account-a',
          principalKey: '-1001',
        }),
      ).resolves.toMatchObject({ botId: 'bot-1' });
      await expect(
        resolveOrCreateBotRoute({
          platform: 'telegram',
          accountKey: 'telegram-account-b',
          principalKey: '-1001',
        }),
      ).resolves.toMatchObject({ botId: 'bot-2' });
      await expect(
        resolveBotRoute({
          platform: 'telegram',
          accountKey: 'telegram-account-c',
          principalKey: '-1001',
        }),
      ).resolves.toBeNull();
    });

    it('rejects mounting the same concrete IM account on two Bots', async () => {
      await invoke('local-db:bots:create', {
        id: 'bot-2',
        name: 'Research Bot',
        capabilities: { harness: 'pi', model: 'grok-4.5', permissions: 'ask' },
      });
      const config = { accountKey: 'telegram-account-a', ownership: 'local-adapter' };
      await invoke('local-db:bots:channel-upsert', {
        botId: 'bot-1',
        kind: 'telegram',
        enabled: true,
        config,
      });

      await expect(
        invoke('local-db:bots:channel-upsert', {
          botId: 'bot-2',
          kind: 'telegram',
          enabled: true,
          config,
        }),
      ).rejects.toThrow('这个 IM 账号已挂载到另一个 Bot');
    });
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

  it('never counts the user own sends, rewound rows, or hidden auto-resume prompts', async () => {
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
      role: 'tool_use',
      content: { name: 'Bash', input: {} },
      createdAt: 5_000,
    });

    expect(await unreadFor('bot-1', { 'bot-1': 1_000 })).toBe(0);

    insertMessage(sessionId, {
      id: 'm5',
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
});

describe('Bot teammate collaboration', () => {
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
    const markTimelineMessage = vi.fn(async () => undefined);
    let clock = 10_000;
    let ids = 0;
    const service = createBotDelegationService({
      dispatch,
      abortSession: vi.fn(async () => undefined),
      archiveSession: vi.fn(async (sessionId: string) => {
        h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(sessionId);
      }),
      closeSession: vi.fn(async () => undefined),
      broadcastSessionCreated: vi.fn(),
      markTimelineMessage,
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
      // 结果回传落到发起方任务后被标成客座气泡。
      expect(markTimelineMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'session-1',
          clientId: `bot-delegation-completion:${firstId}`,
          agentMeta: expect.objectContaining({
            botCollaboration: expect.objectContaining({
              role: 'guest-result',
              toBotId: 'bot-planner',
              childSessionId: firstChild,
            }),
          }),
        }),
      );
      // 回传正文的机读格式必须能被客座气泡的取文助手认出来，否则用户会在气泡里
      // 看到一整段方括号协议文本。
      const completion = dispatch.mock.calls
        .map(([params]) => params as unknown as { message: string; clientId?: string })
        .find((params) => params.clientId === `bot-delegation-completion:${firstId}`);
      expect(readBotDelegationCompletionBody(completion!.message)).toEqual({
        text: '方案定三条：先对齐、再做卡、最后接插话。',
        error: null,
      });

      // 终态后不再接受插话。
      await expect(
        service.interjectDelegation('session-1', firstId, '再改一版'),
      ).resolves.toMatchObject({ ok: false, errorCode: 'ALREADY_TERMINAL' });

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
      ).toContain('先对齐、再做卡、最后接插话');
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
      archiveSession: vi.fn(async (sessionId: string) => {
        h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(sessionId);
      }),
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
      enqueueDelivery: (params) => outbox.enqueue(params),
      abortSession: vi.fn(async () => undefined),
      archiveSession: async (sessionId: string) => {
        h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(sessionId);
      },
      closeSession: vi.fn(async () => undefined),
      broadcastSessionCreated: vi.fn(),
      onChanged: (payload) => {
        changed.push({ delegationId: payload.delegationId, status: payload.status });
      },
      now: () => currentTime,
      createId: () => `delegation-${++seq}`,
    });

    const outbox = createBotDeliveryOutboxService({
      // register.ts 的 session-message 分支：投递就是再走一次同一条主机通路。
      deliver: async (_row, payload) => {
        if (payload.kind !== 'session-message') {
          return {
            ok: false as const,
            retryable: false,
            errorCode: 'UNSUPPORTED_DELIVERY_KIND',
            message: String(payload.kind),
          };
        }
        const result = await dispatch({
          targetSessionId: String(payload.targetSessionId),
          message: String(payload.message),
          persistedContent: String(payload.persistedContent ?? payload.message),
          clientId: String(payload.clientId),
        });
        return result.ok
          ? { ok: true as const }
          : {
              ok: false as const,
              retryable: true,
              errorCode: result.errorCode,
              message: result.message,
            };
      },
      now: () => currentTime,
      createId: () => `outbox-${++seq}`,
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
      outbox,
      started,
      changed,
      runPendingTurns,
      settleChild,
      dispose: () => {
        delegation.dispose();
        outbox.dispose();
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

      // 回程：结果必须经外发队列真的落到发起方的对话里，而不是停在队列上。
      await runtime.outbox.drain();
      const completionClientId = `bot-delegation-completion:${
        delegated.ok ? delegated.delegationId : ''
      }`;
      expect(
        h
          .sqlite!.prepare('SELECT role, content FROM messages WHERE session_id = ? AND client_id = ?')
          .get('session-1', completionClientId),
      ).toEqual({
        role: 'user',
        content: expect.stringContaining('结论：三个版本都兼容。'),
      });
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delivery_outbox WHERE idempotency_key = ?')
          .pluck()
          .get(completionClientId),
      ).toBe('delivered');
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
      await runtime.outbox.drain();
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
      await runtime.outbox.drain();
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
      ).run('ans-1', 'assistant-final', childSessionId, '三个版本都兼容。', 20_000);
      await runtime.delegation.settleSession({
        childSessionId,
        outcome: 'done',
        resultText: '',
      });
      await runtime.outbox.drain();
      expect(
        h.sqlite!.prepare('SELECT result_summary FROM bot_delegations WHERE id = ?').pluck()
          .get(delegated.ok ? delegated.delegationId : ''),
      ).toBe('三个版本都兼容。');
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

      // 协作卡靠这条推送翻终态；没有它，卡片就永远停在「进行中」。
      expect(runtime.changed.at(-1)).toEqual({ delegationId, status: 'failed' });
      // 失败同样要作为一次结果回传排进外发队列，而不是只写进日志。
      expect(
        h
          .sqlite!.prepare(
            'SELECT payload_ref_json AS payload FROM bot_delivery_outbox WHERE idempotency_key = ?',
          )
          .pluck()
          .get(`bot-delegation-completion:${delegationId}`),
      ).toContain('需要登录后才能执行');
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
      expect(delegated).toMatchObject({ ok: true, status: 'waiting' });
      const delegationId = delegated.ok ? delegated.delegationId : '';
      expect(
        h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').pluck().get(delegationId),
      ).toBe('waiting');
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
