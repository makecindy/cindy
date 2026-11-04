import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.js';
import { OwnerSessionStorage } from '../../desktop/src/main/localDb/sessionStorageAdapter.js';
import { readCachedBinaryStatus } from '../../desktop/src/main/agent-binaries/binaryStatus.js';
import { openOwnerDatabase, OwnerDatabaseError } from '../../desktop/src/main/localDb/startupCore.js';
import { resolveHostDataDir, resolveHostRegion } from './profile-path.mjs';
import { acquireHostRuntimeLease, type HostRuntimeLease } from './runtime-lock.js';
import { readAdoptedSessionState } from './credentials/session.mjs';
import { configureHostOwner, readClaudeSubscriptionState } from './agent/claude-auth.mjs';
import { createHostAgentGraph } from './agent/runtime.mjs';
import { runLoginCommand } from './login-cli.mjs';
import { readOrCreateApiToken } from './api-token.mjs';
import { CindyAuthClient } from '@cindy/auth-client';
import { createRequire } from 'node:module';
import { readAuthEndpoints } from './auth/endpoints.mjs';
import { logoutHostSession } from './auth/logout.mjs';
import { listInstalledPlugins } from './plugins.mjs';
import { listActiveSessions } from './sessions.mjs';
import { createPreparedLinuxCredentialStore } from './credentials/store.mjs';
import { createHostServer } from './server.mjs';
import { createChatHandler } from './chat.mjs';

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
let agentGraph: { maker: unknown; agents: string[] } | null = null;
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
  activeOwner = ownerId;
  closeStorage = () => client.dispose();
  runtime.state = 'ready';
  runtime.owner = ownerId;
  runtime.storage = 'ready';
  delete runtime.detail;

  const claudeBinary = harnessBinaryPath('claude-code');
  if (claudeBinary) {
    agentGraph = createHostAgentGraph({
      binaryPath: claudeBinary,
      storage: sessionStorage,
    });
    runtime.agents = agentGraph.agents;
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
const server = createHostServer({
  token: apiToken,
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
  chat: createChatHandler({
    get maker() {
      if (!agentGraph) throw new Error('agent runtime is not ready');
      return agentGraph.maker;
    },
    defaultWorkDir: resolveHostDataDir(),
    defaultModel: process.env.CINDY_HOST_MODEL?.trim() || 'claude-sonnet-4-6',
  }),
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
