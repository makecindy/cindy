import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLiziMcpSessionContext } from '@cindy/mcps';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startCodexHttpBridge, withMcpRouteIdentity } from '../../mcp-integrations/codexHttpBridge.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  CompleteRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  SetLevelRequestSchema,
  ResourceUpdatedNotificationSchema,
  LoggingMessageNotificationSchema,
  TaskStatusNotificationSchema,
  GetTaskRequestSchema,
  GetTaskPayloadRequestSchema,
  ListTasksRequestSchema,
  CancelTaskRequestSchema,
  CreateTaskResultSchema,
  GetTaskResultSchema,
  ListTasksResultSchema,
  CallToolResultSchema,
  ResultSchema,
  ListRootsRequestSchema,
  RootsListChangedNotificationSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  isJSONRPCNotification,
  type CallToolRequest,
  type CallToolResult,
  type ListToolsResult,
  type ClientRequest,
  type CompleteRequest,
  type CompleteResult,
  type ServerCapabilities,
  type ClientCapabilities,
  type ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { startMockAppServer } from '../../../../scripts/mcp-apps-mock.mjs';
import { McpAppsHost } from '../host.js';
import { AppToolCancellation } from '../toolCancellation.js';
import { AppConnection } from '../connection.js';
import { createAppServerProxy } from '../serverProxy.js';
import { setMcpAppsHost, registerAppServer, clearAppServerConfigs } from '../runtime.js';

const capabilities: ServerCapabilities = {
  tools: { listChanged: true },
  resources: { listChanged: true, subscribe: true },
  prompts: { listChanged: true },
  completions: {},
  logging: {},
  tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
  experimental: { 'example/custom': {} },
  extensions: { 'example/custom': {} },
};
const task = {
  taskId: 'ordinary-task',
  status: 'completed' as const,
  ttl: 60_000,
  createdAt: '2026-10-15T00:00:00Z',
  lastUpdatedAt: '2026-10-15T00:00:00Z',
};
const completionParams: CompleteRequest['params'] = {
  ref: { type: 'ref/prompt', name: 'plain' },
  argument: { name: 'value', value: 'draft' },
};
const complete =
  vi.fn<(params: CompleteRequest['params'], signal: AbortSignal) => Promise<CompleteResult>>();
const callTool =
  vi.fn<(params: CallToolRequest['params'], signal: AbortSignal) => Promise<CallToolResult>>();
const subscribed = vi.fn(),
  unsubscribed = vi.fn(),
  setLevel = vi.fn();
const upstreams: McpServer[] = [];
const callbackOutcomes = vi.fn();
const cleanup: Array<() => Promise<unknown>> = [];
let endpoint: Awaited<ReturnType<typeof startMockAppServer>>;
let emptyEndpoint: typeof endpoint;

function createPlainServer() {
  const server = new McpServer({ name: 'ordinary-mcp', version: '1' }, { capabilities });
  upstreams.push(server);
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'plain',
        inputSchema: { type: 'object' as const },
        execution: { taskSupport: 'optional' as const },
      },
      {
        name: 'app_only',
        inputSchema: { type: 'object' as const },
        _meta: { ui: { visibility: ['app'] } },
      },
    ],
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    request.params.task ? { task } : callTool(request.params, extra.signal),
  );
  server.server.setRequestHandler(CompleteRequestSchema, async (request, extra) => {
    if (extra._meta?.progressToken !== undefined)
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken: extra._meta.progressToken, progress: 1, total: 1 },
      });
    return complete(request.params, extra.signal);
  });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    subscribed(request.params);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    unsubscribed(request.params);
    return {};
  });
  server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    setLevel(request.params);
    return {};
  });
  server.server.setRequestHandler(GetTaskRequestSchema, async () => task);
  server.server.setRequestHandler(GetTaskPayloadRequestSchema, async () => ({
    content: [{ type: 'text' as const, text: 'task result' }],
  }));
  server.server.setRequestHandler(ListTasksRequestSchema, async () => ({ tasks: [task] }));
  server.server.setRequestHandler(CancelTaskRequestSchema, async () => ({
    ...task,
    status: 'cancelled' as const,
  }));
  server.server.fallbackRequestHandler = async (request, extra) => {
    if (request.method !== 'example/client-callback') return { echo: request.params?.value };
    try {
      const result = await extra.sendRequest(request.params?.request as ServerRequest, ResultSchema, {
        signal: extra.signal,
      });
      callbackOutcomes(server, { result });
      return result;
    } catch (error) {
      callbackOutcomes(server, { error });
      throw error;
    }
  };
  return server;
}

beforeAll(async () => {
  endpoint = await startMockAppServer({ createServer: createPlainServer });
  emptyEndpoint = await startMockAppServer({
    createServer: () => new McpServer({ name: 'empty', version: '1' }),
  });
});
beforeEach(() => {
  callTool.mockReset().mockResolvedValue({ content: [{ type: 'text', text: 'plain result' }] });
  complete
    .mockReset()
    .mockImplementation(async (params) => ({
      completion: { values: [params.argument.value + '-completed'] },
    }));
  subscribed.mockClear();
  unsubscribed.mockClear();
  setLevel.mockClear();
  callbackOutcomes.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  clearAppServerConfigs();
});
afterAll(async () => {
  await endpoint.close();
  await emptyEndpoint.close();
});

async function fixture(
  transport: 'http' | 'sse' = 'http',
  empty = false,
  peer?: { capabilities: ClientCapabilities; configure(client: Client): void },
) {
  const source = empty ? emptyEndpoint : endpoint;
  const config = { id: 'plain', url: transport === 'http' ? source.url : source.sseUrl, transport };
  let owner: object = {};
  const writeCard = vi.fn();
  const host = new McpAppsHost({
    owner: () => owner,
    config: () => config,
    readCard: async () => {
      throw new Error('No App');
    },
    writeCard,
    authorizeTool: async () => {},
    sendMessage: async () => {},
  });
  setMcpAppsHost(host);
  registerAppServer(config.id, () => config);
  const facade = createAppServerProxy(() => config, {
    agentKind: 'codex',
    sessionId: 'task',
    workingDir: '',
  });
  const client = new Client({ name: 'model', version: '1' }, { capabilities: peer?.capabilities ?? {} });
  peer?.configure(client);
  cleanup.push(async () => {
    await client.close();
    await facade.close();
    await host.reset();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await facade.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    clientTransport,
    config,
    writeCard,
    upstream: upstreams.at(-1)!,
    changeOwner: () => {
      owner = {};
    },
    changeConfig: () => {
      registerAppServer(config.id, () => ({
        ...config,
        headers: { 'x-test-revision': 'changed' },
      }));
    },
  };
}

const revocations = ['owner', 'server', 'config'] as const;
function revoke(f: Awaited<ReturnType<typeof fixture>>, kind: (typeof revocations)[number]) {
  if (kind === 'owner') f.changeOwner();
  else if (kind === 'config') f.changeConfig();
  else clearAppServerConfigs();
}

// Sampling/elicitation belong to a client-originating request. Using the SDK's
// related-request stream also avoids racing HTTP's optional standalone SSE GET.
function requestClient(
  f: Awaited<ReturnType<typeof fixture>>,
  request: ServerRequest,
  options?: RequestOptions,
) {
  return f.client.request(
    { method: 'example/client-callback', params: { request } } as unknown as ClientRequest,
    ResultSchema,
    options,
  );
}

describe('ordinary MCP downstream client callbacks', () => {
  const peerCapabilities: ClientCapabilities = {
    roots: { listChanged: true }, sampling: {}, elicitation: { form: {} },
    extensions: { 'example/client': {} },
  };

  it.each(['http', 'sse'] as const)('preserves declared capabilities and callbacks over %s', async (transport) => {
    const roots = vi.fn(async () => ({ roots: [{ uri: 'file:///fixture/project' }] }));
    const sampling = vi.fn(async () => ({
      role: 'assistant' as const, model: 'fixture',
      content: { type: 'text' as const, text: 'sample result' }, stopReason: 'endTurn',
    }));
    const elicit = vi.fn(async () => ({ action: 'accept' as const, content: { confirmed: true } }));
    const f = await fixture(transport, false, {
      capabilities: peerCapabilities,
      configure(client) {
        client.setRequestHandler(ListRootsRequestSchema, roots);
        client.setRequestHandler(CreateMessageRequestSchema, sampling);
        client.setRequestHandler(ElicitRequestSchema, elicit);
      },
    });
    expect(f.upstream.server.getClientCapabilities()).toMatchObject(peerCapabilities);
    expect(f.upstream.server.getClientCapabilities()?.extensions).toHaveProperty('io.modelcontextprotocol/ui');
    await expect(requestClient(f, { method: 'roots/list' })).resolves.toEqual(
      { roots: [{ uri: 'file:///fixture/project' }] },
    );
    await expect(requestClient(f, { method: 'sampling/createMessage', params: {
      messages: [{ role: 'user', content: { type: 'text', text: 'sample request' } }], maxTokens: 10,
    } })).resolves.toMatchObject({ model: 'fixture', content: { text: 'sample result' } });
    await expect(requestClient(f, { method: 'elicitation/create', params: {
      mode: 'form',
      message: 'Confirm fixture', requestedSchema: {
        type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'],
      },
    } })).resolves.toEqual({ action: 'accept', content: { confirmed: true } });
    const changed = vi.fn(async () => {});
    f.upstream.server.setNotificationHandler(RootsListChangedNotificationSchema, changed);
    await f.client.sendRootsListChanged();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(roots).toHaveBeenCalledOnce();
    expect(sampling).toHaveBeenCalledOnce();
    expect(elicit).toHaveBeenCalledOnce();
  });

  it('does not advertise callbacks absent from the downstream client', async () => {
    const f = await fixture();
    const declared = f.upstream.server.getClientCapabilities()!;
    expect(declared.roots).toBeUndefined();
    expect(declared.sampling).toBeUndefined();
    expect(declared.elicitation).toBeUndefined();
    await expect(requestClient(f, { method: 'roots/list' })).rejects.toThrow('Method not found');
  });

  it('routes callbacks only to the facade that negotiated that connection', async () => {
    const firstRoots = vi.fn(async () => ({ roots: [{ uri: 'file:///fixture/first' }] }));
    const secondRoots = vi.fn(async () => ({ roots: [{ uri: 'file:///fixture/second' }] }));
    const first = await fixture('http', false, {
      capabilities: { roots: {} }, configure: client => client.setRequestHandler(ListRootsRequestSchema, firstRoots),
    });
    const second = await fixture('http', false, {
      capabilities: { roots: {} }, configure: client => client.setRequestHandler(ListRootsRequestSchema, secondRoots),
    });
    await expect(requestClient(first, { method: 'roots/list' })).resolves.toEqual(
      { roots: [{ uri: 'file:///fixture/first' }] },
    );
    await expect(requestClient(second, { method: 'roots/list' })).resolves.toEqual(
      { roots: [{ uri: 'file:///fixture/second' }] },
    );
    expect(firstRoots).toHaveBeenCalledOnce();
    expect(secondRoots).toHaveBeenCalledOnce();
  });

  it.each(revocations)('rejects a callback result after %s revocation', async (kind) => {
    let finish!: () => void;
    const roots = vi.fn(() => new Promise<{ roots: [] }>((resolve) => { finish = () => resolve({ roots: [] }); }));
    const f = await fixture('http', false, {
      capabilities: { roots: {} }, configure: client => client.setRequestHandler(ListRootsRequestSchema, roots),
    });
    const pending = requestClient(f, { method: 'roots/list' }).catch(error => error);
    await vi.waitFor(() => expect(finish).toBeDefined());
    revoke(f, kind);
    finish();
    expect(await pending).toHaveProperty('message', expect.stringContaining('MCP_APP_'));
    // The callback result itself must be withheld from the upstream server,
    // not only rejected later at the outer model response boundary.
    expect(callbackOutcomes).toHaveBeenLastCalledWith(f.upstream, {
      error: expect.objectContaining({ message: expect.stringContaining('MCP_APP_') }),
    });
    expect(roots).toHaveBeenCalledOnce();
    await expect(requestClient(f, { method: 'roots/list' })).rejects.toThrow('MCP_APP_');
    expect(roots).toHaveBeenCalledOnce();
  });

  it.each([0, 1])('forwards callback cancellation for request ID %s without replaying it', async (prior) => {
    const cancelled = vi.fn();
    let finish!: () => void;
    const roots = vi.fn((_request: unknown, extra: { signal: AbortSignal }) => new Promise<{ roots: [] }>((resolve) => {
      finish = () => resolve({ roots: [] });
      extra.signal.addEventListener('abort', () => { cancelled(); resolve({ roots: [] }); }, { once: true });
    }));
    const f = await fixture('http', false, {
      capabilities: { roots: {} }, configure: client => client.setRequestHandler(ListRootsRequestSchema, roots),
    });
    for (let index = 0; index < prior; index++) {
      roots.mockResolvedValueOnce({ roots: [] });
      await requestClient(f, { method: 'roots/list' });
    }
    const cancellation = vi.fn();
    const onmessage = f.clientTransport.onmessage!;
    f.clientTransport.onmessage = (message, extra) => {
      if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled')
        cancellation(message.params);
      onmessage(message, extra);
    };
    const abort = new AbortController();
    const pending = requestClient(f, { method: 'roots/list' }, { signal: abort.signal }).catch(error => error);
    await vi.waitFor(() => expect(roots).toHaveBeenCalledTimes(prior + 1));
    abort.abort();
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(cancellation).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: prior }),
    ));
    // The test peer is SDK 1.29, whose default cancellation handler ignores ID
    // 0. Check the actual wire notification for both IDs and its signal for 1.
    if (prior !== 0) await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    finish();
    expect(roots).toHaveBeenCalledTimes(prior + 1);
  });
});

describe('ordinary MCP compatibility through the App facade', () => {
  it.each(['http', 'sse'] as const)(
    'preserves upstream capabilities, completion/progress, subscriptions and logging over %s',
    async (transport) => {
      const f = await fixture(transport);
      expect(f.client.getServerCapabilities()).toEqual(capabilities);
      const progress = vi.fn();
      let finish!: () => void;
      // SSE may deliver progress and the final response in one socket chunk. The
      // SDK handles notifications asynchronously, so keep this request in flight
      // until the model has observed progress instead of relying on socket timing.
      complete.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ completion: { values: ['draft-completed'] } });
          }),
      );
      const completion = f.client.complete(completionParams, { onprogress: progress });
      await vi.waitFor(() => expect(progress).toHaveBeenCalledWith({ progress: 1, total: 1 }));
      finish();
      expect(await completion).toEqual({ completion: { values: ['draft-completed'] } });
      const updates = vi.fn(),
        logs = vi.fn();
      f.client.setNotificationHandler(ResourceUpdatedNotificationSchema, updates);
      f.client.setNotificationHandler(LoggingMessageNotificationSchema, logs);
      await f.client.subscribeResource({ uri: 'resource://plain' });
      expect(subscribed).toHaveBeenCalledWith({ uri: 'resource://plain' });
      await f.upstream.server.sendResourceUpdated({ uri: 'resource://plain' });
      await vi.waitFor(() =>
        expect(updates).toHaveBeenCalledWith(
          expect.objectContaining({ params: { uri: 'resource://plain' } }),
        ),
      );
      await f.client.unsubscribeResource({ uri: 'resource://plain' });
      expect(unsubscribed).toHaveBeenCalledWith({ uri: 'resource://plain' });
      await f.client.setLoggingLevel('info');
      expect(setLevel).toHaveBeenCalledWith({ level: 'info' });
      await f.upstream.server.notification({
        method: 'notifications/message',
        params: { level: 'info', data: 'ordinary notification' },
      });
      await vi.waitFor(() =>
        expect(logs).toHaveBeenCalledWith(
          expect.objectContaining({ params: { level: 'info', data: 'ordinary notification' } }),
        ),
      );
      expect(
        await f.client.request(
        // SDK ClientRequest enumerates standard methods; this advertised extension is custom.
        { method: 'example/echo', params: { value: 'custom' } } as unknown as ClientRequest,
          ResultSchema,
        ),
      ).toEqual({ echo: 'custom' });
      expect(f.writeCard).not.toHaveBeenCalled();
    },
  );

  it('advertises only capabilities actually supplied by the upstream server', async () => {
    const f = await fixture('http', true);
    expect(f.client.getServerCapabilities()).toEqual({});
  });

  it('preserves task-augmented tools and task methods while enforcing model visibility', async () => {
    const f = await fixture();
    const status = vi.fn();
    f.client.setNotificationHandler(TaskStatusNotificationSchema, status);
    expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual(['plain']);
    expect(
      await f.client.request(
        { method: 'tools/call', params: { name: 'plain', task: { ttl: 60_000 } } },
        CreateTaskResultSchema,
      ),
    ).toEqual({ task });
    expect(
      await f.client.request(
        { method: 'tasks/get', params: { taskId: task.taskId } },
        GetTaskResultSchema,
      ),
    ).toEqual(task);
    expect(
      await f.client.request(
        { method: 'tasks/result', params: { taskId: task.taskId } },
        CallToolResultSchema,
      ),
    ).toEqual({ content: [{ type: 'text', text: 'task result' }] });
    expect(await f.client.request({ method: 'tasks/list' }, ListTasksResultSchema)).toEqual({
      tasks: [task],
    });
    expect(
      await f.client.request(
        { method: 'tasks/cancel', params: { taskId: task.taskId } },
        GetTaskResultSchema,
      ),
    ).toMatchObject({ status: 'cancelled' });
    await f.upstream.server.notification({ method: 'notifications/tasks/status', params: task });
    await vi.waitFor(() =>
      expect(status).toHaveBeenCalledWith(expect.objectContaining({ params: task })),
    );
    await expect(
      f.client.request(
        { method: 'tools/call', params: { name: 'app_only', task: { ttl: 60_000 } } },
        CreateTaskResultSchema,
      ),
    ).rejects.toThrow('MCP_APP_TOOL_NOT_VISIBLE');
    expect(f.writeCard).not.toHaveBeenCalled();
  });

  it.each(['http', 'sse'] as const)(
    'withholds View-only metadata from synchronous and task tool results over %s',
    async (transport) => {
      const f = await fixture(transport);
      const publicResult = {
        content: [{ type: 'text' as const, text: 'Public result', _meta: { publicBlock: true } }],
        structuredContent: { completed: false, _meta: { publicStructured: true } },
        isError: true,
        extension: 'public extension',
      };
      const result = { ...publicResult, _meta: { viewOnly: 'private task result' } };
      callTool.mockResolvedValueOnce(result);
      f.upstream.server.setRequestHandler(GetTaskPayloadRequestSchema, async () => result);

      await expect(f.client.callTool({ name: 'plain' })).resolves.toEqual(publicResult);
      await expect(
        f.client.request(
          { method: 'tools/call', params: { name: 'plain', task: { ttl: 60_000 } } },
          CreateTaskResultSchema,
        ),
      ).resolves.toEqual({ task });
      await expect(
        f.client.request(
          { method: 'tasks/result', params: { taskId: task.taskId } },
          CallToolResultSchema,
        ),
      ).resolves.toEqual(publicResult);
      expect(result._meta).toEqual({ viewOnly: 'private task result' });
      expect(f.writeCard).not.toHaveBeenCalled();
    },
  );

  it('preserves protocol metadata on ordinary forwarded task status results', async () => {
    const f = await fixture();
    const status = { ...task, _meta: { 'example/status': 'public protocol metadata' } };
    f.upstream.server.setRequestHandler(GetTaskRequestSchema, async () => status);
    await expect(
      f.client.request(
        { method: 'tasks/get', params: { taskId: task.taskId } },
        GetTaskResultSchema,
      ),
    ).resolves.toEqual(status);
  });

  it.each(revocations)(
    'rejects a late task tool result after %s revocation without replay',
    async (kind) => {
      const f = await fixture();
      let finish!: () => void;
      const retrieve = vi.fn(
        () =>
          new Promise<CallToolResult>((resolve) => {
            finish = () =>
              resolve({
                content: [{ type: 'text', text: 'Late task result' }],
                _meta: { viewOnly: 'private task result' },
              });
          }),
      );
      f.upstream.server.setRequestHandler(GetTaskPayloadRequestSchema, retrieve);
      const readResult = () =>
        f.client.request(
          { method: 'tasks/result', params: { taskId: task.taskId } },
          CallToolResultSchema,
        );
      const error = kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED';
      const rejected = expect(readResult()).rejects.toThrow(error);
      await vi.waitFor(() => expect(finish).toBeDefined());
      revoke(f, kind);
      finish();
      await rejected;
      await expect(readResult()).rejects.toThrow(error);
      expect(retrieve).toHaveBeenCalledOnce();
      expect(f.writeCard).not.toHaveBeenCalled();
    },
  );

  it.each(['owner', 'server'] as const)(
    'rejects late completion results and new calls after %s revocation',
    async (kind) => {
      const f = await fixture();
      let finish!: () => void;
      complete.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ completion: { values: ['late'] } });
          }),
      );
      const pending = f.client.complete(completionParams);
      const rejected = expect(pending).rejects.toThrow(
        kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED',
      );
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (kind === 'owner') f.changeOwner();
      else clearAppServerConfigs();
      finish();
      await rejected;
      await expect(f.client.subscribeResource({ uri: 'resource://plain' })).rejects.toThrow(
        kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED',
      );
      expect(subscribed).not.toHaveBeenCalled();
    },
  );

  it.each(revocations)(
    'does not execute a tool after %s revocation while acquiring its client',
    async (kind) => {
      const f = await fixture();
      const original = AppConnection.prototype.getClient;
      let finish!: () => void;
      vi.spyOn(AppConnection.prototype, 'getClient')
        // Tool discovery still uses the live client. Hold the separate acquisition
        // for execution to simulate a reconnect completing after revocation.
        .mockImplementationOnce(original)
        .mockImplementationOnce(function (this: AppConnection) {
          return new Promise<Client>((resolve, reject) => {
            finish = () => {
              void original.call(this).then(resolve, reject);
            };
          });
        });
      const rejected = expect(f.client.callTool({ name: 'plain' })).rejects.toThrow(
        kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED',
      );
      await vi.waitFor(() => expect(finish).toBeDefined());
      revoke(f, kind);
      finish();
      await rejected;
      expect(callTool).not.toHaveBeenCalled();
      expect(f.writeCard).not.toHaveBeenCalled();
    },
  );

  it.each(revocations)(
    'rejects a late ordinary tool result after %s revocation without replay',
    async (kind) => {
      const f = await fixture();
      let finish!: () => void;
      callTool.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ content: [{ type: 'text', text: 'late result' }] });
          }),
      );
      const rejected = expect(f.client.callTool({ name: 'plain' })).rejects.toThrow(
        kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED',
      );
      await vi.waitFor(() => expect(finish).toBeDefined());
      revoke(f, kind);
      finish();
      await rejected;
      await expect(f.client.callTool({ name: 'plain' })).rejects.toThrow(
        kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED',
      );
      expect(callTool).toHaveBeenCalledOnce();
      expect(f.writeCard).not.toHaveBeenCalled();
    },
  );

  it.each(revocations)(
    'rejects the model result after %s revocation during App result persistence',
    async (kind) => {
      const f = await fixture();
      f.upstream.server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'plain',
            inputSchema: { type: 'object' as const },
            _meta: { ui: { resourceUri: 'ui://plain' }, 'cindy/plugin': { name: 'Forged', trust: 'cindy-official' } },
          },
        ],
      }));
      let finish!: () => void;
      f.writeCard
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
      const rejected = expect(f.client.callTool({ name: 'plain' })).rejects.toThrow(
        kind === 'owner' ? 'MCP_APP_OWNER_CHANGED' : 'MCP_APP_SERVER_CHANGED',
      );
      await vi.waitFor(() => expect(f.writeCard).toHaveBeenCalledTimes(2));
      revoke(f, kind);
      finish();
      await rejected;
      expect(callTool).toHaveBeenCalledOnce();
      expect(f.writeCard).toHaveBeenCalledTimes(2);
      for (const [, , record] of f.writeCard.mock.calls)
        expect(record.tool._meta).not.toHaveProperty('cindy/plugin');
    },
  );

  it.each(
    (['http', 'sse'] as const).flatMap((transport) =>
      (['tools/list', 'tools/call'] as const).flatMap((method) =>
        [0, 1].map((page) => ({ transport, method, page })),
      ),
    ),
  )('cancels $transport $method discovery on page $page without executing or replaying a tool', async ({ transport, method, page }) => {
    const f = await fixture(transport);
    const tool = { name: 'plain', inputSchema: { type: 'object' as const } };
    const discovered = vi.fn();
    const cancelled = vi.fn();
    let release: (() => void) | undefined;
    cleanup.push(async () => release?.());
    f.upstream.server.setRequestHandler(ListToolsRequestSchema, (request, extra) => {
      discovered(request.params?.cursor);
      if (page === 1 && !request.params?.cursor)
        return { tools: [tool], nextCursor: 'next' };
      return new Promise<ListToolsResult>((resolve, reject) => {
        release = () => resolve({ tools: [] });
        extra.signal.addEventListener('abort', () => {
          cancelled();
          reject(new Error('discovery cancelled'));
        }, { once: true });
      });
    });
    const abort = new AbortController();
    const pending = method === 'tools/list'
      ? f.client.listTools(undefined, { signal: abort.signal })
      : f.client.callTool({ name: 'plain' }, CallToolResultSchema, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(discovered).toHaveBeenCalledTimes(page + 1);
    if (page === 1) expect(discovered).toHaveBeenLastCalledWith('next');
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(discovered).toHaveBeenCalledTimes(page + 1);
    expect(callTool).not.toHaveBeenCalled();
    expect(f.writeCard).not.toHaveBeenCalled();

    // Cancelling discovery must leave the connection usable for a new request.
    f.upstream.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
    await expect(f.client.listTools()).resolves.toMatchObject({ tools: [tool] });
    await expect(f.client.callTool({ name: 'plain' })).resolves.toMatchObject({
      content: [{ type: 'text', text: 'plain result' }],
    });
    expect(callTool).toHaveBeenCalledOnce();
  });

  it.each(['http', 'sse'] as const)('cancels an ordinary %s request waiting for reconnect without disturbing another waiter', async (transport) => {
    const acquiring = vi.spyOn(AppConnection.prototype, 'getClient');
    const f = await fixture(transport);
    const initialClient = await acquiring.mock.results[0]!.value as Client;
    await initialClient.close();
    const before = acquiring.mock.calls.length;
    const connect = Client.prototype.connect;
    let release: (() => void) | undefined;
    cleanup.push(async () => release?.());
    // Hold the next real connection attempt before its handshake; the
    // AppConnection's shared-attempt and per-waiter cancellation remain real.
    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(function (this: Client, ...args: Parameters<Client['connect']>) {
      return new Promise<void>((resolve, reject) => {
        release = () => {
          release = undefined;
          void connect.call(this, ...args).then(resolve, reject);
        };
      });
    });
    const abort = new AbortController();
    const pending = f.client.complete(completionParams, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(release).toBeDefined());
    const cancelled = vi.fn();
    const waiter = acquiring.mock.results.at(-1)!.value as Promise<Client>;
    void waiter.catch(cancelled);
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(complete).not.toHaveBeenCalled();

    const healthy = f.client.complete(completionParams);
    const completed = expect(healthy).resolves.toMatchObject({
      completion: { values: ['draft-completed'] },
    });
    await vi.waitFor(() => expect(acquiring).toHaveBeenCalledTimes(before + 2));
    release!();
    await completed;
    expect(complete).toHaveBeenCalledOnce();
  });

  it('forwards cancellation to the single upstream request without replaying it', async () => {
    const f = await fixture();
    const cancelled = vi.fn();
    complete.mockImplementationOnce(
      (_params, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled();
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
    );
    const abort = new AbortController();
    const pending = f.client.complete(completionParams, { signal: abort.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
    expect(complete).toHaveBeenCalledOnce();
  });
});

// L09: unit regression through the real HTTP bridge + App facade + upstream SDK.
// Previous client-cancellation tests never stopped a Cindy task without native MCP cancellation.
// Minimal failure: two concurrent tools/call requests, interrupt ACK for only one task.
describe('Codex acknowledged user stop', () => {
  it('keeps catalog discovery alive but never starts a stopped tool after discovery returns', async () => {
    const f = await fixture();
    const calls = new AppToolCancellation();
    const identity = { sessionId: 'task', sessionInstanceId: 'instance', threadId: 'thread' };
    let catalogSignal: AbortSignal | undefined;
    let finishCatalog!: () => void;
    f.upstream.server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => new Promise(resolve => {
      catalogSignal = extra.signal;
      finishCatalog = () => resolve({ tools: [{ name: 'plain', inputSchema: { type: 'object' } }] });
    }));
    const outcome = calls.run(identity, () => f.client.callTool({ name: 'plain' })).catch(error => error);
    await vi.waitFor(() => expect(catalogSignal).toBeDefined());
    calls.prepare(identity, () => true)();
    finishCatalog();
    expect(await outcome).toBeInstanceOf(Error);
    expect(catalogSignal!.aborted).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('cancels only captured App tool calls for the exact task instance and thread', async () => {
    const f = await fixture();
    const running = new Map<string, { signal: AbortSignal; finish: () => void }>();
    callTool.mockImplementation((params, signal) => new Promise((resolve, reject) => {
      running.set(String(params.arguments?.tag), { signal, finish: () => resolve({ content: [] }) });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    let completeSignal: AbortSignal | undefined;
    let finishComplete!: () => void;
    complete.mockImplementation((_params, signal) => new Promise(resolve => {
      completeSignal = signal; finishComplete = () => resolve({ completion: { values: [] } });
    }));
    const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
    const bridge = await startCodexHttpBridge({
      logger: log, appServerNames: ['plain'], serverFactories: {
        plain: () => createAppServerProxy(() => f.config, {
          agentKind: 'codex', workingDir: '', getSessionContext: () => {
            const active = getLiziMcpSessionContext();
            return active ? { agentKind: 'codex', workingDir: active.workingDir, sessionId: active.sessionId,
              sessionInstanceId: active.sessionInstanceId, vendorOptions: active.vendorOptions } : undefined;
          },
        }),
        cindy_helper: createPlainServer,
      },
    });
    cleanup.push(() => bridge.shutdown());
    const a = { agentKind: 'codex' as const, workingDir: '', sessionId: 'a', sessionInstanceId: 'a-one' };
    const b = { ...a, sessionId: 'b', sessionInstanceId: 'b-one' };
    bridge.registerThreadContext('a-root', a);
    bridge.registerThreadContext('a-child', a);
    bridge.registerThreadContext('b-root', b);
    const connect = async (name: string, ctx: typeof a) => {
      const client = new Client({ name: 'codex-stop', version: '1' });
      cleanup.push(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(withMcpRouteIdentity(bridge.url(name), {
        sessionInstanceId: ctx.sessionInstanceId,
      })), { requestInit: { headers: { Authorization: 'Bearer ' + bridge.token } } }));
      return client;
    };
    const [clientA, clientB, builtin] = await Promise.all([connect('plain', a), connect('plain', b), connect('cindy_helper', a)]);
    const call = (client: Client, tag: string, threadId: string) => client.callTool({
      name: 'plain', arguments: { tag }, _meta: { threadId },
    }).then(result => ({ result }), error => ({ error }));
    const first = call(clientA, 'first', 'a-root');
    const others = [call(clientA, 'child', 'a-child'), call(clientB, 'other', 'b-root'), call(builtin, 'builtin', 'a-root')];
    const completion = clientA.complete({ ...completionParams, _meta: { threadId: 'a-root' } });
    await vi.waitFor(() => { expect(running.size).toBe(4); expect(completeSignal).toBeDefined(); });
    const identity = { sessionId: a.sessionId, sessionInstanceId: a.sessionInstanceId, threadId: 'a-root' };
    bridge.prepareToolCancellation({ ...identity, sessionInstanceId: 'stale' })();
    expect(running.get('first')!.signal.aborted).toBe(false);
    const confirmed = bridge.prepareToolCancellation(identity);
    // A new turn may already have started when the previous interrupt ACK arrives.
    others.push(call(clientA, 'later', 'a-root'));
    await vi.waitFor(() => expect(running.size).toBe(5));
    confirmed(); confirmed();
    expect(await first).toMatchObject({ error: expect.any(Error) });
    await vi.waitFor(() => expect(running.get('first')!.signal.aborted).toBe(true));
    for (const tag of ['child', 'other', 'builtin', 'later']) expect(running.get(tag)!.signal.aborted).toBe(false);
    expect(completeSignal!.aborted).toBe(false);
    const stale = bridge.prepareToolCancellation(identity);
    bridge.registerThreadContext('a-root', { ...a, sessionInstanceId: 'a-two' });
    stale();
    expect(running.get('later')!.signal.aborted).toBe(false);
    for (const [tag, operation] of running) if (tag !== 'first') operation.finish();
    finishComplete();
    expect((await Promise.all(others)).every(result => 'result' in result)).toBe(true);
    await completion;
  });
});
