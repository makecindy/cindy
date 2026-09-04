// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MarketCategory } from '../../../../../shared/skillhubCategory';

interface CategoryResponse {
  success: boolean;
  categories: MarketCategory[];
  totalCount: number;
  myTotalCount: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

let useCategoryList: typeof import('../useMarketList').useCategoryList;
let setDataOwnerGeneration: typeof import('@/contexts/dataOwnerGeneration').setDataOwnerGeneration;

describe('useCategoryList data-owner isolation', () => {
  beforeEach(async () => {
    vi.resetModules();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    const ownerModule = await import('@/contexts/dataOwnerGeneration');
    ownerModule.__testing.reset();
    setDataOwnerGeneration = ownerModule.setDataOwnerGeneration;
    setDataOwnerGeneration('owner-a', 1);
    ({ useCategoryList } = await import('../useMarketList'));
  });

  it('does not reuse or apply an in-flight category response across accounts', async () => {
    const staleRead = deferred<CategoryResponse>();
    const freshCategory = { slug: 'team-b', name: 'Team B', count: 1, myCount: 0 };
    const listCategories = vi
      .fn<() => Promise<CategoryResponse>>()
      .mockImplementationOnce(() => staleRead.promise)
      .mockResolvedValueOnce({
        success: true,
        categories: [freshCategory],
        totalCount: 1,
        myTotalCount: 0,
      });
    (window as unknown as {
      electronAPI: { skillhub: { listCategories: typeof listCategories } };
    }).electronAPI = { skillhub: { listCategories } };

    const first = renderHook(() => useCategoryList('team'));
    await waitFor(() => expect(listCategories).toHaveBeenCalledTimes(1));
    first.unmount();

    setDataOwnerGeneration('owner-b', 2);
    const second = renderHook(() => useCategoryList('team'));
    await waitFor(() => expect(listCategories).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(second.result.current.categories).toEqual([freshCategory]));

    await act(async () => {
      staleRead.resolve({
        success: true,
        categories: [{ slug: 'team-a', name: 'Team A', count: 1, myCount: 1 }],
        totalCount: 1,
        myTotalCount: 1,
      });
      await staleRead.promise;
    });

    expect(second.result.current.categories).toEqual([freshCategory]);
  });
});
