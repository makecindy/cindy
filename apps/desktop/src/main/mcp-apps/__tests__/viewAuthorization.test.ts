import { createAppMessageSender } from '../messageSender.js';
import { queuedAppMessageGuard } from '../message.js';
import type { AgentInputQueuedMessage } from '../../../shared/agentInputQueue.js';
import type { McpAppsHostDeps } from '../host.js';
import { GhostPickSlot } from '../../cindy-brain/pickSlot.js';
import { GhostPipeDispatcher } from '../../cindy-brain/pipeDispatcher.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { JSONRPCMessage, Notification } from '@modelcontextprotocol/sdk/types.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import { AppConnection, type AppServerConfig } from '../connection.js';
import { McpAppsHost, appServerRevision } from '../host.js';
import { handleMcpAppFrameOperation, handleMcpAppOperation } from '../operations.js';

const hosts: McpAppsHost[] = [];

// Plugin pages cannot widen the approved network grant. Existing view tests
// cover custom MCP only; minimal input is one undeclared CSP origin. Tier: unit.
it.each([true, false])('enforces plugin CSP subset and revokes opened Views (declared=%s)', async declared => {
  const config: AppServerConfig = { id: 'plugin_fixture', url: '', transport: 'in-process', plugin: {
    instance: 'fixture', revision: 'one', packageSha256: 'hash', directory: '/fixture',
    title: 'Fixture', trust: 'unverified', domains: ['https://allowed.example'],
    assertCurrent() {}, createTransport() { throw new Error('unused transport'); },
  } };
  const connection = new AppConnection(config);
  vi.spyOn(connection, 'getClient').mockResolvedValue({ getServerCapabilities: () => ({}) } as never);
  vi.spyOn(connection, 'tools').mockResolvedValue([tool]);
  vi.spyOn(connection, 'resource').mockResolvedValue({ result: { contents: [{
    uri: 'ui://form', mimeType: 'text/html;profile=mcp-app', text: '<html>fixture</html>',
    _meta: { ui: { csp: { connectDomains: [declared ? 'https://allowed.example' : 'https://blocked.example'] } } },
  }] } });
  const owner = {};
  const host = new McpAppsHost({ owner: () => owner, config: () => config, connection: () => connection,
    readCard: async () => ({ version: 1, serverId: config.id, serverRevision: appServerRevision(config), resourceUri: 'ui://form', tool, arguments: {}, result: { content: [] } }),
    writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {},
  });
  hosts.push(host);
  if (!declared) await expect(host.open('renderer:1', 'task', 'card', {})).rejects.toThrow('MCP_PLUGIN_CSP_DOMAIN_NOT_DECLARED');
  else {
    const document = await host.open('renderer:1', 'task', 'card', {});
    const exited = deferred<void>();
    const originalClose = connection.close.bind(connection);
    vi.spyOn(connection, 'close').mockImplementation(async () => { await exited.promise; await originalClose(); });
    const disabled = host.revokePluginServers(new Set([config.id]));
    let uninstalled = false;
    const uninstalling = host.revokePluginConnections('fixture').then(() => { uninstalled = true; });
    await Promise.resolve(); expect(uninstalled).toBe(false);
    exited.resolve(); await Promise.all([disabled, uninstalling]);
    expect(uninstalled).toBe(true);
    await expect(host.poll('renderer:1', 'task', document.viewId, 0)).rejects.toThrow();
    expect(connection.isClosed).toBe(true);
  }
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.reset()));
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const marker = 'private-upstream-result';
const tool = {
  name: 'form',
  description: marker,
  inputSchema: { type: 'object' as const },
  _meta: { ui: { resourceUri: 'ui://form' } },
};
const requests = [
  [
    'tools/call',
    { name: tool.name, arguments: {} },
    'callTool',
    { content: [{ type: 'text', text: marker }] },
  ],
  ['tools/list', {}, 'tools', [tool]],
  [
    'resources/read',
    { uri: 'data://private' },
    'readResource',
    { contents: [{ uri: 'data://private', text: marker }] },
  ],
  ['resources/list', {}, 'listResources', { resources: [{ name: marker, uri: 'data://private' }] }],
  [
    'resources/templates/list',
    {},
    'listResourceTemplates',
    { resourceTemplates: [{ name: marker, uriTemplate: 'data://{id}' }] },
  ],
  ['prompts/list', {}, 'listPrompts', { prompts: [{ name: marker }] }],
] as const;

async function fixture(caller = 'renderer:1', plugin = false, html = '<p>Form</p>', options: { uninitialized?: boolean; pendingTool?: boolean; sendMessage?: McpAppsHostDeps['sendMessage']; attachments?: boolean } = {}) {
  let owner = {};
  let enabled = true;
  let visible = true;
  const config: AppServerConfig = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http',
    ...(plugin ? { plugin: { instance: 'fixture', revision: 'one', packageSha256: 'hash', directory: '/fixture', title: 'Fixture',
      trust: 'unverified', domains: [], assertCurrent() {}, createTransport() { throw new Error('unused'); } } } : {}),
  };
  const card: McpAppRecord = {
    version: 1,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: 'ui://form',
    tool,
    arguments: {},
  };
  if (options.attachments) card.tool = { ...tool, _meta: { ...tool._meta, 'cindy/attachments': [{ type: 'resource_link', uri: 'library:fixture.txt', name: 'fixture' }] } };
  const methods = {
    callTool: vi.fn(),
    tools: vi.fn(async () => [tool]),
    readResource: vi.fn(),
    listResources: vi.fn(),
    listResourceTemplates: vi.fn(),
    listPrompts: vi.fn(),
  };
  let notify!: (message: Notification) => void;
  const connection = {
    getClient: async () => ({
      ...methods,
      getServerCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
    }),
    tools: methods.tools,
    resource: async () => ({
      result: {
        contents: [
          { uri: card.resourceUri, mimeType: 'text/html;profile=mcp-app', text: html },
        ],
      },
    }),
    listen: (listener: typeof notify) => {
      notify = listener;
      return () => {};
    },
    close: vi.fn(async () => {}),
  } as unknown as AppConnection;
  const outgoing: JSONRPCMessage[] = [];
  const connect = AppBridge.prototype.connect;
  vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(function (
    this: AppBridge,
    transport,
  ) {
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      outgoing.push(message);
      await send(message, options);
    };
    return connect.call(this, transport);
  });
  // These cases exercise request completion, not the separate bounded teardown handshake.
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  const authorizeTool = vi.fn<import('../host.js').McpAppsHostDeps['authorizeTool']>(async () => {});
  const readCard = vi.fn(async () => {
    if (!visible) throw new Error('MCP_APP_CARD_UNAVAILABLE');
    return card;
  });
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => (enabled ? config : undefined),
    readCard,
    writeCard: async () => {},
    authorizeTool,
    sendMessage: options.sendMessage ?? (async () => {}),
    ...(options.attachments ? { pluginFiles: { describe: async () => ({ mimeType: 'text/plain', size: 1 }), read: async () => new Response('x') } } : {}),
    connection: () => connection,
  });
  hosts.push(host);
  if (options.pendingTool) card.connectionId = host.registerConnection(connection);
  const document = await host.open(caller, 'task', 'card', {});
  const dispatch = (message: JSONRPCMessage) =>
    host.dispatch(caller, 'task', document.viewId, message);
  if (!options.uninitialized) {
    await dispatch({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'Authorization fixture', version: '1' },
        appCapabilities: {},
      },
    });
    await vi.waitFor(() =>
      expect(outgoing).toContainEqual(expect.objectContaining({ id: 1, result: expect.anything() })),
    );
    await dispatch({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    await vi.waitFor(() =>
      expect(outgoing).toContainEqual(
        expect.objectContaining({ method: 'ui/notifications/tool-input' }),
      ),
    );
    outgoing.length = 0;
  }
  return {
    host,
    document,
    viewId: document.viewId,
    readCard,
    poll: (after: number) => host.poll(caller, 'task', document.viewId, after),
    notify: () => notify({ method: 'notifications/tools/list_changed' }),
    methods,
    outgoing,
    dispatch,
    config,
    authorizeTool,
    revoke(kind: 'card' | 'owner' | 'server' | 'config') {
      if (kind === 'card') visible = false;
      if (kind === 'owner') owner = {};
      if (kind === 'server') enabled = false;
      if (kind === 'config') config.url = 'https://changed.example.invalid';
    },
  };
}

describe('MCP App upstream result authorization', () => {
  async function returnedLink(f: Awaited<ReturnType<typeof fixture>>) {
    const initial = await f.poll(0);
    await f.dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'ui/open-link',
      params: { url: 'https://example.invalid/' },
    });
    const events = await f.poll(initial.at(-1)!.seq);
    const link = events.find((event) => event.openLink)?.openLink;
    expect(link).toEqual({ id: expect.any(String), url: 'https://example.invalid/' });
    return { op: 'open-link', url: link!.url, linkId: link!.id };
  }

  it.each(['card', 'owner', 'server', 'config'] as const)(
    'rejects remote link authorization after %s revocation following a returned poll',
    async (revocation) => {
      const f = await fixture('device:phone');
      const link = await returnedLink(f);
      f.revoke(revocation);
      await expect(
        handleMcpAppOperation(f.host, 'device:phone', 'task', {
          op: 'authorize-link',
          viewId: f.viewId,
          linkId: link.linkId,
        }),
      ).rejects.toThrow(/MCP_APP_(CARD_UNAVAILABLE|VIEW_UNAVAILABLE|SERVER_CHANGED)/);
    },
  );

  it('authorizes only the active link bound to the exact remote caller and task', async () => {
    const f = await fixture('device:phone');
    const link = await returnedLink(f);
    const input = { op: 'authorize-link', viewId: f.viewId, linkId: link.linkId };
    for (const [caller, task] of [
      ['device:other', 'task'],
      ['device:phone', 'other-task'],
    ])
      await expect(handleMcpAppOperation(f.host, caller, task, input)).rejects.toThrow(
        'MCP_APP_VIEW_UNAVAILABLE',
      );
    await expect(
      handleMcpAppOperation(f.host, 'device:phone', 'task', {
        ...input,
        linkId: 'unknown-link',
      }),
    ).rejects.toThrow('MCP_APP_LINK_UNAVAILABLE');
    await expect(handleMcpAppOperation(f.host, 'device:phone', 'task', input)).resolves.toEqual({
      authorized: true,
      validForMs: 30_000,
    });
    f.host.linkResult('device:phone', 'task', f.viewId, link.linkId, false);
    await expect(handleMcpAppOperation(f.host, 'device:phone', 'task', input)).rejects.toThrow(
      'MCP_APP_LINK_UNAVAILABLE',
    );
  });

  it('rechecks the remote View when its owner changes during final link authorization', async () => {
    const f = await fixture('device:phone');
    const link = await returnedLink(f);
    const current = await f.readCard();
    const pending = deferred<McpAppRecord>();
    f.readCard.mockClear().mockReturnValueOnce(pending.promise);
    const rejected = expect(
      handleMcpAppOperation(f.host, 'device:phone', 'task', {
        op: 'authorize-link',
        viewId: f.viewId,
        linkId: link.linkId,
      }),
    ).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
    await vi.waitFor(() => expect(f.readCard).toHaveBeenCalledOnce());
    f.revoke('owner');
    pending.resolve(current);
    await rejected;
  });

  it('opens a returned link when its bound View and card remain current', async () => {
    const f = await fixture();
    const input = await returnedLink(f);
    const openLink = vi.fn(async () => {});
    await expect(
      handleMcpAppFrameOperation(
        f.host,
        'renderer:1',
        'task',
        f.viewId,
        { ...input, viewId: 'forged-view', sessionId: 'forged-task' },
        openLink,
      ),
    ).resolves.toEqual({});
    expect(openLink).toHaveBeenCalledExactlyOnceWith(input.url);
  });

  it.each([
    { linkId: undefined },
    { linkId: 'unknown-link' },
    { url: 'https://another.example.invalid/' },
  ])('does not open a link with a missing or mismatched pending request: %j', async (patch) => {
    const f = await fixture();
    const input = await returnedLink(f);
    const openLink = vi.fn(async () => {});
    await expect(
      handleMcpAppFrameOperation(f.host, 'renderer:1', 'task', f.viewId, { ...input, ...patch }, openLink),
    ).rejects.toThrow(/MCP_APP_(INVALID_LINK|LINK_UNAVAILABLE)/);
    expect(openLink).not.toHaveBeenCalled();
  });

  it('does not replay a completed link request', async () => {
    const f = await fixture();
    const input = await returnedLink(f);
    f.host.linkResult('renderer:1', 'task', f.viewId, input.linkId, false);
    const openLink = vi.fn(async () => {});
    await expect(
      handleMcpAppFrameOperation(f.host, 'renderer:1', 'task', f.viewId, input, openLink),
    ).rejects.toThrow('MCP_APP_LINK_UNAVAILABLE');
    expect(openLink).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'] as const)('does not open a link that expires %s final authorization', async (when) => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const input = await returnedLink(f);
    const current = await f.readCard();
    const pending = deferred<McpAppRecord>();
    const openLink = vi.fn(async () => {});
    if (when === 'before') await vi.advanceTimersByTimeAsync(10_001);
    else f.readCard.mockClear().mockReturnValueOnce(pending.promise);
    const rejected = expect(
      handleMcpAppFrameOperation(f.host, 'renderer:1', 'task', f.viewId, input, openLink),
    ).rejects.toThrow('MCP_APP_LINK_UNAVAILABLE');
    if (when === 'during') {
      expect(f.readCard).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      pending.resolve(current);
    }
    await rejected;
    expect(openLink).not.toHaveBeenCalled();
  });

  it.each(['card', 'owner', 'server', 'config'] as const)(
    'does not open a returned link after %s revocation',
    async (revocation) => {
      const f = await fixture();
      const input = await returnedLink(f);
      f.revoke(revocation);
      const openLink = vi.fn(async () => {});
      await expect(
        handleMcpAppFrameOperation(f.host, 'renderer:1', 'task', f.viewId, input, openLink),
      ).rejects.toThrow(/MCP_APP_(CARD_UNAVAILABLE|VIEW_UNAVAILABLE|SERVER_CHANGED)/);
      expect(openLink).not.toHaveBeenCalled();
    },
  );

  it('does not open a returned link after its View is released', async () => {
    const f = await fixture();
    const input = await returnedLink(f);
    await f.host.releaseCaller('renderer:1');
    const openLink = vi.fn(async () => {});
    await expect(
      handleMcpAppFrameOperation(f.host, 'renderer:1', 'task', f.viewId, input, openLink),
    ).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
    expect(openLink).not.toHaveBeenCalled();
  });

  it.each(['owner', 'server', 'config'] as const)(
    'does not open a returned link after %s revocation during the card check',
    async (revocation) => {
      const f = await fixture();
      const input = await returnedLink(f);
      const current = await f.readCard();
      const pending = deferred<McpAppRecord>();
      f.readCard.mockClear().mockReturnValueOnce(pending.promise);
      const openLink = vi.fn(async () => {});
      const rejected = expect(
        handleMcpAppFrameOperation(f.host, 'renderer:1', 'task', f.viewId, input, openLink),
      ).rejects.toThrow(/MCP_APP_(VIEW_UNAVAILABLE|SERVER_CHANGED)/);
      await vi.waitFor(() => expect(f.readCard).toHaveBeenCalledOnce());
      f.revoke(revocation);
      pending.resolve(current);
      await rejected;
      expect(openLink).not.toHaveBeenCalled();
    },
  );

  it('discards a queued open-link event after its card is revoked', async () => {
    const f = await fixture();
    const initial = await f.poll(0);
    const after = initial.at(-1)!.seq;
    await f.dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'ui/open-link',
      params: { url: 'https://example.invalid/' },
    });
    const queued = await f.poll(after);
    expect(queued).toContainEqual(
      expect.objectContaining({
        openLink: { id: expect.any(String), url: 'https://example.invalid/' },
      }),
    );
    f.revoke('card');
    await expect(f.poll(after)).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
  });

  it('discards a notification arriving during a poll after its card is revoked', async () => {
    const f = await fixture();
    const initial = await f.poll(0);
    const after = initial.at(-1)!.seq;
    const rejected = expect(f.poll(after)).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.revoke('card');
    f.notify();
    await rejected;
  });

  it('delivers a notification arriving during a poll while its card remains current', async () => {
    const f = await fixture();
    const initial = await f.poll(0);
    const pending = f.poll(initial.at(-1)!.seq);
    f.notify();
    await expect(pending).resolves.toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ method: 'notifications/tools/list_changed' }),
      }),
    );
  });

  it.each(['card', 'owner', 'server', 'config'] as const)(
    'does not request tool approval after %s revocation during tool discovery',
    async (revocation) => {
      const f = await fixture();
      const pending = deferred<Array<typeof tool>>();
      f.methods.tools.mockClear().mockReturnValueOnce(pending.promise);
      await f.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: requests[0][1] });
      await vi.waitFor(() => expect(f.methods.tools).toHaveBeenCalledOnce());
      f.revoke(revocation);
      pending.resolve([tool]);
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual(
        expect.objectContaining({ id: 2, error: expect.anything() }),
      );
      expect(f.authorizeTool).not.toHaveBeenCalled();
      expect(f.methods.callTool).not.toHaveBeenCalled();
      expect(f.methods.tools).toHaveBeenCalledOnce();
    },
  );

  it('requests approval once after slow tool discovery when the View remains current', async () => {
    const f = await fixture();
    const pending = deferred<Array<typeof tool>>();
    f.methods.tools.mockClear().mockReturnValueOnce(pending.promise);
    f.methods.callTool.mockResolvedValueOnce(requests[0][3]);
    await f.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: requests[0][1] });
    await vi.waitFor(() => expect(f.methods.tools).toHaveBeenCalledOnce());
    expect(f.authorizeTool).not.toHaveBeenCalled();
    pending.resolve([tool]);
    await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
    expect(f.outgoing).toContainEqual({ jsonrpc: '2.0', id: 2, result: requests[0][3] });
    expect(f.authorizeTool).toHaveBeenCalledExactlyOnceWith(
      'task',
      tool,
      {},
      expect.any(AbortSignal),
      { clientId: 'card', serverId: 'example', title: tool.name },
    );
    expect(f.methods.callTool).toHaveBeenCalledOnce();
    expect(f.methods.tools).toHaveBeenCalledOnce();
  });

  it.each(['card', 'owner', 'server', 'config'] as const)(
    'discards a completed App tool result after %s revocation without replaying it',
    async (revocation) => {
      const f = await fixture();
      const pending = deferred<unknown>();
      f.methods.callTool.mockReturnValueOnce(pending.promise);
      await f.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: requests[0][1] });
      await vi.waitFor(() => expect(f.methods.callTool).toHaveBeenCalledOnce());
      f.revoke(revocation);
      pending.resolve(requests[0][3]);
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual(
        expect.objectContaining({ id: 2, error: expect.anything() }),
      );
      expect(JSON.stringify(f.outgoing)).not.toContain(marker);
      expect(f.methods.callTool).toHaveBeenCalledOnce();
    },
  );

  it.each(requests.slice(1))(
    'discards %s results if the card is revoked while awaiting the server',
    async (method, params, upstream, result) => {
      const f = await fixture();
      const pending = deferred<unknown>();
      const operation = f.methods[upstream];
      operation.mockReturnValueOnce(pending.promise as never);
      operation.mockClear();
      await f.dispatch({ jsonrpc: '2.0', id: 2, method, params });
      await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
      f.revoke('card');
      pending.resolve(result);
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual(
        expect.objectContaining({ id: 2, error: expect.anything() }),
      );
      expect(JSON.stringify(f.outgoing)).not.toContain(marker);
      expect(operation).toHaveBeenCalledOnce();
    },
  );

  it.each(requests)(
    'delivers %s results once when the View remains authorized',
    async (method, params, upstream, result) => {
      const f = await fixture();
      const operation = f.methods[upstream];
      operation.mockResolvedValueOnce(result as never);
      operation.mockClear();
      await f.dispatch({ jsonrpc: '2.0', id: 2, method, params });
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual({
        jsonrpc: '2.0',
        id: 2,
        result: upstream === 'tools' ? { tools: result } : result,
      });
      expect(operation).toHaveBeenCalledOnce();
    },
  );
});

// Real in-process server behind the real View handler: approval must finish before
// a one-use page credential reaches main.js. Existing mocks cannot observe this boundary.
it('approves a plugin page call before binding its card and task in Main', async () => {
  const { createPluginAppTransport, pluginAppTool } = await import('../pluginServer.js');
  const calls: string[] = [];
  const tools = [{ name: 'open', description: 'Open' }, { name: 'save', description: 'Save' }];
  const ui = { resources: [{
            uri: "ui://form",
            file: 'ui/form.html'
        }], tools: { open: { resourceUri: "ui://form" }, save: { visibility: ['app' as const] } } };
  const config: AppServerConfig = { id: 'plugin-gate', url: '', transport: 'in-process', plugin: {
    instance: 'plugin', revision: 'approved', packageSha256: 'hash', directory: '/fixture', title: 'Plugin', trust: 'unverified', domains: [], assertCurrent() {},
    createTransport: () => createPluginAppTransport({ instance: 'plugin', revision: 'approved', tools, ui, assertCurrent() {}, readHtml: () => '<html>Form</html>',
      call: async grant => { calls.push(`${grant.sessionId}/${grant.clientId}/${grant.tool}`); return { content: [{ type: 'text', text: 'saved' }] }; } }),
  } };
  const owner = {}, connection = new AppConnection(config), target = pluginAppTool('plugin', tools[0], ui);
  const authorize = vi.fn(async () => {});
  const host = new McpAppsHost({ owner: () => owner, config: () => config, connection: () => connection,
    readCard: async () => ({ version: 1, serverId: config.id, serverRevision: appServerRevision(config), resourceUri: 'ui://form', tool: target, arguments: {} }),
    writeCard: async () => {}, sendMessage: async () => {}, authorizeTool: authorize,
  }); hosts.push(host);
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  const doc = await host.open('renderer:1', 'task-a', 'card-a', {});
  const dispatch = (message: JSONRPCMessage) => host.dispatch('renderer:1', 'task-a', doc.viewId, message);
  const response = async (id: number) => {
    let value: unknown;
    await vi.waitFor(async () => {
      const poll = await host.poll('renderer:1', 'task-a', doc.viewId, 0);
      value = poll.map(event => event.message).find(message => message && 'id' in message && message.id === id);
      expect(value).toBeDefined();
    });
    return value;
  };
  await dispatch({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'App', version: '1' }, appCapabilities: {} } });
  await response(1);
  await dispatch({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'save' } });
  expect(await response(2)).toMatchObject({ result: { content: [{ text: 'saved' }] } });
  expect(authorize).toHaveBeenCalledOnce();
  expect(calls).toEqual(['task-a/card-a/save']);
});

// unit: device-link cannot serve execution-computer-only files. Minimal failures:
// an existing result link at open, or one tools/call returning such a link later.
// Chat file handoff references are execution-computer files too (card attachments).
it.each(['initial', 'tool-result', 'standard', 'handoff'] as const)('degrades only remote plugin files (%s)', async stage => {
  const { createPluginAppTransport, pluginAppTool } = await import('../pluginServer.js');
  const tools = [{ name: 'open', description: 'Open' }];
  const ui = { resources: [{
            uri: "ui://form",
            file: 'ui/form.html'
        }], tools: { open: { resourceUri: "ui://form" } } };
  const content = [{ type: 'resource_link' as const, name: 'photo.png', uri: stage === 'standard' ? 'https://example.com/photo.png' : 'library:photo.png' }];
  const handoff = { type: 'resource_link' as const, name: 'a.csv', uri: 'handoff:00000000-0000-4000-8000-000000000000' };
  const config: AppServerConfig = { id: 'plugin-files', url: '', transport: 'in-process', plugin: {
    instance: 'plugin', revision: 'approved', packageSha256: 'hash', directory: '/fixture', title: 'Plugin', trust: 'unverified', domains: [], assertCurrent() {},
    createTransport: () => createPluginAppTransport({ instance: 'plugin', revision: 'approved', tools, ui, assertCurrent() {}, readHtml: () => '<p>Page</p>', call: async () => ({ content }) }),
  } };
  const owner = {}, connection = new AppConnection(config), target = pluginAppTool('plugin', tools[0], ui);
  const host = new McpAppsHost({ owner: () => owner, config: () => config, connection: () => connection,
    readCard: async () => ({ version: 1, serverId: config.id, serverRevision: appServerRevision(config), resourceUri: 'ui://form',
      tool: stage === 'handoff' ? { ...target, _meta: { ...target._meta, 'cindy/attachments': [handoff] } } : target,
      arguments: {}, ...(stage === 'initial' ? { result: { content } } : {}) }),
    writeCard: async () => {}, sendMessage: async () => {}, authorizeTool: async () => {},
  }); hosts.push(host);
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  if (stage === 'initial' || stage === 'handoff') {
    await expect(host.open('device:phone', 'task', 'card', {})).rejects.toThrow('MCP_APP_FILES_LOCAL_ONLY');
    return;
  }
  const doc = await host.open('device:phone', 'task', 'card', {});
  const dispatch = (message: JSONRPCMessage) => host.dispatch('device:phone', 'task', doc.viewId, message);
  await dispatch({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'App', version: '1' }, appCapabilities: {} } });
  await host.poll('device:phone', 'task', doc.viewId, 0);
  await dispatch({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'open' } });
  if (stage === 'tool-result') await vi.waitFor(async () => {
    await expect(host.poll('device:phone', 'task', doc.viewId, 0)).rejects.toThrow('MCP_APP_FILES_LOCAL_ONLY');
  });
  else await vi.waitFor(async () => {
    const events = await host.poll('device:phone', 'task', doc.viewId, 0);
    expect(events.some(e => e.message && 'id' in e.message && e.message.id === 2 && 'result' in e.message)).toBe(true);
  });
});

// Tier: unit. Native pick can outlive the SDK default 60s. Existing fast calls
// could not expose this. Use the real Host, AppConnection and plugin MCP server;
// minimum input: one pending page tools/call at 61s, then success or View teardown.
it.each(['complete', 'unmount'] as const)('keeps plugin page calls alive past 60s and handles %s', async ending => {
  const { createPluginAppTransport, pluginAppTool } = await import('../pluginServer.js');
  const waiting = deferred<string[]>();
  const started = deferred<AbortSignal>();
  const ghost = { manifest: { schemaVersion: 3, id: 'pick-lifetime', name: 'Picker', version: '1', kind: 'chip', entry: 'main.js', pick: true, tools: [{ name: 'pick', description: 'Select' }] }, enabled: true, dir: '/picker' } as InstalledGhost;
  const dispatcher = new GhostPipeDispatcher({ getGhost: () => ghost, runtimeStateOf: () => 'running', spawn: async () => ({ ok: true }), sendToGhost: () => true });
  const imported = vi.fn(async () => ({ ok: true as const, name: 'selected' }));
  const deposit = vi.fn(() => ({ ok: false as const, message: 'unexpected' }));
  const slot = new GhostPickSlot({ getGhost: () => ghost, getMutationTarget: () => 'approved',
    showDirectoryDialog: async () => null, showFileDialog: () => waiting.promise, importFiles: imported, depositDir: deposit,
    getPendingCallSignal: (id, call) => dispatcher.getPendingCallSignal(id, call),
    holdCall: (id, call, budget) => dispatcher.holdCall(id, call, budget), releaseCall: (id, call) => dispatcher.releaseCall(id, call),
  });
  const tools = [{ name: 'pick', description: 'Select' }];
  const ui = { resources: [{
            uri: "ui://form",
            file: 'ui/form.html'
        }], tools: { pick: { resourceUri: "ui://form" } } };
  const config: AppServerConfig = { id: 'pick-lifetime', url: '', transport: 'in-process', plugin: {
    instance: 'pick-lifetime', revision: 'approved', packageSha256: 'hash', directory: '/fixture', title: 'Picker', trust: 'unverified', domains: [], assertCurrent() {},
    createTransport: () => createPluginAppTransport({ instance: 'pick-lifetime', revision: 'approved', tools, ui, assertCurrent() {}, readHtml: () => '<p>Select</p>',
      call: async (_grant, _args, signal) => {
        const dispatched = dispatcher.callGhostTool({ ghostId: 'pick-lifetime', tool: 'pick', args: {}, callId: 'page-pick', signal });
        const selected = slot.handleRequest('pick-lifetime', { mode: 'file', into: 'media', callId: 'page-pick', deposit: true });
        started.resolve(signal);
        const result = await selected;
        dispatcher.handleToolResult('pick-lifetime', { callId: 'page-pick', ...result, result: 'selected' });
        await dispatched;
        return { content: [{ type: 'text', text: result.ok ? 'selected' : 'cancelled' }] };
      } }),
  } };
  const owner = {}, connection = new AppConnection(config);
  const host = new McpAppsHost({ owner: () => owner, config: () => config, connection: () => connection,
    readCard: async () => ({ version: 1, serverId: config.id, serverRevision: appServerRevision(config), resourceUri: 'ui://form', tool: pluginAppTool('pick-lifetime', tools[0], ui), arguments: {} }),
    writeCard: async () => {}, sendMessage: async () => {}, authorizeTool: async () => {},
  }); hosts.push(host);
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  const doc = await host.open('renderer:1', 'task', 'card', {});
  vi.useFakeTimers();
  await host.dispatch('renderer:1', 'task', doc.viewId, { jsonrpc: '2.0', id: 0, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'Picker', version: '1' }, appCapabilities: {} } });
  await vi.advanceTimersByTimeAsync(0);
  await host.dispatch('renderer:1', 'task', doc.viewId, { jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await host.dispatch('renderer:1', 'task', doc.viewId, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pick' } });
  await vi.advanceTimersByTimeAsync(0);
  const signal = await started.promise;
  await vi.advanceTimersByTimeAsync(61_000);
  expect(signal.aborted).toBe(false);
  expect((await host.poll('renderer:1', 'task', doc.viewId, 0)).some(event => event.message && 'id' in event.message && event.message.id === 1)).toBe(false);
  if (ending === 'unmount') {
    await host.teardown('renderer:1', 'task', doc.viewId);
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(true);
  }
  waiting.resolve(['/selected/image.png']);
  await vi.advanceTimersByTimeAsync(0);
  if (ending === 'unmount') { expect(imported).not.toHaveBeenCalled(); expect(deposit).not.toHaveBeenCalled(); }
  if (ending === 'complete') {
    expect(imported).toHaveBeenCalledOnce();
    const messages = (await host.poll('renderer:1', 'task', doc.viewId, 0)).map(event => event.message);
    expect(messages).toContainEqual(expect.objectContaining({ id: 1, result: { content: [{ type: 'text', text: 'selected' }] } }));
  }
});

// Unit: plugin page calls formerly bypassed all tool approval. Exercise the real
// Host/AppBridge from local and device callers, with click-like and scripted input.
// A denial must stop upstream dispatch even when the tool claims readOnlyHint.
it.each(['renderer:1', 'device:phone'])('requires plugin tool approval before issuing a page ticket: %s', async caller => {
  const f = await fixture(caller, true);
  f.methods.tools.mockResolvedValue([{ ...tool, annotations: { readOnlyHint: true } }] as never);
  f.methods.callTool.mockResolvedValue({ content: [] });
  f.authorizeTool.mockRejectedValue(new Error('MCP_APP_TOOL_DENIED'));
  for (const id of [70, 71]) {
    await f.dispatch({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool.name,
      arguments: {}, _meta: { trigger: id === 70 ? 'click' : 'script' } } });
    await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id, error: expect.anything() })));
  }
  expect(f.authorizeTool).toHaveBeenCalledTimes(2);
  expect(f.methods.callTool).not.toHaveBeenCalled();
});

// Host dispatch/poll must isolate reused JSON-RPC IDs across documents (unit).
// Existing revocation cases close the whole View; none replace a document while
// an approval or upstream call is pending. The old signal and late reply are observable.
it.each(['approval', 'call'] as const)('reinitializes a document and cancels its old %s without replaying card input', async phase => {
  const f = await fixture('renderer:1', false, '<script type="module">import "@modelcontextprotocol/ext-apps";</script>');
  const old = deferred<{ content: { type: 'text'; text: string }[] }>();
  let signal: AbortSignal | undefined;
  if (phase === 'approval') f.authorizeTool.mockImplementationOnce(async (_s, _t, _a, value) => { signal = value; await old.promise; });
  else f.methods.callTool.mockImplementationOnce((_p, _schema, options) => { signal = options.signal; return old.promise; });
  f.methods.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'new document' }] });
  await f.dispatch({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'form' } });
  await vi.waitFor(() => expect(signal).toBeDefined());
  f.host.context('renderer:1', 'task', f.viewId, { theme: 'dark' });
  await f.dispatch({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {
    protocolVersion: '2026-01-26', appInfo: { name: 'Replacement', version: '1' }, appCapabilities: {},
  } });
  expect(signal!.aborted).toBe(true);
  await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 1, result: expect.objectContaining({ hostContext: expect.objectContaining({ theme: 'dark' }) }) })));
  await f.dispatch({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await f.dispatch({ jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'form' } });
  await vi.waitFor(() => expect(f.methods.callTool).toHaveBeenCalledTimes(phase === 'call' ? 2 : 1));
  old.resolve({ content: [{ type: 'text', text: 'old document' }] });
  await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 70, result: { content: [{ type: 'text', text: 'new document' }] } })));
  const delivered = await f.poll(0);
  const messages = delivered.flatMap(e => e.message ? [e.message] : []);
  expect(f.methods.callTool).toHaveBeenCalledTimes(phase === 'call' ? 2 : 1);
  expect(f.document.sdk).toBeDefined();
  expect(messages.filter(m => 'id' in m && m.id === 70)).toEqual([{ jsonrpc: '2.0', id: 70, result: { content: [{ type: 'text', text: 'new document' }] } }]);
  expect(messages.some(m => 'method' in m && ['ui/notifications/tool-input', 'ui/notifications/tool-result', 'ui/notifications/tool-cancelled'].includes(m.method))).toBe(false);
});

// Unit: adding SDK bytes must not reject an existing near-limit remote page.
it('keeps an old large remote page usable without the optional SDK', async () => {
  const html = 'x'.repeat(4 * 1024 * 1024 - 66 * 1024);
  const f = await fixture('device:phone', false, html);
  expect(f.document.html).toBe(html);
  expect(f.document.sdk).toBeUndefined();
});

// Unit: a poll can snapshot old replies before its final authorization read.
// Reinitialize during that read must discard the already-captured old snapshot.
it('drops an old poll snapshot when its final authorization straddles a new document', async () => {
  const f = await fixture();
  const card = await f.readCard();
  const pending = deferred<McpAppRecord>();
  f.readCard.mockClear().mockResolvedValueOnce(card).mockReturnValueOnce(pending.promise);
  const poll = f.poll(0);
  await vi.waitFor(() => expect(f.readCard).toHaveBeenCalledTimes(2));
  await f.dispatch({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: {
    protocolVersion: '2026-01-26', appInfo: { name: 'Replacement', version: '1' }, appCapabilities: {},
  } });
  pending.resolve(card);
  expect(await poll).toEqual([]);
  const next = await f.poll(0);
  expect(next.some(e => e.message && 'id' in e.message && e.message.id === 1)).toBe(true);
  expect(next.every(event => event.generation === 1)).toBe(true);
  expect(next.some(e => e.message && 'method' in e.message && e.message.method === 'ui/notifications/tool-input')).toBe(false);
});

// Lead R1: accepted messages belong to the card, not a replaceable document.
// Unit, Host -> production sender -> real queued guard, with a busy Agent.
it('keeps an accepted queued ui/message after the document changes', async () => {
  let queued!: AgentInputQueuedMessage;
  const owner = {};
  const sendMessage = createAppMessageSender({ owner: () => owner, readClearBoundary: async () => null,
    restoreQueue: async () => {}, clearBoundary: () => null, shouldQueue: () => true,
    getSessionMeta: async () => ({}), buildCreateOpts: async () => ({ agentKind: 'pi' as const }),
    createClientId: () => 'queued', buildQueueItem: async params => ({ ...params, text: params.message }) as unknown as AgentInputQueuedMessage,
    enqueue: (_session, item) => { queued = item; }, sendToAgentAccepted: vi.fn(),
  });
  const f = await fixture('renderer:1', false, '<p>Form</p>', { sendMessage });
  await f.dispatch({ jsonrpc: '2.0', id: 91, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Please continue' }] } });
  await vi.waitFor(() => expect(f.outgoing).toContainEqual({ jsonrpc: '2.0', id: 91, result: {} }));
  await f.dispatch({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'New', version: '1' }, appCapabilities: {} } });
  await expect(queuedAppMessageGuard(queued)!()).resolves.toBeUndefined();
  expect(queued.text).toBe('Please continue');
  f.revoke('card');
  await expect(queuedAppMessageGuard(queued)!()).rejects.toThrow();
});

// Lead R2: a completion never delivered to a document must survive replacement.
it.each(['result', 'cancelled'] as const)('delivers the first pending tool %s after document replacement', async ending => {
  const f = await fixture('renderer:1', false, '<p>Pending</p>', { pendingTool: true });
  await f.dispatch({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'New', version: '1' }, appCapabilities: {} } });
  const record = await f.readCard();
  if (ending === 'result') record.result = { content: [{ type: 'text', text: 'Done' }] };
  else record.cancelled = 'Cancelled';
  await f.host.updateResult('task', 'card', record);
  expect(f.outgoing.some(m => 'method' in m && m.method === 'ui/notifications/tool-' + ending)).toBe(false);
  await f.dispatch({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await vi.waitFor(() => expect(f.outgoing.filter(m => 'method' in m && m.method === 'ui/notifications/tool-' + ending)).toHaveLength(1));
  expect(f.outgoing.some(m => 'method' in m && m.method === 'ui/notifications/tool-input')).toBe(false);
});

// Lead R3: retrying initialize before initialized stays within the first document.
it('keeps initial input and attachment projection across an initialize retry', async () => {
  const f = await fixture('renderer:1', true, '<p>Retry</p>', { uninitialized: true, pendingTool: true, attachments: true });
  for (const id of [1, 2]) {
    await f.dispatch({ jsonrpc: '2.0', id, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'Retry', version: '1' }, appCapabilities: {} } });
    await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id, result: expect.anything() })));
  }
  await f.dispatch({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ method: 'ui/notifications/tool-input' })));
  const context = f.outgoing.find(m => 'method' in m && m.method === 'ui/notifications/host-context-changed' && m.params?.toolInfo);
  expect(JSON.stringify(context)).toContain('/__cindy/files/');
});

// #8148: every page receives the optional SDK; the Host never rewrites page bytes.
it('keeps BOM page bytes while supplying the SDK to a remote viewer', async () => {
  const html = '\ufeff<!doctype html><html><head></head><body>Old page</body></html>';
  const f = await fixture('device:phone', false, html);
  expect(f.document.html).toBe(html);
  expect(typeof f.document.sdk?.source).toBe('string');
});

// Accepted queued input must survive replacement, but preparation has not accepted it yet.
// Unit / Host -> real sender, hold session metadata before the enqueue fence.
it('cancels a ui/message still preparing when its document is replaced', async () => {
  const metadata = deferred<Record<string, never>>();
  const getSessionMeta = vi.fn(() => metadata.promise);
  const enqueue = vi.fn();
  const owner = {};
  let finished = false;
  const sender = createAppMessageSender({ owner: () => owner, readClearBoundary: async () => null,
    restoreQueue: async () => {}, clearBoundary: () => null, shouldQueue: () => true,
    getSessionMeta, buildCreateOpts: async () => ({ agentKind: 'pi' as const }),
    createClientId: () => 'preparing', buildQueueItem: async params => ({ ...params, text: params.message }) as unknown as AgentInputQueuedMessage,
    enqueue, sendToAgentAccepted: vi.fn(),
  });
  const f = await fixture('renderer:1', false, '<p>Form</p>', {
    sendMessage: async (...args) => { try { await sender(...args); } finally { finished = true; } },
  });
  await f.dispatch({ jsonrpc: '2.0', id: 91, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Not accepted yet' }] } });
  await vi.waitFor(() => expect(getSessionMeta).toHaveBeenCalledOnce());
  await f.dispatch({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'New', version: '1' }, appCapabilities: {} } });
  metadata.resolve({});
  await vi.waitFor(() => expect(finished).toBe(true));
  expect(enqueue).not.toHaveBeenCalled();
});
