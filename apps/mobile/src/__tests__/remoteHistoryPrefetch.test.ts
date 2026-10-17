import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryViewController, projectHistoryView, type HistoryViewPage, type HistoryViewSnapshot } from '@cindy/maker-shared/message-window';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearHistoryDisk, fitsHistoryDisk, historyDiskAuthority, readHistoryDisk, writeHistoryDisk } from '@/session/remoteHistoryDiskCache';
import { prefetchRemoteHistories } from '@/session/remoteHistoryPrefetch';
import { clearRemoteHistoryViews, getRemoteHistoryView, mountRemoteHistoryView } from '@/session/remoteHistoryViews';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import type { RemoteMessage, RemoteSession } from '@/session/types';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => ({
  read: async (name: string) => files.get(name) ?? null,
  write: async (name: string, value: string) => { files.set(name, value); },
  remove: async (name: string) => { files.delete(name); },
  files: async () => [...files.keys()],
}) }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global' }));

const DEVICE = 'host-1';
const row = (id: string, second: number, content = id): RemoteMessage => ({
  id, clientId: id, sessionId: 's', role: 'assistant', content, toolUseId: null, agentMeta: null,
  createdAt: `2026-10-11T00:00:${String(second).padStart(2, '0')}.000Z`,
});
const page = (rows: RemoteMessage[]): HistoryViewPage<RemoteMessage> => ({
  version: 1, items: projectHistoryView(rows, false), hasMore: false, nextCursor: null,
});
const snapshotOf = (rows: RemoteMessage[]): HistoryViewSnapshot<RemoteMessage> => ({
  ...page(rows), details: new Map(), expanded: new Set(), loading: false, ready: true, error: null,
});
function session(id: string, updatedAt: string, patch: Partial<RemoteSession> = {}): RemoteSession {
  return {
    id, userId: 'user-1', title: id, workingDir: '/repo', workspaceKind: 'project', model: 'claude',
    effort: 'medium', permissionMode: 'default', fastMode: false, status: 'active', agentKind: 'cc',
    pinnedAt: null, userSendAt: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt, ...patch,
  } as RemoteSession;
}

afterEach(async () => {
  clearRemoteHistoryViews();
  await clearHistoryDisk();
  remoteSessionStore.clear();
  setMobileAuthOwner(null);
});

describe('history read ahead after a list refresh', () => {
  // A bounded reconnect read is not a superset of completion targets. Hold one
  // real read pending, then enqueue both request kinds in either order.
  it.each([false, true])('retains completion targets alongside a queued reconnect (recent first=%s)', async (recentFirst) => {
    setMobileAuthOwner('user-1');
    const running = Array.from({ length: 5 }, (_, i) => session(`running-${i}`, '2026-10-11T00:00:09Z', { activeTurnStartedAt: 100 }));
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [
      session('held', '2026-10-11T00:00:01Z'), session('done', '2026-10-11T00:00:02Z', { lastTurnEndedAt: 100 }), ...running,
    ]);
    let release!: () => void;
    const reader = { readHistoryView: vi.fn(async (id: string) => {
      if (id === 'held') await new Promise<void>(resolve => { release = resolve; });
      return page([row(id, 9)]);
    }) };
    const first = prefetchRemoteHistories(DEVICE, reader, () => true, new Set(['held']));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const reconnect = () => prefetchRemoteHistories(DEVICE, reader, () => true);
    const completion = () => prefetchRemoteHistories(DEVICE, reader, () => true, new Set(['done']));
    if (recentFirst) { await reconnect(); await completion(); }
    else { await completion(); await reconnect(); }
    release();
    await first;
    expect(reader.readHistoryView.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining(['done', ...running.map(s => s.id)]));
    expect((await readHistoryDisk(historyDiskAuthority(DEVICE, 'done')))?.items).toEqual(page([row('done', 9)]).items);
  });

  // Unit regression: completion must warm its own disk page without reading
  // unrelated running tasks; ordinary preview/ack patches must not cause traffic.
  it('reads only the completed task and ignores repeated completion and preview patches', async () => {
    setMobileAuthOwner('user-1');
    const start = Date.parse('2026-10-11T00:00:01Z');
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [
      session('s', '2026-10-11T00:00:01Z', { activeTurnStartedAt: start }),
      session('running', '2026-10-11T00:00:09Z', { activeTurnStartedAt: start }),
    ]);
    const reader = { readHistoryView: vi.fn(async () => page([row('reply', 9)])) };
    const reads: Promise<void>[] = [];
    const off = remoteSessionStore.onSessionHistoryPrefetchRequested((device, id) => {
      reads.push(prefetchRemoteHistories(device, reader, () => true, id ? new Set([id]) : undefined));
    });
    try {
      remoteSessionStore.applySessionPatch(DEVICE, 's', { preview: 'still running' });
      expect(reader.readHistoryView).not.toHaveBeenCalled();
      remoteSessionStore.applySessionPatch(DEVICE, 's', { lastTurnEndedAt: start + 10_000 });
      await Promise.all(reads);
      expect(reader.readHistoryView.mock.calls).toEqual([['s']]);
      expect((await readHistoryDisk(historyDiskAuthority(DEVICE, 's')))?.items).toEqual(page([row('reply', 9)]).items);
      remoteSessionStore.applySessionPatch(DEVICE, 's', { lastTurnEndedAt: start + 10_000 });
      remoteSessionStore.applySessionPatch(DEVICE, 's', { preview: 'final reply' });
      await Promise.all(reads);
      expect(reader.readHistoryView).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });

  it.each(['prefix', 'collapsed', 'latest'] as const)('handles an oversized %s without losing the offline cache', async (kind) => {
    setMobileAuthOwner('user-1');
    const old = row('old', 1, 'x'.repeat(1_250_000));
    const anchor = row('anchor', 2);
    const previous = snapshotOf([old, anchor]);
    if (kind === 'collapsed') {
      previous.items = [{ type: 'work', key: 'work', summary: {
        key: 'work', firstMessageId: old.id, lastMessageId: old.id, revision: 'r1',
        startedAtMs: Date.parse(old.createdAt), endedAtMs: Date.parse(old.createdAt),
        messageCount: 1, toolCount: 1, isStreaming: false,
      } }, ...page([anchor]).items];
      previous.details = new Map([['work', { messages: [old], revision: 'r1', lastMessageId: old.id,
        complete: true, loading: false, error: null }]]);
    }
    const authority = historyDiskAuthority(DEVICE, 's');
    expect(await writeHistoryDisk(authority, previous)).toBe(true);
    const reply = row('new', 9, 'y'.repeat(kind === 'latest' ? 1_500_000 : 200_000));
    const latest = { ...page([anchor, reply]), hasMore: true, nextCursor: anchor.id };
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', reply.createdAt)]);
    const reader = { readHistoryView: vi.fn(async () => latest) };
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    const cached = await readHistoryDisk(authority);
    expect(cached).not.toBeNull();
    expect(fitsHistoryDisk(cached!)).toBe(true);
    if (kind === 'latest') {
      expect(cached?.items).toEqual(previous.items);
      // Skipping an oversized latest page does not mark this activity version as cached.
      reader.readHistoryView.mockResolvedValueOnce({ ...page([anchor, row('small', 9)]), hasMore: true, nextCursor: anchor.id });
      await prefetchRemoteHistories(DEVICE, reader, () => true);
      expect(reader.readHistoryView).toHaveBeenCalledTimes(2);
      expect((await readHistoryDisk(authority))?.items.at(-1)?.key).toBe('small');
    } else {
      expect(cached?.items.at(-1)?.key).toBe(reply.id);
      expect(cached?.details.size).toBe(0);
      expect(cached).toMatchObject(kind === 'prefix'
        ? { hasMore: true, nextCursor: anchor.id } : { hasMore: false, nextCursor: null });
      expect(cached?.items[0].key).toBe(kind === 'prefix' ? latest.items[0].key : 'work');
    }
  });

  it('fires on the first list and on a reconnect reseed, not on ordinary refreshes', () => {
    const seen: string[] = [];
    const off = remoteSessionStore.onSessionHistoryPrefetchRequested((deviceId) => seen.push(deviceId));
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', '2026-10-11T00:00:01.000Z')]);
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', '2026-10-11T00:00:02.000Z')]);
    remoteSessionStore.requestReseed(DEVICE);
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', '2026-10-11T00:00:02.000Z')]);
    off();
    expect(seen).toEqual([DEVICE, DEVICE]);
  });

  it('writes the latest page of a changed task so opening it restores the new reply', async () => {
    setMobileAuthOwner('user-1');
    const authority = historyDiskAuthority(DEVICE, 's');
    expect(await writeHistoryDisk(authority, snapshotOf([row('a1', 1)]))).toBe(true);
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [
      session('s', '2026-10-11T00:00:09.000Z'),
      session('covered', '2026-10-11T00:00:00.000Z'),
      session('scheduled', '2026-10-11T00:00:09.000Z', { source: 'scheduler' }),
    ]);
    await writeHistoryDisk(historyDiskAuthority(DEVICE, 'covered'), snapshotOf([{ ...row('c1', 0), sessionId: 'covered' }]));
    const reader = { readHistoryView: vi.fn(async (sessionId: string) => page(
      sessionId === 's' ? [row('a1', 1), row('a2', 9, 'reply written while the phone was away')] : [])) };
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    expect(reader.readHistoryView.mock.calls.map(([sessionId]) => sessionId)).toEqual(['s']);
    const cached = await readHistoryDisk(historyDiskAuthority(DEVICE, 's'));
    expect(cached?.items).toEqual(page([row('a1', 1), row('a2', 9, 'reply written while the phone was away')]).items);

    // The same version is not read again; a newer update is.
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    expect(reader.readHistoryView).toHaveBeenCalledTimes(1);
    // Clearing the disk cache (sign-out, account switch) invalidates that record.
    await clearHistoryDisk();
    reader.readHistoryView.mockClear();
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    expect(reader.readHistoryView.mock.calls.map(([sessionId]) => sessionId)).toContain('s');
    expect(await readHistoryDisk(historyDiskAuthority(DEVICE, 's'))).not.toBeNull();
    reader.readHistoryView.mockClear();
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', '2026-10-11T00:00:20.000Z')]);
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    expect(reader.readHistoryView.mock.calls.map(([sessionId]) => sessionId)).toEqual(['s']);
  });

  it('leaves a mounted task to its own view and stops on a Host without history view', async () => {
    setMobileAuthOwner('user-1');
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [
      session('open', '2026-10-11T00:00:09.000Z'), session('other', '2026-10-11T00:00:08.000Z'),
    ]);
    const source = { readHistoryView: vi.fn(async () => page([])),
      readWorkDetails: vi.fn(async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null })),
      setHistoryExpanded: vi.fn(async () => undefined) };
    const release = mountRemoteHistoryView(getRemoteHistoryView(DEVICE, 'open', source), source, false);
    const reader = { readHistoryView: vi.fn(async (_sessionId: string): Promise<HistoryViewPage<RemoteMessage>> => {
      throw new Error('[CHANNEL_NOT_ALLOWED] History view is unavailable');
    }) };
    await prefetchRemoteHistories(DEVICE, reader, () => true);
    release();
    expect(reader.readHistoryView.mock.calls.map(([sessionId]) => sessionId)).toEqual(['other']);
  });

  it('restores previously read history offline after background read ahead saves a newer page', async () => {
    setMobileAuthOwner('user-1');
    const earlier: RemoteMessage = { ...row('u1', 1), role: 'user' };
    const answer = row('a1', 2);
    const latest: RemoteMessage = { ...row('u2', 3), role: 'user' };
    const reply = row('a2', 9);
    await writeHistoryDisk(historyDiskAuthority(DEVICE, 's'), snapshotOf([earlier, answer, latest]));
    remoteSessionStore.setDeviceSessions(DEVICE, 'Mac', [session('s', reply.createdAt)]);
    const reader = { readHistoryView: vi.fn(async () => ({
      ...page([latest, reply]), hasMore: true, nextCursor: latest.id,
    })) };
    await prefetchRemoteHistories(DEVICE, reader, () => true);

    const transport = { page: vi.fn(), details: vi.fn(), expanded: vi.fn() };
    const offline = new HistoryViewController<RemoteMessage>(transport);
    offline.setNetworkAvailable(false);
    await offline.restoreCachedView(() => readHistoryDisk(historyDiskAuthority(DEVICE, 's')));
    expect(offline.getSnapshot().items).toEqual(page([earlier, answer, latest, reply]).items);
    expect(offline.getSnapshot()).toMatchObject({ hasMore: false, nextCursor: null });
    expect(await offline.locate(earlier.clientId, earlier.createdAt)).toEqual(earlier);
    expect(transport.page).not.toHaveBeenCalled();
  });
});
