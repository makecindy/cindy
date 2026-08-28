// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { applyDirectoryGrantUpdate } from '../CCAgentSessionView';

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
