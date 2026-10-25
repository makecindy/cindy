/**
 * 远程 Agent 的本机隧道(被控端)：一个任务一个，只监听 127.0.0.1。
 *
 * 本机 Agent 访问 Cindy 工具(MCP)、执行器(Pi 的文件与命令后端)和 Codex exec-server 时连到这里；
 * 每个 HTTP 请求变成一条反向请求进入事件流，等控制端处理后回包；WebSocket 连接的帧同样经事件流
 * 送到控制端，控制端的帧经 push 送回。loopback 不是鉴权边界：每个请求都要带本任务随机生成的令牌。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

import type { DeviceHostedLinkActivity } from '@cindy/maker-core';
import { WebSocketServer, type WebSocket } from 'ws';

import { TunnelLinkActivity } from './linkActivity.js';

/** 单个请求体上限(与反向请求载荷上限一致)。 */
export const TUNNEL_MAX_BODY_BYTES = 48 * 1024 * 1024;
const MAX_WS_CONNECTIONS = 16;
/** 单条 WebSocket 消息上限(Codex exec-server 读写大文件时整段 base64 在一条消息里)。 */
const MAX_WS_FRAME_BYTES = 48 * 1024 * 1024;
const MCP_KEEPALIVE_MS = 15_000;

/** 只识别本机执行器的单次工具调用及标准取消通知，不接管其他 MCP 服务。 */
function execMcpMessage(req: IncomingMessage, requestPath: string, body: Buffer): { kind: 'call' | 'cancel'; id: string | number } | undefined {
  if (req.method !== 'POST' || requestPath.split('?')[0] !== '/mcp/cindy_exec') return undefined;
  try {
    const message = JSON.parse(body.toString('utf8'));
    if (message?.jsonrpc !== '2.0') return undefined;
    if (message.method === 'tools/call' && (typeof message.id === 'string' || typeof message.id === 'number')) {
      return { kind: 'call', id: message.id };
    }
    const cancelledId = message.params?.requestId;
    if (message.id === undefined && message.method === 'notifications/cancelled'
      && (typeof cancelledId === 'string' || typeof cancelledId === 'number')) return { kind: 'cancel', id: cancelledId };
  } catch { /* 非法请求交回原路由处理。 */ }
  return undefined;
}

export interface TunnelHttpRequest {
  method: string;
  path: string;
  headers: Array<[string, string]>;
  body?: Buffer;
}

export interface TunnelHttpResponse {
  status: number;
  headers: Array<[string, string]>;
  body?: Buffer;
}

export interface TunnelHandlers {
  http(request: TunnelHttpRequest, signal: AbortSignal): Promise<TunnelHttpResponse>;
  wsOpen(connId: string, path: string): void;
  wsMessage(connId: string, data: string): void;
  wsClose(connId: string): void;
}

export interface RunTunnel {
  url: string;
  token: string;
  sendWs(connId: string, data: string): void;
  closeWs(connId: string): void;
  /** 这条隧道上的往来记录(见 linkActivity.ts)。 */
  linkActivity(): DeviceHostedLinkActivity;
  close(): Promise<void>;
}

/** 转发给控制端的请求头(其余如鉴权、Cookie、hop-by-hop 头不出本机)。 */
const FORWARDED_HEADERS = new Set([
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]);

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? '');
  return !!match && sameToken(match[1], token);
}

/**
 * 鉴权：请求头 `Authorization: Bearer <令牌>`，或路径前缀 `/t/<令牌>/`(给只能配置固定地址、
 * 自带另一份请求头的客户端，如 Codex 的 MCP 配置)。返回去掉前缀后的路径；未通过返回 null。
 */
function authorizedPath(url: string | undefined, header: string | undefined, token: string): string | null {
  const target = url ?? '/';
  const prefix = /^\/t\/([^/?#]+)(\/.*)$/.exec(target);
  if (prefix) {
    let given: string;
    try {
      given = decodeURIComponent(prefix[1]);
    } catch {
      return null;
    }
    return sameToken(given, token) ? prefix[2] : null;
  }
  return tokenMatches(header, token) ? target : null;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > TUNNEL_MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function createRunTunnel(handlers: TunnelHandlers): Promise<RunTunnel> {
  const token = randomBytes(32).toString('base64url');
  const sockets = new Set<Socket>();
  const connections = new Map<string, WebSocket>();
  // 每个 run 独立；保留 MCP session 和 JSON-RPC id 的类型，不能取消其它并行调用。
  const pendingExecCalls = new Map<string, () => void>();
  let nextConn = 0;
  let closed = false;
  const activity = new TunnelLinkActivity();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestPath = authorizedPath(req.url, req.headers.authorization, token);
      if (requestPath === null) {
        res.writeHead(401).end();
        req.resume();
        return;
      }
      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        if (!res.headersSent) res.writeHead(413).end();
        return;
      }
      const headers: Array<[string, string]> = [];
      for (const [name, value] of Object.entries(req.headers)) {
        if (!FORWARDED_HEADERS.has(name) || value === undefined) continue;
        headers.push([name, Array.isArray(value) ? value.join(', ') : value]);
      }
      const execMessage = execMcpMessage(req, requestPath, body);
      const callKey = execMessage ? JSON.stringify([req.headers['mcp-session-id'] ?? null, execMessage.id]) : undefined;
      if (execMessage?.kind === 'cancel') {
        // SDK 总超时/单次取消只发通知，不关闭 transport。复用原反向请求的取消信号，
        // 不新增跨端字段，也不关闭共享连接或重放工具操作。
        const cancelPendingCall = pendingExecCalls.get(callKey!);
        if (typeof cancelPendingCall === 'function') cancelPendingCall();
        res.writeHead(202).end();
        return;
      }
      if (callKey !== undefined && pendingExecCalls.has(callKey)) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', id: execMessage!.id, error: { code: -32600, message: 'Request ID is already in use.' },
        }));
        return;
      }
      const streamId = execMessage?.kind === 'call'
        && req.headers.accept?.split(',').some((part) => part.trim().split(';')[0] === 'text/event-stream')
        ? execMessage.id : undefined;
      let keepalive: ReturnType<typeof setInterval> | undefined;
      const streamMessage = (value: unknown) => res.end(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
      const streamError = () => streamMessage({
        jsonrpc: '2.0', id: streamId,
        error: { code: -32603, message: 'The tool request could not be completed.' },
      });
      if (streamId !== undefined) {
        // Claude Code 的 MCP fetch 在首份 HTTP 响应前默认只等 60s。及时建立标准 SSE 响应，
        // 让等待用户确认与命令执行留在工具调用生命周期内，不改变工具执行超时，也不重放请求。
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': waiting\n\n');
        keepalive = setInterval(() => {
          if (!res.destroyed && !res.writableNeedDrain) res.write(': waiting\n\n');
        }, MCP_KEEPALIVE_MS);
        keepalive.unref();
      }
      const release = () => {
        clearInterval(keepalive);
        if (callKey !== undefined && pendingExecCalls.get(callKey) === cancel) pendingExecCalls.delete(callKey);
      };
      const cancel = () => {
        abort.abort();
        release();
        if (res.destroyed || res.writableEnded) return;
        const cancelled = { jsonrpc: '2.0', id: execMessage!.id, error: { code: -32800, message: 'Request cancelled.' } };
        if (streamId !== undefined) streamMessage(cancelled);
        else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cancelled));
      };
      if (callKey !== undefined) pendingExecCalls.set(callKey, cancel);
      res.once('close', release);
      activity.httpStarted();
      try {
        const response = await handlers.http({
          method: req.method ?? 'GET',
          path: requestPath,
          headers,
          ...(body.length ? { body } : {}),
        }, abort.signal);
        if (res.destroyed || res.writableEnded) return;
        if (streamId !== undefined) {
          if (response.status !== 200 || !response.body) streamError();
          else {
            try { streamMessage(JSON.parse(response.body.toString('utf8'))); }
            catch { streamError(); }
          }
          return;
        }
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(response.body);
      } catch (error) {
        if (res.destroyed || res.writableEnded) return;
        if (streamId !== undefined) {
          streamError();
          return;
        }
        // 错误消息/栈可能携带本机路径等信息，不原样回给隧道对端；按错误类别给固定文案。
        const raw = error instanceof Error ? error.message : String(error);
        const message = /aborted/i.test(raw)
          ? 'The request was cancelled.'
          : 'The task has ended on the computer where it runs.';
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'REMOTE_AGENT_TUNNEL', message } }));
      } finally {
        release();
        activity.httpFinished();
      }
    })();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_FRAME_BYTES });
  server.on('upgrade', (req, socket, head) => {
    const wsPath = authorizedPath(req.url, req.headers.authorization, token);
    if (closed || wsPath === null || connections.size >= MAX_WS_CONNECTIONS) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      nextConn += 1;
      const connId = `c${nextConn}`;
      connections.set(connId, ws);
      activity.connection(connId, false);
      handlers.wsOpen(connId, wsPath ?? '/');
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const text = data.toString();
        activity.agentMessage(connId, text);
        handlers.wsMessage(connId, text);
      });
      ws.on('close', () => {
        if (!connections.delete(connId)) return;
        activity.connection(connId, true);
        handlers.wsClose(connId);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    sendWs(connId, data) {
      const ws = connections.get(connId);
      if (!ws || ws.readyState !== ws.OPEN) return;
      activity.environmentMessage(connId, data);
      ws.send(data);
    },
    closeWs(connId) {
      const ws = connections.get(connId);
      if (!ws) return;
      connections.delete(connId);
      activity.connection(connId, true);
      ws.close();
    },
    linkActivity: () => activity.snapshot(),
    async close() {
      if (closed) return;
      closed = true;
      for (const ws of connections.values()) ws.terminate();
      connections.clear();
      wss.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
