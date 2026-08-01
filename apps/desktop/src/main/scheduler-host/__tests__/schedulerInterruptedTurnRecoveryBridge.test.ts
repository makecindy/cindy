import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@cindy/maker-core';

import {
  claimSchedulerInterruptedTurnRecovery,
  configureSchedulerInterruptedTurnRecoveryLifecycle,
  discardSchedulerInterruptedTurnSuppressedError,
  finalizeSchedulerInterruptedTurnSuppressedError,
  registerSchedulerInterruptedTurnRecovery,
  registerSchedulerInterruptedTurnResumeOutcome,
  resetSchedulerInterruptedTurnRecovery,
  releaseSchedulerInterruptedTurnResumeOutcome,
} from '../schedulerInterruptedTurnRecoveryBridge';

const errorEvent = {
  type: 'error',
  data: { message: 'Selected model is at capacity.', isTerminal: true },
} as AgentEvent;

describe('scheduler interrupted-turn recovery bridge', () => {
  it('lets the active Schedule waiter synchronously claim a terminal error', () => {
    const handler = vi.fn(() => true);
    const dispose = registerSchedulerInterruptedTurnRecovery(
      'bridge-claim', 'run-1', handler, vi.fn(),
    );

    expect(claimSchedulerInterruptedTurnRecovery('bridge-claim', errorEvent)).toBe(true);
    expect(handler).toHaveBeenCalledWith(errorEvent);

    dispose();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-claim', errorEvent)).toBe(false);
  });

  it('does not let a stale disposer remove a newer run for the same session', () => {
    const disposeOld = registerSchedulerInterruptedTurnRecovery(
      'bridge-owner', 'same-run', () => false, vi.fn(),
    );
    const next = vi.fn(() => true);
    const disposeNext = registerSchedulerInterruptedTurnRecovery(
      'bridge-owner', 'same-run', next, vi.fn(),
    );

    disposeOld();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-owner', errorEvent)).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);

    disposeNext();
  });

  it('routes concurrent terminal events only to the matching Schedule run', () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const disposeFirst = registerSchedulerInterruptedTurnRecovery(
      'bridge-concurrent', 'run-first', first, vi.fn(),
    );
    const disposeSecond = registerSchedulerInterruptedTurnRecovery(
      'bridge-concurrent', 'run-second', second, vi.fn(),
    );
    const firstEvent = {
      ...errorEvent,
      turnOrigin: { kind: 'scheduler', runId: 'run-first' },
    } as AgentEvent;
    const unknownEvent = {
      ...errorEvent,
      turnOrigin: { kind: 'scheduler', runId: 'run-missing' },
    } as AgentEvent;

    expect(claimSchedulerInterruptedTurnRecovery('bridge-concurrent', firstEvent)).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-concurrent', unknownEvent)).toBe(false);
    expect(claimSchedulerInterruptedTurnRecovery('bridge-concurrent', errorEvent)).toBe(false);

    disposeFirst();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-concurrent', errorEvent)).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
    disposeSecond();
  });

  it('fans session resets out to every registered run and removes their ownership', () => {
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    registerSchedulerInterruptedTurnRecovery('bridge-reset', 'run-first', first, firstReset);
    registerSchedulerInterruptedTurnRecovery('bridge-reset', 'run-second', second, secondReset);

    resetSchedulerInterruptedTurnRecovery('bridge-reset', 'session-reset');

    expect(firstReset).toHaveBeenCalledWith('session-reset');
    expect(secondReset).toHaveBeenCalledWith('session-reset');
    expect(claimSchedulerInterruptedTurnRecovery('bridge-reset', errorEvent)).toBe(false);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
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
