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

import { WebSocketServer, type WebSocket } from 'ws';

/** 单个请求体上限(与反向请求载荷上限一致)。 */
export const TUNNEL_MAX_BODY_BYTES = 48 * 1024 * 1024;
const MAX_WS_CONNECTIONS = 16;
/** 单条 WebSocket 消息上限(Codex exec-server 读写大文件时整段 base64 在一条消息里)。 */
const MAX_WS_FRAME_BYTES = 48 * 1024 * 1024;

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
  let nextConn = 0;
  let closed = false;

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
      try {
        const response = await handlers.http({
          method: req.method ?? 'GET',
          path: requestPath,
          headers,
          ...(body.length ? { body } : {}),
        }, abort.signal);
        if (res.destroyed) return;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(response.body);
      } catch (error) {
        if (res.destroyed) return;
        // 错误消息/栈可能携带本机路径等信息，不原样回给隧道对端；按错误类别给固定文案。
        const raw = error instanceof Error ? error.message : String(error);
        const message = /aborted/i.test(raw)
          ? 'The request was cancelled.'
          : 'The task has ended on the computer where it runs.';
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'REMOTE_AGENT_TUNNEL', message } }));
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
      handlers.wsOpen(connId, wsPath ?? '/');
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        handlers.wsMessage(connId, data.toString());
      });
      ws.on('close', () => {
        if (connections.delete(connId)) handlers.wsClose(connId);
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
      if (ws && ws.readyState === ws.OPEN) ws.send(data);
    },
    closeWs(connId) {
      const ws = connections.get(connId);
      if (!ws) return;
      connections.delete(connId);
      ws.close();
    },
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
