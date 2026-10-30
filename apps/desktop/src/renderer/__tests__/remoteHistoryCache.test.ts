import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HistoryViewController,
  projectHistoryView,
  type HistoryViewSnapshot,
} from '@cindy/maker-shared/message-window';
import { decodeRemoteHistory, encodeRemoteHistory, fitsRemoteHistoryCache } from '../../shared/remoteHistoryCache';
import { readRemoteHistoryCache, remoteHistoryCacheWriter } from '../lib/remoteHistoryCache';
import {
  clearCachedMessages,
  clearMirrorCacheAccountState,
} from '../features/device-link/mirrorCacheClient';
import { setDataOwnerGeneration } from '../contexts/dataOwnerGeneration';

const row = {
  id: 'm',
  clientId: 'm',
  role: 'user',
  content: 'cached text',
  createdAt: '2026-09-17T00:00:00Z',
};
const snapshot: HistoryViewSnapshot<typeof row> = {
  items: projectHistoryView([row], false),
  details: new Map(),
  expanded: new Set(),
  nextCursor: null,
  hasMore: false,
  ready: true,
  loading: false,
  error: null,
};
const getMessages = vi.fn();
const putMessages = vi.fn();
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
beforeEach(() => {
  clearMirrorCacheAccountState();
  setDataOwnerGeneration('owner');
  getMessages
    .mockReset()
    .mockResolvedValue({
      messages: [],
      historyView: encodeRemoteHistory(snapshot),
      invalidation: 0,
      ownerToken: 'owner-token',
      accountCounter: 0,
    });
  putMessages.mockReset().mockResolvedValue({ ok: true, invalidation: 0 });
  vi.stubGlobal('window', {
    electronAPI: { deviceLink: { mirrorCache: { getMessages, putMessages } } },
  });
});
afterEach(() => {
  clearMirrorCacheAccountState();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('structured history mirror lifecycle', () => {
  it.each(['revision', 'lastMessageId', 'removed'] as const)(
    'drops collapsed stale details on encode and legacy cache reads after %s changes',
    async (change) => {
      await readRemoteHistoryCache('dev', 'session');
      const summary = { key: 'work', firstMessageId: 'm', lastMessageId: 'm', revision: 'r1',
        startedAtMs: 0, endedAtMs: 1, isStreaming: false, messageCount: 1, toolCount: 0 };
      const detail = { messages: [row], revision: 'r1', lastMessageId: 'm', complete: true, loading: false, error: null };
      const cached: typeof snapshot = { ...snapshot, items: [{ type: 'work', key: 'work', summary }],
        details: new Map([['work', detail]]), expanded: new Set() };
      expect(decodeRemoteHistory(encodeRemoteHistory(cached))?.details.size).toBe(1);
      const next: typeof snapshot = { ...cached, items: change === 'removed' ? [] : [
        { type: 'work', key: 'work', summary: { ...summary, [change]: 'new' } },
      ] };
      const encoded = encodeRemoteHistory(next);
      expect(encoded).not.toContain('cached text');
      const legacy = JSON.parse(encoded);
      legacy.details = [...cached.details]; // Cache written before revision filtering existed.
      expect(decodeRemoteHistory(JSON.stringify(legacy))?.details.size).toBe(0);
      remoteHistoryCacheWriter('dev', 'session')(next);
      await flush();
      expect(putMessages).toHaveBeenCalledTimes(1);
      expect(putMessages.mock.calls[0][6]).not.toContain('cached text');
    },
  );

  it('keeps matching nested work and preview details when collapsed', () => {
    const summary = { key: 'work', firstMessageId: 'm', lastMessageId: 'm', revision: 'r1',
      startedAtMs: 0, endedAtMs: 1, isStreaming: false, messageCount: 1, toolCount: 0 };
    const detail = { messages: [row], revision: 'r1', lastMessageId: 'm', complete: true, loading: false, error: null };
    const nested: typeof snapshot = { ...snapshot,
      items: [{ type: 'work', key: 'outer', summary: { ...summary, key: 'outer' }, children: [
        { type: 'work', key: 'work', summary: { ...summary, preview: { ...summary, key: 'preview' } } },
      ] }], details: new Map([['work', detail], ['preview', detail]]) };
    expect([...decodeRemoteHistory(encodeRemoteHistory(nested))!.details.keys()]).toEqual(['work', 'preview']);
  });

  it('keeps the last mirror until current expanded details finish successfully', async () => {
    await readRemoteHistoryCache('dev', 'session');
    const writer = remoteHistoryCacheWriter('dev', 'session');
    const summary = { key: 'work', firstMessageId: 'm', lastMessageId: 'm', revision: 'new',
      startedAtMs: 0, endedAtMs: 1, isStreaming: false, messageCount: 1, toolCount: 0 };
    const complete = { messages: [row], revision: 'new', lastMessageId: 'm',
      complete: true, loading: false, error: null };
    const expanded: typeof snapshot = { ...snapshot,
      items: [{ type: 'work', key: 'work', summary }], expanded: new Set(['work']) };
    writer(expanded); // Missing detail, before the request starts.
    for (const patch of [
      { loading: true, complete: false },
      { loading: false, complete: false, error: 'timeout' },
      { complete: false },
      { revision: 'old' },
      { lastMessageId: 'old' },
    ]) {
      writer({ ...expanded, details: new Map([['work', { ...complete, ...patch }]]) });
    }
    await flush();
    expect(putMessages).not.toHaveBeenCalled();
    writer({ ...expanded, details: new Map([['work', complete]]) });
    await flush();
    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0][6]).toContain('cached text');

    const failed = new Map([['work', { ...complete, complete: false, error: 'timeout' }]]);
    writer({ ...expanded, expanded: new Set(), details: failed }); // Collapsed.
    await flush();
    writer({ ...snapshot, expanded: new Set(['work']), details: failed }); // Removed.
    await flush();
    expect(putMessages).toHaveBeenCalledTimes(3);
  });

  it.each(['中', '\\', '"'])('rejects byte-oversize history containing %s before sending it to Main', async (character) => {
    await readRemoteHistoryCache('dev', 'session');
    const large = { ...snapshot, items: projectHistoryView([{ ...row, content: character.repeat(180_000) }], false) };
    const text = encodeRemoteHistory(large);
    expect(text.length).toBeLessThan(512 * 1024);
    expect(Buffer.byteLength(JSON.stringify({ version: 1, updatedAt: Date.now(), messages: [], historyView: text }), 'utf8')).toBeGreaterThan(512 * 1024);
    remoteHistoryCacheWriter('dev', 'session')(large);
    await flush();
    // Existing oversize invalidation still retires a potentially rewound/deleted old page.
    expect(putMessages).toHaveBeenCalledTimes(1);
    expect(putMessages.mock.calls[0][2]).toEqual([]);
    expect(putMessages.mock.calls[0][6]).toBeUndefined();
  });

  it('reserves enough bytes for the persisted envelope at the ASCII boundary', () => {
    const text = 'a'.repeat(512 * 1024 - 256 - 2);
    expect(fitsRemoteHistoryCache(text)).toBe(true);
    expect(fitsRemoteHistoryCache(text + 'a')).toBe(false);
    const payload = JSON.stringify({ version: 1, updatedAt: Number.MAX_SAFE_INTEGER, messages: [], historyView: text });
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(512 * 1024);
  });

  it('does not let a writer waiting for clear A cross clear B', async () => {
    await readRemoteHistoryCache('dev', 'session');
    let finishA!: (value: unknown) => void;
    let finishB!: (value: unknown) => void;
    putMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishA = resolve;
        }),
    );
    clearCachedMessages('dev', 'session');
    remoteHistoryCacheWriter('dev', 'session')(snapshot);
    putMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishB = resolve;
        }),
    );
    clearCachedMessages('dev', 'session');
    const next = remoteHistoryCacheWriter('dev', 'session');
    finishA({ ok: true, invalidation: 1 });
    finishB({ ok: true, invalidation: 2 });
    await flush();
    expect(putMessages).toHaveBeenCalledTimes(2);
    next(snapshot);
    await flush();
    expect(putMessages.mock.calls[2][3]).toBe(2);
  });

  it('bounds a stalled clear and does not remember its response after owner change', async () => {
    vi.useFakeTimers();
    await readRemoteHistoryCache('dev', 'session');
    let finish!: (value: unknown) => void;
    putMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    clearCachedMessages('dev', 'session');
    remoteHistoryCacheWriter('dev', 'session')(snapshot);
    await vi.advanceTimersByTimeAsync(3000);
    expect(putMessages).toHaveBeenCalledTimes(2);
    expect(putMessages.mock.calls[1][3]).toBeUndefined();
    setDataOwnerGeneration('other');
    clearMirrorCacheAccountState();
    finish({ ok: true, invalidation: 99 });
    await flush();
    const { knownMainInvalidationFor } = await import('../features/device-link/mirrorCacheClient');
    expect(knownMainInvalidationFor('session')).toBeUndefined();
  });

  it('restores offline without a network read; fresh history wins over late disk', async () => {
    const page = vi.fn(async () => ({
      version: 1 as const,
      items: [],
      nextCursor: null,
      hasMore: false,
    }));
    const view = new HistoryViewController({ page, details: vi.fn(), expanded: vi.fn() });
    view.setNetworkAvailable(false);
    await view.restoreCachedView(() => readRemoteHistoryCache('dev', 'session'));
    expect(page).not.toHaveBeenCalled();
    expect(view.getSnapshot().items).toEqual(snapshot.items);
    view.setActive(false);
    const fresh = new HistoryViewController({ page, details: vi.fn(), expanded: vi.fn() });
    let finish!: (value: typeof snapshot) => void;
    const restore = fresh.restoreCachedView(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await fresh.refresh();
    finish(snapshot);
    await restore;
    expect(fresh.getSnapshot().items).toEqual([]);
    fresh.setActive(false);
  });

  it.each(['clear', 'owner'] as const)(
    'rejects late disk and pending writes across %s',
    async (boundary) => {
      await readRemoteHistoryCache('dev', 'session');
      const writer = remoteHistoryCacheWriter('dev', 'session');
      let finish!: (value: unknown) => void;
      getMessages.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const reading = readRemoteHistoryCache('dev', 'session');
      if (boundary === 'clear') clearCachedMessages('dev', 'session');
      else setDataOwnerGeneration('other');
      finish({
        messages: [],
        historyView: encodeRemoteHistory(snapshot),
        invalidation: 0,
        ownerToken: 'owner-token',
        accountCounter: 0,
      });
      expect(await reading).toBeNull();
      writer(snapshot);
      await flush();
      expect(putMessages.mock.calls.filter((call) => call[6] !== undefined)).toHaveLength(0);
    },
  );

  it('captures the pending clear counter for the new read, but rejects the old writer', async () => {
    await readRemoteHistoryCache('dev', 'session');
    const old = remoteHistoryCacheWriter('dev', 'session');
    let finish!: (value: unknown) => void;
    putMessages.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    clearCachedMessages('dev', 'session');
    const next = remoteHistoryCacheWriter('dev', 'session');
    next(snapshot);
    old(snapshot);
    await flush();
    expect(putMessages).toHaveBeenCalledTimes(1);
    finish({ ok: true, invalidation: 1 });
    await flush();
    expect(putMessages).toHaveBeenCalledTimes(2);
    expect(putMessages.mock.calls[1][3]).toBe(1);
    expect(putMessages.mock.calls[1][6]).toBe(encodeRemoteHistory(snapshot));
  });
});
