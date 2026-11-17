import { describe, expect, it, vi } from 'vitest';
import {
  controlOwnedSessionExecution,
  isSameSessionExecution,
  withdrawOwnedSessionInputs,
  stopOwnedSessionInput,
} from '../sessionExecutionOwnership.js';

describe('ordinary Session execution ownership', () => {
  // Group stops identify one input: withdraw its queued retry, stop its active
  // turn, and preserve an owner's later turn even if it starts while the lock waits.
  it.each(['owned', 'other', 'replaced'] as const)('cancels only the requested input with %s active', async state => {
    let active = state === 'other' ? 'user-next' : 'group-input';
    const remove = vi.fn(), stopTurn = vi.fn(async () => {}), flush = vi.fn(async () => {});
    await stopOwnedSessionInput({ sessionId: 's', owns: id => id === 'group-input', flush,
      queue: {
        ensureQueueRestored: async () => {},
        getQueueControlSnapshot: () => ({ pendingQueue: [{ clientId: 'retry', retrySourceClientId: 'group-input' }, { clientId: 'user-queued' }] }),
        remove,
      },
      activeInput: () => ({ clientId: active }),
      withSessionLock: async (_, action) => { if (state === 'replaced') active = 'user-next'; await action(); },
      stopTurn,
    });
    expect(remove.mock.calls).toEqual([['s', 'retry']]);
    expect(stopTurn).toHaveBeenCalledTimes(state === 'owned' ? 1 : 0);
    expect(flush).toHaveBeenCalledWith('s');
  });

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
