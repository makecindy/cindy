import type { Buffer } from "node:buffer";

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
 * 允许返回 Promise（视觉桥等需要出网调用的 transform 用）。引擎用 isPromiseLike
 * 统一 await：同步 transform 返回值原样通过，语义与 async 化前逐字节一致。
 *
 * @returns
 *   - 新的 body 对象 → 代理用它替换原 body 转发上游
 *   - null            → 不改写,这一步跳过(还会继续跑后续 transform;全部跳过则字节透传)
 */
export interface RequestTransform {
  (
    body: unknown,
    ctx: RequestTransformCtx,
  ): unknown | null | Promise<unknown | null>;
  /**
   * Error handling for this transform. The default keeps the historical fail-open behavior;
   * transforms that must not expose their unadapted input upstream can reject the request.
   */
  errorMode?: 'reject-request';
  /**
   * Optional cleanup for request-scoped state created while evaluating this transform.
   * Called once after a request that entered the transform chain finishes or closes.
   */
  onRequestSettled?: (requestId: number) => void;
}



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
  /** Classify a matched terminal rejection from the actual sent body, after safe retries. */
  unrecoverableCode?: (body: Buffer) => string | null;
  /** 命中并成功 strip 后触发(用于 Layer-2 markActive)。 */
  onRetry?: (threadId: string, model: string) => void;
  /** 取 threadId 的 header 候选名;省略用默认 DEFAULT_THREAD_ID_HEADERS。 */
  threadIdHeaders?: readonly string[];
  /**
   * 别的规则命中 400/422 时,是否把本规则的 strip 顺手叠上去。
   * 默认 true(encrypted / empty thinking 这类对任意上游都安全)。
   * 语义绑在特定上游的规则必须显式 false,否则会在 GPT 的
   * invalid_encrypted_content 重试里改写 OpenAI 历史。
   */
  applyOnUnmatchedRetry?: boolean;
  /**
   * 本规则作为主匹配时,是否还叠其它 extra strip。默认 true。
   * xAI ModelInput 必须 false:叠 encrypted-content 会删掉本来可回放的 reasoning blob。
   */
  allowExtraRules?: boolean;
}
