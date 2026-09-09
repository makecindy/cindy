import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { scheduleConnectionNotice, updateConnectionNoticeVisibility } from '@/components/connectionNoticeDelay';

describe('floating connection notice', () => {
  afterEach(() => vi.useRealTimers());
  it('waits three seconds and cancels a brief outage without flashing', () => {
    vi.useFakeTimers();
    const reveal = vi.fn();
    const cancel = scheduleConnectionNotice(reveal);
    vi.advanceTimersByTime(2_999);
    expect(reveal).not.toHaveBeenCalled();
    cancel();
    vi.advanceTimersByTime(3_000);
    expect(reveal).not.toHaveBeenCalled();
    const cancelNext = scheduleConnectionNotice(reveal);
    vi.advanceTimersByTime(2_999);
    expect(reveal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reveal).toHaveBeenCalledTimes(1);
    cancelNext();
  });
  it('keeps the anchor out of layout and renders touch targets in the root overlay', () => {
    const overlay = readFileSync('src/components/ConnectionNoticeOverlay.tsx', 'utf8');
    expect(overlay).toContain('anchor: { height: 0 }');
    expect(overlay).toContain('pointerEvents="box-none" style={styles.layer}');
    expect(overlay).toContain('context?.publish(id, null)');
    const root = readFileSync('app/_layout.tsx', 'utf8');
    expect(root).toContain('<ConnectionNoticeProvider>{body}</ConnectionNoticeProvider>');
    const banner = readFileSync('src/components/ConnectionBanner.tsx', 'utf8');
    expect(banner).toContain('useDelayedConnectionNotice(cachedOnly || active)');
    expect(banner).toContain('<ConnectionNoticeOverlay>');
  });
  it('clears immediately on completion and delays each new incident independently', () => {
    vi.useFakeTimers();
    let visible = false;
    let cancel: (() => void) | undefined;
    const update = (active: boolean) => {
      cancel?.();
      cancel = updateConnectionNoticeVisibility(active, visible, (next) => { visible = next; });
    };
    update(true);
    vi.advanceTimersByTime(500);
    update(false);
    vi.advanceTimersByTime(2_000);
    expect(visible).toBe(false);
    update(true);
    vi.advanceTimersByTime(3_000);
    expect(visible).toBe(true);
    update(false);
    expect(visible).toBe(false);
    update(true);
    vi.advanceTimersByTime(2_999);
    expect(visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(visible).toBe(true);
    update(false);
    vi.advanceTimersByTime(2_000);
    expect(visible).toBe(false);
  });
});
