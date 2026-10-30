import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { encodeReliableFrames } from '../../../../../../packages/device-link/src/transport.js';
import { McpAppsHost, appServerRevision } from '../host.js';
import type { AppConnection } from '../connection.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import { MCP_APPS_MAX_BYTES, MCP_APPS_MAX_REMOTE_BYTES } from '../protocol.js';

const hosts: McpAppsHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
});

function wire(result: unknown) {
  return {
    v: 1 as const,
    kind: 'invoke-result' as const,
    id: 'request',
    src: 'host',
    dst: 'controller',
    payload: { ok: true as const, result },
  };
}

function fixture() {
  const owner = {};
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const uri = 'ui://form';
  const tool = {
    name: 'form',
    inputSchema: { type: 'object' as const },
    _meta: { ui: { resourceUri: uri } },
  };
  const record: McpAppRecord = {
    version: 1 as const,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: uri,
    tool,
    arguments: {},
  };
  const contents = (text: string) => ({
    contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text }],
  });
  const resource = vi.fn<AppConnection['resource']>(async () => ({ result: contents('') }));
  const readResource = vi.fn(async () => contents(''));
  const connection = {
    getClient: async () => ({ getServerCapabilities: () => ({ resources: {} }), readResource }),
    tools: async () => [tool],
    resource,
    listen: () => () => {},
    close: vi.fn(async () => {}),
  } as unknown as AppConnection;
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => config,
    readCard: async () => record,
    writeCard: async () => {},
    authorizeTool: async () => {},
    sendMessage: async () => {},
    connection: () => connection,
  });
  // These budget cases model an active tool, not an orphan from a previous Host.
  record.connectionId = host.registerConnection(connection);
  hosts.push(host);
  return { host, resource, readResource, connection, contents };
}

async function initialized(host: McpAppsHost, caller: string) {
  const document = await host.open(caller, 'task', 'card', {});
  const viewId = document.viewId;
  await host.dispatch(caller, 'task', viewId, {
    jsonrpc: '2.0',
    id: 1,
    method: 'ui/initialize',
    params: {
      protocolVersion: '2026-01-26',
      appInfo: { name: 'Budget fixture', version: '1' },
      appCapabilities: {},
    },
  });
  const init = await host.poll(caller, 'task', viewId, 0);
  expect(init.some((event) => event.message && 'result' in event.message)).toBe(true);
  let after = init.at(-1)!.seq;
  await host.dispatch(caller, 'task', viewId, {
    jsonrpc: '2.0',
    method: 'ui/notifications/initialized',
  });
  let input = false;
  while (!input) {
    const events = await host.poll(caller, 'task', viewId, after);
    after = events.at(-1)!.seq;
    input = events.some(
      (event) =>
        event.message &&
        'method' in event.message &&
        event.message.method === 'ui/notifications/tool-input',
    );
  }
  return { viewId, after };
}

describe('MCP Apps serialized remote result budgets', () => {
  it('accepts the complete remote document at its limit, including CSP and JSON escaping', async () => {
    const f = fixture();
    const empty = await f.host.open('renderer:local', 'task', 'card', {});
    const overhead = Buffer.byteLength(JSON.stringify(empty));
    const html = 'x'.repeat(MCP_APPS_MAX_REMOTE_BYTES - overhead);
    f.resource.mockResolvedValue({ result: f.contents(html) });
    const document = await f.host.open('device:phone', 'task', 'card', {});
    expect(Buffer.byteLength(JSON.stringify(document))).toBe(MCP_APPS_MAX_REMOTE_BYTES);
    expect(() => encodeReliableFrames(wire(document), 'stream', 1)).not.toThrow();
    f.resource.mockResolvedValue({ result: f.contents(html + 'x') });
    await expect(f.host.open('device:phone', 'task', 'card', {})).rejects.toThrow(
      'MCP_APP_RESOURCE_TOO_LARGE',
    );
  });

  it.each(['multibyte', 'quotes', 'control characters'] as const)(
    'rejects remote %s before retaining a View, while preserving the local resource budget',
    async (kind) => {
      const f = fixture();
      const html =
        kind === 'multibyte'
          ? '汉'.repeat(Math.floor(MCP_APPS_MAX_REMOTE_BYTES / 3))
          : kind === 'quotes'
            ? '"'.repeat(MCP_APPS_MAX_BYTES / 2)
            : String.fromCharCode(1).repeat(Math.ceil(MCP_APPS_MAX_REMOTE_BYTES / 6));
      expect(Buffer.byteLength(html)).toBeLessThanOrEqual(MCP_APPS_MAX_BYTES);
      f.resource.mockResolvedValue({ result: f.contents(html) });
      for (let attempt = 0; attempt < 5; attempt++)
        await expect(f.host.open('device:phone', 'task', 'card', {})).rejects.toThrow(
          'MCP_APP_RESOURCE_TOO_LARGE',
        );
      expect((await f.host.open('renderer:local', 'task', 'card', {})).html).toBe(html);
      f.resource.mockResolvedValue({ result: f.contents('small') });
      expect(await f.host.open('device:phone', 'task', 'card', {})).toHaveProperty('viewId');
    },
  );

  it.each(['device:phone', 'renderer:local'])(
    'applies UTF-8 event backpressure to %s without interrupting another controller',
    async (caller) => {
      const f = fixture();
      const healthy = await initialized(f.host, 'device:healthy');
      const target = await initialized(f.host, caller);
      const limit = caller.startsWith('device:') ? MCP_APPS_MAX_REMOTE_BYTES : MCP_APPS_MAX_BYTES;
      const text = '汉'.repeat(Math.floor(limit / 3) + 1);
      expect(JSON.stringify(f.contents(text)).length).toBeLessThan(limit);
      f.readResource.mockResolvedValueOnce(f.contents(text));
      const poll = f.host.poll(caller, 'task', target.viewId, target.after);
      const rejected = expect(poll).rejects.toThrow('MCP_APP_BACKPRESSURE');
      await f.host.dispatch(caller, 'task', target.viewId, {
        jsonrpc: '2.0',
        id: 2,
        method: 'resources/read',
        params: { uri: 'ui://form' },
      });
      await rejected;
      await f.host.dispatch('device:healthy', 'task', healthy.viewId, {
        jsonrpc: '2.0',
        id: 3,
        method: 'ping',
      });
      const events = await f.host.poll('device:healthy', 'task', healthy.viewId, healthy.after);
      expect(
        events.some(
          (event) =>
            event.message &&
            'id' in event.message &&
            event.message.id === 3 &&
            'result' in event.message,
        ),
      ).toBe(true);
      expect(f.connection.close).not.toHaveBeenCalled();
    },
  );

  it('reclaims the same UTF-8 bytes after acknowledgement and transports near-limit poll results', async () => {
    const f = fixture();
    const caller = 'device:phone';
    const view = await initialized(f.host, caller);
    const text = '汉'.repeat(Math.floor((MCP_APPS_MAX_REMOTE_BYTES - 1024) / 3));
    f.readResource.mockResolvedValue(f.contents(text));
    for (let id = 2; id < 5; id++) {
      const poll = f.host.poll(caller, 'task', view.viewId, view.after);
      await f.host.dispatch(caller, 'task', view.viewId, {
        jsonrpc: '2.0',
        id,
        method: 'resources/read',
        params: { uri: 'ui://form' },
      });
      const events = await poll;
      expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThanOrEqual(
        MCP_APPS_MAX_REMOTE_BYTES,
      );
      expect(() => encodeReliableFrames(wire(events), 'stream', id)).not.toThrow();
      const response = events.find(
        (event) => event.message && 'id' in event.message && event.message.id === id,
      )?.message as JSONRPCMessage;
      expect(response).toHaveProperty('result.contents.0.text', text);
      view.after = events.at(-1)!.seq;
    }
  });
});
