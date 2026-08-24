/**
 * PiAgent × cindy-bridge 端到端集成测试 —— 证明「模型经桥调 cindy MCP 工具」
 * 与「ask 权限门放行/拒绝」两条链真通。
 *
 * 拓扑(全本地,无网络):
 *   真 pi 二进制  ──RPC──▶ PiAgent
 *        │ HTTP(streamable MCP, SDK) ──▶ 假 MCP server(覆盖多 server、多参数形状与同名工具)
 *        │ HTTP(anthropic SSE)       ──▶ 假网关(脚本化三轮:先发现、再经稳定网关调用，
 *        │                                拿到真实 tool_result 后再出最终 text)
 *   PiAgent.interactionResolver ◀── extension_ui_request(权限询问)
 *
 * 断言:
 *   1. 模型启动面只有两个稳定网关 schema，不再含每个 mcp__<server>__<tool>
 *   2. list_tools → call_tool 真正打到假 MCP server，多工具连续调用仍全部可达
 *   3. ask 档下 Host 仍看到真实 MCP identity；allow/deny 与错误修正链保持成立
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

function anthropicToolTurn(
  sequence: number,
  toolName: string,
  input: Record<string, unknown>,
): string {
  return (
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${sequence}`, type: 'message', role: 'assistant', model: 'pi-test-model',
        content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 },
      },
    }) +
    sseEvent('content_block_start', {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: `toolu_${sequence}`, name: toolName, input: {} },
    }) +
    sseEvent('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    }) +
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sseEvent('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 },
    }) +
    sseEvent('message_stop', { type: 'message_stop' })
  );
}

function anthropicTextTurn(sequence: number, text: string): string {
  return (
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${sequence}`, type: 'message', role: 'assistant', model: 'pi-test-model',
        content: [], stop_reason: null, usage: { input_tokens: 30, output_tokens: 0 },
      },
    }) +
    sseEvent('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    sseEvent('content_block_delta', {
      type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text },
    }) +
    sseEvent('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    sseEvent('message_delta', {
      type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 },
    }) +
    sseEvent('message_stop', { type: 'message_stop' })
  );
}

function countToolResults(requestBody: string): number {
  return (requestBody.match(/"type":"tool_result"/g) ?? []).length;
}

function latestToolResultContent(request: Record<string, unknown>): string {
  const messages = request.messages as Array<{
    content?: Array<{ type?: string; content?: string }>;
  }> | undefined;
  for (const message of [...(messages ?? [])].reverse()) {
    const result = [...(message.content ?? [])].reverse().find((item) => item.type === 'tool_result');
    if (result?.content !== undefined) return result.content;
  }
  throw new Error('model request did not contain a tool_result');
}

function scriptedAnthropicTurn(requestBody: string): string {
  const toolResultCount = countToolResults(requestBody);
  if (requestBody.includes('multi command MCP workflow')) {
    const turns: Array<{ name: string; input: Record<string, unknown> }> = [
      { name: 'cindy_mcp_list_tools', input: {} },
      { name: 'cindy_mcp_list_tools', input: { server: 'cindy_workspace', tool: 'status' } },
      { name: 'cindy_mcp_call_tool', input: { server: 'cindy_workspace', tool: 'status', args: {} } },
      { name: 'cindy_mcp_list_tools', input: { server: 'cindy_workspace', tool: 'sum' } },
      {
        name: 'cindy_mcp_call_tool',
        input: { server: 'cindy_workspace', tool: 'sum', args: { values: [3, 5, 8] } },
      },
      { name: 'cindy_mcp_list_tools', input: { server: 'cindy_workspace', tool: 'configure' } },
      {
        name: 'cindy_mcp_call_tool',
        input: {
          server: 'cindy_workspace',
          tool: 'configure',
          args: { options: { retries: 2, flags: ['safe', 'fast'] } },
        },
      },
      { name: 'cindy_mcp_list_tools', input: { server: 'cindy_workspace', tool: 'lookup' } },
      {
        name: 'cindy_mcp_call_tool',
        input: { server: 'cindy_workspace', tool: 'lookup', args: { query: 'release-notes' } },
      },
      { name: 'cindy_mcp_list_tools', input: { server: 'cindy_contacts', tool: 'lookup' } },
      {
        name: 'cindy_mcp_call_tool',
        input: { server: 'cindy_contacts', tool: 'lookup', args: { query: 'Ada' } },
      },
    ];
    const next = turns[toolResultCount];
    return next
      ? anthropicToolTurn(toolResultCount + 1, next.name, next.input)
      : anthropicTextTurn(
          turns.length + 1,
          'workflow complete: READY, SUM[16], CONFIGURED[2:safe,fast], WORKSPACE[release-notes], CONTACT[Ada]',
        );
  }
  if (requestBody.includes('unknown gateway tool')) {
    return toolResultCount === 0
      ? anthropicToolTurn(1, 'cindy_mcp_call_tool', {
          server: 'missing_server',
          tool: 'missing_tool',
          args: {},
        })
      : anthropicTextTurn(2, 'unknown tool rejected safely');
  }
  if (requestBody.includes('inspect unavailable MCP')) {
    return toolResultCount === 0
      ? anthropicToolTurn(1, 'cindy_mcp_list_tools', {})
      : anthropicTextTurn(2, 'unavailable servers reported');
  }
  if (requestBody.includes('call without schema inspection')) {
    if (toolResultCount === 0) {
      return anthropicToolTurn(1, 'cindy_mcp_call_tool', {
        server: 'cindy_echo', tool: 'echo', args: { text: 'hello-pi' },
      });
    }
    if (toolResultCount === 1) {
      return anthropicToolTurn(2, 'cindy_mcp_list_tools', {
        server: 'cindy_echo', tool: 'echo',
      });
    }
    if (toolResultCount === 2) {
      return anthropicToolTurn(3, 'cindy_mcp_call_tool', {
        server: 'cindy_echo', tool: 'echo', args: { text: 'hello-pi' },
      });
    }
    return anthropicTextTurn(4, 'blind call was gated safely');
  }
  if (requestBody.includes('invalid args then correct')) {
    if (toolResultCount === 0) return anthropicToolTurn(1, 'cindy_mcp_list_tools', {});
    if (toolResultCount === 1) {
      return anthropicToolTurn(2, 'cindy_mcp_list_tools', {
        server: 'cindy_echo', tool: 'echo',
      });
    }
    if (toolResultCount === 2) {
      return anthropicToolTurn(3, 'cindy_mcp_call_tool', {
        server: 'cindy_echo', tool: 'echo', args: {},
      });
    }
    if (toolResultCount === 3) {
      return anthropicToolTurn(4, 'cindy_mcp_call_tool', {
        server: 'cindy_echo', tool: 'echo', args: { text: 'hello-pi' },
      });
    }
    return anthropicTextTurn(5, 'tool said: ECHO[hello-pi]');
  }
  if (toolResultCount === 0) return anthropicToolTurn(1, 'cindy_mcp_list_tools', {});
  if (toolResultCount === 1) {
    return anthropicToolTurn(2, 'cindy_mcp_list_tools', {
      server: 'cindy_echo', tool: 'echo',
    });
  }
  if (toolResultCount === 2) {
    return anthropicToolTurn(3, 'cindy_mcp_call_tool', {
      server: 'cindy_echo', tool: 'echo', args: { text: 'hello-pi' },
    });
  }
  return anthropicTextTurn(4, 'tool said: ECHO[hello-pi]');
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
  const statusCalls: Array<Record<string, never>> = [];
  const sumCalls: Array<{ values: number[] }> = [];
  const configureCalls: Array<{ options: { retries: number; flags: string[] } }> = [];
  const workspaceLookupCalls: Array<{ query: string }> = [];
  const contactsLookupCalls: Array<{ query: string }> = [];
  // 记录假 MCP server 收到的请求 URL —— 断言真 pi(经 cindy-bridge fetch)把
  // host 下发的 `?session=<id>` 原样带到每个 MCP 请求上(orca 身份路由的 pi 侧半)。
  const seenMcpUrls: string[] = [];
  const seenRemoteHeaders: Array<{ authorization?: string; apiKey?: string }> = [];
  const paginatedListCursors: Array<string | undefined> = [];
  const timedOutPaginationCursors: Array<string | undefined> = [];
  const modelRequestBodies: string[] = [];
  const modelRequests: Array<Record<string, unknown>> = [];
  const opaqueTurnCaptures: Array<{ sessionId: string; provider: string; cwd: string }> = [];

  beforeAll(async () => {
    agentHome = mkdtempSync(path.join(tmpdir(), 'pi-mcp-int-'));

    // 假网关:按 user prompt + tool_result 数量脚本化发现、调用、纠错与终答。
    gateway = createServer(async (req, res) => {
      const body = await readBody(req);
      modelRequestBodies.push(body);
      modelRequests.push(JSON.parse(body) as Record<string, unknown>);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(scriptedAnthropicTurn(body));
    });
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    const gAddr = gateway.address();
    if (typeof gAddr === 'object' && gAddr) gatewayUrl = `http://127.0.0.1:${gAddr.port}`;

    // 假 MCP server(streamable-HTTP + bearer + 多路工具),与 codexHttpBridge 同构。
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
      const isWorkspace = req.url?.includes('/workspace') ?? false;
      const isContacts = req.url?.includes('/contacts') ?? false;
      const server = new McpServer({
        name: isWorkspace ? 'cindy_workspace' : isContacts ? 'cindy_contacts' : 'cindy_echo',
        version: '1.0.0',
      });
      if (isWorkspace) {
        server.registerTool(
          'status',
          { description: 'Read the workspace status', inputSchema: {} },
          async (args) => {
            statusCalls.push(args);
            return { content: [{ type: 'text', text: 'READY' }] };
          },
        );
        server.registerTool(
          'sum',
          { description: 'Sum a list of numbers', inputSchema: { values: z.array(z.number()) } },
          async ({ values }) => {
            sumCalls.push({ values });
            return { content: [{ type: 'text', text: `SUM[${values.reduce((total, value) => total + value, 0)}]` }] };
          },
        );
        server.registerTool(
          'configure',
          {
            description: 'Apply nested workspace options',
            inputSchema: {
              options: z.object({ retries: z.number().int(), flags: z.array(z.string()) }),
            },
          },
          async ({ options }) => {
            configureCalls.push({ options });
            return {
              content: [{ type: 'text', text: `CONFIGURED[${options.retries}:${options.flags.join(',')}]` }],
            };
          },
        );
        server.registerTool(
          'lookup',
          { description: 'Look up a workspace resource', inputSchema: { query: z.string() } },
          async ({ query }) => {
            workspaceLookupCalls.push({ query });
            return { content: [{ type: 'text', text: `WORKSPACE[${query}]` }] };
          },
        );
      } else if (isContacts) {
        server.registerTool(
          'lookup',
          { description: 'Look up a contact', inputSchema: { query: z.string() } },
          async ({ query }) => {
            contactsLookupCalls.push({ query });
            return { content: [{ type: 'text', text: `CONTACT[${query}]` }] };
          },
        );
      } else {
        server.registerTool(
          'echo',
          { description: 'Echo text back in uppercase', inputSchema: { text: z.string() } },
          async ({ text }) => {
            echoCalls.push({ text });
            return { content: [{ type: 'text', text: `ECHO[${text}]` }] };
          },
        );
      }
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
    bridgeMode: 'local' | 'local-multi' | 'remote' | 'remote-sse' | 'remote-paginated' | 'remote-failures' = 'local',
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
      turnChangeCapture: {
        beforeKnownFileWrite: async () => {},
        noteOpaqueWrite: (input) => opaqueTurnCaptures.push(input),
      },
      capabilityAdditions: {
        availableModels: [
          { id: 'pi-test-model', displayName: 'Pi Test', contextWindow: 200_000, efforts: [], defaultEffort: null },
        ],
      },
      // 本 fixture 的假网关只实现 Anthropic Messages；协议路由由独立 Responses 集成覆盖。
      resolvePiGatewayModelApi: () => 'anthropic-messages',
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
        if (bridgeMode === 'local-multi') {
          const sessionQuery = ctx?.sessionId
            ? `?session=${encodeURIComponent(ctx.sessionId)}`
            : '';
          return {
            mcpBridge: {
              token: MCP_TOKEN,
              servers: [
                { name: 'cindy_workspace', url: `${mcpUrl}/workspace${sessionQuery}` },
                { name: 'cindy_contacts', url: `${mcpUrl}/contacts${sessionQuery}` },
              ],
            },
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
    bridgeMode: 'local' | 'local-multi' | 'remote' | 'remote-sse' | 'remote-paginated' = 'local',
    prompt = 'call the echo tool',
  ): Promise<{
    events: AgentEvent[];
    permissionAsked: boolean;
    requestBodies: string[];
    requests: Array<Record<string, unknown>>;
  }> {
    const agent = new PiAgent(buildDeps(bridgeMode));
    const cwd = mkdtempSync(path.join(tmpdir(), 'pi-mcp-cwd-'));
    const requestStart = modelRequests.length;
    const requestBodyStart = modelRequestBodies.length;
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
      await handle.send({ type: 'user', content: prompt });
      await done;
      return {
        events,
        permissionAsked,
        requestBodies: modelRequestBodies.slice(requestBodyStart),
        requests: modelRequests.slice(requestStart),
      };
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
      opaqueTurnCaptures.length = 0;
      const { events, permissionAsked, requestBodies, requests } = await runOneTurn('ask', async (req) => {
        expect(req.kind).toBe('permission');
        if (req.kind === 'permission') {
          expect(req.toolName).toBe('mcp__cindy_echo__echo');
          expect(req.input).toEqual({ text: 'hello-pi' });
        }
        return { kind: 'permission', behavior: 'allow' };
      });

      expect(permissionAsked).toBe(true);
      expect(echoCalls.length).toBeGreaterThan(0);
      expect(echoCalls[0]?.text).toBe('hello-pi');
      await waitFor(() => opaqueTurnCaptures.length === 1);
      expect(opaqueTurnCaptures[0]).toMatchObject({
        sessionId: 'mcp-itest-ask',
        provider: 'pi',
      });
      expect(requestBodies[1]).toContain('cindy_echo');
      expect(requestBodies[1]).toContain('Echo text back in uppercase');
      expect(requestBodies[1]).not.toContain('inputSchema');
      expect(requestBodies[2]).toContain('inputSchema');
      expect(requestBodies[2]).toContain('"required"');
      expect(requestBodies[2]).toContain('"text"');

      const firstTools = requests[0]?.tools as Array<{ name?: string }> | undefined;
      const firstToolNames = firstTools?.map((tool) => tool.name) ?? [];
      expect(firstToolNames).toContain('cindy_mcp_list_tools');
      expect(firstToolNames).toContain('cindy_mcp_call_tool');
      expect(firstToolNames).not.toContain('mcp__cindy_echo__echo');
      expect(firstToolNames.filter((name) => name?.startsWith('cindy_mcp_'))).toEqual([
        'cindy_mcp_list_tools',
        'cindy_mcp_call_tool',
      ]);

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
    'executes five real tools across two MCP servers in one Pi workflow without mixing same-name tools',
    { timeout: 90_000 },
    async () => {
      statusCalls.length = 0;
      sumCalls.length = 0;
      configureCalls.length = 0;
      workspaceLookupCalls.length = 0;
      contactsLookupCalls.length = 0;
      seenMcpUrls.length = 0;
      const permissionRequests: Array<{ toolName: string; input: unknown }> = [];

      const { events, requestBodies, requests } = await runOneTurn(
        'ask',
        async (req) => {
          expect(req.kind).toBe('permission');
          if (req.kind === 'permission') {
            permissionRequests.push({ toolName: req.toolName, input: req.input });
          }
          return { kind: 'permission', behavior: 'allow' };
        },
        'local-multi',
        'run the multi command MCP workflow',
      );

      expect(statusCalls).toEqual([{}]);
      expect(sumCalls).toEqual([{ values: [3, 5, 8] }]);
      expect(configureCalls).toEqual([{ options: { retries: 2, flags: ['safe', 'fast'] } }]);
      expect(workspaceLookupCalls).toEqual([{ query: 'release-notes' }]);
      expect(contactsLookupCalls).toEqual([{ query: 'Ada' }]);
      expect(permissionRequests).toEqual([
        { toolName: 'mcp__cindy_workspace__status', input: {} },
        { toolName: 'mcp__cindy_workspace__sum', input: { values: [3, 5, 8] } },
        {
          toolName: 'mcp__cindy_workspace__configure',
          input: { options: { retries: 2, flags: ['safe', 'fast'] } },
        },
        { toolName: 'mcp__cindy_workspace__lookup', input: { query: 'release-notes' } },
        { toolName: 'mcp__cindy_contacts__lookup', input: { query: 'Ada' } },
      ]);

      const startupToolNames = (requests[0]?.tools as Array<{ name?: string }> | undefined)
        ?.map((tool) => tool.name) ?? [];
      expect(startupToolNames.filter((name) => name?.startsWith('cindy_mcp_'))).toEqual([
        'cindy_mcp_list_tools',
        'cindy_mcp_call_tool',
      ]);
      expect(startupToolNames.some((name) => name?.startsWith('mcp__'))).toBe(false);

      const discoveryResult = latestToolResultContent(requests[1] ?? {});
      expect(discoveryResult).toContain('cindy_workspace');
      expect(discoveryResult).toContain('cindy_contacts');
      expect(discoveryResult).not.toContain('inputSchema');
      const inspectedResults = [2, 4, 6, 8, 10].map((index) =>
        JSON.parse(latestToolResultContent(requests[index] ?? {})) as {
          tools?: Array<{ server?: string; name?: string; description?: string; inputSchema?: unknown }>;
        }
      );
      expect(inspectedResults.map((result) => result.tools?.[0])).toMatchObject([
        { server: 'cindy_workspace', name: 'status', inputSchema: { type: 'object', properties: {} } },
        {
          server: 'cindy_workspace',
          name: 'sum',
          inputSchema: {
            type: 'object',
            properties: { values: { type: 'array', items: { type: 'number' } } },
            required: ['values'],
          },
        },
        {
          server: 'cindy_workspace',
          name: 'configure',
          inputSchema: {
            type: 'object',
            properties: {
              options: {
                type: 'object',
                properties: {
                  retries: { type: 'integer' },
                  flags: { type: 'array', items: { type: 'string' } },
                },
                required: ['retries', 'flags'],
              },
            },
            required: ['options'],
          },
        },
        { server: 'cindy_workspace', name: 'lookup', description: 'Look up a workspace resource' },
        { server: 'cindy_contacts', name: 'lookup', description: 'Look up a contact' },
      ]);
      const finalRequestBody = requestBodies.at(-1) ?? '';
      for (const result of [
        'READY',
        'SUM[16]',
        'CONFIGURED[2:safe,fast]',
        'WORKSPACE[release-notes]',
        'CONTACT[Ada]',
      ]) {
        expect(finalRequestBody).toContain(result);
      }
      expect(seenMcpUrls.some((url) => url.includes('/workspace?session=mcp-itest-ask'))).toBe(true);
      expect(seenMcpUrls.some((url) => url.includes('/contacts?session=mcp-itest-ask'))).toBe(true);

      const finalText = events
        .filter((event) => event.type === 'text')
        .map((event) => event.data as { text: string; isFinal?: boolean })
        .filter((data) => data.isFinal)
        .map((data) => data.text)
        .join('');
      expect(finalText).toContain('workflow complete');
      expect(finalText).toContain('CONTACT[Ada]');
    },
  );

  it(
    'invalid MCP args expose the selected schema and let Pi correct the call without losing the capability',
    { timeout: 90_000 },
    async () => {
      echoCalls.length = 0;
      const { events, permissionAsked, requestBodies } = await runOneTurn(
        'bypassPermissions',
        async () => ({ kind: 'permission', behavior: 'deny' }),
        'local',
        'invalid args then correct',
      );

      expect(permissionAsked).toBe(false);
      expect(echoCalls).toEqual([{ text: 'hello-pi' }]);
      expect(requestBodies.some((body) =>
        body.includes('Expected args schema') && body.includes('"required"') && body.includes('"text"')
      )).toBe(true);
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
    'unknown gateway targets fail before MCP execution and do not prompt for a fake wrapper capability',
    { timeout: 90_000 },
    async () => {
      echoCalls.length = 0;
      const { events, permissionAsked, requestBodies } = await runOneTurn(
        'ask',
        async () => ({ kind: 'permission', behavior: 'deny' }),
        'local',
        'unknown gateway tool',
      );

      expect(permissionAsked).toBe(false);
      expect(echoCalls).toHaveLength(0);
      expect(requestBodies.some((body) => body.includes('Unknown Cindy MCP tool'))).toBe(true);
      const finalText = events
        .filter((event) => event.type === 'text')
        .map((event) => event.data as { text: string; isFinal?: boolean })
        .filter((data) => data.isFinal)
        .map((data) => data.text)
        .join('');
      expect(finalText).toContain('unknown tool rejected safely');
    },
  );

  it(
    'known tools cannot execute or prompt until their exact input schema has been inspected',
    { timeout: 90_000 },
    async () => {
      echoCalls.length = 0;
      opaqueTurnCaptures.length = 0;
      let permissionCount = 0;
      const { permissionAsked, requestBodies } = await runOneTurn(
        'ask',
        async (req) => {
          permissionCount += 1;
          expect(req.kind).toBe('permission');
          if (req.kind === 'permission') {
            expect(req.toolName).toBe('mcp__cindy_echo__echo');
            expect(req.input).toEqual({ text: 'hello-pi' });
          }
          return { kind: 'permission', behavior: 'allow' };
        },
        'local',
        'call without schema inspection',
      );

      expect(permissionAsked).toBe(true);
      expect(permissionCount).toBe(1);
      expect(echoCalls).toEqual([{ text: 'hello-pi' }]);
      expect(requestBodies[1]).toContain('Inspect this tool before execution');
      expect(requestBodies[2]).toContain('inputSchema');
      await waitFor(() => opaqueTurnCaptures.length === 1);
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
      const { events, permissionAsked, requestBodies, requests } = await runOneTurn(
        'bypassPermissions',
        async () => ({ kind: 'permission', behavior: 'deny' }),
        'remote-paginated',
      );

      expect(permissionAsked).toBe(false);
      expect(paginatedListCursors).toEqual([undefined, 'page-2', 'page-3']);
      expect(echoCalls).toEqual([{ text: 'hello-pi' }]);
      expect(requestBodies[1]).toContain('page_one');
      expect(requestBodies[1]).toContain('page_two');
      expect(requestBodies[1]).toContain('echo');
      expect(requestBodies[1]).not.toContain('inputSchema');
      expect(requestBodies[2]).toContain('inputSchema');
      const startupToolNames = (requests[0]?.tools as Array<{ name?: string }> | undefined)
        ?.map((tool) => tool.name) ?? [];
      expect(startupToolNames.filter((name) => name?.startsWith('cindy_mcp_'))).toHaveLength(2);
      expect(startupToolNames.some((name) => name?.startsWith('mcp__'))).toBe(false);
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
      const requestBodyStart = modelRequestBodies.length;
      let handle: AgentSessionHandle | null = null;
      try {
        handle = await agent.startSession({
          sessionId: 'mcp-remote-failure-itest',
          workingDir: cwd,
          model: 'pi-test-model',
          permissionMode: 'bypassPermissions',
        });
        const events: AgentEvent[] = [];
        const done = (async () => {
          for await (const event of handle!.events()) {
            events.push(event);
            if (event.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'inspect unavailable MCP' });
        await done;
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
        const requestBodies = modelRequestBodies.slice(requestBodyStart);
        expect(requestBodies.some((body) =>
          body.includes('unavailableServers')
          && body.includes('rejecting_remote')
          && body.includes('slow_remote')
        )).toBe(true);
        expect(events.some((event) =>
          event.type === 'text'
          && (event.data as { text?: string; isFinal?: boolean }).isFinal
          && (event.data as { text?: string }).text?.includes('unavailable servers reported')
        )).toBe(true);
        for (const forbidden of [REMOTE_BEARER, REMOTE_API_KEY, REMOTE_ERROR_CANARY, mcpUrl]) {
          expect(logs).not.toContain(forbidden);
          expect(requestBodies.join('\n')).not.toContain(forbidden);
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
      opaqueTurnCaptures.length = 0;
      const { permissionAsked } = await runOneTurn('ask', async () => ({
        kind: 'permission',
        behavior: 'deny',
        reason: 'test denies',
      }));
      expect(permissionAsked).toBe(true);
      expect(echoCalls.length).toBe(0);
      expect(opaqueTurnCaptures).toHaveLength(0);
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
