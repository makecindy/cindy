/**
 * piEnvironment —— pi MCP 桥 per-session 身份接线测试。
 *
 * bridge 层的 `?session=` 路由 / 401 fail-closed 由 codexHttpBridge.test.ts 覆盖;
 * 本测试锁 pi 侧增量:getPiExtraSpawnConfig 是否
 *   1. 带 sessionId → server URL 打 `?session=<id>` + 在 bridge 注册 agentKind:'pi' 的
 *      ctx,使工具 handler 经 getLiziMcpSessionContext() 拿到该 sessionId
 *      (orca start_team/create_worker 据此绑 Lead,否则 LEAD_NOT_SUPPORTED);
 *   2. disposeSessionCtx() → 注销后 `?session=` 未命中立刻 401(会话结束路由失效);
 *   3. 匿名会话(无 sessionId)→ URL 不带 query、无注册、工具拿不到 ctx(行为同改动前)。
 *
 * getPiExtraSpawnConfig 内部起真 codexHttpBridge,故这里做真 HTTP 往返。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getLiziMcpSessionContext } from '@cindy/mcps';
import { createOrcaWorkerBridgeMcpProvider } from '@cindy/orca-workflow';

import type { Logger, McpProvider } from '@cindy/maker-core';
import {
  getPiExtraSpawnConfig,
  invalidatePiEnvironment,
  shutdownPiEnvironment,
} from '../piEnvironment.js';

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

/** 暴露一个回报当前 lizi MCP session ctx 的 sessionId 的工具,用于断言 ctx 是否流通。 */
function createTestServer(name: string): McpServer {
  const server = new McpServer({ name, version: '1.0.0' });
  server.tool('current_session', 'Return the active lizi MCP session id.', {}, async () => ({
    content: [{ type: 'text' as const, text: getLiziMcpSessionContext()?.sessionId ?? 'no-session' }],
  }));
  server.tool('current_instance', 'Return the active runtime session instance id.', {}, async () => ({
    content: [{
      type: 'text' as const,
      text: getLiziMcpSessionContext()?.sessionInstanceId ?? 'no-instance',
    }],
  }));
  return server;
}

/**
 * 每次 toClaudeSdkConfig 返回全新 McpServer(McpServer 实例不可复用 connect)。
 * name 默认 'cindy_orca'(→ collab,首方内置且被策略 gate 覆盖);传非内置名(如
 * 'custom_probe')可绕过 gate,单测 ctx 流通本身不受策略阻断干扰。
 */
function makeProvider(name = 'cindy_orca'): McpProvider {
  return {
    name,
    toClaudeSdkConfig: () => ({ type: 'sdk', instance: createTestServer(name) }),
  };
}

const INIT_BODY = (id: number) =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pi-bridge-test', version: '1.0.0' },
    },
  });

async function readRpcText(resp: Response): Promise<unknown> {
  const text = await resp.text();
  const payload = text
    .split(/\r?\n/)
    .find((line) => line.startsWith('data: '))
    ?.slice('data: '.length);
  return JSON.parse(payload ?? text);
}

describe('piEnvironment per-session identity', () => {
  afterEach(async () => {
    await shutdownPiEnvironment();
  });

  it('registers a pi session ctx and routes it through session + instance identity', async () => {
    const config = await getPiExtraSpawnConfig([makeProvider()], noopLogger(), {
      sessionId: 'pi-lead-1',
      sessionInstanceId: 'pi-instance-1',
      workingDir: '/repo',
      vendorOptions: {},
    });
    expect(config?.mcpBridge).toBeTruthy();
    const server = config!.mcpBridge!.servers[0]!;
    const token = config!.mcpBridge!.token;
    const routeUrl = new URL(server.url);
    expect(routeUrl.searchParams.get('session')).toBe('pi-lead-1');
    expect(routeUrl.searchParams.get('instance')).toBe('pi-instance-1');

    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(server.url, { method: 'POST', headers, body: INIT_BODY(1) });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    // 工具 handler 经 getLiziMcpSessionContext() 应拿到本 pi 会话身份。
    const callResp = await fetch(server.url, {
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
    expect(await readRpcText(callResp)).toMatchObject({
      result: { content: [{ type: 'text', text: 'pi-lead-1' }] },
    });

    const instanceResp = await fetch(server.url, {
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
    expect(await readRpcText(instanceResp)).toMatchObject({
      result: { content: [{ type: 'text', text: 'pi-instance-1' }] },
    });

    // close 语义:注销后 ?session=pi-lead-1 未命中 → 401 fail-closed。
    expect(config!.disposeSessionCtx).toBeTypeOf('function');
    config!.disposeSessionCtx!();
    const after = await fetch(server.url, { method: 'POST', headers, body: INIT_BODY(4) });
    expect(after.status).toBe(401);
    await after.text();
  });

  it('rejects a stale pi instance route after the same business session is rebound', async () => {
    const oldConfig = await getPiExtraSpawnConfig([makeProvider()], noopLogger(), {
      sessionId: 'pi-rebound',
      sessionInstanceId: 'pi-instance-old',
      workingDir: '/repo',
      vendorOptions: {},
    });
    const newConfig = await getPiExtraSpawnConfig([makeProvider()], noopLogger(), {
      sessionId: 'pi-rebound',
      sessionInstanceId: 'pi-instance-new',
      workingDir: '/repo',
      vendorOptions: {},
    });
    const oldServer = oldConfig!.mcpBridge!.servers[0]!;
    const newServer = newConfig!.mcpBridge!.servers[0]!;
    const headers = {
      authorization: `Bearer ${newConfig!.mcpBridge!.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };

    expect(new URL(oldServer.url).searchParams.get('instance')).toBe('pi-instance-old');
    expect(new URL(newServer.url).searchParams.get('instance')).toBe('pi-instance-new');

    const stale = await fetch(oldServer.url, {
      method: 'POST',
      headers,
      body: INIT_BODY(11),
    });
    expect(stale.status).toBe(401);
    await stale.text();

    const active = await fetch(newServer.url, {
      method: 'POST',
      headers,
      body: INIT_BODY(12),
    });
    expect(active.status).toBe(200);
    await active.text();

    // 旧进程迟到 close 只释放自己的 lease，不得注销新实例的 ctx。
    oldConfig!.disposeSessionCtx!();
    const afterOldClose = await fetch(newServer.url, {
      method: 'POST',
      headers,
      body: INIT_BODY(13),
    });
    expect(afterOldClose.status).toBe(200);
    await afterOldClose.text();
    newConfig!.disposeSessionCtx!();
  });

  it('omits ?session= and registers nothing for an anonymous session (no sessionId)', async () => {
    // 非内置 provider(无 plugin 策略)→ 匿名会话不触发 per-call gate,仍能验证 ctx 流通:
    // 无 ctx 绑定 → 工具拿到 'no-session'(控制类工具会据此回落 LEAD_NOT_SUPPORTED)。
    const config = await getPiExtraSpawnConfig([makeProvider('custom_probe')], noopLogger());
    expect(config?.mcpBridge).toBeTruthy();
    const server = config!.mcpBridge!.servers[0]!;
    const token = config!.mcpBridge!.token;
    // 匿名会话 URL 不带 query、没有身份注册；但仍带 generation lease，供配置换代时
    // 保持旧 bridge 存活到 Pi 子进程退出。
    expect(server.url).not.toContain('?session=');
    expect(config!.disposeSessionCtx).toBeTypeOf('function');

    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(server.url, { method: 'POST', headers, body: INIT_BODY(1) });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(server.url, {
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
    expect(await readRpcText(callResp)).toMatchObject({
      result: { content: [{ type: 'text', text: 'no-session' }] },
    });
    config!.disposeSessionCtx!();
  });

  it('keeps the leased old bridge live through invalidation while new sessions use a new generation', async () => {
    const oldConfig = await getPiExtraSpawnConfig([makeProvider('old_probe')], noopLogger(), {
      sessionId: 'pi-old-generation',
      workingDir: '/repo',
      vendorOptions: {},
    });
    const oldServer = oldConfig!.mcpBridge!.servers[0]!;
    const oldToken = oldConfig!.mcpBridge!.token;

    // 模拟 MCP / contacts / memory 配置保存：新会话必须换桥，但旧 Pi 子进程保存的
    // URL/token 仍可继续初始化和调用，直到它自己 close 归还 lease。
    invalidatePiEnvironment();
    const newConfig = await getPiExtraSpawnConfig([makeProvider('new_probe')], noopLogger(), {
      sessionId: 'pi-new-generation',
      workingDir: '/repo',
      vendorOptions: {},
    });
    const newServer = newConfig!.mcpBridge!.servers[0]!;
    expect(newServer.url).not.toBe(oldServer.url);
    expect(newConfig!.mcpBridge!.token).not.toBe(oldToken);

    const oldHeaders = {
      authorization: `Bearer ${oldToken}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const oldInit = await fetch(oldServer.url, { method: 'POST', headers: oldHeaders, body: INIT_BODY(41) });
    expect(oldInit.status).toBe(200);
    await oldInit.text();

    const newHeaders = {
      authorization: `Bearer ${newConfig!.mcpBridge!.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const newInit = await fetch(newServer.url, { method: 'POST', headers: newHeaders, body: INIT_BODY(42) });
    expect(newInit.status).toBe(200);
    await newInit.text();

    oldConfig!.disposeSessionCtx!();
    newConfig!.disposeSessionCtx!();
  });

  it('fail-closes policy-controlled builtins for an anonymous session (no workdir-bound policy)', async () => {
    // codex review:内置工具的项目级启停改由 bridge 按会话 workdir 冻结策略在 tools/call
    // 复核。匿名会话无 workdir 绑定,无法证明该内置工具在当前项目已启用 →
    // per-call gate fail-closed(missing_thread_context),不放行策略内置工具。
    const config = await getPiExtraSpawnConfig([makeProvider('cindy_orca')], noopLogger());
    const server = config!.mcpBridge!.servers[0]!;
    const token = config!.mcpBridge!.token;
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(server.url, { method: 'POST', headers, body: INIT_BODY(1) });
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    await initResp.text();

    const callResp = await fetch(server.url, {
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
    const result = await readRpcText(callResp) as { result?: { isError?: boolean; content?: { text?: string }[] } };
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content?.[0]?.text).toContain('could not verify this session');
  });

  it('registers the worker bridge before the Pi session role is available', async () => {
    const logger = noopLogger();
    const provider = createOrcaWorkerBridgeMcpProvider({
      logger,
      getMaker: () => {
        throw new Error('not called while registering the MCP server');
      },
      persistUserMessage: async () => {},
      wireSession: () => undefined,
    });
    const config = await getPiExtraSpawnConfig([provider], logger, {
      sessionId: 'pi-worker-1',
      workingDir: '/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'pi-worker-1',
      },
    });

    expect(config?.mcpBridge?.servers.map((server) => server.name)).toContain(
      'orca_worker_bridge',
    );
  });
});
