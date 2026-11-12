/**
 * claude-cli-proxy-bridge —— 给 Claude Code CLI 用的本机 CONNECT 代理,按目标逐条套用系统代理。
 *
 * Claude 订阅会话由 CLI 直连 Anthropic(见 claude-native-cli)。CLI 只认 HTTPS_PROXY 环境
 * 变量,不读系统代理 / PAC,也不支持 SOCKS;而环境变量对整棵进程树生效 —— 直接把「对
 * api.anthropic.com 解析出的系统代理」写进去,Bash 工具里的 git / npm 访问内网也会被强制
 * 走这个代理,系统的例外列表与 PAC 规则全部丢失。
 *
 * 这里在 127.0.0.1 起一个只接受 CONNECT 的端口,每条隧道按**目标主机**重新解析出口
 * (与本地 proxy 同一个解析器:代理 env 优先,其次系统代理 / PAC):
 *   - 直连 / PAC 例外 → 直接连目标;
 *   - HTTP 代理 → 经上游 CONNECT;
 *   - SOCKS5 代理 → 经 SOCKS5 打隧道。
 * 纯 TCP 转发,TLS 在客户端与目标之间端到端,这里看不到请求内容与凭证。明文 HTTP 请求
 * 一律 405,不做正向代理。只监听回环地址,按需启动,整个进程生命周期复用一个端口。
 */

import http from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';

import { parseOutboundProxyUrl, socks5Connect, type OutboundProxyTarget } from '@cindy/anthropic-compat-proxy';

import { createLogger } from '../logger.js';

const log = createLogger('claude-cli-proxy-bridge');

/** 上游建连(直连 / CONNECT / SOCKS 握手)整体超时。 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000;

/** 按目标 URL 解析出口:返回代理地址(http:// / socks5://),null = 直连。 */
export type ClaudeCliProxyResolver = (
  targetUrl: string,
) => string | null | undefined | Promise<string | null | undefined>;

let server: http.Server | null = null;
let listening: Promise<string> | null = null;
let resolveRoute: ClaudeCliProxyResolver | null = null;
const sockets = new Set<Socket>();

function parseConnectAuthority(authority: string | undefined): { host: string; port: number } | null {
  if (!authority) return null;
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    return null;
  }
  // URL 会把 http 默认端口 80 规范化成空串,空串时从原始 authority 取。
  const port = Number(url.port || /:(\d+)$/.exec(authority)?.[1] || '');
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (url.pathname !== '/' || url.search || url.username || url.password) return null;
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  return { host, port };
}

/** `host:port`,IPv6 字面量加方括号。 */
function formatAuthority(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/** 解析器按 URL 判定出口(PAC / NO_PROXY 都按主机名与端口匹配)。 */
function targetUrlOf(host: string, port: number): string {
  const hostPart = host.includes(':') ? `[${host}]` : host;
  return port === 443 ? `https://${hostPart}/` : `https://${hostPart}:${port}/`;
}

function track(socket: Socket): void {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
}

function connectDirect(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error(`connect ${host}:${port} timed out`)), UPSTREAM_CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', reject);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function connectViaHttpProxy(proxy: OutboundProxyTarget, host: string, port: number): Promise<Socket> {
  const authority = formatAuthority(host, port);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        ...(proxy.authHeader ? { 'proxy-authorization': proxy.authHeader } : {}),
      },
      agent: false,
      timeout: UPSTREAM_CONNECT_TIMEOUT_MS,
    });
    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`outbound proxy ${proxy.url} CONNECT ${authority} failed: HTTP ${res.statusCode}`));
        return;
      }
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    req.once('timeout', () => req.destroy(new Error(`outbound proxy ${proxy.url} CONNECT ${authority} timed out`)));
    req.once('error', reject);
    req.end();
  });
}

async function openUpstream(host: string, port: number): Promise<Socket> {
  const raw = resolveRoute ? await resolveRoute(targetUrlOf(host, port)) : null;
  const proxy = parseOutboundProxyUrl(raw);
  if (!proxy) return connectDirect(host, port);
  if (proxy.kind === 'socks5') return socks5Connect(proxy, host, port);
  return connectViaHttpProxy(proxy, host, port);
}

function handleConnect(req: http.IncomingMessage, client: Socket, head: Buffer): void {
  track(client);
  client.on('error', () => client.destroy());
  const target = parseConnectAuthority(req.url);
  if (!target) {
    client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  openUpstream(target.host, target.port).then(
    (remote) => {
      track(remote);
      if (client.destroyed) {
        remote.destroy();
        return;
      }
      const closeBoth = () => {
        remote.destroy();
        client.destroy();
      };
      remote.on('error', closeBoth);
      client.on('error', closeBoth);
      remote.once('close', () => client.destroy());
      client.once('close', () => remote.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
    },
    (err: unknown) => {
      log.warn('proxy bridge tunnel failed', {
        target: formatAuthority(target.host, target.port),
        message: err instanceof Error ? err.message : String(err),
      });
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    },
  );
}

/**
 * 确保桥已监听,返回可作为 HTTPS_PROXY 的地址(`http://127.0.0.1:<port>`)。
 * resolver 按目标解析出口;之后新建的隧道都用最近一次给的 resolver。
 */
export function ensureClaudeCliProxyBridge(resolver: ClaudeCliProxyResolver): Promise<string> {
  resolveRoute = resolver;
  if (listening) return listening;
  const srv = http.createServer((_req, res) => {
    res.writeHead(405, { 'content-type': 'text/plain', connection: 'close' });
    res.end('CONNECT only\n');
  });
  srv.on('connect', handleConnect);
  srv.on('clientError', (_err, socket) => socket.destroy());
  const pending = new Promise<string>((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      srv.off('error', reject);
      srv.on('error', (err) => log.warn('proxy bridge server error', { message: err.message }));
      const address = srv.address();
      if (!address || typeof address === 'string') {
        reject(new Error('proxy bridge has no port'));
        return;
      }
      srv.unref();
      log.info('proxy bridge listening', { port: address.port });
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  server = srv;
  listening = pending;
  pending.catch((err: unknown) => {
    log.warn('proxy bridge failed to start', { message: err instanceof Error ? err.message : String(err) });
    if (listening === pending) {
      listening = null;
      server = null;
    }
  });
  return pending;
}

/** 关闭桥与所有隧道(app 退出、单测)。 */
export function closeClaudeCliProxyBridge(): Promise<void> {
  const srv = server;
  server = null;
  listening = null;
  resolveRoute = null;
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (!srv) return Promise.resolve();
  return new Promise((resolve) => srv.close(() => resolve()));
}
