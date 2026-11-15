import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { AuthApiError, reduceAuthFlow, type ProviderConfig } from '@cindy/auth-client';
import { describe, expect, it, vi } from 'vitest';
import { loginPreparingErrorState, parseDesktopLoginAction } from '../../shared/authIpc';

// Exercise production flow functions without initializing Electron or credentials.
const source = readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8');
function functionSource(start: string, end: string): string {
  const offset = source.indexOf(start);
  return source
    .slice(offset, source.indexOf(end, offset))
    .replaceAll('export async function', 'async function');
}

const providers: ProviderConfig = {
  region: 'global',
  attribution: 'email',
  email: true,
  phone: false,
  social: ['google'],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup({ cached = false, sealed = false, credentialStoreUnavailable = false } = {}) {
  const getProviders = vi.fn<() => Promise<ProviderConfig>>();
  const cancelActive = vi.fn();
  const deps = {
    AuthApiError,
    reduceAuthFlow,
    parseDesktopLoginAction,
    loginPreparingErrorState,
    createAuthClient: () => ({ getProviders }),
    awaitLoginProvidersWithPreparingGate: (promise: Promise<ProviderConfig>) => promise,
    browserAuthorizationSlot: { cancelActive },
    isLoginFlowCommitSealed: () => sealed,
    isOwnerChangeShellPending: () => false,
    stopColdStartRecovery: () => {},
    coldStartAuthInFlight: null,
    readPersistedAuthSession: () => null,
    credentialStoreUnavailable,
    log: { warn: vi.fn() },
    cachedProviders: cached ? providers : null,
  };
  const compiled = transpileModule(
    `
    let loginFlowEpoch = 1, loginFlowState = { step: 'error', code: 'REQUEST_TIMEOUT', recoverTo: 'identifier' };
    let providerConfig = cachedProviders, sessionInvalidationPromise = null;
    let loginActionPromise = null, loginActionPromiseEpoch = null, accessToken = null;
    const AUTH_REGION = 'global', activeAuthRealm = 'global';
    const credentialStoreHealth = { unavailable: credentialStoreUnavailable };
    let handledLoginEmail = null, pendingPersonalLogin = null, discoveredMethods = [];
    let pendingAccountToken = null, pendingAccountRefreshToken = null, pendingAccountMemberships = [];
    let pendingLoginTicket = 'old-ticket', pendingBindTicket = null, pendingSsoVerificationTicket = null;
    let pendingAuthRealm = null, pendingAccountDeletionRestored = false;
    ${functionSource('function resetLoginFlowState()', 'function sealLoginFlowCommit(')}
    ${functionSource('async function loadLoginProviders(', 'async function discoverOrganizationRealm(')}
    ${functionSource('export async function getLoginState()', 'async function completeLogin(')}
    ${functionSource('async function runLoginAction(', 'export async function refresh(')}
    return {
      dispatch: dispatchLoginAction,
      snapshot: () => ({ state: loginFlowState, ticket: pendingLoginTicket, epoch: loginFlowEpoch }),
    };
  `,
    { compilerOptions: { target: ScriptTarget.ES2022 } },
  ).outputText;
  return {
    ...new Function(...Object.keys(deps), compiled)(...Object.values(deps)),
    getProviders,
    cancelActive,
  };
}

describe('login Back without an auth-server round trip', () => {
  it.each([false, true])(
    'preserves credential recovery and private progress (cached=%s)',
    async (cached) => {
      const main = setup({ cached, credentialStoreUnavailable: true });
      expect(await main.dispatch({ type: 'back' })).toEqual({
        success: false,
        code: 'CREDENTIAL_STORE_UNAVAILABLE',
        state: { step: 'error', code: 'CREDENTIAL_STORE_UNAVAILABLE', recoverTo: 'identifier' },
      });
      expect(main.snapshot().ticket).toBe('old-ticket');
      expect(main.snapshot().epoch).toBe(1);
      expect(main.cancelActive).not.toHaveBeenCalled();
      expect(main.getProviders).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'returns locally and clears private progress (cached=%s)',
    async (cached) => {
      const main = setup({ cached });
      const result = await main.dispatch({ type: 'back' });
      expect(result).toEqual({
        success: true,
        state: cached ? { step: 'identifier', providers } : { step: 'entry' },
      });
      expect(main.getProviders).not.toHaveBeenCalled();
      expect(main.snapshot().ticket).toBeNull();
      expect(main.snapshot().epoch).toBe(2);
      expect(main.cancelActive).toHaveBeenCalledOnce();
    },
  );

  it.each(['resolve', 'reject'] as const)(
    'abandons a retry and ignores its late %s',
    async (settle) => {
      const main = setup();
      const old = deferred<ProviderConfig>();
      main.getProviders.mockReturnValueOnce(old.promise);
      const retry = main.dispatch({ type: 'reset' });
      expect(await main.dispatch({ type: 'back' })).toEqual({
        success: true,
        state: { step: 'entry' },
      });
      const next = deferred<ProviderConfig>();
      main.getProviders.mockReturnValueOnce(next.promise);
      const nextRetry = main.dispatch({ type: 'reset' });
      if (settle === 'resolve') old.resolve(providers);
      else old.reject(new AuthApiError('REQUEST_TIMEOUT', 0, 'timeout'));
      expect(await retry).toMatchObject({ success: false, code: 'AUTH_FLOW_SUPERSEDED' });
      expect(main.snapshot().state).toBeNull();
      expect(await main.dispatch({ type: 'reset' })).toMatchObject({ code: 'LOGIN_BUSY' });
      next.resolve(providers);
      expect(await nextRetry).toEqual({ success: true, state: { step: 'identifier', providers } });
      expect(main.getProviders).toHaveBeenCalledTimes(2);
    },
  );

  it('does not interrupt an accepted credential commit', async () => {
    const main = setup({ sealed: true });
    expect(await main.dispatch({ type: 'back' })).toMatchObject({
      success: false,
      code: 'LOGIN_BUSY',
    });
    expect(main.snapshot().epoch).toBe(1);
    expect(main.cancelActive).not.toHaveBeenCalled();
  });
});
