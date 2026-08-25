import { describe, expect, it, vi } from 'vitest';

import { createSubscriptionReplayScheduler } from '../subscriptionReplayScheduler';

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
      isPresenceAvailable: () => true,
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
      isPresenceAvailable: () => true,
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
        isPresenceAvailable: () => true,
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
