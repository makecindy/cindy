import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoryViewController, projectHistoryView, type HistoryViewSnapshot, type HistoryWorkSummary } from '@cindy/maker-shared/message-window';
import { setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { clearHistoryDisk, historyDiskAuthority, readHistoryDisk, writeHistoryDisk } from '@/session/remoteHistoryDiskCache';
import type { RemoteMessage } from '@/session/types';
import { clearRemoteHistoryViews, findRemoteHistoryView, getRemoteHistoryView,
  mountRemoteHistoryView, MAX_INACTIVE_HISTORY_VIEWS } from '@/session/remoteHistoryViews';

const files = vi.hoisted(() => new Map<string, string>());
vi.mock('@/session/historyDiskStoreExpo', () => ({ createHistoryDiskIO: () => ({
  read: async (name: string) => files.get(name) ?? null,
  write: async (name: string, value: string) => { files.set(name, value); },
  remove: async (name: string) => { files.delete(name); },
  files: async () => [...files.keys()],
}) }));
vi.mock('@/config/env', () => ({ getActiveMobileSessionRealm: () => 'global' }));
const snapshot = (text: string): HistoryViewSnapshot<RemoteMessage> => ({
  items: projectHistoryView([{ id: 'a', clientId: 'a', role: 'assistant', content: text,
    createdAt: '2026-09-08T00:00:00Z', sessionId: 's', toolUseId: null, agentMeta: null }], false),
  details: new Map(), expanded: new Set(), hasMore: true, nextCursor: 'older', ready: true,
  loading: false, error: null,
});
const releases: Array<() => void> = [];
function mount(entry: ReturnType<typeof getRemoteHistoryView>, source: ReturnType<typeof transport>) {
  const release = mountRemoteHistoryView(entry, source, true);
  releases.push(release);
  return () => { releases.splice(releases.indexOf(release), 1); release(); };
}
function transport() {
  return {
    readHistoryView: vi.fn(async () => ({ version: 1 as const, items: [...snapshot('network').items], hasMore: false, nextCursor: null })),
    readWorkDetails: vi.fn(async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null })),
    setHistoryExpanded: vi.fn(async () => {}),
  };
}
afterEach(async () => { releases.splice(0).forEach(release => release()); clearRemoteHistoryViews(); await clearHistoryDisk(); setMobileAuthOwner(null); });
describe('persistent history integration', () => {
  it.each(['UNSUPPORTED_CAPABILITY', 'CHANNEL_NOT_ALLOWED'])('removes %s disk projection before LRU recreation and fences old writes', async (code) => {
    setMobileAuthOwner('a');
    const old = historyDiskAuthority('d', 's');
    const other = historyDiskAuthority('other', 's');
    await writeHistoryDisk(old, snapshot('stale disk'));
    await writeHistoryDisk(other, snapshot('other device'));
    const source = transport();
    const entry = getRemoteHistoryView('d', 's', source);
    const release = mount(entry, source);
    await entry.view.refresh();
    source.readHistoryView.mockRejectedValue(new Error(`[${code}] unavailable`));
    await entry.view.refresh();
    expect(entry.view.getSnapshot().ready).toBe(false);
    expect(old.current()).toBe(false);
    release();
    await writeHistoryDisk(old, snapshot('late old write'));
    for (let n = 0; n < MAX_INACTIVE_HISTORY_VIEWS; n++) {
      const nextSource = transport();
      const next = getRemoteHistoryView('d', `other-${n}`, nextSource);
      const leave = mount(next, nextSource);
      await next.view.refresh(); leave();
    }
    expect(findRemoteHistoryView('d', 's')).toBeUndefined();
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).toBeNull();
    expect(await readHistoryDisk(other)).not.toBeNull();
    source.readHistoryView.mockRejectedValue(new Error('offline'));
    const reopened = getRemoteHistoryView('d', 's', source);
    const leave = mount(reopened, source);
    await reopened.view.refresh();
    await vi.waitFor(() => expect(reopened.view.getSnapshot().loading).toBe(false));
    expect(reopened.view).not.toBe(entry.view);
    expect(reopened.view.getSnapshot()).toMatchObject({ ready: false, items: [] });
    source.readHistoryView.mockResolvedValue({ version: 1, items: [...snapshot('fresh').items], hasMore: false, nextCursor: null });
    reopened.view.reset();
    await reopened.view.refresh();
    leave();
    expect(JSON.stringify(await readHistoryDisk(historyDiskAuthority('d', 's')))).toContain('fresh');
  });
  it.each(['UNSUPPORTED_CAPABILITY', 'CHANNEL_NOT_ALLOWED'])('clears an existing %s before activation retries, preserving transient-error caches', async (code) => {
    setMobileAuthOwner('a');
    const source = transport();
    source.readHistoryView.mockRejectedValue(new Error(`[${code}] unavailable`));
    const entry = getRemoteHistoryView('d', 's', source);
    await entry.view.refresh();
    await writeHistoryDisk(historyDiskAuthority('d', 's'), snapshot('stale'));
    source.readHistoryView.mockRejectedValue(new Error('now offline'));
    mount(entry, source);
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).toBeNull();
    const transient = transport();
    transient.readHistoryView.mockRejectedValue(new Error('timeout'));
    const auth = historyDiskAuthority('other', 's');
    await writeHistoryDisk(auth, snapshot('offline cache'));
    const offline = getRemoteHistoryView('other', 's', transient);
    mount(offline, transient); await offline.view.refresh();
    expect(await readHistoryDisk(auth)).not.toBeNull();
  });
  it('does not let an old owner downgrade delete the new owner cache', async () => {
    setMobileAuthOwner('old');
    const source = transport();
    const entry = getRemoteHistoryView('d', 's', source);
    mount(entry, source); await entry.view.refresh();
    setMobileAuthOwner('new');
    const auth = historyDiskAuthority('d', 's');
    await writeHistoryDisk(auth, snapshot('new owner'));
    source.readHistoryView.mockRejectedValue(new Error('[UNSUPPORTED_CAPABILITY] unavailable'));
    await entry.view.refresh();
    expect(auth.current()).toBe(true);
    expect(JSON.stringify(await readHistoryDisk(auth))).toContain('new owner');
  });
  it('skips oversized snapshots before serializing complete details', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    const value = snapshot('small');
    const toJSON = vi.fn(() => { throw new Error('must not serialize'); });
    value.details = new Map([['huge', { messages: [{ content: 'x'.repeat(2 * 1024 * 1024), toJSON }],
      complete: true, loading: false, error: null, revision: 'r', lastMessageId: 'a' }]]) as unknown as typeof value.details;
    await writeHistoryDisk(auth, value);
    expect(toJSON).not.toHaveBeenCalled();
    expect(await readHistoryDisk(auth)).toBeNull();
  });
  it('restores items, pagination and expansion while separating account ownership', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    await writeHistoryDisk(auth, snapshot('cached'));
    expect(await readHistoryDisk(auth)).toMatchObject({ ready: true, nextCursor: 'older', hasMore: true });
    setMobileAuthOwner('b');
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).toBeNull();
    expect(await readHistoryDisk(auth)).toBeNull();
    setMobileAuthOwner('a');
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).not.toBeNull();
  });
  it('invalidates old writes on deletion without disabling another task cache', async () => {
    setMobileAuthOwner('a');
    const old = historyDiskAuthority('d', 's');
    const other = historyDiskAuthority('d', 'other');
    await writeHistoryDisk(old, snapshot('old'));
    await clearHistoryDisk('d', 's');
    await writeHistoryDisk(old, snapshot('late'));
    await writeHistoryDisk(other, snapshot('other'));
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).toBeNull();
    expect(await readHistoryDisk(other)).not.toBeNull();
    await writeHistoryDisk(historyDiskAuthority('d', 's'), snapshot('fresh after rewind'));
    expect(await readHistoryDisk(historyDiskAuthority('d', 's'))).not.toBeNull();
  });
  it('does not cache an unfinished network page or restore a live streaming flag', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    await writeHistoryDisk(auth, { ...snapshot('in flight'), loading: true });
    expect(await readHistoryDisk(auth)).toBeNull();
    const value = snapshot('saved');
    if (value.items[0].type === 'messages') value.items[0].messages[0].agentMeta = { isStreaming: true };
    await writeHistoryDisk(auth, value);
    expect(JSON.stringify(await readHistoryDisk(auth))).not.toContain('"isStreaming":true');
  });
  it('clears only view streaming metadata while preserving nested message and card content', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    const value = snapshot('saved');
    const row: RemoteMessage = { id: 'a', clientId: 'a', sessionId: 's', role: 'tool_use', toolUseId: 'tool',
      createdAt: '2026-09-08T00:00:00Z', agentMeta: { isStreaming: true, streaming: true, custom: { isStreaming: 'business', streaming: true } },
      content: { isStreaming: true, input: { isStreaming: 'literal', nested: [{ isStreaming: true }] } },
      systemCardData: { isStreaming: true },
    };
    const summary: HistoryWorkSummary = { key: 'w', firstMessageId: 'a', lastMessageId: 'a', revision: 'r',
      startedAtMs: 1, endedAtMs: 2, messageCount: 1, toolCount: 1, isStreaming: true };
    value.items = [{ type: 'work', key: 'outer', summary: { ...summary, preview: summary }, children: [
      { type: 'messages', key: 'narration', messages: [row] },
      { type: 'work', key: 'inner', summary, children: [{ type: 'messages', key: 'nested', messages: [row] }] },
    ] }];
    value.details = new Map([['w', { messages: [row], revision: 'r', lastMessageId: 'a',
      complete: true, loading: false, error: null }]]);
    const original = JSON.stringify(value.items);
    await writeHistoryDisk(auth, value);
    const restored = (await readHistoryDisk(auth))!;
    const cachedRow = { ...row, agentMeta: { ...row.agentMeta, isStreaming: false, streaming: false } };
    expect(restored.items).toEqual([{ type: 'work', key: 'outer',
      summary: { ...summary, isStreaming: false, preview: { ...summary, isStreaming: false } }, children: [
        { type: 'messages', key: 'narration', messages: [cachedRow] },
        { type: 'work', key: 'inner', summary: { ...summary, isStreaming: false }, children: [
          { type: 'messages', key: 'nested', messages: [cachedRow] },
        ] },
      ] }]);
    expect(restored.details.get('w')!.messages).toEqual([cachedRow]);
    expect(JSON.stringify(value.items)).toBe(original);
    expect(row.agentMeta!.isStreaming).toBe(true);
  });
  function controller() {
    return new HistoryViewController<RemoteMessage>({
      page: async () => ({ version: 1, items: [...snapshot('network').items], hasMore: false, nextCursor: null }),
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => {},
    });
  }
  it('rejects structurally corrupt work summaries instead of rendering them', async () => {
    setMobileAuthOwner('a');
    const auth = historyDiskAuthority('d', 's');
    await writeHistoryDisk(auth, snapshot('good'));
    const body = [...files.keys()].find(name => name.startsWith('view-'))!;
    const value = JSON.parse(files.get(body)!);
    value.items = [{ type: 'work', key: 'w', summary: { key: 'w' } }];
    files.set(body, JSON.stringify(value));
    expect(await readHistoryDisk(auth)).toBeNull();
  });
  it('shows disk before network and then accepts the authoritative page', async () => {
    const view = controller();
    await view.restoreCachedView(async () => snapshot('disk'));
    expect(JSON.stringify(view.getSnapshot())).toContain('disk');
    await view.refresh();
    expect(JSON.stringify(view.getSnapshot())).toContain('network');
  });
  it.each(['UNSUPPORTED_CAPABILITY', 'CHANNEL_NOT_ALLOWED'])('does not restore disk after %s fallback', async (code) => {
    const view = new HistoryViewController<RemoteMessage>({
      page: async () => { throw new Error(`[${code}] unavailable`); },
      details: async () => ({ version: 1, messages: [], hasMore: false, nextCursor: null }),
      expanded: async () => {},
    });
    let resolve!: (value: HistoryViewSnapshot<RemoteMessage>) => void;
    const reading = view.restoreCachedView(() => new Promise(done => { resolve = done; }));
    await view.refresh();
    resolve(snapshot('stale disk')); await reading;
    const read = vi.fn(async () => snapshot('stale disk'));
    await view.restoreCachedView(read);
    expect(read).not.toHaveBeenCalled();
    expect(view.getSnapshot().ready).toBe(false);
    expect(view.getSnapshot().items).toEqual([]);
  });
  it.each(['fresh', 'reset', 'deactivate'])('ignores late disk after %s', async (action) => {
    const view = controller();
    let resolve!: (value: HistoryViewSnapshot<RemoteMessage>) => void;
    const reading = view.restoreCachedView(() => new Promise(done => { resolve = done; }));
    if (action === 'fresh') await view.refresh();
    else if (action === 'reset') view.reset();
    else view.setActive(false);
    resolve(snapshot('stale disk')); await reading;
    expect(JSON.stringify(view.getSnapshot())).not.toContain('stale disk');
  });
});
