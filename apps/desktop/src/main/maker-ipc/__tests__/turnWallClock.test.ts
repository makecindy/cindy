import { describe, expect, it } from 'vitest';

import { ProductTurnUsageTargetTracker, ProductTurnWallClockTracker } from '../turnWallClock';

describe('ProductTurnWallClockTracker', () => {
  it('keeps continuation gaps inside the final product-turn duration', () => {
    const tracker = new ProductTurnWallClockTracker();
    expect(tracker.start('session-1', 1_000)).toBe(true);

    // Temporary idle/running boundaries do not consume or restart the clock.
    tracker.preserveForContinuation('session-1');
    expect(tracker.start('session-1', 6_000)).toBe(false);
    expect(tracker.finish('other-session', 6_000)).toBeUndefined();
    expect(tracker.finish('session-1', 7_500)).toBe(6_500);
  });

  it('restarts the clock when the next running boundary is not a continuation', () => {
    const tracker = new ProductTurnWallClockTracker();
    expect(tracker.start('session-1', 1_000)).toBe(true);
    expect(tracker.start('session-1', 6_000)).toBe(true);
    expect(tracker.finish('session-1', 8_000)).toBe(2_000);
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

describe('ProductTurnUsageTargetTracker', () => {
  it('reuses the latest continuation assistant for a tokenless final segment', () => {
    const tracker = new ProductTurnUsageTargetTracker();
    tracker.remember('session-1', 'assistant-1');
    tracker.remember('session-1', 'assistant-2');

    expect(tracker.finish('session-1', undefined)).toBe('assistant-2');
    expect(tracker.finish('session-1', undefined)).toBeUndefined();
  });

  it('prefers a final segment assistant and clears abandoned targets', () => {
    const tracker = new ProductTurnUsageTargetTracker();
    tracker.remember('session-1', 'assistant-1');
    expect(tracker.finish('session-1', 'assistant-final')).toBe('assistant-final');

    tracker.remember('session-1', 'stale-assistant');
    tracker.clear('session-1');
    expect(tracker.finish('session-1', undefined)).toBeUndefined();
  });
});
