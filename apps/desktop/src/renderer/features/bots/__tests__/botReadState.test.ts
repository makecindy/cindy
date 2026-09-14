// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getBotLastReadAt,
  getBotLastReadAtMap,
  markBotRead,
  pruneBotReadState,
  resetBotReadStateForTests,
  seedMissingBotReadState,
  setBotReadStateOwner,
  subscribeBotReadState,
} from '../botReadState';

beforeEach(() => {
  window.localStorage.clear();
  resetBotReadStateForTests();
});

afterEach(() => {
  resetBotReadStateForTests();
});

describe('Bot read positions', () => {
  it('persists a read position and survives a fresh module read', () => {
    setBotReadStateOwner('owner-1');
    expect(markBotRead('bot-1', 5_000)).toBe(true);

    // Simulate a reload: drop the in-memory cache, keep localStorage.
    resetBotReadStateForTests();
    setBotReadStateOwner('owner-1');
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
    expect(getBotLastReadAtMap()).toEqual({ 'bot-1': 5_000 });
  });

  it('only ever moves a read position forward', () => {
    setBotReadStateOwner('owner-1');
    markBotRead('bot-1', 5_000);

    expect(markBotRead('bot-1', 4_000)).toBe(false);
    expect(markBotRead('bot-1', 5_000)).toBe(false);
    expect(getBotLastReadAt('bot-1')).toBe(5_000);

    expect(markBotRead('bot-1', 6_000)).toBe(true);
    expect(getBotLastReadAt('bot-1')).toBe(6_000);
  });

  it('keeps each data owner on its own read positions', () => {
    setBotReadStateOwner('owner-1');
    markBotRead('bot-1', 5_000);

    setBotReadStateOwner('owner-2');
    expect(getBotLastReadAt('bot-1')).toBeNull();
    markBotRead('bot-1', 1_000);
    expect(getBotLastReadAt('bot-1')).toBe(1_000);

    // Switching back must not have been clobbered by the second owner.
    setBotReadStateOwner('owner-1');
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
  });

  it('signed-out state is its own namespace, not owner-1 leftovers', () => {
    setBotReadStateOwner('owner-1');
    markBotRead('bot-1', 5_000);
    setBotReadStateOwner(null);
    expect(getBotLastReadAtMap()).toEqual({});
  });

  it('seeds unknown Bots as read so shipping badges does not resurface history', () => {
    setBotReadStateOwner('owner-1');
    markBotRead('bot-1', 5_000);

    expect(seedMissingBotReadState(['bot-1', 'bot-2'], 9_000)).toBe(true);
    expect(getBotLastReadAtMap()).toEqual({ 'bot-1': 5_000, 'bot-2': 9_000 });
    // Idempotent: a second pass must not push the existing positions forward.
    expect(seedMissingBotReadState(['bot-1', 'bot-2'], 12_000)).toBe(false);
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
  });

  it('prunes read positions for Bots that no longer exist', () => {
    setBotReadStateOwner('owner-1');
    markBotRead('bot-1', 5_000);
    markBotRead('bot-gone', 5_000);

    expect(pruneBotReadState(['bot-1'])).toBe(true);
    expect(getBotLastReadAtMap()).toEqual({ 'bot-1': 5_000 });
    expect(pruneBotReadState(['bot-1'])).toBe(false);
  });

  it('notifies subscribers only when the stored state actually changes', () => {
    setBotReadStateOwner('owner-1');
    const listener = vi.fn();
    const unsubscribe = subscribeBotReadState(listener);

    markBotRead('bot-1', 5_000);
    expect(listener).toHaveBeenCalledTimes(1);
    markBotRead('bot-1', 4_000);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    markBotRead('bot-1', 7_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('degrades to an empty map when the stored value is corrupt', () => {
    setBotReadStateOwner('owner-1');
    window.localStorage.setItem('cindy.bots.readState.v1.owner-1', 'not json');
    resetBotReadStateForTests();
    setBotReadStateOwner('owner-1');

    expect(getBotLastReadAtMap()).toEqual({});
    expect(markBotRead('bot-1', 5_000)).toBe(true);
  });
});
