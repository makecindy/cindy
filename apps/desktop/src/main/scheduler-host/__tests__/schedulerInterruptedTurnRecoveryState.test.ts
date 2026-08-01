import { describe, expect, it } from 'vitest';

import { SchedulerInterruptedTurnRecoveryState } from '../schedulerInterruptedTurnRecoveryState';

describe('SchedulerInterruptedTurnRecoveryState', () => {
  it('uses the vendor dispatch boundary to distinguish duplicate errors from a new failed attempt', () => {
    const state = new SchedulerInterruptedTurnRecoveryState();

    expect(state.classifyTerminal()).toBe('ineligible');
    state.noteProgress();
    expect(state.classifyTerminal()).toBe('eligible');

    const generation = state.scheduleRecovery();
    expect(state.classifyTerminal()).toBe('duplicate');
    const signal = state.beginDispatch(generation);
    expect(signal).not.toBeNull();
    expect(state.classifyTerminal()).toBe('duplicate');

    expect(state.noteVendorDispatching(generation)).toBe(true);
    expect(state.classifyTerminal()).toBe('eligible');
  });

  it('synchronously aborts a pre-vendor attempt when user input wins', () => {
    const state = new SchedulerInterruptedTurnRecoveryState();
    state.noteProgress();
    const generation = state.scheduleRecovery();
    const signal = state.beginDispatch(generation);

    expect(state.userInterventionDisposition()).toBe('cancel-pending');
    state.cancel();
    expect(signal?.aborted).toBe(true);
    expect(state.isCurrentAttempt(generation)).toBe(false);
  });

  it('preserves a running attempt for normal queue ordering but reset still aborts it', () => {
    const state = new SchedulerInterruptedTurnRecoveryState();
    state.noteProgress();
    const generation = state.scheduleRecovery();
    const signal = state.beginDispatch(generation);
    state.noteVendorDispatching(generation);

    expect(state.userInterventionDisposition()).toBe('detach');
    expect(signal?.aborted).toBe(false);
    expect(state.isCurrentAttempt(generation)).toBe(true);

    expect(state.cancel()).toBe(true);
    expect(signal?.aborted).toBe(true);
    expect(state.isCurrentAttempt(generation)).toBe(false);
  });
});
