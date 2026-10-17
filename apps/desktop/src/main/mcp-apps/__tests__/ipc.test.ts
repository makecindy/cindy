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
vi.mock('../../utils/ipcValidate.js', () => ({
  throwIpcError: (code: string, message: string) => {
    throw new Error('[' + code + '] ' + message);
  },
}));
import { sessions } from '../../localDb/schema.js';
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
  state.remote = undefined;
  state.predicates = [];
  state.duringUpdate = () => {};
  state.beforePublish = () => {};
  state.session = { id: 'task', status: 'active', clearedAt: null, permissionMode: 'default' };
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
