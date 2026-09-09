import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceLinkError } from '@cindy/device-link';

import { createSubscriptionReplayScheduler, isPermanentSubscriptionReplayError } from '../subscriptionReplayScheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('subscription replay scheduler', () => {
  describe('recovery before presence arrives', () => {
    const deviceId = 'device-a';
    let presence: Map<string, boolean>;
    let directoryOnline: Map<string, boolean>;
    let relayOnline: boolean;
    let unresponsive: boolean;
    let tornDown: boolean;
    let refs: Array<{ deviceId: string; topics: string[] }>;
    let remoteSubscribe: ReturnType<typeof vi.fn<(id: string, topics: string[]) => Promise<unknown>>>;
    let scheduler: ReturnType<typeof createSubscriptionReplayScheduler>;

    beforeEach(() => {
      vi.useFakeTimers();
      presence = new Map();
      directoryOnline = new Map();
      relayOnline = true;
      unresponsive = false;
      tornDown = false;
      refs = [{ deviceId, topics: ['session:one'] }];
      remoteSubscribe = vi.fn<(id: string, topics: string[]) => Promise<unknown>>()
        .mockRejectedValue(new Error('temporary'));
      scheduler = createSubscriptionReplayScheduler({
        snapshotSubscriptions: (id) => refs.filter((ref) => !id || ref.deviceId === id),
        remoteSubscribe,
        isLinkTornDown: () => tornDown,
        isRelayOnline: () => relayOnline,
        isDeviceUnresponsive: () => unresponsive,
        getPresenceAvailability: (id) => presence.get(id)
          ?? (directoryOnline.get(id) === false ? false : undefined),
        isPermanentError: (error, id) => isPermanentSubscriptionReplayError(error, presence.get(id)),
        log: { debug: vi.fn(), warn: vi.fn() },
      });
    });

    afterEach(() => {
      scheduler.teardown();
      vi.useRealTimers();
    });

    it('recovers after reconnect without a presence event or replaying a healthy peer', async () => {
      presence.set(deviceId, true);
      presence.clear(); // The old connection verdict is invalidated on disconnect.
      refs.push({ deviceId: 'device-b', topics: ['sessions'] });
      const healthy = deferred<unknown>();
      let attempts = 0;
      remoteSubscribe.mockImplementation((id) => {
        if (id === 'device-b') return healthy.promise;
        return ++attempts === 1 ? Promise.reject(new Error('temporary')) : Promise.resolve();
      });

      scheduler.replay('ws-online');
      await vi.advanceTimersByTimeAsync(2_999);
      expect(remoteSubscribe).toHaveBeenCalledTimes(2);
      refs[0].topics = ['session:one', 'session:two'];
      await vi.advanceTimersByTimeAsync(1);
      expect(remoteSubscribe).toHaveBeenCalledTimes(3);
      expect(remoteSubscribe).toHaveBeenLastCalledWith(deviceId, ['session:one', 'session:two']);
      healthy.resolve(undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(remoteSubscribe.mock.calls.filter(([id]) => id === 'device-b')).toHaveLength(1);
      expect(remoteSubscribe).toHaveBeenCalledTimes(3);
    });

    it('keeps exponential backoff capped at 30 seconds while presence stays unknown', async () => {
      scheduler.replay('ws-online');
      let attempts = 1;
      for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(remoteSubscribe).toHaveBeenCalledTimes(attempts);
        await vi.advanceTimersByTimeAsync(1);
        expect(remoteSubscribe).toHaveBeenCalledTimes(++attempts);
      }
    });

    it('stops on explicit unavailability and resumes on the next online trigger', async () => {
      scheduler.replay('ws-online');
      await vi.advanceTimersByTimeAsync(0);
      presence.set(deviceId, false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(remoteSubscribe).toHaveBeenCalledTimes(1);

      presence.set(deviceId, true);
      remoteSubscribe.mockResolvedValue(undefined);
      scheduler.replay('presence-online', deviceId);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(remoteSubscribe).toHaveBeenCalledTimes(2);
    });

    it.each(['relay-offline', 'torn-down', 'unresponsive', 'unsubscribed', 'cancel', 'teardown'])(
      'does not retry unknown presence after %s', async (gate) => {
        scheduler.replay('ws-online');
        await vi.advanceTimersByTimeAsync(0);
        if (gate === 'relay-offline') relayOnline = false;
        if (gate === 'torn-down') tornDown = true;
        if (gate === 'unresponsive') unresponsive = true;
        if (gate === 'unsubscribed') refs = [];
        if (gate === 'cancel') scheduler.cancel(deviceId);
        if (gate === 'teardown') scheduler.teardown();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(remoteSubscribe).toHaveBeenCalledTimes(1);
      },
    );

    it('stops when an unknown peer retry receives a permanent rejection', async () => {
      remoteSubscribe.mockRejectedValueOnce(new Error('temporary'))
        .mockRejectedValue(new Error('[ACCESS_REVOKED] denied'));
      scheduler.replay('ws-online');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(remoteSubscribe).toHaveBeenCalledTimes(2);
    });

    it.each([
      new Error('[DEVICE_OFFLINE] offline'),
      new DeviceLinkError('DEVICE_OFFLINE', 'offline'),
    ])('stops unknown recovery on explicit offline response %s and resumes on directory online', async (error) => {
      remoteSubscribe.mockRejectedValue(error);
      scheduler.replay('ws-online');
      await vi.advanceTimersByTimeAsync(120_000);
      expect(remoteSubscribe).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(presence.has(deviceId)).toBe(false);

      directoryOnline.set(deviceId, true);
      remoteSubscribe.mockResolvedValue(undefined);
      scheduler.replay('directory-online', deviceId);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(remoteSubscribe).toHaveBeenCalledTimes(2);
    });

    it('stops on directory offline and retries again after the directory reports online', async () => {
      scheduler.replay('ws-online');
      await vi.advanceTimersByTimeAsync(0);
      directoryOnline.set(deviceId, false);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(remoteSubscribe).toHaveBeenCalledTimes(1);

      directoryOnline.set(deviceId, true);
      scheduler.replay('directory-online', deviceId);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(remoteSubscribe).toHaveBeenCalledTimes(3);
      expect(presence.has(deviceId)).toBe(false);
    });

    it.each(['before request', 'while request pending'])(
      'preserves the existing policy when presence becomes true %s', async (when) => {
        const first = deferred<unknown>();
        remoteSubscribe.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
        if (when === 'before request') presence.set(deviceId, true);
        scheduler.replay('ws-online');
        if (when === 'while request pending') presence.set(deviceId, true);
        first.reject(new DeviceLinkError('DEVICE_OFFLINE', 'route offline without a presence update'));
        await vi.advanceTimersByTimeAsync(3_000);
        expect(remoteSubscribe).toHaveBeenCalledTimes(2);
        expect(presence.get(deviceId)).toBe(true);
      },
    );

    it('does not lose an online trigger queued before the offline response settles', async () => {
      const first = deferred<unknown>();
      remoteSubscribe.mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
      scheduler.replay('ws-online');
      directoryOnline.set(deviceId, true);
      scheduler.replay('directory-online', deviceId);
      first.reject(new DeviceLinkError('DEVICE_OFFLINE', 'late response'));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(remoteSubscribe).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('coalesces ws/presence triggers and replays the latest snapshot after settle', async () => {
    const deviceId = 'device-a';
    let refs = [{ deviceId, topics: ['session:one'] }];
    const first = deferred<unknown>();
    const calls: string[][] = [];
    const remoteSubscribe = vi
      .fn<(id: string, topics: string[]) => Promise<unknown>>()
      .mockImplementation((_id, topics) => {
        calls.push([...topics]);
        return calls.length === 1 ? first.promise : Promise.resolve();
      });
    const scheduler = createSubscriptionReplayScheduler({
      snapshotSubscriptions: () => refs,
      remoteSubscribe,
      isLinkTornDown: () => false,
      isRelayOnline: () => true,
      isDeviceUnresponsive: () => false,
      getPresenceAvailability: () => true,
      isPermanentError: () => false,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    scheduler.replay('ws-online');
    scheduler.replay('presence-online', deviceId);
    refs = [{ deviceId, topics: ['session:one', 'session:two'] }];

    expect(remoteSubscribe).toHaveBeenCalledTimes(1);
    first.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual([['session:one'], ['session:one', 'session:two']]);
  });

  it('does not let an old request clear a new generation after teardown and reacquire', async () => {
    const deviceId = 'device-a';
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    let call = 0;
    const remoteSubscribe = vi.fn<(id: string, topics: string[]) => Promise<unknown>>().mockImplementation(() => {
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });
    const scheduler = createSubscriptionReplayScheduler({
      snapshotSubscriptions: () => [{ deviceId, topics: ['session:one'] }],
      remoteSubscribe,
      isLinkTornDown: () => false,
      isRelayOnline: () => true,
      isDeviceUnresponsive: () => false,
      getPresenceAvailability: () => true,
      isPermanentError: () => false,
      log: { debug: vi.fn(), warn: vi.fn() },
    });

    scheduler.replay('ws-online');
    scheduler.teardown();
    scheduler.replay('ws-online-reacquire');
    expect(remoteSubscribe).toHaveBeenCalledTimes(2);

    first.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(remoteSubscribe).toHaveBeenCalledTimes(2);

    second.resolve(undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(remoteSubscribe).toHaveBeenCalledTimes(2);
  });

  it('invalidates retry timers from an old generation', async () => {
    vi.useFakeTimers();
    try {
      const deviceId = 'device-a';
      const remoteSubscribe = vi
        .fn<(id: string, topics: string[]) => Promise<unknown>>()
        .mockRejectedValue(new Error('temporary'));
      const scheduler = createSubscriptionReplayScheduler({
        snapshotSubscriptions: () => [{ deviceId, topics: ['session:one'] }],
        remoteSubscribe,
        isLinkTornDown: () => false,
        isRelayOnline: () => true,
        isDeviceUnresponsive: () => false,
        getPresenceAvailability: () => true,
        isPermanentError: () => false,
        log: { debug: vi.fn(), warn: vi.fn() },
        retryBaseMs: 10,
      });

      scheduler.replay('old-generation');
      await Promise.resolve();
      await Promise.resolve();
      expect(remoteSubscribe).toHaveBeenCalledTimes(1);

      scheduler.teardown();
      await vi.advanceTimersByTimeAsync(100);
      expect(remoteSubscribe).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
