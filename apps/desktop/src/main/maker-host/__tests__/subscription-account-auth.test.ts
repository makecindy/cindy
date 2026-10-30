import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUNDLED_CATALOG, buildUserProvider } from '@cindy/model-providers';
import { getActiveCatalog, setActiveCatalog, clearDiscoveredProviderModels } from '../active-catalog.js';
import { refreshSubscriptionAccountModels } from '../subscription-account-models.js';
import { waitForXaiDiscoveryIdleForTest } from '../model-discovery/xai.js';
const state = vi.hoisted(() => ({
  directory: '',
  fetch: vi.fn(),
  scope: 'owner-a:1',
  pending: false,
  secrets: new Map<string, string>(),
  login: vi.fn(),
  removeFails: false,
}));
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => state.scope,
  ownerScopedUserDataPath: (...parts: string[]) => path.join(state.directory, state.scope.replaceAll(':', '_'), ...parts),
  isAppSessionBoundaryPending: () => state.pending,
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  genericOAuthSecretIo: {
    read: (id: string) => state.secrets.get(`${state.scope}:${id}`) ?? null,
    readStrict: (id: string) => state.secrets.get(`${state.scope}:${id}`) ?? null,
    write: (id: string, value: string) => {
      state.secrets.set(`${state.scope}:${id}`, value);
      return true;
    },
    remove: (id: string) => {
      if (state.removeFails) return false;
      state.secrets.delete(`${state.scope}:${id}`);
      return true;
    },
  },
}));
vi.mock('../grok-oauth-login.js', () => ({
  runGrokOAuthLogin: (...args: unknown[]) => state.login(...args),
  getGrokAccessToken: async (id: string) => JSON.parse(state.secrets.get(`${state.scope}:${id}`) ?? 'null')?.access_token,
  peekGrokAccessToken: (id: string) => JSON.parse(state.secrets.get(`${state.scope}:${id}`) ?? 'null')?.access_token ?? null,
  cancelGrokOAuthLogin: vi.fn(),
  hasGrokOAuthLogin: (id: string) => state.secrets.has(`${state.scope}:${id}`),
  grokAccountIdentity: vi.fn(),
  logoutGrok: (id: string) => { state.secrets.delete(`${state.scope}:${id}`); },
  resetGrokOAuthMemoryCache: vi.fn(),
}));
vi.mock('../outbound-fetch.js', () => ({ outboundFetch: (...args: unknown[]) => state.fetch(...args) }));
import {
  loginSubscriptionAccount,
  cancelSubscriptionAccountLogin,
  removeSubscriptionAccountCredentialsReversibly,
  resetSubscriptionAccountCaches,
  setSubscriptionAccountInvalidatedHandler,
  subscriptionAccountState,
} from '../subscription-account-auth.js';

const storedToken = (id: string): string | undefined =>
  JSON.parse(state.secrets.get(`${state.scope}:${id}`) ?? 'null')?.access_token;

describe('independent subscription account credentials', () => {
  it.each(['result', 'throw'])('restores the previous account if login fails after persistence (%s)', async failure => {
    putToken('grok-a', 'fake-original');
    state.login.mockImplementation(async opts => {
      opts.persist({ access_token: 'fake-uncommitted' });
      if (failure === 'throw') throw new Error('login failed');
      return { ok: false, reason: 'login failed' };
    });
    if (failure === 'throw') await expect(loginSubscriptionAccount('grok-a', () => true)).rejects.toThrow('login failed');
    else expect((await loginSubscriptionAccount('grok-a', () => true)).ok).toBe(false);
    expect(storedToken('grok-a')).toBe('fake-original');
  });
  it('retired independent Claude accounts never log in, refresh or expose credentials', async () => {
    putToken('claude-a', 'fake-stored');
    await expect(loginSubscriptionAccount('claude-a', () => true)).resolves.toEqual({
      ok: false, reason: 'claude_account_retired',
    });
    expect(state.login).not.toHaveBeenCalled();
    expect(subscriptionAccountState('claude-a')).toEqual({
      authenticated: false, errorReason: 'claude_account_retired', authSource: 'oauth',
    });
    expect(await refreshSubscriptionAccountModels('claude-a')).toBe(false);
    expect(state.fetch).not.toHaveBeenCalled();
    // 已存的凭证不被静默删除;用户删除账号时才清。
    expect(storedToken('claude-a')).toBe('fake-stored');
    removeSubscriptionAccountCredentialsReversibly('claude-a');
    expect(storedToken('claude-a')).toBeUndefined();
  });
  beforeEach(async () => {
    state.directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'cindy-account-discovery-'));
    clearDiscoveredProviderModels();
    setActiveCatalog({ ...BUNDLED_CATALOG, providers: [...BUNDLED_CATALOG.providers,
      ...['claude-a', 'claude-b', 'grok-a', 'grok-b'].map(id => buildUserProvider({
        id, name: id, auth: { method: 'oauth', native: id.startsWith('claude') ? 'claude' : 'xai' }, runtimes: {},
      })),
    ] });
    state.fetch.mockReset();
    resetSubscriptionAccountCaches();
    state.scope = 'owner-a:1';
    state.pending = false;
    state.secrets.clear();
    state.login.mockReset();
    state.removeFails = false;
    setSubscriptionAccountInvalidatedHandler(() => {});
  });
  it('commits each login to its provider and supports rollback', async () => {
    state.login.mockImplementation(async (opts) => {
      opts.persist({ access_token: 'fake-a' });
      return { ok: true };
    });
    const a = await loginSubscriptionAccount('grok-a', () => true);
    state.login.mockImplementation(async (opts) => {
      opts.persist({ access_token: 'fake-b' });
      return { ok: true };
    });
    await loginSubscriptionAccount('grok-b', () => true);
    expect(storedToken('grok-a')).toBe('fake-a');
    expect(storedToken('grok-b')).toBe('fake-b');
    expect(a.rollbackCredentials?.()).toBe(true);
    expect(storedToken('grok-a')).toBeUndefined();
    expect(storedToken('grok-b')).toBe('fake-b');
  });
  it('cancelled late authorization cannot persist credentials', async () => {
    state.login.mockImplementation(async (opts) => {
      cancelSubscriptionAccountLogin('grok-a');
      expect(() => opts.persist({ access_token: 'fake-late' })).toThrow('login_cancelled');
      return { ok: false };
    });
    expect((await loginSubscriptionAccount('grok-a', () => true)).ok).toBe(false);
    expect(storedToken('grok-a')).toBeUndefined();
  });
  it('owner switch rejects a late result without writing to the new owner', async () => {
    state.login.mockImplementation(async (opts) => {
      state.scope = 'owner-b:2';
      expect(() => opts.persist({ access_token: 'fake-late' })).toThrow('login_cancelled');
      return { ok: false };
    });
    expect((await loginSubscriptionAccount('grok-a', () => true)).ok).toBe(false);
    expect(state.secrets.size).toBe(0);
  });
  it.each(['grok'])('%s reports failed credential restoration when cancelled during catalog cleanup', async kind => {
    const id = `${kind}-a`;
    let checks = 0;
    state.login.mockImplementation(async opts => {
      opts.persist({ accessToken: 'fake-uncommitted', access_token: 'fake-uncommitted' });
      state.removeFails = true;
      return { ok: true };
    });
    // persist and pre-cleanup checks succeed; cancellation arrives at the post-cleanup check.
    await expect(loginSubscriptionAccount(id, () => ++checks < 3)).rejects.toThrow('Failed to restore credentials');
  });
  afterEach(async () => {
    await waitForXaiDiscoveryIdleForTest();
    clearDiscoveredProviderModels();
    setActiveCatalog(BUNDLED_CATALOG);
    await fsp.rm(state.directory, { recursive: true, force: true });
  });
  it.each(['grok'])('%s reconnect failure cannot reuse the previous account models', async kind => {
    const id = `${kind}-a`, peer = `${kind}-b`;
    putToken(id, 'fake-old'); putToken(peer, 'fake-peer');
    respondModels('claude-account-only-old');
    expect(await refreshSubscriptionAccountModels(id)).toBe(true);
    expect(await refreshSubscriptionAccountModels(peer)).toBe(true);
    expect(discoveredIds(id).some(m => m.includes('account-only-old'))).toBe(true);
    // Start another old-account request before replacing its credentials.
    let release!: (value: Response) => void;
    state.fetch.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
    const stale = refreshSubscriptionAccountModels(id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    state.login.mockImplementation(async opts => {
      opts.persist({ accessToken: 'fake-new', access_token: 'fake-new' }); return { ok: true };
    });
    expect((await loginSubscriptionAccount(id, () => true)).ok).toBe(true);
    state.fetch.mockRejectedValue(new Error('offline'));
    await refreshSubscriptionAccountModels(id).catch(() => false);
    release(new Response(JSON.stringify({ userId: 'fake-user', data: [{ id: 'claude-late-old', display_name: 'Late old', type: 'model' }] })));
    await stale;
    expect(discoveredIds(id).some(m => /account-only-old|late-old/.test(m))).toBe(false);
    expect(discoveredIds(peer).some(m => m.includes('account-only-old'))).toBe(true);
    if (kind === 'grok') {
      await expect(fsp.stat(path.join(state.directory, state.scope.replaceAll(':', '_'), 'model-discovery', `${id}-models.json`))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fsp.stat(path.join(state.directory, state.scope.replaceAll(':', '_'), 'model-discovery', `${peer}-models.json`))).resolves.toBeDefined();
    }
  });
  it.each(['grok'])('%s removal and credential rollback clear only that connection discovery', async kind => {
    const id = `${kind}-a`, peer = `${kind}-b`;
    putToken(id, 'fake-old'); putToken(peer, 'fake-peer');
    respondModels('claude-account-only-old');
    await refreshSubscriptionAccountModels(id); await refreshSubscriptionAccountModels(peer);
    const restore = removeSubscriptionAccountCredentialsReversibly(id);
    expect(discoveredIds(id).some(m => m.includes('account-only-old'))).toBe(false);
    expect(restore()).toBe(true);
    state.login.mockImplementation(async opts => {
      opts.persist({ accessToken: 'fake-new', access_token: 'fake-new' }); return { ok: true };
    });
    const login = await loginSubscriptionAccount(id, () => true);
    respondModels('claude-account-only-new'); await refreshSubscriptionAccountModels(id);
    expect(discoveredIds(id).some(m => m.includes('account-only-new'))).toBe(true);
    expect(login.rollbackCredentials?.()).toBe(true);
    await waitForXaiDiscoveryIdleForTest();
    expect(discoveredIds(id).some(m => m.includes('account-only-new'))).toBe(false);
    expect(discoveredIds(peer).some(m => m.includes('account-only-old'))).toBe(true);
  });
  it('credential removal is reversible and cannot replace a newer login', async () => {
    putToken('grok-a', 'fake-a');
    const restore = removeSubscriptionAccountCredentialsReversibly('grok-a');
    expect(storedToken('grok-a')).toBeUndefined();
    expect(restore()).toBe(true);
    expect(storedToken('grok-a')).toBe('fake-a');
    const staleRestore = removeSubscriptionAccountCredentialsReversibly('grok-a');
    putToken('grok-a', 'fake-new');
    expect(staleRestore()).toBe(false);
    expect(storedToken('grok-a')).toBe('fake-new');
  });
});

const discoveredIds = (id: string) => Object.values(getActiveCatalog().providers.find(p => p.id === id)!.models).flat().map(m => m.id);
const putToken = (id: string, token: string) => state.secrets.set(`${state.scope}:${id}`, JSON.stringify({ accessToken: token, access_token: token }));
const respondModels = (model: string) => state.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
  url.includes('/user?') ? { userId: 'fake-user' } : { data: [{ id: model, model, display_name: model, type: 'model' }] },
)));
