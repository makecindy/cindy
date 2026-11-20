/**
 * The auto-resume runtime as register.ts and the Node Host assemble it (autoResumeRuntime.ts).
 *
 * Its settlement of an auto-resume item dropped before dispatch had no behavioural coverage while it
 * lived in register.ts: dropping the record settlement, the guard rollback, the held error, the
 * scheduler quota-wait or the provider-group settlement left every test green. Guard and bookkeeping
 * decisions keep their own tests; this file pins what the runtime wires between them and its ports.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
  type AgentInputQueuedMessage,
} from '../../../shared/agentInputQueue.js';
import { createAutoResumeRuntime, type AutoResumeRuntimePorts } from '../autoResumeRuntime.js';

const SID = 'task';

function runtime(restored = true) {
  const ports = {
    isSilentStopAutoResumeEnabled: () => true,
    isInterruptedTurnAutoResumeEnabled: () => true,
    guardLog: { debug: vi.fn(), warn: vi.fn() },
    bookkeeping: {
      persistSuppressedError: vi.fn(),
      surfaceSuppressedError: vi.fn(),
      markOutcome: vi.fn(),
      abandonTakeover: vi.fn(),
      onAutoResumeFailed: vi.fn(),
    },
    restoreAutoResumeRecovery: vi.fn(() => restored),
    finishScheduledUsageLimitWait: vi.fn(),
    settleProviderGroupContinuation: vi.fn(),
  } satisfies AutoResumeRuntimePorts;
  return { ports, ...createAutoResumeRuntime(ports) };
}

function queued(clientId: string, autoResumeInfo: Partial<AgentInputQueuedMessage['autoResumeInfo']>) {
  return {
    clientId,
    autoResume: true,
    autoResumeInfo: { attempt: 1, maxAttempts: 3, ...autoResumeInfo },
  } as AgentInputQueuedMessage;
}

/** An interruption the guard granted, with its error held and its retry item registered. */
function grantedRetry(rt: ReturnType<typeof runtime>, clientId: string): number {
  const decision = rt.interruptedTurnAutoResumeGuard.onInterruptedTurn(SID, Date.now());
  if (decision.action !== 'resume') throw new Error('expected a granted resume');
  const token = decision.sessionTotal;
  rt.autoResumeBookkeeping.beginAttempt(SID, token);
  rt.autoResumeBookkeeping.stashSuppressedError(SID, { message: 'Stream ended' }, token);
  rt.autoResumeBookkeeping.bindSuppressedErrorToClient(SID, token, clientId);
  rt.autoResumeBookkeeping.registerPendingOutcome(SID, token, clientId);
  return token;
}

describe('auto-resume runtime', () => {
  it('settles an interrupted-turn retry dropped before dispatch and frees the guard', () => {
    const rt = runtime(true);
    const token = grantedRetry(rt, 'retry');
    expect(rt.interruptedTurnAutoResumeGuard.onInterruptedTurn(SID, Date.now())).toEqual({
      action: 'skip',
      why: 'pending',
    });

    expect(rt.settleUndispatchedInterruptedAutoResume(SID, queued('retry', { sessionTotal: token }))).toBe(true);

    expect(rt.ports.restoreAutoResumeRecovery).toHaveBeenCalledWith(SID, 'retry', token);
    expect(rt.ports.bookkeeping.markOutcome).toHaveBeenCalledWith(SID, 'retry', 'failed');
    expect(rt.ports.bookkeeping.persistSuppressedError).toHaveBeenCalledWith(SID, { message: 'Stream ended' });
    // The coordinator restored the recovery, so the held error is surfaced with its banner.
    expect(rt.ports.bookkeeping.surfaceSuppressedError).toHaveBeenCalledWith(SID, { message: 'Stream ended' });
    expect(rt.ports.bookkeeping.abandonTakeover).toHaveBeenCalledWith(SID, 'Stream ended', token);
    expect(rt.ports.bookkeeping.onAutoResumeFailed).toHaveBeenCalledWith(SID, token);
    expect(rt.ports.finishScheduledUsageLimitWait).not.toHaveBeenCalled();
    // The pending resume is rolled back: the next interruption is decided again instead of skipped.
    expect(rt.interruptedTurnAutoResumeGuard.onInterruptedTurn(SID, Date.now()).action).toBe('resume');
  });

  it('writes the held error without a banner when a user action superseded the recovery', () => {
    const rt = runtime(false);
    const token = grantedRetry(rt, 'retry');

    expect(rt.settleUndispatchedInterruptedAutoResume(SID, queued('retry', { sessionTotal: token }))).toBe(true);

    expect(rt.ports.bookkeeping.persistSuppressedError).toHaveBeenCalledOnce();
    expect(rt.ports.bookkeeping.surfaceSuppressedError).not.toHaveBeenCalled();
    expect(rt.ports.bookkeeping.abandonTakeover).toHaveBeenCalledWith(SID, undefined, token);
  });

  it('leaves another item\'s retry and the guard alone', () => {
    const rt = runtime(true);
    const token = grantedRetry(rt, 'retry');

    expect(rt.settleUndispatchedInterruptedAutoResume(SID, queued('other', { sessionTotal: token }))).toBe(false);
    expect(rt.settleUndispatchedInterruptedAutoResume(SID, { clientId: 'plain' } as AgentInputQueuedMessage)).toBe(false);

    expect(rt.ports.bookkeeping.markOutcome).not.toHaveBeenCalled();
    expect(rt.ports.bookkeeping.persistSuppressedError).not.toHaveBeenCalled();
    expect(rt.interruptedTurnAutoResumeGuard.onInterruptedTurn(SID, Date.now())).toEqual({
      action: 'skip',
      why: 'pending',
    });
  });

  it('hands a dropped usage-limit continuation back to its recovery, scheduled run and provider group', () => {
    const rt = runtime(true);
    const item = queued('quota', { sessionTotal: 0, reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON });

    expect(rt.autoResumeAttemptToken(item)).toBeNull();
    expect(rt.settleUndispatchedInterruptedAutoResume(SID, item)).toBe(false);

    expect(rt.ports.restoreAutoResumeRecovery).toHaveBeenCalledWith(SID, 'quota', null);
    expect(rt.ports.finishScheduledUsageLimitWait).toHaveBeenCalledWith(SID, 'quota');
    expect(rt.ports.settleProviderGroupContinuation).toHaveBeenCalledWith(SID, false);
    expect(rt.ports.bookkeeping.markOutcome).not.toHaveBeenCalled();
  });

  it('rolls the guard back when the bookkeeping tears down an unscheduled attempt', () => {
    const rt = runtime(true);
    grantedRetry(rt, 'retry');

    rt.autoResumeBookkeeping.teardown(SID);

    expect(rt.interruptedTurnAutoResumeGuard.onInterruptedTurn(SID, Date.now()).action).toBe('resume');
  });
});
