/**
 * 出站(上游方向)HTTP 代理支持 ——
 *
 * 背景:proxy 转发上游用的是 node:http/https 直连,而 Node 的 http 栈不读系统代理、
 * 也不读代理环境变量。用户的代理软件跑在「系统代理」模式(非 TUN)时,浏览器 / Codex CLI
 * (reqwest 自动吃 env)都正常,唯独本代理的上游连接裸直连 → 高墙网络下 AggregateError
 * → 客户端收 502 "upstream unreachable"。本模块提供:
 *
 *   - parseOutboundProxyUrl:解析 `http://[user:pass@]host:port` 形式的代理地址
 *     (当前只支持 HTTP 代理;https/socks 代理返回 null,由调用方回落直连并告警)
 *   - createEnvOutboundProxyResolver:按惯例读 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY /
 *     NO_PROXY(大小写两种拼写),给非 Electron 宿主(CLI / 远端 cc-manager)直接用
 *   - TunnelingHttpsAgent:经代理 CONNECT 隧道连 https 上游的 keep-alive Agent
 *     (TLS 端到端,由 https.Agent 原生逻辑完成,代理只见密文)
 *   - OutboundProxyAgentPool:按代理地址缓存 agent,复用连接池,随 proxy dispose 销毁
 *
 * 边界:代理鉴权只支持 URL userinfo → Proxy-Authorization: Basic;系统代理的
 * 解析(Electron session.resolveProxy)由宿主注入 resolver,本包不依赖 Electron。
 */

import { request as httpRequest, type ClientRequestArgs, type RequestOptions } from 'node:http';
import { Agent as HttpsAgent, type AgentOptions } from 'node:https';
import type { TcpSocketConnectOpts } from 'node:net';
import type { Duplex } from 'node:stream';
import { URL } from 'node:url';

/** 解析后的出站代理目标。authHeader 是现成的 Proxy-Authorization 值(含 "Basic " 前缀)。 */
export interface OutboundProxyTarget {
  /** 规范化代理地址(不含 userinfo,可安全进日志),例 "http://127.0.0.1:7890"。 */
  url: string;
  hostname: string;
  port: number;
  authHeader?: string;
}

/**
 * 出站代理解析器 —— per-request 以最终上游 origin(`https://host:port`)现取代理地址。
 * 返回 http:// 代理 URL = 该请求经代理转发;null/undefined = 直连。
 * 抛错按直连处理(fail-open,代理解析故障不断链路)。loopback 上游不会被调用。
 */
export type OutboundProxyResolver = (
  upstreamUrl: string,
) => string | null | undefined | Promise<string | null | undefined>;

/**
 * 去掉 IPv6 字面量的方括号。WHATWG URL 的 `hostname` 对 IPv6 返回**带方括号**的
 * 形式(`new URL('https://[::1]').hostname === '[::1]'`),而比较 / 重组 authority
 * 都需要裸地址;所有消费 hostname 的入口先过这里归一化。
 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * loopback 上游永不走代理:本机 bridge / gateway 与代理软件无关,而且系统代理的
 * bypass 规则(localhost 默认直连)在 env 层不可见,这里必须自兜。
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = stripIpv6Brackets(hostname.toLowerCase());
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h.startsWith('127.');
}

/**
 * 拼 host:port authority。IPv6 字面量按 RFC 3986 加方括号 —— resolver URL、
 * CONNECT 目标、绝对形式 URL 与 Host 头共用,裸拼 `v6:port` 会被代理当成非法目标。
 */
export function formatAuthority(hostname: string, port: number): string {
  const bare = stripIpv6Brackets(hostname);
  return bare.includes(':') ? `[${bare}]:${port}` : `${bare}:${port}`;
}

/**
 * 按 RFC 9110 语义拼 Host 头:默认端口省略,非默认端口带上;IPv6 字面量加方括号。
 * 经代理的绝对形式请求用 —— 该分支 socket 连的是代理,Host 头只能靠显式设置。
 */
export function formatHostHeader(hostname: string, port: number, protocol: 'http:' | 'https:'): string {
  const defaultPort = protocol === 'https:' ? 443 : 80;
  const bare = stripIpv6Brackets(hostname);
  const bracketed = bare.includes(':') ? `[${bare}]` : bare;
  return port === defaultPort ? bracketed : `${bracketed}:${port}`;
}

/**
 * userinfo 解码。decodeURIComponent 对非法百分号编码(如 `user%GG`)会抛 URIError;
 * 解析器绝不能抛(在请求热路径上,抛了就是未处理 rejection 而非直连回退),
 * 解不开就按用户原文使用。
 */
function safeDecodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 解析代理地址。只接受 http: 协议(CONNECT 隧道 / 绝对形式都建立在明文 HTTP 代理上);
 * https:(TLS-to-proxy)与 socks: 暂不支持,返回 null 由调用方回落直连。
 * 任何输入都不抛错:解析失败一律返回 null。
 */
export function parseOutboundProxyUrl(raw: string | null | undefined): OutboundProxyTarget | null {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:') return null;
  if (!u.hostname) return null;
  const port = u.port ? Number(u.port) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let authHeader: string | undefined;
  if (u.username) {
    // URL 里的 userinfo 是百分号编码的,先解码再进 Basic。
    const user = safeDecodeUserinfo(u.username);
    const pass = u.password ? safeDecodeUserinfo(u.password) : '';
    authHeader = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
  }
  // hostname 去掉 IPv6 方括号:它会被直接用作 TCP connect host(net/tls 只认裸地址);
  // url 保留带括号的 u.host 形态(仅用于日志与 pool key)。
  return { url: `http://${u.host}`, hostname: stripIpv6Brackets(u.hostname), port, authHeader };
}

/** 把可能带凭证的代理地址脱敏成可进日志的形式(只留 scheme://host:port)。 */
export function redactProxyUrlForLog(raw: string): string {
  try {
    const u = new URL(raw.trim());
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<unparseable proxy url>';
  }
}

const ENV_HTTPS_KEYS = ['HTTPS_PROXY', 'https_proxy'] as const;
const ENV_HTTP_KEYS = ['HTTP_PROXY', 'http_proxy'] as const;
const ENV_ALL_KEYS = ['ALL_PROXY', 'all_proxy'] as const;
const ENV_NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const;

function firstEnvValue(env: NodeJS.ProcessEnv, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** 宿主是否配置了任何代理环境变量(用于「env 有配置就以 env 为准」的分层判断)。 */
export function hasProxyEnvConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return firstEnvValue(env, [...ENV_HTTPS_KEYS, ...ENV_HTTP_KEYS, ...ENV_ALL_KEYS]) !== null;
}

/**
 * NO_PROXY 匹配(逗号分隔)。支持惯例语义:
 *   - `*` 全部直连
 *   - `example.com` / `.example.com` 匹配该域及其子域
 *   - `host:port` 额外要求端口一致(仅在恰好一个冒号时按 host:port 拆,
 *     裸 IPv6 字面量如 `::1` / `2001:db8::1` 整体当 host,不误拆末段为端口)
 *   - `[v6]` / `[v6]:port` 的无歧义 IPv6 带端口形式
 * IP 段(CIDR)不支持 —— 与多数实现一致,按普通字面 host 处理。
 */
function noProxyMatches(noProxy: string, hostname: string, port: number): boolean {
  // URL.hostname 的 IPv6 带方括号,先归一成裸地址再与条目比较。
  const host = stripIpv6Brackets(hostname.toLowerCase());
  for (const rawEntry of noProxy.split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryHost = entry;
    let entryPort: number | null = null;
    if (entry.startsWith('[')) {
      // [v6] / [v6]:port —— 唯一无歧义的 IPv6 带端口写法。
      const close = entry.indexOf(']');
      if (close === -1) continue;  // 括号没闭合,条目非法,跳过
      entryHost = entry.slice(1, close);
      const rest = entry.slice(close + 1);
      if (rest.startsWith(':') && /^\d+$/.test(rest.slice(1))) {
        entryPort = Number(rest.slice(1));
      } else if (rest) {
        continue;  // `]` 后跟了端口以外的东西,条目非法,跳过
      }
    } else {
      const first = entry.indexOf(':');
      // 恰好一个冒号且后缀纯数字才按 host:port 拆;多个冒号 = 裸 IPv6 字面量整体当 host。
      if (first !== -1 && first === entry.lastIndexOf(':') && /^\d+$/.test(entry.slice(first + 1))) {
        entryHost = entry.slice(0, first);
        entryPort = Number(entry.slice(first + 1));
      }
    }
    if (entryPort !== null && entryPort !== port) continue;
    const bare = entryHost.startsWith('.') ? entryHost.slice(1) : entryHost;
    if (!bare) continue;
    if (host === bare || host.endsWith(`.${bare}`)) return true;
  }
  return false;
}

/**
 * 环境变量代理解析器。语义与 curl / reqwest 等惯例对齐:
 *   https 上游 → HTTPS_PROXY ?? ALL_PROXY;http 上游 → HTTP_PROXY ?? ALL_PROXY;
 *   NO_PROXY 命中或 loopback 上游 → 直连。
 * env 值在每次调用时现读(默认 process.env),宿主运行期改 env 即时生效。
 */
export function createEnvOutboundProxyResolver(
  env: NodeJS.ProcessEnv = process.env,
): (upstreamUrl: string) => string | null {
  return (upstreamUrl: string): string | null => {
    let u: URL;
    try {
      u = new URL(upstreamUrl);
    } catch {
      return null;
    }
    if (isLoopbackHostname(u.hostname)) return null;
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    const noProxy = firstEnvValue(env, ENV_NO_PROXY_KEYS);
    if (noProxy && noProxyMatches(noProxy, u.hostname, port)) return null;
    const primary = u.protocol === 'https:' ? ENV_HTTPS_KEYS : ENV_HTTP_KEYS;
    return firstEnvValue(env, primary) ?? firstEnvValue(env, ENV_ALL_KEYS);
  };
}

// CONNECT 握手整体超时。代理通常在本机/局域网,正常毫秒级完成;上限只防代理软件假死
// 时无限悬挂。不宜过短:代理背后可能还要现拨远端节点。
const PROXY_CONNECT_TIMEOUT_MS = 15 * 1000;

// 连接代理自身的 Happy Eyeballs 单地址握手超时,与 server.ts 对上游直连的放宽一致
// (代理若配了 DNS 名且解析出多地址,同样会被 Node 默认 250ms per-attempt 砍死)。
const PROXY_CONNECT_ATTEMPT_TIMEOUT_MS = 2500;

/**
 * 经 HTTP 代理 CONNECT 隧道连 https 上游的 keep-alive Agent。
 *
 * 工作方式:对代理发 `CONNECT host:port`,200 后拿到隧道 socket,把它交回
 * https.Agent 原生 createConnection(带 `socket` 选项)完成 TLS 握手 —— TLS 端到端,
 * SNI / 证书校验 / session 复用全部沿用 Node 原生逻辑,代理只见密文。
 * 连接池语义与直连时的 globalAgent 一致(keepAlive,按 host:port 分 key)。
 */
export class TunnelingHttpsAgent extends HttpsAgent {
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
    if (!callback) throw new Error('TunnelingHttpsAgent requires callback-style createConnection');
    const targetHost = options.host ?? 'localhost';
    const targetPort = Number(options.port) || 443;
    const authority = formatAuthority(targetHost, targetPort);
    let settled = false;
    const settle = (err: Error | null, stream?: Duplex): void => {
      if (settled) return;
      settled = true;
      // @types/node 的 callback 把 stream 声明为必选;错误分支按运行时约定传 err 即可。
      (callback as (err: Error | null, stream?: Duplex) => void)(err, stream);
    };

    const connectOptions: RequestOptions & Pick<TcpSocketConnectOpts, 'autoSelectFamilyAttemptTimeout'> = {
      host: this.proxy.hostname,
      port: this.proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        ...(this.proxy.authHeader ? { 'proxy-authorization': this.proxy.authHeader } : {}),
      },
      // CONNECT 会劫持底层 socket,绝不能进共享连接池。
      agent: false,
      timeout: PROXY_CONNECT_TIMEOUT_MS,
      autoSelectFamilyAttemptTimeout: PROXY_CONNECT_ATTEMPT_TIMEOUT_MS,
    };
    const connectReq = httpRequest(connectOptions);

    connectReq.on('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        settle(new Error(`outbound proxy ${this.proxy.url} CONNECT ${authority} failed: HTTP ${res.statusCode}`));
        return;
      }
      // CONNECT 成功后代理不应再发字节;万一有(不合规代理提前送了上游数据)塞回流里。
      if (head.length > 0) socket.unshift(head);
      try {
        // 委托 https.Agent 原生 createConnection 做 TLS:`socket` 选项让 tls.connect
        // 直接包装隧道 socket 而不再自行拨号,servername / 证书校验 / session 缓存照旧。
        const tlsSocket = (HttpsAgent.prototype as unknown as {
          createConnection: (opts: unknown) => Duplex;
        }).createConnection.call(this, { ...options, socket });
        settle(null, tlsSocket);
      } catch (err) {
        socket.destroy();
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    });
    connectReq.on('timeout', () => {
      connectReq.destroy(new Error(`outbound proxy ${this.proxy.url} CONNECT ${authority} timed out`));
    });
    connectReq.on('error', (err) => {
      settle(new Error(`outbound proxy ${this.proxy.url} unreachable: ${err.message}`));
    });
    connectReq.end();
    // socket 走异步 callback 交付;返回 undefined 告知调用方等 callback。
    return undefined;
  }
}

// 正常场景同一时刻只有一个系统代理;上限只防 resolver 返回值抖动(PAC 按 host 给不同
// 出口)时 agent 无限累积。超限逐出最旧的并销毁其连接池。
const AGENT_POOL_MAX_ENTRIES = 8;

/**
 * 按代理地址缓存 TunnelingHttpsAgent,复用其 keep-alive 连接池。
 * 生命周期随 proxy server:dispose 时销毁全部 agent(断开空闲隧道)。
 */
export class OutboundProxyAgentPool {
  private readonly agents = new Map<string, TunnelingHttpsAgent>();

  get(proxy: OutboundProxyTarget): TunnelingHttpsAgent {
    // authHeader 参与 key:同地址不同凭证不能共享隧道池。
    const key = `${proxy.url} ${proxy.authHeader ?? ''}`;
    const existing = this.agents.get(key);
    if (existing) return existing;
    if (this.agents.size >= AGENT_POOL_MAX_ENTRIES) {
      const oldest = this.agents.keys().next().value;
      if (oldest !== undefined) {
        this.agents.get(oldest)?.destroy();
        this.agents.delete(oldest);
      }
    }
    const agent = new TunnelingHttpsAgent(proxy);
    this.agents.set(key, agent);
    return agent;
  }

  destroy(): void {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
  }
}
