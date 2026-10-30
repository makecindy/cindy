import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOfflineMirrorWipeQueue } from '@/device-link/offlineMirrorWipeQueue';
import {
  clearPresenceWipeTimer,
  extendPresenceWipeTimerFloor,
  resetPresenceAvailabilityForConnection,
  schedulePresenceWipeTimer,
  type PresenceWipeTimerEntry,
} from '@/device-link/presenceRecovery';

describe('offline mirror wipe queue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function protectedQueue() {
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush);
    const timers = new Map<string, PresenceWipeTimerEntry>();
    const availability = new Map<string, boolean>();
    const confirming = new Set<string>();
    const deps = {
      now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout,
      wipe: queue.enqueue, deferWipe: queue.enqueue,
      isConfirmationInFlight: (id: string) => confirming.has(id),
    };
    const offline = (id: string) => {
      availability.set(id, false);
      schedulePresenceWipeTimer(timers, availability, id, 5_000, deps);
    };
    return { flush, queue, timers, availability, confirming, deps, offline };
  }

  it('extends a queued wipe on reconnect without delaying another offline peer', async () => {
    const { flush, queue, timers, availability, deps, offline } = protectedQueue();
    offline('reconnecting');
    // This peer expires in the same batch, after the reconnect reset.
    await vi.advanceTimersByTimeAsync(5);
    offline('offline');
    await vi.advanceTimersByTimeAsync(4_996);
    expect(queue.pendingCount()).toBe(1);
    expect(timers.has('reconnecting')).toBe(true);
    resetPresenceAvailabilityForConnection(availability, new Set());
    extendPresenceWipeTimerFloor(timers, availability, 'reconnecting', 3_000, deps);
    await vi.advanceTimersByTimeAsync(15);
    expect(flush.mock.calls).toEqual([[['offline']]]);
    await vi.advanceTimersByTimeAsync(2_985);
    expect(queue.pendingCount()).toBe(1);
    expect(flush).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16);
    expect(flush.mock.calls).toEqual([[['offline']], [['reconnecting']]]);
    expect(timers.size).toBe(0);
  });

  it('defers a queued wipe when link confirmation starts before the batch executes', async () => {
    const { flush, timers, confirming, offline } = protectedQueue();
    offline('peer');
    await vi.advanceTimersByTimeAsync(5_001);
    confirming.add('peer');
    await vi.advanceTimersByTimeAsync(15);
    expect(flush).not.toHaveBeenCalled();
    expect(timers.has('peer')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(flush).not.toHaveBeenCalled();
    confirming.delete('peer');
    await vi.advanceTimersByTimeAsync(1_016);
    expect(flush.mock.calls).toEqual([[['peer']]]);
    expect(timers.size).toBe(0);
  });

  it.each(['cancel', 'available'] as const)('rejects queued work after %s without losing another peer', async (recovery) => {
    const { flush, timers, availability, offline } = protectedQueue();
    offline('recovered');
    offline('offline');
    await vi.advanceTimersByTimeAsync(5_001);
    if (recovery === 'cancel') clearPresenceWipeTimer(timers, 'recovered', clearTimeout);
    else availability.set('recovered', true);
    await vi.advanceTimersByTimeAsync(15);
    expect(flush.mock.calls).toEqual([[['offline']]]);
    expect(timers.size).toBe(0);
  });

  it.each([1, 60, 80, 100])('coalesces %i timer callbacks even when microtasks drain between them', async (count) => {
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush);
    for (let i = 0; i < count; i++) {
      setTimeout(() => queue.enqueue('dev-' + i), 5_000 + i % 10);
    }
    // Async advancement drains microtasks between timers, as RN may do.
    await vi.advanceTimersByTimeAsync(5_010);
    expect(flush).not.toHaveBeenCalled();
    expect(queue.pendingCount()).toBe(count);
    await vi.advanceTimersByTimeAsync(6);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(new Set(flush.mock.calls[0][0])).toEqual(new Set(Array.from({ length: count }, (_, i) => 'dev-' + i)));
    expect(queue.pendingCount()).toBe(0);
  });

  it('dedupes ids without postponing the deadline and permits later waves', async () => {
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush);
    queue.enqueue('a');
    await vi.advanceTimersByTimeAsync(15);
    queue.enqueue('a');
    queue.enqueue('b');
    await vi.advanceTimersByTimeAsync(1);
    expect(flush.mock.calls).toEqual([[['a', 'b']]]);
    queue.enqueue('a');
    await vi.advanceTimersByTimeAsync(16);
    expect(flush.mock.calls).toEqual([[['a', 'b']], [['a']]]);
  });

  it('cancels recovered peers without discarding other offline peers', async () => {
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush);
    queue.enqueue('recovered');
    queue.enqueue('offline');
    queue.cancel('recovered');
    await vi.advanceTimersByTimeAsync(16);
    expect(flush.mock.calls).toEqual([[['offline']]]);
  });

  it('retires queued work on teardown without draining a replacement wave', () => {
    const callbacks: Array<() => void> = [];
    const cancel = vi.fn();
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush, cb => { callbacks.push(cb); return cancel; });
    queue.enqueue('old-owner');
    queue.clear();
    expect(cancel).toHaveBeenCalledTimes(1);
    queue.enqueue('new-owner');
    callbacks[0]();
    expect(flush).not.toHaveBeenCalled();
    expect(queue.pendingCount()).toBe(1);
    callbacks[1]();
    expect(flush.mock.calls).toEqual([[['new-owner']]]);
  });

  it('ignores empty ids and cancels the timer after the last peer recovers', async () => {
    const flush = vi.fn();
    const queue = createOfflineMirrorWipeQueue(flush);
    queue.enqueue('');
    expect(vi.getTimerCount()).toBe(0);
    queue.enqueue('a');
    queue.cancel('a');
    expect(queue.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.runAllTimersAsync();
    expect(flush).not.toHaveBeenCalled();
  });
});
