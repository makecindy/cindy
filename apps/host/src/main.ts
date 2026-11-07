import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { getDefaultVoiceInputSettings } from '../../desktop/src/shared/voiceInputData.ts';
import { DEFAULT_APPEARANCE_SETTINGS } from '../../desktop/src/shared/appearanceSettings.ts';
import { createDefaultLayout } from '../../desktop/src/shared/layoutTree.ts';

import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.js';
import { OwnerSessionStorage } from '../../desktop/src/main/localDb/sessionStorageAdapter.js';
import { getDbClient, setCurrentDbClient, clearCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { AGENT_BINARY_LAYOUT, readCachedBinaryStatus } from '../../desktop/src/main/agent-binaries/binaryStatus.js';
import { openOwnerDatabase, OwnerDatabaseError } from '../../desktop/src/main/localDb/startupCore.js';
import { discoverHostOwner, ownerDatabasePath, resolveHostDataDir, resolveHostRegion } from './profile-path.mjs';
import { acquireHostRuntimeLease, type HostRuntimeLease } from './runtime-lock.js';
import { readAdoptedSessionState } from './credentials/session.mjs';
import { refreshHostSession } from './auth/refresh.mjs';
import { configureHostOwner, readClaudeSubscriptionState } from './agent/claude-auth.mjs';
import { attachAgentsToMakerMemory, createHostMemoryManager, createHostMemoryMcpProviders } from './agent/memory.mjs';
import { createHostAgentGraph } from './agent/runtime.mjs';
import { readGatewayCredentials, fetchGatewayCredentials } from './agent/gateway.mjs';
import { listProviders } from './agent/providers.mjs';
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
import { listInstalledGhosts } from './plugins-installed.ts';
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
import { createSnapshotProcess } from './snapshot-process.mjs';
import { configureGhostSnapshotProcess } from '../../desktop/src/main/cindy-brain/ghostSnapshotCapability.js';
import { withCrossProcessLock } from '../../desktop/src/main/device-link/crossProcessLock.js';
import { createChatHandler } from './chat.mjs';
import { createEventHub } from './events.mjs';
import { createInputQueue } from './agent/input-queue.mjs';
import { applyLiveSessionSettings } from './agent/session-settings.mjs';
import { createInteractionBroker } from './agent/interactions.mjs';
import { messageToCamel, sessionToCamel } from '../../desktop/src/main/localDb/mapper.ts';
import { selectSessionListRows, flattenSessionReadRow, ordinaryTaskListFilter } from '../../desktop/src/main/localDb/sessionQueries.js';
import { messages as messageTable, projectAliases as projectAliasTable, sessions as sessionTable } from '../../desktop/src/main/localDb/schema.js';
import { and, eq, isNull, ne } from 'drizzle-orm';
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
  console.log('Usage: cindy-host [serve|login [--region=cn|global] [--method=<id>]|status [--json]]');
} else if (command === 'status') {
  // Sanitized login state for scripts and for the operator: never tokens.
  try {
    const state = await readAdoptedSessionState({
      userDataDir: resolveHostDataDir(),
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    });
    const json = process.argv.includes('--json');
    if (json) {
      console.log(JSON.stringify(state));
    } else {
      console.log(`authenticated: ${state.authenticated}`);
      console.log(`realm: ${state.realm ?? 'none'}`);
    }
  } catch (error) {
    console.error(`cindy-host status failed: ${error instanceof Error ? error.message : String(error)}`);
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
    `unknown command: ${command}\nusage: cindy-host [serve|login [--region=cn|global] [--method=<id>]|status [--json]]`,
  );
  process.exitCode = 2;
} else {
const PORT = Number(process.env.CINDY_HOST_PORT ?? '3456');
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('CINDY_HOST_PORT must be a valid port');
/** Repo layout: apps/host/src → apps/desktop/{drizzle,native}. */
const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../desktop');

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
    devCandidates: [path.join(desktopRoot, '..', layout.dir, platformKey, layout.file)],
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
        path.join(desktopRoot, '..', layout.dir, platformKey, layout.file),
      ].map((candidate) => path.resolve(candidate)),
    });
    return [kind, status.binaryReady];
  }));
}
/**
 * The Desktop's `AuthState.user` projection, resolved from the same adopted
 * session so the browser identifies the account exactly like the client does.
 */
interface AccountUser {
  id: string;
  name: string;
  avatar: string | null;
  email: string | null;
  defaultModel: string;
  defaultEffort: string;
  membershipKind: 'personal' | 'org';
  membershipRole: 'owner' | 'admin' | 'member';
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  orgSlug: string | null;
  passportId: string;
}

/** Same defaults the Desktop applies when an account has no stored preference. */
const ACCOUNT_DEFAULT_MODEL = 'claude-sonnet-4-6';
const ACCOUNT_DEFAULT_EFFORT = 'medium';

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
  const client = new CindyAuthClient({
    baseUrl: endpoints.authApiBaseUrl,
    region: realm,
    deviceId: machineIdSync(),
    clientType: 'desktop',
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const { sessionToken } = await refreshHostSession({
    store,
    refresh: (token) => client.refresh(token),
  });
  const me = await client.getMe(sessionToken) as Record<string, any>;
  const membership = me?.membership as Record<string, any> | undefined;
  if (!membership || typeof membership.id !== 'string' || !membership.id) return null;
  if (expectedOwner && expectedOwner !== membership.id) throw new Error('The signed-in account does not match the active Host profile');
  currentSessionToken = sessionToken;
  const email = typeof membership.email === 'string' ? membership.email : null;
  const displayName = typeof membership.displayName === 'string' ? membership.displayName : '';
  return {
    id: membership.id,
    name: displayName || email || 'Cindy',
    avatar: typeof membership.avatarUrl === 'string' ? membership.avatarUrl : null,
    email,
    defaultModel: ACCOUNT_DEFAULT_MODEL,
    defaultEffort: ACCOUNT_DEFAULT_EFFORT,
    membershipKind: membership.kind === 'org' ? 'org' : 'personal',
    membershipRole:
      membership.role === 'owner' || membership.role === 'admin' || membership.role === 'member'
        ? membership.role
        : 'member',
    orgId: typeof membership.orgId === 'string' ? membership.orgId : null,
    orgName: typeof membership.orgName === 'string' ? membership.orgName : null,
    orgLogoUrl: typeof membership.orgLogoUrl === 'string' ? membership.orgLogoUrl : null,
    orgSlug: null,
    passportId: typeof me?.passportId === 'string' ? me.passportId : (membership.passportId ?? ''),
  };
}

/** Real account profile from the adopted session; null until it resolves. */
let accountUser: AccountUser | null = null;
let currentSessionToken: string | null = null;
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
    console.warn('[host] auth refresh failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

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
let agentGraph: {
  maker: unknown;
  agent?: unknown;
  agents: string[];
  capabilitiesByAgent?: Record<string, { availableModels?: unknown[] }>;
  instances?: Record<string, {
    listAgentCommands(): Array<{ kind: 'agent-builtin'; name: string; description: string }>;
    listAgentSkills(options: { workingDir: string; sessionId?: string }): Promise<{ skills?: unknown[] }>;
  }>;
} | null = null;
let gatewayCredentials: { endpoint: string; credential: string } | null = null;
/** Owner-scoped Maker Memory; null until the runtime owns an account. */
let makerMemory: ReturnType<typeof createHostMemoryManager> | null = null;
const provisionalSessionIds = new Set<string>();
const hostHistoryReader = createHostHistoryReader((sid) => provisionalSessionIds.has(sid));
/** Non-secret projection of the adopted Desktop login; never tokens. */
let account: { authenticated: boolean; realm: string | null; error?: string } = { authenticated: false, realm: null };

/**
 * Initialize storage for a known owner. Login/OAuth is a later stage; until
 * then storage opens only when the owner is supplied explicitly, so the host
 * never guesses an account or creates a second database root.
 */
async function ensureRuntime(ownerId: string): Promise<void> {
  if (activeOwner !== null) {
    if (activeOwner === ownerId) return;
    throw new Error('owner switch is not supported while the host is running');
  }
  const dataDir = resolveHostDataDir();
  configureHostOwner({ userDataDir: dataDir, ownerId });
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
    if (state.authenticated) {
      const user = await resolveAccountUser(ownerId);
      if (!user) throw new Error('Unable to verify the signed-in Host account');
      accountUser = user;
      account = { authenticated: true, realm: state.realm };
    }
  }

  const vecFile = process.platform === 'win32'
    ? 'vec0.dll'
    : process.platform === 'darwin' ? 'vec0.dylib' : 'vec0.so';
  const opened = await openOwnerDatabase({
    userDataDir: dataDir,
    ownerId,
    isPackaged: false,
    drizzleDir: process.env.CINDY_HOST_DRIZZLE_DIR?.trim() || path.join(desktopRoot, 'drizzle'),
    sqliteVecExtPath: process.env.CINDY_HOST_SQLITE_VEC_PATH?.trim()
      || path.join(desktopRoot, 'native', 'sqlite-vec', `${process.platform}-${process.arch}`, vecFile),
  });
  const client = createDbClientForHandle({
    db: opened.db,
    drizzle: opened.drizzle,
    dispose: async () => opened.db.close(),
  });
  sessionStorage = new OwnerSessionStorage({ db: () => client });
  // Shared readers (history, tags) resolve the owner client from this singleton;
  // installing it here keeps them on the same connection as the host runtime.
  setCurrentDbClient(client, ownerId);
  activeOwner = ownerId;
  closeStorage = async () => { clearCurrentDbClient(client); await client.dispose(); };
  runtime.state = 'ready';
  runtime.owner = ownerId;
  runtime.storage = 'ready';
  delete runtime.detail;

  const claudeBinary = harnessBinaryPath('claude-code');
  const codexBinary = harnessBinaryPath('codex');
  const piBinary = harnessBinaryPath('pi');
  if (claudeBinary || codexBinary || piBinary) {
    // Prefer the already-authorised Cindy gateway key; fall back to the CLI's own
    // subscription login. Both lanes share the same agent class and storage.
    const gateway = await readGatewayCredentials({
      userDataDir: dataDir,
      ownerId,
      // The Desktop namespace key can be supplied directly when the caller only
      // knows the profile's owner hash (as the existing data directories show).
      ownerKey: process.env.CINDY_HOST_OWNER_KEY?.trim() || undefined,
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    }).catch(() => null) ?? await fetchGatewayCredentials({
      sessionToken: currentSessionToken, region: account.realm ?? resolveHostRegion(),
    }).catch((error: unknown) => {
      console.warn('[host] model access unavailable:', error instanceof Error ? error.message : 'request failed');
      return null;
    });
    // Memory uses the same owner-scoped store Desktop reads, so a task started
    // here sees the same memories as a task started there.
    makerMemory = createHostMemoryManager({ userDataDir: dataDir, ownerId });
    // Flip the flag before the agents are built: their runtimeConfig snapshots it
    // at construction, and native-agent syncoff needs the agents that do not exist yet.
    if (makerMemory.isEnabled()) await makerMemory.enable({ skipAgentSync: true });
    agentGraph = createHostAgentGraph({
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
      mcpProviders: createHostMemoryMcpProviders(makerMemory),
      userDataDir: dataDir,
    });
    attachAgentsToMakerMemory(makerMemory, agentGraph.instances);
    // Second step, now that the agents exist: turn their native memory off.
    if (makerMemory.isEnabled()) void makerMemory.enable();
    runtime.agents = [...agentGraph.agents];
    runtime.agentLane = gateway ? 'gateway-key' : 'claude-subscription';
    gatewayCredentials = gateway;
  }
  if (claudeBinary) {
    void readClaudeSubscriptionState({ binary: claudeBinary, env: { PATH: process.env.PATH } })
      .then((state) => { claudeState = state; })
      .catch((error: unknown) => {
        claudeState = { error: error instanceof Error ? error.message : String(error) };
      });
  }
}

const eventHub = createEventHub();
const readSessionForRun = async (sessionId: string) => {
  const rows = await getDbClient().drizzle.select().from(sessionTable)
    .where(eq(sessionTable.id, sessionId)).limit(1);
  const row = rows[0];
  if (!row || row.status !== 'active') throw new Error('session is not active');
  const agentKind = row.agentKind === 'codex' ? 'codex' : row.agentKind === 'pi' ? 'pi' : 'claude-code';
  return {
    id: row.id,
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
const inputQueue = createInputQueue({
  interactions: interactionBroker,
  getMaker: () => {
    if (!agentGraph) throw new Error('agent runtime is not ready');
    return agentGraph.maker;
  },
  hub: eventHub,
  readSession: readSessionForRun,
  persistMessage: insertSessionMessage,
  sent: (sessionId: string) => provisionalSessionIds.delete(sessionId),
});

/** Insert one chat message row and read it back through the shared mapper. */
async function insertSessionMessage(sessionId: string, input: Record<string, unknown>) {
  const clientId = typeof input.clientId === 'string' ? input.clientId : '';
  const role = input.role;
  if (!clientId) throw new Error('clientId is required');
  if (role !== 'user' && role !== 'assistant' && role !== 'error' && role !== 'tool_use' && role !== 'tool_result') {
    throw new Error('unsupported message role');
  }
  const content = input.content;
  if (content === undefined) throw new Error('content is required');
  const id = typeof input.id === 'string' && input.id ? input.id : randomBytes(16).toString('hex');
  const createdAt = typeof input.createdAt === 'string'
    ? Date.parse(input.createdAt) || Date.now()
    : typeof input.createdAt === 'number' ? input.createdAt : Date.now();
  await getDbClient().drizzle.insert(messageTable).values({
    id,
    clientId,
    sessionId,
    role,
    // The renderer sends user content pre-encoded as a JSON string; assistant
    // text arrives as plain text. Only structure needs encoding.
    content: typeof content === 'string' ? content : JSON.stringify(content),
    toolUseId: typeof input.toolUseId === 'string' ? input.toolUseId : null,
    createdAt,
    agentMeta: input.agentMeta ? JSON.stringify(input.agentMeta) : null,
    agentKind: typeof input.agentKind === 'string' ? (input.agentKind === 'claude-code' ? 'cc' : input.agentKind) : null,
  }).onConflictDoNothing({ target: [messageTable.sessionId, messageTable.clientId] });
  const rows = await getDbClient().drizzle.select().from(messageTable)
    .where(and(eq(messageTable.sessionId, sessionId), eq(messageTable.clientId, clientId))).limit(1);
  const row = rows[0];
  if (!row) throw new Error('created message is unavailable');
  const camel = messageToCamel(row as never);
  if (row.id === id) eventHub.publish({ type: 'message_created', sessionId, messageId: id, message: camel });
  return camel;
}

const apiToken = readOrCreateApiToken(resolveHostDataDir());
const webDir = process.env.CINDY_HOST_WEB_DIR?.trim()
  || path.resolve(desktopRoot, '.vite', 'renderer', 'main_window');
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
  token: apiToken,
  shimPath: path.resolve(desktopRoot, '..', 'web', 'shim.js'),
  // Inline the shared defaults so the synchronous snapshot API can answer.
  // The browser client reads the Desktop's own settings files, so the snapshot
  // it boots with is the same one the Desktop renders — never a host-side copy.
  bootValues: () => {
    const profile = currentProfileSettings();
    return {
      appVersion: createRequire(import.meta.url)('../../desktop/package.json').version,
      platform: process.platform,
      osRelease: os.release(),
      locale: profile.appearance?.locale ?? 'en',
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
    region: resolveHostRegion(),
    dataDir: resolveHostDataDir(),
    runtime,
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
  listRunningSessions: (options: unknown) => listRunningSessions(agentGraph?.maker, options),
  refreshAuth: async () => {
    const ok = await refreshAuthSession();
    return { ok, ...projectAuthState() };
  },
  logout: async () => {
    authClosed = true;
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
      deviceId: machineIdSync(),
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
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    await inputQueue.dispose();
    await (agentGraph?.maker as { shutdown?: () => Promise<void> } | undefined)?.shutdown?.();
    agentGraph = null;
    gatewayCredentials = null;
    accountUser = null;
    await closeStorage?.();
    closeStorage = null;
    sessionStorage = null;
    activeOwner = null;
    runtimeLease?.release();
    runtimeLease = null;
    runtime.state = 'uninitialized';
    runtime.storage = 'unopened';
    runtime.owner = null;
    eventHub.clear();
    eventHub.publish({ type: 'auth_changed', ...projectAuthState(), authenticated: false, isAuthenticated: false, user: null, canEnterApp: false, mode: 'signed-out' });
    account = { authenticated: false, realm: null };
    currentSessionToken = null;
    return result;
  },
  listSessions: async (body?: Record<string, unknown>) => {
    if (!sessionStorage) return [];
    try {
      const db = getDbClient().drizzle;
      const statusParam = body?.status;
      const statusFilter: 'active' | 'archived' | null =
        statusParam === 'active' || statusParam === 'archived' ? statusParam : null;
      const sourceFilter = ordinaryTaskListFilter();
      const statusWhere = () =>
        statusFilter ? eq(sessionTable.status, statusFilter) : ne(sessionTable.status, 'deleted');
      const limitParam = typeof body?.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
        ? Math.min(body.limit, 1000)
        : 1000;
      const rawRows = await selectSessionListRows(db, and(sourceFilter, statusWhere()), limitParam);
      return rawRows.map((r) => sessionToCamel(flattenSessionReadRow(r)));
    } catch {
      return sessionStorage ? listActiveSessions(sessionStorage) : [];
    }
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
      activity: row.activity ?? null,
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
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row || row.status === 'deleted') throw new Error('session not found');
    return sessionToCamel({ ...row, messageCount: 0 });
  },
  deleteSession: async (sessionId: string) => {
    if (!sessionStorage) throw new Error('agent runtime is not ready');
    const existing = await sessionStorage.get(sessionId);
    if (!existing) return { deleted: false, sessionId };
    await inputQueue.disposeSession(sessionId);
    pendingAgentSwitches.delete(sessionId);
    await sessionStorage.delete(sessionId);
    provisionalSessionIds.delete(sessionId);
    eventHub.publish({ type: 'session_changed', action: 'delete', sessionId, status: 'deleted' });
    return { deleted: true, sessionId };
  },
  discardProvisionalSession: async (sessionId: string) => {
    if (!provisionalSessionIds.has(sessionId) || !sessionStorage) {
      return { discarded: false, remaining: Boolean(await sessionStorage?.get(sessionId)) };
    }
    await inputQueue.disposeSession(sessionId);
    pendingAgentSwitches.delete(sessionId);
    await sessionStorage.delete(sessionId);
    provisionalSessionIds.delete(sessionId);
    eventHub.publish({ type: 'session_changed', action: 'delete', sessionId, status: 'deleted' });
    return { discarded: true, remaining: false };
  },
  commitProvisionalSession: async (sessionId: string) => {
    const committed = provisionalSessionIds.delete(sessionId);
    return { committed };
  },
  createSession: async (input: Record<string, unknown>) => {
    if (!agentGraph || !sessionStorage) throw new Error('agent runtime is not ready');
    const allowed: Record<string, true> = {
      id: true, title: true, workingDir: true, model: true, effort: true, permissionMode: true,
      fastMode: true, planModeEnabled: true, agentKind: true, providerId: true, provisional: true,
      workspaceKind: true, projectDir: true, extraDirs: true, writableDirs: true,
    };
    if (Object.keys(input).some((key) => allowed[key] !== true)) throw new Error('unsupported session field');
    const agentKind = input.agentKind === 'codex' ? 'codex' : input.agentKind === 'pi' ? 'pi' : 'claude-code';
    const supportedAgents = agentGraph.agents ?? [];
    if (!supportedAgents.includes(agentKind)) throw new Error(`Agent '${agentKind}' is not registered`);
    const available = await listProviders({ gateway: gatewayCredentials, ownerId: runtime.owner });
    const requestedProviderId = typeof input.providerId === 'string' && input.providerId ? input.providerId : null;
    const matchingProvider = requestedProviderId ? available.providers.find((p) => p.id === requestedProviderId) : null;
    if (requestedProviderId && !matchingProvider) throw new Error(`provider '${requestedProviderId}' is not available on cindy-host`);
    const models = available.providers.flatMap((provider) => (!requestedProviderId || provider.id === requestedProviderId ? provider.models?.[agentKind] ?? [] : []));
    const model = typeof input.model === 'string' ? input.model : models[0]?.id;
    if (!model || !models.some((candidate) => candidate.id === model)) throw new Error('model is not available for this agent');
    const requestedWorkDir = typeof input.workingDir === 'string' ? input.workingDir : resolveHostDataDir();
    if (!path.isAbsolute(requestedWorkDir) || !existsSync(requestedWorkDir)) throw new Error('working directory must exist and be absolute');
    const id = typeof input.id === 'string' && input.id ? input.id : randomBytes(16).toString('hex');
    const asStringArray = (value: unknown, field: string): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !path.isAbsolute(item) || !existsSync(item))) {
        throw new Error(`${field} must contain existing absolute directories`);
      }
      return value;
    };
    const extraDirs = asStringArray(input.extraDirs, 'extraDirs');
    const writableDirs = asStringArray(input.writableDirs, 'writableDirs');
    await sessionStorage.create({
      id,
      agentKind,
      workDir: requestedWorkDir,
      title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : 'New Maker',
      model,
      workspaceKind: input.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
      projectDir: typeof input.projectDir === 'string' ? input.projectDir : null,
      effort: parseEffort(input.effort),
      permissionMode: parsePermissionMode(input.permissionMode),
      fastMode: typeof input.fastMode === 'boolean' || input.fastMode === 'ultrafast' ? input.fastMode : undefined,
      planMode: input.planModeEnabled === true,
    });
    await getDbClient().drizzle.update(sessionTable).set({
      providerId: typeof input.providerId === 'string' ? input.providerId : null,
      extraDirs: JSON.stringify(extraDirs),
      writableDirs: JSON.stringify(writableDirs),
    }).where(eq(sessionTable.id, id));
    if (input.provisional === true) provisionalSessionIds.add(id);
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw new Error('created session metadata is unavailable');
    eventHub.publish({ type: 'session_changed', action: 'create', sessionId: id, session: sessionToCamel({ ...row, messageCount: 0 }) });
    return { ...sessionToCamel({ ...row, messageCount: 0 }), provisional: input.provisional === true };
  },
  chat: createChatHandler({
    readSession: readSessionForRun,
    get maker() {
      if (!agentGraph) throw new Error('agent runtime is not ready');
      return agentGraph.maker;
    },
    defaultWorkDir: resolveHostDataDir(),
    defaultModel: process.env.CINDY_HOST_MODEL?.trim() || 'claude-sonnet-4-6',
    interactions: interactionBroker,
    onSessionSent: (sessionId: string) => provisionalSessionIds.delete(sessionId),
  }),
  providers: () => listProviders({ gateway: gatewayCredentials, ownerId: runtime.owner }),
  // The agent's own capability descriptor; no second catalog is invented here.
  // Gateway credential state, reported from the same facts the runtime uses.
  // The renderer asks this synchronously at boot; the desktop proxies it from
  // here so both clients start from the same visibility-owner facts.
  modelVisibilityClaim: () => ({
    dataOwnerId: runtime.owner,
    ownerGeneration: 1,
    canWriteOwnerScoped: Boolean(runtime.owner),
    // The host holds the profile lease, so it is the owner of the legacy
    // renderer namespace; a fresh client can then finish its first-run
    // migration instead of staying pending forever.
    claimed: Boolean(runtime.owner),
    claimedByOtherOwner: false,
    canInitialize: false,
    profileOrigin: 'existing',
  }),
  modelAccess: () => (gatewayCredentials
    ? { state: 'ready', source: 'server', endpoint: gatewayCredentials.endpoint, accountTier: null }
    : { state: 'idle', source: null, endpoint: null, accountTier: null }),
  modelPricing: async () => null,
  referenceModelPricing: () => ({}),
  agents: () => agentGraph?.agents ?? [],
  events: eventHub,
  input: {
    ...inputQueue,
    enqueue: async (sessionId: string, item: Record<string, unknown>) => {
      await applyPendingAgentSwitch(sessionId);
      return inputQueue.enqueue(sessionId, item);
    },
  },
  interactions: interactionBroker,
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
    const result = await agent.listAgentSkills({
      workingDir: typeof input.workingDir === 'string' ? input.workingDir : resolveHostDataDir(),
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
    });
    return { success: true, skills: result.skills ?? [] };
  },
  capabilities: async (agentKind: string) => {
    const kind = agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : 'claude-code';
    const baseCaps = agentGraph?.capabilitiesByAgent?.[kind] ?? (
      kind === 'pi'
        ? {
            switchModel: { supported: true },
            hasFastMode: true,
            effort: { supported: true },
            effortLevels: [
              { id: 'minimal', displayName: 'Minimal' },
              { id: 'low', displayName: 'Low' },
              { id: 'medium', displayName: 'Medium' },
              { id: 'high', displayName: 'High' },
              { id: 'xhigh', displayName: 'Extra High' },
              { id: 'max', displayName: 'Maximum' },
            ],
            reasoningDisplay: ['off', 'full'],
            permissionModes: [
              { id: 'ask', displayName: 'Default permissions', description: 'Read-only tools run directly; writing files, running commands, and MCP tools ask each time.' },
              { id: 'auto', displayName: 'Automatic decisions', description: 'Cindy decides when to ask based on risk.' },
              { id: 'bypassPermissions', displayName: 'Full access', description: 'Run tools without asking.' },
            ],
          }
        : null
    );
    if (!baseCaps) throw new Error(`Agent '${kind}' is not registered`);
    const providerSnapshot = await listProviders({ gateway: gatewayCredentials, ownerId: runtime.owner });
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
      supportsOrcaWorkerPermissionMode: true,
      supportsOrcaWorkerUpdate: true,
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
  ghosts: () => (runtime.owner
    ? listInstalledGhosts({
        userDataDir: resolveHostDataDir(),
        ownerId: runtime.owner,
        onChanged: (ghosts: unknown[]) => eventHub.publish({ type: 'ghosts_changed', ghosts }),
      })
    : []),
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
    ownerGeneration: 1, isCanary: false, deviceId: 'host',
    hasAccountDeletionReceipt: false, accountDeletionRestored: false,
    credentialStoreUnavailable: Boolean(account.error),
  };
}
let startup: Promise<void> = Promise.resolve();

const server = createHostServer(serverDeps);

server.on('error', (error) => {
  console.error(`cindy-host failed to listen: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Host listener address is unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  console.log(`cindy-host listening on ${baseUrl}`);
  // Endpoint discovery for clients on this machine: a pid plus the loopback URL.
  // Explicit clients and host:open use this endpoint; desktop startup stays unchanged.
  try {
    writeFileSync(
      path.join(resolveHostDataDir(), 'host-endpoint.json'),
      JSON.stringify({ pid: process.pid, baseUrl }),
      { mode: 0o600 },
    );
    const cleanup = () => {
      try { rmSync(path.join(resolveHostDataDir(), 'host-endpoint.json'), { force: true }); } catch { /* ignore */ }
    };
    process.once('exit', cleanup);
  } catch { /* discovery is best-effort */ }
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
    await ensureRuntime(owner);
    if (initialUser) {
      accountUser = initialUser;
      account = { authenticated: true, realm: account.realm };
      schedulePeriodicRefresh();
      return;
    }
    if (account.authenticated) { schedulePeriodicRefresh(); return; }
    const state = await readAdoptedSessionState({
      userDataDir: resolveHostDataDir(),
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    });
    account = { authenticated: false, realm: state.realm };
    if (state.authenticated && await refreshAuthSession()) schedulePeriodicRefresh();
  })().catch(async (error: unknown) => {
    try { await closeStorage?.(); }
    finally {
      closeStorage = null;
      sessionStorage = null;
      activeOwner = null;
      runtimeLease?.release();
      runtimeLease = null;
      runtime.storage = 'unopened';
      account = { authenticated: false, realm: account.realm };
      accountUser = null;
      currentSessionToken = null;
    }
    if (runtime.state !== 'blocked') runtime.state = 'error';
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
  void (async () => {
    await startup;
    await authRefreshFlight;
    try {
      await inputQueue.dispose();
      await (agentGraph?.maker as { shutdown?: () => Promise<void> } | undefined)?.shutdown?.();
    } finally {
      server.closeAllConnections();
      server.close();
      await closeStorage?.();
      runtimeLease?.release();
    }
  })().catch((error) => {
    console.error('cindy-host shutdown failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
}
