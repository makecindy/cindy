import { describe, expect, it, vi } from 'vitest';

import { applyRuntimeSelectionAxesWithRecovery } from '../runtimeSelectionAxes.js';

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
