import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthRefreshBackoff } from '../authRefreshBackoff';
import {
  accountVaultKey,
  AuthApiError,
  parseAuthSessionRecord,
  passportVaultKey,
  retryAfterDeadline,
  serializeAuthSessionRecord,
} from '@cindy/auth-client';
import {
  isDefinitiveRefreshFailure,
  isForeignDeviceRefreshFailure,
  runRefreshWithReplacementRetry,
  resolveSessionExpiredReason,
} from '../authRefreshFailure';
import {
  applyRefreshedCredentialsToVault,
  AUTH_ACCOUNT_VAULT_VERSION,
  writeResourceSessionToVault,
} from '../authRefreshCommit';
import { loggedOutAccountKeySet } from '../authAccountLogoutPolicy';
import { reconcileSavedAccountMetadata } from '../authAccountMetadata';
import { isDefinitiveRefreshError } from '../authRefreshError';
import {
  awaitWithStartupTimeout,
  resolveColdStartTimeoutRecovery,
  ColdStartAuthFallbackRegistry,
  commitColdStartRefreshIfCurrent,
} from '../authStartupGate';
import { loginPreparingErrorState, parseDesktopAccountKey, parseDesktopLoginAction } from '../../shared/authIpc';
import { HOST_NOT_STARTED, readHostUnavailableReason } from '../../shared/hostStartFailure';
import { createIpcError } from '../../shared/ipc-errors';
import { accessTokenRefreshDelayMs } from '../authTokenClaims';
import {
  AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY,
  AUTH_ACCOUNT_VAULT_KEY,
  AUTH_SESSION_KEY,
} from '../authCredentialKeys';

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
  'clearAuth',
  'finishColdStartSignedOut',
  'recoverActiveResourceSession',
  'readStoredRefreshTokenCandidates',
  'refreshPassportSessionSingleFlight',
  'replacePassportSessionIfCurrent',
  'assertPassportReplacementStored',
  'removePassportSessionIfCurrent',
  'writePassportSessionToVault',
  'isStoredAccountMetadata',
  'metadataFromMembership',
  'commitDesktopRefreshCredentials',
  'initialize',
  'receiveHostAuthState',
  'invalidateSession',
  'refresh',
  'scheduleRefresh',
  'scheduleRefreshRetry',
  'scheduleRefreshRetryAfterTransientFailure',
  'getRefreshErrorCode',
  'runColdStartRefreshFlow',
  'runAuthRefreshWithReplacementRetry',
  'waitForColdStartRetry',
  'stopColdStartRecovery',
  'runLoginAction',
  // The two sign-in entries the window refuses while its Host did not start.
  'hostNotStartedInClientMode',
  'dispatchLoginAction',
  'enterLocalMode',
  // The step of switchSavedAccount that renews a saved account from its vault copy.
  'refreshSavedResourceSession',
  'bindResourcePairToSavedAccount',
  'replaceResourceSessionIfCurrent',
  'removeRejectedResourceSession',
  'mutateAuthAccountVault',
]);
const compiled = ts.transpileModule(
  `
let authStateEpoch = 0, loginFlowEpoch = 0, accessToken = null, currentUser = null;
let activeAuthRealm = 'global', pendingAuthRealm = null, loginFlowState = null;
let pendingAccountToken = null, pendingAccountRefreshToken = null, pendingAccountMemberships = [];
let accountDeletionRestoredNoticePending = false, confirmedAccountDeletionCredential = null;
let coldStartAuthInFlight = null, coldStartRetryWait = null, refreshTimer = null;
let enterpriseGuestSignIn = null;
let coldStartRecoveryStopped = false, coldStartRetryState = null;
let lastAcceptedRefreshToken = null, persistedRefreshTokenNeedsIdentityCheck = false;
let foreignDeviceLocalSignOut = false;
let refreshPromise = null, sessionInvalidationPromise = null;
let authRefreshOverride = null, delegatedAuthState = null;
const refreshBackoff = new AuthRefreshBackoff();
const uncertainResourceRefreshTokens = new Map();
const pendingResourcePassportRecoveries = new Map();
const passportAccountRefreshFlights = new Map();
const pendingPassportAccountRotations = new Map();
let passiveLocalSignOut = false;
const settledLoginCommitCount = 0;
const API_FETCH_TIMEOUT_MS = 15000;
const AUTH_REGION = 'global';
const COLD_START_AUTH_GATE_TIMEOUT_MS = 20000;
const LEGACY_RESOURCE_REFRESH_TOKEN_KEY = 'legacy-resource';
const LEGACY_REFRESH_TOKEN_KEY = 'legacy', LEGACY_ACCOUNT_REFRESH_TOKEN_KEY = 'legacy-account';
const REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT = 2;
const COLD_START_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [100, 250];
const RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [250, 1000];
const credentialStoreHealth = { unavailable: false, noteRecovered() {}, reset() {}, noteStartupFailure() {} };
const coldStartTimeoutFallbacks = new ColdStartAuthFallbackRegistry();
const snapshotAuthState = () => ({ isAuthenticated: !!accessToken, user: currentUser });
const snapshotLoggedOutAuthState = snapshotAuthState;
const readPersistedAuthSession = () => saved.session;
let readStoredRefreshTokenCandidates = () => [saved.session?.refreshToken];
const hasPotentiallyPersistedAuthCredentials = () => !!saved.session;
const assertLoginFlowCurrent = (epoch) => { if (epoch !== loginFlowEpoch) throw new Error('superseded'); };
const recoverAccountFreeOwnerAtStartup = async (mode, reason, unavailable, options = {}) => {
  onStartupFallback();
  // Exercise the real cleanup reached by the production owner transition. Its
  // timeout flag must preserve uncertainty while the minute-long retry waits.
  clearAuth({ notify: false, nextMode: mode, preservePersistedRefreshToken: true,
    coldStartTimeoutRecovery: options.coldStartTimeoutRecovery,
    preserveResourceRefreshUncertainty: options.preserveResourceRefreshUncertainty });
};
const reconcileDesktopActiveAuthSession = async () => saved.session;
${source.statements
  .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
  .map((node) => node.getText(source).replace(/^export /, '')
    .replace('function refreshPassportSessionSingleFlight(', 'function productionRefreshPassportSessionSingleFlight(')
    .replace('function readStoredRefreshTokenCandidates(', 'function productionReadStoredRefreshTokenCandidates('))
  .join('\n')}
return {
  fetch: apiFetch, start: initialize, dispatchLoginAction, enterLocalMode, runtimeRefresh: refresh, reset: () => runLoginAction({ type: 'reset' }),
  manualLogin: () => runLoginAction({ type: 'discover', identifier: 'test@example.invalid' }),
  state: snapshotAuthState,
  useProductionCandidates: () => { readStoredRefreshTokenCandidates = productionReadStoredRefreshTokenCandidates; },
  useProductionPassport: () => { refreshPassportSessionSingleFlight = productionRefreshPassportSessionSingleFlight; },
  vaultRecovery: () => runColdStartRefreshFlow('test-refresh', 'global', {
    expectedActiveVaultAccountKey: accountVaultKey('global', 'original'),
  }),
  strictResourceRecovery: () => recoverActiveResourceSession('global', 'test-refresh'),
  clearRuntimeAuth: () => clearAuth({ preservePersistedRefreshToken: true }),
  renewPassport: (client) => productionRefreshPassportSessionSingleFlight(client, 'global', 'passport-original'),
  hostAuth: (reader) => { authRefreshOverride = reader; },
  receiveHostAuthState,
  invalidateSession,
  activateRuntime: () => { accessToken = 'test-expired'; currentUser = { id: 'original' }; },
  backoff: refreshBackoff,
  fallback: () => { coldStartTimeoutFallbacks.record(authStateEpoch, authStateEpoch + 1); authStateEpoch++; loginFlowEpoch++; },
  changeOwner: () => {
    authStateEpoch++; accessToken = 'test-new-login'; currentUser = { id: 'other' };
    saved.session = { version: 1, realm: 'global', refreshToken: 'other-refresh' };
    vault.activeAccountKey = '["global","other"]';
    vault.resources['["global","other"]'] = { realm: 'global', refreshToken: 'other-refresh' };
  },
  cancelRecovery: () => { loginFlowEpoch++; },
  stop: stopColdStartRecovery,
  renewSavedAccount: (input) => refreshSavedResourceSession({ ...input, expectedLoginFlowEpoch: loginFlowEpoch }),
  logoutForTest: () => { stopColdStartRecovery(); authStateEpoch++; saved.session = null;
    vault.resources = {}; vault.activeAccountKey = null; vault.signedOutAt = Date.now(); },
};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

const ORIGINAL_KEY = accountVaultKey('global', 'original');

function setup(random = 0) {
  const saved: { session: any } = {
    session: { version: 1, realm: 'global', refreshToken: 'test-refresh' },
  };
  const membership = { id: 'original', kind: 'personal', passportId: 'passport-original' };
  const vault: any = {
    activeAccountKey: ORIGINAL_KEY,
    resources: { [ORIGINAL_KEY]: { realm: 'global', refreshToken: 'test-refresh' } },
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
  const authClient = {
    discover: vi.fn(),
    refreshAccount: vi.fn(async () => ({ accountToken: 'test-passport-access', accountRefreshToken: 'test-passport-rotated' })),
    exchangeAccountMembership: vi.fn(async () => ok.data),
  };
  const deps = {
    // Exercise the Linux cold-start path on every test host, with no enrollment on disk.
    process: { platform: 'linux', env: {} },
    deviceId: 'test-device',
    desktopAuthFetch: vi.fn(),
    readCloudGuest: vi.fn<() => Promise<object | null>>(async () => null),
    cloudGuestSaved: vi.fn(async () => false),
    cloudGuestAuthorization: vi.fn<() => Promise<{ code: string; verifier: string }>>(),
    isAtomicPersistedSecretAbsent: () => true,
    writeAtomicSafe: () => true,
    confirmCloudGuestWhenOnline: vi.fn<(base: () => string, token: () => string | null, transport: typeof fetch) => void>(),
    activateClientEndpointRealm: vi.fn(),
    getClientEndpointForRealm: (realm: string) => 'https://model-access.' + realm + '.example.invalid',
    getAccessToken: () => null,
    saved,
    vault,
    onStartupFallback: vi.fn(),
    transactAuthAccountVault: transaction,
    accountVaultKey,
    passportVaultKey,
    loggedOutAccountKeySet,
    reconcileSavedAccountMetadata,
    isLoggedOutVaultAccount: (value: any, key: string) => loggedOutAccountKeySet(value).has(key),
    refreshPassportSessionSingleFlight: vi.fn(async () => ({ accountToken: "test-passport-access" })),
    expireRuntimeAuth: vi.fn(async () => { saved.session = null; vault.activeAccountKey = null; }),
    applyRefreshedCredentialsToVault,
    writeResourceSessionToVault,
    isDefinitiveRefreshError,
    readAuthAccountVault: () => vault,
    readSafe: vi.fn((): string | null => null),
    readPersistedRefreshToken: (realm: string) => saved.session?.realm === realm ? saved.session.refreshToken : null,
    writePersistedAuthSessionOrThrow: (refreshToken: string, realm: string) => {
      saved.session = { version: 1, realm, refreshToken };
    },
    accessTokenRefreshDelayMs,
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
    resetLoginFlowState: vi.fn(),
    canaryFlagStore: { clear: vi.fn() },
    clearPerAccountIntegrationsInBackground: vi.fn(),
    commitActiveAppSession: vi.fn(),
    isOwnerChangeShellPending: () => false,
    ownerChangeShellGate: { isPending: () => false },
    sealedLoginFlowCommitDepths: new Set(),
    runRefreshWithReplacementRetry,
    isDefinitiveRefreshFailure,
    isForeignDeviceRefreshFailure,
    resolveSessionExpiredReason,
    loginPreparingErrorState,
    requestAuthRefresh: request,
    loadClientEndpointsForRealm: vi.fn(async () => {}),
    loadLoginProviders: loadProviders,
    createAuthClient: () => authClient,
    log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    readActiveVaultRefreshCandidate: vi.fn((): { accountKey: string; realm: string; refreshToken: string } | null => null),
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
    commitVolatileAppSession: vi.fn(),
    clearReplacementIntegrationReloadTimers: vi.fn(),
    migrateLocalProviderBindingsAfterCloudCommit: vi.fn(async () => {}),
    scheduleCanaryFlagSync: vi.fn(),
    scheduleXdOrgBetaDefault: vi.fn(),
    notifyAccessTokenRefreshed: vi.fn(),
    mergeMembershipWithExisting: (membership: unknown) => membership,
    getProviderSecretStore: () => ({ reconcileOwner: vi.fn(), invalidateCaches: vi.fn() }),
    HOST_NOT_STARTED,
    readHostUnavailableReason,
    createIpcError,
    parseDesktopLoginAction,
    browserAuthorizationSlot: { cancelActive: vi.fn(() => false) },
    withAccountFreeOwnerCommit: vi.fn(async () => {}),
    notifyRenderer: vi.fn(),
    notifyAuthListeners: vi.fn(),
  };
  const main = new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  return { ...main, saved, vault, request, ok, transaction, clear, loadProviders, deps, authClient };
}

describe('saved login recovery after startup network failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // Standard tier: a pending enrollment used to hold the launch screen until the guest retry deadline.
  it('unlocks the startup screen while one guest enrollment continues and discards a superseded grant', async () => {
    const h = setup();
    h.saved.session = null;
    h.deps.readCloudGuest.mockResolvedValue({ requestId: 'pilot-order' });
    let grant!: (value: { code: string; verifier: string }) => void;
    h.deps.cloudGuestAuthorization.mockImplementation(() => new Promise((resolve) => { grant = resolve; }));
    const onColdStartPending = vi.fn<(completion: Promise<unknown>) => void>();
    const startup = h.start({ onColdStartPending });
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(startup).resolves.toMatchObject({ isAuthenticated: false });
    expect(h.deps.cloudGuestAuthorization).toHaveBeenCalledExactlyOnceWith(
      { requestId: 'pilot-order' }, 'test-device', 'https://auth.example.invalid', expect.any(Object), h.deps.desktopAuthFetch,
    );
    expect(onColdStartPending).toHaveBeenCalledTimes(1);
    h.cancelRecovery();
    grant({ code: 'test-code', verifier: 'test-verifier' });
    await expect(onColdStartPending.mock.calls[0][0]).resolves.toMatchObject({ isAuthenticated: false });
  });

  it('keeps slowly retrying beyond three failures and restores the original account after the startup fallback', async () => {
    const h = setup();
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.deps.confirmCloudGuestWhenOnline).not.toHaveBeenCalled();
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

  // Standard tier: a saved enterprise session in another realm must confirm against that realm after recovery.
  it('confirms registration only after restoring the stored enterprise realm', async () => {
    const h = setup();
    h.saved.session.realm = 'cn';
    const memberKey = accountVaultKey('cn', 'original');
    h.vault.activeAccountKey = memberKey;
    h.vault.resources = { [memberKey]: { realm: 'cn', refreshToken: 'test-refresh' } };
    const startup = h.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await startup;
    expect(h.deps.confirmCloudGuestWhenOnline).not.toHaveBeenCalled();
    h.request.mockResolvedValue({ ...h.ok, data: { ...h.ok.data, membership: { ...h.ok.data.membership, kind: 'org' } } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.deps.activateClientEndpointRealm).toHaveBeenCalledWith('cn');
    expect(h.deps.confirmCloudGuestWhenOnline).toHaveBeenCalledTimes(1);
    const [base, , transport] = h.deps.confirmCloudGuestWhenOnline.mock.calls[0];
    expect(base()).toBe('https://model-access.cn.example.invalid');
    expect(transport).toBe(h.deps.desktopAuthFetch);
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
    expect(h.vault.resources[ORIGINAL_KEY].refreshToken).toBe('test-rotated');
    expect(h.vault.activeAccountKey).toBe(accountVaultKey('global', 'other'));
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
        h.vault.resources[ORIGINAL_KEY].refreshToken = 'newer-refresh';
      }
      resolve(h.ok);
      await pending;
      expect(h.saved.session?.refreshToken).toBe(change === 'logout' ? undefined : 'newer-refresh');
      expect(h.vault.resources[ORIGINAL_KEY]?.refreshToken).toBe(
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
        h.vault.resources[ORIGINAL_KEY].refreshToken = 'test-replacement';
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

// Regression: explicit Host login must establish the process-local data owner,
// without writing a second account record or rotating credentials from Desktop.
describe('delegated Host owner state', () => {
  it('incidental client 401 cannot sign out the Host or write its credentials', async () => {
    const h = setup();
    const reader = vi.fn(async (): Promise<{ isAuthenticated: boolean; user: { id: string } | null }> => ({ isAuthenticated: true, user: { id: 'host-owner' } }));
    h.hostAuth(reader);
    await h.start();
    const original = structuredClone(h.saved);
    await Promise.all([h.invalidateSession('resource-unauthorized-after-refresh'), h.invalidateSession('account-unavailable')]);
    expect(reader).toHaveBeenCalledTimes(2); // startup plus one coalesced authority read
    expect(h.deps.commitVolatileAppSession).toHaveBeenLastCalledWith('cloud', 'host-owner');
    expect(h.saved).toEqual(original);
    expect(h.clear).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    reader.mockRejectedValueOnce(new Error('offline'));
    await expect(h.invalidateSession('resource-unauthorized-after-refresh')).resolves.toBeUndefined();
    expect(h.deps.commitVolatileAppSession).toHaveBeenLastCalledWith('cloud', 'host-owner');
    reader.mockResolvedValueOnce({ isAuthenticated: false, user: null });
    await h.invalidateSession('resource-unauthorized-after-refresh');
    expect(h.deps.commitVolatileAppSession).toHaveBeenLastCalledWith('signed-out');
    expect(h.saved).toEqual(original);
  });
  it('commits the remote owner at startup and clears it on a logout event', async () => {
    const h = setup();
    const state = { isAuthenticated: true, user: { id: 'host-owner' } };
    h.hostAuth(async () => state);
    await expect(h.start()).resolves.toEqual(state);
    expect(h.deps.commitVolatileAppSession).toHaveBeenLastCalledWith('cloud', 'host-owner');
    h.receiveHostAuthState({ isAuthenticated: false, user: null });
    expect(h.deps.commitVolatileAppSession).toHaveBeenLastCalledWith('signed-out');
    expect(h.request).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.deps.commitCloudAppSession).not.toHaveBeenCalled();
  });

  it('runtime refresh commits the same owner projection as startup', async () => {
    const h = setup();
    h.hostAuth(async () => ({ isAuthenticated: true, user: { id: 'host-owner' } }));
    await expect(h.runtimeRefresh()).resolves.toBe(true);
    expect(h.deps.commitVolatileAppSession).toHaveBeenCalledWith('cloud', 'host-owner');
  });

  // 甲 (2026-11-17): the window's own sign-in and Skip Sign-In write a session, the saved accounts and the
  // owner. While the Host it serves reports that it did not start, both are refused with one fixed code and
  // touch nothing; outside client mode, and once the Host state carries no reason, they run as before.
  it('refuses its own sign-in and Skip Sign-In while the Host reports that it did not start', async () => {
    const h = setup();
    h.hostAuth(async () => ({ isAuthenticated: false, user: null }));
    h.receiveHostAuthState({ isAuthenticated: false, user: null, hostUnavailable: { reason: 'HOST_DATABASE_UNAVAILABLE' } });
    const original = structuredClone(h.saved);

    await expect(h.dispatchLoginAction({ type: 'discover', email: 'person@example.invalid' }))
      .resolves.toEqual({ success: false, code: HOST_NOT_STARTED, state: null });
    await expect(h.enterLocalMode()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: `[PRECONDITION_FAILED] ${HOST_NOT_STARTED}` });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.loadProviders).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    expect(h.saved).toEqual(original);
    expect(h.deps.commitCloudAppSession).not.toHaveBeenCalled();
    expect(h.deps.withAccountFreeOwnerCommit).not.toHaveBeenCalled();

    // A Host state with no reason lifts the refusal: the action reaches the ordinary parsing.
    h.receiveHostAuthState({ isAuthenticated: false, user: null });
    await expect(h.dispatchLoginAction({ type: 'not-an-action' }))
      .resolves.toMatchObject({ success: false, code: 'INVALID_AUTH_ACTION' });
  });

  it('signs in and skips sign-in as before outside client mode', async () => {
    const h = setup();
    await expect(h.dispatchLoginAction({ type: 'not-an-action' }))
      .resolves.toMatchObject({ success: false, code: 'INVALID_AUTH_ACTION' });
    await h.enterLocalMode();
    expect(h.deps.withAccountFreeOwnerCommit).toHaveBeenCalledOnce();
  });

  it('rejects an event without explicit Host mode', () => {
    const h = setup();
    expect(() => h.receiveHostAuthState({ isAuthenticated: true, user: { id: 'foreign' } }))
      .toThrow('explicit client mode');
    expect(h.deps.commitVolatileAppSession).not.toHaveBeenCalled();
  });
});

/*
 * C (reviewer, 2026-11-17): a login the Host renewed, then used by this desktop on the same data.
 * The Host renews with its production refreshHostSession (apps/host/src/auth/refresh.mjs) on the
 * records this harness keeps: the v1 session (`saved.session`) and the account vault (`vault`).
 * Reproduced on 2026-11-17 before the fix: the Host wrote only the v1 record, so the vault copy of
 * the account stayed at the token the server had already rotated out. Scenario 1: switching back to
 * that account loads it from the vault copy, which the server rejects, so the saved account is
 * removed and the switch asks for a new sign-in. Scenario 2: the desktop's cold start reads v1 and
 * recovered even then. Production entry for scenario 1: switchSavedAccount (authManager.ts) renews
 * the account with refreshSavedResourceSession, run here as switchSavedAccount calls it;
 * switchSavedAccount itself is not compiled into this harness (its completeLogin runs the owner
 * commit, teardown and renderer), so this is the closest production entry. Unit; a fake auth server,
 * no real account or store.
 */
describe('a login the Host renewed, then used by the desktop', () => {
  // A non-literal specifier keeps the Host sources out of the desktop typecheck.
  const hostRefreshModule = '../../../../host/src/auth/refresh.mjs';
  type RefreshHostSession = (deps: Record<string, unknown>) => Promise<unknown>;
  let refreshHostSession: RefreshHostSession;
  beforeEach(async () => {
    ({ refreshHostSession } = (await import(/* @vite-ignore */ hostRefreshModule)) as { refreshHostSession: RefreshHostSession });
    vi.useFakeTimers();
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  const membership = { id: 'original', kind: 'personal', role: 'owner', displayName: 'Fixture', email: null,
    orgId: null, orgName: null, passportId: 'passport-original' };

  /** One account server: only the latest refresh token works; each refresh rotates it. */
  function fakeServer() {
    let current = 'test-refresh';
    let next = 0;
    const rotate = (token: string) => {
      if (token !== current) return null;
      current = `rotated-${++next}`;
      return { accessToken: `access-${next}`, refreshToken: current, membership };
    };
    return {
      current: () => current,
      desktop: async (token: string) => {
        const pair = rotate(token);
        return pair ? { ok: true, status: 200, data: pair }
          : { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN', message: 'rotated' } } };
      },
      client: {
        refresh: async (token: string) => {
          const pair = rotate(token);
          if (!pair) throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'rotated');
          return pair;
        },
      },
    };
  }

  /** The Host's production renewal over the records the harness keeps. */
  async function hostRenews(h: ReturnType<typeof setup>, server: ReturnType<typeof fakeServer>, times: number) {
    const store = {
      read: (key: string) => {
        if (key === AUTH_SESSION_KEY) return h.saved.session ? serializeAuthSessionRecord(h.saved.session.realm, h.saved.session.refreshToken) : null;
        if (key === AUTH_ACCOUNT_VAULT_KEY) return JSON.stringify({ version: 1, passports: {}, ...h.vault });
        return null;
      },
      write: (key: string, raw: string) => {
        if (key === AUTH_SESSION_KEY) {
          const record = parseAuthSessionRecord(raw)!;
          h.saved.session = { version: 1, realm: record.realm, refreshToken: record.refreshToken };
        } else if (key === AUTH_ACCOUNT_VAULT_KEY) {
          const next = JSON.parse(raw);
          h.vault.activeAccountKey = next.activeAccountKey;
          h.vault.resources = next.resources;
        } else throw new Error(`unexpected Host write ${key}`);
      },
    };
    for (let i = 0; i < times; i++) {
      await refreshHostSession({ store, refresh: server.client.refresh, withVaultLock: (task: () => unknown) => task(),
        buildRegion: 'global', sleep: async () => {} });
    }
  }

  it('scenario 1: switching back to the account from its vault copy still works after Host renewals', async () => {
    const server = fakeServer();
    const h = setup();
    await hostRenews(h, server, 3);
    expect(h.vault.resources[ORIGINAL_KEY].refreshToken).toBe('rotated-3');
    const pair = await h.renewSavedAccount({
      client: server.client, accountKey: ORIGINAL_KEY, realm: 'global',
      metadata: { membershipId: 'original', passportId: 'passport-original' },
      initialRefreshToken: h.vault.resources[ORIGINAL_KEY].refreshToken,
    });
    expect(pair).toMatchObject({ refreshToken: 'rotated-4', membership: { id: 'original' } });
    expect(h.vault.resources[ORIGINAL_KEY].refreshToken).toBe('rotated-4');
    expect(server.current()).toBe('rotated-4');
  });

  it('scenario 2: the desktop cold start after Host renewals finds v1 and the vault current', async () => {
    const server = fakeServer();
    const h = setup();
    h.request.mockImplementation((token: unknown) => server.desktop(String(token)));
    await hostRenews(h, server, 3);
    expect([h.saved.session.refreshToken, h.vault.resources[ORIGINAL_KEY].refreshToken]).toEqual(['rotated-3', 'rotated-3']);
    await expect(h.start()).resolves.toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.request).toHaveBeenCalledTimes(1);
    expect([h.saved.session.refreshToken, h.vault.resources[ORIGINAL_KEY].refreshToken]).toEqual(['rotated-4', 'rotated-4']);
  });

  // An account signed in only on the Host (`cindy-host login` writes only v1): the vault has no
  // account. The cold start's commit may claim an uninitialized vault (canClaimUninitializedVault).
  it('an account signed in only on the Host is taken over by the desktop cold start, which claims the empty vault', async () => {
    const server = fakeServer();
    const h = setup();
    h.vault.activeAccountKey = null;
    h.vault.resources = {};
    h.request.mockImplementation((token: unknown) => server.desktop(String(token)));
    await hostRenews(h, server, 2);
    expect(h.saved.session.refreshToken).toBe('rotated-2');
    expect(h.vault.resources).toEqual({});
    await expect(h.start()).resolves.toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.vault.activeAccountKey).toBe(ORIGINAL_KEY);
    expect([h.saved.session.refreshToken, h.vault.resources[ORIGINAL_KEY].refreshToken]).toEqual(['rotated-3', 'rotated-3']);
  });
});

/*
 * C (reviewer, 2026-11-17): the saved-account vault after a Host renewal. The vault holds every
 * saved account's credentials and the Host writes it with its own read and write (auth/refresh.mjs),
 * so this is the riskiest write of the line. The vault and the logout tombstones are made and read
 * back by the desktop's production functions (writePassportSessionToVault, writeAuthAccountVault,
 * readAuthAccountVault, listSavedAccounts, compiled from authManager.ts); only the encrypted record
 * store under them is an in-memory map, shared with the Host's store as the profile's
 * safe-storage files are. Rule: apart from the renewed account's refreshToken, metadata and
 * lastUsedAt, the vault stays byte for byte, and the tombstones are untouched. Gap: the Host tests
 * use hand-written vaults. Minimal failure: writing back the normalized view drops a field the Host
 * does not know. Unit; no real account or store.
 */
describe('the saved-account vault after a Host renewal', () => {
  const hostRefreshModule = '../../../../host/src/auth/refresh.mjs';
  const vaultNames = new Set([
    'readAuthAccountVault', 'readAuthAccountLogoutTombstones', 'writeAuthAccountVault',
    'writeAuthAccountLogoutTombstones', 'emptyAuthAccountVault', 'writePassportSessionToVault',
    'isStoredAccountMetadata', 'savedAccountSummaries', 'accountSummaryFromMetadata', 'listSavedAccounts',
    'metadataFromMembership', 'accountVaultKey', 'passportVaultKey',
  ]);
  const vaultParts = source.statements
    .filter((node) => (ts.isFunctionDeclaration(node) && vaultNames.has(node.name?.text ?? ''))
      || (ts.isVariableStatement(node) && node.declarationList.declarations
        .some((d) => d.name.getText(source) === 'AUTH_ACCOUNT_LOGOUT_TOMBSTONES_VERSION')))
    .map((node) => node.getText(source).replace(/^export /, '')
    .replace('function refreshPassportSessionSingleFlight(', 'function productionRefreshPassportSessionSingleFlight(')
    .replace('function readStoredRefreshTokenCandidates(', 'function productionReadStoredRefreshTokenCandidates('));
  const vaultCompiled = ts.transpileModule(`
let currentUser = { id: 'member-a' };
const activeAuthRealm = 'global';
const isPassiveSharedUserDataInstance = () => false;
${vaultParts.join('\n')}
return { readAuthAccountVault, writeAuthAccountVault, emptyAuthAccountVault, writePassportSessionToVault, listSavedAccounts };
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

  const records = new Map<string, string>();
  const desktop = new Function(
    'readAtomicSafe', 'isAtomicPersistedSecretAbsent', 'writeAtomicSafe', 'removeAtomicSafeOrThrow',
    'readAtomicSafeCiphertext', 'writeAtomicSafeCiphertext', 'logUnreadableEncryptedRecord', 'log', 'AuthApiError',
    'AUTH_ACCOUNT_VAULT_KEY', 'AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY', 'AUTH_ACCOUNT_VAULT_VERSION',
    'parseDesktopAccountKey', 'reconcileSavedAccountMetadata', 'loggedOutAccountKeySet', 'writeResourceSessionToVault',
    vaultCompiled,
  )(
    (key: string) => records.get(key) ?? null, (key: string) => !records.has(key),
    (key: string, value: string) => { records.set(key, value); return true; }, (key: string) => { records.delete(key); },
    () => null, () => false, () => undefined, { warn: () => undefined }, AuthApiError,
    AUTH_ACCOUNT_VAULT_KEY, AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY, AUTH_ACCOUNT_VAULT_VERSION,
    parseDesktopAccountKey, reconcileSavedAccountMetadata, loggedOutAccountKeySet, writeResourceSessionToVault,
  );

  const member = (id: string, displayName: string) => ({ id, passportId: 'passport-1', kind: 'personal' as const, role: 'owner' as const,
    displayName, email: `${id}@example.invalid`, avatarUrl: null, orgId: null, orgName: null, orgLogoUrl: null });
  const keyOf = (id: string) => accountVaultKey('global', id);

  it('keeps every other account, the passport, unknown fields and the tombstones byte for byte', async () => {
    const { refreshHostSession } = (await import(/* @vite-ignore */ hostRefreshModule)) as {
      refreshHostSession: (deps: Record<string, unknown>) => Promise<unknown> };
    records.clear();
    // Three accounts on one passport: A current, B saved, C logged out on this device.
    const vault = desktop.emptyAuthAccountVault();
    vault.loggedOutAccountKeys = [keyOf('member-c')];
    writeResourceSessionToVault(vault, { accessToken: 'a', refreshToken: 'a-token', membership: member('member-a', 'A') },
      'global', 'passport-1', { lastUsedAt: 200 });
    writeResourceSessionToVault(vault, { accessToken: 'b', refreshToken: 'b-token', membership: member('member-b', 'B') },
      'global', 'passport-1', { markActive: false, lastUsedAt: 100 });
    desktop.writePassportSessionToVault(vault, { realm: 'global', passportId: 'passport-1', accountRefreshToken: 'passport-token',
      memberships: [member('member-a', 'A'), member('member-b', 'B'), member('member-c', 'C')] });
    expect(desktop.writeAuthAccountVault(vault)).toBe(true);
    // Fields a later desktop may add: one at the top level, one in a saved account.
    const written = JSON.parse(records.get(AUTH_ACCOUNT_VAULT_KEY)!);
    written.laterTopLevelField = { kept: true };
    written.resources[keyOf('member-b')].laterResourceField = 'kept';
    records.set(AUTH_ACCOUNT_VAULT_KEY, JSON.stringify(written));
    records.set(AUTH_SESSION_KEY, serializeAuthSessionRecord('global', 'a-token'));
    const vaultBefore = records.get(AUTH_ACCOUNT_VAULT_KEY)!;
    const tombstonesBefore = records.get(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY);
    expect(JSON.parse(tombstonesBefore!).accountKeys).toEqual([keyOf('member-c')]);
    const accountsBefore = desktop.listSavedAccounts().accounts;
    expect(accountsBefore.map((account: { accountKey: string }) => account.accountKey)).toEqual([keyOf('member-a'), keyOf('member-b')]);

    await refreshHostSession({
      store: { read: (key: string) => records.get(key) ?? null, write: (key: string, value: string) => records.set(key, value) },
      refresh: async (token: string) => {
        expect(token).toBe('a-token');
        return { accessToken: 'access', refreshToken: 'a-rotated', membership: { ...member('member-a', 'A renamed') } };
      },
      withVaultLock: (task: () => unknown) => task(), buildRegion: 'global',
    });

    const after = JSON.parse(records.get(AUTH_ACCOUNT_VAULT_KEY)!);
    const renewed = after.resources[keyOf('member-a')];
    expect(renewed.refreshToken).toBe('a-rotated');
    expect(renewed.metadata.displayName).toBe('A renamed');
    // Everything else, byte for byte: the vault before with only those three fields replaced.
    const expected = JSON.parse(vaultBefore);
    Object.assign(expected.resources[keyOf('member-a')],
      { refreshToken: renewed.refreshToken, metadata: renewed.metadata, lastUsedAt: renewed.lastUsedAt });
    expect(records.get(AUTH_ACCOUNT_VAULT_KEY)).toBe(JSON.stringify(expected));
    expect(after.laterTopLevelField).toEqual({ kept: true });
    expect(after.resources[keyOf('member-b')]).toMatchObject({ refreshToken: 'b-token', laterResourceField: 'kept' });
    expect(Object.values(after.passports)).toMatchObject([{ accountRefreshToken: 'passport-token' }]);
    expect(records.get(AUTH_ACCOUNT_LOGOUT_TOMBSTONES_KEY)).toBe(tombstonesBefore);

    // Read back by the desktop: the same accounts, the current one with the new token.
    const readBack = desktop.readAuthAccountVault();
    expect(readBack.activeAccountKey).toBe(keyOf('member-a'));
    expect(readBack.resources[keyOf('member-a')].refreshToken).toBe('a-rotated');
    expect(readBack.loggedOutAccountKeys).toEqual([keyOf('member-c')]);
    expect(desktop.listSavedAccounts().accounts.map((account: { accountKey: string; isCurrent: boolean }) =>
      [account.accountKey, account.isCurrent])).toEqual(accountsBefore.map((account: { accountKey: string; isCurrent: boolean }) =>
      [account.accountKey, account.isCurrent]));
  });
});

// #8694, unit: real refresh orchestration + commit with memory ports. Existing
// startup/backoff tests never exercised INVALID after a lost rotation response.
// Minimal failure: status=0, then INVALID with the same active Resource/Passport.
// Reuse the file-level production-function harness; no extra eval or real waits.
describe('active Passport recovery after an uncertain Resource rotation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function recoverySetup() {
    const h = setup();
    h.activateRuntime();
    h.vault.resources[ORIGINAL_KEY].metadata = {
      membershipId: 'original',
      passportId: 'passport-original',
      kind: 'personal',
    };
    h.vault.passports = {
      [passportVaultKey('global', 'passport-original')]: { passportId: 'passport-original' },
    };
    const exchange = h.authClient.exchangeAccountMembership;
    return { h, exchange };
  }

  async function rejectAfterLoss(h: ReturnType<typeof setup>) {
    await h.runtimeRefresh();
    h.request.mockResolvedValue({
      ok: false,
      status: 401,
      data: { error: { code: 'INVALID_REFRESH_TOKEN' } },
    });
    await vi.advanceTimersByTimeAsync(61_250);
  }

  it.each([['runtime', 'legacy'], ['cold-start', 'legacy'], ['cold-start', 'projection']] as const)('keeps active uncertainty when a candidate also loses its response (%s/%s)', async (phase, target) => {
    const { h } = recoverySetup();
    const fresh = phase === 'runtime' ? h : setup();
    fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
    fresh.vault.passports = h.vault.passports;
    fresh.useProductionCandidates();
    const seen = new Set<unknown>();
    fresh.request.mockImplementation(async (token: unknown) => {
      if (!seen.has(token)) {
        seen.add(token);
        if (target === 'projection') fresh.saved.session.refreshToken = 'test-other-candidate';
        else fresh.deps.readSafe.mockReturnValue('test-other-candidate');
        return { ok: false, status: 0, data: null };
      }
      return { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } };
    });
    if (phase === 'runtime') await fresh.runtimeRefresh();
    else void fresh.start();
    // Include the second runtime backoff after C's own transport failure.
    await vi.advanceTimersByTimeAsync(185_000);
    expect(fresh.request.mock.calls.map(([token]: unknown[]) => token)).toEqual(target === 'projection'
      ? ['test-refresh', 'test-other-candidate', 'test-other-candidate', 'test-refresh']
      : ['test-refresh', 'test-refresh', 'test-other-candidate', 'test-refresh', 'test-other-candidate']);
    expect(fresh.authClient.exchangeAccountMembership).toHaveBeenCalledWith('test-passport-access', 'original');
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
    expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
  });

  it.each([
    ['runtime', 'MEMBERSHIP_DISABLED', 'legacy'], ['cold-start', 'MEMBERSHIP_DISABLED', 'legacy'],
    ['runtime', 'REFRESH_TOKEN_EXPIRED', 'legacy'], ['cold-start', 'REFRESH_TOKEN_EXPIRED', 'legacy'],
    ['cold-start', 'MEMBERSHIP_DISABLED', 'projection'], ['cold-start', 'REFRESH_TOKEN_EXPIRED', 'projection'],
  ] as const)('recovers an INVALID active owner after a candidate returns %s/%s/%s', async (phase, code, target) => {
    const { h } = recoverySetup();
    const fresh = phase === 'runtime' ? h : setup();
    fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
    fresh.vault.passports = h.vault.passports;
    fresh.useProductionCandidates();
    let first = true;
    fresh.request.mockImplementation(async (token: unknown) => {
      if (first) { first = false; return { ok: false, status: 0, data: null }; }
      if (target === 'projection') fresh.saved.session.refreshToken = 'test-other-candidate';
      else fresh.deps.readSafe.mockReturnValue('test-other-candidate');
      return { ok: false, status: 401, data: { error: { code: token === 'test-refresh' ? 'INVALID_REFRESH_TOKEN' : code } } };
    });
    if (phase === 'runtime') await fresh.runtimeRefresh();
    else void fresh.start();
    await vi.advanceTimersByTimeAsync(62_500);
    expect(fresh.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-refresh', 'test-refresh', 'test-other-candidate',
    ]);
    expect(fresh.authClient.exchangeAccountMembership).toHaveBeenCalledWith('test-passport-access', 'original');
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
    expect(fresh.deps.expireRuntimeAuth).not.toHaveBeenCalled();
    expect(fresh.clear).not.toHaveBeenCalled();
  });

  it.each([
    ['MEMBERSHIP_DISABLED', false], ['REFRESH_TOKEN_EXPIRED', false], ['INVALID_REFRESH_TOKEN', false],
    ['MEMBERSHIP_DISABLED', true], ['REFRESH_TOKEN_EXPIRED', true],
  ] as const)('keeps the active rejection across a candidate outage (%s, active responds again=%s)', async (code, activeRespondsAgain) => {
    const { h } = recoverySetup();
    const fresh = setup();
    fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
    fresh.vault.passports = h.vault.passports;
    fresh.useProductionCandidates();
    fresh.deps.readActiveVaultRefreshCandidate.mockReturnValue({
      accountKey: ORIGINAL_KEY, realm: 'global', refreshToken: 'test-refresh',
    });
    let activeCalls = 0, candidateCalls = 0;
    fresh.request.mockImplementation(async (token: unknown) => {
      if (token === 'test-refresh') {
        activeCalls++;
        if (activeCalls === 1) return { ok: false, status: 0, data: null };
        if (activeCalls === 2) {
          fresh.saved.session.refreshToken = 'test-other-candidate';
          return { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } };
        }
        return { ok: false, status: 401, data: { error: { code } } };
      }
      candidateCalls++;
      if (candidateCalls === 1) {
        if (activeRespondsAgain) fresh.saved.session.refreshToken = 'test-refresh';
        return { ok: false, status: 0, data: null };
      }
      return { ok: false, status: 401, data: { error: { code } } };
    });
    void fresh.start();
    await vi.advanceTimersByTimeAsync(185_000);
    expect(fresh.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-refresh', 'test-refresh', 'test-other-candidate',
      activeRespondsAgain ? 'test-refresh' : 'test-other-candidate',
    ]);
    if (activeRespondsAgain) {
      expect(fresh.deps.refreshPassportSessionSingleFlight).not.toHaveBeenCalled();
      expect(fresh.clear).toHaveBeenCalled();
    } else {
      expect(fresh.authClient.exchangeAccountMembership).toHaveBeenCalledWith('test-passport-access', 'original');
      expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
      expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
      expect(fresh.clear).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['MEMBERSHIP_DISABLED', false], ['REFRESH_TOKEN_EXPIRED', false],
    ['MEMBERSHIP_DISABLED', true], ['REFRESH_TOKEN_EXPIRED', true],
  ] as const)('retains runtime rejection across candidate outage (%s, active responds again=%s)', async (code, activeRespondsAgain) => {
    const { h } = recoverySetup();
    h.useProductionCandidates();
    let activeCalls = 0, candidateCalls = 0;
    h.request.mockImplementation(async (token: unknown) => {
      if (token === 'test-refresh') {
        activeCalls++;
        if (activeCalls === 1) return { ok: false, status: 0, data: null };
        if (activeCalls === 2) {
          h.saved.session.refreshToken = 'test-other-candidate';
          return { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } };
        }
        return { ok: false, status: 401, data: { error: { code } } };
      }
      candidateCalls++;
      if (candidateCalls === 1) {
        if (activeRespondsAgain) h.saved.session.refreshToken = 'test-refresh';
        return { ok: false, status: 0, data: null };
      }
      return { ok: false, status: 401, data: { error: { code } } };
    });
    await h.runtimeRefresh();
    await vi.advanceTimersByTimeAsync(185_000);
    expect(h.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-refresh', 'test-refresh', 'test-other-candidate',
      activeRespondsAgain ? 'test-refresh' : 'test-other-candidate',
    ]);
    if (activeRespondsAgain) {
      expect(h.deps.expireRuntimeAuth).toHaveBeenCalled();
      expect(h.authClient.exchangeAccountMembership).not.toHaveBeenCalled();
    } else {
      expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
      expect(h.vault.activeAccountKey).toBe(ORIGINAL_KEY);
      expect(h.vault.resources[ORIGINAL_KEY].refreshToken).toBe('test-refresh');
      // A different projection still cannot authorize runtime Passport recovery.
      expect(h.authClient.exchangeAccountMembership).not.toHaveBeenCalled();
      h.saved.session.refreshToken = 'test-refresh';
      await vi.advanceTimersByTimeAsync(500_000);
      expect(h.authClient.exchangeAccountMembership).toHaveBeenCalledWith('test-passport-access', 'original');
      expect(h.saved.session?.refreshToken).toBe('test-rotated');
      expect(h.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    }
  });

  it.each(['MEMBERSHIP_DISABLED', 'REFRESH_TOKEN_EXPIRED'] as const)('revokes old runtime rejection when projection changes during a newer %s', async code => {
    const { h } = recoverySetup();
    h.useProductionCandidates();
    let activeCalls = 0, candidateCalls = 0;
    h.request.mockImplementation(async (token: unknown) => {
      if (token === 'test-refresh') {
        activeCalls++;
        if (activeCalls === 1) return { ok: false, status: 0, data: null };
        h.saved.session.refreshToken = 'test-other-candidate';
        return { ok: false, status: 401, data: { error: {
          code: activeCalls === 2 ? 'INVALID_REFRESH_TOKEN' : code,
        } } };
      }
      candidateCalls++;
      if (candidateCalls === 1) {
        h.saved.session.refreshToken = 'test-refresh';
        return { ok: false, status: 0, data: null };
      }
      return { ok: false, status: 401, data: { error: { code: 'REFRESH_TOKEN_EXPIRED' } } };
    });
    await h.runtimeRefresh();
    await vi.advanceTimersByTimeAsync(185_000);
    expect(h.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-refresh', 'test-refresh', 'test-other-candidate', 'test-refresh',
    ]);
    expect(h.saved.session?.refreshToken).toBe('test-other-candidate');
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250_000);
    expect(h.request).toHaveBeenLastCalledWith('test-other-candidate', 'global');
    expect(h.authClient.exchangeAccountMembership).not.toHaveBeenCalled();
    h.saved.session = { version: 1, realm: 'global', refreshToken: 'test-refresh' };
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.authClient.exchangeAccountMembership).not.toHaveBeenCalled();
    expect(h.deps.expireRuntimeAuth).toHaveBeenCalled();
  });

  it.each(['MEMBERSHIP_DISABLED', 'REFRESH_TOKEN_EXPIRED'] as const)('does not reinterpret the active owner\'s own %s as INVALID', async code => {
    const { h } = recoverySetup();
    await h.runtimeRefresh();
    h.request.mockResolvedValue({ ok: false, status: 401, data: { error: { code } } });
    await vi.advanceTimersByTimeAsync(62_500);
    expect(h.deps.refreshPassportSessionSingleFlight).not.toHaveBeenCalled();
    expect(h.deps.expireRuntimeAuth).toHaveBeenCalled();
  });

  it('restores and persists the original account instead of expiring a recoverable login', async () => {
    const { h, exchange } = recoverySetup();
    await rejectAfterLoss(h);
    expect(exchange).toHaveBeenCalledWith('test-passport-access', 'original');
    expect(h.saved.session?.refreshToken).toBe('test-rotated');
    expect(h.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
  });

  it.each([false, true])('keeps the account when the add-account lifecycle cancels recovery (rejected=%s)', async rejected => {
    const { h, exchange } = recoverySetup();
    h.deps.refreshPassportSessionSingleFlight.mockImplementationOnce(async () => {
      h.cancelRecovery();
      if (rejected) throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'rejected');
      return { accountToken: 'test-passport-access' };
    });
    await rejectAfterLoss(h);
    expect(exchange).not.toHaveBeenCalled();
    expect(h.saved.session?.refreshToken).toBe('test-refresh');
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
    expect(h.backoff.remaining(0)).toBeGreaterThan(0);
  });

  it('honors the Passport recovery server cooldown without expiring or re-requesting', async () => {
    const { h, exchange } = recoverySetup();
    h.deps.refreshPassportSessionSingleFlight.mockRejectedValueOnce(
      new AuthApiError('AUTH_REQUEST_FAILED', 503, 'busy', Date.now() + 600_000),
    );
    await rejectAfterLoss(h);
    expect(exchange).not.toHaveBeenCalled();
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
    const count = h.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500_000);
    expect(h.request).toHaveBeenCalledTimes(count);
    expect(h.saved.session?.refreshToken).toBe('test-refresh');
  });

  it.each(['runtime', 'cold-start'] as const)('resumes pending Passport recovery without replaying a dead Resource (%s)', async phase => {
    const { h } = recoverySetup();
    const fresh = phase === 'runtime' ? h : setup();
    if (phase === 'cold-start') {
      fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
      fresh.vault.passports = h.vault.passports;
    }
    fresh.deps.refreshPassportSessionSingleFlight.mockRejectedValueOnce(
      new AuthApiError('AUTH_REQUEST_FAILED', 503, 'busy', Date.now() + 180_000),
    );
    if (phase === 'runtime') await rejectAfterLoss(fresh);
    else {
      void fresh.start();
      await vi.advanceTimersByTimeAsync(1);
      fresh.request.mockResolvedValue({ ok: false, status: 401,
        data: { error: { code: 'INVALID_REFRESH_TOKEN' } } });
      await vi.advanceTimersByTimeAsync(61_250);
    }
    expect(fresh.deps.refreshPassportSessionSingleFlight).toHaveBeenCalledTimes(1);
    const resourceRequests = fresh.request.mock.calls.length;
    // A redundant refresh would now hit a transport outage and postpone Passport.
    fresh.request.mockResolvedValue({ ok: false, status: 0, data: null });
    await vi.advanceTimersByTimeAsync(122_500);
    expect(fresh.deps.refreshPassportSessionSingleFlight).toHaveBeenCalledTimes(2);
    expect(fresh.request).toHaveBeenCalledTimes(resourceRequests);
    expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
  });

  it.each(['inactive', 'discarded'] as const)('preserves pending active recovery after a compatibility rotation commits %s', async commit => {
    const { h } = recoverySetup();
    const fresh = setup();
    fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
    fresh.vault.passports = h.vault.passports;
    const otherKey = accountVaultKey('global', 'other');
    fresh.vault.resources[otherKey] = { realm: 'global', refreshToken: 'test-other', metadata: {
      membershipId: 'other', passportId: 'passport-other', kind: 'personal',
    } };
    fresh.useProductionCandidates();
    fresh.deps.readActiveVaultRefreshCandidate.mockImplementation(() => ({
      accountKey: ORIGINAL_KEY, realm: 'global', refreshToken: fresh.vault.resources[ORIGINAL_KEY].refreshToken,
    }));
    fresh.deps.refreshPassportSessionSingleFlight.mockRejectedValueOnce(
      new AuthApiError('AUTH_REQUEST_FAILED', 503, 'busy', Date.now() + 180_000),
    );
    void fresh.start();
    await vi.advanceTimersByTimeAsync(1);
    fresh.request.mockResolvedValue({ ok: false, status: 401,
      data: { error: { code: 'INVALID_REFRESH_TOKEN' } } });
    await vi.advanceTimersByTimeAsync(61_250);
    expect(fresh.deps.refreshPassportSessionSingleFlight).toHaveBeenCalledTimes(1);
    const previousRequests = fresh.request.mock.calls.length;
    fresh.saved.session.refreshToken = 'test-other';
    fresh.request.mockImplementation(async (token: unknown) => {
      if (token === 'test-other') {
        // Exercise real CAS discard, not a mocked commit outcome.
        if (commit === 'discarded') fresh.vault.resources[otherKey].refreshToken = 'test-other-concurrent';
        return { ...fresh.ok, data: { ...fresh.ok.data, refreshToken: 'test-other-rotated',
          membership: { id: 'other', kind: 'personal', passportId: 'passport-other' } } };
      }
      return { ok: false, status: 0, data: null };
    });
    await vi.advanceTimersByTimeAsync(122_500);
    expect(fresh.vault.resources[otherKey].refreshToken).toBe(
      commit === 'inactive' ? 'test-other-rotated' : 'test-other-concurrent',
    );
    expect(fresh.deps.refreshPassportSessionSingleFlight).toHaveBeenCalledTimes(2);
    expect(fresh.request.mock.calls.slice(previousRequests).map(([token]: unknown[]) => token)).toEqual(['test-other']);
    expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
    expect(fresh.clear).not.toHaveBeenCalled();
  });

  it.each(['newer', 'cleared'] as const)('checks the current Resource before resuming Passport (%s)', async state => {
    const { h } = recoverySetup();
    h.deps.refreshPassportSessionSingleFlight.mockRejectedValueOnce(
      new AuthApiError('AUTH_REQUEST_FAILED', 429, 'busy', Date.now() + 180_000),
    );
    await rejectAfterLoss(h);
    const count = h.request.mock.calls.length;
    if (state === 'newer') {
      h.saved.session.refreshToken = 'test-newer-resource';
      h.request.mockResolvedValue(h.ok);
    } else {
      h.clearRuntimeAuth();
      h.request.mockResolvedValue({ ok: false, status: 0, data: null });
    }
    await vi.advanceTimersByTimeAsync(122_500);
    expect(h.deps.refreshPassportSessionSingleFlight).toHaveBeenCalledTimes(1);
    if (state === 'newer') {
      expect(h.request).toHaveBeenCalledTimes(count + 1);
      expect(h.request).toHaveBeenLastCalledWith('test-newer-resource', 'global');
      expect(h.state().isAuthenticated).toBe(true);
    } else {
      expect(h.request).toHaveBeenCalledTimes(count);
      expect(h.state().isAuthenticated).toBe(false);
    }
  });

  it.each([['passport', 503], ['exchange', 429]] as const)(
    'keeps the server cooldown when cancellation supersedes %s with status %s',
    async (stage, status) => {
      const { h, exchange } = recoverySetup();
      const rejectDuringCancellation = async () => {
        h.cancelRecovery();
        throw new AuthApiError('AUTH_REQUEST_FAILED', status, 'busy', Date.now() + 600_000);
      };
      if (stage === 'passport') {
        h.deps.refreshPassportSessionSingleFlight.mockImplementationOnce(rejectDuringCancellation);
      } else {
        exchange.mockImplementationOnce(rejectDuringCancellation);
      }
      await rejectAfterLoss(h);
      expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
      const count = h.request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500_000);
      expect(h.request).toHaveBeenCalledTimes(count);
      expect(h.saved.session?.refreshToken).toBe('test-refresh');
    },
  );

  it.each([['passport', 403], ['passport', 401], ['exchange', 403]] as const)(
    'reports the disabled member but keeps its sibling Passport when %s rejects recovery (%s)',
    async (stage, status) => {
      const { h, exchange } = recoverySetup();
      const passportKey = passportVaultKey('global', 'passport-original');
      h.vault.passports[passportKey].accountRefreshToken = 'test-passport-old';
      h.vault.passports[passportKey].memberships = ['original', 'sibling'].map(id => ({
        id, kind: 'personal', displayName: id, email: null, avatarUrl: null,
        role: 'member', orgId: null, orgName: null, orgLogoUrl: null,
      }));
      h.useProductionPassport();
      const error = new AuthApiError('MEMBERSHIP_DISABLED', status, 'disabled');
      if (stage === 'passport') {
        h.authClient.refreshAccount.mockRejectedValueOnce(error);
      } else {
        exchange.mockRejectedValueOnce(error);
      }
      await rejectAfterLoss(h);
      expect(h.deps.expireRuntimeAuth).toHaveBeenCalledWith('original', 'account-unavailable');
      expect(h.saved.session).toBeNull();
      expect(h.vault.passports[passportKey]?.accountRefreshToken).toBe(
        stage === 'passport' ? 'test-passport-old' : 'test-passport-rotated',
      );
      expect(h.vault.passports[passportKey]?.memberships).toHaveLength(2);
    },
  );

  it.each(['INVALID_REFRESH_TOKEN', 'REFRESH_TOKEN_EXPIRED', 'ACCOUNT_UNAVAILABLE', 'DEVICE_MISMATCH'])(
    'only removes a rejected Passport when its own credential is unusable (%s)',
    async code => {
      const { h } = recoverySetup();
      const passportKey = passportVaultKey('global', 'passport-original');
      h.vault.passports[passportKey].accountRefreshToken = 'test-passport-old';
      const client = { refreshAccount: vi.fn(async () => {
        throw new AuthApiError(code, 401, 'rejected');
      }) };
      await expect(h.renewPassport(client)).rejects.toMatchObject({ code });
      if (code === 'DEVICE_MISMATCH') {
        expect(h.vault.passports[passportKey]?.accountRefreshToken).toBe('test-passport-old');
      } else {
        expect(h.vault.passports[passportKey]).toBeUndefined();
      }
    },
  );

  // The real Passport single-flight and CAS run here too; only disk I/O is an
  // in-memory transaction port. No server replay grace exists for this token.
  it('persists a pending Passport rotation before refreshing it again, without reusing its stale access token', async () => {
    const { h } = recoverySetup();
    const passportKey = passportVaultKey('global', 'passport-original');
    h.vault.passports[passportKey].accountRefreshToken = 'test-passport-old';
    h.vault.passports[passportKey].memberships = ['original', 'sibling'].map(id => ({
      id, kind: 'personal', displayName: id, email: null, avatarUrl: null,
      role: 'member', orgId: null, orgName: null, orgLogoUrl: null,
    }));
    const client = { refreshAccount: vi.fn(async (token: string) => {
      if (token === 'test-passport-old' && client.refreshAccount.mock.calls.length > 1) {
        throw new AuthApiError('INVALID_REFRESH_TOKEN', 401, 'consumed');
      }
      return { accountToken: token === 'test-passport-old' ? 'test-stale-access' : 'test-fresh-access',
        accountRefreshToken: token === 'test-passport-old' ? 'test-passport-pending' : 'test-passport-latest' };
    }) };
    h.transaction.mockRejectedValueOnce(new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE', 503, 'disk'));
    await expect(h.renewPassport(client)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    const results = await Promise.all([h.renewPassport(client), h.renewPassport(client)]);
    expect(client.refreshAccount.mock.calls.map(([token]) => token)).toEqual(['test-passport-old', 'test-passport-pending']);
    expect(results.every(pair => pair.accountToken === 'test-fresh-access')).toBe(true);
    expect(h.vault.passports[passportKey].accountRefreshToken).toBe('test-passport-latest');
    expect(h.vault.passports[passportKey].memberships.map((member: { membershipId: string }) => member.membershipId)).toEqual(['original', 'sibling']);
  });

  it.each(['removed', 'newer'] as const)('cannot restore an unpersisted Passport over a %s saved generation', async state => {
    const { h } = recoverySetup();
    const passportKey = passportVaultKey('global', 'passport-original');
    h.vault.passports[passportKey].accountRefreshToken = 'test-passport-old';
    const client = { refreshAccount: vi.fn(async () => ({
      accountToken: 'test-new-access', accountRefreshToken: 'test-new-refresh',
    })) };
    h.transaction.mockRejectedValueOnce(new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE', 503, 'disk'));
    await expect(h.renewPassport(client)).rejects.toMatchObject({ code: 'CREDENTIAL_STORE_UNAVAILABLE' });
    if (state === 'removed') {
      delete h.vault.passports[passportKey];
      await expect(h.renewPassport(client)).rejects.toMatchObject({ code: 'ACCOUNT_REAUTH_REQUIRED' });
      expect(h.vault.passports[passportKey]).toBeUndefined();
      expect(client.refreshAccount).toHaveBeenCalledTimes(1);
    } else {
      h.vault.passports[passportKey].accountRefreshToken = 'test-concurrent-newer';
      await h.renewPassport(client);
      expect(client.refreshAccount).toHaveBeenLastCalledWith('test-concurrent-newer');
    }
  });

  it('carries the vault owner discovered by real cold-start replacement retry across a lost response', async () => {
    const { h } = recoverySetup();
    const fresh = setup();
    fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
    fresh.vault.passports = h.vault.passports;
    fresh.saved.session.refreshToken = 'test-stale-projection';
    fresh.useProductionCandidates();
    let vaultRequests = 0;
    fresh.request.mockImplementation(async (token: unknown) => {
      if (token === 'test-refresh' && vaultRequests++ === 0) return { ok: false, status: 0, data: null };
      return { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } };
    });
    const startup = fresh.start();
    await vi.advanceTimersByTimeAsync(62_500);
    await startup;
    expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(fresh.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-stale-projection', 'test-refresh', 'test-refresh',
    ]);
    expect(fresh.authClient.exchangeAccountMembership).toHaveBeenCalledWith('test-passport-access', 'original');
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
  });

  it('keeps a valid compatibility rotation instead of preferring an older vault token', async () => {
    const fresh = setup();
    fresh.saved.session.refreshToken = 'test-newer-projection';
    fresh.useProductionCandidates();
    fresh.request.mockResolvedValue(fresh.ok);
    await fresh.start();
    expect(fresh.request).toHaveBeenCalledTimes(1);
    expect(fresh.request).toHaveBeenCalledWith('test-newer-projection', 'global');
    expect(fresh.state().isAuthenticated).toBe(true);
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
  });

  it.each(['projection', 'legacy'] as const)('follows a new %s rotation written during the selected vault request', async target => {
    const fresh = setup();
    fresh.saved.session.refreshToken = 'test-stale-projection';
    fresh.useProductionCandidates();
    fresh.request.mockImplementation(async (token: unknown) => {
      if (token === 'test-refresh') {
        if (target === 'projection') fresh.saved.session.refreshToken = 'test-new-compatibility';
        else fresh.deps.readSafe.mockReturnValue('test-new-compatibility');
      }
      if (token === 'test-new-compatibility') return fresh.ok;
      return { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } };
    });
    const startup = fresh.start();
    await vi.advanceTimersByTimeAsync(1_250);
    await startup;
    expect(fresh.state().isAuthenticated).toBe(true);
    expect(fresh.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-stale-projection', 'test-refresh', 'test-new-compatibility',
    ]);
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
    expect(fresh.clear).not.toHaveBeenCalled();
  });

  it.each(['projection', 'legacy'] as const)('tries an unrequested %s credential already present at a cross-realm vault handoff', async target => {
    const fresh = setup();
    fresh.saved.session = { version: 1, realm: 'cn', refreshToken: 'test-stale-cn' };
    fresh.useProductionCandidates();
    fresh.deps.readActiveVaultRefreshCandidate.mockReturnValue({
      accountKey: ORIGINAL_KEY, realm: 'global', refreshToken: 'test-refresh',
    });
    fresh.clear.mockImplementation(async () => {
      fresh.saved.session = { version: 1, realm: 'global', refreshToken: target === 'projection'
        ? 'test-handoff-compatibility' : 'test-stale-cn' };
      if (target === 'legacy') fresh.deps.readSafe.mockReturnValue('test-handoff-compatibility');
    });
    fresh.request.mockImplementation(async (token: unknown) => token === 'test-handoff-compatibility'
      ? fresh.ok
      : { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } });
    const startup = fresh.start();
    await vi.advanceTimersByTimeAsync(2_500);
    await startup;
    expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(fresh.request.mock.calls.map(([token]: unknown[]) => token)).toEqual([
      'test-stale-cn', 'test-refresh', 'test-handoff-compatibility',
    ]);
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
  });

  it.each(['absent', 'stale'] as const)('recovers the authoritative vault account with an %s compatibility projection', async projection => {
    const { h } = recoverySetup();
    const fresh = setup();
    fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
    fresh.vault.passports = h.vault.passports;
    fresh.saved.session = projection === 'absent' ? null : {
      version: 1, realm: 'global', refreshToken: 'test-stale-projection',
    };
    const pending = fresh.vaultRecovery();
    await vi.advanceTimersByTimeAsync(1);
    fresh.request.mockResolvedValue({
      ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } },
    });
    await vi.advanceTimersByTimeAsync(61_250);
    expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    await pending;
    expect(fresh.authClient.exchangeAccountMembership).toHaveBeenCalledWith('test-passport-access', 'original');
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
  });

  it('still rejects recovery without a projection outside the explicit vault-owned path', async () => {
    const { h } = recoverySetup();
    h.saved.session = null;
    await expect(h.strictResourceRecovery()).rejects.toMatchObject({ code: 'AUTH_FLOW_SUPERSEDED' });
    expect(h.deps.refreshPassportSessionSingleFlight).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves cold-start write-failure evidence unless explicitly cleared (clear=%s)', async explicitClear => {
    const { h } = recoverySetup();
    const fresh = setup();
    fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
    fresh.vault.passports = h.vault.passports;
    fresh.request.mockResolvedValueOnce(fresh.ok).mockResolvedValue({
      ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } },
    });
    fresh.transaction.mockRejectedValueOnce(new AuthApiError('CREDENTIAL_STORE_UNAVAILABLE', 503, 'disk'));
    const first = fresh.start();
    await vi.advanceTimersByTimeAsync(1_250);
    await first;
    expect(fresh.deps.onStartupFallback).toHaveBeenCalledTimes(1);
    expect(fresh.saved.session?.refreshToken).toBe('test-refresh');
    if (explicitClear) fresh.clearRuntimeAuth();
    const second = fresh.start();
    await vi.advanceTimersByTimeAsync(1_250);
    await second;
    if (explicitClear) {
      expect(fresh.state().isAuthenticated).toBe(false);
      expect(fresh.deps.refreshPassportSessionSingleFlight).not.toHaveBeenCalled();
      expect(fresh.clear).toHaveBeenCalled();
    } else {
      expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
      expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
      expect(fresh.clear).not.toHaveBeenCalled();
    }
  });

  it('recovers an already-rejected Resource after real 20s timeout cleanup and a transport failure', async () => {
    const { h } = recoverySetup();
    const fresh = setup();
    fresh.vault.resources[ORIGINAL_KEY].metadata = h.vault.resources[ORIGINAL_KEY].metadata;
    fresh.vault.passports = h.vault.passports;
    void fresh.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fresh.deps.onStartupFallback).toHaveBeenCalledTimes(1);
    fresh.request.mockResolvedValue({
      ok: false,
      status: 401,
      data: { error: { code: 'INVALID_REFRESH_TOKEN' } },
    });
    await vi.advanceTimersByTimeAsync(41_250);
    expect(fresh.saved.session?.refreshToken).toBe('test-rotated');
    expect(fresh.state()).toMatchObject({ isAuthenticated: true, user: { id: 'original' } });
    expect(fresh.clear).not.toHaveBeenCalled();
  });

  it('does not overwrite a vault generation advanced during membership exchange', async () => {
    const { h, exchange } = recoverySetup();
    exchange.mockImplementationOnce(async () => {
      h.vault.resources[ORIGINAL_KEY].refreshToken = 'test-newer-generation';
      return h.ok.data;
    });
    await rejectAfterLoss(h);
    expect(h.vault.resources[ORIGINAL_KEY].refreshToken).toBe('test-newer-generation');
    expect(h.saved.session?.refreshToken).toBe('test-refresh');
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
  });

  it.each(['logout', 'switch'])('does not reactivate the original account after %s during exchange', async action => {
    const { h, exchange } = recoverySetup();
    exchange.mockImplementationOnce(async () => {
      if (action === 'logout') h.logoutForTest();
      else h.changeOwner();
      return h.ok.data;
    });
    await rejectAfterLoss(h);
    if (action === 'logout') {
      expect(h.saved.session).toBeNull();
      expect(h.vault.resources[ORIGINAL_KEY]).toBeUndefined();
    } else {
      expect(h.saved.session?.refreshToken).toBe('other-refresh');
      expect(h.vault.activeAccountKey).toBe(accountVaultKey('global', 'other'));
      expect(h.vault.resources[ORIGINAL_KEY].refreshToken).toBe('test-rotated');
    }
    expect(h.deps.expireRuntimeAuth).not.toHaveBeenCalled();
  });

  it.each(['passive', 'tombstone', 'missing-passport'])('does not recover an ineligible %s account', async condition => {
    const { h, exchange } = recoverySetup();
    if (condition === 'passive') h.deps.isPassiveSharedUserDataInstance.mockReturnValue(true);
    // The captured port remains stable; configure its mock before runtime admission.
    if (condition === 'tombstone') h.vault.loggedOutAccountKeys = [ORIGINAL_KEY];
    if (condition === 'missing-passport') h.vault.passports = {};
    await rejectAfterLoss(h);
    expect(exchange).not.toHaveBeenCalled();
    expect(h.deps.refreshPassportSessionSingleFlight).not.toHaveBeenCalled();
  });

  it.each(['INVALID_REFRESH_TOKEN', 'MEMBERSHIP_DISABLED', 'DEVICE_MISMATCH'])(
    'does not use Passport to override a fresh %s rejection',
    async (code) => {
      const { h, exchange } = recoverySetup();
      h.request.mockResolvedValue({ ok: false, status: 401, data: { error: { code } } });
      const pending = h.runtimeRefresh();
      await vi.advanceTimersByTimeAsync(1_250);
      await pending;
      expect(exchange).not.toHaveBeenCalled();
      expect(h.deps.refreshPassportSessionSingleFlight).not.toHaveBeenCalled();
      expect(h.deps.expireRuntimeAuth).toHaveBeenCalled();
    },
  );
});
