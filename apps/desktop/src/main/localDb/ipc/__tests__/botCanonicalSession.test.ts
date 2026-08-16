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
import { createBotDeliveryOutboxService } from '../../../maker-ipc/botDeliveryOutboxService';
import { configureBotCanonicalReplacementCoordinator } from '../../../maker-ipc/botCanonicalReplacementCoordinator';
import type { MakerSessionCreateOpts } from '../../../maker-ipc/sessionRequest';
import { parseBotDelegationPlanSnapshot } from '../../../../shared/botDelegation';

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
    expect(opts.makerMemoryIndexSnapshot).toContain('## Project Memory (read-only)');
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
      automation: false,
    });
    expect(resolved.memoryRefs).toHaveLength(3);
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
        expect.objectContaining({ kind: 'project', status: 'captured' }),
      ]),
    );
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

  it('runs a Bot delegation in a separate target-owned child Session and returns the result', async () => {
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
        childSessionId: 'session-2',
        targetBotId: 'bot-2',
        depth: 1,
        status: 'running',
      });
      expect(broadcastSessionCreated).toHaveBeenCalledWith('session-2');
      expect(
        h
          .sqlite!.prepare(
            'SELECT source, parent_session_id AS parentSessionId, agent_kind AS agentKind FROM sessions WHERE id = ?',
          )
          .get('session-2'),
      ).toEqual({ source: 'bot', parentSessionId: 'session-1', agentKind: 'codex' });
      expect(
        h
          .sqlite!.prepare(
            'SELECT bot_id AS botId, role, route_key AS routeKey FROM bot_session_links WHERE session_id = ?',
          )
          .get('session-2'),
      ).toEqual({ botId: 'bot-2', role: 'route', routeKey: 'delegation:delegation-1' });

      h.sqlite!.prepare('UPDATE sessions SET total_token_usage = 900 WHERE id = ?').run(
        'session-2',
      );
      await service.settleSession({
        childSessionId: 'session-2',
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
      expect(archiveSession).toHaveBeenCalledWith('session-2');
      expect(closeSession).toHaveBeenCalledWith('session-2');
      expect(
        h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-2'),
      ).toBe('archived');
      expect(
        h
          .sqlite!.prepare('SELECT role FROM bot_session_links WHERE session_id = ?')
          .pluck()
          .get('session-2'),
      ).toBe('history');
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-2',
          targetBotId: 'bot-1',
          objective: 'A historical task must not start new work.',
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
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
        childSessionId: 'session-2',
        depth: 1,
        deadlineAt: 61_000,
      });
      await expect(service.delegateToBot({
        callerSessionId: 'session-2',
        targetBotId: 'bot-3',
        objective: 'A nested Automation delegation must not exceed max depth.',
      })).resolves.toMatchObject({ ok: false, errorCode: 'MAX_DEPTH' });

      h.sqlite!.prepare('UPDATE sessions SET total_token_usage = 50 WHERE id = ?').run('session-2');
      await expect(service.enforceBudgetForSession('session-2', 50)).resolves.toBe(true);
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
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-2' });

      const snapshot = parseBotDelegationPlanSnapshot(
        h
          .sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?')
          .pluck()
          .get('delegation-frozen-workspace') as string,
      );
      expect(snapshot).not.toBeNull();
      expect(snapshot).toMatchObject({
        version: 1,
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
        id: 'session-2',
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
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-2' });
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
      expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get('session-2')).toBe(
        'archived',
      );
      expect(abortSession).toHaveBeenCalledWith('session-2');
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
      expect(first).toMatchObject({ ok: true, childSessionId: 'session-2' });
      await expect(
        service.delegateToBot({
          callerSessionId: 'session-2',
          targetBotId: 'bot-1',
          objective: 'Send the same work back.',
          maxDepth: 2,
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'DELEGATION_CYCLE' });

      await expect(service.cancelDelegation('session-1', 'delegation-1')).resolves.toMatchObject({
        ok: true,
        childSessionId: 'session-2',
      });
      expect(abortSession).toHaveBeenCalledWith('session-2');
      expect(
        h
          .sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?')
          .pluck()
          .get('delegation-1'),
      ).toBe('cancelled');
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
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-2', depth: 1 });

      await expect(
        service.delegateToBot({
          callerSessionId: 'session-2',
          targetBotId: 'bot-3',
          objective: 'Try to exceed the parent budget.',
          maxDepth: 5,
          budgetTokens: 1_001,
        }),
      ).resolves.toMatchObject({ ok: false, errorCode: 'BUDGET_EXCEEDED' });

      await expect(
        service.delegateToBot({
          callerSessionId: 'session-2',
          targetBotId: 'bot-3',
          objective: 'Use a bounded child budget.',
          maxDepth: 5,
          budgetTokens: 500,
        }),
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-3', depth: 2 });
      expect(
        h
          .sqlite!.prepare('SELECT budget_tokens AS budgetTokens FROM bot_delegations WHERE id = ?')
          .get('nested-2'),
      ).toEqual({ budgetTokens: 500 });

      await expect(
        service.delegateToBot({
          callerSessionId: 'session-3',
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
      expect(delegated).toMatchObject({ ok: true, childSessionId: 'session-2' });
      await service.settleSession({
        childSessionId: 'session-2',
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
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-2' });
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
          targetSessionId: 'session-2',
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
      ).resolves.toMatchObject({ ok: true, childSessionId: 'session-2', status: 'running' });
    } finally {
      first.dispose();
    }
    h.sqlite!.prepare(
      `
      UPDATE sessions
      SET active_turn_started_at = 31000, last_turn_ended_at = 30000
      WHERE id = 'session-2'
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
          targetSessionId: 'session-2',
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
      expect(abortSession).toHaveBeenCalledWith('session-2');
      expect(
        h.sqlite!
          .prepare('SELECT status FROM bot_delegations WHERE id = ?')
          .pluck()
          .get('delegation-expired-restart'),
      ).toBe('timed-out');
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
