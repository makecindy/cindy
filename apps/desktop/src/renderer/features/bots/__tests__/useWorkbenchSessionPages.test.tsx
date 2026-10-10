// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkbenchSessionPages } from '../useWorkbenchSessionPages';
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  generation: 1,
  patch: null as any,
  reset: null as any,
  refresh: null as any,
  snapshot: [] as any[],
}));
vi.mock('@/lib/sessionService', () => ({ list: mocks.list }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => mocks.generation,
  isDataOwnerGenerationCurrent: (g: number) => g === mocks.generation,
}));
vi.mock('@/lib/sessionsBus', () => ({
  onRefresh: (cb: any) => {
    mocks.refresh = cb;
    return () => {};
  },
  onPatch: (cb: any) => {
    mocks.patch = cb;
    return () => {};
  },
}));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: {
    getByFilter: () => mocks.snapshot,
    subscribePatches: (cb: any) => {
      mocks.patch = cb;
      return () => {};
    },
    subscribe: (cb: any) => {
      mocks.reset = cb;
      return () => {};
    },
  },
}));
const page = Array.from({ length: 200 }, (_, n) => ({
  id: `s${n}`,
  status: 'archived',
  updatedAt: new Date(1000 - n).toISOString(),
  title: `Task ${n}`,
}));
beforeEach(() => {
  mocks.list.mockReset();
  mocks.generation = 1;
  mocks.snapshot = [];
});
afterEach(cleanup);
it('does not query collapsed archives; full pages expose continuation and stable cursor', async () => {
  mocks.list
    .mockResolvedValueOnce(page)
    .mockResolvedValueOnce([{ ...page[199], id: 'older', updatedAt: new Date(800).toISOString() }]);
  const { result, rerender } = renderHook(
    ({ enabled }) => useWorkbenchSessionPages('b', 'archived', enabled),
    { initialProps: { enabled: false } },
  );
  expect(mocks.list).not.toHaveBeenCalled();
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.rows.length).toBe(200));
  expect(result.current.hasMore).toBe(true);
  await act(() => result.current.load());
  expect(mocks.list).toHaveBeenLastCalledWith(200, 'archived', {
    fresh: true,
    before: { updatedAt: 801, id: 's199' },
  });
  expect(result.current.rows.length).toBe(201);
  expect(result.current.hasMore).toBe(false);
});
it('keeps loaded history and its cursor on query failure, then retries without duplicates', async () => {
  mocks.list
    .mockResolvedValueOnce(page)
    .mockRejectedValueOnce(new Error('unavailable'))
    .mockResolvedValueOnce([page[199]]);
  const { result } = renderHook(() => useWorkbenchSessionPages('b', 'archived', true));
  await waitFor(() => expect(result.current.rows.length).toBe(200));
  await act(() => result.current.load());
  expect(result.current.error).toBe(true);
  expect(result.current.rows.length).toBe(200);
  await act(() => result.current.load());
  expect(result.current.error).toBe(false);
  expect(result.current.rows.length).toBe(200);
});
it('drops a late query from a different account/scope', async () => {
  let resolve!: (value: any) => void;
  mocks.list
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValueOnce([]);
  const { result, rerender } = renderHook(
    ({ scope }) => useWorkbenchSessionPages(scope, 'archived', true),
    { initialProps: { scope: 'a' } },
  );
  mocks.generation++;
  rerender({ scope: 'b' });
  await act(async () => {
    resolve(page);
  });
  expect(result.current.rows).toEqual([]);
});
it('applies original session title/status patches without inferring completion', async () => {
  mocks.list.mockResolvedValueOnce([page[0]]);
  const { result } = renderHook(() => useWorkbenchSessionPages('b', 'archived', true));
  await waitFor(() => expect(result.current.rows.length).toBe(1));
  act(() => mocks.patch('s0', { title: 'New title', status: 'active' }));
  expect(result.current.rows).toEqual([]);
});

it('shares original-list archive/restore/delete mutations and keeps older pages', async () => {
  mocks.list.mockResolvedValueOnce([page[0]]);
  const { result } = renderHook(() => useWorkbenchSessionPages('b', 'archived', true));
  await waitFor(() => expect(result.current.rows).toHaveLength(1));
  const archived = { ...page[1], title: 'Archived from sidebar' };
  act(() => mocks.patch(archived.id, { status: 'archived' }, archived));
  expect(result.current.rows.map((row) => row.id)).toEqual(['s0', 's1']);
  act(() => mocks.patch('s0', { status: 'deleted' }, null));
  expect(result.current.rows.map((row) => row.id)).toEqual(['s1']);
  act(() => {
    mocks.snapshot = [];
    mocks.reset('updated');
  });
  expect(result.current.rows.map((row) => row.id)).toEqual(['s1']);
  act(() => mocks.patch('s1', { status: 'active' }, archived));
  expect(result.current.rows).toEqual([]);
});
it('reconciles missing rows across the loaded pages on refresh without reading unseen history', async () => {
  const old = { ...page[0], id: 'old', updatedAt: new Date(0).toISOString() };
  mocks.list
    .mockResolvedValueOnce(page)
    .mockResolvedValueOnce([old])
    .mockResolvedValueOnce(page)
    .mockResolvedValueOnce([]);
  const { result } = renderHook(() => useWorkbenchSessionPages('b', 'archived', true));
  await waitFor(() => expect(result.current.rows).toHaveLength(200));
  await act(() => result.current.load());
  expect(result.current.rows).toHaveLength(201);
  await act(() => mocks.refresh());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.rows).toHaveLength(200);
  expect(result.current.hasMore).toBe(false);
  expect(mocks.list).toHaveBeenCalledTimes(4);
});
it('does not resurrect a sidebar deletion when an older list response arrives', async () => {
  let resolve!: (rows: any[]) => void;
  mocks.list.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { result } = renderHook(() => useWorkbenchSessionPages('b', 'archived', true));
  act(() => {
    mocks.patch('s0', { status: 'deleted' }, null);
    mocks.patch('s0', { title: 'Late rename' }, null);
  });
  await act(async () => resolve([page[0]]));
  expect(result.current.rows).toEqual([]);
});
