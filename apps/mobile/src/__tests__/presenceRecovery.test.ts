import { describe, expect, it, vi } from 'vitest';
import {
  capturePresenceAvailabilityEpoch,
  clearPresenceWipeTimer,
  createPresenceAvailabilityEpochs,
  extendPresenceWipeTimerFloor,
  getOrCreatePresenceTrackedRequest,
  isInvokeResultReachabilityEvidence,
  isPresenceAvailabilityEpochCurrent,
  isPresenceEligibleForRemoteRequest,
  markPresenceAvailabilityEpoch,
  PRESENCE_WIPE_MAX_LIFETIME_MS,
  reconcileOfflineVerdictAfterResponse,
  type PresenceUnavailableVerdict,
  type PresenceWipeTimerEntry,
  resetPresenceAvailabilityEpochs,
  resetPresenceAvailabilityForConnection,
  schedulePresenceWipeTimer,
  updatePresenceAvailability,
} from '@/device-link/presenceRecovery';

describe('updatePresenceAvailability', () => {
  it('does not treat the first available snapshot as a recovery', () => {
    const states = new Map<string, boolean>();

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: false,
    });
  });

  it('marks offline to available as a recovery', () => {
    const states = new Map<string, boolean>();

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: false,
      remoteControlEnabled: true,
    })).toEqual({
      available: false,
      recovered: false,
    });
    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: true,
    });
  });

  it('tracks devices independently', () => {
    const states = new Map<string, boolean>();

    updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: false,
      remoteControlEnabled: true,
    });

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-2',
      online: true,
      remoteControlEnabled: true,
    })).toEqual({
      available: true,
      recovered: false,
    });
  });

  it('forgets delta-only verdicts at a new connection epoch so stale offline cannot block rehydrate', () => {
    const states = new Map<string, boolean>();
    updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: false,
      remoteControlEnabled: true,
    });
    updatePresenceAvailability(states, {
      deviceId: 'dev-2',
      online: true,
      remoteControlEnabled: true,
    });
    expect(isPresenceEligibleForRemoteRequest(states, 'dev-1')).toBe(false);

    const pendingRecovery = new Set<string>();
    expect(resetPresenceAvailabilityForConnection(states, pendingRecovery)).toEqual(['dev-1']);

    expect(states.size).toBe(0);
    expect(pendingRecovery).toEqual(new Set(['dev-1']));
    expect(isPresenceEligibleForRemoteRequest(states, 'dev-1')).toBe(true);
    expect(isPresenceEligibleForRemoteRequest(states, 'dev-2')).toBe(true);

    expect(updatePresenceAvailability(states, {
      deviceId: 'dev-1',
      online: true,
      remoteControlEnabled: true,
    }, pendingRecovery)).toEqual({
      available: true,
      recovered: true,
    });
    expect(pendingRecovery.size).toBe(0);
  });
});

describe('unavailable mirror wipe timer', () => {
  function timerHarness() {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timers = new Map<string, PresenceWipeTimerEntry>();
    const states = new Map<string, boolean>([['dev-1', false]]);
    const wipe = vi.fn();
    const deps = {
      now: Date.now,
      setTimer: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
      clearTimer: clearTimeout,
      wipe,
      isConfirmationInFlight: undefined as (() => boolean) | undefined,
    };
    schedulePresenceWipeTimer(timers, states, 'dev-1', 5_000, deps);
    return { deps, states, timers, wipe };
  }

  it('keeps the original deadline when reconnect leaves enough confirmation time', () => {
    const { deps, states, timers, wipe } = timerHarness();
    vi.advanceTimersByTime(2_000);

    resetPresenceAvailabilityForConnection(states, new Set());
    extendPresenceWipeTimerFloor(timers, states, 'dev-1', 3_000, deps);

    vi.advanceTimersByTime(2_999);
    expect(wipe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(wipe).toHaveBeenCalledWith('dev-1');
    vi.useRealTimers();
  });

  it('extends a near-expiry deadline to leave reconnect time for reachability proof', () => {
    const { deps, states, timers, wipe } = timerHarness();
    vi.advanceTimersByTime(4_900);

    resetPresenceAvailabilityForConnection(states, new Set());
    extendPresenceWipeTimerFloor(timers, states, 'dev-1', 3_000, deps);

    vi.advanceTimersByTime(100);
    expect(wipe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_899);
    expect(wipe).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(wipe).toHaveBeenCalledWith('dev-1');
    vi.useRealTimers();
  });

  it('caps repeated reconnect extensions at the first-offline lifetime', () => {
    const { deps, states, timers, wipe } = timerHarness();
    resetPresenceAvailabilityForConnection(states, new Set());

    for (let step = 2_500; step < PRESENCE_WIPE_MAX_LIFETIME_MS; step += 2_500) {
      const advanceBy = Math.min(
        2_500,
        PRESENCE_WIPE_MAX_LIFETIME_MS - Date.now() - 1,
      );
      if (advanceBy <= 0) break;
      vi.advanceTimersByTime(advanceBy);
      extendPresenceWipeTimerFloor(timers, states, 'dev-1', 3_000, deps);
      expect(wipe).not.toHaveBeenCalled();
    }

    vi.advanceTimersByTime(PRESENCE_WIPE_MAX_LIFETIME_MS - Date.now());
    expect(wipe).toHaveBeenCalledWith('dev-1');
    vi.useRealTimers();
  });

  it('cancels cleanup after a near-expiry reconnect proves the device reachable', () => {
    const { deps, states, timers, wipe } = timerHarness();
    vi.advanceTimersByTime(4_900);
    resetPresenceAvailabilityForConnection(states, new Set());
    extendPresenceWipeTimerFloor(timers, states, 'dev-1', 3_000, deps);
    vi.advanceTimersByTime(1_000);

    clearPresenceWipeTimer(timers, 'dev-1', deps.clearTimer);
    vi.advanceTimersByTime(2_000);

    expect(wipe).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('defers cleanup past the reconnect floor while confirmation is in flight', () => {
    const { deps, states, timers, wipe } = timerHarness();
    let confirming = true;
    deps.isConfirmationInFlight = () => confirming;
    vi.advanceTimersByTime(4_900);
    resetPresenceAvailabilityForConnection(states, new Set());
    extendPresenceWipeTimerFloor(timers, states, 'dev-1', 3_000, deps);

    vi.advanceTimersByTime(3_000);
    expect(wipe).not.toHaveBeenCalled();
    confirming = false;
    clearPresenceWipeTimer(timers, 'dev-1', deps.clearTimer);
    vi.advanceTimersByTime(1_000);

    expect(wipe).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('allows only an active confirmation to cross the maximum lifetime', () => {
    const { deps, states, timers, wipe } = timerHarness();
    let confirming = true;
    deps.isConfirmationInFlight = () => confirming;
    resetPresenceAvailabilityForConnection(states, new Set());

    vi.advanceTimersByTime(PRESENCE_WIPE_MAX_LIFETIME_MS);
    expect(wipe).not.toHaveBeenCalled();
    confirming = false;
    vi.advanceTimersByTime(1_000);

    expect(wipe).toHaveBeenCalledWith('dev-1');
    vi.useRealTimers();
  });
});

describe('invoke reachability evidence', () => {
  it('counts successful and non-availability error results as target responses', () => {
    expect(isInvokeResultReachabilityEvidence({
      ok: true,
      result: null,
    })).toBe(true);
    expect(isInvokeResultReachabilityEvidence({
      ok: false,
      error: { code: 'IPC_ERROR', message: 'boom' },
    })).toBe(true);
    expect(isInvokeResultReachabilityEvidence({
      ok: false,
      error: { code: 'CHANNEL_NOT_ALLOWED', message: 'unsupported' },
    })).toBe(true);
  });

  it('does not count disabled or revoked results as reachability', () => {
    expect(isInvokeResultReachabilityEvidence({
      ok: false,
      error: { code: 'REMOTE_DISABLED', message: 'disabled' },
    })).toBe(false);
    expect(isInvokeResultReachabilityEvidence({
      ok: false,
      error: { code: 'ACCESS_REVOKED', message: 'revoked' },
    })).toBe(false);
  });
});

describe('late response verdict reconciliation', () => {
  function harness(kind: PresenceUnavailableVerdict['kind'], responseEvidenceEpoch: number) {
    const states = new Map<string, boolean>([['dev-1', false]]);
    const pendingRecovery = new Set<string>();
    const verdicts = new Map<string, PresenceUnavailableVerdict>([[
      'dev-1',
      { kind, responseEvidenceEpoch },
    ]]);
    return { pendingRecovery, states, verdicts };
  }

  it('returns a superseded rehydrate-offline verdict to unknown', () => {
    const { pendingRecovery, states, verdicts } = harness('offline', 3);

    expect(reconcileOfflineVerdictAfterResponse(
      states,
      pendingRecovery,
      verdicts,
      'dev-1',
      4,
    )).toBe(true);
    expect(states.has('dev-1')).toBe(false);
    expect(pendingRecovery).toEqual(new Set(['dev-1']));
    expect(verdicts.has('dev-1')).toBe(false);
  });

  it('keeps an offline verdict when response evidence is not newer', () => {
    const { pendingRecovery, states, verdicts } = harness('offline', 3);

    expect(reconcileOfflineVerdictAfterResponse(
      states,
      pendingRecovery,
      verdicts,
      'dev-1',
      3,
    )).toBe(false);
    expect(states.get('dev-1')).toBe(false);
    expect(pendingRecovery.size).toBe(0);
  });

  it.each(['disabled', 'presence'] as const)(
    'does not let a raw response clear an authoritative %s verdict',
    (kind) => {
      const { pendingRecovery, states, verdicts } = harness(kind, 3);

      expect(reconcileOfflineVerdictAfterResponse(
        states,
        pendingRecovery,
        verdicts,
        'dev-1',
        4,
      )).toBe(false);
      expect(states.get('dev-1')).toBe(false);
      expect(verdicts.get('dev-1')?.kind).toBe(kind);
    },
  );
});

describe('presence availability epochs', () => {
  it('invalidates an older probe only when that device receives a newer presence delta', () => {
    const epochs = createPresenceAvailabilityEpochs();
    const dev1ProbeEpoch = capturePresenceAvailabilityEpoch(epochs, 'dev-1');
    const dev2ProbeEpoch = capturePresenceAvailabilityEpoch(epochs, 'dev-2');

    markPresenceAvailabilityEpoch(epochs, 'dev-1');

    expect(isPresenceAvailabilityEpochCurrent(epochs, 'dev-1', dev1ProbeEpoch)).toBe(false);
    expect(isPresenceAvailabilityEpochCurrent(epochs, 'dev-2', dev2ProbeEpoch)).toBe(true);
  });

  it('keeps both request-creation epochs when callers share an in-flight request', async () => {
    const epochs = createPresenceAvailabilityEpochs();
    const responseEvidenceEpochs = createPresenceAvailabilityEpochs();
    const inFlight = new Map();
    let resolveRequest!: () => void;
    const request = new Promise<void>((resolve) => {
      resolveRequest = resolve;
    });

    const first = getOrCreatePresenceTrackedRequest(
      inFlight,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      () => request,
    );
    markPresenceAvailabilityEpoch(epochs, 'dev-1');
    markPresenceAvailabilityEpoch(responseEvidenceEpochs, 'dev-1');
    const deduped = getOrCreatePresenceTrackedRequest(
      inFlight,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      () => Promise.resolve(),
    );

    expect(deduped).toBe(first);
    expect(deduped.capturedPresenceEpoch).toBe(0);
    expect(deduped.capturedResponseEvidenceEpoch).toBe(0);
    expect(isPresenceAvailabilityEpochCurrent(
      epochs,
      'dev-1',
      deduped.capturedPresenceEpoch,
    )).toBe(false);
    expect(isPresenceAvailabilityEpochCurrent(
      responseEvidenceEpochs,
      'dev-1',
      deduped.capturedResponseEvidenceEpoch,
    )).toBe(false);

    resolveRequest();
    await request;
  });

  it('resets epochs on logout or account change', () => {
    const epochs = createPresenceAvailabilityEpochs();
    markPresenceAvailabilityEpoch(epochs, 'dev-1');
    resetPresenceAvailabilityEpochs(epochs);

    expect(capturePresenceAvailabilityEpoch(epochs, 'dev-1')).toBe(0);
    expect(epochs.next).toBe(0);
  });
});
