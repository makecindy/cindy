import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRemoteSyncCoordinator,
  createRemoteSyncReopenCoordinator,
  createRemoteSyncRunner,
  waitForCachedSubscription,
} from '@/device-link/remoteSyncTask';
import { SubscriptionAcknowledgements } from '@/device-link/subscriptionAcknowledgements';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
afterEach(() => vi.useRealTimers());

describe('remote sync task runner', () => {
  // Unit: a cached return used to read before ACK and repeat the whole batch.
  // Bound the optimization without delaying cold reads or losing late recovery.
  it.each(['ack', 'timeout', 'failure', 'cancel', 'cold'] as const)('bounds cached subscription waiting: %s', async (outcome) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const subscription = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const run = { signal: controller.signal, isStale: () => controller.signal.aborted };
    let settled = false;
    let ack = false;
    const waiting = waitForCachedSubscription(run, outcome !== 'cold', subscription, () => ack).then(() => { settled = true; });
    const observed = waiting.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(outcome === 'cold');
      if (outcome === 'ack') { ack = true; resolve(); }
      if (outcome === 'failure') reject(new Error('offline'));
      if (outcome === 'cancel') controller.abort();
      if (outcome === 'timeout') await vi.advanceTimersByTimeAsync(2000);
      await observed;
      if (outcome === 'cancel') await expect(waiting).rejects.toThrow('superseded');
      else expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      resolve(); // A late ACK may still drive the existing recovery effect.
    } finally { vi.useRealTimers(); }
  });

  it('shares one successful peer reopen across staggered retries in the same sync run', async () => {
    const reopen = vi.fn(async () => undefined);
    const coordinator = createRemoteSyncReopenCoordinator(reopen);
    const failedAtVersion = coordinator.captureVersion();

    const first = coordinator.reopenAfter(failedAtVersion);
    await first;
    const later = coordinator.reopenAfter(failedAtVersion);

    expect(later).toBe(first);
    await later;
    expect(reopen).toHaveBeenCalledTimes(1);
  });

  it('allows a new reopen when an operation fails after the previous recovery', async () => {
    const reopen = vi.fn(async () => undefined);
    const coordinator = createRemoteSyncReopenCoordinator(reopen);

    await coordinator.reopenAfter(coordinator.captureVersion());
    const requestStartedAfterRecovery = coordinator.captureVersion();
    await coordinator.reopenAfter(requestStartedAfterRecovery);

    expect(reopen).toHaveBeenCalledTimes(2);
    expect(coordinator.captureVersion()).toBe(2);
  });

  it('allows the same sync run to retry after a failed peer reopen', async () => {
    const reopen = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const coordinator = createRemoteSyncReopenCoordinator(reopen);
    const failedAtVersion = coordinator.captureVersion();

    await expect(coordinator.reopenAfter(failedAtVersion)).rejects.toThrow('offline');
    await expect(coordinator.reopenAfter(failedAtVersion)).resolves.toBeUndefined();
    expect(reopen).toHaveBeenCalledTimes(2);
  });

  it('coalesces repeated triggers into one in-flight run and one follow-up run', async () => {
    const gates = [deferred(), deferred()];
    const starts: number[] = [];
    const runner = createRemoteSyncRunner(async () => {
      const index = starts.length;
      starts.push(index);
      await gates[index].promise;
    });

    const first = runner.run();
    const second = runner.run();
    const third = runner.run();

    expect(runner.isRunning()).toBe(true);
    expect(starts).toEqual([0]);
    expect(second).toBe(first);
    expect(third).toBe(first);

    gates[0].resolve();
    await nextTick();
    expect(starts).toEqual([0, 1]);

    gates[1].resolve();
    await first;

    expect(runner.isRunning()).toBe(false);
    expect(starts).toEqual([0, 1]);
  });

  it('runs again normally after the previous drain finishes', async () => {
    let count = 0;
    const runner = createRemoteSyncRunner(async () => {
      count += 1;
    });

    await runner.run();
    await runner.run();

    expect(count).toBe(2);
  });
});

describe('remote sync coordinator', () => {
  // Unit, PR #6325: previous tests had one promise for one connection. A completed
  // old subscription (or only the new list ACK) must not start a cached read while
  // the current detail ACK is missing. Exercise the production ACK table + waiter.
  it('waits for current detail ACK after a focused reconnect', async () => {
    vi.useFakeTimers();
    const acks = new SubscriptionAcknowledgements(() => {});
    const topics = ['sessions', 'session:s'] as const;
    acks.set('d', new Set(topics));
    const previousSubscription = Promise.resolve();
    await previousSubscription;
    acks.delete('d');
    acks.set('d', new Set(['sessions']));
    const controller = new AbortController();
    let reads = 0;
    const waiting = waitForCachedSubscription(
      { signal: controller.signal }, true, previousSubscription,
      () => acks.identity('d', topics) !== null,
    ).then(() => { reads++; });
    await vi.advanceTimersByTimeAsync(500);
    expect(reads).toBe(0);
    acks.set('d', new Set(topics));
    await vi.advanceTimersByTimeAsync(50);
    await waiting;
    expect(reads).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Unit: the ACK may land during cached-return preparation or after the first
  // snapshot starts. Only the former can safely remove the recovery batch.
  it.each([false, true])('coalesces cached return but preserves an ACK after snapshot start (%s)', async (lateAck) => {
    vi.useFakeTimers();
    const subscription = deferred();
    const snapshot = deferred();
    let ack = false;
    let reads = 0;
    const coordinator = createRemoteSyncCoordinator(async run => {
      await waitForCachedSubscription(run, true, subscription.promise, () => ack);
      const covered = ack;
      reads++;
      await snapshot.promise;
      if (covered) run.satisfy('subscription-acked');
    });
    coordinator.setContext('device:session:visit');
    const sync = coordinator.request({ reason: 'passive-refresh' });
    await vi.advanceTimersByTimeAsync(lateAck ? 2000 : 0);
    expect(reads).toBe(lateAck ? 1 : 0);
    ack = true;
    subscription.resolve();
    void coordinator.request({ reason: 'subscription-acked' });
    snapshot.resolve();
    await sync;
    expect(reads).toBe(lateAck ? 2 : 1);
    expect(coordinator.isRunning()).toBe(false);
  });

  it('merges repeated passive requests into one follow-up run', async () => {
    const gates = [deferred(), deferred()];
    const runs: Array<{ reasons: readonly string[]; replaceMessages: boolean }> = [];
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      const index = runs.length;
      runs.push({ reasons: run.reasons, replaceMessages: run.replaceMessages });
      await gates[index].promise;
    });
    coordinator.setContext('dev-1:session-1');

    const first = coordinator.request({ reason: 'mount' });
    const second = coordinator.request({ reason: 'presence' });
    const third = coordinator.request({ reason: 'breaker' });

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(runs).toEqual([{ reasons: ['mount'], replaceMessages: false }]);

    gates[0].resolve();
    await nextTick();
    expect(runs).toEqual([
      { reasons: ['mount'], replaceMessages: false },
      { reasons: ['presence', 'breaker'], replaceMessages: false },
    ]);

    gates[1].resolve();
    await first;
    expect(coordinator.isRunning()).toBe(false);
  });

  it('lets an authoritative replacement invalidate an in-flight passive run', async () => {
    const gates = [deferred(), deferred()];
    const staleChecks: Array<() => boolean> = [];
    const replaceModes: boolean[] = [];
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      const index = replaceModes.length;
      replaceModes.push(run.replaceMessages);
      staleChecks.push(run.isStale);
      await gates[index].promise;
    });
    coordinator.setContext('dev-1:session-1');

    const task = coordinator.request({ reason: 'mount' });
    expect(staleChecks[0]()).toBe(false);
    void coordinator.request({ reason: 'rewind', replaceMessages: true });
    expect(staleChecks[0]()).toBe(true);

    gates[0].resolve();
    await nextTick();
    expect(replaceModes).toEqual([false, true]);
    expect(staleChecks[1]()).toBe(false);

    gates[1].resolve();
    await task;
  });

  it('invalidates old identity runs and drops their queued follow-up', async () => {
    const gates = [deferred(), deferred()];
    const runs: Array<{ reasons: readonly string[]; isStale: () => boolean }> = [];
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      const index = runs.length;
      runs.push({ reasons: run.reasons, isStale: run.isStale });
      await gates[index].promise;
    });
    coordinator.setContext('dev-1:session-a');

    const task = coordinator.request({ reason: 'mount-a' });
    void coordinator.request({ reason: 'retry-a' });
    coordinator.setContext('dev-1:session-b');
    void coordinator.request({ reason: 'mount-b' });

    expect(runs[0].isStale()).toBe(true);
    gates[0].resolve();
    await nextTick();
    expect(runs.map((run) => run.reasons)).toEqual([['mount-a'], ['mount-b']]);
    expect(runs[1].isStale()).toBe(false);

    gates[1].resolve();
    await task;
  });

  it('continues with a queued follow-up after a failed run', async () => {
    const runs: string[][] = [];
    const firstStarted = deferred();
    const coordinator = createRemoteSyncCoordinator(async (run) => {
      runs.push([...run.reasons]);
      if (runs.length === 1) {
        firstStarted.resolve();
        await nextTick();
        throw new Error('first failed');
      }
    });
    coordinator.setContext('dev-1:session-1');

    const task = coordinator.request({ reason: 'first' });
    await firstStarted.promise;
    void coordinator.request({ reason: 'follow-up' });

    await expect(task).rejects.toThrow('first failed');
    expect(runs).toEqual([['first'], ['follow-up']]);
  });
});
