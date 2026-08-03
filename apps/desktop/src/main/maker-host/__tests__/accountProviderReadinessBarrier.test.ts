import { describe, expect, it, vi } from 'vitest';

import { createAccountProviderReadinessBarrier } from '../account-provider-readiness-barrier.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('createAccountProviderReadinessBarrier', () => {
  it('blocks only work belonging to the active readiness scope', async () => {
    const task = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => task.promise, vi.fn());

    let scopeAReady = false;
    void barrier.waitForScope('cloud:owner-a:1').then(() => {
      scopeAReady = true;
    });

    await expect(barrier.waitForScope('cloud:owner-b:2')).resolves.toBe(false);
    expect(scopeAReady).toBe(false);

    task.resolve();
    await vi.waitFor(() => expect(scopeAReady).toBe(true));
  });

  it('fails closed before readiness has been registered for a scope', async () => {
    const barrier = createAccountProviderReadinessBarrier();

    await expect(barrier.waitForScope('cloud:owner-a:1')).resolves.toBe(false);
  });

  it('keeps a new scope behind the previous scope task, including the same owner relogin', async () => {
    const task = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => task.promise, vi.fn());

    let switched = false;
    const waiting = barrier.waitForPreviousScope('cloud:owner-a:3').then((waited) => {
      expect(waited).toBe(true);
      switched = true;
    });
    await Promise.resolve();
    expect(switched).toBe(false);

    task.resolve();
    await waiting;
    expect(switched).toBe(true);
  });

  it('joins duplicate starts for the same scope', async () => {
    const task = deferred();
    const runTask = vi.fn(() => task.promise);
    const barrier = createAccountProviderReadinessBarrier();

    const first = barrier.start('cloud:owner-a:1', runTask, vi.fn());
    const second = barrier.start('cloud:owner-a:1', runTask, vi.fn());
    expect(second).toBe(first);
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledOnce());

    task.resolve();
    await first;
  });

  it('settles rejected work after reporting it', async () => {
    const failure = new Error('discovery failed');
    const onError = vi.fn();
    const barrier = createAccountProviderReadinessBarrier();

    const readiness = barrier.start(
      'cloud:owner-a:1',
      async () => {
        throw failure;
      },
      onError,
    );

    await expect(readiness).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
    await expect(barrier.waitForPreviousScope('cloud:owner-b:2')).resolves.toBe(true);
  });

  it('does not let an older completion clear a newer scope task', async () => {
    const first = deferred();
    const second = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => first.promise, vi.fn());
    barrier.start('cloud:owner-b:2', () => second.promise, vi.fn());

    first.resolve();
    await first.promise;

    let scopeBReady = false;
    void barrier.waitForScope('cloud:owner-b:2').then(() => {
      scopeBReady = true;
    });
    await Promise.resolve();
    expect(scopeBReady).toBe(false);

    second.resolve();
    await vi.waitFor(() => expect(scopeBReady).toBe(true));
  });

  it('fails a waiter whose scope was replaced before its task settled', async () => {
    const first = deferred();
    const second = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => first.promise, vi.fn());
    const firstWaiter = barrier.waitForScope('cloud:owner-a:1');

    barrier.start('cloud:owner-b:2', () => second.promise, vi.fn());
    first.resolve();
    await expect(firstWaiter).resolves.toBe(false);

    second.resolve();
  });
});
