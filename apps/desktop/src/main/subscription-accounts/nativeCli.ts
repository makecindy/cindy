/** Official CLI login/control APIs only. No Claude credential access. */
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { open } from 'node:fs/promises';
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
): Promise<AuthState & { plan?: string; loginExpiresAt?: string }> {
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
export async function readNativeCodexTokens(directory: string, refresh = false) {
  if (refresh) {
    let pending = codexRefreshes.get(directory);
    if (!pending) {
      pending = codexAccountRpc(directory, 'account/read', { refreshToken: true });
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

/** Short-lived app-server control connection: no thread or model request is made. */
export function codexAccountRpc(
  directory: string,
  method: string,
  params: unknown,
  canDispatch?: () => boolean,
): Promise<unknown> {
  const binary = getReadyBinaryPath('codex');
  if (!binary) return Promise.reject(new Error('Codex CLI unavailable'));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['app-server'], {
      cwd: homedir(),
      env: codexProfileEnv(directory),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let settled = false;
    let buffer = '';
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Codex account read timed out')), 15_000);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdin.on('error', () => finish(new Error('Codex account connection closed')));
    child.on('error', () => finish(new Error('Codex CLI unavailable')));
    child.on('close', () => finish(new Error('Codex account connection closed')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1_048_576) return finish(new Error('Codex account response too large'));
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: number; error?: unknown; result?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.error) return finish(new Error('Codex account request failed'));
        if (message.id === 1) {
          send({ method: 'initialized', params: {} });
          // Startup may await configuration/auth refresh. A reset must still use
          // the exact credential observed before spawning this control connection.
          if (canDispatch && !canDispatch()) return finish(new Error('Codex account changed before dispatch'));
          send({ id: 2, method, params });
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
  const state = await readNativeAccount(provider, directory);
  if (!state.authenticated)
    throw new Error(
      state.errorReason === 'codex_provider_managed_auth'
        ? 'codex_provider_managed_auth'
        : 'not_a_subscription',
    );
}
