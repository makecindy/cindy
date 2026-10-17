import { describe, expect, it } from 'vitest';
import { DOUBLE_TAP_INTERVAL_MS, registerTap } from '@/session/useDoubleTap';

describe('registerTap', () => {
  it('treats two taps within the interval as a double tap', () => {
    const first = registerTap(null, 1000);
    expect(first.doubleTap).toBe(false);
    expect(registerTap(first.lastTapAt, 1000 + DOUBLE_TAP_INTERVAL_MS).doubleTap).toBe(true);
  });

  it('starts over when the second tap is too late', () => {
    const first = registerTap(null, 1000);
    const late = registerTap(first.lastTapAt, 1001 + DOUBLE_TAP_INTERVAL_MS);
    expect(late).toEqual({ doubleTap: false, lastTapAt: 1001 + DOUBLE_TAP_INTERVAL_MS });
  });

  it('needs two fresh taps after a double tap', () => {
    const second = registerTap(registerTap(null, 1000).lastTapAt, 1100);
    expect(second.doubleTap).toBe(true);
    expect(registerTap(second.lastTapAt, 1200).doubleTap).toBe(false);
  });
});
