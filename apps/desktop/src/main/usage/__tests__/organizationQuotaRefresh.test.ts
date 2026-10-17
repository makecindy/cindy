import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: { mode: 'cloud', ownerGeneration: 1, dataOwnerId: 'owner-a', user: { id: 'member-a', membershipKind: 'org' } },
  endpoint: 'https://gateway.example.test',
  managed: vi.fn(), outbound: vi.fn(), broadcast: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../authManager', () => ({ getAuthState: () => mocks.auth }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ tapWindowBroadcast: mocks.broadcast }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../maker-host/auth-adapters', () => ({ readClaudeApiKey: () => 'fixture-key' }));
vi.mock('../../maker-host/outbound-fetch', () => ({ outboundFetch: mocks.outbound }));
vi.mock('../../maker-host/runtime-configs', () => ({ claudeUpstreamEndpoint: () => mocks.endpoint }));
vi.mock('../modelPricing', () => ({ getGatewayAccountCurrency: async () => 'CNY' }));
vi.mock('../ledgerCurrency', () => ({ currentLedgerCurrency: () => 'CNY' }));
vi.mock('../organizationAccountUsage.js', () => ({ readOrganizationAccountUsage: mocks.managed }));
const quota = { spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 };
let api: typeof import('../claudeAccountUsage');
let state: typeof import('../../model-access/quotaCredentialState');
beforeAll(async () => {
  // reset-modules: load the mocked usage module once before this suite; per-test resets use its production test reset API.
  vi.resetModules();
  api = await import('../claudeAccountUsage');
  state = await import('../../model-access/quotaCredentialState');
});
beforeEach(() => {
  api.__resetClaudeAccountUsageForTesting();
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.auth = { mode: 'cloud', ownerGeneration: 1, dataOwnerId: 'owner-a', user: { id: 'member-a', membershipKind: 'org' } };
  mocks.endpoint = 'https://gateway.example.test';
  state.setQuotaCredentialStatusReader(() => null);
  mocks.managed.mockResolvedValue(quota);
  mocks.outbound.mockResolvedValue({ ok: true, json: async () => ({ spend: 2, max_budget: 20, results: [] }) });
  state.__resetQuotaCredentialStateForTesting('cloud:owner-a:1', { state: 'ok', source: 'server', endpoint: mocks.endpoint, accountTier: null });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('Cindy AI enterprise quota refresh', () => {
  it('publishes server quota without calling LiteLLM APIs on an inference gateway', async () => {
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
    expect(mocks.outbound).not.toHaveBeenCalled();
  });
  it('preserves legacy Nova quota reads when the server capability is unsupported', async () => {
    mocks.managed.mockResolvedValue(undefined);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toMatchObject({ spend: 2, maxBudget: 20 });
    expect(mocks.outbound).toHaveBeenCalledTimes(2);
  });
  it('does not query legacy credentials on managed-query errors', async () => {
    mocks.managed.mockResolvedValue(null);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(mocks.outbound).not.toHaveBeenCalled();
  });
  it('drops an in-flight response when switching enterprise accounts', async () => {
    let resolve!: (value: unknown) => void;
    mocks.managed.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = api.triggerClaudeAccountUsageRefresh(true);
    mocks.auth = { ...mocks.auth, dataOwnerId: 'owner-b' };
    resolve(quota); await pending;
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
  });
  it('rejects an old realm response with the same membership and endpoint after sync fails', async () => {
    let resolve!: (value: unknown) => void;
    mocks.managed.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = api.triggerClaudeAccountUsageRefresh(true);
    mocks.auth.ownerGeneration++;
    state.noteQuotaCredentialStatus('cloud:owner-a:2', { state: 'failed', source: 'server', endpoint: mocks.endpoint, accountTier: null });
    mocks.managed.mockResolvedValue(null);
    resolve(quota); await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'invalidated' });
    expect(state.quotaCredentialsReady('cloud:owner-a:2', mocks.endpoint)).toBe(false);
  });
  it('clears and broadcasts an unlimited result after a finite quota was cached', async () => {
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
    const cleared = vi.fn();
    const offClear = api.observeClaudeAccountUsage(cleared);
    const revision = api.readClaudeAccountUsageRevision();
    mocks.managed.mockResolvedValue('unlimited');
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'unlimited' });
    expect(cleared).toHaveBeenCalledTimes(1);
    expect(api.readClaudeAccountUsageRevision()).toBe(revision + 1);
    offClear();
    mocks.managed.mockResolvedValue(null);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'unlimited' });
    mocks.auth = { ...mocks.auth, dataOwnerId: 'other-owner' };
    expect(api.readClaudeAccountQuotaClear()).toBeNull();
    expect(mocks.broadcast).toHaveBeenLastCalledWith('usage:claude-account-changed', null);
    expect(mocks.outbound).not.toHaveBeenCalled();
  });
  it('keeps local gateway reads on the original endpoint', async () => {
    mocks.auth.mode = 'local';
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(mocks.managed).not.toHaveBeenCalled();
    expect(mocks.outbound).toHaveBeenCalledTimes(2);
  });
});

describe('quota gateway migration boundary', () => {
  it.each(['failed', 'disabled'] as const)('clears legacy quota when credentials are removed in %s state', async (syncState) => {
    mocks.managed.mockResolvedValue(undefined);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(20);
    state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: syncState, source: 'server', endpoint: mocks.endpoint, accountTier: null });
    expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(20);
    state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: syncState, source: null, endpoint: null, accountTier: null });
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'invalidated' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(mocks.outbound).toHaveBeenCalledTimes(2);
  });

  it('blocks persisted legacy credentials before this process completes credential sync', async () => {
    state.__resetQuotaCredentialStateForTesting('cloud:owner-a:1', { state: 'idle', source: 'server', endpoint: mocks.endpoint, accountTier: null });
    mocks.managed.mockResolvedValue(undefined);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(mocks.outbound).not.toHaveBeenCalled();
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: 'ok', source: 'server', endpoint: mocks.endpoint, accountTier: null });
    await vi.waitFor(() => expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(20));
  });

  it('reads managed quota before credential sync without contacting the persisted gateway', async () => {
    state.__resetQuotaCredentialStateForTesting('cloud:owner-a:1', { state: 'idle', source: 'server', endpoint: mocks.endpoint, accountTier: null });
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
    expect(mocks.outbound).not.toHaveBeenCalled();
  });

  it('invalidates the old gateway quota even if the first new gateway query fails', async () => {
    mocks.managed.mockResolvedValue(undefined);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(20);
    mocks.managed.mockResolvedValue(null);
    mocks.endpoint = 'https://new-gateway.example.test';
    state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: 'ok', source: 'server', endpoint: mocks.endpoint, accountTier: null });
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'invalidated' });
    expect(mocks.broadcast).toHaveBeenLastCalledWith('usage:claude-account-changed', null);
    await vi.waitFor(() => expect(mocks.managed).toHaveBeenCalledTimes(2));
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
  });

  it('drops a late response from the previous gateway after credentials change', async () => {
    mocks.managed.mockResolvedValue(undefined);
    let complete!: (value: unknown) => void;
    mocks.outbound.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = api.triggerClaudeAccountUsageRefresh(true);
    await vi.waitFor(() => expect(mocks.outbound).toHaveBeenCalledTimes(2));
    mocks.managed.mockResolvedValue(null);
    mocks.endpoint = 'https://new-gateway.example.test';
    state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: 'ok', source: 'server', endpoint: mocks.endpoint, accountTier: null });
    complete({ ok: true, json: async () => ({ spend: 99, max_budget: 100 }) });
    await pending;
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'invalidated' });
    expect(mocks.broadcast.mock.calls.some(([, value]) => value?.spend === 99)).toBe(false);
  });
});

it('notifies main-process consumers when finite quota recovers after a source change', async () => {
  await api.triggerClaudeAccountUsageRefresh(true);
  let resolve!: (value: unknown) => void;
  mocks.managed.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const snapshots: unknown[] = [];
  const off = api.observeClaudeAccountUsage(() => snapshots.push(api.readClaudeAccountUsageSnapshot()));
  state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: 'ok', source: 'server', endpoint: 'https://new.example.test', accountTier: null });
  expect(snapshots).toEqual([null]);
  resolve(quota);
  await vi.waitFor(() => expect(snapshots).toEqual([null, quota]));
  off();
});

it('rebinds ready legacy credentials after a silent same-owner generation repair', async () => {
  mocks.managed.mockResolvedValue(undefined);
  state.setQuotaCredentialStatusReader(() => ({ state: 'ok', source: 'server', endpoint: mocks.endpoint, accountTier: null }));
  await api.triggerClaudeAccountUsageRefresh(true);
  expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(20);
  mocks.auth.ownerGeneration++;
  // No auth listener / credential status event is emitted by this repair.
  await api.triggerClaudeAccountUsageRefresh();
  await vi.waitFor(() => expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(20));
  expect(state.quotaCredentialsReady('cloud:owner-a:2', mocks.endpoint)).toBe(true);
});
it('does not rebind credentials when the sync identity no longer matches the realm', async () => {
  mocks.managed.mockResolvedValue(undefined);
  state.setQuotaCredentialStatusReader(() => null);
  await api.triggerClaudeAccountUsageRefresh(true);
  mocks.auth.ownerGeneration++;
  mocks.outbound.mockClear();
  await api.triggerClaudeAccountUsageRefresh();
  expect(mocks.outbound).not.toHaveBeenCalled();
  expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
});

it('still throttles unavailable reads within one owner generation', async () => {
  mocks.managed.mockResolvedValue(null);
  await api.triggerClaudeAccountUsageRefresh();
  await api.triggerClaudeAccountUsageRefresh();
  expect(mocks.managed).toHaveBeenCalledTimes(1);
});
