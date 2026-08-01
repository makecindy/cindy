import { describe, expect, it, vi } from 'vitest';

import type { InterruptedTurnAutoResumeScope } from '../../maker-ipc/interruptedTurnAutoResume';
import { SchedulerInterruptedTurnRecoveryState } from '../schedulerInterruptedTurnRecoveryState';

function createResumeScope(): InterruptedTurnAutoResumeScope {
  return {
    noteProgress() {},
    noteUserSend() {},
    noteTurnStarted() {},
    noteResumeSendFailed() {},
    noteSessionReset() {},
    onInterruptedTurn: () => ({ action: 'skip', why: 'disabled' }),
    dispose() {},
  };
}

describe('SchedulerInterruptedTurnRecoveryState', () => {
  it('uses the vendor dispatch boundary to distinguish duplicate errors from a new failed attempt', () => {
    const state = new SchedulerInterruptedTurnRecoveryState(createResumeScope());

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
    const state = new SchedulerInterruptedTurnRecoveryState(createResumeScope());
    state.noteProgress();
    const generation = state.scheduleRecovery();
    const signal = state.beginDispatch(generation);

    expect(state.userInterventionDisposition()).toBe('cancel-pending');
    state.cancel();
    expect(signal?.aborted).toBe(true);
    expect(state.isCurrentAttempt(generation)).toBe(false);
  });

  it('preserves a running attempt for normal queue ordering but reset still aborts it', () => {
    const state = new SchedulerInterruptedTurnRecoveryState(createResumeScope());
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

  it('owns retry quota transitions for the whole recovery lifecycle', () => {
    const scope: InterruptedTurnAutoResumeScope = {
      noteProgress: vi.fn(),
      noteUserSend: vi.fn(),
      noteTurnStarted: vi.fn(),
      noteResumeSendFailed: vi.fn(),
      noteSessionReset: vi.fn(),
      onInterruptedTurn: vi.fn(() => ({ action: 'skip' as const, why: 'disabled' as const })),
      dispose: vi.fn(),
    };
    const state = new SchedulerInterruptedTurnRecoveryState(scope);

    state.noteRunningStatus();
    state.noteProgress();
    state.noteResumeSendFailed();
    state.onInterruptedTurn(123);
    const generation = state.scheduleRecovery();
    state.beginDispatch(generation);
    state.noteVendorDispatching(generation);

    expect(scope.noteTurnStarted).toHaveBeenCalledTimes(2);
    expect(scope.noteProgress).toHaveBeenCalledTimes(1);
    expect(scope.noteResumeSendFailed).toHaveBeenCalledTimes(1);
    expect(scope.onInterruptedTurn).toHaveBeenCalledWith(123);
    expect(scope.noteSessionReset).not.toHaveBeenCalled();
    expect(scope.dispose).not.toHaveBeenCalled();

    state.cancel();
    expect(scope.noteSessionReset).toHaveBeenCalledTimes(1);
    expect(scope.dispose).toHaveBeenCalledTimes(1);
  });
});
