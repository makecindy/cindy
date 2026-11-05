// @vitest-environment jsdom
// Test value (4.3, unit): real tab-owner endpoint and native close store. Existing
// webview tests cannot exercise an unmounted tab, close rollback or source-side
// async creation after a window handoff. Inputs are one open and one close/move.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { initPluginTabViewHost, mountPluginTabView } from '../pluginTabViews';
import { _resetStore, closeTab, getBucket } from '../store';
import { __resetGlobalTabsForTest, removeGlobalTab } from '../globalTabs';
import { openPluginTabView } from '../lib/openPluginTabView';
import type { PluginTabViewMountRequest } from '../../../../shared/pluginUi';

vi.mock('../lib/detachedSidebarRouting', () => ({ routeSidebarCommand: vi.fn(async () => 'attached') }));
let request: (raw: unknown) => void;
let generation = 0;
let mountNumber = 0;
const opened = vi.fn<(requestId: string, tabId: string | null) => Promise<void>>().mockResolvedValue(), release = vi.fn(async () => {});
const upsert = vi.fn<(raw: unknown) => Promise<void>>().mockResolvedValue(), close = vi.fn(async () => {});
const mount = vi.fn(async (raw: PluginTabViewMountRequest) => ({ token: `mount-${++mountNumber}`, sequence: raw.sequence,
  snapshot: { id: raw.id, scope: raw.sessionId ? { kind: 'session', sessionId: raw.sessionId } : { kind: 'global' },
    params: raw.params, generation: `mount-${mountNumber}`, visible: raw.visible } }));
beforeEach(() => {
  _resetStore(); __resetGlobalTabsForTest(); localStorage.clear(); vi.clearAllMocks();
  close.mockResolvedValue(); upsert.mockResolvedValue();
  setDataOwnerGeneration('tab-owner', ++generation);
  window.electronAPI = { platform: 'darwin', localDb: { rightSidebarTabs: {
    list: async () => ({ tabs: [], activeTabId: null }), upsert, close, setActive: async () => {},
  } }, ghosts: { ui: { tabViews: { ready: async () => {}, onRequest: (listener: typeof request) => { request = listener; return () => {}; },
    opened, mount, update: async () => {}, release } } } } as unknown as Window['electronAPI'];
  initPluginTabViewHost();
});
const send = (sessionId: string | null, sequence = 1, id = 'log') => request({ requestId: `request-${sequence}`, instanceId: 'plugin', id,
  sessionId, params: { item: `item-${sequence}` }, sequence, ownerStamp: { dataOwnerId: 'tab-owner', ownerGeneration: generation } });
const body = (tabId: string, sessionId: string | null) => mountPluginTabView({ tabId, instanceId: 'plugin', id: 'log', sessionId, visible: true });

describe('plugin tab owner', () => {
  // PR #8909: different named views can finish creating out of intent order.
  it.each(['request', 'native'] as const)('keeps the newer named view active when an older creation finishes last (%s)', async source => {
    let finish!: () => void;
    upsert.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
    send('task', 10, 'log');
    await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
    let latest: string | null;
    if (source === 'request') {
      send('task', 11, 'preview');
      await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('request-11', expect.any(String)));
      latest = opened.mock.calls.find(([id]) => id === 'request-11')![1];
    } else latest = await openPluginTabView('plugin', 'preview', 'task');
    expect(getBucket('task').activeTabId).toBe(latest);
    finish();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith('request-10', expect.any(String)));
    expect(getBucket('task').activeTabId).toBe(latest);
    expect(getBucket('task').tabs).toHaveLength(2);
  });
  it('keeps position across parking and clears it only after a successful task close', async () => {
    send('task'); await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    const tabId = opened.mock.calls[0][1] as string;
    const page = await body(tabId, 'task'); page.dispose();
    expect(release).toHaveBeenLastCalledWith(page.token, true);
    close.mockRejectedValueOnce(new Error('DB_UNAVAILABLE'));
    await expect(closeTab('task', tabId)).rejects.toThrow('DB_UNAVAILABLE');
    const restored = await body(tabId, 'task');
    expect(mount).toHaveBeenLastCalledWith(expect.objectContaining({ params: { item: 'item-1' } }));
    restored.dispose(); await closeTab('task', tabId);
    expect(release).toHaveBeenLastCalledWith(restored.token, false);
    await body(await openPluginTabView('plugin', 'log', 'task'), 'task');
    expect(mount).toHaveBeenLastCalledWith(expect.objectContaining({ params: {}, sequence: 0 }));
  });
  it.each(['task', null])('clears positioning when closing a tab which never mounted (%s)', async sessionId => {
    send(sessionId); await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    const tabId = opened.mock.calls[0][1] as string;
    if (sessionId) await closeTab(sessionId, tabId); else removeGlobalTab(tabId);
    await body(await openPluginTabView('plugin', 'log', sessionId), sessionId);
    expect(mount).toHaveBeenLastCalledWith(expect.objectContaining({ params: {}, sequence: 0 }));
  });
  it('does not recreate a released source position when tab creation finishes later', async () => {
    let finish!: () => void;
    upsert.mockImplementationOnce(async () => new Promise<void>(resolve => { finish = resolve; }));
    send('task', 7); await vi.waitFor(() => expect(upsert).toHaveBeenCalled());
    const tabId = (upsert.mock.calls[0][0] as { id: string }).id;
    request({ releaseTabId: tabId, sequence: 7, ownerStamp: { dataOwnerId: 'tab-owner', ownerGeneration: generation } });
    finish(); await vi.waitFor(() => expect(opened).toHaveBeenCalled());
    await body(tabId, 'task');
    expect(mount).toHaveBeenLastCalledWith(expect.objectContaining({ params: {}, sequence: 0 }));
  });
});
