import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  __testing,
  beginProvidersRefresh,
  commitProvidersSnapshot,
  failProvidersRefresh,
  hasProvidersSnapshotLoadFailed,
  getCachedProvidersSnapshot,
  invalidateProvidersSnapshot,
  isProvidersRefreshCurrent,
  subscribeProvidersSnapshot,
} from '@/lib/providersSnapshotStore';

describe('providersSnapshotStore owner isolation', () => {
  beforeEach(() => {
    dataOwnerTesting.reset();
    __testing.reset();
  });

  it('notifies failure without a snapshot, clears it for retry, and ignores superseded failures', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProvidersSnapshot(listener);
    const first = beginProvidersRefresh();
    failProvidersRefresh(first);
    expect(hasProvidersSnapshotLoadFailed()).toBe(true);
    expect(getCachedProvidersSnapshot()).toBeNull();
    expect(listener).toHaveBeenLastCalledWith(null);

    const retry = beginProvidersRefresh();
    expect(hasProvidersSnapshotLoadFailed()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    failProvidersRefresh(first);
    expect(hasProvidersSnapshotLoadFailed()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    const snapshot = { dataOwnerId: null, ownerGeneration: 1, providers: [], providerOrder: [] };
    expect(commitProvidersSnapshot(retry, snapshot)).toBe(true);
    failProvidersRefresh(beginProvidersRefresh());
    expect(hasProvidersSnapshotLoadFailed()).toBe(true);
    expect(getCachedProvidersSnapshot()).toBe(snapshot);
    unsubscribe();
  });

  it('does not expose or accept a failure from the previous owner', () => {
    setDataOwnerGeneration('owner-a');
    const first = beginProvidersRefresh();
    failProvidersRefresh(first);
    expect(hasProvidersSnapshotLoadFailed()).toBe(true);
    setDataOwnerGeneration('owner-b');
    expect(hasProvidersSnapshotLoadFailed()).toBe(false);
    failProvidersRefresh(first);
    expect(hasProvidersSnapshotLoadFailed()).toBe(false);
    invalidateProvidersSnapshot();
    expect(hasProvidersSnapshotLoadFailed()).toBe(false);
  });

  it('hides another owner cache and rejects an in-flight result after owner changes', () => {
    const ownerAProvider = { id: 'owner-a-provider' } as ProviderView;
    const ownerBProvider = { id: 'owner-b-provider' } as ProviderView;

    setDataOwnerGeneration('owner-a');
    const ownerAToken = beginProvidersRefresh();
    expect(commitProvidersSnapshot(ownerAToken, {
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      providers: [ownerAProvider],
      providerOrder: ['owner-a-provider'],
    })).toBe(true);
    expect(getCachedProvidersSnapshot()).toEqual({
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      providers: [ownerAProvider],
      providerOrder: ['owner-a-provider'],
    });

    const listener = vi.fn();
    const unsubscribe = subscribeProvidersSnapshot(listener);
    const staleOwnerAToken = beginProvidersRefresh();
    setDataOwnerGeneration('owner-b');
    invalidateProvidersSnapshot();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(null);
    expect(getCachedProvidersSnapshot()).toBeNull();
    expect(isProvidersRefreshCurrent(staleOwnerAToken)).toBe(false);
    expect(commitProvidersSnapshot(staleOwnerAToken, {
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      providers: [ownerAProvider],
      providerOrder: ['owner-a-provider'],
    })).toBe(false);

    const ownerBToken = beginProvidersRefresh();
    const mismatchedOwnerSnapshot = {
      dataOwnerId: 'owner-a',
      ownerGeneration: 1,
      providers: [ownerBProvider],
      providerOrder: ['owner-b-provider'],
    };
    expect(isProvidersRefreshCurrent(ownerBToken, mismatchedOwnerSnapshot)).toBe(false);
    expect(commitProvidersSnapshot(ownerBToken, mismatchedOwnerSnapshot)).toBe(false);
    expect(commitProvidersSnapshot(ownerBToken, {
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      providers: [ownerBProvider],
      providerOrder: ['owner-b-provider'],
    })).toBe(true);
    expect(getCachedProvidersSnapshot()).toEqual({
      dataOwnerId: 'owner-b',
      ownerGeneration: 2,
      providers: [ownerBProvider],
      providerOrder: ['owner-b-provider'],
    });
    unsubscribe();
  });
});
