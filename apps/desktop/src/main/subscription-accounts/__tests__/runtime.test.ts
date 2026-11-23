import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SubscriptionAccountCommand,
  SubscriptionPoolConfig,
  SubscriptionProvider,
} from '../../../shared/subscriptionAccounts.js';
import { parseSubscriptionSessionAccountView } from '../../../shared/subscriptionAccounts.js';
import {
  NATIVE_SUBSCRIPTION_ACCOUNT,
  Session,
  AgentStartupStoppedError,
  AgentStartupCleanupPendingError,
  AgentNotAuthenticatedError,
  type AgentEvent,
  type BaseAgent,
  type AgentSessionHandle,
  type StartSessionOptions,
  type ForkSdkSessionOptions,
  type Logger,
} from '@cindy/maker-core';
const h = vi.hoisted(() => ({
  afterPoolWrite: undefined as (() => void) | undefined,
  owner: 'owner-a:1',
  pools: {} as Partial<Record<SubscriptionProvider, SubscriptionPoolConfig>>,
  bindings: new Map<string, { providerId: SubscriptionProvider; accountId: string; via?: string }>(),
  read: vi.fn(),
  rpc: vi.fn(),
  tokens: vi.fn(),
  usage: vi.fn(),
  modelCacheRead: vi.fn(),
  savedModelFiles: new Map<string, string>(),
  ownerBoundaryPending: false,
  onSnapshotStage: undefined as (() => void) | undefined,
  rejectSnapshotRename: false,
  directoryEntries: vi.fn(),
  login: vi.fn(),
  bound: true,
  shared: true,
  legacyRead: vi.fn(),
  legacyLogin: vi.fn(),
  importedRead: vi.fn(),
  importedLogin: vi.fn(),
  accountAllowed: vi.fn(),
  routeAllowed: vi.fn(),
  setLegacyPaused: vi.fn(),
  remote: vi.fn(),
  cooling: {} as Record<string, Record<string, Record<string, number>>>,
  writeCooling: vi.fn<(cooling: Record<string, Record<string, Record<string, number>>>) => Promise<undefined>>(async () => undefined),
  clearCooling: vi.fn<(provider: string, accountId: string) => Promise<undefined>>(async () => undefined),
  /** `${kind}:${accountId}` -> provider the account belongs to (placement.ts); absent = built-in. */
  placement: {} as Record<string, string>,
  /** Providers Cindy created for subscription accounts (placement.ts), by provider id. */
  created: {} as Record<string, { kind: 'openai' | 'anthropic'; name: string; account: string }>,
  strategies: {} as Record<string, string>,
  copyOverrides: vi.fn(),
  storedUsage: new Map<string, object | null>(),
}));
// Persisted placement is replaced like the pool file; its own rules are covered in ipc.test.ts.
vi.mock('../placement.js', () => {
  type Kind = 'openai' | 'anthropic';
  const owner = (kind: string, id: string) => h.placement[`${kind}:${id}`] ?? kind;
  const legacyAccount = (providerId: string) => h.pools.openai?.legacyCodexAccounts?.[providerId];
  const providerAccounts = <T extends { id: string }>(kind: string, accounts: readonly T[], providerId = kind) =>
    accounts.filter((a) => owner(kind, a.id) === providerId);
  const resolveSubscriptionPoolProvider = (providerId: string | null | undefined) => {
    if (providerId === 'openai' || providerId === 'anthropic') return { kind: providerId as Kind, providerId, ownAccount: 'default' };
    const created = providerId ? h.created[providerId] : undefined;
    if (providerId && created) return { kind: created.kind, providerId, ownAccount: created.account, created: true as const };
    const legacy = providerId ? legacyAccount(providerId) : undefined;
    return providerId && legacy ? { kind: 'openai' as const, providerId, ownAccount: legacy } : null;
  };
  const pinnedOwnAccount = (ref: { kind: Kind; providerId: string; ownAccount?: string }) =>
    ref.ownAccount && providerAccounts(ref.kind, h.pools[ref.kind]?.accounts ?? [], ref.providerId).length === 0
      && h.pools[ref.kind]?.accounts.some((a) => a.id === ref.ownAccount)
      ? ref.ownAccount : undefined;
  const place = (kind: string, accountId: string, providerId: string) => {
    h.placement[`${kind}:${accountId}`] = providerId;
  };
  return {
    accountProviderId: owner,
    providerAccounts,
    accountSiblings: <T extends { id: string }>(kind: string, accounts: readonly T[], accountId: string) =>
      accounts.filter((a) => owner(kind, a.id) === owner(kind, accountId)),
    readMergedLegacyCodexAccountId: (providerId: string) => {
      const accountId = legacyAccount(providerId);
      return accountId && owner('openai', accountId) !== providerId ? accountId : undefined;
    },
    resolveSubscriptionPoolProvider,
    pinnedOwnAccount,
    readMergedProviderAccount: (providerId: string) => {
      const ref = resolveSubscriptionPoolProvider(providerId);
      return ref ? pinnedOwnAccount(ref) : undefined;
    },
    accountOwnProvider: (kind: string, accountId: string) => {
      const created = Object.entries(h.created).find(([, entry]) => entry.kind === kind && entry.account === accountId);
      if (created) return created[0];
      if (accountId === 'default') return kind;
      const legacy = Object.entries(h.pools.openai?.legacyCodexAccounts ?? {}).find(([, id]) => id === accountId);
      return kind === 'openai' ? legacy?.[0] : undefined;
    },
    placeSubscriptionAccount: async (kind: string, accountId: string | readonly string[], providerId: string) => {
      for (const id of typeof accountId === 'string' ? [accountId] : accountId) place(kind, id, providerId);
    },
    discardUnusedSubscriptionAccountPlacement: async (kind: string, id: string) => { delete h.placement[`${kind}:${id}`]; },
    createSubscriptionProvider: async (kind: Kind, accountId: string, name: string, createId: () => string, prepare?: (id: string) => void, additionalAccountIds: readonly string[] = []) => {
      const providerId = `${kind}-sub-${createId()}`;
      prepare?.(providerId);
      h.created[providerId] = { kind, name, account: accountId };
      place(kind, accountId, providerId);
      for (const id of additionalAccountIds) place(kind, id, providerId);
      return providerId;
    },
    deleteCreatedSubscriptionProvider: async (providerId: string) => {
      delete h.created[providerId];
      for (const [key, id] of Object.entries(h.placement)) if (id === providerId) delete h.placement[key];
    },
    renameCreatedSubscriptionProvider: async (providerId: string, name: string) => {
      if (h.created[providerId]) h.created[providerId] = { ...h.created[providerId], name };
    },
    readProviderStrategy: (providerId: string) => h.strategies[providerId],
    writeProviderStrategy: async (providerId: string, strategy: string) => { h.strategies[providerId] = strategy; },
  };
});
vi.mock('../../provider-group/coolingStore.js', () => ({
  readProviderGroupCooling: () => ({}),
  writeProviderGroupCooling: async () => undefined,
  readSubscriptionAccountCooling: () => h.cooling,
  writeSubscriptionAccountCooling: h.writeCooling,
  clearSubscriptionAccountCooling: h.clearCooling,
}));
vi.mock('../../device-link/index.js', () => ({ remoteBackgroundInvoke: h.remote }));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => [h.owner, ...parts].join('/'),
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => h.ownerBoundaryPending,
}));
vi.mock('../../maker-host/nativeProviderAuthBinding.js', () => ({
  bindNativeProviderAuth: vi.fn(() => { h.bound = true; h.shared = true; }),
  isNativeProviderAuthBound: () => h.bound,
  isNativeProviderAuthSharedSystemCredential: () => h.bound && h.shared,
}));
vi.mock('../nativeCli.js', () => ({
  readNativeAccount: h.read,
  codexAccountRpc: h.rpc,
  readNativeCodexTokens: h.tokens,
  readNativeAccountUsage: h.usage,
  loginNativeAccount: h.login,
  readLegacyCodexAccount: h.legacyRead,
  loginLegacyCodexAccount: h.legacyLogin,
  readLegacyCodexProviderAccount: h.importedRead,
  loginLegacyCodexProviderAccount: h.importedLogin,
}));
vi.mock('../../maker-host/codex-home-path.js', () => ({
  getCodexHome: () => '/existing-cindy/codex-home',
}));
vi.mock('../../maker-host/model-disable-store.js', () => ({ copyProviderDisableOverrides: h.copyOverrides }));
vi.mock('../../usage/accountUsageStorage.js', () => ({
  readStoredAccountUsage: async (kind: string, id: string) => structuredClone(h.storedUsage.get(`${kind}:${id}`) ?? null),
  writeStoredAccountUsage: async (kind: string, id: string, value: object | null, current = () => true) => {
    if (current()) h.storedUsage.set(`${kind}:${id}`, structuredClone(value));
  },
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  readFile: async (file: string) => {
    if (!file.includes('/model-discovery/')) return h.modelCacheRead(file, 'utf8');
    const saved = h.savedModelFiles.get(file);
    if (saved === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return saved;
  },
  readdir: h.directoryEntries,
  writeFile: async (file: string, body: string) => {
    h.savedModelFiles.set(file, body);
    h.onSnapshotStage?.();
  },
  rename: async (source: string, destination: string) => {
    if (h.rejectSnapshotRename) throw Object.assign(new Error('locked snapshot'), { code: 'EACCES' });
    const staged = h.savedModelFiles.get(source);
    if (staged === undefined) throw new Error('missing staged snapshot');
    h.savedModelFiles.set(destination, staged);
    h.savedModelFiles.delete(source);
  },
  rm: async (file: string) => { h.savedModelFiles.delete(file); },
  default: { mkdir: vi.fn(), writeFile: vi.fn(), rename: vi.fn(), rm: vi.fn(), readdir: h.directoryEntries,
    readFile: h.modelCacheRead, stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
}));
// The host production dispatcher runs in memory; no listener or personal files.
vi.mock('../../remote-agent/host/tunnel.js', () => ({ createRunTunnel: async () => ({
  baseUrl: 'http://tunnel.invalid', token: 'synthetic-token', close: async () => {},
}) }));
vi.mock('../legacyAccountAccess.js', () => ({
  legacyCodexAccountCanRun: h.accountAllowed,
  openAiRouteAllowsModel: h.routeAllowed,
  subscriptionRouteAllowsModel: (_provider: string, model: string, options: unknown) => h.routeAllowed(model, options),
  setLegacyCodexAccountPaused: h.setLegacyPaused,
}));
vi.mock('../store.js', () => ({
  readPool: (p: SubscriptionProvider) => h.pools[p] ?? null,
  readLegacyCodexAccountId: (id: string) => h.pools.openai?.legacyCodexAccounts?.[id],
  readLegacyCodexProviderId: (account: string) => Object.entries(h.pools.openai?.legacyCodexAccounts ?? {})
    .find(([, id]) => id === account)?.[0],
  defaultPool: () => ({
    strategy: 'least',
    accounts: [{ id: 'default', paused: false, limit: 4, weight: 1 }],
  }),
  accountDirectory: (p: string, id: string) => [p, id].join('/'),
  accountOwnerPrefix: () => h.owner.replaceAll(':', '-'),
  readAccountBinding: (key: string) => h.bindings.get(key),
  readProviderBoundAccountIds: (kind: string, providerId: string) => new Set([...h.bindings.values()]
    .filter(binding => binding.providerId === kind && (binding.via ?? kind) === providerId).map(binding => binding.accountId)),
  readBoundSubscriptionAccountIds: (kind: string) => new Set([...h.bindings.values()]
    .filter(binding => binding.providerId === kind).map(binding => binding.accountId)),
  writeAccountBindings: async (
    keys: string[],
    providerId: SubscriptionProvider,
    accountId: string,
    via?: string,
  ) => {
    for (const key of keys) h.bindings.set(key, { providerId, accountId, ...(via && via !== providerId ? { via } : {}) });
  },
  updatePool: async (
    p: SubscriptionProvider,
    edit: (value: SubscriptionPoolConfig) => SubscriptionPoolConfig,
  ) => {
    h.pools[p] = edit(
      h.pools[p] ?? {
        strategy: 'least',
        accounts: [{ id: 'default', paused: false, limit: 4, weight: 1 }],
      },
    );
    h.afterPoolWrite?.();
  },
}));
import {
  acquireSubscriptionAccount,
  hasUnavailableSubscriptionPoolAccount,
  isSubscriptionPoolReadUnreachable,
  needsSubscriptionAccountHandoff as probeSubscriptionAccountHandoff,
  readSubscriptionPool,
  readSubscriptionUsage,
  refreshSubscriptionPool,
  refreshSubscriptionPoolCodexModels,
  refreshSubscriptionPoolClaudeModels,
  readSubscriptionPoolClaudeModels,
  setSubscriptionPoolClaudeModelProbe,
  onSubscriptionPoolCodexModelsChanged,
  onSubscriptionPoolClaudeModelsChanged,
  onSubscriptionAccountsChanged,
  readSubscriptionPoolCodexModels,
  resetDefaultSubscriptionCodexDiscovery,
  resetDefaultSubscriptionClaudeDiscovery,
  readSubscriptionAccountBlocked,
  disconnectSubscriptionPool,
  readSubscriptionPoolUsage,
  readSubscriptionPoolModelAvailability,
  readSubscriptionPoolScheduling,
  readLegacySubscriptionPoolUsage,
  readSubscriptionSessionUsage,
  readSubscriptionSessionAccount,
  canSwitchHostedSubscriptionAccount,
  readSubscriptionPoolAccountUsages,
  runSubscriptionAccountCommand,
  hasConnectedSubscriptionPool,
  hasCreatedOpenAiImageAuth,
  lastConfirmedSubscriptionModelsAt,
  subscriptionProviderAccountKeys,
  observeSubscriptionAccountUsage,
  pooledCodexResetTarget,
  refreshCodexSubscriptionAccountAfterReset,
  hasRestoredPooledCodexQuota,
} from '../runtime.js';
import { AccountServiceUnreachableError } from '../accountServiceError.js';
import { createCodexRateLimitResetService } from '../../usage/codexRateLimitReset.js';
import { CodexResetAutoUse, DEFAULT_CODEX_RESET_AUTO_USE } from '../../usage/codexResetAutoUse.js';
import { providerGroupMemberUsageState, providerGroupCodexUsageFromReads, providerGroupUsageSnapshot } from '../../provider-group/usage.js';
import { readLegacySubscriptionQuota } from '../legacyQuota.js';
import { withSubscriptionAccounts } from '../agent.js';
import { getSessionSubscriptionAccount, registerSessionSubscriptionAccount } from '../session.js';
import { prepareSubscriptionAccountForSend } from '../prepareSend.js';
import { getActiveCatalogWithCodexModels } from '../../maker-host/active-catalog.js';
import { refreshCatalogDerivedModels } from '../../maker-host/catalog-to-descriptors.js';
import type { SessionRowSnapshot } from '../../localDb/sessionDispatchSnapshot.js';
import { canSwitchSubscriptionAccount, prepareSubscriptionAccountFailover, readSubscriptionAccountSwitch } from '../failover.js';
import { UsageLimitAutoResume, USAGE_LIMIT_RESUME_BUFFER_MS } from '../../maker-ipc/usageLimitAutoResume.js';
import { createProviderGroupDirectory } from '../../provider-group/directory.js';
import { createProviderGroupRouter, type ProviderGroupPersistedCooling } from '../../provider-group/router.js';
import { createProviderGroupService, type ProviderGroupSessionRow } from '../../provider-group/service.js';
import type { ProviderGroupBinding } from '../../provider-group/bindings.js';
import { normalizeProviderGroupConfig } from '../../../shared/providerGroup.js';
import { createRemoteAgentHost, GROUP_SWITCH_TOKEN_TTL_MS } from '../../remote-agent/host/runHost.js';
import { RemoteAgentPoller, RemoteAgentRunClient } from '../../remote-agent/controller/runClient.js';
import { startRemoteAgentSession, takeGroupSwitchState } from '../../remote-agent/controller/startRemote.js';
import { createInputEnqueueHarness } from '../../maker-ipc/__tests__/inputEnqueueHarness.js';
import { MAKER_INVOKE } from '../../maker-ipc/channels.js';
import type { IpcHandler } from '../../maker-ipc/ipcHandlerRegistry.js';
import { registerMakerSessionSendHandler } from '../../maker-ipc/sessionSendHandler.js';
import { registerStopSessionBackgroundTasksHandler } from '../../maker-ipc/stopSessionBackgroundTasksHandler.js';
import { registerSharedAccountStopAll, sharedAccountHandoffProbe, sharedAccountRegisterWiring, sharedAccountSendTransaction } from '../../remote-agent/__tests__/poolHarness.js';
import { createContextOverflowRollover } from '../../maker-ipc/contextOverflowRollover.js';
import { acceptSessionRuntimeMutation, applySessionRuntimeOverrideForStart, clearAllSessionRuntimeControlStates } from '../../maker-ipc/sessionRuntimeControl.js';
import { AgentInputCoordinator, type AgentInputCoordinatorDeps } from '../../maker-ipc/agent-input-coordinator.js';
import { providerGroupSwitchCause } from '../../provider-group/failurePolicy.js';
import { providerShareGuestPeer } from '@cindy/device-link';
import type { RemoteAgentOpenPayload } from '../../remote-agent/wire.js';
import { createProviderGroupGuestSwitch } from '../../provider-group/guestSwitch.js';
import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  registerMakerSessionAgentSwitchHandler,
  relocateForFreshStart,
  type AgentSwitchSessionRow,
  type MakerSessionAgentSwitchHandlerDeps,
} from '../../maker-ipc/sessionAgentSwitchHandler.js';
import { prependHandoffToUserMessage } from '../../maker-ipc/agentHandoff.js';
import { hostSessionIdFor } from '../../remote-agent/host/sessionIdentity.js';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';
import { resolveSubscriptionPoolProvider } from '../placement.js';
import { createAccountCodexImageChannel, createCodexImageAuthAcquirer, setCodexImageAuthBinding } from '../../cindy-brain/codexImageAuthBinding.js';
import { subscriptionPoolSources } from '../../menubar/collect.js';
import { setAnthropicModelProbe, refreshAnthropicModelsFromProbe, syncAnthropicModelsWithClaudeLogin } from '../../maker-host/model-discovery/anthropic.js';
const account = (id: string) => ({ id, paused: false, limit: 1, weight: 1 });
let generation = 0;
beforeEach(() => {
  h.afterPoolWrite = undefined;
  h.owner = 'owner-a:' + ++generation;
  h.bound = true;
  h.shared = true;
  h.pools = { anthropic: { strategy: 'least', accounts: [account('default'), account('second')] } };
  h.bindings.clear();
  h.read.mockReset().mockResolvedValue({ authenticated: true, identity: 'account' });
  // Existing quota/lease tests assume these fixture models are offered by both
  // native profiles; membership-specific tests override this control response.
  h.rpc.mockReset().mockImplementation(async (_directory: string, method: string) => method === 'model/list'
    ? { data: ['gpt-6', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.3-codex-spark', 'gpt-model',
      'special-model', 'model-a', 'model-b', 'shared-model', 'claude-model'].map(id => ({ id })), nextCursor: null }
    : undefined);
  h.tokens.mockReset().mockImplementation(async (directory: string) => ({
    chatgptAccountId: directory, canDispatch: () => true,
  }));
  h.usage.mockReset().mockResolvedValue({});
  h.savedModelFiles.clear();
  h.ownerBoundaryPending = false;
  h.onSnapshotStage = undefined;
  h.rejectSnapshotRename = false;
  h.modelCacheRead.mockReset().mockRejectedValue(new Error('no account cache'));
  h.directoryEntries.mockReset().mockResolvedValue([]);
  h.login.mockReset().mockResolvedValue(undefined);
  h.legacyRead.mockReset().mockResolvedValue({
    authenticated: true,
    identity: 'original@example.com',
    authSource: 'oauth',
  });
  h.legacyLogin.mockReset().mockResolvedValue(undefined);
  h.importedRead.mockReset().mockResolvedValue({ authenticated: true, identity: 'imported@example.test' });
  h.importedLogin.mockReset().mockResolvedValue(undefined);
  h.accountAllowed.mockReset().mockReturnValue(true);
  h.routeAllowed.mockReset().mockReturnValue(true);
  h.setLegacyPaused.mockReset();
  h.remote.mockReset();
  h.cooling = {};
  h.writeCooling.mockReset().mockResolvedValue(undefined);
  h.clearCooling.mockReset().mockResolvedValue(undefined);
  h.placement = {};
  h.created = {};
  h.strategies = {};
  h.copyOverrides.mockReset();
  h.storedUsage.clear();
});

// #11322 / unit: Desktop's actual handoff callback → prepare → send transaction →
// coordinator dispatch → subscription-wrapped native start. Existing placement tests
// supplied B directly and missed the saved-A / accepted-B split. Minimal input:
// task/native bound to A, saved A, accepted B. Only IO and the native engine are fake.
describe('accepted subscription route handoff before queued dispatch', () => {
  it.each(['executor', null])('keeps the remote-group source when execution is on %s', async agentDeviceId => {
    const id = 'remote-assignment';
    clearAllSessionRuntimeControlStates();
    try {
      acceptSessionRuntimeMutation({ sessionId: id, source: 'fallback', deferred: false, profile: {
        agentKind: 'claude-code', agentDeviceId, providerId: 'controller-provider',
        model: 'claude-model', effort: null, fastMode: false,
      } });
      const probe = vi.fn(async () => false);
      const row = { status: 'active', agentKind: 'cc', agentDeviceId, remoteHostId: null,
        providerId: 'assigned-provider', model: 'claude-model', sdkSessionId: 'remote-native', clearedAt: null };
      await sharedAccountHandoffProbe(probe, 'group-owner')(id, row);
      expect(probe).toHaveBeenCalledWith(id, expect.objectContaining(row), expect.any(Function));
    } finally { clearAllSessionRuntimeControlStates(); }
  });
  it.each(['agent', 'fallback', 'unchanged', 'deferred', 'unavailable', 'cancelled', 'owner-changed'] as const)(
    'preserves native ownership and dispatches the queue head once (%s)', async mode => {
      const id = 'accepted-route';
      clearAllSessionRuntimeControlStates();
      h.pools.anthropic = { strategy: 'order', accounts: [account('default'), account('second')] };
      await runSubscriptionAccountCommand({ action: 'place', providerId: 'anthropic', accountId: 'second', target: null });
      const target = Object.keys(h.created)[0]!;
      const old = await acquireSubscriptionAccount('anthropic', 'claude-model', [`task:${id}`]);
      await old!.bind([`task:${id}`, 'native:old-native']);
      old!.release();
      const row = { id, status: 'active', source: 'desktop', agentKind: 'cc', providerId: 'anthropic',
        model: 'claude-model', sdkSessionId: 'old-native' as string | null, clearedAt: null, remoteHostId: null,
        agentDeviceId: null, contextTokens: 10, contextWindow: 200_000, workingDir: '/synthetic/work' };
      const profile = { agentKind: 'claude-code' as const, providerId: target, model: row.model, effort: null, fastMode: false };
      if (mode !== 'unchanged') acceptSessionRuntimeMutation({ sessionId: id,
        source: mode === 'agent' ? 'agent' : 'fallback', profile, deferred: mode === 'deferred' });
      if (mode === 'unavailable') h.pools.anthropic.accounts[1]!.paused = true;
      let handoff: string | null = null;
      let live: Session | undefined;
      let endEvents!: () => void;
      const eventsEnded = new Promise<void>(resolve => { endEvents = resolve; });
      const sent = vi.fn(async () => {});
      const nativeStart = vi.fn<BaseAgent['startSession']>(async () => ({ id: 'new-native',
        send: sent, close: async () => { endEvents(); }, abort: async () => {}, events: async function* () { await eventsEnded; },
        setInteractionResolver() {},
      } as unknown as AgentSessionHandle));
      const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: nativeStart } as unknown as BaseAgent);
      const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return logger; } };
      const commits = vi.fn(async (_id: string, _handoff: string) => { row.sdkSessionId = null; });
      const rollover = createContextOverflowRollover({
        getSessionRow: async () => ({ ...row }),
        needsNativeSessionHandoff: sharedAccountHandoffProbe((taskId, state) => {
          const result = probeSubscriptionAccountHandoff(taskId, state);
          if (mode === 'owner-changed') {
            h.owner = 'next-owner';
            clearAllSessionRuntimeControlStates();
          }
          return result;
        }),
        listMessages: async () => {
          if (mode === 'cancelled') rollover.cancelRecovery(id);
          return [{ role: 'user', content: 'Remember prior work', clientId: 'prior-user', createdAt: 1 },
            { role: 'assistant', content: 'Step one completed', clientId: 'prior-reply', createdAt: 2 }];
        },
        findLatestRebuildMeta: async () => null, getLiveSession: () => live,
        closeSession: async () => { await live?.close(); live = undefined; },
        drainPersistQueue: async () => {}, commitRebuild: commits,
        setPendingHandoff: (_id, text) => { handoff = text; },
        replayUserMessage: async () => { throw new Error('Pre-send handoff must not replay'); },
        withCloseSuppressed: (_id, run) => run(), log: { info() {}, warn() {} },
      });
      const persisted = vi.fn(async () => {});
      const wiring = sharedAccountRegisterWiring({
        getSessionRowSnapshotStrict: async () => row,
        setSdkSessionId: nativeId => { row.sdkSessionId = nativeId; },
        applySessionRuntimeOverrideForStart,
        admitLocalSessionRoute: async () => {},
        createSessionWithRuntimePlugins: async (opts: StartSessionOptions) => {
          const handle = await agent.startSession({ ...opts, sessionId: id });
          return live = new Session({ id, agentKind: 'claude-code', permissionMode: 'bypassPermissions',
            workDir: row.workingDir, handle, capabilities: {} as never,
            logger });
        },
      });
      const transaction = sharedAccountSendTransaction({ ...wiring,
        getSession: () => live, prepareUnhealthySession: taskId => rollover.prepareUnhealthySession(taskId),
        readScheduledPermissions: async () => ({ permissionMode: 'bypassPermissions', planModeEnabled: false }),
        peekPendingHandoff: async () => handoff, consumePendingHandoff: () => { handoff = null; },
        createDbMessage: persisted, reconcileCreateOptsWithDb: async (_id, opts) => {
          opts.providerId = row.providerId; opts.resumeSessionId = row.sdkSessionId ?? undefined;
        },
      });
      const send = vi.fn<AgentInputCoordinatorDeps['sendToAgent']>(async (...args) => (await transaction.sendToAgentAccepted(...args)).outcome);
      const coordinator = new AgentInputCoordinator({ sendToAgent: send, steerToAgent: async () => {},
        abortSession: async () => {}, touchUserSend: async () => {},
        createUserMessage: async () => { throw new Error('The send transaction owns user persistence'); },
        isTurnRunning: () => live?.isTurnRunning() ?? false, hasPendingInteraction: () => false,
        getAgentKind: () => 'claude-code', getSdkSessionId: async () => live?.sdkSessionId,
        getTurnGeneration: () => live?.getTurnGeneration() ?? null, getTurnSessionIdentity: () => live ?? null,
        emitProjection() {},
      });
      try {
        const text = 'Continue remaining work';
        coordinator.enqueue(id, { clientId: 'head-once', text, persistedContent: text,
          model: row.model, effort: 'medium', workingDir: row.workingDir, permissionMode: 'bypassPermissions',
          createOpts: { agentKind: 'claude-code', model: row.model, providerId: row.providerId,
            workingDir: row.workingDir, permissionMode: 'bypassPermissions' },
          chatMessage: { clientId: 'head-once', role: 'user', content: text, isStreaming: false, createdAt: new Date().toISOString() },
        }, { manualUiSend: true });
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        const outcome = await send.mock.results[0]!.value.catch((error: Error) => error);
        if (['unavailable', 'cancelled', 'owner-changed'].includes(mode)) {
          expect(outcome).toBeInstanceOf(Error);
          expect((outcome as Error).message).toMatch(mode === 'unavailable' ? /No subscription account/
            : mode === 'cancelled' ? /aborted/ : /owner changed/);
          expect(nativeStart).not.toHaveBeenCalled();
          expect(commits).not.toHaveBeenCalled();
          expect(sent).not.toHaveBeenCalled();
          expect(coordinator.getProjection(id).pendingQueue.map(item => item.clientId)).toEqual(['head-once']);
          if (mode === 'unavailable') {
            h.pools.anthropic.accounts[1]!.paused = false;
            await coordinator.retryLastError(id);
            await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
            await send.mock.results[1]!.value;
            expect(nativeStart).toHaveBeenCalledOnce();
            expect(nativeStart.mock.calls[0]![0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/second');
            expect(nativeStart.mock.calls[0]![0].resumeSessionId).toBeUndefined();
            expect(commits).toHaveBeenCalledOnce();
            expect(sent).toHaveBeenCalledOnce();
            expect(persisted).toHaveBeenCalledOnce();
            expect(persisted.mock.calls[0]).toEqual(expect.arrayContaining([
              id, expect.objectContaining({ clientId: 'head-once' }),
            ]));
            expect(coordinator.getProjection(id).pendingQueue).toEqual([]);
          }
        } else {
          expect(nativeStart, JSON.stringify(outcome)).toHaveBeenCalledOnce();
          const switched = mode === 'agent' || mode === 'fallback';
          expect(commits).toHaveBeenCalledTimes(switched ? 1 : 0);
          expect(nativeStart.mock.calls[0]![0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir)
            .toBe(switched ? 'anthropic/second' : 'anthropic/default');
          expect(nativeStart.mock.calls[0]![0].resumeSessionId).toBe(switched ? undefined : 'old-native');
          expect(sent, JSON.stringify(outcome)).toHaveBeenCalledOnce();
          expect(JSON.stringify(sent.mock.calls)).toContain(text);
          if (switched) expect(JSON.stringify(sent.mock.calls)).toContain('Step one completed');
          expect(persisted).toHaveBeenCalledOnce();
          expect(persisted.mock.calls[0]).toEqual(expect.arrayContaining([
            id, expect.objectContaining({ clientId: 'head-once' }),
          ]));
          expect(coordinator.getProjection(id).pendingQueue).toEqual([]);
          expect(h.bindings.get('native:new-native')?.accountId).toBe(switched ? 'second' : 'default');
        }
        expect(row.providerId).toBe('anthropic');
        expect(h.bindings.get('native:old-native')?.accountId).toBe('default');
      } finally {
        endEvents();
        await live?.close();
        clearAllSessionRuntimeControlStates();
      }
    });
});

// Unit regression 2026-11-16: real router → host.handle(open) → account acquire,
// synthetic CLI/auth/storage/tunnel only. Previous layer-local tests could not
// detect the 4+0 vs 3 aggregation error. Same physical/account budgets in both routes.
it('dispatches to the idle sibling through the real remote host rather than the busier single account', async () => {
  h.pools.anthropic!.accounts = ['default', 'second', 'third'].map(id => ({ ...account(id), limit: 16 }));
  h.created['anthropic-single'] = { kind: 'anthropic', name: 'Single', account: 'third' };
  h.placement['anthropic:third'] = 'anthropic-single';
  const held = await Promise.all([
    ...Array.from({ length: 4 }, (_, i) => acquireSubscriptionAccount('anthropic', 'claude-sonnet-5', [`a${i}`], false, { accountId: 'default' })),
    ...Array.from({ length: 3 }, (_, i) => acquireSubscriptionAccount('anthropic-single', 'claude-sonnet-5', [`b${i}`])),
  ]);
  const config = normalizeProviderGroupConfig({ members: [{ kind: 'local' },
    { kind: 'device', agentDeviceId: 'b', providerId: 'anthropic-single' }] }, 'anthropic')!;
  const views = (id: string) => [{ id, name: id, connected: true, agents: ['claude-code'],
    models: { 'claude-code': [{ id: 'claude-sonnet-5', name: 'Sonnet', efforts: [], defaultEffort: null }] },
    runningTurns: id === 'anthropic' ? 4 : 3, routing: { 'claude-code': {} },
  } as unknown as ProviderView];
  const directory = createProviderGroupDirectory({ listLocalProviders: async () => views('anthropic'),
    localDeviceName: () => 'A', localRunning: async () => 4,
    listDevices: async () => [{ deviceId: 'b', name: 'B', online: true, platform: 'darwin', appVersion: '1.0.0',
      lastSeenAt: null, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false }],
    readDeviceProviders: async () => views('anthropic-single'), listReceivedShares: () => [],
    isMobilePlatform: () => false, now: () => Date.now(),
  });
  const router = createProviderGroupRouter({ directory, readGroup: () => config,
    listBindings: () => ({}), isTurnRunning: () => false, now: () => Date.now(), random: () => 0,
    readPoolScheduling: (m, model, options) => readSubscriptionPoolScheduling(m.providerId, model, options),
  });
  let selected: string | undefined;
  const hosted: { lease: Awaited<ReturnType<typeof acquireSubscriptionAccount>> } = { lease: null };
  const host = createRemoteAgentHost({ isAgentAvailable: () => true, isControllerAuthorized: () => true,
    captureOwner: () => h.owner, isOwnerCurrent: owner => owner === h.owner, runsRoot: '/synthetic-host',
    startHosted: async input => {
      hosted.lease = await acquireSubscriptionAccount(input.options.providerId!, input.options.model, [], false, { remote: true, ownComputer: true });
      selected = hosted.lease?.accountId;
      return { id: 'native-synthetic', agentKind: input.kind, model: input.options.model,
        send: async () => {}, close: async () => { hosted.lease?.release(); }, abort: async () => {},
        events: async function* () {}, setInteractionResolver() {},
      } as unknown as AgentSessionHandle;
    },
  });
  try {
    const pick = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: 'claude-sonnet-5', localTask: true });
    expect(pick.kind).toBe('member');
    if (pick.kind !== 'member') return;
    await host.handle('controller', { op: 'open', runId: '11111111-1111-4111-8111-111111111111', agentKind: 'claude-code',
      payload: { json: { sessionId: 'new-task', options: { providerId: pick.member.providerId, model: 'claude-sonnet-5' },
        workspace: { workingDir: '/controller/work', platform: 'darwin', shell: 'bash' }, projectFiles: [], ancestorFiles: [],
        personal: { files: [] }, mcpServers: [] } } });
    await vi.waitFor(() => expect(selected).toBeDefined());
    expect(selected).toBe('second');
    hosted.lease?.release();
    for (const entry of held) entry?.release();
    config.strategy = 'round';
    h.pools.anthropic!.strategy = 'round';
    const counts: Record<string, number> = { default: 0, second: 0, third: 0 };
    for (let i = 0; i < 60; i++) {
      const pick = await router.pick({ providerId: 'anthropic', agentKind: 'claude-code', model: 'claude-sonnet-5', localTask: true });
      expect(pick.kind).toBe('member');
      if (pick.kind !== 'member') continue;
      const lease = await acquireSubscriptionAccount(pick.member.providerId, 'claude-sonnet-5', []);
      expect(lease).not.toBeNull();
      if (lease) { counts[lease.accountId]++; lease.release(); }
    }
    expect(counts).toEqual({ default: 20, second: 20, third: 20 });
  } finally {
    await host.dispose();
    hosted.lease?.release();
    for (const entry of held) entry?.release();
  }
});

// Unit: summaries must use production acquire admission, rather than quota preview
// eligibility (which intentionally ignores full/cooling accounts). The existing
// acquire tests did not observe the capacity used by an outer group.
it.each(['paused', 'removed', 'signed-out', 'unknown', 'exhausted', 'cooling', 'full', 'all-full'] as const)(
  'excludes %s accounts from scheduling without hiding their quota', async state => {
    const model = 'claude-sonnet-5';
    const held: Array<Awaited<ReturnType<typeof acquireSubscriptionAccount>>> = [];
    if (state === 'paused') h.pools.anthropic!.accounts[0].paused = true;
    if (state === 'removed') h.pools.anthropic!.accounts.shift();
    h.read.mockImplementation(async (_kind: string, dir: string) => {
      if (dir.endsWith('default') && state === 'unknown') throw Error('unavailable');
      return { authenticated: !(dir.endsWith('default') && state === 'signed-out'), identity: dir };
    });
    const now = Date.now();
    h.usage.mockImplementation(async (_kind: string, dir: string) => ({ claudeUsage: {
      updatedAt: now, fiveHour: { utilization: state === 'exhausted' && dir.endsWith('default') ? 100 : 10,
        resetsAt: now / 1000 + 3600 }, sevenDay: null, scoped: [],
    } }));
    if (state === 'cooling') h.cooling = { anthropic: { default: { 'claude:sonnet': now + 60_000 } } };
    if (state === 'full' || state === 'all-full') {
      held.push(await acquireSubscriptionAccount('anthropic', model, [], false, { accountId: 'default' }));
      if (state === 'all-full') held.push(await acquireSubscriptionAccount('anthropic', model, [], false, { accountId: 'second' }));
    }
    try {
      expect(await readSubscriptionPoolScheduling('anthropic', model)).toMatchObject({
        accounts: state === 'all-full' ? 0 : 1, running: 0, totalRunning: held.length, full: state === 'all-full',
      });
      if (state === 'full') expect((await readSubscriptionPoolUsage('anthropic'))?.claudeUsage?.fiveHour?.utilization).toBe(10);
      if (state !== 'all-full') {
        const next = await acquireSubscriptionAccount('anthropic', model, []);
        expect(next?.accountId).toBe('second');
        next?.release();
      }
    } finally { for (const lease of held) lease?.release(); }
  },
);

// Unit regression: admission must explain a model cooldown alongside a signed-out
// sibling, without exposing identities or applying the cooldown to other models.
it('explains an unbound task blocked by a model limit and a signed-out account', async () => {
  const until = Date.now() + 60_000;
  h.cooling = { anthropic: { default: { 'claude:fable': until } } };
  h.read.mockImplementation(async (_kind: string, dir: string) => ({
    authenticated: dir.endsWith('default'), identity: dir,
  }));
  await expect(acquireSubscriptionAccount('anthropic', 'claude-fable-5-2', []))
    .rejects.toThrow(new Error(`[SUBSCRIPTION_POOL_MODEL_LIMITED] Subscription usage limit for this model\nresetAtMs=${until}\notherAccountSignedOut=true`));
  const lease = await acquireSubscriptionAccount('anthropic', 'claude-opus-5-5', []);
  expect(lease?.accountId).toBe('default');
  lease?.release();
});

it('reads round capacity without advancing the account cursor or reserving a slot', async () => {
  h.pools.anthropic!.strategy = 'round';
  for (let i = 0; i < 2; i++) expect(await readSubscriptionPoolScheduling('anthropic', 'claude-sonnet-5'))
    .toMatchObject({ accounts: 2, running: 0, totalRunning: 0 });
  const first = await acquireSubscriptionAccount('anthropic', 'claude-sonnet-5', []);
  expect(first?.accountId).toBe('default');
  first?.release();
});

it.each(['full', 'cooling'] as const)('keeps %s account quota visible without using its urgency for new assignments', async state => {
  const now = Date.now();
  const model = 'claude-sonnet-5';
  h.usage.mockImplementation(async (_kind: string, dir: string) => ({ claudeUsage: {
    updatedAt: now, fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
    sevenDay: { utilization: dir.endsWith('default') ? 10 : 90, resetsAt: now / 1000 + 86400 }, scoped: [],
  } }));
  if (state === 'cooling') h.cooling = { anthropic: { default: { 'claude:sonnet': now + 60_000 } } };
  const held = state === 'full'
    ? await acquireSubscriptionAccount('anthropic', model, [], false, { accountId: 'default' }) : null;
  try {
    expect((await readSubscriptionPoolUsage('anthropic'))?.claudeUsage?.sevenDay?.utilization).toBe(10);
    const summary = await readSubscriptionPoolScheduling('anthropic', model);
    expect(summary).toMatchObject({ accounts: 1, running: 0 });
    expect(summary?.urgency).toBeLessThan(1);
  } finally { held?.release(); }
});

// Unit, 2026-11-16: the real pool reads/commands previously omitted secondary quota persistence
// and rejected removal of the CLI-origin account. Storage itself is covered with DbClients in
// accountUsageStorage.test.ts; these cases cover identity-checked restoration and task handoff.
it.each(['anthropic', 'openai'] as const)('persists and restores every %s account with its own plan metadata', async provider => {
  h.pools[provider] = { strategy: 'round', accounts: [account('default'), account('second')] };
  h.read.mockImplementation(async (_provider: string, directory: string) => ({
    authenticated: true, identity: directory, plan: provider === 'anthropic' ? 'max' : 'plus',
    ...(provider === 'anthropic' ? { planTier: 'max_20x', planDisplayName: 'Ultra' } : { planType: 'plus' }),
  }));
  h.usage.mockImplementation(async (_provider: string, directory: string) => {
    const used = directory.endsWith('second') ? 42 : 12;
    const updatedAt = Date.now();
    return provider === 'anthropic'
      ? { claudeUsage: { updatedAt, fiveHour: { utilization: used }, sevenDay: null, scoped: [] } }
      : { codexUsage: { appServerBuckets: { codex: { limitId: 'codex', limitName: null, updatedAt,
        primary: { usedPercent: used, resetsAt: null, windowMinutes: 300 }, secondary: null } }, webSnapshot: null } };
  });
  const initial = await readSubscriptionPool(provider);
  expect(h.storedUsage.has(`${provider}:default`)).toBe(true);
  expect(h.storedUsage.has(`${provider}:second`)).toBe(true);
  if (provider === 'anthropic') expect(h.storedUsage.get('anthropic:second')).toMatchObject({
    subscriptionType: 'max', planTier: 'max_20x', planDisplayName: 'Ultra',
  });
  h.owner += ':restart'; // discard runtime state, retain the simulated owner's database
  const authorized = h.read.getMockImplementation()!;
  h.read.mockRejectedValue(new Error('temporary authentication read failure'));
  expect((await readSubscriptionPool(provider)).accounts.every(a => a.usage === undefined)).toBe(true);
  h.read.mockImplementation(authorized);
  h.usage.mockRejectedValue(new Error('temporarily offline'));
  const restored = await refreshSubscriptionPool(provider, true);
  expect(restored.accounts.map(a => a.usage)).toEqual(initial.accounts.map(a => a.usage));
  expect(restored.accounts[1]).toMatchObject(provider === 'anthropic'
    ? { planTier: 'max_20x', planDisplayName: 'Ultra' } : { planType: 'plus' });
  h.owner += ':replacement';
  h.read.mockResolvedValue({ authenticated: true, identity: 'different-account' });
  expect((await readSubscriptionPool(provider)).accounts.every(a => a.usage === undefined)).toBe(true);
});

// Unit: a marketing-name change is independent of quota and machine tier. The
// next status read must update stored/displayed metadata even while quota is reused.
it.each(['Pro', undefined])('updates or clears the Claude display name without refreshing quota (%s)', async nextName => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const now = Date.now();
  try {
    h.pools.anthropic = { strategy: 'order', accounts: [account('second')] };
    let planDisplayName: string | undefined = 'Ultra';
    h.read.mockImplementation(async () => ({ authenticated: true, identity: 'same@example.test',
      plan: 'pro', planTier: 'pro', planDisplayName }));
    h.usage.mockResolvedValue({ claudeUsage: { source: 'oauth-endpoint', updatedAt: now,
      fiveHour: { utilization: 10 }, scoped: [] } });
    expect((await readSubscriptionPool('anthropic')).accounts[0]).toMatchObject({ planDisplayName: 'Ultra' });
    planDisplayName = nextName;
    vi.setSystemTime(now + 31_000);
    const view = (await readSubscriptionPool('anthropic')).accounts[0];
    expect(view.planDisplayName).toBe(nextName);
    expect(view.usage?.claude?.planDisplayName).toBe(nextName);
    expect(h.storedUsage.get('anthropic:second')).toMatchObject({ subscriptionType: 'pro', planTier: 'pro', planDisplayName: nextName });
    expect(h.usage).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

// Test value / unit: use real admission, account events and commands. A healthy
// second slot after first-slot exhaustion must emit usage/load hints, whereas
// sign-in, pause and removal must keep invalidating the old identity. Prior tests
// verify quota and account commands separately, not the event consumed by groups.
it('distinguishes usage and load changes from sign-in, pause and removal', async () => {
  h.pools.anthropic = { strategy: 'order', accounts: [account('default'), account('second')] };
  h.read.mockImplementation(async (_kind: string, directory: string) => ({ authenticated: true, identity: directory }));
  h.usage.mockImplementation(async (_kind: string, directory: string) => ({ claudeUsage: {
    updatedAt: Date.now(), fiveHour: { utilization: directory.endsWith('second') ? 10 : 100,
      resetsAt: Date.now() / 1000 + 3600 }, sevenDay: null, scoped: [],
  } }));
  const changed = vi.fn();
  const unsubscribe = onSubscriptionAccountsChanged(changed);
  const lease = await acquireSubscriptionAccount('anthropic', 'claude-sonnet-5', []);
  try {
    expect(lease?.account.id).toContain('anthropic:second');
    expect(changed).toHaveBeenLastCalledWith('anthropic', undefined, 'load');
    observeSubscriptionAccountUsage(lease!.account, { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 });
    expect(changed).toHaveBeenLastCalledWith('anthropic', undefined, 'usage');
    lease!.running(false);
    expect(changed).toHaveBeenLastCalledWith('anthropic', undefined, 'load');
    for (const command of [
      { action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'test-login' },
      { action: 'configure', providerId: 'anthropic', accountId: 'second', paused: true },
      { action: 'remove', providerId: 'anthropic', accountId: 'second' },
    ] satisfies SubscriptionAccountCommand[]) {
      changed.mockClear();
      await runSubscriptionAccountCommand(command);
      expect(changed).toHaveBeenLastCalledWith('anthropic', undefined, undefined);
    }
  } finally { lease?.release(); unsubscribe(); }
});

// Unit, plugin quota contract (2026-11-16): existing UI reads expose native paths/identity and
// have no public projection. Two different account quotas, missing data and an in-flight
// removal/owner switch must remain distinguishable through the real read entry.
describe('read-only subscription usage', () => {
  it.each(['anthropic', 'openai'] as const)('projects each %s account without native identity or secret fields', async provider => {
    h.pools[provider] = { strategy: 'round', accounts: [account('default'), account('second')] };
    h.read.mockImplementation(async (_kind: string, directory: string) => ({ authenticated: true,
      identity: `${directory}@private.test`, plan: provider === 'anthropic' ? 'max' : 'plus',
      planTier: provider === 'anthropic' ? 'max_20x' : undefined,
      planDisplayName: provider === 'anthropic' ? 'Ultra' : undefined, accessToken: 'must-not-leak' }));
    const observedAt = Date.now() - 10_000;
    h.usage.mockImplementation(async (_kind: string, directory: string) => {
      const used = directory.endsWith('second') ? 74 : 12;
      return provider === 'anthropic'
        ? { claudeUsage: { source: 'oauth-endpoint', updatedAt: observedAt, fiveHour: { utilization: used, resetsAt: 9_999_999_999 },
          scoped: [{ modelDisplayName: 'Sonnet', utilization: used + 1 }], accountFingerprint: 'must-not-leak', accessToken: 'must-not-leak' } }
        : { codexUsage: { appServerBuckets: { codex: { limitId: 'codex', limitName: null, updatedAt: observedAt,
          primary: { usedPercent: used, windowMinutes: 300, resetsAt: 9_999_999_999 }, secondary: null,
          accessToken: 'must-not-leak' } }, webSnapshot: null } };
    });
    const result = await readSubscriptionUsage(provider);
    expect(result.accounts.map(a => [a.accountId, a.windows[0].usedPercent])).toEqual([['default', 12], ['second', 74]]);
    expect(result.accounts[0]).toMatchObject({ providerId: provider, provider, status: 'connected',
      plan: { type: provider === 'anthropic' ? 'max' : 'plus', tier: provider === 'anthropic' ? 'max_20x' : null }, usageStatus: 'available' });
    if (provider === 'anthropic') expect(result.accounts[0].plan).toHaveProperty('displayName', 'Ultra');
    else expect(result.accounts[0].plan).not.toHaveProperty('displayName');
    expect(result.accounts[0].windows[0]).toMatchObject({ windowMinutes: 300, resetsAt: 9_999_999_999 });
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|private\.test|directory|accountKey|accountFingerprint|accessToken/);
    const reads = h.usage.mock.calls.length;
    expect(await readSubscriptionUsage(provider)).toEqual(result);
    expect(h.usage).toHaveBeenCalledTimes(reads);
  });

  it('preserves unknown and stale readings without refreshing the observation time', async () => {
    h.read.mockImplementation(async (_kind: string, directory: string) => ({ authenticated: true, identity: directory }));
    const old = Date.now() - 600_000;
    h.usage.mockImplementation(async (_kind: string, directory: string) => directory.endsWith('second') ? {}
      : { claudeUsage: { source: 'oauth-endpoint', updatedAt: old, fiveHour: { utilization: 27, resetsAt: 1 } } });
    const result = await readSubscriptionUsage('anthropic');
    expect(result.accounts[0]).toMatchObject({ usageStatus: 'stale', updatedAt: old, windows: [{ usedPercent: 27, updatedAt: old }] });
    expect(result.accounts[1]).toMatchObject({ usageStatus: 'unavailable', updatedAt: null, windows: [], plan: { type: null, tier: null } });
    h.read.mockResolvedValue({ authenticated: false });
    await refreshSubscriptionPool('anthropic', true);
    expect((await readSubscriptionUsage('anthropic')).accounts.every(a => a.status === 'signed-out' && !a.windows.length)).toBe(true);
  });

  // PR #10832 review: a partial SDK event advances the snapshot/bucket clock but
  // retains other windows. The public reader must not re-date those retained quotas.
  it.each(['anthropic', 'openai'] as const)('marks retained %s windows stale after partial events and an endpoint failure', async provider => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.now();
    try {
      h.pools[provider] = { strategy: 'round', accounts: [account('default')] };
      h.usage.mockResolvedValue(provider === 'anthropic'
        ? { claudeUsage: { source: 'oauth-endpoint', updatedAt: now,
          fiveHour: { utilization: 20, resetsAt: now / 1000 + 3600 },
          scoped: [{ modelDisplayName: 'Sonnet', utilization: 60, resetsAt: now / 1000 + 86400 }] } }
        : { codexUsage: { appServerBuckets: { codex: { limitId: 'codex', limitName: null, updatedAt: now,
          primary: { usedPercent: 20, windowMinutes: 300, resetsAt: now / 1000 + 3600 },
          secondary: { usedPercent: 60, windowMinutes: 10080, resetsAt: now / 1000 + 86400 } } }, webSnapshot: null } });
      expect((await readSubscriptionUsage(provider)).accounts[0].usageStatus).toBe('available');
      const lease = (await acquireSubscriptionAccount(provider, undefined, []))!;
      try {
        vi.setSystemTime(now + 600_000);
        observeSubscriptionAccountUsage(lease.account, provider === 'anthropic'
          ? { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3, resetsAt: now / 1000 + 3600 }
          : { limitId: 'codex', primary: { usedPercent: 30, windowMinutes: 300, resetsAt: now / 1000 + 3600 } });
        h.usage.mockRejectedValue(new Error('endpoint unavailable'));
        const result = (await readSubscriptionUsage(provider)).accounts[0];
        expect(result).toMatchObject({ usageStatus: 'stale', updatedAt: null });
        expect(result.windows.find(window => window.id === (provider === 'anthropic' ? 'weekly:Sonnet' : 'codex:secondary')))
          .toMatchObject({ usedPercent: 60, updatedAt: null });
      } finally { lease.release(); }
    } finally { vi.useRealTimers(); }
  });

  it('matches UI deduplication only within the same provider and ChatGPT workspace', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    h.read.mockResolvedValue({ authenticated: true, identity: 'same@example.test' });
    h.tokens.mockResolvedValue({ chatgptAccountId: 'same-workspace', canDispatch: () => true });
    expect((await readSubscriptionUsage('openai')).accounts.map(a => a.accountId)).toEqual(['default']);
    h.placement['openai:second'] = 'separate';
    expect((await readSubscriptionUsage()).accounts.filter(a => a.provider === 'openai')
      .map(a => [a.providerId, a.accountId])).toEqual([['openai', 'default'], ['separate', 'second']]);
  });

  it('only reads connected owner accounts and keeps custom provider placement', async () => {
    h.bound = false;
    h.placement['anthropic:second'] = 'my-claude';
    h.created['my-claude'] = { kind: 'anthropic', name: 'Private name', account: 'second' };
    expect((await readSubscriptionUsage()).accounts.map(a => [a.providerId, a.accountId])).toEqual([['my-claude', 'second']]);
    expect(h.read).toHaveBeenCalledTimes(1);
    expect((await readSubscriptionUsage('anthropic')).accounts).toEqual([]);
    expect((await readSubscriptionUsage('not-a-local-provider')).accounts).toEqual([]);
  });

  it.each(['remove', 'move', 'revoke'] as const)('drops a %s during another account read', async change => {
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.read.mockImplementation(async (_kind: string, directory: string) => {
      if (directory.endsWith('second')) { reached(); await pending; }
      return { authenticated: true, identity: directory };
    });
    const result = readSubscriptionUsage('anthropic');
    await waiting;
    if (change === 'remove') h.pools.anthropic!.accounts = [account('second')];
    else if (change === 'move') h.placement['anthropic:default'] = 'moved';
    else h.bound = false;
    release();
    expect((await result).accounts.map(a => a.accountId)).toEqual(['second']);
  });

  it('rejects a late read after the Cindy owner changes', async () => {
    h.read.mockImplementation(async () => { h.owner = 'another-owner'; return { authenticated: true }; });
    await expect(readSubscriptionUsage('anthropic')).rejects.toThrow('owner changed');
  });
});

// Unit: the CLI-origin account used to become an implicit fallback for a newly empty provider.
// Existing historical bindings must keep working, while new tasks cannot use another supplier.
it.each(['anthropic', 'openai'] as const)('leaves an emptied %s provider unavailable to fresh tasks after moving its only account', async provider => {
  h.pools[provider] = { strategy: 'least', accounts: [account('default')] };
  const old = await acquireSubscriptionAccount(provider, undefined, ['task:original']);
  await old!.bind(['task:original', 'native:original']); old!.release();
  await runSubscriptionAccountCommand({ action: 'place', providerId: provider, accountId: 'default', target: null });
  expect(hasConnectedSubscriptionPool(provider)).toBe(false);
  expect((await readSubscriptionPool(provider)).accounts).toEqual([]);
  await expect(acquireSubscriptionAccount(provider, undefined, [], false, { resuming: false })).rejects.toThrow();
  const start = vi.fn(async () => ({ id: 'resumed-original', send: async () => {}, close: async () => {} }));
  const agent = withSubscriptionAccounts({ kind: provider === 'anthropic' ? 'claude-code' : 'codex', startSession: start } as unknown as BaseAgent);
  await expect(agent.startSession({ providerId: provider, sessionId: 'brand-new' } as StartSessionOptions)).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
  const historical = await agent.startSession({ providerId: provider, sessionId: 'original', resumeSessionId: 'original' } as StartSessionOptions);
  await historical.close();
  expect(start).toHaveBeenCalledOnce();
  const resumed = await acquireSubscriptionAccount(provider, undefined, ['task:original', 'native:original'], false, { resuming: true });
  expect(resumed?.account.configDir).toBe(`${provider}/default`); resumed!.release();
});

it.each(['anthropic', 'openai'] as const)('removes the CLI-origin %s account and hands its task to the remaining account', async provider => {
  h.pools[provider] = { strategy: 'round', accounts: [account('default'), account('second')] };
  h.bindings.set('task:existing', { providerId: provider, accountId: 'default' });
  h.bindings.set('native:old', { providerId: provider, accountId: 'default' });
  const after = await runSubscriptionAccountCommand({ action: 'remove', providerId: provider, accountId: 'default' });
  expect(after.accounts.map(a => a.id)).toEqual(['second']);
  expect(h.storedUsage.get(`${provider}:default`)).toBeNull();
  let rebuilt = false;
  const row = { status: 'idle', providerId: provider, agentKind: provider === 'openai' ? 'codex' : 'claude-code',
    sdkSessionId: 'old', model: null } as SessionRowSnapshot;
  expect(await prepareSubscriptionAccountForSend('existing', {
    readSession: async () => row, isRunning: () => false,
    rebuild: async (_id, assertCurrent) => { assertCurrent(); rebuilt = true; },
  })).toBe(true);
  expect(rebuilt).toBe(true);
  expect(h.bindings.get('task:existing')?.accountId).toBe('second');
  expect(h.bindings.get('native:old')?.accountId).toBe('default');
});

// Unit: the old default-only placement restriction hid authorization and affinity gaps. Exercise
// actual management and dispatch for both engines; only storage and official CLI reads are fake.
it.each(['anthropic', 'openai'] as const)('moves the CLI-origin %s account without relogin or changing task history', async provider => {
  h.pools[provider] = { strategy: 'round', accounts: [account('default'), account('second')] };
  const original = await acquireSubscriptionAccount(provider, undefined, ['task:moving']);
  expect(original?.accountId).toBe('default');
  await original!.bind(['task:moving', 'native:moving']);
  original!.release();
  await runSubscriptionAccountCommand({ action: 'place', providerId: provider, accountId: 'default', target: null });
  const destination = h.placement[`${provider}:default`];
  expect((await readSubscriptionPool(provider)).accounts.map(a => a.id)).toEqual(['second']);
  const moved = await acquireSubscriptionAccount(destination, undefined, ['task:moving', 'native:moving']);
  expect(moved?.account.configDir).toBe(`${provider}/default`);
  moved!.release();
  expect(h.bindings.get('native:moving')?.accountId).toBe('default');
  h.bound = false;
  await expect(acquireSubscriptionAccount(destination, undefined, [])).rejects.toThrow();
  h.bound = true;
  await runSubscriptionAccountCommand({ action: 'place', providerId: destination, accountId: 'default', target: provider });
  expect((await readSubscriptionPool(provider)).accounts.map(a => a.id)).toEqual(['default', 'second']);
});

// Unit security regression: configure creates an unbound CLI placeholder. Moving it is an
// arrangement change, never consent to reuse another owner's still logged-in system CLI.
it.each(['anthropic', 'openai'] as const)('does not authorize a moved unbound %s CLI placeholder', async provider => {
  h.bound = false;
  h.pools[provider] = { strategy: 'least', accounts: [account('default')] };
  await runSubscriptionAccountCommand({ action: 'place', providerId: provider, accountId: 'default', target: null });
  const destination = h.placement[`${provider}:default`];
  expect((await readSubscriptionPool(destination)).accounts[0].status).toBe('signed-out');
  await expect(acquireSubscriptionAccount(destination, undefined, [])).rejects.toThrow();
});

// Unit regression (2026-11-13): native accounts had auth/quota snapshots but no
// independent model discovery. Existing dispatch tests never read the supplier
// catalog after default logout. Minimal input: default revoked, second healthy.

// Unit: old builtin bindings omit `via`. After every profile moves out, compatibility must
// follow the task's actual second profile rather than require it to match the CLI-origin slot.
it.each(['anthropic', 'openai'].flatMap(provider => [false, true].map(resume => ({ provider, resume }))))
('retains the moved second $provider account of an implicit builtin binding (resume=$resume)', async ({ provider: kind, resume }) => {
  const provider = kind as SubscriptionProvider;
  h.pools[provider] = { strategy: 'least', accounts: [account('default'), account('second')] };
  const old = await acquireSubscriptionAccount(provider, undefined, ['task:old-second'], false, { accountId: 'second' });
  await old!.bind(['task:old-second', 'native:old-second']); old!.release();
  await runSubscriptionAccountCommand({ action: 'place', providerId: provider, accountId: 'default', target: null });
  await runSubscriptionAccountCommand({ action: 'place', providerId: provider, accountId: 'second', target: h.placement[`${provider}:default`] });
  const start = vi.fn(async (_options: StartSessionOptions) => ({ id: 'continued-second', send: async () => {}, close: async () => {} }));
  const agent = withSubscriptionAccounts({ kind: provider === 'anthropic' ? 'claude-code' : 'codex', startSession: start } as unknown as BaseAgent);
  const handle = await agent.startSession({ providerId: provider, sessionId: 'old-second',
    ...(resume ? { resumeSessionId: 'old-second' } : {}),
  } as StartSessionOptions);
  expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe(`${provider}/second`);
  await handle.close();
});

// Unit: each clear captures the current owner's database. Switching owner during the account
// config write must reject before either remove path can clear the new owner's default ID.
it.each(['anthropic', 'openai'].flatMap(provider => ['remove', 'remove-provider'].map(action => ({ provider, action }))))
('stops $provider $action quota cleanup when the config write crosses owners', async ({ provider: kind, action }) => {
  const provider = kind as SubscriptionProvider;
  const providerId = action === 'remove' ? provider : `${provider}-sub-12345678`;
  h.pools[provider] = { strategy: 'least', accounts: [account('default')] };
  if (action === 'remove-provider') {
    h.created[providerId] = { kind: provider, name: 'Moved account', account: 'default' };
    h.placement[`${provider}:default`] = providerId;
  }
  await readSubscriptionPool(providerId);
  const sentinel = { accountFingerprint: 'new-owner-sentinel', used: 44 };
  h.storedUsage.set(`${provider}:default`, sentinel);
  h.afterPoolWrite = () => {
    if (!h.pools[provider]?.accounts.length) h.owner += '-new-owner';
  };
  const command = action === 'remove' ? { action: 'remove' as const, providerId, accountId: 'default' }
    : { action: 'remove-provider' as const, providerId };
  await expect(runSubscriptionAccountCommand(command)).rejects.toThrow('owner changed');
  expect(h.storedUsage.get(`${provider}:default`)).toEqual(sentinel);
});
describe('owner-only subscription identity', () => {
  // Unit: workspace B cannot retain A's model list after its own first refresh times out.
  it('does not reuse models across same-email workspace changes', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    h.tokens.mockResolvedValue({ chatgptAccountId: 'workspace-a', canDispatch: () => true });
    h.rpc.mockResolvedValue({ data: [{ id: 'workspace-a-model' }] });
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    h.tokens.mockResolvedValue({ chatgptAccountId: 'workspace-b', canDispatch: () => true });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try {
      await refreshSubscriptionPool('openai');
      h.rpc.mockRejectedValue(new Error('timed out'));
      await refreshSubscriptionPoolCodexModels();
      expect(readSubscriptionPoolCodexModels()).toEqual([]);
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    } finally { clock.mockRestore(); }
  });

  // Unit: a model read that cannot reach OpenAI is reported as a connection problem;
  // any other failure, and a later success, are not.
  it('marks a failed model read as unreachable only when the service could not be reached', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    h.rpc.mockResolvedValue({ data: [{ id: 'sol' }] });
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    expect(isSubscriptionPoolReadUnreachable('openai')).toBe(false);
    h.rpc.mockRejectedValueOnce(new AccountServiceUnreachableError('Codex account read timed out'));
    await refreshSubscriptionPoolCodexModels(true);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    expect(isSubscriptionPoolReadUnreachable('openai')).toBe(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['sol']);
    h.rpc.mockRejectedValueOnce(new Error('Invalid Codex model list'));
    await refreshSubscriptionPoolCodexModels(true);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    expect(isSubscriptionPoolReadUnreachable('openai')).toBe(false);
    await refreshSubscriptionPoolCodexModels(true);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
    expect(isSubscriptionPoolReadUnreachable('openai')).toBe(false);
  });

  // Unit: the first launch after an upgrade may have only the CLI cache as evidence.
  // A disk-only id must not become selectable, even while we recheck a shorter response.
  it('rechecks conflicting first discovery without publishing disk-only models', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    h.rpc.mockResolvedValue({ data: [{ id: 'sol' }] });
    h.modelCacheRead.mockResolvedValue(JSON.stringify({ fetched_at: new Date().toISOString(),
      models: ['sol', 'astra'].map(slug => ({ slug, supported_in_api: true, visibility: 'list' })) }));
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['sol']);
    h.rpc.mockRejectedValueOnce(new Error('retry timeout'));
    await refreshSubscriptionPoolCodexModels(true);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['sol']);
    await refreshSubscriptionPoolCodexModels(true);
    await refreshSubscriptionPoolCodexModels(true);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['sol']);
  });

  // Unit: a staged write from the previous owner must be discarded after an account switch.
  it('discards the staged model list when the owner changes before publication', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    h.rpc.mockResolvedValue({ data: [{ id: 'astra' }] });
    await refreshSubscriptionPool('openai');
    h.onSnapshotStage = () => {
      h.owner = 'another-owner';
      readSubscriptionPoolCodexModels();
    };
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    expect(h.savedModelFiles.size).toBe(0);
  });

  // Unit, PR #11754: a default logout yields before deleting its persisted list.
  // Existing cleanup tests keep the owner stable or replace the runtime on switch.
  it.each(['an owner switch', 'a pending owner boundary'])('preserves saved models when logout cleanup is interrupted by %s', async transition => {
    h.pools.openai = { strategy: 'order', accounts: [account('default')] };
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    const ownerFile = `${h.owner}/model-discovery/codex-pool-default.json`;
    const nextOwnerFile = 'another-owner/model-discovery/codex-pool-default.json';
    const saved = h.savedModelFiles.get(ownerFile);
    expect(saved).toBeDefined();
    h.savedModelFiles.set(nextOwnerFile, saved!);

    resetDefaultSubscriptionCodexDiscovery(false);
    // Switch without touching the new owner's subscription runtime.
    if (transition === 'an owner switch') h.owner = 'another-owner';
    else h.ownerBoundaryPending = true;
    await Promise.resolve();
    expect(h.savedModelFiles.get(ownerFile)).toBe(saved);
    expect(h.savedModelFiles.get(nextOwnerFile)).toBe(saved);
  });

  // Unit: reopening the owner's runtime discards memory; transient failure must still
  // retain Astra even across repeated fallback replies; only consistent native evidence confirms removal.
  it('recovers persisted membership without confirming repeated conflicting fallback lists', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    h.rpc.mockResolvedValue({ data: [{ id: 'astra' }, { id: 'sol', supportedReasoningEfforts: [] }] });
    h.modelCacheRead.mockResolvedValue(JSON.stringify({ models: ['astra', 'sol'].map(slug => ({
      slug, supported_in_api: true, visibility: 'list',
    })) }));
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    const owner = h.owner;
    h.owner = 'another-owner';
    readSubscriptionPoolCodexModels();
    h.owner = owner;
    h.rpc.mockRejectedValueOnce(new Error('timeout'));
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['astra', 'sol']);
    // An omitted effort list permits registry fallback, while an explicit empty list overrides it.
    expect(readSubscriptionPoolCodexModels()?.map(m => m.discoveredMetadata?.efforts)).toEqual([undefined, []]);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    h.rpc.mockResolvedValue({ data: [{ id: 'sol' }] });
    await refreshSubscriptionPoolCodexModels(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['astra', 'sol']);
    await refreshSubscriptionPoolCodexModels(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['astra', 'sol']);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    h.modelCacheRead.mockResolvedValue(JSON.stringify({ models: [{ slug: 'sol', supported_in_api: true, visibility: 'list' }] }));
    await refreshSubscriptionPoolCodexModels(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['sol']);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
    // Unrelated disk-only ids are not a contraction of this account's verified list.
    h.modelCacheRead.mockResolvedValue(JSON.stringify({ models: ['sol', 'disk-only'].map(slug => ({
      slug, supported_in_api: true, visibility: 'list',
    })) }));
    h.rpc.mockResolvedValue({ data: [{ id: 'sol' }, { id: 'new-model' }] });
    await refreshSubscriptionPoolCodexModels(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['sol', 'new-model']);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
  });

  // Unit regression: a restart followed by a slow RPC used to hide a verified model
  // until the request finished. Assert the published directory while the real refresh is pending.
  it('publishes the same-workspace disk snapshot before discovery finishes', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    h.rpc.mockResolvedValue({ data: [{ id: 'astra' }] });
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    const owner = h.owner;
    h.owner = 'another-owner';
    readSubscriptionPoolCodexModels();
    h.owner = owner;
    await refreshSubscriptionPool('openai');
    let finish!: (value: unknown) => void;
    h.rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = refreshSubscriptionPoolCodexModels();
    try {
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['astra']);
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    } finally {
      finish({ data: [{ id: 'astra' }] });
      await pending;
    }
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
  });

  // Unit: a confirmed empty list can fail to replace an older snapshot. The next
  // identical refresh must repair disk so cold recovery cannot revive the removed model.
  it('repairs an older disk snapshot on the next unchanged successful refresh', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    h.rpc.mockResolvedValue({ data: [{ id: 'astra' }] });
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();

    h.rejectSnapshotRename = true;
    h.rpc.mockResolvedValue({ data: [] });
    await refreshSubscriptionPoolCodexModels(true);
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);

    h.rejectSnapshotRename = false;
    await refreshSubscriptionPoolCodexModels(true);
    const owner = h.owner;
    h.owner = 'another-owner';
    readSubscriptionPoolCodexModels();
    h.owner = owner;
    h.rpc.mockRejectedValueOnce(new Error('timeout'));
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
  });

  it('does not carry quota across same-email workspace changes', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default')] };
    h.read.mockResolvedValue({ authenticated: true, identity: 'same@example.test' });
    h.tokens.mockResolvedValue({ chatgptAccountId: 'workspace-a', canDispatch: () => true });
    const quota = (usedPercent: number) => ({ codexUsage: { appServerBuckets: { codex: { primary: null,
      secondary: { usedPercent, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 86400 } } } } });
    h.usage.mockResolvedValue(quota(20));
    const first = await refreshSubscriptionPool('openai');
    h.tokens.mockResolvedValue({ chatgptAccountId: 'workspace-b', canDispatch: () => true });
    h.usage.mockResolvedValue(quota(70));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try {
      const next = await refreshSubscriptionPool('openai');
      expect(next.accounts[0].accountKey).not.toBe(first.accounts[0].accountKey);
      expect(next.accounts[0].usage?.codex?.buckets.codex.secondary?.usedPercent).toBe(70);
    } finally { clock.mockRestore(); }
  });

  it('distinguishes workspaces and never publishes raw workspace ids or tokens', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.read.mockResolvedValue({ authenticated: true, identity: 'same@example.test' });
    h.tokens.mockImplementation(async (directory: string) => ({ accessToken: 'secret-token', chatgptAccountId: directory, canDispatch: () => true }));
    await refreshSubscriptionPool('openai');
    const keys = subscriptionProviderAccountKeys('openai')!;
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.every(key => /^[a-f0-9]{64}$/.test(key))).toBe(true);
    const view = await readSubscriptionPool('openai');
    expect(view.accounts.map(a => a.accountKey).sort()).toEqual(keys);
    expect(JSON.stringify(keys)).not.toContain('secret-token');
    h.pools.openai.accounts[1].paused = true;
    expect(subscriptionProviderAccountKeys('openai')).toBeUndefined();
  });
});

// Unit regression: merging two profiles of the same verified ChatGPT account counted it twice.
// Existing merge tests use distinct workspace ids. Exercise the production command/read/lease
// entry points with A + another login of A + B; retain native history, permissions and placement.
describe('duplicate subscription account profiles', () => {
  beforeEach(() => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('duplicate'), account('other')] };
    h.tokens.mockImplementation(async (directory: string) => ({
      chatgptAccountId: directory.endsWith('/other') ? 'workspace-b' : 'workspace-a', canDispatch: () => true,
    }));
  });

  it('counts verified duplicate homes once in anonymous scheduling and respects model membership', async () => {
    expect(await readSubscriptionPoolScheduling('openai', 'gpt-6')).toMatchObject({ accounts: 2, totalRunning: 0 });
    // Restart the synthetic owner so model discovery is fresh for this model matrix.
    h.owner += ':models';
    h.rpc.mockImplementation(async (directory: string, method: string) => method === 'model/list'
      ? { data: [{ id: directory.endsWith('/other') ? 'model-b' : 'gpt-6' }], nextCursor: null } : undefined);
    expect(await readSubscriptionPoolScheduling('openai', 'gpt-6')).toMatchObject({ accounts: 1, totalRunning: 0 });
    expect(await readSubscriptionPoolScheduling('openai', 'model-b')).toMatchObject({ accounts: 1, totalRunning: 0 });
    expect(await readSubscriptionPoolScheduling('openai', 'openai/gpt-image-2', { capability: 'image.generate' }))
      .toMatchObject({ accounts: 2, totalRunning: 0 });
  });

  it('uses the image model for remote legacy account authorization without chat catalog membership', async () => {
    const model = 'openai/gpt-image-2';
    const options = { remote: true, capability: 'image.generate' as const };
    h.pools.openai = { strategy: 'order', accounts: [account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' } };
    let allowed = true;
    h.accountAllowed.mockImplementation((_id, requested) => allowed && requested === model);

    expect(await readSubscriptionPoolScheduling('openai', model, options)).toMatchObject({ accounts: 1 });
    const lease = await acquireSubscriptionAccount('openai', model, [], false, options);
    expect(lease?.accountId).toBe('imported');
    try {
      expect(() => lease?.assertDispatchable()).not.toThrow();
      allowed = false;
      expect(() => lease?.assertDispatchable()).toThrow('Subscription account remote access was revoked');
    } finally {
      lease?.release();
    }
  });

  // #11948 / unit: unlike legacy images, the created provider has chat auth without
  // image OAuth until the native bridge is readable. Exercise real pooling and the
  // hosted serializer; only the native credential transport and HTTP are synthetic.
  it('uses only the selected provider’s image account and stops if it moves before dispatch', async () => {
    const providerId = 'openai-sub-image-fixture';
    const model = `${providerId}/gpt-image-2`;
    const image = 'iVBORw0KGgo=';
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.created[providerId] = { kind: 'openai', name: 'Independent', account: 'second' };
    h.placement['openai:second'] = providerId;
    let imageAuth = false;
    h.tokens.mockImplementation(async (directory: string) => {
      if (directory === 'openai/second' && !imageAuth) throw new Error('No native OAuth material');
      return { accessToken: `fixture-token:${directory}`, chatgptAccountId: `fixture-workspace:${directory}`, canDispatch: () => true };
    });
    const provider = {
      ...BUNDLED_CATALOG.providers.find(candidate => candidate.id === 'openai')!,
      id: providerId, subscriptionPool: 'openai' as const,
    };
    const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ data: [{ b64_json: image }] }));
    let moveOnSecondRead = false;
    let reads = 0;
    const legacy = vi.fn(async () => { throw new Error('Unexpected legacy credential read'); });
    const observed = vi.fn(() => hasCreatedOpenAiImageAuth(providerId));
    const unsubscribe = onSubscriptionPoolCodexModelsChanged(observed);
    setCodexImageAuthBinding({
      hasPoolImageAuth: hasCreatedOpenAiImageAuth,
      getAuth: legacy,
      onAuthFailure: vi.fn(),
      acquireAuth: createCodexImageAuthAcquirer({
        resolveSubscriptionPoolProvider, acquireSubscriptionAccount,
        async getChatgptBridgeAuthForDispatch(family, selected) {
          if (family !== 'openai' || !selected?.readCodexTokens) {
            throw new Error('Image dispatch did not bind a native OpenAI account');
          }
          const tokens = await selected.readCodexTokens();
          if (++reads === 2 && moveOnSecondRead) delete h.placement['openai:second'];
          return { accessToken: tokens.accessToken, accountId: tokens.chatgptAccountId, canDispatch: tokens.canDispatch! };
        },
        invalidateChatgptBridgeAuth: async () => false,
      }),
    });
    try {
      const channel = createAccountCodexImageChannel(providerId, () => provider, { fetchImplementation });
      const params = { model, prompt: 'Draw a circle' };
      await refreshSubscriptionPool('openai', true);
      await refreshSubscriptionPool(providerId, true);
      expect(hasConnectedSubscriptionPool(providerId)).toBe(true);
      expect(channel.ready()).toBe(false);
      await expect(channel.generateImage(params)).rejects.toThrow('No subscription account is available');
      expect(fetchImplementation).not.toHaveBeenCalled();

      imageAuth = true;
      await refreshSubscriptionPool(providerId, true);
      expect(channel.ready()).toBe(true);
      expect(observed).toHaveLastReturnedWith(true);
      await expect(channel.generateImage(params)).resolves.toEqual({ data: [{ b64_json: image }] });
      const [url, init] = fetchImplementation.mock.calls[0]!;
      expect(url).toBe('https://chatgpt.com/backend-api/codex/images/generations');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer fixture-token:openai/second',
        'ChatGPT-Account-Id': 'fixture-workspace:openai/second',
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'gpt-image-2' });

      reads = 0;
      moveOnSecondRead = true;
      await expect(channel.generateImage(params)).rejects.toThrow('Subscription image account was moved');
      expect(channel.ready()).toBe(false);
      await expect(channel.generateImage(params)).rejects.toThrow('No subscription account is available');
      expect(fetchImplementation).toHaveBeenCalledTimes(1);
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      setCodexImageAuthBinding(null);
    }
  });

  // #11948 / unit: a merged legacy image model's existing off switch uses
  // the original provider namespace even when the destination's switch is on.
  it('respects a merged legacy account’s own image model disable switch', async () => {
    const providerId = 'openai-sub-image-fixture';
    const legacyId = 'openai-imported';
    const model = `${providerId}/gpt-image-2`;
    h.pools.openai = {
      strategy: 'order', accounts: [account('default'), account('second')],
      legacyCodexAccounts: { [legacyId]: 'second' },
    };
    h.created[providerId] = { kind: 'openai', name: 'Independent', account: 'second' };
    h.placement['openai:second'] = providerId;
    h.tokens.mockResolvedValue({
      accessToken: 'fixture-token', chatgptAccountId: 'fixture-workspace', canDispatch: () => true,
    });
    await refreshSubscriptionPool(providerId, true);
    expect(hasCreatedOpenAiImageAuth(providerId)).toBe(true);
    const options = { capability: 'image.generate' as const };
    const lease = await acquireSubscriptionAccount(providerId, model, [], false, options);
    try {
      expect(lease?.accountId).toBe('second');
      h.accountAllowed.mockImplementation((provider: string, modelId: string) =>
        provider !== legacyId || modelId !== `${legacyId}/gpt-image-2`);
      expect(hasCreatedOpenAiImageAuth(providerId)).toBe(false);
      expect(() => lease?.assertDispatchable()).toThrow('does not allow this model');
      await expect(acquireSubscriptionAccount(providerId, model, [], false, options))
        .rejects.toThrow('No subscription account is available');
    } finally {
      lease?.release();
    }
  });

  it('merges into two accounts, empties the source and retains the old task directory', async () => {
    const source = 'openai-sub-duplicate';
    h.created[source] = { kind: 'openai', name: 'Original', account: 'duplicate' };
    h.placement['openai:duplicate'] = source;
    h.bindings.set('task:old', { providerId: 'openai', accountId: 'duplicate', via: source });
    const old = await acquireSubscriptionAccount(source, 'gpt-6', ['task:old'], false, { resuming: true });
    try {
      const merged = await runSubscriptionAccountCommand({ action: 'merge', providerId: source, target: 'openai' });
      expect(merged.accounts.map(a => a.id)).toEqual(['default', 'other']);
      expect(merged.accounts[0].running).toBe(1);
      expect((await readSubscriptionPool(source)).accounts).toEqual([]);
      expect(h.pools.openai!.accounts.map(a => a.id)).toEqual(['default', 'duplicate', 'other']);
      const taskView = await readSubscriptionPool('openai', false, 'old');
      expect(taskView.boundAccountId).toBe('duplicate');
      expect(taskView.accounts.map(a => a.id)).toEqual(['duplicate', 'other']);
      h.bindings.set('native:old-only', { providerId: 'openai', accountId: 'duplicate', via: source });
      const nativeView = await readSubscriptionPool('openai', false, 'unrecorded-task', 'old-only');
      expect(nativeView.boundAccountId).toBe('duplicate');
      expect(nativeView.accounts.map(a => a.id)).toEqual(['duplicate', 'other']);
      const resumed = await acquireSubscriptionAccount(source, 'gpt-6', ['task:old'], false, { resuming: true });
      expect(resumed?.account.configDir).toBe('openai/duplicate');
      resumed?.release();
      expect(await readSubscriptionPoolAccountUsages('openai')).toHaveLength(2);
    } finally { old?.release(); }
  });

  it.each(['least', 'round', 'weight'] as const)('counts identity once for %s distribution and capacity', async strategy => {
    h.pools.openai!.strategy = strategy;
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.6);
    const first = await acquireSubscriptionAccount('openai', 'gpt-6', []);
    try {
      // With equal weights A and B each get half, despite A having two login directories.
      expect(first?.accountId).toBe(strategy === 'weight' ? 'other' : 'default');
      const second = await acquireSubscriptionAccount('openai', 'gpt-6', []);
      try {
        expect(second?.accountId).toBe(strategy === 'weight' ? 'default' : 'other');
        await expect(acquireSubscriptionAccount('openai', 'gpt-6', [])).rejects.toThrow('SUBSCRIPTION_ACCOUNTS_FULL');
      } finally { second?.release(); }
    } finally { first?.release(); random.mockRestore(); }
  });

  it('excludes all copies on retry and does not inherit another profile\'s remote permission', async () => {
    const retry = await acquireSubscriptionAccount('openai', 'gpt-6', [], false, { exclude: new Set(['default']) });
    expect(retry?.accountId).toBe('other');
    retry?.release();
    h.pools.openai!.legacyCodexAccounts = { 'codex-old': 'duplicate' };
    h.importedRead.mockResolvedValue({ authenticated: true, identity: 'account' });
    h.accountAllowed.mockReturnValue(false);
    h.rpc.mockImplementation(async (directory: string) => ({
      data: directory.endsWith('/duplicate') ? [{ id: 'special-model' }] : [{ id: 'gpt-6' }], nextCursor: null,
    }));
    await refreshSubscriptionPoolCodexModels(true);
    await expect(acquireSubscriptionAccount('openai', 'special-model', [], false, { remote: true }))
      .rejects.toThrow('No subscription account is available');
  });

  it('applies account controls to all copies and moves them together without merging independent providers', async () => {
    h.pools.openai!.accounts = [account('first'), account('duplicate'), account('other'), account('independent')];
    const destination = 'openai-sub-target';
    h.created[destination] = { kind: 'openai', name: 'Target', account: 'other' };
    h.placement['openai:other'] = destination;
    h.placement['openai:independent'] = destination;
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'first', paused: true, limit: 3 });
    expect(h.pools.openai!.accounts.slice(0, 2).map(a => [a.paused, a.limit])).toEqual([[true, 3], [true, 3]]);
    expect(h.pools.openai!.accounts[2].paused).toBe(false);
    expect(h.pools.openai!.accounts[3].paused).toBe(false);
    await runSubscriptionAccountCommand({ action: 'place', providerId: 'openai', accountId: 'first', target: null });
    const separate = h.placement['openai:first'];
    expect(h.placement['openai:duplicate']).toBe(separate);
    expect((await readSubscriptionPool(separate)).accounts.map(a => a.id)).toEqual(['first']);
    await runSubscriptionAccountCommand({ action: 'place', providerId: separate, accountId: 'first', target: destination });
    expect((await readSubscriptionPool('openai')).accounts).toEqual([]);
    expect((await readSubscriptionPool(destination)).accounts.map(a => a.id)).toEqual(['first', 'other']);
    await runSubscriptionAccountCommand({ action: 'remove', providerId: destination, accountId: 'first' });
    expect(h.pools.openai!.accounts.map(a => a.id)).toEqual(['other']);
  });

  it('shares real failure cooling, preserves bound-account numbering and keeps unknown identities separate', async () => {
    const lease = await acquireSubscriptionAccount('openai', 'gpt-6', []);
    lease!.observeFailure(new Error('usage limit exceeded'), 'gpt-6', 'run');
    lease!.release();
    expect(readSubscriptionAccountBlocked('openai', 'duplicate', 'gpt-6')).toBe(true);
    const next = await acquireSubscriptionAccount('openai', 'gpt-6', []);
    expect(next?.accountId).toBe('other');
    next?.release();
    h.bindings.set('task:b', { providerId: 'openai', accountId: 'other' });
    expect(await readSubscriptionSessionAccount('openai', { sessionId: 'b' }))
      .toMatchObject({ state: 'bound', account: { number: 3 } });
    h.pools.openai!.accounts = h.pools.openai!.accounts.filter(a => a.id !== 'other');
    expect(readSubscriptionAccountBlocked('openai', 'duplicate', 'gpt-6')).toBe(false);
    h.tokens.mockResolvedValue({ canDispatch: () => false });
    expect((await refreshSubscriptionPool('openai', true)).accounts).toHaveLength(2);
  });

  it('does not fold a different workspace when a concurrent refresh changes the cached identity', async () => {
    h.pools.openai!.accounts = [account('default'), account('other')];
    let finishOther!: (usage: object) => void;
    let otherStarted!: () => void;
    const started = new Promise<void>(resolve => { otherStarted = resolve; });
    h.usage.mockImplementation(async (_kind: string, directory: string) => {
      if (directory.endsWith('/other')) {
        otherStarted();
        return new Promise(resolve => { finishOther = resolve; });
      }
      return {};
    });
    const pending = readSubscriptionPool('openai');
    await started;
    h.tokens.mockResolvedValue({ chatgptAccountId: 'workspace-b', canDispatch: () => true });
    h.bindings.set('task:changed', { providerId: 'openai', accountId: 'default' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try {
      await readSubscriptionSessionAccount('openai', { sessionId: 'changed' });
      finishOther({});
      const view = await pending;
      expect(view.accounts.map(a => a.id)).toEqual(['default', 'other']);
      expect(view.accounts[0].accountKey).not.toBe(view.accounts[1].accountKey);
    } finally { finishOther({}); clock.mockRestore(); }
  });

  // Review regression: the visible native home can hide a legacy home whose own switch is
  // disabled. Pool flags alone must not leave that home's unique model permanently unusable.
  it('restores a hidden legacy home and preserves switches of providers hosting other accounts', async () => {
    let legacyPaused = true;
    h.pools.openai!.accounts[1].paused = true;
    h.pools.openai!.legacyCodexAccounts = { 'codex-old': 'duplicate' };
    h.importedRead.mockResolvedValue({ authenticated: true, identity: 'account' });
    h.accountAllowed.mockImplementation(() => !legacyPaused);
    h.setLegacyPaused.mockImplementation((_id: string, paused: boolean) => { legacyPaused = paused; });
    h.rpc.mockImplementation(async (directory: string) => ({
      data: [{ id: directory.endsWith('/duplicate') ? 'special-model' : 'gpt-6' }], nextCursor: null,
    }));
    await expect(acquireSubscriptionAccount('openai', 'special-model', [])).rejects.toThrow('No subscription account is available');
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'default', paused: false });
    expect(h.setLegacyPaused).toHaveBeenCalledWith('codex-old', false);
    const lease = await acquireSubscriptionAccount('openai', 'special-model', []);
    expect(lease?.accountId).toBe('duplicate');
    lease?.release();
    h.placement['openai:other'] = 'codex-old';
    h.setLegacyPaused.mockClear();
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'default', paused: true });
    expect(h.setLegacyPaused).not.toHaveBeenCalled();
  });

  // Task reads can precede settings reads. Preserve the native history slot (used only when
  // identity is unknown) without scanning unrelated accounts' quota to compute a display index.
  it('numbers a bound account consistently when the task is read before the pool on a cold cache', async () => {
    h.bindings.set('task:cold', { providerId: 'openai', accountId: 'other' });
    expect(await readSubscriptionSessionAccount('openai', { sessionId: 'cold' }))
      .toMatchObject({ state: 'bound', account: { number: 3 } });
    expect(h.usage).toHaveBeenCalledExactlyOnceWith('openai', 'openai/other');
    expect((await readSubscriptionPool('openai')).accounts.map(a => a.id)).toEqual(['default', 'other']);
    expect(await readSubscriptionSessionAccount('openai', { sessionId: 'cold' }))
      .toMatchObject({ state: 'bound', account: { number: 3 } });
  });
});

// Unit regression: an independent, renamed Claude provider is ready while the built-in
// default is signed out. Exercise discovery and the returned per-provider membership;
// previous coverage only checked native/Codex discovery and therefore missed this state.
describe('pooled Claude model discovery', () => {
  const model = (id: string) => ({ id, name: id, contextWindow: 200_000, efforts: [], defaultEffort: null });

  // Unit: discovery is not a new admission rule for saved tasks. The existing lease tests
  // had no installed probe (unlike production), so they missed historical ids and cold failures.
  it.each([false, true])('keeps a saved Claude task on its original account with resume=%s when discovery changes', async resume => {
    h.bindings.set('task:saved', { providerId: 'anthropic', accountId: 'second' });
    h.bindings.set('native:saved-native', { providerId: 'anthropic', accountId: 'second' });
    const probe = vi.fn(async () => [model('claude-new-model')]);
    const send = vi.fn(async () => {});
    const setModel = vi.fn<(model: string) => Promise<void>>(async () => {});
    const start = vi.fn<(options: StartSessionOptions) => Promise<unknown>>(async () => ({ id: 'saved-native', send, setModel, close: async () => {} }));
    const fork = vi.fn<(options: ForkSdkSessionOptions) => Promise<unknown>>(async () => ({ newSdkSessionId: 'saved-fork' }));
    const engine = withSubscriptionAccounts({ kind: 'claude-code', startSession: start, forkSdkSession: fork } as unknown as BaseAgent);
    setSubscriptionPoolClaudeModelProbe(probe);
    try {
      await refreshSubscriptionPoolClaudeModels();
      expect(readSubscriptionAccountBlocked('anthropic', 'second', 'claude-historical-model')).toBe(false);
      const handle = await engine.startSession({ providerId: 'anthropic', sessionId: 'saved', model: 'claude-historical-model',
        ...(resume ? { resumeSessionId: 'saved-native' } : {}) } as StartSessionOptions);
      expect(start.mock.calls[0]![0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/second');
      await handle.send({ type: 'user', content: 'continue' });
      await handle.setModel!('sonnet'); // Native CLI aliases are not necessarily SDK list ids.
      expect(setModel.mock.calls[0]?.[0]).toBe('sonnet');
      await engine.forkSdkSession({ providerId: 'anthropic', sourceSdkSessionId: 'saved-native' } as ForkSdkSessionOptions);
      expect(fork.mock.calls[0]![0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/second');
      await handle.close();

      h.owner += ':restart'; // Persist bindings, discard all in-memory discovery as on an upgrade.
      probe.mockRejectedValue(new Error('discovery offline'));
      expect(await refreshSubscriptionPoolClaudeModels()).toBe(false);
      expect(readSubscriptionPoolClaudeModels()).toBeNull(); // Unknown discovery preserves pre-upgrade route metadata.
      const reopened = await engine.startSession({ providerId: 'anthropic', sessionId: 'saved', model: 'claude-historical-model',
        ...(resume ? { resumeSessionId: 'saved-native' } : {}) } as StartSessionOptions);
      await reopened.send({ type: 'user', content: 'continue after restart' });
      expect(send).toHaveBeenCalledTimes(2);
      expect(h.bindings.get('task:saved')?.accountId).toBe('second');
      await reopened.close();
    } finally { setSubscriptionPoolClaudeModelProbe(null); }
  });

  it('retains the same-login Claude list when the SDK returns no usable models', async () => {
    h.pools.anthropic!.accounts = [account('second')];
    let raw: unknown[] = [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }];
    setAnthropicModelProbe(async callback => { callback(raw); return true; });
    try {
      expect(await refreshAnthropicModelsFromProbe()).toBe(true);
      raw = [];
      expect(await refreshAnthropicModelsFromProbe()).toBe(false);
      expect(readSubscriptionPoolClaudeModels()?.map(m => m.id)).toEqual(['claude-opus-4-8']);
    } finally { setAnthropicModelProbe(null); }
  });

  // Unit: a partial SDK reply may refine capabilities without replacing membership.
  // Legacy capture already covered this, but pooled discovery discarded the refinement.
  it('preserves Claude membership while applying explicit capabilities from a partial reply', async () => {
    h.pools.anthropic!.accounts = [account('second')];
    let raw: unknown[] = [
      { value: 'claude-opus-4-8', supportsEffort: true, supportedEffortLevels: ['low', 'high'], supportsFastMode: true },
      { value: 'claude-sonnet-4-5' }, { value: 'claude-haiku-4-5' },
    ];
    setAnthropicModelProbe(async callback => { callback(raw); return true; });
    try {
      expect(await refreshAnthropicModelsFromProbe()).toBe(true);
      raw = [{ value: 'claude-opus-4-8', supportsEffort: true,
        supportedEffortLevels: ['low', 'high', 'xhigh'], supportsFastMode: false }];
      expect(await refreshAnthropicModelsFromProbe()).toBe(true);
      expect(readSubscriptionPoolClaudeModels()).toHaveLength(3);
      expect(readSubscriptionPoolClaudeModels()?.find(entry => entry.id === 'claude-opus-4-8'))
        .toMatchObject({ efforts: ['low', 'high', 'xhigh'], supportsFastMode: false });
      raw = [{ value: 'claude-opus-4-8' }];
      await refreshAnthropicModelsFromProbe();
      expect(readSubscriptionPoolClaudeModels()).toHaveLength(3);
      expect(readSubscriptionPoolClaudeModels()?.find(entry => entry.id === 'claude-opus-4-8'))
        .toMatchObject({ efforts: ['low', 'high', 'xhigh'], supportsFastMode: false });
    } finally { setAnthropicModelProbe(null); }
  });

  // Unit: native-login notifications can overtake a CLI read; the late result must
  // neither restore the logged-out default nor invalidate an independent account.
  it('finishes concurrent cold Claude reads when their first CLI result publishes a login notification', async () => {
    h.pools.anthropic!.accounts = [account('default')];
    h.read.mockImplementationOnce(async () => {
      await Promise.resolve(); // The native CLI publishes status after its asynchronous read.
      syncAnthropicModelsWithClaudeLogin({ loggedIn: true, email: 'account' });
      return { authenticated: true, identity: 'account' };
    });
    const probe = vi.fn(async (onModels: (models: unknown[]) => void) => {
      onModels([{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }]);
      return true;
    });
    setAnthropicModelProbe(probe);
    try {
      const [ready] = await Promise.all([refreshSubscriptionPoolClaudeModels(), refreshSubscriptionPool('anthropic')]);
      expect(ready).toBe(true);
      expect(hasConnectedSubscriptionPool('anthropic')).toBe(true);
      expect(readSubscriptionPoolClaudeModels()?.map(m => m.id)).toEqual(['claude-opus-4-8']);
      expect(probe).toHaveBeenCalledOnce();
    } finally { setAnthropicModelProbe(null); }
  });

  it('ignores a late Claude default auth read after logout while retaining the second account', async () => {
    setSubscriptionPoolClaudeModelProbe(async profile => [model(profile.configDir)]);
    try {
      await refreshSubscriptionPoolClaudeModels();
      let finish!: (value: unknown) => void;
      h.read.mockImplementation(async (_kind: string, directory: string) => directory.endsWith('default')
        ? new Promise(resolve => { finish = resolve; }) : { authenticated: true, identity: 'account' });
      const reading = refreshSubscriptionPool('anthropic', true);
      resetDefaultSubscriptionClaudeDiscovery(false);
      finish({ authenticated: true, identity: 'account' });
      await reading;
      await refreshSubscriptionPoolClaudeModels();
      expect(readSubscriptionPoolClaudeModels()?.map(m => m.id)).toEqual(['anthropic/second']);
    } finally { setSubscriptionPoolClaudeModelProbe(null); }
  });

  it('does not erase a successful Claude snapshot on a temporary auth read failure', async () => {
    h.pools.anthropic!.accounts = [account('second')];
    const probe = vi.fn(async () => [model('claude-owned')]);
    setSubscriptionPoolClaudeModelProbe(probe);
    const availability: boolean[] = [];
    const stop = onSubscriptionPoolClaudeModelsChanged(() => {
      availability.push(hasUnavailableSubscriptionPoolAccount('anthropic'));
    });
    try {
      await refreshSubscriptionPoolClaudeModels();
      availability.length = 0;
      h.read.mockRejectedValueOnce(new Error('CLI read unavailable'));
      await refreshSubscriptionPool('anthropic', true);
      // PR #11754, unit: an account-only read must notify the picker even when the
      // previously discovered models are identical. Repeated failures stay quiet.
      expect(availability).toEqual([true]);
      h.read.mockRejectedValueOnce(new Error('CLI read still unavailable'));
      await refreshSubscriptionPool('anthropic', true);
      expect(availability).toEqual([true]);
      expect(await refreshSubscriptionPoolClaudeModels()).toBe(false);
      // 2026-11-20: the picker keeps the last confirmed list with its time while the account is
      // unreadable; the routing catalog still requires a current sign-in.
      expect(readSubscriptionPoolClaudeModels('anthropic', { includeLastConfirmed: true })?.map(m => m.id)).toEqual(['claude-owned']);
      expect(lastConfirmedSubscriptionModelsAt('anthropic')).toEqual(expect.any(Number));
      expect(readSubscriptionPoolClaudeModels('anthropic', { includeBoundAccounts: true })).toEqual([]);
      await refreshSubscriptionPool('anthropic', true);
      expect(availability).toEqual([true, false]);
      expect(await refreshSubscriptionPoolClaudeModels()).toBe(true);
      expect(probe).toHaveBeenCalledOnce();
      expect(readSubscriptionPoolClaudeModels()?.map(m => m.id)).toEqual(['claude-owned']);
    } finally {
      stop();
      setSubscriptionPoolClaudeModelProbe(null);
    }
  });

  it('discovers each account on its own profile with the built-in disconnected and survives provider renames', async () => {
    const providerId = 'anthropic-sub-12345678';
    h.pools.anthropic!.disconnected = true;
    h.created[providerId] = { kind: 'anthropic', name: 'My OpenAI', account: 'second' };
    h.placement['anthropic:second'] = providerId;
    h.read.mockImplementation(async (_kind: string, directory: string) => ({ authenticated: !directory.endsWith('default'), identity: directory }));
    const probe = vi.fn(async (options?: import('@cindy/maker-core').RefreshLocalModelsOptions) => {
      options?.[NATIVE_SUBSCRIPTION_ACCOUNT]?.assertCurrent();
      options?.onSupportedModels?.([{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }]);
      return true;
    });
    const engine = withSubscriptionAccounts({ kind: 'claude-code', refreshLocalModels: probe } as unknown as BaseAgent);
    setAnthropicModelProbe((onSupportedModels, profile) => engine.refreshLocalModels({
      onSupportedModels, ...(profile ? { [NATIVE_SUBSCRIPTION_ACCOUNT]: profile } : {}),
    }));
    try {
      expect(await refreshAnthropicModelsFromProbe()).toBe(true);
      expect(probe).toHaveBeenCalledOnce();
      expect(probe.mock.calls[0]![0]?.[NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/second');
      expect(readSubscriptionPoolClaudeModels()).toEqual([]);
      expect(readSubscriptionPoolClaudeModels(providerId)?.map(m => m.id)).toEqual(['claude-opus-4-8']);
      const lease = await acquireSubscriptionAccount(providerId, 'claude-opus-4-8', [], false, { resuming: false });
      expect(lease?.account.configDir).toBe('anthropic/second');
      lease?.release();
      h.created[providerId]!.name = 'Renamed again';
      expect(await refreshSubscriptionPoolClaudeModels(false, providerId)).toBe(true);
      expect(probe).toHaveBeenCalledOnce();
      expect(readSubscriptionPoolClaudeModels(providerId)?.map(m => m.id)).toEqual(['claude-opus-4-8']);
      resetDefaultSubscriptionClaudeDiscovery(false);
      expect(readSubscriptionPoolClaudeModels(providerId)?.map(m => m.id)).toEqual(['claude-opus-4-8']);
      // A real logout clears this profile's membership immediately.
      h.read.mockResolvedValue({ authenticated: false });
      await refreshSubscriptionPool(providerId, true);
      expect(readSubscriptionPoolClaudeModels(providerId)).toEqual([]);
    } finally { setAnthropicModelProbe(null); }
  });

  it.each(['removal', 'owner change'] as const)('retains only the same login on probe failure and rejects late results after %s', async boundary => {
    const providerId = 'anthropic-sub-12345678';
    h.created[providerId] = { kind: 'anthropic', name: 'Anything', account: 'second' };
    h.placement['anthropic:second'] = providerId;
    const probe = vi.fn(async () => [model('claude-owned')]);
    setSubscriptionPoolClaudeModelProbe(probe);
    try {
      await refreshSubscriptionPoolClaudeModels(false, providerId);
      probe.mockRejectedValueOnce(new Error('offline'));
      expect(await refreshSubscriptionPoolClaudeModels(true, providerId)).toBe(false);
      expect(readSubscriptionPoolClaudeModels(providerId)?.map(m => m.id)).toEqual(['claude-owned']);
      let finish!: (models: ReturnType<typeof model>[]) => void;
      probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
      const flight = refreshSubscriptionPoolClaudeModels(true, providerId);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      if (boundary === 'removal') h.pools.anthropic!.accounts = h.pools.anthropic!.accounts.filter(a => a.id !== 'second');
      else h.owner += '-switched';
      finish([model('late-account-model')]);
      expect(await flight).toBe(false);
      expect(readSubscriptionPoolClaudeModels(providerId)).toEqual([]);
    } finally { setSubscriptionPoolClaudeModelProbe(null); }
  });
});

describe('pooled Codex model discovery', () => {
  // Unit: the manual refresh entry must route by id, even if a Codex provider is called Claude.
  it('manually refreshes a renamed independent source without using the disconnected default', async () => {
    const providerId = 'openai-sub-12345678';
    h.pools.openai = { strategy: 'least', disconnected: true, accounts: [account('default'), account('second')] };
    h.created[providerId] = { kind: 'openai', name: 'Claude', account: 'second' };
    h.placement['openai:second'] = providerId;
    h.rpc.mockImplementation(async (directory: string) => ({ data: [{ id: `${directory}-model` }] }));
    const fallback = vi.fn(async () => false);
    const agent = withSubscriptionAccounts({ kind: 'codex', refreshLocalModels: fallback } as unknown as BaseAgent);
    expect(await agent.refreshLocalModels({ providerId, credentialMode: 'oauth-bearer' })).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(h.rpc.mock.calls.map(call => call[0])).toEqual(['openai/second']);
    expect(readSubscriptionPoolCodexModels(providerId)?.map(model => model.id)).toEqual(['openai/second-model']);
    h.pools.openai.legacyCodexAccounts = { 'legacy-codex': 'third' };
    h.pools.openai.accounts.push(account('third'));
    expect(await agent.refreshLocalModels({ providerId: 'legacy-codex', credentialMode: 'oauth-bearer' })).toBe(false);
    expect(fallback).toHaveBeenCalledExactlyOnceWith({ providerId: 'legacy-codex', credentialMode: 'oauth-bearer' });
    expect(h.rpc).toHaveBeenCalledOnce();
  });

  // Unit / PR #10327: cold-start agents already exist before discovery. Previous
  // catalog tests only read the union, missing the capability invalidation path.
  it('publishes effective changes to existing agent capabilities and ignores unchanged or stale reads', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    const byAgent = new Map<string, { availableModels: import('@cindy/maker-core').ModelDescriptor[] }>();
    const target = { getCapabilities(kind: string) {
      if (!byAgent.has(kind)) byAgent.set(kind, { availableModels: [] });
      return byAgent.get(kind)!;
    } };
    const capabilities = target.getCapabilities('codex');
    const push = vi.fn(() => refreshCatalogDerivedModels(target,
      getActiveCatalogWithCodexModels(readSubscriptionPoolCodexModels() ?? [])));
    const stop = onSubscriptionPoolCodexModelsChanged(push);
    try {
      h.rpc.mockImplementation(async (directory: string) => ({ data: [{ id: directory.endsWith('default')
        ? 'gpt-default-only' : 'gpt-second-only' }], nextCursor: null }));
      await refreshSubscriptionPool('openai');
      await refreshSubscriptionPoolCodexModels();
      expect(capabilities.availableModels.map(m => m.id)).toContain('gpt-second-only');
      const broadcasts = push.mock.calls.length;
      await refreshSubscriptionPoolCodexModels(true);
      expect(push).toHaveBeenCalledTimes(broadcasts);
      resetDefaultSubscriptionCodexDiscovery(false);
      expect(capabilities.availableModels.map(m => m.id)).not.toContain('gpt-default-only');
      expect(capabilities.availableModels.map(m => m.id)).toContain('gpt-second-only');
      await runSubscriptionAccountCommand({ providerId: 'openai', action: 'configure', accountId: 'second', paused: true });
      expect(capabilities.availableModels.map(m => m.id)).not.toContain('gpt-second-only');
      await runSubscriptionAccountCommand({ providerId: 'openai', action: 'configure', accountId: 'second', paused: false });
      expect(capabilities.availableModels.map(m => m.id)).toContain('gpt-second-only');
      let complete!: (value: unknown) => void;
      h.rpc.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
      const pending = refreshSubscriptionPoolCodexModels(true);
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      h.owner = 'next-owner';
      const beforeLate = push.mock.calls.length;
      complete({ data: [{ id: 'stale-model' }], nextCursor: null });
      await pending;
      expect(push).toHaveBeenCalledTimes(beforeLate);
    } finally { stop(); }
  });

  // Unit / PR #10327: unique endless cursors and an oversized page bypassed
  // repeat-token detection. Overflow must stop, retain LKG and remain retryable.
  it.each(['pages', 'items'] as const)('bounds discovery by %s without publishing a partial list', async budget => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    await refreshSubscriptionPool('openai');
    h.rpc.mockResolvedValue({ data: [{ id: 'gpt-complete' }], nextCursor: null });
    await refreshSubscriptionPoolCodexModels();
    let calls = 0;
    h.rpc.mockImplementation(async () => {
      if (calls >= 10) throw new Error('fixture ends after the expected page budget');
      return {
        data: Array.from({ length: budget === 'items' ? 1001 : 1 }, (_, i) => ({ id: `partial-${i}` })),
        nextCursor: budget === 'pages' ? `unique-${++calls}` : null,
      };
    });
    const before = h.rpc.mock.calls.length;
    await refreshSubscriptionPoolCodexModels(true);
    expect(h.rpc.mock.calls.length - before).toBe(budget === 'pages' ? 10 : 1);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['gpt-complete']);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    h.rpc.mockResolvedValue({ data: [{ id: 'gpt-recovered' }], nextCursor: null });
    await refreshSubscriptionPoolCodexModels(true);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['gpt-recovered']);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
  });

  // PR #10327 review: aggregation alone allowed a new task or failover to pick
  // a healthy account that never reported its model. The real admission path
  // must use exact per-account membership (including the ChatGPT bridge alias).
  it.each(['order', 'least', 'round'] as const)('uses account membership for %s selection and replacement', async strategy => {
    h.pools.openai = { strategy, accounts: [account('default'), account('second')] };
    h.rpc.mockImplementation(async (directory: string) => ({
      data: [{ id: directory.endsWith('default') ? 'default-only' : 'gpt-second-only' }], nextCursor: null,
    }));
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    // Rebase with the credits fix: ignoring plan-window exhaustion must not
    // make a complete per-account model mismatch admissible before sending.
    expect(readSubscriptionAccountBlocked('openai', 'default', 'gpt-second-only')).toBe(true);
    for (const model of ['gpt-second-only', 'chatgpt/gpt-second-only']) {
      const lease = await acquireSubscriptionAccount('openai', model, []);
      expect(lease?.accountId).toBe('second');
      const apply = vi.fn(async () => {});
      await expect(lease?.changeModel('default-only', apply)).rejects.toThrow('does not offer this model');
      expect(apply).not.toHaveBeenCalled();
      lease?.release();
      h.bindings.set('task:replace', { providerId: 'openai', accountId: 'default' });
      const replacement = await acquireSubscriptionAccount('openai', model, ['task:replace'], false, { resuming: false });
      expect(replacement?.accountId).toBe('second');
      replacement?.release();
    }
  });

  // PR #10327 review: failed discovery was cached as valid empty membership.
  // Unit: retry without an auth change, retain only this login's LKG, and let
  // the public manual refresh force a fresh read rather than reusing failure.
  it('recovers transient model reads in the same auth snapshot and supports manual retry', async () => {
    vi.useFakeTimers();
    try {
      h.pools.openai = { strategy: 'order', accounts: [{ ...account('default'), paused: true }, account('second')] };
      await refreshSubscriptionPool('openai');
      h.rpc.mockRejectedValueOnce(new Error('temporary read failure'))
        .mockResolvedValue({ data: [{ id: 'gpt-recovered' }], nextCursor: null });
      await refreshSubscriptionPoolCodexModels();
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
      expect(readSubscriptionAccountBlocked('openai', 'second', 'gpt-recovered')).toBe(false);
      await vi.advanceTimersByTimeAsync(3_000);
      await refreshSubscriptionPoolCodexModels();
      expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['gpt-recovered']);
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
      const before = h.read.mock.calls.length;
      const nativeRefresh = vi.fn();
      const agent = withSubscriptionAccounts({ kind: 'codex', refreshLocalModels: nativeRefresh } as unknown as BaseAgent);
      let started!: () => void;
      const entered = new Promise<void>(resolve => { started = resolve; });
      let complete!: (value: unknown) => void;
      h.rpc.mockImplementationOnce(() => { started(); return new Promise(resolve => { complete = resolve; }); });
      const callsBeforeRefresh = h.rpc.mock.calls.length;
      const manual = agent.refreshLocalModels();
      const joined = agent.refreshLocalModels();
      await entered;
      complete({ data: [{ id: 'gpt-recovered' }], nextCursor: null });
      expect(await Promise.all([manual, joined])).toEqual([true, true]);
      expect(h.rpc).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
      h.rpc.mockRejectedValueOnce(new Error('another temporary failure'));
      expect(await agent.refreshLocalModels()).toBe(false);
      expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['gpt-recovered']);
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
      expect(await agent.refreshLocalModels()).toBe(true);
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
      expect(h.read).toHaveBeenCalledTimes(before);
      h.rpc.mockResolvedValue({ data: [], nextCursor: null });
      expect(await agent.refreshLocalModels()).toBe(true);
      expect(readSubscriptionPoolCodexModels()).toEqual([]);
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
      const calls = h.rpc.mock.calls.length;
      await vi.advanceTimersByTimeAsync(3_000);
      await refreshSubscriptionPoolCodexModels();
      expect(h.rpc).toHaveBeenCalledTimes(calls);
    } finally { vi.useRealTimers(); }
  });

  it('publishes only healthy saved accounts, restores the default, and fails closed without a healthy account', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
    let defaultHealthy = false;
    let secondHealthy = true;
    h.read.mockImplementation(async (_provider: string, directory: string) => ({
      authenticated: directory.endsWith('default') ? defaultHealthy : secondHealthy,
      identity: directory,
    }));
    h.rpc.mockImplementation(async (directory: string, method: string, params: { cursor: string | null }) => {
      expect(method).toBe('model/list');
      return { data: [{ id: directory.endsWith('default') ? 'default-model' : params.cursor ? 'second-page' : 'healthy-model' }],
        nextCursor: directory.endsWith('second') && !params.cursor ? 'page-2' : null };
    });
    h.modelCacheRead.mockImplementation(async (file: string) => JSON.stringify({ models: [{
      slug: 'healthy-model', visibility: 'list', supported_in_api: true,
      context_window: file.includes('second') ? 600_000 : 100_000,
      input_modalities: ['text', 'image'],
    }, { slug: 'cache-only-model', visibility: 'list', supported_in_api: true }] }));
    await refreshSubscriptionPool('openai');
    await Promise.all([refreshSubscriptionPoolCodexModels(), refreshSubscriptionPoolCodexModels()]);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['healthy-model', 'second-page']);
    expect(readSubscriptionPoolCodexModels()?.[0]).toMatchObject({ contextWindow: 600_000, supportsImageInput: true });
    expect(h.rpc).toHaveBeenCalledTimes(2);
    const lease = await acquireSubscriptionAccount('openai', 'healthy-model', [], false, { remote: true });
    expect(lease?.account.configDir).toBe('openai/second');
    lease?.release();
    defaultHealthy = true;
    await refreshSubscriptionPool('openai', true);
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['default-model', 'healthy-model', 'second-page']);
    resetDefaultSubscriptionCodexDiscovery(false);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['healthy-model', 'second-page']);
    resetDefaultSubscriptionCodexDiscovery(true);
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    h.pools.openai.accounts[1].paused = true;
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['default-model']);
    defaultHealthy = false;
    secondHealthy = false;
    await refreshSubscriptionPool('openai', true);
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    await expect(acquireSubscriptionAccount('openai', 'healthy-model', [])).rejects.toThrow('No subscription account');
    h.owner = 'other-owner';
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
  });

  // PR #10405, unit: global discovery leaked model membership across separately created providers
  // and disconnected OpenAI stopped every provider. Existing discovery tests used one provider.
  it('discovers only each provider models and keeps independent discovery alive when OpenAI is disconnected', async () => {
    const providerId = 'openai-sub-12345678';
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.created[providerId] = { kind: 'openai', name: 'Separate', account: 'second' };
    h.placement['openai:second'] = providerId;
    let revision = 1;
    h.rpc.mockImplementation(async (directory: string) => ({ data: [{ id: `${directory}-${revision}` }] }));
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPool(providerId);
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['openai/default-1']);
    expect(readSubscriptionPoolCodexModels(providerId)?.map(m => m.id)).toEqual(['openai/second-1']);
    const before = readSubscriptionPoolCodexModels(providerId);
    expect(readSubscriptionPoolCodexModels(providerId)).toBe(before);
    h.pools.openai.disconnected = true;
    await refreshSubscriptionPoolCodexModels();
    const changed = vi.fn();
    const stop = onSubscriptionPoolCodexModelsChanged(changed);
    try {
      revision = 2;
      await refreshSubscriptionPoolCodexModels(true);
      expect(readSubscriptionPoolCodexModels()).toEqual([]);
      expect(readSubscriptionPoolCodexModels(providerId)?.map(m => m.id)).toEqual(['openai/second-2']);
      expect(changed).toHaveBeenCalledOnce();
    } finally { stop(); }
  });

  // PR #10405, unit: the full routing catalog must retain a moved account's unique model for
  // recorded history without offering that model through the empty source to new/guest tasks.
  it('retains only bound account models in the full routing view of a merged provider', async () => {
    const providerId = 'openai-sub-12345678';
    h.pools.openai = { strategy: 'order', accounts: ['default', 'second', 'third', 'unrelated'].map(account) };
    h.created[providerId] = { kind: 'openai', name: 'Merged', account: 'second' };
    h.bindings.set('native:old-third', { providerId: 'openai', via: providerId, accountId: 'third' });
    h.rpc.mockImplementation(async (directory: string) => ({ data: [{ id: `${directory}-model` }] }));
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels(providerId)?.map(m => m.id)).toEqual(['openai/second-model']);
    const full = readSubscriptionPoolCodexModels(providerId, { includeBoundAccounts: true });
    expect(full?.map(m => m.id)).toEqual(['openai/second-model', 'openai/third-model']);
    expect(readSubscriptionPoolCodexModels(providerId, { includeBoundAccounts: true })).toBe(full);
    expect(readSubscriptionPoolCodexModels(providerId)?.map(m => m.id)).toEqual(['openai/second-model']);
    h.pools.openai.accounts.find(a => a.id === 'third')!.paused = true;
    expect(readSubscriptionPoolCodexModels(providerId, { includeBoundAccounts: true })?.map(m => m.id)).toEqual(['openai/second-model', 'openai/third-model']);
    // A restart must rediscover metadata for historical paused profiles without selecting them.
    h.owner += '-restart';
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels(providerId)?.map(m => m.id)).toEqual(['openai/second-model']);
    expect(readSubscriptionPoolCodexModels(providerId, { includeBoundAccounts: true })?.map(m => m.id)).toEqual(['openai/second-model', 'openai/third-model']);
    h.read.mockImplementation(async (_kind: string, directory: string) => ({ authenticated: !directory.endsWith('second'), identity: directory }));
    await refreshSubscriptionPool('openai', true);
    await refreshSubscriptionPoolCodexModels();
    expect(hasConnectedSubscriptionPool(providerId)).toBe(false);
    expect(hasConnectedSubscriptionPool(providerId, { includeBoundAccounts: true })).toBe(true);
    // Built-in bindings omit via. Taking that account out still keeps its model in the old
    // source's history view, without making it selectable through the built-in pool again.
    h.bindings.set('native:builtin-old', { providerId: 'openai', accountId: 'third' });
    h.placement['openai:third'] = 'openai-sub-87654321';
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).not.toContain('openai/third-model');
    expect(readSubscriptionPoolCodexModels('openai', { includeBoundAccounts: true })?.map(m => m.id)).toContain('openai/third-model');
    h.pools.openai.disconnected = true;
    expect(hasConnectedSubscriptionPool('openai')).toBe(false);
    expect(hasConnectedSubscriptionPool('openai', { includeBoundAccounts: true })).toBe(true);
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    expect(readSubscriptionPoolCodexModels('openai', { includeBoundAccounts: true })?.map(m => m.id)).toEqual(['openai/third-model']);
  });

  it('drops stale in-flight discovery on owner/login changes and never publishes partial or failed lists', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('second')] };
    await refreshSubscriptionPool('openai');
    let complete!: (value: unknown) => void;
    h.rpc.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const old = refreshSubscriptionPoolCodexModels();
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    h.owner = 'next-owner';
    complete({ data: [{ id: 'old-owner-model' }], nextCursor: null });
    await old;
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    await refreshSubscriptionPool('openai');
    h.rpc.mockImplementation(async (_directory: string, _method: string, params: { cursor: string | null }) => {
      if (params.cursor) throw new Error('model list failed');
      return { data: [{ id: 'partial-model' }], nextCursor: 'next' };
    });
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    const calls = h.rpc.mock.calls.length;
    await refreshSubscriptionPoolCodexModels();
    expect(h.rpc).toHaveBeenCalledTimes(calls);
    await refreshSubscriptionPool('openai', true);
    h.rpc.mockResolvedValue({ data: [{ id: 'new-owner-model' }], nextCursor: null });
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['new-owner-model']);
    await refreshSubscriptionPool('openai', true);
    h.rpc.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const callsBeforeLogin = h.rpc.mock.calls.length;
    const beforeLogin = refreshSubscriptionPoolCodexModels();
    await vi.waitFor(() => expect(h.rpc.mock.calls.length).toBeGreaterThan(callsBeforeLogin));
    h.read.mockResolvedValue({ authenticated: true, identity: 'different-login' });
    await refreshSubscriptionPool('openai', true);
    complete({ data: [{ id: 'stale-login-model' }], nextCursor: null });
    await beforeLogin;
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    h.pools.openai.disconnected = true;
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
  });

  // Unit timing regression: local-control can revoke the default credential
  // while the pool's earlier account/read is still in flight. Its late success
  // must not restore default-only membership over the healthy second account.
  it('keeps a revoked default excluded when an earlier auth read finishes late', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
    h.rpc.mockImplementation(async (directory: string) => ({ data: [{ id: directory }], nextCursor: null }));
    await refreshSubscriptionPool('openai');
    await refreshSubscriptionPoolCodexModels();
    let finishAuth!: (value: unknown) => void;
    h.read.mockImplementation(async (_provider: string, directory: string) => directory.endsWith('default')
      ? new Promise(resolve => { finishAuth = resolve; }) : { authenticated: true, identity: 'account' });
    const reading = refreshSubscriptionPool('openai', true);
    resetDefaultSubscriptionCodexDiscovery(false);
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['openai/second']);
    finishAuth({ authenticated: true, identity: 'account' });
    await reading;
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['openai/second']);
  });
});

// Regression: added OpenAI accounts had neither reset RPC routing nor an automatic
// redemption path. Unit/in-process integration through the real service and engine;
// the native CLI transport is the only replacement, so no real credit is consumed.
describe('pooled Codex resets', () => {
  // Unit regression: a completed reset on the original connection must bypass
  // the warm quota and notify observers, including the implicit default slot.
  it.each([
    { scope: 'openai', accountId: 'default', configured: true },
    { scope: 'openai-old', accountId: 'second', configured: true },
    { scope: 'openai', accountId: 'default', configured: false },
  ])('publishes fresh quota after resetting $scope (configured pool: $configured)', async ({ scope, accountId, configured }) => {
    if (configured) h.pools.openai = {
      strategy: 'least',
      accounts: [account('default'), account('second')],
      legacyCodexAccounts: { 'openai-old': 'second' },
    };
    let redeemed = false;
    const resetsAt = Math.floor(Date.now() / 1000) + 86_400;
    h.usage.mockImplementation(async (_provider, directory: string) => ({
      codexUsage: providerGroupCodexUsageFromReads(null, {
        rateLimits: {
          limitId: 'codex',
          secondary: {
            usedPercent: redeemed && directory.endsWith(accountId) ? 0 : 100,
            windowDurationMins: 10_080,
            resetsAt,
          },
        },
      }, Date.now()),
    }));
    const weeklyUsage = (view: Awaited<ReturnType<typeof readSubscriptionPool>>) =>
      Object.fromEntries(view.accounts.map(entry =>
        [entry.id, entry.usage?.codex?.buckets.codex.secondary?.usedPercent]));
    const initialUsage = configured ? { default: 100, second: 100 } : { default: 100 };
    expect(weeklyUsage(await readSubscriptionPool('openai'))).toEqual(initialUsage);
    const updates: Promise<Awaited<ReturnType<typeof readSubscriptionPool>>>[] = [];
    const unsubscribe = onSubscriptionAccountsChanged((provider, resetAccountId) => {
      if (provider === 'openai' && resetAccountId === accountId) updates.push(readSubscriptionPool('openai'));
    });
    try {
      redeemed = true;
      await refreshCodexSubscriptionAccountAfterReset(scope);
      expect((await Promise.all(updates)).map(weeklyUsage)).toEqual([{ ...initialUsage, [accountId]: 0 }]);
      expect(h.usage.mock.calls).toHaveLength(configured ? 3 : 2);
    } finally {
      unsubscribe();
    }
  });

  // Unit regression: a manual refresh started before redemption can return the old
  // window. The reset notification must let observers read the renewed window.
  it('publishes renewed default Codex quota after a pre-reset refresh finishes', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default')] };
    const now = Date.now();
    const quota = (usedPercent: number, remainingDays: number) => ({
      codexUsage: providerGroupCodexUsageFromReads(null, {
        rateLimits: {
          limitId: 'codex',
          secondary: {
            usedPercent,
            windowDurationMins: 10_080,
            resetsAt: Math.floor(now / 1000) + remainingDays * 86_400,
          },
        },
      }, now),
    });
    const exhausted = quota(100, 2);
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let finish!: (value: typeof exhausted) => void;
    const pending = new Promise<typeof exhausted>(resolve => { finish = resolve; });
    h.usage.mockImplementationOnce(() => {
      started();
      return pending;
    });
    h.usage.mockResolvedValue(quota(0, 7));
    const weeklyUsed = (view: Awaited<ReturnType<typeof readSubscriptionPool>>) =>
      view.accounts[0]?.usage?.codex?.buckets.codex.secondary?.usedPercent;
    const updates: Promise<Awaited<ReturnType<typeof readSubscriptionPool>>>[] = [];
    const unsubscribe = onSubscriptionAccountsChanged((provider, accountId) => {
      if (provider === 'openai' && accountId === 'default') updates.push(readSubscriptionPool('openai'));
    });
    try {
      const preResetRefresh = refreshSubscriptionPool('openai', true);
      await reading;
      const resetRefresh = refreshCodexSubscriptionAccountAfterReset('openai');
      finish(exhausted);
      expect(weeklyUsed(await preResetRefresh)).toBe(100);
      await resetRefresh;
      expect((await Promise.all(updates)).map(weeklyUsed)).toEqual([0]);
    } finally {
      unsubscribe();
    }
  });

  it('reads, automatically redeems and refreshes only the selected account', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second'), account('third')] };
    const redeemed = new Set<string>();
    const now = Date.now();
    const response = (directory: string) => ({
      rateLimits: { secondary: { usedPercent: redeemed.has(directory) ? 0 : 100,
        windowDurationMins: 10080, resetsAt: now / 1000 + 4 * 86400 } },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: redeemed.has(directory) ? 0 : 1, credits: redeemed.has(directory) ? [] : [{
        id: directory + '-credit', status: 'available', resetType: 'codexRateLimits',
        grantedAt: 1, expiresAt: now / 1000 + 86400, title: null, description: null,
      }] },
    });
    h.rpc.mockImplementation(async (directory: string, method: string) => {
      if (method === 'account/rateLimits/read') return response(directory);
      redeemed.add(directory);
      return { outcome: 'reset' };
    });
    const second = pooledCodexResetTarget('openai-account:second')!;
    const third = pooledCodexResetTarget('openai-account:third')!;
    const services = new Map([
      ['openai-account:second', createCodexRateLimitResetService(second)],
      ['openai-account:third', createCodexRateLimitResetService(third)],
    ]);
    const record = vi.fn();
    const engine = new CodexResetAutoUse({
      scope: () => h.owner, now: () => now,
      read: async scope => ({ ...await services.get(scope)!.read(), autoUse: {
        accountKey: scope, settings: { ...DEFAULT_CODEX_RESET_AUTO_USE, enabled: scope.endsWith(':second') },
        customized: true, lastUsedAt: null,
      } }),
      authorized: (_scope, value) => value.autoUse!.settings.enabled,
      consume: (scope, key, authorized) => services.get(scope)!.consume(key, authorized),
      record, refreshWeb: () => second.refresh(), restored: async () => {}, warn: vi.fn(),
    });
    await Promise.all([engine.check('openai-account:second'), engine.check('openai-account:third')]);
    expect([...redeemed]).toEqual(['openai/second']);
    expect(record).toHaveBeenCalledOnce();
    expect(h.usage).toHaveBeenCalledWith('openai', 'openai/second');
    const thirdOffer = (await services.get('openai-account:third')!.read()).resetOffer!;
    await services.get('openai-account:third')!.consume(thirdOffer.idempotencyKey);
    expect([...redeemed]).toEqual(['openai/second', 'openai/third']);
    expect(h.rpc.mock.calls.filter(([, method]) => method === 'account/rateLimitResetCredit/consume')
      .map(([directory, , params]) => [directory, params.creditId])).toEqual([
        ['openai/second', 'openai/second-credit'], ['openai/third', 'openai/third-credit'],
      ]);
    expect(h.rpc.mock.calls.some(([directory]) => directory === 'openai/default')).toBe(false);
  });

  it.each(['removed', 'disconnected', 'owner', 'login'] as const)('rejects a retained reset target after %s', async reason => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
    const target = pooledCodexResetTarget('openai-account:second')!;
    if (reason === 'removed') h.pools.openai.accounts.pop();
    if (reason === 'disconnected') h.pools.openai.disconnected = true;
    if (reason === 'owner') h.owner += '-changed';
    if (reason === 'login') {
      h.login.mockImplementation(() => new Promise(() => {}));
      void runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'second', loginKey: 'reset-test' }).catch(() => {});
      await Promise.resolve();
    }
    await expect(target.consumeResetCredit({ creditId: 'credit', idempotencyKey: 'key' })).rejects.toThrow();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it('keeps imported connections on their original reset lock and preference key', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')], legacyCodexAccounts: { 'openai-old': 'second' } };
    const view = await readSubscriptionPool('openai');
    expect(view.accounts[1].codexResetProviderId).toBe('openai-old');
    expect(() => pooledCodexResetTarget('openai-account:second')).toThrow('original account connection');
  });

  it('wakes only a task bound to the restored account and requires known quota', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
    h.bindings.set('task:mine', { providerId: 'openai', accountId: 'second' });
    expect(await hasRestoredPooledCodexQuota('openai-account:second', 'other', null)).toBe(false);
    expect(await hasRestoredPooledCodexQuota('openai-account:second', 'mine', null)).toBe(false);
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { codex: { limitId: 'codex',
      updatedAt: Date.now(), primary: null, secondary: { usedPercent: 5, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 86400 },
    } } } });
    await pooledCodexResetTarget('openai-account:second')!.refresh();
    expect(await hasRestoredPooledCodexQuota('openai-account:second', 'mine', null)).toBe(true);
  });
});

// Standard: explicit Claude re-login used to be a no-op for connected accounts.
// Two independent profiles expose cross-account renewal and wrong-browser-account
// regressions that the existing add/connect tests did not exercise.
describe('Claude account renewal', () => {
  const firstExpiry = '2030-02-01T00:00:00.000Z';
  const secondExpiry = '2030-01-05T00:00:00.000Z';
  const renewedExpiry = '2030-02-05T00:00:00.000Z';
  // PR #10086 / Greptile, standard: the existing failure/restart test saved
  // identity only after renewal started. A normal logout before restarting
  // lost that identity and allowed a different browser account into the slot.
  it('keeps the last confirmed identity across logout and restart before renewal', async () => {
    let secondIdentity: string | undefined = 'second@example.test';
    h.read.mockImplementation(async (_provider, directory) => ({
      authenticated: directory === 'anthropic/default' || !!secondIdentity,
      identity: directory === 'anthropic/default' ? 'first@example.test' : secondIdentity,
    }));
    await readSubscriptionPool('anthropic');
    secondIdentity = undefined;
    h.owner = 'owner-a:' + ++generation;
    expect((await readSubscriptionPool('anthropic')).accounts[1]).toMatchObject({
      status: 'signed-out', identity: 'second@example.test',
    });
    h.login.mockImplementationOnce(async () => { secondIdentity = 'wrong@example.test'; });
    await expect(runSubscriptionAccountCommand({ action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'after-restart' }))
      .rejects.toThrow('account_mismatch');
    expect(h.login).toHaveBeenCalledExactlyOnceWith('anthropic', 'anthropic/second', expect.any(AbortSignal),
      { renew: true, expectedEmail: 'second@example.test' });
    expect(h.clearCooling).not.toHaveBeenCalled();
    expect((await readSubscriptionPool('anthropic')).accounts[1].status).toBe('signed-out');
  });

  it('refuses renewal with no known identity before changing the CLI profile', async () => {
    h.read.mockResolvedValue({ authenticated: false });
    await expect(runSubscriptionAccountCommand({ action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'unknown' }))
      .rejects.toThrow('account_identity_unknown');
    expect(h.login).not.toHaveBeenCalled();
    expect(h.clearCooling).not.toHaveBeenCalled();
  });

  // Standard: identity persistence adds a write after the auth await. A late
  // CLI response from the previous owner must not update the new owner's pool.
  it('does not save a late CLI identity after the owner changes', async () => {
    h.pools.anthropic!.accounts = [account('default')];
    let finish!: (auth: { authenticated: boolean; identity: string }) => void;
    h.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = readSubscriptionPool('anthropic');
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledOnce());
    h.owner = 'different-owner:' + ++generation;
    h.pools.anthropic = { strategy: 'least', accounts: [account('default')] };
    finish({ authenticated: true, identity: 'previous-owner@example.test' });
    await expect(pending).rejects.toThrow('owner changed');
    expect(h.pools.anthropic.accounts[0]).not.toHaveProperty('lastConfirmedIdentity');
  });

  // Standard, independent PR #10086 review: snapshot guards covered new leases,
  // but an idle live handle could send through a profile being renewed or left
  // on the wrong identity. Exercise the real wrapper, not its guard in isolation.
  it.each(['account_mismatch', 'login_cancelled'])('protects an existing handle during renewal and after %s', async reason => {
    h.pools.anthropic!.accounts = [account('second')];
    let identity = 'second@example.test';
    h.read.mockImplementation(async () => ({ authenticated: true, identity }));
    const nativeSend = vi.fn(async () => {});
    const handle = await withSubscriptionAccounts({
      kind: 'claude-code', startSession: async () => ({
        id: 'existing', send: nativeSend, close: async () => {},
        events: async function* () { yield { type: 'done', data: {} }; },
      }),
    } as unknown as BaseAgent).startSession({ providerId: 'anthropic', sessionId: 'existing' } as StartSessionOptions);
    for await (const event of handle.events()) expect(event.type).toBe('done');
    let finish!: () => void;
    h.login.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (reason === 'account_mismatch') identity = 'wrong@example.test';
      throw new Error(reason);
    });
    const renewal = runSubscriptionAccountCommand({ action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'existing-renewal' });
    await vi.waitFor(() => expect(h.login).toHaveBeenCalledOnce());
    await expect(handle.send({ type: 'user', content: 'during renewal' })).rejects.toThrow('SUBSCRIPTION_ACCOUNT_SIGNING_IN');
    finish();
    await expect(renewal).rejects.toThrow(reason);
    await readSubscriptionPool('anthropic');
    if (reason === 'account_mismatch') {
      await expect(handle.send({ type: 'user', content: 'after wrong login' })).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED');
      expect(nativeSend).not.toHaveBeenCalled();
    } else {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
      try {
        await handle.send({ type: 'user', content: 'original identity confirmed after cancellation' });
        expect(nativeSend).toHaveBeenCalledOnce();
        for await (const event of handle.events()) expect(event.type).toBe('done');
      } finally { clock.mockRestore(); }
    }
    h.login.mockImplementationOnce(async () => { identity = 'second@example.test'; });
    await runSubscriptionAccountCommand({ action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'restore' });
    await handle.send({ type: 'user', content: 'original account restored' });
    expect(nativeSend).toHaveBeenCalledTimes(reason === 'account_mismatch' ? 1 : 2);
    await handle.close();
  });

  it('renews only the selected account and keeps the other expiry and settings', async () => {
    let renewed = false;
    h.read.mockImplementation(async (_provider, directory) => ({
      authenticated: true,
      identity: directory === 'anthropic/default' ? 'first@example.test' : 'second@example.test',
      loginExpiresAt: directory === 'anthropic/default' ? firstExpiry : renewed ? renewedExpiry : secondExpiry,
    }));
    const before = await readSubscriptionPool('anthropic');
    h.login.mockImplementation(async () => { renewed = true; });
    const after = await runSubscriptionAccountCommand({
      action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'renew-second',
    });
    expect(h.login).toHaveBeenCalledExactlyOnceWith('anthropic', 'anthropic/second', expect.any(AbortSignal),
      { renew: true, expectedEmail: 'second@example.test' });
    expect(after.accounts[0]).toEqual(before.accounts[0]);
    expect(after.accounts[1]).toMatchObject({ identity: 'second@example.test', loginExpiresAt: renewedExpiry, status: 'ready' });
    expect(h.pools.anthropic?.accounts[1].reloginIdentity).toBeUndefined();
    expect(h.clearCooling).toHaveBeenCalledExactlyOnceWith('anthropic', 'second');
  });

  it.each(['account_mismatch', 'login_cancelled'])('keeps the selected identity after %s, including a restart and retry', async reason => {
    let secondIdentity = 'second@example.test';
    h.read.mockImplementation(async (_provider, directory) => ({
      authenticated: true,
      identity: directory === 'anthropic/default' ? 'first@example.test' : secondIdentity,
      loginExpiresAt: firstExpiry,
    }));
    await readSubscriptionPool('anthropic');
    h.usage.mockClear();
    h.login.mockImplementationOnce(async () => {
      secondIdentity = 'wrong@example.test';
      throw new Error(reason);
    });
    await expect(runSubscriptionAccountCommand({ action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'wrong' }))
      .rejects.toThrow(reason);
    h.owner = 'owner-a:' + ++generation; // Rebuild in-memory state from the saved pool.
    const after = await readSubscriptionPool('anthropic');
    expect(after.accounts[0]).toMatchObject({ status: 'ready', identity: 'first@example.test', loginExpiresAt: firstExpiry });
    expect(after.accounts[1]).toMatchObject({ status: 'signed-out', identity: 'second@example.test', authIssue: 'claude-account-mismatch' });
    expect(after.accounts[1].loginExpiresAt).toBeUndefined();
    expect(h.usage).not.toHaveBeenCalledWith('anthropic', 'anthropic/second');
    const lease = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', []);
    expect(lease?.account.configDir).toBe('anthropic/default');
    lease?.release();
    h.login.mockImplementationOnce(async (_provider, _directory, _signal, options) => {
      expect(options.expectedEmail).toBe('second@example.test');
      secondIdentity = 'second@example.test';
    });
    const retried = await runSubscriptionAccountCommand({ action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'correct' });
    expect(retried.accounts[1]).toMatchObject({ status: 'ready', identity: 'second@example.test' });
    expect(retried.accounts[1].authIssue).toBeUndefined();
    expect(h.pools.anthropic?.accounts[1].reloginIdentity).toBeUndefined();
  });
});

// #10110 review, unit: the overview refresh must cross the real runtime cache.
// Earlier tests replaced the pool DTO, hiding the 30s/180s cache and lost legacy
// plan. Minimal inputs: cached quota then an upstream change; legacy auth without plan.
describe('quota overview account reads', () => {
  it('refreshes after an older account read already in flight instead of joining its stale result', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default')] };
    const quota = (used: number) => ({ codexUsage: { appServerBuckets: { codex: { primary: null,
      secondary: { usedPercent: used, windowMinutes: 10_080, resetsAt: Date.now() / 1000 + 3600 },
    } } } });
    let finish!: (value: ReturnType<typeof quota>) => void;
    h.usage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const normal = readSubscriptionPool('openai');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    h.usage.mockResolvedValue(quota(70));
    const refresh = refreshSubscriptionPool('openai', true);
    finish(quota(20));
    await normal;
    expect((await refresh).accounts[0].usage?.codex?.buckets.codex.secondary?.usedPercent).toBe(70);
    expect(h.usage).toHaveBeenCalledTimes(2);
  });

  it.each(['anthropic', 'openai'] as const)('refreshes cached %s quota and coalesces concurrent refreshes', async provider => {
    h.pools[provider] = { strategy: 'least', accounts: [account('default')] };
    const quota = (used: number) => provider === 'anthropic'
      ? { claudeUsage: { sevenDay: { utilization: used, resetsAt: Date.now() / 1000 + 3600 } } }
      : { codexUsage: { appServerBuckets: { codex: { primary: null, secondary: {
          usedPercent: used, windowMinutes: 10_080, resetsAt: Date.now() / 1000 + 3600,
        } } } } };
    h.usage.mockResolvedValue(quota(20));
    await readSubscriptionPool(provider);
    const count = h.usage.mock.calls.length;
    h.usage.mockResolvedValue(quota(70));
    await readSubscriptionPool(provider);
    expect(h.usage).toHaveBeenCalledTimes(count);
    const [first, second] = await Promise.all([
      refreshSubscriptionPool(provider, true), refreshSubscriptionPool(provider, true),
    ]);
    const used = (view: typeof first) => provider === 'anthropic'
      ? view.accounts[0].usage?.claude?.sevenDay?.utilization
      : view.accounts[0].usage?.codex?.buckets.codex.secondary?.usedPercent;
    expect([used(first), used(second)]).toEqual([70, 70]);
    expect(h.usage).toHaveBeenCalledTimes(count + 1);
    expect(used(await readSubscriptionPool(provider))).toBe(70);
  });

  it('keeps the legacy default plan from its own quota in the menu bar', async () => {
    h.pools.openai = { strategy: 'least', legacyCodexDefault: true, accounts: [account('default')] };
    h.usage.mockResolvedValue({ codexPlan: 'pro', codexUsage: { appServerBuckets: { codex: {
      primary: null, secondary: { usedPercent: 40, windowMinutes: 10_080, resetsAt: Date.now() / 1000 + 3600 },
    } } } });
    const view = await readSubscriptionPool('openai');
    expect(subscriptionPoolSources({ id: 'openai' } as ProviderView, view, Date.now())).toMatchObject([
      { account: 'original@example.com', plan: 'Pro', windows: [{ usedPercent: 40 }] },
    ]);
    expect(h.usage).toHaveBeenCalledWith('openai', '/existing-cindy/codex-home');
    expect(h.read).not.toHaveBeenCalled();
  });
});

// PR #9998 review, unit: prior tests released preparation leases immediately and
// never tried a competing start between account binding and runtime takeover.
// Two accounts with limit 1 reproduce both the handoff gap and first-send gap.
describe('account handoff concurrency', () => {
  it.each(['quota', 'paused'] as const)('keeps the %s handoff reserved through runtime takeover and the first message', async cause => {
    h.pools.anthropic!.accounts = h.pools.anthropic!.accounts.map(a => ({ ...a, limitSet: true }));
    const original = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', []);
    await original!.bind(['task:moving']);
    original!.observeFailure({ sdkError: 'rate_limit' }, 'claude-sonnet', 'run');
    original!.release();
    if (cause === 'paused') h.pools.anthropic!.accounts[0].paused = true;
    const row = { status: 'active', providerId: 'anthropic', agentKind: 'cc', model: 'claude-sonnet', sdkSessionId: null,
      title: null, userSendAt: null, workingDir: null, workspaceKind: null };
    const deps = { readSession: async () => row, isRunning: () => false, rebuild: async () => {} };
    const prepare = cause === 'quota' ? prepareSubscriptionAccountFailover : prepareSubscriptionAccountForSend;
    expect(await prepare('moving', deps)).toBe(true);
    await expect(acquireSubscriptionAccount('anthropic', row.model, ['task:competing'])).rejects.toThrow('SUBSCRIPTION_ACCOUNTS_FULL');
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async () => ({
      id: 'replacement', send: async () => {}, close: async () => {},
      events: async function* () { yield { type: 'done', data: {} }; },
    }) } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'anthropic', model: row.model, sessionId: 'moving' } as StartSessionOptions);
    expect((await readSubscriptionPool('anthropic')).accounts.map(a => a.running)).toEqual([0, 1]);
    await expect(acquireSubscriptionAccount('anthropic', row.model, ['task:competing'])).rejects.toThrow('SUBSCRIPTION_ACCOUNTS_FULL');
    await handle.send({ type: 'user', content: 'continue' });
    for await (const event of handle.events()) expect(event.type).toBe('done');
    const next = await acquireSubscriptionAccount('anthropic', row.model, ['task:competing']);
    expect(next?.accountId).toBe('second');
    next?.release();
    await handle.close();
  });

  it('expires an abandoned handoff and rechecks its limit before a late takeover', async () => {
    vi.useFakeTimers();
    try {
      h.pools.anthropic!.accounts = h.pools.anthropic!.accounts.map(a => ({ ...a, limitSet: true }));
      h.bindings.set('task:moving', { providerId: 'anthropic', accountId: 'default' });
      h.pools.anthropic!.accounts[0].paused = true;
      await prepareSubscriptionAccountForSend('moving', {
        readSession: async () => ({ status: 'active', providerId: 'anthropic', agentKind: 'cc' } as SessionRowSnapshot),
        isRunning: () => false, rebuild: async () => {},
      });
      await vi.advanceTimersByTimeAsync(30_001);
      const competing = await acquireSubscriptionAccount('anthropic', undefined, ['task:competing']);
      expect(competing?.accountId).toBe('second');
      await expect(acquireSubscriptionAccount('anthropic', undefined, ['task:moving'])).rejects.toThrow('SUBSCRIPTION_ACCOUNTS_FULL');
      competing?.release();
      const takeover = await acquireSubscriptionAccount('anthropic', undefined, ['task:moving']);
      expect(takeover?.accountId).toBe('second');
      takeover?.release();
    } finally { vi.useRealTimers(); }
  });

  // Login used to clear memory only, so the old persisted cooldown reappeared.
  it('clears persisted cooling when an account reconnects', async () => {
    h.cooling = { anthropic: { second: { '': Date.now() + 60_000 } } };
    await runSubscriptionAccountCommand({ action: 'login', providerId: 'anthropic', accountId: 'second', loginKey: 'reconnect' });
    expect(h.clearCooling).toHaveBeenCalledExactlyOnceWith('anthropic', 'second');
  });
});

// Unit, 2026-11-11 pause report: exercise the pre-send probe and real agent
// wrapper. Earlier coverage intentionally kept paused native sessions pinned;
// now the host must hand off first, then a fresh context may choose another account.
const needsSubscriptionAccountHandoff = (id: string, row: Parameters<typeof probeSubscriptionAccountHandoff>[1]) => probeSubscriptionAccountHandoff(id, row, h.remote);

describe('paused account next-turn handoff', () => {
  it.each(['anthropic', 'openai'] as const)('moves a fresh %s context while preserving native history ownership', async provider => {
    h.pools[provider] = { strategy: 'order', accounts: [account('default'), account('second')] };
    const first = await acquireSubscriptionAccount(provider, undefined, []);
    await first!.bind(['task:task-a', 'native:old-history']);
    first!.release();
    h.pools[provider]!.accounts[0].paused = true;
    expect(await needsSubscriptionAccountHandoff('task-a', { providerId: provider, agentKind: provider === 'anthropic' ? 'cc' : 'codex', sdkSessionId: 'old-history' })).toBe(true);
    const next = await acquireSubscriptionAccount(provider, undefined, ['task:task-a'], false, { resuming: false });
    expect(next!.account.configDir).toBe(`${provider}/second`);
    await next!.bind(['task:task-a', 'native:new-history']);
    expect(h.bindings.get('native:old-history')?.accountId).toBe('default');
    expect(h.bindings.get('task:task-a')?.accountId).toBe('second');
    next!.release();
    h.pools[provider]!.accounts[1].paused = true;
    await expect(needsSubscriptionAccountHandoff('task-a', { providerId: provider, agentKind: provider === 'anthropic' ? 'cc' : 'codex', sdkSessionId: 'new-history' })).rejects.toThrow('No subscription account');
  });

  it('checks the executing computer for a paused remote task and leaves shared providers alone', async () => {
    h.remote.mockResolvedValueOnce({ ok: true, result: { providerId: 'anthropic', state: 'bound',
      account: { isDefault: false, number: 2, paused: true, status: 'ready' } } })
      .mockResolvedValueOnce({ ok: true, result: { providerId: 'anthropic', model: 'claude-sonnet', available: true } });
    const row = { providerId: 'anthropic', model: 'claude-sonnet', agentKind: 'cc', sdkSessionId: 'remote-native', agentDeviceId: 'my-other-computer' };
    expect(await needsSubscriptionAccountHandoff('task', row)).toBe(true);
    expect(h.remote.mock.calls[0][2]).toEqual([{ action: 'session', providerId: 'anthropic', routeProviderId: 'anthropic', nativeSessionId: 'remote-native', model: 'claude-sonnet' }]);
    expect(h.bindings.size).toBe(0);
    h.remote.mockClear();
    expect(await needsSubscriptionAccountHandoff('task', { ...row, agentDeviceId: 'share:someone' })).toBe(false);
    expect(h.remote).not.toHaveBeenCalled();
  });

  // Review regressions: replacement is a new authorization route, and remote
  // readiness must use the requested model's bucket rather than generic status.
  it('checks imported replacement permissions as a new route', async () => {
    h.pools.openai = { strategy: 'order', accounts: [{ ...account('default'), paused: true }, account('blocked'), account('allowed')], legacyCodexAccounts: { 'old-blocked': 'blocked' } };
    h.bindings.set('task:paused', { providerId: 'openai', accountId: 'default' });
    h.accountAllowed.mockImplementation((id, model, options) => id !== 'old-blocked' || model !== 'gpt-6' || !options.newRoute);
    const next = await acquireSubscriptionAccount('openai', 'gpt-6', ['task:paused'], false, { resuming: false });
    expect(next!.account.configDir).toBe('openai/allowed');
    expect(h.accountAllowed).toHaveBeenCalledWith('old-blocked', 'gpt-6', expect.objectContaining({ newRoute: true }));
    next!.release();
  });

  // Standard: old controller-side status checks missed remote new-route grants.
  // Exercise the existing executor availability predicate, including quota buckets.
  it.each([
    { limited: false, allowed: true },
    { limited: true, allowed: true },
    { limited: false, allowed: false },
  ])('uses executor quota and permissions before handoff (%j)', async ({ limited, allowed }) => {
    const model = 'gpt-5.3-codex-spark';
    const bucket = (usedPercent: number, limitName: string) => ({ limitName, updatedAt: Date.now(), primary: { usedPercent, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 }, secondary: null });
    h.pools.openai = { strategy: 'order', accounts: [{ ...account('default'), paused: true }, account('imported')], legacyCodexAccounts: { 'old-imported': 'imported' } };
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { codex: bucket(limited ? 5 : 100, 'Codex'), spark: bucket(limited ? 100 : 5, 'GPT-5.3-Codex-Spark') }, webSnapshot: null } });
    h.accountAllowed.mockReturnValue(allowed);
    h.remote.mockResolvedValueOnce({ ok: true, result: { providerId: 'openai', state: 'bound', account: { isDefault: false, number: 1, paused: true, status: 'ready' } } })
      .mockImplementationOnce(async () => ({ ok: true, result: { providerId: 'openai', model, available: await readSubscriptionPoolModelAvailability('openai', model, { remote: true }) } }));
    const result = needsSubscriptionAccountHandoff('task', { providerId: 'openai', agentKind: 'codex', model, sdkSessionId: 'native', agentDeviceId: 'mini' });
    if (!allowed) await expect(result).rejects.toThrow('No subscription account');
    else expect(await result).toBe(true);
    expect(h.remote.mock.calls[1].slice(0, 3)).toEqual(['mini', 'maker:subscription-pool:quota', ['openai', model]]);
    expect(h.accountAllowed).toHaveBeenCalledWith('old-imported', model, { remote: true, ownComputer: false, newRoute: true });
    expect(h.bindings.size).toBe(0);
  });

  it.each([
    { ok: false },
    { ok: true, result: { providerId: 'openai', pooled: true, usage: {} } },
    { ok: true, result: { providerId: 'openai', model: 'other', available: true } },
  ])('keeps the native recovery path when executor confirmation is absent (%j)', async reply => {
    h.remote.mockResolvedValueOnce({ ok: true, result: { providerId: 'openai', state: 'bound', account: { isDefault: false, number: 1, paused: true, status: 'ready' } } }).mockResolvedValueOnce(reply);
    await expect(needsSubscriptionAccountHandoff('task', { providerId: 'openai', agentKind: 'codex', model: 'gpt-6', sdkSessionId: 'native', agentDeviceId: 'mini' })).rejects.toThrow('No subscription account');
    expect(h.bindings.size).toBe(0);
  });

  it('starts a new task on an enabled account even when its draft already has a paused binding', async () => {
    h.bindings.set('task:draft', { providerId: 'anthropic', accountId: 'default' });
    h.pools.anthropic!.accounts[0].paused = true;
    const start = vi.fn<BaseAgent['startSession']>(async () => ({ id: 'new-native', close: async () => {} } as unknown as AgentSessionHandle));
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'anthropic', model: 'claude-sonnet', sessionId: 'draft', workingDir: '.' });
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/second');
    expect(h.bindings.get('task:draft')?.accountId).toBe('second');
    await handle.close();
  });

  it('blocks the next send on an old handle but allows a turn already in progress to finish', async () => {
    const send = vi.fn(async () => {});
    const native = { kind: 'claude-code', startSession: async () => ({ id: 'native', send, close: async () => {} }) } as unknown as BaseAgent;
    const agent = withSubscriptionAccounts(native);
    const handle = await agent.startSession({ providerId: 'anthropic', model: 'claude-sonnet', sessionId: 'task-a', workingDir: '.' });
    await handle.send({ type: 'user', content: 'first' });
    h.pools.anthropic!.accounts[0].paused = true;
    // In-flight protocol calls may still use the selected credentials.
    expect(() => getSessionSubscriptionAccount('task-a')?.assertCurrent()).not.toThrow();
    await expect(handle.send({ type: 'user', content: 'next' })).rejects.toThrow('disabled');
    expect(send).toHaveBeenCalledOnce();
    await handle.close();
  });
});

describe('tasks using imported Codex connections', () => {
  // User upgrade regression 2026-11-11, standard: old IDs must keep their account
  // for resume/fork in all OpenAI engines; prior coverage only tested the CLI default.
  it.each(['codex', 'claude-code', 'pi'] as const)('pins a saved %s connection to its imported account', async kind => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    const close = vi.fn(async () => {});
    const start = vi.fn<BaseAgent['startSession']>(async () => ({ id: 'native-old', close } as unknown as AgentSessionHandle));
    const agent = withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai-old', sessionId: 'old-task', resumeSessionId: 'native-old' } as StartSessionOptions);
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
    expect(h.bindings.get('task:old-task')?.accountId).toBe('imported');
    expect(h.importedRead).toHaveBeenCalledWith('openai-old', 'openai/imported');
    await handle.close();
    h.pools.openai.accounts = [account('default')];
    await expect(agent.startSession({ providerId: 'openai-old', sessionId: 'old-task' } as StartSessionOptions)).rejects.toThrow();
    expect(start).toHaveBeenCalledOnce();
  });

  // Regression (2026-11-22): the writer check must compare against the host the session actually runs on,
  // which carries its subscription account; a route onto another account still compares without it.
  it('checks the thread writer host with the account the session runs on, only for that account', async () => {
    h.pools.openai = {
      strategy: 'round', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    const check = vi.fn<BaseAgent['requiresCodexThreadHostTransfer']>(async () => false);
    const agent = withSubscriptionAccounts({ kind: 'codex', requiresCodexThreadHostTransfer: check } as unknown as BaseAgent);
    const running = { id: 'imported', configDir: 'openai/imported', assertCurrent() {}, readState: async () => ({ authenticated: true }) };
    const release = registerSessionSubscriptionAccount('lane', running);
    try {
      await agent.requiresCodexThreadHostTransfer({ sessionId: 'lane', providerId: 'openai-old', model: 'gpt-5.4', threadId: 't' });
      expect(check.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]).toBe(running);
      await agent.requiresCodexThreadHostTransfer({ sessionId: 'lane', providerId: 'openai', model: 'gpt-5.4', threadId: 't' });
      expect(check.mock.calls[1][0][NATIVE_SUBSCRIPTION_ACCOUNT]).toBe(running);
      h.pools.openai.legacyCodexAccounts = { 'openai-old': 'default' };
      await agent.requiresCodexThreadHostTransfer({ sessionId: 'lane', providerId: 'openai-old', model: 'gpt-5.4', threadId: 't' });
      expect(check.mock.calls[2][0][NATIVE_SUBSCRIPTION_ACCOUNT]).toBeUndefined();
      await agent.requiresCodexThreadHostTransfer({ sessionId: 'other', providerId: 'openai', model: 'gpt-5.4', threadId: 't' });
      expect(check.mock.calls[3][0][NATIVE_SUBSCRIPTION_ACCOUNT]).toBeUndefined();
    } finally { release(); }
  });

  // Review (#12144): a created provider can hold several accounts; its first account is only one of them.
  // A session running on another account of that same provider keeps its own host.
  it('keeps the running account when it is a later account of the target provider', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('second'), account('third'), account('elsewhere')] };
    h.created.cprov = { kind: 'openai', name: 'Team', account: 'second' };
    h.placement['openai:second'] = 'cprov';
    h.placement['openai:third'] = 'cprov';
    const check = vi.fn<BaseAgent['requiresCodexThreadHostTransfer']>(async () => false);
    const agent = withSubscriptionAccounts({ kind: 'codex', requiresCodexThreadHostTransfer: check } as unknown as BaseAgent);
    const running = (id: string) => ({ id, configDir: `openai/${id}`, assertCurrent() {}, readState: async () => ({ authenticated: true }) });
    const third = running('third');
    let release = registerSessionSubscriptionAccount('lane', third);
    try {
      await agent.requiresCodexThreadHostTransfer({ sessionId: 'lane', providerId: 'cprov', model: 'gpt-5.4', threadId: 't' });
      expect(check.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]).toBe(third);
    } finally { release(); }
    release = registerSessionSubscriptionAccount('lane', running('elsewhere'));
    try {
      await agent.requiresCodexThreadHostTransfer({ sessionId: 'lane', providerId: 'cprov', model: 'gpt-5.4', threadId: 't' });
      expect(check.mock.calls[1][0][NATIVE_SUBSCRIPTION_ACCOUNT]).toBeUndefined();
    } finally { release(); }
  });

  // Review (#12144): once the running account is removed, switching the idle task to another source must
  // still reach the target's writer check instead of failing on the stale account.
  it('checks another target normally when the running account was removed', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('default')] };
    const check = vi.fn<BaseAgent['requiresCodexThreadHostTransfer']>(async () => true);
    const agent = withSubscriptionAccounts({ kind: 'codex', requiresCodexThreadHostTransfer: check } as unknown as BaseAgent);
    let removed = false;
    const running = { id: 'gone', configDir: 'openai/gone', readState: async () => ({ authenticated: true }),
      assertCurrent() { if (removed) throw new Error('Subscription account was disconnected'); } };
    const release = registerSessionSubscriptionAccount('lane', running);
    removed = true;
    try {
      await expect(agent.requiresCodexThreadHostTransfer({ sessionId: 'lane', providerId: 'anthropic-api', model: 'm', threadId: 't' }))
        .resolves.toBe(true);
      await expect(agent.requiresCodexThreadHostTransfer({ sessionId: 'lane', providerId: 'openai', model: 'gpt-5.4', threadId: 't' }))
        .resolves.toBe(true);
      expect(check.mock.calls.map(([options]) => options[NATIVE_SUBSCRIPTION_ACCOUNT])).toEqual([undefined, undefined]);
    } finally { release(); }
  });

  it('forks old history through the same imported account and reconnects through its old login', async () => {
    h.pools.openai = {
      strategy: 'round', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    const fork = vi.fn<(options: ForkSdkSessionOptions) => Promise<{ newSdkSessionId: string }>>(async () => ({ newSdkSessionId: 'forked' }));
    const agent = withSubscriptionAccounts({ kind: 'codex', forkSdkSession: fork } as unknown as BaseAgent);
    await agent.forkSdkSession({ providerId: 'openai-old', sourceSdkSessionId: 'old-native' } as ForkSdkSessionOptions);
    expect(fork.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
    expect(h.bindings.get('native:forked')?.accountId).toBe('imported');
    await runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'imported', loginKey: 'reconnect' });
    expect(h.importedLogin).toHaveBeenCalledWith('openai-old', expect.any(AbortSignal));
    expect(h.login).not.toHaveBeenCalled();
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'imported', paused: false });
    expect(h.setLegacyPaused).toHaveBeenCalledWith('openai-old', false);
  });

  it('does not lend an imported account whose old connection disallows remote use', async () => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    h.accountAllowed.mockImplementation((_provider, _model, options) => !options.remote);
    await expect(acquireSubscriptionAccount('openai', 'gpt-model', [], false, { remote: true })).rejects.toThrow('No subscription account');
    const local = await acquireSubscriptionAccount('openai', 'gpt-model', []);
    expect(local?.account.configDir).toBe('openai/imported');
    local?.release();
    h.accountAllowed.mockReturnValue(true);
    const remote = await acquireSubscriptionAccount('openai', 'gpt-model', [], false, { remote: true });
    h.accountAllowed.mockImplementation((_provider, _model, options) => !options.remote);
    await expect(remote!.account.readState()).rejects.toThrow('remote access was revoked');
    remote?.release();
  });

  // PR #9837 review / unit: a healthy imported account cannot clear a group's
  // cooldown for a new route its original grants deny. Prior tests only gated
  // allocation. Two accounts (signed-out default + healthy imported) reproduce it.
  it.each([false, true])('checks imported-account grants before recovering pool cooling (remote=%s)', async (remote) => {
    const model = 'chatgpt/gpt-6-astra';
    h.pools.openai = {
      strategy: 'order', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    let grant = 'all';
    h.read.mockImplementation(async (_provider, directory) => ({ authenticated: !directory.endsWith('default') }));
    h.accountAllowed.mockImplementation((_provider, target, options) =>
      !options.newRoute || (target === model && (grant === 'all' || (grant === 'local' && !options.remote))));
    h.usage.mockImplementation(async (_provider, dir) => {
      if (dir.endsWith('imported')) grant = 'denied'; // Revoked while the first quota read is in flight.
      return { codexUsage: {
        appServerBuckets: { codex: { limitId: 'codex', updatedAt: Date.now(),
          primary: { usedPercent: dir.endsWith('default') ? 100 : 10,
            resetsAt: Date.now() / 1000 + 3600, windowMinutes: 300 }, secondary: null } },
        webSnapshot: null, nativeAccountPool: true,
      } };
    });
    const options = { remote };
    expect(await readSubscriptionPoolModelAvailability('openai', model, options)).toBe(false);
    await expect(acquireSubscriptionAccount('openai', model, [], false, options)).rejects.toThrow('No subscription account');
    grant = 'local';
    expect(await readSubscriptionPoolModelAvailability('openai', model, options)).toBe(!remote);
    grant = 'all';
    expect(await readSubscriptionPoolModelAvailability('openai', model, options)).toBe(true);
    expect(h.bindings.size).toBe(0);
    const lease = await acquireSubscriptionAccount('openai', model, [], false, options);
    expect(lease?.account.configDir).toBe('openai/imported');
    lease?.release();
    grant = 'denied';
    expect(await readSubscriptionPoolModelAvailability('openai', model, options)).toBe(false);
  });

  it('pins an explicit old connection without task keys and does not persist a denied assignment', async () => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('default'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    const start = vi.fn<BaseAgent['startSession']>(async () => ({ id: 'native-keys', close: async () => {} } as unknown as AgentSessionHandle));
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai-old' } as StartSessionOptions);
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
    await handle.close();
    h.bindings.clear();
    h.accountAllowed.mockReturnValue(false);
    await expect(agent.startSession({ providerId: 'openai-old', sessionId: 'denied-new-task' } as StartSessionOptions)).rejects.toThrow();
    expect(h.bindings.size).toBe(0);
    expect(start).toHaveBeenCalledOnce();
  });

  // PR #9900 review, standard: an existing remote lease must track the actual
  // model after a hot switch. Earlier coverage only revoked the startup model.
  // PR #9837 merge regression: a completed switch followed by grant revocation
  // must also keep quota failures on the new model after access is restored.
  // Earlier tests checked permissions and quota tracking separately.
  it.each(['codex', 'claude-code', 'pi'] as const)('checks the current and target remote model for %s', async kind => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('imported'), { ...account('second'), paused: true }],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { codex: {
      limitId: 'codex', updatedAt: Date.now(),
      primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 },
      secondary: null,
    } }, webSnapshot: null } });
    const allowed = new Set(['model-a']);
    h.accountAllowed.mockImplementation((_provider, model, options) => !options.remote || allowed.has(model));
    const setModel = vi.fn<NonNullable<AgentSessionHandle['setModel']>>(async () => {});
    const send = vi.fn<AgentSessionHandle['send']>(async () => {});
    const start = vi.fn<BaseAgent['startSession']>(async () => ({
      id: 'switch-native', setModel, send, close: async () => {},
    } as unknown as AgentSessionHandle));
    const agent = withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({
      providerId: 'openai', model: 'model-a', workingDir: '.', sessionId: 'switch-task',
      deviceHosted: {
        workingDir: '.', extraDirs: [], writableDirs: [], platform: process.platform,
        shell: 'fixture', isGitRepo: false, tunnelUrl: 'http://127.0.0.1',
        tunnelToken: 'fixture-unused', mcpServers: [],
      },
    });
    await expect(handle.setModel!('model-b')).rejects.toThrow('remote access was revoked');
    expect(setModel).not.toHaveBeenCalled();
    allowed.add('model-b');
    setModel.mockRejectedValueOnce(new Error('switch failed'));
    await expect(handle.setModel!('model-b')).rejects.toThrow('switch failed');
    allowed.delete('model-b');
    await handle.send({ type: 'user', content: 'still model a' });
    allowed.add('model-b');
    await handle.setModel!('model-b');
    allowed.delete('model-a');
    await handle.send({ type: 'user', content: 'now model b' });
    expect(send).toHaveBeenCalledTimes(2);
    allowed.delete('model-b');
    await expect(handle.send({ type: 'user', content: 'revoked' })).rejects.toThrow('remote access was revoked');
    expect(send).toHaveBeenCalledTimes(2);
    expect(() => start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]!.assertCurrent())
      .toThrow('remote access was revoked');
    allowed.add('model-b');
    allowed.add('model-c');
    setModel.mockImplementationOnce(async () => { allowed.delete('model-c'); });
    await expect(handle.setModel!('model-c')).rejects.toThrow('remote access was revoked');
    await expect(handle.send({ type: 'user', content: 'revoked during switch' })).rejects.toThrow('remote access was revoked');
    expect(send).toHaveBeenCalledTimes(2);
    allowed.add('model-c');
    send.mockRejectedValueOnce(Object.assign(new Error('usage limit'), { codexErrorInfo: 'usageLimitExceeded' }));
    await expect(handle.send({ type: 'user', content: 'restored model c' })).rejects.toThrow('usage limit');
    expect(await readSubscriptionPoolModelAvailability('openai', 'model-c')).toBe(false);
    expect(await readSubscriptionPoolModelAvailability('openai', 'model-b')).toBe(true);
    await handle.close();
  });

  it('checks the imported connection model exclusion before a local switch', async () => {
    h.pools.openai = {
      strategy: 'least', accounts: [account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    h.accountAllowed.mockImplementation((_provider, model, options) => !options.modelSwitch || model !== 'model-b');
    const setModel = vi.fn<NonNullable<AgentSessionHandle['setModel']>>(async () => {});
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: async () => ({
      id: 'local-switch', setModel, close: async () => {},
    } as unknown as AgentSessionHandle) } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai', model: 'model-a', workingDir: '.' });
    await expect(handle.setModel!('model-b')).rejects.toThrow('does not allow this model');
    expect(setModel).not.toHaveBeenCalled();
    await handle.setModel!('model-a');
    expect(setModel).toHaveBeenCalledOnce();
    await handle.close();
  });

  // 2026-11-13 user report (unit): after the merge, old tasks kept waiting on an exhausted account
  // although the other account had quota, and users can no longer pick a connection by hand.
  // Existing failover coverage only used non-merged accounts. Minimal input: two accounts, the
  // merged one exhausted (or paused) — either bound to an `openai` task or still pinned by the
  // old connection id of a task that has not run since the merge.
  const model = 'gpt-6';
  it.each([
    { cause: 'exhausted', route: 'openai', bound: true, denied: false },
    { cause: 'exhausted', route: 'openai-old', bound: false, denied: false },
    { cause: 'paused', route: 'openai-old', bound: false, denied: false },
    // The merged route's own model switch still applies: never widen access by moving.
    { cause: 'exhausted', route: 'openai-old', bound: false, denied: true },
  ] as const)('moves a $route task off a $cause merged account before sending (merged route denied=$denied)',
    async ({ cause, route, bound, denied }) => {
      h.pools.openai = {
        strategy: 'order', accounts: [{ ...account('imported'), limit: 4 }, { ...account('second'), limit: 4 }],
        legacyCodexAccounts: { 'openai-old': 'imported' },
      };
      if (cause === 'paused') h.pools.openai.accounts[0].paused = true;
      else {
        const lease = await acquireSubscriptionAccount('openai', model, [], false, { accountId: 'imported' });
        if (bound) await lease!.bind(['task:t', 'native:old']);
        lease!.observeFailure(Object.assign(new Error('usage limit'), { codexErrorInfo: 'usageLimitExceeded' }), model, 'run');
        lease!.release();
      }
      h.routeAllowed.mockReturnValue(!denied);
      const row = { status: 'active', providerId: route as string, agentKind: 'codex', model, sdkSessionId: 'old' } as SessionRowSnapshot;
      const rebuild = vi.fn(async (_id: string, assertCurrent: () => void) => { assertCurrent(); });
      const moveRoute = vi.fn(async (_id: string, providerId: string, assertCurrent: () => void) => {
        assertCurrent();
        row.providerId = providerId;
      });
      const deps = { readSession: async () => row, isRunning: () => false, rebuild, moveRoute };
      if (cause === 'exhausted') expect(await canSwitchSubscriptionAccount('t', deps.readSession)).toBe(!denied);
      const moved = cause === 'paused'
        ? await prepareSubscriptionAccountForSend('t', deps)
        : await prepareSubscriptionAccountFailover('t', deps);
      expect(moved).toBe(!denied);
      expect(rebuild).toHaveBeenCalledTimes(denied ? 0 : 1);
      // A task leaving the old connection id continues on the merged route; an `openai` task stays there.
      expect(row.providerId).toBe(denied ? route : 'openai');
      expect(moveRoute).toHaveBeenCalledTimes(denied || route === 'openai' ? 0 : 1);
      expect(h.bindings.get('task:t')?.accountId).toBe(denied ? (bound ? 'imported' : undefined) : 'second');
      // The old native history stays with the account that owns it.
      if (bound) expect(h.bindings.get('native:old')?.accountId).toBe('imported');
    });

  it('reports and starts a fresh session of an openai task bound to an exhausted merged account elsewhere', async () => {
    h.pools.openai = {
      strategy: 'order', accounts: [{ ...account('imported'), limit: 4 }, { ...account('second'), limit: 4 }],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    const failed = await acquireSubscriptionAccount('openai', model, [], false, { accountId: 'imported' });
    await failed!.bind(['task:fresh', 'native:old']);
    failed!.observeFailure(Object.assign(new Error('usage limit'), { codexErrorInfo: 'usageLimitExceeded' }), model, 'run');
    failed!.release();
    // The executing computer reports it to a controller, which then hands the task off.
    expect(await readSubscriptionSessionAccount('openai', { sessionId: 'fresh', model }))
      .toMatchObject({ state: 'bound', account: { blocked: true, switchAvailable: true } });
    const start = vi.fn(async () => ({ id: 'native-new', close: async () => {} }) as unknown as AgentSessionHandle);
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai', sessionId: 'fresh', model } as StartSessionOptions);
    expect((start.mock.calls[0] as unknown as [StartSessionOptions])[0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/second');
    expect(h.bindings.get('task:fresh')?.accountId).toBe('second');
    expect(h.bindings.get('native:old')?.accountId).toBe('imported');
    await handle.close();
  });

  // 2026-11-13 user decision (subscription-account-pools.md 合并与拿出由用户决定), unit: an account
  // the upgrade merged belongs to its own connection again. Same minimal input as the merged case
  // above (two accounts, the first exhausted), but OpenAI must neither assign it nor move its tasks.
  it('keeps tasks on an account restored to its own connection and stops OpenAI from assigning it', async () => {
    h.pools.openai = {
      strategy: 'order', accounts: [{ ...account('imported'), limit: 4 }, { ...account('second'), limit: 4 }],
      legacyCodexAccounts: { 'openai-old': 'imported' },
    };
    h.placement = { 'openai:imported': 'openai-old' };
    const failed = await acquireSubscriptionAccount('openai', model, [], false, { accountId: 'imported' });
    await failed!.bind(['task:fresh', 'native:old']);
    failed!.observeFailure(Object.assign(new Error('usage limit'), { codexErrorInfo: 'usageLimitExceeded' }), model, 'run');
    failed!.release();
    // An `openai` task assigned to the account while it was merged follows the account.
    expect(await readSubscriptionSessionAccount('openai', { sessionId: 'fresh', model }))
      .toMatchObject({ state: 'bound', account: { number: 1 } });
    expect(await readSubscriptionSessionAccount('openai', { sessionId: 'fresh', model }))
      .not.toHaveProperty('account.blocked');
    const start = vi.fn(async () => ({ id: 'native-new', close: async () => {} }) as unknown as AgentSessionHandle);
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai', sessionId: 'fresh', model } as StartSessionOptions);
    expect((start.mock.calls[0] as unknown as [StartSessionOptions])[0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
    expect(h.bindings.get('task:fresh')?.accountId).toBe('imported');
    await handle.close();
    expect(await canSwitchSubscriptionAccount('fresh', async () => ({
      status: 'active', providerId: 'openai', agentKind: 'codex', model, sdkSessionId: 'old',
    }))).toBe(false);
    // New OpenAI work and the OpenAI account list use only OpenAI's own accounts. Another model is
    // used so the first account's cooling for `model` cannot explain the choice (one every account
    // lists: new OpenAI work only picks accounts whose own model list has the model).
    const fresh = await acquireSubscriptionAccount('openai', 'gpt-6-astra', [], false);
    expect(fresh?.accountId).toBe('second');
    fresh?.release();
    expect((await readSubscriptionPool('openai')).accounts.map((a) => a.id)).toEqual(['second']);
    // Disconnecting OpenAI does not stop the restored connection.
    h.pools.openai.disconnected = true;
    const own = await acquireSubscriptionAccount('openai', model, [], false, { accountId: 'imported' });
    expect(own?.accountId).toBe('imported');
    own?.release();
    await expect(acquireSubscriptionAccount('openai', model, [], false)).rejects.toThrow('disconnected');
  });

  // PR #10271 independent review (unit): local-only recovery left remote tasks on their old
  // connection id. Exercise executor admission, the wire parser, controller handoff and a fresh
  // Agent start together; two accounts and one unavailable legacy account are the minimal input.
  it.each(['exhausted', 'paused', 'removed', 'fresh'] as const)('hands a remote legacy task off a %s account on its executor', async cause => {
    h.pools.openai = { strategy: 'order', accounts: [account('imported'), account('second')],
      legacyCodexAccounts: { 'openai-old': 'imported' } };
    const old = await acquireSubscriptionAccount('openai', model, [], false, { accountId: 'imported' });
    await old!.bind(['task:remote', 'native:remote-old']);
    if (cause === 'exhausted' || cause === 'fresh') old!.observeFailure(Object.assign(new Error('usage limit'), { codexErrorInfo: 'usageLimitExceeded' }), model, 'run');
    old!.release();
    if (cause === 'paused') {
      h.setLegacyPaused.mockImplementation((id: string, paused: boolean) => {
        h.routeAllowed.mockImplementation((route: string) => route !== id || !paused);
      });
      await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'imported', paused: true });
    }
    if (cause === 'removed') h.pools.openai.accounts.shift();
    h.remote.mockImplementation(async (_device, _channel, args) => ({ ok: true,
      result: await readSubscriptionSessionAccount('openai', args[0], { remote: true, ownComputer: true }) }));
    const row = { status: 'active', providerId: 'openai-old', agentKind: 'codex', model,
      sdkSessionId: cause === 'fresh' ? null : 'remote-old' as string | null, agentDeviceId: 'executor' };
    expect(await canSwitchSubscriptionAccount('remote', async () => row, h.remote)).toBe(true);
    h.remote.mockClear();
    const rebuild = vi.fn(async (_id: string, assertCurrent: () => void) => { assertCurrent(); row.sdkSessionId = null; });
    const moveRoute = vi.fn(async (_id: string, providerId: string, assertCurrent: () => void) => { assertCurrent(); row.providerId = providerId; });
    expect(await prepareSubscriptionAccountFailover('remote', {
      readSession: async () => row, isRunning: () => false, rebuild, moveRoute, invokeRemote: h.remote,
    })).toBe(true);
    expect(h.remote).toHaveBeenCalledTimes(1);
    expect(h.remote.mock.calls[0][2]).toEqual([{ action: 'session', providerId: 'openai',
      ...(cause === 'fresh' ? {} : { nativeSessionId: 'remote-old' }), model, legacyProviderId: 'openai-old' }]);
    expect(rebuild).toHaveBeenCalledTimes(cause === 'fresh' ? 0 : 1);
    expect(row).toMatchObject({ providerId: 'openai', agentDeviceId: 'executor', sdkSessionId: null });
    const start = vi.fn(async () => ({ id: 'remote-new', close: async () => {} }) as unknown as AgentSessionHandle);
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: row.providerId, sessionId: 'remote', model,
      deviceHosted: { guest: false } } as unknown as StartSessionOptions);
    expect((start.mock.calls[0] as unknown as [StartSessionOptions])[0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/second');
    expect(h.bindings.get('task:remote')?.accountId).toBe('second');
    expect(h.bindings.get('native:remote-old')?.accountId).toBe('imported');
    await handle.close();
  });

  it('requires explicit executor admission for a remote legacy route and rejects stale responses', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('imported'), account('second')],
      legacyCodexAccounts: { 'openai-old': 'imported' } };
    const old = await acquireSubscriptionAccount('openai', model, [], false, { accountId: 'imported' });
    await old!.bind(['native:remote-old']);
    old!.observeFailure(Object.assign(new Error('usage limit'), { codexErrorInfo: 'usageLimitExceeded' }), model, 'run');
    old!.release();
    const query = { nativeSessionId: 'remote-old', model, legacyProviderId: 'openai-old' };
    for (const options of [{}, { remote: true }, { remote: true, ownComputer: false }])
      expect(await readSubscriptionSessionAccount('openai', query, options)).not.toHaveProperty('replacementProviderId');
    h.routeAllowed.mockReturnValue(false);
    expect(await readSubscriptionSessionAccount('openai', query, { remote: true, ownComputer: true })).not.toHaveProperty('replacementProviderId');
    h.routeAllowed.mockReturnValue(true);
    h.accountAllowed.mockReturnValue(false);
    expect(await readSubscriptionSessionAccount('openai', query, { remote: true, ownComputer: true })).not.toHaveProperty('replacementProviderId');
    h.accountAllowed.mockReturnValue(true);
    expect(await readSubscriptionSessionAccount('openai', { ...query, legacyProviderId: 'unknown' }, { remote: true, ownComputer: true })).not.toHaveProperty('replacementProviderId');
    h.bindings.set('native:remote-old', { providerId: 'openai', accountId: 'second' });
    expect(await readSubscriptionSessionAccount('openai', query, { remote: true, ownComputer: true })).not.toHaveProperty('replacementProviderId');
    h.bindings.set('native:remote-old', { providerId: 'openai', accountId: 'imported' });
    // An old host ignores legacyProviderId and returns ordinary blocked/switchAvailable. Keep history.
    h.remote.mockImplementation(async () => ({ ok: true,
      result: await readSubscriptionSessionAccount('openai', { nativeSessionId: 'remote-old', model }) }));
    const row = { status: 'active', providerId: 'openai-old', agentKind: 'codex', model,
      sdkSessionId: 'remote-old', agentDeviceId: 'executor' };
    const rebuild = vi.fn();
    const moveRoute = vi.fn();
    const deps = { readSession: async () => row, isRunning: () => false, rebuild, moveRoute, invokeRemote: h.remote };
    expect(await prepareSubscriptionAccountFailover('remote', deps)).toBe(false);
    expect(rebuild).not.toHaveBeenCalled();
    h.remote.mockImplementation(async () => {
      const result = await readSubscriptionSessionAccount('openai', query, { remote: true, ownComputer: true });
      row.sdkSessionId = 'newer-native';
      return { ok: true, result };
    });
    await expect(prepareSubscriptionAccountFailover('remote', deps)).rejects.toThrow('route changed');
    expect(rebuild).not.toHaveBeenCalled();
    expect(moveRoute).not.toHaveBeenCalled();
    h.remote.mockClear();
    expect(await prepareSubscriptionAccountFailover('remote', { ...deps,
      readSession: async () => ({ ...row, agentDeviceId: 'share:someone' }) })).toBe(false);
    expect(h.remote).not.toHaveBeenCalled();
  });
});

describe('native account assignment on the executing computer', () => {
  // PR #10910 merge / unit: the anonymous projection must use #10885 readiness,
  // not wait for an unread sibling or label an entirely pending pool unavailable.
  it.each(['ready-peer', 'all-pending'] as const)('projects only confirmed accounts with %s status', async stage => {
    vi.useFakeTimers();
    h.pools.anthropic = { strategy: 'least', accounts: ['default', 'second'].map(account) };
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    h.read.mockImplementation(async (_kind, directory: string) => {
      if (stage === 'all-pending' || directory.endsWith('/default')) await barrier;
      return { authenticated: true, identity: directory };
    });
    const result: { value?: Awaited<ReturnType<typeof readSubscriptionPoolScheduling>> } = {};
    const pending = readSubscriptionPoolScheduling('anthropic', 'claude-sonnet-5').then(value => { result.value = value; });
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      if (stage === 'ready-peer') expect(result.value).toMatchObject({ accounts: 1, running: 0, full: false });
      else expect(result.value).toBeUndefined();
      expect(h.bindings.size).toBe(0);
      finish();
      await pending;
      expect(await readSubscriptionPoolScheduling('anthropic', 'claude-sonnet-5'))
        .toMatchObject({ accounts: 2, running: 0, full: false });
    } finally {
      finish();
      await pending;
      vi.useRealTimers();
    }
  });

  // PR #10885 review, unit: control reads may use paused accounts without task admission.
  // #10892 moved Claude discovery to its own probe; retain the Claude control contract and
  // exercise the remaining real refresh adapter caller (pools of legacy Codex profiles).
  it.each(['anthropic', 'openai'] as const)('reads paused %s control accounts without admitting a new task or reserving capacity', async provider => {
    const ids = provider === 'anthropic' ? ['default', 'second'] : ['first', 'second'];
    h.pools[provider] = { strategy: 'least', accounts: ids.map(id => ({ ...account(id), paused: true })),
      ...(provider === 'openai' ? { legacyCodexAccounts: { 'old-first': 'first', 'old-second': 'second' } } : {}) };
    if (provider === 'anthropic') {
      const lease = await acquireSubscriptionAccount(provider, undefined, [], true);
      expect(lease?.account.configDir).toBe('anthropic/default');
      lease!.release();
    } else {
      const modelRefresh = vi.fn<BaseAgent['refreshLocalModels']>().mockResolvedValue(true);
      const agent = withSubscriptionAccounts({ kind: 'codex', refreshLocalModels: modelRefresh } as unknown as BaseAgent);
      expect(await agent.refreshLocalModels()).toBe(true);
      expect(modelRefresh.mock.calls[0][0]?.[NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/first');
    }
    expect((await readSubscriptionPool(provider)).accounts.map(entry => [entry.paused, entry.running]))
      .toEqual([[true, 0], [true, 0]]);
    expect(h.bindings.size).toBe(0);
    await expect(acquireSubscriptionAccount(provider, undefined, [])).rejects.toThrow('No subscription account is available');
  });

  // F1, unit: real acquire, task reader and adapter must not wait for another account's CLI.
  // Previous coverage only settled every sibling before asserting the selected directory.
  it.each(['anthropic', 'openai'] as const)('resumes a healthy %s task while its sibling status never answers', async provider => {
    vi.useFakeTimers();
    h.pools[provider] = { strategy: 'least', accounts: [account('default'), account('second')] };
    h.bindings.set('task:healthy', { providerId: provider, accountId: 'second' });
    h.bindings.set('native:healthy-native', { providerId: provider, accountId: 'second' });
    let finish!: (value: object) => void;
    const slow = new Promise<object>(resolve => { finish = resolve; });
    h.read.mockImplementation(async (_kind, directory: string) => directory.endsWith('/default')
      ? slow : { authenticated: true, identity: 'healthy@example.test' });
    const native = { id: 'healthy-native', close: vi.fn(async () => {}) } as unknown as AgentSessionHandle;
    const start = vi.fn<(options: StartSessionOptions) => Promise<AgentSessionHandle>>().mockResolvedValue(native);
    const agent = withSubscriptionAccounts({ kind: provider === 'openai' ? 'codex' : 'claude-code', startSession: start } as unknown as BaseAgent);
    let handle: AgentSessionHandle | undefined;
    const pending = agent.startSession({ providerId: provider, sessionId: 'healthy', resumeSessionId: 'healthy-native', model: 'gpt-6' } as StartSessionOptions)
      .then(result => { handle = result; return result; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(handle).toBeDefined();
      expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]!.configDir).toBe(`${provider}/second`);
      expect(await readSubscriptionSessionAccount(provider, { sessionId: 'healthy' }))
        .toMatchObject({ state: 'bound', account: { number: 2, status: 'ready' } });
    } finally {
      finish({ authenticated: false });
      await (await pending).close();
      vi.useRealTimers();
    }
  });

  it.each(['status', 'models'] as const)('bounds new assignment waiting for sibling %s without racing the fastest account', async stage => {
    vi.useFakeTimers();
    h.pools.openai = { strategy: 'order', accounts: ['default', 'second', 'third'].map(account) };
    let finish!: (value: object) => void;
    const slow = new Promise<object>(resolve => { finish = resolve; });
    h.read.mockImplementation(async (_kind, directory: string) => stage === 'status' && directory.endsWith('/default')
      ? slow : { authenticated: true, identity: directory });
    h.rpc.mockImplementation(async (directory: string) => {
      if (directory.endsWith('/default')) return slow;
      // third replies first; the policy must still prefer second within the common budget.
      if (directory.endsWith('/second')) await new Promise(resolve => setTimeout(resolve, 500));
      return { data: [{ id: 'gpt-6' }], nextCursor: null };
    });
    let selected: string | undefined;
    const pending = acquireSubscriptionAccount('openai', 'gpt-6', []).then(lease => { selected = lease?.accountId; return lease; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(selected).toBeUndefined(); // ready peers still share one fairness window
      await vi.advanceTimersByTimeAsync(2_000);
      expect(selected).toBe('second'); // order among all ready peers, not arrival order
      (await pending)!.release();
      finish(stage === 'status' ? { authenticated: false } : { data: [{ id: 'gpt-6' }], nextCursor: null });
      await vi.advanceTimersByTimeAsync(0);
      if (stage === 'models') {
        const recovered = await acquireSubscriptionAccount('openai', 'gpt-6', []);
        expect(recovered?.accountId).toBe('default');
        recovered!.release();
      }
    } finally {
      finish(stage === 'status' ? { authenticated: false } : { data: [{ id: 'gpt-6' }], nextCursor: null });
      (await pending)?.release();
      vi.useRealTimers();
    }
  });

  it('keeps independent providers and paused historical model discovery out of dispatch and model switches', async () => {
    vi.useFakeTimers();
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second'), { ...account('historical'), paused: true }] };
    h.placement['openai:second'] = 'separate';
    h.created.separate = { kind: 'openai', name: 'Separate', account: 'second' };
    h.bindings.set('native:old', { providerId: 'openai', accountId: 'historical' });
    await readSubscriptionPool('openai');
    await readSubscriptionPool('separate');
    let finish!: (value: object) => void;
    const slow = new Promise<object>(resolve => { finish = resolve; });
    h.rpc.mockImplementation(async (directory: string) => directory.endsWith('/default')
      ? { data: [{ id: 'gpt-6' }, { id: 'model-b' }], nextCursor: null } : slow);
    const discovery = refreshSubscriptionPoolCodexModels(true);
    let lease: Awaited<ReturnType<typeof acquireSubscriptionAccount>> | undefined;
    const pending = acquireSubscriptionAccount('openai', 'gpt-6', []).then(value => { lease = value; return value; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(lease?.accountId).toBe('default');
      const apply = vi.fn(async () => {});
      await lease!.changeModel('model-b', apply);
      expect(apply).toHaveBeenCalledOnce();
      expect(h.rpc.mock.calls.filter(([directory]) => directory === 'openai/second')).toHaveLength(1);
    } finally {
      finish({ data: [{ id: 'gpt-6' }], nextCursor: null });
      await discovery;
      (await pending)?.release();
      vi.useRealTimers();
    }
  });

  it.each(['cold-single', 'owner-change', 'model-not-offered'] as const)
  ('preserves %s admission while a native read is pending', async state => {
    vi.useFakeTimers();
    h.pools.openai = { strategy: 'order', accounts: state === 'cold-single' ? [account('second')] : [account('default'), account('second')] };
    let finish!: (value: object) => void;
    const slow = new Promise<object>(resolve => { finish = resolve; });
    h.rpc.mockImplementation(async (directory: string) => directory.endsWith('/second') ? slow
      : { data: [{ id: 'different-model' }], nextCursor: null });
    let settled = false;
    const pending = acquireSubscriptionAccount('openai', 'gpt-6', []);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toBe(false); // no cached/foreign membership admits the pending profile
      if (state === 'owner-change') h.owner += '-changed';
      finish({ data: [{ id: state === 'model-not-offered' ? 'different-model' : 'gpt-6' }], nextCursor: null });
      if (state === 'owner-change') await expect(pending).rejects.toThrow('owner changed');
      else if (state === 'model-not-offered') await expect(pending).rejects.toThrow('No subscription account');
      else { const lease = await pending; expect(lease?.accountId).toBe('second'); lease!.release(); }
    } finally {
      finish({ data: [], nextCursor: null });
      await pending.catch(() => {});
      vi.useRealTimers();
    }
  });

  it.each(['cancel', 'failure'] as const)('preserves the original unreadable account and history after Add %s', async state => {
    h.pools.openai = { strategy: 'least', accounts: [account('default')] };
    h.bindings.set('native:old', { providerId: 'openai', accountId: 'default' });
    const original = structuredClone(h.pools.openai);
    h.read.mockImplementation(async (_kind, directory: string) => {
      if (directory.endsWith('/default')) throw new Error('CLI unavailable');
      return { authenticated: false };
    });
    let started!: () => void;
    const loginStarted = new Promise<void>(resolve => { started = resolve; });
    h.login.mockImplementation(async (_kind, _directory, signal: AbortSignal) => {
      started();
      if (state === 'failure') throw new Error('login_failed');
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('login_cancelled')), { once: true }));
    });
    const command = runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'another' });
    const rejected = expect(command).rejects.toThrow(state === 'cancel' ? 'login_cancelled' : 'login_failed');
    await loginStarted;
    if (state === 'cancel') await runSubscriptionAccountCommand({ action: 'cancel', providerId: 'openai', loginKey: 'another' });
    await rejected;
    expect(h.pools.openai).toEqual(original);
    expect(h.placement).toEqual({});
    expect(h.bindings.get('native:old')?.accountId).toBe('default');
    expect(h.clearCooling).not.toHaveBeenCalled();
    expect(h.login.mock.calls[0][1]).not.toBe('openai/default');
  });

  it.each(['empty', 'missing'] as const)('keeps legacy first-use Add compatible with a confirmed %s default directory', async state => {
    h.pools = {};
    h.bound = false;
    if (state === 'missing') h.directoryEntries.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    let signedIn = false;
    h.read.mockImplementation(async () => ({ authenticated: signedIn }));
    h.login.mockImplementation(async () => { signedIn = true; });
    const view = await runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'first' });
    expect(view.accounts.map(a => [a.id, a.status])).toEqual([['default', 'ready']]);
    expect(h.login).toHaveBeenCalledExactlyOnceWith('openai', 'openai/default', expect.any(AbortSignal));
  });

  it('does not turn a disappearing detected login into Add overwriting the default home', async () => {
    h.pools = {};
    h.bound = false;
    h.read.mockResolvedValueOnce({ authenticated: true, identity: 'original@example.test' })
      .mockResolvedValue({ authenticated: false });
    await expect(runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'changed' }))
      .rejects.toThrow('login_failed');
    expect(h.login).not.toHaveBeenCalled();
    expect(h.clearCooling).not.toHaveBeenCalled();
  });

  it('rechecks a binding paused during its own status read before deciding whether to inspect replacements', async () => {
    h.bindings.set('task:changed', { providerId: 'anthropic', accountId: 'default' });
    h.read.mockImplementation(async (_kind, directory: string) => {
      if (directory.endsWith('/default')) h.pools.anthropic!.accounts[0].paused = true;
      return { authenticated: true, identity: 'account' };
    });
    const lease = await acquireSubscriptionAccount('anthropic', 'claude-model', ['task:changed'], false, { resuming: false });
    expect(lease?.accountId).toBe('second');
    lease!.release();
    expect(h.bindings.get('task:changed')?.accountId).toBe('default'); // dispatch has not bound a new native history
  });

  it.each(['owner-change', 'cancel'] as const)('does not commit a %s during post-login verification', async state => {
    h.pools.openai = { strategy: 'least', accounts: [account('second')] };
    let verifying!: () => void;
    const verificationStarted = new Promise<void>(resolve => { verifying = resolve; });
    let finish!: (value: object) => void;
    const verified = new Promise<object>(resolve => { finish = resolve; });
    let loggedIn = false;
    h.read.mockImplementation(async () => {
      if (loggedIn) { verifying(); return verified; }
      return { authenticated: false };
    });
    h.login.mockImplementation(async () => { loggedIn = true; });
    const command = runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'second', loginKey: 'verifying' });
    const rejected = expect(command).rejects.toThrow(state === 'cancel' ? 'login_cancelled' : 'owner changed');
    await verificationStarted;
    let cancellation: Promise<unknown> | undefined;
    if (state === 'owner-change') h.owner += '-changed';
    else cancellation = runSubscriptionAccountCommand({ action: 'cancel', providerId: 'openai', loginKey: 'verifying' });
    finish({ authenticated: true, identity: 'second@example.test' });
    await rejected;
    await cancellation;
    expect(h.clearCooling).not.toHaveBeenCalled();
    expect(h.pools.openai!.accounts.map(a => a.id)).toEqual(['second']);
  });

  // F2, unit: Add previously reused the existing default home after a failed auth read.
  // Existing wizard coverage only tested explicit `connect:new` and healthy defaults.
  it.each((['anthropic', 'openai'] as const).flatMap(provider =>
    ['unavailable', 'signed-out', 'authorized', 'history', 'unreadable-directory'].map(state => ({ provider, state }))))
  ('adds another $provider account without borrowing a $state default home', async ({ provider, state }) => {
    h.pools = state === 'unavailable' || state === 'signed-out'
      ? { [provider]: { strategy: 'least', accounts: [account('default')] } } : {};
    h.bound = state === 'unavailable' || state === 'signed-out' || state === 'authorized';
    if (state === 'signed-out') h.bindings.set('native:retained-history', { providerId: provider, accountId: 'default' });
    if (state === 'history') h.directoryEntries.mockResolvedValue(['sessions']);
    if (state === 'unreadable-directory') h.directoryEntries.mockRejectedValue(new Error('EACCES'));
    const signedIn = new Set<string>();
    h.read.mockImplementation(async (_kind, directory: string) => {
      if (directory.endsWith('/default') && state === 'unavailable') throw new Error('CLI unavailable');
      return { authenticated: signedIn.has(directory), identity: signedIn.has(directory) ? 'new@example.test' : undefined };
    });
    h.login.mockImplementation(async (_kind, directory: string) => { signedIn.add(directory); });
    const view = await runSubscriptionAccountCommand({ action: 'add', providerId: provider, loginKey: 'another' });
    const added = view.accounts.find(a => a.id !== 'default');
    expect(added).toMatchObject({ status: 'ready', identity: 'new@example.test' });
    expect(h.login).toHaveBeenCalledExactlyOnceWith(provider, `${provider}/${added!.id}`, expect.any(AbortSignal));
    if (state === 'signed-out') expect(h.bindings.get('native:retained-history')?.accountId).toBe('default');
    expect(h.pools[provider]!.accounts.map(a => a.id)).toEqual(['default', added!.id]);
  });

  // F3, unit: the official login control can finish while account/read fails or still reports
  // signed out. Existing renewal tests checked this only for Claude's expected-email guard.
  it.each(['unavailable', 'signed-out', 'authenticated'] as const)
  ('commits OpenAI login and clears cooling only after %s verification', async verification => {
    h.pools.openai = { strategy: 'least', accounts: [account('second')] };
    let loggedIn = false;
    h.read.mockImplementation(async () => {
      if (loggedIn && verification === 'unavailable') throw new Error('CLI unavailable');
      return { authenticated: loggedIn && verification === 'authenticated', identity: 'second@example.test' };
    });
    h.login.mockImplementation(async () => { loggedIn = true; });
    const command = runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'second', loginKey: 'verify' });
    if (verification === 'authenticated') {
      expect((await command).accounts[0].status).toBe('ready');
      expect(h.clearCooling).toHaveBeenCalledWith('openai', 'second');
    } else {
      await expect(command).rejects.toThrow(verification === 'unavailable' ? 'SUBSCRIPTION_ACCOUNT_UNAVAILABLE' : 'login_failed');
      expect(h.clearCooling).not.toHaveBeenCalled();
      expect((await readSubscriptionPool('openai')).accounts[0].status)
        .toBe(verification === 'unavailable' ? 'unavailable' : 'signed-out');
    }
    expect(h.pools.openai!.accounts.map(a => a.id)).toEqual(['second']);
  });

  it('retains rejected-credential evidence when post-login verification is unavailable', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('second')] };
    h.tokens.mockResolvedValue({ accessToken: 'rejected-fixture-token', chatgptAccountId: 'fixture-workspace', canDispatch: () => true });
    const lease = await acquireSubscriptionAccount('openai', undefined, [], false, { accountId: 'second' });
    lease!.account.invalidateAuth!('token_revoked', 'rejected-fixture-token');
    lease!.release();
    let verifying = false;
    h.login.mockImplementation(async () => { verifying = true; });
    h.read.mockImplementation(async () => {
      if (verifying) throw new Error('CLI unavailable');
      return { authenticated: true, identity: 'account' };
    });
    await expect(runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'second', loginKey: 'uncertain' }))
      .rejects.toThrow('SUBSCRIPTION_ACCOUNT_UNAVAILABLE');
    verifying = false;
    expect((await readSubscriptionPool('openai')).accounts[0].status).toBe('signed-out');
    expect(h.clearCooling).not.toHaveBeenCalled();
  });
  // Unit regression (2026-11-13): account pools rejected ChatGPT before the upstream could
  // spend credits. Prior coverage asserted exhausted windows were admission failures; it never
  // started/resumed a full-window account with available, unknown or depleted cached credits.
  it.each([
    { hasCredits: true, unlimited: false, balance: '52768.87' },
    null,
    { hasCredits: false, unlimited: false, balance: '0' },
  ])('leaves ChatGPT credit admission to upstream for new, resumed and explicit accounts (%j)', async credits => {
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { codex: {
      limitId: 'codex', updatedAt: Date.now(),
      primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 },
      secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: Date.now() / 1000 + 86400 },
    } }, webSnapshot: null }, codexCredits: credits });
    h.bindings.set('task:existing', { providerId: 'openai', accountId: 'default' });
    for (const [keys, options] of [
      [[], {}],
      [['task:existing'], { resuming: true }],
      [[], { accountId: 'second', resuming: true, remote: true, ownComputer: true }],
    ] as const) {
      const lease = await acquireSubscriptionAccount('openai', 'gpt-6', [...keys], false, options);
      expect(lease?.account.configDir).toBe('accountId' in options ? 'openai/second' : 'openai/default');
      expect(readSubscriptionAccountBlocked('openai', lease!.accountId, 'gpt-6')).toBe(false);
      lease!.release();
    }
    expect(h.bindings.get('task:existing')?.accountId).toBe('default');
  });

  // Regression: a pinned exhausted account was reported as login-or-reset even
  // when another account was ready. Unit: exercise acquisition, not UI heuristics.
  it.each([null, 3600])('reports the bound account limit and only its trusted reset (%s)', async delay => {
    const now = Date.now();
    const resetAt = delay === null ? null : Math.floor(now / 1000) + delay;
    h.bindings.set('task:existing', { providerId: 'anthropic', accountId: 'second' });
    h.usage.mockImplementation(async (_provider, directory) => directory === 'anthropic/second'
      ? { claudeUsage: { updatedAt: now, fiveHour: { utilization: 100, resetsAt: resetAt }, sevenDay: null, scoped: [] } }
      : {});
    const error = await acquireSubscriptionAccount('anthropic', 'claude-sonnet-4-6', ['task:existing']).catch(e => e);
    expect(error.message).toContain('[SUBSCRIPTION_ACCOUNT_LIMITED]');
    if (resetAt) expect(error.message).toContain(`resetAtMs=${resetAt * 1000}`);
    else expect(error.message).not.toContain('resetAtMs=');
    expect(h.bindings.get('task:existing')?.accountId).toBe('second');
  });

  it.each(['signed-out', 'unavailable', 'removed'] as const)('distinguishes %s from exhaustion', async state => {
    h.bindings.set('task:existing', { providerId: 'anthropic', accountId: 'second' });
    if (state === 'removed') h.pools.anthropic!.accounts = [account('default')];
    else h.read.mockImplementation(async (_provider, directory) => {
      if (directory !== 'anthropic/second') return { authenticated: true };
      if (state === 'unavailable') throw new Error('temporary CLI failure');
      return { authenticated: false };
    });
    await expect(acquireSubscriptionAccount('anthropic', undefined, ['task:existing']))
      .rejects.toThrow(state === 'signed-out' ? '[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED]' : '[SUBSCRIPTION_ACCOUNT_UNAVAILABLE]');
  });

  // 2026-11-12 实测：重启后 OpenAI 池里第一个账号额度用尽、第二个有额度，却整池无账号可选。
  // 根因是官方 CLI 的第一次读失败被当成成功快照缓存 30 秒，用户重试也只会拿到同一份
  // 旧结论。生产入口：acquireSubscriptionAccount；可观察结果：短暂窗口后的重试能发出。
  // 已有覆盖不够：上方 'distinguishes unavailable' 只断言首次失败的错误码，不推进时间、不重试。
  // 最小失败输入：绑定账号首读抛错、随后恢复，4 秒后重试。tier：默认 unit(进程内 fake + 假时钟)。
  it('re-reads a failed account snapshot instead of serving it for the whole success window', async () => {
    vi.useFakeTimers();
    try {
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
      h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
      h.bindings.set('task:existing', { providerId: 'openai', accountId: 'second' });
      let cliReady = false;
      h.read.mockImplementation(async (_provider, directory: string) => {
        if (directory !== 'openai/second') return { authenticated: true, identity: 'first@example.test' };
        if (!cliReady) throw new Error('Codex CLI unavailable');
        return { authenticated: true, identity: 'second@example.test' };
      });
      const send = () => acquireSubscriptionAccount('openai', 'gpt-6.1-sol', ['task:existing']);
      await expect(send()).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE]');
      // Cached evidence is for configured active accounts only. These pure
      // projections do not trigger a CLI read or revive a disconnected pool.
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
      h.pools.openai.disconnected = true;
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
      delete h.pools.openai.disconnected;
      h.pools.openai.accounts[1].paused = true;
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
      h.pools.openai.accounts[1].paused = false;
      // 窗口内仍复用失败快照：并发与连续重试不得反复 spawn 官方 CLI。
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(send()).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE]');
      cliReady = true;
      await vi.advanceTimersByTimeAsync(3_001);
      const lease = await send();
      expect(lease?.accountId).toBe('second');
      expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
      lease?.release();
    } finally { vi.useRealTimers(); }
  });

  it('projects the task binding without selecting, reserving or unpausing an account', async () => {
    h.pools.anthropic!.accounts[0].paused = true;
    h.bindings.set('task:existing', { providerId: 'anthropic', accountId: 'default' });
    const bound = await readSubscriptionPool('anthropic', false, 'existing');
    expect(bound.boundAccountId).toBe('default');
    expect(bound.accounts[0]).toMatchObject({ paused: true, running: 0 });
    expect((await readSubscriptionPool('anthropic', false, 'new-task')).boundAccountId).toBeNull();
    expect(await readSubscriptionPool('anthropic')).not.toHaveProperty('boundAccountId');
    h.pools.anthropic!.accounts = [account('second')];
    expect((await readSubscriptionPool('anthropic', false, 'existing')).boundAccountId).toBe('default');
    expect(h.bindings.size).toBe(1);
  });

  // #9517 review, unit: Add must recover both bound and unbound managed defaults.
  // A disconnected pool and a first Add bypassed the bound-default fallback.
  it.each([
    { bound: true, configured: true },
    { bound: false, configured: true },
    { bound: false, configured: false },
  ])('adds an isolated account for a managed default (bound=$bound, configured=$configured)', async ({ bound, configured }) => {
    h.bound = bound;
    if (configured) h.pools.openai = { strategy: 'least', accounts: [account('default')], disconnected: !bound };
    const signedIn = new Set<string>();
    h.read.mockImplementation(async (_provider, directory: string) =>
      directory === 'openai/default'
        ? { authenticated: false, errorReason: 'codex_provider_managed_auth' }
        : { authenticated: signedIn.has(directory), identity: 'new@example.test' },
    );
    h.login.mockImplementation(async (_provider, directory: string) => { signedIn.add(directory); });

    const result = await runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'recover' });

    expect(h.login).toHaveBeenCalledOnce();
    const newAccount = result.accounts.find((entry) => entry.id !== 'default');
    expect(newAccount).toMatchObject({ status: 'ready', identity: 'new@example.test' });
    expect(h.login).toHaveBeenCalledWith('openai', `openai/${newAccount!.id}`, expect.any(AbortSignal));
    expect(h.pools.openai!.accounts.map((entry) => entry.id)).toEqual(['default', newAccount!.id]);
    expect(result.accounts[0]).toMatchObject({ id: 'default', status: 'signed-out' });
    expect(result.accounts[0].authIssue).toBe(bound ? 'codex-provider-managed-auth' : undefined);
    expect(h.pools.openai!.disconnected).toBe(false);
    expect(h.legacyLogin).not.toHaveBeenCalled();
  });

  // Unit, #9517: redirecting an unbound default must preserve cancellation and
  // leave the disconnected pool unauthorized until an independent login succeeds.
  it('cancels isolated recovery without reconnecting the unbound default and can retry', async () => {
    h.bound = false;
    h.pools.openai = { strategy: 'least', accounts: [account('default')], disconnected: true };
    h.read.mockImplementation(async (_provider, directory: string) => directory === 'openai/default'
      ? { authenticated: false, errorReason: 'codex_provider_managed_auth' }
      : { authenticated: false });
    let started!: () => void;
    const loginStarted = new Promise<void>((resolve) => { started = resolve; });
    h.login.mockImplementationOnce((_provider, _directory, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('login_cancelled')), { once: true });
      started();
    }));
    const pending = runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'cancel-new' });
    const cancelled = expect(pending).rejects.toThrow('login_cancelled');
    await loginStarted;
    await runSubscriptionAccountCommand({ action: 'cancel', providerId: 'openai', loginKey: 'cancel-new' });
    await cancelled;
    expect(h.login.mock.calls[0][1]).not.toBe('openai/default');
    expect(h.pools.openai!.disconnected).toBe(true);
    h.login.mockImplementation(async (_provider, directory: string) => {
      h.read.mockImplementation(async (_kind, home: string) => home === directory
        ? { authenticated: true, identity: 'new@example.test' }
        : { authenticated: false, errorReason: 'codex_provider_managed_auth' });
    });
    await runSubscriptionAccountCommand({ action: 'add', providerId: 'openai', loginKey: 'retry-new' });
    expect(h.login).toHaveBeenCalledTimes(2);
    expect(h.login.mock.calls[1][1]).not.toBe('openai/default');
  });

  // #9517, unit: the real connection/reconnection entry must reject the CLI's
  // provider-managed auth state before login. Existing cases only cover signed-in/out.
  it.each([
    { action: 'connect', target: 'default', providerId: 'openai', loginKey: 'provider' },
    { action: 'add', providerId: 'openai', loginKey: 'provider' },
    { action: 'login', accountId: 'second', providerId: 'openai', loginKey: 'provider' },
  ] as const)('does not relaunch login for provider-managed authentication ($action)', async (command) => {
    h.bound = false;
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
    h.read.mockResolvedValue({ authenticated: false, errorReason: 'codex_provider_managed_auth' });
    if (command.action === 'connect') {
      const preview = await runSubscriptionAccountCommand({ action: 'preview', providerId: 'openai' });
      expect(preview.accounts[0]).toMatchObject({ status: 'signed-out', authIssue: 'codex-provider-managed-auth' });
      expect(h.usage).not.toHaveBeenCalled();
    }
    await expect(runSubscriptionAccountCommand(command)).rejects.toThrow('codex_provider_managed_auth');
    expect(h.login).not.toHaveBeenCalled();
    // The blocked attempt releases its login reservation, and "new" keeps using
    // its own directory instead of the incompatible default profile.
    h.read.mockImplementation(async (_provider, directory) => ({
      authenticated: !directory.endsWith('/default'),
      ...(directory.endsWith('/default') ? { errorReason: 'codex_provider_managed_auth' } : {}),
    }));
    const next = await runSubscriptionAccountCommand({ action: 'connect', target: 'new', providerId: 'openai', loginKey: 'next' });
    expect(h.login).toHaveBeenCalledOnce();
    expect(h.login.mock.calls[0][1]).not.toBe('openai/default');
    expect(next.accounts.at(-1)?.status).toBe('ready');
  });

  // 2026-11-11 user report (unit): the model list and composer usage showed the CLI default
  // account for a task pinned to another pool account. Display reads must resolve the same
  // bindings a resume does (task id first, then the native id a remote host knows), and never
  // substitute the default or the next pool pick. Minimal input: a task bound to `second`.
  it.each(['anthropic', 'openai'] as const)('names the account a %s task is pinned to', async (provider) => {
    h.pools[provider] = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.read.mockImplementation(async (_p: string, directory: string) => ({
      authenticated: true, identity: directory.endsWith('second') ? 'second@example.test' : 'first@example.test',
      ...(provider === 'anthropic' ? { plan: 'pro', planTier: 'pro',
        planDisplayName: directory.endsWith('second') ? 'Ultra' : 'Pro' } : {}),
    }));
    const now = Date.now();
    h.usage.mockImplementation(async (_p: string, directory: string) => {
      const used = directory.endsWith('second') ? 30 : 90;
      const bucket = { limitId: 'codex', limitName: null, updatedAt: now,
        primary: { usedPercent: used, windowMinutes: 300, resetsAt: now / 1000 + 3600 }, secondary: null };
      return provider === 'anthropic'
        ? { claudeUsage: { updatedAt: now, fiveHour: { utilization: used, resetsAt: now / 1000 + 3600 }, sevenDay: null, scoped: [] } }
        : { codexUsage: { appServerBuckets: { codex: bucket }, webSnapshot: bucket } };
    });
    const read = (keys: { sessionId?: string; nativeSessionId?: string }) =>
      readSubscriptionSessionAccount(provider, keys);
    h.bindings.set('task:task-1', { providerId: provider, accountId: 'second' });
    const bound = await read({ sessionId: 'task-1', nativeSessionId: 'unbound-native' });
    expect(bound).toMatchObject({ state: 'bound', account: {
      isDefault: false, number: 2, identity: 'second@example.test', status: 'ready',
    } });
    if (provider === 'anthropic') expect(parseSubscriptionSessionAccountView(bound, provider))
      .toMatchObject({ account: { plan: 'pro', planTier: 'pro', planDisplayName: 'Ultra' } });
    expect(bound.state === 'bound' && (provider === 'anthropic'
      ? bound.account.usage?.claude?.fiveHour?.utilization
      : bound.account.usage?.codex?.buckets.codex.primary?.usedPercent)).toBe(30);
    // A remote executor only knows the native id.
    h.bindings.set('native:sdk-2', { providerId: provider, accountId: 'second' });
    expect(await read({ sessionId: 'controller-id', nativeSessionId: 'sdk-2' }))
      .toMatchObject({ state: 'bound', account: { number: 2 } });
    h.bindings.set('task:task-3', { providerId: provider, accountId: 'default' });
    expect(await read({ sessionId: 'task-3' }))
      .toMatchObject({ state: 'bound', account: { isDefault: true, identity: 'first@example.test' } });
    // Not yet run: the pool picks next turn. Pre-pool resume: the original default readers.
    expect(await read({ sessionId: 'new' })).toEqual({ providerId: provider, state: 'unassigned' });
    expect(await read({ sessionId: 'old', nativeSessionId: 'pre-pool' }))
      .toEqual({ providerId: provider, state: 'legacy' });
    // A removed account fails visibly instead of naming the remaining default.
    h.pools[provider]!.accounts = [account('default')];
    expect(await read({ sessionId: 'task-1' })).toEqual({ providerId: provider, state: 'unavailable' });
    expect(await read({ sessionId: 'task-3' })).toMatchObject({ providerId: provider, state: 'bound', account: { number: 1 } });
    h.pools = {};
    expect(await read({ sessionId: 'task-1' })).toEqual({ providerId: provider, state: 'legacy' });
  });

  // Unit, #9295 review: reset lookups refresh the pinned profile rather than
  // taking a different ready account; prior tests only covered pool availability.
  it.each([
    ['anthropic', 'default'], ['anthropic', 'second'], ['openai', 'default'], ['openai', 'second'],
  ] as const)('reads only the bound %s/%s quota for a native task', async (provider, accountId) => {
    h.pools[provider] = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.bindings.set('native:limited-task', { providerId: provider, accountId });
    const now = Date.now();
    const reset = now / 1000 + 3600;
    const bucket = { limitId: 'codex', limitName: null, updatedAt: now,
      primary: { usedPercent: 100, resetsAt: reset, windowMinutes: 300 }, secondary: null };
    h.usage.mockResolvedValue(provider === 'anthropic'
      ? { claudeUsage: { updatedAt: now, fiveHour: { utilization: 100, resetsAt: reset }, sevenDay: null, scoped: [] } }
      : { codexUsage: { appServerBuckets: { codex: bucket }, webSnapshot: bucket } });
    const scope = { subscriptionSessionId: 'limited-task' };
    const channel = provider === 'anthropic' ? 'maker:usage:claude-subscription' : 'maker:usage:account';
    const args = provider === 'anthropic' ? [provider, true, scope] : ['codex', provider, scope];
    const result = await readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, channel, args, readSubscriptionSessionUsage);
    expect(result).toMatchObject(provider === 'anthropic' ? { fiveHour: { utilization: 100, resetsAt: reset } }
      : { primary: { usedPercent: 100, resetsAt: reset }, nativeAccountPool: true });
    expect(h.usage).toHaveBeenCalledExactlyOnceWith(provider, `${provider}/${accountId}`);
    // A removed binding must not fall back to the still-available other profile.
    h.pools[provider]!.accounts = h.pools[provider]!.accounts.filter(a => a.id !== accountId);
    expect(await readSubscriptionSessionUsage(provider, 'limited-task')).toBeNull();
    expect(await readSubscriptionSessionUsage(provider, 'pre-pool-task')).toBeUndefined();
    expect(h.usage).toHaveBeenCalledTimes(1);
  });

  // Unit: legacy wire reads must expose usable pool quota when the first account
  // is exhausted. Existing tests only exercise the new pool query, not old calls.
  it.each(['anthropic', 'openai'] as const)('keeps old %s quota readers usable without changing the default account card', async (provider) => {
    h.pools[provider] = { strategy: 'order', accounts: [account('default'), account('second')] };
    if (provider === 'anthropic') h.read.mockImplementation(async (_kind: string, directory: string) => ({
      authenticated: true, identity: directory, plan: 'pro', planTier: 'pro',
      planDisplayName: directory.endsWith('second') ? 'Ultra' : 'Pro',
    }));
    const now = Date.now();
    h.usage.mockImplementation(async (_provider: string, directory: string) => {
      const used = directory.endsWith('default') ? 100 : 12;
      const bucket = { limitId: 'codex', limitName: null, updatedAt: now,
        primary: { usedPercent: used, windowMinutes: 300, resetsAt: now / 1000 + 3600 }, secondary: null };
      return provider === 'anthropic'
        ? { claudeUsage: { updatedAt: now, fiveHour: { utilization: used, resetsAt: now / 1000 + 3600 }, sevenDay: null, scoped: [], accountFingerprint: 'private-identity' } }
        : { codexUsage: { appServerBuckets: { codex: bucket }, webSnapshot: bucket } };
    });
    const read = (channel: string, args: unknown[]) => readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, channel, args);
    if (provider === 'anthropic') {
      const usage = await read('maker:usage:claude-subscription', []);
      expect(usage).toMatchObject({ fiveHour: { utilization: 12 }, providerId: 'anthropic',
        subscriptionType: 'pro', planTier: 'pro', planDisplayName: 'Ultra' });
      expect(providerGroupMemberUsageState({ claudeUsage: providerGroupUsageSnapshot(usage, now) }, undefined, now, 'claude-code').limited).toBe(false);
      expect(JSON.stringify(usage)).not.toContain('private-identity');
    } else {
      const usage = await read('maker:usage:account', ['codex']);
      const limits = await read('maker:usage:codex-rate-limits', []);
      const combined = providerGroupCodexUsageFromReads(usage, limits, now);
      for (const kind of ['codex', 'claude-code', 'pi'])
        expect(providerGroupMemberUsageState({ codexUsage: combined }, undefined, now, kind).limited).toBe(false);
      expect(limits).toMatchObject({ rateLimits: { primary: { usedPercent: 12 } }, resetOffer: null, rateLimitResetCredits: null });
    }
    const original = (await readSubscriptionPool(provider)).accounts[0];
    expect(provider === 'anthropic' ? original.usage?.claude?.fiveHour?.utilization
      : original.usage?.codex?.buckets.codex.primary?.usedPercent).toBe(100);
    const lease = await acquireSubscriptionAccount(provider, undefined, []);
    expect(lease).toMatchObject({ account: { configDir: `${provider}/second` } });
    lease?.release();
  });

  it('preserves legacy, named and explicit default-account reads, and never revives a disconnected pool', async () => {
    const read = vi.fn(readLegacySubscriptionPoolUsage);
    for (const [channel, args] of [
      ['maker:usage:claude-subscription', ['anthropic', false, 'default-subscription-account']],
      ['maker:usage:account', ['codex', 'openai', 'default-subscription-account']],
      ['maker:usage:codex-rate-limits', ['openai', 'default-subscription-account']],
      ['maker:usage:account', ['codex', 'openai-second']],
      ['maker:usage:claude-subscription', ['anthropic-second']],
      ['maker:usage:account', ['claude-code']],
    ] as Array<[string, unknown[]]>) expect(await readLegacySubscriptionQuota(read, channel, args)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    h.pools = {};
    expect(await readLegacySubscriptionQuota(read, 'maker:usage:account', ['codex'])).toBeUndefined();
    h.pools.openai = { strategy: 'order', accounts: [account('default')] };
    expect(await readLegacySubscriptionQuota(read, 'maker:usage:account', ['codex'])).toMatchObject({ providerId: 'openai' });
    h.pools.openai = { strategy: 'order', disconnected: true, accounts: [account('default')] };
    expect(await readLegacySubscriptionQuota(read, 'maker:usage:account', ['codex'])).toBeNull();
  });

  // Unit: legacy rate-limits readers timestamp a reply as fresh. A cached model
  // bucket must neither gain a new lifetime nor become the generic/WHAM quota.
  it.each([0, 11 * 60_000])('keeps model-only quota separate and rejects %i ms old native reads', async (age) => {
    h.pools.openai = { strategy: 'order', accounts: [account('second')] };
    const now = Date.now();
    const bucket = { limitId: 'spark', limitName: 'Spark', updatedAt: now - age,
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: now / 1000 + 3600 }, secondary: null };
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { spark: bucket }, webSnapshot: null } });
    const usage = await readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, 'maker:usage:account', ['codex']);
    expect(usage).toMatchObject({ webSnapshot: null, appServerBuckets: { spark: { updatedAt: now - age } } });
    expect(usage).not.toHaveProperty('primary');
    const limits = await readLegacySubscriptionQuota(readLegacySubscriptionPoolUsage, 'maker:usage:codex-rate-limits', []);
    if (age) expect(limits).toBeNull();
    else expect(limits).toMatchObject({ rateLimits: { primary: null }, rateLimitsByLimitId: { spark: { primary: { usedPercent: 100 } } } });
  });
  // Regression: a signed-in CLI was silently reused by the wizard's "add account".
  // Unit tier: the real command entry must keep preview read-only and explicit
  // new-account intent isolated, including an unbound or expired first account.
  it.each(['anthropic', 'openai'] as const)(
    'previews an unbound %s login without authorizing it',
    async (providerId) => {
      h.bound = false;
      h.pools = {};
      const preview = await runSubscriptionAccountCommand({ action: 'preview', providerId });
      expect(preview.accounts[0]).toMatchObject({
        id: 'default',
        identity: 'account',
        status: 'ready',
      });
      expect(preview.defaultAdded).toBe(false);
      expect(h.pools).toEqual({});
      expect(h.login).not.toHaveBeenCalled();
      expect((await readSubscriptionPool(providerId)).accounts[0].status).toBe('signed-out');
      expect(await acquireSubscriptionAccount(providerId, undefined, [])).toBeNull();
    },
  );
  // PR #10473: a retained same-identity account in a disconnected built-in pool must not hide
  // the shortcut. An account placed in its own provider stays connected when the built-in is off.
  it.each(['anthropic', 'openai'] as const)(
    'restores the %s shortcut after disconnecting the same-identity built-in account',
    async (providerId) => {
      h.bound = false;
      h.pools[providerId] = { strategy: 'least', accounts: [account('default'), account('second')] };
      h.read.mockResolvedValue({ authenticated: true, identity: 'same@example.com' });
      const preview = () => runSubscriptionAccountCommand({ action: 'preview', providerId });
      expect((await preview()).defaultAdded).toBe(true);
      await disconnectSubscriptionPool(providerId);
      expect((await preview()).defaultAdded).toBe(false);
      h.placement[`${providerId}:second`] = `${providerId}-sub-12345678`;
      expect((await preview()).defaultAdded).toBe(true);
    },
  );
  // Unit: old native connections already used the default login before a pool file existed.
  // The wizard must hide that shortcut without creating a pool; an explicitly removed slot stays removed.
  it.each(['anthropic', 'openai'] as const)(
    'recognizes an implicit %s default login already connected before account pools',
    async (providerId) => {
      h.bound = true;
      h.pools = {};
      expect((await runSubscriptionAccountCommand({ action: 'preview', providerId })).defaultAdded).toBe(true);
      expect(h.pools).toEqual({});
      h.pools[providerId] = { strategy: 'least', accounts: [] };
      const preview = await runSubscriptionAccountCommand({ action: 'preview', providerId });
      expect(preview.defaultAdded).toBe(false);
      expect(preview.accounts[0]).toMatchObject({ id: 'default', status: 'ready' });
      expect(h.login).not.toHaveBeenCalled();
    },
  );
  it.each(
    ['anthropic', 'openai'].flatMap((providerId) =>
      [true, false].map((bound) => ({ providerId: providerId as SubscriptionProvider, bound })),
    ),
  )(
    'keeps explicit new $providerId login isolated with default binding=$bound',
    async ({ providerId, bound }) => {
      h.bound = bound;
      h.pools = {};
      h.read.mockImplementation(async (_provider, directory) => ({
        authenticated: !directory.endsWith('default') || !bound,
        identity: directory.endsWith('default') ? 'original@example.com' : 'new@example.com',
      }));
      await runSubscriptionAccountCommand({
        action: 'connect',
        target: 'new',
        providerId,
        loginKey: 'new',
      });
      const ids = h.pools[providerId]!.accounts.map((a) => a.id);
      expect(ids).toEqual(['default', expect.stringMatching(/^cindy-/)]);
      expect(h.placement[`${providerId}:${ids[1]}`]).toBe(providerId);
      expect(h.login).toHaveBeenCalledExactlyOnceWith(
        providerId,
        `${providerId}/${ids[1]}`,
        expect.any(AbortSignal),
      );
      // Wizard shortcut (2026-11-14): the CLI login counts as added once the built-in provider uses
      // it, or once the same identity is already signed in as another account.
      const preview = () => runSubscriptionAccountCommand({ action: 'preview', providerId });
      expect((await preview()).defaultAdded).toBe(bound);
      h.read.mockImplementation(async (_provider, directory) => ({
        authenticated: true,
        identity: directory.endsWith('default') ? 'New@Example.com' : 'new@example.com',
      }));
      expect((await preview()).defaultAdded).toBe(true);
    },
  );
  it.each(['anthropic', 'openai'].flatMap(providerId =>
    ['connect', 'add'].map(action => ({ providerId: providerId as SubscriptionProvider, action: action as 'connect' | 'add' }))))(
    'connects the detected $providerId default through $action without another browser login',
    async ({ providerId, action }) => {
      h.bound = false;
      h.pools = {};
      await runSubscriptionAccountCommand({
        action,
        target: 'default',
        providerId,
        loginKey: 'existing',
      } as SubscriptionAccountCommand);
      expect(h.pools[providerId]!.accounts.map((a) => a.id)).toEqual(['default']);
      expect(h.login).not.toHaveBeenCalled();
      // Turning the built-in provider off offers the CLI login in the wizard again.
      h.bound = true;
      h.pools[providerId]!.disconnected = true;
      expect((await runSubscriptionAccountCommand({ action: 'preview', providerId })).defaultAdded).toBe(false);
    },
  );
  it('keeps the private legacy Codex default when the wizard connects it', async () => {
    h.shared = false;
    h.pools = {};
    const preview = await runSubscriptionAccountCommand({
      action: 'preview',
      providerId: 'openai',
    });
    expect(preview.accounts[0]).toMatchObject({ identity: 'original@example.com', legacy: true });
    await runSubscriptionAccountCommand({
      action: 'connect',
      target: 'default',
      providerId: 'openai',
      loginKey: 'legacy',
    });
    expect(h.pools.openai!.legacyCodexDefault).toBe(true);
    expect(h.login).not.toHaveBeenCalled();
    expect(h.legacyLogin).not.toHaveBeenCalled();
    expect((await readSubscriptionPool('openai')).accounts[0].directory).toBe(
      '/existing-cindy/codex-home',
    );
  });
  // Shutdown may end the event queue before the underlying process confirms exit.
  it.each(['close', 'detach'] as const)(
    'keeps an account protected through %s failure and late terminal events until retry succeeds',
    async (method) => {
      h.pools.anthropic = { strategy: 'least', accounts: [account('second')] };
      let rejectClose!: (error: Error) => void;
      const teardown = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectClose = reject;
            }),
        )
        .mockResolvedValue(undefined);
      const nativeHandle = {
        id: 'closing-thread',
        send: vi.fn(async () => {}),
        close: teardown,
        detach: teardown,
        events: async function* () {
          yield { type: 'done', data: {} };
        },
      } as unknown as AgentSessionHandle;
      const agent = withSubscriptionAccounts({
        kind: 'claude-code',
        startSession: async () => nativeHandle,
      } as unknown as BaseAgent);
      const handle = await agent.startSession({
        providerId: 'anthropic',
        sessionId: 'closing-task',
      } as StartSessionOptions);
      await handle.send({ type: 'user', content: 'hello' });
      const closing = expect(handle[method]!()).rejects.toThrow('shutdown failed');
      for await (const event of handle.events()) expect(event.type).toBe('done');
      const login = {
        action: 'login' as const,
        providerId: 'anthropic' as const,
        accountId: 'second',
        loginKey: 'blocked',
      };
      await expect(runSubscriptionAccountCommand(login)).rejects.toThrow('in use');
      rejectClose(new Error('shutdown failed'));
      await closing;
      expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(1);
      expect(getSessionSubscriptionAccount('closing-task')).toBeDefined();
      await expect(
        runSubscriptionAccountCommand({
          action: 'remove',
          providerId: 'anthropic',
          accountId: 'second',
        }),
      ).rejects.toThrow('in use');
      await expect(handle.send({ type: 'user', content: 'late' })).rejects.toThrow('closing');
      await handle[method]!();
      expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(0);
      expect(getSessionSubscriptionAccount('closing-task')).toBeUndefined();
      await runSubscriptionAccountCommand(login);
      expect(h.login).toHaveBeenCalledOnce();
    },
  );
  it('does not interpret a consumer leaving the event iterator as runtime shutdown', async () => {
    const nativeHandle = {
      id: 'live-thread',
      send: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      events: async function* () {
        yield { type: 'text', data: { text: 'still working' } };
      },
    } as unknown as AgentSessionHandle;
    const agent = withSubscriptionAccounts({
      kind: 'claude-code',
      startSession: async () => nativeHandle,
    } as unknown as BaseAgent);
    const handle = await agent.startSession({
      providerId: 'anthropic',
      sessionId: 'live-task',
    } as StartSessionOptions);
    await handle.send({ type: 'user', content: 'hello' });
    for await (const event of handle.events()) {
      expect(event.type).toBe('text');
      break;
    }
    expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(1);
    expect(getSessionSubscriptionAccount('live-task')).toBeDefined();
    await handle.close();
    expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(0);
  });
  it.each(['stopped', 'unauthenticated', 'pending', 'opaque'] as const)(
    'only releases a %s startup reservation when its process is confirmed stopped',
    async (kind) => {
      let stopped!: () => void;
      const whenStopped = new Promise<void>((resolve) => {
        stopped = resolve;
      });
      const error =
        kind === 'stopped'
          ? new AgentStartupStoppedError('failed')
          : kind === 'unauthenticated'
            ? new AgentNotAuthenticatedError('claude-code')
            : kind === 'pending'
              ? new AgentStartupCleanupPendingError('failed', { cause: 'failed', whenStopped })
              : new Error('opaque failure');
      const agent = withSubscriptionAccounts({
        kind: 'claude-code',
        startSession: async () => {
          throw error;
        },
      } as unknown as BaseAgent);
      await expect(
        agent.startSession({
          providerId: 'anthropic',
          sessionId: 'failed-task',
        } as StartSessionOptions),
      ).rejects.toBe(error);
      expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(
        kind === 'pending' || kind === 'opaque' ? 1 : 0,
      );
      if (kind === 'pending') {
        expect(getSessionSubscriptionAccount('failed-task')).toBeDefined();
        stopped();
        await whenStopped;
        expect((await readSubscriptionPool('anthropic')).accounts[0].running).toBe(0);
        expect(getSessionSubscriptionAccount('failed-task')).toBeUndefined();
      }
    },
  );
  // Unit, 2026-11-11 user decision: accounts fail over like provider group members (§6.1).
  // Minimal input: the first account hits its usage limit while starting a new task, the second is healthy.
  it('moves a new task that fails to start to the next account and remembers the failure across restarts', async () => {
    const limit = new AgentStartupStoppedError('usage limit exceeded');
    const start = vi.fn(async (options: StartSessionOptions) => {
      if (options[NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir === 'anthropic/default') throw limit;
      return { id: 'native-second', events: async function* () {}, send: vi.fn(), close: vi.fn() } as unknown as AgentSessionHandle;
    });
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'anthropic', sessionId: 'moved', model: 'claude-sonnet' } as StartSessionOptions);
    expect(handle.id).toBe('native-second');
    expect(start).toHaveBeenCalledTimes(2);
    expect(h.bindings.get('task:moved')).toMatchObject({ accountId: 'second' });
    expect(h.writeCooling).toHaveBeenLastCalledWith({ anthropic: { default: expect.any(Object) } });
    // A restarted owner runtime reads the remembered failure and keeps new tasks off that account.
    h.cooling = h.writeCooling.mock.calls.at(-1)![0];
    h.owner = 'owner-a:restarted';
    h.pools.anthropic!.accounts[1].limit = 4;
    const next = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', []);
    expect(next!.accountId).toBe('second');
    next!.release();
  });
  it('returns the original start failure once every account was tried, and never moves a pinned task', async () => {
    const failure = new AgentNotAuthenticatedError('claude-code');
    const start = vi.fn(async () => { throw failure; });
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: start } as unknown as BaseAgent);
    await expect(agent.startSession({ providerId: 'anthropic', sessionId: 'all-fail' } as StartSessionOptions)).rejects.toBe(failure);
    expect(start).toHaveBeenCalledTimes(2);
    start.mockClear();
    h.bindings.set('task:pinned', { providerId: 'anthropic', accountId: 'second' });
    await expect(agent.startSession({ providerId: 'anthropic', sessionId: 'pinned' } as StartSessionOptions)).rejects.toBe(failure);
    expect(start).toHaveBeenCalledTimes(1);
  });
  // Unit, 2026-11-11 user decision: a bound account that cannot take the task model moves before the
  // next send, like a provider group member (§5 pre-send quota check, §6.1). Minimal input: two
  // accounts, the bound one exhausted; then running, paused and nowhere-to-go variants.
  it('moves a task off an exhausted bound account before sending, and only when another account can take it', async () => {
    h.pools.anthropic!.accounts = [{ ...account('default'), limit: 4 }, { ...account('second'), limit: 4 }];
    const exhausted = new Set<string>();
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({ claudeUsage: { updatedAt: Date.now(),
      fiveHour: { utilization: [...exhausted].some(id => dir.endsWith(id)) ? 100 : 10, resetsAt: Date.now() / 1000 + 3600 },
      sevenDay: { utilization: 20, resetsAt: Date.now() / 1000 + 86400 }, scoped: [] } }));
    h.bindings.set('task:t', { providerId: 'anthropic', accountId: 'default' });
    const row = { status: 'active', providerId: 'anthropic', agentKind: 'cc', model: 'claude-sonnet', sdkSessionId: 'native-a' };
    let running = false;
    const rebuild = vi.fn(async (_id: string, assertCurrent: () => void) => { assertCurrent(); });
    const deps = { readSession: async () => row, isRunning: () => running, rebuild };
    // Drop runtime state and explicitly refresh quota: persisted snapshots now survive restart.
    // The pre-send check still only consumes the refreshed cache and never waits for the CLI.
    const freshOwner = async () => { h.owner += '-fresh'; await refreshSubscriptionPool('anthropic', true); };
    expect(await prepareSubscriptionAccountFailover('t', deps)).toBe(false);
    exhausted.add('default'); await freshOwner();
    running = true;
    expect(await prepareSubscriptionAccountFailover('t', deps)).toBe(false);
    running = false;
    h.pools.anthropic!.accounts[0].paused = true;
    expect(await prepareSubscriptionAccountFailover('t', deps)).toBe(false);
    h.pools.anthropic!.accounts[0].paused = false;
    exhausted.add('second'); await freshOwner();
    expect(await canSwitchSubscriptionAccount('t', deps.readSession)).toBe(false);
    expect(await prepareSubscriptionAccountFailover('t', deps)).toBe(false);
    expect(rebuild).not.toHaveBeenCalled();
    exhausted.delete('second'); await freshOwner();
    expect(await canSwitchSubscriptionAccount('t', deps.readSession)).toBe(true);
    expect(await prepareSubscriptionAccountFailover('t', deps)).toBe(true);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(h.bindings.get('task:t')).toMatchObject({ accountId: 'second' });
    // The probe reserves nothing; the move holds one slot until runtime takeover.
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([0, 1]);
    // Another computer, SSH and unbound tasks never move here.
    for (const other of [{ agentDeviceId: 'mac' }, { remoteHostId: 'ssh' }]) {
      expect(await prepareSubscriptionAccountFailover('t', { ...deps, readSession: async () => ({ ...row, ...other }) })).toBe(false);
    }
  });
  // Unit, shared-task login log: an executor may keep reporting a successful
  // CLI snapshot. The remembered auth failure must still make the pool switch.
  it('switches a Pi task after its selected-account login rejection', async () => {
    const message = '[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The task subscription account requires login';
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    const model = 'chatgpt/gpt-6.1-sol';
    const lease = await acquireSubscriptionAccount('openai', model, []);
    expect(lease!.accountId).toBe('default');
    await lease!.bind(['task:pi-login', 'native:pi-old']);
    expect(lease!.observeFailure({ message, sdkError: message }, model, 'run')).toBe(true);
    lease!.release();
    expect(h.writeCooling).toHaveBeenCalledWith(expect.objectContaining({ openai: {
      default: { '': expect.any(Number) },
    } }));
    const row = { status: 'active', providerId: 'openai', agentKind: 'pi', model, sdkSessionId: 'pi-old' };
    const rebuild = vi.fn(async () => undefined);
    expect(await prepareSubscriptionAccountFailover('pi-login', { readSession: async () => row, isRunning: () => false, rebuild })).toBe(true);
    expect(rebuild).toHaveBeenCalledOnce();
    expect(h.bindings.get('task:pi-login')).toMatchObject({ accountId: 'second' });
    expect(h.bindings.get('native:pi-old')).toMatchObject({ accountId: 'default' });
  });

  it('does not turn a request-time account read failure into a signed-out state', async () => {
    vi.useFakeTimers();
    let lease: Awaited<ReturnType<typeof acquireSubscriptionAccount>> = null;
    try {
      h.pools.openai = { strategy: 'order', accounts: [account('default')] };
      lease = await acquireSubscriptionAccount('openai', 'chatgpt/gpt-6.1-sol', []);
      h.read.mockRejectedValue(new Error('temporary CLI failure'));
      await vi.advanceTimersByTimeAsync(30_001);
      const failure = await lease!.account.readState().catch(error => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toBe('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE] The task subscription account is unavailable');
      expect(lease!.observeFailure(failure, 'chatgpt/gpt-6.1-sol', 'run')).toBe(true);
      expect(h.writeCooling).not.toHaveBeenCalled();
    } finally {
      lease?.release();
      vi.useRealTimers();
    }
  });

  // Unit / shared A grows by merging B: the hosted replacement probe must use
  // A's actual admission, while B's retained share cannot inherit A's accounts.
  // Existing probes covered owner tasks, not this unchanged-share boundary.
  it.each(['pool', 'alias'] as const)('offers a hosted replacement only inside the original shared provider: %s', async route => {
    h.pools.anthropic!.accounts = [account('default'), account('second')];
    const a = 'anthropic-sub-aaaaaaaa';
    const b = 'anthropic-sub-bbbbbbbb';
    h.created[a] = { kind: 'anthropic', name: 'A', account: route === 'pool' ? 'default' : 'second' };
    h.created[b] = { kind: 'anthropic', name: 'B', account: route === 'pool' ? 'second' : 'default' };
    h.placement['anthropic:default'] = a;
    h.placement['anthropic:second'] = a;
    const model = 'claude-sonnet';
    const original = await acquireSubscriptionAccount(a, model, [], false, { accountId: 'default' });
    await original!.bind(['task:guest-a']);
    original!.observeFailure({ sdkError: 'rate_limit' }, model, 'run');
    original!.release();
    const published = route === 'pool' ? a : b;
    if (route === 'alias') h.bindings.set('task:guest-a', { providerId: 'anthropic', accountId: 'default', via: b });
    const view = await readSubscriptionSessionAccount('anthropic', {
      sessionId: 'guest-a', model, routeProviderId: published,
    }, { remote: true });
    expect(view).toMatchObject({ state: 'bound', account: { blocked: true, switchAvailable: true } });
    // The owner can move B's task to A, but B's guest must keep B's grant.
    if (route === 'alias') expect(view).toHaveProperty('replacementProviderId', a);
    expect(await canSwitchHostedSubscriptionAccount(published, 'guest-a', model)).toBe(route === 'pool');
    h.pools.anthropic!.accounts[1].paused = true;
    expect(await canSwitchHostedSubscriptionAccount(a, 'guest-a', model)).toBe(false);
    expect(h.bindings.get('task:guest-a')?.accountId).toBe('default');
  });

  it('moves a task off an account that remembers a real failure for its model', async () => {
    h.pools.anthropic!.accounts = [{ ...account('default'), limit: 4 }, { ...account('second'), limit: 4 }];
    const lease = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', []);
    expect(lease!.accountId).toBe('default');
    await lease!.bind(['task:cooled']);
    expect(lease!.observeFailure({ sdkError: 'rate_limit' }, 'claude-sonnet', 'run')).toBe(true);
    lease!.release();
    const row = { status: 'active', providerId: 'anthropic', agentKind: 'cc', model: 'claude-sonnet', sdkSessionId: 'native-c' };
    const rebuild = vi.fn(async () => undefined);
    expect(await prepareSubscriptionAccountFailover('cooled', { readSession: async () => row, isRunning: () => false, rebuild })).toBe(true);
    expect(h.bindings.get('task:cooled')).toMatchObject({ accountId: 'second' });
    // A different model family is not blocked by that failure.
    h.bindings.set('task:other-model', { providerId: 'anthropic', accountId: 'default' });
    expect(await prepareSubscriptionAccountFailover('other-model', { readSession: async () => ({ ...row, model: 'claude-opus' }),
      isRunning: () => false, rebuild })).toBe(false);
  });
  // 2026-11-12 incident (unit): after the group moved a task to another computer, the fresh native
  // session there kept the task's exhausted account (SUBSCRIPTION_ACCOUNT_LIMITED) although a second
  // account was ready. Minimal input: the bound account remembers a usage limit for the task model.
  it('starts a fresh native session of a bound task on another account when the bound one is blocked', async () => {
    h.pools.anthropic!.accounts = [{ ...account('default'), limit: 4 }, { ...account('second'), limit: 4 }];
    const model = 'claude-sonnet';
    const failed = await acquireSubscriptionAccount('anthropic', model, []);
    await failed!.bind(['task:moved', 'native:old']);
    failed!.observeFailure({ sdkError: 'rate_limit' }, model, 'run');
    failed!.release();
    // The executing computer reports the same judgment to the controller only for a model query.
    expect(await readSubscriptionSessionAccount('anthropic', { sessionId: 'moved', model }))
      .toMatchObject({ state: 'bound', account: { number: 1, blocked: true, switchAvailable: true } });
    expect(await readSubscriptionSessionAccount('anthropic', { sessionId: 'moved' })).not.toHaveProperty('account.blocked');
    const start = vi.fn(async () => ({ id: 'native-new', events: async function* () {}, send: vi.fn(), close: vi.fn() }) as unknown as AgentSessionHandle);
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: start } as unknown as BaseAgent);
    await agent.startSession({ providerId: 'anthropic', sessionId: 'moved', model } as StartSessionOptions);
    expect((start.mock.calls[0] as unknown as [StartSessionOptions])[0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/second');
    expect(h.bindings.get('task:moved')).toMatchObject({ accountId: 'second' });
    expect(h.bindings.get('native:old')).toMatchObject({ accountId: 'default' });
    // Every other account blocked too: the task keeps its own account instead of failing as full.
    const second = await acquireSubscriptionAccount('anthropic', model, ['task:moved']);
    second!.observeFailure({ sdkError: 'rate_limit' }, model, 'run');
    second!.release();
    h.bindings.set('task:stay', { providerId: 'anthropic', accountId: 'default' });
    await agent.startSession({ providerId: 'anthropic', sessionId: 'stay', model } as StartSessionOptions);
    expect((start.mock.calls[1] as unknown as [StartSessionOptions])[0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/default');
  });
  // 2026-11-12 incident (unit): a same-account remote task stayed on its exhausted account although
  // its computer had another one; pre-send and immediate continuation only handled local tasks.
  it('hands a remote task off an account its computer reports blocked, only when that computer can continue', async () => {
    const row = { status: 'active', providerId: 'anthropic', agentKind: 'cc', model: 'claude-sonnet',
      sdkSessionId: 'remote-native', agentDeviceId: 'mac-mini' };
    const bound = (extra: object) => ({ ok: true, result: { providerId: 'anthropic', state: 'bound',
      account: { isDefault: true, number: 1, paused: false, status: 'ready', ...extra } } });
    // The executor returns actual admission in the existing session read. A quota request would
    // fail here: an optional replacement probe must not add a new timeout that blocks sending.
    h.remote.mockImplementation(async (_device, channel) => {
      if (channel !== 'maker:subscription-accounts') throw new Error('quota timeout');
      return bound({ blocked: true, switchAvailable: true });
    });
    expect(await needsSubscriptionAccountHandoff('t', row)).toBe(true);
    expect(h.remote.mock.calls[0][2]).toEqual([{ action: 'session', providerId: 'anthropic', routeProviderId: 'anthropic',
      nativeSessionId: 'remote-native', model: 'claude-sonnet' }]);
    // No other account there: the message still goes to the original account, the send is not failed.
    h.remote.mockResolvedValueOnce(bound({ blocked: true, switchAvailable: false }));
    expect(await needsSubscriptionAccountHandoff('t', row)).toBe(false);
    // Missing or malformed admission never authorizes retiring context, including older replies.
    for (const extra of [{}, { blocked: true }, { blocked: true, switchAvailable: 'true' }]) {
      h.remote.mockReset().mockResolvedValueOnce(bound(extra));
      expect(await needsSubscriptionAccountHandoff('t', row)).toBe(false);
      expect(h.remote).toHaveBeenCalledTimes(1);
    }
    // A usage-limit failure continues at once on the same evidence; shared providers never move.
    h.remote.mockResolvedValueOnce(bound({ blocked: true, switchAvailable: true }));
    expect(await canSwitchSubscriptionAccount('t', async () => row, h.remote)).toBe(true);
    expect(await canSwitchSubscriptionAccount('t', async () => ({ ...row, agentDeviceId: 'share:someone' }), h.remote)).toBe(false);
    expect(h.remote).toHaveBeenCalledTimes(2);
    h.remote.mockImplementationOnce(async () => {
      h.owner += '-changed';
      return bound({ blocked: true, switchAvailable: true });
    });
    await expect(needsSubscriptionAccountHandoff('t', row)).rejects.toThrow('owner changed');
  });
  // PR #10152 review, unit: quota alone is not admission. The healthy replacement may already
  // occupy its only slot; exercise executor selection and controller handoff together.
  it('preserves a remote native session when every replacement account is full', async () => {
    const model = 'claude-sonnet';
    h.pools.anthropic!.accounts = [account('default'), { ...account('second'), limitSet: true }];
    const failed = await acquireSubscriptionAccount('anthropic', model, []);
    await failed!.bind(['task:remote-full', 'native:remote-full']);
    failed!.observeFailure({ sdkError: 'rate_limit' }, model, 'run');
    failed!.release();
    const competing = await acquireSubscriptionAccount('anthropic', model, ['task:competing']);
    const now = Date.now();
    h.usage.mockResolvedValue({ claudeUsage: { updatedAt: now,
      fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
      sevenDay: { utilization: 20, resetsAt: now / 1000 + 86400 }, scoped: [] } });
    h.remote.mockImplementation(async (_device, channel, args) => ({ ok: true,
      result: channel === 'maker:subscription-accounts'
        ? await readSubscriptionSessionAccount('anthropic', args[0] as { nativeSessionId: string; model: string })
        : { providerId: 'anthropic', model, available: true },
    }));
    const row = { status: 'active', providerId: 'anthropic', agentKind: 'cc', model,
      sdkSessionId: 'remote-full', agentDeviceId: 'other-computer' };
    expect(await needsSubscriptionAccountHandoff('remote-full', row)).toBe(false);
    expect(await canSwitchSubscriptionAccount('remote-full', async () => row, h.remote)).toBe(false);
    competing!.release();
    expect(await needsSubscriptionAccountHandoff('remote-full', row)).toBe(true);
    expect(h.bindings.get('native:remote-full')?.accountId).toBe('default');
    expect((await readSubscriptionPool('anthropic')).accounts.map(a => a.running)).toEqual([0, 0]);
  });
  // PR #10152 independent review, unit: optional replacement reads must not extend the original
  // account query past its transport deadline. Fake time covers both a slow bound read and a
  // cold replacement; late completion must never move a binding.
  it.each([0, 15_000])('bounds optional replacement admission after a %s ms bound-account read', async (accountDelay) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] });
    try {
      const model = 'claude-sonnet';
      const failed = await acquireSubscriptionAccount('anthropic', model, []);
      await failed!.bind(['task:slow-probe', 'native:slow-probe']);
      failed!.observeFailure({ sdkError: 'rate_limit' }, model, 'run');
      failed!.release();
      await vi.advanceTimersByTimeAsync(31_000);
      h.read.mockImplementation(async (_provider, directory) => {
        await new Promise(resolve => setTimeout(resolve, directory.endsWith('default') ? accountDelay : 20_000));
        if (directory.endsWith('default') && accountDelay) throw new Error('native status timed out');
        return { authenticated: true, identity: 'fixture@example.test' };
      });
      let view: unknown;
      const query = readSubscriptionSessionAccount('anthropic', { nativeSessionId: 'slow-probe', model })
        .then(result => { view = result; });
      await vi.advanceTimersByTimeAsync(Math.max(accountDelay, 2_000));
      expect(view).toMatchObject({ state: 'bound', account: { blocked: true, switchAvailable: false } });
      await vi.runAllTimersAsync();
      await query;
      expect(h.bindings.get('task:slow-probe')?.accountId).toBe('default');
      expect(h.bindings.get('native:slow-probe')?.accountId).toBe('default');
    } finally {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
  });
  // PR review: selection happens before any process exists, so Maker must release startup resources.
  it('classifies an unavailable pool as a stopped startup without calling the native agent', async () => {
    h.pools.anthropic!.disconnected = true;
    const start = vi.fn();
    const agent = withSubscriptionAccounts({
      kind: 'claude-code',
      startSession: start,
    } as unknown as BaseAgent);
    await expect(
      agent.startSession({ providerId: 'anthropic' } as StartSessionOptions),
    ).rejects.toBeInstanceOf(AgentStartupStoppedError);
    expect(start).not.toHaveBeenCalled();
  });
  it('forks and binds a secondary Claude profile without moving to the default account', async () => {
    h.bindings.set('native:source-second', { providerId: 'anthropic', accountId: 'second' });
    const fork = vi.fn(async (options: ForkSdkSessionOptions) => {
      expect(options[NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/second');
      return { newSdkSessionId: 'fork-second', uuidMap: new Map() };
    });
    const agent = withSubscriptionAccounts({
      kind: 'claude-code',
      forkSdkSession: fork,
    } as unknown as BaseAgent);
    await agent.forkSdkSession({
      providerId: 'anthropic',
      sourceSdkSessionId: 'source-second',
      upToMessageId: 'message-second',
      workingDir: '/work',
    });
    expect(fork).toHaveBeenCalledOnce();
    expect(h.bindings.get('native:fork-second')?.accountId).toBe('second');
  });
  it('merges direct Codex quota events by bucket without blocking pool credit admission for any engine', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default')] };
    const window = (usedPercent: number) => ({
      usedPercent,
      windowMinutes: 300,
      resetsAt: Date.now() / 1000 + 7200,
    });
    h.usage.mockResolvedValue({
      codexUsage: {
        appServerBuckets: {
          codex: {
            limitId: 'codex',
            limitName: 'Codex',
            updatedAt: Date.now(),
            primary: window(10),
            secondary: null,
          },
          spark: {
            limitId: 'spark',
            limitName: 'special-model',
            updatedAt: Date.now(),
            primary: window(20),
            secondary: null,
          },
        },
        webSnapshot: null,
      },
    });
    const lease = await acquireSubscriptionAccount('openai', 'gpt-6', []);
    observeSubscriptionAccountUsage(lease!.account, { limitId: 'codex', primary: window(100) });
    const pooled = await readSubscriptionPoolUsage('openai');
    expect(pooled?.codexUsage?.appServerBuckets?.spark.primary?.usedPercent).toBe(20);
    expect(pooled?.codexUsage?.appServerBuckets?.codex.limitName).toBe('Codex');
    for (const kind of ['codex', 'pi', 'claude-code']) {
      expect(
        providerGroupMemberUsageState(pooled!, 'chatgpt/gpt-6', Date.now(), kind).limited,
      ).toBe(false);
      expect(
        providerGroupMemberUsageState(pooled!, 'chatgpt/special-model', Date.now(), kind).limited,
      ).toBe(false);
    }
    lease?.release();
    const next = await acquireSubscriptionAccount('openai', 'gpt-6', []);
    expect(next?.account.configDir).toBe('openai/default');
    next?.release();
  });
  // Upgrade regression: existing authorizations must not be rewritten by installing or opening the new UI.
  it('passes existing single-account sessions through unchanged until a pool is configured', async () => {
    h.pools = {};
    for (const [kind, providerId] of [
      ['claude-code', 'anthropic'],
      ['codex', 'openai'],
      ['claude-code', 'openai'],
      ['pi', 'openai'],
    ]) {
      const start = vi.fn(async () => ({ id: 'existing' }));
      const agent = withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent);
      const options = { providerId, sessionId: 'existing-task' } as StartSessionOptions;
      await agent.startSession(options);
      expect(start).toHaveBeenCalledExactlyOnceWith(options);
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(h.legacyRead).not.toHaveBeenCalled();
    expect(h.login).not.toHaveBeenCalled();
    expect(h.pools).toEqual({});
  });
  it('keeps the authorized private Codex account after adding a second account fails, and then balances both after success', async () => {
    h.pools = {};
    h.shared = false;
    h.read.mockResolvedValue({ authenticated: false });
    h.login.mockRejectedValueOnce(new Error('login_cancelled'));
    const before = await readSubscriptionPool('openai');
    expect(before.configured).toBe(false);
    expect(before.accounts[0]).toMatchObject({
      status: 'ready',
      identity: 'original@example.com',
      directory: '/existing-cindy/codex-home',
    });
    await expect(
      runSubscriptionAccountCommand({
        action: 'add',
        providerId: 'openai',
        loginKey: 'cancelled-second',
      }),
    ).rejects.toThrow('login_cancelled');
    expect(h.pools.openai?.legacyCodexDefault).toBe(true);
    expect(h.placement).toEqual({});
    const after = await readSubscriptionPool('openai');
    expect(after.accounts.map((a) => a.status)).toEqual(['ready']);
    const original = await acquireSubscriptionAccount('openai', undefined, []);
    expect(original?.account.configDir).toBe('/existing-cindy/codex-home');
    original?.release();
    h.login.mockImplementation(async () => {
      h.read.mockResolvedValue({ authenticated: true, identity: 'second@example.com' });
    });
    await runSubscriptionAccountCommand({
      action: 'add',
      providerId: 'openai',
      loginKey: 'retry-second',
    });
    const addedId = h.pools.openai!.accounts[1].id;
    // Explicit additions to the built-in provider must survive the old-pool restoration.
    expect(h.placement[`openai:${addedId}`]).toBe('openai');
    await runSubscriptionAccountCommand({
      action: 'configure',
      providerId: 'openai',
      strategy: 'round',
    });
    const next = await acquireSubscriptionAccount('openai', undefined, []);
    expect(next?.account.configDir).toBe('openai/' + addedId);
    next?.release();
    expect(h.legacyLogin).not.toHaveBeenCalled();
    expect(h.legacyRead).toHaveBeenCalled();
  });
  // Standard: real dispatch wrappers share scheduling across all OpenAI engines.
  it('shares OpenAI accounts across Codex, Claude Code and Pi, including secondary-only login', async () => {
    h.pools.openai = { strategy: 'round', accounts: [{ ...account('default'), limit: 2 }, account('second')] };
    const selected: string[] = [];
    const handles: AgentSessionHandle[] = [];
    for (const kind of ['codex', 'claude-code', 'pi']) {
      const sessionId = 'pool-' + kind;
      const wrapped = withSubscriptionAccounts({
        kind,
        startSession: async (options: StartSessionOptions) => {
          expect(getSessionSubscriptionAccount(sessionId)).toBe(
            options[NATIVE_SUBSCRIPTION_ACCOUNT],
          );
          selected.push(options[NATIVE_SUBSCRIPTION_ACCOUNT]!.configDir);
          return {
            id: sessionId,
            close: async () => {},
            setModel: vi.fn(),
          } as unknown as AgentSessionHandle;
        },
      } as unknown as BaseAgent);
      handles.push(
        await wrapped.startSession({ providerId: 'openai', sessionId } as StartSessionOptions),
      );
    }
    expect(selected).toEqual(['openai/default', 'openai/second', 'openai/default']);
    expect(await handles[1].requiresModelSwitchRebuild?.('m', { providerId: 'xd' })).toBe(true);
    await Promise.all(handles.map((handle) => handle.close()));
    expect(getSessionSubscriptionAccount('pool-claude-code')).toBeUndefined();
    h.bound = false;
    h.owner = 'owner-a:' + ++generation;
    const secondary = await acquireSubscriptionAccount('openai', undefined, []);
    expect(secondary?.account.configDir).toBe('openai/second');
    secondary?.release();
  });
  it.each(['anthropic', 'openai'].flatMap(providerId =>
    [true, false].map(bound => ({ providerId: providerId as SubscriptionProvider, bound }))))('reconnects the signed-out $providerId default folder explicitly with binding=$bound', async ({ providerId, bound }) => {
    h.bound = bound;
    h.pools[providerId] = { strategy: 'least', accounts: [account('default')] };
    h.read.mockResolvedValue({ authenticated: false });
    h.login.mockImplementation(async () => {
      h.read.mockResolvedValue({ authenticated: true });
    });
    await runSubscriptionAccountCommand({
      action: 'connect',
      target: 'default',
      providerId,
      loginKey: 'reconnect-first',
    });
    expect(h.login).toHaveBeenCalledWith(providerId, `${providerId}/default`, expect.any(AbortSignal));
    expect(h.pools[providerId]!.accounts.map((a) => a.id)).toEqual(['default']);
  });
  it('only marks the selected account disconnected after a rejected bridge credential', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    const selected = await acquireSubscriptionAccount('openai', undefined, []);
    selected!.account.invalidateAuth!('token_revoked', 'fixture-token');
    expect((await readSubscriptionPool('openai')).accounts.map((a) => a.status)).toEqual([
      'signed-out',
      'ready',
    ]);
    const next = await acquireSubscriptionAccount('openai', undefined, []);
    expect(next?.account.configDir).toBe('openai/second');
    selected?.release();
    next?.release();
  });
  it('reserves concurrent starts before another picker can select, and counts running turns until release', async () => {
    const [first, second] = await Promise.all([
      acquireSubscriptionAccount('anthropic', 'claude-sonnet', ['task:a']),
      acquireSubscriptionAccount('anthropic', 'claude-sonnet', ['task:b']),
    ]);
    expect(first!.account.configDir).not.toBe(second!.account.configDir);
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      1, 1,
    ]);
    first!.running(false);
    const third = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', ['task:c']);
    expect(third!.account.id).toBe(first!.account.id);
    first!.release();
    second!.release();
    third!.release();
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      0, 0,
    ]);
  });
  // Unit, 2026-11-11 user decision: a full account takes no new task (was: overfill the least busy).
  // Minimal input: two accounts limited to one task each, a third new task, then the limit cleared.
  it('uses the group round and order policies and refuses new tasks once every account is full', async () => {
    h.pools.anthropic!.strategy = 'round';
    const a = await acquireSubscriptionAccount('anthropic', undefined, []);
    const b = await acquireSubscriptionAccount('anthropic', undefined, []);
    expect([a!.account.configDir, b!.account.configDir]).toEqual(['anthropic/default', 'anthropic/second']);
    await expect(acquireSubscriptionAccount('anthropic', undefined, [])).rejects.toThrow('[SUBSCRIPTION_ACCOUNTS_FULL]');
    // A pinned task keeps its account; the limit only gates new assignments.
    await a!.bind(['task:pinned']);
    const pinned = await acquireSubscriptionAccount('anthropic', undefined, ['task:pinned']);
    expect(pinned!.account.configDir).toBe('anthropic/default');
    pinned!.release();
    // Clearing the setting means unlimited concurrency for that account.
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'anthropic', accountId: 'second', limit: null });
    expect(h.pools.anthropic!.accounts[1]).toMatchObject({ limit: 4 });
    const extra = await acquireSubscriptionAccount('anthropic', undefined, []);
    expect(extra!.account.configDir).toBe('anthropic/second');
    a!.release();
    b!.release();
    extra!.release();
    h.pools.anthropic!.strategy = 'order';
    const ordered = await acquireSubscriptionAccount('anthropic', undefined, []);
    expect(ordered!.account.configDir).toBe('anthropic/default');
    ordered!.release();
  });
  // 2026-11-13 (subscription-account-pools.md 合并与拿出由用户决定), unit: the pool used to serve only
  // the built-in provider, so an account the user took out or moved kept being listed and assigned
  // there. Real command entry and dispatch; placement storage is the in-memory stand-in above.
  it.each(['anthropic', 'openai'] as const)('takes out, moves, merges and deletes %s providers by account', async kind => {
    h.pools[kind] = {
      strategy: 'order',
      accounts: ['default', 'second', 'third'].map(id => ({ ...account(id), limit: 4 })),
    };
    const ids = async (providerId: string) => (await readSubscriptionPool(providerId)).accounts.map(a => a.id);
    const pick = async (providerId: string) => {
      const lease = await acquireSubscriptionAccount(providerId, undefined, []);
      lease?.release();
      return lease?.account.configDir;
    };
    await runSubscriptionAccountCommand({ action: 'place', providerId: kind, accountId: 'third', target: null });
    const [created] = Object.keys(h.created);
    expect(created).toMatch(new RegExp(`^${kind}-sub-`));
    const copiedOverrides = kind === 'openai'
      ? [kind, created, { source: 'openai/gpt-image-2', target: `${created}/gpt-image-2` }]
      : [kind, created];
    expect(h.copyOverrides).toHaveBeenCalledWith(...copiedOverrides);
    expect(await ids(kind)).toEqual(['default', 'second']);
    expect(await pick(created!)).toBe(`${kind}/third`);
    // Review regression: a task switched to another provider used to keep its old account. A fresh
    // session picks within the new provider; a resume never runs the old history in another account.
    const first = await acquireSubscriptionAccount(kind, undefined, ['task:switch']);
    await first!.bind(['task:switch']);
    first!.release();
    await expect(acquireSubscriptionAccount(created!, undefined, ['task:switch'])).rejects.toThrow('changed');
    // Before that resume happens, the pre-send check hands the switched task over with its context.
    const row = (providerId: string) => ({ providerId, agentKind: kind === 'anthropic' ? 'cc' : 'codex', sdkSessionId: 'switch-history' });
    expect(await needsSubscriptionAccountHandoff('switch', row(kind))).toBe(false);
    expect(await needsSubscriptionAccountHandoff('switch', row(created!))).toBe(true);
    // Isolated-sandbox regression: the picker showed the task's account and quota under every
    // provider of the kind, although another provider would hand the task over to its own account.
    expect((await readSubscriptionPool(kind, false, 'switch')).boundAccountId).toBe('default');
    expect((await readSubscriptionPool(created!, false, 'switch')).boundAccountId).toBeNull();
    const fresh = await acquireSubscriptionAccount(created!, undefined, ['task:switch'], false, { resuming: false });
    expect(fresh!.account.configDir).toBe(`${kind}/third`);
    fresh!.release();
    // Moving into the created provider leaves only the CLI default with the built-in one.
    await runSubscriptionAccountCommand({ action: 'place', providerId: kind, accountId: 'second', target: created! });
    expect(await ids(kind)).toEqual(['default']);
    expect(await ids(created!)).toEqual(['second', 'third']);
    h.pools[kind]!.accounts[1]!.paused = true;
    expect(await pick(created!)).toBe(`${kind}/third`);
    expect(await pick(kind)).toBe(`${kind}/default`);
    // Merging moves every account back; the emptied provider keeps pinning its own for old tasks.
    await runSubscriptionAccountCommand({ action: 'merge', providerId: created!, target: kind });
    expect(await ids(kind)).toEqual(['default', 'second', 'third']);
    expect(await ids(created!)).toEqual([]);
    // Sandbox regression: the merged provider read as disconnected, so its old tasks could not send.
    expect(hasConnectedSubscriptionPool(created!)).toBe(true);
    // Deleting a created provider stops using only its own accounts.
    await runSubscriptionAccountCommand({ action: 'place', providerId: kind, accountId: 'third', target: null });
    expect(h.copyOverrides).toHaveBeenLastCalledWith(...copiedOverrides);
    await runSubscriptionAccountCommand({ action: 'remove-provider', providerId: created! });
    expect(h.pools[kind]!.accounts.map(a => a.id)).toEqual(['default', 'second']);
    expect(h.created).toEqual({});
    await expect(runSubscriptionAccountCommand({ action: 'remove-provider', providerId: kind })).rejects.toThrow();
    // Review regression: the built-in provider is never merged away as a whole, even from a pool
    // migrated without a CLI default account.
    h.pools[kind]!.accounts = [{ ...account('second'), limit: 4 }, { ...account('fourth'), limit: 4 }];
    await runSubscriptionAccountCommand({ action: 'place', providerId: kind, accountId: 'fourth', target: null });
    const [other] = Object.keys(h.created);
    await expect(runSubscriptionAccountCommand({ action: 'merge', providerId: kind, target: other! }))
      .rejects.toThrow('built-in');
    expect(await ids(kind)).toEqual(['second']);
  });
  // PR #10405, unit: merging an entire multi-account provider previously pinned every old task
  // to its first account. Start and fork must keep the native history's recorded second account.
  it.each([
    { kind: 'anthropic' as const, providerId: 'anthropic-sub-12345678' },
    { kind: 'openai' as const, providerId: 'openai-sub-12345678' },
    { kind: 'openai' as const, providerId: 'openai-old' },
  ])('keeps second-account history after merging $providerId', async ({ kind, providerId }) => {
    h.pools[kind] = { strategy: 'order', accounts: ['default', 'second', 'third'].map(account) };
    if (providerId.endsWith('-old')) h.pools[kind]!.legacyCodexAccounts = { [providerId]: 'second' };
    else h.created[providerId] = { kind, name: 'Multiple', account: 'second' };
    h.placement = { [`${kind}:second`]: providerId, [`${kind}:third`]: providerId };
    const lease = await acquireSubscriptionAccount(providerId, undefined, [], false, { accountId: 'third' });
    await lease!.bind(['task:merged-second', 'native:merged-second']);
    lease!.release();
    await runSubscriptionAccountCommand({ action: 'merge', providerId, target: kind });
    const start = vi.fn<(options: StartSessionOptions) => Promise<AgentSessionHandle>>(async () =>
      ({ id: 'resumed-second', close: async () => {} }) as unknown as AgentSessionHandle);
    const fork = vi.fn<(options: ForkSdkSessionOptions) => Promise<{ newSdkSessionId: string }>>(async () => ({ newSdkSessionId: 'forked-second' }));
    const agent = withSubscriptionAccounts({ kind: kind === 'openai' ? 'codex' : 'claude-code', startSession: start, forkSdkSession: fork } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId, sessionId: 'merged-second', resumeSessionId: 'merged-second' } as StartSessionOptions);
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe(`${kind}/third`);
    await handle.close();
    await agent.forkSdkSession({ providerId, sourceSdkSessionId: 'merged-second' } as ForkSdkSessionOptions);
    expect(fork.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe(`${kind}/third`);
    expect(h.bindings.get('native:forked-second')?.accountId).toBe('third');
    const query = { nativeSessionId: 'merged-second', model: kind === 'openai' ? 'gpt-6' : 'claude-sonnet',
      ...(providerId.endsWith('-old') ? { legacyProviderId: providerId } : { routeProviderId: providerId }) };
    expect(await readSubscriptionSessionAccount(kind, query, { remote: true, ownComputer: true }))
      .toMatchObject({ state: 'bound', account: { number: 3 } });
  });
  // 2026-11-14 regression (subscription-account-pools.md 旧版直接加入账号池的账号也拆开 / 任务跟着账号走),
  // unit: splitting the old pool left the built-in source with only a signed-out default login, and
  // the composer refused its old tasks as disconnected although the executor resumes them on their
  // account. Minimal input: a built-in task bound to `second`, `second` split out, default signed out.
  it.each(['anthropic', 'openai'] as const)('keeps a built-in %s task on its account after that account is split out', async kind => {
    h.pools[kind] = { strategy: 'order', accounts: ['default', 'second'].map(account) };
    h.read.mockImplementation(async (_kind: string, directory: string) =>
      ({ authenticated: !directory.endsWith('default'), identity: directory }));
    const model = kind === 'openai' ? 'gpt-6' : 'claude-sonnet';
    const lease = await acquireSubscriptionAccount(kind, model, [], false, { accountId: 'second' });
    await lease!.bind(['task:old-task', 'native:old-native']);
    lease!.release();
    const providerId = `${kind}-sub-12345678`;
    h.created[providerId] = { kind, name: 'Split', account: 'second' };
    h.placement[`${kind}:second`] = providerId;
    await refreshSubscriptionPool(kind, true);
    // New tasks still see the emptied source as disconnected; only routing keeps the bound account.
    expect(hasConnectedSubscriptionPool(kind)).toBe(false);
    expect(hasConnectedSubscriptionPool(kind, { includeBoundAccounts: true })).toBe(true);
    // The local composer learns where the account lives now; remote replies keep their old shape.
    expect(await readSubscriptionSessionAccount(kind, { sessionId: 'old-task', nativeSessionId: 'old-native', model }))
      .toMatchObject({ state: 'bound', account: { status: 'ready', paused: false, ownerProviderId: providerId } });
    expect(await readSubscriptionSessionAccount(kind, { sessionId: 'old-task', model }, { remote: true, ownComputer: true }))
      .not.toHaveProperty('account.ownerProviderId');
    // The resume continues the native history on the same account: no handoff, no rebinding.
    const start = vi.fn<(options: StartSessionOptions) => Promise<AgentSessionHandle>>(async () =>
      ({ id: 'old-native', close: async () => {} }) as unknown as AgentSessionHandle);
    const agent = withSubscriptionAccounts({ kind: kind === 'openai' ? 'codex' : 'claude-code', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: kind, sessionId: 'old-task', resumeSessionId: 'old-native', model } as StartSessionOptions);
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe(`${kind}/second`);
    expect(h.bindings.get('task:old-task')?.accountId).toBe('second');
    expect(h.bindings.get('native:old-native')?.accountId).toBe('second');
    await handle.close();
    // An account that stays in the built-in source is not reported as living elsewhere.
    delete h.placement[`${kind}:second`];
    expect(await readSubscriptionSessionAccount(kind, { sessionId: 'old-task', model }))
      .not.toHaveProperty('account.ownerProviderId');
  });
  // PR #10405 review, unit: built-in-only probes missed a created multi-account provider.
  // Two accounts in that provider plus an unrelated default prove selection stays scoped;
  // the old native history must stay bound while the task starts on its replacement.
  it.each(['anthropic', 'openai'] as const)('hands off within a created %s provider after failure or pause', async kind => {
    const providerId = `${kind}-sub-12345678`;
    h.created[providerId] = { kind, name: 'Separate', account: 'second' };
    h.placement = { [`${kind}:second`]: providerId, [`${kind}:third`]: providerId };
    h.pools[kind] = { strategy: 'order', accounts: ['default', 'second', 'third'].map(id => ({ ...account(id), limit: 4 })) };
    const model = kind === 'openai' ? 'gpt-6' : 'claude-sonnet';
    const old = await acquireSubscriptionAccount(providerId, model, []);
    await old!.bind(['task:created', 'native:created-old']);
    expect(old!.observeFailure(new Error('[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] The task subscription account requires login'), model, 'run')).toBe(true);
    old!.release();
    const row = { status: 'active', providerId, agentKind: kind === 'openai' ? 'codex' : 'cc', model, sdkSessionId: 'created-old',
      title: null, userSendAt: null, workingDir: null, workspaceKind: null };
    const rebuild = vi.fn(async (_id: string, assertCurrent: () => void) => { assertCurrent(); });
    const deps = { readSession: async () => row, isRunning: () => false, rebuild };
    expect(await canSwitchSubscriptionAccount('created', deps.readSession)).toBe(true);
    expect(await prepareSubscriptionAccountFailover('created', deps)).toBe(true);
    expect(h.bindings.get('task:created')?.accountId).toBe('third');
    expect(h.bindings.get('native:created-old')?.accountId).toBe('second');
    h.pools[kind]!.accounts.find(a => a.id === 'third')!.paused = true;
    h.owner += '-renewed';
    expect(await prepareSubscriptionAccountForSend('created', deps)).toBe(true);
    expect(h.bindings.get('task:created')?.accountId).toBe('second');
    expect(rebuild).toHaveBeenCalledTimes(2);
  });
  // PR #10405, unit: run the real account wrapper, then observe the engine-facing grant. The
  // engine already tests strict grant matching; the wrapper must preserve it during aliasing.
  it.each(['anthropic', 'openai'] as const)('keeps shared %s starts within their original provider grant', async kind => {
    const providerId = `${kind}-sub-12345678`;
    h.created[providerId] = { kind, name: 'Separate', account: 'second' };
    h.placement = { [`${kind}:second`]: providerId };
    h.pools[kind] = { strategy: 'order', accounts: [account('default'), account('second')] };
    const start = vi.fn<(options: StartSessionOptions) => Promise<AgentSessionHandle>>(async () => ({ id: 'guest-native', close: async () => {} }) as unknown as AgentSessionHandle);
    const agent = withSubscriptionAccounts({ kind: kind === 'openai' ? 'codex' : 'claude-code', startSession: start } as unknown as BaseAgent);
    const guestProvider = { providerId, routeToken: 'fixture-route', modelIds: ['shared-model'] };
    const options = { providerId, model: 'shared-model', deviceHosted: { guest: true, guestProvider } } as unknown as StartSessionOptions;
    const handle = await agent.startSession(options);
    const invoked = start.mock.calls[0]![0];
    expect(invoked.deviceHosted?.guestProvider).toEqual({ ...guestProvider, providerId: invoked.providerId });
    expect(invoked[NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe(`${kind}/second`);
    expect(options.deviceHosted?.guestProvider).toBe(guestProvider);
    expect(guestProvider.providerId).toBe(providerId);
    await handle.close();
    start.mockClear();
    await expect(agent.startSession({ ...options, deviceHosted: { ...options.deviceHosted!,
      guestProvider: { ...guestProvider, providerId: 'unrelated' } } })).rejects.toThrow('REMOTE_AGENT_PROVIDER_NOT_ALLOWED');
    expect(start).not.toHaveBeenCalled();
  });
  // PR #10405, unit: drive the actual executor query and controller handoff together. A healthy
  // default outside the selected provider proves that replacement never borrows another pool.
  it.each([
    { kind: 'anthropic' as const, providerId: 'anthropic-sub-12345678' },
    { kind: 'openai' as const, providerId: 'openai-sub-12345678' },
    { kind: 'openai' as const, providerId: 'openai-old' },
  ])('hands off remote tasks within $providerId and requires a route-aware executor', async ({ kind, providerId }) => {
    h.pools[kind] = { strategy: 'order', accounts: ['default', 'second', 'third'].map(id => ({ ...account(id), limit: 4 })) };
    if (providerId.endsWith('-old')) h.pools[kind]!.legacyCodexAccounts = { [providerId]: 'second' };
    else h.created[providerId] = { kind, name: 'Separate', account: 'second' };
    h.placement = { [`${kind}:second`]: providerId, [`${kind}:third`]: providerId };
    const model = kind === 'openai' ? 'gpt-6' : 'claude-sonnet';
    const failed = await acquireSubscriptionAccount(providerId, model, []);
    await failed!.bind(['task:remote-created', 'native:remote-created-old']);
    failed!.observeFailure(new Error('[SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED] login expired'), model, 'run');
    failed!.release();
    const row = { status: 'active', providerId, agentKind: kind === 'openai' ? 'codex' : 'cc', model,
      sdkSessionId: 'remote-created-old' as string | null, agentDeviceId: 'other-computer' };
    const remote: NonNullable<Parameters<typeof probeSubscriptionAccountHandoff>[2]> = async (_device, _channel, args) => ({ ok: true,
      result: await readSubscriptionSessionAccount(kind, args[0] as Parameters<typeof readSubscriptionSessionAccount>[1],
        { remote: true, ownComputer: true }) });
    expect(await canSwitchSubscriptionAccount('remote-created', async () => row, remote)).toBe(true);
    const rebuild = vi.fn(async (_id: string, assertCurrent: () => void) => { assertCurrent(); row.sdkSessionId = null; });
    const moveRoute = vi.fn();
    expect(await prepareSubscriptionAccountFailover('remote-created', { readSession: async () => row,
      isRunning: () => false, rebuild, moveRoute, invokeRemote: remote })).toBe(true);
    expect(rebuild).toHaveBeenCalledOnce();
    expect(moveRoute).not.toHaveBeenCalled();
    const resumed = await acquireSubscriptionAccount(providerId, model, ['task:remote-created'], false, { resuming: false });
    expect(resumed?.accountId).toBe('third');
    resumed?.release();
    if (!providerId.endsWith('-old')) {
      row.sdkSessionId = 'remote-created-old';
      expect(await probeSubscriptionAccountHandoff('remote-created', row, async () => ({ ok: true, result: {
        providerId: kind, state: 'bound', account: { isDefault: false, number: 1, paused: false, status: 'limited',
          blocked: true, switchAvailable: true },
      } }))).toBe(false);
    }
  });
  // PR #10405, unit: a remote source change must use the executor's actual target admission,
  // including an older host that ignores the new route field. Local-only switch coverage missed it.
  it.each([
    { kind: 'anthropic' as const, providerId: 'anthropic-sub-12345678' },
    { kind: 'openai' as const, providerId: 'openai-sub-12345678' },
    { kind: 'openai' as const, providerId: 'openai-old' },
  ])('hands off remote history when the user selects $providerId', async ({ kind, providerId }) => {
    h.pools[kind] = { strategy: 'order', accounts: [account('default'), account('second')] };
    if (providerId.endsWith('-old')) h.pools[kind]!.legacyCodexAccounts = { [providerId]: 'second' };
    else h.created[providerId] = { kind, name: 'Separate', account: 'second' };
    h.placement[`${kind}:second`] = providerId;
    const model = kind === 'openai' ? 'gpt-6' : 'claude-sonnet';
    const original = await acquireSubscriptionAccount(kind, model, []);
    await original!.bind(['native:before-switch']);
    original!.release();
    const row = { providerId, agentKind: kind === 'openai' ? 'codex' : 'cc', model,
      sdkSessionId: 'before-switch', agentDeviceId: 'executor' };
    const remote: NonNullable<Parameters<typeof probeSubscriptionAccountHandoff>[2]> = async (_device, _channel, args) => ({ ok: true,
      result: await readSubscriptionSessionAccount(kind, args[0] as Parameters<typeof readSubscriptionSessionAccount>[1],
        { remote: true, ownComputer: true }) });
    expect(await probeSubscriptionAccountHandoff('switch', row, remote)).toBe(true);
    expect(await probeSubscriptionAccountHandoff('switch', { ...row, agentDeviceId: null })).toBe(true);
    h.routeAllowed.mockReturnValue(false);
    expect(await probeSubscriptionAccountHandoff('switch', row, remote)).toBe(false);
    expect(h.bindings.get('native:before-switch')?.accountId).toBe('default');
  });
  it('reports and replaces the second remote account of a legacy provider that owns multiple accounts', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('imported'), account('second')],
      legacyCodexAccounts: { 'openai-old': 'imported' } };
    h.placement = { 'openai:imported': 'openai-old', 'openai:second': 'openai-old' };
    h.bindings.set('native:second-legacy', { providerId: 'openai', accountId: 'second', via: 'openai-old' });
    const query = { nativeSessionId: 'second-legacy', legacyProviderId: 'openai-old', model: 'gpt-6' };
    const options = { remote: true, ownComputer: true };
    expect(await readSubscriptionSessionAccount('openai', query, options)).toMatchObject({ state: 'bound', account: { number: 2 } });
    h.pools.openai.accounts[1].paused = true;
    expect(await readSubscriptionSessionAccount('openai', query, options)).toMatchObject({
      state: 'bound', account: { number: 2, paused: true, switchAvailable: true },
    });
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai-old', accountId: 'imported', paused: true });
    expect(h.setLegacyPaused).not.toHaveBeenCalled();
  });
  it('rolls back cancelled additions and preserves placement when model settings cannot be copied', async () => {
    const providerId = 'anthropic-sub-12345678';
    h.created[providerId] = { kind: 'anthropic', name: 'Separate', account: 'second' };
    h.placement = { 'anthropic:second': providerId };
    h.login.mockRejectedValue(new Error('login_cancelled'));
    await expect(runSubscriptionAccountCommand({ action: 'add', providerId, loginKey: 'cancel' })).rejects.toThrow('login_cancelled');
    expect(h.pools.anthropic!.accounts.map(a => a.id)).toEqual(['default', 'second']);
    expect(h.placement).toEqual({ 'anthropic:second': providerId });
    h.pools.anthropic!.accounts.push(account('third'));
    h.copyOverrides.mockImplementation(() => { throw new Error('model settings unavailable'); });
    await expect(runSubscriptionAccountCommand({ action: 'place', providerId: 'anthropic', accountId: 'third', target: null }))
      .rejects.toThrow('model settings unavailable');
    expect(Object.keys(h.created)).toEqual([providerId]);
    expect(h.placement).toEqual({ 'anthropic:second': providerId });
  });
  // Report verification (unit): the scheduler's pure-input tests did not cover
  // settings commands reaching dispatch. Equal/unknown quota lets order, the
  // saved concurrency limit and a changed weight each produce a different pick.
  it.each(['anthropic', 'openai'] as const)('applies saved order, concurrency and weight settings for %s', async providerId => {
    h.pools[providerId] = {
      strategy: 'least',
      accounts: [{ ...account('default'), limit: 4 }, { ...account('second'), limit: 4 }],
    };
    const leases: Array<NonNullable<Awaited<ReturnType<typeof acquireSubscriptionAccount>>>> = [];
    const acquire = async () => {
      const lease = (await acquireSubscriptionAccount(providerId, undefined, []))!;
      leases.push(lease);
      return lease;
    };
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.25);
    try {
      const busy = await acquire();
      await runSubscriptionAccountCommand({ action: 'configure', providerId, strategy: 'order' });
      const ordered = await acquire();
      expect(ordered.account.configDir).toBe(`${providerId}/default`);
      ordered.release();
      await runSubscriptionAccountCommand({ action: 'configure', providerId, accountId: 'default', limit: 1 });
      const limited = await acquire();
      expect(limited.account.configDir).toBe(`${providerId}/second`);
      limited.release();
      busy.release();
      await runSubscriptionAccountCommand({ action: 'configure', providerId, strategy: 'weight' });
      const equal = await acquire();
      expect(equal.account.configDir).toBe(`${providerId}/default`);
      equal.release();
      await runSubscriptionAccountCommand({ action: 'configure', providerId, accountId: 'second', weight: 100 });
      expect((await acquire()).account.configDir).toBe(`${providerId}/second`);
    } finally {
      random.mockRestore();
      for (const lease of leases) lease.release();
    }
  });
  it('refuses paused or removed native resumes instead of sending with disabled credentials', async () => {
    const original = await acquireSubscriptionAccount('anthropic', undefined, []);
    await original!.bind(['native:thread-a']);
    original!.release();
    h.pools.anthropic!.accounts[0].paused = true;
    await expect(acquireSubscriptionAccount('anthropic', undefined, ['native:thread-a'])).rejects.toThrow();
    // History inspection/fork control may still read the original home.
    const control = await acquireSubscriptionAccount('anthropic', undefined, ['native:thread-a'], true);
    expect(control!.account.id).toBe(original!.account.id);
    control!.release();
    h.pools.anthropic!.accounts.shift();
    await expect(
      acquireSubscriptionAccount('anthropic', undefined, ['native:thread-a']),
    ).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_UNAVAILABLE]');
  });
  it('skips exhausted accounts with the same model-specific quota policy as provider groups', async () => {
    h.usage.mockImplementation(async (_provider: string, dir: string) =>
      dir.endsWith('default')
        ? {
            claudeUsage: {
              updatedAt: Date.now(),
              fiveHour: { utilization: 100, resetsAt: Date.now() / 1000 + 3600 },
              sevenDay: null,
              scoped: [],
            },
          }
        : {},
    );
    const selected = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', []);
    expect(selected!.account.configDir).toBe('anthropic/second');
    selected!.release();
  });
  it('does not silently fall back when the provider is disconnected', async () => {
    await disconnectSubscriptionPool('anthropic');
    await expect(acquireSubscriptionAccount('anthropic', undefined, [])).rejects.toThrow(
      'disconnected',
    );
  });
  it('fences late CLI results and leases at an owner boundary', async () => {
    let finish!: (value: unknown) => void;
    h.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    h.pools.anthropic!.accounts = [account('default')];
    const pending = acquireSubscriptionAccount('anthropic', undefined, []);
    h.owner = 'owner-b:1';
    finish({ authenticated: true });
    await expect(pending).rejects.toThrow('owner changed');
    expect(h.bindings.size).toBe(0);
  });
  it('reports usable pool quota to an outer group even when the default account is exhausted', async () => {
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({
      claudeUsage: {
        updatedAt: Date.now(),
        fiveHour: {
          utilization: dir.endsWith('default') ? 100 : 12,
          resetsAt: Date.now() / 1000 + 3600,
        },
        sevenDay: null,
        scoped: [],
      },
    }));
    expect((await readSubscriptionPoolUsage('anthropic'))?.claudeUsage?.fiveHour?.utilization).toBe(
      12,
    );
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      0, 0,
    ]);
  });
  // PR #9998 review, unit: a healthy but full account still has quota. The
  // prior read-only tests never held a reservation and missed the false reset.
  it('reports remaining quota when the only healthy Claude account is full', async () => {
    h.usage.mockImplementation(async (...[, dir]: [string, string]) => ({ claudeUsage: {
      updatedAt: Date.now(), fiveHour: { utilization: dir.endsWith('default') ? 100 : 12,
        resetsAt: Date.now() / 1000 + 3600 }, sevenDay: null, scoped: [],
    } }));
    const busy = await acquireSubscriptionAccount('anthropic', undefined, ['task:busy']);
    try {
      expect(busy?.accountId).toBe('second');
      await expect(acquireSubscriptionAccount('anthropic', undefined, ['task:new'])).rejects.toThrow('SUBSCRIPTION_ACCOUNTS_FULL');
      expect((await readSubscriptionPoolUsage('anthropic'))?.claudeUsage?.fiveHour?.utilization).toBe(12);
    } finally { busy?.release(); }
  });
  // #9833, unit: the actual account pool and group router must agree after an
  // old task cools the member. Existing tests exercised these layers separately.
  it.each(['persisted', 'terminal', 'startup'] as const)('assigns a new same-model task to the healthy account after a %s cooldown', async (failure) => {
    const now = Date.now();
    const model = 'claude-sonnet-5-5';
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({ claudeUsage: {
      updatedAt: now,
      fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
      sevenDay: { utilization: dir.endsWith('default') ? 100 : 20, resetsAt: now / 1000 + 86400 },
      scoped: [],
    } }));
    h.bindings.set('native:old', { providerId: 'anthropic', accountId: 'default' });
    const config = normalizeProviderGroupConfig({ members: [{ kind: 'local' }] }, 'anthropic')!;
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [{ id: 'anthropic', name: 'Anthropic', connected: true,
        agents: ['claude-code'], auth: { method: 'oauth', native: 'claude' },
        models: { 'claude-code': [{ id: model, name: model, efforts: [], defaultEffort: null }] },
        routing: { 'claude-code': {} },
      } as unknown as ProviderView],
      localDeviceName: () => 'local', listDevices: async () => [], readDeviceProviders: async () => [],
      listReceivedShares: () => [], isMobilePlatform: () => false,
      readClaudeUsage: async () => (await readSubscriptionPoolUsage('anthropic'))?.claudeUsage ?? null,
      now: () => now,
    });
    const bindings = new Map<string, ProviderGroupBinding>();
    const router = createProviderGroupRouter({ directory, readGroup: () => config,
      listBindings: () => Object.fromEntries(bindings), isTurnRunning: () => false, now: () => now, random: () => 0,
      readPoolModelAvailability: async () => readSubscriptionPoolModelAvailability('anthropic', model),
      coolingStore: { read: (): ProviderGroupPersistedCooling => failure === 'persisted'
        ? { anthropic: { local: { 'claude:sonnet': now + 1_800_000 } } } : {}, write: vi.fn() },
    });
    const row: ProviderGroupSessionRow = { agentKind: 'claude-code', model, providerId: 'anthropic',
      agentDeviceId: null, remoteHostId: null, sdkSessionId: null };
    const switchAgentLocation = vi.fn();
    const service = createProviderGroupService({ router, directory, readGroup: () => config,
      readBinding: (id) => bindings.get(id) ?? null,
      writeBinding: async (id, binding) => {
        if (binding) bindings.set(id, { providerId: binding.providerId, memberKey: binding.memberKey, at: now });
        else bindings.delete(id);
      },
      isReleased: () => false, markReleased: vi.fn(), readSessionRow: async (id) => ({ ...row, sdkSessionId: id === 'old' ? 'native:old' : null }),
      resolveImplicitProvider: async () => 'anthropic', persistRoute: vi.fn(), hasAssistantHistory: async () => false,
      isFailoverEligible: async () => true, leaseRecovery: () => ({}), isLeaseCurrent: () => true,
      rearmContinue: () => 2, cancelContinue: vi.fn(), switchAgentLocation, isTurnRunning: () => false, hasLiveSession: () => false,
      continueSession: async () => 'resumed', fallback: vi.fn(), readResetAt: () => null,
      now: () => now, sleep: async () => {}, log: { info: vi.fn(), warn: vi.fn() },
    });
    if (failure !== 'persisted') {
      bindings.set('old', { providerId: 'anthropic', memberKey: 'local', at: now });
      if (failure === 'terminal') await service.onTurnError('old', { sdkError: 'rate_limit' }, 1);
      else {
        const context = await service.assignBeforeStart({ sessionId: 'old', agentKind: 'claude-code', model });
        expect(context).not.toBeNull();
        await service.nextAfterStartFailure(context!, new Error("You've hit your usage limit"));
      }
      expect(router.coolingUntil('anthropic', 'local', model)).toBe(now + 1_800_000);
    }
    expect(await service.assignBeforeStart({ sessionId: 'new', agentKind: 'claude-code', model }))
      .toMatchObject({ member: { key: 'local' } });
    const next = await acquireSubscriptionAccount('anthropic', model, ['task:new']);
    expect(next?.account.configDir).toBe('anthropic/second');
    next?.release();
    await expect(acquireSubscriptionAccount('anthropic', model, ['native:old'])).rejects.toThrow('[SUBSCRIPTION_ACCOUNT_LIMITED]');
    expect(h.bindings.get('native:old')?.accountId).toBe('default');
    expect(switchAgentLocation).not.toHaveBeenCalled();
  });
  // 2026-11-12 incident (unit): the group cooled the failing computer and gave up ("no computer left")
  // although that computer still had a healthy account. Real service → router → account pool with
  // one computer and two accounts; the executing account remembers its limit as agent.ts records it.
  it('continues a failed group task on another account of the same computer before giving up', async () => {
    const now = Date.now();
    const model = 'claude-sonnet-5-5';
    h.pools.anthropic!.accounts = [{ ...account('default'), limit: 4 }, { ...account('second'), limit: 4 }];
    h.usage.mockResolvedValue({ claudeUsage: { updatedAt: now, fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
      sevenDay: { utilization: 20, resetsAt: now / 1000 + 86400 }, scoped: [] } });
    const failed = await acquireSubscriptionAccount('anthropic', model, []);
    await failed!.bind(['task:old', 'native:old']);
    failed!.observeFailure({ sdkError: 'rate_limit' }, model, 'run');
    failed!.release();
    const config = normalizeProviderGroupConfig({ members: [{ kind: 'local' }] }, 'anthropic')!;
    const directory = createProviderGroupDirectory({
      listLocalProviders: async () => [{ id: 'anthropic', name: 'Anthropic', connected: true,
        agents: ['claude-code'], auth: { method: 'oauth', native: 'claude' },
        models: { 'claude-code': [{ id: model, name: model, efforts: [], defaultEffort: null }] },
        routing: { 'claude-code': {} },
      } as unknown as ProviderView],
      localDeviceName: () => 'local', listDevices: async () => [], readDeviceProviders: async () => [],
      listReceivedShares: () => [], isMobilePlatform: () => false,
      readClaudeUsage: async () => (await readSubscriptionPoolUsage('anthropic'))?.claudeUsage ?? null,
      now: () => now,
    });
    const bindings = new Map<string, ProviderGroupBinding>([['old', { providerId: 'anthropic', memberKey: 'local', at: now }]]);
    const router = createProviderGroupRouter({ directory, readGroup: () => config,
      listBindings: () => Object.fromEntries(bindings), isTurnRunning: () => false, now: () => now, random: () => 0,
      readPoolModelAvailability: async () => readSubscriptionPoolModelAvailability('anthropic', model),
      coolingStore: { read: (): ProviderGroupPersistedCooling => ({}), write: vi.fn() },
    });
    const taskRow = { status: 'active', providerId: 'anthropic', agentKind: 'cc', model, sdkSessionId: 'old',
      agentDeviceId: null, remoteHostId: null };
    const continueSession = vi.fn(async () => 'resumed' as const);
    const accountProbe = vi.fn((id: string) => readSubscriptionAccountSwitch(id, async () => taskRow));
    const arm = vi.fn(() => true);
    const waiting = new UsageLimitAutoResume({
      now: () => now, random: () => 0, setTimer: vi.fn(), clearTimer: vi.fn(),
      isEligible: async () => true, resolveResetAt: async () => now + 60_000,
      canSwitchAccount: async id => (await accountProbe(id)) !== null,
      arm, isCurrent: () => true, cancel: vi.fn(), continueSession, log: vi.fn(),
    });
    let fallbackRun: Promise<boolean> | undefined;
    const fallback = vi.fn((id: string, signals: Parameters<UsageLimitAutoResume['onTurnError']>[1], token: number,
      options?: { accountSwitchChecked?: true }) => { fallbackRun = waiting.onTurnError(id, signals, token, options); });
    const switchAgentLocation = vi.fn();
    const service = createProviderGroupService({ router, directory, readGroup: () => config,
      readBinding: (id) => bindings.get(id) ?? null,
      writeBinding: async (id, binding) => {
        if (binding) bindings.set(id, { providerId: binding.providerId, memberKey: binding.memberKey, at: now });
        else bindings.delete(id);
      },
      isReleased: () => false, markReleased: vi.fn(),
      readSessionRow: async () => ({ agentKind: 'claude-code', model, providerId: 'anthropic',
        agentDeviceId: null, remoteHostId: null, sdkSessionId: 'old' }),
      resolveImplicitProvider: async () => 'anthropic', persistRoute: vi.fn(), hasAssistantHistory: async () => true,
      isFailoverEligible: async () => true, leaseRecovery: () => ({}), isLeaseCurrent: () => true,
      rearmContinue: () => 2, cancelContinue: vi.fn(), switchAgentLocation, isTurnRunning: () => false, hasLiveSession: () => false,
      readAccountSwitch: accountProbe,
      continueSession, fallback, readResetAt: () => null,
      now: () => now, sleep: async () => {}, log: { info: vi.fn(), warn: vi.fn() },
    });
    await service.onTurnError('old', { sdkError: 'rate_limit' }, 1);
    expect(continueSession).toHaveBeenCalledTimes(1);
    expect((continueSession.mock.calls[0] as unknown[])[2]).not.toHaveProperty('agentSwitch');
    expect(switchAgentLocation).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    // The computer still serves the model through its other account: no group cooldown.
    expect(router.coolingUntil('anthropic', 'local', model)).toBeNull();
    // The continuation's ordinary pre-send check hands the task to that account.
    const rebuild = vi.fn(async () => undefined);
    expect(await prepareSubscriptionAccountFailover('old', { readSession: async () => taskRow, isRunning: () => false, rebuild })).toBe(true);
    expect(h.bindings.get('task:old')).toMatchObject({ accountId: 'second' });
    // The same account failing again in this round means the move did not take: switch computers as before.
    h.bindings.set('task:old', { providerId: 'anthropic', accountId: 'default' });
    await service.onTurnError('old', { sdkError: 'rate_limit' }, 2);
    await fallbackRun;
    expect(continueSession).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(accountProbe).toHaveBeenCalledTimes(2);
    expect(arm).toHaveBeenCalledWith('old', 2, now + 60_000 + USAGE_LIMIT_RESUME_BUFFER_MS);
  });
  // PR #9837 / unit: an actual CLI failure without account_usage must outrank
  // optimistic cached quota. The previous group regression pre-exhausted it.
  it.each([
    ['startup', 'exhausted'], ['terminal', 'unknown'], ['send', 'healthy'],
  ] as const)('does not reuse the failed account after %s with a %s backup', async (failure, backup) => {
    const model = 'claude-sonnet-5-5';
    const now = Date.now();
    h.pools.anthropic!.strategy = 'order';
    h.usage.mockImplementation(async (_provider: string, dir: string) =>
      dir.endsWith('second') && backup === 'unknown' ? {} : { claudeUsage: {
        updatedAt: now, fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
        sevenDay: { utilization: dir.endsWith('second') ? backup === 'exhausted' ? 100 : 40 : 20,
          resetsAt: now / 1000 + 86400 },
      } });
    const error = new AgentStartupStoppedError(new Error("You've hit your usage limit"));
    const start = vi.fn(async () => {
      if (failure === 'startup') throw error;
      return { id: 'failed-native', close: async () => {},
        send: async () => { if (failure === 'send') throw error; },
        events: async function* () { yield { type: 'error', data: { sdkError: 'rate_limit' } }; },
      } as unknown as AgentSessionHandle;
    });
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: start } as unknown as BaseAgent);
    const options: StartSessionOptions = { providerId: 'anthropic', model, sessionId: 'failed-task', workingDir: '/work',
      ...(failure === 'terminal' ? { deviceHosted: { workingDir: '/controller/work', extraDirs: [], writableDirs: [],
        platform: 'win32' as const, shell: 'powershell', isGitRepo: false, tunnelUrl: 'http://127.0.0.1:1',
        tunnelToken: 'unused-test-token', mcpServers: [] } } : {}) };
    if (failure === 'startup') await expect(agent.startSession(options)).rejects.toThrow('usage limit');
    else {
      const handle = await agent.startSession(options);
      if (failure === 'send') await expect(handle.send({ type: 'user', content: 'hello' })).rejects.toThrow('usage limit');
      else for await (const _event of handle.events()) { /* Consume the actual wrapper. */ }
      await handle.close();
      expect(h.bindings.get('native:failed-native')?.accountId).toBe('default');
      const pinned = await acquireSubscriptionAccount('anthropic', model, ['native:failed-native']);
      expect(pinned?.account.configDir).toBe('anthropic/default'); // manual retry stays pinned
      pinned?.release();
    }
    expect(await readSubscriptionPoolModelAvailability('anthropic', model)).toBe(backup === 'healthy');
    if (backup === 'healthy') {
      const next = await acquireSubscriptionAccount('anthropic', model, ['task:new']);
      expect(next?.account.configDir).toBe('anthropic/second');
      next?.release();
    } else if (backup === 'exhausted') {
      await expect(acquireSubscriptionAccount('anthropic', model, ['task:new'])).rejects.toThrow('[SUBSCRIPTION_POOL_MODEL_LIMITED]');
    }
    expect(await readSubscriptionPoolModelAvailability('anthropic', 'claude-opus-5-5')).toBe(true);
  });

  // Unit: the account failure must follow model switches and expire at the real
  // reset (or the existing fallback), without treating retryable/overload as quota.
  it.each([60_000, null])('expires account failure evidence after %s ms and ignores stale-owner events', async (resetDelay) => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const sonnet = 'claude-sonnet-5-5';
      const opus = 'claude-opus-5-5';
      h.pools.anthropic!.accounts[1].paused = true;
      h.usage.mockImplementation(async () => ({ claudeUsage: { updatedAt: Date.now(),
        fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
        sevenDay: { utilization: 20, resetsAt: now / 1000 + 86400 },
      } }));
      let data: Record<string, unknown> = { sdkError: 'rate_limit', willRetry: true };
      const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async () => ({
        id: 'switching', close: async () => {}, setModel: async () => {},
        events: async function* () { yield { type: 'error', data }; },
      }) } as unknown as BaseAgent);
      const handle = await agent.startSession({ providerId: 'anthropic', model: sonnet } as StartSessionOptions);
      await handle.setModel!(opus);
      const consume = async () => { for await (const _event of handle.events()) { /* real dispatch */ } };
      await consume();
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(true);
      data = { sdkError: 'rate_limit', errorStatus: 529 };
      await consume();
      // 2026-11-11: an overload cools the whole account for 2 minutes, like a provider group member.
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(false);
      expect(await readSubscriptionPoolModelAvailability('anthropic', sonnet)).toBe(false);
      const later = now + 120_000;
      vi.setSystemTime(later);
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(true);
      data = { sdkError: 'rate_limit', ...(resetDelay === null ? {} : { usageResetAt: later + resetDelay }) };
      await consume();
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(false);
      expect(await readSubscriptionPoolModelAvailability('anthropic', sonnet)).toBe(true);
      const duration = resetDelay ?? 1_800_000;
      vi.setSystemTime(later + duration - 1);
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(false);
      vi.setSystemTime(later + duration);
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(true);
      h.owner += '-new';
      await consume(); // This old lease cannot poison the new owner's pool.
      expect(await readSubscriptionPoolModelAvailability('anthropic', opus)).toBe(true);
      await handle.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // Unit: the same native OpenAI account serves Codex and ChatGPT bridge aliases;
  // an alias must not evade the failure recorded by the executing host.
  it('shares account failure evidence across native OpenAI model aliases', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.usage.mockResolvedValue({ codexUsage: { appServerBuckets: { codex: {
      limitId: 'codex', updatedAt: Date.now(),
      primary: { usedPercent: 100, windowMinutes: 300, resetsAt: Date.now() / 1000 + 3600 },
      secondary: null,
    } }, webSnapshot: null }, codexCredits: { hasCredits: true, unlimited: false, balance: '52768.87' } });
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: async () => ({
      id: 'codex-failed', close: async () => {},
      events: async function* () { yield { type: 'error', data: { codexErrorInfo: 'usageLimitExceeded' } }; },
    }) } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai', model: 'gpt-6-astra' } as StartSessionOptions);
    for await (const _event of handle.events()) { /* actual host wrapper */ }
    expect(readSubscriptionAccountBlocked('openai', 'default', 'gpt-6-astra')).toBe(true);
    await handle.close();
    const next = await acquireSubscriptionAccount('openai', 'chatgpt/gpt-6-astra', []);
    expect(next?.account.configDir).toBe('openai/second');
    next?.release();
    h.pools.openai!.accounts[1].paused = true;
    expect(await readSubscriptionPoolModelAvailability('openai', 'chatgpt/gpt-6-astra')).toBe(false);
    await runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'default', loginKey: 'reconnect' });
    expect(await readSubscriptionPoolModelAvailability('openai', 'chatgpt/gpt-6-astra')).toBe(true);
  });

  // #9833, unit: only an eligible account with known capacity may remove a
  // member cooldown. Pool aggregate tests did not cover this positive proof.
  it.each(['paused', 'removed', 'auth', 'unknown', 'exhausted', 'disconnected', 'single'] as const)(
    'does not recover a member when the alternate account is %s', async (reason) => {
      const now = Date.now();
      h.usage.mockImplementation(async (_provider: string, dir: string) => reason === 'unknown' && dir.endsWith('second') ? {} : ({ claudeUsage: {
        updatedAt: now, fiveHour: { utilization: 10, resetsAt: now / 1000 + 3600 },
        sevenDay: { utilization: dir.endsWith('default') || reason === 'exhausted' ? 100 : 20, resetsAt: now / 1000 + 86400 },
      } }));
      h.read.mockImplementation(async (_provider: string, dir: string) => {
        // Mutations happen while the CLI read is in flight, after the pool was captured.
        if (reason === 'paused') h.pools.anthropic!.accounts[1].paused = true;
        if (reason === 'removed') h.pools.anthropic!.accounts = h.pools.anthropic!.accounts.slice(0, 1);
        if (reason === 'disconnected') h.pools.anthropic!.disconnected = true;
        return { authenticated: !(reason === 'auth' && dir.endsWith('second')) };
      });
      if (reason === 'single') h.pools.anthropic!.accounts = [account('default')];
      expect(await readSubscriptionPoolModelAvailability('anthropic', 'claude-sonnet-5-5'))
        .toBe(reason === 'single' ? null : false);
    },
  );
  it('publishes usable model-specific Claude quota instead of the first account’s exhausted bucket', async () => {
    h.pools.anthropic!.strategy = 'order';
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({
      claudeUsage: {
        updatedAt: Date.now(),
        fiveHour: { utilization: 10, resetsAt: Date.now() / 1000 + 3600 },
        sevenDay: null,
        scoped: [
          {
            modelId: 'claude-sonnet',
            modelDisplayName: 'Sonnet',
            utilization: dir.endsWith('default') ? 100 : 20,
            resetsAt: Date.now() / 1000 + 3600,
          },
        ],
      },
    }));
    const quota = await readSubscriptionPoolUsage('anthropic');
    expect(quota?.claudeUsage?.scoped?.[0]?.utilization).toBe(20);
  });
  it('uses native Codex quota for ChatGPT bridge models and aggregates each model bucket separately', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default'), account('second')] };
    h.usage.mockImplementation(async (_provider: string, dir: string) => {
      const bucket = (limitId: string, usedPercent: number) => ({
        limitId,
        limitName: limitId,
        updatedAt: Date.now(),
        primary: { usedPercent, windowMinutes: 300, resetsAt: Date.now() / 1000 + 7200 },
        secondary: null,
      });
      return {
        codexUsage: {
          appServerBuckets: {
            codex: bucket('codex', dir.endsWith('default') ? 100 : 15),
            special: bucket('special', dir.endsWith('default') ? 5 : 100),
          },
          webSnapshot: null,
        },
      };
    });
    const chosen = await acquireSubscriptionAccount('openai', 'chatgpt/gpt-6-astra', []);
    expect(chosen?.account.configDir).toBe('openai/second');
    try {
      // The other account can ask upstream to spend credits even though its plan window is full.
      const credits = await acquireSubscriptionAccount('openai', 'chatgpt/gpt-6-astra', ['task:new']);
      expect(credits?.account.configDir).toBe('openai/default');
      credits?.release();
      const quota = (await readSubscriptionPoolUsage('openai'))?.codexUsage?.appServerBuckets;
      expect(quota?.codex.primary?.usedPercent).toBe(15);
      expect(quota?.special.primary?.usedPercent).toBe(5);
    } finally { chosen?.release(); }
  });
  // Regression: settings showed one weekly bar per account. Each account must carry every
  // window of its own snapshot, and sharing must list only accounts that can serve tasks.
  // Unit, user report 2026-11-11: a pause while CLI reads are pending must
  // affect group quota and shared account listings. Existing tests paused first.
  it.each(['aggregate', 'shared'] as const)('rechecks paused accounts after pending %s quota reads', async kind => {
    let finish!: (value: object) => void;
    const pending = new Promise<object>(resolve => { finish = resolve; });
    h.usage.mockReturnValue(pending);
    const read = kind === 'aggregate' ? readSubscriptionPoolUsage : readSubscriptionPoolAccountUsages;
    const result = read('anthropic');
    await vi.waitFor(() => expect(h.usage).toHaveBeenCalled());
    h.pools.anthropic = { ...h.pools.anthropic!, accounts: h.pools.anthropic!.accounts.map(a => ({ ...a, paused: true })) };
    finish({ claudeUsage: { updatedAt: Date.now(), fiveHour: { utilization: 10, resetsAt: Date.now() / 1000 + 3600 } } });
    expect(await result).toEqual(kind === 'aggregate' ? null : []);
  });

  // PR #10405, unit: placement can change while quota is pending; a source must not publish an
  // account which now belongs elsewhere. Prior pending-read regressions only changed pause state.
  it('omits a moved account from sharing after its pending quota read completes', async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    let finish!: (value: object) => void;
    const pending = new Promise<object>(resolve => { finish = resolve; });
    h.usage.mockImplementation(() => { started(); return pending; });
    const result = readSubscriptionPoolAccountUsages('anthropic');
    await reading;
    h.placement['anthropic:second'] = 'anthropic-sub-12345678';
    finish({ claudeUsage: { updatedAt: Date.now(), fiveHour: { utilization: 10, resetsAt: Date.now() / 1000 + 3600 } } });
    expect((await result)?.map(a => a.usage?.claudeUsage?.fiveHour?.utilization)).toEqual([10]);
  });

  it('reports every usage window per account and lists only assignable accounts for sharing', async () => {
    h.pools.anthropic!.accounts.push({ ...account('paused'), paused: true }, account('signed-out'));
    h.read.mockImplementation(async (_provider: string, dir: string) => ({
      authenticated: !dir.endsWith('signed-out'),
      identity: dir,
    }));
    const window = (utilization: number) => ({ utilization, resetsAt: Date.now() / 1000 + 3600 });
    h.usage.mockImplementation(async (_provider: string, dir: string) => ({
      claudeUsage: {
        updatedAt: Date.now(),
        fiveHour: window(dir.endsWith('default') ? 2 : 30),
        sevenDay: window(dir.endsWith('default') ? 86 : 40),
        scoped: [{ modelId: 'claude-fable', modelDisplayName: 'Fable', ...window(16) }],
      },
    }));
    const view = await readSubscriptionPool('anthropic');
    expect(view.accounts.map((a) => a.usage?.claude?.sevenDay?.utilization)).toEqual([
      86,
      40,
      40,
      undefined,
    ]);
    expect(view.accounts[1].usage?.claude).toMatchObject({
      fiveHour: { utilization: 30 },
      scoped: [{ modelDisplayName: 'Fable', utilization: 16 }],
    });
    const shared = await readSubscriptionPoolAccountUsages('anthropic');
    expect(shared?.map(a => a.usage?.claudeUsage?.sevenDay?.utilization)).toEqual([86, 40]);
    expect(JSON.stringify(shared)).not.toContain('anthropic/');
    h.pools.anthropic!.disconnected = true;
    expect(await readSubscriptionPoolAccountUsages('anthropic')).toBeUndefined();
    expect((await readSubscriptionPool('anthropic')).accounts.every((a) => !a.usage)).toBe(true);
  });
  // User-reported quota oscillation / unit: frequent SDK events used to renew
  // the cache clock forever. Existing tests never cross endpoint TTL with events.
  it('refreshes authoritative Claude percentages despite continuous SDK events', async () => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      h.pools.anthropic = { strategy: 'order', accounts: [account('default')] };
      const reset = now / 1000 + 604800;
      h.usage.mockResolvedValue({ claudeUsage: {
        source: 'oauth-endpoint', updatedAt: now, sevenDay: { utilization: 22, resetsAt: reset },
      } });
      const lease = await acquireSubscriptionAccount('anthropic', 'claude-sonnet', []);
      for (let i = 0; i < 5; i++) {
        now += 31_000;
        observeSubscriptionAccountUsage(lease!.account, {
          rateLimitType: 'seven_day', utilization: 0.2, resetsAt: reset, status: 'allowed',
        });
        expect((await readSubscriptionPool('anthropic')).accounts[0].usage?.claude?.sevenDay?.utilization).toBe(22);
      }
      expect(h.usage).toHaveBeenCalledTimes(1);
      now += 31_000;
      h.usage.mockResolvedValue({ claudeUsage: {
        source: 'oauth-endpoint', updatedAt: now, sevenDay: { utilization: 24, resetsAt: reset },
      } });
      observeSubscriptionAccountUsage(lease!.account, {
        rateLimitType: 'seven_day', utilization: 0.2, resetsAt: reset, status: 'allowed',
      });
      expect((await readSubscriptionPool('anthropic')).accounts[0].usage?.claude?.sevenDay?.utilization).toBe(24);
      expect(h.usage).toHaveBeenCalledTimes(2);
      lease!.release();
    } finally { clock.mockRestore(); }
  });

  // #9951 P1 / unit: list reads yield to auth and quota I/O. Existing TTL tests
  // complete I/O immediately and cannot detect a rejected event being overwritten.
  it.each(['anthropic', 'openai'] as const)('retains %s quota events during auth, endpoint and failed endpoint reads', async (provider) => {
    let now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let releaseRead: (() => void) | undefined;
    try {
      // Room for the held lease and the post-reset lease below (limits are hard).
      h.pools[provider] = { strategy: 'order', accounts: [{ ...account('default'), limit: 2 }] };
      const reset = now / 1000 + 86400;
      const initial = provider === 'anthropic'
        ? { claudeUsage: { source: 'oauth-endpoint', updatedAt: now, fiveHour: { utilization: 20, resetsAt: reset } } }
        : { codexUsage: { appServerBuckets: {
            codex: { limitId: 'codex', updatedAt: now,
              primary: { usedPercent: 20, windowMinutes: 300, resetsAt: reset },
              secondary: { usedPercent: 25, windowMinutes: 10080, resetsAt: reset } },
            spark: { limitId: 'spark', updatedAt: now,
              primary: { usedPercent: 15, windowMinutes: 300, resetsAt: reset }, secondary: null },
          }, webSnapshot: null } };
      h.usage.mockResolvedValue(initial);
      const lease = await acquireSubscriptionAccount(provider, provider === 'anthropic' ? 'claude-sonnet' : 'gpt-6', []);
      for (const phase of ['auth', 'endpoint', 'failed-endpoint', 'new-window']) {
        now += phase === 'auth' ? 31_000 : 181_000;
        let started!: () => void;
        const reading = new Promise<void>(resolve => { started = resolve; });
        const paused = new Promise<void>(resolve => { releaseRead = resolve; });
        if (phase === 'auth') h.read.mockImplementationOnce(async () => {
          started(); await paused; return { authenticated: true, identity: 'account' };
        });
        else h.usage.mockImplementationOnce(async () => {
          started(); await paused;
          if (phase === 'failed-endpoint') throw new Error('endpoint unavailable');
          return provider === 'anthropic' ? { claudeUsage: {
            source: 'oauth-endpoint', updatedAt: now + 1,
            fiveHour: { utilization: 30, resetsAt: phase === 'new-window' ? reset + 18000 : reset },
            sevenDay: { utilization: 45, resetsAt: reset },
            scoped: [{ modelDisplayName: 'Opus', utilization: 60, resetsAt: reset }],
          } } : { codexUsage: { appServerBuckets: {
            codex: { limitId: 'codex', updatedAt: now + 1,
              primary: { usedPercent: 30, windowMinutes: 300, resetsAt: phase === 'new-window' ? reset + 18000 : reset },
              secondary: { usedPercent: 45, windowMinutes: 10080, resetsAt: reset } },
            spark: { limitId: 'spark', updatedAt: now + 1,
              primary: { usedPercent: 60, windowMinutes: 300, resetsAt: reset }, secondary: null },
          }, webSnapshot: null }, codexCredits: { hasCredits: true, unlimited: false, balance: '8.50' } };
        });
        const view = readSubscriptionPool(provider);
        await reading;
        observeSubscriptionAccountUsage(lease!.account, provider === 'anthropic'
          ? { rateLimitType: 'five_hour', utilization: 1, resetsAt: reset, status: 'rejected' }
          : { limitId: 'codex', primary: { usedPercent: 100, windowMinutes: 300, resetsAt: reset } });
        releaseRead!();
        const usage = (await view).accounts[0].usage;
        if (phase === 'new-window') {
          if (provider === 'anthropic') {
            expect(usage?.claude?.fiveHour?.resetsAt).toBe(reset + 18000);
            expect(usage?.claude?.rateLimitStatus).toBeUndefined();
          } else expect(usage?.codex?.buckets.codex.primary).toMatchObject({ usedPercent: 30, resetsAt: reset + 18000 });
          const nextLease = await acquireSubscriptionAccount(provider, provider === 'anthropic' ? 'claude-sonnet' : 'gpt-6', []);
          expect(nextLease).toBeTruthy();
          nextLease!.release();
          continue;
        }
        if (provider === 'anthropic') expect(usage?.claude?.rateLimitStatus).toBe('rejected');
        else expect(usage?.codex?.buckets.codex.primary?.usedPercent).toBe(100);
        if (phase === 'endpoint') {
          // #9951 P2: a concurrent event must not discard successful read fields
          // or keep the endpoint TTL expired. Prior tests only checked rejection.
          if (provider === 'anthropic') expect(usage?.claude).toMatchObject({
            fiveHour: { utilization: 30 }, sevenDay: { utilization: 45 },
            scoped: [{ modelDisplayName: 'Opus', utilization: 60 }],
          });
          else expect(usage?.codex).toMatchObject({
            buckets: { codex: { secondary: { usedPercent: 45 } }, spark: { primary: { usedPercent: 60 } } },
            credits: { balance: '8.50' },
          });
          const readCount = h.usage.mock.calls.length;
          now += 31_000;
          await readSubscriptionPool(provider);
          expect(h.usage).toHaveBeenCalledTimes(readCount);
        }
        if (provider === 'anthropic') {
          await expect(acquireSubscriptionAccount(provider, 'claude-sonnet', []))
            .rejects.toThrow('[SUBSCRIPTION_POOL_MODEL_LIMITED]');
        } else {
          const next = await acquireSubscriptionAccount(provider, 'gpt-6', []);
          expect(next?.account.configDir).toBe('openai/default');
          next?.release();
        }
      }
      lease!.release();
    } finally { releaseRead?.(); clock.mockRestore(); }
  });

  it('keeps Codex credits for the account card when quota events update its buckets', async () => {
    h.pools.openai = { strategy: 'order', accounts: [account('default')] };
    h.usage.mockResolvedValue({
      codexUsage: {
        appServerBuckets: {
          codex: {
            limitId: 'codex',
            limitName: null,
            updatedAt: Date.now(),
            primary: { usedPercent: 10, windowMinutes: 300, resetsAt: Date.now() / 1000 + 600 },
            secondary: null,
          },
        },
        webSnapshot: null,
      },
      codexCredits: { hasCredits: true, unlimited: false, balance: '12.50' },
    });
    const lease = await acquireSubscriptionAccount('openai', 'gpt-6', []);
    observeSubscriptionAccountUsage(lease!.account, {
      limitId: 'codex',
      primary: { usedPercent: 55, windowMinutes: 300, resetsAt: Date.now() / 1000 + 600 },
    });
    lease!.release();
    expect((await readSubscriptionPool('openai')).accounts[0].usage?.codex).toMatchObject({
      buckets: { codex: { primary: { usedPercent: 55 } } },
      credits: { balance: '12.50' },
    });
  });

  // 2026-11-19 user report (Codex 发消息卡 1–2 秒) and decision, subscription-account-pools.md
  // 「同机多账号的故障隔离」, unit. Entry: the wrapped agent's startSession plus the account views.
  // Every Codex runtime start waited for each account's quota read (its own CLI process and a
  // chatgpt.com request), although ChatGPT quota only orders new assignments. Existing start tests
  // answer that read at once and their logins carry no plan, so none could see the wait.
  // Minimal failing input: a quota read older than its 3-minute reuse window that has not answered.
  describe('starting while an account quota read is still running', () => {
    let now = 1_800_000_000_000;
    // The default account is nearly through its five-hour window; the second has room.
    const quotaFor = (directory: string, percent = directory.endsWith('/default') ? 90 : 10) => directory.startsWith('anthropic/')
      ? { claudeUsage: { source: 'oauth-endpoint', updatedAt: now,
        fiveHour: { utilization: percent, resetsAt: now / 1000 + 3 * 3600 } } }
      : { codexUsage: { appServerBuckets: { codex: { limitId: 'codex', limitName: null, updatedAt: now,
        primary: { usedPercent: percent, windowMinutes: 300, resetsAt: now / 1000 + 3 * 3600 }, secondary: null } },
      webSnapshot: null } };
    /** Reads every account once as the settings page does, ages that read, then holds the next quota read. */
    const holdNextQuotaRead = async (provider: SubscriptionProvider, ageMs: number, fresh: number) => {
      h.read.mockImplementation(async (_kind: string, directory: string) => ({
        authenticated: true, identity: `${directory.replace('/', '-')}@example.test`, plan: 'plus', planType: 'plus',
      }));
      h.usage.mockImplementation(async (_kind: string, directory: string) => quotaFor(directory));
      await readSubscriptionPool(provider);
      now += ageMs;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      h.usage.mockImplementation(async (_kind: string, directory: string) => { await gate; return quotaFor(directory, fresh); });
      return release;
    };
    const startAgent = (kind: 'codex' | 'claude-code', checkAuth = false) => {
      const spawned = vi.fn();
      const start = vi.fn(async (options: StartSessionOptions) => {
        if (checkAuth) expect(await options[NATIVE_SUBSCRIPTION_ACCOUNT]?.readState()).toMatchObject({ authenticated: true });
        spawned();
        return { id: 'task-native', close: async () => {} } as unknown as AgentSessionHandle;
      });
      return { start, spawned, agent: withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent) };
    };
    const shownQuota = async (provider: SubscriptionProvider, accountId: string) => {
      const usage = (await readSubscriptionPool(provider)).accounts.find((entry) => entry.id === accountId)?.usage;
      return provider === 'openai' ? usage?.codex?.buckets.codex.primary?.usedPercent : usage?.claude?.fiveHour?.utilization;
    };

    // Rows that wait prove it by their result: only the fresh quota picks `default` (row 4) or stops
    // the limited Claude account (row 5); the quota read before would have chosen otherwise.
    it.each([
      { name: 'a Codex task resuming on its account', kind: 'codex', provider: 'openai', accounts: ['default', 'second'],
        bound: 'second', ageMs: 4 * 60_000, waits: false, fresh: 50, account: 'second' },
      { name: 'a new Codex task with one account', kind: 'codex', provider: 'openai', accounts: ['default'],
        ageMs: 40 * 60_000, waits: false, fresh: 50, account: 'default' },
      { name: 'a new Codex task ordered by a quota read four minutes ago', kind: 'codex', provider: 'openai',
        accounts: ['default', 'second'], ageMs: 4 * 60_000, waits: false, fresh: 50, account: 'second' },
      { name: 'a new Codex task whose last quota is too old to order by', kind: 'codex', provider: 'openai',
        accounts: ['default', 'second'], ageMs: 6 * 60_000, waits: true, fresh: 50, account: 'default' },
      { name: 'a Claude task, whose quota decides whether it may start', kind: 'claude-code', provider: 'anthropic',
        accounts: ['default', 'second'], bound: 'second', ageMs: 4 * 60_000, waits: true, fresh: 100, account: null },
    ] as const)('$name: waits for the quota read = $waits', async (row) => {
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        h.pools[row.provider] = { strategy: 'least', accounts: row.accounts.map(account) };
        const bound: string | undefined = 'bound' in row ? row.bound : undefined;
        if (bound) for (const key of ['task:task', 'native:task-native'])
          h.bindings.set(key, { providerId: row.provider, accountId: bound });
        const release = await holdNextQuotaRead(row.provider, row.ageMs, row.fresh);
        const loginReads = h.read.mock.calls.length;
        const quotaReads = h.usage.mock.calls.length;
        const { start, agent } = startAgent(row.kind);
        const starting = agent.startSession({ providerId: row.provider, sessionId: 'task',
          model: row.kind === 'codex' ? 'gpt-6' : 'claude-sonnet',
          ...(bound ? { resumeSessionId: 'task-native' } : {}) } as StartSessionOptions);
        await vi.waitFor(() => expect(h.usage.mock.calls.length).toBeGreaterThan(quotaReads));
        if (!row.waits) await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        // The login is still read for every start; only the quota read stops blocking Codex.
        expect(h.read.mock.calls.length).toBeGreaterThan(loginReads);
        release();
        if (row.account === null) {
          await expect(starting).rejects.toBeInstanceOf(AgentStartupStoppedError);
          expect(start).not.toHaveBeenCalled();
        } else {
          const handle = await starting;
          expect(start.mock.calls[0]![0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe(`${row.provider}/${row.account}`);
          await handle.close();
        }
        // The quota read still completes and is what the account views show.
        expect(await shownQuota(row.provider, bound ?? row.account ?? 'default')).toBe(row.fresh);
      } finally { clock.mockRestore(); }
    });

    // Same decision: returning to Cindy refreshes the account views, and a message sent meanwhile
    // joins that read. The task starts on the login it read; the views still wait for its quota.
    it('starts on the login of a view read that is still fetching quota, without a second read', async () => {
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      try {
        h.pools.openai = { strategy: 'least', accounts: [account('default')] };
        const release = await holdNextQuotaRead('openai', 4 * 60_000, 50);
        const quotaReads = h.usage.mock.calls.length;
        let viewed = false;
        const viewing = readSubscriptionPool('openai').then((view) => { viewed = true; return view; });
        await vi.waitFor(() => expect(h.usage).toHaveBeenCalledTimes(quotaReads + 1));
        const { start, agent } = startAgent('codex');
        const starting = agent.startSession({ providerId: 'openai', sessionId: 'task', model: 'gpt-6' } as StartSessionOptions);
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        expect(viewed).toBe(false);
        release();
        expect((await viewing).accounts[0].usage?.codex?.buckets.codex.primary?.usedPercent).toBe(50);
        expect(h.usage).toHaveBeenCalledTimes(quotaReads + 1);
        await (await starting).close();
      } finally { clock.mockRestore(); }
    });

    // The host checks auth again before spawning. Hold quota and release it on either side of
    // model discovery: the native start must proceed, and its login must survive quota enrichment
    // even for a legacy default login without a plan (review threads #11479, unit).
    it.each([
      { legacy: false, finishQuotaFirst: true },
      { legacy: false, finishQuotaFirst: false },
      { legacy: true, finishQuotaFirst: true },
      { legacy: true, finishQuotaFirst: false },
    ])('starts with legacy=$legacy and quota finishing before models=$finishQuotaFirst', async ({ legacy, finishQuotaFirst }) => {
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let releaseQuota: (() => void) | undefined;
      let listModels: (() => void) | undefined;
      let starting: Promise<AgentSessionHandle> | undefined;
      let existing: Awaited<ReturnType<typeof acquireSubscriptionAccount>> = null;
      try {
        h.pools.openai = { strategy: 'least', accounts: [{ ...account('default'), limit: 2 }], legacyCodexDefault: legacy };
        if (legacy && finishQuotaFirst) existing = await acquireSubscriptionAccount('openai', undefined, []);
        releaseQuota = await holdNextQuotaRead('openai', 4 * 60_000, 50);
        const originalUsage = h.usage.getMockImplementation()!;
        h.usage.mockImplementation(async (kind: string, directory: string) => ({
          ...await originalUsage(kind, directory), codexPlan: 'pro',
        }));
        const listed = new Promise<void>((resolve) => { listModels = resolve; });
        h.rpc.mockImplementation(async (_directory: string, method: string) => {
          if (method !== 'model/list') return undefined;
          await listed;
          return { data: [{ id: 'gpt-6' }], nextCursor: null };
        });
        const { start, spawned, agent } = startAgent('codex', true);
        starting = agent.startSession({ providerId: 'openai', sessionId: 'task', model: 'gpt-6' } as StartSessionOptions);
        void starting.catch(() => {});
        await vi.waitFor(() => expect(h.rpc.mock.calls.some((call) => call[1] === 'model/list')).toBe(true));
        if (finishQuotaFirst) {
          // A running task can publish its plan and quota while a new task is discovering models.
          if (legacy) {
            expect(existing).not.toBeNull();
            observeSubscriptionAccountUsage(existing!.account, {
              limitId: 'codex-other', planType: 'pro',
              secondary: { usedPercent: 65, windowMinutes: 10_080, resetsAt: now / 1000 + 3600 },
            });
          }
          releaseQuota();
          expect(await shownQuota('openai', 'default')).toBe(50);
        }
        listModels!();
        await vi.waitFor(() => expect(spawned).toHaveBeenCalledOnce());
        await starting;
        expect(start.mock.calls[0]![0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir)
          .toBe(legacy ? '/existing-cindy/codex-home' : 'openai/default');
        releaseQuota();
        const view = await readSubscriptionPool('openai');
        expect(view.accounts[0].plan).toBe(legacy ? 'pro' : 'plus');
        expect(view.accounts[0].usage?.codex?.buckets.codex.primary?.usedPercent).toBe(50);
        if (legacy && finishQuotaFirst)
          expect(view.accounts[0].usage?.codex?.buckets['codex-other']?.secondary?.usedPercent).toBe(65);
      } finally {
        releaseQuota?.();
        listModels?.();
        await starting?.then((handle) => handle.close(), () => {});
        existing?.release();
        clock.mockRestore();
      }
    });

    // An auth rejection can now race the pending quota request. A late successful quota
    // must never make the rejected login usable again (account pool login admission, unit).
    it('keeps a rejected Codex login unavailable after its pending quota read completes', async () => {
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let releaseQuota: (() => void) | undefined;
      try {
        h.pools.openai = { strategy: 'least', accounts: [account('default')] };
        releaseQuota = await holdNextQuotaRead('openai', 4 * 60_000, 50);
        const lease = await acquireSubscriptionAccount('openai', 'gpt-6', []);
        expect(lease).not.toBeNull();
        const viewing = readSubscriptionPool('openai');
        lease!.account.invalidateAuth?.('invalid_grant', 'test-token');
        releaseQuota();
        expect((await viewing).accounts[0].status).toBe('signed-out');
        await expect(lease!.account.readState()).resolves.toMatchObject({ authenticated: false });
        lease!.release();
      } finally {
        releaseQuota?.();
        clock.mockRestore();
      }
    });
  });
  it('reserves login before asynchronous writes, and an early cancellation never launches the CLI', async () => {
    const pending = runSubscriptionAccountCommand({
      action: 'login',
      providerId: 'anthropic',
      accountId: 'default',
      loginKey: 'first',
    });
    const rejected = expect(
      runSubscriptionAccountCommand({
        action: 'login',
        providerId: 'anthropic',
        accountId: 'second',
        loginKey: 'second',
      }),
    ).rejects.toThrow('login_in_progress');
    const cancelled = expect(pending).rejects.toThrow('login_cancelled');
    await runSubscriptionAccountCommand({
      action: 'cancel',
      providerId: 'anthropic',
      loginKey: 'first',
    });
    await rejected;
    await cancelled;
    expect(h.login).not.toHaveBeenCalled();
  });
  it('does not replace credentials while an account is running a turn', async () => {
    const active = await acquireSubscriptionAccount('anthropic', undefined, []);
    await expect(
      runSubscriptionAccountCommand({
        action: 'login',
        providerId: 'anthropic',
        accountId: 'default',
        loginKey: 'busy',
      }),
    ).rejects.toThrow('in use');
    expect(h.login).not.toHaveBeenCalled();
    active!.release();
  });
  // Standard tier: exercise the real dispatch wrapper, not a second copy of its routing logic.
  it('keeps direct and device-hosted starts in the same pool and releases turn counts after terminal events', async () => {
    const routes: StartSessionOptions[] = [];
    const native = {
      kind: 'claude-code',
      startSession: async (options: StartSessionOptions) => {
        routes.push(options);
        return {
          id: `thread-${routes.length}`,
          send: async () => {},
          close: async () => {},
          events: async function* () {
            yield { type: 'done', data: {} };
          },
        } as unknown as AgentSessionHandle;
      },
    } as unknown as BaseAgent;
    const agent = withSubscriptionAccounts(native);
    const first = await agent.startSession({
      providerId: 'anthropic',
      sessionId: 'first',
      workingDir: '/work',
    } as StartSessionOptions);
    await first.send({ type: 'user', content: 'hello' });
    const second = await agent.startSession({
      providerId: 'anthropic',
      sessionId: 'hosted',
      workingDir: '/work',
      deviceHosted: true,
    } as unknown as StartSessionOptions);
    expect(routes[0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).not.toBe(
      routes[1][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir,
    );
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      1, 1,
    ]);
    for await (const event of first.events()) {
      expect(event.type).toBe('done');
    }
    await second.close();
    expect((await readSubscriptionPool('anthropic')).accounts.map((a) => a.running)).toEqual([
      0, 0,
    ]);
  });
  // 2026-11-11 report: account switches/strategies appeared ineffective. Existing
  // dispatch tests always supplied providerId, so native default routes bypassed
  // the pool untested. Unit: configure through the production command, then start
  // local/hosted tasks without providerId; observe the actual runtime profile.
  it.each(['claude-code', 'codex'].flatMap(kind => [false, true].map(hosted => ({ kind, hosted }))))(
    'applies account settings to an implicit $kind subscription (hosted=$hosted)',
    async ({ kind, hosted }) => {
      const provider = kind === 'claude-code' ? 'anthropic' : 'openai';
      h.pools[provider] = { strategy: 'least', accounts: [account('default'), account('second')] };
      const start = vi.fn(async (_options: StartSessionOptions) => ({ id: 'implicit-native', close: async () => {} }));
      const auth = { getState: vi.fn(async () => ({ authenticated: true, authSource: 'oauth' as const })) };
      const agent = withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent, auth);
      const options = { workingDir: '/work', model: kind === 'claude-code' ? 'claude-sonnet' : 'gpt-6',
        ...(hosted ? { deviceHosted: { workingDir: '/controller' } } : {}) } as StartSessionOptions;
      await runSubscriptionAccountCommand({ action: 'configure', providerId: provider, strategy: 'round' });
      const profiles: Array<string | undefined> = [];
      for (const sessionId of ['implicit-a', 'implicit-b']) {
        const handle = await agent.startSession({ ...options, sessionId });
        profiles.push(start.mock.calls.at(-1)![0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir);
        await handle.close();
      }
      expect(profiles).toEqual([`${provider}/default`, `${provider}/second`]);
      await runSubscriptionAccountCommand({ action: 'configure', providerId: provider, accountId: 'default', paused: true });
      const next = await agent.startSession({ ...options, sessionId: 'implicit-c' });
      expect(start.mock.calls.at(-1)![0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe(`${provider}/second`);
      await next.close();
      await runSubscriptionAccountCommand({ action: 'configure', providerId: provider, accountId: 'second', paused: true });
      await expect(agent.startSession({ ...options, sessionId: 'implicit-d' })).rejects.toThrow('No subscription account');
      expect(start).toHaveBeenCalledTimes(3);
    },
  );
  // The default-route fix must not select a subscription for a gateway, custom,
  // SSH or Pi route. Existing cases covered explicit subscriptions only.
  // PR #9998 review, unit: the actual connected default is asynchronous; an
  // OAuth-authenticated host must not turn a custom default into OpenAI.
  it.each(['openai', 'custom', null])('awaits the connected Codex default %s before allocating an account', async source => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    const start = vi.fn<BaseAgent['startSession']>(async () => ({ id: 'connected-default', close: async () => {} }) as AgentSessionHandle);
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start } as unknown as BaseAgent, {
      getState: async () => ({ authenticated: true, authSource: 'oauth' }),
      resolveDefaultProvider: async () => source,
    });
    const input = { model: 'shared-model', sessionId: 'default-task' } as StartSessionOptions;
    const handle = await agent.startSession(input);
    expect(Boolean(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT])).toBe(source !== 'custom');
    if (source === 'custom') expect(start).toHaveBeenCalledExactlyOnceWith(input);
    await handle.close();
  });
  it.each([
    { kind: 'claude-code', options: {}, nativeAuth: false },
    { kind: 'claude-code', options: { providerId: 'xd' }, nativeAuth: true },
    { kind: 'claude-code', options: { providerId: 'custom' }, nativeAuth: true },
    { kind: 'claude-code', options: { remoteHostId: 'ssh-host' }, nativeAuth: true },
    { kind: 'codex', options: { model: 'codex/gpt-6' }, nativeAuth: true },
    { kind: 'codex', options: { model: 'custom-model' }, nativeAuth: true },
    { kind: 'pi', options: {}, nativeAuth: true },
  ])('preserves non-pool default routes: $kind $options (native=$nativeAuth)', async ({ kind, options, nativeAuth }) => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    const start = vi.fn(async (_options: StartSessionOptions) => ({ id: 'non-pool' }));
    const auth = {
      getState: vi.fn(async () => ({ authenticated: true, authSource: nativeAuth ? 'oauth' as const : 'api-key' as const })),
      resolveDefaultProvider: (model?: string) => model === 'custom-model' ? 'custom' : null,
    };
    const agent = withSubscriptionAccounts({ kind, startSession: start } as unknown as BaseAgent, auth);
    const input = { workingDir: '/work', model: 'claude-sonnet', ...options } as StartSessionOptions;
    await agent.startSession(input);
    expect(start).toHaveBeenCalledExactlyOnceWith(input);
    expect(h.read).not.toHaveBeenCalled();
  });
  it('rebuilds when a non-pool runtime switches to an implicit subscription', async () => {
    const setModel = vi.fn();
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async () => ({
      id: 'custom-runtime', setModel, requiresModelSwitchRebuild: async () => false,
    }) } as unknown as BaseAgent, {
      getState: async () => ({ authenticated: true, authSource: 'oauth' }),
    });
    const handle = await agent.startSession({ providerId: 'custom', model: 'claude-sonnet' } as StartSessionOptions);
    expect(await handle.requiresModelSwitchRebuild!('claude-sonnet', { providerId: null })).toBe(true);
    await expect(handle.setModel!('claude-sonnet', { providerId: null })).rejects.toThrow('requires rebuilding');
    expect(setModel).not.toHaveBeenCalled();
  });
  it('registers the selected account for an implicit ChatGPT bridge instead of using its default login', async () => {
    h.pools.openai = { strategy: 'order', accounts: [{ ...account('default'), paused: true }, account('second')] };
    const start = vi.fn(async (_options: StartSessionOptions) => ({ id: 'bridge-native', close: async () => {} }));
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: start } as unknown as BaseAgent);
    const handle = await agent.startSession({ sessionId: 'implicit-bridge', model: 'chatgpt/gpt-6' } as StartSessionOptions);
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/second');
    expect(getSessionSubscriptionAccount('implicit-bridge')).toBe(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]);
    await handle.close();
  });
  it('rejects an owner switch while resolving an implicit subscription', async () => {
    const start = vi.fn();
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: start } as unknown as BaseAgent, {
      getState: async () => {
        h.owner = 'other-owner';
        return { authenticated: true, authSource: 'oauth' };
      },
    });
    await expect(agent.startSession({ model: 'claude-sonnet' } as StartSessionOptions)).rejects.toThrow('owner changed');
    expect(start).not.toHaveBeenCalled();
    expect(h.read).not.toHaveBeenCalled();
  });
  // Unit regression: an unbound old thread already lives in an imported account
  // home, but legacy startup checks the disconnected default login (no_oauth).
  // Exercise resume/fork through the real wrapper and persist only the proven owner.
  it.each(['resume', 'fork'].flatMap(operation => ['openai', null, '  '].map(providerId => ({ operation, providerId }))))('recovers the original imported account for an unbound $operation (provider=$providerId)', async ({ operation, providerId }) => {
    h.pools.openai = { strategy: 'order', accounts: [account('second'), account('imported')],
      legacyCodexAccounts: { 'openai-old': 'imported' } };
    h.legacyRead.mockResolvedValue({ authenticated: false, errorReason: 'no_oauth' });
    const start = vi.fn(async (_options: StartSessionOptions) => ({ id: 'legacy', close: async () => {} }));
    const fork = vi.fn(async (_options: ForkSdkSessionOptions) => ({ newSdkSessionId: 'forked' }));
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start, forkSdkSession: fork } as unknown as BaseAgent, {
      getState: h.legacyRead,
      resolveCodexHistoryHome: async () => 'openai/imported',
    });
    if (operation === 'resume') {
      const handle = await agent.startSession({ providerId, sessionId: 'old-task', resumeSessionId: 'legacy' } as StartSessionOptions);
      expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
      expect(h.bindings.get('task:old-task')?.accountId).toBe('imported');
      await handle.close();
    } else {
      await agent.forkSdkSession({ providerId, sourceSdkSessionId: 'legacy' } as ForkSdkSessionOptions);
      expect(fork.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
      expect(h.bindings.get('native:forked')?.accountId).toBe('imported');
    }
    expect(h.bindings.get('native:legacy')?.accountId).toBe('imported');
  });
  // Review #10068: historical affinity is proof of the original login, but must
  // never turn another selected/default source or SSH thread into a subscription.
  it.each(['resume', 'fork'].flatMap(operation => [
    { providerId: 'xd', model: 'gpt-6' },
    { providerId: 'custom', model: 'gpt-6' },
    { providerId: null, model: 'codex/gpt-6' },
    { providerId: null, model: 'custom-model' },
    { providerId: null, model: 'gpt-6', remoteHostId: 'ssh-host' },
  ].map(route => ({ operation, ...route }))))('preserves $operation route $providerId/$model/$remoteHostId', async ({ operation, ...route }) => {
    h.pools.openai = { strategy: 'order', accounts: [account('imported')], legacyCodexAccounts: { 'openai-old': 'imported' } };
    const start = vi.fn(async () => ({ id: 'legacy' }));
    const fork = vi.fn(async () => ({ newSdkSessionId: 'forked' }));
    const history = vi.fn(async () => 'openai/imported');
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start, forkSdkSession: fork } as unknown as BaseAgent, {
      getState: h.legacyRead,
      resolveDefaultProvider: model => model === 'custom-model' ? 'custom' : null,
      resolveCodexHistoryHome: history,
    });
    if (operation === 'resume') {
      const options = { ...route, sessionId: 'old-task', resumeSessionId: 'legacy' } as StartSessionOptions;
      await agent.startSession(options);
      expect(start).toHaveBeenCalledExactlyOnceWith(options);
    } else {
      const options = { ...route, sourceSdkSessionId: 'legacy' } as ForkSdkSessionOptions;
      await agent.forkSdkSession(options);
      expect(fork).toHaveBeenCalledExactlyOnceWith(options);
    }
    expect(history).not.toHaveBeenCalled();
    expect(h.bindings.size).toBe(0);
  });
  it.each(['resume', 'fork'] as const)('uses the recorded account for an implicit %s without the default login', async operation => {
    h.pools.openai = { strategy: 'order', accounts: [account('second'), account('imported')], legacyCodexAccounts: { 'openai-old': 'imported' } };
    h.bindings.set('native:legacy', { providerId: 'openai', accountId: 'imported' });
    h.legacyRead.mockResolvedValue({ authenticated: false, errorReason: 'no_oauth' });
    const start = vi.fn(async (_options: StartSessionOptions) => ({ id: 'legacy', close: async () => {} }));
    const fork = vi.fn(async (_options: ForkSdkSessionOptions) => ({ newSdkSessionId: 'forked' }));
    const history = vi.fn(async () => 'openai/second');
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start, forkSdkSession: fork } as unknown as BaseAgent, {
      getState: h.legacyRead, resolveCodexHistoryHome: history,
    });
    if (operation === 'resume') {
      const handle = await agent.startSession({ providerId: null, sessionId: 'old-task', resumeSessionId: 'legacy' } as StartSessionOptions);
      expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
      await handle.close();
    } else {
      await agent.forkSdkSession({ providerId: null, sourceSdkSessionId: 'legacy' } as ForkSdkSessionOptions);
      expect(fork.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/imported');
    }
    expect(history).not.toHaveBeenCalled();
  });
  it.each(['removed', 'paused', 'signed-out', 'owner-changed', 'lookup-failed'].flatMap(failure => ['openai', null].map(providerId => ({ failure, providerId }))))('does not replace the historical account when $failure (provider=$providerId)', async ({ failure, providerId }) => {
    h.pools.openai = { strategy: 'order', accounts: [account('second'), ...(failure === 'removed' ? [] : [account('imported')])],
      legacyCodexAccounts: { 'openai-old': 'imported' } };
    if (failure === 'paused') h.pools.openai.accounts[1].paused = true;
    if (failure === 'signed-out') h.importedRead.mockResolvedValue({ authenticated: false });
    const start = vi.fn();
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start } as unknown as BaseAgent, {
      getState: h.legacyRead,
      resolveCodexHistoryHome: async () => {
        if (failure === 'lookup-failed') throw new Error('History index unavailable');
        if (failure === 'owner-changed') h.owner = 'other-owner';
        return 'openai/imported';
      },
    });
    await expect(agent.startSession({ providerId, sessionId: 'old-task', resumeSessionId: 'legacy' } as StartSessionOptions)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(h.bindings.size).toBe(0);
  });
  it('preserves a pre-pool Codex resume on its legacy home instead of silently selecting ~/.codex', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    const start = vi.fn(async () => ({ id: 'legacy' }));
    const agent = withSubscriptionAccounts({
      kind: 'codex',
      startSession: start,
    } as unknown as BaseAgent, { getState: h.legacyRead, resolveCodexHistoryHome: async () => '/unregistered-private-home' });
    const options = {
      providerId: 'openai',
      resumeSessionId: 'legacy',
      sessionId: 'old-task',
    } as StartSessionOptions;
    await agent.startSession(options);
    expect(start).toHaveBeenCalledExactlyOnceWith(options);
    expect(h.read).not.toHaveBeenCalled();
  });
  // #10301 回归(系统账号已登录 + 旧任务用内部 codex-home + symlink EPERM)。这条链路上
  // lazy create 抛的是「凭证连不上」而不是「没登录」,恢复入口(到模型供应商里重新连接)
  // 依赖这个 reason 一路活着到界面。这里同时钉住两件事:旧路由的隔离策略不被绕过(不注入
  // 账号),以及这个 reason 不被 AgentStartupStoppedError 的包装吃掉 —— 少任何一条,
  // 用户看到的就是一句没有出路的「回复未完成」。
  it('keeps the shared-link reason on a legacy-home resume instead of falling back to another account', async () => {
    h.pools.openai = { strategy: 'round', accounts: [account('default'), account('second')] };
    const start = vi.fn(async (_options: StartSessionOptions): Promise<never> => {
      throw new AgentNotAuthenticatedError('codex', 'codex not authenticated: codex_shared_auth_link_unavailable');
    });
    const agent = withSubscriptionAccounts({
      kind: 'codex',
      startSession: start,
    } as unknown as BaseAgent, { getState: h.legacyRead, resolveCodexHistoryHome: async () => '/unregistered-private-home' });
    const options = {
      providerId: 'openai',
      resumeSessionId: 'legacy',
      sessionId: 'old-task',
    } as StartSessionOptions;
    await expect(agent.startSession(options)).rejects.toThrow('codex_shared_auth_link_unavailable');
    // 旧路由照旧不注入账号:恢复走「重新连接」,不是换一个账号池里的账号。
    expect(start).toHaveBeenCalledExactlyOnceWith(options);
    expect(start.mock.calls[0]![0][NATIVE_SUBSCRIPTION_ACCOUNT]).toBeUndefined();
  });
});

// #10692: existing disabled-account cases persist task/native bindings first. These unit
// cases enter real pre-send recovery with only host-owned history metadata, then start
// through the production account wrapper; no credentials, disk history or native CLI are used.
describe('unbound Codex history account recovery', () => {
  function fixture() {
    h.pools.openai = { strategy: 'order', accounts: [account('second')],
      legacyCodexAccounts: { 'openai-old': 'imported' } };
    const row = { status: 'active', providerId: 'openai', agentKind: 'codex',
      model: 'gpt-6.1-sol', sdkSessionId: 'legacy' } as SessionRowSnapshot;
    const deps = {
      readSession: vi.fn(async () => row),
      isRunning: vi.fn(() => false),
      resolveCodexHistoryHome: vi.fn(async (): Promise<string | undefined> => 'openai/imported'),
      rebuild: vi.fn(async (_id: string, assertCurrent: () => void) => {
        assertCurrent();
        row.sdkSessionId = null;
      }),
    };
    return { row, deps };
  }
  it.each(['removed', 'paused'] as const)('hands off %s history before starting a fresh native session', async cause => {
    const { row, deps } = fixture();
    if (cause === 'paused') h.pools.openai!.accounts.push({ ...account('imported'), paused: true });
    const start = vi.fn(async (_options: StartSessionOptions) => ({ id: 'replacement-native', close: async () => {} }));
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: start } as unknown as BaseAgent,
      { getState: h.legacyRead, resolveCodexHistoryHome: deps.resolveCodexHistoryHome });
    // Original failure is produced by the actual allocator, not an injected startup error.
    await expect(agent.startSession({ providerId: 'openai', sessionId: 'old-task',
      resumeSessionId: 'legacy', model: row.model! } as StartSessionOptions)).rejects.toThrow('SUBSCRIPTION_ACCOUNT_UNAVAILABLE');
    expect(start).not.toHaveBeenCalled();
    expect(await prepareSubscriptionAccountForSend('old-task', deps)).toBe(true);
    expect(row.sdkSessionId).toBeNull();
    expect(deps.rebuild).toHaveBeenCalledOnce();
    expect(h.bindings.get('task:old-task')?.accountId).toBe('second');
    expect(h.bindings.has('native:legacy')).toBe(false);
    expect(h.pools.openai!.legacyCodexAccounts).toEqual({ 'openai-old': 'imported' });
    const handle = await agent.startSession({ providerId: row.providerId, sessionId: 'old-task',
      resumeSessionId: row.sdkSessionId ?? undefined, model: row.model! } as StartSessionOptions);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.calls[0][0].resumeSessionId).toBeUndefined();
    expect(start.mock.calls[0][0][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('openai/second');
    await handle.close();
    expect(await prepareSubscriptionAccountForSend('old-task', deps)).toBe(false);
    expect(deps.rebuild).toHaveBeenCalledOnce();
  });
  it.each(['healthy', 'unknown', 'new-task', 'bound', 'ssh', 'remote-agent', 'other-provider', 'other-engine'] as const)(
    'preserves existing routing when %s', async condition => {
      const { row, deps } = fixture();
      if (condition === 'healthy') h.pools.openai!.accounts.push(account('imported'));
      if (condition === 'unknown') deps.resolveCodexHistoryHome.mockResolvedValue('/unregistered-private-home');
      if (condition === 'new-task') row.sdkSessionId = null;
      if (condition === 'bound') h.bindings.set('task:old-task', { providerId: 'openai', accountId: 'second' });
      if (condition === 'ssh') row.remoteHostId = 'ssh-host';
      if (condition === 'remote-agent') row.agentDeviceId = 'other-computer';
      if (condition === 'other-provider') row.providerId = 'custom';
      if (condition === 'other-engine') row.agentKind = 'pi';
      const before = new Map(h.bindings);
      expect(await prepareSubscriptionAccountForSend('old-task', deps)).toBe(false);
      expect(deps.rebuild).not.toHaveBeenCalled();
      expect(h.bindings).toEqual(before);
      if (!['healthy', 'unknown'].includes(condition)) expect(deps.resolveCodexHistoryHome).not.toHaveBeenCalled();
    });
  it('does not overwrite a task rebound within the same provider while preparing the handoff', async () => {
    const { row, deps } = fixture();
    deps.rebuild.mockImplementation(async (_id, assertCurrent) => {
      h.bindings.set('task:old-task', { providerId: 'openai', accountId: 'second' });
      assertCurrent();
    });
    await expect(prepareSubscriptionAccountForSend('old-task', deps)).rejects.toThrow('account changed');
    expect(row.sdkSessionId).toBe('legacy');
    expect(h.bindings.get('task:old-task')?.accountId).toBe('second');
    expect(h.bindings.has('native:legacy')).toBe(false);
  });
  it.each(['lookup-failed', 'owner-changed', 'route-changed', 'busy', 'no-replacement', 'rebuild-failed'] as const)(
    'keeps old history and task ownership on %s', async failure => {
      const { row, deps } = fixture();
      if (failure === 'lookup-failed') deps.resolveCodexHistoryHome.mockRejectedValue(new Error('history unavailable'));
      if (failure === 'owner-changed' || failure === 'route-changed') deps.resolveCodexHistoryHome.mockImplementation(async () => {
        if (failure === 'owner-changed') h.owner = 'other-owner';
        else row.providerId = 'custom';
        return 'openai/imported';
      });
      if (failure === 'busy') deps.isRunning.mockReturnValue(true);
      if (failure === 'no-replacement') h.pools.openai!.accounts[0].paused = true;
      if (failure === 'rebuild-failed') deps.rebuild.mockRejectedValue(new Error('handoff failed'));
      await expect(prepareSubscriptionAccountForSend('old-task', deps)).rejects.toThrow();
      expect(row.sdkSessionId).toBe('legacy');
      expect(h.bindings.size).toBe(0);
      if (failure !== 'rebuild-failed') expect(deps.rebuild).not.toHaveBeenCalled();
    });
});

// Unit regression (2026-11-11): retry reused a disabled account despite another account
// having quota. Existing lease tests did not exercise pre-send context transfer.
// The production entry must change only task ownership after durable history recovery.
describe('disabled task account recovery before send', () => {
  async function fixture() {
    const original = await acquireSubscriptionAccount('anthropic', 'claude-model', []);
    await original!.bind(['task:task-a', 'native:native-a']);
    original!.release();
    h.pools.anthropic!.accounts[0].paused = true;
    const row = { status: 'active', providerId: 'anthropic', agentKind: 'cc',
      model: 'claude-model', sdkSessionId: 'native-a' } as SessionRowSnapshot;
    const deps = {
      readSession: vi.fn(async () => row),
      isRunning: vi.fn(() => false),
      rebuild: vi.fn(async (_id: string, assertCurrent: () => void) => {
        assertCurrent();
        row.sdkSessionId = null;
      }),
    };
    return { row, deps, original: original! };
  }
  it.each(['paused', 'removed'] as const)('moves a %s task to a usable account while retaining original native history ownership', async cause => {
    const { row, deps } = await fixture();
    if (cause === 'removed') h.pools.anthropic!.accounts.shift();
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(true);
    expect(row.sdkSessionId).toBeNull();
    expect(h.bindings.get('task:task-a')?.accountId).toBe('second');
    expect(h.bindings.get('native:native-a')?.accountId).toBe('default');
    const resumed = await acquireSubscriptionAccount('anthropic', row.model!, ['task:task-a']);
    expect(resumed?.account.configDir).toBe('anthropic/second');
    resumed?.release();
    await expect(acquireSubscriptionAccount('anthropic', row.model!, ['task:task-a', 'native:native-a']))
      .rejects.toThrow('account changed');
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(false);
    expect(deps.rebuild).toHaveBeenCalledOnce();
  });
  it('recovers an older Claude task whose original default home has no persisted binding', async () => {
    const { deps } = await fixture();
    h.bindings.clear();
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(true);
    expect(h.bindings.get('task:task-a')?.accountId).toBe('second');
    expect(h.bindings.has('native:native-a')).toBe(false);
  });
  it.each(['codex', 'cc', 'pi'])('uses the same account transfer for OpenAI %s tasks', async agentKind => {
    const { row, deps } = await fixture();
    row.providerId = 'openai';
    row.agentKind = agentKind;
    h.pools.openai = h.pools.anthropic;
    h.bindings.set('task:task-a', { providerId: 'openai', accountId: 'default' });
    h.bindings.set('native:native-a', { providerId: 'openai', accountId: 'default' });
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(true);
    expect(h.bindings.get('task:task-a')).toEqual({ providerId: 'openai', accountId: 'second' });
    expect(h.bindings.get('native:native-a')?.accountId).toBe('default');
  });
  it.each(['no-replacement', 'busy', 'rebuild-failed', 'owner-changed', 'target-disabled'] as const)('preserves the original binding on %s', async failure => {
    const { row, deps } = await fixture();
    if (failure === 'no-replacement') h.pools.anthropic!.accounts[1].paused = true;
    if (failure === 'busy') deps.isRunning.mockReturnValue(true);
    if (failure === 'rebuild-failed') deps.rebuild.mockRejectedValueOnce(new Error('disk full'));
    if (failure === 'owner-changed') deps.readSession.mockImplementationOnce(async () => { h.owner = 'other-owner'; return row; });
    if (failure === 'target-disabled') deps.rebuild.mockImplementationOnce(async (_id, assertCurrent) => {
      h.pools.anthropic!.accounts[1].paused = true;
      assertCurrent();
    });
    await expect(prepareSubscriptionAccountForSend('task-a', deps)).rejects.toThrow();
    expect(row.sdkSessionId).toBe('native-a');
    expect(h.bindings.get('task:task-a')?.accountId).toBe('default');
    expect(h.bindings.get('native:native-a')?.accountId).toBe('default');
    if (failure !== 'owner-changed')
      expect((await readSubscriptionPool('anthropic')).accounts.every(a => a.running === 0)).toBe(true);
  });
  it.each(['enabled', 'ssh', 'remote-agent', 'different-provider'] as const)('does not transfer a task when %s', async kind => {
    const { row, deps } = await fixture();
    if (kind === 'enabled') h.pools.anthropic!.accounts[0].paused = false;
    if (kind === 'ssh') row.remoteHostId = 'remote-host';
    if (kind === 'remote-agent') row.agentDeviceId = 'other-computer';
    if (kind === 'different-provider') row.providerId = 'custom';
    expect(await prepareSubscriptionAccountForSend('task-a', deps)).toBe(false);
    expect(deps.rebuild).not.toHaveBeenCalled();
    expect(h.bindings.get('task:task-a')?.accountId).toBe('default');
  });
  // Unit: an already-hosted default subscription can predate the first pool configuration.
  // Existing live-handle coverage creates the pool before startup, so it misses the legacy path.
  it.each((['openai', 'anthropic'] as const).flatMap(provider => [false, true].flatMap(implicit =>
    [false, true].map(clearProvider => ({ provider, implicit, clearProvider })))))(
    'honors first-time pause on a live unpooled $provider task (implicit=$implicit, clear=$clearProvider)', async ({ provider, implicit, clearProvider }) => {
    delete h.pools[provider];
    const send = vi.fn(async () => {});
    const agent = withSubscriptionAccounts({ kind: provider === 'openai' ? 'codex' : 'claude-code',
      startSession: async () => ({ id: 'unpooled-native', send, setModel: async () => {}, close: async () => {} }),
    } as unknown as BaseAgent, { getState: async () => ({ authenticated: true, authSource: 'oauth' }) });
    const handle = await agent.startSession({ ...(implicit ? {} : { providerId: provider }), sessionId: 'unpooled-task',
      deviceHosted: { workingDir: '/controller' },
    } as StartSessionOptions);
    await handle.send({ type: 'user', content: 'before' });
    // Clearing the explicit source still uses the native default login.
    if (clearProvider) await handle.setModel!(provider === 'openai' ? 'gpt-6' : 'claude-sonnet', { providerId: null });
    await runSubscriptionAccountCommand({ action: 'configure', providerId: provider, accountId: 'default', paused: true });
    await expect(handle.send({ type: 'user', content: 'paused' })).rejects.toThrow('disabled');
    expect(send).toHaveBeenCalledTimes(1);
    await runSubscriptionAccountCommand({ action: 'configure', providerId: provider, accountId: 'default', paused: false });
    await handle.send({ type: 'user', content: 'enabled' });
    expect(send).toHaveBeenCalledTimes(2);
    await handle.close();
  });
  it.each(['api-key', 'custom-default'] as const)('does not attach a subscription pause to an unpooled %s route', async source => {
    delete h.pools.openai;
    const send = vi.fn(async () => {});
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: async () => ({
      id: 'unpooled-api', send, close: async () => {},
    }) } as unknown as BaseAgent, {
      getState: async () => ({ authenticated: true, authSource: source === 'api-key' ? 'api-key' : 'oauth' }),
      resolveDefaultProvider: async () => source === 'custom-default' ? 'custom-api' : null,
    });
    const handle = await agent.startSession({ sessionId: 'unpooled-api' } as StartSessionOptions);
    expect(h.pools.openai).toBeUndefined();
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'default', paused: true });
    await handle.send({ type: 'user', content: 'api' });
    expect(send).toHaveBeenCalledTimes(1);
    await handle.close();
  });
  // A successful in-place source switch must track the newly selected subscription,
  // including callers retaining the handle's send function across that switch.
  it.each(['anthropic', 'custom-api'])('honors first-time pause after switching from %s to OpenAI', async initial => {
    delete h.pools.openai;
    delete h.pools.anthropic;
    const send = vi.fn(async () => {});
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async () => ({
      id: 'switch-subscription', send, setModel: async () => {}, close: async () => {},
    }) } as unknown as BaseAgent, { getState: async () => ({ authenticated: true, authSource: 'oauth' }) });
    const handle = await agent.startSession({ ...(initial === 'anthropic' ? {} : { providerId: initial }) } as StartSessionOptions);
    const sendNext = handle.send.bind(handle);
    await sendNext({ type: 'user', content: 'before' });
    await handle.setModel!('gpt-6', { providerId: 'openai' });
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'default', paused: true });
    await expect(sendNext({ type: 'user', content: 'paused' })).rejects.toThrow('disabled');
    expect(send).toHaveBeenCalledTimes(1);
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'default', paused: false });
    await sendNext({ type: 'user', content: 'enabled' });
    expect(send).toHaveBeenCalledTimes(2);
    await handle.close();
  });
  it('does not apply a later subscription pause to a handle already switched to an API provider', async () => {
    delete h.pools.openai;
    const send = vi.fn(async () => {});
    const agent = withSubscriptionAccounts({ kind: 'codex', startSession: async () => ({
      id: 'unpooled-switch', send, setModel: async () => {}, close: async () => {},
    }) } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'openai' } as StartSessionOptions);
    await handle.setModel!('custom-model', { providerId: 'custom-api' });
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'openai', accountId: 'default', paused: true });
    await handle.send({ type: 'user', content: 'api' });
    expect(send).toHaveBeenCalledTimes(1);
    await handle.close();
  });
  it('blocks the next send on an already-live handle after its account is disabled', async () => {
    const send = vi.fn(async () => {});
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async () => ({
      id: 'native-a', send, close: async () => {},
    }) } as unknown as BaseAgent);
    const handle = await agent.startSession({ providerId: 'anthropic', sessionId: 'task-a' } as StartSessionOptions);
    await runSubscriptionAccountCommand({ action: 'configure', providerId: 'anthropic', accountId: 'default', paused: true });
    await expect(handle.send({ type: 'user', content: 'continue' })).rejects.toThrow('disabled');
    expect(send).not.toHaveBeenCalled();
    await handle.close();
  });
});

// Integration (in-memory native/credential/storage boundaries, NOT real-device E2E).
// Bug: an unchanged A share retained a's native session after B merged into A;
// a was limited, b healthy, but the guest saw LAZY_CREATE_FAILED forever.
// Existing probe/relay tests isolated the receiver from actual account admission.
// Minimal input: one guest task, two distinct profiles, one terminal rate limit.
// This exercises the production transport, allocator, token receiver, group recovery,
// history relocation and fresh native open, including the first start-failed ordering.
// Standalone full-file validation: 405 cases / 6.35s wall (1.61s cases); most cost is module collection.
describe('shared subscription recovery through controller and account allocation', () => {
  it.each([
    { original: 'default', phase: 'run', boundary: 'none' },
    { original: 'default', phase: 'idle-send', boundary: 'none' },
    { original: 'second', phase: 'run', boundary: 'none' },
    { original: 'default', phase: 'run', boundary: 'all-run-limited' },
    { original: 'default', phase: 'cold', boundary: 'none' },
    { original: 'default', phase: 'auth-cold', boundary: 'none' },
    { original: 'default', phase: 'auth-send', boundary: 'none' },
    { original: 'default', phase: 'auth-send', boundary: 'no-spare' },
    { original: 'default', phase: 'auth-pending-start', boundary: 'none' },
    { original: 'default', phase: 'pre-pool', boundary: 'none' },
    { original: 'default', phase: 'pending-start', boundary: 'none' },
    { original: 'default', phase: 'cold', boundary: 'all-limited' },
    { original: 'second', phase: 'cold', boundary: 'old-share' },
    // 11-20 incident / #11081, unit: O has reclaimed its run and the pinned
    // Opus account is blocked. Drive the real starter, Session and coordinator
    // through the next send. The older cold case opens a new RunClient directly.
    // Native agent, credentials, persistence and wire delivery are fixtures.
    { original: 'second', phase: 'reconnect', boundary: 'none' },
    { original: 'second', phase: 'reconnect', boundary: 'edited-input' },
    { original: 'second', phase: 'reconnect', boundary: 'expired-host-token' },
    { original: 'second', phase: 'scheduled-reconnect', boundary: 'none' },
    { original: 'second', phase: 'legacy-reconnect', boundary: 'none' },
    { original: 'second', phase: 'reconnect', boundary: 'replacement-id-write-failed' },
    { original: 'second', phase: 'reconnect', boundary: 'boundary-write-failed' },
    { original: 'second', phase: 'reconnect', boundary: 'stop-during-open' },
    { original: 'second', phase: 'reconnect', boundary: 'new-input-during-open' },
    // Unit integration (in-memory IPC/transport): after the replacement open,
    // a second UI input at the real send's final fence must preserve FIFO.
    { original: 'second', phase: 'reconnect', boundary: 'registered-input-before-replay-rpc' },
    { original: 'second', phase: 'reconnect', boundary: 'stop-all-during-open' },
    { original: 'second', phase: 'reconnect', boundary: 'stop-all-after-id-write' },
    { original: 'second', phase: 'reconnect', boundary: 'all-limited' },
    // Unit (in-memory share directory): a retained execution route is not
    // current authorization to tear down this Session and claim a new run.
    { original: 'second', phase: 'reconnect', boundary: 'share-list-unknown' },
    { original: 'second', phase: 'reconnect', boundary: 'late-input' },
    { original: 'second', phase: 'reconnect', boundary: 'late-stop' },
    { original: 'second', phase: 'reconnect', boundary: 'late-route-change' },
    { original: 'second', phase: 'reconnect', boundary: 'late-revoke' },
    { original: 'second', phase: 'cold-weekly', boundary: 'none' },
    { original: 'default', phase: 'run', boundary: 'stopped' },
    { original: 'default', phase: 'run', boundary: 'revoked' },
  ] as const)('$phase: $original with $boundary', async ({ original, phase, boundary }) => {
    h.modelCacheRead.mockRejectedValue(Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' }));
    const a = 'anthropic-sub-aaaaaaaa';
    const b = 'anthropic-sub-bbbbbbbb';
    const weekly = phase.endsWith('reconnect') || phase === 'cold-weekly';
    const nextInputDuringOpen = boundary === 'new-input-during-open';
    const nextInputBeforeReplayRpc = boundary === 'registered-input-before-replay-rpc';
    let reachedReplayRpc!: () => void;
    let releaseReplayRpc!: () => void;
    const replayRpcReady = new Promise<void>(resolve => { reachedReplayRpc = resolve; });
    const replayRpcGate = new Promise<void>(resolve => { releaseReplayRpc = resolve; });
    let finishReplayTurn!: () => void;
    const replayTurnGate = new Promise<void>(resolve => { finishReplayTurn = resolve; });
    const supersededDuringOpen = nextInputDuringOpen || boundary === 'stop-during-open' || boundary === 'stop-all-during-open';
    const stopAfterIdWrite = boundary === 'stop-all-after-id-write';
    let receivedReplacementOpen!: () => void;
    let finishReplacementOpen!: () => void;
    const replacementOpened = new Promise<void>(resolve => { receivedReplacementOpen = resolve; });
    const replacementReply = new Promise<void>(resolve => { finishReplacementOpen = resolve; });
    const delayedOffer = boundary.startsWith('late-');
    let recoveryAllowed = true;
    let shareListKnown = boundary !== 'share-list-unknown';
    const published = weekly ? 'anthropic' : boundary === 'old-share' ? b : a;
    const nextAccount = original === 'default' ? 'second' : 'default';
    const model = weekly ? 'claude-opus-5-5' : 'claude-sonnet-5-5';
    const task = `guest-${phase}-${original}-${boundary}`;
    const peer = weekly ? providerShareGuestPeer('fixture-share', 'fixture-member', 'fixture-laptop') : 'share-test-guest';
    const route = 'share:isolated-test';
    h.pools.anthropic = { strategy: 'order', accounts: [account('default'), account('second')].map(entry => ({ ...entry, limit: 4 })) };
    if (!weekly) h.created[a] = { kind: 'anthropic', name: 'A', account: 'default' };
    h.created[b] = { kind: 'anthropic', name: 'B', account: 'second' };
    h.placement['anthropic:default'] = published === 'anthropic' ? 'anthropic' : a;
    h.placement['anthropic:second'] = published === 'anthropic' ? 'anthropic' : a;
    h.read.mockImplementation(async (_kind: string, dir: string) => ({ authenticated: true, identity: dir }));
    const row: AgentSwitchSessionRow = { id: task, status: 'active', agentKind: 'cc', model,
      providerId: published, agentDeviceId: route, remoteHostId: null, orcaRole: null, sdkSessionId: null };
    const guestSwitch = createProviderGroupGuestSwitch();
    const wireOrder: string[] = [];
    const starts: StartSessionOptions[] = [];
    const received: unknown[] = [];
    const events: AgentEvent[] = [];
    const clients: RemoteAgentRunClient[] = [];
    const limited = new Set<string>();
    let authorized = true;
    let confirmStopped!: () => void;
    const whenStopped = new Promise<void>(resolve => { confirmStopped = resolve; });
    let probeEntered!: () => void;
    let resolveProbe: (() => void) | undefined;
    const probeGate = new Promise<void>(resolve => { probeEntered = resolve; });
    let nativeSequence = 0;
    const pendingStart = phase === 'pending-start' || phase === 'auth-pending-start';
    const agent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async (options: StartSessionOptions) => {
      starts.push(options);
      if (phase === 'auth-cold' && options.resumeSessionId) throw new AgentNotAuthenticatedError('claude-code');
      if (phase === 'auth-pending-start') throw new AgentStartupCleanupPendingError('not authenticated', { cause: 'not authenticated', whenStopped });
      if (phase === 'pending-start') throw new AgentStartupCleanupPendingError('usage limit exceeded', { cause: 'usage limit exceeded', whenStopped });
      const id = `isolated-native-${++nativeSequence}`;
      const queue: AgentEvent[] = [];
      let ended = false;
      let wake: (() => void) | undefined;
      const emit = (event: AgentEvent) => { queue.push(event); wake?.(); wake = undefined; };
      return { id, agentKind: 'claude-code', model, setInteractionResolver() {}, abort: async () => {},
        send: async (message: unknown) => {
          received.push(message);
          const dir = options[NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir ?? 'anthropic/default';
          if (phase !== 'idle-send' || !limited.size) emit({ type: 'text', data: { text: 'native started this turn' } } as AgentEvent);
          const terminal = limited.has(dir.split('/').at(-1)!)
            ? { type: 'error', data: { sdkError: 'rate_limit', message: 'usage limit exceeded', isTerminal: true } } as AgentEvent
            : { type: 'done', data: {} } as AgentEvent;
          if (nextInputBeforeReplayRpc && dir.endsWith('/default') && received.length === 2) {
            void replayTurnGate.then(() => emit(terminal));
          } else {
            emit(terminal);
          }
        },
        close: async () => { ended = true; wake?.(); },
        events: async function* () {
          while (!ended) {
            if (queue.length) yield queue.shift()!;
            else await new Promise<void>(resolve => { wake = resolve; });
          }
        },
      } as unknown as AgentSessionHandle;
    } } as unknown as BaseAgent);
    let hostNow = Date.now();
    const probeResults: boolean[] = [];
    const host = createRemoteAgentHost({
      runsRoot: '/synthetic-shared-pool-integration', isAgentAvailable: () => true,
      ...(weekly ? { now: () => hostNow, readLimits: () => ({ perDevice: 16, total: 64, idleMinutes: 1 }) } : {}),
      isControllerAuthorized: () => authorized, controllerTrust: () => 'guest',
      providerAccess: { resolve: async () => published, isAllowed: () => authorized },
      bindGuestProviderRoute: async () => ({ routeToken: 'synthetic-route', modelIds: [model], release() {} }),
      captureOwner: () => h.owner, isOwnerCurrent: owner => owner === h.owner,
      canSwitchLocalAccount: async input => {
        if (delayedOffer || boundary === 'stopped' || boundary === 'revoked') {
          probeEntered();
          await new Promise<void>(resolve => { resolveProbe = resolve; });
        }
        const available = await canSwitchHostedSubscriptionAccount(input.providerId, input.hostSessionId, input.model);
        probeResults.push(available);
        return available;
      },
      groupRelay: { plan: async () => null, connect: () => { throw new Error('no remote group member'); },
        noteStartFailure: () => false, noteRunFailure: () => false,
        trackRun: () => ({ setRunning() {}, release() {} }), forget: async () => {} },
      startHosted: input => agent.startSession({ ...input.options, sessionId: input.hostSessionId,
        workingDir: input.shadowDir, deviceHosted: { ...input.workspace, guest: true } } as StartSessionOptions),
    });
    const opens: RemoteAgentOpenPayload[] = [];
    let sendCalls = 0;
    const poller = new RemoteAgentPoller(async (args, invokeOptions) => {
      const request = JSON.parse(JSON.stringify(args[0]));
      if (nextInputBeforeReplayRpc && opens.length === 3 && sendCalls === 1
        && request.op === 'call' && request.method === 'send') {
        expect(invokeOptions?.beforeDispatch).toBeTypeOf('function');
        reachedReplayRpc();
        await replayRpcGate;
      }
      invokeOptions?.beforeDispatch?.();
      if (request.op === 'open') {
        opens.push(request.payload.json);
        if (boundary === 'expired-host-token' && request.payload.json.groupSwitchToken) {
          // Advance only O's clock after G claims the offer. The real host
          // ignores the expired token and opens normally, as in #11081.
          hostNow += GROUP_SWITCH_TOKEN_TTL_MS + 1;
        }
      }
      if (request.op === 'call' && request.method === 'send') sendCalls++;
      const response = await host.handle(peer, request);
      if (supersededDuringOpen && opens.length === 3 && request.op === 'open' && request.payload.json.groupSwitchToken) {
        receivedReplacementOpen();
        await replacementReply;
      }
      return JSON.parse(JSON.stringify(response ?? null));
    });
    let active!: RemoteAgentRunClient;
    let remoteHandle: AgentSessionHandle | undefined;
    let guestSession: Session | undefined;
    const guestLog: Logger = {
      trace() {}, debug() {}, info: vi.fn(), warn: vi.fn(), error() {}, fatal() {}, child: () => guestLog,
    };
    const openRemote = async (resumeSessionId?: string) => {
      remoteHandle = await startRemoteAgentSession('claude-code', {
        sessionId: task, workingDir: '/controller/work', model, providerId: published, resumeSessionId,
      }, {
        poller, invoke: poller.invoke, rgPath: 'rg', newId: randomUUID, log: guestLog,
        recoverSharedReconnect: true,
        prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
        collectProjectFiles: async () => [], isGitRepo: async () => false,
        groupSwitch: { token: guestSwitch.takeForOpen(task), offer: token => {
          wireOrder.push('token'); guestSwitch.offer(task, token);
        } },
      });
      row.sdkSessionId = remoteHandle.id;
      guestSwitch.release(task);
      return remoteHandle;
    };
    let handoff = '';
    const open = async (resume?: string) => {
      active = new RemoteAgentRunClient(randomUUID(), poller, {
        onEvent: event => { events.push(event as AgentEvent); wireOrder.push((event as AgentEvent).type); },
        onState: state => takeGroupSwitchState(state, token => { wireOrder.push('token'); guestSwitch.offer(task, token); }),
        onRequest: async () => ({ type: 'callback', value: undefined }), onWs() {}, onClosed() {},
      }, randomUUID);
      clients.push(active);
      try {
        const result = await active.open('claude-code', { sessionId: task, virtualWorkspace: true,
          options: { model, providerId: published, ...(resume ? { resumeSessionId: resume } : {}) },
          acceptsGroupSwitch: true, ...(guestSwitch.takeForOpen(task) ? { groupSwitchToken: guestSwitch.takeForOpen(task) } : {}),
          workspace: { workingDir: '/controller/work', platform: 'darwin', shell: 'bash' },
          projectFiles: [], ancestorFiles: [], personal: { files: [] }, mcpServers: [] });
        row.sdkSessionId = result.id as string;
        guestSwitch.release(task);
      } catch (error) { wireOrder.push('start-failed'); throw error; }
    };
    const relocate = async (isCurrent = () => true, deferSharedCommit?: true) => {
      expect(isCurrent()).toBe(true);
      if (!weekly) await active.close('close', 'navigation');
      const relocated = await relocateForFreshStart({
        getSessionRow: async () => ({ ...row }),
        listMessagesForHandoff: async () => [{ role: 'user', content: 'Keep the codeword PINEAPPLE-42.', createdAt: 1 },
          { role: 'assistant', content: 'Previous work is complete; continue remaining work.', createdAt: 2 }],
        applyAgentSwitchToDb: async (_id, patch) => { Object.assign(row, patch); }, setSessionProvider() {},
        insertBoundaryMessage: async () => 'boundary', setPendingHandoff: (_id, text) => { handoff = text; },
        applyResumeFallbackAtomically: async () => {}, log: { info() {}, warn() {} },
      }, { sessionId: task, agentDeviceId: route, providerId: published, sharedRelocation: true, deferSharedCommit,
        assertCurrent: () => { if (!isCurrent()) throw new Error('superseded'); } });
      expect(relocated.nativeId).toBeNull();
      if (!deferSharedCommit) expect(row.sdkSessionId).toBeNull();
      return relocated;
    };
    const continueSession = vi.fn(async () => {
      if (weekly) {
        const fresh = await openRemote();
        const message = prependHandoffToUserMessage('Continue remaining work.', handoff);
        if (typeof message !== 'string') throw new Error('Expected a text handoff');
        await fresh.send({ type: 'user', content: message });
        for await (const event of fresh.events()) {
          events.push(event);
          if (event.type === 'done') break;
        }
        return 'resumed' as const;
      }
      await open();
      await active.call('send', [prependHandoffToUserMessage({ type: 'user', content: 'Continue remaining work.' }, handoff)]);
      return 'resumed' as const;
    });
    const fallback = vi.fn();
    const directory = createProviderGroupDirectory({ listLocalProviders: async () => [], localDeviceName: () => 'guest',
      listDevices: async () => [], readDeviceProviders: async () => [], listReceivedShares: () => [],
      isMobilePlatform: () => false, now: Date.now });
    const router = createProviderGroupRouter({ directory, readGroup: () => null, listBindings: () => ({}),
      isTurnRunning: () => false, now: Date.now, random: () => 0 });
    const service = createProviderGroupService({ router, directory, readGroup: () => null,
      readBinding: () => null, writeBinding: async () => {}, isReleased: () => false, markReleased: async () => {},
      readSessionRow: async () => ({ ...row, agentDeviceId: row.agentDeviceId ?? null, agentKind: 'claude-code' }), resolveImplicitProvider: async () => published,
      persistRoute: async () => {}, hasAssistantHistory: async () => true, isFailoverEligible: async () => true,
      leaseRecovery: () => ({}), isLeaseCurrent: () => true, rearmContinue: () => 2, cancelContinue() {},
      switchAgentLocation: async (_id, _route, opts) => { await relocate(opts?.isCurrent); },
      isTurnRunning: () => false, hasLiveSession: () => true, continueSession, fallback,
      readResetAt: () => null, now: Date.now, sleep: async () => {}, guestSwitch, log: { info() {}, warn() {} },
    });
    if (weekly) vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      // Created-share binding is derived using the real host's same identity function.
      const hostTask = hostSessionIdFor(peer, task);
      if (phase !== 'pre-pool') h.bindings.set(`task:${hostTask}`, {
        providerId: 'anthropic', accountId: original, ...(weekly ? {} : { via: published }),
      });
      else delete h.pools.anthropic;
      if (weekly) {
        const originalHandle = await openRemote();
        const oldNative = originalHandle.id;
        guestSession = new Session({ id: task, agentKind: 'claude-code', permissionMode: 'bypassPermissions', workDir: '/controller/work',
          agentDeviceId: route, handle: originalHandle, capabilities: {} as never, logger: guestLog });
        const session = guestSession;
        const settled = new Promise<void>(resolve => session.onEvent(event => { if (event.type === 'done') resolve(); }));
        await session.send('Keep the codeword PINEAPPLE-42.');
        await settled;

        hostNow += 61_000;
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(() => expect(guestLog.info).toHaveBeenCalledWith(
          'remote agent connection released by the other computer', expect.any(Object)));
        expect(host.limitUsage().total).toBe(0);
        hostNow += 13 * 60 * 60_000;
        await vi.advanceTimersByTimeAsync(5_000);
        vi.mocked(guestLog.info).mockClear();

        const resetAtMs = Date.now() + 3 * 86_400_000;
        const exhausted = await acquireSubscriptionAccount(published, model, [], true, { accountId: original, remote: true });
        expect(exhausted!.observeFailure({ sdkError: 'rate_limit', usageResetAt: resetAtMs }, model, 'run')).toBe(true);
        exhausted!.release();
        h.usage.mockImplementation(async (_kind: string, dir: string) => ({ claudeUsage: {
          updatedAt: Date.now(), fiveHour: dir.endsWith('/second') ? null : { utilization: 11, resetsAt: Date.now() / 1000 + 3600 },
          sevenDay: { utilization: dir.endsWith('/second') ? 100 : 3, resetsAt: resetAtMs / 1000 },
          scoped: [{ utilization: 0, resetsAt: resetAtMs / 1000, modelDisplayName: 'Fable', modelId: null }],
        } }));
        await refreshSubscriptionPool(published, true);
        const view = await readSubscriptionSessionAccount('anthropic',
          { sessionId: hostTask, model, routeProviderId: published }, { remote: true });
        expect(view).toMatchObject({ state: 'bound', account: { blocked: true, switchAvailable: true, status: 'limited' } });
        expect(view).not.toHaveProperty('replacementProviderId');

        let live: Session | undefined = session;
        session.onStatusChange(status => {
          if (status === 'closed' && live === session) live = undefined;
        });
        const persisted: string[] = [];
        const persistedError = vi.fn();
        const onUsageLimitedTurnError = vi.fn();
        const bootstrapped = vi.fn();
        if (boundary === 'all-limited') {
          const spare = await acquireSubscriptionAccount(published, model, [], true, { accountId: nextAccount, remote: true });
          expect(spare!.observeFailure({ sdkError: 'rate_limit', usageResetAt: resetAtMs }, model, 'run')).toBe(true);
          spare!.release();
        }
        if (phase === 'cold-weekly') {
          await session.close();
          live = undefined;
        }
        let coordinator: AgentInputCoordinator;
        let holdEditedInput = boundary === 'edited-input';
        const attach = (current: Session) => {
          current.onEvent(event => {
            events.push(event);
            if (event.type === 'done') coordinator.onTurnEvent(task, 'done', undefined, undefined, event);
          });
        };
        const insertBoundary = vi.fn(async (_id: string, _body: unknown, options: { beforePublish(): Promise<void> }) => {
          await options.beforePublish();
          if (boundary === 'boundary-write-failed') throw new Error('Synthetic handoff write failure');
          return { id: 'boundary' };
        });
        const history = () => [
          { role: 'user', content: 'Keep the codeword PINEAPPLE-42.', createdAt: 1 },
          { role: 'assistant', content: 'Previous work is complete; continue remaining work.', createdAt: 2 },
          ...persisted.map(clientId => ({ role: 'user', content: 'Continue.', clientId, createdAt: 3 })),
        ];
        const stopAllHandlers = new Map<string, IpcHandler>();
        const maker = {
          getSession: () => live,
          closeSession: async () => { await live?.close(); live = undefined; },
          closeSessionIfCurrent: async (current: Session) => {
            if (live !== current || !await current.closeIfIdle()) return 'busy';
            live = undefined;
            return 'closed';
          },
        };
        const wiring = sharedAccountRegisterWiring({
          maker,
          persistAndHydrateSessionProvider: async () => {
            if (stopAfterIdWrite && opens.length === 3) {
              receivedReplacementOpen();
              await replacementReply;
            }
          },
          providerGroupService: service,
          providerShareAccessEpoch: () => recoveryAllowed ? 0 : 1,
          // Keep the old execution lookup available even when the current
          // directory is missing the share, as with a retained Agent Net route.
          findReceivedShareForExecution: () => ({ status: authorized ? 'active' : 'revoked' }),
          findReceivedShare: () => shareListKnown ? { status: authorized ? 'active' : 'revoked' } : null,
          getProviderGroupGuestSwitch: () => guestSwitch,
          getSessionRowSnapshotStrict: async () => ({ ...row, clearedAt: null }),
          setSdkSessionId: id => { row.sdkSessionId = id; },
          listMessagesForAgentHandoff: async () => history(),
          createDbMessage: insertBoundary,
          agentSwitchDeps: {
            getSessionRow: async () => ({ ...row }),
            listMessagesForHandoff: async () => history(),
            applyAgentSwitchToDb: async (_id: string, patch: object) => { Object.assign(row, patch); },
            setSessionProvider() {},
            insertBoundaryMessage: async () => 'cold-boundary',
            setPendingHandoff: (_id: string, note: string) => { handoff = note; },
            log: guestLog,
          },
          createSessionWithRuntimePlugins: async (opts: StartSessionOptions) => {
            const handle = await openRemote(opts.resumeSessionId);
            if (boundary === 'replacement-id-write-failed') {
              row.sdkSessionId = oldNative;
              await handle.close({ reason: 'navigation' });
              throw new Error('Synthetic native ID write failure');
            }
            live = guestSession = new Session({ id: task, agentKind: 'claude-code', permissionMode: 'bypassPermissions',
              workDir: '/controller/work', agentDeviceId: route, handle, capabilities: {} as never, logger: guestLog });
            attach(live);
            return live;
          },
        });
        registerSharedAccountStopAll({
          createElectronIpcHandlerRegistry: () => ({ handle: (channel: string, handler: IpcHandler) => stopAllHandlers.set(channel, handler) }),
          registerStopSessionBackgroundTasksHandler, maker, providerGroupService: service,
          clearClaudeSessionBackgroundActivity() {}, resetAutomaticRecoveryForExplicitStop() {}, pauseGoalBeforeExplicitStop() {},
        });
        const { sendToAgentAccepted } = sharedAccountSendTransaction({
          ...wiring,
          getSession: () => live,
          readScheduledPermissions: async () => ({ permissionMode: 'bypassPermissions', planModeEnabled: false }),
          peekPendingHandoff: async () => handoff || null,
          consumePendingHandoff: () => { handoff = ''; },
          createDbMessage: async (_id, msg) => { persisted.push(msg.clientId); },
          reconcileCreateOptsWithDb: async (_id, opts) => {
            opts.agentDeviceId = route;
            opts.providerId = published;
            opts.resumeSessionId = row.sdkSessionId ?? undefined;
          },
          bootstrapSession: async (...args) => {
            bootstrapped();
            return wiring.bootstrapSession(...args);
          },
        });
        if (phase === 'legacy-reconnect') {
          const handlers = new Map<string, IpcHandler>();
          registerMakerSessionSendHandler({ handle: (channel, handler) => handlers.set(channel, handler) }, {
            sendToAgentAccepted: (id, message, opts, sendOptions) => sendToAgentAccepted(id, message, opts, sendOptions),
          });
          await expect(handlers.get(MAKER_INVOKE.SEND)!(null, task, 'Continue.')).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LIMITED');
          expect(guestSwitch.hasOffer(task)).toBe(true);
          expect(wireOrder).toEqual(['token']);
          expect(opens).toHaveLength(2);
          expect(sendCalls).toBe(1);
          expect(received).toHaveLength(1);
          expect(bootstrapped).not.toHaveBeenCalled();
          return;
        }
        const send = vi.fn<AgentInputCoordinatorDeps['sendToAgent']>(async (...args) =>
          (await sendToAgentAccepted(...args)).outcome);
        coordinator = new AgentInputCoordinator({
          sendToAgent: send, steerToAgent: async () => {}, abortSession: async () => {},
          touchUserSend: async () => {}, createUserMessage: vi.fn(),
          isTurnRunning: () => holdEditedInput || (live?.isTurnRunning() ?? false), hasPendingInteraction: () => false,
          getAgentKind: () => 'claude-code', getSdkSessionId: async () => live?.sdkSessionId,
          getTurnGeneration: () => live?.getTurnGeneration() ?? null, getTurnSessionIdentity: () => live ?? null,
          emitProjection: () => {}, persistTerminalSendError: persistedError, onUsageLimitedTurnError,
        });
        const registeredInput = nextInputBeforeReplayRpc ? createInputEnqueueHarness(coordinator, { remote: false }) : undefined;
        const inputItem = (clientId: string, body: string) => ({
          clientId, text: body, persistedContent: body, model, effort: 'medium',
          permissionMode: 'default', workingDir: '/controller/work',
          createOpts: { agentKind: 'claude-code', model, workingDir: '/controller/work', permissionMode: 'bypassPermissions' },
          ...(phase === 'scheduled-reconnect' ? {
            origin: { kind: 'scheduler', scheduleId: 'fixture-schedule', scheduleName: 'Fixture', runId: 'fixture-run' },
          } : {}),
          chatMessage: { clientId, role: 'user', content: body, isStreaming: false, createdAt: new Date().toISOString() },
        }) satisfies Parameters<AgentInputCoordinator['enqueue']>[1];
        const enqueue = (clientId: string, body: string) => coordinator.enqueue(task, inputItem(clientId, body), {
          manualUiSend: phase !== 'scheduled-reconnect',
        });
        if (registeredInput) await registeredInput.enqueue({}, task, inputItem('after-idle', 'Continue.'));
        else enqueue('after-idle', 'Continue.');
        if (holdEditedInput) {
          expect(send).not.toHaveBeenCalled();
          coordinator.updateText(task, 'after-idle', 'Continue the edited input.');
          holdEditedInput = false;
          coordinator.resume(task);
        }
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        if (registeredInput) {
          try {
            await Promise.race([
              replayRpcReady,
              send.mock.results[0].value.then(() => { throw new Error('Expected recovery to reach the send RPC'); }),
            ]);
            expect(opens).toHaveLength(3);
            expect(opens[2]).toHaveProperty('groupSwitchToken', expect.any(String));
            expect(insertBoundary).toHaveBeenCalledOnce();
            const queued = await registeredInput.enqueue({}, task, inputItem('next-input', 'Send after the recovered input.'));
            expect(queued.pendingQueue.map(item => item.clientId)).toEqual(['next-input']);
            expect(send).toHaveBeenCalledOnce();
            expect(sendCalls).toBe(1);
            expect(received).toHaveLength(1);
          } finally {
            releaseReplayRpc();
          }
          try {
            // The send ACK arrives while the recovered turn is still running.
            await expect(send.mock.results[0].value).resolves.toMatchObject({ dispatched: true });
            expect(send).toHaveBeenCalledOnce();
            expect(sendCalls).toBe(2);
            expect(received).toHaveLength(2);
            expect(coordinator.getProjection(task).pendingQueue.map(item => item.clientId)).toEqual(['next-input']);
          } finally {
            finishReplayTurn();
          }
          await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
          await expect(send.mock.results[1].value).resolves.toMatchObject({ dispatched: true });
          await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(2));
          expect(opens).toHaveLength(3);
          expect(persisted).toEqual(['after-idle', 'next-input']);
          expect(sendCalls).toBe(3);
          expect(received.slice(1)).toEqual([
            expect.objectContaining({ content: expect.stringContaining('Continue.') }),
            expect.objectContaining({ content: 'Send after the recovered input.' }),
          ]);
          expect(JSON.stringify(received[1])).toContain('PINEAPPLE-42');
          expect(persistedError).not.toHaveBeenCalled();
          return;
        }
        if (boundary === 'replacement-id-write-failed' || boundary === 'boundary-write-failed') {
          await expect(send.mock.results[0].value).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LIMITED');
          expect(opens).toHaveLength(3);
          expect(opens[2]).toHaveProperty('groupSwitchToken', expect.any(String));
          expect(insertBoundary).toHaveBeenCalledTimes(boundary === 'boundary-write-failed' ? 1 : 0);
          expect(row.sdkSessionId).toBe(oldNative);
          expect(live).toBeUndefined();
          expect(guestSwitch.takeForOpen(task)).toBeUndefined();
          expect(handoff).toBe('');
          expect(received).toHaveLength(1);
          expect(sendCalls).toBe(1);
          expect(persisted).toEqual(['after-idle']);
          return;
        }
        if (supersededDuringOpen || stopAfterIdWrite) {
          const firstSend = send.mock.results[0].value as Promise<unknown>;
          const settled = Promise.allSettled([firstSend]);
          try {
            await Promise.race([replacementOpened, firstSend.then(() => { throw new Error('Expected replacement open'); })]);
            expect(opens[2].groupSwitchToken).toEqual(expect.any(String));
            expect(wireOrder).toEqual(['token']);
            if (stopAfterIdWrite) expect(row.sdkSessionId).not.toBe(oldNative);
            if (nextInputDuringOpen) {
              enqueue('next-input', 'Send the next input.');
              // The next user's input releases G's old send even before O replies.
              await settled;
            } else if (boundary !== 'stop-during-open') {
              await expect(stopAllHandlers.get(MAKER_INVOKE.STOP_SESSION_BACKGROUND_TASKS)!(null, task)).resolves.toEqual({ ok: true });
            } else {
              coordinator.stop(task);
            }
          } finally {
            finishReplacementOpen();
          }
          await settled;
          expect(live).toBeUndefined();
          expect(row.sdkSessionId).toBe(oldNative);
          expect(insertBoundary).not.toHaveBeenCalled();
          expect(handoff).toBe('');
          expect(guestSwitch.hasOffer(task)).toBe(false);
          expect(guestSwitch.takeForOpen(task)).toBeUndefined();
          expect(sendCalls).toBe(1);
          expect(received).toHaveLength(1);
          if (!nextInputDuringOpen) enqueue('next-input', 'Send the next input.');
          await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
          const followUp = await send.mock.results[1].value.catch((error: unknown) => error);
          // O may already have rebound the task before the cancellation reached G.
          // The ordinary follow-up still uses the original history and no old token.
          expect(h.bindings.get(`task:${hostTask}`)?.accountId).toBe(nextAccount);
          expect(opens).toHaveLength(4);
          expect(opens[3].options.resumeSessionId).toBe(oldNative);
          expect(opens[3]).not.toHaveProperty('groupSwitchToken');
          expect(followUp).toMatchObject({
            accepted: false, code: 'LAZY_CREATE_FAILED', message: 'The task subscription account changed',
          });
          expect(sendCalls).toBe(1);
          expect(received).toHaveLength(1);
          expect(insertBoundary).not.toHaveBeenCalled();
          expect(persisted).toEqual(['after-idle']);
          if (boundary === 'stop-all-after-id-write') {
            // Unit regression for the cancelled-handoff window: exercise the
            // provider picker IPC and apply its real deferred route intents.
            // The intermediate local provider is only selected, not run.
            await vi.advanceTimersByTimeAsync(120_000);
            expect(send).toHaveBeenCalledTimes(2);
            expect(opens).toHaveLength(4);
            const manualBoundaries: string[] = [];
            const pendingSwitches = createPendingAgentSwitchRegistry();
            const switchDeps: MakerSessionAgentSwitchHandlerDeps = {
              pendingSwitches,
              getSessionRow: async () => ({ ...row }),
              getLiveSession: () => live,
              closeSession: maker.closeSession,
              listMessagesForHandoff: async () => history(),
              applyAgentSwitchToDb: async (_id, patch) => { Object.assign(row, patch); },
              setSessionProvider() {},
              insertBoundaryMessage: async (_id, note) => {
                manualBoundaries.push(note.toProviderId!);
                return `manual-switch-${manualBoundaries.length}`;
              },
              applyResumeFallbackAtomically: async () => { throw new Error('Unexpected parked-history fallback'); },
              setPendingHandoff: (_id, note) => { handoff = note; },
              bootstrapSwitchedSession: async () => { throw new Error('Expected lazy startup on send'); },
              withCloseSuppressed: async (_id, run) => run(),
              log: guestLog,
            };
            registerMakerSessionAgentSwitchHandler({
              handle: (channel, handler) => stopAllHandlers.set(channel, handler),
            }, switchDeps);
            const selectProvider = stopAllHandlers.get(MAKER_INVOKE.SWITCH_SESSION_AGENT)!;
            await expect(selectProvider(null, task, 'claude-code', model, 'xd', undefined, undefined,
              { agentDeviceId: null })).resolves.toMatchObject({ deferred: true });
            await applyPendingAgentSwitchIfIdle(switchDeps, task);
            expect(row).toMatchObject({ providerId: 'xd', agentDeviceId: null, sdkSessionId: null });
            await expect(selectProvider(null, task, 'claude-code', model, published, undefined, undefined,
              { agentDeviceId: route })).resolves.toMatchObject({ deferred: true });
            await applyPendingAgentSwitchIfIdle(switchDeps, task);
            expect(row).toMatchObject({ providerId: published, agentDeviceId: route, sdkSessionId: null });

            const doneEvents = events.filter(event => event.type === 'done').length;
            enqueue('after-manual-switch', 'Send after switching back.');
            await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
            await expect(send.mock.results[2].value).resolves.toMatchObject({ dispatched: true });
            await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(doneEvents + 1));
            expect(opens).toHaveLength(5);
            expect(opens[4].options.resumeSessionId).toBeUndefined();
            expect(opens[4]).not.toHaveProperty('groupSwitchToken');
            expect(received).toHaveLength(2);
            expect(received.at(-1)).toMatchObject({ content: expect.stringContaining('Send after switching back.') });
            expect(starts.at(-1)?.[NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/default');
            expect(sendCalls).toBe(2);
            expect(persisted).toEqual(['after-idle', 'after-manual-switch']);
            expect(manualBoundaries).toEqual(['xd', published]);
          }
          return;
        }
        if (delayedOffer) {
          await probeGate;
          if (boundary === 'late-stop') coordinator.stop(task);
          else if (boundary === 'late-input') enqueue('new-input', 'Use my latest instructions.');
          else recoveryAllowed = false;
          resolveProbe!();
          if (boundary === 'late-stop') {
            await expect(send.mock.results[0].value).resolves.toMatchObject({ dispatched: false });
          } else if (boundary === 'late-input') {
            await expect(send.mock.results[0].value).rejects.toMatchObject({ name: 'AbortError' });
          } else {
            await expect(send.mock.results[0].value).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LIMITED');
          }
          expect(bootstrapped).not.toHaveBeenCalled();
          expect(sendCalls).toBe(1);
          expect(probeResults).toEqual([true]);
          expect(guestSwitch.hasOffer(task)).toBe(false);
          return;
        }
        if (boundary === 'share-list-unknown') {
          await expect(send.mock.results[0].value).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LIMITED');
          await vi.waitFor(() => expect(persistedError).toHaveBeenCalledWith(task, expect.stringContaining('SUBSCRIPTION_ACCOUNT_LIMITED')));
          expect(live).toBe(session);
          expect(session.getStatus()).toBe('active');
          expect(bootstrapped).not.toHaveBeenCalled();
          expect(insertBoundary).not.toHaveBeenCalled();
          expect(opens).toHaveLength(2);
          expect(sendCalls).toBe(1);
          expect(received).toHaveLength(1);
          expect(probeResults).toEqual([true]);
          expect(guestSwitch.hasOffer(task)).toBe(false);

          shareListKnown = true;
          // The refused attempt still used O's one local offer for this round.
          // Advance O's clock past that existing budget, without asking it for a refresh.
          hostNow += 31 * 60_000;
          // The normal rejected-send drain can retire the old runtime. This is
          // independent of the recovery path, which must not close it itself.
          await vi.waitFor(() => expect(live).toBeUndefined());
          enqueue('after-directory-recovery', 'Proceed after the directory recovers.');
          await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
          await expect(send.mock.results[1].value).resolves.toMatchObject({ dispatched: true });
          expect(bootstrapped).toHaveBeenCalledOnce();
          expect(opens).toHaveLength(4);
          expect(opens[2].options.resumeSessionId).toBe(oldNative);
          expect(opens[3].groupSwitchToken).toEqual(expect.any(String));
          expect(opens[3].options.resumeSessionId).toBeUndefined();
          expect(sendCalls).toBe(2);
          expect(persisted).toEqual(['after-idle', 'after-directory-recovery']);
          expect(JSON.stringify(received.at(-1))).toContain('Proceed after the directory recovers.');
          expect(JSON.stringify(received.at(-1))).toContain('PINEAPPLE-42');
          return;
        }
        if (boundary === 'all-limited') {
          await vi.waitFor(() => expect(persistedError).toHaveBeenCalledWith(task, expect.stringContaining('SUBSCRIPTION_ACCOUNT_LIMITED')));
          expect(persisted).toEqual(['after-idle']);
          expect(bootstrapped).not.toHaveBeenCalled();
          expect(opens).toHaveLength(2);
          expect(sendCalls).toBe(1);
          expect(probeResults).toEqual([false]);
          expect(guestSwitch.hasOffer(task)).toBe(false);
          return;
        }
        if (phase === 'scheduled-reconnect') {
          await expect(send.mock.results[0].value).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LIMITED');
          expect(bootstrapped).not.toHaveBeenCalled();
          expect(guestSwitch.hasOffer(task)).toBe(true);
          expect(wireOrder).toEqual(['token']);
          expect(opens).toHaveLength(2);
          expect(sendCalls).toBe(1);
          expect(received).toHaveLength(1);
          expect(handoff).toBe('');
          return;
        }
        const dispatched = await send.mock.results[0].value.catch((error: unknown) => error);
        expect(probeResults, 'the host must have an eligible spare').toEqual([true]);
        expect(bootstrapped, 'the confirmed rejection must reopen the stale controller Session').toHaveBeenCalledOnce();
        expect(dispatched).toMatchObject({ dispatched: true });
        await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
        expect(persisted).toEqual(['after-idle']);
        if (phase === 'reconnect') expect(insertBoundary).toHaveBeenCalledOnce();
        expect(persistedError).not.toHaveBeenCalled();
        expect(onUsageLimitedTurnError).not.toHaveBeenCalled();
        expect(opens).toHaveLength(3);
        expect(opens[1]).toMatchObject({ acceptsGroupSwitch: true, options: { resumeSessionId: oldNative } });
        expect(opens[1]).not.toHaveProperty('groupAssigned');
        expect(opens[2]).toHaveProperty('groupSwitchToken', expect.any(String));
        expect(opens[2].options).not.toHaveProperty('resumeSessionId');
        expect(sendCalls).toBe(2);
        expect(starts).toHaveLength(2);
        expect(starts[1][NATIVE_SUBSCRIPTION_ACCOUNT]?.configDir).toBe('anthropic/default');
        expect(h.bindings.get(`native:${oldNative}`)?.accountId).toBe(original);
        expect(JSON.stringify(received.at(-1))).toContain('PINEAPPLE-42');
        const expectedInput = boundary === 'edited-input' ? 'Continue the edited input.' : 'Continue.';
        expect(JSON.stringify(received.at(-1)).split(expectedInput)).toHaveLength(2);
        if (boundary === 'edited-input') expect(JSON.stringify(received.at(-1))).not.toContain('Continue.');
        if (boundary === 'expired-host-token') {
          expect(wireOrder).toEqual(['token']);
          expect(received).toHaveLength(2);
          expect(events.filter(event => event.type === 'done')).toHaveLength(1);
        }
        return;
      }

      if (pendingStart) {
        await expect(open()).rejects.toThrow(phase === 'auth-pending-start' ? 'not authenticated' : 'usage limit exceeded');
        expect(await canSwitchHostedSubscriptionAccount(published, hostTask, model)).toBe(true);
        expect((await readSubscriptionPool(a)).accounts.map(entry => entry.running)).toEqual([1, 0]);
        expect(await service.prepareGuestStartSwitch(task)).toBeNull();
        expect(wireOrder).not.toContain('token');
        confirmStopped(); await whenStopped;
        expect((await readSubscriptionPool(a)).accounts.map(entry => entry.running)).toEqual([0, 0]);
        expect(starts).toHaveLength(1);
        expect(guestSwitch.hasOffer(task)).toBe(false);
        return;
      }
      await open();
      const oldNative = row.sdkSessionId!;
      expect(oldNative).toBe('isolated-native-1');
      await active.call('send', [{ type: 'user', content: 'Keep the codeword PINEAPPLE-42.' }]);
      await vi.waitFor(() => expect(events.some(event => event.type === 'done')).toBe(true));
      if (phase === 'pre-pool') h.pools.anthropic = { strategy: 'order', accounts: [account('default'), account('second')].map(entry => ({ ...entry, limit: 4 })) };
      const originalLease = await acquireSubscriptionAccount(published, model, [`task:${hostTask}`], true,
        { accountId: original, remote: true });
      if (phase === 'auth-cold') {
        originalLease!.release();
        await active.close('close', 'navigation');
        // Cached allocator admission remains healthy; the real wrapper releases
        // the lease after target.startSession's definite no-process auth failure.
        await expect(open(oldNative)).rejects.toThrow('agent-not-authenticated:claude-code');
        expect(wireOrder).toContain('token');
        expect(wireOrder.indexOf('token')).toBeLessThan(wireOrder.indexOf('start-failed'));
        const recovery = await service.prepareGuestStartSwitch(task);
        expect(recovery).not.toBeNull();
        try { await relocate(recovery!.isCurrent); } finally { recovery!.dispose(); }
        await continueSession();
      } else if (phase === 'idle-send') {
        originalLease!.release();
        limited.add(original);
        expect(host.limitUsage().total).toBe(1);
        expect(received).toHaveLength(1);
        await active.call('send', [{ type: 'user', content: 'Continue remaining work.' }]);
        expect(received).toHaveLength(2);
        await vi.waitFor(() => expect(events.some(event => event.type === 'error')).toBe(true));
        expect(wireOrder.filter(event => event === 'token')).toHaveLength(1);
        expect(wireOrder.indexOf('token')).toBeLessThan(wireOrder.indexOf('error'));
        await service.onTurnError(task, events.find(event => event.type === 'error')!.data as { message: string; usageLimit: boolean }, 1);
        expect(continueSession).toHaveBeenCalledOnce();
        expect(received).toHaveLength(3);
        expect(JSON.stringify(received.at(-1)).match(/Continue remaining work\./g)).toHaveLength(1);
      } else if (phase === 'auth-send') {
        originalLease!.release();
        h.pools.anthropic!.accounts[0].reloginIdentity = 'previous@example.invalid';
        if (boundary === 'no-spare') h.pools.anthropic!.accounts[1].paused = true;
        h.read.mockImplementation(async (_kind: string, dir: string) => ({ authenticated: !dir.endsWith(original), identity: dir }));
        await refreshSubscriptionPool(a, true);
        const count = received.length;
        await expect(active.call('send', [{ type: 'user', content: 'Continue.' }])).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED');
        expect(received).toHaveLength(count); // lease.assertDispatchable rejected before native send; no native terminal exists.
        if (boundary === 'no-spare') {
          expect(guestSwitch.hasOffer(task)).toBe(false);
          expect(wireOrder).not.toContain('token');
          expect(starts).toHaveLength(1);
          return;
        }
        expect(wireOrder).toContain('token');
        await vi.waitFor(() => expect(events.some(event => event.type === 'error')).toBe(true));
        const authError = events.find(event => event.type === 'error')!.data as { message: string; usageLimit?: boolean };
        expect(authError.message).toContain('SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED');
        expect(authError.usageLimit).not.toBe(true);
        expect(events.filter(event => event.type === 'error')).toHaveLength(1);
        expect(wireOrder.indexOf('token')).toBeLessThan(wireOrder.indexOf('error'));
        await service.onTurnError(task, authError, 1);
      } else if (phase === 'cold' || phase === 'pre-pool') {
        await active.close('close', 'navigation');
        expect(originalLease!.observeFailure({ sdkError: 'rate_limit' }, model, 'run')).toBe(true);
        expect(readSubscriptionAccountBlocked('anthropic', original, model)).toBe(true);
        originalLease!.release();
        limited.add(original);
        if (boundary === 'all-limited') {
          limited.add(nextAccount);
          const other = await acquireSubscriptionAccount(a, model, [], true, { accountId: nextAccount });
          other!.observeFailure({ sdkError: 'rate_limit' }, model, 'run'); other!.release();
        }
        h.usage.mockImplementation(async (_kind: string, dir: string) => ({ claudeUsage: { updatedAt: Date.now(),
          fiveHour: { utilization: limited.has(dir.split('/').at(-1)!) ? 100 : 10, resetsAt: Date.now() / 1000 + 3600 },
          sevenDay: null, scoped: [] } }));
        await refreshSubscriptionPool(a, true);
        await expect(open(oldNative)).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LIMITED');
        if (boundary === 'none') {
          expect(wireOrder.indexOf('token')).toBeLessThan(wireOrder.indexOf('start-failed'));
          const recovery = await service.prepareGuestStartSwitch(task);
          expect(recovery).not.toBeNull();
          await relocate(recovery!.isCurrent); recovery!.dispose();
          await continueSession();
        } else {
          expect(await service.prepareGuestStartSwitch(task)).toBeNull();
          expect(wireOrder).not.toContain('token');
          expect(starts).toHaveLength(1);
          return;
        }
      } else {
        originalLease!.release();
        limited.add(original);
        if (boundary === 'all-run-limited') limited.add(nextAccount);
        const errorsBefore = events.filter(event => event.type === 'error').length;
        await active.call('send', [{ type: 'user', content: 'Continue.' }]);
        if (boundary === 'stopped' || boundary === 'revoked') {
          await probeGate;
          if (boundary === 'stopped') { service.noteUserAction(task); await active.call('abort', []); }
          else { authorized = false; service.noteUserAction(task); await host.abortControllers(controller => controller === peer); }
          resolveProbe!();
          if (boundary === 'stopped') await vi.waitFor(() => expect(events.filter(event => event.type === 'error').length).toBeGreaterThan(errorsBefore));
          else expect(host.limitUsage().total).toBe(0);
          expect(wireOrder).not.toContain('token');
          expect(guestSwitch.hasOffer(task)).toBe(false);
          expect(continueSession).not.toHaveBeenCalled();
          return;
        }
        await vi.waitFor(() => expect(events.filter(event => event.type === 'error').length).toBeGreaterThan(errorsBefore));
        expect(wireOrder).toContain('token');
        expect(wireOrder.indexOf('token')).toBeLessThan(wireOrder.indexOf('error'));
        expect(service.mayHandleTurnError(task, { sdkError: 'rate_limit' })).toBe(true);
        await service.onTurnError(task, { sdkError: 'rate_limit' }, 1);
      }
      if (boundary === 'all-run-limited') {
        await vi.waitFor(() => expect(events.filter(event => event.type === 'error').length).toBe(2));
        expect(wireOrder.filter(item => item === 'token')).toHaveLength(1);
        expect(service.mayHandleTurnError(task, { sdkError: 'rate_limit' })).toBe(false);
        await service.onTurnError(task, { sdkError: 'rate_limit' }, 2);
        expect(fallback).toHaveBeenCalledOnce();
        expect(starts).toHaveLength(2);
        expect(h.bindings.get(`native:${oldNative}`)?.accountId).toBe(original);
        expect(h.bindings.get('native:isolated-native-2')?.accountId).toBe(nextAccount);
        return;
      }
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done').length).toBe(2));
      expect(starts).toHaveLength(phase === 'auth-cold' ? 3 : 2);
      expect(starts.at(-1)![NATIVE_SUBSCRIPTION_ACCOUNT]!.configDir).toBe(`anthropic/${nextAccount}`);
      expect(starts.at(-1)!.resumeSessionId).toBeUndefined();
      expect(h.bindings.get(`native:${oldNative}`)?.accountId).toBe(original);
      expect(h.bindings.get('native:isolated-native-2')?.accountId).toBe(nextAccount);
      expect(h.bindings.get(`task:${hostTask}`)?.accountId).toBe(nextAccount);
      expect(row.agentDeviceId).toBe(route);
      expect(row.providerId).toBe(published);
      expect(JSON.stringify(received.at(-1))).toContain('PINEAPPLE-42');
      expect(JSON.stringify(received.at(-1))).toContain('Continue remaining work.');
      expect(fallback).not.toHaveBeenCalled();
      expect(guestSwitch.takeForOpen(task)).toBeUndefined();
    } finally {
      confirmStopped();
      resolveProbe?.();
      await guestSession?.close();
      await remoteHandle?.close({ reason: 'navigation' });
      for (const client of clients) client.abandon('test-finished');
      await host.dispose();
      if (weekly) vi.useRealTimers();
    }
  });
});

// 2026-11-18 user report, unit: the router returned a wrong address for chatgpt.com, so every
// Codex account read timed out while the login on disk was valid. The account looked signed out,
// and signing in again failed before the browser opened. Existing login cases use reads that
// answer or fail without a cause. Minimal input: the native account read rejects as unreachable.
describe('unreachable account service', () => {
  const unreachable = () => new AccountServiceUnreachableError('Codex account request failed');

  // The sign-in still has to be confirmed (登录完成须确认, 2026-11-16): an offline confirmation is
  // not a completed login, but it must say the service was unreachable instead of a generic failure.
  it('still opens the browser login for a known account and reports an unconfirmed result as unreachable', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
    h.read.mockRejectedValue(unreachable());
    await expect(runSubscriptionAccountCommand({ action: 'login', providerId: 'openai', accountId: 'second', loginKey: 'offline' }))
      .rejects.toBeInstanceOf(AccountServiceUnreachableError);
    expect(h.login).toHaveBeenCalledWith('openai', 'openai/second', expect.any(AbortSignal));
    expect((await readSubscriptionPool('openai')).accounts.find((entry) => entry.id === 'second')?.status).toBe('unavailable');
  });

  it('keeps the last identity while unreadable and announces the change both ways', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default')] };
    h.read.mockResolvedValue({ authenticated: true, identity: 'kept@example.test' });
    await refreshSubscriptionPool('openai', true);
    const events: string[] = [];
    const off = onSubscriptionAccountsChanged((provider) => events.push(provider));
    try {
      h.read.mockRejectedValue(unreachable());
      expect((await refreshSubscriptionPool('openai', true)).accounts[0])
        .toMatchObject({ status: 'unavailable', identity: 'kept@example.test' });
      expect(events).toEqual(['openai']);
      await refreshSubscriptionPool('openai', true);
      expect(events).toEqual(['openai']);
      h.read.mockResolvedValue({ authenticated: true, identity: 'kept@example.test' });
      expect((await refreshSubscriptionPool('openai', true)).accounts[0].status).toBe('ready');
      expect(events).toEqual(['openai', 'openai']);
    } finally {
      off();
    }
  });

  // 2026-11-20 user report: a short outage emptied the local model picker ("模型列表暂未更新" with
  // no time) and the provider read as signed out. Cases above check only the account row.
  // Minimal input: a signed-in account with a model list whose next account read fails.
  it('keeps the provider connected and its last list with its time, without routing to it', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default')] };
    h.rpc.mockResolvedValue({ data: [{ id: 'gpt-kept' }], nextCursor: null });
    await refreshSubscriptionPool('openai', true);
    await refreshSubscriptionPoolCodexModels(true);

    h.read.mockRejectedValue(unreachable());
    const rpcCalls = h.rpc.mock.calls.length;
    expect((await refreshSubscriptionPool('openai', true)).accounts[0].status).toBe('unavailable');
    await refreshSubscriptionPoolCodexModels();
    expect(h.rpc).toHaveBeenCalledTimes(rpcCalls);
    // PR #11754 review: the default gate also drives oneshot model selection.
    // An unreadable account with a saved list must leave room for a healthy fallback.
    expect(hasConnectedSubscriptionPool('openai')).toBe(false);
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
    expect(readSubscriptionPoolCodexModels('openai', { includeLastConfirmed: true })?.map(m => m.id)).toEqual(['gpt-kept']);
    expect(lastConfirmedSubscriptionModelsAt('openai')).toEqual(expect.any(Number));
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    expect(hasConnectedSubscriptionPool('openai', { includeBoundAccounts: true })).toBe(false);
    expect(readSubscriptionPoolCodexModels('openai', { includeBoundAccounts: true })).toEqual([]);
    await expect(acquireSubscriptionAccount('openai', 'gpt-kept', [])).rejects.toThrow('No subscription account is available');

    // Back online: the account reads again and its list is fetched afresh.
    h.read.mockResolvedValue({ authenticated: true, identity: 'account' });
    h.rpc.mockResolvedValue({ data: [{ id: 'gpt-fresh' }], nextCursor: null });
    expect((await refreshSubscriptionPool('openai', true)).accounts[0].status).toBe('ready');
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels()?.map(m => m.id)).toEqual(['gpt-fresh']);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(false);
  });

  // Unit: after one account is unreadable, the aggregate failure marker and display
  // models stay constant when the last healthy account also becomes unreadable.
  it('publishes loss of the last usable account even if display models stay the same', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default'), account('second')] };
    const offline = new Set<string>();
    h.read.mockImplementation(async (_provider: string, directory: string) => {
      if (offline.has(directory.split('/').at(-1)!)) throw unreachable();
      return { authenticated: true, identity: directory };
    });
    h.rpc.mockResolvedValue({ data: [{ id: 'gpt-shared' }], nextCursor: null });
    await refreshSubscriptionPool('openai', true);
    await refreshSubscriptionPoolCodexModels(true);
    offline.add('default');
    await refreshSubscriptionPool('openai', true);
    expect(hasUnavailableSubscriptionPoolAccount('openai')).toBe(true);
    expect(hasConnectedSubscriptionPool('openai')).toBe(true);

    const observed: boolean[] = [];
    const stop = onSubscriptionPoolCodexModelsChanged(() => observed.push(hasConnectedSubscriptionPool('openai')));
    try {
      offline.add('second');
      await refreshSubscriptionPool('openai', true);
      expect(observed).toContain(false);
      expect(readSubscriptionPoolCodexModels()).toEqual([]);
      expect(readSubscriptionPoolCodexModels('openai', { includeLastConfirmed: true })?.map(m => m.id))
        .toEqual(['gpt-shared']);
    } finally { stop(); }
  });

  // Offline at startup: memory is gone, so the list saved for the slot is the evidence. A
  // confirmed sign-out clears it, so a later offline start does not resurrect the account.
  it('restores the saved list after an offline restart until a sign-out is confirmed', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('second')] };
    h.rpc.mockResolvedValue({ data: [{ id: 'gpt-saved' }], nextCursor: null });
    await refreshSubscriptionPool('openai', true);
    await refreshSubscriptionPoolCodexModels(true);
    const owner = h.owner;
    const restart = () => { h.owner = 'another-owner'; readSubscriptionPoolCodexModels(); h.owner = owner; };

    restart();
    h.read.mockRejectedValue(unreachable());
    await refreshSubscriptionPool('openai', true);
    await refreshSubscriptionPoolCodexModels();
    expect(readSubscriptionPoolCodexModels('openai', { includeLastConfirmed: true })?.map(m => m.id)).toEqual(['gpt-saved']);
    expect(lastConfirmedSubscriptionModelsAt('openai')).toEqual(expect.any(Number));

    h.read.mockResolvedValue({ authenticated: false });
    await refreshSubscriptionPool('openai', true);
    expect(h.savedModelFiles.size).toBe(0);
    restart();
    h.read.mockRejectedValue(unreachable());
    await refreshSubscriptionPool('openai', true);
    await refreshSubscriptionPoolCodexModels();
    expect(hasConnectedSubscriptionPool('openai')).toBe(false);
    expect(readSubscriptionPoolCodexModels('openai', { includeLastConfirmed: true })).toEqual([]);
  });

  it('does not invent a sign-in for an account that was never confirmed', async () => {
    h.pools.openai = { strategy: 'least', accounts: [account('default')] };
    h.read.mockRejectedValue(unreachable());
    expect((await refreshSubscriptionPool('openai', true)).accounts[0].status).toBe('unavailable');
    await refreshSubscriptionPoolCodexModels();
    expect(hasConnectedSubscriptionPool('openai')).toBe(false);
    expect(readSubscriptionPoolCodexModels()).toEqual([]);
  });
});
