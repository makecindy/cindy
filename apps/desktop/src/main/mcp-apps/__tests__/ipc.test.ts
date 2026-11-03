import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQL } from 'drizzle-orm';
import type { McpAppsHostDeps } from '../host.js';
const state = vi.hoisted(() => ({
  owner: null as object | null,
  deps: undefined as McpAppsHostDeps | undefined,
  session: {
    id: 'task',
    status: 'active',
    clearedAt: null as number | null,
    permissionMode: 'default',
    planModeEnabled: false,
  },
  row: null as Record<string, unknown> | null,
  updateResult: [] as Record<string, unknown>[],
  predicates: [] as SQL[],
  duringUpdate: () => {},
  beforePublish: () => {},
  broadcast: vi.fn(),
  create: vi.fn(),
  trusted: vi.fn(),
  invoke: vi.fn(),
  open: vi.fn(),
  dispatch: vi.fn(),
  revisionKey: vi.fn(() => 'a'.repeat(64)),
  remote: undefined as { controllerDeviceId: string; sharedTask?: object } | undefined,
  handle: undefined as
    ((event: unknown, session: unknown, input: unknown) => Promise<unknown>) | undefined,
}));
vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: (_name: string, handler: typeof state.handle) => {
      state.handle = handler;
    },
  },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../host.js', () => ({
  appServerRevision: (config: unknown) => JSON.stringify(config),
  McpAppsHost: class {
    open = state.open;
    dispatch = state.dispatch;
    constructor(deps: McpAppsHostDeps) {
      state.deps = deps;
    }
  },
}));
vi.mock('../runtime.js', () => ({ setMcpAppsHost: vi.fn(), readAppServer: vi.fn() }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ getMcpAppRevisionKey: state.revisionKey }));
vi.mock('../sandboxProtocol.js', () => ({
  supplyMcpAppDocument: vi.fn(),
  removeMcpAppDocument: vi.fn(),
  mountRemoteAppDocument: vi.fn(),
  unmountRemoteAppDocument: vi.fn(),
  assertMcpAppDocumentCaller: vi.fn(),
  setMcpAppCallerCleanup: vi.fn(),
  setMcpAppFileReader: vi.fn(),
}));
vi.mock('../../device-link/index.js', () => ({ remoteInvoke: state.invoke, getRemoteLinkCloseEpoch: () => 0 }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseDeviceLink: true }) }));
vi.mock('../../localDb/client/current.js', () => ({
  getCurrentDbClientSnapshot: () => state.owner,
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  broadcastMessageRow: state.broadcast,
  createMessage: (...args: unknown[]) => state.create(...args),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ owner: state.owner }),
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: state.trusted,
}));
vi.mock('../../device-link/invoke-context.js', () => ({
  getDeviceLinkInvokeContext: () => state.remote,
}));
import { sessions } from '../../localDb/schema.js';
import { readAppServer } from '../runtime.js';
import { pagePermissionGrants, pagePermissionSessionChanged } from '../pagePermissions.js';
import { registerMcpAppsIpc } from '../ipc.js';
import { mountRemoteAppDocument } from '../sandboxProtocol.js';
const record = {
  version: 1 as const,
  serverId: 'example',
  serverRevision: 'revision',
  resourceUri: 'ui://example/app',
  tool: { name: 'form', inputSchema: { type: 'object' as const } },
  arguments: {},
};
const request = vi.fn(async () => ({ kind: 'permission' as const, behavior: 'allow' as const }));
beforeEach(() => {
  vi.clearAllMocks();
  pagePermissionGrants.clearServers();
  vi.mocked(readAppServer).mockReturnValue({ id: 'example', url: 'https://example.com/mcp', transport: 'http' });
  state.remote = undefined;
  state.predicates = [];
  state.duringUpdate = () => {};
  state.beforePublish = () => {};
  state.session = { id: 'task', status: 'active', clearedAt: null, permissionMode: 'default', planModeEnabled: false };
  state.row = {
    id: 'row',
    sessionId: 'task',
    clientId: 'card',
    createdAt: 200,
    role: 'assistant',
    rewindAt: null,
    agentMeta: JSON.stringify({ mcpApp: true }),
    content: JSON.stringify({ mcpApp: record }),
  };
  state.updateResult = [state.row];
  state.owner = {
    client: {
      drizzle: {
        select: () => ({
          from: (table: unknown) => ({
            where: (condition: SQL) => ({
              limit: async () => {
                state.predicates.push(condition);
                return table === sessions
                  ? [state.session]
                  : state.row
                    ? [{ ...state.row, meta: state.row.agentMeta }]
                    : [];
              },
            }),
          }),
        }),
        update: () => ({
          set: () => ({
            where: (condition: SQL) => ({
              returning: async () => {
                state.predicates.push(condition);
                state.duringUpdate();
                return state.updateResult;
              },
            }),
          }),
        }),
      },
    },
  };
  state.create.mockImplementation(
    async (_id: string, _body: unknown, options: { beforePublish: () => Promise<void> }) => {
      state.beforePublish();
      await options.beforePublish();
    },
  );
  registerMcpAppsIpc(async () => {}, request);
});
describe('MCP App persistence and IPC wiring', () => {
  it('injects the persistent vault key lazily instead of using a transient Host key', () => {
    expect(state.revisionKey).not.toHaveBeenCalled();
    expect(state.deps!.revisionKey!()).toBe('a'.repeat(64));
    expect(state.revisionKey).toHaveBeenCalledOnce();
  });
  it('reads only host-marked visible assistant cards and uses the task clear boundary', async () => {
    state.session.clearedAt = 100;
    expect(await state.deps!.readCard('task', 'card')).toEqual(record);
    const query = new SQLiteSyncDialect().sqlToQuery(state.predicates[1]);
    expect(query.params).toContain('assistant');
    expect(query.sql).toContain('sessions.cleared_at');
    expect(query.sql).toContain('EXISTS');
    expect(query.sql).toContain('rewind_at');
    state.row!.agentMeta = '{}';
    await expect(state.deps!.readCard('task', 'card')).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
  });
  it('uses a guarded update and broadcasts only a successful same-owner result', async () => {
    await state.deps!.writeCard('task', 'card', record);
    expect(state.broadcast).toHaveBeenCalledOnce();
    const query = new SQLiteSyncDialect().sqlToQuery(state.predicates.at(-1)!);
    expect(query.sql).toContain('EXISTS');
    expect(query.sql).toContain("sessions.status = 'active'");
    expect(query.sql).toContain('sessions.cleared_at');
    expect(query.sql).toContain('rewind_at');
    state.broadcast.mockClear();
    state.updateResult = [];
    await expect(state.deps!.writeCard('task', 'card', record)).rejects.toThrow(
      'MCP_APP_CARD_UNAVAILABLE',
    );
    expect(state.broadcast).not.toHaveBeenCalled();
  });
  it('rejects owner changes after asynchronous writes without publishing their result', async () => {
    state.duringUpdate = () => {
      state.owner = {};
    };
    await expect(state.deps!.writeCard('task', 'card', record)).rejects.toThrow(
      'MCP_APP_CARD_UNAVAILABLE',
    );
    expect(state.broadcast).not.toHaveBeenCalled();
  });
  it('fences creation before publication when the task is cleared', async () => {
    state.row = null;
    state.beforePublish = () => {
      state.session = { ...state.session, clearedAt: 300 };
    };
    await expect(state.deps!.writeCard('task', 'card', record)).rejects.toThrow(
      'MCP_APP_CARD_UNAVAILABLE',
    );
    expect(state.create).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({ agentMeta: { mcpApp: true } }),
      expect.objectContaining({ beforePublish: expect.any(Function) }),
    );
    expect(state.create.mock.calls[0][2]).not.toHaveProperty('expectedClearBoundaryMs');
  });
  it.each([
    { result: { content: [{ type: 'text' as const, text: 'Late result' }] } },
    { cancelled: 'Tool execution cancelled' },
  ])('does not recreate a deleted card when completion arrives: %j', async (completion) => {
    state.row = null;
    await expect(
      state.deps!.writeCard('task', 'card', { ...record, ...completion }),
    ).rejects.toThrow('MCP_APP_CARD_UNAVAILABLE');
    expect(state.create).not.toHaveBeenCalled();
    expect(state.broadcast).not.toHaveBeenCalled();
  });
  it('keeps View-only MCP App results in Main while broadcasting public history', async () => {
    const full = { ...record,
      arguments: { private: 'app-input' },
      result: {
        content: [{ type: 'text', text: 'Saved result', _meta: { private: 'block' } }],
        structuredContent: { private: 'structured' },
        _meta: { private: 'view-only' },
      },
    };
    state.row!.content = JSON.stringify({ mcpApp: full });
    state.updateResult = [state.row!];
    await state.deps!.writeCard('task', 'card', full);
    expect(state.broadcast.mock.calls[0]![1].content).toEqual({
      mcpAppHistory: { version: 1, title: 'form', text: 'Saved result' },
    });
    expect(await state.deps!.readCard('task', 'card')).toEqual(full);
    expect(JSON.parse(state.row!.content as string)).toEqual({ mcpApp: full });
  });
  it('allows a new pending card to be created before tool execution', async () => {
    state.row = null;
    await state.deps!.writeCard('task', 'card', record);
    expect(state.create).toHaveBeenCalledWith(
      'task',
      { clientId: 'card', role: 'assistant', content: { mcpApp: record }, agentMeta: { mcpApp: true } },
      expect.objectContaining({ beforePublish: expect.any(Function) }),
    );
  });
  it('blocks archived tasks and checks tool permission through the existing approval route', async () => {
    state.session.status = 'archived';
    await expect(state.deps!.readCard('task', 'card')).rejects.toThrow(
      'MCP_APP_SESSION_UNAVAILABLE',
    );
    state.session.status = 'active';
    await state.deps!.authorizeTool(
      'task',
      record.tool,
      { title: 'edited' },
      new AbortController().signal,
    );
    expect(request).toHaveBeenCalledWith(
      'task',
      expect.objectContaining({
        kind: 'permission',
        toolName: 'MCP App: form',
        input: { title: 'edited' },
      }),
      expect.any(AbortSignal),
    );
    state.session.permissionMode = 'bypassPermissions';
    request.mockClear();
    await state.deps!.authorizeTool('task', record.tool, {}, new AbortController().signal);
    expect(request).not.toHaveBeenCalled();
  });
  it('checks a real local sender, refuses shared-task guests, and returns only public errors', async () => {
    await expect(
      state.handle!({ sender: { id: 1 } }, 'task', { op: 'unknown', secret: 'must-not-return' }),
    ).rejects.toThrow('[PRECONDITION_FAILED] MCP_APP_INVALID_REQUEST');
    expect(state.trusted).toHaveBeenCalledOnce();
    state.remote = { controllerDeviceId: 'guest', sharedTask: {} };
    await expect(state.handle!({}, 'task', { op: 'open', clientId: 'card' })).rejects.toThrow(
      'MCP_APP_OWNER_ONLY',
    );
  });
  it('routes remote cards through the dedicated Main control boundary and forbids remote relay pivots', async () => {
    const event = { sender: { id: 1 } };
    await expect(state.handle!(event, 'task', {
      deviceId: 'other-computer', op: 'message', viewId: 'remote-view',
      message: { jsonrpc: '2.0', id: 1, method: 'tools/call' },
    })).rejects.toThrow('MCP_APP_FRAME_REQUIRED');
    expect(state.trusted).toHaveBeenCalledOnce();
    expect(state.invoke).not.toHaveBeenCalled();
    state.remote = { controllerDeviceId: 'phone' };
    await expect(state.handle!({}, 'task', { deviceId: 'other-computer', op: 'open', clientId: 'card' }))
      .rejects.toThrow('MCP_APP_INVALID_REQUEST');
    expect(state.invoke).not.toHaveBeenCalled();
  });
  it('keeps remote RPCs in Main while preserving the incoming Mobile Host contract', async () => {
    const document = { viewId: 'remote-view', html: '<p>Private App</p>', csp: "default-src 'none'",
      prefersBorder: true, policy: { connectDomains: ['https://private-app.example.invalid'] } };
    state.invoke.mockImplementation(async (_device, _channel, _args, options) => {
      options.preSend();
      return { ok: true, result: document };
    });
    vi.mocked(mountRemoteAppDocument).mockReturnValueOnce('local-view');
    expect(await state.handle!({ sender: { id: 1 } }, 'task', {
      deviceId: 'other-computer', op: 'open', clientId: 'card', openId: 'attempt',
    })).toEqual({ viewId: 'local-view', transport: 'sandbox', prefersBorder: true });
    const message = { jsonrpc: '2.0', id: 2, method: 'tools/call' };
    const frame = vi.mocked(mountRemoteAppDocument).mock.calls.at(-1)![2]!;
    await frame({ op: 'message', viewId: 'forged', message });
    expect(state.invoke).toHaveBeenLastCalledWith('other-computer', 'maker:mcp-apps:v1',
      ['task', { op: 'message', viewId: 'remote-view', message }], { preSend: expect.any(Function) });

    state.open.mockResolvedValue(document);
    expect(await state.handle!({ sender: { id: 1 } }, 'task', { op: 'open', clientId: 'card' }))
      .toEqual({ viewId: 'remote-view', transport: 'sandbox', prefersBorder: true });

    // Mobile still reaches the execution Host over the existing same-account channel.
    state.remote = { controllerDeviceId: 'phone' };
    state.open.mockResolvedValue(document);
    expect(await state.handle!({}, 'task', { op: 'open', clientId: 'card' })).toEqual(document);
    expect(state.open).toHaveBeenCalledWith('device:phone', 'task', 'card', {}, undefined);
    await state.handle!({}, 'task', { op: 'message', viewId: 'remote-view', message });
    expect(state.dispatch).toHaveBeenCalledWith('device:phone', 'task', 'remote-view', message);
  });
});

// unit: page tools must use existing Auto-review, not always prompt. Minimal input:
// one custom MCP call in auto mode, with each possible reviewer decision.
it.each(['allow', 'block', 'ask'] as const)('routes page approval through Auto (%s)', async verdict => {
  state.session.permissionMode = 'auto';
  const review = vi.fn(async () => ({ verdict }));
  registerMcpAppsIpc(async () => {}, request, review);
  const result = state.deps!.authorizeTool('task', record.tool, { value: 3 }, new AbortController().signal,
    { clientId: 'card', serverId: 'custom', title: 'Planner' });
  if (verdict === 'block') await expect(result).rejects.toThrow('MCP_APP_TOOL_DENIED');
  else await result;
  expect(review).toHaveBeenCalledWith('task', 'custom', 'form', { value: 3 });
  expect(request).toHaveBeenCalledTimes(verdict === 'ask' ? 1 : 0);
  if (verdict === 'ask') expect(request).toHaveBeenCalledWith('task', expect.objectContaining({ metadata: expect.objectContaining({ mcpApp: { clientId: 'card', serverId: 'custom', title: 'Planner', scope: 'once' } }) }), expect.any(AbortSignal));
});

// unit: page-only task grants were absent. Minimum input is two page calls with one
// session-scoped answer, then change one authority boundary. Model stores are never involved.
describe('page-only task permission lifetime', () => {
  const source = { clientId: 'card', serverId: 'example', title: 'Planner' };
  const tool = { name: 'read', inputSchema: { type: 'object' as const } };
  const call = (id = 'task', target = tool) => state.deps!.authorizeTool(id, target, {}, new AbortController().signal, source);
  it('remembers only this task/service/tool and clears on session clear, end, config and owner changes', async () => {
    request.mockResolvedValue({ kind: 'permission', behavior: 'allow', permissionUpdates: [{ destination: 'session' }] } as never);
    await call(); await call(); expect(request).toHaveBeenCalledTimes(1);
    await call('other'); expect(request).toHaveBeenCalledTimes(2);
    await call('task', { ...tool, name: 'another' }); expect(request).toHaveBeenCalledTimes(3);
    pagePermissionSessionChanged('task', { clearedAt: 1 });
    await call(); expect(request).toHaveBeenCalledTimes(4);
    pagePermissionSessionChanged('task', { status: 'archived' });
    await call(); expect(request).toHaveBeenCalledTimes(5);
    vi.mocked(readAppServer).mockReturnValue({ id: 'example', url: 'https://example.com/new', transport: 'http' });
    await call(); expect(request).toHaveBeenCalledTimes(6);
    state.owner = { ...(state.owner as object) };
    await call(); expect(request).toHaveBeenCalledTimes(7);
    pagePermissionGrants.clearServers(new Set(['example']));
    await call(); expect(request).toHaveBeenCalledTimes(8);
  });
  it('never remembers destructive, Auto or once-only answers', async () => {
    request.mockResolvedValue({ kind: 'permission', behavior: 'allow', permissionUpdates: [{ destination: 'session' }] } as never);
    const destructive = { ...tool, annotations: { destructiveHint: true } };
    await call('task', destructive); await call('task', destructive);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, 'task', expect.objectContaining({ suggestions: undefined, metadata: { mcpApp: { ...source, scope: 'once' } } }), expect.any(AbortSignal));
    state.session.permissionMode = 'auto';
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    registerMcpAppsIpc(async () => {}, request, review);
    await call(); await call(); expect(review).toHaveBeenCalledTimes(2);
    state.session.permissionMode = 'default';
    request.mockResolvedValue({ kind: 'permission', behavior: 'allow' });
    await call(); await call(); expect(request).toHaveBeenCalledTimes(4);
  });
  it('settles only the waiting page request after committed Full Access, without another prompt', async () => {
    let resolve!: (value: { kind: 'permission'; behavior: 'allow' }) => void;
    const prompt = vi.fn(() => new Promise<{ kind: 'permission'; behavior: 'allow' }>(r => { resolve = r; }));
    const allow = vi.fn(() => resolve({ kind: 'permission', behavior: 'allow' }));
    registerMcpAppsIpc(async () => {}, prompt, undefined, allow);
    const pending = call();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    state.session = { ...state.session, permissionMode: 'bypassPermissions' };
    pagePermissionSessionChanged('other', { permissionMode: 'bypassPermissions' });
    expect(allow).not.toHaveBeenCalled();
    pagePermissionSessionChanged('task', { permissionMode: 'bypassPermissions' });
    await pending; expect(allow).toHaveBeenCalledWith('task', expect.any(String));
    await call(); expect(prompt).toHaveBeenCalledOnce();
  });
});

// M05, unit: original Host tests bypassed the second IPC error envelope on the
// viewer. Exercise the registered remote entry + RemoteMcpAppViews + real Host,
// with only device-link transport substituted. One Library result is sufficient.
it('preserves the local-files limitation across Desktop and phone remote entry points', async () => {
  const { McpAppsHost: RealHost, appServerRevision: revision } = await vi.importActual<typeof import('../host.js')>('../host.js');
  const { createPluginAppTransport, pluginAppTool } = await import('../pluginServer.js');
  const tools = [{ name: 'open', description: 'Open' }];
  const ui = { resources: [{
            uri: "ui://page",
            file: 'ui.html'
        }], tools: { open: { resourceUri: "ui://page" } } };
  const config: import('../connection.js').AppServerConfig = { id: 'remote-files', url: '', transport: 'in-process', plugin: {
    instance: 'remote-files', revision: 'approved', packageSha256: 'hash', directory: '/fixture', title: 'Files', trust: 'unverified', domains: [], assertCurrent() {},
    createTransport: () => createPluginAppTransport({ instance: 'remote-files', revision: 'approved', tools, ui, assertCurrent() {}, readHtml: () => '<p>Standard page</p>', call: async () => ({ content: [] }) }),
  } };
  const actual = new RealHost({ owner: () => state.owner!, config: () => config,
    readCard: async (_task, card) => ({ version: 1, serverId: config.id, serverRevision: revision(config), resourceUri: 'ui://page', tool: pluginAppTool('remote-files', tools[0], ui), arguments: {},
      result: { content: card === 'files' ? [{ type: 'resource_link', uri: 'library:report.png', name: 'report' }] : [] } }),
    writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {},
  });
  state.open.mockImplementation(actual.open.bind(actual));
  // Model the actual IPC serialization, including its [PRECONDITION_FAILED] prefix.
  state.invoke.mockImplementation(async (_device, _channel, args, options) => {
    options.preSend();
    const saved = state.remote;
    state.remote = { controllerDeviceId: 'viewer' };
    try { return { ok: true, result: await state.handle!({}, args[0], args[1]) }; }
    catch (error) { return { ok: false, error: { code: 'PRECONDITION_FAILED', message: (error as Error).message } }; }
    finally { state.remote = saved; }
  });
  try {
    for (const viewer of ['desktop', 'phone']) {
      state.remote = viewer === 'phone' ? { controllerDeviceId: 'phone' } : undefined;
      const route = viewer === 'desktop' ? { deviceId: 'execution-computer' } : {};
      await expect(state.handle!({ sender: { id: 1 } }, 'task', { ...route, op: 'open', clientId: 'files' }))
        .rejects.toThrow('[PRECONDITION_FAILED] MCP_APP_FILES_LOCAL_ONLY');
      vi.mocked(mountRemoteAppDocument).mockReturnValue('local-standard');
      const doc = await state.handle!({ sender: { id: 1 } }, 'task', { ...route, op: 'open', clientId: 'standard' });
      expect(doc).toMatchObject(viewer === 'desktop' ? { viewId: 'local-standard', transport: 'sandbox' } : { html: '<p>Standard page</p>' });
    }
  } finally { await actual.reset(); }
});

// Wrapped public codes survive, but upstream text/URLs/secrets must never leak.
it.each([
  ['MCP_APP_FILE_NOT_AUTHORIZED', 'MCP_APP_FILE_NOT_AUTHORIZED'],
  ['MCP_APP_TOOL_DENIED', 'MCP_APP_TOOL_DENIED'],
  ['MCP_APP_CALL_NOT_AUTHORIZED', 'MCP_APP_CALL_NOT_AUTHORIZED'],
  ['MCP_PLUGIN_CSP_DOMAIN_NOT_DECLARED', 'MCP_PLUGIN_CSP_DOMAIN_NOT_DECLARED'],
  ['MCP_PLUGIN_UNAVAILABLE', 'MCP_PLUGIN_UNAVAILABLE'],
  ['MCP_APP_FILES_LOCAL_ONLY https://private.invalid/?token=secret', 'MCP_APP_REQUEST_FAILED'],
])('preserves only public remote App errors: %s', async (message, expected) => {
  state.invoke.mockResolvedValue({ ok: false, error: { code: 'PRECONDITION_FAILED', message: `[PRECONDITION_FAILED] ${message}` } });
  await expect(state.handle!({ sender: { id: 1 } }, 'task', { deviceId: 'execution-computer', op: 'open', clientId: 'card' }))
    .rejects.toThrow(`[PRECONDITION_FAILED] ${expected}`);
});

// Unit: real registerMcpAppsIpc authorizer + production ghost_call classifier.
// Plugin pages formerly skipped this path; two ordinary page calls must share only
// a page grant, while Full Access, media policy and Auto produce distinct outcomes.
describe('plugin page ghost_call approval policy', () => {
  const source = { clientId: 'card', serverId: 'plugin-example', title: 'Page' };
  const tool = { name: 'save', inputSchema: { type: 'object' as const } };
  function bind(ghostId = 'notes', namespace?: string | null) {
    vi.mocked(readAppServer).mockReturnValue({ id: source.serverId, url: '', transport: 'in-process', plugin: {
      ghostId, ...(namespace !== undefined ? { namespace } : {}), instance: '_root__' + ghostId, revision: 'approved', packageSha256: 'hash', directory: '/fixture', title: 'Page',
      trust: 'unverified', domains: [], assertCurrent() {}, createTransport() { throw new Error('unused'); },
    } });
  }
  const call = (target = tool) => state.deps!.authorizeTool('task', target, { value: 3 }, new AbortController().signal, source);
  it('asks through the page request and remembers only page calls in this task', async () => {
    bind();
    request.mockResolvedValue({ kind: 'permission', behavior: 'allow', permissionUpdates: [{ destination: 'session' }] } as never);
    await call(); await call();
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith('task', expect.objectContaining({ suggestions: expect.any(Array),
      metadata: { mcpApp: { ...source, scope: 'session' } } }), expect.any(AbortSignal));
  });
  // 4420282600, unit: the real page authorizer must observe the independent plan toggle.
  // Existing coverage only used permissionMode; a remembered grant and an in-flight approval missed it.
  it.each(['default', 'auto', 'bypassPermissions', 'media'] as const)('denies a page call in plan mode before %s policy can allow it', async mode => {
    bind(mode === 'media' ? 'cindy-art' : 'notes');
    state.session.permissionMode = mode === 'media' ? 'default' : mode;
    state.session.planModeEnabled = true;
    await expect(call(mode === 'media' ? { ...tool, name: 'gen_image' } : tool)).rejects.toThrow('MCP_APP_TOOL_DENIED');
    expect(request).not.toHaveBeenCalled();
  });
  it('discards remembered page approval after entering and leaving plan mode', async () => {
    bind();
    request.mockResolvedValue({ kind: 'permission', behavior: 'allow', permissionUpdates: [{ destination: 'session' }] } as never);
    await call(); await call();
    expect(request).toHaveBeenCalledOnce();
    state.session = { ...state.session, planModeEnabled: true };
    pagePermissionSessionChanged('task', { planModeEnabled: true });
    state.session = { ...state.session, planModeEnabled: false };
    pagePermissionSessionChanged('task', { planModeEnabled: false });
    await call();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it.each(['default', 'auto'] as const)('rechecks plan mode after a pending %s approval', async mode => {
    bind();
    state.session.permissionMode = mode;
    const enterPlan = () => {
      state.session = { ...state.session, planModeEnabled: true };
      pagePermissionSessionChanged('task', { planModeEnabled: true });
    };
    const prompt = vi.fn(async () => { enterPlan(); return { kind: 'permission' as const, behavior: 'allow' as const }; });
    const review = vi.fn(async () => { enterPlan(); return { verdict: 'allow' as const }; });
    registerMcpAppsIpc(async () => {}, prompt, review);
    await expect(call()).rejects.toThrow('MCP_APP_TOOL_DENIED');
    expect(mode === 'auto' ? review : prompt).toHaveBeenCalledOnce();
  });
  it.each(['bypassPermissions', 'media', 'media-auto'] as const)('does not ask for %s', async mode => {
    bind(mode === 'bypassPermissions' ? 'notes' : 'cindy-art');
    state.session.permissionMode = mode === 'media-auto' ? 'auto' : mode === 'media' ? 'default' : mode;
    const review = vi.fn(async () => ({ verdict: 'ask' as const }));
    registerMcpAppsIpc(async () => {}, request, review);
    await call(mode === 'bypassPermissions' ? tool : { ...tool, name: 'gen_image' });
    expect(review).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 'example'])('reviews the original ghost_call identity and page origin in Auto: %s', async namespace => {
    bind('notes', namespace); state.session.permissionMode = 'auto';
    const review = vi.fn(async () => ({ verdict: 'allow' as const }));
    registerMcpAppsIpc(async () => {}, request, review);
    await call();
    expect(review).toHaveBeenCalledWith('task', 'cindy', 'ghost_call',
      { ghost_id: 'notes', ...(namespace !== undefined ? { namespace } : {}), tool: 'save', args: { value: 3 } }, expect.stringContaining('由插件交互页面发起'));
    expect(request).not.toHaveBeenCalled();
  });
});
