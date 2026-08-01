import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@cindy/maker-core';

import {
  claimSchedulerInterruptedTurnRecovery,
  configureSchedulerInterruptedTurnRecoveryLifecycle,
  discardSchedulerInterruptedTurnSuppressedError,
  finalizeSchedulerInterruptedTurnSuppressedError,
  registerSchedulerInterruptedTurnRecovery,
  registerSchedulerInterruptedTurnResumeOutcome,
  releaseSchedulerInterruptedTurnResumeOutcome,
} from '../schedulerInterruptedTurnRecoveryBridge';

const errorEvent = {
  type: 'error',
  data: { message: 'Selected model is at capacity.', isTerminal: true },
} as AgentEvent;

describe('scheduler interrupted-turn recovery bridge', () => {
  it('lets the active Schedule waiter synchronously claim a terminal error', () => {
    const handler = vi.fn(() => true);
    const dispose = registerSchedulerInterruptedTurnRecovery('bridge-claim', handler);

    expect(claimSchedulerInterruptedTurnRecovery('bridge-claim', errorEvent)).toBe(true);
    expect(handler).toHaveBeenCalledWith(errorEvent);

    dispose();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-claim', errorEvent)).toBe(false);
  });

  it('does not let a stale disposer remove a newer run for the same session', () => {
    const disposeOld = registerSchedulerInterruptedTurnRecovery('bridge-owner', () => false);
    const next = vi.fn(() => true);
    const disposeNext = registerSchedulerInterruptedTurnRecovery('bridge-owner', next);

    disposeOld();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-owner', errorEvent)).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);

    disposeNext();
  });

  it('forwards persistence lifecycle events when the desktop host is installed', () => {
    const lifecycle = {
      registerOutcome: vi.fn(),
      releaseOutcome: vi.fn(),
      discardSuppressedError: vi.fn(),
      finalizeSuppressedError: vi.fn(),
    };
    configureSchedulerInterruptedTurnRecoveryLifecycle(lifecycle);

    registerSchedulerInterruptedTurnResumeOutcome('bridge-life', 'client-1');
    releaseSchedulerInterruptedTurnResumeOutcome('bridge-life', 'client-1');
    discardSchedulerInterruptedTurnSuppressedError('bridge-life');
    finalizeSchedulerInterruptedTurnSuppressedError('bridge-life');

    expect(lifecycle.registerOutcome).toHaveBeenCalledWith('bridge-life', 'client-1');
    expect(lifecycle.releaseOutcome).toHaveBeenCalledWith('bridge-life', 'client-1');
    expect(lifecycle.discardSuppressedError).toHaveBeenCalledWith('bridge-life');
    expect(lifecycle.finalizeSuppressedError).toHaveBeenCalledWith('bridge-life');
  });
});
