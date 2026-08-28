// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import { applyWritableDirsUpdate } from '../CCAgentSessionView';

describe('applyWritableDirsUpdate', () => {
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

    await expect(applyWritableDirsUpdate({
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

    await expect(applyWritableDirsUpdate({
      next: ['/workspace', '/rejected'],
      previous: ['/workspace'],
      activate: vi.fn(async () => ['/workspace']),
      persist,
      refresh,
    })).resolves.toEqual(['/workspace']);

    expect(persist).toHaveBeenCalledWith(['/workspace']);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
