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
  reconcileAvailabilityAfterInboundFrame,
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

  it('transport-timeout 直接可达证据清除 wipe timer 后,即使后续恢复瞬时失败、availability 停在 unknown,镜像也不会被误删', () => {
    const { states, timers, wipe } = timerHarness();
    vi.advanceTimersByTime(2_000);

    // 收到 transport-timeout:可达性冲销回 unknown(非明确 true)+ 同步清
    // 掉此前 unavailable 建的 wipe timer(context 分支调 clearPresenceWipeTimer)。
    reconcileAvailabilityAfterInboundFrame(states, new Set(), new Map(), 'dev-1');
    clearPresenceWipeTimer(timers, 'dev-1', clearTimeout);
    expect(states.has('dev-1')).toBe(false); // unknown,不是明确 true

    // 随后 open/subscribe/rehydrate 瞬时失败、没有任何恢复进展——旧 timer
    // 若未被清除,到点时 availability 仍非明确 true,会把刚被直接证明可达
    // 的设备镜像误删。
    vi.advanceTimersByTime(60_000);
    expect(wipe).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

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

  it('does not let a fulfilled retained link defer unavailable cleanup', async () => {
    const { deps, timers, wipe } = timerHarness();
    const tracked = new Map();
    const request = getOrCreatePresenceTrackedRequest(
      tracked,
      createPresenceAvailabilityEpochs(),
      createPresenceAvailabilityEpochs(),
      'dev-1',
      async () => 'accepted',
      { retainSuccessful: true },
    );
    await request.request;
    deps.isConfirmationInFlight = () => tracked.get('dev-1')?.pending === true;

    vi.advanceTimersByTime(5_000);

    expect(timers.has('dev-1')).toBe(false);
    expect(wipe).toHaveBeenCalledWith('dev-1');
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

describe('inbound frame availability reconciliation (transport-timeout)', () => {
  it('无 verdict 的 stale presence=false 被入站帧直接冲销,设备重新可发起远程请求', () => {
    // 场景:增量 presence 漏掉恢复边,availability 遗留 false 但没有任何
    // verdict——reconcileOfflineVerdictAfterResponse 对此无能为力(要求 verdict
    // 存在),而收到 transport-timeout 本身已证明对端可达。
    const states = new Map<string, boolean>([['dev-1', false]]);
    const pendingRecovery = new Set<string>();
    const verdicts = new Map<string, PresenceUnavailableVerdict>();

    expect(isPresenceEligibleForRemoteRequest(states, 'dev-1')).toBe(false);
    expect(reconcileAvailabilityAfterInboundFrame(states, pendingRecovery, verdicts, 'dev-1')).toBe(true);
    // 回到 unknown 乐观补齐 → 本轮 rehydrate 的 availablePlans 不再排除它,
    // link-open/订阅恢复得以发起
    expect(isPresenceEligibleForRemoteRequest(states, 'dev-1')).toBe(true);
    expect(pendingRecovery).toEqual(new Set(['dev-1']));
  });

  it('offline/presence 判定被入站帧推翻;disabled 判定保留且不碰可用性', () => {
    for (const kind of ['offline', 'presence'] as const) {
      const states = new Map<string, boolean>([['dev-1', false]]);
      const pendingRecovery = new Set<string>();
      const verdicts = new Map<string, PresenceUnavailableVerdict>([
        ['dev-1', { kind, responseEvidenceEpoch: 3 }],
      ]);
      expect(reconcileAvailabilityAfterInboundFrame(states, pendingRecovery, verdicts, 'dev-1')).toBe(true);
      expect(verdicts.has('dev-1')).toBe(false);
      expect(isPresenceEligibleForRemoteRequest(states, 'dev-1')).toBe(true);
    }

    // disabled 与可达性无关(被控开关关闭),只能由权威 presence 恢复
    const states = new Map<string, boolean>([['dev-1', false]]);
    const pendingRecovery = new Set<string>();
    const verdicts = new Map<string, PresenceUnavailableVerdict>([
      ['dev-1', { kind: 'disabled', responseEvidenceEpoch: 3 }],
    ]);
    expect(reconcileAvailabilityAfterInboundFrame(states, pendingRecovery, verdicts, 'dev-1')).toBe(false);
    expect(verdicts.get('dev-1')?.kind).toBe('disabled');
    expect(isPresenceEligibleForRemoteRequest(states, 'dev-1')).toBe(false);
  });

  it('无遗留状态时为 no-op', () => {
    const states = new Map<string, boolean>([['dev-1', true]]);
    const pendingRecovery = new Set<string>();
    const verdicts = new Map<string, PresenceUnavailableVerdict>();
    expect(reconcileAvailabilityAfterInboundFrame(states, pendingRecovery, verdicts, 'dev-1')).toBe(false);
    expect(states.get('dev-1')).toBe(true);
    expect(pendingRecovery.size).toBe(0);
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

  it('retains a successful tracked request for link reuse until the owner invalidates it', async () => {
    const epochs = createPresenceAvailabilityEpochs();
    const responseEvidenceEpochs = createPresenceAvailabilityEpochs();
    const tracked = new Map();
    const create = vi.fn(async () => 'accepted');

    const first = getOrCreatePresenceTrackedRequest(
      tracked,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      create,
      { retainSuccessful: true },
    );
    await expect(first.request).resolves.toBe('accepted');
    const reused = getOrCreatePresenceTrackedRequest(
      tracked,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      create,
      { retainSuccessful: true },
    );

    expect(reused).toBe(first);
    expect(reused.pending).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    tracked.delete('dev-1');
    const reopened = getOrCreatePresenceTrackedRequest(
      tracked,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      create,
      { retainSuccessful: true },
    );
    await reopened.request;
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('refreshes a settled retained link without duplicating an in-flight reopen', async () => {
    const epochs = createPresenceAvailabilityEpochs();
    const responseEvidenceEpochs = createPresenceAvailabilityEpochs();
    const tracked = new Map();
    let resolveReopen!: (value: string) => void;
    const reopenPending = new Promise<string>((resolve) => {
      resolveReopen = resolve;
    });
    const create = vi.fn()
      .mockResolvedValueOnce('first-accept')
      .mockReturnValueOnce(reopenPending);

    const first = getOrCreatePresenceTrackedRequest(
      tracked,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      create,
      { retainSuccessful: true },
    );
    await expect(first.request).resolves.toBe('first-accept');

    const reopened = getOrCreatePresenceTrackedRequest(
      tracked,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      create,
      { retainSuccessful: true, refreshSettled: true },
    );
    const deduped = getOrCreatePresenceTrackedRequest(
      tracked,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      create,
      { retainSuccessful: true, refreshSettled: true },
    );

    expect(reopened).not.toBe(first);
    expect(deduped).toBe(reopened);
    expect(create).toHaveBeenCalledTimes(2);
    resolveReopen('second-accept');
    await expect(reopened.request).resolves.toBe('second-accept');
  });

  it('does not retain failed requests when successful reuse is enabled', async () => {
    const epochs = createPresenceAvailabilityEpochs();
    const responseEvidenceEpochs = createPresenceAvailabilityEpochs();
    const tracked = new Map();
    const create = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('accepted');

    const failed = getOrCreatePresenceTrackedRequest(
      tracked,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      create,
      { retainSuccessful: true },
    );
    await expect(failed.request).rejects.toThrow('offline');
    await Promise.resolve();
    const retried = getOrCreatePresenceTrackedRequest(
      tracked,
      epochs,
      responseEvidenceEpochs,
      'dev-1',
      create,
      { retainSuccessful: true },
    );
    await expect(retried.request).resolves.toBe('accepted');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('resets epochs on logout or account change', () => {
    const epochs = createPresenceAvailabilityEpochs();
    markPresenceAvailabilityEpoch(epochs, 'dev-1');
    resetPresenceAvailabilityEpochs(epochs);

    expect(capturePresenceAvailabilityEpoch(epochs, 'dev-1')).toBe(0);
    expect(epochs.next).toBe(0);
  });
});
