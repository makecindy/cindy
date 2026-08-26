/**
 * provider-route —— 把 catalog 的 `RoutingDescriptor` 翻译成 loopback proxy 的 `RoutingDecision`,
 * 并据 per-session 选定的供应商解析本会话的路由。
 *
 * 这是「统一路由器」的翻译层:当某会话**显式选了供应商**(per-session providerId)时,
 * proxy 的 routingTransform 用本模块据 catalog 描述符出路由。没显式选的会话通常由调用方
 * 回落到 spawn-aware 默认(cc)/ decideCodexRoute(codex);但模型 id 自带唯一供应商命名空间
 * 且该供应商要求 provider OAuth 注入时(如 xai/grok-*)，也可按 catalog 推断路由。
 *
 * **设计约束(no-break)**:对内置 Anthropic / OpenAI / XD 三家,本函数的输出与对应
 * decideXxxRoute 在等价场景下**逐字段一致**(见 __tests__/providerRoute.test.ts 的 snapshot 锁定)。
 *
 * gateway-key 的落地 header 因 agent 二进制 wire 不同(agent 参数据此分流):
 *   - claude-code: 子进程可能带 x-api-key,且 oauth 模式会泄漏 authorization bearer → 两个都覆盖,
 *     并删描述符指定的 header(anthropic-beta)。对应 decideClaudeRoute 的网关分支。
 *   - codex:       子进程带 authorization bearer → 覆盖它即可。对应 decideCodexRoute 的网关分支。
 * oauth-passthrough 两 agent 同构:只 upstreamOverride 到供应商自家上游,header 不动。
 * provider-oauth-header: upstreamOverride 到供应商自家上游,并用 host 保存的 provider OAuth
 * token 覆盖 authorization,避免把子进程里其它供应商的 OAuth bearer 泄漏过去(如 Codex → xAI)。
 */

import {
  actualSourceIdForModel,
  chatEligibleSourcesForModel,
  isExclusiveXaiModelId,
  resolvePiModelRoute,
  runtimeCustomProviderId,
  storedCustomProviderId,
  XAI_MODEL_PREFIX,
  type AgentKind,
  type Provider,
  type ProviderView,
  type RoutingDescriptor,
} from '@cindy/model-providers';
import type { RoutingDecision } from '@cindy/anthropic-compat-proxy';

import { getActiveCatalog, isXdCodexAnthropicBridgeModel } from './active-catalog.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { getSessionProvider } from './session-provider-store.js';

/**
 * 自定义(user)供应商的 API key 读取器（注入）。
 *
 * 用 setter 注入而非直接 import `providerSecretStore`：后者触电（app/safeStorage），会让
 * 本模块的纯逻辑单测（providerRoute.test.ts）在无 electron 环境炸。host 在启动期（splash）调
 * `setCustomProviderKeyReader(readCustomProviderKey)` 接通真实 safeStorage 读取（见
 * createDesktopProviderService.ensureActiveCatalogLoaded）。默认 no-op（返回 null）。
 *
 * key 只在 resolve 时读出注入鉴权头，**绝不进 catalog / 绝不经 listProviders 回 renderer**。
 */
type CustomProviderKeyReader = (providerId: string, agent: AgentKind) => string | null;
let customProviderKeyReader: CustomProviderKeyReader = () => null;
const providerRouteMutationCounts = new Map<string, number>();

/** host 启动期接通真实 safeStorage 读取（按 `provider_key_<id>_<agent>`，per-runtime 独立密钥）。 */
export function setCustomProviderKeyReader(reader: CustomProviderKeyReader): void {
  customProviderKeyReader = reader;
}

/**
 * 暂停某个 provider 的新路由解析，直到配置、secret 与 active catalog 一起切换完成。
 *
 * 配置和 safeStorage 无法组成同一个物理事务；mutation 期间直接拒绝新请求，避免把旧
 * endpoint 与新 key（或新 endpoint 与旧 key）拼成一次上游请求。计数使排队的多窗口
 * mutation 之间不会短暂恢复路由。
 */
export function beginProviderRouteMutation(providerId: string): () => void {
  providerId = runtimeCustomProviderId(providerId);
  providerRouteMutationCounts.set(
    providerId,
    (providerRouteMutationCounts.get(providerId) ?? 0) + 1,
  );
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const remaining = (providerRouteMutationCounts.get(providerId) ?? 1) - 1;
    if (remaining <= 0) providerRouteMutationCounts.delete(providerId);
    else providerRouteMutationCounts.set(providerId, remaining);
  };
}

export function isProviderRouteMutationInProgress(providerId: string): boolean {
  return providerRouteMutationCounts.has(runtimeCustomProviderId(providerId));
}

/**
 * 通用 OAuth 供应商的 access_token 读取器（注入，同 key reader 模式）。
 *
 * **必须同步**（路由热路径，规则 10）：读 generic-oauth 的内存 blob 缓存；临期刷新由
 * generic-oauth 侧在读取时后台单飞触发，不阻塞本次路由。返回 null = 未登录 / 无 token
 * → 路由仍指向该供应商上游但置哑 token（上游预期 401；绝不回落默认路由防凭证泄漏）。
 */
type OAuthTokenReader = (providerId: string) => string | null;
let oauthTokenReader: OAuthTokenReader = () => null;

/** host 启动期接通 generic-oauth 的同步 token 缓存读取。 */
export function setOAuthTokenReader(reader: OAuthTokenReader): void {
  oauthTokenReader = reader;
}

/** 查询自定义供应商该 runtime 是否已有可注入的 API key（不暴露明文）。 */
export function hasCustomProviderKey(providerId: string, agent: AgentKind): boolean {
  if (isProviderRouteMutationInProgress(providerId)) return false;
  return Boolean(customProviderKeyReader(storedCustomProviderId(providerId), agent));
}

export interface ProviderOAuthTokenReadOptions {
  forceRefresh?: boolean;
  staleToken?: string;
}

type ProviderOAuthTokenReader = (
  providerId: string,
  agent: AgentKind,
  options?: ProviderOAuthTokenReadOptions,
) => string | null | Promise<string | null>;
let providerOAuthTokenReader: ProviderOAuthTokenReader = () => null;

/** host 启动期接通内置 OAuth 供应商 token 读取（如 xAI/SuperGrok）。 */
export function setProviderOAuthTokenReader(reader: ProviderOAuthTokenReader): void {
  providerOAuthTokenReader = reader;
}

type ProviderViewsReader = () => Promise<ProviderView[]>;
let providerViewsReader: ProviderViewsReader = async () => [];

/**
 * 注入 Main 侧实时 ProviderView 读取器。隐式来源必须与模型选择器共用连接态，
 * 不能只看 active catalog：目录表示“可提供”，凭证状态才表示“当前可路由”。
 */
export function setProviderViewsReader(reader: ProviderViewsReader): void {
  providerViewsReader = reader;
}

/** Read a provider OAuth token for a local bridge retry without exposing the reader itself. */
export function readProviderOAuthToken(
  providerId: string,
  agent: AgentKind,
  options?: ProviderOAuthTokenReadOptions,
): Promise<string | null> {
  return Promise.resolve(providerOAuthTokenReader(providerId, agent, options)).catch(() => null);
}

const MISSING_PROVIDER_OAUTH_TOKEN = 'xdt-missing-provider-oauth-token';

/**
 * Codex 子进程(ChatGPT OAuth spawn)随请求携带的 OpenAI 账号/会话元数据头。
 * 发往第三方上游前必须整组抹掉:既是隐私(账号 id 泄漏给别家),也防上游把不认识的
 * OpenAI 头当非法请求拒掉。内置 xai 走目录条目的 headerDelete 声明同一组;自定义
 * OAuth 供应商的目录条目(buildUserProvider)不带 headerDelete,由 oauth-token 分支
 * 在代码层兜底(非 ChatGPT spawn 下这些头不存在,删除为 no-op,无副作用)。
 */
const CODEX_ACCOUNT_HEADERS = ['chatgpt-account-id', 'openai-beta', 'originator', 'session_id'];
/** 无鉴权上游永远不能收到 agent 子进程自带的订阅凭证。 */
const CLIENT_AUTH_HEADERS = ['authorization', 'x-api-key'];
/** 缺少自定义供应商 key 时覆盖 CLI 凭证的哑值：目标上游应 401，但绝不收到订阅 token。 */
const MISSING_CUSTOM_PROVIDER_API_KEY = 'cindy-missing-custom-provider-api-key';
const DISABLED_PROVIDER_ROUTE_ERROR = 'provider_route_disabled';
const UPDATING_PROVIDER_ROUTE_ERROR = 'provider_route_updating';
const PENDING_PROVIDER_SWITCH_ERROR = 'provider_switch_pending';

type PendingCredentialSwitchReader = (
  sessionId: string,
) => { model: string; providerId: string | null; previousModel?: string } | undefined;
let pendingCredentialSwitchReader: PendingCredentialSwitchReader = () => undefined;

/** Main wires the pending switch service into this synchronous routing boundary. */
export function setPendingCredentialSwitchReader(reader: PendingCredentialSwitchReader): void {
  pendingCredentialSwitchReader = reader;
}

/**
 * 已迁移但无法安全执行的历史路由必须由 proxy 原地拒绝，不能返回 null：
 * null 在两个 proxy host 里表示“未命中”，会继续走默认网关/订阅上游。
 */
function disabledProviderRouteDecision(providerId?: string): RoutingDecision {
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

function updatingProviderRouteDecision(providerId: string): RoutingDecision {
  return {
    localHandler: async ({ res }) => {
      const payload = JSON.stringify({
        type: 'error',
        error: {
          type: UPDATING_PROVIDER_ROUTE_ERROR,
          code: UPDATING_PROVIDER_ROUTE_ERROR,
          message: `Provider '${providerId}' is updating; retry after the configuration change completes.`,
        },
      });
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '1',
      });
      res.end(payload);
    },
  };
}

function pendingProviderSwitchRouteDecision(providerId: string | null): RoutingDecision {
  return {
    localHandler: async ({ res }) => {
      const source = providerId ? `Provider '${providerId}'` : 'The default Provider route';
      const payload = JSON.stringify({
        type: 'error',
        error: {
          type: PENDING_PROVIDER_SWITCH_ERROR,
          code: PENDING_PROVIDER_SWITCH_ERROR,
          message: `${source} has a pending Provider switch; retry after the current turn completes.`,
        },
      });
      res.writeHead(503, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'retry-after': '1',
      });
      res.end(payload);
    },
  };
}

function samePendingSwitchModel(left: string, right: string): boolean {
  const leftBare = left.endsWith('[1m]') ? left.slice(0, -'[1m]'.length) : left;
  const rightBare = right.endsWith('[1m]') ? right.slice(0, -'[1m]'.length) : right;
  return leftBare === rightBare;
}

export function resolvePendingSessionRouteDecision(
  sessionId: string,
  wireModel: string | undefined,
): RoutingDecision | null {
  const providerId = getSessionProvider(sessionId);
  const pendingSwitch = pendingCredentialSwitchReader(sessionId);
  return wireModel &&
    pendingSwitch &&
    samePendingSwitchModel(pendingSwitch.model, wireModel) &&
    (!pendingSwitch.previousModel ||
      !samePendingSwitchModel(pendingSwitch.previousModel, wireModel))
    ? pendingProviderSwitchRouteDecision(providerId)
    : null;
}

function withoutClientAuthHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const blocked = new Set(CLIENT_AUTH_HEADERS);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => !blocked.has(name.toLowerCase())),
  );
}

function normalizeLegacyClientAuthHeaders(
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

function hasHeader(headers: Record<string, string> | undefined, expectedName: string): boolean {
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

/**
 * 网关默认路由 —— 「会话未显式选供应商」且 agent 处于 **oauth-spawn**(子进程携带订阅 OAuth token)
 * 时的默认决策:把全部模型按内置 XD 网关来源路由(网关 key 覆盖 OAuth bearer + 删描述符指定 header),
 * 防止订阅 token 泄漏到网关。语义等价于退役前 `decideClaudeRoute` 的非 Anthropic oauth 分支(对全模型)。
 *
 * 返回 null = 没网关 key 可换(调用方据 agent 自行兜底,如 Anthropic 模型放行直连)。
 *
 * 注:仅用于 oauth-spawn 的默认回落。env-key / gateway-spawn 下子进程自带网关 key,默认应回 null
 * (passthrough,字节级不变),不要调本函数。
 */
export function gatewayDefaultRouteDecision(
  agent: AgentKind,
  gatewayKey: string | null,
): RoutingDecision | null {
  if (!getAppCapabilities().canUseCindyGateway) return null;
  const xd = getActiveCatalog().providers.find((p) => p.id === 'xd');
  const routing = xd?.routing[agent];
  if (!routing) return null;
  return buildRouteDecision(routing, gatewayKey, agent);
}

/**
 * 路由描述符声明了 modelPrefixes(服务范围)时,判断该 wire model 是否在其范围内。
 *
 * 未声明 = universal(网关 / Anthropic 直连 / 自定义供应商,上游本身能服务任意模型);
 * wireModel 为空 = 控制面请求(如 codex `GET /models`,无 body.model),不受范围限制。
 */
function routingServesWireModel(
  routing: RoutingDescriptor,
  wireModel: string | undefined,
): boolean {
  if (routing.disabled) return false;
  if (!routing.modelPrefixes?.length) return true;
  if (!wireModel) return true;
  return routing.modelPrefixes.some(
    (prefix) =>
      wireModel.startsWith(prefix)
      || (prefix === XAI_MODEL_PREFIX && isExclusiveXaiModelId(wireModel)),
  );
}

/**
 * 解析 provider × agent × model 的最终 wire。
 *
 * Model Access v3 已给每个 Agent 明确限定 wire protocol；XD 不在客户端做模型级协议
 * fallback。自定义 provider 的兼容 bridge 仍由它自己的 routing descriptor 表达。
 */
export function providerRoutingForModel(
  provider: Provider,
  agent: AgentKind,
  wireModel: string | undefined,
): RoutingDescriptor | null {
  const routing = provider.routing[agent];
  if (!routing) return null;
  const model = wireModel
    ? provider.models[agent]?.find((candidate) => candidate.id === wireModel)
    : undefined;
  const modelRoute = model?.route;
  const piRoute =
    agent === 'pi'
      ? resolvePiModelRoute(model, {
          baseUrl: routing.upstream,
          wireProtocol: routing.wireProtocol,
        })
      : undefined;
  if (agent === 'pi' && piRoute === null) return null;
  if (
    !modelRoute &&
    (agent !== 'pi' ||
      (piRoute?.baseUrl === routing.upstream && piRoute.wireProtocol === routing.wireProtocol))
  )
    return routing;

  // 鉴权、固定 headers 与模型 namespace 门继续继承 provider/runtime；请求路径不能在
  // 协议切换后误继承旧 runtime 的路径，只有模型覆盖显式声明时才带回。
  const { requestPath: _runtimeRequestPath, ...inherited } = routing;
  return {
    ...inherited,
    upstream: agent === 'pi' ? piRoute!.baseUrl : modelRoute!.baseUrl,
    wireProtocol: agent === 'pi' ? piRoute!.wireProtocol : modelRoute!.wireProtocol,
    ...(agent === 'pi'
      ? piRoute!.requestPath
        ? { requestPath: piRoute!.requestPath }
        : {}
      : modelRoute?.requestPath
        ? { requestPath: modelRoute.requestPath }
        : {}),
  };
}

/**
 * 某 provider 对某 agent 的路由是否服务该 wire model(modelPrefixes 语义;未声明 = true,
 * provider 无该 agent 路由 = false)。
 *
 * 给**请求体 transform**(如 codex 的 xAI Responses 兼容改写)用的同源判据:transform
 * 是否改写与路由是否捕获必须同一个真值,否则会出现「请求被 scope 门放回默认上游,
 * body 却已按 xAI 语义改写」的分叉(#890 Codex review 指出)。
 */
export function providerRoutingServesWireModel(
  providerId: string,
  agent: AgentKind,
  wireModel: string | undefined,
): boolean {
  if (providerId === 'xd' && !getAppCapabilities().canUseCindyGateway) return false;
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  const routing = provider ? providerRoutingForModel(provider, agent, wireModel) : null;
  if (!routing) return false;
  return routingServesWireModel(routing, wireModel);
}

/**
 * 据某会话**显式选定的供应商**解析本次请求的路由决策。
 * 返回 null = 该会话未显式选供应商(或该供应商对此 agent 无路由,或本次请求的 wire model
 * 不在该路由声明的服务范围内)→ 调用方回落 decideXxxRoute / spawn 默认(no-break)。
 *
 * 路由描述符取自当前生效目录 getActiveCatalog()(OSS 运行时真源 / bundled 兜底,与统一路由器同源)。
 * active catalog 在 splash 期已加载完成,且 getActiveCatalog() 同步返回,故路由热路径零额外开销。
 *
 * @param sessionId  xdt 会话 id(proxy 经 session header 反解得到)
 * @param agent      承载该会话的 agent
 * @param gatewayKey XD 网关 key(gateway-key 策略要换成它)
 * @param wireModel  本次请求 body.model(原始,未经 modelIdRewrite)。路由声明了 modelPrefixes
 *                   时据此过服务范围门:agent CLI 内部用 claude-* 小模型发起的辅助调用(权限
 *                   auto 模式的安全分类器等)不属于订阅直连供应商的服务范围,必须回落默认路由,
 *                   否则被误送到无法服务它的上游 → 分类器必挂、工具全被拦(issue #886)。
 */
export function getSessionRoutingDescriptor(
  sessionId: string,
  agent: AgentKind,
  wireModel?: string,
): RoutingDescriptor | null {
  const providerId = getSessionProvider(sessionId);
  if (!providerId) return null;
  if (isProviderRouteMutationInProgress(providerId)) return null;
  const provider = getActiveCatalog().providers.find((candidate) => candidate.id === providerId);
  const routing = provider ? providerRoutingForModel(provider, agent, wireModel) : null;
  if (!routing || !routingServesWireModel(routing, wireModel)) return null;
  return routing;
}

/** Resolve routing metadata directly from a provider id without consulting session state. */
export function getProviderRoutingDescriptor(
  providerId: string | null | undefined,
  agent: AgentKind,
  wireModel?: string,
): RoutingDescriptor | null {
  const id = providerId?.trim();
  if (!id || isProviderRouteMutationInProgress(id)) return null;
  if (id === 'xd' && !getAppCapabilities().canUseCindyGateway) return null;
  const provider = getActiveCatalog().providers.find((candidate) => candidate.id === id);
  const routing = provider ? providerRoutingForModel(provider, agent, wireModel) : null;
  if (!routing || !routingServesWireModel(routing, wireModel)) return null;
  return routing;
}

export interface ResolvedSessionRoute {
  providerId: string;
  providerSource: 'builtin' | 'user';
  routing: RoutingDescriptor;
  apiKey: string | null;
  oauthToken: string | null;
}

export async function resolveProviderRouteById(
  providerId: string,
  agent: AgentKind,
  wireModel?: string,
): Promise<ResolvedSessionRoute | null> {
  if (isProviderRouteMutationInProgress(providerId)) return null;
  const provider = getActiveCatalog().providers.find((candidate) => candidate.id === providerId);
  const routing = provider ? providerRoutingForModel(provider, agent, wireModel) : null;
  if (!provider || !routing || !routingServesWireModel(routing, wireModel)) return null;
  const { apiKey, oauthToken } = await readProviderRouteCredentials(provider, routing, agent);
  return {
    providerId,
    providerSource: provider.source,
    routing,
    apiKey,
    oauthToken,
  };
}

/**
 * 解析会话选定来源的完整运行时素材，供需要本地协议 handler 的路径使用。
 * 普通透明转发仍走 resolveSessionRouteDecision，避免改变历史返回形态。
 */
export async function resolveSessionRoute(
  sessionId: string,
  agent: AgentKind,
  wireModel?: string,
): Promise<ResolvedSessionRoute | null> {
  const providerId = getSessionProvider(sessionId);
  if (!providerId) return null;
  return resolveProviderRouteById(providerId, agent, wireModel);
}

/** Build outbound headers for an already resolved local protocol handler. */
export function buildLocalHandlerHeaders(
  route: ResolvedSessionRoute,
  agent: AgentKind,
): {
  headers: Record<string, string>;
  headerDelete: string[];
} {
  const hostManagedAuth =
    route.routing.authStrategy === 'none' ||
    route.routing.authStrategy === 'api-key-header' ||
    route.routing.authStrategy === 'oauth-token' ||
    route.routing.authStrategy === 'provider-oauth-header';
  const headers: Record<string, string> = hostManagedAuth
    ? withoutClientAuthHeaders(route.routing.headerOverride)
    : { ...(route.routing.headerOverride ?? {}) };
  const headerDelete = new Set(route.routing.headerDelete ?? []);
  switch (route.routing.authStrategy) {
    case 'none':
      for (const name of CLIENT_AUTH_HEADERS) headerDelete.add(name);
      break;
    case 'api-key-header':
      {
        const decision = buildRouteDecision(route.routing, null, agent, route.apiKey);
        Object.assign(headers, decision?.headerOverride ?? {});
        for (const name of decision?.headerDelete ?? []) headerDelete.add(name);
      }
      break;
    case 'oauth-token':
    case 'provider-oauth-header':
      headers.authorization = `Bearer ${route.oauthToken || MISSING_PROVIDER_OAUTH_TOKEN}`;
      break;
    case 'gateway-key':
    case 'oauth-passthrough':
      break;
  }
  if (agent === 'codex') for (const name of CODEX_ACCOUNT_HEADERS) headerDelete.add(name);
  const normalizedDelete = new Set([...headerDelete].map((name) => name.toLowerCase()));
  for (const name of Object.keys(headers)) {
    if (normalizedDelete.has(name.toLowerCase())) delete headers[name];
  }
  return { headers, headerDelete: [...headerDelete] };
}
/** 某 providerId 解析出的路由描述符 + 已注入真实凭证的 RoutingDecision(供远端 env materialize 用)。 */
export interface ResolvedProviderRouteDecision {
  providerId: string;
  routing: RoutingDescriptor;
  /** buildRouteDecision 结果(headerOverride 已含真实 key/token,upstreamOverride = 供应商真上游)。 */
  decision: RoutingDecision | null;
}

/**
 * 读取某供应商路由所需的 host 侧凭证(自定义 key + 供应商 OAuth token)。
 * resolveSessionRoute / resolveProviderRouteDecision 共用 —— 判定条件(user source 才有
 * 自定义 key、两种 OAuth 策略的读取器与容错)是同一份逻辑,分写会漂移。
 */
async function readProviderRouteCredentials(
  provider: { id: string; source: 'builtin' | 'user' },
  routing: RoutingDescriptor,
  agent: AgentKind,
): Promise<{ apiKey: string | null; oauthToken: string | null }> {
  const credentialProviderId =
    provider.source === 'user' ? storedCustomProviderId(provider.id) : provider.id;
  const apiKey =
    provider.source === 'user' ? customProviderKeyReader(credentialProviderId, agent) : null;
  let oauthToken: string | null = null;
  if (routing.authStrategy === 'oauth-token') {
    oauthToken = oauthTokenReader(credentialProviderId);
  } else if (routing.authStrategy === 'provider-oauth-header') {
    try {
      oauthToken = await providerOAuthTokenReader(provider.id, agent);
    } catch {
      oauthToken = null;
    }
  }
  return { apiKey, oauthToken };
}

/**
 * 按 **providerId** 解析路由决策(resolveSessionRouteDecision 的 provider-keyed 变体,不查
 * getSessionProvider,也不套 routingServesWireModel 服务范围门 —— 远端会话的 model 就是该
 * 供应商的主模型)。远端 Claude 会话把结果翻成 cc env 时用(见 remote-claude-route.ts)。
 * 返回 null = providerId 空 / xd 网关不可用 / 该供应商对此 agent 无路由 / 路由凭证正在
 * mutation 窗口内(与 resolveSessionRoute 同口径:窗口极短,spawn 拒绝后重试即可,不能把
 * 旧 endpoint 与新 key 拼进同一份远端 env)。
 */
export async function resolveProviderRouteDecision(
  providerId: string | null | undefined,
  agent: AgentKind,
  gatewayKey: string | null,
  wireModel?: string,
): Promise<ResolvedProviderRouteDecision | null> {
  const id = providerId?.trim() || null;
  if (!id) return null;
  if (isProviderRouteMutationInProgress(id)) return null;
  if (id === 'xd' && !getAppCapabilities().canUseCindyGateway) return null;
  const provider = getActiveCatalog().providers.find((p) => p.id === id);
  const routing = provider ? providerRoutingForModel(provider, agent, wireModel) : null;
  if (!provider || !routing || !routingServesWireModel(routing, wireModel)) return null;
  const { apiKey, oauthToken } = await readProviderRouteCredentials(provider, routing, agent);
  const decision = buildRouteDecision(routing, gatewayKey, agent, apiKey, oauthToken);
  return {
    providerId: id,
    routing,
    decision: decision && wireModel && routing.requestPath
      ? { ...decision, pathOverride: routing.requestPath }
      : decision,
  };
}

export function resolveSessionRouteDecision(
  sessionId: string,
  agent: AgentKind,
  gatewayKey: string | null,
  wireModel?: string,
): RoutingDecision | null | Promise<RoutingDecision | null> {
  const providerId = getSessionProvider(sessionId);
  const pendingDecision = resolvePendingSessionRouteDecision(sessionId, wireModel);
  if (!providerId) return pendingDecision;
  if (isProviderRouteMutationInProgress(providerId)) {
    return updatingProviderRouteDecision(providerId);
  }
  if (providerId === 'xd' && !getAppCapabilities().canUseCindyGateway) return null;
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  const routing = provider ? providerRoutingForModel(provider, agent, wireModel) : null;
  if (!routing) return null;
  if (routing.disabled) return disabledProviderRouteDecision(providerId);
  if (pendingDecision) return pendingDecision;
  if (!routingServesWireModel(routing, wireModel)) return null;
  // 自定义供应商：resolve 时按 provider_key_<id>_<agent> 读出该 runtime 的 API key 注入鉴权头（不在 catalog）。
  const credentialProviderId =
    provider?.source === 'user' ? storedCustomProviderId(providerId) : providerId;
  const apiKey =
    provider?.source === 'user' ? customProviderKeyReader(credentialProviderId, agent) : null;
  const withRequestPath = (decision: RoutingDecision | null): RoutingDecision | null =>
    decision && wireModel && routing.requestPath
      ? { ...decision, pathOverride: routing.requestPath }
      : decision;
  // 通用 OAuth 供应商（oauth-token）：从 generic-oauth 内存缓存**同步**读 access_token
  // （临期刷新在后台单飞，不阻塞路由热路径，规则 10）。
  if (routing.authStrategy === 'oauth-token') {
    return withRequestPath(
      buildRouteDecision(
        routing,
        gatewayKey,
        agent,
        apiKey,
        oauthTokenReader(credentialProviderId),
      ),
    );
  }
  if (routing.authStrategy !== 'provider-oauth-header') {
    return withRequestPath(buildRouteDecision(routing, gatewayKey, agent, apiKey));
  }
  return Promise.resolve(providerOAuthTokenReader(providerId, agent))
    .then((token) => withRequestPath(buildRouteDecision(routing, gatewayKey, agent, apiKey, token)))
    .catch(() => withRequestPath(buildRouteDecision(routing, gatewayKey, agent, apiKey, null)));
}

function providersForModel(modelId: string, agent: AgentKind) {
  return getActiveCatalog().providers.filter(
    (provider) =>
      !isProviderRouteMutationInProgress(provider.id) &&
      (provider.id !== 'xd' || getAppCapabilities().canUseCindyGateway) &&
      provider.agents.includes(agent) &&
      Boolean(provider.routing[agent] && !provider.routing[agent]?.disabled) &&
      (provider.models[agent] ?? []).some((model) => model.id === modelId),
  );
}

type ConnectedDefaultProviderResolution =
  | { kind: 'provider'; provider: ProviderView }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

async function connectedDefaultProviderForModel(
  modelId: string,
  agent: AgentKind,
): Promise<ConnectedDefaultProviderResolution> {
  const providers = await providerViewsReader();
  const eligible = chatEligibleSourcesForModel(providers, modelId, agent, {
    includeDisabled: true,
  });
  // Claude Code can emit its first request before the selected Provider is
  // bound to the session. If more than one connected source exposes the same
  // bare model id, choosing the native default/first source would risk sending
  // that prompt to a Provider the user did not select. Fail closed until the
  // session binding arrives; Codex retains its established native-default
  // semantics because its implicit bridge is also used for explicit prefixes.
  if (agent === 'claude-code' && eligible.length > 1) return { kind: 'ambiguous' };
  // This runs while dispatching an already-created implicit-source session. Admission for new
  // sessions/model switches happened earlier; keep its retired/disabled source usable for resume.
  const defaultId = actualSourceIdForModel(providers, null, modelId, agent);
  const provider = eligible.find((candidate) => candidate.id === defaultId);
  return provider ? { kind: 'provider', provider } : { kind: 'none' };
}

/**
 * 隐式 bridge 的 wire 判定口径:目录条目未显式声明 wireProtocol 时按 agent 原生缺省
 * 推断(claude-code=anthropic-messages,codex=openai-responses;与 resolveVisionBackendRoute
 * 的缺省推断同源)。claude-code 的用户 Anthropic 兼容上游(如智谱)在目录里就是该 agent
 * 的缺省 wire,buildUserProvider 按约定省略该字段 —— 不做缺省推断,这些来源会被整体
 * 排除在隐式路由之外,裸 catalog id(如 glm-5.3)只能落默认网关吃 LiteLLM 模型校验层
 * 的 400(Invalid model name)。
 */
function implicitBridgeWire(
  routing: RoutingDescriptor | null,
  agent: AgentKind,
): RoutingDescriptor['wireProtocol'] {
  if (routing?.wireProtocol) return routing.wireProtocol;
  if (agent === 'claude-code') return 'anthropic-messages';
  if (agent === 'codex') return 'openai-responses';
  return undefined;
}

function hasImplicitLocalBridgeCandidate(modelId: string, agent: AgentKind): boolean {
  return providersForModel(modelId, agent).some((provider) => {
    const wire = implicitBridgeWire(providerRoutingForModel(provider, agent, modelId), agent);
    return wire === 'openai-chat' || wire === 'anthropic-messages';
  });
}

function uniqueProviderForModel(modelId: string, agent: AgentKind) {
  const providers = providersForModel(modelId, agent);
  return providers.length === 1 ? providers[0] : null;
}

/**
 * 隐式来源推断:仅当某 model 在该 agent 下只属于一个 provider 时返回 provider id。
 * 用于 `providerId=null` 但 model 自带命名空间的路径(如 xai/grok-*)。
 */
export function inferProviderIdForModel(modelId: string, agent: AgentKind): string | null {
  return uniqueProviderForModel(modelId, agent)?.id ?? null;
}

export type ImplicitLocalBridgeRouteResolution =
  | { kind: 'route'; route: ResolvedSessionRoute }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

/**
 * Resolve an implicit bridge route while preserving the distinction between
 * no connected source and multiple connected sources. Claude Code callers
 * must refuse the latter until the session's explicit Provider binding arrives.
 */
export async function resolveImplicitLocalBridgeRouteResolution(
  modelId: string,
  agent: AgentKind,
): Promise<ImplicitLocalBridgeRouteResolution> {
  const catalogModelId = modelId.replace(/\[1m\]$/, '');
  if (!hasImplicitLocalBridgeCandidate(catalogModelId, agent)) {
    return { kind: 'none' };
  }
  const source = await connectedDefaultProviderForModel(catalogModelId, agent);
  if (source.kind !== 'provider') return source;
  const routing = providerRoutingForModel(source.provider, agent, modelId);
  const wire = implicitBridgeWire(routing, agent);
  if (wire !== 'openai-chat' && wire !== 'anthropic-messages') {
    return { kind: 'none' };
  }
  const route = await resolveProviderRouteById(source.provider.id, agent, modelId);
  return route ? { kind: 'route', route } : { kind: 'none' };
}

/**
 * 隐式本地 bridge 来源：会话未显式选 Provider 时，按模型选择器相同的原生默认来源
 * 解析 Provider；只有最终来源明确声明 Chat / Anthropic Messages wire 才接管。
 *
 * 这里不能使用 uniqueProviderForModel：Claude 模型通常同时由 Anthropic 与 XD 提供，
 * 但 Codex 的默认来源仍应稳定选择 XD；XD 不可用时才落到候选首项（如 Anthropic）。
 */
export function resolveImplicitLocalBridgeRoute(
  modelId: string,
  agent: AgentKind,
): Promise<ResolvedSessionRoute | null> {
  return resolveImplicitLocalBridgeRouteResolution(modelId, agent).then((resolution) =>
    resolution.kind === 'route' ? resolution.route : null,
  );
}

/**
 * 隐式 provider OAuth 路由:providerId/sessionProvider 为空时,按 model 唯一来源推断出
 * provider-oauth-header 路由。只接管这类必须由 proxy 注入供应商 OAuth 的路径,避免改变
 * gpt-* 等多来源模型的 Codex 原生默认路由。
 */
export function resolveImplicitProviderOAuthRouteDecision(
  modelId: string,
  agent: AgentKind,
  gatewayKey: string | null,
): RoutingDecision | null | Promise<RoutingDecision | null> {
  const provider = uniqueProviderForModel(modelId, agent);
  const routing = provider?.routing[agent];
  if (!provider || !routing || routing.authStrategy !== 'provider-oauth-header') return null;
  const apiKey = provider.source === 'user' ? customProviderKeyReader(provider.id, agent) : null;
  const withRequestPath = (decision: RoutingDecision | null): RoutingDecision | null =>
    decision && routing.requestPath ? { ...decision, pathOverride: routing.requestPath } : decision;
  return Promise.resolve(providerOAuthTokenReader(provider.id, agent))
    .then((token) => withRequestPath(buildRouteDecision(routing, gatewayKey, agent, apiKey, token)))
    .catch(() => withRequestPath(buildRouteDecision(routing, gatewayKey, agent, apiKey, null)));
}

/**
 * provider-oauth host 的无会话控制面路由(如 Codex `GET /models`)。
 *
 * 这类请求没有 model/thread 可反解 provider;只有当当前 catalog 对该 agent 恰好只有一个
 * provider-oauth-header 供应商时才接管。多于一个时保持 null,避免把控制面请求误送错供应商。
 */
export function resolveProviderOAuthControlRouteDecision(
  agent: AgentKind,
  gatewayKey: string | null,
): RoutingDecision | null | Promise<RoutingDecision | null> {
  const providers = getActiveCatalog().providers.filter((provider) => {
    const routing = provider.routing[agent];
    return (
      !isProviderRouteMutationInProgress(provider.id) &&
      provider.agents.includes(agent) &&
      routing?.authStrategy === 'provider-oauth-header' &&
      // Session-less Codex control requests use the OpenAI control-plane
      // protocol. Local inference bridges (Chat / Anthropic Messages) obtain
      // their model lists through Cindy's provider discovery and must not
      // compete for transparent GET /models routing.
      (routing.wireProtocol === undefined || routing.wireProtocol === 'openai-responses')
    );
  });
  if (providers.length !== 1) return null;
  const provider = providers[0];
  const routing = provider.routing[agent];
  if (!routing) return null;
  const apiKey = provider.source === 'user' ? customProviderKeyReader(provider.id, agent) : null;
  return Promise.resolve(providerOAuthTokenReader(provider.id, agent))
    .then((token) => buildRouteDecision(routing, gatewayKey, agent, apiKey, token))
    .catch(() => buildRouteDecision(routing, gatewayKey, agent, apiKey, null));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rewriteModelIdForProvider(
  providerId: string | null,
  agent: AgentKind,
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!providerId) return null;
  const model = body.model;
  if (typeof model !== 'string' || model.length === 0) return null;
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  const stripPrefix = provider?.routing[agent]?.modelIdRewrite?.stripPrefix;
  if (!stripPrefix || !model.startsWith(stripPrefix)) return null;
  const rewritten = model.slice(stripPrefix.length);
  if (!rewritten) return null;
  return { ...body, model: rewritten };
}

/** Apply a provider's model rewrite to a request body without session lookup. */
export function rewriteProviderModelIdInBody(
  providerId: string | null | undefined,
  agent: AgentKind,
  body: unknown,
): Record<string, unknown> | null {
  if (!isPlainObject(body)) return null;
  return rewriteModelIdForProvider(providerId?.trim() || null, agent, body);
}

/**
 * 按会话显式选中的 provider routing.modelIdRewrite 改写请求体里的 model id。
 * 例:xAI catalog 对外暴露 `xai/grok-4.3`,发往 api.x.ai 前剥成 `grok-4.3`。
 */
export function rewriteSessionModelIdForRoute(
  sessionId: string,
  agent: AgentKind,
  body: unknown,
): Record<string, unknown> | null {
  if (!isPlainObject(body)) return null;
  const providerId = getSessionProvider(sessionId);
  return rewriteModelIdForProvider(providerId, agent, body);
}

/**
 * 按 model 唯一来源推断 provider 后应用 modelIdRewrite。
 * 例:providerId=null + `xai/grok-4.3` 也要在发往 api.x.ai 前剥成 `grok-4.3`。
 */
export function rewriteImplicitModelIdForRoute(
  agent: AgentKind,
  body: unknown,
): Record<string, unknown> | null {
  if (!isPlainObject(body)) return null;
  const model = body.model;
  if (typeof model !== 'string' || model.length === 0) return null;
  return rewriteModelIdForProvider(inferProviderIdForModel(model, agent), agent, body);
}

/**
 * 该会话是否显式选了**自定义(user)供应商**。
 * codex 路由用：env-key 注入态默认全量走网关、per-session 无意义（内置三家保持该旧行为），
 * 但自定义供应商必须按其 baseUrl + 用户 key 路由，故对 user 供应商放行 per-session 解析。
 */
export function isUserProviderSession(sessionId: string): boolean {
  return getUserProviderIdForSession(sessionId) !== null;
}

/**
 * 该会话显式选定的**自定义(user)供应商 id**；非 user 供应商 / 未选 → null。
 * 上游错误观察器（provider-upstream-error-observer）用它把 4xx/5xx 归属到具体自定义供应商。
 */
export function getUserProviderIdForSession(sessionId: string): string | null {
  const providerId = getSessionProvider(sessionId);
  if (!providerId) return null;
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  return provider?.source === 'user' ? providerId : null;
}

/** 该会话是否使用 host/proxy 注入供应商鉴权的路由策略(provider-oauth-header / oauth-token)。 */
export function isHostInjectedAuthSession(sessionId: string, agent: AgentKind): boolean {
  const providerId = getSessionProvider(sessionId);
  if (!providerId) return false;
  const strategy = getActiveCatalog().providers.find((p) => p.id === providerId)?.routing[agent]
    ?.authStrategy;
  // provider-oauth-header(bespoke,如 xAI)与 oauth-token(通用 Runner)同属「host 注入鉴权」:
  // 令牌由 proxy 覆盖、与子进程自带凭证无关,env-key/gateway 态也必须按会话路由,
  // 否则 builtin oauth-token 供应商会话会落回默认网关、请求打到错误上游。
  return strategy === 'provider-oauth-header' || strategy === 'oauth-token';
}

/**
 * 解析视觉后端（图 → 文字描述）的真实出站端点，与 agent 路由**同源**。
 *
 * 视觉桥（vision-channel.ts）不自己复刻路由判断，而是经本函数复用统一路由器的
 * `providerRoutingForModel`（含 xd 特例：客户端投影给 Codex 的模型走 Claude Messages 面）：
 *  - gateway-key → upstream 用 host 传入的网关动态端点（key 与 endpoint 同租户），
 *    鉴权头用网关 key（与 proxy gateway-key 分支同口径，codex 面只覆盖 authorization）；
 *  - api-key-header → upstream 用 routing.upstream，鉴权头用 custom provider key；
 *  - modelIdRewrite.stripPrefix → 转发前剥模型前缀（如 codex/xxx → xxx，对齐 codex 代理）。
 *
 * 返回 null = 该 provider/model 对该 agent 无可用路由 / 凭证或动态端点缺失（网关不可用）。
 * 失败不抛错：返回 null 由视觉桥调用方走 fallback / 回退无视觉桥。
 */
/** 按模型选视觉后端的 agent 面：模型前缀显式指面，否则按 provider.models 归属，最后回退。 */
function pickVisionAgent(provider: Provider, modelId: string): AgentKind | null {
  // XD 投影给 Codex 的模型本质是 Claude-wire（仅 claude-code 面、无 codex 原生），
  // `codex/` 只是路由前缀：即使带 `codex/` 前缀也必须走 claude-code 面 / Messages，
  // 否则误走 Responses 被上游拒（rebase 后 pickVisionAgent 先按前缀选 codex 面）。
  if (provider.id === 'xd' && isXdCodexAnthropicBridgeModel(modelId)) {
    if (provider.routing['claude-code']) return 'claude-code';
  }
  if (modelId.startsWith('codex/') && provider.routing.codex) return 'codex';
  if (
    (modelId.startsWith('claude-') || modelId.startsWith('anthropic/')) &&
    provider.routing['claude-code']
  ) {
    return 'claude-code';
  }
  for (const agent of provider.agents) {
    if ((provider.models[agent] ?? []).some((m) => m.id === modelId) && provider.routing[agent]) {
      return agent;
    }
  }
  const preferred: AgentKind[] = ['claude-code', 'codex', 'pi'];
  for (const agent of preferred) {
    if (provider.agents.includes(agent) && provider.routing[agent]) return agent;
  }
  return null;
}

export function resolveVisionBackendRoute(
  providerId: string,
  modelId: string,
  gatewayEndpoint: string | null,
): {
  upstream: string;
  requestPath: string;
  wireProtocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat';
  model: string;
  authorization: string | null;
  /** 路由指定的额外请求头（headerOverride 去掉客户端凭证头后）。视觉桥直连需要它们
   *  （如 anthropic-version / x-api-key / 自定义 provider 头），否则后端会拒请求（P1）。 */
  headers: Record<string, string>;
} | null {
  if (isProviderRouteMutationInProgress(providerId)) return null;
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  if (!provider) return null;
  // 按模型选 agent 面：模型前缀显式指面（codex/ → codex；claude- / anthropic/ → claude-code），
  // 否则按 provider.models 归属，最后回退第一个声明 routing 的 agent。对齐视觉桥旧 pickAgent。
  const agent = pickVisionAgent(provider, modelId);
  if (!agent) return null;
  const routing = providerRoutingForModel(provider, agent, modelId);
  if (!routing || routing.disabled) return null;

  // 转发上游前还原 model id（对齐 rewriteModelIdForProvider）。
  // XD 投影给 Codex 的模型走 Claude Messages 面时，`codex/` 是路由前缀不是后端真实模型名，
  // 必须剥掉（否则上游 /v1/messages 收到 model:'codex/...' 404）。剥到目录裸 id。
  let model = modelId;
  if (provider.id === 'xd' && isXdCodexAnthropicBridgeModel(modelId)) {
    model = modelId.replace(/^codex\//, '').replace(/\[1m\]$/, '');
  }
  const stripPrefix = routing.modelIdRewrite?.stripPrefix;
  if (stripPrefix && model.startsWith(stripPrefix)) {
    model = model.slice(stripPrefix.length);
  }

  // Claude/Codex 保留各自原生前门的历史缺省；Pi 是后来加入的自适应 runtime，
  // 缺声明不能猜成 Chat，否则视觉工具会把图片与凭证发往错误协议端点。
  if (agent === 'pi' && routing.wireProtocol === undefined) return null;
  const wireProtocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat' =
    routing.wireProtocol ??
    (agent === 'claude-code'
      ? 'anthropic-messages'
      : agent === 'codex'
        ? 'openai-responses'
        : 'openai-chat');
  // 缺省请求路径按协议推断（对齐上游标准路径）。
  const requestPath =
    routing.requestPath ??
    (wireProtocol === 'anthropic-messages'
      ? '/v1/messages'
      : wireProtocol === 'openai-responses'
        ? '/responses'
        : '/chat/completions');

  let upstream: string;
  let authorization: string | null;
  switch (routing.authStrategy) {
    case 'gateway-key': {
      if (!gatewayEndpoint) return null; // 网关不可用
      const key = gatewayKeyReader();
      if (!key) return null; // 无网关 key 可换
      // 网关 base 由最终协议决定，而不是由承载它的 agent 决定：Responses 的标准路径
      // 是 `<endpoint>/v1/responses`，Messages 则由裸 endpoint 拼 `/v1/messages`。Pi 可按模型
      // 在两种协议间切换，因此若按 agent 判断会把 Pi Responses 错送到 `<endpoint>/responses`。
      upstream =
        wireProtocol === 'openai-responses'
          ? `${gatewayEndpoint.replace(/\/+$/, '')}/v1`
          : gatewayEndpoint.replace(/\/$/, '');
      authorization = `Bearer ${key}`;
      break;
    }
    case 'api-key-header': {
      const key = customProviderKeyReader(provider.id, agent);
      if (!key) {
        // safeStorage 无 key：镜像 buildRouteDecision 的 legacy 回退——升级前的自定义
        // 供应商可能把凭证只存在 routing.headerOverride（authorization / x-api-key），
        // 普通路由保留 legacy 头继续工作，视觉路由也应如此，否则该后端「不可用」但普通
        // 请求明明成功（codex P1）。headerOverride 有 legacy 凭证时用它们，无则真缺 key。
        const hasLegacyAuthorization = hasHeader(routing.headerOverride, 'authorization');
        const hasLegacyApiKey = hasHeader(routing.headerOverride, 'x-api-key');
        if (!hasLegacyAuthorization && !hasLegacyApiKey) return null;
        upstream = routing.upstream.replace(/\/$/, '');
        authorization = null; // legacy 凭证经 headerOverride 下发，不单设 Bearer
        break;
      }
      upstream = routing.upstream.replace(/\/$/, '');
      authorization = `Bearer ${key}`;
      break;
    }
    case 'none': {
      upstream = routing.upstream.replace(/\/$/, '');
      authorization = null;
      break;
    }
    default:
      // OAuth 系暂不支持作为视觉后端（与 vision-channel 的第一版边界一致）。
      return null;
  }
  // 路由额外头（headerOverride 去掉客户端凭证头）：anthropic-version / x-api-key /
  // 自定义 provider 头等。视觉桥直连不发 proxy，需自己带上，否则后端可能 400/拒绝。
  const headers = withoutClientAuthHeaders(routing.headerOverride);
  // 对齐 buildRouteDecision 的凭证头形状（claude-code/pi 面 = Anthropic Messages 风格，
  // 后端按 x-api-key 鉴权，只带 Authorization: Bearer 会被拒；codex 面 = OpenAI 式按
  // Bearer 鉴权）。x-api-key 不是「客户端凭证头」，是路由要求的鉴权形状，须补进额外头。
  //  - api-key-header：自定义供应商，key = 用户 API key；
  //  - gateway-key：XD Messages 视觉路由（claude-code/pi 面），key = 网关 key——代理层
  //    buildRouteDecision 对 XD 路由同时发 x-api-key + authorization，直连视觉请求须镜像。
  if (routing.authStrategy === 'api-key-header') {
    const key = customProviderKeyReader(provider.id, agent);
    if (key) {
      // 对齐 buildRouteDecision 的凭证头形状：claude-code/pi 面（Anthropic Messages 风格）
      // 后端按 x-api-key 鉴权须补 x-api-key；codex 面（OpenAI 式）按 Bearer 鉴权（已由
      // authorization 字段下发），不补 x-api-key。
      if (agent !== 'codex') headers['x-api-key'] = key;
    } else if (
      hasHeader(routing.headerOverride, 'authorization') ||
      hasHeader(routing.headerOverride, 'x-api-key')
    ) {
      // legacy 凭证（safeStorage 无 key，凭证仍在 headerOverride）：无论哪个 agent 面都
      // 并入 headers 下发（codex 面 legacy Authorization-only / x-api-key-only 同样适用，
      // 否则视觉请求 401 但普通请求正常——codex P1）。与 authorization=null 分支配套。
      // 对齐 buildRouteDecision 的 legacy 回退。
      Object.assign(headers, normalizeLegacyClientAuthHeaders(routing.headerOverride));
    }
  } else if (routing.authStrategy === 'gateway-key' && agent !== 'codex') {
    // XD Messages 视觉路由（claude-code/pi 面），key = 网关 key——代理层 buildRouteDecision
    // 对 XD 路由同时发 x-api-key + authorization，直连视觉请求须镜像。
    const key = gatewayKeyReader();
    if (key) headers['x-api-key'] = key;
  }
  return { upstream, requestPath, wireProtocol, model, authorization, headers };
}

/** 当前生效的 XD 网关 key（host 注入；默认空）。 */
let gatewayKeyReader: () => string | null = () => null;
export function setVisionGatewayKeyReader(reader: () => string | null): void {
  gatewayKeyReader = reader;
}
