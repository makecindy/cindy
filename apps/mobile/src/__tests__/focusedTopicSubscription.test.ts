import { describe, expect, it, vi } from 'vitest';
import {
  readAfterTopicSubscriptionAck,
  startFocusedTopicSubscription,
} from '@/device-link/focusedTopicSubscription';

type TopicFn = (owner: string, deviceId: string, topics: string[]) => Promise<void>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('startFocusedTopicSubscription', () => {
  it('unsubscribes the focused heavy topic on blur after subscribe has landed', async () => {
    const subscribe = vi.fn<TopicFn>(async () => undefined);
    const unsubscribe = vi.fn<TopicFn>(async () => undefined);

    const cleanup = startFocusedTopicSubscription({
      deviceId: 'dev-1',
      owner: 'session:s1',
      subscribe,
      topic: 'session:s1',
      unsubscribe,
    });
    await Promise.resolve();

    cleanup();

    const owner = subscribe.mock.calls[0]?.[0];
    expect(owner).toEqual(expect.stringMatching(/^session:s1:focus:[a-z0-9]+$/));
    expect(subscribe).toHaveBeenCalledWith(owner, 'dev-1', ['session:s1']);
    expect(unsubscribe).toHaveBeenCalledWith(owner, 'dev-1', ['session:s1']);
  });

  it('sends a second cleanup after subscribe acknowledgement when blur happens immediately', async () => {
    const pending = deferred();
    const subscribe = vi.fn<TopicFn>(() => pending.promise);
    const unsubscribe = vi.fn<TopicFn>(async () => undefined);

    const cleanup = startFocusedTopicSubscription({
      deviceId: 'dev-1',
      owner: 'session:s1',
      subscribe,
      topic: 'session:s1',
      unsubscribe,
    });
    cleanup();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith(subscribe.mock.calls[0]?.[0], 'dev-1', ['session:s1']);

    pending.resolve();
    await pending.promise;
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenLastCalledWith(subscribe.mock.calls[0]?.[0], 'dev-1', ['session:s1']);
  });

  it('sends the second cleanup when subscribe rejects after blur', async () => {
    const pending = deferred();
    const subscribe = vi.fn<TopicFn>(() => pending.promise);
    const unsubscribe = vi.fn<TopicFn>(async () => undefined);

    const cleanup = startFocusedTopicSubscription({
      deviceId: 'dev-1',
      owner: 'session:s1',
      subscribe,
      topic: 'session:s1',
      unsubscribe,
    });
    cleanup();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledWith(subscribe.mock.calls[0]?.[0], 'dev-1', ['session:s1']);

    pending.reject(new Error('subscribe timeout'));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();

    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenLastCalledWith(subscribe.mock.calls[0]?.[0], 'dev-1', ['session:s1']);
  });

  it('does not let an old blur cleanup release a newer focus owner', async () => {
    const first = deferred();
    const subscribe = vi
      .fn<TopicFn>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);
    const unsubscribe = vi.fn<TopicFn>(async () => undefined);

    const cleanupFirst = startFocusedTopicSubscription({
      deviceId: 'dev-1',
      owner: 'session:s1',
      subscribe,
      topic: 'session:s1',
      unsubscribe,
    });
    cleanupFirst();
    const cleanupSecond = startFocusedTopicSubscription({
      deviceId: 'dev-1',
      owner: 'session:s1',
      subscribe,
      topic: 'session:s1',
      unsubscribe,
    });
    await Promise.resolve();

    first.resolve();
    await first.promise;
    await Promise.resolve();

    const firstOwner = subscribe.mock.calls[0]?.[0];
    const secondOwner = subscribe.mock.calls[1]?.[0];
    expect(firstOwner).not.toBe(secondOwner);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(unsubscribe).toHaveBeenNthCalledWith(1, firstOwner, 'dev-1', ['session:s1']);
    expect(unsubscribe).toHaveBeenNthCalledWith(2, firstOwner, 'dev-1', ['session:s1']);

    cleanupSecond();
    expect(unsubscribe).toHaveBeenCalledTimes(3);
    expect(unsubscribe).toHaveBeenLastCalledWith(secondOwner, 'dev-1', ['session:s1']);
  });
});

describe('readAfterTopicSubscriptionAck', () => {
  it('starts the authoritative read only after the remote subscription is acknowledged', async () => {
    const events: string[] = [];
    const pending = deferred();
    const subscribe = vi.fn<TopicFn>(() => {
      events.push('subscribe');
      return pending.promise.then(() => {
        events.push('ack');
      });
    });
    const unsubscribe = vi.fn<TopicFn>(async () => {
      events.push('unsubscribe');
    });

    const result = readAfterTopicSubscriptionAck({
      deviceId: 'dev-1',
      owner: 'message-sync:s1:1',
      subscribe,
      topic: 'session:s1',
      unsubscribe,
      read: async () => {
        events.push('read');
        return 'snapshot';
      },
    });
    await Promise.resolve();
    expect(events).toEqual(['subscribe']);

    pending.resolve();
    await expect(result).resolves.toBe('snapshot');
    expect(events).toEqual(['subscribe', 'ack', 'read', 'unsubscribe']);
  });

  it('releases the temporary owner when subscribe or read fails', async () => {
    const unsubscribe = vi.fn<TopicFn>(async () => undefined);
    await expect(readAfterTopicSubscriptionAck({
      deviceId: 'dev-1',
      owner: 'message-sync:s1:subscribe-error',
      subscribe: vi.fn<TopicFn>(async () => {
        throw new Error('subscribe failed');
      }),
      topic: 'session:s1',
      unsubscribe,
      read: vi.fn(async () => 'never'),
    })).rejects.toThrow('subscribe failed');
    expect(unsubscribe).toHaveBeenCalledWith(
      'message-sync:s1:subscribe-error',
      'dev-1',
      ['session:s1'],
    );

    await expect(readAfterTopicSubscriptionAck({
      deviceId: 'dev-1',
      owner: 'message-sync:s1:read-error',
      subscribe: vi.fn<TopicFn>(async () => undefined),
      topic: 'session:s1',
      unsubscribe,
      read: async () => {
        throw new Error('read failed');
      },
    })).rejects.toThrow('read failed');
    expect(unsubscribe).toHaveBeenCalledWith(
      'message-sync:s1:read-error',
      'dev-1',
      ['session:s1'],
    );
  });
});
