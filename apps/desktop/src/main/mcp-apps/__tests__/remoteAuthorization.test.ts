import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '@cindy/maker-core';
import { getLiziMcpSessionContext } from '@cindy/mcps';
import { registerAppServer, clearAppServerConfigs } from '../runtime.js';
import {
  startCodexHttpBridge,
  selectRemoteInjectableServerNames,
  type CodexHttpBridge,
} from '../../mcp-integrations/codexHttpBridge.js';
import { CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY } from '../../mcp-integrations/codexBuiltinToolPolicy.js';
let bridge: CodexHttpBridge | undefined;
const receivedNotification = vi.fn();
const log = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return this;
  },
} as Logger;
function server() {
  const server = new McpServer({ name: 'example', version: '1' });
  server.server.fallbackNotificationHandler = async (notification) => {
    receivedNotification(notification, getLiziMcpSessionContext()?.sessionInstanceId);
  };
  server.tool('context', {}, async () => ({
    content: [{ type: 'text', text: getLiziMcpSessionContext()?.sessionInstanceId ?? 'unbound' }],
  }));
  return server;
}
const createAppServer = vi.fn(server);
afterEach(async () => {
  clearAppServerConfigs();
  await bridge?.shutdown();
  bridge = undefined;
  receivedNotification.mockClear();
  createAppServer.mockClear();
});
const headers = {
  authorization: 'Bearer invalid-test-only-remote-token',
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
};
async function fixture(vendorOptions: Record<string, unknown> = {}) {
  for (const id of ['example', 'not-mounted'])
    registerAppServer(id, () => ({ id, url: 'http://127.0.0.1:1/mcp', transport: 'http' }));
  bridge = await startCodexHttpBridge({
    serverFactories: { example: createAppServer, 'not-mounted': server, cindy_ssh: server },
    appServerNames: ['example'],
    additionalBearerTokens: () => ['invalid-test-only-remote-token'],
    logger: log,
  });
  const setPolicy = (vendorOptions: Record<string, unknown>) => bridge!.registerSessionCtx('task', {
    agentKind: 'claude-code',
    sessionId: 'task',
    sessionInstanceId: 'instance',
    workingDir: '/remote',
    remoteHostId: 'host',
    vendorOptions,
  });
  setPolicy(vendorOptions);
  const base = bridge.url('example');
  const bound = base + '?session=task&instance=instance';
  const init = await fetch(bound, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    }),
  });
  expect(init.status).toBe(200);
  const id = init.headers.get('mcp-session-id')!;
  await init.text();
  const request = async (url: string, body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': id },
      body: JSON.stringify(body),
    });
  return { base, bound, request, setPolicy };
}
const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
const call = {
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'context', arguments: {} },
};
describe('MCP Apps over the existing remote bridge', () => {
  it('permits the configured custom server only with the actual Session instance', async () => {
    const f = await fixture();
    const reply = await f.request(f.bound, call);
    expect(reply.status).toBe(200);
    expect(await reply.text()).toContain('instance');
    for (const url of [f.base, f.base + '?session=task', f.base + '?session=task&instance=stale']) {
      const denied = await f.request(url, call);
      expect(denied.status).toBe(401);
      await denied.text();
    }
  });
  it('rejects unbound discovery, resource access and a batch containing execution', async () => {
    const f = await fixture();
    const discovery = await f.request(f.base, list);
    expect(discovery.status).toBe(401);
    await discovery.text();
    for (const body of [
      { jsonrpc: '2.0', id: 5, method: 'resources/read', params: { uri: 'ui://example/app' } },
      [list, call],
    ]) {
      const denied = await f.request(f.base, body);
      expect(denied.status).toBe(401);
      await denied.text();
    }
  });
  it('requires a Session for standard and extension notifications, including mixed batches', async () => {
    const f = await fixture();
    const notifications = [
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 'test', progress: 1 } },
      { jsonrpc: '2.0', method: 'example/side-effect', params: { value: 'test' } },
    ];
    for (const body of [...notifications, [list, notifications[2]]]) {
      const denied = await f.request(f.base, body);
      expect(denied.status).toBe(401);
      await denied.text();
    }
    expect(receivedNotification).not.toHaveBeenCalled();
  });
  it('requires a bound route for the initialization notification as well', async () => {
    const f = await fixture();
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
    const unbound = await f.request(f.base, initialized);
    expect(unbound.status).toBe(401);
    await unbound.text();
    const allowed = await f.request(f.bound, initialized);
    expect(allowed.status).toBe(202);
    await allowed.text();
    // A method name alone must not turn a request into a handshake exemption.
    const denied = await f.request(f.base, { ...initialized, id: 4 });
    expect(denied.status).toBe(401);
    await denied.text();
  });
  it('forwards a notification with the verified Session context and rejects revoked routes', async () => {
    const f = await fixture();
    const notification = { jsonrpc: '2.0', method: 'example/side-effect', params: { value: 'test' } };
    const allowed = await f.request(f.bound, notification);
    expect(allowed.status).toBe(202);
    await allowed.text();
    await vi.waitFor(() => expect(receivedNotification).toHaveBeenCalledWith(notification, 'instance'));
    receivedNotification.mockClear();
    for (const url of [f.base + '?session=task', f.base + '?session=task&instance=stale']) {
      const denied = await f.request(url, notification);
      expect(denied.status).toBe(401);
      await denied.text();
    }
    bridge!.unregisterSessionCtx('task');
    const revoked = await f.request(f.bound, notification);
    expect(revoked.status).toBe(401);
    await revoked.text();
    expect(receivedNotification).not.toHaveBeenCalled();
  });
  it('enforces the frozen custom-server mount for notifications as well', async () => {
    const f = await fixture();
    f.setPolicy({
      [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [],
      cindyRuntimeMcpServerNames: [],
    });
    const notification = { jsonrpc: '2.0', method: 'example/side-effect' };
    const denied = await f.request(f.bound, notification);
    expect(denied.status).toBe(403);
    await denied.text();
    expect(receivedNotification).not.toHaveBeenCalled();
  });
  it('never exposes unrelated local servers or a custom server absent from this bridge', async () => {
    const f = await fixture();
    for (const name of ['not-mounted', 'cindy_ssh']) {
      const denied = await f.request(bridge!.url(name), list);
      expect(denied.status).toBe(403);
      await denied.text();
    }
    clearAppServerConfigs();
    const revoked = await f.request(f.bound, call);
    expect(revoked.status).toBe(403);
    await revoked.text();
  });
  it('applies frozen Bot policy to discovery and execution together', async () => {
    const f = await fixture();
    f.setPolicy({
      [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [],
      cindyRuntimeMcpServerNames: [],
    });
    for (const body of [list, call]) {
      const denied = await f.request(f.bound, body);
      expect(denied.status).toBe(403);
      await denied.text();
    }
    bridge!.registerSessionCtx('task', {
      agentKind: 'claude-code',
      sessionId: 'task',
      sessionInstanceId: 'instance',
      workingDir: '/remote',
      remoteHostId: 'host',
      vendorOptions: {
        [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [],
        cindyRuntimeMcpServerNames: ['example'],
      },
    });
    for (const body of [list, call]) {
      const allowed = await f.request(f.bound, body);
      expect(allowed.status).toBe(200);
      await allowed.text();
    }
  });
  it.each(['?session=task', '?session=task&instance=instance'])(
    'rejects scoped Bot initialization before creating an excluded facade: %s',
    async (query) => {
      const f = await fixture();
      f.setPolicy({
        [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [],
        cindyRuntimeMcpServerNames: [],
      });
      const created = createAppServer.mock.calls.length;
      const initialize = {
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      };
      const denied = await fetch(f.base + query, { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(denied.status).toBe(403);
      expect(await denied.text()).toBe('MCP server is not mounted for this Session');
      expect(createAppServer).toHaveBeenCalledTimes(created);
      f.setPolicy({
        [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [],
        cindyRuntimeMcpServerNames: ['example'],
      });
      const allowed = await fetch(f.base + query, { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(allowed.status).toBe(200);
      await allowed.text();
      expect(createAppServer).toHaveBeenCalledTimes(created + 1);
    },
  );
  it('does not create a credentialed facade for a process-wide remote App URL', async () => {
    const f = await fixture();
    const created = createAppServer.mock.calls.length;
    const response = await fetch(f.base, {
      method: 'POST', headers, body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      }),
    });
    expect(response.status).toBe(401);
    await response.text();
    expect(createAppServer).toHaveBeenCalledTimes(created);
  });
  it('enforces the same mount boundary for local Codex primary-token discovery and execution', async () => {
    const f = await fixture();
    const localHeaders = { ...headers, authorization: `Bearer ${bridge!.token}` };
    const url = f.base + '?instance=local-instance';
    const context = {
      agentKind: 'codex' as const, sessionId: 'local-task', sessionInstanceId: 'local-instance',
      workingDir: '/local',
      vendorOptions: { [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [], cindyRuntimeMcpServerNames: [] as string[] },
    };
    const initialize = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    };
    const created = createAppServer.mock.calls.length;
    const unbound = await fetch(f.base, { method: 'POST', headers: localHeaders, body: JSON.stringify(initialize) });
    expect(unbound.status).toBe(401);
    await unbound.text();
    await bridge!.withDiscoveryContext(context, async () => {
      const excluded = await fetch(url, { method: 'POST', headers: localHeaders, body: JSON.stringify(initialize) });
      expect(excluded.status).toBe(403);
      await excluded.text();
    });
    expect(createAppServer).toHaveBeenCalledTimes(created);
    context.vendorOptions.cindyRuntimeMcpServerNames = ['example'];
    let id = '';
    const request = async (body: unknown) => fetch(url, {
      method: 'POST', headers: { ...localHeaders, 'mcp-session-id': id }, body: JSON.stringify(body),
    });
    await bridge!.withDiscoveryContext(context, async () => {
      const response = await fetch(url, { method: 'POST', headers: localHeaders, body: JSON.stringify(initialize) });
      expect(response.status).toBe(200);
      id = response.headers.get('mcp-session-id')!;
      await response.text();
      const listed = await request(list);
      expect(listed.status).toBe(200);
      await listed.text();
      const premature = await request(call);
      expect(premature.status).toBe(401);
      await premature.text();
    });
    bridge!.registerThreadContext('local-thread', context);
    const called = await request(call);
    expect(called.status).toBe(200);
    expect(await called.text()).toContain('local-instance');
    context.vendorOptions.cindyRuntimeMcpServerNames = [];
    for (const body of [list, call]) {
      const excluded = await request(body);
      expect(excluded.status).toBe(403);
      await excluded.text();
    }
  });
  it('binds remote Codex startup discovery to its frozen Session and revokes the lease', async () => {
    const f = await fixture();
    const url = f.base + '?instance=codex-instance';
    const context = {
      agentKind: 'codex' as const, sessionId: 'codex-task', sessionInstanceId: 'codex-instance',
      workingDir: '/remote', remoteHostId: 'host',
      vendorOptions: { [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: [], cindyRuntimeMcpServerNames: [] as string[] },
    };
    const initialize = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    };
    const created = createAppServer.mock.calls.length;
    await bridge!.withDiscoveryContext(context, async () => {
      const denied = await fetch(url, { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(denied.status).toBe(403);
      await denied.text();
      expect(createAppServer).toHaveBeenCalledTimes(created);
    });
    context.vendorOptions.cindyRuntimeMcpServerNames = ['example'];
    let id = '';
    const request = async (body: unknown) => fetch(url, {
      method: 'POST', headers: { ...headers, 'mcp-session-id': id }, body: JSON.stringify(body),
    });
    await bridge!.withDiscoveryContext(context, async () => {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(initialize) });
      expect(response.status).toBe(200);
      id = response.headers.get('mcp-session-id')!;
      await response.text();
      const discovery = await request(list);
      expect(discovery.status).toBe(200);
      expect(await discovery.text()).toContain('context');
      const execution = await request(call);
      expect(execution.status).toBe(401);
      await execution.text();
    });
    const expired = await request(list);
    expect(expired.status).toBe(401);
    await expired.text();
    bridge!.registerThreadContext('codex-thread', context);
    const execution = await request(call);
    expect(execution.status).toBe(200);
    expect(await execution.text()).toContain('codex-instance');
    bridge!.unregisterThreadContext('codex-thread', 'codex-instance');
    const revoked = await request(list);
    expect(revoked.status).toBe(401);
    await revoked.text();
  });
  it('keeps injection inside both the configured and frozen custom-server sets', async () => {
    await fixture();
    const gates = { collabEnabled: false, memoryEnabled: false };
    expect(selectRemoteInjectableServerNames(['example', 'cindy_ssh'], gates)).toEqual(['example']);
    expect(
      selectRemoteInjectableServerNames(['example'], { ...gates, appServerNames: [] }),
    ).toEqual([]);
    expect(
      selectRemoteInjectableServerNames(['example'], { ...gates, appServerNames: ['example'] }),
    ).toEqual(['example']);
  });
});
