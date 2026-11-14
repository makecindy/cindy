import { reconcileDeletedTaskViewState } from '../../desktop/src/main/mcp-apps/viewStateStore.js';
import { clientMigrationContract } from './client-migration-contract.mjs';
import { createRightSidebarTabsService } from '../../desktop/src/main/localDb/ipc/rightSidebarTabs.js';
import { createHostPlatformTools } from './platform/tools.js';
import { createHostCodexRuntime } from './agent/codex-runtime.js';
import { createAvailabilityPolicy } from '../../desktop/src/main/device-link/providerShareAvailabilityPolicyCore.js';
import { configureWindowsAtomicRename } from '../../desktop/src/main/windowsAtomicRename.js';
import { isDefinitiveRefreshError } from '../../desktop/src/main/authRefreshError.js';
import { createUserSession } from '../../desktop/src/main/localDb/ipc/createUserSession.js';
import { setSessionOpeningModelAdmission } from '../../desktop/src/main/localDb/sessionOpening.js';
import { resolveSessionExecutionSelection } from '../../desktop/src/main/maker-ipc/sessionExecutionSelection.js';
import { buildLocalProviderRoutingContext } from '../../desktop/src/main/maker-ipc/orcaProviderRoutingContext.js';
import { configureProvisionalSessions, isProvisionalSession, forgetProvisionalSession, sweepLeftoverProvisionalSessions } from '../../desktop/src/main/localDb/provisionalSessions.js';
import { commitProvisionalSession, discardProvisionalSessionRow } from '../../desktop/src/main/localDb/sessionDraftLifecycle.js';
import { activeOwnerScopeKey, beginAppSessionBoundary, commitVolatileAppSession, getActiveAppSession, isAppSessionBoundaryPending } from '../../desktop/src/main/appSessionState.js';
import { statWorkingDirectory, workdirProbeHostClient } from '../../desktop/src/main/workdir-probe-host/index.js';
import { mapMembershipToAuthUser, type User as AccountUser } from '../../desktop/src/shared/authUser.js';
import { resolveSessionDevice, canRegisterHostDevice } from './auth/device-identity.mjs';
import { AUTH_SESSION_KEY } from '../../desktop/src/main/authCredentialKeys.js';
import { createHostDeviceLink } from './device-link.js';
import { createHostService } from './service.mjs';
import { readHostCreateSessionOpts } from './create-session-request.js';
import { ensureDialogueWorkspaceDir } from '../../desktop/src/main/localDb/dialogueWorkspace.js';
import { resolveRuntimeDeviceId } from '../../desktop/src/main/deviceId.js';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { getDefaultVoiceInputSettings } from '../../desktop/src/shared/voiceInputData.ts';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../desktop/src/shared/appearanceSettings.ts';
import { createDefaultLayout } from '../../desktop/src/shared/layoutTree.ts';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hostRuntimeLayout } from './runtime-layout.mjs';
import { createHostServerApi } from './server-api.js';
import { decodeAccessTokenOrgSlug } from '../../desktop/src/main/authTokenClaims.js';
import { parseGhostSetupInteractionCommand } from '../../desktop/src/main/cindy-brain/ghostSetupInteractionBridge.js';
import { openSystemBrowser, openHostBrowser } from './browser-open.mjs';

import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.js';
import { OwnerSessionStorage } from '../../desktop/src/main/localDb/sessionStorageAdapter.js';
import { getDbClient, setCurrentDbClient, clearCurrentDbClient, getCurrentDbClientSnapshot } from '../../desktop/src/main/localDb/client/current.ts';
import { loadAgentInputQueueSnapshot, saveAgentInputQueueSnapshot, getPersistedInputClientIds } from '../../desktop/src/main/localDb/agentInputQueueSnapshots.ts';
import { touchUserSendRow } from '../../desktop/src/main/localDb/sessionQueries.ts';
import { markSessionTurnStartedDurable, markSessionTurnEnded, drainSessionActiveTurnWrites, ackSessionTurnEndedDurable,
  hasAssistantProgressAfterMessage, getRecoveryContextSnapshot,
} from '../../desktop/src/main/localDb/sessionActiveTurn.ts';
import { readSessionExtraDirsFromDb, readSessionWritableDirsFromDb } from '../../desktop/src/main/maker-host/session-storage.js';
import { createProviderGroupStore } from '../../desktop/src/main/provider-group/storeCore.js';
import { createProviderGroupBindings } from '../../desktop/src/main/provider-group/bindings.js';
import { AGENT_BINARY_LAYOUT, readCachedBinaryStatus } from '../../desktop/src/main/agent-binaries/binaryStatus.js';
import { openOwnerDatabase, OwnerDatabaseError } from '../../desktop/src/main/localDb/startupCore.js';
import { discoverHostOwner, ownerDatabasePath, resolveHostDataDir, resolveHostRegion, resolveHostAppDataDir } from './profile-path.mjs';
import { acquireHostRuntimeLease, acquireHostServiceLease, type HostRuntimeLease } from './runtime-lock.js';
import { publishHostEndpoint, readHostProcessStatus, requestHostStop, requestHostRemote } from './control.mjs';
import { readAdoptedSessionState } from './credentials/session.mjs';
import { refreshHostSession } from './auth/refresh.mjs';
import { configureHostOwner, readClaudeSubscriptionState } from './agent/claude-auth.mjs';
import { attachAgentsToMakerMemory, createHostMemoryManager, createHostMemoryMcpProviders } from './agent/memory.mjs';
import { createHostAgentGraph } from './agent/runtime.mjs';
import { createHostMcpRuntime } from './agent/mcp-runtime.js';
import { createHostAgentAuth } from './agent/auth-service.js';
import { initLogger } from '../../desktop/src/main/logger.js';
import { createHostModelAccess } from './agent/model-access.js';
import { MODEL_ACCESS_STATUS_CHANNEL } from '../../desktop/src/shared/modelAccess.js';
import { createProviderCatalog } from './agent/providers.mjs';
import { closeClaudeCliProxyBridge } from '../../desktop/src/main/maker-host/claude-cli-proxy-bridge.js';
import { setXdGatewayModels } from '../../desktop/src/main/maker-host/active-catalog.js';
import { buildModelsSyncRequest, parseModelsSyncPayload, withModelsSyncOverallDeadline } from '../../desktop/src/main/model-access/modelsSyncRefresh.js';
import { createHostProviderConfig } from './agent/provider-config.js';
import { createProviderRouteResolver } from './agent/provider-credentials.mjs';
import { createHostHistoryReader, readMessagesList, readMessagesAroundClientId } from './agent/history.js';
import { runLoginCommand } from './login-cli.mjs';
import { readOrCreateApiToken } from './api-token.mjs';
import { CindyAuthClient } from '@cindy/auth-client';
import type { Effort, PermissionMode } from '@cindy/maker-core';
import { createRequire } from 'node:module';
import { readAuthEndpoints } from './auth/endpoints.mjs';
import { logoutHostSession } from './auth/logout.mjs';
import { listInstalledPlugins } from './plugins.mjs';
import { createHostGhostManager } from './plugins-installed.ts';
import { initializeHostPluginRemoteAuthorization } from './plugins/remote-authorization.js';
import { ownerScopedPath } from '../../desktop/src/main/dataOwnerPath.js';
import { createHostPluginRuntime } from './plugins/runtime.js';
import { createHostPluginGateway } from './plugins/gateway.js';
import { createHostToolService } from './agent/host-tools.js';
import { storageShareMessage } from '../../desktop/src/main/cindy-brain/storageService.js';
import { createHostConfirmations } from './host-confirmations.js';
import { createMainI18n } from '../../desktop/src/main/i18n.js';
import { GHOST_HOST_TOOL_GROUPS } from '@cindy/plugin-protocol';
import { toolAutoReviewAction } from '@cindy/maker-core';
import { GhostGrantConfirmBridge } from '../../desktop/src/main/cindy-brain/ghostGrantConfirmBridge.js';
import { getGhostCard, listGhostCardsBySession } from '../../desktop/src/main/cindy-brain/cardStoreDb.js';
import { ghostAppContextLocale } from '../../desktop/src/shared/ghost.js';
import { MAKER_PUSH } from '../../desktop/src/main/maker-ipc/channels.js';
import { listActiveSessions, listRunningSessions } from './sessions.mjs';
import {
  readProfileSettings,
  writeAppearanceSettingsPatch,
  writeAppShortcutOverrides,
  writeLayout,
  writeSidebarSettings,
} from './profile-settings.mjs';
import { createCredentialStore } from './credentials/store.mjs';
import { createHostServer } from './server.mjs';
import { createPlatformClientBridge } from './platform/client-bridge.js';
import { createSnapshotProcess } from './snapshot-process.mjs';
import { configureGhostSnapshotProcess } from '../../desktop/src/main/cindy-brain/ghostSnapshotCapability.js';
import { withCrossProcessLock } from '../../desktop/src/main/device-link/crossProcessLock.js';
import { createChatHandler } from './chat.mjs';
import { createEventHub } from './events.mjs';
import { createTaskTagService } from '../../desktop/src/main/localDb/ipc/taskTagService.js';
import { executeConversationSearch } from '../../desktop/src/main/localDb/ipc/search.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../desktop/src/main/device-link/broadcast-tap.js';
import { createInputQueue } from './agent/input-queue.mjs';
import { applyLiveSessionSettings } from './agent/session-settings.mjs';
import { createInteractionBroker } from './agent/interactions.mjs';
import { messageToCamel, sessionToCamel } from '../../desktop/src/main/localDb/mapper.ts';
import { readHostSessionList, readHostSession } from './session-reads.js';
import { createHostMessageStore, createHostMessageRecovery } from './message-store.js';
import { createHostAttachments } from './attachments.js';
import { createSubagentReadService } from '../../desktop/src/main/localDb/ipc/subagentReadService.js';
import { configureUserDataDir, configureAppDataDir, getUserDataDir } from '../../desktop/src/main/userDataPath.js';
import { botSessionLinks, messages as messageTable, projectAliases as projectAliasTable, sessions as sessionTable } from '../../desktop/src/main/localDb/schema.js';
import { and, eq, isNull } from 'drizzle-orm';
import { projectHistoryView } from '@cindy/maker-shared/message-window';
import { isDefaultDraftSessionTitle, normalizeAutoTitle } from '@cindy/maker-shared/session-title';

const DEFAULT_VOICE_INPUT_SETTINGS = getDefaultVoiceInputSettings();
configureGhostSnapshotProcess(createSnapshotProcess);
const VALID_EFFORTS: Record<string, true> = {
  minimal: true, low: true, medium: true, high: true, xhigh: true, max: true, ultra: true,
};
const VALID_PERMISSION_MODES: Record<string, true> = {
  ask: true, default: true, acceptEdits: true, plan: true, auto: true, bypassPermissions: true,
};
function parseEffort(value: unknown): Effort | undefined {
  if (typeof value !== 'string' || VALID_EFFORTS[value] !== true) return undefined;
  return value as Effort;
}
function parsePermissionMode(value: unknown): PermissionMode | undefined {
  if (typeof value !== 'string' || VALID_PERMISSION_MODES[value] !== true) return undefined;
  return value as PermissionMode;
}

const command = process.argv[2];
if (command === '--help' || command === '-h') {
  console.log('Usage: cindy-host [serve|login [--region=cn|global] [--method=<id>]|open|status [--json]|remote [status|enable|disable|revoke <device-id>]|stop]');
} else if (command === 'open') {
  try {
    await openHostBrowser(resolveHostDataDir());
    console.log('Opened Cindy Host in your browser.');
  } catch (error) {
    console.error(`cindy-host open failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'status') {
  // Sanitized login state for scripts and for the operator: never tokens.
  try {
    const login = await readAdoptedSessionState({
      userDataDir: resolveHostDataDir(),
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    }).catch(() => ({ authenticated: null, realm: null, credentialStoreUnavailable: true }));
    const state = { ...login, ...await readHostProcessStatus(resolveHostDataDir()) };
    const json = process.argv.includes('--json');
    if (json) {
      console.log(JSON.stringify(state));
    } else {
      console.log(`authenticated: ${state.authenticated}`);
      console.log(`realm: ${state.realm ?? 'none'}`);
      console.log(`running: ${state.running === null ? 'unreachable' : state.running}`);
      if (state.baseUrl) console.log(`address: ${state.baseUrl}`);
      if (state.error) console.error(state.error);
      if ('credentialStoreUnavailable' in login) console.error('Credential store is unavailable; unlock it to inspect sign-in status.');
    }
  } catch (error) {
    console.error(`cindy-host status failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'stop') {
  try {
    const result = await requestHostStop(resolveHostDataDir());
    console.log(result.stopping ? 'Cindy Host is stopping.' : 'Cindy Host is not running.');
  } catch (error) {
    console.error(`cindy-host stop failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
 } else if (command === 'remote') {
  try {
    const action = process.argv[3] ?? 'status';
    if (!['status', 'enable', 'disable', 'revoke'].includes(action)) throw new Error('Usage: cindy-host remote [status|enable|disable|revoke <device-id>]');
    console.log(JSON.stringify(await requestHostRemote(resolveHostDataDir(), action, process.argv[4]), null, 2));
  } catch (error) {
    console.error(`cindy-host remote failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command === 'login') {
  try {
    await runLoginCommand(process.argv.slice(3));
  } catch (error) {
    console.error(`cindy-host login failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command !== undefined && command !== 'serve') {
  console.error(
    `unknown command: ${command}\nusage: cindy-host [serve|login [--region=cn|global] [--method=<id>]|open|status [--json]|remote [status|enable|disable|revoke <device-id>]|stop]`,
  );
  process.exitCode = 2;
} else {
const PORT = Number(process.env.CINDY_HOST_PORT ?? '3456');
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('CINDY_HOST_PORT must be a valid port');
const profileDir = resolveHostDataDir();
configureUserDataDir(profileDir);
configureAppDataDir(resolveHostAppDataDir());
configureWindowsAtomicRename({
  packagedBinary: hostRuntimeLayout().atomicRenameBinary ?? undefined,
  sourceFile: hostRuntimeLayout().atomicRenameSource ?? undefined,
  cacheDir: path.join(profileDir, 'windows-atomic-rename'),
});
mkdirSync(profileDir, { recursive: true, mode: 0o700 });
const serviceLease = acquireHostServiceLease(profileDir);
if (!serviceLease.held) throw new Error(`Cindy Host profile is busy (${serviceLease.reason}). Use status or stop for this profile.`);
initLogger({ userDataDir: profileDir, isPackaged: true, logDir: path.join(profileDir, 'logs') });
const instanceId = randomUUID();
let removeEndpoint: (() => void) | undefined;
const releaseService = () => {
  try { removeEndpoint?.(); }
  finally { serviceLease.release(); }
};
process.once('exit', releaseService);
const layout = hostRuntimeLayout();

interface RuntimeState {
  state: 'uninitialized' | 'ready' | 'error' | 'blocked';
  owner: string | null;
  storage: 'unopened' | 'ready' | 'error';
  agents?: string[];
  agentLane?: string;
  detail?: string;
}

const runtime: RuntimeState = { state: 'uninitialized', owner: null, storage: 'unopened' };

/** Resolved dev checkout binary for one harness, or null when absent. */
function harnessBinaryPath(kind: 'claude-code' | 'codex' | 'pi'): string | null {
  const layout = kind === 'claude-code'
    ? { dir: 'claude-code-bin', file: AGENT_BINARY_LAYOUT['claude-code'].binaryName }
    : kind === 'codex'
      ? { dir: 'codex-package-bin', file: AGENT_BINARY_LAYOUT.codex.binaryName }
      : { dir: 'pi-bin', file: AGENT_BINARY_LAYOUT.pi.binaryName };
  const status = readCachedBinaryStatus({
    kind,
    isPackaged: false,
    userDataDir: resolveHostDataDir(),
    devCandidates: [path.join(hostRuntimeLayout().harnessRoot, layout.dir, platformKey, layout.file)],
  });
  return status.binaryPath ?? null;
}

/** Dev checkout binaries, in the same order the Desktop dev lookup uses. */
const HARNESS_KINDS = ['claude-code', 'codex', 'pi'] as const;
const platformKey = `${process.platform}-${process.arch}`;

function harnessStatus(): Record<string, boolean> {
  return Object.fromEntries(HARNESS_KINDS.map((kind) => {
    const layout = kind === 'claude-code'
      ? { dir: 'claude-code-bin', file: AGENT_BINARY_LAYOUT['claude-code'].binaryName }
      : kind === 'codex'
        ? { dir: 'codex-package-bin', file: AGENT_BINARY_LAYOUT.codex.binaryName }
        : { dir: 'pi-bin', file: AGENT_BINARY_LAYOUT.pi.binaryName };
    const status = readCachedBinaryStatus({
      kind,
      isPackaged: false,
      userDataDir: resolveHostDataDir(),
      devCandidates: [
        path.join(hostRuntimeLayout().harnessRoot, layout.dir, platformKey, layout.file),
      ].map((candidate) => path.resolve(candidate)),
    });
    return [kind, status.binaryReady];
  }));
}
/**
 * The Desktop's `AuthState.user` projection, resolved from the same adopted
 * session so the browser identifies the account exactly like the client does.
 */
/**
 * Resolve the signed-in account profile through the adopted Desktop session.
 *
 * The auth-server `me` document is a membership, not a user row, so this maps it
 * exactly like the Desktop's `mapMembershipToAuthUser` does. Only the display
 * projection is kept; the access token never leaves this function, and the
 * refresh token is written back through the shared safeStorage record both
 * clients read (same path, same rotation semantics as the Desktop).
 */
async function resolveAccountUser(expectedOwner: string | null = runtime.owner): Promise<AccountUser | null> {
  const realm = (account.realm ?? resolveHostRegion()) as 'cn' | 'global';
  const endpoints = readAuthEndpoints(realm);
  const store = await createCredentialStore({
    userDataDir: resolveHostDataDir(),
    keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
  });
  const { machineIdSync } = createRequire(import.meta.url)('node-machine-id');
  const verifiedDeviceId = resolveSessionDevice(store.read(AUTH_SESSION_KEY), () => resolveRuntimeDeviceId(machineIdSync, ''));
  const client = new CindyAuthClient({
    baseUrl: endpoints.authApiBaseUrl,
    region: realm,
    deviceId: verifiedDeviceId,
    clientType: 'desktop',
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const { sessionToken } = await refreshHostSession({
    store,
    refresh: (token) => client.refresh(token),
  });
  const me = await client.getMe(sessionToken);
  const membership = me?.membership;
  if (!membership || typeof membership.id !== 'string' || !membership.id) return null;
  if (expectedOwner && expectedOwner !== membership.id) throw new Error('The signed-in account does not match the active Host profile');
  currentSessionToken = sessionToken;
  currentDeviceId = verifiedDeviceId;
  remoteIdentityReady = canRegisterHostDevice(store.read(AUTH_SESSION_KEY), () => resolveRuntimeDeviceId(machineIdSync, ''));
  return { ...mapMembershipToAuthUser(membership, me.passportId), orgSlug: decodeAccessTokenOrgSlug(sessionToken) };
}

/** Real account profile from the adopted session; null until it resolves. */
let accountUser: AccountUser | null = null;
let currentSessionToken: string | null = null;
let remoteIdentityReady = false;
let currentDeviceId: string | null = null;
let deviceLink: ReturnType<typeof createHostDeviceLink> | null = null;
let activeOwner: string | null = null;
let closeStorage: (() => Promise<void>) | null = null;
let sessionStorage: OwnerSessionStorage | null = null;
let runtimeLease: HostRuntimeLease | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

let authClosed = false;
let authRefreshFlight: Promise<boolean> | null = null;
async function refreshAuthSession(): Promise<boolean> {
  if (authClosed) return false;
  if (authRefreshFlight) return authRefreshFlight;
  authRefreshFlight = performAuthRefresh().finally(() => { authRefreshFlight = null; });
  return authRefreshFlight;
}
async function performAuthRefresh(): Promise<boolean> {
  try {
    const user = await resolveAccountUser();
    if (user) {
      accountUser = user;
      account = { authenticated: true, realm: account.realm ?? resolveHostRegion() };
      eventHub.publish({ type: 'auth_changed', ...projectAuthState() });
      return true;
    }
    return false;
  } catch (error) {
    if (isDefinitiveRefreshError(error)) {
      // Refresh may belong to an admitted HTTP request. Raise the boundary now,
      // but let that request unwind before waiting for the HTTP drain.
      void invalidateHostSession('account-unavailable').catch(error => {
        console.warn('[host] expired-account cleanup failed:', error instanceof Error ? error.message : 'cleanup failed');
      });
    }
    console.warn('[host] auth refresh failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

let invalidation: Promise<void> | null = null;
function invalidateHostSession(_reason: string): Promise<void> {
  if (invalidation) return invalidation;
  const release = beginAppSessionBoundary();
  account = { authenticated: false, realm: account.realm, error: 'Sign in again with cindy-host login' };
  currentSessionToken = null;
  remoteIdentityReady = false;
  invalidation = Promise.resolve().then(async () => {
    try {
      const requestsDrained = server.pauseOwnerRequests();
      // Cancel user waits before draining HTTP handlers. A pending confirmation
      // must not keep expired-account requests (and their database) alive forever.
      fileConfirmation.cleanupAll('session_closed');
      plugins?.authorization.bridge.cleanupAll('session_closed');
      stopPluginAuthorization?.(); stopPluginAuthorization = null;
      plugins?.authorization.cancelPending();
      interactionBroker.dispose();
      await pluginGateway?.host.reset();
      await requestsDrained;
      await disposeOwnerRuntime();
    } finally {
      commitVolatileAppSession('signed-out', null, true);
      release();
      runtime.state = 'uninitialized'; runtime.owner = null; runtime.storage = 'unopened';
      runtime.detail = 'Sign-in expired. Stop the Host, sign in again, then start it.';
      eventHub.clear();
    }
  }).finally(() => { invalidation = null; });
  return invalidation;
}
const serverApi = createHostServerApi({
  token: () => currentSessionToken, refresh: refreshAuthSession,
  invalidate: invalidateHostSession, locale: () => Intl.DateTimeFormat().resolvedOptions().locale,
});

function schedulePeriodicRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    void refreshAuthSession();
  }, 30 * 60 * 1000);
  refreshTimer.unref();
}
/** Claude subscription state read once per boot; never on the health path. */
let claudeState: Record<string, unknown> | null = null;
/** Real maker-core agents registered in this process. */
let agentGraph: ReturnType<typeof createHostAgentGraph> | null = null;
let providerConfig: ReturnType<typeof createHostProviderConfig> | null = null;
let codexRuntime: ReturnType<typeof createHostCodexRuntime> | null = null;
let mcpRuntime: ReturnType<typeof createHostMcpRuntime> | null = null;
let agentAuth: ReturnType<typeof createHostAgentAuth> | null = null;
const listProviders = createProviderCatalog({
  readProviders: connected => providerConfig?.publicViews(connected) ?? Promise.resolve([]),
  applyModels: setXdGatewayModels,
  fetchModels: async () => {
    const baseUrl = readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global').modelAccessApiBaseUrl;
    if (!baseUrl) throw new Error('Model access endpoint is unavailable');
    const request = buildModelsSyncRequest(baseUrl);
    const payload = await withModelsSyncOverallDeadline(serverApi(request.path, { ...request.options, redactErrorDetails: true }));
    const parsed = parseModelsSyncPayload(payload);
    if (!parsed.ok) throw new Error('HOST_MODEL_ACCESS_INVALID_RESPONSE');
    return parsed.models;
  },
  readOwner: () => ({ ...getActiveAppSession(), pending: isAppSessionBoundaryPending() }),
});
let stopPluginAuthorization: (() => void) | null = null;
let platformClient: ReturnType<typeof createPlatformClientBridge> | null = null;
let platformTools: ReturnType<typeof createHostPlatformTools> | null = null;
let plugins: Awaited<ReturnType<typeof createHostPluginRuntime>> | null = null;
let pluginGateway: ReturnType<typeof createHostPluginGateway> | null = null;
let pluginManager: ReturnType<typeof createHostGhostManager> | null = null;
let hostTools: ReturnType<typeof createHostToolService> | null = null;
let hostConfirmations: ReturnType<typeof createHostConfirmations> | null = null;
let availabilityPolicy: ReturnType<typeof createAvailabilityPolicy> | null = null;
let modelAccess: ReturnType<typeof createHostModelAccess> | null = null;
const currentGateway = () => modelAccess?.gateway.credential && modelAccess.gateway.endpoint ? modelAccess.gateway : null;
/** Owner-scoped Maker Memory; null until the runtime owns an account. */
let makerMemory: ReturnType<typeof createHostMemoryManager> | null = null;
const hostHistoryReader = createHostHistoryReader(isProvisionalSession);
/** Non-secret projection of the adopted Desktop login; never tokens. */
let account: { authenticated: boolean; realm: string | null; error?: string } = { authenticated: false, realm: null };

/**
 * Initialize storage only after verifying the signed-in membership. An explicit
 * owner selects a profile; it is never evidence of a successful login.
 */
async function ensureRuntime(ownerId: string): Promise<void> {
  if (activeOwner !== null) {
    if (activeOwner === ownerId) return;
    throw new Error('owner switch is not supported while the host is running');
  }
  const dataDir = resolveHostDataDir();
  const lease = acquireHostRuntimeLease(dataDir, ownerId);
  if (!lease.held) {
    runtime.state = 'blocked';
    runtime.owner = ownerId;
    runtime.storage = 'unopened';
    runtime.detail = `runtime lease unavailable (${lease.reason}): another cindy-host owns this profile`;
    throw new OwnerDatabaseError('DB_SCHEMA_LOCKED', runtime.detail);
  }
  runtimeLease = lease;

  // Verify the credential owner under the profile lease, before opening any
  // database or constructing an agent. Refresh errors here must not be swallowed
  // by the periodic refresh path: an account B login cannot run on A's data.
  if (!currentSessionToken) {
    const state = await readAdoptedSessionState({
      userDataDir: dataDir,
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    });
    account = { authenticated: false, realm: state.realm };
    if (!state.authenticated) throw new Error('Sign in with `cindy-host login` before opening account data');
    if (state.authenticated) {
      const user = await resolveAccountUser(ownerId);
      if (!user) throw new Error('Unable to verify the signed-in Host account');
      accountUser = user;
      account = { authenticated: true, realm: state.realm };
    }
  }

  configureHostOwner({ userDataDir: dataDir, ownerId });
  const opened = await openOwnerDatabase({
    userDataDir: dataDir,
    ownerId,
    // This remains an experimental writer: keep Desktop's development guard
    // against migrating a formal profile, including in a standalone artifact.
    isPackaged: false,
    drizzleDir: process.env.CINDY_HOST_DRIZZLE_DIR?.trim() || layout.drizzleDir,
    sqliteVecExtPath: process.env.CINDY_HOST_SQLITE_VEC_PATH?.trim()
      || layout.sqliteVecPath,
  });
  const client = createDbClientForHandle({
    db: opened.db,
    drizzle: opened.drizzle,
    dispose: async () => { opened.db.close(); },
  });
  sessionStorage = new OwnerSessionStorage({ db: () => client });
  // Shared readers (history, tags) resolve the owner client from this singleton;
  // installing it here keeps them on the same connection as the host runtime.
  setCurrentDbClient(client, ownerId);
  activeOwner = ownerId;
  await reconcileDeletedTaskViewState(client, () => activeOwner === ownerId);
  closeStorage = async () => { clearCurrentDbClient(client); await client.dispose(); };
  configureProvisionalSessions(dataDir, { onSwept: sessionId => eventHub.publish({ type: 'session_changed', action: 'delete', sessionId }) });
  await sweepLeftoverProvisionalSessions();
  runtime.owner = ownerId;
  runtime.storage = 'ready';
  delete runtime.detail;

  const pluginOwner = activeOwnerScopeKey();
  const credentials = await createCredentialStore({ userDataDir: dataDir,
    keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined });
  providerConfig = createHostProviderConfig({ profileDir: dataDir, ownerId, credentials,
    gatewayConnected: () => Boolean(currentGateway()),
    getCodexBinary: () => harnessBinaryPath('codex'),
    getClaudeBinary: () => harnessBinaryPath('claude-code'),
    publish: (channel, payload) => eventHub.publish({ type: 'plugin_push', channel, payload }),
    openExternal: async url => { await openSystemBrowser(url); } });
  await providerConfig.loadCatalog({
    baseUrl: readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global').modelAccessApiBaseUrl,
    url: process.env.XDT_MODELS_URL, localPath: process.env.XDT_MODELS_PATH,
    disableFetch: process.env.XDT_DISABLE_MODELS_FETCH === '1',
  });
  availabilityPolicy = createAvailabilityPolicy(disableShareAvailability);
  const providerSecrets = providerConfig.builtinStore;
  modelAccess = createHostModelAccess({ ownerId, region: (account.realm ?? resolveHostRegion()) as 'cn' | 'global',
    readKey: () => providerSecrets.get('xd'),
    writeKey: value => providerSecrets.set('xd', value),
    request: (route, method) => {
      const baseUrl = readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global').modelAccessApiBaseUrl;
      if (!baseUrl) throw new Error('Model access endpoint is unavailable');
      return serverApi(route, { baseUrl, method, redactErrorDetails: true });
    },
    publish: status => eventHub.publish({ type: 'plugin_push', channel: MODEL_ACCESS_STATUS_CHANNEL, payload: status }),
    onKeyChanged: () => agentGraph?.gatewayRestart.schedule(),
  });
  await modelAccess.start();
  pluginManager = createHostGhostManager({ userDataDir: dataDir, ownerId,
    onChanged: ghosts => {
      if (activeOwnerScopeKey() !== pluginOwner || isAppSessionBoundaryPending()) return;
      eventHub.publish({ type: 'plugin_push', channel: 'ghosts:changed', payload: { ghosts } });
      void plugins?.reconcile().then(() => pluginGateway?.refresh())
        .catch(error => console.warn('[host] plugin reconciliation failed:', error.message));
    },
  });
  const toolOwnerCurrent = () => activeOwnerScopeKey() === pluginOwner && !isAppSessionBoundaryPending();
  const i18n = createMainI18n(() => [Intl.DateTimeFormat().resolvedOptions().locale]);
  hostConfirmations = createHostConfirmations({ current: toolOwnerCurrent });
  hostTools = createHostToolService({ profileDir: dataDir, ownerId,
    owner: () => ({ dataOwnerId: getActiveAppSession().dataOwnerId, ownerGeneration: getActiveAppSession().generation }),
    current: toolOwnerCurrent, getGhost: id => plugins?.getGhost(id) ?? null, manager: pluginManager,
    files: () => { if (!plugins) throw new Error('UNSUPPORTED_CAPABILITY'); return plugins.fsSlot; },
    storage: () => { if (!plugins) throw new Error('UNSUPPORTED_CAPABILITY'); return plugins.storage; },
    getSession: id => agentGraph?.maker.getSession(id), confirmations: hostConfirmations, t: i18n.t,
    taskActions: {
      input: id => inputQueue.taskActionInput(id),
    },
  });
  plugins = await createHostPluginRuntime({ profileDir: dataDir, ownerId, manager: pluginManager, credentials,
    hostToolRequest: hostTools.request, onPluginStopped: hostTools.stopPlugin,
    confirmStorageShare: async (facts, check) => {
      if (!check() || !hostConfirmations) return false;
      const confirmed = await hostConfirmations.confirm({ ghostId: facts.sourceId, ghostName: facts.sourceName,
        body: `${storageShareMessage(i18n.t, facts)}\n\n${facts.sourceId}\n→ ${facts.targetId}`,
        confirmText: i18n.t('settings.ghosts.connections.confirmAllow'), cancelText: null, danger: false });
      return check() && confirmed;
    },
    getLoginEmail: () => accountUser?.email ?? null,
    getUser: () => accountUser,
    account: {
      hasLogin: () => Boolean(currentSessionToken && account.authenticated),
      endpoint: service => {
        const value = readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global')[service];
        if (!value) throw new Error('Plugin authorization service endpoint is unavailable');
        return value;
      },
      post: (service, route, body) => serverApi(route, {
        method: 'POST', body, timeoutMs: 15_000, redactErrorDetails: true,
        allowedRedactedErrorCodes: ['FEISHU_OAUTH_FAILED', 'JIRA_OAUTH_FAILED'],
        baseUrl: () => {
          const value = readAuthEndpoints((account.realm ?? resolveHostRegion()) as 'cn' | 'global')[service];
          if (!value) throw new Error('Plugin authorization service endpoint is unavailable');
          return value;
        },
      }),
      openExternal: async url => { await openSystemBrowser(url); },
      modelAccessReady: () => Boolean(currentGateway()?.credential),
    },
    getSession: id => agentGraph?.maker.getSession(id),
    requestFileConfirmation: (id, payload) => fileConfirmation.request(id, payload),
    appContext: () => ({ ok: true, context: { region: resolveHostRegion(),
      locale: ghostAppContextLocale(Intl.DateTimeFormat().resolvedOptions().locale) } }),
    publish: (channel, payload) => {
      if (channel === MAKER_PUSH.INTERACTION_REQUEST || channel === MAKER_PUSH.INTERACTION_DISMISSED) {
        eventHub.publish({ ...(payload as Record<string, unknown>),
          type: channel === MAKER_PUSH.INTERACTION_REQUEST ? 'interaction_request' : 'interaction_dismissed' });
      } else eventHub.publish({ type: 'plugin_push', channel, payload });
    },
  });

  pluginGateway = createHostPluginGateway({ runtime: plugins, profileDir: dataDir, ownerId,
    version: layout.version, credentials, fileConfirmation,
    getSession: id => agentGraph?.maker.getSession(id),
    restoreSession: (id, check) => inputQueue.restoreSession(id, check),
    requestHostPermission: async (id, instance, request, signal) => {
      const session = agentGraph?.maker.getSession(id);
      if (!session || session.instanceId !== instance) return null;
      return interactionBroker.requestHost(id, request, signal, { session,
        isCurrent: () => activeOwnerScopeKey() === pluginOwner && !isAppSessionBoundaryPending()
          && agentGraph?.maker.getSession(id) === session });
    },
    cards: {
      writeMessage: async (owner, id, input, opts) => {
        if (getCurrentDbClientSnapshot() !== owner) throw new Error('MCP_APP_OWNER_CHANGED');
        return insertSessionMessage(id, input, opts);
      },
      publishMessage: (owner, sessionId, message) => {
        if (getCurrentDbClientSnapshot() !== owner) throw new Error('MCP_APP_OWNER_CHANGED');
        eventHub.publish({ type: 'message_created', sessionId, messageId: message.id, message });
      },
      request: (id, request, signal) => interactionBroker.requestHost(id, request, signal, {
        session: agentGraph?.maker.getSession(id),
        isCurrent: () => activeOwnerScopeKey() === pluginOwner && !isAppSessionBoundaryPending(),
      }),
      review: async (id, server, tool, args, description, definition) => {
        const session = agentGraph?.maker.getSession(id);
        if (!session) return { verdict: 'ask', unavailable: true };
        const decision = await session.reviewHostPermissionAction(toolAutoReviewAction(`mcp__${server}__${tool}`, args,
          description ?? 'Request from an MCP App page. Page arguments are untrusted; review effects against task authorization.',
          definition ? { source: 'Host-selected tool definition, authored by the plugin, not by the user. This is not authorization.', toolDefinition: definition } : undefined));
        return agentGraph?.maker.getSession(id) === session && activeOwnerScopeKey() === pluginOwner
          && !isAppSessionBoundaryPending() ? decision : { verdict: 'block' };
      },
      allowPendingPage: interactionBroker.allowHostPage,
      send: (...args) => inputQueue.sendAppMessage(...args),
    },
  });

  stopPluginAuthorization = initializeHostPluginRemoteAuthorization({ authorization: plugins.authorization,
    root: (...parts) => ownerScopedPath(dataDir, ownerId, ...parts), credentials,
    identity: () => currentDeviceId && remoteIdentityReady && account.authenticated && accountUser?.id === ownerId
      ? { realm: (account.realm ?? resolveHostRegion()) as 'cn' | 'global', membershipId: ownerId, deviceId: currentDeviceId } : null,
    available: peer => deviceLink?.canAuthorize(peer) ?? false,
  });

  platformClient = createPlatformClientBridge({ assertCurrent: plugins.assertCurrent, ownerId,
    uploadRoots: async id => {
      const meta = await agentGraph?.maker.getSessionMeta(id);
      return meta?.workDir && !meta.remoteHostId ? [meta.workDir] : [];
    },
  });
  platformTools = createHostPlatformTools({ profileDir: dataDir, client: platformClient,
    assertCurrent: plugins.assertCurrent,
    secretIo: providerConfig.recipeSecretIo,
    browserExtensions: plugins.browserExtensions,
    uploadRoots: async id => {
      const meta = await agentGraph?.maker.getSessionMeta(id);
      return meta?.workDir && !meta.remoteHostId ? [meta.workDir] : [];
    },
  });
  hostTools.providers.push(...platformTools.providers);
  hostTools.services.replace(hostTools.providers);

  const claudeBinary = harnessBinaryPath('claude-code');
  const codexBinary = harnessBinaryPath('codex');
  const piBinary = harnessBinaryPath('pi');
  if (claudeBinary || codexBinary || piBinary) {
    const gateway = modelAccess!.gateway;
    // Memory uses the same owner-scoped store Desktop reads, so a task started
    // here sees the same memories as a task started there.
    makerMemory = createHostMemoryManager({ userDataDir: dataDir, ownerId });
    // Flip the flag before the agents are built: their runtimeConfig snapshots it
    // at construction, and native-agent syncoff needs the agents that do not exist yet.
    if (makerMemory.isEnabled()) await makerMemory.enable({ skipAgentSync: true });
    mcpRuntime = createHostMcpRuntime({ appServerIds: pluginGateway.appServerIds,
      getRemoteMcpBridgeToken: providerConfig.remoteBridgeToken });
    if (codexBinary) codexRuntime = createHostCodexRuntime({ profileDir: dataDir, binaryPath: codexBinary,
      config: providerConfig, modelAccess: modelAccess!, availabilityPolicy: availabilityPolicy!, mcp: mcpRuntime,
      publish: (channel, payload) => eventHub.publish({ type: 'plugin_push', channel, payload }),
    });
    agentGraph = createHostAgentGraph({
      onSessionClose: (id: string) => platformTools?.closeSession(id),
      codexRuntime,
      providerConfig,
      mcpRuntime,
      isSessionInTurn: (id: string) => inputQueue.isTurnRunning(id),
      wakeSession: (id: string, reason: string) => inputQueue.wakeSession(id, reason),
      resolveProviderRoute: createProviderRouteResolver({
        catalog: () => listProviders({ gateway, ownerId }),
        store: await createCredentialStore({ userDataDir: dataDir }),
        ownerId,
      }),
      binaryPath: claudeBinary,
      codexBinaryPath: codexBinary ?? undefined,
      piBinaryPath: piBinary ?? undefined,
      storage: sessionStorage,
      gateway,
      makerMemory,
      mcpProviders: await pluginGateway.prepareMcpProviders([...hostTools.providers, ...createHostMemoryMcpProviders(makerMemory), pluginGateway.provider]),
      userDataDir: dataDir,
    });
    attachAgentsToMakerMemory(makerMemory, agentGraph.instances);
    agentAuth = createHostAgentAuth({ maker: agentGraph.maker, readApiKey: () => gateway?.credential ?? null,
      publish: (channel, payload) => eventHub.publish({ type: 'plugin_push', channel, payload }) });
    // Second step, now that the agents exist: turn their native memory off.
    if (makerMemory.isEnabled()) await makerMemory.enable();
    runtime.agents = [...agentGraph.agents];
    runtime.agentLane = currentGateway() ? 'gateway-key' : 'claude-subscription';

  }
  if (claudeBinary) {
    const ownerSession = activeOwnerScopeKey();
    void readClaudeSubscriptionState({ binary: claudeBinary, env: { PATH: process.env.PATH } })
      .then((state) => { if (activeOwnerScopeKey() === ownerSession) claudeState = state; })
      .catch((error: unknown) => {
        if (activeOwnerScopeKey() === ownerSession) claudeState = { error: error instanceof Error ? error.message : String(error) };
      });
  }
  await plugins.reconcile();
  await pluginGateway.refresh();
  runtime.state = 'ready';
}

const eventHub = createEventHub();
const taskTags = createTaskTagService({
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
  broadcastSessionPatched: (sessionId, patch, scope) => {
    if (scope && !isDataOwnerBroadcastScopeCurrent(scope)) return;
    eventHub.publish({ type: 'session_changed', sessionId, patch });
  },
  tapWindowBroadcast: (_channel, payload, ownerStamp) => {
    eventHub.publish({ type: 'task_tags_changed', payload, ownerStamp });
  },
});
const sessionDraftPorts = {
  emitSessionCreated: (sessionId: string) => eventHub.publish({ type: 'session_changed', action: 'create', sessionId }),
  emitSessionListChangedLocally: (sessionId: string) => eventHub.publish({ type: 'session_changed', action: 'delete', sessionId }),
  notifyPluginSessionCreated: (input: { sessionId: string; workdir?: string }) => eventHub.publish({ type: 'session_created', ...input }),
};
setSessionOpeningModelAdmission(async body => {
  const kind = body.agentKind === 'cc' ? 'claude-code' : body.agentKind;
  const snapshot = await listProviders({ gateway: currentGateway(), ownerId: runtime.owner });
  const execution = resolveSessionExecutionSelection({
    selection: body,
    availableAgents: agentGraph?.agents ?? [],
    availableModels: snapshot.providers.flatMap(provider => kind ? provider.models[kind] ?? [] : []),
    providerRouting: buildLocalProviderRoutingContext(snapshot.providers),
    hasCindyAiApiKey: currentGateway() !== null,
  });
  return { ...body, ...execution, effort: execution.effort ?? '',
    agentKind: execution.agentKind === 'claude-code' ? 'cc' : execution.agentKind };
});
// Read the same owner-scoped group facts as Desktop. Host does not yet have the
// assignment service, so no mutation port may report a successful group change.
const hostProviderGroups = createProviderGroupStore({
  withAvailabilityPolicyMutation: async () => { throw new Error('[UNSUPPORTED_CAPABILITY] Host cannot change provider groups'); },
});
const hostProviderBindings = createProviderGroupBindings(hostProviderGroups);
const readSessionForRun = async (sessionId: string) => {
  const db = getDbClient();
  const rows = await db.drizzle.select().from(sessionTable)
    .where(eq(sessionTable.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row || row.status !== 'active') throw new Error('session is not active');
  const [botLink] = await db.drizzle.select({ botId: botSessionLinks.botId })
    .from(botSessionLinks).where(eq(botSessionLinks.sessionId, sessionId)).limit(1);
  const agentKind = row.agentKind === 'codex' ? 'codex' : row.agentKind === 'pi' ? 'pi' : 'claude-code';
  return {
    id: row.id,
    status: row.status, source: row.source, botId: botLink?.botId ?? null,
    remoteHostId: row.remoteHostId, agentDeviceId: row.agentDeviceId,
    orcaRole: row.orcaRole, orcaRemoteLead: row.orcaRemoteLead,
    agentKind,
    model: row.model,
    workingDir: row.workingDir,
    providerId: row.providerId,
    sdkSessionId: row.sdkSessionId,
    effort: row.effort, permissionMode: row.permissionMode,
    fastMode: row.fastMode, planModeEnabled: row.planModeEnabled,
  };
};
/** Web client cross-engine switches: registered as an intent, applied on next enqueue. */
const pendingAgentSwitches = new Map<string, {
  targetAgentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
}>();

function projectAgentSwitchIntent(intent: {
  targetAgentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  providerId: string | null;
  effort?: string;
  fastMode?: boolean | 'ultrafast';
} | undefined): Record<string, unknown> | null {
  if (!intent) return null;
  return {
    targetAgentKind: intent.targetAgentKind,
    model: intent.model,
    providerId: intent.providerId,
    ...(intent.effort ? { effort: intent.effort } : {}),
    ...(intent.fastMode !== undefined ? { fastMode: intent.fastMode } : {}),
  };
}

async function applyPendingAgentSwitch(sessionId: string): Promise<void> {
  const intent = pendingAgentSwitches.get(sessionId);
  if (!intent) return;
  await serverDeps.updateSession(sessionId, {
    agentKind: intent.targetAgentKind,
    model: intent.model,
    providerId: intent.providerId,
    ...(intent.effort ? { effort: intent.effort } : {}),
    ...(intent.fastMode !== undefined ? { fastMode: intent.fastMode } : {}),
  });
  pendingAgentSwitches.delete(sessionId);
  eventHub.publish({ type: 'session_changed', sessionId, patch: { agentSwitchIntent: null } });
}
const interactionBroker = createInteractionBroker({ hub: eventHub });
const fileConfirmation = new GhostGrantConfirmBridge({
  broadcast: (channel, payload) => eventHub.publish({
    ...(payload as Record<string, unknown>),
    type: channel === MAKER_PUSH.INTERACTION_REQUEST ? 'interaction_request' : 'interaction_dismissed',
  }),
});
const interactions = {
  ...interactionBroker,
  pending: (sessionId: string) => [...interactionBroker.pending(sessionId),
    ...fileConfirmation.pendingSnapshots(sessionId).map(({ request }) => ({ requestId: request.requestId, request })),
    ...(plugins?.authorization.bridge.pendingSnapshots(sessionId) ?? []).map(({ request }) => ({ requestId: request.requestId, request }))],
  respond: (sessionId: string | null, requestId: string, decision: unknown) => {
    const pending = fileConfirmation.pendingSnapshots().find(item => item.request.requestId === requestId);
    if (pending) return (!sessionId || sessionId === pending.sessionId) && !isAppSessionBoundaryPending()
      && fileConfirmation.resolve(requestId, decision);
    const setup = plugins?.authorization.bridge.pendingSnapshots().find(item => item.request.requestId === requestId);
    if (setup) {
      const command = parseGhostSetupInteractionCommand(decision);
      return Boolean(command && (!sessionId || sessionId === setup.sessionId) && !isAppSessionBoundaryPending()
        && plugins?.authorization.bridge.resolve(requestId, command));
    }
    return interactionBroker.respond(sessionId, requestId, decision);
  },
  detach: (id: string, reason?: string) => {
    fileConfirmation.cleanupForSession(id, 'session_aborted');
    plugins?.authorization.bridge.cleanupForSession(id, 'session_aborted');
    interactionBroker.detach(id, reason);
  },
  cancelHostWaits: (id: string) => {
    fileConfirmation.cleanupForSession(id, 'session_aborted');
    plugins?.authorization.bridge.cleanupForSession(id, 'session_aborted');
  },
};
const insertSessionMessage = createHostMessageStore({ getOwner: getCurrentDbClientSnapshot,
  publish: (event: unknown) => eventHub.publish(event) });

const messageRecovery = createHostMessageRecovery({ getOwner: getCurrentDbClientSnapshot,
  publish: (event: unknown) => eventHub.publish(event) });

const inputQueue = createInputQueue({
  getOwner: getCurrentDbClientSnapshot,
  createAttachments: ({ assertCurrent }: { assertCurrent(): void }) => createHostAttachments({
    getOwner: getCurrentDbClientSnapshot, assertCurrent,
  }),
  interactions,
  getMaker: () => {
    if (!agentGraph) throw new Error('agent runtime is not ready');
    return agentGraph.maker;
  },
  hub: eventHub,
  hasPendingCredentialSwitch: (id: string) => agentGraph?.gatewayRestart.isSessionRestarting(id) ?? false,
  onSessionSettled: () => agentGraph?.gatewayRestart.onSessionSettled(),
  beforeSessionStart: async (_id: string, kind: string) => {
    if (kind === 'codex') await agentGraph?.gatewayRestart.flushBeforeLocalCodexSessionStart();
  },
  readSession: readSessionForRun,
  assertProviderExecutionSupported: (id: string, providerId?: string | null) => {
    if (hostProviderBindings.readProviderGroupBinding(id)
      || (providerId && hostProviderGroups.readProviderGroup(providerId))) {
      throw new Error('[UNSUPPORTED_CAPABILITY] Host does not yet support provider groups');
    }
  },
  readSessionExtraDirs: readSessionExtraDirsFromDb,
  readSessionWritableDirs: readSessionWritableDirsFromDb,
  readMcpAppModelContext: async (id: string) => (await pluginGateway?.modelContext(id))
    ?? { text: '', async assertCurrent() {}, consume() {} },
  ackInterruptedTurnDispatched: ackSessionTurnEndedDurable,
  ...messageRecovery,
  persistMessage: insertSessionMessage,
  persistQueueSnapshot: saveAgentInputQueueSnapshot,
  loadQueueSnapshot: loadAgentInputQueueSnapshot,
  getPersistedClientIds: getPersistedInputClientIds,
  markStarted: markSessionTurnStartedDurable,
  markEnded: async (sessionId: string, endedAt: number) => {
    markSessionTurnEnded(sessionId, endedAt);
    await drainSessionActiveTurnWrites(sessionId);
  },
  hasAssistantProgressAfter: hasAssistantProgressAfterMessage,
  getRecoveryContextSnapshot,
  loadClearBoundary: async (sessionId: string) => {
    const [row] = await getDbClient().drizzle.select({ clearedAt: sessionTable.clearedAt })
      .from(sessionTable).where(eq(sessionTable.id, sessionId)).limit(1);
    if (!row) throw new Error('session not found');
    return row.clearedAt;
  },
  touchUserSend: async (sessionId: string, atMs?: number) => {
    const owner = getCurrentDbClientSnapshot();
    if (!owner) throw new Error('DbClient not ready');
    const ts = typeof atMs === 'number' && Number.isFinite(atMs) && atMs > 0 ? Math.floor(atMs) : Date.now();
    const [row] = await touchUserSendRow(owner.client.drizzle, sessionId, ts);
    if (row && getCurrentDbClientSnapshot() === owner) eventHub.publish({ type: 'session_changed', sessionId,
      patch: { userSendAt: new Date(row.userSendAt!).toISOString(),
        lastActivityAt: new Date(row.lastActivityAt!).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() } });
  },
  sent: (sessionId: string) => commitProvisionalSession(sessionId, sessionDraftPorts),
});

const subagentReads = createSubagentReadService({
  getUserDataDir,
  isBoundaryPending: () => runtime.state !== 'ready',
  activeOwnerScopeKey: () => {
    const owner = getCurrentDbClientSnapshot();
    if (!owner) throw new Error('DbClient not ready');
    return `${owner.userId}:${owner.clientEpoch}`;
  },
  enqueueSessionWrite: (sessionId, label, write) => inputQueue.enqueueDurableWrite(sessionId, label, write),
  // Reading stored work must not advertise an unwired control operation.
  isParentPiSessionLive: () => false,
});

const apiToken = readOrCreateApiToken(resolveHostDataDir());
const webDir = process.env.CINDY_HOST_WEB_DIR?.trim()
  || layout.webDir;
/** The profile the browser client reads: same account, same files, no copy. */
function hostProfileInput() {
  return { dataDir: resolveHostDataDir(), ownerId: runtime.owner ?? null };
}

function currentProfileSettings() {
  return readProfileSettings(hostProfileInput());
}

function writeProfileAppearance(patch: unknown) {
  const applied = writeAppearanceSettingsPatch(
    hostProfileInput(),
    patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {},
  );
  eventHub.publish({ type: 'appearance_changed', appearance: applied });
  eventHub.publish({ type: 'settings_changed', domain: 'appearance', value: applied });
  return applied;
}

const serverDeps = {
  browserBackend: (handler: keyof NonNullable<typeof platformTools>['browserSettings'], payload: unknown) => {
    if (!platformTools) throw new Error('HOST_RUNTIME_NOT_READY');
    return platformTools.browserSettings[handler](undefined, payload);
  },
  executeTaskTags: taskTags.executeTaskTags,
  searchConversations: executeConversationSearch,
  rightSidebarTabs: createRightSidebarTabsService({
    getDb: () => getDbClient().drizzle,
    changed: sessionId => { eventHub.publish({ type: 'right_sidebar_tabs_changed', sessionId }); },
  }),
  instanceId,
  isOwnerReady: () => runtime.state === 'ready' && account.authenticated && !isAppSessionBoundaryPending(),
  requestStop: () => stop(),
  subagentRuns: subagentReads,
  token: apiToken,
  shimPath: layout.shimPath,
  shimPrebuilt: layout.packaged,
  // Inline the shared defaults so the synchronous snapshot API can answer.
  // The browser client reads the Desktop's own settings files, so the snapshot
  // it boots with is the same one the Desktop renders — never a host-side copy.
  bootValues: () => {
    const profile = currentProfileSettings();
    return {
      appVersion: layout.version,
      platform: process.platform,
      osRelease: os.release(),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      voiceInput: profile.voiceInput,
      harness: harnessStatus(),
      auth: account.authenticated && accountUser
        ? { user: accountUser, ownerId: runtime.owner }
        : {},
      appearance: profile.appearance,
      layout: profile.layout,
      sidebar: profile.sidebar,
      analytics: profile.analytics,
      appShortcuts: profile.appShortcuts,
    };
  },
  profile: async () => currentProfileSettings(),
  settings: {
    setAppearance: async (patch: unknown) => writeProfileAppearance(patch),
    resetAppearance: async () => writeProfileAppearance({ ...DEFAULT_APPEARANCE_SETTINGS }),
    setLayout: async (layout: unknown) => {
      const applied = writeLayout(hostProfileInput(), layout);
      eventHub.publish({ type: 'settings_changed', domain: 'layout', value: applied });
      return applied;
    },
    resetLayout: async () => {
      const applied = writeLayout(hostProfileInput(), createDefaultLayout());
      eventHub.publish({ type: 'settings_changed', domain: 'layout', value: applied });
      return applied;
    },
    setSidebar: async (value: unknown) => {
      const applied = writeSidebarSettings(hostProfileInput(), value);
      eventHub.publish({ type: 'settings_changed', domain: 'sidebar', value: applied });
      return applied;
    },
    setShortcuts: async (overrides: unknown) => {
      const applied = writeAppShortcutOverrides(hostProfileInput(), overrides);
      eventHub.publish({ type: 'settings_changed', domain: 'shortcuts', value: applied });
      return applied;
    },
  },
  // Resolved per request so a bundle built after startup is picked up.
  webDir: () => (existsSync(path.join(webDir, 'index.html')) ? webDir : null),
  probe: async () => ({
    status: 'ok',
    service: 'cindy-host',
    clientProtocol: 1,
    // Platform RPC now survives a client replacement, with live embedded pages
    // deferring it. Full daily-client migration still requires the production
    // adoption acceptance and feature parity (scheduler, companions and IM).
    // The isolated platform acceptance must not open the whole-client gate.
    clientHandoffReady: clientMigrationContract.ready,
    instanceId,
    pid: process.pid,
    region: resolveHostRegion(),
    dataDir: resolveHostDataDir(),
    runtime,
    remote: deviceLink?.state() ?? { enabled: false, status: 'offline' },
    account,
    harness: harnessStatus(),
    claude: claudeState,
    maker: agentGraph ? { agents: agentGraph.agents } : null,
    sessions: sessionStorage ? (await listActiveSessions(sessionStorage)).length : null,
  }),
  me: async () => ({
    owner: runtime.owner,
    authenticated: account.authenticated,
    realm: account.realm,
    user: accountUser,
  }),
  getAuthState: async () => { await startup; return projectAuthState(); },
  agentAuthState: async (kind: 'claude-code' | 'codex' | 'pi') => {
    if (!HARNESS_KINDS.includes(kind)) throw new Error('Invalid agent kind');
    if (!agentGraph?.instances[kind]) return { authenticated: false, errorReason: 'runtime_unavailable' };
    return agentGraph.maker.getAgentAuthState(kind);
  },
  agentStatus: async (kind: 'claude-code' | 'codex' | 'pi') => {
    if (!HARNESS_KINDS.includes(kind)) throw new Error('Invalid agent kind');
    return agentGraph?.maker.getAgentStatus(kind) ?? { binaryReady: false, binaryPath: null, authReady: false };
  },
  agentAuthInvoke: (channel: string, args: unknown[], caller: string) => {
    if (!agentAuth) throw new Error('Agent runtime is unavailable');
    return agentAuth.invoke(channel, args, caller);
  },
  releaseAuthCaller: (caller: string) => { agentAuth?.releaseCaller(caller); hostConfirmations?.cancelCaller(caller); },
  connectController: (caller: string, send: Parameters<NonNullable<typeof hostConfirmations>['connect']>[1]) =>
    hostConfirmations?.connect(caller, send),
  resolvePluginConfirmation: (caller: string, kind: 'confirm' | 'install', requestId: string, confirmed: boolean) =>
    hostConfirmations?.resolve(caller, kind, requestId, confirmed) ?? false,
  requestPluginTaskApproval: async (id: string, capability: string) => {
    const group = GHOST_HOST_TOOL_GROUPS.find(value => capability === `host-tools:${value}`);
    return { granted: !!group && !!hostTools && await hostTools.approveGroup(id, group, () => plugins?.current() === true, true) };
  },
  cancelPendingAuth: async () => {
    agentAuth?.close();
    await providerConfig?.cancelLogins();
  },
  listRunningSessions: (options: unknown) => listRunningSessions(agentGraph?.maker, options),
  refreshAuth: async () => {
    const ok = await refreshAuthSession();
    return { ok, ...projectAuthState() };
  },
  logout: async () => {
    await startup;
    authClosed = true;
    const releaseBoundary = beginAppSessionBoundary();
    try {
    await authRefreshFlight;
    const realm = (account.realm ?? resolveHostRegion()) as 'cn' | 'global';
    const endpoints = readAuthEndpoints(realm);
    const store = await createCredentialStore({
      userDataDir: resolveHostDataDir(),
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    });
    const { machineIdSync } = createRequire(import.meta.url)('node-machine-id');
    const client = new CindyAuthClient({
      baseUrl: endpoints.authApiBaseUrl,
      region: realm,
      deviceId: resolveSessionDevice(store.read(AUTH_SESSION_KEY), () => resolveRuntimeDeviceId(machineIdSync, '')),
      clientType: 'desktop',
      fetch: (input, init) => globalThis.fetch(input, init),
    });
    const result = await withCrossProcessLock(
      path.join(resolveHostDataDir(), '.cindy-auth-accounts-v1.lock'),
      { label: 'auth-account-vault', waitMs: 5000 },
      async (lock) => {
        if (!lock.held) throw new Error('Saved account credentials are busy; retry logout');
        return logoutHostSession({
          store, ownerId: accountUser?.id, passportId: accountUser?.passportId,
          refresh: (token) => client.refresh(token),
          logout: (accessToken) => client.logout(accessToken),
        });
      },
    );
    return result;
    } finally {
      try { await disposeOwnerRuntime(); }
      finally {
        commitVolatileAppSession('signed-out', null, true);
        releaseBoundary();
        eventHub.clear();
        eventHub.publish({ type: 'auth_changed', ...projectAuthState() });
      }
    }
  },
  listSessions: async (body?: Record<string, unknown>) => {
    if (!sessionStorage) return [];
    // A failed read must not replace an archived/pinned view with active-only
    // fallback data. The HTTP boundary reports the error and clients can retry.
    return readHostSessionList(getDbClient().drizzle, body);
  },
  // Project aliases are rows in the same owner database; the sidebar groups by
  // them on both clients, so they come straight from that table.
  listProjectAliases: async () => {
    const rows = await getDbClient().drizzle.select().from(projectAliasTable);
    return rows.map((row: Record<string, unknown>) => ({
      projectKey: String(row.projectKey ?? ''),
      alias: String(row.alias ?? ''),
      updatedAt: new Date(Number(row.updatedAt ?? 0)).toISOString(),
    }));
  },
  setProjectAlias: async (input: { projectKey?: unknown; alias?: unknown }) => {
    const { upsertProjectAlias } = await import('../../desktop/src/main/localDb/ipc/projectAliasesCore.ts');
    const result = await upsertProjectAlias(input.projectKey, input.alias);
    eventHub.publish({ type: 'project_aliases_changed' });
    return result;
  },
  deleteProjectAlias: async (input: { projectKey?: unknown }) => {
    const { deleteProjectAlias } = await import('../../desktop/src/main/localDb/ipc/projectAliasesCore.ts');
    await deleteProjectAlias(input.projectKey);
    eventHub.publish({ type: 'project_aliases_changed' });
    return { ok: true };
  },
  listRecentWorkdirs: async () => {
    const { listRecentWorkdirs } = await import('../../desktop/src/main/localDb/ipc/recentWorkdirsCore.ts');
    return listRecentWorkdirs();
  },
  interruptedPending: async () => {
    const { listInterruptedPendingRows } = await import('../../desktop/src/main/localDb/sessionActiveTurn.ts');
    return (await listInterruptedPendingRows({ includeBotTasks: false })).map((row) => row.sessionId);
  },
  errorTailPending: async () => {
    const { listErrorTailPendingSessionIds } = await import('../../desktop/src/main/localDb/sessionActiveTurn.ts');
    return listErrorTailPendingSessionIds();
  },
  interruptedCandidates: async () => {
    const { listInterruptedResumeCandidateRows } = await import('../../desktop/src/main/localDb/interruptedResumeCandidates.ts');
    const rows = await listInterruptedResumeCandidateRows(() => false);
    return rows.map((row) => ({
      sessionId: row.sessionId,
      interruptedAt: row.interruptedAt,
      activity: row.lastToolUse?.toolName ?? null,
    }));
  },
  updateSession: async (sessionId: string, patch: Record<string, unknown>) => {
    const allowed: Record<string, true> = {
      title: true, status: true, pinnedAt: true, notificationsMuted: true, model: true,
      effort: true, permissionMode: true, fastMode: true, planModeEnabled: true,
      providerId: true, agentKind: true,
    };
    if (Object.keys(patch).some((key) => allowed[key] !== true)) {
      throw new Error('unsupported session field');
    }
    // A live Session keeps its own permission mode and model route. Apply the
    // change there first so the stored value and the running Agent cannot
    // disagree (a tighter mode must bind the very next tool call). An engine
    // switch is left to the input queue, which recreates the Session.
    const live = patch.agentKind === undefined ? agentGraph?.maker.getSession(sessionId) : undefined;
    const stored = live && patch.model === undefined && Object.hasOwn(patch, 'providerId')
      ? await readSessionForRun(sessionId) : null;
    await applyLiveSessionSettings(live, patch, stored);
    const update: Record<string, unknown> = { updatedAt: Date.now() };
    if (typeof patch.title === 'string') update.title = patch.title;
    if (patch.status === 'active' || patch.status === 'archived') update.status = patch.status;
    if (patch.pinnedAt === null) update.pinnedAt = null;
    else if (typeof patch.pinnedAt === 'string') update.pinnedAt = Date.parse(patch.pinnedAt) || null;
    if (typeof patch.notificationsMuted === 'boolean') update.notificationsMuted = patch.notificationsMuted;
    if (typeof patch.model === 'string') update.model = patch.model;
    if (typeof patch.effort === 'string') update.effort = patch.effort;
    if (typeof patch.permissionMode === 'string') update.permissionMode = patch.permissionMode;
    if (typeof patch.fastMode === 'boolean' || patch.fastMode === 'ultrafast') update.fastMode = patch.fastMode;
    if (typeof patch.planModeEnabled === 'boolean') update.planModeEnabled = patch.planModeEnabled;
    if (patch.providerId === null || typeof patch.providerId === 'string') update.providerId = patch.providerId;
    if (typeof patch.agentKind === 'string') update.agentKind = patch.agentKind === 'claude-code' ? 'cc' : patch.agentKind;
    await getDbClient().drizzle.update(sessionTable).set(update).where(eq(sessionTable.id, sessionId));
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error('session not found');
    eventHub.publish({ type: 'session_changed', action: 'update', sessionId, patch, status: row.status });
    return sessionToCamel({ ...row, messageCount: 0 });
  },
  /**
   * Cross-engine switch: record the intent and let the next enqueue apply it.
   * Mirrors the desktop contract (`deferred: true`) so the renderer can show
   * the target engine optimistically without reporting "未生效".
   */
  switchSessionAgent: async (
    sessionId: string,
    targetAgentKind: string,
    model: string,
    providerId: string | null,
    effort?: string,
    fastMode?: boolean | 'ultrafast',
  ) => {
    const rows = await getDbClient().drizzle.select({ id: sessionTable.id }).from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    if (!rows[0]) throw new Error('session not found');
    if (!model) throw new Error('model is required');
    const intent = {
      targetAgentKind: targetAgentKind === 'codex' ? 'codex' : targetAgentKind === 'pi' ? 'pi' : 'claude-code',
      model,
      providerId: providerId ?? null,
      ...(typeof effort === 'string' && effort ? { effort } : {}),
      ...(fastMode === true || fastMode === false || fastMode === 'ultrafast' ? { fastMode } : {}),
    } as const;
    pendingAgentSwitches.set(sessionId, intent);
    eventHub.publish({
      type: 'session_changed',
      sessionId,
      patch: { agentSwitchIntent: projectAgentSwitchIntent(intent) },
    });
    return {
      switched: false,
      agentKind: intent.targetAgentKind,
      model: intent.model,
      engineReady: true,
      deferred: true,
    };
  },
  getSessionAgentSwitchIntent: (sessionId: string) => (
    projectAgentSwitchIntent(pendingAgentSwitches.get(sessionId))
  ),
  /**
   * Auto-title step 1 (Codex-style immediate placeholder): persist the
   * normalized first user text while the title is still the default sentinel.
   * The desktop's smart-title model pass stays desktop-owned; the web client
   * still gets the visible sidebar update D3 expects.
   */
  autoTitle: async (input: { sessionId?: unknown; text?: unknown; isUserText?: unknown }) => {
    const sessionId = String(input.sessionId ?? '');
    const text = typeof input.text === 'string' ? input.text : '';
    const seed = normalizeAutoTitle(text);
    if (!sessionId || !seed) return { applied: false, done: false };
    const rows = await getDbClient().drizzle.select({ title: sessionTable.title }).from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const current = rows[0]?.title ?? null;
    if (current === null || !isDefaultDraftSessionTitle(current)) {
      return { applied: false, done: true };
    }
    await getDbClient().drizzle.update(sessionTable)
      .set({ title: seed, updatedAt: Date.now() })
      .where(and(eq(sessionTable.id, sessionId), eq(sessionTable.title, current)));
    const after = await getDbClient().drizzle.select({ title: sessionTable.title }).from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const applied = after[0]?.title === seed;
    if (applied) eventHub.publish({ type: 'session_changed', sessionId, patch: { title: seed } });
    return { applied, done: applied };
  },
  getSession: async (sessionId: string) => {
    return readHostSession(getDbClient().drizzle, sessionId);
  },
  deleteSession: async (sessionId: string) => {
    if (!sessionStorage) throw new Error('agent runtime is not ready');
    const existing = await sessionStorage.get(sessionId);
    if (!existing) return { deleted: false, sessionId };
    await inputQueue.disposeSession(sessionId);
    pendingAgentSwitches.delete(sessionId);
    await sessionStorage.delete(sessionId);
    forgetProvisionalSession(sessionId);
    eventHub.publish({ type: 'session_changed', action: 'delete', sessionId, status: 'deleted' });
    return { deleted: true, sessionId };
  },
  discardProvisionalSession: async (sessionId: string) => {
    // Only an unsent draft may be closed: a late request for a task another
    // client already sent must leave its queue running.
    if (!isProvisionalSession(sessionId)) {
      return { discarded: false, remaining: Boolean(await sessionStorage?.get(sessionId)) };
    }
    await inputQueue.disposeSession(sessionId);
    pendingAgentSwitches.delete(sessionId);
    const discarded = await discardProvisionalSessionRow(sessionId, sessionDraftPorts);
    return { discarded, remaining: Boolean(await sessionStorage?.get(sessionId)) };
  },
  commitProvisionalSession: async (sessionId: string) => ({
    committed: await commitProvisionalSession(sessionId, sessionDraftPorts),
  }),
  createSession: async (input: Record<string, unknown>) => {
    if (!agentGraph || !sessionStorage) throw new Error('agent runtime is not ready');
    const allowed: Record<string, true> = {
      id: true, title: true, workingDir: true, model: true, effort: true, permissionMode: true,
      fastMode: true, planModeEnabled: true, agentKind: true, providerId: true, provisional: true,
      workspaceKind: true, projectDir: true, extraDirs: true, writableDirs: true,
    };
    if (Object.keys(input).some((key) => allowed[key] !== true)) throw new Error('unsupported session field');
    if (typeof input.workingDir === 'string' && input.workingDir.trim()) {
      if (!path.isAbsolute(input.workingDir) || !(await statWorkingDirectory(input.workingDir)).isDirectory()) {
        throw new Error('working directory must exist and be absolute');
      }
    } else if (input.workspaceKind !== 'dialogue') {
      throw new Error('choose a project directory or create a dialogue task');
    }
    const row = await createUserSession({ ...input, agentKind: input.agentKind === 'claude-code' ? 'cc' : input.agentKind }, {
      // HTTP has no native folder-picker proof. The shared service rejects new
      // writable roots until a trusted directory-grant flow supplies one.
      senderId: 0, userDataDir: profileDir,
      notifyPluginSessionCreated: sessionDraftPorts.notifyPluginSessionCreated,
    });
    // Connected clients refresh their task list from this event. An unsent
    // draft announces itself when it is sent (commit), not here.
    if (input.provisional !== true) {
      eventHub.publish({ type: 'session_changed', action: 'create', session: row, sessionId: row.id });
    }
    return row;
  },
  chat: createChatHandler({
    readSession: (id: string) => sessionStorage?.get(id),
    createSession: (body: Record<string, unknown>) => serverDeps.createSession(body),
    enqueue: (id: string, input: unknown) => inputQueue.enqueue(id, input),
    inputStatus: (id: string, clientId: string) => inputQueue.inputStatus(id, clientId),
    events: eventHub,
    defaultModel: process.env.CINDY_HOST_MODEL?.trim(),
  }),
  providers: () => listProviders({ gateway: currentGateway(), ownerId: runtime.owner }),
  // The agent's own capability descriptor; no second catalog is invented here.
  // Gateway credential state, reported from the same facts the runtime uses.
  // The renderer asks this synchronously at boot; the desktop proxies it from
  // here so both clients start from the same visibility-owner facts.
  modelVisibilityClaim: () => ({
    dataOwnerId: runtime.owner,
    ownerGeneration: getActiveAppSession().generation,
    canWriteOwnerScoped: Boolean(runtime.owner),
    // The host holds the profile lease, so it is the owner of the legacy
    // renderer namespace; a fresh client can then finish its first-run
    // migration instead of staying pending forever.
    claimed: Boolean(runtime.owner),
    claimedByOtherOwner: false,
    canInitialize: false,
    profileOrigin: 'existing',
  }),
  modelAccess: () => modelAccess?.sync.getStatus() ?? { state: 'idle', source: null, endpoint: null, accountTier: null },
  retryModelAccess: () => {
    if (!modelAccess) throw new Error('Model access is not initialized');
    return modelAccess.sync.retry();
  },
  codexRuntimeRoute: () => {
    if (!codexRuntime) throw new Error('Codex runtime is not available');
    return codexRuntime.readRoute();
  },
  modelPricing: async () => null,
  referenceModelPricing: () => ({}),
  agents: () => agentGraph?.agents ?? [],
  events: eventHub,
  input: {
    ...inputQueue,
    projection: (sessionId: string) => inputQueue.getProjection(sessionId),
    enqueue: async (sessionId: string, item: Record<string, unknown>) => {
      await applyPendingAgentSwitch(sessionId);
      return inputQueue.enqueue(sessionId, item);
    },
  },
  interactions,
  agentCommands: async (input: { agentKind?: string }) => {
    const rawKind = String(input.agentKind ?? '');
    const kind = rawKind === 'codex' ? 'codex' : rawKind === 'pi' ? 'pi' : 'claude-code';
    const agent = agentGraph?.instances?.[kind];
    if (!agent) return { success: false, error: `Agent '${kind}' is not registered` };
    return { success: true, commands: agent.listAgentCommands() };
  },
  agentSkills: async (input: { agentKind?: string; workingDir?: string; sessionId?: string }) => {
    const rawKind = String(input.agentKind ?? '');
    const kind = rawKind === 'codex' ? 'codex' : rawKind === 'pi' ? 'pi' : 'claude-code';
    const agent = agentGraph?.instances?.[kind];
    if (!agent) return { success: false, error: `Agent '${kind}' is not registered` };
    const stored = input.sessionId ? await sessionStorage?.get(input.sessionId) : null;
    if (input.sessionId && !stored) throw new Error('session not found');
    const workingDir = stored?.workDir || input.workingDir || undefined;
    if (workingDir && !path.isAbsolute(workingDir)) throw new Error('workingDir must be absolute');
    const result = await agent.listAgentSkills({ workingDir });
    return { success: true, skills: result.skills ?? [] };
  },
  capabilities: async (agentKind: string) => {
    const kind = agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : 'claude-code';
    const baseCaps = agentGraph?.capabilitiesByAgent?.[kind];
    if (!baseCaps) throw new Error(`Agent '${kind}' is not registered`);
    const providerSnapshot = await listProviders({ gateway: currentGateway(), ownerId: runtime.owner });
    const allModelsForAgent = providerSnapshot.providers.flatMap((provider) => provider.models?.[kind] ?? []);
    const seen = new Set<string>();
    const availableModels = [];
    for (const model of allModelsForAgent) {
      if (!seen.has(model.id)) {
        seen.add(model.id);
        availableModels.push({
          id: model.id,
          displayName: model.name ?? model.id,
          contextWindow: model.contextWindow ?? 0,
          efforts: model.efforts ?? [],
          defaultEffort: model.defaultEffort ?? null,
          supportsFastMode: model.supportsFastMode,
          supportsImageInput: model.supportsImageInput,
          supportsToolCalls: model.supportsToolCalls,
        });
      }
    }
    return {
      agentKind,
      ...baseCaps,
      availableModels,
      capabilities: { ...baseCaps, availableModels },
      supportsSessionAgentSwitch: true,
      supportsModelWindowSwitchGuard: true,
      supportsSessionAgentSwitchCas: true,
      supportsOrcaWorkerPermissionMode: false,
      supportsOrcaWorkerUpdate: false,
    };
  },
  createMessage: insertSessionMessage,
  // Usage totals come from the same session row the task list reads; the
  // per-message breakdown stays with the windowed reader (host TODO).
  estimatedSessionValue: async (sessionId: string) => {
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row) throw new Error('session not found');
    return { totalValueUsd: row.totalCostUsd, entries: [] };
  },
  historyView: async (sessionId: string, before?: string | null) => {
    return hostHistoryReader.page(sessionId, before ?? undefined, true);
  },
  workDetails: async (sessionId: string, ref: unknown, after?: string | null) => {
    return hostHistoryReader.details(sessionId, ref as any, after ?? undefined);
  },
  messagesAroundClientId: async (sessionId: string, clientId: string, opts?: { radius?: number }) => {
    return readMessagesAroundClientId(sessionId, clientId, opts);
  },
  messagesList: async (sessionId: string, limit?: number, before?: string | null) => {
    return readMessagesList(sessionId, { limit: limit ?? 200, before: before ?? undefined });
  },
  history: async (sessionId: string, limit: number) => {
    return readMessagesList(sessionId, { limit });
  },
  turnChangeSets: async (sessionId: string) => {
    const { listTurnChangeSets } = await import('../../desktop/src/main/turn-change-set/store.ts');
    return listTurnChangeSets(sessionId);
  },
  ghosts: () => plugins?.list() ?? [],
  pluginRuntimeStates: () => plugins?.runtimeStates() ?? { states: {} },
  getPluginCard: async (callId: string) => ({ card: await getGhostCard(callId) }),
  listPluginCards: async (sessionId: string) => ({ cards: await listGhostCardsBySession(sessionId) }),
  setPluginEnabled: (id: string, enabled: boolean, approval?: string) => {
    if (!plugins) throw new Error('Plugin runtime is not ready');
    return plugins.setEnabled(id, enabled, approval);
  },
  listPlugins: () => (runtime.owner
    ? listInstalledPlugins(resolveHostDataDir(), runtime.owner)
    : { plugins: [], namespace: 'canonical', legacyNamespacePresent: false }),
};

function projectAuthState() {
  const authenticated = Boolean(account.authenticated && accountUser && accountUser.id === runtime.owner);
  return {
    authenticated, isAuthenticated: authenticated, user: authenticated ? accountUser : null,
    realm: account.realm, owner: runtime.owner, dataOwnerId: authenticated ? runtime.owner : null,
    mode: authenticated ? 'cloud' : 'signed-out', canEnterApp: authenticated,
    ownerGeneration: getActiveAppSession().generation, isCanary: false, deviceId: currentDeviceId,
    hasAccountDeletionReceipt: false, accountDeletionRestored: false,
    credentialStoreUnavailable: Boolean(account.error),
  };
}

/** Ordered disposal also runs after partial startup or a failed sign-out. */
async function disposeOwnerRuntime(): Promise<void> {
  const remote = deviceLink;
  deviceLink = null;
  remoteIdentityReady = false;
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  const errors: unknown[] = [];
  const attempt = async (operation: () => unknown) => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  try {
    // Keep storage alive until all execution and memory writers have settled,
    // but still release every resource when any individual teardown fails.
    fileConfirmation.cleanupAll('session_closed');
    hostConfirmations?.close(); hostTools?.close();
    stopPluginAuthorization?.(); stopPluginAuthorization = null;
    interactionBroker.dispose();
    await attempt(() => agentAuth?.close());
    await attempt(() => modelAccess?.close());
    agentGraph?.gatewayRestart.clear();
    await attempt(() => providerConfig?.close());
    const stopPlugins = plugins?.close();
    const stopApps = pluginGateway?.close();
    // Attach a rejection handler immediately while other services drain.
    const drainedPlugins = stopPlugins?.then(() => {}, error => { errors.push(error); });
    const drainedApps = stopApps?.then(() => {}, error => { errors.push(error); });
    await attempt(() => remote?.stop());
    // Settle disconnected platform calls before Maker awaits task-close hooks.
    // Client-owned OS sessions are released by its authenticated socket teardown.
    platformClient?.close();
    await attempt(() => inputQueue.dispose());
    await attempt(() => (agentGraph?.maker as { shutdown?: () => Promise<void> } | undefined)?.shutdown?.());
    await attempt(() => codexRuntime?.close());
    await attempt(() => mcpRuntime?.close());
    platformClient?.close(); platformClient = null;
    await attempt(() => platformTools?.close());
    await attempt(closeClaudeCliProxyBridge);
    await attempt(() => makerMemory?.dispose());
    await attempt(() => drainedPlugins);
    await attempt(() => drainedApps);
    pluginManager?.disposeNotificationIndex();
    await attempt(() => closeStorage?.());
  } finally {
    platformTools = null;
    plugins = null;
    pluginGateway = null;
    pluginManager = null;
    hostTools = null;
    hostConfirmations = null;
    agentGraph = null;
    mcpRuntime = null;
    codexRuntime = null;
    providerConfig = null;
    agentAuth = null;
    modelAccess = null;
    availabilityPolicy = null;
    makerMemory = null;
    closeStorage = null;
    sessionStorage = null;
    activeOwner = null;
    accountUser = null;
    currentSessionToken = null;
    currentDeviceId = null;
    claudeState = null;
    account = { authenticated: false, realm: account.realm };
    await attempt(() => runtimeLease?.release());
    runtimeLease = null;
    runtime.state = 'uninitialized';
    runtime.storage = 'unopened';
    runtime.owner = null;
  }
  if (errors.length) throw new AggregateError(errors, 'Owner runtime cleanup failed');
}
let startup: Promise<void> = Promise.resolve();

const service = createHostService(serverDeps);
const server = createHostServer({ ...serverDeps, service, platformClient: () => platformClient,
  remoteControl: async (action: string, body: { deviceId?: string }) => {
    if (!deviceLink) throw new Error('Sign in and start the Host runtime first');
    if (action === 'status') return deviceLink.state();
    if (action === 'enable' || action === 'disable') return deviceLink.setEnabled(action === 'enable');
    if (action === 'revoke') return deviceLink.revoke(body.deviceId ?? '');
    throw new Error('Unknown remote control command');
  },
});

function startDeviceLink(): void {
  if (deviceLink) return;
  const endpoint = readAuthEndpoints(account.realm === 'cn' ? 'cn' : 'global').deviceLinkApiBaseUrl;
  if (!endpoint) throw new Error('The endpoint manifest does not contain a Device Link relay');
  deviceLink = createHostDeviceLink({
    profileDir, version: layout.version,
    mcpApps: pluginGateway ?? undefined,
    releaseAuthCaller: caller => agentAuth?.releaseCaller(caller),
    getWsUrl: () => endpoint.replace(/^https:/, 'wss:') + '/api/device-link/ws',
    getToken: async () => currentSessionToken,
    refreshToken: async () => { await refreshAuthSession(); },
    canRegister: () => remoteIdentityReady && account.authenticated && !authClosed,
    invoke: service, subscribe: eventHub.subscribe,
    createRuntimeSession: async input => {
      const scope = activeOwnerScopeKey();
      const opts = readHostCreateSessionOpts(input, ensureDialogueWorkspaceDir);
      // These routes need separate execution services; never reinterpret a remote
      // task or Orca worker as an ordinary local task.
      if (opts.remoteHostId || opts.agentDeviceId || opts.orcaRole)
        throw new Error('[NOT_SUPPORTED] This execution route is not assembled in the Host yet');
      const row = await serverDeps.createSession({
        id: opts.id, agentKind: opts.agentKind, workingDir: opts.workingDir,
        workspaceKind: opts.workspaceKind, model: opts.model,
        permissionMode: opts.permissionMode, effort: opts.effort, providerId: opts.providerId,
        fastMode: opts.fastMode, planModeEnabled: opts.planMode,
        extraDirs: opts.extraDirs, writableDirs: opts.writableDirs,
      });
      if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending() || !agentGraph) throw new Error('Host account changed');
      const session = await agentGraph.maker.createSession({ ...opts, id: row.id });
      if (activeOwnerScopeKey() !== scope || isAppSessionBoundaryPending()) throw new Error('Host account changed');
      return { sessionId: session.id, agentKind: session.agentKind, workDir: session.workDir,
        capabilities: session.capabilities, usedProjectContext: false };
    },
    availabilityPolicy: availabilityPolicy ?? undefined,
    disableShareAvailability,

  });
}

async function disableShareAvailability(shareId: string) {
  const baseUrl = readAuthEndpoints(account.realm === 'cn' ? 'cn' : 'global').deviceLinkApiBaseUrl;
  if (!baseUrl) throw new Error('Device Link endpoint is unavailable');
  await serverApi(`/api/device-link/provider-shares/availability/${encodeURIComponent(shareId)}/disable`, {
    baseUrl, method: 'POST', body: {}, redactErrorDetails: true,
  });
}

server.on('error', (error) => {
  console.error(`cindy-host failed to listen: ${error.message}`);
  process.exitCode = 1;
  stop();
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Host listener address is unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  // Endpoint discovery for clients on this machine: a pid plus the loopback URL.
  // Explicit clients and host:open use this endpoint; desktop startup stays unchanged.
  try {
    removeEndpoint = publishHostEndpoint(profileDir, baseUrl, instanceId);
  } catch (error) {
    console.error('cindy-host discovery failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    stop();
    return;
  }
  console.log(`cindy-host listening on ${baseUrl}`);
  // Packaged logging captures console.* to disk. Operators and service
  // supervisors still need the non-secret loopback readiness address on stdout.
  process.stdout.write(`cindy-host listening on ${baseUrl}\n`);
  startup = (async () => {
    let owner = process.env.CINDY_HOST_OWNER?.trim() || '';
    let initialUser: AccountUser | null = null;
    if (!owner) {
      const discovered = discoverHostOwner(resolveHostDataDir());
      if (discovered.ownerId) {
        owner = discovered.ownerId;
        if (!existsSync(ownerDatabasePath(resolveHostDataDir(), owner))) throw new Error('owner database is missing');
      } else {
        // A newly signed-in preview has credentials but no database yet. Resolve
        // the authenticated membership before creating its first owner database;
        // never invent an owner or copy the running desktop's account files.
        const state = await readAdoptedSessionState({ userDataDir: resolveHostDataDir() });
        account = { authenticated: false, realm: state.realm };
        if (state.authenticated) initialUser = await resolveAccountUser();
        if (!initialUser) { runtime.detail = discovered.reason ?? 'owner is unknown'; return; }
        owner = initialUser.id;
      }
    }
    if (initialUser) {
      accountUser = initialUser;
      account = { authenticated: true, realm: account.realm };
    }
    await ensureRuntime(owner);
    startDeviceLink();
    if (account.authenticated) { schedulePeriodicRefresh(); return; }
    const state = await readAdoptedSessionState({
      userDataDir: resolveHostDataDir(),
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    });
    account = { authenticated: false, realm: state.realm };
    if (state.authenticated && await refreshAuthSession()) schedulePeriodicRefresh();
  })().catch(async (error: unknown) => {
    const blocked = runtime.state === 'blocked';
    try { await disposeOwnerRuntime(); }
    catch (cleanupError) { console.error('cindy-host startup cleanup failed:', cleanupError); }
    finally { commitVolatileAppSession('signed-out', null, true); }
    runtime.state = blocked ? 'blocked' : 'error';
    runtime.detail = error instanceof Error ? error.message : String(error);
    console.error('cindy-host initialization failed:', runtime.detail);
  });
});

let shuttingDown = false;
const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  authClosed = true;
  if (refreshTimer) clearInterval(refreshTimer);
  const requestsDrained = server.stopAccepting();
  const releaseOwnerBoundary = beginAppSessionBoundary();
  void (async () => {
    try {
      // Always drain every in-flight writer before releasing the profile lease,
      // including when another startup/auth operation rejected.
      const settled = await Promise.allSettled([startup, authRefreshFlight, requestsDrained]);
      const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
      try { await disposeOwnerRuntime(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Host shutdown did not complete cleanly');
    } finally {
      server.closeAllConnections();
      try {
        commitVolatileAppSession('signed-out', null, true);
        releaseOwnerBoundary();
        workdirProbeHostClient.dispose();
        runtimeLease?.release();
        releaseService();
      } finally { process.removeListener('exit', releaseService); }
    }
  })().catch((error) => {
    console.error('cindy-host shutdown failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
}
