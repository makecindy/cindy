import { app } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AuthState } from '@cindy/maker-core';
import { getActiveAppSession } from '../appSessionState.js';
import { getCachedBinaryStatus, isVettedAgentBinaryPath } from '../agent-binaries/index.js';
import { getActiveCatalog } from './active-catalog.js';
import { terminateCodexLoginProcess } from './codex-auth-state.js';
import { prepareCodexGlobalSkillsLinks } from './codex-global-skills.js';
import { prepareCodexGlobalRulesCopy } from './codex-global-rules.js';
import { prepareCodexGlobalPluginsBridge } from './codex-global-plugins.js';
import { DESKTOP_CAPABILITY_ROUTING_POLICY } from './capability-routing.js';

/** Native account homes never participate in system Codex credential reconciliation. */
export function isCodexAccountProvider(providerId?: string | null): boolean {
  return (
    !!providerId &&
    getActiveCatalog().providers.some(
      (provider) =>
        provider.id === providerId &&
        provider.source === 'user' &&
        provider.auth.native === 'codex',
    )
  );
}

export function isOpenAiSubscriptionProviderId(providerId?: string | null): boolean {
  return providerId === 'openai' || isCodexAccountProvider(providerId);
}

export async function invalidateCodexAccount(providerId: string, reason: string, failedAccessToken: string): Promise<void> {
  if (!isCodexAccountProvider(providerId)) throw new Error('OpenAI account is unavailable');
  // Compare and commit without an await: a late failure must not invalidate a newer login.
  const home = codexAccountHome(providerId);
  const current = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'));
  if (current.tokens?.access_token !== failedAccessToken) return;
  fs.writeFileSync(path.join(home, 'invalidated'), reason, { mode: 0o600 });
  await retireAccount(providerId);
}

export function codexAccountHome(providerId: string): string {
  if (!/^[a-z0-9_-]{1,40}$/.test(providerId)) throw new Error('Invalid Codex provider id');
  const ownerId = getActiveAppSession().dataOwnerId;
  if (!ownerId) throw new Error('An active owner is required');
  const owner = createHash('sha256').update(ownerId).digest('hex');
  return path.join(app.getPath('userData'), 'codex-accounts', owner, providerId);
}

interface AccountIdentity {
  principal: string;
  label: string;
}

/** Legacy names have no customization flag; recognize only the generated shape. */
export function codexAccountLoginName(
  name: string,
  previousIdentity: string | undefined,
  identity: string,
  occupiedNames: ReadonlySet<string>,
): string | undefined {
  if (previousIdentity === identity) return undefined;
  const oldBase = previousIdentity ? `OpenAI · ${previousIdentity}`.slice(0, 50) : undefined;
  const generated = oldBase && (
    name === oldBase ||
    (name.startsWith(oldBase) && /^ \((?:[2-9]|[1-9]\d+)\)$/.test(name.slice(oldBase.length)))
  );
  if (name !== 'OpenAI' && !generated) return undefined;
  const base = `OpenAI · ${identity}`.slice(0, 50);
  let next = base;
  for (let suffix = 2; occupiedNames.has(next); suffix++) next = `${base} (${suffix})`;
  return next;
}

/** Pure parser: never return tokens through account status or IPC. */
export function parseCodexAccountIdentity(raw: string): AccountIdentity | null {
  try {
    const value = JSON.parse(raw);
    if (typeof value.tokens?.access_token !== 'string' || !value.tokens.access_token) return null;
    const jwt = value.tokens.id_token ?? value.tokens.access_token;
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    const account =
      value.tokens.account_id ?? claims['https://api.openai.com/auth']?.chatgpt_account_id;
    const subject = claims.sub;
    if (typeof account !== 'string' || typeof subject !== 'string') return null;
    return {
      principal: createHash('sha256').update(`${subject}\0${account}`).digest('hex'),
      label:
        typeof claims.email === 'string'
          ? claims.email
          : typeof claims.name === 'string'
            ? claims.name
            : 'ChatGPT',
    };
  } catch {
    return null;
  }
}

export function codexAccountState(providerId: string): AuthState {
  if (!isCodexAccountProvider(providerId))
    return { authenticated: false, errorReason: 'provider_unavailable' };
  try {
    const home = codexAccountHome(providerId);
    if (fs.existsSync(path.join(home, 'disconnected'))) return { authenticated: false };
    if (fs.existsSync(path.join(home, 'invalidated'))) return { authenticated: false, errorReason: 'oauth_expired' };
    const identity = parseCodexAccountIdentity(
      fs.readFileSync(path.join(home, 'auth.json'), 'utf8'),
    );
    const saved = JSON.parse(
      fs.readFileSync(path.join(home, 'account.json'), 'utf8'),
    ) as AccountIdentity;
    if (!identity || identity.principal !== saved.principal)
      return { authenticated: false, errorReason: 'account_mismatch' };
    return { authenticated: true, identity: identity.label, authSource: 'oauth' };
  } catch {
    return { authenticated: false };
  }
}

export async function prepareCodexAccountHome(providerId: string): Promise<string> {
  if (!codexAccountState(providerId).authenticated) throw new Error('Codex account requires login');
  const home = codexAccountHome(providerId);
  await Promise.all([prepareCodexGlobalSkillsLinks(home), prepareCodexGlobalRulesCopy(home)]);
  const plugins = await prepareCodexGlobalPluginsBridge(home, {
    capabilityRouting: DESKTOP_CAPABILITY_ROUTING_POLICY,
  });
  if (plugins.routingFailures.length) throw new Error('Codex capability routing unavailable');
  return home;
}

const logins = new Map<string, { cancel: () => void; done: Promise<void> }>();
const disconnecting = new Set<string>();
let retireAccount: (providerId: string) => Promise<void> = async () => {};
export function setCodexAccountRetirement(handler: (providerId: string) => Promise<void>): void {
  retireAccount = handler;
}
export function cancelCodexAccountLogin(providerId: string): void {
  logins.get(codexAccountHome(providerId))?.cancel();
}

export async function loginCodexAccount(
  providerId: string,
  isCurrent: () => boolean,
): Promise<{
  ok: boolean;
  reason?: string;
  firstLogin?: boolean;
  previousIdentity?: string;
  rollbackCredentials?: () => boolean;
}> {
  if (!isCodexAccountProvider(providerId)) throw new Error('Unknown Codex account provider');
  const owner = getActiveAppSession();
  const home = codexAccountHome(providerId);
  if (logins.has(home) || disconnecting.has(home))
    return { ok: false, reason: 'login_in_progress' };
  const binary = getCachedBinaryStatus('codex');
  if (!binary.binaryPath || !isVettedAgentBinaryPath('codex', binary.binaryPath))
    return { ok: false, reason: 'codex_binary_missing' };
  let cancelled = false;
  let proc: ChildProcess | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const operation = {
    done,
    cancel: () => {
      cancelled = true;
      if (proc) terminateCodexLoginProcess(proc);
    },
  };
  logins.set(home, operation);
  const current = () =>
    !cancelled && isCurrent() && getActiveAppSession().generation === owner.generation;
  const staging = path.join(home, `login-${randomUUID()}`);
  try {
    await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      path.join(staging, 'config.toml'),
      'cli_auth_credentials_store = "file"\n',
      { mode: 0o600 },
    );
    if (!current()) return { ok: false, reason: 'login_cancelled' };
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      proc = spawn(binary.binaryPath!, ['login'], {
        env: { ...process.env, CODEX_HOME: staging },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      // `codex login` opens the browser itself. Drain its output without opening
      // the printed authorization URL a second time.
      proc.stdout?.resume();
      proc.stderr?.resume();
      const timeout = setTimeout(operation.cancel, 5 * 60_000);
      proc.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      proc.once('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    if (!current()) return { ok: false, reason: 'login_cancelled' };
    if (exitCode !== 0) return { ok: false, reason: 'login_failed' };
    const raw = await fsp.readFile(path.join(staging, 'auth.json'), 'utf8');
    const identity = parseCodexAccountIdentity(raw);
    if (!identity) return { ok: false, reason: 'invalid_account' };
    let previous: AccountIdentity | null = null;
    try {
      previous = JSON.parse(await fsp.readFile(path.join(home, 'account.json'), 'utf8'));
    } catch {
      /* first login */
    }
    // An explicit login may replace this connection's account or workspace.
    // Retire its old runtime before committing the newly authorized identity.
    await retireAccount(providerId);
    if (!current()) return { ok: false, reason: 'login_cancelled' };
    const files = ['auth.json', 'account.json', 'config.toml', 'disconnected', 'invalidated'];
    const before = files.map((file) => {
      try {
        return fs.readFileSync(path.join(home, file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    });
    const rollbackCredentials = () => {
      try {
        if (fs.readFileSync(path.join(home, 'auth.json'), 'utf8') !== raw) return false;
        files.forEach((file, index) => {
          const previous = before[index];
          if (previous === null) fs.rmSync(path.join(home, file), { force: true });
          else fs.writeFileSync(path.join(home, file), previous, { mode: 0o600 });
        });
        return true;
      } catch {
        return false;
      }
    };
    // Synchronous commit after the final ownership check; no other request can interleave.
    fs.writeFileSync(path.join(home, 'account.json'), JSON.stringify(identity), { mode: 0o600 });
    fs.writeFileSync(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n', {
      mode: 0o600,
    });
    fs.renameSync(path.join(staging, 'auth.json'), path.join(home, 'auth.json'));
    fs.rmSync(path.join(home, 'disconnected'), { force: true });
    fs.rmSync(path.join(home, 'invalidated'), { force: true });
    return { ok: true, firstLogin: previous === null, previousIdentity: previous?.label, rollbackCredentials };
  } finally {
    if (logins.get(home) === operation) logins.delete(home);
    try {
      await fsp.rm(staging, { recursive: true, force: true });
    } finally {
      finish();
    }
  }
}

export async function logoutCodexAccount(providerId: string): Promise<void> {
  const owner = getActiveAppSession();
  const home = codexAccountHome(providerId);
  if (disconnecting.has(home)) throw new Error('Codex account disconnect is already in progress');
  disconnecting.add(home);
  try {
    const login = logins.get(home);
    login?.cancel();
    await login?.done;
    await fsp.mkdir(home, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(home, 'disconnected'), '', { mode: 0o600 });
    await fsp.rm(path.join(home, 'auth.json'), { force: true });
    if (getActiveAppSession().generation === owner.generation) await retireAccount(providerId);
  } finally {
    disconnecting.delete(home);
  }
}

export async function retireCodexAccount(providerId: string): Promise<void> {
  const owner = getActiveAppSession();
  const login = logins.get(codexAccountHome(providerId));
  login?.cancel();
  await login?.done;
  if (getActiveAppSession().generation !== owner.generation)
    throw new Error('Account changed during Codex retirement');
  await retireAccount(providerId);
}

export function removeCodexAccountCredentialsReversibly(providerId: string): () => boolean {
  const home = codexAccountHome(providerId);
  const authPath = path.join(home, 'auth.json');
  let previous: Buffer | undefined;
  try {
    previous = fs.readFileSync(authPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.rmSync(authPath, { force: true });
  return () => {
    try {
      if (fs.existsSync(authPath)) return false;
      if (previous) fs.writeFileSync(authPath, previous, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  };
}
