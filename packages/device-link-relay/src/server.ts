/**
 * 中转服务入口:一个 HTTP(S) 服务同时承载
 * - `/api/device-link/ws`:设备 WebSocket(握手时校验 `CindyRelay` 凭证);
 * - `/api/device-link/*`:与官方 relay 同形的 REST(设备、媒体);
 * - `/api/device-link/relay/*`:自建中转独有的加入与管理接口、媒体签名地址。
 *
 * Cindy 内运行与服务器上独立运行用的都是这一个入口。证书:传入 `tls` 时直接提供 HTTPS;
 * 不传时只提供 HTTP,用于本机自连、测试,以及由前置代理(nginx / frp / Tailscale serve 等)负责 TLS 的场景。
 */
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import path from 'node:path';
import { PROTOCOL_VERSION, WS_MAX_PAYLOAD_BYTES } from '@cindy/device-link-protocol';
import { WebSocketServer } from 'ws';
import { parseRelayAuthorization } from './credentials';
import { RelayError } from './errors';
import { CLOSE_DEVICE_REMOVED, DEFAULT_HUB_LIMITS, Hub, type HubLimits } from './hub';
import { silentLogger, type RelayLogger } from './logger';
import { BLOB_PATH_PREFIX, DEFAULT_MEDIA_LIMITS, MediaStore, type MediaLimits } from './media';
import { Pairing } from './pairing';
import { normalizeName, RelayStore, type StoredDevice } from './store';
import { RELAY_VERSION } from './version';

const API_PREFIX = '/api/device-link';
const WS_PATH = `${API_PREFIX}/ws`;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_POLL_WAIT_MS = 25_000;
const POLL_TOKEN_HEADER = 'x-cindy-relay-poll-token';

export interface RelayServerOptions {
  /** 中转数据目录,须先用 `initializeRelay` 初始化。 */
  dataDir: string;
  /** 监听地址,默认只监听本机 `127.0.0.1`。 */
  host?: string;
  /** 监听端口,默认 0(随机)。 */
  port?: number;
  /** PEM 证书与私钥;提供时直接以 HTTPS/WSS 服务。 */
  tls?: { cert: string | Buffer; key: string | Buffer };
  /** 其他设备访问中转用的地址(如 https://1.2.3.4),用于生成媒体签名地址;不填时按请求推断。 */
  publicUrl?: string;
  /** 中转在前置代理之后时,按 X-Forwarded-Proto / X-Forwarded-Host 推断外部地址。默认 false。 */
  trustProxyHeaders?: boolean;
  media?: Partial<MediaLimits>;
  hub?: Partial<HubLimits>;
  now?: () => number;
  logger?: RelayLogger;
  /** 媒体过期清理间隔,默认 10 分钟。 */
  sweepIntervalMs?: number;
  /** 当前证书到期时间(自动证书时由证书管理提供),主人在状态接口里看到。 */
  certificateExpiresAt?: () => string | null;
}

export interface RelayServerHandle {
  readonly relayId: string;
  /** 本机可直接访问的基础地址(按监听地址生成),如 http://127.0.0.1:47820 */
  readonly localUrl: string;
  readonly port: number;
  /** 换上续期后的证书,已建立的连接不受影响(仅 HTTPS)。 */
  updateTls(tls: { cert: string | Buffer; key: string | Buffer }): void;
  /**
   * 关闭中转。`retire: true` 表示主人停用了中转:用 4410 断开所有设备,客户端不再重连、
   * 提示「中转已停用」;缺省为暂时关闭(1001),设备按退避重连,中转回来后自动恢复。
   */
  close(options?: { retire?: boolean }): Promise<void>;
}

type Route = (ctx: RequestContext) => Promise<void>;

interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(text)),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BODY_BYTES) throw new RelayError('PAYLOAD_TOO_LARGE', 'request body is too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new RelayError('BAD_REQUEST', 'request body must be a JSON object');
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const HOST_PATTERN = /^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/;

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServerHandle> {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? silentLogger;
  const host = options.host ?? '127.0.0.1';
  const store = await RelayStore.open(options.dataDir, (error) => {
    logger.error('failed to save relay state', { reason: error instanceof Error ? error.name : 'unknown' });
  });
  const media = new MediaStore(
    path.join(options.dataDir, 'media'),
    store.mediaSigningKey,
    { ...DEFAULT_MEDIA_LIMITS, ...options.media },
    now,
  );
  await media.init();
  const hub = new Hub(store, store.ownerUserId, now, logger, { ...DEFAULT_HUB_LIMITS, ...options.hub });
  const pairing = new Pairing(store, now, (device) => {
    logger.info('device admitted', { platform: device.platform ?? 'unknown' });
    hub.announce(device);
  });
  const publicUrl = options.publicUrl?.replace(/\/+$/, '');

  function externalBase(req: IncomingMessage): string {
    if (publicUrl) return publicUrl;
    const forwardedProto = options.trustProxyHeaders ? headerValue(req.headers['x-forwarded-proto']) : undefined;
    const forwardedHost = options.trustProxyHeaders ? headerValue(req.headers['x-forwarded-host']) : undefined;
    const proto = options.tls ? 'https' : forwardedProto === 'https' ? 'https' : 'http';
    const hostHeader = forwardedHost ?? headerValue(req.headers.host);
    const safeHost = hostHeader && HOST_PATTERN.test(hostHeader) ? hostHeader : `${host}:${boundPort}`;
    return `${proto}://${safeHost}`;
  }

  function authenticate(req: IncomingMessage): StoredDevice {
    const credential = parseRelayAuthorization(req.headers.authorization);
    const device = credential ? store.findByCredential(credential) : undefined;
    if (!device) throw new RelayError('RELAY_CREDENTIAL_INVALID', 'missing or invalid relay credential');
    return device;
  }

  function requireOwner(req: IncomingMessage): StoredDevice {
    const device = authenticate(req);
    if (device.role !== 'owner') throw new RelayError('FORBIDDEN', 'only the owner device can manage this relay');
    return device;
  }

  const routes: Array<{ method: string; pattern: RegExp; handler: Route }> = [];
  const route = (method: string, pattern: RegExp, handler: Route) => routes.push({ method, pattern, handler });

  // ── 公开:加入前探测与加入申请 ────────────────────────────────────────────
  route('GET', /^\/api\/device-link\/relay\/info$/, async ({ res }) => {
    sendJson(res, 200, {
      relayId: store.relayId,
      name: store.relayName,
      protocolVersion: PROTOCOL_VERSION,
      relayVersion: RELAY_VERSION,
      features: ['pairing-v1', 'device-signatures-v1'],
      // 仅供展示与主人核对;加入的设备只信任加入链接里的主人公钥。
      ownerPublicKey: store.ownerPublicKey,
    });
  });
  route('POST', /^\/api\/device-link\/relay\/pair$/, async ({ req, res }) => {
    const body = await readJson(req);
    sendJson(res, 200, pairing.submit(body, req.socket.remoteAddress ?? 'unknown'));
  });
  route('GET', /^\/api\/device-link\/relay\/pair\/([0-9a-f-]{36})$/, async ({ req, res, url, params }) => {
    const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) * 1000, 0), MAX_POLL_WAIT_MS);
    const result = await pairing.poll(params[0], headerValue(req.headers[POLL_TOKEN_HEADER]), Number.isFinite(wait) ? wait : 0);
    sendJson(res, 200, result);
  });

  // ── 设备(与官方 relay 同形)─────────────────────────────────────────────
  route('GET', /^\/api\/device-link\/devices$/, async ({ req, res }) => {
    const self = authenticate(req);
    sendJson(res, 200, { devices: store.list().map((device) => hub.deviceView(device, self.deviceId)) });
  });
  route('PATCH', /^\/api\/device-link\/devices\/([^/]+)$/, async ({ req, res, params }) => {
    authenticate(req);
    const body = await readJson(req);
    const deviceId = decodeURIComponent(params[0]);
    if (!store.get(deviceId)) throw new RelayError('NOT_FOUND', 'device not found');
    let customName: string | null = null;
    if (body.name !== null) {
      customName = normalizeName(body.name);
      if (!customName) throw new RelayError('BAD_REQUEST', 'invalid device name');
    }
    const device = store.update(deviceId, { customName })!;
    hub.announce(device);
    sendJson(res, 200, { deviceId, name: device.customName ?? device.reportedName });
  });
  route('DELETE', /^\/api\/device-link\/devices\/([^/]+)$/, async ({ req, res, params }) => {
    const self = authenticate(req);
    const deviceId = decodeURIComponent(params[0]);
    const target = store.get(deviceId);
    if (!target) throw new RelayError('NOT_FOUND', 'device not found');
    if (target.role === 'owner') throw new RelayError('FORBIDDEN', 'the owner device cannot be removed');
    // 主人可以移除任何成员;成员只能让自己退出。
    if (self.role !== 'owner' && self.deviceId !== deviceId) {
      throw new RelayError('FORBIDDEN', 'only the owner device can remove other devices');
    }
    store.remove(deviceId);
    hub.disconnectDevice(target, CLOSE_DEVICE_REMOVED, 'device removed');
    logger.info('device removed', { bySelf: self.deviceId === deviceId });
    sendJson(res, 200, { deviceId, deleted: true });
  });

  // 设备证书:每台设备据此核对其他设备发来的消息(证书由主人签名,中转只负责保存与转交)。
  route('GET', /^\/api\/device-link\/relay\/certs$/, async ({ req, res }) => {
    authenticate(req);
    sendJson(res, 200, { ownerPublicKey: store.ownerPublicKey, certs: store.certificates() });
  });

  // ── 媒体 ─────────────────────────────────────────────────────────────────
  route('POST', /^\/api\/device-link\/media\/presign-put$/, async ({ req, res }) => {
    authenticate(req);
    sendJson(res, 200, media.presignPut(await readJson(req), externalBase(req)));
  });
  route('POST', /^\/api\/device-link\/media\/presign-get$/, async ({ req, res }) => {
    authenticate(req);
    const body = await readJson(req);
    sendJson(res, 200, await media.presignGet(body.key, externalBase(req)));
  });
  route('DELETE', /^\/api\/device-link\/media$/, async ({ req, res }) => {
    authenticate(req);
    const body = await readJson(req);
    await media.delete(body.key);
    sendJson(res, 200, { deleted: true });
  });

  // ── 自建中转不提供的官方能力:给出客户端能平稳处理的响应 ─────────────────
  // ICE:404 让远程桌面按现有逻辑退回公共 STUN。
  route('GET', /^\/api\/device-link\/ice-servers$/, async ({ req }) => {
    authenticate(req);
    throw new RelayError('NOT_FOUND', 'no ICE configuration on a self-hosted relay');
  });
  // 手机推送:推送凭据绑定官方 App,自建中转不保存 token,也不声明 notify 能力。
  route('PUT', /^\/api\/device-link\/push-token$/, async ({ req, res }) => {
    authenticate(req);
    sendEmpty(res, 204);
  });
  route('DELETE', /^\/api\/device-link\/push-token$/, async ({ req, res }) => {
    authenticate(req);
    sendEmpty(res, 204);
  });
  // 供应商分享跨账号,自建中转上始终为空。
  route('GET', /^\/api\/device-link\/provider-shares$/, async ({ req, res }) => {
    authenticate(req);
    sendJson(res, 200, { shares: [] });
  });

  // ── 管理(仅主人电脑)─────────────────────────────────────────────────────
  route('POST', /^\/api\/device-link\/relay\/admin\/join-codes$/, async ({ req, res }) => {
    requireOwner(req);
    sendJson(res, 200, pairing.createJoinCode());
  });
  route('GET', /^\/api\/device-link\/relay\/admin\/pair-requests$/, async ({ req, res }) => {
    requireOwner(req);
    sendJson(res, 200, { requests: pairing.listPending() });
  });
  route('POST', /^\/api\/device-link\/relay\/admin\/pair-requests\/([0-9a-f-]{36})\/(approve|reject)$/, async ({ req, res, params }) => {
    requireOwner(req);
    const approve = params[1] === 'approve';
    const body = approve ? await readJson(req) : {};
    pairing.decide(params[0], approve, body.cert);
    sendJson(res, 200, { requestId: params[0], status: params[1] === 'approve' ? 'approved' : 'rejected' });
  });
  route('GET', /^\/api\/device-link\/relay\/admin\/status$/, async ({ req, res }) => {
    requireOwner(req);
    sendJson(res, 200, {
      relayId: store.relayId,
      name: store.relayName,
      relayVersion: RELAY_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      devices: store.list().length,
      online: hub.onlineCount,
      media: media.stats,
      tls: options.tls ? 'certificate' : 'none',
      certificateExpiresAt: options.certificateExpiresAt?.() ?? null,
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://relay.invalid');
    } catch {
      res.setHeader('Connection', 'close');
      sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'invalid request target' } });
      return;
    }
    try {
      if (url.pathname.startsWith(BLOB_PATH_PREFIX)) {
        await media.handleBlobRequest(req, res, url);
        return;
      }
      if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw new RelayError('NOT_FOUND', 'not found');
      for (const entry of routes) {
        const match = entry.pattern.exec(url.pathname);
        if (!match) continue;
        if (entry.method !== req.method) continue;
        await entry.handler({ req, res, url, params: match.slice(1) });
        return;
      }
      const pathExists = routes.some((entry) => entry.pattern.test(url.pathname));
      throw pathExists ? new RelayError('BAD_REQUEST', 'method not allowed') : new RelayError('NOT_FOUND', 'not found');
    } catch (error) {
      const relayError =
        error instanceof RelayError ? error : new RelayError('INTERNAL', 'internal relay error');
      if (!(error instanceof RelayError)) logger.error('request failed', { path: url.pathname.split('/').slice(0, 4).join('/') });
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // 上传被拒时请求体可能还没读完;回完错误后关闭连接,不在拒绝的上传上继续读数据。
      if (req.method === 'PUT' && !req.complete) res.setHeader('Connection', 'close');
      sendJson(res, relayError.status, { error: { code: relayError.code, message: relayError.message } });
    }
  }

  const server: Server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, (req, res) => void handleRequest(req, res))
    : createHttpServer((req, res) => void handleRequest(req, res));
  // 长轮询最长 25 秒;大文件上传不能被整体请求超时打断,只限制请求头。
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on('error', () => undefined);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://relay.invalid');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const credential = parseRelayAuthorization(req.headers.authorization);
    const device = credential ? store.findByCredential(credential) : undefined;
    if (url.pathname !== WS_PATH || !device) {
      const status = url.pathname !== WS_PATH ? '404 Not Found' : '401 Unauthorized';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, device));
  });

  let boundPort = 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  boundPort = (server.address() as AddressInfo).port;

  const sweepTimer = setInterval(() => {
    void media.sweep().catch(() => logger.warn('media sweep failed'));
  }, options.sweepIntervalMs ?? 10 * 60 * 1000);
  sweepTimer.unref?.();

  const scheme = options.tls ? 'https' : 'http';
  const urlHost = host.includes(':') ? `[${host}]` : host;
  logger.info('relay listening', { port: boundPort, tls: Boolean(options.tls) });

  let closing: Promise<void> | null = null;
  return {
    relayId: store.relayId,
    localUrl: `${scheme}://${urlHost}:${boundPort}`,
    port: boundPort,
    updateTls(tls) {
      if (!options.tls) throw new Error('relay is not serving HTTPS');
      (server as import('node:https').Server).setSecureContext({ cert: tls.cert, key: tls.key });
      logger.info('certificate updated');
    },
    close(closeOptions) {
      closing ??= (async () => {
        clearInterval(sweepTimer);
        pairing.wakeAll();
        if (closeOptions?.retire) hub.closeAll(CLOSE_DEVICE_REMOVED, 'relay retired');
        else hub.closeAll(1001, 'relay shutting down');
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        });
        await store.flush();
      })();
      return closing;
    },
  };
}

/** 从文件读取 PEM 证书与私钥(独立运行时由命令行参数指定)。 */
export async function readTlsFiles(certPath: string, keyPath: string): Promise<{ cert: Buffer; key: Buffer }> {
  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  return { cert, key };
}
