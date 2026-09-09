import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createXdtHelperMcpServer, getLiziMcpSessionContext } from '@cindy/mcps';

import type { Logger } from '@cindy/maker-core';
import {
  computeRemoteMcpFingerprint,
  selectRemoteInjectableServerNames,
  startCodexHttpBridge,
  type CodexHttpBridge,
  withMcpRouteIdentity,
} from '../codexHttpBridge.js';
import { CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY, CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../codexBuiltinToolPolicy.js';
import { isBotToolsetAvailableOnTarget } from '../../../shared/botRemoteCapabilities.js';
import { resolveBotAllowedBuiltinPluginIds } from '../../maker-host/plugins/types.js';

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createTestServer(): McpServer {
  const server = new McpServer({ name: 'cindy_test', version: '1.0.0' });
  server.tool(
    'current_session',
    'Return the active lizi MCP session context session id.',
    {},
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: getLiziMcpSessionContext()?.sessionId ?? 'no-session',
        },
      ],
    }),
  );
  server.tool(
    'current_instance',
    'Return the active lizi MCP session context instance id.',
    {},
    async () => ({
      content: [
        {
          type: 'text' as const,
          text: getLiziMcpSessionContext()?.sessionInstanceId ?? 'no-instance',
        },
      ],
    }),
  );
  return server;
}

async function readRpcResponse(resp: Response): Promise<unknown> {
  const text = await resp.text();
  const eventPayload = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(eventPayload ?? text);
}

/**
 * Every JSON-RPC response in the reply, not just the first. A batched request
 * comes back as one SSE `data:` event per response, so `readRpcResponse`
 * (first event only) cannot see the whole batch.
 */
async function readAllRpcResponses(resp: Response): Promise<unknown[]> {
  const text = await resp.text();
  const payloads = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)) as unknown);
  if (payloads.length > 0) return payloads.flat();
  const parsed = JSON.parse(text) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

describe('remote injection shared pure functions (R4 P3)', () => {
  // 这两个函数是 CC 注入 / Codex ensure / Codex drift 三条路径的唯一真源,
  // 间接测试出错时定位困难 — 这里直接锁 gate 组合与指纹敏感性。
  const AVAILABLE = ['cindy_orca', 'orca_worker_bridge', 'cindy_memory', 'cindy_ssh'];

  it('selectRemoteInjectableServerNames: gate 组合与白名单过滤', () => {
    expect(selectRemoteInjectableServerNames(AVAILABLE, { collabEnabled: true, memoryEnabled: true }))
      .toEqual(['cindy_orca', 'orca_worker_bridge', 'cindy_memory']);
    expect(selectRemoteInjectableServerNames(AVAILABLE, { collabEnabled: true, memoryEnabled: false }))
      .toEqual(['cindy_orca', 'orca_worker_bridge']);
    // collab 关 + memory 开 → 只出 cindy_memory。
    expect(selectRemoteInjectableServerNames(AVAILABLE, { collabEnabled: false, memoryEnabled: true }))
      .toEqual(['cindy_memory']);
    expect(selectRemoteInjectableServerNames(AVAILABLE, { collabEnabled: false, memoryEnabled: false }))
      .toEqual([]);
    // cindy_ssh 等非白名单 server 任何 gate 组合下都不可选(上面四例已隐含,
    // 这里显式断言防未来放宽)。
    for (const collabEnabled of [true, false]) {
      for (const memoryEnabled of [true, false]) {
        expect(
          selectRemoteInjectableServerNames(AVAILABLE, { collabEnabled, memoryEnabled }),
        ).not.toContain('cindy_ssh');
      }
    }
    // memory 开但 bridge 没挂 cindy_memory → 不凭空注入。
    expect(
      selectRemoteInjectableServerNames(['cindy_orca'], { collabEnabled: true, memoryEnabled: true }),
    ).toEqual(['cindy_orca']);
  });

  it('computeRemoteMcpFingerprint: 对 serverNames 顺序不敏感, 对集合/成分敏感', () => {
    const base = { token: 'tok', bridgeInstanceId: 'b1', remotePort: 47921 };
    const fp = computeRemoteMcpFingerprint({ ...base, serverNames: ['cindy_orca', 'cindy_memory'] });
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    // 顺序不敏感 — 调用方无需预排序。
    expect(computeRemoteMcpFingerprint({ ...base, serverNames: ['cindy_memory', 'cindy_orca'] })).toBe(fp);
    // 集合敏感 — memory 开关翻转必须构成新代际。
    expect(computeRemoteMcpFingerprint({ ...base, serverNames: ['cindy_orca'] })).not.toBe(fp);
    // 其余成分敏感 — token 轮换 / bridge 换代 / 端口重绑都构成新代际。
    expect(computeRemoteMcpFingerprint({ ...base, token: 'tok2', serverNames: ['cindy_orca', 'cindy_memory'] })).not.toBe(fp);
    expect(computeRemoteMcpFingerprint({ ...base, bridgeInstanceId: 'b2', serverNames: ['cindy_orca', 'cindy_memory'] })).not.toBe(fp);
    expect(computeRemoteMcpFingerprint({ ...base, remotePort: 47922, serverNames: ['cindy_orca', 'cindy_memory'] })).not.toBe(fp);
    expect(computeRemoteMcpFingerprint({
      ...base,
      serverNames: ['cindy_orca', 'cindy_memory'],
      sessionInstanceId: 'instance-1',
    })).not.toBe(computeRemoteMcpFingerprint({
      ...base,
      serverNames: ['cindy_orca', 'cindy_memory'],
      sessionInstanceId: 'instance-2',
    }));
  });

  it('withMcpRouteIdentity preserves the base route and encodes opaque identity', () => {
    const result = new URL(withMcpRouteIdentity('http://127.0.0.1:47921/mcp/cindy_orca', {
      sessionId: 'session / 1',
      sessionInstanceId: 'instance?1',
    }));
    expect(result.pathname).toBe('/mcp/cindy_orca');
    expect(result.searchParams.get('session')).toBe('session / 1');
    expect(result.searchParams.get('instance')).toBe('instance?1');
  });
});

describe('codexHttpBridge', () => {
  let bridge: CodexHttpBridge | null = null;

  afterEach(async () => {
    await bridge?.shutdown();
    bridge = null;
  });

  it('scopes startup tools/list before thread registration without authorizing execution', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_helper: () => {
        const server = createTestServer();
        server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
          name: getLiziMcpSessionContext()?.sessionId ?? 'unbound',
          inputSchema: { type: 'object', properties: {} },
        }] }));
        return server;
      } },
      pluginIdByServerName: { cindy_helper: 'cindy_helper' },
      logger: noopLogger(),
    });
    const current = bridge;
    const url = withMcpRouteIdentity(current.url('cindy_helper'), { sessionInstanceId: 'starting-instance' });
    const headers: Record<string, string> = {
      authorization: `Bearer ${current.token}`, accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initialized = await fetch(url, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'startup-test', version: '1' },
      },
    }) });
    headers['mcp-session-id'] = initialized.headers.get('mcp-session-id')!;
    await initialized.text();
    let id = 2;
    const request = (method: string, params: unknown = {}) => fetch(url, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
    });
    const list = async () => await readRpcResponse(await request('tools/list')) as { result: { tools: Array<{ name: string }> } };
    expect((await list()).result.tools[0].name).toBe('unbound');
    const context = { agentKind: 'codex' as const, sessionId: 'bot-parent', sessionInstanceId: 'starting-instance', workingDir: '/bot' };
    await expect(current.withDiscoveryContext(context, async () => {
      expect((await list()).result.tools[0].name).toBe('bot-parent');
      const execution = await request('tools/call', { name: 'current_session', arguments: {} });
      expect(execution.status).toBe(401);
      await execution.text();
      const stale = await readRpcResponse(await request('tools/list', { _meta: { threadId: 'unregistered-thread' } })) as { result: { tools: Array<{ name: string }> } };
      expect(stale.result.tools[0].name).toBe('unbound');
      throw new Error('native startup failed');
    })).rejects.toThrow('native startup failed');
    expect((await list()).result.tools[0].name).toBe('unbound');
    current.registerThreadContext('real-thread', context);
    expect((await list()).result.tools[0].name).toBe('bot-parent');
    const execution = await request('tools/call', { name: 'current_session', arguments: {}, _meta: { threadId: 'real-thread' } });
    expect(execution.status).toBe(200);
    expect(await readRpcResponse(execution)).toMatchObject({ result: { content: [{ text: 'bot-parent' }] } });
  });

  it.each(['codex', 'claude-code'] as const)('serves only live Bot tasks over the %s remote helper route', async (agentKind) => {
    let surface: 'bot' | 'default' = 'bot';
    const start = vi.fn(async () => ({ ok: true as const, delegationId: 'remote-task', childSessionId: 'child-session', status: 'running', deadlineAt: 1000 }));
    const unavailable = vi.fn(async () => ({ ok: false as const, errorCode: 'UNEXPECTED', message: 'unused' }));
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_helper: () => createXdtHelperMcpServer({
        resolveSurface: async () => surface,
        sessionTasks: { startSessionTask: start, getSessionTask: unavailable, messageSessionTask: unavailable, stopSessionTask: unavailable },
      }, { agentKind, workingDir: '', getSessionContext: getLiziMcpSessionContext }) },
      pluginIdByServerName: { cindy_helper: 'xdt_helper' },
      additionalBearerTokens: () => ['remote-test-token'],
      logger: noopLogger(),
    });
    const current = bridge;
    const allowed = resolveBotAllowedBuiltinPluginIds([{
      id: 'xdt_helper',
      available: isBotToolsetAvailableOnTarget({ agentKind, remoteHostId: 'ssh-host', toolsetId: 'xdt_helper' }),
    }], []);
    const ctx = {
      agentKind, sessionId: 'remote-bot', sessionInstanceId: 'remote-instance', remoteHostId: 'ssh-host', workingDir: '/bot',
      vendorOptions: { [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: allowed },
    };
    if (agentKind === 'claude-code') current.registerSessionCtx(ctx.sessionId, ctx);
    const url = withMcpRouteIdentity(current.url('cindy_helper'), {
      sessionInstanceId: ctx.sessionInstanceId,
      ...(agentKind === 'claude-code' ? { sessionId: ctx.sessionId } : {}),
    });
    const headers: Record<string, string> = {
      authorization: 'Bearer remote-test-token', accept: 'application/json, text/event-stream', 'content-type': 'application/json',
    };
    const init = await fetch(url, { method: 'POST', headers, body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote-bot-test', version: '1' },
      },
    }) });
    expect(init.status).toBe(200);
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
    await init.text();
    let id = 2;
    const request = (method: string, params: unknown = {}, target = url) => fetch(target, {
      method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
    });
    const list = async () => readRpcResponse(await request('tools/list')) as Promise<{ result: { tools: Array<{ name: string }> } }>;
    await current.withDiscoveryContext(ctx, async () => {
      expect((await list()).result.tools.map(t => t.name)).toEqual(expect.arrayContaining([
        'start_session_task', 'check_session_task', 'message_session_task', 'stop_session_task',
      ]));
      if (agentKind === 'codex') {
        const denied = await request('tools/call', { name: 'start_session_task', arguments: { instruction: 'too early' } });
        expect(denied.status).toBe(401);
        await denied.text();
      }
    });
    if (agentKind === 'codex') current.registerThreadContext('remote-thread', ctx);
    const firstList = await list();
    expect((await list()).result).toEqual(firstList.result);
    const result = await readRpcResponse(await request('tools/call', {
      name: 'start_session_task', arguments: { instruction: 'Build the report' },
      ...(agentKind === 'codex' ? { _meta: { threadId: 'remote-thread' } } : {}),
    }));
    expect(result).toMatchObject({ result: { content: [{ type: 'text', text: expect.stringContaining('remote-task') }] } });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ callerSessionId: 'remote-bot', objective: 'Build the report' }));
    // The bridge is shared: a live surface change must not reveal ordinary helper controls.
    surface = 'default';
    expect((await list()).result.tools.map(t => t.name).sort()).toEqual(['call_tool', 'list_tools']);
    const categories = await readRpcResponse(await request('tools/call', { name: 'list_tools', arguments: {} }));
    expect(categories).toMatchObject({ result: { content: [{ text: expect.stringContaining('"categories":[]') }] } });
    await request('tools/call', { name: 'start_session_task', arguments: { instruction: 'denied' } }).then(readRpcResponse);
    expect(start).toHaveBeenCalledTimes(1);
    if (agentKind === 'codex') {
      // A remote token cannot borrow a local or Pi context to get the broad helper surface.
      for (const invalid of [{ ...ctx, remoteHostId: undefined }, { ...ctx, agentKind: 'pi' as const }]) {
        current.registerThreadContext('remote-thread', invalid);
        const denied = await request('tools/list');
        expect(denied.status).toBe(401);
        await denied.text();
      }
    }
    if (agentKind === 'codex') current.unregisterThreadContext('remote-thread', ctx.sessionInstanceId);
    else current.unregisterSessionCtx(ctx.sessionId, ctx);
    const stale = await request('tools/list');
    expect(stale.status).toBe(401);
    await stale.text();
  });

  it('accepts an additional bearer token (remote daemon) and rejects unknown tokens', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: {
        cindy_orca: createTestServer,
        cindy_test: createTestServer,
        cindy_memory: createTestServer,
      },
      additionalBearerTokens: () => ['remote-persistent-token'],
      logger: noopLogger(),
    });

    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    const postInit = (serverName: string, token: string) =>
      fetch(bridge!.url(serverName), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
        },
        body: initBody,
      });

    // 主 token (per-run, 本地 codex 子进程) 全通 — 白名单与非白名单都可用。
    const mainResp = await postInit('cindy_orca', bridge.token);
    expect(mainResp.status).toBe(200);
    await mainResp.text();
    const mainNonCollab = await postInit('cindy_test', bridge.token);
    expect(mainNonCollab.status).toBe(200);
    await mainNonCollab.text();

    // additional token (远端常驻 daemon 的 persistent token) 仅限协同白名单:
    // 同一 remote-forward 能摸到完整 /mcp/<name> 路由, 拿到 token 的远端
    // 进程不得初始化本机非协同 server (codex-connector P1 回归)。
    const remoteResp = await postInit('cindy_orca', 'remote-persistent-token');
    expect(remoteResp.status).toBe(200);
    await remoteResp.text();
    // cindy_memory 属远端白名单 (Maker Memory 经 bridge 回本机 store) — scoped
    // token 放行;其余 in-process server (cindy_test 代表) 仍 403。
    const remoteMemory = await postInit('cindy_memory', 'remote-persistent-token');
    expect(remoteMemory.status).toBe(200);
    await remoteMemory.text();
    const remoteNonCollab = await postInit('cindy_test', 'remote-persistent-token');
    expect(remoteNonCollab.status).toBe(403);
    await remoteNonCollab.text();

    // 未知 token 一律 401 (防呆过滤)。
    const badResp = await postInit('cindy_orca', 'not-a-real-token');
    expect(badResp.status).toBe(401);
    await badResp.text();
  });

  it('routes tool calls by JSON-RPC params._meta.threadId', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-a', {
      agentKind: 'codex',
      sessionId: 'session-a',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: {
        ...baseHeaders,
        'mcp-session-id': mcpSessionId ?? '',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          _meta: { threadId: 'thread-a' },
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        content: [{ type: 'text', text: 'session-a' }],
      },
    });
  });

  it('binds local Codex tool calls to the registered Session instance', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-instance', {
      agentKind: 'codex',
      sessionId: 'session-instance',
      sessionInstanceId: 'instance-current',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const headers = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const activeUrl = withMcpRouteIdentity(bridge.url('cindy_test'), {
      sessionInstanceId: 'instance-current',
    });
    const initResp = await fetch(activeUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const call = (url: string, id: number, name: string) =>
      fetch(url, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name,
            arguments: {},
            _meta: { threadId: 'thread-instance' },
          },
        }),
      });

    const active = await call(activeUrl, 2, 'current_instance');
    expect(active.status).toBe(200);
    expect(await readRpcResponse(active)).toMatchObject({
      result: { content: [{ type: 'text', text: 'instance-current' }] },
    });

    const activeWithoutThreadId = await fetch(activeUrl, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'current_session', arguments: {} },
      }),
    });
    expect(activeWithoutThreadId.status).toBe(200);
    expect(await readRpcResponse(activeWithoutThreadId)).toMatchObject({
      result: { content: [{ type: 'text', text: 'session-instance' }] },
    });

    const stale = await call(
      withMcpRouteIdentity(bridge.url('cindy_test'), {
        sessionInstanceId: 'instance-stale',
      }),
      3,
      'current_instance',
    );
    expect(stale.status).toBe(401);
    await stale.text();

    const staleWithoutThreadId = await fetch(
      withMcpRouteIdentity(bridge.url('cindy_test'), {
        sessionInstanceId: 'instance-stale',
      }),
      {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'current_session', arguments: {} },
        }),
      },
    );
    expect(staleWithoutThreadId.status).toBe(401);
    await staleWithoutThreadId.text();

    // An old unbound URL keeps ordinary session-aware tools compatible, but
    // deliberately removes the capability needed for Full Access auto-grants.
    const legacySession = await call(bridge.url('cindy_test'), 4, 'current_session');
    expect(legacySession.status).toBe(200);
    expect(await readRpcResponse(legacySession)).toMatchObject({
      result: { content: [{ type: 'text', text: 'session-instance' }] },
    });
    const legacyInstance = await call(bridge.url('cindy_test'), 5, 'current_instance');
    expect(legacyInstance.status).toBe(200);
    expect(await readRpcResponse(legacyInstance)).toMatchObject({
      result: { content: [{ type: 'text', text: 'no-instance' }] },
    });
  });

  it('keeps the thread context when a batch sibling omits the thread id', async () => {
    // Regression: a JSON-RPC batch carrying a notification (no
    // params._meta.threadId) alongside a well-attributed tools/call used to
    // collapse extractCodexThreadId() to undefined for the WHOLE batch, so the
    // transport ran without runWithLiziMcpSessionContext. Providers reading the
    // context (cindy_browser's __mcpSessionId) then fell back to host-side
    // UI-focus inference — the cross-session routing bug, via batches.
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-batch', {
      agentKind: 'codex',
      sessionId: 'session-batch',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        // Contextless sibling — legitimate per MCP, must be ignored here.
        { jsonrpc: '2.0', method: 'notifications/progress', params: {} },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-batch' },
          },
        },
      ]),
    });

    expect(callResp.status).toBe(200);
    // 'no-session' here would mean the ALS context was dropped.
    expect(await readRpcResponse(callResp)).toMatchObject({
      id: 2,
      result: { content: [{ type: 'text', text: 'session-batch' }] },
    });
  });

  it('drops the thread context when a batched tool call itself lacks a thread id', async () => {
    // The permissiveness above stops at tools/call: an unattributed tool call
    // must NOT inherit a sibling's session. findBlockedToolCall fail-closes
    // this shape only for servers with a pluginId, so this server (no pluginId)
    // proves the guard also lives in extractCodexThreadId.
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-batch', {
      agentKind: 'codex',
      sessionId: 'session-batch',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-batch' },
          },
        },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          // No _meta.threadId — poisons the batch on purpose.
          params: { name: 'current_session', arguments: {} },
        },
      ]),
    });

    expect(callResp.status).toBe(200);
    const results = (await readAllRpcResponses(callResp)) as Array<{
      id?: number;
      result?: { content?: Array<{ text?: string }> };
    }>;
    expect(results.length).toBeGreaterThan(0);
    // No response may report the sibling's session — the batch is unattributed.
    for (const entry of results) {
      expect(entry.result?.content?.[0]?.text).not.toBe('session-batch');
    }
    // And the well-formed call did run, just without a context.
    expect(
      results.find((entry) => entry.id === 2)?.result?.content?.[0]?.text,
    ).toBe('no-session');
  });

  it('a sibling naming another thread cannot degrade a well-attributed call', async () => {
    // Sibling attribution must never win over the tool call's own: otherwise a
    // stray notification carrying some other threadId would strip the ALS
    // context and re-open the UI-focus fallback.
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    for (const [threadId, sessionId] of [
      ['thread-x', 'session-x'],
      ['thread-y', 'session-y'],
    ]) {
      bridge.registerThreadContext(threadId!, {
        agentKind: 'codex',
        sessionId: sessionId!,
        workingDir: '/repo',
        vendorOptions: {},
      });
    }

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        // Notification pointing at a DIFFERENT registered thread.
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { _meta: { threadId: 'thread-y' } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-x' },
          },
        },
      ]),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      id: 2,
      result: { content: [{ type: 'text', text: 'session-x' }] },
    });
  });

  it('siblings disagreeing among themselves still cannot strip a call context', async () => {
    // Two non-tool siblings naming DIFFERENT threads used to short-circuit the
    // scan to undefined before the tools/call could claim the request — and
    // hasAmbiguousThreadContext ignores non-tool messages, so nothing rejected
    // it either: it just ran contextless, back to UI focus.
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      logger: noopLogger(),
    });
    for (const [threadId, sessionId] of [
      ['thread-x', 'session-x'],
      ['thread-y', 'session-y'],
      ['thread-z', 'session-z'],
    ]) {
      bridge.registerThreadContext(threadId!, {
        agentKind: 'codex',
        sessionId: sessionId!,
        workingDir: '/repo',
        vendorOptions: {},
      });
    }

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { _meta: { threadId: 'thread-y' } },
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: { _meta: { threadId: 'thread-z' } },
        },
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-x' },
          },
        },
      ]),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      id: 2,
      result: { content: [{ type: 'text', text: 'session-x' }] },
    });
  });

  it('accepts batched thread aliases only when their full execution contexts match', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    const first = {
      agentKind: 'codex',
      sessionId: 'session-alias',
      sessionInstanceId: 'instance-alias',
      workingDir: '/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['browser'],
        orcaRole: 'lead',
      },
    };
    bridge.registerThreadContext('thread-alias-one', first);
    bridge.registerThreadContext('thread-alias-two', {
      ...first,
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['browser'],
        orcaRole: 'lead',
      },
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify(
        ['thread-alias-one', 'thread-alias-two'].map((threadId, index) => ({
          jsonrpc: '2.0',
          id: index + 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId },
          },
        })),
      ),
    });

    expect(callResp.status).toBe(200);
    const results = (await readAllRpcResponses(callResp)) as Array<{
      id?: number;
      result?: { content?: Array<{ text?: string }> };
    }>;
    expect(results).toHaveLength(2);
    for (const entry of results) {
      expect(entry.result?.content?.[0]?.text).toBe('session-alias');
    }
  });

  it('fail-closes batched aliases when their tool policies differ', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    const baseContext = {
      agentKind: 'codex',
      sessionId: 'session-alias',
      sessionInstanceId: 'instance-alias',
      workingDir: '/repo',
    };
    bridge.registerThreadContext('thread-policy-one', {
      ...baseContext,
      vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['browser'] },
    });
    bridge.registerThreadContext('thread-policy-two', {
      ...baseContext,
      vendorOptions: { [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['android'] },
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify(
        ['thread-policy-one', 'thread-policy-two'].map((threadId, index) => ({
          jsonrpc: '2.0',
          id: index + 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId },
          },
        })),
      ),
    });

    expect(callResp.status).toBe(200);
    const results = (await readAllRpcResponses(callResp)) as Array<{
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    }>;
    expect(results).toHaveLength(2);
    for (const entry of results) {
      expect(entry.result?.isError).toBe(true);
      expect(entry.result?.content?.[0]?.text).toMatch(/more than one session/);
    }
  });

  it('fail-closes a batch whose tool calls name two different threads', async () => {
    // Two registered+enabled threads coalesced into one batch: the per-call
    // policy checks pass, and extractCodexThreadId rightly refuses to pick a
    // context — but running contextless would route through the focused UI
    // session. Refusing to pick must therefore mean refusing to run.
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    for (const [threadId, sessionId] of [
      ['thread-one', 'session-one'],
      ['thread-two', 'session-two'],
    ]) {
      bridge.registerThreadContext(threadId!, {
        agentKind: 'codex',
        sessionId: sessionId!,
        workingDir: '/repo',
        // Plugin enabled on BOTH threads — findBlockedToolCall has no reason to
        // block either call on its own.
        vendorOptions: {},
      });
    }

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify(
        ['thread-one', 'thread-two'].map((threadId, i) => ({
          jsonrpc: '2.0',
          id: i + 2,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId },
          },
        })),
      ),
    });

    expect(callResp.status).toBe(200);
    const results = (await readAllRpcResponses(callResp)) as Array<{
      id?: number;
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    }>;
    expect(results).toHaveLength(2);
    for (const entry of results) {
      // Rejected outright — and in particular NOT executed contextless, which
      // is what 'no-session' (or either session id) here would mean.
      expect(entry.result?.isError).toBe(true);
      expect(entry.result?.content?.[0]?.text).toMatch(/more than one session/);
    }
  });

  it('keeps legacy ?session= routing compatible without exposing the Session instance', async () => {
    bridge = await startCodexHttpBridge({
      // remote cc 走 persistent token, 仅限协同白名单 — 用白名单内的
      // cindy_orca 模拟真实 cc 流量 (scope 收窄后 cindy_test 会被 403)。
      serverFactories: { cindy_orca: createTestServer },
      additionalBearerTokens: () => ['remote-persistent-token'],
      logger: noopLogger(),
    });
    bridge.registerSessionCtx('cc-session-1', {
      agentKind: 'claude-code',
      sessionId: 'cc-session-1',
      sessionInstanceId: 'cc-instance-1',
      workingDir: '/remote/repo',
      vendorOptions: {},
    });

    const headers = {
      authorization: 'Bearer remote-persistent-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const sessionUrl = `${bridge.url('cindy_orca')}?session=cc-session-1`;
    const initBody = (id: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      });
    const initResp = await fetch(sessionUrl, {
      method: 'POST',
      headers,
      body: initBody(1),
    });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    // tools/call 不带 _meta.threadId —— ?session= query 即身份。
    const callResp = await fetch(sessionUrl, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'current_session', arguments: {} },
      }),
    });
    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: { content: [{ type: 'text', text: 'cc-session-1' }] },
    });

    const instanceResp = await fetch(sessionUrl, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'current_instance', arguments: {} },
      }),
    });
    expect(instanceResp.status).toBe(200);
    expect(await readRpcResponse(instanceResp)).toMatchObject({
      result: { content: [{ type: 'text', text: 'no-instance' }] },
    });

    // 注销后 ?session= 未命中立刻 401 (fail-closed)。
    bridge.unregisterSessionCtx('cc-session-1');
    const after = await fetch(sessionUrl, {
      method: 'POST',
      headers,
      body: initBody(4),
    });
    expect(after.status).toBe(401);
    await after.text();
  });

  it('requires remote Claude and Pi routes to match both session and instance', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_orca: createTestServer },
      additionalBearerTokens: () => ['remote-persistent-token'],
      logger: noopLogger(),
    });
    bridge.registerSessionCtx('remote-session', {
      agentKind: 'pi',
      sessionId: 'remote-session',
      sessionInstanceId: 'remote-instance-current',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const headers = {
      authorization: 'Bearer remote-persistent-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    const activeUrl = withMcpRouteIdentity(bridge.url('cindy_orca'), {
      sessionId: 'remote-session',
      sessionInstanceId: 'remote-instance-current',
    });
    const activeInit = await fetch(activeUrl, { method: 'POST', headers, body: initBody });
    expect(activeInit.status).toBe(200);
    const mcpSessionId = activeInit.headers.get('mcp-session-id');
    await activeInit.text();

    const activeCall = await fetch(activeUrl, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'current_instance', arguments: {} },
      }),
    });
    expect(activeCall.status).toBe(200);
    expect(await readRpcResponse(activeCall)).toMatchObject({
      result: { content: [{ type: 'text', text: 'remote-instance-current' }] },
    });

    const staleUrl = withMcpRouteIdentity(bridge.url('cindy_orca'), {
      sessionId: 'remote-session',
      sessionInstanceId: 'remote-instance-stale',
    });
    const stale = await fetch(staleUrl, { method: 'POST', headers, body: initBody });
    expect(stale.status).toBe(401);
    await stale.text();
  });

  it('rejects an unregistered ?session= query while leaving token-only requests untouched', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { cindy_test: createTestServer },
      additionalBearerTokens: () => ['remote-persistent-token'],
      logger: noopLogger(),
    });
    const initBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      },
    });
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };

    // 声称了 session 但未注册 → 401 fail-closed (sessionId 是明文路由参数)。
    const forged = await fetch(`${bridge.url('cindy_test')}?session=nobody`, {
      method: 'POST',
      headers: { ...headers, authorization: 'Bearer remote-persistent-token' },
      body: initBody,
    });
    expect(forged.status).toBe(401);
    await forged.text();

    // 不带 ?session= 的请求不受影响 (本地 codex 子进程的主 token 路径)。
    const plain = await fetch(bridge.url('cindy_test'), {
      method: 'POST',
      headers: { ...headers, authorization: `Bearer ${bridge.token}` },
      body: initBody,
    });
    expect(plain.status).toBe(200);
    await plain.text();
  });

  it('applies the frozen plugin policy to ?session= ctx tool calls (remote cc)', async () => {
    bridge = await startCodexHttpBridge({
      // server 名用白名单内的 cindy_orca 模拟真实 remote cc 流量
      // (persistent token scope 收窄后非白名单 server 会被 403)。
      serverFactories: { cindy_orca: createTestServer },
      pluginIdByServerName: { cindy_orca: 'ssh' },
      additionalBearerTokens: () => ['remote-persistent-token'],
      logger: noopLogger(),
    });
    // cc 远端不带 _meta.threadId,policy 边界必须从 ?session= ctx 取,
    // 否则禁用插件的 tools/call 会被 missing_thread_context 以外的路径漏过。
    bridge.registerSessionCtx('cc-disabled', {
      agentKind: 'claude-code',
      sessionId: 'cc-disabled',
      workingDir: '/remote/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['ssh'],
      },
    });

    const headers = {
      authorization: 'Bearer remote-persistent-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const sessionUrl = `${bridge.url('cindy_orca')}?session=cc-disabled`;
    const initResp = await fetch(sessionUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(sessionUrl, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'current_session', arguments: {} },
      }),
    });
    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: { isError: true },
    });
  });

  it('ignores a forged _meta.threadId on ?session= requests for the policy check', async () => {
    // sec P1 回归:?session= 路由下请求体携带一个已注册且未禁用 plugin 的
    // threadId 时, policy 判定不得按那个 thread ctx 放行 —— 执行态身份与
    // policy ctx 都必须是 ?session= 强优先。
    bridge = await startCodexHttpBridge({
      // server 名用白名单内的 cindy_orca 模拟真实 remote cc 流量
      // (persistent token scope 收窄后非白名单 server 会被 403)。
      serverFactories: { cindy_orca: createTestServer },
      pluginIdByServerName: { cindy_orca: 'ssh' },
      additionalBearerTokens: () => ['remote-persistent-token'],
      logger: noopLogger(),
    });
    // 伪造目标:一个已注册、未禁用 ssh plugin 的 codex thread。
    bridge.registerThreadContext('thread-clean', {
      agentKind: 'codex',
      sessionId: 'session-clean',
      workingDir: '/repo',
      vendorOptions: {},
    });
    bridge.registerSessionCtx('cc-disabled', {
      agentKind: 'claude-code',
      sessionId: 'cc-disabled',
      workingDir: '/remote/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['ssh'],
      },
    });

    const headers = {
      authorization: 'Bearer remote-persistent-token',
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const sessionUrl = `${bridge.url('cindy_orca')}?session=cc-disabled`;
    const initResp = await fetch(sessionUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(sessionUrl, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          // 伪造: 已注册且未禁用 ssh 的 threadId。
          _meta: { threadId: 'thread-clean' },
        },
      }),
    });
    expect(callResp.status).toBe(200);
    // 仍按 ?session= 的 disabled policy 拦截, 不被伪造 threadId 放行。
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: { isError: true },
    });
  });

  it('blocks a tool call using the policy frozen on its Codex thread', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-disabled', {
      agentKind: 'codex',
      sessionId: 'session-disabled',
      sessionInstanceId: 'instance-disabled',
      workingDir: '/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['ssh'],
      },
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const sessionUrl = withMcpRouteIdentity(bridge.url('lizi_test'), {
      sessionInstanceId: 'instance-disabled',
    });
    const initResp = await fetch(sessionUrl, {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(sessionUrl, {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          _meta: { threadId: 'thread-disabled' },
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('ssh') }],
      },
    });

    const withoutThreadId = await fetch(sessionUrl, {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'current_session', arguments: {} },
      }),
    });
    expect(withoutThreadId.status).toBe(200);
    expect(await readRpcResponse(withoutThreadId)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('ssh') }],
      },
    });
  });

  it.each([
    ['a missing thread id', undefined],
    ['an unregistered thread id', 'thread-not-registered'],
  ])('fail-closes a policy-controlled tool call with %s', async (_label, threadId) => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'current_session',
          arguments: {},
          ...(threadId ? { _meta: { threadId } } : {}),
        },
      }),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toMatchObject({
      result: {
        isError: true,
        content: [{ type: 'text', text: expect.stringContaining('verified Cindy session') }],
      },
    });
  });

  it('fail-closes a mixed JSON-RPC batch containing disabled tool calls', async () => {
    bridge = await startCodexHttpBridge({
      serverFactories: { lizi_test: createTestServer },
      pluginIdByServerName: { lizi_test: 'ssh' },
      logger: noopLogger(),
    });
    bridge.registerThreadContext('thread-batch-disabled', {
      agentKind: 'codex',
      sessionId: 'session-batch-disabled',
      workingDir: '/repo',
      vendorOptions: {
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: ['ssh'],
      },
    });

    const baseHeaders = {
      authorization: `Bearer ${bridge.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: baseHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    const callResp = await fetch(bridge.url('lizi_test'), {
      method: 'POST',
      headers: { ...baseHeaders, 'mcp-session-id': mcpSessionId ?? '' },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {},
        },
        ...[2, 3].map((id) => ({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'current_session',
            arguments: {},
            _meta: { threadId: 'thread-batch-disabled' },
          },
        })),
      ]),
    });

    expect(callResp.status).toBe(200);
    expect(await readRpcResponse(callResp)).toEqual([
      expect.objectContaining({ id: 2, result: expect.objectContaining({ isError: true }) }),
      expect.objectContaining({ id: 3, result: expect.objectContaining({ isError: true }) }),
    ]);
  });
});
