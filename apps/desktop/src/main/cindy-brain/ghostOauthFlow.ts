/**
 * ghostOauthFlow.ts — 意识 OAuth 凭证形态的主机侧授权引擎(通用声明式)。
 * ---------------------------------------------------------------------------
 * 设计定案(2026-07-13 与 Lizi):平台不预设 provider 名单——意识在 ghost.json
 * 里声明"去哪授权、要什么 scope"(authorizeUrl / tokenUrl / scopes / pkce),
 * clientId / clientSecret 由用户在意识设置页自填(input:'ghost' 只写通道同款
 * 纪律),装入确认框全量展示,用户知情自担。
 *
 * 本模块声明化的是**参数**,不是**代码**:授权流程本身(拉浏览器、loopback
 * 回调、state / PKCE 校验、code 换 token、refresh)永远是这份主机可信代码在
 * 跑,意识没有任何插手授权过程的机会——它连授权发生了都感知不到,只管发
 * cindy.fetch,令牌由 networkSlot 按 inject 声明现取现注。
 *
 * 流程形态:标准 authorization code + PKCE(S256,缺省开启)+ 本机 loopback
 * 回调(127.0.0.1 随机端口),与 @cindy/mcps 的 google / jira 两份 flow 同宗,
 * 抽参数化后不再绑定任何具体服务商。
 *
 * 安全纪律:
 * - access / refresh token、授权 code、client 凭证全程不进沙箱、不进日志
 *   (日志只记 host / 状态码 / 错误类别);
 * - authorizeUrl / tokenUrl 只认 https(装入校验是第一道,这里防御性重验);
 * - state 32 字节随机,回调不匹配整单作废;PKCE verifier 每单新生成;
 * - token 端点响应体 ≤256KB 截断防撑爆;
 * - 同一时刻仅允许一单在途(第二单进来先作废前一单——用户视角:重复点
 *   「连接账号」以最后一次为准)。
 *
 * 依赖注入(规则 14):openExternal / fetchImpl / logger 全部经 opts 传入,
 * 单测用假浏览器(直接 HTTP 打回调端口)+ 假 fetch 全覆盖,零 Electron。
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';

import { GHOST_OAUTH_RESERVED_AUTHORIZE_PARAMS, ghostNetworkHostMatches } from '../../shared/ghost.js';
import {
  buildOAuthReturnAction,
  getGhostOAuthResultCopy,
  OAUTH_RESULT_HTML_LANG,
  pickOAuthResultPageLang,
  renderOAuthResultPage,
  type GhostOAuthErrorKind,
  type OAuthResultPageLang,
} from '../oauthResultPage.js';

/** 授权流程 / 刷新共用的声明参数(源自 ghost.json 的 oauth 声明 + 用户自填 client 凭证)。 */
export interface GhostOauthClientConfig {
  /** 授权页地址(https;装入校验保证,这里防御性重验)。 */
  authorizeUrl: string;
  /** code / refresh token 交换端点(https)。 */
  tokenUrl: string;
  /** 申请的 scope 列表(空数组 = 不带 scope 参数,少数服务商用默认授权面)。 */
  scopes: readonly string[];
  /** scope 参数拼接分隔符(缺省空格 = OAuth 标准;Slack 这类逗号分隔的服务商传 ','). */
  scopeDelimiter?: string;
  /** 用户在意识设置页自填的 OAuth 客户端 ID。 */
  clientId: string;
  /** 可选:客户端 secret(桌面应用的 installed-app secret 本非机密,但仍按凭证纪律保管)。 */
  clientSecret?: string;
  /** PKCE(S256)开关,缺省 true;个别老服务商不支持时意识可显式声明关闭。 */
  pkce?: boolean;
  /**
   * 服务商特有的授权页附加参数,由意识声明(平台不预设 provider 语义):
   * Google 要 refresh token 需 `access_type=offline` + `prompt=consent`,
   * Atlassian 需 `audience=api.atlassian.com` + `prompt=consent`。
   * 协议保留参数(response_type / client_id / redirect_uri / state / scope /
   * code_challenge*)不可覆盖,撞名忽略。
   */
  extraAuthorizeParams?: Record<string, string>;
  /**
   * 可选:loopback 回调固定端口。Atlassian 这类服务商要求回调 URI 与应用
   * 注册值精确匹配(含端口),声明后 listen 钉死该端口(占用 = LISTEN_FAILED),
   * redirectUri 恒为 `http://127.0.0.1:<port>/callback`。缺省 = 随机端口
   * (Google 等允许任意 loopback 端口的服务商用缺省即可)。
   */
  redirectPort?: number;
  /**
   * 可选:XDT server token broker 的 provider slug(如 'jira')。声明后
   * code 换 token 与 refresh 不直连 tokenUrl,改经注入的 broker 调用器
   * (client secret 在服务端,不随包分发)。仅第一方官方意识可用,门控在
   * 运行时接线层。broker 模式兼容 PKCE(pkce 缺省开):verifier 经 broker
   * exchange 透传到服务端,由 provider 决定是否消费(feishu 要、jira/slack
   * 显式声明 pkce:false)。
   */
  tokenBroker?: string;
  /**
   * 可选:报给服务商的公网 https 回调地址(双地址模型,Slack 这类只收
   * https redirect 的服务商用)。声明后 authorize URL 与 code 交换里的
   * redirect_uri 都用它;浏览器实际落在 broker 的弹跳路由,由其 302 回本机
   * loopback(redirectPort + callbackPath)。缺省 = 单地址模型(loopback 即
   * redirect_uri)。仅 https(INVALID_CONFIG 拒)。
   */
  publicRedirectUri?: string;
  /**
   * 可选:loopback 监听的回调路径(broker 弹跳路由的 302 目标路径可能不是
   * 缺省的 /callback,如 slack 的 /slack-mcp/callback)。缺省 '/callback'。
   */
  callbackPath?: string;
  /**
   * 可选:该插件 manifest 的 network.hosts 白名单(装入确认框展示、用户同意
   * 过的域名面;含最左通配)。跨源 code 投递的允许来源 = authorizeUrl/tokenUrl
   * 的 origin + 本白名单命中的 https origin——xAI 这类「授权端点在 auth.x.ai、
   * consent 页从 accounts.x.ai 投递」的服务商,把投递域声明进 hosts 即可,
   * 不引入白名单之外的新信任面。
   */
  corsDeliveryHosts?: readonly string[];
}

/** extraAuthorizeParams 不允许顶掉的协议保留参数(清单校验拒装,这里防御性重验)。 */
const RESERVED_AUTHORIZE_PARAMS: ReadonlySet<string> = new Set(
  GHOST_OAUTH_RESERVED_AUTHORIZE_PARAMS,
);

// ── 跨源 code 投递(#810)─────────────────────────────────────────────────────
// xAI 新版 consent 页(accounts.x.ai)授权完成后不再 302 重定向回 loopback,而是由
// 页面 JS **跨源 fetch** 本回调地址投递 code;Chrome 对「公网 https 页面 → 127.0.0.1」
// 要求回调服务器应答 CORS preflight 并返回 Private Network Access 头,否则投递被浏览
// 器拦下,授权卡死在「复制 code」页。第一方 Grok 登录已修(grok-oauth-login.ts),这里
// 把同一机制移植进通用引擎。
//
// 通用引擎不能绑死某个服务商:允许来源从该插件声明的 authorizeUrl / tokenUrl 的
// origin 派生,并叠加 manifest network.hosts 白名单命中的 https origin(装入确认框
// 展示、用户同意过的域名面)——xAI 这类「授权端点在 auth.x.ai、consent 页从
// accounts.x.ai 投递」的服务商,把投递域声明进 hosts 即被覆盖;任意其它网站的
// 预检拿不到 CORS 头。真实性校验仍靠 state(+PKCE),与 302 回调同一套。

/** 跨源投递允许面(端点 origin 精确集合 + hosts 白名单模式)。 */
export interface GhostCallbackCorsAllowlist {
  origins: ReadonlySet<string>;
  hostPatterns: readonly string[];
}

/** 从插件声明的 OAuth 端点与 hosts 白名单派生跨源投递允许面(仅 https origin)。 */
export function ghostCallbackCorsAllowlist(
  config: Pick<GhostOauthClientConfig, 'authorizeUrl' | 'tokenUrl' | 'corsDeliveryHosts'>,
): GhostCallbackCorsAllowlist {
  const origins = new Set<string>();
  for (const raw of [config.authorizeUrl, config.tokenUrl]) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:') origins.add(url.origin);
    } catch {
      /* isSafeHttpsUrl 已在流程入口校验;这里防御性忽略 */
    }
  }
  return { origins, hostPatterns: config.corsDeliveryHosts ?? [] };
}

function isAllowedDeliveryOrigin(
  allowlist: GhostCallbackCorsAllowlist,
  origin: string,
): boolean {
  if (allowlist.origins.has(origin)) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const hostname = url.hostname.toLowerCase();
  return allowlist.hostPatterns.some((pattern) => ghostNetworkHostMatches(pattern, hostname));
}

/** origin 在允许面内时返回回调响应应附带的 CORS/PNA 头;否则为空(不放行)。 */
export function ghostCallbackCorsHeaders(
  allowlist: GhostCallbackCorsAllowlist,
  origin: string | undefined,
): Record<string, string> {
  if (!origin || !isAllowedDeliveryOrigin(allowlist, origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    Vary: 'Origin',
  };
}

/** 一次授权 / 刷新成功后的令牌包(交由 token manager 落库;本模块不持久化)。 */
export interface GhostOauthTokenBundle {
  accessToken: string;
  /** 服务商未发 refresh token 时为 null(到期只能重新授权)。 */
  refreshToken: string | null;
  /** access token 过期时刻(epoch ms,已扣 60s 安全余量);服务商未给 expires_in 时为 null。 */
  expiresAt: number | null;
  /** 服务商回填的实际授权 scope(可能少于申请面;未回填为 null)。 */
  grantedScope: string | null;
}

export type GhostOauthFlowError =
  | 'INVALID_CONFIG'
  | 'LISTEN_FAILED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CALLBACK_INVALID'
  | 'EXCHANGE_FAILED'
  | 'SERVICE_UNAVAILABLE'
  | 'NETWORK';

export type GhostOauthFlowResult =
  | { ok: true; bundle: GhostOauthTokenBundle }
  | { ok: false; error: GhostOauthFlowError; detail?: string };

export type GhostOauthRefreshResult =
  | { ok: true; bundle: GhostOauthTokenBundle }
  /**
   * invalidGrant = 服务商明确拒绝 refresh token(吊销 / 过期 / 用户改密),
   * 调用方应作废存量并引导重新授权;其余失败是瞬时性的,可原 token 重试。
   */
  | { ok: false; error: 'EXCHANGE_FAILED' | 'SERVICE_UNAVAILABLE' | 'NETWORK'; invalidGrant: boolean; detail?: string };

/** broker 一次交换 / 刷新的结果(形态对齐 GhostOauthRefreshResult,便于两条链路共用消费端)。 */
export type GhostOauthBrokerResult =
  | { ok: true; bundle: GhostOauthTokenBundle }
  | { ok: false; error: 'EXCHANGE_FAILED' | 'SERVICE_UNAVAILABLE' | 'NETWORK'; invalidGrant: boolean; detail?: string };

/**
 * XDT server token broker 调用器(tokenBroker 声明的执行通道)。实现方负责
 * 带登录 JWT 调 server 端 `/api/integrations/<slug>/oauth/exchange|refresh`
 * 并把响应映射成 bundle;本引擎不感知 HTTP 细节。
 */
export interface GhostOauthBrokerClient {
  exchange(
    slug: string,
    params: { code: string; redirectUri: string; codeVerifier?: string },
  ): Promise<GhostOauthBrokerResult>;
  refresh(slug: string, params: { refreshToken: string }): Promise<GhostOauthBrokerResult>;
}

export interface GhostOauthLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface StartGhostOauthFlowOptions {
  config: GhostOauthClientConfig;
  /** 拉起系统浏览器(生产注入 shell.openExternal)。 */
  openExternal(url: string): void | Promise<void>;
  /** 真实 HTTP(生产注入全局 fetch / net.fetch;单测注入假实现)。 */
  fetchImpl: typeof fetch;
  /** 整单超时,缺省 5 分钟。 */
  timeoutMs?: number;
  /** 授权成功页展示的品牌名(纯文案)。 */
  brandName?: string;
  /**
   * 可选:钉死端口(redirectPort)被外部进程占用时的回收器。listen 失败时
   * 引擎调它一次(生产注入 portReclaim:查占用 PID 并强杀,护栏见该模块),
   * 返回 true 表示值得重试 listen;未注入或回收失败按 LISTEN_FAILED 收场。
   * 自家上一单的僵尸监听不走这里——引擎在 listen 前就等它关完了。
   */
  reclaimPort?: (port: number) => Promise<boolean>;
  /** config.tokenBroker 有值时必须注入;未注入按 INVALID_CONFIG 拒。 */
  broker?: GhostOauthBrokerClient;
  logger?: GhostOauthLogger;
}

const FLOW_TIMEOUT_DEFAULT_MS = 5 * 60 * 1000;
/** token 端点响应体读取上限(与 networkSlot 交换引擎同档)。 */
const TOKEN_RESPONSE_MAX_BYTES = 256 * 1024;
/** access token 过期安全余量:提前视为过期,避免出网瞬间刚好失效(broker 调用器共用同一口径)。 */
export const EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;
const CALLBACK_PATH = '/callback';

/* ------------------------------------------------------------------------ */
/* 工具函数                                                                  */
/* ------------------------------------------------------------------------ */

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** https 且无内嵌用户名密码才放行(装入校验的防御性重验)。 */
function isSafeHttpsUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** 失败页文案键(免把中文散文当参数传, i18n 后统一走键)。 */
type OauthErrorKind = GhostOAuthErrorKind;

// 文案表已收敛到 oauthResultPage.ts 的 getGhostOAuthResultCopy(callback copy
// builder 生产/preview 合一,PR0b-callback),此处只保留占位符替换与页面组装。

function successHtml(brandName: string, lang: OAuthResultPageLang): string {
  const s = getGhostOAuthResultCopy(lang);
  // 替换器必须用函数形式: 字符串形式会把替换值里的 $&/$' 等当特殊模式展开
  // (用户可控的 detail 能借此弄坏/伪造文案);统一 renderer 最后只转义一次。
  const body = s.successBody.replace('{brand}', () => brandName);
  return renderOAuthResultPage({
    htmlLang: OAUTH_RESULT_HTML_LANG[lang],
    variant: 'success',
    title: s.successTitle,
    body,
    action: buildOAuthReturnAction(lang, 'ghost-oauth', brandName),
  });
}

function errorHtml(
  kind: OauthErrorKind,
  lang: OAuthResultPageLang,
  brandName: string,
  detail?: string,
): string {
  const s = getGhostOAuthResultCopy(lang);
  const body = s.errors[kind]
    .replace('{brand}', () => brandName)
    .replace('{detail}', () => detail ?? '');
  return renderOAuthResultPage({
    htmlLang: OAUTH_RESULT_HTML_LANG[lang],
    variant: 'error',
    title: s.errorTitle,
    body,
    action: buildOAuthReturnAction(lang, 'ghost-oauth', brandName),
  });
}

/** 有界读取响应体文本(超限直接判失败,不截断硬解析半截 JSON)。 */
async function readBoundedText(res: Response): Promise<string | null> {
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > TOKEN_RESPONSE_MAX_BYTES) return null;
  return text;
}

interface TokenEndpointResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
}

function toBundle(
  parsed: TokenEndpointResponse,
  previousRefreshToken?: string,
): GhostOauthTokenBundle | null {
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) return null;
  const expiresIn =
    typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)
      ? parsed.expires_in
      : null;
  // refresh token 轮换兼容(Atlassian 等):响应带新 refresh token 用新的,
  // 没带则沿用旧的(Google 刷新时不重发 refresh token)。
  const refreshToken =
    typeof parsed.refresh_token === 'string' && parsed.refresh_token.length > 0
      ? parsed.refresh_token
      : (previousRefreshToken ?? null);
  return {
    accessToken: parsed.access_token,
    refreshToken,
    expiresAt:
      expiresIn !== null
        ? Date.now() + Math.max(0, expiresIn * 1000 - EXPIRY_SAFETY_MARGIN_MS)
        : null,
    grantedScope: typeof parsed.scope === 'string' && parsed.scope.length > 0 ? parsed.scope : null,
  };
}

/** 从 token 端点错误响应里提取可展示摘要(不含凭证字节,截 200 字)。 */
function summarizeTokenError(status: number, text: string | null): string {
  let hint = '';
  if (text) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
      const code = typeof parsed.error === 'string' ? parsed.error : '';
      const desc = typeof parsed.error_description === 'string' ? parsed.error_description : '';
      hint = [code, desc].filter(Boolean).join(': ');
    } catch {
      hint = text;
    }
  }
  return `HTTP ${status}${hint ? ` ${hint.slice(0, 200)}` : ''}`;
}

function isInvalidGrant(text: string | null): boolean {
  if (!text) return false;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return parsed.error === 'invalid_grant';
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------ */
/* 授权流程                                                                  */
/* ------------------------------------------------------------------------ */

/** 在途单作废钩子:同一时刻只允许一单,后来者顶掉前一单(CANCELLED 收场)。 */
let activeAbort: (() => void) | null = null;

/**
 * 前一单**完整收尾**(含 loopback 监听真正关闭)的信号。close 是异步的,
 * 新单若只作废前一单就立刻 listen,钉死端口(redirectPort)场景会撞上自家
 * 还没关完的僵尸监听(EADDRINUSE 误报"端口被占用")——新单必须等它落定。
 */
let activeSettled: Promise<void> | null = null;

/** 外部主动取消当前在途授权(用户关设置页 / 换意识时调用;无在途时是空操作)。 */
export function cancelActiveGhostOauthFlow(): void {
  activeAbort?.();
}

/**
 * 跑一单完整的 authorization code(+PKCE)授权:
 * loopback 起监听 → 拼授权 URL 拉浏览器 → 等回调验 state → code 换 token。
 * 永不 reject,一切失败折叠成结构化 result。
 */
export async function startGhostOauthFlow(
  opts: StartGhostOauthFlowOptions,
): Promise<GhostOauthFlowResult> {
  const { config } = opts;

  if (!config.clientId) return { ok: false, error: 'INVALID_CONFIG', detail: 'clientId 未配置' };
  if (!isSafeHttpsUrl(config.authorizeUrl)) {
    return {
      ok: false,
      error: 'INVALID_CONFIG',
      detail: 'authorizeUrl 必须是 https 且不含内嵌凭证',
    };
  }
  if (!isSafeHttpsUrl(config.tokenUrl)) {
    return { ok: false, error: 'INVALID_CONFIG', detail: 'tokenUrl 必须是 https 且不含内嵌凭证' };
  }
  if (config.tokenBroker && !opts.broker) {
    return {
      ok: false,
      error: 'INVALID_CONFIG',
      detail: 'tokenBroker 已声明但主机未接线 broker 通道',
    };
  }
  if (config.publicRedirectUri !== undefined && !isSafeHttpsUrl(config.publicRedirectUri)) {
    return {
      ok: false,
      error: 'INVALID_CONFIG',
      detail: 'publicRedirectUri 必须是 https 且不含内嵌凭证',
    };
  }

  // 本单取消信号在任何 await 之前**同步**注册:外部 cancel 与后来单的顶替,
  // 在"排队等前单收尾 / listen / 端口回收"的整个窗口内都能命中本单。若注册
  // 晚到 listen 之后,窗口期进场的第三单会空转 abort 并排到本单后面,"重复
  // 点连接以最后一次为准"就被反转成"先来的赢"。
  let cancelledFlag = false;
  let signalCancelled: () => void = () => undefined;
  const cancelledPromise = new Promise<'cancelled'>((resolve) => {
    signalCancelled = () => {
      cancelledFlag = true;
      resolve('cancelled');
    };
  });
  activeAbort?.();
  activeAbort = signalCancelled;
  const cancellation: FlowCancellation = {
    cancelledPromise,
    isCancelled: () => cancelledFlag,
    myAbort: signalCancelled,
  };

  const prior = activeSettled;
  const run = (async (): Promise<GhostOauthFlowResult> => {
    // 等前一单**完整**收尾(含监听真正关闭)再起本单;排队期间被顶掉/取消
    // 就直接收场,不去抢端口。
    if (prior) await prior.catch(() => undefined);
    if (cancellation.isCancelled()) return { ok: false, error: 'CANCELLED' };
    return runGhostOauthFlow(opts, cancellation);
  })();
  // 同步挂链:第三单在本单尚未真正跑起来时进场,也严格排到本单之后——
  // 任意时刻至多一单持有监听,不存在两单并发抢同一钉死端口的窗口。
  activeSettled = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 本单取消上下文:wrapper 同步注册,授权单主体全程消费。 */
interface FlowCancellation {
  cancelledPromise: Promise<'cancelled'>;
  isCancelled(): boolean;
  /** 本单登记在模块级 activeAbort 上的钩子(finally 只清自己那单的)。 */
  myAbort: () => void;
}

/** 授权单主体(调用方已完成参数校验、取消注册与前一单收尾等待)。 */
async function runGhostOauthFlow(
  opts: StartGhostOauthFlowOptions,
  cancellation: FlowCancellation,
): Promise<GhostOauthFlowResult> {
  const { config, openExternal, fetchImpl, logger } = opts;
  const timeoutMs = opts.timeoutMs ?? FLOW_TIMEOUT_DEFAULT_MS;
  const brandName = opts.brandName ?? 'Cindy';

  // PKCE 缺省开;broker 模式同样支持(verifier 经 broker exchange 透传服务端),
  // 不吃 PKCE 的服务商(jira/slack)在声明里显式 pkce:false。
  const usePkce = config.pkce !== false;
  const state = base64Url(crypto.randomBytes(32));
  const verifier = usePkce ? base64Url(crypto.randomBytes(32)) : null;
  const challenge = verifier
    ? base64Url(crypto.createHash('sha256').update(verifier).digest())
    : null;

  // loopback 监听:缺省 127.0.0.1 随机端口;声明 redirectPort 时钉死该端口
  // (Atlassian 等回调精确匹配的服务商)。钉死端口被外部进程占用时,注入了
  // reclaimPort 就自动查杀占用者后重试;回收不动才 LISTEN_FAILED。
  const listenOnce = (): Promise<{ server: http.Server; port: number }> =>
    new Promise((resolve, reject) => {
      const srv = http.createServer();
      srv.on('error', reject);
      srv.listen(config.redirectPort ?? 0, '127.0.0.1', () => {
        const addr = srv.address();
        if (typeof addr === 'object' && addr && typeof addr.port === 'number') {
          resolve({ server: srv, port: addr.port });
        } else {
          srv.close();
          reject(new Error('loopback listen 返回了意外的地址形态'));
        }
      });
    });

  let listener: { server: http.Server; port: number } | null = null;
  let listenErr: unknown = null;
  try {
    listener = await listenOnce();
  } catch (err) {
    listenErr = err;
  }
  if (!listener && config.redirectPort && opts.reclaimPort) {
    logger?.warn('ghost oauth 钉死端口被占,尝试自动回收', { port: config.redirectPort });
    const reclaimed = await opts.reclaimPort(config.redirectPort).catch(() => false);
    if (reclaimed) {
      // 强杀后系统释放端口有微小延迟,短间隔重试几轮;本单已被顶掉/取消
      // 就不再抢端口。
      for (let attempt = 0; attempt < 5 && !listener && !cancellation.isCancelled(); attempt += 1) {
        try {
          listener = await listenOnce();
        } catch (err) {
          listenErr = err;
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  }
  if (!listener) {
    // 回收/重试窗口内被顶掉或取消的单按 CANCELLED 收场,不假报"端口被占用"
    // (新单可能马上就成功了,旧单的占用报错只会误导用户)。
    if (cancellation.isCancelled()) return { ok: false, error: 'CANCELLED' };
    logger?.warn('ghost oauth loopback 监听失败', {
      port: config.redirectPort ?? 0,
      err: String(listenErr),
    });
    // 文案按"是否真的尝试过自动回收"区分:第三方意识拿不到回收器,不能
    // 谎称"无法自动释放"。
    const detail = config.redirectPort
      ? opts.reclaimPort
        ? `本机端口 ${config.redirectPort} 被占用且无法自动释放,请手动关闭占用它的程序后重试`
        : `本机端口 ${config.redirectPort} 被其它程序占用,请关闭占用它的程序后重试`
      : String(listenErr);
    return { ok: false, error: 'LISTEN_FAILED', detail };
  }
  const { server, port } = listener;

  // 双地址模型:服务商侧 redirect_uri 用公网弹跳地址(声明了才有),浏览器
  // 由弹跳路由 302 回本机 loopback;单地址模型两者同一。code 交换(直连与
  // broker)带的 redirect_uri 必须与 authorize 时一致,恒用 redirectUri。
  const callbackPath = config.callbackPath ?? CALLBACK_PATH;
  const redirectUri = config.publicRedirectUri ?? `http://127.0.0.1:${port}${callbackPath}`;

  const authorizeUrl = new URL(config.authorizeUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', config.clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  if (config.scopes.length > 0) {
    authorizeUrl.searchParams.set('scope', config.scopes.join(config.scopeDelimiter ?? ' '));
  }
  if (challenge) {
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(config.extraAuthorizeParams ?? {})) {
    if (RESERVED_AUTHORIZE_PARAMS.has(key)) continue;
    authorizeUrl.searchParams.set(key, value);
  }

  // 回调等待(含超时与取消;三路竞速,谁先到听谁的)。
  const callback = new Promise<
    { kind: 'code'; code: string } | { kind: 'invalid'; detail: string }
  >((resolve) => {
    let settled = false;
    const finish = (
      v: { kind: 'code'; code: string } | { kind: 'invalid'; detail: string },
    ): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const corsAllowlist = ghostCallbackCorsAllowlist(config);
    server.on('request', (req, res) => {
      // 页面语言按浏览器 Accept-Language 就近命中(zh/ja/ko, 缺省英文)
      const lang = pickOAuthResultPageLang(
        typeof req.headers['accept-language'] === 'string'
          ? req.headers['accept-language']
          : undefined,
      );
      const cors = ghostCallbackCorsHeaders(
        corsAllowlist,
        typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      );
      // CORS/PNA preflight 必须 204 放行且不触碰登录流状态 —— 它没有 code 参数,
      // 落进下方缺 code 分支会直接终止整个登录(grok 侧 issue #491 的卡死教训)。
      // 非允许来源的预检同样 204 但不带 CORS 头,浏览器会拦下后续请求。
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/favicon.ico') {
          res.writeHead(204);
          res.end();
          return;
        }
        if (url.pathname !== callbackPath) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        // state 是回调真实性的唯一凭证,最先校验(与第一方 grok 监听器同口径):
        // 跨源 fetch 投递时代表旧登录尝试的 consent 页可能带旧 state 持续重试,
        // 这类请求一律 400 但**不结算**当前登录——陈旧 tab 的一次滞留重试不能
        // 杀死新发起的登录;error / code 参数只在 state 匹配时才有意义。
        const gotState = url.searchParams.get('state');
        if (gotState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
          res.end(errorHtml('invalid-callback', lang, brandName));
          return;
        }
        const err = url.searchParams.get('error');
        if (err) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
          res.end(errorHtml('provider-error', lang, brandName, err));
          finish({ kind: 'invalid', detail: `authorize error=${err}` });
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
          res.end(errorHtml('invalid-callback', lang, brandName));
          finish({ kind: 'invalid', detail: 'callback 缺 code 参数' });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
        res.end(successHtml(brandName, lang));
        finish({ kind: 'code', code });
      } catch (err2) {
        try {
          // 跨源 fetch 场景缺 CORS 头会让浏览器把 500 响应整体拦下,页面侧
          // 无从感知失败 —— 内部错误同样带头。
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', ...cors });
          res.end(errorHtml('internal', lang, brandName));
        } catch {
          /* 响应通道已坏,无事可做 */
        }
        finish({ kind: 'invalid', detail: `callback 处理异常 ${String(err2)}` });
      }
    });
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    // listen / 回收期间已被顶掉或取消:别再拉浏览器弹无主的授权页。
    if (cancellation.isCancelled()) return { ok: false, error: 'CANCELLED' };
    await openExternal(authorizeUrl.toString());
    logger?.info('ghost oauth 授权页已拉起', { host: authorizeUrl.hostname, port });

    const outcome = await Promise.race([callback, timeout, cancellation.cancelledPromise]);

    if (outcome === 'timeout') return { ok: false, error: 'TIMEOUT' };
    if (outcome === 'cancelled') return { ok: false, error: 'CANCELLED' };
    if (outcome.kind === 'invalid')
      return { ok: false, error: 'CALLBACK_INVALID', detail: outcome.detail };

    // broker 模式:code 交换交给 XDT server(secret 在服务端),不直连 tokenUrl。
    if (config.tokenBroker && opts.broker) {
      const brokered = await opts.broker.exchange(config.tokenBroker, {
        code: outcome.code,
        redirectUri,
        ...(verifier !== null ? { codeVerifier: verifier } : {}),
      });
      if (!brokered.ok) {
        logger?.warn('ghost oauth broker 交换失败', {
          slug: config.tokenBroker,
          error: brokered.error,
        });
        return { ok: false, error: brokered.error, detail: brokered.detail };
      }
      logger?.info('ghost oauth 授权完成(broker)', {
        slug: config.tokenBroker,
        hasRefreshToken: brokered.bundle.refreshToken !== null,
        // scope 名单非敏感(不含令牌字节)。飞书权限累积语义下,老用户(v1
        // 登录时代授过全量)首连时这里回显的就是应用已开通用户权限全集——
        // 用于校准 ghost.json 的 scopes 声明(声明不全会让新用户缺权限,
        // 声明未开通的会 20027 整页拒绝,两头都靠这个回显对账)。
        grantedScope: brokered.bundle.grantedScope,
      });
      return { ok: true, bundle: brokered.bundle };
    }

    // code 换 token。
    const form = new URLSearchParams();
    form.set('grant_type', 'authorization_code');
    form.set('code', outcome.code);
    form.set('redirect_uri', redirectUri);
    form.set('client_id', config.clientId);
    if (config.clientSecret) form.set('client_secret', config.clientSecret);
    if (verifier) form.set('code_verifier', verifier);

    let res: Response;
    try {
      res = await fetchImpl(config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
      });
    } catch (err) {
      logger?.warn('ghost oauth token 交换网络失败', {
        host: new URL(config.tokenUrl).hostname,
        err: String(err),
      });
      return { ok: false, error: 'NETWORK', detail: String(err) };
    }

    const text = await readBoundedText(res);
    if (!res.ok) {
      const detail = summarizeTokenError(res.status, text);
      logger?.warn('ghost oauth token 交换被拒', {
        host: new URL(config.tokenUrl).hostname,
        status: res.status,
      });
      return { ok: false, error: 'EXCHANGE_FAILED', detail };
    }
    let parsed: TokenEndpointResponse;
    try {
      parsed = JSON.parse(text ?? '') as TokenEndpointResponse;
    } catch {
      return { ok: false, error: 'EXCHANGE_FAILED', detail: 'token 端点响应不是合法 JSON' };
    }
    const bundle = toBundle(parsed);
    if (!bundle)
      return { ok: false, error: 'EXCHANGE_FAILED', detail: 'token 端点响应缺少 access_token' };
    logger?.info('ghost oauth 授权完成', {
      host: new URL(config.tokenUrl).hostname,
      hasRefreshToken: bundle.refreshToken !== null,
    });
    return { ok: true, bundle };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    // 只清自己那单的取消钩子:单 A 被单 B 顶掉后,A 的 finally 晚到,不能把
    // B 刚注册的 activeAbort 抹成 null(否则 B 变成"取消不掉的孤儿单")。
    if (activeAbort === cancellation.myAbort) activeAbort = null;
    // 掐掉浏览器的 keep-alive 连接并等监听**真正**关闭:下一单靠 activeSettled
    // 等到这里完成才 listen,钉死端口不会被自家上一单的余温占住。
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/* ------------------------------------------------------------------------ */
/* 刷新                                                                      */
/* ------------------------------------------------------------------------ */

export interface RefreshGhostOauthTokenOptions {
  config: GhostOauthClientConfig;
  refreshToken: string;
  fetchImpl: typeof fetch;
  /** config.tokenBroker 有值时必须注入;未注入按 EXCHANGE_FAILED 拒(非 invalidGrant,不作废存量)。 */
  broker?: GhostOauthBrokerClient;
  logger?: GhostOauthLogger;
}

/**
 * refresh_token grant 换新 access token。响应若带新 refresh token(轮换型
 * 服务商如 Atlassian)一并回传,调用方必须覆盖落库,否则下一次刷新用旧
 * token 会 invalid_grant。
 */
export async function refreshGhostOauthToken(
  opts: RefreshGhostOauthTokenOptions,
): Promise<GhostOauthRefreshResult> {
  const { config, refreshToken, fetchImpl, logger } = opts;

  // broker 模式:refresh 同样经 XDT server;invalidGrant 原样透传给 markExpired 链路。
  if (config.tokenBroker) {
    if (!opts.broker) {
      return {
        ok: false,
        error: 'EXCHANGE_FAILED',
        invalidGrant: false,
        detail: 'tokenBroker 已声明但主机未接线 broker 通道',
      };
    }
    const brokered = await opts.broker.refresh(config.tokenBroker, { refreshToken });
    if (!brokered.ok) {
      logger?.warn('ghost oauth broker 刷新失败', {
        slug: config.tokenBroker,
        error: brokered.error,
        invalidGrant: brokered.invalidGrant,
      });
      return brokered;
    }
    // broker 未回新 refresh token 时沿用旧的(与直连 toBundle 的轮换语义对齐)。
    const bundle =
      brokered.bundle.refreshToken !== null
        ? brokered.bundle
        : { ...brokered.bundle, refreshToken };
    return { ok: true, bundle };
  }

  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);
  form.set('client_id', config.clientId);
  if (config.clientSecret) form.set('client_secret', config.clientSecret);

  let res: Response;
  try {
    res = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    });
  } catch (err) {
    return { ok: false, error: 'NETWORK', invalidGrant: false, detail: String(err) };
  }

  const text = await readBoundedText(res);
  if (!res.ok) {
    const invalidGrant = isInvalidGrant(text);
    logger?.warn('ghost oauth 刷新被拒', {
      host: new URL(config.tokenUrl).hostname,
      status: res.status,
      invalidGrant,
    });
    return {
      ok: false,
      error: 'EXCHANGE_FAILED',
      invalidGrant,
      detail: summarizeTokenError(res.status, text),
    };
  }
  let parsed: TokenEndpointResponse;
  try {
    parsed = JSON.parse(text ?? '') as TokenEndpointResponse;
  } catch {
    return {
      ok: false,
      error: 'EXCHANGE_FAILED',
      invalidGrant: false,
      detail: 'token 端点响应不是合法 JSON',
    };
  }
  const bundle = toBundle(parsed, refreshToken);
  if (!bundle) {
    return {
      ok: false,
      error: 'EXCHANGE_FAILED',
      invalidGrant: false,
      detail: 'token 端点响应缺少 access_token',
    };
  }
  return { ok: true, bundle };
}

/* ------------------------------------------------------------------------ */
/* 声明式身份拉取(设置页"已连接为 xxx"的账号标签)                            */
/* ------------------------------------------------------------------------ */

export interface FetchGhostOauthIdentityOptions {
  /** 身份端点(https;意识 oauth 声明的可选 identity.url,如 Google userinfo / Atlassian me)。 */
  url: string;
  /** 标签在响应 JSON 里的点分路径(如 "email" / "name";与 exchange.tokenPath 同规则,不支持数组下标)。 */
  labelPath: string;
  /**
   * 可选:展示名模板(`{点分路径}` 占位符,如 Slack 的 "{team} · {user}")。
   * 与 labelPath 取同一份响应;任一占位符取不到字符串值时整体降级 null。
   */
  displayTemplate?: string;
  /**
   * 可选:头像 URL 的点分路径(如飞书 user_info 的 "data.avatar_thumb")。
   * 取到的值必须是 https 地址,否则降级 null;这里只取地址不下载——下载在
   * fetchGhostOauthAvatar(调用方按需跑,失败不阻断)。
   */
  avatarPath?: string;
  accessToken: string;
  fetchImpl: typeof fetch;
}

/**
 * 身份端点一次拉取的产物:label = 稳定身份键(合并判定),display = 人类可读
 * 展示名,avatarUrl = 头像地址(声明了 avatarPath 且值是合法 https 才有)。
 */
export interface GhostOauthIdentityInfo {
  label: string | null;
  display: string | null;
  avatarUrl: string | null;
}

const IDENTITY_VALUE_MAX_CHARS = 200;
/** displayTemplate 占位符形状(与 shared/ghost.ts 校验同一形态;这里防御性重验)。 */
const IDENTITY_TEMPLATE_PLACEHOLDER_RE = /\{([^{}]*)\}/g;

/** 响应 JSON 按点分路径取字符串值(非字符串 / 空 / 超长一律 null)。 */
function extractIdentityValue(parsed: unknown, path: string): string | null {
  let cursor: unknown = parsed;
  for (const seg of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return typeof cursor === 'string' &&
    cursor.length > 0 &&
    cursor.length <= IDENTITY_VALUE_MAX_CHARS
    ? cursor
    : null;
}

/**
 * 授权成功后拉一次身份端点:labelPath 取稳定身份标签(同身份合并判定键),
 * displayTemplate(声明了才有)渲染人类可读展示名。纯展示/判定用途,任何
 * 失败不阻断授权(对应产物降级 null,设置页回落显示"账号 N")。
 */
export async function fetchGhostOauthIdentity(
  opts: FetchGhostOauthIdentityOptions,
): Promise<GhostOauthIdentityInfo> {
  const none: GhostOauthIdentityInfo = { label: null, display: null, avatarUrl: null };
  if (!isSafeHttpsUrl(opts.url)) return none;
  let res: Response;
  try {
    res = await opts.fetchImpl(opts.url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: 'application/json' },
    });
  } catch {
    return none;
  }
  if (!res.ok) return none;
  const text = await readBoundedText(res);
  if (text === null) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none;
  }

  const label = extractIdentityValue(parsed, opts.labelPath);

  let display: string | null = null;
  if (opts.displayTemplate) {
    let broken = false;
    display = opts.displayTemplate.replace(IDENTITY_TEMPLATE_PLACEHOLDER_RE, (_m, path: string) => {
      const value = extractIdentityValue(parsed, path);
      if (value === null) {
        broken = true;
        return '';
      }
      return value;
    });
    if (broken || display.length === 0 || display.length > IDENTITY_VALUE_MAX_CHARS) display = null;
  }

  // 头像地址:URL 常带长签名参数,用独立的长度上限;非 https 一律弃(降级
  // 无头像,不能让身份端点把 file:// / http:// 地址塞进主机下载器)。
  let avatarUrl: string | null = null;
  if (opts.avatarPath) {
    const raw = extractIdentityUrlValue(parsed, opts.avatarPath);
    if (raw !== null && isSafeHttpsUrl(raw)) avatarUrl = raw;
  }
  return { label, display, avatarUrl };
}

/** 头像 URL 专用取值(与 extractIdentityValue 同路径规则,上限放宽到 URL 级)。 */
const IDENTITY_URL_VALUE_MAX_CHARS = 2048;
function extractIdentityUrlValue(parsed: unknown, path: string): string | null {
  let cursor: unknown = parsed;
  for (const seg of path.split('.')) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) return null;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return typeof cursor === 'string' &&
    cursor.length > 0 &&
    cursor.length <= IDENTITY_URL_VALUE_MAX_CHARS
    ? cursor
    : null;
}

/* ------------------------------------------------------------------------ */
/* 声明式头像下载(设置页账号卡的头像 data URL)                               */
/* ------------------------------------------------------------------------ */

/** 头像原始字节硬顶(缩略图级;超限整单弃,不截断出坏图)。 */
const AVATAR_MAX_BYTES = 256 * 1024;
/** 头像可接受的图片 mime(data URL 直出给沙箱 <img>,只认常见位图)。 */
const AVATAR_ALLOWED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * 下载账号头像并转 data URL。地址来自身份响应(服务商自报的 CDN),**绝不
 * 带 Authorization**——头像域名不在凭证注入白名单里,带令牌出去就是泄露。
 * 任何失败(非 https / 非图片 / 超限 / 网络)一律 null,纯 best-effort。
 */
export async function fetchGhostOauthAvatar(opts: {
  url: string;
  fetchImpl: typeof fetch;
}): Promise<string | null> {
  if (!isSafeHttpsUrl(opts.url)) return null;
  let res: Response;
  try {
    res = await opts.fetchImpl(opts.url, { method: 'GET', headers: { Accept: 'image/*' } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!AVATAR_ALLOWED_MIMES.has(mime)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
  if (bytes.byteLength === 0 || bytes.byteLength > AVATAR_MAX_BYTES) return null;
  return `data:${mime};base64,${bytes.toString('base64')}`;
}
