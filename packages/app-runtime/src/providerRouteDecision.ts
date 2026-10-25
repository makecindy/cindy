import type {RoutingDescriptor,AgentKind} from '@cindy/model-providers';
import type {RoutingDecision} from '@cindy/anthropic-compat-proxy';


export const MISSING_PROVIDER_OAUTH_TOKEN = 'xdt-missing-provider-oauth-token';


/**
 * Codex 子进程(ChatGPT OAuth spawn)随请求携带的 OpenAI 账号/会话元数据头。
 * 发往第三方上游前必须整组抹掉:既是隐私(账号 id 泄漏给别家),也防上游把不认识的
 * OpenAI 头当非法请求拒掉。内置 xai 走目录条目的 headerDelete 声明同一组;自定义
 * OAuth 供应商的目录条目(buildUserProvider)不带 headerDelete,由 oauth-token 分支
 * 在代码层兜底(非 ChatGPT spawn 下这些头不存在,删除为 no-op,无副作用)。
 */
export const CODEX_ACCOUNT_HEADERS = ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'];

/** 无鉴权上游永远不能收到 agent 子进程自带的订阅凭证。 */
export const CLIENT_AUTH_HEADERS = ['authorization', 'x-api-key'];

/** 缺少自定义供应商 key 时覆盖 CLI 凭证的哑值：目标上游应 401，但绝不收到订阅 token。 */
export const MISSING_CUSTOM_PROVIDER_API_KEY = 'cindy-missing-custom-provider-api-key';

export const DISABLED_PROVIDER_ROUTE_ERROR = 'provider_route_disabled';


/**
 * 已迁移但无法安全执行的历史路由必须由 proxy 原地拒绝，不能返回 null：
 * null 在两个 proxy host 里表示“未命中”，会继续走默认网关/订阅上游。
 */
export function disabledProviderRouteDecision(providerId?: string): RoutingDecision {
  return {
    localHandler: async ({ res }) => {
      const providerLabel = providerId ? `Provider '${providerId}'` : 'The selected provider';
      const payload = JSON.stringify({
        type: 'error',
        error: {
          type: DISABLED_PROVIDER_ROUTE_ERROR,
          code: DISABLED_PROVIDER_ROUTE_ERROR,
          message: `${providerLabel} is disabled; update its endpoint or authentication settings before retrying.`,
        },
      });
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(payload);
    },
  };
}


export function withoutClientAuthHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const blocked = new Set(CLIENT_AUTH_HEADERS);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !blocked.has(name.toLowerCase())),
  );
}


export function normalizeLegacyClientAuthHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  const clientAuthHeaders = new Set(CLIENT_AUTH_HEADERS);
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    normalized[clientAuthHeaders.has(lower) ? lower : name] = value;
  }
  return normalized;
}


export function hasHeader(headers: Record<string, string> | undefined, expectedName: string): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === expectedName);
}


/**
 * 据路由描述符 + 当前网关 key + agent 生成 proxy 路由决策。
 * 返回 null = 不 override(passthrough),由调用方决定是否回落默认路由。
 *
 * `apiKey` 仅 `api-key-header` 策略（自定义供应商）使用：按 agent 注入鉴权头
 * （cc=`x-api-key`，codex=`authorization: Bearer`）。内置三家不传 / 忽略。
 * `oauthToken` 仅 `oauth-token` 策略（描述符驱动的通用 OAuth 供应商）使用。
 */
export function buildRouteDecision(
  routing: RoutingDescriptor,
  gatewayKey: string | null,
  agent: AgentKind,
  apiKey?: string | null,
  // 供应商 OAuth token：provider-oauth-header（host bespoke 读取器，如 xAI）与 oauth-token
  // （通用 Runner）两策略共用——语义都是「host 持有的该供应商 access_token」，且单个
  // routing 只会命中其一，共用一个参数无歧义。
  oauthToken?: string | null,
): RoutingDecision | null {
  if (routing.disabled) return disabledProviderRouteDecision();
  switch (routing.authStrategy) {
    case 'none': {
      // 本机 / 自托管无鉴权代理：仍固定路由到所选 upstream，但显式剥掉子进程自带的
      // Claude.ai / ChatGPT 凭证与账号元数据。宁可让代理按匿名请求拒绝，也不能泄漏订阅令牌。
      const headerDelete = new Set([
        ...(routing.headerDelete ?? []),
        ...CLIENT_AUTH_HEADERS,
        ...(agent === 'codex' ? CODEX_ACCOUNT_HEADERS : []),
      ]);
      const headerOverride = withoutClientAuthHeaders(routing.headerOverride);
      return {
        upstreamOverride: routing.upstream,
        ...(Object.keys(headerOverride).length > 0 ? { headerOverride } : {}),
        headerDelete: [...headerDelete],
      };
    }

    case 'oauth-token': {
      // 描述符驱动的通用 OAuth 供应商：上游改到供应商自家端点，鉴权头换成 Runner 持有的
      // access_token。无 token（未登录/已失效）**也不回落 null**——会话是显式选了这家的,
      // 回落会让请求带着子进程自带凭证流向默认网关/别家上游(模型跑错上游 + 凭证泄漏);
      // 与 provider-oauth-header 同口径:置哑 token 仍发往本供应商,宁可上游 401。
      const headerOverride: Record<string, string> = {
        ...withoutClientAuthHeaders(routing.headerOverride),
        authorization: `Bearer ${oauthToken || MISSING_PROVIDER_OAUTH_TOKEN}`,
      };
      const decision: RoutingDecision = { headerOverride };
      if (routing.upstream) decision.upstreamOverride = routing.upstream;
      // Copilot assigns personal/business/enterprise API hosts in its inference token.
      // Follow that assignment only for the official preset and official Copilot hosts.
      if (routing.upstream && oauthToken) {
        const upstream = new URL(routing.upstream);
        if (upstream.protocol === 'https:' && upstream.hostname === 'api.individual.githubcopilot.com') {
          const host = oauthToken.match(/(?:^|;)proxy-ep=(proxy\.(?:individual|business|enterprise)\.githubcopilot\.com)(?:;|$)/)?.[1];
          if (host) { upstream.hostname = host.replace(/^proxy\./, 'api.'); decision.upstreamOverride = upstream.toString().replace(/\/$/, ''); }
        }
      }
      // cc 子进程可能带 x-api-key（gateway-spawn 的网关 key）——发往 OAuth 上游必须抹掉，
      // 防泄漏 + 防按 x-api-key 优先鉴权的端点拿错钥匙。合并描述符自带的 headerDelete。
      const del = new Set(routing.headerDelete ?? []);
      if (agent === 'claude-code') del.add('x-api-key');
      // codex 子进程带 OpenAI 账号元数据头——oauth-token 上游一定是第三方,整组抹掉(见常量注释)。
      if (agent === 'codex') for (const h of CODEX_ACCOUNT_HEADERS) del.add(h);
      if (del.size > 0) decision.headerDelete = [...del];
      return decision;
    }
    case 'oauth-passthrough':
      // 直连供应商自家上游,透传子进程已带的 OAuth bearer(+ beta header)。header 不动。
      return { upstreamOverride: routing.upstream };

    case 'provider-oauth-header': {
      // 直连供应商自家上游,但子进程 bearer 不属于它(例如 Codex 的 OpenAI OAuth 不能打 xAI)。
      // 缺 token 时也覆盖成哑 token,宁可让目标上游 401,也不能把原 bearer 泄漏到别家。
      const headerOverride: Record<string, string> = {
        ...withoutClientAuthHeaders(routing.headerOverride),
        authorization: `Bearer ${oauthToken || MISSING_PROVIDER_OAUTH_TOKEN}`,
      };
      const decision: RoutingDecision = {
        upstreamOverride: routing.upstream,
        headerOverride,
      };
      if (routing.headerDelete?.length) decision.headerDelete = routing.headerDelete;
      return decision;
    }

    case 'gateway-key': {
      // 走 XD 网关(= proxy 默认上游,不 override),鉴权头换成网关 key。
      if (!gatewayKey) return null; // 没 key 可换 → passthrough(调用方记 warn)
      const headerOverride: Record<string, string> =
        agent !== 'codex'
          ? { 'x-api-key': gatewayKey, authorization: `Bearer ${gatewayKey}` }
          : { authorization: `Bearer ${gatewayKey}` };
      if (routing.headerOverride) Object.assign(headerOverride, routing.headerOverride);
      const decision: RoutingDecision = { headerOverride };
      if (routing.headerDelete?.length) decision.headerDelete = routing.headerDelete;
      return decision;
    }

    case 'api-key-header': {
      // 自定义供应商：上游改到 baseUrl，用用户自己的 api key 覆盖鉴权头，叠加用户自定义 headers。
      // key 来自 resolve 时注入的 apiKey（不在 catalog 里）。
      // 新版凭证由 safeStorage 注入；旧版曾把 API key 直接存进 headerOverride。没有迁移到
      // safeStorage 的 key 时保留旧头，避免升级后所有 legacy 自定义供应商静默掉鉴权。
      // 一旦存在安全存储 key，仍先剥掉旧头再覆盖，防旧凭证与新凭证并存。
      const hasLegacyAuthorization = hasHeader(routing.headerOverride, 'authorization');
      const hasLegacyApiKey = hasHeader(routing.headerOverride, 'x-api-key');
      const hasLegacyCredential = hasLegacyAuthorization || hasLegacyApiKey;
      const headerOverride =
        apiKey || !hasLegacyCredential
          ? withoutClientAuthHeaders(routing.headerOverride)
          : normalizeLegacyClientAuthHeaders(routing.headerOverride);
      if (apiKey) {
        if (agent !== 'codex') {
          // cc 子进程在 oauth-spawn 下会带订阅的 `authorization: Bearer <Claude token>`——必须连它一起
          // 覆盖，否则订阅 token 泄漏到自定义上游，且被「按 Bearer 鉴权」的兼容网关（如 mimo 的
          // /anthropic：OpenAI 式鉴权）当成无效 key → 401。两个头都置成用户 key：x-api-key 覆盖标准
          // Anthropic 端点、authorization 覆盖按 Bearer 鉴权的兼容端点。与内置 gateway-key(cc) 同时覆盖两头同因。
          headerOverride['x-api-key'] = apiKey;
          headerOverride['authorization'] = `Bearer ${apiKey}`;
        } else {
          headerOverride['authorization'] = `Bearer ${apiKey}`;
        }
      } else {
        // 未配置 key 时，每一种 agent 原生鉴权头都必须有 legacy 值或哑值覆盖。只保留
        // x-api-key 会让 Codex Authorization 穿透；只保留 Authorization 也会让 Claude
        // x-api-key 穿透。
        if (!hasLegacyAuthorization) {
          headerOverride.authorization = `Bearer ${MISSING_CUSTOM_PROVIDER_API_KEY}`;
        }
        if (agent !== 'codex' && !hasLegacyApiKey) {
          headerOverride['x-api-key'] = MISSING_CUSTOM_PROVIDER_API_KEY;
        }
      }
      const decision: RoutingDecision = {};
      if (Object.keys(headerOverride).length > 0) decision.headerOverride = headerOverride;
      if (routing.upstream) decision.upstreamOverride = routing.upstream;
      const headerDelete = new Set(routing.headerDelete ?? []);
      if (agent === 'codex') for (const name of CODEX_ACCOUNT_HEADERS) headerDelete.add(name);
      if (headerDelete.size > 0) decision.headerDelete = [...headerDelete];
      // 自定义供应商必有 upstream → 实际总返回 decision；全空时 passthrough。
      return decision.headerOverride || decision.upstreamOverride || decision.headerDelete
        ? decision
        : null;
    }

    default:
      return null;
  }
}

/** 某 providerId 解析出的路由描述符 + 已注入真实凭证的 RoutingDecision(供远端 env materialize 用)。 */
export interface ResolvedProviderRouteDecision {
  providerId: string;
  routing: RoutingDescriptor;
  /** buildRouteDecision 结果(headerOverride 已含真实 key/token,upstreamOverride = 供应商真上游)。 */
  decision: RoutingDecision | null;
}
