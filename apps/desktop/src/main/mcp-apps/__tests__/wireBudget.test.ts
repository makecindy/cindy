import { createHash } from 'node:crypto';
import { McpAppSdkCache, type McpAppDocument } from '../../../shared/mcpApps.js';
import { handleMcpAppOperation } from '../operations.js';
import { gzipSync } from 'node:zlib';
import { hostAppSdkAsset } from '../hostSdk.js';
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

// Contract: size is measured on the actual shipped asset, not source spelling.
it('keeps the two shipped helper modules within the fixed raw and gzip budget', () => {
  const addon = hostAppSdkAsset.addons['cindy/view-state'];
  const modules = [addon.source, addon.reactSource];
  expect(modules.reduce((n, source) => n + Buffer.byteLength(source), 0)).toBeLessThanOrEqual(16 * 1024);
  expect(modules.reduce((n, source) => n + gzipSync(source).length, 0)).toBeLessThanOrEqual(6 * 1024);
});

describe('MCP Apps serialized remote result budgets', () => {
  // Ordinary metadata and an authored SDK prefix both keep the legacy wire budget.
  it.each([
    '<script>const packageName = "@modelcontextprotocol/ext-apps";</script>',
    '<script type="importmap">{"imports":{"@modelcontextprotocol/":"https://vendor.example/mcp/"}}</script><script type="module">import "@modelcontextprotocol/ext-apps";</script>',
  ])('accepts the complete remote document at its limit with authored SDK provisioning: %s', async (prefix) => {
    const f = fixture();
    const empty = await f.host.open('renderer:local', 'task', 'card', {});
    const overhead = Buffer.byteLength(JSON.stringify({ ...empty, html: prefix, sdk: undefined }));
    const html = prefix + 'x'.repeat(MCP_APPS_MAX_REMOTE_BYTES - overhead);
    f.resource.mockResolvedValue({ result: f.contents(html) });
    const document = await f.host.open('device:phone', 'task', 'card', {});
    expect(document.sdk).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(document))).toBe(MCP_APPS_MAX_REMOTE_BYTES);
    expect(() => encodeReliableFrames(wire(document), 'stream', 1)).not.toThrow();
    // Even the small reference must not reduce the legacy SDK-less page limit.
    const hash = createHash('sha256').update(JSON.stringify([empty.sdk!.source,
      empty.sdk!.addons?.['cindy/view-state']?.source ?? null,
      empty.sdk!.addons?.['cindy/view-state']?.reactSource ?? null])).digest('hex');
    const referenced = await handleMcpAppOperation(f.host, 'device:phone', 'task', {
      op: 'open', clientId: 'card', sdkCacheHashes: [hash],
    }) as McpAppDocument;
    expect(referenced.sdk).toBeUndefined();
    expect(referenced.sdkRef).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(referenced))).toBe(MCP_APPS_MAX_REMOTE_BYTES);

    f.resource.mockResolvedValue({ result: f.contents(html + 'x') });
    await expect(f.host.open('device:phone', 'task', 'card', {})).rejects.toThrow(
      'MCP_APP_RESOURCE_TOO_LARGE',
    );
  });

  // Always-on SDK cannot reduce the legacy page budget: real Host.open must
  // open an otherwise valid page even when the optional environment bytes do not fit.
  it('opens a page without SDK bytes when only the appended SDK exceeds the remote budget', async () => {
    const f = fixture();
    const html = '<script type="module">import "@modelcontextprotocol/ext-apps";</script>' + 'x'.repeat(MCP_APPS_MAX_REMOTE_BYTES - 4096);
    f.resource.mockResolvedValue({ result: f.contents(html) });
    const local = await f.host.open('renderer:local', 'task', 'card', {});
    expect(local.sdk).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify({ ...local, sdk: undefined }))).toBeLessThan(MCP_APPS_MAX_REMOTE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(local))).toBeGreaterThan(MCP_APPS_MAX_REMOTE_BYTES);
    const document = await f.host.open('device:phone', 'task', 'card', {});
    expect(document.html).toBe(html);
    expect(document.sdk).toBeUndefined();
    expect(() => encodeReliableFrames(wire(document), 'wire-id', 1)).not.toThrow();
  });

  // Regression: the real operation/Host budget used to discard a warm SDK before
  // reference negotiation. Unit tier: a controlled resource just below the wire
  // cap must hydrate on the viewer; cold/mismatched declarations retain omission.
  it('negotiates a warm SDK reference before applying the large-page wire budget', async () => {
    const f = fixture();
    const cache = new McpAppSdkCache(text => createHash('sha256').update(text).digest('hex'));
    const owner = {};
    const replies: McpAppDocument[] = [];
    const send = async (input: Record<string, unknown>) => {
      const reply = await handleMcpAppOperation(f.host, 'device:phone', 'task', input) as McpAppDocument;
      if (input.op === 'open') replies.push(reply);
      return reply;
    };
    const input = { op: 'open', clientId: 'card', context: {} };
    const small = await cache.open(owner, 'host', input, send, () => {});
    await send({ op: 'teardown', viewId: small.viewId });
    const html = '<script type="module">import "@modelcontextprotocol/ext-apps";</script>' + 'x'.repeat(MCP_APPS_MAX_REMOTE_BYTES - 4096);
    f.resource.mockResolvedValue({ result: f.contents(html) });
    expect(Buffer.byteLength(JSON.stringify({ ...small, html }))).toBeGreaterThan(MCP_APPS_MAX_REMOTE_BYTES);
    const warm = await cache.open(owner, 'host', input, send, () => {});
    expect(replies.at(-1)?.sdkRef).toMatch(/^[a-f0-9]{64}$/);
    expect(replies.at(-1)?.sdk).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(replies.at(-1)))).toBeLessThan(MCP_APPS_MAX_REMOTE_BYTES);
    expect(warm.sdk).toEqual(small.sdk);
    expect(warm.html).toBe(html);
    for (const sdkCacheHashes of [undefined, ['0'.repeat(64)]]) {
      const cold = await send({ ...input, sdkCacheHashes });
      expect(cold.html).toBe(html);
      expect(cold.sdk).toBeUndefined();
      expect(cold.sdkRef).toBeUndefined();
    }
  });

  // Addons must not consume the SDK budget of an otherwise valid installed page.
  it('reuses the reduced SDK on a second boundary-page open without mutating later opens', async () => {
    const f = fixture(); const local = await f.host.open('renderer:local', 'task', 'card', {});
    const base = { ...local, html: '', sdk: { source: local.sdk!.source } };
    const html = 'x'.repeat(MCP_APPS_MAX_REMOTE_BYTES - Buffer.byteLength(JSON.stringify(base)));
    f.resource.mockResolvedValue({ result: f.contents(html) });
    // Real operation/Host/cache regression: the first response fits only without
    // addons; the next must recognize that cached variant (unit tier).
    const cache = new McpAppSdkCache(text => createHash('sha256').update(text).digest('hex'));
    const owner = {};
    let wireDocument!: McpAppDocument;
    const send = async (input: Record<string, unknown>) => {
      wireDocument = await handleMcpAppOperation(f.host, 'device:phone', 'task', input) as McpAppDocument;
      return wireDocument;
    };
    const input = { op: 'open', clientId: 'card', context: {} };
    const remote = await cache.open(owner, 'host', input, send, () => {});
    expect(wireDocument.sdk).toEqual(remote.sdk);
    expect(wireDocument.sdkRef).toBeUndefined();
    expect(remote.sdk).toEqual({ source: local.sdk!.source });
    expect(Buffer.byteLength(JSON.stringify(remote))).toBe(MCP_APPS_MAX_REMOTE_BYTES);
    const second = await cache.open(owner, 'host', input, send, () => {});
    expect(wireDocument.sdkRef).toMatch(/^[a-f0-9]{64}$/);
    expect(wireDocument.sdk).toBeUndefined();
    expect(second.sdk).toEqual(remote.sdk);
    expect(second.html).toBe(html);
    f.resource.mockResolvedValue({ result: f.contents('small') });
    const next = await f.host.open('device:phone', 'task', 'card', {});
    expect(next.sdk?.addons?.['cindy/view-state']).toEqual(local.sdk?.addons?.['cindy/view-state']);
  });

  it('supplies the environment for custom MCP pages without an initial SDK import', async () => {
    const f = fixture();
    f.resource.mockResolvedValue({ result: f.contents('<!doctype html><p>Legacy page</p>') });
    const document = await f.host.open('device:phone', 'task', 'card', {});
    expect(document.sdk?.source).toContain('export');
    expect(document.html).toBe('<!doctype html><p>Legacy page</p>');
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
