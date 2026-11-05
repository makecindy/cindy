import { describe, expect, it, vi } from 'vitest';
import { PluginTabViewHost } from '../pluginTabViewHost';
import { PLUGIN_TAB_VIEW_REQUEST } from '../../../shared/pluginUi';

// 4.3 unit: real transport owner, navigation ordering, page ack and release.
// Old contribution page tests cannot cover a persistent named native tab.
function setup() {
  let token = 'owner:install:1';
  let popped: number | null = null;
  let sidebarVisible = false;
  const messages: { controller: number; channel: string; payload: Record<string, unknown> }[] = [];
  const windows = new Map([1, 2, 3].map(id => [id, { id, role: id === 1 ? 'main' : id === 2 ? 'popout' : 'sidebar',
    current: () => true, visible: () => id !== 3 || sidebarVisible,
    send: (channel: string, payload: unknown) => messages.push({ controller: id, channel, payload: payload as Record<string, unknown> }) }]));
  const host = new PluginTabViewHost({
    current: id => id === 'plugin' ? { token, pluginId: 'plugin', ui: { version: 1, tabViews: [
      { id: 'log', title: 'Log', scope: 'session', page: 'views/log.html' },
      { id: 'preview', title: 'Preview', scope: 'global', page: 'preview.html' },
    ] } } : null,
    controller: id => windows.get(id) ?? null,
    authorize: async () => () => true,
    ownerForTab: () => popped,
    timeoutMs: 20,
  });
  const request = (sequence: number) => host.prepare({ controller: 'local:1', instanceId: 'plugin', id: 'log',
    sessionId: 'task', params: { item: `${sequence}` }, sequence, current: () => true });
  const mount = (controller = 1, sequence = 2) => host.mount(controller, { tabId: 'tab', instanceId: 'plugin', id: 'log',
    sessionId: 'task', params: { item: `${sequence}` }, sequence, visible: true });
  return { host, request, mount, messages, revoke: () => { token = 'owner:install:2'; },
    pop: (id: number | null) => { popped = id; }, showSidebar: () => { sidebarVisible = true; } };
}
describe('PluginTabViewHost', () => {
  it('suppresses late intent, dispatches once and distinguishes opened from page received', async () => {
    const h = setup();
    const newer = h.request(2); const older = h.request(1);
    expect(await h.host.navigate('local:1', older.requestId)).toEqual({ tab: 'superseded', page: 'unconfirmed' });
    const pending = h.host.navigate('local:1', newer.requestId);
    await Promise.resolve();
    const request = h.messages.find(m => m.channel === PLUGIN_TAB_VIEW_REQUEST)!.payload;
    const mounted = await h.mount();
    const sent = vi.fn();
    h.host.attach(1, `cindy-ghost://plugin/views/log.html?cindyView=${mounted.token}`, { id: 10, send: sent, current: () => true });
    h.host.opened(1, { requestId: request.requestId, tabId: 'tab' });
    const read = h.host.read(10);
    expect(read.snapshot).toMatchObject({ id: 'log', params: { item: '2' }, scope: { kind: 'session', sessionId: 'task' } });
    h.host.received(10, { generation: read.snapshot.generation, sequence: read.sequence });
    expect(await pending).toEqual({ tab: 'opened', page: 'received' });
    expect(await h.host.navigate('local:1', newer.requestId)).toEqual({ tab: 'opened', page: 'received' });
    expect(h.messages.filter(m => m.channel === PLUGIN_TAB_VIEW_REQUEST)).toHaveLength(1);
  });
  it('binds only the canonical page and invalidates old guests after remount and installation change', async () => {
    const h = setup(); const a = await h.mount();
    expect(h.host.attach(2, `cindy-ghost://plugin/views/log.html?cindyView=${a.token}`, { id: 10, send: vi.fn(), current: () => true })).toBe(false);
    expect(h.host.attach(1, `cindy-ghost://plugin/preview.html?cindyView=${a.token}`, { id: 10, send: vi.fn(), current: () => true })).toBe(false);
    expect(h.host.attach(1, `cindy-ghost://plugin/views/log.html?cindyView=${a.token}`, { id: 10, send: vi.fn(), current: () => true })).toBe(true);
    const b = await h.mount();
    expect(b.snapshot.generation).not.toBe(a.snapshot.generation);
    expect(() => h.host.read(10)).toThrow('VIEW_UNAVAILABLE');
    h.revoke();
    expect(h.host.authorizeAttach(1, `cindy-ghost://plugin/views/log.html?cindyView=${b.token}`)).toBeNull();
    await expect(h.host.mount(1, { tabId: 'tab', instanceId: 'plugin', id: 'missing', sessionId: 'task', params: {}, sequence: 1, visible: true })).rejects.toThrow();
  });
  it('transfers only current positioning to the native popout owner and releases the old copy', async () => {
    const h = setup(); const a = await h.mount(); h.pop(2);
    h.host.release(1, a.token, true);
    const b = await h.mount(2, 0);
    expect(b.snapshot.params).toEqual({ item: '2' });
    expect(h.host.authorizeAttach(1, `cindy-ghost://plugin/views/log.html?cindyView=${a.token}`)).toBeNull();
    h.host.release(2, b.token, false);
    h.pop(null);
    expect((await h.mount(1, 0)).snapshot.params).toEqual({ item: '0' });
  });
  // 4.3 unit regression: a prewarmed sidebar is ready but hidden. Only the
  // visible native host may receive a first open; older tests only had popouts.
  it.each([false, true])('does not send a first open to a hidden sidebar (visible=%s)', async visible => {
    const h = setup(); h.host.ready(3); if (visible) h.showSidebar();
    const pending = h.host.navigate('local:1', h.request(2).requestId);
    await Promise.resolve();
    const sent = h.messages.find(m => m.payload.requestId)!;
    expect(sent.controller).toBe(visible ? 3 : 1);
    const view = await h.mount(sent.controller);
    h.host.attach(sent.controller, `cindy-ghost://plugin/views/log.html?cindyView=${view.token}`,
      { id: 10, send: vi.fn(), current: () => true });
    h.host.opened(sent.controller, { requestId: sent.payload.requestId, tabId: 'tab' });
    h.host.received(10, { generation: view.token, sequence: view.sequence });
    expect(await pending).toEqual({ tab: 'opened', page: 'received' });
  });
  // A whole-sidebar move has no per-tab popout assignment. A first mount can
  // also happen there before the main renderer finishes creating the tab.
  it('hands the current in-flight position to a detached sidebar before the source mounts', async () => {
    const h = setup();
    const pending = h.host.navigate('local:1', h.request(7).requestId);
    await Promise.resolve();
    const sent = h.messages.find(m => m.payload.requestId)!;
    const view = await h.mount(3, 0);
    expect(view.snapshot.params).toEqual({ item: '7' });
    expect(h.messages).toContainEqual(expect.objectContaining({ controller: 1,
      payload: expect.objectContaining({ releaseTabId: 'tab', sequence: 7 }) }));
    h.host.attach(3, `cindy-ghost://plugin/views/log.html?cindyView=${view.token}`,
      { id: 10, send: vi.fn(), current: () => true });
    h.host.opened(1, { requestId: sent.payload.requestId, tabId: 'tab' });
    h.host.received(10, { generation: view.token, sequence: 7 });
    expect(await pending).toEqual({ tab: 'opened', page: 'received' });
    h.host.release(3, view.token, true);
    const returned = await h.mount(1, 0);
    expect(returned.snapshot.params).toEqual({ item: '7' });
    h.host.release(1, returned.token, false);
    expect((await h.mount(1, 0)).snapshot.params).toEqual({ item: '0' });
  });
  it('keeps a parked position until close and routes a returning popout to its original owner', async () => {
    const h = setup(), first = await h.mount();
    h.host.release(1, first.token, true);
    expect((await h.mount(3, 0)).snapshot.params).toEqual({ item: '2' });
    const parked = await h.mount(3, 0);
    h.host.release(3, parked.token, true);
    h.host.release(3, parked.token, false);
    expect((await h.mount(1, 0)).snapshot.params).toEqual({ item: '0' });

    h.pop(2); const popout = await h.mount(2); h.pop(null);
    h.host.release(2, popout.token, true);
    const pending = h.host.navigate('local:1', h.request(3).requestId);
    await Promise.resolve();
    const sent = h.messages.filter(m => m.payload.requestId).at(-1)!;
    expect(sent.controller).toBe(1);
    h.host.opened(1, { requestId: sent.payload.requestId, tabId: null });
    expect(await pending).toEqual({ tab: 'unavailable', page: 'unconfirmed' });
  });
});
