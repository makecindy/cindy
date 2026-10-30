import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { JSONRPCMessage, Notification } from '@modelcontextprotocol/sdk/types.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import type { AppConnection } from '../connection.js';
import { McpAppsHost, appServerRevision } from '../host.js';
import { handleMcpAppFrameOperation, handleMcpAppOperation } from '../operations.js';

const hosts: McpAppsHost[] = [];
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

async function fixture(caller = 'renderer:1') {
  let owner = {};
  let enabled = true;
  let visible = true;
  const config = { id: 'example', url: 'https://mcp.example.invalid', transport: 'http' as const };
  const card: McpAppRecord = {
    version: 1,
    serverId: config.id,
    serverRevision: appServerRevision(config),
    resourceUri: 'ui://form',
    tool,
    arguments: {},
  };
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
          { uri: card.resourceUri, mimeType: 'text/html;profile=mcp-app', text: '<p>Form</p>' },
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
  const authorizeTool = vi.fn(async () => {});
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
    sendMessage: async () => {},
    connection: () => connection,
  });
  hosts.push(host);
  const document = await host.open(caller, 'task', 'card', {});
  const dispatch = (message: JSONRPCMessage) =>
    host.dispatch(caller, 'task', document.viewId, message);
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
  await vi.waitFor(
    () =>
      expect(outgoing).toContainEqual(expect.objectContaining({ id: 1, result: expect.anything() })),
    { interval: 1 },
  );
  await dispatch({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
  await vi.waitFor(
    () =>
      expect(outgoing).toContainEqual(
        expect.objectContaining({ method: 'ui/notifications/tool-input' }),
      ),
    { interval: 1 },
  );
  outgoing.length = 0;
  return {
    host,
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
    );
    expect(f.methods.callTool).toHaveBeenCalledOnce();
    expect(f.methods.tools).toHaveBeenCalledOnce();
  });

  it('retains the latest tool progress while the card authorization read is pending', async () => {
    const f = await fixture();
    const result = deferred<unknown>();
    f.methods.callTool.mockReturnValueOnce(result.promise);
    await f.dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { ...requests[0][1], _meta: { progressToken: 'view-local-token' } },
    });
    await vi.waitFor(() => expect(f.methods.callTool).toHaveBeenCalledOnce());
    const options = f.methods.callTool.mock.calls[0][2] as RequestOptions;
    const authorization = deferred<McpAppRecord>();
    f.readCard.mockReturnValueOnce(authorization.promise);
    options.onprogress?.({ progress: 1 });
    await vi.waitFor(() => expect(f.readCard.mock.results.at(-1)?.value).toBe(authorization.promise));
    options.onprogress?.({ progress: 2 });
    options.onprogress?.({ progress: 3, total: 10, message: 'latest' });
    authorization.resolve(await f.readCard());
    await vi.waitFor(() =>
      expect(f.outgoing).toContainEqual({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'view-local-token', progress: 3, total: 10, message: 'latest' },
      }),
    );
    expect(
      f.outgoing.filter(
        (message) => 'method' in message && message.method === 'notifications/progress',
      ),
    ).toHaveLength(1);
    result.resolve(requests[0][3]);
    await vi.waitFor(() =>
      expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2, result: requests[0][3] })),
    );
  });

  it.each(['card', 'owner', 'server', 'config'] as const)(
    'discards App tool progress and results after %s revocation without replaying it',
    async (revocation) => {
      const f = await fixture();
      const pending = deferred<unknown>();
      f.methods.callTool.mockReturnValueOnce(pending.promise);
      await f.dispatch({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { ...requests[0][1], _meta: { progressToken: 'view-local-token' } },
      });
      await vi.waitFor(() => expect(f.methods.callTool).toHaveBeenCalledOnce());
      const options = f.methods.callTool.mock.calls[0][2] as RequestOptions;
      options.onprogress?.({ progress: 1, total: 2, message: 'authorized progress' });
      await vi.waitFor(() =>
        expect(f.outgoing).toContainEqual({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: 'view-local-token',
            progress: 1,
            total: 2,
            message: 'authorized progress',
          },
        }),
      );
      f.outgoing.length = 0;
      f.revoke(revocation);
      options.onprogress?.({ progress: 2, total: 2, message: marker });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(JSON.stringify(f.outgoing)).not.toContain(marker);
      pending.resolve(requests[0][3]);
      await vi.waitFor(() => expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2 })));
      expect(f.outgoing).toContainEqual(expect.objectContaining({ id: 2, error: expect.anything() }));
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
