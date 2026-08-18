import { describe, expect, it, vi } from 'vitest';

import { createAccountProviderReadinessArmBinding } from '../account-provider-readiness-arm.js';
import { createAccountProviderReadinessBarrier } from '../account-provider-readiness-barrier.js';
import {
  ensureCurrentAccountProviderReadiness,
  shouldStartReadinessConsumers,
} from '../account-provider-readiness-ensure.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ensureCurrentAccountProviderReadiness', () => {
  it('starts a new incarnation after logout instead of adopting the pre-logout task', async () => {
    const barrier = createAccountProviderReadinessBarrier();
    const first = vi.fn(async () => {
      barrier.markDiscoveryComplete();
    });
    const second = vi.fn(async () => {
      barrier.markDiscoveryComplete();
    });
    const arm = createAccountProviderReadinessArmBinding();
    arm.publish('owner-a', () => {
      barrier.start('cloud:owner-a:5', second, vi.fn());
    });

    barrier.start('cloud:owner-a:1', first, vi.fn());
    await vi.waitFor(() => expect(first).toHaveBeenCalledOnce());
    barrier.invalidateAdoption();

    const ready = await ensureCurrentAccountProviderReadiness({
      barrier,
      startIfOwnerMatches: (ownerId) => arm.startIfOwnerMatches(ownerId),
      getScopeKey: () => 'cloud:owner-a:5',
      getOwnerId: () => 'owner-a',
      isBoundaryPending: () => false,
    });

    expect(ready).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(barrier.hasScope('cloud:owner-a:5')).toBe(true);
  });

  it('resumes incomplete same-owner discovery instead of launching a blocked full start', async () => {
    const task = deferred();
    const start = vi.fn(() => {
      throw new Error('full start must not run while an adoptable same-owner entry exists');
    });
    const barrier = createAccountProviderReadinessBarrier();
    barrier.start('cloud:owner-a:1', () => task.promise, vi.fn());
    task.resolve();
    await task.promise;

    const resume = vi.fn(async () => {
      expect(barrier.hasAdoptableSameOwner('cloud:owner-a:3')).toBe(true);
      expect(barrier.isDiscoveryComplete()).toBe(false);
      barrier.markDiscoveryComplete();
      return true;
    });

    const ready = await ensureCurrentAccountProviderReadiness({
      barrier,
      startIfOwnerMatches: start,
      resumeIncompleteDiscovery: resume,
      getScopeKey: () => 'cloud:owner-a:3',
      getOwnerId: () => 'owner-a',
      isBoundaryPending: () => false,
    });

    expect(resume).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(ready).toBe(true);
    expect(barrier.hasScope('cloud:owner-a:3')).toBe(true);
  });

  it('notifies consumers once after a successful same-owner adopt', async () => {
    const barrier = createAccountProviderReadinessBarrier();
    const task = deferred();
    barrier.start('cloud:owner-a:1', () => task.promise, vi.fn());
    barrier.markDiscoveryComplete();
    task.resolve();

    const onReady = vi.fn();
    const first = ensureCurrentAccountProviderReadiness({
      barrier,
      startIfOwnerMatches: vi.fn(),
      getScopeKey: () => 'cloud:owner-a:3',
      getOwnerId: () => 'owner-a',
      isBoundaryPending: () => false,
      onReady,
    });
    const second = ensureCurrentAccountProviderReadiness({
      barrier,
      startIfOwnerMatches: vi.fn(),
      getScopeKey: () => 'cloud:owner-a:3',
      getOwnerId: () => 'owner-a',
      isBoundaryPending: () => false,
      onReady,
    });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledWith('owner-a');
  });
});

describe('shouldStartReadinessConsumers', () => {
  it('allows same-owner generation rollover and rejects a real owner change', () => {
    expect(
      shouldStartReadinessConsumers({
        capturedScopeKey: 'cloud:owner-a:1',
        currentScopeKey: 'cloud:owner-a:3',
        boundaryPending: false,
        adoptable: true,
      }),
    ).toBe(true);
    expect(
      shouldStartReadinessConsumers({
        capturedScopeKey: 'cloud:owner-a:1',
        currentScopeKey: 'cloud:owner-b:2',
        boundaryPending: false,
        adoptable: true,
      }),
    ).toBe(false);
    expect(
      shouldStartReadinessConsumers({
        capturedScopeKey: 'cloud:owner-a:1',
        currentScopeKey: 'cloud:owner-a:3',
        boundaryPending: false,
        adoptable: false,
      }),
    ).toBe(false);
  });
});
