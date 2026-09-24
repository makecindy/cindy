import { createDrizzleProxy } from '../../client/drizzleProxy';
import type { DbTransport } from '../../client/DbTransport';
import { getSelectedNewMakerRoute, setNewMakerDraftCache } from '../../../maker-host/newMakerDefaultsCache';
import { setModelVisibilityMirror } from '../../../maker-host/model-visibility-mirror';
import { setMainLocale } from '../../../i18n';
import Database from 'better-sqlite3';
import { AgentInputCoordinator } from '../../../maker-ipc/agent-input-coordinator';
import { createSessionQueueControlService } from '../../../maker-ipc/sessionQueueControl';
import { createMessage } from '../messages';
import { authorizeSessionQueueItem, rebuildSessionQueueItem } from '../../../maker-ipc/sessionControlService';
import type { AgentInputQueuedMessage } from '../../../../shared/agentInputQueue';
import type { ProviderView } from '@cindy/model-providers';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { drizzle } from 'drizzle-orm/better-sqlite3';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_TEMPLATE_PRESET_IDENTITIES } from '../../../../shared/botTemplatePreset';
import { normalizeWorkingDirForStorage } from '../../../../shared/workingDir';
import { createBotModelRouteReconciler } from '../../../maker-ipc/botModelRouteReconciler';
import type { BotModelRoute } from '../../../../shared/botModelChain';
import type { AgentKind } from '@cindy/maker-core';
import { createBotCapabilityService, type BotCapabilityUpdate } from '../../../maker-ipc/botCapabilityService';
import { buildBotMcpCatalog } from '../../../maker-host/botMcpCatalog';
import { CustomMcpProvider } from '../../../mcp-integrations/custom-mcp-provider';
import type { McpProvider } from '@cindy/maker-core';
import type { CustomMcpConfig } from '../../../../shared/customMcp';
import { getMaker, getPluginRegistry, isBotToolsetAvailable } from '../../../maker-host/index';
import { getBuiltinMcpServerNames, refreshCustomMcpProviders, registerCustomMcpArrays, resetCustomMcpRegistry } from '../../../mcp-integrations/custom-mcp-registry';
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
  getSession: vi.fn(() => null as {
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
vi.mock('../../../maker-host/custom-mcp-store.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../maker-host/custom-mcp-store.js')>(),
  listCustomMcpServers: async () => h.customMcpConfigs,
}));
vi.mock('../../../maker-host/createDesktopProviderService.js', () => ({
  getDesktopProviderService: () => ({ listProviders: h.listProviders }),
}));
vi.mock('../../../maker-host/index.js', () => ({
  validateBotCapabilityAdditions: h.validateCapabilityAdditions,
  getMaker: () => ({ getSession: h.getSession, listAgentSkills: async () => ({ skills: [{ name: 'release-check', description: 'Release checklist', enabled: true }] }) }),
  getPluginRegistry: () => ({
    getPlugins: () => ['memory', 'xdt_helper', 'contacts', 'lsp'].map((id) => ({ id, name: id, description: id })),
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
    ownerScopedUserDataPath: () => join(h.userDataDir, createHash('sha256').update(h.ownerScopeKey).digest('hex')),
  };
});

import {
  createBotCanonicalSession,
  registerBotIpc,
  updateBotProfile as updateStoredBotProfile,
  getBotRemoteResourceSource,
  listBotRemoteResourceSources,
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
import { createBotLifecycleService } from '../../../maker-ipc/botLifecycleService';
import { createBotDirectMessageService } from '../../../maker-ipc/botDirectMessageService';
import { createBotDelegationService, discardDelegationQueuedInputs } from '../../../maker-ipc/botDelegationService';
import {
  BOT_DELEGATION_MAX_DISPATCH_ATTEMPTS,
} from '../../../maker-ipc/botDelegationDispatchOutcome';
import { ACCOUNT_PROVIDER_NOT_READY_CODE } from '../../../../shared/accountProviderReadiness';
import { configureBotCanonicalReplacementCoordinator } from '../../../maker-ipc/botCanonicalReplacementCoordinator';
import type { MakerSessionCreateOpts } from '../../../maker-ipc/sessionRequest';
import { parseBotDelegationPlanSnapshot } from '../../../../shared/botDelegation';
import { readBotCollaborationMeta } from '../../../../shared/botCollaboration';
import { UI_ACTION_TRIGGER_PREFIX } from '../../../../shared/interruptedTurn';
import { readRemoteBotSessionAccess } from '../botRemoteSessionAccess';
import { assertRemoteBotInvocationAllowed, projectRemoteSessionResult, projectRemoteBotPush } from '../../../device-link/remoteBotSessionBoundary';
import { listBotSkillsForSession, saveBotSkillForSession } from '../../../maker-ipc/botSkillService';
import { resolveBotCanonicalSession } from '../../../maker-ipc/botCanonicalSessionRegistry';
import { provisionDefaultBot } from '../../../maker-ipc/botDefaultProvisioning';
import { resolveSafe } from '../../../cindy-media/blobStore';

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
      context_window_runtime INTEGER,
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
    routing: { pi: { upstream: 'https://example.invalid', authStrategy: 'gateway-key' } },
    models: { pi: [{ id: 'z-ai/glm-5.3-flash', efforts: ['high'], defaultEffort: 'high',
      newSessionDefault: ['pi'], supportsImageInput: true }] },
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

  it.each(['hidden', 'archived'])('enforces %s companion visibility for cached task IDs, lists and pushes while retaining local access', async (state) => {
    const created = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const id = created.session.id;
    expect(await readRemoteBotSessionAccess(id)).toBe('visible');
    await expect(assertRemoteBotInvocationAllowed([id])).resolves.toBeUndefined();
    expect(await projectRemoteSessionResult('local-db:sessions:get', created.session)).toEqual(created.session);
    if (state === 'hidden') h.sqlite!.prepare("UPDATE bot_profiles SET hidden_at = 1 WHERE id = 'bot-1'").run();
    else h.sqlite!.prepare("UPDATE bot_profiles SET status = 'archived' WHERE id = 'bot-1'").run();
    expect(await readRemoteBotSessionAccess(id)).toBe('hidden');
    await expect(assertRemoteBotInvocationAllowed([id])).rejects.toThrow('[NOT_FOUND]');
    await expect(assertRemoteBotInvocationAllowed([{ sessionId: id }])).rejects.toThrow('[NOT_FOUND]');
    expect(await projectRemoteSessionResult('local-db:sessions:list', [created.session])).toEqual([]);
    expect(await projectRemoteSessionResult('maker:list-active', [{ sessionId: id }])).toEqual([]);
    expect(await projectRemoteBotPush({ sessionId: id, content: 'private reply' })).toBeNull();
    expect(await projectRemoteBotPush(created.session, 'local-db:sessions:created')).toBeNull();
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

  it('creates the first canonical task on Codex when only its subscription is connected', async () => {
    h.providers = [{
      id: 'openai', source: 'builtin', connected: true, agents: ['codex'],
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
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xd',
      effort: 'high',
    });
    expect(capabilities.skills).toEqual([]);
    expect(capabilities.toolsets).toEqual([]);
    expect(capabilities.mcpServers).toEqual([]);
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
    expect(await submit()).toEqual(first);
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
    expect(opts.botProfileContextPrompt?.includes('`start_session_task`')).toBe(helperEnabled);
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
    expect(opts.botProfileContextPrompt).toContain('login/configuration card is already in this chat');
    expect(opts.botProfileContextPrompt).toContain('End the turn and wait for the Host authorization-completed notification');
    expect(opts.botProfileContextPrompt).not.toContain('This remote runtime does not provide');
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
    expect(opts.botProfileContextPrompt).toContain('`start_session_task`');
    expect(opts.botProfileContextPrompt).toContain('Respect the user’s memory switch');
    expect(opts.botProfileContextPrompt).toContain('Use `update_teammate_profile`');
    expect(opts.botProfileContextPrompt).not.toContain('direct the user to the teammate’s model settings');
    expect(opts.botProfileContextPrompt).not.toContain('login/configuration card is already in this chat');
    expect(opts.botProfileContextPrompt).not.toContain('End the turn and wait for the Host authorization-completed notification');
    if (agentKind === 'pi') {
      expect(opts.botProfileContextPrompt).toContain('`ghost_list`, `ghost_info`, `ghost_call`');
      expect(opts.botProfileContextPrompt).toContain('This remote runtime does not provide plugin authorization cards');
      expect(opts.botProfileContextPrompt).toContain('Plugins page on the trusted desktop');
      expect(opts.botProfileContextPrompt).toContain('after the user confirms readiness');
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
    expect(discovered).toMatchObject({ ok: true, capabilities: [{ id: 'shared-docs', joined: false, available: true }] });
    expect(JSON.stringify(discovered)).not.toMatch(/FAKE_SECRET|example.invalid|Authorization/);
    await expect(selectBotCapability({ callerSessionId, kind: 'mcp', id: 'shared-docs', joined: true })).resolves.toMatchObject({ ok: true, effective: 'next-turn' });
    await expect(findBotCapabilities({ callerSessionId, kind: 'mcp' })).resolves.toMatchObject({ capabilities: [{ id: 'shared-docs', joined: true }] });
    expect(h.requestRuntimeRefresh).toHaveBeenCalledWith(callerSessionId, 'profile');
    await expect(selectBotCapability({ callerSessionId, kind: 'skill', id: 'release-check', joined: true })).resolves.toMatchObject({ ok: true });
    await expect(findBotCapabilities({ callerSessionId, kind: 'skill' })).resolves.toMatchObject({ capabilities: [{ id: 'release-check', joined: true }] });
    await expect(selectBotCapability({ callerSessionId, kind: 'mcp', id: 'shared-docs', joined: false })).resolves.toMatchObject({ ok: true, joined: false });
    await expect(findBotCapabilities({ callerSessionId, kind: 'skill' })).resolves.toMatchObject({ capabilities: [{ id: 'release-check', joined: true }] });
  });

  it.each(['skill', 'toolset-global', 'toolset-provider', 'mcp'] as const)(
    'revalidates newly added %s at the settings save boundary without blocking old references', async (scenario) => {
      const created = await invoke('local-db:bots:create-canonical-session', {
        botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
      });
      let available = true;
      const kind = scenario.startsWith('toolset') ? 'toolset' as const : scenario as 'skill' | 'mcp';
      const id = kind === 'skill' ? 'release-check' : kind === 'toolset' ? 'contacts' : 'shared-docs';
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
    h.customMcpConfigs.push({ id: 'events', name: 'Events', transport: 'sse', url: 'https://example.invalid/sse', headers: {} });
    await refreshCustomMcpProviders();
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
    h.customMcpConfigs.push({ id: 'events', name: 'Events', transport: 'sse', url: 'https://example.invalid/sse', headers: {} });
    await refreshCustomMcpProviders();
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
    for (const [kind, id] of [['mcp', 'events'], ['skill', 'route-skill'], ['toolset', 'contacts']] as const) {
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
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { mcpServers: ['shared-docs'] } });
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
  ])('keeps Pi-incompatible $id discoverable but unjoinable and removable', async (config) => {
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
        description: config.transport, available: false, joined: true }]),
    });
    await expect(selectBotCapability({ ...input, joined: true })).resolves.toMatchObject({ ok: false, errorCode: 'CAPABILITY_UNAVAILABLE' });
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
        capabilities: [expect.objectContaining({ id: 'shared-docs', joined: true, available: agentKind !== 'codex' })],
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

  it.each(['contacts', 'lsp'])('rejects gated %s despite registry enablement and keeps joined references removable', async (id) => {
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

  it.each([['browser', 'cindy_browser'], ['scheduler', 'cindy_scheduler'], ['contacts', 'cindy_contacts']])('mounts the selected %s toolset into the actual MCP policy', async (toolset, server) => {
    await invoke('local-db:bots:update', { id: 'bot-1', capabilities: { toolsets: [toolset], toolsetMode: 'allowlist' } });
    const created = await invoke('local-db:bots:create-canonical-session', { botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 2 });
    const opts: MakerSessionCreateOpts = { id: created.session.id, agentKind: 'codex', workingDir: created.session.workingDir, workspaceKind: 'dialogue', model: 'test-model', permissionMode: 'auto' };
    await hydrateBotProfileRuntime(opts, {
      listMcpServers: async () => [{ name: server, source: 'builtin', available: true }],
      listToolsets: async () => [{ id: toolset, name: toolset, essential: toolset === 'scheduler', available: true }],
    });
    expect(opts.botRuntimeProfile?.mcpPolicy.configured).toContain(server);
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
    discardDelegationQueuedInputs?: Parameters<typeof createBotDelegationService>[0]['discardDelegationQueuedInputs'];
    collectArtifacts?: Parameters<typeof createBotDelegationService>[0]['collectArtifacts'];
    readSessionExecution?: Parameters<typeof createBotDelegationService>[0]['readSessionExecution'];
    withSessionLock?: Parameters<typeof createBotDelegationService>[0]['withSessionLock'];
    closeSession?: Parameters<typeof createBotDelegationService>[0]['closeSession'];
    getWorktree?: Parameters<typeof createBotDelegationService>[0]['getWorktree'];
    withTransferredWorktree?: Parameters<typeof createBotDelegationService>[0]['withTransferredWorktree'];
    prepareWorktree?: Parameters<typeof createBotDelegationService>[0]['prepareWorktree'];
    taskQueue?: Parameters<typeof createBotDelegationService>[0]['taskQueue'];
    taskRoute?: Parameters<typeof createBotDelegationService>[0]['taskRoute'];
    taskControl?: boolean;
    queueSnapshots?: Map<string, AgentInputQueuedMessage[]>;
    onNativeStarted?: (sessionId: string) => void;
    beforeNativeAcceptance?: (sessionId: string) => void;
    rejectAfterNativeAcceptance?: () => boolean;
    appliedOnResume?: () => string[];
    reconcileWorktree?: Parameters<typeof createBotDelegationService>[0]['reconcileWorktree'];
    stopUnsupported?: boolean;
    steerUnsupported?: boolean;
    readCallerRuntime?: Parameters<typeof createBotDelegationService>[0]['readCallerRuntime'];
    readCallerPermission?: Parameters<typeof createBotDelegationService>[0]['readCallerPermission'];
    accountReady?: () => boolean;
    transientUnavailable?: () => boolean;
    replyFor?: (sessionId: string) => string;
    startTime?: number;
    resolveInteraction?: NonNullable<
      Parameters<typeof createBotDelegationService>[0]['resolveInteraction']
    >;
    onResultReceiptPersisted?: () => Promise<void>;
    onCompletionDispatched?: () => Promise<void>;
    onInteractionDispatched?: () => Promise<void>;
  } = {}) {
    const accountReady = options.accountReady ?? (() => true);
    const started: StartedTurn[] = [];
    const pendingTurns: Array<{ sessionId: string; queued: boolean }> = [];
    const heldInputs = new Set<string>();
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
    const dispatchDirect = vi.fn(async (params: {
      targetSessionId: string;
      dispatcherSessionId?: string;
      message: string;
      persistedContent?: string;
      clientId?: string;
      onAccepted?: (replayed?: boolean) => void | Promise<void>;
    }) => {
      if (params.clientId && hasMessage(params.targetSessionId, params.clientId)) {
        await params.onAccepted?.(true);
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
      if (params.dispatcherSessionId) h.sqlite!.prepare('UPDATE messages SET agent_meta = ? WHERE session_id = ? AND client_id = ?')
        .run(JSON.stringify({ origin: { kind: 'session', senderSessionId: params.dispatcherSessionId } }), params.targetSessionId, clientId);
      options.beforeNativeAcceptance?.(params.targetSessionId);
      await params.onAccepted?.();
      if (options.rejectAfterNativeAcceptance?.()) {
        started.pop();
        return { ok: false as const, errorCode: 'TEMPORARILY_UNAVAILABLE', message: 'Cancelled before vendor dispatch' };
      }
      h.sqlite!.prepare('UPDATE sessions SET active_turn_started_at = ? WHERE id = ?')
        .run(currentTime, params.targetSessionId);
      pendingTurns.push({ sessionId: params.targetSessionId, queued: queuedBehindRunningTurn });
      return {
        ok: true as const,
        targetSessionId: params.targetSessionId,
        wakeKind: queuedBehindRunningTurn ? 'queued' as const : 'resumed' as const,
      };
    });

    // Use the production coordinator for resume durability tests. The normal
    // dispatch fixture above deliberately models only the native send boundary.
    const acceptedCallbacks = new Map<string, () => void | Promise<void>>();
    const coordinator = options.queueSnapshots ? new AgentInputCoordinator({
      isTurnRunning: id => pendingTurns.some(turn => turn.sessionId === id && !turn.queued),
      hasPendingInteraction: () => false,
      getAgentKind: () => 'pi',
      getSdkSessionId: async () => undefined,
      emitProjection: () => undefined,
      steerToAgent: async () => undefined,
      abortSession: async () => undefined,
      persistQueueSnapshot: (id, items) => { options.queueSnapshots!.set(id, structuredClone(items)); },
      loadQueueSnapshot: async id => options.queueSnapshots!.get(id) ?? [],
      getPersistedClientIds: async (id, ids) => new Set(ids.filter(clientId => hasMessage(id, clientId))),
      sendToAgent: async (id, _message, _opts, sendOpts) => {
        const persisted = sendOpts.persistUserMessage;
        if (!persisted) throw new Error('Missing coordinator user row');
        writeMessage(id, persisted.clientId, 'user', persisted.content);
        options.beforeNativeAcceptance?.(id);
        await persisted.onPersisted?.();
        const row = readSession(id)!;
        started.push({ sessionId: id, ...row });
        h.sqlite!.prepare('UPDATE sessions SET active_turn_started_at = ? WHERE id = ?').run(currentTime, id);
        pendingTurns.push({ sessionId: id, queued: false });
        options.onNativeStarted?.(id);
        return { kind: 'session-dispatch', source: 'fixture-native-turn', dispatched: true };
      },
      onDispatchedUserTurn: async (id, item) => { delegation.confirmQueuedSessionInputDispatched(id, item.clientId); },
      onAcceptedQueuedMessage: async (id, item, restoredFromSnapshot) => {
        await acceptedCallbacks.get(item.clientId)?.();
        if (options.readSessionExecution) await delegation.acceptQueuedSessionInput(id, item.clientId, item.supersedesUserClientId, restoredFromSnapshot, item.retrySourceClientId);
      },
    }) : undefined;
    const dispatch = vi.fn(async (params: Parameters<typeof dispatchDirect>[0]) => {
      if (coordinator) {
        await coordinator.ensureQueueRestored(params.targetSessionId);
        // Same admission decision as sendToSessionInternal, before any native
        // send or persisted client-ID receipt exists.
        if (coordinator.shouldQueueNewTurn(params.targetSessionId)) {
          const clientId = params.clientId ?? `queued-${++seq}`;
          if (params.onAccepted) acceptedCallbacks.set(clientId, params.onAccepted);
          coordinator.enqueue(params.targetSessionId, {
            clientId, text: params.message, persistedContent: params.persistedContent ?? params.message,
            model: 'grok-4.5', effort: 'high', permissionMode: 'default', workingDir: h.userDataDir,
            chatMessage: { clientId, role: 'user', content: params.message,
              isStreaming: false, createdAt: new Date(currentTime).toISOString() },
            createOpts: { agentKind: 'pi', workingDir: h.userDataDir, model: 'grok-4.5',
              permissionMode: 'default', userPrompt: '', makerMemoryEnabled: false, displayReasoning: 'summarized' },
          });
          return { ok: true as const, targetSessionId: params.targetSessionId, wakeKind: 'queued' as const };
        }
      }
      const result = await dispatchDirect(params);
      if (result.ok && params.clientId?.startsWith('bot-delegation-completion:')) {
        await options.onCompletionDispatched?.();
      }
      if (result.ok && params.clientId?.startsWith('bot-delegation-interaction:')) {
        await options.onInteractionDispatched?.();
      }
      return result;
    });

    const abortSession = vi.fn(async (id: string): Promise<void> => { coordinator?.stop(id); });
    const steer = vi.fn<NonNullable<Parameters<typeof createBotDelegationService>[0]['taskControl']>['steer']>(async () => options.steerUnsupported
      ? { ok: false as const, errorCode: 'UNSUPPORTED_CAPABILITY' as const, message: 'No same-turn steer' }
      : { ok: true as const, queuedMessageId: 'steered-message' });
    const stopTurn = vi.fn(async () => options.stopUnsupported
      ? { ok: false as const, errorCode: 'UNSUPPORTED_CAPABILITY' as const, message: 'No graceful stop' }
      : { ok: true as const, status: 'requested' as const });
    const waitForInputBoundary = vi.fn(async () => undefined);
    const preparePause = vi.fn(async () => undefined);
    const flushInput = vi.fn(async (): Promise<void> => undefined);
    const closeSession = vi.fn(options.closeSession ?? (async () => undefined));
    const delegation = createBotDelegationService({
      readSessionExecution: options.readSessionExecution,
      collectArtifacts: options.collectArtifacts,
      discardDelegationQueuedInputs: options.discardDelegationQueuedInputs ?? (coordinator
        ? (id, delegationId) => discardDelegationQueuedInputs(coordinator, id, delegationId, async () => undefined)
        : undefined),
      withSessionLock: options.withSessionLock,
      prepareWorktree: options.prepareWorktree,
      getWorktree: options.getWorktree,
      reconcileWorktree: options.reconcileWorktree,
      withTransferredWorktree: options.withTransferredWorktree,
      taskQueue: options.taskQueue,
      taskRoute: options.taskRoute,
      ...(options.taskControl ? { taskControl: {
        steer, stop: stopTurn,
        isActive: (id: string) => pendingTurns.some((turn) => turn.sessionId === id && !turn.queued),
        holdInput: (id: string, held: boolean) => {
          if (held) heldInputs.add(id); else heldInputs.delete(id);
          coordinator?.setExecutionPaused(id, held);
          return held ? [] : options.appliedOnResume?.() ?? [];
        },
        waitForInputBoundary,
        preparePause,
        restoreInput: async id => { await coordinator?.ensureQueueRestored(id); },
        flushInput,
        resumeInput: async id => { coordinator?.resume(id); },
      } } : {}),
      readCallerRuntime: options.readCallerRuntime,
      readCallerPermission: options.readCallerPermission,
      persistTimelineMessage: options.onResultReceiptPersisted ? async params => {
        await createMessage(params.sessionId, {
          clientId: params.clientId,
          role: params.role,
          content: params.content,
          createdAt: params.createdAt,
          agentMeta: params.agentMeta as Parameters<typeof createMessage>[1]['agentMeta'],
        });
        if (params.clientId.startsWith('bot-delegation-result:')) {
          await options.onResultReceiptPersisted?.();
        }
      } : undefined,
      dispatch,
      abortSession,
      closeSession,
      broadcastSessionCreated: vi.fn(),
      resolveInteraction: options.resolveInteraction,
      readPendingInputClientIds: coordinator ? id => coordinator.getQueueControlSnapshot(id).pendingQueue.flatMap(item => [item.clientId, ...(item.supersedesUserClientId ? [item.supersedesUserClientId] : []), ...(item.retrySourceClientId ? [item.retrySourceClientId] : [])]) : undefined,
      hasPendingInput: (sessionId) => coordinator?.hasPendingQueuedWork(sessionId) || pendingTurns.some(
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

    const settleChild = async (sessionId: string, reply: string, execution?: { instanceId: string; generation: number }): Promise<void> => {
      const pendingIndex = pendingTurns.findIndex((turn) => turn.sessionId === sessionId);
      if (pendingIndex >= 0) pendingTurns.splice(pendingIndex, 1);
      writeMessage(sessionId, `assistant-${++seq}`, 'assistant', reply);
      h.sqlite!.prepare(
        `UPDATE sessions SET total_token_usage = total_token_usage + 100,
           last_turn_ended_at = ? WHERE id = ?`,
      ).run(currentTime, sessionId);
      coordinator?.onTurnEvent(sessionId, 'done');
      await delegation.settleSession({
        childSessionId: sessionId,
        outcome: 'done',
        resultText: reply,
        ...(execution ? { execution } : {}),
      });
    };

    return {
      delegation, coordinator, closeSession,
      heldInputs, steer, stopTurn, waitForInputBoundary, preparePause, flushInput,
      dispatch,
      abortSession,
      started,
      changed,
      runPendingTurns,
      settleChild,
      dispose: () => {
        delegation.dispose();
        if (coordinator) for (const id of options.queueSnapshots!.keys()) coordinator.setExecutionPaused(id, true);
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

  it.each(['delete-first', 'message-first'])('serializes shared-history writes and deletion (%s)', async (order) => {
    await seedPair();
    const target = await invoke('local-db:bots:create-canonical-session', {
      botId: 'bot-1', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
    });
    const sqlite = h.sqlite!;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
    const realTx = h.tx!;
    h.tx = async (name, args) => {
      const result = await realTx(name, args);
      if (order === 'delete-first' && name === 'bots.prepareProfileDeletion') {
        entered();
        await barrier;
      }
      return result;
    };
    const ensureCanonicalSession = vi.fn(async () => ({ ok: true as const, sessionId: target.session.id }));
    const dispatch = vi.fn(async () => {
      if (order === 'message-first') { entered(); await barrier; }
      return { ok: true as const, targetSessionId: target.session.id, wakeKind: 'queued' as const };
    });
    const direct = createBotDirectMessageService({ dispatch, ensureCanonicalSession });
    const lifecycle = createBotLifecycleService({
      maker: { closeSession: h.closeSession } as never,
      getDelegationService: () => null,
      deleteProfileAndDetachSessions: async (botId, sessionIds, keepTaskHistory) => {
        await realTx('bots.deleteProfile', { botId, sessionIds, keepTaskHistory, at: Date.now() });
      },
    });
    const remove = () => lifecycle.run({ botId: 'bot-a', action: 'delete', confirmName: '发起方伙伴', keepTaskHistory: true });
    const send = () => direct.messageAgent({ callerSessionId: 'session-1', targetBotId: 'bot-1', message: 'Race against deletion' });
    const first = order === 'delete-first' ? remove() : send();
    await atBoundary;
    const second = order === 'delete-first' ? send() : remove();
    if (order === 'delete-first') await vi.waitFor(() => expect(ensureCanonicalSession).toHaveBeenCalled());
    release();
    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    if (order === 'delete-first') {
      expect(firstResult, firstResult.status === 'rejected' ? String(firstResult.reason) : '').toMatchObject({ status: 'fulfilled', value: { status: 'deleted' } });
      expect(secondResult).toMatchObject({ status: 'fulfilled', value: { ok: false } });
      expect(dispatch).not.toHaveBeenCalled();
      expect(sqlite.prepare('SELECT * FROM bot_direct_message_threads').all()).toEqual([]);
      expect(sqlite.prepare('SELECT * FROM bot_direct_messages').all()).toEqual([]);
    } else {
      expect(firstResult).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      expect(secondResult, secondResult.status === 'rejected' ? String(secondResult.reason) : '').toMatchObject({ status: 'fulfilled', value: { status: 'deleted' } });
      expect(sqlite.prepare("SELECT id FROM bot_profiles WHERE id = 'bot-a'").get()).toBeUndefined();
      expect(sqlite.prepare('SELECT * FROM bot_direct_message_threads').all()).toHaveLength(1);
      expect(sqlite.prepare('SELECT * FROM bot_direct_messages').all()).toHaveLength(1);
    }
  });

  it.each(['delayed', 'failed'])('revokes caller capabilities while Session close is %s', async (mode) => {
    await seedPair();
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const closeSession = vi.fn(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; }));
    const lifecycle = createBotLifecycleService({ maker: { closeSession } as never, getDelegationService: () => null });
    const runtime = createDelegationRuntime();
    const pausing = lifecycle.run({ action: 'pause', botId: 'bot-a' });
    try {
      await vi.waitFor(() => expect(closeSession).toHaveBeenCalled());
      expect(await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Must not start while closing' })).toMatchObject({ ok: false });
      expect(await listBotSkillsForSession({ callerSessionId: 'session-1' })).toMatchObject({ ok: false, errorCode: 'BOT_SESSION_INACTIVE' });
      expect(await saveBotSkillForSession({ callerSessionId: 'session-1', name: 'Blocked skill', description: 'Must not be saved', body: 'No file should be written.' })).toMatchObject({ ok: false, errorCode: 'BOT_SESSION_INACTIVE' });
      if (mode === 'failed') fail(new Error('runtime did not close')); else finish();
      const result = await pausing;
      expect(result.status).toBe('paused');
      if (mode === 'failed') expect(result.warnings).toEqual([expect.stringContaining('SESSION_CLOSE_FAILED')]);
      expect(await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Must stay paused' })).toMatchObject({ ok: false });
      expect(runtime.started).toHaveLength(0);
    } finally { finish?.(); await pausing; runtime.delegation.dispose(); }
  });

  it.each(['paused', 'archived-link'])('blocks new work and Skill access from a still-running %s caller', async (state) => {
    await seedPair();
    if (state === 'paused') h.sqlite!.prepare("UPDATE bot_profiles SET status = 'paused' WHERE id = 'bot-a'").run();
    else h.sqlite!.prepare("UPDATE bot_session_links SET archived_at = 1 WHERE session_id = 'session-1'").run();
    const runtime = createDelegationRuntime();
    try {
      const result = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Must not run' });
      expect(result.ok).toBe(false);
      expect(runtime.started).toHaveLength(0);
      expect(await listBotSkillsForSession({ callerSessionId: 'session-1' })).toMatchObject({ ok: false, errorCode: 'BOT_SESSION_INACTIVE' });
      expect(await saveBotSkillForSession({ callerSessionId: 'session-1', name: 'Blocked skill', description: 'Must not be saved', body: 'No file should be written.' })).toMatchObject({ ok: false, errorCode: 'BOT_SESSION_INACTIVE' });
    } finally { runtime.delegation.dispose(); }
  });

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

  it.each(['ask', 'auto', 'bypassPermissions'])('inherits the live %s permission in the child task', async (mode) => {
    await seedPair();
    const runtime = createDelegationRuntime({ readCallerPermission: () => mode });
    try {
      const result = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Run the requested checks.' });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.message);
      expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get(result.childSessionId)).toBe(mode);
    } finally {
      runtime.dispose();
    }
  });

  it.each(['ask', 'auto', null])('uses stable permission after asynchronous workspace preparation: %s', async (settledMode) => {
    await seedPair();
    let permission: string | null = 'bypassPermissions';
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { finishPreparation = resolve; });
    h.ensureGit.mockImplementationOnce(async () => { await preparation; return undefined; });
    const runtime = createDelegationRuntime({ readCallerPermission: () => permission });
    const starting = runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Run the requested checks.' });
    try {
      await vi.waitFor(() => expect(h.ensureGit).toHaveBeenCalledWith(expect.objectContaining({ source: 'bot-delegation' })));
      permission = settledMode;
      finishPreparation();
      const result = await starting;
      if (settledMode === null) {
        expect(result).toMatchObject({ ok: false, errorCode: 'CALLER_PERMISSION_UNAVAILABLE' });
        expect(h.sqlite!.prepare('SELECT count(*) FROM bot_delegations').pluck().get()).toBe(0);
        expect(h.sqlite!.prepare('SELECT count(*) FROM sessions WHERE parent_session_id = ?').pluck().get('session-1')).toBe(0);
        expect(runtime.started).toEqual([]);
      } else {
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE id = ?').pluck().get(result.childSessionId)).toBe(settledMode);
        const snapshot = h.sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?').pluck().get(result.delegationId) as string;
        expect(JSON.parse(snapshot).permission).toMatchObject({ mode: settledMode, requesterMode: settledMode });
      }
    } finally {
      finishPreparation();
      await starting;
      runtime.dispose();
    }
  });

  it.each(['ask', 'auto', null])('aborts a child whose caller permission changed during persistence: %s', async (settledMode) => {
    await seedPair();
    let permission: string | null = 'bypassPermissions';
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
    const realTx = h.tx!;
    h.tx = async (name, args) => {
      if (name === 'bots.createDelegation') {
        entered();
        await barrier;
      }
      return realTx(name, args);
    };
    const runtime = createDelegationRuntime({ readCallerPermission: () => permission });
    const starting = runtime.delegation.startSessionTask({
      callerSessionId: 'session-1', objective: 'Run the requested checks.',
    });
    try {
      await atBoundary;
      permission = settledMode;
      release();
      const result = await starting;
      expect(result).toMatchObject({ ok: false, errorCode: 'CALLER_PERMISSION_UNAVAILABLE' });
      expect(runtime.started).toEqual([]);
      expect(h.sqlite!.prepare('SELECT status FROM bot_delegations').pluck().get()).toBe('failed');
    } finally {
      release();
      await starting.catch(() => undefined);
      h.tx = realTx;
      runtime.dispose();
    }
  });

  it.each(['ask', 'bypassPermissions', null])('revalidates permission generation after asynchronous child creation: %s', async (mode) => {
    await seedPair();
    let permission: { mode: string; generation: number } | null = { mode: 'bypassPermissions', generation: 1 };
    const originalTx = h.tx!;
    let persisted = false;
    let release!: () => void;
    const pendingReply = new Promise<void>((resolve) => { release = resolve; });
    h.tx = async (name, args) => {
      const result = await originalTx(name, args);
      if (name === 'bots.createDelegation') {
        persisted = true;
        await pendingReply;
      }
      return result;
    };
    const runtime = createDelegationRuntime({ readCallerPermission: () => permission });
    const starting = runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Do not retain stale Full Access.' });
    try {
      await vi.waitFor(() => expect(persisted).toBe(true));
      permission = mode === null ? null : { mode, generation: 2 };
      release();
      expect(await starting).toMatchObject({ ok: false, errorCode: 'CALLER_PERMISSION_UNAVAILABLE' });
      expect(runtime.started).toEqual([]);
      expect(h.sqlite!.prepare('SELECT permission_mode FROM sessions WHERE parent_session_id = ?').pluck().get('session-1')).toBe('ask');
      expect(h.sqlite!.prepare('SELECT status FROM bot_delegations').pluck().get()).toBe('failed');
    } finally {
      release();
      await starting;
      h.tx = originalTx;
      runtime.dispose();
    }
  });

  it('rechecks permission after the asynchronous dispatch-plan reads', async () => {
    await seedPair();
    let permission = { mode: 'bypassPermissions', generation: 1 };
    const realSelect = h.db!.select.bind(h.db!);
    let crossedDispatchBoundary = false;
    const select = vi.spyOn(h.db!, 'select').mockImplementation((fields) => {
      const query = realSelect(fields);
      // Keep the real SQLite query, but model a user change while the worker
      // replies to validateDispatchPlan's final child-status read.
      if (fields?.status === sessions.status && fields?.source === sessions.source) {
        crossedDispatchBoundary = true;
        queueMicrotask(() => { permission = { mode: 'ask', generation: 2 }; });
      }
      return query;
    });
    const runtime = createDelegationRuntime({ readCallerPermission: () => permission });
    try {
      const result = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1', objective: 'Run the requested checks.',
      });
      expect(crossedDispatchBoundary).toBe(true);
      expect(result).toMatchObject({ status: 'failed' });
      // Failure wakes the parent with the completion notice, never the child.
      expect(runtime.started.map((turn) => turn.sessionId)).toEqual(['session-1']);
      expect(h.sqlite!.prepare('SELECT permission_mode, status FROM sessions WHERE parent_session_id = ?')
        .get('session-1')).toMatchObject({ permission_mode: 'ask', status: 'active' });
    } finally {
      select.mockRestore();
      runtime.dispose();
    }
  });

  it('does not start a child with stale permissions during a live permission change', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ readCallerPermission: () => null });
    try {
      const result = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Run the requested checks.' });
      expect(result).toMatchObject({ ok: false, errorCode: 'CALLER_PERMISSION_UNAVAILABLE' });
      expect(runtime.started).toEqual([]);
    } finally {
      runtime.dispose();
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

  it.each(['done', 'error'] as const)('keeps the Session visible and background work alive after %s, without restarting on restore', async (outcome) => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Wait for background checks.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome, resultText: 'Checks are still pending.' });
      expect(runtime.closeSession).not.toHaveBeenCalled();
      expect(runtime.abortSession).not.toHaveBeenCalled();
      expect(h.sqlite!.prepare("SELECT id FROM sessions WHERE status = 'active' AND source = 'desktop'").all())
        .toContainEqual({ id: task.childSessionId });
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { session_id: task.childSessionId, session_status: 'active', status: outcome === 'done' ? 'completed' : 'failed' } });
      const before = runtime.started.length;
      await runtime.delegation.restore();
      expect(runtime.started).toHaveLength(before);
    } finally { runtime.dispose(); }
  });

  it('retries a persisted start without a current-run acceptance receipt after restart', async () => {
    await seedPair();
    const before = createDelegationRuntime({ beforeNativeAcceptance: () => { throw new Error('host exited before acceptance'); } });
    await expect(before.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Unaccepted start.' })).rejects.toThrow('host exited');
    const row = h.sqlite!.prepare('SELECT id, child_session_id AS child, status FROM bot_delegations').get() as { id: string; child: string; status: string };
    expect(row.status).toBe('queued');
    before.dispose();
    const after = createDelegationRuntime({ readSessionExecution: () => ({ instanceId: 'restarted', generation: 1 }) });
    try {
      await after.delegation.restore();
      expect(after.started.filter(turn => turn.sessionId === row.child)).toHaveLength(1);
      expect(await after.delegation.getSessionTask('session-1', row.id)).toMatchObject({ task: { status: 'running' } });
      expect(after.dispatch.mock.calls.at(-1)?.[0].clientId).not.toBe(`bot-delegation-start:${row.id}`);
      const retry = after.dispatch.mock.calls.at(-1)?.[0].clientId;
      expect(h.sqlite!.prepare("SELECT json_extract(permission_snapshot_json, '$.taskDispatchRetry.clientId') FROM bot_delegations WHERE id = ?").pluck().get(row.id)).toBe(retry);
      expect(h.sqlite!.prepare('SELECT COUNT(*) FROM messages WHERE session_id = ? AND client_id = ?').pluck().get(row.child, `bot-delegation-start:${row.id}`)).toBe(1);
      await after.delegation.settleSession({ childSessionId: row.child, outcome: 'done', execution: { instanceId: 'restarted', generation: 1 }, resultText: 'Recovered result.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT result_summary FROM bot_delegations WHERE id = ?').pluck().get(row.id)).toBe('Recovered result.');
    } finally { after.dispose(); }
  });

  it.each(['restart', 'unpause'] as const)('retries a persisted %s prompt without its own acceptance receipt', async kind => {
    await seedPair();
    const oldExecution = { instanceId: 'old-runtime', generation: 1 };
    const before = createDelegationRuntime({ taskControl: true, readSessionExecution: () => oldExecution });
    const task = await before.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Continue the original task.' });
    if (!task.ok) throw new Error('missing task');
    if (kind === 'unpause') {
      await before.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      await before.settleChild(task.childSessionId, 'Paused.', oldExecution);
    }
    const snapshot = JSON.parse(h.sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?').pluck().get(task.delegationId) as string);
    const clientId = kind === 'restart'
      ? `bot-delegation-resume:${task.delegationId}:10000`
      : `bot-delegation-unpause:${task.delegationId}:${snapshot.taskPause.token}`;
    // Crash after saving this recovery input, before native acceptance. The
    // existing receipt belongs to the interrupted original turn, not this input.
    h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('persisted-recovery-fixture', clientId, task.childSessionId, 'user', 'Continue existing work.', 10_500);
    before.dispose();
    const execution = { instanceId: 'new-runtime', generation: 1 };
    const after = createDelegationRuntime({ taskControl: true, startTime: 11_000, readSessionExecution: () => execution });
    try {
      if (kind === 'restart') await after.delegation.restore();
      else expect(await after.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: true });
      expect(after.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(1);
      const retryId = after.dispatch.mock.calls.at(-1)![0].clientId!;
      expect(retryId).not.toBe(clientId);
      const saved = JSON.parse(h.sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?').pluck().get(task.delegationId) as string);
      expect(saved.taskExecution).toMatchObject({ ...execution, runSequence: 1, clientId: retryId });
      expect(saved.taskRecoveryRetry.clientId).toBe(retryId);
      expect(h.sqlite!.prepare('SELECT COUNT(*) FROM messages WHERE session_id = ? AND client_id = ?').pluck().get(task.childSessionId, clientId)).toBe(1);
      if (kind === 'restart') await after.delegation.restore();
      else expect(await after.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: true });
      expect(after.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(1);
      await after.delegation.settleSession({ childSessionId: task.childSessionId, execution, outcome: 'done', resultText: 'Recovered.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      expect(await after.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ task: { status: 'completed', result: 'Recovered.' } });
    } finally { after.dispose(); }
  });

  it.each(['restart', 'unpause'] as const)('retries %s after acceptance is followed by dispatch rejection', async kind => {
    await seedPair();
    const oldExecution = { instanceId: 'original-runtime', generation: 1 };
    const before = createDelegationRuntime({ taskControl: true, readSessionExecution: () => oldExecution });
    const task = await before.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish existing work.' });
    if (!task.ok) throw new Error('missing task');
    if (kind === 'unpause') {
      await before.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      await before.settleChild(task.childSessionId, 'Paused.', oldExecution);
    }
    before.dispose();
    let reject = true;
    const execution = { instanceId: 'recovery-runtime', generation: 1 };
    const after = createDelegationRuntime({ taskControl: true, startTime: 11_000,
      readSessionExecution: () => execution, rejectAfterNativeAcceptance: () => reject });
    const resume = () => kind === 'restart' ? after.delegation.restore()
      : after.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' });
    try {
      await resume();
      expect(after.started).toHaveLength(0);
      const saved = JSON.parse(h.sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?').pluck().get(task.delegationId) as string);
      expect(saved.taskExecution).toMatchObject(oldExecution);
      reject = false;
      await resume();
      expect(after.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(1);
      await resume();
      expect(after.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(1);
      await after.delegation.settleSession({ childSessionId: task.childSessionId, execution, outcome: 'done', resultText: 'Recovered after cancellation.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      expect(await after.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ task: { status: 'completed' } });
    } finally { after.dispose(); }
  });

  it('retries a rejected supplement without replacing its previous execution receipt', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    let reject = false;
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution,
      rejectAfterNativeAcceptance: () => reject });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Original work.' });
      if (!task.ok) throw new Error('missing task');
      const input = { kind: 'message' as const, text: 'Add a conclusion.', idempotencyKey: 'rejected-supplement' };
      execution = { instanceId: 'native', generation: 2 };
      reject = true;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, input)).toMatchObject({ ok: false });
      const saved = JSON.parse(h.sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?').pluck().get(task.delegationId) as string);
      expect(saved.taskExecution).toMatchObject({ instanceId: 'native', generation: 1 });
      reject = false;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, input)).toMatchObject({ ok: true });
      expect(runtime.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(2);
      // A later accepted supplement cannot erase the first one's idempotency receipt.
      execution = { instanceId: 'native', generation: 3 };
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { ...input, idempotencyKey: 'later-supplement' });
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, input);
      expect(runtime.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(3);
    } finally { runtime.dispose(); }
  });

  it('collects artifacts using only inputs accepted in the reopened run', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const collectArtifacts = vi.fn(async () => []);
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution, collectArtifacts });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Initial work.' });
      if (!task.ok) throw new Error('missing task');
      const firstId = runtime.dispatch.mock.calls.find(([p]) => p.targetSessionId === task.childSessionId)![0].clientId!;
      await runtime.settleChild(task.childSessionId, 'First result.', execution);
      expect(collectArtifacts).toHaveBeenLastCalledWith(task.childSessionId, [firstId]);
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue.' });
      const nextId = runtime.dispatch.mock.calls.filter(([p]) => p.targetSessionId === task.childSessionId).at(-1)![0].clientId!;
      await runtime.settleChild(task.childSessionId, 'Next result.', execution);
      expect(nextId).not.toBe(firstId);
      expect(collectArtifacts).toHaveBeenLastCalledWith(task.childSessionId, [nextId]);
    } finally { runtime.dispose(); }
  });

  it('does not rebind an idempotent supplement replay to a later direct turn', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Original task.' });
      if (!task.ok) throw new Error('missing task');
      const input = { kind: 'message' as const, text: 'Supplement.', idempotencyKey: 'same-input' };
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, input);
      const original = h.sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?').pluck().get(task.delegationId);
      execution = { instanceId: 'native', generation: 3 };
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, input);
      expect(h.sqlite!.prepare('SELECT permission_snapshot_json FROM bot_delegations WHERE id = ?').pluck().get(task.delegationId)).toBe(original);
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution, resultText: 'Unrelated result.' });
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ task: { status: 'running' } });
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution: { instanceId: 'native', generation: 2 }, resultText: 'Supplement result.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT result_summary FROM bot_delegations WHERE id = ?').pluck().get(task.delegationId)).toBe('Supplement result.');
    } finally { runtime.dispose(); }
  });

  it.each([false, true])('binds queued continuation start only at native acceptance (cold: %s)', async cold => {
    await seedPair();
    const receipts = new Map<string, { instanceId: string; generation: number }>();
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots: new Map(),
      readSessionExecution: id => receipts.get(id) ?? null,
      beforeNativeAcceptance: id => receipts.set(id, {
        instanceId: receipts.get(id)?.instanceId ?? `native-${id}`,
        generation: (receipts.get(id)?.generation ?? 0) + 1,
      }),
    });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Initial task.' });
      if (!task.ok) throw new Error('missing task');
      const initialReceipt = receipts.get(task.childSessionId)!;
      await runtime.settleChild(task.childSessionId, 'Initial result.', initialReceipt);
      await runtime.dispatch({ targetSessionId: task.childSessionId, message: 'Independent user turn.', clientId: 'direct-user-turn' });
      const directReceipt = receipts.get(task.childSessionId)!;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue the task.' }))
        .toMatchObject({ ok: false, errorCode: 'STOP_UNCONFIRMED' });
      await runtime.settleChild(task.childSessionId, 'Direct turn ended.', directReceipt);
      runtime.coordinator!.setExecutionPaused(task.childSessionId, true);
      const continued = await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue the task.' });
      expect(continued).toMatchObject({ ok: true });
      expect(runtime.coordinator!.getQueueControlSnapshot(task.childSessionId).pendingQueue.map(item => item.clientId))
        .toContain(`bot-delegation-start:${task.delegationId}:2`);
      const read = () => h.sqlite!.prepare("SELECT status, json_extract(permission_snapshot_json, '$.taskExecution') AS receipt FROM bot_delegations WHERE id = ?").get(task.delegationId);
      expect(read()).toEqual({ status: 'queued', receipt: JSON.stringify({ ...initialReceipt, runSequence: 1, clientId: `bot-delegation-start:${task.delegationId}` }) });
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution: directReceipt, resultText: 'Unrelated direct result.',
        pendingInputClientIds: [`bot-delegation-start:${task.delegationId}:2`], hadPendingInputAtTerminal: true });
      expect(read()).toEqual({ status: 'queued', receipt: JSON.stringify({ ...initialReceipt, runSequence: 1, clientId: `bot-delegation-start:${task.delegationId}` }) });
      if (cold) receipts.delete(task.childSessionId);
      runtime.coordinator!.setExecutionPaused(task.childSessionId, false);
      runtime.coordinator!.resume(task.childSessionId);
      await vi.waitFor(() => expect(runtime.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(3));
      expect(read()).toEqual({ status: 'running', receipt: JSON.stringify({ ...receipts.get(task.childSessionId), runSequence: 2, clientId: `bot-delegation-start:${task.delegationId}:2` }) });
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution: directReceipt, resultText: 'Late direct result.' });
      expect((read() as { status: string }).status).toBe('running');
      await runtime.settleChild(task.childSessionId, 'Continuation result.', receipts.get(task.childSessionId));
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Continuation result.' });
    } finally { runtime.dispose(); }
  });

  it.each(['archived', 'deleted'] as const)('refuses continuation of a %s Session without creating a replacement', async (status) => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.settleChild(task.childSessionId, 'Done.');
      h.sqlite!.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(status, task.childSessionId);
      const count = h.sqlite!.prepare('SELECT COUNT(*) AS n FROM sessions').get();
      const before = runtime.started.length;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue.' }))
        .toMatchObject({ ok: false, errorCode: status.toUpperCase() });
      expect(h.sqlite!.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual(count);
      expect(runtime.started).toHaveLength(before);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { session_id: task.childSessionId, session_status: status, status: 'completed' } });
    } finally { runtime.dispose(); }
  });

  it('does not let a failed cancellation cleanup close a later continuation', async () => {
    await seedPair();
    vi.useFakeTimers();
    const runtime = createDelegationRuntime({ closeSession: async () => { throw new Error('runtime close unavailable'); } });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Do the work.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.stopSessionTask('session-1', task.delegationId);
      expect(runtime.closeSession).toHaveBeenCalledTimes(1);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: 'cancelled', session_status: 'active' } });
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue with new instructions.' }))
        .toMatchObject({ ok: true, childSessionId: task.childSessionId });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runtime.closeSession).toHaveBeenCalledTimes(1);
      expect(runtime.abortSession).toHaveBeenCalledTimes(1);
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it.each(['new-turn', 'new-instance'] as const)('does not retry cancellation cleanup against a direct %s', async (replacement) => {
    await seedPair();
    vi.useFakeTimers();
    let execution = { instanceId: 'native-1', generation: 1 };
    const withSessionLock = vi.fn(async (_id: string, operation: () => Promise<void>) => operation());
    const runtime = createDelegationRuntime({
      readSessionExecution: () => execution,
      withSessionLock,
      closeSession: async () => { throw new Error('close temporarily failed'); },
    });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Work.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.stopSessionTask('session-1', task.delegationId);
      expect(runtime.closeSession).toHaveBeenCalledTimes(1);
      const locksBeforeRetry = withSessionLock.mock.calls.length;
      // Opening the visible task and sending directly does not reopen delegation.
      execution = replacement === 'new-turn'
        ? { instanceId: 'native-1', generation: 2 }
        : { instanceId: 'native-2', generation: 1 };
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runtime.closeSession).toHaveBeenCalledTimes(1);
      expect(runtime.abortSession).toHaveBeenCalledTimes(1);
      expect(withSessionLock).toHaveBeenCalledTimes(locksBeforeRetry);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: 'cancelled', session_status: 'active' } });
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it.each((['cancel', 'pause', 'request-stop'] as const).flatMap(mode =>
    [false, true].map(changeInsideLock => ({ mode, changeInsideLock })),
  ))('does not apply first $mode to a newer direct execution (lock race: $changeInsideLock)', async ({ mode, changeInsideLock }) => {
      await seedPair();
      let execution = { instanceId: 'native', generation: 1 };
      const discard = vi.fn(async () => undefined);
      const runtime = createDelegationRuntime({ taskControl: true,
        readSessionExecution: () => execution, discardDelegationQueuedInputs: discard,
        withSessionLock: async (_id, operation) => {
          execution = { instanceId: 'native', generation: 2 };
          await operation();
        },
      });
      try {
        const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Original work.' });
        if (!task.ok) throw new Error('missing task');
        if (!changeInsideLock) execution = { instanceId: 'native', generation: 2 };
        await runtime.delegation.stopSessionTask('session-1', task.delegationId, mode);
        expect(runtime.abortSession).not.toHaveBeenCalled();
        expect(runtime.stopTurn).not.toHaveBeenCalled();
        expect(runtime.preparePause).not.toHaveBeenCalled();
        expect(runtime.closeSession).not.toHaveBeenCalled();
        expect(discard).toHaveBeenCalledWith(task.childSessionId, task.delegationId);
        expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
          .toMatchObject({ task: { status: 'cancelled', session_status: 'active' } });
      } finally { runtime.dispose(); }
  });

  it.each(['done', 'error'] as const)('ignores a delayed %s from an earlier execution after same-Session continuation', async (outcome) => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'First run.' });
      if (!task.ok) throw new Error('missing task');
      const previousExecution = execution;
      await runtime.settleChild(task.childSessionId, 'First result.');
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Second run.' });
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome,
        execution: previousExecution, resultText: 'Stale result.', error: 'Stale failure.' });
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: 'running' } });
      expect(h.sqlite!.prepare('SELECT result_summary, last_error FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ result_summary: null, last_error: null });
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done',
        execution, resultText: 'Second result.' });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Second result.' });
    } finally { runtime.dispose(); }
  });

  it.each(['new-turn', 'no-instance', 'never-accepted'] as const)('timeout cleanup preserves unrelated work with %s', async replacement => {
    await seedPair();
    vi.useFakeTimers();
    let execution: { instanceId: string; generation: number } | null = { instanceId: 'native', generation: 1 };
    const discardDelegationQueuedInputs = vi.fn(async () => undefined);
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution, discardDelegationQueuedInputs,
      transientUnavailable: () => replacement === 'never-accepted' });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Deadline work.', timeoutMs: 1000 });
      if (!task.ok) throw new Error('missing task');
      execution = replacement === 'new-turn' ? { instanceId: 'native', generation: 2 } : null;
      runtime.advance(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ task: { status: 'timed-out', session_status: 'active' } });
      expect(discardDelegationQueuedInputs).toHaveBeenCalledExactlyOnceWith(task.childSessionId, task.delegationId);
      expect(runtime.abortSession).not.toHaveBeenCalled();
      expect(runtime.closeSession).not.toHaveBeenCalled();
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it.each([false, true, 'auto'] as const)('removes timed-out delegation queue entries without dropping unrelated input (retry clone: %s)', async cloned => {
    await seedPair();
    vi.useFakeTimers();
    let execution: { instanceId: string; generation: number } | null = { instanceId: 'native', generation: 1 };
    const queueSnapshots = new Map<string, AgentInputQueuedMessage[]>();
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution, queueSnapshots });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Expire queued work.', timeoutMs: 1000 });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Delegated follow-up.' });
      await runtime.dispatch({ targetSessionId: task.childSessionId, message: 'Keep direct user input.', clientId: 'direct-user-input' });
      expect(runtime.coordinator!.getQueueControlSnapshot(task.childSessionId).pendingQueue).toHaveLength(2);
      if (cloned) {
        const item = runtime.coordinator!.getQueueControlSnapshot(task.childSessionId).pendingQueue[0];
        runtime.coordinator!.remove(task.childSessionId, item.clientId);
        runtime.coordinator!.enqueue(task.childSessionId, {
          ...item, clientId: 'random-retry-clone',
          supersedesUserClientId: cloned === 'auto' ? undefined : item.clientId,
          retrySourceClientId: cloned === 'auto' ? item.clientId : undefined,
          chatMessage: { ...item.chatMessage, clientId: 'random-retry-clone' },
        });
      }
      execution = null;
      runtime.advance(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.coordinator!.getQueueControlSnapshot(task.childSessionId).pendingQueue.map(item => item.clientId))
        .toEqual(['direct-user-input']);
      expect(queueSnapshots.get(task.childSessionId)?.map(item => item.clientId)).toEqual(['direct-user-input']);
      expect(runtime.abortSession).not.toHaveBeenCalled();
      expect(runtime.closeSession).not.toHaveBeenCalled();
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('timeout still aborts the native execution bound to the delegation receipt', async () => {
    await seedPair();
    vi.useFakeTimers();
    const runtime = createDelegationRuntime({ readSessionExecution: () => ({ instanceId: 'native', generation: 1 }) });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Stop on deadline.', timeoutMs: 1000 });
      if (!task.ok) throw new Error('missing task');
      runtime.advance(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(runtime.abortSession).toHaveBeenCalledExactlyOnceWith(task.childSessionId);
      expect(runtime.closeSession).toHaveBeenCalledExactlyOnceWith(task.childSessionId);
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('does not reuse the prior answer for a tool-only continuation without an assistant message', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'First answer.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.settleChild(task.childSessionId, 'Previous answer must not be repeated.');
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Tool-only continuation.' });
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution, resultText: '', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: null });
    } finally { runtime.dispose(); }
  });

  it('settles the accepted delegated receipt when a direct turn starts during artifact reads', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    let release!: () => void;
    let entered!: () => void;
    const collecting = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution,
      collectArtifacts: async () => { entered(); await barrier; return []; } });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Original work.' });
      if (!task.ok) throw new Error('missing task');
      const original = runtime.delegation.settleSession({ childSessionId: task.childSessionId,
        outcome: 'done', execution, resultText: 'Original result.', hadPendingInputAtTerminal: false });
      await collecting;
      execution = { instanceId: 'native', generation: 2 };
      const direct = runtime.delegation.settleSession({ childSessionId: task.childSessionId,
        outcome: 'done', execution, resultText: 'Unrelated direct result.', hadPendingInputAtTerminal: false });
      release();
      await Promise.all([original, direct]);
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Original result.' });
    } finally { release(); runtime.dispose(); }
  });

  it('recovers only the terminal event assistant message after a direct next turn has replied', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Recover original result.' });
      if (!task.ok) throw new Error('missing task');
      const insert = h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('original-result-id', 'original-result-client', task.childSessionId, 'assistant', 'Original transcript.', 20000);
      insert.run('direct-result-id', 'direct-result-client', task.childSessionId, 'assistant', 'Unrelated transcript.', 30000);
      const originalExecution = execution;
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution: originalExecution,
        resultMessageClientId: 'original-result-client', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Original transcript.' });
    } finally { runtime.dispose(); }
  });

  it('does not commit a terminal result after its durable execution receipt changes during reads', async () => {
    await seedPair();
    const execution = { instanceId: 'native', generation: 1 };
    let delegationId = '';
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution,
      collectArtifacts: async () => {
        h.sqlite!.prepare("UPDATE bot_delegations SET permission_snapshot_json = json_set(permission_snapshot_json, '$.taskExecution.generation', 2) WHERE id = ?").run(delegationId);
        return [];
      } });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Changing receipt.' });
      if (!task.ok) throw new Error('missing task');
      delegationId = task.delegationId;
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Superseded result.', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(delegationId))
        .toEqual({ status: 'running', result_summary: null });
    } finally { runtime.dispose(); }
  });

  it('does not adopt an ordinary user message queued before the delegated terminal event', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Delegated objective.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Delegated answer.', hadPendingInputAtTerminal: true, pendingInputClientIds: ['ordinary-user-input'] });
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, 'ordinary-user-input');
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Unrelated answer.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Delegated answer.' });
    } finally { runtime.dispose(); }
  });

  it.each(['direct', 'delegated-looking'] as const)('does not publish an invalid direct terminal boundary for %s queued input while the original result is pending', async kind => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const collecting = new Promise<void>(resolve => { entered = resolve; });
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution,
      collectArtifacts: async () => { entered(); await barrier; return []; } });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Original objective.' });
      if (!task.ok) throw new Error('missing task');
      const original = runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Original answer.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      await collecting;
      execution = { instanceId: 'native', generation: 2 };
      const clientId = kind === 'direct' ? 'next-direct-input' : `bot-delegation-interject:${task.delegationId}:queued`;
      const direct = runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Direct answer.', hadPendingInputAtTerminal: true, pendingInputClientIds: [clientId] });
      execution = { instanceId: 'native', generation: 3 };
      if (kind === 'delegated-looking') {
        // A declined owned boundary must remain rejected on subsequent attempts.
        for (let retry = 0; retry < 2; retry++) {
          await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, clientId))
            .rejects.toThrow('Delegated queue boundary validation was declined');
        }
        await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, 'retry-clone', clientId))
          .rejects.toThrow('Delegated queue boundary validation was declined');
      } else {
        await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, clientId)).resolves.toBeUndefined();
      }
      expect(h.sqlite!.prepare("SELECT json_extract(permission_snapshot_json, '$.taskExecution.generation') AS generation FROM bot_delegations WHERE id = ?").get(task.delegationId))
        .toEqual({ generation: 1 });
      release();
      await Promise.all([original, direct]);
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Original answer.' });
    } finally { release(); runtime.dispose(); }
  });

  it('adopts only input queued at the delegated terminal boundary', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Queued work.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        hadPendingInputAtTerminal: true, pendingInputClientIds: [`bot-delegation-interject:${task.delegationId}:owned`] });
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, 'unrelated-input');
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Unrelated.', pendingInputClientIds: [`bot-delegation-interject:${task.delegationId}:owned`], hadPendingInputAtTerminal: true });
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ task: { status: 'running' } });
      await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, `bot-delegation-interject:${task.delegationId}:owned`);
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Queued result.', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Queued result.' });
    } finally { runtime.dispose(); }
  });

  it('keeps a supplement queued after an empty terminal snapshot tracked until its result', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots: new Map(), readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Original work.' });
      if (!task.ok) throw new Error('missing task');
      // The terminal adapter captured [] before this supplement obtained the task lock.
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Late supplement.' });
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Original result.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ task: { status: 'running' } });
      execution = { instanceId: 'native', generation: 2 };
      await runtime.settleChild(task.childSessionId, 'Original turn ended.');
      await vi.waitFor(() => expect(runtime.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(2));
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Late supplement result.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Late supplement result.' });
    } finally { runtime.dispose(); }
  });

  it.each([false, true])('rejects late owned input after an empty stale snapshot (settled: %s)', async settled => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots: new Map(), readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Original work.' });
      if (!task.ok) throw new Error('missing task');
      execution = { instanceId: 'native', generation: 2 };
      const stale = runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Unrelated direct result.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Late supplement.' });
      if (settled) await stale;
      const clientId = runtime.dispatch.mock.calls.find(([input]) => input.clientId?.startsWith('bot-delegation-interject:'))![0].clientId!;
      execution = { instanceId: 'native', generation: 3 };
      await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, clientId))
        .rejects.toThrow('Delegated queued input has no verified execution boundary');
      await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, 'retry-clone', clientId))
        .rejects.toThrow('Delegated queued input has no verified execution boundary');
      await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, 'ordinary-direct-input')).resolves.toBeUndefined();
      await stale;
      expect(h.sqlite!.prepare("SELECT status, json_extract(permission_snapshot_json, '$.taskExecution.generation') AS generation FROM bot_delegations WHERE id = ?").get(task.delegationId))
        .toEqual({ status: 'running', generation: 1 });
    } finally { runtime.dispose(); }
  });

  it('rejects a supplement acceptance if its delegated run has already ended', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots: new Map(),
      readSessionExecution: () => ({ instanceId: 'native', generation: 1 }) });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Work.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Queued supplement.' });
      const accepted = runtime.dispatch.mock.calls.find(([input]) => input.clientId?.startsWith('bot-delegation-interject:'))![0].onAccepted!;
      h.sqlite!.prepare("UPDATE bot_delegations SET status = 'cancelled' WHERE id = ?").run(task.delegationId);
      await expect(accepted()).rejects.toThrow('Delegated execution receipt was not committed');
    } finally { runtime.dispose(); }
  });

  it.each([false, true])('revalidates a retry clone after transient boundary read failure (receipt changed: %s)', async changed => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Queued work.' });
      if (!task.ok) throw new Error('missing task');
      const clientId = `bot-delegation-interject:${task.delegationId}:pending`;
      const failingRead = vi.spyOn(h.db!, 'select').mockImplementationOnce(() => { throw new Error('temporary database failure'); });
      const terminal = runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        pendingInputClientIds: [clientId], hadPendingInputAtTerminal: true });
      const firstAcceptance = runtime.delegation.acceptQueuedSessionInput(task.childSessionId, clientId);
      const attempts = await Promise.allSettled([terminal, firstAcceptance]);
      expect(attempts.every(result => result.status === 'rejected')).toBe(true);
      failingRead.mockRestore();
      execution = { instanceId: 'native', generation: 2 };
      if (changed) h.sqlite!.prepare("UPDATE bot_delegations SET permission_snapshot_json = json_set(permission_snapshot_json, '$.taskExecution.generation', 3) WHERE id = ?").run(task.delegationId);
      const retry = runtime.delegation.acceptQueuedSessionInput(task.childSessionId, 'retry-clone', clientId);
      if (changed) {
        await expect(retry).rejects.toThrow('Delegated queue boundary validation was declined');
        expect(h.sqlite!.prepare("SELECT json_extract(permission_snapshot_json, '$.taskExecution.generation') FROM bot_delegations WHERE id = ?").pluck().get(task.delegationId)).toBe(3);
      } else {
        await retry;
        await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
          resultText: 'Retry result.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
        expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
          .toEqual({ status: 'completed', result_summary: 'Retry result.' });
      }
    } finally { vi.restoreAllMocks(); runtime.dispose(); }
  });

  it('awaits terminal receipt validation when queue acceptance overtakes settlement', async () => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Queued follow-up.' });
      if (!task.ok) throw new Error('missing task');
      const clientId = `bot-delegation-interject:${task.delegationId}:racing`;
      // Do not await settlement: simulate the already-scheduled queue drain.
      const terminal = runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        pendingInputClientIds: [clientId], hadPendingInputAtTerminal: true });
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, clientId);
      await terminal;
      runtime.delegation.confirmQueuedSessionInputDispatched(task.childSessionId, clientId);
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Follow-up result.', pendingInputClientIds: [], hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Follow-up result.' });
    } finally { runtime.dispose(); }
  });

  it.each([false, true])('retains accepted but undispatched input for retry (cloned: %s)', async cloned => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Retry queued work.' });
      if (!task.ok) throw new Error('missing task');
      const originalId = `bot-delegation-interject:${task.delegationId}:retry`;
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        hadPendingInputAtTerminal: true, pendingInputClientIds: [originalId] });
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, originalId);
      // No dispatch receipt: native reservation was cancelled after acceptance.
      execution = { instanceId: 'replacement-native', generation: 1 };
      const retryId = cloned ? 'manual-retry-clone' : originalId;
      await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, retryId, cloned ? originalId : undefined);
      runtime.delegation.confirmQueuedSessionInputDispatched(task.childSessionId, retryId);
      const dispatchedExecution = execution;
      execution = { instanceId: 'replacement-native', generation: 2 };
      // A consumed boundary cannot be used to attach a later direct execution.
      // Reusing an owned ID now explicitly rejects instead of silently ignoring it.
      if (cloned) await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, retryId);
      else await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, retryId))
        .rejects.toThrow('Delegated queued input has no verified execution boundary');
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution: dispatchedExecution,
        resultText: 'Retried result.', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Retried result.' });
    } finally { runtime.dispose(); }
  });

  it.each(['FAIL', 'IGNORE'] as const)('retains a queued execution boundary when receipt persistence returns %s', async failure => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Durable queue adoption.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        hadPendingInputAtTerminal: true, pendingInputClientIds: [`bot-delegation-interject:${task.delegationId}:retry`] });
      execution = { instanceId: 'native', generation: 2 };
      const raise = failure === 'FAIL' ? "RAISE(FAIL, 'fixture receipt unavailable')" : 'RAISE(IGNORE)';
      h.sqlite!.exec(`CREATE TEMP TRIGGER fail_execution_receipt BEFORE UPDATE OF permission_snapshot_json ON bot_delegations
        WHEN json_extract(NEW.permission_snapshot_json, '$.taskExecution.generation') = 2
        BEGIN SELECT ${raise}; END`);
      await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, `bot-delegation-interject:${task.delegationId}:retry`)).rejects.toThrow();
      h.sqlite!.exec('DROP TRIGGER fail_execution_receipt');
      await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, `bot-delegation-interject:${task.delegationId}:retry`);
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Retry adopted.', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Retry adopted.' });
    } finally { h.sqlite!.exec('DROP TRIGGER IF EXISTS fail_execution_receipt'); runtime.dispose(); }
  });

  it('enqueues a delegated resume even when an unrelated direct input is already queued', async () => {
    await seedPair();
    const queueSnapshots = new Map<string, AgentInputQueuedMessage[]>();
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Resume delegated objective.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      await runtime.settleChild(task.childSessionId, 'Paused.');
      await runtime.dispatch({ targetSessionId: task.childSessionId, message: 'Unrelated direct input.', clientId: 'ordinary-paused-input' });
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' });
      expect(runtime.dispatch.mock.calls.some(([input]) => input.clientId?.startsWith(`bot-delegation-unpause:${task.delegationId}:`))).toBe(true);
      expect(runtime.coordinator!.getQueueControlSnapshot(task.childSessionId).pendingQueue.some(input => input.clientId.startsWith(`bot-delegation-unpause:${task.delegationId}:`))).toBe(true);
    } finally { runtime.dispose(); }
  });

  it.each(['retry-saved-terminal', 'missing-terminal', 'saved-terminal', 'expired-saved-terminal', 'user-before-restore', 'edit-before-restore', 'text-before-restore', 'content-before-restore', 'merge-before-restore'] as const)('restores an owned supplement with %s', async scenario => {
    await seedPair();
    const queueSnapshots = new Map<string, AgentInputQueuedMessage[]>();
    const before = createDelegationRuntime({ taskControl: true, queueSnapshots,
      readSessionExecution: () => ({ instanceId: 'before-restart', generation: 1 }) });
    let after: ReturnType<typeof createDelegationRuntime> | undefined;
    try {
      const task = await before.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Original work.' });
      if (!task.ok) throw new Error('missing task');
      if (scenario === 'retry-saved-terminal' || scenario === 'saved-terminal' || scenario === 'expired-saved-terminal') {
        // The native terminal receipt is durable, but settlement was interrupted.
        h.sqlite!.exec("CREATE TEMP TRIGGER fail_terminal_commit BEFORE UPDATE OF status ON bot_delegations WHEN NEW.status = 'completed' BEGIN SELECT RAISE(FAIL, 'fixture restart'); END");
        await expect(before.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done',
          execution: { instanceId: 'before-restart', generation: 1 }, resultText: 'Earlier result.',
          hadPendingInputAtTerminal: false })).rejects.toThrow();
        h.sqlite!.exec('DROP TRIGGER fail_terminal_commit');
      }
      await before.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Queued supplement.' });
      if (scenario === 'merge-before-restore') await before.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Second supplement.' });
      h.sqlite!.prepare('UPDATE sessions SET last_turn_ended_at = 10000 WHERE id = ?').run(task.childSessionId);
      before.dispose();
      if (scenario === 'retry-saved-terminal') {
        queueSnapshots.set(task.childSessionId, queueSnapshots.get(task.childSessionId)!.map(item => ({
          ...item, clientId: 'random-retry-clone', supersedesUserClientId: item.clientId,
          chatMessage: { ...item.chatMessage, clientId: 'random-retry-clone' },
        })));
      }
      const execution = { instanceId: 'after-restart', generation: 1 };
      after = createDelegationRuntime({ taskControl: true, queueSnapshots, startTime: scenario === 'expired-saved-terminal' ? 2_000_000 : 11000,
        readSessionExecution: () => execution });
      if (scenario.endsWith('before-restore')) {
        await after.coordinator!.ensureQueueRestored(task.childSessionId);
        const queued = after.coordinator!.getQueueControlSnapshot(task.childSessionId).pendingQueue;
        const item = queued[0];
        const edited = { ...item, text: 'Edited supplement.', persistedContent: 'Edited supplement.',
          chatMessage: { ...item.chatMessage, content: 'Edited supplement.' } };
        if (scenario === 'edit-before-restore') {
          expect(after.coordinator!.replaceQueuedMessage(task.childSessionId, item.clientId, edited)).toBe(true);
        } else if (scenario === 'text-before-restore') {
          after.coordinator!.updateText(task.childSessionId, item.clientId, 'Edited supplement.');
        } else if (scenario === 'content-before-restore') {
          expect(after.coordinator!.updateContentWithResult(task.childSessionId, item.clientId, edited).updated).toBe(true);
        } else if (scenario === 'merge-before-restore') {
          expect(after.coordinator!.mergeQueuedMessagesAtomically(task.childSessionId, queued.map(q => q.clientId), () => edited).merged).toBe(true);
        }
        after.coordinator!.resume(task.childSessionId);
      } else {
        await after.delegation.restore();
      }
      if (scenario === 'expired-saved-terminal') {
        expect(await after.delegation.getSessionTask('session-1', task.delegationId))
          .toMatchObject({ task: { status: 'timed-out' } });
        expect(after.started.some(turn => turn.sessionId === task.childSessionId)).toBe(false);
        return;
      }
      await vi.waitFor(() => expect(after!.started).toHaveLength(1));
      expect(after.started[0].sessionId).toBe(task.childSessionId);
      if (scenario.endsWith('before-restore')) await after.delegation.restore();
      expect(after.dispatch).not.toHaveBeenCalled(); // Resume the saved input, never replay initial dispatch.
      await after.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Supplement result.', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Supplement result.' });
    } finally { before.dispose(); after?.dispose(); }
  });

  it.each([false, true])('binds automatic retry provenance without hiding the original input (cold: %s)', async cold => {
    await seedPair();
    let execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Retry delegated work.' });
      if (!task.ok) throw new Error('missing task');
      execution = { instanceId: 'native', generation: 2 };
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Supplement', idempotencyKey: 'auto-source' });
      const source = runtime.dispatch.mock.calls.at(-1)![0].clientId!;
      execution = { instanceId: 'native', generation: 3 };
      if (!cold) await expect(runtime.delegation.acceptQueuedSessionInput(task.childSessionId, 'unknown-clone', undefined, false,
        `bot-delegation-interject:${task.delegationId}:not-accepted`)).rejects.toThrow('no accepted delegation receipt');
      await runtime.delegation.acceptQueuedSessionInput(task.childSessionId, 'auto-clone', undefined, cold, source);
      runtime.delegation.confirmQueuedSessionInputDispatched(task.childSessionId, 'auto-clone');
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Automatic retry result.', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Automatic retry result.' });
    } finally { runtime.dispose(); }
  });

  it('binds a cold-restored retry clone through its original delegated input', async () => {
    await seedPair();
    const before = createDelegationRuntime({ readSessionExecution: () => ({ instanceId: 'before-restart', generation: 1 }) });
    let after: ReturnType<typeof createDelegationRuntime> | undefined;
    try {
      const task = await before.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Retry saved supplement.' });
      if (!task.ok) throw new Error('missing task');
      const originalId = `bot-delegation-interject:${task.delegationId}:retry`;
      await before.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done',
        execution: { instanceId: 'before-restart', generation: 1 },
        hadPendingInputAtTerminal: true, pendingInputClientIds: [originalId] });
      before.dispose();
      const execution = { instanceId: 'after-restart', generation: 1 };
      after = createDelegationRuntime({ readSessionExecution: () => execution });
      await after.delegation.acceptQueuedSessionInput(task.childSessionId, 'random-retry-clone', originalId, true);
      after.delegation.confirmQueuedSessionInputDispatched(task.childSessionId, 'random-retry-clone');
      await after.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Retried supplement completed.', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Retried supplement completed.' });
    } finally { before.dispose(); after?.dispose(); }
  });

  it('binds a restored explicit resume queue to the new native execution', async () => {
    await seedPair();
    const queueSnapshots = new Map<string, AgentInputQueuedMessage[]>();
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots,
      readSessionExecution: () => ({ instanceId: 'before-restart', generation: 1 }) });
    let restored: ReturnType<typeof createDelegationRuntime> | undefined;
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Resume exactly once.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      await runtime.settleChild(task.childSessionId, 'Stopped.');
      runtime.advance(1000);
      const fault = loseResumeCommitReceipt(true);
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' });
      fault.mockRestore();
      runtime.dispose();
      const execution = { instanceId: 'after-restart', generation: 1 };
      restored = createDelegationRuntime({ taskControl: true, queueSnapshots, startTime: 11000,
        readSessionExecution: () => execution });
      await restored.delegation.restore();
      await vi.waitFor(() => expect(restored!.started).toHaveLength(1));
      await restored.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution,
        resultText: 'Resumed result.', hadPendingInputAtTerminal: false });
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'completed', result_summary: 'Resumed result.' });
    } finally { runtime.dispose(); restored?.dispose(); }
  });

  it('ignores the prior terminal event while a continuation is queued before native reservation', async () => {
    await seedPair();
    let unavailable = false;
    const execution = { instanceId: 'native', generation: 1 };
    const runtime = createDelegationRuntime({ readSessionExecution: () => execution, transientUnavailable: () => unavailable });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'First run.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.settleChild(task.childSessionId, 'First result.');
      unavailable = true;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue.' }))
        .toMatchObject({ ok: true, queued: true });
      // Still generation 1: checking only the live native identity is insufficient.
      await runtime.delegation.settleSession({ childSessionId: task.childSessionId, outcome: 'done', execution, resultText: 'Old duplicate.' });
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: 'queued' } });
    } finally { runtime.dispose(); }
  });

  it('rechecks explicit archive inside the continuation transaction', async () => {
    await seedPair();
    let childId = '';
    const originalTx = h.tx!;
    h.tx = async (name, args) => {
      if (name === 'bots.reopenDelegation') h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(childId);
      return originalTx(name, args);
    };
    const runtime = createDelegationRuntime();
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.settleChild(task.childSessionId, 'Done.');
      childId = task.childSessionId;
      const before = runtime.started.length;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue.' }))
        .toMatchObject({ ok: false, errorCode: 'SESSION_TASK_STATE_CHANGED' });
      expect(runtime.started).toHaveLength(before);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: 'completed', session_status: 'archived' } });
    } finally { h.tx = originalTx; runtime.dispose(); }
  });

  it('binds a prepared worktree before first dispatch and rejects unavailable isolation', async () => {
    await seedPair();
    const workspace = join(h.userDataDir, 'task-project-worktree');
    mkdirSync(workspace, { recursive: true });
    const runtime = createDelegationRuntime({ prepareWorktree: async () => ({ ok: true, sessionId: 'worktree-session', workingDir: workspace }) });
    try {
      const result = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Edit this project.', workingDir: h.userDataDir, useWorktree: true });
      expect(result).toMatchObject({ ok: true, childSessionId: 'worktree-session' });
      if (!result.ok) throw new Error('missing task');
      expect(await runtime.delegation.getSessionTask('session-1', result.delegationId))
        .toMatchObject({ task: { working_dir: normalizeWorkingDirForStorage(workspace), workspace_kind: 'project' } });
      expect(runtime.started[0].sessionId).toBe('worktree-session');
      expect(h.sqlite!.prepare('SELECT worktree_path AS path FROM sessions WHERE id = ?').get('worktree-session')).toEqual({ path: workspace });
    } finally { runtime.dispose(); }
    const unavailable = createDelegationRuntime();
    try {
      expect(await unavailable.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Edit.', workingDir: workspace, useWorktree: true }))
        .toMatchObject({ ok: false, errorCode: 'WORKTREE_UNAVAILABLE' });
      expect(unavailable.started).toHaveLength(0);
    } finally { unavailable.dispose(); }
  });

  it('keeps the same worktree owner and Session across continuations, including a failed transaction', async () => {
    await seedPair();
    const workspace = join(h.userDataDir, 'continued-worktree');
    mkdirSync(workspace, { recursive: true });
    let owner = 'worktree-first';
    const runtime = createDelegationRuntime({
      prepareWorktree: async () => ({ ok: true, sessionId: owner, workingDir: workspace }),
      getWorktree: id => id === owner ? { path: workspace } : null,
      withTransferredWorktree: async (previous, next, worktreePath, commit) => {
        expect(previous).toBe(owner);
        expect(worktreePath).toBe(workspace);
        const result = await commit();
        if (result.reopened) owner = next;
        return result;
      },
    });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Preserve files.', workingDir: h.userDataDir, useWorktree: true });
      if (!task.ok) throw new Error('task failed');
      await runtime.settleChild(owner, 'First result.');
      // The manager remains authoritative even if the display snapshot is absent.
      h.sqlite!.prepare('UPDATE sessions SET worktree_path = NULL WHERE id = ?').run(owner);
      h.sqlite!.exec("CREATE TEMP TRIGGER fail_reopen_binding BEFORE UPDATE OF worktree_path ON sessions BEGIN SELECT RAISE(FAIL, 'fixture transfer failure'); END");
      const before = h.sqlite!.prepare('SELECT COUNT(*) AS count FROM sessions').get();
      const startedBeforeFailure = runtime.started.length;
      await expect(runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue.' })).rejects.toThrow('fixture transfer failure');
      expect(h.sqlite!.prepare('SELECT COUNT(*) AS count FROM sessions').get()).toEqual(before);
      expect(runtime.started).toHaveLength(startedBeforeFailure);
      expect(owner).toBe('worktree-first');
      h.sqlite!.exec('DROP TRIGGER fail_reopen_binding');
      for (let round = 0; round < 2; round++) {
        const previous = owner;
        const resumed = await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'Continue.' });
        expect(resumed).toMatchObject({ ok: true, resumed: true });
        expect(owner).toBe(previous);
        expect(h.sqlite!.prepare('SELECT working_dir AS cwd, worktree_path AS path FROM sessions WHERE id = ?').get(owner))
          .toEqual({ cwd: normalizeWorkingDirForStorage(workspace), path: workspace });
        expect(runtime.started.at(-1)?.sessionId).toBe(owner);
        await runtime.settleChild(owner, 'Next result.');
      }
    } finally {
      h.sqlite!.exec('DROP TRIGGER IF EXISTS fail_reopen_binding');
      runtime.dispose();
    }
  });

  it('still publishes and dispatches a committed worktree task when its display snapshot fails', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ prepareWorktree: async () => ({ ok: true,
      sessionId: 'snapshot-failure-session', workingDir: h.userDataDir }) });
    h.sqlite!.exec("CREATE TEMP TRIGGER fail_worktree_snapshot BEFORE UPDATE OF worktree_path ON sessions BEGIN SELECT RAISE(FAIL, 'fixture snapshot unavailable'); END");
    try {
      const result = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1',
        objective: 'Continue despite an unavailable display snapshot.', workingDir: h.userDataDir, useWorktree: true });
      expect(result).toMatchObject({ ok: true, childSessionId: 'snapshot-failure-session' });
      if (!result.ok) throw new Error('task failed');
      expect(runtime.started.map(turn => turn.sessionId)).toEqual(['snapshot-failure-session']);
      expect(await runtime.delegation.getSessionTask('session-1', result.delegationId))
        .toMatchObject({ task: { status: 'running', working_dir: normalizeWorkingDirForStorage(h.userDataDir) } });
      await runtime.settleChild(result.childSessionId, 'Finished.');
      expect(await runtime.delegation.getSessionTask('session-1', result.delegationId))
        .toMatchObject({ task: { status: 'completed' } });
    } finally { h.sqlite!.exec('DROP TRIGGER fail_worktree_snapshot'); runtime.dispose(); }
  });

  it.each(['running', 'queued', 'paused'] as const)('preserves the %s input and timers when cancellation intent cannot be persisted', async (state) => {
    await seedPair();
    vi.useFakeTimers();
    let unavailable = state === 'queued';
    const runtime = createDelegationRuntime({ taskControl: true, transientUnavailable: () => unavailable });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish safely.', timeoutMs: 10_000 });
      if (!task.ok) throw new Error('task failed');
      if (state === 'paused') await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      const before = await runtime.delegation.getSessionTask('session-1', task.delegationId);
      h.sqlite!.exec("CREATE TEMP TRIGGER fail_cancel_intent BEFORE UPDATE OF permission_snapshot_json ON bot_delegations WHEN json_extract(NEW.permission_snapshot_json, '$.taskCancelRequested') = 1 BEGIN SELECT RAISE(FAIL, 'fixture cancel unavailable'); END");
      await expect(runtime.delegation.stopSessionTask('session-1', task.delegationId)).rejects.toThrow();
      h.sqlite!.exec('DROP TRIGGER fail_cancel_intent');
      expect(runtime.heldInputs.has(task.childSessionId)).toBe(state === 'paused');
      expect(runtime.abortSession).not.toHaveBeenCalled();
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toEqual(before);
      if (state === 'queued') {
        unavailable = false;
        runtime.advance(1_000);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(runtime.started.map(turn => turn.sessionId)).toContain(task.childSessionId);
      }
      runtime.advance(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: state === 'paused' ? 'waiting' : 'timed-out' } });
    } finally {
      h.sqlite!.exec('DROP TRIGGER IF EXISTS fail_cancel_intent');
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it.each(['running', 'completed', 'failed'] as const)('retains %s status and receipts when queue restoration fails', async (state) => {
    await seedPair();
    const inspect = vi.fn(async () => { throw new Error('Task queue restoration is incomplete'); });
    const runtime = createDelegationRuntime({ taskControl: true, taskQueue: {
      inspect, update: vi.fn(), cancel: vi.fn(),
    } });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish safely.' });
      if (!task.ok) throw new Error('task failed');
      const sent = await runtime.delegation.messageSessionTask('session-1', task.delegationId,
        { kind: 'message', text: 'additional requirement', idempotencyKey: 'receipt' });
      if (!sent.ok || !('queuedMessageId' in sent)) throw new Error('missing receipt');
      if (state !== 'running') h.sqlite!.prepare('UPDATE bot_delegations SET status = ?, result_summary = ?, last_error = ? WHERE id = ?')
        .run(state, 'Saved result', state === 'failed' ? 'FIXTURE: Saved error' : null, task.delegationId);
      for (const messageId of [undefined, 'missing', sent.queuedMessageId]) {
        const result = await runtime.delegation.getSessionTask('session-1', task.delegationId, messageId);
        expect(result).toMatchObject({ ok: true, task: { status: state, queue: null, queue_error: 'QUEUE_UNAVAILABLE' } });
        if (!result.ok) throw new Error('missing task');
        if (state !== 'running') expect(result.task.result).toBe('Saved result');
        if (state === 'failed') expect(result.task.error).toBe('Saved error');
        expect(result.task.message_receipt).toEqual(messageId ? {
          queued_message_id: messageId, state: messageId === sent.queuedMessageId ? 'dispatched' : 'unavailable',
        } : undefined);
      }
    } finally { runtime.dispose(); }
  });

  it('keeps steer IDs stable and reuses persisted receipts after runtime replacement', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish safely.' });
      if (!task.ok) throw new Error('task failed');
      const input = { kind: 'message' as const, text: 'urgent', mode: 'steer' as const, idempotencyKey: 'retry:完整/key' };
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, input);
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, input);
      const calls = runtime.steer.mock.calls;
      const id = calls[0][0].queuedMessageId;
      if (!id) throw new Error('missing stable ID');
      expect(id).toEqual(expect.stringMatching(/^bot-task-steer:[a-f0-9]{64}$/));
      expect(calls[1][0].queuedMessageId).toBe(id);
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { ...input, idempotencyKey: 'retry完整key' });
      expect(calls[2][0].queuedMessageId).not.toBe(id);
      h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at, agent_meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('accepted-steer', id, task.childSessionId, 'user', input.text, 10_000,
          JSON.stringify({ origin: { kind: 'session', senderSessionId: 'session-1' } }));
      const restored = createDelegationRuntime({ taskControl: true });
      try {
        expect(await restored.delegation.messageSessionTask('session-1', task.delegationId, input))
          .toMatchObject({ ok: true, delivery: 'same-turn', queuedMessageId: id });
        expect(restored.steer).not.toHaveBeenCalled();
        expect(restored.started).toHaveLength(0);
        expect(await restored.delegation.messageSessionTask('session-2', task.delegationId, input))
          .toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
      } finally { restored.dispose(); }
    } finally { runtime.dispose(); }
  });

  it.each(['waitForInputBoundary', 'stopTurn', 'preparePause', 'flushInput'] as const)('retries an uncertain pause after %s fails', async (stage) => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish safely.' });
      if (!task.ok) throw new Error('task failed');
      runtime[stage].mockRejectedValueOnce(new Error('transient fixture failure'));
      expect(await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause'))
        .toMatchObject({ ok: false, errorCode: 'PAUSE_UNCONFIRMED' });
      const before = await runtime.delegation.getSessionTask('session-1', task.delegationId);
      runtime.advance(1_000);
      expect(await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause'))
        .toMatchObject({ ok: true, control: { state: 'pausing' } });
      expect(runtime[stage]).toHaveBeenCalledTimes(2);
      expect(runtime.heldInputs.has(task.childSessionId)).toBe(true);
      await runtime.settleChild(task.childSessionId, 'Stopped.');
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' }))
        .toMatchObject({ ok: true });
      const after = await runtime.delegation.getSessionTask('session-1', task.delegationId);
      if (!before.ok || !after.ok) throw new Error('missing task');
      expect(after.task.deadline_at).toBe(before.task.deadline_at! + 1_000);
    } finally { runtime.dispose(); }
  });

  it('does not acknowledge pause until the retained input snapshot has finished writing', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true });
    let release!: () => void;
    const persisted = new Promise<void>(resolve => { release = resolve; });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Retain the supplement.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'queued supplement' });
      runtime.flushInput.mockImplementationOnce(() => persisted);
      let acknowledged = false;
      const paused = runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause')
        .then(result => { acknowledged = true; return result; });
      await vi.waitFor(() => expect(runtime.flushInput).toHaveBeenCalledWith(task.childSessionId));
      expect(acknowledged).toBe(false);
      expect(runtime.heldInputs.has(task.childSessionId)).toBe(true);
      release();
      expect(await paused).toMatchObject({ ok: true });
    } finally { release(); runtime.dispose(); }
  });

  it.each(['bot', 'parent'] as const)('serializes %s lifecycle cancellation with the held resume commit', async (scope) => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true });
    let release!: () => void;
    const boundary = new Promise<void>(resolve => { release = resolve; });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish safely.' });
      if (!task.ok) throw new Error('task failed');
      await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      await runtime.settleChild(task.childSessionId, 'Stopped.');
      let atBoundary = false;
      runtime.flushInput.mockImplementationOnce(async () => { atBoundary = true; await boundary; });
      const resumed = runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' });
      await vi.waitFor(() => expect(atBoundary).toBe(true));
      let cancellationSettled = false;
      const cancelled = (scope === 'bot'
        ? runtime.delegation.cancelDelegationsForBot('bot-a')
        : runtime.delegation.cancelDelegationsForParentSession('session-1'))
        .then(result => { cancellationSettled = true; return result; });
      await new Promise(resolve => setImmediate(resolve));
      expect(cancellationSettled).toBe(false);
      expect(h.sqlite!.prepare('SELECT status FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'waiting' });
      // An abort awaiting its terminal callback must not deadlock with the lock.
      runtime.abortSession.mockImplementationOnce(async () => runtime.settleChild(task.childSessionId, 'Cancelled.'));
      release();
      expect(await resumed).toMatchObject({ ok: true });
      expect(await cancelled).toBe(1);
      expect(runtime.heldInputs.has(task.childSessionId)).toBe(false);
      const count = runtime.started.length;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' }))
        .toMatchObject({ ok: false, errorCode: 'NOT_PAUSED' });
      expect(runtime.started).toHaveLength(count);
    } finally { release(); runtime.dispose(); }
  });

  it('routes owned queue edits through the shared consuming and sender guards and reports dispatch receipts', async () => {
    await seedPair();
    const item = (clientId: string, sender: string): AgentInputQueuedMessage => ({
      clientId, text: 'before', persistedContent: 'before', model: 'model', effort: 'medium', permissionMode: 'default', workingDir: h.userDataDir,
      chatMessage: { clientId, role: 'user', content: 'before' },
      createOpts: { agentKind: 'codex', workingDir: h.userDataDir, model: 'model', effort: 'medium', permissionMode: 'default' },
      origin: { kind: 'session', senderSessionId: sender, displayText: 'before' },
    });
    let queue = [item('mine', 'session-1'), item('foreign', 'other-session')];
    const consumingClientIds: string[] = [];
    const shared = createSessionQueueControlService({
      getSnapshot: async () => ({ pendingQueue: queue, consumingClientIds }),
      replaceQueuedMessage: (_id, clientId, next) => {
        const index = queue.findIndex(item => item.clientId === clientId);
        if (index < 0) return false;
        queue[index] = next; return true;
      },
      removeQueuedMessage: (_id, clientId) => { queue = queue.filter(item => item.clientId !== clientId); return true; },
    });
    const runtime = createDelegationRuntime({ taskControl: true, taskQueue: {
      inspect: async (_id, caller) => queue.filter(item => authorizeSessionQueueItem(item, caller).ok)
        .map(item => ({ queuedMessageId: item.clientId, consuming: consumingClientIds.includes(item.clientId), message: item.text })),
      update: params => shared.update({ sessionId: params.targetSessionId, queuedMessageId: params.queuedMessageId, message: params.message,
        authorize: item => authorizeSessionQueueItem(item, params.callerSessionId), rebuild: rebuildSessionQueueItem }),
      cancel: params => shared.cancel({ sessionId: params.targetSessionId, queuedMessageId: params.queuedMessageId,
        authorize: item => authorizeSessionQueueItem(item, params.callerSessionId) }),
    } });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish the report.' });
      if (!task.ok) throw new Error('missing task');
      const edit = (id: string) => runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'edit', queuedMessageId: id, text: 'revised' });
      expect(await edit('foreign')).toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED' });
      expect(await edit('mine')).toMatchObject({ ok: true, delivery: 'queued' });
      expect(queue[0].persistedContent).toBe('revised');
      consumingClientIds.push('mine');
      expect(await edit('mine')).toMatchObject({ ok: false, errorCode: 'MESSAGE_CONSUMING' });
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId, 'mine'))
        .toMatchObject({ task: { queue: [{ queuedMessageId: 'mine', message: 'revised', consuming: true }], message_receipt: { state: 'consuming' } } });
      consumingClientIds.length = 0;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'withdraw', queuedMessageId: 'mine' }))
        .toMatchObject({ ok: true, delivery: 'withdrawn' });
      expect(queue.map(item => item.clientId)).toEqual(['foreign']);
      const message = await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'additional requirements' });
      if (!message.ok || !('queuedMessageId' in message)) throw new Error('missing receipt');
      expect(message.queuedMessageId).toEqual(expect.any(String));
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId, message.queuedMessageId))
        .toMatchObject({ task: { message_receipt: { state: 'dispatched' } } });
    } finally { runtime.dispose(); }
  });

  it('holds a paused execution through terminal events and restart, then resumes the same Session once', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true });
    try {
      const started = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Perform a non-repeatable action, then summarize.' });
      if (!started.ok) throw new Error('task did not start');
      const taskId = started.delegationId;
      const sessionId = started.childSessionId;
      const before = await runtime.delegation.getSessionTask('session-1', taskId);
      expect(await runtime.delegation.stopSessionTask('session-1', taskId, 'pause'))
        .toMatchObject({ ok: true, control: { state: 'pausing', queue_held: true, stop_status: 'requested' } });
      expect(runtime.abortSession).not.toHaveBeenCalled();
      expect(await runtime.delegation.messageSessionTask('session-1', taskId, { kind: 'resume' }))
        .toMatchObject({ ok: false, errorCode: 'STOP_UNCONFIRMED' });
      expect(await runtime.delegation.messageSessionTask('session-1', taskId, { kind: 'message', text: 'new' }))
        .toMatchObject({ ok: false, errorCode: 'TASK_PAUSED' });
      // An interaction arriving after stop was requested must not retract that stop.
      const lateRequest = { kind: 'permission' as const, requestId: 'late-approval', toolName: 'write_file', input: {} };
      await runtime.delegation.handleInteractionStart(sessionId, lateRequest);
      expect(await runtime.delegation.messageSessionTask('session-1', taskId, { kind: 'resume' }))
        .toMatchObject({ ok: false, errorCode: 'STOP_UNCONFIRMED' });
      await runtime.delegation.handleInteractionEnd(sessionId, lateRequest);
      await runtime.settleChild(sessionId, 'Partial work already performed.');
      expect(await runtime.delegation.getSessionTask('session-1', taskId))
        .toMatchObject({ ok: true, task: { status: 'waiting', control: { state: 'paused' }, completed_at: null } });
      expect(runtime.started.filter((turn) => turn.sessionId === 'session-1')).toHaveLength(0);
      runtime.advance(120_000);
      const startCount = runtime.started.length;
      await runtime.delegation.restore();
      expect(runtime.started).toHaveLength(startCount);
      const restored = createDelegationRuntime({ taskControl: true, startTime: 130_000 });
      try {
        await restored.delegation.restore();
        expect(restored.started).toHaveLength(0);
        expect(restored.heldInputs.has(sessionId)).toBe(true);
        const results = await Promise.all([
          restored.delegation.messageSessionTask('session-1', taskId, { kind: 'resume' }),
          restored.delegation.messageSessionTask('session-1', taskId, { kind: 'resume' }),
        ]);
        expect(results.filter((result) => result.ok)).toHaveLength(2); // Same resume receipt; only one dispatch.
        expect(restored.started.map((turn) => turn.sessionId)).toEqual([sessionId]);
        const after = await restored.delegation.getSessionTask('session-1', taskId);
        if (!before.ok || !after.ok) throw new Error('missing task');
        expect(after.task.deadline_at).toBe(before.task.deadline_at! + 120_000);
        expect(after.task.session_id).toBe(sessionId);
        const inputs = h.sqlite!.prepare("SELECT content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY rowid").all(sessionId) as Array<{ content: string }>;
        expect(inputs).toHaveLength(2);
        expect(inputs[1].content).toContain('do not replay the original request');
        await restored.settleChild(sessionId, 'Final result.');
        expect(await restored.delegation.getSessionTask('session-1', taskId))
          .toMatchObject({ ok: true, task: { status: 'completed', result: 'Final result.' } });
        expect(restored.started.filter((turn) => turn.sessionId === 'session-1')).toHaveLength(1);
      } finally { restored.dispose(); }
    } finally { runtime.dispose(); }
  });

  it.each(['claude', 'codex', 'pi'])('keeps owned %s task steer distinct from queue and preserves denial', async (harness) => {
    await seedPair({ harness });
    const runtime = createDelegationRuntime({ taskControl: true, steerUnsupported: true });
    try {
      const started = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish a report.' });
      if (!started.ok) throw new Error('task did not start');
      const count = runtime.started.length;
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId,
        { kind: 'message', text: 'urgent', mode: 'steer' }))
        .toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
      expect(runtime.started).toHaveLength(count);
      expect(await runtime.delegation.stopSessionTask(started.childSessionId, started.delegationId, 'pause'))
        .toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
      expect(runtime.stopTurn).not.toHaveBeenCalled();
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId,
        { kind: 'message', text: 'next turn' }))
        .toMatchObject({ ok: true, queued: true, delivery: 'queued' });
    } finally { runtime.dispose(); }
  });

  it.each([false, true])('preserves the permission input boundary after a failed pause write (already paused: %s)', async alreadyPaused => {
    await seedPair();
    const resolveInteraction = vi.fn(() => true);
    const runtime = createDelegationRuntime({ taskControl: true, resolveInteraction });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Wait for approval.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.handleInteractionStart(task.childSessionId,
        { kind: 'permission', requestId: 'pause-write-permission', toolName: 'write_file', input: {} });
      if (alreadyPaused) await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      const before = await runtime.delegation.getSessionTask('session-1', task.delegationId);
      h.sqlite!.exec("CREATE TEMP TRIGGER fail_pause_write BEFORE UPDATE OF permission_snapshot_json ON bot_delegations BEGIN SELECT RAISE(FAIL, 'fixture pause unavailable'); END");
      expect(await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause'))
        .toMatchObject({ ok: false, errorCode: 'PAUSE_UNCONFIRMED' });
      expect(runtime.heldInputs.has(task.childSessionId)).toBe(alreadyPaused);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toEqual(before);
      expect(resolveInteraction).not.toHaveBeenCalled();
      expect(runtime.stopTurn).not.toHaveBeenCalled();
      h.sqlite!.exec('DROP TRIGGER fail_pause_write');
      if (alreadyPaused) expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' }))
        .toMatchObject({ ok: true, delivery: 'awaiting-interaction' });
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'approve' }))
        .toMatchObject({ ok: true, delivery: 'interaction' });
      expect(resolveInteraction).toHaveBeenCalledTimes(1);
    } finally { h.sqlite!.exec('DROP TRIGGER IF EXISTS fail_pause_write'); runtime.dispose(); }
  });

  it.each(['queued', 'completed'] as const)('keeps %s recovery retryable after an unavailable worktree readback', async status => {
    await seedPair();
    let blocked = true;
    const reconcileWorktree = vi.fn(async () => { if (blocked) throw new Error('fixture reconciliation unavailable'); });
    const runtime = createDelegationRuntime({ taskControl: true, reconcileWorktree });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Resume only after ownership readback.' });
      if (!task.ok) throw new Error('missing task');
      if (status === 'completed') h.sqlite!.prepare("UPDATE bot_delegations SET status = 'completed', result_summary = 'fixture finished' WHERE id = ?").run(task.delegationId);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ ok: true, task: { status } });
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'continue' }))
        .toMatchObject({ ok: false, errorCode: 'WORKTREE_TRANSFER_PENDING' });
      const { createBotRuntimeRestoreCoordinator } = await import('../../../maker-ipc/botRuntimeRestore');
      const coordinator = createBotRuntimeRestoreCoordinator({
        readDbIdentity: () => ({ userId: 'owner', clientEpoch: 1 }),
        readServices: () => ({ directMessages: { restore: async () => undefined }, delegation: runtime.delegation }),
        log: { warn: vi.fn() },
      });
      expect(await coordinator.restoreCurrentOwner()).toBe(false);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ ok: true, task: { status } });
      blocked = false;
      expect(await coordinator.restoreCurrentOwner()).toBe(true);
      expect(await coordinator.restoreCurrentOwner()).toBe(true);
      // A new owner epoch performs a real recovery pass; durable receipts must
      // also prevent duplicate delivery when coordinator caching cannot help.
      await runtime.delegation.restore();
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ ok: true, task: { status: status === 'queued' ? 'running' : 'completed' } });
      expect(runtime.dispatch.mock.calls.filter(([params]) => params.clientId === `bot-delegation-start:${task.delegationId}`)).toHaveLength(status === 'queued' ? 1 : 0);
      if (status === 'completed') {
        expect((h.sqlite!.prepare('SELECT completion_delivered_at FROM bot_delegations WHERE id = ?').get(task.delegationId) as { completion_delivered_at: number | null }).completion_delivered_at).not.toBeNull();
        expect(runtime.dispatch.mock.calls.filter(([params]) => params.targetSessionId === 'session-1')).toHaveLength(1);
      }
    } finally { runtime.dispose(); }
  });

  it.each([false, true])('retries the resume dispatch readback failure unless cancelled (%s)', async cancel => {
    await seedPair();
    vi.useFakeTimers();
    let readbacks = 0;
    let failReadback = false;
    const runtime = createDelegationRuntime({ taskControl: true, reconcileWorktree: async () => {
      if (failReadback && ++readbacks === 2) throw new Error('fixture second readback unavailable');
    } });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Recover the interrupted turn.' });
      if (!task.ok) throw new Error('missing task');
      failReadback = true;
      await runtime.delegation.restore();
      const resumeCalls = () => runtime.dispatch.mock.calls.filter(([params]) => params.clientId?.startsWith(`bot-delegation-resume:${task.delegationId}:`));
      expect(resumeCalls()).toHaveLength(0);
      if (cancel) {
        await runtime.delegation.stopSessionTask('session-1', task.delegationId);
        await runtime.settleChild(task.childSessionId, 'Cancelled.');
      }
      runtime.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(resumeCalls()).toHaveLength(cancel ? 0 : 1);
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ ok: true, task: { status: cancel ? 'cancelled' : 'running' } });
    } finally { runtime.dispose(); vi.useRealTimers(); }
  });

  it('preserves other recovery progress and never dispatches a task cancelled between failed passes', async () => {
    await seedPair();
    let blockedSession: string | null = null;
    let unavailable = true;
    const runtime = createDelegationRuntime({ taskControl: true,
      transientUnavailable: () => unavailable,
      reconcileWorktree: async sessionId => {
        if (sessionId === blockedSession) throw new Error('fixture reconciliation unavailable');
      },
    });
    try {
      const blocked = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Cancel before recovery.' });
      const unaffected = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Recover the independent result.' });
      if (!blocked.ok || !unaffected.ok) throw new Error('missing tasks');
      blockedSession = blocked.childSessionId;
      h.sqlite!.prepare("UPDATE bot_delegations SET status = 'completed', result_summary = 'fixture finished' WHERE id = ?").run(unaffected.delegationId);
      const { createBotRuntimeRestoreCoordinator } = await import('../../../maker-ipc/botRuntimeRestore');
      const coordinator = createBotRuntimeRestoreCoordinator({
        readDbIdentity: () => ({ userId: 'owner', clientEpoch: 1 }),
        readServices: () => ({ directMessages: { restore: async () => undefined }, delegation: runtime.delegation }),
        log: { warn: vi.fn() },
      });
      // Let parent result delivery succeed while ownership blocks child startup.
      unavailable = false;
      runtime.dispatch.mockClear();
      expect(await coordinator.restoreCurrentOwner()).toBe(false);
      expect(runtime.dispatch.mock.calls.filter(([params]) => params.targetSessionId === 'session-1')).toHaveLength(1);
      expect(await runtime.delegation.stopSessionTask('session-1', blocked.delegationId, 'cancel')).toMatchObject({ ok: true });
      expect(runtime.heldInputs.has(blocked.childSessionId)).toBe(false);
      blockedSession = null;
      expect(await coordinator.restoreCurrentOwner()).toBe(true);
      await runtime.delegation.restore();
      expect(await runtime.delegation.getSessionTask('session-1', blocked.delegationId)).toMatchObject({ ok: true, task: { status: 'cancelled' } });
      expect(runtime.dispatch.mock.calls.some(([params]) => params.targetSessionId === blocked.childSessionId)).toBe(false);
      expect(runtime.dispatch.mock.calls.filter(([params]) => params.targetSessionId === 'session-1')).toHaveLength(2);
    } finally { runtime.dispose(); }
  });

  it.each([false, true])('only renotifies an unresolved interaction on resume (applied IM answer: %s)', async applied => {
    await seedPair();
    let decisionApplied = false;
    const runtime = createDelegationRuntime({ taskControl: true,
      appliedOnResume: () => decisionApplied ? ['im-answer'] : [] });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Wait for an IM answer.' });
      if (!task.ok) throw new Error('missing task');
      const request = { kind: 'permission' as const, requestId: 'im-answer', toolName: 'write_file', input: {} };
      await runtime.delegation.handleInteractionStart(task.childSessionId, request);
      expect(await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause')).toMatchObject({ ok: true });
      runtime.dispatch.mockClear();
      decisionApplied = applied;
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' }))
        .toMatchObject({ ok: true, delivery: applied ? 'interaction' : 'awaiting-interaction' });
      const notifications = runtime.dispatch.mock.calls.filter(([params]) => params.clientId?.includes('bot-delegation-interaction:'));
      expect(notifications).toHaveLength(applied ? 0 : 1);
      const row = h.sqlite!.prepare('SELECT status, pending_interaction_json FROM bot_delegations WHERE id = ?').get(task.delegationId) as { status: string; pending_interaction_json: string | null };
      expect(row.status).toBe(applied ? 'running' : 'waiting');
      if (applied) {
        expect(row.pending_interaction_json).toBeNull();
        // The delayed native callback is harmless after synchronous bookkeeping.
        await runtime.delegation.handleInteractionEnd(task.childSessionId, request);
        expect(runtime.dispatch.mock.calls.filter(([params]) => params.clientId?.includes('bot-delegation-interaction:'))).toHaveLength(0);
      }
    } finally { runtime.dispose(); }
  });

  it('pauses an interaction without resolving it, and accounts for the wait only once', async () => {
    await seedPair();
    const resolveInteraction = vi.fn(() => true);
    const runtime = createDelegationRuntime({ taskControl: true, resolveInteraction });
    try {
      const started = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Write the report after approval.' });
      if (!started.ok) throw new Error('task did not start');
      const request = { kind: 'permission' as const, requestId: 'held-approval', toolName: 'write_file', input: {} };
      const before = await runtime.delegation.getSessionTask('session-1', started.delegationId);
      await runtime.delegation.handleInteractionStart(started.childSessionId, request);
      runtime.advance(10_000);
      expect(await runtime.delegation.stopSessionTask('session-1', started.delegationId, 'pause')).toMatchObject({ ok: true });
      expect(runtime.stopTurn).not.toHaveBeenCalled();
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId, { kind: 'approve' }))
        .toMatchObject({ ok: false, errorCode: 'TASK_PAUSED' });
      expect(resolveInteraction).not.toHaveBeenCalled();
      runtime.advance(20_000);
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId, { kind: 'resume' }))
        .toMatchObject({ ok: true, delivery: 'awaiting-interaction' });
      runtime.advance(5_000);
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId, { kind: 'approve' }))
        .toMatchObject({ ok: true, delivery: 'interaction' });
      expect(resolveInteraction).toHaveBeenCalledTimes(1);
      await runtime.delegation.handleInteractionEnd(started.childSessionId, request);
      const after = await runtime.delegation.getSessionTask('session-1', started.delegationId);
      if (!before.ok || !after.ok) throw new Error('missing task');
      expect(after.task.deadline_at).toBe(before.task.deadline_at! + 35_000);
      expect(after.task.pendingInteraction).toBeNull();
      expect(runtime.started.filter((turn) => turn.sessionId === started.childSessionId)).toHaveLength(1);
    } finally { runtime.dispose(); }
  });

  /** Commit the real SQLite update, then lose only its worker acknowledgement. */
  function loseResumeCommitReceipt(readbackUnavailable: boolean) {
    const update = h.db!.update.bind(h.db!);
    return vi.spyOn(h.db!, 'update').mockImplementation(table => {
      const builder = update(table);
      const set = builder.set.bind(builder);
      builder.set = values => {
        const query = set(values);
        if (table === botDelegations && JSON.stringify(values).includes('taskResume')) {
          const returning = query.returning.bind(query);
          query.returning = (fields?: Parameters<typeof returning>[0]) => {
            const result = fields ? returning(fields) : returning();
            result.all();
            if (readbackUnavailable) vi.spyOn(h.db!, 'select').mockImplementationOnce(() => {
              throw new Error('fixture readback unavailable');
            });
            throw new Error('fixture commit acknowledgement lost');
          };
        }
        return query;
      };
      return builder;
    });
  }

  const flushTaskQueue = async () => {
    for (let i = 0; i < 30; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };

  it.each(['retry', 'restart', 'cancel'] as const)('retains an idle resume behind the real queue barrier on DB failure, then handles %s', async recovery => {
    await seedPair();
    const queueSnapshots = new Map<string, AgentInputQueuedMessage[]>();
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Do each action once.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      await runtime.settleChild(task.childSessionId, 'Stopped before continuing.');
      runtime.advance(1_000);
      h.sqlite!.exec("CREATE TEMP TRIGGER fail_resume_commit BEFORE UPDATE OF permission_snapshot_json ON bot_delegations WHEN json_extract(NEW.permission_snapshot_json, '$.taskPause') IS NULL BEGIN SELECT RAISE(FAIL, 'fixture resume DB unavailable'); END");
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' }))
        .toMatchObject({ ok: false, errorCode: 'RESUME_FAILED' });
      await flushTaskQueue();
      expect(runtime.started).toHaveLength(1);
      expect(runtime.heldInputs.has(task.childSessionId)).toBe(true);
      expect(queueSnapshots.get(task.childSessionId)).toHaveLength(1);
      const retainedId = queueSnapshots.get(task.childSessionId)![0].clientId;
      expect(h.sqlite!.prepare('SELECT 1 FROM messages WHERE client_id = ?').get(retainedId)).toBeUndefined();
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { control: { state: 'paused' }, completed_at: null } });
      h.sqlite!.exec('DROP TRIGGER fail_resume_commit');
      if (recovery === 'cancel') {
        expect(await runtime.delegation.stopSessionTask('session-1', task.delegationId)).toMatchObject({ ok: true });
        await flushTaskQueue();
        expect(runtime.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(1);
        expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: false });
        expect(queueSnapshots.get(task.childSessionId) ?? []).toHaveLength(0);
        return;
      }
      if (recovery === 'restart') {
        runtime.dispose();
        const restored = createDelegationRuntime({ taskControl: true, queueSnapshots, startTime: 12_000 });
        try {
          await restored.delegation.restore();
          await flushTaskQueue();
          expect(restored.started).toHaveLength(0);
          expect(await restored.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: true });
          await flushTaskQueue();
          expect(restored.started).toHaveLength(1);
          await restored.settleChild(task.childSessionId, 'Restored continuation completed.');
          expect(await restored.delegation.getSessionTask('session-1', task.delegationId)).toMatchObject({ task: { status: 'completed' } });
        } finally { restored.dispose(); }
        return;
      }
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: true });
      await flushTaskQueue();
      expect(runtime.started).toHaveLength(2);
      expect(runtime.heldInputs.has(task.childSessionId)).toBe(false);
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: true });
      await flushTaskQueue();
      expect(runtime.started).toHaveLength(2);
      await runtime.settleChild(task.childSessionId, 'The resumed work is complete.');
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: 'completed', result: 'The resumed work is complete.' } });
    } finally {
      h.sqlite!.exec('DROP TRIGGER IF EXISTS fail_resume_commit');
      runtime.dispose();
    }
  });

  it('keeps a completion emitted immediately as the resume barrier opens', async () => {
    await seedPair();
    let childId = '';
    let completion: Promise<void> | undefined;
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots: new Map(),
      onNativeStarted: id => {
        if (id === childId) completion = runtime.settleChild(id, 'Immediate resumed completion.');
      },
    });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish without duplication.' });
      if (!task.ok) throw new Error('missing task');
      childId = task.childSessionId;
      await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      await runtime.settleChild(childId, 'Stopped.');
      runtime.advance(1_000);
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: true });
      await flushTaskQueue();
      expect(completion).toBeDefined();
      await completion;
      expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: 'completed', result: 'Immediate resumed completion.' } });
      expect(runtime.started.filter(turn => turn.sessionId === childId)).toHaveLength(2);
    } finally { runtime.dispose(); }
  });

  it.each(['readback', 'retry', 'restore', 'restart'] as const)('recovers a committed resume after receipt loss through %s without replaying work', async recovery => {
    await seedPair();
    const queueSnapshots = new Map<string, AgentInputQueuedMessage[]>();
    const runtime = createDelegationRuntime({ taskControl: true, queueSnapshots });
    let restored: ReturnType<typeof createDelegationRuntime> | undefined;
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Continue exactly once.' });
      if (!task.ok) throw new Error('missing task');
      await runtime.delegation.stopSessionTask('session-1', task.delegationId, 'pause');
      await runtime.settleChild(task.childSessionId, 'Stopped.');
      runtime.advance(1_000);
      const fault = loseResumeCommitReceipt(recovery !== 'readback');
      const result = await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' });
      fault.mockRestore();
      await flushTaskQueue();
      expect(result).toMatchObject({ ok: recovery === 'readback' });
      if (recovery !== 'readback') {
        expect(runtime.started).toHaveLength(1);
        expect(runtime.heldInputs.has(task.childSessionId)).toBe(true);
        expect(queueSnapshots.get(task.childSessionId)).toHaveLength(1);
        expect(await runtime.delegation.getSessionTask('session-1', task.delegationId))
          .toMatchObject({ task: { control: { state: 'resuming', queue_held: true } } });
      }
      if (recovery === 'retry') {
        expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: true });
      } else if (recovery === 'restore') {
        await runtime.delegation.restore();
      } else if (recovery === 'restart') {
        runtime.dispose();
        restored = createDelegationRuntime({ taskControl: true, queueSnapshots, startTime: 11_000 });
        await restored.delegation.restore();
      }
      await flushTaskQueue();
      const active = restored ?? runtime;
      expect(active.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(restored ? 1 : 2);
      const dispatchCount = active.dispatch.mock.calls.length;
      expect(await active.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume', text: 'Different input' }))
        .toMatchObject({ ok: false, errorCode: 'RESUME_INPUT_CHANGED' });
      expect(await active.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'resume' })).toMatchObject({ ok: true });
      expect(active.dispatch).toHaveBeenCalledTimes(dispatchCount);
      await active.settleChild(task.childSessionId, 'One completed continuation.');
      expect(await active.delegation.getSessionTask('session-1', task.delegationId))
        .toMatchObject({ task: { status: 'completed', result: 'One completed continuation.' } });
      const afterCompletion = createDelegationRuntime({ taskControl: true, queueSnapshots, startTime: 12_000 });
      try {
        await afterCompletion.delegation.restore();
        expect(afterCompletion.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(0);
      } finally { afterCompletion.dispose(); }
    } finally { vi.restoreAllMocks(); restored?.dispose(); runtime.dispose(); }
  });

  it('uses native steer and graceful stop without queueing or finishing the task', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true });
    try {
      const started = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish.' });
      if (!started.ok) throw new Error('task did not start');
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId,
        { kind: 'message', text: 'Correct the current direction.', mode: 'steer' }))
        .toMatchObject({ ok: true, delivery: 'same-turn', queued: false });
      expect(await runtime.delegation.stopSessionTask('session-1', started.delegationId, 'request-stop'))
        .toMatchObject({ ok: true, control: { state: 'requested', queue_held: false } });
      expect(runtime.stopTurn).toHaveBeenCalledWith({ targetSessionId: started.childSessionId });
      expect(runtime.started).toHaveLength(1);
      expect(runtime.abortSession).not.toHaveBeenCalled();
      expect(await runtime.delegation.getSessionTask('session-1', started.delegationId))
        .toMatchObject({ task: { status: 'running', completed_at: null,
          control: { last_stop_request: { requested_at: 10_000, status: 'requested' }, stop_status: 'unconfirmed' } } });
      const restored = createDelegationRuntime({ taskControl: true });
      try {
        expect(await restored.delegation.getSessionTask('session-1', started.delegationId))
          .toMatchObject({ task: { control: { last_stop_request: { status: 'requested' }, stop_status: 'stopped' } } });
        expect(restored.stopTurn).not.toHaveBeenCalled();
      } finally { restored.dispose(); }
    } finally { runtime.dispose(); }
  });

  it.each([undefined, 'Use the revised requirements.'])('keeps a pre-dispatch pause durable with resume input %s, and cancel prevents resume', async (text) => {
    await seedPair();
    let transientUnavailable = true;
    const runtime = createDelegationRuntime({ taskControl: true, transientUnavailable: () => transientUnavailable });
    try {
      const started = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish when ready.' });
      if (!started.ok) throw new Error('task did not start');
      expect(await runtime.delegation.stopSessionTask('session-1', started.delegationId, 'pause'))
        .toMatchObject({ ok: true, control: { state: 'paused' } });
      transientUnavailable = false;
      // Paused time must not consume the initial dispatch deadline.
      runtime.advance(24 * 60 * 60 * 1_000);
      await runtime.delegation.restore();
      expect(runtime.started).toHaveLength(0);
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId, { kind: 'resume', text }))
        .toMatchObject({ ok: true, childSessionId: started.childSessionId });
      expect(runtime.started.map((turn) => turn.sessionId)).toEqual(text
        ? [started.childSessionId, started.childSessionId] : [started.childSessionId]);
      expect(await runtime.delegation.getSessionTask('session-1', started.delegationId)).toMatchObject({ task: { status: 'running' } });
      await runtime.delegation.stopSessionTask('session-1', started.delegationId, 'pause');
      expect(await runtime.delegation.stopSessionTask('session-1', started.delegationId))
        .toMatchObject({ ok: true, control: { state: 'cancelling', stop_status: 'unconfirmed' } });
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId, { kind: 'resume' }))
        .toMatchObject({ ok: false, errorCode: 'STOP_UNCONFIRMED' });
      await runtime.settleChild(started.childSessionId, 'Interrupted.');
      expect(await runtime.delegation.getSessionTask('session-1', started.delegationId))
        .toMatchObject({ ok: true, task: { status: 'cancelled', control: { stop_status: 'stopped' } } });
      expect(await runtime.delegation.messageSessionTask('session-1', started.delegationId, { kind: 'resume' }))
        .toMatchObject({ ok: false, errorCode: 'NOT_PAUSED' });
    } finally { runtime.dispose(); }
  });

  it('preserves cancellation across a late interaction end and host restore', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true });
    try {
      const task = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Wait for approval.' });
      if (!task.ok) throw new Error('missing task');
      const request = { kind: 'permission' as const, requestId: 'approval', toolName: 'write_file', input: {} };
      await runtime.delegation.handleInteractionStart(task.childSessionId, request);
      await runtime.delegation.stopSessionTask('session-1', task.delegationId);
      runtime.advance(1_000);
      await runtime.delegation.handleInteractionEnd(task.childSessionId, request);
      expect(await runtime.delegation.messageSessionTask('session-1', task.delegationId, { kind: 'message', text: 'must not run' }))
        .toMatchObject({ ok: false, errorCode: 'STOP_UNCONFIRMED' });
      const restored = createDelegationRuntime({ taskControl: true });
      try {
        await restored.delegation.restore();
        expect(await restored.delegation.getSessionTask('session-1', task.delegationId))
          .toMatchObject({ task: { status: 'cancelled', control: { stop_status: 'stopped' } } });
        expect(restored.started.filter(turn => turn.sessionId === task.childSessionId)).toHaveLength(0);
      } finally { restored.dispose(); }
    } finally { runtime.dispose(); }
  });

  it('does not leave a durable hold when graceful stop is unsupported', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ taskControl: true, stopUnsupported: true });
    try {
      const started = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Finish.' });
      if (!started.ok) throw new Error('task did not start');
      expect(await runtime.delegation.stopSessionTask('session-1', started.delegationId, 'pause'))
        .toMatchObject({ ok: false, errorCode: 'UNSUPPORTED_CAPABILITY' });
      expect(runtime.heldInputs.size).toBe(0);
      expect(await runtime.delegation.getSessionTask('session-1', started.delegationId))
        .toMatchObject({ ok: true, task: { status: 'running', control: { queue_held: false } } });
    } finally { runtime.dispose(); }
  });

  it('persists independent receipts before queued wakeups for simultaneous results and an interleaved input', async () => {
    await seedPair();
    const runtime = createDelegationRuntime({ collectArtifacts: async () => [{ path: 'report.pdf', absolutePath: '/reports/report.pdf', status: 'added' }] });
    try {
      const first = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'First report' });
      const second = await runtime.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Second report' });
      if (!first.ok || !second.ok) throw new Error('Tasks did not start');
      h.sqlite!.prepare('UPDATE sessions SET working_dir = ? WHERE id IN (?, ?)').run('/child-task', first.childSessionId, second.childSessionId);
      await runtime.dispatch({ targetSessionId: 'session-1', message: 'Another input', clientId: 'interleaved' });
      await Promise.all([
        runtime.settleChild(first.childSessionId, '![chart](https://example.com/chart.png)'),
        runtime.settleChild(second.childSessionId, '[Report](https://example.com/report.pdf)'),
      ]);
      const results = h.sqlite!.prepare('SELECT client_id, agent_meta FROM messages WHERE session_id = ? AND client_id LIKE ? ORDER BY created_at')
        .all('session-1', 'bot-delegation-result:%') as { agent_meta: string }[];
      expect(results).toHaveLength(2);
      expect(results.every(row => JSON.parse(row.agent_meta).botCollaboration.result.workingDir === '/child-task')).toBe(true);
      expect(results.map(row => JSON.parse(row.agent_meta).botCollaboration.result.text).sort()).toEqual([
        '![chart](https://example.com/chart.png)', '[Report](https://example.com/report.pdf)',
      ].sort());
      expect(results.every(row => JSON.parse(row.agent_meta).botCollaboration.result.artifacts[0].absolutePath === '/reports/report.pdf')).toBe(true);
      expect(runtime.started.filter(turn => turn.sessionId === first.childSessionId)).toHaveLength(1);
      expect(runtime.started.filter(turn => turn.sessionId === second.childSessionId)).toHaveLength(1);
    } finally { runtime.dispose(); }
  });

  it('rehomes a result receipt when its parent is physically deleted after persistence', async () => {
    await seedPair();
    let replacementSessionId: string | undefined;
    const runtime = createDelegationRuntime({
      onResultReceiptPersisted: async () => {
        if (replacementSessionId) return;
        // The receipt was committed, then parent deletion cascades it away
        // before the completion wake-up can be delivered.
        h.sqlite!.prepare("DELETE FROM sessions WHERE id = 'session-1'").run();
        const recovered = await invoke('local-db:bots:create-canonical-session', {
          botId: 'bot-a',
          expectedCanonicalSessionId: null,
          expectedProfileVersion: 1,
        });
        replacementSessionId = recovered.canonicalSessionId as string;
      },
    });
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1', objective: 'Preserve the final report',
      });
      if (!started.ok) throw new Error('Task did not start');
      await runtime.settleChild(started.childSessionId, '[Report](https://example.com/report.pdf)');

      expect(replacementSessionId).toBeTruthy();
      expect(h.sqlite!.prepare('SELECT session_id, agent_meta FROM messages WHERE client_id = ?')
        .get(`bot-delegation-result:${started.delegationId}:1`)).toMatchObject({
        session_id: replacementSessionId,
        agent_meta: expect.stringContaining('https://example.com/report.pdf'),
      });
      expect(h.sqlite!.prepare('SELECT completion_delivered_at FROM bot_delegations WHERE id = ?')
        .pluck().get(started.delegationId)).not.toBeNull();
      expect(runtime.started.some(turn => turn.sessionId === replacementSessionId)).toBe(true);
    } finally { runtime.dispose(); }
  });

  it('retries the completion wake when its original target disappears after dispatch', async () => {
    await seedPair();
    let replacementSessionId: string | undefined;
    const runtime = createDelegationRuntime({
      onCompletionDispatched: async () => {
        if (replacementSessionId) return;
        h.sqlite!.prepare("DELETE FROM sessions WHERE id = 'session-1'").run();
        const recovered = await invoke('local-db:bots:create-canonical-session', {
          botId: 'bot-a', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
        });
        replacementSessionId = recovered.canonicalSessionId as string;
      },
    });
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1', objective: 'Keep the report and wake its requester',
      });
      if (!started.ok) throw new Error('Task did not start');
      await runtime.settleChild(started.childSessionId, 'The final report.');

      expect(replacementSessionId).toBeTruthy();
      expect(h.sqlite!.prepare('SELECT session_id FROM messages WHERE client_id = ?')
        .get(`bot-delegation-result:${started.delegationId}:1`)).toEqual({ session_id: replacementSessionId });
      expect(h.sqlite!.prepare('SELECT completion_delivered_at FROM bot_delegations WHERE id = ?')
        .pluck().get(started.delegationId)).toBeNull();
      expect(h.sqlite!.prepare('SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?')
        .get(replacementSessionId, `bot-delegation-completion:${started.delegationId}`)).toBeUndefined();

      await runtime.delegation.restore();
      expect(h.sqlite!.prepare('SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?')
        .get(replacementSessionId, `bot-delegation-completion:${started.delegationId}`)).toBeTruthy();
      expect(h.sqlite!.prepare('SELECT completion_delivered_at FROM bot_delegations WHERE id = ?')
        .pluck().get(started.delegationId)).not.toBeNull();
    } finally { runtime.dispose(); }
  });

  it.each(['paused-bot', 'archived-parent'] as const)(
    'keeps the result in the original conversation when the requester is %s',
    async (requesterState) => {
      await seedPair();
      const runtime = createDelegationRuntime({
        collectArtifacts: async () => [{ path: 'report.pdf', absolutePath: '/reports/report.pdf', status: 'added' }],
      });
      try {
        const started = await runtime.delegation.startSessionTask({
          callerSessionId: 'session-1', objective: 'Produce a report',
        });
        if (!started.ok) throw new Error('Task did not start');
        if (requesterState === 'paused-bot') {
          h.sqlite!.prepare("UPDATE bot_profiles SET status = 'paused' WHERE id = 'bot-a'").run();
        } else {
          h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = 'session-1'").run();
        }

        await runtime.settleChild(started.childSessionId, '[Report](https://example.com/report.pdf)');
        const receipt = h.sqlite!.prepare(
          'SELECT session_id, agent_meta FROM messages WHERE client_id = ?',
        ).get(`bot-delegation-result:${started.delegationId}:1`) as {
          session_id: string; agent_meta: string;
        };
        expect(receipt.session_id).toBe('session-1');
        expect(JSON.parse(receipt.agent_meta).botCollaboration.result).toMatchObject({
          runSequence: 1,
          status: 'completed',
          text: '[Report](https://example.com/report.pdf)',
          artifacts: [{ absolutePath: '/reports/report.pdf' }],
        });
        expect(h.sqlite!.prepare('SELECT completion_delivered_at FROM bot_delegations WHERE id = ?')
          .pluck().get(started.delegationId)).toBeNull();
        expect(runtime.dispatch.mock.calls.some(([input]) => input.clientId ===
          `bot-delegation-completion:${started.delegationId}`)).toBe(false);
        await runtime.delegation.restore();
        expect(h.sqlite!.prepare('SELECT COUNT(*) FROM messages WHERE client_id = ?').pluck()
          .get(`bot-delegation-result:${started.delegationId}:1`)).toBe(1);

        if (requesterState === 'paused-bot') {
          h.sqlite!.prepare("UPDATE bot_profiles SET status = 'active' WHERE id = 'bot-a'").run();
        } else {
          h.sqlite!.prepare("UPDATE sessions SET status = 'active' WHERE id = 'session-1'").run();
        }
        await runtime.delegation.restore();
        expect(h.sqlite!.prepare('SELECT COUNT(*) FROM messages WHERE client_id = ?').pluck()
          .get(`bot-delegation-result:${started.delegationId}:1`)).toBe(1);
        expect(runtime.dispatch.mock.calls.filter(([input]) => input.clientId ===
          `bot-delegation-completion:${started.delegationId}`)).toHaveLength(1);
      } finally { runtime.dispose(); }
    },
  );

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
      expect(continued.childSessionId).toBe(started.childSessionId);
      expect(await runtime.delegation.listDelegations('session-1')).toMatchObject({
        delegations: [expect.objectContaining({ id: started.delegationId, childSessionId: started.childSessionId, status: 'running' })],
      });
      expect(runtime.started.filter(turn => turn.sessionId === started.childSessionId)).toHaveLength(2);
      expect(runtime.dispatch.mock.calls.at(-1)?.[0].clientId).toBe(`bot-delegation-start:${started.delegationId}:2`);
      expect(h.sqlite!.prepare('SELECT content FROM messages WHERE session_id = ? AND role = ?').all(started.childSessionId, 'assistant'))
        .toContainEqual({ content: '第一版结果。' });
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
      const resultCards = h.sqlite!.prepare(
        'SELECT client_id, agent_meta FROM messages WHERE session_id = ? AND client_id LIKE ? ORDER BY created_at',
      ).all('session-1', `bot-delegation-result:${started.delegationId}:%`) as Array<{ client_id: string; agent_meta: string }>;
      const workingDir = h.sqlite!.prepare('SELECT working_dir FROM sessions WHERE id = ?').pluck().get(started.childSessionId);
      expect(resultCards.map(row => JSON.parse(row.agent_meta).botCollaboration.result)).toEqual([
        { workingDir, runSequence: 1, status: 'completed', text: '第一版结果。', artifacts: [] },
        { workingDir, runSequence: 2, status: 'completed', text: '第二版结果，含风险清单。', artifacts: [] },
      ]);
      expect(h.sqlite!.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_id = ?')
        .get(`bot-delegation-request:${started.delegationId}`)).toEqual({ n: 1 });
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

      const instruction = '补充：最后必须带风险清单。\n读取 /workspace/project/AGENTS.md 并核对执行授权。';
      await expect(
        runtime.delegation.messageSessionTask('session-1', started.delegationId, {
          kind: 'message',
          text: instruction,
          idempotencyKey: 'follow-up-1',
        }),
      ).resolves.toMatchObject({ ok: true, queued: true, resumed: false });

      const childClientId = `bot-delegation-interject:${started.delegationId}:follow-up-1`;
      expect(runtime.dispatch).toHaveBeenCalledWith(expect.objectContaining({
        targetSessionId: started.childSessionId,
        clientId: childClientId,
        message: `[来自 发起方伙伴 的补充]\n\n${instruction}`,
        persistedContent: `[来自 发起方伙伴 的补充]\n\n${instruction}`,
      }));
      const readMessage = (sessionId: string, clientId: string) => h.sqlite!.prepare(
        'SELECT role, content, agent_meta AS agentMeta FROM messages WHERE session_id = ? AND client_id = ?',
      ).get(sessionId, clientId) as { role: string; content: string; agentMeta: string };
      expect(readMessage(started.childSessionId, childClientId).content).toContain(instruction);
      const trace = readMessage('session-1', `bot-delegation-interject-mirror:${started.delegationId}:follow-up-1`);
      expect(trace).toMatchObject({ role: 'assistant', content: '' });
      expect(JSON.parse(trace.agentMeta).botCollaboration.role).toBe('interjection');
      expect(readMessage('session-1', `bot-delegation-request:${started.delegationId}`).content).toBe('');
      // Status queries return context to the caller without appending it to the timeline.
      const timelineBeforeCheck = h.sqlite!.prepare("SELECT * FROM messages WHERE session_id = 'session-1'").all();
      await expect(runtime.delegation.getSessionTask('session-1', started.delegationId)).resolves.toMatchObject({
        ok: true, task: { status: 'running', objective: '先整理一版方案。' },
      });
      expect(h.sqlite!.prepare("SELECT * FROM messages WHERE session_id = 'session-1'").all()).toEqual(timelineBeforeCheck);

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

  it.each(['delegation-request', 'interjection', 'delegation-result'])('recovers the child answer without promoting a nested %s receipt', async (nestedRole) => {
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
      h.sqlite!.prepare(`INSERT INTO messages (id, client_id, session_id, role, content, created_at, agent_meta)
        VALUES ('nested', 'nested', ?, 'assistant', 'Nested result, not the outer answer', 21000, ?)`)
        .run(childSessionId, JSON.stringify({ botCollaboration: { role: nestedRole } }));
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

  it('preserves an incomplete result in the failed task card and completion receipt', async () => {
    await seedPair();
    const runtime = createDelegationRuntime();
    try {
      const delegated = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1', objective: '查一下版本兼容矩阵。',
      });
      expect(delegated.ok).toBe(true);
      if (!delegated.ok) throw new Error('Session task did not start');
      await runtime.delegation.settleSession({
        childSessionId: delegated.childSessionId, outcome: 'error',
        resultText: '已确认前两个版本兼容，第三个版本',
        error: 'Pi reached the model output limit.',
      });
      await expect(runtime.delegation.getSessionTask('session-1', delegated.delegationId)).resolves.toMatchObject({
        ok: true, task: { status: 'failed', result: '已确认前两个版本兼容，第三个版本' },
      });
      const receipt = h.sqlite!.prepare(
        'SELECT content FROM messages WHERE session_id = ? AND client_id = ?',
      ).pluck().get('session-1', `bot-delegation-completion:${delegated.delegationId}`);
      const resultCard = h.sqlite!.prepare('SELECT agent_meta FROM messages WHERE client_id = ?')
        .get(`bot-delegation-result:${delegated.delegationId}:1`) as { agent_meta: string };
      expect(JSON.parse(resultCard.agent_meta).botCollaboration.result).toMatchObject({
        status: 'failed', text: '已确认前两个版本兼容，第三个版本', error: 'Pi reached the model output limit.',
      });
      await expect(runtime.delegation.messageSessionTask('session-1', delegated.delegationId, { kind: 'message', text: 'Continue' }))
        .resolves.toMatchObject({ ok: true, resumed: true });
      await runtime.settleChild(delegated.childSessionId, 'Recovered result');
      expect(h.sqlite!.prepare('SELECT agent_meta FROM messages WHERE client_id = ?').pluck()
        .get(`bot-delegation-result:${delegated.delegationId}:1`)).toBe(resultCard.agent_meta);
      expect(receipt).toContain('已确认前两个版本兼容，第三个版本');
      expect(receipt).toContain('Pi reached the model output limit.');
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
        input: {
          path: '/tmp/report.md',
          headers: { 'X-Auth': 'opaque-private-credential' },
          token: 'private-credential-value',
        },
        title: '写入报告',
      };
      await runtime.delegation.handleInteractionStart(started.childSessionId, request);
      const wake = runtime.dispatch.mock.calls.find(([params]) =>
        params.clientId === `bot-delegation-interaction:${started.delegationId}:${request.requestId}`,
      )?.[0].message;
      expect(wake).toContain('请求工具: write_file');
      expect(wake).not.toContain('/tmp/report.md');
      expect(wake).not.toContain('opaque-private-credential');
      expect(wake).not.toContain('private-credential-value');
      expect(wake).not.toContain('请求参数');
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
            summary: '写入报告',
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

  it('retries a pending approval wake-up in the replacement canonical task', async () => {
    await seedPair();
    vi.useFakeTimers();
    let replacementSessionId: string | undefined;
    const runtime = createDelegationRuntime({
      onInteractionDispatched: async () => {
        if (replacementSessionId) return;
        h.sqlite!.prepare("DELETE FROM sessions WHERE id = 'session-1'").run();
        const recovered = await invoke('local-db:bots:create-canonical-session', {
          botId: 'bot-a', expectedCanonicalSessionId: null, expectedProfileVersion: 1,
        });
        replacementSessionId = recovered.canonicalSessionId as string;
      },
    });
    try {
      const task = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1', objective: 'Wait for approval before writing.',
      });
      if (!task.ok) throw new Error('Task did not start');
      const request = { kind: 'permission' as const, requestId: 'replacement-approval', toolName: 'write_file', input: {} };
      await runtime.delegation.handleInteractionStart(task.childSessionId, request);
      expect(replacementSessionId).toBeTruthy();
      const wakeId = `bot-delegation-interaction:${task.delegationId}:${request.requestId}`;
      expect(h.sqlite!.prepare('SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?')
        .get(replacementSessionId, wakeId)).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sqlite!.prepare('SELECT 1 FROM messages WHERE session_id = ? AND client_id = ?')
        .get(replacementSessionId, wakeId)).toBeTruthy();
      expect(runtime.started.filter(turn => turn.sessionId === replacementSessionId)).toHaveLength(1);
      expect(await runtime.delegation.getSessionTask(replacementSessionId!, task.delegationId))
        .toMatchObject({ task: { status: 'waiting', pendingInteraction: { requestId: request.requestId } } });
    } finally {
      runtime.dispose();
      vi.useRealTimers();
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
      const resultCard = h.sqlite!.prepare('SELECT agent_meta FROM messages WHERE client_id = ?').pluck()
        .get(`bot-delegation-result:${started.delegationId}:1`) as string;
      expect(JSON.parse(resultCard).botCollaboration.result).toMatchObject({
        status: 'timed-out', error: 'TIMEOUT: 到了约定时间后台任务还没有交回结果',
      });
    } finally {
      runtime.dispose();
      vi.useRealTimers();
    }
  });

  it.each([[10_000, 'active'], [2_000_000, 'active'], [10_000, 'archived'], [2_000_000, 'archived']] as const)('recovers the durable terminal at time %s with Session %s', async (startTime, sessionStatus) => {
    await seedPair();
    const execution = { instanceId: 'before-restart', generation: 1 };
    const beforeRestart = createDelegationRuntime({ readSessionExecution: () => execution });
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
    // Crash after recording the native terminal event, before terminal settlement.
    h.sqlite!.exec("CREATE TEMP TRIGGER fail_terminal_commit BEFORE UPDATE OF status ON bot_delegations WHEN NEW.status = 'completed' BEGIN SELECT RAISE(FAIL, 'fixture restart'); END");
    await expect(beforeRestart.delegation.settleSession({ childSessionId: started.childSessionId, outcome: 'done', execution,
      resultMessageClientId: 'restored-answer-client', hadPendingInputAtTerminal: false })).rejects.toThrow();
    h.sqlite!.exec('DROP TRIGGER fail_terminal_commit');
    h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('later-direct-answer', 'later-direct-answer-client', started.childSessionId, 'assistant', 'Unrelated direct answer.', 40000);
    h.sqlite!.prepare('UPDATE sessions SET active_turn_started_at = 30000, last_turn_ended_at = 40000 WHERE id = ?').run(started.childSessionId);
    beforeRestart.dispose();

    h.sqlite!.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(sessionStatus, started.childSessionId);
    const afterRestart = createDelegationRuntime({ startTime });
    try {
      await afterRestart.delegation.restore();
      expect(h.sqlite!.prepare('SELECT status FROM sessions WHERE id = ?').pluck().get(started.childSessionId)).toBe(sessionStatus);
      expect(afterRestart.started.some(turn => turn.sessionId === started.childSessionId)).toBe(false);
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

  it('leaves an unverified restart result unresolved instead of adopting a later direct turn', async () => {
    await seedPair();
    const before = createDelegationRuntime({ readSessionExecution: () => ({ instanceId: 'old-native', generation: 1 }) });
    const task = await before.delegation.startSessionTask({ callerSessionId: 'session-1', objective: 'Lost original callback.' });
    if (!task.ok) throw new Error('missing task');
    h.sqlite!.prepare('INSERT INTO messages (id, client_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('unrelated-result', 'unrelated-result-client', task.childSessionId, 'assistant', 'Direct turn answer.', 40000);
    h.sqlite!.prepare('UPDATE sessions SET active_turn_started_at = 30000, last_turn_ended_at = 40000 WHERE id = ?').run(task.childSessionId);
    before.dispose();
    const after = createDelegationRuntime();
    try {
      await after.delegation.restore();
      expect(h.sqlite!.prepare('SELECT status, result_summary FROM bot_delegations WHERE id = ?').get(task.delegationId))
        .toEqual({ status: 'running', result_summary: null });
      expect(after.started).toHaveLength(0);
    } finally { after.dispose(); }
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
      expect(h.sqlite!.prepare('SELECT COUNT(*) AS n FROM messages WHERE client_id = ?')
        .get(`bot-delegation-result:${started.delegationId}:1`)).toEqual({ n: 1 });
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

  it('lets the requesting teammate choose a configured route only after execution ends', async () => {
    await seedPair();
    const current = { agentKind: 'codex' as const, model: 'same-model', providerId: 'subscription', effort: null, fastMode: false };
    const next = { ...current, providerId: 'paid' };
    const inspect = vi.fn(async () => ({ ok: true as const, generation: 7, current, next }));
    const advance = vi.fn(async () => ({ ok: true as const, status: 'applied' as const, generation: 8 }));
    const runtime = createDelegationRuntime({ taskRoute: { inspect, advance } });
    try {
      const started = await runtime.delegation.startSessionTask({
        callerSessionId: 'session-1', objective: '尝试当前已配置的路线。',
      });
      if (!started.ok) throw new Error('Session task did not start');
      await expect(runtime.delegation.advanceSessionTaskRoute('session-1', started.delegationId, 7, 'old'))
        .resolves.toMatchObject({ ok: false, errorCode: 'TASK_ACTIVE' });
      expect(advance).not.toHaveBeenCalled();
      await runtime.delegation.settleSession({ childSessionId: started.childSessionId, outcome: 'error', error: 'Quota exhausted' });
      const turnsBeforeSwitch = runtime.started.length;
      const preview = await runtime.delegation.inspectSessionTaskRoute('session-1', started.delegationId);
      expect(preview).toMatchObject({ ok: true, current: { providerId: 'subscription' }, next: { providerId: 'paid' } });
      if (!preview.ok) throw new Error('Expected route preview');
      await expect(runtime.delegation.advanceSessionTaskRoute('session-1', started.delegationId, 6, preview.selectionToken!))
        .resolves.toMatchObject({ ok: false, errorCode: 'CONFLICT' });
      await expect(runtime.delegation.advanceSessionTaskRoute('session-1', started.delegationId, 7, 'old'))
        .resolves.toMatchObject({ ok: false, errorCode: 'CONFLICT' });
      await expect(runtime.delegation.advanceSessionTaskRoute('session-1', started.delegationId, 7, preview.selectionToken!))
        .resolves.toMatchObject({ ok: true, status: 'applied', generation: 8 });
      expect(advance).toHaveBeenCalledWith(started.childSessionId, 7, next);
      expect(runtime.started).toHaveLength(turnsBeforeSwitch); // Switching never replays the task.
      await expect(runtime.delegation.advanceSessionTaskRoute('unowned-session', started.delegationId, 7, preview.selectionToken!))
        .resolves.toMatchObject({ ok: false, errorCode: 'NOT_A_BOT_SESSION' });
      h.sqlite!.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(started.childSessionId);
      await expect(runtime.delegation.inspectSessionTaskRoute('session-1', started.delegationId))
        .resolves.toMatchObject({ ok: false, errorCode: 'CHILD_SESSION_INVALID' });
      expect(inspect).toHaveBeenCalledTimes(4); // No new candidate is shown for an archived child.
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

  it('saves only its own explicit model chain, applies it through the send resolver, and resets to the live default', async () => {
    const { service, sessionId, id } = await setupModelControl();
    await invoke('local-db:bots:create', { id: 'bot-2', name: 'Other teammate', avatar: '🐈' });
    const before = await invoke('local-db:bots:get', 'bot-1');
    const other = await invoke('local-db:bots:get', 'bot-2');
    const appDefault = getSelectedNewMakerRoute(h.ownerScopeKey);
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
    expect(await modelSettings.readEffectiveBotModelChain(restored.capabilities)).toEqual([appDefault]);
    const nextDefault = { ...appDefault!, effort: 'low' };
    setNewMakerDraftCache({ selectedRoute: nextDefault, lastByVendor: {}, effortByModel: {}, fastModeByModel: {} }, h.ownerScopeKey);
    expect(await modelSettings.readEffectiveBotModelChain(restored.capabilities)).toEqual([nextDefault]);
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
