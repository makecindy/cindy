import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRefreshBackoff } from '../authRefreshBackoff';
import { AuthApiError, retryAfterDeadline } from '@cindy/auth-client';
import { runRefreshWithReplacementRetry, resolveSessionExpiredReason } from '../authRefreshFailure';
import {
  awaitWithStartupTimeout,
  resolveColdStartTimeoutRecovery,
  ColdStartAuthFallbackRegistry,
  commitColdStartRefreshIfCurrent,
} from '../authStartupGate';
import { loginPreparingErrorState } from '../../shared/authIpc';

// Test value (unit): execute the production cold-start and login-action entrypoints with
// in-memory credentials/network. On 2026-10-29 three DNS failures stranded a valid login;
// the pure startup-gate tests did not exercise ongoing retries or the reset action.
// Minimal input: a saved session, repeated status=0 responses, then recovery/manual action.
// Compile once; never load Electron, a real credential store, or sleep in wall-clock time.
const source = ts.createSourceFile(
  'authManager.ts',
  readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  'apiFetch',
  'commitDesktopRefreshCredentials',
  'readStoredRefreshTokenCandidates',
  'readActiveVaultRefreshCandidate',
  'writeResourceSessionToVault',
  'initialize',
  'refresh',
  'scheduleRefresh',
  'scheduleRefreshRetry',
  'scheduleRefreshRetryAfterTransientFailure',
  'getRefreshErrorCode',
  'runColdStartRefreshFlow',
  'runAuthRefreshWithReplacementRetry',
  'recoverActiveResourceSession',
  'bindResourcePairToSavedAccount',
  'isDefinitiveRefreshError',
  'waitForColdStartRetry',
  'stopColdStartRecovery',
  'runLoginAction',
]);
const compiled = ts.transpileModule(
  `
let authStateEpoch = 0, loginFlowEpoch = 0, accessToken = null, currentUser = null;
let activeAuthRealm = 'global', pendingAuthRealm = null, loginFlowState = null;
let coldStartAuthInFlight = null, coldStartRetryWait = null, refreshTimer = null;
let coldStartRecoveryStopped = false, coldStartRetryState = null;
let lastAcceptedRefreshToken = null, persistedRefreshTokenNeedsIdentityCheck = false;
let foreignDeviceLocalSignOut = false;
let refreshPromise = null;
const uncertainResourceRefreshTokens = new Map();
const pendingResourceRefreshResults = new Map();
const refreshBackoff = new AuthRefreshBackoff();
const passiveLocalSignOut = false, settledLoginCommitCount = 0;
const API_FETCH_TIMEOUT_MS = 15000;
const AUTH_REGION = 'global';
const COLD_START_AUTH_GATE_TIMEOUT_MS = 20000;
const LEGACY_RESOURCE_REFRESH_TOKEN_KEY = 'legacy-resource';
const LEGACY_REFRESH_TOKEN_KEY = 'legacy', LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'legacy-account';
const REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT = 2;
const COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [100, 250];
const RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [250, 1000];
const credentialStoreHealth = { unavailable: false, noteRecovered() {} };
const coldStartTimeoutFallbacks = new ColdStartAuthFallbackRegistry();
const snapshotAuthState = () => ({ isAuthenticated: !!accessToken, user: currentUser });
const snapshotLoggedOutAuthState = snapshotAuthState;
const readPersistedAuthSession = () => saved.session;
const readPersistedRefreshToken = (realm) => saved.session?.realm === realm ? saved.session.refreshToken : null;
const hasPotentiallyPersistedAuthCredentials = () => !!saved.session;
const assertLoginFlowCurrent = (epoch) => { if (epoch !== loginFlowEpoch) throw new Error('superseded'); };
const finishColdStartSignedOut = async () => snapshotAuthState();
const recoverAccountFreeOwnerAtStartup = async () => {
  onStartupFallback();
  coldStartTimeoutFallbacks.record(authStateEpoch, authStateEpoch + 1);
  authStateEpoch++; loginFlowEpoch++;
};
const reconcileDesktopActiveAuthSession = async () => saved.session;
${source.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
  .map((node) => node.getText(source).replace(/^export /, ''))
  .join('\n')}
return {
  fetch: apiFetch, start: initialize, runtimeRefresh: refresh, reset: () => runLoginAction({ type: 'reset' }),
  runtimePending: () => refreshPromise,
  manualLogin: () => runLoginAction({ type: 'discover', identifier: 'test@example.invalid' }),
  state: snapshotAuthState,
  activateRuntime: () => { accessToken = 'test-expired'; currentUser = { id: 'original' }; },
  backoff: refreshBackoff,
  fallback: () => { coldStartTimeoutFallbacks.record(authStateEpoch, authStateEpoch + 1); authStateEpoch++; loginFlowEpoch++; },
  changeOwner: () => {
    authStateEpoch++; accessToken = 'test-new-login'; currentUser = { id: 'other' };
    saved.session = { version: 1, realm: 'global', refreshToken: 'other-refresh' };
    vault.activeAccountKey = 'global:other';
    vault.resources['global:other'] = { realm: 'global', refreshToken: 'other-refresh' };
  },
  stop: stopColdStartRecovery,
  logoutForTest: () => { stopColdStartRecovery(); authStateEpoch++; saved.session = null;
    pendingResourceRefreshResults.clear(); uncertainResourceRefreshTokens.clear();
    vault.resources = {}; vault.activeAccountKey = null; vault.signedOutAt = Date.now(); },
};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

function setup(random = 0) {
  const saved: { session: any } = {
    session: { version: 1, realm: 'global', refreshToken: 'test-refresh' },
  };
  const membership = { id: 'original', kind: 'personal', passportId: 'passport-original' };
  const vault: any = {
    activeAccountKey: 'global:original',
    resources: { 'global:original': { realm: 'global', refreshToken: 'test-refresh' } },
    passports: {},
  };
  const ok = {
    ok: true,
    status: 200,
    data: { accessToken: 'test-access', refreshToken: 'test-rotated', membership },
  };
  const request = vi
    .fn<(...args: unknown[]) => Promise<any>>()
    .mockResolvedValue({ ok: false, status: 0, data: null });
  const loadProviders = vi.fn(async () => ({ step: 'identifier' }));
  const transaction = vi.fn(async (mutate: any, afterPersist: any) => {
    const result = mutate(vault);
    await afterPersist(result);
    return result;
  });
  const clear = vi.fn(async () => {
    saved.session.refreshToken = '';
  });
  const exchangeAccountMembership = vi.fn(async () => ok.data);
  const deps = {
    saved,
    vault,
    onStartupFallback: vi.fn(),
    transactAuthAccountVault: transaction,
    accountVaultKey: (realm: string, id: string) => `${realm}:${id}`,
    loggedOutAccountKeySet: () => new Set(),
    passportVaultKey: (realm: string, id: string) => realm + ':' + id,
    readAuthAccountVault: () => vault,
    isLoggedOutVaultAccount: (value: { loggedOutAccountKeys?: string[] }, key: string) =>
      value.loggedOutAccountKeys?.includes(key) ?? false,
    readSafe: () => null,
    writePersistedAuthSessionOrThrow: vi.fn((refreshToken: string, realm: string) => {
      saved.session = { version: 1, realm, refreshToken };
    }),
    metadataFromMembership: (membership: unknown) => membership,
    AuthRefreshBackoff: class extends AuthRefreshBackoff {
      constructor() {
        super(
          () => Date.now(),
          () => random,
        );
      }
    },
    AuthApiError,
    retryAfterDeadline,
    authServerUrl: () => 'https://auth.example.invalid',
    net: { fetch: vi.fn() },
    requestErrorMessage: String,
    ColdStartAuthFallbackRegistry,
    commitColdStartRefreshIfCurrent,
    awaitWithStartupTimeout,
    resolveColdStartTimeoutRecovery,
    readReloginFlag: () => null,
    removeSafe: vi.fn(),
    isOwnerChangeShellPending: () => false,
    ownerChangeShellGate: { isPending: () => false },
    sealedLoginFlowCommitDepths: new Set(),
    runRefreshWithReplacementRetry,
    resolveSessionExpiredReason,
    loginPreparingErrorState,
    requestAuthRefresh: request,
    loadClientEndpointsForRealm: vi.fn(async () => {}),
    loadLoginProviders: loadProviders,
    refreshPassportSessionSingleFlight: vi.fn(async () => ({ accountToken: 'test-account-access' })),
    exchangeAccountMembership,
    createAuthClient: () => ({
      discover: vi.fn(),
      exchangeAccountMembership,
    }),
    expireRuntimeAuth: vi.fn(async () => {}),
    log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    clearConfirmedDeadRefreshTokens: clear,
    resetActiveAuthRealmToBuild: vi.fn(),
    isPassiveSharedUserDataInstance: vi.fn(() => false),
    canRestoreAuthSessionForMembership: () => true,
    getActiveAppSession: () => ({ mode: 'signed-out', dataOwnerId: null }),
    withCloudOwnerCommit: async (options: any) => {
      await options.prepareTransition();
      await options.prepareCommit?.();
      options.commit();
    },
    accountSwitchTeardown: vi.fn(async () => {}),
    claimLegacyNamespaceForVerifiedUser: vi.fn(async () => {}),
    mapMembershipToAuthUser: (value: unknown) => value,
    commitCloudAppSession: vi.fn(),
    clearReplacementIntegrationReloadTimers: vi.fn(),
    migrateLocalProviderBindingsAfterCloudCommit: vi.fn(async () => {}),
    scheduleCanaryFlagSync: vi.fn(),
    scheduleXdOrgBetaDefault: vi.fn(),
    notifyAccessTokenRefreshed: vi.fn(),
    mergeMembershipWithExisting: (membership: unknown) => membership,
    getProviderSecretStore: () => ({ reconcileOwner: vi.fn() }),
    notifyRenderer: vi.fn(),
    notifyAuthListeners: vi.fn(),
  };
  const main = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  return { ...main, saved, vault, request, ok, transaction, clear, loadProviders, deps };
}

describe('saved login recovery after startup network failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps slowly retrying beyond three failures and restores the original account after the startup fallback', async () => {
    const h = setup();
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toMatchObject({ isAuthenticated: false });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.request.mock.calls.length).toBeGreaterThan(3);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(h.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.deps.notifyAuthListeners).toHaveBeenCalled();
  });

  it('retry restores the saved login instead of fetching fresh login providers', async () => {
    const h = setup();
    h.request.mockResolvedValue(h.ok);
    await expect(h.reset()).resolves.toMatchObject({ success: true, state: { step: 'completed' } });
    expect(h.loadProviders).not.toHaveBeenCalled();
    expect(h.saved.session.refreshToken).toBe('test-rotated');
  });

  it('manual login stops the waiting recovery without clearing the saved credential', async () => {
    const h = setup();
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await h.manualLogin();
    const attempts = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    await pending;
    await expect(h.start()).resolves.toMatchObject({ isAuthenticated: false });
    expect(h.request).toHaveBeenCalledTimes(attempts);
    expect(h.saved.session.refreshToken).toBe('test-refresh');
  });

  it('retry wakes a network backoff and reuses the saved session immediately', async () => {
    const h = setup();
    void h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockResolvedValue(h.ok);
    await expect(h.reset()).resolves.toMatchObject({ success: true, state: { step: 'completed' } });
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.loadProviders).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('preserves only the old saved account rotation after an owner change', async () => {
    const h = setup();
    let resolve!: (value: unknown) => void;
    h.request.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(0);
    h.changeOwner();
    resolve(h.ok);
    await expect(pending).resolves.toMatchObject({ user: { id: 'other' } });
    expect(h.saved.session.refreshToken).toBe('other-refresh');
    expect(h.vault.resources['global:original'].refreshToken).toBe('test-rotated');
    expect(h.vault.activeAccountKey).toBe('global:other');
    expect(h.deps.notifyAuthListeners).not.toHaveBeenCalled();
  });

  // PR #7737: stopping publication must not lose a rotating request's result or
  // its server deadline. Existing tests only stopped a timer or changed owner.
  // Minimal sequences below execute initialize/reset with an in-flight reply (unit).
  it.each(['network', 'vault'])(
    'keeps the rotation when manual login stops publication during %s',
    async (phase) => {
      const h = setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (phase === 'network')
        h.request.mockImplementationOnce(async () => {
          await gate;
          return h.ok;
        });
      else {
        h.request.mockResolvedValue(h.ok);
        h.transaction.mockImplementationOnce(async (mutate: any, afterPersist: any) => {
          await gate;
          const result = mutate(h.vault);
          await afterPersist(result);
          return result;
        });
      }
      const pending = h.start();
      await vi.advanceTimersByTimeAsync(0);
      await h.manualLogin();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.deps.onStartupFallback).not.toHaveBeenCalled();
      release();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(h.saved.session.refreshToken).toBe('test-rotated');
      expect(h.state()).toMatchObject({ isAuthenticated: false });
      expect(h.deps.notifyAuthListeners).not.toHaveBeenCalled();
    },
  );

  it.each(['logout', 'newer-token'])(
    'does not resurrect or overwrite credentials after %s',
    async (change) => {
      const h = setup();
      let resolve!: (value: unknown) => void;
      h.request.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      const pending = h.start();
      await vi.advanceTimersByTimeAsync(0);
      if (change === 'logout') h.logoutForTest();
      else {
        h.stop();
        h.saved.session.refreshToken = 'newer-refresh';
        h.vault.resources['global:original'].refreshToken = 'newer-refresh';
      }
      resolve(h.ok);
      await pending;
      expect(h.saved.session?.refreshToken).toBe(change === 'logout' ? undefined : 'newer-refresh');
      expect(h.vault.resources['global:original']?.refreshToken).toBe(
        change === 'logout' ? undefined : 'newer-refresh',
      );
    },
  );

  it('continues a retry requested before the stopped request fails without offering new login', async () => {
    const h = setup();
    let resolve!: (value: unknown) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    void h.start();
    await vi.advanceTimersByTimeAsync(0);
    await h.manualLogin();
    const reset = h.reset();
    resolve({ ok: false, status: 0, data: null });
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(20_000);
    await reset;
    expect(h.loadProviders).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.state()).toMatchObject({ isAuthenticated: true });
  });

  it.each([false, true])(
    'retains the server deadline across stopping and restarting (late=%s)',
    async (late) => {
      const h = setup(0.5);
      const failure = { ok: false, status: 503, data: {}, retryAt: Date.now() + 120_000 };
      let resolve!: (value: unknown) => void;
      h.request.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      void h.start();
      await vi.advanceTimersByTimeAsync(0);
      if (!late) {
        resolve(failure);
        await vi.advanceTimersByTimeAsync(0);
      }
      h.stop();
      if (late) resolve(failure);
      await vi.advanceTimersByTimeAsync(0);
      const reset = h.reset();
      h.request.mockResolvedValue(h.ok);
      await vi.advanceTimersByTimeAsync(20_000);
      await reset;
      await vi.advanceTimersByTimeAsync(129_999);
      expect(h.request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.state()).toMatchObject({ isAuthenticated: true });
    },
  );

  // PR #7737 replacement-token regression (unit): existing deadline tests keep
  // the same token. initialize must retain both Retry-After and failure history
  // when A fails, another instance writes B, and the replacement request is limited.
  it.each([
    { status: 429, resume: false },
    { status: 503, resume: true },
  ])('keeps replacement-token backoff ($status, resume=$resume)', async ({ status, resume }) => {
    const h = setup(0.5);
    h.request
      .mockResolvedValueOnce({ ok: false, status: 503, data: {} })
      .mockImplementationOnce(async () => {
        h.saved.session.refreshToken = 'test-replacement';
        h.vault.resources['global:original'].refreshToken = 'test-replacement';
        return { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } };
      })
      .mockImplementationOnce(async () => ({
        ok: false,
        status,
        data: {},
        retryAt: Date.now() + 240_000,
      }))
      .mockResolvedValue(h.ok);
    void h.start();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-refresh',
      'test-refresh',
      'test-replacement',
    ]);
    if (resume) {
      h.stop();
      await vi.advanceTimersByTimeAsync(0);
      const reset = h.reset();
      await vi.advanceTimersByTimeAsync(20_000);
      await reset;
      expect(h.loadProviders).not.toHaveBeenCalled();
    }
    // The second failure adds 60s of jitter after the 240s server deadline.
    // Resetting the failure count would retry 30s early; retaining A's key retries now.
    await vi.advanceTimersByTimeAsync(299_999 - (resume ? 20_000 : 0));
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.saved.session.refreshToken).toBe('test-replacement');
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenLastCalledWith('test-replacement', 'global');
    expect(h.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('coalesces multiple retry clicks and runtime refresh behind the pending request', async () => {
    const h = setup();
    let resolve!: (value: unknown) => void;
    h.request.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    void h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    const first = h.reset();
    const second = h.reset();
    await vi.advanceTimersByTimeAsync(0);
    await expect(h.runtimeRefresh()).resolves.toBe(false);
    expect(h.request).toHaveBeenCalledTimes(1);
    resolve(h.ok);
    await expect(first).resolves.toMatchObject({ success: true });
    await expect(second).resolves.toMatchObject({ success: true });
    expect(h.loadProviders).not.toHaveBeenCalled();
  });

  it.each([
    { status: 429, serverWait: undefined },
    { status: 429, serverWait: 120_000 },
    { status: 503, serverWait: 120_000 },
  ])(
    'keeps server cooldown and jitter across retry clicks ($status, $serverWait)',
    async ({ status, serverWait }) => {
      const h = setup(0.5);
      // Exercise HTTP header parsing too: the old path dropped Retry-After on
      // 503, so injecting retryAt directly would miss the premature retry bug.
      h.deps.net.fetch.mockResolvedValue(
        new Response('{}', {
          status,
          headers: serverWait === undefined ? {} : { 'Retry-After': String(serverWait / 1000) },
        }),
      );
      h.request.mockImplementation(() => h.fetch('/api/auth/refresh', { timeoutMs: 0 }));
      void h.start();
      await vi.advanceTimersByTimeAsync(20_000);
      const retry = h.reset();
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(retry).resolves.toMatchObject({
        success: false,
        code: 'AUTH_SERVICE_UNAVAILABLE',
      });
      expect(h.request).toHaveBeenCalledTimes(1);
      h.request.mockResolvedValue(h.ok);
      await vi.advanceTimersByTimeAsync((serverWait ?? 60_000) + 30_000 - 40_001);
      expect(h.request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.state()).toMatchObject({ isAuthenticated: true });
    },
  );

  it('retries endpoint discovery without sending the credential to a fallback realm', async () => {
    const h = setup();
    h.deps.loadClientEndpointsForRealm.mockRejectedValue(new Error('offline'));
    void h.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.request).not.toHaveBeenCalled();
    h.deps.loadClientEndpointsForRealm.mockResolvedValue();
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.state()).toMatchObject({ isAuthenticated: true });
  });

  it.each(['REFRESH_TOKEN_EXPIRED', 'DEVICE_MISMATCH'])(
    'stops after terminal response %s',
    async (code) => {
      const h = setup();
      h.request.mockResolvedValue({ ok: false, status: 401, data: { error: { code } } });
      await expect(h.start()).resolves.toMatchObject({ isAuthenticated: false });
      await vi.advanceTimersByTimeAsync(300_000);
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.clear).toHaveBeenCalledTimes(code === 'REFRESH_TOKEN_EXPIRED' ? 1 : 0);
    },
  );
});

// Unit regression: runtime refresh + its real timer must recover within 3 seconds
// after three transport failures and a trusted 401 (2026-11-04 outage). Existing
// cold-start tests and admission-only backoff tests never ran this timer path.
// Each quick attempt now needs evidence received after the previous launch;
// without it the original long deadline must resume (2026-11-04 follow-up).
describe('runtime token rejection after an offline backoff', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('requires fresh 401 evidence for every quick attempt and retains its tier across an offline wait', async () => {
    const h = setup(0.5);
    h.activateRuntime();
    await h.runtimeRefresh();
    await vi.advanceTimersByTimeAsync(90_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(h.request).toHaveBeenCalledTimes(3);
    const longDeadline = Date.now() + h.backoff.remaining(0);
    await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(1_000);
    for (let i = 0; i < 4; i++) await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(h.request).toHaveBeenCalledTimes(4);
    expect(Date.now() + h.backoff.remaining(0)).toBe(longDeadline);

    // No new evidence: the timer returns to the original long deadline, even
    // though the quick tier's earliest retry time has already passed.
    await vi.advanceTimersByTimeAsync(65_000);
    expect(h.request).toHaveBeenCalledTimes(4);
    expect(Date.now() + h.backoff.runtimeRemaining(0)).toBe(longDeadline);
    await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.request).toHaveBeenCalledTimes(5);
    expect(Date.now() + h.backoff.remaining(0)).toBe(longDeadline);

    let finish!: (result: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await h.runtimeRefresh({ serverRejectedToken: true });
    // Tier retained across the 65s outage: the next floor is 3s, not 1.5s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.request).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(h.request).toHaveBeenCalledTimes(6);
    // Evidence received after launch (even while in flight) may authorize the
    // following attempt, but never a concurrent request or a second deadline.
    const concurrent = [h.runtimeRefresh(), h.runtimeRefresh({ serverRejectedToken: true })];
    finish({ ok: false, status: 0, data: null });
    await expect(Promise.all(concurrent)).resolves.toEqual([false, false]);
    h.request.mockResolvedValue(h.ok);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.request).toHaveBeenCalledTimes(7);
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.backoff.remaining(0)).toBe(0);
    expect(h.deps.notifyAccessTokenRefreshed).toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it.each([503, 0])('keeps Retry-After despite 401s after leaving the quick retry path (status=%s)', async status => {
    const h = setup(0.5);
    h.activateRuntime();
    await h.runtimeRefresh();
    await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(1_500); // One quick transport failure.
    const retryAt = Date.now() + 600_000;
    h.request.mockResolvedValue({ ok: false, status, retryAt, data: null });
    await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(2_250);
    expect(h.request).toHaveBeenCalledTimes(3);
    // The failed quick request consumes only the next long tier (2–4m).
    const deadline = retryAt + 60_000;
    expect(Date.now() + h.backoff.remaining(0)).toBe(deadline);
    for (let i = 0; i < 5; i++) await h.runtimeRefresh({ serverRejectedToken: true });
    await vi.advanceTimersByTimeAsync(deadline - Date.now() - 1);
    expect(h.request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.request).toHaveBeenCalledTimes(4);
  });
});

// Test value (unit): real initialize/refresh entrypoints must recover a consumed
// Resource token through the already-saved Passport, without changing identity.
// 2026-11-08: transport failure followed by INVALID_REFRESH_TOKEN deleted a login;
// existing retries only covered a replacement already present on disk. Minimal
// input: one saved account/Passport, lost refresh response, then rejected old token.
describe('lost Resource rotation response', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  function setupSavedPassport() {
    const h = setup();
    h.vault.resources['global:original'].metadata = {
      membershipId: 'original', passportId: 'passport-original',
    };
    h.vault.passports['global:passport-original'] = {
      realm: 'global', passportId: 'passport-original', accountRefreshToken: 'test-passport-refresh',
    };
    h.request.mockResolvedValue({
      ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } },
    });
    return h;
  }

  async function beginRuntimeRecovery(h: ReturnType<typeof setup>, uncertainStatus = 0) {
    h.activateRuntime();
    h.request.mockResolvedValueOnce({ ok: false, status: uncertainStatus, data: null });
    await h.runtimeRefresh();
    await vi.advanceTimersByTimeAsync(60_000);
    return { pending: h.runtimePending() ?? Promise.resolve(false) };
  }

  it.each([['runtime', 0], ['runtime', 200], ['cold-start', 0]] as const)(
    'recovers the same saved account during %s after uncertain status %s', async (phase, status) => {
    const h = setupSavedPassport();
    let pending: Promise<unknown>;
    if (phase === 'runtime') {
      ({ pending } = await beginRuntimeRecovery(h, status));
    } else {
      h.request.mockResolvedValueOnce({ ok: false, status: 0, data: null });
      pending = h.start();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.deps.exchangeAccountMembership).toHaveBeenCalledWith('test-account-access', 'original');
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
    },
  );

  it('preserves credentials and Retry-After when Passport recovery is rate limited', async () => {
    const h = setupSavedPassport();
    h.activateRuntime();
    const retryAt = Date.now() + 600_000;
    h.deps.refreshPassportSessionSingleFlight.mockRejectedValue(
      new AuthApiError('RATE_LIMITED', 429, 'Test rate limit', retryAt),
    );
    const { pending } = await beginRuntimeRecovery(h);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(h.deps.refreshPassportSessionSingleFlight).toHaveBeenCalledOnce();
    expect(h.deps.exchangeAccountMembership).not.toHaveBeenCalled();
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    expect(Date.now() + h.backoff.remaining(0)).toBeGreaterThanOrEqual(retryAt);
  });

  it.each(['missing-passport', 'logged-out', 'passive', 'unambiguous-invalid', 'DEVICE_MISMATCH', 'MEMBERSHIP_DISABLED'])(
    'does not attempt Passport recovery for %s', async reason => {
      const h = setupSavedPassport();
      h.activateRuntime();
      if (reason === 'missing-passport') h.vault.passports = {};
      else if (reason === 'logged-out') h.vault.loggedOutAccountKeys = ['global:original'];
      else if (reason === 'passive') h.deps.isPassiveSharedUserDataInstance.mockReturnValue(true);
      else if (reason !== 'unambiguous-invalid')
        h.request.mockResolvedValue({ ok: false, status: 401, data: { error: { code: reason } } });
      const { pending } = reason === 'unambiguous-invalid'
        ? { pending: h.runtimeRefresh() }
        : await beginRuntimeRecovery(h);
      await vi.advanceTimersByTimeAsync(2_000);
      await pending;
      expect(h.deps.refreshPassportSessionSingleFlight).not.toHaveBeenCalled();
      expect(h.deps.exchangeAccountMembership).not.toHaveBeenCalled();
      expect(h.deps.expireRuntimeAuth).toHaveBeenCalledOnce();
    },
  );

  it('stops recovery if the owner changes while the Passport request is in flight', async () => {
    const h = setupSavedPassport();
    h.activateRuntime();
    let finish!: (value: { accountToken: string }) => void;
    h.deps.refreshPassportSessionSingleFlight.mockImplementationOnce(
      () => new Promise(resolve => { finish = resolve; }),
    );
    const { pending } = await beginRuntimeRecovery(h);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.deps.refreshPassportSessionSingleFlight).toHaveBeenCalledOnce();
    h.changeOwner();
    finish({ accountToken: 'test-account-access' });
    await pending;
    expect(h.deps.exchangeAccountMembership).not.toHaveBeenCalled();
    expect(h.saved.session.refreshToken).toBe('other-refresh');
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
  });

  it('rejects a recovered membership belonging to another account', async () => {
    const h = setupSavedPassport();
    h.activateRuntime();
    h.deps.exchangeAccountMembership.mockResolvedValue({
      ...h.ok.data, membership: { ...h.ok.data.membership, id: 'unexpected' },
    });
    const { pending } = await beginRuntimeRecovery(h);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    expect(h.state()).toMatchObject({ user: { id: 'original' } });
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
  });

  it('retries saving a received rotation without consuming the rejected predecessor again', async () => {
    const h = setup();
    h.activateRuntime();
    h.request.mockResolvedValueOnce(h.ok);
    h.transaction.mockRejectedValueOnce(
      new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE', 503, 'Test vault write failed'),
    );
    await expect(h.runtimeRefresh()).resolves.toBe(false);
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
  });

  // PR #9429 P1: two processes can persist A -> B -> C while both projection
  // writes fail. Execute refresh and the commit callback with C arriving before
  // the retry or after it starts waiting for the vault lock; B must never win.
  it.each(['before-retry', 'inside-vault-transaction'])(
    'preserves a newer vault generation when it changes %s',
    async (timing) => {
      const h = setup();
      h.activateRuntime();
      h.request.mockResolvedValueOnce(h.ok);
      h.deps.writePersistedAuthSessionOrThrow.mockImplementationOnce(() => {
        throw new Error('Test projection write failed');
      });
      await expect(h.runtimeRefresh()).resolves.toBe(false);
      expect(h.vault.resources['global:original'].refreshToken).toBe('test-rotated');
      expect(h.saved.session.refreshToken).toBe('test-refresh');

      const advanceVault = () => {
        h.vault.resources['global:original'].refreshToken = 'test-newer';
      };
      if (timing === 'before-retry') advanceVault();
      else h.transaction.mockImplementationOnce(async (
        mutate: (vault: typeof h.vault) => unknown,
        afterPersist: (result: unknown) => unknown,
      ) => {
        advanceVault();
        const result = mutate(h.vault);
        await afterPersist(result);
        return result;
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.vault.resources['global:original'].refreshToken).toBe('test-newer');
      expect(h.saved.session.refreshToken).toBe('test-refresh');
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.deps.notifyAccessTokenRefreshed).not.toHaveBeenCalled();
      expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();

      // Discard the stale cache and let the existing replacement reader catch
      // up from C. A rejected projection must not strand or delete that login.
      h.request.mockResolvedValueOnce({
        ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } },
      }).mockResolvedValueOnce({
        ...h.ok, data: { ...h.ok.data, refreshToken: 'test-newest' },
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.request.mock.calls.map((call: readonly unknown[]) => call[0])).toEqual([
        'test-refresh', 'test-refresh', 'test-newer',
      ]);
      expect(h.saved.session.refreshToken).toBe('test-newest');
      expect(h.vault.resources['global:original'].refreshToken).toBe('test-newest');
      expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
    },
  );

  it('repairs a failed projection when the vault still contains the cached result', async () => {
    const h = setup();
    h.activateRuntime();
    h.request.mockResolvedValueOnce(h.ok);
    h.deps.writePersistedAuthSessionOrThrow.mockImplementationOnce(() => {
      throw new Error('Test projection write failed');
    });
    await h.runtimeRefresh();
    expect(h.vault.resources['global:original'].refreshToken).toBe('test-rotated');
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.deps.notifyAccessTokenRefreshed).toHaveBeenCalledOnce();
  });

  it('keeps a newer vault generation written while the refresh request is in flight', async () => {
    const h = setup();
    h.activateRuntime();
    h.request.mockImplementationOnce(async () => {
      h.vault.resources['global:original'].refreshToken = 'test-newer';
      return h.ok;
    });
    await expect(h.runtimeRefresh()).resolves.toBe(false);
    expect(h.vault.resources['global:original'].refreshToken).toBe('test-newer');
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    expect(h.deps.notifyAccessTokenRefreshed).not.toHaveBeenCalled();
  });

  it('accepts a fresh compatibility-token rotation when the divergent vault has not changed', async () => {
    const h = setup();
    h.activateRuntime();
    h.vault.resources['global:original'].refreshToken = 'test-older-vault';
    h.request.mockResolvedValueOnce(h.ok);
    await expect(h.runtimeRefresh()).resolves.toBe(true);
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.vault.resources['global:original'].refreshToken).toBe('test-rotated');
  });

  it('preserves a newer vault generation written during Passport membership exchange', async () => {
    const h = setupSavedPassport();
    h.deps.exchangeAccountMembership.mockImplementationOnce(async () => {
      h.vault.resources['global:original'].refreshToken = 'test-newer';
      return h.ok.data;
    });
    const { pending } = await beginRuntimeRecovery(h);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe(false);
    expect(h.deps.exchangeAccountMembership).toHaveBeenCalledOnce();
    expect(h.vault.resources['global:original'].refreshToken).toBe('test-newer');
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    expect(h.deps.notifyAccessTokenRefreshed).not.toHaveBeenCalled();
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
  });

  it('continues cold-start recovery from the newer vault instead of replaying the stale cache', async () => {
    const h = setup();
    h.request.mockResolvedValueOnce(h.ok);
    h.deps.writePersistedAuthSessionOrThrow.mockImplementationOnce(() => {
      throw new Error('Test projection write failed');
    });
    await h.start();
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    h.vault.resources['global:original'].refreshToken = 'test-newer';
    h.request.mockResolvedValueOnce({
      ...h.ok, data: { ...h.ok.data, refreshToken: 'test-newest' },
    });
    await h.start();
    expect(h.request.mock.calls.map((call: readonly unknown[]) => call[0])).toEqual(['test-refresh', 'test-newer']);
    expect(h.saved.session.refreshToken).toBe('test-newest');
    expect(h.vault.resources['global:original'].refreshToken).toBe('test-newest');
    expect(h.state()).toMatchObject({ isAuthenticated: true });
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('retries saving a recovered Resource without rotating the Passport again', async () => {
    const h = setupSavedPassport();
    h.transaction.mockRejectedValueOnce(
      new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE', 503, 'Test vault write failed'),
    );
    const { pending } = await beginRuntimeRecovery(h);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(h.saved.session.refreshToken).toBe('test-refresh');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.saved.session.refreshToken).toBe('test-rotated');
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.deps.refreshPassportSessionSingleFlight).toHaveBeenCalledOnce();
    expect(h.deps.exchangeAccountMembership).toHaveBeenCalledOnce();
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
  });

  it.each(['owner-change', 'logout'])(
    'keeps successful late runtime rotations within their account after %s', async change => {
    const h = setup();
    h.activateRuntime();
    let finish!: (value: unknown) => void;
    h.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.runtimeRefresh();
    if (change === 'owner-change') h.changeOwner();
    else h.logoutForTest();
    finish(h.ok);
    await pending;
    expect(h.vault.resources['global:original']?.refreshToken).toBe(
      change === 'owner-change' ? 'test-rotated' : undefined,
    );
    expect(h.saved.session?.refreshToken).toBe(change === 'owner-change' ? 'other-refresh' : undefined);
    expect(h.deps.notifyAuthListeners).not.toHaveBeenCalled();
    },
  );
});

// Test value (unit): execute the real credential transaction against in-memory
// encrypted-record substitutes. Unlike account switching, a successful server
// rotation cannot be rolled back when writing the compatibility projection fails.
// Existing cold-start tests replaced the transaction and missed this data loss.
const makeVaultTransaction = new Function('deps', ts.transpileModule(
  'const { withCrossProcessLock, authAccountVaultLockPath, readAtomicSafe, ' +
  'isAtomicPersistedSecretAbsent, readAtomicSafeCiphertext, readAuthAccountVault, ' +
  'writeAuthAccountVaultOrThrow, removeAtomicSafeOrThrow, writeAtomicSafe, ' +
  'writeAtomicSafeCiphertext, accountVaultLockError, AuthApiError, log } = deps; ' +
  'const AUTH_ACCOUNT_VAULT_KEY = "vault", AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY = "logout"; ' +
  source.statements.find(node => ts.isFunctionDeclaration(node) &&
    node.name?.text === 'transactAuthAccountVault')!.getText(source) +
  '; return transactAuthAccountVault;',
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText);

describe('durable rotation versus account-switch rollback', () => {
  it.each([false, true])('preserves a rotated vault only when requested (%s)', async preserveRotatedCredentials => {
    const records = new Map([['vault', JSON.stringify({ token: 'test-old' })]]);
    const run = makeVaultTransaction({
      withCrossProcessLock: async (...args: [unknown, unknown, (status: { held: boolean }) => Promise<unknown>]) =>
        args[2]({ held: true }),
      authAccountVaultLockPath: () => 'test-lock',
      readAtomicSafe: (key: string) => records.get(key) ?? null,
      isAtomicPersistedSecretAbsent: (key: string) => !records.has(key),
      readAuthAccountVault: () => JSON.parse(records.get('vault')!),
      writeAuthAccountVaultOrThrow: (vault: unknown) => records.set('vault', JSON.stringify(vault)),
      removeAtomicSafeOrThrow: (key: string) => records.delete(key),
      writeAtomicSafe: (key: string, value: string) => { records.set(key, value); return true; },
      readAtomicSafeCiphertext: vi.fn(), writeAtomicSafeCiphertext: vi.fn(),
      accountVaultLockError: vi.fn(), AuthApiError,
      log: { warn: vi.fn() },
    });
    const projectionFailure = new Error('Test projection write failed');
    await expect(run(
      (vault: { token: string }) => { vault.token = 'test-rotated'; },
      () => { throw projectionFailure; },
      { preserveRotatedCredentials },
    )).rejects.toBe(projectionFailure);
    expect(JSON.parse(records.get('vault')!).token).toBe(
      preserveRotatedCredentials ? 'test-rotated' : 'test-old',
    );
  });
});
