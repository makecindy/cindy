import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearExpiredManualInterrupts,
  clearManualInterrupt,
  clearOrcaManualInterruptTestingState,
  forgetKnownOrcaWorkerSession,
  getManualInterrupt,
  isKnownOrcaWorkerSession,
  markKnownOrcaWorkerSession,
  markManualInterrupt,
  ORCA_MANUAL_INTERRUPT_TTL_MS,
} from '../orcaManualInterrupt';

describe('orcaManualInterrupt', () => {
  beforeEach(() => {
    clearOrcaManualInterruptTestingState();
  });

  it('keeps manual interrupt reads non-destructive', () => {
    markManualInterrupt('session-1', 'input_stop', 1000);

    expect(getManualInterrupt('session-1', 1000)).not.toBeNull();
    expect(getManualInterrupt('session-1', 1001)).not.toBeNull();
    expect(getManualInterrupt('session-1', 1002)).toEqual({
      markedAt: 1000,
      reason: 'input_stop',
    });
  });

  it('clears explicit manual interrupt marks', () => {
    markManualInterrupt('session-1', 'abort_session', 1000);

    clearManualInterrupt('session-1');

    expect(getManualInterrupt('session-1', 1001)).toBeNull();
  });

  it('does not let an ordinary stop reason overwrite a reserved Lead interrupt', () => {
    markManualInterrupt('session-1', 'lead_interrupt', 1000);
    markManualInterrupt('session-1', 'input_stop', 1001);
    markManualInterrupt('session-1', 'abort_session', 1002);

    expect(getManualInterrupt('session-1', 1003)).toEqual({
      markedAt: 1000,
      reason: 'lead_interrupt',
    });
  });

  it('expires stale marks with ttl cleanup', () => {
    markManualInterrupt('session-1', 'input_stop', 1000);
    markManualInterrupt('session-2', 'abort_session', 2000);

    const cleared = clearExpiredManualInterrupts(1000 + ORCA_MANUAL_INTERRUPT_TTL_MS + 1);

    expect(cleared).toBe(1);
    expect(getManualInterrupt('session-1', 1000 + ORCA_MANUAL_INTERRUPT_TTL_MS + 1)).toBeNull();
    expect(getManualInterrupt('session-2', 1000 + ORCA_MANUAL_INTERRUPT_TTL_MS + 1)).not.toBeNull();
  });

  it('tracks known worker sessions independently and forget clears marks', () => {
    markKnownOrcaWorkerSession('session-1');
    markManualInterrupt('session-1', 'input_stop', 1000);

    expect(isKnownOrcaWorkerSession('session-1')).toBe(true);

    forgetKnownOrcaWorkerSession('session-1');

    expect(isKnownOrcaWorkerSession('session-1')).toBe(false);
    expect(getManualInterrupt('session-1', 1001)).toBeNull();
  });
});
