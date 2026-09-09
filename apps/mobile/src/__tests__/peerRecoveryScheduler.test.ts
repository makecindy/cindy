import { describe, expect, it, vi } from 'vitest';
import { resolveHomeConnectionFeedback } from '@/components/connectionBannerVisibility';
import {
  PeerRecoveryOpenIntentRegistry,
  PeerRecoveryScheduler,
} from '@/device-link/peerRecoveryScheduler';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('PeerRecoveryScheduler', () => {
  it('hands recovery off to queued Home hydration without exposing the old manual failure', async () => {
    const subscribed = deferred<void>();
    const syncing = new Set<string>();
    const scheduler = new PeerRecoveryScheduler(async (id) => {
      await subscribed.promise;
      // Home reseed marks syncing before its limiter starts the snapshot reads.
      syncing.add(id);
      return { retry: false };
    });
    const failure = { deviceId: 'a', deviceName: 'Mac', error: '[INVOKE_TIMEOUT] failed' };
    const feedback = () => resolveHomeConnectionFeedback(failure, new Set([...scheduler.getActiveDeviceIds(), ...syncing]));
    scheduler.request('a');
    expect(feedback().deviceRecovery).toBe(true);
    subscribed.resolve();
    await flush();
    expect(scheduler.getActiveDeviceIds().size).toBe(0);
    expect(feedback().deviceRecovery).toBe(true);
    syncing.delete('a');
    // A failed hydrate may retain the ordinary error; only now is manual retry available.
    expect(feedback().deviceRecovery).toBe(false);
    expect(resolveHomeConnectionFeedback(null, syncing).error).toBeNull();
  });
  it('publishes stable active snapshots across queue, retry, completion and cancellation', async () => {
    vi.useFakeTimers();
    try {
      const first = deferred<{ retry: boolean }>();
      const scheduler = new PeerRecoveryScheduler(() => first.promise, { maxConcurrent: 1 });
      const changed = vi.fn();
      const off = scheduler.subscribe(changed);
      const initial = scheduler.getActiveDeviceIds();
      scheduler.requestMany(['a', 'b']);
      expect([...scheduler.getActiveDeviceIds()]).toEqual(['a', 'b']);
      expect(initial.size).toBe(0);
      const active = scheduler.getActiveDeviceIds();
      first.resolve({ retry: true });
      await flush();
      expect(scheduler.getActiveDeviceIds()).toBe(active);
      scheduler.cancel('a');
      expect([...scheduler.getActiveDeviceIds()]).toEqual(['b']);
      scheduler.pause();
      expect(scheduler.getActiveDeviceIds().size).toBe(0);
      const calls = changed.mock.calls.length;
      off();
      scheduler.clear();
      expect(changed).toHaveBeenCalledTimes(calls);
    } finally { vi.useRealTimers(); }
  });

  it('keeps a re-request visible while a cancelled generation settles', async () => {
    const old = deferred<{ retry: boolean }>();
    const next = deferred<{ retry: boolean }>();
    const run = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const scheduler = new PeerRecoveryScheduler(run);
    scheduler.request('a');
    scheduler.cancel('a');
    expect(scheduler.getActiveDeviceIds().size).toBe(0);
    scheduler.request('a');
    expect(scheduler.getActiveDeviceIds().has('a')).toBe(true);
    old.resolve({ retry: false });
    await flush();
    expect(scheduler.getActiveDeviceIds().has('a')).toBe(true);
    next.resolve({ retry: false });
    await flush();
    expect(scheduler.getActiveDeviceIds().size).toBe(0);
  });
  it('does not let an old forced-open completion clear a newer intent for the same peer', () => {
    const intents = new PeerRecoveryOpenIntentRegistry();
    const first = intents.request('desktop-a');
    intents.cancel('desktop-a');
    const second = intents.request('desktop-a');

    expect(second).toBeGreaterThan(first);
    expect(intents.complete('desktop-a', first)).toBe(false);
    expect(intents.has('desktop-a')).toBe(true);
    expect(intents.complete('desktop-a', second)).toBe(true);
    expect(intents.has('desktop-a')).toBe(false);
  });

  it('runs up to six peer recoveries by default', () => {
    const started: string[] = [];
    const scheduler = new PeerRecoveryScheduler((deviceId) => {
      started.push(deviceId);
      return deferred<{ retry: boolean }>().promise;
    });

    scheduler.requestMany(['a', 'b', 'c', 'd', 'e', 'f', 'g']);

    expect(started).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(scheduler.getSnapshot('g').phase).toBe('queued');
  });

  it('lets healthy peers recover while one peer is stalled', async () => {
    const stalled = deferred<{ retry: boolean }>();
    const completed: string[] = [];
    const scheduler = new PeerRecoveryScheduler(
      async (deviceId) => {
        if (deviceId === 'desktop-a') return stalled.promise;
        completed.push(deviceId);
        return { retry: false };
      },
      { maxConcurrent: 3 },
    );

    scheduler.requestMany(['desktop-a', 'desktop-b', 'desktop-c']);
    await flush();

    expect(completed).toEqual(['desktop-b', 'desktop-c']);
    expect(scheduler.getSnapshot('desktop-a').phase).toBe('running');
    expect(scheduler.getSnapshot('desktop-b').phase).toBe('idle');
    stalled.resolve({ retry: true });
    await flush();
  });

  it('bounds recovery concurrency without making peers share lifecycle state', async () => {
    const releases = new Map<string, ReturnType<typeof deferred<{ retry: boolean }>>>();
    const started: string[] = [];
    const scheduler = new PeerRecoveryScheduler(
      (deviceId) => {
        started.push(deviceId);
        const run = deferred<{ retry: boolean }>();
        releases.set(deviceId, run);
        return run.promise;
      },
      { maxConcurrent: 2 },
    );

    scheduler.requestMany(['a', 'b', 'c']);
    expect(started).toEqual(['a', 'b']);
    expect(scheduler.getSnapshot('c').phase).toBe('queued');

    releases.get('b')?.resolve({ retry: false });
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    expect(scheduler.getSnapshot('a').phase).toBe('running');
  });

  it('keeps retry backoff per peer', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const scheduler = new PeerRecoveryScheduler(
      async (deviceId) => {
        calls.push(deviceId);
        return { retry: deviceId === 'a' };
      },
      { retryBaseMs: 2_000, retryMaxMs: 30_000 },
    );

    scheduler.requestMany(['a', 'b']);
    await flush();
    expect(scheduler.getSnapshot('a')).toMatchObject({
      phase: 'waiting-retry',
      retryAttempt: 1,
    });
    expect(scheduler.getSnapshot('b').phase).toBe('idle');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(['a', 'b', 'a']);
    expect(scheduler.getSnapshot('a').retryAttempt).toBe(2);
    expect(scheduler.getSnapshot('b').retryAttempt).toBe(0);
    scheduler.clear();
    vi.useRealTimers();
  });

  it('cancels only the selected peer and ignores its late result', async () => {
    const a = deferred<{ retry: boolean }>();
    const b = deferred<{ retry: boolean }>();
    const scheduler = new PeerRecoveryScheduler((deviceId) => (
      deviceId === 'a' ? a.promise : b.promise
    ));

    scheduler.requestMany(['a', 'b']);
    scheduler.cancel('a');
    a.resolve({ retry: true });
    b.resolve({ retry: false });
    await flush();

    expect(scheduler.getSnapshot('a')).toEqual({
      deviceId: 'a',
      phase: 'idle',
      retryAttempt: 0,
    });
    expect(scheduler.getSnapshot('b').phase).toBe('idle');
  });

  it('reruns only the peer requested during its in-flight recovery', async () => {
    const firstA = deferred<{ retry: boolean }>();
    const calls: string[] = [];
    const scheduler = new PeerRecoveryScheduler(async (deviceId) => {
      calls.push(deviceId);
      if (deviceId === 'a' && calls.filter((item) => item === 'a').length === 1) {
        return firstA.promise;
      }
      return { retry: false };
    });

    scheduler.requestMany(['a', 'b']);
    scheduler.request('a');
    firstA.resolve({ retry: false });
    await flush();

    expect(calls).toEqual(['a', 'b', 'a']);
  });
});
