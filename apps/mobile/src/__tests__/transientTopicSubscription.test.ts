import { describe, expect, it, vi } from 'vitest';
import {
  createTransientTopicSubscriptionCoordinator,
} from '@/device-link/transientTopicSubscription';

type RetryOperation = <T>(operation: () => Promise<T>) => Promise<T>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const retryOnce: RetryOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch {
    return operation();
  }
};

describe('transient topic subscription coordinator', () => {
  it('reopens the peer link before independently retrying a failed subscription', async () => {
    const order: string[] = [];
    const subscribe = vi.fn(async () => {
      order.push('subscribe');
      if (subscribe.mock.calls.length === 1) throw new Error('transient');
    });
    const reopenLink = vi.fn(async () => {
      order.push('reopen');
    });
    const coordinator = createTransientTopicSubscriptionCoordinator(retryOnce);

    await coordinator.start({
      identity: 'device-1:session-1:epoch-1',
      isStale: () => false,
      reopenLink,
      subscribe,
    });

    expect(order).toEqual(['subscribe', 'reopen', 'subscribe']);
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(reopenLink).toHaveBeenCalledTimes(1);
  });

  it('keeps one retry loop per recovery identity', async () => {
    const pending = deferred();
    const subscribe = vi.fn(() => pending.promise);
    const coordinator = createTransientTopicSubscriptionCoordinator(retryOnce);
    const request = {
      identity: 'device-1:session-1:epoch-1',
      isStale: () => false,
      reopenLink: vi.fn(async () => undefined),
      subscribe,
    };

    const first = coordinator.start(request);
    const second = coordinator.start(request);

    expect(second).toBe(first);
    expect(subscribe).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;

    await coordinator.start(request);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it('lets a current run replace a stale loop without the old settle clearing it', async () => {
    const firstPending = deferred();
    const secondPending = deferred();
    let firstStale = false;
    const coordinator = createTransientTopicSubscriptionCoordinator(retryOnce);

    const first = coordinator.start({
      identity: 'device-1:session-1:epoch-1',
      isStale: () => firstStale,
      reopenLink: vi.fn(async () => undefined),
      subscribe: vi.fn(() => firstPending.promise),
    });
    firstStale = true;
    const second = coordinator.start({
      identity: 'device-1:session-1:epoch-1',
      isStale: () => false,
      reopenLink: vi.fn(async () => undefined),
      subscribe: vi.fn(() => secondPending.promise),
    });

    expect(second).not.toBe(first);
    firstPending.resolve();
    await first;

    const duplicateOfSecond = coordinator.start({
      identity: 'device-1:session-1:epoch-1',
      isStale: () => false,
      reopenLink: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
    });
    expect(duplicateOfSecond).toBe(second);

    secondPending.resolve();
    await second;
  });

  it('does not retry or re-register an owner after the recovery scope becomes stale', async () => {
    let stale = false;
    const subscribe = vi.fn(async () => {
      stale = true;
      throw new Error('transient');
    });
    const reopenLink = vi.fn(async () => undefined);
    const coordinator = createTransientTopicSubscriptionCoordinator(retryOnce);

    await coordinator.start({
      identity: 'device-1:session-1:epoch-1',
      isStale: () => stale,
      reopenLink,
      subscribe,
    });

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(reopenLink).not.toHaveBeenCalled();
  });

  it('rechecks staleness after reopening before it subscribes again', async () => {
    let stale = false;
    const subscribe = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    const reopenLink = vi.fn(async () => {
      stale = true;
    });
    const coordinator = createTransientTopicSubscriptionCoordinator(retryOnce);

    await coordinator.start({
      identity: 'device-1:session-1:epoch-1',
      isStale: () => stale,
      reopenLink,
      subscribe,
    });

    expect(reopenLink).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});
