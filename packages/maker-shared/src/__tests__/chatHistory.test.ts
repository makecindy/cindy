import { describe, expect, it, vi } from 'vitest';
import { createChatHistory, type ChatHistoryBatch, type ChatHistoryState, type ChatHistoryStore } from '../chatHistory.js';

// Unit tier: UI history previously refetched pages and lost edits outside the latest page.
// Exercise the actual cache entry points with restart, durable failure and ordered wire events.
function fixture() {
  const disk = new Map<string, ChatHistoryState>();
  const store: ChatHistoryStore = {
    read: async room => structuredClone(disk.get(room)),
    write: vi.fn(async (room, state) => { if (state) disk.set(room, structuredClone(state)); else disk.delete(room); }),
  };
  const message = (id: string, revision = 1, deleted = false) => ({ id, seq: id, revision, deleted, text: deleted ? '' : `v${revision}`, threadRootId: null });
  let batch: ChatHistoryBatch = { cursor: '10', changes: [] };
  let live = true;
  let generation = 0;
  const api = vi.fn(async (route: string): Promise<unknown> => {
    if (route.endsWith('/snapshot')) return { room: { id: 'room', kind: 'group' }, messages: [message('9')], cursor: '10' };
    if (route.startsWith('/changes?')) return batch;
    return [message('2'), message('1')];
  });
  const open = () => createChatHistory({ api: api as <T>(route: string) => Promise<T>, store, current: () => live, newGeneration: () => String(++generation) });
  const page = new URLSearchParams('limit=100&before=5');
  return { disk, store, api, open, message, page, setBatch: (value: ChatHistoryBatch) => { batch = value; }, leave: () => { live = false; } };
}

describe('durable chat history', () => {
  // Unit: unrelated room activity must not evict another topic's downloaded head page.
  it('invalidates only the latest pages whose filter includes a new message', async () => {
    const f = fixture(); const cache = f.open();
    const topic = new URLSearchParams('threadRootId=root&limit=50');
    const main = new URLSearchParams('limit=100');
    await cache.page('room', topic); await cache.page('room', main);
    await cache.receive('room', { cursor: '11', changes: [{ type: 'message.created', data: { message: f.message('11') } }] }, '10');
    f.api.mockClear();
    await cache.page('room', topic);
    expect(f.api).not.toHaveBeenCalled();
    await cache.page('room', main);
    expect(f.api).toHaveBeenCalledWith('/conversations/room/messages?limit=100');
  });

  // Unit: old topic roots need durable single-message coverage and aggregate refreshes,
  // while edits/tombstones must share the room cursor and survive a process restart.
  it('retains topic roots across restarts and repairs them from the room change stream', async () => {
    const f = fixture(); let replies = 0;
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async route => route.endsWith('/messages/1')
      ? { ...f.message('1'), replyCount: replies } : original(route));
    const cache = f.open();
    await cache.message('room', '1');
    const restarted = f.open(); f.api.mockClear();
    expect(await restarted.message('room', '1')).toMatchObject({ replyCount: 0 });
    expect(f.api.mock.calls.map(([route]) => route)).toEqual(['/changes?scope=conversation:room&after=10&limit=100']);
    replies = 1;
    await restarted.receive('room', { cursor: '11', changes: [{ type: 'message.created', data: { message: { ...f.message('11'), threadRootId: '1' } } }] }, '10');
    expect(await restarted.message('room', '1')).toMatchObject({ replyCount: 1 });
    await restarted.receive('room', { cursor: '12', changes: [{ type: 'message.deleted', data: { message: f.message('1', 2, true) } }] }, '10');
    f.setBatch({ cursor: '12', changes: [] });
    expect(await f.open().message('room', '1')).toMatchObject({ deleted: true, revision: 2 });
    restarted.invalidate('room');
    f.api.mockImplementationOnce(async () => { throw new Error('NOT_MEMBER'); });
    await expect(restarted.message('room', '1')).rejects.toThrow('NOT_MEMBER');
    expect(f.disk.has('room')).toBe(false);
  });

  it('retries a concurrent writer conflict without overwriting its newer historical edit', async () => {
    const f = fixture(); const cache = f.open(); await cache.page('room', f.page);
    vi.mocked(f.store.write).mockImplementationOnce(async () => {
      const newer = f.disk.get('room')!;
      newer.cursor = '11'; newer.messages['1'] = f.message('1', 2);
      throw new Error('CHAT_CACHE_CONFLICT');
    });
    await cache.receive('room', { cursor: '12', changes: [{ type: 'message.deleted', data: { message: f.message('2', 2, true) } }] }, '10');
    expect(f.disk.get('room')?.cursor).toBe('12');
    expect((await cache.projection('room', ['1', '2'])).messages).toEqual([f.message('1', 2), f.message('2', 2, true)]);
  });

  // Unit: another mounted cache can win between actor-read invalidation and save.
  // A retry must still refresh personal metadata before callers acknowledge that event.
  it('retains personal metadata invalidation across a concurrent writer conflict', async () => {
    const f = fixture(); let readSeq = '0';
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async route => route.endsWith('/snapshot')
      ? { room: { id: 'room' }, cursor: '10', messages: [], reads: [{ thread_key: 'main', read_seq: readSeq }] }
      : original(route));
    const cache = f.open(); await cache.snapshot('room');
    readSeq = '9'; cache.invalidate('room', true);
    vi.mocked(f.store.write).mockRejectedValueOnce(new Error('CHAT_CACHE_CONFLICT'));
    expect(await cache.snapshot('room')).toMatchObject({ reads: [{ read_seq: '9' }] });
    expect(f.disk.get('room')?.snapshot).toMatchObject({ reads: [{ read_seq: '9' }] });
    // A second notice arriving during the metadata read must outlive the first
    // refresh's successful commit as well, rather than being cleared with it.
    const responding = f.api.getMockImplementation()!;
    let finish!: () => void;
    f.api.mockImplementation(async route => {
      const value = await responding(route);
      if (route.endsWith('/snapshot')) await new Promise<void>(resolve => { finish = resolve; });
      return value;
    });
    cache.invalidate('room', true); const pending = cache.snapshot('room');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { interval: 1 });
    readSeq = '10'; cache.invalidate('room', true); finish(); await pending;
    f.api.mockImplementation(responding);
    expect(await cache.snapshot('room')).toMatchObject({ reads: [{ read_seq: '10' }] });
  });

  it('stitches known ranges when a new message shifts all older pagination boundaries', async () => {
    const f = fixture(); const cache = f.open();
    let newest = 6;
    f.api.mockImplementation(async route => {
      if (route.endsWith('/snapshot')) return { room: { id: 'room' }, messages: [], cursor: '10' };
      const query = new URL(`https://fixture${route}`).searchParams;
      const before = Number(query.get('before') ?? newest + 1);
      return Array.from({ length: Math.min(3, before - 1) }, (_, n) => f.message(String(before - 1 - n)));
    });
    await cache.page('room', new URLSearchParams('limit=3'));
    await cache.page('room', new URLSearchParams('limit=3&before=4'));
    await cache.receive('room', { cursor: '11', changes: [{ type: 'message.created', data: { message: f.message('7') } }] }, '10');
    newest = 7; f.api.mockClear();
    expect((await cache.page('room', new URLSearchParams('limit=3'))).map(m => m.id)).toEqual(['7', '6', '5']);
    expect((await cache.page('room', new URLSearchParams('limit=3&before=5'))).map(m => m.id)).toEqual(['4', '3', '2']);
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it('reuses covered pages after restart and applies edits and tombstones outside the latest window', async () => {
    const f = fixture();
    await f.open().page('room', f.page);
    f.api.mockClear();
    f.setBatch({ cursor: '12', changes: [
      { type: 'message.updated', entityId: '1', data: { message: f.message('1', 2) } },
      { type: 'message.deleted', entityId: '2', data: { message: f.message('2', 2, true) } },
    ] });
    const fresh = f.open();
    expect(await fresh.page('room', f.page)).toEqual([f.message('2', 2, true), f.message('1', 2)]);
    expect(f.api.mock.calls.map(([route]) => route)).toEqual(['/changes?scope=conversation:room&after=10&limit=100']);
    expect(f.disk.get('room')?.cursor).toBe('12');
    await fresh.page('room', new URLSearchParams('limit=100&before=8'));
    expect(f.api.mock.calls.at(-1)?.[0]).toBe('/conversations/room/messages?limit=100&before=8');
    // A late page carrying revision 1 never resurrects revision 2.
    expect((await fresh.projection('room', ['2'])).messages).toEqual([f.message('2', 2, true)]);
  });

  // PR #7242, unit: one new head at the 500-page limit used to evict each next
  // page during a forward scan. Existing shifted-boundary coverage never filled the cache.
  it('retains the next cached pages during a full scan at capacity after a new message', async () => {
    const f = fixture();
    const state: ChatHistoryState = { generation: 'saved', snapshot: { room: { id: 'room' }, messages: [], cursor: '10' },
      cursor: '10', messages: {}, pages: {}, metadataDirty: false };
    // One message per page keeps the capacity/eviction regression small while using
    // the same production page, persistence and coverage-stitching entry points.
    for (let seq = 500; seq >= 1; seq--) {
      state.messages[String(seq)] = f.message(String(seq));
      state.pages[seq === 500 ? 'limit=1' : `limit=1&before=${seq + 1}`] = [String(seq)];
    }
    f.disk.set('room', state);
    const cache = f.open();
    await cache.receive('room', { cursor: '11', changes: [{ type: 'message.created', data: { message: f.message('501') } }] }, '10');
    f.api.mockImplementation(async route => {
      const before = new URL(`https://fixture${route}`).searchParams.get('before');
      return [f.message(before ? String(Number(before) - 1) : '501')];
    });
    // receive() does not mark the restored cache checked; retain its real empty delta read.
    const messagesApi = f.api.getMockImplementation()!;
    f.api.mockImplementation(async route => route.startsWith('/changes?')
      ? { cursor: '11', changes: [] } : messagesApi(route));
    for (let seq = 501; seq >= 2; seq--) {
      const query = new URLSearchParams(seq === 501 ? 'limit=1' : `limit=1&before=${seq + 1}`);
      expect((await cache.page('room', query)).map(message => message.id)).toEqual([String(seq)]);
    }
    expect(f.api.mock.calls.filter(([route]) => route.includes('/messages?'))).toHaveLength(1);
    expect(Object.keys(f.disk.get('room')!.pages)).toHaveLength(500);
    // Evicting old coverage must not prune the very page the caller is receiving.
    expect(await cache.page('room', new URLSearchParams('limit=1&before=2'))).toEqual([f.message('1')]);
    expect(Object.keys(f.disk.get('room')!.pages)).toHaveLength(500);
  });

  // Personal read positions have an actor cursor, separate from room message changes.
  it('reauthorizes personal snapshot metadata after reconnect even when room changes are empty', async () => {
    const f = fixture(); let readSeq = '0';
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async route => route.endsWith('/snapshot')
      ? { room: { id: 'room' }, cursor: '10', messages: [], reads: [{ thread_key: 'main', read_seq: readSeq }] }
      : original(route));
    const cache = f.open(); await cache.snapshot('room');
    readSeq = '9'; cache.reconnect();
    expect(await cache.snapshot('room')).toMatchObject({ reads: [{ read_seq: '9' }] });
    f.api.mockClear(); cache.invalidate('room'); await cache.snapshot('room');
    expect(f.api.mock.calls.map(([route]) => route)).toEqual(['/changes?scope=conversation:room&after=10&limit=100']);
    // A room loaded from disk after the connection is restored needs the same calibration.
    const restarted = f.open(); readSeq = '10'; restarted.reconnect();
    expect(await restarted.snapshot('room')).toMatchObject({ reads: [{ read_seq: '10' }] });
  });

  it('drops every older range on RESET_REQUIRED and changes the renderer generation', async () => {
    const f = fixture(); const cache = f.open();
    await cache.page('room', f.page);
    const previous = (await cache.projection('room', ['1'])).generation;
    f.api.mockImplementationOnce(async () => { throw new Error('RESET_REQUIRED'); });
    cache.reconnect();
    expect((await cache.projection('room', ['1'])).messages).toEqual([]);
    expect((await cache.projection('room', [])).generation).not.toBe(previous);
    expect(f.disk.get('room')?.pages).toEqual({});
    await cache.page('room', f.page);
    expect(f.api.mock.calls.at(-1)?.[0]).toContain('/messages?');
  });

  it('refreshes reaction aggregates on an old visible page instead of silently retaining old badges', async () => {
    const f = fixture(); const cache = f.open(); await cache.page('room', f.page);
    await cache.receive('room', { cursor: '11', changes: [{ type: 'reaction.changed', entityId: '1', data: { message: f.message('1') } }] }, '10');
    f.api.mockClear();
    f.api.mockResolvedValueOnce([{ ...f.message('2') }, { ...f.message('1'), reactions: [{ emoji: 'like', count: 2 }] }]);
    expect((await cache.projection('room', ['1'])).messages).toEqual([{ ...f.message('1'), reactions: [{ emoji: 'like', count: 2 }] }]);
    expect(f.api.mock.calls.map(([route]) => route)).toEqual(['/conversations/room/messages?limit=100&before=5']);
  });

  // Unit: snapshot() must expose refreshed reactions after reaction.changed; the wire body has no aggregates.
  // Message 9 has no page coverage, so the page regression above misses the stale second snapshot and absent refetch.
  it('refreshes snapshot-only reaction aggregates on the next snapshot read', async () => {
    const f = fixture(); let reactions: unknown[] = [];
    const original = f.api.getMockImplementation()!;
    f.api.mockImplementation(async route => route.endsWith('/snapshot')
      ? { room: { id: 'room' }, cursor: '10', messages: [{ ...f.message('9'), reactions }] }
      : original(route));
    const cache = f.open(); await cache.snapshot('room');
    await cache.receive('room', { cursor: '11', changes: [{ type: 'reaction.changed', entityId: '9', data: { message: f.message('9') } }] }, '10');
    reactions = [{ emoji: 'like', count: 2 }]; f.api.mockClear();
    expect(await cache.snapshot('room')).toMatchObject({ messages: [{ id: '9', reactions }] });
    expect(f.api.mock.calls.map(([route]) => route)).toEqual([
      '/changes?scope=conversation:room&after=11&limit=100',
      '/conversations/room/snapshot',
    ]);
  });

  it('does not advance a durable cursor when saving an event fails, and replays it on restart', async () => {
    const f = fixture(); const cache = f.open();
    await cache.page('room', f.page);
    const batch = { cursor: '11', changes: [{ type: 'message.deleted', data: { message: f.message('1', 2, true) } }] };
    vi.mocked(f.store.write).mockRejectedValueOnce(new Error('disk full'));
    await expect(cache.receive('room', batch, '10')).rejects.toThrow('disk full');
    expect(f.disk.get('room')?.cursor).toBe('10');
    f.setBatch(batch);
    expect((await f.open().page('room', f.page))[1]).toEqual(f.message('1', 2, true));
  });

  it('serializes a delayed page with the next edit and verifies a subscription gap through changes', async () => {
    const f = fixture(); const cache = f.open(); await cache.snapshot('room');
    let finish!: (value: unknown) => void;
    f.api.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const page = cache.page('room', f.page);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'), { interval: 1 });
    const receive = cache.receive('room', { cursor: '11', changes: [{ type: 'message.updated', data: { message: f.message('1', 2) } }] }, '10');
    finish([f.message('1')]); await page; await receive;
    expect((await cache.page('room', f.page))[0]).toEqual(f.message('1', 2));
    f.api.mockClear();
    f.setBatch({ cursor: '20', changes: [{ type: 'message.deleted', data: { message: f.message('1', 3, true) } }] });
    await cache.receive('room', { cursor: '20', changes: [] }, '19');
    expect(f.api.mock.calls[0]?.[0]).toContain('after=11');
    expect((await cache.page('room', f.page))[0]).toEqual(f.message('1', 3, true));
  });

  // PR #7242, unit: a stale deletion conflict must not hide the permission error
  // that makes the caller clear its UI; the next read still has to reauthorize.
  it('preserves a revocation error when another mount wins the cleanup CAS', async () => {
    const f = fixture(); const cache = f.open(); await cache.page('room', f.page);
    vi.mocked(f.store.write).mockImplementationOnce(async () => {
      f.disk.get('room')!.generation = 'newer';
      throw new Error('CHAT_CACHE_CONFLICT');
    });
    f.api.mockRejectedValueOnce(new Error('FORBIDDEN')); cache.reconnect();
    await expect(cache.snapshot('room')).rejects.toThrow('FORBIDDEN');
    expect(f.disk.get('room')?.generation).toBe('newer');
    f.api.mockRejectedValueOnce(new Error('FORBIDDEN'));
    await expect(cache.snapshot('room')).rejects.toThrow('FORBIDDEN');
    expect(f.disk.has('room')).toBe(false);
  });

  it('clears revoked history and never persists a response after an owner switch', async () => {
    const f = fixture(); const cache = f.open(); await cache.page('room', f.page);
    f.api.mockRejectedValueOnce(new Error('CONVERSATION_NOT_FOUND')); cache.reconnect();
    await expect(cache.snapshot('room')).rejects.toThrow('CONVERSATION_NOT_FOUND');
    expect(f.disk.has('room')).toBe(false);
    f.api.mockImplementationOnce(async () => { f.leave(); return { room: { id: 'room' }, messages: [], cursor: '20' }; });
    await expect(cache.snapshot('room')).rejects.toThrow('OWNER_CHANGED');
    expect(f.disk.has('room')).toBe(false);
  });
});
