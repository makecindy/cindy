import { beforeEach, describe, expect, it } from 'vitest';

import type { ProviderView } from '@cindy/model-providers';
import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  __testing,
  beginProvidersRefresh,
  commitProvidersSnapshot,
  getCachedProvidersSnapshot,
  isProvidersRefreshCurrent,
} from '@/lib/providersSnapshotStore';

describe('providersSnapshotStore owner isolation', () => {
  beforeEach(() => {
    dataOwnerTesting.reset();
    __testing.reset();
  });

  it('hides another owner cache and rejects an in-flight result after owner changes', () => {
    const ownerAProvider = { id: 'owner-a-provider' } as ProviderView;
    const ownerBProvider = { id: 'owner-b-provider' } as ProviderView;

    setDataOwnerGeneration('owner-a');
    const ownerAToken = beginProvidersRefresh();
    expect(commitProvidersSnapshot(ownerAToken, {
      dataOwnerId: 'owner-a',
      providers: [ownerAProvider],
      providerOrder: ['owner-a-provider'],
    })).toBe(true);
    expect(getCachedProvidersSnapshot()).toEqual({
      dataOwnerId: 'owner-a',
      providers: [ownerAProvider],
      providerOrder: ['owner-a-provider'],
    });

    const staleOwnerAToken = beginProvidersRefresh();
    setDataOwnerGeneration('owner-b');
    expect(getCachedProvidersSnapshot()).toBeNull();
    expect(isProvidersRefreshCurrent(staleOwnerAToken)).toBe(false);
    expect(commitProvidersSnapshot(staleOwnerAToken, {
      dataOwnerId: 'owner-a',
      providers: [ownerAProvider],
      providerOrder: ['owner-a-provider'],
    })).toBe(false);

    const ownerBToken = beginProvidersRefresh();
    const mismatchedOwnerSnapshot = {
      dataOwnerId: 'owner-a',
      providers: [ownerBProvider],
      providerOrder: ['owner-b-provider'],
    };
    expect(isProvidersRefreshCurrent(ownerBToken, mismatchedOwnerSnapshot)).toBe(false);
    expect(commitProvidersSnapshot(ownerBToken, mismatchedOwnerSnapshot)).toBe(false);
    expect(commitProvidersSnapshot(ownerBToken, {
      dataOwnerId: 'owner-b',
      providers: [ownerBProvider],
      providerOrder: ['owner-b-provider'],
    })).toBe(true);
    expect(getCachedProvidersSnapshot()).toEqual({
      dataOwnerId: 'owner-b',
      providers: [ownerBProvider],
      providerOrder: ['owner-b-provider'],
    });
  });
});
