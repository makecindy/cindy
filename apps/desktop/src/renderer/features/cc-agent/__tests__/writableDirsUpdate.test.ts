// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  applyDirectoryGrantUpdate,
  createWritableDirRemovalQueue,
} from '../CCAgentSessionView';

describe('applyDirectoryGrantUpdate', () => {
  it('refreshes the Main-validated subset without a second renderer persistence write', async () => {
    const refresh = vi.fn(async () => undefined);

    await expect(applyDirectoryGrantUpdate({
      next: ['/workspace', '/rejected'],
      previous: ['/workspace'],
      activate: vi.fn(async () => ['/workspace']),
      refresh,
    })).resolves.toEqual(['/workspace']);

    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps the previous UI truth when Main returns no validated subset', async () => {
    const refresh = vi.fn(async () => undefined);

    await expect(applyDirectoryGrantUpdate({
      next: ['/reference'],
      previous: ['/previous'],
      activate: vi.fn(async () => undefined),
      refresh,
    })).resolves.toEqual(['/previous']);

    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('createWritableDirRemovalQueue', () => {
  it('serializes rapid removals against the latest accepted grant set', async () => {
    const queue = createWritableDirRemovalQueue();
    const order: string[] = [];
    let runtime = ['/output/a', '/output/b'];
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

    expect(order).toEqual(['activate:/output/b', 'activate:']);
    expect(runtime).toEqual([]);
  });

  it('continues from the last accepted grants when an earlier Main transaction fails', async () => {
    const queue = createWritableDirRemovalQueue();
    let runtime = ['/output/a', '/output/b'];
    let activationCount = 0;
    const apply = (next: string[], previous: string[]) =>
      applyDirectoryGrantUpdate({
        next,
        previous,
        activate: async (dirs) => {
          activationCount += 1;
          if (activationCount === 1) throw new Error('database unavailable');
          runtime = [...dirs];
          return dirs;
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
    expect(runtime).toEqual(['/output/a']);
  });
});
