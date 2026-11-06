/**
 * ghostOauthBroker.ts — tokenBroker 声明的 XDT server 授权 broker 调用器。
 * ---------------------------------------------------------------------------
 * oauth 详单声明 `tokenBroker: "<slug>"` 的意识。资格按可信安装事实判定，
 * 名称前缀不放行。校验层保持纯函数不感知装入语境，
 * 门控在装入闸与连接闸。符合资格后，code 换 token 与 refresh 不直连服务商
 * tokenUrl,改经 XDT server
 * 的授权 broker 端点(`/api/integrations/<slug>/oauth/exchange|refresh`,JWT
 * 保护)——client secret 由服务端持有,不随包分发。本模块只做两件事:
 * 调 server + 把响应映射成 GhostOauthTokenBundle,授权流程本体仍在
 * ghostOauthFlow(loopback 回调、state 校验等与直连模式共用)。
 *
 * 错误映射口径(invalidGrant 走**上游拒绝白名单**,fail-safe):
 * - 未登录(本地无 access token)→ EXCHANGE_FAILED,提示先登录,绝不把
 *   "登录态缺失"误判成 invalid_grant(那会连带作废用户的 refresh token);
 * - 仅 server 401 且错误码命中 UPSTREAM_REJECTION_CODES(如 JIRA_OAUTH_FAILED
 *   = Atlassian 拒绝该 refresh token)才 invalidGrant:true,消费端走
 *   markExpired 引导重连;登录层 401(TOKEN_EXPIRED / UNAUTHORIZED /
 *   INVALID_TOKEN / USER_NOT_FOUND…)以及任何**不认识的** 401 错误码一律
 *   invalidGrant:false——server JWT secret 轮换这类全员性登录层故障绝不能
 *   连带销毁所有人的第三方授权;
 * - 网络不通(statusCode 0 / NETWORK_ERROR)→ NETWORK(瞬时,可重试)。
 * - broker 路由未部署或服务端故障(404 / 5xx)→ SERVICE_UNAVAILABLE,供宿主
 *   显示可操作的服务不可用提示,不暴露上游响应正文。
 *
 * 依赖注入(规则 14):server 调用与登录态判断全经 deps,单测内存假体覆盖,
 * 零 Electron。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';

import {
  EXPIRY_SAFETY_MARGIN_MS,
  type GhostOauthBrokerBootstrapResult,
  type GhostOauthBrokerClient,
  type GhostOauthBrokerResult,
  type GhostOauthLogger,
  type GhostOauthTokenBundle,
} from './ghostOauthFlow.js';

/**
 * 接线层认可的 broker slug 白名单:server 端有对应端点才放行,未知 slug
 * 直接结构化拒绝(不打无谓的 server 请求)。新增 provider 时同步扩这里
 * 与 server 端路由。
 */
// 'slack' slug 已于 2026-07-19 随 cindy-slack 意识退役(Slack 能力并轨 hook
// 通道, user token 改由 slack-hook-server 在 bind v2 授权时托管)。
export const SUPPORTED_TOKEN_BROKERS: ReadonlySet<string> = new Set(['feishu', 'jira']);

/**
 * 由服务端按企业配置签发应用身份的 slug:授权开始时经 bootstrap 取 clientId 与
 * 一次性授权事务,清单可不内置 clientId。其它 slug 继续用清单里的 clientId。
 */
const CLIENT_ISSUING_TOKEN_BROKERS: ReadonlySet<string> = new Set(['feishu']);

/** 该 tokenBroker 是否由服务端签发 clientId(插件清单可缺省)。 */
export function tokenBrokerIssuesClientId(slug: string | undefined): boolean {
  return slug !== undefined && CLIENT_ISSUING_TOKEN_BROKERS.has(slug);
}

/**
 * server 401 里明确表示"上游服务商拒绝了这份授权"的错误码白名单——只有命中
 * 才允许 invalidGrant(触发消费端删 refresh token)。新增 broker provider 时
 * 把它的上游拒绝码加进来;不认识的 401 一律按登录层故障处理(fail-safe:
 * 宁可多一次重试,绝不误删用户凭证)。
 */
const UPSTREAM_REJECTION_CODES: ReadonlySet<string> = new Set([
  'FEISHU_OAUTH_FAILED',
  'JIRA_OAUTH_FAILED',
]);

/** broker 端点的响应形态(apps/server routes/jiraOAuth.ts 的返回契约)。 */
interface BrokerTokenResponse {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresIn?: unknown;
  scope?: unknown;
}

/** bootstrap 端点的响应形态(oauth-broker routes/oauth.ts 的返回契约)。 */
interface BrokerBootstrapResponse {
  clientId?: unknown;
  transactionId?: unknown;
  redirectUri?: unknown;
}

/** apiPost 抛出的错误最小面(生产 = serverApiClient.ServerApiError 的字段)。 */
export interface GhostOauthBrokerApiError {
  code: string;
  statusCode: number;
  message: string;
}

export interface GhostOauthBrokerDeps {
  /** POST JSON 到 XDT server(生产注入 serverApiFetch;失败 throw ServerApiError)。 */
  apiPost(path: string, body: Record<string, unknown>): Promise<unknown>;
  /** 当前是否有登录态(生产 = authManager.getAccessToken() 非空)。 */
  hasLoginToken(): boolean;
  logger?: GhostOauthLogger;
}

function toBundle(raw: unknown): GhostOauthTokenBundle | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const parsed = raw as BrokerTokenResponse;
  if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) return null;
  const expiresIn = typeof parsed.expiresIn === 'number' && Number.isFinite(parsed.expiresIn)
    ? parsed.expiresIn
    : null;
  return {
    accessToken: parsed.accessToken,
    refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0
      ? parsed.refreshToken
      : null,
    expiresAt: expiresIn !== null ? Date.now() + Math.max(0, expiresIn * 1000 - EXPIRY_SAFETY_MARGIN_MS) : null,
    grantedScope: typeof parsed.scope === 'string' && parsed.scope.length > 0 ? parsed.scope : null,
  };
}

function isApiError(err: unknown): err is GhostOauthBrokerApiError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as GhostOauthBrokerApiError).code === 'string' &&
    typeof (err as GhostOauthBrokerApiError).statusCode === 'number'
  );
}

export function createGhostOauthBrokerClient(deps: GhostOauthBrokerDeps): GhostOauthBrokerClient {
  const post = async (
    slug: string,
    action: 'bootstrap' | 'exchange' | 'refresh',
    body: Record<string, unknown>,
  ): Promise<{ ok: true; raw: unknown } | Extract<GhostOauthBrokerResult, { ok: false }>> => {
    if (!SUPPORTED_TOKEN_BROKERS.has(slug)) {
      return { ok: false, error: 'EXCHANGE_FAILED', invalidGrant: false, detail: `不支持的 tokenBroker:${slug}` };
    }
    if (!deps.hasLoginToken()) {
      return {
        ok: false,
        error: 'EXCHANGE_FAILED',
        invalidGrant: false,
        detail: `需要先登录 ${BRAND_NAME}(broker 授权经服务端完成)`,
      };
    }
    let raw: unknown;
    try {
      raw = await deps.apiPost(`/api/integrations/${slug}/oauth/${action}`, body);
    } catch (err) {
      if (isApiError(err)) {
        if (err.statusCode === 0 || err.code === 'NETWORK_ERROR') {
          return { ok: false, error: 'NETWORK', invalidGrant: false, detail: err.message };
        }
        if (err.statusCode === 404 || err.statusCode >= 500) {
          deps.logger?.warn('ghost oauth broker 服务不可用', {
            slug,
            action,
            status: err.statusCode,
            code: err.code,
          });
          return { ok: false, error: 'SERVICE_UNAVAILABLE', invalidGrant: false };
        }
        const invalidGrant = err.statusCode === 401 && UPSTREAM_REJECTION_CODES.has(err.code);
        deps.logger?.warn('ghost oauth broker 调用被拒', {
          slug,
          action,
          status: err.statusCode,
          code: err.code,
          invalidGrant,
        });
        return {
          ok: false,
          error: 'EXCHANGE_FAILED',
          invalidGrant,
          detail: `${err.code} ${err.message}`.slice(0, 200),
        };
      }
      // serverApiFetch 的真实传输失败会带 statusCode:0 / NETWORK_ERROR,
      // 已在上方精确归类。其余异常可能来自账号能力门禁或调用前置条件，
      // 不能误导用户检查网络。
      return { ok: false, error: 'EXCHANGE_FAILED', invalidGrant: false, detail: String(err) };
    }
    return { ok: true, raw };
  };

  const call = async (
    slug: string,
    action: 'exchange' | 'refresh',
    body: Record<string, unknown>,
  ): Promise<GhostOauthBrokerResult> => {
    const posted = await post(slug, action, body);
    if (!posted.ok) return posted;
    const bundle = toBundle(posted.raw);
    if (!bundle) {
      return { ok: false, error: 'EXCHANGE_FAILED', invalidGrant: false, detail: 'broker 响应缺少 accessToken' };
    }
    return { ok: true, bundle };
  };

  const bootstrap = async (
    slug: string,
    { redirectUri }: { redirectUri: string },
  ): Promise<GhostOauthBrokerBootstrapResult | null> => {
    if (!tokenBrokerIssuesClientId(slug)) return null;
    const posted = await post(slug, 'bootstrap', { redirectUri });
    if (!posted.ok) return { ok: false, error: posted.error, detail: posted.detail };
    const parsed = (typeof posted.raw === 'object' && posted.raw !== null ? posted.raw : {}) as BrokerBootstrapResponse;
    if (
      typeof parsed.clientId !== 'string' || parsed.clientId.length === 0
      || typeof parsed.transactionId !== 'string' || parsed.transactionId.length === 0
    ) {
      return { ok: false, error: 'EXCHANGE_FAILED', detail: 'broker 授权应用响应字段不完整' };
    }
    // 服务端按企业配置校验回调地址;回显不一致说明两端对授权事务的理解已分叉。
    if (parsed.redirectUri !== redirectUri) {
      return { ok: false, error: 'EXCHANGE_FAILED', detail: 'broker 返回的回调地址与本机不一致' };
    }
    return { ok: true, clientId: parsed.clientId, transactionId: parsed.transactionId };
  };

  return {
    bootstrap,
    // codeVerifier:PKCE 流(feishu)由 broker 端点透传上游;不吃 PKCE 的
    // provider(jira/slack)声明 pkce:false,不会带到这里。
    exchange: (slug, { code, redirectUri, codeVerifier, transactionId }) =>
      call(slug, 'exchange', {
        code,
        redirectUri,
        ...(codeVerifier !== undefined ? { codeVerifier } : {}),
        ...(transactionId !== undefined ? { transactionId } : {}),
      }),
    refresh: (slug, { refreshToken }) => call(slug, 'refresh', { refreshToken }),
  };
}
