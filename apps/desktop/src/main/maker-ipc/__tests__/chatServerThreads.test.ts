import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThreadProjection, isShareableThreadReply, threadPreviewAttachments, threadPreviewText, type ThreadMessage } from '../chatServerThreads.js';
import { buildBotGroupThreadShareCard } from '../../../shared/botGroupChat.js';

const room = '10000000-0000-4000-8000-000000000001';
const rootA = '20000000-0000-4000-8000-00000000000a';
const rootB = '20000000-0000-4000-8000-00000000000b';
let seq = 0;
function message(overrides: Partial<ThreadMessage> & { id: string }): ThreadMessage {
  seq += 1;
  return { seq: String(seq), authorId: 'author', deleted: false, threadRootId: null, content: [{ type: 'text', text: overrides.id }], ...overrides };
}
const reply = (id: string, rootId: string, extra: Partial<ThreadMessage> = {}) => message({ id, threadRootId: rootId, ...extra });
const fullWindow = (messages: ThreadMessage[]) => [...messages, ...Array.from({ length: 100 - messages.length }, (_, i) => message({ id: `filler-${i}` }))];
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const makeIo = () => ({ threadPage: vi.fn(), message: vi.fn(), filled: vi.fn() });

describe('thread previews', () => {
  let io: ReturnType<typeof makeIo>;
  let projection: ReturnType<typeof createThreadProjection<ThreadMessage>>;
  beforeEach(() => { io = makeIo(); projection = createThreadProjection(io); });
  afterEach(() => vi.useRealTimers());

  it('uses the snapshot window for active threads without any extra request', () => {
    const root = message({ id: rootA, replyCount: 3 });
    // Newest first, like the server snapshot; a deleted reply never previews.
    const window = fullWindow([reply('r3', rootA), reply('gone', rootA, { deleted: true }), reply('r2', rootA), reply('r1', rootA)]);
    expect(projection.previews(room, [root], window).get(rootA)!.map(m => m.id)).toEqual(['r2', 'r3']);
    expect(io.threadPage).not.toHaveBeenCalled();
  });

  it('treats a short snapshot as the whole history', () => {
    const root = message({ id: rootA, replyCount: 1 });
    expect(projection.previews(room, [root], [reply('only', rootA)]).get(rootA)!.map(m => m.id)).toEqual(['only']);
    expect(io.threadPage).not.toHaveBeenCalled();
  });

  it('answers at once and fills quiet threads in the background, then asks for one refresh', async () => {
    const root = message({ id: rootB, replyCount: 2 });
    const page = deferred<ThreadMessage[]>();
    io.threadPage.mockReturnValue(page.promise);
    // The room is not held back by the thread read.
    expect(projection.previews(room, [root], fullWindow([])).has(rootB)).toBe(false);
    expect(io.threadPage).toHaveBeenCalledWith(room, rootB, 6, undefined);
    // A refresh while the read is in flight does not start a second one.
    projection.previews(room, [root], fullWindow([]));
    expect(io.threadPage).toHaveBeenCalledTimes(1);
    page.resolve([reply('b2', rootB), reply('b1', rootB)]);
    await projection.settled();
    expect(io.filled).toHaveBeenCalledExactlyOnceWith(room);
    expect(projection.previews(room, [root], fullWindow([])).get(rootB)!.map(m => m.id)).toEqual(['b1', 'b2']);
    expect(io.threadPage).toHaveBeenCalledTimes(1);
    // A new reply changes the count, so the cached page is no longer trusted.
    projection.previews(room, [{ ...root, replyCount: 3 }], fullWindow([]));
    expect(io.threadPage).toHaveBeenCalledTimes(2);
  });

  it('reads further back when deleted replies fill the newest page', async () => {
    const root = message({ id: rootB, replyCount: 2 });
    const tombstones = Array.from({ length: 5 }, (_, i) => reply(`gone-${i}`, rootB, { deleted: true }));
    const older = reply('old-1', rootB);
    io.threadPage
      .mockResolvedValueOnce([...tombstones, reply('newest', rootB)])
      .mockResolvedValueOnce([older, reply('old-2', rootB)]);
    projection.previews(room, [root], fullWindow([]));
    await projection.settled();
    const before = [...tombstones, reply('x', rootB)].reduce((min, m) => Math.min(min, Number(m.seq)), Infinity);
    expect(io.threadPage).toHaveBeenNthCalledWith(2, room, rootB, 6, expect.any(String));
    expect(Number(io.threadPage.mock.calls[1]![3])).toBeLessThanOrEqual(before);
    expect(projection.previews(room, [root], fullWindow([])).get(rootB)!.map(m => m.id)).toEqual(['old-1', 'newest']);
  });

  it('stops reading back once history ends or after a bounded number of pages', async () => {
    const root = message({ id: rootB, replyCount: 2 });
    io.threadPage.mockImplementation(async () => Array.from({ length: 6 }, (_, i) => reply(`gone-${i}`, rootB, { deleted: true })));
    projection.previews(room, [root], fullWindow([]));
    await projection.settled();
    expect(io.threadPage).toHaveBeenCalledTimes(4);
    io.threadPage.mockClear().mockResolvedValue([reply('only', rootB)]);
    projection.previews(room, [{ ...root, replyCount: 5 }], fullWindow([]));
    await projection.settled();
    expect(io.threadPage).toHaveBeenCalledTimes(1);
  });

  it('drops a cached page when one of its replies is edited or deleted, and resets after reconnect', async () => {
    const root = message({ id: rootB, replyCount: 1 });
    io.threadPage.mockResolvedValue([reply('b1', rootB)]);
    const read = async () => { projection.previews(room, [root], fullWindow([])); await projection.settled(); };
    await read();
    projection.invalidate(room, 'unrelated');
    await read();
    expect(io.threadPage).toHaveBeenCalledTimes(1);
    projection.invalidate(room, 'b1');
    await read();
    expect(io.threadPage).toHaveBeenCalledTimes(2);
    projection.reset();
    await read();
    expect(io.threadPage).toHaveBeenCalledTimes(3);
  });

  it('shows a new reply in the window even when a deletion keeps the reply count unchanged', async () => {
    const root = message({ id: rootB, replyCount: 3 });
    io.threadPage.mockResolvedValue([reply('b3', rootB), reply('b2', rootB), reply('b1', rootB)]);
    projection.previews(room, [root], fullWindow([]));
    await projection.settled();
    // An older reply is deleted while b4 arrives: still three replies.
    const newest = reply('b4', rootB);
    const previews = projection.previews(room, [root], fullWindow([newest]));
    expect(previews.get(rootB)!.map(m => m.id)).toEqual(['b3', 'b4']);
    expect(io.threadPage).toHaveBeenCalledTimes(1);
  });

  it('bounds concurrent reads and backs off a failed thread instead of failing the room', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let active = 0, peak = 0;
    io.threadPage.mockImplementation(async (_room: string, rootId: string) => {
      active += 1; peak = Math.max(peak, active);
      await Promise.resolve(); active -= 1;
      if (rootId.endsWith('0')) throw new Error('offline');
      return [reply(`latest-${rootId}`, rootId)];
    });
    const roots = Array.from({ length: 20 }, (_, i) => message({ id: `30000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, replyCount: 1 }));
    projection.previews(room, roots, fullWindow([]));
    await projection.settled();
    expect(peak).toBeLessThanOrEqual(6);
    expect(projection.previews(room, roots, fullWindow([])).size).toBe(18);
    io.threadPage.mockClear();
    projection.previews(room, roots, fullWindow([]));
    expect(io.threadPage).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + 31_000);
    projection.previews(room, roots, fullWindow([]));
    await projection.settled();
    expect(io.threadPage).toHaveBeenCalledTimes(2);
  });

  it('ignores replies themselves and roots without replies', () => {
    const previews = projection.previews(room, [message({ id: rootA, replyCount: 0 }), reply('nested', rootA, { replyCount: 4 })], fullWindow([]));
    expect(previews.size).toBe(0);
    expect(io.threadPage).not.toHaveBeenCalled();
  });
});

describe('share sources', () => {
  let io: ReturnType<typeof makeIo>;
  let projection: ReturnType<typeof createThreadProjection<ThreadMessage>>;
  beforeEach(() => { io = makeIo(); projection = createThreadProjection(io); });
  const share = (id: string, messageId: string) => message({ id, content: [buildBotGroupThreadShareCard({ messageId, threadRootId: rootA, authorName: 'Miao', text: 'hi' })] });
  const sourceId = '40000000-0000-4000-8000-000000000001';

  it('prefers fresh snapshot copies and reads each missing reply once, in the background', async () => {
    const fresh = reply(sourceId, rootA);
    expect(projection.shareSources(room, [share('s1', sourceId)], [fresh]).get(sourceId)).toBe(fresh);
    expect(io.message).not.toHaveBeenCalled();
    const other = '40000000-0000-4000-8000-000000000002';
    io.message.mockResolvedValue(reply(other, rootA));
    // Still being read: absent, so the caller shows a loading state rather than the card text.
    expect(projection.shareSources(room, [share('s2', other), share('s3', other)], []).has(other)).toBe(false);
    projection.shareSources(room, [share('s2', other)], []);
    await projection.settled();
    expect(io.message).toHaveBeenCalledTimes(1);
    expect(io.filled).toHaveBeenCalledWith(room);
    expect(projection.shareSources(room, [share('s2', other)], []).get(other)?.id).toBe(other);
  });

  it('remembers a reply the reader may not see and forgets edited ones', async () => {
    io.message.mockResolvedValue(null);
    projection.shareSources(room, [share('s1', sourceId)], []);
    await projection.settled();
    expect(projection.shareSources(room, [share('s1', sourceId)], []).get(sourceId)).toBeNull();
    io.message.mockResolvedValue(reply(sourceId, rootA, { revision: 2 }));
    projection.invalidate(room, sourceId);
    projection.shareSources(room, [share('s1', sourceId)], []);
    await projection.settled();
    expect(projection.shareSources(room, [share('s1', sourceId)], []).get(sourceId)?.revision).toBe(2);
  });

  it('keeps a share unresolved, without asking for a refresh, while the server cannot be reached', async () => {
    io.message.mockRejectedValue(new Error('offline'));
    projection.shareSources(room, [share('s1', sourceId)], []);
    await projection.settled();
    expect(projection.shareSources(room, [share('s1', sourceId)], []).has(sourceId)).toBe(false);
    expect(io.filled).not.toHaveBeenCalled();
  });

  it('does not treat a card posted inside a thread as a share', () => {
    const nested = { ...share('s1', sourceId), threadRootId: rootA };
    expect(projection.shareSources(room, [nested], []).size).toBe(0);
  });
});

describe('late reads after a reset or invalidation', () => {
  const sourceId = '40000000-0000-4000-8000-000000000001';
  const share = message({ id: 's1', content: [buildBotGroupThreadShareCard({ messageId: sourceId, threadRootId: rootA, authorName: 'Miao', text: 'hi' })] });

  it.each(['reset', 'invalidate'] as const)('does not let a thread page started before %s refill the cache', async (clear) => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    const root = message({ id: rootB, replyCount: 1 });
    const stale = deferred<ThreadMessage[]>();
    io.threadPage.mockReturnValueOnce(stale.promise).mockResolvedValue([reply('b1', rootB, { revision: 2 })]);
    projection.previews(room, [root], fullWindow([]));
    if (clear === 'reset') projection.reset(); else projection.invalidate(room, 'b1');
    stale.resolve([reply('b1', rootB)]);
    await projection.settled();
    // The stale copy is dropped, but the reader is still told to look again.
    expect(io.filled).toHaveBeenCalledWith(room);
    projection.previews(room, [root], fullWindow([]));
    await projection.settled();
    expect(io.threadPage).toHaveBeenCalledTimes(2);
    expect(projection.previews(room, [root], fullWindow([])).get(rootB)![0]!.revision).toBe(2);
  });

  it.each(['reset', 'invalidate'] as const)('does not let a share source read started before %s refill the cache', async (clear) => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    const stale = deferred<ThreadMessage | null>();
    io.message.mockReturnValueOnce(stale.promise).mockResolvedValue(reply(sourceId, rootA, { revision: 2 }));
    projection.shareSources(room, [share], []);
    if (clear === 'reset') projection.reset(); else projection.invalidate(room, sourceId);
    stale.resolve(reply(sourceId, rootA));
    await projection.settled();
    projection.shareSources(room, [share], []);
    await projection.settled();
    expect(io.message).toHaveBeenCalledTimes(2);
    expect(projection.shareSources(room, [share], []).get(sourceId)?.revision).toBe(2);
  });

  it.each(['reset', 'invalidate'] as const)('asks for a fresh read when a read started before %s fails', async (clear) => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    let fail!: (error: Error) => void;
    io.message.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; })).mockResolvedValue(reply(sourceId, rootA));
    projection.shareSources(room, [share], []);
    // An unrelated edit: the refresh it causes skips the read still in flight.
    if (clear === 'reset') projection.reset(); else projection.invalidate(room, 'another-message');
    expect(projection.shareSources(room, [share], []).has(sourceId)).toBe(false);
    fail(new Error('offline'));
    await projection.settled();
    expect(io.filled).toHaveBeenCalledWith(room);
    projection.shareSources(room, [share], []);
    await projection.settled();
    expect(io.message).toHaveBeenCalledTimes(2);
    expect(projection.shareSources(room, [share], []).get(sourceId)?.id).toBe(sourceId);
  });

  it('keeps reads in one room when another room is edited', async () => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    const otherRoom = '10000000-0000-4000-8000-000000000002';
    const pending = deferred<ThreadMessage | null>();
    io.message.mockReturnValueOnce(pending.promise);
    const before = projection.version(room);
    projection.shareSources(room, [share], []);
    projection.invalidate(otherRoom, 'elsewhere');
    expect(projection.version(room)).toBe(before);
    expect(projection.version(otherRoom)).toBeGreaterThan(before);
    pending.resolve(reply(sourceId, rootA));
    await projection.settled();
    expect(io.message).toHaveBeenCalledTimes(1);
    expect(projection.shareSources(room, [share], []).get(sourceId)?.id).toBe(sourceId);
    // A reset still raises every room.
    const edited = projection.version(otherRoom);
    projection.reset();
    expect(projection.version(room)).toBeGreaterThan(before);
    expect(projection.version(otherRoom)).toBeGreaterThan(edited);
  });
});

describe('reply summaries', () => {
  it('summarizes text separately from files and refuses system or deleted replies', () => {
    const files = reply('f', rootA, { content: [{ type: 'text', text: '  第一行\n第二行 ' }, { type: 'media', mediaId: 'm1', caption: 'shot.PNG' }, { type: 'media', mediaId: 'm2', caption: 'notes.pdf' }] });
    expect(threadPreviewText(files)).toBe('第一行 第二行');
    expect(threadPreviewAttachments(files, block => block.caption!)).toEqual([{ name: 'shot.PNG', category: 'image' }, { name: 'notes.pdf', category: 'file' }]);
    expect(threadPreviewText(reply('long', rootA, { content: [{ type: 'text', text: 'x'.repeat(400) }] }))).toHaveLength(280);
    expect(isShareableThreadReply(files)).toBe(true);
    expect(isShareableThreadReply(message({ id: 'root' }))).toBe(false);
    expect(isShareableThreadReply(reply('d', rootA, { deleted: true }))).toBe(false);
    expect(isShareableThreadReply(reply('s', rootA, { origin: 'system' }))).toBe(false);
    expect(isShareableThreadReply(reply('n', rootA, { content: [{ type: 'card', namespace: 'cindy.group-notice', fallback: 'x' }] }))).toBe(false);
  });
});

describe('recovering from a failed read in a quiet room', () => {
  const sourceId = '40000000-0000-4000-8000-000000000001';
  const share = message({ id: 's1', content: [buildBotGroupThreadShareCard({ messageId: sourceId, threadRootId: rootA, authorName: 'Miao', text: 'hi' })] });
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('asks for one more read after the backoff even when nothing else happens', async () => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    io.message.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(reply(sourceId, rootA));
    // The adapter answers `filled` by reading again, like a push would.
    io.filled.mockImplementation(() => { projection.shareSources(room, [share], []); });
    projection.shareSources(room, [share], []);
    await projection.settled();
    expect(io.filled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(io.message).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await projection.settled();
    expect(io.message).toHaveBeenCalledTimes(2);
    expect(projection.shareSources(room, [share], []).get(sourceId)?.id).toBe(sourceId);
  });

  it.each(['source', 'preview'] as const)('invalidates failed %s reads immediately without waking another room early', async kind => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    const root = message({ id: rootA, replyCount: 1 });
    const read = (id: string) => kind === 'source'
      ? projection.shareSources(id, [share], []) : projection.previews(id, [root], fullWindow([]));
    io.message.mockRejectedValue(new Error('offline'));
    io.threadPage.mockRejectedValue(new Error('offline'));
    read(room); read('other-room');
    await projection.settled();
    await vi.advanceTimersByTimeAsync(1_000);
    projection.invalidate(room, sourceId);
    io.message.mockResolvedValue(null); // The source was deleted.
    io.threadPage.mockResolvedValue([reply(sourceId, rootA, { content: [{ type: 'text', text: 'edited' }] })]);
    read(room); read('other-room');
    await projection.settled();
    const requests = kind === 'source' ? io.message.mock.calls : io.threadPage.mock.calls;
    expect(requests.map(([id]) => id)).toEqual([room, 'other-room', room]);
    if (kind === 'source') expect(read(room).get(sourceId)).toBeNull();
    else expect(read(room).get(rootA)).toEqual([expect.objectContaining({ content: [{ type: 'text', text: 'edited' }] })]);
    io.filled.mockClear();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(io.filled.mock.calls).toEqual([['other-room']]);
    projection.dispose();
  });

  it('backs off and stops retrying by itself after a bounded number of attempts', async () => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    io.threadPage.mockRejectedValue(new Error('offline'));
    const root = message({ id: rootB, replyCount: 1 });
    io.filled.mockImplementation(() => { projection.previews(room, [root], fullWindow([])); });
    projection.previews(room, [root], fullWindow([]));
    await projection.settled();
    const gaps: number[] = [];
    let last = Date.now();
    for (let step = 0; step < 40; step += 1) {
      const before = io.threadPage.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      await projection.settled();
      if (io.threadPage.mock.calls.length > before) { gaps.push(Date.now() - last); last = Date.now(); }
    }
    // 5 automatic retries with doubling gaps, then it waits for a push or a reopen.
    expect(io.threadPage).toHaveBeenCalledTimes(6);
    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    // Once it has given up, the next push or reopening reads again at once.
    io.threadPage.mockResolvedValue([reply('r1', rootB)]);
    projection.previews(room, [root], fullWindow([]));
    await projection.settled();
    expect(io.threadPage).toHaveBeenCalledTimes(7);
    expect(projection.previews(room, [root], fullWindow([])).get(rootB)?.map(item => item.id)).toEqual(['r1']);
  });

  it.each(['dispose', 'reset'] as const)('cancels a pending retry on %s', async (stop) => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    io.message.mockRejectedValue(new Error('offline'));
    projection.shareSources(room, [share], []);
    await projection.settled();
    projection[stop]();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(io.filled).not.toHaveBeenCalled();
  });
});

describe('one wake-up per room with several failed reads', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());
  const idA = '40000000-0000-4000-8000-00000000000a';
  const idB = '40000000-0000-4000-8000-00000000000b';
  const card = (id: string, messageId: string) => message({ id, content: [buildBotGroupThreadShareCard({ messageId, threadRootId: rootA, authorName: 'Miao', text: 'hi' })] });
  const shares = [card('sa', idA), card('sb', idB)];

  it('keeps waking up for a later deadline after an earlier one has recovered', async () => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    const failOnce = new Set([idA, idB]);
    io.message.mockImplementation(async (_room: string, id: string) => {
      if (failOnce.delete(id)) throw new Error('offline');
      return reply(id, rootA);
    });
    io.filled.mockImplementation(() => { projection.shareSources(room, shares, []); });
    projection.shareSources(room, [shares[0]!], []);       // A fails at t0 → due t30
    await projection.settled();
    await vi.advanceTimersByTimeAsync(5_000);
    projection.shareSources(room, [shares[1]!], []);       // B fails at t5 → due t35
    await projection.settled();
    await vi.advanceTimersByTimeAsync(25_000);             // t30: A retried and recovered; B not yet due
    await projection.settled();
    expect(projection.shareSources(room, shares, []).get(idA)?.id).toBe(idA);
    expect(projection.shareSources(room, shares, []).has(idB)).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);              // t35: nothing else happens in the room
    await projection.settled();
    expect(projection.shareSources(room, shares, []).get(idB)?.id).toBe(idB);
    // Both recovered: no further wake-ups.
    io.filled.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(io.filled).not.toHaveBeenCalled();
  });

  it('keeps each read to its own five automatic retries when failures are staggered', async () => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    let bFailed = false;
    io.message.mockImplementation(async (_room: string, id: string) => {
      if (id === idA) throw new Error('offline');
      if (!bFailed) { bFailed = true; throw new Error('offline'); }
      return reply(id, rootA);
    });
    io.filled.mockImplementation(() => { projection.shareSources(room, shares, []); });
    projection.shareSources(room, [shares[0]!], []);
    await projection.settled();
    await vi.advanceTimersByTimeAsync(5_000);
    projection.shareSources(room, [shares[1]!], []);
    await projection.settled();
    for (let step = 0; step < 200; step += 1) { await vi.advanceTimersByTimeAsync(30_000); await projection.settled(); }
    const reads = (id: string) => io.message.mock.calls.filter(([, value]) => value === id).length;
    expect(reads(idA)).toBe(6);
    expect(reads(idB)).toBe(2);
    expect(projection.shareSources(room, shares, []).get(idB)?.id).toBe(idB);
    // A gave up and B recovered: the room has nothing left to wake up for.
    io.filled.mockClear();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(io.filled).not.toHaveBeenCalled();
  });

  it.each(['dispose', 'reset'] as const)('cancels every pending wake-up of the room on %s', async (stop) => {
    const io = makeIo();
    const projection = createThreadProjection(io);
    io.message.mockRejectedValue(new Error('offline'));
    projection.shareSources(room, [shares[0]!], []);
    await projection.settled();
    await vi.advanceTimersByTimeAsync(5_000);
    projection.shareSources(room, [shares[1]!], []);
    await projection.settled();
    projection[stop]();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(io.filled).not.toHaveBeenCalled();
  });
});
