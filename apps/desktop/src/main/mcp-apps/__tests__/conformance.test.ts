import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { startMockAppServer } from '../../../../scripts/mcp-apps-mock.mjs';
import {
  createRawAppServer,
  RAW_RESOURCE,
  RAW_APP_HTML,
} from '../../../../scripts/mcp-apps-raw-fixture.mjs';
import { AppConnection } from '../connection.js';
import { handleMcpAppOperation } from '../operations.js';
import { McpAppsHost, appServerRevision } from '../host.js';
import { createAppServerProxy } from '../serverProxy.js';
import { registerAppServer, setMcpAppsHost, clearAppServerConfigs } from '../runtime.js';
import type { McpAppRecord, McpAppDocument } from '../../../shared/mcpApps.js';

type Rpc = JSONRPCMessage;
type Init = {
  protocolVersion: string;
  hostInfo: { name: string };
  hostCapabilities: Record<string, unknown>;
  hostContext: Record<string, unknown>;
};
let endpoint: Awaited<ReturnType<typeof startMockAppServer>>;
let textEndpoint: typeof endpoint;
const cleanup: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  endpoint = await startMockAppServer({ createServer: createRawAppServer });
  textEndpoint = await startMockAppServer({
    createServer: () => createRawAppServer({ encoding: 'text', metadata: 'read', legacyUri: true }),
  });
});
afterAll(async () => {
  await endpoint.close();
  await textEndpoint.close();
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  clearAppServerConfigs();
});

/** Independent JSON-RPC peer. No View SDK and no access to Host internals. */
class RawPeer {
  readonly notifications: Rpc[] = [];
  readonly hostRequests: Rpc[] = [];
  readonly links: string[] = [];
  linkSuccess = true;
  private nextId = 1;
  private active = true;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly host: McpAppsHost,
    readonly viewId: string,
  ) {
    void this.poll();
  }
  async notify(method: string, params: Record<string, unknown> = {}) {
    await this.host.dispatch('renderer:conformance', 'task', this.viewId, {
      jsonrpc: '2.0',
      method,
      params,
    });
  }
  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      // real-wait: exercise the production RPC timeout when a fixture never responds.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Fixture RPC timed out: ' + method));
      }, 3_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    void this.host
      .dispatch('renderer:conformance', 'task', this.viewId, { jsonrpc: '2.0', id, method, params })
      .catch((error) => {
        const item = this.pending.get(id);
        if (item) {
          clearTimeout(item.timer);
          this.pending.delete(id);
          item.reject(error);
        }
      });
    return result as Promise<T>;
  }
  get lastRequestId() {
    return this.nextId - 1;
  }
  async cancel(id: number) {
    const item = this.pending.get(id);
    if (item) {
      clearTimeout(item.timer);
      this.pending.delete(id);
      item.reject(new Error('Request cancelled'));
    }
    await this.notify('notifications/cancelled', { requestId: id, reason: 'User cancelled' });
  }
  private async poll() {
    let after = 0;
    while (this.active) {
      let events;
      try {
        events = await this.host.poll('renderer:conformance', 'task', this.viewId, after);
      } catch {
        return;
      }
      for (const event of events) {
        after = event.seq;
        if (event.openLink) {
          this.links.push(event.openLink.url);
          this.host.linkResult(
            'renderer:conformance',
            'task',
            this.viewId,
            event.openLink.id,
            this.linkSuccess,
          );
          continue;
        }
        const message = event.message;
        if ('method' in message) {
          if ('id' in message) {
            this.hostRequests.push(message);
            await this.host.dispatch('renderer:conformance', 'task', this.viewId, {
              jsonrpc: '2.0',
              id: message.id,
              result: {},
            });
          } else this.notifications.push(message);
        } else if (typeof message.id === 'number') {
          const item = this.pending.get(message.id);
          if (item) {
            clearTimeout(item.timer);
            this.pending.delete(message.id);
            if ('error' in message)
              item.reject(
                Object.assign(new Error(message.error.message), { code: message.error.code }),
              );
            else item.resolve(message.result);
          }
        }
      }
    }
  }
  stop() {
    this.active = false;
    this.pending.forEach((item) => clearTimeout(item.timer));
    this.pending.clear();
  }
}

async function fixture(
  transport: 'http' | 'sse' = 'http',
  initialize = true,
  appModes = ['inline', 'fullscreen'],
  source = endpoint,
) {
  const config = {
    id: 'independent-metrics',
    url: transport === 'http' ? source.url : source.sseUrl,
    transport,
  };
  const connection = new AppConnection(config);
  const client = await connection.getClient();
  const tool = (await connection.tools()).find((tool) => tool.name === 'open_metrics')!;
  const args = { threshold: 75 };
  const result = (await client.callTool(
    { name: 'open_metrics', arguments: args },
    CallToolResultSchema,
  )) as CallToolResult;
  const cards = new Map<string, McpAppRecord>();
  const record: McpAppRecord = {
    version: 1,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: RAW_RESOURCE,
    tool,
    arguments: args,
    result,
  };
  cards.set('card', record);
  const owner = {};
  const authorize = vi.fn(async () => {}),
    send = vi.fn(async () => {}),
    audit = vi.fn();
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => config,
    readCard: async (_session, id) => {
      const value = cards.get(id);
      if (!value) throw new Error('MCP_APP_CARD_UNAVAILABLE');
      return value;
    },
    writeCard: async (_session, id, value) => {
      cards.set(id, value);
    },
    authorizeTool: authorize,
    sendMessage: send,
    audit,
  });
  record.connectionId = host.registerConnection(connection);
  const document = (await handleMcpAppOperation(host, 'renderer:conformance', 'task', {
    op: 'open',
    clientId: 'card',
    context: {
      platform: 'desktop',
      theme: 'light',
      locale: 'zh-CN',
      timeZone: 'Asia/Shanghai',
      styles: { variables: { '--color-text-primary': 'rgb(0,0,0)' } },
      containerDimensions: { width: 640, maxHeight: 1_200 },
      safeAreaInsets: { top: 10, right: 0, bottom: 20, left: 0 },
    },
  })) as McpAppDocument;
  const peer = new RawPeer(host, document.viewId);
  cleanup.push(async () => {
    await host.reset();
    peer.stop();
    await connection.close();
  });
  let init: Init | undefined;
  if (initialize) {
    init = await peer.request<Init>('ui/initialize', {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Independent raw peer', version: '1' },
      appCapabilities: { availableDisplayModes: appModes },
    });
    await peer.notify('ui/notifications/initialized');
    await vi.waitFor(() =>
      expect(
        peer.notifications.some(
          (message) => 'method' in message && message.method === 'ui/notifications/tool-result',
        ),
      ).toBe(true),
    );
  }
  const state = async () => {
    const data = await client.readResource({ uri: 'metrics://independent/state' });
    return JSON.parse('text' in data.contents[0] ? data.contents[0].text : '') as {
      cancelled: number;
      slowStarted: number;
      refreshes: number;
    };
  };
  return {
    host,
    peer,
    document,
    record,
    result,
    init,
    client,
    connection,
    config,
    cards,
    authorize,
    send,
    audit,
    state,
  };
}

describe('2026-01-26 MCP Apps conformance against an independent local server', () => {
  it.each(['http', 'sse'] as const)(
    '%s: also loads legacy resourceUri with text HTML and read-level metadata',
    async (transport) => {
      const f = await fixture(transport, true, ['inline', 'fullscreen'], textEndpoint);
      expect(f.record.tool._meta).toEqual({ 'ui/resourceUri': RAW_RESOURCE });
      expect(f.document.html).toBe(RAW_APP_HTML);
      expect(f.document.prefersBorder).toBe(false);
      expect(f.init!.protocolVersion).toBe('2026-01-26');
    },
  );
  it.each(['http', 'sse'] as const)(
    '%s: negotiates the stable protocol with an SDK-free App and blob/list resource metadata',
    async (transport) => {
      const f = await fixture(transport);
      expect(f.document.html).toBe(RAW_APP_HTML);
      expect(f.document.prefersBorder).toBe(false);
      expect(f.init).toMatchObject({
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'Cindy' },
        hostContext: {
          theme: 'light',
          locale: 'zh-CN',
          timeZone: 'Asia/Shanghai',
          toolInfo: { tool: { name: 'open_metrics' } },
          containerDimensions: { width: 640, maxHeight: 1_200 },
          safeAreaInsets: { top: 10, bottom: 20 },
        },
      });
      expect(f.init!.hostCapabilities).toMatchObject({
        serverTools: { listChanged: true },
        serverResources: { listChanged: true },
        sandbox: { permissions: {}, csp: { frameDomains: [] } },
      });
      expect(f.result._meta?.clientUi).toEqual({ mimeTypes: ['text/html;profile=mcp-app'] });
      const input = f.peer.notifications.find(
        (message) => 'method' in message && message.method === 'ui/notifications/tool-input',
      );
      const output = f.peer.notifications.find(
        (message) => 'method' in message && message.method === 'ui/notifications/tool-result',
      );
      expect(input).toMatchObject({ params: { arguments: { threshold: 75 } } });
      expect(output).toMatchObject({ params: f.result });
      expect(f.peer.notifications.indexOf(input!)).toBeLessThan(
        f.peer.notifications.indexOf(output!),
      );
      expect(f.result.content.map((item) => item.type)).toEqual([
        'text',
        'image',
        'audio',
        'resource',
        'resource',
        'resource_link',
      ]);
    },
  );
  it('rejects pre-initialization calls and waits for initialized before sending lifecycle notifications', async () => {
    const f = await fixture('http', false);
    await expect(
      f.peer.request('tools/call', { name: 'refresh_metrics', arguments: {} }),
    ).rejects.toThrow('MCP_APP_NOT_INITIALIZED');
    const result = await f.peer.request<Init>('ui/initialize', {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Raw', version: '1' },
      appCapabilities: {},
    });
    expect(result.protocolVersion).toBe('2026-01-26');
    expect(f.peer.notifications).toEqual([]);
    await f.peer.notify('ui/notifications/initialized');
    await vi.waitFor(() =>
      expect(f.peer.notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'ui/notifications/tool-input' }),
          expect.objectContaining({ method: 'ui/notifications/tool-result' }),
        ]),
      ),
    );
    await expect(
      f.peer.request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'Raw', version: '1' },
        appCapabilities: {},
      }),
    ).rejects.toThrow('MCP_APP_ALREADY_INITIALIZED');
    expect(await f.peer.request('ping')).toEqual({});
  });
  it('negotiates an unknown requested version to the actual supported stable version', async () => {
    const f = await fixture('http', false);
    expect(
      await f.peer.request<Init>('ui/initialize', {
        protocolVersion: '1900-01-01',
        appInfo: { name: 'Future View', version: '1' },
        appCapabilities: {},
      }),
    ).toMatchObject({ protocolVersion: '2026-01-26' });
  });
  it('proxies paginated discovery, resource templates and prompts to the App without model-only tools', async () => {
    const f = await fixture();
    const tools = await f.peer.request<{ tools: Tool[] }>('tools/list');
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'open_metrics',
      'refresh_metrics',
      'slow_metrics',
      'notify_change',
      'error_metrics',
    ]);
    await expect(
      f.peer.request('tools/call', { name: 'model_audit', arguments: {} }),
    ).rejects.toThrow('MCP_APP_TOOL_NOT_VISIBLE');
    const page = await f.peer.request<{ resources: unknown[]; nextCursor: string }>(
      'resources/list',
    );
    expect(page.nextCursor).toBe('ui');
    expect(await f.peer.request('resources/list', { cursor: page.nextCursor })).toMatchObject({
      resources: [{ uri: RAW_RESOURCE }],
    });
    expect(await f.peer.request('resources/templates/list')).toMatchObject({
      resourceTemplates: [{ uriTemplate: 'metrics://independent/{metric}' }],
    });
    expect(
      await f.peer.request('resources/read', { uri: 'metrics://independent/requests' }),
    ).toMatchObject({ contents: [{ text: 'Metric resource: metrics://independent/requests' }] });
    expect(await f.peer.request('prompts/list')).toMatchObject({
      prompts: [{ name: 'explain_metrics' }],
    });
  });
  it.each(['http', 'sse'] as const)('%s: reconnects an open View for each later server operation', async (transport) => {
    const f = await fixture(transport);
    const operations = [
      ['tools/call', { name: 'refresh_metrics', arguments: { threshold: 42 } },
        { structuredContent: { metrics: { threshold: 42, refreshes: 1 } } }],
      ['resources/read', { uri: 'metrics://independent/requests' },
        { contents: [{ text: 'Metric resource: metrics://independent/requests' }] }],
      ['resources/list', { cursor: 'ui' }, { resources: [{ uri: RAW_RESOURCE }] }],
      ['resources/templates/list', {}, { resourceTemplates: [{ uriTemplate: 'metrics://independent/{metric}' }] }],
      ['prompts/list', {}, { prompts: [{ name: 'explain_metrics' }] }],
    ] as const;
    for (const [method, params, expected] of operations) {
      const previous = await f.connection.getClient();
      // Simulate the transport's close event without permanently closing the
      // shared AppConnection, so the next request must create a new client.
      previous.onclose?.();
      await previous.close();
      expect(await f.peer.request(method, params)).toMatchObject(expected);
      expect(await f.connection.getClient()).not.toBe(previous);
    }
    expect(f.authorize).toHaveBeenCalledOnce();
  });
  it('fans out standard list_changed notifications and exposes refreshed tool definitions', async () => {
    const f = await fixture();
    await f.peer.request('tools/call', { name: 'notify_change', arguments: {} });
    await vi.waitFor(() =>
      expect(f.peer.notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ method: 'notifications/tools/list_changed' }),
          expect.objectContaining({ method: 'notifications/resources/list_changed' }),
          expect.objectContaining({ method: 'notifications/prompts/list_changed' }),
        ]),
      ),
    );
    const tools = await f.peer.request<{ tools: Tool[] }>('tools/list');
    expect(tools.tools.find((tool) => tool.name === 'refresh_metrics')?.title).toBe('Refresh 1');
  });
  it('keeps full results in the View, enforces permission and preserves isError', async () => {
    const f = await fixture();
    expect(
      await f.peer.request<CallToolResult>('tools/call', {
        name: 'refresh_metrics',
        arguments: { threshold: 99 },
      }),
    ).toMatchObject({
      structuredContent: { metrics: { threshold: 99, refreshes: 1 } },
      _meta: { viewOnly: 'independent-view-metadata' },
    });
    expect(f.authorize).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ name: 'refresh_metrics' }),
      { threshold: 99 },
      expect.any(AbortSignal),
      expect.objectContaining({ clientId: expect.any(String), serverId: expect.any(String) }),
    );
    expect(
      await f.peer.request('tools/call', { name: 'error_metrics', arguments: {} }),
    ).toMatchObject({ isError: true, _meta: { viewOnly: 'error-details' } });
    f.authorize.mockRejectedValueOnce(new Error('MCP_APP_TOOL_DENIED'));
    await expect(
      f.peer.request('tools/call', { name: 'refresh_metrics', arguments: {} }),
    ).rejects.toThrow('MCP_APP_TOOL_DENIED');
    expect((await f.state()).refreshes).toBe(1);
  });
  it('preserves user message content, replaces model context and rejects unadvertised modalities', async () => {
    const f = await fixture();
    await f.peer.request('ui/update-model-context', {
      content: [{ type: 'text', text: 'old' }],
      structuredContent: { threshold: 1 },
    });
    await f.peer.request('ui/update-model-context', {
      content: [{ type: 'text', text: 'latest' }],
      structuredContent: { threshold: 2 },
    });
    expect((await f.host.modelContext('task')).text).toContain('latest');
    expect((await f.host.modelContext('task')).text).not.toContain('"text":"old"');
    expect(f.send).not.toHaveBeenCalled();
    await f.peer.request('ui/message', {
      role: 'user',
      content: { type: 'text', text: 'Stable message' },
    });
    await f.peer.request('ui/message', {
      role: 'user',
      content: [{ type: 'resource_link', uri: 'metrics://independent/latest', name: 'Metrics' }],
    });
    expect(f.send).toHaveBeenNthCalledWith(1, 'task', expect.anything(), [
      { type: 'text', text: 'Stable message' },
    ], expect.any(Function));
    expect(f.send).toHaveBeenNthCalledWith(2, 'task', expect.anything(), [
      { type: 'resource_link', uri: 'metrics://independent/latest', name: 'Metrics' },
    ], expect.any(Function));
    await expect(
      f.peer.request('ui/message', {
        role: 'user',
        content: [{ type: 'image', mimeType: 'image/png', data: 'AQID' }],
      }),
    ).rejects.toThrow('MCP_APP_MESSAGE_CONTENT_UNSUPPORTED');
    await expect(
      f.peer.request('ui/update-model-context', {
        content: [{ type: 'audio', mimeType: 'audio/wav', data: 'AQID' }],
      }),
    ).rejects.toThrow('MCP_APP_CONTEXT_CONTENT_UNSUPPORTED');
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('returns success and failure for controller link actions and rejects unsafe URLs', async () => {
    const f = await fixture();
    expect(await f.peer.request('ui/open-link', { url: 'https://example.org/metrics' })).toEqual(
      {},
    );
    f.peer.linkSuccess = false;
    await expect(
      f.peer.request('ui/open-link', { url: 'https://example.org/denied' }),
    ).rejects.toThrow('MCP_APP_LINK_OPEN_FAILED');
    await expect(f.peer.request('ui/open-link', { url: 'javascript:alert(1)' })).rejects.toThrow(
      'MCP_APP_INVALID_LINK',
    );
    expect(f.peer.links).toEqual(['https://example.org/metrics', 'https://example.org/denied']);
  });
  it('honors App mode restrictions and sends updated environment as partial Host context', async () => {
    const f = await fixture('http', true, ['inline']);
    expect(await f.peer.request('ui/request-display-mode', { mode: 'fullscreen' })).toEqual({
      mode: 'inline',
    });
    expect(await f.peer.request('ui/request-display-mode', { mode: 'pip' })).toEqual({
      mode: 'inline',
    });
    f.host.context('renderer:conformance', 'task', f.document.viewId, {
      theme: 'dark',
      locale: 'en-US',
    });
    await vi.waitFor(() =>
      expect(f.peer.notifications).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            method: 'ui/notifications/host-context-changed',
            params: expect.objectContaining({ theme: 'dark', locale: 'en-US' }),
          }),
        ]),
      ),
    );
    await f.peer.notify('ui/notifications/size-changed', { width: 640, height: 420 });
    await f.peer.notify('notifications/message', {
      level: 'info',
      data: 'Fixture content should never be logged',
    });
    expect(f.audit.mock.calls.flat()).not.toContain('Fixture content should never be logged');
  });
  it('keeps download unavailable on a Host without a local file handler and rejects unknown methods', async () => {
    const f = await fixture();
    for (const capability of ['sampling', 'downloadFile'])
      expect(f.init!.hostCapabilities).not.toHaveProperty(capability);
    for (const method of ['sampling/createMessage', 'ui/download-file', 'future/unknown']) {
      await expect(f.peer.request(method)).rejects.toMatchObject({ code: -32601 });
    }
    expect(f.audit).toHaveBeenCalledWith('unknown');
  });
  it('propagates standard cancellation to an in-flight App tool without retrying it', async () => {
    const f = await fixture();
    const pending = f.peer.request<CallToolResult>('tools/call', {
      name: 'slow_metrics',
      arguments: {},
    });
    const id = f.peer.lastRequestId;
    const rejection = expect(pending).rejects.toThrow('Request cancelled');
    await vi.waitFor(async () => expect((await f.state()).slowStarted).toBe(1));
    await f.peer.cancel(id);
    await vi.waitFor(async () => expect((await f.state()).cancelled).toBe(1));
    await rejection;
    expect((await f.state()).slowStarted).toBe(1);
  });
  it('completes the standard teardown handshake before the View is released', async () => {
    const f = await fixture();
    await f.host.teardown('renderer:conformance', 'task', f.document.viewId);
    expect(f.peer.hostRequests).toEqual([
      expect.objectContaining({ method: 'ui/resource-teardown' }),
    ]);
    await expect(f.host.poll('renderer:conformance', 'task', f.document.viewId, 0)).rejects.toThrow(
      'MCP_APP_VIEW_UNAVAILABLE',
    );
  });
  it('uses the same model facade for a different App and strips only View metadata', async () => {
    const f = await fixture();
    setMcpAppsHost(f.host);
    registerAppServer(f.config.id, () => f.config);
    const proxy = createAppServerProxy(() => f.config, {
      agentKind: 'codex',
      sessionId: 'task',
      workingDir: '',
    });
    const model = new Client({ name: 'Independent model client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await proxy.connect(serverTransport);
    await model.connect(clientTransport);
    cleanup.push(async () => {
      await model.close();
      await proxy.close();
    });
    expect((await model.listTools()).tools.map((tool) => tool.name)).toEqual([
      'open_metrics',
      'model_audit',
    ]);
    const result = await model.callTool(
      { name: 'open_metrics', arguments: { threshold: 10 } },
      CallToolResultSchema,
    );
    expect(result).not.toHaveProperty('_meta');
    expect(result.content).toEqual(f.result.content);
    const card = [...f.cards.values()].find((card) => card.arguments.threshold === 10)!;
    expect(card.result?._meta).toMatchObject({ viewOnly: 'independent-view-metadata' });
    const second = await f.host.open(
      'renderer:conformance',
      'task',
      [...f.cards.entries()].find(([, value]) => value === card)![0],
      { platform: 'desktop' },
    );
    expect(second.html).toBe(RAW_APP_HTML);
    await expect(model.callTool({ name: 'refresh_metrics', arguments: {} })).rejects.toThrow(
      'MCP_APP_TOOL_NOT_VISIBLE',
    );
    expect(await model.getPrompt({ name: 'explain_metrics' })).toMatchObject({
      messages: [{ role: 'user', content: { text: 'Explain these metrics.' } }],
    });
    expect(await model.listResourceTemplates()).toMatchObject({
      resourceTemplates: [{ name: 'Metric' }],
    });
  });
});
