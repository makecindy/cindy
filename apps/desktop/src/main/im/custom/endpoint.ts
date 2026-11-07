/**
 * im/custom/endpoint.ts — 自定义渠道的本机端点。
 *
 * 一个 server 服务所有自定义连接, 路径按连接区分:
 *   POST /im/custom/<connectionId>/inbound
 * 每个连接一把独立 token(存在安全存储里), 请求头 Authorization: Bearer token。
 *
 * 不占端口: macOS / Linux 监听 Unix domain socket, Windows 监听 named pipe。
 * 调用方用 curl 的 --unix-socket 指向 socket 文件, 请求体与 token 约定不变。
 * 文件权限 0600 就是访问边界, 没有端口冲突, 也不需要防火墙。
 *
 * 同机发现文件: <userData>/im-custom/endpoint.json(0700/0600), 只含 socket 路径,
 * 不含 token。
 */

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';

import type { CustomInboundMessage } from '@cindy/im';
import { CUSTOM_INBOUND_PATH_PREFIX, CUSTOM_INBOUND_PATH_SUFFIX } from '@cindy/im';

const MAX_BODY_BYTES = 1024 * 1024;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const SERVER_HEADER = 'Cindy-Custom-IM/1.0';

export interface CustomInboundTarget {
  /** 该连接的入站 token(常量时间比较)。 */
  token: string;
  handle(payload: CustomInboundMessage): void;
}

export interface CustomEndpointOptions {
  /** 同机发现文件目录。 */
  discoveryDir: string;
  log: { info(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}

export interface CustomEndpointHandle {
  /** Unix socket 路径或 Windows named pipe 名。 */
  socketPath: string;
  /** 注册/替换某连接的入站目标; 返回该连接给调用方看的 URL。 */
  register(connectionId: string, target: CustomInboundTarget): string;
  unregister(connectionId: string): void;
  shutdown(): Promise<void>;
}

export async function startCustomEndpoint(
  opts: CustomEndpointOptions,
): Promise<CustomEndpointHandle> {
  const targets = new Map<string, CustomInboundTarget>();
  const liveSockets = new Set<import('node:net').Socket>();
  const socketPath = resolveSocketPath(opts.discoveryDir);

  // 上次异常退出可能留下没人监听的 socket 文件; 先探活清理, 否则重启永远报 SOCKET_IN_USE。
  await removeStaleSocket(socketPath);

  const server = http.createServer((req, res) => {
    res.setHeader('Server', SERVER_HEADER);
    void handle(req, res, targets, opts.log).catch((err: unknown) => {
      opts.log.warn('custom im inbound crashed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end();
      }
    });
  });
  server.on('connection', (socket) => {
    liveSockets.add(socket);
    socket.once('close', () => liveSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `CUSTOM_ENDPOINT_SOCKET_IN_USE: ${socketPath} (another Cindy instance is serving it)`,
          ),
        );
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve();
    });
    server.listen(socketPath);
  });

  opts.log.info('custom im endpoint listening', { socketPath });
  // umask 会让 socket 落成 0755; 显式收紧到 0600, 访问边界只剩当前用户。
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      opts.log.warn('custom im socket chmod failed', { socketPath });
    }
  }
  writeDiscovery(opts.discoveryDir, socketPath);

  const register = (connectionId: string, target: CustomInboundTarget): string => {
    targets.set(connectionId, target);
    return urlFor(connectionId);
  };

  return {
    socketPath,
    register,
    unregister: (connectionId) => {
      targets.delete(connectionId);
    },
    shutdown: async () => {
      for (const socket of liveSockets) {
        try {
          socket.destroy();
        } catch {
          /* 尽力而为 */
        }
      }
      liveSockets.clear();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        timer.unref?.();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      // 保留发现文件(socket 路径固定); socket 文件由系统在 close 时清理。
    },
  };
}

/** 给调用方看的地址: Unix socket 用 localhost 主机名(实际请求走 socket 文件)。 */
export function urlFor(connectionId: string): string {
  return `http://localhost${CUSTOM_INBOUND_PATH_PREFIX}${encodeURIComponent(connectionId)}${CUSTOM_INBOUND_PATH_SUFFIX}`;
}

export function resolveSocketPath(dir: string): string {
  if (process.platform === 'win32') {
    const digest = Buffer.from(dir).toString('base64url').slice(-32);
    return `\\\\.\\pipe\\cindy-im-${digest}`;
  }
  // macOS 的 sun_path 只有 104 字节, userData 路径常常超长(EINVAL)。
  // 把 socket 放到短目录, 用目录哈希区分不同账号/沙箱; 发现文件仍写在 userData 里。
  const digest = createHash('sha256').update(dir, 'utf8').digest('hex').slice(0, 16);
  const base = process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.length < 40
    ? process.env.XDG_RUNTIME_DIR
    : '/tmp';
  return path.join(base, `cindy-im-${digest}.sock`);
}

/** 读上次持久化的 socket 路径; 没有/损坏返回 null。 */
export function readPersistedSocketPath(dir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'endpoint.json'), 'utf8')) as {
      socketPath?: unknown;
    };
    return typeof raw.socketPath === 'string' && raw.socketPath ? raw.socketPath : null;
  } catch {
    return null;
  }
}

/**
 * 清掉上次崩溃留下的 socket 文件。Unix socket 上还能连上说明有进程在服务,
 * 这时不删, 交给 listen 报 EADDRINUSE。
 */
export async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    if (!fs.statSync(socketPath).isSocket()) return;
  } catch {
    return;
  }
  const inUse = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    // 用裸 TCP 连接探活: 不向在服务的实例发请求, 也不会因为它提前关闭连接而冒 EPIPE。
    const probe = net.createConnection({ path: socketPath });
    probe.once('connect', () => {
      probe.destroy();
      finish(true);
    });
    probe.once('error', () => finish(false));
    probe.setTimeout(500, () => {
      probe.destroy();
      finish(true);
    });
  });
  if (!inUse) fs.rmSync(socketPath, { force: true });
}

function parseConnectionId(pathname: string): string | null {
  if (!pathname.startsWith(CUSTOM_INBOUND_PATH_PREFIX)) return null;
  if (!pathname.endsWith(CUSTOM_INBOUND_PATH_SUFFIX)) return null;
  const raw = pathname.slice(CUSTOM_INBOUND_PATH_PREFIX.length, -CUSTOM_INBOUND_PATH_SUFFIX.length);
  if (!raw || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targets: Map<string, CustomInboundTarget>,
  log: CustomEndpointOptions['log'],
): Promise<void> {
  // UDS / named pipe 没有 remoteAddress; 访问边界是 socket 文件权限(0600) + token。
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const connectionId = parseConnectionId(url.pathname);
  if (!connectionId) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const target = targets.get(connectionId);
  if (!target) {
    res.statusCode = 404;
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  const auth = req.headers.authorization;
  const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!tokenMatches(presented, target.token)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.statusCode = 401;
    res.end();
    log.warn('custom im inbound unauthorized', { connectionId });
    return;
  }

  const body = await readBody(req);
  if (body === null) {
    res.statusCode = 413;
    res.end();
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    res.end();
    return;
  }
  const message = normalizeInbound(parsed);
  if (!message) {
    res.statusCode = 400;
    res.end();
    return;
  }
  target.handle(message);
  res.statusCode = 202;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end('{"ok":true}');
}

export function normalizeInbound(raw: unknown): CustomInboundMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const conversationId = typeof r.conversationId === 'string' ? r.conversationId.trim() : '';
  const text = typeof r.text === 'string' ? r.text : '';
  if (!conversationId || conversationId.length > 200 || !text.trim()) return null;
  if (text.length > 32_000) return null;
  const attachments: CustomInboundMessage['attachments'] = [];
  if (Array.isArray(r.attachments)) {
    for (const item of r.attachments) {
      if (!item || typeof item !== 'object') continue;
      const a = item as Record<string, unknown>;
      if (typeof a.absPath !== 'string' || !path.isAbsolute(a.absPath)) continue;
      attachments.push({
        absPath: a.absPath,
        ...(typeof a.name === 'string' ? { name: a.name } : {}),
        ...(typeof a.mimeType === 'string' ? { mimeType: a.mimeType } : {}),
      });
    }
  }
  return {
    conversationId,
    text,
    ...(typeof r.callbackUrl === 'string' && /^https?:\/\//i.test(r.callbackUrl)
      ? { callbackUrl: r.callbackUrl }
      : {}),
    ...(typeof r.userId === 'string' && r.userId.trim() ? { userId: r.userId.trim() } : {}),
    ...(typeof r.userName === 'string' && r.userName.trim() ? { userName: r.userName.trim() } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

async function readBody(req: http.IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      chunks.length = 0;
      continue;
    }
    chunks.push(buf);
  }
  return total > MAX_BODY_BYTES ? null : Buffer.concat(chunks).toString('utf8');
}

function tokenMatches(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function writeDiscovery(dir: string, socketPath: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'endpoint.json');
  const tmp = path.join(dir, `endpoint.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ socketPath, protocol: 'cindy-custom-im/1' }, null, 2), {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return file;
}
