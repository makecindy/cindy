import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { projectHistoryView, type HistoryViewPage } from '@cindy/maker-shared/message-window';
import { clearRemoteHistoryViews, findRemoteHistoryView, getRemoteHistoryView,
  mountRemoteHistoryView, MAX_INACTIVE_HISTORY_VIEWS } from '../session/remoteHistoryViews';
import { remoteSessionStore } from '../session/remoteSessionStore';
import { buildMobileHistoryRenderItems } from '../session/mobileHistoryRender';
import type { RemoteMessage, RemoteSession } from '../session/types';

const page = (content = 'unchanged answer'): HistoryViewPage<RemoteMessage> => ({ version: 1,
  items: projectHistoryView([{ id: 'a', clientId: 'a', sessionId: 's', role: 'assistant',
    content, toolUseId: null, agentMeta: null, createdAt: '2026-09-08T00:00:00Z' }], false),
  hasMore: false, nextCursor: null });
const reader = () => ({ readHistoryView: vi.fn(async () => page()),
  readWorkDetails: vi.fn(async () => ({ version: 1 as const, messages: [], hasMore: false, nextCursor: null })),
  setHistoryExpanded: vi.fn(async () => undefined) });
const releases: Array<() => void> = [];
function mount(entry: ReturnType<typeof getRemoteHistoryView>, source = reader()) {
  const release = mountRemoteHistoryView(entry, source, true);
  releases.push(release);
  return () => { releases.splice(releases.indexOf(release), 1); release(); };
}
afterEach(() => { releases.splice(0).forEach(release => release()); clearRemoteHistoryViews(); });

describe('history reentry', () => {
  it.each(['invoke', 'push', 'initial-invoke', 'initial-push'])('retires deleted history through %s without another notification', async (operation) => {
    const source = reader();
    let settle!: (value: HistoryViewPage<RemoteMessage>) => void;
    const delayed = new Promise<HistoryViewPage<RemoteMessage>>(resolve => { settle = resolve; });
    source.readHistoryView.mockImplementationOnce(() => delayed);
    const entry = getRemoteHistoryView('delete-device', 'delete-session', source);
    mount(entry, source);
    const pending = entry.view.refresh();
    if (!operation.startsWith('initial')) { settle(page('deleted')); await pending; }
    const other = getRemoteHistoryView('other-device', 'delete-session', reader());
    mount(other); await other.view.refresh();
    source.readHistoryView.mockResolvedValue({ ...page(), items: [] });
    if (operation.endsWith('push')) {
      remoteSessionStore.applyRemotePush('delete-device', 'local-db:messages:deleted', {
        sessionId: 'delete-session', clientIds: ['a'],
      });
    } else remoteSessionStore.removeMessages('delete-session', ['a'], 'delete-device');
    expect(entry.view.getSnapshot()).toMatchObject({ ready: false, items: [] });
    expect(other.view.getSnapshot().ready).toBe(true);
    settle(page('deleted')); await pending;
    expect(entry.view.getSnapshot().items).toEqual([]);
    expect(entry.view.isActive()).toBe(true);
    await entry.view.refresh();
    expect(entry.view.getSnapshot()).toMatchObject({ ready: true, items: [] });
  });

  it('does not register abandoned renders', () => {
    getRemoteHistoryView('d', 's', reader());
    expect(findRemoteHistoryView('d', 's')).toBeUndefined();
  });
  it('reuses ready content on reopen and preserves identities through unchanged background validation', async () => {
    const first = reader();
    const entry = getRemoteHistoryView('d', 's', first);
    const release = mount(entry, first);
    await entry.view.refresh();
    const items = entry.view.getSnapshot().items;
    release();
    const next = reader();
    let resolve!: (value: HistoryViewPage<RemoteMessage>) => void;
    next.readHistoryView.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const reopened = getRemoteHistoryView('d', 's', next);
    expect(reopened.view).toBe(entry.view);
    mount(reopened, next);
    expect(reopened.view.getSnapshot()).toMatchObject({ ready: true, loading: true });
    expect(reopened.view.getSnapshot().items).toBe(items);
    resolve(page());
    await reopened.view.refresh();
    expect(reopened.view.getSnapshot().items).toBe(items);
    expect(first.readHistoryView).toHaveBeenCalledTimes(1);
    expect(next.readHistoryView).toHaveBeenCalledTimes(1);
  });

  it('does not let a pre-blur response overwrite cached content or the reactivated generation', async () => {
    const source = reader();
    const entry = getRemoteHistoryView('d', 's', source);
    const release = mount(entry, source);
    await entry.view.refresh();
    const items = entry.view.getSnapshot().items;
    let resolve!: (value: HistoryViewPage<RemoteMessage>) => void;
    source.readHistoryView.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const stale = entry.view.refresh();
    release();
    mount(entry, source);
    const current = entry.view.refresh();
    resolve(page('stale answer'));
    await Promise.all([stale, current]);
    expect(entry.view.getSnapshot().items).toBe(items);
  });

  it('keeps running-task render keys and content through every reentry refresh notification', async () => {
    const source = reader();
    const entry = getRemoteHistoryView('d', 's', source);
    const release = mount(entry, source);
    await entry.view.refresh();
    const live: RemoteMessage = { id: 'live', clientId: 'live', sessionId: 's', role: 'assistant',
      content: 'still generating', agentMeta: { isStreaming: true }, toolUseId: null,
      createdAt: '2026-09-08T00:00:01Z' };
    const render = () => buildMobileHistoryRenderItems({ view: entry.view,
      snapshot: entry.view.getSnapshot(), messages: [live], streaming: true, sessionId: 's' });
    const before = render();
    const frames: string[] = [];
    const off = entry.view.subscribe(() => frames.push(JSON.stringify(render())));
    release();
    mount(entry, source);
    await entry.view.refresh();
    off();
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) expect(frame).toBe(JSON.stringify(before));
    expect(render().map(item => item.key)).toEqual(before.map(item => item.key));
    expect(JSON.stringify(before)).toContain('unchanged answer');
    expect(JSON.stringify(before)).toContain('still generating');
  });

  it.each(['account', 'device'])('clears retained data at the existing %s boundary, including a late read', async (boundary) => {
    const source = reader();
    const entry = getRemoteHistoryView('d', 's', source);
    const release = mount(entry, source);
    await entry.view.refresh();
    let resolve!: (value: HistoryViewPage<RemoteMessage>) => void;
    source.readHistoryView.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const stale = entry.view.refresh();
    release();
    if (boundary === 'account') remoteSessionStore.clear();
    else remoteSessionStore.removeDevice('d');
    resolve(page('old account'));
    await stale;
    expect(findRemoteHistoryView('d', 's')).toBeUndefined();
    expect(entry.view.getSnapshot()).toMatchObject({ ready: false, items: [] });
  });

  it('keeps a mounted reclaimed view registered for subsequent focus and push invalidation', async () => {
    const source = reader();
    const entry = getRemoteHistoryView('d', 's', source);
    mount(entry, source);
    await entry.view.refresh();
    entry.view.setActive(false);
    clearRemoteHistoryViews('d', 's');
    expect(findRemoteHistoryView('d', 's')).toBe(entry.view);
    expect(entry.view.getSnapshot()).toMatchObject({ ready: false, items: [] });
    entry.view.setActive(true);
    await entry.view.refresh();
    findRemoteHistoryView('d', 's')!.setActive(false);
    findRemoteHistoryView('d', 's')!.reset();
    expect(entry.view.getSnapshot()).toMatchObject({ ready: false, items: [] });
  });

  it('isolates device identities and evicts oldest detached views without removing the mounted view', async () => {
    const active = getRemoteHistoryView('other', 's', reader());
    mount(active);
    for (let i = 0; i <= MAX_INACTIVE_HISTORY_VIEWS; i++) {
      const entry = getRemoteHistoryView('d', String(i), reader());
      const release = mount(entry);
      await entry.view.refresh();
      release();
    }
    expect(findRemoteHistoryView('d', '0')).toBeUndefined();
    expect(findRemoteHistoryView('d', String(MAX_INACTIVE_HISTORY_VIEWS))).toBeDefined();
    expect(findRemoteHistoryView('other', 's')).toBe(active.view);
  });

  it('does not retain an oversized history window after unmount', async () => {
    const source = reader();
    source.readHistoryView.mockResolvedValue(page('x'.repeat(3 * 1024 * 1024)));
    const entry = getRemoteHistoryView('d', 's', source);
    const release = mount(entry, source);
    await entry.view.refresh();
    release();
    expect(findRemoteHistoryView('d', 's')).toBeUndefined();
  });

  it('invalidates cached pre-rewind content even after leaving the screen', async () => {
    const entry = getRemoteHistoryView('d', 's', reader());
    const release = mount(entry);
    await entry.view.refresh();
    release();
    remoteSessionStore.invalidateSessionMessageWindow('s', 'd');
    expect(entry.view.getSnapshot()).toMatchObject({ items: [], ready: false });
    const reopened = getRemoteHistoryView('d', 's', reader());
    expect(reopened.view.getSnapshot().items).toEqual([]);
  });

  it('uses existing schedule reclamation while keeping a mounted background view addressable', async () => {
    remoteSessionStore.upsertDeviceSession('d', 'desktop', {
      id: 's', source: 'scheduler', status: 'active', createdAt: '2026-09-08T00:00:00Z',
      updatedAt: '2026-09-08T00:00:00Z', title: 's',
    } as RemoteSession);
    const entry = getRemoteHistoryView('d', 's', reader());
    mount(entry);
    const authority = remoteSessionStore.enterSessionMessageDetail('s');
    await entry.view.refresh();
    entry.view.setActive(false);
    remoteSessionStore.leaveSessionMessageDetail('s', 'app-background', authority);
    expect(remoteSessionStore.releaseSessionRuntimeState('s', { reason: 'app-background' })).toBe(true);
    expect(entry.view.getSnapshot()).toMatchObject({ items: [], ready: false });
    expect(findRemoteHistoryView('d', 's')).toBe(entry.view);
  });

  it('retains ready content on transient failure but accepts real authoritative changes', async () => {
    const source = reader();
    const entry = getRemoteHistoryView('d', 's', source);
    mount(entry, source);
    await entry.view.refresh();
    const items = entry.view.getSnapshot().items;
    source.readHistoryView.mockRejectedValueOnce(new Error('temporary timeout'));
    await entry.view.refresh();
    expect(entry.view.getSnapshot().ready).toBe(true);
    expect(entry.view.getSnapshot().items).toBe(items);
    source.readHistoryView.mockResolvedValueOnce(page('corrected answer'));
    await entry.view.refresh();
    expect(entry.view.getSnapshot().items).not.toBe(items);
    expect(JSON.stringify(entry.view.getSnapshot().items)).toContain('corrected answer');
  });

  it.each(['deleted', 'archived'] as const)('clears a retained view when the store receives %s directly', async (status) => {
    remoteSessionStore.upsertDeviceSession('d', 'desktop', { id: 's', status: 'active',
      createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z', title: 's' } as RemoteSession);
    const entry = getRemoteHistoryView('d', 's', reader());
    const release = mount(entry);
    await entry.view.refresh();
    release();
    remoteSessionStore.applySessionPatch('d', 's', { status });
    expect(findRemoteHistoryView('d', 's')).toBeUndefined();
    expect(entry.view.getSnapshot()).toMatchObject({ ready: false, items: [] });
  });

  it('ordinary screen focus uses activation rather than destructive reset', () => {
    const source = readFileSync(new URL('../../app/sessions/[sessionId].tsx', import.meta.url), 'utf8');
    const focus = source.slice(source.indexOf('const historyView = useRemoteHistoryView'), source.indexOf('const rawMessages = useSessionMessages'));
    expect(focus).toContain('historyView.view.setActive(true)');
    expect(focus).not.toContain('.reset()');
    expect(source).toContain('options.replaceMessages && historyView.view.getSnapshot().ready');
  });
});
