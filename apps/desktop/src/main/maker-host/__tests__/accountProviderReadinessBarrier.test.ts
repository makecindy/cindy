import { describe, expect, it, vi } from 'vitest';

import {
  createAccountProviderReadinessBarrier,
  isSameOwnerScopeKey,
  ownerIdentityFromScopeKey,
  shouldClearCatalogAfterJoiningPreviousScope,
} from '../account-provider-readiness-barrier.js';

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

    barrier.markDiscoveryComplete();
    task.resolve();
    await vi.waitFor(() => expect(scopeAReady).toBe(true));
  });

  it('fails closed before readiness has been registered for a scope', async () => {
    const barrier = createAccountProviderReadinessBarrier();

    expect(barrier.hasScope('cloud:owner-a:1')).toBe(false);
    await expect(barrier.waitForScope('cloud:owner-a:1')).resolves.toBe(false);
  });

  it('tracks only the current readiness scope', () => {
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => Promise.resolve(), vi.fn());

    expect(barrier.hasScope('cloud:owner-a:1')).toBe(true);
    expect(barrier.hasScope('cloud:owner-b:2')).toBe(false);
    expect(barrier.hasSameOwnerIdentity('cloud:owner-a:3')).toBe(true);

    barrier.start('cloud:owner-b:2', () => Promise.resolve(), vi.fn());
    expect(barrier.hasScope('cloud:owner-a:1')).toBe(false);
    expect(barrier.hasScope('cloud:owner-b:2')).toBe(true);
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

    barrier.markDiscoveryComplete();
    second.resolve();
    await vi.waitFor(() => expect(scopeBReady).toBe(true));
  });

  it('clears the process catalog only after joining a different owner', () => {
    expect(
      shouldClearCatalogAfterJoiningPreviousScope({
        waited: true,
        currentSameOwnerAsNext: true,
      }),
    ).toBe(false);
    expect(
      shouldClearCatalogAfterJoiningPreviousScope({
        waited: true,
        currentSameOwnerAsNext: false,
      }),
    ).toBe(true);
    expect(
      shouldClearCatalogAfterJoiningPreviousScope({
        waited: false,
        currentSameOwnerAsNext: false,
      }),
    ).toBe(false);
  });

  it('parses owner identity from the app-session scope key format', () => {
    expect(ownerIdentityFromScopeKey('cloud:owner-a:1')).toBe('cloud:owner-a');
    expect(ownerIdentityFromScopeKey('cloud:owner-a:3')).toBe('cloud:owner-a');
    expect(isSameOwnerScopeKey('cloud:owner-a:1', 'cloud:owner-a:3')).toBe(true);
    expect(isSameOwnerScopeKey('cloud:owner-a:1', 'cloud:owner-b:2')).toBe(false);
  });

  it('adopts a deferred same-owner generation without starting another task', async () => {
    const task = deferred();
    const runTask = vi.fn(() => task.promise);
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', runTask, vi.fn());
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledOnce());

    const adopting = barrier.adoptSameOwnerAfterPreviousSettles('cloud:owner-a:3');
    expect(barrier.hasScope('cloud:owner-a:3')).toBe(false);
    expect(runTask).toHaveBeenCalledOnce();

    barrier.markDiscoveryComplete();
    task.resolve();
    await expect(adopting).resolves.toBe(true);
    expect(barrier.hasScope('cloud:owner-a:3')).toBe(true);
    expect(barrier.hasScope('cloud:owner-a:1')).toBe(false);
    expect(runTask).toHaveBeenCalledOnce();
    await expect(barrier.waitForScope('cloud:owner-a:3')).resolves.toBe(true);
    expect(barrier.start('cloud:owner-a:3', runTask, vi.fn())).toBeDefined();
    expect(runTask).toHaveBeenCalledOnce();
  });

  it('does not let a late same-owner start replace an adopted generation', async () => {
    const first = deferred();
    const lateTask = vi.fn(() => Promise.resolve());
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => first.promise, vi.fn());
    const adopting = barrier.adoptSameOwnerAfterPreviousSettles('cloud:owner-a:3');

    barrier.markDiscoveryComplete();
    first.resolve();
    await expect(adopting).resolves.toBe(true);
    await expect(barrier.waitForScope('cloud:owner-a:1')).resolves.toBe(false);

    barrier.start('cloud:owner-a:4', lateTask, vi.fn());
    expect(lateTask).not.toHaveBeenCalled();
    expect(barrier.hasScope('cloud:owner-a:3')).toBe(true);
    await expect(barrier.waitForScope('cloud:owner-a:3')).resolves.toBe(true);
  });

  it('refuses to adopt a different owner onto the settled task', async () => {
    const task = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => task.promise, vi.fn());

    await expect(barrier.adoptSameOwnerAfterPreviousSettles('cloud:owner-b:2')).resolves.toBe(
      false,
    );
    expect(barrier.hasScope('cloud:owner-a:1')).toBe(true);
    task.resolve();
    await task.promise;
  });

  it('refuses to adopt an incomplete or invalidated same-owner task', async () => {
    const task = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => task.promise, vi.fn());
    task.resolve();
    await expect(barrier.adoptSameOwnerAfterPreviousSettles('cloud:owner-a:3')).resolves.toBe(
      false,
    );

    barrier.markDiscoveryComplete();
    await expect(barrier.adoptSameOwnerAfterPreviousSettles('cloud:owner-a:3')).resolves.toBe(
      true,
    );
    barrier.invalidateAdoption();
    await expect(barrier.adoptSameOwnerAfterPreviousSettles('cloud:owner-a:4')).resolves.toBe(
      false,
    );
  });

  it('identifies an adoptable entry that settled without completing discovery', async () => {
    const task = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => task.promise, vi.fn());
    task.resolve();
    await task.promise;

    expect(barrier.needsIncompleteDiscoveryResume('cloud:owner-a:3')).toBe(true);
    expect(barrier.needsIncompleteDiscoveryResume('cloud:owner-b:2')).toBe(false);
    barrier.invalidateAdoption();
    expect(barrier.needsIncompleteDiscoveryResume('cloud:owner-a:3')).toBe(false);
  });

  it('does not let a replaced entry mark the next incarnation complete', async () => {
    const firstWork = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    const first = barrier.start(
      'cloud:owner-a:1',
      async (handle) => {
        await firstWork.promise;
        handle.markDiscoveryComplete();
      },
      vi.fn(),
    );

    barrier.invalidateAdoption();
    barrier.start('cloud:owner-a:5', async () => {}, vi.fn());
    firstWork.resolve();
    await first;

    expect(barrier.hasScope('cloud:owner-a:5')).toBe(true);
    expect(barrier.isDiscoveryComplete()).toBe(false);
    expect(barrier.currentHandle()?.isLive()).toBe(true);
  });

  it('keeps a live handle across a same-owner generation bump until adopt', async () => {
    const work = deferred();
    const barrier = createAccountProviderReadinessBarrier();
    let seenLiveAfterBump = false;
    barrier.start(
      'cloud:owner-a:1',
      async (handle) => {
        await work.promise;
        seenLiveAfterBump = handle.isLive();
        handle.markDiscoveryComplete();
      },
      vi.fn(),
    );
    const handle = barrier.currentHandle();
    expect(handle?.isLive()).toBe(true);
    work.resolve();
    await barrier.waitForPreviousScope('cloud:owner-a:3');
    expect(seenLiveAfterBump).toBe(true);
    await expect(barrier.adoptSameOwnerAfterPreviousSettles('cloud:owner-a:3')).resolves.toBe(
      true,
    );
    expect(handle?.isLive()).toBe(false);
    expect(barrier.currentHandle()?.isLive()).toBe(true);
  });

  it('starts a new task after teardown invalidates the previous incarnation', async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', first, vi.fn());
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    barrier.markDiscoveryComplete();
    barrier.invalidateAdoption();

    barrier.start('cloud:owner-a:5', second, vi.fn());
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(barrier.hasScope('cloud:owner-a:5')).toBe(true);
    expect(barrier.hasAdoptableSameOwner('cloud:owner-a:5')).toBe(true);
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
