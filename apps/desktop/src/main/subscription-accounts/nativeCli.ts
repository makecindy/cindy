/** Official CLI login/control APIs only. No Claude credential access. */
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { statSync, type Stats } from 'node:fs';
import { cleanProcessEnv, type AuthState } from '@cindy/maker-core';
import { getReadyBinaryPath } from '../agent-binaries/index.js';
import {
  refreshClaudeCliLoginStatus,
  readClaudeCliPlanUsage,
  runClaudeCliLogin,
} from '../maker-host/claude-native-cli.desktop.js';
import { parseClaudeOAuthUsageResponse } from '../../shared/claudeSubscriptionUsage.js';
import { providerGroupCodexUsageFromReads } from '../provider-group/usage.js';
import type { SubscriptionProvider } from '../../shared/subscriptionAccounts.js';
import { AccountServiceUnreachableError, isAccountServiceUnreachable } from './accountServiceError.js';

/** Preserve the old adapter's owner/revocation checks; do not adopt ~/.codex on upgrade. */
export async function readLegacyCodexAccount(): Promise<AuthState> {
  const { desktopCodexAuthAdapter } = await import('../maker-host/auth-adapters.js');
  return desktopCodexAuthAdapter.readAccountPresentationState();
}

export async function loginLegacyCodexAccount(signal: AbortSignal): Promise<void> {
  const { desktopCodexAuthAdapter } = await import('../maker-host/auth-adapters.js');
  if (signal.aborted) throw new Error('login_cancelled');
  const cancel = () => desktopCodexAuthAdapter.cancelLogin();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const state = await desktopCodexAuthAdapter.triggerLogin({ mode: 'browser' });
    if (signal.aborted) throw new Error('login_cancelled');
    if (!state.authenticated || state.authSource !== 'oauth')
      throw new Error(state.errorReason ?? 'login_failed');
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** Imported connections keep their original revocation checks and native login lifecycle. */
export async function readLegacyCodexProviderAccount(providerId: string, directory: string) {
  const { codexAccountState } = await import('../maker-host/codex-account-auth.desktop.js');
  const state = codexAccountState(providerId);
  // Right after a restart the connection may not be in the provider catalog yet (custom providers
  // load once the database is ready). That says nothing about the login: report a failed read, so
  // the snapshot retries within seconds instead of caching "requires login" and failing the
  // interrupted task's automatic resume (2026-11-18).
  if (state.errorReason === 'provider_unavailable') throw new Error('Codex connection is not loaded');
  return state.authenticated ? readNativeAccount('openai', directory) : state;
}

export async function loginLegacyCodexProviderAccount(providerId: string, signal: AbortSignal): Promise<void> {
  const { loginCodexAccount, cancelCodexAccountLogin } = await import('../maker-host/codex-account-auth.desktop.js');
  if (signal.aborted) throw new Error('login_cancelled');
  const cancel = () => cancelCodexAccountLogin(providerId);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const result = await loginCodexAccount(providerId, () => !signal.aborted);
    if (signal.aborted) throw new Error('login_cancelled');
    if (!result.ok) throw new Error(result.reason ?? 'login_failed');
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

// Only used to classify; the CLI's own wording never leaves this module.
const UNREACHABLE_CLI_ERROR = /time(?:d)?\s*out|timeout|network|connect|dns|unreachable|sending request|tls|certificate|proxy|offline/i;

function codexRequestError(error: unknown): Error {
  const message = typeof (error as { message?: unknown })?.message === 'string'
    ? (error as { message: string }).message : '';
  return UNREACHABLE_CLI_ERROR.test(message)
    ? new AccountServiceUnreachableError('Codex account request failed')
    : new Error('Codex account request failed');
}

function codexProfileEnv(directory: string): Record<string, string> {
  const env = { ...cleanProcessEnv() };
  const replaced = new Set([
    'CODEX_HOME',
    'CODEX_ACCESS_TOKEN',
    'CODEX_API_KEY',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_FEDERATION_RULE_ID',
    'OPENAI_IDENTITY_TOKEN_FILE',
    'OPENAI_WORKLOAD_IDENTITY_CONTEXT',
  ]);
  for (const key of Object.keys(env)) if (replaced.has(key.toUpperCase())) delete env[key];
  env.CODEX_HOME = directory;
  return env;
}

export async function readNativeAccount(
  provider: SubscriptionProvider,
  directory: string,
  options?: { force?: boolean },
): Promise<AuthState & { plan?: string; planTier?: string; planDisplayName?: string; planType?: string; loginExpiresAt?: string }> {
  if (provider === 'anthropic') {
    const result = await refreshClaudeCliLoginStatus({
      configDir: directory === path.join(homedir(), '.claude') ? undefined : directory,
      ...(options?.force ? { force: true, requireFresh: true } : {}),
    });
    return {
      authenticated: result.loggedIn,
      identity: result.email,
      authSource: 'oauth',
      plan: result.subscriptionType,
      planTier: result.planTier,
      planDisplayName: result.planDisplayName,
      ...(result.loginExpiresAt ? { loginExpiresAt: result.loginExpiresAt } : {}),
    };
  }
  const result = (await codexAccountRpc(directory, 'account/read', { refreshToken: false })) as {
    account?: { type?: string; email?: string; planType?: string } | null;
    requiresOpenaiAuth?: boolean;
  };
  return {
    authenticated: result.account?.type === 'chatgpt',
    identity: result.account?.email,
    plan: result.account?.planType,
    planType: result.account?.planType,
    authSource: 'oauth',
    // The CLI can hide an existing ChatGPT login when its active provider owns
    // authentication. Repeating login cannot make that provider expose the account.
    ...(result.account === null && result.requiresOpenaiAuth === false
      ? { errorReason: 'codex_provider_managed_auth' }
      : {}),
  };
}

export async function readNativeAccountUsage(provider: SubscriptionProvider, directory: string) {
  if (provider === 'anthropic') {
    const usage = await readClaudeCliPlanUsage(
      directory === path.join(homedir(), '.claude') ? undefined : directory,
    );
    return {
      claudeUsage: usage ? parseClaudeOAuthUsageResponse(usage.rateLimits, Date.now()) : null,
    };
  }
  const rateLimits = await codexAccountRpc(directory, 'account/rateLimits/read', {}) as {
    rateLimits?: { planType?: unknown };
  } | null;
  return {
    codexUsage: providerGroupCodexUsageFromReads(null, rateLimits, Date.now()),
    codexCredits: codexCredits(rateLimits),
    // Legacy auth adapters expose identity but no plan. Preserve metadata from
    // this same profile's quota response before the scheduler sanitizes it.
    codexPlan: typeof rateLimits?.rateLimits?.planType === 'string'
      ? rateLimits.rateLimits.planType.trim() || undefined : undefined,
  };
}

/** Settings shows the balance line of the provider usage card; scheduling ignores it. */
function codexCredits(raw: unknown) {
  const credits = (raw as { rateLimits?: { credits?: unknown } } | null)?.rateLimits?.credits;
  if (!credits || typeof credits !== 'object') return null;
  const { hasCredits, unlimited, balance } = credits as Record<string, unknown>;
  return typeof hasCredits === 'boolean'
    ? {
        hasCredits,
        unlimited: unlimited === true,
        balance: typeof balance === 'string' ? balance.slice(0, 64) : null,
      }
    : null;
}

const codexRefreshes = new Map<string, Promise<unknown>>();

/** Codex's existing external-auth bridge. Never used for Claude or returned through IPC. */
export async function readNativeCodexTokens(
  directory: string,
  refresh = false,
  official = false,
  canDispatch?: () => boolean,
) {
  if (refresh) {
    let pending = codexRefreshes.get(directory);
    if (!pending) {
      pending = codexAccountRpc(directory, 'account/read', { refreshToken: true }, canDispatch,
        official ? { official: true } : undefined);
      codexRefreshes.set(directory, pending);
    }
    try {
      await pending;
    } finally {
      if (codexRefreshes.get(directory) === pending) codexRefreshes.delete(directory);
    }
  }
  const authPath = path.join(directory, 'auth.json');
  const file = await open(authPath, 'r');
  const sameFile = (a: Stats, b: Stats) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs;
  try {
    const before = await file.stat();
    if (before.size > 1024 * 1024)
      throw new Error('Codex account authentication bridge is unavailable');
    const raw = JSON.parse(await file.readFile('utf8'));
    const after = await file.stat();
    const canDispatch = () => {
      try {
        return sameFile(after, statSync(authPath));
      } catch {
        return false;
      }
    };
    if (
      !sameFile(before, after) ||
      !canDispatch() ||
      typeof raw.tokens?.access_token !== 'string' ||
      typeof raw.tokens?.account_id !== 'string'
    )
      throw new Error('Codex account authentication bridge is unavailable');
    return {
      accessToken: raw.tokens.access_token as string,
      chatgptAccountId: raw.tokens.account_id as string,
      canDispatch,
    };
  } finally {
    await file.close();
  }
}

/** Discover subscription models without loading the native CLI's gateway config or cache.
 * Only access tokens cross the in-memory external-auth bridge; auth.json is never copied.
 */
export async function withCodexModelDiscovery<T>(
  directory: string,
  isCurrent: () => boolean,
  discover: (request: (params: unknown) => Promise<unknown>, cacheDirectory: string, canPublish: () => boolean) => Promise<T>,
): Promise<T> {
  let tokens = await readNativeCodexTokens(directory);
  const accountId = tokens.chatgptAccountId;
  const isolated = await mkdtemp(path.join(tmpdir(), 'cindy-codex-models-'));
  const canDispatch = () => isCurrent() && tokens.canDispatch();
  try {
    if (!canDispatch()) throw new Error('Codex account changed before dispatch');
    return await discover(
      params => codexAccountRpc(isolated, 'model/list', params, canDispatch, {
        externalAuth: {
          accessToken: tokens.accessToken,
          chatgptAccountId: accountId,
          refresh: async previousAccountId => {
            if (previousAccountId !== accountId || !canDispatch()) throw new Error();
            const refreshed = await readNativeCodexTokens(directory, true, true, canDispatch);
            if (!isCurrent() || !refreshed.canDispatch() || refreshed.chatgptAccountId !== accountId
              || refreshed.accessToken === tokens.accessToken) throw new Error();
            tokens = refreshed;
            return { accessToken: tokens.accessToken, chatgptAccountId: accountId };
          },
        },
      }),
      isolated,
      canDispatch,
    );
  } finally {
    await rm(isolated, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Short-lived app-server control connection: no thread or inference request is made. */
export function codexAccountRpc(
  directory: string,
  method: string,
  params: unknown,
  canDispatch?: () => boolean | Promise<boolean>,
  options?: {
    official?: boolean;
    externalAuth?: {
      accessToken: string;
      chatgptAccountId: string;
      refresh: (previousAccountId: unknown) => Promise<{ accessToken: string; chatgptAccountId: string }>;
    };
  },
): Promise<unknown> {
  const binary = getReadyBinaryPath('codex');
  if (!binary) return Promise.reject(new Error('Codex CLI unavailable'));
  const externalAuth = options?.externalAuth;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server', ...(externalAuth || options?.official ? [
      '-c', 'model_provider="openai"',
      '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
    ] : []), ...(externalAuth ? [
      '-c', 'cli_auth_credentials_store="ephemeral"',
    ] : [])], {
      cwd: externalAuth ? directory : homedir(),
      env: codexProfileEnv(directory),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let settled = false;
    let closed = false;
    let buffer = '';
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const complete = () => { if (error) reject(error); else resolve(result); };
      // The discovery owner removes its temporary home on completion. Wait for
      // the process to exit first, including on Windows where open files block rm.
      if (externalAuth && !closed) {
        child.once('close', complete);
        child.kill('SIGKILL');
      } else {
        child.kill();
        complete();
      }
    };
    // A stalled read is almost always the CLI waiting on its account service (startup refreshes).
    const timer = setTimeout(() => finish(new AccountServiceUnreachableError('Codex account read timed out')), 15_000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    const dispatch = async (message = { id: 2, method, params }) => {
      try {
        if (canDispatch) {
          const allowed = canDispatch();
          // Existing synchronous proofs and the write must stay in the same synchronous segment.
          if (!(typeof allowed === 'boolean' ? allowed : await allowed))
            return finish(new Error('Codex account changed before dispatch'));
        }
        // An asynchronous credential/source check can outlive this control connection.
        if (!settled) send(message);
      } catch {
        finish(new Error('Codex account changed before dispatch'));
      }
    };
    child.stdin.on('error', () => finish(new Error('Codex account connection closed')));
    child.on('error', () => finish(new Error('Codex CLI unavailable')));
    child.on('close', () => { closed = true; finish(new Error('Codex account connection closed')); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1_048_576) return finish(new Error('Codex account response too large'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: number | string; method?: string; params?: unknown; error?: unknown; result?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (externalAuth && message.id !== undefined && message.method === 'account/chatgptAuthTokens/refresh') {
          const requestId = message.id;
          const request = message.params as { reason?: unknown; previousAccountId?: unknown } | null;
          void (async () => {
            try {
              if (request?.reason !== 'unauthorized' || settled) throw new Error();
              const tokens = await externalAuth.refresh(request.previousAccountId);
              // Refresh awaits the source CLI; a timeout/account change must prevent a late token write.
              if (settled) return;
              if (canDispatch) {
                const allowed = canDispatch();
                if (!(typeof allowed === 'boolean' ? allowed : await allowed)) throw new Error();
              }
              if (!settled) send({ id: requestId, result: tokens });
            } catch {
              finish(new Error('Codex account authentication is unavailable or has changed'));
            }
          })();
          continue;
        }
        if (message.method) {
          if (!settled && message.id !== undefined)
            send({ id: message.id, error: { code: -32601, message: 'Unsupported account request' } });
          continue;
        }
        if (message.error) return finish(codexRequestError(message.error));
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          // Startup may await configuration/auth refresh. A reset must still use
          // the exact credential observed before spawning this control connection.
          void dispatch(externalAuth
            ? { id: 3, method: 'config/read', params: { includeLayers: false } }
            : undefined);
        } else if (externalAuth && message.id === 3) {
          if ((message.result as { config?: { cli_auth_credentials_store?: unknown } })?.config?.cli_auth_credentials_store !== 'ephemeral')
            return finish(new Error('Codex isolated authentication is unavailable'));
          void dispatch({ id: 4, method: 'account/login/start', params: {
            type: 'chatgptAuthTokens', accessToken: externalAuth.accessToken, chatgptAccountId: externalAuth.chatgptAccountId,
          } });
        } else if (externalAuth && message.id === 4) {
          if ((message.result as { type?: unknown })?.type !== 'chatgptAuthTokens')
            return finish(new Error('Codex isolated authentication is unavailable'));
          void dispatch();
        } else if (message.id === 2) finish(undefined, message.result);
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'cindy', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

export async function loginNativeAccount(
  provider: SubscriptionProvider,
  directory: string,
  signal: AbortSignal,
  options?: { renew?: boolean; expectedEmail?: string },
): Promise<void> {
  if (provider === 'anthropic') {
    const result = await runClaudeCliLogin(
      signal,
      directory === path.join(homedir(), '.claude') ? undefined : directory,
      options,
    );
    if (!result.ok) throw new Error(result.reason);
    return;
  }
  const binary = getReadyBinaryPath('codex');
  if (!binary) throw new Error('Codex CLI unavailable');
  if (signal.aborted) throw new Error('login_cancelled');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['login'], {
      cwd: homedir(),
      env: codexProfileEnv(directory),
      stdio: 'ignore',
      windowsHide: true,
    });
    const stop = () => child.kill();
    const timer = setTimeout(stop, 5 * 60_000);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    };
    child.once('error', () => {
      cleanup();
      reject(new Error('Codex CLI unavailable'));
    });
    child.once('close', (code) => {
      cleanup();
      if (signal.aborted) reject(new Error('login_cancelled'));
      else if (code !== 0) reject(new Error('login_failed'));
      else resolve();
    });
  });
  let state: Awaited<ReturnType<typeof readNativeAccount>>;
  try {
    state = await readNativeAccount(provider, directory);
  } catch (error) {
    // The CLI finished its browser login; only this follow-up read could not reach the service.
    // The caller confirms the sign-in itself and reports the connection problem if it persists.
    if (isAccountServiceUnreachable(error)) return;
    throw error;
  }
  if (!state.authenticated)
    throw new Error(
      state.errorReason === 'codex_provider_managed_auth'
        ? 'codex_provider_managed_auth'
        : 'not_a_subscription',
    );
}
