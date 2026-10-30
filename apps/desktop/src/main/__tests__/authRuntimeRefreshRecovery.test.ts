import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retryAfterDeadline } from '@cindy/auth-client';
import { AuthRefreshBackoff } from '../authRefreshBackoff';
import {
  RuntimeRefreshConfirmation,
  resolveSessionExpiredReason,
  runRefreshWithReplacementRetry,
} from '../authRefreshFailure';

// Test value (unit): #7612's status=0 -> INVALID_REFRESH_TOKEN sequence must
// receive one confirmation opportunity, without bypassing shared retry admission.
// Execute the production runtime entry, replacement reads and retry timer with
// synthetic credentials/fake time; no Electron, real credentials or live server.
const source = ts.createSourceFile(
  'authManager.ts',
  readFileSync(new URL('../authManager.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set([
  'refresh',
  'apiFetch',
  'getRefreshErrorCode',
  'runAuthRefreshWithReplacementRetry',
  'scheduleRefreshRetryAfterTransientFailure',
]);
const compiled = ts.transpileModule(
  source.statements
    .filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ''))
    .map((node) => node.getText(source).replace(/^export /, ''))
    .join('\n'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;
const invalid = { ok: false, status: 401, data: { error: { code: 'INVALID_REFRESH_TOKEN' } } };
const network = { ok: false, status: 0, data: null };
const success = {
  ok: true,
  status: 200,
  data: {
    accessToken: 'synthetic-access',
    refreshToken: 'synthetic-rotated',
    membership: { id: 'synthetic-owner', kind: 'personal' },
  },
};

function setup() {
  const saved = { session: { realm: 'global', refreshToken: 'synthetic-refresh' } };
  const request = vi
    .fn<(...args: unknown[]) => Promise<{ ok: boolean; status: number; data: unknown }>>()
    .mockResolvedValue(network);
  const expire = vi.fn();
  const deps = {
    saved,
    request,
    expire,
    AuthRefreshBackoff,
    RuntimeRefreshConfirmation,
    retryAfterDeadline,
    net: { fetch: vi.fn() },
    authServerUrl: () => 'https://auth.example.invalid',
    requestErrorMessage: String,
    runRefreshWithReplacementRetry,
    resolveSessionExpiredReason,
    requestAuthRefresh: request,
    loadClientEndpointsForRealm: vi.fn(async () => {}),
    readPersistedAuthSession: () => saved.session,
    readStoredRefreshTokenCandidates: () => [saved.session.refreshToken],
    credentialStoreHealth: { noteRecovered: () => false },
    getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'synthetic-owner' }),
    log: { warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    commitDesktopRefreshCredentials: async (data: typeof success.data) => {
      saved.session.refreshToken = data.refreshToken;
      return 'active';
    },
    canRestoreAuthSessionForMembership: () => true,
    mergeMembershipWithExisting: (membership: unknown) => membership,
    withCloudOwnerCommit: async (options: {
      prepareTransition: () => Promise<void>;
      commit: () => void;
    }) => {
      await options.prepareTransition();
      options.commit();
    },
    accountSwitchTeardown: vi.fn(async () => {}),
    commitCloudAppSession: vi.fn(),
    migrateLocalProviderBindingsAfterCloudCommit: vi.fn(async () => {}),
    notifyRenderer: vi.fn(),
    notifyAuthListeners: vi.fn(),
  };
  const main = new Function(
    ...Object.keys(deps),
    `
    let authStateEpoch = 1, refreshPromise = null, refreshTimer = null;
    let accessToken = 'synthetic-old-access', currentUser = { id: 'synthetic-owner' };
    let activeAuthRealm = 'global', lastAcceptedRefreshToken = null;
    let persistedRefreshTokenNeedsIdentityCheck = false, foreignDeviceLocalSignOut = false;
    const coldStartAuthInFlight = null, AUTH_REGION = 'global', API_FETCH_TIMEOUT_MS = 15000;
    const RUNTIME_REFRESH_RETRY_MS = 60000, REFRESH_TOKEN_REPLACEMENT_RETRY_LIMIT = 2;
    const RUNTIME_REFRESH_TOKEN_REPLACEMENT_RECHECK_DELAYS_MS = [250, 1000];
    const refreshBackoff = new AuthRefreshBackoff(() => Date.now(), () => 0);
    const runtimeRefreshConfirmation = new RuntimeRefreshConfirmation(() => Date.now());
    const scheduleRefresh = () => { refreshBackoff.clear(); clearTimeout(refreshTimer); };
    const expireRuntimeAuth = async (...args) => { expire(...args); authStateEpoch++; accessToken = null; currentUser = null; clearTimeout(refreshTimer); };
    ${compiled}
    return { call: refresh, fetch: apiFetch, changeOwner: () => { authStateEpoch++; },
      state: () => ({ accessToken, currentUser }), backoff: refreshBackoff };
  `,
  )(...Object.values(deps));
  return { ...main, request, expire, saved, deps };
}

async function settle(h: ReturnType<typeof setup>) {
  const pending = h.call();
  await vi.advanceTimersByTimeAsync(1250);
  return pending;
}

describe('runtime refresh after an uncertain network result', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(['net::ERR_NETWORK_CHANGED', 'net::ERR_TIMED_OUT', 'net::ERR_CONNECTION_RESET'])(
    'confirms invalid after apiFetch reports %s',
    async (message) => {
      const h = setup();
      h.deps.net.fetch.mockRejectedValue(new Error(message));
      h.request.mockImplementation(() => h.fetch('/api/auth/refresh', { timeoutMs: 0 }));
      await h.call();
      h.request.mockResolvedValue(invalid);
      await vi.advanceTimersByTimeAsync(61_250);
      expect(h.expire).not.toHaveBeenCalled();
      expect(h.request).toHaveBeenCalledTimes(2);
    },
  );

  it('also confirms when the server sent success headers but the rotation body could not be read', async () => {
    const h = setup();
    h.deps.net.fetch.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error('synthetic interrupted response');
      },
    });
    h.request.mockImplementation(() => h.fetch('/api/auth/refresh', { timeoutMs: 0 }));
    await h.call();
    h.request.mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(61_250);
    expect(h.expire).not.toHaveBeenCalled();
  });

  it.each([429, 503])('does not infer a lost rotation from HTTP %s alone', async (status) => {
    const h = setup();
    h.request.mockResolvedValue({ ok: false, status, data: null });
    await h.call();
    h.request.mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(61_250);
    expect(h.expire).toHaveBeenCalledTimes(1);
  });

  it('keeps the session after the first invalid response, then expires on confirmation', async () => {
    const h = setup();
    await h.call();
    h.request.mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(61_250);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.expire).not.toHaveBeenCalled();
    expect(h.state().accessToken).toBe('synthetic-old-access');
    await vi.advanceTimersByTimeAsync(121_250);
    expect(h.request).toHaveBeenCalledTimes(3);
    expect(h.expire).toHaveBeenCalledExactlyOnceWith('synthetic-owner', 'replaced-elsewhere');
  });

  it('recovers on the confirmation request and requires fresh network uncertainty for another deferral', async () => {
    const h = setup();
    await h.call();
    h.request.mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(61_250);
    expect(h.expire).not.toHaveBeenCalled();
    h.request.mockResolvedValue(success);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.saved.session.refreshToken).toBe('synthetic-rotated');
    expect(h.state().accessToken).toBe('synthetic-access');
    h.request.mockResolvedValue(invalid);
    await settle(h);
    expect(h.expire).toHaveBeenCalledTimes(1);
  });

  it.each([
    'INVALID_REFRESH_TOKEN',
    'REFRESH_TOKEN_EXPIRED',
    'MEMBERSHIP_DISABLED',
    'DEVICE_MISMATCH',
  ])('preserves the immediate expiry path for a definite %s without uncertainty', async (code) => {
    const h = setup();
    h.request.mockResolvedValue({ ...invalid, data: { error: { code } } });
    await settle(h);
    expect(h.expire).toHaveBeenCalledTimes(1);
    if (code === 'DEVICE_MISMATCH')
      expect(h.expire).toHaveBeenCalledWith('synthetic-owner', 'device-mismatch', {
        preservePersistedRefreshToken: true,
      });
  });

  it.each(['REFRESH_TOKEN_EXPIRED', 'MEMBERSHIP_DISABLED', 'DEVICE_MISMATCH'])(
    'does not defer %s even after a network failure',
    async (code) => {
      const h = setup();
      await h.call();
      h.request.mockResolvedValue({ ...invalid, data: { error: { code } } });
      await vi.advanceTimersByTimeAsync(61_250);
      expect(h.expire).toHaveBeenCalledTimes(1);
    },
  );

  it('uses a replacement written during the confirmation wait instead of replaying the rejected token', async () => {
    const h = setup();
    await h.call();
    h.request.mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(61_250);
    expect(h.expire).not.toHaveBeenCalled();
    h.saved.session.refreshToken = 'synthetic-replacement';
    h.request.mockResolvedValue(success);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.request).toHaveBeenLastCalledWith('synthetic-replacement', 'global');
    expect(h.state().accessToken).toBe('synthetic-access');
    expect(h.expire).not.toHaveBeenCalled();
  });

  it('does not treat an old network failure as fresh uncertainty after a long sleep', async () => {
    const h = setup();
    await h.call();
    vi.setSystemTime(Date.now() + 16 * 60_000);
    h.request.mockResolvedValue(invalid);
    await settle(h);
    expect(h.expire).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm confirmation when another network failure follows the first invalid', async () => {
    const h = setup();
    await h.call();
    h.request.mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(61_250);
    h.request.mockResolvedValue(network);
    await vi.advanceTimersByTimeAsync(120_000);
    h.request.mockResolvedValue(invalid);
    await vi.advanceTimersByTimeAsync(241_250);
    expect(h.request).toHaveBeenCalledTimes(4);
    expect(h.expire).toHaveBeenCalledTimes(1);
  });

  it.each(['epoch', 'token', 'realm'])(
    'does not transfer uncertainty to a different %s',
    async (scope) => {
      const h = setup();
      await h.call();
      if (scope === 'epoch') h.changeOwner();
      if (scope === 'token') h.saved.session.refreshToken = 'synthetic-other';
      // Match the active realm too, without requiring the endpoint manifest loader.
      if (scope === 'realm') h.saved.session.realm = 'cn';
      h.request.mockResolvedValue(invalid);
      await vi.advanceTimersByTimeAsync(61_250);
      if (scope === 'epoch') await settle(h);
      expect(h.expire).toHaveBeenCalledTimes(1);
    },
  );

  it('shares an in-flight request and all callers honor the same backoff after network failure', async () => {
    const h = setup();
    let resolve!: (result: typeof network) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const calls = [h.call(), h.call({ networkRecovered: true }), h.call()];
    expect(h.request).toHaveBeenCalledTimes(1);
    resolve(network);
    await expect(Promise.all(calls)).resolves.toEqual([false, false, false]);
    for (let attempt = 0; attempt < 5; attempt++) await h.call({ networkRecovered: true });
    expect(h.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.request).toHaveBeenCalledTimes(2);
  });

  it('ignores a late network result after logout or a newer login', async () => {
    const h = setup();
    let resolve!: (result: typeof network) => void;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = h.call();
    h.changeOwner();
    resolve(network);
    await pending;
    h.request.mockResolvedValue(invalid);
    await settle(h);
    expect(h.expire).toHaveBeenCalledTimes(1);
    expect(h.backoff.remaining(2)).toBe(0);
  });
});
