/** @vitest-environment jsdom */

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  refreshLocalCatalogSnapshot: vi.fn(async () => true),
  getCachedProvidersSnapshot: vi.fn(() => []),
  subscribeProvidersSnapshot: vi.fn(() => () => {}),
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
  it('refetches the atomic providers and capabilities snapshot', () => {
    const { result } = renderHook(() => useProviders());

    act(() => result.current.refetch());

    expect(mocks.refreshLocalCatalogSnapshot).toHaveBeenCalledOnce();
  });
});
