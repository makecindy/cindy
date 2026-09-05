import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMobileTailFollower, type MobileTailSnapshot } from '@/session/messageTailFollower';
import { MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS } from '@/session/messageScroll';

function harness() {
  const snapshot: MobileTailSnapshot = {
    metrics: { contentHeight: 2000, viewportHeight: 800, offsetY: 1200 },
    stickToLatest: true,
    userControllingScroll: false,
    preservingHistory: false,
    layoutSettleAt: 0,
    animatedScrollUntil: 0,
  };
  const seekEnd = vi.fn((animated: boolean) => {
    if (animated) snapshot.animatedScrollUntil = Date.now() + 800;
  });
  const correctOffset = vi.fn((offset: number) => { snapshot.metrics.offsetY = offset; });
  const onMeasurementOscillation = vi.fn();
  const follower = createMobileTailFollower({
    read: () => snapshot, seekEnd, correctOffset, onMeasurementOscillation,
  });
  return { snapshot, seekEnd, correctOffset, onMeasurementOscillation, follower };
}

describe('one mobile tail follower', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 16));
    vi.stubGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('seeks unmeasured rows once, then corrects against native geometry in either direction', () => {
    const h = harness();
    h.snapshot.metrics.offsetY = 1800;
    h.follower.requestEnd(false);
    h.follower.reconcile(); // The entry animation and layout share the same pending check.
    vi.advanceTimersByTime(200);
    expect(h.seekEnd).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.correctOffset).toHaveBeenCalledExactlyOnceWith(1200);
    h.snapshot.metrics.offsetY = 900;
    h.follower.reconcile();
    vi.advanceTimersByTime(200);
    expect(h.correctOffset).toHaveBeenLastCalledWith(1200);
    expect(h.seekEnd).toHaveBeenCalledTimes(1);
  });

  it('recovers shrinkage below one screen after layout settles', () => {
    const h = harness();
    h.snapshot.metrics.contentHeight = 500;
    h.snapshot.layoutSettleAt = Date.now() + 120;
    h.follower.contentChanged();
    vi.advanceTimersByTime(100);
    expect(h.correctOffset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(h.correctOffset).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks a larger viewport even when no content-size event follows', () => {
    const h = harness();
    h.snapshot.metrics.viewportHeight = 1000;
    h.follower.reconcile();
    vi.advanceTimersByTime(200);
    expect(h.correctOffset).toHaveBeenCalledExactlyOnceWith(1000);
  });

  it('does not scroll an aligned short list', () => {
    const h = harness();
    h.snapshot.metrics = { contentHeight: 500, viewportHeight: 800, offsetY: 0 };
    h.follower.contentChanged();
    vi.advanceTimersByTime(200);
    expect(h.correctOffset).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not poll during a held gesture and resumes on release even after output stops', () => {
    const h = harness();
    h.snapshot.userControllingScroll = true;
    h.snapshot.metrics.contentHeight = 2500;
    h.follower.contentChanged();
    h.follower.reconcile();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(h.correctOffset).not.toHaveBeenCalled();
    h.snapshot.userControllingScroll = false;
    h.follower.reconcile();
    vi.advanceTimersByTime(200);
    expect(h.correctOffset).toHaveBeenCalledExactlyOnceWith(1700);
  });

  it('stops a pending correction if a gesture or history reader takes over', () => {
    for (const owner of ['userControllingScroll', 'preservingHistory'] as const) {
      const h = harness();
      h.snapshot.metrics.offsetY = 1800;
      h.follower.reconcile();
      h.snapshot[owner] = true;
      vi.advanceTimersByTime(200);
      expect(h.correctOffset).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('never reclaims the viewport after follow has been released', () => {
    const h = harness();
    h.snapshot.stickToLatest = false;
    h.snapshot.metrics.contentHeight = 2500;
    h.follower.contentChanged();
    h.follower.reconcile();
    vi.advanceTimersByTime(1000);
    expect(h.correctOffset).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets explicit jumps precede touch-end without cutting their animation short', () => {
    const h = harness();
    h.snapshot.userControllingScroll = true;
    h.follower.requestEnd(true, true);
    expect(h.seekEnd).toHaveBeenCalledExactlyOnceWith(true);
    h.snapshot.userControllingScroll = false;
    h.snapshot.metrics.contentHeight = 2500;
    h.follower.reconcile();
    h.follower.contentChanged();
    vi.advanceTimersByTime(799);
    expect(h.correctOffset).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(h.correctOffset).toHaveBeenCalledExactlyOnceWith(1700);
  });

  it('keeps live growth immediate and coalesces repeated verification requests', () => {
    const h = harness();
    h.snapshot.metrics.contentHeight = 2500;
    h.snapshot.layoutSettleAt = Date.now() + 120;
    h.follower.contentChanged();
    expect(h.correctOffset).toHaveBeenCalledExactlyOnceWith(1700);
    for (let i = 0; i < 20; i++) h.follower.reconcile();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(300);
    expect(h.correctOffset).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds retries when native never acknowledges and discards work on task reset', () => {
    const h = harness();
    h.correctOffset.mockImplementation(() => {});
    h.snapshot.metrics.offsetY = 1800;
    for (let i = 0; i < 20; i++) h.follower.reconcile();
    vi.advanceTimersByTime(1000);
    expect(h.correctOffset).toHaveBeenCalledTimes(MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS);
    expect(vi.getTimerCount()).toBe(0);
    h.follower.reconcile();
    h.follower.reset();
    vi.advanceTimersByTime(1000);
    expect(h.correctOffset).toHaveBeenCalledTimes(MOBILE_ANCHOR_VERIFY_MAX_ATTEMPTS);
  });

  it('applies the oscillation circuit to the shared verifier as well as immediate growth', () => {
    const h = harness();
    h.correctOffset.mockImplementation(() => {});
    for (let i = 0; i < 8; i++) {
      h.snapshot.metrics.contentHeight = i % 2 === 0 ? 2100 : 2000;
      h.follower.contentChanged();
      vi.advanceTimersByTime(16);
    }
    expect(h.onMeasurementOscillation).toHaveBeenCalledTimes(1);
    h.snapshot.metrics.contentHeight = 2100;
    h.follower.contentChanged();
    const count = h.correctOffset.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(h.correctOffset).toHaveBeenCalledTimes(count);
    h.correctOffset.mockImplementation((offset) => { h.snapshot.metrics.offsetY = offset; });
    vi.advanceTimersByTime(1500);
    expect(h.correctOffset).toHaveBeenCalledTimes(count + 1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
