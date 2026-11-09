import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
  const readCard = vi.fn(async () => record);
  const writeCard = vi.fn(async () => {});
  const host = new McpAppsHost({ owner: () => owner, config: () => config, readCard,
    writeCard, authorizeTool: async () => {}, sendMessage: async () => {},
    connection: () => connection, disposeDocument });
  hosts.push(host);
  const binding = { id: 'workspace', title: 'Workspace', serverId: config.id,
    serverRevision: record.serverRevision, resourceUri: record.resourceUri, assertCurrent: vi.fn(() => {}) };
  return { host, resource, disposeDocument, connection, readCard, writeCard, binding };
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
  // UI extension contract: independently opened resources share the real Host,
  // never fabricate a task/card or replay a tool to obtain a document (unit).
  it('opens an authorized resource without reading or writing a tool card', async () => {
    const f = fixture();
    const document = await f.host.openResource('renderer:1', null, f.binding, {});
    expect(document.html).toContain('form');
    expect(f.readCard).not.toHaveBeenCalled();
    expect(f.writeCard).not.toHaveBeenCalled();
    await expect(f.host.assertViewAuthorized('renderer:1', null, document.viewId)).resolves.toBeUndefined();
    expect(f.binding.assertCurrent).toHaveBeenCalled();
    expect(f.readCard).not.toHaveBeenCalled();
    await f.host.releaseCaller('renderer:1');
    expect(() => f.host.context('renderer:1', null, document.viewId, {})).toThrow('MCP_APP_VIEW_UNAVAILABLE');
  });

  it('refuses a resource whose binding was revoked while HTML was loading', async () => {
    const f = fixture();
    const data = await f.resource(f.binding.resourceUri);
    let finish!: () => void;
    f.resource.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(data); }));
    const pending = f.host.openResource('renderer:1', null, f.binding, {});
    const rejected = expect(pending).rejects.toThrow('MCP_APP_SOURCE_UNAVAILABLE');
    await vi.waitFor(() => expect(finish).toBeDefined());
    f.binding.assertCurrent.mockImplementation(() => { throw new Error('MCP_APP_SOURCE_UNAVAILABLE'); });
    finish();
    await rejected;
    expect(f.readCard).not.toHaveBeenCalled();
    expect(f.writeCard).not.toHaveBeenCalled();
  });

  it('initializes a standalone resource with the standard bridge and no fabricated tool identity', async () => {
    const f = fixture();
    const document = await f.host.openResource('renderer:1', null, f.binding, {
      toolInfo: { id: 'forged', tool: { name: 'forged', inputSchema: { type: 'object' } } },
    });
    await f.host.dispatch('renderer:1', null, document.viewId, {
      jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {
        protocolVersion: '2026-01-26', appInfo: { name: 'Workspace', version: '1' }, appCapabilities: {},
      },
    });
    const events = await f.host.poll('renderer:1', null, document.viewId, 0);
    const initialized = events.find(event => event.message && 'id' in event.message && event.message.id === 1);
    expect(initialized?.message).toMatchObject({ result: { protocolVersion: '2026-01-26' } });
    expect((initialized?.message as { result: { hostContext?: { toolInfo?: unknown } } }).result.hostContext?.toolInfo).toBeUndefined();
    expect(f.readCard).not.toHaveBeenCalled();
    expect(f.writeCard).not.toHaveBeenCalled();
  });

  it('initializes from the authoritative context source and keeps it until the View closes', async () => {
    const f = fixture();
    let changed!: () => void;
    let draft = { revision: 'original' };
    const stop = vi.fn();
    const observeContext = vi.fn(async (notify: () => void) => { changed = notify; notify(); return stop; });
    const document = await f.host.openResource('renderer:1', null, { ...f.binding,
      observeContext, projectContext: () => ({ draft }),
    }, {});
    vi.useFakeTimers();
    const initialize = async (id: number) => {
      await f.host.dispatch('renderer:1', null, document.viewId, {
        jsonrpc: '2.0', id, method: 'ui/initialize', params: {
          protocolVersion: '2026-01-26', appInfo: { name: 'Workspace', version: '1' }, appCapabilities: {},
        },
      });
      await f.host.dispatch('renderer:1', null, document.viewId, { jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      await vi.advanceTimersByTimeAsync(0);
      return f.host.poll('renderer:1', null, document.viewId, 0);
    };
    expect(await initialize(1)).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ id: 1, result: expect.objectContaining({ hostContext: expect.objectContaining({ cindy: { draft } }) }) }),
    }));
    draft = { revision: 'after-edit' }; changed();
    expect(await initialize(2)).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ id: 2, result: expect.objectContaining({ hostContext: expect.objectContaining({ cindy: { draft } }) }) }),
    }));
    expect(observeContext).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(f.readCard).not.toHaveBeenCalled();
    expect(f.writeCard).not.toHaveBeenCalled();
    await f.host.releaseCaller('renderer:1');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => changed()).not.toThrow();
  });

  it('calls a standalone resource host tool through the official App SDK without a task or tool card', async () => {
    const f = fixture();
    const callHostTool = vi.fn(async () => ({ content: [{ type: 'text' as const, text: '{"opened":true}' }] }));
    const document = await f.host.openResource('renderer:1', null, { ...f.binding,
      hostTools: [{ name: 'cindy.ui.open', inputSchema: { type: 'object', properties: { viewId: { type: 'string' } }, required: ['viewId'] } }],
      callHostTool,
    }, {});
    let active = true;
    const transport: Transport = {
      async start() {
        void (async () => {
          let after = 0;
          while (active) {
            try {
              const events = await f.host.poll('renderer:1', null, document.viewId, after);
              for (const event of events) { after = event.seq; if (event.message) transport.onmessage?.(event.message); }
            } catch (error) { if (active) transport.onerror?.(error as Error); return; }
          }
        })();
      },
      send: message => f.host.dispatch('renderer:1', null, document.viewId, message),
      async close() { active = false; transport.onclose?.(); },
    };
    const app = new App({ name: 'Standalone View', version: '1' }, {}, { autoResize: false });
    try {
      await app.connect(transport);
      expect(await app.callServerTool({ name: 'cindy.ui.open', arguments: { viewId: 'workspace' } }))
        .toMatchObject({ content: [{ type: 'text', text: '{"opened":true}' }] });
      expect(callHostTool).toHaveBeenCalledWith('cindy.ui.open', { viewId: 'workspace' }, expect.any(AbortSignal));
      expect(f.readCard).not.toHaveBeenCalled();
      expect(f.writeCard).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

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
