/**
 * partner-bridge/server.ts
 * ---------------------------------------------------------------------------
 * 本机回环 HTTP 入口:外部系统(自研服务、微信自动化脚本)用 curl 就能派一单
 * 给 Cindy 伙伴,并取回结果。
 *
 *    POST /v1/tasks          { key, prompt, callbackUrl?, workingDir?, permissionMode? }
 *    GET  /v1/tasks/:id      查状态与结果
 *    POST /v1/tasks/:id/cancel
 *    GET  /v1/health
 *
 * 安全边界(三层,每一层都不依赖调用方自觉):
 *   1. 只 bind 127.0.0.1,端口交给内核分配;请求再校验 remoteAddress 是回环;
 *   2. bearer token,常量时间比较;token 只落在 0600 的端点文件里(见 ./endpointFile.ts);
 *   3. body 大小硬上限,超限直接 413,不缓冲。
 *
 * 与 mcp-integrations/codexHttpBridge.ts 同一套服务形态(同进程生命周期、
 * before-quit 收连接),差别只在协议:那边是 MCP streamable-HTTP,这边是
 * 一张任务单的 REST 面。
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { timingSafeEqual } from 'node:crypto';

import type { PartnerTaskService } from './taskService.js';
import type { PartnerTurnRequest } from './types.js';

const SERVER_HEADER = 'Cindy-Partner-Bridge/1.0';
/** 请求体上限:单条指令 32k 字符 + 回调地址等字段,1 MiB 富余且不缓冲大 body。 */
const MAX_BODY_BYTES = 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 5_000;

export interface PartnerBridgeServerOptions {
  service: PartnerTaskService;
  token: string;
  log: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface PartnerBridgeServer {
  port: number;
  url(pathname: string): string;
  shutdown(): Promise<void>;
}

export async function startPartnerBridgeServer(
  opts: PartnerBridgeServerOptions,
): Promise<PartnerBridgeServer> {
  const liveSockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    res.setHeader('Server', SERVER_HEADER);
    void handleRequest(req, res, opts).catch((err: unknown) => {
      opts.log.warn('partner bridge request crashed', {
        url: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'INTERNAL', message: '内部错误' }));
      } else {
        res.end();
      }
    });
  });

  server.on('connection', (socket) => {
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve();
    });
    // 0 = 内核原子分配空闲端口;绑定前不会接受任何外部连接。
    server.listen(0, '127.0.0.1');
  });

  server.on('error', (err) => {
    opts.log.warn('partner bridge listener error', { message: err.message });
  });

  const port = (server.address() as AddressInfo).port;
  opts.log.info('partner bridge listening', { port });

  return {
    port,
    url: (pathname) => `http://127.0.0.1:${port}${pathname}`,
    shutdown: async () => {
      for (const socket of liveSockets) {
        try {
          socket.destroy();
        } catch {
          /* 关连接是尽力而为 */
        }
      }
      liveSockets.clear();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      opts.log.info('partner bridge stopped');
    },
  };
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: PartnerBridgeServerOptions,
): Promise<void> {
  if (!isLoopback(req.socket.remoteAddress ?? '')) {
    sendJson(res, 403, { error: 'FORBIDDEN', message: '只接受本机回环请求' });
    return;
  }
  if (!isAuthorized(req.headers.authorization, opts.token)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    sendJson(res, 401, { error: 'UNAUTHORIZED', message: '缺少或错误的 bearer token' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/v1/health') {
    sendJson(res, 200, { ok: true, version: 1, running: opts.service.runningCount() });
    return;
  }

  if (pathname === '/v1/tasks') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: '只支持 POST' });
      return;
    }
    const body = await readJsonBody(req, res);
    if (body === null) return;
    const outcome = await opts.service.submit(toTurnRequest(body));
    if (!outcome.ok) {
      const status = outcome.errorCode === 'BUSY' ? 409 : 400;
      sendJson(res, status, { error: outcome.errorCode, message: outcome.message });
      return;
    }
    sendJson(res, 202, taskView(outcome.task));
    return;
  }

  const taskMatch = /^\/v1\/tasks\/([^/]+)(\/cancel)?$/.exec(pathname);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1]);
    const isCancel = taskMatch[2] !== undefined;
    if (isCancel) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: '只支持 POST' });
        return;
      }
      const outcome = await opts.service.cancel(taskId);
      if (!outcome.ok) {
        sendJson(res, outcome.errorCode === 'NOT_FOUND' ? 404 : 409, {
          error: outcome.errorCode,
          message: outcome.message,
        });
        return;
      }
      sendJson(res, 200, taskView(outcome.task));
      return;
    }
    if (method !== 'GET') {
      sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', message: '只支持 GET' });
      return;
    }
    const task = opts.service.get(taskId);
    if (!task) {
      sendJson(res, 404, { error: 'NOT_FOUND', message: '没有这个任务' });
      return;
    }
    sendJson(res, 200, taskView(task));
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND', message: '没有这个接口' });
}

function toTurnRequest(body: Record<string, unknown>): PartnerTurnRequest {
  return {
    key: typeof body.key === 'string' ? body.key : '',
    prompt: typeof body.prompt === 'string' ? body.prompt : '',
    ...(typeof body.callbackUrl === 'string' ? { callbackUrl: body.callbackUrl } : {}),
    ...(typeof body.workingDir === 'string' ? { workingDir: body.workingDir } : {}),
    ...(typeof body.permissionMode === 'string' ? { permissionMode: body.permissionMode } : {}),
    ...(typeof body.agentKind === 'string' ? { agentKind: body.agentKind } : {}),
  } as PartnerTurnRequest;
}

function taskView(task: {
  taskId: string;
  key: string;
  sessionId: string | null;
  status: string;
  text: string | null;
  attachments: unknown;
  errorCode: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}): Record<string, unknown> {
  return {
    taskId: task.taskId,
    key: task.key,
    sessionId: task.sessionId,
    status: task.status,
    text: task.text,
    attachments: task.attachments,
    errorCode: task.errorCode,
    error: task.error,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
  };
}

function isAuthorized(header: string | undefined, token: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

function isLoopback(remote: string): boolean {
  return (
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1' ||
    remote.startsWith('127.')
  );
}

/** 读 JSON body;超限回 413、解析失败回 400,两种都自己写响应并返回 null。 */
async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > MAX_BODY_BYTES) {
        sendJson(res, 413, { error: 'PAYLOAD_TOO_LARGE', message: '请求体过大' });
        return null;
      }
      chunks.push(buf);
    }
  } catch {
    sendJson(res, 400, { error: 'BAD_REQUEST', message: '读取请求体失败' });
    return null;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    sendJson(res, 400, { error: 'BAD_REQUEST', message: '请求体不能为空' });
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { error: 'BAD_REQUEST', message: '请求体必须是 JSON 对象' });
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: 'BAD_REQUEST', message: '请求体不是合法 JSON' });
    return null;
  }
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}
