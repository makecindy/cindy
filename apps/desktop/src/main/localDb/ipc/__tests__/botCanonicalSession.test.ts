import { seedBotReadPositions, markBotReadPositions, pruneBotReadState as pruneHostBotReads } from '../../../maker-ipc/botReadStateStore';
import { listBotDelegationHistory } from '../../../maker-ipc/botDelegationHistory';
import { readBotResponsibilityScope } from '../../../maker-ipc/botTaskCreation';
import { emitSessionCreated } from '../sessionCreatedBroadcast.js';
import { setSessionOpeningModelAdmission } from '../../sessionOpening';
import { createDrizzleProxy } from '../../client/drizzleProxy';
import type { DbTransport } from '../../client/DbTransport';
import { getSelectedNewMakerRoute, setNewMakerDraftCache } from '../../../maker-host/newMakerDefaultsCache';
import { setModelVisibilityMirror } from '../../../maker-host/model-visibility-mirror';
import { setMainLocale } from '../../../i18n.desktop';
import Database from 'better-sqlite3';
import { createMessage } from '../messages';
import type { ProviderView } from '@cindy/model-providers';
import { createHash } from 'node:crypto';
import { createCompanionCloudHost } from '../../../companion-cloud/host';
import { materializeCompanion } from '../../../companion-cloud/materialize';
import { companionHomes, companionSnapshot } from '../../../companion-cloud/homes';
import { startCompanionCloud } from '../../../companion-cloud/runtime';
import { fakeApi, memoryState } from '../../../companion-cloud/__tests__/fakes';
import { clearSessionPersistState, noteSessionAgentKind, getAssistantSamplingRuntimeId } from '../../../messagePersistBroadcaster.desktop';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, promises as fsPromises, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_TEMPLATE_PRESET_IDENTITIES } from '../../../../shared/botTemplatePreset';
import { createBotModelRouteReconciler } from '../../../maker-ipc/botModelRouteReconciler';
import { configureBotModelSelectionCoordinator, createBotModelSelectionCoordinator } from '../../../maker-ipc/botModelSelectionCoordinator';
import { createScheduledModelScope, writeScheduledModelBaselineIfProfileCurrent, ScheduledModelSelectionBusyError, type ScheduledModelSelection } from '../../../maker-ipc/scheduledModelSelection';
import { acquireSendToSessionLock, withSendToSessionLock } from '../../../maker-ipc/sendToSessionLock';
import type { BotModelRoute } from '../../../../shared/botModelChain';
import type { AgentKind } from '@cindy/maker-core';
import { createBotCapabilityService, type BotCapabilityUpdate } from '../../../maker-ipc/botCapabilityService';
import { GroupToolAuthorizationError, registerGroupToolAuthority } from '../../../maker-ipc/botGroupToolAuthorization';
import { buildBotMcpCatalog } from '../../../maker-host/botMcpCatalog';
import { CustomMcpProvider } from '../../../mcp-integrations/custom-mcp-provider';
import type { McpProvider } from '@cindy/maker-core';
import type { CustomMcpConfig } from '../../../../shared/customMcp';
import { Session } from '@cindy/maker-core';
import { withSessionPermissionChange } from '../../../maker-ipc/sessionPermissionChange';
import { getMaker, getPluginRegistry, isBotToolsetAvailable } from '../../../maker-host/index';
import { getBuiltinMcpServerNames, refreshCustomMcpProviders, registerCustomMcpArrays, resetCustomMcpRegistry } from '../../../mcp-integrations/custom-mcp-registry.desktop';
import { isBotToolsetAvailableOnTarget } from '../../../../shared/botRemoteCapabilities';
import { resolveBotAllowedBuiltinPluginIds } from '../../../maker-host/plugins/types';

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

// Host preference storage is outside this database/runtime integration test.
vi.mock('../sessionCreatedBroadcast.js', () => ({ emitSessionCreated: vi.fn(), emitSessionListChangedLocally: vi.fn() }));
vi.mock('electron-store', () => ({ default: class {
  private values = new Map<string, unknown>();
  get(key: string, fallback?: unknown) { return this.values.get(key) ?? fallback; }
  set(key: string | Record<string, unknown>, value?: unknown) {
    if (typeof key === 'string') this.values.set(key, value);
    else for (const [name, item] of Object.entries(key)) this.values.set(name, item);
  }
  delete(key: string) { this.values.delete(key); }
} }));
vi.mock('../../../maker-ipc/appDefaultModelControl.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../../maker-ipc/appDefaultModelControl.js')>(),
  validateTaskModel: vi.fn(async () => true),
}));

const h = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const userDataDir = mkdtempSync(join(tmpdir(), 'cindy-bot-test-'));
  return ({
  userDataDir,
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
  remove: vi.fn(async (_path: import('node:fs').PathLike, _options?: import('node:fs').RmOptions) => undefined),
  ensureGit: vi.fn(async () => undefined),
  closeSession: vi.fn(async () => undefined),
  getSession: vi.fn((_id?: string) => null as {
    capabilities?: { manualCompact?: { supported?: boolean } };
    isTurnRunning?: () => boolean;
    compactSession: (instructions?: string) => Promise<unknown>;
    setPermissionMode?: (mode: string) => Promise<void>;
  } | null),
  ensureDialogue: vi.fn((sessionId: string) => join(userDataDir, sessionId)),
  searchConversations: vi.fn(),
  requestRuntimeRefresh: vi.fn(),
  validateCapabilityAdditions: vi.fn(async (_update: BotCapabilityUpdate) => {}),
  toolsetsAvailable: false,
  customMcpConfigs: [] as CustomMcpConfig[],
  mcpProviders: [] as McpProvider[],
  providers: [] as ProviderView[],
  listProviders: vi.fn(async (): Promise<ProviderView[]> => h.providers),
  ownerScopeKey: 'owner-a:1',
  ownerBoundaryPending: false,
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
});
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, default: { ...actual, rm: h.remove } };
});
// Legacy byte migration has its own real-storage suite.
vi.mock('../legacyTeammateAvatar.js', () => ({ migrateLegacyTeammateAvatar: async () => false }));
// Native activity UI is outside this database/runtime integration test.
vi.mock('../../../agent-island/service.js', () => ({ getAgentIslandService: () => null }));
vi.mock('../../../maker-ipc/botDefaultProvisioning.js', () => ({
  provisionDefaultBot: vi.fn(), markDefaultBotOffered: vi.fn(),
  withDefaultBotProvisioningLock: async (_root: string, assertOwner: () => void, action: () => Promise<unknown>) => {
    assertOwner();
    return action();
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => h.userDataDir),
    getAppPath: () => resolve(__dirname, '../../../../..'),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
    fromWebContents: vi.fn(() => null),
  },
  dialog: { showOpenDialog: h.showOpenDialog },
}));
vi.mock('../../client/current', () => ({
  getCurrentDbClientSnapshot: (() => {
    let current: { key: string; client: {
      tx: (name: string, args: unknown) => Promise<unknown>;
      query: (sql: string, params: unknown[]) => Promise<unknown[]>;
    } } | null = null;
    return () => {
      if (!current || current.key !== h.ownerScopeKey) current = {
        key: h.ownerScopeKey,
        client: {
          tx: (name, args) => h.tx!(name, args),
          query: async (sql, params) => h.sqlite!.prepare(sql).all(...params),
        },
      };
      return current;
    };
  })(),
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
  readGitSafetySettings: () => ({ mode: 'all-projects', autoSnapshotEnabled: true, autoInitProjectGit: true }),
}));
vi.mock('../../../maker-host/custom-mcp-store.desktop.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../maker-host/custom-mcp-store.desktop.js')>(),
  listCustomMcpServers: async () => h.customMcpConfigs,
}));
vi.mock('../../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: h.listProviders }),
}));
vi.mock('../../../maker-host/index.js', () => ({
  validateBotCapabilityAdditions: h.validateCapabilityAdditions,
  getMaker: () => ({ getSession: h.getSession, listAgentSkills: async () => ({ skills: [{ name: 'release-check', description: 'Release checklist', enabled: true }] }) }),
  getPluginRegistry: () => ({
    getPlugins: () => ['memory', 'xdt_helper', 'calendar', 'lsp'].map((id) => ({ id, name: id, description: id })),
    getEnableState: async () => ({ effectiveEnabled: true }),
  }),
  isBotToolsetAvailable: () => h.toolsetsAvailable,
  getMakerIfReady: () => ({
    listAvailableAgents: () => ['claude-code', 'codex', 'pi'],
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
vi.mock('../../../appSessionState.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../appSessionState.js')>();
  return {
    ...actual,
    activeOwnerScopeKey: () => h.ownerScopeKey,
    isAppSessionBoundaryPending: () => h.ownerBoundaryPending,
    ownerScopedUserDataPath: (...parts: string[]) => join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), ...parts),
  };
});
vi.mock('../../../assistantSamplingSettlement.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../assistantSamplingSettlement.js')>();
  return { ...actual, assistantSamplingSettlements: actual.createAssistantSamplingSettlementStore(
    () => join(h.userDataDir, 'sampling-settlements', createHash('sha256').update(h.ownerScopeKey).digest('hex')),
  ) };
});

import {
  archiveBotChannelLanes,
  createBotCanonicalSession,
  ensureBotChannelLaneSession,
  findBotChannelLaneSession,
  registerBotIpc,
  createBotProfile,
  setBotProfileAvatar,
  updateBotProfile as updateStoredBotProfile,
  getBotRemoteResourceSource,
  listBotRemoteResourceSources,
  prepareImportedBotInvitation,
} from '../bots';
import { tx as runWorkerTx } from '../../worker/opHandlers/tx.js';
import * as modelSettings from '../../../maker-host/bot-model-chain-settings-store.js';
import { assertTrustedAppRendererEvent } from '../../../security/trustedAppRenderer.js';
import { runDeviceLinkInvokeContext } from '../../../device-link/invoke-context.js';
import {
  hydrateBotProfileRuntime,
  markBotProfileRuntimeApplied,
  markBotProfileRuntimeFailed,
} from '../../../maker-ipc/botProfileRuntime';
import { createBotDirectMessageService } from '../../../maker-ipc/botDirectMessageService';
import { configureBotCanonicalReplacementCoordinator } from '../../../maker-ipc/botCanonicalReplacementCoordinator';
import type { MakerSessionCreateOpts } from '../../../maker-ipc/sessionRequest';
import { readRemoteBotSessionAccess } from '../botRemoteSessionAccess';
import { assertRemoteBotInvocationAllowed, projectRemoteSessionResult, projectRemoteBotPush } from '../../../device-link/remoteBotSessionBoundary';
import { listBotSkillsForSession, saveBotSkillForSession } from '../../../maker-ipc/botSkillService';
import { provisionDefaultBot } from '../../../maker-ipc/botDefaultProvisioning';
import { resolveSafe } from '../../../cindy-media/blobStore.desktop';

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
      project_dir TEXT,
      workspace_kind TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
      scheduled_model_baseline TEXT,
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
      context_window_runtime INTEGER,
      fast_mode INTEGER NOT NULL DEFAULT 0,
      plan_mode_enabled INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER,
      pinned_at INTEGER,
      hidden_at INTEGER,
      notifications_muted INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      provider_id TEXT,
      user_send_at INTEGER,
      last_activity_at INTEGER,
      agent_kind TEXT NOT NULL DEFAULT 'cc',
      orca_role TEXT,
      parent_session_id TEXT,
      forked_at_message_id TEXT,
      worktree_path TEXT,
      extra_dirs TEXT NOT NULL DEFAULT '[]',
      writable_dirs TEXT NOT NULL DEFAULT '[]',
      remote_host_id TEXT,
      agent_device_id TEXT,
      orca_remote_lead TEXT,
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
      im_default_route TEXT,
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
    CREATE TABLE bot_direct_message_threads (
      id TEXT PRIMARY KEY,
      bot_a_id TEXT NOT NULL,
      bot_b_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      close_reason TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      max_messages INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      blocked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    );
    CREATE TABLE bot_direct_messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      sender_bot_id TEXT NOT NULL,
      recipient_bot_id TEXT NOT NULL,
      sender_session_id TEXT,
      recipient_session_id TEXT,
      delivery_status TEXT NOT NULL DEFAULT 'pending',
      sender_name TEXT,
      recipient_name TEXT,
      bridge_session_id TEXT,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(thread_id, sequence)
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
      group_task_posts_json TEXT DEFAULT '{}' NOT NULL,
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
  sqlite.exec(readFileSync(resolve(__dirname, '../../../../../drizzle/0070_woozy_harpoon.sql'), 'utf8'));
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
const capabilityDeps = {
  getMaker, getPluginRegistry, isBotToolsetAvailable,
  resolveBotAgentKind: async (): Promise<AgentKind | null> => 'pi',
  listMcpServers: async ({ agentKind, remoteHostId }: { agentKind: AgentKind; remoteHostId?: string }) => buildBotMcpCatalog({
    agentKind, remoteHostId, providers: h.mcpProviders, builtinNames: getBuiltinMcpServerNames(),
    customServers: h.customMcpConfigs.map((config) => ({ ...config, updatedAt: 1 })),
  }),
};
const { list: findBotCapabilities, select: selectBotCapability } = createBotCapabilityService(capabilityDeps);

beforeEach(async () => {
  setSessionOpeningModelAdmission(async body => body);
  setModelVisibilityMirror({}, { fallback: true });
  h.toolsetsAvailable = false;
  h.validateCapabilityAdditions.mockReset().mockResolvedValue(undefined);
  h.customMcpConfigs = [{ id: 'shared-docs', name: 'Shared Docs', transport: 'http', url: 'https://example.invalid/private', headers: { Authorization: 'FAKE_SECRET' } }];
  h.mcpProviders = [
    { name: 'cindy_helper', toClaudeSdkConfig: () => ({ type: 'sdk' }) },
    new CustomMcpProvider(h.customMcpConfigs[0]!, () => null),
  ];
  resetCustomMcpRegistry();
  registerCustomMcpArrays(h.mcpProviders);
  vi.clearAllMocks();
  h.listProviders.mockReset().mockImplementation(async () => h.providers);
  vi.mocked(provisionDefaultBot).mockReset();
  h.remove.mockImplementation(async (...args) => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    await fs.rm(...args);
  });
  h.handlers.clear();
  h.nextSession = 0;
  h.providers = [{
    id: 'xd', connected: true, source: 'builtin', agents: ['pi'], access: { kind: 'managed' },
    auth: { method: 'managed' },
    routing: { pi: { upstream: 'https://example.invalid', authStrategy: 'gateway-key' } },
    models: { pi: ['z-ai/glm-5.3-flash', 'auto'].map(id => ({ id, efforts: ['high'], defaultEffort: 'high',
      newSessionDefault: ['pi'], supportsImageInput: true })) },
  }] as ProviderView[];
  h.worktrees = [];
  h.isSessionAlive.mockReturnValue(false);
  h.ensureGit.mockResolvedValue(undefined);
  h.closeSession.mockClear();
  h.getSession.mockReset();
  h.getSession.mockReturnValue(null);
  h.ownerScopeKey = 'owner-a:1';
  setNewMakerDraftCache({ selectedRoute: { harness: 'pi', providerId: 'xd', model: 'z-ai/glm-5.3-flash', effort: 'high', fastMode: false }, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, h.ownerScopeKey);
  h.ownerBoundaryPending = false;
  h.searchConversations.mockResolvedValue({
    query: '',
    results: [],
    vectorUsed: false,
    vectorSkipReason: null,
    poolCapped: false,
  });
  configureBotCanonicalReplacementCoordinator(async (_sessionId, operation) => operation());
  configureBotModelSelectionCoordinator(async (_sessionIds, operation) => operation());
  h.sqlite?.close();
  createDb();
  registerBotIpc();
  await invoke('local-db:bots:create', {
    id: 'bot-1',
    name: 'Release Bot',
    avatar: '🤖',
    capabilities: {
      harness: 'pi',
      model: 'grok-4.5',
      permissions: 'trusted',
    },
  });
});

describe('Bot global model restore IPC', () => {
  it('checks the sender before clearing settings', async () => {
    const reset = vi.spyOn(modelSettings, 'resetBotModelChainSettings');
    vi.mocked(assertTrustedAppRendererEvent).mockImplementationOnce(() => { throw new Error('untrusted'); });
    try {
      await expect(invoke('local-db:bots:model-chain-settings-reset', undefined)).rejects.toThrow('untrusted');
      expect(reset).not.toHaveBeenCalled();
    } finally { reset.mockRestore(); }
  });

  it('returns the resolved state and sanitizes filesystem failures', async () => {
    const reset = vi.spyOn(modelSettings, 'resetBotModelChainSettings');
    try {
      reset.mockResolvedValueOnce({ value: { modelChain: [] }, defaults: { modelChain: [] }, isCustomized: false, customizedKeys: [] });
      await expect(invoke('local-db:bots:model-chain-settings-reset', undefined)).resolves.toEqual({ modelChain: [], isCustomized: false });
      reset.mockRejectedValueOnce(new Error('/private/account/settings.json: denied'));
      await expect(invoke('local-db:bots:model-chain-settings-reset', undefined)).rejects.toThrow('Could not restore Bot model defaults');
    } finally { reset.mockRestore(); }
  });

  it('rejects an account transition before clearing settings', async () => {
    const reset = vi.spyOn(modelSettings, 'resetBotModelChainSettings');
    try {
      h.ownerBoundaryPending = true;
      await expect(invoke('local-db:bots:model-chain-settings-reset', undefined)).rejects.toThrow('PRECONDITION_FAILED');
      expect(reset).not.toHaveBeenCalled();
    } finally { reset.mockRestore(); }
  });
});

describe('Bot canonical Session lifecycle', () => {
  it('reads the stored 代输入 and follow-by-scheduler choices back into the settings profile', async () => {
    expect((await invoke('local-db:bots:get', 'bot-1')).capabilities).not.toHaveProperty('inputHandoff');
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { inputHandoff: false, allowSchedulerFollow: true } });
    expect((await invoke('local-db:bots:get', 'bot-1')).capabilities).toMatchObject({ inputHandoff: false, allowSchedulerFollow: true });
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { inputHandoff: true, allowSchedulerFollow: false } });
    const reset = (await invoke('local-db:bots:get', 'bot-1')).capabilities;
    expect(reset.inputHandoff).not.toBe(false);
    expect(reset.allowSchedulerFollow).not.toBe(true);
  });

  it.each(['inherit', 'allowlist'])('omits retired toolsets from the %s companion settings and discovery', async (mode) => {
    const row = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1')
      .get('bot-1') as { capabilities_json: string };
    const config = { ...JSON.parse(row.capabilities_json), toolCapabilityVersion: 1,
      toolsetMode: mode, toolsets: ['ios-simulator', 'docs', 'missing-tool'], permissions: 'ask' };
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ? AND version = 1')
      .run(JSON.stringify(config), 'bot-1');
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const profile = await invoke('local-db:bots:get', 'bot-1');
    expect(profile.capabilities).toMatchObject({ toolsetMode: mode, toolsets: ['docs', 'missing-tool'], permissions: 'ask' });
    const remote = await (await import('../bots')).getBotRemoteSettingsSource('bot-1');
    expect(remote).toMatchObject({ toolsets: ['docs', 'missing-tool'], permissions: 'ask' });
    const result = await createBotCapabilityService(capabilityDeps).list({
      callerSessionId: created.session.id, kind: 'toolset',
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('ios-simulator');
    expect(result).toMatchObject({ capabilities: expect.arrayContaining([
      expect.objectContaining({ id: 'missing-tool', available: false, joined: true }),
    ]) });
    // Reading the upgraded projection must not rewrite historical profile versions.
    expect(JSON.parse((h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1')
      .get('bot-1') as { capabilities_json: string }).capabilities_json)).toEqual(config);
  });


  it.each(['../bot', 'Bot', 'a:b', 'con', 'aux', 'lpt1'])('rejects nonportable new companion ID %s before persistence', async (id) => {
    await expect(invoke('local-db:bots:create', { id, name: 'Unsafe ID' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(h.sqlite!.prepare('SELECT COUNT(*) AS count FROM bot_profiles').get()).toEqual({ count: 1 });
  });

  it.each(['Bot-1', 'bot/1'])('rejects a new ID whose home aliases legacy profile %s', async (legacyId) => {
    h.sqlite!.pragma('foreign_keys = OFF');
    h.sqlite!.prepare("UPDATE bot_profiles SET id = ? WHERE id = 'bot-1'").run(legacyId);
    await expect(invoke('local-db:bots:create', { id: 'bot-1', name: 'Alias' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    h.sqlite!.pragma('foreign_keys = ON');
  });

  // cindy-bots-runtime.md §2: hidden/archive affects listing, not owner access to an original task.
  it.each(['hidden', 'archived'])('keeps %s companion tasks accessible by ID and live pushes while omitting default lists and companion resources', async (state) => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const id = created.session.id;
    expect(await readRemoteBotSessionAccess(id)).toBe('visible');
    await expect(assertRemoteBotInvocationAllowed([id])).resolves.toBeUndefined();
    expect(await projectRemoteSessionResult('local-db:sessions:get', created.session)).toEqual(created.session);
    if (state === 'hidden') h.sqlite!.prepare("UPDATE bot_profiles SET hidden_at = 1 WHERE id = 'bot-1'").run();
    else h.sqlite!.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = 'bot-1'").run();
    expect(await readRemoteBotSessionAccess(id)).toBe('background');
    await expect(assertRemoteBotInvocationAllowed([id])).resolves.toBeUndefined();
    await expect(assertRemoteBotInvocationAllowed([{ sessionId: id }])).resolves.toBeUndefined();
    expect(await projectRemoteSessionResult('local-db:sessions:get', created.session)).toEqual(created.session);
    expect(await projectRemoteSessionResult('local-db:sessions:list', [created.session])).toEqual([]);
    expect(await projectRemoteSessionResult('maker:list-active', [{ sessionId: id }])).toEqual([]);
    const reply = { sessionId: id, content: 'task reply' };
    expect(await projectRemoteBotPush(reply)).toEqual(reply);
    expect(await projectRemoteBotPush(created.session, 'local-db:sessions:created')).toEqual(created.session);
    await expect(assertRemoteBotInvocationAllowed(['bot-1'], 'local-db:bots:get')).rejects.toThrow('[NOT_FOUND]');
    const cachedResource = { ref: { id: 'bot-1', kind: 'bot' }, revision: id, display: { title: 'private name' } };
    await expect(projectRemoteSessionResult('maker:remote-resources:get', cachedResource)).rejects.toThrow('[NOT_FOUND]');
    expect(await projectRemoteSessionResult('maker:remote-resources:list', { items: [cachedResource], revision: id })).toEqual({ items: [], revision: '' });
    expect(await invoke('local-db:bots:get', 'bot-1')).toMatchObject({ id: 'bot-1' });
  });

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

  it('persists a shared model location when creating the canonical session', async () => {
    const route = { harness: 'codex', model: 'gpt-6-astra', providerId: 'openai',
      agentDeviceId: 'share:test-account', effort: 'high', fastMode: false };
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ? AND version = 1')
      .run(JSON.stringify({ modelChainOverride: [route] }), 'bot-1');
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    expect(h.sqlite!.prepare('SELECT agent_device_id, model, provider_id FROM sessions WHERE id = ?')
      .get(canonical.session.id)).toEqual({ agent_device_id: route.agentDeviceId,
        model: route.model, provider_id: route.providerId });
  });

  it('creates the first canonical task on Codex when only its subscription is connected', async () => {
    h.providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
      auth: { method: 'oauth' },
      access: { kind: 'subscription', product: 'ChatGPT' },
      routing: { codex: { upstream: 'https://example.invalid', authStrategy: 'oauth-passthrough' } },
      models: { codex: [{ id: 'gpt-5.6-sol', mode: 'chat', status: 'active', efforts: ['medium'], defaultEffort: 'medium' }] },
    }] as ProviderView[];
    setNewMakerDraftCache({ selectedRoute: { harness: 'codex', providerId: 'openai', model: 'gpt-5.6-sol', effort: 'medium', fastMode: false }, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, h.ownerScopeKey);
    const created = await invoke('local-db:bots:create', { id: 'codex-only', name: 'Codex Bot' });
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: created.id, expectedCanonicalSessionId: created.canonicalSessionId ?? null,
      expectedProfileVersion: 1,
    });
    const row = h.sqlite!.prepare('SELECT agent_kind, model, provider_id, effort FROM sessions WHERE id = ?')
      .get(canonical.session.id);
    expect(row).toMatchObject({ agent_kind: 'codex', model: 'gpt-5.6-sol', provider_id: 'openai', effort: 'medium' });
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
      model: 'auto',
      providerId: 'xd',
      effort: 'high',
    });
    expect(capabilities).toMatchObject({ toolCapabilityVersion: 1, toolsetMode: 'inherit', mcpMode: 'inherit' });
    expect(capabilities.skills).toEqual([]);
    expect(capabilities.toolsets).toEqual([]);
    expect(capabilities.mcpServers).toEqual([]);
  });

  it.each(['available', 'implicit', 'disconnected', 'deleted'])('checks the Desktop invitation selection at submission: %s', async state => {
    const control = await import('../../../maker-ipc/appDefaultModelControl.js');
    const real = await vi.importActual<typeof control>('../../../maker-ipc/appDefaultModelControl.js');
    vi.mocked(control.validateTaskModel).mockImplementation(real.validateTaskModel);
    try {
      const route: BotModelRoute = { harness: 'pi', providerId: state === 'implicit' ? null : 'xd', model: 'z-ai/glm-5.3-flash', effort: 'high', fastMode: false };
      if (state === 'disconnected') h.providers[0]!.connected = false;
      if (state === 'deleted') h.providers = [];
      const before = h.sqlite!.prepare('SELECT id FROM bot_profiles').all();
      const creating = invoke('local-db:bots:create', { id: 'desktop-selected', name: 'Selected', prepareInvitation: true,
        capabilities: { modelChainOverride: [route] } });
      if ((state === 'available' || state === 'implicit')) await expect(creating).resolves.toMatchObject({ id: 'desktop-selected' });
      else {
        await expect(creating).rejects.toThrow('Model route unavailable');
        expect(h.sqlite!.prepare('SELECT id FROM bot_profiles').all()).toEqual(before);
      }
    } finally { vi.mocked(control.validateTaskModel).mockResolvedValue(true); }
  });

  it.each(['available', 'implicit', 'disconnected', 'deleted'])('validates the primary route before Desktop settings persist: %s', async state => {
    await invoke('local-db:bots:create', { id: 'desktop-settings', name: 'Settings' });
    const before = h.sqlite!.prepare("SELECT * FROM bot_profile_versions WHERE bot_id = 'desktop-settings'").all();
    const control = await import('../../../maker-ipc/appDefaultModelControl.js');
    const real = await vi.importActual<typeof control>('../../../maker-ipc/appDefaultModelControl.js');
    vi.mocked(control.validateTaskModel).mockImplementation(real.validateTaskModel);
    try {
      const route: BotModelRoute = { harness: 'pi', providerId: state === 'implicit' ? null : 'xd', model: 'z-ai/glm-5.3-flash', effort: 'high', fastMode: false };
      if (state === 'disconnected') h.providers[0]!.connected = false;
      if (state === 'deleted') h.providers = [];
      // A stale backup must not prevent saving a usable primary.
      const modelChainOverride = [route, { ...route, model: 'stale-backup' }];
      const saving = invoke('local-db:bots:update', { id: 'desktop-settings', capabilities: { modelChainOverride } });
      if (state === 'available' || state === 'implicit') {
        await expect(saving).resolves.toMatchObject({ capabilities: { modelChainOverride } });
      } else {
        await expect(saving).rejects.toThrow('Model route unavailable');
        expect(h.sqlite!.prepare("SELECT * FROM bot_profile_versions WHERE bot_id = 'desktop-settings'").all()).toEqual(before);
        // Unrelated profile edits remain possible with an unavailable stored route.
        await expect(invoke('local-db:bots:update', { id: 'desktop-settings', name: 'Renamed' }))
          .resolves.toMatchObject({ name: 'Renamed' });
      }
    } finally { vi.mocked(control.validateTaskModel).mockResolvedValue(true); }
  });

  it('validates a legacy location-only selection before persisting settings', async () => {
    const route = { harness: 'codex', model: 'gpt-6-astra', providerId: 'openai', effort: 'high', fastMode: false };
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ? AND version = 1')
      .run(JSON.stringify(route), 'bot-1');
    const before = h.sqlite!.prepare("SELECT * FROM bot_profile_versions WHERE bot_id = 'bot-1'").all();
    const control = await import('../../../maker-ipc/appDefaultModelControl.js');
    vi.mocked(control.validateTaskModel).mockClear().mockResolvedValue(false);
    try {
      await expect(invoke('local-db:bots:update', {
        id: 'bot-1', capabilities: { agentDeviceId: 'share:unavailable-location' },
      })).rejects.toThrow('Model route unavailable');
      expect(control.validateTaskModel).toHaveBeenCalledWith({ ...route, agentDeviceId: 'share:unavailable-location' });
      expect(h.sqlite!.prepare("SELECT * FROM bot_profile_versions WHERE bot_id = 'bot-1'").all()).toEqual(before);
    } finally { vi.mocked(control.validateTaskModel).mockResolvedValue(true); }
  });

  it.each(['rename', 'skills'])('allows legacy chain-only profile maintenance with an unavailable provider: %s', async edit => {
    const id = 'legacy-chain-only';
    await invoke('local-db:bots:create', { id, name: 'Legacy' });
    const route: BotModelRoute = { harness: 'pi', providerId: 'deleted-provider', model: 'legacy-model', effort: 'high', fastMode: false };
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ?')
      .run(JSON.stringify({ modelChain: [route] }), id);
    const control = await import('../../../maker-ipc/appDefaultModelControl.js');
    vi.mocked(control.validateTaskModel).mockClear().mockResolvedValue(false);
    try {
      const patch = edit === 'rename' ? { name: 'Renamed legacy' } : { skills: ['legacy-skill'] };
      const saved = await invoke('local-db:bots:update', { id, ...patch });
      expect(saved.capabilities.modelChain).toEqual([route]);
      if (edit === 'rename') expect(saved.name).toBe('Renamed legacy');
      else expect(saved.skills).toEqual(['legacy-skill']);
      expect(control.validateTaskModel).not.toHaveBeenCalled();
      // Actual model changes must still pass live validation.
      await expect(invoke('local-db:bots:update', { id, capabilities: {
        modelChainOverride: [{ ...route, model: 'another-unavailable-model' }],
      } })).rejects.toThrow('Model route unavailable');
      expect(control.validateTaskModel).toHaveBeenCalled();
    } finally { vi.mocked(control.validateTaskModel).mockResolvedValue(true); }
  });

  it('preserves explicit creation selections under the new capability contract', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'selected-bot', name: 'Selected Bot',
      capabilities: { toolsetMode: 'allowlist', toolsets: [], permissions: 'ask' },
    });
    expect(created.capabilities).toMatchObject({ toolsetMode: 'allowlist', toolsets: [], mcpMode: 'inherit', permissions: 'ask' });
    const row = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1').get('selected-bot') as { capabilities_json: string };
    expect(JSON.parse(row.capabilities_json)).toMatchObject({ toolCapabilityVersion: 1, toolsetMode: 'allowlist' });
  });

  it('persists only bounded welcome hints, not caller-supplied progress or profile identity', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'bot-context', name: 'Context Bot', prepareInvitation: true,
      welcomeContext: { projects: ['Puzzle Studio'], tasks: ['Build a game editor'], automations: [], extra: 'discard' },
      capabilities: { invitation: { stage: 'ready', welcomeContext: { projects: ['injected'] } } },
    });
    const row = h.sqlite!.prepare('SELECT identity_source, capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1').get('bot-context') as { identity_source: string; capabilities_json: string };
    const config = JSON.parse(row.capabilities_json);
    expect(config.invitation).toMatchObject({ stage: 'skills', welcomeContext: { projects: ['Puzzle Studio'], tasks: ['Build a game editor'], automations: [] } });
    expect(config.invitation.welcomeContext.extra).toBeUndefined();
    expect(row.identity_source).not.toContain('Puzzle Studio');
    expect(created.invitation.welcomeContext).toBeUndefined();
  });

  it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])(
    'persists explicit %s for default provisioning before Main locale synchronization',
    async (locale) => {
      setMainLocale('en');
      vi.mocked(provisionDefaultBot).mockImplementationOnce(async input => { await input.create(); });
      await invoke('local-db:bots:list', { locale });
      const row = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1').get('cindy-default') as { capabilities_json: string };
      expect(JSON.parse(row.capabilities_json).invitation.locale).toBe(locale);
    },
  );

  it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])(
    'persists explicit %s for manual creation before Main locale synchronization',
    async (locale) => {
      setMainLocale('en');
      await invoke('local-db:bots:create', { id: 'locale-bot', name: 'Locale test', prepareInvitation: true, locale });
      const row = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1').get('locale-bot') as { capabilities_json: string };
      expect(JSON.parse(row.capabilities_json).invitation.locale).toBe(locale);
    },
  );

  it.each([undefined, 'unsupported', 'system', { locale: 'ja' }])(
    'keeps legacy or invalid locale requests on the Main fallback: %j',
    async (locale) => {
      setMainLocale('en');
      await invoke('local-db:bots:create', { id: 'locale-bot', name: 'Locale test', prepareInvitation: true, locale });
      const row = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1').get('locale-bot') as { capabilities_json: string };
      expect(JSON.parse(row.capabilities_json).invitation.locale).toBe('en');
    },
  );

  it('passes the cached background into first-time default Cindy provisioning', async () => {
    vi.mocked(provisionDefaultBot).mockImplementationOnce(async input => { await input.create(); });
    const welcomeContext = { projects: ['Puzzle Studio'], tasks: [], automations: ['Daily issue triage'] };
    await invoke('local-db:bots:list', { welcomeContext });
    const row = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1').get('cindy-default') as { capabilities_json: string };
    expect(JSON.parse(row.capabilities_json).invitation.welcomeContext).toEqual(welcomeContext);
  });

  it('accepts a legacy welcome request without forging an assistant message', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'bot-welcome',
      name: 'Welcome Bot',
      welcomeMessage: '你好，我已经准备好了。',
    });
    expect(created.invitation).toBeDefined();
    expect(h.sqlite!.prepare('SELECT content FROM messages WHERE client_id = ?')
      .get('bot-welcome:bot-welcome')).toBeUndefined();
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
  });

  it.each(['profile', 'skills', 'avatar', 'welcome', 'failed'])('keeps initial invitation %s preparation from racing with profile edits', async (stage) => {
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ?')
      .run(JSON.stringify({ invitation: { id: 'invite-1', stage } }), 'bot-1');
    await expect(invoke('local-db:bots:update', { id: 'bot-1', name: 'New name' }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(h.sqlite!.prepare('SELECT display_name AS name, current_version FROM bot_profiles WHERE id = ?').get('bot-1'))
      .toEqual({ name: 'Release Bot', current_version: 1 });
  });

  it('captures live sampling ownership on mirror rows and retires it when the native runtime closes', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const sessionId = created.session.id;
    noteSessionAgentKind(sessionId, 'codex');
    const runtimeId = getAssistantSamplingRuntimeId(sessionId)!;
    await createMessage(sessionId, { clientId: 'unconfirmed', role: 'assistant', content: 'uncertain',
      agentMeta: { samplingAttemptPending: { runtimeId } } });
    const host = createCompanionCloudHost({ deliverToCanonical: async () => ({ ok: true }),
      ensureCanonicalSession: async () => sessionId, rebuildContext: async () => 'rebuilt', listDevices: async () => [],
    });
    expect(await host.latestRows(sessionId, 200)).toContainEqual(expect.objectContaining({ clientId: 'unconfirmed', samplingRuntimeId: runtimeId }));
    clearSessionPersistState(sessionId);
    expect(await host.rowsAfter(sessionId, { createdAt: 0, id: '' }, 200)).toContainEqual(expect.objectContaining({
      clientId: 'unconfirmed', samplingRuntimeId: null, agentMeta: JSON.stringify({ samplingAttemptPending: { runtimeId } }),
    }));
  });

  // A durable accepted outcome must fence mirror cursors while its DB replay still fails.
  it.each([false, true])('blocks mirror progress until durable settlement replay succeeds (existing cursor=%s)', async existingCursor => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const sessionId = created.session.id;
    await createMessage(sessionId, { clientId: 'accepted-retry', role: 'assistant', content: 'Accepted answer', createdAt: 1000,
      agentMeta: { samplingAttemptPending: { runtimeId: 'retired' } } });
    await createMessage(sessionId, { clientId: 'later-input', role: 'user', content: 'Later input', createdAt: 20 * 60_000 });
    const { assistantSamplingSettlements } = await import('../../../assistantSamplingSettlement.js');
    assistantSamplingSettlements.put({ sessionId, persistId: 'accepted-retry', patch: { samplingAttemptPending: false } });
    clearSessionPersistState(sessionId);
    const messageApi = await import('../messages.js');
    const patch = vi.spyOn(messageApi, 'patchMessageAgentMetaWithResult').mockRejectedValue(new Error('transient SQLite failure'));
    const { createCompanionMirror } = await import('../../../companion-cloud/mirror.js');
    const { memoryState, fakeApi } = await import('../../../companion-cloud/__tests__/fakes.js');
    const { state } = memoryState();
    state.update('bot-1', 'actor', entry => {
      entry.roomId = 'room';
      if (existingCursor) entry.mirror = { sessionId, createdAt: 0, id: '' };
    });
    const { api, calls } = fakeApi(() => ({ messages: [] }));
    const host = createCompanionCloudHost({ deliverToCanonical: async () => ({ ok: true }),
      ensureCanonicalSession: async () => sessionId, rebuildContext: async () => 'rebuilt', listDevices: async () => [],
    });
    const mirror = createCompanionMirror({ api, state, humanActorId: () => 'human', canonicalSession: async () => sessionId,
      rowsAfter: host.rowsAfter, latestRows: host.latestRows });
    const before = structuredClone(state.bot('bot-1'));
    try {
      await expect(mirror.syncBot('bot-1', 'actor', 'Bot', { drain: true })).rejects.toThrow('COMPANION_STILL_CHANGING');
      expect(state.bot('bot-1')).toEqual(before);
      expect(calls).toEqual([]);
      expect(assistantSamplingSettlements.list(sessionId)).toHaveLength(1);
    } finally { patch.mockRestore(); }
    await mirror.syncBot('bot-1', 'actor', 'Bot', { drain: true });
    await mirror.syncBot('bot-1', 'actor', 'Bot', { drain: true });
    const imported = calls.filter(call => call.route.endsWith('/import')).flatMap(call =>
      (call.data as { messages: Array<{ content: Array<{ text?: string }> }> }).messages);
    expect(imported.filter(message => message.content.some(part => part.text === 'Accepted answer'))).toHaveLength(1);
    expect(assistantSamplingSettlements.list(sessionId)).toEqual([]);
    expect(state.bot('bot-1')?.mirror?.createdAt).toBe(20 * 60_000);
  });

  // #7095: the default companion seeded on a fresh computer is demoted mid-meeting; the take-over then
  // writes the cloud profile onto that copy.
  describe('cloud take-over of a copy whose first meeting never finished', () => {
    const stored = () => JSON.parse(h.sqlite!.prepare(
      'SELECT v.capabilities_json AS json FROM bot_profile_versions v JOIN bot_profiles p ON p.id = v.bot_id AND p.current_version = v.version WHERE p.id = ?',
    ).pluck().get('bot-1') as string) as Record<string, unknown>;
    const unfinished = (stage: string) => h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ?')
      .run(JSON.stringify({ invitation: { id: 'invite-1', stage } }), 'bot-1');

    it.each(['profile', 'skills', 'avatar', 'welcome', 'failed'])('replaces the profile and ends the %s meeting', async (stage) => {
      unfinished(stage);
      const updated = await updateStoredBotProfile({ id: 'bot-1', name: 'Cindy', enabled: true }, undefined, undefined,
        { replacesUnfinishedMeeting: true });
      expect(updated.name).toBe('Cindy');
      expect(stored().invitation).toBeUndefined();
      // The take-over goes on to the main task, which a pending meeting would refuse.
      await expect(invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: updated.currentVersion,
      })).resolves.toMatchObject({ created: true });
    });

    // The take-over retries about once a minute, and each try builds the main task from the live
    // default: a follow-default companion on a computer with only a custom provider stops at the
    // model guidance until the owner picks the companions' default model, then goes through unrestarted.
    it('retries into the main task once the owner sets the companions\' default model', async () => {
      await invoke('local-db:bots:create', { id: 'bot-follow', name: 'Cindy', capabilities: {} });
      h.providers = [{
        id: 'custom-gateway', connected: true, source: 'user', agents: ['pi'], auth: { method: 'api-key' },
        models: { pi: [{ id: 'custom-model', efforts: [], defaultEffort: null, defaultEnabled: true }] },
      }] as unknown as ProviderView[];
      const createMain = () => invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-follow', expectedCanonicalSessionId: null, expectedProfileVersion: 1 });
      try {
        await expect(createMain()).rejects.toThrow('请先连接模型供应商或选择伙伴模型');
        await expect(createMain()).rejects.toThrow('请先连接模型供应商或选择伙伴模型');
        await invoke('local-db:bots:model-chain-settings-set', { modelChain: [
          { harness: 'pi', providerId: 'custom-gateway', model: 'custom-model', effort: '', fastMode: false }] });
        await expect(createMain()).resolves.toMatchObject({ created: true, session: { model: 'custom-model' } });
      } finally { await modelSettings.resetBotModelChainSettings(); }
    });

    it('keeps a finished meeting record', async () => {
      unfinished('ready');
      await updateStoredBotProfile({ id: 'bot-1', name: 'Cindy' }, undefined, undefined, { replacesUnfinishedMeeting: true });
      expect(stored().invitation).toMatchObject({ id: 'invite-1', stage: 'ready' });
    });

    // #6897 + #7116 + #7213: database-only tests bypass the host's trusted restore flags.
    // This unit fixture combines a name collision, pending meeting and rejected avatar;
    // losing any flag blocks the main task or loses the persisted fallback provenance.
    it('takes over an unfinished meeting next to a same-named companion while retaining avatar provenance', async () => {
      const local = await invoke('local-db:bots:create', {
        id: 'same-name-local', name: 'Cloud companion', avatar: '🐈',
      });
      unfinished('avatar');
      const host = createCompanionCloudHost({
        deliverToCanonical: async () => ({ ok: true }),
        ensureCanonicalSession: async () => 'unused',
        rebuildContext: async () => 'rebuilt',
        listDevices: async () => [],
      });
      await host.materializer!.updateProfile({ id: 'bot-1', name: 'Cloud companion',
        avatar: 'http://old-device.example/avatar.png' }, { assertCurrent() {} });
      const profile = await invoke('local-db:bots:get', 'bot-1');
      expect(profile).toMatchObject({ name: 'Cloud companion', avatar: '🤖' });
      expect(stored().invitation).toBeUndefined();
      expect(stored().cloudAvatarFallback).toBe(true);
      await expect(invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: profile.currentVersion,
      })).resolves.toMatchObject({ created: true });
      expect(await invoke('local-db:bots:get', 'same-name-local')).toEqual(local);
    });

    it('does not let a renderer or model body switch the protection off', async () => {
      unfinished('skills');
      await expect(invoke('local-db:bots:update', { id: 'bot-1', name: 'Cindy', replacesUnfinishedMeeting: true }))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await expect(updateStoredBotProfile({ id: 'bot-1', name: 'Cindy' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(stored().invitation).toMatchObject({ stage: 'skills' });
    });
  });

  // cloud-companions.md §3.1 (2026-10-26): a companion taken over from another computer may share its
  // name with a different companion already here; the two stay independent.
  describe('cloud take-over next to a same-named local companion', () => {
    const names = () => h.sqlite!.prepare("SELECT id FROM bot_profiles WHERE display_name = 'Release Bot' ORDER BY id").pluck().all();

    // #10205 review, DB tier: the real host must use a source-only versioned update on
    // the current home. Runtime fakes cannot prove local-file conflict detection or preservation.
    it.each([
      { field: 'identitySource', status: 'active' }, { field: 'userContextSource', status: 'active' },
      { field: 'identitySource', status: 'paused' }, { field: 'userContextSource', status: 'paused' },
    ] as const)('edits only the rejected local $field ($status) and refuses a stale source', async ({ field, status }) => {
      const id = `repair-local-${field.toLowerCase()}`;
      await invoke('local-db:bots:create', { id, name: 'Local name', description: 'Local description',
        identitySource: 'Keep identity', userContextSource: 'Keep user context' });
      if (status === 'paused') await invoke('local-db:bots:update', { id, enabled: false });
      expect(await invoke('local-db:bots:get', id)).toMatchObject({ status });
      const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', id);
      const file = join(home, field === 'identitySource' ? 'SOUL.md' : 'memories/USER.md');
      const untouched = join(home, field === 'identitySource' ? 'memories/USER.md' : 'SOUL.md');
      const kept = readFileSync(untouched, 'utf8');
      const original = 'x'.repeat(12001);
      writeFileSync(file, original);
      const host = createCompanionCloudHost({ deliverToCanonical: async () => ({ ok: true }),
        ensureCanonicalSession: async () => 'unused', rebuildContext: async () => 'rebuilt', listDevices: async () => [] });
      const fields = [{ field, source: original, maxLength: 12000 }];
      await host.repairProfileSources!(id, fields, { [field]: 'Owner correction' }, { assertCurrent() {} });
      expect(readFileSync(file, 'utf8').trim()).toBe('Owner correction');
      expect(readFileSync(untouched, 'utf8')).toBe(kept);
      expect(await invoke('local-db:bots:get', id)).toMatchObject({ status, name: 'Local name', description: 'Local description' });
      writeFileSync(file, 'New edit while the draft was open');
      await expect(host.repairProfileSources!(id, fields, { [field]: 'Stale correction' }, { assertCurrent() {} }))
        .rejects.toMatchObject({ reason: 'changed' });
      expect(readFileSync(file, 'utf8')).toBe('New edit while the draft was open');
    });

    // #10205 review, DB tier: the normal profile writer logs folder failures. The recovery
    // action must not acknowledge them, and the same draft must retry a partially saved pair.
    it.each(['identitySource', 'userContextSource'] as const)('keeps the repair draft after a failed %s file write and retries it', async field => {
      const id = `repair-write-${field.toLowerCase()}`;
      await invoke('local-db:bots:create', { id, name: 'Local name', identitySource: 'Old identity', userContextSource: 'Old user' });
      await invoke('local-db:bots:update', { id, enabled: false });
      const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', id);
      const files = { identitySource: join(home, 'SOUL.md'), userContextSource: join(home, 'memories', 'USER.md') };
      const source = 'x'.repeat(12001);
      for (const file of Object.values(files)) writeFileSync(file, source);
      const actor = { id: 'repair-write-actor', kind: 'bot', externalId: id, name: 'Cloud name', homeDeviceId: 'self' };
      const { api } = fakeApi(route => route === '/preferences' ? [{ key: 'companion.profile.v1', revision: 1,
        value: { name: 'Cloud name', description: '', soul: source, user: source, systemPrompt: '' } }] : {});
      const { state } = memoryState();
      const host = createCompanionCloudHost({ deliverToCanonical: async () => ({ ok: true }),
        ensureCanonicalSession: async () => 'unused', rebuildContext: async () => 'rebuilt', listDevices: async () => [] });
      host.openState = () => state;
      const runtime = startCompanionCloud({ api, host, endpoint: 'https://synthetic.invalid', humanActorId: 'human',
        selfDeviceId: 'self', current: () => true, bots: () => [], actors: () => [actor], initialKick: false });
      const rename = fsPromises.rename.bind(fsPromises);
      let blocked = true;
      const failure = vi.spyOn(fsPromises, 'rename').mockImplementation(async (from, to) => {
        if (blocked && String(to).replaceAll('\\', '/').endsWith(`/bots/${id}/${field === 'identitySource' ? 'SOUL.md' : 'memories/USER.md'}`))
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        return rename(from, to);
      });
      try {
        runtime.reconcile([{ id, status: 'paused' }]);
        const opened = await runtime.repairProfile(id, { action: 'read' });
        if (!opened.ok || !opened.draft) throw new Error('Missing repair draft');
        const request = { action: 'save' as const, token: opened.draft.token,
          values: { identitySource: 'Corrected identity', userContextSource: 'Corrected user' } };
        expect(runtime.installConfirmed(id)).toBe(true);
        expect(await runtime.repairProfile(id, request)).toEqual({ ok: false, code: 'FAILED' });
        expect(readFileSync(files[field], 'utf8')).toBe(source);
        blocked = false;
        expect(await runtime.repairProfile(id, request)).toEqual({ ok: true });
        for (const key of ['identitySource', 'userContextSource'] as const) expect(readFileSync(files[key], 'utf8')).toBe(request.values[key]);
        expect((await host.readValues(id)).find(row => row.key === 'companion.profile.v1')?.value)
          .toMatchObject({ soul: 'Corrected identity', user: 'Corrected user' });
        expect(await invoke('local-db:bots:get', id)).toMatchObject({ name: 'Local name', status: 'paused' });
      } finally { failure.mockRestore(); runtime.dispose(); }
    });

    // #10112: fakeLocal never ran readText's 12000-character boundary. DB tier:
    // real host creation/update and runtime recovery must agree, without losing text.
    it.each(['identitySource', 'userContextSource'] as const)('preserves the real source boundary through take-over: %s', async field => {
      const actor = { id: 'profile-actor', kind: 'bot', externalId: 'profile-limit', name: 'Profile limit', avatar: null, homeDeviceId: 'old-home' };
      let source = 'x'.repeat(12001);
      const { state } = memoryState();
      const host = createCompanionCloudHost({ deliverToCanonical: async () => ({ ok: true }),
        ensureCanonicalSession: async () => 'unused', rebuildContext: async () => 'rebuilt', listDevices: async () => [] });
      host.openState = () => state;
      const failure = { field, maxLength: 12000 };
      const draft = () => ({ id: actor.externalId, name: actor.name, description: '', identitySource: '', userContextSource: '', avatar: null, [field]: source });
      await expect(host.materializer!.createProfile(draft(), { assertCurrent() {} }))
        .rejects.toMatchObject({ code: 'INVALID_PARAMS', failure });
      const { api, calls } = fakeApi((route, method) => {
        if (route === '/preferences') return method === 'GET' ? [{ key: 'companion.profile.v1', revision: 1, value: {
          name: actor.name, description: '', soul: field === 'identitySource' ? source : '',
          systemPrompt: '', user: field === 'userContextSource' ? source : '',
        } }] : { revision: 1 };
        if (route === '/conversations') return { id: '10000000-0000-4000-8000-000000000001' };
        if (route.includes('/messages?')) return [];
        return {};
      });
      const runtime = startCompanionCloud({ api, host, endpoint: 'https://synthetic.invalid', humanActorId: 'human', selfDeviceId: 'self',
        current: () => true, bots: () => [], actors: () => [actor], initialKick: false });
      try {
        expect(await runtime.takeOver(actor.externalId)).toEqual({ ok: false, code: 'FAILED', profileFailure: failure });
        expect(calls.every(call => call.method === 'GET')).toBe(true);
        expect(actor.homeDeviceId).toBe('old-home');
        expect(h.sqlite!.prepare('SELECT id FROM bot_profiles WHERE id = ?').get(actor.externalId)).toBeUndefined();
        source = `  ${'x'.repeat(12000)}  `;
        expect(await runtime.takeOver(actor.externalId)).toEqual({ ok: true });
        const original = await invoke('local-db:bots:get', actor.externalId);
        source = 'x'.repeat(12001);
        await expect(host.materializer!.updateProfile(draft(), { assertCurrent() {} }))
          .rejects.toMatchObject({ code: 'INVALID_PARAMS', failure });
        expect(await invoke('local-db:bots:get', actor.externalId)).toEqual(original);
        expect(await runtime.takeOver(actor.externalId)).toEqual({ ok: false, code: 'FAILED', profileFailure: failure });
        // This case exercises re-materialization of a handed-over copy, not in-place home editing.
        state.update(actor.externalId, actor.id, entry => { entry.demoted = true; });
        const repair = await runtime.repairProfile(actor.externalId, { action: 'read' });
        if (!repair.ok || !repair.draft) throw new Error('Missing recovery editor');
        expect(repair.draft.fields[0]?.source).toBe(source);
        expect(await runtime.repairProfile(actor.externalId, { action: 'save', token: repair.draft.token,
          values: { [field]: 'y'.repeat(12000) } })).toEqual({ ok: true });
        const backups = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'companion-cloud-backups');
        const saved = await fsPromises.readdir(backups);
        const originals = await Promise.all(saved.filter(name => name.startsWith('profile-repair-'))
          .map(async name => JSON.parse(await fsPromises.readFile(join(backups, name, 'profile.json'), 'utf8'))));
        expect(originals).toContainEqual(expect.objectContaining({ botId: actor.externalId,
          profile: expect.objectContaining({ [field === 'identitySource' ? 'soul' : 'user']: source }) }));
        expect(state.isDemoted(actor.externalId)).toBe(false);
        expect(runtime.profileFailure(actor.externalId)).toBeUndefined();
      } finally { runtime.dispose(); companionHomes.reset(); }
    });

    // #9960: the runtime preflight and the real host/SQLite creation must agree. The old
    // materializer projection had no worker singleton, so relaxing only preflight was insufficient.
    // DB tier; synthetic cloud, isolated SQLite; no Electron app or real account involved.
    it.each(['missing', 'remote', 'local', 'unregistered'] as const)('handles a local Cindy copy during take-over: %s', async location => {
      h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ?')
        .run(JSON.stringify({ templateId: 'cindy' }), 'bot-1');
      const original = await invoke('local-db:bots:get', 'bot-1');
      const actor = { id: 'incoming-actor', kind: 'bot', externalId: 'incoming_cindy', name: 'Cloud Cindy', avatar: null, homeDeviceId: 'old-home' };
      const actors = [actor, ...(['missing', 'unregistered'].includes(location) ? [] : [{ id: 'old-actor', kind: 'bot', externalId: 'bot-1', name: 'Old Cindy', avatar: null,
        homeDeviceId: location === 'local' ? 'self' : 'elsewhere' }])];
      const { state } = memoryState();
      if (location !== 'unregistered') state.update('bot-1', 'old-actor', entry => { entry.demoted = true; });
      const host = createCompanionCloudHost({ deliverToCanonical: async () => ({ ok: true }),
        ensureCanonicalSession: async () => 'unused', rebuildContext: async () => 'rebuilt', listDevices: async () => [] });
      host.openState = () => state;
      const publish = () => host.homes.update(companionSnapshot({ enabled: true, selfDeviceId: 'self', humanActorId: 'human', actors,
        demotedBotIds: state.demotedBotIds() }));
      const { api, calls } = fakeApi((route, method) => {
        if (route === '/preferences') return method === 'GET' ? [{ key: 'companion.profile.v1', revision: 1, value: {
          name: 'Cloud Cindy', description: '', soul: 'Cloud identity', systemPrompt: '', user: '', templateId: 'cindy',
        } }] : { revision: 1 };
        if (route === '/conversations') return { id: '10000000-0000-4000-8000-000000000001' };
        if (route.includes('/messages?')) return [];
        return {};
      });
      publish();
      const runtime = startCompanionCloud({ api, host, endpoint: 'https://synthetic.invalid', humanActorId: 'human', selfDeviceId: 'self',
        current: () => true, bots: () => [], actors: () => actors, publish, initialKick: false });
      try {
        const result = await runtime.takeOver(actor.externalId);
        if (location === 'local' || location === 'unregistered') {
          expect(result).toEqual({ ok: false, code: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'bot-1', conflictingDeviceId: 'self' });
          // The original active+absent/empty-state orphan remains protected, but the exact
          // profile is readable through the settings route even when absent from cloud merge.
          expect(await invoke('local-db:bots:list', {})).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'bot-1' })]));
          expect(calls.every(call => call.method === 'GET')).toBe(true);
          expect(actor.homeDeviceId).toBe('old-home');
        } else {
          expect(result).toEqual({ ok: true });
          expect(await invoke('local-db:bots:get', actor.externalId)).toMatchObject({ id: actor.externalId, name: 'Cloud Cindy', status: 'active' });
          expect(actor.homeDeviceId).toBe('self');
          // Recovery also takes the existing-copy path, without duplicating or changing the orphan.
          expect(await runtime.takeOver(actor.externalId)).toEqual({ ok: true });
          expect(state.isDemoted(actor.externalId)).toBe(false);
          // Ordinary creation must return the effective local Cindy, not the hidden old one.
          expect(await invoke('local-db:bots:create', { id: 'another_cindy', name: 'Another Cindy', templateId: 'cindy' }))
            .toMatchObject({ id: actor.externalId });
        }
        expect(await invoke('local-db:bots:get', 'bot-1')).toEqual(original);
        expect(state.isDemoted('bot-1')).toBe(location !== 'unregistered');
      } finally { runtime.dispose(); companionHomes.reset(); }
    });

    // Regression (cloud-companions.md §6): the actual host + SQLite singleton must distinguish
    // the exact externalId from a different Cindy, including legacy identity fingerprints.
    // The pure materializer tests have no DB uniqueness constraint. DB tier; no user data/network.
    it.each(['same-id', 'different-id', 'legacy-identity'] as const)('restores Cindy by identity: %s', async scenario => {
      h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ?, identity_source = ? WHERE bot_id = ?')
        .run(JSON.stringify(scenario === 'legacy-identity' ? {} : { templateId: 'cindy' }),
          scenario === 'legacy-identity' ? BOT_TEMPLATE_PRESET_IDENTITIES.cindy : 'Custom Cindy identity', 'bot-1');
      const original = await invoke('local-db:bots:get', 'bot-1');
      const id = scenario === 'same-id' ? 'bot-1' : 'incoming_cindy';
      const host = createCompanionCloudHost({
        deliverToCanonical: async () => ({ ok: true }), ensureCanonicalSession: async () => 'unused',
        rebuildContext: async () => 'rebuilt', listDevices: async () => [],
      });
      const { state } = memoryState();
      const { api } = fakeApi(route => route === '/preferences'
        ? [{ key: 'companion.profile.v1', revision: 1, value: {
          name: 'Cloud Cindy', description: '', soul: 'Cloud identity', systemPrompt: '', user: '', templateId: 'cindy',
        } }] : []);
      const restore = () => materializeCompanion({ api, state,
        host: { ...host.materializer!, latestRows: host.latestRows },
        actor: { id: 'cloud-actor', externalId: id, name: 'Cloud Cindy', avatar: null }, roomId: async () => 'room',
      });
      if (scenario === 'same-id') {
        expect(await restore()).toMatchObject({ created: false });
        expect(await restore()).toMatchObject({ created: false, inserted: 0 });
        expect(await invoke('local-db:bots:get', id)).toMatchObject({ id, name: 'Cloud Cindy' });
        expect(state.isDemoted(id)).toBe(false);
      } else {
        await expect(restore()).rejects.toMatchObject({ message: 'LOCAL_CINDY_CONFLICT', conflictingBotId: 'bot-1' });
        expect(await invoke('local-db:bots:get', 'bot-1')).toEqual(original);
        expect(state.isDemoted(id)).toBe(true);
        expect(state.bot(id)?.backedUp).toBeUndefined();
        // The singleton no longer blocks after it is archived. This read alone must not create anything.
        h.sqlite!.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = ?").run('bot-1');
        expect(await host.materializer!.findConflictingCindy!(id)).toBeNull();
      }
      expect(h.sqlite!.prepare('SELECT id FROM bot_profiles').pluck().all()).toEqual(['bot-1']);
    });

    // #6897 + #7213: the host create path must pass both flags into the real profile transaction.
    // The database-only name checks below cannot catch an omitted host flag. No network is used.
    it('creates a same-named cloud copy with persisted fallback avatar provenance', async () => {
      const local = await invoke('local-db:bots:get', 'bot-1');
      const host = createCompanionCloudHost({
        deliverToCanonical: async () => ({ ok: true }),
        ensureCanonicalSession: async () => 'unused',
        rebuildContext: async () => 'rebuilt',
        listDevices: async () => [],
      });
      await host.materializer!.createProfile({ id: 'import_other', name: 'Release Bot',
        description: '', identitySource: '', userContextSource: '',
        avatar: 'http://old-device.example/avatar.png' }, { assertCurrent() {} });
      const profile = await invoke('local-db:bots:get', 'import_other');
      expect(profile).toMatchObject({ name: 'Release Bot', avatar: '🤖' });
      const stored = JSON.parse(h.sqlite!.prepare(
        'SELECT v.capabilities_json FROM bot_profile_versions v JOIN bot_profiles p ON p.id = v.bot_id AND p.current_version = v.version WHERE p.id = ?',
      ).pluck().get('import_other') as string) as Record<string, unknown>;
      expect(stored.cloudAvatarFallback).toBe(true);
      expect(names()).toEqual(['bot-1', 'import_other']);
      expect(await invoke('local-db:bots:get', 'bot-1')).toEqual(local);
    });

    it('creates the copy without the name check', async () => {
      const { createBotProfile } = await import('../bots');
      const created = await createBotProfile({ id: 'import_other', name: 'release bot' }, { allowSameName: true });
      expect(created.id).toBe('import_other');
      await createBotProfile({ id: 'import_third', name: 'Release Bot' }, { allowSameName: true });
      expect(names()).toEqual(['bot-1', 'import_third']);
    });

    it('still refuses a same-named ordinary creation', async () => {
      const { createBotProfile } = await import('../bots');
      await expect(createBotProfile({ id: 'import_other', name: 'Release Bot' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      await expect(createBotProfile({ id: 'import_other', name: 'Release Bot' }, { templateId: undefined })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(names()).toEqual(['bot-1']);
    });

    it('does not let a renderer or model body switch the name check off', async () => {
      const { createBotProfile } = await import('../bots');
      for (const flag of ['allowSameName', 'allowDuplicateName', 'inactiveCindyIds']) {
        await expect(invoke('local-db:bots:create', { id: 'import_other', name: 'Release Bot', [flag]: true }))
          .rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
        await expect(createBotProfile({ id: 'import_other', name: 'Release Bot', [flag]: true })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      }
      expect(names()).toEqual(['bot-1']);
    });

    it('does not let a public request supply inactive Cindy identities', async () => {
      await invoke('local-db:bots:create', { id: 'local-cindy', name: 'Cindy', templateId: 'cindy' });
      const { createBotProfile } = await import('../bots');
      await expect(createBotProfile({ id: 'forged_cindy', name: 'Another', inactiveCindyIds: ['local-cindy'] },
        { templateId: 'cindy', allowSameName: true })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(h.sqlite!.prepare("SELECT COUNT(*) FROM bot_profiles WHERE id = 'forged_cindy'").pluck().get()).toBe(0);
    });

    it('keeps the default Cindy unique for a take-over', async () => {
      const { createBotProfile } = await import('../bots');
      await invoke('local-db:bots:create', { id: 'local-cindy', name: 'Cindy', templateId: 'cindy' });
      await expect(createBotProfile({ id: 'import_cindy', name: 'Cindy 2' }, { templateId: 'cindy', allowSameName: true }))
        .rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      expect(h.sqlite!.prepare("SELECT COUNT(*) FROM bot_profiles WHERE id = 'import_cindy'").pluck().get()).toBe(0);
    });

    it('takes over an existing copy whose cloud name now matches another local companion', async () => {
      await invoke('local-db:bots:create', { id: 'import_copy', name: 'Copy' });
      await expect(updateStoredBotProfile({ id: 'import_copy', name: 'Release Bot' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      await expect(invoke('local-db:bots:update', { id: 'import_copy', name: 'Release Bot', allowSameName: true }))
        .rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
      const updated = await updateStoredBotProfile({ id: 'import_copy', name: 'Release Bot' }, undefined, undefined, { allowSameName: true });
      expect(updated.name).toBe('Release Bot');
      expect(names()).toEqual(['bot-1', 'import_copy']);
    });
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

  it.each([['ask', 'ask'], ['auto', 'auto'], ['trusted', 'bypassPermissions']])('applies saved %s permissions to the existing chat and live runtime', async (permissions, mode) => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const setPermissionMode = vi.fn(async () => {});
    h.getSession.mockReturnValue({ compactSession: vi.fn(), setPermissionMode });
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions } });
    expect(h.sqlite!.prepare('SELECT permission_mode AS mode FROM sessions WHERE id = ?').get(created.session.id)).toEqual({ mode });
    expect(setPermissionMode).toHaveBeenCalledWith(mode);
    // Saving the same value repairs an old chat left at the prior permission mode.
    h.sqlite!.prepare("UPDATE sessions SET permission_mode = 'default' WHERE id = ?").run(created.session.id);
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions } });
    expect(h.sqlite!.prepare('SELECT permission_mode AS mode FROM sessions WHERE id = ?').get(created.session.id)).toEqual({ mode });
  });

  // #6782, unit: real settings IPC and worker transaction. Earlier coverage did
  // not commit a composer permission between the profile read and settings save.
  it.each([['ask', 'bypassPermissions', 'trusted'], ['trusted', 'ask', 'ask']])(
    'preserves a newer permission through an in-flight profile edit (%s -> %s)',
    async (previous, mode, expected) => {
      const initial = await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions: previous } });
      const created = await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: initial.currentVersion,
      });
      const lane = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey: 'im:feishu:fixture:g:1', title: 'Fixture' });
      if (!lane.ok) throw new Error(lane.message);
      const runTx = h.tx!;
      let interleaved = false;
      h.tx = async (name, args) => {
        if (name === 'bots.updateProfile' && !interleaved) {
          interleaved = true;
          await runTx('bots.persistSessionPermission', { sessionId: created.session.id, mode });
        }
        return runTx(name, args);
      };
      const updated = await invoke('local-db:bots:update', { id: 'bot-1', name: 'Edited name' });
      expect(interleaved).toBe(true);
      expect(updated).toMatchObject({ name: 'Edited name', capabilities: { permissions: expected } });
      expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id IN (?, ?)').pluck().all(created.session.id, lane.sessionId))
        .toEqual([mode, mode]);
      const next = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey: 'im:feishu:fixture:g:2', title: 'New fixture' });
      if (!next.ok) throw new Error(next.message);
      expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get(next.sessionId)).toBe(mode);
    },
  );

  // #6782, unit: creation repairs in the worker before Main can see the old
  // Profile. The returned repair receipt must still update an existing runtime.
  it('repairs legacy permissions during new channel creation and hot-switches an existing lane', async () => {
    const initial = await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions: 'ask' } });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: initial.currentVersion,
    });
    const existing = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey: 'im:feishu:fixture:g:1', title: 'Old' });
    if (!existing.ok) throw new Error(existing.message);
    h.sqlite!.prepare("UPDATE sessions SET permission_mode = 'bypassPermissions' WHERE id = ?").run(created.session.id);
    const live = { compactSession: vi.fn(), stablePermissionModeState: { mode: 'ask' },
      setPermissionMode: vi.fn(async (mode: string) => { live.stablePermissionModeState = { mode }; }) };
    h.getSession.mockImplementation(id => id === existing.sessionId ? live : null);
    const next = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey: 'im:feishu:fixture:g:2', title: 'New' });
    if (!next.ok) throw new Error(next.message);
    expect(live.stablePermissionModeState.mode).toBe('bypassPermissions');
    expect(live.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id IN (?, ?, ?)').pluck()
      .all(created.session.id, existing.sessionId, next.sessionId)).toEqual(Array(3).fill('bypassPermissions'));
    expect((await invoke('local-db:bots:get', 'bot-1')).capabilities.permissions).toBe('trusted');
  });

  // P1 review: settings remain available when the canonical task/link is absent.
  // Persisted rows alone never updated an already loaded IM runtime in this case.
  it('tightens a live channel from settings without a canonical link', async () => {
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions: 'trusted' } });
    const lane = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey: 'im:feishu:fixture:g:orphan', title: 'Orphan' });
    if (!lane.ok) throw new Error(lane.message);
    const live = { compactSession: vi.fn(), stablePermissionModeState: { mode: 'bypassPermissions' },
      setPermissionMode: vi.fn(async (mode: string) => { live.stablePermissionModeState = { mode }; }) };
    h.getSession.mockImplementation(id => id === lane.sessionId ? live : null);
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions: 'ask' } });
    expect(live.stablePermissionModeState.mode).toBe('ask');
    expect(live.setPermissionMode).toHaveBeenCalledWith('ask');
    expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get(lane.sessionId)).toBe('ask');
  });

  // #6782, unit: an explicit idempotent edit is still a new permission intent.
  // The previous diff only protected changed=true profile saves.
  it('commits an explicit same-value permission after a concurrent composer choice', async () => {
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions: 'ask' } });
    const initial = await invoke('local-db:bots:get', 'bot-1');
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: initial.currentVersion,
    });
    const lane = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey: 'im:feishu:fixture:g:1', title: 'Fixture' });
    if (!lane.ok) throw new Error(lane.message);
    const runTx = h.tx!;
    let interleaved = false;
    h.tx = async (name, args) => {
      if (name === 'bots.updateProfile' && !interleaved) {
        interleaved = true;
        await runTx('bots.persistSessionPermission', { sessionId: created.session.id, mode: 'bypassPermissions' });
      }
      return runTx(name, args);
    };
    const updated = await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions: 'ask' } });
    expect(updated.capabilities.permissions).toBe('ask');
    expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id IN (?, ?)').pluck().all(created.session.id, lane.sessionId))
      .toEqual(['ask', 'ask']);
  });

  // Actual Session serialization alone cannot order the surrounding DB commits.
  it('orders complete settings and composer permission commits with a real Session', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    let release!: () => void;
    let entered!: () => void;
    let validated!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const preflight = new Promise<void>(resolve => { validated = resolve; });
    const logger = { info() {}, debug() {}, trace() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
    const live = new Session({ id: created.session.id, agentKind: 'codex', workDir: created.session.workingDir,
      permissionMode: 'ask', turnStallMs: 0, logger,
      capabilities: { permissionModes: [{ id: 'ask' }, { id: 'bypassPermissions' }], setPermissionModeMidSession: { supported: true } } as never,
      handle: { setInteractionResolver() {}, close: async () => {}, setPermissionMode: async (mode: string) => {
        if (mode === 'bypassPermissions') { entered(); await pending; }
      } } as never,
    });
    h.getSession.mockImplementation(id => id === live.id ? live as never : null);
    const composer = withSessionPermissionChange(live.id, async () => {
      await live.setPermissionMode('bypassPermissions');
      await h.tx!('bots.persistSessionPermission', { sessionId: live.id, mode: 'bypassPermissions' });
    });
    await started;
    h.validateCapabilityAdditions.mockImplementationOnce(async () => { validated(); });
    const settings = invoke('local-db:bots:update', { id: 'bot-1', name: 'Edited name', capabilities: { permissions: 'ask' } });
    await preflight;
    // Let continuations already released by the completed validation reach either
    // the native queue or the host commit fence; no wall-clock sleep is involved.
    await new Promise<void>(resolve => setImmediate(resolve));
    release();
    try {
      await Promise.all([composer, settings]);
      expect(live.stablePermissionModeState?.mode).toBe('ask');
      expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get(live.id)).toBe('ask');
      const profile = await invoke('local-db:bots:get', 'bot-1');
      expect(profile.capabilities.permissions).toBe('ask');
    } finally { await live.close(); }
  });

  it('retires a runtime whose permission change failed and keeps the saved setting for restart', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    h.getSession.mockReturnValue({ compactSession: vi.fn(), setPermissionMode: vi.fn(async () => { throw new Error('runtime disconnected'); }) });
    await expect(invoke('local-db:bots:update', { id: 'bot-1', capabilities: { permissions: 'ask' } })).rejects.toThrow('runtime disconnected');
    expect(h.closeSession).toHaveBeenCalledWith(created.session.id);
    expect(h.sqlite!.prepare('SELECT permission_mode AS mode FROM sessions WHERE id = ?').get(created.session.id)).toEqual({ mode: 'ask' });
    expect(h.requestRuntimeRefresh).not.toHaveBeenCalled();
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

  it.each(['dash', 'lizi'])('accepts old %s creation payloads as ordinary teammates', async (templateId) => {
    const identitySource = `User-edited ${templateId} identity`;
    const created = await invoke('local-db:bots:create', {
      id: `legacy-${templateId}`, name: templateId, templateId, identitySource,
      avatar: `cindy://avatar/preset/${templateId}`,
      capabilities: { toolsetMode: 'allowlist', toolsets: ['docs'] },
    });
    expect(created).toMatchObject({ identitySource, avatar: `cindy://avatar/preset/${templateId}` });
    expect(created.templateId).toBeUndefined();
    const row = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ?')
      .get(`legacy-${templateId}`) as { capabilities_json: string };
    expect(JSON.parse(row.capabilities_json)).toMatchObject({ toolsets: ['docs'] });
    expect(JSON.parse(row.capabilities_json).templateId).toBeUndefined();
  });

  it.each(['dash', 'lizi'])('keeps an existing %s profile, home and canonical chat independent of its retired template', async (templateId) => {
    const id = `existing-${templateId}`;
    const identitySource = `My customized ${templateId} identity`;
    await invoke('local-db:bots:create', { id, name: templateId, identitySource,
      avatar: `cindy://avatar/preset/${templateId}` });
    // Replay an old persisted profile; the removed template is only historical metadata.
    const readConfig = () => JSON.parse((h.sqlite!.prepare(
      'SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? ORDER BY version DESC LIMIT 1',
    ).get(id) as { capabilities_json: string }).capabilities_json);
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ?')
      .run(JSON.stringify({ ...readConfig(), templateId }), id);
    const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', id);
    mkdirSync(join(home, 'skills', 'my-workflow'), { recursive: true });
    writeFileSync(join(home, 'skills', 'my-workflow', 'SKILL.md'), 'My verified workflow');
    writeFileSync(join(home, 'memories', 'user-preference.md'), 'My stable preference');
    const soulBefore = readFileSync(join(home, 'SOUL.md'), 'utf8');
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: id, expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    await invoke('local-db:bots:list', {});
    const loaded = await invoke('local-db:bots:get', id);
    expect(loaded).toMatchObject({ templateId, identitySource, currentVersion: 1,
      avatar: `cindy://avatar/preset/${templateId}`, canonicalSessionId: canonical.canonicalSessionId });
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe(soulBefore);
    expect(readFileSync(join(home, 'skills', 'my-workflow', 'SKILL.md'), 'utf8')).toBe('My verified workflow');
    expect(readFileSync(join(home, 'memories', 'user-preference.md'), 'utf8')).toBe('My stable preference');
    const edited = await invoke('local-db:bots:update', { id, name: `${templateId} renamed` });
    expect(edited).toMatchObject({ templateId, identitySource, canonicalSessionId: canonical.canonicalSessionId });
    expect(readConfig().templateId).toBe(templateId);
  });

  it('keeps a description created at full length editable', async () => {
    const description = '长'.repeat(12000);
    const created = await invoke('local-db:bots:create', { id: 'long-description', name: 'Long', description });
    const edited = await invoke('local-db:bots:update', { id: created.id, description: `${description.slice(1)}改` });
    expect(edited.description).toHaveLength(12000);
    await expect(invoke('local-db:bots:update', { id: created.id, description: `${description}!` }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('adopts a hand-edited SOUL.md when creating the canonical task from the version the caller saw', async () => {
    const created = await invoke('local-db:bots:create', { id: 'file-first', name: 'File First', identitySource: 'Original identity' });
    const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', created.id);
    writeFileSync(join(home, 'SOUL.md'), 'Identity written in an editor\n');
    // A stale caller from before an unrelated concurrent save still loses the CAS.
    await invoke('local-db:bots:update', { id: created.id, name: 'File First 2', expectedVersion: 1 });
    await expect(invoke('local-db:bots:create-canonical-session', {
      botId: created.id, expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const current = (await invoke('local-db:bots:get', created.id)).currentVersion as number;
    writeFileSync(join(home, 'SOUL.md'), 'Identity written again\n');
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: created.id, expectedCanonicalSessionId: null, expectedProfileVersion: current,
    });
    expect(canonical.canonicalSessionId).toBeTruthy();
    const loaded = await invoke('local-db:bots:get', created.id);
    expect(loaded.currentVersion).toBe(current + 1);
    expect(loaded.identitySource).toContain('Identity written again');
  });

  it('adopts a kept hand-edited USER.md in the same reconcile that re-seeds a missing SOUL.md', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'partial-home', name: 'Partial Home', identitySource: 'Stored identity',
      userContextSource: 'Stored user context',
    });
    const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', created.id);
    rmSync(join(home, 'SOUL.md'));
    writeFileSync(join(home, 'memories', 'USER.md'), 'User context written in an editor');
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: created.id, expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    expect(canonical.canonicalSessionId).toBeTruthy();
    const loaded = await invoke('local-db:bots:get', created.id);
    expect(loaded).toMatchObject({
      currentVersion: 2, identitySource: 'Stored identity', userContextSource: 'User context written in an editor',
    });
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('Stored identity');
  });

  it('seeds a missing SOUL.md from the database on a filesystem without hard links, without deriving', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'no-hardlinks', name: 'No Hardlinks', identitySource: 'Stored identity',
      userContextSource: 'Stored user context',
    });
    const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', created.id);
    rmSync(join(home, 'SOUL.md'));
    const link = vi.spyOn(fsPromises, 'link').mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    try {
      const canonical = await invoke('local-db:bots:create-canonical-session', {
        botId: created.id, expectedCanonicalSessionId: null, expectedProfileVersion: 1,
      });
      expect(canonical.canonicalSessionId).toBeTruthy();
    } finally {
      link.mockRestore();
    }
    expect(await invoke('local-db:bots:get', created.id)).toMatchObject({
      currentVersion: 1, identitySource: 'Stored identity', userContextSource: 'Stored user context',
    });
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('Stored identity');
    expect(readFileSync(join(home, 'memories', 'USER.md'), 'utf8')).toBe('Stored user context');
  });

  it('seeds a never-created Bot Home on an unrelated save without touching an existing one', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'legacy-home', name: 'Legacy Home', identitySource: 'Stored identity',
      userContextSource: 'Stored user context',
    });
    const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', created.id);
    // A profile from before the Home existed: no editable files yet.
    rmSync(join(home, 'SOUL.md'));
    rmSync(join(home, 'memories', 'USER.md'));
    await invoke('local-db:bots:update', { id: created.id, pinned: true });
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8').trim()).toBe('Stored identity');
    expect(readFileSync(join(home, 'memories', 'USER.md'), 'utf8').trim()).toBe('Stored user context');

    // Only SOUL.md missing: seeding fills it without resetting a hand-edited USER.md.
    rmSync(join(home, 'SOUL.md'));
    writeFileSync(join(home, 'memories', 'USER.md'), 'User context written in an editor\n');
    await invoke('local-db:bots:update', { id: created.id, pinned: false });
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8').trim()).toBe('Stored identity');
    expect(readFileSync(join(home, 'memories', 'USER.md'), 'utf8')).toBe('User context written in an editor\n');
  });

  it('keeps hand-edited SOUL.md and USER.md through unrelated profile saves', async () => {
    const created = await invoke('local-db:bots:create', {
      id: 'hand-edited', name: 'Hand Edited', identitySource: 'Original identity',
      userContextSource: 'Original user context',
    });
    const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', created.id);
    writeFileSync(join(home, 'SOUL.md'), 'Identity written in an editor\n');
    writeFileSync(join(home, 'memories', 'USER.md'), 'User context written in an editor\n');

    await invoke('local-db:bots:update', { id: created.id, pinned: true });
    await invoke('local-db:bots:update', { id: created.id, hidden: true });
    await invoke('local-db:bots:update', { id: created.id, hidden: false, name: 'Renamed' });
    await invoke('local-db:bots:update', { id: created.id, capabilities: { permissions: 'auto' } });
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('Identity written in an editor\n');
    expect(readFileSync(join(home, 'memories', 'USER.md'), 'utf8')).toBe('User context written in an editor\n');

    // An explicit identity or user-context edit in settings writes only its own file.
    await invoke('local-db:bots:update', { id: created.id, identitySource: 'Identity from settings' });
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8').trim()).toBe('Identity from settings');
    expect(readFileSync(join(home, 'memories', 'USER.md'), 'utf8')).toBe('User context written in an editor\n');
    writeFileSync(join(home, 'SOUL.md'), 'Identity edited again\n');
    await invoke('local-db:bots:update', { id: created.id, userContextSource: 'Context from settings' });
    expect(readFileSync(join(home, 'memories', 'USER.md'), 'utf8').trim()).toBe('Context from settings');
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('Identity edited again\n');
  });

  it('still recognizes an unchanged legacy Cindy without rewriting its identity', async () => {
    await invoke('local-db:bots:create', { id: 'legacy-cindy', name: 'Cindy',
      identitySource: BOT_TEMPLATE_PRESET_IDENTITIES.cindy });
    const loaded = await invoke('local-db:bots:get', 'legacy-cindy');
    expect(loaded).toMatchObject({ templateId: 'cindy', identitySource: BOT_TEMPLATE_PRESET_IDENTITIES.cindy, currentVersion: 1 });
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

  it('prepares one original welcome only after a native import has saved its identity', async () => {
    const invitation = await import('../../../maker-ipc/botInvitation');
    const queued = vi.spyOn(invitation, 'queueBotInvitation').mockImplementation(() => {});
    try {
      await invoke('local-db:bots:create', { id: 'native-welcome', name: 'Native package', identitySource: 'Saved package identity', prepareInvitation: false });
      expect(queued).not.toHaveBeenCalled();
      await prepareImportedBotInvitation('native-welcome', 'native-request', 'zh-CN');
      const profile = await invoke('local-db:bots:get', 'native-welcome');
      expect(profile.identitySource).toBe('Saved package identity');
      expect(profile.invitation).toMatchObject({ stage: 'welcome' });
      const version = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = ?').get('native-welcome', profile.currentVersion) as { capabilities_json: string };
      expect(JSON.parse(version.capabilities_json).invitation).toMatchObject({ id: 'import-welcome:native-request', stage: 'welcome', locale: 'zh-CN' });
      expect(queued).toHaveBeenCalledTimes(1);
      await prepareImportedBotInvitation('native-welcome', 'native-request', 'en');
      expect(queued).toHaveBeenCalledTimes(1);
      expect((await invoke('local-db:bots:get', 'native-welcome')).currentVersion).toBe(profile.currentVersion);
    } finally { queued.mockRestore(); }
  });

  it('refuses to prepare a native welcome after deletion or archival', async () => {
    const invitation = await import('../../../maker-ipc/botInvitation');
    const queued = vi.spyOn(invitation, 'queueBotInvitation').mockImplementation(() => {});
    try {
      await expect(prepareImportedBotInvitation('missing-native', 'native-request')).rejects.toThrow('[NOT_FOUND]');
      await invoke('local-db:bots:create', { id: 'archived-native', name: 'Archived native', prepareInvitation: false });
      h.sqlite!.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = ?").run('archived-native');
      await expect(prepareImportedBotInvitation('archived-native', 'native-request')).rejects.toThrow('[NOT_FOUND]');
      expect(queued).not.toHaveBeenCalled();
    } finally { queued.mockRestore(); }
  });

  // #6897 (existing SQLite integration fixture): sync bookkeeping cannot be the only guard against
  // publishing a fallback. Existing avatar tests never persisted this provenance.
  it('persists cloud fallback provenance with the avatar and only releases it for a real image', async () => {
    const created = await createBotProfile({ name: 'Restored fallback', avatar: '🤖' }, { avatarFallback: true });
    const readProvenance = (botId = created.id) => {
      const row = h.sqlite!.prepare(`SELECT v.capabilities_json AS json FROM bot_profiles p
        JOIN bot_profile_versions v ON v.bot_id = p.id AND v.version = p.current_version WHERE p.id = ?`)
        .get(botId) as { json: string };
      return JSON.parse(row.json).cloudAvatarFallback;
    };
    expect(readProvenance()).toBe(true);
    await updateStoredBotProfile({ id: created.id, name: 'Renamed fallback',
      capabilities: { cloudAvatarFallback: false } });
    expect(readProvenance()).toBe(true);
    await updateStoredBotProfile({ id: created.id, avatar: '🦊' }, undefined, undefined, { avatarFallback: false });
    expect(readProvenance()).toBeUndefined();
    await updateStoredBotProfile({ id: created.id, avatar: '🤖' }, undefined, undefined, { avatarFallback: true });
    expect(readProvenance()).toBe(true);
    const original = await createBotProfile({ name: 'Real image source' });
    const image = { buffer: readFileSync(resolveSafe(original.avatar).absPath), mimeType: 'image/png' };
    await expect(setBotProfileAvatar(created.id, image, 0)).rejects.toThrow('PRECONDITION_FAILED');
    expect(readProvenance()).toBe(true);
    const updated = await setBotProfileAvatar(created.id, image);
    expect(updated.avatar).toBe(original.avatar);
    expect(readProvenance()).toBeUndefined();
    await updateStoredBotProfile({ id: created.id, capabilities: { cloudAvatarFallback: true } });
    expect(readProvenance()).toBeUndefined();
    const untrusted = await createBotProfile({ name: 'Ordinary emoji', avatar: '🤖', capabilities: { cloudAvatarFallback: true } });
    expect(readProvenance(untrusted.id)).toBeUndefined();
  });

  it('creates a real gallery portrait when the shared tool entry receives only a name', async () => {
    const { createBotProfile } = await import('../bots');
    const created = await createBotProfile({ name: 'Name only' });
    expect(created.avatar).toMatch(/^cindy-media:\/\/blobs\/[a-f0-9]{64}\.png$/);
    const sharp = (await import('sharp')).default;
    const stored = readFileSync(resolveSafe(created.avatar).absPath);
    expect(await sharp(stored).metadata()).toMatchObject({ width: 256, height: 256 });
    expect(h.sqlite!.prepare('SELECT hash, ref_kind FROM media_refs WHERE ref_id = ?').get(created.id))
      .toEqual({ hash: createHash('sha256').update(stored).digest('hex'), ref_kind: 'bot-avatar' });
    const next = await createBotProfile({ name: 'Another name' });
    expect(next.avatar).not.toBe(created.avatar);
    expect((await invoke('local-db:bots:get', created.id)).avatar).toBe(created.avatar);
  });

  it.each(['available', 'implicit', 'disconnected', 'deleted'])('advertises a live mobile creation default: %s', async state => {
    const { botRemoteManagement } = await import('../botRemoteManagement');
    const route: BotModelRoute = { harness: 'pi', providerId: state === 'implicit' ? null : 'xd', model: 'z-ai/glm-5.3-flash', effort: 'high', fastMode: false };
    const readDefault = vi.spyOn(modelSettings, 'readEffectiveBotModelChain').mockResolvedValue([route]);
    try {
      if (state === 'disconnected') h.providers[0]!.connected = false;
      if (state === 'deleted') h.providers = [];
      const resource = await botRemoteManagement.getEditor({ controllerDeviceId: 'mobile-default-test' }, 'create', 'en');
      const data = resource.blocks?.find(block => block.id === 'create')?.data as { creationModelChain: string };
      expect(data.creationModelChain)
        .toBe(JSON.stringify((state === 'available' || state === 'implicit') ? [{ ...route, providerId: 'xd' }] : []));
      expect(await modelSettings.readEffectiveBotModelChain({})).toEqual([route]);
    } finally { readDefault.mockRestore(); }
  });

  it.each(['disconnected', 'deleted', 'empty'])('rechecks a mobile default that becomes %s after the form loads', async state => {
    const { botRemoteManagement } = await import('../botRemoteManagement');
    const context = { controllerDeviceId: 'mobile-stale-default' };
    const route: BotModelRoute = { harness: 'pi', providerId: 'xd', model: 'z-ai/glm-5.3-flash', effort: 'high', fastMode: false };
    const readDefault = vi.spyOn(modelSettings, 'readEffectiveBotModelChain').mockResolvedValue([route]);
    try {
      const resource = await botRemoteManagement.getEditor(context, 'create', 'en');
      const before = h.sqlite!.prepare('SELECT id FROM bot_profiles').all();
      if (state === 'disconnected') h.providers[0]!.connected = false;
      if (state === 'deleted') h.providers = [];
      if (state === 'empty') readDefault.mockResolvedValue([]);
      const sharp = (await import('sharp')).default;
      const bytes = await sharp(resolve(__dirname, '../../../../renderer/assets/bot-presets/cindy.png')).resize(256, 256).jpeg({ quality: 80 }).toBuffer();
      await expect(botRemoteManagement.invoke(context, {
        collectionId: 'teammates', resourceRef: resource.ref, actionId: resource.actions![0].id,
        client: { protocolVersion: 1, primitives: ['form'], locale: 'en' },
        input: { name: 'Stale default', avatarImageBase64: bytes.toString('base64'), requestId: 'stale-default-intent-001' },
      })).rejects.toThrow('Model route unavailable');
      expect(h.sqlite!.prepare('SELECT id FROM bot_profiles').all()).toEqual(before);
    } finally { readDefault.mockRestore(); }
  });

  it('reconciles mobile creation after a lost receipt without bypassing invitation preparation', async () => {
    const { botRemoteManagement } = await import('../botRemoteManagement');
    const sharp = (await import('sharp')).default;
    const bytes = await sharp(resolve(__dirname, '../../../../renderer/assets/bot-presets/cindy.png')).resize(256, 256).jpeg({ quality: 80 }).toBuffer();
    const context = { controllerDeviceId: 'mobile-creation-test' };
    const client = { protocolVersion: 1, primitives: ['form'], locale: 'zh-CN' };
    const input = { name: '手机创建的伙伴', avatarImageBase64: bytes.toString('base64'), requestId: 'mobile-creation-intent-001' };
    const submit = async () => {
      const resource = await botRemoteManagement.getEditor(context, 'create', 'zh-CN');
      return botRemoteManagement.invoke(context, { collectionId: 'teammates', resourceRef: resource.ref, actionId: resource.actions![0].id, client, input });
    };
    const first = await submit();
    const target = first.effects.find(effect => effect.kind === 'navigate');
    if (target?.kind !== 'navigate' || target.target.kind !== 'resource') throw Error('Missing creation receipt');
    const botId = target.target.ref.id;
    const profile = await invoke('local-db:bots:get', botId);
    expect(profile.canonicalSessionId).toBeUndefined();
    expect(profile.invitation).toMatchObject({ stage: 'skills' });
    const preparing = await botRemoteManagement.getInvitation(context, botId);
    expect(preparing.blocks).toContainEqual(expect.objectContaining({ id: 'invitation', data: { stage: 'skills' } }));
    expect(preparing.links).toEqual([]);
    expect(readFileSync(resolveSafe(profile.avatar).absPath)).toEqual(bytes);
    // Receipt recovery must still return the existing teammate after its provider disconnects.
    h.providers[0]!.connected = false;
    try { expect(await submit()).toEqual(first); }
    finally { h.providers[0]!.connected = true; }
    // The host invitation worker owns progress; a reconnect cannot advance it.
    expect((await invoke('local-db:bots:get', botId)).invitation.stage).toBe('skills');
    h.sqlite!.prepare("UPDATE bot_profile_versions SET capabilities_json = json_set(capabilities_json, '$.invitation.stage', 'failed') WHERE bot_id = ?").run(botId);
    const failed = await botRemoteManagement.getInvitation(context, botId);
    const invitation = await import('../../../maker-ipc/botInvitation');
    const queued = vi.spyOn(invitation, 'queueBotInvitation').mockImplementation(() => {});
    try {
      await botRemoteManagement.invoke(context, { collectionId: 'teammates', resourceRef: failed.ref, actionId: failed.actions![0].id, client });
      expect(queued).toHaveBeenCalledWith(botId, expect.objectContaining({ createCanonicalSession: expect.any(Function) }), true);
    } finally { queued.mockRestore(); }
    const staleRetry = await botRemoteManagement.getInvitation(context, botId);
    h.sqlite!.prepare("UPDATE bot_profile_versions SET capabilities_json = json_set(capabilities_json, '$.invitation.stage', 'ready') WHERE bot_id = ?").run(botId);
    await expect(botRemoteManagement.invoke(context, { collectionId: 'teammates', resourceRef: staleRetry.ref, actionId: staleRetry.actions![0].id, client })).rejects.toThrow('Resource changed');
    await submit();
    const ready = await invoke('local-db:bots:get', botId);
    expect(ready.canonicalSessionId).toBeTruthy();
    await updateStoredBotProfile({ id: botId, name: '后来在电脑上改的名字' });
    expect(await submit()).toEqual(first);
    expect(await invoke('local-db:bots:get', botId)).toMatchObject({ name: '后来在电脑上改的名字', canonicalSessionId: ready.canonicalSessionId });
    expect(h.sqlite!.prepare('SELECT id FROM bot_profiles WHERE id = ?').all(botId)).toHaveLength(1);
  });

  it('allows creating and renaming an ordinary Cindy after the old Cindy is deleted', async () => {
    await invoke('local-db:bots:create', { id: 'removed-cindy', name: 'Cindy', templateId: 'cindy' });
    h.sqlite!.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = 'removed-cindy'").run();
    await h.tx!('bots.deleteProfile', { botId: 'removed-cindy', sessionIds: [], keepTaskHistory: true, at: Date.now() });
    const bytes = readFileSync(resolve(__dirname, '../../../../renderer/assets/bot-presets/cindy.png'));
    const created = await invoke('local-db:bots:create', {
      id: 'new-cindy', name: 'Cindy', avatarImageBase64: bytes.toString('base64'),
    });
    expect(created.id).toBe('new-cindy');
    expect(created.templateId).toBeUndefined();
    await invoke('local-db:bots:update', { id: 'new-cindy', name: 'Another name' });
    const renamed = await invoke('local-db:bots:update', { id: 'bot-1', name: ' cindy ' });
    expect(renamed.name.trim()).toBe('cindy');
    expect(renamed.templateId).toBeUndefined();
  });

  it('saves a chosen Cindy portrait without changing the existing identity or canonical chat', async () => {
    h.showOpenDialog.mockClear();
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const before = await invoke('local-db:bots:get', 'bot-1');
    const bytes = readFileSync(resolve(__dirname, '../../../../renderer/assets/bot-presets/cindy.png'));
    const result = await invoke('local-db:bots:choose-avatar', {
      botId: 'bot-1', avatarImageBase64: bytes.toString('base64'),
    });
    expect(result.canceled).toBe(false);
    expect(result.profile).toMatchObject({ name: before.name, identitySource: before.identitySource,
      canonicalSessionId: canonical.canonicalSessionId, capabilities: before.capabilities });
    expect(result.profile.templateId).toBe(before.templateId);
    expect(readFileSync(resolveSafe(result.profile.avatar).absPath)).toEqual(bytes);
    expect(h.showOpenDialog).not.toHaveBeenCalled();
    expect(h.sqlite!.prepare("SELECT ref_id, ref_kind FROM media_refs WHERE ref_id = 'bot-1'").all())
      .toEqual([{ ref_id: 'bot-1', ref_kind: 'bot-avatar' }]);
  });

  it.each(['not base64', Buffer.from('not an image').toString('base64'), ''])('rejects invalid avatar bytes %j without a native dialog or profile change', async avatarImageBase64 => {
    h.showOpenDialog.mockClear();
    const before = await invoke('local-db:bots:get', 'bot-1');
    await expect(invoke('local-db:bots:choose-avatar', { botId: 'bot-1', avatarImageBase64 }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(await invoke('local-db:bots:get', 'bot-1')).toEqual(before);
    expect(h.showOpenDialog).not.toHaveBeenCalled();
  });

  // #6889 unit: exercise the registered Bot source IPC in local mode,
  // including sender and owner-boundary errors. Existing tests only saved
  // avatars for an already-created Bot; source preparation must not mutate it.
  it('prepares a Bot avatar source in local mode without a profile write', async () => {
    h.ownerScopeKey = 'local:fixture:1';
    const filePath = resolve(__dirname, '../../../../renderer/assets/bot-presets/cindy.png');
    h.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [filePath] });
    const before = await invoke('local-db:bots:get', 'bot-1');
    const source = await invoke('local-db:bots:choose-avatar-source', undefined);
    expect(source).toEqual({ canceled: false, previewDataUrl: `data:image/png;base64,${readFileSync(filePath).toString('base64')}` });
    expect(await invoke('local-db:bots:get', 'bot-1')).toEqual(before);
  });

  it('rejects an untrusted source chooser before opening a file dialog', async () => {
    h.showOpenDialog.mockClear();
    vi.mocked(assertTrustedAppRendererEvent).mockImplementationOnce(() => { throw new Error('untrusted'); });
    await expect(invoke('local-db:bots:choose-avatar-source', undefined)).rejects.toThrow('untrusted');
    expect(h.showOpenDialog).not.toHaveBeenCalled();
  });

  it('discards a source chooser result after changing owners', async () => {
    h.showOpenDialog.mockImplementationOnce(async () => {
      h.ownerScopeKey = 'another-owner';
      return { canceled: true, filePaths: [] };
    });
    await expect(invoke('local-db:bots:choose-avatar-source', undefined)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('retains the old host file chooser when no gallery bytes are supplied', async () => {
    h.showOpenDialog.mockClear();
    await expect(invoke('local-db:bots:choose-avatar', { botId: 'bot-1' })).resolves.toEqual({ canceled: true });
    expect(h.showOpenDialog).toHaveBeenCalledOnce();
  });

  it('retains copied image bytes through an independent media ref after the source is deleted', async () => {
    const { createBotProfile } = await import('../bots');
    const source = await createBotProfile({ name: 'Original portrait' });
    const bytes = readFileSync(resolveSafe(source.avatar).absPath);
    const copy = await createBotProfile({ name: 'Copied portrait', avatar: source.avatar,
      avatarImageBase64: bytes.toString('base64') });
    expect(copy.avatar).toBe(source.avatar);
    expect(h.sqlite!.prepare('SELECT COUNT(*) AS n FROM media_refs WHERE hash = ?')
      .get(createHash('sha256').update(bytes).digest('hex'))).toEqual({ n: 2 });
    h.sqlite!.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = ?").run(source.id);
    await h.tx!('bots.deleteProfile', { botId: source.id, sessionIds: [], keepTaskHistory: false, at: Date.now() });
    expect((await invoke('local-db:bots:get', copy.id)).avatar).toBe(source.avatar);
    expect(readFileSync(resolveSafe(copy.avatar).absPath)).toEqual(bytes);
    expect(h.sqlite!.prepare('SELECT ref_id FROM media_refs WHERE hash = ?')
      .all(createHash('sha256').update(bytes).digest('hex'))).toEqual([{ ref_id: copy.id }]);
  });

  it.each(['legacy IPC', 'resource registry'])('provides Cindy on first Mobile entry via %s and shares the receipt after deletion', async entry => {
    const real = await vi.importActual<typeof import('../../../maker-ipc/botDefaultProvisioning')>(
      '../../../maker-ipc/botDefaultProvisioning');
    vi.mocked(provisionDefaultBot).mockImplementation(real.provisionDefaultBot);
    h.sqlite!.prepare('DELETE FROM bot_profiles').run();
    // A fresh owner has no receipt, roster or history. No desktop list has run.
    h.ownerScopeKey = `mobile-first-${entry}:1`;
    const legacyList = () => runDeviceLinkInvokeContext(
      { controllerDeviceId: 'mobile-first', channel: 'local-db:bots:list' },
      () => invoke('local-db:bots:list', undefined),
    );
    const { registerBotRemoteResourceProvider } = await import('../botRemoteResourceProvider');
    const { remoteResourceRegistry } = await import('../../../device-link/remoteResourceRegistry');
    registerBotRemoteResourceProvider();
    const mobileList = entry === 'legacy IPC' ? legacyList : async () => {
      const result = await remoteResourceRegistry.list({ controllerDeviceId: 'mobile-first' }, {
        client: { protocolVersion: 1, primitives: ['markdown'] }, collectionId: 'teammates',
      });
      return result.items.map(item => ({ id: item.ref.id, name: item.display.title }));
    };
    const first = await mobileList();
    expect(first).toEqual([expect.objectContaining({ id: 'cindy-default', name: 'Cindy' })]);
    expect(first[0]).not.toHaveProperty('identitySource');
    await invoke('local-db:bots:list', undefined);
    expect(h.sqlite!.prepare('SELECT COUNT(*) AS n FROM bot_profiles').get()).toEqual({ n: 1 });
    // Removing even all history cannot undo the account's one-time receipt.
    h.sqlite!.prepare('DELETE FROM bot_profiles').run();
    await expect(mobileList()).resolves.toEqual([]);
    await expect(invoke('local-db:bots:list', undefined)).resolves.toEqual([]);
  });

  it.each(['legacy IPC', 'resource registry'])('queues committed Cindy before a failed projection on first %s entry', async (entry) => {
    const real = await vi.importActual<typeof import('../../../maker-ipc/botDefaultProvisioning')>(
      '../../../maker-ipc/botDefaultProvisioning');
    vi.mocked(provisionDefaultBot).mockImplementation(real.provisionDefaultBot);
    h.sqlite!.prepare('DELETE FROM bot_profiles').run();
    h.ownerScopeKey = `mobile-projection-failure-${entry}:1`;
    const invitation = await import('../../../maker-ipc/botInvitation');
    const queued = vi.spyOn(invitation, 'queueBotInvitation').mockImplementation(() => {});
    let projectionFailed = false;
    h.listProviders.mockImplementation(async () => {
      if (!projectionFailed && h.sqlite!.prepare("SELECT id FROM bot_profiles WHERE id = 'cindy-default'").get()) {
        // A provider read after the create transaction, before the presentation
        // can complete. The invitation must already be queued at this point.
        expect(queued).toHaveBeenCalledWith('cindy-default', expect.any(Object), false);
        projectionFailed = true;
        throw new Error('Temporary provider projection failure');
      }
      return h.providers;
    });
    try {
      const list: () => Promise<{ id: string }[]> = entry === 'legacy IPC' ? () => runDeviceLinkInvokeContext(
        { controllerDeviceId: 'mobile-first', channel: 'local-db:bots:list' },
        () => invoke('local-db:bots:list', undefined),
      ) : listBotRemoteResourceSources;
      expect((await list()).map(row => row.id)).toEqual(['cindy-default']);
      expect(projectionFailed).toBe(true);
      expect(queued).toHaveBeenCalledTimes(1);
      const stored = h.sqlite!.prepare("SELECT capabilities_json AS config FROM bot_profile_versions WHERE bot_id = 'cindy-default'").get() as { config: string };
      expect(JSON.parse(stored.config).invitation).toMatchObject({ stage: 'skills' });
      // A second remote read only sees durable history. It must not be needed
      // to repair the lost queue entry, or create a second default teammate.
      expect((await list()).map(row => row.id)).toEqual(['cindy-default']);
      expect(queued).toHaveBeenCalledTimes(1);
    } finally {
      queued.mockRestore();
    }
  });

  it('rejects a remote list when its owner changes during provisioning', async () => {
    vi.mocked(provisionDefaultBot).mockImplementationOnce(async () => { h.ownerScopeKey = 'other:2'; });
    await expect(runDeviceLinkInvokeContext(
      { controllerDeviceId: 'mobile-first', channel: 'local-db:bots:list' },
      () => invoke('local-db:bots:list', undefined),
    )).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
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
      expect(projection).not.toHaveProperty('hiddenAt');
    }
  });

  it.each(['hidden', 'archived'])('rejects a discovered Bot ID after becoming %s while preserving local recovery', async (state) => {
    const remoteList = () => runDeviceLinkInvokeContext(
      { controllerDeviceId: 'remote-mac', channel: 'local-db:bots:list' },
      () => invoke('local-db:bots:list', undefined),
    );
    const remoteGet = (id: string) => runDeviceLinkInvokeContext(
      { controllerDeviceId: 'remote-mac', channel: 'local-db:bots:get' },
      () => invoke('local-db:bots:get', id),
    );
    const [discovered] = await remoteList() as Array<{ id: string }>;
    await expect(remoteGet(discovered.id)).resolves.toMatchObject({ id: discovered.id });
    if (state === 'hidden') h.sqlite!.prepare('UPDATE bot_profiles SET hidden_at = ? WHERE id = ?').run(200, discovered.id);
    else h.sqlite!.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = ?").run(discovered.id);
    await expect(remoteList()).resolves.toEqual([]);
    await expect(remoteGet(discovered.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(invoke('local-db:bots:get', discovered.id)).resolves.toMatchObject({ id: discovered.id });
    expect(await invoke('local-db:bots:list', undefined)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: discovered.id }),
    ]));
    h.sqlite!.prepare("UPDATE bot_profiles SET hidden_at = NULL, status = 'active' WHERE id = ?").run(discovered.id);
    await expect(remoteGet(discovered.id)).resolves.toMatchObject({ id: discovered.id });
    expect(await remoteList()).toEqual([expect.objectContaining({ id: discovered.id })]);
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

  it('keeps an unconfigured profile but rejects a model-less canonical task', async () => {
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

    await expect(invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-pi-default',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    })).rejects.toThrow('请先连接模型供应商或选择伙伴模型');
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

  it('creates one IM channel lane per route key, notifies the task list and keeps it out of private history search', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    vi.mocked(emitSessionCreated).mockClear();
    const routeKey = 'im:telegram:777:g:-100123';
    const first = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey, title: '[TG·群] 100123' });
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) throw new Error(first.message);
    await expect(ensureBotChannelLaneSession({ botId: 'bot-1', routeKey, title: 'ignored' }))
      .resolves.toEqual({ ok: true, sessionId: first.sessionId, created: false });
    // The owner archived the lane from the task list: the next message resumes it, not a second lane.
    // Restoring re-reads the task row with its tags, as in the production schema.
    h.sqlite!.exec(`CREATE TABLE IF NOT EXISTS task_tags(id TEXT PRIMARY KEY,name TEXT,color TEXT,favorite_order INTEGER,sort_order INTEGER,revision INTEGER,name_customized INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS session_task_tags(session_id TEXT,tag_id TEXT);`);
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(first.sessionId);
    await expect(ensureBotChannelLaneSession({ botId: 'bot-1', routeKey, title: 'ignored' }))
      .resolves.toEqual({ ok: true, sessionId: first.sessionId, created: false });
    expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').get(first.sessionId)).toEqual({ status: 'active' });
    // A restore failure other than deletion must surface for retry, never replace the lane.
    h.sqlite!.prepare("UPDATE sessions SET status = 'archived', orca_role = 'worker' WHERE id = ?").run(first.sessionId);
    await expect(ensureBotChannelLaneSession({ botId: 'bot-1', routeKey, title: 'ignored' }))
      .rejects.toThrow(/Restore the managed task/);
    h.sqlite!.prepare("UPDATE sessions SET status = 'active', orca_role = NULL WHERE id = ?").run(first.sessionId);
    expect(emitSessionCreated).toHaveBeenCalledExactlyOnceWith(first.sessionId);
    await expect(findBotChannelLaneSession('bot-1', routeKey)).resolves.toBe(first.sessionId);
    const canonical = h.sqlite!.prepare(
      'SELECT working_dir AS workingDir, model, permission_mode AS permissionMode FROM sessions WHERE id = ?',
    ).get(created.session.id);
    // Same Home workspace, model and permission profile as the canonical chat.
    expect(h.sqlite!.prepare(
      `SELECT s.source, s.status, s.title, s.workspace_kind AS workspaceKind, s.working_dir AS workingDir,
              s.model, s.permission_mode AS permissionMode, l.role, l.route_key AS routeKey
       FROM sessions s JOIN bot_session_links l ON l.session_id = s.id WHERE s.id = ?`,
    ).get(first.sessionId)).toEqual({
      source: 'bot',
      status: 'active',
      title: '[TG·群] 100123',
      workspaceKind: 'dialogue',
      role: 'channel',
      routeKey,
      ...canonical as object,
    });

    const [profile] = await invoke('local-db:bots:list', undefined);
    expect(profile.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.sessionId, kind: 'channel', role: 'channel' }),
    ]));

    h.searchConversations.mockResolvedValue({
      query: 'release', results: [], vectorUsed: false, vectorSkipReason: null, poolCapped: false,
    });
    await invoke('local-db:bots:search-history', { botId: 'bot-1', query: 'release', limit: 5 });
    expect(h.searchConversations).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ sessionIds: [created.session.id] }) }),
      { sessionSources: null },
    );

    await expect(archiveBotChannelLanes({ routeKeyPrefix: 'im:telegram:777:' }))
      .resolves.toEqual([first.sessionId]);
    await expect(findBotChannelLaneSession('bot-1', routeKey)).resolves.toBeNull();
    const fresh = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey, title: '[TG·群] 100123' });
    expect(fresh).toMatchObject({ ok: true, created: true });
    expect(fresh.ok && fresh.sessionId).not.toBe(first.sessionId);
  });

  // Same topic contract through the authorized mobile channel, including empty lanes and roots with colons (unit).
  it.each(['local', 'remote'])('opens one private-chat topic per main-chat message via %s, with its own context note and timeline entry', async (entry) => {
    const topicInvoke = async (channel: string, body: unknown): Promise<any> => entry === 'local' ? invoke(channel, body)
      : runDeviceLinkInvokeContext({ controllerDeviceId: 'mobile-1', channel }, () => h.handlers.get(channel)!({}, body));
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const chatId = created.session.id;
    const insert = h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    // Host-written messages such as the opening hello carry colons in their clientId.
    insert.run('m-root', 'bot-opening:inv-1', chatId, 'user', JSON.stringify({ text: 'Plan the launch post' }), 1_000);
    const root = { botId: 'bot-1', rootSessionId: chatId, rootClientId: 'bot-opening:inv-1' };

    // A root outside the companion's main Chat cannot carry a topic.
    await expect(topicInvoke('local-db:bots:dm-thread:ensure', { ...root, rootClientId: 'missing' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'ROOT_UNAVAILABLE' });
    const first = await topicInvoke('local-db:bots:dm-thread:ensure', { ...root, title: 'Plan the launch post' });
    expect(first).toMatchObject({ ok: true, created: true });
    await expect(topicInvoke('local-db:bots:dm-thread:ensure', root))
      .resolves.toEqual({ ok: true, sessionId: first.sessionId, created: false });
    const canonical = h.sqlite!.prepare('SELECT working_dir AS workingDir, permission_mode AS permissionMode FROM sessions WHERE id = ?')
      .get(chatId);
    expect(h.sqlite!.prepare(`SELECT s.source, s.working_dir AS workingDir, s.permission_mode AS permissionMode,
        l.role, l.route_key AS routeKey FROM sessions s JOIN bot_session_links l ON l.session_id = s.id WHERE s.id = ?`)
      .get(first.sessionId)).toEqual({ source: 'bot', role: 'thread', routeKey: `dm-thread:${chatId}:bot-opening:inv-1`, ...canonical as object });
    const [profile] = await invoke('local-db:bots:list', undefined);
    expect(profile.sessions).toEqual(expect.arrayContaining([expect.objectContaining({
      id: first.sessionId, kind: 'thread', threadRoot: { rootSessionId: chatId, rootClientId: 'bot-opening:inv-1' },
    })]));

    const remoteProfile = await runDeviceLinkInvokeContext({ controllerDeviceId: 'mobile-1', channel: 'local-db:bots:get' },
      () => h.handlers.get('local-db:bots:get')!({}, 'bot-1'));
    expect(remoteProfile).toMatchObject({ dmThreadsSupported: true, sessions: expect.arrayContaining([
      { id: first.sessionId, role: 'thread', status: 'active', threadRoot: { rootSessionId: chatId, rootClientId: 'bot-opening:inv-1' } },
    ]) });

    // Opened and left empty: no entry under the root yet.
    await expect(topicInvoke('local-db:bots:dm-thread:list', { botId: 'bot-1', rootSessionId: chatId })).resolves.toEqual([]);
    insert.run('t-1', 'topic-1', first.sessionId, 'user', JSON.stringify({ text: 'Shorter, please' }), 2_000);
    insert.run('t-2', 'topic-2', first.sessionId, 'assistant', JSON.stringify('Here is a shorter draft.'), 3_000);
    await expect(topicInvoke('local-db:bots:dm-thread:list', { botId: 'bot-1', rootSessionId: chatId })).resolves.toEqual([{
      sessionId: first.sessionId, rootSessionId: chatId, rootClientId: 'bot-opening:inv-1',
      replyCount: 2, lastReplyAt: 3_000, lastAssistantAt: 3_000, createdAt: expect.any(Number),
    }]);

    // The topic's model context names its root; a rewound root is reported as unavailable, not guessed.
    const { readBotDmThreadContextNote } = await import('../../../maker-ipc/botDmThreadContext');
    await expect(readBotDmThreadContextNote(first.sessionId)).resolves.toContain('Plan the launch post');
    await expect(readBotDmThreadContextNote(chatId)).resolves.toBeNull();
    h.sqlite!.prepare("UPDATE messages SET rewind_at = 5000 WHERE id = 'm-root'").run();
    const note = await readBotDmThreadContextNote(first.sessionId);
    expect(note).toContain('不可用');
    expect(note).not.toContain('Plan the launch post');
  });

  it('gives the companion the quoted message of a quote reply, re-read from its own chat', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const chatId = created.session.id;
    h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('m-quoted', 'quoted-1', chatId, 'assistant', JSON.stringify('Ship the launch post on Friday.'), 1_000);
    const { readReplyQuoteNote } = await import('../../../maker-ipc/chatReplyQuoteNote');
    const sent = (replyQuote: unknown) => JSON.stringify({ text: 'Why Friday?', images: [], files: [], replyQuote });
    // The original comes from the chat itself; the excerpt the renderer sent is display only.
    const note = await readReplyQuoteNote(chatId, sent({ clientId: 'quoted-1', role: 'assistant', excerpt: 'forged' }));
    expect(note).toContain('Ship the launch post on Friday.');
    expect(note).not.toContain('forged');
    await expect(readReplyQuoteNote(chatId, sent({ clientId: 'quoted-1', role: 'system', excerpt: '' }))).resolves.toBeNull();
    await expect(readReplyQuoteNote(chatId, JSON.stringify({ text: 'no quote', images: [], files: [] }))).resolves.toBeNull();
    // A quote that points elsewhere or at a rewound row says the original is unavailable.
    await expect(readReplyQuoteNote('other-session', sent({ clientId: 'quoted-1', role: 'assistant', excerpt: '' })))
      .resolves.toContain('不可用');
    h.sqlite!.prepare("UPDATE messages SET rewind_at = 5000 WHERE id = 'm-quoted'").run();
    const rewound = await readReplyQuoteNote(chatId, sent({ clientId: 'quoted-1', role: 'assistant', excerpt: '' }));
    expect(rewound).toContain('不可用');
    expect(rewound).not.toContain('Ship the launch post');
    // An owner message with only an attachment is still there, not "unavailable".
    h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('m-image', 'image-1', chatId, 'user', JSON.stringify({ text: '', images: [{ url: 'x', originalName: 'chart.png' }], files: [] }), 2_000);
    const imageOnly = await readReplyQuoteNote(chatId, sent({ clientId: 'image-1', role: 'user', excerpt: 'chart.png' }));
    expect(imageOnly).toContain('chart.png');
    expect(imageOnly).not.toContain('不可用');
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

  it.each([
    { agentKind: 'codex' as const, helperEnabled: true },
    { agentKind: 'claude-code' as const, helperEnabled: true },
    { agentKind: 'codex' as const, helperEnabled: false },
    { agentKind: 'claude-code' as const, helperEnabled: false },
  ])('resolves remote capabilities and helper guidance from the same catalog ($agentKind, helper=$helperEnabled)', async ({ agentKind, helperEnabled }) => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const inputs: Array<{ kind: string; remoteHostId?: string }> = [];
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind,
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
        return [{
          id: 'xdt_helper', name: 'Helper', essential: true,
          available: helperEnabled && isBotToolsetAvailableOnTarget({ ...input, toolsetId: 'xdt_helper' }),
        }];
      },
    });

    expect(inputs).toEqual([
      { kind: 'skills', remoteHostId: 'remote-host-1' },
      { kind: 'mcp', remoteHostId: 'remote-host-1' },
      { kind: 'toolsets', remoteHostId: 'remote-host-1' },
    ]);
    const policy = opts.botRuntimeProfile!.toolsetPolicy;
    const allowed = resolveBotAllowedBuiltinPluginIds(policy.catalog, policy.configured);
    expect(allowed.includes('xdt_helper')).toBe(helperEnabled);
    expect(opts.botProfileContextPrompt?.includes('`list_agents`')).toBe(helperEnabled);
    expect(opts.botProfileContextPrompt?.includes('`find_teammate_capabilities`')).toBe(helperEnabled);
    // Remote Claude/Codex mount helper but not the cindy plugin gateway.
    expect(opts.botProfileContextPrompt).not.toContain('ghost_list');
    expect(opts.botProfileContextPrompt).not.toContain('ghost_call');
  });

  it('keeps plugin discovery guidance for remote Pi because cindy is tunneled', async () => {
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
      workspaceKind: 'project',
      model: 'grok-4.5',
      permissionMode: 'ask',
    };

    await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [],
      listMcpServers: async () => [],
      listToolsets: async () => [{
        id: 'xdt_helper', name: 'Helper', essential: true, available: true,
      }],
    });

    expect(opts.botProfileContextPrompt).toContain('`find_teammate_capabilities`');
    expect(opts.botProfileContextPrompt).toContain('ghost_list');
    expect(opts.botProfileContextPrompt).toContain('ghost_call');
  });

  it('inherits MCP and tools while preserving the companion Skill selection', async () => {
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
      mcpPolicy: { mode: 'allowlist', configured: ['docs'] },
      toolsetPolicy: { mode: 'allowlist', configured: ['browser'] },
    });
  });

  it.each([
    { versioned: false, selected: true, mode: 'inherit', expectedMcp: ['docs', 'mail'], expectedTools: ['browser', 'calendar'] },
    { versioned: false, selected: false, mode: 'inherit', expectedMcp: ['docs', 'mail'], expectedTools: ['browser', 'calendar'] },
    { versioned: true, selected: false, mode: 'allowlist', expectedMcp: [], expectedTools: [] },
    { versioned: true, selected: true, mode: 'allowlist', expectedMcp: ['docs'], expectedTools: ['browser'] },
  ])('keeps stored capability selections consistent in settings and runtime: %j', async (entry) => {
    const row = h.sqlite!.prepare('SELECT capabilities_json FROM bot_profile_versions WHERE bot_id = ? AND version = 1')
      .get('bot-1') as { capabilities_json: string };
    const config = { ...JSON.parse(row.capabilities_json),
      toolsetMode: 'allowlist', toolsets: entry.selected ? ['browser'] : [],
      mcpMode: 'allowlist', mcpServers: entry.selected ? ['docs'] : [],
    };
    if (entry.versioned) config.toolCapabilityVersion = 1;
    else delete config.toolCapabilityVersion;
    h.sqlite!.prepare('UPDATE bot_profile_versions SET capabilities_json = ? WHERE bot_id = ? AND version = 1')
      .run(JSON.stringify(config), 'bot-1');
    const loaded = await invoke('local-db:bots:get', 'bot-1');
    expect(loaded.capabilities).toMatchObject({ toolsetMode: entry.mode, mcpMode: entry.mode });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id, agentKind: 'pi', workingDir: created.session.workingDir,
      workspaceKind: 'dialogue', model: 'grok-4.5', permissionMode: 'ask',
    };
    await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [],
      listMcpServers: async () => ['docs', 'mail'].map(name => ({ name, source: 'custom', available: true })),
      listToolsets: async () => ['browser', 'calendar'].map(id => ({ id, name: id, available: true })),
    });
    expect(opts.botRuntimeProfile).toMatchObject({
      mcpPolicy: { mode: 'allowlist', configured: entry.expectedMcp },
      toolsetPolicy: { mode: 'allowlist', configured: entry.expectedTools },
    });
  });

  // DB regression: shared learning used to leave running chats with the old
  // memory/Skill index. Exercise hydrate + persisted applied snapshots, not hash
  // implementation details; the minimal mutation keeps Profile and paths fixed.
  it.each(['canonical', 'channel', 'thread'])('refreshes shared learned resources in a running %s chat', async role => {
    // Model successive completed bootstraps at distinct persisted times. Real
    // millisecond ties otherwise make the existing latest-snapshot query arbitrary.
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => ++now);
    try {
      const created = await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
      });
      h.sqlite!.prepare('UPDATE bot_session_links SET role=? WHERE session_id=?').run(role, created.session.id);
      const makeOpts = (): MakerSessionCreateOpts => ({
        id: created.session.id, agentKind: 'codex', workingDir: created.session.workingDir,
        workspaceKind: 'dialogue', model: 'gpt-5', permissionMode: 'bypassPermissions',
      });
      let index = '# Memory\n';
      let updatedAt = 'v1';
      const deps = {
        readMemoryIndex: async () => index,
        listOwnSkills: async () => ({ pluginRoot: '/skills', skills: [{
          name: 'report', description: 'A verified report format', path: '/skills/report', updatedAt,
        }] }),
      };
      const initial = await hydrateBotProfileRuntime(makeOpts(), deps);
      await markBotProfileRuntimeApplied(initial!);
      expect((await hydrateBotProfileRuntime(makeOpts(), deps))?.runtimeEpochChanged).toBe(false);
      index += '- [Conclusion first](feedback_conclusion.md)\n';
      const changed = await hydrateBotProfileRuntime(makeOpts(), deps);
      expect(changed?.runtimeEpochChanged).toBe(true);
      await markBotProfileRuntimeApplied(changed!);
      expect((await hydrateBotProfileRuntime(makeOpts(), deps))?.runtimeEpochChanged).toBe(false);
      updatedAt = 'v2';
      expect((await hydrateBotProfileRuntime(makeOpts(), deps))?.runtimeEpochChanged).toBe(true);
    } finally {
      clock.mockRestore();
    }
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
        baseline: { pluginRoot: '/userdata/managed-teammate-skills/v1', skill: {
          name: 'teammate-guide', description: 'Shared baseline',
          path: '/userdata/managed-teammate-skills/v1/skills/teammate-guide',
          filePath: '/userdata/managed-teammate-skills/v1/skills/teammate-guide/SKILL.md',
        } },
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
      { name: 'teammate-guide', description: 'Shared baseline',
        path: '/userdata/managed-teammate-skills/v1/skills/teammate-guide',
        filePath: '/userdata/managed-teammate-skills/v1/skills/teammate-guide/SKILL.md' },
      {
        name: 'weekly-report',
        description: 'How I put the weekly report together',
        path: '/userdata/bot-skills/bot-1/skills/weekly-report',
        filePath: '/userdata/bot-skills/bot-1/skills/weekly-report/SKILL.md',
      },
    ]);
    // Claude Code 只会开关它自己发现到的 Skill,所以还要给它一个本地 plugin 根。
    expect(opts.botRuntimeProfile?.skillPolicy.ownSkillPluginRoots).toEqual([
      '/userdata/managed-teammate-skills/v1',
      '/userdata/bot-skills/bot-1',
    ]);
    expect(opts.botProfileContextPrompt).toContain('Use `update_teammate_profile`');
    expect(opts.botProfileContextPrompt).not.toContain('direct the user to the teammate’s model settings');
    // The card details are on-demand (read_teammate_skill name=plugins); the core keeps the route.
    expect(opts.botProfileContextPrompt).toContain('Plugin logins go through `connect_account` cards on the trusted desktop.');
    expect(opts.botProfileContextPrompt).not.toContain('This remote runtime has no authorization cards');
    // 用户配的 Skill 那一栏不受影响。
    expect(opts.botRuntimeProfile?.skillPolicy.catalog).toEqual([]);
  });

  it.each(['pi', 'claude-code', 'codex'] as const)('does not advertise or mount local personal Skills on remote %s', async (agentKind) => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1',
      expectedCanonicalSessionId: null,
      expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: created.session.id,
      agentKind,
      workingDir: created.session.workingDir,
      workspaceKind: 'dialogue',
      model: 'grok-4.5',
      permissionMode: 'bypassPermissions',
      remoteHostId: 'box',
    };

    await hydrateBotProfileRuntime(opts, {
      listSkills: async () => [],
      listToolsets: async () => [{ id: 'xdt_helper', name: 'Helper', available: true }],
      listOwnSkills: async () => ({
        pluginRoot: '/userdata/bot-skills/bot-1',
        skills: [{ name: 'weekly-report', description: '', path: '/userdata/bot-skills/bot-1/skills/weekly-report' }],
      }),
    }, { persistSnapshot: false });

    // 路径是本机的,远端 harness 打不开 —— 挂一串死路径比不挂更糟。
    expect(opts.botRuntimeProfile?.skillPolicy.ownSkills).toBeUndefined();
    expect(opts.botRuntimeProfile?.skillPolicy.ownSkillPluginRoots).toBeUndefined();
    expect(opts.botProfileContextPrompt).not.toContain('`save_teammate_skill`');
    expect(opts.botProfileContextPrompt).not.toContain('`list_teammate_skills`');
    expect(opts.botProfileContextPrompt).not.toContain('then create or refine a useful personal Skill');
    expect(opts.botProfileContextPrompt).toContain('Personal Skill storage and learning are unavailable');
    expect(opts.botProfileContextPrompt).toContain('`create_teammate`');
    expect(opts.botProfileContextPrompt).toContain('`list_agents`');
    expect(opts.botProfileContextPrompt).toContain('Respect the memory switch');
    expect(opts.botProfileContextPrompt).toContain('Use `update_teammate_profile`');
    expect(opts.botProfileContextPrompt).not.toContain('direct the user to the teammate’s model settings');
    expect(opts.botProfileContextPrompt).not.toContain('Plugin logins go through `connect_account` cards');
    if (agentKind === 'pi') {
      expect(opts.botProfileContextPrompt).toContain('`ghost_list`, `ghost_info`, `ghost_call`');
      expect(opts.botProfileContextPrompt).toContain('This remote runtime has no authorization cards: point the user to the trusted desktop\'s Plugins page.');
    } else {
      expect(opts.botProfileContextPrompt).not.toContain('`ghost_call`');
    }
  });

  it.each(['canonical', 'delegation'] as const)('rejects remote %s personal Skill access before local storage or refresh', async (role) => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const sessionId = created.session.id;
    h.sqlite!.prepare('UPDATE sessions SET remote_host_id = ? WHERE id = ?').run('ssh-host', sessionId);
    h.sqlite!.prepare('UPDATE bot_session_links SET role = ? WHERE session_id = ?').run(role, sessionId);
    const userDataDir = join(h.userDataDir, `remote-skill-guard-${role}`);
    const requestRefresh = vi.fn(async () => true);
    const deps = { userDataDir, requestRefresh };
    const input = { callerSessionId: sessionId, name: 'Verified workflow', description: 'A reusable method', body: 'A verified sequence of steps.' };
    const rejected = { ok: false, errorCode: 'REMOTE_SKILLS_UNAVAILABLE' };
    expect(await listBotSkillsForSession({ callerSessionId: sessionId }, deps)).toMatchObject(rejected);
    expect(await saveBotSkillForSession(input, deps)).toMatchObject(rejected);
    expect(existsSync(userDataDir)).toBe(false);
    expect(requestRefresh).not.toHaveBeenCalled();

    // Device-link control of a desktop runtime is still local: the execution
    // target, not the caller's phone/transport, determines shelf availability.
    h.sqlite!.prepare('UPDATE sessions SET remote_host_id = NULL WHERE id = ?').run(sessionId);
    expect(await saveBotSkillForSession(input, deps)).toMatchObject({ ok: true, effective: 'next-turn' });
    expect(await listBotSkillsForSession({ callerSessionId: sessionId }, deps)).toMatchObject({
      ok: true, skills: [expect.objectContaining({ name: input.name })],
    });
    expect(requestRefresh).toHaveBeenCalledTimes(1);
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

    const initial = makeOpts();
    const first = await hydrateBotProfileRuntime(initial, {
      listSkills: async () => [],
      listOwnSkills: async () => ({ pluginRoot: '/userdata/bot-skills/bot-1', skills: [] }),
    });
    expect(initial.botProfileContextPrompt).toContain('save_teammate_skill');
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

  it('discovers and joins existing capabilities without copying connection secrets or changing another Bot', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', { botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1 });
    const callerSessionId = created.session.id;
    const discovered = await findBotCapabilities({ callerSessionId, kind: 'mcp' });
    expect(discovered).toMatchObject({ ok: true, capabilities: [{ id: 'shared-docs', joined: true, available: true }] });
    expect(JSON.stringify(discovered)).not.toMatch(/FAKE_SECRET|example.invalid|Authorization/);
    await expect(selectBotCapability({ callerSessionId, kind: 'mcp', id: 'shared-docs', joined: true })).resolves.toMatchObject({ ok: true, effective: 'next-turn' });
    await expect(findBotCapabilities({ callerSessionId, kind: 'mcp' })).resolves.toMatchObject({ capabilities: [{ id: 'shared-docs', joined: true }] });
    expect(h.requestRuntimeRefresh).toHaveBeenCalledWith(callerSessionId, 'profile');
    await expect(selectBotCapability({ callerSessionId, kind: 'skill', id: 'release-check', joined: true })).resolves.toMatchObject({ ok: true });
    await expect(findBotCapabilities({ callerSessionId, kind: 'skill' })).resolves.toMatchObject({ capabilities: [{ id: 'release-check', joined: true }] });
    await expect(selectBotCapability({ callerSessionId, kind: 'mcp', id: 'shared-docs', joined: false })).resolves.toMatchObject({ ok: true, joined: false });
    await expect(findBotCapabilities({ callerSessionId, kind: 'skill' })).resolves.toMatchObject({ capabilities: [{ id: 'release-check', joined: true }] });
  });

  it('keeps an active official skill authoritative over its namesake until it is turned off', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', { botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1 });
    const input = { callerSessionId: created.session.id, kind: 'skill' as const, id: 'pr', joined: true };
    const serviceWith = (officialEnabled: boolean) => createBotCapabilityService({
      ...capabilityDeps,
      getMaker: () => ({ getSession: h.getSession, listAgentSkills: async () => ({ skills: [
        { kind: 'agent-skill' as const, name: 'pr', source: 'skill' as const, cindyOfficial: true, enabled: officialEnabled },
        { kind: 'agent-skill' as const, name: 'pr', source: 'user' as const, enabled: true },
      ] }) }),
    });
    await expect(serviceWith(true).select(input)).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_NOT_SELECTABLE' });
    await expect(serviceWith(false).select(input)).resolves.toMatchObject({ ok: true });
  });

  it.each(['skill', 'toolset-global', 'toolset-provider', 'mcp'] as const)(
    'revalidates newly added %s at the settings save boundary without blocking old references', async (scenario) => {
      const created = await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
      });
      let available = true;
      const kind = scenario.startsWith('toolset') ? 'toolset' as const : scenario as 'skill' | 'mcp';
      const id = kind === 'skill' ? 'release-check' : kind === 'toolset' ? 'calendar' : 'shared-docs';
      const field = kind === 'skill' ? 'skills' : kind === 'toolset' ? 'toolsets' : 'mcpServers';
      const patch = (ids: string[]) => kind === 'skill' ? { skills: ids } : { capabilities: { [field]: ids } };
      const listAgentSkills = vi.fn(async (_agentKind: AgentKind, opts: { forceReload?: boolean }) => ({
        skills: available || !opts.forceReload
          ? [{ kind: 'agent-skill' as const, source: 'user' as const, name: 'release-check', enabled: true }] : [],
      }));
      const resolveBotAgentKind = vi.fn(capabilityDeps.resolveBotAgentKind);
      const service = createBotCapabilityService({
        ...capabilityDeps, resolveBotAgentKind,
        getMaker: () => ({ listAgentSkills }),
        getPluginRegistry: () => ({
          getPlugins: getPluginRegistry().getPlugins,
          getEnableState: async (id, workingDir) => ({
            ...await getPluginRegistry().getEnableState(id, workingDir),
            effectiveEnabled: scenario !== 'toolset-global' || available,
          }),
        }),
        isBotToolsetAvailable: () => scenario !== 'toolset-provider' || available,
        listMcpServers: async (input) => available ? capabilityDeps.listMcpServers(input) : [],
      });
      h.validateCapabilityAdditions.mockImplementation(service.validateAdditions);
      await expect(service.list({ callerSessionId: created.session.id, kind })).resolves.toMatchObject({
        capabilities: expect.arrayContaining([expect.objectContaining({ id, available: true })]),
      });
      available = false;
      await expect(service.select({ callerSessionId: created.session.id, kind, id, joined: true }))
        .resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
      await expect(invoke('local-db:bots:update', { id: 'bot-1', name: 'Unsaved name', ...patch([id]), capabilityBaseline: { [field]: [] } }))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(h.sqlite!.prepare('SELECT current_version, display_name FROM bot_profiles WHERE id = ?').get('bot-1'))
        .toEqual({ current_version: 1, display_name: 'Release Bot' });
      if (kind === 'skill') expect(listAgentSkills).toHaveBeenLastCalledWith('pi', expect.objectContaining({ forceReload: true }));
      available = true;
      await expect(invoke('local-db:bots:update', { id: 'bot-1', ...patch([id]) })).resolves.toMatchObject({ currentVersion: 2 });
      available = false;
      resolveBotAgentKind.mockClear();
      // Retaining a now-unavailable reference must not prevent an unrelated edit or removal.
      await expect(invoke('local-db:bots:update', { id: 'bot-1', name: 'Saved name', ...patch([id]) })).resolves.toMatchObject({ name: 'Saved name' });
      await expect(invoke('local-db:bots:update', { id: 'bot-1', ...patch([]) })).resolves.toBeTruthy();
      expect(resolveBotAgentKind).not.toHaveBeenCalled();
    },
  );

  it.each(['skills', 'mcpServers', 'toolsets'] as const)('merges stale settings %s without losing concurrent joins or restoring external removals', async (field) => {
    const patch = (ids: string[]) => field === 'skills' ? { skills: ids } : { capabilities: { [field]: ids } };
    const selected = (profile: { skills: string[]; capabilities: { mcpServers: string[]; toolsets: string[] } }): string[] =>
      field === 'skills' ? profile.skills : profile.capabilities[field];
    // Model-side writes use the same mutation with their captured version. The
    // renderer has not received this new snapshot when its request reaches Main.
    await updateStoredBotProfile({ id: 'bot-1', ...patch(['external']) }, 1);
    const saved = await invoke('local-db:bots:update', {
      id: 'bot-1', ...patch(['local']), capabilityBaseline: { [field]: [] },
    });
    expect(selected(saved)).toEqual(['external', 'local']);
    expect(h.validateCapabilityAdditions).toHaveBeenLastCalledWith(expect.objectContaining({
      next: expect.objectContaining({ [field]: ['external', 'local'] }),
    }));
    expect(saved).not.toHaveProperty('capabilityBaseline');
    // A trailing save can run before the merged response is rendered. Its local
    // baseline still lacks external; removing local must leave external alone.
    const trailing = await invoke('local-db:bots:update', {
      id: 'bot-1', ...patch([]), capabilityBaseline: { [field]: ['local'] },
    });
    expect(selected(trailing)).toEqual(['external']);
    await updateStoredBotProfile({ id: 'bot-1', ...patch([]) }, trailing.currentVersion);
    const afterRemoval = await invoke('local-db:bots:update', {
      id: 'bot-1', ...patch(['external', 'new-local']), capabilityBaseline: { [field]: ['external'] },
    });
    expect(selected(afterRemoval)).toEqual(['new-local']);
    // Repeating the same local delta is idempotent.
    const repeated = await invoke('local-db:bots:update', {
      id: 'bot-1', ...patch(['external', 'new-local']), capabilityBaseline: { [field]: ['external'] },
    });
    expect(selected(repeated)).toEqual(['new-local']);
    expect(repeated.currentVersion).toBe(afterRemoval.currentVersion);
  });

  it.each([null, [], { skills: [42] }, { toolsets: [] }])('rejects malformed or unmatched capability baselines: %j', async (capabilityBaseline) => {
    await expect(invoke('local-db:bots:update', { id: 'bot-1', skills: ['new'], capabilityBaseline }))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    expect(h.sqlite!.prepare('SELECT current_version FROM bot_profiles WHERE id = ?').pluck().get('bot-1')).toBe(1);
  });

  it('validates a settings grant against the model chain saved in the same update', async () => {
    const eventsConfig = { id: 'events', name: 'Events', transport: 'sse' as const, url: 'https://example.invalid/sse', headers: {} };
    h.customMcpConfigs.push(eventsConfig);
    await refreshCustomMcpProviders();
    // Keep this test on the legacy direct provider path so the model-route
    // admission guard still covers a transport unavailable to Codex.
    const eventsProviderIndex = h.mcpProviders.findIndex((provider) => provider.name === eventsConfig.id);
    expect(eventsProviderIndex).toBeGreaterThanOrEqual(0);
    h.mcpProviders[eventsProviderIndex] = new CustomMcpProvider(eventsConfig, () => null);
    const chain: BotModelRoute[] = [{ harness: 'claude', model: 'claude-x', providerId: null, effort: '', fastMode: false }];
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { modelChain: chain } });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    const apply = vi.fn();
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => h.ownerScopeKey,
      read: async () => ({ chain, current: { agentKind: 'claude-code', model: 'claude-x', providerId: null, effort: null, fastMode: false }, hasRuntimeOverride: true }), apply });
    const resolveBotAgentKind = vi.fn(async (id: string, draft?: BotModelRoute[]) => (await reconcile.preview(id, draft))?.agentKind ?? null);
    const service = createBotCapabilityService({ ...capabilityDeps, resolveBotAgentKind });
    h.validateCapabilityAdditions.mockImplementation(service.validateAdditions);
    const next = [{ ...chain[0]!, harness: 'codex', model: 'codex-x' }];
    await expect(invoke('local-db:bots:update', { id: 'bot-1', capabilities: { modelChain: next, mcpServers: ['events'] } }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(resolveBotAgentKind).toHaveBeenLastCalledWith(created.session.id, next);
    expect(h.sqlite!.prepare('SELECT current_version FROM bot_profiles WHERE id = ?').pluck().get('bot-1')).toBe(2);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each(['owner', 'version'])('does not commit a validated settings grant after an in-flight %s change', async (change) => {
    await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const service = createBotCapabilityService({ ...capabilityDeps,
      listMcpServers: async (input) => {
        if (change === 'owner') h.ownerScopeKey = 'another-owner';
        else h.sqlite!.prepare('UPDATE bot_profiles SET current_version = current_version + 1 WHERE id = ?').run('bot-1');
        return capabilityDeps.listMcpServers(input);
      },
    });
    h.validateCapabilityAdditions.mockImplementation(service.validateAdditions);
    await expect(invoke('local-db:bots:update', { id: 'bot-1', capabilities: { mcpServers: ['shared-docs'] }, capabilityBaseline: { mcpServers: [] } })).rejects.toBeTruthy();
    expect(h.sqlite!.prepare('SELECT COUNT(*) FROM bot_profile_versions WHERE bot_id = ?').pluck().get('bot-1')).toBe(1);
  });

  it('validates model-side grants against the next configured route while the old turn is running', async () => {
    let chain: BotModelRoute[] = [{ harness: 'claude', model: 'claude-x', providerId: null, effort: '', fastMode: false }];
    const eventsConfig = { id: 'events', name: 'Events', transport: 'sse' as const, url: 'https://example.invalid/sse', headers: {} };
    h.customMcpConfigs.push(eventsConfig);
    await refreshCustomMcpProviders();
    // The production registry mounts the Apps facade for every harness. Use a
    // direct provider here to exercise the route-change rejection itself.
    const eventsProviderIndex = h.mcpProviders.findIndex((provider) => provider.name === eventsConfig.id);
    expect(eventsProviderIndex).toBeGreaterThanOrEqual(0);
    h.mcpProviders[eventsProviderIndex] = new CustomMcpProvider(eventsConfig, () => null);
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { modelChain: chain } });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    const current = { agentKind: 'claude-code' as const, model: 'claude-x', providerId: null, effort: null, fastMode: false };
    const apply = vi.fn(async () => {});
    const reconcile = createBotModelRouteReconciler({
      ownerEpoch: () => h.ownerScopeKey,
      read: async () => ({ chain, current, hasRuntimeOverride: true }),
      apply,
    });
    await reconcile(created.session.id);
    const listAgentSkills = vi.fn(async (agentKind: AgentKind) => ({
      skills: [{ kind: 'agent-skill' as const, name: 'route-skill', source: 'user' as const, enabled: agentKind === 'claude-code' }],
    }));
    const toolsetAvailable = vi.fn((ctx: { agentKind: AgentKind }) => ctx.agentKind === 'claude-code');
    const service = createBotCapabilityService({
      ...capabilityDeps,
      getMaker: () => ({ getSession: () => current, listAgentSkills }),
      isBotToolsetAvailable: toolsetAvailable,
      resolveBotAgentKind: async (id) => (await reconcile.preview(id))?.agentKind ?? null,
    });
    const input = { callerSessionId: created.session.id, kind: 'mcp' as const, id: 'events' };
    await expect(service.list(input)).resolves.toMatchObject({ capabilities: expect.arrayContaining([
      expect.objectContaining({ id: 'events', available: true }),
    ]) });
    // The profile changes during the current Claude turn; it has not applied a switch yet.
    chain = [{ ...chain[0]!, harness: 'codex', model: 'codex-x' }];
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { modelChain: chain } });
    for (const [kind, id] of [['mcp', 'events'], ['skill', 'route-skill'], ['toolset', 'calendar']] as const) {
      await expect(service.list({ ...input, kind })).resolves.toMatchObject({
        capabilities: expect.arrayContaining([expect.objectContaining({ id, available: false })]),
      });
      await expect(service.select({ ...input, kind, id, joined: true })).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
    }
    expect(listAgentSkills).toHaveBeenLastCalledWith('codex', expect.anything());
    expect(toolsetAvailable).toHaveBeenLastCalledWith(expect.objectContaining({ agentKind: 'codex' }));
    expect(apply).not.toHaveBeenCalled();
    expect(h.sqlite!.prepare('SELECT current_version FROM bot_profiles WHERE id = ?').pluck().get('bot-1')).toBe(3);
    // Previewing a grant must not consume the pending route change for the next send.
    await reconcile(created.session.id);
    expect(apply).toHaveBeenCalledWith(created.session.id, expect.objectContaining({ agentKind: 'codex' }), current);
  });

  it.each(['missing', 'error', 'owner-change'])('does not use the current route when next-turn preview fails: %s', async (reason) => {
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { mcpServers: ['shared-docs'], mcpMode: 'allowlist' } });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    const listMcpServers = vi.fn(capabilityDeps.listMcpServers);
    const resolveBotAgentKind = vi.fn(async (): Promise<AgentKind | null> => {
      if (reason === 'error') throw new Error('preview failed');
      if (reason === 'owner-change') { h.ownerScopeKey = 'owner-b'; return 'claude-code'; }
      return null;
    });
    const service = createBotCapabilityService({ ...capabilityDeps, listMcpServers, resolveBotAgentKind });
    const input = { callerSessionId: created.session.id, kind: 'mcp' as const, id: 'shared-docs' };
    await expect(service.select({ ...input, joined: true })).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_SELECTION_FAILED' });
    expect(listMcpServers).not.toHaveBeenCalled();
    expect(h.sqlite!.prepare('SELECT current_version FROM bot_profiles WHERE id = ?').pluck().get('bot-1')).toBe(2);
    h.ownerScopeKey = 'owner-a:1';
    resolveBotAgentKind.mockClear();
    await expect(service.select({ ...input, joined: false })).resolves.toMatchObject({ ok: true });
    expect(resolveBotAgentKind).not.toHaveBeenCalled();
  });

  it.each(['cindy_helper', '__proto__', 'constructor', 'bad_header'])('rejects MCP %s quarantined by the actual registry while keeping its saved reference removable', async (id) => {
    h.customMcpConfigs.push({
      id, name: 'Legacy MCP', transport: 'http', url: 'https://example.invalid/legacy',
      headers: id === 'bad_header' ? { 'X-Name': '中文' } : {},
    });
    await refreshCustomMcpProviders();
    expect(h.mcpProviders.filter((provider) => provider instanceof CustomMcpProvider).map((provider) => provider.name)).toEqual(['shared-docs']);
    await invoke('local-db:bots:update', {
      id: 'bot-1', capabilities: { mcpServers: [id], mcpMode: 'allowlist' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    const input = { callerSessionId: created.session.id, kind: 'mcp' as const };
    const discovered = await findBotCapabilities(input);
    expect(discovered).toMatchObject({
      ok: true, capabilities: expect.arrayContaining([
        { id, name: 'Legacy MCP', description: 'http', available: false, joined: true },
        { id: 'shared-docs', name: 'Shared Docs', description: 'http', available: true, joined: false },
      ]),
    });
    expect(JSON.stringify(discovered)).not.toMatch(/FAKE_SECRET|example.invalid|Authorization/);
    await expect(selectBotCapability({ ...input, id, joined: true })).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
    expect(h.sqlite!.prepare('SELECT current_version FROM bot_profiles WHERE id = ?').pluck().get('bot-1')).toBe(2);
    await expect(selectBotCapability({ ...input, id, joined: false })).resolves.toMatchObject({ ok: true, joined: false });
    await expect(selectBotCapability({ ...input, id: 'shared-docs', joined: true })).resolves.toMatchObject({ ok: true, joined: true });
  });

  it.each([
    { id: 'pi-sse', transport: 'sse' as const, url: 'https://example.invalid/mcp' },
    { id: 'pi-public-http', transport: 'http' as const, url: 'http://example.invalid/mcp' },
  ])('exposes $id through the MCP Apps facade on Pi', async (config) => {
    h.customMcpConfigs.push({ ...config, name: config.id, headers: {} });
    await refreshCustomMcpProviders();
    await invoke('local-db:bots:update', {
      id: 'bot-1', capabilities: { mcpServers: [config.id], mcpMode: 'allowlist' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    expect(created.session.agentKind).toBe('pi');
    const input = { callerSessionId: created.session.id, kind: 'mcp' as const, id: config.id };
    await expect(findBotCapabilities(input)).resolves.toMatchObject({
      capabilities: expect.arrayContaining([{ id: config.id, name: config.id,
        description: config.transport, available: true, joined: true }]),
    });
    await expect(selectBotCapability({ ...input, joined: true })).resolves.toMatchObject({ ok: true, joined: true });
    await expect(selectBotCapability({ ...input, joined: false })).resolves.toMatchObject({ ok: true, joined: false });
  });

  it('revalidates saved MCP transports on fallback and restores them when switching back', async () => {
    const configs = [
      { id: 'https', transport: 'http' as const, url: 'https://example.invalid/mcp' },
      { id: 'sse', transport: 'sse' as const, url: 'https://example.invalid/sse' },
      { id: 'public-http', transport: 'http' as const, url: 'http://example.invalid/mcp' },
      { id: 'local-http', transport: 'http' as const, url: 'http://localhost:4321/mcp' },
    ].map((config) => ({ ...config, name: config.id, headers: { Authorization: 'FAKE_SECRET' }, updatedAt: 1 }));
    const configured = configs.map((config) => config.id);
    const providers = configs.map((config) => new CustomMcpProvider(config, () => 'FAKE_TOKEN'));
    await invoke('local-db:bots:update', {
      id: 'bot-1', capabilities: { mcpServers: configured, mcpMode: 'allowlist' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    for (const agentKind of ['claude-code', 'codex', 'pi', 'claude-code'] as const) {
      const opts: MakerSessionCreateOpts = {
        id: created.session.id, agentKind, workingDir: created.session.workingDir,
        workspaceKind: 'dialogue', model: 'test-model', permissionMode: 'auto',
      };
      const snapshot = await hydrateBotProfileRuntime(opts, {
        listMcpServers: async ({ agentKind: actualRoute, remoteHostId }) => {
          const catalog = buildBotMcpCatalog({
            agentKind: actualRoute, remoteHostId, providers, builtinNames: [], customServers: configs,
          });
          expect(JSON.stringify(catalog)).not.toMatch(/FAKE_SECRET|FAKE_TOKEN|example.invalid|Authorization/);
          return catalog;
        },
      });
      expect(snapshot).toMatchObject({
        configuredMcpServers: configured,
        resolvedMcpServers: agentKind === 'pi' ? ['https', 'local-http']
          : agentKind === 'codex' ? ['https', 'public-http', 'local-http'] : configured,
        unavailableMcpServers: agentKind === 'pi' ? ['sse', 'public-http']
          : agentKind === 'codex' ? ['sse'] : [],
      });
      expect(opts.botRuntimeProfile?.mcpPolicy.catalog).toContainEqual(expect.objectContaining({
        name: 'sse', available: agentKind === 'claude-code',
      }));
    }
  });

  // P1 integration: a quarantined persisted row used to duplicate the native
  // capability id, making selection operate on the wrong entry.
  it('lists and selects native Apps once despite a retained custom collision', async () => {
    h.customMcpConfigs.push({ id: 'codex_apps', name: 'Legacy custom Apps', transport: 'http',
      url: 'https://example.invalid/legacy', headers: {} });
    await refreshCustomMcpProviders();
    await invoke('local-db:bots:update', {
      id: 'bot-1', capabilities: { mcpServers: [], mcpMode: 'allowlist' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    const service = createBotCapabilityService({ ...capabilityDeps, resolveBotAgentKind: async () => 'codex' });
    h.validateCapabilityAdditions.mockImplementation(service.validateAdditions);
    const input = { callerSessionId: created.session.id, kind: 'mcp' as const, id: 'codex_apps' };
    const result = await service.list(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.capabilities.filter((entry) => entry.id === 'codex_apps')).toEqual([
      expect.objectContaining({ name: 'codex_apps', available: true, joined: false }),
    ]);
    await expect(service.select({ ...input, joined: true })).resolves.toMatchObject({ ok: true });
    await expect(service.select({ ...input, joined: false })).resolves.toMatchObject({ ok: true });
    expect(h.mcpProviders.some((provider) => provider.name === 'codex_apps')).toBe(false);
    expect(h.customMcpConfigs.some((entry) => entry.id === 'codex_apps')).toBe(true);
  });

  it('rejects unforwarded custom MCPs on SSH Codex while preserving saved references and supported routes', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1', capabilities: { mcpServers: ['shared-docs'], mcpMode: 'allowlist' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    h.sqlite!.prepare('UPDATE sessions SET remote_host_id = ? WHERE id = ?').run('ssh-host', created.session.id);
    const input = { callerSessionId: created.session.id, kind: 'mcp' as const, id: 'shared-docs' };
    for (const agentKind of ['codex', 'claude-code', 'pi'] as const) {
      const service = createBotCapabilityService({ ...capabilityDeps, resolveBotAgentKind: async () => agentKind });
      await expect(service.list(input)).resolves.toMatchObject({
        capabilities: [
          expect.objectContaining({ id: 'shared-docs', joined: true, available: agentKind !== 'codex' }),
          // Native Apps is discoverable but cannot be selected on SSH Codex.
          ...(agentKind === 'codex' ? [expect.objectContaining({ id: 'codex_apps', joined: false, available: false })] : []),
        ],
      });
      const opts: MakerSessionCreateOpts = {
        id: created.session.id, agentKind, workingDir: '/srv/bot', remoteHostId: 'ssh-host',
        workspaceKind: 'project', model: 'test-model', permissionMode: 'auto',
      };
      const snapshot = await hydrateBotProfileRuntime(opts, { listMcpServers: capabilityDeps.listMcpServers });
      expect(snapshot).toMatchObject({
        configuredMcpServers: ['shared-docs'],
        resolvedMcpServers: agentKind === 'codex' ? [] : ['shared-docs'],
        unavailableMcpServers: agentKind === 'codex' ? ['shared-docs'] : [],
      });
    }
    const service = createBotCapabilityService({ ...capabilityDeps, resolveBotAgentKind: async () => 'codex' });
    h.validateCapabilityAdditions.mockImplementation(service.validateAdditions);
    await expect(service.select({ ...input, id: 'codex_apps', joined: true }))
      .resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
    await expect(service.select({ ...input, joined: false })).resolves.toMatchObject({ ok: true, joined: false });
    await expect(service.select({ ...input, joined: true })).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
    await expect(invoke('local-db:bots:update', { id: 'bot-1', capabilities: { mcpServers: ['shared-docs'] } }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    h.sqlite!.prepare('UPDATE sessions SET remote_host_id = NULL WHERE id = ?').run(created.session.id);
    await expect(service.select({ ...input, joined: true })).resolves.toMatchObject({ ok: true, joined: true });
  });

  it('rejects desktop-loopback custom MCPs on SSH Pi while keeping public HTTPS', async () => {
    h.customMcpConfigs.push({
      id: 'local-http', name: 'Local HTTP', transport: 'http',
      url: 'http://127.0.0.1:4321/mcp', headers: {},
    });
    h.mcpProviders.push(new CustomMcpProvider(h.customMcpConfigs[1]!, () => null));
    await invoke('local-db:bots:update', {
      id: 'bot-1', capabilities: { mcpServers: ['shared-docs', 'local-http'], mcpMode: 'allowlist' },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    h.sqlite!.prepare('UPDATE sessions SET remote_host_id = ? WHERE id = ?').run('ssh-host', created.session.id);
    const service = createBotCapabilityService({ ...capabilityDeps, resolveBotAgentKind: async () => 'pi' });
    const input = { callerSessionId: created.session.id, kind: 'mcp' as const };
    await expect(service.list(input)).resolves.toMatchObject({
      capabilities: expect.arrayContaining([
        expect.objectContaining({ id: 'shared-docs', joined: true, available: true }),
        expect.objectContaining({ id: 'local-http', joined: true, available: false }),
      ]),
    });
    const snapshot = await hydrateBotProfileRuntime({
      id: created.session.id, agentKind: 'pi', workingDir: '/srv/bot', remoteHostId: 'ssh-host',
      workspaceKind: 'project', model: 'test-model', permissionMode: 'auto',
    }, { listMcpServers: capabilityDeps.listMcpServers });
    expect(snapshot).toMatchObject({
      configuredMcpServers: ['shared-docs', 'local-http'],
      resolvedMcpServers: ['shared-docs'],
      unavailableMcpServers: ['local-http'],
    });
    await expect(service.select({ ...input, id: 'local-http', joined: true }))
      .resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
    await expect(service.select({ ...input, id: 'local-http', joined: false }))
      .resolves.toMatchObject({ ok: true, joined: false });
  });

  it.each(['calendar'])('rejects gated %s despite registry enablement and keeps joined references removable', async (id) => {
    const created = await invoke('local-db:bots:create-canonical-session', { botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1 });
    const input = { callerSessionId: created.session.id, kind: 'toolset' as const, id };
    await expect(findBotCapabilities(input)).resolves.toMatchObject({
      ok: true, capabilities: expect.arrayContaining([{ id, name: id, description: id, available: false, joined: false }]),
    });
    await expect(selectBotCapability({ ...input, joined: true })).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
    h.toolsetsAvailable = true;
    await expect(selectBotCapability({ ...input, joined: true })).resolves.toMatchObject({ ok: true });
    h.toolsetsAvailable = false;
    await expect(selectBotCapability({ ...input, joined: false })).resolves.toMatchObject({ ok: true, joined: false });
  });

  it.each([false, true])('keeps fixed toolsets out of selection even with saved references: %s', async (savedReferences) => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      capabilities: { toolsets: savedReferences ? ['memory', 'xdt_helper', 'retired-toolset'] : [] },
    });
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2,
    });
    const input = { callerSessionId: created.session.id, kind: 'toolset' as const };
    h.toolsetsAvailable = true;
    const discovered = await findBotCapabilities(input);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) throw new Error(discovered.message);
    for (const id of ['memory', 'xdt_helper']) {
      expect(discovered.capabilities.some((item) => item.id === id)).toBe(false);
      for (const joined of [true, false]) {
        await expect(selectBotCapability({ ...input, id, joined })).resolves.toMatchObject({
          ok: false, errorCode: 'CAPABILITY_NOT_SELECTABLE',
        });
      }
    }
    expect(h.sqlite!.prepare('SELECT current_version FROM bot_profiles WHERE id = ?').pluck().get('bot-1')).toBe(2);
    if (savedReferences) {
      expect(discovered.capabilities).toContainEqual({
        id: 'retired-toolset', name: 'retired-toolset', description: '', available: false, joined: true,
      });
      await expect(selectBotCapability({ ...input, id: 'retired-toolset', joined: false })).resolves.toMatchObject({ ok: true });
    }
  });

  it('refuses absent capabilities and callers without an active canonical Bot', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', { botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1 });
    await expect(selectBotCapability({ callerSessionId: created.session.id, kind: 'mcp', id: 'missing', joined: true })).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
    await expect(selectBotCapability({ callerSessionId: 'unknown', kind: 'mcp', id: 'shared-docs', joined: true })).resolves.toMatchObject({ ok: false });
    h.sqlite!.prepare("UPDATE bot_profiles SET status = 'paused' WHERE id = 'bot-1'").run();
    await expect(selectBotCapability({ callerSessionId: created.session.id, kind: 'mcp', id: 'shared-docs', joined: true })).resolves.toMatchObject({ ok: false });
  });

  it('allows trusted settings to add capabilities while the Bot is paused', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const current = { agentKind: 'pi' as const, model: 'grok-4.5', providerId: null, effort: null, fastMode: false };
    const chain: BotModelRoute[] = [{ harness: 'pi', model: 'grok-4.5', providerId: null, effort: '', fastMode: false }];
    const profileStatus = () => h.sqlite!.prepare("SELECT status FROM bot_profiles WHERE id = 'bot-1'").pluck().get() as string;
    const apply = vi.fn();
    const reconcile = createBotModelRouteReconciler({
      ownerEpoch: () => h.ownerScopeKey,
      read: async (_id, purpose) => {
        const status = profileStatus();
        if (purpose === 'preview') {
          return ['active', 'paused'].includes(status) ? { chain, current, hasRuntimeOverride: false } : null;
        }
        return status === 'active' ? { chain, current, hasRuntimeOverride: false } : null;
      },
      apply,
    });
    const service = createBotCapabilityService({
      ...capabilityDeps,
      resolveBotAgentKind: async (id, draft) => (await reconcile.preview(id, draft))?.agentKind ?? null,
    });
    h.validateCapabilityAdditions.mockImplementation(service.validateAdditions);
    h.sqlite!.prepare("UPDATE bot_profiles SET status = 'paused' WHERE id = 'bot-1'").run();
    await expect(selectBotCapability({
      callerSessionId: created.session.id, kind: 'mcp', id: 'shared-docs', joined: true,
    })).resolves.toMatchObject({ ok: false });
    await expect(findBotCapabilities({ callerSessionId: created.session.id, kind: 'mcp' }))
      .resolves.toMatchObject({ ok: false });
    await expect(invoke('local-db:bots:update', {
      id: 'bot-1', capabilities: { mcpServers: ['shared-docs'] },
    })).resolves.toMatchObject({ currentVersion: 2 });
    expect(await reconcile.preview(created.session.id)).toMatchObject({ agentKind: 'pi' });
    await reconcile(created.session.id);
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([['browser', 'cindy_browser'], ['scheduler', 'cindy_scheduler']])('mounts the selected %s toolset into the actual MCP policy', async (toolset, server) => {
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { toolsets: [toolset], toolsetMode: 'allowlist' } });
    const created = await invoke('local-db:bots:create-canonical-session', { botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2 });
    const opts: MakerSessionCreateOpts = { id: created.session.id, agentKind: 'codex', workingDir: created.session.workingDir, workspaceKind: 'dialogue', model: 'test-model', permissionMode: 'auto' };
    await hydrateBotProfileRuntime(opts, {
      listMcpServers: async () => [{ name: server, source: 'builtin', available: true }],
      listToolsets: async () => [{ id: toolset, name: toolset, essential: toolset === 'scheduler', available: true }],
    });
    expect(opts.botRuntimeProfile?.mcpPolicy.configured).toContain(server);
  });

  it('mounts the baseline scheduler MCP for a local Bot without the toolset being selected', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', { botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1 });
    const opts: MakerSessionCreateOpts = { id: created.session.id, agentKind: 'claude-code', workingDir: created.session.workingDir, workspaceKind: 'dialogue', model: 'test-model', permissionMode: 'auto' };
    await hydrateBotProfileRuntime(opts, {
      listMcpServers: async () => [{ name: 'cindy_scheduler', source: 'builtin', available: true }],
      listToolsets: async () => [{ id: 'scheduler', name: 'Scheduler', essential: true, available: true }],
    });
    expect(opts.botRuntimeProfile?.mcpPolicy.configured).toContain('cindy_scheduler');
    expect(opts.botProfileContextPrompt).toContain('你能建普通自动化');
    expect(opts.botProfileContextPrompt).toContain('你能看、能管用户的任务');
  });

  it('refreshes canonical MCP generations and Toolset versions in place', async () => {
    await invoke('local-db:bots:update', {
      id: 'bot-1',
      capabilities: {
        mcpServers: ['docs'],
        mcpMode: 'allowlist',
        toolsets: ['calendar'],
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
          id: 'calendar',
          name: 'Calendar',
          available: true,
          version: toolsetVersion,
        }],
      });

    const first = await hydrate('http:1000', '1.0.0');
    await markBotProfileRuntimeApplied(first!);
    await expect(hydrate('http:1000', '1.0.0')).resolves.toMatchObject({
      resolvedMcpServers: ['docs'],
      resolvedToolsets: ['calendar'],
      runtimeEpochChanged: false,
    });
    await expect(hydrate('http:1001', '1.0.0')).resolves.toMatchObject({
      sessionId: created.session.id,
      resolvedMcpServers: ['docs'],
      runtimeEpochChanged: true,
    });
    await expect(hydrate('http:1000', '2.0.0')).resolves.toMatchObject({
      sessionId: created.session.id,
      resolvedToolsets: ['calendar'],
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
      workingDir: join(h.userDataDir, 'session-1'),
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
      workingDir: join(h.userDataDir, 'session-1'),
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

  it.each([
    { identitySource: undefined, description: '负责财务分析，使用用户提供的数据，不编造账目。' },
    { identitySource: '   ', description: '负责财务分析，使用用户提供的数据，不编造账目。' },
    { identitySource: undefined, description: '财'.repeat(12000) },
    { identitySource: '只使用用户明确指定的独立身份。', description: '列表中的简短介绍' },
  ])('preserves description-only roles through creation and runtime (identity=$identitySource)', async ({ identitySource, description }) => {
    const created = await invoke('local-db:bots:create', {
      id: 'finance-role', name: 'Finance', avatar: '🤖', description, identitySource,
    });
    const expected = identitySource?.trim() || description;
    expect(created.identitySource).toBe(expected);
    const home = join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex'), 'bots', created.id);
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8').trim()).toBe(expected);
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: created.id, expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const opts: MakerSessionCreateOpts = {
      id: canonical.session.id, agentKind: 'pi', workingDir: canonical.session.workingDir,
      workspaceKind: 'dialogue', model: canonical.session.model, permissionMode: 'ask',
    };
    await hydrateBotProfileRuntime(opts, {}, { persistSnapshot: false });
    expect(opts.botProfilePrompt).toBe(expected);
    // The derived identity must still be accepted by the same API, including
    // maximum-length descriptions copied back by editing/duplication clients.
    const copy = await invoke('local-db:bots:create', {
      id: 'finance-role-copy', name: 'Finance copy', avatar: '🤖', description,
      identitySource: created.identitySource,
    });
    expect(copy.identitySource).toBe(expected);
  });

  it('uses the current description when an identity is explicitly cleared', async () => {
    const description = '负责核对财务数据和解释预算差异。';
    const updated = await invoke('local-db:bots:update', {
      id: 'bot-1', description, identitySource: '   ',
    });
    expect(updated.identitySource).toBe(description);
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

  it('keeps public commentary out of local and remote preview reads while generating', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'user', role: 'user', content: 'Question', createdAt: 1000 });
    for (let n = 0; n < 8; n++) insertMessage(sessionId, { id: `progress-${n}`, role: 'assistant', content: 'Tool preamble', createdAt: 2000 + n });
    h.getSession.mockReturnValue({ isTurnRunning: () => true, compactSession: vi.fn() });
    const single = await invoke('local-db:bots:get', 'bot-1');
    expect(single.lastMessagePreview).toBe('Question');
    const { getBotRemoteResourceSource } = await import('../bots');
    expect((await getBotRemoteResourceSource('bot-1')).lastMessagePreview).toBe('Question');
    insertMessage(sessionId, { id: 'sealed', role: 'assistant', content: 'Final answer', agentMeta: { turnCompleted: true }, createdAt: 3000 });
    expect((await getBotRemoteResourceSource('bot-1')).lastMessagePreview).toBe('Final answer');
    h.getSession.mockReturnValue(null);
    expect((await invoke('local-db:bots:get', 'bot-1')).lastMessagePreview).toBe('Final answer');
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

  // Merge compatibility: test the real list handler and SQLite-visible replies,
  // not only the renderer projection. Host seeds must not hide a reply after a
  // complete window's earlier seed; actual host acknowledgements still clear it.
  it('does not let a host automatic seed hide replies past a complete window read position', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'host-seed-reply', role: 'assistant', content: 'Unread reply', createdAt: 2000 });
    try {
      seedBotReadPositions({ 'bot-1': 3000 });
      expect(await unreadFor('bot-1', { 'bot-1': 1000 })).toBe(1);
      markBotReadPositions({ 'bot-1': 2000 });
      expect(await unreadFor('bot-1', { 'bot-1': 1000 })).toBe(0);
    } finally { pruneHostBotReads({ botIds: [] }); }
  });

  it('remote reply watermark ignores user activity and private timeline traces', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'reply', role: 'assistant', content: 'Visible result', createdAt: 1000 });
    insertMessage(sessionId, { id: 'user', role: 'user', content: 'Another question', createdAt: 2000 });
    insertMessage(sessionId, { id: 'private', role: 'assistant', content: 'Private result', createdAt: 3000, agentMeta: { botPrivateReply: true } });
    insertMessage(sessionId, { id: 'trace', role: 'assistant', content: 'Private trace', createdAt: 4000, agentMeta: { botDirectMessage: { v: 1 } } });
    insertMessage(sessionId, { id: 'rewound', role: 'assistant', content: 'Rewound', createdAt: 5000, rewindAt: 6000 });
    const remote = await getBotRemoteResourceSource('bot-1');
    expect(remote.lastReplyAt).toBe(1000);
    expect(remote.lastMessagePreview).toBe('Another question');
    h.sqlite!.prepare('UPDATE sessions SET cleared_at = 6000 WHERE id = ?').run(sessionId);
    expect((await getBotRemoteResourceSource('bot-1')).lastReplyAt).toBe(0);
  });

  it('keeps hidden coordination inputs and actions out of unread and preview after history reload', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'result', role: 'assistant', content: 'Visible final result', createdAt: 1000 });
    insertMessage(sessionId, { id: 'coordination', role: 'user', content: '[UI_ACTION_TRIGGER]File ownership agreement', createdAt: 2000,
      agentMeta: { origin: { kind: 'session', senderSessionId: 'child' }, botTaskCoordinationInput: { delegationId: 'task', senderSessionId: 'child', runSequence: 1 } } });
    insertMessage(sessionId, { id: 'audit-tool', role: 'tool_use', content: { toolName: 'read', input: {} }, createdAt: 3000 });
    expect(await unreadFor('bot-1', { 'bot-1': 1500 })).toBe(0);
    const resource = await getBotRemoteResourceSource('bot-1');
    expect(resource.lastReplyAt).toBe(1000);
    expect(resource.lastMessagePreview).toBe('Visible final result');
    insertMessage(sessionId, { id: 'next-result', role: 'assistant', content: 'Requested update', createdAt: 4000 });
    expect(await unreadFor('bot-1', { 'bot-1': 1500 })).toBe(1);
  });

  it.each([false, true])('does not count failed welcome sampling attempts (running=%s)', async (running) => {
    const sessionId = await canonicalFor('bot-1');
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      insertMessage(sessionId, {
        id: `failed-opening-${attempt}`, role: 'assistant', content: `你好，我是 Cindy。尝试 ${attempt}`,
        createdAt: 2000 + attempt,
        agentMeta: {
          assistantPhase: 'final_answer', turnCompleted: false, turnCostUsd: 0.01,
          failedSamplingAttempt: { threadId: 'native-thread', turnId: 'welcome-turn', attempt, itemId: `failed-${attempt}` },
        },
      });
    }
    insertMessage(sessionId, {
      id: 'successful-opening', role: 'assistant', content: '你好，我是 Cindy。', createdAt: 3000,
      agentMeta: { assistantPhase: 'final_answer', turnCompleted: true },
    });
    h.getSession.mockReturnValue(running ? { isTurnRunning: () => true, compactSession: vi.fn() } : null);
    expect(await unreadFor('bot-1', { 'bot-1': 1000 })).toBe(1);
  });

  it('keeps failed sampling output out of local previews and remote reply watermarks', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, {
      id: 'answer', role: 'assistant', content: 'Accepted reply', createdAt: 2000,
      agentMeta: { turnCompleted: true },
    });
    for (let attempt = 1; attempt <= 105; attempt += 1) {
      insertMessage(sessionId, {
        id: `failed-${attempt}`, role: 'assistant', content: 'Incomplete replacement', createdAt: 3000 + attempt,
        agentMeta: { failedSamplingAttempt: { threadId: 'native-thread', turnId: 'next-turn', attempt, itemId: `failed-${attempt}` } },
      });
    }
    expect(await unreadFor('bot-1', { 'bot-1': 1000 })).toBe(1);
    expect(await unreadFor('bot-1', { 'bot-1': 2000 })).toBe(0);
    expect(await invoke('local-db:bots:get', 'bot-1')).toMatchObject({
      lastMessagePreview: 'Accepted reply', lastMessageAt: 2000,
    });
    expect(await getBotRemoteResourceSource('bot-1')).toMatchObject({
      lastMessagePreview: 'Accepted reply', lastReplyAt: 2000,
    });
  });

  it.each([true, { runtimeId: 'retired-runtime' }])('does not promote orphaned pending replies after close (%j)', async samplingAttemptPending => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'accepted', role: 'assistant', content: 'Accepted reply', createdAt: 2000,
      agentMeta: { samplingAttemptPending: false, turnCompleted: true } });
    for (let index = 0; index < 105; index++) insertMessage(sessionId, {
      id: `orphan-${index}`, role: 'assistant', content: 'Unconfirmed prose', createdAt: 3000 + index,
      agentMeta: { samplingAttemptPending, turnCompleted: true, turnCostUsd: 0.01 },
    });
    h.getSession.mockReturnValue(null);
    expect(await unreadFor('bot-1', { 'bot-1': 1000 })).toBe(1);
    expect(await unreadFor('bot-1', { 'bot-1': 2000 })).toBe(0);
    expect(await invoke('local-db:bots:get', 'bot-1')).toMatchObject({
      lastMessagePreview: 'Accepted reply', lastMessageAt: 2000,
    });
    expect(await getBotRemoteResourceSource('bot-1')).toMatchObject({
      lastMessagePreview: 'Accepted reply', lastReplyAt: 2000,
    });
  });

  it.each(['local', 'remote'])('recovers an accepted intent through %s projection without creating a cloud host', async projection => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'accepted-pending', role: 'assistant', content: 'Accepted after close', createdAt: 2000,
      agentMeta: { samplingAttemptPending: { runtimeId: 'old-runtime' }, turnCompleted: true } });
    const { assistantSamplingSettlements } = await import('../../../assistantSamplingSettlement.js');
    assistantSamplingSettlements.put({ sessionId, persistId: 'accepted-pending', patch: { samplingAttemptPending: false } });
    const { clearSessionPersistState } = await import('../../../messagePersistBroadcaster.desktop.js');
    clearSessionPersistState(sessionId);
    h.getSession.mockReturnValue(null);
    if (projection === 'local') {
      expect(await unreadFor('bot-1', { 'bot-1': 1000 })).toBe(1);
      expect(await invoke('local-db:bots:get', 'bot-1')).toMatchObject({ lastMessagePreview: 'Accepted after close', lastMessageAt: 2000 });
    } else {
      expect(await getBotRemoteResourceSource('bot-1')).toMatchObject({ lastMessagePreview: 'Accepted after close', lastReplyAt: 2000 });
    }
    expect(assistantSamplingSettlements.list(sessionId)).toEqual([]);
  });

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

  // Regression / unit: list/get and the remote projection must agree with the
  // transcript's persisted tool-parent classification. Earlier coverage only
  // used parentToolUseId, not the parentUuid written by message persistence.
  // Minimal case: one read reply followed by a sealed child (or legacy parent).
  it.each([
    { parentUuid: 'toolu_child', internal: true },
    { parentUuid: 'call_child', internal: true },
    { parentUuid: 'Task_x1', internal: true },
    { parentUuid: 'chatcmpl-tool-child', internal: true },
    { parentUuid: '4f1c9a7e-3b2d-4c8a-9e5f-1a2b3c4d5e6f', internal: false },
    { parentUuid: 'preceding-user-uuid', internal: false },
  ])('keeps persisted parent $parentUuid consistent across list projections', async ({ parentUuid, internal }) => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'read-reply', role: 'assistant', content: 'Already read', createdAt: 1000 });
    insertMessage(sessionId, { id: 'parented-reply', role: 'assistant', content: 'Later reply', createdAt: 2000,
      agentMeta: { parentUuid, turnCompleted: true } });
    const expected = { lastMessagePreview: internal ? 'Already read' : 'Later reply', lastMessageAt: internal ? 1000 : 2000 };
    const rows = await invoke('local-db:bots:list', { lastReadAtByBotId: { 'bot-1': 1500 } }) as Array<{ id: string }>;
    expect(rows.find(row => row.id === 'bot-1')).toMatchObject({ ...expected, unreadCount: internal ? 0 : 1 });
    expect(await invoke('local-db:bots:get', 'bot-1')).toMatchObject(expected);
    expect(await getBotRemoteResourceSource('bot-1')).toMatchObject({ ...expected, lastReplyAt: expected.lastMessageAt });
  });

  it('excludes commentary, pre-tool narration, empty and private rows from both badges and remote reply watermarks', async () => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'progress', role: 'assistant', content: 'Checking', createdAt: 2000 });
    insertMessage(sessionId, { id: 'tool', role: 'tool_use', content: { name: 'Read' }, createdAt: 2100 });
    insertMessage(sessionId, { id: 'answer', role: 'assistant', content: 'Result', agentMeta: { turnCompleted: true }, createdAt: 3000 });
    insertMessage(sessionId, { id: 'commentary', role: 'assistant', content: 'Working', agentMeta: { assistantPhase: 'commentary' }, createdAt: 4000 });
    insertMessage(sessionId, { id: 'child', role: 'assistant', content: 'Tool child', agentMeta: { parentToolUseId: 'tool-1' }, createdAt: 5000 });
    for (let i = 0; i < 105; i++) insertMessage(sessionId, { id: `empty-${i}`, role: 'assistant', content: '', createdAt: 6000 + i });
    expect(await unreadFor('bot-1', { 'bot-1': 1000 })).toBe(1);
    expect((await getBotRemoteResourceSource('bot-1')).lastReplyAt).toBe(3000);
    // Empty rows cannot consume the unread cap and hide the real reply.
    expect(await unreadFor('bot-1', { 'bot-1': 3000 })).toBe(0);
  });

  it.each([
    { turnCompleted: true },
    { turnUsageDetails: { totalTokens: 12 } },
    { turnMoney: { amount: 0.01, currency: 'USD' } },
    { turnCostUsd: 0.01 },
  ])('retains a completed visible reply before continuation tools (%j)', async (seal) => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'reply', role: 'assistant', content: 'Completed reply', agentMeta: seal, createdAt: 2000 });
    insertMessage(sessionId, { id: 'tool', role: 'tool_use', content: { name: 'Read' }, createdAt: 2100 });
    expect(await unreadFor('bot-1', { 'bot-1': 1000 })).toBe(1);
    const remote = await getBotRemoteResourceSource('bot-1');
    expect(remote.lastReplyAt).toBe(2000);
    expect(remote.lastMessagePreview).toBe('Completed reply');
    expect(await unreadFor('bot-1', { 'bot-1': 2000 })).toBe(0);
  });

  // #6958: short histories missed repeated scans of later turns; the first fix also
  // scanned the entire remaining history for each narration in one long tool turn.
  // Exercise real list/get, remote watermark and DM handlers with SQLite in the unit tier.
  // A TEMP view counts role reads while retaining the real session/time index, so
  // quadratic work fails deterministically without a host-sensitive time limit.
  it.each(['later turns', 'single long tool turn'] as const)('bounds message reads through %s without losing replies behind empty rows', async (history) => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'root', role: 'user', content: '', createdAt: 1 });
    const thread = await invoke('local-db:bots:dm-thread:ensure', {
      botId: 'bot-1', rootSessionId: sessionId, rootClientId: 'root',
    });
    expect(thread.ok).toBe(true);
    h.sqlite!.transaction(() => {
      for (const id of [sessionId, thread.sessionId]) {
        if (history === 'later turns') {
          for (let i = 0; i < 100; i++) {
            insertMessage(id, { id: `${id}-user-${i}`, role: 'user', content: '', createdAt: 1000 + i * 2 });
            insertMessage(id, { id: `${id}-reply-${i}`, role: 'assistant', content: `Reply ${i}`, createdAt: 1001 + i * 2 });
          }
          for (let i = 0; i < 7500; i++) {
            insertMessage(id, { id: `${id}-tool-${i}`, role: 'tool_use', content: {}, createdAt: 2000 + i });
          }
        } else {
          for (let i = 0; i < 3800; i++) {
            insertMessage(id, { id: `${id}-narration-${i}`, role: 'assistant', content: 'Checking', createdAt: 1000 + i * 2 });
            insertMessage(id, { id: `${id}-tool-${i}`, role: 'tool_use', content: {}, createdAt: 1001 + i * 2 });
          }
          insertMessage(id, { id: `${id}-final`, role: 'assistant', content: 'Done', createdAt: 9000, agentMeta: { turnCompleted: true } });
        }
        for (let i = 0; i < 105; i++) {
          insertMessage(id, { id: `${id}-empty-${i}`, role: 'assistant', content: '', createdAt: 10000 + i });
        }
      }
    })();

    const messageCount = h.sqlite!.prepare('SELECT COUNT(*) FROM messages').pluck().get() as number;
    let roleReads = 0;
    h.sqlite!.function('count_message_role', (role) => {
      if (++roleReads > messageCount * 20) throw new Error('Message read budget exceeded');
      return role;
    });
    h.sqlite!.exec(`CREATE TEMP VIEW messages AS SELECT
      id, client_id, session_id, count_message_role(role) AS role, content,
      tool_use_id, agent_meta, agent_kind, created_at, rewind_at FROM main.messages`);
    h.db = drizzle(h.sqlite!, { logger: { logQuery() { roleReads = 0; } } });
    const preview = history === 'later turns' ? 'Reply 98' : 'Done';
    const replyAt = history === 'later turns' ? 1197 : 9000;
    const replyCount = history === 'later turns' ? 99 : 1;
    const [local] = await invoke('local-db:bots:list', { lastReadAtByBotId: { 'bot-1': 1 } });
    expect(local).toMatchObject({ lastMessagePreview: preview, lastMessageAt: replyAt, unreadCount: replyCount });
    expect(await invoke('local-db:bots:get', 'bot-1')).toMatchObject({ lastMessagePreview: preview, lastMessageAt: replyAt });
    expect(await getBotRemoteResourceSource('bot-1')).toMatchObject({ lastMessagePreview: preview, lastReplyAt: replyAt });
    expect(await invoke('local-db:bots:dm-thread:list', { botId: 'bot-1', rootSessionId: sessionId }))
      .toEqual([expect.objectContaining({ sessionId: thread.sessionId, replyCount, lastReplyAt: replyAt, lastAssistantAt: replyAt })]);
  });

  // The bound must preserve the former strict next_input < tool comparison, including
  // ties, absent boundaries and inputs that do not start a new turn (#6958).
  it.each([
    { label: 'next input before tool', inputAt: 2000, toolAt: 2001, visible: true },
    { label: 'next input tied with tool', inputAt: 2000, toolAt: 2000, visible: false },
    { label: 'input tied with reply', inputAt: 1000, toolAt: 2000, visible: false },
    { label: 'tool tied with reply', inputAt: 2000, toolAt: 1000, visible: true },
    { label: 'rewound input', inputAt: 2000, toolAt: 3000, rewindAt: 4000, visible: false },
    { label: 'auto-resume input', inputAt: 2000, toolAt: 3000, agentMeta: { autoResume: true }, visible: false },
    { label: 'steer input', inputAt: 2000, toolAt: 3000, agentMeta: { delivery: 'steer' }, visible: false },
    { label: 'rewound tool', inputAt: 3000, toolAt: 2000, toolRewindAt: 4000, visible: true },
  ])('preserves reply visibility at the turn boundary: $label', async ({ inputAt, toolAt, rewindAt, agentMeta, toolRewindAt, visible }) => {
    const sessionId = await canonicalFor('bot-1');
    insertMessage(sessionId, { id: 'reply', role: 'assistant', content: 'Reply', createdAt: 1000 });
    insertMessage(sessionId, { id: 'input', role: 'user', content: '', createdAt: inputAt, rewindAt, agentMeta });
    insertMessage(sessionId, { id: 'tool', role: 'tool_use', content: {}, createdAt: toolAt, rewindAt: toolRewindAt });
    expect(await unreadFor('bot-1', { 'bot-1': 1 })).toBe(visible ? 1 : 0);
    expect(await getBotRemoteResourceSource('bot-1')).toMatchObject({
      lastMessagePreview: visible ? 'Reply' : null,
      lastReplyAt: visible ? 1000 : 0,
    });
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

describe('Teammate task delivery and group lane messages', () => {
  const PROVIDER = 'localstub';

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

  function seedGroupLane(id = 'group-lane', route = 'group:fixture:access:owner:2') {
    h.sqlite!.prepare(`INSERT INTO sessions (id, source, status, working_dir, model, agent_kind, provider_id, permission_mode, created_at, updated_at)
      SELECT ?, source, status, working_dir, model, agent_kind, provider_id, permission_mode, created_at, updated_at FROM sessions WHERE id='session-1'`).run(id);
    h.sqlite!.prepare(`INSERT INTO bot_session_links (id, bot_id, session_id, profile_version, role, route_key, created_at)
      VALUES (?, 'bot-a', ?, 1, 'group', ?, 1)`).run(`${id}-link`, id, route);
  }

  it('projects the owning group of each hidden group lane so entries can return to that group', async () => {
    await seedPair();
    seedGroupLane('group-lane', 'group:fixture:access:owner:2');
    seedGroupLane('group-plan', 'group:fixture:plan:plan-1');
    const profile = await invoke('local-db:bots:get', 'bot-a') as { sessions: Array<Record<string, unknown>> };
    const byId = new Map(profile.sessions.map((session) => [session.id, session]));
    expect(byId.get('group-lane')).toMatchObject({ kind: 'group', role: 'group', groupId: 'fixture' });
    expect(byId.get('group-plan')).toMatchObject({ kind: 'group', role: 'group', groupId: 'fixture' });
    expect(byId.get('session-1')).toMatchObject({ kind: 'chat', role: 'canonical' });
    expect(byId.get('session-1')).not.toHaveProperty('groupId');
  });

  // V1 background tasks were retired (2026-11-08); nothing writes bot_delegations any more. Guards
  // old task cards and glance outputs going blank and old children losing their creator mark.
  // Real SQLite, production readers; a row still running at upgrade keeps its stored status.
  it('keeps old background tasks readable and still opened by their teammate', async () => {
    await seedPair(); seedGroupLane();
    for (const id of ['child-done', 'child-running']) {
      h.sqlite!.prepare("INSERT INTO sessions (id, source, status, title, created_at, updated_at) VALUES (?, 'desktop', 'active', ?, 1, 1)")
        .run(id, `Title ${id}`);
    }
    const insert = h.sqlite!.prepare(`INSERT INTO bot_delegations (id, requesting_bot_id, parent_session_id, child_session_id,
      objective, permission_snapshot_json, status, output_artifacts_json, pending_interaction_json, last_error, created_at, updated_at)
      VALUES (?, 'bot-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('done', 'session-1', 'child-done', 'Write the report', '{}', 'failed',
      JSON.stringify([{ path: 'report.md', absolutePath: '/work/report.md', status: 'added' }]), null, 'TIMEOUT: too slow', 2, 2);
    insert.run('running', 'group-lane', 'child-running', 'Group work', JSON.stringify({ groupOriginRoute: 'group:fixture:access:owner:2' }),
      'waiting', '[]', JSON.stringify({ requestId: 'r', kind: 'permission', summary: 'Approve', raisedAt: 1 }), null, 1, 1);

    const main = await listBotDelegationHistory('session-1');
    expect(main).toMatchObject({ ok: true, delegations: [
      { id: 'done', title: 'Title child-done', status: 'timed-out', targetBotName: 'Cindy',
        artifacts: [{ path: 'report.md', absolutePath: '/work/report.md', status: 'added' }] },
      { id: 'running', status: 'waiting', pendingInteraction: null },
    ] });
    expect(await listBotDelegationHistory('group-lane')).toMatchObject({ ok: true, delegations: [{ id: 'running' }] });
    expect(await listBotDelegationHistory('child-done')).toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
    expect(await readBotResponsibilityScope(h.userDataDir, 'bot-a')).toEqual({
      sessionIds: ['child-done', 'child-running'], delegatedSessionIds: ['child-done', 'child-running'],
    });
  });

  it.each([true, false])('counts an explicit group private send with subsequent tools (canonical running=%s)', async running => {
    await seedPair(); seedGroupLane();
    const release = registerGroupToolAuthority('group-lane', { botId: 'bot-a', mode: 'owner',
      sourceGroup: { groupId: 'fixture', name: 'Fixture group' }, isCurrent: () => true, validate: async () => {} });
    const service = createBotDirectMessageService({});
    try {
      h.getSession.mockReturnValue({ isTurnRunning: () => running, compactSession: vi.fn() });
      const sent = await service.sendToUser({ callerSessionId: 'group-lane', message: 'Explicit private reply', idempotencyKey: 'visible-private-fixture' });
      if (!sent.ok) throw new Error(sent.message);
      const row = h.sqlite!.prepare('SELECT created_at AS createdAt, agent_meta AS meta FROM messages WHERE id=?').get(sent.messageId) as { createdAt: number; meta: string };
      expect(JSON.parse(row.meta).turnCompleted).toBeUndefined();
      await createMessage(sent.targetSessionId, { clientId: 'later-progress', role: 'assistant', content: 'Private turn still working', createdAt: row.createdAt + 1 });
      await createMessage(sent.targetSessionId, { clientId: 'later-tool', role: 'tool_use', content: { name: 'Read' }, createdAt: row.createdAt + 2 });
      const list = async (lastReadAt: number) => (await invoke('local-db:bots:list', { lastReadAtByBotId: { 'bot-a': lastReadAt } }) as Array<{ id: string; unreadCount: number; lastMessagePreview: string }>).find(bot => bot.id === 'bot-a')!;
      expect(await list(row.createdAt - 1)).toMatchObject({ unreadCount: 1, lastMessagePreview: 'Explicit private reply' });
      expect(await getBotRemoteResourceSource('bot-a')).toMatchObject({ lastReplyAt: row.createdAt, lastMessagePreview: 'Explicit private reply' });
      expect(await list(row.createdAt)).toMatchObject({ unreadCount: 0 });
      h.sqlite!.prepare('UPDATE messages SET rewind_at=? WHERE id=?').run(row.createdAt + 3, sent.messageId);
      expect(await list(row.createdAt - 1)).toMatchObject({ unreadCount: 0 });
      expect((await getBotRemoteResourceSource('bot-a')).lastReplyAt).toBe(0);
      h.sqlite!.prepare('UPDATE messages SET rewind_at=NULL WHERE id=?').run(sent.messageId);
      h.sqlite!.prepare('UPDATE sessions SET cleared_at=? WHERE id=?').run(row.createdAt + 3, sent.targetSessionId);
      expect(await list(row.createdAt - 1)).toMatchObject({ unreadCount: 0 });
      expect((await getBotRemoteResourceSource('bot-a')).lastReplyAt).toBe(0);
    } finally { release(); }
  });

  it.each(['Private reply', '"Private reply"', '123', '{"reply":"ok"}', 'line one\nline two'])('compares exact persisted private text on retries: %s', async message => {
    await seedPair(); seedGroupLane();
    const release = registerGroupToolAuthority('group-lane', { botId: 'bot-a', mode: 'owner',
      sourceGroup: { groupId: 'fixture' }, isCurrent: () => true, validate: async () => {} });
    const service = createBotDirectMessageService({});
    const input = { callerSessionId: 'group-lane', message, idempotencyKey: 'exact-text-fixture' };
    try {
      const first = await service.sendToUser(input);
      expect(first).toMatchObject({ ok: true, delivered: true });
      if (!first.ok) throw new Error(first.message);
      expect(h.sqlite!.prepare('SELECT content FROM messages WHERE id=?').pluck().get(first.messageId)).toBe(message);
      expect(await service.sendToUser(input)).toEqual(first);
      expect(await service.sendToUser({ ...input, message: message + ' changed' }))
        .toMatchObject({ ok: false, errorCode: 'IDEMPOTENCY_CONFLICT' });
      expect(h.sqlite!.prepare("SELECT count(*) FROM messages WHERE client_id LIKE 'bot-group-private:%'").pluck().get()).toBe(1);
    } finally { release(); }
  });

  it.each(['revoked', 'owner-changed'] as const)('removes an unpublished group private message when %s during persistence', async failure => {
    await seedPair(); seedGroupLane();
    let revoked = false;
    const release = registerGroupToolAuthority('group-lane', { botId: 'bot-a', mode: 'owner',
      sourceGroup: { groupId: 'fixture' }, isCurrent: () => true,
      validate: async () => { if (revoked) throw new GroupToolAuthorizationError(); } });
    const originalTx = h.tx!;
    h.tx = async (name, args) => {
      const result = await originalTx(name, args);
      if (name === 'message.insert' && (args as { publication?: string }).publication === 'stage') {
        expect(h.sqlite!.prepare("SELECT count(*) FROM messages WHERE content = 'Must stay private' AND rewind_at IS NULL").pluck().get()).toBe(0);
        if (failure === 'revoked') revoked = true;
        else h.ownerScopeKey = 'owner-b:2';
      }
      return result;
    };
    const service = createBotDirectMessageService({
      captureOwnerScope: () => ({ ownerScopeKey: h.ownerScopeKey, ownerStamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 } }),
      isOwnerScopeCurrent: scope => scope.ownerScopeKey === h.ownerScopeKey });
    try {
      expect(await service.sendToUser({ callerSessionId: 'group-lane', message: 'Must stay private', idempotencyKey: 'post-write-revoke' }))
        .toMatchObject({ ok: false, errorCode: 'GROUP_AUTHORIZATION_REQUIRED' });
      expect(h.sqlite!.prepare("SELECT count(*) FROM messages WHERE content = 'Must stay private'").pluck().get()).toBe(0);
    } finally { h.tx = originalTx; release(); }
  });

});

afterAll(() => {
  resetCustomMcpRegistry();
  h.sqlite?.close();
  rmSync(h.userDataDir, { recursive: true, force: true });
});


describe('Bot self control uses the same profile authority as settings', () => {
  it('reads only its own state and patches requested fields without replacing independent configuration', async () => {
    const canonical = await invoke('local-db:bots:create-canonical-session', { botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1 });
    const sessionId = canonical.session.id;
    const service = createBotCapabilityService(capabilityDeps);
    const initial = await service.inspect({ callerSessionId: sessionId });
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error('Expected current Bot');
    const before = await invoke('local-db:bots:get', 'bot-1');
    expect(await service.updateProfile({ callerSessionId: sessionId,
      expectedVersion: initial.state.profile.version, name: 'Renamed' })).toMatchObject({ ok: true, effective: 'next-turn' });
    const after = await invoke('local-db:bots:get', 'bot-1');
    expect(after.name).toBe('Renamed');
    expect(after.capabilities).toEqual(before.capabilities);
    expect(after.identitySource).toBe(before.identitySource);
    expect(after.canonicalSessionId).toBe(before.canonicalSessionId);
    expect(await service.updateProfile({ callerSessionId: sessionId,
      expectedVersion: initial.state.profile.version, name: 'Stale' })).toMatchObject({ ok: false });
    expect(await service.inspect({ callerSessionId: 'not-a-bot' })).toMatchObject({ ok: false });
    expect((await invoke('local-db:bots:get', 'bot-1')).name).toBe('Renamed');
  });
});


describe('Teammate model selection shares profile persistence and route reconciliation', () => {
  // #7177, DB tier: older clients leave an unversioned automation baseline
  // after a permanent choice. Existing cases only change the saved model.
  // Exercise the real IPC/transaction and cold send preparation: accepting the
  // already-saved choice must fence the old restore without editing the choice.
  it('accepts the saved permanent choice over a legacy baseline after restart', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const sessionId = created.session.id as string;
    const before = await invoke('local-db:bots:get', 'bot-1');
    const legacy = JSON.stringify({ scopeId: 'legacy', agentKind: 'codex', model: 'old-model',
      providerId: 'removed-provider', effort: 'medium', fastMode: false });
    h.sqlite!.prepare('UPDATE sessions SET scheduled_model_baseline = ? WHERE id = ?').run(legacy, sessionId);
    const readBaseline = () => h.sqlite!.prepare('SELECT scheduled_model_baseline FROM sessions WHERE id = ?')
      .pluck().get(sessionId) as string | null;
    await invoke('local-db:bots:update', { id: 'bot-1', acceptSavedModelSelectionVersion: before.currentVersion });
    const after = await invoke('local-db:bots:get', 'bot-1');
    expect(after.capabilities).toEqual(before.capabilities);
    expect(after.currentVersion).toBe(before.currentVersion + 1);
    expect(JSON.parse(readBaseline()!)).toMatchObject({ pendingBotProfileVersion: after.currentVersion });
    const chain = await modelSettings.readEffectiveBotModelChain(after.capabilities);
    const restoreOld = vi.fn(async () => { throw new Error('removed provider must not be restored'); });
    const cold = createBotModelRouteReconciler({ ownerEpoch: () => h.ownerScopeKey,
      read: async () => ({ chain, current: { agentKind: 'codex', model: 'old-model', providerId: 'removed-provider',
        effort: 'medium', fastMode: false }, hasRuntimeOverride: false, scheduledModelBaseline: readBaseline() }),
      apply: async () => { throw new Error('route not ready'); },
      onSelectionAccepted: async (id, expected) => h.sqlite!.prepare(
        'UPDATE sessions SET scheduled_model_baseline = NULL WHERE id = ? AND scheduled_model_baseline IS ?',
      ).run(id, expected ?? null).changes === 1,
    });
    const scope = createScheduledModelScope({ read: async () => ({ profile: {
      agentKind: 'codex', model: 'old-model', providerId: 'removed-provider', effort: 'medium', fastMode: false,
    }, baseline: readBaseline() }), write: async () => {}, apply: restoreOld, isBusy: () => false, createId: () => 'unused' });
    await scope.restore(sessionId);
    expect(restoreOld).not.toHaveBeenCalled();
    await expect(cold(sessionId)).rejects.toThrow('route not ready');
    expect(JSON.parse(readBaseline()!)).toMatchObject({ pendingBotProfileVersion: after.currentVersion });
    const applied: unknown[] = [];
    const ready = createBotModelRouteReconciler({ ownerEpoch: () => h.ownerScopeKey,
      read: async () => ({ chain, current: { agentKind: 'codex', model: 'old-model', providerId: 'removed-provider',
        effort: 'medium', fastMode: false }, hasRuntimeOverride: false, scheduledModelBaseline: readBaseline() }),
      apply: async (_id, route) => { applied.push(route); },
      onSelectionAccepted: async (id, expected) => h.sqlite!.prepare(
        'UPDATE sessions SET scheduled_model_baseline = NULL WHERE id = ? AND scheduled_model_baseline IS ?',
      ).run(id, expected ?? null).changes === 1,
    });
    await ready(sessionId);
    expect(applied).toEqual([expect.objectContaining({ model: chain[0]!.model, providerId: chain[0]!.providerId })]);
    expect(readBaseline()).toBeNull();
    await expect(invoke('local-db:bots:update', { id: 'bot-1', acceptSavedModelSelectionVersion: before.currentVersion }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  // #6895 P1: the previous crash test stopped at the profile commit. A subsequent
  // automation could recreate A before runtime refresh. DB tier: exercise the
  // real save transaction, send locks, reconciler and baseline writer in both
  // orders, then restore through a fresh scope (no runtime refresh or timers).
  it.each(['save-first', 'automation-first'] as const)('does not resurrect an old route when %s races baseline capture', async (order) => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const sessionId = created.session.id as string;
    const read = async () => {
      const row = h.sqlite!.prepare(`SELECT s.agent_kind AS agentKind, s.model, s.provider_id AS providerId, s.effort, s.fast_mode AS fastMode,
        s.scheduled_model_baseline AS baseline, json_array(p.id, p.current_version) AS profileRevision
        FROM sessions s JOIN bot_session_links l ON l.session_id = s.id
        JOIN bot_profiles p ON p.id = l.bot_id WHERE s.id = ?`)
        .get(sessionId) as ScheduledModelSelection & { baseline: string | null; profileRevision: string };
      return { profile: { ...row, fastMode: !!row.fastMode }, baseline: row.baseline, profileRevision: row.profileRevision };
    };
    const apply = async (_id: string, route: Omit<ScheduledModelSelection, 'effort'> & { effort: string | null }) => {
      h.sqlite!.prepare('UPDATE sessions SET agent_kind = ?, model = ?, provider_id = ?, effort = ?, fast_mode = ? WHERE id = ?')
        .run(route.agentKind, route.model, route.providerId, route.effort ?? '', Number(route.fastMode), sessionId);
    };
    const reconcile = createBotModelRouteReconciler({ ownerEpoch: () => h.ownerScopeKey,
      withSessionLock: withSendToSessionLock,
      read: async () => {
        const state = await read();
        const bot = await invoke('local-db:bots:get', 'bot-1');
        return { chain: await modelSettings.readEffectiveBotModelChain(bot.capabilities),
          current: state.profile, hasRuntimeOverride: true,
          scheduledModelBaseline: state.baseline };
      }, apply,
      onSelectionAccepted: async (id, expected) => h.sqlite!.prepare(
        'UPDATE sessions SET scheduled_model_baseline = NULL WHERE id = ? AND scheduled_model_baseline IS ?',
      ).run(id, expected ?? null).changes === 1,
    });
    let savingReachedLock!: () => void;
    const waiting = new Promise<void>((resolve) => { savingReachedLock = resolve; });
    configureBotModelSelectionCoordinator(createBotModelSelectionCoordinator({
      acquireSessionLock: (id) => { savingReachedLock(); return acquireSendToSessionLock(id); },
      cancelRecovery: () => {}, // This fixture has no input coordinator or pending continuation.
      invalidate: reconcile.invalidate,
    }));
    const deps = { read, apply, isBusy: () => false, createId: () => 'race-scope',
      prepareBaseline: (id: string) => reconcile(id, true),
      write: async (_id: string, baseline: Parameters<typeof writeScheduledModelBaselineIfProfileCurrent>[2] | null, revision?: string | null) => {
        if (baseline) return writeScheduledModelBaselineIfProfileCurrent({
          exec: async (sql, params) => h.sqlite!.prepare(sql).run(...params),
        }, sessionId, baseline, revision ?? null);
        h.sqlite!.prepare('UPDATE sessions SET scheduled_model_baseline = ? WHERE id = ?')
          .run(baseline ? JSON.stringify(baseline) : null, sessionId);
      },
    };
    const scope = createScheduledModelScope(deps);
    const save = () => invoke('local-db:bots:update', { id: 'bot-1', capabilities: {
      // Combined settings also enter the permission commit fence from #6782.
      permissions: 'auto',
      modelChainOverride: [{ harness: 'codex', model: 'new-saved-model', providerId: null, effort: 'medium', fastMode: false }],
    } });
    if (order === 'automation-first') {
      const release = await acquireSendToSessionLock(sessionId);
      const saving = save();
      try {
        await waiting;
        await scope.begin(sessionId);
        expect(JSON.parse((await read()).baseline!).model).not.toBe('new-saved-model');
      } finally { release(); }
      await saving;
      expect(JSON.parse((await read()).baseline!)).toMatchObject({ pendingBotProfileVersion: 2 });
    } else {
      await save();
    }
    expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get(sessionId)).toBe('auto');
    // requestRuntimeRefresh is inert in this fixture: begin must align the saved
    // route itself rather than relying on the asynchronous refresh continuation.
    await withSendToSessionLock(sessionId, () => scope.begin(sessionId));
    expect(JSON.parse((await read()).baseline!)).toMatchObject({ agentKind: 'codex', model: 'new-saved-model' });
    await apply(sessionId, { agentKind: 'pi', model: 'temporary', providerId: null, effort: null, fastMode: false });
    await withSendToSessionLock(sessionId, () => createScheduledModelScope(deps).restore(sessionId));
    expect((await read()).profile).toMatchObject({ agentKind: 'codex', model: 'new-saved-model' });
    expect((await read()).baseline).toBeNull();
  });

  // #6895 review, DB tier: a lane linked after the follower snapshot has no
  // send lock in that save. The real IPC save and conditional baseline writer
  // must reject its post-commit write, rather than resurrect A after restart.
  it('fences a new lane baseline writer outside the model-save lock snapshot', async () => {
    let sessionId = '';
    const read = async () => {
      const row = h.sqlite!.prepare(`SELECT s.agent_kind AS agentKind, s.model, s.provider_id AS providerId,
        s.effort, s.fast_mode AS fastMode, s.scheduled_model_baseline AS baseline,
        json_array(p.id, p.current_version) AS profileRevision
        FROM sessions s JOIN bot_session_links l ON l.session_id = s.id
        JOIN bot_profiles p ON p.id = l.bot_id WHERE s.id = ?`).get(sessionId) as
        ScheduledModelSelection & { baseline: string | null; profileRevision: string };
      return { profile: { ...row, fastMode: !!row.fastMode }, baseline: row.baseline, profileRevision: row.profileRevision };
    };
    const db = { exec: async (sql: string, params: unknown[]) => h.sqlite!.prepare(sql).run(...params) };
    configureBotModelSelectionCoordinator(async (ids, operation) => {
      const lane = await ensureBotChannelLaneSession({ botId: 'bot-1', routeKey: 'im:feishu:fixture:g:save-race', title: 'New lane' });
      if (!lane.ok) throw new Error(lane.message);
      sessionId = lane.sessionId;
      expect(ids).not.toContain(sessionId);
      let reachedWrite!: () => void;
      const writing = new Promise<void>((resolve) => { reachedWrite = resolve; });
      let releaseWrite!: () => void;
      const committed = new Promise<void>((resolve) => { releaseWrite = resolve; });
      const scope = createScheduledModelScope({ read, createId: () => 'late-lane', isBusy: () => false,
        apply: async () => undefined,
        write: async (id, baseline, revision) => {
          if (!baseline) return;
          reachedWrite();
          await committed;
          return writeScheduledModelBaselineIfProfileCurrent(db, id, baseline, revision ?? null);
        },
      });
      const capture = scope.begin(sessionId);
      await writing;
      const result = await operation().finally(releaseWrite);
      await expect(capture).rejects.toThrow(ScheduledModelSelectionBusyError);
      return result;
    });
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: {
      modelChainOverride: [{ harness: 'codex', model: 'new-saved-model', providerId: null, effort: 'medium', fastMode: false }],
    } });
    expect(JSON.parse((await read()).baseline!)).toMatchObject({ pendingBotProfileVersion: 2 });
    const bot = await invoke('local-db:bots:get', 'bot-1');
    const apply = async (_id: string, route: ScheduledModelSelection) => {
      h.sqlite!.prepare('UPDATE sessions SET agent_kind = ?, model = ?, provider_id = ?, effort = ?, fast_mode = ? WHERE id = ?')
        .run(route.agentKind, route.model, route.providerId, route.effort ?? '', Number(route.fastMode), sessionId);
    };
    const cold = createBotModelRouteReconciler({ ownerEpoch: () => h.ownerScopeKey,
      read: async () => ({ chain: await modelSettings.readEffectiveBotModelChain(bot.capabilities),
        current: (await read()).profile, hasRuntimeOverride: false, scheduledModelBaseline: (await read()).baseline }), apply,
      onSelectionAccepted: async (id, expected) => h.sqlite!.prepare(
        'UPDATE sessions SET scheduled_model_baseline = NULL WHERE id = ? AND scheduled_model_baseline IS ?',
      ).run(id, expected ?? null).changes === 1,
    });
    expect(await cold.preview(sessionId)).toMatchObject({ model: 'new-saved-model' });
    const deps = { read, apply, isBusy: () => false, createId: () => 'retry', prepareBaseline: cold,
      write: async (id: string, baseline: Parameters<typeof writeScheduledModelBaselineIfProfileCurrent>[2] | null, revision?: string | null) => {
        if (baseline) return writeScheduledModelBaselineIfProfileCurrent(db, id, baseline, revision ?? null);
        h.sqlite!.prepare('UPDATE sessions SET scheduled_model_baseline = NULL WHERE id = ?').run(id);
      },
    };
    await createScheduledModelScope(deps).begin(sessionId);
    expect(JSON.parse((await read()).baseline!)).toMatchObject({ model: 'new-saved-model' });
    await apply(sessionId, { agentKind: 'pi', model: 'temporary', providerId: null, effort: null, fastMode: false });
    await createScheduledModelScope(deps).restore(sessionId);
    expect((await read()).profile).toMatchObject({ model: 'new-saved-model' });
  });

  // #6895 DB regression: a crash after the profile commit but before the async
  // runtime refresh must not restore the superseded choice on the next cold send.
  it('commits a new model and retires its restore before runtime refresh, while unrelated edits retain it', async () => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const sessionId = created.session.id;
    const baseline = JSON.stringify({ scopeId: 'automation', agentKind: 'pi', model: 'old-model', providerId: null, effort: null, fastMode: false });
    h.sqlite!.prepare('UPDATE sessions SET scheduled_model_baseline = ? WHERE id = ?').run(baseline, sessionId);
    const readBaseline = () => (h.sqlite!.prepare('SELECT scheduled_model_baseline AS baseline FROM sessions WHERE id = ?').get(sessionId) as { baseline: string | null }).baseline;
    await invoke('local-db:bots:update', { id: 'bot-1', name: 'Renamed companion' });
    expect(readBaseline()).toBe(baseline);
    h.requestRuntimeRefresh.mockClear();
    const runTx = h.tx!;
    h.tx = async (name, args) => {
      const result = await runTx(name, args);
      if (name === 'bots.updateProfile') throw new Error('simulated process loss after commit');
      return result;
    };
    await expect(invoke('local-db:bots:update', { id: 'bot-1', capabilities: {
      modelChainOverride: [{ harness: 'codex', model: 'new-saved-model', providerId: null, effort: 'medium', fastMode: false }],
    } })).rejects.toThrow('simulated process loss after commit');
    expect(h.requestRuntimeRefresh).not.toHaveBeenCalled();
    expect(JSON.parse(readBaseline()!)).toMatchObject({ pendingBotProfileVersion: 3 });
    const profile = await invoke('local-db:bots:get', 'bot-1');
    const chain = await modelSettings.readEffectiveBotModelChain(profile.capabilities);
    const apply = vi.fn();
    const cold = createBotModelRouteReconciler({ ownerEpoch: () => h.ownerScopeKey,
      read: async () => ({ chain, current: { agentKind: 'pi', model: 'temporary-model', providerId: null, effort: null, fastMode: false },
        scheduledModelBaseline: readBaseline(), hasRuntimeOverride: false }), apply,
      onSelectionAccepted: async (id, expected) => h.sqlite!.prepare(
        'UPDATE sessions SET scheduled_model_baseline = NULL WHERE id = ? AND scheduled_model_baseline IS ?',
      ).run(id, expected ?? null).changes === 1,
    });
    expect(await cold.preview(sessionId)).toMatchObject({ agentKind: 'codex', model: 'new-saved-model' });
    await cold(sessionId);
    expect(apply).toHaveBeenCalledWith(sessionId, expect.objectContaining({ agentKind: 'codex', model: 'new-saved-model' }), expect.anything());
    expect(readBaseline()).toBeNull();
  });

  async function setupModelControl() {
    const canonical = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const model = { ...h.providers[0]!.models.pi![0]!, id: 'enabled-alternate-model' };
    h.providers[0]!.models.pi!.push(model);
    model.efforts = ['low', 'high'];
    model.defaultEnabled = true;
    return { sessionId: canonical.session.id as string,
      service: createBotCapabilityService(capabilityDeps),
      id: JSON.stringify(['pi', 'xd', model.id]), model };
  }

  // #7177, DB tier: an explicit same-value tool selection must reach the
  // acceptance transaction; a plain metadata edit must retain the old scope.
  it('reaccepts the same model through the teammate tool without treating a rename as recovery', async () => {
    const { service, sessionId, id } = await setupModelControl();
    const modelChain = [{ id, effort: 'low', fastMode: false }];
    expect(await service.updateProfile({ callerSessionId: sessionId, expectedVersion: 1, modelChain }))
      .toMatchObject({ ok: true });
    const before = await invoke('local-db:bots:get', 'bot-1');
    const legacy = JSON.stringify({ scopeId: 'legacy', agentKind: 'codex', model: 'old-model',
      providerId: 'removed-provider', effort: 'medium', fastMode: false });
    h.sqlite!.prepare('UPDATE sessions SET scheduled_model_baseline = ? WHERE id = ?').run(legacy, sessionId);
    const readBaseline = () => h.sqlite!.prepare('SELECT scheduled_model_baseline FROM sessions WHERE id = ?')
      .pluck().get(sessionId) as string;
    expect(await service.updateProfile({ callerSessionId: sessionId, expectedVersion: before.currentVersion, name: 'New name' }))
      .toMatchObject({ ok: true });
    expect(readBaseline()).toBe(legacy);
    const renamed = await invoke('local-db:bots:get', 'bot-1');
    expect(await service.updateProfile({ callerSessionId: sessionId, expectedVersion: renamed.currentVersion, modelChain }))
      .toMatchObject({ ok: true });
    const after = await invoke('local-db:bots:get', 'bot-1');
    expect(after.capabilities).toEqual(before.capabilities);
    expect(after.name).toBe('New name');
    expect(JSON.parse(readBaseline())).toMatchObject({ pendingBotProfileVersion: after.currentVersion });
    expect(after.currentVersion).toBe(renamed.currentVersion + 1);
  });

  // DB regression: a per-teammate reset follows the teammate default even if
  // the new-task composer changes later; previously the two were coupled.
  it('saves its own model chain, applies it through the send resolver, and resets independently of new tasks', async () => {
    const { service, sessionId, id } = await setupModelControl();
    await invoke('local-db:bots:create', { id: 'bot-2', name: 'Other teammate', avatar: '🐈' });
    const before = await invoke('local-db:bots:get', 'bot-1');
    const other = await invoke('local-db:bots:get', 'bot-2');
    const appDefault = getSelectedNewMakerRoute(h.ownerScopeKey);
    const botDefault = await modelSettings.readEffectiveBotModelChain({ modelChainOverride: null });
    expect(await service.updateProfile({ callerSessionId: sessionId, expectedVersion: 1,
      modelChain: [{ id, effort: 'low', fastMode: false }] })).toMatchObject({ ok: true, effective: 'next-turn' });
    const after = await invoke('local-db:bots:get', 'bot-1');
    const chain = await modelSettings.readEffectiveBotModelChain(after.capabilities);
    expect(chain).toEqual([{ harness: 'pi', providerId: 'xd', model: 'enabled-alternate-model', effort: 'low', fastMode: false }]);
    expect(after.identitySource).toBe(before.identitySource);
    expect(after.canonicalSessionId).toBe(sessionId);
    for (const key of ['skills', 'mcpServers', 'toolsets', 'memory', 'permissions'])
      expect(after.capabilities[key]).toEqual(before.capabilities[key]);
    expect(await invoke('local-db:bots:get', 'bot-2')).toEqual(other);
    expect(getSelectedNewMakerRoute(h.ownerScopeKey)).toEqual(appDefault);
    const apply = vi.fn();
    // A fresh reconciler models restart; the saved choice, not an ephemeral override, owns the next send.
    await createBotModelRouteReconciler({ ownerEpoch: () => h.ownerScopeKey,
      read: async () => ({ chain, current: { agentKind: 'pi', model: 'grok-4.5', providerId: null, effort: 'high', fastMode: false }, hasRuntimeOverride: false }), apply,
    })(sessionId);
    expect(apply).toHaveBeenCalledWith(sessionId, expect.objectContaining({ effort: 'low', model: 'enabled-alternate-model' }), expect.anything());
    expect(await service.updateProfile({ callerSessionId: sessionId, expectedVersion: 1, modelChain: null })).toMatchObject({ ok: false });
    expect(await service.updateProfile({ callerSessionId: sessionId, expectedVersion: 2, modelChain: null })).toMatchObject({ ok: true });
    const restored = await invoke('local-db:bots:get', 'bot-1');
    expect(restored.capabilities.modelChainOverride).toBeNull();
    expect(await modelSettings.readEffectiveBotModelChain(restored.capabilities)).toEqual(botDefault);
    const nextDefault = { ...appDefault!, effort: 'low' };
    setNewMakerDraftCache({ selectedRoute: nextDefault, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, h.ownerScopeKey);
    expect(await modelSettings.readEffectiveBotModelChain(restored.capabilities)).toEqual(botDefault);
  });

  it.each(['disabled', 'disconnected', 'effort', 'fast', 'duplicate', 'unknown', 'owner', 'foreign'] as const)(
    'rejects %s selection without changing profile or app defaults', async (kind) => {
      const { service, sessionId, id, model } = await setupModelControl();
      const before = await invoke('local-db:bots:get', 'bot-1');
      const appDefault = getSelectedNewMakerRoute(h.ownerScopeKey);
      const choice = { id, effort: 'low', fastMode: false };
      if (kind === 'disabled') model.defaultEnabled = false;
      if (kind === 'disconnected') h.providers[0]!.connected = false;
      if (kind === 'effort') choice.effort = 'ultra';
      if (kind === 'fast') choice.fastMode = true;
      if (kind === 'unknown') choice.id = 'not-a-route';
      if (kind === 'owner') h.ownerBoundaryPending = true;
      const result = await service.updateProfile({ callerSessionId: kind === 'foreign' ? 'ordinary-session' : sessionId,
        expectedVersion: 1, modelChain: kind === 'duplicate' ? [choice, choice] : [choice] });
      expect(result).toMatchObject({ ok: false });
      h.ownerBoundaryPending = false;
      expect(await invoke('local-db:bots:get', 'bot-1')).toEqual(before);
      expect(getSelectedNewMakerRoute(h.ownerScopeKey)).toEqual(appDefault);
    });
});


/** Delay real SQL replies to expose fan-out hidden by the synchronous fixture. */
function observeBotReadConcurrency() {
  let active = 0;
  let peak = 0;
  const transport: DbTransport = {
    async send<R>(op: string, args: unknown): Promise<R> {
      if (op !== 'rawAll') throw new Error(`unexpected read operation: ${op}`);
      const { sql, params } = args as { sql: string; params: unknown[] };
      peak = Math.max(peak, ++active);
      try {
        const rows = h.sqlite!.prepare(sql).raw().all(...params);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return rows as R;
      } finally { active--; }
    },
    on() {}, onTerminated() {}, async close() {},
  };
  h.db = createDrizzleProxy(transport);
  return () => peak;
}

it.each(['local', 'remote', 'resources'])('bounds %s companion roster reads without dropping profiles', async (entry) => {
  const [profile] = await h.db!.select().from(botProfiles);
  const [version] = await h.db!.select().from(botProfileVersions);
  for (let i = 2; i <= 20; i++) {
    const id = `roster-${i}`;
    await h.db!.insert(botProfiles).values({ ...profile, id, displayName: id });
    await h.db!.insert(botProfileVersions).values({ ...version, id: `${id}-version`, botId: id });
  }
  const peak = observeBotReadConcurrency();
  const rows = entry === 'resources' ? await listBotRemoteResourceSources()
    : entry === 'remote' ? await runDeviceLinkInvokeContext(
      { controllerDeviceId: 'mobile-roster', channel: 'local-db:bots:list' },
      () => invoke('local-db:bots:list', undefined),
    ) : await invoke('local-db:bots:list', undefined);
  expect(rows).toHaveLength(20);
  expect(new Set(rows.map((row: { id: string }) => row.id)).size).toBe(20);
  expect(peak()).toBe(1);
});

it('reads long companion history snapshots sequentially and keeps every latest snapshot', async () => {
  const created = await invoke('local-db:bots:create-canonical-session', {
    botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
  });
  const [session] = await h.db!.select().from(sessions);
  for (let i = 1; i <= 40; i++) {
    const id = `history-${i}`;
    await h.db!.insert(sessions).values({ ...session, id });
    await h.db!.insert(botSessionLinks).values({ id, botId: 'bot-1', sessionId: id, role: 'history', profileVersion: 1, createdAt: i });
    h.sqlite!.prepare(`INSERT INTO bot_runtime_snapshots
      (id, bot_id, session_id, profile_version, agent_kind, working_dir, status, prepared_at, configured_json)
      VALUES (?, 'bot-1', ?, 1, 'pi', '/workspace', 'prepared', ?, '{}')`).run(id, id, i);
  }
  const peak = observeBotReadConcurrency();
  const profile = await invoke('local-db:bots:get', 'bot-1');
  expect(profile.sessions).toHaveLength(41);
  expect(profile.sessions.filter((row: { runtimeSnapshot?: unknown }) => row.runtimeSnapshot)).toHaveLength(40);
  expect(profile.sessions.some((row: { id: string }) => row.id === created.session.id)).toBe(true);
  expect(peak()).toBe(1);
});
