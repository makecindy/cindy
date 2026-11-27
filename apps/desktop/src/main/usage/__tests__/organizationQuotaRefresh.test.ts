import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: { mode: 'cloud', ownerGeneration: 1, dataOwnerId: 'owner-a', user: { id: 'member-a', membershipKind: 'org' } },
  endpoint: 'https://gateway.example.test',
  managed: vi.fn(), broadcast: vi.fn(),
}));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../authManager', () => ({ getAuthState: () => mocks.auth }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ tapWindowBroadcast: mocks.broadcast }));
vi.mock('../../logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../maker-host/model-disable-store.js', () => ({ readModelDisableOverrides: () => ({}) }));
vi.mock('../organizationAccountUsage.js', () => ({ readOrganizationAccountUsage: mocks.managed }));
// Unit: exercise the production refresh/cache entry point. Source changes and
// same-membership realm switches must discard old results and recover on the next
// read; parser/HTTP failures are covered by organizationQuotaApi.test.ts.
const quota = { spend: 12, maxBudget: 100, currency: 'CNY', todaySpend: null, fetchedAt: 1 };
import * as api from '../claudeAccountUsage';
import * as state from '../../model-access/quotaCredentialState';
beforeEach(() => {
  api.__resetClaudeAccountUsageForTesting();
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.auth = { mode: 'cloud', ownerGeneration: 1, dataOwnerId: 'owner-a', user: { id: 'member-a', membershipKind: 'org' } };
  mocks.endpoint = 'https://gateway.example.test';
  state.setQuotaCredentialStatusReader(() => null);
  mocks.managed.mockResolvedValue(quota);
  state.__resetQuotaCredentialStateForTesting('cloud:owner-a:1', { state: 'ok', source: 'server', endpoint: mocks.endpoint, accountTier: null });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe('Cindy AI enterprise quota refresh', () => {
  it('publishes the server quota snapshot', async () => {
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
  });
  it('leaves an unavailable query without a snapshot', async () => {
    mocks.managed.mockResolvedValue(null);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
  });
  it('drops an in-flight response when switching enterprise accounts', async () => {
    let resolve!: (value: unknown) => void;
    mocks.managed.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = api.triggerClaudeAccountUsageRefresh(true);
    mocks.auth = { ...mocks.auth, dataOwnerId: 'owner-b' };
    resolve(quota); await pending;
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
    expect(mocks.broadcast).not.toHaveBeenCalled();
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
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
    expect(mocks.broadcast.mock.calls.every(([, value]) => value === null)).toBe(true);
    mocks.managed.mockResolvedValue(quota);
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
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
  });
});

describe('quota source invalidation', () => {
  it.each(['failed', 'disabled'] as const)('invalidates quota when its source is removed in %s state', async (syncState) => {
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(100);
    state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: syncState, source: 'server', endpoint: mocks.endpoint, accountTier: null });
    expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(100);
    mocks.managed.mockResolvedValue(null);
    state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: syncState, source: null, endpoint: null, accountTier: null });
    expect(api.readClaudeAccountQuotaClear()).toEqual({ quotaState: 'invalidated' });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.readClaudeAccountUsageSnapshot()).toBeNull();
  });

  it('reads managed quota before credential sync', async () => {
    state.__resetQuotaCredentialStateForTesting('cloud:owner-a:1', { state: 'idle', source: 'server', endpoint: mocks.endpoint, accountTier: null });
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
  });

  it('invalidates the old gateway quota even if the first new gateway query fails', async () => {
    await api.triggerClaudeAccountUsageRefresh(true);
    expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(100);
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
    let complete!: (value: unknown) => void;
    mocks.managed.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const pending = api.triggerClaudeAccountUsageRefresh(true);
    mocks.managed.mockResolvedValue(null);
    mocks.endpoint = 'https://new-gateway.example.test';
    state.noteQuotaCredentialStatus('cloud:owner-a:1', { state: 'ok', source: 'server', endpoint: mocks.endpoint, accountTier: null });
    complete({ ...quota, spend: 99 });
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

it('rebinds the quota source after a silent same-owner generation repair', async () => {
  state.setQuotaCredentialStatusReader(() => ({ state: 'ok', source: 'server', endpoint: mocks.endpoint, accountTier: null }));
  await api.triggerClaudeAccountUsageRefresh(true);
  expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(100);
  mocks.broadcast.mockClear();
  mocks.auth.ownerGeneration++;
  // No auth listener / credential status event is emitted by this repair.
  await api.triggerClaudeAccountUsageRefresh();
  await vi.waitFor(() => expect(api.readClaudeAccountUsageSnapshot()?.maxBudget).toBe(100));
  expect(mocks.broadcast.mock.calls[0]).toEqual(['usage:claude-account-changed', null]);
  expect(mocks.broadcast).toHaveBeenLastCalledWith('usage:claude-account-changed', quota);
});
it('reads the new owner quota without requiring a matching credential sync', async () => {
  state.setQuotaCredentialStatusReader(() => null);
  await api.triggerClaudeAccountUsageRefresh(true);
  mocks.auth.ownerGeneration++;
  await api.triggerClaudeAccountUsageRefresh();
  expect(api.readClaudeAccountUsageSnapshot()).toEqual(quota);
});

it('still throttles unavailable reads within one owner generation', async () => {
  mocks.managed.mockResolvedValue(null);
  await api.triggerClaudeAccountUsageRefresh();
  await api.triggerClaudeAccountUsageRefresh();
  expect(mocks.managed).toHaveBeenCalledTimes(1);
});
