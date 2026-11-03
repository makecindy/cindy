import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAppsHost, appServerRevision } from '../host.js';
import type { AppConnection } from '../connection.js';

const hosts: McpAppsHost[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
});
function fixture() {
  const owner = {};
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const tool = { name: 'form', inputSchema: { type: 'object' as const }, _meta: { ui: { resourceUri: 'ui://form' } } };
  const record = { version: 1 as const, serverId: config.id, serverRevision: appServerRevision(config), resourceUri: 'ui://form', tool, arguments: {} };
  const resource = vi.fn<AppConnection['resource']>(async () => ({
    result: { contents: [{ uri: record.resourceUri, mimeType: 'text/html;profile=mcp-app', text: '<html>form</html>' }] },
  }));
  const connection = {
    getClient: async () => ({ getServerCapabilities: () => ({}) }),
    tools: async () => [tool], resource, listen: () => () => {}, close: vi.fn(async () => {}),
  } as unknown as AppConnection;
  const disposeDocument = vi.fn();
  const host = new McpAppsHost({ owner: () => owner, config: () => config, readCard: async () => record,
    writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {},
    connection: () => connection, disposeDocument });
  hosts.push(host);
  return { host, resource, disposeDocument, connection };
}
async function initialize(host: McpAppsHost, viewId: string) {
  await host.dispatch('device:phone', 'task', viewId, {
    jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {
      protocolVersion: '2026-01-26', appInfo: { name: 'link-test', version: '1' }, appCapabilities: {},
    },
  });
  await host.dispatch('device:phone', 'task', viewId, { jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await vi.advanceTimersByTimeAsync(0);
}
describe('MCP App open cancellation', () => {
  it('reserves a pending link before its original timeout and accepts its delayed result once', async () => {
    const f = fixture();
    const doc = await f.host.open('device:phone', 'task', 'card', {});
    vi.useFakeTimers();
    await initialize(f.host, doc.viewId);
    await f.host.dispatch('device:phone', 'task', doc.viewId, {
      jsonrpc: '2.0', id: 2, method: 'ui/open-link', params: { url: 'https://example.org/' },
    });
    await vi.advanceTimersByTimeAsync(0);
    const events = await f.host.poll('device:phone', 'task', doc.viewId, 0);
    const link = events.find((event) => event.openLink)!;
    expect(link.openLink).toBeDefined();
    await vi.advanceTimersByTimeAsync(9_999);
    await f.host.authorizeLink('device:phone', 'task', doc.viewId, link.openLink!.id);
    await vi.advanceTimersByTimeAsync(2);
    const delivered = vi.fn();
    const pending = f.host.poll('device:phone', 'task', doc.viewId, link.seq).then(delivered);
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).not.toHaveBeenCalled();
    f.host.linkResult('device:phone', 'task', doc.viewId, link.openLink!.id, true);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    expect(delivered.mock.calls[0][0]).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ id: 2, result: {} }),
    }));
    await expect(f.host.authorizeLink('device:phone', 'task', doc.viewId, link.openLink!.id))
      .rejects.toThrow('MCP_APP_LINK_UNAVAILABLE');
  });
  it('grants a pending link once and expires the bounded reservation if no result arrives', async () => {
    const f = fixture();
    const doc = await f.host.open('device:phone', 'task', 'card', {});
    vi.useFakeTimers();
    await initialize(f.host, doc.viewId);
    await f.host.dispatch('device:phone', 'task', doc.viewId, {
      jsonrpc: '2.0', id: 2, method: 'ui/open-link', params: { url: 'https://example.org/' },
    });
    await vi.advanceTimersByTimeAsync(0);
    const link = (await f.host.poll('device:phone', 'task', doc.viewId, 0)).find((event) => event.openLink)!;
    expect(await f.host.authorizeLink('device:phone', 'task', doc.viewId, link.openLink!.id))
      .toEqual({ authorized: true, validForMs: 30_000 });
    await expect(f.host.authorizeLink('device:phone', 'task', doc.viewId, link.openLink!.id))
      .rejects.toThrow('MCP_APP_LINK_ALREADY_AUTHORIZED');
    await vi.advanceTimersByTimeAsync(30_000);
    const events = await f.host.poll('device:phone', 'task', doc.viewId, link.seq);
    expect(events).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ id: 2, error: expect.objectContaining({ message: expect.stringContaining('MCP_APP_LINK_OPEN_FAILED') }) }),
    }));
    await expect(f.host.authorizeLink('device:phone', 'task', doc.viewId, link.openLink!.id))
      .rejects.toThrow('MCP_APP_LINK_UNAVAILABLE');
  });
  it('reclaims a reloaded caller quota immediately without closing shared connections', async () => {
    const f = fixture();
    const old = [];
    for (let i = 0; i < 16; i++) old.push(await f.host.open('renderer:1', 'task', 'card', {}));
    const other = await f.host.open('renderer:2', 'task', 'card', {});
    const phone = await f.host.open('device:phone', 'task', 'card', {});
    await expect(f.host.open('renderer:1', 'task', 'card', {})).rejects.toThrow('MCP_APP_VIEW_LIMIT');

    const cleanup = f.host.releaseCaller('renderer:1');
    // No sweep, asynchronous iframe teardown or connection shutdown may delay reuse.
    expect(f.disposeDocument).toHaveBeenCalledTimes(16);
    for (const document of old) {
      expect(f.disposeDocument).toHaveBeenCalledWith(document.viewId);
      expect(() => f.host.context('renderer:1', 'task', document.viewId, {})).toThrow('MCP_APP_VIEW_UNAVAILABLE');
    }
    for (let i = 0; i < 16; i++) await f.host.open('renderer:1', 'task', 'card', {});
    await cleanup;
    expect(() => f.host.context('renderer:2', 'task', other.viewId, {})).not.toThrow();
    expect(() => f.host.context('device:phone', 'task', phone.viewId, {})).not.toThrow();
    expect(f.connection.close).not.toHaveBeenCalled();
  });

  it('cancels only the exiting caller pending loads and refuses their late Views', async () => {
    const f = fixture();
    const data = await f.resource('ui://form');
    let finish!: () => void;
    f.resource.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(data); }));
    const slow = f.host.open('renderer:1', 'task', 'card', {}, 'old');
    const rejected = expect(slow).rejects.toThrow('MCP_APP_OPEN_CANCELLED');
    await vi.waitFor(() => expect(finish).toBeDefined());
    const other = await f.host.open('renderer:2', 'task', 'card', {});
    let finishOther!: () => void;
    f.resource.mockImplementationOnce(() => new Promise((resolve) => { finishOther = () => resolve(data); }));
    const otherPending = f.host.open('device:phone', 'task', 'card', {});
    await vi.waitFor(() => expect(finishOther).toBeDefined());
    await f.host.releaseCaller('renderer:1');
    await rejected;
    finish();
    finishOther();
    expect(await otherPending).toHaveProperty('viewId');
    expect(() => f.host.context('renderer:2', 'task', other.viewId, {})).not.toThrow();
    expect(f.disposeDocument).not.toHaveBeenCalled();
    expect(f.connection.close).not.toHaveBeenCalled();
    for (let i = 0; i < 16; i++) await f.host.open('renderer:1', 'task', 'card', {}, `replacement-${i}`);
  });

  it('cancels a pending open without touching another controller or replaying anything', async () => {
    const f = fixture();
    const healthy = await f.host.open('device:healthy', 'task', 'card', {}, 'same-id');
    const data = await f.resource('ui://form');
    let finish!: () => void;
    f.resource.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(data); }));
    const slow = f.host.open('device:slow', 'task', 'card', {}, 'same-id');
    const rejected = expect(slow).rejects.toThrow('MCP_APP_OPEN_CANCELLED');
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.host.cancelOpen('device:slow', 'task', 'same-id');
    await rejected;
    finish();
    await Promise.resolve();
    expect(() => f.host.context('device:healthy', 'task', healthy.viewId, { theme: 'dark' })).not.toThrow();
    expect(f.disposeDocument).not.toHaveBeenCalledWith(healthy.viewId);
    expect(f.resource).toHaveBeenCalledTimes(3);
  });
  it('reclaims a View when its open response was lost, scoped to caller and task', async () => {
    const f = fixture();
    const doc = await f.host.open('device:phone', 'task', 'card', {}, 'attempt');
    await f.host.cancelOpen('device:other', 'task', 'attempt');
    await f.host.cancelOpen('device:phone', 'other-task', 'attempt');
    expect(() => f.host.context('device:phone', 'task', doc.viewId, {})).not.toThrow();
    await f.host.cancelOpen('device:phone', 'task', 'attempt');
    expect(f.disposeDocument).toHaveBeenCalledWith(doc.viewId);
    expect(() => f.host.context('device:phone', 'task', doc.viewId, {})).toThrow('MCP_APP_VIEW_UNAVAILABLE');
  });
  it('remembers cancellation that arrives before open and permits a different attempt', async () => {
    const f = fixture();
    await f.host.cancelOpen('device:phone', 'task', 'old');
    await expect(f.host.open('device:phone', 'task', 'card', {}, 'old')).rejects.toThrow('MCP_APP_OPEN_CANCELLED');
    expect(f.resource).not.toHaveBeenCalled();
    expect(await f.host.open('device:phone', 'task', 'card', {}, 'new')).toHaveProperty('viewId');
  });
  it('bounds loading at 90 seconds and never publishes a late document', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let aborted = false;
    f.resource.mockImplementationOnce((_uri, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => { aborted = true; reject(signal!.reason); });
    }));
    const pending = f.host.open('device:phone', 'task', 'card', {}, 'attempt');
    const rejected = expect(pending).rejects.toThrow('MCP_APP_OPEN_TIMEOUT');
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(aborted).toBe(true);
    expect(f.disposeDocument).not.toHaveBeenCalled();
    expect(f.connection.close).toHaveBeenCalled();
  });
});
