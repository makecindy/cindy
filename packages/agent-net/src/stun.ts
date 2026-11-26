/**
 * 查自己的公网地址：最小的 STUN Binding 请求（RFC 5389），从 agent-net 用的同一个 UDP 端口发出，
 * 这样拿到的就是 NAT 给这个端口的外部地址，打洞时告诉对端。回复用驱动的 `intercept` 截下，不交给核心。
 * 只认 XOR-MAPPED-ADDRESS（还有老服务器的 MAPPED-ADDRESS），不做认证、不重传以外的任何事。
 *
 * 透明代理的 Fake-IP 避让（2026-11-22 真机排查）：Surge / Clash / Mihomo / Sing-box 等透明代理把域名解析成
 * RFC 2544 保留段 `198.18.0.0/15`（并且劫持普通 UDP/53）。往 Fake-IP 发 STUN 或中转 UDP 会命中代理的域名分流
 * 路径，分配的外部端口与按真实 IP 探测对端时走 NAT 得到的端口不同，导致对端处于端口受限锥形 NAT 时双向互相丢包、
 * 永远无法直连。检测到 `198.18.0.0/15` 时，改经直连 IP 的 DoH 取回真实 IPv4，拿不到再回退原解析结果。
 */
import { lookup } from 'node:dns/promises';
import { randomBytes } from 'node:crypto';
import type { ClientRequest } from 'node:http';
import { get as httpsGet } from 'node:https';
import { isIPv4 } from 'node:net';
import type { Address } from '@cindy/agent-net-core/node';

const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const MAGIC_COOKIE = 0x2112a442;
const MAPPED_ADDRESS = 0x0001;
const XOR_MAPPED_ADDRESS = 0x0020;

const DOH_TIMEOUT_MS = 2_000;
const MAX_DOH_BODY_BYTES = 16 * 1024;
const DOH_SERVERS: ReadonlyArray<{ host: string; servername: string; path: (name: string) => string; accept?: string }> = [
  { host: '223.5.5.5', servername: 'dns.alidns.com', path: (name) => `/resolve?name=${encodeURIComponent(name)}&type=A` },
  { host: '1.1.1.1', servername: 'cloudflare-dns.com', path: (name) => `/dns-query?name=${encodeURIComponent(name)}&type=A`, accept: 'application/dns-json' },
];
const inFlightRealLookups = new Map<string, Promise<string | null>>();

export interface ResolveUdpHostDeps {
  systemLookup?: (host: string) => Promise<string>;
  resolveReal?: (host: string) => Promise<string | null>;
}

/** 透明代理常用的 Fake-IP 段（RFC 2544：`198.18.0.0/15`）。 */
export function isFakeIp(address: string): boolean {
  if (!isIPv4(address)) return false;
  const first = address.indexOf('.');
  const second = address.indexOf('.', first + 1);
  if (Number(address.slice(0, first)) !== 198) return false;
  const octet = Number(address.slice(first + 1, second));
  return octet === 18 || octet === 19;
}

/** 从 DoH JSON 响应（AliDNS / Cloudflare 兼容格式）中取出第一个非 Fake-IP 的 IPv4 A 记录。 */
export function parseDohIpv4(body: string): string | null {
  let parsed: { Status?: unknown; Answer?: unknown };
  try { parsed = JSON.parse(body); } catch { return null; }
  if (parsed.Status !== 0 || !Array.isArray(parsed.Answer)) return null;
  for (const record of parsed.Answer) {
    if (!record || typeof record !== 'object') continue;
    const { type, data } = record as { type?: unknown; data?: unknown };
    if (type === 1 && typeof data === 'string' && isIPv4(data) && !isFakeIp(data)) return data;
  }
  return null;
}

function queryOneDoh(
  server: (typeof DOH_SERVERS)[number],
  host: string,
  timeoutMs: number,
): { promise: Promise<string | null>; cancel: () => void } {
  let req: ClientRequest | null = null;
  let timer: NodeJS.Timeout | null = null;
  let settled = false;
  let finish!: (value: string | null) => void;
  const done = (value: string | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    finish(value);
  };
  const promise = new Promise<string | null>((resolve) => {
    finish = resolve;
    timer = setTimeout(() => { req?.destroy(); done(null); }, timeoutMs);
    timer.unref();
    req = httpsGet({
      host: server.host,
      port: 443,
      servername: server.servername,
      path: server.path(host),
      headers: server.accept ? { accept: server.accept } : undefined,
      agent: false,
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); done(null); return; }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_DOH_BODY_BYTES) { res.destroy(); done(null); return; }
        chunks.push(chunk);
      });
      res.on('end', () => done(parseDohIpv4(Buffer.concat(chunks).toString('utf8'))));
      res.on('error', () => done(null));
    });
    req.on('error', () => done(null));
  });
  return {
    promise,
    cancel: () => { req?.destroy(); done(null); },
  };
}

function resolveViaDoh(host: string, timeoutMs = DOH_TIMEOUT_MS): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const queries = DOH_SERVERS.map((server) => queryOneDoh(server, host, timeoutMs));
    let remaining = queries.length;
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      for (const query of queries) query.cancel();
      resolve(value);
    };
    for (const query of queries) {
      void query.promise.then((address) => {
        if (address) { settle(address); return; }
        remaining -= 1;
        if (remaining === 0) settle(null);
      });
    }
  });
}

function resolveRealDeduplicated(host: string, resolveReal: (host: string) => Promise<string | null>): Promise<string | null> {
  const existing = inFlightRealLookups.get(host);
  if (existing) return existing;
  const pending = resolveReal(host).catch(() => null).finally(() => {
    if (inFlightRealLookups.get(host) === pending) inFlightRealLookups.delete(host);
  });
  inFlightRealLookups.set(host, pending);
  return pending;
}

/**
 * 解析 STUN 与中转 UDP 目标的 IPv4 地址：普通网络直接用系统 DNS；若系统 DNS 返回 Fake-IP（`198.18.0.0/15`），
 * 再经直连 IP 的 DoH 解析真实 IPv4 以避开透明代理的 Fake-IP 路径，解析不到时回退系统结果。
 */
export async function resolveUdpHost(host: string, deps: ResolveUdpHostDeps = {}): Promise<string> {
  if (isIPv4(host)) return host;
  const address = deps.systemLookup ? await deps.systemLookup(host) : (await lookup(host, { family: 4 })).address;
  if (!isFakeIp(address)) return address;
  const real = await resolveRealDeduplicated(host, deps.resolveReal ?? resolveViaDoh);
  return real && isIPv4(real) && !isFakeIp(real) ? real : address;
}

interface Pending {
  resolve: (address: Address | null) => void;
  timer: NodeJS.Timeout;
}

export class StunClient {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  close(): void {
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.resolve(null); }
    this.pending.clear();
  }

  /** `send` 从 agent-net 的 UDP 端口发一个数据报（驱动的 `sendUdp`）。 */
  constructor(
    private readonly send: (to: Address, datagram: Uint8Array) => void,
    private readonly resolveHost: (host: string) => Promise<string> = resolveUdpHost,
  ) {}

  /** 交给驱动的 `intercept`：是这里发出的请求的回复就收下并返回 `true`。 */
  readonly intercept = (datagram: Uint8Array): boolean => {
    const bytes = Buffer.from(datagram.buffer, datagram.byteOffset, datagram.byteLength);
    if (bytes.length < 20 || bytes.readUInt32BE(4) !== MAGIC_COOKIE) return false;
    const id = bytes.subarray(8, 20).toString('hex');
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(bytes.readUInt16BE(0) === BINDING_SUCCESS ? parseMapped(bytes) : null);
    return true;
  };

  /** 向 `server`（`主机:端口`）查这个端口的外部地址，最多重发两次，查不到返回 `null`。 */
  async query(server: string, timeoutMs = 1_500): Promise<Address | null> {
    const [host, port] = splitHostPort(server);
    const address = await this.resolveHost(host);
    if (this.closed) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.closed) return null;
      const id = randomBytes(12);
      const request = Buffer.alloc(20);
      request.writeUInt16BE(BINDING_REQUEST, 0);
      request.writeUInt32BE(MAGIC_COOKIE, 4);
      id.copy(request, 8);
      const reply = new Promise<Address | null>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id.toString('hex'));
          resolve(null);
        }, timeoutMs / 3);
        timer.unref();
        this.pending.set(id.toString('hex'), { resolve, timer });
      });
      try { this.send({ address, port }, request); }
      catch {
        const pending = this.pending.get(id.toString('hex'));
        if (pending) { clearTimeout(pending.timer); this.pending.delete(id.toString('hex')); pending.resolve(null); }
        return null;
      }
      const mapped = await reply;
      if (mapped) return mapped;
    }
    return null;
  }
}

export function splitHostPort(server: string): [string, number] {
  const index = server.lastIndexOf(':');
  return [server.slice(0, index), Number(server.slice(index + 1))];
}

function parseMapped(message: Buffer): Address | null {
  let offset = 20;
  const end = Math.min(message.length, 20 + message.readUInt16BE(2));
  let plain: Address | null = null;
  while (offset + 4 <= end) {
    const type = message.readUInt16BE(offset);
    const length = message.readUInt16BE(offset + 2);
    const value = message.subarray(offset + 4, offset + 4 + length);
    if ((type === XOR_MAPPED_ADDRESS || type === MAPPED_ADDRESS) && value.length >= 8 && value[1] === 0x01) {
      const xor = type === XOR_MAPPED_ADDRESS;
      const port = value.readUInt16BE(2) ^ (xor ? MAGIC_COOKIE >>> 16 : 0);
      const ip = value.readUInt32BE(4) ^ (xor ? MAGIC_COOKIE : 0);
      const address = { address: [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.'), port };
      if (xor) return address;
      plain = address;
    }
    // 属性按 4 字节对齐。
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return plain;
}
