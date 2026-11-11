import { describe, expect, it, vi } from 'vitest';

import { SessionDragNativeOpenCoordinator } from '../sessionDragNativeOpenCoordinator';

describe('SessionDragNativeOpenCoordinator', () => {
  it('opens on native release and lets the later fallback consume the result once', () => {
    const owner = {};
    const beforeOpen = vi.fn();
    const openIfOutside = vi.fn(() => true);
    const coordinator = new SessionDragNativeOpenCoordinator();
    coordinator.begin(1, owner, 'session-a', 'device-a');

    expect(coordinator.handleNativeRelease(1, beforeOpen, openIfOutside)).toBe(true);
    expect(beforeOpen).toHaveBeenCalledOnce();
    expect(openIfOutside).toHaveBeenCalledWith({
      owner,
      sessionId: 'session-a',
      deviceId: 'device-a',
    });
    expect(coordinator.consumeNativeResult(owner, 'session-a', 'device-a')).toBe(true);
    expect(coordinator.consumeNativeResult(owner, 'session-a', 'device-a')).toBeNull();
  });

  it('preserves an inside-window result so dragend does not reclassify it', () => {
    const owner = {};
    const coordinator = new SessionDragNativeOpenCoordinator();
    coordinator.begin(2, owner, 'session-a');

    expect(coordinator.handleNativeRelease(2, vi.fn(), () => false)).toBe(false);
    expect(coordinator.consumeNativeResult(owner, 'session-a')).toBe(false);
  });

  it('ignores stopped, stale, and mismatched native results', () => {
    let now = 100;
    const firstOwner = {};
    const secondOwner = {};
    const coordinator = new SessionDragNativeOpenCoordinator({
      now: () => now,
      resultTtlMs: 50,
    });

    coordinator.begin(3, firstOwner, 'session-a');
    coordinator.stop(3);
    expect(coordinator.handleNativeRelease(3, vi.fn(), () => true)).toBeNull();

    coordinator.begin(4, firstOwner, 'session-a', 'device-a');
    coordinator.handleNativeRelease(4, vi.fn(), () => true);
    expect(coordinator.consumeNativeResult(firstOwner, 'session-b', 'device-a')).toBeNull();

    coordinator.begin(5, secondOwner, 'session-a');
    coordinator.handleNativeRelease(5, vi.fn(), () => true);
    now = 151;
    expect(coordinator.consumeNativeResult(secondOwner, 'session-a')).toBeNull();
  });

  it('invalidates an unconsumed result when the same window starts another drag', () => {
    const owner = {};
    const coordinator = new SessionDragNativeOpenCoordinator();
    coordinator.begin(6, owner, 'session-a');
    coordinator.handleNativeRelease(6, vi.fn(), () => true);

    coordinator.begin(7, owner, 'session-a');

    expect(coordinator.consumeNativeResult(owner, 'session-a')).toBeNull();
  });
});
