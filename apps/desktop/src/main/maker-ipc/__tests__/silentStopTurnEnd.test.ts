import { describe, expect, it, vi } from 'vitest';
import { SilentStopAutoResumeGuard } from '../silentStopAutoResume.js';
import { SilentStopTurnLeaseGate } from '../sessionTurnLease.js';
import { handleSilentStopTurnEndWithPorts, type SilentStopTurnEndPorts } from '../silentStopTurnEnd.js';
import { surfaceSilentStopFailureWithPorts } from '../silentStopFailure.js';

// #10854, unit: run the production terminal handler through persistence and
// broadcast. Guard-only tests cannot detect cause loss or failed-send miscopy.
// This entry has its own async dispatch/lease lifecycle, unlike the pure guard.
function harness(mode: 'accepted' | 'rejected' | 'throw' = 'accepted') {
  let now = 1_000_000;
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const guard = new SilentStopAutoResumeGuard({ isEnabled: () => true, now: () => now, log });
  const gate = new SilentStopTurnLeaseGate();
  gate.schedule('s', {}, 'lease');
  const broadcast = vi.fn();
  const createDbMessage = vi.fn<SilentStopTurnEndPorts['createDbMessage']>()
    .mockResolvedValue({} as Awaited<ReturnType<SilentStopTurnEndPorts['createDbMessage']>>);
  const discardActivity = vi.fn();
  const coordinator = {
    hasPendingQueuedWork: vi.fn(() => false),
    noteHostTurnContinuation: vi.fn(),
    noteHostTurnContinuationFailed: vi.fn(),
  };
  type Session = Parameters<typeof handleSilentStopTurnEndWithPorts>[0];
  const send = vi.fn<Session['sendHostTurnContinuation']>(async (_message, opts) => {
    opts?.onTurnReserved?.(2);
    if (mode === 'throw') throw new Error('synthetic dispatch failure');
    if (mode === 'rejected') return { accepted: false, reason: 'provider-rejected-before-dispatch' };
    await opts?.onAccepted?.();
    return { accepted: true };
  });
  const session = { id: 's', getTurnGeneration: () => 1, sendHostTurnContinuation: send } as unknown as Session;
  const settle = vi.fn(async () => gate.settle('s', 'lease'));
  const ports: SilentStopTurnEndPorts = {
    silentStopTurnLeaseGate: gate,
    agentInputCoordinatorHolder: coordinator,
    silentStopAutoResumeGuard: guard,
    sessionListActivityTracker: { captureContinuation: () => discardActivity },
    productTurnWallClockTracker: { preserveForContinuation: vi.fn() },
    advanceRuntimeRecoveryNotice: vi.fn(),
    createDbMessage,
    settleSilentStopDone: settle,
    surfaceSilentStopExhaustedBanner: (id, cause) => surfaceSilentStopFailureWithPorts(id, cause, {
      createDbMessage, broadcast, log,
    }),
    log,
  };
  return {
    guard, send, broadcast, createDbMessage, settle, coordinator, discardActivity, log,
    tick: () => { now += 60_000; },
    decide: () => guard.onSilentStop('s', now),
    run: () => handleSilentStopTurnEndWithPorts(session, now, 'lease', undefined, ports),
  };
}

describe('silent-stop termination diagnostics', () => {
  it.each([
    ['budget', '本次自动续跑次数已用完'],
    ['rate-limit', '频率保护'],
    ['session-breaker', '累计自动续跑次数已达上限'],
  ] as const)('persists and broadcasts the actual %s cause without another dispatch', async (cause, detail) => {
    const h = harness();
    if (cause !== 'budget') {
      const attempts = cause === 'session-breaker' ? 6 : 1;
      for (let i = 0; i < attempts; i++) {
        h.tick();
        h.guard.noteUserSend('s');
        h.guard.noteTurnStarted('s');
        expect(h.decide().action).toBe('resume');
      }
      h.guard.noteTurnStarted('s');
    }
    await h.run();
    await h.run(); // Duplicate terminal delivery cannot spend or publish twice.
    expect(h.send).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledOnce();
    const data = h.broadcast.mock.calls[0][0];
    expect(data).toMatchObject({ reason: 'silent-stop-exhausted', isTerminal: true, silentStopFailureCause: cause });
    expect(data.message).toContain(detail);
    expect(data.message).not.toContain('连续多次');
    expect(h.createDbMessage).toHaveBeenCalledOnce();
    expect(h.createDbMessage.mock.calls[0][1]).toMatchObject({ role: 'error', content: data });
    expect(h.log.warn).toHaveBeenCalledWith(expect.any(String), { sessionId: 's', silentStopFailureCause: cause });
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it.each([
    ['rejected', 'dispatch-not-accepted', '自动续跑请求未派发'],
    ['throw', 'dispatch-error', '派发自动续跑请求时发生错误'],
  ] as const)('reports a first empty response followed by dispatch %s without replaying side effects', async (mode, cause, detail) => {
    const h = harness(mode);
    h.guard.noteUserSend('s');
    await h.run();
    await h.run();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.broadcast).toHaveBeenCalledOnce();
    const data = h.broadcast.mock.calls[0][0];
    expect(data.silentStopFailureCause).toBe(cause);
    expect(data.message).toContain(detail);
    expect(data.message).not.toContain('连续多次');
    expect(h.createDbMessage.mock.calls.map(call => call[1].role)).toEqual(['error']);
    expect(h.coordinator.noteHostTurnContinuationFailed).toHaveBeenCalledWith('s', 2);
    expect(h.discardActivity).not.toHaveBeenCalled();
    h.tick();
    expect(h.decide().action).toBe('resume'); // pending cleared, one credit remains
    h.guard.noteResumeSendFailed('s');
    h.tick();
    expect(h.decide()).toEqual({ action: 'exhausted', cause: 'budget' });
  });

  it('dispatches a successful continuation once without surfacing a failure', async () => {
    const h = harness();
    h.guard.noteUserSend('s');
    await h.run();
    await h.run();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.createDbMessage.mock.calls.map(call => call[1].role)).toEqual(['user']);
    expect(h.discardActivity).toHaveBeenCalledOnce();
    expect(h.coordinator.noteHostTurnContinuationFailed).not.toHaveBeenCalled();
  });

  it('still broadcasts the bounded cause when writing the error row fails', async () => {
    const h = harness();
    h.createDbMessage.mockRejectedValueOnce(new Error('synthetic storage failure'));
    await h.run();
    expect(h.broadcast).toHaveBeenCalledWith(expect.objectContaining({ silentStopFailureCause: 'budget' }));
    expect(h.settle).toHaveBeenCalledOnce();
    expect(h.send).not.toHaveBeenCalled();
  });
});
