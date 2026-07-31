/**
 * 公开类型 —— 给 host 注入 transform 链 / logger 用。
 *
 * 设计要点:
 *   - 请求 transform 是数组,按顺序串联,任一返回 null 表示"我不动这条",继续下一个
 *     或者最终走字节透传(整条 JSON 全程不解析,延迟 0)
 *   - 响应不开 transform —— 流式 SSE 一旦 parse/改写就丧失低延迟,代价不值;
 *     只提供可选 observer 做只读 tee,默认关闭
 *   - logger 全可选,host 不传就静默(包本身永远不 console.log)
 */

import type { Buffer } from 'node:buffer';
import type { ServerResponse } from 'node:http';

import type { OutboundProxyResolver } from './outbound-proxy.js';

/**
 * 请求 transform 上下文。
 * - method/url/headers 是只读快照,transform 不应该尝试通过这些改写 outbound 请求
 *   (改 method/url 没意义,改 headers 通过专用 transform 接口未来再加)
 */
export interface RequestTransformCtx {
  /** Monotonic identifier shared with the eventual response observer for this request. */
  readonly reqId: number;
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * 本请求**最终**发往的上游 baseURL(routingTransform 的 per-request override 已生效,
   * 与 ResponseObserverCtx.upstreamBase 同构)。仅在请求 transform 链的 ctx 里出现;
   * routingTransform / localHandler 的 ctx 中为 undefined(路由尚未/无需解析)。
   * 供「按目标上游做兼容改写」的 transform 使用(如跨供应商时转换上游读不懂的历史项),
   * 避免 host 侧为判断路由去向而复刻整套路由逻辑。
   */
  readonly upstreamBase?: string;
}

/**
 * 请求 body transform。
 *
 * @returns
 *   - 新的 body 对象 → 代理用它替换原 body 转发上游
 *   - null            → 不改写,这一步跳过(还会继续跑后续 transform;全部跳过则字节透传)
 */
export type RequestTransform = (
  body: unknown,
  ctx: RequestTransformCtx,
) => unknown | null;

/**
 * 本地 handler —— 路由决策命中 `localHandler` 时,代理**不转发上游**,由 handler 直接消费
 * 请求并把响应写回 `res`(典型:协议翻译,如 Anthropic Messages ↔ OpenAI Responses)。
 *
 * 契约:
 *   - handler 全权负责响应(writeHead / write / end;SSE 直接流式写);
 *   - 抛错(或 reject)且尚未写响应头 → 代理回 502 fail-open;已写头 → destroy socket
 *     (与 forward 的上游错误语义一致);
 *   - `parsedBody` 是路由决策阶段已解析的 JSON(复用,不二次 parse);非 JSON 请求为 undefined;
 *   - handler 内的会话态(effort 等)由 host 的 routingTransform 在决策点闭包传入,
 *     引擎不引入任何会话概念。
 */
export type LocalRequestHandler = (args: {
  /** 原始请求 body 字节(transform 链之前;GET 等无 body 请求为空 Buffer)。 */
  rawBody: Buffer;
  /** 路由决策阶段解析出的 JSON body;非 JSON / 无 body 请求为 undefined。 */
  parsedBody: unknown;
  /** method / url / headers 只读快照(与 RoutingTransform 的 ctx 同源)。 */
  ctx: RequestTransformCtx;
  /** 客户端响应对象,handler 自行写回。 */
  res: ServerResponse;
}) => Promise<void>;

/**
 * 路由决策 —— per-request 决定转发到哪个上游 / 覆盖哪些 outbound header,或交给本地 handler。
 * 与 RequestTransform 职责分离:RequestTransform 改 body,RoutingTransform 只读、决定路由。
 */
export interface RoutingDecision {
  /** 覆盖本次请求的上游 URL(完整 `http(s)://host[:port][/basePath]`);省略 = 用默认 `opts.upstream`。 */
  upstreamOverride?: string;
  /**
   * 覆盖本次请求追加到上游 base path 后的路径；必须是以单个 `/` 开头的同源路径。
   * 典型用于兼容端点不是标准 `/responses` / `/v1/messages` 的供应商。
   */
  pathOverride?: string;
  /** 合并进 outbound headers 的字段(覆盖语义,小写 key);典型用于换 `authorization`。 */
  headerOverride?: Record<string, string>;
  /**
   * 转发前从 outbound headers 删除的字段(大小写不敏感匹配)。在 `headerOverride` 合并**之后**应用,
   * 所以「先 override 再 delete」会净删除该 header。`headerOverride` 只能 set,无法移除一个客户端
   * 已带上的 header —— 典型用途: 子进程对所有请求都挂了某个 header(如 OAuth 专用的
   * `anthropic-beta: oauth-2025-04-20`),但路由到不认这个 header 的上游(gateway / LiteLLM)时
   * 必须把它抹掉,否则上游可能 400。省略 = 不删任何 header(向后兼容)。
   */
  headerDelete?: string[];
  /**
   * 本地 handler(见 LocalRequestHandler)。与上面四个转发字段**互斥**:设了 handler 时其余
   * 字段忽略、不发生任何上游转发。省略 = 转发语义,与本字段引入前字节级一致。
   */
  localHandler?: LocalRequestHandler;
}

/**
 * 路由 transform —— 在 body transform 链跑完后、转发前调用一次。
 *
 * 入参 `body` 是**原始**请求体(transform 链改写前),这样路由判断可以基于上游看不到的
 * 原始字段(例:去前缀前的 `codex/` model id)。返回 `null` = 不 override,走默认上游 + 透传 headers。
 */
export type RoutingTransform = (
  body: unknown,
  ctx: RequestTransformCtx,
) => RoutingDecision | null | Promise<RoutingDecision | null>;

export interface ResponseObserverCtx {
  readonly reqId: number;
  readonly method: string;
  readonly url: string;
  readonly upstreamBase: string;
  readonly status: number;
  /**
   * 客户端(agent 子进程)发来的原始请求头,**未**经路由改写。
   * 反解会话归属(thread-id 等 agent 自带 header)用这个。
   */
  readonly requestHeaders: Readonly<Record<string, string>>;
  /**
   * 实际发往上游的请求头 —— 已应用 RoutingDecision 的 headerOverride 与 headerDelete。
   *
   * 凡是要判断「这次请求究竟用了哪把凭证」的观察器必须读它:供应商 OAuth 是路由期注入的,
   * requestHeaders 里的 authorization 仍是子进程自带的那把,拿它做等值关联必然对不上。
   *
   * 省略时按 requestHeaders 理解(没有路由改写 = 发出去的就是收到的)。
   */
  readonly outboundHeaders?: Readonly<Record<string, string>>;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly requestBody: Buffer;
}

export interface ResponseObserverSink {
  onData?: (chunk: Buffer) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

/**
 * 只读响应观察器。用于抽取低风险 metadata(如 provider service_tier),不得改写响应。
 * onData 和 client pipe 同时挂在 upstreamRes 上,实现必须保持轻量。
 */
export type ResponseObserver = (
  ctx: ResponseObserverCtx,
) => ResponseObserverSink | null | undefined | void;

/**
 * 一条 400 透明重试规则。
 *
 * forward() 命中上游 400 时,按顺序找第一条 `enabled() && matches(decodedErrBodyText)
 * && strip(body) !== null` 的规则,用其 strip 结果重发一次(canRetry=false,防循环)。
 * 多条规则并列(例: encrypted_content / empty_thinking),互不耦合;regex 互斥,
 * 命中顺序仅在两条都可能匹配同一错误体时才有意义(实际不会)。
 */
export interface RecoveryRule {
  /** 诊断用稳定 id,进日志(例 'encrypted_content' / 'empty_thinking')。 */
  id: string;
  /** gate: false 时该规则完全跳过(thinking 永远 true;encrypted 跟 silentEncryptedRetry 设置)。 */
  enabled: () => boolean;
  /** 对解压后的 400 错误体文本判定是否命中本规则。
   * 命名避开 `match`:与 String.prototype.match 同名会让 CodeQL 把动态文本误判为
   * 正则模式(js/regex-injection 误报)。 */
  matches: (decodedErrorBodyText: string) => boolean;
  /** 改写请求 body;返回 null = 没有可改的东西(本规则不适用,继续找下一条)。 */
  strip: (body: Buffer) => Buffer | null;
  /** 命中并成功 strip 后触发(用于 Layer-2 markActive)。 */
  onRetry?: (threadId: string, model: string) => void;
  /** 取 threadId 的 header 候选名;省略用默认 DEFAULT_THREAD_ID_HEADERS。 */
  threadIdHeaders?: readonly string[];
}

/**
 * 极简 logger 接口 —— 跟 maker-core/Logger 形态对齐,host 可以直接传同一个 logger 适配器进来。
 * 全可选,不传任何方法就完全静默。
 */
export interface ProxyLogger {
  debug?: (msg: string, ctx?: Record<string, unknown>) => void;
  info?: (msg: string, ctx?: Record<string, unknown>) => void;
  warn?: (msg: string, ctx?: Record<string, unknown>) => void;
  error?: (msg: string, ctx?: Record<string, unknown>) => void;
  /**
   * 可选: 返回 true 表示当前 debug 级别会被实际落盘。proxy 用它来判断"是否值得为
   * debug 日志额外做事"(典型: tee 响应流到内存做完整 body dump,会占 256KB+/请求)。
   *
   * 不实现 → proxy 视为永远 true,会无脑做这些 debug 工作; 没人订阅 logger.debug
   * 时这部分开销纯白白浪费。强烈建议 host 实现,跟自家日志级别系统挂钩。
   */
  isDebugEnabled?: () => boolean;
}

/**
 * createAnthropicCompatProxy 入参。
 */
export interface ProxyOptions {
  /**
   * 真正的 Anthropic-compatible 上游 (网关 endpoint,登录随凭据下发)。
   * 函数形态 = 每个请求现取(宿主网关 endpoint 运行期可变,如登录后由服务端下发)。
   * null / undefined / 空串 = 默认上游当前不可用;显式 upstreamOverride / localHandler
   * 仍可正常工作,只有确实回落默认上游的请求会收到 503。
   */
  upstream: string | null | undefined | (() => string | null | undefined);
  /**
   * 请求 transform 链。不传时 = [stripToolUseProviderSpecificFields, stripNonAnthropicFields]
   *（默认行为）。
   * 传空数组 [] = 显式禁用所有 transform,纯透传。
   */
  transformRequest?: RequestTransform[];
  /**
   * 可选: per-request 路由 override(按 body.model 等选上游 / 换鉴权 header)。
   * 不传 = 永远走 `upstream` + 透传 headers(字节级行为与不传时完全一致,向后兼容)。
   */
  routingTransform?: RoutingTransform;
  /**
   * 可选响应观察器。默认关闭;开启后只能 tee 响应 chunk 做轻量 metadata 解析,
   * 不能改写响应或阻塞流式 pipe。
   */
  responseObserver?: ResponseObserver;
  /** 可选 logger,不传则静默 */
  logger?: ProxyLogger;
  /**
   * 上游 400 透明重试规则链。forward() 收到 400 时按顺序应用第一条命中的规则
   * (剥字段重发一次)。不传 / 空数组 = 不做任何透明重试(原样回 400)。
   * 典型: [createEncryptedContentRecoveryRule(...), createEmptyThinkingRecoveryRule(...)]。
   */
  recoveryRules?: RecoveryRule[];
  /** 监听 host,默认 127.0.0.1 (loopback only;不要改成 0.0.0.0) */
  host?: string;
  /**
   * 可选: 单条请求 body 上限(字节),超限回 413。默认 32MB(Claude Code 场景足够)。
   * Codex 走 Responses API 每轮全量重发 thread 历史,长会话(贴图 base64 / 加密
   * reasoning blob)会越过默认值,desktop 侧对 codex proxy 显式调大。
   * 注意: body 会整段缓冲进内存并 JSON.parse,该值同时就是单请求的内存 / 解析停顿预算。
   */
  maxRequestBodyBytes?: number;
  /**
   * 可选: 出站(上游方向)代理解析器。per-request 以最终上游 origin 现取:
   *   - `http://` 代理地址 = 经该代理转发(https 上游走 CONNECT 隧道、http 上游走绝对形式)
   *   - `socks5://`(含 socks5h / socks 别名)= 经 SOCKS5 隧道转发,两种上游都走隧道,
   *     且**上游域名交给代理端解析**(见 socks5.ts;本地 DNS 解不出上游时这是唯一出路)
   *   - 返回 null / 其它 scheme / 抛错 = 直连(fail-open)。loopback 上游不会被调用。
   * 宿主用它接系统代理(Electron resolveProxy)或代理环境变量
   * (createEnvOutboundProxyResolver)。不传 = 永远直连,与扩展前字节级一致。
   */
  resolveOutboundProxy?: OutboundProxyResolver;
  /**
   * 可选: WebSocket upgrade 的上游解析器。**不传 = 完全不接受 upgrade**
   * (Claude Code 侧的 proxy 就不传, 行为与扩展前逐字节一致)。
   *
   * 返回上游 URL → 接受 upgrade 并把两端 socket 对接到该上游;
   * 返回 **null → 回 426 Upgrade Required**, codex 据此优雅退回 HTTP transport
   * (426 是它唯一认作降级信号的状态码, 见 codex core/src/client.rs 的
   * `StatusCode::UPGRADE_REQUIRED` 分支; 其余错误一律 Err 抛出 = 用户吃报错)。
   * 而 codex 侧的降级是 **session 级**的(一个 turn 触发后同 session 后续 turn
   * 都走 HTTP), 所以一次 426 即稳定, 不会在两种传输之间抖动。
   *
   * 因此 null 的语义不是"拒绝服务", 而是"这个会话走 HTTP 更合适" —— 宿主可以据此
   * 把需要 body 级能力(recoveryRules / responseObserver)的会话导回 HTTP 路径,
   * 而不牺牲其余会话的 WS 长连接。
   *
   * **为什么不复用 routingTransform 来定 WS 上游**: 那条路按请求体里的 model 分流,
   * 而 upgrade 请求没有 body、也未必带 session/thread header, 会 fallback 到默认
   * 上游。开了 WS 的 provider 是明确且唯一的, 上游可以直接给定, 不需要推导。
   *
   * **WS 流量上以下能力一律不生效**(proxy 只做 socket 级转发, 不解析 WS 帧):
   * requestTransform / routingTransform 的 body 改写、recoveryRules、
   * responseObserver、maxRequestBodyBytes。放开某个 provider 的 WS 前必须确认
   * 它不依赖这些。
   */
  resolveWebSocketUpstream?: (ctx: {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }) => string | null;
  /**
   * 可选: debug 级别下是否 dump 入站请求 body(截断到 64KiB)。默认 false ——
   * dev 的日志级别默认 trace,若默认 dump,agent 高并发场景(code-review 扇出 +
   * 429 重试,2026-07-17 实测峰值 80 req/s)每请求几十 KiB 的 util.format /
   * JSON.stringify / 终端镜像全压在 main event loop 上,单日 agent 日志可达
   * 数百 MB,是整窗卡顿的确认放大器。需要诊断请求体时由宿主显式开启
   * (desktop 侧: 环境变量 XDT_PROXY_DUMP_REQUEST_BODY=1)。关闭时 inbound
   * 日志仍保留 reqId / method / upstream / url / bytes 元数据;错误响应 body
   * dump(16KiB,debug-gated)不受本开关影响,照旧保留。
   */
  debugDumpRequestBody?: boolean;
}

/**
 * createAnthropicCompatProxy 返回。
 */
export interface ProxyHandle {
  /** Claude Code 子进程应该用的 ANTHROPIC_BASE_URL,例: http://127.0.0.1:54321 */
  readonly url: string;
  /**
   * 强制断开指定 thread 当前已建立或正在握手的 WS 隧道，返回断开的隧道数。
   *
   * 用于宿主把已命中 HTTP-only recovery 的 Codex thread 从预热连接池中逐出；
   * 否则下一次请求会复用旧 WS，无法通过新的 upgrade 响应触发 transport fallback。
   */
  disconnectWebSocketsForThread?(threadId: string): number;
  /** 优雅关闭 —— close listener + 等待 in-flight 请求结束(2s 超时强关) */
  dispose(): Promise<void>;
}
