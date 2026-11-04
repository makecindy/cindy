import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { createDbClientForHandle } from '../../desktop/src/main/localDb/client/createDbClientForHandle.js';
import { OwnerSessionStorage } from '../../desktop/src/main/localDb/sessionStorageAdapter.js';
import { readCachedBinaryStatus } from '../../desktop/src/main/agent-binaries/binaryStatus.js';
import { openOwnerDatabase, OwnerDatabaseError } from '../../desktop/src/main/localDb/startupCore.js';
import { resolveHostDataDir, resolveHostRegion } from './profile-path.mjs';
import { acquireHostRuntimeLease, type HostRuntimeLease } from './runtime-lock.js';
import { readAdoptedSessionState } from './credentials/session.mjs';
import { runLoginCommand } from './login-cli.mjs';

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
  detail?: string;
}

const runtime: RuntimeState = { state: 'uninitialized', owner: null, storage: 'unopened' };

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
  const lease = acquireHostRuntimeLease(resolveHostDataDir(), ownerId);
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
    userDataDir: resolveHostDataDir(),
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
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    let sessions: number | null = null;
    if (sessionStorage) {
      try {
        sessions = (await sessionStorage.list()).length;
      } catch {
        sessions = null;
      }
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({
      status: 'ok',
      service: 'cindy-host',
      region: resolveHostRegion(),
      dataDir: resolveHostDataDir(),
      runtime,
      account,
      harness: harnessStatus(),
      sessions,
    }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: 'not_found' }));
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
