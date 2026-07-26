import { describe, expect, it } from 'vitest';
import { HeadlessTurnCompletionTracker } from './turn-completion.js';

describe('HeadlessTurnCompletionTracker', () => {
  it('keeps a turn pending until its terminal event releases it', async () => {
    const tracker = new HeadlessTurnCompletionTracker();
    let settled = false;
    const wait = tracker.waitFor('session-a').then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    tracker.complete('session-a');
    await wait;
    expect(settled).toBe(true);
  });

  it('is idempotent and does not leave a stale completion behind', async () => {
    const tracker = new HeadlessTurnCompletionTracker();
    const first = tracker.waitFor('session-a');
    expect(tracker.waitFor('session-a')).toBe(first);
    tracker.complete('session-a');
    tracker.complete('session-a');
    await first;
    expect(tracker.has('session-a')).toBe(false);
  });
});
