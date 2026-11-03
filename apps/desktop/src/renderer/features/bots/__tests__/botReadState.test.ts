import { botGroupReadKey, botGroupUnreadCount, isBotGroupUnread, seedBotGroupReadState } from '../botReadState';
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
    // A failed write still retains the session watermark across fresh reads.
    const blocked = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      expect(markBotRead('bot-1', 7_000)).toBe(true);
      expect(markBotRead('bot-1', 6_500)).toBe(false);
      expect(markBotRead('bot-2', 8_000)).toBe(true);
      expect(getBotLastReadAt('bot-1')).toBe(7_000);
    } finally {
      blocked.mockRestore();
    }
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

  it('keeps group watermarks on list refresh/restart, prunes deletion, and observes another window', () => {
    setBotReadStateOwner('owner-1');
    seedBotGroupReadState([{ id: 'g', lastReplyAt: 100 }]);
    seedBotGroupReadState([{ id: 'g', lastReplyAt: 200 }]);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(true);
    resetBotReadStateForTests(); setBotReadStateOwner('owner-1');
    expect(getBotLastReadAt(botGroupReadKey('g'))).toBe(100);
    const listener = vi.fn(); const off = subscribeBotReadState(listener);
    window.localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({ 'group:g': 200 }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'cindy.bots.readState.v1.owner-1' }));
    expect(listener).toHaveBeenCalledOnce();
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(false);
    const mark = 'cindy.bots.readState.v1.mark.' + JSON.stringify('owner-1') + '.' + JSON.stringify(['group:g', 300]);
    window.localStorage.setItem(mark, '1');
    window.dispatchEvent(new StorageEvent('storage', { key: mark, newValue: '1', storageArea: window.localStorage }));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 300 })).toBe(false);
    seedBotGroupReadState([]); expect(getBotLastReadAt(botGroupReadKey('g'))).toBeNull();
    resetBotReadStateForTests(); setBotReadStateOwner('owner-1');
    expect(getBotLastReadAt(botGroupReadKey('g'))).toBeNull();
    off();
  });

  // PR #8637 / unit: another renderer can persist before its storage event
  // reaches this cached module. Every public writer must preserve that read.
  it.each(['mark', 'seed-bots', 'prune-bots', 'seed-groups'] as const)(
    'preserves another window read before storage delivery during %s', action => {
      setBotReadStateOwner('owner-1');
      seedBotGroupReadState([{ id: 'g', lastReplyAt: 100 }, { id: 'gone', lastReplyAt: 50 }]);
      markBotRead('bot-alive', 100);
      markBotRead('bot-gone', 50);
      expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(true);
      // Simulate the other renderer's successful write, with no storage event.
      window.localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({
        ...getBotLastReadAtMap(), 'group:g': 200, 'bot-alive': 200, 'thread:other': 300,
      }));
      if (action === 'mark') markBotRead('bot-alive', 400);
      else if (action === 'seed-bots') seedMissingBotReadState(['bot-alive', 'new-bot'], 400);
      else if (action === 'prune-bots') pruneBotReadState(['bot-alive']);
      else seedBotGroupReadState([{ id: 'g', lastReplyAt: 200 }, { id: 'new-group', lastReplyAt: 400 }]);
      expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(false);
      resetBotReadStateForTests(); setBotReadStateOwner('owner-1');
      const saved = getBotLastReadAtMap();
      expect(saved['group:g']).toBe(200);
      expect(saved['thread:other']).toBe(300);
      expect(saved['bot-alive']).toBe(action === 'mark' ? 400 : 200);
      if (action === 'seed-bots') expect(saved['new-bot']).toBe(400);
      if (action === 'prune-bots') expect(saved['bot-gone']).toBeUndefined();
      if (action === 'seed-groups') {
        expect(saved['group:gone']).toBeUndefined();
        expect(saved['group:new-group']).toBe(400);
      }
      resetBotReadStateForTests(); setBotReadStateOwner('owner-1');
      expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(false);
    },
  );

  // Unit / review4460020582: pause the actual storage commit after its
  // read, let another renderer commit, then restore from persisted facts.
  it.each([['group:g', 'group:g'], ['bot-1', 'thread:other']])(
    'preserves concurrent explicit reads for %s and %s after reload', (olderId, newerId) => {
      setBotReadStateOwner('owner-1');
      markBotRead(olderId, 100);
      const set = Storage.prototype.setItem;
      let interleave = true;
      const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
        if (interleave) { interleave = false; markBotRead(newerId, 300); }
        set.call(this, key, value);
      });
      try { markBotRead(olderId, 200); } finally { spy.mockRestore(); }
      expect(interleave).toBe(false);
      resetBotReadStateForTests(); setBotReadStateOwner('owner-1');
      expect(getBotLastReadAt(newerId)).toBe(300);
      expect(getBotLastReadAt(olderId)).toBe(olderId === newerId ? 300 : 200);
      if (olderId === 'group:g') expect(isBotGroupUnread({ id: 'g', lastReplyAt: 300 })).toBe(false);
    },
  );

  it('does not lower another window read when an older explicit mark arrives first', () => {
    setBotReadStateOwner('owner-1');
    markBotRead('group:g', 100);
    window.localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({ 'group:g': 300 }));
    expect(markBotRead('group:g', 200)).toBe(false);
    expect(getBotLastReadAt('group:g')).toBe(300);
    expect(JSON.parse(window.localStorage.getItem('cindy.bots.readState.v1.owner-1')!)).toEqual({ 'group:g': 300 });
  });

  it('prunes read positions for Bots that no longer exist', () => {
    setBotReadStateOwner('owner-1');
    markBotRead('bot-1', 5_000);
    markBotRead('bot-gone', 5_000);

    expect(pruneBotReadState(['bot-1'])).toBe(true);
    expect(getBotLastReadAtMap()).toEqual({ 'bot-1': 5_000 });
    expect(pruneBotReadState(['bot-1'])).toBe(false);
  });

  it('counts other humans as incoming, preserves pending replies behind self messages, and seeds old history quietly', () => {
    const lastMessage = { authorKind: 'user' as const, isSelf: false, authorName: 'Chris', preview: 'Hello', createdAt: 100 };
    seedBotGroupReadState([{ id: 'g', lastMessage }]);
    expect(isBotGroupUnread({ id: 'g', lastMessage })).toBe(false);
    const incoming = { id: 'g', lastMessage: { ...lastMessage, createdAt: 200 } };
    expect(isBotGroupUnread(incoming)).toBe(true);
    expect(isBotGroupUnread({ id: 'g', lastMessage: { ...lastMessage, isSelf: true, createdAt: 300 } })).toBe(false);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200, lastMessage: { ...lastMessage, isSelf: true, createdAt: 300 } })).toBe(true);
    markBotRead(botGroupReadKey('g'), 200);
    expect(isBotGroupUnread(incoming)).toBe(false);
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

  it('does not count a system admission as an incoming reply or hide a pending reply', () => {
    setBotReadStateOwner('owner-1');
    markBotRead(botGroupReadKey('g'), 100);
    const lastMessage = { authorKind: 'system' as const, isSelf: false, authorName: 'Taylor',
      noticeCode: 'member-joined' as const, preview: 'Taylor joined the group', createdAt: 300 };
    expect(isBotGroupUnread({ id: 'g', lastMessage })).toBe(false);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 100, lastMessage })).toBe(false);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200, lastMessage })).toBe(true);
    expect(getBotLastReadAt(botGroupReadKey('g'))).toBe(100);
  });

  it('degrades to an empty map when the stored value is corrupt', () => {
    setBotReadStateOwner('owner-1');
    window.localStorage.setItem('cindy.bots.readState.v1.owner-1', 'not json');
    resetBotReadStateForTests();
    setBotReadStateOwner('owner-1');

    expect(getBotLastReadAtMap()).toEqual({});
    expect(markBotRead('bot-1', 5_000)).toBe(true);
    resetBotReadStateForTests(); setBotReadStateOwner('owner-1');
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
  });

  it('counts a group\'s unread messages from the host\'s incoming times, and falls back to one without them', () => {
    setBotReadStateOwner('owner-1');
    const at = (ms: number) => new Date(ms).toISOString();
    const group = { id: 'g', lastReplyAt: 4_000, incomingMessageTimes: [at(1_000), at(2_000), at(3_000), at(4_000)] };
    // Never read before: seeding marks the existing history as read.
    seedBotGroupReadState([group]);
    expect(botGroupUnreadCount(group)).toBe(0);
    // Read up to the second message (as stored by an earlier visit).
    window.localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({ [botGroupReadKey('g')]: 2_000 }));
    resetBotReadStateForTests();
    setBotReadStateOwner('owner-1');
    expect(botGroupUnreadCount(group)).toBe(2);
    expect(isBotGroupUnread(group)).toBe(true);
    // An older host sends no list: anything newer reads as one.
    expect(botGroupUnreadCount({ id: 'g', lastReplyAt: 4_000 })).toBe(1);
    // The list and the latest reply disagreeing still never hides a new reply.
    expect(botGroupUnreadCount({ id: 'g', lastReplyAt: 4_000, incomingMessageTimes: [] })).toBe(1);
    markBotRead(botGroupReadKey('g'), 4_000);
    expect(botGroupUnreadCount(group)).toBe(0);
    expect(isBotGroupUnread(group)).toBe(false);
  });
});
