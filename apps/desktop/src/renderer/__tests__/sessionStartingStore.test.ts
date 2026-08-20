import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  absorbSessionStarting,
  clearSessionStarting,
  getStartingSessionIds,
  markSessionStarting,
  resetSessionStartingStoreForTests,
  SESSION_STARTING_TTL_MS,
} from '@/lib/sessionStartingStore';

describe('sessionStartingStore', () => {
  beforeEach(() => {
    resetSessionStartingStoreForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetSessionStartingStoreForTests();
    vi.useRealTimers();
  });

  it('marks a just-sent session until it is absorbed or cleared', () => {
    markSessionStarting('new-task');
    expect([...getStartingSessionIds()]).toEqual(['new-task']);

    absorbSessionStarting(['new-task']);
    expect([...getStartingSessionIds()]).toEqual([]);
  });

  it('keeps snapshot identity when remaking the same session', () => {
    markSessionStarting('s1');
    const first = getStartingSessionIds();
    markSessionStarting('s1');
    expect(getStartingSessionIds()).toBe(first);
  });

  it('does not absorb unknown ids and can clear a leftover mark', () => {
    markSessionStarting('keep');
    absorbSessionStarting(['other']);
    expect([...getStartingSessionIds()]).toEqual(['keep']);

    clearSessionStarting('keep');
    expect([...getStartingSessionIds()]).toEqual([]);
    clearSessionStarting('keep');
  });

  it('expires a starting mark that never becomes running', () => {
    markSessionStarting('stuck');
    vi.advanceTimersByTime(SESSION_STARTING_TTL_MS - 1);
    expect([...getStartingSessionIds()]).toEqual(['stuck']);
    vi.advanceTimersByTime(1);
    expect([...getStartingSessionIds()]).toEqual([]);
  });
});
