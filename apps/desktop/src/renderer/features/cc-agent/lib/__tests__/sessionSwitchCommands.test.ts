import { describe, expect, it, vi } from 'vitest';

import {
  onRequestSessionSwitch,
  pickAdjacentSessionId,
  requestSessionSwitch,
} from '../sessionSwitchCommands';

describe('pickAdjacentSessionId', () => {
  const list = ['a', 'b', 'c'];

  it('moves one step in either direction', () => {
    expect(pickAdjacentSessionId(list, 'b', 'previous')).toBe('a');
    expect(pickAdjacentSessionId(list, 'b', 'next')).toBe('c');
  });

  it('stops at both ends instead of wrapping', () => {
    // Wrapping would jump the user from one end of the list to the other with
    // no way to feel that the list had ended.
    expect(pickAdjacentSessionId(list, 'a', 'previous')).toBeNull();
    expect(pickAdjacentSessionId(list, 'c', 'next')).toBeNull();
  });

  it('enters the list from whichever end the user turned toward', () => {
    expect(pickAdjacentSessionId(list, null, 'next')).toBe('a');
    expect(pickAdjacentSessionId(list, null, 'previous')).toBe('c');
  });

  it('stays put when the active task is filtered out of the visible list', () => {
    // Search or a status filter can hide the active task; moving relative to
    // something that is not on screen would be a guess.
    expect(pickAdjacentSessionId(list, 'hidden', 'next')).toBeNull();
    expect(pickAdjacentSessionId(list, 'hidden', 'previous')).toBeNull();
  });

  it('has nowhere to go in an empty list', () => {
    expect(pickAdjacentSessionId([], 'a', 'next')).toBeNull();
    expect(pickAdjacentSessionId([], null, 'next')).toBeNull();
  });
});

describe('session switch channel', () => {
  it('delivers to subscribers until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onRequestSessionSwitch(listener);

    requestSessionSwitch('next');
    expect(listener).toHaveBeenCalledWith('next');

    unsubscribe();
    requestSessionSwitch('previous');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps delivering after a subscriber throws', () => {
    const broken = vi.fn(() => {
      throw new Error('boom');
    });
    const healthy = vi.fn();
    const offBroken = onRequestSessionSwitch(broken);
    const offHealthy = onRequestSessionSwitch(healthy);

    expect(() => requestSessionSwitch('next')).not.toThrow();
    expect(healthy).toHaveBeenCalledWith('next');

    offBroken();
    offHealthy();
  });
});
