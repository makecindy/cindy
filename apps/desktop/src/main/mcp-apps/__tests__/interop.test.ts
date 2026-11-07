import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { App } from '@modelcontextprotocol/ext-apps';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolResultSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type ServerRequest,
  type ServerNotification,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createMockAppServer,
  startMockAppServer,
  MOCK_RESOURCE,
} from '../../../../scripts/mcp-apps-mock.mjs';
import { AppConnection } from '../connection.js';
import { McpAppsHost, appServerRevision, type McpAppsHostDeps } from '../host.js';
import { setMcpAppsHost, registerAppServer } from '../runtime.js';
import { createAppServerProxy } from '../serverProxy.js';
import { MCP_APPS_MAX_BYTES, MCP_APPS_MAX_CARD_BYTES } from '../protocol.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';

let endpoint: Awaited<ReturnType<typeof startMockAppServer>>;
const serverInstructions =
  'Review the draft before calling create_application.\nKeep application data unchanged.';
const cleanups: Array<() => Promise<unknown>> = [];
beforeAll(async () => {
  endpoint = await startMockAppServer({
    createServer: () => createMockAppServer({ instructions: serverInstructions }),
  });
});
afterAll(async () => {
  await endpoint.close();
});
afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((close) => close()));
});

/** Independent official View SDK, using the production Host transport operations. */
class TestViewTransport implements Transport {
  onmessage?: Transport['onmessage'];
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  failure?: unknown;
  private active = true;
  constructor(
    private host: McpAppsHost,
    private viewId: string,
    private caller = 'renderer:1',
    private openLink: (url: string) => Promise<void> = async () => {},
  ) {}
  async start() {
    void (async () => {
      let after = 0;
      while (this.active) {
        try {
          const events = await this.host.poll(this.caller, 'task', this.viewId, after);
          for (const event of events) {
            after = event.seq;
            if (event.openLink) {
              await this.openLink(event.openLink.url);
              this.host.linkResult(this.caller, 'task', this.viewId, event.openLink.id, true);
            } else this.onmessage?.(event.message);
          }
        } catch (error) {
          if (this.active) {
            this.failure = error;
            await this.close();
          }
          return;
        }
      }
    })();
  }
  async send(message: JSONRPCMessage) {
    await this.host.dispatch(this.caller, 'task', this.viewId, message);
  }
  async close() {
    if (!this.active) return;
    this.active = false;
    this.onclose?.();
  }
}

async function fixture(
  transport: 'http' | 'sse' = 'http',
  options: {
    cancelled?: boolean;
    pending?: boolean;
    platform?: 'mobile' | 'desktop';
    appModes?: ('inline' | 'fullscreen')[];
    duringResource?: 'result' | 'cancelled' | 'clear' | 'server';
    revisionKey?: () => string;
    source?: typeof endpoint;
  } = {},
) {
  const config = {
    id: 'example',
    url:
      transport === 'http' ? (options.source ?? endpoint).url : (options.source ?? endpoint).sseUrl,
    transport,
  };
  let owner: object = {};
  let visible = true;
  let enabled = true;
  const connection = new AppConnection(config);
  const client = await connection.getClient();
  const tool = (await connection.tools()).find((tool) => tool.name === 'draft_form')!;
  const input = { title: 'Draft', body: 'Review first' };
  const result = (await client.callTool(
    { name: 'draft_form', arguments: input },
    CallToolResultSchema,
  )) as CallToolResult;
  let card: McpAppRecord = {
    version: 1,
    serverId: config.id,
    serverRevision: appServerRevision(config, options.revisionKey?.()),
    resourceUri: MOCK_RESOURCE,
    tool,
    arguments: input,
    ...(options.cancelled ? { cancelled: 'User cancelled' } : options.pending ? {} : { result }),
  };
  const authorize = vi.fn(async () => {});
  const sendMessage = vi.fn<McpAppsHostDeps['sendMessage']>(async () => {});
  const openLink = vi.fn(async () => {});
  const dispose = vi.fn();
  const write = vi.fn(async (_session: string, _client: string, record: McpAppRecord) => {
    card = record;
  });
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => (enabled ? config : undefined),
    revisionKey: options.revisionKey,
    readCard: async () => {
      if (!visible) throw new Error('MCP_APP_CARD_UNAVAILABLE');
      return card;
    },
    writeCard: write,
    authorizeTool: authorize,
    sendMessage,
    disposeDocument: dispose,
  });
  card.connectionId = host.registerConnection(connection);
  if (options.duringResource) {
    if (options.duringResource === 'result' || options.duringResource === 'cancelled')
      delete card.result;
    const readResource = connection.resource.bind(connection);
    vi.spyOn(connection, 'resource').mockImplementationOnce(async (uri) => {
      const resource = await readResource(uri);
      if (options.duringResource === 'result')
        await host.updateResult('task', 'card', { ...card, result });
      if (options.duringResource === 'cancelled')
        await host.updateResult('task', 'card', { ...card, cancelled: 'User cancelled' });
      if (options.duringResource === 'clear') visible = false;
      if (options.duringResource === 'server') enabled = false;
      return resource;
    });
  }
  const document = await host
    .open('renderer:1', 'task', 'card', {
      theme: 'dark',
      platform: options.platform ?? 'desktop',
    })
    .catch(async (error) => {
      await host.reset();
      await connection.close();
      throw error;
    });
  const app = new App(
    { name: 'Official SDK View', version: '1.0.0' },
    { availableDisplayModes: options.appModes ?? ['inline', 'fullscreen'] },
    { autoResize: false },
  );
  const messages: string[] = [];
  const inputs: unknown[] = [],
    results: unknown[] = [];
  app.ontoolinput = (params) => {
    messages.push('input');
    inputs.push(params);
  };
  app.ontoolresult = (params) => {
    messages.push('result');
    results.push(params);
  };
  app.ontoolcancelled = () => {
    messages.push('cancelled');
  };
  const teardown = vi.fn(async () => ({}));
  app.onteardown = teardown;
  const viewTransport = new TestViewTransport(host, document.viewId, 'renderer:1', openLink);
  await app.connect(viewTransport);
  const apps = [app];
  cleanups.push(async () => {
    await host.reset();
    await Promise.all(apps.map((view) => view.close()));
    await connection.close();
  });
  return {
    host,
    app,
    apps,
    viewTransport,
    client,
    card,
    document,
    config,
    messages,
    inputs,
    results,
    authorize,
    sendMessage,
    openLink,
    write,
    teardown,
    dispose,
    clear() {
      visible = false;
    },
    revoke() {
      enabled = false;
    },
    changeOwner() {
      owner = {};
    },
  };
}

/** Real SDK requests with server completion controlled independently of the Host clock. */
async function controlledToolFixture(transport: 'http' | 'sse' = 'http') {
  const calls: {
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>;
    resolve(result: CallToolResult): void;
  }[] = [];
  const source = await startMockAppServer({
    createServer: () => {
      const server = createMockAppServer();
      server.registerTool(
        'controlled_tool',
        { inputSchema: {}, _meta: { ui: { visibility: ['app'] } } },
        async (_args, extra) =>
          new Promise<CallToolResult>((resolve) => calls.push({ extra, resolve })),
      );
      return server;
    },
  });
  cleanups.push(async () => {
    calls.forEach(({ resolve }) => resolve({ content: [] }));
    await source.close();
  });
  return { f: await fixture(transport, { source }), calls };
}

describe('official MCP Apps interoperability', () => {
  it.each(['http', 'sse'] as const)(
    'routes concurrent %s View progress by request, preserving its values',
    async (transport) => {
      const { f, calls } = await controlledToolFixture(transport);
      const document = await f.host.open('renderer:2', 'task', 'card', { platform: 'desktop' });
      const second = new App({ name: 'Second View', version: '1' }, {}, { autoResize: false });
      second.onteardown = async () => ({});
      f.apps.push(second);
      await second.connect(new TestViewTransport(f.host, document.viewId, 'renderer:2'));
      const firstProgress = vi.fn(),
        secondProgress = vi.fn();
      const firstResult = f.app.callServerTool(
        { name: 'controlled_tool', arguments: {}, _meta: { requestLabel: 'first' } },
        { onprogress: firstProgress },
      );
      const secondResult = second.callServerTool(
        { name: 'controlled_tool', arguments: {}, _meta: { requestLabel: 'second' } },
        { onprogress: secondProgress },
      );
      const results = Promise.allSettled([firstResult, secondResult]);
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      const first = calls.find((call) => call.extra._meta?.requestLabel === 'first')!;
      const other = calls.find((call) => call.extra._meta?.requestLabel === 'second')!;
      expect(first.extra._meta?.progressToken).not.toBe(other.extra._meta?.progressToken);
      await other.extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: other.extra._meta!.progressToken!,
          progress: 2.5,
          total: 10,
          message: 'second',
        },
      });
      await vi.waitFor(() =>
        expect(secondProgress).toHaveBeenCalledWith({
          progress: 2.5,
          total: 10,
          message: 'second',
        }),
      );
      expect(firstProgress).not.toHaveBeenCalled();
      first.resolve({ content: [{ type: 'text', text: 'first' }] });
      other.resolve({ content: [{ type: 'text', text: 'second' }] });
      expect(await results).toEqual([
        { status: 'fulfilled', value: { content: [{ type: 'text', text: 'first' }] } },
        { status: 'fulfilled', value: { content: [{ type: 'text', text: 'second' }] } },
      ]);
    },
  );

  it.each([true, false])(
    'finishes a 90-second tool with progress=%s under the View request budget',
    async (withProgress) => {
      const { f, calls } = await controlledToolFixture();
      await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'Date'],
        shouldClearNativeTimers: true,
      });
      const progress = vi.fn();
      let settled = false;
      const result = f.app
        .callServerTool(
          { name: 'controlled_tool', arguments: {} },
          {
            ...(withProgress ? {} : { timeout: 120_000 }),
            onprogress: progress,
          },
        )
        .finally(() => {
          settled = true;
        });
      const outcome = result.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        for (let step = 1; step <= 3; step++) {
          await vi.advanceTimersByTimeAsync(30_000);
          if (withProgress) {
            await calls[0].extra.sendNotification({
              method: 'notifications/progress',
              params: {
                progressToken: calls[0].extra._meta!.progressToken!,
                progress: step,
                total: 3,
              },
            });
            await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(step));
          }
        }
        expect(settled).toBe(false);
        calls[0].resolve({ content: [{ type: 'text', text: 'complete' }] });
        expect(await outcome).toEqual({ value: { content: [{ type: 'text', text: 'complete' }] } });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('honors a shorter View timeout without replaying the tool or cancelling a later call', async () => {
    const { f, calls } = await controlledToolFixture();
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
      shouldClearNativeTimers: true,
    });
    const cancelled = f.app.callServerTool(
      { name: 'controlled_tool', arguments: {} },
      { timeout: 500 },
    );
    const outcome = cancelled.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(501);
      expect(await outcome).toMatchObject({ error: { code: -32001 } });
      await vi.waitFor(() => expect(calls[0].extra.signal.aborted).toBe(true));
      const next = f.app.callServerTool({ name: 'controlled_tool', arguments: {} });
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      calls[1].resolve({ content: [{ type: 'text', text: 'next call' }] });
      expect((await next).content).toEqual([{ type: 'text', text: 'next call' }]);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('bounds total tool time even when server progress renews the View timer', async () => {
    const { f, calls } = await controlledToolFixture();
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
      shouldClearNativeTimers: true,
    });
    const progress = vi.fn();
    let settled = false;
    const result = f.app.callServerTool(
      { name: 'controlled_tool', arguments: {} },
      { timeout: 2 * 60 * 60_000, onprogress: progress },
    );
    const outcome = result
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(29 * 60_000);
      expect(settled).toBe(false);
      await calls[0].extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: calls[0].extra._meta!.progressToken!, progress: 1 },
      });
      await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(60_001);
      expect(await outcome).toMatchObject({ error: { code: -32001 } });
      await vi.waitFor(() => expect(calls[0].extra.signal.aborted).toBe(true));
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(['http', 'sse'] as const)('cancels a %s App resource request waiting for reconnect without disturbing a peer', async (transport) => {
    const f = await fixture(transport);
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    await f.client.close();
    const acquiring = vi.spyOn(AppConnection.prototype, 'getClient');
    const read = vi.spyOn(Client.prototype, 'readResource');
    const connect = Client.prototype.connect;
    let release: (() => void) | undefined;
    cleanups.push(async () => release?.());
    // Exercise the real shared connection attempt and per-waiter cancellation.
    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(function (this: Client, ...args: Parameters<Client['connect']>) {
      return new Promise<void>((resolve, reject) => {
        release = () => {
          release = undefined;
          void connect.call(this, ...args).then(resolve, reject);
        };
      });
    });
    const abort = new AbortController();
    const pending = f.app.readServerResource({ uri: MOCK_RESOURCE }, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    const cancelled = vi.fn();
    const waiter = acquiring.mock.results.at(-1)!.value as Promise<Client>;
    void waiter.catch(cancelled);
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(read).not.toHaveBeenCalled();

    const healthy = f.app.readServerResource({ uri: MOCK_RESOURCE });
    const completed = expect(healthy).resolves.toMatchObject({ contents: [{ uri: MOCK_RESOURCE }] });
    await vi.waitFor(() => expect(acquiring).toHaveBeenCalledTimes(2));
    release!();
    await completed;
    expect(read).toHaveBeenCalledOnce();
  });

  it('stores and delivers a bounded oversized-result failure to live and reopened remote Views', async () => {
    const f = await fixture('http', { pending: true });
    await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
    const oversized: CallToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(MCP_APPS_MAX_BYTES) }],
      structuredContent: { original: true },
      _meta: { viewOnly: 'must not be persisted with the rejected payload' },
    };
    await f.host.updateResult('task', 'card', { ...f.card, result: oversized });
    const persisted = f.write.mock.calls.at(-1)![2];
    const failure = {
      isError: true,
      content: [{ type: 'text', text: 'MCP_APP_RESULT_TOO_LARGE' }],
    };
    expect(persisted.result).toEqual(failure);
    expect(Buffer.byteLength(JSON.stringify({ mcpApp: persisted }))).toBeLessThan(
      MCP_APPS_MAX_CARD_BYTES,
    );
    // A history row transports content as a JSON-escaped string, not as the raw card object.
    expect(
      Buffer.byteLength(JSON.stringify({ content: JSON.stringify({ mcpApp: persisted }) })),
    ).toBeLessThan(MCP_APPS_MAX_BYTES);
    await vi.waitFor(() => expect(f.results).toEqual([failure]));
    expect(oversized.content[0]).toHaveProperty('data', 'A'.repeat(MCP_APPS_MAX_BYTES));
    await f.host.teardown('renderer:1', 'task', f.document.viewId);

    const document = await f.host.open('device:phone', 'task', 'card', {
      platform: 'mobile',
      theme: 'dark',
    });
    const reopened = new App(
      { name: 'Reopened remote View', version: '1.0.0' },
      {},
      { autoResize: false },
    );
    const results: unknown[] = [];
    reopened.ontoolresult = (result) => {
      results.push(result);
    };
    cleanups.push(async () => {
      await reopened.close();
    });
    await reopened.connect(new TestViewTransport(f.host, document.viewId, 'device:phone'));
    await vi.waitFor(() => expect(results).toEqual([failure]));
  });
  it('rejects oversized card input before writing history', async () => {
    const f = await fixture('http', { pending: true });
    await expect(
      f.host.updateResult('task', 'card', {
        ...f.card,
        arguments: { draft: 'x'.repeat(MCP_APPS_MAX_CARD_BYTES) },
      }),
    ).rejects.toThrow('MCP_APP_CARD_TOO_LARGE');
    expect(f.write).not.toHaveBeenCalled();
  });
  it('keeps the original oversized model result while persisting only the bounded App failure', async () => {
    const f = await fixture();
    setMcpAppsHost(f.host);
    registerAppServer(f.config.id, () => f.config);
    const upstream: CallToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(MCP_APPS_MAX_BYTES) }],
      structuredContent: { original: true },
      _meta: { viewOnly: 'private to the View' },
    };
    const getClient = vi.spyOn(AppConnection.prototype, 'getClient').mockResolvedValue(f.client);
    const callTool = vi.spyOn(f.client, 'callTool').mockResolvedValueOnce(upstream);
    const facade = createAppServerProxy(() => f.config, {
      agentKind: 'codex',
      sessionId: 'task',
      workingDir: '',
    });
    const client = new Client({ name: 'model-client', version: '1' });
    cleanups.push(async () => {
      await client.close();
      await facade.close();
    });
    try {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await facade.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'draft_form',
        arguments: { title: 'Draft', body: 'Review' },
      });
      expect(result.content).toEqual(upstream.content);
      expect(result.structuredContent).toEqual(upstream.structuredContent);
      expect(result).not.toHaveProperty('_meta');
      expect(upstream._meta).toEqual({ viewOnly: 'private to the View' });
      expect(f.write).toHaveBeenCalledTimes(2);
      for (const [, , record] of f.write.mock.calls)
        expect(Buffer.byteLength(JSON.stringify({ mcpApp: record }))).toBeLessThanOrEqual(
          MCP_APPS_MAX_CARD_BYTES,
        );
      expect(f.write.mock.calls.at(-1)![2].result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'MCP_APP_RESULT_TOO_LARGE' }],
      });
    } finally {
      callTool.mockRestore();
      getClient.mockRestore();
    }
  });
  it.each(['result', 'cancelled'] as const)(
    'delivers %s when execution finishes while the App resource is loading',
    async (duringResource) => {
      const f = await fixture('http', { duringResource });
      await vi.waitFor(() => expect(f.messages).toEqual(['input', duringResource]));
      if (duringResource === 'result') expect(f.results).toEqual([f.card.result]);
    },
  );
  it.each([
    ['clear', 'MCP_APP_CARD_UNAVAILABLE'],
    ['server', 'MCP_APP_SERVER_CHANGED'],
  ] as const)(
    'refuses a View revoked by %s while its resource is loading',
    async (duringResource, error) => {
      await expect(fixture('http', { duringResource })).rejects.toThrow(error);
    },
  );
  it.each(['http', 'sse'] as const)(
    '%s negotiates the official View and sends input before full result',
    async (transport) => {
      const f = await fixture(transport);
      await vi.waitFor(() => expect(f.messages).toEqual(['input', 'result']));
      expect(f.inputs).toEqual([{ arguments: f.card.arguments }]);
      expect(f.results).toEqual([f.card.result]);
      expect(f.card.result?._meta?.hostUi).toMatchObject({
        mimeTypes: ['text/html;profile=mcp-app'],
      });
      expect(f.app.getHostContext()).toMatchObject({
        theme: 'dark',
        displayMode: 'inline',
        availableDisplayModes: ['inline', 'fullscreen'],
      });
      expect(f.app.getHostCapabilities()).toMatchObject({
        sandbox: { permissions: {} },
        serverTools: {},
      });
      expect(f.document.html).toContain('创建模拟申请');
      expect(
        () => new Script(f.document.html.match(/<script>([\s\S]*)<\/script>/i)![1]),
      ).not.toThrow();
    },
  );
  it('App-only submit stays outside the model surface and model-only calls are rejected', async () => {
    const f = await fixture();
    const result = await f.app.callServerTool({
      name: 'create_application',
      arguments: { title: 'Edited', body: 'Application only' },
    });
    expect(result.structuredContent).toEqual({ applicationId: 1, sent: false });
    expect(f.authorize).toHaveBeenCalledOnce();
    await expect(f.app.callServerTool({ name: 'model_only', arguments: {} })).rejects.toThrow(
      'MCP_APP_TOOL_NOT_VISIBLE',
    );
    const resource = await f.app.readServerResource({ uri: MOCK_RESOURCE });
    expect(resource.contents[0].mimeType).toBe('text/html;profile=mcp-app');
  });
  it('context updates replace old values, do not start a model turn, and disappear after clear', async () => {
    const f = await fixture();
    await f.app.updateModelContext({ structuredContent: { draft: 'old' } });
    await f.app.updateModelContext({ structuredContent: { draft: 'new' } });
    const context = await f.host.modelContext('task');
    expect(context.text).toContain('new');
    expect(context.text).not.toContain('old');
    expect(f.sendMessage).not.toHaveBeenCalled();
    await f.app.sendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'Continue editing' }],
    });
    expect(f.sendMessage).toHaveBeenCalledWith('task', expect.anything(), [
      { type: 'text', text: 'Continue editing' },
    ], expect.any(Function));
    f.clear();
    expect((await f.host.modelContext('task')).text).toBe('');
    await expect(
      f.app.callServerTool({ name: 'create_application', arguments: { title: 'x', body: '' } }),
    ).rejects.toThrow('Connection closed');
    expect(f.viewTransport.failure).toMatchObject({ message: 'MCP_APP_CARD_UNAVAILABLE' });
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it.each(['card', 'owner', 'server'] as const)(
    'rechecks the live View after %s revocation during App-message preparation',
    async (kind) => {
      const f = await fixture();
      let finish!: () => void;
      let completed!: () => void;
      const completion = new Promise<void>((resolve) => {
        completed = resolve;
      });
      let failure: unknown;
      const dispatched = vi.fn();
      f.sendMessage.mockImplementationOnce(async (_id, _record, _content, assertCurrent) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        try {
          await assertCurrent();
          dispatched();
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          completed();
        }
      });
      const rejected = expect(
        f.app.sendMessage({ role: 'user', content: [{ type: 'text', text: 'Continue editing' }] }),
      ).rejects.toThrow('Connection closed');
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (kind === 'card') f.clear();
      else if (kind === 'owner') f.changeOwner();
      else f.revoke();
      finish();
      await completion;
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(
        /MCP_APP_(CARD_UNAVAILABLE|VIEW_UNAVAILABLE|SERVER_CHANGED)/,
      );
      await rejected;
      expect(f.viewTransport.failure).toBeInstanceOf(Error);
      expect((f.viewTransport.failure as Error).message).toMatch(
        /MCP_APP_(CARD_UNAVAILABLE|VIEW_UNAVAILABLE|SERVER_CHANGED)/,
      );
      expect(dispatched).not.toHaveBeenCalled();
      expect(f.sendMessage).toHaveBeenCalledOnce();
    },
  );

  it('consumes a captured context once and leaves later updates for the next send', async () => {
    const f = await fixture();
    await f.app.updateModelContext({ structuredContent: { draft: 'first' } });
    const first = await f.host.modelContext('task');
    expect(first.text).toContain('first');
    // Reading prepares a send but must not consume data if dispatch later fails.
    expect((await f.host.modelContext('task')).text).toBe(first.text);
    first.consume();
    expect((await f.host.modelContext('task')).text).toBe('');

    await f.app.updateModelContext({ structuredContent: { draft: 'second' } });
    const second = await f.host.modelContext('task');
    await f.app.updateModelContext({ structuredContent: { draft: 'third' } });
    second.consume();
    first.consume();
    const third = await f.host.modelContext('task');
    expect(third.text).toContain('third');
    expect(third.text).not.toContain('second');
    third.consume();
    expect((await f.host.modelContext('task')).text).toBe('');
  });
  it('keeps a newer update even when its contents match the accepted snapshot', async () => {
    const f = await fixture();
    const update = { structuredContent: { draft: 'same' } };
    await f.app.updateModelContext(update);
    const previous = await f.host.modelContext('task');
    await f.app.updateModelContext(update);
    previous.consume();
    const next = await f.host.modelContext('task');
    expect(next.text).toBe(previous.text);
    next.consume();
    expect((await f.host.modelContext('task')).text).toBe('');
  });
  it('supports the stable single-block ui/message shape', async () => {
    const f = await fixture();
    await f.host.dispatch('renderer:1', 'task', f.document.viewId, {
      jsonrpc: '2.0',
      id: 'legacy-message',
      method: 'ui/message',
      params: { role: 'user', content: { type: 'text', text: 'Stable spec' } },
    });
    await vi.waitFor(() =>
      expect(f.sendMessage).toHaveBeenCalledWith('task', expect.anything(), [
        { type: 'text', text: 'Stable spec' },
      ], expect.any(Function)),
    );
  });
  it('opens links on the controller, without forwarding the host action to the View', async () => {
    const f = await fixture();
    await f.app.openLink({ url: 'https://example.org/help' });
    expect(f.openLink).toHaveBeenCalledWith('https://example.org/help');
    await expect(f.app.openLink({ url: 'file:///C:/private' })).rejects.toThrow(
      'MCP_APP_INVALID_LINK',
    );
    expect(f.openLink).toHaveBeenCalledOnce();
  });
  it('host-initiated display changes use context notifications and preserve identity', async () => {
    const f = await fixture();
    await f.app.requestDisplayMode({ mode: 'fullscreen' });
    f.host.displayMode('renderer:1', 'task', f.document.viewId, 'inline');
    await vi.waitFor(() => expect(f.app.getHostContext()?.displayMode).toBe('inline'));
    f.host.context('renderer:1', 'task', f.document.viewId, { locale: 'zh-CN' });
    await vi.waitFor(() =>
      expect(f.app.getHostContext()).toMatchObject({
        theme: 'dark',
        locale: 'zh-CN',
        toolInfo: { id: 'card' },
      }),
    );
  });
  it('returns the actual negotiated display mode and sends host context changes', async () => {
    const f = await fixture('http', { platform: 'mobile' });
    expect(await f.app.requestDisplayMode({ mode: 'fullscreen' })).toEqual({ mode: 'inline' });
    f.host.context('renderer:1', 'task', f.document.viewId, { theme: 'light', locale: 'zh-CN' });
    await vi.waitFor(() =>
      expect(f.app.getHostContext()).toMatchObject({ theme: 'light', locale: 'zh-CN' }),
    );
    const desktop = await fixture();
    expect(await desktop.app.requestDisplayMode({ mode: 'fullscreen' })).toEqual({
      mode: 'fullscreen',
    });
    expect(await desktop.app.requestDisplayMode({ mode: 'pip' })).toEqual({ mode: 'fullscreen' });
  });
  it('delivers cancellation and completes official teardown before disposing the document', async () => {
    const f = await fixture('http', { cancelled: true });
    await vi.waitFor(() => expect(f.messages).toEqual(['input', 'cancelled']));
    await f.host.teardown('renderer:1', 'task', f.document.viewId);
    expect(f.teardown).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledWith(f.document.viewId);
    await expect(f.host.poll('renderer:1', 'task', f.document.viewId, 0)).rejects.toThrow(
      'MCP_APP_VIEW_UNAVAILABLE',
    );
  });
  it('binds requests to the exact task, controller and signed-in owner', async () => {
    const f = await fixture();
    await expect(
      f.host.dispatch('device:other', 'task', f.document.viewId, {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      }),
    ).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
    await expect(f.host.poll('renderer:1', 'another-task', f.document.viewId, 0)).rejects.toThrow(
      'MCP_APP_VIEW_UNAVAILABLE',
    );
    f.changeOwner();
    expect((await f.host.modelContext('task')).text).toBe('');
    await expect(
      f.host.dispatch('renderer:1', 'task', f.document.viewId, {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
      }),
    ).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
  });
  it('revokes a View when its configured server is removed', async () => {
    const f = await fixture();
    f.revoke();
    await expect(
      f.app.callServerTool({ name: 'create_application', arguments: { title: 'x', body: '' } }),
    ).rejects.toThrow('MCP_APP_SERVER_CHANGED');
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('persists the injected private revision through the facade and revokes Views when the key changes', async () => {
    let key = 'a'.repeat(64);
    const f = await fixture('http', { revisionKey: () => key });
    setMcpAppsHost(f.host);
    registerAppServer(f.config.id, () => f.config);
    const facade = createAppServerProxy(() => f.config, {
      agentKind: 'codex', sessionId: 'task', workingDir: '',
    });
    const client = new Client({ name: 'model-client', version: '1' });
    cleanups.push(async () => { await client.close(); await facade.close(); });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await facade.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: 'draft_form', arguments: { title: 'Draft', body: 'Review' } });
    const persisted = f.write.mock.calls.at(-1)![2];
    expect(persisted.serverRevision).toBe(appServerRevision(f.config, key));
    expect(persisted.serverRevision).not.toBe(appServerRevision(f.config));
    key = 'b'.repeat(64);
    await expect(
      f.app.callServerTool({ name: 'create_application', arguments: { title: 'x', body: '' } }),
    ).rejects.toThrow('MCP_APP_SERVER_CHANGED');
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('registers only used model facades and releases their connections on shutdown', async () => {
    const f = await fixture();
    setMcpAppsHost(f.host);
    registerAppServer(f.config.id, () => f.config);
    const register = vi.spyOn(f.host, 'registerConnection');
    const release = vi.spyOn(f.host, 'releaseConnection');
    // Unused first instances from retired bridge generations exceed the Host limit.
    const facades = Array.from({ length: 300 }, () =>
      createAppServerProxy(() => f.config, {
        agentKind: 'codex',
        sessionId: 'task',
        workingDir: '',
      }),
    );
    cleanups.push(async () => {
      await Promise.allSettled(facades.map((facade) => facade.close()));
    });
    expect(register).not.toHaveBeenCalled();

    const facade = facades[facades.length - 1];
    const client = new Client({ name: 'model-client', version: '1' });
    cleanups.push(async () => {
      await client.close();
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await facade.connect(serverTransport);
    await client.connect(clientTransport);
    expect(register).toHaveBeenCalledOnce();
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('draft_form');
    expect(register).toHaveBeenCalledTimes(2);
    const connection = register.mock.calls[0][0];
    expect(connection.isClosed).toBe(false);
    await client.listTools();
    expect(register.mock.results[1].value).toBe(register.mock.results[0].value);
    await facade.close();
    await vi.waitFor(() => expect(connection.isClosed).toBe(true));
    expect(release).toHaveBeenCalledWith(connection);
  });
  it('keeps ordinary MCP requests usable while the persistent App revision vault is unavailable', async () => {
    let vaultAvailable = true;
    const f = await fixture('http', {
      revisionKey: () => {
        if (!vaultAvailable) throw new Error('MCP_APP_REVISION_KEY_UNAVAILABLE');
        return 'a'.repeat(64);
      },
    });
    vaultAvailable = false;
    setMcpAppsHost(f.host);
    registerAppServer(f.config.id, () => f.config);
    const facade = createAppServerProxy(() => f.config, {
      agentKind: 'codex', sessionId: 'task', workingDir: '',
    });
    const client = new Client({ name: 'model-client', version: '1' });
    cleanups.push(async () => { await client.close(); await facade.close(); });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await facade.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(['draft_form', 'model_only']);
    f.write.mockClear();
    expect((await client.callTool({ name: 'model_only', arguments: {} })).isError).not.toBe(true);
    const result = await client.callTool({
      name: 'draft_form', arguments: { title: 'Vault unavailable', body: 'Keep tool execution' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Draft: Vault unavailable' }]);
    expect(result).not.toHaveProperty('_meta');
    expect(f.write).not.toHaveBeenCalled();
    // No transient revision is persisted as a substitute for the inaccessible vault.
    await expect(f.host.open('renderer:1', 'task', 'card', {}))
      .rejects.toThrow('MCP_APP_REVISION_KEY_UNAVAILABLE');
    f.config.url += '/changed';
    await expect(client.listTools()).rejects.toThrow('MCP_APP_SERVER_CHANGED');
  });
  it.each(['http', 'sse'] as const)(
    'preserves upstream instructions in the %s model initialize response',
    async (transport) => {
      const f = await fixture(transport);
      setMcpAppsHost(f.host);
      registerAppServer(f.config.id, () => f.config);
      const facade = createAppServerProxy(() => f.config, {
        agentKind: 'claude-code',
        sessionId: 'task',
        workingDir: '',
      });
      const client = new Client({ name: 'model-client', version: '1' });
      cleanups.push(async () => {
        await client.close();
        await facade.close();
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await facade.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getInstructions()).toBe(serverInstructions);
      expect(client.getServerVersion()).toEqual({ name: f.config.id, version: '1.0.0' });
      expect(client.getServerCapabilities()).toMatchObject({ tools: { listChanged: true } });
      await client.listTools();
      expect(client.getInstructions()).toBe(serverInstructions);
    },
  );
  it('rejects initialization after an owner change without leaving the client waiting', async () => {
    const f = await fixture();
    setMcpAppsHost(f.host);
    registerAppServer(f.config.id, () => f.config);
    const facade = createAppServerProxy(() => f.config, {
      agentKind: 'codex',
      sessionId: 'task',
      workingDir: '',
    });
    const client = new Client({ name: 'model-client', version: '1' });
    cleanups.push(async () => {
      await client.close();
      await facade.close();
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await facade.connect(serverTransport);
    f.changeOwner();
    await expect(client.connect(clientTransport)).rejects.toThrow('MCP_APP_INITIALIZE_FAILED');
  });
  it('the model facade strips UI metadata and never turns card-write failure into tool failure', async () => {
    const f = await fixture();
    setMcpAppsHost(f.host);
    registerAppServer(f.config.id, () => f.config);
    const facade = createAppServerProxy(() => f.config, {
      agentKind: 'codex',
      sessionId: 'task',
      workingDir: '',
    });
    const client = new Client({ name: 'model-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await facade.connect(serverTransport);
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close();
      await facade.close();
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'draft_form',
      'model_only',
    ]);
    f.write.mockRejectedValueOnce(new Error('DB not available'));
    const result = await client.callTool({
      name: 'draft_form',
      arguments: { title: 'x', body: 'y' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Draft: x' }]);
    expect(result).not.toHaveProperty('_meta');
    await expect(
      client.callTool({ name: 'create_application', arguments: { title: 'x', body: 'y' } }),
    ).rejects.toThrow('MCP_APP_TOOL_NOT_VISIBLE');
  });
});
