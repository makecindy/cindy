import { describe, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { PLUGIN_UI_CAPABILITIES } from '@cindy/maker-shared';
import { createPluginUiIpcHandlers } from '../pluginUiIpc.js';
import { registerPluginTabViewIpc } from '../pluginTabViewIpc.js';
import { PLUGIN_TAB_VIEW_MOUNT, PLUGIN_TAB_VIEW_READ } from '../../../shared/pluginUi.js';

/* C4/C9 local adapter. Existing remote-only IPC tests do not cover this new
 * boundary. Minimum input: a valid request from a non-app frame; no business
 * service may be called. Tier: unit, injected handlers without Electron boot. */
const event = { sender: { id: 42, isDestroyed: () => false } } as IpcMainInvokeEvent;
const request = { sessionId: 'task', point: 'composer.tools', capabilities: PLUGIN_UI_CAPABILITIES };
function setup(dev = true) {
  const service = { read: vi.fn(async (_controller: string, _request: unknown, _guard: () => boolean) => ({ views: [], revision: '' })),
    invoke: vi.fn(async () => ({ status: 'completed', invocationId: 'click' })), chooseRenderer: vi.fn(async () => {}),
    release: vi.fn(), inspect: vi.fn(() => ({ bindings: 0 })) };
  const assertTrusted = vi.fn();
  const pageHost = { open: vi.fn(async () => 'page-id'), close: vi.fn(async () => {}) };
  const handlers = createPluginUiIpcHandlers({ service: () => service as never, pageHost: () => pageHost as never, assertTrusted,
    devEnabled: () => dev, fail: (code, message) => { throw Object.assign(new Error(message), { code }); } });
  return { service, pageHost, assertTrusted, handlers };
}
describe('native UI local IPC', () => {
  // 4.3 unit: the real IPC registration keeps native mounting and guest reads
  // on distinct source guards, including child frames of a registered guest.
  it('keeps the named view guest bridge separate from trusted renderer mounting', async () => {
    const routes = new Map<string, (event: IpcMainInvokeEvent, value: unknown) => unknown>();
    const mount = vi.fn(), read = vi.fn(() => ({ id: 'log' }));
    const trusted = vi.fn(() => { throw new Error('untrusted'); });
    registerPluginTabViewIpc({ handle: (channel, run) => { routes.set(channel, run); } },
      () => ({ mount, read }) as never, trusted);
    const frame = { parent: null }, sender = { id: 10, mainFrame: frame };
    const guest = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    expect(routes.get(PLUGIN_TAB_VIEW_READ)!(guest, undefined)).toEqual({ id: 'log' });
    expect(trusted).not.toHaveBeenCalled();
    expect(() => routes.get(PLUGIN_TAB_VIEW_READ)!({ ...guest, senderFrame: { parent: frame } } as never, undefined)).toThrow();
    expect(() => routes.get(PLUGIN_TAB_VIEW_MOUNT)!(guest, {})).toThrow('untrusted');
    expect(mount).not.toHaveBeenCalled(); expect(read).toHaveBeenCalledOnce();
  });
  it('rejects untrusted frames before parsing or calling a service', async () => {
    const h = setup(); h.assertTrusted.mockImplementation(() => { throw new Error('untrusted'); });
    await expect(h.handlers.read(event, request)).rejects.toThrow('untrusted');
    expect(h.service.read).not.toHaveBeenCalled();
    await expect(h.handlers.choose(event, { request, choice: null })).rejects.toThrow('untrusted');
    expect(h.service.chooseRenderer).not.toHaveBeenCalled();
    expect(() => h.handlers.release(event, { subscriptionId: 'outlet' })).toThrow('untrusted');
    expect(h.service.release).not.toHaveBeenCalled();
  });
  it('validates a local renderer choice without accepting an injected source identity', async () => {
    const h = setup();
    const target = { ...request, point: 'tool.body', target: { kind: 'tool', id: 'tool-1' } };
    const choice = { instanceId: 'plugin-instance', contributionId: 'render' };
    await h.handlers.choose(event, { request: target, choice, source: { instanceId: 'forged' } });
    expect(h.service.chooseRenderer).toHaveBeenCalledWith('local:42', target, choice, expect.any(Function));
    await expect(h.handlers.choose(event, { request: target, choice: { instanceId: '', contributionId: 'render' } })).rejects.toThrow();
    await expect(h.handlers.choose(event, { request: target })).rejects.toThrow();
  });
  it('stamps the real local controller and rejects malformed fixed-purpose requests', async () => {
    const h = setup(); expect(await h.handlers.read(event, request)).toEqual({ views: [], revision: '' });
    expect(h.service.read).toHaveBeenCalledWith('local:42', request, expect.any(Function));
    await expect(h.handlers.read(event, { ...request, capabilities: { primitives: 'anything' } })).rejects.toThrow();
    const input = { viewId: 'view', expectedRevision: '1', actionId: 'save', invocationId: 'click', values: {} };
    await h.handlers.invoke(event, { sessionId: 'task', input });
    expect(h.service.invoke).toHaveBeenCalledWith('local:42', 'task', input, expect.any(Function));
    h.handlers.release(event, { subscriptionId: 'outlet' });
    expect(h.service.release).toHaveBeenCalledExactlyOnceWith('local:42', 'outlet');
    expect(() => h.handlers.release(event, { subscriptionId: '' })).toThrow();
  });
  it('rejects native UI requests without a task binding', async () => {
    const h = setup();
    await expect(h.handlers.read(event, { point: 'composer.tools', capabilities: PLUGIN_UI_CAPABILITIES })).rejects.toThrow();
    const input = { viewId: 'view', expectedRevision: '1', actionId: 'save', invocationId: 'click', values: {} };
    await expect(h.handlers.invoke(event, { input })).rejects.toThrow();
    await expect(h.handlers.openPage(event, { viewId: 'view', revision: '1' })).rejects.toThrow();
    expect(h.service.read).not.toHaveBeenCalled();
    expect(h.service.invoke).not.toHaveBeenCalled();
    expect(h.pageHost.open).not.toHaveBeenCalled();
  });
  it('opens and closes a page only from its trusted owning renderer', async () => {
    const h = setup();
    expect(await h.handlers.openPage(event, { sessionId: 'task', viewId: 'view', revision: '1', instanceId: 'forged' })).toBe('page-id');
    expect(h.pageHost.open).toHaveBeenCalledWith('local:42', 'task', 'view', '1', expect.any(Function));
    await h.handlers.closePage(event, { pageId: 'page-id' });
    expect(h.pageHost.close).toHaveBeenCalledWith('local:42', 'page-id');
    await expect(h.handlers.openPage(event, { sessionId: 'task', viewId: '', revision: '1' })).rejects.toThrow();
    h.assertTrusted.mockImplementation(() => { throw new Error('untrusted'); });
    await expect(h.handlers.openPage(event, { sessionId: 'task', viewId: 'view', revision: '1' })).rejects.toThrow('untrusted');
    expect(h.pageHost.open).toHaveBeenCalledOnce();
  });
  it('uses a dev-only inspection branch and rejects a renderer that leaves during a read', async () => {
    const h = setup(false); expect(() => h.handlers.inspect(event)).toThrow();
    expect(h.service.inspect).not.toHaveBeenCalled();
    const d = setup(); expect(d.handlers.inspect(event)).toEqual({ bindings: 0 });
    await d.handlers.read(event, request);
    const isCurrent = d.service.read.mock.calls[0][2] as unknown as () => boolean;
    d.assertTrusted.mockImplementation(() => { throw new Error('navigated'); });
    expect(isCurrent()).toBe(false);
  });
});
