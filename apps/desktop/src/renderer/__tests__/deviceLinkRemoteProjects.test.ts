import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveIneligibleRemoteProjectAction,
  startRemoteSessionsReconciler,
} from '@/features/device-link/useDeviceLinkRemoteProjects';

afterEach(() => {
  vi.useRealTimers();
});

describe('startRemoteSessionsReconciler', () => {
  it('periodically refreshes every eligible device and stops cleanly', async () => {
    vi.useFakeTimers();
    const eligible = new Map([
      ['dev-a', 'Mac A'],
      ['dev-b', 'Mac B'],
    ]);
    const refresh = vi.fn(async () => 'ok');
    const stop = startRemoteSessionsReconciler(() => eligible, refresh, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh.mock.calls).toEqual([
      ['dev-a', 'Mac A'],
      ['dev-b', 'Mac B'],
    ]);

    eligible.delete('dev-a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenLastCalledWith('dev-b', 'Mac B');
    expect(refresh).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

describe('resolveIneligibleRemoteProjectAction', () => {
  it('keeps the cached shard when an eligible device goes offline even if the offline row reports remoteControlEnabled=false', () => {
    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: true,
        hasCachedShard: true,
        isSelf: false,
        online: false,
        remoteControlEnabled: false,
        disabledControl: false,
      }),
    ).toBe('disconnect');
  });

  it('removes an already disconnected cached shard when control is explicitly disabled later', () => {
    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: false,
        hasCachedShard: true,
        isSelf: false,
        online: true,
        remoteControlEnabled: false,
        disabledControl: false,
      }),
    ).toBe('remove');

    expect(
      resolveIneligibleRemoteProjectAction({
        wasEligible: false,
        hasCachedShard: true,
        isSelf: false,
        online: false,
        remoteControlEnabled: false,
        disabledControl: true,
      }),
    ).toBe('remove');
  });
});
