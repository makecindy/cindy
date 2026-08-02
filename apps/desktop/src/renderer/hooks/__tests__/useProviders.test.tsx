/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { ProviderView } from '@cindy/model-providers';

const mocks = vi.hoisted(() => ({
  authState: { dataOwnerId: 'owner-a' as string | null },
  cachedOwnerId: 'owner-a' as string | null,
  cachedProviders: [] as ProviderView[],
  latestListener: null as null | ((providers: ProviderView[]) => void),
  refreshLocalCatalogSnapshot: vi.fn(async () => true),
  getCachedProvidersSnapshot: vi.fn(),
  subscribeProvidersSnapshot: vi.fn(),
}));

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: mocks.authState.dataOwnerId, generation: 1 }),
}));

vi.mock('@/lib/localCatalogSnapshot', () => ({
  refreshLocalCatalogSnapshot: mocks.refreshLocalCatalogSnapshot,
}));

vi.mock('@/lib/providersSnapshotStore', () => ({
  getCachedProvidersSnapshot: mocks.getCachedProvidersSnapshot,
  subscribeProvidersSnapshot: mocks.subscribeProvidersSnapshot,
}));

import { useProviders } from '../useProviders';

describe('useProviders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authState.dataOwnerId = 'owner-a';
    mocks.cachedOwnerId = 'owner-a';
    mocks.cachedProviders = [];
    mocks.latestListener = null;
    mocks.getCachedProvidersSnapshot.mockImplementation(() =>
      mocks.cachedOwnerId === mocks.authState.dataOwnerId ? mocks.cachedProviders : null,
    );
    mocks.subscribeProvidersSnapshot.mockImplementation(
      (listener: (providers: ProviderView[]) => void) => {
        mocks.latestListener = listener;
        return () => {
          if (mocks.latestListener === listener) mocks.latestListener = null;
        };
      },
    );
  });

  it('refetches the atomic providers and capabilities snapshot', () => {
    const { result } = renderHook(() => useProviders());

    act(() => result.current.refetch());

    expect(mocks.refreshLocalCatalogSnapshot).toHaveBeenCalledOnce();
  });

  it('does not expose the previous owner snapshot while the new owner is loading', () => {
    const ownerAProvider = { id: 'owner-a-provider' } as ProviderView;
    const ownerBProvider = { id: 'owner-b-provider' } as ProviderView;
    mocks.cachedProviders = [ownerAProvider];
    const { result, rerender } = renderHook(() => useProviders());
    expect(result.current.providers).toEqual([ownerAProvider]);
    expect(result.current.loading).toBe(false);

    act(() => {
      mocks.authState.dataOwnerId = 'owner-b';
      rerender();
    });
    expect(result.current.providers).toEqual([]);
    expect(result.current.loading).toBe(true);

    act(() => {
      mocks.cachedOwnerId = 'owner-b';
      mocks.cachedProviders = [ownerBProvider];
      mocks.latestListener?.([ownerBProvider]);
    });
    expect(result.current.providers).toEqual([ownerBProvider]);
    expect(result.current.loading).toBe(false);
  });
});
