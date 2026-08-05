/**
 * PiAgent × cindy-bridge 端到端集成测试 —— 证明「模型经桥调 cindy MCP 工具」
 * 与「ask 权限门放行/拒绝」两条链真通。
 *
 * 拓扑(全本地,无网络):
 *   真 pi 二进制  ──RPC──▶ PiAgent
 *        │ HTTP(streamable MCP, SDK) ──▶ 假 MCP server(注册一个 cindy_echo 工具)
 *        │ HTTP(anthropic SSE)       ──▶ 假网关(脚本化两轮:先 tool_use 调 cindy_echo,
 *        │                                拿到 tool_result 后再出最终 text)
 *   PiAgent.interactionResolver ◀── extension_ui_request(权限询问)
 *
 * 断言:
 *   1. 模型发起的 tool_use 打到假 MCP server(工具确实经 cindy-bridge 注册+转发)
 *   2. ask 档下该工具触发 interactionResolver;allow → 工具执行、最终 text 含回显
 *   3. deny 场景:另一会话 resolver 返回 deny → 工具不执行,MCP server 未被命中
 *
 * pi 二进制缺失时 skip。
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { PiAgent } from '../index.js';
import type { AgentDeps, AgentSessionHandle, PiExtraSpawnConfig } from '../../base-agent.js';
import type { AgentEvent, InteractionRequest, InteractionDecision } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const PI_BINARY = path.join(
  REPO_ROOT,
  'apps',
  'pi-bin',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'pi.exe' : 'pi',
);
const piAvailable = existsSync(PI_BINARY);

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

function recordingLogger(entries: Array<{ message: string; ctx?: Record<string, unknown> }>): Logger {
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
    child: () => logger,
  };
  return logger;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// ── 假网关:脚本化两轮 anthropic Messages 流 ─────────────────────────────────
// 第 1 次请求(messages 里没有 tool_result)→ 出 tool_use 调 cindy_echo。
// 第 2 次请求(已带 tool_result)→ 出最终 text。
function anthropicTurn(hasToolResult: boolean, toolName: string): string {
  if (!hasToolResult) {
    return (
      sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_1', type: 'message', role: 'assistant', model: 'pi-test-model',
          content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 },
        },
      }) +
      sseEvent('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: toolName, input: {} },
      }) +
      sseEvent('content_block_delta', {
        type: 'content_block_delta', index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify({ text: 'hello-pi' }) },
      }) +
      sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      sseEvent('message_delta', {
        type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 },
      }) +
      sseEvent('message_stop', { type: 'message_stop' })
    );
  }
  return (
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_2', type: 'message', role: 'assistant', model: 'pi-test-model',
        content: [], stop_reason: null, usage: { input_tokens: 30, output_tokens: 0 },
      },
    }) +
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    sseEvent('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'tool said: ECHO[hello-pi]' },
    }) +
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sseEvent('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 },
    }) +
    sseEvent('message_stop', { type: 'message_stop' })
  );
}

describe.skipIf(!piAvailable)('PiAgent × cindy-bridge (real pi + MCP bridge + permission gate)', () => {
  let gateway: Server;
  let gatewayUrl = '';
  let mcpHttp: Server;
  let mcpUrl = '';
  const MCP_TOKEN = 'bridge-token-xyz';
  const REMOTE_BEARER = 'remote-bearer-secret';
  const REMOTE_API_KEY = 'remote-api-key-secret';
  const REMOTE_ERROR_CANARY = 'remote-error-body-secret-canary';
  let agentHome = '';
  const echoCalls: Array<{ text: unknown }> = [];
  // 记录假 MCP server 收到的请求 URL —— 断言真 pi(经 cindy-bridge fetch)把
  // host 下发的 `?session=<id>` 原样带到每个 MCP 请求上(orca 身份路由的 pi 侧半)。
  const seenMcpUrls: string[] = [];
  const seenRemoteHeaders: Array<{ authorization?: string; apiKey?: string }> = [];
  const paginatedListCursors: Array<string | undefined> = [];
  const timedOutPaginationCursors: Array<string | undefined> = [];

  beforeAll(async () => {
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-mcp-int-'));

    // 假网关:按 messages 是否含 tool_result 决定出哪一轮。
    gateway = createServer(async (req, res) => {
      const body = await readBody(req);
      const hasToolResult = body.includes('tool_result') || body.includes('toolResult');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(anthropicTurn(hasToolResult, 'mcp__cindy_echo__echo'));
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    const gAddr = gateway.address();
    if (typeof gAddr === 'object' && gAddr) gatewayUrl = `http://127.0.0.1:${gAddr.port}`;

    // 假 MCP server(streamable-HTTP + bearer + 单工具 echo),与 codexHttpBridge 同构。
    mcpHttp = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      seenMcpUrls.push(req.url ?? '');
      const auth = req.headers.authorization ?? '';
      const apiKey = Array.isArray(req.headers['x-api-key'])
        ? req.headers['x-api-key'][0]
        : req.headers['x-api-key'];
      if (auth === `Bearer ${REMOTE_BEARER}` || apiKey) {
        seenRemoteHeaders.push({
          ...(auth ? { authorization: auth } : {}),
          ...(apiKey ? { apiKey } : {}),
        });
      }
      if (req.url?.includes('/paginated-timeout')) {
        if (auth !== `Bearer ${REMOTE_BEARER}`) {
          res.writeHead(401).end('unauthorized');
          return;
        }
        const body = JSON.parse(await readBody(req)) as {
          id?: number;
          method?: string;
          params?: { cursor?: string };
        };
        if (body.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        let result: unknown;
        if (body.method === 'initialize') {
          result = {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'paginated-timeout', version: '1.0.0' },
          };
        } else if (body.method === 'tools/list') {
          timedOutPaginationCursors.push(body.params?.cursor);
          if (body.params?.cursor === 'slow-page') {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          result = body.params?.cursor === undefined
            ? { tools: [], nextCursor: 'slow-page' }
            : { tools: [] };
        } else {
          result = {};
        }
        if (!res.destroyed && !res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        }
        return;
      }
      if (req.url?.includes('/paginated')) {
        if (auth !== `Bearer ${REMOTE_BEARER}` || apiKey !== REMOTE_API_KEY) {
          res.writeHead(401).end('unauthorized');
          return;
        }
        const body = JSON.parse(await readBody(req)) as {
          id?: number;
          method?: string;
          params?: { cursor?: string; arguments?: { text?: unknown } };
        };
        if (body.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        const tool = (name: string) => ({
          name,
          description: `Tool from ${name}`,
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        });
        let result: unknown;
        if (body.method === 'initialize') {
          result = {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'paginated', version: '1.0.0' },
          };
        } else if (body.method === 'tools/list') {
          const cursor = body.params?.cursor;
          paginatedListCursors.push(cursor);
          result = cursor === undefined
            ? { tools: [tool('page_one')], nextCursor: 'page-2' }
            : cursor === 'page-2'
              ? { tools: [tool('page_two')], nextCursor: 'page-3' }
              : { tools: [tool('echo')] };
        } else if (body.method === 'tools/call') {
          const text = body.params?.arguments?.text;
          echoCalls.push({ text });
          result = { content: [{ type: 'text', text: `ECHO[${String(text)}]` }] };
        } else {
          result = {};
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      if (req.url?.includes('/persistent-sse')) {
        if (auth !== `Bearer ${REMOTE_BEARER}` || apiKey !== REMOTE_API_KEY) {
          res.writeHead(401).end('unauthorized');
          return;
        }
        const body = JSON.parse(await readBody(req)) as {
          id?: number;
          method?: string;
          params?: { arguments?: { text?: unknown } };
        };
        if (body.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        let result: unknown;
        if (body.method === 'initialize') {
          result = {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'persistent-sse', version: '1.0.0' },
          };
        } else if (body.method === 'tools/list') {
          result = {
            tools: [{
              name: 'echo',
              description: 'Echo text back',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            }],
          };
        } else if (body.method === 'tools/call') {
          // 超过 50ms startup budget 后才回工具结果，证明探测完成后切回长 request budget。
          await new Promise((resolve) => setTimeout(resolve, 120));
          const text = body.params?.arguments?.text;
          echoCalls.push({ text });
          result = { content: [{ type: 'text', text: `ECHO[${String(text)}]` }] };
        } else {
          result = {};
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\r\n\r\n`);
        // 合法 Streamable HTTP server 可在返回当前 response 后继续保持 SSE 流；client
        // 必须在 event 到达时返回并取消流，而不是等待这里结束。
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!res.destroyed && !res.writableEnded) res.end();
        return;
      }
      if (req.url?.includes('/reject')) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end(REMOTE_ERROR_CANARY);
        return;
      }
      if (req.url?.includes('/slow')) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!res.destroyed && !res.writableEnded) res.writeHead(504).end('late response');
        return;
      }
      if (req.url?.includes('/stall-body')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"jsonrpc":"2.0","id":1');
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!res.destroyed && !res.writableEnded) res.end('}');
        return;
      }
      const localAuthorized = auth === `Bearer ${MCP_TOKEN}`;
      const remoteAuthorized = auth === `Bearer ${REMOTE_BEARER}` && apiKey === REMOTE_API_KEY;
      if (!localAuthorized && !remoteAuthorized) {
        res.writeHead(401).end('unauthorized');
        return;
      }
      const server = new McpServer({ name: 'cindy_echo', version: '1.0.0' });
      server.registerTool(
        'echo',
        { description: 'Echo text back in uppercase', inputSchema: { text: z.string() } },
        async ({ text }) => {
          echoCalls.push({ text });
          return { content: [{ type: 'text', text: `ECHO[${text}]` }] };
        },
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      const body = await readBody(req);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
    await new Promise<void>((r) => mcpHttp.listen(0, '127.0.0.1', r));
    const mAddr = mcpHttp.address();
    if (typeof mAddr === 'object' && mAddr) mcpUrl = `http://127.0.0.1:${mAddr.port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => gateway.close(() => r()));
    await new Promise<void>((r) => mcpHttp.close(() => r()));
    rmSync(agentHome, { recursive: true, force: true });
  });

  function buildDeps(
    bridgeMode: 'local' | 'remote' | 'remote-sse' | 'remote-paginated' | 'remote-failures' = 'local',
    logger: Logger = noopLogger,
  ): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'k' }),
      },
      runtimeConfig: { endpoint: gatewayUrl },
      binaryPath: PI_BINARY,
      logger,
      capabilityAdditions: {
        availableModels: [
          { id: 'pi-test-model', displayName: 'Pi Test', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      resolvePiAgentHome: () => agentHome,
      // host MCP bridge 出口:指向本测试的假 MCP server。把 ctx.sessionId 打进
      // `?session=` —— 既验 PiAgent.startSession 把 opts.sessionId 透传进 ctx,
      // 又让假 server 能观察到真 pi 是否原样转发该 query(见 seenMcpUrls 断言)。
      preparePiExtraSpawnConfig: async (_providers, ctx): Promise<PiExtraSpawnConfig> => {
        if (bridgeMode === 'remote') {
          return {
            mcpBridge: {
              // 故意给一个错误的 local token，证明 direct remote 不会把它当 Authorization。
              token: 'must-not-be-sent-to-remote',
              servers: [{
                name: 'cindy_echo',
                url: mcpUrl,
                remote: {
                  headerEnvVars: {
                    authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0',
                    'x-api-key': 'CINDY_PI_REMOTE_MCP_SECRET_1',
                  },
                  startupTimeoutMs: 1_000,
                  requestTimeoutMs: 5_000,
                },
              }],
            },
            mcpEnv: {
              CINDY_PI_REMOTE_MCP_SECRET_0: `Bearer ${REMOTE_BEARER}`,
              CINDY_PI_REMOTE_MCP_SECRET_1: REMOTE_API_KEY,
            },
          };
        }
        if (bridgeMode === 'remote-sse') {
          return {
            mcpBridge: {
              token: '',
              servers: [{
                name: 'cindy_echo',
                url: `${mcpUrl}/persistent-sse`,
                remote: {
                  headerEnvVars: {
                    authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0',
                    'x-api-key': 'CINDY_PI_REMOTE_MCP_SECRET_1',
                  },
                  startupTimeoutMs: 50,
                  requestTimeoutMs: 1_000,
                },
              }],
            },
            mcpEnv: {
              CINDY_PI_REMOTE_MCP_SECRET_0: `Bearer ${REMOTE_BEARER}`,
              CINDY_PI_REMOTE_MCP_SECRET_1: REMOTE_API_KEY,
            },
          };
        }
        if (bridgeMode === 'remote-paginated') {
          return {
            mcpBridge: {
              token: '',
              servers: [{
                name: 'cindy_echo',
                url: `${mcpUrl}/paginated`,
                remote: {
                  headerEnvVars: {
                    authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0',
                    'x-api-key': 'CINDY_PI_REMOTE_MCP_SECRET_1',
                  },
                  startupTimeoutMs: 1_000,
                  requestTimeoutMs: 1_000,
                },
              }],
            },
            mcpEnv: {
              CINDY_PI_REMOTE_MCP_SECRET_0: `Bearer ${REMOTE_BEARER}`,
              CINDY_PI_REMOTE_MCP_SECRET_1: REMOTE_API_KEY,
            },
          };
        }
        if (bridgeMode === 'remote-failures') {
          return {
            mcpBridge: {
              token: '',
              servers: [
                {
                  name: 'rejecting_remote',
                  url: `${mcpUrl}/reject`,
                  remote: {
                    headerEnvVars: { authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0' },
                    startupTimeoutMs: 1_000,
                    requestTimeoutMs: 1_000,
                  },
                },
                {
                  name: 'slow_remote',
                  url: `${mcpUrl}/slow`,
                  remote: {
                    headerEnvVars: { authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0' },
                    startupTimeoutMs: 50,
                    requestTimeoutMs: 5_000,
                  },
                },
                {
                  name: 'stalling_body_remote',
                  url: `${mcpUrl}/stall-body`,
                  remote: {
                    headerEnvVars: { authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0' },
                    startupTimeoutMs: 50,
                    requestTimeoutMs: 5_000,
                  },
                },
                {
                  name: 'paginated_timeout_remote',
                  url: `${mcpUrl}/paginated-timeout`,
                  remote: {
                    headerEnvVars: { authorization: 'CINDY_PI_REMOTE_MCP_SECRET_0' },
                    startupTimeoutMs: 200,
                    requestTimeoutMs: 5_000,
                  },
                },
              ],
            },
            mcpEnv: { CINDY_PI_REMOTE_MCP_SECRET_0: `Bearer ${REMOTE_BEARER}` },
          };
        }
        return {
          mcpBridge: {
            token: MCP_TOKEN,
            servers: [
              {
                name: 'cindy_echo',
                url: ctx?.sessionId
                  ? `${mcpUrl}?session=${encodeURIComponent(ctx.sessionId)}`
                  : mcpUrl,
              },
            ],
          },
        };
      },
    };
  }

  async function runOneTurn(
    permissionMode: 'ask' | 'bypassPermissions',
    resolver: (req: InteractionRequest) => Promise<InteractionDecision>,
    bridgeMode: 'local' | 'remote' | 'remote-sse' | 'remote-paginated' = 'local',
  ): Promise<{ events: AgentEvent[]; permissionAsked: boolean }> {
    const agent = new PiAgent(buildDeps(bridgeMode));
    const cwd = mkdtempSync(path.join(tmpdir(), 'pi-mcp-cwd-'));
    let handle: AgentSessionHandle | null = null;
    let permissionAsked = false;
    try {
      handle = await agent.startSession({
        sessionId: `mcp-itest-${permissionMode}`,
        workingDir: cwd,
        model: 'pi-test-model',
        permissionMode,
      });
      handle.setInteractionResolver(async (req) => {
        if (req.kind === 'permission') permissionAsked = true;
        return resolver(req);
      });
      const events: AgentEvent[] = [];
      const done = (async () => {
        for await (const ev of handle!.events()) {
          events.push(ev);
          if (ev.type === 'done') break;
        }
      })();
      await handle.send({ type: 'user', content: 'call the echo tool' });
      await done;
      return { events, permissionAsked };
    } finally {
      await handle?.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  it(
    'ask + allow: 模型经桥调 cindy 工具 → 触发权限询问 → 放行 → 工具执行 → 最终 text 含回显',
    { timeout: 90_000 },
    async () => {
      echoCalls.length = 0;
      seenMcpUrls.length = 0;
      const { events, permissionAsked } = await runOneTurn('ask', async (req) => {
        expect(req.kind).toBe('permission');
        if (req.kind === 'permission') {
          expect(req.toolName).toBe('mcp__cindy_echo__echo');
        }
        return { kind: 'permission', behavior: 'allow' };
      });

      expect(permissionAsked).toBe(true);
      expect(echoCalls.length).toBeGreaterThan(0);
      expect(echoCalls[0]?.text).toBe('hello-pi');

      // 真 pi(经 cindy-bridge)必须把 host 下发的 `?session=<sessionId>` 原样带到
      // MCP 请求上 —— 这是 orca 身份路由能在真 pi 上生效的 pi 侧前提。
      expect(seenMcpUrls.length).toBeGreaterThan(0);
      expect(seenMcpUrls.every((u) => u.includes('session=mcp-itest-ask'))).toBe(true);

      const finalText = events
        .filter((e) => e.type === 'text')
        .map((e) => e.data as { text: string; isFinal?: boolean })
        .filter((d) => d.isFinal)
        .map((d) => d.text)
        .join('');
      expect(finalText).toContain('ECHO[hello-pi]');
    },
  );

  it(
    'direct remote HTTP: uses env-backed bearer/custom headers instead of the localhost bridge token',
    { timeout: 90_000 },
    async () => {
      echoCalls.length = 0;
      seenMcpUrls.length = 0;
      seenRemoteHeaders.length = 0;
      let proxyHits = 0;
      const proxy = createServer((_req, res) => {
        proxyHits += 1;
        res.writeHead(502).end('loopback traffic must not reach HTTP_PROXY');
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const proxyAddress = proxy.address();
      if (typeof proxyAddress !== 'object' || !proxyAddress) throw new Error('proxy did not listen');
      const previous = {
        HTTP_PROXY: process.env.HTTP_PROXY,
        http_proxy: process.env.http_proxy,
        NO_PROXY: process.env.NO_PROXY,
        no_proxy: process.env.no_proxy,
      };
      process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
      delete process.env.http_proxy;
      process.env.NO_PROXY = '';
      delete process.env.no_proxy;
      let turn: Awaited<ReturnType<typeof runOneTurn>> | undefined;
      try {
        turn = await runOneTurn(
          'bypassPermissions',
          async () => ({ kind: 'permission', behavior: 'deny' }),
          'remote',
        );
      } finally {
        for (const name of Object.keys(previous)) delete process.env[name];
        for (const [name, value] of Object.entries(previous)) {
          if (value !== undefined) process.env[name] = value;
        }
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }

      expect(turn).toBeDefined();
      const { events, permissionAsked } = turn!;
      expect(proxyHits).toBe(0);
      expect(permissionAsked).toBe(false);
      expect(echoCalls).toEqual([{ text: 'hello-pi' }]);
      expect(seenRemoteHeaders.length).toBeGreaterThan(0);
      expect(seenRemoteHeaders.every((headers) =>
        headers.authorization === `Bearer ${REMOTE_BEARER}` && headers.apiKey === REMOTE_API_KEY
      )).toBe(true);
      expect(seenMcpUrls.every((url) => !url.includes('session='))).toBe(true);
      const finalText = events
        .filter((event) => event.type === 'text')
        .map((event) => event.data as { text: string; isFinal?: boolean })
        .filter((data) => data.isFinal)
        .map((data) => data.text)
        .join('');
      expect(finalText).toContain('ECHO[hello-pi]');
    },
  );

  it(
    'persistent SSE: registers on the matching event without waiting for stream close, then uses the long tool timeout',
    { timeout: 90_000 },
    async () => {
      echoCalls.length = 0;
      const { events, permissionAsked } = await runOneTurn(
        'bypassPermissions',
        async () => ({ kind: 'permission', behavior: 'deny' }),
        'remote-sse',
      );

      expect(permissionAsked).toBe(false);
      expect(echoCalls).toEqual([{ text: 'hello-pi' }]);
      const finalText = events
        .filter((event) => event.type === 'text')
        .map((event) => event.data as { text: string; isFinal?: boolean })
        .filter((data) => data.isFinal)
        .map((data) => data.text)
        .join('');
      expect(finalText).toContain('ECHO[hello-pi]');
    },
  );

  it(
    'paginated tools/list: follows every cursor within startup and registers a tool from the final page',
    { timeout: 90_000 },
    async () => {
      echoCalls.length = 0;
      paginatedListCursors.length = 0;
      const { events, permissionAsked } = await runOneTurn(
        'bypassPermissions',
        async () => ({ kind: 'permission', behavior: 'deny' }),
        'remote-paginated',
      );

      expect(permissionAsked).toBe(false);
      expect(paginatedListCursors).toEqual([undefined, 'page-2', 'page-3']);
      expect(echoCalls).toEqual([{ text: 'hello-pi' }]);
      const finalText = events
        .filter((event) => event.type === 'text')
        .map((event) => event.data as { text: string; isFinal?: boolean })
        .filter((data) => data.isFinal)
        .map((data) => data.text)
        .join('');
      expect(finalText).toContain('ECHO[hello-pi]');
    },
  );

  it(
    'remote startup failures and timeouts are visible without logging URL, response body, or auth secrets',
    { timeout: 30_000 },
    async () => {
      const entries: Array<{ message: string; ctx?: Record<string, unknown> }> = [];
      const logger = recordingLogger(entries);
      timedOutPaginationCursors.length = 0;
      const agent = new PiAgent(buildDeps('remote-failures', logger));
      const cwd = mkdtempSync(path.join(tmpdir(), 'pi-mcp-failure-cwd-'));
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'mcp-remote-failure-itest',
          workingDir: cwd,
          model: 'pi-test-model',
          permissionMode: 'bypassPermissions',
        });
        await waitFor(() => {
          const logs = JSON.stringify(entries);
          return logs.includes('HTTP 401')
            && logs.includes('connect slow_remote failed: request timed out')
            && logs.includes('connect stalling_body_remote failed: request timed out')
            && logs.includes('connect paginated_timeout_remote failed: request timed out');
        });
        const logs = JSON.stringify(entries);
        expect(logs).toContain('connect rejecting_remote failed: HTTP 401');
        expect(logs).toContain('connect slow_remote failed: request timed out');
        expect(logs).toContain('connect stalling_body_remote failed: request timed out');
        expect(logs).toContain('connect paginated_timeout_remote failed: request timed out');
        expect(timedOutPaginationCursors).toEqual([undefined, 'slow-page']);
        for (const forbidden of [REMOTE_BEARER, REMOTE_API_KEY, REMOTE_ERROR_CANARY, mcpUrl]) {
          expect(logs).not.toContain(forbidden);
        }
      } finally {
        await handle?.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  it(
    'ask + deny: 权限拒绝 → cindy 工具不执行(MCP server 未被命中)',
    { timeout: 90_000 },
    async () => {
      echoCalls.length = 0;
      const { permissionAsked } = await runOneTurn('ask', async () => ({
        kind: 'permission',
        behavior: 'deny',
        reason: 'test denies',
      }));
      expect(permissionAsked).toBe(true);
      expect(echoCalls.length).toBe(0);
    },
  );
});

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
