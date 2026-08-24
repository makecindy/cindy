import { describe, expect, it, vi } from 'vitest';

import {
  applyRuntimeSelectionAxesWithRecovery,
  commitRuntimeAxisAfterPersistence,
} from '../runtimeSelectionAxes.js';

describe('applyRuntimeSelectionAxesWithRecovery', () => {
  it('commits the control stores only after every live axis succeeds', async () => {
    const order: string[] = [];
    await applyRuntimeSelectionAxesWithRecovery({
      session: {
        agentKind: 'codex',
        setEffort: vi.fn(async () => {
          order.push('effort');
        }),
        setFastMode: vi.fn(async () => {
          order.push('fast');
        }),
      },
      effort: 'high',
      fastMode: true,
      commitControlStores: () => order.push('commit'),
      restoreControlStores: () => order.push('restore'),
      terminateSession: vi.fn(async () => {
        order.push('terminate');
      }),
    });

    expect(order).toEqual(['effort', 'fast', 'commit']);
  });

  it('retires a live session before committing a fixed-effort profile', async () => {
    const order: string[] = [];
    const setEffort = vi.fn(async () => {
      order.push('effort');
    });
    const setFastMode = vi.fn(async () => {
      order.push('fast');
    });
    const restoreControlStores = vi.fn(() => order.push('restore'));

    await applyRuntimeSelectionAxesWithRecovery({
      session: {
        agentKind: 'codex',
        setEffort,
        setFastMode,
      },
      effort: null,
      fastMode: true,
      commitControlStores: () => order.push('commit'),
      restoreControlStores,
      terminateSession: vi.fn(async () => {
        order.push('terminate');
      }),
    });

    expect(order).toEqual(['terminate', 'commit']);
    expect(setEffort).not.toHaveBeenCalled();
    expect(setFastMode).not.toHaveBeenCalled();
    expect(restoreControlStores).not.toHaveBeenCalled();
  });

  it('restores the old stores when a fixed-effort session cannot be retired', async () => {
    const terminationError = new Error('close rejected');
    const commitControlStores = vi.fn();
    const restoreControlStores = vi.fn();
    const recoverLiveProfileAfterTerminationFailure = vi.fn();

    await expect(
      applyRuntimeSelectionAxesWithRecovery({
        session: {
          agentKind: 'claude-code',
          setEffort: vi.fn(),
          setFastMode: vi.fn(),
        },
        effort: null,
        fastMode: false,
        commitControlStores,
        restoreControlStores,
        recoverLiveProfileAfterTerminationFailure,
        terminateSession: vi.fn(async () => {
          throw terminationError;
        }),
      }),
    ).rejects.toBe(terminationError);

    expect(restoreControlStores).toHaveBeenCalledOnce();
    expect(recoverLiveProfileAfterTerminationFailure).toHaveBeenCalledOnce();
    expect(commitControlStores).not.toHaveBeenCalled();
  });

  it('commits an axis only after persistence succeeds', async () => {
    const order: string[] = [];
    await commitRuntimeAxisAfterPersistence({
      persist: async () => {
        order.push('persist');
      },
      commit: () => order.push('commit'),
    });
    expect(order).toEqual(['persist', 'commit']);
  });

  it('recovers the live axis without committing when persistence fails', async () => {
    const persistenceError = new Error('sqlite rejected');
    const order: string[] = [];
    await expect(
      commitRuntimeAxisAfterPersistence({
        persist: async () => {
          order.push('persist');
          throw persistenceError;
        },
        commit: () => order.push('commit'),
        recoverAfterPersistenceFailure: async () => {
          order.push('recover');
        },
      }),
    ).rejects.toBe(persistenceError);
    expect(order).toEqual(['persist', 'recover']);
  });

  it('restores the old stores and retires a partially-mutated session on axis failure', async () => {
    const order: string[] = [];
    const axisError = new Error('fast transport disconnected');
    const commitControlStores = vi.fn(() => order.push('commit'));

    await expect(
      applyRuntimeSelectionAxesWithRecovery({
        session: {
          agentKind: 'codex',
          setEffort: vi.fn(async () => {
            order.push('effort');
          }),
          setFastMode: vi.fn(async () => {
            order.push('fast');
            throw axisError;
          }),
        },
        effort: 'xhigh',
        fastMode: true,
        commitControlStores,
        restoreControlStores: () => order.push('restore'),
        terminateSession: vi.fn(async () => {
          order.push('terminate');
        }),
      }),
    ).rejects.toBe(axisError);

    expect(order).toEqual(['effort', 'fast', 'restore', 'terminate']);
    expect(commitControlStores).not.toHaveBeenCalled();
  });

  it('reports both failures when the partially-mutated session cannot be retired', async () => {
    const axisError = new Error('effort rejected');
    const terminationError = new Error('close rejected');
    const result = applyRuntimeSelectionAxesWithRecovery({
      session: {
        agentKind: 'claude-code',
        setEffort: vi.fn(async () => {
          throw axisError;
        }),
        setFastMode: vi.fn(async () => undefined),
      },
      effort: 'high',
      fastMode: false,
      commitControlStores: vi.fn(),
      restoreControlStores: vi.fn(),
      terminateSession: vi.fn(async () => {
        throw terminationError;
      }),
    });

    await expect(result).rejects.toMatchObject({
      name: 'AggregateError',
      errors: [axisError, terminationError],
    });
  });
});
