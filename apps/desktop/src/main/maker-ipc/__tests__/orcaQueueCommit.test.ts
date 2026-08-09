import { describe, expect, it, vi } from 'vitest';

import { commitQueuedMessageAfterOrcaFence } from '../orcaQueueCommit.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('commitQueuedMessageAfterOrcaFence', () => {
  it.each([
    ['dormant queue', 'prepare'],
    ['live queue', 'prepare'],
    ['SESSION_RUNNING recovery', 'restore'],
    ['rehydrate recovery', 'restore'],
    ['scheduler queue', 'restore'],
  ] as const)(
    'does not enqueue or accept %s after a fence during %s',
    async (_entryPoint, blockedAt) => {
      let fenced = false;
      const accepted = vi.fn();
      const enqueue = vi.fn();
      const prepareGate = deferred<{ clientId: string }>();
      const restoreGate = deferred<void>();
      const commit = commitQueuedMessageAfterOrcaFence({
        targetSessionId: 'worker-session',
        prepare: async () => {
          if (blockedAt === 'prepare') await prepareGate.promise;
          return { clientId: 'client-1' };
        },
        restoreQueue: async () => {
          if (blockedAt === 'restore') await restoreGate.promise;
        },
        isFenced: () => fenced,
        registerAccepted: accepted,
        enqueue,
      });

      if (blockedAt === 'prepare') {
        fenced = true;
        prepareGate.resolve({ clientId: 'client-1' });
      } else {
        fenced = true;
        restoreGate.resolve();
      }

      await expect(commit).resolves.toBe('fenced');
      expect(enqueue).not.toHaveBeenCalled();
      expect(accepted).not.toHaveBeenCalled();
    },
  );

  it('enqueues and registers accepted only when the final fence check is clear', async () => {
    const accepted = vi.fn();
    const enqueue = vi.fn();

    await expect(
      commitQueuedMessageAfterOrcaFence({
        targetSessionId: 'worker-session',
        prepare: async () => ({ clientId: 'client-1' }),
        restoreQueue: async () => undefined,
        isFenced: () => false,
        registerAccepted: accepted,
        enqueue,
      }),
    ).resolves.toBe('enqueued');

    expect(accepted).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith('worker-session', { clientId: 'client-1' });
  });
});
