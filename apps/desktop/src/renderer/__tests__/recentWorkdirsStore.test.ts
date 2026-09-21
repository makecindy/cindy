import { afterEach, describe, expect, it, vi } from 'vitest';

describe('recentWorkdirsStore changed push', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('refreshes the cached activity immediately after a main-process touch broadcast', async () => {
    let rows = [
      {
        path: 'D:/Work/Project-A',
        lastUsedAt: '2026-08-10T00:00:00.000Z',
        exists: true,
      },
    ];
    let onChanged: ((payload: unknown, ownerStamp?: unknown) => void) | undefined;
    const list = vi.fn(async () => rows);
    vi.stubGlobal('window', {
      electronAPI: {
        localDb: {
          recentWorkdirs: {
            list,
            remove: vi.fn(),
            onChanged: (callback: typeof onChanged) => {
              onChanged = callback;
              return () => {};
            },
          },
        },
      },
    });

    const { recentWorkdirsStore } = await import('@/lib/recentWorkdirsStore');
    await recentWorkdirsStore.ensure();
    expect(recentWorkdirsStore.get()?.[0]?.lastUsedAt).toBe('2026-08-10T00:00:00.000Z');

    rows = [
      {
        path: 'D:/Work/Project-A',
        lastUsedAt: '2026-08-12T12:00:00.000Z',
        exists: true,
      },
    ];
    onChanged?.({ path: 'D:/Work/Project-A' });

    await vi.waitFor(() => {
      expect(recentWorkdirsStore.get()?.[0]?.lastUsedAt).toBe('2026-08-12T12:00:00.000Z');
    });
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('clears the previous owner cache and fences a late in-flight response', async () => {
    const pending: Array<{
      resolve: (rows: Array<{ path: string; lastUsedAt: string; exists: boolean }>) => void;
    }> = [];
    const list = vi.fn(
      () =>
        new Promise<Array<{ path: string; lastUsedAt: string; exists: boolean }>>((resolve) => {
          pending.push({ resolve });
        }),
    );
    vi.stubGlobal('window', {
      electronAPI: {
        localDb: {
          recentWorkdirs: {
            list,
            remove: vi.fn(),
            onChanged: () => () => {},
          },
        },
      },
    });

    const { recentWorkdirsStore } = await import('@/lib/recentWorkdirsStore');
    recentWorkdirsStore.setDataOwner({ dataOwnerId: 'owner-a', generation: 1 });
    const ownerAInitialRequest = recentWorkdirsStore.ensure();
    expect(list).toHaveBeenCalledTimes(1);
    pending[0]!.resolve([
      { path: '/owner-a/cached', lastUsedAt: '2026-08-12T00:00:00.000Z', exists: true },
    ]);
    await ownerAInitialRequest;
    expect(recentWorkdirsStore.get()?.map((entry) => entry.path)).toEqual([
      '/owner-a/cached',
    ]);

    const ownerARefresh = recentWorkdirsStore.forceRefresh();
    expect(list).toHaveBeenCalledTimes(2);

    recentWorkdirsStore.setDataOwner({ dataOwnerId: 'owner-b', generation: 2 });
    expect(recentWorkdirsStore.get()).toBeNull();
    const ownerBRequest = recentWorkdirsStore.ensure();
    expect(list).toHaveBeenCalledTimes(3);

    pending[2]!.resolve([
      { path: '/owner-b/project', lastUsedAt: '2026-08-13T00:00:00.000Z', exists: true },
    ]);
    await ownerBRequest;
    expect(recentWorkdirsStore.get()?.map((entry) => entry.path)).toEqual([
      '/owner-b/project',
    ]);

    pending[1]!.resolve([
      { path: '/owner-a/project', lastUsedAt: '2026-08-12T00:00:00.000Z', exists: true },
    ]);
    await ownerARefresh;
    expect(recentWorkdirsStore.get()?.map((entry) => entry.path)).toEqual([
      '/owner-b/project',
    ]);
  });
});
