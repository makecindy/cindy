// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  applyDirectoryGrantUpdate,
  createWritableDirRemovalQueue,
} from '../CCAgentSessionView';

describe('applyDirectoryGrantUpdate', () => {
  it('rolls runtime grants back and refreshes when local persistence fails', async () => {
    const previous = ['/workspace'];
    const next = ['/workspace', '/output'];
    let runtime = previous;
    const order: string[] = [];
    const persistError = new Error('database unavailable');
    const activate = vi.fn(async (dirs: string[]) => {
      runtime = dirs;
      order.push(`activate:${dirs.join(',')}`);
      return dirs;
    });
    const persist = vi.fn(async () => {
      order.push('persist');
      throw persistError;
    });
    const refresh = vi.fn(async () => {
      order.push('refresh');
    });

    await expect(applyDirectoryGrantUpdate({
      next,
      previous,
      activate,
      persist,
      refresh,
    })).rejects.toBe(persistError);

    expect(runtime).toEqual(previous);
    expect(order).toEqual([
      'activate:/workspace,/output',
      'persist',
      'activate:/workspace',
      'refresh',
    ]);
  });

  it('persists the runtime-validated subset and refreshes after success', async () => {
    const persist = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);

    await expect(applyDirectoryGrantUpdate({
      next: ['/workspace', '/rejected'],
      previous: ['/workspace'],
      activate: vi.fn(async () => ['/workspace']),
      persist,
      refresh,
    })).resolves.toEqual(['/workspace']);

    expect(persist).toHaveBeenCalledWith(['/workspace']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not persist an unverified request when the runtime returns no subset', async () => {
    const persist = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => undefined);

    await expect(applyDirectoryGrantUpdate({
      next: ['/reference'],
      previous: ['/previous'],
      activate: vi.fn(async () => undefined),
      persist,
      refresh,
    })).resolves.toEqual(['/previous']);

    expect(persist).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'adds a grant',
      previous: ['/reference-a'],
      next: ['/reference-a', '/reference-b'],
      accepted: ['/reference-a', '/reference-b'],
    },
    {
      name: 'replaces grants',
      previous: ['/reference-a'],
      next: ['/reference-b'],
      accepted: ['/reference-b'],
    },
    {
      name: 'persists the conflict-filtered subset',
      previous: ['/reference-a'],
      next: ['/reference-a', '/shared/specs'],
      accepted: ['/reference-a'],
    },
  ])('$name as the runtime, SQLite, and UI source of truth', async ({ previous, next, accepted }) => {
    let runtime = previous;
    let stored = previous;
    let ui = previous;

    await applyDirectoryGrantUpdate({
      next,
      previous,
      activate: vi.fn(async () => {
        runtime = accepted;
        return accepted;
      }),
      persist: vi.fn(async (dirs) => {
        stored = dirs;
      }),
      refresh: vi.fn(async () => {
        ui = stored;
      }),
    });

    expect({ runtime, stored, ui }).toEqual({
      runtime: accepted,
      stored: accepted,
      ui: accepted,
    });
  });

  it('keeps the writable grant after restart when a nested read-only grant is filtered out', async () => {
    const database = {
      extraDirs: [] as string[],
      writableDirs: ['/shared'],
    };

    await applyDirectoryGrantUpdate({
      next: ['/shared/specs'],
      previous: database.extraDirs,
      activate: vi.fn(async () => []),
      persist: vi.fn(async (dirs) => {
        database.extraDirs = dirs;
      }),
      refresh: vi.fn(async () => undefined),
    });

    // A restarted session reads the persisted columns directly. The rejected
    // read-only child must not reappear and displace the writable parent.
    expect(database).toEqual({
      extraDirs: [],
      writableDirs: ['/shared'],
    });
  });
});

describe('createWritableDirRemovalQueue', () => {
  it('serializes rapid removals against the latest accepted grant set', async () => {
    const queue = createWritableDirRemovalQueue();
    const order: string[] = [];
    let runtime = ['/output/a', '/output/b'];
    let stored = [...runtime];
    let releaseFirstActivation: (() => void) | undefined;
    const firstActivation = new Promise<void>((resolve) => {
      releaseFirstActivation = resolve;
    });
    let activationCount = 0;

    const apply = (next: string[], previous: string[]) =>
      applyDirectoryGrantUpdate({
        next,
        previous,
        activate: async (dirs) => {
          activationCount += 1;
          order.push(`activate:${dirs.join(',')}`);
          if (activationCount === 1) await firstActivation;
          runtime = [...dirs];
          return dirs;
        },
        persist: async (dirs) => {
          order.push(`persist:${dirs.join(',')}`);
          stored = [...dirs];
        },
        refresh: async () => undefined,
      });

    const removeA = queue.remove({
      sessionId: 'session-1',
      path: '/output/a',
      observed: ['/output/a', '/output/b'],
      apply,
    });
    const removeB = queue.remove({
      sessionId: 'session-1',
      path: '/output/b',
      observed: ['/output/a', '/output/b'],
      apply,
    });

    await vi.waitFor(() => expect(order).toEqual(['activate:/output/b']));
    expect(activationCount).toBe(1);
    releaseFirstActivation?.();
    await expect(Promise.all([removeA, removeB])).resolves.toEqual([['/output/b'], []]);

    expect(order).toEqual(['activate:/output/b', 'persist:/output/b', 'activate:', 'persist:']);
    expect({ runtime, stored }).toEqual({ runtime: [], stored: [] });
  });

  it('continues from the rolled-back grants when an earlier persistence fails', async () => {
    const queue = createWritableDirRemovalQueue();
    let runtime = ['/output/a', '/output/b'];
    let stored = [...runtime];
    let persistCount = 0;
    const apply = (next: string[], previous: string[]) =>
      applyDirectoryGrantUpdate({
        next,
        previous,
        activate: async (dirs) => {
          runtime = [...dirs];
          return dirs;
        },
        persist: async (dirs) => {
          persistCount += 1;
          if (persistCount === 1) throw new Error('database unavailable');
          stored = [...dirs];
        },
        refresh: async () => undefined,
      });

    const removeA = queue.remove({
      sessionId: 'session-1',
      path: '/output/a',
      observed: ['/output/a', '/output/b'],
      apply,
    });
    const removeB = queue.remove({
      sessionId: 'session-1',
      path: '/output/b',
      observed: ['/output/a', '/output/b'],
      apply,
    });

    await expect(removeA).rejects.toThrow('database unavailable');
    await expect(removeB).resolves.toEqual(['/output/a']);
    expect({ runtime, stored }).toEqual({
      runtime: ['/output/a'],
      stored: ['/output/a'],
    });
  });
});
