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
} from '../maker-host/claude-native-cli.js';
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
): Promise<AuthState & { plan?: string }> {
  if (provider === 'anthropic') {
    const result = await refreshClaudeCliLoginStatus({
      configDir: directory === path.join(homedir(), '.claude') ? undefined : directory,
    });
    return {
      authenticated: result.loggedIn,
      identity: result.email,
      authSource: 'oauth',
      plan: result.subscriptionType,
    };
  }
  const result = (await codexAccountRpc(directory, 'account/read', { refreshToken: false })) as {
    account?: { type?: string; email?: string; planType?: string } | null;
  };
  return {
    authenticated: result.account?.type === 'chatgpt',
    identity: result.account?.email,
    plan: result.account?.planType,
    authSource: 'oauth',
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
  return {
    codexUsage: providerGroupCodexUsageFromReads(
      null,
      await codexAccountRpc(directory, 'account/rateLimits/read', {}),
      Date.now(),
    ),
  };
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
): Promise<void> {
  if (provider === 'anthropic') {
    const result = await runClaudeCliLogin(
      signal,
      directory === path.join(homedir(), '.claude') ? undefined : directory,
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
  if (!(await readNativeAccount(provider, directory)).authenticated)
    throw new Error('not_a_subscription');
}
