import { describe, expect, it, vi } from 'vitest';
import {
  controlOwnedSessionExecution,
  isSameSessionExecution,
  withdrawOwnedSessionInputs,
} from '../sessionExecutionOwnership.js';

describe('ordinary Session execution ownership', () => {
  it('requires both instance and generation', () => {
    expect(
      isSameSessionExecution(
        { instanceId: 'a', generation: 1 },
        { instanceId: 'b', generation: 1 },
      ),
    ).toBe(false);
    expect(
      isSameSessionExecution(
        { instanceId: 'a', generation: 2 },
        { instanceId: 'a', generation: 1 },
      ),
    ).toBe(false);
    expect(isSameSessionExecution(null, null)).toBe(false);
  });
  it('rechecks after acquiring the restart lock', async () => {
    let owned = true;
    const operation = vi.fn();
    expect(
      await controlOwnedSessionExecution({
        sessionId: 's',
        matches: () => owned,
        withSessionLock: async (_, fn) => {
          owned = false;
          await fn();
        },
        operation,
      }),
    ).toBe(false);
    expect(operation).not.toHaveBeenCalled();
  });
  it('restores cold queues and only withdraws owned inputs and recovery aliases', async () => {
    const remove = vi.fn();
    const flush = vi.fn();
    let restored = false;
    await withdrawOwnedSessionInputs({
      sessionId: 's',
      owns: (id) => id === 'owned',
      flush,
      queue: {
        ensureQueueRestored: async () => {
          restored = true;
        },
        getQueueControlSnapshot: () => {
          expect(restored).toBe(true);
          return {
            pendingQueue: [
              { clientId: 'user' },
              { clientId: 'retry', retrySourceClientId: 'owned' },
              { clientId: 'clone', supersedesUserClientId: 'owned' },
              { clientId: 'owned-other' },
            ],
          };
        },
        remove,
      },
    });
    expect(remove.mock.calls).toEqual([
      ['s', 'retry'],
      ['s', 'clone'],
    ]);
    expect(flush).toHaveBeenCalledWith('s');
  });
});
