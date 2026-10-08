import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { AuthApiError as ClientAuthApiError } from '@cindy/auth-client';
import { loginPreparingErrorState } from '../../shared/authIpc';
import { mapLoginProvidersLoadFailure } from '../authStartupGate';

// Execute the production login action and eligibility predicate without loading
// Electron or opening a real credential store (same boundary as the wiring tests).
const source = readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8');
const actionSource = source.slice(
  source.indexOf('async function runLoginAction('),
  source.indexOf('export async function dispatchLoginAction('),
);
const eligibilitySource = source.slice(
  source.indexOf('export function needsCredentialProcessRecovery('),
  source.indexOf('/** Prevent automatic process recovery'),
);

function setup({
  backendUnavailable = true,
  authenticated = false,
  passive = false,
  code = 'CREDENTIAL_STORE_UNAVAILABLE',
  retryAt = undefined as number | undefined,
  initialError = false,
} = {}) {
  class AuthApiError extends Error {
    statusCode = 503;
    retryAt = retryAt;
    constructor(public code: string) {
      super(code);
    }
  }
  const previous = { step: 'verification-code', kind: 'email', identifier: 'user@example.invalid' };
  const backend = { available: !backendUnavailable };
  const deps = {
    AuthApiError,
    loginPreparingErrorState,
    createAuthClient: () => ({ verifyCode: vi.fn(async () => ({ status: 'ok' })) }),
    acceptLoginOutcome: vi.fn(async () => {
      throw new AuthApiError(code);
    }),
    log: { warn: vi.fn() },
    credentialEncryptionUnavailable: false,
    safeStorage: { isEncryptionAvailable: () => backend.available },
    app: { isReady: () => true },
    powerMonitor: { getSystemIdleState: () => 'active' },
    code,
    credentialStoreHealth: { unavailable: false },
    accessToken: authenticated ? 'test-only-token' : null,
    getActiveAppSession: () => ({ mode: authenticated ? 'signed-in' : 'signed-out' }),
    isPassiveSharedUserDataInstance: () => passive,
    previous,
    initialError,
  };
  const compiled = transpileModule(
    `
    let loginFlowState = initialError ? { step: 'error', code: 'NETWORK_ERROR' } : previous;
    let loginFlowEpoch = 1;
    const AUTH_REGION = 'global', activeAuthRealm = 'global';
    let pendingAuthRealm = null;
    const providerConfig = {};
    let credentialEncryptionFailureLogged = false;
    ${source.slice(source.indexOf('function isCredentialEncryptionAvailable('), source.indexOf('/** Main-process recovery signal'))}
    const originalAccept = acceptLoginOutcome;
    acceptLoginOutcome = async (...args) => {
      if (code === 'CREDENTIAL_STORE_UNAVAILABLE') isCredentialEncryptionAvailable();
      return originalAccept(...args);
    };
    async function loadLoginProviders() {
      loginFlowState = { step: 'identifier', providers: {} };
      return loginFlowState;
    }
    ${actionSource}
    ${eligibilitySource.replace('export function', 'function')}
    return { run: runLoginAction, needsRecovery: needsCredentialProcessRecovery,
      observeBackend: isCredentialEncryptionAvailable };
  `,
    { compilerOptions: { target: ScriptTarget.ES2022 } },
  ).outputText;
  return {
    ...new Function(...Object.keys(deps), compiled)(...Object.values(deps)),
    previous,
    backend,
  };
}

describe('credential failure during fresh sign-in', () => {
  it('retains an observed backend failure across reset and clears it on backend recovery', async () => {
    const harness = setup();
    expect(harness.needsRecovery()).toBe(false);
    await harness.run({
      type: 'verify-code',
      kind: 'email',
      identifier: 'user@example.invalid',
      code: '123456',
    });
    expect(harness.needsRecovery()).toBe(true);
    expect((await harness.run({ type: 'reset' })).state.step).toBe('identifier');
    expect(harness.needsRecovery()).toBe(true);
    await harness.run({ type: 'reset' });
    expect(harness.needsRecovery()).toBe(true);
    harness.backend.available = true;
    harness.observeBackend();
    expect(harness.needsRecovery()).toBe(false);
  });
  it('replays provider deadlines from main without another request, then drops them on a new flow', async () => {
    const loadLoginProviders = vi
      .fn()
      .mockRejectedValueOnce(
        new ClientAuthApiError('RATE_LIMITED', 429, 'limited', 1_800_000_000_000),
      )
      .mockResolvedValue({ step: 'identifier', providers: {} });
    const deps = {
      loadLoginProviders,
      mapLoginProvidersLoadFailure,
      isOwnerChangeShellPending: () => false,
      log: { warn: vi.fn() },
    };
    const getSource = source.slice(
      source.indexOf('export async function getLoginState('),
      source.indexOf('\nasync function completeLogin('),
    );
    const compiled = transpileModule(
      `
      let loginFlowState = null, loginFlowEpoch = 1, accessToken = null;
      const credentialStoreHealth = { unavailable: false };
      ${getSource.replace('export async function', 'async function')}
      return { get: getLoginState, newFlow: () => { loginFlowState = null; loginFlowEpoch++; } };
    `,
      { compilerOptions: { target: ScriptTarget.ES2022 } },
    ).outputText;
    const main = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
    const first = await main.get();
    expect(first.state.retryAt).toBe(1_800_000_000_000);
    const replay = await main.get();
    expect(replay).toEqual({ success: true, state: first.state });
    expect(loadLoginProviders).toHaveBeenCalledTimes(1);
    main.newFlow();
    expect((await main.get()).state.retryAt).toBeUndefined();
  });

  it('keeps the deadline in a terminal action error state for renderer reload', async () => {
    const harness = setup({ code: 'RATE_LIMITED', retryAt: 1_800_000_000_000, initialError: true });
    const result = await harness.run({
      type: 'verify-code',
      kind: 'email',
      identifier: 'user@example.invalid',
      code: '123456',
    });
    expect(result.state).toEqual(loginPreparingErrorState('RATE_LIMITED', 1_800_000_000_000));
  });

  it('passes the server cooldown without triggering credential recovery or dropping the form', async () => {
    const harness = setup({ code: 'RATE_LIMITED', retryAt: 1_800_000_000_000 });
    const result = await harness.run({
      type: 'verify-code',
      kind: 'email',
      identifier: 'user@example.invalid',
      code: '123456',
    });
    expect(result).toEqual({
      success: false,
      code: 'RATE_LIMITED',
      retryAt: 1_800_000_000_000,
      state: harness.previous,
    });
    expect(harness.needsRecovery()).toBe(false);
  });
  it.each([
    { backendUnavailable: true, authenticated: false, passive: false, recovery: true },
    { backendUnavailable: false, authenticated: false, passive: false, recovery: false },
    { backendUnavailable: true, authenticated: true, passive: false, recovery: false },
    { backendUnavailable: true, authenticated: false, passive: true, recovery: false },
  ])(
    'shows recovery guidance without restarting unsafe or irrelevant cases: %j',
    async ({ recovery, ...options }) => {
      const harness = setup(options);
      expect(harness.needsRecovery()).toBe(false);
      const result = await harness.run({
        type: 'verify-code',
        kind: 'email',
        identifier: 'user@example.invalid',
        code: '123456',
      });
      expect(result).toEqual({
        success: false,
        code: 'CREDENTIAL_STORE_UNAVAILABLE',
        state: { step: 'error', code: 'CREDENTIAL_STORE_UNAVAILABLE', recoverTo: 'identifier' },
      });
      expect(harness.needsRecovery()).toBe(recovery);
    },
  );

  it.each(['INVALID_CODE', 'NETWORK_ERROR'])(
    'keeps the form for %s without requesting process recovery',
    async (code) => {
      const harness = setup({ code });
      const result = await harness.run({
        type: 'verify-code',
        kind: 'email',
        identifier: 'user@example.invalid',
        code: '123456',
      });
      expect(result.state).toBe(harness.previous);
      expect(harness.needsRecovery()).toBe(false);
    },
  );
});
