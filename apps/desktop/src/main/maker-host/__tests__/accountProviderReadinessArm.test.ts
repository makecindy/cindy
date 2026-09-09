import { describe, expect, it, vi } from 'vitest';

import {
  createAccountProviderReadinessArmBinding,
  shouldFirePendingReadinessStart,
  shouldKeepPendingReadinessStart,
} from '../account-provider-readiness-arm.js';

describe('createAccountProviderReadinessArmBinding', () => {
  it('starts only when the bound owner still matches', () => {
    const start = vi.fn();
    const arm = createAccountProviderReadinessArmBinding();
    arm.publish('owner-a', start);

    expect(arm.startIfOwnerMatches('owner-a')).toBe(true);
    expect(start).toHaveBeenCalledOnce();

    expect(arm.startIfOwnerMatches('owner-b')).toBe(false);
    expect(start).toHaveBeenCalledOnce();
  });

  it('does not let a stale owner closure start after clear or owner change', () => {
    const oldStart = vi.fn();
    const newStart = vi.fn();
    const arm = createAccountProviderReadinessArmBinding();
    arm.publish('owner-a', oldStart);
    arm.clear();

    expect(arm.startIfOwnerMatches('owner-a')).toBe(false);
    expect(oldStart).not.toHaveBeenCalled();

    arm.publish('owner-a', oldStart);
    arm.publish('owner-b', newStart);
    expect(arm.startIfOwnerMatches('owner-b')).toBe(true);
    expect(arm.startIfOwnerMatches('owner-a')).toBe(false);
    expect(oldStart).not.toHaveBeenCalled();
    expect(newStart).toHaveBeenCalledOnce();
  });

  it('resumes incomplete discovery only for the bound owner', async () => {
    const resume = vi.fn(async () => {});
    const arm = createAccountProviderReadinessArmBinding();
    arm.publish('owner-a', vi.fn(), resume);

    await expect(arm.resumeIncompleteIfOwnerMatches('owner-b')).resolves.toBe(false);
    expect(resume).not.toHaveBeenCalled();
    await expect(arm.resumeIncompleteIfOwnerMatches('owner-a')).resolves.toBe(true);
    expect(resume).toHaveBeenCalledOnce();
    arm.clear();
    await expect(arm.resumeIncompleteIfOwnerMatches('owner-a')).resolves.toBe(false);
  });
});

describe('shouldFirePendingReadinessStart', () => {
  it('does not fire a leftover pending start after logout or owner change', () => {
    expect(
      shouldFirePendingReadinessStart({
        pendingOwnerId: 'owner-a',
        currentOwnerId: 'owner-a',
        boundaryPending: false,
      }),
    ).toBe(true);
    expect(
      shouldFirePendingReadinessStart({
        pendingOwnerId: 'owner-a',
        currentOwnerId: null,
        boundaryPending: false,
      }),
    ).toBe(false);
    expect(
      shouldFirePendingReadinessStart({
        pendingOwnerId: 'owner-a',
        currentOwnerId: 'owner-a',
        boundaryPending: true,
      }),
    ).toBe(false);
  });

  it('keeps a same-owner pending start across a transient Ghost boundary', () => {
    expect(
      shouldKeepPendingReadinessStart({
        pendingOwnerId: 'owner-a',
        currentOwnerId: 'owner-a',
        boundaryPending: true,
      }),
    ).toBe(true);
    expect(
      shouldKeepPendingReadinessStart({
        pendingOwnerId: 'owner-a',
        currentOwnerId: 'owner-a',
        boundaryPending: false,
      }),
    ).toBe(false);
    expect(
      shouldKeepPendingReadinessStart({
        pendingOwnerId: 'owner-a',
        currentOwnerId: 'owner-b',
        boundaryPending: true,
      }),
    ).toBe(false);
  });
});
