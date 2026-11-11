// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  botGroupReadKey, botGroupUnreadCount, isBotGroupUnread, seedBotGroupReadState,
  getBotLastReadAt, getBotLastReadAtMap, markBotRead, pruneBotReadState,
  resetBotReadStateForTests, seedMissingBotReadState, setBotReadStateOwner, subscribeBotReadState,
  startBotReadStateSync, getBotReadStateSyncStatus,
} from '../botReadState';
import { createBotReadStateProjection } from '../botReadStateSync';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { botReadStateFixture } from './botReadStateFixture';
import type { BotReadStateRequest, BotReadStateResult } from '../../../../shared/botReadStateStorage';
import { createIpcError } from '../../../../shared/ipc-errors';

// R1–R6: public unread facade and independent renderer mirrors against the real Main writer.
// Existing single-window localStorage tests could not catch lost concurrent acks, seed promotion,
// import gating or Main instance revision changes. All files are isolated temp unit fixtures.
let fixture: ReturnType<typeof botReadStateFixture>;
let stop: () => void;
const ready = async () => { await vi.waitFor(() => expect(getBotReadStateSyncStatus().phase).toBe('ready')); };
async function reload() {
  stop(); resetBotReadStateForTests(); stop = startBotReadStateSync(); await ready();
}
beforeEach(async () => {
  window.localStorage.clear(); resetBotReadStateForTests();
  setDataOwnerGeneration('owner-1', 1);
  fixture = botReadStateFixture();
  window.electronAPI = { maker: fixture.bridge } as unknown as Window['electronAPI'];
  stop = startBotReadStateSync(); await ready();
});
afterEach(async () => {
  stop(); resetBotReadStateForTests();
  // Let already-accepted Main operations settle before removing their private temp directory.
  await fixture.bridge.botReadState({ owner: { dataOwnerId: getDataOwnerGeneration().dataOwnerId ?? 'owner-1', generation: getDataOwnerGeneration().generation }, action: 'snapshot' });
  fixture.dispose(); vi.restoreAllMocks();
});

describe('Bot read positions', () => {
  it('persists through Main and survives a fresh renderer without writing localStorage', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    expect(markBotRead('bot-1', 5_000)).toBe(true);
    await vi.waitFor(async () => {
      const result = await fixture.bridge.botReadState({ owner: { dataOwnerId: 'owner-1', generation: 1 }, action: 'snapshot' });
      expect(result.positions[0]?.ackAt).toBe(5_000);
    });
    await reload();
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
    expect(getBotLastReadAtMap()).toEqual({ 'bot-1': 5_000 });
    expect(write).not.toHaveBeenCalled();
  });
  it('only moves explicit acknowledgements forward and notifies on projection changes', () => {
    const listener = vi.fn(); const off = subscribeBotReadState(listener);
    expect(markBotRead('bot-1', 5_000)).toBe(true);
    expect(markBotRead('bot-1', 4_000)).toBe(false);
    expect(markBotRead('bot-1', 5_000)).toBe(false);
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
    expect(listener).toHaveBeenCalledOnce();
    off(); markBotRead('bot-1', 7_000); expect(listener).toHaveBeenCalledOnce();
  });
  it('isolates accounts and signed-out state without losing the earlier account', async () => {
    markBotRead('bot-1', 5_000);
    await vi.waitFor(async () => expect((await fixture.bridge.botReadState({ owner: { dataOwnerId: 'owner-1', generation: 1 }, action: 'snapshot' })).positions[0]?.ackAt).toBe(5_000));
    setDataOwnerGeneration('owner-2', 2); setBotReadStateOwner('owner-2'); await ready();
    expect(getBotLastReadAt('bot-1')).toBeNull(); markBotRead('bot-1', 1_000);
    expect(getBotLastReadAt('bot-1')).toBe(1_000);
    setDataOwnerGeneration(null, 3); setBotReadStateOwner(null);
    expect(getBotLastReadAtMap()).toEqual({});
    setDataOwnerGeneration('owner-1', 4); setBotReadStateOwner('owner-1'); await ready();
    expect(getBotLastReadAt('bot-1')).toBe(5_000);
  });
  it('seeds unknown Bots quietly without advancing known positions or pruning absent/hidden rows', async () => {
    markBotRead('bot-1', 5_000);
    expect(seedMissingBotReadState(['bot-1', 'bot-2'], 9_000)).toBe(true);
    expect(getBotLastReadAtMap()).toEqual({ 'bot-1': 5_000, 'bot-2': 9_000 });
    expect(seedMissingBotReadState(['bot-1', 'bot-2'], 12_000)).toBe(false);
    expect(pruneBotReadState(['bot-1'])).toBe(false);
    seedBotGroupReadState([{ id: 'g', lastReplyAt: 100 }]);
    seedBotGroupReadState([{ id: 'g', lastReplyAt: 200 }]); seedBotGroupReadState([]);
    expect(getBotLastReadAt(botGroupReadKey('g'))).toBe(100);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(true);
  });
  it('counts other humans, not self/system notices, and preserves replies behind self messages', () => {
    const lastMessage = { authorKind: 'user' as const, isSelf: false, authorName: 'Example', preview: 'Hello', createdAt: 100 };
    seedBotGroupReadState([{ id: 'g', lastMessage }]);
    expect(isBotGroupUnread({ id: 'g', lastMessage })).toBe(false);
    expect(isBotGroupUnread({ id: 'g', lastMessage: { ...lastMessage, createdAt: 200 } })).toBe(true);
    expect(isBotGroupUnread({ id: 'g', lastMessage: { ...lastMessage, isSelf: true, createdAt: 300 } })).toBe(false);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200, lastMessage: { ...lastMessage, isSelf: true, createdAt: 300 } })).toBe(true);
    const system = { ...lastMessage, authorKind: 'system' as const, createdAt: 300 };
    expect(isBotGroupUnread({ id: 'g', lastMessage: system })).toBe(false);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200, lastMessage: system })).toBe(true);
    markBotRead(botGroupReadKey('g'), 200);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(false);
  });
  it('counts incoming times, falls back to one and leaves serverUnread authoritative', () => {
    const group = { id: 'g', lastReplyAt: 4_000, incomingMessageTimes: [1_000, 2_000, 3_000, 4_000].map(ms => new Date(ms).toISOString()) };
    seedBotGroupReadState([{ ...group, lastReplyAt: 2_000 }]);
    expect(botGroupUnreadCount(group)).toBe(2);
    expect(botGroupUnreadCount({ id: 'g', lastReplyAt: 4_000 })).toBe(1);
    expect(botGroupUnreadCount({ id: 'g', lastReplyAt: 4_000, incomingMessageTimes: [] })).toBe(1);
    markBotRead(botGroupReadKey('g'), 4_000); expect(botGroupUnreadCount(group)).toBe(0);
    expect(botGroupUnreadCount({ ...group, serverUnread: { count: 7, mentioned: false } })).toBe(7);
  });
  it('merges reverse-order windows and retains the earliest automatic seed independently of acknowledgements', async () => {
    const second = createBotReadStateProjection({ currentOwner: getDataOwnerGeneration, storage: () => localStorage, bridge: () => fixture.bridge });
    const off = second.start();
    try {
      await vi.waitFor(() => expect(second.status().phase).toBe('ready'));
      second.ack({ kind: 'bot', id: 'b' }, 300); markBotRead('b', 200); markBotRead('other', 400);
      await vi.waitFor(() => expect(getBotLastReadAt('b')).toBe(300));
      await vi.waitFor(() => expect(second.read({ kind: 'bot', id: 'other' })).toBe(400));
      // Simulate discoveries made independently before either window receives the other's snapshot.
      seedMissingBotReadState(['group:g'], 200);
      second.seed({ kind: 'group', id: 'g' }, 100);
      await vi.waitFor(() => expect(getBotLastReadAt('group:g')).toBe(100));
      markBotRead('group:g', 150);
      expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(true);
      await vi.waitFor(() => expect(second.read({ kind: 'group', id: 'g' })).toBe(150));
      await reload(); expect(getBotLastReadAt('b')).toBe(300); expect(getBotLastReadAt('group:g')).toBe(150);
    } finally { off(); }
  });
  it('imports all legacy and old-PR sources before seed/ack, preserves corruption and reimports after rollback', async () => {
    stop(); resetBotReadStateForTests();
    localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({ legacy: 90 }));
    localStorage.setItem('cindy.remoteBots.v1.owner-1', '{broken');
    localStorage.setItem('cindy.remoteBotReads.v1.owner-1', JSON.stringify([{ deviceId: 'd', id: 'b', readAt: 250 }]));
    localStorage.setItem('cindy.bots.readState.v1.mark."owner-1".["seed",100,"initial"]', '1');
    localStorage.setItem('cindy.bots.readState.v1.mark."owner-1".["seed",150]', '1');
    localStorage.setItem('cindy.remoteBotReads.v1.entry."owner-1".["e","b",40,"initial"]', '1');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const bridge = { ...fixture.bridge, botReadState: vi.fn(async (request: BotReadStateRequest) => { await gate; return fixture.bridge.botReadState(request); }) };
    window.electronAPI = { maker: bridge } as unknown as Window['electronAPI'];
    stop = startBotReadStateSync();
    seedMissingBotReadState(['legacy'], 500); markBotRead('seed', 160);
    expect(bridge.botReadState.mock.calls).toHaveLength(1);
    const imported = bridge.botReadState.mock.calls[0][0];
    expect(imported.action).toBe('merge');
    if (imported.action === 'merge') expect(imported.positions.some(row => row.ackAt === 160 || row.initialAt === 500)).toBe(false);
    release(); await ready();
    await vi.waitFor(() => expect(getBotLastReadAt('seed')).toBe(160));
    expect(getBotLastReadAt('legacy')).toBe(90);
    expect(getBotReadStateSyncStatus().corruptSources).toContain('cindy.remoteBots.v1.owner-1');
    expect(localStorage.getItem('cindy.remoteBots.v1.owner-1')).toBe('{broken');
    localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({ legacy: 300 }));
    await reload(); expect(getBotLastReadAt('legacy')).toBe(300);
  });
  it('blocks on inaccessible legacy storage, retains queued ack and retries without treating failure as empty', async () => {
    stop(); resetBotReadStateForTests();
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    stop = startBotReadStateSync(); markBotRead('b', 150); seedMissingBotReadState(['b'], 500);
    await vi.waitFor(() => expect(getBotReadStateSyncStatus().phase).toBe('error'));
    expect((await fixture.bridge.botReadState({ owner: { dataOwnerId: 'owner-1', generation: 1 }, action: 'snapshot' })).positions).toEqual([]);
    get.mockRestore(); localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({ b: 200 }));
    window.dispatchEvent(new Event('focus')); await ready();
    expect(getBotLastReadAt('b')).toBe(200);
  });
  it('keeps automatic discovery distinct when the first real acknowledgement is earlier or equal', async () => {
    seedMissingBotReadState(['earlier', 'equal'], 200);
    expect(markBotRead('earlier', 150)).toBe(true);
    expect(markBotRead('equal', 200)).toBe(false);
    await vi.waitFor(async () => {
      const result = await fixture.bridge.botReadState({ owner: { dataOwnerId: 'owner-1', generation: 1 }, action: 'snapshot' });
      expect(result.positions.find(row => row.identity.kind === 'bot' && row.identity.id === 'earlier')?.ackAt).toBe(150);
      expect(result.positions.find(row => row.identity.kind === 'bot' && row.identity.id === 'equal')?.ackAt).toBe(200);
    });
    await reload(); expect(getBotLastReadAt('earlier')).toBe(150);
  });
  it('assembles complete versioned pages and retries an invalidated cursor before opening bootstrap', async () => {
    stop(); resetBotReadStateForTests();
    await fixture.bridge.botReadState({ owner: { dataOwnerId: 'owner-1', generation: 1 }, action: 'merge', positions: [
      { identity: { kind: 'bot', id: 'one' }, ackAt: 100 }, { identity: { kind: 'bot', id: 'two' }, ackAt: 200 },
    ] });
    let first = true;
    let changed = false;
    const bridge = { ...fixture.bridge, onBotReadStateChanged: () => () => {}, // lost notification
      botReadState: vi.fn(async (request: BotReadStateRequest) => {
      if (request.action === 'snapshot' && request.cursor) {
        if (!changed) {
          changed = true; first = true;
          await fixture.bridge.botReadState({ owner: request.owner, action: 'merge', positions: [{ identity: { kind: 'bot', id: 'two' }, ackAt: 300 }] });
          throw createIpcError('PRECONDITION_FAILED', 'BOT_READ_SNAPSHOT_STALE');
        }
        const result = await fixture.bridge.botReadState({ owner: request.owner, action: 'snapshot' });
        return { ...result, positions: result.positions.slice(1) };
      }
      const result = await fixture.bridge.botReadState(request);
      if (request.action === 'snapshot' && first) { first = false; return { ...result, positions: result.positions.slice(0, 1), nextCursor: 'page-2' }; }
      return result;
    }) };
    window.electronAPI = { maker: bridge } as unknown as Window['electronAPI'];
    stop = startBotReadStateSync(); seedMissingBotReadState(['two'], 900);
    await ready();
    expect(getBotLastReadAtMap()).toEqual({ one: 100, two: 300 });
  });
  it('does not fall back to competing storage writes on IPC failure or a missing bridge', async () => {
    const original = fixture.bridge.botReadState;
    const write = vi.spyOn(Storage.prototype, 'setItem');
    let fail = true;
    fixture.bridge.botReadState = async request => {
      if (request.action === 'merge' && fail) { fail = false; throw new Error('disk full'); }
      return original(request);
    };
    markBotRead('b', 300);
    await vi.waitFor(() => expect(getBotReadStateSyncStatus().phase).toBe('error'));
    expect(getBotLastReadAt('b')).toBe(300);
    setDataOwnerGeneration('owner-1', 2); setBotReadStateOwner('owner-1'); await ready();
    await reload(); expect(getBotLastReadAt('b')).toBe(300);
    stop(); resetBotReadStateForTests(); window.electronAPI = { maker: {} } as unknown as Window['electronAPI'];
    stop = startBotReadStateSync(); markBotRead('c', 400);
    expect(getBotReadStateSyncStatus().phase).toBe('unavailable');
    expect(write).not.toHaveBeenCalled();
  });
  it('rejects a delayed old-account bootstrap response after the owner switches', async () => {
    stop(); resetBotReadStateForTests();
    let finish!: (result: BotReadStateResult) => void;
    const bridge = { ...fixture.bridge, botReadState: vi.fn((request: BotReadStateRequest) => request.owner.dataOwnerId === 'owner-1'
      ? new Promise<BotReadStateResult>(resolve => { finish = resolve; }) : fixture.bridge.botReadState(request)) };
    window.electronAPI = { maker: bridge } as unknown as Window['electronAPI'];
    stop = startBotReadStateSync(); markBotRead('old', 900);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    setDataOwnerGeneration('owner-2', 2); setBotReadStateOwner('owner-2'); await ready();
    finish({ owner: { dataOwnerId: 'owner-1', generation: 1 }, instanceId: 'retired', revision: 999,
      positions: [{ identity: { kind: 'bot', id: 'old' }, ackAt: 900 }] });
    await Promise.resolve(); expect(getBotLastReadAtMap()).toEqual({});
  });
  it('accepts a new Main instance, ignores retired events and releases shared subscriptions', async () => {
    markBotRead('b', 300);
    await vi.waitFor(async () => expect((await fixture.bridge.botReadState({ owner: { dataOwnerId: 'owner-1', generation: 1 }, action: 'snapshot' })).positions[0]?.ackAt).toBe(300));
    const old = await fixture.bridge.botReadState({ owner: { dataOwnerId: 'owner-1', generation: 1 }, action: 'snapshot' });
    fixture.restart();
    window.dispatchEvent(new Event('focus')); await ready();
    await fixture.bridge.botReadState({ owner: { dataOwnerId: 'owner-1', generation: 1 }, action: 'merge', positions: [{ identity: { kind: 'bot', id: 'b' }, ackAt: 400 }] });
    await vi.waitFor(() => expect(getBotLastReadAt('b')).toBe(400));
    fixture.publish({ ...old, revision: 9999 });
    expect(getBotLastReadAt('b')).toBe(400);
    const release = startBotReadStateSync(); expect(fixture.listenerCount()).toBe(1);
    release(); expect(fixture.listenerCount()).toBe(1); stop(); expect(fixture.listenerCount()).toBe(0);
  });

  // The computer's main keeps the one position every device advances (phone, other Macs).
  it('hands local positions to the host as seeds, reports reads, and folds host positions in forward', async () => {
    let push: ((payload: unknown, stamp?: unknown) => void) | undefined;
    const host = { 'bot-1': 9_000, 'bot-2': 1_000 };
    const update = vi.fn(async (body: { ownerId: string }) => ({ ownerId: body.ownerId, positions: host }));
    (window as unknown as { electronAPI: unknown }).electronAPI = { maker: fixture.bridge, localDb: { bots: { readState: {
      get: vi.fn(async () => ({ ownerId: 'owner-1', positions: host })), update, onChanged: (callback: typeof push) => { push = callback; return () => { push = undefined; }; },
    } } } };
    try {
      window.localStorage.setItem('cindy.bots.readState.v1.owner-1', JSON.stringify({ 'bot-1': 5_000, 'bot-2': 3_000 }));
      stop(); resetBotReadStateForTests(); stop = startBotReadStateSync(); await ready();
      setBotReadStateOwner('owner-1');
      // Upgrade migration: the host only takes what it has no position for.
      await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ ownerId: 'owner-1', seed: expect.objectContaining({ 'bot-2': 3_000 }) }));
      await vi.waitFor(() => expect(getBotLastReadAt('bot-1')).toBe(9_000));
      expect(getBotLastReadAt('bot-2')).toBe(3_000);
      markBotRead('bot-2', 4_000);
      expect(update).toHaveBeenLastCalledWith({ ownerId: 'owner-1', mark: { 'bot-2': 4_000 } });
      // Read on the phone: the host pushes; another account's push is ignored.
      push?.({ ownerId: 'owner-2', positions: { 'bot-2': 99_000 } });
      push?.({ ownerId: 'owner-1', positions: { 'bot-2': 8_000 } });
      expect(getBotLastReadAt('bot-2')).toBe(8_000);
    } finally {
      window.electronAPI = { maker: fixture.bridge } as unknown as Window['electronAPI'];
    }
  });
  // Merge compatibility: upstream host initialization must not promote an automatic
  // seed into a user's read acknowledgement in the multi-window projection.
  it('keeps host seeds distinct from actual reads and rejects late old-generation host replies', async () => {
    let push: ((payload: unknown, stamp?: unknown) => void) | undefined;
    let finish!: (state: { ownerId: string; positions: Record<string, number> }) => void;
    const state = { ownerId: 'owner-1', positions: {}, acknowledgedPositions: {} };
    window.electronAPI = { maker: fixture.bridge, localDb: { bots: { readState: {
      get: () => new Promise(resolve => { finish = resolve; }),
      update: vi.fn(async () => state),
      onChanged: (callback: typeof push) => { push = callback; return () => { push = undefined; }; },
    } } } } as unknown as Window['electronAPI'];
    stop(); resetBotReadStateForTests(); stop = startBotReadStateSync(); await ready();
    seedBotGroupReadState([{ id: 'g', lastReplyAt: 100 }]);
    push?.({ ownerId: 'owner-1', positions: { 'group:g': 200 }, acknowledgedPositions: {} });
    expect(getBotLastReadAt('group:g')).toBe(100);
    expect(isBotGroupUnread({ id: 'g', lastReplyAt: 200 })).toBe(true);
    push?.({ ownerId: 'owner-1', positions: { 'group:g': 200 }, acknowledgedPositions: { 'group:g': 150 } });
    expect(getBotLastReadAt('group:g')).toBe(150);
    const oldFinish = finish;
    setDataOwnerGeneration('owner-1', 2); setBotReadStateOwner('owner-1'); await ready();
    oldFinish({ ownerId: 'owner-1', positions: { 'group:g': 99_000 } });
    await Promise.resolve();
    expect(getBotLastReadAt('group:g')).toBe(150);
  });

});
