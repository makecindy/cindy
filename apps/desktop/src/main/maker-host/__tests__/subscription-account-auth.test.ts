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
  revokeDuringRefresh: false,
  callbacks: [] as Array<() => void>,
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
vi.mock('../claude-credentials-store.js', () => ({
  readClaudeAiOAuth: () => ({ accessToken: 'fake-local-token' }),
}));
vi.mock('../claude-oauth-refresh.js', () => ({
  createClaudeOAuthRefresher: (deps: { readOAuth: () => unknown; onInvalidGrant: () => void }) => {
    state.callbacks.push(deps.onInvalidGrant);
    return ({
    getValidOAuth: async () => {
      const captured = deps.readOAuth();
      if (state.revokeDuringRefresh) deps.onInvalidGrant();
      return captured;
    },
    invalidate: vi.fn(),
    backfillSubscriptionProfile: vi.fn(),
    });
  },
}));
vi.mock('../claude-oauth-login.js', () => ({
  runClaudeOAuthLogin: (...args: unknown[]) => state.login(...args),
  cancelClaudeOAuthLogin: vi.fn(),
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
  readClaudeAccountOAuth,
  cancelSubscriptionAccountLogin,
  removeSubscriptionAccountCredentialsReversibly,
  resetSubscriptionAccountCaches,
  getValidClaudeAccountOAuth,
  setSubscriptionAccountInvalidatedHandler,
  subscriptionAccountState,
} from '../subscription-account-auth.js';

describe('independent subscription account credentials', () => {
  it.each(['result', 'throw'])('restores the previous account if login fails after persistence (%s)', async failure => {
    state.secrets.set(`${state.scope}:claude-a`, JSON.stringify({ accessToken: 'fake-original' }));
    state.login.mockImplementation(async opts => {
      opts.persist({ accessToken: 'fake-uncommitted' });
      if (failure === 'throw') throw new Error('login failed');
      return { ok: false, reason: 'login failed' };
    });
    if (failure === 'throw') await expect(loginSubscriptionAccount('claude-a', () => true)).rejects.toThrow('login failed');
    else expect((await loginSubscriptionAccount('claude-a', () => true)).ok).toBe(false);
    expect(readClaudeAccountOAuth('claude-a')?.accessToken).toBe('fake-original');
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
    state.callbacks = [];
    state.removeFails = false;
    state.revokeDuringRefresh = false;
    setSubscriptionAccountInvalidatedHandler(() => {});
  });
  it.each([false, true])('invalid grant disconnects only the failed account even when removal fails=%s', async (removeFails) => {
    state.secrets.set(`${state.scope}:claude-a`, JSON.stringify({ accessToken: 'fake-a' }));
    state.secrets.set(`${state.scope}:claude-b`, JSON.stringify({ accessToken: 'fake-b' }));
    await getValidClaudeAccountOAuth('claude-a');
    respondModels('claude-account-only-old');
    await refreshSubscriptionAccountModels('claude-a');
    await refreshSubscriptionAccountModels('claude-b');
    const broadcast = vi.fn();
    setSubscriptionAccountInvalidatedHandler(broadcast);
    state.removeFails = removeFails;
    state.callbacks[0]();
    expect(broadcast).toHaveBeenCalledWith('claude-a');
    expect(discoveredIds('claude-a').some(m => m.includes('account-only-old'))).toBe(false);
    expect(discoveredIds('claude-b').some(m => m.includes('account-only-old'))).toBe(true);
    expect(subscriptionAccountState('claude-a').authenticated).toBe(false);
    expect(await getValidClaudeAccountOAuth('claude-a')).toBeNull();
    expect(readClaudeAccountOAuth('claude-b')?.accessToken).toBe('fake-b');
    expect(readClaudeAccountOAuth()?.accessToken).toBe('fake-local-token');
    state.login.mockImplementation(async opts => { opts.persist({ accessToken: 'fake-new' }); return { ok: true }; });
    await loginSubscriptionAccount('claude-a', () => true);
    expect(readClaudeAccountOAuth('claude-a')?.accessToken).toBe('fake-new');
  });
  it('late invalid grant from an old owner cannot clear or broadcast the new owner', async () => {
    await getValidClaudeAccountOAuth('claude-a');
    const broadcast = vi.fn();
    setSubscriptionAccountInvalidatedHandler(broadcast);
    state.scope = 'owner-b:2';
    state.secrets.set(`${state.scope}:claude-a`, JSON.stringify({ accessToken: 'fake-new-owner' }));
    state.callbacks[0]();
    expect(broadcast).not.toHaveBeenCalled();
    expect(readClaudeAccountOAuth('claude-a')?.accessToken).toBe('fake-new-owner');
  });
  it('does not return the refresher fallback credential on the invalid-grant request itself', async () => {
    state.secrets.set(`${state.scope}:claude-a`, JSON.stringify({ accessToken: 'fake-revoked' }));
    state.revokeDuringRefresh = true;
    state.removeFails = true;
    expect(await getValidClaudeAccountOAuth('claude-a')).toBeNull();
    expect(readClaudeAccountOAuth('claude-a')).toBeNull();
  });
  it('commits each login to its provider, preserving the local account and supporting rollback', async () => {
    state.login.mockImplementation(async (opts) => {
      opts.persist({ accessToken: 'fake-a' });
      return { ok: true };
    });
    const a = await loginSubscriptionAccount('claude-a', () => true);
    state.login.mockImplementation(async (opts) => {
      opts.persist({ accessToken: 'fake-b' });
      return { ok: true };
    });
    await loginSubscriptionAccount('claude-b', () => true);
    expect(readClaudeAccountOAuth('claude-a')?.accessToken).toBe('fake-a');
    expect(readClaudeAccountOAuth('claude-b')?.accessToken).toBe('fake-b');
    expect(readClaudeAccountOAuth()?.accessToken).toBe('fake-local-token');
    expect(a.rollbackCredentials?.()).toBe(true);
    expect(readClaudeAccountOAuth('claude-a')).toBeNull();
    expect(readClaudeAccountOAuth('claude-b')?.accessToken).toBe('fake-b');
  });
  it('cancelled late authorization cannot persist credentials', async () => {
    state.login.mockImplementation(async (opts) => {
      cancelSubscriptionAccountLogin('claude-a');
      expect(() => opts.persist({ accessToken: 'fake-late' })).toThrow('login_cancelled');
      return { ok: false };
    });
    expect((await loginSubscriptionAccount('claude-a', () => true)).ok).toBe(false);
    expect(readClaudeAccountOAuth('claude-a')).toBeNull();
  });
  it('owner switch rejects a late result without writing to the new owner', async () => {
    state.login.mockImplementation(async (opts) => {
      state.scope = 'owner-b:2';
      expect(() => opts.persist({ accessToken: 'fake-late' })).toThrow('login_cancelled');
      return { ok: false };
    });
    expect((await loginSubscriptionAccount('claude-a', () => true)).ok).toBe(false);
    expect(state.secrets.size).toBe(0);
  });
  it.each(['claude', 'grok'])('%s reports failed credential restoration when cancelled during catalog cleanup', async kind => {
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
  it.each(['claude', 'grok'])('%s reconnect failure cannot reuse the previous account models', async kind => {
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
  it.each(['claude', 'grok'])('%s removal and credential rollback clear only that connection discovery', async kind => {
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
    state.secrets.set('owner-a:1:claude-a', JSON.stringify({ accessToken: 'fake-a' }));
    const restore = removeSubscriptionAccountCredentialsReversibly('claude-a');
    expect(readClaudeAccountOAuth('claude-a')).toBeNull();
    expect(restore()).toBe(true);
    const staleRestore = removeSubscriptionAccountCredentialsReversibly('claude-a');
    state.secrets.set('owner-a:1:claude-a', JSON.stringify({ accessToken: 'fake-new' }));
    expect(staleRestore()).toBe(false);
    expect(readClaudeAccountOAuth('claude-a')?.accessToken).toBe('fake-new');
  });
});

const discoveredIds = (id: string) => Object.values(getActiveCatalog().providers.find(p => p.id === id)!.models).flat().map(m => m.id);
const putToken = (id: string, token: string) => state.secrets.set(`${state.scope}:${id}`, JSON.stringify({ accessToken: token, access_token: token }));
const respondModels = (model: string) => state.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
  url.includes('/user?') ? { userId: 'fake-user' } : { data: [{ id: model, model, display_name: model, type: 'model' }] },
)));
