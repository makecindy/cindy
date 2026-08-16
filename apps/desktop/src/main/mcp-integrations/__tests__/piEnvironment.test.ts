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

import { afterEach, describe, expect, it, vi } from 'vitest';
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

function recordingLogger(): { logger: Logger; entries: Array<{ message: string; ctx?: Record<string, unknown> }> } {
  const entries: Array<{ message: string; ctx?: Record<string, unknown> }> = [];
  const record = (message: string, ctx?: Record<string, unknown>): void => {
    entries.push({ message, ...(ctx ? { ctx } : {}) });
  };
  const logger: Logger = {
    trace: record,
    debug: record,
    info: record,
    warn: record,
    error: record,
    fatal: record,
    child() {
      return logger;
    },
  };
  return { logger, entries };
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
  server.tool('current_vendor_options', 'Return the active lizi MCP vendor options.', {}, async () => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify(getLiziMcpSessionContext()?.vendorOptions ?? {}),
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
      mcpCallerKind: 'root',
      mcpCallerAttested: true,
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

  it('keeps the registered Pi MCP vendorOptions live for start_team Lead activation', async () => {
    const vendorOptions: Record<string, unknown> = { source: 'draft' };
    const config = await getPiExtraSpawnConfig([makeProvider('custom_probe')], noopLogger(), {
      sessionId: 'pi-runtime-lead',
      workingDir: '/repo',
      vendorOptions,
    });
    const server = config!.mcpBridge!.servers[0]!;
    const headers = {
      authorization: `Bearer ${config!.mcpBridge!.token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const initResp = await fetch(server.url, { method: 'POST', headers, body: INIT_BODY(21) });
    expect(initResp.status).toBe(200);
    const mcpSessionId = initResp.headers.get('mcp-session-id');
    expect(mcpSessionId).toBeTruthy();
    await initResp.text();

    // 对应 start_team 成功后的 MakerSession.setVendorOptions 原地更新。
    Object.assign(vendorOptions, {
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'pi-runtime-lead',
    });
    const callResp = await fetch(server.url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': mcpSessionId! },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 22,
        method: 'tools/call',
        params: { name: 'current_vendor_options', arguments: {} },
      }),
    });
    expect(callResp.status).toBe(200);
    const result = await readRpcText(callResp) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(JSON.parse(result.result?.content?.[0]?.text ?? '{}')).toMatchObject({
      source: 'draft',
      orcaRole: 'lead',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'pi-runtime-lead',
    });
    config!.disposeSessionCtx!();
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

  it('assembles authenticated remote HTTP MCPs with env references and no secret values in the descriptor or logs', async () => {
    const bearerSecret = 'bearer-secret-must-not-leak';
    const headerSecret = 'header-secret-must-not-leak';
    const { logger, entries } = recordingLogger();
    const provider: McpProvider = {
      name: 'custom_exa',
      toCodexMcpConfig: () => ({
        type: 'http',
        url: 'https://mcp.example.test/v1?source=pi',
        bearerTokenEnvVar: 'UPSTREAM_BEARER',
        envHttpHeaders: { 'X-Api-Key': 'UPSTREAM_API_KEY' },
      }),
      getExtraEnv: () => ({
        UPSTREAM_BEARER: bearerSecret,
        UPSTREAM_API_KEY: headerSecret,
      }),
    };

    const config = await getPiExtraSpawnConfig([provider], logger, {
      sessionId: 'pi-remote-1',
      workingDir: '/repo',
    });
    const server = config!.mcpBridge!.servers[0]!;
    expect(config!.mcpBridge!.token).toBe('');
    expect(server).toMatchObject({
      name: 'custom_exa',
      url: 'https://mcp.example.test/v1?source=pi',
      remote: { startupTimeoutMs: 10_000, requestTimeoutMs: 600_000 },
    });
    // 外部 endpoint 不能被误加 localhost bridge 的 session identity。
    expect(new URL(server.url).searchParams.has('session')).toBe(false);

    const authorizationEnv = server.remote!.headerEnvVars.authorization!;
    const apiKeyEnv = server.remote!.headerEnvVars['x-api-key']!;
    expect(authorizationEnv).toMatch(/^CINDY_PI_REMOTE_MCP_SECRET_\d+$/);
    expect(apiKeyEnv).toMatch(/^CINDY_PI_REMOTE_MCP_SECRET_\d+$/);
    expect(authorizationEnv).not.toBe(apiKeyEnv);
    expect(config!.mcpEnv).toMatchObject({
      [authorizationEnv]: `Bearer ${bearerSecret}`,
      [apiKeyEnv]: headerSecret,
    });

    const descriptor = JSON.stringify(config!.mcpBridge);
    const logs = JSON.stringify(entries);
    for (const secret of [bearerSecret, headerSecret]) {
      expect(descriptor).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
    config!.disposeSessionCtx!();
  });

  it('derives a stable per-session bridge token across rebuilds (round 41 — envHash stability)', async () => {
    // 回归(轮 41 CRITICAL):token 曾每次 randomBytes 新生成 → 断链重连重建
    // spawn env 时 CINDY_PI_MCP_BRIDGE 必变 → envHash 必变 → daemon ensure
    // 判配置变更 → kill + respawn —— "正常对话期间突然 kill"根因。同 session
    // 两次构建(模拟断链重连)token 必须逐字节稳定,否则 attach 保活失效。
    const configA = await getPiExtraSpawnConfig([makeProvider()], noopLogger(), {
      sessionId: 'stable-token-session',
      sessionInstanceId: 'inst-1',
      workingDir: '/repo',
      vendorOptions: {},
    });
    const configB = await getPiExtraSpawnConfig([makeProvider()], noopLogger(), {
      sessionId: 'stable-token-session',
      sessionInstanceId: 'inst-2',
      workingDir: '/repo',
      vendorOptions: {},
    });
    expect(configA!.mcpBridge!.token).toBe(configB!.mcpBridge!.token);
    expect(configA!.mcpBridge!.token).toMatch(/^[0-9a-f]{64}$/);
    // 隔离性保持:不同 session 的 token 必须不同(HMAC 派生, 非全局固定值)。
    const configOther = await getPiExtraSpawnConfig([makeProvider()], noopLogger(), {
      sessionId: 'other-session',
      sessionInstanceId: 'inst-1',
      workingDir: '/repo',
      vendorOptions: {},
    });
    expect(configOther!.mcpBridge!.token).not.toBe(configA!.mcpBridge!.token);
    configA!.disposeSessionCtx!();
    configB!.disposeSessionCtx!();
    configOther!.disposeSessionCtx!();
  });

  it('fail-closes malformed or incomplete remote HTTP providers without hiding a valid provider', async () => {
    const logCanary = 'remote-secret-log-canary';
    const { logger, entries } = recordingLogger();
    const valid: McpProvider = {
      name: 'valid_remote',
      toCodexMcpConfig: () => ({ type: 'http', url: 'https://valid.example.test/mcp' }),
    };
    const validLoopback: McpProvider = {
      name: 'valid_loopback',
      toCodexMcpConfig: () => ({ type: 'http', url: 'http://127.0.0.1:4321/mcp' }),
    };
    const validIpv6Loopback: McpProvider = {
      name: 'valid_ipv6_loopback',
      toCodexMcpConfig: () => ({ type: 'http', url: 'http://[::1]:4321/mcp' }),
    };
    const providers: McpProvider[] = [
      {
        name: 'missing_bearer',
        toCodexMcpConfig: () => ({
          type: 'http', url: 'https://missing.example.test/mcp', bearerTokenEnvVar: 'MISSING',
        }),
        getExtraEnv: () => ({ UNUSED: logCanary }),
      },
      {
        name: 'missing_header',
        toCodexMcpConfig: () => ({
          type: 'http',
          url: 'https://missing-header.example.test/mcp',
          envHttpHeaders: { 'X-Api-Key': 'MISSING_HEADER' },
        }),
      },
      {
        name: 'invalid_scheme',
        toCodexMcpConfig: () => ({ type: 'http', url: 'file:///tmp/not-an-http-mcp' }),
      },
      {
        name: 'insecure_non_loopback',
        toCodexMcpConfig: () => ({ type: 'http', url: 'http://public.example.test/mcp' }),
      },
      {
        // 127/8 都由 OS 视为 loopback，但 Pi 的 NO_PROXY 只保证 127.0.0.1；其余地址
        // 不得明文携带认证 header，以免被全局 HTTP_PROXY 接走。
        name: 'loopback_outside_no_proxy',
        toCodexMcpConfig: () => ({ type: 'http', url: 'http://127.0.0.2:4321/mcp' }),
      },
      {
        name: 'embedded_credentials',
        toCodexMcpConfig: () => ({ type: 'http', url: 'https://user:secret@example.test/mcp' }),
      },
      {
        name: 'invalid_header',
        toCodexMcpConfig: () => ({
          type: 'http',
          url: 'https://bad-header.example.test/mcp',
          envHttpHeaders: { 'bad\nname': 'BAD_HEADER' },
        }),
        getExtraEnv: () => ({ BAD_HEADER: logCanary }),
      },
      {
        name: 'throwing_environment',
        toCodexMcpConfig: () => ({ type: 'http', url: 'https://throw-env.example.test/mcp' }),
        getExtraEnv: () => { throw new Error(logCanary); },
      },
      {
        name: 'throwing_config',
        toCodexMcpConfig: () => { throw new Error(logCanary); },
      },
      valid,
      validLoopback,
      validIpv6Loopback,
    ];

    const config = await getPiExtraSpawnConfig(providers, logger);
    expect(config!.mcpBridge!.servers.map((server) => server.name)).toEqual([
      'valid_remote',
      'valid_loopback',
      'valid_ipv6_loopback',
    ]);
    const logs = JSON.stringify(entries);
    expect(logs).not.toContain(logCanary);
    expect(logs).not.toContain('user:secret');
    config!.disposeSessionCtx!();
  });

  it('snapshots remote MCP lifecycle changes for new sessions while old leases keep their startup config', async () => {
    let enabled = true;
    let url = 'https://old.example.test/mcp';
    let secret = 'old-generation-secret';
    const provider: McpProvider = {
      name: 'mutable_remote',
      isEnabled: () => enabled,
      toCodexMcpConfig: () => ({
        type: 'http',
        url,
        envHttpHeaders: { 'X-Api-Key': 'MUTABLE_SECRET' },
      }),
      getExtraEnv: () => ({ MUTABLE_SECRET: secret }),
    };

    // 启动前已配置：首个 Pi session 直接拿到 remote server 快照。
    const oldConfig = await getPiExtraSpawnConfig([provider], noopLogger());
    expect(oldConfig!.mcpBridge!.servers[0]!.url).toBe(url);
    expect(Object.values(oldConfig!.mcpEnv!)).toContain('old-generation-secret');

    // 运行中修改 + 重复触发 invalidation：下一新会话/重启使用新值，旧 lease 不漂移。
    url = 'https://new.example.test/mcp';
    secret = 'new-generation-secret';
    invalidatePiEnvironment();
    invalidatePiEnvironment();
    const newConfig = await getPiExtraSpawnConfig([provider], noopLogger());
    expect(newConfig!.mcpBridge!.servers[0]!.url).toBe(url);
    expect(Object.values(newConfig!.mcpEnv!)).toContain('new-generation-secret');
    expect(oldConfig!.mcpBridge!.servers[0]!.url).toBe('https://old.example.test/mcp');
    expect(Object.values(oldConfig!.mcpEnv!)).toContain('old-generation-secret');

    // 禁用和删除都在下一 generation 撤销；再次新增后可恢复，无需重启应用。
    enabled = false;
    invalidatePiEnvironment();
    expect(await getPiExtraSpawnConfig([provider], noopLogger())).toBeNull();
    invalidatePiEnvironment();
    expect(await getPiExtraSpawnConfig([], noopLogger())).toBeNull();
    enabled = true;
    secret = 'readded-secret';
    invalidatePiEnvironment();
    const readded = await getPiExtraSpawnConfig([provider], noopLogger());
    expect(Object.values(readded!.mcpEnv!)).toContain('readded-secret');

    oldConfig!.disposeSessionCtx!();
    newConfig!.disposeSessionCtx!();
    readded!.disposeSessionCtx!();
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
    expect(result.result?.content?.[0]?.text).toContain('verified Cindy session');
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

  // ── 轮 40-w4 HIGH 回归保护:ensureBridge 成功路径的 30s 超时 timer 必须取消 ──
  it('does not re-create the bridge when 30s elapse after a successful start (round 40-w4 HIGH)', async () => {
    vi.useFakeTimers();
    try {
      // 首次调用:启动 bridge
      const first = await getPiExtraSpawnConfig([makeProvider('cindy_probe')], noopLogger(), {
        sessionId: 'sess-a',
        workingDir: '/repo',
      });
      expect(first?.mcpBridge?.servers.length).toBeGreaterThan(0);

      // 推进 30s —— 修复前:迟到 timer 清空 startPromise → 下次调用重建 bridge。
      await vi.advanceTimersByTimeAsync(30_000);

      // 再次调用:应命中已完成的 startPromise(缓存), 不重建。
      const second = await getPiExtraSpawnConfig([makeProvider('cindy_probe')], noopLogger(), {
        sessionId: 'sess-b',
        workingDir: '/repo',
      });
      expect(second?.mcpBridge?.servers.length).toBeGreaterThan(0);
      // 断言仍复用同一 bridge:两次返回的 URL 端口一致 = 未重建新 HTTP server
      // (URL 的 ?session= 因 sessionId 不同而不同, 只比端口)。
      const portOf = (u: string | undefined) => new URL(u ?? '').port;
      expect(portOf(second?.mcpBridge?.servers[0]?.url)).toBe(portOf(first?.mcpBridge?.servers[0]?.url));
    } finally {
      vi.useRealTimers();
    }
  });
});
