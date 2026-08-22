import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetInputDeviceActionsForTests,
  bindInputDeviceApprovalActionToTarget,
  createVisibleInputDeviceApprovalTarget,
  dispatchInputDeviceAction,
  subscribeInputDeviceAction,
} from '../inputDeviceActions';

describe('inputDeviceActions', () => {
  afterEach(() => {
    __resetInputDeviceActionsForTests();
  });

  it('lets the newest subscriber consume a command first', () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => true);
    subscribeInputDeviceAction(older);
    subscribeInputDeviceAction(newer);

    dispatchInputDeviceAction({ type: 'command', commandId: 'forkTask' });

    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
  });

  it('continues to older subscribers when the newer one declines', () => {
    const older = vi.fn(() => true);
    const newer = vi.fn(() => false);
    subscribeInputDeviceAction(older);
    subscribeInputDeviceAction(newer);

    dispatchInputDeviceAction({ type: 'command', commandId: 'copyConversationMarkdown' });

    expect(newer).toHaveBeenCalledOnce();
    expect(older).toHaveBeenCalledOnce();
  });

  it('does not rebind a delayed approval action from replaced permission A to B', () => {
    const replacementB = {
      kind: 'permission' as const,
      requestId: 'permission-b',
      observedAtMs: 200,
    };

    for (const commandId of ['approval.approve', 'approval.decline'] as const) {
      const lateActionForA = {
        type: 'command' as const,
        commandId,
        issuedAtMs: 100,
      };
      expect(bindInputDeviceApprovalActionToTarget(lateActionForA, replacementB)).toBeNull();
      expect(
        bindInputDeviceApprovalActionToTarget(
          { ...lateActionForA, issuedAtMs: replacementB.observedAtMs },
          replacementB,
        ),
      ).toBeNull();
      expect(
        bindInputDeviceApprovalActionToTarget({ ...lateActionForA, issuedAtMs: 201 }, replacementB),
      ).toBe(replacementB);
    }
  });

  it('binds approval to the card the task view actually displays', () => {
    expect(createVisibleInputDeviceApprovalTarget('permission-a', 'plan-b', 300)).toEqual({
      kind: 'plan_review',
      requestId: 'plan-b',
      observedAtMs: 300,
    });
    expect(createVisibleInputDeviceApprovalTarget('permission-a', null, 301)).toEqual({
      kind: 'permission',
      requestId: 'permission-a',
      observedAtMs: 301,
    });
  });
});
