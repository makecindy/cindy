import { describe, expect, it } from 'vitest';

import { ProductTurnWallClockTracker } from '../turnWallClock';

describe('ProductTurnWallClockTracker', () => {
  it('keeps continuation gaps inside the final product-turn duration', () => {
    const tracker = new ProductTurnWallClockTracker();
    tracker.start('session-1', 1_000);

    // Intermediate continuation boundaries do not consume or restart the clock.
    expect(tracker.finish('other-session', 6_000)).toBeUndefined();
    expect(tracker.finish('session-1', 7_500)).toBe(6_500);
  });

  it('returns undefined for missing or invalid time boundaries', () => {
    const tracker = new ProductTurnWallClockTracker();
    expect(tracker.finish('missing', 2_000)).toBeUndefined();

    tracker.start('reversed', 3_000);
    expect(tracker.finish('reversed', 2_000)).toBeUndefined();

    tracker.start('invalid', Number.NaN);
    expect(tracker.finish('invalid', 4_000)).toBeUndefined();
  });

  it('clears abandoned turns without leaking their start into a later turn', () => {
    const tracker = new ProductTurnWallClockTracker();
    tracker.start('session-1', 1_000);
    tracker.clear('session-1');
    expect(tracker.finish('session-1', 5_000)).toBeUndefined();

    tracker.start('session-1', 6_000);
    expect(tracker.finish('session-1', 8_000)).toBe(2_000);
  });
});
