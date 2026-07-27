/**
 * SOCKS5 出站代理支持(RFC 1928 + RFC 1929 用户名/密码认证)——
 *
 * 背景:出站代理原先只认明文 HTTP 代理(见 outbound-proxy.ts)。代理软件跑「系统代理」
 * 模式却只提供 SOCKS 出口时,解析器全部跳过 → 回落裸直连 → 由 **本机** 解析上游域名;
 * 本地 DNS 解不出(污染 / 公司 DNS / 依赖代理软件的远端 DNS)就必然
 * `getaddrinfo ENOTFOUND <上游>` → 客户端收 502 "upstream unreachable"。
 *
 * 本模块手写 SOCKS5 客户端(本包对外部署要求零运行时依赖,见 build.mjs),提供:
 *   - socks5Connect:完成协商 / 认证 / CONNECT,返回已就绪的隧道 socket
 *   - Socks5HttpsAgent:隧道之上做 TLS(端到端,代理只见密文),keep-alive 复用
 *   - Socks5HttpAgent :隧道直接当 http 连接用(http 上游无需 TLS 包装)
 *
 * **DNS 一律交给代理端解析**:目标是域名时用 ATYP=0x03 原样送出,不在本地预解析。
 * curl 用 `socks5://` / `socks5h://` 区分本地 / 远端解析,本模块不做这个区分 ——
 * 本地解析正是上面那条故障链的起点,在这里没有任何收益。只有上游本身写成 IP 字面量
 * 时才用 ATYP=0x01 / 0x04。
 */

import { Agent as HttpAgent, type ClientRequestArgs } from 'node:http';
import { Agent as HttpsAgent, type AgentOptions } from 'node:https';
import { connect as netConnect, isIPv4, isIPv6, type Socket, type TcpSocketConnectOpts } from 'node:net';
import type { Duplex } from 'node:stream';

import {
  formatAuthority,
  SOCKS5_CREDENTIAL_MAX_BYTES,
  stripIpv6Brackets,
  type OutboundProxyTarget,
} from './outbound-proxy.js';

// 握手整体超时(TCP 连上代理 → CONNECT 回复读完)。与 HTTP 代理 CONNECT 的
// PROXY_CONNECT_TIMEOUT_MS 对齐:代理通常在本机/局域网,正常毫秒级完成,上限只防
// 代理软件假死时无限悬挂;不宜过短,代理背后可能还要现拨远端节点。
const SOCKS5_HANDSHAKE_TIMEOUT_MS = 15 * 1000;

// 连接代理自身的 Happy Eyeballs 单地址握手超时,同样与 HTTP 代理路径一致
// (代理写成 DNS 名且解出多地址时,Node 默认 250ms per-attempt 会把候选逐个砍死)。
const SOCKS5_CONNECT_ATTEMPT_TIMEOUT_MS = 2500;

const VERSION = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_NONE_ACCEPTABLE = 0xff;
const USERPASS_SUBNEGOTIATION_VERSION = 0x01;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REP_SUCCEEDED = 0x00;

/** RFC 1928 §6 的 REP 码 → 可读原因;未知码回落十六进制,不吞掉信息。 */
function replyErrorText(rep: number): string {
  switch (rep) {
    case 0x01: return 'general SOCKS server failure';
    case 0x02: return 'connection not allowed by ruleset';
    case 0x03: return 'network unreachable';
    case 0x04: return 'host unreachable';
    case 0x05: return 'connection refused';
    case 0x06: return 'TTL expired';
    case 0x07: return 'command not supported';
    case 0x08: return 'address type not supported';
    default: return `unknown reply code 0x${rep.toString(16).padStart(2, '0')}`;
  }
}

/**
 * IPv6 字面量 → 16 字节。Node 没有内置 API,这里按 RFC 4291 文本形式手解:支持 `::`
 * 压缩与末段内嵌 IPv4(`::ffff:1.2.3.4`)。调用方已用 isIPv6 校验过格式,解析失败
 * (理论上不可达)返回 null 由调用方回落成错误,不静默发出错误地址。
 */
export function ipv6ToBytes(address: string): Buffer | null {
  // 去掉可能的 zone id(`fe80::1%en0`)—— SOCKS5 目标地址里没有 zone 的位置。
  const bare = address.split('%')[0];
  const doubleColon = bare.indexOf('::');
  const headText = doubleColon === -1 ? bare : bare.slice(0, doubleColon);
  const tailText = doubleColon === -1 ? '' : bare.slice(doubleColon + 2);

  const toGroups = (text: string): number[] | null => {
    if (!text) return [];
    const groups: number[] = [];
    for (const part of text.split(':')) {
      if (!part) return null;
      if (part.includes('.')) {
        // 内嵌 IPv4 只可能出现在最后,占两个 16-bit 组。
        if (!isIPv4(part)) return null;
        const octets = part.split('.').map(Number);
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  const head = toGroups(headText);
  const tail = toGroups(tailText);
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (doubleColon === -1 ? fill !== 0 : fill < 0) return null;
  const groups = [...head, ...new Array<number>(Math.max(fill, 0)).fill(0), ...tail];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  groups.forEach((group, i) => out.writeUInt16BE(group, i * 2));
  return out;
}

/**
 * 把目标地址编码成 SOCKS5 的 ATYP + ADDR 段。域名走 ATYP_DOMAIN 交给代理解析
 * (见文件头注释);域名超 255 字节无法表达,返回 null。
 *
 * 先剥 IPv6 方括号:上游 URL 里的 `https://[2001:db8::1]` 经 WHATWG URL 解析后
 * hostname 恒带方括号,且 Node 把它原样传到 agent 的 `options.host`(实测)。
 * 不剥的话 isIPv6 判否,地址会被当成**域名**连括号一起发出去,代理拿去做 DNS
 * 解析必然失败。
 */
function encodeDestination(rawHost: string): Buffer | null {
  const host = stripIpv6Brackets(rawHost);
  if (isIPv4(host)) {
    return Buffer.concat([Buffer.of(ATYP_IPV4), Buffer.from(host.split('.').map(Number))]);
  }
  if (isIPv6(host)) {
    const bytes = ipv6ToBytes(host);
    return bytes ? Buffer.concat([Buffer.of(ATYP_IPV6), bytes]) : null;
  }
  const domain = Buffer.from(host, 'utf8');
  if (domain.length === 0 || domain.length > 255) return null;
  return Buffer.concat([Buffer.of(ATYP_DOMAIN, domain.length), domain]);
}

/** 回复里 BND.ADDR 段的长度(不含 ATYP 本身);域名形态的长度前缀由调用方先读一字节。 */
function boundAddressLength(atyp: number, domainLength: number): number | null {
  if (atyp === ATYP_IPV4) return 4;
  if (atyp === ATYP_IPV6) return 16;
  if (atyp === ATYP_DOMAIN) return domainLength;
  return null;
}

/**
 * 顺序读取器 —— 握手是严格的请求/应答往返,用 `read(n)` 表达最直观。socket 出错或
 * 提前关闭时唤醒等待者,不留悬挂 Promise;`release()` 摘掉 listener 并把多读的字节
 * 塞回流(合规代理不会提前发数据,但不合规的会)。
 */
function createSocketReader(socket: Socket): {
  read: (n: number) => Promise<Buffer>;
  fail: (err: Error) => void;
  release: () => void;
} {
  // 显式标注 Buffer(默认 ArrayBufferLike):socket 'data' 给的 chunk 与 alloc 出来的
  // 具体 ArrayBuffer 类型参数不同,不标注会在 concat 赋值处类型不兼容。
  let buffered: Buffer = Buffer.alloc(0);
  let waiter: { need: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null;
  // socket 出错 / 提前关闭后记在这里,让后续 read 同步失败而不是空等到握手超时。
  let terminalError: Error | null = null;

  const settleIfReady = (): void => {
    if (!waiter || buffered.length < waiter.need) return;
    const { need, resolve } = waiter;
    waiter = null;
    resolve(buffered.subarray(0, need));
    buffered = buffered.subarray(need);
  };
  const onData = (chunk: Buffer): void => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
    settleIfReady();
  };
  socket.on('data', onData);

  return {
    read(n: number): Promise<Buffer> {
      return new Promise<Buffer>((resolve, reject) => {
        // socket 已经出错 / 关闭:立刻失败,不要挂到握手超时才发现。今天的握手是
        // 一条线性 await 链(每次 read resolve 后的微任务里就挂上了下一个 waiter,
        // 早于任何 I/O 回调),所以「无 waiter 时出错」这个窗口够不到;记住终止错误
        // 是为了将来万一在两次 read 之间插入 await,不至于静默退化成 15s 空等。
        if (terminalError) { reject(terminalError); return; }
        // 握手是串行的,同一时刻只会有一个等待者;并发读是编码错误。
        if (waiter) { reject(new Error('socks5: concurrent read')); return; }
        waiter = { need: n, resolve, reject };
        settleIfReady();
      });
    },
    fail(err: Error): void {
      // 保留第一个错误 —— 它最接近根因(后续的 close 只是它的后果)。
      terminalError ??= err;
      const pending = waiter;
      waiter = null;
      pending?.reject(err);
    },
    release(): void {
      socket.off('data', onData);
      // 失败路径上 socket 可能已经销毁,此时 unshift 会抛;只在还活着时塞回。
      if (buffered.length > 0 && !socket.destroyed) socket.unshift(buffered);
      // 注意:这里**不能** pause()。挂过 'data' 已把流切进 flowing,显式 pause 会让
      // readableFlowing=false,而 http.Agent / tls 接管时只是 on('data'),不会主动
      // resume —— 那才是真正的挂起。flowing 状态下的空档只存在于「release 到下一个
      // 消费者接管」之间,调用方必须在同一个同步块里把 socket 交出去(见两个 agent)。
    },
  };
}

/**
 * 连到 SOCKS5 代理并把隧道打到 `destHost:destPort`,返回已就绪的裸 socket
 * (之后可直接当 TCP 用,或在其上做 TLS)。任何失败都 destroy socket 并抛错,
 * 错误信息统一带上代理地址(脱敏形态)与目标,便于从 502 body 一眼定位失败在哪一跳。
 */
export async function socks5Connect(
  proxy: OutboundProxyTarget,
  destHost: string,
  destPort: number,
): Promise<Socket> {
  const authority = formatAuthority(destHost, destPort);
  const fail = (message: string): Error => new Error(`outbound proxy ${proxy.url} ${message}`);

  const destination = encodeDestination(destHost);
  if (!destination) throw fail(`cannot encode destination ${authority}`);

  const connectOptions: TcpSocketConnectOpts & { autoSelectFamilyAttemptTimeout?: number } = {
    host: proxy.hostname,
    port: proxy.port,
    autoSelectFamilyAttemptTimeout: SOCKS5_CONNECT_ATTEMPT_TIMEOUT_MS,
  };
  const socket = netConnect(connectOptions);
  socket.setNoDelay(true);
  const reader = createSocketReader(socket);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    const err = fail(`CONNECT ${authority} timed out`);
    reader.fail(err);
    socket.destroy(err);
  }, SOCKS5_HANDSHAKE_TIMEOUT_MS);
  // 握手期的定时器不该拖住进程退出(Node 允许 unref;某些运行时无此方法)。
  timer.unref?.();

  // socket 层错误 / 提前 EOF 唤醒等待中的 read,避免握手 Promise 永久悬挂。
  const onError = (err: Error): void => {
    reader.fail(timedOut ? fail(`CONNECT ${authority} timed out`) : fail(`unreachable: ${err.message}`));
  };
  const onClose = (): void => {
    reader.fail(timedOut
      ? fail(`CONNECT ${authority} timed out`)
      : fail(`closed the connection during the SOCKS5 handshake`));
  };
  socket.on('error', onError);
  socket.on('close', onClose);

  try {
    await new Promise<void>((resolve, reject) => {
      if (!socket.connecting) { resolve(); return; }
      socket.once('connect', resolve);
      socket.once('error', (err: Error) => reject(fail(`unreachable: ${err.message}`)));
      socket.once('close', () => reject(fail('unreachable: connection closed')));
    });

    // ── 方法协商 ──────────────────────────────────────────────────────────
    const methods = proxy.username ? [AUTH_NONE, AUTH_USERPASS] : [AUTH_NONE];
    socket.write(Buffer.from([VERSION, methods.length, ...methods]));
    const greeting = await reader.read(2);
    if (greeting[0] !== VERSION) throw fail(`is not a SOCKS5 proxy (server version 0x${greeting[0].toString(16)})`);
    const method = greeting[1];
    if (method === AUTH_NONE_ACCEPTABLE) {
      throw fail(proxy.username
        ? 'rejected both anonymous and username/password authentication'
        : 'requires authentication but none is configured');
    }

    // ── RFC 1929 用户名/密码认证 ──────────────────────────────────────────
    if (method === AUTH_USERPASS) {
      if (!proxy.username) throw fail('requires username/password authentication but none is configured');
      const user = Buffer.from(proxy.username, 'utf8');
      const pass = Buffer.from(proxy.password ?? '', 'utf8');
      // UNAME / PASSWD 都是单字节长度前缀。parseOutboundProxyUrl 已把超长凭证降级成
      // 「无凭证」,但两个 agent 是公开导出的,宿主可以自己造 target —— 那条路上长度
      // 会静默溢出成错误的帧(300 → 44),把乱码凭证发给代理。fail fast。
      if (user.length > SOCKS5_CREDENTIAL_MAX_BYTES || pass.length > SOCKS5_CREDENTIAL_MAX_BYTES) {
        throw fail(`credentials exceed the RFC 1929 limit of ${SOCKS5_CREDENTIAL_MAX_BYTES} bytes`);
      }
      socket.write(Buffer.concat([
        Buffer.of(USERPASS_SUBNEGOTIATION_VERSION, user.length),
        user,
        Buffer.of(pass.length),
        pass,
      ]));
      const authReply = await reader.read(2);
      // 版本必须是子协商的 0x01。对不上说明流已经错位(代理实现不合规或读串了),
      // 此时 status 字节也不可信,不能当成认证成功继续往下走。
      if (authReply[0] !== USERPASS_SUBNEGOTIATION_VERSION) {
        throw fail(`returned an unexpected auth subnegotiation version 0x${authReply[0].toString(16).padStart(2, '0')}`);
      }
      // 状态非 0 即失败(不回显任何凭证内容)。
      if (authReply[1] !== 0x00) throw fail('rejected the username/password credentials');
    } else if (method !== AUTH_NONE) {
      throw fail(`selected unsupported authentication method 0x${method.toString(16).padStart(2, '0')}`);
    }

    // ── CONNECT ──────────────────────────────────────────────────────────
    const portBytes = Buffer.alloc(2);
    portBytes.writeUInt16BE(destPort);
    socket.write(Buffer.concat([Buffer.of(VERSION, CMD_CONNECT, 0x00), destination, portBytes]));

    const reply = await reader.read(4);
    if (reply[1] !== REP_SUCCEEDED) {
      throw fail(`CONNECT ${authority} failed: ${replyErrorText(reply[1])}`);
    }
    // BND.ADDR / BND.PORT 用不上,但必须读完,否则残留字节会污染隧道数据。
    const atyp = reply[3];
    const domainLength = atyp === ATYP_DOMAIN ? (await reader.read(1))[0] : 0;
    const addrLength = boundAddressLength(atyp, domainLength);
    if (addrLength === null) throw fail(`returned an unsupported bound address type 0x${atyp.toString(16)}`);
    await reader.read(addrLength + 2);

    clearTimeout(timer);
    socket.off('error', onError);
    socket.off('close', onClose);
    reader.release();
    return socket;
  } catch (err) {
    clearTimeout(timer);
    socket.off('error', onError);
    socket.off('close', onClose);
    reader.release();
    // 摘掉上面的 listener 后 socket 就没有 'error' 消费者了,销毁过程中再冒出的
    // ECONNRESET 会变成未捕获异常;挂一个空 listener 兜住。
    socket.on('error', () => {});
    socket.destroy();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * https 上游经 SOCKS5 隧道的 keep-alive Agent。握手拿到裸 socket 后交回
 * https.Agent 原生 createConnection(`socket` 选项)完成 TLS —— TLS 端到端,
 * SNI / 证书校验 / session 复用全部沿用 Node 原生逻辑,代理只见密文。
 * 与 HTTP 代理路径的 TunnelingHttpsAgent 同构。
 */
export class Socks5HttpsAgent extends HttpsAgent {
  private readonly proxy: OutboundProxyTarget;

  constructor(proxy: OutboundProxyTarget, opts?: AgentOptions) {
    super({ keepAlive: true, ...opts });
    this.proxy = proxy;
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    // http.Agent 运行时恒以 callback 形态调用(createSocket → oncreate);无 callback
    // 时无法异步建连,直接失败比静默直连安全。
    if (!callback) throw new Error('Socks5HttpsAgent requires callback-style createConnection');
    const settle = callback as (err: Error | null, stream?: Duplex) => void;
    socks5Connect(this.proxy, options.host ?? 'localhost', Number(options.port) || 443)
      .then((socket) => {
        try {
          const tlsSocket = (HttpsAgent.prototype as unknown as {
            createConnection: (opts: unknown) => Duplex;
          }).createConnection.call(this, { ...options, socket });
          settle(null, tlsSocket);
        } catch (err) {
          socket.destroy();
          settle(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .catch((err: unknown) => settle(err instanceof Error ? err : new Error(String(err))));
    // socket 走异步 callback 交付;返回 undefined 告知调用方等 callback。
    return undefined;
  }
}

/**
 * http 上游经 SOCKS5 隧道的 keep-alive Agent。SOCKS 是 L4 隧道,隧道建好后就是一条
 * 普通 TCP 连接,请求仍按 origin-form 发给真实上游(不存在 HTTP 代理那种绝对形式)。
 */
export class Socks5HttpAgent extends HttpAgent {
  private readonly proxy: OutboundProxyTarget;

  constructor(proxy: OutboundProxyTarget, opts?: AgentOptions) {
    super({ keepAlive: true, ...opts });
    this.proxy = proxy;
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    if (!callback) throw new Error('Socks5HttpAgent requires callback-style createConnection');
    const settle = callback as (err: Error | null, stream?: Duplex) => void;
    socks5Connect(this.proxy, options.host ?? 'localhost', Number(options.port) || 80)
      .then((socket) => settle(null, socket))
      .catch((err: unknown) => settle(err instanceof Error ? err : new Error(String(err))));
    return undefined;
  }
}
