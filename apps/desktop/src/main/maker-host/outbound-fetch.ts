/**
 * outbound-fetch —— main 侧「吃系统代理」的出网通道(undici fetch + ws agent)。
 *
 * 背景:Node 的 undici(`globalThis.fetch`)与 `ws` 都**不读系统代理设置、也不读
 * 代理环境变量**。用户的代理软件跑「系统代理」模式(非 TUN)时,浏览器 / Electron
 * `net.fetch`(Chromium 栈)正常,而 main 里的裸 `fetch` / `new WebSocket()` 是直连 ——
 * 高墙网络下换 token 被上游按来源拒(实测 platform.claude.com 换 token 回 403)、
 * 订阅直连上游连不上、provider 连通性探测误报不通。
 *
 * 本模块把仓库里已有的出站代理能力(`outbound-proxy-resolver` 的两层解析 +
 * `@cindy/anthropic-compat-proxy` 的 HTTP CONNECT 隧道与 SOCKS5 agent)接到这两个栈上:
 *
 *   - `outboundFetch`:签名与 `globalThis.fetch` 对齐的替换品,per-request 现取代理。
 *     现存 `fetchImpl: typeof fetch` / `fetchFn: typeof fetch` 注入点可直接换默认值。
 *   - `resolveOutboundDispatcher`:给已有自建 dispatcher 的调用点(voice-input 的
 *     keepalive 池)用 —— 有代理时返回代理 dispatcher,直连时返回调用方的 fallback。
 *   - `createOutboundHttpAgent`:给 `ws` 用(`new WebSocket(url, { agent })`)。
 *
 * 语义与 loopback proxy host 那两处完全一致:loopback 上游恒直连;代理解析失败
 * fail-open 走直连(不断链路);代理地址只以脱敏形态进日志。
 *
 * 已知限制:
 *   - **需要认证的系统代理不支持**。`session.resolveProxy` 只给 host:port,凭证由
 *     Chromium 自己的 proxy-auth 挑战(`app.on('login')`)补,Node/undici 这条路没有对接
 *     口 —— 这类环境下会收到 407。命中 407 会明确告警并提示改用带 userinfo 的
 *     `HTTPS_PROXY`(env 层支持 Proxy-Authorization)。
 *   - 直连路径不经 undici(走 `globalThis.fetch`,以保证无代理时行为与改造前逐字节
 *     一致),所以「直连 URL 重定向到需要代理的 host」不会中途升级成走代理 —— 与改造前
 *     一致,不是本模块引入。
 */

import type { Agent as NodeHttpAgent } from 'node:http';

import {
  Agent as UndiciAgent,
  Dispatcher,
  ProxyAgent,
  buildConnector,
  fetch as undiciFetch,
} from 'undici';

import {
  isLoopbackHostname,
  parseOutboundProxyUrl,
  redactProxyUrlForLog,
  socks5Connect,
  Socks5HttpAgent,
  Socks5HttpsAgent,
  stripIpv6Brackets,
  TunnelingHttpsAgent,
  type OutboundProxyTarget,
} from '@cindy/anthropic-compat-proxy';

import { createMakerLogger } from './logger-adapter.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';

const log = createMakerLogger('outbound-fetch');

/**
 * Happy Eyeballs 单地址握手超时。与 `main/index.ts` 的进程级默认值、
 * `voice-input/refinerHttpDispatcher.ts` 的 per-pool 值同为 2500ms:代理软件背后可能
 * 现拨远端节点,Node 默认的 250ms 会把合法握手全掐掉,只剩一个裸 'fetch failed'。
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 2500;

/** 正常场景同一时刻只有一个系统代理;上限只防 PAC 按 host 给不同出口时无限累积。 */
const DISPATCHER_POOL_MAX_ENTRIES = 8;

/**
 * 被逐出的 dispatcher 延迟这么久才 close。逐出的实例可能刚被某个调用方取走、还没
 * 把请求交给 undici(`resolveOutboundDispatcher` 返回 → 调用方 fetch 之间有个窗口),
 * 立刻 close 会让那一发请求撞上「dispatcher 已关闭」。宽限期内新请求照常发,过后
 * 再优雅关闭空闲连接(close 本身会等已入队请求跑完)。
 */
const EVICTED_DISPATCHER_CLOSE_GRACE_MS = 60_000;

/** routing wrapper 只做派发、不持有连接,逐出即丢,无需 close;上限只防无限增长。 */
const ROUTING_POOL_MAX_ENTRIES = 64;

/** 告警去重集合的上限 —— 满了整体清空(下一轮重新记一次,不会静默丢告警)。 */
const WARNED_ORIGINS_MAX_ENTRIES = 256;

/**
 * 同步可读的「该 origin 当前该走什么」快照。用途只有一个:undici 内部跟随重定向时
 * 会拿同一个 dispatcher 去打新 origin,而 dispatch() 是同步 API,来不及做一次
 * `session.resolveProxy` 往返 —— 快照命中就能按新 origin 正确选出口。TTL 与
 * outbound-proxy-resolver 的系统代理缓存同为 30s。
 */
const PROXY_DECISION_TTL_MS = 30 * 1000;

export interface ResolveOutboundDispatcherOptions {
  /** 直连(或代理不可用)时返回的 dispatcher —— 调用方已有的连接池。 */
  fallback?: Dispatcher;
  /** 代理 dispatcher 的连接池调优(keepAlive / connections 等),参与缓存 key。 */
  agentOptions?: UndiciAgent.Options;
  /**
   * 调用方的取消信号。选路发生在请求出发之前,不传的话它就落在调用方的超时预算之外
   * (见 PROXY_RESOLVE_TIMEOUT_MS 的注释);传了则 abort 时立刻抛,与 fetch 语义一致。
   */
  signal?: AbortSignal;
}

const dispatcherPool = new Map<string, Dispatcher>();
const routingPool = new Map<string, Dispatcher>();
// 每个 origin 上次告警过的原因;不支持的组合只记一次,不在热路径上刷日志。
const warnedOrigins = new Set<string>();
const proxyDecisionCache = new Map<string, { raw: string | null; expiresAt: number }>();
let directAgent: UndiciAgent | null = null;

/** 重定向落到 loopback / 已知直连 origin 时用的直连池(与代理池同握手调优)。 */
function getDirectAgent(): UndiciAgent {
  directAgent ??= new UndiciAgent({
    connect: { autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS },
  });
  return directAgent;
}

function upstreamProtocol(url: URL): 'http:' | 'https:' {
  // ws/wss 在代理层与 http/https 同构(wss 经 CONNECT 隧道后做 TLS)。
  if (url.protocol === 'wss:' || url.protocol === 'https:') return 'https:';
  return 'http:';
}

function defaultPort(protocol: 'http:' | 'https:'): number {
  return protocol === 'https:' ? 443 : 80;
}

/**
 * 解析上游 URL。解不出(调用方给了相对路径等)返回 null —— 由调用方按直连处理,
 * 真正的报错留给底层 fetch,本模块不制造新的失败模式。
 */
function parseUpstream(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** 上游 origin 串(协议 + host)—— 日志与 loopback 判定用。 */
function originOf(upstream: URL): string {
  return `${upstreamProtocol(upstream)}//${upstream.host}`;
}

/**
 * 送给 resolver / 两级缓存的 key:origin + path,**不带 query 与 fragment**。
 *
 * 带 path 是因为 PAC 的 `FindProxyForURL(url, host)` 允许按路径判定 —— 只送 origin 会
 * 让同一 origin 上所有路径共用 `/` 的结论,配置了「某内部路径直连、其余走代理」的用户
 * 会被判错(review 2026-07-27 P1)。不带 query 是纪律:query 常带令牌等敏感参数,而它
 * 会进入 resolver 的缓存 key;按 path 已经覆盖了现实中的 PAC 写法。
 */
function resolveKeyOf(upstream: URL): string {
  return `${originOf(upstream)}${upstream.pathname}`;
}

/** 从 dispatch() 的 (origin, path) 拼出同一个 key —— 重定向选路要查同一份快照。 */
function resolveKeyFromParts(origin: string, path: string | undefined): string {
  const pathname = (path ?? '/').split('?')[0]?.split('#')[0] || '/';
  return `${origin}${pathname}`;
}

/**
 * 代理解析自身的超时。解析发生在请求真正出发之前,不受调用方 `signal` /
 * `AbortSignal.timeout` 约束 —— `session.resolveProxy` 若慢或不 settle,OAuth 的 30s、
 * 探测的 10s 这些既有上限就形同虚设(review 2026-07-27 P1)。超时按直连处理
 * (fail-open,与其它解析故障同口径),不把请求拖死在选路上。
 */
const PROXY_RESOLVE_TIMEOUT_MS = 2000;

function abortErrorOf(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * 带两道保险地取代理串:调用方 abort 立刻抛(与 fetch 的取消语义一致),解析自身
 * 超时则按直连处理。
 */
async function resolveRawProxy(
  resolveKey: string,
  origin: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) throw abortErrorOf(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race<string | null>([
      Promise.resolve(resolveDesktopOutboundProxy(resolveKey)).then((v) => v ?? null),
      new Promise<string | null>((resolve) => {
        timer = setTimeout(() => {
          warnOnce(origin, 'resolution-timed-out', { upstream: origin });
          resolve(null);
        }, PROXY_RESOLVE_TIMEOUT_MS);
        timer.unref?.();
      }),
      new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        onAbort = () => reject(abortErrorOf(signal));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 取当前生效的代理目标;直连 / 解析失败 / loopback 上游一律 null。 */
async function resolveProxyTarget(
  upstream: URL,
  signal?: AbortSignal,
): Promise<OutboundProxyTarget | null> {
  if (isLoopbackHostname(upstream.hostname)) return null;
  // resolver 拿 origin + path(PAC 可按路径判定);日志与告警只用 origin。
  const resolveKey = resolveKeyOf(upstream);
  const originUrl = originOf(upstream);
  let raw: string | null | undefined;
  try {
    raw = await resolveRawProxy(resolveKey, originUrl, signal);
  } catch (err) {
    // 取消要如实向上抛(否则调用方的 abort 变成静默直连请求)。
    if (signal?.aborted) throw err;
    // fail-open:代理解析故障不该让请求失败,退回直连(与 resolver 内部语义一致)。
    log.warn('outbound proxy resolution failed — using direct connection', {
      upstream: originUrl,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  rememberProxyDecision(resolveKey, raw ?? null);
  if (!raw) return null;
  const target = parseOutboundProxyUrl(raw);
  if (!target) {
    warnOnce(originUrl, 'unsupported-proxy-scheme', {
      upstream: originUrl,
      proxy: redactProxyUrlForLog(raw),
    });
    return null;
  }
  return target;
}

/** key 是 resolveKeyOf() 给的「origin + path」,不是单纯 origin —— per-path PAC 靠它。 */
function rememberProxyDecision(resolveKey: string, raw: string | null): void {
  if (proxyDecisionCache.size >= ROUTING_POOL_MAX_ENTRIES) {
    // 与 routing wrapper 同量级即够(快照只服务重定向选路);满了整体重建,不做 LRU。
    proxyDecisionCache.clear();
  }
  proxyDecisionCache.set(resolveKey, { raw, expiresAt: Date.now() + PROXY_DECISION_TTL_MS });
}

/**
 * 同步取某个解析 key(**origin + path**,不是单纯 origin)的代理决策:
 * `{ known: false }` = 快照里没有(调用方自行决定兜底),`{ known: true, target: null }`
 * = 直连,否则给出代理目标。不发起任何异步解析。
 */
function syncProxyDecision(resolveKey: string): { known: boolean; target: OutboundProxyTarget | null } {
  const hit = proxyDecisionCache.get(resolveKey);
  if (!hit || hit.expiresAt <= Date.now()) return { known: false, target: null };
  if (!hit.raw) return { known: true, target: null };
  return { known: true, target: parseOutboundProxyUrl(hit.raw) };
}

function warnOnce(origin: string, reason: string, fields: Record<string, unknown>): void {
  const key = `${origin}:${reason}`;
  if (warnedOrigins.has(key)) return;
  // 异常代理配置下 origin 可能持续变化;满了整体清空(下一轮重新记一次)而不是无限增长。
  if (warnedOrigins.size >= WARNED_ORIGINS_MAX_ENTRIES) warnedOrigins.clear();
  warnedOrigins.add(key);
  log.warn(`outbound proxy ${reason} — using direct connection`, fields);
}

/**
 * dispatcher 缓存 key。凭证参与(同地址不同凭证不能共享连接池);上游协议参与
 * (https 要在隧道上做 TLS,http 不做);调优参数参与(调用方各自的池语义不同)。
 * 用 JSON 数组而非拼接:字段本身可能含分隔符,拼接会让不同输入撞成同一 key。
 */
function dispatcherKey(
  proxy: OutboundProxyTarget,
  protocol: 'http:' | 'https:',
  agentOptions: UndiciAgent.Options | undefined,
): string {
  return JSON.stringify([
    proxy.kind,
    proxy.url,
    proxy.authHeader ?? '',
    proxy.username ?? '',
    proxy.password ?? '',
    protocol,
    agentOptions ? JSON.stringify(identifyFunctions(agentOptions)) : '',
  ]);
}

// 函数身份 → 稳定标识。函数在 JSON.stringify 里会被整个丢掉,直接 stringify
// agentOptions 会让「两个不同的自定义 connect / factory」塌成同一个 key,进而共享一个
// 用别的 connector 建出来的 dispatcher(review 2026-07-27)。WeakMap 不阻止回收。
const functionKeys = new WeakMap<object, string>();
let functionKeySeq = 0;

function functionKey(fn: object): string {
  let key = functionKeys.get(fn);
  if (!key) {
    functionKeySeq += 1;
    key = `fn#${functionKeySeq}`;
    functionKeys.set(fn, key);
  }
  return key;
}

/** 把 options 里的函数值换成稳定标识,其余原样(键顺序沿用调用方给的顺序)。 */
function identifyFunctions(value: unknown): unknown {
  if (typeof value === 'function') return functionKey(value as object);
  if (Array.isArray(value)) return value.map(identifyFunctions);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, identifyFunctions(v)]),
    );
  }
  return value;
}

function closeAfterGrace(dispatcher: Dispatcher): void {
  // 立刻 close 会打断「已取走但还没提交」的那一发请求(review 2026-07-27 P1);
  // 宽限期后再 close,timer unref 不拖住进程退出。
  const timer = setTimeout(() => {
    void dispatcher.close().catch(() => {
      /* 关闭空闲连接失败无所谓,交给 GC */
    });
  }, EVICTED_DISPATCHER_CLOSE_GRACE_MS);
  timer.unref?.();
}

function poolGet(key: string, create: () => Dispatcher): Dispatcher {
  const existing = dispatcherPool.get(key);
  if (existing) return existing;
  if (dispatcherPool.size >= DISPATCHER_POOL_MAX_ENTRIES) {
    const oldest = dispatcherPool.keys().next().value;
    if (oldest !== undefined) {
      const evicted = dispatcherPool.get(oldest);
      dispatcherPool.delete(oldest);
      if (evicted) closeAfterGrace(evicted);
    }
  }
  const created = create();
  dispatcherPool.set(key, created);
  return created;
}

function routingPoolGet(key: string, create: () => Dispatcher): Dispatcher {
  const existing = routingPool.get(key);
  if (existing) return existing;
  if (routingPool.size >= ROUTING_POOL_MAX_ENTRIES) {
    const oldest = routingPool.keys().next().value;
    // wrapper 不持有连接(底层池才有),逐出直接丢,不能 close —— 那会连带关掉共享池。
    if (oldest !== undefined) routingPool.delete(oldest);
  }
  const created = create();
  routingPool.set(key, created);
  return created;
}

/**
 * SOCKS5 的 undici connector:先经代理握手拿裸 socket,再把它交给 undici 原生
 * connector 做 TLS(`httpSocket` 选项)—— TLS 端到端,SNI / 证书校验沿用 undici 逻辑,
 * 代理只见密文。http 上游没有 TLS 这一步,握手好的 socket 直接就是那条 TCP 连接。
 */
function createSocks5Connector(
  proxy: OutboundProxyTarget,
  connectOptions: Record<string, unknown>,
): buildConnector.connector {
  // BuildOptions 的类型联合里 TcpNetConnectOpts 要求 port,但 connector 的 port 是
  // per-request 从 options 取的(建 connector 时给不了);undici 运行时只读我们传的这
  // 几个字段,断言收在这一行。
  const tlsConnector = buildConnector(connectOptions as buildConnector.BuildOptions);
  return (options, callback) => {
    const protocol = options.protocol === 'https:' ? 'https:' : 'http:';
    const port = Number(options.port) || defaultPort(protocol);
    socks5Connect(proxy, stripIpv6Brackets(options.hostname), port)
      .then((socket) => {
        if (protocol !== 'https:') {
          callback(null, socket);
          return;
        }
        tlsConnector({ ...options, httpSocket: socket }, callback);
      })
      .catch((err: unknown) => {
        callback(err instanceof Error ? err : new Error(String(err)), null);
      });
  };
}

/**
 * 合并握手配置:调用方给的 `agentOptions.connect` 优先,只在它没给某项时补默认。
 * 无条件覆盖会让调用方的调优失效(voice-input 允许用 env 调
 * autoSelectFamilyAttemptTimeout),而该字段又参与 dispatcherKey —— 那就白白多分一个
 * 语义相同的池(review 2026-07-27)。调用方传的是自定义 connector 函数时原样保留。
 *
 * @internal 导出仅供单测断言合并规则。
 */
export function resolveConnectOptions(
  agentOptions: UndiciAgent.Options | undefined,
): Record<string, unknown> | UndiciAgent.Options['connect'] {
  const callerConnect = agentOptions?.connect;
  if (typeof callerConnect === 'function') return callerConnect;
  return {
    autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS,
    ...(callerConnect && typeof callerConnect === 'object'
      ? (callerConnect as Record<string, unknown>)
      : {}),
  };
}

function createProxyDispatcher(
  proxy: OutboundProxyTarget,
  protocol: 'http:' | 'https:',
  agentOptions: UndiciAgent.Options | undefined,
): Dispatcher {
  log.debug('creating outbound proxy dispatcher', { proxy: proxy.url, protocol });
  const connect = resolveConnectOptions(agentOptions);
  if (proxy.kind === 'socks5') {
    // SOCKS5 隧道必须用我们自己的 connector(先握手再在裸 socket 上做 TLS),调用方若
    // 自带 connector 无法复用 —— 那时 TLS 段退回默认握手参数。
    const tlsOptions =
      typeof connect === 'function'
        ? { autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_TIMEOUT_MS }
        : ((connect ?? {}) as Record<string, unknown>);
    return new UndiciAgent({
      ...agentOptions,
      connect: createSocks5Connector(proxy, tlsOptions),
    });
  }
  return new ProxyAgent({
    ...agentOptions,
    uri: proxy.url,
    ...(proxy.authHeader ? { token: proxy.authHeader } : {}),
    connect,
  });
}

/**
 * 按**当前请求的 origin** 派发的 dispatcher 包装。
 *
 * 为什么需要:`fetch` 默认 `redirect: 'follow'`,undici 在内部跟随重定向时会一直用
 * 同一个 dispatcher。裸给代理 dispatcher 的话,一个走代理的 URL 302 到 loopback 或
 * 到 NO_PROXY 豁免的 host,后续跳仍会被塞进代理隧道 —— 既破坏 bypass 语义,也破坏
 * 本模块「loopback 恒直连」的承诺(review 2026-07-27 P1)。
 *
 * 包装后每一跳都按目标 origin 重新选出口:
 *   - 首跳 origin → 原代理池(命中率最高的情况,零额外开销)
 *   - loopback → 直连池(**同步可判**,无需解析,承诺因此在重定向后依然成立)
 *   - 其它 origin → 查同步快照:直连决策走直连池,代理决策走对应代理池
 *   - 快照没有(该 origin 从没解析过)→ 沿用首跳的代理,并后台补一次解析,让下次准确。
 *     这是 `dispatch()` 同步契约下的取舍:宁可多走一次代理,也不为了精确而阻塞热路径。
 *
 * 已知限制(与改造前一致,不是本 PR 引入):直连路径不经 undici(走 `globalThis.fetch`),
 * 所以「直连 URL 重定向到需要代理的 host」不会中途升级成走代理。
 *
 * 类体懒建(第一次真的要走代理时才求值 `extends Dispatcher`):模块加载期不碰 undici 的
 * 类,单测对 undici 做部分 mock 时不必为它额外补 `Dispatcher` 导出。
 */
interface OriginRoutingDispatcher extends Dispatcher {
  /** @internal 单测用:看某个目标 URL 会被路由到哪个底层 dispatcher。 */
  pickForUrlForTest(url: string): Dispatcher;
}

/** wrapper 的首跳出口描述 —— 存的是「怎么取」而不是 dispatcher 实例本身,见下方注释。 */
interface PrimaryRoute {
  /** 首跳的解析 key(origin + path),与快照 / resolver 同一维度。 */
  resolveKey: string;
  proxy: OutboundProxyTarget;
  protocol: 'http:' | 'https:';
}

type OriginRoutingDispatcherCtor = new (
  primary: PrimaryRoute,
  agentOptions: UndiciAgent.Options | undefined,
) => OriginRoutingDispatcher;

let _routingDispatcherCtor: OriginRoutingDispatcherCtor | null = null;

function routingDispatcherCtor(): OriginRoutingDispatcherCtor {
  if (_routingDispatcherCtor) return _routingDispatcherCtor;
  _routingDispatcherCtor = class extends Dispatcher {
    constructor(
      private readonly primary: PrimaryRoute,
      private readonly agentOptions: UndiciAgent.Options | undefined,
    ) {
      super();
    }

    override dispatch(
      options: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler,
    ): boolean {
      return this.pick(options).dispatch(options, handler);
    }

    /** close/destroy 恒不向下传:底层是共享池,包装只是一层路由。 */
    override async close(): Promise<void> {}
    override async destroy(): Promise<void> {}

    pickForUrlForTest(url: string): Dispatcher {
      // 与 undici 的 dispatch 一致:origin 与 path 分开给。
      const parsed = parseUpstream(url);
      return this.pick({
        origin: parsed ? originOf(parsed) : url,
        path: parsed ? `${parsed.pathname}${parsed.search}` : '/',
        method: 'GET',
      });
    }

    private pick(options: Dispatcher.DispatchOptions): Dispatcher {
      const target = this.targetUrl(options);
      if (!target) return this.forProxy(this.primary.proxy, this.primary.protocol);
      const origin = originOf(target);
      if (isLoopbackHostname(target.hostname)) return getDirectAgent();
      // 快照与 resolver 同 key(origin + path):PAC 可按路径判定,只比 origin 会串味。
      const key = resolveKeyFromParts(origin, options.path);
      if (key === this.primary.resolveKey) {
        return this.forProxy(this.primary.proxy, this.primary.protocol);
      }
      const decision = syncProxyDecision(key);
      if (!decision.known) {
        // 后台补解析(它会写进快照),本跳沿用首跳出口。必须拿**带 path 的** URL 去解析
        // —— 用只有 origin 的 target 会把结论写到 `origin + /` 上,而这里查的是
        // `origin + path`,那就永远 miss、永远沿用首跳代理(review 2026-07-28 P1)。
        // key 本身就是「origin + path」,直接拿它当 URL 解,写入与查询保证同键。
        void resolveProxyTarget(parseUpstream(key) ?? target).catch(() => undefined);
        return this.forProxy(this.primary.proxy, this.primary.protocol);
      }
      if (!decision.target) return getDirectAgent();
      return this.forProxy(decision.target, upstreamProtocol(target));
    }

    /**
     * 每次都从底层池现取(必要时重建),**不缓存 dispatcher 实例**:底层池有上限,
     * 逐出后 60s 会 close 掉那个实例。若 wrapper 攥着旧引用,逐出之后就会把请求发给
     * 一个已关闭的 dispatcher(review 2026-07-27 P1)。现取的代价只是一次 Map 查询。
     */
    private forProxy(proxy: OutboundProxyTarget, protocol: 'http:' | 'https:'): Dispatcher {
      const key = dispatcherKey(proxy, protocol, this.agentOptions);
      return poolGet(key, () => createProxyDispatcher(proxy, protocol, this.agentOptions));
    }

    private targetUrl(options: Dispatcher.DispatchOptions): URL | null {
      const raw = options.origin;
      if (raw instanceof URL) return raw;
      if (typeof raw === 'string') return parseUpstream(raw);
      return null;
    }
  } as unknown as OriginRoutingDispatcherCtor;
  return _routingDispatcherCtor;
}

/**
 * 取该上游当前该用的 undici dispatcher。直连 → `opts.fallback`(默认 undefined,
 * 即 undici 全局 dispatcher,行为与改造前逐字节一致)。
 */
export async function resolveOutboundDispatcher(
  url: string,
  opts: ResolveOutboundDispatcherOptions = {},
): Promise<Dispatcher | undefined> {
  const upstream = parseUpstream(url);
  if (!upstream) return opts.fallback;
  const proxy = await resolveProxyTarget(upstream, opts.signal);
  if (!proxy) return opts.fallback;
  const protocol = upstreamProtocol(upstream);
  const resolveKey = resolveKeyOf(upstream);
  const key = dispatcherKey(proxy, protocol, opts.agentOptions);
  // 先把底层池建起来(首跳大概率立刻要用),wrapper 里仍按 key 现取,所以底层被逐出
  // 重建也不会留下 stale 引用。
  poolGet(key, () => createProxyDispatcher(proxy, protocol, opts.agentOptions));
  // 包装按 (底层 key, 首跳解析 key) 缓存:同一上游反复请求拿到同一个实例;
  // 底层连接池仍跨 origin 共享(wrapper 本身不持有连接)。
  const Routing = routingDispatcherCtor();
  return routingPoolGet(
    `${key}|${resolveKey}`,
    () => new Routing({ resolveKey, proxy, protocol }, opts.agentOptions),
  );
}

/**
 * `globalThis.fetch` 的代理感知替换品:所有 `typeof fetch` 注入点可直接换默认值。
 *
 * 直连时**原样调用 `globalThis.fetch`** —— 与改造前逐字节一致(Node 内置的也是
 * undici,`redirect: 'manual'` 同样如实回 3xx + Location,插件 network 槽的逐跳白名单
 * 校验照旧;宿主与单测对全局 fetch 的替换也照旧生效)。只有代理生效时才切到 npm
 * undici 的 fetch —— 那是唯一能挂 dispatcher 的入口。类型断言收口在这一处。
 */
export const outboundFetch = (async (
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
) => {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string }).url ?? '');
  const signal = signalOf(input, init);
  const dispatcher = await resolveOutboundDispatcher(target, { signal });
  if (!dispatcher) return globalThis.fetch(input, init);
  const request = await normalizeForUndici(input, init);
  if (request.init.redirect !== 'follow') {
    // 调用方要 manual / error 语义(插件 network 槽靠 manual 逐跳守门),原样交给 undici。
    return undiciFetch(request.url as never, { ...request.init, dispatcher } as never);
  }
  return followRedirectsThroughProxy(request, dispatcher, signal);
}) as unknown as typeof globalThis.fetch;

function signalOf(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): AbortSignal | undefined {
  if (init && 'signal' in init && init.signal) return init.signal;
  if (typeof input === 'object' && input !== null && 'signal' in input) {
    return (input as { signal?: AbortSignal }).signal;
  }
  return undefined;
}

/** 与 fetch 规范一致的跳数上限。 */
const MAX_REDIRECT_HOPS = 20;

/** fetch 规范的 redirect status 集合 —— 只有这几个才跟随。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * 需要认证的系统代理:`session.resolveProxy` 只给 host:port,拿不到凭证 —— Chromium 自己
 * 靠 `app.on('login')` 那套挑战交互补,而 Node/undici 这条路没有对接口,结果是 407。
 *
 * 我们不能凭空拿到系统 keychain 里的代理凭证,所以这里做不到透明支持;能做的是**不静默**:
 * 命中 407 就明确告警,指出可用带凭证的 `HTTPS_PROXY`(env 层支持 userinfo → 会走
 * Proxy-Authorization)绕过。这条限制同时登记在模块头与 PR 描述里。
 */
function noteProxyAuthRequired(url: string, status: number): void {
  if (status !== 407) return;
  const upstream = parseUpstream(url);
  const origin = upstream ? originOf(upstream) : url;
  warnOnce(origin, 'requires-authentication', {
    upstream: origin,
    hint: 'system proxy demands credentials; set HTTPS_PROXY=http://user:pass@host:port',
  });
}

/**
 * 代理路径上**自己**跟随重定向,每一跳都重新解析该 origin 该走什么。
 *
 * 为什么不交给 undici 的 `redirect: 'follow'`:它内部跟随时会一直用同一个 dispatcher,
 * 而第一次访问某个重定向目标时我们的同步快照里通常没有它 —— 那一跳就会被塞进原来的
 * 代理隧道,PAC / NO_PROXY 判定形同虚设(review 2026-07-27 P1)。这里逐跳 `await` 解析,
 * 结论精确;两个 fetch 入口都走它,`OriginRoutingDispatcher` 只剩「调用方自带 dispatcher」
 * (voice-input 的 keepalive 池)那条路径的兜底。
 *
 * 跳转语义按 fetch 规范的子集:303、以及 301/302 上的非 GET/HEAD → 转 GET 并丢 body;
 * 307/308 原样重放(body 已是 Buffer,可重放);跨 origin 去掉凭证类头。
 */
async function followRedirectsThroughProxy(
  request: { url: string; init: Record<string, unknown> },
  initialDispatcher: Dispatcher,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let url = request.url;
  let method = String(request.init.method ?? 'GET');
  let body = request.init.body as Buffer | undefined;
  const headers = new Headers(request.init.headers as Array<[string, string]>);
  let dispatcher: Dispatcher | undefined = initialDispatcher;

  for (let hop = 0; ; hop += 1) {
    const res = (await undiciFetch(url as never, {
      method,
      headers: [...headers] as Array<[string, string]>,
      ...(body ? { body } : {}),
      redirect: 'manual',
      ...(signal ? { signal } : {}),
      ...(dispatcher ? { dispatcher } : {}),
    } as never)) as unknown as {
      status: number;
      headers: { get(name: string): string | null };
      body?: { cancel(): Promise<void> } | null;
    };
    noteProxyAuthRequired(url, res.status);
    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
    // 不是 fetch 定义的重定向状态(如 300 Multiple Choices、304 Not Modified),或没有
    // Location(无从跟随)→ 原样回给调用方。**不能**按「3xx 且有 Location」就跟随:那会
    // 让开代理时把 304 / 300 吞掉换成另一个响应,与直连路径行为不一致
    // (review 2026-07-28 P1)。
    if (!location) return res;
    if (hop >= MAX_REDIRECT_HOPS) {
      await res.body?.cancel().catch(() => undefined);
      throw new TypeError('outboundFetch: too many redirects');
    }
    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return res; // Location 非法:交回调用方按非 ok 处理,不自造异常
    }
    // fetch 规范的 method 改写只有两种情形:301/302 上的 **POST**,以及 303 上的
    // 非 GET/HEAD。其余(301 上的 PUT/PATCH、303 上的 HEAD、307/308 全部)保留原方法
    // 与 body(review 2026-07-28 P1:之前写宽了,PUT 会丢方法和 body、HEAD 会变 GET)。
    const rewriteToGet =
      ((res.status === 301 || res.status === 302) && method === 'POST') ||
      (res.status === 303 && method !== 'GET' && method !== 'HEAD');
    if (rewriteToGet) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    if (new URL(url).origin !== next.origin) {
      // 跨 origin 不重放凭证(与 github/gitlab client 的 fail-closed 纪律同口径)。
      headers.delete('authorization');
      headers.delete('cookie');
      headers.delete('proxy-authorization');
    }
    // 3xx 的 body 不会被消费,显式取消以归还连接。
    await res.body?.cancel().catch(() => undefined);
    url = next.href;
    dispatcher = await resolveOutboundDispatcher(url, { signal });
  }
}

/**
 * 把「全局 fetch 的入参」翻译成 npm undici 认得的形状。
 *
 * 为什么必须翻译:全局 `FormData` / `Blob` / `File` 来自 **Node 内置的** undici,而这里
 * 用的是 **npm 包** undici —— 它的 body 提取靠 `instanceof` 自己那套类,跨实现的实例
 * 认不出来,`FormData` 会被当普通对象序列化成 `[object FormData]`(review 2026-07-27 P1:
 * 语音转写与 GitLab 附件上传都用全局 FormData)。
 *
 * 做法:交给全局 `Request` 归一化(它同时负责补 multipart 的 content-type 与 boundary),
 * 再把 body 读成 Buffer 交给 undici。代价是流式上传会被缓冲成整块 —— 当前所有调用点
 * 上传的都是内存里已有的字节(音频、附件),没有真正的流式上传。
 */
async function normalizeForUndici(
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): Promise<{ url: string; init: Record<string, unknown> }> {
  const request = new Request(input as RequestInfo, init as RequestInit);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  return {
    url: request.url,
    init: {
      method: request.method,
      headers: [...request.headers] as Array<[string, string]>,
      ...(body ? { body } : {}),
      redirect: request.redirect,
      signal: request.signal,
    },
  };
}

/**
 * `undici` 自己的 fetch 签名版本 —— 调用点已经在用 `import { fetch as undiciFetch }`
 * 且消费 undici 的 Response(如 `response.body?.cancel()`)时用这个,避免为了换通道
 * 顺带改一圈类型。语义与 `outboundFetch` 完全一致。
 */
export const outboundUndiciFetch: typeof undiciFetch = async (input, init) => {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : ((input as { url?: string }).url ?? '');
  // signal 必须透传:选路在请求出发之前,不传就等于让调用方的取消晚生效(最多多等
  // 一次解析超时),与 outboundFetch 的语义不一致。
  const signal = signalOf(
    input as Parameters<typeof globalThis.fetch>[0],
    init as Parameters<typeof globalThis.fetch>[1],
  );
  const dispatcher = await resolveOutboundDispatcher(target, { signal });
  if (!dispatcher) return undiciFetch(input, init);
  const request = await normalizeForUndici(
    input as Parameters<typeof globalThis.fetch>[0],
    init as Parameters<typeof globalThis.fetch>[1],
  );
  if (request.init.redirect !== 'follow') {
    return undiciFetch(request.url, { ...request.init, dispatcher } as never);
  }
  // 与 outboundFetch 同一套逐跳跟随:让 undici 内部跟随会把重定向那一跳按首跳的
  // 代理判定发出去(review 2026-07-27 P1)。
  return (await followRedirectsThroughProxy(request, dispatcher, signal)) as Awaited<
    ReturnType<typeof undiciFetch>
  >;
};

/**
 * 给 node http 栈(主要是 `ws`:`new WebSocket(url, { agent })`)取代理 agent。
 * 直连 → undefined(调用方原样不传 agent,行为与改造前一致)。
 *
 * 明文 `ws://` 到非 loopback 主机 + HTTP 代理的组合不支持:HTTP 代理下的明文上游走
 * 绝对形式请求,而 WebSocket 的 upgrade 握手必须是隧道。实际用到的外网 WS 端点都是
 * `wss://`;真遇到就记一次告警并直连,不静默。
 */
export async function createOutboundHttpAgent(url: string): Promise<NodeHttpAgent | undefined> {
  const upstream = parseUpstream(url);
  if (!upstream) return undefined;
  const proxy = await resolveProxyTarget(upstream);
  if (!proxy) return undefined;
  const protocol = upstreamProtocol(upstream);
  if (proxy.kind === 'socks5') {
    return protocol === 'https:' ? new Socks5HttpsAgent(proxy) : new Socks5HttpAgent(proxy);
  }
  if (protocol !== 'https:') {
    warnOnce(`${protocol}//${upstream.host}`, 'plaintext-upstream-unsupported', {
      upstream: `${protocol}//${upstream.host}`,
      proxy: proxy.url,
    });
    return undefined;
  }
  return new TunnelingHttpsAgent(proxy);
}

/** @internal 单测用:清空 dispatcher 池与告警去重状态。 */
export function resetOutboundFetchStateForTest(): void {
  for (const dispatcher of dispatcherPool.values()) {
    void dispatcher.close().catch(() => {
      /* no-op */
    });
  }
  dispatcherPool.clear();
  routingPool.clear();
  proxyDecisionCache.clear();
  warnedOrigins.clear();
  // 直连池也要收:它是模块级单例,不重置会跨用例存活(状态不隔离 + 悬挂的空闲连接)。
  if (directAgent) {
    const agent = directAgent;
    directAgent = null;
    void agent.close().catch(() => {
      /* no-op */
    });
  }
}
