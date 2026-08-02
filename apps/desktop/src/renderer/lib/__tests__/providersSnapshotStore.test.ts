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
    expect(commitProvidersSnapshot(ownerAToken, [ownerAProvider])).toBe(true);
    expect(getCachedProvidersSnapshot()).toEqual([ownerAProvider]);

    const staleOwnerAToken = beginProvidersRefresh();
    setDataOwnerGeneration('owner-b');
    expect(getCachedProvidersSnapshot()).toBeNull();
    expect(isProvidersRefreshCurrent(staleOwnerAToken)).toBe(false);
    expect(commitProvidersSnapshot(staleOwnerAToken, [ownerAProvider])).toBe(false);

    const ownerBToken = beginProvidersRefresh();
    expect(commitProvidersSnapshot(ownerBToken, [ownerBProvider])).toBe(true);
    expect(getCachedProvidersSnapshot()).toEqual([ownerBProvider]);
  });
});
