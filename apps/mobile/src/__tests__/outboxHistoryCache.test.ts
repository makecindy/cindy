import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryViewController, projectHistoryView, type HistoryViewPage } from '@cindy/maker-shared/message-window';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { cacheOutboxHistory } from '@/session/outboxHistoryCache';
import { clearHistoryDisk, historyDiskAuthority, readHistoryDisk } from '@/session/remoteHistoryDiskCache';
import { cacheSessionMessagesIfCurrent, captureSessionMessageCacheWriteAuthority, getCachedSessionMessages } from '@/session/mobileSessionMessageCache';
import { remoteSessionStore, useSessionMessages } from '@/session/remoteSessionStore';
import { clearRemoteHistoryViews, getRemoteHistoryView, mountRemoteHistoryView } from '@/session/remoteHistoryViews';
import type { RemoteMessage } from '@/session/types';

type Effect = () => void | (() => void);
// `mount` (when set) keeps one hook instance across renders: refs keep their slot, and an effect
// re-runs only when its deps change, after the previous run's cleanup, like React.
interface Mount { refs: { current: unknown }[]; effects: { deps?: readonly unknown[]; cleanup?: () => void }[];
  pending: (() => void)[]; cursor: { ref: number; effect: number } }
const state = vi.hoisted(() => ({ rows: [] as RemoteMessage[], fail: false,
  effects: [] as Effect[], mount: null as Mount | null, rawWrites: 0,
  files: new Map<string, string>(), raw: new Map<string, string>() }));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: Effect, deps?: readonly unknown[]) => {
    const mount = state.mount;
    if (!mount) { state.effects.push(effect); return; }
    const index = mount.cursor.effect++;
    const slot = mount.effects[index];
    if (slot && deps && slot.deps?.length === deps.length && deps.every((dep, i) => Object.is(dep, slot.deps![i]))) return;
    mount.pending.push(() => { slot?.cleanup?.(); mount.effects[index] = { deps, cleanup: effect() || undefined }; });
  },
  useRef: <T>(current: T) => {
    const mount = state.mount;
    if (!mount) return { current };
    const index = mount.cursor.ref++;
    return (mount.refs[index] ??= { current }) as { current: T };
  },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global' }));
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => ({
  read: async (name: string) => state.files.get(name) ?? null,
  write: async (name: string, text: string) => {
    if (state.fail) throw new Error('disk full');
    state.files.set(name, text);
  },
  remove: async (name: string) => { state.files.delete(name); },
  files: async () => [...state.files.keys()],
}) }));
vi.mock('@/session/messageCacheStorage', () => ({ messageCacheStorage: {
  getItem: async (key: string) => state.raw.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    if (state.fail) throw new Error('disk full');
    state.rawWrites += 1;
    state.raw.set(key, value);
  },
} }));

const row = (id: string, seconds: number): RemoteMessage => ({
  id, clientId: id, sessionId: 's', role: 'user', content: `message ${id}`, rowid: seconds,
  createdAt: new Date(Date.UTC(2026, 9, 9, 0, 0, seconds)).toISOString(), toolUseId: null, agentMeta: null,
});
const releases: (() => void)[] = [];
async function opened(rows: RemoteMessage[], error?: string) {
  const source = {
    readHistoryView: vi.fn(async (): Promise<HistoryViewPage<RemoteMessage>> => {
      if (error) throw new Error(error);
      return { version: 1, items: projectHistoryView(rows, false), hasMore: true, nextCursor: 'older' };
    }),
    readWorkDetails: async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null }),
    setHistoryExpanded: async () => {},
  };
  const entry = getRemoteHistoryView('d', 's', source);
  releases.push(mountRemoteHistoryView(entry, source, true));
  await entry.view.refresh();
  return { entry, source };
}
const save = (current = () => true) => cacheOutboxHistory('d', 's', 'sent', current);
// Run the production hook's effect lifecycle without loading a native renderer.
function flushUnmount(rendered: RemoteMessage[]) {
  const latest = state.rows;
  state.rows = rendered;
  useSessionMessages('s', 'd');
  const cleanups = state.effects.splice(0).map(effect => effect());
  state.rows = latest;
  for (const cleanup of cleanups) cleanup?.();
}
// One mounted instance of the production hook: render with the given rows, commit its effects.
function mountSessionMessages() {
  const mount: Mount = { refs: [], effects: [], pending: [], cursor: { ref: 0, effect: 0 } };
  return {
    render(rows: RemoteMessage[]) {
      state.rows = rows;
      state.mount = mount;
      mount.cursor = { ref: 0, effect: 0 };
      try { useSessionMessages('s', 'd'); } finally { state.mount = null; }
      mount.pending.splice(0).forEach(commit => commit());
    },
    unmount() { mount.effects.forEach(slot => slot?.cleanup?.()); },
  };
}
beforeEach(() => {
  state.rows = [row('sent', 2)]; state.fail = false; state.mount = null; state.rawWrites = 0; setMobileAuthOwner('a');
  vi.spyOn(remoteSessionStore, 'getMessages').mockImplementation(() => state.rows);
  vi.spyOn(remoteSessionStore, 'getSessionRetention').mockReturnValue('regular');
});
afterEach(async () => {
  state.fail = false;
  releases.splice(0).forEach(release => release());
  clearRemoteHistoryViews(); await clearHistoryDisk(); state.raw.clear(); setMobileAuthOwner(null);
  vi.restoreAllMocks();
});

describe('outbox to offline history handoff', () => {
  // Regression: reopened old tasks retain host-owned bubbles even though history
  // already cached their user rows. Existing cases always populated the raw store.
  // Unit: a cached user row, empty raw window, and no network response must suffice.
  it('hands off a cached user row without fetching it back into the raw window', async () => {
    const { source } = await opened([row('sent', 2)]);
    expect(await save()).toBe(true);
    releases.splice(0).forEach(release => release());
    clearRemoteHistoryViews();
    state.rows = [];
    const entry = getRemoteHistoryView('d', 's', source);
    entry.view.setNetworkAvailable(false);
    releases.push(mountRemoteHistoryView(entry, source, true));
    await entry.view.restoreCachedView(() => readHistoryDisk(historyDiskAuthority('d', 's')));
    expect(entry.view.getSnapshot().stale).toBe(true);
    expect(await save()).toBe(true);
    expect(source.readHistoryView).toHaveBeenCalledTimes(1);
    expect(JSON.stringify((await readHistoryDisk(historyDiskAuthority('d', 's')))?.items))
      .toContain('message sent');
  });
  it('does not use another role with the same client id as proof of a sent user row', async () => {
    await opened([{ ...row('sent', 2), role: 'assistant' }]);
    state.rows = [];
    expect(await save()).toBe(false);
  });
  it('retains display ownership when the page is absent or its snapshot predates the send', async () => {
    expect(await save()).toBe(false);
    await opened([row('previous', 1)]);
    expect(await save()).toBe(false);
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).toBeNull();
  });
  it('flushes the confirmed user before the debounce and restores it offline exactly once', async () => {
    await opened([row('previous', 1), row('sent', 2)]);
    expect(await save()).toBe(true);
    const cached = await readHistoryDisk(historyDiskAuthority('d', 's'));
    expect(cached).not.toBeNull();
    const network = vi.fn(async () => { throw new Error('offline'); });
    const cold = new HistoryViewController<RemoteMessage>({ page: network, details: network, expanded: async () => {} });
    cold.setNetworkAvailable(false);
    await cold.restoreCachedView(async () => cached);
    expect(JSON.stringify(cold.getSnapshot().items).match(/message sent/g)).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });
  it('keeps the outbox on storage failure, and succeeds on the existing next attempt', async () => {
    await opened([row('sent', 2)]);
    state.fail = true;
    expect(await save()).toBe(false);
    state.fail = false;
    expect(await save()).toBe(true);
  });
  it('does not leave a sent bubble forever after it ages out of the cached window', async () => {
    await opened([row('newer', 3)]);
    expect(await save()).toBe(true);
  });
  it('keeps a new send when older history was imported with larger rowids', async () => {
    await opened([{ ...row('imported', 1), rowid: 100 }]);
    expect(await save()).toBe(false);
  });
  it('uses persisted host chronology even when insertion order differs', async () => {
    state.rows = [{ ...row('sent', 0), rowid: 100 }];
    await opened([row('newer', 1)]);
    expect(await save()).toBe(true);
  });
  it.each([1, 2, 3])('uses rowid only to break equal host timestamps (rowid=%s)', async (rowid) => {
    await opened([{ ...row('boundary', 2), rowid }]);
    expect(await save()).toBe(rowid > 2);
  });
  it.each(['sent', 'boundary'])('retains ownership when %s lacks a persisted rowid', async (missing) => {
    state.rows = [{ ...row('sent', 0), rowid: missing === 'sent' ? undefined : 2 }];
    await opened([{ ...row('previous', 1), rowid: missing === 'boundary' ? undefined : 1 }]);
    expect(await save()).toBe(false);
  });
  it('does not infer handoff from invalid host timestamps', async () => {
    state.rows = [{ ...row('sent', 0), createdAt: 'invalid' }];
    await opened([row('previous', 1)]);
    expect(await save()).toBe(false);
  });
  it('finds the message boundary after leading folded work and restores that window offline', async () => {
    const { entry } = await opened([
      { ...row('work', 3), role: 'thinking', content: 'working' },
      { ...row('answer', 4), role: 'assistant', agentMeta: { turnCompleted: true } },
    ]);
    expect(entry.view.getSnapshot().items[0].type).toBe('work');
    expect(await save()).toBe(true);
    const cached = await readHistoryDisk(historyDiskAuthority('d', 's'));
    expect(cached?.items[0].type).toBe('work');
    const network = vi.fn(async () => { throw new Error('offline'); });
    const cold = new HistoryViewController<RemoteMessage>({ page: network, details: network, expanded: async () => {} });
    cold.setNetworkAvailable(false);
    await cold.restoreCachedView(async () => cached);
    expect(cold.getSnapshot().items).toEqual(cached?.items);
    expect(network).not.toHaveBeenCalled();
  });
  it.each(['UNSUPPORTED_CAPABILITY', 'CHANNEL_NOT_ALLOWED'])('persists the raw fallback for %s hosts', async (error) => {
    await opened([], error);
    state.fail = true;
    expect(await save()).toBe(false);
    state.fail = false;
    expect(await save()).toBe(true);
    expect(await getCachedSessionMessages('d', 's')).toEqual(state.rows);
  });
  it('rejects a pre-handoff debounce write queued after raw fallback was saved', async () => {
    await opened([], 'UNSUPPORTED_CAPABILITY');
    const staleAuthority = captureSessionMessageCacheWriteAuthority('d', 's');
    expect(await save()).toBe(true);
    expect(await cacheSessionMessagesIfCurrent(staleAuthority, [row('previous', 1)])).toBe(false);
    expect(await getCachedSessionMessages('d', 's')).toEqual(state.rows);
  });
  it.each(['before', 'after'])('unmount %s handoff reads store ingress newer than the last render', async (order) => {
    await opened([], 'UNSUPPORTED_CAPABILITY');
    const rendered = [row('previous', 1)];
    state.rows = [...rendered, row('sent', 2)];
    if (order === 'before') flushUnmount(rendered);
    expect(await save()).toBe(true);
    if (order === 'after') flushUnmount(rendered);
    expect(await getCachedSessionMessages('d', 's')).toEqual(state.rows);
  });
  it('unmount after raw store eviction preserves the confirmed disk window', async () => {
    await opened([], 'UNSUPPORTED_CAPABILITY');
    expect(await save()).toBe(true);
    const saved = state.rows;
    state.rows = [];
    flushUnmount([row('previous', 1)]);
    expect(await getCachedSessionMessages('d', 's')).toEqual(saved);
  });
  it('does not release on logout or a stale sender', async () => {
    await opened([row('sent', 2)]);
    expect(await save(() => false)).toBe(false);
    setMobileAuthOwner(null);
    expect(await save()).toBe(false);
  });
  it('does not release a row removed by clear or rewind', async () => {
    const { entry, source } = await opened([row('sent', 2)]);
    state.rows = [];
    // reset refreshes an active view: the host must reflect the deletion too,
    // rather than reintroducing the row as new authoritative history.
    source.readHistoryView.mockResolvedValue({ version: 1, items: [], hasMore: false, nextCursor: null });
    entry.view.reset();
    await clearHistoryDisk('d', 's');
    expect(await save()).toBe(false);
  });
  // Perf regression (mobile streaming jank): the debounced raw-cache write used to fire at every
  // 600 ms pause of a streaming reply, serializing the whole window on the JS thread mid-turn.
  // Production entry: useSessionMessages' persist effect. Minimal failing input: one assistant row
  // with agentMeta.isStreaming=true. The write must wait for the final (settled) snapshot.
  it('defers the debounced raw write while a reply is still streaming, then writes once settled', async () => {
    vi.useFakeTimers();
    const hook = mountSessionMessages();
    try {
      const streaming: RemoteMessage = { ...row('reply', 3), role: 'assistant', agentMeta: { isStreaming: true } };
      hook.render([row('sent', 2), streaming]);
      hook.render([row('sent', 2), { ...streaming, content: 'message reply, more' }]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.rawWrites).toBe(0);
      // The final flush of the same mount settles the deferred snapshot through the debounce.
      hook.render([row('sent', 2), { ...streaming, agentMeta: { turnCompleted: true } }]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.rawWrites).toBe(1);
      expect([...state.raw.values()].join('')).toContain('message reply');
      // Nothing is left unsaved, so leaving the task does not write the same snapshot again.
      hook.unmount();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(state.rawWrites).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  // Leaving the task mid-stream has no pending debounce timer any more; the deferred snapshot
  // must still be flushed by the unmount path, otherwise the rows that arrived during the turn
  // (including the user's own send) are missing from the offline cache until the next visit.
  it('flushes the deferred snapshot on unmount while the reply is still streaming', async () => {
    const streaming: RemoteMessage = { ...row('reply', 3), role: 'assistant', agentMeta: { isStreaming: true } };
    state.rows = [row('sent', 2), streaming];
    flushUnmount(state.rows);
    await vi.waitFor(async () => {
      expect((await getCachedSessionMessages('d', 's')).map(message => message.id)).toEqual(['sent', 'reply']);
    });
  });
});
