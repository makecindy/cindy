import path from 'node:path';
import { existsSync } from 'node:fs';
import { getDefaultVoiceInputSettings } from '../../desktop/src/shared/voiceInputData.ts';
import { createDefaultLayout } from '../../desktop/src/shared/layoutTree.ts';

import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.js';
import { OwnerSessionStorage } from '../../desktop/src/main/localDb/sessionStorageAdapter.js';
import { getDbClient, setCurrentDbClient } from '../../desktop/src/main/localDb/client/current.ts';
import { readCachedBinaryStatus } from '../../desktop/src/main/agent-binaries/binaryStatus.js';
import { openOwnerDatabase, OwnerDatabaseError } from '../../desktop/src/main/localDb/startupCore.js';
import { resolveHostDataDir, resolveHostRegion } from './profile-path.mjs';
import { acquireHostRuntimeLease, type HostRuntimeLease } from './runtime-lock.js';
import { readAdoptedSessionState } from './credentials/session.mjs';
import { configureHostOwner, readClaudeSubscriptionState } from './agent/claude-auth.mjs';
import { createHostAgentGraph } from './agent/runtime.mjs';
import { readGatewayCredentials } from './agent/gateway.mjs';
import { listProviders } from './agent/providers.mjs';
import { runLoginCommand } from './login-cli.mjs';
import { readOrCreateApiToken } from './api-token.mjs';
import { CindyAuthClient } from '@cindy/auth-client';
import type { Effort, PermissionMode } from '@cindy/maker-core';
import { createRequire } from 'node:module';
import { readAuthEndpoints } from './auth/endpoints.mjs';
import { logoutHostSession } from './auth/logout.mjs';
import { listInstalledPlugins } from './plugins.mjs';
import { listActiveSessions } from './sessions.mjs';
import { createPreparedLinuxCredentialStore } from './credentials/store.mjs';
import { createHostServer } from './server.mjs';
import { createChatHandler } from './chat.mjs';
import { sessionToCamel } from '../../desktop/src/main/localDb/mapper.ts';
import { sessions as sessionTable } from '../../desktop/src/main/localDb/schema.js';
import { eq } from 'drizzle-orm';

const DEFAULT_VOICE_INPUT_SETTINGS = getDefaultVoiceInputSettings();
const DEFAULT_LAYOUT = createDefaultLayout();
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
if (command === 'login') {
  try {
    await runLoginCommand(process.argv.slice(3));
  } catch (error) {
    console.error(`cindy-host login failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else if (command !== undefined && command !== 'serve') {
  console.error(`unknown command: ${command}\nusage: cindy-host [serve|login [--region=cn|global] [--method=<id>]]`);
  process.exitCode = 2;
} else {
const PORT = 3456;
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
    ? { dir: 'claude-code-bin', file: 'claude' }
    : kind === 'codex'
      ? { dir: 'codex-package-bin', file: path.join('bin', 'codex') }
      : { dir: 'pi-bin', file: 'pi' };
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
      ? { dir: 'claude-code-bin', file: 'claude' }
      : kind === 'codex'
        ? { dir: 'codex-package-bin', file: path.join('bin', 'codex') }
        : { dir: 'pi-bin', file: 'pi' };
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
let activeOwner: string | null = null;
let closeStorage: (() => Promise<void>) | null = null;
let sessionStorage: OwnerSessionStorage | null = null;
let runtimeLease: HostRuntimeLease | null = null;
/** Claude subscription state read once per boot; never on the health path. */
let claudeState: Record<string, unknown> | null = null;
/** Real maker-core agents registered in this process. */
let agentGraph: {
  maker: unknown;
  agent?: unknown;
  agents: string[];
  capabilitiesByAgent?: Record<string, { availableModels?: unknown[] }>;
} | null = null;
let gatewayCredentials: { endpoint: string; credential: string } | null = null;
const provisionalSessionIds = new Set<string>();
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
  closeStorage = () => client.dispose();
  runtime.state = 'ready';
  runtime.owner = ownerId;
  runtime.storage = 'ready';
  delete runtime.detail;

  const claudeBinary = harnessBinaryPath('claude-code');
  if (claudeBinary) {
    // Prefer the already-authorised Cindy gateway key; fall back to the CLI's own
    // subscription login. Both lanes share the same agent class and storage.
    const gateway = await readGatewayCredentials({
      userDataDir: dataDir,
      ownerId,
      // The Desktop namespace key can be supplied directly when the caller only
      // knows the profile's owner hash (as the existing data directories show).
      ownerKey: process.env.CINDY_HOST_OWNER_KEY?.trim() || undefined,
      keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
    }).catch(() => null);
    agentGraph = createHostAgentGraph({
      binaryPath: claudeBinary,
      codexBinaryPath: harnessBinaryPath('codex') ?? undefined,
      storage: sessionStorage,
      gateway,
    });
    runtime.agents = agentGraph.agents;
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

const apiToken = readOrCreateApiToken(resolveHostDataDir());
// Per-boot cookie for the bundled web client; the bearer remains the CLI path.
const webSession = randomBytes(24).toString('base64url');
const webDir = process.env.CINDY_HOST_WEB_DIR?.trim()
  || path.resolve(desktopRoot, '.vite', 'renderer', 'main_window');
const server = createHostServer({
  token: apiToken,
  webSession,
  shimPath: path.resolve(desktopRoot, '..', 'web', 'shim.js'),
  // Inline the shared defaults so the synchronous snapshot API can answer.
  bootValues: () => ({
    voiceInput: { settings: DEFAULT_VOICE_INPUT_SETTINGS, history: [] },
    harness: harnessStatus(),
    auth: account.authenticated
      ? { user: { id: runtime.owner ?? 'owner', name: runtime.owner ?? 'owner', email: null, avatar: null }, ownerId: runtime.owner }
      : {},
    appearance: {},
    layout: DEFAULT_LAYOUT,
  }),
  webDir: process.env.CINDY_HOST_WEB_DIR?.trim() ? webDir : (existsSync(webDir) ? webDir : null),
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
  me: async () => ({ owner: runtime.owner, authenticated: account.authenticated, realm: account.realm }),
  logout: async () => {
    const realm = (account.realm ?? resolveHostRegion()) as 'cn' | 'global';
    const endpoints = readAuthEndpoints(realm);
    const store = await createPreparedLinuxCredentialStore({
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
    const result = await logoutHostSession({
      store,
      refresh: (token) => client.refresh(token),
      logout: (accessToken) => client.logout(accessToken),
    });
    account = { authenticated: false, realm: null };
    return result;
  },
  listSessions: async () => (sessionStorage ? listActiveSessions(sessionStorage) : []),
  getSession: async (sessionId: string) => {
    const rows = await getDbClient().drizzle.select().from(sessionTable)
      .where(eq(sessionTable.id, sessionId)).limit(1);
    const row = rows[0];
    if (!row || row.status === 'deleted') throw new Error('session not found');
    return sessionToCamel({ ...row, messageCount: 0 });
  },
  discardProvisionalSession: async (sessionId: string) => {
    if (!provisionalSessionIds.has(sessionId) || !sessionStorage) {
      return { discarded: false, remaining: Boolean(await sessionStorage?.get(sessionId)) };
    }
    await sessionStorage.delete(sessionId);
    provisionalSessionIds.delete(sessionId);
    return { discarded: true, remaining: false };
  },
  commitProvisionalSession: async (sessionId: string) => {
    const committed = provisionalSessionIds.delete(sessionId);
    return { committed };
  },
  createSession: async (input: Record<string, unknown>) => {
    if (!agentGraph || !sessionStorage) throw new Error('agent runtime is not ready');
    const allowed: Record<string, true> = {
      id: true, workingDir: true, model: true, effort: true, permissionMode: true,
      fastMode: true, planModeEnabled: true, agentKind: true, providerId: true, provisional: true,
      workspaceKind: true, projectDir: true, extraDirs: true, writableDirs: true,
    };
    if (Object.keys(input).some((key) => allowed[key] !== true)) throw new Error('unsupported session field');
    const agentKind = input.agentKind === 'codex' ? 'codex' : input.agentKind === 'pi' ? 'pi' : 'claude-code';
    if (!agentGraph.agents.includes(agentKind)) throw new Error(`Agent '${agentKind}' is not registered`);
    if (input.providerId !== undefined && input.providerId !== null && input.providerId !== 'xd') throw new Error('provider is not available on cindy-host');
    const available = await listProviders({ gateway: gatewayCredentials, ownerId: runtime.owner });
    const models = available.providers.find((provider) => provider.id === 'xd')?.models?.[agentKind] ?? [];
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
      title: 'New Maker',
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
    return { ...sessionToCamel({ ...row, messageCount: 0 }), provisional: input.provisional === true };
  },
  chat: createChatHandler({
    readSession: async (sessionId: string) => {
      const rows = await getDbClient().drizzle.select().from(sessionTable)
        .where(eq(sessionTable.id, sessionId)).limit(1);
      const row = rows[0];
      if (!row || row.status !== 'active') throw new Error('session is not active');
      return { id: row.id, agentKind: row.agentKind, model: row.model, workingDir: row.workingDir, providerId: row.providerId };
    },
    get maker() {
      if (!agentGraph) throw new Error('agent runtime is not ready');
      return agentGraph.maker;
    },
    defaultWorkDir: resolveHostDataDir(),
    defaultModel: process.env.CINDY_HOST_MODEL?.trim() || 'claude-sonnet-4-6',
    onSessionSent: (sessionId: string) => provisionalSessionIds.delete(sessionId),
  }),
  providers: () => listProviders({ gateway: gatewayCredentials, ownerId: runtime.owner }),
  // The agent's own capability descriptor; no second catalog is invented here.
  // Gateway credential state, reported from the same facts the runtime uses.
  modelAccess: () => (gatewayCredentials
    ? { state: 'ready', source: 'server', endpoint: gatewayCredentials.endpoint, accountTier: null }
    : { state: 'idle', source: null, endpoint: null, accountTier: null }),
  modelPricing: async () => null,
  referenceModelPricing: () => ({}),
  agents: () => agentGraph?.agents ?? [],
  capabilities: async (agentKind: string) => {
    const capabilities = agentGraph?.capabilitiesByAgent?.[agentKind];
    if (!capabilities) throw new Error(`Agent '${agentKind}' is not registered`);
    const providerSnapshot = await listProviders({ gateway: gatewayCredentials, ownerId: runtime.owner });
    const gatewayModels = providerSnapshot.providers.find((provider) => provider.id === 'xd')?.models?.[agentKind] ?? [];
    const availableModels = gatewayModels.map((model) => ({
      id: model.id,
      displayName: model.name,
      contextWindow: model.contextWindow,
      efforts: model.efforts,
      defaultEffort: model.defaultEffort,
    }));
    return {
      agentKind,
      capabilities: { ...capabilities, availableModels },
      availableModels,
    };
  },
  history: async (sessionId: string, limit: number) => {
    const { getMessagesForHistory } = await import('../../desktop/src/main/localDb/chatHistoryReader.ts');
    const page = await getMessagesForHistory({
      sessionIds: [sessionId], workdir: null, fromMs: null, toMs: null,
      agentKind: null, roles: null, includeRewound: false, limit, cursor: null, order: 'asc',
    });
    return page.items;
  },
  listPlugins: () => (runtime.owner
    ? listInstalledPlugins(resolveHostDataDir(), runtime.owner)
    : { plugins: [], namespace: 'canonical', legacyNamespacePresent: false }),
});

server.on('error', (error) => {
  console.error(`cindy-host failed to listen: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cindy-host listening on http://127.0.0.1:${PORT}`);
  void readAdoptedSessionState({
    userDataDir: resolveHostDataDir(),
    keyringApplication: process.env.CINDY_HOST_KEYRING_APPLICATION?.trim() || undefined,
  }).then((state) => {
    account = state;
  }).catch((error: unknown) => {
    account = {
      authenticated: false,
      realm: null,
      error: error instanceof Error ? error.message : String(error),
    };
  });
  const owner = process.env.CINDY_HOST_OWNER?.trim();
  if (!owner) return;
  void ensureRuntime(owner).catch((error: unknown) => {
    if (runtime.state === 'blocked') {
      // A blocked host never opened storage; reporting 'error' would wrongly
      // imply the profile database failed.
      runtime.storage = 'unopened';
    } else {
      runtime.state = 'error';
      runtime.storage = 'error';
    }
    runtime.owner = owner;
    runtime.detail = error instanceof OwnerDatabaseError
      ? `${error.code}: ${error.message}`
      : error instanceof Error ? error.message : String(error);
    console.error(`cindy-host storage initialization failed: ${runtime.detail}`);
  });
});

let shuttingDown = false;
const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void (closeStorage?.() ?? Promise.resolve()).then(() => {
    server.close((error) => {
      if (error) {
        console.error(`cindy-host shutdown failed: ${error.message}`);
        process.exitCode = 1;
      }
    });
  });
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
}
