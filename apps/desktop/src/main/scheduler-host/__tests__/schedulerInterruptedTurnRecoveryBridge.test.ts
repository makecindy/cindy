import { describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '@cindy/maker-core';

import {
  claimSchedulerInterruptedTurnRecovery,
  configureSchedulerInterruptedTurnRecoveryLifecycle,
  discardSchedulerInterruptedTurnSuppressedError,
  finalizeSchedulerInterruptedTurnSuppressedError,
  isSchedulerInterruptedTurnRecoverySessionReserved,
  isSchedulerInterruptedTurnEventOwnedBy,
  registerSchedulerInterruptedTurnRecovery,
  registerSchedulerInterruptedTurnResumeOutcome,
  resetSchedulerInterruptedTurnRecovery,
  releaseSchedulerInterruptedTurnResumeOutcome,
  settleSchedulerInterruptedTurnResumeOutcome,
  supersedeSchedulerInterruptedTurnRecovery,
} from '../schedulerInterruptedTurnRecoveryBridge';

const errorEvent = {
  type: 'error',
  data: { message: 'Selected model is at capacity.', isTerminal: true },
} as AgentEvent;
const notReserved = () => false;

describe('scheduler interrupted-turn recovery bridge', () => {
  it('lets the active Schedule waiter synchronously claim a terminal error', () => {
    const handler = vi.fn(() => 'started' as const);
    const dispose = registerSchedulerInterruptedTurnRecovery(
      'bridge-claim', 'run-1', handler, vi.fn(), notReserved,
    );

    expect(claimSchedulerInterruptedTurnRecovery('bridge-claim', errorEvent)).toEqual({
      runId: 'run-1',
      disposition: 'started',
    });
    expect(handler).toHaveBeenCalledWith(errorEvent);

    dispose();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-claim', errorEvent)).toBeNull();
  });

  it('does not let a stale disposer remove a newer run for the same session', () => {
    const disposeOld = registerSchedulerInterruptedTurnRecovery(
      'bridge-owner', 'same-run', () => null, vi.fn(), notReserved,
    );
    const next = vi.fn(() => 'started' as const);
    const disposeNext = registerSchedulerInterruptedTurnRecovery(
      'bridge-owner', 'same-run', next, vi.fn(), notReserved,
    );

    disposeOld();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-owner', errorEvent)).toEqual({
      runId: 'same-run',
      disposition: 'started',
    });
    expect(next).toHaveBeenCalledTimes(1);

    disposeNext();
  });

  it('routes concurrent terminal events only to the matching Schedule run', () => {
    const first = vi.fn(() => 'started' as const);
    const second = vi.fn(() => 'duplicate' as const);
    const disposeFirst = registerSchedulerInterruptedTurnRecovery(
      'bridge-concurrent', 'run-first', first, vi.fn(), notReserved,
    );
    const disposeSecond = registerSchedulerInterruptedTurnRecovery(
      'bridge-concurrent', 'run-second', second, vi.fn(), notReserved,
    );
    const firstEvent = {
      ...errorEvent,
      turnOrigin: { kind: 'scheduler', runId: 'run-first' },
    } as AgentEvent;
    const unknownEvent = {
      ...errorEvent,
      turnOrigin: { kind: 'scheduler', runId: 'run-missing' },
    } as AgentEvent;

    expect(claimSchedulerInterruptedTurnRecovery('bridge-concurrent', firstEvent)).toEqual({
      runId: 'run-first',
      disposition: 'started',
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-concurrent', unknownEvent)).toBeNull();
    expect(claimSchedulerInterruptedTurnRecovery('bridge-concurrent', errorEvent)).toBeNull();
    expect(
      isSchedulerInterruptedTurnEventOwnedBy('bridge-concurrent', 'run-first', undefined),
    ).toBe(false);
    expect(
      isSchedulerInterruptedTurnEventOwnedBy(
        'bridge-concurrent', 'run-first', 'run-first',
      ),
    ).toBe(true);

    disposeFirst();
    expect(
      isSchedulerInterruptedTurnEventOwnedBy('bridge-concurrent', 'run-second', undefined),
    ).toBe(true);
    expect(claimSchedulerInterruptedTurnRecovery('bridge-concurrent', errorEvent)).toEqual({
      runId: 'run-second',
      disposition: 'duplicate',
    });
    expect(second).toHaveBeenCalledTimes(1);
    disposeSecond();
  });

  it('fans session resets out to every registered run and removes their ownership', () => {
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    const first = vi.fn(() => 'started' as const);
    const second = vi.fn(() => 'started' as const);
    registerSchedulerInterruptedTurnRecovery(
      'bridge-reset', 'run-first', first, firstReset, notReserved,
    );
    registerSchedulerInterruptedTurnRecovery(
      'bridge-reset', 'run-second', second, secondReset, notReserved,
    );

    resetSchedulerInterruptedTurnRecovery('bridge-reset', 'session-reset');

    expect(firstReset).toHaveBeenCalledWith('session-reset');
    expect(secondReset).toHaveBeenCalledWith('session-reset');
    expect(claimSchedulerInterruptedTurnRecovery('bridge-reset', errorEvent)).toBeNull();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it('fans user intervention out and revokes future recovery ownership', () => {
    const onReset = vi.fn();
    const handler = vi.fn(() => 'started' as const);
    const dispose = registerSchedulerInterruptedTurnRecovery(
      'bridge-intervention', 'run-1', handler, onReset, notReserved,
    );

    supersedeSchedulerInterruptedTurnRecovery('bridge-intervention');

    expect(onReset).toHaveBeenCalledWith('user-intervention');
    expect(claimSchedulerInterruptedTurnRecovery('bridge-intervention', errorEvent)).toBeNull();
    expect(
      isSchedulerInterruptedTurnEventOwnedBy('bridge-intervention', 'run-1', undefined),
    ).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    dispose();
    expect(
      isSchedulerInterruptedTurnEventOwnedBy('bridge-intervention', 'run-1', undefined),
    ).toBe(false);
  });

  it('reserves the session while any run is in recovery backoff or dispatch', () => {
    let firstReserved = false;
    let secondReserved = true;
    const disposeFirst = registerSchedulerInterruptedTurnRecovery(
      'bridge-reserved', 'run-first', () => null, vi.fn(), () => firstReserved,
    );
    const disposeSecond = registerSchedulerInterruptedTurnRecovery(
      'bridge-reserved', 'run-second', () => null, vi.fn(), () => secondReserved,
    );

    expect(isSchedulerInterruptedTurnRecoverySessionReserved('bridge-reserved')).toBe(true);
    secondReserved = false;
    expect(isSchedulerInterruptedTurnRecoverySessionReserved('bridge-reserved')).toBe(false);
    firstReserved = true;
    expect(isSchedulerInterruptedTurnRecoverySessionReserved('bridge-reserved')).toBe(true);
    disposeFirst();
    expect(isSchedulerInterruptedTurnRecoverySessionReserved('bridge-reserved')).toBe(false);
    disposeSecond();
  });

  it('forwards persistence lifecycle events when the desktop host is installed', () => {
    const lifecycle = {
      registerOutcome: vi.fn(),
      releaseOutcome: vi.fn(),
      settleOutcome: vi.fn(),
      discardSuppressedError: vi.fn(),
      finalizeSuppressedError: vi.fn(),
    };
    configureSchedulerInterruptedTurnRecoveryLifecycle(lifecycle);

    registerSchedulerInterruptedTurnResumeOutcome('bridge-life', 'run-1', 'client-1');
    releaseSchedulerInterruptedTurnResumeOutcome('bridge-life', 'run-1', 'client-1');
    settleSchedulerInterruptedTurnResumeOutcome('bridge-life', 'run-1', 'succeeded');
    discardSchedulerInterruptedTurnSuppressedError('bridge-life', 'run-1');
    finalizeSchedulerInterruptedTurnSuppressedError('bridge-life', 'run-1');

    expect(lifecycle.registerOutcome).toHaveBeenCalledWith('bridge-life', 'run-1', 'client-1');
    expect(lifecycle.releaseOutcome).toHaveBeenCalledWith('bridge-life', 'run-1', 'client-1');
    expect(lifecycle.settleOutcome).toHaveBeenCalledWith('bridge-life', 'run-1', 'succeeded');
    expect(lifecycle.discardSuppressedError).toHaveBeenCalledWith('bridge-life', 'run-1');
    expect(lifecycle.finalizeSuppressedError).toHaveBeenCalledWith('bridge-life', 'run-1');
  });
});
