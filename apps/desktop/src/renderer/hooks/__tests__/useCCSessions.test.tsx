// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { ListStatusFilter } from '@/lib/sessionService';
import { createIpcError } from '../../../shared/ipc-errors';
import { useCCSessions } from '../useCCSessions';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), prependCreated: vi.fn(),
  cache: new Map<ListStatusFilter, Session[]>(),
  listeners: new Set<(change: 'updated' | 'reset') => void>(),
  ensureByFilter: vi.fn<(filter: ListStatusFilter) => Promise<void>>(),
}));
vi.mock('@/lib/sessionService', () => ({ create: mocks.create }));
// Remote-origin resolution is only used by patchLocal, outside this snapshot /
// creation-result suite. Do not load the remote store and transport graph here.
vi.mock('@/features/device-link/stickySessionOrigin', () => ({ getStickySessionDeviceId: () => undefined }));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: {
  getByFilter: (filter: ListStatusFilter) => mocks.cache.get(filter) ?? null,
  subscribe: (listener: (change: 'updated' | 'reset') => void) => {
    mocks.listeners.add(listener);
    return () => { mocks.listeners.delete(listener); };
  },
  ensureByFilter: mocks.ensureByFilter,
  prependCreated: mocks.prependCreated,
} }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockReset();
  mocks.cache.clear();
  mocks.cache.set('active', []);
  mocks.listeners.clear();
  mocks.ensureByFilter.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

function publish(change: 'updated' | 'reset' = 'updated') {
  mocks.listeners.forEach((listener) => listener(change));
}

// P03: a warm mount committed the same session snapshot twice, re-rendering its
// consumers without new data. Existing creation tests do not cover snapshot timing.
// Exercise the real hook with a stable cached array; preserve changed snapshots,
// filter identity, cold loading and reset/error transitions. Tier: component/unit.
// Standalone: 3.80 s Vitest / 5.63 s including pnpm; test body 32 ms. Launcher,
// setup and module collection exceed the 5 s target; no real waits or module resets.
describe('useCCSessions snapshot publication', () => {
  it('commits a warm snapshot once while still subscribing to later changes', () => {
    const cached = [{ id: 'warm' }] as Session[];
    mocks.cache.set('active', cached);
    const committed = vi.fn();
    const { result, unmount } = renderHook(() => {
      const value = useCCSessions();
      useLayoutEffect(() => { committed(value.sessions); });
      return value;
    });
    expect(result.current.sessions).toBe(cached);
    expect(result.current.isLoading).toBe(false);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(mocks.ensureByFilter).not.toHaveBeenCalled();
    const changed = [{ id: 'updated' }] as Session[];
    act(() => {
      mocks.cache.set('active', changed);
      publish();
    });
    expect(result.current.sessions).toBe(changed);
    expect(committed).toHaveBeenCalledTimes(2);
    unmount();
    expect(mocks.listeners.size).toBe(0);
  });

  it('adopts a snapshot changed after render but before the subscription effect', () => {
    const initial = [{ id: 'before-commit' }] as Session[];
    const changed = [{ id: 'during-commit' }] as Session[];
    mocks.cache.set('active', initial);
    const { result } = renderHook(() => {
      const value = useCCSessions();
      useLayoutEffect(() => { mocks.cache.set('active', changed); }, []);
      return value;
    });
    expect(result.current.sessions).toBe(changed);
    expect(result.current.effectiveIncludeArchived).toBe('active');
    expect(result.current.isLoading).toBe(false);
    expect(mocks.ensureByFilter).not.toHaveBeenCalled();
  });

  it('switches the effective filter and clears an error even when buckets share an array', async () => {
    const shared = [{ id: 'shared' }] as Session[];
    mocks.cache.set('active', shared);
    mocks.cache.set('all', shared);
    const { result, rerender } = renderHook(
      ({ filter }: { filter: ListStatusFilter }) => useCCSessions({ includeArchived: filter }),
      { initialProps: { filter: 'active' } },
    );
    mocks.create.mockRejectedValueOnce(new Error('Create failed'));
    await act(async () => { await result.current.createSession(); });
    expect(result.current.error?.message).toBe('Create failed');
    rerender({ filter: 'all' });
    expect(result.current.sessions).toBe(shared);
    expect(result.current.effectiveIncludeArchived).toBe('all');
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(mocks.ensureByFilter).not.toHaveBeenCalled();
  });

  it.each([false, true])('loads a cold bucket with the prior snapshot preserved when warm=%s', async (warm) => {
    const previous = [{ id: 'previous' }] as Session[];
    mocks.cache.set('active', previous);
    const { result, rerender } = renderHook(
      ({ filter }: { filter: ListStatusFilter }) => useCCSessions({ includeArchived: filter }),
      { initialProps: { filter: warm ? 'active' : 'archived' } },
    );
    if (warm) rerender({ filter: 'archived' });
    expect(result.current.sessions).toEqual(warm ? previous : []);
    expect(result.current.effectiveIncludeArchived).toBe(warm ? 'active' : 'archived');
    expect(result.current.isLoading).toBe(!warm);
    expect(mocks.ensureByFilter).toHaveBeenCalledExactlyOnceWith('archived');
    const loaded = [{ id: 'loaded' }] as Session[];
    await act(async () => {
      mocks.cache.set('archived', loaded);
      publish();
    });
    expect(result.current.sessions).toBe(loaded);
    expect(result.current.effectiveIncludeArchived).toBe('archived');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('clears a reset snapshot, reports a failed reload and accepts later data', async () => {
    mocks.cache.set('active', [{ id: 'previous-owner' }] as Session[]);
    const { result } = renderHook(() => useCCSessions());
    mocks.ensureByFilter.mockRejectedValueOnce(new Error('Reload failed'));
    act(() => {
      mocks.cache.clear();
      publish('reset');
    });
    expect(result.current.sessions).toEqual([]);
    expect(result.current.isLoading).toBe(true);
    expect(mocks.ensureByFilter).toHaveBeenCalledExactlyOnceWith('active');
    await act(async () => undefined);
    expect(result.current.error?.message).toBe('Reload failed');
    expect(result.current.isLoading).toBe(false);
    const current = [{ id: 'current-owner' }] as Session[];
    act(() => {
      mocks.cache.set('active', current);
      publish();
    });
    expect(result.current.sessions).toBe(current);
    expect(result.current.error).toBeNull();
  });

  it('clears a cold-bucket error when returning to the same warm snapshot', async () => {
    const cached = [{ id: 'warm' }] as Session[];
    mocks.cache.set('active', cached);
    const { result, rerender } = renderHook(
      ({ filter }: { filter: ListStatusFilter }) => useCCSessions({ includeArchived: filter }),
      { initialProps: { filter: 'active' } },
    );
    mocks.ensureByFilter.mockRejectedValueOnce(new Error('Archived unavailable'));
    await act(async () => { rerender({ filter: 'archived' }); });
    expect(result.current.sessions).toBe(cached);
    expect(result.current.effectiveIncludeArchived).toBe('active');
    expect(result.current.error?.message).toBe('Archived unavailable');
    rerender({ filter: 'active' });
    expect(result.current.sessions).toBe(cached);
    expect(result.current.effectiveIncludeArchived).toBe('active');
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(mocks.ensureByFilter).toHaveBeenCalledExactlyOnceWith('archived');
  });
});

// #7395: the real hook must report the current create error before state commits.
// Existing submission tests inject createSession and cannot observe this boundary.
// A separate jsdom file is needed because the recovery controller suite is pure node.
// Minimal input: two failed creates in one React batch. Tier: component/unit.
describe('useCCSessions creation result compatibility', () => {
  it('reports each invocation error synchronously without waiting for a React render', async () => {
    const first = createIpcError('WRITABLE_DIRECTORY_AUTHORIZATION_REQUIRED', 'Picker proof required');
    const second = createIpcError('WRITABLE_DIRECTORY_UNAVAILABLE', 'Directory unavailable');
    mocks.create.mockRejectedValueOnce(first).mockRejectedValueOnce(second);
    const { result } = renderHook(() => useCCSessions());
    const observed: unknown[] = [];
    await act(async () => {
      expect(await result.current.createSession({}, (error) => observed.push(error))).toBeNull();
      expect(observed).toEqual([first]);
      expect(await result.current.createSession({}, (error) => observed.push(error))).toBeNull();
      expect(observed).toEqual([first, second]);
    });
    expect(mocks.prependCreated).not.toHaveBeenCalled();
  });

  it('keeps the legacy null result when the caller does not request an error callback', async () => {
    mocks.create.mockRejectedValueOnce(new Error('Storage failure'));
    const { result } = renderHook(() => useCCSessions());
    await act(async () => { expect(await result.current.createSession()).toBeNull(); });
    expect(result.current.error?.message).toBe('Storage failure');
    expect(mocks.prependCreated).not.toHaveBeenCalled();
  });

  it('returns and publishes the created session once without calling the failure handler', async () => {
    const session = { id: 'created-session' };
    mocks.create.mockResolvedValueOnce(session);
    const failed = vi.fn();
    const { result } = renderHook(() => useCCSessions());
    await act(async () => { expect(await result.current.createSession({}, failed)).toBe(session); });
    expect(mocks.prependCreated).toHaveBeenCalledExactlyOnceWith(session);
    expect(failed).not.toHaveBeenCalled();
  });
});
