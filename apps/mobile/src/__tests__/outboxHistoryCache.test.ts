import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { HistoryViewController, projectHistoryView, type HistoryViewPage } from '@cindy/maker-shared/message-window';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { cacheOutboxHistory } from '@/session/outboxHistoryCache';
import { clearHistoryDisk, historyDiskAuthority, readHistoryDisk } from '@/session/remoteHistoryDiskCache';
import { cacheSessionMessagesIfCurrent, captureSessionMessageCacheWriteAuthority, getCachedSessionMessages } from '@/session/mobileSessionMessageCache';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { clearRemoteHistoryViews, getRemoteHistoryView, mountRemoteHistoryView } from '@/session/remoteHistoryViews';
import type { RemoteMessage } from '@/session/types';

const state = vi.hoisted(() => ({ rows: [] as RemoteMessage[], fail: false,
  files: new Map<string, string>(), raw: new Map<string, string>() }));
vi.mock('@/session/remoteSessionStore', () => ({ remoteSessionStore: {
  getMessages: () => state.rows, getSessionRetention: () => 'regular',
} }));
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
// Execute the actual unmount effect without mounting the native message screen.
const source = ts.createSourceFile('remoteSessionStore.ts', readFileSync(
  new URL('../session/remoteSessionStore.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const hook = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useSessionMessageCacheSync')!;
let cleanupSource = '';
function findCleanup(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect') {
    const callback = node.arguments[0];
    if (ts.isArrowFunction(callback) && ts.isArrowFunction(callback.body)) cleanupSource = callback.body.getText(source);
  }
  ts.forEachChild(node, findCleanup);
}
findCleanup(hook);
function flushUnmount(rendered: RemoteMessage[]) {
  const bindings = { persistTimerRef: { current: setTimeout(() => {}, 60_000) },
    ctxRef: { current: { deviceId: 'd', sessionId: 's', messages: rendered } },
    remoteSessionStore, captureSessionMessageCacheWriteAuthority, cacheSessionMessagesIfCurrent, clearTimeout };
  const js = ts.transpileModule(`const { ${Object.keys(bindings).join(',')} } = bindings; (${cleanupSource})();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('bindings', js)(bindings);
}
beforeEach(() => { state.rows = [row('sent', 2)]; state.fail = false; setMobileAuthOwner('a'); });
afterEach(async () => {
  state.fail = false;
  releases.splice(0).forEach(release => release());
  clearRemoteHistoryViews(); await clearHistoryDisk(); state.raw.clear(); setMobileAuthOwner(null);
});

describe('outbox to offline history handoff', () => {
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
    const { entry } = await opened([row('sent', 2)]);
    state.rows = [];
    entry.view.reset();
    await clearHistoryDisk('d', 's');
    expect(await save()).toBe(false);
  });
});
