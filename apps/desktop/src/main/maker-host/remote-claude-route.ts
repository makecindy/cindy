/**
 * remote-claude-route —— 远端 Claude Code 会话的「路由 materialization」(host 侧)。
 *
 * 本地会话按模型在「Anthropic 订阅直连 / XD 网关 / 自定义供应商」之间分流的逻辑活在本机
 * loopback compat-proxy 里(anthropic-compat-proxy-host.ts 的 routingTransform 按请求覆盖
 * upstream + 鉴权头)。远端 cc-mgr 会话够不到这个 proxy,所以必须在 spawn 前把「该会话应走
 * 的真上游 + 鉴权 + 定制请求头」解析好,直接烤进远端 cc 子进程的 env(ANTHROPIC_BASE_URL /
 * ANTHROPIC_API_KEY | ANTHROPIC_AUTH_TOKEN / ANTHROPIC_CUSTOM_HEADERS / CLAUDE_CODE_OAUTH_TOKEN)。
 *
 * 注入进 maker-core 的 AgentDeps.resolveRemoteClaudeRoute。返回语义见该字段文档:
 *   - RemoteClaudeRoute:native OAuth 订阅 / 自定义 Claude Code 供应商 —— 覆盖 endpoint + 鉴权;
 *   - null:有效路由是 XD 网关(或默认回落网关)—— maker-core 将远端凭证形态回落
 *     'gateway-key'(网关 key + 网关 endpoint),与升级前远端行为一致;
 *   - throw:供应商在远端无法用 cc env 表达(自定义 requestPath / modelIdRewrite / oauth-passthrough),
 *     明确报错,不静默错路由。
 *
 * 鉴权头 → cc env 的编码遵循「单鉴权门 + 其余头走 ANTHROPIC_CUSTOM_HEADERS」(R2):cc 在
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 下必须有恰好一个鉴权 env 过 auth gate,同时设两个
 * (ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN)在 cc>=2.1.198 上可能触发 shouldDisableAuth;
 * 把另一个鉴权头塞进 ANTHROPIC_CUSTOM_HEADERS 既避开该冲突,出站 header 集合又与本地 proxy
 * 逐字节一致(已用 header-echo 探测 cc 的透传行为确认)。
 *
 * 已知缺口(既有行为,非本模块回归):本模块只镜像本地 proxy 的 ②段默认路由;⓪段的
 * `chatgpt/` / `xai/` 订阅前缀模型(本地走 responses bridge 订阅直连)远端不可表达,
 * 会话会落到网关路径 —— 与升级前「远端恒网关」一致。
 */

import type { RemoteClaudeRoute } from '@cindy/maker-core';
import type { RoutingDecision } from '@cindy/anthropic-compat-proxy';

import { readClaudeApiKey } from './auth-adapters.js';
import { claudeOAuthSpawnEnv } from './claude-oauth-spawn-env.js';
import { getClaudeAiOAuthForSpawn } from './claude-oauth-refresh.js';
import { hasClaudeAiOAuth } from './claude-credentials-store.js';
import { getActiveCatalog } from './active-catalog.js';
import {
  ANTHROPIC_DIRECT_UPSTREAM,
  anthropicCatalogModelIds,
  isAnthropicWireModel,
} from './claude-gateway-config.js';
import {
  gatewayDefaultRouteDecision,
  isProviderRouteMutationInProgress,
  resolveProviderRouteDecision,
  type ResolvedProviderRouteDecision,
} from './provider-route.js';

/** 'none'(自托管无鉴权)供应商在远端的 cc auth-gate 占位值 —— 目标上游应忽略它。 */
const REMOTE_NO_AUTH_PLACEHOLDER = 'cindy-remote-no-auth';

const REMOTE_AGENT = 'claude-code' as const;

export async function resolveRemoteClaudeRoute(opts: {
  providerId?: string | null;
  model: string;
}): Promise<RemoteClaudeRoute | null> {
  const providerId = opts.providerId?.trim() || null;

  // 内置 Anthropic 的 catalog route 是 oauth-passthrough(本地 cc 子进程自己带订阅 bearer)；
  // 远端没有这个 bearer 来源，必须由 host 读取 native OAuth token 后显式 materialize。
  if (providerId === 'anthropic') return nativeAnthropicRoute();

  // 显式选定供应商(非网关)→ 按其 RoutingDescriptor materialize。
  if (providerId && providerId !== 'xd') {
    // mutation 窗口先于「无路由」判:resolveProviderRouteDecision 在窗口内也返回 null
    // (安全门),但报「不支持」会误导 —— 真实状态是「凭证正在更新,稍后重试」,对齐
    // 本地 provider_route_updating 语义。
    if (isProviderRouteMutationInProgress(providerId)) {
      throw new Error(
        `[REMOTE_PROVIDER_UPDATING] provider "${providerId}" credentials are being updated on this desktop; retry in a moment`,
      );
    }
    const routed = await resolveProviderRouteDecision(providerId, REMOTE_AGENT, readClaudeApiKey());
    if (routed) return materializeRoutedProvider(routed);
    // TOCTOU 兜底:resolver 内部也会因 mutation 窗口返回 null;若恰好在两次判定之间
    // 窗口开启,报 UPDATING 而非 UNSUPPORTED(语义更准确,用户稍后重试即可)。
    if (isProviderRouteMutationInProgress(providerId)) {
      throw new Error(
        `[REMOTE_PROVIDER_UPDATING] provider "${providerId}" credentials are being updated on this desktop; retry in a moment`,
      );
    }
    throw new Error(
      `[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" has no claude-code route on this desktop`,
    );
  }

  // 显式 XD 网关 → 走既有网关远端路径(maker-core 侧 null 回落)。
  if (providerId === 'xd') return null;

  // 未显式选供应商(默认):镜像本地 proxy 的默认路由(anthropic-compat-proxy-host ②段)。
  // 没连订阅 = gateway-spawn,本地 passthrough 网关 → 远端网关(null)。
  if (!hasClaudeAiOAuth()) return null;
  // oauth-spawn + 有网关 key(且网关可用):本地「全量换网关 key」防订阅 token 泄漏到网关,
  // 远端同样走网关(null)——计费归属与实际上游必须与本地一致,不能因为是远端就升级成直连。
  if (gatewayDefaultRouteDecision(REMOTE_AGENT, readClaudeApiKey())) return null;
  // oauth-spawn、没网关 key:Anthropic 模型唯一出路是订阅直连(与本地一致)。
  if (isAnthropicWireModel(opts.model, anthropicCatalogModelIds(getActiveCatalog()))) {
    return nativeAnthropicRoute();
  }
  // 没网关 key 的非 Anthropic 模型:本地 passthrough 必 401;远端回网关路径,由 maker-core
  // 的 remoteEndpoint guard / gateway-key auth gate 报「缺网关凭据」的真实原因。
  return null;
}

/** 内置 Anthropic 订阅直连:endpoint 取运行时目录 anthropic 描述符 upstream,缺省隐式直连上游。 */
function nativeAnthropicRoute(): RemoteClaudeRoute {
  const oauth = getClaudeAiOAuthForSpawn();
  if (!oauth?.accessToken) {
    throw new Error(
      '[REMOTE_NATIVE_OAUTH_UNAVAILABLE] Anthropic subscription is not connected on this desktop; connect Claude.ai or pick a gateway model for the remote session.',
    );
  }
  const descriptor = getActiveCatalog().providers.find((p) => p.id === 'anthropic')?.routing[
    REMOTE_AGENT
  ];
  const endpoint = descriptor?.upstream?.trim() || ANTHROPIC_DIRECT_UPSTREAM;
  const env = claudeOAuthSpawnEnv(oauth);
  const customHeaders = descriptor?.headerOverride;
  if (customHeaders && Object.keys(customHeaders).length > 0) {
    env.ANTHROPIC_CUSTOM_HEADERS = serializeCustomHeaders(customHeaders);
  }
  return { endpoint, env };
}

/** 自定义 / 通用 OAuth Claude Code 供应商:把 buildRouteDecision 结论翻成 cc env。 */
function materializeRoutedProvider(routed: ResolvedProviderRouteDecision): RemoteClaudeRoute {
  const { providerId, routing, decision } = routed;
  if (routing.disabled) {
    throw new Error(`[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" route is disabled`);
  }
  // cc 恒打 baseURL 的标准 /v1/messages,没有 env 能改推理路径。
  if (routing.requestPath) {
    throw new Error(
      `[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" uses a custom request path, which remote Claude Code sessions can't replicate`,
    );
  }
  // 远端发给 cc 的 model = 会话选的 model,cc 不会替我们剥前缀 → 需要 modelIdRewrite 的供应商暂不支持。
  if (routing.modelIdRewrite) {
    throw new Error(
      `[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" needs model-id rewriting, which remote Claude Code sessions can't replicate`,
    );
  }
  // oauth-passthrough(内置 xai 等)依赖 cc 子进程自带的 provider OAuth bearer,远端 env 无来源。
  if (routing.authStrategy === 'oauth-passthrough') {
    throw new Error(
      `[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" (oauth-passthrough) isn't supported on remote Claude Code sessions`,
    );
  }
  // oauth-token(generic OAuth,如 xAI):ANTHROPIC_AUTH_TOKEN 烤进远端,但 desktop 的
  // generic OAuth 刷新只在 desktop 侧读时发生,远端 daemon 无 refresh 通道 —— token
  // 过期后持续 401,与本地 routed 会话行为不一致(codex-connector review #1035)。
  // 除非补 provider-token refresh/sync(follow-up),一律拒绝。
  if (routing.authStrategy === 'oauth-token') {
    throw new Error(
      `[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" (oauth-token) isn't supported on remote Claude Code sessions: the bearer can't be refreshed remotely`,
    );
  }
  // buildRouteDecision 返回 null(非 xd 的 gateway-key 路由缺网关 key / 未知 authStrategy):
  // 不能拿占位鉴权打真上游(运行期 401,归因困难),前置报错。
  if (!decision) {
    throw new Error(
      `[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" route did not resolve to remote-usable credentials`,
    );
  }
  // no-auth + loopback upstream:baseUrl 指向本机 localhost,materialize 后远端
  // ANTHROPIC_BASE_URL 会指向**远端机器的** localhost,必错(codex-connector review
  // #1035)。除非显式隧道(follow-up),一律拒绝;非 loopback 的 no-auth(如内网
  // 自托管)远端可能可达,仍放行。
  const endpoint = (decision.upstreamOverride ?? routing.upstream)?.trim();
  if (routing.authStrategy === 'none' && endpoint && isLoopbackUrl(endpoint)) {
    throw new Error(
      `[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" (no-auth loopback) isn't supported on remote Claude Code sessions: the loopback base URL would point at the remote host's localhost`,
    );
  }
  if (!endpoint) {
    throw new Error(`[REMOTE_PROVIDER_UNSUPPORTED] provider "${providerId}" has no upstream endpoint`);
  }
  return { endpoint, env: routeDecisionToCcEnv(decision) };
}

/**
 * RoutingDecision.headerOverride → cc env(R2:单鉴权门 + 其余头进 ANTHROPIC_CUSTOM_HEADERS)。
 * buildRouteDecision 用小写 'x-api-key' / 'authorization';这里大小写不敏感地识别。
 */
function routeDecisionToCcEnv(decision: RoutingDecision): Record<string, string> {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = { ...(decision.headerOverride ?? {}) };
  const findHeaderKey = (name: string): string | undefined =>
    Object.keys(headers).find((k) => k.toLowerCase() === name);

  const xApiKeyKey = findHeaderKey('x-api-key');
  const authKey = findHeaderKey('authorization');
  if (xApiKeyKey) {
    env.ANTHROPIC_API_KEY = headers[xApiKeyKey];
    delete headers[xApiKeyKey];
  } else if (authKey) {
    env.ANTHROPIC_AUTH_TOKEN = stripBearer(headers[authKey]);
    delete headers[authKey];
  } else {
    // 无鉴权头('none' 自托管):cc 仍需一个凭证 env 过 auth gate,给占位值,上游忽略。
    env.ANTHROPIC_API_KEY = REMOTE_NO_AUTH_PLACEHOLDER;
  }
  // 剩余头(含另一个鉴权头、供应商定制头)统一走 custom headers,复刻本地 proxy 的出站集合。
  if (Object.keys(headers).length > 0) {
    env.ANTHROPIC_CUSTOM_HEADERS = serializeCustomHeaders(headers);
  }
  return env;
}

function stripBearer(value: string): string {
  const m = /^\s*Bearer\s+(.*)$/i.exec(value);
  return m ? m[1] : value;
}

/** URL 是否指向本机 loopback(localhost / 127.x.y.z / ::1)。
 *  轮 36 HIGH:与 pi-host.ts 的 isLoopbackUrl 对齐 —— startsWith('127.') 会误杀
 *  127.example.com 等合法域名, 改为精确 IPv4 loopback 正则。 */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'localhost'
      || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
      || host === '::1'
      || host === '[::1]';
  } catch {
    return false;
  }
}

/** cc 的 ANTHROPIC_CUSTOM_HEADERS 格式:每行 `Name: Value`,换行分隔(header-echo 探测确认)。
 *  头名/值里的 \r \n 会注入额外头行,剥掉防串行(copilot review #1035)。 */
function serializeCustomHeaders(headers: Record<string, string>): string {
  const sanitize = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim();
  return Object.entries(headers)
    .map(([name, value]) => `${sanitize(name)}: ${sanitize(value)}`)
    .join('\n');
}
